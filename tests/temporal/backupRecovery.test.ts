import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBackup,
  inspectFileBackup,
  parseTemporalRecoverySnapshot,
  stageTemporalRecoverySet,
  verifyTemporalRecoverySet,
} from '../../src/adapters/artifacts/backup.js';
import type { TemporalRecoverySnapshot } from '../../src/adapters/artifacts/backup.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
import { digest } from '../../src/adapters/artifacts/files.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(sharedDatabase = false) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'aw-recovery-set-'))),
    source = join(root, 'source');
  temporary.push(root);
  fs.mkdirSync(source);
  const roots = {
    artifacts: join(source, 'artifacts'),
    receipts: join(source, 'receipts'),
    workspaces: join(source, 'workspaces'),
    build: join(source, 'build'),
    projections: join(source, 'projections'),
  };
  for (const directory of Object.values(roots)) fs.mkdirSync(directory);
  fs.mkdirSync(join(roots.workspaces, 'writer-1'));
  function put(component: keyof typeof roots, file: string, content: string): ArtifactRef {
    const bytes = Buffer.from(content),
      ref = { sha256: digest(bytes), bytes: bytes.length };
    fs.writeFileSync(join(roots[component], file === '<hash>' ? ref.sha256 : file), bytes);
    return ref;
  }
  const history = put(
      'artifacts',
      '<hash>',
      '{"workflowId":"same-id","runId":"same-run","events":[{"result":"FAIL","finding":"F-1"}]}',
    ),
    evidence = put(
      'artifacts',
      '<hash>',
      '{"id":"F-1","result":"FAIL","findings":["original"],"Result":"not replaced"}',
    ),
    defaultDump = put('artifacts', '<hash>', 'PGDMP\0default-signature-fixture'),
    visibilityDump = put('artifacts', '<hash>', 'PGDMP\0visibility-signature-fixture'),
    configuration = put('build', 'server.yaml', 'source configuration bytes'),
    workerBuild = put('build', 'worker.json', '{"version":"pinned-original"}'),
    receipt = put(
      'receipts',
      'stop.json',
      '{"outcome":"unknown","grant":"original; requires reconciliation"}',
    );
  put('workspaces', 'writer-1/source.ts', 'original unintegrated work');
  put('projections', 'index.json', '{"derived":"FAIL F-1"}');
  const snapshot: TemporalRecoverySnapshot = {
    schemaVersion: 1,
    kind: 'temporal-storage-snapshot',
    backend: 'postgresql',
    versions: { temporal: 'source-version', postgresql: 'source-version' },
    configuration,
    workerBuild,
    cut: { id: 'one-quiesced-cut', capturedAt: '2026-10-29T00:00:00.000Z', receipt },
    datastores: [
      {
        role: 'default',
        source: 'observed-cluster',
        database: 'source_default',
        schemaVersion: 'observed-default-schema',
        dump: defaultDump,
      },
      {
        role: 'visibility',
        source: 'observed-cluster',
        database: sharedDatabase ? 'source_default' : 'source_visibility',
        schemaVersion: 'observed-visibility-schema',
        dump: sharedDatabase ? defaultDump : visibilityDump,
      },
    ],
    workflows: [
      {
        namespace: 'original',
        workflowId: 'same-id',
        runId: 'same-run',
        history,
        result: evidence,
      },
      {
        namespace: 'original',
        workflowId: 'pending-id',
        runId: 'pending-run',
        history,
        result: null,
      },
    ],
    evidence: [{ id: 'F-1', content: evidence }],
    workcopies: [{ id: 'previous-writer', root: 'workspaces/writer-1' }],
  };
  const backupInput = { schemaVersion: 2, roots: { ...roots }, destination: join(root, 'backup') };
  function save() {
    const bytes = Buffer.from(JSON.stringify(snapshot)),
      snapshotRef = { sha256: digest(bytes), bytes: bytes.length };
    fs.writeFileSync(join(roots.build, 'storage-snapshot.json'), bytes);
    const expected = inspectFileBackup(backupInput),
      saved = createBackup(backupInput, expected.manifest);
    return {
      schemaVersion: 1,
      backup: backupInput.destination,
      manifest: saved.manifest,
      snapshot: snapshotRef,
    };
  }
  return { root, roots, snapshot, backupInput, history, evidence, defaultDump, save };
}
describe('coherent Temporal storage file set; no database or authority recovery claim', () => {
  it.each([false, true])(
    'verifies and stages original IDs/FAIL/workcopies without source or activation; shared database=%s',
    (shared) => {
      const f = fixture(shared),
        input = f.save(),
        verified = verifyTemporalRecoverySet(input);
      expect(verified).toMatchObject({
        status: 'files-verified',
        requiresReconciliation: true,
        activationAllowed: false,
      });
      expect(verified.snapshot).toEqual(f.snapshot);
      fs.rmSync(join(f.root, 'source'), { recursive: true });
      const destination = join(f.root, 'staged'),
        result = stageTemporalRecoverySet({ ...input, destination });
      expect(result).toMatchObject({
        status: 'staged',
        activationAllowed: false,
        scope: 'temporal-storage-files',
        snapshot: input.snapshot,
      });
      expect(fs.readFileSync(join(destination, 'artifacts', f.evidence.sha256), 'utf8')).toContain(
        '"result":"FAIL"',
      );
      expect(fs.readFileSync(join(destination, 'workspaces/writer-1/source.ts'), 'utf8')).toBe(
        'original unintegrated work',
      );
      expect(fs.readFileSync(join(destination, 'receipts/stop.json'), 'utf8')).toContain('unknown');
      expect(JSON.parse(fs.readFileSync(join(destination, 'RECOVERY.json'), 'utf8'))).toEqual(
        result,
      );
      expect(() => stageTemporalRecoverySet({ ...input, destination })).toThrow('EEXIST');
    },
  );
  it.each(['database', 'history', 'evidence', 'configuration', 'receipt', 'snapshot'])(
    'rejects a corrupt or missing %s before creating a staging directory',
    (kind) => {
      const f = fixture(),
        input = f.save(),
        destination = join(f.root, 'staged'),
        content =
          kind === 'database'
            ? f.defaultDump
            : kind === 'history'
              ? f.history
              : kind === 'evidence'
                ? f.evidence
                : kind === 'configuration'
                  ? f.snapshot.configuration
                  : kind === 'receipt'
                    ? f.snapshot.cut.receipt
                    : input.snapshot;
      fs.writeFileSync(join(input.backup, 'blobs', content.sha256), 'damaged');
      expect(() => stageTemporalRecoverySet({ ...input, destination })).toThrow(
        'artifact-corrupted',
      );
      expect(fs.existsSync(destination)).toBe(false);
    },
  );
  it.each(['artifacts', 'projections', 'receipts', 'workspaces', 'build'])(
    'rejects an omitted physical boundary: %s',
    (component) => {
      const f = fixture();
      Reflect.deleteProperty(f.backupInput.roots, component);
      const input = f.save();
      expect(() => verifyTemporalRecoverySet(input)).toThrow('recovery-boundary-missing');
    },
  );
  it('requires the snapshot descriptor to be pinned at its declared location', () => {
    const f = fixture(),
      input = f.save();
    expect(() => verifyTemporalRecoverySet({ ...input, snapshot: f.evidence })).toThrow(
      'recovery-snapshot-not-pinned',
    );
  });
  it.each(['new-root', 'missing-root', 'unlisted-file'])(
    'rejects an incomplete workcopy inventory: %s',
    (kind) => {
      const f = fixture();
      if (kind === 'new-root') fs.mkdirSync(join(f.roots.workspaces, 'unregistered'));
      else if (kind === 'missing-root') f.snapshot.workcopies[0]!.root = 'workspaces/missing';
      else fs.writeFileSync(join(f.roots.workspaces, 'unlisted.txt'), 'unregistered');
      const input = f.save();
      expect(() => verifyTemporalRecoverySet(input)).toThrow(
        kind === 'missing-root' ? 'recovery-workcopy-missing' : 'recovery-unlisted-workcopy',
      );
    },
  );
  it.each(['dump', 'configuration', 'build', 'receipt', 'evidence', 'history', 'result'])(
    'requires %s in the correct immutable boundary',
    (kind) => {
      const f = fixture(),
        unpinned = { sha256: 'f'.repeat(64), bytes: 1 };
      if (kind === 'dump') f.snapshot.datastores[0]!.dump = unpinned;
      else if (kind === 'configuration') f.snapshot.configuration = f.evidence;
      else if (kind === 'build') f.snapshot.workerBuild = f.evidence;
      else if (kind === 'receipt') f.snapshot.cut.receipt = f.evidence;
      else if (kind === 'evidence') f.snapshot.evidence[0]!.content = unpinned;
      else if (kind === 'history') f.snapshot.workflows[0]!.history = unpinned;
      else f.snapshot.workflows[0]!.result = unpinned;
      expect(() => verifyTemporalRecoverySet(f.save())).toThrow(
        kind === 'configuration' || kind === 'build' || kind === 'receipt'
          ? 'recovery-reference-not-in-boundary'
          : 'recovery-artifact-not-pinned',
      );
    },
  );
  it('rejects non-native dump contents and conflicting cuts of the same physical database', () => {
    const f = fixture(true);
    f.snapshot.datastores[1]!.dump = f.evidence;
    expect(() => verifyTemporalRecoverySet(f.save())).toThrow('recovery-database-cut-conflict');
    const second = fixture();
    second.snapshot.datastores[0]!.dump = second.evidence;
    expect(() => verifyTemporalRecoverySet(second.save())).toThrow('backup-native-dump-required');
  });
  it('leaves a failed file restore incomplete and publishes no recovery receipt', () => {
    const f = fixture(),
      input = f.save(),
      destination = join(f.root, 'staged'),
      write = fs.writeFileSync;
    let writes = 0;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (++writes === 3) throw new Error('disk full');
        return write(...args);
      },
    );
    expect(() => stageTemporalRecoverySet({ ...input, destination })).toThrow('disk full');
    expect(fs.existsSync(join(destination, '.restore-incomplete'))).toBe(true);
    expect(fs.existsSync(join(destination, 'RECOVERY.json'))).toBe(false);
  });
  it('rejects unsupported, incomplete and ambiguous snapshot descriptors', () => {
    const f = fixture();
    for (const invalid of [
      { ...f.snapshot, schemaVersion: 2 },
      { ...f.snapshot, kind: 'other' },
      { ...f.snapshot, backend: 'sqlite' },
      { ...f.snapshot, datastores: [] },
      { ...f.snapshot, datastores: [f.snapshot.datastores[0], f.snapshot.datastores[0]] },
      { ...f.snapshot, datastores: [{ ...f.snapshot.datastores[0], role: 'unknown' }] },
      { ...f.snapshot, cut: { ...f.snapshot.cut, capturedAt: 'invalid' } },
      { ...f.snapshot, cut: { ...f.snapshot.cut, capturedAt: '2026-02-30T00:00:00.000Z' } },
      { ...f.snapshot, evidence: [f.snapshot.evidence[0], f.snapshot.evidence[0]] },
      { ...f.snapshot, workflows: [f.snapshot.workflows[0], f.snapshot.workflows[0]] },
      { ...f.snapshot, workflows: null },
      { ...f.snapshot, workcopies: [{ id: 'writer', root: '../outside' }] },
      { ...f.snapshot, workcopies: [{ id: 'writer', root: 'workspaces/a/b' }] },
      { ...f.snapshot, configuration: null },
    ])
      expect(() => parseTemporalRecoverySnapshot(invalid)).toThrow();
    expect(() =>
      verifyTemporalRecoverySet({
        schemaVersion: 2,
        backup: f.root,
        manifest: f.evidence,
        snapshot: f.evidence,
      }),
    ).toThrow('recovery-input-version');
  });
});
