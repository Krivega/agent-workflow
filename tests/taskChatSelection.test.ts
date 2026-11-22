import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { workflowFixture } from './workflowFixtures.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { taskChatSelection, taskChatOptions } from '../cli/taskChatInputs.js';
import { readTaskCouncilSelection, confirmTaskCouncilSelection } from '../cli/taskChatSelection.js';
import {
  configuredRoles,
  configuredProfileLocators,
  councilAdviserName,
  councilRoles,
  changedPlanningRoles,
  createCouncil,
} from '../core/council.js';
import { compareInputs } from '../core/evidence.js';
import type { Selection } from '../core/council.js';
import { encodeProofArtifact } from '../adapters/storage/sharedArtifacts.js';

let f: Awaited<ReturnType<typeof workflowFixture>>, directory: string, files: FileWorkflowInputs;
const active = {
  trigger: true,
  reason: 'Границы модулей',
  requirements: ['architect.md'],
  inputs: { files: ['source.txt'], directories: [] },
};
const roleMap = () =>
  Object.fromEntries(
    councilRoles.map((role) => [
      role,
      role === 'architect'
        ? structuredClone(active)
        : { trigger: false, reason: `Область ${role} не затронута` },
    ]),
  );
async function plan(roles = roleMap()) {
  await f.file('roles.json', JSON.stringify({ schema_version: 1, roles }));
  return readTaskCouncilSelection(f.root, 'roles.json');
}
async function select(roles = roleMap(), targets = ['source.txt']) {
  const routing = { plan: await plan(roles), shared: ['common.md'], directory };
  return taskChatSelection(files, ['assignment.txt', 'common.md'], {}, targets, routing);
}
async function confirm(selection: Selection) {
  return confirmTaskCouncilSelection(
    f.root,
    directory,
    files,
    await files.ref('roles.json'),
    selection,
    {
      ...f.executor.spec,
      sources: await Promise.all(
        ['assignment.txt', f.card.locator, 'common.md', 'roles.json'].map((p) => files.ref(p)),
      ),
    },
  );
}
beforeEach(async () => {
  f = await workflowFixture();
  directory = await mkdtemp(resolve(dirname(f.root), 'council-selection-'));
  files = new FileWorkflowInputs(f.root, directory);
  await f.file('architect.md', 'Проверить границы модулей.');
  await f.file('backend.md', 'Проверить серверный договор.');
  await f.file('common.md', 'Общие требования.');
  await f.file('api/server.ts', 'export const version = 1;');
});
afterEach(async () => {
  await f.dispose();
  await rm(directory, { recursive: true, force: true });
});

it('does not select every adviser when applicability has not been assessed', async () => {
  await expect(taskChatSelection(files, ['source.txt'], {}, [])).rejects.toThrow(
    'council-selection-required',
  );
});

it('keeps the immutable role selection and binding when exact shared dependencies are explicitly restored', async () => {
  await f.file(
    'artifact.json',
    encodeProofArtifact(f.root, { before: [await f.ref('source.txt')] }),
  );
  const role = { ...active, inputs: { files: ['source.txt', 'artifact.json'], directories: [] } };
  const roles = { ...roleMap(), architect: role };
  const first = await select(roles);
  const graph = await files.dependencies([await files.ref('artifact.json')]);
  role.inputs.files.push(...graph.map((ref) => ref.locator));
  const next = await select(roles);
  expect(next.selection.architect).toEqual(first.selection.architect);
  expect(await confirm(next.selection)).toEqual({
    architect: first.selection.architect.requirements,
  });
  expect(
    graph.every((ref) =>
      next.inputs.inputs.some((r) => r.locator === ref.locator && r.hash === ref.hash),
    ),
  ).toBe(true);
});

it('binds only applicable profiles and independently scoped complete inputs', async () => {
  const { selection, inputs } = await select();
  expect(councilRoles.filter((role) => selection[role].trigger)).toEqual(['architect']);
  expect(selection.backend.requirements).toEqual([await files.ref('roles.json')]);
  expect(selection.architect.inputs.complete).toBe(true);
  expect(selection.architect.inputs.inputs.map((r) => r.locator)).not.toContain('assignment.txt');
  expect(inputs.inputs.map((r) => r.locator)).toContain('assignment.txt');
  expect(await confirm(selection)).toEqual({ architect: selection.architect.requirements });
  expect((await select()).selection).toEqual(selection);
});

