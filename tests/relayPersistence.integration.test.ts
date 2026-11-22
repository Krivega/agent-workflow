import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ControllerRelayJournal } from '../adapters/storage/relayJournal.js';
import { FileRelayProofs } from '../adapters/project/relayProofs.js';
import { beginRelay, advanceRelay, dispatchRelay } from '../application/relayWorkflow.js';
import { adoptedCheckpoint, readySuccessor } from '../core/relayCheckpoint.js';
import { createRelay, replayRelay, successorRun } from '../core/relay.js';
import type { RelayAction, RelayEvent, RelayLog, RelayState } from '../core/relay.js';
import type { InputRef } from '../core/localRun.js';
import { relayFixture } from './relayFixtures.js';
import { fixture, grant } from './storageFixtures.js';
let f: Awaited<ReturnType<typeof relayFixture>>;
let db: ReturnType<typeof fixture>;
let journal: ControllerRelayJournal;
let proofs: FileRelayProofs;
let state: RelayState;
const file = async (name: string, value: unknown) => {
  await f.file(name, JSON.stringify(value));
  return f.ref(name);
};
const send = async (action: RelayAction) => {
  state = await advanceRelay(
    { ...action, id: `e-${state.revision}`, revision: state.revision },
    journal,
    proofs,
  );
  return state;
};
const stopProof = () => ({
  kind: 'writers-stopped',
  thread: 'session',
  active_turn: false,
  remaining_terminals: 0,
  remaining_processes: 0,
  before_hash: 'fixed',
  after_hash: 'fixed',
  observation_ms: 250,
});
const releaseProof = () => ({
  kind: 'release',
  predecessor: 'source',
  generation: 1,
  released: true,
  snapshot: f.seed.snapshot,
  stopped: state.stopped,
});
const identityProof = () => ({
  session: {
    thread: { id: 'successor', projectId: 'native', forkedFromId: null, turns: [] },
    cwd: f.root,
    model: f.successor.model,
    reasoningEffort: f.successor.effort,
    sandbox: { type: 'workspaceWrite', networkAccess: false },
  },
});
const adoptionProof = () => ({
  working_checkpoint: adoptedCheckpoint(f.seed, readySuccessor(f.seed, state)),
  kind: 'adoption',
  session: 'successor',
  generation: 2,
  snapshot: f.seed.snapshot,
  release: state.release,
  checkpoint: f.seed.checkpoint,
  progress: f.seed.progress,
});
beforeEach(async () => {
  f = await relayFixture();
  f.seed.predecessor.spec.run_id = 'source';
  f.seed.predecessor.spec.writer = 'source';
  f.seed.predecessor.loaded!.run_id = 'source';
  f.seed.snapshot = await file('snapshot.json', {
    checkpoint: f.seed.checkpoint,
    progress: f.seed.progress,
  });
  f.seed.trigger.evidence = await file('trigger.json', {
    mode: 'auto',
    manual_request: null,
    notification: {
      method: 'item/completed',
      params: {
        threadId: 'session',
        turnId: 'turn',
        item: { type: 'contextCompaction', id: 'compact' },
      },
    },
  });
  db = fixture();
  db.claim();
  journal = new ControllerRelayJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
  );
  proofs = new FileRelayProofs(f.root, f.root);
  state = createRelay(f.seed);
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});

