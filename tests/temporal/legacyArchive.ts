import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { exactFields, object, requireContract } from '../../src/contracts/project.js';
import { createBackup } from '../../src/adapters/artifacts/backup.js';
import {
  digest,
  publishFile,
  readPrivateFile,
  syncDirectory,
} from '../../src/adapters/artifacts/files.js';

const shared = 'AWJSON1\n',
  archived = 'AWARCHIVE1\n',
  retained = 'AWRETAIN1\n';
function file(path: string): Buffer {
  const stat = lstatSync(path);
  requireContract(
    realpathSync(path) === path && stat.isFile() && stat.nlink === 1,
    'legacy-plain-file-required',
  );
  return readPrivateFile(path);
}
function rootPath(value: unknown): string {
  requireContract(typeof value === 'string' && isAbsolute(value), 'legacy-absolute-root-required');
  const root = resolve(value);
  requireContract(
    realpathSync(root) === root && lstatSync(root).isDirectory(),
    'legacy-plain-root-required',
  );
  for (const suffix of ['-journal', '-wal', '-shm'])
    requireContract(
      !existsSync(join(root, 'store.sqlite' + suffix)),
      'legacy-database-recovery-required',
    );
  return root;
}
function json(text: unknown): unknown {
  requireContract(typeof text === 'string', 'legacy-json-required');
  return JSON.parse(text) as unknown;
}
function inflate(text: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    gunzipSync(Buffer.from(text, 'base64'), { maxOutputLength: 1_073_741_824 }),
  );
}
function decoder(read: (hash: unknown) => Buffer) {
  const active = new Set<string>();
  const archives = new Map<string, Record<string, unknown>>();
  function decode(text: string): unknown {
    if (text.startsWith(retained)) return decode(text.slice(retained.length));
    if (text.startsWith(archived)) return expand(decode(text.slice(archived.length)));
    if (text.startsWith(shared)) return node(json(text.slice(shared.length)));
    requireContract(!/^AW[A-Z0-9]+\n/u.test(text), 'legacy-format-unsupported');
    return json(text);
  }
  function node(value: unknown): unknown {
    requireContract(Array.isArray(value) && value.length === 2, 'legacy-shared-node-invalid');
    const kind: unknown = value[0],
      child: unknown = value[1];
    switch (kind) {
      case 'value':
        return child;
      case 'ref': {
        requireContract(typeof child === 'string' && !active.has(child), 'legacy-shared-cycle');
        active.add(child);
        try {
          return node(json(read(child).toString('utf8')));
        } finally {
          active.delete(child);
        }
      }
      case 'string':
        return stable(node(child));
      case 'array':
        requireContract(Array.isArray(child), 'legacy-shared-node-invalid');
        return child.map(node);
      case 'object': {
        requireContract(Array.isArray(child), 'legacy-shared-node-invalid');
        const entries = child.map((entry: unknown): [string, unknown] => {
          requireContract(
            Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string',
            'legacy-shared-node-invalid',
          );
          return [entry[0], node(entry[1])];
        });
        requireContract(
          new Set(entries.map(([key]) => key)).size === entries.length,
          'legacy-shared-duplicate',
        );
        return Object.fromEntries(entries);
      }
      default:
        throw new Error('legacy-shared-node-invalid');
    }
  }
  function archive(hash: unknown): Record<string, unknown> {
    requireContract(typeof hash === 'string', 'legacy-blob-ref-invalid');
    const previous = archives.get(hash);
    if (previous !== undefined) return previous;
    const body = object(decode(read(hash).toString('utf8')));
    if (body.dependencies !== undefined) {
      requireContract(Array.isArray(body.dependencies), 'legacy-history-invalid');
      for (const dependency of body.dependencies) archive(dependency);
    }
    archives.set(hash, body);
    return body;
  }
  function expand(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(expand);
    if (value === null || typeof value !== 'object') return value;
    const input = object(value),
      execution =
        [2, 3].includes(Number(input.schema_version)) &&
        typeof input.task_id === 'string' &&
        'reviewer_sessions' in input,
      council =
        ['planning', 'acceptance'].includes(String(input.phase)) &&
        'selection' in input &&
        'advisers' in input;
    return Object.fromEntries(
      Object.entries(input).map(([key, child]) => {
        if (key !== 'history' || (!execution && !council)) return [key, expand(child)];
        requireContract(Array.isArray(child), 'legacy-history-invalid');
        return [
          key,
          child.map((raw: unknown) => {
            const entry = object(raw);
            if (entry.archive === undefined) return entry;
            const body = archive(object(entry.archive).hash);
            if (execution) {
              requireContract(
                body.kind === 'execution-event' && typeof body.payload === 'string',
                'legacy-history-invalid',
              );
              const payload = json(inflate(body.payload));
              requireContract(typeof payload === 'string', 'legacy-history-invalid');
              const { archive: _archive, ...rest } = entry;
              return { ...rest, payload };
            }
            requireContract(body.kind === 'council-answer', 'legacy-history-invalid');
            const answer = object(body.answer),
              summary = object(entry.answer);
            for (const [name, value] of Object.entries(summary)) {
              const actual =
                name === 'binding'
                  ? { answer_turn: object(answer.binding).answer_turn }
                  : answer[name];
              requireContract(stable(actual) === stable(value), 'legacy-history-summary-mismatch');
            }
            return { role: entry.role, session: entry.session, answer };
          }),
        ];
      }),
    );
  }
  return decode;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stable(object(value)[key]))
        .join(',') +
      '}'
    );
  const text = JSON.stringify(value);
  requireContract(text !== undefined, 'legacy-json-required');
  return text;
}
function payloads(value: unknown, encoding?: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => payloads(item));
  if (value === null || typeof value !== 'object') return value;
  const v = object(value);
  requireContract(
    v.history_payload_encoding === undefined || v.history_payload_encoding === 1,
    'legacy-history-encoding-unsupported',
  );
  return Object.fromEntries(
    Object.entries(v).map(([key, child]) => {
      if (key !== 'history' || encoding !== 1)
        return [key, payloads(child, key === 'execution' ? v.history_payload_encoding : undefined)];
      requireContract(Array.isArray(child), 'legacy-history-invalid');
      return [
        key,
        child.map((raw: unknown) => {
          const entry = object(raw);
          if (
            typeof entry.payload !== 'string' ||
            !entry.payload.startsWith('agent-workflow:gzip-history:')
          )
            return entry;
          const match = /^agent-workflow:gzip-history:([12]):(.*)$/su.exec(entry.payload);
          requireContract(match, 'legacy-history-encoding-unsupported');
          const text = inflate(match[2]!),
            payload = match[1] === '1' ? text : json(text);
          requireContract(typeof payload === 'string', 'legacy-history-invalid');
          return { ...entry, payload };
        }),
      ];
    }),
  );
}

