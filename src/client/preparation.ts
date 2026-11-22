import { requireClientTaskBackend } from './taskBackend.js';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import type { Client } from '@temporalio/client';
import { workflowKey, requireContract } from '../contracts/project.js';
import { parsePreparation } from '../policy/preparation.js';
import type { PreparationWorkflow } from '../workflows/preparation.js';
import type { PreparationInput } from '../contracts/preparation.js';

export async function startPreparation(client: Client, value: unknown, taskQueue: string) {
  const input = parsePreparation(value);
  requireClientTaskBackend(client, input);
  const handle = await client.workflow.start<typeof PreparationWorkflow>('PreparationWorkflow', {
    args: [input],
    taskQueue,
    workflowId: workflowKey(input.project.projectId, input.taskId),
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
  });
  const existing = await handle.query<PreparationInput>('preparationInput');
  requireContract(JSON.stringify(existing) === JSON.stringify(input), 'preparation-start-conflict');
  return handle;
}
