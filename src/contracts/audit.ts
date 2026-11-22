import type { ArtifactRef, PreparationInput } from './preparation.js';
import type { ReaderEpoch, ReaderSession } from './reader.js';

export interface AuditTiming {
  stage: string;
  estimateMs: number;
  elapsedMs: number | null;
  externalWaitMs: number | null;
  knownElapsedMs: number;
}
export type AuditTrigger =
  { kind: 'overrun' } | { kind: 'no-progress' | 'doubt'; evidence: ArtifactRef };
export type AuditDirection =
  'continue' | 'replace-approach' | 'replace-executor' | 'reconsider-constraints';
export interface AuditCard {
  schemaVersion: 1;
  kind: 'audit-card';
  preparation: PreparationInput;
  goal: { path: string; sha256: string; bytes: number };
  criteria: string[];
  completed: ArtifactRef[];
  openFindings: string[];
  checkpoint: string;
  timing: AuditTiming | null;
  trigger: AuditTrigger;
  sources: { path: string; sha256: string; bytes: number }[];
  nextAction: string;
}
export interface AuditInput {
  schemaVersion: 1;
  preparation: PreparationInput;
  auditId: string;
  card: ArtifactRef;
  preflight: ArtifactRef;
}
export interface AuditorSession {
  parent: ReaderSession;
  child: string;
  path: string;
  parentTurn: string;
}
export interface AuditReport {
  schemaVersion: 1;
  card: ArtifactRef;
  coverage: 'complete' | 'partial';
  direction: AuditDirection | null;
  reasons: string[];
  sources: string[];
  checkpoint: string;
  nextResult: string;
  limitations: string[];
}
export interface AuditorActivities {
  preflightAuditor(input: PreparationInput): Promise<ArtifactRef>;
  registerAuditor(input: AuditInput): Promise<ArtifactRef>;
  launchAuditor(input: AuditInput, epoch: ReaderEpoch): Promise<AuditorSession>;
  observeAuditorLoad(
    input: AuditInput,
    session: AuditorSession,
    epoch: ReaderEpoch,
  ): Promise<ArtifactRef | null>;
  prepareAuditQuestion(
    input: AuditInput,
    session: AuditorSession,
    load: ArtifactRef,
    epoch: ReaderEpoch,
  ): Promise<ArtifactRef>;
  answerAuditor(
    input: AuditInput,
    session: AuditorSession,
    question: ArtifactRef,
    epoch: ReaderEpoch,
  ): Promise<string>;
  observeAuditAnswer(
    input: AuditInput,
    session: AuditorSession,
    load: ArtifactRef,
    question: ArtifactRef,
    parentTurn: string,
    epoch: ReaderEpoch,
  ): Promise<ArtifactRef | null>;
  finishAudit(
    input: AuditInput,
    session: AuditorSession,
    load: ArtifactRef,
    question: ArtifactRef,
    parentTurn: string,
    answer: ArtifactRef,
    epoch: ReaderEpoch,
  ): Promise<{ manifest: ArtifactRef; report: Pick<AuditReport, 'coverage' | 'direction'> }>;
  verifyAuditResult(
    input: AuditInput,
    result: ArtifactRef,
    stop: ArtifactRef,
  ): Promise<{ proof: ArtifactRef; report: Pick<AuditReport, 'coverage' | 'direction'> }>;
}
export interface AuditorControls {
  stopAuditor(input: AuditInput, permit: ArtifactRef | null): Promise<ArtifactRef>;
}
