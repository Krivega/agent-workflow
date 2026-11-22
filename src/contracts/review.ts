import type { ArtifactRef, PreparationInput } from './preparation.js';
import type { ScopedReaderInput } from './reader.js';

export interface ReviewInput {
  schemaVersion: 1;
  preparation: PreparationInput;
  reviewId: string;
  request: ArtifactRef;
}
export interface ReviewRole {
  roleId: string;
  applies: boolean | null;
  reason: string;
  paths: string[];
  complete: boolean;
  attestedBy: string;
  discoveryRule: string;
  history: { complete: boolean; answers: ArtifactRef[] };
}
export interface ReviewRequestFields {
  phase: 'planning' | 'acceptance' | 'arbitration';
  scope: string;
  sharedPaths: string[];
  roles: ReviewRole[];
}
export interface ArbitrationScope {
  target: { roleId: string; findingId: string };
  trigger: ArtifactRef;
  profile: { model: string; effort: string; clientVersion: string };
}
export type ArbitrationDecision =
  | {
      kind: 'direction';
      mandatoryDefect: boolean;
      direction: string;
      exception: null;
      residualRisk: null;
      dissent: string[];
      condition: null;
    }
  | {
      kind: 'compromise';
      mandatoryDefect: boolean;
      direction: string;
      exception: string;
      residualRisk: string;
      dissent: string[];
      condition: null;
    }
  | {
      kind: 'no-decision';
      mandatoryDefect: null;
      direction: null;
      exception: null;
      residualRisk: null;
      dissent: string[];
      condition: string;
    };
export type ReviewRequest = ReviewRequestFields &
  (
    | { schemaVersion: 1 }
    | {
        schemaVersion: 2 | 3 | 6;
        evidence: ArtifactRef[];
        expectedFiles: { path: string; sha256: string; bytes: number }[];
      }
    | {
        schemaVersion: 5 | 7;
        evidence: ArtifactRef[];
        expectedFiles: { path: string; sha256: string; bytes: number }[];
        arbitration: ArbitrationScope;
      }
    | {
        schemaVersion: 4;
        evidence: ArtifactRef[];
        roleEvidence: { roleId: string; evidence: ArtifactRef[]; openFindings: string[] }[];
        expectedFiles: { path: string; sha256: string; bytes: number }[];
      }
  );
export interface ReviewSnapshotFields {
  kind: 'reader-review';
  input: Omit<ScopedReaderInput, 'review'>;
  phase: ReviewRequest['phase'];
  scope: string;
  sharedPaths: string[];
  selection: ReviewRole;
  files: { path: string; sha256: string; bytes: number }[];
}
export type ReviewSnapshot = ReviewSnapshotFields &
  (
    | { schemaVersion: 1 }
    | { schemaVersion: 2 | 3 | 6; evidence: ArtifactRef[] }
    | { schemaVersion: 4; evidence: ArtifactRef[]; openFindings: string[] }
    | { schemaVersion: 5 | 7; evidence: ArtifactRef[]; arbitration: ArbitrationScope }
  );
export interface ReviewReportFields {
  roleId: string;
  phase: ReviewRequest['phase'];
  scope: string;
  review: ArtifactRef;
  verdict: 'PASS' | 'FAIL' | 'NOT RUN';
  coverage: 'complete' | 'partial';
  findings: { id: string; blocking: boolean; text: string }[];
  limitations: string[];
}
export type ReviewReport = ReviewReportFields &
  (
    | { schemaVersion: 1 }
    | { schemaVersion: 2; resolved: string[] }
    | { schemaVersion: 3; decision: ArbitrationDecision }
    | {
        schemaVersion: 4;
        conflicts: {
          findingId: string;
          sources: { path: string; sha256: string; bytes: number }[];
        }[];
      }
  );
export type ReviewDecision = {
  roleId: string;
  action: 'review' | 'reuse' | 'not-applicable' | 'blocked';
  reasons: string[];
  input: ScopedReaderInput | null;
  answer: ArtifactRef | null;
};
export interface ReviewPlan {
  manifest: ArtifactRef;
  decisions: ReviewDecision[];
}
export interface ReviewActivities {
  prepareReviewPlan(input: ReviewInput): Promise<ReviewPlan>;
  finishReview(value: {
    schemaVersion: 1;
    input: ReviewInput;
    plan: ArtifactRef;
    answers: { roleId: string; answer: ArtifactRef | null }[];
  }): Promise<{ manifest: ArtifactRef; complete: boolean }>;
}
