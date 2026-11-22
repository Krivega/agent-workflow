import { beginExecution, advanceExecution } from '../application/executionWorkflow.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { validateCheckpoint } from '../adapters/storage/workflowValidation.js';
import { unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { createCouncil, assignAdviser, answerCouncil } from '../core/council.js';
import { recordCorrection, resolveFinding } from '../core/findings.js';
import { createExecution } from '../core/execution.js';
import type { Execution, ExecutionAction, MechanicalProof } from '../core/execution.js';
import type { Json, TechnicalState } from '../core/evidence.js';
import type { AgentSession } from '../core/dataRoute.js';
import type { LocalRun } from '../core/localRun.js';
import { fixture, grant } from './storageFixtures.js';
import { workflowFixture, executionEvent } from './workflowFixtures.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
let db: ReturnType<typeof fixture>;
let journal: TaskWorkflowJournal;
beforeEach(async () => {
  f = await workflowFixture();
  db = fixture();
  db.claim();
  journal = new TaskWorkflowJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
  );
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});
function checkpoint(patch: Record<string, unknown>) {
  const state = unwrap<TechnicalState>(db.execute({ type: 'state' }));
  expect(
    db.mutate(
      {
        type: 'checkpoint',
        state: { ...(state.checkpoint as object), ...patch } as Json,
        effects: [],
      },
      state.revision,
    ).ok,
  ).toBe(true);
}
function initial(route: Execution['route'] = 'substantial') {
  return createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
    true,
    route,
  );
}
function proof(): MechanicalProof {
  return {
    inputs: f.target.inputs,
    accepted: f.proof,
    observed: f.proof,
    delta: f.target.diff,
    expected_delta: f.target.diff,
    links: [f.proof],
    expected_links: [f.proof],
    semantic_delta: false,
    applicability: 'applicable',
  };
}
async function advance(run: Execution, action: ExecutionAction) {
  return advanceExecution(executionEvent(run, action), journal, f.inputs);
}
async function reviewed(route: Execution['route'] = 'substantial') {
  checkpoint({ local_run: f.executor });
  let run = await beginExecution(initial(route), journal);
  run = await advance(
    run,
    route === 'substantial'
      ? { type: 'PLAN', council: f.council('planning') }
      : { type: 'MECHANICAL', proof: proof() },
  );
  return advance(run, {
    type: 'REVIEW',
    target: f.target,
    selection: f.selection,
    baseline: {
      kind: 'real',
      scenario: 'local command represented in fixture',
      evidence: f.proof,
      inputs: f.target.inputs,
      elapsed_ms: 1,
      exit_code: 0,
    },
    checks: [
      {
        id: 'validate',
        verdict: 'PASS',
        reason: 'local',
        evidence: f.proof,
        inputs: f.target.inputs,
      },
    ],
  });
}
async function result(run: Execution) {
  return advance(run, {
    type: 'RESULT',
    result: {
      scope: run.target.scope,
      target: run.target,
      evidence: [f.proof, f.target.diff],
      child_results: run.child_results,
      limitations: ['fixture'],
      summary: 'bounded result',
    },
  });
}

it.each([0, 1])(
  'rejects a profile %s changed after acceptance without saving DONE and allows replanning',
  async (index) => {
    let run = await reviewed();
    run = await advance(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] });
    run = await result(run);
    const saved = await journal.read();
    await f.file(f.profiles.architect[index]!.locator, '# Changed after acceptance\n');
    await expect(advance(run, { type: 'DONE' })).rejects.toThrow('workflow-input-changed');
    expect(await journal.read()).toEqual(saved);
    const replanning = await advance(run, { type: 'REPLAN', target: f.target });
    expect(replanning.status).toBe('planning');
    await expect(
      advance(replanning, { type: 'PLAN', council: f.council('planning') }),
    ).rejects.toThrow('workflow-input-changed');
  },
);

