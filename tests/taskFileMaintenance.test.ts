import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
const faults = vi.hoisted(() => ({ firstRename: false, indexRename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    renameSync: vi.fn((from: fs.PathLike, to: fs.PathLike) => {
      if (faults.firstRename) {
        faults.firstRename = false;
        throw new Error('copy-publish');
      }
      if (faults.indexRename && String(to).endsWith('.workflow-files.json'))
        throw new Error('index-publish');
      return actual.renameSync(from, to);
    }),
  };
});
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, grant, signed } from './storageFixtures.js';
import {
  relocateTaskFiles,
  materializeTaskFiles,
  type TaskFileRequest,
} from '../adapters/storage/taskFileMaintenance.js';
import {
  filePointer,
  locationsName,
  locatedPath,
  type FileLocations,
} from '../adapters/storage/fileLocations.js';
import { privateFileSource, readPrivateFile } from '../adapters/storage/storeFiles.js';
import { initializeStore, StoreDatabase } from '../adapters/storage/storeDatabase.js';
import { noStorageProbe } from '../adapters/storage/storeFiles.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { digest, canonicalHash } from '../adapters/storage/storeCodec.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { projectText } from '../adapters/project/projectFiles.js';
import { runChatCommand } from '../cli/chatCommand.js';
import { runChatCheck } from '../adapters/project/chatChecks.js';
import { AppServerSessions } from '../adapters/codex/appServerSessions.js';
import { rejectedSend } from '../adapters/codex/rejectedSend.js';

let db: ReturnType<typeof fixture>, root: string, request: TaskFileRequest;
let extra: string[];
const original = JSON.stringify({ observation: 'exact FAIL and original output '.repeat(3000) });
const tool = '#!/bin/sh\nprintf "fixture-tool-1\\n"\n';
beforeEach(() => {
  faults.firstRename = false;
  faults.indexRename = false;
  const base = fixture();
  root = resolve(base.parent, 'namespace');
  mkdirSync(root);
  const storeRoot = resolve(root, 'store');
  initializeStore(storeRoot, grant.context);
  const store = new SqliteEvidenceStore(storeRoot, grant, () => 100);
  db = {
    ...base,
    root: storeRoot,
    store,
    execute: (command) => store.execute({ context: grant.context, command }),
    mutate: (...args: Parameters<typeof base.mutate>) => store.execute(signed(...args)),
    claim: () => unwrap(store.execute(signed({ type: 'claim', lease_until: 1000 }, 0, 0))),
  };
  db.claim();
  extra = [];
  mkdirSync(resolve(root, 'evidence'));
  mkdirSync(resolve(root, 'native-tools'));
  writeFileSync(resolve(root, 'evidence/original.json'), original, { mode: 0o600 });
  writeFileSync(resolve(root, 'native-tools/tool'), tool, { mode: 0o700 });
  request = {
    operation_id: 'relocate',
    expected_revision: 1,
    expected_generation: 1,
    expected_owner: 'owner',
    files: {
      'evidence/original.json': { hash: digest(original), kind: 'archive' },
      'native-tools/tool': { hash: digest(tool), kind: 'tool' },
    },
  };
});
afterEach(() => {
  db.dispose();
  for (const path of extra) rmSync(path, { recursive: true, force: true });
});
const apply = (
  r = request,
  authority = grant,
  now = 1001,
  probe?: Parameters<typeof relocateTaskFiles>[5],
) => relocateTaskFiles(root, db.root, authority, r, () => now, probe);
function index() {
  return JSON.parse(readFileSync(resolve(root, locationsName), 'utf8')) as FileLocations;
}
function restored() {
  const path = resolve(dirname(root), basename(root) + '-restored');
  extra.push(path);
  return path;
}

