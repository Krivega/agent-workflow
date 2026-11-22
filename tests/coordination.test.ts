import {
  applyCoordination,
  createCoordination,
  observationWait,
  replayCoordination,
  scopesOverlap,
} from '../core/coordination.js';
import type {
  Coordination,
  CoordinationAction,
  CoordinationSeed,
  WorkScope,
} from '../core/coordination.js';
import { coordinationFixture } from './coordinationFixtures.js';

let f: Awaited<ReturnType<typeof coordinationFixture>>;
let state: Coordination;
const send = (action: CoordinationAction) => {
  state = applyCoordination(f.seed, state, {
    ...action,
    id: `e-${state.revision}`,
    revision: state.revision,
    generation: 1,
  });
  return state;
};
const bind = (id: string) => {
  send({ type: 'RESERVE', child: id, operation: `op-${id}` });
  send({ type: 'BIND', child: id, session: `session-${id}`, receipt: f.proof });
};
const finish = (id: string) => {
  send({
    type: 'OBSERVE',
    child: id,
    session: `session-${id}`,
    cursor: 1,
    outcome: 'completed',
    result: f.result(id),
    receipt: f.proof,
  });
  send({ type: 'ACCEPT', child: id, current: f.target.inputs });
};
const integration = (): CoordinationAction => ({
  type: 'INTEGRATE',
  executor: 'integrator',
  inputs: f.target.inputs,
  boundaries: f.check,
  validation: f.check,
  child_inputs: { a: f.target.inputs, b: f.target.inputs },
});
beforeEach(async () => {
  f = await coordinationFixture();
  state = createCoordination(f.seed);
});
afterEach(async () => f.dispose());

it('accepts two exact results, deduplicates delivered events and preserves links in one integration', () => {
  bind('a');
  bind('b');
  send({
    type: 'OBSERVE',
    child: 'a',
    session: 'session-a',
    cursor: 0,
    outcome: 'running',
    result: null,
    receipt: f.proof,
  });
  finish('a');
  finish('b');
  send({
    type: 'OBSERVE',
    child: 'a',
    session: 'session-a',
    cursor: 2,
    outcome: 'completed',
    result: f.result('a'),
    receipt: f.proof,
  });
  expect(state.children[0]!.status).toBe('accepted');
  send({
    type: 'OBSERVE',
    child: 'a',
    session: 'session-a',
    cursor: 1,
    outcome: 'failed',
    result: null,
    receipt: f.proof,
  });
  expect(state.children[0]!.status).toBe('accepted');
  const prior = state.history.at(-1)!;
  expect(applyCoordination(f.seed, state, prior)).toBe(state);
  expect(() => applyCoordination(f.seed, state, { ...prior, generation: 2 })).toThrow(
    'coordination-event-conflict',
  );
  send(integration());
  expect(state.status).toBe('done');
  expect(replayCoordination({ schema_version: 1, seed: f.seed, events: state.history })).toEqual(
    state,
  );
  expect(() => send({ type: 'CANCEL', reason: 'late' })).toThrow('coordination-closed');
});

it('retains unknown dispatch and late creation during cancellation until own stop confirmation', () => {
  send({ type: 'RESERVE', child: 'a', operation: 'op-a' });
  send({ type: 'CANCEL', reason: 'parent cancelled' });
  expect(state.status).toBe('cancelling');
  expect(state.children[1]!.status).toBe('stopped');
  expect(() => send({ type: 'RESERVE', child: 'b', operation: 'op-b' })).toThrow(
    'dispatch-not-ready',
  );
  send({ type: 'BIND', child: 'a', session: 'session-a', receipt: f.proof });
  send({
    type: 'OBSERVE',
    child: 'a',
    session: 'session-a',
    cursor: 2,
    outcome: 'completed',
    result: f.result('a'),
    receipt: f.proof,
  });
  expect(state.children[0]!.result).toBeNull();
  send({ type: 'STOPPED', child: 'a', receipt: f.proof });
  expect(state.status).toBe('cancelled');
  expect(state.children[0]!.stopped).toEqual(f.proof);
});

