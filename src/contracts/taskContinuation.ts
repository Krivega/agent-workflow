import type { ArtifactRef } from './preparation.js';
import type { ContinuingTaskInput } from './localTask.js';
import type { PayloadReaderCommand, ReaderCommandAck } from './readerControl.js';
import type { ReviewInput } from './review.js';
import type { SubstantialAdmissionInput } from './substantialTask.js';

export interface TaskResumePayload {
  schemaVersion: 1;
  kind: 'task-planning-resume';
  held: ArtifactRef;
  admission: SubstantialAdmissionInput;
}
export interface TaskContinuationControls {
  holdTaskPlanning(
    input: ContinuingTaskInput,
    planning: ReviewInput,
    review: ArtifactRef,
  ): Promise<ArtifactRef>;
  resumeTaskPlanning(
    input: ContinuingTaskInput,
    held: ArtifactRef,
    command: PayloadReaderCommand,
    revision: number,
  ): Promise<{ input: ContinuingTaskInput; ack: ReaderCommandAck }>;
}
