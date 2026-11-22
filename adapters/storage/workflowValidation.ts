import { progressAuditKey } from '../../core/progressAudit.js';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import { createCouncil } from '../../core/council.js';
import type { Council, ReviewAnswer } from '../../core/council.js';
import { createExecution } from '../../core/execution.js';
import type { Execution } from '../../core/execution.js';
import { validateDataQuery } from '../../core/dataRoute.js';
import type { DataReading } from '../../core/dataRoute.js';
import type { InputManifest } from '../../core/evidence.js';
import { targetEvidenceInputs } from '../../core/evidence.js';
import type { ReviewTarget } from '../../core/council.js';
import type { WorkflowCheckpoint } from '../../ports/workflowJournal.js';
import { validateManifest } from './evidenceRecords.js';
import { confirmIndependent, auditBrief } from '../../core/supervision.js';
import type { Supervision } from '../../core/supervision.js';
import type { ArbitrationAttempt } from '../../core/arbitration.js';
import { createTiming } from '../../core/stageTiming.js';
import { validateLocalAdmission } from '../../core/localPlanning.js';
import { coderOwnsSource, validateCoderRun } from '../../core/coder.js';
import type { CoderRun } from '../../core/coder.js';

function array(value: unknown): unknown[] {
  requireWorkflow(Array.isArray(value), 'invalid-workflow-array');
  return value;
}
function archive(value: unknown) {
  requireWorkflow(/^[a-f0-9]{64}$/u.test(textField(object(value).hash)), 'invalid-history-archive');
}
function integer(value: unknown, minimum: number) {
  requireWorkflow(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum,
    'invalid-workflow-integer',
  );
}
function choice(value: unknown, values: unknown[]) {
  requireWorkflow(values.includes(value), 'invalid-workflow-choice');
}
function ref(value: unknown) {
  const input = object(value);
  textField(input.locator);
  textField(input.hash);
}
function refs(value: unknown) {
  array(value).forEach(ref);
}
function manifest(value: unknown) {
  validateManifest(value as InputManifest);
}
function target(value: unknown) {
  const input = object(value);
  textField(input.scope);
  textField(input.base);
  ref(input.diff);
  manifest(input.inputs);
  if (input.evidence_inputs !== undefined) manifest(input.evidence_inputs);
  targetEvidenceInputs(input as unknown as ReviewTarget);
}
function answer(value: unknown) {
  const input = object(value) as unknown as ReviewAnswer;
  choice(input.verdict, ['PASS', 'FAIL', 'NOT RUN', 'N/A']);
  choice(input.coverage, ['complete', 'partial']);
  textField(input.scope);
  target(input.target);
  refs(input.sources);
  ref(input.evidence);
  array(input.limitations).forEach(textField);
  array(input.findings).forEach(finding);
}
function finding(value: unknown) {
  const input = object(value);
  [input.id, input.scope, input.condition, input.reason].forEach(textField);
  choice(input.blocking, [true, false]);
  if (input.waivable !== undefined) choice(input.waivable, [true, false]);
  refs(input.sources);
}
function council(value: unknown) {
  const input = object(value) as unknown as Council;
  choice(input.phase, ['planning', 'acceptance']);
  target(input.target);
  createCouncil(input.phase, input.selection, input.target, input.configuration);
  for (const rule of Object.values(input.selection)) {
    refs(rule.requirements);
    manifest(rule.inputs);
  }
  for (const raw of Object.values(object(input.advisers))) {
    const adviser = object(raw);
    choice(adviser.status, ['running', 'answered']);
    const run = object(adviser.run);
    requireWorkflow(run.schema_version === 1, 'unsupported-adviser-version');
    textField(object(run.spec).session_id);
    requireWorkflow(
      (adviser.status === 'answered') === (adviser.answer !== null),
      'invalid-adviser-answer',
    );
    if (adviser.answer !== null) answer(adviser.answer);
    if (adviser.reviewed !== null) {
      const reviewed = object(adviser.reviewed);
      refs(reviewed.requirements);
      manifest(reviewed.inputs);
    }
  }
  for (const raw of array(input.history)) {
    const entry = object(raw);
    textField(entry.role);
    textField(entry.session);
    if (entry.archive === undefined && entry.retained !== true) answer(entry.answer);
    else {
      if (entry.retained !== true) archive(entry.archive);
      const summary = object(entry.answer);
      choice(summary.verdict, ['PASS', 'FAIL', 'NOT RUN', 'N/A']);
      choice(summary.coverage, ['complete', 'partial']);
      ref(summary.evidence);
      array(summary.findings).forEach(finding);
      if (summary.binding !== undefined) textField(object(summary.binding).answer_turn);
    }
  }
  if (input.review_turns !== undefined)
    for (const entry of array(input.review_turns)) {
      const turn = object(entry);
      [turn.role, turn.session, turn.turn].forEach(textField);
    }
}
function children(value: unknown) {
  for (const raw of array(value)) {
    const child = object(raw);
    textField(child.scope);
    textField(child.criterion);
    ref(child.evidence);
    manifest(child.inputs);
    choice(child.valid, [true, false]);
  }
}
function arbitrationAttempt(
  a: Pick<ArbitrationAttempt, 'decision' | 'human' | 'implementation' | 'review' | 'working_check'>,
) {
  if (a.decision !== null) {
    choice(a.decision.outcome, ['direction', 'compromise', 'undecided']);
    textField(a.decision.reason);
    ref(a.decision.evidence);
    array(a.decision.dissent).forEach(textField);
    if (a.decision.outcome === 'compromise') {
      textField(a.decision.exception);
      textField(a.decision.residual_risk);
    }
  }
  for (const value of [a.human, a.implementation]) if (value !== null) ref(value);
  if (a.review !== null) {
    textField(a.review.reviewer);
    choice(a.review.verdict, ['PASS', 'FAIL']);
    ref(a.review.evidence);
  }
  if (a.working_check !== null) ref(a.working_check);
}
function supervision(value: unknown) {
  const input = object(value) as unknown as Supervision;
  requireWorkflow([1, 2].includes(input.schema_version), 'unsupported-supervision-version');
  requireWorkflow(
    input.schema_version === 2 ||
      (input.reservations === undefined && input.audits.every((a) => a.card.timing !== null)),
    'unsupported-supervision-version',
  );
  for (const a of input.reservations ?? []) {
    [a.id, a.key].forEach(textField);
    auditBrief(a.card);
    requireWorkflow(
      a.card.timing === null && a.key === progressAuditKey(a.card.progress),
      'audit-reservation-mismatch',
    );
    if (a.operation !== null) {
      textField(a.operation);
      textField(a.parent);
    } else requireWorkflow(a.parent === null, 'audit-parent-mismatch');
    if (a.settled !== null) {
      ref(a.settled.receipt);
      requireWorkflow(a.settled.operation === (a.operation ?? a.id), 'audit-operation-mismatch');
      choice(a.settled.outcome, ['not-started', 'idle', 'terminal']);
      if (a.settled.outcome === 'not-started')
        requireWorkflow(a.settled.session === null, 'audit-attempt-identity-mismatch');
      else {
        textField(a.settled.session.id);
        requireWorkflow(
          a.settled.session.agent_role === 'auditor' &&
            a.settled.session.read_only &&
            !a.settled.session.network,
          'audit-attempt-profile-unconfirmed',
        );
        if (a.settled.outcome === 'terminal') {
          textField(a.settled.turn);
          choice(a.settled.status, ['completed', 'failed', 'interrupted']);
        }
      }
    }
  }
  for (const stage of array(input.stages)) {
    const s = object(stage);
    createTiming(textField(s.id), s.estimate_ms as number, textField(s.checkpoint));
    for (const elapsed of [s.elapsed_ms, s.external_wait_ms])
      if (elapsed !== null)
        requireWorkflow(
          typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0,
          'invalid-elapsed-time',
        );
    array(s.audited).forEach(textField);
    for (const sample of array(s.samples)) {
      const p = object(sample);
      [p.id, p.epoch].forEach(textField);
      requireWorkflow(
        typeof p.monotonic_ms === 'number' &&
          Number.isFinite(p.monotonic_ms) &&
          p.monotonic_ms >= 0,
        'invalid-monotonic-time',
      );
      choice(p.external, [true, false]);
    }
  }
  const sessions: string[] = [];
  for (const role of input.arbiters) {
    confirmIndependent(role, 'arbiter', sessions);
    sessions.push(role.session.id);
  }
  for (const a of input.arbitrations) {
    [a.id, a.finding_id, a.scope, a.session_id, a.resume_condition].forEach(textField);
    choice(a.status, ['waiting', 'blocked', 'human', 'implementing', 'resolved']);
    choice(a.trigger.kind, ['initial-contradiction', 'three-fail']);
    if (a.trigger.kind === 'initial-contradiction') {
      ref(a.trigger.confirmation);
      textField(a.trigger.reviewer);
    }
    ref(a.original_fail);
    refs(a.sources);
    requireWorkflow(sessions.includes(a.session_id), 'arbiter-proof-missing');
    choice(a.exception_applied, [true, false]);
    if (a.accepted_target !== null) target(a.accepted_target);
    requireWorkflow(!a.exception_applied || a.accepted_target !== null, 'exception-target-missing');
    arbitrationAttempt(a);
    if (a.attempts !== undefined)
      for (const value of array(a.attempts)) {
        const attempt = object(value) as unknown as ArbitrationAttempt;
        textField(attempt.condition);
        requireWorkflow(attempt.condition === a.resume_condition, 'arbitration-condition-mismatch');
        ref(attempt.evidence);
        requireWorkflow(attempt.decision !== null, 'arbitration-decision-missing');
        arbitrationAttempt(attempt);
      }
    requireWorkflow(
      a.status !== 'resolved' ||
        (a.decision !== null && a.implementation !== null && a.review !== null),
      'arbitration-resolution-incomplete',
    );
  }
  for (const a of input.audits) {
    [a.id, a.key].forEach(textField);
    auditBrief(a.card);
    refs(a.card.completed);
    array(a.card.open_findings).forEach(textField);
    confirmIndependent(a.role, 'auditor', sessions);
    sessions.push(a.role.session.id);
    if (a.answer !== null) {
      choice(a.answer.direction, [
        'continue',
        'replace-approach',
        'replace-executor',
        'reconsider-constraints',
      ]);
      [a.answer.reason, a.answer.next_result].forEach(textField);
      ref(a.answer.evidence);
    }
    if (a.applied !== null) {
      requireWorkflow(a.answer !== null, 'audit-answer-missing');
      textField(a.applied.checkpoint);
      ref(a.applied.evidence);
    }
  }
}
export function validateExecution(value: unknown): asserts value is Execution {
  const input = object(value) as unknown as Execution;
  requireWorkflow([2, 3].includes(input.schema_version), 'unsupported-execution-version');
  requireWorkflow(
    input.route !== 'local' || input.schema_version === 3,
    'unsupported-execution-version',
  );
  integer(input.revision, 0);
  integer(input.generation, 1);
  if (input.requirements_revision !== undefined) integer(input.requirements_revision, 0);
  if (input.supervision !== undefined) supervision(input.supervision);
  choice(input.status, ['planning', 'implementing', 'review', 'done']);
  choice(input.route, ['substantial', 'mechanical', 'local']);
  choice(input.code, [true, false]);
  target(input.target);
  if (input.local !== undefined) {
    requireWorkflow(input.schema_version === 3, 'unsupported-execution-version');
    validateLocalAdmission(input.local, { ...input.target, inputs: input.local.inputs });
  }
  if (input.coder_reservations !== undefined) {
    requireWorkflow(input.schema_version === 3, 'unsupported-execution-version');
    array(input.coder_reservations).forEach(textField);
  }
  requireWorkflow(
    input.route !== 'local' || input.status === 'planning' || input.local !== undefined,
    'local-plan-required',
  );
  for (const raw of array(input.gates)) {
    const gate = object(raw);
    choice(gate.kind, ['check', 'human']);
    choice(gate.applicable, [true, false]);
  }
  createExecution(
    input.task_id,
    input.generation,
    input.target,
    input.gates,
    input.code,
    input.route,
  );
  for (const value of [input.planning, input.acceptance]) if (value !== null) council(value);
  Object.values(object(input.reviewer_sessions)).forEach(textField);
  for (const raw of array(input.checks)) {
    const check = object(raw);
    textField(check.id);
    textField(check.reason);
    choice(check.verdict, ['PASS', 'FAIL', 'NOT RUN', 'N/A']);
    ref(check.evidence);
    manifest(check.inputs);
  }
  if (input.baseline !== null) {
    const baseline = object(input.baseline);
    choice(baseline.kind, ['real', 'fixture']);
    textField(baseline.scenario);
    ref(baseline.evidence);
    manifest(baseline.inputs);
    requireWorkflow(
      typeof baseline.elapsed_ms === 'number' &&
        Number.isFinite(baseline.elapsed_ms) &&
        baseline.elapsed_ms >= 0,
      'invalid-baseline-time',
    );
    integer(baseline.exit_code, 0);
  }
  if (input.mechanical !== null) {
    const proof = object(input.mechanical);
    manifest(proof.inputs);
    [proof.accepted, proof.observed, proof.delta, proof.expected_delta].forEach(ref);
    refs(proof.links);
    refs(proof.expected_links);
    choice(proof.semantic_delta, [true, false]);
    choice(proof.applicability, ['applicable', 'changed', 'unknown']);
  }
  for (const raw of array(input.findings)) {
    finding(raw);
    const entry = object(raw);
    textField(entry.owner);
    ref(entry.original_fail);
    for (const rawRound of array(entry.rounds)) {
      const round = object(rawRound);
      textField(round.correction_id);
      refs(round.evidence);
      array(round.reviewers).forEach(textField);
      if (round.verdicts !== undefined)
        for (const rawVerdict of array(round.verdicts)) {
          const verdict = object(rawVerdict);
          textField(verdict.reviewer);
          choice(verdict.verdict, ['PASS', 'FAIL']);
          ref(verdict.evidence);
        }
    }
    if (entry.resolution !== null) {
      const resolution = object(entry.resolution);
      textField(resolution.condition);
      textField(resolution.reviewer);
      ref(resolution.evidence);
    }
  }
  children(input.child_results);
  choice(input.compromise, ['none', 'pending', 'accepted']);
  if (input.result !== null) {
    const result = object(input.result);
    textField(result.scope);
    target(result.target);
    refs(result.evidence);
    children(result.child_results);
    array(result.limitations).forEach(textField);
    textField(result.summary);
  }
  requireWorkflow(input.status !== 'done' || input.result !== null, 'done-result-missing');
  if (input.history_format !== undefined) choice(input.history_format, [1]);
  for (const raw of array(input.history)) {
    const event = object(raw);
    textField(event.id);
    if (event.dependencies !== undefined)
      for (const hash of array(event.dependencies)) archive({ hash });
    if (event.fingerprint !== undefined) {
      requireWorkflow(input.history_format === 1, 'invalid-retained-event');
      archive({ hash: event.fingerprint });
      requireWorkflow(
        event.payload === '' && event.archive === undefined && event.dependencies === undefined,
        'invalid-retained-event',
      );
      if (event.expected_revision !== undefined) integer(event.expected_revision, 0);
      if (event.generation !== undefined) integer(event.generation, 1);
      if (event.type !== undefined) textField(event.type);
    } else if (event.archive === undefined) textField(event.payload);
    else {
      requireWorkflow(event.payload === '', 'invalid-archived-event');
      archive(event.archive);
    }
  }
}
export function validateCheckpoint(value: unknown): asserts value is WorkflowCheckpoint {
  const input = object(value);
  requireWorkflow([1, 2].includes(input.schema_version as number), 'unsupported-workflow-version');
  requireWorkflow(
    input.schema_version !== 2 || input.format_backup !== undefined,
    'unsupported-workflow-version',
  );
  if (input.schema_version === 2) ref(input.format_backup);
  requireWorkflow(
    (input.execution as Execution | null)?.schema_version !== 3 || input.schema_version === 2,
    'unsupported-workflow-version',
  );
  integer(input.revision, 0);
  if (input.execution !== null) validateExecution(input.execution);
  if (input.coders !== undefined) {
    requireWorkflow(input.schema_version === 2, 'unsupported-workflow-version');
    const coders = Object.entries(object(input.coders));
    for (const [id, value] of coders) {
      const run = value as CoderRun;
      requireWorkflow(run.brief.id === id, 'coder-identity-mismatch');
      validateCoderRun(run);
    }
    const active = coders
      .map(([, value]) => value as CoderRun)
      .filter(coderOwnsSource)
      .map((run) => run.brief.id)
      .sort();
    const execution = input.execution as Execution | null;
    requireWorkflow(
      execution !== null &&
        JSON.stringify(execution.coder_reservations?.slice().sort()) === JSON.stringify(active),
      'coder-reservations-mismatch',
    );
  }
  if ((input.execution as Execution | null)?.supervision?.schema_version === 2)
    ref(input.supervision_backup);
  for (const [id, raw] of Object.entries(object(input.readings))) {
    const reading = object(raw) as unknown as DataReading;
    requireWorkflow(reading.id === id, 'wrong-reading-id');
    validateDataQuery(reading.query);
    integer(reading.creations, 1);
    choice(reading.phase, ['reserved', 'loading', 'ready', 'sending', 'running', 'answered']);
    [reading.profile.model, reading.profile.effort, reading.profile.reason].forEach(textField);
    if (reading.session !== null) {
      const session = object(reading.session);
      [session.id, session.model, session.effort, session.workspace, session.project_id].forEach(
        textField,
      );
      choice(session.read_only, [true, false]);
      choice(session.network, [true, false]);
      ref(session.receipt);
    }
    if (reading.load !== null) ref(reading.load);
    if (reading.turn_id !== null) textField(reading.turn_id);
    if (reading.send_id !== undefined) textField(reading.send_id);
    for (const rawAnswer of array(reading.answers)) {
      const result = object(rawAnswer);
      choice(result.outcome, ['PASS', 'FAIL', 'NOT RUN']);
      choice(result.coverage, ['complete', 'partial']);
      array(result.scope).forEach(textField);
      refs(result.sources);
      ref(result.evidence);
      textField(result.content);
      array(result.limitations).forEach(textField);
      requireWorkflow(
        result.continuation === null || typeof result.continuation === 'string',
        'invalid-data-continuation',
      );
    }
    if (reading.restart !== null) {
      const restart = object(reading.restart);
      textField(restart.previous_id);
      ref(restart.checkpoint);
    }
  }
}
