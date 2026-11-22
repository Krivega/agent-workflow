import { requireLoadedProcedures } from './localRun.js';
import { sameValue } from './equality.js';
import { sameRefs, sameTarget } from './council.js';
import type { ReviewTarget } from './council.js';
import { compareInputs, targetEvidenceInputs } from './evidence.js';
import { requireWorkflow, textField } from './connection.js';
import { assertRunAction, confirmLoad } from './localRun.js';
import type { InputRef, LocalRun } from './localRun.js';
import { confirmSession } from './dataRoute.js';
import type { AgentSession } from './dataRoute.js';
import type { Finding } from './findings.js';
import {
  decideArbitration,
  finishArbitration,
  humanArbitration,
  reconsiderArbitration,
  resumeArbitration,
  startArbitration,
} from './arbitration.js';
import type { Arbitration, ArbitrationTrigger } from './arbitration.js';
import { auditKey, claimAudit, createTiming, sampleTiming } from './stageTiming.js';
import type { AuditTrigger, StageTiming } from './stageTiming.js';
import { progressAuditKey } from './progressAudit.js';
import type { ProgressAudit, SettledAuditAttempt } from './progressAudit.js';

export interface IndependentRole {
  run: LocalRun;
  session: AgentSession;
  agent_type: 'arbiter' | 'auditor';
  type_receipt: InputRef;
}
interface AuditCardBase {
  ref: InputRef;
  goal: string;
  criteria: string[];
  completed: InputRef[];
  open_findings: string[];
  next_action: string;
}
export type StageAuditCard = AuditCardBase & { timing: StageTiming; progress?: never };
export type ProgressAuditCard = AuditCardBase & { timing: null; progress: ProgressAudit };
export type AuditCard = StageAuditCard | ProgressAuditCard;
export interface AuditReservation {
  id: string;
  key: string;
  card: ProgressAuditCard;
  operation: string | null;
  parent: string | null;
  settled: SettledAuditAttempt | null;
}
export interface Audit {
  id: string;
  key: string;
  card: AuditCard;
  role: IndependentRole;
  answer: {
    direction: 'continue' | 'replace-approach' | 'replace-executor' | 'reconsider-constraints';
    reason: string;
    next_result: string;
    evidence: InputRef;
  } | null;
  operation?: string;
  applied: { checkpoint: string; evidence: InputRef } | null;
}
export interface Supervision {
  schema_version: 1 | 2;
  reservations?: AuditReservation[];
  stages: StageTiming[];
  arbitrations: Arbitration[];
  arbiters: IndependentRole[];
  audits: Audit[];
}
export type SupervisionAction =
  | { kind: 'stage'; id: string; estimate_ms: number; checkpoint: string }
  | { kind: 'sample'; stage: string; sample: StageTiming['samples'][number] }
  | {
      kind: 'arbitrate';
      id: string;
      finding: string;
      trigger: ArbitrationTrigger;
      role: IndependentRole;
    }
  | {
      kind: 'decision';
      id: string;
      session: string;
      decision: NonNullable<Arbitration['decision']>;
    }
  | { kind: 'human'; id: string; accepted: boolean; evidence: InputRef }
  | { kind: 'resume'; id: string; condition: string; evidence: InputRef }
  | { kind: 'reconsider'; id: string; condition: string; evidence: InputRef }
  | { kind: 'review'; id: string; proof: Parameters<typeof finishArbitration>[2] }
  | {
      kind: 'audit';
      id: string;
      stage: string | null;
      trigger: AuditTrigger;
      card: AuditCard;
      role: IndependentRole;
    }
  | { kind: 'reserve-audit'; id: string; card: ProgressAuditCard }
  | { kind: 'launch-audit'; id: string; operation: string; parent: string }
  | { kind: 'settle-audit'; id: string; observation: SettledAuditAttempt }
  | { kind: 'audit-answer'; id: string; session: string; answer: NonNullable<Audit['answer']> }
  | { kind: 'audit-apply'; id: string; checkpoint: string; evidence: InputRef };

