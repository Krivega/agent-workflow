import { readFile, unlink, symlink, chmod, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  cardCriteria,
  adoptCardMarkdown,
  projectCardStatus,
  readCardMarkdown,
} from '../adapters/project/cardMarkdown.js';
import { moveCardLinks } from '../adapters/project/cardLinks.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import * as projectFiles from '../adapters/project/projectFiles.js';
import { localFixture } from './localFixtures.js';
import { FileProjectCards } from '../adapters/project/fileProjectCards.js';

let f: Awaited<ReturnType<typeof localFixture>>;
beforeEach(async () => {
  f = await localFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.dispose();
});

async function lintIndexes() {
  await copyFile('.markdownlint-cli2.jsonc', resolve(f.root, '.markdownlint-cli2.jsonc'));
  return spawnSync(
    process.execPath,
    [
      resolve('node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs'),
      `${f.connection.plans.active}/README.md`,
      `${f.connection.plans.verifying}/README.md`,
    ],
    { cwd: f.root, encoding: 'utf8' },
  );
}

it.each([
  {
    name: 'last loose list item into a table',
    source: '# Active\n\n- [Other](other.md)\n\n- [Task](task.md)\n',
    target: '# Verifying\n\n| Plan |\n| --- |\n| [Other](other.md) |\n',
    remaining: '# Active\n\n- [Other](other.md)\n',
  },
  {
    name: 'middle loose list item into a list',
    source: '# Active\n\n- [Before](before.md)\n\n- [Task](task.md)\n\n- [After](after.md)\n',
    target: '# Verifying\n\n- [Other](other.md)\n',
    remaining: '# Active\n\n- [Before](before.md)\n\n- [After](after.md)\n',
  },
  {
    name: 'table row into a table',
    source: '# Active\n\n| Plan |\n| --- |\n| [Task](task.md) |\n| [Other](other.md) |\n',
    target: '# Verifying\n\n| Plan |\n| --- |\n| [Other](other.md) |\n',
    remaining: '# Active\n\n| Plan |\n| --- |\n| [Other](other.md) |\n',
  },
  {
    name: 'only list item into an empty index',
    source: '# Active\n\n- [Task](task.md)\n',
    target: '# Verifying\n',
    remaining: '# Active\n',
  },
  {
    name: 'table row after a manual list',
    source: '# Active\n\n| Plan |\n| --- |\n| [Task](task.md) |\n| [Other](other.md) |\n',
    target: '# Verifying\n\n- Keep this manual item.\n',
    remaining: '# Active\n\n| Plan |\n| --- |\n| [Other](other.md) |\n',
  },
  {
    name: 'list item after manual text',
    source: '# Active\n\n- [Task](task.md)\n',
    target: '# Verifying\n\nKeep this manual text.\n',
    remaining: '# Active\n',
  },
])(
  'keeps valid Markdown when moving $name and moving back',
  async ({ source, target, remaining }) => {
    const sourceIndex = `${f.connection.plans.active}/README.md`;
    const targetIndex = `${f.connection.plans.verifying}/README.md`;
    await f.file(sourceIndex, source);
    await f.file(targetIndex, target);
    let lint = await lintIndexes();
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    const plan = await f.cards.prepare(f.card, 'verifying', 'markdown-forward');
    const receipt = await f.cards.apply(plan);
    expect(receipt.status).toBe('confirmed');
    expect(await f.cards.apply(plan)).toEqual(receipt);
    expect(await readFile(resolve(f.root, targetIndex), 'utf8')).toContain(target.trimEnd());
    lint = await lintIndexes();
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    expect(await readFile(resolve(f.root, sourceIndex), 'utf8')).toBe(remaining);
    const card = await f.cards.read(plan.to);
    const reverse = await f.cards.prepare(card, 'active', 'markdown-reverse');
    expect((await f.cards.apply(reverse)).status).toBe('confirmed');
    lint = await lintIndexes();
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    expect((await f.cards.read(f.card.locator)).content).toBe(f.card.content);
  },
);

