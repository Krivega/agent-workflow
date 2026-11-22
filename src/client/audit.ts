import { requireClientTaskBackend } from './taskBackend.js';
import type { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import type { AuditWorkflow } from '../workflows/audit.js';
import { parseAuditInput, auditWorkflowKey } from '../policy/audit.js';
import { requireContract } from '../contracts/project.js';

export async function startAudit(client: Client, value: unknown, taskQueue: string) {
  const input = parseAuditInput(value);
  requireClientTaskBackend(client, input.preparation);
  const handle = await client.workflow.start<typeof AuditWorkflow>('AuditWorkflow', {
    workflowId: auditWorkflowKey(input),
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    taskQueue,
    args: [input],
  });
  requireContract(
    JSON.stringify(parseAuditInput(await handle.query('auditInput'))) === JSON.stringify(input),
    'audit-start-conflict',
  );
  return handle;
}
