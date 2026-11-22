import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlFixture } from './controlFixture.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerExecution } from '../../src/policy/readerExecution.js';
import { readerTarget, readerKey, parseReaderInput } from '../../src/policy/readerControl.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import * as files from '../../src/adapters/artifacts/files.js';
import { recoverReaderHost } from '../../src/worker/readerRecovery.js';
import { localTaskFixture } from './localTaskFixture.js';

afterEach(() => {
  vi.restoreAllMocks();
});
function fixture() {
  const f = controlFixture(),
    root = join(f.root, 'dead-host'),
    project = join(root, digest(f.input.preparation.project.projectId)),
    permissions = join(project, 'permissions'),
    admissions = join(root, 'admissions');
  mkdirSync(admissions, { recursive: true });
  const gate = readerBoundary(permissions, f.store, f.workspace, readerExecution(f.profile)),
    permit = gate.install(f.input),
    epoch = { permit, revision: 0, attempt: 0 };
  const key = digest(JSON.stringify(readerTarget(f.input, readerKey(f.input)))),
    folder = join(permissions, key),
    ownerFile = join(root, 'host-owner');
  writeFileSync(ownerFile, JSON.stringify({ pid: 999999, id: 'dead-owner' }));
  writeFileSync(
    join(admissions, key),
    JSON.stringify({
      schemaVersion: 1,
      target: readerTarget(f.input, readerKey(f.input)),
      inputHash: digest(JSON.stringify(parseReaderInput(f.input))),
      permit,
    }),
  );
  const dead = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  });
  const projects = [{ registration: f.registration, rpc: f.rpc, authority: f.authority }];
  const recover = () => recoverReaderHost(projects, root, f.profile, [f.input]);
  const create = () =>
    gate.boundary.dispatch(f.input, epoch, 'create', 'thread/start', {}, async () =>
      structuredClone(f.response),
    );
  return {
    ...f,
    root,
    project,
    permissions,
    admissions,
    key,
    folder,
    ownerFile,
    gate,
    permit,
    epoch,
    projects,
    dead,
    recover,
    create,
  };
}
describe('dead reader host recovery from primary evidence', () => {
  it('keeps a reader-only host when its card changed', async () => {
    const f = fixture();
    writeFileSync(join(f.workspace, f.input.preparation.card), 'edited');
    await expect(f.recover()).rejects.toThrow('reader-card-changed');
    expect(existsSync(f.ownerFile)).toBe(true);
  });
  it('accepts an empty task inventory for a reader-only host and refuses an undeclared task', async () => {
    const f = fixture(),
      permission = readFileSync(join(f.folder, 'permission.json'));
    await expect(
      recoverReaderHost(f.projects, f.root, f.profile, [f.input], [localTaskFixture().input]),
    ).rejects.toThrow('task-recovery-inventory-undeclared');
    expect(existsSync(f.ownerFile)).toBe(true);
    expect(readFileSync(join(f.folder, 'permission.json'))).toEqual(permission);
    expect(f.rpc.request).not.toHaveBeenCalled();
    await recoverReaderHost(f.projects, f.root, f.profile, [f.input], []);
    expect(existsSync(f.ownerFile)).toBe(false);
    expect(f.rpc.request).not.toHaveBeenCalled();
  });
  it('never reclaims native auditors using reader-only evidence', async () => {
    const f = fixture();
    writeFileSync(f.ownerFile, JSON.stringify({ pid: 999999, id: 'dead-owner', audits: true }));
    await expect(f.recover()).rejects.toThrow('reader-recovery-auditors-unsupported');
    expect(existsSync(f.ownerFile)).toBe(true);
    expect(f.rpc.request).not.toHaveBeenCalled();
  });
  it('never reclaims a writer-enabled host using reader-only evidence', async () => {
    const f = fixture();
    writeFileSync(f.ownerFile, JSON.stringify({ pid: 999999, id: 'dead-owner', tasks: true }));
    await expect(f.recover()).rejects.toThrow('reader-recovery-writers-unsupported');
    expect(existsSync(f.ownerFile)).toBe(true);
    expect(f.rpc.request).not.toHaveBeenCalled();
  });
  it('preserves owner/generation/permissions and removes a stale lock only after primary terminal proof', async () => {
    const f = fixture();
    await f.create();
    await f.gate.boundary.dispatch(
      f.input,
      f.epoch,
      'load',
      'turn/start',
      { threadId: 'session' },
      async () => ({ turn: { id: 'one' } }),
    );
    f.response.thread.turns = [{ id: 'one', status: 'completed' }];
    mkdirSync(join(f.folder, 'lock'));
    const before = readFileSync(join(f.folder, 'permission.json'));
    expect((await f.recover()).proofs).toHaveLength(1);
    expect(existsSync(f.ownerFile)).toBe(false);
    expect(existsSync(join(f.folder, 'lock'))).toBe(false);
    expect(readFileSync(join(f.folder, 'permission.json'))).toEqual(before);
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(['thread/read']);
    expect(readdirSync(f.root).some((name) => name.startsWith('recovery-'))).toBe(true);
  });
  it('keeps the previous host reserved while a turn is busy or its terminal history is invalid', async () => {
    for (const defect of [
      'active',
      'duplicate',
      'missing',
      'foreign-id',
      'foreign-cwd',
      'turns',
      'read-error',
    ] as const) {
      const f = fixture();
      await f.create();
      f.response.thread.turns = [
        { id: 'one', status: defect === 'active' ? 'inProgress' : 'completed' },
      ];
      if (defect === 'duplicate') f.response.thread.turns.push({ id: 'one', status: 'completed' });
      if (defect === 'missing') f.response.thread.turns[0]!.id = '';
      if (defect === 'foreign-id') f.response.thread.id = 'foreign';
      if (defect === 'foreign-cwd') f.response.thread.cwd = 'foreign';
      if (defect === 'turns') f.response.thread.turns = null as never;
      if (defect === 'read-error') f.rpc.request.mockRejectedValueOnce(new Error('offline'));
      await expect(f.recover()).rejects.toThrow();
      expect(existsSync(f.ownerFile)).toBe(true);
      expect(existsSync(join(f.root, 'host-recovery-lock'))).toBe(false);
      f.dead.mockRestore();
    }
  });
  it('never repeats an unknown creation or adopts a send to an unregistered/missing turn', async () => {
    for (const defect of ['create', 'session', 'turn', 'send-input', 'send-missing'] as const) {
      const f = fixture();
      if (defect === 'create')
        await expect(
          f.gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', {}, async () => {
            throw new Error('lost');
          }),
        ).rejects.toThrow();
      else {
        await f.create();
        const send = f.gate.boundary.dispatch(
          f.input,
          f.epoch,
          'send',
          'turn/start',
          {
            threadId: defect === 'session' ? 'foreign' : 'session',
            input: defect === 'send-input' ? null : [{ type: 'text', text: 'marker' }],
          },
          async () => {
            if (defect === 'turn') return { turn: { id: 'missing' } };
            throw new Error('lost');
          },
        );
        if (defect === 'turn') await send;
        else await expect(send).rejects.toThrow('lost');
      }
      await expect(f.recover()).rejects.toThrow();
      expect(existsSync(f.ownerFile)).toBe(true);
      expect(f.rpc.request.mock.calls.every(([method]) => method === 'thread/read')).toBe(true);
      f.dead.mockRestore();
    }
  });
  it('recovers a lost send response only by the unique original primary message', async () => {
    const f = fixture();
    await f.create();
    await expect(
      f.gate.boundary.dispatch(
        f.input,
        f.epoch,
        'send',
        'turn/start',
        { threadId: 'session', input: [{ type: 'text', text: 'marker' }] },
        async () => {
          throw new Error('lost');
        },
      ),
    ).rejects.toThrow();
    f.response.thread.turns = [
      {
        id: 'one',
        status: 'completed',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: 'marker' }] }],
      },
    ];
    await f.recover();
    expect(existsSync(f.ownerFile)).toBe(false);
  });
  it('rejects a living, reused, inaccessible or malformed owner PID', async () => {
    const f = fixture();
    f.dead.mockImplementationOnce(() => true);
    await expect(f.recover()).rejects.toThrow('reader-host-still-alive');
    f.dead.mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    await expect(f.recover()).rejects.toThrow('denied');
    writeFileSync(f.ownerFile, JSON.stringify({ pid: 0, id: 'x' }));
    await expect(f.recover()).rejects.toThrow('reader-host-owner-invalid');
  });
  it('requires a complete inventory and refuses missing or conflicting bindings', async () => {
    const f = fixture();
    await expect(recoverReaderHost([], f.root, f.profile, [])).rejects.toThrow(
      'inventory-required',
    );
    await expect(recoverReaderHost(f.projects, f.root, f.profile, [])).rejects.toThrow(
      'admission-incomplete',
    );
    await expect(
      recoverReaderHost(f.projects, f.root, f.profile, [f.input, f.input]),
    ).rejects.toThrow('admission-incomplete');
    mkdirSync(join(f.permissions, 'unknown'));
    await expect(f.recover()).rejects.toThrow('assignment-incomplete');
    rmSync(join(f.permissions, 'unknown'), { recursive: true });
    mkdirSync(join(f.root, 'a'.repeat(64)));
    await expect(f.recover()).rejects.toThrow('project-incomplete');
    rmSync(join(f.root, 'a'.repeat(64)), { recursive: true });
    writeFileSync(join(f.admissions, f.key), '{}');
    await expect(f.recover()).rejects.toThrow('admission-mismatch');
  });
  it('rechecks owner and journal bytes after reading primary evidence', async () => {
    for (const defect of ['owner', 'permission', 'admission', 'pid'] as const) {
      const f = fixture();
      await f.create();
      const original = f.rpc.request.getMockImplementation()!;
      f.rpc.request.mockImplementationOnce(async (...args) => {
        if (defect === 'owner')
          writeFileSync(f.ownerFile, JSON.stringify({ pid: 999998, id: 'changed' }));
        if (defect === 'permission') {
          const file = join(f.folder, 'permission.json'),
            value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
          writeFileSync(file, JSON.stringify({ ...value, revision: 1 }));
        }
        if (defect === 'admission') writeFileSync(join(f.admissions, f.key), '{}');
        if (defect === 'pid') f.dead.mockImplementationOnce(() => true);
        return original(...args);
      });
      await expect(f.recover()).rejects.toThrow();
      expect(existsSync(f.ownerFile)).toBe(true);
      f.dead.mockRestore();
    }
  });
  it('preserves uncertainty on receipt storage failure and permits an exact recheck', async () => {
    const f = fixture(),
      original = files.publishFile;
    const publish = vi.spyOn(files, 'publishFile').mockImplementation((path, bytes) => {
      if (path.includes('/recovery-'))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return original(path, bytes);
    });
    await expect(f.recover()).rejects.toThrow('disk full');
    expect(existsSync(f.ownerFile)).toBe(true);
    publish.mockRestore();
    await f.recover();
    expect(existsSync(f.ownerFile)).toBe(false);
  });
  it('accepts an identical recovery receipt after interruption and rejects conflicting bytes', async () => {
    for (const conflict of [false, true]) {
      const f = fixture(),
        original = files.publishFile;
      const publish = vi.spyOn(files, 'publishFile').mockImplementation((path, bytes) => {
        if (path.includes('/recovery-')) {
          original(path, conflict ? Buffer.from('{}') : bytes);
          throw Object.assign(new Error('already published'), { code: 'EEXIST' });
        }
        return original(path, bytes);
      });
      if (conflict) await expect(f.recover()).rejects.toThrow('reader-recovery-receipt-conflict');
      else await f.recover();
      expect(existsSync(f.ownerFile)).toBe(conflict);
      publish.mockRestore();
      f.dead.mockRestore();
    }
  });
});
