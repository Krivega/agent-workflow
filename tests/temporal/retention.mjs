import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-retention-cli-'))),
  source = join(root, 'source'),
  backup = join(root, 'backup'),
  bytes = Buffer.from('original FAIL F-1'),
  content = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
try {
  const { createBackup } = await import(join(packageRoot, 'dist/adapters/artifacts/backup.js'));
  mkdirSync(source);
  writeFileSync(join(source, 'fail'), bytes);
  writeFileSync(join(root, 'fail'), bytes);
  const saved = createBackup({
      schemaVersion: 2,
      roots: { artifacts: source },
      destination: backup,
    }),
    input = {
      schemaVersion: 1,
      root,
      now: '2026-10-29T00:00:00.000Z',
      files: [{ path: 'fail', kind: 'fail', createdAt: '2026-01-01T00:00:00.000Z', content }],
      protected: [],
      backups: [{ schemaVersion: 1, backup, manifest: saved.manifest }],
    },
    config = join(root, 'retention.json');
  writeFileSync(config, JSON.stringify(input));
  const run = () =>
      spawnSync(
        process.execPath,
        [join(packageRoot, 'dist/client/index.js'), '--backup', 'retention', config],
        { encoding: 'utf8' },
      ),
    result = run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.deletionAuthorized, false);
  assert.equal(report.entries[0].reason, 'referenced-evidence');
  writeFileSync(join(backup, '.backup-incomplete'), 'pending');
  assert.notEqual(run().status, 0);
  assert.deepEqual(readFileSync(join(root, 'fail')), bytes);
  console.log(
    JSON.stringify({
      status: 'PASS',
      modelStarts: 0,
      serverStarts: 0,
      deletionAuthorized: false,
      incompleteBackupRefused: true,
      originalEvidencePreserved: true,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
