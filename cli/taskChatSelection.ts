import { resolve } from 'node:path';
import { localLocator, object, requireWorkflow, textField } from '../core/connection.js';
import type { CouncilConfiguration } from '../core/connection.js';
import {
  selectedRole,
  configuredProfileLocators,
  configuredRoles,
  sameRefs,
} from '../core/council.js';
import type { CouncilRole, Selection } from '../core/council.js';
import type { InputRef, RunSpec } from '../core/localRun.js';
import { compareInputs } from '../core/evidence.js';
import type { Discovery, FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { contentHash, projectText } from '../adapters/project/projectFiles.js';
import { canonical } from '../adapters/storage/storeCodec.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';

interface RoleSelection {
  trigger: boolean;
  reason: string;
  requirements: string[];
  inputs: Discovery;
}
export interface TaskCouncilSelection {
  ref: InputRef;
  configuration?: CouncilConfiguration;
  roles: Record<CouncilRole, RoleSelection>;
}
async function logicalRoleSelection(files: FileWorkflowInputs, entry: RoleSelection) {
  const refs = await Promise.all(entry.inputs.files.map((locator) => files.ref(locator)));
  const dependencies = new Set((await files.dependencies(refs)).map((ref) => ref.locator));
  return {
    ...entry,
    inputs: {
      ...entry.inputs,
      files: entry.inputs.files.filter((path) => !dependencies.has(path)),
    },
  };
}
function roleSnapshot(directory: string, role: CouncilRole, entry: RoleSelection) {
  const row = { schema_version: 1, role, ...entry };
  return {
    row,
    ref: {
      locator: resolve(directory, `selection-${role}-${contentHash(canonical(row))}.json`),
      hash: contentHash(canonical(row) + '\n'),
    },
  };
}
function roleRequirements(
  files: FileWorkflowInputs,
  role: CouncilRole,
  entry: RoleSelection,
  shared: string[],
  snapshot: InputRef,
  configuration?: CouncilConfiguration,
) {
  return Promise.all(
    [
      ...new Set([
        ...shared,
        ...entry.requirements,
        ...configuredProfileLocators(role, configuration),
        snapshot.locator,
      ]),
    ]
      .sort()
      .map((locator) => files.ref(locator)),
  );
}
function roleDiscovery(entry: RoleSelection, requirements: InputRef[]): Discovery {
  return {
    files: [...new Set([...requirements.map((ref) => ref.locator), ...entry.inputs.files])].sort(),
    directories: entry.inputs.directories,
  };
}
function paths(value: unknown): string[] {
  requireWorkflow(Array.isArray(value), 'invalid-council-paths');
  return [...new Set(value.map(localLocator))].sort();
}
export async function readTaskCouncilSelection(
  root: string,
  locator: string,
  configuration?: CouncilConfiguration,
) {
  const content = await projectText(root, locator);
  const value = object(JSON.parse(content));
  requireWorkflow(
    value.schema_version === 1 &&
      Object.keys(value).every((key) => ['schema_version', 'roles'].includes(key)),
    'invalid-council-selection',
  );
  const councilRoles = configuredRoles(configuration);
  const roles = object(value.roles);
  requireWorkflow(
    Object.keys(roles).length === councilRoles.length &&
      councilRoles.every((role) => Object.hasOwn(roles, role)),
    'missing-role-selection',
  );
  const parsed = {} as TaskCouncilSelection['roles'];
  for (const role of councilRoles) {
    const entry = object(roles[role]);
    const reason = textField(entry.reason);
    requireWorkflow(entry.trigger !== null, `${role}:applicability-unknown`);
    requireWorkflow(typeof entry.trigger === 'boolean', 'invalid-role-trigger');
    requireWorkflow(
      Object.keys(entry).every((key) =>
        (entry.trigger
          ? ['trigger', 'reason', 'requirements', 'inputs']
          : ['trigger', 'reason']
        ).includes(key),
      ),
      'invalid-role-selection',
    );
    let requirements: string[] = [];
    let inputs: Discovery = { files: [], directories: [] };
    if (entry.trigger) {
      requirements = paths(entry.requirements);
      requireWorkflow(requirements.length > 0, 'missing-role-requirements');
      const discovery = object(entry.inputs);
      requireWorkflow(
        Object.keys(discovery).every((key) => ['files', 'directories'].includes(key)),
        'invalid-discovery',
      );
      inputs = { files: paths(discovery.files), directories: paths(discovery.directories) };
    }
    parsed[role] = { trigger: entry.trigger, reason, requirements, inputs };
  }
  return {
    ref: { locator, hash: contentHash(content) },
    roles: parsed,
    ...(configuration === undefined ? {} : { configuration }),
  };
}

export async function scopedTaskChatSelection(
  files: FileWorkflowInputs,
  refs: string[],
  targets: string[],
  routing: { plan: TaskCouncilSelection; shared: string[]; directory: string },
) {
  const councilRoles = configuredRoles(routing.plan.configuration);
  await files.verify([routing.plan.ref]);
  const selection = {} as Selection;
  const discovery: Discovery = {
    files: [...refs, ...targets, routing.plan.ref.locator],
    directories: [],
  };
  for (const role of councilRoles) {
    const declared = routing.plan.roles[role]!;
    if (!declared.trigger) continue;
    const entry = await logicalRoleSelection(files, declared);
    // Each immutable row binds its own rationale without invalidating unrelated reviewers.
    const { row, ref: snapshot } = roleSnapshot(routing.directory, role, entry);
    const saved = readManaged(snapshot.locator);
    requireWorkflow(
      saved === null || canonical(saved) === canonical(row),
      'council-selection-conflict',
    );
    if (saved === null) saveManaged(snapshot.locator, row, false);
    const requirements = await roleRequirements(
      files,
      role,
      entry,
      routing.shared,
      snapshot,
      routing.plan.configuration,
    );
    const inputs = await files.capture(
      roleDiscovery(entry, requirements),
      `Principal selection: ${role}`,
    );
    selection[role] = { trigger: true, reason: entry.reason, requirements, inputs };
    discovery.files.push(...inputs.inputs.map((ref) => ref.locator));
    discovery.files.push(...(await files.dependencies(inputs.inputs)).map((ref) => ref.locator));
    discovery.directories.push(...entry.inputs.directories);
  }
  requireWorkflow(
    targets.every((target) =>
      Object.values(selection).some((entry) =>
        entry.inputs.inputs.some((ref) => ref.locator === target),
      ),
    ),
    'council-target-uncovered',
  );
  const inputs = await files.capture(
    {
      files: [...new Set(discovery.files)].sort(),
      directories: [...new Set(discovery.directories)].sort(),
    },
    'Principal council selection',
  );
  for (const role of councilRoles) {
    if (!Object.hasOwn(selection, role))
      selection[role] = {
        trigger: false,
        reason: routing.plan.roles[role]!.reason,
        requirements: [routing.plan.ref],
        inputs,
      };
  }
  return { selection, inputs };
}

export function sharedCouncilSources(
  sources: InputRef[],
  selection: string,
  assignment: string,
  card: string,
): string[] {
  return sources
    .filter((ref) => ![selection, assignment, card].includes(ref.locator))
    .map((ref) => ref.locator);
}

export async function confirmTaskCouncilSelection(
  root: string,
  directory: string,
  files: FileWorkflowInputs,
  source: InputRef,
  selection: Selection,
  spec: RunSpec,
  configuration?: CouncilConfiguration,
) {
  await files.verify([source]);
  requireWorkflow(
    spec.sources.some((ref) => sameRefs([ref], [source])),
    'council-selection-not-bound',
  );
  const plan = await readTaskCouncilSelection(root, source.locator, configuration);
  requireWorkflow(sameRefs([source], [plan.ref]), 'workflow-input-changed');
  requireWorkflow('task_id' in spec.identity, 'council-selection-task-required');
  const shared = sharedCouncilSources(
    spec.sources,
    source.locator,
    spec.assignment.locator,
    spec.identity.card.locator,
  );
  const councilRoles = configuredRoles(configuration);
  const requirements: Partial<Record<CouncilRole, InputRef[]>> = {};
  for (const role of councilRoles) {
    const declared = plan.roles[role]!;
    const entry = declared.trigger ? await logicalRoleSelection(files, declared) : declared;
    const selected = selectedRole(selection, role);
    requireWorkflow(
      selected.trigger === entry.trigger && selected.reason === entry.reason,
      'council-selection-mismatch',
    );
    if (!entry.trigger) continue;
    const { ref } = roleSnapshot(directory, role, entry);
    await files.verify([ref]);
    const expected = await roleRequirements(files, role, entry, shared, ref, configuration);
    requireWorkflow(sameRefs(selected.requirements, expected), 'council-selection-mismatch');
    requireWorkflow(
      compareInputs(
        selected.inputs,
        await files.restore(
          selected.inputs,
          await files.capture(roleDiscovery(entry, expected), `Principal selection: ${role}`),
        ),
      ) === 'applicable',
      'council-selection-mismatch',
    );
    requirements[role] = expected;
  }
  return requirements;
}
