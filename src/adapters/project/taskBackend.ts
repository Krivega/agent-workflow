import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
  text,
} from '../../contracts/project.js';
import { privateDirectory, publishFile, readPrivateFile } from '../artifacts/files.js';
import { digest, readProjectFile } from '../artifacts/files.js';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type { TaskStartAdmissionContext } from '../../contracts/taskStartAdmission.js';
import { controlRef } from '../../policy/readerControl.js';
import { checkTaskStartAdmission } from './taskStartAdmission.js';

export type TaskBackend = 'legacy' | 'temporal';
export interface TaskBackendAssignment {
  schemaVersion: 1;
  projectId: string;
  taskId: string;
  backend: TaskBackend;
  cardName: string;
  origin: string;
}
export interface TaskBackendAssignmentV2 extends Omit<
  TaskBackendAssignment,
  'schemaVersion' | 'backend'
> {
  schemaVersion: 2;
  backend: 'temporal';
  startAdmission: ArtifactRef;
  route?: TaskBackendRoute;
}
export interface TaskBackendRoute {
  address: string;
  namespace: string;
  taskQueue: string;
}
export type AnyTaskBackendAssignment = TaskBackendAssignment | TaskBackendAssignmentV2;
const consumers = ['legacy', 'sdk', 'worker'] as const;

export function taskBackendHome(workspace: string): string {
  const root = realpathSync(workspace);
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      NODE_ENV: process.env.NODE_ENV,
      LC_ALL: 'C',
    },
  }).trim();
  return join(realpathSync(resolve(root, common)), 'agent-workflow');
}

function backendLocation(workspace: string) {
  try {
    return taskBackendHome(workspace);
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer };
    if (failure.status === 128 && failure.stderr?.toString().includes('not a git repository'))
      return null;
    throw error;
  }
}
export function taskBackendPolicy(workspace: string) {
  const workspaceRequired = declaration(
    join(realpathSync(workspace), '.agent-workflow-backend.json'),
  );
  return readBackendPolicy(workspaceRequired, backendLocation(workspace));
}

function readBackendPolicy(workspaceRequired: boolean, home: string | null) {
  if (home === null) {
    requireContract(!workspaceRequired, 'backend-policy-required');
    return null;
  }
  const commonRequired = declaration(join(dirname(home), 'agent-workflow-backend.json'));
  const path = join(home, 'backend-policy.json');
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined) {
    requireContract(
      !workspaceRequired && !commonRequired && !existsSync(join(home, 'backend-assignments')),
      'backend-policy-required',
    );
    return null;
  }
  requireContract(workspaceRequired || commonRequired, 'backend-activation-required');
  requireContract(metadata.nlink === 1, 'backend-policy-linked');
  const value = object(JSON.parse(readPrivateFile(path).toString()));
  exactFields(value, [
    'schemaVersion',
    'newTasks',
    ...(value.schemaVersion === 2 ? ['startAdmission'] : []),
  ]);
  requireContract(
    (value.schemaVersion === 1 ||
      (value.schemaVersion === 2 && value.startAdmission === 'task-start-admission/1')) &&
      (value.newTasks === 'temporal' || value.newTasks === 'blocked'),
    'backend-policy-invalid',
  );
  return {
    home,
    newTasks: value.newTasks,
    ...(value.schemaVersion === 2 ? { startAdmission: 'task-start-admission/1' as const } : {}),
  };
}

function declaration(path: string): boolean {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined) return false;
  requireContract(metadata.nlink === 1, 'backend-declaration-linked');
  const value = object(JSON.parse(readPrivateFile(path).toString()));
  exactFields(value, ['schemaVersion', 'required']);
  requireContract(
    value.schemaVersion === 1 && value.required === true,
    'backend-declaration-invalid',
  );
  return true;
}

export function parseTaskBackendRoute(value: unknown): TaskBackendRoute {
  const route = object(value);
  exactFields(route, ['address', 'namespace', 'taskQueue']);
  return {
    address: text(route.address),
    namespace: text(route.namespace),
    taskQueue: text(route.taskQueue),
  };
}

