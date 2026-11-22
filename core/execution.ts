import { createMachine, getInitialSnapshot, transition } from 'xstate';
import { requireWorkflow, textField } from './connection.js';
import { compareInputs, targetEvidenceInputs } from './evidence.js';
import { copyState, sameValue } from './equality.js';
import type { ArchiveRef, InputManifest } from './evidence.js';
import {
  assignAdviser,
  createCouncil,
  changedPlanningRoles,
  councilBlockers,
  configuredRoles,
  sameRefs,
  sameTarget,
} from './council.js';
import type { Council, CouncilRole, ReviewTarget, Selection } from './council.js';
import { recordFinding } from './findings.js';
import type { Finding } from './findings.js';
import type { InputRef, LocalRun } from './localRun.js';
import {
  applySupervision,
  emptySupervision,
  findingExcepted,
  supervisionBlockers,
  supervisionEvidence,
  assertSupervisedScope,
} from './supervision.js';
import type { Supervision, SupervisionAction } from './supervision.js';
import { validateLocalAdmission, validateLocalReview } from './localPlanning.js';
import type { LocalAdmission } from './localPlanning.js';

export interface Check {
  id: string;
  verdict: 'PASS' | 'FAIL' | 'NOT RUN' | 'N/A';
  reason: string;
  evidence: InputRef;
  inputs: InputManifest;
}
export interface Gate {
  id: string;
  kind: 'check' | 'human';
  applicable: boolean;
  reason: string;
}
export interface Baseline {
  kind: 'real' | 'fixture';
  scenario: string;
  evidence: InputRef;
  inputs: InputManifest;
  elapsed_ms: number;
  exit_code: number;
}
export interface MechanicalProof {
  inputs: InputManifest;
  accepted: InputRef;
  observed: InputRef;
  delta: InputRef;
  expected_delta: InputRef;
  links: InputRef[];
  expected_links: InputRef[];
  semantic_delta: boolean;
  applicability: 'applicable' | 'changed' | 'unknown';
}
export interface ExecutionResult {
  scope: string;
  target: ReviewTarget;
  evidence: InputRef[];
  child_results: {
    scope: string;
    criterion: string;
    evidence: InputRef;
    inputs: InputManifest;
    valid: boolean;
  }[];
  limitations: string[];
  summary: string;
}
export interface HumanCompletion {
  schema_version: 1;
  task_id: string;
  generation: number;
  requirements_revision: number;
  message_revision: number;
  target: ReviewTarget;
  decisions: {
    question_id: string;
    action: string;
    revision: number;
    accepted: boolean;
    source: InputRef;
  }[];
}
export interface Execution {
  schema_version: 2 | 3;
  requirements_revision?: number;
  human_completion?: HumanCompletion;
  task_id: string;
  revision: number;
  generation: number;
  status: 'planning' | 'implementing' | 'review' | 'done';
  route: 'substantial' | 'mechanical' | 'local';
  local?: LocalAdmission;
  coder_reservations?: string[];
  code: boolean;
  planning: Council | null;
  acceptance: Council | null;
  reviewer_sessions: Record<string, string>;
  mechanical: MechanicalProof | null;
  target: ReviewTarget;
  gates: Gate[];
  checks: Check[];
  baseline: Baseline | null;
  findings: Finding[];
  compromise: 'none' | 'pending' | 'accepted';
  result: ExecutionResult | null;
  child_results: ExecutionResult['child_results'];
  history_format?: 1;
  history: {
    id: string;
    payload: string;
    archive?: ArchiveRef;
    dependencies?: string[];
    fingerprint?: string;
    expected_revision?: number;
    generation?: number;
    type?: ExecutionAction['type'];
  }[];
  supervision?: Supervision;
}
export type ExecutionAction =
  | { type: 'SUPERVISE'; action: SupervisionAction }
  | {
      type: 'REPLACE_REVIEWER';
      role: CouncilRole;
      previous_session: string;
      run: LocalRun;
      checkpoint: InputRef;
    }
  | { type: 'INVALIDATE_CHILD'; scope: string; criterion: string; reason: string }
  | { type: 'REPLAN'; target: ReviewTarget; requirements?: { revision: number; source: InputRef } }
  | {
      type: 'REUSE';
      scope: string;
      criterion: string;
      original_scope: string;
      original_criterion: string;
      source: InputManifest;
      current: InputManifest;
      evidence: InputRef;
      risk: boolean;
    }
  | { type: 'PLAN'; council: Council }
  | { type: 'LOCAL'; admission: LocalAdmission }
  | { type: 'MECHANICAL'; proof: MechanicalProof }
  | {
      type: 'REVIEW';
      target: ReviewTarget;
      selection: Selection;
      baseline: Baseline;
      checks: Check[];
    }
  | { type: 'ACCEPT'; council: Council; findings: Finding[] }
  | { type: 'CORRECT'; findings: Finding[] }
  | { type: 'RESULT'; result: ExecutionResult }
  | { type: 'DONE' };
