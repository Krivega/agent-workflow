import type { AnyManagedTaskInput, ManagedTaskInput } from '../contracts/localTask.js';
import type { HumanManagedTaskInput } from '../contracts/localTask.js';
import type { TaskHumanWaitResume, TaskHumanExecutionResume } from '../contracts/taskHuman.js';
import type { TaskExecutionResume, TaskExecutionDiagnostic } from '../contracts/taskExecution.js';
import { exactFields, object, requireContract, text } from '../contracts/project.js';
import { controlRef, parsePayloadReaderCommand } from './readerControl.js';
import { parseSubstantialAdmission } from './substantialTask.js';
import {
  taskControlTarget,
  checkTaskContinuation,
  checkTaskContinuationAdmission,
} from './taskContinuation.js';

export function taskExecutionCommand(input: AnyManagedTaskInput, value: unknown, revision: number) {
  const command = parsePayloadReaderCommand(value);
  requireContract(
    JSON.stringify(command.target) === JSON.stringify(taskControlTarget(input)) &&
      command.author === input.admission.preparation.owner,
    'task-command-target-mismatch',
  );
  requireContract(
    command.expectedRevision === revision &&
      revision < Number.MAX_SAFE_INTEGER &&
      (command.attempt === input.continuation.attempt + (command.action === 'resume' ? 1 : 0) ||
        (input.schemaVersion === 12 &&
          command.action === 'resume' &&
          command.attempt === input.continuation.attempt)),
    'task-command-stale',
  );
  return command;
}
export function taskHumanExecutionCommand(
  input: HumanManagedTaskInput,
  value: unknown,
  revision: number,
) {
  const command = parsePayloadReaderCommand(value);
  requireContract(
    JSON.stringify(command.target) === JSON.stringify(taskControlTarget(input)) &&
      command.author === input.admission.preparation.owner,
    'task-command-target-mismatch',
  );
  requireContract(
    command.expectedRevision === revision &&
      revision < Number.MAX_SAFE_INTEGER &&
      (command.attempt === input.continuation.attempt ||
        (command.action === 'resume' && command.attempt === input.continuation.attempt + 1)),
    'task-command-stale',
  );
  return command;
}
export function parseTaskExecutionResume(value: unknown): TaskExecutionResume {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'held', 'admission']);
  requireContract(
    v.schemaVersion === 1 && v.kind === 'task-execution-resume',
    'task-execution-payload',
  );
  const payload: TaskExecutionResume = {
    schemaVersion: 1,
    kind: 'task-execution-resume',
    held: controlRef(v.held),
    admission: parseSubstantialAdmission(v.admission),
  };
  return payload;
}
export function checkTaskExecutionResume(input: ManagedTaskInput, payload: TaskExecutionResume) {
  checkTaskContinuation(input, { ...payload, kind: 'task-planning-resume' });
}
export function parseTaskHumanExecutionResume(value: unknown): TaskHumanExecutionResume {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'held', 'admission', 'startAdmission']);
  requireContract(
    v.schemaVersion === 2 && v.kind === 'task-execution-resume',
    'human-execution-resume-payload',
  );
  return {
    schemaVersion: 2,
    kind: 'task-execution-resume',
    held: controlRef(v.held),
    admission: parseSubstantialAdmission(v.admission),
    startAdmission: controlRef(v.startAdmission),
  };
}
export function checkTaskHumanExecutionResume(
  input: HumanManagedTaskInput,
  payload: TaskHumanExecutionResume,
) {
  requireContract(payload.schemaVersion === 2, 'human-resume-admission-required');
  checkTaskContinuationAdmission(input, payload.admission);
  const same =
    payload.startAdmission.sha256 === input.startAdmission.sha256 &&
    payload.startAdmission.bytes === input.startAdmission.bytes;
  requireContract(
    same === (payload.admission.preparation.revision === input.admission.preparation.revision),
    'human-resume-declaration-revision',
  );
}
export function parseTaskHumanWaitResume(value: unknown): TaskHumanWaitResume {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'admission', 'startAdmission']);
  requireContract(
    v.schemaVersion === 2 && v.kind === 'task-human-wait-resume',
    'human-wait-resume-payload',
  );
  return {
    schemaVersion: 2,
    kind: 'task-human-wait-resume',
    admission: parseSubstantialAdmission(v.admission),
    startAdmission: controlRef(v.startAdmission),
  };
}
export function checkTaskHumanWaitResume(
  input: HumanManagedTaskInput,
  payload: TaskHumanWaitResume,
): boolean {
  checkTaskContinuationAdmission(input, payload.admission);
  const replan = payload.admission.preparation.revision !== input.admission.preparation.revision,
    same =
      input.startAdmission.sha256 === payload.startAdmission.sha256 &&
      input.startAdmission.bytes === payload.startAdmission.bytes;
  requireContract(same !== replan, 'human-resume-declaration-revision');
  return replan;
}
export function taskInterruption(value: unknown) {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'reason']);
  requireContract(
    v.schemaVersion === 1 && v.kind === 'task-interruption',
    'task-interruption-payload',
  );
  return text(v.reason);
}
export function taskExecutionDiagnostics(value: unknown): TaskExecutionDiagnostic[] {
  requireContract(Array.isArray(value), 'task-checkpoint-invalid');
  return value.map((item) => {
    const v = object(item);
    exactFields(v, ['phase', 'error']);
    requireContract(
      typeof v.phase === 'string' && typeof v.error === 'string',
      'task-checkpoint-invalid',
    );
    return { phase: v.phase, error: v.error };
  });
}
