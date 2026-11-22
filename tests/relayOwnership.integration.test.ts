import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { TaskRelayOwnership } from '../adapters/storage/relayOwnership.js';
import { AssignmentRelayOwnership } from '../adapters/storage/assignmentRelayOwnership.js';
import { AssignmentLocalRuns } from '../adapters/storage/localRunStores.js';
import { SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { adoptedCheckpoint, readySuccessor } from '../core/relayCheckpoint.js';
import { createRelay, successorRun } from '../core/relay.js';
import { applyLocalEvent } from '../core/localRun.js';
import type { LocalRun } from '../core/localRun.js';
import type { OperationResult, StoreReply, TechnicalState } from '../core/evidence.js';
import { relayFixture } from './relayFixtures.js';
import { fixture, grant } from './storageFixtures.js';
let f: Awaited<ReturnType<typeof relayFixture>>;
let db: ReturnType<typeof fixture>;
beforeEach(async () => {
  f = await relayFixture();
  db = fixture();
  db.claim();
  db.mutate({ type: 'checkpoint', state: f.seed.checkpoint, effects: [] }, 1);
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});
const failure: StoreReply = {
  ok: false,
  error: {
    code: 'unknown-outcome',
    operation_id: null,
    observed_revision: null,
    retryable: true,
    recovery_locator: 'fixture',
  },
};
const current = (): TechnicalState => {
  const reply = db.execute({ type: 'state' });
  if (!reply.ok) throw Error('fixture unavailable');
  return reply.value as TechnicalState;
};

it('releases the actual source lease, preserves its checkpoint and fences late writes after successor claim', async () => {
  const source = new TaskRelayOwnership(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
  );
  const receipt = await source.release(f.seed, f.proof, resolve(f.root, 'release.json'));
  expect(JSON.parse(await readFile(receipt.locator, 'utf8'))).toMatchObject({
    kind: 'release',
    generation: 1,
    released: true,
    snapshot: f.seed.snapshot,
  });
  const successorContext = { ...grant.context, actor_id: 'new-owner', run_id: 'relay:successor' };
  const successorDb = new SqliteEvidenceStore(
    db.root,
    { ...grant, context: successorContext },
    () => 100,
  );
  const target = new TaskRelayOwnership(
    { execute: async (r) => successorDb.execute(r) },
    successorContext,
  );
  const adopted = await target.claim(f.seed, 1000);
  expect(adopted.generation).toBe(2);
  const run = readySuccessor(f.seed, {
    ...createRelay(f.seed),
    successor: f.successor,
    loaded: { ...f.executor.loaded!, run_id: 'relay:successor', session_id: 'successor' },
  });
  const active = await target.adopt(f.seed, run);
  expect(active.checkpoint).toEqual(adoptedCheckpoint(f.seed, run));
  expect(adopted.checkpoint).toEqual(f.seed.checkpoint);
  expect(
    db.mutate(
      { type: 'checkpoint', state: { late: true }, effects: [] },
      adopted.revision,
      1,
      'late',
    ).ok,
  ).toBe(false);
  await expect(target.claim(f.seed, 1000)).rejects.toThrow('relay-claim-forbidden');
  await expect(source.release(f.seed, f.proof, receipt.locator)).rejects.toThrow(
    'relay-source-changed',
  );
});

it('recovers the committed release after a receipt write failure without repeating the mutation', async () => {
  const path = resolve(f.root, 'missing', 'release.json');
  const source = () =>
    new TaskRelayOwnership({ execute: async (r) => db.store.execute(r) }, grant.context);
  await expect(source().release(f.seed, f.proof, path)).rejects.toMatchObject({ code: 'ENOENT' });
  const released = current();
  expect(released.released).toBe(true);
  expect(db.execute({ type: 'operation', operation_id: `${f.seed.id}:release` })).toMatchObject({
    ok: true,
    value: { status: 'confirmed' },
  });
  await mkdir(resolve(f.root, 'missing'));
  const recovered = await source().release(f.seed, f.proof, path);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
    kind: 'release',
    snapshot: f.seed.snapshot,
    stopped: f.proof,
    store: released,
  });
  expect(await source().release(f.seed, f.proof, path)).toEqual(recovered);
  expect(current()).toEqual(released);
  await writeFile(path, 'unrelated receipt');
  await expect(source().release(f.seed, f.proof, path)).rejects.toThrow(
    'relay-release-receipt-conflict',
  );
  expect(await readFile(path, 'utf8')).toBe('unrelated receipt');
});

