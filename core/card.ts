export type ProjectStatus = 'active' | 'blocked' | 'verifying' | 'completed' | 'cancelled';
export interface CardSnapshot {
  locator: string;
  revision: string;
  content: string;
  task_id: string | null;
  project_id: string | null;
  notes_version: unknown;
  status: ProjectStatus;
}
export interface FileChange {
  locator: string;
  before: string | null;
  after: string | null;
}
export interface CardProjection {
  operation_id: string;
  task_id: string;
  from: string;
  to: string;
  changes: FileChange[];
  supersedes?: { operation_id: string; decision: string };
}
export type ProjectionResult =
  | { status: 'confirmed'; locator: string; revision: string }
  | { status: 'pending'; conflicts: string[] };

export interface CardCompletion {
  criteria: string[];
  summary: string;
  limitations: string[];
  evidence: { locator: string; hash: string }[];
}
