import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { sourceCheckouts } from './sourceCheckouts.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repository = resolve(process.env.AGENT_WORKFLOW_CONSUMER_ROOT ?? source);
const fixture = join(source, 'examples/temporal-consumers');

export function consumerLock(lock, metadata, sha1) {
  assert.equal(metadata.name, '@krivega/agent-workflow');
  assert.match(metadata.version, /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u);
  assert.match(sha1, /^[a-f0-9]{40}$/u);
  assert.doesNotMatch(lock, /(?:file|link|portal|workspace):/u, 'local resolution in package lock');
  for (const version of Object.values(metadata.dependencies))
    assert.match(version, /^\d+\.\d+\.\d+$/u, 'unpinned runtime dependency');
  return (
    lock +
    '\n"@krivega/agent-workflow@file:../runtime.tgz":\n' +
    `  version "${metadata.version}"\n  resolved "file:../runtime.tgz#${sha1}"\n` +
    '  dependencies:\n' +
    Object.entries(metadata.dependencies)
      .map(([name, version]) => `    ${JSON.stringify(name)} ${JSON.stringify(version)}\n`)
      .join('')
  );
}

export function isolationPolicy(root) {
  const roots = Array.isArray(root) ? root : [root];
  assert.ok(roots.length > 0);
  for (const value of roots) {
    assert.ok(typeof value === 'string' && value.startsWith('/'));
    assert.doesNotMatch(value, /[\r\n]/u);
  }
  return `(version 1) (allow default) (deny network*) ${[...new Set(roots)].map((value) => `(deny file-read* (subpath ${JSON.stringify(value)}))`).join(' ')}`;
}

const packagedInstructions = [
  'package/.agents/README.md',
  'package/.agents/skills/agent-workflow/SKILL.md',
  'package/.agents/skills/agent-workflow/agents/openai.yaml',
  'package/.agents/skills/analyze-change-impact/SKILL.md',
  'package/.agents/skills/architecture-decision-record/SKILL.md',
  'package/.agents/skills/architecture-decision-record/references/upstream-attribution.md',
  'package/.agents/skills/review-git-branch/SKILL.md',
  'package/.codex/agents/auditor.toml',
];

const publicGuides = [
  'package/docs/current-chat/compact-context.md',
  'package/docs/current-chat/council.md',
  'package/docs/current-chat/execution.md',
  'package/docs/current-chat/loading.md',
  'package/docs/current-chat/requirements.md',
  'package/docs/design/api-contract.md',
  'package/docs/quality/agent-workflow-contracts.md',
  'package/docs/temporal-sdk.md',
];

export function checkPackageFiles(entries, { npmArchive = false } = {}) {
  for (const required of [
    'package/dist/contracts/project.js',
    'package/package.json',
    ...(npmArchive ? [] : ['package/yarn.lock']),
  ])
    assert.ok(entries.includes(required), 'required package member missing: ' + required);
  for (const entry of entries) {
    assert.ok(!entry.includes('\\') && !entry.split('/').includes('..'), 'unsafe archive path');
    const path = entry.replace(/\/$/u, '');
    // Previously accepted Yarn archives also contain the toolkit's own instructions.
    if (!npmArchive && path === 'package/AGENTS.md') continue;
    if (npmArchive && path.startsWith('package/docs/'))
      assert.ok(
        publicGuides.some((guide) => guide === path || guide.startsWith(path + '/')),
        'internal document in package: ' + path,
      );
    if (packagedInstructions.some((file) => file === path || file.startsWith(path + '/'))) continue;
    assert.match(
      entry,
      /^package\/(?:(?:dist|examples|docs|src|core|ports|application|adapters|cli|comparison|harness2|roles|procedures|project)(?:\/.*)?|package\.json|yarn\.lock|README\.md|(?:CODER|COORDINATION|DIAGRAMS|FINALIZATION|LOCAL-WORKFLOW|PORTABILITY|RELAY|SUPERVISION)\.md|CURRENT-CHAT\.md|MIGRATION\.md|STORAGE\.md|EXECUTION\.md|tsconfig\.(?:base|test)\.json)\/?$/u,
      'archive entry outside the reviewed package supply',
    );
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} failed: ${result.error ?? ''}\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}

