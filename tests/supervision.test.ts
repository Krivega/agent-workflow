import { afterEach, beforeEach, expect, it } from 'vitest';
import { recordFinding, recordRoundVerdict } from '../core/findings.js';
import {
  startArbitration,
  decideArbitration,
  humanArbitration,
  resumeArbitration,
  reconsiderArbitration,
  finishArbitration,
} from '../core/arbitration.js';
import { createTiming, sampleTiming, auditKey, claimAudit } from '../core/stageTiming.js';
import {
  applySupervision,
  emptySupervision,
  confirmIndependent,
  auditBrief,
  findingExcepted,
  assertSupervisedScope,
  supervisionBlockers,
  supervisionEvidence,
} from '../core/supervision.js';
import type { IndependentRole, SupervisionAction } from '../core/supervision.js';
import { applyExecution, createExecution, executionBlockers } from '../core/execution.js';
import { validateExecution } from '../adapters/storage/workflowValidation.js';
import { startLocalRun, applyLocalEvent } from '../core/localRun.js';
import { loadedRun, event as localEvent } from './localFixtures.js';
import { workflowFixture, executionEvent } from './workflowFixtures.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});
function finding() {
  return recordFinding(
    [],
    {
      id: 'F1',
      scope: 'workflow',
      blocking: true,
      waivable: true,
      reason: 'contradiction',
      condition: 'contract satisfied',
      sources: [f.proof],
    },
    'architect',
    f.proof,
  )[0]!;
}
function role(kind: 'arbiter' | 'auditor', id: string = kind): IndependentRole {
  const run = structuredClone(f.adviser);
  run.spec.role = kind;
  run.spec.session_id = id;
  run.loaded!.session_id = id;
  return {
    run,
    agent_type: kind,
    type_receipt: f.proof,
    session: {
      id,
      agent_role: kind,
      model: run.spec.requested.model,
      effort: run.spec.requested.effort,
      workspace: run.spec.workspace,
      project_id: run.spec.project_id,
      read_only: true,
      network: false,
      forked_from: null,
      initial_turns: 0,
      receipt: f.proof,
    },
  };
}
const trigger = () => ({
  kind: 'initial-contradiction' as const,
  reviewer: 'architect' as const,
  confirmation: f.proof,
});
const decision = (outcome: 'direction' | 'compromise' | 'undecided' = 'direction') => ({
  outcome,
  reason: 'Exact source resolves the conflict',
  exception: 'narrow exception',
  residual_risk: 'documented risk',
  dissent: ['original FAIL remains'],
  evidence: f.proof,
});
const proof = (verdict: 'PASS' | 'FAIL' = 'PASS') => ({
  target: f.target,
  implementation: f.proof,
  review: { reviewer: 'architect' as const, verdict, evidence: f.proof },
  condition: 'contract satisfied',
  working_check: f.proof,
  check_verdict: 'PASS' as const,
  mandatory_defect: false,
});

