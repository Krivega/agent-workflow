import { applyRelay, createRelay, replayRelay, successorRun } from '../core/relay.js';
import type { RelayAction, RelaySeed, RelayState } from '../core/relay.js';
import { relayFixture } from './relayFixtures.js';
import { compactionEvent } from '../adapters/codex/compactionEvents.js';
let f: Awaited<ReturnType<typeof relayFixture>>;
let state: RelayState;
const send = (action: RelayAction) =>
  (state = applyRelay(f.seed, state, {
    ...action,
    id: `e-${state.revision}`,
    revision: state.revision,
  }));
const identify = () => {
  send({ type: 'STOP', receipt: f.proof });
  send({ type: 'RELEASE', generation: 1, snapshot: f.seed.snapshot, receipt: f.proof });
  send({ type: 'RESERVE', operation: 'create-once' });
  send({ type: 'IDENTIFY', session: f.successor });
};
const load = () =>
  send({
    type: 'LOAD',
    receipt: { ...f.executor.loaded!, run_id: 'relay:successor', session_id: 'successor' },
  });
beforeEach(async () => {
  f = await relayFixture();
  state = createRelay(f.seed);
});
afterEach(async () => f.dispose());

it('preserves the entire checkpoint and separates release, one creation, load, adoption and continuation', () => {
  identify();
  load();
  send({
    type: 'ADOPT',
    generation: 2,
    snapshot: f.seed.snapshot,
    release: f.proof,
    receipt: f.proof,
  });
  send({ type: 'CONTINUE', session: 'successor', action: 'write marker', receipt: f.proof });
  expect(state.phase).toBe('continued');
  expect(f.seed.checkpoint).toMatchObject({
    workflow: { findings: ['original FAIL'], unknown: 'keep' },
  });
  expect(replayRelay({ schema_version: 1, seed: f.seed, events: state.events })).toEqual(state);
  expect(applyRelay(f.seed, state, state.events[0]!)).toBe(state);
  expect(() => applyRelay(f.seed, state, { ...state.events[0]!, revision: 10 })).toThrow(
    'relay-event-conflict',
  );
  expect(() => send({ type: 'FAIL', kind: 'technical-unavailable', receipt: f.proof })).toThrow(
    'relay-closed',
  );
});

it('supports cardless executor and coordinator without inventing a task card or changing the writer', () => {
  f.seed.predecessor.spec.identity = { assignment_id: 'cardless' };
  f.seed.predecessor.spec.product = false;
  f.seed.trigger.mode = 'manual';
  expect(createRelay(f.seed).phase).toBe('stopping');
  expect(successorRun(f.seed, f.successor).spec.identity).toEqual({ assignment_id: 'cardless' });
  f.seed.predecessor.type = 'orchestrator';
  f.seed.predecessor.spec.coordinator = true;
  f.seed.predecessor.spec.writer = 'integrator';
  f.seed.predecessor.spec.requested.permissions = ['read', 'coordinate'];
  f.seed.predecessor.spec.effective = { ...f.seed.predecessor.spec.requested };
  f.seed.predecessor.spec.route = { kind: 'nonproduct' };
  expect(() => createRelay(f.seed)).toThrow('coordinator-mapping-missing');
  f.seed.progress.mapping = { a: 'accepted', b: 'pending' };
  f.seed.progress.elapsed_ms = null;
  f.seed.progress.external_wait_ms = 100;
  state = createRelay(f.seed);
  f.successor.read_only = true;
  identify();
  load();
  expect(successorRun(f.seed, f.successor).spec.writer).toBe('integrator');
});

