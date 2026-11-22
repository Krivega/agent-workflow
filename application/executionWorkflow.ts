import type { AuditAttempts } from '../ports/auditAttempts.js';
import { requireWorkflow } from '../core/connection.js';
import { compareInputs, targetEvidenceInputs } from '../core/evidence.js';
import { applyExecution } from '../core/execution.js';
import type { Execution, ExecutionEvent } from '../core/execution.js';
import type { WorkflowInputs, WorkflowJournal } from '../ports/workflowJournal.js';
import type { AgentSessions } from '../ports/agentSessions.js';
import { confirmSession } from '../core/dataRoute.js';
import type { LocalRun } from '../core/localRun.js';
import { collectInputRefs } from '../core/inputRefs.js';
import type { AuditCards } from '../ports/auditCards.js';
import { sameValue } from '../core/equality.js';
import type { Council } from '../core/council.js';
import { councilCurrentProfileRefs } from '../core/council.js';

export async function beginExecution(run: Execution, journal: WorkflowJournal) {
  await journal.ensureReady(run);
  const state = await journal.read();
  requireWorkflow(state.execution === null, 'execution-already-exists');
  await journal.save(
    state,
    {
      ...state,
      schema_version: run.schema_version === 3 ? 2 : state.schema_version,
      revision: state.revision + 1,
      execution: run,
    },
    `execution:${run.task_id}:begin`,
  );
  return run;
}
export async function advanceExecution(
  event: ExecutionEvent,
  journal: WorkflowJournal,
  inputs: WorkflowInputs,
  sessions?: Pick<AgentSessions, 'inspect'> & Partial<AuditAttempts>,
  auditCards?: AuditCards,
) {
  const state = await journal.read();
  const run = state.execution;
  requireWorkflow(run !== null, 'execution-not-found');
  await journal.ensureReady(run);
  const previous = run.history.find((entry) => entry.id === event.id);
  if (previous?.archive !== undefined) {
    requireWorkflow(journal.readEvent !== undefined, 'execution-history-reader-required');
    requireWorkflow(
      (await journal.readEvent(previous.archive.hash)) === JSON.stringify(event),
      'execution-event-conflict',
    );
    return run;
  }
  const next = applyExecution(run, event, journal.fingerprint);
  if (next === run) return run;
  const settling = event.type === 'SUPERVISE' && event.action.kind === 'settle-audit';
  const control = settling || event.type === 'CORRECT' || event.type === 'INVALIDATE_CHILD';
  if (!control && event.type !== 'REPLAN') {
    for (const council of [next.planning, next.acceptance])
      if (council !== null) await inputs.verify(councilCurrentProfileRefs(council));
  }
  if (!control) {
    const current = await inputs.current(next.target.inputs);
    requireWorkflow(
      compareInputs(next.target.inputs, current) === 'applicable',
      'execution-inputs-stale-or-unknown',
    );
    await inputs.verify([next.target.diff]);
    if (next.target.evidence_inputs !== undefined)
      requireWorkflow(
        compareInputs(
          targetEvidenceInputs(next.target),
          await inputs.current(next.target.evidence_inputs),
        ) === 'applicable',
        'execution-evidence-stale-or-unknown',
      );
    for (const child of next.child_results)
      if (child.valid)
        requireWorkflow(
          compareInputs(child.inputs, await inputs.current(child.inputs)) === 'applicable',
          'child-inputs-stale-or-unknown',
        );
  }
  if (!control) await verifyCouncilInputs(next.acceptance, inputs);
  if (next.mechanical && next.route === 'mechanical' && !control) {
    const proof = next.mechanical;
    await inputs.verify([
      proof.accepted,
      proof.observed,
      proof.delta,
      proof.expected_delta,
      ...proof.links,
      ...proof.expected_links,
    ]);
  }
  if (event.type === 'REVIEW')
    await inputs.verify([event.baseline.evidence, ...event.checks.map((c) => c.evidence)]);
  if (event.type === 'LOCAL')
    await inputs.verify([
      event.admission.source,
      event.admission.plan.requirement,
      event.admission.plan.owner,
      ...event.admission.plan.basis,
      ...event.admission.plan.consumers,
    ]);
  if (event.type === 'SUPERVISE') {
    const action = event.action;
    if (settling && action.kind === 'settle-audit') {
      const reservation = run.supervision?.reservations?.find((a) => a.id === action.id);
      requireWorkflow(reservation !== undefined, 'audit-reservation-not-open');
      const observed =
        reservation.operation === null
          ? {
              outcome: 'not-started' as const,
              operation: reservation.id,
              session: null,
              receipt: reservation.card.ref,
            }
          : await (async () => {
              requireWorkflow(
                sessions?.observeAuditAttempt !== undefined,
                'audit-attempt-observer-required',
              );
              return sessions.observeAuditAttempt(reservation);
            })();
      requireWorkflow(observed.outcome !== 'unknown', 'audit-attempt-outcome-unknown');
      requireWorkflow(
        sameValue(observed, action.observation),
        'audit-attempt-observation-mismatch',
      );
      await inputs.verify([reservation.card.ref, observed.receipt]);
    } else await inputs.verify(collectInputRefs(action));
    if (action.kind === 'audit' || action.kind === 'reserve-audit') {
      requireWorkflow(auditCards !== undefined, 'audit-card-reader-required');
      requireWorkflow(
        sameValue(await auditCards.read(action.card.ref), action.card),
        'audit-card-content-mismatch',
      );
    }
    if (action.kind === 'launch-audit') {
      requireWorkflow(sessions?.confirmAuditParent !== undefined, 'audit-parent-observer-required');
      await sessions.confirmAuditParent(action.parent);
      const card = run.supervision!.reservations!.find((a) => a.id === action.id)!.card;
      await inputs.verify(collectInputRefs(card));
    }
    if (action.kind === 'audit' && action.card.timing === null) {
      requireWorkflow(
        sessions?.observeAuditAttempt !== undefined,
        'audit-attempt-observer-required',
      );
      const reservation = run.supervision!.reservations!.find((a) => a.id === action.id)!;
      const observed = await sessions.observeAuditAttempt(reservation);
      requireWorkflow(
        observed.outcome === 'terminal' && observed.session.id === action.role.session.id,
        'audit-launch-unconfirmed',
      );
      await inputs.verify([observed.receipt]);
    }
    if (action.kind === 'arbitrate' || action.kind === 'audit') {
      requireWorkflow(sessions !== undefined, 'independent-session-unconfirmed');
      const role = action.role;
      const observed = await sessions.inspect(role.session.id);
      requireWorkflow(observed !== null, 'independent-session-missing');
      requireWorkflow(
        role.agent_type !== 'auditor' || observed.agent_role === 'auditor',
        'native-auditor-unconfirmed',
      );
      confirmSession(observed, { ...role.run.spec.requested, reason: role.agent_type }, false);
      requireWorkflow(
        observed.id === role.session.id &&
          observed.project_id === role.session.project_id &&
          observed.workspace === role.session.workspace,
        'independent-session-mismatch',
      );
    }
  }
  if (event.type === 'ACCEPT' || event.type === 'PLAN')
    await inputs.verify(event.council.history.map((h) => h.answer.evidence));
  if (event.type === 'REUSE') {
    requireWorkflow(
      compareInputs(event.source, await inputs.current(event.current)) === 'applicable',
      'child-inputs-changed',
    );
    await inputs.verify([event.evidence]);
  }
  if (event.type === 'REPLACE_REVIEWER') {
    requireWorkflow(sessions !== undefined, 'reviewer-recovery-unconfirmed');
    requireWorkflow(
      (await sessions.inspect(event.previous_session)) === null,
      'reviewer-still-recoverable',
    );
    const replacement = await sessions.inspect(event.run.spec.session_id);
    requireWorkflow(replacement !== null, 'replacement-session-missing');
    confirmSession(
      replacement,
      { ...event.run.spec.requested, reason: 'explicit reviewer recovery' },
      false,
    );
    await inputs.verify([event.checkpoint]);
  }
  if (event.type === 'RESULT')
    await inputs.verify([
      ...event.result.evidence,
      ...event.result.child_results.map((r) => r.evidence),
    ]);
  if (event.type === 'DONE' && next.result)
    await inputs.verify([
      ...next.result.evidence,
      ...next.result.child_results.map((r) => r.evidence),
    ]);
  await journal.save(
    state,
    {
      ...state,
      schema_version: next.schema_version === 3 ? 2 : state.schema_version,
      revision: state.revision + 1,
      execution: next,
    },
    `execution:${run.task_id}:${event.id}`,
  );
  const saved = (await journal.read()).execution;
  requireWorkflow(saved !== null, 'execution-not-found');
  return saved;
}

export async function verifyCouncilInputs(
  council: Council | null,
  inputs: WorkflowInputs,
  projection?: LocalRun['projection'],
) {
  if (council === null) return;
  for (const selection of Object.values(council.selection))
    if (selection.trigger === true)
      requireWorkflow(
        compareInputs(selection.inputs, await inputs.current(selection.inputs, projection)) ===
          'applicable',
        'council-inputs-stale-or-unknown',
      );
}
