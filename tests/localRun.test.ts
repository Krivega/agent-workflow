import {
  applyLocalEvent,
  assertRunAction,
  continueRole,
  executorType,
  requiredProcedures,
  selectedProcedures,
  startLocalRun,
} from '../core/localRun.js';
import type { LoadReceipt, LocalRun } from '../core/localRun.js';
import { event, loadedRun, localFixture } from './localFixtures.js';

let f: Awaited<ReturnType<typeof localFixture>>;
beforeEach(async () => {
  f = await localFixture();
});
afterEach(async () => {
  await f.dispose();
});
const ready = (run: LocalRun) => applyLocalEvent(run, event(run, { type: 'READY' }));

it('requires a read receipt before readiness and preserves failures, timing and cancellation across late replies', () => {
  let run = startLocalRun(f.spec, 4);
  expect(() => ready(run)).toThrow('load-unconfirmed');
  run = loadedRun(run);
  run = applyLocalEvent(
    run,
    event(run, {
      type: 'RESULT',
      session_id: 'session',
      source: f.spec.sources[0]!,
      outcome: 'FAIL',
    }),
  );
  run.elapsed_ms = 101;
  run.external_wait_ms = 23;
  run = applyLocalEvent(run, event(run, { type: 'WAIT' }));
  run = ready(run);
  assertRunAction(run, 'update-card');
  expect(() => assertRunAction(run, 'coordinate')).toThrow('action-forbidden');
  run = applyLocalEvent(run, event(run, { type: 'WAIT' }));
  const cancel = event(run, {
    type: 'CANCEL',
    reason: 'User cancelled',
    unfinished: ['criterion'],
    stopped_receipt: 'no child processes in fixture',
  });
  const cancelled = applyLocalEvent(run, cancel);
  expect(cancelled).toMatchObject({
    status: 'cancelled',
    generation: 5,
    elapsed_ms: 101,
    external_wait_ms: 23,
    results: [{ outcome: 'FAIL' }],
  });
  expect(applyLocalEvent(cancelled, cancel)).toBe(cancelled);
  expect(() => applyLocalEvent(cancelled, { ...cancel, reason: 'changed' })).toThrow(
    'event-conflict',
  );
  expect(() => ready(cancelled)).toThrow('run-cancelled');
});

it('checks profiles, roles and parent history without changing the parent type', () => {
  expect(executorType(f.spec)).toBe('executor');
  expect(executorType({ parent_run_id: null, coordinator: true })).toBe('orchestrator');
  const spec = {
    ...f.spec,
    parent_run_id: 'parent',
    coordinator: true,
    role: 'raw-data-reader' as const,
    requested: { ...f.spec.requested, permissions: ['read' as const] },
    effective: { ...f.spec.requested, permissions: ['read' as const] },
  };
  const run = ready(loadedRun(startLocalRun(spec, 1)));
  expect(run.type).toBe('role');
  expect(requiredProcedures(run.type)).toEqual(['bootstrap', 'data-roles', 'evidence']);
  continueRole(run, 'session', spec.sources, false);
  expect(() => continueRole(run, 'new-session', spec.sources, true)).toThrow('role-identity-lost');
  expect(() =>
    continueRole(run, 'session', [{ locator: 'source.txt', hash: 'new' }], false),
  ).toThrow('source-revision-changed');
  continueRole(run, 'session', [{ locator: 'source.txt', hash: 'new' }], true);
  expect(() => startLocalRun({ ...spec, fork_turns: 'all' }, 1)).toThrow(
    'parent-history-forbidden',
  );
  expect(() => startLocalRun({ ...spec, requested: f.spec.requested }, 1)).toThrow(
    'action-forbidden',
  );
  expect(() => startLocalRun({ ...f.spec, role: 'explorer' }, 1)).toThrow('wrong-role-profile');
  expect(() =>
    startLocalRun(
      { ...spec, role: 'evidence-explorer', identity: { assignment_id: 'a' }, product: false },
      1,
    ),
  ).toThrow('evidence-role-needs-task');
});

