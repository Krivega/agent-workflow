import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { exportStore, restoreStore } from '../adapters/storage/storeBackup.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { evidenceSchema, type BackupReceipt, type EvidenceGrant } from '../core/evidence.js';
import { createBackup, stageRestore, verifyBackup } from '../src/adapters/artifacts/backup.js';
import { artifactStore, publishFile } from '../src/adapters/artifacts/files.js';
import { readLegacyArchive } from '../src/adapters/artifacts/legacyArchive.js';
import { controlRef } from '../src/policy/readerControl.js';
import {
  exactFields,
  object,
  relativePath,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';

const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
const pin = (path: string): H04Pin => ({ path, sha256: digest(h01RawFile(path)) });
function save(path: string, value: unknown) {
  publishFile(path, Buffer.from(canonical(value) + '\n'));
  return pin(path);
}
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
const absolute = (value: unknown) => h04Pin({ path: value, sha256: '0'.repeat(64) }).path;

/** Byte inventory only: never open or recover the sealed source database. */
export function inventoryH06Recovery(root: string) {
  requireContract(realpathSync(root) === root, 'h06-recovery-root-alias');
  const entries: Array<{
    path: string;
    sha256: string | null;
    bytes: number;
    executable: boolean;
  }> = [];
  function visit(path: string) {
    const stat = lstatSync(path);
    requireContract(
      realpathSync(path) === path && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)),
      'h06-recovery-plain-source',
    );
    const name = relative(root, path);
    if (stat.isDirectory()) {
      entries.push({ path: name, sha256: null, bytes: 0, executable: false });
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else {
      const bytes = h01RawFile(path);
      entries.push({
        path: name,
        sha256: digest(bytes),
        bytes: bytes.length,
        executable: (stat.mode & 0o100) !== 0,
      });
    }
  }
  visit(root);
  return entries;
}

export function planH06RecoveryPackage(value: unknown) {
  const input = object(value);
  exactFields(input, ['kind', 'summary', 'destination']);
  requireContract(input.kind === 'comparison-h06-recovery-package/1', 'h06-recovery-kind');
  const summaryPin = h04Pin(input.summary),
    summary = read(summaryPin),
    source = dirname(summaryPin.path);
  requireContract(
    summary.kind === 'h06-autonomous-live-summary/1' &&
      summary.status === 'PASS' &&
      summary.profile === 'h06-autonomous-recovery/3' &&
      summary.retryAllowed === false &&
      summary.rootRunnerExitCode === 0,
    'h06-recovery-completed-profile',
  );
  const outcomePin = h04Pin(summary.outcome),
    outcome = read(outcomePin),
    claim = read(h04Pin(outcome.claim));
  const request = object(claim.request),
    binding = object(request.binding),
    evidence = absolute(request.evidenceRoot),
    workspace = absolute(binding.workspaceRoot);
  requireContract(
    dirname(evidence) === source &&
      dirname(outcomePin.path) === evidence &&
      outcome.status === 'completed' &&
      object(outcome.acceptance).status === 'PASS',
    'h06-recovery-source-binding',
  );
  const cleanupPin = pin(join(source, relativePath(summary.cleanup))),
    cleanup = read(cleanupPin);
  const stopped = cleanup.stopProofs;
  requireContract(
    cleanup.status === 'CONFIRMED' &&
      same(cleanup.outcome, outcomePin) &&
      Array.isArray(stopped) &&
      stopped.length === 3 &&
      stopped.every((value) => {
        const proof = object(value);
        return (
          proof.activeTurn === false &&
          proof.remainingProcesses === 0 &&
          proof.remainingTerminals === 0 &&
          proof.treeStable === true
        );
      }) &&
      Object.values(object(cleanup.ownedPidAbsent)).length > 0 &&
      Object.values(object(cleanup.ownedPidAbsent)).every((absent) => absent === true),
    'h06-recovery-unclosed-source',
  );
  for (const value of stopped) {
    const proof = object(value);
    read(h04Pin({ path: proof.path, sha256: proof.sha256 }));
  }
  const phases = object(object(outcome.acceptance).evidence).phases;
  const stages = ['load', 'warm-pause', 'warm-resume', 'cold-pause', 'cold-resume', 'completion'];
  requireContract(
    Array.isArray(phases) && phases.length === stages.length,
    'h06-recovery-phase-count',
  );
  for (const [index, value] of phases.entries()) {
    const phase = object(value),
      intent = h04Pin(phase.intent),
      settlement = read(h04Pin(phase.settlement));
    requireContract(
      phase.stage === stages[index] && same(settlement.intent, intent),
      'h06-recovery-phase-binding',
    );
    read(intent);
    read(h04Pin(phase.result));
    read(h04Pin(settlement.outcome));
  }
  const store = join(evidence, 'legacy-store');
  for (const suffix of ['-wal', '-shm', '-journal'])
    requireContract(
      !existsSync(join(store, 'store.sqlite' + suffix)),
      'h06-recovery-live-database',
    );
  const destination = absolute(input.destination);
  requireContract(
    realpathSync(dirname(destination)) === dirname(destination) &&
      !existsSync(destination) &&
      [source, workspace].every((root) => !overlaps(root, destination)),
    'h06-recovery-destination',
  );
  return {
    summary: summaryPin,
    cleanup: cleanupPin,
    outcome: outcomePin,
    claim,
    request,
    source,
    evidence,
    workspace,
    store,
    destination,
    mayRun: false,
    qualification: false,
  } as const;
}