it('moves originals and tools while retaining exact logical refs, readable proofs, executable cache and an independent restore', async () => {
  const files = new FileWorkflowInputs(root, root);
  const before = await files.ref('evidence/original.json');
  const result = apply();
  expect(result.files).toBe(2);
  expect(readFileSync(resolve(root, 'evidence/original.json'), 'utf8')).toBe(
    filePointer(before.hash),
  );
  expect(readPrivateFile(resolve(root, 'evidence/original.json')).toString()).toBe(original);
  expect(await projectText(root, 'evidence/original.json')).toBe(original);
  expect(await files.ref('evidence/original.json')).toEqual(before);
  const executable = privateFileSource(resolve(root, 'native-tools/tool'));
  expect(executable.kind).toBe('tool');
  expect(spawnSync(executable.path, [], { encoding: 'utf8' })).toMatchObject({
    status: 0,
    stdout: 'fixture-tool-1\n',
  });
  expect(apply()).toEqual(result);
  const target = restored(),
    copy = materializeTaskFiles(root, target, db.root, grant, () => 1001);
  expect(copy.hash).toBe(canonicalHash(copy.files));
  expect(readFileSync(resolve(target, 'evidence/original.json'), 'utf8')).toBe(original);
  expect(readFileSync(resolve(target, 'native-tools/tool'), 'utf8')).toBe(tool);
  expect(existsSync(resolve(target, locationsName))).toBe(false);
  await expect(
    runChatCheck(root, root, {
      id: 'archived',
      command: { file: process.execPath, args: ['evidence/original.json'] },
      discovery: { files: ['native-tools/tool'], directories: [] },
      attested_by: 'owner',
    }),
  ).rejects.toThrow('archived-command-input');
  await expect(
    runChatCheck(root, root, {
      id: 'archive-bin',
      command: { file: resolve(root, 'evidence/original.json'), args: [] },
      discovery: { files: ['native-tools/tool'], directories: [] },
      attested_by: 'owner',
    }),
  ).rejects.toThrow('archived-command-input');
  expect(
    (
      await runChatCheck(root, root, {
        id: 'cached',
        command: { file: resolve(root, 'native-tools/tool'), args: [] },
        discovery: { files: ['native-tools/tool'], directories: [] },
        attested_by: 'owner',
      })
    ).check.verdict,
  ).toBe('PASS');
  expect(
    (
      await runChatCheck(root, root, {
        id: 'cached-argument',
        command: { file: '/bin/sh', args: [resolve(root, 'native-tools/tool')] },
        discovery: { files: ['native-tools/tool'], directories: [] },
        attested_by: 'owner',
      })
    ).check.verdict,
  ).toBe('PASS');
  expect(apply()).toEqual(result);
});
it('leaves originals intact and removes temporary files when copying or publishing fails', () => {
  faults.firstRename = true;
  expect(() => apply()).toThrow('copy-publish');
  expect(readFileSync(resolve(root, 'evidence/original.json'), 'utf8')).toBe(original);
  faults.indexRename = true;
  expect(() => apply()).toThrow('index-publish');
  expect(readFileSync(resolve(root, 'evidence/original.json'), 'utf8')).toBe(original);
  faults.indexRename = false;
  expect(apply()).toMatchObject({ files: 2 });
});
it('can archive without tools and refuses unknown or mismatched check operations', () => {
  const lock = resolve(root, 'unknown.check.lock');
  writeFileSync(lock, '{}');
  expect(() => apply()).toThrow('invalid-context');
  fs.unlinkSync(lock);
  const intent = resolve(root, 'pending.intent.json');
  writeFileSync(intent, JSON.stringify({ request_hash: 'intent' }));
  expect(() => apply()).toThrow();
  writeFileSync(
    resolve(root, 'pending.json'),
    JSON.stringify({ request_hash: 'other', operation_id: 'pending' }),
  );
  expect(() => apply()).toThrow('invalid-context');
  writeFileSync(intent, JSON.stringify({ request_hash: 1 }));
  expect(() => apply()).toThrow('invalid-context');
  writeFileSync(intent, JSON.stringify({ request_hash: 'intent' }));
  writeFileSync(
    resolve(root, 'pending.json'),
    JSON.stringify({ request_hash: 'intent', operation_id: 'foreign' }),
  );
  expect(() => apply()).toThrow('invalid-context');
  writeFileSync(
    resolve(root, 'pending.json'),
    JSON.stringify({ request_hash: 'intent', operation_id: 'pending' }),
  );
  expect(
    apply({
      ...request,
      files: { 'evidence/original.json': request.files['evidence/original.json']! },
    }).tools,
  ).toBeNull();
});
it.each(['copied', 'indexed', 'replaced'] as const)(
  'resumes a crash at %s without losing originals or changing the checkpoint',
  (stage) => {
    expect(() =>
      apply(request, grant, 1001, (observed) => {
        if (observed === stage) throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(readPrivateFile(resolve(root, 'evidence/original.json')).toString()).toBe(original);
    const result = apply();
    expect(result.checkpoint_hash).toBe(canonicalHash(null));
    expect(index().complete).toBe(true);
  },
);
it('shares an identical tool set between namespaces', () => {
  const first = apply();
  const sibling = resolve(db.parent, 'peer');
  mkdirSync(sibling);
  mkdirSync(resolve(sibling, 'native-tools'));
  writeFileSync(resolve(sibling, 'native-tools/tool'), tool, { mode: 0o700 });
  const store = resolve(sibling, 'store');
  initializeStore(store, grant.context);
  unwrap(
    new SqliteEvidenceStore(store, grant, () => 100).execute(
      signed({ type: 'claim', lease_until: 1000 }, 0, 0),
    ),
  );
  const result = relocateTaskFiles(
    sibling,
    store,
    grant,
    { ...request, files: { 'native-tools/tool': request.files['native-tools/tool']! } },
    () => 1001,
  );
  expect(result.tools).toBe(first.tools);
  expect(privateFileSource(resolve(sibling, 'native-tools/tool')).path).toBe(
    privateFileSource(resolve(root, 'native-tools/tool')).path,
  );
});
it('denies stale/active ownership, missing manage, protected paths, invalid kinds and changed data', () => {
  expect(() => apply(request, { ...grant, permissions: ['read'] })).toThrow('permission-denied');
  expect(() => apply({ ...request, expected_revision: 0 })).toThrow('revision-conflict');
  for (const r of [
    { ...request, expected_generation: 2 },
    { ...request, expected_owner: 'foreign' },
  ])
    expect(() => apply(r)).toThrow('stale-owner');
  expect(() => apply(request, grant, 100)).toThrow('stale-owner');
  expect(() => apply({ ...request, operation_id: '' })).toThrow('invalid-context');
  expect(() => apply({ ...request, files: {} })).toThrow('invalid-context');
  for (const name of [
    'request.json',
    '../escape',
    'store/store.sqlite',
    'controller/state',
    'card-projections/current.json',
    'connection/descriptor.json',
    'x.check.lock',
    'x.intent.json',
    'council/architect.json',
  ])
    expect(() =>
      apply({ ...request, files: { [name]: { hash: digest('x'), kind: 'archive' } } }),
    ).toThrow('permission-denied');
  expect(() =>
    apply({
      ...request,
      files: { 'evidence/original.json': { hash: 'a'.repeat(64), kind: 'archive' } },
    }),
  ).toThrow('corrupt');
  expect(() =>
    apply({
      ...request,
      files: { 'evidence/original.json': { hash: digest(original), kind: 'invalid' as 'archive' } },
    }),
  ).toThrow('invalid-context');
  expect(() =>
    apply({
      ...request,
      files: { 'evidence/original.json': { hash: digest(original), kind: 'tool' } },
    }),
  ).toThrow('corrupt');
  symlinkSync(resolve(root, 'evidence/original.json'), resolve(root, 'alias'));
  expect(() =>
    apply({ ...request, files: { alias: { hash: digest(original), kind: 'archive' } } }),
  ).toThrow('permission-denied');
});
it('rejects pending Store effects and a conflicting relocation without modifying a source', () => {
  db.mutate(
    {
      type: 'checkpoint',
      state: { pending: true },
      effects: [{ id: 'pending', intent: { type: 'run' } }],
    },
    1,
  );
  expect(() => apply({ ...request, expected_revision: 2 })).toThrow('invalid-context');
  expect(readFileSync(resolve(root, 'evidence/original.json'), 'utf8')).toBe(original);
  expect(() => materializeTaskFiles(root, restored(), db.root, grant, () => 1001)).toThrow(
    'invalid-context',
  );
});
it('requires manage and a quiet Store for materialization and accepts released/frozen snapshots', () => {
  apply();
  expect(() =>
    materializeTaskFiles(root, restored(), db.root, { ...grant, permissions: ['read'] }),
  ).toThrow('permission-denied');
  expect(() => materializeTaskFiles(root, restored(), db.root + '/wrong', grant)).toThrow(
    'invalid-context',
  );
  expect(() => materializeTaskFiles(root, restored(), db.root, grant, () => 100)).toThrow(
    'stale-owner',
  );
  for (const flag of ['released', 'frozen'] as const) {
    const store = new StoreDatabase(db.root, grant.context, noStorageProbe);
    const state = store.state('current');
    state.released = false;
    state.frozen = false;
    state[flag] = true;
    store.save(state);
    store.close();
    expect(
      materializeTaskFiles(root, restored() + flag, db.root, grant, () => 100).files[
        'evidence/original.json'
      ],
    ).toBe(digest(original));
    extra.push(restored() + flag);
  }
});
it('rejects an index conflict, corrupt content and a concurrent source change', () => {
  expect(() =>
    apply(request, grant, 1001, (stage) => {
      if (stage === 'copied') writeFileSync(resolve(root, 'evidence/original.json'), 'new writer');
    }),
  ).toThrow('corrupt');
  expect(readFileSync(resolve(root, 'evidence/original.json'), 'utf8')).toBe('new writer');
  writeFileSync(resolve(root, 'evidence/original.json'), original);
  apply();
  expect(() => apply({ ...request, operation_id: 'other' })).toThrow('revision-conflict');
  const entry = index().files['evidence/original.json']!;
  writeFileSync(locatedPath(root, 'evidence/original.json', entry), 'corrupt');
  expect(() => readPrivateFile(resolve(root, 'evidence/original.json'))).toThrow('corrupt');
  expect(() => privateFileSource(resolve(root, 'evidence/original.json'))).toThrow('corrupt');
  expect(() => apply()).toThrow('corrupt');
  expect(() => materializeTaskFiles(root, root, db.root, grant, () => 1001)).toThrow(
    'permission-denied',
  );
});
it('keeps unregistered literal markers literal and refuses forged location metadata', () => {
  const path = resolve(root, 'literal');
  writeFileSync(path, filePointer('a'.repeat(64)));
  expect(readPrivateFile(path).toString()).toBe(filePointer('a'.repeat(64)));
  apply();
  expect(readPrivateFile(path).toString()).toBe(filePointer('a'.repeat(64)));
  const saved = index();
  for (const change of [{ schema_version: 2 }, { root: 'foreign' }, { files: null }]) {
    writeFileSync(resolve(root, locationsName), JSON.stringify({ ...saved, ...change }));
    expect(() => readPrivateFile(resolve(root, 'evidence/original.json'))).toThrow('corrupt');
  }
  writeFileSync(resolve(root, locationsName), JSON.stringify(saved));
  writeFileSync(resolve(root, 'evidence/original.json'), filePointer('b'.repeat(64)));
  expect(() => readPrivateFile(resolve(root, 'evidence/original.json'))).toThrow('corrupt');
  expect(() => locatedPath(root, '../escape', saved.files['evidence/original.json']!)).toThrow(
    'permission-denied',
  );
  for (const patch of [
    { hash: 'bad' },
    { bytes: -1 },
    { mode: NaN },
    { kind: 'unknown' },
    { kind: 'tool', bundle: 'bad' },
    { kind: 'tool', bundle: null },
  ])
    expect(() =>
      locatedPath(root, 'evidence/original.json', {
        ...saved.files['evidence/original.json']!,
        ...patch,
      } as never),
    ).toThrow('corrupt');
});
it('exposes relocation, cache resolution and full materialization through CLI', async () => {
  const path = resolve(root, 'command.json'),
    output: string[] = [],
    errors: string[] = [];
  const call = async (command: string, values: Record<string, unknown>) => {
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        root,
        namespace: root,
        storage: { root: db.root, grant },
        ...values,
      }),
    );
    return runChatCommand(
      [command, path],
      (line) => output.push(line),
      (line) => errors.push(line),
    );
  };
  expect(await call('relocate-files', { relocation: request })).toBe(0);
  expect(await call('resolve-tool', { locator: 'native-tools/tool' })).toBe(0);
  expect(JSON.parse(output.at(-1)!) as unknown).toMatchObject({ kind: 'tool', hash: digest(tool) });
  expect(await call('resolve-tool', { locator: 'evidence/original.json' })).toBe(1);
  expect(errors.at(-1)).toContain('tool-not-cached');
  expect(await call('materialize-files', { destination: restored() })).toBe(0);
});
it('reuses an archived native receipt and recovers an archived legacy rejection through their original logical addresses', async () => {
  const rpc = {
    request: vi.fn(async () => ({
      thread: { id: 'session', projectId: 'project', turns: [], forkedFromId: null },
      cwd: root,
      sandbox: { type: 'readOnly', networkAccess: false },
      model: 'model',
      reasoningEffort: 'high',
    })),
    completed: vi.fn(async () => {}),
  };
  const sessions = new AppServerSessions(rpc, root, 'project', root);
  const first = await sessions.create({ model: 'model', effort: 'high', reason: 'fixture' });
  const journal = resolve(root, 'transport.jsonl');
  const sent = {
    id: 1,
    method: 'turn/start',
    params: {
      threadId: 'session',
      input: [{ type: 'text', text: 'Workflow delivery id: "delivery"\nrequest' }],
    },
  };
  const response = {
    id: 1,
    error: { code: -32602, data: { input_error_code: 'input_too_large' } },
  };
  const transcript =
    JSON.stringify({ direction: 'send', data: sent }) +
    '\n' +
    JSON.stringify({ direction: 'recv', data: response }) +
    '\n';
  writeFileSync(journal, transcript);
  request.files[basename(first.receipt.locator)] = { hash: first.receipt.hash, kind: 'archive' };
  request.files['transport.jsonl'] = { hash: digest(transcript), kind: 'archive' };
  apply();
  expect(
    (await sessions.create({ model: 'model', effort: 'high', reason: 'fixture' })).receipt,
  ).toEqual(first.receipt);
  expect(await rejectedSend(journal, 'session', 'delivery')).toMatchObject({
    request: sent,
    response,
  });
});
