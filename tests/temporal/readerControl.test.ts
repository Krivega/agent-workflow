import { readerExecution } from '../../src/policy/readerExecution.js';
import { join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import { controlFixture } from './controlFixture.js';
import { controlReader, startControlledReader } from '../../src/client/reader.js';
import { bindTaskBackendClient } from '../../src/client/taskBackend.js';
import {
  nextReaderControl,
  parseReaderCommand,
  parseReaderInput,
  readerKey,
  readerTarget,
} from '../../src/policy/readerControl.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerBudget } from '../../src/adapters/codex/readerBudget.js';
import * as files from '../../src/adapters/artifacts/files.js';

describe('reader commands and client', () => {
  it.each([
    'pass',
    'history',
    'resume',
    'lost-turn',
    'unknown-create',
    'non-idle',
    'becomes-active',
    'model',
    'effort',
    'version',
    'scope',
    'different-error',
    'late-journal',
  ])(
    'requires a frozen create-only journal and two verified idle headers before confirming an unpersisted reader stop: %s',
    async (mode) => {
      const f = controlFixture();
      if (mode === 'history')
        f.response.thread.turns.push({ id: 'previous', status: 'completed', items: [] });
      await f.gate.boundary.dispatch(
        f.input,
        f.epoch,
        'create-only',
        mode === 'resume' ? 'thread/resume' : 'thread/start',
        {},
        async () => f.response,
      );
      if (mode === 'lost-turn' || mode === 'unknown-create')
        await expect(
          f.gate.boundary.dispatch(
            f.input,
            f.epoch,
            'lost',
            mode === 'lost-turn' ? 'turn/start' : 'thread/start',
            { threadId: 'session' },
            async () => {
              throw new Error('lost reply');
            },
          ),
        ).rejects.toThrow('lost reply');
      const revision = f.gate.freeze(f.input, f.permit);
      let headers = 0;
      f.rpc.request.mockImplementation(async (method, params) => {
        expect(method).toBe('thread/read');
        if (params.includeTurns === true)
          throw new Error(
            mode === 'different-error'
              ? 'transport offline'
              : 'app-server-error:{"code":-32601,"message":"list_turns is not supported yet"}',
          );
        headers++;
        return {
          thread: {
            ...f.response.thread,
            model: mode === 'model' ? 'foreign' : f.profile.model,
            reasoningEffort: mode === 'effort' ? 'high' : f.profile.effort,
            cliVersion: mode === 'version' ? 'other' : f.profile.clientVersion,
            parentThreadId: mode === 'scope' ? 'other' : null,
            status: {
              type:
                mode === 'non-idle' || (mode === 'becomes-active' && headers === 2)
                  ? 'active'
                  : 'idle',
            },
          },
        };
      });
      if (mode === 'late-journal') {
        const read = f.gate.requests;
        let reads = 0;
        vi.spyOn(f.gate, 'requests').mockImplementation((...args) => {
          const before = read(...args);
          return ++reads === 1 ? before : [...before, { ...before[0]!, operationId: 'late' }];
        });
      }
      const outcome = f.controls.stopReader(f.input, f.permit, revision);
      if (mode === 'pass') {
        const result = await outcome;
        const receipt = JSON.parse(f.store.read(result.receipt).toString()) as {
          confirmed: boolean;
          observations: { sha256: string; bytes: number }[];
        };
        expect(receipt.confirmed).toBe(true);
        expect(headers).toBe(2);
        expect(JSON.parse(f.store.read(receipt.observations[0]!).toString())).toHaveProperty(
          'kind',
          'reader-unstarted-stop',
        );
        const late = vi.fn();
        await expect(
          f.gate.boundary.dispatch(f.input, f.epoch, 'late', 'turn/start', {}, late),
        ).rejects.toThrow();
        expect(late).not.toHaveBeenCalled();
      } else await expect(outcome).rejects.toThrow('reader-stop-unknown');
    },
  );
  it('normalizes a start and joins only its identical immutable input', async () => {
    const f = controlFixture();
    const query = vi.fn(async () => f.input),
      start = vi.fn(async () => ({ query }));
    const client = { workflow: { start } } as unknown as Client;
    bindTaskBackendClient(client, f.registration);
    expect(await startControlledReader(client, f.input, 'q')).toEqual({ query });
    expect(start.mock.calls[0]).toMatchObject([
      'ControlledReaderWorkflow',
      { workflowId: readerKey(f.input), taskQueue: 'q' },
    ]);
    query.mockResolvedValueOnce({
      ...f.input,
      preparation: { ...f.input.preparation, revision: 2 },
    });
    await expect(startControlledReader(client, f.input, 'q')).rejects.toThrow(
      'reader-start-conflict',
    );
    expect(() => parseReaderInput({ ...f.input, roleId: 'other' })).toThrow(
      'reader-role-not-declared',
    );
    expect(() => readerTarget(f.input, 'foreign')).toThrow('reader-workflow-id-mismatch');
  });
  it('binds full payload hashes, permits transport retry and validates acknowledgements', async () => {
    const f = controlFixture(),
      command = f.command();
    const ack = {
      commandId: command.commandId,
      hash: command.hash,
      revision: 1,
      authorization: f.proof,
    };
    const executeUpdate = vi.fn(
        async (_name: string, _options: { args: unknown[]; updateId?: string }) => ack,
      ),
      getHandle = vi.fn(() => ({ executeUpdate }));
    const client = { workflow: { getHandle } } as unknown as Client;
    bindTaskBackendClient(client, f.registration);
    expect(await controlReader(client, readerKey(f.input), command)).toEqual(ack);
    expect(executeUpdate.mock.calls[0]).toMatchObject(['readerControl', { args: [command] }]);
    expect(executeUpdate.mock.calls[0]![1]).not.toHaveProperty('updateId');
    for (const change of [
      { hash: 'a'.repeat(64) },
      { action: 'cancel' },
      { target: { ...command.target, workflowId: 'foreign' } },
    ])
      await expect(
        controlReader(client, readerKey(f.input), { ...command, ...change }),
      ).rejects.toThrow('reader-command-hash-invalid');
    for (const bad of [
      { ...ack, hash: 'b'.repeat(64) },
      { ...ack, commandId: 'other' },
      { ...ack, revision: 2 },
    ]) {
      executeUpdate.mockResolvedValueOnce(bad);
      await expect(controlReader(client, readerKey(f.input), command)).rejects.toThrow(
        'reader-command-receipt-invalid',
      );
    }
    for (const change of [
      { schemaVersion: 2 },
      { hash: 'x' },
      { action: 'restart' },
      { attempt: -1 },
      { source: { sha256: 'x', bytes: 1 } },
      { source: { sha256: 'a'.repeat(64), bytes: -1 } },
      { target: { ...command.target, generation: 0 } },
      { target: { ...command.target, requirementsRevision: 0 } },
    ])
      expect(() => parseReaderCommand({ ...command, ...change })).toThrow();
  });
  it('enforces revisions, stopped resume, explicit attempt and terminal states', () => {
    const f = controlFixture(),
      running = { mode: 'running' as const, revision: 0, attempt: 0 };
    expect(nextReaderControl(running, f.command())).toEqual({
      mode: 'pausing',
      revision: 1,
      attempt: 0,
    });
    expect(nextReaderControl(running, f.command('cancel')).mode).toBe('cancelling');
    expect(
      nextReaderControl({ mode: 'paused', revision: 1, attempt: 0 }, f.command('resume', 1, 1)),
    ).toEqual({ mode: 'running', revision: 2, attempt: 1 });
    for (const state of [
      { ...running, revision: Number.MAX_SAFE_INTEGER },
      { ...running, mode: 'answered' },
      { ...running, mode: 'cancelled' },
    ])
      expect(() =>
        nextReaderControl(state as typeof running, f.command('pause', state.revision)),
      ).toThrow();
    expect(() => nextReaderControl(running, f.command('pause', 1))).toThrow('reader-command-stale');
    for (const [state, command] of [
      [running, f.command('resume')],
      [running, f.command('pause', 0, 1)],
      [running, f.command('resume', 0, 2)],
      [{ ...running, attempt: 1 }, f.command()],
    ] as const)
      expect(() => nextReaderControl(state, command)).toThrow();
  });
});

describe('durable external reader permissions', () => {
  function paths(f: ReturnType<typeof controlFixture>) {
    const folder = join(f.boundaryRoot, readdirSync(f.boundaryRoot)[0]!);
    return { folder, file: join(folder, 'permission.json') };
  }
  it('binds workspace identity, card, input and permit while stop remains possible after deletion', () => {
    const f = controlFixture();
    expect(f.gate.install(f.input)).toEqual(f.permit);
    f.gate.boundary.assert(f.input, f.epoch);
    expect(() => f.gate.boundary.assert(f.input, { ...f.epoch, permit: f.proof })).toThrow(
      'reader-permit-unconfirmed',
    );
    expect(() =>
      f.gate.boundary.assert(
        { ...f.input, preparation: { ...f.input.preparation, card: 'tasks/other.md' } },
        f.epoch,
      ),
    ).toThrow('reader-permit-unconfirmed');
    writeFileSync(join(f.workspace, 'tasks/one.md'), 'changed');
    expect(() => f.gate.boundary.assert(f.input, f.epoch)).toThrow('reader-card-changed');
    expect(f.gate.freeze(f.input, f.permit)).toBe(1);
    expect(f.gate.freeze(f.input, f.permit)).toBe(1);
    rmSync(f.workspace, { recursive: true });
    expect(f.gate.requests(f.input, f.permit, 1)).toEqual([]);
    f.gate.confirmStop(f.input, f.permit, 1, f.proof);
    expect(() => f.gate.install(f.input)).toThrow('reader-permit-revoked');
  });
  it('fences dispatch, journals unknown outcomes and recovers known responses without resending', async () => {
    const f = controlFixture(),
      effect = vi.fn(async () => ({ thread: { id: 's' } }));
    expect(f.gate.boundary.response(f.input, f.epoch, 'create', 'thread/start')).toBeNull();
    expect(
      await f.gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', {}, effect),
    ).toEqual({ thread: { id: 's' } });
    expect(
      await f.gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', {}, effect),
    ).toEqual({ thread: { id: 's' } });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(f.gate.boundary.response(f.input, f.epoch, 'create', 'thread/start')).toEqual({
      thread: { id: 's' },
    });
    await expect(
      f.gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', { x: 1 }, effect),
    ).rejects.toThrow('reader-dispatch-conflict');
    await expect(
      f.gate.boundary.dispatch(f.input, f.epoch, 'unknown', 'turn/start', {}, async () => {
        throw new Error('lost');
      }),
    ).rejects.toThrow('lost');
    await expect(
      f.gate.boundary.dispatch(f.input, f.epoch, 'unknown', 'turn/start', {}, effect),
    ).rejects.toThrow('reader-dispatch-unknown');
    expect(() => f.gate.requests(f.input, f.permit, 0)).toThrow('reader-stop-not-fenced');
    expect(() => f.gate.confirmStop(f.input, f.permit, 0, f.proof)).toThrow(
      'reader-stop-not-fenced',
    );
    f.gate.freeze(f.input, f.permit);
    expect(f.gate.requests(f.input, f.permit, 1)).toHaveLength(2);
    await expect(
      f.gate.boundary.dispatch(f.input, f.epoch, 'late', 'turn/start', {}, effect),
    ).rejects.toThrow('reader-permit-revoked');
    expect(() => f.gate.requests(f.input, f.permit, 2)).toThrow('reader-stop-not-fenced');
    expect(() => f.gate.confirmStop(f.input, f.permit, 2, f.proof)).toThrow(
      'reader-stop-not-fenced',
    );
  });
  it('requires confirmed stop and immutable workspace/card before human resume', () => {
    const f = controlFixture(),
      pause = f.command();
    expect(f.gate.commandAck(f.input, f.permit, pause)).toBeNull();
    expect(() => f.gate.advance(f.input, f.permit, f.command('resume'), f.proof)).toThrow(
      'reader-resume-not-stopped',
    );
    const ack = f.gate.advance(f.input, f.permit, pause, f.proof);
    expect(f.gate.advance(f.input, f.permit, pause, f.proof)).toEqual(ack);
    expect(f.gate.commandAck(f.input, f.permit, pause)).toEqual(ack);
    for (const method of ['advance', 'commandAck'] as const)
      expect(() =>
        f.gate[method](f.input, f.permit, { ...pause, hash: 'b'.repeat(64) }, f.proof),
      ).toThrow('reader-command-id-conflict');
    expect(f.gate.commandAck(f.input, f.permit, f.command('cancel', 1))).toBeNull();
    expect(() => f.gate.advance(f.input, f.permit, f.command('resume', 1), f.proof)).toThrow(
      'reader-resume-not-stopped',
    );
    f.gate.confirmStop(f.input, f.permit, 1, f.proof);
    writeFileSync(join(f.workspace, 'tasks/one.md'), 'changed');
    expect(() => f.gate.advance(f.input, f.permit, f.command('resume', 1), f.proof)).toThrow(
      'reader-card-changed',
    );
    writeFileSync(join(f.workspace, 'tasks/one.md'), 'tasks/one.md');
    renameSync(f.workspace, f.workspace + '-old');
    mkdirSync(f.workspace);
    expect(() => f.gate.advance(f.input, f.permit, f.command('resume', 1), f.proof)).toThrow(
      'reader-workspace-replaced',
    );
    rmSync(f.workspace, { recursive: true });
    renameSync(f.workspace + '-old', f.workspace);
    expect(f.gate.advance(f.input, f.permit, f.command('resume', 1, 1), f.proof).revision).toBe(2);
    f.gate.boundary.assert(f.input, { ...f.epoch, revision: 2, attempt: 1 });
    expect(() => f.gate.advance(f.input, f.permit, f.command('cancel', 1), f.proof)).toThrow(
      'reader-command-stale',
    );
    f.gate.advance(f.input, f.permit, f.command('cancel', 2), f.proof);
    expect(() => f.gate.advance(f.input, f.permit, f.command('pause', 3), f.proof)).toThrow(
      'reader-control-terminal',
    );
  });
  it('rejects malformed durable permissions and requests instead of guessing', async () => {
    const f = controlFixture(),
      { file, folder } = paths(f),
      original = JSON.parse(readFileSync(file, 'utf8')) as { workspace: Record<string, unknown> };
    const changes = [
      { schemaVersion: 1 },
      { dispatches: null },
      { dispatches: { invalid: 'a'.repeat(64) } },
      { dispatches: { ['request-' + 'a'.repeat(64)]: 0 } },
      { dispatches: { ['request-' + 'a'.repeat(64)]: 'bad' } },
      { inputHash: 'x' },
      { target: {} },
      { revision: -1 },
      { revision: 0.5 },
      { permission: 'other' },
      { cardHash: 0 },
      { cardHash: 'x' },
      { workspace: { root: 'other', dev: '1', ino: '1' } },
      { workspace: { ...original.workspace, dev: 0 } },
      { workspace: { ...original.workspace, ino: 0 } },
      { stop: {} },
      { last: { commandId: 0 } },
      { last: { commandId: 'x', hash: 0 } },
      { last: { commandId: 'x', hash: 'h', revision: 0.5 } },
      { last: { commandId: 'x', hash: 'h', revision: 1 } },
      { last: { commandId: 'x', hash: 'h', revision: 0, authorization: {} } },
    ];
    for (const change of changes) {
      writeFileSync(file, JSON.stringify({ ...original, ...change }));
      expect(() => f.gate.boundary.assert(f.input, f.epoch)).toThrow();
    }
    writeFileSync(file, JSON.stringify(original));
    renameSync(f.workspace, f.workspace + '-old');
    mkdirSync(f.workspace);
    expect(() => f.gate.boundary.assert(f.input, f.epoch)).toThrow('reader-workspace-replaced');
    rmSync(f.workspace, { recursive: true });
    renameSync(f.workspace + '-old', f.workspace);
    mkdirSync(join(folder, 'lock'));
    await expect(
      f.gate.boundary.dispatch(f.input, f.epoch, 's', 'thread/start', {}, async () => ({})),
    ).rejects.toThrow('EEXIST');
    rmSync(join(folder, 'lock'), { recursive: true });
    const target = join(folder, 'request-' + digest(JSON.stringify(['turn/start', 'bad'])));
    f.gate.freeze(f.input, f.permit);
    for (const record of [
      { revision: 0.5 },
      { revision: 1 },
      { revision: 0, method: 'other' },
      { revision: 0, method: 'turn/start', operationId: 0 },
      { revision: 0, method: 'turn/start', operationId: 'bad', params: null },
    ]) {
      writeFileSync(target, JSON.stringify(record));
      writeFileSync(
        file,
        JSON.stringify({
          ...original,
          revision: 1,
          permission: 'released',
          dispatches: {
            [target.slice(target.lastIndexOf('/') + 1)]: digest(JSON.stringify(record)),
          },
        }),
      );
      expect(() => f.gate.requests(f.input, f.permit, 1)).toThrow();
    }
    writeFileSync(file, 'broken');
    expect(() => f.gate.freeze(f.input, f.permit)).toThrow();
  });
  it('blocks missing or changed dispatches until the exact original journal is restored', async () => {
    const f = controlFixture(),
      { folder } = paths(f),
      effect = vi.fn(async () => ({ thread: { id: 's' } }));
    await f.gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', {}, effect);
    const target = join(folder, 'request-' + digest(JSON.stringify(['thread/start', 'create']))),
      original = readFileSync(target);
    for (const corrupted of [null, Buffer.from('{}')]) {
      if (corrupted === null) rmSync(target);
      else writeFileSync(target, corrupted);
      const gate = readerBoundary(f.boundaryRoot, f.store, f.workspace, readerExecution(f.profile));
      expect(() => gate.boundary.assert(f.input, f.epoch)).toThrow('reader-dispatch-');
      expect(() => gate.boundary.response(f.input, f.epoch, 'create', 'thread/start')).toThrow(
        'reader-dispatch-',
      );
      await expect(
        gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', {}, effect),
      ).rejects.toThrow('reader-dispatch-');
      await expect(
        gate.boundary.dispatch(f.input, f.epoch, 'another', 'thread/start', {}, effect),
      ).rejects.toThrow('reader-dispatch-');
      writeFileSync(target, original);
    }
    expect(
      await f.gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', {}, effect),
    ).toEqual({ thread: { id: 's' } });
    expect(effect).toHaveBeenCalledTimes(1);
    f.gate.freeze(f.input, f.permit);
    expect(f.gate.requests(f.input, f.permit, 1)).toHaveLength(1);
  });
  it('cannot reinstall permissions over surviving effects or use an old permit after total loss', async () => {
    const f = controlFixture(),
      { file, folder } = paths(f);
    await f.gate.boundary.dispatch(
      f.input,
      f.epoch,
      'create',
      'thread/start',
      {},
      async () => f.response,
    );
    rmSync(file);
    expect(() => f.gate.install(f.input)).toThrow('reader-permission-journal-lost');
    rmSync(folder, { recursive: true });
    const gate = readerBoundary(f.boundaryRoot, f.store, f.workspace, readerExecution(f.profile));
    expect(() => gate.boundary.assert(f.input, f.epoch)).toThrow();
    const next = gate.install(f.input);
    expect(next).not.toEqual(f.permit);
    expect(() => gate.boundary.assert(f.input, f.epoch)).toThrow('reader-permit-unconfirmed');
  });
  it('records dispatch intent before publishing a request and never calls the effect after a disk failure', async () => {
    const f = controlFixture(),
      effect = vi.fn(async () => ({})),
      original = files.publishFile,
      publish = vi.spyOn(files, 'publishFile');
    publish.mockImplementation((path, bytes) => {
      if (path.includes('/request-')) throw new Error('disk-full');
      return original(path, bytes);
    });
    await expect(
      f.gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', {}, effect),
    ).rejects.toThrow('disk-full');
    publish.mockRestore();
    expect(effect).not.toHaveBeenCalled();
    f.gate.freeze(f.input, f.permit);
    expect(() => f.gate.requests(f.input, f.permit, 1)).toThrow(
      'reader-dispatch-journal-incomplete',
    );
  });
  it('preserves stop across another pause and safety release and denies overflow', () => {
    const f = controlFixture(),
      { file } = paths(f);
    f.gate.advance(f.input, f.permit, f.command(), f.proof);
    f.gate.confirmStop(f.input, f.permit, 1, f.proof);
    f.gate.advance(f.input, f.permit, f.command('pause', 1, 0, 'again'), f.proof);
    f.gate.freeze(f.input, f.permit);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { stop: unknown }).stop).toEqual(f.proof);
    const p = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      file,
      JSON.stringify({ ...p, permission: 'active', revision: Number.MAX_SAFE_INTEGER, last: null }),
    );
    expect(() => f.gate.freeze(f.input, f.permit)).toThrow('reader-command-stale');
    expect(() =>
      f.gate.advance(f.input, f.permit, f.command('pause', Number.MAX_SAFE_INTEGER), f.proof),
    ).toThrow('reader-command-stale');
  });
  it('does not swallow storage errors or dispatch after host shutdown', async () => {
    const f = controlFixture(),
      { folder } = paths(f);
    const read = vi.spyOn(files, 'readPrivateFile').mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(() => f.gate.install(f.input)).toThrow('denied');
    read.mockRestore();
    const gate = readerBoundary(
      f.boundaryRoot,
      f.store,
      f.workspace,
      readerExecution(f.profile),
      () => {
        throw new Error('closed');
      },
    );
    await expect(
      gate.boundary.dispatch(f.input, f.epoch, 's', 'thread/start', {}, async () => ({})),
    ).rejects.toThrow('closed');
    const path = join(folder, 'request-' + digest(JSON.stringify(['thread/start', 'bad'])));
    mkdirSync(path);
    await expect(
      f.gate.boundary.dispatch(f.input, f.epoch, 'bad', 'thread/start', {}, async () => ({})),
    ).rejects.toThrow();
  });
  it('retains unknown when publishing a native response fails and rejects conflicting concurrent outcomes', async () => {
    const f = controlFixture(),
      { folder } = paths(f);
    const target = join(
      folder,
      'request-' + digest(JSON.stringify(['thread/start', 'race'])) + '.response',
    );
    await expect(
      f.gate.boundary.dispatch(f.input, f.epoch, 'race', 'thread/start', {}, async () => {
        writeFileSync(target, JSON.stringify(f.proof));
        return { thread: { id: 's' } };
      }),
    ).rejects.toThrow('reader-dispatch-outcome-conflict');
    const filesPublish = files.publishFile,
      publish = vi.spyOn(files, 'publishFile');
    publish.mockImplementationOnce((...args) => filesPublish(...args));
    publish.mockImplementationOnce((...args) => filesPublish(...args));
    publish.mockImplementationOnce(() => {
      throw new Error('disk-full');
    });
    await expect(
      f.gate.boundary.dispatch(f.input, f.epoch, 'disk', 'thread/start', {}, async () => ({})),
    ).rejects.toThrow('disk-full');
    publish.mockRestore();
  });
});

