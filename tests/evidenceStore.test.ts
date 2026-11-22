import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  compareInputs,
  type CatalogPage,
  type FinalizationManifest,
  type StoredEvidence,
  type TechnicalState,
  type WriteAck,
} from '../core/evidence.js';
import { canonical, digest, failure, requestHash } from '../adapters/storage/storeCodec.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { StoreDatabase } from '../adapters/storage/storeDatabase.js';
import { body, fixture, grant, signed } from './storageFixtures.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.dispose();
});
const code = (value: unknown, expected: string) =>
  expect(value).toMatchObject({ ok: false, error: { code: expected } });

it('commits and replays a large logical checkpoint within a bounded heap with exact hashes', () => {
  const program = `
    import assert from 'node:assert/strict';
    import { fixture } from ${JSON.stringify(new URL('./storageFixtures.ts', import.meta.url).href)};
    import { canonicalHash } from ${JSON.stringify(new URL('../adapters/storage/storeCodec.ts', import.meta.url).href)};
    const f = fixture();
    try {
      f.claim();
      const change = {
        type: 'checkpoint',
        state: { source: Array(40_000).fill('payload '.repeat(1000)) },
        effects: [],
      };
      const reply = f.mutate(change, 1);
      assert(reply.ok);
      assert.equal(reply.value.content_hash, canonicalHash(change));
      assert.deepEqual(f.mutate(change, 1), reply);
      assert.deepEqual(f.execute({ type: 'operation', operation_id: 'op-1' }), {
        ok: true, value: { status: 'confirmed', ack: reply.value },
      });
      const state = f.execute({ type: 'state' });
      assert(state.ok);
      assert.equal(state.value.revision, 2);
      assert.equal(state.value.checkpoint.source.length, 40_000);
      assert(state.value.checkpoint.source.every(value => value === change.state.source[0]));
      console.log('PASS');
    } finally {
      f.dispose();
    }
  `;
  expect(
    execFileSync(
      process.execPath,
      ['--max-old-space-size=128', '--import', 'tsx', '--input-type=module', '--eval', program],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000 },
    ).trim(),
  ).toBe('PASS');
}, 20_000);

it('keeps immutable exact revisions, independent heads and body-free idempotent receipts', () => {
  expect(f.claim()).toMatchObject({ generation: 1, catalog_revision: 1 });
  const request = signed({ type: 'write', id: 'failure', body }, 1);
  const ack = unwrap<WriteAck>(f.store.execute(request));
  expect(ack).toMatchObject({
    revision: 1,
    catalog_revision: 2,
    content_hash: digest(canonical(body)),
  });
  expect(canonical(ack)).not.toContain(body.raw.output);
  expect(f.store.execute(request)).toEqual({ ok: true, value: ack });
  expect(f.execute({ type: 'operation', operation_id: 'op-1' })).toEqual({
    ok: true,
    value: { status: 'confirmed', ack },
  });
  expect(f.execute({ type: 'operation', operation_id: 'missing' })).toEqual({
    ok: true,
    value: { status: 'not-started' },
  });
  const nextBody = { ...body, result: 'PASS' as const, exit_code: 0 };
  expect(
    f.mutate(
      { type: 'supersede', id: 'failure', expected_head: 1, reason: 'fixed', body: nextBody },
      2,
    ).ok,
  ).toBe(true);
  const exact = unwrap<StoredEvidence>(f.execute({ type: 'read', id: 'failure', revision: 1 }));
  expect(exact).toMatchObject({
    body,
    predecessor: null,
    successor: 2,
    metadata: { revision: 1, head_revision: 2 },
  });
  expect(readFileSync(exact.raw_locator, 'utf8')).toBe(canonical(body.raw));
  const head = unwrap<StoredEvidence>(f.execute({ type: 'read', id: 'failure', revision: null }));
  expect(head).toMatchObject({
    body: nextBody,
    predecessor: 1,
    successor: null,
    metadata: { reason: 'fixed', revision: 2 },
  });
  code(f.execute({ type: 'read', id: 'failure', revision: 3 }), 'not-found');
  code(f.execute({ type: 'read', id: 'missing', revision: null }), 'not-found');
  code(f.store.execute(signed({ type: 'write', id: 'other', body }, 1)), 'revision-conflict');
  code(f.mutate({ type: 'write', id: 'failure', body }, 3), 'revision-conflict');
  code(
    f.mutate({ type: 'supersede', id: 'failure', expected_head: 1, reason: 'race', body }, 3),
    'revision-conflict',
  );
  code(
    f.mutate({ type: 'supersede', id: 'failure', expected_head: 2, reason: '', body }, 3),
    'invalid-context',
  );
});

