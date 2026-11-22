import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { afterEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  gameSourceDigest as digest,
  gameSourceRoots,
  snapshotGameSource,
  readGameSource,
  copyGameSource,
} from './full-game-source.mjs';
import {
  bindGameRuntime,
  registryGameRelease,
  readGameSnapshotInput,
} from './full-game-release.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(seed = {}) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'aw-full-game-source-')));
  roots.push(temporary);
  const root = join(temporary, 'game');
  mkdirSync(root);
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 2000 });
  git(['init', '--quiet']);
  const file = (path, body, mode = 0o644) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, { mode });
    chmodSync(join(root, path), mode);
  };
  const commit = () => {
    git(['add', '--all']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Fixture',
    ]);
  };
  file('.gitignore', 'ignored/\n');
  file('tracked.txt', 'original');
  file('deleted.txt', 'deleted later');
  for (const [path, content] of Object.entries(seed)) file(path, content);
  commit();
  const binding = () => {
    const manifest = snapshotGameSource(root);
    const path = join(temporary, 'snapshot.json');
    const bytes = JSON.stringify(manifest) + '\n';
    writeFileSync(path, bytes);
    return { root, snapshot: { path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) } };
  };
  return { temporary, root, git, file, commit, binding };
}

test('pins current tracked, staged, untracked and executable bytes without refreshing the origin index', () => {
  const f = fixture();
  f.file('tracked.txt', 'unstaged');
  f.file('staged.txt', 'staged first');
  f.git(['add', 'staged.txt']);
  f.file('staged.txt', 'actual dirty bytes');
  f.file('untracked.sh', '#!/bin/sh\nexit 0\n', 0o755);
  f.file('ignored/cache', 'not an input');
  rmSync(join(f.root, 'deleted.txt'));
  const index = readFileSync(join(f.root, '.git/index'));
  const binding = f.binding();
  const manifest = readGameSource(binding);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    ['.gitignore', 'staged.txt', 'tracked.txt', 'untracked.sh'],
  );
  assert.equal(manifest.files.at(-1).mode, 0o755);
  assert.equal(
    manifest.files.find((entry) => entry.path === 'staged.txt').sha256,
    digest('actual dirty bytes'),
  );
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index);
});

test('copies exact dirty bytes and modes with a shallow HEAD-only checkout, without deleted historical blobs', () => {
  const f = fixture({ 'tools/agent-workflow/core/old.ts': 'must never be checked out' });
  const oldBlob = f.git(['rev-parse', 'HEAD:tools/agent-workflow/core/old.ts']).trim();
  rmSync(join(f.root, 'tools'), { recursive: true });
  f.commit();
  f.file('tracked.txt', 'candidate bytes');
  f.file('new.txt', 'untracked input', 0o755);
  rmSync(join(f.root, 'deleted.txt'));
  const binding = f.binding();
  const original = readGameSource(binding);
  const index = readFileSync(join(f.root, '.git/index'));
  const copy = join(f.temporary, 'checker');
  assert.deepEqual(copyGameSource(binding, copy), original);
  assert.equal(existsSync(join(copy, 'tools/agent-workflow/core/old.ts')), false);
  assert.equal(existsSync(join(copy, 'deleted.txt')), false);
  assert.equal(readFileSync(join(copy, 'new.txt'), 'utf8'), 'untracked input');
  assert.equal(lstatSync(join(copy, 'new.txt')).mode & 0o777, 0o755);
  const copyGit = (args) =>
    execFileSync('git', args, { cwd: copy, encoding: 'utf8', stdio: 'pipe', timeout: 2000 }).trim();
  assert.equal(copyGit(['rev-parse', '--is-shallow-repository']), 'true');
  assert.equal(copyGit(['rev-parse', 'HEAD']), original.head);
  assert.equal(copyGit(['rev-list', '--count', 'HEAD']), '1');
  assert.equal(f.git(['rev-list', '--count', 'HEAD']).trim(), '2');
  assert.throws(() => copyGit(['cat-file', '-e', oldBlob]));
  assert.equal(existsSync(join(copy, '.git/objects/info/alternates')), false);
  for (const file of readdirSync(join(copy, '.git/objects/pack')))
    assert.equal(lstatSync(join(copy, '.git/objects/pack', file)).nlink, 1);
  assert.deepEqual(snapshotGameSource(copy), { ...original, root: copy });
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index);
  assert.throws(() => copyGameSource(binding, copy), /already exists/u);
  assert.throws(() => copyGameSource(binding, join(f.root, 'nested')), /independent/u);
});