interface Reference {
  locator: string | null;
  sha256: string;
  bytes?: number;
  prefixBytes?: number;
}
interface CapturedReference extends Reference {
  content: { sha256: string; bytes: number };
  line: number | null;
}

function transportDiagnostic(value: Record<string, unknown>) {
  const fields: Record<string, string> = {
    direction: 'string',
    bytes: 'number',
    hash: 'string',
    id: 'number',
    method: 'string',
    preview: 'string',
  };
  return (
    ['send', 'recv', 'stderr'].includes(String(value.direction)) &&
    typeof value.hash === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.hash) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) >= 0 &&
    (value.preview === undefined || value.direction === 'stderr') &&
    Object.entries(value).every(([key, item]) => typeof item === fields[key])
  );
}

/** Capture only references reachable from the saved H06 package and decoded Store, not whole chats. */
export function captureH06RecoveryClosure(input: {
  source: string;
  workspace: string;
  destination: string;
  runtime: Record<string, string>;
  decoded: unknown;
}) {
  const store = artifactStore(input.destination),
    pending: Reference[] = [],
    seen = new Set<string>();
  const captured: CapturedReference[] = [],
    missing: Array<Reference & { reason: string }> = [];
  const byHash = new Map<string, string>(),
    journals = new Map<string, Buffer>();
  const native: Array<{ reference: Reference; path: string; line: number }> = [];
  function enqueue(ref: Reference) {
    const key = canonical(ref);
    if (!seen.has(key)) {
      seen.add(key);
      pending.push(ref);
    }
  }
  function journal(path: string) {
    let bytes = journals.get(path);
    if (bytes === undefined) {
      bytes = readH06NativeJournal(path);
      journals.set(path, bytes);
    }
    return bytes;
  }
  function discover(value: unknown) {
    if (typeof value === 'string') {
      scan(Buffer.from(value));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(discover);
      return;
    }
    const v = object(value);
    if (transportDiagnostic(v)) return;
    if (v.kind === 'h06-delegated-retained-host-continuation/1') {
      const ref = controlRef(v.nativePrefix);
      enqueue({ locator: absolute(v.transcript), sha256: ref.sha256, prefixBytes: ref.bytes });
      for (const [key, value] of Object.entries(v)) if (key !== 'nativePrefix') discover(value);
      return;
    }
    const locator =
      typeof v.path === 'string' ? v.path : typeof v.locator === 'string' ? v.locator : null;
    const hash = typeof v.sha256 === 'string' ? v.sha256 : v.hash;
    if (
      typeof hash === 'string' &&
      /^[a-f0-9]{64}$/u.test(hash) &&
      (locator !== null || typeof v.bytes === 'number')
    ) {
      enqueue({
        locator,
        sha256: hash,
        ...(typeof v.bytes === 'number' ? { bytes: v.bytes } : {}),
      });
    }
    Object.values(v).forEach(discover);
  }
  function scan(bytes: Buffer) {
    if (bytes[0] !== 123 && bytes[0] !== 91) return;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString());
    } catch {
      return;
    }
    discover(value);
  }
  for (const root of [input.source, input.workspace])
    for (const entry of inventoryH06Recovery(root)) {
      if (entry.sha256 !== null) {
        const path = join(root, entry.path);
        byHash.set(entry.sha256, path);
        scan(h01RawFile(path));
      }
    }
  discover(input.decoded);
  for (let i = 0; i < pending.length; i++) {
    const ref = pending[i]!;
    try {
      if (ref.prefixBytes !== undefined) {
        const bytes = journal(ref.locator!).subarray(0, ref.prefixBytes);
        requireContract(
          bytes.length === ref.prefixBytes && digest(bytes) === ref.sha256,
          'native-prefix-missing-or-changed',
        );
        const content = store.publish(bytes);
        captured.push({ ...ref, content, line: null });
        byHash.set(ref.sha256, join(input.destination, content.sha256));
        continue;
      }
      const match = ref.locator === null ? null : /^(.*)#L([1-9]\d*)$/u.exec(ref.locator);
      if (match !== null) {
        const path = match[1]!,
          line = Number(match[2]);
        const bytes = journal(path);
        const rows = bytes.toString().split('\n'),
          row = rows[line - 1];
        requireContract(
          row !== undefined && digest(row + '\n') === ref.sha256,
          'native-line-missing-or-changed',
        );
        native.push({ reference: ref, path, line });
        continue;
      }
      const fallback = byHash.get(ref.sha256),
        preserved =
          ref.locator === null ? undefined : input.runtime[ref.locator + '|' + ref.sha256];
      let path = preserved ?? fallback;
      if (path === undefined && ref.locator !== null)
        path = isAbsolute(ref.locator)
          ? ref.locator
          : join(input.workspace, relativePath(ref.locator));
      requireContract(path !== undefined, 'content-not-found');
      const bytes = h01RawFile(path);
      requireContract(
        digest(bytes) === ref.sha256 && (ref.bytes === undefined || ref.bytes === bytes.length),
        'file-missing-or-changed',
      );
      captured.push({ ...ref, content: store.publish(bytes), line: null });
      byHash.set(ref.sha256, path);
      scan(bytes);
    } catch (error) {
      missing.push({ ...ref, reason: String(error) });
    }
  }
  for (const path of new Set(native.map((entry) => entry.path))) {
    const refs = native.filter((entry) => entry.path === path),
      lastLine = Math.max(...refs.map((entry) => entry.line));
    const prefix = Buffer.from(
        journals.get(path)!.toString().split('\n').slice(0, lastLine).join('\n') + '\n',
      ),
      content = store.publish(prefix);
    captured.push(...refs.map(({ reference, line }) => ({ ...reference, content, line })));
  }
  return { captured, missing, complete: missing.length === 0 };
}

