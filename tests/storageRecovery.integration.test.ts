import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StoredEvidence, TechnicalState } from '../core/evidence.js';
import { ProcessEvidenceStore } from '../adapters/storage/processEvidenceStore.js';
import { exportStore, restoreStore } from '../adapters/storage/storeBackup.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { initializeStore, StoreDatabase } from '../adapters/storage/storeDatabase.js';
import {
  parseStored,
  readPrivateFile,
  safeDirectory,
  StoreFiles,
} from '../adapters/storage/storeFiles.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { body, fixture, grant, signed } from './storageFixtures.js';

let f: ReturnType<typeof fixture>;
const children: ChildProcess[] = [];
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  f.dispose();
});

it('runs two real writers against one revision and restarts to recover the single committed receipt', async () => {
  f.claim();
  const first = new ProcessEvidenceStore(f.root, grant);
  const second = new ProcessEvidenceStore(f.root, grant);
  const results = await Promise.all([
    first.execute(signed({ type: 'write', id: 'first', body }, 1, 1, 'first')),
    second.execute(signed({ type: 'write', id: 'second', body }, 1, 1, 'second')),
  ]);
  // Use a lease valid for actual process clocks rather than the deterministic fixture clock.
  expect(results.every((result) => !result.ok && result.error.code === 'stale-owner')).toBe(true);
  f.mutate({ type: 'renew', lease_until: Date.now() + 60_000 }, 1);
  const raced = await Promise.all([
    first.execute(signed({ type: 'write', id: 'first', body }, 2, 1, 'first')),
    second.execute(signed({ type: 'write', id: 'second', body }, 2, 1, 'second')),
  ]);
  expect(raced.filter((result) => result.ok)).toHaveLength(1);
  expect(raced.find((result) => !result.ok)).toMatchObject({
    error: { code: 'revision-conflict' },
  });
  expect(await first.execute({ context: grant.context, command: { type: 'state' } })).toMatchObject(
    { ok: true, value: { revision: 3 } },
  );
});

it('performs administration in isolated processes and keeps restore frozen', async () => {
  const created = new ProcessEvidenceStore(join(f.parent, 'process-created'), grant);
  expect(await created.administer(grant.context, { type: 'initialize' })).toEqual({
    ok: true,
    value: { status: 'initialized' },
  });
  f.claim();
  f.mutate({ type: 'freeze' }, 1);
  const store = new ProcessEvidenceStore(f.root, grant);
  const database = join(f.root, 'store.sqlite');
  const writer = new DatabaseSync(database);
  try {
    expect(writer.prepare('PRAGMA journal_mode=WAL').get()).toMatchObject({ journal_mode: 'wal' });
  } finally {
    writer.close();
  }
  const before = readFileSync(database);
  const sourceEntries = readdirSync(f.root).sort();
  const occupied = join(f.parent, 'occupied');
  mkdirSync(occupied);
  const sentinel = join(occupied, 'sentinel');
  writeFileSync(sentinel, 'existing backup');
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(
      await store.administer(grant.context, { type: 'backup', destination: occupied }),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(readFileSync(database).equals(before)).toBe(true);
    expect(readdirSync(f.root).sort()).toEqual(sourceEntries);
    expect(readdirSync(occupied)).toEqual(['sentinel']);
    expect(readFileSync(sentinel, 'utf8')).toBe('existing backup');
  }
  const destination = join(f.parent, 'process-backup');
  const receipt = await store.administer(grant.context, { type: 'backup', destination });
  expect(receipt).toMatchObject({ ok: true, value: { revision: 2 } });
  const restored = new ProcessEvidenceStore(join(f.parent, 'process-restored'), grant);
  expect(
    await restored.administer(grant.context, { type: 'restore', source: destination }),
  ).toEqual(receipt);
  expect(
    await restored.execute({ context: grant.context, command: { type: 'state' } }),
  ).toMatchObject({ ok: true, value: { frozen: true, generation: 1 } });
});

