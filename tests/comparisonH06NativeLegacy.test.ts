import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { exportStore } from '../adapters/storage/storeBackup.js';
import { initializeStore, StoreDatabase } from '../adapters/storage/storeDatabase.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { noStorageProbe } from '../adapters/storage/storeFiles.js';
import type { Change, TechnicalState } from '../core/evidence.js';
import type { H04Pin } from './comparisonH04Contract.js';
import type { H06NativeFailureBinding } from './comparisonH06NativeFailure.js';
import { checkH06NativeLegacyCrossing, runH06NativeLegacy } from './comparisonH06NativeLegacy.js';
import { grant, signed } from './storageFixtures.js';

vi.mock('./comparisonH06Native.js', () => ({
  async startH06NativeVariant<T>(
    _binding: unknown,
    evidence: string,
    run: (failure: H04Pin) => Promise<T>,
  ) {
    const path = join(evidence, 'f01', 'receipt.json'),
      bytes = readFileSync(path);
    const initialFailure = { path, sha256: digest(bytes) };
    return { initialFailure, writer: await run(initialFailure) };
  },
}));
vi.mock('./comparisonH06NativeFailure.js', () => ({
  checkH06NativeFailure: (_binding: unknown, pin: H04Pin) => pin,
}));

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(100000);
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-lease-observer-'));
  roots.push(root);
  const evidence = join(root, 'evidence'),
    workspace = join(root, 'workspace');
  mkdirSync(evidence);
  mkdirSync(workspace);
  mkdirSync(join(evidence, 'f01'));
  writeFileSync(join(evidence, 'f01', 'receipt.json'), '{}');
  const binding: H06NativeFailureBinding = {
    operationId: grant.context.task_id,
    variant: 'legacy',
    workspaceRoot: workspace,
    node: { path: '/pinned/node', sha256: 'a'.repeat(64) },
    timeoutMs: 1000,
  };
  const storeRoot = join(evidence, 'store'),
    oldDeadline = 110000,
    workDeadline = 160000;
  initializeStore(storeRoot, grant.context);
  const store = new SqliteEvidenceStore(storeRoot, grant, Date.now);
  unwrap(store.execute(signed({ type: 'claim', lease_until: oldDeadline }, 0, 0, 'initial-owner')));
  const state = () =>
    unwrap<TechnicalState>(
      store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    );
  const mutate = (change: Change) => {
    const current = state();
    return unwrap(store.execute(signed(change, current.revision, current.generation)));
  };
  const corrupt = (change: Partial<TechnicalState>) => {
    const current = state(),
      database = new StoreDatabase(store.root, grant.context, noStorageProbe);
    try {
      database.db
        .prepare('UPDATE state SET body=? WHERE singleton=1')
        .run(database.encode({ ...current, ...change }));
    } finally {
      database.close();
    }
  };
  const finish = () => vi.advanceTimersByTimeAsync(11001);
  const run = <T>(stage: (verify: () => void, failure: H04Pin) => Promise<T>) =>
    runH06NativeLegacy(binding, evidence, store, oldDeadline, workDeadline, stage);
  return {
    root,
    evidence,
    binding,
    store,
    oldDeadline,
    workDeadline,
    state,
    mutate,
    corrupt,
    finish,
    run,
  };
}