it('reconsiders blocked decisions without erasing history or bypassing human and review gates', () => {
  const item = finding();
  const start = startArbitration('A', item, trigger(), 'a');
  const undecided = decideArbitration(start, 'a', decision('undecided'));
  for (const [run, condition] of [
    [start, item.condition],
    [undecided, 'wrong'],
    [{ ...undecided, decision: null }, item.condition],
  ] as const)
    expect(() => reconsiderArbitration(run, condition, f.proof)).toThrow(
      'arbitration-not-reconsiderable',
    );
  expect(() =>
    reconsiderArbitration(undecided, item.condition, { ...f.proof, hash: '' }),
  ).toThrow();
  let waiting = reconsiderArbitration(undecided, item.condition, f.proof);
  expect(waiting.status).toBe('waiting');
  expect(waiting.original_fail).toEqual(item.original_fail);
  expect(waiting.attempts).toEqual([
    {
      decision: decision('undecided'),
      human: null,
      implementation: null,
      review: null,
      working_check: null,
      condition: item.condition,
      evidence: f.proof,
    },
  ]);
  expect(() => finishArbitration(waiting, item, proof())).toThrow('wrong-arbitration-scope');
  expect(() => decideArbitration(waiting, 'foreign', decision())).toThrow('wrong-arbiter-answer');
  const rejected = humanArbitration(
    decideArbitration(waiting, 'a', decision('compromise')),
    false,
    f.proof,
  );
  waiting = reconsiderArbitration(rejected, item.condition, f.proof);
  expect(waiting.attempts).toHaveLength(2);
  expect(waiting.attempts![1]!.human).toEqual(f.proof);
  let pending = decideArbitration(waiting, 'a', decision('compromise'));
  expect(pending.status).toBe('human');
  expect(pending.human).toBeNull();
  pending = humanArbitration(pending, true, f.proof);
  const failed = finishArbitration(pending, item, proof('FAIL'));
  waiting = reconsiderArbitration(failed, item.condition, f.proof);
  expect(waiting.attempts![2]).toMatchObject({
    review: proof('FAIL').review,
    working_check: f.proof,
  });
  const implementing = decideArbitration(waiting, 'a', decision());
  expect(finishArbitration(implementing, item, proof()).status).toBe('resolved');
  expect(implementing.attempts!.map((a) => a.decision!.dissent)).toEqual(
    Array(3).fill(['original FAIL remains']),
  );
});

it('counts substantive correction verdicts once and requires three consecutive owner failures', () => {
  let item = finding();
  expect(() => startArbitration('A', item, { kind: 'three-fail' }, 'a')).toThrow(
    'three-fail-unconfirmed',
  );
  for (const correction of ['one', 'two', 'three'])
    item = recordRoundVerdict(item, correction, 'architect', 'FAIL', f.proof);
  expect(recordRoundVerdict(item, 'one', 'architect', 'FAIL', f.proof)).toEqual(item);
  expect(() => recordRoundVerdict(item, 'one', 'architect', 'PASS', f.proof)).toThrow(
    'round-verdict-conflict',
  );
  expect(() =>
    recordRoundVerdict(item, 'one', 'architect', 'FAIL', { ...f.proof, locator: 'other' }),
  ).toThrow('round-verdict-conflict');
  expect(() =>
    recordRoundVerdict(item, 'one', 'architect', 'FAIL', { ...f.proof, hash: 'other' }),
  ).toThrow('round-verdict-conflict');
  item = recordRoundVerdict(item, 'three', 'devops', 'FAIL', f.proof);
  expect(startArbitration('A', item, { kind: 'three-fail' }, 'a').status).toBe('waiting');
  item = recordRoundVerdict(item, 'four', 'architect', 'PASS', f.proof);
  expect(() => startArbitration('A', item, { kind: 'three-fail' }, 'a')).toThrow(
    'three-fail-unconfirmed',
  );
  delete item.rounds[3]!.verdicts;
  expect(() => startArbitration('A', item, { kind: 'three-fail' }, 'a')).toThrow(
    'three-fail-unconfirmed',
  );
  expect(() => startArbitration('A', finding(), { ...trigger(), reviewer: 'devops' }, 'a')).toThrow(
    'contradiction-unconfirmed',
  );
});

