import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { declareBackendFixture } from './backendPolicyFixture.js';
import { existsSync } from 'node:fs';
import { reserveTaskBackend } from '../src/adapters/project/taskBackend.js';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { connectionTransition, validateConnectionPlan } from '../core/taskConnection.js';
import type { TaskConnectionPlan } from '../core/taskConnection.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { runTaskConnectionCommand } from '../cli/taskConnectionCommand.js';
import { localFixture, loadedRun } from './localFixtures.js';
import { startLocalRun } from '../core/localRun.js';
import { connectCardMarkdown, readCardMarkdown } from '../adapters/project/cardMarkdown.js';
let f: Awaited<ReturnType<typeof localFixture>>,
  external: string,
  service: FileTaskConnection,
  card: string;
beforeEach(async () => {
  f = await localFixture();
  external = await mkdtemp(resolve(tmpdir(), 'aw10-'));
  external = await (await import('node:fs/promises')).realpath(external);
  service = new FileTaskConnection(f.root);
  card = f.connection.plans.active + '/legacy.md';
  await f.file(card, '# Legacy\n\n- **Статус:** `active`\n\nРучной текст.\n');
});
afterEach(async () => {
  await f.dispose();
  await rm(external, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const preview = () => service.preview('connection.json', card, 'chosen-task');
it('requires an inventoried Legacy assignment before connection writes and permits the exact old task', async () => {
  const plan = await preview();
  const before = await readFile(resolve(f.root, card), 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  declareBackendFixture(f.root);
  await f.file(
    '.git/agent-workflow/backend-policy.json',
    JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
  );
  await expect(service.apply(plan, journal())).rejects.toThrow('backend-assignment-required');
  expect(existsSync(journal())).toBe(false);
  expect(await readFile(resolve(f.root, card), 'utf8')).toBe(before);
  reserveTaskBackend(f.root, {
    schemaVersion: 1,
    projectId: 'project',
    taskId: 'chosen-task',
    backend: 'legacy',
    cardName: 'legacy.md',
    origin: 'a'.repeat(64),
  });
  await service.apply(plan, journal());
  await service.change(journal(), 'DISABLE');
  expect((await service.read(journal())).receipt.phase).toBe('disabled');
});
it('refuses backend conflicts before connection change acquires its writer lock', async () => {
  const plan = await preview();
  await service.apply(plan, journal());
  const before = await readFile(stateFile(), 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  declareBackendFixture(f.root);
  await f.file(
    '.git/agent-workflow/backend-policy.json',
    JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
  );
  reserveTaskBackend(f.root, {
    schemaVersion: 1,
    projectId: 'project',
    taskId: 'chosen-task',
    backend: 'temporal',
    cardName: 'legacy.md',
    origin: 'a'.repeat(64),
  });
  const lock = resolve(journal(), 'writer.lock');
  await writeFile(lock, 'existing-owner');
  await expect(service.change(journal(), 'ROLLBACK')).rejects.toThrow('backend-route-conflict');
  expect(await readFile(lock, 'utf8')).toBe('existing-owner');
  expect(await readFile(stateFile(), 'utf8')).toBe(before);
});
const journal = () => resolve(external, 'journal');
const stateFile = () => resolve(journal(), 'state.json');
const editState = async (patch: Record<string, unknown>) =>
  writeFile(
    stateFile(),
    JSON.stringify({
      ...(JSON.parse(await readFile(stateFile(), 'utf8')) as Record<string, unknown>),
      ...patch,
    }),
  );
it('upgrades existing v1 YAML without losing unknown fields, then projects v2 through the current card writer', async () => {
  const legacy = await f.cards.read(f.card.locator),
    plan = await service.preview('connection.json', f.card.locator, 'task');
  expect(plan.from_version).toBe(1);
  expect(plan.after).toContain('ручное поле');
  expect(plan.after.replace('schema_version: 2', 'schema_version: 1')).toBe(plan.before);
  const connected = readCardMarkdown(f.card.locator, plan.after);
  expect(connected.notes_version).toBe(2);
  await service.apply(plan, journal());
  await expect(
    f.inputs.verify(
      loadedRun(
        startLocalRun(
          {
            ...f.spec,
            identity: {
              task_id: 'task',
              card: { locator: connected.locator, hash: connected.revision },
            },
          },
          1,
        ),
      ),
    ),
  ).resolves.toBeUndefined();
  const projected = await f.cards.prepare(connected, 'blocked', 'v2-status');
  expect((await f.cards.apply(projected)).status).toBe('confirmed');
  expect((await f.cards.read(f.card.locator)).status).toBe('blocked');
  expect(() => connectCardMarkdown({ ...legacy, notes_version: 99 }, 'project', 'task')).toThrow(
    'unsupported',
  );
  expect(() =>
    connectCardMarkdown(
      { ...legacy, content: legacy.content.replace('schema_version: 1', 'schema_version: []') },
      'project',
      'task',
    ),
  ).toThrow('invalid-schema-node');
});
it('dry-runs without writes, connects exactly one card, disables and rolls back exact original bytes', async () => {
  const before = await readFile(resolve(f.root, card), 'utf8'),
    plan = await preview();
  expect(await readFile(resolve(f.root, card), 'utf8')).toBe(before);
  expect(plan).toMatchObject({
    from_version: null,
    to_version: 2,
    project_id: 'project',
    task_id: 'chosen-task',
  });
  const enabled = await service.apply(plan, journal());
  expect(enabled.receipt.phase).toBe('enabled');
  expect(await service.apply(plan, journal())).toEqual(enabled);
  const existing = await preview();
  expect(existing.from_version).toBe(2);
  expect(existing.before).toBe(existing.after);
  await service.change(journal(), 'DISABLE');
  expect((await service.change(journal(), 'DISABLE')).receipt.phase).toBe('disabled');
  await service.change(journal(), 'ENABLE');
  await service.change(journal(), 'DISABLE');
  await service.change(journal(), 'ROLLBACK');
  expect((await service.change(journal(), 'ROLLBACK')).receipt.phase).toBe('rolled-back');
  expect(await readFile(resolve(f.root, card), 'utf8')).toBe(before);
  expect(JSON.parse(await readFile(resolve(journal(), 'backup.json'), 'utf8'))).toEqual(plan);
  expect(() => connectionTransition('enabled', 'ROLLBACK')).toThrow('transition');
});
it('rejects unknown versions, missing procedures, identity conflicts and cards outside the selected plan roots', async () => {
  const plan = await preview();
  for (const patch of [
    { schema_version: 2 },
    { tool_version: 'future' },
    { to_version: 9 },
    { from_version: 9 },
  ])
    expect(() => validateConnectionPlan({ ...plan, ...patch } as TaskConnectionPlan)).toThrow(
      'unsupported',
    );
  await f.file('outside.md', plan.before);
  await expect(service.preview('connection.json', 'outside.md', 'task')).rejects.toThrow('outside');
  await f.file(card, plan.after.replace('schema_version: 2', 'schema_version: 9'));
  await expect(preview()).rejects.toThrow('unsupported');
  for (const after of [
    plan.after.replace('project_id: "project"', 'project_id: "other"'),
    plan.after.replace('task_id: "chosen-task"', 'task_id: "other"'),
  ]) {
    await f.file(card, after);
    await expect(preview()).rejects.toThrow('identity');
  }
  await f.file(card, plan.before);
  await rm(resolve(f.root, f.connection.procedures[0]!.locator));
  await expect(preview()).rejects.toThrow('ENOENT');
});
it('detects changed descriptor/rules, a tampered migration delta and manual edits before applying', async () => {
  const plan = await preview();
  for (const patch of [
    { descriptor: { ...plan.descriptor, hash: 'changed' } },
    { project_id: 'other' },
    { procedures: [] },
    { rules: [] },
  ])
    await expect(service.apply({ ...plan, ...patch }, journal())).rejects.toThrow('inputs-changed');
  for (const patch of [
    { from_version: 1 as const },
    { after: plan.before },
    { after: plan.after.replace('project_id: "project"', 'project_id: "other"') },
    { task_id: 'other' },
  ])
    await expect(service.apply({ ...plan, ...patch }, journal())).rejects.toThrow('card-mismatch');
  await expect(
    service.apply({ ...plan, after: plan.after + 'unexpected' }, journal()),
  ).rejects.toThrow('unexpected-delta');
  await f.file('outside.md', plan.before);
  await expect(service.apply({ ...plan, card: 'outside.md' }, journal())).rejects.toThrow(
    'outside',
  );
  await f.file(card, plan.before + 'manual edit');
  await expect(service.apply(plan, journal())).rejects.toThrow('manual-conflict');
  expect(await readFile(resolve(f.root, card), 'utf8')).toContain('manual edit');
});
it('rejects corrupt backup/history and external journal aliases without changing the card', async () => {
  const plan = await preview();
  await expect(service.apply(plan, f.root)).rejects.toThrow('external');
  await expect(service.apply(plan, resolve(f.root, 'journal'))).rejects.toThrow('external');
  const alias = resolve(external, 'alias');
  await symlink(f.root, alias);
  await expect(service.apply(plan, resolve(alias, 'journal'))).rejects.toThrow('permission-denied');
  await service.apply(plan, journal());
  const state = await readFile(stateFile(), 'utf8');
  for (const patch of [{ schema_version: 2 }, { plan_hash: 'bad' }, { history: null }]) {
    await writeFile(stateFile(), state);
    await editState(patch);
    await expect(service.read(journal())).rejects.toThrow('unsupported');
  }
  await writeFile(stateFile(), state);
  await editState({ phase: 'disabled' });
  await expect(service.read(journal())).rejects.toThrow('history');
  await writeFile(stateFile(), state);
  await f.file(card, plan.before);
  await expect(service.apply(plan, journal())).rejects.toThrow('incomplete');
  await f.file(card, plan.after);
  await writeFile(
    resolve(journal(), 'backup.json'),
    JSON.stringify({ ...plan, before: plan.before + 'changed' }),
  );
  await expect(service.apply(plan, journal())).rejects.toThrow('backup-conflict');
});
it('recovers a partial card write and an identical pending state, but retains conflicting pending bytes', async () => {
  const plan = await preview();
  await service.apply(plan, journal());
  await editState({ phase: 'prepared', history: [] });
  const pending = {
    schema_version: 1,
    phase: 'enabled',
    plan_hash: contentHash(JSON.stringify(plan)),
    history: ['ENABLE'],
  };
  await writeFile(stateFile() + '.pending', JSON.stringify(pending));
  expect((await service.apply(plan, journal())).receipt.phase).toBe('enabled');
  await writeFile(stateFile() + '.pending', 'unrelated');
  await expect(service.change(journal(), 'DISABLE')).rejects.toThrow('partial-conflict');
  expect(await readFile(stateFile() + '.pending', 'utf8')).toBe('unrelated');
  await rm(stateFile() + '.pending');
  await service.change(journal(), 'DISABLE');
  await f.file('AGENTS.md', 'changed rules');
  await expect(service.change(journal(), 'ENABLE')).rejects.toThrow('inputs-changed');
  await service.change(journal(), 'ROLLBACK');
  expect(await readFile(resolve(f.root, card), 'utf8')).toBe(plan.before);
});
it('surfaces IO failures without replacing backup, state or an unrelated pending file', async () => {
  const plan = await preview();
  await mkdir(journal());
  await chmod(journal(), 0o500);
  try {
    await expect(service.apply(plan, journal())).rejects.toThrow('EACCES');
  } finally {
    await chmod(journal(), 0o700);
  }
  await mkdir(resolve(journal(), 'backup.json'));
  await expect(service.apply(plan, journal())).rejects.toThrow();
  await rm(resolve(journal(), 'backup.json'), { recursive: true });
  await writeFile(resolve(journal(), 'backup.json'), JSON.stringify(plan));
  await chmod(journal(), 0o500);
  try {
    await expect(service.apply(plan, journal())).rejects.toThrow('EACCES');
  } finally {
    await chmod(journal(), 0o700);
  }
  await mkdir(stateFile());
  await expect(service.apply(plan, journal())).rejects.toThrow();
  await rm(stateFile(), { recursive: true });
  await writeFile(resolve(f.root, card) + '.pending', 'other');
  await expect(service.apply(plan, journal())).rejects.toThrow('partial-conflict');
  await rm(resolve(f.root, card) + '.pending');
  const parent = dirname(resolve(f.root, card));
  await chmod(parent, 0o500);
  try {
    await expect(service.apply(plan, journal())).rejects.toThrow('EACCES');
  } finally {
    await chmod(parent, 0o700);
  }
});
it('runs preview/apply/disable/rollback commands with explicit inputs and ordinary CLI errors', async () => {
  const output = vi.fn(),
    error = vi.fn(),
    planFile = resolve(external, 'plan.json');
  expect(
    await runTaskConnectionCommand(
      ['preview-task', 'connection.json', card, 'chosen-task'],
      f.root,
      output,
      error,
    ),
  ).toBe(0);
  await writeFile(planFile, output.mock.calls[0]![0] as string);
  expect(
    await runTaskConnectionCommand(
      ['apply-task', planFile, journal(), f.root],
      'unused',
      output,
      error,
    ),
  ).toBe(0);
  expect(await runTaskConnectionCommand(['disable-task', journal()], f.root, output, error)).toBe(
    0,
  );
  expect(
    await runTaskConnectionCommand(['rollback-task', journal(), f.root], 'unused', output, error),
  ).toBe(0);
  for (const args of [
    [],
    ['unknown'],
    ['preview-task'],
    ['apply-task', '', 'x'],
    ['disable-task', 'a', 'b', 'c'],
  ])
    expect(await runTaskConnectionCommand(args, f.root, output, error)).toBe(2);
  expect(
    await runTaskConnectionCommand(['apply-task', 'missing', journal()], f.root, output, error),
  ).toBe(1);
  vi.spyOn(FileTaskConnection.prototype, 'preview').mockRejectedValue('opaque failure');
  expect(
    await runTaskConnectionCommand(['preview-task', 'd', 'c', 't'], f.root, output, error),
  ).toBe(1);
  expect(error).toHaveBeenLastCalledWith('Не удалось изменить подключение.');
});