test('refuses a source HEAD that changes before the shallow clone instead of accepting another commit', () => {
  const f = fixture();
  const binding = f.binding();
  const destination = join(f.temporary, 'checker');
  const execute = (command, args, options) => {
    if (args[0] === 'clone') {
      f.file('tracked.txt', 'new commit');
      f.commit();
    }
    return execFileSync(command, args, { ...options, timeout: 2000 });
  };
  assert.throws(() => copyGameSource(binding, destination, execute), /HEAD changed during clone/u);
  assert.equal(existsSync(join(destination, 'tracked.txt')), false);
});

test('rejects aliases, links, incomplete inventories and changed pins before creating a copy', () => {
  const f = fixture();
  const binding = f.binding();
  const alias = join(f.temporary, 'alias');
  symlinkSync(f.root, alias);
  assert.throws(() => snapshotGameSource(alias), /alias/u);
  for (const [name, make] of [
    ['symbolic', () => symlinkSync('tracked.txt', join(f.root, 'symbolic'))],
    ['hardlink', () => linkSync(join(f.root, 'tracked.txt'), join(f.root, 'hardlink'))],
  ]) {
    make();
    assert.throws(() => snapshotGameSource(f.root), /alias|single-link/u);
    rmSync(join(f.root, name));
  }
  f.file('extra.txt', 'unknown input');
  assert.throws(() => readGameSource(binding), /snapshot drift/u);
  rmSync(join(f.root, 'extra.txt'));
  assert.throws(
    () => readGameSource({ ...binding, snapshot: { ...binding.snapshot, sha256: '0'.repeat(64) } }),
    /hash mismatch/u,
  );
  assert.throws(
    () => readGameSource({ ...binding, snapshot: { ...binding.snapshot, bytes: 1 } }),
    /size mismatch/u,
  );
  const current = JSON.parse(readFileSync(binding.snapshot.path));
  current.files.pop();
  const bytes = JSON.stringify(current);
  writeFileSync(binding.snapshot.path, bytes);
  const incomplete = {
    ...binding,
    snapshot: { ...binding.snapshot, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) },
  };
  const destination = join(f.temporary, 'never-created');
  assert.throws(() => copyGameSource(incomplete, destination), /snapshot drift/u);
  assert.equal(existsSync(destination), false);
});

test('forwards every Git call through the supplied executor and rejects drift during copying', () => {
  const f = fixture();
  const binding = f.binding();
  let calls = 0;
  const destination = join(f.temporary, 'checker');
  const execute = (command, args, options) => {
    calls++;
    const result = execFileSync(command, args, { ...options, timeout: 2000 });
    if (args[0] === 'clone') f.file('tracked.txt', 'changed during clone');
    return result;
  };
  assert.throws(() => copyGameSource(binding, destination, execute), /changed before copy/u);
  assert.ok(calls > 0);
  assert.equal(existsSync(join(destination, 'tracked.txt')), false);
});

test('refuses escaping, special and noncanonical Git inventory entries', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'directory'));
  for (const entry of [
    '../outside',
    '/absolute',
    'tracked.txt/../tracked.txt',
    '.git/config',
    'directory',
  ]) {
    const execute = (command, args, options) =>
      args[0] === 'ls-files'
        ? entry + '\0'
        : execFileSync(command, args, { ...options, timeout: 2000 });
    assert.throws(
      () => snapshotGameSource(f.root, execute),
      /unsafe game path|regular single-link/u,
    );
  }
});

