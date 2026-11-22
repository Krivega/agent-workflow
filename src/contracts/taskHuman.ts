import type { ArtifactRef } from './preparation.js';
import type { ReaderTarget, PayloadReaderCommand, ReaderCommandAck } from './readerControl.js';
import type { ReviewInput } from './review.js';
import type { HumanManagedTaskInput } from './localTask.js';
import type { TaskExecutionBudget, TaskExecutionDiagnostic } from './taskExecution.js';
import type { SubstantialAdmissionInput } from './substantialTask.js';

export type TaskHumanTarget = ReaderTarget & { roleId: 'task' };
export interface TaskHumanCriterion {
  id: string;
  text: string;
  kind: 'human' | 'check';
  applicable: boolean;
  reason: string;
}
export interface TaskHumanManifest {
  schemaVersion: 1;
  kind: 'task-human-gate-manifest';
  target: TaskHumanTarget;
  card: ArtifactRef & { path: string };
  requirements: ArtifactRef;
  declaration: ArtifactRef;
  criteria: TaskHumanCriterion[];
}
export interface BoundTaskHumanManifest {
  manifest: TaskHumanManifest;
  ref: ArtifactRef;
}
interface TaskHumanCommandFields {
  schemaVersion: 1;
  commandId: string;
  hash: string;
  target: TaskHumanTarget;
  manifest: ArtifactRef;
  expectedRevision: number;
  author: string;
  source: ArtifactRef;
  questionId: string;
  criterionId: string;
}
export type TaskHumanCommand = TaskHumanCommandFields &
  ({ action: 'ASK' } | { action: 'DECIDE'; accepted: boolean });
export interface TaskHumanReceipt {
  commandId: string;
  hash: string;
  revision: number;
  requirementsRevision: number;
  proof: ArtifactRef;
}
export interface TaskHumanState {
  schemaVersion: 1;
  current: BoundTaskHumanManifest;
  revision: number;
  closed: boolean;
  pending: {
    questionId: string;
    criterionId: string;
    requirementsRevision: number;
    askedRevision: number;
  } | null;
  decisions: {
    questionId: string;
    criterionId: string;
    requirementsRevision: number;
    accepted: boolean;
    source: ArtifactRef;
    receipt: TaskHumanReceipt;
  }[];
  history: (
    | { kind: 'command'; command: TaskHumanCommand; receipt: TaskHumanReceipt }
    | {
        kind: 'requirements';
        previousManifest: ArtifactRef;
        nextManifest: ArtifactRef;
        source: ArtifactRef;
        receipt: TaskHumanReceipt;
      }
  )[];
}

// Only a trusted Activity produces verification; this shape never authenticates supplied JSON.
export type VerifiedTaskHumanCommand = {
  kind: 'verified-task-human-command';
  command: TaskHumanCommand;
  proof: ArtifactRef;
} & ({ action: 'ASK' } | { action: 'DECIDE'; accepted: boolean });
export interface VerifiedTaskHumanRequirements {
  kind: 'verified-task-human-requirements';
  commandId: string;
  hash: string;
  previousManifest: ArtifactRef;
  next: BoundTaskHumanManifest;
  expectedRevision: number;
  source: ArtifactRef;
  proof: ArtifactRef;
}
export interface TaskHumanTechnicalCompletion {
  input: HumanManagedTaskInput;
  snapshot: ArtifactRef;
  packet: ReviewInput;
  acceptance: ArtifactRef;
  records: ArtifactRef[];
  stopped: ArtifactRef;
}
export interface TaskHumanCommandContext {
  input: HumanManagedTaskInput;
  state: TaskHumanState;
  technical: TaskHumanTechnicalCompletion;
}
export interface TaskHumanWaitResume {
  schemaVersion: 2;
  kind: 'task-human-wait-resume';
  admission: SubstantialAdmissionInput;
  startAdmission: ArtifactRef;
}
export interface TaskHumanExecutionResume {
  schemaVersion: 2;
  kind: 'task-execution-resume';
  held: ArtifactRef;
  admission: SubstantialAdmissionInput;
  startAdmission: ArtifactRef;
}
export interface TaskHumanAuthority {
  verify(
    context: TaskHumanCommandContext,
    command: TaskHumanCommand,
  ): Promise<VerifiedTaskHumanCommand>;
}
export interface TaskHumanFinishRequest extends TaskHumanCommandContext {
  schemaVersion: 1;
  kind: 'task-human-finish';
  expectedRevision: number;
}
export interface TaskHumanExecutionCheckpoint {
  schemaVersion: 2;
  producer: { workflowId: string; runId: string };
  initial: HumanManagedTaskInput;
  input: HumanManagedTaskInput;
  revision: number;
  history: ArtifactRef[];
  commands: ArtifactRef[];
  previous: ArtifactRef | null;
  budget: TaskExecutionBudget;
  beganAt: number;
  diagnostics: TaskExecutionDiagnostic[];
  humanState: TaskHumanState;
  technical: TaskHumanTechnicalCompletion | null;
  wait:
    | { kind: 'execution-held'; held: ArtifactRef; stop: ArtifactRef }
    | { kind: 'human-gates'; paused: boolean };
}
export interface TaskHumanActivities {
  prepareTaskHuman(input: HumanManagedTaskInput): Promise<BoundTaskHumanManifest>;
  verifyTaskHumanCommand(
    context: TaskHumanCommandContext,
    command: TaskHumanCommand,
  ): Promise<VerifiedTaskHumanCommand>;
  controlTaskHumanExecution(
    context: TaskHumanCommandContext,
    command: PayloadReaderCommand,
    revision: number,
  ): Promise<{ ack: ReaderCommandAck; input: HumanManagedTaskInput }>;
  finishTaskHuman(request: TaskHumanFinishRequest): Promise<{
    status: 'done';
    result: ArtifactRef;
    projection: ArtifactRef;
  }>;
  saveTaskHumanCheckpoint(checkpoint: TaskHumanExecutionCheckpoint): Promise<ArtifactRef>;
  loadTaskHumanCheckpoint(
    initial: HumanManagedTaskInput,
    checkpoint: ArtifactRef,
    continuedFromRunId: string,
  ): Promise<TaskHumanExecutionCheckpoint>;
}
