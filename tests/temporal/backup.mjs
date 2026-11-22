import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import console from 'node:console';
import process from 'node:process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-backup-cli-'))),
  sources = join(root, 'sources'),
  roots = Object.fromEntries(
    ['artifacts', 'receipts', 'workspaces', 'build'].map((name) => [name, join(sources, name)]),
  );
function run(action, input) {
  const file = join(root, action + '.json');
  writeFileSync(file, JSON.stringify(input));
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, 'dist/client/index.js'), '--backup', action, file],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}
try {
  for (const directory of Object.values(roots)) mkdirSync(directory, { recursive: true });
  const original = Buffer.from('original FAIL F-1\n'),
    hash = createHash('sha256').update(original).digest('hex'),
    receipt = Buffer.from(
      JSON.stringify({ owner: 'retained-owner', generation: 7, unknown: true }),
    ),
    persistence = join(sources, 'temporal.pgdump'),
    backup = join(root, 'backup'),
    destination = join(root, 'staged');
  writeFileSync(join(roots.artifacts, hash), original);
  writeFileSync(join(roots.receipts, 'permission.json'), receipt);
  writeFileSync(join(roots.workspaces, 'content.bin'), Buffer.from([0, 128, 255]));
  writeFileSync(join(roots.build, 'version.json'), '{"fixture":true}');
  // Deliberately only a format-signature fixture; no native PostgreSQL restore is claimed.
  writeFileSync(persistence, 'PGDMP\0byte-packing-fixture');
  const saved = run('save', { schemaVersion: 1, roots, persistence, destination: backup });
  assert.equal(saved.status, 'saved');
  rmSync(sources, { recursive: true });
  const restored = run('restore', {
    schemaVersion: 1,
    backup,
    manifest: saved.manifest,
    destination,
  });
  assert.equal(restored.status, 'staged');
  assert.equal(restored.requiresReconciliation, true);
  assert.deepEqual(readFileSync(join(destination, 'artifacts', hash)), original);
  assert.deepEqual(readFileSync(join(destination, 'receipts/permission.json')), receipt);
  assert.deepEqual(
    readFileSync(join(destination, 'workspaces/content.bin')),
    Buffer.from([0, 128, 255]),
  );
  assert.deepEqual(JSON.parse(readFileSync(join(destination, 'RESTORE.json'), 'utf8')), restored);
  console.log(
    JSON.stringify({
      status: 'PASS',
      boundaries: 5,
      sourceRemovedBeforeRestore: true,
      modelStarts: 0,
      serverStarts: 0,
      nativeDatabaseRestore: 'NOT RUN',
      restoredStatus: 'staged',
      manifest: saved.manifest,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
