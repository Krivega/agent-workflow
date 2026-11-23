import {
  bindTaskBackendClient,
  requireClientTaskStart,
  reserveNewTaskBackend,
} from './taskBackend.js';
import { Client, Connection } from '@temporalio/client';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { LocalTaskInput } from '../contracts/localTask.js';
import type {
  ArtifactRef,
  LocalProjectRegistration,
  PreparationInput,
} from '../contracts/preparation.js';
import type {
  TaskStartAssignment,
  VerifiedStartAdmission,
} from '../contracts/taskStartAdmission.js';
import type { LocalTaskWorkflow } from '../workflows/localTask.js';
import { localTaskKey, parseLocalTask } from '../policy/localTask.js';
import {
  exactFields,
  identifier,
  object,
  parseProject,
  requireContract,
  text,
} from '../contracts/project.js';
import { nativeTaskSource } from '../adapters/codex/nativeTaskSource.js';
import { artifactStore, digest } from '../adapters/artifacts/files.js';
import { taskBackendPolicy } from '../adapters/project/taskBackend.js';
import { checkTaskStartAdmission } from '../adapters/project/taskStartAdmission.js';
import { checkSubstantialStartInputs } from '../activities/substantialTask.js';
import { buildPreparedTaskPreview } from './taskStartPreview.js';

export async function startLocalTask(
  client: Client,
  value: unknown,
  taskQueue: string,
  checkInputs?: () => void,
  onSubmit?: (workflowId: string) => void,
) {
  const input = parseLocalTask(value);
  requireContract(
    (input.schemaVersion !== 10 && input.schemaVersion !== 11 && input.schemaVersion !== 12) ||
      input.continuation.attempt === 0,
    'task-continuation-start-forbidden',
  );
  await requireClientTaskStart(client, input, taskQueue);
  checkInputs?.();
  const workflowId = localTaskKey(input);
  onSubmit?.(workflowId);
  const handle = await client.workflow.start<typeof LocalTaskWorkflow>('LocalTaskWorkflow', {
    args: [input],
    taskQueue,
    workflowId,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
  });
  const current = await handle.query<LocalTaskInput>('localTaskInput');
  requireContract(
    JSON.stringify(parseLocalTask(current)) === JSON.stringify(input),
    'local-task-start-conflict',
  );
  return handle;
}

function preparedRegistration(value: unknown, workspace: string): LocalProjectRegistration {
  const row = object(value);
  exactFields(row, [
    'project',
    'hostId',
    'owner',
    'generation',
    'workspaceRoot',
    'artifactRoot',
    'commands',
    'taskBackend',
  ]);
  const generation = row.generation;
  requireContract(row.workspaceRoot === workspace, 'task-chat-temporal-workspace');
  requireContract(row.taskBackend === 'required', 'backend-registration-invalid');
  requireContract(
    typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0,
    'backend-generation-invalid',
  );
  const commands = Object.fromEntries(
    Object.entries(object(row.commands)).map(([id, value]) => {
      const command = object(value),
        timeoutMs = command.timeoutMs;
      exactFields(command, [
        'executable',
        'args',
        ...(timeoutMs === undefined ? [] : ['timeoutMs']),
      ]);
      requireContract(
        Array.isArray(command.args) &&
          command.args.every((arg: unknown) => typeof arg === 'string' && !arg.includes('\0')) &&
          (timeoutMs === undefined ||
            (typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0)),
        'invalid-registered-command',
      );
      return [
        identifier(id),
        {
          executable: text(command.executable),
          args: command.args as string[],
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      ];
    }),
  );
  return {
    project: parseProject(row.project),
    hostId: identifier(row.hostId),
    owner: identifier(row.owner),
    generation,
    workspaceRoot: workspace,
    artifactRoot: text(row.artifactRoot),
    commands,
    taskBackend: 'required',
  };
}

export function parsePreparedTaskRegistration(config: unknown, workspace: string) {
  const settings = object(config);
  exactFields(settings, ['schemaVersion', 'address', 'namespace', 'taskQueue', 'registration']);
  requireContract(settings.schemaVersion === 1, 'task-chat-temporal-registration-version');
  const address = text(settings.address),
    namespace = text(settings.namespace),
    taskQueue = text(settings.taskQueue),
    registration = preparedRegistration(settings.registration, workspace);
  return { address, namespace, taskQueue, registration };
}

function preparedTaskStart(workspace: string, value: unknown, config: unknown) {
  const policy = taskBackendPolicy(workspace);
  requireContract(policy?.startAdmission !== undefined, 'task-start-policy-required');
  requireContract(policy.newTasks === 'temporal', 'backend-new-tasks-blocked');
  const route = parsePreparedTaskRegistration(config, workspace);
  const input = parseLocalTask(value);
  requireContract(input.schemaVersion === 12, 'task-chat-temporal-input-version');
  requireContract(input.continuation.attempt === 0, 'task-continuation-start-forbidden');
  return { policy, route, input };
}

function preparedTaskAuthority(registration: LocalProjectRegistration, threadId: string) {
  return nativeTaskSource(artifactStore(registration.artifactRoot, { existingOnly: true }), {
    sessionsRoot: resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'sessions'),
    chatWorkspace: registration.workspaceRoot,
    threadId,
    owner: registration.owner,
  });
}

