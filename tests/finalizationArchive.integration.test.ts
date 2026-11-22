import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FinalizationArchive } from '../adapters/storage/finalizationArchive.js';
import type { FinalizationSeed } from '../core/finalization.js';
import { finalizationFixture } from './finalizationFixtures.js';
import { body, grant } from './storageFixtures.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { restoreStore } from '../adapters/storage/storeBackup.js';
import type { Json } from '../core/evidence.js';
let f: Awaited<ReturnType<typeof finalizationFixture>>;
beforeEach(async () => {
  f = await finalizationFixture();
});
afterEach(async () => {
  await f.dispose();
});
const changedProof = async (name: string, value: unknown) => {
  const path = resolve(f.paths.receipts, name + '.json');
  writeFileSync(path, canonical(value));
  return f.inputs.ref(path);
};
const mutateAuthority = async (patch: Record<string, unknown>) => {
  await f.file('cleanup-authority.json', JSON.stringify({ ...f.authority, ...patch }));
  return {
    ...f.seed,
    policy: { ...f.seed.policy, authority: await f.ref('cleanup-authority.json') },
  } as FinalizationSeed;
};

it('exports all original FAIL/raw/dispositions, restores elsewhere and recovers every complete receipt without replacing copies', async () => {
  const manifest = await f.restored();
  expect(await f.archive.freeze(f.seed)).toEqual(manifest);
  const backup = readFileSync(resolve(f.paths.archive, 'store.sqlite'));
  expect((await f.archive.export(manifest)).receipt).toEqual(
    (await f.archive.restore(manifest)).receipt,
  );
  expect(readFileSync(resolve(f.paths.archive, 'store.sqlite'))).toEqual(backup);
  const state = await f.current(),
    first = await f.archive.archive(f.seed, state, f.proof);
  f.setClock(105);
  expect(await f.archive.archive(f.seed, state, f.proof)).toEqual(first);
  await f.send({ type: 'ARCHIVE', authority: f.proof, ...first });
  expect(manifest.entries[0]).toMatchObject({ result: 'FAIL', id: 'original-fail' });
  expect(manifest.blobs.every((hash) => existsSync(resolve(f.paths.restored, 'blobs', hash)))).toBe(
    true,
  );
  expect(f.db.mutate({ type: 'write', id: 'late', body }, manifest.state.revision).ok).toBe(false);
});
it('requires explicit reservation, external receipts and elapsed grace for disposable cleanup; recovery preserves two verified copies', async () => {
  await f.reserved();
  const state = await f.current();
  await expect(f.archive.cleanup(f.seed, { ...state, phase: 'archived' })).rejects.toThrow(
    'reservation',
  );
  await expect(f.archive.cleanup({ ...f.seed, policy: { mode: 'retain' } }, state)).rejects.toThrow(
    'retention',
  );
  f.setClock(109);
  await expect(f.archive.cleanup(f.seed, state)).rejects.toThrow('grace');
  f.setClock(110);
  const proof = await f.archive.cleanup(f.seed, state);
  expect(existsSync(f.paths.source)).toBe(false);
  expect(await f.archive.cleanup(f.seed, state)).toEqual(proof);
  await f.send({ type: 'CLEANED', proof });
  expect((await f.current()).phase).toBe('cleaned');
  expect(existsSync(f.paths.archive)).toBe(true);
  expect(existsSync(f.paths.restored)).toBe(true);
});
it('keeps cleanup unknown if source disappears without prior intent or a conflicting quarantine exists', async () => {
  await f.reserved();
  const state = await f.current();
  mkdirSync(f.paths.source + '.cleanup');
  await expect(f.archive.cleanup(f.seed, state)).rejects.toThrow('location-conflict');
  rmSync(f.paths.source + '.cleanup', { recursive: true });
  // Simulate a crash after the durable intent and atomic rename, before recursive deletion.
  renameSync(f.paths.source, f.paths.source + '.cleanup');
  const proof = await f.archive.cleanup(f.seed, state);
  await f.send({ type: 'CLEANED', proof });
  rmSync(resolve(f.paths.receipts, 'cleanup-intent.json'));
  await expect(f.archive.cleanup(f.seed, state)).rejects.toThrow('origin-unknown');
});
it('refuses nested/colliding roots, including its quarantine, before writing', () => {
  for (const paths of [
    { ...f.paths, archive: f.paths.source },
    { ...f.paths, archive: f.paths.source + '/nested' },
    { ...f.paths, archive: f.paths.source + '.cleanup' },
    { ...f.paths, source: 'relative' },
  ])
    expect(() => new FinalizationArchive(f.root, f.db.parent, paths, grant, () => 100)).toThrow(
      'disjoint',
    );
});
it('requires done, matching primary result and complete producer stop, with management authority', async () => {
  await expect(
    new FinalizationArchive(
      f.root,
      f.db.parent,
      f.paths,
      { ...grant, permissions: ['read'] },
      () => 100,
    ).prepare(f.seed),
  ).rejects.toThrow('authority');
  const execution = f.checkpoint.workflow.execution;
  for (const patch of [{ schema_version: 9 }, { status: 'review' }, { result: null }]) {
    const state = f.db.execute({ type: 'state' });
    if (!state.ok) throw Error('fixture');
    f.db.mutate(
      {
        type: 'checkpoint',
        state: {
          ...f.checkpoint,
          workflow: { schema_version: 1, execution: { ...execution, ...patch } },
        } as unknown as Json,
        effects: [],
      },
      (state.value as { revision: number }).revision,
    );
    await expect(f.archive.prepare(f.seed)).rejects.toThrow('needs-done');
  }
  const current = f.db.execute({ type: 'state' });
  if (!current.ok) throw Error('fixture');
  f.db.mutate(
    { type: 'checkpoint', state: f.checkpoint as unknown as Json, effects: [] },
    (current.value as { revision: number }).revision,
  );
  for (const identity of [
    { project_id: 'wrong', identity: { task_id: 'task', card: f.proof } },
    { project_id: 'project', identity: { assignment_id: 'x' } },
    { project_id: 'project', identity: { task_id: 'wrong', card: f.proof } },
  ])
    await expect(
      f.archive.prepare({
        ...f.seed,
        run: { ...f.seed.run, spec: { ...f.seed.run.spec, ...identity } },
      }),
    ).rejects.toThrow('needs-done');
  for (const data of [
    { kind: 'other', result: execution.result },
    { kind: 'done', result: { wrong: true } },
  ]) {
    await f.file('done.json', JSON.stringify(data));
    await expect(f.archive.prepare({ ...f.seed, done: await f.ref('done.json') })).rejects.toThrow(
      'done-proof',
    );
  }
  await f.file('done.json', JSON.stringify({ kind: 'done', result: execution.result }));
  const stopped = {
    kind: 'producers-stopped',
    project_id: 'project',
    task_id: 'task',
    complete: true,
    remaining: 0,
  };
  for (const patch of [
    { kind: 'wrong' },
    { project_id: 'wrong' },
    { task_id: 'wrong' },
    { complete: false },
    { remaining: 1 },
  ]) {
    await f.file('stopped.json', JSON.stringify({ ...stopped, ...patch }));
    await expect(
      f.archive.prepare({ ...f.seed, stopped: await f.ref('stopped.json') }),
    ).rejects.toThrow('producers');
  }
});
it('requires exact disposable scope, operator, version and grace independently of journal claims', async () => {
  for (const patch of [
    { kind: 'other' },
    { disposable: false },
    { source: f.paths.archive },
    { operator: 'other' },
    { policy_version: 'other' },
    { grace_ms: 0 },
  ])
    await expect(f.archive.prepare(await mutateAuthority(patch))).rejects.toThrow('test-authority');
  await f.file('cleanup-authority.json', JSON.stringify(f.authority));
  await expect(
    f.archive.prepare({ ...f.seed, policy: { mode: 'retain' } }),
  ).resolves.toBeUndefined();
});
it('detects new evidence after catalog, missing raw and partial export rather than overwriting them', async () => {
  const manifest = await f.start();
  mkdirSync(f.paths.archive);
  await expect(f.archive.export(manifest)).rejects.toThrow('ENOENT');
  rmSync(f.paths.archive, { recursive: true });
  const raw = resolve(f.paths.source, 'blobs', manifest.entries[0]!.raw_hash),
    bytes = readFileSync(raw);
  rmSync(raw);
  await expect(f.archive.export(manifest)).rejects.toThrow();
  writeFileSync(raw, bytes, { mode: 0o600 });
  f.db.mutate({ type: 'thaw' }, manifest.state.revision);
  f.db.mutate({ type: 'write', id: 'late', body }, manifest.state.revision + 1);
  f.db.mutate({ type: 'freeze' }, manifest.state.revision + 2);
  await expect(f.archive.export(manifest)).rejects.toThrow('catalog-changed');
});
it('validates copied catalog, database and receipt fields and rejects tampering on restore', async () => {
  const manifest = await f.start();
  await f.archive.export(manifest);
  const path = resolve(f.paths.archive, 'receipt.json'),
    original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  for (const patch of [
    { manifest_hash: 'bad' },
    { database_hash: 'bad' },
    { revision: 0 },
    { project_id: 'wrong' },
    { task_id: 'wrong' },
    { blobs: [] },
  ]) {
    writeFileSync(path, JSON.stringify({ ...original, ...patch }));
    await expect(f.archive.restore(manifest)).rejects.toThrow('copy-mismatch');
  }
  writeFileSync(path, JSON.stringify(original));
  await expect(
    f.archive.restore({ ...manifest, context: { ...manifest.context, project_id: 'wrong' } }),
  ).rejects.toThrow('copy-mismatch');
  mkdirSync(f.paths.restored);
  await expect(f.archive.restore(manifest)).rejects.toThrow('ENOENT');
});