it('repairs historical confirmed index formatting without rewriting the card, intent or receipt', async () => {
  const sourceIndex = `${f.connection.plans.active}/README.md`;
  const targetIndex = `${f.connection.plans.verifying}/README.md`;
  await f.file(sourceIndex, '# Active\n\n- [Other](other.md)\n\n- [Task](task.md)\n');
  await f.file(targetIndex, '# Verifying\n\n| Plan |\n| --- |\n| [Other](other.md) |\n');
  const plan = await f.cards.prepare(f.card, 'verifying', 'historical-confirmed');
  const source = plan.changes.find((change) => change.locator === sourceIndex)!;
  const target = plan.changes.find((change) => change.locator === targetIndex)!;
  // Preserve the old formatter's confirmed output to exercise its ordinary manual repair path.
  source.after = '# Active\n\n- [Other](other.md)\n\n';
  target.after = `${target.before!.trimEnd()}\n- [Task](task.md)\n`;
  const receipt = await f.cards.apply(plan);
  expect(receipt.status).toBe('confirmed');
  const protectedPaths = [
    plan.to,
    '.journal/historical-confirmed.json',
    '.journal/historical-confirmed.receipt.json',
  ];
  const before = await Promise.all(protectedPaths.map((path) => readFile(resolve(f.root, path))));
  const failed = await lintIndexes();
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain('MD012');
  expect(failed.stderr).toContain('MD032');
  await f.file(sourceIndex, source.after.trimEnd() + '\n');
  await f.file(targetIndex, `${target.before!.trimEnd()}\n\n- [Task](task.md)\n`);
  const repaired = await lintIndexes();
  expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
  expect(await f.cards.apply(plan)).toEqual(receipt);
  expect(await Promise.all(protectedPaths.map((path) => readFile(resolve(f.root, path))))).toEqual(
    before,
  );
  expect(failed.stderr).toContain('MD012');
  expect(await readFile(resolve(f.root, sourceIndex), 'utf8')).toBe(source.after.trimEnd() + '\n');
});

it('moves active → verifying → completed → active, preserving identity, YAML, labels and ADR body', async () => {
  let card = f.card;
  const initial = card.content;
  const first = await f.cards.prepare(card, 'verifying', 'move-verifying');
  const adr = await readFile(resolve(f.root, 'decision.md'), 'utf8');
  for (const status of ['verifying', 'completed', 'active', 'blocked'] as const) {
    const plan = await f.cards.prepare(card, status, `move-${status}`);
    const result = await f.cards.apply(plan);
    expect(result.status).toBe('confirmed');
    expect(await f.cards.apply(plan)).toEqual(result);
    card = await f.cards.read(plan.to);
    expect(card).toMatchObject({ task_id: 'task', project_id: 'project', status });
    expect(card.content.replace(`\`${status}\``, '`active`')).toBe(initial);
    expect(await readFile(resolve(f.root, 'pointer.md'), 'utf8')).toContain(`${plan.to}#scope`);
    const updatedAdr = await readFile(resolve(f.root, 'decision.md'), 'utf8');
    expect(updatedAdr.slice(updatedAdr.indexOf('\n## '))).toBe(adr.slice(adr.indexOf('\n## ')));
    expect(updatedAdr).toContain(`${plan.to}#scope`);
  }
  expect((await f.cards.apply(first)).status).toBe('confirmed');
  expect((await f.cards.read(card.locator)).status).toBe('blocked');
});

it('retains both versions on a manual edit and resumes partial projection without overwriting it', async () => {
  const plan = await f.cards.prepare(f.card, 'verifying', 'manual');
  await f.file('pointer.md', 'new manual text');
  expect(await f.cards.apply(plan)).toEqual({ status: 'pending', conflicts: ['pointer.md'] });
  expect(await f.cards.read(f.card.locator)).toEqual(f.card);
  expect(JSON.parse(await readFile(resolve(f.root, '.journal/manual.json'), 'utf8'))).toEqual(plan);
  expect(await readFile(resolve(f.root, 'pointer.md'), 'utf8')).toBe('new manual text');
  const pointer = plan.changes.find((c) => c.locator === 'pointer.md')!;
  // Explicit reconciliation accepts the original input; no automatic rollback.
  await f.file('pointer.md', pointer.before!);
  await f.file(plan.to, plan.changes[0]!.after!); // Resume after the first confirmed file effect.
  expect((await f.cards.apply(plan)).status).toBe('confirmed');
  await expect(f.cards.apply({ ...plan, from: 'other.md' })).rejects.toThrow(
    'projection-operation-conflict',
  );
});

