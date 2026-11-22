import type { ArtifactRef } from './preparation.js';
import type { LocalAdmissionInput } from './localAdmission.js';
import type { LocalImplementationPlan } from '../policy/localPlanning.js';
import type { ReaderExecution } from './readerControl.js';
import type { ReviewInput } from './review.js';
import type { ProcessIdentity } from './writerProcesses.js';
import type { MechanicalAdmissionInput, MechanicalApplication } from './mechanicalTask.js';
import type {
  SubstantialAdmissionInput,
  SubstantialPlan,
  SubstantialApproval,
} from './substantialTask.js';
import type { TaskTree, TaskBinding, TaskFileChange } from './taskFiles.js';
export type { FileVersion, TaskTree, TaskBinding } from './taskFiles.js';

export const taskAuditStages = [
  'baseline',
  'writing',
  'candidate-checks',
  'integration',
  'integrated-checks',
  'acceptance',
] as const;
export type TaskAuditStage = (typeof taskAuditStages)[number];
export interface NativeTaskInput {
  schemaVersion: 1;
  admission: LocalAdmissionInput;
  executor: { path: string; sha256: string };
  baseline: string;
}
export type LocalTaskInput =
  | NativeTaskInput
  | { schemaVersion: 2; admission: MechanicalAdmissionInput; baseline: string }
  | {
      schemaVersion: 3;
      admission: SubstantialAdmissionInput;
      executor: NativeTaskInput['executor'];
      baseline: string;
    }
  | CorrectionTaskInput
  | ArbitrationTaskInput
  | InitialArbitrationTaskInput
  | SupervisedTaskInput
  | ContinuingTaskInput
  | ManagedTaskInput
  | HumanManagedTaskInput;
export interface ContinuingTaskInput extends Omit<NativeTaskInput, 'schemaVersion' | 'admission'> {
  schemaVersion: 10;
  admission: SubstantialAdmissionInput;
  continuation: { attempt: number; previous: ArtifactRef | null };
}
export interface ManagedTaskInput extends Omit<ContinuingTaskInput, 'schemaVersion'> {
  schemaVersion: 11;
}
export interface HumanManagedTaskInput extends Omit<ManagedTaskInput, 'schemaVersion'> {
  schemaVersion: 12;
  startAdmission: ArtifactRef;
}
export type AnyManagedTaskInput = ManagedTaskInput | HumanManagedTaskInput;
export interface PlanningSupervisedTaskInput {
  schemaVersion: 7;
  admission: SubstantialAdmissionInput;
  executor: NativeTaskInput['executor'];
  baseline: string;
  audit: { planningEstimateMs: number };
}
export interface TimedStageTaskInput extends Omit<
  PlanningSupervisedTaskInput,
  'schemaVersion' | 'audit'
> {
  schemaVersion: 8;
  audit: PlanningSupervisedTaskInput['audit'] & { stages: Record<TaskAuditStage, number> };
}
export interface ProgressSupervisedTaskInput extends Omit<TimedStageTaskInput, 'schemaVersion'> {
  schemaVersion: 9;
  progress: {
    checkpoint: string;
    trigger: { kind: 'no-progress' | 'doubt'; evidence: ArtifactRef };
  };
}
export type StageSupervisedTaskInput = TimedStageTaskInput | ProgressSupervisedTaskInput;
export type SupervisedTaskInput = PlanningSupervisedTaskInput | StageSupervisedTaskInput;
export type InitialArbitrationTaskInput = {
  schemaVersion: 6;
  admission: SubstantialAdmissionInput;
  executor: NativeTaskInput['executor'];
  baseline: string;
  arbitration: Pick<ArbitrationTaskInput['arbitration'], 'roleId' | 'profile'>;
};
export type CorrectionTaskInput = {
  schemaVersion: 4;
  admission: LocalAdmissionInput | SubstantialAdmissionInput;
  executor: NativeTaskInput['executor'];
  baseline: string;
  corrections: { maxRounds: 1 | 2; checks: { roleId: string; commands: string[] }[] };
};
export type ArbitrationTaskInput = Omit<CorrectionTaskInput, 'schemaVersion'> & {
  schemaVersion: 5;
  arbitration: {
    roleId: string;
    profile: ReaderExecution['profile'];
    compromiseFindings: { roleId: string; findingId: string }[];
  };
};
export type CorrectingTaskInput = CorrectionTaskInput | ArbitrationTaskInput;
export interface TaskCorrection {
  round: number;
  origin: ArtifactRef | null;
  previous: { snapshot: ArtifactRef; packet: ReviewInput; review: ArtifactRef } | null;
  instructions: ArtifactRef | null;
  arbitration?: ArtifactRef;
}
export type TaskPlan = Pick<
  LocalImplementationPlan,
  'requirement' | 'basis' | 'paths' | 'checks' | 'criterion'
