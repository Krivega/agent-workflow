import { requireClientTaskBackend } from './taskBackend.js';
import type { Client } from '@temporalio/client';
import type { PayloadReaderCommand, ReaderCommandAck } from '../contracts/readerControl.js';
import { parsePayloadReaderCommand, readerCommandText } from '../policy/readerControl.js';
import { requireContract } from '../contracts/project.js';
import { digest } from '../adapters/artifacts/files.js';

export function makeTaskPlanningCommand(
  value: Omit<PayloadReaderCommand, 'hash'>,
): PayloadReaderCommand {
  const command = parsePayloadReaderCommand({ ...value, hash: '0'.repeat(64) });
  requireContract(
    command.action === 'resume' && command.target.roleId === 'task',
    'task-command-action',
  );
  return { ...command, hash: digest(readerCommandText(command)) };
}
export async function controlTaskPlanning(
  client: Client,
  workflowId: string,
  value: unknown,
): Promise<ReaderCommandAck> {
  const command = parsePayloadReaderCommand(value);
  requireContract(
    command.target.workflowId === workflowId &&
      command.action === 'resume' &&
      command.target.roleId === 'task' &&
      digest(readerCommandText(command)) === command.hash,
    'task-command-hash-invalid',
  );
  requireClientTaskBackend(client, command.target);
  const ack = await client.workflow
    .getHandle(workflowId)
    .executeUpdate<ReaderCommandAck, [PayloadReaderCommand]>('taskPlanningControl', {
      args: [command],
    });
  requireContract(
    ack.commandId === command.commandId &&
      ack.hash === command.hash &&
      ack.revision === command.expectedRevision + 1,
    'task-command-receipt-invalid',
  );
  return ack;
}
