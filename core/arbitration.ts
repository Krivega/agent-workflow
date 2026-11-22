import { createMachine, transition } from 'xstate';
import { requireWorkflow, textField } from './connection.js';
import { sameRefs } from './council.js';
import type { CouncilRole, ReviewTarget } from './council.js';
import type { Finding } from './findings.js';
import type { InputRef } from './localRun.js';

export type ArbitrationTrigger =
  | { kind: 'initial-contradiction'; confirmation: InputRef; reviewer: CouncilRole }
  | { kind: 'three-fail' };
export interface Arbitration {
  id: string;
  finding_id: string;
  scope: string;
  trigger: ArbitrationTrigger;
  status: 'waiting' | 'blocked' | 'human' | 'implementing' | 'resolved';
  original_fail: InputRef;
  sources: InputRef[];
  session_id: string;
  decision: {
    outcome: 'direction' | 'compromise' | 'undecided';
    reason: string;
    exception: string;
    residual_risk: string;
    dissent: string[];
    evidence: InputRef;
  } | null;
  human: InputRef | null;
  implementation: InputRef | null;
  review: { reviewer: CouncilRole; verdict: 'PASS' | 'FAIL'; evidence: InputRef } | null;
  resume_condition: string;
  exception_applied: boolean;
  accepted_target: ReviewTarget | null;
  working_check: InputRef | null;
  attempts?: ArbitrationAttempt[];
}
export type ArbitrationAttempt = Pick<
  Arbitration,
  'decision' | 'human' | 'implementation' | 'review' | 'working_check'
