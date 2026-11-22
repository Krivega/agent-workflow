import {
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  executeChild,
  proxyActivities,
  patched,
  workflowInfo,
} from '@temporalio/workflow';
import type { SupervisedTaskInput } from '../contracts/localTask.js';
import type { ReviewInput } from '../contracts/review.js';
import type { AuditorActivities } from '../contracts/audit.js';
import type {
  TaskAuditActivities,
  TaskPlanningProgressActivities,
} from '../contracts/taskAudit.js';
import { reviewKey } from '../policy/review.js';
import { ReviewWorkflow } from './review.js';
import { supervisedOperation, type StageAuditStatus } from './stageAudit.js';
export type PlanningAuditStatus = StageAuditStatus;

export async function supervisedPlanning(
  input: SupervisedTaskInput,
  planning: ReviewInput,
  status: PlanningAuditStatus,
) {
  const activities = proxyActivities<AuditorActivities & TaskAuditActivities>({
    taskQueue: workflowInfo().taskQueue + '.audit',
    startToCloseTimeout: '20 minutes',
    heartbeatTimeout: '10 seconds',
    retry: { maximumAttempts: 1 },
  });
  const preflight = await activities.preflightAuditor(input.admission.preparation);
  const observations = proxyActivities<TaskPlanningProgressActivities>({
    taskQueue: workflowInfo().taskQueue + '.control',
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 1 },
  });
  const completed = await supervisedOperation(
    'planning',
    input.audit.planningEstimateMs,
    status,
    () =>
      executeChild(ReviewWorkflow, {
        args: [planning],
        workflowId: reviewKey(planning),
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      }),
    async (timing) => {
      const progress = patched('task-planning-audit-primary-progress')
        ? await observations.captureTaskPlanningProgress(input, planning)
        : null;
      return progress === null
        ? activities.prepareTaskPlanningAudit(input, planning, preflight, timing)
        : activities.prepareTaskPlanningAudit(input, planning, preflight, timing, progress);
    },
    (timing, audit) =>
      activities.finishTaskPlanningAudit({
        schemaVersion: 1,
        kind: 'task-planning-supervision',
        input,
        planning,
        timing,
        claim: status.claim,
        audit,
      }),
  );
  return { review: completed.result, supervision: completed.supervision };
}
