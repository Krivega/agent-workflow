import type { Client } from '@temporalio/client';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { LocalProjectRegistration, PreparationInput } from '../contracts/preparation.js';
import type { ReaderTarget } from '../contracts/readerControl.js';
import type { LocalTaskInput } from '../contracts/localTask.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { TaskStartPrincipalAuthority } from '../contracts/taskStartAdmission.js';
import type {
  TaskBackendAssignment,
  TaskBackendAssignmentV2,
} from '../adapters/project/taskBackend.js';
import { checkTaskStartAdmission } from '../adapters/project/taskStartAdmission.js';
import { identifier, object, parseProject, requireContract } from '../contracts/project.js';
import { checkRegistration, parsePreparation } from '../policy/preparation.js';
import { digest, readProjectFile } from '../adapters/artifacts/files.js';
import {
  parseTaskBackendRoute,
  taskBackendGuard,
  reserveTaskBackend,
  taskBackendPolicy,
} from '../adapters/project/taskBackend.js';
export { reserveTaskBackend, taskBackendPolicy } from '../adapters/project/taskBackend.js';
export {
  checkTaskStartAdmission,
  prepareTaskStartAdmission,
} from '../adapters/project/taskStartAdmission.js';
export type {
  TaskStartPrincipalAuthority,
  TaskStartDeclaration,
  VerifiedStartAdmission,
} from '../contracts/taskStartAdmission.js';
export type {
  TaskBackendAssignment,
  TaskBackendAssignmentV2,
  AnyTaskBackendAssignment,
  TaskBackendRoute,
} from '../adapters/project/taskBackend.js';

export type TaskBackendRegistration = Pick<
  LocalProjectRegistration,
  'project' | 'hostId' | 'owner' | 'generation' | 'workspaceRoot' | 'taskBackend'
> &
  Partial<Pick<LocalProjectRegistration, 'artifactRoot'>>;
type BoundRegistration = {
  registration: TaskBackendRegistration;
  guard: ReturnType<typeof taskBackendGuard>;
  principal?: Pick<TaskStartPrincipalAuthority, 'verify'>;
};
type BackendTarget = Pick<
  ReaderTarget,
  'projectId' | 'workspaceId' | 'taskId' | 'hostId' | 'owner' | 'generation'
>;
const registrations = new WeakMap<Client, Map<string, BoundRegistration>>();
function key(projectId: string, workspaceId: string) {
  return projectId + '/' + workspaceId;
}

export function bindTaskBackendClient(
  client: Client,
  value: TaskBackendRegistration,
  principal?: Pick<TaskStartPrincipalAuthority, 'verify'>,
) {
  const project = parseProject(value.project);
  requireContract(
    Number.isSafeInteger(value.generation) && value.generation > 0,
    'backend-generation-invalid',
  );
  requireContract(
    value.taskBackend === undefined || value.taskBackend === 'required',
    'backend-mode-invalid',
  );
  requireContract(
    principal === undefined || value.artifactRoot !== undefined,
    'task-start-artifact-root-required',
  );
  const registration = {
    project,
    hostId: identifier(value.hostId),
    owner: identifier(value.owner),
    generation: value.generation,
    workspaceRoot: realpathSync(value.workspaceRoot),
    ...(principal === undefined || value.artifactRoot === undefined
      ? {}
      : { artifactRoot: realpathSync(value.artifactRoot) }),
    ...(value.taskBackend === undefined ? {} : { taskBackend: value.taskBackend }),
  };
  const all = registrations.get(client) ?? new Map<string, BoundRegistration>();
  const id = key(project.projectId, project.workspaceId),
    prior = all.get(id);
  requireContract(
    prior === undefined ||
      (JSON.stringify(prior.registration) === JSON.stringify(registration) &&
        prior.principal === principal),
    'backend-client-already-bound',
  );
  if (prior === undefined)
    all.set(id, {
      registration,
      guard: taskBackendGuard(registration.workspaceRoot, registration.taskBackend === 'required'),
      ...(principal === undefined ? {} : { principal }),
    });
  else prior.guard.assert();
  registrations.set(client, all);
  return client;
}
function registered(client: Client, input: PreparationInput | BackendTarget) {
  const all = registrations.get(client);
  requireContract(all !== undefined, 'backend-client-unbound');
  const projectId = 'project' in input ? input.project.projectId : input.projectId;
  const workspaceId = 'project' in input ? input.project.workspaceId : input.workspaceId;
  const bound = all.get(key(projectId, workspaceId));
  requireContract(bound !== undefined, 'backend-client-project');
  const { registration } = bound;
  if ('project' in input) checkRegistration(input, registration);
  else
    requireContract(
      input.hostId === registration.hostId &&
        input.owner === registration.owner &&
        input.generation === registration.generation,
      'backend-client-identity',
    );
  return bound;
}
export function requireClientTaskBackend(client: Client, input: PreparationInput | BackendTarget) {
  const { registration, guard } = registered(client, input);
  const project = parseProject(registration.project);
  return guard.require(
    project.projectId,
    input.taskId,
    'temporal',
    'sdk',
    'project' in input ? input.card : undefined,
  );
}