/** File-only offline recovery. All SQLite adapters receive owned copies, never sealed inputs. */
export async function runH06RecoveryPackage(value: unknown) {
  const plan = planH06RecoveryPackage(value),
    before = inventoryH06Recovery(plan.source),
    workspaceBefore = inventoryH06Recovery(plan.workspace);
  mkdirSync(plan.destination, { mode: 0o700 });
  const source = join(plan.destination, 'source'),
    workspace = join(plan.destination, 'workspace');
  cpSync(plan.source, source, { recursive: true, force: false, errorOnExist: true });
  cpSync(plan.workspace, workspace, { recursive: true, force: false, errorOnExist: true });
  requireContract(
    same(before, inventoryH06Recovery(source)) &&
      same(workspaceBefore, inventoryH06Recovery(workspace)),
    'h06-recovery-copy-changed',
  );
  const storePath = join(source, relative(plan.source, plan.store));
  const history = readLegacyArchive({ schemaVersion: 1, root: storePath }),
    state = object(history.state),
    checkpoint = object(state.checkpoint),
    workflow = object(checkpoint.workflow),
    coders = object(workflow.coders);
  const outcome = read(plan.outcome),
    expectedRevision = object(object(outcome.acceptance).evidence).storeRevision;
  requireContract(
    state.revision === expectedRevision &&
      state.generation === plan.claim.generation &&
      Object.keys(coders).length === 3 &&
      Object.values(coders).some((value) => object(value).status === 'integrated'),
    'h06-recovery-post-writer-state',
  );
  const manifestPath = join(source, relativePath(read(plan.summary).runtimeArchive)),
    runtimeManifest = read(pin(manifestPath));
  requireContract(
    runtimeManifest.kind === 'h06-executed-runtime-manifest/1' &&
      Array.isArray(runtimeManifest.pins) &&
      runtimeManifest.pins.length > 0,
    'h06-recovery-runtime-manifest',
  );
  const runtime: Record<string, string> = {};
  for (const value of runtimeManifest.pins) {
    const item = object(value),
      reference = h04Pin({ path: item.path, sha256: item.sha256 }),
      preserved = absolute(item.preserved);
    requireContract(
      dirname(preserved) === join(plan.source, 'executed-runtime'),
      'h06-recovery-runtime-preserved',
    );
    const copy = join(source, relative(plan.source, preserved));
    readH04Pin({ path: copy, sha256: reference.sha256 });
    runtime[reference.path + '|' + reference.sha256] = copy;
  }
  const metadata = join(plan.destination, 'metadata');
  mkdirSync(metadata, { mode: 0o700 });
  const recoveryRuntime = pin(fileURLToPath(import.meta.url));
  publishFile(join(metadata, 'recovery-tool.ts'), readH04Pin(recoveryRuntime));
  const closure = captureH06RecoveryClosure({
    source,
    workspace,
    destination: join(plan.destination, 'closure'),
    runtime,
    decoded: history,
  });
  const closurePin = save(join(metadata, 'closure.json'), closure),
    sourceInventory = save(join(metadata, 'source-inventory.json'), before),
    workspaceInventory = save(join(metadata, 'workspace-inventory.json'), workspaceBefore);
  const bootstrap = read(h04Pin(plan.request.bootstrap));
  const grant: EvidenceGrant = {
    context: {
      schema_version: evidenceSchema,
      project_id: text(bootstrap.projectId),
      task_id: text(object(plan.request.binding).operationId),
      subtask_id: null,
      run_id: text(bootstrap.runId),
      actor_id: text(plan.claim.actorId),
    },
    permissions: ['read', 'manage'],
  };
  const exported = join(plan.destination, 'store-export');
  let receipt: BackupReceipt | null = null;
  if (state.frozen === true) {
    const working = join(plan.destination, 'store-working');
    cpSync(storePath, working, { recursive: true, force: false, errorOnExist: true });
    chmodSync(working, 0o700);
    receipt = await exportStore(working, exported, grant);
  }
  const archive = join(plan.destination, 'archive'),
    saved = createBackup({
      schemaVersion: 2,
      roots: {
        legacy: source,
        workspaces: workspace,
        artifacts: join(plan.destination, 'closure'),
        receipts: metadata,
        ...(receipt === null ? {} : { build: exported }),
      },
      destination: archive,
    });
  const archiveFile = join(plan.destination, 'recovery.tgz');
  execFileSync('/usr/bin/tar', ['-czf', archiveFile, '-C', archive, '.']);
  const archivePin = pin(archiveFile),
    unpacked = join(plan.destination, 'unpacked');
  mkdirSync(unpacked, { mode: 0o700 });
  execFileSync('/usr/bin/tar', ['-xzf', archiveFile, '-C', unpacked]);
  verifyBackup({ schemaVersion: 1, backup: unpacked, manifest: saved.manifest });
  const restored = join(plan.destination, 'restored');
  stageRestore({
    schemaVersion: 1,
    backup: unpacked,
    manifest: saved.manifest,
    destination: restored,
  });
  requireContract(
    same(before, inventoryH06Recovery(join(restored, 'legacy'))) &&
      same(workspaceBefore, inventoryH06Recovery(join(restored, 'workspaces'))),
    'h06-recovery-restored-files-changed',
  );
  const restoredStore =
    receipt === null
      ? join(restored, 'legacy', relative(plan.source, plan.store))
      : join(plan.destination, 'restored-store');
  if (receipt !== null) restoreStore(join(restored, 'build'), restoredStore, grant);
  const recovered = readLegacyArchive({ schemaVersion: 1, root: restoredStore });
  const semantic = ({ database: _database, ...value }: typeof history) => value;
  requireContract(
    same(semantic(history), semantic(recovered)),
    'h06-recovery-restored-store-changed',
  );
  requireContract(
    same(before, inventoryH06Recovery(plan.source)) &&
      same(workspaceBefore, inventoryH06Recovery(plan.workspace)),
    'h06-recovery-source-changed',
  );
  const report = {
    kind: 'comparison-h06-recovery-package-result/1',
    status: closure.complete ? 'PASS' : 'PARTIAL',
    scope: 'completed-legacy-files-and-store',
    source: plan.summary,
    outcome: plan.outcome,
    cleanup: plan.cleanup,
    sourceUnchanged: true,
    archive: archivePin,
    manifest: saved.manifest,
    sourceInventory,
    workspaceInventory,
    closure: closurePin,
    missingReferences: closure.missing,
    runtimePins: runtimeManifest.pins.length,
    provenance: { requestHash: plan.claim.requestHash, assets: plan.claim.assets },
    recoveryRuntime,
    store: {
      status: 'PASS',
      revision: state.revision,
      generation: state.generation,
      coders: Object.keys(coders),
      method: receipt === null ? 'closed-file-backup-restore' : 'frozen-store-export-restore',
      frozenStoreAdapter: receipt === null ? 'NOT_APPLICABLE_UNFROZEN' : 'PASS',
      backup: receipt,
    },
    files: 'PASS',
    temporalPostgresql: 'UNKNOWN',
    serverRpo: 'UNKNOWN',
    serverRto: 'UNKNOWN',
    executionImport: false,
    requiresReconciliation: true,
    mayRun: false,
    qualification: false,
  } as const;
  return { report: save(join(plan.destination, 'result.json'), report), result: report };
}

export async function h06RecoveryPackageMain(args: readonly string[]) {
  const [action, path] = args;
  requireContract(
    args.length === 2 && path !== undefined && (action === '--plan' || action === '--run'),
    'h06-recovery-arguments',
  );
  const value = JSON.parse(h01RawFile(absolute(path)).toString()) as unknown;
  return action === '--plan' ? planH06RecoveryPackage(value) : runH06RecoveryPackage(value);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void h06RecoveryPackageMain(process.argv.slice(2)).then(
    (result) => process.stdout.write(canonical(result) + '\n'),
    (error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    },
  );
