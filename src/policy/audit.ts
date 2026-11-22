import type {
  AuditCard,
  AuditInput,
  AuditReport,
  AuditTiming,
  AuditTrigger,
} from '../contracts/audit.js';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
  text,
} from '../contracts/project.js';
import { controlRef } from './readerControl.js';
import { parsePreparation } from './preparation.js';

function wording(value: unknown): string {
  requireContract(typeof value === 'string' && value.trim().length > 0, 'audit-text-required');
  return value;
}
function strings(value: unknown, nonempty = false): string[] {
  requireContract(Array.isArray(value) && (!nonempty || value.length > 0), 'audit-list-required');
  const result = value.map(wording);
  requireContract(new Set(result).size === result.length, 'audit-duplicate');
  return result;
}
function duration(value: unknown): number {
  requireContract(Number.isSafeInteger(value) && Number(value) >= 0, 'audit-time-invalid');
  return Number(value);
}
export function parseAuditTiming(value: unknown): AuditTiming {
  const v = object(value);
  exactFields(v, ['stage', 'estimateMs', 'elapsedMs', 'externalWaitMs', 'knownElapsedMs']);
  const estimateMs = duration(v.estimateMs),
    elapsedMs = v.elapsedMs === null ? null : duration(v.elapsedMs),
    knownElapsedMs = duration(v.knownElapsedMs);
  requireContract(
    estimateMs > 0 &&
      estimateMs <= 3_600_000 &&
      (elapsedMs === null || knownElapsedMs === elapsedMs),
    'audit-time-invalid',
  );
  return {
    stage: identifier(v.stage),
    estimateMs,
    elapsedMs,
    externalWaitMs: v.externalWaitMs === null ? null : duration(v.externalWaitMs),
    knownElapsedMs,
  };
}
export function parseAuditTrigger(value: unknown): AuditTrigger {
  const v = object(value);
  if (v.kind === 'overrun') {
    exactFields(v, ['kind']);
    return { kind: 'overrun' };
  }
  exactFields(v, ['kind', 'evidence']);
  requireContract(v.kind === 'no-progress' || v.kind === 'doubt', 'audit-trigger-invalid');
  return { kind: v.kind, evidence: controlRef(v.evidence) };
}
export function auditClaim(
  timing: AuditTiming | null,
  checkpoint: string,
  trigger: AuditTrigger,
  handled: string[],
): string {
  timing = timing === null ? null : parseAuditTiming(timing);
  identifier(checkpoint);
  trigger = parseAuditTrigger(trigger);
  if (trigger.kind === 'overrun')
    requireContract(
      timing !== null && timing.knownElapsedMs >= timing.estimateMs * 2,
      'audit-threshold-not-reached',
    );
  const stage = timing === null ? 'task-progress' : timing.stage;
  const key =
    trigger.kind === 'overrun'
      ? `${stage}:overrun`
      : `${stage}:${checkpoint}:${trigger.kind}:${trigger.evidence.sha256}`;
  requireContract(!handled.includes(key), 'audit-already-handled');
  return key;
}
export function parseAuditInput(value: unknown): AuditInput {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'preparation', 'auditId', 'card', 'preflight']);
  requireContract(v.schemaVersion === 1, 'audit-input-version');
  return {
    schemaVersion: 1,
    preparation: parsePreparation(v.preparation),
    auditId: identifier(v.auditId),
    card: controlRef(v.card),
    preflight: controlRef(v.preflight),
  };
}
export function auditWorkflowKey(input: AuditInput): string {
  const p = parseAuditInput(input);
  return `aw/audit/${p.preparation.project.projectId}/${p.preparation.taskId}/${p.auditId}`;
}
function source(value: unknown) {
  const v = object(value);
  exactFields(v, ['path', 'sha256', 'bytes']);
  return { path: relativePath(v.path), ...controlRef({ sha256: v.sha256, bytes: v.bytes }) };
}
export function parseAuditCard(value: unknown): AuditCard {
  const v = object(value);
  exactFields(v, [
    'schemaVersion',
    'kind',
    'preparation',
    'goal',
    'criteria',
    'completed',
    'openFindings',
    'checkpoint',
    'timing',
    'trigger',
    'sources',
    'nextAction',
  ]);
  requireContract(v.schemaVersion === 1 && v.kind === 'audit-card', 'audit-card-version');
  requireContract(
    Array.isArray(v.completed) && Array.isArray(v.sources) && v.sources.length > 0,
    'audit-card-incomplete',
  );
  const goal = source(v.goal),
    sources = v.sources.map(source);
  requireContract(
    new Set(sources.map((s) => s.path)).size === sources.length &&
      sources.some((s) => JSON.stringify(s) === JSON.stringify(goal)),
    'audit-goal-source-missing',
  );
  const card: AuditCard = {
    schemaVersion: 1,
    kind: 'audit-card',
    preparation: parsePreparation(v.preparation),
    goal,
    criteria: strings(v.criteria, true),
    completed: v.completed.map(controlRef),
    openFindings: strings(v.openFindings),
    checkpoint: identifier(v.checkpoint),
    timing: v.timing === null ? null : parseAuditTiming(v.timing),
    trigger: parseAuditTrigger(v.trigger),
    sources,
    nextAction: wording(v.nextAction),
  };
  auditClaim(card.timing, card.checkpoint, card.trigger, []);
  return card;
}
export function parseAuditReport(
  value: unknown,
  question: { ref: AuditInput['card']; checkpoint: string; sources: string[] },
): AuditReport {
  const v = object(value);
  exactFields(v, [
    'schemaVersion',
    'card',
    'coverage',
    'direction',
    'reasons',
    'sources',
    'checkpoint',
    'nextResult',
    'limitations',
  ]);
  requireContract(
    v.schemaVersion === 1 &&
      JSON.stringify(controlRef(v.card)) === JSON.stringify(question.ref) &&
      v.checkpoint === question.checkpoint,
    'audit-report-binding',
  );
  requireContract(v.coverage === 'complete' || v.coverage === 'partial', 'audit-report-coverage');
  requireContract(
    v.direction === null ||
      v.direction === 'continue' ||
      v.direction === 'replace-approach' ||
      v.direction === 'replace-executor' ||
      v.direction === 'reconsider-constraints',
    'audit-direction-invalid',
  );
  requireContract(
    v.coverage !== 'complete' || v.direction !== null,
    'audit-complete-without-direction',
  );
  const sources = strings(v.sources, true);
  requireContract(
    sources.every((s) => question.sources.includes(s)),
    'audit-report-source-unbound',
  );
  return {
    schemaVersion: 1,
    card: question.ref,
    coverage: v.coverage,
    direction: v.direction,
    reasons: strings(v.reasons, true),
    sources,
    checkpoint: text(v.checkpoint),
    nextResult: wording(v.nextResult),
    limitations: strings(v.limitations),
  };
}