type TaskBackendStartOptions = { taskQueue: string; checkInputs(): void };

function taskStartRoute(client: Client, taskQueue: string) {
  return parseTaskBackendRoute({
    address: object(object(client.connection).options).address,
    namespace: object(client.options).namespace,
    taskQueue,
  });
}

export function reserveNewTaskBackend(client: Client, value: unknown): TaskBackendAssignment;
export function reserveNewTaskBackend(
  client: Client,
  value: unknown,
  startAdmission: ArtifactRef,
  options?: TaskBackendStartOptions,
): Promise<TaskBackendAssignmentV2>;
export function reserveNewTaskBackend(
  client: Client,
  value: unknown,
  startAdmission?: ArtifactRef,
  options?: TaskBackendStartOptions,
): TaskBackendAssignment | Promise<TaskBackendAssignmentV2> {
  const input = parsePreparation(value);
  const { registration, guard, principal } = registered(client, input);
  guard.assert();
  const policy = taskBackendPolicy(registration.workspaceRoot);
  requireContract(policy !== null, 'backend-policy-required');
  requireContract(policy.newTasks === 'temporal', 'backend-new-tasks-blocked');
  if (policy.startAdmission !== undefined) {
    requireContract(
      startAdmission !== undefined &&
        principal !== undefined &&
        registration.artifactRoot !== undefined,
      'task-start-admission-required',
    );
    return reserveTaskBackend(
      registration.workspaceRoot,
      {
        schemaVersion: 2,
        projectId: input.project.projectId,
        taskId: input.taskId,
        backend: 'temporal',
        cardName: basename(input.card),
        origin: digest(readProjectFile(registration.workspaceRoot, input.card)),
        startAdmission,
        ...(options === undefined ? {} : { route: taskStartRoute(client, options.taskQueue) }),
      },
      {
        registration: { ...registration, artifactRoot: registration.artifactRoot },
        authority: principal,
        preparation: input,
        ...(options === undefined ? {} : { checkInputs: () => options.checkInputs() }),
      },
    );
  }
  requireContract(
    startAdmission === undefined && options === undefined,
    'task-start-policy-required',
  );
  return reserveTaskBackend(registration.workspaceRoot, {
    schemaVersion: 1,
    projectId: input.project.projectId,
    taskId: input.taskId,
    backend: policy.newTasks,
    cardName: basename(input.card),
    origin: digest(readProjectFile(registration.workspaceRoot, input.card)),
  });
}

export async function requireClientTaskStart(
  client: Client,
  input: LocalTaskInput,
  taskQueue?: string,
) {
  const preparation = input.admission.preparation;
  const { registration, guard, principal } = registered(client, preparation);
  const policy = guard.assert(),
    assignment = requireClientTaskBackend(client, preparation);
  if (input.schemaVersion !== 12) {
    requireContract(
      policy?.startAdmission === undefined && assignment?.schemaVersion !== 2,
      'task-start-admission-required',
    );
    return;
  }
  requireContract(
    assignment?.schemaVersion === 2 &&
      principal !== undefined &&
      registration.artifactRoot !== undefined,
    'task-start-admission-required',
  );
  const { route } = assignment;
  function verifyRoute() {
    if (route === undefined) return;
    requireContract(
      taskQueue !== undefined &&
        JSON.stringify(taskStartRoute(client, taskQueue)) === JSON.stringify(route),
      'task-start-route-conflict',
    );
  }
  verifyRoute();
  const admitted = await checkTaskStartAdmission(
    { ...registration, artifactRoot: registration.artifactRoot },
    principal,
    input.startAdmission,
    preparation,
    assignment,
  );
  verifyRoute();
  return admitted;
}