it('keeps initial compromises pending for the human and retains all original failures and dissent', () => {
  const item = finding();
  const start = startArbitration('A', item, trigger(), 'a');
  expect(() => decideArbitration(start, 'other', decision())).toThrow('wrong-arbiter-answer');
  const pending = decideArbitration(start, 'a', decision('compromise'));
  expect(pending.status).toBe('human');
  expect(humanArbitration(pending, false, f.proof).status).toBe('blocked');
  const implementing = humanArbitration(pending, true, f.proof);
  expect(finishArbitration(implementing, item, proof()).status).toBe('resolved');
  expect(finishArbitration(implementing, item, proof('FAIL')).status).toBe('blocked');
  expect(() =>
    finishArbitration(implementing, item, { ...proof(), mandatory_defect: true }),
  ).toThrow('mandatory-defect-cannot-be-waived');
  expect(() => humanArbitration(start, true, f.proof)).toThrow('human-decision-not-pending');
  expect(() => decideArbitration(pending, 'a', decision())).toThrow('wrong-arbiter-answer');
  expect(() => finishArbitration(start, item, proof())).toThrow('wrong-arbitration-scope');
  expect(() => finishArbitration(implementing, { ...item, id: 'other' }, proof())).toThrow(
    'wrong-arbitration-scope',
  );
  expect(() =>
    finishArbitration(
      implementing,
      { ...item, original_fail: { ...f.proof, hash: 'other' } },
      proof(),
    ),
  ).toThrow('wrong-arbitration-scope');
  expect(() => finishArbitration(implementing, item, { ...proof(), condition: 'other' })).toThrow(
    'affected-review-required',
  );
  expect(() =>
    finishArbitration(implementing, item, {
      ...proof(),
      review: { ...proof().review, reviewer: 'devops' },
    }),
  ).toThrow('affected-review-required');
  expect(
    finishArbitration(implementing, item, { ...proof(), check_verdict: 'NOT RUN' }).status,
  ).toBe('blocked');
  const blocked = finishArbitration(decideArbitration(start, 'a', decision()), item, proof('FAIL'));
  expect(resumeArbitration(blocked, item.condition, f.proof).status).toBe('implementing');
  for (const a of [
    start,
    decideArbitration(start, 'a', decision('undecided')),
    humanArbitration(pending, false, f.proof),
  ])
    expect(() => resumeArbitration(a, item.condition, f.proof)).toThrow(
      'arbitration-needs-new-decision',
    );
  expect(() => resumeArbitration(blocked, 'wrong condition', f.proof)).toThrow(
    'arbitration-needs-new-decision',
  );
  let failed = item;
  for (const id of ['one', 'two', 'three'])
    failed = recordRoundVerdict(failed, id, 'architect', 'FAIL', f.proof);
  const compromise = decideArbitration(
    startArbitration('B', failed, { kind: 'three-fail' }, 'b'),
    'b',
    decision('compromise'),
  );
  const result = finishArbitration(compromise, failed, proof('FAIL'));
  expect(result).toMatchObject({
    status: 'resolved',
    exception_applied: true,
    original_fail: item.original_fail,
    decision: { dissent: ['original FAIL remains'] },
    review: { verdict: 'FAIL' },
  });
});

it('accumulates monotonic work and internal waits separately from external waits without inventing restart gaps', () => {
  for (const n of [0, -1, 3_600_001, NaN, 0.5])
    expect(() => createTiming('stage', n, 'cp')).toThrow('invalid-stage-estimate');
  let timing = createTiming('stage', 100, 'cp');
  const sample = (id: string, monotonic_ms: number, external = false, epoch = 'epoch') => ({
    id,
    epoch,
    monotonic_ms,
    external,
  });
  timing = sampleTiming(timing, sample('1', 1000));
  expect(sampleTiming(timing, sample('1', 1000))).toBe(timing);
  for (const s of [sample('1', 1001), sample('1', 1000, true), sample('1', 1000, false, 'new')])
    expect(() => sampleTiming(timing, s)).toThrow('time-sample-conflict');
  expect(() => sampleTiming(timing, sample('bad', -1))).toThrow('invalid-monotonic-time');
  expect(() => auditKey(timing, { kind: 'overrun' })).toThrow('audit-threshold-not-reached');
  timing = sampleTiming(timing, sample('2', 1200, true));
  timing = sampleTiming(timing, sample('3', 1600));
  expect(timing).toMatchObject({ elapsed_ms: 200, external_wait_ms: 400 });
  const claimed = claimAudit(timing, { kind: 'overrun' });
  expect(() => claimAudit(claimed, { kind: 'overrun' })).toThrow('audit-already-handled');
  expect(claimAudit(claimed, { kind: 'doubt', evidence_id: 'new-risk' }).audited).toHaveLength(2);
  const backwards = sampleTiming(timing, sample('4', 100));
  expect(backwards.elapsed_ms).toBeNull();
  expect(sampleTiming(backwards, sample('5', 150)).elapsed_ms).toBeNull();
  const restarted = sampleTiming(timing, sample('4', 100, true, 'restart'));
  expect(sampleTiming(restarted, sample('5', 150, true, 'restart')).external_wait_ms).toBeNull();
  expect(claimAudit(restarted, { kind: 'overrun' }).audited).toHaveLength(1);
  expect(() => claimAudit({ ...restarted, samples: [] }, { kind: 'overrun' })).toThrow(
    'audit-threshold-not-reached',
  );
  expect(claimAudit(backwards, { kind: 'overrun' }).audited).toHaveLength(1);
});