export function emptySupervision(): Supervision {
  return { schema_version: 1, stages: [], arbitrations: [], arbiters: [], audits: [] };
}
export function supervisionEvidence(state: Supervision): InputRef[] {
  return [
    ...state.arbiters.flatMap((role) => [role.session.receipt, role.type_receipt]),
    ...state.arbitrations.flatMap((a) => [
      a.original_fail,
      a.decision?.evidence,
      a.human,
      a.implementation,
      a.review?.evidence,
      a.working_check,
      ...(a.attempts ?? []).flatMap((attempt) => [
        attempt.evidence,
        attempt.decision?.evidence,
        attempt.human,
        attempt.implementation,
        attempt.review?.evidence,
        attempt.working_check,
      ]),
    ]),
    ...(state.reservations ?? []).flatMap((a) => [
      a.card.ref,
      ...a.card.completed,
      a.settled?.receipt,
    ]),
    ...state.audits.flatMap((a) => [
      a.card.ref,
      ...a.card.completed,
      a.role.session.receipt,
      a.role.type_receipt,
      a.answer?.evidence,
      a.applied?.evidence,
    ]),
  ].filter((ref): ref is InputRef => ref != null);
}
export function confirmIndependent(
  role: IndependentRole,
  expected: 'arbiter' | 'auditor',
  used: string[],
): void {
  const { run, session } = role;
  assertRunAction(run, 'read');
  requireWorkflow(run.loaded !== null, 'independent-load-missing');
  confirmLoad(run, run.loaded);
  requireLoadedProcedures(run, [expected === 'arbiter' ? 'arbitration' : 'audit']);
  requireWorkflow(
    run.type === 'role' &&
      run.spec.role === expected &&
      role.agent_type === expected &&
      run.spec.fork_turns === 'none' &&
      run.spec.session_id === session.id &&
      run.spec.workspace === session.workspace &&
      run.spec.project_id === session.project_id,
    'wrong-independent-role',
  );
  requireWorkflow(
    run.spec.procedures.some((p) => p.id === (expected === 'arbiter' ? 'arbitration' : 'audit')),
    'independent-procedure-missing',
  );
  confirmSession(session, { ...run.spec.requested, reason: expected }, true);
  requireWorkflow(
    expected !== 'auditor' || session.agent_role === 'auditor',
    'native-auditor-unconfirmed',
  );
  [role.type_receipt.locator, role.type_receipt.hash].forEach(textField);
  requireWorkflow(!used.includes(session.id), 'independent-session-reused');
}
export function auditBrief(card: AuditCard): string {
  textField(card.goal);
  textField(card.next_action);
  requireWorkflow(card.criteria.length > 0, 'audit-card-empty');
  card.criteria.forEach(textField);
  textField(card.ref.locator);
  textField(card.ref.hash);
  if (card.timing === null) progressAuditKey(card.progress);
  else requireWorkflow(card.progress === undefined, 'audit-card-variant-mismatch');
  return card.ref.locator;
}
export function supervisionBlockers(state: Supervision): string[] {
  return [
    ...(state.reservations ?? [])
      .filter((a) => a.settled === null)
      .map((a) => `audit-reservation:${a.id}`),
    ...state.arbitrations.filter((a) => a.status !== 'resolved').map((a) => `arbitration:${a.id}`),
    ...state.audits.filter((a) => a.applied === null).map((a) => `audit:${a.id}`),
  ];
}
export function findingExcepted(
  state: Supervision,
  finding: Finding,
  target: ReviewTarget,
): boolean {
  return state.arbitrations.some(
    (a) =>
      a.finding_id === finding.id &&
      a.status === 'resolved' &&
      a.exception_applied &&
      a.scope === finding.scope &&
      a.accepted_target !== null &&
      compareInputs(a.accepted_target.inputs, target.inputs) === 'applicable' &&
      compareInputs(targetEvidenceInputs(a.accepted_target), targetEvidenceInputs(target)) ===
        'applicable' &&
      sameRefs([a.accepted_target.diff], [target.diff]),
  );
}
export function assertSupervisedScope(state: Supervision, scope: string): void {
  requireWorkflow(
    !state.arbitrations.some(
      (a) => a.scope === scope && a.status !== 'resolved' && a.status !== 'implementing',
    ),
    'scope-blocked',
  );
  requireWorkflow(
    state.audits.every((a) => a.applied !== null) &&
      (state.reservations ?? []).every((a) => a.settled !== null),
    'audit-action-pending',
  );
}
export function applySupervision(
  state: Supervision,
  action: SupervisionAction,
  findings: Finding[],
  priorSessions: string[],
  target: ReviewTarget,
): Supervision {
  const next = structuredClone(state);
  const used = [
    ...priorSessions,
    ...state.arbiters.map((r) => r.session.id),
    ...state.audits.map((a) => a.role.session.id),
    ...(state.reservations ?? []).flatMap((a) =>
      a.settled?.session ? [a.settled.session.id] : [],
    ),
  ];
  if (action.kind === 'stage') {
    requireWorkflow(!state.stages.some((s) => s.id === action.id), 'stage-already-exists');
    next.stages.push(createTiming(action.id, action.estimate_ms, action.checkpoint));
  } else if (action.kind === 'reserve-audit') {
    requireWorkflow(
      state.audits.every((a) => a.applied !== null),
      'audit-action-pending',
    );
    auditBrief(action.card);
    textField(action.id);
    requireWorkflow(
      !state.audits.some((a) => a.id === action.id) &&
        !(state.reservations ?? []).some((a) => a.id === action.id),
      'audit-id-conflict',
    );
    const progress = action.card.progress;
    const key = progressAuditKey(progress);
    requireWorkflow(
      compareInputs(target.inputs, progress.inputs) === 'applicable',
      'audit-card-stale',
    );
    requireWorkflow(
      findings
        .filter((f) => f.resolution === null)
        .every((f) => action.card.open_findings.includes(f.id)),
      'audit-card-stale',
    );
    const previous = [
      ...(state.reservations ?? []).map((a) => a.card),
      ...state.audits.map((a) => a.card),
    ].filter(
      (card): card is ProgressAuditCard =>
        card.timing === null && card.progress.task_id === progress.task_id,
    );
    requireWorkflow(
      previous.every(
        (card) =>
          card.progress.checkpoint !== progress.checkpoint &&
          card.progress.evidence.hash !== progress.evidence.hash,
      ),
      'audit-already-claimed',
    );
    requireWorkflow(
      (state.reservations ?? []).every((a) => a.settled !== null),
      'audit-launch-pending',
    );
    next.schema_version = 2;
    (next.reservations ??= []).push({
      id: action.id,
      key,
      card: action.card,
      operation: null,
      parent: null,
      settled: null,
    });
  } else if (action.kind === 'launch-audit' || action.kind === 'settle-audit') {
    const reservations = next.reservations ?? [];
    const reservation = reservations.find((a) => a.id === action.id);
    requireWorkflow(
      reservation !== undefined && reservation.settled === null,
      'audit-reservation-not-open',
    );
    if (action.kind === 'launch-audit') {
      requireWorkflow(
        compareInputs(target.inputs, reservation.card.progress.inputs) === 'applicable' &&
          findings
            .filter((f) => f.resolution === null)
            .every((f) => reservation.card.open_findings.includes(f.id)),
        'audit-card-stale',
      );
      textField(action.parent);
      textField(action.operation);
      requireWorkflow(
        reservation.operation === null &&
          !reservations.some((a) => a.operation === action.operation) &&
          !state.audits.some((a) => a.operation === action.operation),
        'audit-launch-already-claimed',
      );
      reservation.operation = action.operation;
      reservation.parent = action.parent;
    } else {
      const observation = action.observation;
      requireWorkflow(
        ['not-started', 'idle', 'terminal'].includes(observation.outcome),
        'audit-attempt-outcome-unknown',
      );
      requireWorkflow(
        observation.operation === (reservation.operation ?? reservation.id),
        'audit-operation-mismatch',
      );
      requireWorkflow(
        reservation.operation !== null || observation.outcome === 'not-started',
        'audit-attempt-not-launched',
      );
      [observation.receipt.locator, observation.receipt.hash].forEach(textField);
      if (observation.outcome === 'not-started')
        requireWorkflow(observation.session === null, 'audit-attempt-identity-mismatch');
      else {
        requireWorkflow(
          observation.session.agent_role === 'auditor' &&
            observation.session.read_only &&
            !observation.session.network,
          'audit-attempt-profile-unconfirmed',
        );
        if (observation.outcome === 'terminal') {
          textField(observation.turn);
          requireWorkflow(
            ['completed', 'failed', 'interrupted'].includes(observation.status),
            'audit-attempt-not-terminal',
          );
        }
      }
      reservation.settled = observation;
    }
  } else if (action.kind === 'sample') {
    const index = next.stages.findIndex((s) => s.id === action.stage);
    requireWorkflow(index >= 0, 'stage-not-found');
    next.stages[index] = sampleTiming(next.stages[index]!, action.sample);
  } else if (action.kind === 'audit') {
    if (action.stage !== null)
      requireWorkflow(
        next.stages.some((s) => s.id === action.stage),
        'stage-not-found',
      );
    requireWorkflow(!state.audits.some((a) => a.id === action.id), 'audit-id-conflict');
    confirmIndependent(action.role, 'auditor', used);
    auditBrief(action.card);
    requireWorkflow(
      findings
        .filter((f) => f.resolution === null)
        .every((f) => action.card.open_findings.includes(f.id)),
      'audit-card-stale',
    );
    let key: string;
    let operation: string | undefined;
    if (action.card.timing === null) {
      requireWorkflow(
        action.stage === null &&
          action.trigger.kind === 'no-progress' &&
          action.trigger.evidence_id === action.card.progress.evidence.hash,
        'wrong-progress-audit-trigger',
      );
      requireWorkflow(
        compareInputs(target.inputs, action.card.progress.inputs) === 'applicable',
        'audit-card-stale',
      );
      const index = next.reservations?.findIndex((a) => a.id === action.id) ?? -1;
      const reservation = next.reservations?.[index];
      requireWorkflow(
        reservation !== undefined &&
          reservation.settled === null &&
          reservation.operation !== null &&
          sameValue(reservation.card, action.card),
        'audit-reservation-mismatch',
      );
      key = reservation.key;
      operation = reservation.operation;
      next.reservations!.splice(index, 1);
    } else {
      const index = next.stages.findIndex((s) => s.id === action.stage);
      requireWorkflow(index >= 0, 'stage-not-found');
      const stage = next.stages[index]!;
      requireWorkflow(sameValue(action.card.timing, stage), 'audit-card-stale');
      next.stages[index] = claimAudit(stage, action.trigger);
      key = auditKey(stage, action.trigger);
    }
    next.audits.push({
      id: action.id,
      key,
      card: action.card,
      role: action.role,
      ...(operation === undefined ? {} : { operation }),
      answer: null,
      applied: null,
    });
  } else if (action.kind === 'arbitrate') {
    requireWorkflow(
      !state.arbitrations.some(
        (a) => a.id === action.id || (a.finding_id === action.finding && a.status !== 'resolved'),
      ),
      'arbitration-already-open',
    );
    const finding = findings.find((f) => f.id === action.finding);
    requireWorkflow(finding !== undefined, 'arbitration-finding-missing');
    confirmIndependent(action.role, 'arbiter', used);
    next.arbiters.push(action.role);
    next.arbitrations.push(
      startArbitration(action.id, finding, action.trigger, action.role.session.id),
    );
  } else if (action.kind === 'audit-answer' || action.kind === 'audit-apply') {
    const audit = next.audits.find((a) => a.id === action.id);
    requireWorkflow(audit !== undefined, 'audit-not-found');
    if (action.kind === 'audit-answer') {
      requireWorkflow(
        audit.answer === null && action.session === audit.role.session.id,
        'wrong-auditor-answer',
      );
      [
        action.answer.reason,
        action.answer.next_result,
        action.answer.evidence.locator,
        action.answer.evidence.hash,
      ].forEach(textField);
      audit.answer = action.answer;
    } else {
      requireWorkflow(audit.answer !== null && audit.applied === null, 'audit-not-actionable');
      [action.checkpoint, action.evidence.locator, action.evidence.hash].forEach(textField);
      requireWorkflow(
        action.checkpoint !== (audit.card.timing ?? audit.card.progress).checkpoint,
        'audit-checkpoint-unchanged',
      );
      audit.applied = { checkpoint: action.checkpoint, evidence: action.evidence };
      // Applying a direction does not reset time or create a new overrun trigger. A future
      // no-progress trigger must carry new evidence for a genuinely new checkpoint.
    }
  } else {
    const index = next.arbitrations.findIndex((a) => a.id === action.id);
    requireWorkflow(index >= 0, 'arbitration-not-found');
    const arbitration = next.arbitrations[index]!;
    if (action.kind === 'decision')
      next.arbitrations[index] = decideArbitration(arbitration, action.session, action.decision);
    else if (action.kind === 'human')
      next.arbitrations[index] = humanArbitration(arbitration, action.accepted, action.evidence);
    else if (action.kind === 'resume')
      next.arbitrations[index] = resumeArbitration(arbitration, action.condition, action.evidence);
    else if (action.kind === 'reconsider')
      next.arbitrations[index] = reconsiderArbitration(
        arbitration,
        action.condition,
        action.evidence,
      );
    else {
      const finding = findings.find((f) => f.id === arbitration.finding_id);
      requireWorkflow(finding !== undefined, 'arbitration-finding-missing');
      requireWorkflow(sameTarget(action.proof.target, target), 'arbitration-target-mismatch');
      next.arbitrations[index] = finishArbitration(arbitration, finding, action.proof);
    }
  }
  return structuredClone(next);
}