it('requires the actual ready AW4 writer and atomically rejects cancellation or generation changes', async () => {
  await expect(beginExecution(initial(), journal)).rejects.toThrow('invalid-object');
  for (const patch of [{ schema_version: 2 }, { status: 'cancelled' }, { status: 'waiting' }]) {
    checkpoint({ local_run: { ...f.executor, ...patch } });
    await expect(beginExecution(initial(), journal)).rejects.toThrow('local-executor-not-ready');
  }
  for (const patch of [
    { generation: 2 },
    { spec: { ...f.executor.spec, project_id: 'other' } },
    { spec: { ...f.executor.spec, identity: { assignment_id: 'role' } } },
    { spec: { ...f.executor.spec, identity: { task_id: 'other', card: f.proof } } },
    { spec: { ...f.executor.spec, run_id: 'other' } },
  ]) {
    checkpoint({ local_run: { ...f.executor, ...patch } });
    await expect(beginExecution(initial(), journal)).rejects.toThrow('wrong-local-executor');
  }
  checkpoint({ local_run: { ...f.executor, projection: { result: { status: 'pending' } } } });
  await expect(beginExecution(initial(), journal)).rejects.toThrow('reconciliation-pending');
  checkpoint({ local_run: { ...f.executor, spec: { ...f.executor.spec, writer: 'other' } } });
  await expect(beginExecution(initial(), journal)).rejects.toThrow('not-card-writer');
  checkpoint({ local_run: f.executor });
  const run = await beginExecution(initial(), journal);
  const action = executionEvent(run, { type: 'PLAN', council: f.council('planning') });
  await expect(
    advanceExecution(action, journal, {
      current: f.inputs.current.bind(f.inputs),
      verify: async (refs) => {
        await f.inputs.verify(refs);
        checkpoint({ local_run: { ...f.executor, status: 'cancelled' } });
      },
    }),
  ).rejects.toThrow('local-executor-not-ready');
  expect((await journal.read()).execution!.status).toBe('planning');
  await expect(advanceExecution(action, journal, f.inputs)).rejects.toThrow(
    'local-executor-not-ready',
  );
});

it('verifies every M1 source before persistence and rechecks it at done', async () => {
  checkpoint({ local_run: f.executor });
  let run = await beginExecution(initial('mechanical'), journal);
  const forged = { locator: 'absent.txt', hash: 'a'.repeat(64) };
  await expect(
    advance(run, { type: 'MECHANICAL', proof: { ...proof(), accepted: forged, observed: forged } }),
  ).rejects.toThrow();
  expect((await journal.read()).execution!.status).toBe('planning');
  run = await advance(run, { type: 'MECHANICAL', proof: proof() });
  await f.file('proof.txt', 'edited');
  await expect(
    advance(run, {
      type: 'REVIEW',
      target: f.target,
      selection: f.selection,
      baseline: {
        kind: 'real',
        scenario: 'command',
        evidence: f.proof,
        inputs: f.target.inputs,
        elapsed_ms: 0,
        exit_code: 0,
      },
      checks: [],
    }),
  ).rejects.toThrow('workflow-input-changed');
});

it('revalidates child dependencies and separate proof files after Result and allows explicit invalidation', async () => {
  let run = await reviewed();
  run = await advance(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] });
  await f.file('child-source.txt', 'v1');
  await f.file('child-proof.txt', 'pass');
  const childInputs = await f.inputs.capture(
    { files: ['child-source.txt'], directories: [] },
    'child',
  );
  const reuse = {
    type: 'REUSE' as const,
    scope: 'child',
    criterion: 'child criterion',
    original_scope: 'child',
    original_criterion: 'child criterion',
    source: childInputs,
    current: childInputs,
    evidence: await f.ref('child-proof.txt'),
    risk: false,
  };
  run = await advance(run, reuse);
  run = await result(run);
  await f.file('child-proof.txt', 'changed proof');
  await expect(advance(run, { type: 'DONE' })).rejects.toThrow('workflow-input-changed');
  await f.file('child-proof.txt', 'pass');
  await f.file('child-source.txt', 'v2');
  await expect(advance(run, { type: 'DONE' })).rejects.toThrow('child-inputs-stale-or-unknown');
  run = await advance(run, {
    type: 'INVALIDATE_CHILD',
    scope: 'child',
    criterion: 'child criterion',
    reason: 'dependency changed',
  });
  await expect(advance(run, { type: 'DONE' })).rejects.toThrow('premature-done');
  run = await advance(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] });
  expect(run.child_results[0]!.valid).toBe(false);
  await f.file('child-source.txt', 'v1');
  run = await advance(run, reuse);
  run = await result(run);
  run = await advance(run, { type: 'DONE' });
  expect(run.status).toBe('done');
  expect((await journal.read()).execution).toEqual(run);
});

