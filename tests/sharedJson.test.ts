import * as artifactFiles from '../adapters/storage/storeFiles.js';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeSharedJson, decodeSharedJson } from '../adapters/storage/sharedJson.js';
import { canonical, canonicalHash, digest } from '../adapters/storage/storeCodec.js';
import { stableJson } from '../core/equality.js';
import { saveChatArtifact, readChatArtifact } from '../cli/chatContinuation.js';
import { runChatCommand } from '../cli/chatCommand.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import { exportStore, restoreStore } from '../adapters/storage/storeBackup.js';
import { SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { fixture, grant } from './storageFixtures.js';
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.dispose();
});
const source = 'исходный текст \ud800\udfff'.repeat(5000);
it('hashes canonical request bytes without assembling the complete serialized request', () => {
  for (const value of [
    null,
    {},
    [],
    { source, history: [source, { z: 1, a: 2 }] },
    { é: 1, é: 2, '10': true },
  ])
    expect(canonicalHash(value)).toBe(digest(canonical(value)));
});
it('rejects invalid values beyond the large-size threshold without replacing the managed root', () => {
  const path = join(f.parent, 'invalid-managed.json');
  saveManaged(path, { preserved: true });
  for (const value of [undefined, NaN, Infinity, () => 1, Symbol('invalid')]) {
    expect(() => saveManaged(path, { a: source, z: value })).toThrow('invalid-context');
    expect(readManaged(path)).toEqual({ preserved: true });
  }
});
it('stores large managed histories as shared data and keeps legacy literals and independent objects', () => {
  const path = join(f.parent, 'managed.json');
  const value = {
    source,
    history: [
      { source, status: 'FAIL' },
      { source, status: 'FAIL' },
    ],
  };
  saveManaged(path, value);
  expect(statSync(path).size).toBeLessThan(1000);
  const restored = readManaged<typeof value>(path)!;
  expect(restored).toEqual(value);
  restored.history[0]!.status = 'changed';
  expect(restored.history[1]!.status).toBe('FAIL');
  expect(readManaged(path)).toEqual(value);
  for (const literal of ['AWJSON1\n["ref","literal"]', { legacy: true }, [1, null, false]]) {
    writeFileSync(path, JSON.stringify(literal));
    expect(readManaged(path)).toEqual(literal);
  }
  expect(readManaged(join(f.parent, 'missing.json'))).toBeNull();
});