it('rejects a lost runtime boundary after asynchronous reads before mutating a card', async () => {
  const projection = await f.cards.prepare(f.card, 'verifying', 'runtime-boundary');
  let valid = true;
  const cards = new FileProjectCards(f.root, f.connection, resolve(f.root, '.journal'), () => {
    if (!valid) throw new Error('chat-runtime-directory-changed');
  });
  const read = projectFiles.projectText;
  vi.spyOn(projectFiles, 'projectText').mockImplementation(async (root, locator) => {
    const text = await read(root, locator);
    valid = false;
    return text;
  });
  await expect(cards.apply(projection)).rejects.toThrow('chat-runtime-directory-changed');
  expect(await readFile(resolve(f.root, f.card.locator), 'utf8')).toBe(f.card.content);
  await expect(readFile(resolve(f.root, projection.to))).rejects.toHaveProperty('code', 'ENOENT');
});

it('leaves future TaskNotes uninterpreted and refuses mutation; older cards need explicit adoption', () => {
  const future = readCardMarkdown(
    'card.md',
    f.card.content.replace('schema_version: 1', 'schema_version: 9'),
  );
  expect(future).toMatchObject({
    notes_version: 9,
    task_id: null,
  });
  expect(future.content).toContain('unknown:');
  expect(() => projectCardStatus(future, 'completed')).toThrow('unsupported-task-notes-version');
  const old = readCardMarkdown('old.md', '# Old\n\n- **Статус:** `active`\n');
  expect(old.task_id).toBeNull();
  expect(readCardMarkdown('old.md', adoptCardMarkdown(old, 'p', 'explicit-id')).task_id).toBe(
    'explicit-id',
  );
  expect(() => adoptCardMarkdown(f.card, 'p', 't')).toThrow('card-already-has-notes');
  expect(() => readCardMarkdown('bad', f.card.content + f.card.content)).toThrow(
    'duplicate-task-notes',
  );
  expect(() => readCardMarkdown('bad', '# None')).toThrow('missing-card-status');
  expect(() =>
    readCardMarkdown('bad', f.card.content.replace('schema_version: 1', 'schema_version: [bad')),
  ).toThrow('invalid-task-notes');
});

it('refuses ambiguous indexes, destinations, wrong identity and protected ADR body changes', async () => {
  await expect(f.cards.prepare({ ...f.card, task_id: null }, 'verifying', 'x')).rejects.toThrow(
    'card-identity-mismatch',
  );
  await expect(
    f.cards.prepare({ ...f.card, project_id: 'other' }, 'verifying', 'x'),
  ).rejects.toThrow('card-identity-mismatch');
  await expect(f.cards.prepare({ ...f.card, revision: 'stale' }, 'verifying', 'x')).rejects.toThrow(
    'invalid-card-revision',
  );
  await expect(
    f.cards.prepare({ ...f.card, locator: 'outside.md' }, 'verifying', 'x'),
  ).rejects.toThrow('card-outside-plans');
  await expect(f.cards.prepare(f.card, 'active', 'a/b')).rejects.toThrow('invalid-operation-id');
  await f.file(`${f.connection.plans.active}/README.md`, '# Active\n');
  await expect(f.cards.prepare(f.card, 'verifying', 'x')).rejects.toThrow('card-index-not-unique');
  await f.file(`${f.connection.plans.active}/README.md`, '# Active\n- [Task](task.md)\n');
  const plan = await f.cards.prepare(f.card, 'verifying', 'x');
  await f.file(plan.to, 'existing document');
  expect(await f.cards.apply(plan)).toEqual({ status: 'pending', conflicts: [plan.to] });
  await unlink(resolve(f.root, plan.to));
  await f.file(
    'decision.md',
    `# ADR-9000\n- **Status:** \`accepted\`\n\n## Body\n[Task](${f.card.locator})\n`,
  );
  await expect(f.cards.prepare(f.card, 'verifying', 'protected')).rejects.toThrow(
    'protected-adr-body-link',
  );
});

