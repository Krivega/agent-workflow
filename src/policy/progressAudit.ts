import type { ProgressSupervisedTaskInput } from '../contracts/localTask.js';
import type { TaskProgressAudit, TaskProgressContext } from '../contracts/progressAudit.js';
import { exactFields, object, relativePath, requireContract, text } from '../contracts/project.js';
import { parsePreparation } from './preparation.js';
import { parseLocalTask } from './localTask.js';
import { auditClaim, parseAuditInput } from './audit.js';
import { controlRef } from './readerControl.js';

export function parseTaskProgressContext(value: unknown): TaskProgressContext {
  const raw = object(value);
  exactFields(raw, ['input', 'snapshot', 'baseline', 'taskElapsedMs']);
  const input = parseLocalTask(raw.input);
  requireContract(input.schemaVersion === 9, 'task-progress-input');
  requireContract(
    raw.taskElapsedMs === null ||
      (Number.isSafeInteger(raw.taskElapsedMs) && Number(raw.taskElapsedMs) >= 0),
    'task-progress-time',
  );
  return {
    input,
    snapshot: controlRef(raw.snapshot),
    baseline: controlRef(raw.baseline),
    taskElapsedMs: raw.taskElapsedMs === null ? null : Number(raw.taskElapsedMs),
  };
}
export function taskProgressAuditId(input: ProgressSupervisedTaskInput) {
  return 'progress-' + input.progress.checkpoint;
}
export function parseTaskProgressEvidence(
  value: unknown,
  input: ProgressSupervisedTaskInput,
  goal: { path: string; sha256: string; bytes: number },
) {
  const raw = object(value);
  exactFields(raw, [
    'schemaVersion',
    'kind',
    'preparation',
    'checkpoint',
    'trigger',
    'goal',
    'evidence',
    'reason',
  ]);
  const source = object(raw.goal);
  exactFields(source, ['path', 'sha256', 'bytes']);
  const actual = {
    path: relativePath(source.path),
    ...controlRef({ sha256: source.sha256, bytes: source.bytes }),
  };
  requireContract(
    raw.schemaVersion === 1 &&
      raw.kind === 'task-progress-request' &&
      JSON.stringify(parsePreparation(raw.preparation)) ===
        JSON.stringify(input.admission.preparation) &&
      raw.checkpoint === input.progress.checkpoint &&
      raw.trigger === input.progress.trigger.kind &&
      JSON.stringify(actual) === JSON.stringify(goal),
    'task-progress-evidence-binding',
  );
  requireContract(
    Array.isArray(raw.evidence) && raw.evidence.length > 0,
    'task-progress-evidence-required',
  );
  const evidence = raw.evidence.map(controlRef);
  requireContract(
    new Set(evidence.map((r) => r.sha256)).size === evidence.length,
    'task-progress-duplicate-evidence',
  );
  requireContract(
    typeof raw.reason === 'string' && raw.reason.trim().length > 0,
    'task-progress-reason-required',
  );
  return { evidence, reason: text(raw.reason) };
}
export function parseTaskProgressAudit(
  value: unknown,
  expected: ProgressSupervisedTaskInput,
): TaskProgressAudit {
  const raw = object(value);
  exactFields(raw, ['schemaVersion', 'kind', 'context', 'timing', 'claim', 'audit']);
  const context = parseTaskProgressContext(raw.context),
    audit = object(raw.audit);
  exactFields(audit, ['input', 'result', 'stop']);
  const input = parseAuditInput(audit.input);
  const claim = auditClaim(
    null,
    context.input.progress.checkpoint,
    context.input.progress.trigger,
    [],
  );
  requireContract(
    raw.schemaVersion === 1 &&
      raw.kind === 'task-progress-supervision' &&
      raw.timing === null &&
      JSON.stringify(context.input) === JSON.stringify(parseLocalTask(expected)) &&
      raw.claim === claim &&
      input.auditId === taskProgressAuditId(context.input) &&
      JSON.stringify(input.preparation) === JSON.stringify(context.input.admission.preparation),
    'task-progress-audit-binding',
  );
  return {
    schemaVersion: 1,
    kind: 'task-progress-supervision',
    context,
    timing: null,
    claim,
    audit: { input, result: controlRef(audit.result), stop: controlRef(audit.stop) },
  };
}
