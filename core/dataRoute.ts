import { requireWorkflow, textField } from './connection.js';
import type { Procedure } from './connection.js';
import type { DataRole, InputRef } from './localRun.js';
import { sameRefs } from './council.js';

export interface DataBrief {
  question: string;
  scope: string[];
  sources: InputRef[];
  criterion: string;
  format: string;
  rules: InputRef[];
  procedures: Procedure[];
}
export type DataQuery = DataBrief &
  (
    | { kind: 'unknown-source'; entrypoints: string[] }
    | {
        kind: 'large-source';
        ranges: { start: number; end: number }[];
        selection: string;
        classification: string;
        completeness: string;
        continuation: string | null;
      }
    | {
        kind: 'unknown-evidence';
        task_id: string;
        budget: { pages: number; bodies: number; bytes: number };
      }
  );
export interface SessionProfile {
  model: string;
  effort: string;
  reason: string;
}
export interface AgentSession {
  id: string;
  agent_role?: string | null;
  native_project_id?: string | null;
  parent_id?: string | null;
  native_child?: boolean;
  observed_turn?: string;
  name?: string | null;
  model: string;
  effort: string;
  workspace: string;
  project_id: string;
  read_only: boolean;
  network: boolean;
  forked_from: string | null;
  initial_turns: number;
  receipt: InputRef;
}
export interface DataAnswer {
  outcome: 'PASS' | 'FAIL' | 'NOT RUN';
  scope: string[];
  sources: InputRef[];
  coverage: 'complete' | 'partial';
  content: string;
  continuation: string | null;
  limitations: string[];
  evidence: InputRef;
}
export interface DataReading {
  id: string;
  query: DataQuery;
  profile: SessionProfile;
  phase: 'reserved' | 'loading' | 'ready' | 'sending' | 'running' | 'answered';
  session: AgentSession | null;
  load: InputRef | null;
  turn_id: string | null;
  send_id?: string;
  creations: number;
  answers: DataAnswer[];
  restart: { previous_id: string; checkpoint: InputRef } | null;
}
export function requireSettledReadings(readings: Record<string, DataReading>): void {
  requireWorkflow(
    Object.values(readings).every(
      (r) =>
        r.session !== null &&
        r.load !== null &&
        (r.phase === 'ready' ||
          (r.turn_id !== null && (r.phase === 'running' || r.phase === 'answered'))),
    ),
    'chat-role-operation-unknown',
  );
}
export function dataRole(query: DataQuery): DataRole {
  return query.kind === 'unknown-source'
    ? 'explorer'
    : query.kind === 'large-source'
      ? 'raw-data-reader'
      : 'evidence-explorer';
}
export function validateDataQuery(query: DataQuery): void {
  [query.question, query.criterion, query.format].forEach(textField);
  requireWorkflow(
    query.scope.length > 0 && query.sources.length > 0 && query.rules.length > 0,
    'incomplete-data-brief',
  );
  query.scope.forEach(textField);
  for (const ref of [...query.sources, ...query.rules]) {
    textField(ref.locator);
    textField(ref.hash);
  }
  requireWorkflow(
    ['bootstrap', 'data-roles', 'evidence'].every((id) =>
      query.procedures.some((p) => p.id === id),
    ),
    'data-procedures-missing',
  );
  if (query.kind === 'unknown-source') {
    requireWorkflow(query.entrypoints.length > 0, 'entrypoints-missing');
    query.entrypoints.forEach(textField);
  } else if (query.kind === 'unknown-evidence') {
    textField(query.task_id);
    requireWorkflow(
      [query.budget.pages, query.budget.bodies, query.budget.bytes].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ),
      'data-budget-invalid',
    );
  } else {
    [query.selection, query.classification, query.completeness].forEach(textField);
    requireWorkflow(
      query.sources.length === 1 &&
        query.ranges.length > 0 &&
        query.ranges.every(
          (r) =>
            Number.isSafeInteger(r.start) &&
            Number.isSafeInteger(r.end) &&
            r.start > 0 &&
            r.end >= r.start,
        ),
      'data-ranges-invalid',
    );
  }
}
// Explicit construction prevents accidental propagation of the parent's messages or extra fields.
export function roleBrief(query: DataQuery): string {
  validateDataQuery(query);
  const shared = {
    role: dataRole(query),
    fork_turns: 'none',
    permissions: ['read'],
    question: query.question,
    scope: query.scope,
    sources: query.sources.map(({ locator, hash }) => ({ locator, hash })),
    criterion: query.criterion,
    format: query.format,
    rules: query.rules.map(({ locator, hash }) => ({ locator, hash })),
  };
  const detail =
    query.kind === 'unknown-source'
      ? { entrypoints: query.entrypoints }
      : query.kind === 'unknown-evidence'
        ? {
            task_id: query.task_id,
            budget: {
              pages: query.budget.pages,
              bodies: query.budget.bodies,
              bytes: query.budget.bytes,
            },
          }
        : {
            ranges: query.ranges.map(({ start, end }) => ({ start, end })),
            selection: query.selection,
            classification: query.classification,
            completeness: query.completeness,
            continuation: query.continuation,
          };
  return JSON.stringify({ ...shared, ...detail });
}
export function confirmSession(
  session: AgentSession,
  profile: SessionProfile,
  fresh: boolean,
): void {
  textField(session.id);
  requireWorkflow(
    session.model === profile.model &&
      session.effort === profile.effort &&
      session.read_only &&
      !session.network,
    'effective-profile-mismatch',
  );
  requireWorkflow(
    !fresh || (session.forked_from === null && session.initial_turns === 0),
    'parent-history-inherited',
  );
}
export function validateDataAnswer(reading: DataReading, answer: DataAnswer): void {
  requireWorkflow(
    answer.scope.length === reading.query.scope.length &&
      answer.scope.every((s) => reading.query.scope.includes(s)),
    'wrong-data-scope',
  );
  requireWorkflow(sameRefs(reading.query.sources, answer.sources), 'wrong-data-revision');
  textField(answer.content);
  textField(answer.evidence.locator);
  requireWorkflow(
    answer.coverage === 'complete' || answer.continuation !== null,
    'partial-without-continuation',
  );
}
