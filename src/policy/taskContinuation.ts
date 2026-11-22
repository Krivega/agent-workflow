import type { ContinuingTaskInput, AnyManagedTaskInput } from '../contracts/localTask.js';
import type { ReaderTarget } from '../contracts/readerControl.js';
import type { TaskResumePayload } from '../contracts/taskContinuation.js';
import type { SubstantialAdmissionInput } from '../contracts/substantialTask.js';
import { exactFields, object, requireContract } from '../contracts/project.js';
import { controlRef, parsePayloadReaderCommand } from './readerControl.js';
import { parseSubstantialAdmission } from './substantialTask.js';
import { localTaskKey } from './localTask.js';

export function taskControlTarget(input: ContinuingTaskInput | AnyManagedTaskInput): ReaderTarget {
  const p = input.admission.preparation;
  return {
    workflowId: localTaskKey(input),
    projectId: p.project.projectId,
    taskId: p.taskId,
    roleId: 'task',
    hostId: p.hostId,
    workspaceId: p.project.workspaceId,
    owner: p.owner,
    generation: p.generation,
    requirementsRevision: p.revision,
  };
}
export function taskResumeCommand(input: ContinuingTaskInput, value: unknown, revision: number) {
  const command = parsePayloadReaderCommand(value);
  requireContract(
    JSON.stringify(command.target) === JSON.stringify(taskControlTarget(input)) &&
      command.author === input.admission.preparation.owner,
    'task-command-target-mismatch',
  );
  requireContract(command.action === 'resume', 'task-command-action');
  requireContract(
    command.expectedRevision === revision &&
      revision < Number.MAX_SAFE_INTEGER &&
      command.attempt === input.continuation.attempt + 1,
    'task-command-stale',
  );
  return command;
}
export function parseTaskResumePayload(value: unknown): TaskResumePayload {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'held', 'admission']);
  requireContract(
    v.schemaVersion === 1 && v.kind === 'task-planning-resume',
    'task-resume-payload',
  );
  return {
    schemaVersion: 1,
    kind: 'task-planning-resume',
    held: controlRef(v.held),
    admission: parseSubstantialAdmission(v.admission),
  };
}
export function checkTaskContinuation(
  current: ContinuingTaskInput | AnyManagedTaskInput,
  payload: TaskResumePayload,
) {
  checkTaskContinuationAdmission(current, payload.admission);
}
export function checkTaskContinuationAdmission(
  current: ContinuingTaskInput | AnyManagedTaskInput,
  next: SubstantialAdmissionInput,
) {
  const admission = parseSubstantialAdmission(current.admission),
    before = admission.preparation,
    after = next.preparation;
  requireContract(
    JSON.stringify({ ...after, revision: before.revision }) === JSON.stringify(before) &&
      (after.revision === before.revision || after.revision === before.revision + 1),
    'task-resume-scope-changed',
  );
  requireContract(
    after.revision !== before.revision || JSON.stringify(next) === JSON.stringify(admission),
    'task-resume-revision-required',
  );
}