function assignment(value: unknown): AnyTaskBackendAssignment {
  const row = object(value);
  exactFields(row, [
    'schemaVersion',
    'projectId',
    'taskId',
    'backend',
    'cardName',
    'origin',
    ...(row.schemaVersion === 2
      ? ['startAdmission', ...(row.route === undefined ? [] : ['route'])]
      : []),
  ]);
  requireContract(
    (row.schemaVersion === 1 && (row.backend === 'legacy' || row.backend === 'temporal')) ||
      (row.schemaVersion === 2 && row.backend === 'temporal'),
    'backend-assignment-invalid',
  );
  requireContract(
    typeof row.origin === 'string' && /^[a-f\d]{64}$/u.test(row.origin),
    'backend-origin-invalid',
  );
  const cardName = relativePath(row.cardName);
  requireContract(basename(cardName) === cardName, 'backend-card-invalid');
  const projectId = identifier(row.projectId),
    taskId = identifier(row.taskId);
  return row.schemaVersion === 2
    ? {
        schemaVersion: 2,
        projectId,
        taskId,
        backend: 'temporal',
        cardName,
        origin: row.origin,
        startAdmission: controlRef(row.startAdmission),
        ...(row.route === undefined ? {} : { route: parseTaskBackendRoute(row.route) }),
      }
    : {
        schemaVersion: 1,
        projectId,
        taskId,
        backend: row.backend as TaskBackend,
        cardName,
        origin: row.origin,
      };
}

function projectDirectory(home: string, projectId: string) {
  return join(home, 'backend-assignments', identifier(projectId));
}
function assignmentPath(home: string, projectId: string, taskId: string) {
  return join(projectDirectory(home, projectId), identifier(taskId) + '.json');
}
function readAssignment(path: string) {
  requireContract(lstatSync(path).nlink === 1, 'backend-assignment-linked');
  const bytes = readPrivateFile(path);
  const row = assignment(JSON.parse(bytes.toString()));
  requireContract(
    bytes.equals(Buffer.from(JSON.stringify(row))),
    'backend-assignment-noncanonical',
  );
  return row;
}
function safeParent(path: string): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing === undefined) return safeParent(dirname(path));
  requireContract(existing.isDirectory() && realpathSync(path) === path, 'backend-parent-unsafe');
}

// Explicit inventory/creation only; this records a route and grants no execution authority.
export function reserveTaskBackend(
  workspace: string,
  value: TaskBackendAssignment,
): TaskBackendAssignment;
export function reserveTaskBackend(
  workspace: string,
  value: TaskBackendAssignmentV2,
  context: TaskStartAdmissionContext,
): Promise<TaskBackendAssignmentV2>;
export function reserveTaskBackend(
  workspace: string,
  value: AnyTaskBackendAssignment,
  context?: TaskStartAdmissionContext,
): AnyTaskBackendAssignment | Promise<TaskBackendAssignmentV2> {
  const row = assignment(value);
  const home = taskBackendHome(workspace);
  if (row.schemaVersion === 2) {
    requireContract(
      context !== undefined && realpathSync(workspace) === context.registration.workspaceRoot,
      'task-start-context-required',
    );
    const guard = taskBackendGuard(workspace);
    function startPolicy() {
      const policy = guard.assert();
      requireContract(policy?.startAdmission !== undefined, 'task-start-policy-required');
      return policy;
    }
    requireContract(
      startPolicy().newTasks === 'temporal' ||
        existsSync(assignmentPath(home, row.projectId, row.taskId)),
      'backend-new-tasks-blocked',
    );
    return checkTaskStartAdmission(
      context.registration,
      context.authority,
      row.startAdmission,
      context.preparation,
      row,
    ).then((verified) => {
      startPolicy();
      requireContract(verified.admission.previous === null, 'task-start-initial-required');
      requireContract(
        digest(readProjectFile(context.registration.workspaceRoot, context.preparation.card)) ===
          row.origin,
        'task-start-card-changed',
      );
      return reserveAssignment(home, row, () => {
        requireContract(startPolicy().newTasks === 'temporal', 'backend-new-tasks-blocked');
        context.checkInputs?.();
      }) as TaskBackendAssignmentV2;
    });
  }
  if (
    !existsSync(assignmentPath(home, row.projectId, row.taskId)) &&
    existsSync(join(home, 'backend-policy.json'))
  )
    requireContract(
      taskBackendPolicy(workspace)?.startAdmission === undefined,
      'task-start-admission-required',
    );
  return reserveAssignment(home, row);
}
function reserveAssignment(
  home: string,
  row: AnyTaskBackendAssignment,
  assertNewTaskAllowed?: () => void,
): AnyTaskBackendAssignment {
  const directory = projectDirectory(home, row.projectId);
  safeParent(directory);
  const path = assignmentPath(home, row.projectId, row.taskId);
  const bytes = Buffer.from(JSON.stringify(row));
  if (existsSync(path)) {
    const identity = lstatSync(directory, { bigint: true });
    requireContract(readPrivateFile(path).equals(bytes), 'backend-assignment-conflict');
    const current = lstatSync(directory, { bigint: true });
    requireContract(
      current.dev === identity.dev && current.ino === identity.ino,
      'backend-root-changed',
    );
    return readAssignment(path);
  }
  assertNewTaskAllowed?.();
  privateDirectory(directory);
  const identity = lstatSync(directory, { bigint: true });
  const lock = join(directory, 'assignment-lock');
  mkdirSync(lock, { mode: 0o700 });
  try {
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
      const prior = readAssignment(join(directory, name));
      requireContract(
        prior.projectId === row.projectId && name === prior.taskId + '.json',
        'backend-assignment-location',
      );
      requireContract(
        prior.taskId === row.taskId ||
          (prior.cardName !== row.cardName && prior.origin !== row.origin),
        'backend-task-alias',
      );
    }
    assertNewTaskAllowed?.();
    try {
      publishFile(path, bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    requireContract(readPrivateFile(path).equals(bytes), 'backend-assignment-conflict');
    return readAssignment(path);
  } finally {
    const current = lstatSync(directory, { bigint: true });
    requireContract(
      current.dev === identity.dev && current.ino === identity.ino,
      'backend-root-changed',
    );
    rmdirSync(lock);
  }
}

export function requireTaskBackend(
  workspace: string,
  projectId: string,
  taskId: string,
  backend: TaskBackend,
  consumer: (typeof consumers)[number],
  card?: string,
) {
  const policy = taskBackendPolicy(workspace);
  if (policy === null) return null;
  return assignedBackend(policy.home, projectId, taskId, backend, consumer, card);
}

function assignedBackend(
  home: string,
  projectId: string,
  taskId: string,
  backend: TaskBackend,
  consumer: (typeof consumers)[number],
  card?: string,
) {
  requireContract(consumers.includes(consumer), 'backend-consumer-unknown');
  const path = assignmentPath(home, projectId, taskId);
  requireContract(existsSync(path), 'backend-assignment-required');
  const row = readAssignment(path);
  requireContract(
    row.projectId === projectId && row.taskId === taskId && row.backend === backend,
    'backend-route-conflict',
  );
  if (card !== undefined)
    requireContract(row.cardName === basename(relativePath(card)), 'backend-card-conflict');
  return row;
}

export function requireLegacyCardBackend(workspace: string, projectId: string, card: string) {
  const policy = taskBackendPolicy(workspace);
  if (policy === null) return;
  const directory = projectDirectory(policy.home, projectId);
  requireContract(existsSync(directory), 'backend-assignment-required');
  const rows = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readAssignment(join(directory, name)))
    .filter((row) => row.cardName === basename(relativePath(card)));
  requireContract(rows.length === 1, 'backend-assignment-required');
  requireTaskBackend(workspace, projectId, rows[0]!.taskId, 'legacy', 'legacy', card);
}

