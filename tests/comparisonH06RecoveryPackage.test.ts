import {
  chmodSync,
  existsSync,
  linkSync,
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
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import type { TechnicalState } from '../core/evidence.js';
import type { H04Pin } from './comparisonH04Contract.js';
import { grant, signed } from './storageFixtures.js';
import {
  captureH06RecoveryClosure,
  h06RecoveryPackageMain,
  inventoryH06Recovery,
  planH06RecoveryPackage,
  runH06RecoveryPackage,
} from './comparisonH06RecoveryPackage.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(frozen = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-recovery-package-'));
  roots.push(root);
  const source = join(root, 'sealed'),
    workspace = join(root, 'workspace'),
    evidence = join(source, 'task');
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  const pin = (path: string): H04Pin => ({ path, sha256: digest(readFileSync(path)) });
  const save = (path: string, value: unknown) => {
    writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
    return pin(path);
  };
  const text = (path: string, value: string) => {
    writeFileSync(path, value, { mode: 0o600 });
    return pin(path);
  };
  const material = text(join(workspace, 'material.txt'), 'complete final material\n');
  text(join(workspace, 'broken.txt'), '{not JSON');
  const descriptor = save(join(workspace, 'workflow.json'), {
    card: { locator: 'material.txt', hash: material.sha256 },
  });
  chmodSync(descriptor.path, 0o700);
  const bootstrap = save(join(root, 'bootstrap.json'), { projectId: 'project', runId: 'run' });
  const runtimeFile = text(join(root, 'old-runtime.ts'), 'executed exact runtime\n');
  mkdirSync(join(source, 'executed-runtime'), { mode: 0o700 });
  const preserved = text(
    join(source, 'executed-runtime', runtimeFile.sha256),
    'executed exact runtime\n',
  );
  text(runtimeFile.path, 'changed later runtime\n');
  const runtimeManifest = {
    kind: 'h06-executed-runtime-manifest/1',
    pins: [{ ...runtimeFile, preserved: preserved.path }],
  };
  save(join(source, 'executed-runtime-manifest.json'), runtimeManifest);
  const journal = text(join(root, 'native.jsonl'), '{"event":"primary"}\n{"event":"terminal"}\n');
  save(join(source, 'references.json'), {
    array: [{ locator: 'material.txt', hash: material.sha256 }],
    native: { locator: journal.path + '#L2', hash: digest('{"event":"terminal"}\n') },
    content: { sha256: material.sha256, bytes: 24 },
    diagnostic: {
      bytes: 258,
      hash: '5'.repeat(64),
      direction: 'recv',
      method: 'item/agentMessage/delta',
    },
    stderrDiagnostic: { bytes: 4, hash: '7'.repeat(64), direction: 'stderr', preview: 'text' },
    retained: {
      kind: 'h06-delegated-retained-host-continuation/1',
      transcript: journal.path,
      nativePrefix: {
        bytes: Buffer.byteLength('{"event":"primary"}\n'),
        sha256: digest('{"event":"primary"}\n'),
      },
    },
    nested: canonical({ path: bootstrap.path, sha256: bootstrap.sha256 }),
    primitive: 4,
    null: null,
  });
  const storeRoot = join(evidence, 'legacy-store');
  initializeStore(storeRoot, grant.context);
  const store = new SqliteEvidenceStore(storeRoot, grant, () => 100);
  unwrap(store.execute(signed({ type: 'claim', lease_until: 100000 }, 0, 0)));
  unwrap(
    store.execute(
      signed(
        {
          type: 'checkpoint',
          state: {
            workflow: {
              coders: {
                warm: { status: 'cancelled' },
                cold: { status: 'cancelled' },
                final: { status: 'integrated' },
              },
            },
          },
          effects: [],
        },
        1,
      ),
    ),
  );
  if (frozen) unwrap(store.execute(signed({ type: 'freeze' }, 2)));
  const state = unwrap<TechnicalState>(
    store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
  );
  const request = {
    binding: { workspaceRoot: workspace, operationId: 'task' },
    evidenceRoot: evidence,
    bootstrap,
  };
  const claim = save(join(evidence, 'claim.json'), {
    request,
    actorId: 'owner',
    generation: 1,
    requestHash: 'a'.repeat(64),
    assets: { fixture: true },
  });
  const phases = [
    'load',
    'warm-pause',
    'warm-resume',
    'cold-pause',
    'cold-resume',
    'completion',
  ].map((stage, index) => {
    const intent = save(join(evidence, index + '-intent.json'), { stage }),
      result = save(join(evidence, index + '-result.json'), { stage }),
      outcome = save(join(evidence, index + '-outcome.json'), { stage, result });
    return {
      stage,
      intent,
      result,
      settlement: save(join(evidence, index + '-settlement.json'), { intent, outcome }),
    };
  });
  const outcomeValue = {
    kind: 'h06-delegated-run-outcome/1',
    claim,
    status: 'completed',
    acceptance: { status: 'PASS', evidence: { phases, storeRevision: state.revision } },
  };
  let outcome = save(join(evidence, 'outcome.json'), outcomeValue);
  const cleanupValue = {
    status: 'CONFIRMED',
    outcome,
    stopProofs: ['warm', 'cold', 'final'].map((id) => ({
      ...save(join(evidence, id + '-stopped.json'), { status: 'stopped' }),
      activeTurn: false,
      remainingProcesses: 0,
      remainingTerminals: 0,
      treeStable: true,
    })),
    ownedPidAbsent: { 123: true },
  };
  const summaryValue = {
    kind: 'h06-autonomous-live-summary/1',
    status: 'PASS',
    profile: 'h06-autonomous-recovery/3',
    outcome,
    cleanup: 'cleanup-verification.json',
    runtimeArchive: 'executed-runtime-manifest.json',
    retryAllowed: false,
    rootRunnerExitCode: 0,
  };
  const input = {
    kind: 'comparison-h06-recovery-package/1',
    summary: save(join(source, 'summary.json'), summaryValue),
    destination: join(root, 'recovered'),
  };
  const refresh = () => {
    outcome = save(join(evidence, 'outcome.json'), outcomeValue);
    cleanupValue.outcome = outcome;
    summaryValue.outcome = outcome;
    save(join(source, 'cleanup-verification.json'), cleanupValue);
    input.summary = save(join(source, 'summary.json'), summaryValue);
  };
  refresh();
  return {
    root,
    source,
    workspace,
    evidence,
    storeRoot,
    save,
    text,
    pin,
    input,
    state,
    outcomeValue,
    cleanupValue,
    summaryValue,
    runtimeManifest,
    material,
    journal,
    refresh,
  };
}

