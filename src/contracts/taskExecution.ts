import type { ArtifactRef } from './preparation.js';
import type { ManagedTaskInput, AnyManagedTaskInput } from './localTask.js';
import type { ReviewInput } from './review.js';
import type { PayloadReaderCommand, ReaderCommandAck } from './readerControl.js';
import type { SubstantialAdmissionInput } from './substantialTask.js';

export interface TaskExecutionProgress {
  phase: string;
  snapshot: ArtifactRef | null;
  planning: ReviewInput | null;
  records: ArtifactRef[];
}
export interface TaskExecutionResume {
  schemaVersion: 1;
  kind: 'task-execution-resume';
  held: ArtifactRef;
  admission: SubstantialAdmissionInput;
}
export interface TaskExecutionOutcome {
  status: 'done';
  result: ArtifactRef;
  projection: ArtifactRef;
}
export interface TaskExecutionBudget {
  extendedFrom?: ArtifactRef & { runId: string };
  limit: number;
  used: number;
  manifest: ArtifactRef;
}
export interface TaskExecutionDiagnostic {
  phase: string;
  error: string;
}
export interface TaskExecutionCheckpoint {
  initial: ManagedTaskInput;
  input: ManagedTaskInput;
  revision: number;
  held: ArtifactRef;
  history: ArtifactRef[];
  commands: ArtifactRef[];
  previous: ArtifactRef | null;
  budget: TaskExecutionBudget;
  beganAt: number;
  diagnostics: TaskExecutionDiagnostic[];
}
export interface TaskExecutionSummary {
  history: ArtifactRef[];
  commands: ArtifactRef[];
  checkpoint: ArtifactRef | null;
  budget: TaskExecutionBudget | null;
  budgetFailure: string;
  elapsedMs: number;
  diagnostics: TaskExecutionDiagnostic[];
}
export type TaskExecutionCompletion = (
  | TaskExecutionOutcome
  | {
      status: 'cancelled';
      stop: ArtifactRef;
      held: ArtifactRef | null;
      error: string;
      stopFailure: string;
    }
) &
  TaskExecutionSummary;
export interface TaskExecutionControls {
  captureTaskExecutionBudget(
    input: AnyManagedTaskInput,
    previous: ArtifactRef | null,
  ): Promise<TaskExecutionBudget>;
  saveTaskExecutionCheckpoint(checkpoint: TaskExecutionCheckpoint): Promise<ArtifactRef>;
  loadTaskExecutionCheckpoint(
    initial: ManagedTaskInput,
    checkpoint: ArtifactRef,
  ): Promise<TaskExecutionCheckpoint & { stop: ArtifactRef }>;
  prepareTaskExecution(input: AnyManagedTaskInput): Promise<ArtifactRef>;
  findTaskExecutionCommand(
    input: AnyManagedTaskInput,
    command: PayloadReaderCommand,
  ): Promise<ReaderCommandAck | null>;
  interruptTaskExecution(
    input: AnyManagedTaskInput,
    command: PayloadReaderCommand,
    revision: number,
  ): Promise<ReaderCommandAck>;
  holdTaskExecution(
    input: AnyManagedTaskInput,
    progress: TaskExecutionProgress,
    stop: ArtifactRef,
    reason: string,
    command: ReaderCommandAck | null,
  ): Promise<{ status: 'held'; held: ArtifactRef } | TaskExecutionOutcome>;
  resumeTaskExecution(
    input: AnyManagedTaskInput,
    held: ArtifactRef,
    command: PayloadReaderCommand,
    revision: number,
  ): Promise<{ input: AnyManagedTaskInput; ack: ReaderCommandAck }>;
}
