import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const postgresTools = [
  'postgres',
  'initdb',
  'pg_ctl',
  'psql',
  'pg_dump',
  'pg_restore',
  'createdb',
];
export const observerTools = ['/bin/ps', '/usr/sbin/lsof'];
const ref = (bytes) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
});
function regularBytes(path, executable) {
  assert.ok(isAbsolute(path) && resolve(path) === path, 'canonical absolute file required');
  assert.equal(realpathSync(path), path, 'symlinked file or parent rejected');
  const before = lstatSync(path);
  assert.ok(before.isFile() && before.nlink === 1, 'regular single-link file required');
  if (executable) assert.ok((before.mode & 0o111) !== 0, 'executable permission required');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assert.ok(opened.isFile() && opened.nlink === 1, 'opened file is not single-link regular');
    assert.equal(opened.ino, before.ino, 'file changed before read');
    assert.equal(opened.dev, before.dev, 'file changed before read');
    const bytes = readFileSync(fd),
      after = lstatSync(path),
      end = fstatSync(fd);
    assert.equal(realpathSync(path), path, 'file path changed during read');
    for (const key of ['ino', 'dev', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) {
      assert.equal(after[key], opened[key], 'file changed during read: ' + key);
      assert.equal(end[key], opened[key], 'opened file changed during read: ' + key);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function observeExecutablePins(paths) {
  return Object.fromEntries(paths.map((path) => [path, ref(regularBytes(path, true))]));
}
export function assertExecutablePin(path, pins) {
  assert.ok(pins && Object.hasOwn(pins, path) && pins[path], 'missing executable pin: ' + path);
  const actual = ref(regularBytes(path, true));
  assert.deepEqual(actual, pins[path], 'executable pin mismatch: ' + path);
  return actual;
}
export function requiredExecutablePaths(config) {
  return postgresTools
    .map((name) => join(config.executables.postgresDirectory, name))
    .concat(config.executables.temporalServer, config.executables.temporalSqlTool, observerTools);
}
export function assertAllExecutablePins(config, archiveSha256) {
  const paths = requiredExecutablePaths(config);
  assert.deepEqual(
    Object.keys(config.executablePins).sort(),
    [...paths].sort(),
    'unexpected toolchain pins',
  );
  const observed = Object.fromEntries(
    paths.map((path) => [path, assertExecutablePin(path, config.executablePins)]),
  );
  assert.ok(config.temporalBinaryInventory, 'pinned Temporal binary inventory required');
  const bytes = regularBytes(config.temporalBinaryInventory.path, false);
  assert.deepEqual(
    ref(bytes),
    config.temporalBinaryInventory.content,
    'binary inventory pin mismatch',
  );
  const inventory = JSON.parse(bytes.toString('utf8'));
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.archive.content.sha256, archiveSha256, 'inventory archive pin mismatch');
  assert.deepEqual(
    Object.keys(inventory.executablePins).sort(),
    [config.executables.temporalServer, config.executables.temporalSqlTool].sort(),
  );
  for (const [path, expected] of Object.entries(inventory.executablePins))
    assert.deepEqual(observed[path], expected, 'inventory executable mismatch');
  return observed;
}
export function processSample(pins, execute, environment) {
  assertExecutablePin('/bin/ps', pins);
  return execute('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time='], {
    encoding: 'utf8',
    timeout: 2000,
    env: environment,
  });
}
export function pinnedSpawn(file, args, options, pins, execute) {
  assertExecutablePin(file, pins);
  return execute(file, args, options);
}
function tarString(header, start, length) {
  return header
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/su, '');
}
function tarNumber(header, start, length) {
  const raw = tarString(header, start, length).trim();
  assert.match(raw, /^[0-7]+$/u, 'unsupported tar number');
  const number = Number.parseInt(raw, 8);
  assert.ok(Number.isSafeInteger(number) && number >= 0);
  return number;
}
export function extractPinnedTemporalArchive(archive, destination, expectedSha256) {
  const compressed = regularBytes(archive, false);
  assert.ok(compressed.length <= 128 * 1024 * 1024, 'archive size budget exceeded');
  assert.equal(ref(compressed).sha256, expectedSha256, 'archive pin mismatch');
  const tar = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 }),
    selected = new Map(),
    ignoredMetadata = [];
  let offset = 0,
    ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(
        tar.subarray(offset).every((byte) => byte === 0),
        'nonzero data after tar end',
      );
      assert.ok(tar.length - offset >= 1024, 'incomplete tar terminator');
      ended = true;
      break;
    }
    const checksum = tarNumber(header, 148, 8);
    assert.equal(
      header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0),
      checksum,
      'invalid tar checksum',
    );
    const prefix = tarString(header, 345, 155),
      name = tarString(header, 0, 100),
      path = prefix ? prefix + '/' + name : name,
      type = tarString(header, 156, 1),
      size = tarNumber(header, 124, 12),
      start = offset + 512,
      end = start + size;
    assert.ok(
      path &&
        !path.startsWith('/') &&
        !path.split('/').some((part) => part === '..') &&
        !/[\\\r\n]/u.test(path),
      'unsafe tar path',
    );
    const ignoredMetadataLink =
      path === 'config/development.yaml' &&
      type === '2' &&
      size === 0 &&
      tarString(header, 157, 100) === 'development-sqlite.yaml' &&
      ignoredMetadata.length === 0;
    assert.ok(
      type === '' || type === '0' || type === '5' || ignoredMetadataLink,
      'tar links/extensions/special files rejected',
    );
    if (ignoredMetadataLink)
      ignoredMetadata.push({
        path,
        target: 'development-sqlite.yaml',
        type,
        bytes: 0,
        materialized: false,
      });
    assert.ok(end <= tar.length, 'truncated tar member');
    if (path === 'temporal-server' || path === 'temporal-sql-tool') {
      assert.ok(
        type !== '5' && size > 0 && !selected.has(path),
        'duplicate or invalid binary member',
      );
      selected.set(path, Buffer.from(tar.subarray(start, end)));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  assert.ok(ended && selected.size === 2, 'complete archive with both binaries required');
  assert.ok(
    isAbsolute(destination) && !existsSync(destination),
    'new absolute extraction destination required',
  );
  assert.equal(
    realpathSync(resolve(destination, '..')),
    resolve(destination, '..'),
    'canonical extraction parent required',
  );
  mkdirSync(destination, { mode: 0o700 });
  for (const [name, bytes] of selected)
    writeFileSync(join(destination, name), bytes, { flag: 'wx', mode: 0o700 });
  const inventory = {
    schemaVersion: 1,
    archive: { path: archive, content: ref(compressed) },
    ignoredMetadata,
    extraction:
      'verified archive; strict regular tar members; only two named binaries materialized; no native execution',
    executablePins: observeExecutablePins(
      [...selected.keys()].map((name) => join(destination, name)),
    ),
  };
  const inventoryPath = join(destination, 'binary-inventory.json'),
    inventoryBytes = Buffer.from(JSON.stringify(inventory, null, 2));
  writeFileSync(inventoryPath, inventoryBytes, { flag: 'wx', mode: 0o600 });
  return { ...inventory, binaryInventory: { path: inventoryPath, content: ref(inventoryBytes) } };
}