it('recovers an unknown release reply from the durable operation and rejects a changed payload', async () => {
  let loseReply = true;
  const store = new SqliteEvidenceStore(
    db.root,
    grant,
    () => 100,
    (boundary) => {
      if (boundary === 'after-commit' && loseReply) {
        loseReply = false;
        throw new Error('lost reply after commit');
      }
    },
  );
  const source = new TaskRelayOwnership({ execute: async (r) => store.execute(r) }, grant.context);
  const path = resolve(f.root, 'release.json');
  await expect(source.release(f.seed, f.proof, path)).rejects.toThrow('relay-release-unknown');
  const released = current();
  await expect(source.release(f.seed, { ...f.proof, locator: 'other-stop' }, path)).rejects.toThrow(
    'relay-release-unknown',
  );
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(current()).toEqual(released);
  await source.release(f.seed, f.proof, path);
  expect(current()).toEqual(released);
});

it('requires the original durable release ack and refuses a foreign actor during recovery', async () => {
  const source = new TaskRelayOwnership(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
  );
  const path = resolve(f.root, 'release.json');
  await source.release(f.seed, f.proof, path);
  const released = current();
  const stored = db.execute({ type: 'operation', operation_id: `${f.seed.id}:release` });
  if (!stored.ok) throw new Error('fixture unavailable');
  const operation = stored.value as OperationResult;
  if (operation.status !== 'confirmed') throw new Error('fixture release missing');
  for (const reply of [
    failure,
    { ok: true as const, value: { status: 'not-started' as const } },
    ...[
      { operation_id: 'other:release' },
      { generation: 2 },
      { catalog_revision: released.revision + 1 },
    ].map((patch): StoreReply => ({
      ok: true,
      value: { ...operation, ack: { ...operation.ack, ...patch } },
    })),
  ]) {
    const guarded = new TaskRelayOwnership(
      {
        execute: async (r) => (r.command.type === 'operation' ? reply : db.store.execute(r)),
      },
      grant.context,
    );
    await expect(guarded.release(f.seed, f.proof, path)).rejects.toThrow(
      reply.ok ? 'relay-source-changed' : 'relay-release-unknown',
    );
  }
  const foreign = { ...grant, context: { ...grant.context, actor_id: 'foreign' } };
  const foreignStore = new SqliteEvidenceStore(db.root, foreign, () => 100);
  await expect(
    new TaskRelayOwnership(
      { execute: async (r) => foreignStore.execute(r) },
      foreign.context,
    ).release(f.seed, f.proof, path),
  ).rejects.toThrow('relay-release-unknown');
  expect(current()).toEqual(released);
});

