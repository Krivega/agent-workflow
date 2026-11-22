import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { checkPackageFiles } from './pinned-consumers.mjs';
import {
  canonicalGamePath,
  exactFields,
  gameCopyMarker,
  gameRelativePath,
  gameSourceDigest as digest,
  readGameFile,
  snapshotGameSource,
} from './full-game-source.mjs';

const pinPath = 'tools/agent-workflow.runtime.json';
const payloadPath = 'tools/agent-workflow.payload.json';
function payload(archive, metadata, execute, npmArchive = false) {
  const run = (args, encoding) =>
    execute('/usr/bin/tar', args, { encoding, maxBuffer: 32 * 1024 * 1024, stdio: 'pipe' });
  const names = run(['-tzf', archive], 'utf8').trimEnd().split('\n');
  checkPackageFiles(names, { npmArchive });
  const rows = run(['-tvzf', archive], 'utf8').trimEnd().split('\n');
  assert.equal(rows.length, names.length);
  const entries = new Map();
  for (const [index, entry] of names.entries()) {
    const path = entry.replace(/\/$/u, '');
    assert.ok(path === 'package' || path.startsWith('package/'));
    assert.equal(posix.normalize(path), path);
    assert.ok(!/[\\\r\n\0]/u.test(path) && !path.split('/').includes('..'));
    assert.ok(!entries.has(path), 'duplicate tar entry');
    const row = rows[index];
    assert.ok(row.endsWith(' ' + entry) && ['-', 'd'].includes(row[0]), 'nonregular tar member');
    assert.match(row.slice(1, 10), /^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/u);
    entries.set(path, {
      entry,
      regular: row[0] === '-',
      mode: row
        .slice(1, 10)
        .split('')
        .reduce((mode, flag, bit) => mode | (flag === '-' ? 0 : 1 << (8 - bit)), 0),
    });
  }
  for (const path of entries.keys())
    for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent))
      assert.ok(!entries.get(parent)?.regular, 'tar parent is a file');
  const files = [];
  for (const [path, entry] of [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (!entry.regular) continue;
    assert.ok(path.startsWith('package/'), 'regular package root refused');
    const bytes = Buffer.from(run(['-xOf', archive, entry.entry], null));
    files.push({
      path: path.slice('package/'.length),
      mode: entry.mode,
      bytes: bytes.length,
      sha256: digest(bytes),
    });
    if (path === 'package/package.json')
      assert.deepEqual(JSON.parse(bytes), metadata, 'archive metadata mismatch');
  }
  assert.ok(files.some((file) => file.path === 'package.json'));
  return files;
}
function runtimeLock(lock, selector, metadata, sha1) {
  const header = JSON.stringify(metadata.name + '@' + selector) + ':';
  const chunks = lock.split(/(?<=\n)\n/u);
  const selected = chunks.filter((chunk) => chunk.startsWith(header + '\n'));
  assert.equal(selected.length, 1, 'one exact runtime lock stanza required');
  const old = selected[0];
  const lines = old.trimEnd().split('\n');
  assert.equal(lines[1], `  version "${metadata.version}"`, 'runtime lock version drift');
  assert.match(
    lines[2],
    new RegExp(
      '^  resolved "' + selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '#[a-f0-9]{40}"$',
      'u',
    ),
  );
  assert.equal(lines[3], '  dependencies:');
  const dependencies = Object.create(null);
  for (const line of lines.slice(4)) {
    const match = /^    (?:"([^"\\]+)"|([a-z0-9][a-z0-9._-]*)) ("[^"\\]+")$/u.exec(line);
    assert.ok(match, 'unrecognized runtime lock dependency');
    const dependency = match[1] ?? match[2];
    assert.ok(!Object.hasOwn(dependencies, dependency), 'duplicate runtime dependency');
    dependencies[dependency] = JSON.parse(match[3]);
  }
  for (const [dependency, version] of Object.entries(dependencies))
    assert.equal(metadata.dependencies?.[dependency], version, 'runtime dependency graph changed');
  for (const [dependency, version] of Object.entries(metadata.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/u, 'exact runtime dependency required');
    if (Object.hasOwn(dependencies, dependency)) continue;
    const target = dependency + '@' + version;
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const selectorPattern = new RegExp(
      '(?:^|,\\s*)(?:"' + escaped + '"|' + escaped + ')(?=,|:$)',
      'u',
    );
    const locked = chunks.filter((chunk) => selectorPattern.test(chunk.split('\n')[0]));
    assert.equal(locked.length, 1, 'one existing locked exact dependency required: ' + target);
    assert.equal(
      locked[0].split('\n')[1],
      `  version "${version}"`,
      'existing locked dependency version mismatch',
    );
  }
  const updated =
    [
      lines[0],
      lines[1],
      `  resolved "${selector}#${sha1}"`,
      '  dependencies:',
      ...Object.entries(metadata.dependencies).map(
        ([dependency, version]) => `    ${JSON.stringify(dependency)} ${JSON.stringify(version)}`,
      ),
    ].join('\n') + old.match(/\n*$/u)[0];
  return chunks.map((chunk) => (chunk === old ? updated : chunk)).join('\n');
}
export function readGameSnapshotInput(snapshot, path) {
  assert.ok(snapshot, 'npm archive requires a pinned game snapshot');
  const file = readGameFile(join(snapshot.root, path));
  assert.deepEqual(
    { path, ...file.ref },
    snapshot.files.find((entry) => entry.path === path),
    'game release input drift',
  );
  return file;
}