it('rebases outgoing links on a deeper move and leaves external/fragment links intact', () => {
  const text = '[Rule](../../rule.md#anchor) [Web](https://example.test) [Same](#scope)';
  expect(
    moveCardLinks(
      text,
      'plans/active/task.md',
      'archive/task.md',
      'plans/active/task.md',
      'archive/task.md',
    ),
  ).toBe('[Rule](../rule.md#anchor) [Web](https://example.test) [Same](#scope)');
  expect(moveCardLinks('[Rule](rule.md)', 'index.md', 'index.md', 'task.md', 'other/task.md')).toBe(
    '[Rule](rule.md)',
  );
  expect(contentHash(f.card.content)).toBe(f.card.revision);
  const literal =
    '```yaml\nunknown: "[Self](task.md)"\n```\n<!-- [Self](task.md) -->\n[Self](task.md)';
  expect(moveCardLinks(literal, 'task.md', 'new/task.md', 'task.md', 'new/task.md')).toBe(literal);
});

it('refuses corrupted receipts instead of repeating a confirmed projection', async () => {
  const plan = await f.cards.prepare(f.card, 'active', 'receipt');
  await expect(f.cards.apply({ ...plan, changes: [] })).rejects.toThrow(
    'missing-projection-target',
  );
  await expect(
    f.cards.apply({ ...plan, changes: [{ ...plan.changes[0]!, after: null }] }),
  ).rejects.toThrow('missing-projection-target');
  await expect(f.cards.apply({ ...plan, task_id: 'foreign' })).rejects.toThrow(
    'projection-identity-mismatch',
  );
  await expect(
    f.cards.apply({
      ...plan,
      changes: [
        {
          ...plan.changes[0]!,
          after: f.card.content.replace('project_id: "project"', 'project_id: "foreign"'),
        },
      ],
    }),
  ).rejects.toThrow('projection-identity-mismatch');
  await f.cards.apply(plan);
  for (const receipt of [
    { status: 'unknown', locator: plan.to, revision: f.card.revision },
    { status: 'confirmed', locator: 'foreign.md', revision: f.card.revision },
    { status: 'confirmed', locator: plan.to, revision: 'bad' },
  ]) {
    await f.file('.journal/receipt.receipt.json', JSON.stringify(receipt));
    await expect(f.cards.apply(plan)).rejects.toThrow('invalid-projection-receipt');
  }
  expect(await f.cards.read(f.card.locator)).toEqual(f.card);
});

it('stops a concurrent manual edit between preflight and writing, leaving the journal recoverable', async () => {
  const plan = await f.cards.prepare(f.card, 'verifying', 'race');
  const read = projectFiles.projectText;
  let reads = 0;
  vi.spyOn(projectFiles, 'projectText').mockImplementation(async (root, locator) => {
    if (locator === 'pointer.md' && ++reads === 2) await f.file(locator, 'concurrent edit');
    return read(root, locator);
  });
  expect(await f.cards.apply(plan)).toEqual({ status: 'pending', conflicts: ['pointer.md'] });
  expect(await readFile(resolve(f.root, 'pointer.md'), 'utf8')).toBe('concurrent edit');
  expect(await readFile(resolve(f.root, '.journal/race.json'), 'utf8')).toContain('operation_id');
});