it('rejects changed source and ambiguous release/claim results without manufacturing a receipt', async () => {
  const initial = current();
  const context = grant.context;
  const reply = (value: TechnicalState): StoreReply => ({ ok: true, value });
  for (const patch of [{ released: true }, { generation: 2 }, { checkpoint: null }]) {
    const source = new TaskRelayOwnership(
      { execute: async () => reply({ ...initial, ...patch }) },
      context,
    );
    await expect(source.release(f.seed, f.proof, resolve(f.root, 'unused'))).rejects.toThrow(
      'relay-source-changed',
    );
  }
  await expect(
    new TaskRelayOwnership(
      { execute: async () => reply(initial) },
      { ...context, run_id: 'other' },
    ).release(f.seed, f.proof, 'unused'),
  ).rejects.toThrow('relay-source-changed');
  await expect(
    new TaskRelayOwnership({ execute: async () => failure }, context).release(
      f.seed,
      f.proof,
      'unused',
    ),
  ).rejects.toThrow('relay-source-unavailable');
  const sequence = (values: StoreReply[]) => ({ execute: async () => values.shift()! });
  await expect(
    new TaskRelayOwnership(sequence([reply(initial), failure]), context).release(
      f.seed,
      f.proof,
      'unused',
    ),
  ).rejects.toThrow('relay-release-unknown');
  const released = { ...initial, released: true };
  for (const patch of [{ released: false }, { generation: 2 }, { checkpoint: null }]) {
    await expect(
      new TaskRelayOwnership(
        sequence([reply(initial), reply(released), reply({ ...released, ...patch })]),
        context,
      ).release(f.seed, f.proof, 'unused'),
    ).rejects.toThrow('relay-release-unconfirmed');
  }
  const successorContext = { ...context, run_id: 'relay:successor', actor_id: 'new' };
  for (const patch of [{ released: false }, { generation: 2 }, { checkpoint: null }])
    await expect(
      new TaskRelayOwnership(
        { execute: async () => reply({ ...released, ...patch }) },
        successorContext,
      ).claim(f.seed, 1000),
    ).rejects.toThrow('relay-claim-forbidden');
  await expect(
    new TaskRelayOwnership({ execute: async () => reply(released) }, context).claim(f.seed, 1000),
  ).rejects.toThrow('relay-claim-forbidden');
  await expect(
    new TaskRelayOwnership(sequence([reply(released), failure]), successorContext).claim(
      f.seed,
      1000,
    ),
  ).rejects.toThrow('relay-claim-unknown');
  const adopted = { ...initial, generation: 2, owner: 'new' };
  for (const patch of [{ released: true }, { generation: 1 }, { owner: 'other' }])
    await expect(
      new TaskRelayOwnership(
        sequence([reply(released), reply(adopted), reply({ ...adopted, ...patch })]),
        successorContext,
      ).claim(f.seed, 1000),
    ).rejects.toThrow('relay-claim-unconfirmed');
});

it('releases a cardless assignment and adopts it in a fresh assignment without a task Store', async () => {
  f.seed.predecessor.spec.product = false;
  f.seed.predecessor.spec.identity = { assignment_id: 'cardless' };
  const source = new AssignmentLocalRuns(resolve(f.root, 'source-assignment'));
  const successor = new AssignmentLocalRuns(resolve(f.root, 'new-assignment'));
  await source.save(null, f.seed.predecessor);
  const control = new AssignmentRelayOwnership(source, successor);
  const stopped = await control.release(
    f.seed,
    f.proof,
    resolve(f.root, 'assignment-release.json'),
  );
  expect(JSON.parse(await readFile(stopped.locator, 'utf8'))).toMatchObject({
    kind: 'release',
    released: true,
    generation: 1,
  });
  const old = (await source.read())!;
  expect(old.status).toBe('cancelled');
  expect(() =>
    applyLocalEvent(old, {
      type: 'READY',
      event_id: 'late',
      expected_revision: old.revision,
      generation: old.generation,
    }),
  ).toThrow('run-cancelled');
  await expect(source.save(f.seed.predecessor, f.seed.predecessor)).rejects.toThrow(
    'run-revision-conflict',
  );
  const run = successorRun(f.seed, f.successor);
  expect(await control.claim(f.seed, run)).toEqual(run);
  expect(await successor.read()).toEqual(run);
  await expect(control.claim(f.seed, run)).rejects.toThrow('assignment-successor-exists');
});