it('survives a real frozen backup across the lease timer and accepts the thawed action boundary', async () => {
  const f = fixture();
  const result = await f.run(async (verify) => {
    f.mutate({ type: 'freeze' });
    expect(f.state().frozen).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.state().frozen).toBe(true);
    const backup = await exportStore(f.store.root, join(f.root, 'backup'), grant);
    expect(backup.revision).toBe(f.state().revision);
    f.mutate({ type: 'thaw' });
    verify();
    await vi.advanceTimersByTimeAsync(6001);
    verify();
    return 'completed-after-backup';
  });
  expect(result.writer.result).toBe('completed-after-backup');
  expect(f.state()).toMatchObject({
    owner: grant.context.actor_id,
    generation: 1,
    frozen: false,
    released: false,
  });
  expect(
    checkH06NativeLegacyCrossing(
      f.binding,
      result.writer.renewal,
      result.writer.crossing,
      0.000001,
    ),
  ).toMatchObject({ status: 'LEASE_CROSSING_VERIFIED', qualification: false });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['initial', 'explicit action', 'after stage'] as const)(
  'rejects a frozen Store at the %s boundary',
  async (boundary) => {
    const f = fixture(),
      stage = vi.fn(async (verify: () => void) => {
        f.mutate({ type: 'freeze' });
        if (boundary === 'explicit action') verify();
        await f.finish();
        return 'unsafe';
      });
    if (boundary === 'initial') f.mutate({ type: 'freeze' });
    await expect(f.run(stage)).rejects.toThrow('h06-legacy-owner');
    if (boundary === 'initial') expect(stage).not.toHaveBeenCalled();
    expect(existsSync(join(f.evidence, 'legacy-crossing.json'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  ['foreign owner', { owner: 'another-owner' }],
  ['another generation', { generation: 2 }],
  ['released owner', { released: true }],
  ['expired lease', { lease_until: 100000 }],
] as const)('keeps %s forbidden at the explicit action boundary', async (_name, change) => {
  const f = fixture();
  await expect(
    f.run(async (verify) => {
      f.corrupt(change);
      verify();
    }),
  ).rejects.toThrow('h06-legacy-owner');
  expect(existsSync(join(f.evidence, 'legacy-crossing.json'))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the work deadline enforced in a stage action even with a valid renewed lease', async () => {
  const f = fixture();
  await expect(
    f.run(async (verify) => {
      vi.setSystemTime(f.workDeadline);
      verify();
    }),
  ).rejects.toThrow('h06-legacy-owner');
  expect(vi.getTimerCount()).toBe(0);
});

it('retains an identity observer failure after the runtime file is restored', async () => {
  const f = fixture();
  await expect(
    f.run(async (verify) => {
      const path = join(f.store.root, 'chat-runtime.json'),
        original = readFileSync(path);
      writeFileSync(path, '{}');
      await vi.advanceTimersByTimeAsync(5000);
      writeFileSync(path, original);
      verify();
    }),
  ).rejects.toThrow('chat-runtime-binding-changed');
  expect(existsSync(join(f.evidence, 'legacy-crossing.json'))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not save crossing evidence when the stage throws and clears the observer', async () => {
  const f = fixture();
  await expect(
    f.run(async () => {
      throw new Error('stage-failed');
    }),
  ).rejects.toThrow('stage-failed');
  expect(existsSync(join(f.evidence, 'legacy-renew.json'))).toBe(true);
  expect(existsSync(join(f.evidence, 'legacy-crossing.json'))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('requires an actual crossing of the original lease deadline', async () => {
  const f = fixture();
  await expect(f.run(async () => 'too-early')).rejects.toThrow('h06-legacy-stage-not-crossed');
});

it('refuses an inconsistent initial owner or original lease', async () => {
  const f = fixture(),
    stage = vi.fn(async () => 'unexpected');
  f.corrupt({ lease_until: f.oldDeadline + 1 });
  await expect(f.run(stage)).rejects.toThrow('h06-legacy-old-deadline');
  expect(stage).not.toHaveBeenCalled();
});

it('refuses non-Legacy binding before starting a lease or stage', async () => {
  const f = fixture(),
    stage = vi.fn(async () => 'unexpected');
  f.binding.variant = 'temporal';
  await expect(f.run(stage)).rejects.toThrow('h06-legacy-start-binding');
  expect(stage).not.toHaveBeenCalled();
});

it.each(['kind', 'owner', 'renewal', 'time'] as const)(
  'retained crossing still rejects changed %s evidence',
  async (part) => {
    const f = fixture(),
      result = await f.run(async () => {
        await f.finish();
        return 'done';
      });
    const renewal = JSON.parse(readFileSync(result.writer.renewal.path, 'utf8')) as Record<
      string,
      unknown
    >;
    const crossing = JSON.parse(readFileSync(result.writer.crossing.path, 'utf8')) as Record<
      string,
      unknown
    >;
    if (part === 'kind') crossing.kind = 'another-crossing';
    if (part === 'owner') (crossing.after as Record<string, unknown>).owner = 'another-owner';
    if (part === 'renewal') renewal.hash = 'b'.repeat(64);
    if (part === 'time') crossing.elapsedMs = 0;
    const repin = (pin: H04Pin, value: unknown) => {
      const bytes = canonical(value);
      writeFileSync(pin.path, bytes);
      return { path: pin.path, sha256: digest(bytes) };
    };
    const renewalPin = repin(result.writer.renewal, renewal);
    crossing.renewal = renewalPin;
    expect(() =>
      checkH06NativeLegacyCrossing(
        f.binding,
        renewalPin,
        repin(result.writer.crossing, crossing),
        0.000001,
      ),
    ).toThrow(
      'h06-legacy-crossing-' + (part === 'kind' ? 'binding' : part === 'renewal' ? 'renew' : part),
    );
  },
);
