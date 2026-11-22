import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  retainStore,
  restoreRetentionBackup,
  type RetentionRequest,
} from '../adapters/storage/retentionMaintenance.js';
import { retainEvidence, retentionFingerprint } from '../adapters/storage/retainedJson.js';
import { compactArchive } from '../adapters/storage/archiveJson.js';
import { canonicalHash } from '../adapters/storage/storeCodec.js';
import { StoreFiles, noStorageProbe } from '../adapters/storage/storeFiles.js';
import { StoreDatabase } from '../adapters/storage/storeDatabase.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { TaskLocalRuns } from '../adapters/storage/localRunStores.js';
import { createExecution } from '../core/execution.js';
import { encodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { runChatCommand } from '../cli/chatCommand.js';
import { fixture, grant, body } from './storageFixtures.js';
import { workflowFixture } from './workflowFixtures.js';
import type {
  TechnicalState,
  Json,
  EffectRecord,
  StoredEvidence,
  EventRecord,
} from '../core/evidence.js';
import type { LocalRun } from '../core/localRun.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
let db: ReturnType<typeof fixture>;
beforeEach(async () => {
  f = await workflowFixture();
  db = fixture();
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});

function setup(archived = false) {
  db.claim();
  const run = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'proof', kind: 'check', applicable: true, reason: 'proof' }],
    false,
    'substantial',
  );
  const event = {
    type: 'PLAN',
    id: 'legacy',
    expected_revision: 0,
    generation: 1,
    council: f.council('planning'),
  };
  const payload = JSON.stringify(event);
  run.history = [{ id: 'legacy', payload }];
  const checkpoint = {
    local_run: f.executor,
    workflow: { schema_version: 1, revision: 1, execution: run, readings: {} },
  };
  const packed = archived
    ? compactArchive(checkpoint)
    : { value: checkpoint as unknown as Json, blobs: [] };
  expect(
    db.mutate(
      {
        type: 'checkpoint',
        state: packed.value,
        effects: [{ id: 'external', intent: { command: 'pending', data: 'intent '.repeat(2000) } }],
        ...(archived ? { blobs: packed.blobs, archive_version: 1 } : {}),
      },
      1,
    ).ok,
  ).toBe(true);
  const evidence = unwrap(db.mutate({ type: 'write', id: 'original-FAIL', body }, 2));
  const orphan = new StoreFiles(db.root, noStorageProbe).publish(
    'discarded snapshot '.repeat(5000),
  );
  const before = unwrap<TechnicalState>(db.execute({ type: 'state', archive: 'current' }));
  const request: RetentionRequest = {
    operation_id: 'retain',
    expected_revision: before.revision,
    expected_generation: before.generation,
    expected_owner: before.owner,
    backup: join(db.parent, 'backup'),
  };
  return { request, before, payload, event, orphan, evidence };
}

