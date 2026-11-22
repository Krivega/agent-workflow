import type { ArtifactRef, LocalProjectRegistration, PreparationInput } from './preparation.js';
import type { BoundTaskHumanManifest, TaskHumanCriterion, TaskHumanTarget } from './taskHuman.js';

export interface TaskStartPrincipalBinding {
  owner: string;
  threadId: string;
  turnId: string;
  source: { locator: string; hash: string };
  proof: ArtifactRef;
}
export interface TaskStartPrincipalAuthority {
  issue(): Promise<TaskStartPrincipalBinding>;
  verify(principal: TaskStartPrincipalBinding): Promise<unknown>;
}
export interface TaskStartAdmissionContext {
  registration: TaskStartRegistration;
  authority: Pick<TaskStartPrincipalAuthority, 'verify'>;
  preparation: PreparationInput;
  checkInputs?(): void;
}
export type TaskStartRegistration = Pick<
  LocalProjectRegistration,
  'project' | 'hostId' | 'owner' | 'generation' | 'workspaceRoot' | 'artifactRoot'
>;
export interface TaskStartAdmission {
  schemaVersion: 1;
  kind: 'task-start-admission';
  previous: ArtifactRef | null;
  target: TaskHumanTarget;
  card: ArtifactRef & { path: string };
  requirements: ArtifactRef;
  principal: TaskStartPrincipalBinding;
  criteria: TaskHumanCriterion[];
}
export interface TaskStartDeclaration {
  preparation: PreparationInput;
  previous: ArtifactRef | null;
  human: string[];
  inapplicable: { criterion: string; reason: string }[];
}
export interface TaskStartAssignment {
  projectId: string;
  taskId: string;
  cardName: string;
  origin: string;
  startAdmission: ArtifactRef;
}
export interface VerifiedStartAdmission {
  ref: ArtifactRef;
  admission: TaskStartAdmission;
  initial: { ref: ArtifactRef; admission: TaskStartAdmission };
  manifest: BoundTaskHumanManifest;
}