it('checks independent profiles, procedure load, identity and scoped blocking', () => {
  const valid = role('arbiter');
  confirmIndependent(valid, 'arbiter', []);
  expect(() => confirmIndependent(valid, 'arbiter', ['arbiter'])).toThrow(
    'independent-session-reused',
  );
  const cases: [IndependentRole, string][] = [
    [{ ...valid, run: { ...valid.run, loaded: null } }, 'independent-load-missing'],
    [{ ...valid, agent_type: 'auditor' }, 'wrong-independent-role'],
    [{ ...valid, session: { ...valid.session, workspace: 'wrong' } }, 'wrong-independent-role'],
    [{ ...valid, session: { ...valid.session, project_id: 'wrong' } }, 'wrong-independent-role'],
    [{ ...valid, session: { ...valid.session, id: 'wrong' } }, 'wrong-independent-role'],
    [{ ...valid, run: { ...valid.run, type: 'executor' } }, 'wrong-independent-role'],
    [
      { ...valid, run: { ...valid.run, spec: { ...valid.run.spec, role: 'auditor' } } },
      'wrong-independent-role',
    ],
    [
      { ...valid, run: { ...valid.run, spec: { ...valid.run.spec, fork_turns: 'all' } } },
      'wrong-independent-role',
    ],
    [{ ...valid, session: { ...valid.session, initial_turns: 1 } }, 'parent-history-inherited'],
  ];
  const missing = structuredClone(valid);
  missing.run.spec.procedures = missing.run.spec.procedures.filter((p) => p.id !== 'arbitration');
  missing.run.loaded!.procedures = missing.run.spec.procedures;
  cases.push([missing, 'independent-procedure-missing']);
  for (const [input, message] of cases)
    expect(() => confirmIndependent(input, 'arbiter', [])).toThrow(message);
  let state = emptySupervision();
  const advance = (action: SupervisionAction) => {
    state = applySupervision(state, action, [finding()], [], f.target);
  };
  advance({ kind: 'arbitrate', id: 'A', finding: 'F1', trigger: trigger(), role: valid });
  expect(supervisionBlockers(state)).toEqual(['arbitration:A']);
  expect(supervisionEvidence(state)).toContainEqual(f.proof);
  const suspended = {
    ...createExecution(
      'task',
      1,
      f.target,
      [{ id: 'validate', kind: 'check' as const, applicable: true, reason: 'code' }],
      true,
      'substantial',
    ),
    status: 'implementing' as const,
    supervision: state,
  };
  expect(() =>
    applyExecution(
      suspended,
      executionEvent(suspended, {
        type: 'REVIEW',
        target: f.target,
        selection: f.selection,
        baseline: {
          kind: 'real',
          scenario: 'test',
          evidence: f.proof,
          inputs: f.target.inputs,
          elapsed_ms: 0,
          exit_code: 0,
        },
        checks: [],
      }),
    ),
  ).toThrow('scope-blocked');
  expect(() => assertSupervisedScope(state, 'workflow')).toThrow('scope-blocked');
  assertSupervisedScope(state, 'independent');
  advance({ kind: 'decision', id: 'A', session: 'arbiter', decision: decision() });
  assertSupervisedScope(state, 'workflow');
  advance({ kind: 'review', id: 'A', proof: proof('FAIL') });
  advance({ kind: 'resume', id: 'A', condition: finding().condition, evidence: f.proof });
  advance({ kind: 'review', id: 'A', proof: proof() });
  expect(supervisionBlockers(state)).toEqual([]);
  expect(findingExcepted(state, finding(), f.target)).toBe(false);
  state.arbitrations[0]!.exception_applied = true;
  expect(findingExcepted(state, finding(), f.target)).toBe(true);
  expect(
    findingExcepted(state, finding(), {
      ...f.target,
      evidence_inputs: {
        ...f.target.inputs,
        inputs: [...f.target.inputs.inputs, f.proof],
      },
    }),
  ).toBe(false);
  expect(findingExcepted(state, { ...finding(), scope: 'other' }, f.target)).toBe(false);
  expect(findingExcepted(state, { ...finding(), id: 'other' }, f.target)).toBe(false);
  assertSupervisedScope(state, 'workflow');
});

