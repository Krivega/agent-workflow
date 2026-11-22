import type { ProjectDescriptor } from './project.js';

export interface ArtifactRef {
  sha256: string;
  bytes: number;
}

export interface PreparationInput {
  schemaVersion: 1;
  taskId: string;
  project: ProjectDescriptor;
  hostId: string;
  owner: string;
  generation: number;
  revision: number;
  card: string;
}

export interface PreparationResult {
  status: 'prepared';
  manifest: ArtifactRef;
}

export interface PreparationActivities {
  prepareProject(input: PreparationInput): Promise<PreparationResult>;
}

export interface LocalProjectRegistration {
  taskBackend?: 'required';
  project: unknown;
  hostId: string;
  owner: string;
  generation: number;
  workspaceRoot: string;
  artifactRoot: string;
  commands: Record<string, { executable: string; args: readonly string[]; timeoutMs?: number }>;
}