it('permits a replacement reviewer only after primary identity-loss confirmation and a durable checkpoint', async () => {
  let run = await reviewed();
  run = await advance(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] });
  run = await advance(run, { type: 'CORRECT', findings: [] });
  const replacement: LocalRun = {
    ...f.adviser,
    spec: { ...f.adviser.spec, session_id: 'replacement' },
    loaded: { ...f.adviser.loaded!, session_id: 'replacement' },
  };
  const action = executionEvent(run, {
    type: 'REPLACE_REVIEWER',
    role: 'architect',
    previous_session: 'session',
    run: replacement,
    checkpoint: f.proof,
  });
  await expect(advanceExecution(action, journal, f.inputs)).rejects.toThrow(
    'reviewer-recovery-unconfirmed',
  );
  const meta: AgentSession = {
    id: 'replacement',
    model: 'fixture',
    effort: 'high',
    workspace: f.root,
    project_id: 'project',
    read_only: true,
    network: false,
    forked_from: null,
    initial_turns: 0,
    receipt: f.proof,
  };
  const inspect = vi.fn(async (): Promise<AgentSession | null> => meta);
  await expect(advanceExecution(action, journal, f.inputs, { inspect })).rejects.toThrow(
    'reviewer-still-recoverable',
  );
  inspect.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  await expect(advanceExecution(action, journal, f.inputs, { inspect })).rejects.toThrow(
    'replacement-session-missing',
  );
  inspect.mockResolvedValueOnce(null).mockResolvedValueOnce(meta);
  expect(
    (await advanceExecution(action, journal, f.inputs, { inspect })).reviewer_sessions.architect,
  ).toBe('replacement');
});

it('rejects malformed nested checkpoints during restore, before they can be promoted to done', async () => {
  const run = initial();
  const base = { schema_version: 1, revision: 0, execution: run, readings: {} };
  const malformed = [
    { ...base, readings: [] },
    { ...base, revision: -1 },
    { ...base, revision: 0.5 },
    ...[
      { schema_version: 99 },
      { revision: -1 },
      { generation: 0 },
      { status: 'unknown' },
      { route: 'unknown' },
      { code: null },
      { gates: [] },
      { status: 'done' },
      { history: null },
      {
        baseline: {
          kind: 'real',
          scenario: 'bad time',
          evidence: f.proof,
          inputs: f.target.inputs,
          elapsed_ms: -1,
          exit_code: 0,
        },
      },
    ].map((patch) => ({ ...base, execution: { ...run, ...patch } })),
    { ...base, readings: { wrong: { id: 'other' } } },
    {
      ...base,
      execution: {
        ...run,
        planning: {
          ...f.council('planning'),
          advisers: {
            architect: {
              ...f.council('planning').advisers.architect!,
              run: { ...f.adviser, schema_version: 99 },
            },
          },
        },
      },
    },
    {
      ...base,
      execution: {
        ...run,
        planning: {
          ...f.council('planning'),
          advisers: {
            architect: { ...f.council('planning').advisers.architect!, status: 'running' },
          },
        },
      },
    },
  ];
  for (const invalid of malformed) {
    checkpoint({ workflow: invalid });
    await expect(journal.read()).rejects.toThrow();
  }
  const valid = {
    ...base,
    execution: {
      ...run,
      mechanical: proof(),
      child_results: [
        {
          scope: 'child',
          criterion: 'done',
          evidence: f.proof,
          inputs: f.target.inputs,
          valid: false,
        },
      ],
      acceptance: f.council('acceptance'),
      findings: [
        {
          id: 'finding',
          scope: 'workflow',
          condition: 'fixed',
          reason: 'issue',
          blocking: true,
          sources: [f.proof],
          owner: 'architect',
          original_fail: f.proof,
          rounds: [{ correction_id: 'round', evidence: [f.proof], reviewers: ['architect'] }],
          resolution: { condition: 'fixed', reviewer: 'architect', evidence: f.proof },
        },
      ],
    },
  };
  expect(() => validateCheckpoint(valid)).not.toThrow();
  const running = f.council('planning');
  running.advisers.architect = {
    ...running.advisers.architect!,
    status: 'running',
    answer: null,
    reviewed: null,
  };
  expect(() =>
    validateCheckpoint({ ...base, execution: { ...run, planning: running } }),
  ).not.toThrow();
  expect(() =>
    validateCheckpoint({
      ...valid,
      execution: {
        ...valid.execution,
        findings: [{ ...valid.execution.findings[0]!, resolution: null }],
      },
    }),
  ).not.toThrow();
});