it('records failure and hang, pauses without transferring ownership, and keeps completed evidence on cancellation', () => {
  bind('a');
  bind('b');
  for (const [cursor, outcome] of [
    [0, 'failed'],
    [1, 'stalled'],
  ] as const) {
    send({
      type: 'OBSERVE',
      child: 'a',
      session: 'session-a',
      cursor,
      outcome,
      result: null,
      receipt: f.proof,
    });
    expect(state.children[0]!.status).toBe(outcome);
  }
  send({ type: 'UNAVAILABLE', receipt: f.proof });
  expect(() => send({ type: 'UNAVAILABLE', receipt: f.proof })).toThrow('coordinator-not-active');
  expect(() => send({ type: 'RESUME', owner: 'foreign', receipt: f.proof })).toThrow(
    'coordinator-owner-unconfirmed',
  );
  expect(() =>
    send({
      type: 'OBSERVE',
      child: 'a',
      session: 'session-a',
      cursor: 2,
      outcome: 'running',
      result: null,
      receipt: f.proof,
    }),
  ).toThrow('coordinator-unavailable');
  send({ type: 'RESUME', owner: 'run', receipt: f.proof });
  finish('b');
  send({ type: 'UNAVAILABLE', receipt: f.proof });
  send({ type: 'CANCEL', reason: 'stop while unavailable' });
  expect(state.children[1]!.result).toEqual(f.result('b'));
  send({ type: 'STOPPED', child: 'a', receipt: f.proof });
  expect(state.status).toBe('cancelling');
  send({ type: 'CANCEL', reason: 'repeat cancellation while waiting for b' });
  expect(state.children[0]!.status).toBe('stopped');
  expect(state.children[0]!.stopped).toEqual(f.proof);
  send({ type: 'STOPPED', child: 'b', receipt: f.proof });
  expect(state.status).toBe('cancelled');
});

it('requires dependency acceptance and rejects cycles, missing owners and overlapping writers', () => {
  f.seed.children[1]!.dependencies = ['a'];
  state = createCoordination(f.seed);
  expect(() => send({ type: 'RESERVE', child: 'b', operation: 'b' })).toThrow(
    'dependency-not-accepted',
  );
  bind('a');
  finish('a');
  bind('b');
  const variants: [string, (seed: CoordinationSeed) => void][] = [
    [
      'unsupported-coordination-seed',
      (s) => {
        Object.assign(s, { schema_version: 2 });
      },
    ],
    [
      'coordination-load-missing',
      (s) => {
        s.run.loaded = null;
      },
    ],
    [
      'coordination-procedure-missing',
      (s) => {
        s.run.spec.procedures = s.run.spec.procedures.filter((p) => p.id !== 'coordination');
        s.run.loaded!.procedures = s.run.spec.procedures;
      },
    ],
    [
      'invalid-poll-interval',
      (s) => {
        s.poll_interval_ms = -1;
      },
    ],
    [
      'coordinator-cannot-integrate',
      (s) => {
        s.integration.executor = 'run';
      },
    ],
    [
      'missing-text',
      (s) => {
        s.children[0]!.writer = '';
      },
    ],
    [
      'missing-text',
      (s) => {
        s.children[0]!.authority.hash = '';
      },
    ],
    [
      'duplicate-or-missing-child',
      (s) => {
        s.children = [];
      },
    ],
    [
      'duplicate-or-missing-child',
      (s) => {
        s.children.push(s.children[0]!);
      },
    ],
    [
      'dependency-cycle',
      (s) => {
        s.children[0]!.dependencies = ['b'];
      },
    ],
    [
      'dependency-missing',
      (s) => {
        s.children[0]!.dependencies = ['missing'];
      },
    ],
    [
      'shared-contract-owned-by-integrator',
      (s) => {
        s.children[0]!.scope.paths = ['common.txt'];
      },
    ],
    [
      'competing-scope-writers',
      (s) => {
        s.children[1]!.scope = s.children[0]!.scope;
      },
    ],
    [
      'noncanonical-workspace',
      (s) => {
        s.integration.scope.workspace = 'relative';
      },
    ],
    [
      'noncanonical-workspace',
      (s) => {
        s.integration.scope.workspace = '/trailing/';
      },
    ],
    [
      'noncanonical-workspace',
      (s) => {
        s.integration.scope.workspace = '/a/../b';
      },
    ],
    [
      'incomplete-work-scope',
      (s) => {
        s.integration.scope.paths = [];
      },
    ],
    [
      'incomplete-work-scope',
      (s) => {
        s.integration.scope.paths = ['x', 'x'];
      },
    ],
    [
      'unsafe-locator',
      (s) => {
        s.integration.scope.paths = ['../x'];
      },
    ],
  ];
  for (const [error, change] of variants) {
    const seed = structuredClone(f.seed);
    change(seed);
    expect(() => createCoordination(seed), error).toThrow(error);
  }
  const ro = structuredClone(f.seed);
  ro.children[0]!.read_only = true;
  ro.children[0]!.scope = ro.integration.scope;
  ro.children[1]!.scope = ro.children[0]!.scope;
  ro.children[1]!.read_only = true;
  expect(createCoordination(ro).status).toBe('active');
  ro.children[1]!.read_only = false;
  ro.children[1]!.scope = { workspace: '/different', paths: ['common.txt'] };
  expect(createCoordination(ro).status).toBe('active');
  expect(
    scopesOverlap({ workspace: '/a', paths: ['x'] }, { workspace: '/a', paths: ['x/y'] }),
  ).toBe(true);
  expect(
    scopesOverlap({ workspace: '/a', paths: ['x/y'] }, { workspace: '/a', paths: ['x'] }),
  ).toBe(true);
  expect(scopesOverlap({ workspace: '/a', paths: ['x'] }, { workspace: '/b', paths: ['x'] })).toBe(
    false,
  );
});