it('persists audit direction once, sends only the card locator and suppresses the handled threshold', () => {
  let state = emptySupervision();
  const advance = (action: SupervisionAction) => {
    state = applySupervision(state, action, [finding()], [], f.target);
  };
  advance({ kind: 'stage', id: 'stage', estimate_ms: 10, checkpoint: 'cp' });
  expect(() => advance({ kind: 'stage', id: 'stage', estimate_ms: 10, checkpoint: 'cp' })).toThrow(
    'stage-already-exists',
  );
  for (const [id, time] of [
    ['1', 0],
    ['2', 20],
  ] as const)
    advance({
      kind: 'sample',
      stage: 'stage',
      sample: { id, epoch: 'process', monotonic_ms: time, external: false },
    });
  const card = {
    ref: f.proof,
    goal: 'Goal',
    criteria: ['criterion'],
    completed: [],
    open_findings: ['F1'],
    timing: state.stages[0]!,
    next_action: 'next observable result',
  };
  expect(auditBrief(card)).toBe(f.proof.locator);
  expect(() => auditBrief({ ...card, criteria: [] })).toThrow('audit-card-empty');
  const request = {
    kind: 'audit' as const,
    id: 'audit',
    stage: 'stage',
    trigger: { kind: 'overrun' as const },
    card,
    role: role('auditor'),
  };
  advance(request);
  expect(supervisionBlockers(state)).toEqual(['audit:audit']);
  expect(supervisionEvidence(state)).toContainEqual(f.proof);
  expect(() => assertSupervisedScope(state, 'any')).toThrow('audit-action-pending');
  expect(() => advance(request)).toThrow('audit-id-conflict');
  const answer = {
    direction: 'replace-approach' as const,
    reason: 'narrow implementation',
    next_result: 'confirmed check',
    evidence: f.proof,
  };
  expect(() =>
    advance({ kind: 'audit-apply', id: 'audit', checkpoint: 'new', evidence: f.proof }),
  ).toThrow('audit-not-actionable');
  expect(() => advance({ kind: 'audit-answer', id: 'audit', session: 'wrong', answer })).toThrow(
    'wrong-auditor-answer',
  );
  advance({ kind: 'audit-answer', id: 'audit', session: 'auditor', answer });
  expect(() => advance({ kind: 'audit-answer', id: 'audit', session: 'auditor', answer })).toThrow(
    'wrong-auditor-answer',
  );
  expect(() =>
    advance({ kind: 'audit-apply', id: 'audit', checkpoint: 'cp', evidence: f.proof }),
  ).toThrow('audit-checkpoint-unchanged');
  advance({ kind: 'audit-apply', id: 'audit', checkpoint: 'next', evidence: f.proof });
  expect(supervisionBlockers(state)).toEqual([]);
  expect(state.stages[0]!.elapsed_ms).toBe(20);
  expect(supervisionEvidence(state)).toContainEqual(f.proof);
  expect(() =>
    advance({
      ...request,
      id: 'another',
      role: role('auditor', 'auditor-2'),
      card: { ...card, timing: state.stages[0]! },
    }),
  ).toThrow('audit-already-handled');
  const execution = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
    true,
    'substantial',
  );
  const run = { ...execution, supervision: state };
  validateExecution(run);
  const changed = applyExecution(
    execution,
    executionEvent(execution, {
      type: 'SUPERVISE',
      action: { kind: 'stage', id: 's', estimate_ms: 10, checkpoint: 'cp' },
    }),
  );
  expect(changed.supervision!.stages).toHaveLength(1);
  expect(executionBlockers({ ...run, findings: [finding()] })).toContain('open-blocker');
});