it('keeps M1 retry receipts without retaining superseded proof after substantial replanning', async () => {
  let run = await reviewed('mechanical');
  const oldDelta = run.mechanical!.delta;
  await f.file('diff.txt', 'new substantial delta at the same locator');
  const target = { ...f.target, diff: await f.ref('diff.txt') };
  run = await advance(run, { type: 'REPLAN', target });
  const council = (phase: 'planning' | 'acceptance') => {
    const assigned = assignAdviser(
      createCouncil(phase, f.selection, target),
      'architect',
      f.adviser,
    );
    return answerCouncil(assigned, 'architect', 'session', { ...f.answer(assigned), target });
  };
  run = await advance(run, { type: 'PLAN', council: council('planning') });
  run = await advance(run, {
    type: 'REVIEW',
    target,
    selection: f.selection,
    baseline: {
      kind: 'real',
      scenario: 'new substantial baseline',
      evidence: f.proof,
      inputs: target.inputs,
      elapsed_ms: 1,
      exit_code: 0,
    },
    checks: [
      {
        id: 'validate',
        verdict: 'PASS',
        reason: 'new checks',
        evidence: f.proof,
        inputs: target.inputs,
      },
    ],
  });
  run = await advance(run, { type: 'ACCEPT', council: council('acceptance'), findings: [] });
  run = await advance(run, {
    type: 'RESULT',
    result: {
      scope: target.scope,
      target,
      evidence: [f.proof, target.diff],
      child_results: [],
      limitations: [],
      summary: 'new substantial result with current evidence',
    },
  });
  run = await advance(run, { type: 'DONE' });
  expect(run.status).toBe('done');
  expect(run.mechanical).toBeNull();
  expect(run.result!.evidence).not.toContainEqual(oldDelta);
  expect(
    (await journal.read({ archive: true })).execution!.history.some(
      (event) => event.fingerprint?.length === 64 && event.type === 'MECHANICAL',
    ),
  ).toBe(true);
});

it.each([false, true])(
  'revokes child reuse for a later nonblocking finding until independent revalidation, restored=%s',
  async (restored) => {
    let run = await reviewed();
    run = await advance(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] });
    const reuse = {
      type: 'REUSE' as const,
      scope: 'child',
      criterion: 'accepted criterion',
      original_scope: 'child',
      original_criterion: 'accepted criterion',
      source: f.target.inputs,
      current: f.target.inputs,
      evidence: f.proof,
      risk: false,
    };
    run = await advance(run, reuse);
    run = await result(run);
    const finding = {
      id: 'child-risk',
      scope: 'child',
      condition: 'risk checked and addressed',
      reason: 'new scoped defect or risk',
      blocking: false,
      sources: [f.proof],
    };
    const assigned = assignAdviser(
      createCouncil('acceptance', f.selection, f.target),
      'architect',
      f.adviser,
    );
    const withRisk = answerCouncil(assigned, 'architect', 'session', {
      ...f.answer(assigned),
      findings: [finding],
    });
    run = await advance(run, { type: 'ACCEPT', council: withRisk, findings: [] });
    expect(run.child_results[0]!.valid).toBe(false);
    await expect(result(run)).rejects.toThrow('result-gates-open');
    await expect(advance(run, { type: 'DONE' })).rejects.toThrow('premature-done');
    if (restored) {
      const state = await journal.read();
      checkpoint({
        workflow: {
          ...state,
          execution: {
            ...run,
            child_results: run.child_results.map((child) => ({ ...child, valid: true })),
          },
        },
      });
      run = (await journal.read()).execution!;
      expect(run.child_results[0]!.valid).toBe(true);
    }
    const original = run.findings[0]!;
    const resolved = resolveFinding(
      recordCorrection(original, 'child-correction', 'architect', f.proof),
      original.condition,
      f.proof,
      'architect',
      'PASS',
    );
    run = await advance(run, {
      type: 'ACCEPT',
      council: f.council('acceptance'),
      findings: [resolved],
    });
    expect(run.child_results[0]!.valid).toBe(false);
    await expect(result(run)).rejects.toThrow('result-gates-open');
    run = await advance(run, reuse);
    run = await result(run);
    run = await advance(run, { type: 'DONE' });
    expect(run.status).toBe('done');
    expect(run.findings[0]!.original_fail).toEqual(f.proof);
  },
);