it.each(
  (['blob-written', 'blob-published', 'before-commit', 'after-commit'] as const).flatMap(
    (boundary) => [false, true].map((archive) => ({ boundary, archive })),
  ),
)(
  'recovers after real SIGKILL at $boundary, archive=$archive, without silently duplicating the operation',
  async ({ boundary, archive }) => {
    f.claim();
    const content = JSON.stringify({ kind: 'execution-event', payload: 'immutable archive' });
    const request = signed(
      archive
        ? {
            type: 'checkpoint',
            state: { archive_root: digest(content) },
            effects: [],
            blobs: [{ hash: digest(content), content }],
          }
        : { type: 'write', id: 'evidence', body },
      1,
    );
    const script = join(f.parent, 'kill-driver.mjs');
    writeFileSync(
      script,
      `
    import { writeSync } from 'node:fs';
    import { SqliteEvidenceStore } from ${JSON.stringify(resolve('adapters/storage/sqliteEvidenceStore.ts'))};
    const store = new SqliteEvidenceStore(${JSON.stringify(f.root)}, ${JSON.stringify(grant)}, () => 100, (point) => {
      if (point === ${JSON.stringify(boundary)}) {
        writeSync(1, 'ready\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    });
    store.execute(${JSON.stringify(request)});
  `,
    );
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const closed = new Promise((resolveClose) => child.on('close', resolveClose));
    await new Promise<void>((resolveReady, reject) => {
      child.stdout.on('data', () => {
        child.kill('SIGKILL');
        resolveReady();
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal !== 'SIGKILL') reject(new Error(`driver exited ${code}/${signal}`));
      });
    });
    await closed;
    const recovery = f.execute({ type: 'operation', operation_id: 'op-1' });
    expect(recovery).toMatchObject({
      ok: true,
      value: { status: boundary === 'after-commit' ? 'confirmed' : 'not-started' },
    });
    expect(f.store.execute(request).ok).toBe(true);
    expect(f.store.execute(request).ok).toBe(true);
    expect(unwrap<TechnicalState>(f.execute({ type: 'state' })).revision).toBe(2);
    if (archive)
      expect(f.execute({ type: 'archive', hash: digest(content) })).toEqual({
        ok: true,
        value: { hash: digest(content), value: JSON.parse(content) as unknown },
      });
    else
      expect(
        unwrap<StoredEvidence>(f.execute({ type: 'read', id: 'evidence', revision: 1 })).body,
      ).toEqual(body);
    const db = new StoreDatabase(f.root, grant.context, () => {});
    db.check();
    db.close();
    if (boundary === 'blob-written')
      expect(readdirSync(join(f.root, 'blobs')).some((name) => name.startsWith('.pending-'))).toBe(
        true,
      );
  },
);

it('preserves a frozen backup and restores hashes, generations, operations and effects into a new root', async () => {
  f.claim();
  f.mutate({ type: 'write', id: 'e', body }, 1);
  f.mutate(
    {
      type: 'checkpoint',
      state: { elapsed: 123, review: 'FAIL' },
      effects: [{ id: 'unknown-create', intent: 'native-project' }],
    },
    2,
  );
  f.mutate({ type: 'freeze' }, 3);
  const destination = join(f.parent, 'export');
  const receipt = await exportStore(f.root, destination, grant);
  expect(receipt).toMatchObject({ revision: 4, schema: 2 });
  const restoredRoot = join(f.parent, 'restored');
  expect(restoreStore(destination, restoredRoot, grant)).toEqual(receipt);
  const restored = new SqliteEvidenceStore(restoredRoot, grant, () => 100);
  const request = {
    context: grant.context,
    command: { type: 'finalization' as const, expected_revision: 4 },
  };
  expect(restored.execute(request)).toEqual(f.store.execute(request));
  expect(restored.execute(signed({ type: 'write', id: 'late', body }, 4))).toMatchObject({
    ok: false,
    error: { code: 'revision-conflict' },
  });
  expect(() => restoreStore(destination, restoredRoot, grant)).toThrow('EEXIST');
  await expect(exportStore(f.root, join(f.root, 'inside'), grant)).rejects.toThrow(
    'permission-denied',
  );
  await expect(exportStore(f.root, f.root, grant)).rejects.toThrow('permission-denied');
  await expect(
    exportStore(f.root, join(f.parent, 'denied'), { ...grant, permissions: ['read'] }),
  ).rejects.toThrow('permission-denied');
  expect(() =>
    restoreStore(destination, join(f.parent, 'denied'), { ...grant, permissions: ['read'] }),
  ).toThrow('permission-denied');
  const foreign = { ...grant, context: { ...grant.context, task_id: 'other' } };
  expect(() => restoreStore(destination, join(f.parent, 'foreign'), foreign)).toThrow(
    'invalid-context',
  );
  expect(() => restoreStore(destination, join(destination, 'nested'), grant)).toThrow(
    'permission-denied',
  );
  const originalReceipt = readFileSync(join(destination, 'receipt.json'), 'utf8');
  writeFileSync(join(destination, 'receipt.json'), canonical({ ...receipt, schema: 99 }));
  expect(() => restoreStore(destination, join(f.parent, 'future'), grant)).toThrow(
    'unsupported-version',
  );
  writeFileSync(join(destination, 'receipt.json'), originalReceipt);
  writeFileSync(join(destination, 'manifest.json'), 'corrupt');
  expect(() => restoreStore(destination, join(f.parent, 'broken'), grant)).toThrow('corrupt');
  f.mutate({ type: 'thaw' }, 4);
  await expect(exportStore(f.root, join(f.parent, 'unfrozen'), grant)).rejects.toThrow(
    'revision-conflict',
  );
  expect(readdirSync(f.parent)).not.toContain('unfrozen');
});

