import { requireWorkflow, textField } from './connection.js';
import type { CouncilConfiguration } from './connection.js';
import { selectedRole, createCouncil, configuredRoles, sameRefs } from './council.js';
import type { ReviewTarget, Selection } from './council.js';
import { compareInputs } from './evidence.js';
import type { InputManifest } from './evidence.js';
import type { InputRef, LocalImplementationPlan } from './localRun.js';
import { validateLocalPlan } from './localRun.js';

export interface LocalAdmission {
  configuration?: CouncilConfiguration;
  plan: LocalImplementationPlan;
  source: InputRef;
  inputs: InputManifest;
  selection: Selection;
}
export function localPlanRefs(plan: LocalImplementationPlan): InputRef[] {
  return [plan.requirement, plan.owner, ...plan.basis, ...plan.consumers];
}
export function validateLocalAdmission(admission: LocalAdmission, target: ReviewTarget): void {
  validateLocalPlan(admission.plan);
  [admission.source.locator, admission.source.hash].forEach(textField);
  requireWorkflow(
    compareInputs(admission.inputs, target.inputs) === 'applicable',
    'local-admission-inputs-mismatch',
  );
  requireWorkflow(
    [admission.source, ...localPlanRefs(admission.plan)].every((ref) =>
      admission.inputs.inputs.some((input) => sameRefs([input], [ref])),
    ),
    'local-admission-source-missing',
  );
  createCouncil('acceptance', admission.selection, target, admission.configuration);
  requireWorkflow(
    configuredRoles(admission.configuration).some(
      (role) => selectedRole(admission.selection, role).trigger === true,
    ),
    'local-acceptance-required',
  );
}
export function localPathAllowed(paths: string[], path: string): boolean {
  return paths.some((scope) => path === scope || path.startsWith(scope + '/'));
}
export function localStableRefs(plan: LocalImplementationPlan, refs: InputRef[]): InputRef[] {
  const fixed = [plan.requirement, ...plan.basis];
  return refs.filter(
    (ref) =>
      !localPathAllowed(plan.paths, ref.locator) ||
      fixed.some((basis) => basis.locator === ref.locator),
  );
}
function stableInputs(before: InputManifest, after: InputManifest, paths: string[]) {
  requireWorkflow(
    compareInputs(before, before) === 'applicable' && compareInputs(after, after) === 'applicable',
    'local-inputs-unknown',
  );
  const stable = (inputs: InputRef[]) =>
    inputs.filter((ref) => !localPathAllowed(paths, ref.locator));
  return sameRefs(stable(before.inputs), stable(after.inputs));
}
export function validateLocalReview(
  admission: LocalAdmission,
  target: ReviewTarget,
  selection: Selection,
): void {
  validateLocalPlan(admission.plan);
  createCouncil('acceptance', selection, target, admission.configuration);
  const paths = admission.plan.paths;
  requireWorkflow(
    stableInputs(admission.inputs, target.inputs, paths) &&
      [admission.source, admission.plan.requirement, ...admission.plan.basis].every((ref) =>
        target.inputs.inputs.some((current) => sameRefs([current], [ref])),
      ),
    'local-delta-needs-planning',
  );
  for (const role of configuredRoles(admission.configuration)) {
    const before = selectedRole(admission.selection, role),
      after = selectedRole(selection, role);
    requireWorkflow(
      before.trigger === after.trigger &&
        (!before.trigger ||
          (sameRefs(before.requirements, after.requirements) &&
            stableInputs(before.inputs, after.inputs, paths))),
      'local-delta-needs-planning',
    );
  }
}
