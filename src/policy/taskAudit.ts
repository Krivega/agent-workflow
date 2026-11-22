import type { SupervisedTaskInput } from '../contracts/localTask.js';
import type { TaskPlanningAudit } from '../contracts/taskAudit.js';
import { exactFields, object, requireContract } from '../contracts/project.js';
import { parseLocalTask, supervisedTask } from './localTask.js';
import { parseReviewInput } from './review.js';
import { parseAuditInput, parseAuditTiming, auditClaim } from './audit.js';
import { controlRef } from './readerControl.js';

export function parsePlanningSupervision(
  value: unknown,
  expected: SupervisedTaskInput,
): TaskPlanningAudit {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'input', 'planning', 'timing', 'claim', 'audit']);
  const input = parseLocalTask(v.input),
    planning = parseReviewInput(v.planning),
    timing = parseAuditTiming(v.timing);
  requireContract(
    v.schemaVersion === 1 &&
      v.kind === 'task-planning-supervision' &&
      supervisedTask(input) &&
      JSON.stringify(input) === JSON.stringify(parseLocalTask(expected)) &&
      JSON.stringify(planning.preparation) === JSON.stringify(input.admission.preparation),
    'task-supervision-binding',
  );
  requireContract(
    timing.stage === 'planning' &&
      timing.estimateMs === input.audit.planningEstimateMs &&
      timing.externalWaitMs === 0,
    'task-supervision-time',
  );
  if (v.audit === null) {
    requireContract(
      v.claim === null &&
        timing.elapsedMs !== null &&
        timing.knownElapsedMs < timing.estimateMs * 2,
      'task-supervision-audit-required',
    );
    return {
      schemaVersion: 1,
      kind: 'task-planning-supervision',
      input,
      planning,
      timing,
      claim: null,
      audit: null,
    };
  }
  const audit = object(v.audit);
  exactFields(audit, ['input', 'result', 'stop']);
  const auditInput = parseAuditInput(audit.input),
    claim = auditClaim(timing, 'planning-overrun', { kind: 'overrun' }, []);
  requireContract(
    v.claim === claim &&
      auditInput.auditId === 'planning-overrun' &&
      JSON.stringify(auditInput.preparation) === JSON.stringify(input.admission.preparation),
    'task-supervision-audit-binding',
  );
  return {
    schemaVersion: 1,
    kind: 'task-planning-supervision',
    input,
    planning,
    timing,
    claim,
    audit: { input: auditInput, result: controlRef(audit.result), stop: controlRef(audit.stop) },
  };
}