it.each([false, true])(
  'restores a real SQLite Store and complete file/native closure, initially frozen=%s',
  async (frozen) => {
    const f = fixture(frozen),
      before = inventoryH06Recovery(f.source),
      workspaceBefore = inventoryH06Recovery(f.workspace);
    const request = f.save(join(f.root, 'request.json'), f.input);
    await expect(h06RecoveryPackageMain(['--plan', request.path])).resolves.toMatchObject({
      source: f.source,
      mayRun: false,
    });
    expect(existsSync(f.input.destination)).toBe(false);
    const { result, report } = (await h06RecoveryPackageMain(['--run', request.path])) as Awaited<
      ReturnType<typeof runH06RecoveryPackage>
    >;
    expect(result).toMatchObject({
      status: 'PASS',
      sourceUnchanged: true,
      files: 'PASS',
      runtimePins: 1,
      temporalPostgresql: 'UNKNOWN',
      serverRpo: 'UNKNOWN',
      serverRto: 'UNKNOWN',
      executionImport: false,
      requiresReconciliation: true,
      mayRun: false,
      qualification: false,
      store: {
        revision: frozen ? 3 : 2,
        generation: 1,
        coders: ['cold', 'final', 'warm'],
        method: frozen ? 'frozen-store-export-restore' : 'closed-file-backup-restore',
        frozenStoreAdapter: frozen ? 'PASS' : 'NOT_APPLICABLE_UNFROZEN',
      },
    });
    expect(f.pin(result.archive.path)).toEqual(result.archive);
    expect(f.pin(report.path)).toEqual(report);
    expect(inventoryH06Recovery(f.source)).toEqual(before);
    expect(inventoryH06Recovery(f.workspace)).toEqual(workspaceBefore);
    const closure = JSON.parse(readFileSync(result.closure.path, 'utf8')) as {
      captured: Array<{
        locator: string;
        line: number | null;
        prefixBytes?: number;
        content: { sha256: string };
      }>;
      missing: unknown[];
    };
    expect(closure.missing).toEqual([]);
    expect(
      closure.captured.some((ref) => ref.locator === f.journal.path + '#L2' && ref.line === 2),
    ).toBe(true);
    const retained = closure.captured.find(
      (ref) => ref.locator === f.journal.path && ref.prefixBytes !== undefined,
    );
    expect(retained?.prefixBytes).toBe(Buffer.byteLength('{"event":"primary"}\n'));
    expect(retained?.content.sha256).toBe(digest('{"event":"primary"}\n'));
    expect(
      existsSync(
        join(f.input.destination, 'restored', 'artifacts', f.runtimeManifest.pins[0]!.sha256),
      ),
    ).toBe(true);
    await expect(runH06RecoveryPackage(f.input)).rejects.toThrow('h06-recovery-destination');
  },
);

