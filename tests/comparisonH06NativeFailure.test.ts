import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../src/adapters/artifacts/files.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import { startH06NativeVariant } from './comparisonH06Native.js';
import { checkH06NativeLegacyCrossing, runH06NativeLegacy } from './comparisonH06NativeLegacy.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { grant, signed } from './storageFixtures.js';
import {
  checkH06NativeFailure,
  observeH06NativeFailure,
  type H06NativeFailureBinding,
} from './comparisonH06NativeFailure.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-f01-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot);
  const cases = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  for (const [name, bytes] of Object.entries(cases.cases.find(({ id }) => id === 'H-06')!.files))
    writeFileSync(join(workspaceRoot, name), bytes);
  const binding: H06NativeFailureBinding = {
    operationId: 'h06-native-test',
    variant: 'temporal',
    workspaceRoot,
    node: { path: join(root, 'pinned-node'), sha256: digest('node-binary') },
    timeoutMs: 30000,
  };
  const before = observeH06NativeFailure(workspaceRoot);
  const receipt = {
    kind: 'h06-native-f01',
    binding: { ...binding },
    before,
    after: before,
    outcome: {
      command: {
        executable: binding.node.path,
        sha256: binding.node.sha256,
        args: ['checks.mjs'],
        timeoutMs: binding.timeoutMs,
      },
      code: 1,
      signal: null,
      error: null,
      elapsedMs: 30,
      stop: { confirmed: true, processes: [{ pid: 100, parent: 1, started: 'fixture-start' }] },
      log: `Error: ENOENT: no such file or directory, open '${before.missingManifest}'\n`,
    },
  };
  function pin() {
    const path = join(root, 'receipt.json');
    const bytes = JSON.stringify(receipt);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  }
  return { root, workspaceRoot, binding, before, receipt, pin };
}

it.each(['legacy', 'temporal'] as const)('reads pinned primary F-01 evidence for %s', (variant) => {
  const f = fixture();
  f.binding.variant = variant;
  f.receipt.binding.variant = variant;
  // The preserved before/after observation is independent of later authorized workspace changes.
  mkdirSync(join(f.workspaceRoot, 'evidence'));
  writeFileSync(f.before.missingManifest, '{}');
  const pin = f.pin();
  expect(checkH06NativeFailure(f.binding, pin)).toEqual(pin);
});

it('rejects a preserved receipt if a frozen assignment file changes afterward', () => {
  const f = fixture();
  const pin = f.pin();
  writeFileSync(join(f.workspaceRoot, 'checks.mjs'), 'process.exit(0)');
  expect(() => checkH06NativeFailure(f.binding, pin)).toThrow('h06-f01-material');
});

it('allows an empty physical evidence directory at observation time', () => {
  const f = fixture();
  mkdirSync(join(f.workspaceRoot, 'evidence'));
  expect(observeH06NativeFailure(f.workspaceRoot)).toEqual(f.before);
});

it.each(['alias', 'file', 'material', 'manifest', 'manifest-alias', 'evidence-alias'] as const)(
  'rejects unsafe initial workspace evidence (%s)',
  (which) => {
    const f = fixture();
    let workspace = f.workspaceRoot;
    if (which === 'alias') {
      workspace = join(f.root, 'alias');
      symlinkSync(f.workspaceRoot, workspace);
    }
    if (which === 'file') {
      workspace = join(f.root, 'file');
      writeFileSync(workspace, '');
    }
    if (which === 'material') writeFileSync(join(workspace, 'checks.mjs'), 'process.exit(1)');
    if (which === 'evidence-alias')
      symlinkSync(join(f.root, 'missing'), join(workspace, 'evidence'));
    if (which === 'manifest' || which === 'manifest-alias') {
      mkdirSync(join(workspace, 'evidence'));
      if (which === 'manifest') writeFileSync(f.before.missingManifest, '{}');
      else symlinkSync(join(f.root, 'missing'), f.before.missingManifest);
    }
    expect(() => observeH06NativeFailure(workspace)).toThrow();
  },
);

it.each([
  { operationId: 'other' },
  { variant: 'legacy' },
  { variant: 'wrong' },
  { workspaceRoot: '/different-workspace' },
  { timeoutMs: 1.5 },
  { timeoutMs: 0 },
])('rejects an inconsistent expected operation %j', (change) => {
  const f = fixture();
  Object.assign(f.binding, change);
  expect(() => checkH06NativeFailure(f.binding, f.pin())).toThrow('h06-f01-binding');
});

