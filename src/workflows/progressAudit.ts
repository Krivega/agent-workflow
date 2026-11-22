import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { AuditorActivities } from '../contracts/audit.js';
import type {
  TaskProgressContext,
  TaskProgressAuditActivities,
} from '../contracts/progressAudit.js';
import { auditClaim } from '../policy/audit.js';
import { verifiedTaskAudit, type StageAuditStatus } from './stageAudit.js';

export async function taskProgressCheckpoint(
  context: TaskProgressContext,
  status: StageAuditStatus,
) {
  const activities = proxyActivities<TaskProgressAuditActivities & AuditorActivities>({
    taskQueue: workflowInfo().taskQueue + '.audit',
    startToCloseTimeout: '20 minutes',
    heartbeatTimeout: '10 seconds',
    retry: { maximumAttempts: 1 },
  });
  const request = context.input.progress;
  status.claim = auditClaim(null, request.checkpoint, request.trigger, []);
  const preflight = await activities.preflightAuditor(context.input.admission.preparation);
  status.audit = await activities.prepareTaskProgressAudit(context, preflight);
  const audit = await verifiedTaskAudit(status.audit, status, 'task-progress');
  status.supervision = await activities.finishTaskProgressAudit({
    schemaVersion: 1,
    kind: 'task-progress-supervision',
    context,
    timing: null,
    claim: status.claim,
    audit,
  });
  return status.supervision;
}