export type ExecutionEvent = ExecutionAction & {
  id: string;
  expected_revision: number;
  generation: number;
};
const machine = createMachine({
  types: {} as { events: { type: ExecutionAction['type'] } },
  initial: 'planning',
  states: {
    planning: {
      on: {
        PLAN: 'implementing',
        LOCAL: 'implementing',
        MECHANICAL: 'implementing',
        REPLAN: 'planning',
      },
    },
    implementing: { on: { REVIEW: 'review', REPLAN: 'planning' } },
    review: { on: { REVIEW: 'review', CORRECT: 'implementing', DONE: 'done', REPLAN: 'planning' } },
    done: { type: 'final' },
  },
});
export function createExecution(
  task: string,
  generation: number,
  target: ReviewTarget,
  gates: Gate[],
  code: boolean,
  route: Execution['route'],
): Execution {
  textField(task);
  targetEvidenceInputs(target);
  requireWorkflow(Number.isSafeInteger(generation) && generation > 0, 'invalid-generation');
  requireWorkflow(
    gates.length > 0 && new Set(gates.map((g) => g.id)).size === gates.length,
    'invalid-gates',
  );
  for (const gate of gates) {
    textField(gate.id);
    textField(gate.reason);
  }
  requireWorkflow(
    !code || gates.some((g) => g.id === 'validate' && g.kind === 'check' && g.applicable),
    'validate-required',
  );
  return {
    schema_version: route === 'local' ? 3 : 2,
    task_id: task,
    revision: 0,
    generation,
    status: getInitialSnapshot(machine).value as Execution['status'],
    route,
    code,
    planning: null,
    acceptance: null,
    reviewer_sessions: {},
    mechanical: null,
    target,
    gates,
    checks: [],
    baseline: null,
    findings: [],
    compromise: 'none',
    result: null,
    child_results: [],
    history: [],
  };
}
export function checkMechanical(proof: MechanicalProof): void {
  requireWorkflow(
    !proof.semantic_delta && proof.applicability === 'applicable',
    'mechanical-needs-planning',
  );
  requireWorkflow(
    sameRefs([proof.accepted], [proof.observed]) &&
      sameRefs([proof.delta], [proof.expected_delta]) &&
      sameRefs(proof.links, proof.expected_links),
    'mechanical-proof-mismatch',
  );
  [proof.accepted.locator, proof.accepted.hash, proof.delta.locator, proof.delta.hash].forEach(
    textField,
  );
}
function childHasOpenFinding(run: Execution, scope: string): boolean {
  return run.findings.some((finding) => finding.scope === scope && finding.resolution === null);
}
function revokeChildReuse(run: Execution): void {
  for (const child of run.child_results) {
    if (childHasOpenFinding(run, child.scope)) child.valid = false;
  }
}
export function executionBlockers(run: Execution): string[] {
  const blockers: string[] = [];
  for (const id of run.coder_reservations ?? []) blockers.push(`coder:${id}:pending`);
  for (const gate of run.gates) {
    if (!gate.applicable) continue;
    const check = run.checks.find((c) => c.id === gate.id);
    if (
      !check ||
      check.verdict !== 'PASS' ||
      compareInputs(check.inputs, run.target.inputs) !== 'applicable'
    )
      blockers.push(`${gate.id}:not-passed`);
  }
  const supervision = run.supervision ?? emptySupervision();
  blockers.push(...supervisionBlockers(supervision));
  if (
    run.findings.some(
      (f) => f.blocking && f.resolution === null && !findingExcepted(supervision, f, run.target),
    )
  )
    blockers.push('open-blocker');
  if (run.compromise === 'pending') blockers.push('human-compromise-pending');
  for (const child of run.child_results)
    if (
      !child.valid ||
      run.findings.some((finding) => finding.scope === child.scope && finding.resolution === null)
    )
      blockers.push(`child:${child.scope}:not-reusable`);
  if (run.route !== 'mechanical') {
    if (!run.acceptance) blockers.push('acceptance-missing');
    else {
      const excepted: CouncilRole[] = [];
      for (const role of configuredRoles(run.acceptance.configuration)) {
        const answer = run.acceptance.advisers[role]?.answer;
        if (
          answer?.verdict === 'FAIL' &&
          answer.findings.length > 0 &&
          answer.findings.every((reported) =>
            run.findings.some(
              (finding) =>
                finding.id === reported.id &&
                finding.owner === role &&
                findingExcepted(supervision, finding, run.target),
            ),
          )
        )
          excepted.push(role);
      }
      blockers.push(...councilBlockers(run.acceptance, excepted));
    }
  }
  return blockers;
}
function preserveFindings(previous: Finding[], next: Finding[]): void {
  for (const finding of previous) {
    const retained = next.find((f) => f.id === finding.id);
    requireWorkflow(
      retained !== undefined &&
        retained.scope === finding.scope &&
        retained.blocking === finding.blocking &&
        retained.waivable === finding.waivable &&
        retained.reason === finding.reason &&
        sameRefs(retained.sources, finding.sources) &&
        retained.condition === finding.condition &&
        retained.owner === finding.owner &&
        sameRefs([retained.original_fail], [finding.original_fail]) &&
        finding.rounds.every((round) =>
          retained.rounds.some(
            (r) =>
              r.correction_id === round.correction_id &&
              round.reviewers.every((role) => r.reviewers.includes(role)) &&
              round.evidence.every((ref) => r.evidence.some((e) => sameRefs([e], [ref]))) &&
              (round.verdicts ?? []).every((v) => r.verdicts?.some((other) => sameValue(v, other))),
          ),
        ),
      'finding-history-lost',
    );
    if (retained.resolution)
      requireWorkflow(
        retained.resolution.condition === retained.condition &&
          retained.resolution.reviewer === retained.owner &&
          retained.rounds.some(
            (r) =>
              r.reviewers.includes(retained.owner) &&
              r.evidence.some((e) => sameRefs([e], [retained.resolution!.evidence])),
          ),
        'unproven-finding-resolution',
      );
  }
}
export function applyExecution(
  run: Execution,
  event: ExecutionEvent,
  fingerprint?: (value: unknown) => string,
): Execution {
  const hash = fingerprint?.(event);
  requireWorkflow(
    hash === undefined || /^[a-f0-9]{64}$/u.test(hash),
    'invalid-execution-fingerprint',
  );
  requireWorkflow(
    run.history_format === undefined || fingerprint !== undefined,
    'execution-fingerprint-required',
  );
  const payload = hash === undefined ? JSON.stringify(event) : '';
  const previous = run.history.find((e) => e.id === event.id);
  if (previous) {
    requireWorkflow(previous.archive === undefined, 'execution-history-read-required');
    requireWorkflow(
      previous.fingerprint === undefined
        ? previous.payload === (hash === undefined ? payload : JSON.stringify(event))
        : hash === previous.fingerprint,
      'execution-event-conflict',
    );
    return run;
  }
  requireWorkflow(
    run.revision === event.expected_revision && run.generation === event.generation,
    'stale-execution-event',
  );
  requireWorkflow(run.status !== 'done', 'execution-done');
  if (['REPLAN', 'REVIEW', 'RESULT', 'DONE'].includes(event.type))
    requireWorkflow((run.coder_reservations?.length ?? 0) === 0, 'coder-writers-pending');
  // Historical payloads are immutable strings; cloning them can exhaust the heap.
  const next = copyState({ ...run, history: [] });
  // Retain revocation from legacy checkpoints before an event can resolve their finding.
  revokeChildReuse(next);
  if (event.type === 'SUPERVISE') {
    if (event.action.kind === 'reserve-audit')
      requireWorkflow(event.action.card.progress.task_id === run.task_id, 'wrong-audit-task');
    next.supervision = applySupervision(
      run.supervision ?? emptySupervision(),
      event.action,
      run.findings,
      Object.values(run.reviewer_sessions),
      run.target,
    );
    next.result = null;
  } else if (event.type === 'REPLACE_REVIEWER') {
    requireWorkflow(
      run.reviewer_sessions[event.role] === event.previous_session &&
        (run.planning !== null || run.local !== undefined),
      'wrong-reviewer-recovery',
    );
    const assignment = assignAdviser(
      createCouncil(
        'acceptance',
        run.local?.selection ?? run.planning!.selection,
        run.target,
        run.local ? run.local.configuration : run.planning!.configuration,
      ),
      event.role,
      event.run,
    ).advisers[event.role]!;
    next.reviewer_sessions[event.role] = event.run.spec.session_id;
    if (next.acceptance) next.acceptance.advisers[event.role] = assignment;
    next.result = null;
  } else if (event.type === 'INVALIDATE_CHILD') {
    textField(event.reason);
    const child = next.child_results.find(
      (c) => c.scope === event.scope && c.criterion === event.criterion,
    );
    requireWorkflow(child !== undefined, 'child-result-missing');
    child.valid = false;
    next.result = null;
  } else if (event.type === 'REPLAN') {
    targetEvidenceInputs(event.target);
    const revised = event.requirements;
    requireWorkflow(
      run.status === 'implementing' ||
        run.status === 'review' ||
        (run.status === 'planning' && revised !== undefined),
      'wrong-replan-phase',
    );
    if (revised !== undefined) {
      requireWorkflow(
        revised.revision === (run.requirements_revision ?? 0) + 1,
        'stale-requirements-revision',
      );
      [revised.source.locator, revised.source.hash].forEach(textField);
      next.requirements_revision = revised.revision;
    }
    next.target = event.target;
    next.route = 'substantial';
    delete next.local;
    next.mechanical = null;
    next.baseline = null;
    next.checks = [];
    next.acceptance = null;
    next.result = null;
  } else if (event.type === 'REUSE') {
    requireWorkflow(
      event.scope === event.original_scope &&
        event.criterion === event.original_criterion &&
        !event.risk &&
        !run.findings.some((f) => f.scope === event.scope && f.resolution === null) &&
        compareInputs(event.source, event.current) === 'applicable',
      'child-result-not-reusable',
    );
    const child = {
      scope: event.scope,
      criterion: event.criterion,
      evidence: event.evidence,
      inputs: event.current,
      valid: true,
    };
    requireWorkflow(
      !run.child_results.some(
        (r) => r.scope === child.scope && r.criterion === child.criterion && r.valid,
      ),
      'child-already-reused',
    );
    next.child_results = next.child_results.filter(
      (r) => r.scope !== child.scope || r.criterion !== child.criterion,
    );
    next.child_results.push(child);
    next.result = null;
  } else if (event.type === 'PLAN') {
    requireWorkflow(
      run.status === 'planning' &&
        run.route === 'substantial' &&
        event.council.phase === 'planning',
      'wrong-planning-phase',
    );
    requireWorkflow(
      sameTarget(run.target, event.council.target) && councilBlockers(event.council).length === 0,
      'planning-not-accepted',
    );
    next.planning = event.council;
  } else if (event.type === 'LOCAL') {
    requireWorkflow(run.status === 'planning' && run.route !== 'mechanical', 'wrong-local-phase');
    validateLocalAdmission(event.admission, run.target);
    next.schema_version = 3;
    next.route = 'local';
    next.local = event.admission;
  } else if (event.type === 'MECHANICAL') {
    requireWorkflow(
      run.status === 'planning' && run.route === 'mechanical',
      'wrong-mechanical-phase',
    );
    checkMechanical(event.proof);
    requireWorkflow(
      sameRefs([event.proof.delta], [run.target.diff]) &&
        compareInputs(event.proof.inputs, run.target.inputs) === 'applicable',
      'mechanical-target-mismatch',
    );
    next.mechanical = event.proof;
  } else if (event.type === 'REVIEW') {
    if (run.supervision) assertSupervisedScope(run.supervision, run.target.scope);
    const refreshing = run.status === 'review';
    requireWorkflow(run.status === 'implementing' || refreshing, 'implementation-not-started');
    if (refreshing) {
      const human = new Set(
        run.gates.filter((gate) => gate.kind === 'human' && gate.applicable).map((gate) => gate.id),
      );
      requireWorkflow(
        human.size > 0 &&
          sameValue(run.target, event.target) &&
          sameValue(run.baseline, event.baseline) &&
          event.checks.length === run.checks.length &&
          event.checks.every((check) => {
            const previous = run.checks.find((old) => old.id === check.id);
            return (
              previous !== undefined &&
              (human.has(check.id)
                ? sameValue(check.inputs, previous.inputs)
                : sameValue(check, previous))
            );
          }) &&
          event.checks.some(
            (check) =>
              human.has(check.id) &&
              !sameValue(
                check,
                run.checks.find((old) => old.id === check.id),
              ),
          ),
        'human-review-refresh-only',
      );
      next.acceptance = null;
    }
    requireWorkflow(run.target.scope === event.target.scope, 'new-scope-needs-planning');
    if (run.route === 'mechanical') {
      requireWorkflow(
        run.mechanical !== null &&
          sameRefs([run.mechanical.delta], [event.target.diff]) &&
          compareInputs(run.mechanical.inputs, event.target.inputs) === 'applicable',
        'mechanical-target-mismatch',
      );
      checkMechanical(run.mechanical);
    }
    if (run.planning && run.route !== 'local')
      requireWorkflow(
        changedPlanningRoles(run.planning, event.selection).length === 0,
        'new-scope-needs-planning',
      );
    if (run.route === 'local') {
      requireWorkflow(run.local !== undefined, 'local-plan-required');
      validateLocalReview(run.local, event.target, event.selection);
    }
    requireWorkflow(
      event.baseline.kind === 'real' &&
        event.baseline.exit_code === 0 &&
        Number.isFinite(event.baseline.elapsed_ms) &&
        event.baseline.elapsed_ms >= 0,
      'real-baseline-required',
    );
    textField(event.baseline.scenario);
    requireWorkflow(
      compareInputs(event.baseline.inputs, event.target.inputs) === 'applicable',
      'stale-baseline',
    );
    requireWorkflow(
      new Set(event.checks.map((c) => c.id)).size === event.checks.length,
      'duplicate-check',
    );
    next.target = event.target;
    next.baseline = event.baseline;
    next.checks = event.checks;
    next.result = null;
  } else if (event.type === 'ACCEPT') {
    requireWorkflow(
      run.status === 'review' && run.route !== 'mechanical' && event.council.phase === 'acceptance',
      'wrong-acceptance-phase',
    );
    requireWorkflow(sameTarget(run.target, event.council.target), 'wrong-acceptance-target');
    requireWorkflow(
      sameValue(
        event.council.configuration,
        run.local ? run.local.configuration : run.planning?.configuration,
      ),
      'wrong-council-configuration',
    );
    requireWorkflow(
      run.route === 'local'
        ? run.local !== undefined
        : run.planning !== null &&
            changedPlanningRoles(run.planning, event.council.selection).length === 0,
      'unplanned-acceptance-scope',
    );
    if (run.route === 'local') validateLocalReview(run.local!, run.target, event.council.selection);
    preserveFindings(run.findings, event.findings);
    for (const [role, adviser] of Object.entries(event.council.advisers)) {
      const key = role as CouncilRole;
      requireWorkflow(
        run.reviewer_sessions[key] === undefined ||
          run.reviewer_sessions[key] === adviser.run.spec.session_id,
        'reviewer-replacement-needs-recovery',
      );
      next.reviewer_sessions[key] = adviser.run.spec.session_id;
    }
    for (const finding of event.findings) {
      if (finding.resolution) {
        const answer = event.council.advisers[finding.owner]?.answer;
        requireWorkflow(
          answer?.verdict === 'PASS' && sameRefs([answer.evidence], [finding.resolution.evidence]),
          'resolution-review-missing',
        );
      }
    }
    next.acceptance = event.council;
    next.result = null;
    next.findings = event.findings;
    for (const entry of event.council.history)
      for (const finding of entry.answer.findings) {
        const resolved = next.findings.find((f) => f.id === finding.id && f.resolution !== null);
        if (
          resolved &&
          !finding.blocking &&
          resolved.owner === entry.role &&
          entry.answer.verdict === 'PASS'
        )
          continue;
        next.findings = recordFinding(next.findings, finding, entry.role, entry.answer.evidence);
      }
  } else if (event.type === 'CORRECT') {
    if (run.supervision) assertSupervisedScope(run.supervision, run.target.scope);
    requireWorkflow(run.status === 'review', 'wrong-correction-phase');
    preserveFindings(run.findings, event.findings);
    next.findings = event.findings;
    next.acceptance = null;
    next.result = null;
  } else if (event.type === 'RESULT') {
    requireWorkflow(
      run.status === 'review' && executionBlockers(run).length === 0,
      'result-gates-open',
    );
    requireWorkflow(
      event.result.scope === run.target.scope && sameTarget(run.target, event.result.target),
      'wrong-result-target',
    );
    textField(event.result.summary);
    requireWorkflow(event.result.evidence.length > 0, 'result-evidence-missing');
    const required = [
      ...supervisionEvidence(run.supervision ?? emptySupervision()),
      ...run.checks
        .filter((c) => run.gates.some((g) => g.id === c.id && g.applicable))
        .map((c) => c.evidence),
      run.baseline!.evidence,
      ...(run.acceptance?.history.map((h) => h.answer.evidence) ?? []),
      ...(run.route === 'mechanical' && run.mechanical
        ? [
            run.mechanical.accepted,
            run.mechanical.observed,
            run.mechanical.delta,
            run.mechanical.expected_delta,
            ...run.mechanical.links,
            ...run.mechanical.expected_links,
          ]
        : []),
    ];
    requireWorkflow(
      required.every((ref) => event.result.evidence.some((e) => sameRefs([e], [ref]))),
      'result-proof-links-missing',
    );
    requireWorkflow(sameValue(run.child_results, event.result.child_results), 'child-scope-lost');
    next.result = event.result;
  } else {
    requireWorkflow(
      run.status === 'review' && executionBlockers(run).length === 0 && run.result !== null,
      'premature-done',
    );
  }
  revokeChildReuse(next);
  next.status = transition(
    machine,
    machine.resolveState({ value: run.status, context: {} }),
    event,
  )[0].value as Execution['status'];
  next.revision += 1;
  return {
    ...copyState(next),
    ...(hash === undefined ? {} : { history_format: 1 as const }),
    history: [
      ...run.history.map((entry) => ({
        ...entry,
        ...(entry.archive === undefined ? {} : { archive: { ...entry.archive } }),
        ...(entry.dependencies === undefined ? {} : { dependencies: [...entry.dependencies] }),
      })),
      {
        id: event.id,
        payload,
        ...(hash === undefined
          ? {}
          : {
              fingerprint: hash,
              expected_revision: event.expected_revision,
              generation: event.generation,
              type: event.type,
            }),
        ...(hash === undefined &&
        (event.type === 'PLAN' || event.type === 'ACCEPT') &&
        event.council.history.some((entry) => entry.archive !== undefined)
          ? {
              dependencies: event.council.history.flatMap((entry) =>
                entry.archive === undefined ? [] : [entry.archive.hash],
              ),
            }
          : {}),
      },
    ],
  };
}