it('releases an unused backup reservation after failing to open the source', async () => {
  const destination = join(f.parent, 'export');
  await expect(exportStore(join(f.parent, 'missing'), destination, grant)).rejects.toThrow(
    'ENOENT',
  );
  expect(readdirSync(f.parent)).not.toContain('export');
});

it.each([false, true])(
  'preserves a changed backup destination on validation failure (replacement=%s)',
  async (replace) => {
    const destination = join(f.parent, 'export');
    const check = vi.spyOn(StoreDatabase.prototype, 'check').mockImplementationOnce(() => {
      renameSync(destination, join(f.parent, 'displaced'));
      if (replace) mkdirSync(destination);
      throw new Error('source validation failed');
    });
    try {
      await expect(exportStore(f.root, destination, grant)).rejects.toThrow(
        'source validation failed',
      );
      expect(readdirSync(f.parent).includes('export')).toBe(replace);
      expect(readdirSync(join(f.parent, 'displaced'))).toEqual([]);
    } finally {
      check.mockRestore();
    }
  },
);

it('rejects traversal, symlinks, hard links, root substitution and writable-by-others roots', () => {
  expect(() => safeDirectory('relative')).toThrow('permission-denied');
  expect(() => safeDirectory(`${f.parent}/../elsewhere`)).toThrow('permission-denied');
  symlinkSync(f.root, join(f.parent, 'alias'));
  expect(() => new StoreFiles(join(f.parent, 'alias'), () => {})).toThrow('permission-denied');
  chmodSync(f.root, 0o755);
  expect(f.execute({ type: 'state' })).toMatchObject({
    ok: false,
    error: { code: 'permission-denied' },
  });
  chmodSync(f.root, 0o700);
  const files = new StoreFiles(f.root, () => {});
  expect(() => files.blobPath('../outside')).toThrow('corrupt');
  const old = join(f.parent, 'old');
  renameSync(f.root, old);
  mkdirSync(f.root, { mode: 0o700 });
  mkdirSync(join(f.root, 'blobs'));
  expect(() => files.assertRoot()).toThrow('permission-denied');
  rmSync(f.root, { recursive: true });
  renameSync(old, f.root);
  const dbPath = join(f.root, 'store.sqlite');
  linkSync(dbPath, join(f.parent, 'hard'));
  expect(f.execute({ type: 'state' })).toMatchObject({
    ok: false,
    error: { code: 'permission-denied' },
  });
  expect(() => readPrivateFile(dbPath)).toThrow('permission-denied');
  rmSync(join(f.parent, 'hard'));
  symlinkSync(dbPath, join(f.root, 'store.sqlite-journal'));
  expect(f.execute({ type: 'state' })).toMatchObject({
    ok: false,
    error: { code: 'permission-denied' },
  });
});

it('does not Ack a failed blob/commit and reports unknown after a committed but lost reply', () => {
  f.claim();
  const request = signed({ type: 'write', id: 'e', body }, 1);
  for (const boundary of ['blob-written', 'blob-published', 'before-commit', 'after-commit']) {
    const failing = new SqliteEvidenceStore(
      f.root,
      grant,
      () => 100,
      (point) => {
        if (point === boundary)
          throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
      },
    );
    const reply = failing.execute(request);
    expect(reply).toMatchObject({
      ok: false,
      error: { code: boundary === 'after-commit' ? 'unknown-outcome' : 'unavailable' },
    });
    expect(f.execute({ type: 'operation', operation_id: 'op-1' })).toMatchObject({
      ok: true,
      value: { status: boundary === 'after-commit' ? 'confirmed' : 'not-started' },
    });
  }
  expect(f.store.execute(request).ok).toBe(true);
  const missing = new SqliteEvidenceStore(join(f.parent, 'missing'), grant, () => 100);
  expect(missing.execute({ context: grant.context, command: { type: 'state' } })).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  expect(() => parseStored('{bad')).toThrow('corrupt');
  expect(() =>
    initializeStore(join(f.parent, 'invalid'), { ...grant.context, schema_version: 'future' }),
  ).toThrow('invalid-context');
});