it('blocks duplicate arbitration and preserves an explicit human decision in the checkpoint', () => {
  let state = emptySupervision();
  const item = finding();
  const advance = (action: SupervisionAction) => {
    state = applySupervision(state, action, [item], [], f.target);
  };
  const request = {
    kind: 'arbitrate' as const,
    id: 'A',
    finding: 'F1',
    trigger: trigger(),
    role: role('arbiter'),
  };
  advance(request);
  expect(() => advance(request)).toThrow('arbitration-already-open');
  expect(() => advance({ ...request, id: 'B' })).toThrow('arbitration-already-open');
  advance({ kind: 'decision', id: 'A', session: 'arbiter', decision: decision('compromise') });
  advance({ kind: 'human', id: 'A', accepted: true, evidence: f.proof });
  advance({ kind: 'review', id: 'A', proof: proof() });
  expect(supervisionEvidence(state)).toContainEqual(f.proof);
  expect(() => advance({ ...request, id: 'B' })).toThrow('independent-session-reused');
  const second = role('arbiter', 'arbiter-2');
  advance({ ...request, id: 'B', role: second });
  expect(() => advance({ ...request, id: 'C', finding: 'missing' })).toThrow(
    'arbitration-finding-missing',
  );
  const run = {
    ...createExecution(
      'task',
      1,
      f.target,
      [{ id: 'validate', kind: 'check' as const, applicable: true, reason: 'code' }],
      true,
      'substantial',
    ),
    supervision: state,
  };
  validateExecution(run);
  state.arbitrations[0]!.decision!.outcome = 'direction';
  state.stages.push({
    ...createTiming('unknown', 10, 'cp'),
    elapsed_ms: null,
    external_wait_ms: null,
  });
  validateExecution(run);
  expect(findingExcepted(state, item, { ...f.target, diff: { ...f.proof, hash: 'changed' } })).toBe(
    false,
  );
  state.arbitrations[0]!.decision!.outcome = 'compromise';
  expect(
    findingExcepted(state, item, { ...f.target, inputs: { ...f.target.inputs, complete: false } }),
  ).toBe(false);
});

it('readies independent roles from their own procedure sets without requiring another role bootstrap', () => {
  for (const kind of ['arbiter', 'auditor'] as const) {
    const original = role(kind);
    const spec = {
      ...original.run.spec,
      procedures: original.run.spec.procedures.filter(
        (p) => p.id === 'evidence' || p.id === (kind === 'arbiter' ? 'arbitration' : 'audit'),
      ),
    };
    let run = loadedRun(startLocalRun(spec, 1));
    run = applyLocalEvent(run, localEvent(run, { type: 'READY' }));
    expect(run.status).toBe('ready');
    confirmIndependent({ ...original, run }, kind, []);
  }
});

function progressCard() {
  return {
    ref: f.proof,
    goal: 'Finish the original task',
    criteria: ['Observable result'],
    completed: [f.proof],
    open_findings: ['F1'],
    timing: null,
    progress: {
      schema_version: 1 as const,
      task_id: 'task',
      scope: f.target.scope,
      goal_source: f.target.inputs.inputs[0]!,
      checkpoint: 'before-audit',
      evidence: f.proof,
      inputs: f.target.inputs,
      estimate_ms: null,
      elapsed_ms: null,
      external_wait_ms: null,
    },
    next_action: 'Produce the original result',
  };
}