it.each([false, true])(
  'deletes old bodies but preserves admission, effects, retry receipts and an exact backup (archive=%s)',
  async (archived) => {
    const s = setup(archived);
    const effects = unwrap<EffectRecord[]>(db.execute({ type: 'effects' }));
    const oldOperation = db.execute({ type: 'operation', operation_id: 'op-1' });
    const receipt = retainStore(db.root, grant, s.request, () => 1001);
    expect(receipt.deleted_blobs).toBeGreaterThan(0);
    expect(existsSync(join(db.root, 'blobs', s.orphan))).toBe(false);
    expect(db.execute({ type: 'operation', operation_id: 'op-1' })).toEqual(oldOperation);
    expect(unwrap(db.execute({ type: 'effects' }))).toEqual(effects);
    expect(
      unwrap<StoredEvidence>(db.execute({ type: 'read', id: 'original-FAIL', revision: null }))
        .body,
    ).toEqual(body);
    const state = unwrap<TechnicalState>(db.execute({ type: 'state' }));
    expect(state).toMatchObject({
      generation: s.before.generation,
      owner: s.before.owner,
      released: s.before.released,
      revision: s.before.revision + 1,
    });
    const run = (
      await new TaskWorkflowJournal(
        { execute: async (request) => db.store.execute(request) },
        grant.context,
        1,
      ).read()
    ).execution!;
    expect(run.history[0]).toMatchObject({
      id: 'legacy',
      payload: '',
      fingerprint: retentionFingerprint(s.event),
    });
    expect(JSON.stringify(run)).not.toContain(s.payload);
    const retried = retainStore(db.root, grant, s.request, () => 1001);
    expect(retried.ack).toEqual(receipt.ack);
    expect(retried.deleted_blobs).toBe(0);
    const restored = join(db.parent, 'restored');
    expect(
      restoreRetentionBackup(receipt.backup, restored, receipt.backup_hash).files,
    ).toBeGreaterThan(0);
    const original = unwrap<TechnicalState>(
      new SqliteEvidenceStore(restored, grant, () => 1001).execute({
        context: grant.context,
        command: { type: 'state', archive: 'current' },
      }),
    );
    expect(original).toEqual(s.before);
    expect(() =>
      restoreRetentionBackup(receipt.backup, join(db.parent, 'bad'), '0'.repeat(64)),
    ).toThrow('corrupt');
  },
);

it('rejects missing permissions, wrong identity/revision/owner/generation, an active lease and a frozen namespace', () => {
  const s = setup();
  expect(() => retainStore(db.root, { ...grant, permissions: ['read'] }, s.request)).toThrow(
    'permission-denied',
  );
  expect(() =>
    retainStore(db.root, { ...grant, context: { ...grant.context, task_id: 'other' } }, s.request),
  ).toThrow('invalid-context');
  expect(() =>
    retainStore(db.root, grant, { ...s.request, expected_revision: 2 }, () => 1001),
  ).toThrow('revision-conflict');
  for (const patch of [{ expected_owner: null }, { expected_generation: 2 }])
    expect(() => retainStore(db.root, grant, { ...s.request, ...patch }, () => 1001)).toThrow(
      'stale-owner',
    );
  expect(() => retainStore(db.root, grant, s.request, () => 999)).toThrow('stale-owner');
  for (const patch of [
    { operation_id: '' },
    { expected_revision: -1 },
    { expected_generation: -1 },
  ])
    expect(() => retainStore(db.root, grant, { ...s.request, ...patch }, () => 1001)).toThrow(
      'invalid-context',
    );
  for (const backup of [db.root, join(db.root, 'backup'), 'relative'])
    expect(() => retainStore(db.root, grant, { ...s.request, backup }, () => 1001)).toThrow(
      'permission-denied',
    );
  expect(existsSync(s.request.backup)).toBe(false);
  expect(db.mutate({ type: 'freeze' }, s.before.revision).ok).toBe(true);
  expect(() =>
    retainStore(
      db.root,
      grant,
      { ...s.request, expected_revision: s.before.revision + 1 },
      () => 1001,
    ),
  ).toThrow('stale-owner');
});

it('refuses a corrupted backup before modifying the authoritative state', () => {
  const s = setup();
  const bytes = readFileSync(join(db.root, 'store.sqlite'));
  expect(() =>
    retainStore(
      db.root,
      grant,
      s.request,
      () => 1001,
      (stage) => {
        if (stage === 'backup-created')
          writeFileSync(join(s.request.backup, 'identity.json'), 'changed');
      },
    ),
  ).toThrow('corrupt');
  expect(unwrap<TechnicalState>(db.execute({ type: 'state', archive: 'current' }))).toEqual(
    s.before,
  );
  expect(readFileSync(join(db.root, 'store.sqlite'))).toEqual(bytes);
  expect(existsSync(join(db.root, 'blobs', s.orphan))).toBe(true);
});

