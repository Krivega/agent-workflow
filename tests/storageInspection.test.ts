import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { StoreDatabase } from '../adapters/storage/storeDatabase.js';
import { noStorageProbe, StoreFiles } from '../adapters/storage/storeFiles.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { fixture, grant, signed } from './storageFixtures.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
  f.claim();
});
afterEach(() => {
  vi.restoreAllMocks();
  f.dispose();
});
const inspect = () => new SqliteEvidenceStore(f.root, grant, () => 100, noStorageProbe, 'inspect');
const snapshot = () =>
  Object.fromEntries(
    readdirSync(f.root)
      .filter((name) => name !== 'blobs')
      .map((name) => [name, readFileSync(join(f.root, name))]),
  );
const state = { context: grant.context, command: { type: 'state' as const } };

it('reads the live DELETE Store without changing bytes or creating files and refuses every mutation', () => {
  const before = snapshot(),
    reader = inspect();
  expect(reader.execute(state)).toMatchObject({ ok: true, value: { revision: 1, generation: 1 } });
  expect(reader.execute(signed({ type: 'renew', lease_until: 2000 }, 1))).toMatchObject({
    ok: false,
    error: { code: 'permission-denied', retryable: false },
  });
  expect(snapshot()).toEqual(before);
  const db = new StoreDatabase(f.root, grant.context, noStorageProbe, 'inspect');
  try {
    expect(() => db.transaction(true, () => {})).toThrow('permission-denied');
    expect(db.transaction(false, () => db.state()).revision).toBe(1);
  } finally {
    db.close();
  }
  expect(snapshot()).toEqual(before);
});

it.each(['-journal', '-wal', '-shm'])(
  'rejects an existing %s before opening SQLite or recovering it',
  (suffix) => {
    writeFileSync(join(f.root, 'store.sqlite' + suffix), 'existing sidecar');
    const before = snapshot();
    expect(inspect().execute(state)).toMatchObject({
      ok: false,
      error: { code: 'recovery-required', retryable: false },
    });
    expect(snapshot()).toEqual(before);
  },
);

it('requires explicit recovery for a closed WAL database without creating its missing WAL/SHM', () => {
  const writer = new DatabaseSync(join(f.root, 'store.sqlite'));
  writer.exec('PRAGMA journal_mode=WAL');
  writer.close();
  const before = snapshot();
  expect(Object.keys(before)).not.toContain('store.sqlite-wal');
  const reply = inspect().execute(state);
  expect(reply).toMatchObject({
    ok: false,
    error: { code: 'recovery-required', retryable: false },
  });
  expect(() => unwrap(reply)).toThrow('recovery-required');
  expect(snapshot()).toEqual(before);
});

it('rejects either WAL header byte without normalizing the source', () => {
  const path = join(f.root, 'store.sqlite'),
    original = readFileSync(path),
    bytes = Buffer.from(original);
  bytes[19] = 2;
  writeFileSync(path, bytes);
  const before = snapshot();
  expect(inspect().execute(state)).toMatchObject({
    ok: false,
    error: { code: 'recovery-required' },
  });
  expect(snapshot()).toEqual(before);
});

it('rechecks a header flipped after the read-only connection opens', () => {
  const assertRoot = StoreFiles.prototype.assertRoot;
  let checks = 0;
  const path = join(f.root, 'store.sqlite');
  vi.spyOn(StoreFiles.prototype, 'assertRoot').mockImplementation(function (this: StoreFiles) {
    assertRoot.call(this);
    if (++checks === 3) {
      const writer = new DatabaseSync(path);
      writer.exec('PRAGMA journal_mode=WAL');
      writer.close();
    }
  });
  expect(inspect().execute(state)).toMatchObject({
    ok: false,
    error: { code: 'recovery-required' },
  });
  expect(readdirSync(f.root).sort()).toEqual(['blobs', 'identity.json', 'store.sqlite']);
  expect(readFileSync(path)[18]).toBe(2);
});

it('refuses a WAL flip at the first SQL read without creating sidecars', () => {
  const prepare = DatabaseSync.prototype.prepare,
    path = join(f.root, 'store.sqlite');
  let flipped = false;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (!flipped && sql === 'PRAGMA user_version') {
      flipped = true;
      const writer = new DatabaseSync(path);
      writer.exec('PRAGMA journal_mode=WAL');
      writer.close();
    }
    return prepare.call(this, sql);
  });
  expect(inspect().execute(state)).toMatchObject({
    ok: false,
    error: { code: 'recovery-required' },
  });
  expect(flipped).toBe(true);
  expect(readdirSync(f.root).sort()).toEqual(['blobs', 'identity.json', 'store.sqlite']);
});

it('refuses a sidecar appearing during a read transaction', () => {
  const db = new StoreDatabase(f.root, grant.context, noStorageProbe, 'inspect');
  try {
    expect(() =>
      db.transaction(false, () => {
        writeFileSync(join(f.root, 'store.sqlite-journal'), 'raced journal');
        return db.state();
      }),
    ).toThrow('recovery-required');
    expect(db.db.isTransaction).toBe(false);
    expect(readFileSync(join(f.root, 'store.sqlite-journal'), 'utf8')).toBe('raced journal');
  } finally {
    db.close();
  }
});

it('rechecks the schema version and directory identity after a read', () => {
  const path = join(f.root, 'store.sqlite'),
    original = readFileSync(path);
  const db = new StoreDatabase(f.root, grant.context, noStorageProbe, 'inspect');
  try {
    expect(() =>
      db.transaction(false, () => {
        const changed = Buffer.from(original);
        changed.writeUInt32BE(99, 60);
        writeFileSync(path, changed);
      }),
    ).toThrow('unsupported-version');
    writeFileSync(path, original);
    expect(() =>
      db.transaction(false, () => {
        renameSync(path, path + '.old');
        writeFileSync(path, original, { mode: 0o600 });
      }),
    ).toThrow('permission-denied');
  } finally {
    db.close();
  }
});