it.each(['kind', 'before', 'after', 'receipt-pin'])('rejects replaced evidence (%s)', (which) => {
  const f = fixture();
  if (which === 'kind') f.receipt.kind = 'other';
  if (which === 'before') f.receipt.before = { ...f.before, files: [] };
  if (which === 'after') f.receipt.after = { ...f.before, missingManifest: '/different' };
  const pin = f.pin();
  if (which === 'receipt-pin') writeFileSync(pin.path, '{}');
  expect(() => checkH06NativeFailure(f.binding, pin)).toThrow();
});

it.each([
  { executable: '/different-node' },
  { sha256: digest('different-node') },
  { args: ['another-check.mjs'] },
  { timeoutMs: 2 },
])('rejects a different checker command %j', (change) => {
  const f = fixture();
  Object.assign(f.receipt.outcome.command, change);
  expect(() => checkH06NativeFailure(f.binding, f.pin())).toThrow('h06-f01-command');
});

it.each([
  { code: 0 },
  { code: null },
  { signal: 'SIGTERM' },
  { error: 'spawn failure' },
  { stop: { confirmed: false } },
  { stop: { confirmed: true, processes: null } },
  { stop: { confirmed: true, processes: [] } },
  { log: null },
  { log: "Error: ENOENT: no such file or directory, open '/foreign/evidence/manifest.json'" },
])('rejects an unconfirmed or unrelated checker failure %j', (change) => {
  const f = fixture();
  Object.assign(f.receipt.outcome, change);
  expect(() => checkH06NativeFailure(f.binding, f.pin())).toThrow('h06-f01-outcome');
});

function nativeStage() {
  const f = fixture();
  const evidence = join(f.root, 'primary');
  mkdirSync(evidence, { mode: 0o700 });
  const node = realpathSync(process.execPath);
  f.binding.node = { path: node, sha256: digest(readFileSync(node)) };
  return { ...f, evidence };
}

it.each(['legacy', 'temporal'] as const)(
  'persists and verifies the real F-01 before starting the %s writer',
  async (variant) => {
    const f = nativeStage();
    f.binding.variant = variant;
    const start = vi.fn(async (pin: H04Pin) => {
      expect(checkH06NativeFailure(f.binding, pin)).toEqual(pin);
      expect(pin.path).toBe(join(f.evidence, 'f01', 'receipt.json'));
      const receipt = JSON.parse(readH04Pin(pin).toString()) as typeof f.receipt;
      expect(receipt.before).toEqual(f.before);
      expect(receipt.after).toEqual(f.before);
      expect(receipt.outcome).toMatchObject({ code: 1, signal: null, error: null });
      expect(receipt.outcome.log).toContain(f.before.missingManifest);
      expect(await new NativeWriterProcesses().alive(receipt.outcome.stop.processes)).toEqual([]);
      mkdirSync(join(f.workspaceRoot, 'evidence'));
      writeFileSync(f.before.missingManifest, '{"sources":[]}');
      return 'writer-started';
    });
    const result = await startH06NativeVariant(f.binding, f.evidence, start);
    expect(start).toHaveBeenCalledExactlyOnceWith(result.initialFailure);
    expect(result.writer).toBe('writer-started');
    expect(checkH06NativeFailure(f.binding, result.initialFailure)).toEqual(result.initialFailure);
  },
);

it('keeps the primary receipt after a writer failure and refuses to repeat the initial stage', async () => {
  const f = nativeStage();
  const start = vi.fn(async () => {
    throw new Error('writer failed');
  });
  await expect(startH06NativeVariant(f.binding, f.evidence, start)).rejects.toThrow(
    'writer failed',
  );
  const path = join(f.evidence, 'f01', 'receipt.json');
  const bytes = readFileSync(path);
  const pin = { path, sha256: digest(bytes) };
  expect(checkH06NativeFailure(f.binding, pin)).toEqual(pin);
  await expect(startH06NativeVariant(f.binding, f.evidence, start)).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(readFileSync(path)).toEqual(bytes);
});