/** Verify the registry release against the isolated game source before its first offline install. */
export function registryGameRelease(snapshot, archivePath, metadata, execute = execFileSync) {
  const input = (path) => readGameSnapshotInput(snapshot, path);
  const pin = JSON.parse(input(pinPath).bytes);
  exactFields(pin, [
    'schemaVersion',
    'name',
    'version',
    'resolved',
    'integrity',
    'archiveSha256',
    'payloadManifest',
    'payloadManifestSha256',
  ]);
  assert.equal(pin.schemaVersion, 2);
  assert.equal(pin.name, '@krivega/agent-workflow');
  assert.equal(metadata.name, pin.name);
  assert.equal(metadata.version, pin.version);
  const archive = readGameFile(archivePath);
  assert.equal(archive.ref.sha256, pin.archiveSha256);
  const sha1 = createHash('sha1').update(archive.bytes).digest('hex');
  assert.equal(
    pin.resolved,
    'https://registry.npmjs.org/@krivega/agent-workflow/-/agent-workflow-' +
      pin.version +
      '.tgz#' +
      sha1,
  );
  assert.equal(
    pin.integrity,
    'sha512-' + createHash('sha512').update(archive.bytes).digest('base64'),
  );
  const project = JSON.parse(input('package.json').bytes);
  const sections = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ].filter((section) => Object.hasOwn(project[section] ?? {}, pin.name));
  assert.equal(sections.length, 1);
  assert.ok(['dependencies', 'devDependencies'].includes(sections[0]));
  assert.equal(project[sections[0]][pin.name], pin.version);
  const lock = input('yarn.lock').bytes.toString('utf8');
  const selector = pin.name + '@' + pin.version;
  const stanzas = lock.split(/\r?\n\r?\n/u).map((chunk) => chunk.trimEnd().split(/\r?\n/u));
  const matches = stanzas.filter(([header]) =>
    header
      .replace(/:$/u, '')
      .split(', ')
      .some((item) => item.replace(/^"|"$/gu, '') === selector),
  );
  assert.equal(matches.length, 1, 'one exact registry lock stanza required');
  const [header, version, resolved, integrity, dependencies, ...rest] = matches[0];
  assert.equal(header, JSON.stringify(selector) + ':');
  assert.deepEqual(
    [version, resolved, integrity, dependencies],
    [
      '  version ' + JSON.stringify(pin.version),
      '  resolved ' + JSON.stringify(pin.resolved),
      '  integrity ' + pin.integrity,
      '  dependencies:',
    ],
  );
  assert.deepEqual(
    rest
      .map((line) => {
        const match = /^    ("[^"\\]+"|[a-zA-Z0-9._-]+) "([^"]+)"$/u.exec(line);
        assert.ok(match, 'unexpected registry dependency');
        return [match[1].replace(/^"|"$/gu, ''), match[2]];
      })
      .sort(),
    Object.entries(metadata.dependencies).sort(),
  );
  assert.equal(pin.payloadManifest, payloadPath);
  const inventory = input(payloadPath);
  assert.equal(inventory.ref.sha256, pin.payloadManifestSha256);
  const files = payload(archivePath, metadata, execute, true);
  assert.deepEqual(JSON.parse(inventory.bytes), {
    kind: 'agent-workflow-release-payload/1',
    name: pin.name,
    version: pin.version,
    archiveSha256: pin.archiveSha256,
    files,
  });
  return {
    kind: 'installed-game-registry-binding/1',
    archive: { path: archivePath, sha256: archive.ref.sha256, bytes: archive.ref.bytes },
    changed: [],
    package: input('package.json').ref,
    payload: { files: files.length, sha256: inventory.ref.sha256 },
  };
}

export function bindGameRuntime(checker, archivePath, metadata, execute = execFileSync) {
  canonicalGamePath(checker);
  const origin = JSON.parse(readGameFile(join(checker, gameCopyMarker)).bytes);
  assert.notEqual(origin.root, checker, 'isolated game copy required');
  assert.deepEqual(
    snapshotGameSource(checker, execute),
    { ...origin, root: checker },
    'checker changed before release binding',
  );
  assert.deepEqual(snapshotGameSource(origin.root, execute), origin, 'original game changed');
  const archive = readGameFile(archivePath);
  const packageFile = readGameFile(join(checker, 'package.json'));
  const pkg = JSON.parse(packageFile.bytes);
  const pinFile = readGameFile(join(checker, pinPath));
  const pin = JSON.parse(pinFile.bytes);
  if (pin.schemaVersion === 2) {
    return registryGameRelease({ ...origin, root: checker }, archivePath, metadata, execute);
  }
  exactFields(pin, [
    'schemaVersion',
    'name',
    'version',
    'archive',
    'archiveSha256',
    'payloadManifest',
    'payloadManifestSha256',
  ]);
  assert.equal(pin.schemaVersion, 1);
  const name = metadata.name;
  assert.ok(
    ['@krivega/agent-workflow', '@agent-workflow/runtime'].includes(name),
    'unknown runtime package',
  );
  assert.equal(pin.name, name);
  assert.equal(
    metadata.version,
    pin.version,
    'runtime version change requires another consumer preparation',
  );
  assert.equal(pin.payloadManifest, payloadPath);
  gameRelativePath(pin.archive);
  assert.ok(pin.archive.startsWith('tools/vendor/'), 'unexpected vendored archive path');
  const selector = 'file:' + pin.archive;
  const dependencySections = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ].filter((section) => Object.hasOwn(pkg[section] ?? {}, name));
  assert.ok(
    dependencySections.length === 1 &&
      ['dependencies', 'devDependencies'].includes(dependencySections[0]),
    'one supported game runtime dependency required',
  );
  assert.equal(pkg[dependencySections[0]][name], selector, 'game dependency pin drift');
  const previousArchive = readGameFile(join(checker, pin.archive));
  assert.equal(previousArchive.ref.sha256, pin.archiveSha256, 'old game archive pin mismatch');
  const previousPayload = readGameFile(join(checker, payloadPath));
  assert.equal(previousPayload.ref.sha256, pin.payloadManifestSha256, 'old payload pin mismatch');
  const oldPayload = JSON.parse(previousPayload.bytes);
  assert.equal(oldPayload.kind, 'agent-workflow-release-payload/1');
  assert.equal(oldPayload.name, name);
  assert.equal(oldPayload.version, pin.version);
  assert.equal(oldPayload.archiveSha256, pin.archiveSha256);
  const lockFile = readGameFile(join(checker, 'yarn.lock'));
  const sha1 = createHash('sha1').update(archive.bytes).digest('hex');
  const lock = runtimeLock(lockFile.bytes.toString(), selector, metadata, sha1);
  const files = payload(archivePath, metadata, execute);
  assert.deepEqual(readGameFile(archivePath).ref, archive.ref, 'archive changed during inventory');
  const nextPayload = Buffer.from(
    JSON.stringify(
      {
        kind: 'agent-workflow-release-payload/1',
        name,
        version: metadata.version,
        archiveSha256: archive.ref.sha256,
        files,
      },
      null,
      2,
    ) + '\n',
  );
  const nextPin = Buffer.from(
    JSON.stringify(
      { ...pin, archiveSha256: archive.ref.sha256, payloadManifestSha256: digest(nextPayload) },
      null,
      2,
    ) + '\n',
  );
  const changes = [
    [pin.archive, previousArchive, archive.bytes],
    [payloadPath, previousPayload, nextPayload],
    [pinPath, pinFile, nextPin],
    ['yarn.lock', lockFile, Buffer.from(lock)],
  ];
  for (const [path, before] of changes)
    assert.deepEqual(readGameFile(join(checker, path)).ref, before.ref, 'checker input changed');
  const changed = [];
  for (const [path, before, bytes] of changes) {
    writeFileSync(join(checker, path), bytes);
    const after = readGameFile(join(checker, path)).ref;
    assert.deepEqual(after, { ...before.ref, sha256: digest(bytes), bytes: bytes.length });
    changed.push({ path, before: before.ref, after });
  }
  assert.deepEqual(
    readGameFile(join(checker, 'package.json')).ref,
    packageFile.ref,
    'game package changed',
  );
  assert.deepEqual(readGameFile(archivePath).ref, archive.ref, 'candidate archive changed');
  assert.deepEqual(
    snapshotGameSource(origin.root, execute),
    origin,
    'original game changed during binding',
  );
  return {
    kind: 'installed-game-runtime-binding/1',
    archive: { path: archivePath, sha256: archive.ref.sha256, bytes: archive.ref.bytes },
    changed,
    package: packageFile.ref,
    payload: { files: files.length, sha256: digest(nextPayload) },
  };
}