function releaseFixture(options = {}) {
  const f = fixture();
  const oldMetadata = {
    name: '@agent-workflow/runtime',
    version: '0.1.2',
    dependencies: { xstate: '5.33.3' },
    scripts: { build: 'tsc -p tsconfig.build.json' },
  };
  const metadata = {
    ...oldMetadata,
    dependencies: options.dependencies ?? oldMetadata.dependencies,
  };
  function archive(name, content, mutate = () => {}, packageMetadata = metadata) {
    const directory = join(f.temporary, name);
    mkdirSync(join(directory, 'package/dist/contracts'), { recursive: true });
    writeFileSync(join(directory, 'package/package.json'), JSON.stringify(packageMetadata));
    writeFileSync(join(directory, 'package/yarn.lock'), '# yarn lockfile v1\n');
    writeFileSync(join(directory, 'package/dist/contracts/project.js'), content, { mode: 0o755 });
    mutate(directory);
    const path = join(f.temporary, name + '.tgz');
    execFileSync('/usr/bin/tar', ['-czf', path, '-C', directory, 'package'], { timeout: 2000 });
    return path;
  }
  const oldArchive = archive('old', 'old runtime', () => {}, oldMetadata);
  const candidate = archive('candidate', 'new runtime');
  const vendor = 'tools/vendor/agent-workflow-runtime-0.1.2.tgz';
  const oldHash = digest(readFileSync(oldArchive));
  const oldPayload = JSON.stringify({
    kind: 'agent-workflow-release-payload/1',
    name: metadata.name,
    version: metadata.version,
    archiveSha256: oldHash,
    files: [],
  });
  f.file(vendor, readFileSync(oldArchive));
  f.file('tools/agent-workflow.payload.json', oldPayload);
  f.file(
    'tools/agent-workflow.runtime.json',
    JSON.stringify({
      schemaVersion: 1,
      name: metadata.name,
      version: metadata.version,
      archive: vendor,
      archiveSha256: oldHash,
      payloadManifest: 'tools/agent-workflow.payload.json',
      payloadManifestSha256: digest(oldPayload),
    }),
  );
  f.file(
    'package.json',
    JSON.stringify({
      private: true,
      scripts: {
        validate: 'real project validation',
        'agent-workflow:consumer:check': 'node scripts/agentWorkflow.mjs verify',
      },
      ...Object.fromEntries(
        [
          options.runtimeSection ?? 'dependencies',
          ...(options.duplicateSection ? [options.duplicateSection] : []),
        ].map((section) => [
          section,
          { [metadata.name]: options.consumerSelector ?? 'file:' + vendor },
        ]),
      ),
    }),
  );
  const remainder =
    '\n"other@1.0.0":\n  version "1.0.0"\n  resolved "https://registry.invalid/other.tgz#123"\n' +
    (options.lockedExtra ?? '');
  f.file(
    'yarn.lock',
    '# fixture lock\n\n"@agent-workflow/runtime@file:' +
      vendor +
      '":\n  version "0.1.2"\n  resolved "file:' +
      vendor +
      '#' +
      createHash('sha1').update(readFileSync(oldArchive)).digest('hex') +
      '"\n  dependencies:\n    ' +
      (options.lockName ?? '"xstate"') +
      ' "5.33.3"\n' +
      remainder,
  );
  const binding = f.binding();
  const checker = join(f.temporary, 'checker');
  copyGameSource(binding, checker);
  return {
    ...f,
    metadata,
    archive,
    candidate,
    binding,
    refreshBinding: f.binding,
    checker,
    vendor,
    remainder,
  };
}

test('binds the same archive into an isolated checker while preserving project scripts and every other lock stanza', () => {
  const f = releaseFixture();
  const before = readGameSource(f.binding);
  const packageBytes = readFileSync(join(f.checker, 'package.json'));
  const proof = bindGameRuntime(f.checker, f.candidate, f.metadata);
  assert.equal(proof.archive.sha256, digest(readFileSync(f.candidate)));
  assert.deepEqual(readFileSync(join(f.checker, f.vendor)), readFileSync(f.candidate));
  assert.deepEqual(readFileSync(join(f.checker, 'package.json')), packageBytes);
  assert.ok(readFileSync(join(f.checker, 'yarn.lock'), 'utf8').endsWith(f.remainder));
  const pin = JSON.parse(readFileSync(join(f.checker, 'tools/agent-workflow.runtime.json')));
  const payloadBytes = readFileSync(join(f.checker, pin.payloadManifest));
  assert.equal(pin.archiveSha256, proof.archive.sha256);
  assert.equal(pin.payloadManifestSha256, digest(payloadBytes));
  const payload = JSON.parse(payloadBytes);
  assert.equal(payload.archiveSha256, proof.archive.sha256);
  assert.equal(payload.files.length, 3);
  assert.deepEqual(
    payload.files.map((entry) => entry.path),
    ['dist/contracts/project.js', 'package.json', 'yarn.lock'],
  );
  assert.equal(payload.files[0].mode, 0o755);
  assert.equal(payload.files[0].sha256, digest('new runtime'));
  assert.equal(payload.files[0].bytes, Buffer.byteLength('new runtime'));
  assert.equal(proof.changed.length, 4);
  assert.deepEqual(readGameSource(f.binding), before);
  assert.equal(lstatSync(join(f.checker, f.vendor)).nlink, 1);
  assert.throws(() => bindGameRuntime(f.root, f.candidate, f.metadata));
});

