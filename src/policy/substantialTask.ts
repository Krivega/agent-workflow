import type { SubstantialAdmissionInput, SubstantialPlan } from '../contracts/substantialTask.js';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
} from '../contracts/project.js';
import { controlRef } from './readerControl.js';
import { parsePreparation } from './preparation.js';
import { localPlanningRisks, validateLocalPlan } from './localPlanning.js';

export function parseSubstantialAdmission(value: unknown): SubstantialAdmissionInput {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'preparation', 'plan', 'planning', 'acceptance']);
  requireContract(v.schemaVersion === 3, 'substantial-admission-schema');
  const plan = object(v.plan);
  exactFields(plan, ['path', 'sha256']);
  return {
    schemaVersion: 3,
    preparation: parsePreparation(v.preparation),
    plan: {
      path: relativePath(plan.path),
      sha256: controlRef({ sha256: plan.sha256, bytes: 0 }).sha256,
    },
    planning: controlRef(v.planning),
    acceptance: controlRef(v.acceptance),
  };
}
export function parseSubstantialPlan(value: unknown): SubstantialPlan {
  const v = object(value);
  exactFields(v, [
    'schema_version',
    'plan_id',
    'requirement',
    'basis',
    'owner',
    'consumers',
    'consumers_complete',
    'paths',
    'risks',
    'reason',
    'checks',
    'criterion',
  ]);
  requireContract(v.schema_version === 2, 'substantial-plan-schema');
  const risks = object(v.risks);
  requireContract(
    Object.keys(risks).length === localPlanningRisks.length &&
      localPlanningRisks.every((r) => typeof risks[r] === 'boolean') &&
      localPlanningRisks.some((r) => risks[r] === true) &&
      risks.unknown_consumers === false,
    'substantial-risks-incomplete',
  );
  const normalized = {
    ...v,
    schema_version: 1,
    risks: Object.fromEntries(localPlanningRisks.map((r) => [r, false])),
  };
  validateLocalPlan(normalized);
  for (const raw of [
    normalized.requirement,
    ...normalized.basis,
    normalized.owner,
    ...normalized.consumers,
  ]) {
    const source = object(raw);
    exactFields(source, ['locator', 'hash']);
    relativePath(source.locator);
    controlRef({ sha256: source.hash, bytes: 0 });
  }
  return {
    ...normalized,
    schema_version: 2,
    plan_id: identifier(v.plan_id),
    risks: risks as SubstantialPlan['risks'],
  };
}
