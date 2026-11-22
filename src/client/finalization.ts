import { requireClientTaskBackend } from './taskBackend.js';
import type { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import type { ArchiveCommand } from '../contracts/readerControl.js';
import type { FinalizationInput } from '../contracts/finalization.js';
import type { FinalizationWorkflow } from '../workflows/finalization.js';
import { finalizationKey, parseFinalization } from '../policy/finalization.js';
import { parseArchiveCommand, readerCommandText } from '../policy/readerControl.js';
import { requireContract } from '../contracts/project.js';
import { digest } from '../adapters/artifacts/files.js';

export function makeArchiveCommand(value: Omit<ArchiveCommand, 'hash'>): ArchiveCommand {
  const command = parseArchiveCommand({ ...value, hash: '0'.repeat(64) });
  return { ...command, hash: digest(readerCommandText(command)) };
}
export async function startFinalization(client: Client, value: unknown, taskQueue: string) {
  const input = parseFinalization(value);
  requireContract(
    digest(readerCommandText(input.command)) === input.command.hash,
    'archive-command-hash-invalid',
  );
  requireClientTaskBackend(client, input.preparation);
  const handle = await client.workflow.start<typeof FinalizationWorkflow>('FinalizationWorkflow', {
    args: [input],
    taskQueue,
    workflowId: finalizationKey(input),
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
  });
  requireContract(
    JSON.stringify(
      parseFinalization(await handle.query<FinalizationInput>('finalizationInput')),
    ) === JSON.stringify(input),
    'finalization-start-conflict',
  );
  return handle;
}
