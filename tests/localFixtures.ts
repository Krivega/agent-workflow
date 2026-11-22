import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Connection } from '../core/connection.js';
import type { LocalEvent, LocalRun, RunSpec } from '../core/localRun.js';
import { fileConnectionReader } from '../adapters/project/fileConnectionReader.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { fileRunInputs } from '../adapters/project/fileRunInputs.js';
import { FileProjectCards } from '../adapters/project/fileProjectCards.js';
import { adoptCardMarkdown, readCardMarkdown } from '../adapters/project/cardMarkdown.js';
import { applyLocalEvent } from '../core/localRun.js';

export async function localFixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'aw4-')));
  const file = async (locator: string, content: string) => {
    await mkdir(dirname(resolve(root, locator)), { recursive: true });
    await writeFile(resolve(root, locator), content);
  };
  const connection = JSON.parse(
    await readFile(new URL('../project/workflow.json', import.meta.url), 'utf8'),
  ) as Connection;
  // Existing saved tasks use the original descriptor without project-defined profiles or checks.
  delete connection.council;
  delete connection.coder_profile;
  delete connection.validation_commands;
  connection.project_id = 'project';
  connection.rules = ['AGENTS.md'];
  connection.mutable_links = ['pointer.md', 'decision.md'];
  for (const procedure of connection.procedures) {
    await file(
      procedure.locator,
      await readFile(
        resolve(
          import.meta.dirname,
          '..',
          procedure.locator.replace(/^tools\/agent-workflow\//u, ''),
        ),
        'utf8',
      ),
    );
  }
  await file('package.json', JSON.stringify({ scripts: { validate: 'echo NOT EXECUTED' } }));
  await file('AGENTS.md', '# Fixture rules\nRead only within the requested scope.\n');
  for (const [status, path] of Object.entries(connection.plans)) {
    await file(
      `${path}/README.md`,
      status === 'active' ? '# Active\n\n- [Task](task.md)\n' : `# ${status}\n`,
    );
  }
  const locator = `${connection.plans.active}/task.md`;
  const content = adoptCardMarkdown(
    readCardMarkdown(
      locator,
      '# Task\n\n- **Статус:** `active`\n\n## Scope\n\nKeep manual text.\n',
    ),
    'project',
    'task',
  );
  await file(
    locator,
    content.replace(
      'task_id: "task"',
      'task_id: "task"\nunknown:\n  list: [a, b]\n  text: |\n    ручное поле',
    ),
  );
  await file(
    'pointer.md',
    `# Pointer\n\n[Task](${locator}#scope)\n[ref]: ${locator}\n<a href="${locator}">task</a>\n`,
  );
  await file(
    'decision.md',
    `# ADR-9000\n\n- **Status:** \`accepted\`\n- **Decision basis:** [Task](${locator}#scope)\n\n## Decision\n\nKeep this body byte for byte. [Pointer](pointer.md)\n`,
  );
  await file('source.txt', 'source revision 1');
  await file(
    'assignment.txt',
    'Explicitly authorized local assignment; planning accepted for this fixture.',
  );
  await file('connection.json', JSON.stringify(connection));
  const loaded = await fileConnectionReader.load(root, 'connection.json');
  const cards = new FileProjectCards(root, connection, resolve(root, '.journal'));
  const card = await cards.read(locator);
  const ref = async (path: string) => ({
    locator: path,
    hash: contentHash(await readFile(resolve(root, path), 'utf8')),
  });
  const spec: RunSpec = {
    project_id: 'project',
    identity: { task_id: 'task', card: { locator, hash: card.revision } },
    assignment: await ref('assignment.txt'),
    product: true,
    run_id: 'run',
    session_id: 'session',
    host_id: 'host',
    workspace: root,
    parent_run_id: null,
    coordinator: false,
    role: null,
    fork_turns: 'none',
    scope: ['source.txt'],
    outcome: 'Local AW4 fixture',
    criteria: ['ready with read receipt'],
    writer: 'run',
    requested: { model: 'fixture-model', effort: 'high', permissions: ['read', 'update-card'] },
    effective: { model: 'fixture-model', effort: 'high', permissions: ['read', 'update-card'] },
    sources: [await ref('source.txt')],
    procedures: loaded.procedures.map(({ content: _content, ...procedure }) => procedure),
    rules: loaded.rules.map(({ content: _content, ...rule }) => rule),
    route: { kind: 'substantial', accepted_plan: await ref('assignment.txt') },
  };
  return {
    root,
    file,
    ref,
    spec,
    connection,
    loaded,
    cards,
    card,
    inputs: fileRunInputs(root, 'connection.json'),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
type EventDetail = LocalEvent extends infer E
  ? E extends LocalEvent
    ? Omit<E, 'event_id' | 'expected_revision' | 'generation'>
    : never
  : never;
export function event<T extends EventDetail>(
  run: LocalRun,
  detail: T,
): T & { event_id: string; expected_revision: number; generation: number } {
  return {
    event_id: `event-${run.revision}`,
    expected_revision: run.revision,
    generation: run.generation,
    ...detail,
  };
}
export function loadedRun(run: LocalRun) {
  return applyLocalEvent(
    run,
    event(run, {
      type: 'LOAD',
      receipt: {
        run_id: run.spec.run_id,
        session_id: run.spec.session_id,
        procedures: run.spec.procedures,
        rules: run.spec.rules,
        observed_read: 'fixture-only',
      },
    }),
  );
}