it('keeps mechanical and nonproduct paths distinct from substantial planning', () => {
  const run = startLocalRun(f.spec, 1);
  expect(ready(loadedRun(run)).status).toBe('ready');
  expect(
    ready(
      loadedRun({
        ...run,
        spec: {
          ...f.spec,
          route: {
            kind: 'mechanical',
            accepted_material: f.spec.assignment,
            semantic_delta: false,
          },
        },
      }),
    ).status,
  ).toBe('ready');
  expect(
    ready(
      loadedRun(
        startLocalRun(
          {
            ...f.spec,
            product: false,
            identity: { assignment_id: 'assignment' },
            route: { kind: 'nonproduct' },
          },
          1,
        ),
      ),
    ).status,
  ).toBe('ready');
  for (const [route, error] of [
    [{ kind: 'substantial', accepted_plan: null }, 'planning-required'],
    [
      { kind: 'mechanical', accepted_material: f.spec.assignment, semantic_delta: true },
      'semantic-delta-needs-planning',
    ],
    [{ kind: 'nonproduct' }, 'product-needs-planning'],
  ] as const)
    expect(() => ready(loadedRun({ ...run, spec: { ...run.spec, route } }))).toThrow(error);
});

it('rejects incomplete briefs, stale events and unconfirmed effective settings', () => {
  for (const spec of [
    { ...f.spec, scope: [] },
    { ...f.spec, criteria: [] },
    { ...f.spec, sources: [] },
  ])
    expect(() => startLocalRun(spec, 1)).toThrow('incomplete-brief');
  expect(() => startLocalRun(f.spec, 0)).toThrow('invalid-generation');
  expect(() => startLocalRun({ ...f.spec, identity: { assignment_id: 'a' } }, 1)).toThrow(
    'product-needs-card',
  );
  let run = loadedRun(startLocalRun(f.spec, 1));
  for (const effective of [
    null,
    { ...f.spec.requested, model: 'other' },
    { ...f.spec.requested, effort: 'other' },
    { ...f.spec.requested, permissions: [] },
    { ...f.spec.requested, permissions: ['read' as const, 'implement' as const] },
  ])
    expect(() => ready({ ...run, spec: { ...f.spec, effective } })).toThrow('profile-unconfirmed');
  expect(() => applyLocalEvent(run, { ...event(run, { type: 'WAIT' }), generation: 9 })).toThrow(
    'stale-event',
  );
  expect(() =>
    applyLocalEvent(run, { ...event(run, { type: 'WAIT' }), expected_revision: 9 }),
  ).toThrow('stale-event');
  expect(() =>
    applyLocalEvent(
      run,
      event(run, {
        type: 'RESULT',
        session_id: 'wrong',
        source: f.spec.assignment,
        outcome: 'PASS',
      }),
    ),
  ).toThrow('wrong-result-identity');
  expect(() =>
    applyLocalEvent(
      run,
      event(run, { type: 'CANCEL', reason: 'x', unfinished: [], stopped_receipt: 'x' }),
    ),
  ).toThrow('missing-unfinished-scope');
  run = loadedRun({ ...run, spec: { ...f.spec, procedures: [] } });
  expect(() => ready(run)).toThrow('missing-procedure');
});

it('requires the exact procedure/rule version and exact new session for the LOAD receipt', () => {
  const run = startLocalRun(f.spec, 1);
  const receipt = loadedRun(run).loaded!;
  for (const [change, error] of [
    [{ run_id: 'other' }, 'wrong-load-identity'],
    [{ session_id: 'other' }, 'wrong-load-identity'],
    [{ rules: [] }, 'rules-not-loaded'],
    [{ rules: [{ ...receipt.rules[0]!, hash: 'changed' }] }, 'rules-not-loaded'],
    [{ procedures: [] }, 'procedures-not-loaded'],
    ...(['id', 'hash', 'version', 'locator'] as const).map(
      (key) =>
        [
          { procedures: receipt.procedures.map((p, i) => (i ? p : { ...p, [key]: 'wrong' })) },
          'procedures-not-loaded',
        ] as const,
    ),
  ] as [Partial<LoadReceipt>, string][])
    expect(() =>
      applyLocalEvent(run, event(run, { type: 'LOAD', receipt: { ...receipt, ...change } })),
    ).toThrow(error);
});