it('reads every referenced chunk once per operation without retaining stale bytes between reads', () => {
  const ref = saveChatArtifact(f.parent, 'repeated', {
    a: { source },
    b: { source },
    c: { source },
  });
  const read = vi.spyOn(artifactFiles, 'readPrivateFile');
  try {
    expect(readChatArtifact(ref)).toEqual({ a: { source }, b: { source }, c: { source } });
    const paths = read.mock.calls.map(([path]) => path);
    expect(new Set(paths).size).toBe(paths.length);
    const blob = paths.find((path) => path.includes('/shared-json/'))!;
    writeFileSync(blob, 'changed');
    expect(() => readChatArtifact(ref)).toThrow('chat-artifact-conflict');
  } finally {
    read.mockRestore();
  }
});
it('shares repeated nested JSON histories without changing strings, reserved-looking values or arrays', () => {
  const blobs = new Map<string, string>();
  const publish = (text: string) => {
    const hash = digest(text);
    blobs.set(hash, text);
    return hash;
  };
  const value = {
    a: source,
    b: source,
    events: [stableJson({ source, status: 'FAIL' })],
    literal: 'not json '.repeat(1000),
  };
  const encoded = encodeSharedJson(value, publish);
  expect(decodeSharedJson(encoded, (hash) => blobs.get(hash)!)).toEqual(value);
  const count = blobs.size;
  encodeSharedJson({ ...value, revision: 2 }, publish);
  expect(blobs.size).toBe(count);
  expect(encoded.length).toBeLessThan(1000);
  for (const value of [
    null,
    3,
    true,
    'AWJSON1\n',
    '\u0000'.repeat(1000),
    ['ref', 'literal'],
    { a: 'b' },
  ])
    expect(decodeSharedJson(encodeSharedJson(value, publish), (hash) => blobs.get(hash)!)).toEqual(
      value,
    );
  expect(decodeSharedJson('{"legacy":true}', () => '')).toEqual({ legacy: true });
  expect(() => decodeSharedJson('AWJSON1\n[]', () => '')).toThrow();
  expect(() => decodeSharedJson('AWJSON1\n["unknown",0]', () => '')).toThrow();
});
it('parses shared nodes once per read while every mutable value remains independent', () => {
  const blobs = new Map<string, string>();
  const item = { source, small: { entries: [null, true, 7, { verdict: 'FAIL' }] } };
  const value = { a: item, b: item, json: stableJson(item) };
  const encoded = encodeSharedJson(value, (text) => {
    const hash = digest(text);
    blobs.set(hash, text);
    return hash;
  });
  const read = vi.fn((hash: string) => blobs.get(hash)!);
  const restored = decodeSharedJson(encoded, read) as typeof value;
  expect(restored).toEqual(value);
  expect(new Set(read.mock.calls.map(([hash]) => hash)).size).toBe(read.mock.calls.length);
  (restored.a.small.entries[3] as { verdict: string }).verdict = 'changed';
  expect(restored.b.small.entries[3]).toEqual({ verdict: 'FAIL' });
  expect(restored.json).toBe(stableJson(item));
  expect(decodeSharedJson(encoded, read)).toEqual(value);
  const first = read.mock.calls[0]![0];
  blobs.set(first, 'corrupt');
  expect(() => decodeSharedJson(encoded, read)).toThrow('corrupt');
});
it('bounds the growth of new Store snapshots and restores every referenced blob', async () => {
  f.claim();
  for (let revision = 1; revision <= 12; revision++)
    expect(
      f.mutate(
        {
          type: 'checkpoint',
          state: { revision, source, history: [stableJson({ source })] },
          effects: [],
        },
        revision,
      ).ok,
    ).toBe(true);
  const size = readdirSync(join(f.root, 'blobs')).reduce(
    (n, p) => n + statSync(join(f.root, 'blobs', p)).size,
    0,
  );
  expect(size).toBeLessThan(Buffer.byteLength(source) * 3);
  expect(f.mutate({ type: 'freeze' }, 13).ok).toBe(true);
  const backup = join(f.parent, 'backup'),
    restored = join(f.parent, 'restored');
  await exportStore(f.root, backup, grant);
  restoreStore(backup, restored, grant);
  expect(
    new SqliteEvidenceStore(restored, grant, () => 100).execute({
      context: grant.context,
      command: { type: 'state' },
    }),
  ).toEqual(f.execute({ type: 'state' }));
  const blob = readdirSync(join(restored, 'blobs'))[0]!;
  writeFileSync(join(restored, 'blobs', blob), 'corrupt');
  await expect(() => exportStore(restored, join(f.parent, 'bad-backup'), grant)).rejects.toThrow();
});
it('reads and writes legacy Store version 1 without an implicit migration', async () => {
  const db = new DatabaseSync(join(f.root, 'store.sqlite'));
  db.exec('PRAGMA user_version=1');
  db.close();
  const identity = join(f.root, 'identity.json');
  writeFileSync(
    identity,
    JSON.stringify({ ...JSON.parse(readFileSync(identity, 'utf8')), schema: 1 }),
  );
  f.claim();
  expect(f.mutate({ type: 'checkpoint', state: { source }, effects: [] }, 1).ok).toBe(true);
  expect(f.execute({ type: 'state' })).toMatchObject({
    ok: true,
    value: { checkpoint: { source } },
  });
  f.mutate({ type: 'freeze' }, 2);
  expect(await exportStore(f.root, join(f.parent, 'legacy-backup'), grant)).toMatchObject({
    schema: 1,
  });
  expect(
    restoreStore(join(f.parent, 'legacy-backup'), join(f.parent, 'legacy-restored'), grant),
  ).toMatchObject({ schema: 1 });
  expect(
    new SqliteEvidenceStore(join(f.parent, 'legacy-restored'), grant, () => 100).execute({
      context: grant.context,
      command: { type: 'state' },
    }),
  ).toEqual(f.execute({ type: 'state' }));
});
it('keeps large full command results addressable and rejects missing or damaged artifacts', async () => {
  const ref = saveChatArtifact(f.parent, 'result', { source, repeat: source });
  expect(ref.locator).toContain('.shared.json');
  expect(readChatArtifact(ref)).toEqual({ source, repeat: source });
  expect(saveChatArtifact(f.parent, 'result', { source, repeat: source })).toEqual(ref);
  const request = join(f.parent, 'ref.json');
  writeFileSync(request, JSON.stringify(ref));
  const output: string[] = [];
  expect(
    await runChatCommand(
      ['read-artifact', request],
      (s) => output.push(s),
      () => {},
    ),
  ).toBe(0);
  expect(JSON.parse(output[0]!)).toEqual({ source, repeat: source });
  expect(() => readChatArtifact({ ...ref, hash: 'wrong' })).toThrow('chat-artifact-conflict');
  expect(readChatArtifact(saveChatArtifact(f.parent, 'small', { yes: true }))).toEqual({
    yes: true,
  });
  const manifest = readFileSync(ref.locator, 'utf8');
  const invalid = 'AWJSON1\n["ref","../outside"]';
  writeFileSync(ref.locator, invalid);
  expect(() => readChatArtifact({ ...ref, hash: digest(invalid) })).toThrow(
    'chat-artifact-conflict',
  );
  writeFileSync(ref.locator, manifest);
  const blob = readdirSync(join(f.parent, 'shared-json'))[0]!;
  writeFileSync(join(f.parent, 'shared-json', blob), 'damaged');
  expect(() => readChatArtifact(ref)).toThrow('chat-artifact-conflict');
  expect(() => saveChatArtifact(f.parent, 'result', { source, repeat: source })).toThrow(
    'chat-artifact-conflict',
  );
});

