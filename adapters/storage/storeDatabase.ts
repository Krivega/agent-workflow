import metadata from '../../package.json' with { type: 'json' };
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chmodSync, lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  evidenceSchema,
  requireStore,
  StoreFault,
  type EvidenceContext,
  type TechnicalState,
} from '../../core/evidence.js';
import { encodeSharedJson, retainedPrefix } from './sharedJson.js';
import { archivePrefix, decodeArchivedJson } from './archiveJson.js';
import { canonical } from './storeCodec.js';
import {
  createPrivateDirectory,
  databaseVersion,
  parseStored,
  readPrivateFile,
  StoreFiles,
  syncDirectory,
  writePrivateFile,
  type StorageProbe,
} from './storeFiles.js';

export const storageSchema = 2;

export function initializeStore(root: string, context: EvidenceContext): void {
  requireStore(
    context.schema_version === evidenceSchema && !!context.project_id && !!context.task_id,
    'invalid-context',
  );
  createPrivateDirectory(root);
  createPrivateDirectory(join(root, 'blobs'));
  const db = new DatabaseSync(join(root, 'store.sqlite'));
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON;
      BEGIN IMMEDIATE;
      CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), project TEXT NOT NULL, task TEXT NOT NULL);
      CREATE TABLE state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL);
      CREATE TABLE entries (id TEXT NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(id, revision));
      CREATE TABLE heads (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, FOREIGN KEY(id,revision) REFERENCES entries(id,revision));
      CREATE TABLE operations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, ack TEXT NOT NULL);
      CREATE TABLE events (revision INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE effects (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      PRAGMA user_version=2;`);
    db.prepare('INSERT INTO identity VALUES (1,?,?)').run(context.project_id, context.task_id);
    db.prepare('INSERT INTO state VALUES (1,?)').run(
      canonical({
        revision: 0,
        generation: 0,
        owner: null,
        lease_until: 0,
        released: true,
        frozen: false,
        checkpoint: null,
      }),
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  chmodSync(join(root, 'store.sqlite'), 0o600);
  writePrivateFile(
    join(root, 'identity.json'),
    canonical({
      schema: storageSchema,
      project: context.project_id,
      task: context.task_id,
      runtime_package_version: metadata.version,
    }),
  );
  syncDirectory(root);
}

export class StoreDatabase {
  private archived = false;
  retained = false;
  readonly files: StoreFiles;
  readonly db: DatabaseSync;
  readonly schema: number;
  constructor(
    root: string,
    context: EvidenceContext,
    probe: StorageProbe,
    private readonly mode: 'live' | 'backup' | 'inspect' = 'live',
  ) {
    this.files = new StoreFiles(root, probe);
    const path = join(root, 'store.sqlite');
    // Validate identity/version before allowing SQLite to recover a hot rollback journal.
    const identity = parseStored<{ schema: number; project: string; task: string }>(
      readPrivateFile(join(root, 'identity.json')).toString('utf8'),
    );
    requireStore(
      [1, storageSchema].includes(identity.schema) && databaseVersion(path) === identity.schema,
      'unsupported-version',
    );
    requireStore(
      identity.project === context.project_id && identity.task === context.task_id,
      'invalid-context',
    );
    this.schema = identity.schema;
    this.inspectable();
    if (mode === 'backup') {
      // The backup receipt covers the main database file only.
      requireStore(
        ['-journal', '-wal', '-shm'].every(
          (suffix) => lstatSync(path + suffix, { throwIfNoEntry: false }) === undefined,
        ),
        'corrupt',
      );
      this.db = new DatabaseSync(pathToFileURL(path).href + '?immutable=1', { readOnly: true });
    } else this.db = new DatabaseSync(path, { readOnly: mode === 'inspect' });
    try {
      if (mode === 'inspect') {
        // Exclusive locking refuses a raced WAL open without creating its WAL/SHM files.
        this.db.exec('PRAGMA query_only=ON; PRAGMA locking_mode=EXCLUSIVE;');
        this.inspectable();
      }
      this.db.exec('PRAGMA busy_timeout=1000;');
      const version = this.db.prepare('PRAGMA user_version').get()!['user_version'];
      requireStore(version === this.schema, 'unsupported-version');
      const identity = this.db.prepare('SELECT project,task FROM identity').get();
      requireStore(
        identity &&
          identity['project'] === context.project_id &&
          identity['task'] === context.task_id,
        'invalid-context',
      );
      this.files.assertRoot();
      this.db.exec(
        mode !== 'live'
          ? 'PRAGMA query_only=ON; PRAGMA foreign_keys=ON;'
          : 'PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON;',
      );
    } catch (error) {
      try {
        this.inspectable();
      } finally {
        this.db.close();
      }
      throw error;
    }
  }

  private inspectable(): void {
    if (this.mode !== 'inspect') return;
    this.files.assertRoot();
    const path = join(this.files.root, 'store.sqlite');
    const header = readPrivateFile(path, 100);
    requireStore(
      ['-journal', '-wal', '-shm'].every(
        (suffix) => lstatSync(path + suffix, { throwIfNoEntry: false }) === undefined,
      ) &&
        header[18] === 1 &&
        header[19] === 1,
      'recovery-required',
    );
    requireStore(databaseVersion(path) === this.schema, 'unsupported-version');
  }

  state(archive: 'current' | 'full' = 'full'): TechnicalState {
    const text = this.db.prepare('SELECT body FROM state WHERE singleton=1').get()![
      'body'
    ] as string;
    this.archived = text.startsWith(archivePrefix);
    this.retained = text.startsWith(retainedPrefix);
    return this.decode(text, undefined, archive === 'full');
  }
  save(state: TechnicalState, archived = false, retained = false): void {
    this.archived ||= archived;
    this.retained ||= retained;
    this.db.prepare('UPDATE state SET body=? WHERE singleton=1').run(this.encode(state));
  }
  encode(value: unknown): string {
    return (
      (this.retained ? retainedPrefix : this.archived ? archivePrefix : '') +
      (this.schema === 1
        ? canonical(value)
        : encodeSharedJson(value, (content) => this.files.publish(content)))
    );
  }
  decode<T>(text: string, blobs?: Set<string>, full = true): T {
    return decodeArchivedJson(
      text,
      (hash) => {
        blobs?.add(hash);
        return this.files.readBlob(hash);
      },
      full,
    ) as T;
  }
  check(): void {
    requireStore(
      this.db.prepare('PRAGMA integrity_check').get()!['integrity_check'] === 'ok' &&
        this.db.prepare('PRAGMA foreign_key_check').all().length === 0,
      'corrupt',
    );
  }
  transaction<T>(write: boolean, work: () => T): T {
    this.files.assertRoot();
    this.inspectable();
    requireStore(!write || this.mode !== 'inspect', 'permission-denied');
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const value = work();
      this.files.assertRoot();
      this.inspectable();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      // SQLite may roll back automatically on I/O/full errors.
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}

export function revisionMatches(actual: number, expected: number): void {
  if (actual !== expected) throw new StoreFault('revision-conflict', actual);
}