export function refuseUnroutedBackendConsumer(workspace: string) {
  requireContract(taskBackendPolicy(workspace) === null, 'backend-consumer-not-qualified');
}

export function taskBackendGuard(workspace: string, required = false) {
  const original = resolve(workspace);
  const root = realpathSync(original),
    identity = lstatSync(root, { bigint: true });
  const location = backendLocation(root);
  const common = location === null ? null : lstatSync(dirname(location), { bigint: true });
  required ||= [
    join(root, '.agent-workflow-backend.json'),
    ...(location === null
      ? []
      : [
          join(dirname(location), 'agent-workflow-backend.json'),
          join(location, 'backend-policy.json'),
          join(location, 'backend-assignments'),
        ]),
  ].some((path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined);
  function assert() {
    const current = lstatSync(root, { bigint: true });
    requireContract(
      realpathSync(original) === root &&
        current.dev === identity.dev &&
        current.ino === identity.ino,
      'backend-workspace-changed',
    );
    requireContract(backendLocation(root) === location, 'backend-git-root-changed');
    if (common !== null) {
      const metadata = lstatSync(dirname(location!), { bigint: true });
      requireContract(
        metadata.dev === common.dev && metadata.ino === common.ino,
        'backend-git-root-changed',
      );
    }
    const policy = readBackendPolicy(
      declaration(join(root, '.agent-workflow-backend.json')),
      location,
    );
    required ||= policy !== null;
    requireContract(!required || policy !== null, 'backend-policy-required');
    return policy;
  }
  return {
    assert,
    require(
      projectId: string,
      taskId: string,
      backend: TaskBackend,
      consumer: (typeof consumers)[number],
      card?: string,
    ) {
      const policy = assert();
      return policy === null
        ? null
        : assignedBackend(policy.home, projectId, taskId, backend, consumer, card);
    },
  };
}
