import type { ArtifactRef, PreparationResult } from './preparation.js';
import type { ReaderActivities, ReaderEpoch, ReaderInput } from './reader.js';

export interface ReaderExecution {
  schemaVersion: 1;
  policyVersion: 1;
  profile: { model: string; effort: string; clientVersion: string };
}

export interface ReaderTarget {
  workflowId: string;
  projectId: string;
  taskId: string;
  roleId: string;
  hostId: string;
  workspaceId: string;
  owner: string;
  generation: number;
  requirementsRevision: number;
}
export type { ReaderEpoch } from './reader.js';
export interface ReaderCommand {
  schemaVersion: 1;
  commandId: string;
  hash: string;
  target: ReaderTarget;
  expectedRevision: number;
  author: string;
  action: 'pause' | 'resume' | 'cancel';
  attempt: number;
  source: ArtifactRef;
}
export interface PayloadReaderCommand extends Omit<ReaderCommand, 'schemaVersion'> {
  schemaVersion: 2;
  payload: ArtifactRef;
}
export interface ArchiveCommand extends Omit<PayloadReaderCommand, 'schemaVersion' | 'action'> {
  schemaVersion: 3;
  action: 'archive';
}
export type AuthorizedReaderCommand = ReaderCommand | PayloadReaderCommand | ArchiveCommand;
export type ReaderMode =
  'running' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'answered' | 'blocked';
export interface ReaderControlState {
  mode: ReaderMode;
  revision: number;
  attempt: number;
}
export type ReaderPhase = 'registering' | 'preparing' | 'creating' | 'loading' | 'answering';
export type ReaderOperationKey =
  [string, number] | [string, number, number] | [string, number, string, ArtifactRef, number];
export interface ReaderDiagnostic {
  kind:
    | 'running'
    | 'waiting-human'
    | 'waiting-worker'
    | 'stopping'
    | 'unknown-effect'
    | 'technical-error'
    | 'workflow-error'
    | 'terminal'
    | 'unavailable';
  reason: string;
  nextAction: string;
  evidenceHash: string | null;
}
export interface ReaderStatus extends ReaderControlState {
  schemaVersion: 1;
  target: ReaderTarget;
  runId: string;
  taskQueue: string;
  workerVersion: string | null;
  phase: ReaderPhase;
  permit: ArtifactRef | null;
  session: string | null;
  error: string;
  operation: {
    name: 'register' | 'prepare' | 'create' | 'load' | 'answer' | 'stop';
    key: ReaderOperationKey | null;
  };
  diagnostic: ReaderDiagnostic;
}
export interface ReaderCommandAck {
  commandId: string;
  hash: string;
  revision: number;
  authorization: ArtifactRef;
}
export interface ReaderAuthority {
  verify(command: AuthorizedReaderCommand): Promise<{
    origin: 'human' | 'initial-grant';
    author: string;
    hash: string;
    proof: ArtifactRef;
  }>;
}
export interface ReaderControlActivities {
  registerReader(input: ReaderInput, workflowId: string): Promise<ArtifactRef>;
  applyReaderCommand(
    input: ReaderInput,
    permit: ArtifactRef,
    command: ReaderCommand,
  ): Promise<ReaderCommandAck>;
  freezeReader(input: ReaderInput, permit: ArtifactRef): Promise<number>;
  stopReader(
    input: ReaderInput,
    permit: ArtifactRef,
    minimumRevision: number,
  ): Promise<{ status: 'stopped'; receipt: ArtifactRef }>;
}
export interface ControlledReaderActivities extends Pick<
  ReaderActivities,
  'createReader' | 'loadReader' | 'answerReader'
> {
  prepareControlledReader(input: ReaderInput, epoch: ReaderEpoch): Promise<PreparationResult>;
}
