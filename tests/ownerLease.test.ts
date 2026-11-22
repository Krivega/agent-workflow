import type { Change, TechnicalState, StoreRequest } from '../core/evidence.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { ProcessEvidenceStore } from '../adapters/storage/processEvidenceStore.js';
import { fixture, grant, signed } from './storageFixtures.js';
import {
  refreshChatLease,
  withActiveChatLease,
  saveChatArtifact,
} from '../cli/chatContinuation.js';

let f: ReturnType<typeof fixture>;
let now: number;
let store: SqliteEvidenceStore;
beforeEach(() => {
  f = fixture();
  f.claim();
  now = 2000;
  store = new SqliteEvidenceStore(f.root, grant, () => now);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  f.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function snapshot() {
  return unwrap<TechnicalState>(
    store.execute({ context: grant.context, command: { type: 'state' } }),
  );
}
function recovery(): Extract<Change, { type: 'recover-owner' }> {
  const state = snapshot();
  return {
    type: 'recover-owner',
    lease_until: 4000,
    proof: {
      owner: 'owner',
      generation: state.generation,
      revision: state.revision,
      checkpoint_hash: digest(canonical(state.checkpoint)),
      evidence: { locator: '/proof', hash: 'a'.repeat(64) },
    },
  };
}
it('keeps ordinary expired renew forbidden and recovers the same owner atomically with an idempotent receipt', () => {
  expect(store.execute(signed({ type: 'renew', lease_until: 4000 }, 1))).toMatchObject({
    ok: false,
    error: { code: 'stale-owner' },
  });
  const request = signed(recovery(), 1);
  const reply = store.execute(request);
  expect(reply).toMatchObject({ ok: true, value: { generation: 1, catalog_revision: 2 } });
  now = 5000;
  expect(store.execute(request)).toEqual(reply);
  expect(snapshot()).toMatchObject({ owner: 'owner', generation: 1, lease_until: 4000 });
});
it('recovers a lost acknowledgement after the owner restoration committed without another state change', () => {
  const request = signed(recovery(), 1);
  const failed = new SqliteEvidenceStore(
    f.root,
    grant,
    () => now,
    (boundary) => {
      if (boundary === 'after-commit') throw new Error('lost acknowledgement');
    },
  );
  expect(failed.execute(request)).toMatchObject({ ok: false, error: { code: 'unknown-outcome' } });
  expect(
    store.execute({ context: grant.context, command: { type: 'operation', operation_id: 'op-1' } }),
  ).toMatchObject({ ok: true, value: { status: 'confirmed' } });
  expect(store.execute(request)).toMatchObject({ ok: true });
  expect(snapshot()).toMatchObject({
    revision: 2,
    owner: 'owner',
    generation: 1,
    lease_until: 4000,
  });
});
it('allows only one of two real processes to restore the same expired owner revision', async () => {
  vi.restoreAllMocks();
  const change = { ...recovery(), lease_until: Date.now() + 60_000 };
  const first = new ProcessEvidenceStore(f.root, grant);
  const second = new ProcessEvidenceStore(f.root, grant);
  const replies = await Promise.all([
    first.execute(signed(change, 1, 1, 'recover-first')),
    second.execute(signed(change, 1, 1, 'recover-second')),
  ]);
  expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
  expect(replies.find((reply) => !reply.ok)).toMatchObject({
    error: { code: 'revision-conflict' },
  });
  expect(snapshot()).toMatchObject({ owner: 'owner', generation: 1, revision: 2 });
});
it.each([
  'owner',
  'generation',
  'revision',
  'checkpoint',
  'locator',
  'hash',
  'deadline',
  'missing-proof',
])('rejects invalid recovery proof: %s', (field) => {
  const change = recovery();
  switch (field) {
    case 'owner':
      change.proof.owner = 'other';
      break;
    case 'generation':
      change.proof.generation++;
      break;
    case 'revision':
      change.proof.revision++;
      break;
    case 'checkpoint':
      change.proof.checkpoint_hash = 'changed';
      break;
    case 'locator':
      change.proof.evidence.locator = '';
      break;
    case 'hash':
      change.proof.evidence.hash = 'wrong';
      break;
    case 'deadline':
      change.lease_until = now;
      break;
    case 'missing-proof':
      Reflect.deleteProperty(change, 'proof');
      break;
  }
  expect(store.execute(signed(change, 1))).toMatchObject({
    ok: false,
    error: { code: 'invalid-context' },
  });
  expect(snapshot().revision).toBe(1);
});
it('rejects an unexpired recovery, stale CAS, another actor, readonly and a changed replay payload', () => {
  now = 500;
  const change = recovery();
  expect(store.execute(signed(change, 1))).toMatchObject({ ok: false });
  now = 2000;
  expect(store.execute(signed(change, 0))).toMatchObject({
    ok: false,
    error: { code: 'revision-conflict' },
  });
  const other = { ...grant, context: { ...grant.context, actor_id: 'other' } };
  expect(
    new SqliteEvidenceStore(f.root, other, () => now).execute(signed(change, 1, 1, 'other', other)),
  ).toMatchObject({ ok: false, error: { code: 'stale-owner' } });
  expect(
    new SqliteEvidenceStore(f.root, { ...grant, permissions: ['read'] }, () => now).execute(
      signed(change, 1),
    ),
  ).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  expect(store.execute(signed(change, 1))).toMatchObject({ ok: true });
  change.lease_until++;
  expect(store.execute(signed(change, 1))).toMatchObject({
    ok: false,
    error: { code: 'revision-conflict' },
  });
});
it.each(['pending', 'unknown', 'confirmed', 'not-started'] as const)(
  'checks persisted effect outcome %s before restoring a lease',
  (outcome) => {
    now = 500;
    expect(
      store.execute(
        signed(
          {
            type: 'checkpoint',
            state: { retained: true },
            effects: [{ id: 'effect', intent: {} }],
          },
          1,
        ),
      ).ok,
    ).toBe(true);
    if (outcome !== 'pending')
      expect(
        store.execute(signed({ type: 'effect', id: 'effect', outcome, receipt: {} }, 2)).ok,
      ).toBe(true);
    now = 2000;
    expect(store.execute(signed(recovery(), snapshot().revision)).ok).toBe(
      outcome === 'confirmed' || outcome === 'not-started',
    );
  },
);
it('does not recover frozen or released ownership', () => {
  now = 500;
  expect(store.execute(signed({ type: 'freeze' }, 1)).ok).toBe(true);
  now = 2000;
  expect(store.execute(signed(recovery(), 2)).ok).toBe(false);
  expect(store.execute(signed({ type: 'thaw' }, 2)).ok).toBe(true);
  expect(
    store.execute(signed({ type: 'release', checkpoint: {}, stopped_writers_receipt: 'proof' }, 3))
      .ok,
  ).toBe(true);
  expect(store.execute(signed(recovery(), 4)).ok).toBe(false);
});
it('renews active work without a model call and requires recovery proof after expiry', () => {
  now = 500;
  refreshChatLease(store);
  expect(snapshot().lease_until).toBe(now + 30 * 60_000);
  const revision = snapshot().revision;
  refreshChatLease(store);
  expect(snapshot().revision).toBe(revision);
  now = snapshot().lease_until + 1;
  expect(() => refreshChatLease(store)).toThrow('chat-lease-recovery-required');
  const evidence = { locator: '/proof', hash: 'a'.repeat(64) };
  expect(() =>
    refreshChatLease(store, { evidence, expected_revision: snapshot().revision - 1 }),
  ).toThrow('chat-owner-recovery-conflict');
  refreshChatLease(store, { evidence, expected_revision: snapshot().revision });
  expect(snapshot()).toMatchObject({ owner: 'owner', generation: 1 });
});
it('renews one minute before expiry while retaining a longer live lease', () => {
  now = 500;
  refreshChatLease(store);
  const initial = snapshot();
  now = initial.lease_until - 60_001;
  refreshChatLease(store);
  expect(snapshot().revision).toBe(initial.revision);
  now += 1;
  refreshChatLease(store);
  expect(snapshot()).toMatchObject({
    owner: initial.owner,
    generation: initial.generation,
    lease_until: now + 30 * 60_000,
  });
});
it('rejects a malformed evidence locator in a recovery request', () => {
  const request: StoreRequest = signed(recovery(), 1);
  if (request.command.type !== 'mutate' || request.command.change.type !== 'recover-owner')
    throw new Error('fixture');
  Reflect.deleteProperty(request.command.change.proof, 'evidence');
  // Rebuild the payload hash after deliberately removing an untrusted JSON field.
  expect(store.execute(signed(request.command.change, 1)).ok).toBe(false);
});
it('maintains a running process lease and surfaces a failed boundary check without repeating the action', async () => {
  vi.useFakeTimers();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  now = 500;
  const action = vi.fn(
    () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 6000)),
  );
  const pending = withActiveChatLease(store, () => {}, action);
  await vi.advanceTimersByTimeAsync(6000);
  expect(await pending).toBe('done');
  expect(snapshot().lease_until).toBe(now + 30 * 60_000);
  const failed = withActiveChatLease(
    store,
    () => {
      throw new Error('boundary changed');
    },
    action,
  );
  const rejection = expect(failed).rejects.toThrow('boundary changed');
  await vi.advanceTimersByTimeAsync(6000);
  await rejection;
  expect(action).toHaveBeenCalledTimes(1);
});
it('rejects an expired initial lease and a heartbeat failure before reporting a completed action', async () => {
  now = 2000;
  const action = vi.fn(async () => 'unreachable');
  await expect(withActiveChatLease(store, () => {}, action)).rejects.toThrow(
    'chat-lease-recovery-required',
  );
  expect(action).not.toHaveBeenCalled();
  now = 500;
  vi.useFakeTimers();
  let permitted = true;
  const running = withActiveChatLease(
    store,
    () => {
      if (!permitted) throw new Error('boundary changed');
    },
    () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 6000)),
  );
  const rejected = expect(running).rejects.toThrow('boundary changed');
  permitted = false;
  await vi.advanceTimersByTimeAsync(6000);
  await rejected;
});
it('stores immutable full artifacts and rejects a conflicting preexisting artifact', async () => {
  const ref = saveChatArtifact(f.parent, 'result', { detail: 'proof' });
  expect(saveChatArtifact(f.parent, 'result', { detail: 'proof' })).toEqual(ref);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(ref.locator, 'wrong');
  expect(() => saveChatArtifact(f.parent, 'result', { detail: 'proof' })).toThrow(
    'chat-artifact-conflict',
  );
  expect(() => saveChatArtifact('/missing/parent', 'result', {})).toThrow('ENOENT');
});

it('keeps one owner through three simulated hours and fences later effects after a failed heartbeat', async () => {
  vi.useFakeTimers();
  now = 500;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  refreshChatLease(store);
  const initial = snapshot();
  let complete!: () => void;
  let boundary!: () => void;
  let permitted = true;
  const task = withActiveChatLease(
    store,
    () => {
      if (!permitted) throw new Error('owner revoked');
    },
    async (verify) => {
      boundary = verify;
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      verify();
    },
  );
  const rejection = expect(task).rejects.toThrow('owner revoked');
  for (let step = 0; step < 7; step++) {
    now += 29 * 60_000 + 50_000;
    await vi.advanceTimersByTimeAsync(5000);
    boundary();
    expect(snapshot()).toMatchObject({ owner: initial.owner, generation: initial.generation });
    expect(snapshot().lease_until).toBeGreaterThan(now);
  }
  permitted = false;
  await vi.advanceTimersByTimeAsync(5000);
  permitted = true;
  expect(boundary).toThrow('owner revoked');
  complete();
  await rejection;
});
