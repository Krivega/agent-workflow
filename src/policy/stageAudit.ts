import type { StageSupervisedTaskInput } from '../contracts/localTask.js';
import type { TaskStageAudit, TaskStageContext } from '../contracts/stageAudit.js';
import { taskAuditStages } from '../contracts/localTask.js';
import { exactFields, object, requireContract } from '../contracts/project.js';
import { parseLocalTask, stageSupervisedTask } from './localTask.js';
import { auditClaim, parseAuditInput, parseAuditTiming } from './audit.js';
import { controlRef } from './readerControl.js';

export function parseTaskStageContext(value: unknown): TaskStageContext {
  const v = object(value);
  exactFields(v, ['input', 'stage', 'snapshot', 'completed']);
  const input = parseLocalTask(v.input);
  requireContract(stageSupervisedTask(input), 'task-stage-input');
  const stage = taskAuditStages.find((s) => s === v.stage);
  requireContract(stage !== undefined && Array.isArray(v.completed), 'task-stage-context');
  const completed = v.completed.map(controlRef);
  requireContract(
    new Set(completed.map((r) => r.sha256)).size === completed.length,
    'task-stage-duplicate-evidence',
  );
  return { input, stage, snapshot: controlRef(v.snapshot), completed };
}
export function parseTaskStageAudit(
  value: unknown,
  expected: StageSupervisedTaskInput,
): TaskStageAudit {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'context', 'timing', 'claim', 'audit']);
  const context = parseTaskStageContext(v.context),
    timing = parseAuditTiming(v.timing);
  requireContract(
    v.schemaVersion === 1 &&
      v.kind === 'task-stage-supervision' &&
      JSON.stringify(context.input) === JSON.stringify(parseLocalTask(expected)),
    'task-stage-binding',
  );
  requireContract(
    timing.stage === context.stage &&
      timing.estimateMs === context.input.audit.stages[context.stage] &&
      timing.externalWaitMs === 0,
    'task-stage-time',
  );
  let audit: TaskStageAudit['audit'] = null;
  if (v.audit === null)
    requireContract(
      v.claim === null &&
        timing.elapsedMs !== null &&
        timing.knownElapsedMs < timing.estimateMs * 2,
      'task-stage-audit-required',
    );
  else {
    const raw = object(v.audit);
    exactFields(raw, ['input', 'result', 'stop']);
    const input = parseAuditInput(raw.input);
    requireContract(
      v.claim === auditClaim(timing, context.stage + '-overrun', { kind: 'overrun' }, []) &&
        input.auditId === context.stage + '-overrun' &&
        JSON.stringify(input.preparation) === JSON.stringify(context.input.admission.preparation),
      'task-stage-audit-binding',
    );
    audit = { input, result: controlRef(raw.result), stop: controlRef(raw.stop) };
  }
  return {
    schemaVersion: 1,
    kind: 'task-stage-supervision',
    context,
    timing,
    claim: v.claim as string | null,
    audit,
  };
}