it('audits a completed preparation chain without any stage or invented estimate and preserves FAIL', () => {
  const card = progressCard();
  let state = emptySupervision();
  const legacy = { ...state };
  delete legacy.reservations;
  expect(() =>
    applySupervision(
      legacy,
      {
        kind: 'launch-audit',
        id: 'missing',
        operation: 'launch-missing',
        parent: 'audit-parent',
      },
      [],
      [],
      f.target,
    ),
  ).toThrow('audit-reservation-not-open');
  const apply = (action: SupervisionAction) => {
    state = applySupervision(state, action, [finding()], [], f.target);
    return state;
  };
  apply({ kind: 'reserve-audit', id: 'progress', card });
  expect(state.schema_version).toBe(2);
  expect(state.stages).toEqual([]);
  expect(supervisionBlockers(state)).toContain('audit-reservation:progress');
  expect(() => assertSupervisedScope(state, f.target.scope)).toThrow('audit-action-pending');
  expect(() => apply({ kind: 'reserve-audit', id: 'again', card })).toThrow(
    'audit-already-claimed',
  );
  apply({
    kind: 'launch-audit',
    id: 'progress',
    operation: 'launch-progress',
    parent: 'audit-parent',
  });
  expect(() =>
    apply({
      kind: 'launch-audit',
      id: 'progress',
      operation: 'launch-progress',
      parent: 'audit-parent',
    }),
  ).toThrow('audit-launch-already-claimed');
  const audit: SupervisionAction = {
    kind: 'audit',
    id: 'progress',
    stage: null,
    trigger: { kind: 'no-progress', evidence_id: card.progress.evidence.hash },
    card,
    role: role('auditor'),
  };
  expect(() => apply({ ...audit, trigger: { kind: 'overrun' } })).toThrow(
    'wrong-progress-audit-trigger',
  );
  apply(audit);
  expect(state.audits[0]!.operation).toBe('launch-progress');
  expect(state.reservations).toEqual([]);
  expect(() =>
    apply({ kind: 'audit-apply', id: 'progress', checkpoint: 'next', evidence: f.proof }),
  ).toThrow('audit-not-actionable');
  apply({
    kind: 'audit-answer',
    id: 'progress',
    session: 'auditor',
    answer: {
      direction: 'replace-approach',
      reason: 'Preparation has not produced the task result',
      next_result: 'Observable implementation',
      evidence: f.proof,
    },
  });
  expect(() =>
    apply({
      kind: 'audit-apply',
      id: 'progress',
      checkpoint: card.progress.checkpoint,
      evidence: f.proof,
    }),
  ).toThrow('audit-checkpoint-unchanged');
  apply({ kind: 'audit-apply', id: 'progress', checkpoint: 'after-audit', evidence: f.proof });
  expect(supervisionBlockers(state)).toEqual([]);
  expect(state.stages).toEqual([]);
  const execution = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'required' }],
    false,
    'substantial',
  );
  execution.supervision = state;
  validateExecution(execution);
  expect(() =>
    validateExecution({ ...execution, supervision: { ...state, schema_version: 1 } }),
  ).toThrow('unsupported-supervision-version');
});

it.each(['not-started', 'idle', 'terminal'] as const)(
  'settles %s without applying a stale answer and keeps the old attempt',
  (outcome) => {
    const card = progressCard();
    let state = applySupervision(
      emptySupervision(),
      { kind: 'reserve-audit', id: 'old', card },
      [],
      [],
      f.target,
    );
    state = applySupervision(
      state,
      { kind: 'launch-audit', id: 'old', operation: 'launch-old', parent: 'audit-parent' },
      [],
      [],
      f.target,
    );
    const observation =
      outcome === 'not-started'
        ? { outcome, operation: 'launch-old', session: null, receipt: f.proof }
        : outcome === 'idle'
          ? { outcome, operation: 'launch-old', session: role('auditor').session, receipt: f.proof }
          : {
              outcome,
              operation: 'launch-old',
              session: role('auditor').session,
              receipt: f.proof,
              turn: 'failed-turn',
              status: 'failed' as const,
            };
    state = applySupervision(
      state,
      { kind: 'settle-audit', id: 'old', observation },
      [],
      [],
      f.target,
    );
    expect(state.reservations![0]!.settled).toEqual(observation);
    expect(state.audits).toEqual([]);
    expect(supervisionEvidence(state)).toContainEqual(f.proof);
    expect(() =>
      applySupervision(
        state,
        {
          kind: 'reserve-audit',
          id: 'same-proof',
          card: { ...card, progress: { ...card.progress, checkpoint: 'new' } },
        },
        [],
        [],
        f.target,
      ),
    ).toThrow('audit-already-claimed');
    const fresh = {
      ...card,
      progress: {
        ...card.progress,
        checkpoint: 'new',
        evidence: { ...f.proof, hash: 'new-proof' },
      },
    };
    state = applySupervision(
      state,
      { kind: 'reserve-audit', id: 'fresh', card: fresh },
      [],
      [],
      f.target,
    );
    expect(state.reservations).toHaveLength(2);
    const execution = createExecution(
      'task',
      1,
      f.target,
      [{ id: 'validate', kind: 'check', applicable: true, reason: 'required' }],
      false,
      'substantial',
    );
    execution.supervision = state;
    validateExecution(execution);
  },
);

