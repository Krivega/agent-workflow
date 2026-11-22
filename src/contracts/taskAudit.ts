import type { ArtifactRef } from './preparation.js';
import type { SupervisedTaskInput } from './localTask.js';
import type { ReviewInput } from './review.js';
import type { AuditInput, AuditTiming } from './audit.js';
import type { ReaderInput, ReaderSession } from './reader.js';

export interface PlanningReaderObservation {
  input: ReaderInput;
  permit: ArtifactRef;
  session: ReaderSession | null;
  operations?: ArtifactRef;
}
export interface TaskPlanningProgressActivities {
  captureTaskPlanningProgress(
    input: SupervisedTaskInput,
    planning: ReviewInput,
  ): Promise<ArtifactRef>;
}

export interface TaskPlanningAudit {
  schemaVersion: 1;
  kind: 'task-planning-supervision';
  input: SupervisedTaskInput;
  planning: ReviewInput;
  timing: AuditTiming;
  claim: string | null;
  audit: { input: AuditInput; result: ArtifactRef; stop: ArtifactRef } | null;
}
export interface TaskAuditActivities {
  prepareTaskPlanningAudit(
    input: SupervisedTaskInput,
    planning: ReviewInput,
    preflight: ArtifactRef,
    timing: AuditTiming,
    progress?: ArtifactRef,
  ): Promise<AuditInput>;
  finishTaskPlanningAudit(value: TaskPlanningAudit): Promise<ArtifactRef>;
}