test('refuses version or dependency graph changes before mutating any checker input', () => {
  for (const changed of [{ version: '0.1.3' }, { dependencies: { xstate: 'other' } }]) {
    const f = releaseFixture();
    const before = snapshotGameSource(f.checker);
    assert.throws(
      () => bindGameRuntime(f.checker, f.candidate, { ...f.metadata, ...changed }),
      /version change|dependency graph changed/u,
    );
    assert.deepEqual(snapshotGameSource(f.checker), before);
  }
});

test('supports the actual game devDependency without changing package bytes and refuses duplicate or foreign pins', () => {
  const f = releaseFixture({ runtimeSection: 'devDependencies', lockName: 'xstate' });
  const original = readFileSync(join(f.checker, 'package.json'));
  const proof = bindGameRuntime(f.checker, f.candidate, f.metadata);
  assert.equal(proof.archive.sha256, digest(readFileSync(f.candidate)));
  assert.deepEqual(readFileSync(join(f.checker, 'package.json')), original);
  for (const options of [
    { duplicateSection: 'devDependencies' },
    { runtimeSection: 'devDependencies', duplicateSection: 'peerDependencies' },
    { runtimeSection: 'optionalDependencies' },
    { runtimeSection: 'devDependencies', consumerSelector: 'file:tools/vendor/foreign.tgz' },
  ]) {
    const invalid = releaseFixture(options);
    const before = snapshotGameSource(invalid.checker);
    assert.throws(
      () => bindGameRuntime(invalid.checker, invalid.candidate, invalid.metadata),
      /one supported game runtime dependency|dependency pin drift/u,
    );
    assert.deepEqual(snapshotGameSource(invalid.checker), before);
  }
});

test('allows an additional exact TypeScript edge only when its existing lock resolution is already pinned', () => {
  const dependencies = { xstate: '5.33.3', typescript: '6.0.3' };
  const stanza =
    '\ntypescript@6.0.3, typescript@^6.0.3:\n  version "6.0.3"\n  resolved "https://registry.invalid/typescript.tgz#123"\n';
  const f = releaseFixture({ dependencies, lockedExtra: stanza });
  const proof = bindGameRuntime(f.checker, f.candidate, f.metadata);
  const lock = readFileSync(join(f.checker, 'yarn.lock'), 'utf8');
  assert.ok(lock.includes('    "typescript" "6.0.3"\n'));
  assert.ok(lock.endsWith(f.remainder), 'all other resolution stanzas must remain byte-identical');
  assert.equal(proof.archive.sha256, digest(readFileSync(f.candidate)));
  for (const lockedExtra of [
    '',
    stanza.replace('typescript@6.0.3, ', ''),
    stanza.replace('  version "6.0.3"', '  version "6.0.2"'),
    stanza + stanza,
  ]) {
    const bad = releaseFixture({ dependencies, lockedExtra });
    const before = snapshotGameSource(bad.checker);
    assert.throws(
      () => bindGameRuntime(bad.checker, bad.candidate, bad.metadata),
      /locked exact dependency|locked dependency version mismatch/u,
    );
    assert.deepEqual(snapshotGameSource(bad.checker), before);
  }
});

test('rejects damaged pins, checker drift and nonregular archive payloads before binding', () => {
  for (const mode of ['pin', 'metadata', 'symlink', 'hardlink', 'special-mode']) {
    const f = releaseFixture();
    let candidate = f.candidate;
    if (mode === 'pin') writeFileSync(join(f.checker, 'tools/agent-workflow.runtime.json'), '{}');
    if (mode === 'metadata') writeFileSync(join(f.checker, 'tracked.txt'), 'checker drift');
    if (mode === 'symlink')
      candidate = f.archive('linked', 'runtime', (directory) =>
        symlinkSync('project.js', join(directory, 'package/dist/contracts/link.js')),
      );
    if (mode === 'hardlink')
      candidate = f.archive('hardlinked', 'runtime', (directory) =>
        linkSync(
          join(directory, 'package/dist/contracts/project.js'),
          join(directory, 'package/dist/contracts/link.js'),
        ),
      );
    if (mode === 'special-mode')
      candidate = f.archive('special-mode', 'runtime', (directory) =>
        chmodSync(join(directory, 'package/dist/contracts/project.js'), 0o4755),
      );
    const before = snapshotGameSource(f.checker);
    assert.throws(() => bindGameRuntime(f.checker, candidate, f.metadata));
    assert.deepEqual(snapshotGameSource(f.checker), before);
  }
});

