import type { StageSupervisedTaskInput, TaskAuditStage } from './localTask.js';
import type { ArtifactRef } from './preparation.js';
import type { AuditInput, AuditTiming } from './audit.js';

export interface TaskStageContext {
  input: StageSupervisedTaskInput;
  stage: TaskAuditStage;
  snapshot: ArtifactRef;
  completed: ArtifactRef[];
}
export interface TaskStageAudit {
  schemaVersion: 1;
  kind: 'task-stage-supervision';
  context: TaskStageContext;
  timing: AuditTiming;
  claim: string | null;
  audit: { input: AuditInput; result: ArtifactRef; stop: ArtifactRef } | null;
}
export interface TaskStageAuditActivities {
  prepareTaskStageAudit(
    context: TaskStageContext,
    timing: AuditTiming,
    preflight: ArtifactRef,
  ): Promise<AuditInput>;
  finishTaskStageAudit(record: TaskStageAudit): Promise<ArtifactRef>;
}