it('persists the relay outside the source namespace and completes with exact raw proofs', async () => {
  expect(await journal.read()).toBeNull();
  state = await beginRelay(f.seed, journal, proofs);
  await expect(beginRelay(f.seed, journal, proofs)).rejects.toThrow('relay-already-exists');
  await send({ type: 'STOP', receipt: await file('stopped.json', stopProof()) });
  await send({
    type: 'RELEASE',
    generation: 1,
    snapshot: f.seed.snapshot,
    receipt: await file('released.json', releaseProof()),
  });
  const created = { ...f.successor, receipt: await file('identity.json', identityProof()) };
  state = await dispatchRelay('create', journal, proofs, { create: async () => created });
  await expect(
    dispatchRelay('again', journal, proofs, {
      create: async () => {
        throw Error('must not create');
      },
    }),
  ).rejects.toThrow('relay-create-already-reserved');
  const run = successorRun(f.seed, created);
  const loadRef = await file('load.json', {
    session: 'successor',
    refs: [...run.spec.procedures, ...run.spec.rules],
  });
  await send({
    type: 'LOAD',
    receipt: {
      run_id: run.spec.run_id,
      session_id: run.spec.session_id,
      procedures: run.spec.procedures,
      rules: run.spec.rules,
      observed_read: loadRef.locator,
    },
  });
  await send({
    type: 'ADOPT',
    generation: 2,
    snapshot: f.seed.snapshot,
    release: state.release!,
    receipt: await file('adopted.json', adoptionProof()),
  });
  await send({
    type: 'CONTINUE',
    session: 'successor',
    action: 'write marker',
    receipt: await file('continued.json', {
      kind: 'continuation',
      session: 'successor',
      action: 'write marker',
      adoption: state.adoption,
      observed: f.proof,
    }),
  });
  expect(state.phase).toBe('continued');
  const log = (await journal.read())!;
  expect(replayRelay(log)).toEqual(state);
  expect(await advanceRelay(log.events.at(-1)!, journal, proofs)).toEqual(state);
  await journal.save({ ...log, events: log.events.slice(0, -1) }, log);
  await expect(journal.save(log, log)).rejects.toThrow('relay-log-not-append-only');
  expect(
    await new ControllerRelayJournal(
      { execute: async (r) => db.store.execute(r) },
      grant.context,
      1,
    ).read(),
  ).toEqual(log);
});

it('keeps a single durable creation reservation on unknown outcome and rejects re-entry', async () => {
  await expect(
    advanceRelay({ type: 'STOP', receipt: f.proof, id: 'x', revision: 0 }, journal, proofs),
  ).rejects.toThrow('relay-not-found');
  await expect(
    dispatchRelay('x', journal, proofs, { create: async () => f.successor }),
  ).rejects.toThrow('relay-not-found');
  state = await beginRelay(f.seed, journal, proofs);
  await send({ type: 'STOP', receipt: await file('stopped.json', stopProof()) });
  await send({
    type: 'RELEASE',
    generation: 1,
    snapshot: f.seed.snapshot,
    receipt: await file('released.json', releaseProof()),
  });
  const create = vi.fn(async () => {
    throw Error('unknown transport outcome');
  });
  await expect(dispatchRelay('create', journal, proofs, { create })).rejects.toThrow(
    'unknown transport outcome',
  );
  await expect(dispatchRelay('create', journal, proofs, { create })).rejects.toThrow(
    'relay-create-already-reserved',
  );
  expect(create).toHaveBeenCalledTimes(1);
  state = replayRelay((await journal.read())!);
  const event: RelayEvent = {
    type: 'IDENTIFY',
    id: 'identity',
    revision: state.revision,
    session: f.successor,
  };
  await expect(
    advanceRelay(event, journal, {
      verify: async () => {},
      prepare: async () => {},
      confirm: async () => {
        await send({
          type: 'FAIL',
          kind: 'permission-denied',
          receipt: await file('denied.json', { kind: 'permission-denied' }),
        });
      },
    }),
  ).rejects.toThrow('relay-observation-stale');
  expect(replayRelay((await journal.read())!).denied).toBe(true);
});

