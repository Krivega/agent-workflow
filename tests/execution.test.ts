import {
  applyExecution,
  checkMechanical,
  createExecution,
  executionBlockers,
} from '../core/execution.js';
import type { Execution, ExecutionAction, MechanicalProof } from '../core/execution.js';
import { answerCouncil, assignAdviser, createCouncil } from '../core/council.js';
import {
  recordCorrection,
  recordFinding,
  recordRoundVerdict,
  resolveFinding,
} from '../core/findings.js';
import { executionEvent, workflowFixture } from './workflowFixtures.js';
import { sameValue } from '../core/equality.js';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});
const act = (run: Execution, action: ExecutionAction) =>
  applyExecution(run, executionEvent(run, action));
function initial(route: Execution['route'] = 'substantial') {
  return createExecution(
    'task',
    1,
    f.target,
    [
      { id: 'validate', applicable: true, reason: 'code', kind: 'check' },
      { id: 'human', applicable: true, reason: 'explicit acceptance', kind: 'human' },
      { id: 'device', applicable: false, reason: 'no device change', kind: 'check' },
    ],
    true,
    route,
  );
}
function mechanical(): MechanicalProof {
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
function review(): Extract<ExecutionAction, { type: 'REVIEW' }> {
  return {
    type: 'REVIEW',
    target: f.target,
    selection: f.selection,
    baseline: {
      kind: 'real',
      scenario: 'actual local command',
      evidence: f.proof,
      inputs: f.target.inputs,
      elapsed_ms: 12,
      exit_code: 0,
    },
    checks: ['validate', 'human'].map((id) => ({
      id,
      verdict: 'PASS',
      reason: 'verified',
      evidence: f.proof,
      inputs: f.target.inputs,
    })),
  };
}
function ready() {
  return act(act(initial(), { type: 'PLAN', council: f.council('planning') }), review());
}
function accepted() {
  return act(ready(), { type: 'ACCEPT', council: f.council('acceptance'), findings: [] });
}
function result(run: Execution): Extract<ExecutionAction, { type: 'RESULT' }> {
  return {
    type: 'RESULT',
    result: {
      scope: f.target.scope,
      target: f.target,
      evidence: [f.proof, f.target.diff],
      child_results: run.child_results,
      limitations: [],
      summary: 'bounded result',
    },
  };
}

it('advances large historical payloads within a bounded heap while keeping mutable state independent', () => {
  const module = pathToFileURL(resolve(import.meta.dirname, '../core/execution.ts')).href;
  const output = execFileSync(
    process.execPath,
    [
      '--max-old-space-size=128',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import { applyExecution } from ${JSON.stringify(module)};
       const run = ${JSON.stringify(act(initial(), { type: 'PLAN', council: f.council('planning') }))};
       const payload = 'ё'.repeat(40_000_000);
       run.history = [{ id: 'historical-failure', payload }];
       const event = { type: 'REPLAN', id: 'next', expected_revision: run.revision, generation: 1, target: run.target };
       const next = applyExecution(run, event);
       assert.equal(next.history[0].payload, payload);
       assert.equal(next.history.length, 2);
       next.history[0].id = 'changed';
       next.target.scope = 'changed';
       assert.equal(run.history[0].id, 'historical-failure');
       assert.equal(run.history.length, 1);
       assert.equal(run.target.scope, 'workflow');
       assert.equal(event.target.scope, 'workflow');
       assert.equal(applyExecution(run, event).history[0].payload, payload);
       console.log('preserved');`,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  expect(output.trim()).toBe('preserved');
});

it('requires planning, a real measured baseline, exact checks, acceptance and a durable Result before done', () => {
  let run = initial();
  expect(() => act(run, review())).toThrow('implementation-not-started');
  expect(() => act(run, { type: 'DONE' })).toThrow('premature-done');
  expect(() => act(run, { type: 'PLAN', council: f.council('acceptance') })).toThrow(
    'wrong-planning-phase',
  );
  expect(() =>
    act(run, { type: 'PLAN', council: createCouncil('planning', f.selection, f.target) }),
  ).toThrow('planning-not-accepted');
  expect(() =>
    act(run, {
      type: 'PLAN',
      council: { ...f.council('planning'), target: { ...f.target, scope: 'other' } },
    }),
  ).toThrow('planning-not-accepted');
  run = act(run, { type: 'PLAN', council: f.council('planning') });
  for (const patch of [
    { kind: 'fixture' as const },
    { exit_code: 1 },
    { elapsed_ms: -1 },
    { elapsed_ms: Number.NaN },
  ])
    expect(() => act(run, { ...review(), baseline: { ...review().baseline, ...patch } })).toThrow(
      'real-baseline-required',
    );
  expect(() =>
    act(run, {
      ...review(),
      baseline: { ...review().baseline, inputs: { ...f.target.inputs, complete: false } },
    }),
  ).toThrow('stale-baseline');
  expect(() =>
    act(run, { ...review(), checks: [review().checks[0]!, review().checks[0]!] }),
  ).toThrow('duplicate-check');
  expect(() => act(run, { ...review(), target: { ...f.target, scope: 'new' } })).toThrow(
    'new-scope-needs-planning',
  );
  const newSelection = { ...f.selection, dba: { ...f.selection.dba, trigger: true } };
  expect(() => act(run, { ...review(), selection: newSelection })).toThrow(
    'new-scope-needs-planning',
  );
  run = act(run, review());
  expect(executionBlockers(run)).toEqual(['acceptance-missing']);
  expect(() => act(run, result(run))).toThrow('result-gates-open');
  expect(() => act(run, { type: 'ACCEPT', council: f.council('planning'), findings: [] })).toThrow(
    'wrong-acceptance-phase',
  );
  expect(() =>
    act(run, {
      type: 'ACCEPT',
      council: { ...f.council('acceptance'), target: { ...f.target, base: 'new' } },
      findings: [],
    }),
  ).toThrow('wrong-acceptance-target');
  expect(() =>
    act(run, {
      type: 'ACCEPT',
      council: {
        ...f.council('acceptance'),
        configuration: { catalog: 'profiles/readme.md', profiles: { qa: 'profiles/qa.md' } },
      },
      findings: [],
    }),
  ).toThrow('wrong-council-configuration');
  expect(() =>
    act(run, {
      type: 'ACCEPT',
      council: { ...f.council('acceptance'), selection: newSelection },
      findings: [],
    }),
  ).toThrow('unplanned-acceptance-scope');
  run = act(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] });
  expect(() => act(run, { type: 'DONE' })).toThrow('premature-done');
  expect(() =>
    act(run, { ...result(run), result: { ...result(run).result, scope: 'other' } }),
  ).toThrow('wrong-result-target');
  expect(() =>
    act(run, {
      ...result(run),
      result: { ...result(run).result, target: { ...f.target, base: 'new' } },
    }),
  ).toThrow('wrong-result-target');
  expect(() =>
    act(run, { ...result(run), result: { ...result(run).result, evidence: [] } }),
  ).toThrow('result-evidence-missing');
  expect(() =>
    act(run, {
      ...result(run),
      result: { ...result(run).result, evidence: [{ locator: 'other', hash: 'x' }] },
    }),
  ).toThrow('result-proof-links-missing');
  const event = executionEvent(run, result(run));
  run = applyExecution(run, event);
  expect(applyExecution(run, event)).toBe(run);
  expect(() => applyExecution(run, { ...event, type: 'DONE' })).toThrow('execution-event-conflict');
  expect(() =>
    applyExecution(run, { ...executionEvent(run, { type: 'DONE' }), generation: 2 }),
  ).toThrow('stale-execution-event');
  expect(() =>
    applyExecution(run, { ...executionEvent(run, { type: 'DONE' }), expected_revision: 0 }),
  ).toThrow('stale-execution-event');
  run = act(run, { type: 'DONE' });
  expect(run.status).toBe('done');
  expect(() => act(run, { type: 'DONE' })).toThrow('execution-done');
});

it('never treats missing, failed, unknown or human checks as success', () => {
  const run = accepted();
  for (const verdict of ['FAIL', 'NOT RUN', 'N/A'] as const) {
    const invalid = {
      ...run,
      checks: run.checks.map((c) => (c.id === 'human' ? { ...c, verdict } : c)),
    };
    expect(executionBlockers(invalid)).toContain('human:not-passed');
    expect(() => act(invalid, result(invalid))).toThrow('result-gates-open');
  }
  expect(executionBlockers({ ...run, checks: [] })).toEqual([
    'validate:not-passed',
    'human:not-passed',
  ]);
  expect(
    executionBlockers({
      ...run,
      checks: run.checks.map((c) => ({ ...c, inputs: { ...c.inputs, complete: false } })),
    }),
  ).toContain('validate:not-passed');
  expect(executionBlockers({ ...run, compromise: 'pending' })).toEqual([
    'human-compromise-pending',
  ]);
  expect(() => createExecution('task', 0, f.target, [], false, 'substantial')).toThrow(
    'invalid-generation',
  );
  expect(() => createExecution('task', 1, f.target, [], false, 'substantial')).toThrow(
    'invalid-gates',
  );
  expect(() =>
    createExecution('task', 1, f.target, [run.gates[0]!, run.gates[0]!], false, 'substantial'),
  ).toThrow('invalid-gates');
  for (const patch of [{ applicable: false }, { kind: 'human' as const }, { id: 'other' }])
    expect(() =>
      createExecution('task', 1, f.target, [{ ...run.gates[0]!, ...patch }], true, 'substantial'),
    ).toThrow('validate-required');
  expect(createExecution('task', 1, f.target, [run.gates[0]!], false, 'substantial').code).toBe(
    false,
  );
});

it('runs M1 without a council, returns new semantics to planning and preserves accepted child scope', () => {
  let run = initial('mechanical');
  expect(() => act(run, { type: 'PLAN', council: f.council('planning') })).toThrow(
    'wrong-planning-phase',
  );
  expect(() => act(initial(), { type: 'MECHANICAL', proof: mechanical() })).toThrow(
    'wrong-mechanical-phase',
  );
  for (const patch of [
    { semantic_delta: true },
    { applicability: 'unknown' as const },
    { applicability: 'changed' as const },
  ])
    expect(() => checkMechanical({ ...mechanical(), ...patch })).toThrow(
      'mechanical-needs-planning',
    );
  for (const patch of [
    { observed: { ...f.proof, hash: 'changed' } },
    { expected_delta: { ...f.proof, hash: 'changed' } },
    { expected_links: [] },
  ])
    expect(() => checkMechanical({ ...mechanical(), ...patch })).toThrow(
      'mechanical-proof-mismatch',
    );
  run = act(run, { type: 'MECHANICAL', proof: mechanical() });
  run = act(run, review());
  expect(executionBlockers(run)).toEqual([]);
  run = act(run, result(run));
  run = act(run, { type: 'DONE' });
  expect(run.status).toBe('done');
  let substantive = act(initial('mechanical'), { type: 'MECHANICAL', proof: mechanical() });
  substantive = act(substantive, { type: 'REPLAN', target: f.target });
  expect(substantive.status).toBe('planning');
  expect(substantive.route).toBe('substantial');
  expect(() => act(initial(), { type: 'REPLAN', target: f.target })).toThrow('wrong-replan-phase');
  expect(act(ready(), { type: 'REPLAN', target: f.target }).status).toBe('planning');
  const revised = act(initial(), {
    type: 'REPLAN',
    target: f.target,
    requirements: { revision: 1, source: f.proof },
  });
  expect(revised.requirements_revision).toBe(1);
  expect(() =>
    act(revised, {
      type: 'REPLAN',
      target: f.target,
      requirements: { revision: 1, source: f.proof },
    }),
  ).toThrow('stale-requirements-revision');
  const reuse: Extract<ExecutionAction, { type: 'REUSE' }> = {
    type: 'REUSE',
    scope: 'child',
    criterion: 'child-criterion',
    original_scope: 'child',
    original_criterion: 'child-criterion',
    source: f.target.inputs,
    current: f.target.inputs,
    evidence: f.proof,
    risk: false,
  };
  let parent = act(accepted(), reuse);
  expect(() => act(parent, reuse)).toThrow('child-already-reused');
  for (const patch of [
    { scope: 'other' },
    { criterion: 'other' },
    { risk: true },
    { current: { ...f.target.inputs, complete: false } },
  ])
    expect(() => act(accepted(), { ...reuse, ...patch })).toThrow('child-result-not-reusable');
  expect(() =>
    act(parent, { ...result(parent), result: { ...result(parent).result, child_results: [] } }),
  ).toThrow('child-scope-lost');
  parent = act(parent, result(parent));
  expect(parent.result!.child_results[0]!.scope).toBe('child');
});

it('keeps blockers, original failures and rounds when correction or HEAD changes', () => {
  const finding = {
    id: 'F1',
    scope: 'workflow',
    condition: 'fix invariant',
    reason: 'defect',
    blocking: true,
    sources: [f.proof],
  };
  const council = assignAdviser(
    createCouncil('acceptance', f.selection, f.target),
    'architect',
    f.adviser,
  );
  const failed = answerCouncil(council, 'architect', 'session', {
    ...f.answer(council),
    verdict: 'FAIL',
    findings: [finding],
  });
  let run = act(ready(), { type: 'ACCEPT', council: failed, findings: [] });
  expect(executionBlockers(run)).toContain('open-blocker');
  expect(() => act(run, { type: 'CORRECT', findings: [] })).toThrow('finding-history-lost');
  const original = run.findings[0]!;
  const corrected = recordCorrection(original, 'correction', 'architect', f.proof);
  run = act(run, { type: 'CORRECT', findings: [corrected] });
  expect(run.status).toBe('implementing');
  expect(() => act(run, { type: 'CORRECT', findings: run.findings })).toThrow(
    'wrong-correction-phase',
  );
  run = act(run, review());
  expect(() =>
    act(run, {
      type: 'ACCEPT',
      council: f.council('acceptance'),
      findings: [{ ...corrected, rounds: [] }],
    }),
  ).toThrow('finding-history-lost');
  for (const patch of [
    { condition: 'other' },
    { scope: 'other' },
    { blocking: false },
    { reason: 'other' },
    { sources: [] },
    { owner: 'dba' as const },
    { original_fail: { ...f.proof, hash: 'other' } },
    { rounds: [{ ...corrected.rounds[0]!, reviewers: [] }] },
    { rounds: [{ ...corrected.rounds[0]!, evidence: [] }] },
  ])
    expect(() =>
      act(run, {
        type: 'ACCEPT',
        council: f.council('acceptance'),
        findings: [{ ...corrected, ...patch }],
      }),
    ).toThrow('finding-history-lost');
  expect(
    executionBlockers(
      act(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [corrected] }),
    ),
  ).toContain('open-blocker');
  const resolved = resolveFinding(corrected, corrected.condition, f.proof, 'architect', 'PASS');
  for (const patch of [
    { condition: 'wrong' },
    { reviewer: 'dba' as const },
    { evidence: { ...f.proof, hash: 'wrong' } },
  ])
    expect(() =>
      act(run, {
        type: 'ACCEPT',
        council: f.council('acceptance'),
        findings: [{ ...resolved, resolution: { ...resolved.resolution!, ...patch } }],
      }),
    ).toThrow('unproven-finding-resolution');
  const incomplete = { ...f.council('acceptance'), advisers: {} };
  expect(() => act(run, { type: 'ACCEPT', council: incomplete, findings: [resolved] })).toThrow(
    'resolution-review-missing',
  );
  for (const patch of [{ verdict: 'FAIL' as const }, { evidence: { ...f.proof, hash: 'other' } }]) {
    const council = f.council('acceptance');
    const adviser = council.advisers.architect!;
    const changed = {
      ...council,
      advisers: { architect: { ...adviser, answer: { ...adviser.answer!, ...patch } } },
    };
    expect(() => act(run, { type: 'ACCEPT', council: changed, findings: [resolved] })).toThrow(
      'resolution-review-missing',
    );
  }
  run = act(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [resolved] });
  expect(executionBlockers(run)).toEqual([]);
  expect(run.findings[0]!.rounds).toHaveLength(1);
  const open = recordFinding([], finding, 'architect', f.proof);
  const reuse = {
    type: 'REUSE' as const,
    scope: 'workflow',
    original_scope: 'workflow',
    criterion: 'x',
    original_criterion: 'x',
    source: f.target.inputs,
    current: f.target.inputs,
    evidence: f.proof,
    risk: false,
  };
  expect(() => act({ ...run, findings: open }, reuse)).toThrow('child-result-not-reusable');
  expect(() =>
    act(
      { ...run, planning: null },
      { type: 'ACCEPT', council: f.council('acceptance'), findings: [resolved] },
    ),
  ).toThrow('unplanned-acceptance-scope');
});

it('retains native closing comments without replacing the resolved finding definition', () => {
  const finding = recordFinding(
    [],
    {
      id: 'F-closing-comment',
      scope: 'workflow',
      condition: 'original repair condition',
      reason: 'original failure',
      blocking: true,
      sources: [f.proof],
    },
    'architect',
    f.proof,
  )[0]!;
  const corrected = recordRoundVerdict(finding, 'correction', 'architect', 'PASS', f.proof);
  const resolved = resolveFinding(corrected, finding.condition, f.proof, 'architect', 'PASS');
  const council = f.council('acceptance');
  const comment = {
    ...finding,
    scope: 'correction verified',
    condition: 'condition fulfilled',
    blocking: false,
  };
  council.history.push({
    role: 'architect',
    session: 'session',
    answer: { ...f.answer(council), findings: [comment] },
  });
  const previous = { ...ready(), findings: [corrected] };
  for (const verdicts of [
    undefined,
    [],
    [{ reviewer: 'architect' as const, verdict: 'FAIL' as const, evidence: f.proof }],
  ]) {
    const round = { ...resolved.rounds[0]! };
    if (verdicts === undefined) Reflect.deleteProperty(round, 'verdicts');
    else round.verdicts = verdicts;
    const stripped = { ...resolved, rounds: [round] };
    expect(() => act(previous, { type: 'ACCEPT', council, findings: [stripped] })).toThrow(
      'finding-history-lost',
    );
  }
  const run = act(previous, { type: 'ACCEPT', council, findings: [resolved] });
  expect(run.findings).toEqual([resolved]);
  expect(run.acceptance!.history.at(-1)!.answer.findings).toEqual([comment]);
  expect(executionBlockers(run)).toEqual([]);
});

it.each(['unresolved', 'blocking', 'other-owner', 'failed-verdict'])(
  'keeps definition conflicts strict for a closing comment: %s',
  (kind) => {
    const finding = recordFinding(
      [],
      {
        id: 'F-closing-comment',
        scope: 'workflow',
        condition: 'original condition',
        reason: 'defect',
        blocking: true,
        sources: [f.proof],
      },
      'architect',
      f.proof,
    )[0]!;
    const corrected = recordCorrection(finding, 'correction', 'architect', f.proof);
    const resolved = resolveFinding(corrected, finding.condition, f.proof, 'architect', 'PASS');
    const council = f.council('acceptance');
    council.history.push({
      role: kind === 'other-owner' ? 'backend' : 'architect',
      session: 'session',
      answer: {
        ...f.answer(council),
        verdict: kind === 'failed-verdict' ? 'FAIL' : 'PASS',
        findings: [{ ...finding, condition: 'changed condition', blocking: kind === 'blocking' }],
      },
    });
    expect(() =>
      act(
        { ...ready(), findings: [finding] },
        { type: 'ACCEPT', council, findings: [kind === 'unresolved' ? corrected : resolved] },
      ),
    ).toThrow('finding-identity-conflict');
  },
);

it('compares JSON values independently of object key ordering without ignoring array ordering or lost fields', () => {
  expect(sameValue({ x: [1, { b: 2, a: null }] }, { x: [1, { a: null, b: 2 }] })).toBe(true);
  for (const [a, b] of [
    [null, {}],
    [{}, null],
    [1, {}],
    [{}, 1],
    [[], {}],
    [{}, []],
    [[1], []],
    [
      [1, 2],
      [2, 1],
    ],
    [{ a: 1 }, { b: 1 }],
    [{ a: 1 }, {}],
    [{ a: 1 }, { a: 2 }],
  ])
    expect(sameValue(a, b)).toBe(false);
});

it('binds M1 to exact inputs and delta and invalidates Result when child results or acceptance change', () => {
  for (const proof of [
    { ...mechanical(), delta: f.proof, expected_delta: f.proof },
    { ...mechanical(), inputs: { ...f.target.inputs, complete: false } },
  ])
    expect(() => act(initial('mechanical'), { type: 'MECHANICAL', proof })).toThrow(
      'mechanical-target-mismatch',
    );
  const mechanicalRun = act(initial('mechanical'), { type: 'MECHANICAL', proof: mechanical() });
  for (const target of [
    { ...f.target, diff: f.proof },
    { ...f.target, inputs: { ...f.target.inputs, complete: false } },
  ])
    expect(() => act(mechanicalRun, { ...review(), target })).toThrow('mechanical-target-mismatch');
  expect(() => act({ ...mechanicalRun, mechanical: null }, review())).toThrow(
    'mechanical-target-mismatch',
  );
  const reviewed = act(mechanicalRun, review());
  expect(() =>
    act(reviewed, {
      ...result(reviewed),
      result: { ...result(reviewed).result, evidence: [f.proof] },
    }),
  ).toThrow('result-proof-links-missing');
  let run = act(accepted(), result(accepted()));
  expect(
    act(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] }).result,
  ).toBeNull();
  const reuse = {
    type: 'REUSE' as const,
    scope: 'child',
    original_scope: 'child',
    criterion: 'criterion',
    original_criterion: 'criterion',
    source: f.target.inputs,
    current: f.target.inputs,
    evidence: f.proof,
    risk: false,
  };
  run = act(run, reuse);
  expect(run.result).toBeNull();
  run = act(run, result(run));
  expect(() =>
    act(run, {
      type: 'INVALIDATE_CHILD',
      scope: 'missing',
      criterion: 'criterion',
      reason: 'changed dependency',
    }),
  ).toThrow('child-result-missing');
  run = act(run, {
    type: 'INVALIDATE_CHILD',
    scope: 'child',
    criterion: 'criterion',
    reason: 'changed dependency',
  });
  expect(run.result).toBeNull();
  expect(executionBlockers(run)).toContain('child:child:not-reusable');
  expect(() => act(run, { type: 'DONE' })).toThrow('premature-done');
  run = act(run, reuse);
  expect(run.child_results).toHaveLength(1);
  expect(run.child_results[0]!.valid).toBe(true);
});

it('retains acceptance assignments through correction, with explicit replacement after identity loss', () => {
  const council = assignAdviser(
    createCouncil('acceptance', f.selection, f.target),
    'architect',
    f.adviser,
  );
  let run = act(ready(), { type: 'ACCEPT', council, findings: [] });
  const replacement = {
    ...f.adviser,
    spec: { ...f.adviser.spec, session_id: 'replacement' },
    loaded: { ...f.adviser.loaded!, session_id: 'replacement' },
  };
  const other = assignAdviser(
    createCouncil('acceptance', f.selection, f.target),
    'architect',
    replacement,
  );
  expect(() => act(run, { type: 'ACCEPT', council: other, findings: [] })).toThrow(
    'reviewer-replacement-needs-recovery',
  );
  const replace = {
    type: 'REPLACE_REVIEWER' as const,
    role: 'architect' as const,
    previous_session: 'session',
    run: replacement,
    checkpoint: f.proof,
  };
  expect(() => act(run, { ...replace, previous_session: 'wrong' })).toThrow(
    'wrong-reviewer-recovery',
  );
  expect(() => act({ ...run, planning: null }, replace)).toThrow('wrong-reviewer-recovery');
  expect(act(run, replace).acceptance!.advisers.architect!.run.spec.session_id).toBe('replacement');
  run = act(run, { type: 'CORRECT', findings: [] });
  expect(run.reviewer_sessions.architect).toBe('session');
  const again = act(run, review());
  expect(() => act(again, { type: 'ACCEPT', council: other, findings: [] })).toThrow(
    'reviewer-replacement-needs-recovery',
  );
  run = act(run, replace);
  expect(run.reviewer_sessions.architect).toBe('replacement');
  const acceptedReplacement = answerCouncil(other, 'architect', 'replacement', f.answer(other));
  expect(
    act(act(run, review()), { type: 'ACCEPT', council: acceptedReplacement, findings: [] })
      .reviewer_sessions.architect,
  ).toBe('replacement');
});

it('blocks stale stored child acceptance when a later nonblocking scoped finding is unresolved', () => {
  const run = accepted();
  const finding = recordFinding(
    [],
    {
      id: 'risk',
      scope: 'child',
      condition: 'checked',
      reason: 'new risk',
      blocking: false,
      sources: [f.proof],
    },
    'architect',
    f.proof,
  );
  const stale = {
    ...run,
    findings: finding,
    child_results: [
      {
        scope: 'child',
        criterion: 'done',
        evidence: f.proof,
        inputs: f.target.inputs,
        valid: true,
      },
    ],
  };
  expect(executionBlockers(stale)).toEqual(['child:child:not-reusable']);
  expect(() => act(stale, result(stale))).toThrow('result-gates-open');
  const corrected = act({ ...stale, findings: [] }, { type: 'CORRECT', findings: finding });
  expect(corrected.child_results[0]!.valid).toBe(false);
});
