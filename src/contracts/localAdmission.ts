import type { ArtifactRef, PreparationInput } from './preparation.js';

export interface LocalPlanSource {
  locator: string;
  hash: string;
}
export interface LocalAdmissionInput {
  schemaVersion: 1;
  preparation: PreparationInput;
  plan: { path: string; sha256: string };
  acceptance: ArtifactRef;
}
export interface LocalAdmissionResult {
  status: 'admitted';
  manifest: ArtifactRef;
}
export interface LocalAdmissionActivities {
  prepareLocalAdmission(input: LocalAdmissionInput): Promise<LocalAdmissionResult>;
}
