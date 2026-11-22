import { adoptedCheckpoint, readySuccessor } from '../core/relayCheckpoint.js';
import { createRelay } from '../core/relay.js';
import { createExecution, applyExecution } from '../core/execution.js';
import { coordinationSeed, replayCoordination } from '../core/coordination.js';
import type { CoordinationLog } from '../core/coordination.js';
import type { Json } from '../core/evidence.js';
import { relayFixture } from './relayFixtures.js';
import { coordinationFixture } from './coordinationFixtures.js';
let f: Awaited<ReturnType<typeof relayFixture>>;
beforeEach(async () => {
  f = await relayFixture();
});
afterEach(async () => f.dispose());
const ready = () =>
  readySuccessor(f.seed, {
    ...createRelay(f.seed),
    successor: f.successor,
    loaded: { ...f.executor.loaded!, run_id: 'relay:successor', session_id: 'successor' },
  });

it('rebinds execution generation without losing prior history, findings or unknown fields', () => {
  const execution = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'required', kind: 'check', applicable: true, reason: 'fixture' }],
    false,
    'substantial',
  );
  f.seed.checkpoint = {
    local_run: f.seed.predecessor as unknown as Json,
    workflow: {
      schema_version: 1,
      revision: 2,
      execution: execution as unknown as Json,
      readings: {},
      unknown: 'keep',
    },
    extra: ['keep'],
  };
  f.seed.predecessor.elapsed_ms = 100;
  f.seed.predecessor.external_wait_ms = 20;
  const run = ready();
  const adopted = adoptedCheckpoint(f.seed, run) as unknown as {
    workflow: { execution: typeof execution; unknown: string };
    extra: string[];
  };
  expect(run).toMatchObject({
    generation: 2,
    status: 'ready',
    elapsed_ms: 100,
    external_wait_ms: 20,
  });
  expect(adopted.workflow.execution.generation).toBe(2);
  expect(adopted.workflow.unknown).toBe('keep');
  expect(adopted.extra).toEqual(['keep']);
  const next = applyExecution(adopted.workflow.execution, {
    type: 'PLAN',
    id: 'plan',
    generation: 2,
    expected_revision: 0,
    council: f.council('planning'),
  });
  expect(next.status).toBe('implementing');
  expect(() =>
    applyExecution(adopted.workflow.execution, {
      type: 'PLAN',
      id: 'late',
      generation: 1,
      expected_revision: 0,
      council: f.council('planning'),
    }),
  ).toThrow();
  expect(execution.generation).toBe(1);
});

it('continues a coordinator after adoption while retaining its original event log', async () => {
  const c = await coordinationFixture();
  try {
    f.seed.predecessor = c.seed.run;
    f.seed.progress.mapping = {};
    f.successor = {
      ...f.successor,
      read_only: true,
      model: c.seed.run.spec.requested.model,
      effort: c.seed.run.spec.requested.effort,
    };
    const source: CoordinationLog = {
      schema_version: 1,
      seed: c.seed,
      events: [
        {
          type: 'RESERVE',
          child: 'a',
          operation: 'original',
          id: 'first',
          revision: 0,
          generation: 1,
        },
      ],
    };
    f.seed.checkpoint = {
      local_run: c.seed.run as unknown as Json,
      coordination: source as unknown as Json,
    };
    const state = {
      ...createRelay(f.seed),
      successor: f.successor,
      loaded: { ...c.seed.run.loaded!, run_id: 'relay:successor', session_id: 'successor' },
    };
    const run = readySuccessor(f.seed, state);
    const adopted = adoptedCheckpoint(f.seed, run) as unknown as { coordination: CoordinationLog };
    expect(adopted.coordination.schema_version).toBe(2);
    expect(coordinationSeed(adopted.coordination).run.generation).toBe(2);
    const next: CoordinationLog = {
      ...adopted.coordination,
      events: [
        {
          type: 'RESERVE',
          child: 'b',
          operation: 'next',
          id: 'second',
          revision: 1,
          generation: 2,
        },
      ],
    };
    expect(replayCoordination(next).children.map((child) => child.status)).toEqual([
      'reserved',
      'reserved',
    ]);
    expect(source.events).toHaveLength(1);
    const late: CoordinationLog = { ...next, events: [{ ...next.events[0]!, generation: 1 }] };
    expect(() => replayCoordination(late)).toThrow('stale-coordination-event');
    for (const patch of [
      { generation: 1 },
      { spec: { ...run.spec, run_id: c.seed.run.spec.run_id } },
      { spec: { ...run.spec, session_id: c.seed.run.spec.session_id } },
      { spec: { ...run.spec, project_id: 'other' } },
      { spec: { ...run.spec, workspace: '/other' } },
      { spec: { ...run.spec, identity: { assignment_id: 'other' } } },
    ]) {
      expect(() =>
        coordinationSeed({ schema_version: 2, source, run: { ...run, ...patch }, events: [] }),
      ).toThrow('coordination-adoption-mismatch');
    }
  } finally {
    await c.dispose();
  }
});

