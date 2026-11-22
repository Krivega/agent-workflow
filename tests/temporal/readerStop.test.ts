import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlFixture } from './controlFixture.js';
import { readerControlActivities } from '../../src/activities/readerControl.js';
import { makeReaderCommand } from '../../src/client/reader.js';
import { readerKey } from '../../src/policy/readerControl.js';

describe('authorized reader control and physical stop', () => {
  it('does not certify stop after the dispatch journal is lost', async () => {
    const f = controlFixture();
    await f.gate.boundary.dispatch(
      f.input,
      f.epoch,
      'create',
      'thread/start',
      {},
      async () => f.response,
    );
    f.response.thread.turns.push({ id: 'one', status: 'inProgress' });
    const folder = join(f.boundaryRoot, readdirSync(f.boundaryRoot)[0]!);
    for (const name of readdirSync(folder).filter((name) => name.startsWith('request-')))
      rmSync(join(folder, name));
    f.gate.freeze(f.input, f.permit);
    await expect(f.controls.stopReader(f.input, f.permit, 1)).rejects.toThrow();
    expect(f.response.thread.turns[0]!.status).toBe('inProgress');
    expect(() => f.gate.advance(f.input, f.permit, f.command('resume', 1, 1), f.proof)).toThrow(
      'reader-control-terminal',
    );
  });
  it('requires exact target/hash/authority and allows initial-grant safety commands only', async () => {
    const f = controlFixture();
    expect(await f.controls.registerReader(f.input, readerKey(f.input))).toEqual(f.permit);
    await expect(f.controls.registerReader(f.input, 'wrong')).rejects.toThrow(
      'reader-workflow-id-mismatch',
    );
    await expect(
      f.controls.registerReader({ ...f.input, roleId: 'other' }, readerKey(f.input)),
    ).rejects.toThrow('reader-role-not-declared');
    const c = f.command();
    await expect(
      f.controls.applyReaderCommand(f.input, f.permit, { ...c, hash: 'b'.repeat(64) }),
    ).rejects.toThrow('reader-command-hash-invalid');
    for (const change of [{ author: 'foreign' }, { target: { ...c.target, hostId: 'foreign' } }])
      await expect(
        f.controls.applyReaderCommand(f.input, f.permit, makeReaderCommand({ ...c, ...change })),
      ).rejects.toThrow('reader-command-target-mismatch');
    for (const change of [{ origin: 'bot' }, { author: 'foreign' }, { hash: 'b'.repeat(64) }]) {
      f.authority.verify.mockResolvedValueOnce({
        origin: 'human',
        author: c.author,
        hash: c.hash,
        proof: f.proof,
        ...change,
      } as never);
      await expect(f.controls.applyReaderCommand(f.input, f.permit, c)).rejects.toThrow(
        'reader-command-authority-mismatch',
      );
    }
    f.authority.verify.mockResolvedValueOnce({
      origin: 'initial-grant',
      author: c.author,
      hash: c.hash,
      proof: f.proof,
    });
    const ack = await f.controls.applyReaderCommand(f.input, f.permit, c);
    f.authority.verify.mockClear();
    expect(await f.controls.applyReaderCommand(f.input, f.permit, c)).toEqual(ack);
    expect(f.authority.verify).not.toHaveBeenCalled();
    await f.controls.stopReader(f.input, f.permit, 1);
    const resume = f.command('resume', 1, 1);
    f.authority.verify.mockResolvedValueOnce({
      origin: 'initial-grant',
      author: resume.author,
      hash: resume.hash,
      proof: f.proof,
    });
    await expect(f.controls.applyReaderCommand(f.input, f.permit, resume)).rejects.toThrow(
      'reader-resume-human-required',
    );
    expect((await f.controls.applyReaderCommand(f.input, f.permit, resume)).revision).toBe(2);
    expect(await f.controls.freezeReader(f.input, f.permit)).toBe(3);
  });
  it('interrupts an occupied native turn and confirms primary terminal state before success', async () => {
    const f = controlFixture();
    await f.gate.boundary.dispatch(
      f.input,
      f.epoch,
      'create',
      'thread/start',
      {},
      async () => f.response,
    );
    await f.gate.boundary.dispatch(
      f.input,
      f.epoch,
      'send',
      'turn/start',
      { threadId: 'session' },
      async () => ({ turn: { id: 'one' } }),
    );
    f.response.thread.turns.push({ id: 'one', status: 'inProgress' });
    f.gate.freeze(f.input, f.permit);
    const result = await f.controls.stopReader(f.input, f.permit, 1);
    expect(result.status).toBe('stopped');
    expect(f.rpc.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'session',
      turnId: 'one',
    });
    expect(f.rpc.completed).toHaveBeenCalledWith('session', 'one', expect.any(AbortSignal));
    expect(
      (JSON.parse(f.store.read(result.receipt).toString()) as { confirmed: boolean }).confirmed,
    ).toBe(true);
    rmSync(f.workspace, { recursive: true });
    expect((await f.controls.stopReader(f.input, f.permit, 1)).status).toBe('stopped');
  });
  it('recovers an unknown send only by unique exact primary message after stopping', async () => {
    const f = controlFixture(),
      message = 'Workflow operation: send\nRead inputs';
    await f.gate.boundary.dispatch(
      f.input,
      f.epoch,
      'create',
      'thread/start',
      {},
      async () => f.response,
    );
    await expect(
      f.gate.boundary.dispatch(
        f.input,
        f.epoch,
        'send',
        'turn/start',
        {
          threadId: 'session',
          input: [{ type: 'text', text: message }],
        },
        async () => {
          throw new Error('lost');
        },
      ),
    ).rejects.toThrow('lost');
    f.response.thread.turns.push({
      id: 'one',
      status: 'inProgress',
      items: [{ type: 'userMessage', content: [{ type: 'text', text: message }] }],
    });
    f.gate.freeze(f.input, f.permit);
    expect((await f.controls.stopReader(f.input, f.permit, 1)).status).toBe('stopped');
    expect(f.rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(0);
    f.response.thread.turns = [];
    await expect(f.controls.stopReader(f.input, f.permit, 1)).rejects.toThrow(
      'reader-stop-unknown',
    );
  });
  it('preserves uncertainty after unknown creation or sends to a foreign session', async () => {
    for (const method of ['thread/start', 'turn/start'] as const) {
      const f = controlFixture();
      await expect(
        f.gate.boundary.dispatch(
          f.input,
          f.epoch,
          'unknown',
          method,
          { threadId: 'foreign' },
          async () => {
            throw new Error('lost');
          },
        ),
      ).rejects.toThrow('lost');
      f.gate.freeze(f.input, f.permit);
      await expect(f.controls.stopReader(f.input, f.permit, 1)).rejects.toThrow(
        'reader-stop-unknown',
      );
      expect(f.rpc.request).not.toHaveBeenCalled();
    }
  });
  it.each([
    'id',
    'cwd',
    'turns',
    'status',
    'missing',
    'duplicate',
    'still-active',
    'read-error',
    'interrupt-error',
    'wait-error',
    'bad-input',
    'bad-turn',
  ] as const)(
    'refuses missing, conflicting or nonterminal history and records the failure (%s)',
    async (defect) => {
      const f = controlFixture();
      await f.gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', {}, async () =>
        structuredClone(f.response),
      );
      if (defect === 'bad-input') {
        await expect(
          f.gate.boundary.dispatch(
            f.input,
            f.epoch,
            'send',
            'turn/start',
            { threadId: 'session', input: null },
            async () => {
              throw new Error('lost');
            },
          ),
        ).rejects.toThrow();
      } else
        await f.gate.boundary.dispatch(
          f.input,
          f.epoch,
          'send',
          'turn/start',
          { threadId: 'session' },
          async () => ({ turn: { id: defect === 'bad-turn' ? '' : 'one' } }),
        );
      f.response.thread.turns = [{ id: 'one', status: 'completed' }];
      if (defect === 'id') f.response.thread.id = 'foreign';
      if (defect === 'cwd') f.response.thread.cwd = 'foreign';
      if (defect === 'turns') f.response.thread.turns = null as never;
      if (defect === 'status') f.response.thread.turns[0]!.status = 'unknown';
      if (defect === 'missing') f.response.thread.turns = [];
      if (defect === 'duplicate') f.response.thread.turns.push({ id: 'one', status: 'failed' });
      const primary = f.rpc.request.getMockImplementation()!;
      if (['still-active', 'interrupt-error', 'wait-error'].includes(defect))
        f.response.thread.turns[0]!.status = 'inProgress';
      if (['read-error', 'interrupt-error', 'still-active'].includes(defect))
        f.rpc.request.mockImplementation(async (method, params) => {
          if (
            (method === 'thread/read' && defect === 'read-error') ||
            (method === 'turn/interrupt' && defect === 'interrupt-error')
          )
            throw new Error('offline');
          if (method === 'turn/interrupt' && defect === 'still-active') return {};
          return primary(method, params);
        });
      if (defect === 'wait-error') f.rpc.completed.mockRejectedValueOnce(new Error('offline'));
      f.gate.freeze(f.input, f.permit);
      await expect(f.controls.stopReader(f.input, f.permit, 1)).rejects.toThrow(
        'reader-stop-unknown',
      );
    },
  );
  it('does not perform native IO until fencing and registration are confirmed', async () => {
    const f = controlFixture();
    await expect(f.controls.stopReader(f.input, f.permit, 1)).rejects.toThrow(
      'reader-stop-not-fenced',
    );
    expect(f.rpc.request).not.toHaveBeenCalled();
    const foreign = readerControlActivities(
      { ...f.registration, owner: 'other' },
      f.rpc,
      f.gate,
      f.authority,
    );
    await expect(foreign.freezeReader(f.input, f.permit)).rejects.toThrow();
    await f.gate.boundary.dispatch(f.input, f.epoch, 'create', 'thread/start', {}, async () => ({
      ...f.response,
      cwd: 'foreign',
    }));
    f.gate.freeze(f.input, f.permit);
    await expect(f.controls.stopReader(f.input, f.permit, 1)).rejects.toThrow(
      'reader-stop-unknown',
    );
  });
});
