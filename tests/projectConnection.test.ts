import { link, mkdir, readFile, symlink, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseCouncilConfiguration,
  parseConnection,
  localLocator,
  object,
  textField,
} from '../core/connection.js';
import {
  fileConnectionReader,
  projectDescriptor,
} from '../adapters/project/fileConnectionReader.js';
import { contentHash, projectText } from '../adapters/project/projectFiles.js';
import { inspectConnection } from '../application/inspectConnection.js';
import { runAgentWorkflow } from '../cli/runAgentWorkflow.js';
import { localFixture } from './localFixtures.js';

let f: Awaited<ReturnType<typeof localFixture>>;
beforeEach(async () => {
  f = await localFixture();
});
afterEach(async () => {
  await f.dispose();
});

it('validates the real pinned descriptor and exposes commands without executing their bodies', async () => {
  const actual = await inspectConnection(
    resolve(import.meta.dirname, '..'),
    'project/workflow.json',
    fileConnectionReader,
  );
  expect(actual).toMatchObject({
    scope: 'connection-only',
    project_id: 'agent-workflow',
    commands: ['validate'],
  });
  expect(actual.procedures).toHaveLength(12);
  const legacyPlans = { ...f.connection.plans };
  delete legacyPlans.cancelled;
  expect(parseConnection({ ...f.connection, plans: legacyPlans }).plans).toEqual(legacyPlans);
  expect(() =>
    parseConnection({
      ...f.connection,
      plans: { ...legacyPlans, cancelled: '../bad' },
    }),
  ).toThrow('unsafe-locator');
  expect(
    parseConnection({
      ...f.connection,
      procedures: f.connection.procedures.filter(
        (p) =>
          !['council', 'arbitration', 'audit', 'coordination', 'relay', 'finalization'].includes(
            p.id,
          ),
      ),
    }).procedures,
  ).toHaveLength(6);
  const deps = {
    projectReader: { read: vi.fn() },
    connectionReader: fileConnectionReader,
    cwd: f.root,
    write: vi.fn(),
    writeError: vi.fn(),
  };
  for (const args of [
    ['inspect-connection', 'connection.json'],
    ['inspect-connection', 'connection.json', f.root],
  ])
    expect(await runAgentWorkflow(args, deps)).toBe(0);
  expect(deps.projectReader.read).not.toHaveBeenCalled();
  expect(deps.write.mock.calls[0]![0]).not.toContain('NOT EXECUTED');
  for (const args of [
    ['inspect-connection'],
    ['inspect-connection', ''],
    ['inspect-connection', 'x', ''],
    ['inspect-connection', 'x', 'y', 'z'],
  ])
    expect(await runAgentWorkflow(args, deps)).toBe(2);
  expect(await runAgentWorkflow(['inspect-connection', 'missing.json'], deps)).toBe(1);
});

it('rejects unsupported versions before touching locators or commands', async () => {
  await f.file('connection.json', JSON.stringify({ schema_version: 999, rules: ['not-there'] }));
  await expect(fileConnectionReader.load(f.root, 'connection.json')).rejects.toThrow(
    'unsupported-connection-version',
  );
  expect(() => parseConnection({ ...f.connection, tool_version: 'future' })).toThrow(
    'unsupported-connection-version',
  );
  for (const value of [null, [], 3]) expect(() => object(value)).toThrow('invalid-object');
  for (const value of [null, ' ', 3]) expect(() => textField(value)).toThrow('missing-text');
  for (const value of ['../x', '/x', 'a//b', './x', 'a\\b', 'file://x', 'a%20b', 'a#b', 'a b'])
    expect(() => localLocator(value)).toThrow('unsafe-locator');
  for (const [patch, reason] of [
    [{ rules: [] }, 'missing-list'],
    [{ commands: null }, 'missing-list'],
    [{ commands: ['validate;rm'] }, 'invalid-command-name'],
    [{ procedures: f.connection.procedures.slice(1) }, 'missing-or-duplicate-procedure'],
    [
      {
        procedures: f.connection.procedures.map(() => f.connection.procedures[0]),
      },
      'missing-or-duplicate-procedure',
    ],
    [{ procedures: [{ ...f.connection.procedures[0], id: 'unknown' }] }, 'unknown-procedure'],
    [{ procedures: [{ ...f.connection.procedures[0], hash: 'bad' }] }, 'invalid-procedure-hash'],
    [
      {
        plans: { ...f.connection.plans, completed: f.connection.plans.active },
      },
      'duplicate-plan-root',
    ],
  ] as const)
    expect(() => parseConnection({ ...f.connection, ...patch })).toThrow(reason);
});

it('rejects missing commands, missing procedures, changed hashes and incorrect version headers', async () => {
  await f.file('package.json', '{"scripts":{}}');
  await expect(fileConnectionReader.load(f.root, 'connection.json')).rejects.toThrow(
    'missing-text',
  );
  await f.file('package.json', '{"scripts":{"validate":"true"}}');
  const procedure = f.connection.procedures[0]!;
  await f.file(procedure.locator, 'changed');
  await expect(fileConnectionReader.load(f.root, 'connection.json')).rejects.toThrow(
    'procedure-version-mismatch',
  );
  procedure.hash = contentHash('changed');
  await f.file('connection.json', JSON.stringify(f.connection));
  await expect(fileConnectionReader.load(f.root, 'connection.json')).rejects.toThrow(
    'procedure-header-mismatch',
  );
  await unlink(resolve(f.root, procedure.locator));
  await expect(fileConnectionReader.load(f.root, 'connection.json')).rejects.toThrow('ENOENT');
});

it('rejects symlinks, hardlinks and directory locators without escaping the project', async () => {
  await symlink(resolve(f.root, 'source.txt'), resolve(f.root, 'alias.txt'));
  await expect(projectText(f.root, 'alias.txt')).rejects.toThrow('unsafe-project-path');
  await link(resolve(f.root, 'source.txt'), resolve(f.root, 'hard.txt'));
  await expect(projectText(f.root, 'hard.txt')).rejects.toThrow('unsafe-project-file');
  await mkdir(resolve(f.root, 'directory'));
  await expect(projectText(f.root, 'directory')).rejects.toThrow('unsafe-project-file');
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('source revision 1');
});

it('validates project-owned role IDs and evidence paths before they are used', () => {
  const catalog = 'profiles/catalog.md';
  for (const profiles of [
    {},
    { '../unsafe': 'profiles/a.md' },
    { constructor: 'profiles/a.md' },
    { qa: catalog },
    { qa: '../outside.md' },
  ]) {
    expect(() => parseCouncilConfiguration({ catalog, profiles })).toThrow();
  }
  expect(() =>
    parseConnection({ ...f.connection, validation_commands: [{ file: 'npm', args: 'validate' }] }),
  ).toThrow('invalid-validation-command');
  expect(
    parseConnection({ ...f.connection, validation_commands: [{ file: 'make', args: [] }] })
      .validation_commands,
  ).toEqual([{ file: 'make', args: [] }]);
});

it('prefers the standalone descriptor when both layouts exist', async () => {
  const legacy = 'tools/agent-workflow/project/workflow.json';
  await f.file(legacy, '{}');
  expect(projectDescriptor(f.root)).toBe(legacy);
  await f.file('project/workflow.json', '{}');
  expect(projectDescriptor(f.root)).toBe('project/workflow.json');
});