it('allows scoped O6 only for technical unavailability and never bypasses denial', () => {
  expect(() =>
    send({ type: 'ASSIST', coordinator: 'o6', authority: f.proof, receipt: f.proof }),
  ).toThrow('assistance-without-technical-failure');
  send({ type: 'FAIL', kind: 'technical-unavailable', receipt: f.proof });
  send({ type: 'ASSIST', coordinator: 'o6', authority: f.proof, receipt: f.proof });
  expect(state.phase).toBe('stopping');
  expect(state.assistance).toHaveLength(1);
  send({ type: 'FAIL', kind: 'permission-denied', receipt: f.proof });
  expect(() =>
    send({ type: 'ASSIST', coordinator: 'other', authority: f.proof, receipt: f.proof }),
  ).toThrow('relay-closed');
});

it('rejects incomplete triggers, lost state, unsupported versions and role relay', () => {
  const variants: [string, (seed: RelaySeed) => void][] = [
    ['unsupported-relay-seed', (s) => Object.assign(s, { schema_version: 2 })],
    [
      'predecessor-not-ready',
      (s) => {
        s.predecessor.status = 'cancelled';
      },
    ],
    [
      'role-cannot-relay',
      (s) => {
        s.predecessor.type = 'role';
      },
    ],
    [
      'compaction-trigger-unconfirmed',
      (s) => {
        s.trigger.thread = 'helper';
      },
    ],
    [
      'compaction-trigger-unconfirmed',
      (s) => {
        Object.assign(s.trigger, { mode: 'resume' });
      },
    ],
    [
      'predecessor-load-missing',
      (s) => {
        s.predecessor.loaded = null;
      },
    ],
    [
      'relay-procedure-missing',
      (s) => {
        s.predecessor.spec.procedures = s.predecessor.spec.procedures.filter(
          (p) => p.id !== 'relay',
        );
        s.predecessor.loaded!.procedures = s.predecessor.spec.procedures;
      },
    ],
    [
      'relay-checkpoint-missing',
      (s) => {
        s.checkpoint = null;
      },
    ],
    [
      'invalid-relay-estimate',
      (s) => {
        s.progress.estimate_ms = 0;
      },
    ],
    [
      'invalid-relay-estimate',
      (s) => {
        s.progress.estimate_ms = 3600001;
      },
    ],
    [
      'invalid-relay-estimate',
      (s) => {
        s.progress.estimate_ms = NaN;
      },
    ],
    [
      'invalid-relay-elapsed',
      (s) => {
        s.progress.elapsed_ms = -1;
      },
    ],
    [
      'invalid-relay-elapsed',
      (s) => {
        s.progress.elapsed_ms = NaN;
      },
    ],
  ];
  for (const [reason, change] of variants) {
    const seed = structuredClone(f.seed);
    change(seed);
    expect(() => createRelay(seed)).toThrow(reason);
  }
  expect(() =>
    replayRelay({ schema_version: 2, seed: f.seed, events: [] } as unknown as Parameters<
      typeof replayRelay
    >[0]),
  ).toThrow('unsupported-relay-log');
  expect(() =>
    applyRelay(f.seed, state, { type: 'STOP', receipt: f.proof, id: 'x', revision: 2 }),
  ).toThrow('stale-relay-event');
  expect(() => send({ type: 'RESERVE', operation: 'too early' })).toThrow('relay-order-violation');
});