it('rejects mismatched context and permissions before opening files or inspecting a body', () => {
  const missing = new SqliteEvidenceStore('/not/a/store', grant, () => 100);
  code(
    missing.execute({
      context: { ...grant.context, task_id: 'other' },
      command: { type: 'read', id: 'secret', revision: null },
    }),
    'invalid-context',
  );
  code(
    missing.execute({
      context: { ...grant.context, schema_version: 'future' },
      command: { type: 'state' },
    }),
    'unsupported-version',
  );
  const reader = new SqliteEvidenceStore(f.root, { ...grant, permissions: ['read'] }, () => 100);
  code(reader.execute(signed({ type: 'write', id: 'no', body }, 0)), 'permission-denied');
  for (const context of [
    { ...grant.context, actor_id: '' },
    { ...grant.context, task_id: '' },
    { ...grant.context, project_id: '' },
    { ...grant.context, run_id: 42 },
    { ...grant.context, subtask_id: 42 },
  ]) {
    const invalid = context as typeof grant.context;
    code(
      new SqliteEvidenceStore(f.root, { ...grant, context: invalid }, () => 100).execute({
        context: invalid,
        command: { type: 'state' },
      }),
      'invalid-context',
    );
  }
  const stranger = { ...grant, context: { ...grant.context, project_id: 'different' } };
  code(
    new SqliteEvidenceStore(f.root, stranger, () => 100).execute({
      context: stranger.context,
      command: { type: 'state' },
    }),
    'invalid-context',
  );
});

it('fences late owners and expiry, preserves checkpoints/effects, and requires release before adoption', () => {
  f.claim();
  code(f.mutate({ type: 'claim', lease_until: 2000 }, 1), 'stale-owner');
  code(f.mutate({ type: 'renew', lease_until: 100 }, 1), 'invalid-context');
  expect(f.mutate({ type: 'renew', lease_until: 2000 }, 1).ok).toBe(true);
  code(f.mutate({ type: 'checkpoint', state: 'late', effects: [] }, 2, 0), 'stale-owner');
  const expired = new SqliteEvidenceStore(f.root, grant, () => 2000);
  code(expired.execute(signed({ type: 'write', id: 'late', body }, 2)), 'stale-owner');
  const badClock = new SqliteEvidenceStore(f.root, grant, () => NaN);
  code(badClock.execute(signed({ type: 'freeze' }, 2)), 'invalid-context');
  expect(
    f.mutate(
      {
        type: 'checkpoint',
        state: { elapsed: 42, failures: ['FAIL'] },
        effects: [{ id: 'create', intent: { native_project: 'project' } }],
      },
      2,
    ).ok,
  ).toBe(true);
  code(
    f.mutate(
      { type: 'checkpoint', state: 'rollback', effects: [{ id: 'create', intent: null }] },
      3,
    ),
    'revision-conflict',
  );
  code(
    f.mutate({ type: 'effect', id: 'absent', outcome: 'unknown', receipt: null }, 3),
    'not-found',
  );
  code(
    f.mutate({ type: 'effect', id: 'create', outcome: 'confirmed', receipt: null }, 3),
    'invalid-context',
  );
  expect(f.mutate({ type: 'effect', id: 'create', outcome: 'unknown', receipt: null }, 3).ok).toBe(
    true,
  );
  expect(
    f.mutate(
      { type: 'effect', id: 'create', outcome: 'confirmed', receipt: { identity: 'thread' } },
      4,
    ).ok,
  ).toBe(true);
  code(
    f.mutate({ type: 'effect', id: 'create', outcome: 'not-started', receipt: 'no' }, 5),
    'revision-conflict',
  );
  code(
    f.mutate({ type: 'release', stopped_writers_receipt: '', checkpoint: 'saved' }, 5),
    'invalid-context',
  );
  code(
    f.mutate({ type: 'release', stopped_writers_receipt: 'stopped', checkpoint: null }, 5),
    'invalid-context',
  );
  expect(
    f.mutate(
      { type: 'release', stopped_writers_receipt: 'pid-exit', checkpoint: { elapsed: 42 } },
      5,
    ).ok,
  ).toBe(true);
  code(f.mutate({ type: 'write', id: 'late', body }, 6), 'stale-owner');
  const successor = {
    ...grant,
    context: { ...grant.context, actor_id: 'successor', run_id: 'next', subtask_id: 'child' },
  };
  const next = new SqliteEvidenceStore(f.root, successor, () => 100);
  expect(
    next.execute(signed({ type: 'claim', lease_until: 2000 }, 6, 1, 'adoption', successor)),
  ).toMatchObject({ ok: true, value: { generation: 2 } });
  code(f.mutate({ type: 'write', id: 'late', body }, 7, 2), 'stale-owner');
  expect(unwrap<TechnicalState>(f.execute({ type: 'state' }))).toMatchObject({
    owner: 'successor',
    generation: 2,
    checkpoint: { elapsed: 42 },
  });
});

