import {
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  condition,
  executeChild,
  proxyActivities,
  workflowInfo,
} from '@temporalio/workflow';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { AuditInput, AuditTiming, AuditorActivities } from '../contracts/audit.js';
import type {
  TaskStageAudit,
  TaskStageContext,
  TaskStageAuditActivities,
} from '../contracts/stageAudit.js';
import { auditClaim, auditWorkflowKey } from '../policy/audit.js';
import { AuditWorkflow } from './audit.js';

export interface StageAuditStatus {
  claim: string | null;
  audit: AuditInput | null;
  result: ArtifactRef | null;
  stop: ArtifactRef | null;
  supervision: ArtifactRef | null;
}
export async function supervisedOperation<T>(
  stage: string,
  estimateMs: number,
  status: StageAuditStatus,
  operation: () => Promise<T>,
  prepare: (timing: AuditTiming) => Promise<AuditInput>,
  finish: (timing: AuditTiming, audit: TaskStageAudit['audit']) => Promise<ArtifactRef>,
) {
  const began = Date.now();
  let knownElapsedMs = 0,
    elapsedMs: number | null = 0;
  function timing() {
    const delta = Date.now() - began;
    if (delta < knownElapsedMs) elapsedMs = null;
    knownElapsedMs = Math.max(knownElapsedMs, delta);
    if (elapsedMs !== null) elapsedMs = knownElapsedMs;
    return { stage, estimateMs, elapsedMs, externalWaitMs: 0, knownElapsedMs };
  }
  const scope = new CancellationScope();
  let settled = false;
  const pending = scope.run(operation).then(
    (result) => {
      settled = true;
      return { ok: true as const, result, timing: timing() };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  try {
    await condition(() => settled, estimateMs * 2);
    const observed = settled ? await pending : null;
    if (observed !== null && !observed.ok) throw observed.error;
    const checkpoint = observed === null ? timing() : observed.timing;
    let audit: TaskStageAudit['audit'] = null;
    if (!settled || checkpoint.knownElapsedMs >= estimateMs * 2) {
      status.claim = auditClaim(checkpoint, stage + '-overrun', { kind: 'overrun' }, []);
      status.audit = await prepare(checkpoint);
      audit = await verifiedTaskAudit(status.audit, status, stage);
    }
    const completed = await pending;
    if (!completed.ok) throw completed.error;
    status.supervision = await finish(completed.timing, audit);
    return { result: completed.result, supervision: status.supervision };
  } catch (error) {
    scope.cancel();
    await CancellationScope.nonCancellable(() => pending);
    throw error;
  }
}

export async function supervisedTaskStage<T>(
  context: TaskStageContext,
  status: StageAuditStatus,
  operation: () => Promise<T>,
) {
  const activities = proxyActivities<TaskStageAuditActivities & AuditorActivities>({
    taskQueue: workflowInfo().taskQueue + '.audit',
    startToCloseTimeout: '20 minutes',
    heartbeatTimeout: '10 seconds',
    retry: { maximumAttempts: 1 },
  });
  return supervisedOperation(
    context.stage,
    context.input.audit.stages[context.stage],
    status,
    operation,
    async (timing) => {
      const preflight = await activities.preflightAuditor(context.input.admission.preparation);
      return activities.prepareTaskStageAudit(context, timing, preflight);
    },
    (timing, audit) =>
      activities.finishTaskStageAudit({
        schemaVersion: 1,
        kind: 'task-stage-supervision',
        context,
        timing,
        claim: status.claim,
        audit,
      }),
  );
}

export async function verifiedTaskAudit(
  input: AuditInput,
  status: StageAuditStatus,
  stage: string,
): Promise<NonNullable<TaskStageAudit['audit']>> {
  const queue = workflowInfo().taskQueue + '.audit';
  const activities = proxyActivities<TaskStageAuditActivities & AuditorActivities>({
    taskQueue: queue,
    startToCloseTimeout: '20 minutes',
    heartbeatTimeout: '10 seconds',
    retry: { maximumAttempts: 1 },
  });
  const result = await executeChild(AuditWorkflow, {
    args: [input],
    taskQueue: queue,
    workflowId: auditWorkflowKey(input),
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
    cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
  });
  status.stop = result.stop;
  if (CancellationScope.current().consideredCancelled)
    await CancellationScope.current().cancelRequested;
  if (result.status !== 'audited')
    throw ApplicationFailure.nonRetryable('task-' + stage + '-audit-blocked', 'TaskAuditHeld');
  status.result = result.manifest;
  const verified = await activities.verifyAuditResult(input, result.manifest, result.stop);
  if (verified.report.coverage !== 'complete' || verified.report.direction !== 'continue')
    throw ApplicationFailure.nonRetryable(
      'task-' + stage + '-audit-held:' + result.manifest.sha256,
      'TaskAuditHeld',
    );
  return { input, result: result.manifest, stop: result.stop };
}