it('changes only the affected role and rediscovers new dependencies and common requirements', async () => {
  const roles = {
    ...roleMap(),
    backend: {
      trigger: true,
      reason: 'Серверный договор',
      requirements: ['backend.md'],
      inputs: { files: [], directories: ['api'] },
    },
  };
  const first = await select(roles);
  const council = createCouncil('planning', first.selection, { ...f.target, inputs: first.inputs });
  await f.file('api/server.ts', 'export const version = 2;');
  const second = await select(roles);
  expect(changedPlanningRoles(council, second.selection)).toEqual(['backend']);
  expect(compareInputs(first.selection.architect.inputs, second.selection.architect.inputs)).toBe(
    'applicable',
  );
  await f.file('api/new.ts', 'new consumer');
  expect(
    compareInputs(
      second.selection.backend.inputs,
      await files.current(second.selection.backend.inputs),
    ),
  ).toBe('changed');
  await f.file('common.md', 'Общее требование изменено.');
  expect(changedPlanningRoles(council, (await select(roles)).selection)).toEqual([
    'architect',
    'backend',
  ]);
});

it('invalidates the role when its rationale, requirement, discovery, or profile changes', async () => {
  const first = await select();
  const council = createCouncil('planning', first.selection, { ...f.target, inputs: first.inputs });
  const roles = roleMap();
  roles.architect = { ...active, reason: 'Новая граница' };
  expect(changedPlanningRoles(council, (await select(roles)).selection)).toEqual(['architect']);
  await f.file('architect.md', 'Новое предметное требование.');
  expect(changedPlanningRoles(council, (await select()).selection)).toEqual(['architect']);
  await f.file('tools/agent-workflow/roles/architect.md', 'Новый профиль.');
  expect(changedPlanningRoles(council, (await select()).selection)).toEqual(['architect']);
  const tampered = structuredClone(first.selection);
  tampered.architect.reason = 'Подмена';
  await expect(confirm(tampered)).rejects.toThrow('council-selection-mismatch');
});

it('rejects an uncovered target and a changed selection source', async () => {
  await expect(select(roleMap(), ['api/server.ts'])).rejects.toThrow('council-target-uncovered');
  const routing = { plan: await plan(), shared: ['common.md'], directory };
  await f.file('roles.json', '{}');
  await expect(taskChatSelection(files, ['source.txt'], {}, [], routing)).rejects.toThrow(
    'workflow-input-changed',
  );
});

it('rejects conflicting or altered row evidence without rewriting history', async () => {
  const first = await select();
  const snapshot = first.selection.architect.requirements.find((ref) =>
    ref.locator.startsWith(directory),
  )!;
  const original = await readFile(snapshot.locator, 'utf8');
  await writeFile(snapshot.locator, '{"changed":true}');
  await expect(confirm(first.selection)).rejects.toThrow('workflow-input-changed');
  await expect(select()).rejects.toThrow('council-selection-conflict');
  expect(await readFile(snapshot.locator, 'utf8')).toBe('{"changed":true}');
  await writeFile(snapshot.locator, original);
  for (const patch of [
    { requirements: [await files.ref('common.md')] },
    { inputs: { ...first.selection.architect.inputs, complete: false } },
  ]) {
    await expect(
      confirm({
        ...first.selection,
        architect: { ...first.selection.architect, ...patch },
      }),
    ).rejects.toThrow('council-selection-mismatch');
  }
  await expect(
    confirmTaskCouncilSelection(
      f.root,
      directory,
      files,
      await files.ref('roles.json'),
      first.selection,
      f.executor.spec,
    ),
  ).rejects.toThrow('council-selection-not-bound');
  await expect(
    confirmTaskCouncilSelection(
      f.root,
      directory,
      files,
      await files.ref('roles.json'),
      first.selection,
      {
        ...f.spec,
        identity: { assignment_id: 'nonproduct' },
        sources: [await files.ref('roles.json')],
      },
    ),
  ).rejects.toThrow('council-selection-task-required');
});

it.each([
  [
    'missing role',
    (roles: Record<string, unknown>) => {
      delete roles.product;
    },
  ],
  [
    'unknown role',
    (roles: Record<string, unknown>) => {
      roles.other = roles.product;
    },
  ],
  [
    'unknown applicability',
    (roles: Record<string, unknown>) => {
      roles.architect = { ...active, trigger: null };
    },
  ],
  [
    'invalid trigger',
    (roles: Record<string, unknown>) => {
      roles.architect = { ...active, trigger: 'yes' };
    },
  ],
  [
    'empty reason',
    (roles: Record<string, unknown>) => {
      roles.architect = { ...active, reason: '' };
    },
  ],
  [
    'empty requirements',
    (roles: Record<string, unknown>) => {
      roles.architect = { ...active, requirements: [] };
    },
  ],
  [
    'invalid paths',
    (roles: Record<string, unknown>) => {
      roles.architect = { ...active, requirements: 'architect.md' };
    },
  ],
  [
    'unsafe path',
    (roles: Record<string, unknown>) => {
      roles.architect = { ...active, requirements: ['../secret'] };
    },
  ],
  [
    'unknown field',
    (roles: Record<string, unknown>) => {
      roles.architect = { ...active, automatic: true };
    },
  ],
  [
    'inactive requirements',
    (roles: Record<string, unknown>) => {
      roles.product = { trigger: false, reason: 'N/A', requirements: [] };
    },
  ],
  [
    'invalid discovery',
    (roles: Record<string, unknown>) => {
      roles.architect = { ...active, inputs: { files: [], directories: [], glob: '*' } };
    },
  ],
] as const)('rejects %s rather than silently skipping a review', async (_name, mutate) => {
  const roles = roleMap();
  mutate(roles);
  await expect(plan(roles)).rejects.toThrow();
});