it('retains unresolved external references explicitly without calling them a complete archive', async () => {
  const f = fixture();
  f.save(join(f.source, 'missing-reference.json'), {
    path: join(f.root, 'missing.json'),
    sha256: '0'.repeat(64),
  });
  const { result } = await runH06RecoveryPackage(f.input);
  expect(result.status).toBe('PARTIAL');
  expect(result.files).toBe('PASS');
  expect(result.store.status).toBe('PASS');
  expect(result.missingReferences).toEqual([
    expect.objectContaining({ locator: join(f.root, 'missing.json'), sha256: '0'.repeat(64) }),
  ]);
});

it('rejects authority/profile changes, unclosed writers, incomplete phase ledgers and unsafe destinations before copying', () => {
  const f = fixture();
  for (const change of [{ kind: 'other' }, { extra: true }])
    expect(() => planH06RecoveryPackage({ ...f.input, ...change })).toThrow();
  f.summaryValue.status = 'UNKNOWN';
  f.refresh();
  expect(() => planH06RecoveryPackage(f.input)).toThrow('h06-recovery-completed-profile');
  f.summaryValue.status = 'PASS';
  f.cleanupValue.ownedPidAbsent[123] = false;
  f.refresh();
  expect(() => planH06RecoveryPackage(f.input)).toThrow('h06-recovery-unclosed-source');
  f.cleanupValue.ownedPidAbsent[123] = true;
  f.cleanupValue.stopProofs[0]!.activeTurn = true;
  f.refresh();
  expect(() => planH06RecoveryPackage(f.input)).toThrow('h06-recovery-unclosed-source');
  f.cleanupValue.stopProofs[0]!.activeTurn = false;
  const phases = f.outcomeValue.acceptance.evidence.phases;
  f.outcomeValue.acceptance.evidence.phases = [];
  f.refresh();
  expect(() => planH06RecoveryPackage(f.input)).toThrow('h06-recovery-phase-count');
  f.outcomeValue.acceptance.evidence.phases = phases;
  phases[0]!.stage = 'wrong';
  f.refresh();
  expect(() => planH06RecoveryPackage(f.input)).toThrow('h06-recovery-phase-binding');
  phases[0]!.stage = 'load';
  f.refresh();
  const wal = f.text(join(f.storeRoot, 'store.sqlite-wal'), 'not closed');
  expect(() => planH06RecoveryPackage(f.input)).toThrow('h06-recovery-live-database');
  rmSync(wal.path);
  for (const destination of [f.source, join(f.source, 'nested'), f.workspace, f.root])
    expect(() => planH06RecoveryPackage({ ...f.input, destination })).toThrow(
      'h06-recovery-destination',
    );
  expect(existsSync(f.input.destination)).toBe(false);
});

it('refuses symlink and hardlink source entries and does not follow a linked root', () => {
  const f = fixture(),
    linked = join(f.root, 'linked');
  symlinkSync(f.source, linked);
  expect(() => inventoryH06Recovery(linked)).toThrow('h06-recovery-root-alias');
  symlinkSync(f.material.path, join(f.source, 'linked-file'));
  expect(() => inventoryH06Recovery(f.source)).toThrow('h06-recovery-plain-source');
  rmSync(join(f.source, 'linked-file'));
  linkSync(f.material.path, join(f.source, 'hardlinked'));
  expect(() => inventoryH06Recovery(f.source)).toThrow('h06-recovery-plain-source');
});

