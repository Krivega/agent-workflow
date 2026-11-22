import { requireWorkflow, object, textField, localLocator } from '../contracts/localValues.js';
import type { LocalPlanSource as InputRef } from '../contracts/localAdmission.js';

export const localPlanningRisks = [
  'new_behavior',
  'new_contract',
  'architecture',
  'storage',
  'authority',
  'security',
  'data_integrity',
  'unknown_consumers',
] as const;
export interface LocalImplementationPlan {
  schema_version: 1;
  requirement: InputRef;
  basis: InputRef[];
  owner: InputRef;
  paths: string[];
  consumers: InputRef[];
  consumers_complete: true;
  risks: Record<(typeof localPlanningRisks)[number], false>;
  reason: string;
  checks: string[];
  criterion: string;
}
export function validateLocalPlan(value: unknown): asserts value is LocalImplementationPlan {
  const plan = object(value);
  requireWorkflow(plan.schema_version === 1, 'unsupported-local-plan');
  requireWorkflow(
    Array.isArray(plan.basis) &&
      plan.basis.length > 0 &&
      Array.isArray(plan.consumers) &&
      plan.consumers.length > 0 &&
      plan.consumers_complete === true,
    'local-consumers-incomplete',
  );
  for (const raw of [
    plan.requirement,
    plan.owner,
    ...(plan.basis as unknown[]),
    ...(plan.consumers as unknown[]),
  ]) {
    const ref = object(raw);
    textField(ref.locator);
    textField(ref.hash);
  }
  requireWorkflow(
    Array.isArray(plan.paths) &&
      plan.paths.length > 0 &&
      new Set(plan.paths).size === plan.paths.length,
    'local-scope-incomplete',
  );
  plan.paths.forEach(localLocator);
  const risks = object(plan.risks);
  requireWorkflow(
    Object.keys(risks).length === localPlanningRisks.length &&
      localPlanningRisks.every((risk) => risks[risk] === false),
    'local-needs-council-planning',
  );
  [plan.reason, plan.criterion].forEach(textField);
  requireWorkflow(Array.isArray(plan.checks) && plan.checks.length > 0, 'local-checks-missing');
  plan.checks.forEach(textField);
}