>;
export interface TaskSnapshotFields {
  admission: ArtifactRef;
  profile: ReaderExecution['profile'];
  disabledServers: string[];
  source: TaskBinding;
  copy: TaskBinding;
  tree: TaskTree;
  commands: Record<
    string,
    { executable: string; args: readonly string[]; timeoutMs: number; sha256: string }
  >;
}
export type TaskSnapshot = TaskSnapshotFields &
  (
    | {
        schemaVersion: 1;
        kind: 'local-task';
        input: NativeTaskInput;
        plan: LocalImplementationPlan;
      }
    | {
        schemaVersion: 3;
        kind: 'substantial-task';
        input: Extract<LocalTaskInput, { schemaVersion: 3 | 6 | 7 | 8 | 9 | 10 | 11 | 12 }>;
        plan: SubstantialPlan;
        planning: SubstantialApproval;
        supervision?: ArtifactRef;
      }
    | {
        schemaVersion: 4;
        kind: 'correction-task';
        input: CorrectingTaskInput;
        plan: LocalImplementationPlan | SubstantialPlan;
        planning: SubstantialApproval | null;
        correction: TaskCorrection;
      }
    | {
        schemaVersion: 2;
        kind: 'mechanical-task';
        input: Extract<LocalTaskInput, { schemaVersion: 2 }>;
        plan: TaskPlan;
        mechanical: MechanicalApplication;
      }
  );
export interface TaskCheckResult {
  status: 'PASS' | 'FAIL';
  manifest: ArtifactRef;
}
export interface WriterResult {
  session: string | null;
  answer: ArtifactRef;
  stop: ArtifactRef;
  tree: ArtifactRef;
}
export interface TaskIntegration {
  changes: TaskFileChange[];
  source: TaskBinding;
  copy: TaskBinding;
  candidate: ArtifactRef;
  writer: WriterResult;
  previousIntegration?: ArtifactRef;
}
export interface TaskWriterRuntime {
  pid: number;
  initialize(): Promise<void>;
  /** Admission may reject before dispatch; it must not send a turn. */
  admitTurn?(params: Record<string, unknown>): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  completed(thread: string, turn: string, signal?: AbortSignal): Promise<void>;
  close(): void;
}
export interface TaskRuntimeProof {
  processes: ProcessIdentity[];
  session: string | null;
}
export type TaskWriterObservation =
  | { status: 'unknown'; reason: string }
  | { status: 'live'; runtime: TaskRuntimeProof; processes: ProcessIdentity[] }
  | { status: 'stopped'; runtime: TaskRuntimeProof; receipt: ArtifactRef };
export interface LocalTaskActivities {
  prepareInitialArbitration(
    input: LocalTaskInput,
    planning: ReviewInput,
    review: ArtifactRef,
  ): Promise<{ manifest: ArtifactRef; review: ReviewInput }>;
  finishInitialArbitration(
    input: LocalTaskInput,
    arbitration: ArtifactRef,
    reviewed: ArtifactRef,
  ): Promise<{ manifest: ArtifactRef; planning: ReviewInput | null }>;
  prepareLocalArbitration(
    input: LocalTaskInput,
    snapshot: ArtifactRef,
    packet: ReviewInput,
    review: ArtifactRef,
  ): Promise<{ manifest: ArtifactRef; review: ReviewInput }>;
  finishLocalArbitration(
    input: LocalTaskInput,
    snapshot: ArtifactRef,
    arbitration: ArtifactRef,
    reviewed: ArtifactRef,
  ): Promise<{ manifest: ArtifactRef; snapshot: ArtifactRef | null; ready: boolean }>;
  prepareLocalCorrection(
    input: LocalTaskInput,
    previous: ArtifactRef,
    packet: ReviewInput,
    review: ArtifactRef,
  ): Promise<ArtifactRef>;
  prepareSubstantialPlanning(input: LocalTaskInput): Promise<ReviewInput>;
  prepareLocalTask(
    input: LocalTaskInput,
    planning?: ArtifactRef,
    supervision?: ArtifactRef,
  ): Promise<ArtifactRef>;
  checkLocalTask(
    input: LocalTaskInput,
    snapshot: ArtifactRef,
    stage: 'baseline' | 'candidate' | 'integrated',
    writer: WriterResult | null,
    integration: ArtifactRef | null,
  ): Promise<TaskCheckResult>;
  writeLocalTask(
    input: LocalTaskInput,
    snapshot: ArtifactRef,
    progress?: ArtifactRef,
  ): Promise<WriterResult>;
  planLocalIntegration(
    input: LocalTaskInput,
    snapshot: ArtifactRef,
    writer: WriterResult,
    checks: ArtifactRef,
  ): Promise<ArtifactRef>;
  integrateLocalTask(
    input: LocalTaskInput,
    snapshot: ArtifactRef,
    intent: ArtifactRef,
  ): Promise<ArtifactRef>;
  recheckIntegratedTask(
    input: HumanManagedTaskInput,
    authorization: ArtifactRef,
  ): Promise<{
    snapshot: ArtifactRef;
    stopped: ArtifactRef;
    packet: ReviewInput;
    records: ArtifactRef[];
  }>;
  prepareLocalAcceptance(
    input: LocalTaskInput,
    snapshot: ArtifactRef,
    writer: WriterResult,
    candidateChecks: ArtifactRef,
    intent: ArtifactRef,
    integration: ArtifactRef,
    finalChecks: ArtifactRef,
    baseline: ArtifactRef,
  ): Promise<ReviewInput>;
  finishLocalTask(
    input: LocalTaskInput,
    snapshot: ArtifactRef,
    packet: ReviewInput,
    review: ArtifactRef,
    stages?: ArtifactRef[],
    progress?: ArtifactRef,
  ): Promise<{ status: 'done'; result: ArtifactRef; projection: ArtifactRef }>;
}
export interface LocalTaskControls {
  stopLocalTask(input: LocalTaskInput): Promise<ArtifactRef>;
}
