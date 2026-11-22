import { requireClientTaskBackend } from './taskBackend.js';
import type { Client } from '@temporalio/client';
import type { PayloadReaderCommand, ReaderCommandAck } from '../contracts/readerControl.js';
import { parsePayloadReaderCommand, readerCommandText } from '../policy/readerControl.js';
import { identifier, requireContract } from '../contracts/project.js';
import { digest } from '../adapters/artifacts/files.js';
import { isDeepStrictEqual } from 'node:util';
import type {
  TaskHumanCommand,
  TaskHumanCommandContext,
  TaskHumanReceipt,
  TaskHumanTarget,
  TaskHumanWaitResume,
} from '../contracts/taskHuman.js';
import type { HumanManagedTaskInput } from '../contracts/localTask.js';
import { checkTaskHumanWaitResume, parseTaskHumanWaitResume } from '../policy/taskExecution.js';
import { taskControlTarget } from '../policy/taskContinuation.js';
import { taskHumanCanonical } from '../policy/taskHuman.js';
import type { artifactStore } from '../adapters/artifacts/files.js';
import {
  parseTaskHumanCommand,
  parseTaskHumanTarget,
  taskHumanCommandText,
} from '../policy/taskHuman.js';
import { controlRef } from '../policy/readerControl.js';
import type { nativeTaskHumanAuthority } from '../adapters/codex/taskHumanAuthority.js';
export { extendTaskBudget } from '../worker/taskBudget.js';
export { artifactStore } from '../adapters/artifacts/files.js';
export { nativeTaskHumanAuthority } from '../adapters/codex/taskHumanAuthority.js';
export { nativeTaskSource } from '../adapters/codex/nativeTaskSource.js';
export type {
  NativeTaskIssuer,
  NativeTaskPrimarySource,
} from '../adapters/codex/nativeTaskSource.js';
export type { NativeHumanReferences } from '../adapters/codex/nativeHumanChoice.js';
export type {
  TaskHumanExecutionResume,
  TaskHumanCommand,
  TaskHumanCommandContext,
  TaskHumanReceipt,
  TaskHumanTarget,
  TaskHumanWaitResume,
} from '../contracts/taskHuman.js';
export type { ManagedTaskInput, HumanManagedTaskInput } from '../contracts/localTask.js';
export type {
  TaskExecutionResume,
  TaskExecutionProgress,
  TaskExecutionBudget,
  TaskExecutionCheckpoint,
  TaskExecutionCompletion,
  TaskExecutionDiagnostic,
} from '../contracts/taskExecution.js';

export function makeTaskExecutionCommand(
  value: Omit<PayloadReaderCommand, 'hash'>,
): PayloadReaderCommand {
  const command = parsePayloadReaderCommand({ ...value, hash: '0'.repeat(64) });
  requireContract(command.target.roleId === 'task', 'task-command-action');
  return { ...command, hash: digest(readerCommandText(command)) };
}
export async function controlTaskExecution(
  client: Client,
  workflowId: string,
  value: unknown,
  runId?: string,
): Promise<ReaderCommandAck> {
  const command = parsePayloadReaderCommand(value);
  requireContract(
    command.target.workflowId === workflowId &&
      command.target.roleId === 'task' &&
      digest(readerCommandText(command)) === command.hash,
    'task-command-hash-invalid',
  );
  requireClientTaskBackend(client, command.target);
  const handle =
    runId === undefined
      ? client.workflow.getHandle(workflowId)
      : client.workflow.getHandle(workflowId, identifier(runId));
  const ack = await handle.executeUpdate<ReaderCommandAck, [PayloadReaderCommand]>(
    'taskExecutionControl',
    {
      args: [command],
    },
  );
  requireContract(
    ack.commandId === command.commandId &&
      ack.hash === command.hash &&
      ack.revision === command.expectedRevision + 1,
    'task-command-receipt-invalid',
  );
  return ack;
}

