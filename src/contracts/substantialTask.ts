import type { ArtifactRef, PreparationInput } from './preparation.js';
import type { LocalImplementationPlan } from '../policy/localPlanning.js';
export interface SubstantialAdmissionInput {
  schemaVersion: 3;
  preparation: PreparationInput;
  plan: { path: string; sha256: string };
  planning: ArtifactRef;
  acceptance: ArtifactRef;
}
export type SubstantialCriterionCheck = {
  criterion: string;
  evidence?: string;
  success?: string;
} & (
  | { stage: 'baseline' | 'candidate' | 'integrated'; command: string }
  | { stage: 'acceptance'; roleId: string; subject: string }
);
export type SubstantialPlan = Omit<LocalImplementationPlan, 'schema_version' | 'risks'> & {
  schema_version: 2;
  plan_id: string;
  risks: Record<keyof LocalImplementationPlan['risks'], boolean>;
  criterion_checks?: SubstantialCriterionCheck[];
};
export interface SubstantialApproval {
  accepted: ArtifactRef;
  sessions: string[];
}