it('catalogs metadata only, tracks coverage and invalidates stale or altered cursors', () => {
  f.claim();
  f.mutate({ type: 'write', id: 'a', body }, 1);
  f.mutate({ type: 'write', id: 'b', body }, 2);
  const command = { type: 'catalog' as const, query: '', cursor: null, limit: 1, byte_limit: 2000 };
  const page = unwrap<CatalogPage>(f.execute(command));
  expect(page).toMatchObject({
    coverage: 'partial',
    items: [{ id: 'a' }],
    next_cursor: { revision: 3, offset: 1 },
  });
  expect(canonical(page)).not.toContain('failure\n');
  expect(f.execute({ ...command, cursor: page.next_cursor })).toMatchObject({
    ok: true,
    value: { coverage: 'complete', items: [{ id: 'b' }], next_cursor: null },
  });
  expect(f.execute({ ...command, query: 'absent' })).toMatchObject({
    ok: true,
    value: { coverage: 'complete', items: [] },
  });
  code(f.execute({ ...command, byte_limit: 1 }), 'budget-exhausted');
  code(f.execute({ ...command, limit: 0 }), 'invalid-context');
  code(
    f.execute({ ...command, cursor: { revision: 3, offset: -1, query: '' } }),
    'invalid-context',
  );
  code(
    f.execute({ ...command, cursor: { revision: 3, offset: 20, query: '' } }),
    'invalid-context',
  );
  code(f.execute({ ...command, cursor: page.next_cursor, query: 'changed' }), 'invalid-context');
  f.mutate({ type: 'write', id: 'c', body }, 3);
  code(f.execute({ ...command, cursor: page.next_cursor }), 'revision-conflict');
});

it('keeps FAIL and provenance while recording resolutions and content-based reuse separately', () => {
  f.claim();
  f.mutate({ type: 'write', id: 'failure', body }, 1);
  f.mutate({ type: 'write', id: 'proof', body: { ...body, result: 'PASS' } }, 2);
  code(
    f.mutate(
      {
        type: 'resolve',
        id: 'failure',
        expected_head: 1,
        condition: '',
        disposition: 'fixed',
        supporting_id: 'proof',
        supporting_revision: 1,
      },
      3,
    ),
    'invalid-context',
  );
  expect(
    f.mutate(
      {
        type: 'resolve',
        id: 'failure',
        expected_head: 1,
        condition: 'test passes',
        disposition: 'fixed',
        supporting_id: 'proof',
        supporting_revision: 1,
      },
      3,
    ).ok,
  ).toBe(true);
  expect(
    f.mutate(
      {
        type: 'reuse',
        id: 'proof',
        revision: 1,
        target_scope: 'new-task',
        manifest: body.manifest,
      },
      4,
    ).ok,
  ).toBe(true);
  code(f.execute({ type: 'finalization', expected_revision: 5 }), 'revision-conflict');
  f.mutate({ type: 'freeze' }, 5);
  code(f.mutate({ type: 'write', id: 'late', body }, 6), 'revision-conflict');
  const manifest = unwrap<FinalizationManifest>(
    f.execute({ type: 'finalization', expected_revision: 6 }),
  );
  expect(manifest.entries.find((item) => item.id === 'failure')?.result).toBe('FAIL');
  expect(manifest.events[4]?.change).toMatchObject({ type: 'reuse', applicability: 'applicable' });
  expect(manifest.blobs).toHaveLength(3);
  expect(manifest.operations).toHaveLength(6);
  expect(f.mutate({ type: 'thaw' }, 6).ok).toBe(true);
  const source = body.manifest;
  expect(compareInputs(source, { ...source, complete: false })).toBe('unknown');
  expect(compareInputs({ ...source, complete: false }, source)).toBe('unknown');
  expect(compareInputs({ ...source, attested_by: '' }, source)).toBe('unknown');
  expect(compareInputs(source, { ...source, attested_by: '' })).toBe('unknown');
  expect(compareInputs(source, { ...source, discovery_rule: 'other' })).toBe('changed');
  expect(compareInputs(source, { ...source, inputs: [] })).toBe('changed');
  expect(
    unwrap<StoredEvidence>(f.execute({ type: 'read', id: 'failure', revision: 1 })).body.provenance,
  ).toEqual(body.provenance);
});