it('requires primary snapshot and native trigger contents, including separate manual origin', async () => {
  await proofs.prepare(f.seed);
  for (const patch of [{ checkpoint: null }, { progress: null }]) {
    const ref = await file('bad-snapshot.json', {
      checkpoint: f.seed.checkpoint,
      progress: f.seed.progress,
      ...patch,
    });
    await expect(proofs.prepare({ ...f.seed, snapshot: ref })).rejects.toThrow(
      'relay-snapshot-content-mismatch',
    );
  }
  const trigger = JSON.parse(await readFile(resolve(f.root, 'trigger.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  for (const patch of [
    { notification: { method: 'thread/resumed' } },
    { mode: 'manual' },
    { manual_request: 'unexpected' },
  ]) {
    const ref = await file('bad-trigger.json', { ...trigger, ...patch });
    await expect(
      proofs.prepare({ ...f.seed, trigger: { ...f.seed.trigger, evidence: ref } }),
    ).rejects.toThrow();
  }
  const manual = await file('manual.json', {
    ...trigger,
    mode: 'manual',
    manual_request: 'actual native request',
  });
  await proofs.prepare({
    ...f.seed,
    trigger: { ...f.seed.trigger, mode: 'manual', evidence: manual },
  });
  const badManual = await file('manual-bad.json', {
    ...trigger,
    mode: 'manual',
    manual_request: null,
  });
  await expect(
    proofs.prepare({
      ...f.seed,
      trigger: { ...f.seed.trigger, mode: 'manual', evidence: badManual },
    }),
  ).rejects.toThrow('compaction-origin-unconfirmed');
  const absolute: InputRef = { locator: resolve(f.root, manual.locator), hash: manual.hash };
  await proofs.prepare({
    ...f.seed,
    trigger: { ...f.seed.trigger, mode: 'manual', evidence: absolute },
  });
});

it('refuses every incomplete stop/release/identity/adoption/continuation/assistance receipt', async () => {
  state.stopped = f.proof;
  state.release = f.proof;
  state.successor = f.successor;
  state.adoption = f.proof;
  state.loaded = { ...f.executor.loaded!, run_id: 'relay:successor', session_id: 'successor' };
  const confirm = async (action: RelayAction, proof: unknown) => {
    const receipt = await file('candidate.json', proof);
    const event =
      action.type === 'IDENTIFY'
        ? { ...action, session: { ...action.session, receipt } }
        : { ...action, receipt };
    return proofs.confirm(f.seed, state, { ...event, id: 'x', revision: 0 } as RelayEvent);
  };
  const cases: [RelayAction, Record<string, unknown>, Record<string, unknown>[]][] = [
    [
      { type: 'STOP', receipt: f.proof },
      stopProof(),
      [
        { kind: 'wrong' },
        { thread: 'foreign' },
        { active_turn: true },
        { remaining_terminals: 1 },
        { remaining_processes: 1 },
        { before_hash: 'different' },
        { before_hash: null, after_hash: null },
        { observation_ms: '250' },
        { observation_ms: 0 },
      ],
    ],
    [
      { type: 'RELEASE', generation: 1, snapshot: f.seed.snapshot, receipt: f.proof },
      releaseProof(),
      [
        { kind: 'wrong' },
        { predecessor: 'other' },
        { generation: 2 },
        { released: false },
        { snapshot: null },
        { stopped: null },
      ],
    ],
    [
      {
        type: 'ADOPT',
        generation: 2,
        snapshot: f.seed.snapshot,
        release: f.proof,
        receipt: f.proof,
      },
      adoptionProof(),
      [
        { kind: 'wrong' },
        { session: 'other' },
        { generation: 1 },
        { snapshot: null },
        { release: null },
        { checkpoint: null },
        { progress: null },
        { working_checkpoint: null },
      ],
    ],
    [
      { type: 'CONTINUE', session: 'successor', action: 'write marker', receipt: f.proof },
      {
        kind: 'continuation',
        session: 'successor',
        action: 'write marker',
        adoption: f.proof,
        observed: f.proof,
      },
      [{ kind: 'wrong' }, { session: 'other' }, { action: 'other' }, { adoption: null }],
    ],
    [
      { type: 'ASSIST', coordinator: 'o6', authority: f.proof, receipt: f.proof },
      {
        kind: 'dispatch',
        coordinator: 'o6',
        project_id: 'native',
        workspace: f.root,
        release: f.proof,
        attempts: 1,
      },
      [
        { kind: 'wrong' },
        { coordinator: 'other' },
        { project_id: 'other' },
        { workspace: 'other' },
        { release: null },
        { attempts: 2 },
      ],
    ],
    [
      { type: 'FAIL', kind: 'technical-unavailable', receipt: f.proof },
      { kind: 'technical-unavailable' },
      [{ kind: 'permission-denied' }],
    ],
  ];
  for (const [action, good, invalid] of cases) {
    await confirm(action, good);
    for (const patch of invalid)
      await expect(confirm(action, { ...good, ...patch })).rejects.toThrow();
  }
  const identity = identityProof();
  const mutations = [
    { thread: { ...identity.session.thread, id: 'other' } },
    { thread: { ...identity.session.thread, projectId: 'other' } },
    { cwd: 'other' },
    { thread: { ...identity.session.thread, forkedFromId: 'parent' } },
    { thread: { ...identity.session.thread, turns: null } },
    { thread: { ...identity.session.thread, turns: [1] } },
    { model: 'other' },
    { reasoningEffort: 'low' },
    { sandbox: { type: 'readOnly', networkAccess: false } },
    { sandbox: { type: 'workspaceWrite', networkAccess: true } },
  ];
  await confirm({ type: 'IDENTIFY', session: f.successor }, identity);
  for (const patch of mutations)
    await expect(
      confirm(
        { type: 'IDENTIFY', session: f.successor },
        { session: { ...identity.session, ...patch } },
      ),
    ).rejects.toThrow('native-successor-unconfirmed');
  const run = successorRun(f.seed, f.successor);
  for (const value of [
    { session: 'other', refs: [] },
    { session: 'successor', refs: null },
    { session: 'successor', refs: [] },
    { session: 'successor', refs: run.spec.procedures.map((p) => ({ ...p, hash: 'wrong' })) },
  ]) {
    const read = await file('load.json', value);
    await expect(
      proofs.confirm(f.seed, state, {
        type: 'LOAD',
        id: 'load',
        revision: 0,
        receipt: {
          run_id: run.spec.run_id,
          session_id: 'successor',
          procedures: run.spec.procedures,
          rules: run.spec.rules,
          observed_read: read.locator,
        },
      }),
    ).rejects.toThrow('relay-load-observation-mismatch');
  }
});

it('preserves siblings and refuses incompatible, competing or stale controller writes', async () => {
  db.mutate({ type: 'checkpoint', state: { sibling: 'keep' }, effects: [] }, 1);
  state = await beginRelay(f.seed, journal, proofs);
  expect(db.execute({ type: 'state' })).toMatchObject({
    ok: true,
    value: { checkpoint: { sibling: 'keep' } },
  });
  const log = (await journal.read())!;
  await send({ type: 'STOP', receipt: await file('stopped.json', stopProof()) });
  const event: RelayEvent = {
    type: 'FAIL',
    kind: 'technical-unavailable',
    receipt: f.proof,
    id: 'late',
    revision: 0,
  };
  await expect(journal.save(log, { ...log, events: [event] })).rejects.toThrow(
    'relay-revision-conflict',
  );
  const current = (await journal.read())!;
  const next: RelayLog = { ...current, events: [...current.events, { ...event, revision: 1 }] };
  const old = new ControllerRelayJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    99,
  );
  await expect(old.save(current, next)).rejects.toThrow('relay-store-write-rejected');
  const same = new ControllerRelayJournal(
    { execute: async (r) => db.store.execute(r) },
    { ...grant.context, run_id: 'source' },
    1,
  );
  await expect(same.save(null, log)).rejects.toThrow('relay-needs-external-controller');
  const unavailable = new ControllerRelayJournal(
    {
      execute: async () => ({
        ok: false,
        error: {
          code: 'unavailable',
          operation_id: null,
          observed_revision: null,
          retryable: true,
          recovery_locator: 'fixture',
        },
      }),
    },
    grant.context,
    1,
  );
  await expect(unavailable.read()).rejects.toThrow('relay-store-unavailable');
  const stored = db.execute({ type: 'state' });
  if (!stored.ok) throw Error('fixture unavailable');
  db.mutate(
    { type: 'checkpoint', state: { relay: { schema_version: 2 } }, effects: [] },
    (stored.value as { revision: number }).revision,
  );
  await expect(journal.read()).rejects.toThrow('unsupported-relay-log');
});
