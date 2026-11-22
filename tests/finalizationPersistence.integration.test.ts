import { beginFinalization, advanceFinalization } from '../application/finalizationWorkflow.js';
import { ControllerFinalizationJournal } from '../adapters/storage/finalizationJournal.js';
import { finalizationFixture } from './finalizationFixtures.js';
import { signed } from './storageFixtures.js';
import type { FinalizationLog } from '../core/finalization.js';
import type { StoreReply, TechnicalState, Json } from '../core/evidence.js';
let f: Awaited<ReturnType<typeof finalizationFixture>>;
beforeEach(async () => {
  f = await finalizationFixture();
});
afterEach(async () => {
  await f.dispose();
});
const failure: StoreReply = {
  ok: false,
  error: {
    code: 'unknown-outcome',
    operation_id: null,
    observed_revision: null,
    retryable: false,
    recovery_locator: 'fixture',
  },
};
it('starts retention-only finalization without granting cleanup authority', async () => {
  await beginFinalization({ ...f.seed, policy: { mode: 'retain' } }, f.journal, f.archive);
  expect((await f.log()).seed.policy).toEqual({ mode: 'retain' });
  expect((await f.current()).phase).toBe('started');
});
it('restarts from durable journal, cancels separately from done and rejects duplicate start', async () => {
  await expect(
    advanceFinalization(
      { type: 'CANCEL', reason: 'stop', id: 'c', revision: 0 },
      f.journal,
      f.archive,
    ),
  ).rejects.toThrow('not-found');
  await beginFinalization(f.seed, f.journal, f.archive);
  await expect(beginFinalization(f.seed, f.journal, f.archive)).rejects.toThrow('already-exists');
  const log = await f.log(),
    copy = new ControllerFinalizationJournal(f.store, f.context, 1);
  expect(await copy.read()).toEqual(log);
  await copy.save(log, log);
  const event = {
    type: 'CANCEL' as const,
    reason: 'operator cancelled finalization',
    id: 'cancel',
    revision: 0,
  };
  const result = await advanceFinalization(event, copy, f.archive);
  expect(await advanceFinalization(event, copy, f.archive)).toEqual(result);
  expect(result.phase).toBe('cancelled');
  const source = f.db.execute({ type: 'state' });
  expect(source.ok && source.value).toMatchObject({
    checkpoint: { workflow: { execution: { status: 'done' } } },
  });
});
it('keeps control journal outside source and enforces append-only CAS and unknown-write recovery', async () => {
  const initial: FinalizationLog = { schema_version: 1, seed: f.seed, events: [] };
  await expect(
    new ControllerFinalizationJournal(
      f.store,
      { ...f.context, run_id: f.seed.run.spec.run_id },
      1,
    ).save(null, initial),
  ).rejects.toThrow('external-controller');
  const cancelled = {
    ...initial,
    events: [{ type: 'CANCEL' as const, reason: 'cancelled', id: 'cancel', revision: 0 }],
  };
  await expect(f.journal.save(null, cancelled)).rejects.toThrow('append-only');
  await beginFinalization(f.seed, f.journal, f.archive);
  await expect(
    f.journal.save({ ...initial, seed: { ...f.seed, id: 'other' } }, cancelled),
  ).rejects.toThrow('append-only');
  await expect(f.journal.save(cancelled, cancelled)).rejects.toThrow('append-only');
  await expect(
    f.journal.save(null, { ...initial, seed: { ...f.seed, id: 'other' } }),
  ).rejects.toThrow('revision-conflict');
  const reply = await f.store.execute({ context: f.context, command: { type: 'state' } });
  if (!reply.ok) throw Error('fixture');
  const state = reply.value as TechnicalState;
  const unavailable = new ControllerFinalizationJournal(
    { execute: async () => failure },
    f.context,
    1,
  );
  await expect(unavailable.read()).rejects.toThrow('unavailable');
  const writeFailed = new ControllerFinalizationJournal(
    { execute: async (r) => (r.command.type === 'state' ? reply : failure) },
    f.context,
    1,
  );
  await expect(writeFailed.save(initial, cancelled)).rejects.toThrow('write-rejected');
  const empty = new ControllerFinalizationJournal(
    { execute: async () => ({ ok: true, value: { ...state, checkpoint: { other: 'keep' } } }) },
    f.context,
    1,
  );
  expect(await empty.read()).toBeNull();
  const corrupt = new ControllerFinalizationJournal(
    {
      execute: async () => ({
        ok: true,
        value: { ...state, checkpoint: { finalization: { schema_version: 999 } } },
      }),
    },
    f.context,
    1,
  );
  await expect(corrupt.read()).rejects.toThrow('unsupported');
});
it('rejects a cancellation that arrives while external proofs are being observed', async () => {
  await beginFinalization(f.seed, f.journal, f.archive);
  const event = { type: 'CANCEL' as const, id: 'cancel', revision: 0, reason: 'cancel' };
  const verification = {
    verify: async () => {
      await f.send({ type: 'CANCEL', reason: 'new request' });
    },
    prepare: async () => {},
    confirm: async () => {},
  };
  await expect(advanceFinalization(event, f.journal, verification)).rejects.toThrow(
    'observation-stale',
  );
  expect((await f.current()).phase).toBe('cancelled');
});
it('preserves neighbouring controller fields and rejects source changes during preparation', async () => {
  const before = await f.store.execute({ context: f.context, command: { type: 'state' } });
  if (!before.ok) throw Error('fixture');
  f.controllerDb.execute(
    signed(
      { type: 'checkpoint', state: { other: 'keep' }, effects: [] },
      (before.value as TechnicalState).revision,
      1,
      'neighbour',
      { context: f.context, permissions: ['read', 'produce', 'resolve', 'manage'] },
    ),
  );
  await beginFinalization(f.seed, f.journal, f.archive);
  const after = await f.store.execute({ context: f.context, command: { type: 'state' } });
  expect(after.ok && after.value).toMatchObject({ checkpoint: { other: 'keep' } });
  const original = f.archive.verify.bind(f.archive);
  let changed = false;
  vi.spyOn(f.archive, 'verify').mockImplementation(async (refs) => {
    await original(refs);
    if (!changed) {
      changed = true;
      f.db.mutate(
        {
          type: 'checkpoint',
          state: { ...f.checkpoint, late: 'new' } as unknown as Json,
          effects: [],
        },
        3,
      );
    }
  });
  await expect(f.archive.freeze(f.seed)).rejects.toThrow('source-changed');
});