it('refuses cardless ownership when the source, generation, identity or durable confirmation is missing', async () => {
  f.seed.predecessor.spec.product = false;
  f.seed.predecessor.spec.identity = { assignment_id: 'cardless' };
  const local = f.seed.predecessor,
    next = successorRun(f.seed, f.successor);
  const target = { read: async () => null, save: async () => {} };
  for (const value of [
    null,
    { ...local, spec: { ...local.spec, identity: { task_id: 'task', card: f.proof } } },
    { ...local, revision: 99 },
  ]) {
    await expect(
      new AssignmentRelayOwnership(
        { read: async () => value, save: async () => {} },
        target,
      ).release(f.seed, f.proof, 'unused'),
    ).rejects.toThrow('assignment-relay-source-changed');
  }
  await expect(
    new AssignmentRelayOwnership({ read: async () => local, save: async () => {} }, target).release(
      f.seed,
      f.proof,
      'unused',
    ),
  ).rejects.toThrow('assignment-release-unconfirmed');
  const released: LocalRun = { ...local, status: 'cancelled', generation: 2 };
  for (const value of [
    null,
    { ...released, status: 'ready' as const },
    { ...released, generation: 3 },
    { ...released, spec: { ...released.spec, run_id: 'other' } },
  ]) {
    await expect(
      new AssignmentRelayOwnership({ read: async () => value, save: async () => {} }, target).claim(
        f.seed,
        next,
      ),
    ).rejects.toThrow('assignment-claim-forbidden');
  }
  const source = { read: async () => released, save: async () => {} };
  for (const run of [
    { ...next, spec: { ...next.spec, run_id: 'other' } },
    { ...next, generation: 3 },
    { ...next, spec: { ...next.spec, identity: { task_id: 'task', card: f.proof } } },
    { ...next, spec: { ...next.spec, identity: { assignment_id: 'other' } } },
  ])
    await expect(new AssignmentRelayOwnership(source, target).claim(f.seed, run)).rejects.toThrow(
      'assignment-claim-forbidden',
    );
  await expect(
    new AssignmentRelayOwnership(source, target).claim(
      { ...f.seed, predecessor: { ...local, generation: 4 } },
      next,
    ),
  ).rejects.toThrow('assignment-claim-forbidden');
  await expect(new AssignmentRelayOwnership(source, target).claim(f.seed, next)).rejects.toThrow(
    'assignment-claim-unconfirmed',
  );
});

it('requires claimed ownership and confirms the persisted working checkpoint before adoption', async () => {
  const initial = { ...current(), owner: 'new', generation: 2 };
  const context = { ...grant.context, actor_id: 'new', run_id: 'relay:successor' };
  const run = readySuccessor(f.seed, {
    ...createRelay(f.seed),
    successor: f.successor,
    loaded: { ...f.executor.loaded!, run_id: 'relay:successor', session_id: 'successor' },
  });
  const reply = (value: TechnicalState): StoreReply => ({ ok: true, value });
  for (const patch of [
    { released: true },
    { generation: 1 },
    { owner: 'other' },
    { checkpoint: null },
  ]) {
    const control = new TaskRelayOwnership(
      { execute: async () => reply({ ...initial, ...patch }) },
      context,
    );
    await expect(control.adopt(f.seed, run)).rejects.toThrow('relay-adoption-ownership-mismatch');
  }
  await expect(
    new TaskRelayOwnership({ execute: async () => reply(initial) }, grant.context).adopt(
      f.seed,
      run,
    ),
  ).rejects.toThrow('relay-adoption-ownership-mismatch');
  let replies: StoreReply[] = [reply(initial), failure];
  const control = new TaskRelayOwnership({ execute: async () => replies.shift()! }, context);
  await expect(control.adopt(f.seed, run)).rejects.toThrow('relay-adoption-unknown');
  replies = [reply(initial), reply(initial), reply(initial)];
  await expect(control.adopt(f.seed, run)).rejects.toThrow('relay-adoption-unconfirmed');
});