it('fails closed on unsafe aliases and journal write failure before any card mutation', async () => {
  f.connection.mutable_links.push(`${f.connection.plans.active}/README.md`, 'AGENTS.md');
  const plan = await f.cards.prepare(f.card, 'verifying', 'fail');
  await expect(f.cards.apply({ ...plan, operation_id: 'a/b' })).rejects.toThrow(
    'invalid-operation-id',
  );
  await unlink(resolve(f.root, 'pointer.md'));
  await symlink(resolve(f.root, 'source.txt'), resolve(f.root, 'pointer.md'));
  await expect(f.cards.apply(plan)).rejects.toThrow('unsafe-project-path');
  expect(await f.cards.read(f.card.locator)).toEqual(f.card);
  await chmod(resolve(f.root, '.journal'), 0o500);
  try {
    await expect(f.cards.apply({ ...plan, operation_id: 'denied' })).rejects.toThrow('EACCES');
  } finally {
    await chmod(resolve(f.root, '.journal'), 0o700);
  }
  expect(await f.cards.read(f.card.locator)).toEqual(f.card);
});

it('projects accepted criteria and evidence while refusing an unchecked requirement', async () => {
  const content =
    f.card.content +
    '\n## Критерии приёмки\n\n- [ ] C1: первая строка\n  продолжение требования\n- [x] C2: другое\n\n## Ограничения\n\nУстройства не проверены.\n';
  const card = readCardMarkdown(f.card.locator, content);
  const completion = {
    criteria: cardCriteria(content),
    summary: 'Проверено',
    evidence: [{ locator: 'proof.json', hash: 'a'.repeat(64) }],
    limitations: ['Устройства'],
  };
  expect(completion.criteria).toEqual(['C1: первая строка продолжение требования', 'C2: другое']);
  expect(() =>
    projectCardStatus(
      { ...card, content: content.replace('C2: другое', 'C1: другое') },
      'completed',
      { ...completion, criteria: ['C1', 'C1: первая строка продолжение требования'] },
    ),
  ).toThrow('duplicate-criterion-id');
  const projected = projectCardStatus(card, 'completed', completion);
  expect(projected).toContain('- [x] C1: первая строка\n  продолжение требования');
  expect(projected).toContain('[Доказательство](proof.json)');
  expect(projected).toContain('Устройства не проверены.');
  expect(
    projectCardStatus(readCardMarkdown(card.locator, projected), 'completed', completion),
  ).toBe(projected);
  expect(() =>
    projectCardStatus(card, 'completed', { ...completion, criteria: ['C2: другое'] }),
  ).toThrow('completion-criterion-unaccepted');
  expect(() => projectCardStatus(card, 'active', completion)).toThrow('completion-status-mismatch');
  expect(projectCardStatus(card, 'completed', { ...completion, criteria: ['C1', 'C2'] })).toContain(
    '- [x] C1',
  );
  expect(() =>
    projectCardStatus({ ...card, content: content + '\n' }, 'completed', {
      ...completion,
      criteria: [],
    }),
  ).toThrow('completion-criterion-unaccepted');
  expect(() =>
    projectCardStatus(
      { ...card, content: content.replace('C1: первая строка', 'обычный критерий') },
      'completed',
      { ...completion, criteria: [] },
    ),
  ).toThrow('completion-criterion-unaccepted');
  expect(
    projectCardStatus(card, 'completed', {
      ...completion,
      criteria: ['C1: первая строка', 'C2: другое'],
    }),
  ).toContain('- [x] C1');
  expect(projectCardStatus(f.card, 'completed', { ...completion, limitations: [] })).toContain(
    'Принятый результат',
  );
  expect(
    projectCardStatus(
      { ...f.card, content: f.card.content.replace(/^## /gmu, '### ') },
      'completed',
      completion,
    ),
  ).toContain('Принятый результат');
  expect(
    projectCardStatus(
      { ...f.card, content: f.card.content + '\n## Критерии\n- [ ] validate: все проверки\n' },
      'completed',
      { ...completion, criteria: ['validate'] },
    ),
  ).toContain('- [x] validate:');
  expect(() =>
    projectCardStatus(
      { ...f.card, content: f.card.content + '\n## Критерии\n- [ ] validate: все проверки\n' },
      'completed',
      { ...completion, criteria: [] },
    ),
  ).toThrow('completion-criterion-unaccepted');
  expect(cardCriteria('no section')).toEqual([]);
  await f.file(card.locator, content);
  const plan = await f.cards.prepare(card, 'completed', 'complete-criteria', completion);
  expect(plan.changes[0]!.after).toContain('- [x] C1');
});