it('handles SQLite FULL with automatic rollback and detects foreign-key damage', () => {
  const db = new StoreDatabase(f.root, grant.context, () => {});
  const pages = db.db.prepare('PRAGMA page_count').get()!['page_count'];
  db.db.exec(`PRAGMA max_page_count=${pages}`);
  expect(() =>
    db.transaction(true, () => {
      db.db.prepare('INSERT INTO effects VALUES (?,?)').run('full', 'x'.repeat(1024 * 1024));
    }),
  ).toThrow(/full/i);
  expect(db.db.prepare('SELECT * FROM effects').all()).toHaveLength(0);
  db.db.exec("PRAGMA foreign_keys=OFF; INSERT INTO heads VALUES ('missing',1)");
  expect(() => db.check()).toThrow('corrupt');
  db.close();
  const corrupt = new DatabaseSync(join(f.root, 'store.sqlite'));
  corrupt.prepare('UPDATE state SET body=?').run('{broken');
  corrupt.close();
  expect(f.execute({ type: 'state' })).toMatchObject({ ok: false, error: { code: 'corrupt' } });
});

it('rejects dangling journal symlinks and database substitution before returning an Ack', () => {
  f.claim();
  symlinkSync(join(f.parent, 'must-not-create'), join(f.root, 'store.sqlite-journal'));
  expect(f.mutate({ type: 'write', id: 'e', body }, 1)).toMatchObject({
    ok: false,
    error: { code: 'permission-denied' },
  });
  expect(readdirSync(f.parent)).not.toContain('must-not-create');
  rmSync(join(f.root, 'store.sqlite-journal'));
  const files = new StoreFiles(f.root, () => {});
  const database = join(f.root, 'store.sqlite');
  const saved = readFileSync(database);
  renameSync(database, join(f.root, 'old.sqlite'));
  writeFileSync(database, saved);
  expect(() => files.assertRoot()).toThrow('permission-denied');
  writeFileSync(database, saved.subarray(0, 100));
  expect(f.execute({ type: 'state' })).toMatchObject({ ok: false, error: { code: 'corrupt' } });
  writeFileSync(database, 'not a SQLite database');
  expect(f.execute({ type: 'state' })).toMatchObject({ ok: false, error: { code: 'corrupt' } });
});

it('recovers a hot rollback journal after SIGKILL with spilled checkpoint pages', () => {
  f.claim();
  const script = `import { StoreDatabase } from ${JSON.stringify(resolve('adapters/storage/storeDatabase.ts'))};
    const db=new StoreDatabase(${JSON.stringify(f.root)},${JSON.stringify(grant.context)},()=>{});
    db.transaction(true,()=>{ db.save({...db.state(),checkpoint:'x'.repeat(8*1024*1024)}); process.kill(process.pid,'SIGKILL'); });`;
  const child = spawnSync(process.execPath, [
    '--import',
    import.meta.resolve('tsx'),
    '--input-type=module',
    '-e',
    script,
  ]);
  expect(child.signal).toBe('SIGKILL');
  expect(f.execute({ type: 'state' })).toMatchObject({
    ok: true,
    value: { revision: 1, checkpoint: null, generation: 1 },
  });
  expect(f.mutate({ type: 'write', id: 'after-recovery', body }, 1).ok).toBe(true);
});

it('checks both immutable identity and database identity before admitting a scope', () => {
  const database = new DatabaseSync(join(f.root, 'store.sqlite'));
  database.prepare('UPDATE identity SET task=?').run('different');
  database.close();
  expect(f.execute({ type: 'state' })).toMatchObject({
    ok: false,
    error: { code: 'invalid-context' },
  });
});

it('reports real filesystem permission failures and rejects future backup API versions', async () => {
  f.claim();
  chmodSync(join(f.root, 'blobs'), 0o500);
  try {
    expect(f.mutate({ type: 'write', id: 'e', body }, 1)).toMatchObject({
      ok: false,
      error: { code: 'permission-denied' },
    });
  } finally {
    chmodSync(join(f.root, 'blobs'), 0o700);
  }
  const future = { ...grant, context: { ...grant.context, schema_version: 'future' } };
  await expect(exportStore(f.root, join(f.parent, 'future'), future)).rejects.toThrow(
    'unsupported-version',
  );
  expect(() => restoreStore(f.root, join(f.parent, 'future'), future)).toThrow(
    'unsupported-version',
  );
});
