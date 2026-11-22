import { requireClientTaskBackend } from './taskBackend.js';
import type { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import type { LocalAdmissionInput } from '../contracts/localAdmission.js';
import type { LocalAdmissionWorkflow } from '../workflows/localAdmission.js';
import { localAdmissionKey, parseLocalAdmission } from '../policy/localAdmission.js';
import { requireContract } from '../contracts/project.js';

export async function startLocalAdmission(client: Client, value: unknown, taskQueue: string) {
  const input = parseLocalAdmission(value);
  requireClientTaskBackend(client, input.preparation);
  const handle = await client.workflow.start<typeof LocalAdmissionWorkflow>(
    'LocalAdmissionWorkflow',
    {
      args: [input],
      taskQueue,
      workflowId: localAdmissionKey(input),
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    },
  );
  const accepted = await handle.query<LocalAdmissionInput>('localAdmissionInput');
  requireContract(
    JSON.stringify(parseLocalAdmission(accepted)) === JSON.stringify(input),
    'local-admission-start-conflict',
  );
  return handle;
}