it.each(['before-commit', 'after-commit', 'blob-removed'] as const)(
  'recovers safely after a failure at %s',
  (boundary) => {
    const s = setup(true);
    let failed = false;
    expect(() =>
      retainStore(
        db.root,
        grant,
        s.request,
        () => 1001,
        (stage) => {
          if (stage === boundary && !failed) {
            failed = true;
            throw new Error('interrupted');
          }
        },
      ),
    ).toThrow('interrupted');
    const state = unwrap<TechnicalState>(db.execute({ type: 'state', archive: 'current' }));
    expect(state.revision).toBe(s.before.revision + (boundary === 'before-commit' ? 0 : 1));
    const recovered = retainStore(db.root, grant, s.request, () => 1001);
    expect(recovered.ack.catalog_revision).toBe(s.before.revision + 1);
    expect(existsSync(join(db.root, 'blobs', s.orphan))).toBe(false);
    expect(() =>
      retainStore(db.root, grant, { ...s.request, backup: join(db.parent, 'other') }, () => 1001),
    ).toThrow('revision-conflict');
    expect(
      retainEvidence(unwrap<TechnicalState>(db.execute({ type: 'state' })).checkpoint),
    ).toEqual(unwrap<TechnicalState>(db.execute({ type: 'state' })).checkpoint);
  },
);

it('exposes maintenance as an explicit CLI operation and keeps the output a short receipt', async () => {
  const s = setup();
  const path = join(f.root, 'retain.json');
  await f.file(
    'retain.json',
    JSON.stringify({
      schema_version: 1,
      root: f.root,
      storage: { root: db.root, grant },
      retention: s.request,
    }),
  );
  const output: string[] = [],
    errors: string[] = [];
  expect(
    await runChatCommand(
      ['retain-store', path],
      (text) => output.push(text),
      (text) => errors.push(text),
    ),
  ).toBe(0);
  expect(errors).toEqual([]);
  expect(output[0]!.length).toBeLessThan(2048);
  expect(
    (JSON.parse(output[0]!) as { ack: { catalog_revision: number } }).ack.catalog_revision,
  ).toBe(s.before.revision + 1);
  expect(readdirSync(join(db.root, 'blobs'))).not.toContain(s.orphan);
  expect(
    canonicalHash(unwrap<TechnicalState>(db.execute({ type: 'state' })).checkpoint),
  ).toHaveLength(64);
});

it('rebinds a pruned planning certificate only when its retained meaning and original backup match', async () => {
  const s = setup();
  const source = { schema_version: 1, task_id: 'task', council: f.council('planning') };
  const originalBytes = JSON.stringify(source);
  const previous = { locator: 'planning.json', hash: digest(originalBytes) };
  const original = { locator: join(db.parent, 'original-planning.json'), hash: previous.hash };
  writeFileSync(original.locator, originalBytes);
  const raw = s.before.checkpoint as unknown as { local_run: LocalRun };
  raw.local_run.spec.workspace = f.root;
  raw.local_run.spec.route = { kind: 'substantial', accepted_plan: previous };
  expect(
    db.mutate({ type: 'checkpoint', state: s.before.checkpoint, effects: [] }, s.before.revision)
      .ok,
  ).toBe(true);
  const certificate = {
    ...(retainEvidence(source) as Record<string, Json>),
    retained_source: previous,
  };
  const bytes = encodeChatArtifact(f.root, certificate, 'minimal');
  writeFileSync(join(f.root, 'planning.json'), bytes);
  const current = { locator: previous.locator, hash: digest(bytes) };
  const request = {
    ...s.request,
    expected_revision: s.before.revision + 1,
    planning: { previous, current, original },
  };
  expect(() =>
    retainStore(
      db.root,
      grant,
      {
        ...request,
        planning: { ...request.planning, current: { ...current, locator: 'other.json' } },
      },
      () => 1001,
    ),
  ).toThrow('invalid-context');
  expect(() =>
    retainStore(
      db.root,
      grant,
      {
        ...request,
        planning: { ...request.planning, current: { ...current, hash: 'a'.repeat(64) } },
      },
      () => 1001,
    ),
  ).toThrow('corrupt');
  const retained = retainStore(db.root, grant, request, () => 1001);
  const state = unwrap<TechnicalState>(db.execute({ type: 'state' }));
  expect((state.checkpoint as unknown as { local_run: LocalRun }).local_run.spec.route).toEqual({
    kind: 'substantial',
    accepted_plan: current,
  });
  expect(retained.ack.catalog_revision).toBe(request.expected_revision + 1);
  expect(digest(readFileSync(original.locator))).toBe(previous.hash);
});

