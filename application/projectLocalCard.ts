import { requireWorkflow } from '../core/connection.js';
import type { LocalRun } from '../core/localRun.js';
import { assertRunAction } from '../core/localRun.js';
import type { CardCompletion, FileChange, ProjectStatus } from '../core/card.js';
import type { LocalRuns, RunInputs } from '../ports/localRuns.js';
import type { ProjectCards } from '../ports/projectCards.js';

function assertProjection(run: LocalRun, cancelled: boolean) {
  if (cancelled) {
    requireWorkflow(
      run.status === 'cancelled' && run.cancellation !== null,
      'cancellation-required',
    );
    requireWorkflow(
      run.spec.writer === run.spec.run_id &&
        run.type !== 'role' &&
        run.spec.requested.permissions.includes('update-card'),
      'cancellation-projection-forbidden',
    );
  } else assertRunAction(run, 'update-card');
}

async function applyProjection(
  pending: LocalRun,
  taskId: string,
  runs: LocalRuns,
  cards: ProjectCards,
) {
  const plan = pending.projection!.plan;
  const result = await cards.apply(plan);
  const next = { ...pending, revision: pending.revision + 1, projection: { plan, result } };
  if (result.status === 'confirmed')
    next.spec = {
      ...next.spec,
      identity: {
        task_id: taskId,
        card: { locator: result.locator, hash: result.revision },
      },
    };
  await runs.save(pending, next);
  return next;
}

// The caller supplies an accepted status decision. AW5 owns acceptance, not this projection.
export async function projectLocalCard(
  status: ProjectStatus,
  operation: string,
  runs: LocalRuns,
  cards: ProjectCards,
  inputs: RunInputs,
  completion?: CardCompletion,
) {
  const run = await runs.read();
  requireWorkflow(run !== null, 'run-not-found');
  assertProjection(run, status === 'cancelled');
  requireWorkflow(
    run.spec.writer === run.spec.run_id && 'task_id' in run.spec.identity,
    'not-card-writer',
  );
  const identity = run.spec.identity;
  let pending = run;
  if (run.projection?.result.status !== 'pending') {
    await inputs.verify(run);
    const card = await cards.read(identity.card.locator);
    requireWorkflow(
      card.revision === identity.card.hash &&
        card.task_id === identity.task_id &&
        card.project_id === run.spec.project_id,
      'card-revision-conflict',
    );
    const plan = await cards.prepare(card, status, operation, completion);
    pending = {
      ...run,
      revision: run.revision + 1,
      projection: { plan, result: { status: 'pending', conflicts: [] } },
    };
    await runs.save(run, pending);
  }
  const plan = pending.projection!.plan;
  requireWorkflow(plan.operation_id === operation, 'reconciliation-pending');
  return applyProjection(pending, identity.task_id, runs, cards);
}

export async function reconcileLocalCard(
  resolution: { previous_id: string; operation_id: string; decision: string; files: FileChange[] },
  runs: LocalRuns,
  cards: ProjectCards,
) {
  const run = await runs.read();
  requireWorkflow(
    run !== null && run.projection?.result.status === 'pending',
    'no-pending-projection',
  );
  assertProjection(run, run.status === 'cancelled');
  requireWorkflow(
    run.spec.writer === run.spec.run_id && 'task_id' in run.spec.identity,
    'not-card-writer',
  );
  const old = run.projection.plan;
  requireWorkflow(
    resolution.previous_id === old.operation_id &&
      resolution.operation_id !== old.operation_id &&
      resolution.decision.trim().length > 0,
    'invalid-reconciliation',
  );
  requireWorkflow(
    resolution.files.length > 0 &&
      new Set(resolution.files.map((f) => f.locator)).size === resolution.files.length &&
      resolution.files.every((f) => old.changes.some((c) => c.locator === f.locator)),
    'reconciliation-scope-mismatch',
  );
  const plan = {
    ...old,
    operation_id: resolution.operation_id,
    supersedes: { operation_id: old.operation_id, decision: resolution.decision },
    changes: old.changes.map(
      (change) => resolution.files.find((f) => f.locator === change.locator) ?? change,
    ),
  };
  const pending = {
    ...run,
    revision: run.revision + 1,
    projection: { plan, result: { status: 'pending' as const, conflicts: [] } },
  };
  await runs.save(run, pending);
  return applyProjection(pending, run.spec.identity.task_id, runs, cards);
}
