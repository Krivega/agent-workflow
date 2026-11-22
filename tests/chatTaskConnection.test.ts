import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { declareBackendFixture } from './backendPolicyFixture.js';
import { existsSync } from 'node:fs';
import { reserveTaskBackend } from '../src/adapters/project/taskBackend.js';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { FileProjectCards } from '../adapters/project/fileProjectCards.js';
import { indexChatCard } from '../adapters/project/chatCardIndex.js';
import { connectChatTask } from '../adapters/project/chatTaskConnection.js';
import type { ChatTaskRequest } from '../adapters/project/chatTaskConnection.js';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { localFixture } from './localFixtures.js';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
let f: Awaited<ReturnType<typeof localFixture>>;
let external: string;
let request: ChatTaskRequest;
beforeEach(async () => {
  f = await localFixture();
  external = await mkdtemp(resolve(dirname(f.root), 'chat-journal-'));
  request = {
    descriptor: 'connection.json',
    journal: resolve(external, 'connection'),
    cards: [f.card.locator],
    create: null,
  };
});
afterEach(async () => {
  await f.dispose();
  await rm(external, { recursive: true, force: true });
});
it('rejects an unregistered connection and new card before journal creation on an activated project', async () => {
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  declareBackendFixture(f.root);
  await f.file(
    '.git/agent-workflow/backend-policy.json',
    JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
  );
  await expect(connectChatTask(f.root, request)).rejects.toThrow('backend-assignment-required');
  expect(existsSync(request.journal)).toBe(false);
  await expect(
    connectChatTask(f.root, {
      ...request,
      cards: [],
      create: { title: 'New', goal: 'New', scope: ['source.txt'], criteria: ['check'] },
    }),
  ).rejects.toThrow('backend-consumer-not-qualified');
  expect(existsSync(request.journal)).toBe(false);
  reserveTaskBackend(f.root, {
    schemaVersion: 1,
    projectId: 'project',
    taskId: 'task',
    backend: 'legacy',
    cardName: 'task.md',
    origin: 'a'.repeat(64),
  });
  expect((await connectChatTask(f.root, request)).receipt.phase).toBe('enabled');
});
it('connects the selected existing card once, preserves unknown/manual fields, backup and stable identity', async () => {
  const result = await connectChatTask(f.root, request);
  expect(result.plan.task_id).toBe('task');
  expect(result.receipt.phase).toBe('enabled');
  expect(result.plan.before).toBe(f.card.content);
  expect(result.plan.after).toContain('ручное поле');
  expect(await connectChatTask(f.root, request)).toEqual(result);
  expect((await readdir(request.journal)).sort()).toEqual([
    'backup.json',
    'selection.json',
    'state.json',
  ]);
  await new FileTaskConnection(f.root).change(request.journal, 'DISABLE');
  await expect(connectChatTask(f.root, request)).rejects.toThrow('chat-connection-disabled');
  expect((await new FileTaskConnection(f.root).read(request.journal)).receipt.phase).toBe(
    'disabled',
  );
});
it('creates one card with generated stable IDs and recovers a card effect before its receipt', async () => {
  request.cards = [];
  request.create = {
    title: 'Проба',
    goal: 'Проверить путь',
    scope: ['source.txt'],
    criteria: ['Доказательство сохранено'],
  };
  const result = await connectChatTask(f.root, request);
  expect(result.plan.task_id).toMatch(/^chat-/u);
  expect(result.plan.card).toContain(result.plan.task_id);
  expect(result.plan.after).toContain('Проверить путь');
  expect(await connectChatTask(f.root, request)).toEqual(result);
  const state = JSON.parse(
    await readFile(resolve(request.journal, 'state.json'), 'utf8'),
  ) as Record<string, unknown>;
  state.phase = 'prepared';
  state.history = [];
  await writeFile(resolve(request.journal, 'state.json'), JSON.stringify(state));
  expect((await connectChatTask(f.root, request)).receipt.phase).toBe('enabled');
  expect(
    (await readdir(resolve(f.root, f.connection.plans.active))).filter((p) =>
      p.startsWith('chat-'),
    ),
  ).toHaveLength(1);
});
it('assigns one identity to an old unconnected card without touching its manual prose', async () => {
  await f.file(f.card.locator, '# Old\n\n- **Статус:** `active`\n\nManual.\n');
  const result = await connectChatTask(f.root, request);
  expect(result.plan.task_id).toMatch(/^chat-/u);
  expect(result.plan.after).toContain('Manual.');
});
it('rejects ambiguity, in-workspace journals, unknown notes, changed intent, disabled and manual conflicts', async () => {
  await expect(connectChatTask(f.root, { ...request, cards: [] })).rejects.toThrow(
    'chat-task-ambiguous',
  );
  await expect(
    connectChatTask(f.root, { ...request, cards: [f.card.locator, f.card.locator] }),
  ).rejects.toThrow('chat-task-ambiguous');
  await expect(
    connectChatTask(f.root, { ...request, journal: resolve(f.root, 'journal') }),
  ).rejects.toThrow('connection-journal-must-be-external');
  await f.file(f.card.locator, f.card.content.replace('schema_version: 1', 'schema_version: 99'));
  await expect(connectChatTask(f.root, request)).rejects.toThrow('unsupported-task-notes-version');
  await f.file(f.card.locator, f.card.content);
  const result = await connectChatTask(f.root, request);
  await expect(
    connectChatTask(f.root, { ...request, descriptor: './connection.json' }),
  ).rejects.toThrow();
  await writeFile(
    resolve(request.journal, 'selection.json'),
    JSON.stringify({ schema_version: 99 }),
  );
  await expect(connectChatTask(f.root, request)).rejects.toThrow('chat-selection-conflict');
  await writeFile(
    resolve(request.journal, 'selection.json'),
    JSON.stringify({ schema_version: 1, request_hash: 'wrong' }),
  );
  await expect(connectChatTask(f.root, request)).rejects.toThrow('chat-selection-conflict');
  expect(result.plan.task_id).toBe('task');
});
it('rejects empty/multiline card fields and preserves a manual edit', async () => {
  const create = { title: 'Проба', goal: 'goal', scope: ['source.txt'], criteria: ['check'] };
  const cards = await readdir(resolve(f.root, f.connection.plans.active));
  await expect(
    connectChatTask(f.root, { ...request, cards: [], create: { ...create, title: 'a\nb' } }),
  ).rejects.toThrow('chat-card-multiline-field');
  await expect(readdir(request.journal)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(resolve(f.root, f.connection.plans.active))).toEqual(cards);
  await expect(
    connectChatTask(f.root, { ...request, cards: [], create: { ...create, criteria: [] } }),
  ).rejects.toThrow('chat-card-incomplete');
  await expect(readdir(request.journal)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(resolve(f.root, f.connection.plans.active))).toEqual(cards);
  await connectChatTask(f.root, request);
  await f.file(f.card.locator, 'manual change');
  await expect(connectChatTask(f.root, request)).rejects.toThrow('connection-manual-conflict');
  expect(await readFile(resolve(f.root, f.card.locator), 'utf8')).toBe('manual change');
});