it('rejects wrong release, duplicate create, false identity, unconfirmed load, adoption and action', () => {
  send({ type: 'STOP', receipt: f.proof });
  for (const release of [
    { generation: 2, snapshot: f.proof },
    { generation: 1, snapshot: { locator: 'wrong', hash: 'x' } },
  ])
    expect(() => send({ type: 'RELEASE', ...release, receipt: f.proof })).toThrow(
      'release-checkpoint-mismatch',
    );
  send({ type: 'RELEASE', generation: 1, snapshot: f.proof, receipt: f.proof });
  send({ type: 'RESERVE', operation: 'create-once' });
  expect(() => send({ type: 'RESERVE', operation: 'retry' })).toThrow('relay-order-violation');
  for (const patch of [
    { id: 'session' },
    { id: 'clientThreadId:pending' },
    { project_id: 'other' },
    { workspace: '/other' },
    { forked_from: 'parent' },
    { initial_turns: 1 },
  ])
    expect(() => send({ type: 'IDENTIFY', session: { ...f.successor, ...patch } })).toThrow(
      'successor-identity-unconfirmed',
    );
  for (const patch of [
    { model: 'other' },
    { effort: 'low' },
    { network: true },
    { read_only: true },
  ])
    expect(() => send({ type: 'IDENTIFY', session: { ...f.successor, ...patch } })).toThrow(
      'successor-profile-unconfirmed',
    );
  send({ type: 'IDENTIFY', session: f.successor });
  expect(() => send({ type: 'LOAD', receipt: f.executor.loaded! })).toThrow('wrong-load-identity');
  load();
  const adoption = {
    type: 'ADOPT' as const,
    generation: 2,
    snapshot: f.proof,
    release: f.proof,
    receipt: f.proof,
  };
  for (const patch of [
    { generation: 1 },
    { snapshot: { locator: 'other', hash: 'x' } },
    { release: { locator: 'other', hash: 'x' } },
  ])
    expect(() => send({ ...adoption, ...patch })).toThrow('adoption-checkpoint-mismatch');
  send(adoption);
  expect(() =>
    send({ type: 'CONTINUE', session: 'old', action: 'write marker', receipt: f.proof }),
  ).toThrow('continuation-unconfirmed');
  expect(() =>
    send({ type: 'CONTINUE', session: 'successor', action: 'nothing', receipt: f.proof }),
  ).toThrow('continuation-unconfirmed');
});

it('only accepts a completed native compaction for the selected predecessor', () => {
  const message = {
    method: 'item/completed',
    params: {
      threadId: 'session',
      turnId: 'turn',
      item: { id: 'compact', type: 'contextCompaction' },
    },
  };
  expect(compactionEvent(message, 'session', 'auto', f.proof)).toEqual(f.seed.trigger);
  expect(compactionEvent({ method: 'thread/resumed' }, 'session', 'auto', f.proof)).toBeNull();
  expect(compactionEvent(message, 'other', 'auto', f.proof)).toBeNull();
  expect(
    compactionEvent(
      { ...message, params: { ...message.params, item: { type: 'agentMessage' } } },
      'session',
      'auto',
      f.proof,
    ),
  ).toBeNull();
  expect(() => compactionEvent(message, 'session', 'resume' as 'auto', f.proof)).toThrow(
    'unknown-compaction-origin',
  );
});

it('requires the relay procedure in scoped predecessor and successor native receipts', () => {
  f.seed.predecessor.spec.procedure_loading = 'by-action';
  const full = f.seed.predecessor.loaded!;
  const base = full.procedures.filter((p) => ['bootstrap', 'task', 'evidence'].includes(p.id));
  f.seed.predecessor.loaded = { ...full, procedures: base };
  expect(() => createRelay(f.seed)).toThrow('procedure-not-loaded:relay');
  f.seed.predecessor.loaded = {
    ...full,
    procedures: [...base, full.procedures.find((p) => p.id === 'relay')!],
  };
  state = createRelay(f.seed);
  identify();
  expect(() =>
    send({
      type: 'LOAD',
      receipt: { ...full, run_id: 'relay:successor', session_id: 'successor', procedures: base },
    }),
  ).toThrow('procedure-not-loaded:relay');
  load();
  expect(state.phase).toBe('loaded');
});
it('rejects a successor from an unknown persisted predecessor format before changing generation', () => {
  for (const patch of [
    { schema_version: 3 },
    { schema_version: 2 },
    { schema_version: 2, format: 'unknown' },
  ]) {
    const seed = structuredClone(f.seed);
    Object.assign(seed.predecessor, patch);
    expect(() => successorRun(seed, f.successor)).toThrow('unsupported-run-version');
    expect(seed.predecessor.generation).toBe(1);
  }
});