export function verifyPreparedTaskAdmission(
  registration: LocalProjectRegistration,
  ref: ArtifactRef,
  preparation: PreparationInput,
  threadId: string,
  assignment: TaskStartAssignment,
) {
  return checkTaskStartAdmission(
    registration,
    preparedTaskAuthority(registration, threadId),
    ref,
    preparation,
    assignment,
    { card: 'retained' },
  );
}

function checkedPreview(
  prepared: ReturnType<typeof preparedTaskStart>,
  admission: VerifiedStartAdmission,
) {
  const { route, input } = prepared;
  const { summary, fingerprint } = buildPreparedTaskPreview(route.registration, input, admission);
  const previewDigest = digest(JSON.stringify({ ...prepared, fingerprint }));
  return { summary, previewDigest };
}

export async function previewPreparedLocalTask(workspace: string, value: unknown, config: unknown) {
  const prepared = preparedTaskStart(workspace, value, config);
  const {
    input,
    route: { registration },
  } = prepared;
  const authority = preparedTaskAuthority(registration, identifier(process.env.CODEX_THREAD_ID));
  const admission = await checkTaskStartAdmission(
    registration,
    authority,
    input.startAdmission,
    input.admission.preparation,
  );
  requireContract(admission.admission.previous === null, 'task-start-initial-required');
  return {
    status: 'preview',
    backend: 'temporal',
    workflowId: localTaskKey(input),
    ...checkedPreview(prepared, admission),
  };
}

/** Submit an initial task with an already issued primary admission. */
export async function startPreparedLocalTask(
  workspace: string,
  value: unknown,
  config: unknown,
  options?: {
    onSubmit?: (workflowId: string) => void;
    previewDigest?: string;
    checkFiles?: () => void;
  },
) {
  const prepared = preparedTaskStart(workspace, value, config);
  const {
    input,
    route: { address, namespace, taskQueue, registration },
  } = prepared;
  checkSubstantialStartInputs(registration, input);
  const authority = preparedTaskAuthority(registration, identifier(process.env.CODEX_THREAD_ID));
  const preparation = input.admission.preparation;
  const admission = await checkTaskStartAdmission(
    registration,
    authority,
    input.startAdmission,
    preparation,
  );
  requireContract(admission.admission.previous === null, 'task-start-initial-required');
  const checkInputs = () => {
    options?.checkFiles?.();
    if (options?.previewDigest === undefined) {
      checkSubstantialStartInputs(registration, input);
      return;
    }
    requireContract(
      JSON.stringify(taskBackendPolicy(workspace)) === JSON.stringify(prepared.policy) &&
        checkedPreview(prepared, admission).previewDigest === options.previewDigest,
      'task-chat-temporal-preview-changed',
    );
  };
  if (options?.previewDigest !== undefined) checkInputs();
  const connection = Connection.lazy({ address });
  try {
    const client = bindTaskBackendClient(
      new Client({ connection, namespace }),
      registration,
      authority,
    );
    await reserveNewTaskBackend(client, preparation, input.startAdmission, {
      taskQueue,
      checkInputs,
    });
    const handle = await startLocalTask(client, input, taskQueue, checkInputs, options?.onSubmit);
    return { status: 'accepted', backend: 'temporal', workflowId: handle.workflowId };
  } finally {
    await connection.close();
  }
}