it('reports missing content and changed native lines without reading unrelated complete chat histories', () => {
  const f = fixture();
  f.save(join(f.source, 'closure-errors.json'), [
    { sha256: '1'.repeat(64), bytes: 2 },
    { locator: f.journal.path + '#L999', hash: '2'.repeat(64) },
    { locator: '../outside', hash: '3'.repeat(64) },
    { path: f.material.path, sha256: '4'.repeat(64) },
    { sha256: f.material.sha256, bytes: 1 },
    { hash: '6'.repeat(64), bytes: 2 },
    {
      bytes: 258,
      hash: '8'.repeat(64),
      direction: 'recv',
      method: 'item/agentMessage/delta',
      artifact: true,
    },
    { bytes: 3, hash: '9'.repeat(64), direction: 'recv', method: 42 },
    { bytes: 4, hash: 'a'.repeat(64), direction: 'recv', preview: 'not a stderr diagnostic' },
    {
      kind: 'h06-delegated-retained-host-continuation/1',
      transcript: f.journal.path,
      nativePrefix: { bytes: 3, sha256: 'b'.repeat(64) },
    },
    {
      kind: 'h06-delegated-retained-host-continuation/1',
      transcript: f.journal.path,
      nativePrefix: { bytes: 9999, sha256: 'c'.repeat(64) },
    },
  ]);
  const closure = captureH06RecoveryClosure({
    source: f.source,
    workspace: f.workspace,
    destination: join(f.root, 'closure'),
    runtime: {},
    decoded: null,
  });
  expect(closure.complete).toBe(false);
  expect(closure.missing).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: 'Error: content-not-found' }),
      expect.objectContaining({ reason: 'Error: native-line-missing-or-changed' }),
      expect.objectContaining({ reason: 'Error: invalid-relative-path' }),
      expect.objectContaining({ reason: 'Error: file-missing-or-changed' }),
      expect.objectContaining({ reason: 'Error: native-prefix-missing-or-changed' }),
      expect.objectContaining({
        locator: null,
        sha256: '6'.repeat(64),
        reason: 'Error: content-not-found',
      }),
      expect.objectContaining({
        locator: null,
        sha256: '8'.repeat(64),
        reason: 'Error: content-not-found',
      }),
      expect.objectContaining({
        locator: null,
        sha256: '9'.repeat(64),
        reason: 'Error: content-not-found',
      }),
      expect.objectContaining({
        locator: null,
        sha256: 'a'.repeat(64),
        reason: 'Error: content-not-found',
      }),
    ]),
  );
});

it('rejects a pre-Writer snapshot or missing executed runtime preservation rather than upgrading it to recovery proof', async () => {
  const f = fixture();
  f.outcomeValue.acceptance.evidence.storeRevision = 548;
  f.refresh();
  await expect(runH06RecoveryPackage(f.input)).rejects.toThrow('h06-recovery-post-writer-state');
  const second = fixture();
  second.runtimeManifest.pins[0]!.preserved = join(second.root, 'outside-runtime');
  second.save(join(second.source, 'executed-runtime-manifest.json'), second.runtimeManifest);
  await expect(runH06RecoveryPackage(second.input)).rejects.toThrow(
    'h06-recovery-runtime-preserved',
  );
});

it('handles command arguments and direct CLI outcomes without starting any live workflow', async () => {
  const f = fixture(),
    request = f.save(join(f.root, 'request.json'), f.input);
  for (const args of [[], ['--run'], ['--other', request.path], ['--plan', request.path, 'extra']])
    await expect(h06RecoveryPackageMain(args)).rejects.toThrow('h06-recovery-arguments');
  const argv = process.argv,
    exitCode = process.exitCode,
    entry = fileURLToPath(new URL('./comparisonH06RecoveryPackage.ts', import.meta.url));
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    process.argv = ['node', entry, '--plan', request.path];
    vi.resetModules();
    await import('./comparisonH06RecoveryPackage.js');
    await vi.waitFor(() => expect(output).toHaveBeenCalled());
    process.argv = ['node', entry, '--wrong', request.path];
    vi.resetModules();
    await import('./comparisonH06RecoveryPackage.js');
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Error: h06-recovery-arguments\n'));
    expect(process.exitCode).toBe(1);
    process.argv = [];
    vi.resetModules();
    await import('./comparisonH06RecoveryPackage.js');
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
