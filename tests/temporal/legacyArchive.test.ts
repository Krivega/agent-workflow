import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readLegacyArchive,
  exportLegacyArchive,
} from '../../src/adapters/artifacts/legacyArchive.js';
import { stageRestore, verifyBackup } from '../../src/adapters/artifacts/backup.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { legacyArchiveCommand } from '../../src/client/legacyArchive.js';

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(schema = 2) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'aw-legacy-'))),
    store = join(root, 'store');
  temporary.push(root);
  fs.mkdirSync(store);
  fs.mkdirSync(join(store, 'blobs'));
  const db = new DatabaseSync(join(store, 'store.sqlite'));
  db.exec(`CREATE TABLE identity(singleton INTEGER PRIMARY KEY,project TEXT,task TEXT);
    CREATE TABLE state(singleton INTEGER PRIMARY KEY,body TEXT);
    CREATE TABLE entries(id TEXT,revision INTEGER,metadata TEXT,PRIMARY KEY(id,revision));
    CREATE TABLE heads(id TEXT PRIMARY KEY,revision INTEGER,FOREIGN KEY(id,revision) REFERENCES entries(id,revision));
    CREATE TABLE operations(id TEXT PRIMARY KEY,hash TEXT,ack TEXT);
    CREATE TABLE events(revision INTEGER PRIMARY KEY,body TEXT);
    CREATE TABLE effects(id TEXT PRIMARY KEY,body TEXT);
    INSERT INTO identity VALUES(1,'project','task'); PRAGMA user_version=${schema};`);
  db.prepare('INSERT INTO state VALUES(1,?)').run(
    JSON.stringify({
      revision: 0,
      generation: 0,
      owner: null,
      lease_until: 0,
      released: true,
      frozen: false,
      checkpoint: null,
    }),
  );
  db.close();
  fs.writeFileSync(
    join(store, 'identity.json'),
    JSON.stringify({ schema, project: 'project', task: 'task' }),
  );
  function write(text: string) {
    const hash = digest(text);
    fs.writeFileSync(join(store, 'blobs', hash), text);
    return hash;
  }
  function sql(query: string, ...parameters: (string | number)[]) {
    const db = new DatabaseSync(join(store, 'store.sqlite'));
    try {
      db.prepare(query).run(...parameters);
    } finally {
      db.close();
    }
  }
  function state(value: unknown) {
    sql('UPDATE state SET body=?', typeof value === 'string' ? value : JSON.stringify(value));
  }
  const raw = { input: 'original input', output: 'FAIL F-1\n' },
    body = {
      result: 'FAIL',
      findings: [{ id: 'F-1', status: 'open' }],
      raw,
      Result: { status: 'FAIL', limitation: 'original' },
    },
    metadata = {
      id: 'proof-1',
      revision: 1,
      content_hash: write(JSON.stringify(body)),
      raw_hash: write(JSON.stringify(raw)),
      result: 'FAIL',
    };
  sql('INSERT INTO entries VALUES (?,?,?)', metadata.id, 1, JSON.stringify(metadata));
  sql('INSERT INTO heads VALUES (?,?)', metadata.id, 1);
  return {
    root,
    store,
    write,
    sql,
    state,
    body,
    metadata,
    input: { schemaVersion: 1, root: store },
  };
}
describe('read-only legacy history and independent export', () => {
  it.each([1, 2])(
    'reads schema %i without changing database bytes and exports without runtime import',
    (schema) => {
      const f = fixture(schema),
        before = fs.readFileSync(join(f.store, 'store.sqlite'));
      f.sql('INSERT INTO events VALUES (?,?)', 1, '{"id":"event-1","result":"FAIL"}');
      f.sql(
        'INSERT INTO operations VALUES (?,?,?)',
        'op-1',
        'original-hash',
        '{"operation_id":"op-1"}',
      );
      f.sql('INSERT INTO effects VALUES (?,?)', 'effect-1', '{"outcome":"unknown","receipt":null}');
      const source = fs.readFileSync(join(f.store, 'store.sqlite')),
        history = readLegacyArchive(f.input);
      expect(before).not.toEqual(source);
      expect(history.entries[0]).toMatchObject({
        id: 'proof-1',
        metadata: f.metadata,
        body: f.body,
      });
      expect(history.events).toEqual([{ id: 'event-1', result: 'FAIL' }]);
      expect(history.operations).toEqual([{ operation_id: 'op-1' }]);
      expect(history.effects).toEqual([{ outcome: 'unknown', receipt: null }]);
      expect(fs.readFileSync(join(f.store, 'store.sqlite'))).toEqual(source);
      const destination = join(f.root, 'archive'),
        result = exportLegacyArchive({ ...f.input, destination });
      expect(result).toMatchObject({
        status: 'archived',
        executionImport: false,
        requiresReconciliation: true,
      });
      expect(digest(fs.readFileSync(join(destination, 'history.json')))).toBe(
        result.history.sha256,
      );
      verifyBackup({ schemaVersion: 1, backup: destination, manifest: result.manifest });
      fs.rmSync(f.store, { recursive: true });
      const restored = join(f.root, 'staged');
      stageRestore({
        schemaVersion: 1,
        backup: destination,
        manifest: result.manifest,
        destination: restored,
      });
      expect(readLegacyArchive({ ...f.input, root: join(restored, 'legacy') })).toEqual(history);
    },
  );
  it('preserves stale owner, retained fingerprints, FAIL/findings/Result and literal reference-shaped objects', () => {
    const f = fixture(),
      original = {
        owner: 'previous-owner',
        released: false,
        checkpoint: {
          Result: { findings: ['F-1'], result: 'FAIL' },
          history: [{ id: 'command-1', fingerprint: 'a'.repeat(64), payload: '' }],
          literal: ['ref', 'literal'],
          large: 'original '.repeat(900),
        },
      };
    const sharedHash = f.write(JSON.stringify(['value', original]));
    f.state('AWRETAIN1\nAWJSON1\n' + JSON.stringify(['ref', sharedHash]));
    expect(readLegacyArchive(f.input).state).toEqual(original);
    expect(
      exportLegacyArchive({ ...f.input, destination: join(f.root, 'archive') }).executionImport,
    ).toBe(false);
  });
  it('expands archived execution and council history with exact original IDs and answer bodies', () => {
    const f = fixture(),
      answer = {
        verdict: 'FAIL',
        coverage: { complete: false },
        findings: [{ id: 'F-7', detail: 'original' }],
        evidence: ['proof-1'],
        design: { decision: 'retain' },
        binding: { answer_turn: 'turn-3', original: true },
      },
      value = {
        execution: {
          schema_version: 2,
          task_id: 'task',
          reviewer_sessions: {},
          history: [
            { id: 'event-2', payload: 'original \ud800 FAIL' },
            { id: 'retained', payload: '', fingerprint: 'b'.repeat(64) },
          ],
        },
        council: {
          phase: 'acceptance',
          selection: {},
          advisers: {},
          history: [{ role: 'tester', session: 'session-2', answer }],
        },
        literal: [null, { archive: { hash: 'f'.repeat(64) } }],
      };
    const eventHash = f.write(
        JSON.stringify({
          kind: 'execution-event',
          payload: gzipSync(JSON.stringify(value.execution.history[0]!.payload)).toString('base64'),
          dependencies: [],
        }),
      ),
      answerHash = f.write(JSON.stringify({ kind: 'council-answer', answer })),
      packed = {
        ...value,
        execution: {
          ...value.execution,
          history: [
            { ...value.execution.history[0], payload: '', archive: { hash: eventHash } },
            value.execution.history[1],
          ],
        },
        council: {
          ...value.council,
          history: [
            {
              role: 'tester',
              session: 'session-2',
              answer: { ...answer, binding: { answer_turn: answer.binding.answer_turn } },
              archive: { hash: answerHash },
            },
          ],
        },
      };
    f.state('AWARCHIVE1\nAWJSON1\n' + JSON.stringify(['value', packed]));
    expect(readLegacyArchive(f.input).state).toEqual(value);
  });
  it('checks shared archive dependencies once while preserving original evidence and IDs', () => {
    const f = fixture(),
      dependency = JSON.stringify({ kind: 'council-answer', answer: f.body }),
      dependencyHash = f.write(dependency),
      eventHash = f.write(
        JSON.stringify({
          kind: 'execution-event',
          payload: gzipSync(JSON.stringify('original FAIL F-1')).toString('base64'),
          dependencies: [dependencyHash, dependencyHash],
        }),
      ),
      execution = {
        schema_version: 2,
        task_id: 'task',
        reviewer_sessions: {},
        history: [
          { id: 'original-event', payload: '', archive: { hash: eventHash } },
          { id: 'same-archive', payload: '', archive: { hash: eventHash } },
        ],
      };
    f.state('AWARCHIVE1\nAWJSON1\n' + JSON.stringify(['value', { execution }]));
    const parse = vi.spyOn(JSON, 'parse'),
      result = readLegacyArchive(f.input);
    expect(parse.mock.calls.filter(([text]) => text === dependency)).toHaveLength(1);
    expect(result.state).toEqual({
      execution: {
        ...execution,
        history: [
          { id: 'original-event', payload: 'original FAIL F-1' },
          { id: 'same-archive', payload: 'original FAIL F-1' },
        ],
      },
    });
    expect(result.entries[0]).toMatchObject({ metadata: f.metadata, body: f.body });
    expect(result.blobs).toContainEqual({
      sha256: dependencyHash,
      bytes: Buffer.byteLength(dependency),
    });
    const database = fs.readFileSync(join(f.store, 'store.sqlite')),
      destination = join(f.root, 'archive'),
      exported = exportLegacyArchive({ ...f.input, destination }),
      staged = join(f.root, 'staged');
    verifyBackup({ schemaVersion: 1, backup: destination, manifest: exported.manifest });
    expect(digest(fs.readFileSync(join(destination, 'history.json')))).toBe(
      exported.history.sha256,
    );
    expect(JSON.parse(fs.readFileSync(join(destination, 'history.json'), 'utf8'))).toEqual(result);
    expect(
      stageRestore({
        schemaVersion: 1,
        backup: destination,
        manifest: exported.manifest,
        destination: staged,
      }),
    ).toMatchObject({ status: 'staged', requiresReconciliation: true });
    expect(readLegacyArchive({ ...f.input, root: join(staged, 'legacy') })).toEqual(result);
    expect(fs.readFileSync(join(staged, 'legacy', 'blobs', dependencyHash), 'utf8')).toBe(
      dependency,
    );
    expect(fs.readFileSync(join(f.store, 'store.sqlite'))).toEqual(database);
  });
  it.each(['missing', 'transitive-missing', 'corrupt'])(
    'refuses an incomplete archive dependency before export: %s',
    (kind) => {
      const f = fixture(),
        dependencyHash = f.write(JSON.stringify({ kind: 'council-answer', answer: f.body }));
      let dependency = dependencyHash;
      if (kind === 'transitive-missing')
        dependency = f.write(
          JSON.stringify({
            kind: 'execution-event',
            payload: gzipSync(JSON.stringify('original nested event')).toString('base64'),
            dependencies: [dependencyHash],
          }),
        );
      const eventHash = f.write(
        JSON.stringify({
          kind: 'execution-event',
          payload: gzipSync(JSON.stringify('original FAIL F-1')).toString('base64'),
          dependencies: [dependency],
        }),
      );
      f.state(
        'AWARCHIVE1\nAWJSON1\n' +
          JSON.stringify([
            'value',
            {
              schema_version: 2,
              task_id: 'task',
              reviewer_sessions: {},
              history: [{ id: 'original-event', payload: '', archive: { hash: eventHash } }],
            },
          ]),
      );
      const path = join(f.store, 'blobs', dependencyHash),
        database = fs.readFileSync(join(f.store, 'store.sqlite')),
        destination = join(f.root, 'archive');
      if (kind === 'corrupt') fs.writeFileSync(path, 'corrupt original dependency');
      else fs.unlinkSync(path);
      expect(() => readLegacyArchive(f.input)).toThrow();
      expect(() => exportLegacyArchive({ ...f.input, destination })).toThrow();
      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.readFileSync(join(f.store, 'store.sqlite'))).toEqual(database);
    },
  );
  it.each([null, {}, 'invalid', 7, [7], ['not-a-hash']])(
    'refuses malformed archive dependencies before export: %j',
    (dependencies) => {
      const f = fixture(),
        eventHash = f.write(
          JSON.stringify({
            kind: 'execution-event',
            payload: gzipSync(JSON.stringify('original FAIL F-1')).toString('base64'),
            dependencies,
          }),
        );
      f.state(
        'AWARCHIVE1\nAWJSON1\n' +
          JSON.stringify([
            'value',
            {
              schema_version: 2,
              task_id: 'task',
              reviewer_sessions: {},
              history: [{ id: 'original-event', payload: '', archive: { hash: eventHash } }],
            },
          ]),
      );
      const destination = join(f.root, 'archive');
      expect(() => exportLegacyArchive({ ...f.input, destination })).toThrow();
      expect(fs.existsSync(destination)).toBe(false);
    },
  );
  it('decodes a shared canonical JSON string containing nested arrays without interpreting literal references', () => {
    const f = fixture();
    f.state(
      'AWJSON1\n' +
        JSON.stringify([
          'string',
          [
            'object',
            [
              [
                'z',
                [
                  'array',
                  [
                    ['value', 7],
                    ['value', 'original'],
                  ],
                ],
              ],
              ['a', ['value', null]],
            ],
          ],
        ]),
    );
    expect(readLegacyArchive(f.input).state).toBe('{"a":null,"z":[7,"original"]}');
  });
  it.each([1, 2])(
    'decodes gzip history payload format %i without losing the original compressed table row',
    (version) => {
      const f = fixture(),
        text = 'historical FAIL \ud800',
        encoded =
          'agent-workflow:gzip-history:' +
          version +
          ':' +
          gzipSync(version === 1 ? 'historical FAIL' : JSON.stringify(text)).toString('base64');
      f.state({
        checkpoint: {
          schema_version: 2,
          history_payload_encoding: 1,
          execution: {
            history: [
              { id: 'old', payload: encoded },
              { id: 'plain', payload: 'original uncompressed FAIL' },
            ],
          },
        },
      });
      const result = readLegacyArchive(f.input);
      expect(JSON.stringify(result.state)).toContain(version === 1 ? 'historical FAIL' : '\\ud800');
      expect(String(result.tables.state[0]!['body'])).toContain(encoded);
    },
  );
  it.each(['-journal', '-wal', '-shm'])(
    'refuses uncheckpointed SQLite boundary %s without touching sources',
    (suffix) => {
      const f = fixture();
      fs.writeFileSync(join(f.store, 'store.sqlite' + suffix), 'pending');
      expect(() => readLegacyArchive(f.input)).toThrow('legacy-database-recovery-required');
    },
  );
  it.each(['corrupt', 'missing', 'hardlink', 'symlink'])(
    'refuses a broken declared blob: %s',
    (kind) => {
      const f = fixture(),
        path = join(f.store, 'blobs', f.metadata.content_hash);
      if (kind === 'corrupt') fs.writeFileSync(path, 'changed');
      else if (kind === 'hardlink') fs.linkSync(path, join(f.root, 'linked'));
      else {
        fs.unlinkSync(path);
        if (kind === 'symlink') fs.symlinkSync(join(f.store, 'blobs', f.metadata.raw_hash), path);
      }
      expect(() =>
        exportLegacyArchive({ ...f.input, destination: join(f.root, 'archive') }),
      ).toThrow();
      expect(fs.existsSync(join(f.root, 'archive'))).toBe(false);
    },
  );
  it.each(['AWJSON2\n{}', 'AWARCHIVE2\n{}', 'AWRETAIN2\n{}', 'AWLOCATION1\n{}'])(
    'refuses unknown format %s',
    (text) => {
      const f = fixture();
      f.state(text);
      expect(() => readLegacyArchive(f.input)).toThrow('legacy-format-unsupported');
    },
  );
  it('does not invent missing retained history or accept malformed shared nodes', () => {
    const f = fixture();
    for (const node of [
      ['other', null],
      ['array', {}],
      ['object', [['x']]],
      [
        'object',
        [
          ['x', ['value', 1]],
          ['x', ['value', 2]],
        ],
      ],
      ['ref', 'b'.repeat(64)],
    ]) {
      f.state('AWJSON1\n' + JSON.stringify(node));
      expect(() => readLegacyArchive(f.input)).toThrow();
    }
  });
  it('validates original identity, entry metadata and raw evidence before export', () => {
    const f = fixture();
    f.sql('UPDATE entries SET metadata=?', JSON.stringify({ ...f.metadata, id: 'foreign' }));
    expect(() => readLegacyArchive(f.input)).toThrow('legacy-entry-identity-mismatch');
    f.sql(
      'UPDATE entries SET metadata=?',
      JSON.stringify({ ...f.metadata, raw_hash: f.write('{"different":true}') }),
    );
    expect(() => readLegacyArchive(f.input)).toThrow('legacy-entry-raw-mismatch');
    f.sql('UPDATE identity SET task=?', 'foreign');
    expect(() => readLegacyArchive(f.input)).toThrow('legacy-identity-mismatch');
  });
  it('exposes the same read/export CLI and refuses unsupported inputs without creating files', () => {
    const f = fixture(),
      input = join(f.root, 'read.json');
    fs.writeFileSync(input, JSON.stringify(f.input));
    expect(legacyArchiveCommand(['read', input])).toEqual(readLegacyArchive(f.input));
    const output = join(f.root, 'export.json');
    fs.writeFileSync(output, JSON.stringify({ ...f.input, destination: join(f.root, 'archive') }));
    expect(legacyArchiveCommand(['export', output])).toMatchObject({ status: 'archived' });
    for (const args of [[], ['read'], ['other', input], ['read', ''], ['read', input, 'extra']])
      expect(() => legacyArchiveCommand(args)).toThrow('Usage: legacy-archive');
    expect(() => readLegacyArchive({ ...f.input, schemaVersion: 2 })).toThrow(
      'legacy-input-version',
    );
    expect(() => readLegacyArchive({ ...f.input, root: 'relative' })).toThrow(
      'legacy-absolute-root-required',
    );
    expect(() => readLegacyArchive({ ...f.input, extra: true })).toThrow('unexpected-fields');
  });
});