describe('host wide model credits', () => {
  it('shares a fixed cap, recovers a repeated dispatch and refuses changed limits or hashes', () => {
    const f = controlFixture(),
      root = join(f.root, 'credits'),
      consume = readerBudget(root, 2);
    consume(digest('a'), digest('x'));
    consume(digest('a'), digest('x'));
    expect(() => consume(digest('a'), digest('y'))).toThrow('reader-model-credit-conflict');
    readerBudget(root, 2)(digest('b'), digest('x'));
    expect(() => consume(digest('c'), digest('x'))).toThrow('reader-model-budget-exhausted');
    expect(() => readerBudget(root, 3)).toThrow('reader-model-budget-conflict');
    expect(() => readerBudget(join(f.root, 'zero'), 0)(digest('a'), digest('b'))).toThrow(
      'reader-model-budget-exhausted',
    );
    for (const cap of [-1, 0.5, Infinity])
      expect(() => readerBudget(root, cap)).toThrow('reader-model-budget-invalid');
    for (const pair of [
      ['x', digest('x')],
      [digest('x'), 'x'],
    ])
      expect(() => consume(pair[0]!, pair[1]!)).toThrow('reader-model-credit-invalid');
    mkdirSync(join(root, 'lock'));
    expect(() => consume(digest('a'), digest('x'))).toThrow('EEXIST');
  });
  it('preserves unexpected IO errors while creating the limit or reserving a credit', () => {
    const f = controlFixture(),
      root = join(f.root, 'credits');
    mkdirSync(root);
    mkdirSync(join(root, 'limit'));
    expect(() => readerBudget(root, 1)).toThrow();
    rmSync(join(root, 'limit'), { recursive: true });
    const consume = readerBudget(root, 1);
    mkdirSync(join(root, '0.credit'));
    expect(() => consume(digest('a'), digest('x'))).toThrow();
  });
  it('propagates disk errors at both reservation boundaries without granting a credit', () => {
    const f = controlFixture(),
      root = join(f.root, 'credits'),
      publish = vi.spyOn(files, 'publishFile');
    publish.mockImplementationOnce(() => {
      throw new Error('disk-full');
    });
    expect(() => readerBudget(root, 1)).toThrow('disk-full');
    publish.mockRestore();
    const consume = readerBudget(root, 1),
      next = vi.spyOn(files, 'publishFile');
    next.mockImplementationOnce(() => {
      throw new Error('disk-full');
    });
    expect(() => consume(digest('a'), digest('x'))).toThrow('disk-full');
    next.mockRestore();
  });
});