it('removes orphaned fragments on subsequent checkpoints in a fresh minimal namespace', async () => {
  db.claim();
  const runs = new TaskLocalRuns(
    { execute: async (request) => db.store.execute(request) },
    grant.context,
    1,
  );
  await runs.save(null, f.executor);
  expect(unwrap<TechnicalState>(db.execute({ type: 'state' })).retention_gc).toBe(true);
  const orphan = new StoreFiles(db.root, noStorageProbe).publish('old unused state '.repeat(1000));
  const pending = '.pending-00000000-0000-0000-0000-000000000000';
  writeFileSync(join(db.root, 'blobs', pending), 'interrupted publication');
  const next = { ...f.executor, revision: f.executor.revision + 1 };
  await runs.save(f.executor, next);
  expect(existsSync(join(db.root, 'blobs', orphan))).toBe(false);
  expect(existsSync(join(db.root, 'blobs', pending))).toBe(false);
  expect(await runs.read()).toEqual(next);
});

it('cannot reintroduce legacy archived bodies through a checkpoint or release after maintenance', () => {
  const s = setup();
  retainStore(db.root, grant, s.request, () => 1001);
  const legacy = compactArchive(s.before.checkpoint);
  const revision = s.before.revision + 1;
  expect(
    db.mutate(
      {
        type: 'checkpoint',
        state: legacy.value,
        effects: [],
        blobs: legacy.blobs,
        archive_version: 1,
      },
      revision,
    ).ok,
  ).toBe(true);
  for (const blob of legacy.blobs) new StoreFiles(db.root, noStorageProbe).publish(blob.content);
  expect(
    db.mutate(
      { type: 'release', checkpoint: legacy.value, stopped_writers_receipt: 'stopped' },
      revision + 1,
    ).ok,
  ).toBe(true);
  const state = unwrap<TechnicalState>(db.execute({ type: 'state' }));
  expect(state.released).toBe(true);
  expect(state.checkpoint).toEqual(retainEvidence(s.before.checkpoint));
  const database = new StoreDatabase(db.root, grant.context, noStorageProbe);
  const events = database.db
    .prepare('SELECT body FROM events ORDER BY revision')
    .all()
    .map((row) => database.decode<EventRecord>(row['body'] as string));
  database.close();
  expect(events.at(-1)!.change).toMatchObject({
    type: 'release',
    checkpoint_hash: canonicalHash(state.checkpoint),
  });
  expect(events.at(-1)!.change).not.toHaveProperty('checkpoint');
});

it('allows a released namespace and removes fragments published by a failed first maintenance', () => {
  const s = setup();
  expect(
    db.mutate(
      { type: 'release', checkpoint: s.before.checkpoint, stopped_writers_receipt: 'stopped' },
      s.before.revision,
    ).ok,
  ).toBe(true);
  const request = { ...s.request, expected_revision: s.before.revision + 1 };
  let orphan = '';
  expect(() =>
    retainStore(
      db.root,
      grant,
      request,
      () => 999,
      (stage) => {
        if (stage === 'before-commit') {
          orphan = new StoreFiles(db.root, noStorageProbe).publish('new orphan');
          throw new Error('interrupted');
        }
      },
    ),
  ).toThrow('interrupted');
  const result = retainStore(db.root, grant, request, () => 999);
  expect(result.deleted_blobs).toBeGreaterThan(0);
  expect(existsSync(join(db.root, 'blobs', orphan))).toBe(false);
});
