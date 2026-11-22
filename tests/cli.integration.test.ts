import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { fileProjectManifestReader } from '../adapters/project/fileProjectManifestReader.js';
import { declareBackendFixture } from './backendPolicyFixture.js';

const directories: string[] = [];
const manifest = { engines: { node: '>=26.0.0' }, scripts: { validate: 'must never execute' } };
async function project(content: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'agent-workflow-aw1-'));
  directories.push(root);
  await writeFile(resolve(root, 'package.json'), content);
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('reads the actual file without modifying it and propagates parse/read errors', async () => {
  const content = JSON.stringify(manifest);
  const root = await project(content);
  expect(await fileProjectManifestReader.read(root)).toEqual(manifest);
  expect(await readFile(resolve(root, 'package.json'), 'utf8')).toBe(content);
  await writeFile(resolve(root, 'package.json'), '{broken');
  await expect(fileProjectManifestReader.read(root)).rejects.toThrow(SyntaxError);
  await rm(resolve(root, 'package.json'));
  await expect(fileProjectManifestReader.read(root)).rejects.toThrow('ENOENT');
});

it('runs the real CLI in a separate process from another working directory', async () => {
  const root = await project(JSON.stringify(manifest));
  const cli = resolve('cli/main.ts');
  const tsx = import.meta.resolve('tsx');
  const output = execFileSync(process.execPath, ['--import', tsx, cli, 'inspect-project'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(JSON.parse(output)).toEqual({
    scope: 'configuration-only',
    nodeRange: manifest.engines.node,
    validation: { command: 'yarn validate', script: manifest.scripts.validate },
  });
  expect(() =>
    execFileSync(process.execPath, ['--import', tsx, cli, 'start'], {
      cwd: root,
      stdio: 'pipe',
    }),
  ).toThrow(expect.objectContaining({ status: 2 }));
  await writeFile(resolve(root, 'package.json'), '{}');
  expect(() =>
    execFileSync(process.execPath, ['--import', tsx, cli, 'inspect-project'], {
      cwd: root,
      stdio: 'pipe',
    }),
  ).toThrow(expect.objectContaining({ status: 1 }));
});

it.each([
  [
    'temporal',
    ['--temporal-registration', '../registration.json'],
    'task-chat-temporal-input-required',
  ],
  ['temporal', ['--temporal-input', 'input.json'], 'task-chat-temporal-input-required'],
  [
    'temporal',
    ['--state', '../run', '--card', 'task.md', '--plan', 'proposal.md'],
    'task-chat-temporal-input-required',
  ],
  [
    'blocked',
    ['--temporal-input', 'input.json', '--temporal-registration', '../registration.json'],
    'backend-new-tasks-blocked',
  ],
  [
    'temporal',
    ['--temporal-input', 'input.json', '--temporal-registration', 'input.json'],
    'task-chat-temporal-registration-private',
  ],
] as const)(
  'refuses Temporal starts through the package bin without effects: %s %j',
  async (newTasks, args, reason) => {
    const outside = await mkdtemp(resolve(tmpdir(), 'agent-workflow-task-chat-bin-'));
    directories.push(outside);
    const root = resolve(outside, 'project');
    await mkdir(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    declareBackendFixture(root);
    const backend = resolve(root, '.git/agent-workflow');
    await mkdir(backend);
    const policy = resolve(backend, 'backend-policy.json');
    const policyBytes = JSON.stringify({
      schemaVersion: 2,
      newTasks,
      startAdmission: 'task-start-admission/1',
    });
    await writeFile(policy, policyBytes);
    await writeFile(resolve(root, 'input.json'), '{}');
    await writeFile(resolve(outside, 'registration.json'), '{}', { mode: 0o600 });
    await writeFile(resolve(outside, 'codex'), '#!/bin/sh\nprintf "called\\n" > "$0.called"\n', {
      mode: 0o700,
    });
    const socketLog = resolve(outside, 'connection.called');
    const preload =
      'data:text/javascript,' +
      encodeURIComponent(`
    import { appendFileSync } from 'node:fs';
    import { Socket } from 'node:net';
    import { tmpdir, userInfo } from 'node:os';
    import { join } from 'node:path';
    const loaderSocket = join(tmpdir(), 'tsx-' + (process.geteuid?.() ?? userInfo().username), process.ppid + '.pipe');
    const { registerHooks } = await import('node:module');
    registerHooks({load(url, context, next) {
      if (['/cli/legacyTaskChatCommand.', '/application/', '/adapters/storage/'].some(part => url.includes(part)))
        throw new Error('Temporal start loaded a Legacy module: ' + url);
      return next(url, context);
    }});
    const connect = Socket.prototype.connect;
    Socket.prototype.connect = function (...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (options === loaderSocket || options?.path === loaderSocket) return connect.apply(this, args);
      appendFileSync(${JSON.stringify(socketLog)}, 'called\\n');
      throw new Error('unexpected connection');
    };
  `);
    const result = spawnSync(
      process.execPath,
      ['--import', preload, resolve('cli/entry.mjs'), 'task-chat', 'start', ...args],
      {
        cwd: root,
        env: { ...process.env, PATH: outside + delimiter + process.env.PATH },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(reason);
    expect((await readdir(outside)).sort()).toEqual(['codex', 'project', 'registration.json']);
    expect((await readdir(root)).sort()).toEqual([
      '.agent-workflow-backend.json',
      '.git',
      'input.json',
    ]);
    expect(await readdir(backend)).toEqual(['backend-policy.json']);
    expect(await readFile(policy, 'utf8')).toBe(policyBytes);
    expect(await readFile(resolve(root, 'input.json'), 'utf8')).toBe('{}');
    expect(await readFile(resolve(outside, 'registration.json'), 'utf8')).toBe('{}');
  },
);
