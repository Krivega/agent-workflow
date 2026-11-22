import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { consumerLock, isolationPolicy, checkPackageFiles } from './pinned-consumers.mjs';

const metadata = {
  name: '@krivega/agent-workflow',
  version: '0.1.0',
  dependencies: { '@temporalio/client': '1.24.0' },
};
const hash = 'a'.repeat(40);
test('pins the local tarball and exact runtime dependencies without a source resolution', () => {
  const lock = consumerLock('# yarn lockfile v1\n', metadata, hash);
  assert.match(lock, /agent-workflow@file:\.\.\/runtime\.tgz/u);
  assert.ok(lock.includes('resolved "file:../runtime.tgz#' + hash + '"'));
  assert.match(lock, /"@temporalio\/client" "1\.24\.0"/u);
});
test('rejects every existing local resolution and unpinned dependency', () => {
  for (const scheme of ['file', 'link', 'portal', 'workspace'])
    assert.throws(() => consumerLock('resolved "' + scheme + ':/source"', metadata, hash));
  assert.throws(() =>
    consumerLock('', { ...metadata, dependencies: { dependency: '^1.0.0' } }, hash),
  );
  assert.throws(() => consumerLock('', { ...metadata, name: 'other' }, hash));
  assert.throws(() => consumerLock('', metadata, 'bad-hash'));
});
test('OS policy denies source reads and network and quotes paths literally', () => {
  const policy = isolationPolicy('/source/with "quotes"');
  assert.ok(policy.includes('(deny network*)'));
  assert.ok(policy.includes('(subpath "/source/with \\"quotes\\"")'));
  assert.throws(() => isolationPolicy('relative'));
  assert.throws(() => isolationPolicy('/source\npath'));
});
test('accepts only the reviewed full-runtime supply and rejects unreviewed source and traversal', () => {
  const entries = [
    'package/dist/contracts/project.js',
    'package/package.json',
    'package/yarn.lock',
  ];
  checkPackageFiles([
    'package/',
    ...entries,
    'package/docs/current-chat/loading.md',
    'package/procedures/audit.md',
    'package/procedures/implementation.md',
    'package/cli/main.ts',
    'package/core/connection.ts',
    'package/src/contracts/localValues.ts',
    'package/.codex/agents/auditor.toml',
    'package/.agents/skills/analyze-change-impact/SKILL.md',
    'package/project/workflow.json',
  ]);
  for (const path of [
    'package/apps/index.ts',
    'package/node_modules/other/index.js',
    'package/tmp/evidence.json',
    'package/unreviewed/implementation.md',
    'package/.codex/config.toml',
    'package/.codex/agents/other.toml',
    'package/.agents/skills/unreviewed/SKILL.md',
    'package/docs/../secret',
  ])
    assert.throws(() => checkPackageFiles([...entries, path]));
  for (const internal of [
    'package/AGENTS.md',
    'package/docs/evidence/report.md',
    'package/docs/exec-plans/active/plan.md',
  ]) {
    checkPackageFiles([...entries, internal]);
    assert.throws(() => checkPackageFiles([...entries, internal], { npmArchive: true }));
  }
  assert.throws(() => checkPackageFiles(['package/package.json']));
});
for (const required of [
  'package/dist/contracts/project.js',
  'package/package.json',
  'package/yarn.lock',
])
  test('refuses a package missing required member ' + required, () => {
    const complete = [
      'package/dist/contracts/project.js',
      'package/package.json',
      'package/yarn.lock',
    ];
    assert.throws(() => checkPackageFiles(complete.filter((entry) => entry !== required)));
  });
test('does not replace required metadata with directory or nested spellings', () => {
  const complete = [
    'package/dist/contracts/project.js',
    'package/package.json',
    'package/yarn.lock',
  ];
  for (const required of ['package/package.json', 'package/yarn.lock'])
    for (const substitute of [required + '/', required.replace('package/', 'package/docs/')])
      assert.throws(() =>
        checkPackageFiles([...complete.filter((entry) => entry !== required), substitute]),
      );
});

test('denies the independent toolkit and consumer roots together without weakening validation', () => {
  const policy = isolationPolicy(['/consumer', '/toolkit', '/consumer']);
  assert.equal(policy.match(/subpath/g).length, 2);
  assert.ok(policy.includes('(subpath "/consumer")'));
  assert.ok(policy.includes('(subpath "/toolkit")'));
  assert.throws(() => isolationPolicy([]));
  assert.throws(() => isolationPolicy(['/consumer', 'relative']));
});

test('Yarn ships the native auditor and the local contracts linked by every procedure and role', (t) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), 'aw-package-documents-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const archive = join(temp, 'runtime.tgz');
  execFileSync('yarn', ['--silent', 'pack', '--filename', archive], { cwd: root });
  const members = new Set(
    execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trimEnd().split('\n'),
  );
  checkPackageFiles([...members]);
  for (const directory of ['dist/client', 'dist/adapters/artifacts']) {
    for (const extension of ['js', 'd.ts'])
      assert.ok(!members.has(`package/${directory}/legacyArchive.${extension}`));
  }
  const metadata = JSON.parse(execFileSync('tar', ['-xzOf', archive, 'package/package.json']));
  assert.ok(!Object.hasOwn(metadata.exports, './legacy-archive'));

  for (const path of ['CURRENT-CHAT.md', '.codex/agents/auditor.toml', '.agents/README.md']) {
    assert.ok(members.has('package/' + path), path);
    assert.deepEqual(
      execFileSync('tar', ['-xzOf', archive, 'package/' + path]),
      readFileSync(join(root, path)),
    );
  }
  for (const directory of ['procedures', 'roles']) {
    for (const name of readdirSync(join(root, directory)).filter((name) => name.endsWith('.md'))) {
      const path = posix.join('package', directory, name);
      assert.ok(members.has(path), path);
      const content = readFileSync(join(root, directory, name), 'utf8');
      for (const [, link] of content.matchAll(/\[[^\]]+\]\(([^ )]+)\)/gu)) {
        if (link.startsWith('#') || link.includes('://')) continue;
        const target = posix.join(posix.dirname(path), link.split('#')[0]);
        assert.ok(members.has(target), path + ' links to missing ' + target);
      }
    }
  }
});
