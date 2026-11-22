import type { TaskBinding, LocalTaskInput } from './localTask.js';
import type { ArtifactRef } from './preparation.js';

export interface TaskHostAdmission {
  schemaVersion: 1;
  host: { pid: number; id: string };
  input: LocalTaskInput;
  gate: { directory: string; grant: ArtifactRef; mode: 'owned' | 'retained' };
}

export interface TaskPermissionOwnerRef {
  kind: 'host' | 'recovery';
  root: string;
  rootIdentity: string;
  artifactRoot: string;
  record: ArtifactRef;
  pid: number;
  id: string;
}
export interface TaskPermissionOwner {
  ref: TaskPermissionOwnerRef;
  assertCurrent(): void;
}
export interface TaskPermissionScope {
  source: TaskBinding;
  directory: string;
  taskKey: string;
  attempt: number;
  grant: ArtifactRef;
}