it('recognizes an older noncanonical event payload after storage reorders its keys', async () => {
  const { stableJson } = await import('../core/equality.js');
  expect(stableJson({ z: [null, true, 1], a: { b: 'x', a: false } })).toBe(
    '{"a":{"a":false,"b":"x"},"z":[null,true,1]}',
  );
  const f = await localFixture();
  try {
    const run = startLocalRun(f.spec, 1);
    const action = event(run, { type: 'WAIT' });
    const next = applyLocalEvent(run, action);
    const reordered = {
      type: action.type,
      generation: action.generation,
      expected_revision: action.expected_revision,
      event_id: action.event_id,
    };
    next.history[0]!.payload = JSON.stringify(reordered);
    expect(applyLocalEvent(next, action)).toBe(next);
  } finally {
    await f.dispose();
  }
});

it('admits a scoped reader and requires an observed procedure before implementation or coordination', () => {
  const profile = {
    ...f.spec.requested,
    permissions: ['read', 'update-card', 'implement'] as const,
  };
  const spec = {
    ...f.spec,
    procedure_loading: 'by-action' as const,
    requested: { ...profile, permissions: [...profile.permissions] },
    effective: { ...profile, permissions: [...profile.permissions] },
  };
  let run = startLocalRun(spec, 1);
  expect(selectedProcedures(spec).map((p) => p.id)).toEqual(['bootstrap', 'task', 'evidence']);
  const load = (ids: string[]) => {
    const receipt = {
      ...loadedRun(run).loaded!,
      procedures: spec.procedures.filter((p) => ids.includes(p.id)),
    };
    run = applyLocalEvent(run, event(run, { type: 'LOAD', receipt }));
  };
  load(['bootstrap', 'task', 'evidence']);
  run = ready(run);
  assertRunAction(run, 'read');
  assertRunAction(run, 'update-card');
  expect(() => assertRunAction(run, 'implement')).toThrow('procedure-not-loaded:implementation');
  load(['bootstrap', 'task', 'evidence', 'implementation']);
  expect(() => assertRunAction(run, 'implement')).toThrow('procedure-not-loaded:boundary-review');
  load(['bootstrap', 'task', 'evidence', 'implementation', 'boundary-review']);
  assertRunAction(run, 'implement');
  const coordinator = {
    ...run,
    type: 'orchestrator' as const,
    spec: {
      ...spec,
      coordinator: true,
      requested: { ...spec.requested, permissions: ['coordinate' as const] },
    },
  };
  expect(() => assertRunAction(coordinator, 'coordinate')).toThrow(
    'procedure-not-loaded:coordination',
  );
  coordinator.loaded = {
    ...coordinator.loaded!,
    procedures: [
      ...coordinator.loaded!.procedures,
      spec.procedures.find((p) => p.id === 'coordination')!,
    ],
  };
  assertRunAction(coordinator, 'coordinate');
  expect(run.spec.procedures).toEqual(f.spec.procedures);
});

it('rejects forged scoped receipts, missing startup reads and unknown saved loading modes', () => {
  const run = startLocalRun({ ...f.spec, procedure_loading: 'by-action' }, 1);
  const full = loadedRun(run).loaded!;
  for (const procedures of [
    [full.procedures[0]!, full.procedures[0]!],
    [{ ...full.procedures[0]!, version: 'unknown' }],
    [{ ...full.procedures[0]!, hash: 'changed' }],
  ])
    expect(() =>
      applyLocalEvent(run, event(run, { type: 'LOAD', receipt: { ...full, procedures } })),
    ).toThrow('procedures-not-loaded');
  const incomplete = applyLocalEvent(
    run,
    event(run, { type: 'LOAD', receipt: { ...full, procedures: [] } }),
  );
  expect(() => ready(incomplete)).toThrow('procedure-not-loaded:bootstrap');
  const unknown = { ...f.spec, procedure_loading: 'unknown' } as unknown as typeof f.spec;
  expect(() => startLocalRun(unknown, 1)).toThrow('unsupported-procedure-loading');
});