it('rejects intersecting absolute paths across nested workspace roots in either order', () => {
  const outer = { workspace: f.root, paths: ['nested/shared.ts'] };
  const inner = { workspace: `${f.root}/nested`, paths: ['shared.ts'] };
  for (const [a, b] of [
    [outer, inner],
    [inner, outer],
    [{ ...outer, paths: ['nested'] }, inner],
    [inner, { ...outer, paths: ['nested'] }],
  ] satisfies [WorkScope, WorkScope][]) {
    expect(scopesOverlap(a, b)).toBe(true);
    const seed = structuredClone(f.seed);
    seed.children[0]!.scope = a;
    seed.children[1]!.scope = b;
    expect(() => createCoordination(seed)).toThrow('competing-scope-writers');
    seed.children[1]!.scope = { workspace: f.root, paths: ['separate.ts'] };
    seed.integration.scope = b;
    expect(() => createCoordination(seed)).toThrow('shared-contract-owned-by-integrator');
    seed.children[0]!.read_only = true;
    expect(createCoordination(seed).status).toBe('active');
  }
  expect(scopesOverlap(outer, { ...inner, paths: ['shared.tsx'] })).toBe(false);
  expect(scopesOverlap(outer, { workspace: `${f.root}/nested-other`, paths: ['shared.ts'] })).toBe(
    false,
  );
});

it.each(['completed', 'accepted'] as const)(
  'requires a stop receipt after cancellation of a %s child and retains its result',
  (phase) => {
    bind('a');
    send({
      type: 'OBSERVE',
      child: 'a',
      session: 'session-a',
      cursor: 0,
      outcome: 'completed',
      result: f.result('a'),
      receipt: f.proof,
    });
    if (phase === 'accepted') send({ type: 'ACCEPT', child: 'a', current: f.target.inputs });
    send({ type: 'CANCEL', reason: 'background writer may remain after the answer' });
    expect(state.status).toBe('cancelling');
    expect(state.children[0]).toMatchObject({
      status: 'stopping',
      result: f.result('a'),
      stopped: null,
    });
    expect(state.children[1]!.status).toBe('stopped');
    expect(() => send({ type: 'ACCEPT', child: 'a', current: f.target.inputs })).toThrow(
      'child-not-completed',
    );
    const log = { schema_version: 1 as const, seed: f.seed, events: state.history };
    expect(replayCoordination(log)).toEqual(state);
    send({ type: 'STOPPED', child: 'a', receipt: f.proof });
    expect(state.status).toBe('cancelled');
    expect(state.children[0]!.stopped).toEqual(f.proof);
    expect(state.children[0]!.result).toEqual(f.result('a'));
  },
);

