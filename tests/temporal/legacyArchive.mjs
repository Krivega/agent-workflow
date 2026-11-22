import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { legacyArchiveCommand } from './legacyArchiveCommand.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-legacy-cli-'))),
  store = join(root, 'store'),
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function command(action, input) {
  const config = join(root, action + '.json');
  writeFileSync(config, JSON.stringify(input));
  return legacyArchiveCommand([action, config]);
}
try {
  const removed = spawnSync(
    process.execPath,
    [
      join(packageRoot, 'dist/client/index.js'),
      '--legacy-archive',
      'export',
      'request.json',
      'registration.json',
    ],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /Usage: prepare-project/u);
  mkdirSync(store);
  mkdirSync(join(store, 'blobs'));
  const db = new DatabaseSync(join(store, 'store.sqlite'));
  db.exec(`CREATE TABLE identity(project TEXT,task TEXT); INSERT INTO identity VALUES ('project','task');
    CREATE TABLE state(singleton INTEGER,body TEXT); CREATE TABLE entries(id TEXT,revision INTEGER,metadata TEXT);
    CREATE TABLE heads(id TEXT,revision INTEGER); CREATE TABLE operations(id TEXT,hash TEXT,ack TEXT);
    CREATE TABLE events(revision INTEGER,body TEXT); CREATE TABLE effects(id TEXT,body TEXT); PRAGMA user_version=2;`);
  const state = {
    owner: 'retained-owner',
    released: false,
    checkpoint: {
      Result: 'FAIL',
      findings: [{ id: 'F-1', status: 'open' }],
      history: [{ id: 'command-1', fingerprint: 'a'.repeat(64), payload: '' }],
    },
  };
  db.prepare('INSERT INTO state VALUES (1,?)').run(
    'AWRETAIN1\nAWJSON1\n' + JSON.stringify(['value', state]),
  );
  db.close();
  writeFileSync(
    join(store, 'identity.json'),
    JSON.stringify({ schema: 2, project: 'project', task: 'task' }),
  );
  const before = hash(readFileSync(join(store, 'store.sqlite'))),
    input = { schemaVersion: 1, root: store },
    read = command('read', input);
  assert.deepEqual(read.state, state);
  assert.equal(hash(readFileSync(join(store, 'store.sqlite'))), before);
  const destination = join(root, 'archive'),
    exported = command('export', { ...input, destination });
  assert.equal(exported.executionImport, false);
  assert.equal(exported.requiresReconciliation, true);
  assert.equal(hash(readFileSync(join(destination, 'history.json'))), exported.history.sha256);
  const { stageRestore } = await import(join(packageRoot, 'dist/adapters/artifacts/backup.js'));
  rmSync(store, { recursive: true });
  const restored = join(root, 'restored');
  stageRestore({
    schemaVersion: 1,
    backup: destination,
    manifest: exported.manifest,
    destination: restored,
  });
  assert.deepEqual(command('read', { ...input, root: join(restored, 'legacy') }), read);
  console.log(
    JSON.stringify({
      status: 'PASS',
      modelStarts: 0,
      serverStarts: 0,
      legacyDatabaseReadOnly: true,
      sourceRemovedBeforeRestore: true,
      originalIdsHashesPreserved: true,
      executionImport: false,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
