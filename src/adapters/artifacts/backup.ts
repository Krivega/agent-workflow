import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ArtifactRef } from '../../contracts/preparation.js';
import { exactFields, object, relativePath, requireContract } from '../../contracts/project.js';
import { controlRef } from '../../policy/readerControl.js';
import { artifactStore, digest, publishFile, readPrivateFile, syncDirectory } from './files.js';

const components = ['artifacts', 'receipts', 'workspaces', 'build'] as const;
type Component = (typeof components)[number];
const fileComponents = [...components, 'projections', 'legacy'] as const;
type FileComponent = (typeof fileComponents)[number];
export interface BackupInput {
  schemaVersion: 1;
  persistence: string;
  roots: Record<Component, string>;
  destination: string;
}
export interface RestoreInput {
  schemaVersion: 1;
  backup: string;
  manifest: ArtifactRef;
  destination: string;
}
export interface FileBackupInput {
  schemaVersion: 2;
  roots: Partial<Record<FileComponent, string>>;
  destination: string;
}
interface BackupEntry {
  path: string;
  content: ArtifactRef | null;
  executable: boolean;
}
interface BackupManifest {
  schemaVersion: 1 | 2;
  kind: 'agent-workflow-backup';
  requiresReconciliation: true;
  persistence: { format: 'postgresql-custom'; content: ArtifactRef } | null;
  entries: BackupEntry[];
}
function path(value: unknown): string {
  requireContract(typeof value === 'string' && isAbsolute(value), 'backup-absolute-path-required');
  const result = resolve(value);
  requireContract(realpathSync(result) === result, 'backup-linked-path');
  return result;
}
function destination(value: unknown): string {
  requireContract(typeof value === 'string' && isAbsolute(value), 'backup-absolute-path-required');
  const result = resolve(value);
  path(dirname(result));
  return result;
}
function separate(paths: string[]): void {
  requireContract(
    paths.every((a, i) => paths.every((b, j) => i === j || (a !== b && !a.startsWith(b + sep)))),
    'backup-overlapping-paths',
  );
}
export function parseBackupInput(value: unknown): BackupInput {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'persistence', 'roots', 'destination']);
  requireContract(v.schemaVersion === 1, 'backup-input-version');
  const raw = object(v.roots);
  exactFields(raw, [...components]);
  const roots = {
    artifacts: path(raw.artifacts),
    receipts: path(raw.receipts),
    workspaces: path(raw.workspaces),
    build: path(raw.build),
  };
  requireContract(
    Object.values(roots).every((p) => lstatSync(p).isDirectory()),
    'backup-root-type',
  );
  const input: BackupInput = {
    schemaVersion: 1,
    persistence: path(v.persistence),
    roots,
    destination: destination(v.destination),
  };
  separate([...Object.values(roots), input.persistence, input.destination]);
  return input;
}
export function parseFileBackupInput(value: unknown): FileBackupInput {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'roots', 'destination']);
  requireContract(v.schemaVersion === 2, 'backup-input-version');
  const raw = object(v.roots),
    roots: FileBackupInput['roots'] = {};
  requireContract(Object.keys(raw).length > 0, 'backup-component-missing');
  for (const [name, value] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
    requireContract(fileComponents.includes(name as FileComponent), 'backup-component-invalid');
    const root = path(value);
    requireContract(lstatSync(root).isDirectory(), 'backup-root-type');
    roots[name as FileComponent] = root;
  }
  const input: FileBackupInput = {
    schemaVersion: 2,
    roots,
    destination: destination(v.destination),
  };
  separate([...Object.values(roots), input.destination]);
  return input;
}
export function parseRestoreInput(value: unknown): RestoreInput {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'backup', 'manifest', 'destination']);
  requireContract(v.schemaVersion === 1, 'backup-input-version');
  const input: RestoreInput = {
    schemaVersion: 1,
    backup: path(v.backup),
    manifest: controlRef(v.manifest),
    destination: destination(v.destination),
  };
  separate([input.backup, input.destination]);
  return input;
}
function plainFile(file: string): Buffer {
  const stat = lstatSync(file);
  requireContract(stat.isFile() && stat.nlink === 1, 'backup-plain-file-required');
  return readPrivateFile(file);
}
function postgres(bytes: Buffer): void {
  requireContract(bytes.subarray(0, 5).equals(Buffer.from('PGDMP')), 'backup-native-dump-required');
}
function capture(
  input: BackupInput | FileBackupInput,
  publish: (bytes: Buffer) => ArtifactRef,
  approved?: BackupManifest,
): BackupManifest {
  const accepted =
    approved === undefined
      ? undefined
      : new Map(approved.entries.map((entry) => [entry.path, entry]));
  function accept(entry: BackupEntry): void {
    if (accepted !== undefined)
      requireContract(isDeepStrictEqual(accepted.get(entry.path), entry), 'backup-source-changed');
  }
  let persistence: BackupManifest['persistence'] = null;
  if (input.schemaVersion === 1) {
    const dump = plainFile(input.persistence);
    postgres(dump);
    if (approved !== undefined)
      requireContract(
        isDeepStrictEqual(approved.persistence, {
          format: 'postgresql-custom',
          content: { sha256: digest(dump), bytes: dump.length },
        }),
        'backup-source-changed',
      );
    persistence = { format: 'postgresql-custom', content: publish(dump) };
  }
  const entries: BackupEntry[] = [];
  function visit(root: string, relative: string) {
    relativePath(relative);
    const file = join(root, relative.split('/').slice(1).join('/'));
    requireContract(realpathSync(file) === file, 'backup-linked-path');
    const stat = lstatSync(file);
    requireContract(
      !['host-owner', 'source-reservation', 'permission-lock'].includes(
        relative.split('/').at(-1)!,
      ) && !relative.split('/').at(-1)!.startsWith('.pending-'),
      'backup-owner-or-write-pending',
    );
    if (stat.isDirectory()) {
      const entry = { path: relative, content: null, executable: false };
      accept(entry);
      entries.push(entry);
      for (const name of readdirSync(file).sort()) visit(root, relative + '/' + name);
    } else {
      const bytes = plainFile(file),
        entry = {
          path: relative,
          content: { sha256: digest(bytes), bytes: bytes.length },
          executable: (stat.mode & 0o100) !== 0,
        };
      accept(entry);
      entry.content = publish(bytes);
      entries.push(entry);
    }
  }
  for (const [component, root] of Object.entries(input.roots)) visit(root, component);
  return {
    schemaVersion: input.schemaVersion,
    kind: 'agent-workflow-backup',
    requiresReconciliation: true,
    persistence,
    entries,
  };
}
function parseManifest(value: unknown): BackupManifest {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'requiresReconciliation', 'persistence', 'entries']);
  requireContract(
    (v.schemaVersion === 1 || v.schemaVersion === 2) &&
      v.kind === 'agent-workflow-backup' &&
      v.requiresReconciliation === true,
    'backup-manifest-version',
  );
  let persistence: BackupManifest['persistence'] = null;
  if (v.schemaVersion === 1) {
    const raw = object(v.persistence);
    exactFields(raw, ['format', 'content']);
    requireContract(raw.format === 'postgresql-custom', 'backup-persistence-format');
    persistence = { format: 'postgresql-custom', content: controlRef(raw.content) };
  } else requireContract(v.persistence === null, 'backup-file-only-persistence');
  const allowed = v.schemaVersion === 1 ? components : fileComponents;
  requireContract(Array.isArray(v.entries), 'backup-entries-required');
  const entries = v.entries.map((value): BackupEntry => {
    const entry = object(value);
    exactFields(entry, ['path', 'content', 'executable']);
    const name = relativePath(entry.path);
    requireContract(allowed.includes(name.split('/')[0] as Component), 'backup-component-invalid');
    requireContract(typeof entry.executable === 'boolean', 'backup-executable-invalid');
    requireContract(entry.content !== null || entry.executable === false, 'backup-directory-mode');
    return {
      path: name,
      content: entry.content === null ? null : controlRef(entry.content),
      executable: entry.executable,
    };
  });
  const directories = new Set<string>();
  const seen = new Set<string>();
  for (const entry of entries) {
    requireContract(!seen.has(entry.path), 'backup-duplicate-path');
    seen.add(entry.path);
    if (allowed.includes(entry.path as Component))
      requireContract(entry.content === null, 'backup-component-directory-required');
    else
      requireContract(
        directories.has(entry.path.slice(0, entry.path.lastIndexOf('/'))),
        'backup-parent-missing',
      );
    if (entry.content === null) directories.add(entry.path);
  }
  requireContract(
    v.schemaVersion === 1 ? components.every((name) => seen.has(name)) : directories.size > 0,
    'backup-component-missing',
  );
  return {
    schemaVersion: v.schemaVersion,
    kind: 'agent-workflow-backup',
    requiresReconciliation: true,
    persistence,
    entries,
  };
}
function verified(input: Pick<RestoreInput, 'backup' | 'manifest'>) {
  requireContract(!existsSync(join(input.backup, '.backup-incomplete')), 'backup-incomplete');
  const bytes = plainFile(join(input.backup, 'manifest.json'));
  requireContract(
    bytes.length === input.manifest.bytes && digest(bytes) === input.manifest.sha256,
    'backup-manifest-corrupted',
  );
  const manifest = parseManifest(JSON.parse(bytes.toString()) as unknown);
  requireContract(
    lstatSync(path(join(input.backup, 'blobs'))).isDirectory(),
    'backup-blobs-directory',
  );
  const store = artifactStore(join(input.backup, 'blobs'));
  for (const ref of [
    ...(manifest.persistence === null ? [] : [manifest.persistence.content]),
    ...manifest.entries.flatMap((entry) => (entry.content === null ? [] : [entry.content])),
  ])
    plainFile(join(input.backup, 'blobs', ref.sha256));
  if (manifest.persistence !== null) postgres(store.read(manifest.persistence.content));
  for (const entry of manifest.entries) if (entry.content !== null) store.read(entry.content);
  return { manifest, store };
}
export function createBackup(
  raw: unknown,
  expectedManifest?: ArtifactRef,
): { status: 'saved'; manifest: ArtifactRef } {
  const input = object(raw).schemaVersion === 2 ? parseFileBackupInput(raw) : parseBackupInput(raw);
  // Source databases and writers must already be stopped; byte equality cannot establish that boundary.
  const before = capture(input, (bytes) => ({ sha256: digest(bytes), bytes: bytes.length })),
    beforeBytes = Buffer.from(JSON.stringify(before)),
    beforeRef = { sha256: digest(beforeBytes), bytes: beforeBytes.length };
  if (expectedManifest !== undefined)
    requireContract(
      isDeepStrictEqual(controlRef(expectedManifest), beforeRef),
      'backup-approved-manifest-mismatch',
    );
  mkdirSync(input.destination, { mode: 0o700 });
  syncDirectory(dirname(input.destination));
  const pending = join(input.destination, '.backup-incomplete');
  publishFile(pending, Buffer.from('Backup has not completed.\n'));
  const store = artifactStore(join(input.destination, 'blobs')),
    copied = capture(input, store.publish, before),
    after = capture(input, (bytes) => ({ sha256: digest(bytes), bytes: bytes.length }));
  requireContract(
    isDeepStrictEqual(before, copied) && isDeepStrictEqual(copied, after),
    'backup-source-changed',
  );
  const bytes = Buffer.from(JSON.stringify(copied)),
    manifest = { sha256: digest(bytes), bytes: bytes.length };
  requireContract(isDeepStrictEqual(manifest, beforeRef), 'backup-source-changed');
  publishFile(join(input.destination, 'manifest.json'), bytes);
  unlinkSync(pending);
  syncDirectory(input.destination);
  return { status: 'saved', manifest };
}
export function inspectFileBackup(raw: unknown) {
  const inventory = capture(parseFileBackupInput(raw), (bytes) => ({
      sha256: digest(bytes),
      bytes: bytes.length,
    })),
    bytes = Buffer.from(JSON.stringify(inventory));
  return { manifest: { sha256: digest(bytes), bytes: bytes.length }, inventory };
}
export function verifyBackup(raw: unknown) {
  const value = object(raw);
  exactFields(value, ['schemaVersion', 'backup', 'manifest']);
  requireContract(value.schemaVersion === 1, 'backup-input-version');
  const input = { backup: path(value.backup), manifest: controlRef(value.manifest) },
    { manifest } = verified(input);
  return {
    status: 'verified' as const,
    manifest: input.manifest,
    scope:
      manifest.schemaVersion === 1 ? ('persistence-and-files' as const) : ('files-only' as const),
    components: manifest.entries
      .filter((entry) => !entry.path.includes('/'))
      .map((entry) => entry.path),
    blobs: [
      ...(manifest.persistence === null ? [] : [manifest.persistence.content]),
      ...manifest.entries.flatMap((entry) => (entry.content === null ? [] : [entry.content])),
    ],
  };
}
export function stageRestore(raw: unknown): {
  status: 'staged';
  requiresReconciliation: true;
  manifest: ArtifactRef;
} {
  const input = parseRestoreInput(raw),
    { manifest, store } = verified(input);
  mkdirSync(input.destination, { mode: 0o700 });
  syncDirectory(dirname(input.destination));
  const pending = join(input.destination, '.restore-incomplete');
  publishFile(pending, Buffer.from(JSON.stringify(input.manifest)));
  if (manifest.persistence !== null) {
    mkdirSync(join(input.destination, 'persistence'), { mode: 0o700 });
    publishFile(
      join(input.destination, 'persistence/temporal.pgdump'),
      store.read(manifest.persistence.content),
    );
  }
  for (const entry of manifest.entries) {
    const target = join(input.destination, entry.path);
    if (entry.content === null) {
      mkdirSync(target, { mode: 0o700 });
      syncDirectory(dirname(target));
    } else {
      publishFile(target, store.read(entry.content));
      if (entry.executable) {
        const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fchmodSync(descriptor, 0o700);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
    }
  }
  const result = {
    status: 'staged' as const,
    requiresReconciliation: true as const,
    manifest: input.manifest,
  };
  publishFile(join(input.destination, 'RESTORE.json'), Buffer.from(JSON.stringify(result)));
  unlinkSync(pending);
  syncDirectory(input.destination);
  return result;
}

export interface TemporalRecoverySnapshot {
  schemaVersion: 1;
  kind: 'temporal-storage-snapshot';
  backend: 'postgresql';
  versions: { temporal: string; postgresql: string };
  configuration: ArtifactRef;
  workerBuild: ArtifactRef;
  cut: { id: string; capturedAt: string; receipt: ArtifactRef };
  datastores: {
    role: 'default' | 'visibility';
    source: string;
    database: string;
    schemaVersion: string;
    dump: ArtifactRef;
  }[];
  workflows: {
    namespace: string;
    workflowId: string;
    runId: string;
    history: ArtifactRef;
    result: ArtifactRef | null;
  }[];
  evidence: { id: string; content: ArtifactRef }[];
  workcopies: { id: string; root: string }[];
}
function recoveryText(value: unknown): string {
  requireContract(typeof value === 'string' && value.length > 0, 'recovery-text-required');
  return value;
}
function recoveryList<T>(value: unknown, parse: (item: Record<string, unknown>) => T): T[] {
  requireContract(Array.isArray(value), 'recovery-list-required');
  return value.map((item: unknown) => parse(object(item)));
}
function distinct(values: string[]): void {
  requireContract(new Set(values).size === values.length, 'recovery-duplicate-identity');
}
export function parseTemporalRecoverySnapshot(raw: unknown): TemporalRecoverySnapshot {
  const v = object(raw);
  exactFields(v, [
    'schemaVersion',
    'kind',
    'backend',
    'versions',
    'configuration',
    'workerBuild',
    'cut',
    'datastores',
    'workflows',
    'evidence',
    'workcopies',
  ]);
  requireContract(
    v.schemaVersion === 1 && v.kind === 'temporal-storage-snapshot' && v.backend === 'postgresql',
    'recovery-snapshot-version',
  );
  const versions = object(v.versions),
    cut = object(v.cut);
  exactFields(versions, ['temporal', 'postgresql']);
  exactFields(cut, ['id', 'capturedAt', 'receipt']);
  const capturedAt = recoveryText(cut.capturedAt),
    time = Date.parse(capturedAt);
  requireContract(
    Number.isFinite(time) && new Date(time).toISOString() === capturedAt,
    'recovery-cut-time-invalid',
  );
  const datastores = recoveryList(
    v.datastores,
    (item): TemporalRecoverySnapshot['datastores'][number] => {
      exactFields(item, ['role', 'source', 'database', 'schemaVersion', 'dump']);
      requireContract(
        item.role === 'default' || item.role === 'visibility',
        'recovery-datastore-role',
      );
      return {
        role: item.role,
        source: recoveryText(item.source),
        database: recoveryText(item.database),
        schemaVersion: recoveryText(item.schemaVersion),
        dump: controlRef(item.dump),
      };
    },
  );
  distinct(datastores.map((store) => store.role));
  requireContract(
    datastores.some((store) => store.role === 'default') &&
      datastores.some((store) => store.role === 'visibility'),
    'recovery-datastore-missing',
  );
  const workflows = recoveryList(v.workflows, (item) => {
    exactFields(item, ['namespace', 'workflowId', 'runId', 'history', 'result']);
    return {
      namespace: recoveryText(item.namespace),
      workflowId: recoveryText(item.workflowId),
      runId: recoveryText(item.runId),
      history: controlRef(item.history),
      result: item.result === null ? null : controlRef(item.result),
    };
  });
  distinct(
    workflows.map((workflow) =>
      JSON.stringify([workflow.namespace, workflow.workflowId, workflow.runId]),
    ),
  );
  const evidence = recoveryList(v.evidence, (item) => {
    exactFields(item, ['id', 'content']);
    return { id: recoveryText(item.id), content: controlRef(item.content) };
  });
  distinct(evidence.map((item) => item.id));
  const workcopies = recoveryList(v.workcopies, (item) => {
    exactFields(item, ['id', 'root']);
    const root = relativePath(item.root);
    requireContract(
      root.startsWith('workspaces/') && root.split('/').length === 2,
      'recovery-workcopy-root',
    );
    return { id: recoveryText(item.id), root };
  });
  distinct(workcopies.map((copy) => copy.id));
  distinct(workcopies.map((copy) => copy.root));
  return {
    schemaVersion: 1,
    kind: 'temporal-storage-snapshot',
    backend: 'postgresql',
    versions: {
      temporal: recoveryText(versions.temporal),
      postgresql: recoveryText(versions.postgresql),
    },
    configuration: controlRef(v.configuration),
    workerBuild: controlRef(v.workerBuild),
    cut: { id: recoveryText(cut.id), capturedAt, receipt: controlRef(cut.receipt) },
    datastores,
    workflows,
    evidence,
    workcopies,
  };
}
function recoverySet(raw: unknown) {
  const value = object(raw);
  exactFields(value, ['schemaVersion', 'backup', 'manifest', 'snapshot']);
  requireContract(value.schemaVersion === 1, 'recovery-input-version');
  const input = {
      schemaVersion: 1 as const,
      backup: path(value.backup),
      manifest: controlRef(value.manifest),
      snapshot: controlRef(value.snapshot),
    },
    { manifest, store } = verified(input),
    entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  requireContract(manifest.schemaVersion === 2, 'recovery-file-backup-required');
  requireContract(
    [...components, 'projections'].every((name) => entries.get(name)?.content === null),
    'recovery-boundary-missing',
  );
  requireContract(
    isDeepStrictEqual(entries.get('build/storage-snapshot.json')?.content, input.snapshot),
    'recovery-snapshot-not-pinned',
  );
  const snapshot = parseTemporalRecoverySnapshot(
    JSON.parse(store.read(input.snapshot).toString('utf8')) as unknown,
  );
  function belongs(ref: ArtifactRef, component: string): void {
    requireContract(
      manifest.entries.some(
        (entry) => entry.path.startsWith(component + '/') && isDeepStrictEqual(entry.content, ref),
      ),
      'recovery-reference-not-in-boundary',
    );
  }
  function artifact(ref: ArtifactRef): void {
    requireContract(
      isDeepStrictEqual(entries.get('artifacts/' + ref.sha256)?.content, ref),
      'recovery-artifact-not-pinned',
    );
  }
  belongs(snapshot.configuration, 'build');
  belongs(snapshot.workerBuild, 'build');
  belongs(snapshot.cut.receipt, 'receipts');
  const databases = new Map<string, ArtifactRef>();
  for (const datastore of snapshot.datastores) {
    const physical = JSON.stringify([datastore.source, datastore.database]),
      previous = databases.get(physical);
    requireContract(
      previous === undefined || isDeepStrictEqual(previous, datastore.dump),
      'recovery-database-cut-conflict',
    );
    databases.set(physical, datastore.dump);
    artifact(datastore.dump);
    postgres(store.read(datastore.dump));
  }
  for (const workflow of snapshot.workflows) {
    artifact(workflow.history);
    if (workflow.result !== null) artifact(workflow.result);
  }
  for (const evidence of snapshot.evidence) artifact(evidence.content);
  for (const copy of snapshot.workcopies)
    requireContract(entries.get(copy.root)?.content === null, 'recovery-workcopy-missing');
  for (const entry of manifest.entries.filter((entry) => entry.path.startsWith('workspaces/')))
    requireContract(
      snapshot.workcopies.some(
        (copy) => entry.path === copy.root || entry.path.startsWith(copy.root + '/'),
      ),
      'recovery-unlisted-workcopy',
    );
  return { input, snapshot };
}
export function verifyTemporalRecoverySet(raw: unknown) {
  const { input, snapshot } = recoverySet(raw);
  return {
    status: 'files-verified' as const,
    manifest: input.manifest,
    snapshotRef: input.snapshot,
    snapshot,
    databaseFormat: 'postgresql-custom' as const,
    requiresReconciliation: true as const,
    activationAllowed: false as const,
  };
}
export function stageTemporalRecoverySet(raw: unknown) {
  const value = object(raw);
  exactFields(value, ['schemaVersion', 'backup', 'manifest', 'snapshot', 'destination']);
  const { input, snapshot } = recoverySet({
      schemaVersion: value.schemaVersion,
      backup: value.backup,
      manifest: value.manifest,
      snapshot: value.snapshot,
    }),
    staged = stageRestore({
      schemaVersion: 1,
      backup: input.backup,
      manifest: input.manifest,
      destination: value.destination,
    }),
    result = {
      ...staged,
      scope: 'temporal-storage-files' as const,
      snapshot: input.snapshot,
      backend: snapshot.backend,
      activationAllowed: false as const,
    };
  publishFile(
    join(destination(value.destination), 'RECOVERY.json'),
    Buffer.from(JSON.stringify(result)),
  );
  return result;
}