test('routes tar reads through the caller executor and refuses an archive that changes during inventory', () => {
  const f = releaseFixture();
  const before = snapshotGameSource(f.checker);
  const commands = [];
  const execute = (command, args, options) => {
    commands.push(command);
    const result = execFileSync(command, args, { ...options, timeout: 2000 });
    if (command === '/usr/bin/tar' && args[0] === '-tvzf')
      writeFileSync(f.candidate, 'replaced archive');
    return result;
  };
  assert.throws(() => bindGameRuntime(f.checker, f.candidate, f.metadata, execute));
  assert.ok(commands.includes('/usr/bin/tar'));
  assert.deepEqual(snapshotGameSource(f.checker), before);
});

test('accepts only the exact npm payload and frozen game lock without rebinding the checker', () => {
  const f = releaseFixture();
  const metadata = { ...f.metadata, name: '@krivega/agent-workflow' };
  const archive = f.archive(
    'registry',
    'public',
    (dir) => rmSync(join(dir, 'package/yarn.lock')),
    metadata,
  );
  const bytes = readFileSync(archive);
  const archiveSha256 = digest(bytes);
  const selector = metadata.name + '@' + metadata.version;
  const resolved =
    'https://registry.npmjs.org/@krivega/agent-workflow/-/agent-workflow-' +
    metadata.version +
    '.tgz#' +
    createHash('sha1').update(bytes).digest('hex');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const lock =
    JSON.stringify(selector) +
    ':\n  version ' +
    JSON.stringify(metadata.version) +
    '\n  resolved ' +
    JSON.stringify(resolved) +
    '\n  integrity ' +
    integrity +
    '\n  dependencies:\n    xstate "5.33.3"\n';
  const files = ['dist/contracts/project.js', 'package.json'].map((path) => {
    const file = join(f.temporary, 'registry/package', path);
    return {
      path,
      mode: lstatSync(file).mode & 0o777,
      bytes: lstatSync(file).size,
      sha256: digest(readFileSync(file)),
    };
  });
  const inventory = JSON.stringify({
    kind: 'agent-workflow-release-payload/1',
    name: metadata.name,
    version: metadata.version,
    archiveSha256,
    files,
  });
  const pin = {
    schemaVersion: 2,
    name: metadata.name,
    version: metadata.version,
    resolved,
    integrity,
    archiveSha256,
    payloadManifest: 'tools/agent-workflow.payload.json',
    payloadManifestSha256: digest(inventory),
  };
  f.file('tools/agent-workflow.runtime.json', JSON.stringify(pin));
  f.file(pin.payloadManifest, inventory);
  f.file(
    'package.json',
    JSON.stringify({ devDependencies: { [metadata.name]: metadata.version } }),
  );
  f.file('yarn.lock', lock);
  const binding = f.refreshBinding(),
    checker = join(f.temporary, 'registry-checker');
  copyGameSource(binding, checker);
  assert.deepEqual(gameSourceRoots(checker), [checker, f.root]);
  const proof = bindGameRuntime(checker, archive, metadata);
  assert.deepEqual(proof.changed, []);
  assert.equal(proof.payload.files, 2);
  const snapshot = readGameSource(binding);
  f.file('yarn.lock', lock.replace(integrity, 'sha512-other'));
  assert.throws(() => registryGameRelease(snapshot, archive, metadata), /input drift/);
  for (const changed of [
    lock.replace(integrity, 'sha512-other'),
    lock + '\n' + lock,
    lock.replace('5.33.3', '0.0.0'),
  ]) {
    f.file('yarn.lock', changed);
    assert.throws(() => registryGameRelease(snapshotGameSource(f.root), archive, metadata));
  }
  f.file('yarn.lock', lock);
  assert.throws(() => registryGameRelease(snapshotGameSource(f.root), f.candidate, metadata));
  assert.throws(() => readGameSnapshotInput(null, 'yarn.lock'), /pinned game snapshot/);
});
