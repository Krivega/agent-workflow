import type { LocalTaskInput } from '../contracts/localTask.js';
import { identifier, requireContract } from '../contracts/project.js';
import { localTaskKey } from './localTask.js';

export function taskAdmissionIdentity(input: LocalTaskInput) {
  return JSON.stringify([
    localTaskKey(input),
    input.schemaVersion === 10 || input.schemaVersion === 11 || input.schemaVersion === 12
      ? input.continuation.attempt
      : 0,
  ]);
}

export function taskAdmissionsRelativePath(instance: string, version: 1 | 2 | 3): string {
  if (version === 1) return 'task-admissions';
  requireContract(version === 2 || version === 3, 'task-recovery-bindings-unsupported');
  return 'task-admissions-v2/' + identifier(instance);
}
