import type { ArtifactRef, PreparationInput } from './preparation.js';
import type { ArchiveCommand } from './readerControl.js';

export interface FinalizationInput {
  schemaVersion: 1;
  operation: 'archive';
  preparation: PreparationInput;
  result: ArtifactRef;
  command: ArchiveCommand;
}
export interface ArchivePayload {
  schemaVersion: 1;
  kind: 'task-archive-authorization';
  result: ArtifactRef;
  backup: {
    schemaVersion: 2;
    roots: Partial<
      Record<'artifacts' | 'receipts' | 'workspaces' | 'build' | 'projections' | 'legacy', string>
    >;
    destination: string;
  };
  inventory: ArtifactRef;
}
export interface FinalizationActivities {
  archiveFinalizedTask(
    input: FinalizationInput,
  ): Promise<{ status: 'archived'; manifest: ArtifactRef; receipt: ArtifactRef }>;
  reconcileFinalizedTask(
    input: FinalizationInput,
  ): Promise<
    | { status: 'archived'; manifest: ArtifactRef; receipt: ArtifactRef }
    | { status: 'unknown'; reason: string }
  >;
}