it('verifies and restores a self-contained WAL backup without changing its pinned bytes', async () => {
  const manifest = await f.start();
  const { receipt } = await f.archive.export(manifest);
  const path = resolve(f.paths.archive, 'store.sqlite');
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare('PRAGMA journal_mode=WAL').get()).toMatchObject({ journal_mode: 'wal' });
  } finally {
    db.close();
  }
  const database = readFileSync(path);
  expect([...database.subarray(18, 20)]).toEqual([2, 2]);
  const pinned = { ...receipt, database_hash: digest(database) };
  writeFileSync(resolve(f.paths.archive, 'receipt.json'), canonical(pinned));
  const archiveFiles = readdirSync(f.paths.archive);
  const occupied = f.paths.restored + '-occupied';
  mkdirSync(occupied);
  expect(() => restoreStore(f.paths.archive, occupied, grant)).toThrow('EEXIST');
  expect(readFileSync(path)).toEqual(database);
  expect(readdirSync(f.paths.archive)).toEqual(archiveFiles);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = path + suffix;
    writeFileSync(sidecar, 'not covered by the backup receipt');
    await expect(f.archive.restore(manifest)).rejects.toThrow('corrupt');
    expect(readFileSync(sidecar, 'utf8')).toBe('not covered by the backup receipt');
    expect(existsSync(f.paths.restored)).toBe(false);
    rmSync(sidecar);
  }
  expect((await f.archive.restore(manifest)).receipt).toEqual(pinned);
  expect((await f.archive.restore(manifest)).receipt).toEqual(pinned);
  expect(readFileSync(path)).toEqual(database);
  expect(readdirSync(f.paths.archive)).toEqual(archiveFiles);
  expect(readFileSync(resolve(f.paths.restored, 'store.sqlite'))).toEqual(database);
});

