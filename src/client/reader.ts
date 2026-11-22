import { requireClientTaskBackend } from './taskBackend.js';
import type { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import type { ReaderInput } from '../contracts/reader.js';
import type { ReaderCommand, ReaderCommandAck } from '../contracts/readerControl.js';
import type { ControlledReaderWorkflow } from '../workflows/controlledReader.js';
import {
  parseReaderCommand,
  parseReaderInput,
  readerCommandText,
  readerKey,
} from '../policy/readerControl.js';
import { requireContract } from '../contracts/project.js';
import { digest } from '../adapters/artifacts/files.js';

export function makeReaderCommand(value: Omit<ReaderCommand, 'hash'>): ReaderCommand {
  const command = parseReaderCommand({ ...value, hash: '0'.repeat(64) });
  return { ...command, hash: digest(readerCommandText(command)) };
}
export async function startControlledReader(client: Client, value: unknown, taskQueue: string) {
  const input = parseReaderInput(value);
  requireClientTaskBackend(client, input.preparation);
  const handle = await client.workflow.start<typeof ControlledReaderWorkflow>(
    'ControlledReaderWorkflow',
    {
      args: [input],
      taskQueue,
      workflowId: readerKey(input),
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    },
  );
  const accepted = parseReaderInput(await handle.query<ReaderInput>('readerInput'));
  requireContract(JSON.stringify(accepted) === JSON.stringify(input), 'reader-start-conflict');
  return handle;
}
export async function controlReader(
  client: Client,
  workflowId: string,
  value: unknown,
): Promise<ReaderCommandAck> {
  const command = parseReaderCommand(value);
  requireContract(
    command.target.workflowId === workflowId && digest(readerCommandText(command)) === command.hash,
    'reader-command-hash-invalid',
  );
  requireClientTaskBackend(client, command.target);
  const ack = await client.workflow
    .getHandle(workflowId)
    .executeUpdate<ReaderCommandAck, [ReaderCommand]>('readerControl', {
      args: [command],
    });
  requireContract(
    ack.commandId === command.commandId &&
      ack.hash === command.hash &&
      ack.revision === command.expectedRevision + 1,
    'reader-command-receipt-invalid',
  );
  return ack;
}