it('preserves an unexpected checker result and refuses to start the writer', async () => {
  const f = nativeStage();
  const path = join(f.root, 'unexpected-checker');
  const script = '#!/bin/sh\nexit 0\n';
  writeFileSync(path, script, { mode: 0o700 });
  f.binding.node = { path, sha256: digest(script) };
  const start = vi.fn(async () => {});
  await expect(startH06NativeVariant(f.binding, f.evidence, start)).rejects.toThrow(
    'h06-f01-outcome',
  );
  const receipt = JSON.parse(
    readFileSync(join(f.evidence, 'f01', 'receipt.json'), 'utf8'),
  ) as typeof f.receipt;
  expect(receipt.outcome.code).toBe(0);
  expect(start).not.toHaveBeenCalled();
});

it.each(['manifest', 'node', 'overlap'] as const)(
  'refuses to claim F-01 or start a writer when %s is invalid',
  async (which) => {
    const f = nativeStage();
    const start = vi.fn(async () => {});
    if (which === 'manifest') {
      mkdirSync(join(f.workspaceRoot, 'evidence'));
      writeFileSync(f.before.missingManifest, '{}');
    }
    if (which === 'node') f.binding.node.sha256 = digest('changed binary');
    const evidence = which === 'overlap' ? f.workspaceRoot : f.evidence;
    await expect(startH06NativeVariant(f.binding, evidence, start)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(existsSync(join(evidence, 'f01'))).toBe(false);
  },
);

it.each([true, false])(
  'uses the real Legacy renewal and records the stage crossing only when observed (%s)',
  async (crossed) => {
    const f = nativeStage();
    f.binding.variant = 'legacy';
    f.binding.timeoutMs = 3000;
    const storeRoot = join(f.evidence, 'store');
    const authority = { ...grant, context: { ...grant.context, task_id: f.binding.operationId } };
    let now = 100000;
    const oldDeadline = now + 10000;
    initializeStore(storeRoot, authority.context);
    const store = new SqliteEvidenceStore(storeRoot, authority, () => now);
    unwrap(
      store.execute(signed({ type: 'claim', lease_until: oldDeadline }, 0, 0, 'claim', authority)),
    );
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const start = async (verify: () => void, pin: H04Pin) => {
        expect(checkH06NativeFailure(f.binding, pin)).toEqual(pin);
        expect(existsSync(join(f.evidence, 'legacy-renew.json'))).toBe(true);
        await new Promise((done) => setTimeout(done, 5));
        now = oldDeadline + (crossed ? 1 : -1);
        verify();
        return 'stage-finished';
      };
      const attempt = runH06NativeLegacy(
        f.binding,
        f.evidence,
        store,
        oldDeadline,
        oldDeadline + 60000,
        start,
      );
      if (!crossed) {
        await expect(attempt).rejects.toThrow('h06-legacy-stage-not-crossed');
        expect(existsSync(join(f.evidence, 'legacy-renew.json'))).toBe(true);
        expect(existsSync(join(f.evidence, 'legacy-crossing.json'))).toBe(false);
        return;
      }
      const result = await attempt;
      expect(result.writer.result).toBe('stage-finished');
      const renewal: unknown = JSON.parse(readH04Pin(result.writer.renewal).toString());
      expect(renewal).toMatchObject({
        kind: 'h06-native-legacy-renew',
        before: { lease_until: oldDeadline, owner: authority.context.actor_id },
        renewed: { lease_until: 1900000, owner: authority.context.actor_id },
        event: { change: { type: 'renew', lease_until: 1900000 } },
        observedAt: 100000,
        ack: { operation_id: 'chat:lease:1:1', generation: 1, catalog_revision: 2 },
      });
      expect(JSON.parse(readH04Pin(result.writer.crossing).toString()) as unknown).toMatchObject({
        kind: 'h06-native-legacy-crossing',
        renewal: result.writer.renewal,
        startedAt: 100000,
        endedAt: oldDeadline + 1,
      });
      expect(
        checkH06NativeLegacyCrossing(f.binding, result.writer.renewal, result.writer.crossing, 1),
      ).toMatchObject({ status: 'LEASE_CROSSING_VERIFIED', qualification: false });
      expect(() =>
        checkH06NativeLegacyCrossing(
          f.binding,
          result.writer.renewal,
          result.writer.crossing,
          100000,
        ),
      ).toThrow('h06-legacy-crossing-time');
    } finally {
      clock.mockRestore();
    }
  },
);