export function runPinnedConsumers(evidence) {
  assert.ok(
    process.env.AGENT_WORKFLOW_CONSUMER_ROOT,
    'Set AGENT_WORKFLOW_CONSUMER_ROOT to the explicit game checkout',
  );
  assert.equal(process.platform, 'darwin', 'the OS denial profile requires macOS');
  assert.ok(!existsSync(evidence), 'evidence directory must be new');
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const name of ['prepack', 'postpack', 'prepare'])
    assert.equal(metadata.scripts[name], undefined, 'package lifecycle requires separate review');
  assert.ok(
    existsSync(join(source, 'dist/contracts/project.js')),
    'build package before installation check',
  );
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'aw-pinned-consumers-')));
  mkdirSync(evidence, { recursive: true });
  const report = {
    schemaVersion: 1,
    kind: 'pinned-consumer-preparation',
    status: 'running',
    source,
    temporaryRoot: copy,
    package: null,
    consumers: [],
    cleaned: false,
    modelCalls: 0,
    servicesStarted: 0,
    qualification: false,
  };
  try {
    const archive = join(copy, 'runtime.tgz');
    run('yarn', ['pack', '--filename', archive], { cwd: source });
    const archiveBytes = readFileSync(archive);
    const lock = consumerLock(
      readFileSync(join(source, 'yarn.lock'), 'utf8'),
      metadata,
      digest(archiveBytes, 'sha1'),
    );
    report.package = {
      name: metadata.name,
      version: metadata.version,
      sha256: digest(archiveBytes),
    };
    cpSync(archive, join(evidence, 'runtime.tgz'));
    const entries = run('/usr/bin/tar', ['-tzf', archive]).trim().split('\n');
    checkPackageFiles(entries);
    for (const file of packagedInstructions)
      assert.ok(entries.includes(file), 'required project instruction missing: ' + file);
    writeFileSync(join(evidence, 'package-files.json'), JSON.stringify(entries, null, 2) + '\n');
    const roots = sourceCheckouts([repository, source]);
    const policy = isolationPolicy(roots);
    for (const name of ['game', 'neutral']) {
      const workspace = join(copy, name);
      mkdirSync(workspace);
      let project, card, commands;
      if (name === 'game') {
        project = JSON.parse(
          readFileSync(join(repository, 'tools/agent-workflow/project/temporal.json'), 'utf8'),
        );
        for (const path of [...project.rules, ...project.roles.map((role) => role.profile)]) {
          mkdirSync(dirname(join(workspace, path)), { recursive: true });
          cpSync(join(repository, path), join(workspace, path));
        }
        card = project.cardRoot + '/installation.md';
        mkdirSync(dirname(join(workspace, card)), { recursive: true });
        cpSync(join(fixture, 'game/task.md'), join(workspace, card));
        commands = { validate: { executable: 'yarn', args: ['validate'] } };
      } else {
        cpSync(join(fixture, 'neutral'), workspace, { recursive: true });
        project = JSON.parse(readFileSync(join(workspace, 'project.json'), 'utf8'));
        card = 'work-items/example.md';
        commands = {
          syntax: {
            executable: process.execPath,
            args: ['--check', 'smoke.mjs'],
          },
        };
      }
      writeFileSync(join(workspace, 'project.json'), JSON.stringify(project, null, 2) + '\n');
      writeFileSync(
        join(workspace, 'package.json'),
        JSON.stringify(
          {
            name: 'aw-pinned-' + name,
            private: true,
            type: 'module',
            dependencies: { '@krivega/agent-workflow': 'file:../runtime.tgz' },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(workspace, 'yarn.lock'), lock);
      writeFileSync(
        join(workspace, 'pin.json'),
        JSON.stringify({ ...report.package, card, commands }, null, 2) + '\n',
      );
      cpSync(join(fixture, 'smoke.mjs'), join(workspace, 'smoke.mjs'));
      for (const root of roots) {
        const denied = spawnSync(
          '/usr/bin/sandbox-exec',
          ['-p', policy, '/bin/cat', join(root, 'package.json')],
          { cwd: workspace, encoding: 'utf8' },
        );
        assert.notEqual(denied.status, 0, 'source read must be denied by the OS');
        assert.match(
          denied.stderr,
          /Operation not permitted/u,
          'negative probe must fail because of the OS policy',
        );
      }
      assert.equal(
        digest(readFileSync(archive)),
        report.package.sha256,
        'package archive changed before installation',
      );
      const install = run(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          policy,
          'yarn',
          'install',
          '--frozen-lockfile',
          '--offline',
          '--non-interactive',
          '--ignore-scripts',
        ],
        { cwd: workspace },
      );
      assert.equal(readFileSync(join(workspace, 'yarn.lock'), 'utf8'), lock, 'frozen lock changed');
      assert.equal(digest(readFileSync(archive)), report.package.sha256, 'package archive changed');
      const stdout = run('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, 'smoke.mjs'], {
        cwd: workspace,
      });
      assert.equal(
        digest(readFileSync(archive)),
        report.package.sha256,
        'package archive changed after smoke',
      );
      const result = JSON.parse(stdout.trim());
      report.consumers.push({
        name,
        sourceReadDenied: true,
        networkDenied: true,
        lockSha256: digest(lock),
        ...result,
      });
      mkdirSync(join(evidence, name));
      for (const path of ['package.json', 'project.json', 'yarn.lock', 'pin.json'])
        cpSync(join(workspace, path), join(evidence, name, path));
      writeFileSync(join(evidence, name, 'install.log'), install);
      writeFileSync(join(evidence, name, 'smoke.json'), stdout);
      cpSync(join(workspace, 'artifacts'), join(evidence, name, 'artifacts'), {
        recursive: true,
      });
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = String(error);
    throw error;
  } finally {
    rmSync(copy, { recursive: true, force: true });
    report.cleaned = !existsSync(copy);
    writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(
    JSON.stringify({
      status: report.status,
      evidence,
      package: report.package,
      cleaned: report.cleaned,
      qualification: false,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(
    process.argv[2],
    '--run',
    'Usage: node tests/temporal/pinned-consumers.mjs --run NEW_EVIDENCE_DIRECTORY',
  );
  assert.ok(process.argv[3] && process.argv.length === 4);
  runPinnedConsumers(resolve(process.argv[3]));
}
