import type { ProgressSupervisedTaskInput } from './localTask.js';
import type { ArtifactRef } from './preparation.js';
import type { AuditInput } from './audit.js';

export interface TaskProgressContext {
  input: ProgressSupervisedTaskInput;
  snapshot: ArtifactRef;
  baseline: ArtifactRef;
  taskElapsedMs: number | null;
}
export interface TaskProgressAudit {
  schemaVersion: 1;
  kind: 'task-progress-supervision';
  context: TaskProgressContext;
  timing: null;
  claim: string;
  audit: { input: AuditInput; result: ArtifactRef; stop: ArtifactRef };
}
export interface TaskProgressAuditActivities {
  prepareTaskProgressAudit(
    context: TaskProgressContext,
    preflight: ArtifactRef,
  ): Promise<AuditInput>;
  finishTaskProgressAudit(record: TaskProgressAudit): Promise<ArtifactRef>;
}