/** Uses a separate Update; PAUSE/RESUME never becomes human acceptance. */
export async function controlTaskHuman(
  client: Client,
  workflowId: string,
  value: unknown,
  runId?: string,
): Promise<TaskHumanReceipt> {
  const command = parseTaskHumanCommand(value);
  requireContract(
    command.target.workflowId === workflowId &&
      digest(taskHumanCommandText(command)) === command.hash,
    'task-human-command-hash-invalid',
  );
  requireClientTaskBackend(client, command.target);
  const handle =
    runId === undefined
      ? client.workflow.getHandle(workflowId)
      : client.workflow.getHandle(workflowId, identifier(runId));
  const receipt = await handle.executeUpdate<TaskHumanReceipt, [TaskHumanCommand]>('taskHuman', {
    args: [command],
  });
  requireContract(
    receipt.commandId === command.commandId &&
      receipt.hash === command.hash &&
      receipt.revision === command.expectedRevision + 1 &&
      receipt.requirementsRevision === command.target.requirementsRevision,
    'task-human-command-receipt-invalid',
  );
  controlRef(receipt.proof);
  return receipt;
}

export async function queryTaskHuman(
  client: Client,
  workflowId: string,
  rawTarget: TaskHumanTarget,
  runId?: string,
): Promise<TaskHumanCommandContext | null> {
  const target = parseTaskHumanTarget(rawTarget);
  requireContract(target.workflowId === workflowId, 'task-human-query-target');
  requireClientTaskBackend(client, target);
  const handle =
    runId === undefined
      ? client.workflow.getHandle(workflowId)
      : client.workflow.getHandle(workflowId, identifier(runId));
  const context = await handle.query<TaskHumanCommandContext | null>('taskHumanState');
  if (context === null) return null;
  requireContract(
    context.input.schemaVersion === 12 &&
      isDeepStrictEqual(context.state.current.manifest.target, target) &&
      isDeepStrictEqual(context.technical.input, context.input),
    'task-human-query-context',
  );
  return context;
}

type TaskHumanAuthority = ReturnType<typeof nativeTaskHumanAuthority>;

/** Resuming human wait retains technical work; only changed requirements advance attempt. */
export function makeTaskHumanWaitResumeCommand(
  input: HumanManagedTaskInput,
  fields: Pick<PayloadReaderCommand, 'commandId' | 'expectedRevision' | 'author' | 'source'>,
  value: TaskHumanWaitResume,
  store: Pick<ReturnType<typeof artifactStore>, 'publish'>,
): PayloadReaderCommand {
  const payload = parseTaskHumanWaitResume(value),
    replan = checkTaskHumanWaitResume(input, payload);
  requireContract(fields.author === input.admission.preparation.owner, 'task-human-resume-author');
  return makeTaskExecutionCommand({
    schemaVersion: 2,
    ...fields,
    target: taskControlTarget(input),
    action: 'resume',
    attempt: input.continuation.attempt + (replan ? 1 : 0),
    payload: store.publish(Buffer.from(taskHumanCanonical(payload))),
  });
}
async function currentHumanContext(
  client: Client,
  workflowId: string,
  target: TaskHumanTarget,
  runId?: string,
) {
  const context = await queryTaskHuman(client, workflowId, target, runId);
  requireContract(context !== null, 'task-human-technical-result-not-ready');
  return context;
}

export async function prepareTaskHumanAsk(
  client: Client,
  workflowId: string,
  target: TaskHumanTarget,
  authority: Pick<TaskHumanAuthority, 'prepareAsk'>,
  value: Parameters<TaskHumanAuthority['prepareAsk']>[1],
  runId?: string,
) {
  return authority.prepareAsk(await currentHumanContext(client, workflowId, target, runId), value);
}

/** Returns exact UI arguments only after the durable ASK is visible in Workflow state. */
export async function prepareTaskHumanQuestion(
  client: Client,
  workflowId: string,
  target: TaskHumanTarget,
  authority: Pick<TaskHumanAuthority, 'prepareQuestion'>,
  runId?: string,
) {
  return authority.prepareQuestion(await currentHumanContext(client, workflowId, target, runId));
}

/** Choice is derived from primary native records; the caller supplies no accepted boolean. */
export async function prepareTaskHumanDecision(
  client: Client,
  workflowId: string,
  target: TaskHumanTarget,
  authority: Pick<TaskHumanAuthority, 'makeDecision'>,
  value: Parameters<TaskHumanAuthority['makeDecision']>[1],
  runId?: string,
) {
  return authority.makeDecision(
    await currentHumanContext(client, workflowId, target, runId),
    value,
  );
}
