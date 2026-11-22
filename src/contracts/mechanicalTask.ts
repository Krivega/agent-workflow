import type { ArtifactRef, PreparationInput } from './preparation.js';
import type { LocalPlanSource } from './localAdmission.js';
import type { FileVersion, TaskFileChange } from './taskFiles.js';

export interface MechanicalAdmissionInput {
  schemaVersion: 2;
  preparation: PreparationInput;
  plan: { path: string; sha256: string };
  accepted: ArtifactRef;
  acceptance: ArtifactRef;
}
export interface MechanicalMaterial {
  schemaVersion: 1;
  kind: 'mechanical-material';
  materialId: string;
  requirement: LocalPlanSource;
  links: LocalPlanSource[];
  linksComplete: true;
  semanticDelta: false;
  files: {
    path: string;
    before: FileVersion | null;
    after: { source: LocalPlanSource; mode: number } | null;
  }[];
  checks: string[];
  criterion: string;
}
export interface MechanicalApplication {
  materialId: string;
  accepted: ArtifactRef;
  sessions: string[];
  changes: TaskFileChange[];
}