it('rejects fabricated export/restore/archive/cleanup receipts and future clock claims', async () => {
  const manifest = await f.restored(),
    state = await f.current();
  await expect(f.archive.archive(f.seed, { ...state, phase: 'started' }, f.proof)).rejects.toThrow(
    'restore-before',
  );
  const archived = await f.archive.archive(f.seed, state, f.proof),
    actual = JSON.parse(readFileSync(archived.proof.locator, 'utf8')) as Record<string, unknown>;
  for (const patch of [
    { kind: 'wrong' },
    { id: 'other' },
    { at: 99 },
    { authority: manifest.context },
    { manifest: 'wrong' },
    { revision: 0 },
  ]) {
    const proof = await changedProof('tampered', { ...actual, ...patch });
    await expect(
      f.archive.confirm(f.seed, state, {
        type: 'ARCHIVE',
        id: 'a',
        revision: 3,
        authority: f.proof,
        at: 100,
        proof,
      }),
    ).rejects.toThrow('confirmation');
  }
  f.setClock(99);
  await expect(
    f.archive.confirm(f.seed, state, {
      type: 'ARCHIVE',
      id: 'a',
      revision: 3,
      authority: f.proof,
      at: 100,
      proof: archived.proof,
    }),
  ).rejects.toThrow('confirmation');
  f.setClock(100);
  await f.send({ type: 'ARCHIVE', authority: f.proof, ...archived });
  await expect(
    f.archive.confirm(f.seed, await f.current(), {
      type: 'RESERVE_CLEANUP',
      operator: 'tester',
      now: 110,
      authority: f.proof,
      id: 'r',
      revision: 4,
    }),
  ).rejects.toThrow('clock');
  for (const type of ['EXPORT', 'RESTORE'] as const) {
    const exporting = type === 'EXPORT',
      base = {
        kind: exporting ? 'export' : 'restore',
        root: exporting ? f.paths.archive : f.paths.restored,
        receipt: state.exported,
      };
    for (const patch of [{ kind: 'wrong' }, { root: 'wrong' }, { receipt: { wrong: true } }]) {
      const proof = await changedProof('tampered', { ...base, ...patch });
      await expect(
        f.archive.confirm(f.seed, state, {
          type,
          id: 'e',
          revision: 0,
          receipt: state.exported!,
          proof,
        }),
      ).rejects.toThrow('proof-mismatch');
    }
    const wrong = { ...state.exported!, schema: 999 },
      proof = await changedProof('tampered', { ...base, receipt: wrong });
    await expect(
      f.archive.confirm(f.seed, state, { type, id: 'e', revision: 0, receipt: wrong, proof }),
    ).rejects.toThrow('receipt-mismatch');
  }
  const forged = await changedProof('forged', {
    kind: 'cleaned',
    id: f.seed.id,
    manifest: state.exported!.manifest_hash,
    archive: archived.proof,
  });
  await expect(
    f.archive.confirm(
      f.seed,
      { ...state, archive: archived },
      { type: 'CLEANED', proof: forged, id: 'c', revision: 5 },
    ),
  ).rejects.toThrow('cleanup-unconfirmed');
});
it('keeps invalid archive receipts and incomplete cleanup outcomes out of successful history', async () => {
  await f.reserved();
  const state = await f.current(),
    original = JSON.parse(readFileSync(state.archive!.proof.locator, 'utf8')) as Record<
      string,
      unknown
    >;
  for (const patch of [{ kind: 'bad' }, { id: 'bad' }, { manifest: 'bad' }, { at: 0 }]) {
    const proof = await changedProof('tampered', { ...original, ...patch });
    await expect(
      f.archive.cleanup(f.seed, { ...state, archive: { ...state.archive!, proof } }),
    ).rejects.toThrow('confirmation');
  }
  const proof = await f.archive.cleanup(f.seed, state),
    cleaned = JSON.parse(readFileSync(proof.locator, 'utf8')) as Record<string, unknown>;
  for (const patch of [{ kind: 'bad' }, { id: 'bad' }, { manifest: 'bad' }, { archive: f.proof }]) {
    const bad = await changedProof('tampered', { ...cleaned, ...patch });
    await expect(
      f.archive.confirm(f.seed, state, { type: 'CLEANED', proof: bad, id: 'c', revision: 5 }),
    ).rejects.toThrow('cleanup-unconfirmed');
  }
  mkdirSync(f.paths.source + '.cleanup');
  await expect(
    f.archive.confirm(f.seed, state, { type: 'CLEANED', proof, id: 'c', revision: 5 }),
  ).rejects.toThrow('cleanup-unconfirmed');
  const conflict = await changedProof('export', { bad: true });
  expect(conflict.hash).toBeTruthy();
  await expect(f.archive.restore(state.manifest!)).resolves.toBeDefined();
  await expect(
    f.archive.archive(f.seed, { ...state, phase: 'restored' }, f.proof),
  ).rejects.toThrow();
});
