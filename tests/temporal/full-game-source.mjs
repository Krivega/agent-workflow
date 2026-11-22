import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const gameCopyMarker = '.git/aw-installed-game-source.json';
export const gameSourceDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function exactFields(value, fields) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), 'unexpected fields');
}
export function canonicalGamePath(path) {
  assert.equal(typeof path, 'string');
  assert.ok(isAbsolute(path) && resolve(path) === path, 'canonical absolute path required');
  assert.equal(realpathSync(path), path, 'path alias refused');
  return path;
}
// A checker prepared from a migrated copy must also be denied access to the original checkout.
export function gameSourceRoots(root) {
  const roots = [];
  for (;;) {
    canonicalGamePath(root);
    assert.ok(!roots.includes(root), 'cyclic game copy origin');
    roots.push(root);
    const marker = join(root, gameCopyMarker);
    if (!existsSync(marker)) return roots;
    const manifest = JSON.parse(readGameFile(marker).bytes);
    assert.equal(manifest.kind, 'installed-game-source/1');
    root = manifest.root;
  }
}
export function gameRelativePath(path) {
  assert.equal(typeof path, 'string');
  assert.ok(
    path &&
      !posix.isAbsolute(path) &&
      posix.normalize(path) === path &&
      !/[\\\r\n\0]/u.test(path) &&
      !path.split('/').some((part) => ['..', '.', '.git', ''].includes(part)),
    'unsafe game path',
  );
  return path;
}
export function readGameFile(path) {
  canonicalGamePath(path);
  const before = lstatSync(path);
  assert.ok(before.isFile() && before.nlink === 1, 'regular single-link file required');
  const bytes = readFileSync(path);
  canonicalGamePath(path);
  const after = lstatSync(path);
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'nlink'])
    assert.equal(after[field], before[field], 'file changed while reading');
  assert.equal(bytes.length, after.size);
  return {
    bytes,
    ref: { sha256: gameSourceDigest(bytes), bytes: bytes.length, mode: after.mode & 0o777 },
  };
}
function git(root, args, execute) {
  return execute('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function collect(root, execute) {
  assert.equal(
    git(root, ['rev-parse', '--show-toplevel'], execute).trim(),
    root,
    'game checkout root required',
  );
  const head = git(root, ['rev-parse', 'HEAD'], execute).trim();
  assert.match(head, /^[a-f0-9]{40}$/u);
  const files = [];
  const names = git(
    root,
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    execute,
  );
  for (const path of [...new Set(names.split('\0').filter(Boolean))].sort()) {
    gameRelativePath(path);
    const absolute = join(root, path);
    try {
      lstatSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    files.push({ path, ...readGameFile(absolute).ref });
  }
  return { schemaVersion: 1, kind: 'installed-game-source/1', root, head, files };
}
export function snapshotGameSource(root, execute = execFileSync) {
  canonicalGamePath(root);
  assert.ok(lstatSync(root).isDirectory(), 'game root must be a directory');
  const result = collect(root, execute);
  assert.deepEqual(collect(root, execute), result, 'game source changed during snapshot');
  return result;
}
export function readGameSource(binding, execute = execFileSync) {
  exactFields(binding, ['root', 'snapshot']);
  exactFields(binding.snapshot, ['path', 'sha256', 'bytes']);
  assert.match(binding.snapshot.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(binding.snapshot.bytes) && binding.snapshot.bytes > 0);
  const saved = readGameFile(binding.snapshot.path);
  assert.equal(saved.ref.sha256, binding.snapshot.sha256, 'game snapshot hash mismatch');
  assert.equal(saved.ref.bytes, binding.snapshot.bytes, 'game snapshot size mismatch');
  const manifest = JSON.parse(saved.bytes);
  exactFields(manifest, ['schemaVersion', 'kind', 'root', 'head', 'files']);
  assert.equal(manifest.root, binding.root);
  assert.deepEqual(snapshotGameSource(binding.root, execute), manifest, 'game snapshot drift');
  return manifest;
}

export function copyGameSource(binding, destination, execute = execFileSync) {
  const manifest = readGameSource(binding, execute);
  assert.ok(isAbsolute(destination) && resolve(destination) === destination);
  canonicalGamePath(dirname(destination));
  assert.ok(
    destination !== manifest.root &&
      !destination.startsWith(manifest.root + sep) &&
      !manifest.root.startsWith(destination + sep),
    'game copy must be independent',
  );
  try {
    lstatSync(destination);
    assert.fail('game copy destination already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  git(
    manifest.root,
    [
      'clone',
      '--quiet',
      '--no-local',
      '--no-checkout',
      '--depth',
      '1',
      '--',
      pathToFileURL(manifest.root).href,
      destination,
    ],
    execute,
  );
  assert.equal(
    git(destination, ['rev-parse', 'HEAD'], execute).trim(),
    manifest.head,
    'game HEAD changed during clone',
  );
  git(destination, ['reset', '--quiet', '--mixed', manifest.head], execute);
  for (const ref of manifest.files) {
    const origin = readGameFile(join(manifest.root, ref.path));
    assert.deepEqual({ path: ref.path, ...origin.ref }, ref, 'game source changed before copy');
    const target = join(destination, ref.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, origin.bytes, { flag: 'wx', mode: ref.mode });
    chmodSync(target, ref.mode);
    assert.deepEqual(readGameFile(target).ref, origin.ref, 'game copy readback mismatch');
  }
  git(destination, ['add', '--all'], execute);
  assert.deepEqual(snapshotGameSource(destination, execute), { ...manifest, root: destination });
  assert.deepEqual(readGameSource(binding, execute), manifest, 'original game changed during copy');
  writeFileSync(join(destination, gameCopyMarker), JSON.stringify(manifest) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return manifest;
}