it('refuses incomplete readiness, stale source, unsupported state and mismatched adoption', () => {
  const state = createRelay(f.seed);
  expect(() => readySuccessor(f.seed, state)).toThrow('successor-load-required');
  expect(() => readySuccessor(f.seed, { ...state, successor: f.successor })).toThrow(
    'successor-load-required',
  );
  const run = ready();
  expect(() => adoptedCheckpoint({ ...f.seed, checkpoint: {} }, run)).toThrow(
    'source-local-checkpoint-mismatch',
  );
  for (const patch of [
    { status: 'inbox' as const },
    { generation: 1 },
    { spec: { ...run.spec, run_id: 'other' } },
  ])
    expect(() => adoptedCheckpoint(f.seed, { ...run, ...patch })).toThrow(
      'successor-not-adoptable',
    );
  for (const workflow of [
    { schema_version: 9 },
    { schema_version: 1, execution: { schema_version: 1, generation: 1 } },
    { schema_version: 1, execution: { schema_version: 2, generation: 2 } },
  ]) {
    expect(() =>
      adoptedCheckpoint(
        { ...f.seed, checkpoint: { local_run: f.seed.predecessor as unknown as Json, workflow } },
        run,
      ),
    ).toThrow();
  }
  expect(
    adoptedCheckpoint(
      { ...f.seed, checkpoint: { local_run: f.seed.predecessor as unknown as Json } },
      run,
    ),
  ).toMatchObject({ local_run: { generation: 2 } });
});

it.each(['local-planning', 'coder'] as const)(
  'preserves version two %s in a successor and refuses unfinished coder state',
  (format) => {
    f.seed.predecessor = {
      ...f.seed.predecessor,
      schema_version: 2,
      format,
      ...(format === 'coder' ? { coder_locks: [] } : {}),
    };
    const successor = ready();
    expect(successor).toMatchObject({ schema_version: 2, format, generation: 2 });
    expect(successor.coder_locks).toEqual(format === 'coder' ? [] : undefined);
    const settled = {
      schema_version: 2,
      execution: null,
      coders: {
        first: { status: 'integrated' },
        second: { status: 'cancelled' },
        third: { status: 'not-started' },
      },
    };
    f.seed.checkpoint = {
      local_run: f.seed.predecessor as unknown as Json,
      workflow: settled,
    };
    expect(adoptedCheckpoint(f.seed, successor)).toMatchObject({ workflow: settled });
    for (const status of ['creating', 'running', 'released', 'integrating']) {
      f.seed.checkpoint = {
        local_run: f.seed.predecessor as unknown as Json,
        workflow: { ...settled, coders: { first: { status } } },
      };
      expect(() => adoptedCheckpoint(f.seed, successor)).toThrow('coder-writers-pending');
    }
  },
);