it('recovers a created card with missing connection receipts and preserves a conflicting edit or I/O failure', async () => {
  request.cards = [];
  request.create = { title: 'Recovery', goal: 'goal', scope: ['source.txt'], criteria: ['check'] };
  let result = await connectChatTask(f.root, request);
  const clear = async () => {
    await rm(resolve(request.journal, 'state.json'));
    await rm(resolve(request.journal, 'backup.json'));
  };
  await clear();
  await f.file(result.plan.card, result.plan.before);
  vi.mocked(fs.writeFile).mockRejectedValueOnce(
    Object.assign(new Error('disk failure'), { code: 'EIO' }),
  );
  await expect(connectChatTask(f.root, request)).rejects.toThrow('disk failure');
  result = await connectChatTask(f.root, request);
  await clear();
  await f.file(result.plan.card, 'manual');
  await expect(connectChatTask(f.root, request)).rejects.toThrow('chat-created-card-conflict');
});
it('refuses a non-file intent instead of treating it as missing', async () => {
  await mkdir(request.journal);
  await mkdir(resolve(request.journal, 'selection.json'));
  await expect(connectChatTask(f.root, request)).rejects.toThrow();
});

it('does not hide an index journal I/O error after connection', async () => {
  const result = await connectChatTask(f.root, request);
  vi.mocked(fs.writeFile).mockRejectedValueOnce(
    Object.assign(new Error('index disk failure'), { code: 'EIO' }),
  );
  await expect(indexChatCard(f.root, f.connection, result.plan, request.journal)).rejects.toThrow(
    'index disk failure',
  );
});

it('projects a newly created indexed card to completed with exactly one index row', async () => {
  await f.file(`${f.connection.plans.active}/README.md`, '# Active\n');
  const result = await connectChatTask(f.root, {
    ...request,
    cards: [],
    create: { title: 'New', goal: 'goal', scope: ['source.txt'], criteria: ['check'] },
  });
  const cards = new FileProjectCards(f.root, f.connection, resolve(external, 'projection'));
  expect(await readFile(resolve(f.root, f.connection.plans.active, 'README.md'), 'utf8')).toBe(
    `# Active\n\n- [${result.plan.task_id}](${result.plan.card.split('/').at(-1)!})\n`,
  );
  const card = await cards.read(result.plan.card);
  const moved = await cards.apply(await cards.prepare(card, 'completed', 'finish-new'));
  expect(moved.status).toBe('confirmed');
  expect(
    await readFile(resolve(f.root, f.connection.plans.completed, 'README.md'), 'utf8'),
  ).toContain(result.plan.task_id);
  expect(
    await readFile(resolve(f.root, f.connection.plans.active, 'README.md'), 'utf8'),
  ).not.toContain(result.plan.task_id);
});