it('retires an unlaunched reservation and rejects incomplete progress evidence and stale binding', () => {
  const card = progressCard();
  const apply = (action: SupervisionAction) =>
    applySupervision(emptySupervision(), action, [finding()], [], f.target);
  expect(() =>
    apply({ kind: 'reserve-audit', id: 'x', card: { ...card, open_findings: [] } }),
  ).toThrow('audit-card-stale');
  for (const delta of [
    { schema_version: 99 },
    { estimate_ms: 1 },
    { inputs: { ...card.progress.inputs, complete: false } },
    { goal_source: { locator: 'absent', hash: 'absent' } },
  ])
    expect(() =>
      apply({
        kind: 'reserve-audit',
        id: 'x',
        card: { ...card, progress: { ...card.progress, ...delta } },
      } as SupervisionAction),
    ).toThrow();
  let state = apply({ kind: 'reserve-audit', id: 'x', card });
  expect(() =>
    applySupervision(
      state,
      {
        kind: 'audit',
        id: 'x',
        stage: null,
        trigger: { kind: 'no-progress', evidence_id: card.progress.evidence.hash },
        card,
        role: role('auditor'),
      },
      [],
      [],
      f.target,
    ),
  ).toThrow('audit-reservation-mismatch');
  state = applySupervision(
    state,
    {
      kind: 'settle-audit',
      id: 'x',
      observation: { outcome: 'not-started', operation: 'x', session: null, receipt: f.proof },
    },
    [],
    [],
    f.target,
  );
  expect(state.reservations![0]!.settled?.session).toBeNull();
});

it('keeps completed audit keys and launch operations reserved against renamed retries', () => {
  let state = emptySupervision();
  const card = progressCard();
  const apply = (action: SupervisionAction) => {
    state = applySupervision(state, action, [], [], f.target);
  };
  const audit: SupervisionAction = {
    kind: 'audit',
    id: 'first',
    stage: null,
    trigger: { kind: 'no-progress', evidence_id: card.progress.evidence.hash },
    card,
    role: role('auditor'),
  };
  expect(() => apply(audit)).toThrow('audit-reservation-mismatch');
  apply({ kind: 'reserve-audit', id: 'first', card });
  apply({ kind: 'launch-audit', id: 'first', operation: 'one-operation', parent: 'audit-parent' });
  apply(audit);
  expect(() => apply({ kind: 'reserve-audit', id: 'renamed', card })).toThrow(
    'audit-action-pending',
  );
  apply({
    kind: 'audit-answer',
    id: 'first',
    session: 'auditor',
    answer: {
      direction: 'continue',
      reason: 'Proceed with the original goal',
      next_result: 'Observable result',
      evidence: f.proof,
    },
  });
  apply({ kind: 'audit-apply', id: 'first', checkpoint: 'applied', evidence: f.proof });
  expect(() => apply({ kind: 'reserve-audit', id: 'first', card })).toThrow('audit-id-conflict');
  expect(() => apply({ kind: 'reserve-audit', id: 'renamed', card })).toThrow(
    'audit-already-claimed',
  );
  const fresh = {
    ...card,
    progress: {
      ...card.progress,
      checkpoint: 'next',
      evidence: { locator: 'next-proof', hash: 'new-proof' },
    },
  };
  apply({ kind: 'reserve-audit', id: 'new-proof', card: fresh });
  expect(() =>
    apply({
      kind: 'launch-audit',
      id: 'new-proof',
      operation: 'one-operation',
      parent: 'audit-parent',
    }),
  ).toThrow('audit-launch-already-claimed');
});