it('rejects stale, conflicting, incomplete and foreign observations without accepting anything', () => {
  expect(() =>
    applyCoordination(f.seed, state, {
      type: 'CANCEL',
      reason: 'x',
      id: 'x',
      revision: 1,
      generation: 1,
    }),
  ).toThrow('stale-coordination-event');
  expect(() =>
    applyCoordination(f.seed, state, {
      type: 'CANCEL',
      reason: 'x',
      id: 'x',
      revision: 0,
      generation: 2,
    }),
  ).toThrow('stale-coordination-event');
  expect(() => send({ type: 'RESERVE', child: 'missing', operation: 'x' })).toThrow(
    'child-missing',
  );
  expect(() => send({ type: 'BIND', child: 'a', session: 's', receipt: f.proof })).toThrow(
    'dispatch-already-bound',
  );
  expect(() => send({ type: 'STOPPED', child: 'a', receipt: f.proof })).toThrow(
    'stop-not-requested',
  );
  expect(() => send({ type: 'ACCEPT', child: 'a', current: f.target.inputs })).toThrow(
    'child-not-completed',
  );
  expect(() => send(integration())).toThrow('children-not-accepted');
  bind('a');
  expect(() => send({ type: 'BIND', child: 'a', session: 's', receipt: f.proof })).toThrow(
    'dispatch-already-bound',
  );
  expect(() => send({ type: 'RESERVE', child: 'b', operation: 'op-a' })).toThrow(
    'duplicate-dispatch-operation',
  );
  send({ type: 'RESERVE', child: 'b', operation: 'op-b' });
  expect(() => send({ type: 'BIND', child: 'b', session: 'session-a', receipt: f.proof })).toThrow(
    'child-session-reused',
  );
  send({ type: 'BIND', child: 'b', session: 'session-b', receipt: f.proof });
  const observation = {
    type: 'OBSERVE' as const,
    child: 'a',
    session: 'session-a',
    cursor: 0,
    outcome: 'completed' as const,
    result: f.result('a'),
    receipt: f.proof,
  };
  expect(() => send({ ...observation, session: 'foreign' })).toThrow('wrong-child-session');
  expect(() => send({ ...observation, cursor: -1 })).toThrow('invalid-observation-cursor');
  expect(() => send({ ...observation, result: null })).toThrow('completion-result-missing');
  expect(() => send({ ...observation, result: { ...f.result('a'), criterion: 'wrong' } })).toThrow(
    'wrong-child-result',
  );
  expect(() =>
    send({ ...observation, result: { ...f.result('a'), scope: f.result('b').scope } }),
  ).toThrow('wrong-child-result');
  expect(() =>
    send({
      ...observation,
      result: { ...f.result('a'), inputs: { ...f.target.inputs, complete: false } },
    }),
  ).toThrow('incomplete-child-inputs');
  expect(() =>
    send({
      ...observation,
      result: { ...f.result('a'), acceptance: { ...f.check, verdict: 'FAIL' } },
    }),
  ).toThrow('child-acceptance-missing');
  expect(() =>
    send({
      ...observation,
      result: {
        ...f.result('a'),
        acceptance: { ...f.check, inputs: { ...f.target.inputs, complete: false } },
      },
    }),
  ).toThrow('child-acceptance-missing');
  send(observation);
  send(observation);
  expect(() => send({ ...observation, outcome: 'failed' })).toThrow('observation-cursor-conflict');
  expect(() => send({ ...observation, result: { ...f.result('a'), criterion: 'other' } })).toThrow(
    'observation-cursor-conflict',
  );
  expect(() => send({ ...observation, cursor: 1, outcome: 'running' })).toThrow(
    'completion-conflict',
  );
  expect(() =>
    send({
      ...observation,
      cursor: 1,
      result: { ...f.result('a'), evidence: { locator: 'different', hash: 'x' } },
    }),
  ).toThrow('completion-conflict');
  expect(() =>
    send({ type: 'ACCEPT', child: 'a', current: { ...f.target.inputs, complete: false } }),
  ).toThrow('child-result-stale');
  send({ type: 'ACCEPT', child: 'a', current: f.target.inputs });
  finish('b');
  const done = integration() as Extract<CoordinationAction, { type: 'INTEGRATE' }>;
  for (const action of [
    { ...done, executor: 'wrong' },
    { ...done, inputs: { ...f.target.inputs, complete: false } },
    { ...done, child_inputs: {} },
    { ...done, child_inputs: { ...done.child_inputs, a: { ...f.target.inputs, complete: false } } },
    { ...done, boundaries: { ...f.check, verdict: 'NOT RUN' as const } },
    { ...done, validation: { ...f.check, id: 'smoke' } },
    { ...done, validation: { ...f.check, verdict: 'FAIL' as const } },
    { ...done, validation: { ...f.check, inputs: { ...f.target.inputs, complete: false } } },
  ])
    expect(() => send(action)).toThrow();
});

it('caps each fallback wait, handles immediate events and validates time inputs', () => {
  expect(observationWait(210_000, 0, false)).toBe(60_000);
  expect(observationWait(210_000, 200_000, false)).toBe(10_000);
  expect(observationWait(210_000, 300_000, false)).toBe(0);
  expect(observationWait(210_000, 0, true)).toBe(0);
  for (const [interval, elapsed] of [
    [NaN, 0],
    [0, 0],
    [1, NaN],
    [1, -1],
  ])
    expect(() => observationWait(interval!, elapsed!, false)).toThrow('invalid-observation-time');
  expect(() =>
    replayCoordination({ schema_version: 99, seed: f.seed, events: [] } as unknown as Parameters<
      typeof replayCoordination
    >[0]),
  ).toThrow('unsupported-coordination-log');
});

it('requires a scoped coordinator to read coordination before dispatch can begin', () => {
  f.seed.run.spec.procedure_loading = 'by-action';
  const full = f.seed.run.loaded!;
  f.seed.run.loaded = {
    ...full,
    procedures: full.procedures.filter((p) => ['bootstrap', 'task', 'evidence'].includes(p.id)),
  };
  expect(() => createCoordination(f.seed)).toThrow('procedure-not-loaded:coordination');
  f.seed.run.loaded.procedures.push(full.procedures.find((p) => p.id === 'coordination')!);
  expect(createCoordination(f.seed).status).toBe('active');
});