it('addresses identical large objects independently of root and nested property insertion order', () => {
  const first = saveChatArtifact(f.parent, 'ordered', { a: source, b: { x: 1, y: 2 }, c: source });
  const second = saveChatArtifact(f.parent, 'ordered', { c: source, b: { y: 2, x: 1 }, a: source });
  expect(second).toEqual(first);
});

it('keeps distinct Unicode keys deterministic even when locale collation considers them equal', () => {
  const first = { '\u00e9': source, 'e\u0301': 'different', nested: { b: 2, a: 1 } };
  const second = { nested: { a: 1, b: 2 }, 'e\u0301': 'different', '\u00e9': source };
  const ref = saveChatArtifact(f.parent, 'unicode-keys', first);
  expect(saveChatArtifact(f.parent, 'unicode-keys', second)).toEqual(ref);
  expect(readChatArtifact(ref)).toEqual(first);
});

it('does not publish a partial chunk when a write fails and permits a clean retry', () => {
  const original = artifactFiles.writePrivateFile;
  const failure = vi
    .spyOn(artifactFiles, 'writePrivateFile')
    .mockImplementationOnce((path, bytes) => {
      original(path, bytes.slice(0, 10));
      throw new Error('injected partial write');
    });
  try {
    expect(() => saveChatArtifact(f.parent, 'interrupted', { source })).toThrow(
      'injected partial write',
    );
  } finally {
    failure.mockRestore();
  }
  const ref = saveChatArtifact(f.parent, 'interrupted', { source });
  expect(readChatArtifact(ref)).toEqual({ source });
});

it('preserves errors when the large-artifact parent directory does not exist', () => {
  expect(() => saveChatArtifact(join(f.parent, 'missing'), 'large', { source })).toThrow('ENOENT');
});
