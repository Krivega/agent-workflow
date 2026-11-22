import type { LocalAdmissionInput } from '../contracts/localAdmission.js';
import { exactFields, object, relativePath, requireContract } from '../contracts/project.js';
import { controlRef } from './readerControl.js';
import { parsePreparation } from './preparation.js';

export function parseLocalAdmission(value: unknown): LocalAdmissionInput {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'preparation', 'plan', 'acceptance']);
  requireContract(v.schemaVersion === 1, 'local-admission-schema-unsupported');
  const plan = object(v.plan);
  exactFields(plan, ['path', 'sha256']);
  return {
    schemaVersion: 1,
    preparation: parsePreparation(v.preparation),
    plan: {
      path: relativePath(plan.path),
      sha256: controlRef({ sha256: plan.sha256, bytes: 0 }).sha256,
    },
    acceptance: controlRef(v.acceptance),
  };
}
export function localAdmissionKey(value: LocalAdmissionInput): string {
  const input = parseLocalAdmission(value),
    p = input.preparation;
  return `aw/local-admission/${p.project.projectId}/${p.taskId}/${input.plan.sha256}`;
}