> & { condition: string; evidence: InputRef };
const machine = createMachine({
  types: {} as { events: { type: 'BLOCK' | 'HUMAN' | 'IMPLEMENT' | 'RESOLVE' | 'RECONSIDER' } },
  initial: 'waiting',
  states: {
    waiting: { on: { BLOCK: 'blocked', HUMAN: 'human', IMPLEMENT: 'implementing' } },
    blocked: { on: { IMPLEMENT: 'implementing', RECONSIDER: 'waiting' } },
    human: { on: { IMPLEMENT: 'implementing', BLOCK: 'blocked' } },
    implementing: { on: { RESOLVE: 'resolved', BLOCK: 'blocked' } },
    resolved: { type: 'final' },
  },
});
function move(
  value: Arbitration,
  type: 'BLOCK' | 'HUMAN' | 'IMPLEMENT' | 'RESOLVE' | 'RECONSIDER',
): Arbitration {
  return {
    ...value,
    status: transition(machine, machine.resolveState({ value: value.status, context: {} }), {
      type,
    })[0].value as Arbitration['status'],
  };
}
export function startArbitration(
  id: string,
  finding: Finding,
  trigger: ArbitrationTrigger,
  session: string,
): Arbitration {
  [id, session].forEach(textField);
  requireWorkflow(finding.resolution === null, 'finding-already-resolved');
  if (trigger.kind === 'initial-contradiction') {
    requireWorkflow(trigger.reviewer === finding.owner, 'contradiction-unconfirmed');
    [trigger.confirmation.locator, trigger.confirmation.hash].forEach(textField);
  } else {
    const tail = finding.rounds.slice(-3);
    requireWorkflow(
      tail.length === 3 &&
        tail.every((r) =>
          r.verdicts?.some((v) => v.reviewer === finding.owner && v.verdict === 'FAIL'),
        ),
      'three-fail-unconfirmed',
    );
  }
  return {
    id,
    finding_id: finding.id,
    scope: finding.scope,
    trigger,
    status: 'waiting',
    original_fail: finding.original_fail,
    sources: finding.sources,
    session_id: session,
    decision: null,
    human: null,
    implementation: null,
    review: null,
    resume_condition: finding.condition,
    exception_applied: false,
    accepted_target: null,
    working_check: null,
  };
}
export function decideArbitration(
  run: Arbitration,
  session: string,
  decision: NonNullable<Arbitration['decision']>,
): Arbitration {
  requireWorkflow(run.status === 'waiting' && session === run.session_id, 'wrong-arbiter-answer');
  [decision.reason, decision.evidence.locator, decision.evidence.hash].forEach(textField);
  if (decision.outcome === 'compromise')
    [decision.exception, decision.residual_risk].forEach(textField);
  return move(
    { ...run, decision: structuredClone(decision) },
    decision.outcome === 'undecided'
      ? 'BLOCK'
      : decision.outcome === 'compromise' && run.trigger.kind === 'initial-contradiction'
        ? 'HUMAN'
        : 'IMPLEMENT',
  );
}
export function humanArbitration(
  run: Arbitration,
  accepted: boolean,
  evidence: InputRef,
): Arbitration {
  requireWorkflow(run.status === 'human', 'human-decision-not-pending');
  [evidence.locator, evidence.hash].forEach(textField);
  return move({ ...run, human: evidence }, accepted ? 'IMPLEMENT' : 'BLOCK');
}
export function resumeArbitration(
  run: Arbitration,
  condition: string,
  evidence: InputRef,
): Arbitration {
  requireWorkflow(
    run.status === 'blocked' &&
      condition === run.resume_condition &&
      run.decision?.outcome === 'direction',
    'arbitration-needs-new-decision',
  );
  [evidence.locator, evidence.hash].forEach(textField);
  return move({ ...run, implementation: evidence }, 'IMPLEMENT');
}
export function reconsiderArbitration(
  run: Arbitration,
  condition: string,
  evidence: InputRef,
): Arbitration {
  requireWorkflow(
    run.status === 'blocked' && condition === run.resume_condition && run.decision !== null,
    'arbitration-not-reconsiderable',
  );
  [evidence.locator, evidence.hash].forEach(textField);
  const { decision, human, implementation, review, working_check } = run;
  return move(
    {
      ...run,
      attempts: [
        ...(run.attempts ?? []),
        structuredClone({
          decision,
          human,
          implementation,
          review,
          working_check,
          condition,
          evidence,
        }),
      ],
      decision: null,
      human: null,
      implementation: null,
      review: null,
      working_check: null,
      exception_applied: false,
      accepted_target: null,
    },
    'RECONSIDER',
  );
}
export function finishArbitration(
  run: Arbitration,
  finding: Finding,
  proof: {
    target: ReviewTarget;
    implementation: InputRef;
    review: NonNullable<Arbitration['review']>;
    condition: string;
    working_check: InputRef;
    check_verdict: 'PASS' | 'FAIL' | 'NOT RUN';
    mandatory_defect: boolean;
  },
): Arbitration {
  requireWorkflow(
    run.status === 'implementing' &&
      finding.id === run.finding_id &&
      sameRefs([finding.original_fail], [run.original_fail]),
    'wrong-arbitration-scope',
  );
  requireWorkflow(
    proof.review.reviewer === finding.owner && proof.condition === finding.condition,
    'affected-review-required',
  );
  [proof.implementation, proof.working_check, proof.review.evidence].forEach((ref) => {
    textField(ref.locator);
    textField(ref.hash);
  });
  const exception = run.decision!.outcome === 'compromise';
  const accepted =
    proof.check_verdict === 'PASS' &&
    (proof.review.verdict === 'PASS' ||
      (exception && run.trigger.kind === 'three-fail' && !proof.mandatory_defect));
  // Mandatory defects cannot be waived, even by an apparently successful working check.
  requireWorkflow(
    !exception || (!proof.mandatory_defect && finding.waivable === true),
    'mandatory-defect-cannot-be-waived',
  );
  return move(
    {
      ...run,
      implementation: proof.implementation,
      review: proof.review,
      exception_applied: accepted && exception,
      accepted_target: accepted ? proof.target : null,
      working_check: proof.working_check,
    },
    accepted ? 'RESOLVE' : 'BLOCK',
  );
}
