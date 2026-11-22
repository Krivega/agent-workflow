import {
  selectedRole,
  configuredRoles,
  changedPlanningRoles,
  repeatCouncil,
  revisePlanning,
  sameRefs,
} from '../core/council.js';
import type { Council, ReviewTarget, Selection } from '../core/council.js';
import { requireWorkflow } from '../core/connection.js';
import { copyState } from '../core/equality.js';
import { compareInputs, targetEvidenceInputs } from '../core/evidence.js';
import type { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';

export async function restoreCouncilSelection(
  council: Council,
  actual: Selection,
  files: FileWorkflowInputs,
): Promise<Selection> {
  const selection = copyState(actual);
  for (const role of configuredRoles(council.configuration)) {
    const before = selectedRole(council.selection, role);
    const after = selectedRole(selection, role);
    const answer = council.advisers[role]?.answer;
    if (
      answer?.verdict !== 'PASS' ||
      answer.coverage !== 'complete' ||
      !before.trigger ||
      !after.trigger ||
      before.reason !== after.reason ||
      !sameRefs(before.requirements, after.requirements) ||
      compareInputs(before.inputs, before.inputs) !== 'applicable' ||
      compareInputs(after.inputs, after.inputs) !== 'applicable' ||
      before.inputs.discovery_rule !== after.inputs.discovery_rule
    )
      continue;
    const old = new Set(before.inputs.inputs.map((ref) => ref.locator));
    const added = after.inputs.inputs.filter((ref) => !old.has(ref.locator));
    if (added.length === 0 || !sameRefs([...before.inputs.inputs, ...added], after.inputs.inputs))
      continue;
    const graph = new Map(
      (await files.dependencies(before.inputs.inputs)).map((ref) => [ref.locator, ref.hash]),
    );
    if (added.every((ref) => graph.get(ref.locator) === ref.hash))
      after.inputs = copyState(before.inputs);
  }
  return selection;
}

export async function refreshCouncilInputs(
  council: Council,
  target: ReviewTarget,
  files: FileWorkflowInputs,
) {
  requireWorkflow(target.inputs.complete, 'incomplete-council-target');
  requireWorkflow(
    compareInputs(target.inputs, await files.current(target.inputs)) === 'applicable',
    'stale-council-target',
  );
  const evidence = targetEvidenceInputs(target);
  requireWorkflow(
    compareInputs(evidence, await files.current(evidence)) === 'applicable',
    'stale-council-evidence',
  );
  const targetInputs = new Map(evidence.inputs.map((ref) => [ref.locator, ref.hash]));
  let selection = copyState(council.selection);
  for (const role of configuredRoles(council.configuration)) {
    const entry = selectedRole(selection, role);
    requireWorkflow(entry.trigger !== null, `${role}:applicability-unknown`);
    if (!entry.trigger) continue;
    entry.inputs = await files.current(entry.inputs);
    requireWorkflow(entry.inputs.complete, `${role}:incomplete-inputs`);
    requireWorkflow(
      entry.inputs.inputs.every((ref) => targetInputs.get(ref.locator) === ref.hash),
      `${role}:inputs-outside-target`,
    );
    entry.requirements = await Promise.all(entry.requirements.map((ref) => files.ref(ref.locator)));
  }
  selection = await restoreCouncilSelection(council, selection, files);
  if (council.phase === 'planning') return revisePlanning(council, selection, target);
  const changed = changedPlanningRoles(council, selection, target);
  const roles = configuredRoles(council.configuration).filter(
    (role) =>
      selectedRole(selection, role).trigger &&
      (council.target.scope !== target.scope ||
        changed.includes(role) ||
        council.advisers[role]?.answer?.verdict !== 'PASS' ||
        council.advisers[role]?.answer?.coverage !== 'complete'),
  );
  return roles.length === 0
    ? { ...copyState(council), selection, target: copyState(target) }
    : repeatCouncil(council, target, roles, selection);
}
