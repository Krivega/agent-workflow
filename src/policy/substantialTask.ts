import type {
  SubstantialAdmissionInput,
  SubstantialCriterionCheck,
  SubstantialPlan,
} from '../contracts/substantialTask.js';
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
import { textField } from '../contracts/localValues.js';

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
function criterionChecks(value: unknown): SubstantialCriterionCheck[] {
  requireContract(Array.isArray(value), 'substantial-criterion-checks');
  return value.map((item: unknown) => {
    const raw = object(item);
    const { stage } = raw;
    const common = {
      criterion: textField(raw.criterion),
      ...(raw.evidence === undefined ? {} : { evidence: textField(raw.evidence) }),
      ...(raw.success === undefined ? {} : { success: textField(raw.success) }),
    };
    if (stage === 'acceptance') {
      exactFields(raw, [...Object.keys(common), 'stage', 'roleId', 'subject']);
      return { ...common, stage, roleId: identifier(raw.roleId), subject: textField(raw.subject) };
    }
    requireContract(
      stage === 'baseline' || stage === 'candidate' || stage === 'integrated',
      'substantial-criterion-check-stage',
    );
    exactFields(raw, [...Object.keys(common), 'stage', 'command']);
    return { ...common, stage, command: identifier(raw.command) };
  });
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
    ...(v.criterion_checks === undefined ? [] : ['criterion_checks']),
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
    ...(v.criterion_checks === undefined
      ? {}
      : { criterion_checks: criterionChecks(v.criterion_checks) }),
  };
}
