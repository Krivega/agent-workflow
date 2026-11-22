import { requireWorkflow, textField } from './connection.js';
import { compareInputs } from './evidence.js';
import type { InputManifest } from './evidence.js';
import type { InputRef } from './localRun.js';
import type { AgentSession } from './dataRoute.js';

export interface ProgressAudit {
  schema_version: 1;
  task_id: string;
  scope: string;
  goal_source: InputRef;
  checkpoint: string;
  evidence: InputRef;
  inputs: InputManifest;
  estimate_ms: null;
  elapsed_ms: null;
  external_wait_ms: null;
}
export type AuditAttemptObservation =
  | { outcome: 'unknown' }
  | { outcome: 'not-started'; operation: string; session: null; receipt: InputRef }
  | { outcome: 'idle'; operation: string; session: AgentSession; receipt: InputRef }
  | {
      outcome: 'terminal';
      operation: string;
      session: AgentSession;
      turn: string;
      status: 'completed' | 'failed' | 'interrupted';
      receipt: InputRef;
    };
export type SettledAuditAttempt = Exclude<AuditAttemptObservation, { outcome: 'unknown' }>;

export function progressAuditKey(progress: ProgressAudit): string {
  [progress.task_id, progress.scope, progress.checkpoint].forEach(textField);
  for (const ref of [progress.goal_source, progress.evidence])
    [ref.locator, ref.hash].forEach(textField);
  requireWorkflow(progress.schema_version === 1, 'unsupported-progress-audit-version');
  requireWorkflow(
    progress.estimate_ms === null &&
      progress.elapsed_ms === null &&
      progress.external_wait_ms === null,
    'progress-audit-time-must-be-unknown',
  );
  requireWorkflow(
    compareInputs(progress.inputs, progress.inputs) === 'applicable',
    'progress-audit-inputs-incomplete',
  );
  requireWorkflow(
    progress.inputs.inputs.some(
      (r) => r.locator === progress.goal_source.locator && r.hash === progress.goal_source.hash,
    ),
    'progress-audit-goal-source-missing',
  );
  return JSON.stringify([
    progress.task_id,
    progress.scope,
    progress.checkpoint,
    progress.evidence.hash,
  ]);
}
