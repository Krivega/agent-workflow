import type { ArtifactRef, PreparationInput, PreparationResult } from './preparation.js';
export interface ReaderEpoch {
  permit: ArtifactRef;
  revision: number;
  attempt: number;
}

export interface ReaderBase {
  preparation: PreparationInput;
  roleId: string;
}
export interface ScopedReaderInput extends ReaderBase {
  schemaVersion: 2;
  reviewId: string;
  review: ArtifactRef;
}
export type ReaderInput = ReaderBase | ScopedReaderInput;

export interface ReaderSession {
  id: string;
  creation: ArtifactRef;
}

export interface ReaderActivities {
  prepareProject(input: PreparationInput): Promise<PreparationResult>;
  createReader(
    input: ReaderInput,
    prepared: PreparationResult,
    epoch?: ReaderEpoch,
  ): Promise<ReaderSession>;
  loadReader(
    input: ReaderInput,
    prepared: PreparationResult,
    session: ReaderSession,
    epoch?: ReaderEpoch,
  ): Promise<ArtifactRef>;
  answerReader(
    input: ReaderInput,
    prepared: PreparationResult,
    session: ReaderSession,
    load: ArtifactRef,
    epoch?: ReaderEpoch,
  ): Promise<ArtifactRef>;
}