it('rejects malformed data, hashes, unsupported schemas and corruption without a success Ack', () => {
  f.claim();
  const valid = signed({ type: 'write', id: 'e', body }, 1);
  if (valid.command.type === 'mutate') valid.command.mutation.payload_hash = 'wrong';
  code(f.store.execute(valid), 'invalid-context');
  const invalidBodies = [
    { ...body, kind: '' },
    { ...body, scope: '' },
    { ...body, criterion: '' },
    { ...body, result: 'invalid' },
    { ...body, summary: null },
    { ...body, command: null },
    { ...body, exit_code: 1.5 },
    { ...body, links: [1] },
    { ...body, limitations: [1] },
    { ...body, raw: { input: null, output: '' } },
    { ...body, raw: { input: '', output: null } },
    { ...body, provenance: { ...body.provenance, head: 5 } },
    {
      ...body,
      manifest: { ...body.manifest, inputs: [...body.manifest.inputs, ...body.manifest.inputs] },
    },
    { ...body, manifest: { ...body.manifest, inputs: [{ locator: 'x', hash: 'no' }] } },
    { ...body, manifest: { ...body.manifest, discovery_rule: '' } },
  ];
  for (const invalid of invalidBodies)
    code(f.mutate({ type: 'write', id: 'e', body: invalid as typeof body }, 1), 'invalid-context');
  code(f.mutate({ type: 'write', id: '', body }, 1), 'invalid-context');
  f.mutate({ type: 'write', id: 'e', body }, 1);
  const record = unwrap<StoredEvidence>(f.execute({ type: 'read', id: 'e', revision: null }));
  writeFileSync(record.raw_locator, 'damaged');
  code(f.execute({ type: 'read', id: 'e', revision: null }), 'corrupt');
  const db = new DatabaseSync(join(f.root, 'store.sqlite'));
  db.exec('PRAGMA user_version=99');
  db.close();
  code(f.execute({ type: 'state' }), 'unsupported-version');
  expect(() => canonical(undefined)).toThrow('invalid-context');
  expect(() => canonical(Infinity)).toThrow('invalid-context');
  expect(failure(null, valid, 'root')).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(failure('disk', valid, 'root')).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  expect(requestHash({ context: grant.context, command: { type: 'state' } })).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(failure(new Error('disk'), valid, 'root')).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  expect(() => unwrap(failure(new Error('disk'), valid, 'root'))).toThrow('unavailable');
});

it('validates malformed wire requests before storage and permits explicit release after lease expiry', () => {
  for (const request of [
    null,
    {},
    { context: grant.context },
    { context: grant.context, command: { type: 'future' } },
    { context: grant.context, command: { type: 'mutate' } },
  ]) {
    code(f.store.execute(request as Parameters<typeof f.store.execute>[0]), 'invalid-context');
  }
  f.claim();
  const expired = new SqliteEvidenceStore(f.root, grant, () => 1000);
  expect(
    expired.execute(
      signed(
        { type: 'release', stopped_writers_receipt: 'exit-receipt', checkpoint: 'preserved' },
        1,
      ),
    ).ok,
  ).toBe(true);
  expect(expired.execute(signed({ type: 'claim', lease_until: 2000 }, 2)).ok).toBe(true);
});

it('detects database integrity problems and rolls back failed transactions', () => {
  const db = new StoreDatabase(f.root, grant.context, () => {});
  db.check();
  expect(() =>
    db.transaction(true, () => {
      db.save({ ...db.state(), revision: 99 });
      throw new Error('abort');
    }),
  ).toThrow('abort');
  expect(db.state().revision).toBe(0);
  db.close();
});