export function readLegacyArchive(raw: unknown) {
  const input = object(raw);
  exactFields(input, ['schemaVersion', 'root']);
  requireContract(input.schemaVersion === 1, 'legacy-input-version');
  const root = rootPath(input.root),
    identity = object(json(file(join(root, 'identity.json')).toString('utf8')));
  requireContract(
    [1, 2].includes(Number(identity.schema)) &&
      typeof identity.project === 'string' &&
      typeof identity.task === 'string',
    'legacy-identity-invalid',
  );
  const database = file(join(root, 'store.sqlite'));
  requireContract(
    database.length >= 100 &&
      database.subarray(0, 16).toString() === 'SQLite format 3\0' &&
      database.readUInt32BE(60) === identity.schema,
    'legacy-database-version',
  );
  const refs = new Map<string, { sha256: string; bytes: number }>();
  const read = (hash: unknown): Buffer => {
    requireContract(
      typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash),
      'legacy-blob-ref-invalid',
    );
    const bytes = file(join(root, 'blobs', hash));
    requireContract(digest(bytes) === hash, 'legacy-blob-corrupted');
    refs.set(hash, { sha256: hash, bytes: bytes.length });
    return bytes;
  };
  requireContract(
    realpathSync(join(root, 'blobs')) === join(root, 'blobs') &&
      lstatSync(join(root, 'blobs')).isDirectory(),
    'legacy-plain-root-required',
  );
  for (const hash of readdirSync(join(root, 'blobs')).sort()) read(hash);
  const decode = decoder(read),
    db = new DatabaseSync(join(root, 'store.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN;');
    requireContract(
      db.prepare('PRAGMA integrity_check').get()!['integrity_check'] === 'ok' &&
        db.prepare('PRAGMA foreign_key_check').all().length === 0,
      'legacy-database-corrupted',
    );
    const sqlIdentity = db.prepare('SELECT project,task FROM identity').all();
    requireContract(
      sqlIdentity.length === 1 &&
        sqlIdentity[0]!['project'] === identity.project &&
        sqlIdentity[0]!['task'] === identity.task,
      'legacy-identity-mismatch',
    );
    const stateRows = db.prepare('SELECT body FROM state WHERE singleton=1').all();
    requireContract(stateRows.length === 1, 'legacy-state-required');
    const state = payloads(decode(String(stateRows[0]!['body']))),
      entries = db
        .prepare('SELECT id,revision,metadata FROM entries ORDER BY id,revision')
        .all()
        .map((row) => {
          const metadata = object(json(row['metadata']));
          requireContract(
            metadata.id === row['id'] && metadata.revision === row['revision'],
            'legacy-entry-identity-mismatch',
          );
          const body = json(read(metadata.content_hash).toString('utf8')),
            raw = json(read(metadata.raw_hash).toString('utf8'));
          requireContract(stable(object(body).raw) === stable(raw), 'legacy-entry-raw-mismatch');
          return { id: row['id'], revision: row['revision'], metadata, body, raw };
        });
    const tables = {
      state: stateRows,
      entries: db.prepare('SELECT id,revision,metadata FROM entries ORDER BY id,revision').all(),
      heads: db.prepare('SELECT id,revision FROM heads ORDER BY id').all(),
      operations: db.prepare('SELECT id,hash,ack FROM operations ORDER BY id').all(),
      events: db.prepare('SELECT revision,body FROM events ORDER BY revision').all(),
      effects: db.prepare('SELECT id,body FROM effects ORDER BY id').all(),
    };
    const result = {
      schemaVersion: 1 as const,
      kind: 'legacy-history' as const,
      executionImport: false as const,
      identity,
      database: { sha256: digest(database), bytes: database.length },
      state,
      entries,
      events: tables.events.map((row) => decode(String(row['body']))),
      operations: tables.operations.map((row) => decode(String(row['ack']))),
      effects: tables.effects.map((row) => decode(String(row['body']))),
      tables,
      blobs: [...refs.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    };
    db.exec('COMMIT;');
    requireContract(
      digest(file(join(root, 'store.sqlite'))) === result.database.sha256,
      'legacy-source-changed',
    );
    rootPath(root);
    return result;
  } finally {
    db.close();
  }
}

export function exportLegacyArchive(raw: unknown) {
  const input = object(raw);
  exactFields(input, ['schemaVersion', 'root', 'destination']);
  const history = readLegacyArchive({ schemaVersion: input.schemaVersion, root: input.root }),
    saved = createBackup({
      schemaVersion: 2,
      roots: { legacy: input.root },
      destination: input.destination,
    });
  const after = readLegacyArchive({ schemaVersion: input.schemaVersion, root: input.root });
  requireContract(stable(after) === stable(history), 'legacy-source-changed');
  const bytes = Buffer.from(JSON.stringify(history)),
    historyRef = { sha256: digest(bytes), bytes: bytes.length };
  publishFile(join(String(input.destination), 'history.json'), bytes);
  const result = {
    status: 'archived' as const,
    executionImport: false as const,
    requiresReconciliation: true as const,
    identity: history.identity,
    manifest: saved.manifest,
    history: historyRef,
  };
  publishFile(join(String(input.destination), 'ARCHIVE.json'), Buffer.from(JSON.stringify(result)));
  syncDirectory(String(input.destination));
  return result;
}