it('validates the plan version and preserves the explicit legacy exclusion route', async () => {
  await f.file('roles.json', JSON.stringify({ schema_version: 2, roles: roleMap() }));
  await expect(readTaskCouncilSelection(f.root, 'roles.json')).rejects.toThrow(
    'invalid-council-selection',
  );
  await f.file(
    'roles.json',
    JSON.stringify({ schema_version: 1, roles: roleMap(), unexpected: true }),
  );
  await expect(readTaskCouncilSelection(f.root, 'roles.json')).rejects.toThrow(
    'invalid-council-selection',
  );
  const skipped = { backend: 'Нет серверных изменений' };
  const { selection } = await taskChatSelection(files, ['source.txt'], skipped, []);
  expect(selection.backend.trigger).toBe(false);
  expect(selection.architect.trigger).toBe(true);
  expect(selection.backend.requirements).toEqual([await files.ref('source.txt')]);
  expect(() =>
    taskChatOptions([
      'start',
      '--state',
      directory,
      '--council-selection',
      'roles.json',
      '--skip-role',
      'backend:reason',
    ]),
  ).toThrow('conflicting-council-selection');
});

it('pins five subject-specific review sets and rejects a newly uncovered consumer', async () => {
  const matrix = [
    ['architect', 'architecture/boundary.ts'],
    ['dba', 'data/codec.ts'],
    ['methodologist-literary-editor', 'learning/values.json'],
    ['ui-ux-designer', 'ui/input.ts'],
    ['devops', 'build/check.mjs'],
  ] as const;
  const roles = roleMap();
  for (const [role, input] of matrix) {
    const requirement = `requirements/${role}.md`;
    await f.file(requirement, `Обязательство роли ${role}`);
    await f.file(input, `consumer owned by ${role}`);
    roles[role] = {
      trigger: true,
      reason: `Проверить ${input} по ${requirement}`,
      requirements: [requirement],
      inputs: { files: [input], directories: [] },
    };
  }
  const targets = matrix.map(([, input]) => input);
  const first = await select(roles, targets);
  expect(await confirm(first.selection)).toHaveProperty('dba');
  for (const [role, input] of matrix) {
    const paths = first.selection[role].inputs.inputs.map((ref) => ref.locator);
    expect(paths).toContain(input);
    expect(targets.filter((target) => paths.includes(target))).toEqual([input]);
  }
  const council = createCouncil('planning', first.selection, { ...f.target, inputs: first.inputs });
  await f.file('data/codec.ts', 'corrected write failure handling');
  const next = await select(roles, targets);
  expect(changedPlanningRoles(council, next.selection)).toEqual(['dba']);
  await f.file('data/new-consumer.ts', 'new consumer');
  await expect(select(roles, [...targets, 'data/new-consumer.ts'])).rejects.toThrow(
    'council-target-uncovered',
  );
  await f.file('common.md', 'Изменён общий договор');
  expect(changedPlanningRoles(council, (await select(roles, targets)).selection).sort()).toEqual(
    matrix.map(([role]) => role).sort(),
  );
});

it('rejects roles outside a project roster and does not accept a substitute profile', async () => {
  const configuration = { catalog: 'common.md', profiles: { reviewer: 'architect.md' } };
  const [reviewer] = configuredRoles(configuration);
  expect(councilAdviserName(reviewer!)).toBe('Советник: reviewer');
  expect(() => configuredProfileLocators('architect', configuration)).toThrow(
    'unknown-council-role',
  );
  await plan();
  await expect(readTaskCouncilSelection(f.root, 'roles.json', configuration)).rejects.toThrow(
    'missing-role-selection',
  );
  await expect(
    taskChatSelection(
      files,
      ['source.txt'],
      { architect: 'not relevant' },
      [],
      undefined,
      configuration,
    ),
  ).rejects.toThrow('invalid-skipped-role');
});
