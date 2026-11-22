import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBackup,
  inspectFileBackup,
  parseBackupInput,
  parseRestoreInput,
  stageRestore,
  verifyBackup,
} from '../../src/adapters/artifacts/backup.js';
import type { BackupInput } from '../../src/adapters/artifacts/backup.js';
import { backupCommand } from '../../src/client/backup.js';
import { digest } from '../../src/adapters/artifacts/files.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'aw-backup-')));
  temporary.push(root);
  const roots = {
    artifacts: join(root, 'artifacts'),
    receipts: join(root, 'receipts'),
    workspaces: join(root, 'workspaces'),
    build: join(root, 'build'),
  };
  for (const path of Object.values(roots)) fs.mkdirSync(path);
  fs.mkdirSync(join(roots.workspaces, 'empty'));
  const fail = Buffer.from('FAIL: original finding F-1\n'),
    receipt = Buffer.from(
      JSON.stringify({ owner: 'original', generation: 7, active: false, outcome: 'unknown' }),
    );
  fs.writeFileSync(join(roots.artifacts, digest(fail)), fail);
  fs.writeFileSync(join(roots.receipts, 'permission.json'), receipt);
  fs.writeFileSync(join(roots.receipts, 'done.json'), '{"taskId":"closed","revision":4}');
  fs.writeFileSync(join(roots.workspaces, 'source.bin'), Buffer.from([0, 255, 3]));
  fs.writeFileSync(join(roots.build, 'worker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // This is a byte-packing fixture, not a valid PostgreSQL database or a native restore proof.
  const persistence = join(root, 'temporal.pgdump');
  fs.writeFileSync(persistence, Buffer.from('PGDMP\0fixture-only'));
  const input: BackupInput = {
    schemaVersion: 1,
    roots,
    persistence,
    destination: join(root, 'backup'),
  };
  function saved() {
    const result = createBackup(input);
    return {
      schemaVersion: 1 as const,
      backup: input.destination,
      manifest: result.manifest,
      destination: join(root, 'restored'),
    };
  }
  function altered(change: (manifest: Record<string, unknown>) => void) {
    const restore = saved(),
      file = join(restore.backup, 'manifest.json'),
      manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    change(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(file, bytes);
    return { ...restore, manifest: { sha256: digest(bytes), bytes: bytes.length } };
  }
  return { root, input, fail, receipt, saved, altered };
}
describe('offline backup packing and recovery staging', () => {
  it('restores all five boundaries without sources and preserves FAIL, tombstones and permissions', () => {
    const f = fixture(),
      restore = f.saved();
    for (const path of Object.values(f.input.roots)) fs.rmSync(path, { recursive: true });
    fs.unlinkSync(f.input.persistence);
    expect(
      verifyBackup({ schemaVersion: 1, backup: restore.backup, manifest: restore.manifest }).scope,
    ).toBe('persistence-and-files');
    const result = stageRestore(restore);
    expect(result).toEqual({
      status: 'staged',
      requiresReconciliation: true,
      manifest: restore.manifest,
    });
    expect(fs.readFileSync(join(restore.destination, 'artifacts', digest(f.fail)))).toEqual(f.fail);
    expect(fs.readFileSync(join(restore.destination, 'receipts/permission.json'))).toEqual(
      f.receipt,
    );
    expect(
      JSON.parse(fs.readFileSync(join(restore.destination, 'receipts/done.json'), 'utf8')),
    ).toEqual({ taskId: 'closed', revision: 4 });
    expect(fs.readdirSync(join(restore.destination, 'workspaces/empty'))).toEqual([]);
    expect(fs.readFileSync(join(restore.destination, 'workspaces/source.bin'))).toEqual(
      Buffer.from([0, 255, 3]),
    );
    expect(
      fs
        .readFileSync(join(restore.destination, 'persistence/temporal.pgdump'))
        .subarray(0, 5)
        .toString(),
    ).toBe('PGDMP');
    expect(fs.statSync(restore.destination).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(restore.destination, 'receipts/permission.json')).mode & 0o777).toBe(
      0o600,
    );
    expect(fs.statSync(join(restore.destination, 'build/worker')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(join(restore.destination, 'RESTORE.json'), 'utf8'))).toEqual(
      result,
    );
    expect(fs.existsSync(join(restore.destination, '.restore-incomplete'))).toBe(false);
    const before = fs.readFileSync(join(restore.destination, 'RESTORE.json'));
    expect(() => stageRestore(restore)).toThrow('EEXIST');
    expect(fs.readFileSync(join(restore.destination, 'RESTORE.json'))).toEqual(before);
  });
  it.each([false, true])(
    'requires a durable restore directory entry before success, parent sync fails=%s',
    (fails) => {
      const f = fixture(),
        restore = f.saved(),
        parent = fs.statSync(f.root),
        original = fs.fsyncSync,
        failure = Object.assign(new Error('restore parent sync failed'), { code: 'EIO' });
      const snapshot = () =>
        [
          'manifest.json',
          ...fs.readdirSync(join(restore.backup, 'blobs')).map((name) => 'blobs/' + name),
        ].map((name) => [name, fs.readFileSync(join(restore.backup, name))]);
      const before = snapshot();
      let parentSyncObserved = false;
      vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
        const stat = fs.fstatSync(descriptor);
        if (stat.dev === parent.dev && stat.ino === parent.ino) {
          expect(fs.existsSync(restore.destination)).toBe(true);
          expect(fs.existsSync(join(restore.destination, 'RESTORE.json'))).toBe(false);
          parentSyncObserved = true;
          if (fails) throw failure;
        }
        return original(descriptor);
      });
      if (fails) {
        expect(() => stageRestore(restore)).toThrow(failure);
        expect(fs.existsSync(join(restore.destination, 'RESTORE.json'))).toBe(false);
        vi.restoreAllMocks();
        expect(() => stageRestore(restore)).toThrow('EEXIST');
      } else expect(stageRestore(restore).status).toBe('staged');
      expect(parentSyncObserved).toBe(true);
      expect(snapshot()).toEqual(before);
      expect(
        verifyBackup({ schemaVersion: 1, backup: restore.backup, manifest: restore.manifest })
          .status,
      ).toBe('verified');
      expect(fs.readFileSync(join(f.input.roots.receipts, 'permission.json'))).toEqual(f.receipt);
    },
  );
  it('does not overwrite an existing backup or touch the source on retry', () => {
    const f = fixture();
    f.saved();
    const original = fs.readFileSync(join(f.input.destination, 'manifest.json'));
    expect(() => createBackup(f.input)).toThrow('EEXIST');
    expect(fs.readFileSync(join(f.input.destination, 'manifest.json'))).toEqual(original);
    expect(fs.readFileSync(join(f.input.roots.receipts, 'permission.json'))).toEqual(f.receipt);
  });
  it.each(['host-owner', 'source-reservation', 'permission-lock', '.pending-file'])(
    'refuses active or unknown ownership before publishing a backup: %s',
    (name) => {
      const f = fixture();
      fs.writeFileSync(join(f.input.roots.receipts, name), 'unknown owner');
      expect(() => createBackup(f.input)).toThrow('backup-owner-or-write-pending');
      expect(fs.existsSync(f.input.destination)).toBe(false);
    },
  );
  it.each(['symlink', 'hardlink', 'fifo'])(
    'refuses filesystem indirection and special files: %s',
    (kind) => {
      const f = fixture(),
        target = join(f.input.roots.receipts, 'linked');
      if (kind === 'symlink') fs.symlinkSync(f.input.persistence, target);
      else if (kind === 'hardlink') fs.linkSync(f.input.persistence, target);
      else execFileSync('mkfifo', [target]);
      expect(() => createBackup(f.input)).toThrow(
        kind === 'symlink' ? 'backup-linked-path' : 'backup-plain-file-required',
      );
      expect(fs.existsSync(f.input.destination)).toBe(false);
    },
  );
  it('refuses a persistence file without the native format signature', () => {
    const f = fixture();
    fs.writeFileSync(f.input.persistence, 'not a dump');
    expect(() => createBackup(f.input)).toThrow('backup-native-dump-required');
  });
  it('detects source mutation while copying and leaves no completed manifest', () => {
    const f = fixture(),
      original = fs.readdirSync;
    let seen = 0;
    vi.spyOn(fs, 'readdirSync').mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
      if (args[0] === f.input.roots.workspaces && ++seen === 2)
        fs.writeFileSync(join(f.input.roots.workspaces, 'source.bin'), 'changed');
      return original(...args);
    });
    expect(() => createBackup(f.input)).toThrow('backup-source-changed');
    expect(fs.existsSync(join(f.input.destination, 'manifest.json'))).toBe(false);
  });
  it('keeps an incomplete restore visibly incomplete after a write failure', () => {
    const f = fixture(),
      restore = f.saved(),
      original = fs.writeFileSync;
    let writes = 0;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (++writes === 3) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return original(...args);
      },
    );
    expect(() => stageRestore(restore)).toThrow('disk full');
    expect(fs.existsSync(join(restore.destination, '.restore-incomplete'))).toBe(true);
    expect(fs.existsSync(join(restore.destination, 'RESTORE.json'))).toBe(false);
    expect(fs.readFileSync(join(f.input.roots.receipts, 'permission.json'))).toEqual(f.receipt);
    vi.restoreAllMocks();
    expect(() => stageRestore(restore)).toThrow('EEXIST');
  });
  it('does not publish a manifest on a failed backup write', () => {
    const f = fixture();
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('backup write denied');
    });
    expect(() => createBackup(f.input)).toThrow('backup write denied');
    expect(fs.existsSync(join(f.input.destination, 'manifest.json'))).toBe(false);
  });
  it('verifies the separately retained manifest hash before creating a restore directory', () => {
    const f = fixture(),
      restore = f.saved(),
      file = join(restore.backup, 'manifest.json');
    expect(() => stageRestore({ ...restore, manifest: { ...restore.manifest, bytes: 0 } })).toThrow(
      'backup-manifest-corrupted',
    );
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('agent-workflow-backup', 'untrusted-backup'),
    );
    expect(() => stageRestore(restore)).toThrow('backup-manifest-corrupted');
    expect(fs.existsSync(restore.destination)).toBe(false);
  });
  it.each(['corrupt', 'missing', 'link'])(
    'verifies every blob before creating the restored tree: %s',
    (kind) => {
      const f = fixture(),
        restore = f.saved(),
        file = join(restore.backup, 'blobs', digest(f.fail));
      if (kind === 'corrupt') fs.writeFileSync(file, 'changed');
      else {
        fs.unlinkSync(file);
        if (kind === 'link') fs.symlinkSync(join(f.input.roots.artifacts, digest(f.fail)), file);
      }
      expect(() => stageRestore(restore)).toThrow();
      expect(fs.existsSync(restore.destination)).toBe(false);
    },
  );
  it.each([
    [
      'version',
      (m: Record<string, unknown>) => {
        m.schemaVersion = 3;
      },
      'backup-manifest-version',
    ],
    [
      'kind',
      (m: Record<string, unknown>) => {
        m.kind = 'other';
      },
      'backup-manifest-version',
    ],
    [
      'reconciliation',
      (m: Record<string, unknown>) => {
        m.requiresReconciliation = false;
      },
      'backup-manifest-version',
    ],
    [
      'format',
      (m: Record<string, unknown>) => {
        (m.persistence as Record<string, unknown>).format = 'sqlite';
      },
      'backup-persistence-format',
    ],
    [
      'entries',
      (m: Record<string, unknown>) => {
        m.entries = null;
      },
      'backup-entries-required',
    ],
    [
      'missing',
      (m: Record<string, unknown>) => {
        m.entries = [];
      },
      'backup-component-missing',
    ],
    [
      'duplicate',
      (m: Record<string, unknown>) => {
        (m.entries as unknown[]).push((m.entries as unknown[])[0]);
      },
      'backup-duplicate-path',
    ],
    [
      'traversal',
      (m: Record<string, unknown>) => {
        (m.entries as Record<string, unknown>[])[0]!.path = '../escape';
      },
      'invalid-relative-path',
    ],
    [
      'component',
      (m: Record<string, unknown>) => {
        (m.entries as Record<string, unknown>[])[0]!.path = 'foreign';
      },
      'backup-component-invalid',
    ],
    [
      'executable',
      (m: Record<string, unknown>) => {
        (m.entries as Record<string, unknown>[])[0]!.executable = 'yes';
      },
      'backup-executable-invalid',
    ],
    [
      'directory',
      (m: Record<string, unknown>) => {
        (m.entries as Record<string, unknown>[])[0]!.executable = true;
      },
      'backup-directory-mode',
    ],
    [
      'root-file',
      (m: Record<string, unknown>) => {
        (m.entries as Record<string, unknown>[])[0]!.content = (
          m.persistence as Record<string, unknown>
        ).content;
      },
      'backup-component-directory-required',
    ],
    [
      'parent',
      (m: Record<string, unknown>) => {
        (m.entries as Record<string, unknown>[])[1]!.path = 'artifacts/absent/nested';
      },
      'backup-parent-missing',
    ],
  ] as const)('rejects malformed or unsafe manifests: %s', (_label, mutate, error) => {
    const f = fixture(),
      restore = f.altered(mutate);
    expect(() => stageRestore(restore)).toThrow(error);
    expect(fs.existsSync(restore.destination)).toBe(false);
  });
  it('rejects a fake persistence blob even when a forged manifest pins its bytes', () => {
    const f = fixture(),
      bytes = Buffer.from('not native');
    const restore = f.altered((manifest) => {
      fs.writeFileSync(join(f.input.destination, 'blobs', digest(bytes)), bytes);
      (manifest.persistence as Record<string, unknown>).content = {
        sha256: digest(bytes),
        bytes: bytes.length,
      };
    });
    expect(() => stageRestore(restore)).toThrow('backup-native-dump-required');
  });
  it('refuses missing or non-directory blob storage without repairing the backup', () => {
    const f = fixture(),
      restore = f.saved(),
      blobs = join(restore.backup, 'blobs');
    fs.rmSync(blobs, { recursive: true });
    expect(() => stageRestore(restore)).toThrow('ENOENT');
    expect(fs.existsSync(blobs)).toBe(false);
    fs.writeFileSync(blobs, 'file');
    expect(() => stageRestore(restore)).toThrow('backup-blobs-directory');
  });
  it('requires absolute unlinked and disjoint roots and exact versioned inputs', () => {
    const f = fixture(),
      restore = f.saved();
    expect(parseBackupInput(f.input)).toEqual(f.input);
    expect(parseRestoreInput(restore)).toEqual(restore);
    expect(() => parseBackupInput({ ...f.input, schemaVersion: 2 })).toThrow(
      'backup-input-version',
    );
    expect(() => parseRestoreInput({ ...restore, schemaVersion: 2 })).toThrow(
      'backup-input-version',
    );
    for (const persistence of [null, 'relative'])
      expect(() => parseBackupInput({ ...f.input, persistence })).toThrow(
        'backup-absolute-path-required',
      );
    for (const destination of [1, 'relative'])
      expect(() => parseRestoreInput({ ...restore, destination })).toThrow(
        'backup-absolute-path-required',
      );
    for (const destination of [f.input.roots.artifacts, join(f.input.roots.artifacts, 'nested')])
      expect(() => parseBackupInput({ ...f.input, destination })).toThrow(
        'backup-overlapping-paths',
      );
    expect(() =>
      parseRestoreInput({ ...restore, destination: join(restore.backup, 'nested') }),
    ).toThrow('backup-overlapping-paths');
    expect(() =>
      parseBackupInput({ ...f.input, roots: { ...f.input.roots, build: f.input.persistence } }),
    ).toThrow('backup-root-type');
    expect(() => parseBackupInput({ ...f.input, extra: true })).toThrow('unexpected-fields');
    fs.symlinkSync(f.input.roots.artifacts, join(f.root, 'linked'));
    expect(() =>
      parseBackupInput({
        ...f.input,
        roots: { ...f.input.roots, artifacts: join(f.root, 'linked') },
      }),
    ).toThrow('backup-linked-path');
    expect(() =>
      parseRestoreInput({ ...restore, destination: join(f.root, 'linked', 'new') }),
    ).toThrow('backup-linked-path');
  });
  it('provides the same save/restore through a local CLI without contacting Temporal or models', () => {
    const f = fixture(),
      save = join(f.root, 'save.json');
    fs.writeFileSync(save, JSON.stringify(f.input));
    const result = backupCommand(['save', save]);
    if (!('manifest' in result)) throw new Error('save manifest missing');
    const config = join(f.root, 'restore.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        backup: f.input.destination,
        manifest: result.manifest,
        destination: join(f.root, 'restored'),
      }),
    );
    expect(backupCommand(['restore', config])).toMatchObject({
      status: 'staged',
      requiresReconciliation: true,
    });
    for (const args of [
      [],
      ['save'],
      ['other', config],
      ['restore', ''],
      ['save', save, 'extra'],
      new Array<string>(2),
    ])
      expect(() => backupCommand(args)).toThrow('Usage: backup');
  });
  it('copies selected file boundaries independently of PostgreSQL and reports their limited scope', () => {
    const f = fixture(),
      projections = join(f.root, 'projections');
    fs.mkdirSync(projections);
    fs.writeFileSync(join(projections, 'index.json'), '{"derived":true}');
    const input = {
      schemaVersion: 2,
      roots: { artifacts: f.input.roots.artifacts, projections },
      destination: f.input.destination,
    };
    const save = join(f.root, 'file-save.json');
    fs.writeFileSync(save, JSON.stringify(input));
    const result = backupCommand(['save', save]),
      verify = join(f.root, 'verify.json');
    if (!('manifest' in result)) throw new Error('save manifest missing');
    fs.writeFileSync(
      verify,
      JSON.stringify({ schemaVersion: 1, backup: input.destination, manifest: result.manifest }),
    );
    expect(backupCommand(['verify', verify])).toMatchObject({
      scope: 'files-only',
      components: ['artifacts', 'projections'],
    });
    fs.rmSync(projections, { recursive: true });
    const destination = join(f.root, 'file-staged');
    expect(
      stageRestore({
        schemaVersion: 1,
        backup: input.destination,
        manifest: result.manifest,
        destination,
      }).requiresReconciliation,
    ).toBe(true);
    expect(fs.readFileSync(join(destination, 'projections/index.json'), 'utf8')).toBe(
      '{"derived":true}',
    );
    expect(fs.existsSync(join(destination, 'persistence'))).toBe(false);
  });
  it('inspects deterministic file inventory without publication and pins the same save manifest', () => {
    const f = fixture(),
      input = {
        schemaVersion: 2,
        roots: { workspaces: f.input.roots.workspaces, artifacts: f.input.roots.artifacts },
        destination: f.input.destination,
      },
      first = inspectFileBackup(input),
      reversed = inspectFileBackup({
        ...input,
        roots: { artifacts: f.input.roots.artifacts, workspaces: f.input.roots.workspaces },
      });
    expect(first).toEqual(reversed);
    expect(fs.existsSync(input.destination)).toBe(false);
    const bytes = Buffer.from(JSON.stringify(first.inventory));
    expect(first.manifest).toEqual({ sha256: digest(bytes), bytes: bytes.length });
    expect(bytes.at(-1)).toBe('}'.charCodeAt(0));
    expect(createBackup(input, first.manifest).manifest).toEqual(first.manifest);
  });
  it('does not publish unapproved bytes inserted after preflight and before the first write', () => {
    const f = fixture(),
      input = {
        schemaVersion: 2,
        roots: { artifacts: f.input.roots.artifacts },
        destination: f.input.destination,
      },
      approved = inspectFileBackup(input),
      unapproved = Buffer.from('unapproved private bytes'),
      original = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation((...args: Parameters<typeof fs.mkdirSync>) => {
      if (args[0] === input.destination)
        fs.writeFileSync(join(f.input.roots.artifacts, 'zz-unapproved'), unapproved);
      return original(...args);
    });
    expect(() => createBackup(input, approved.manifest)).toThrow('backup-source-changed');
    expect(fs.existsSync(join(input.destination, '.backup-incomplete'))).toBe(true);
    expect(fs.existsSync(join(input.destination, 'manifest.json'))).toBe(false);
    expect(fs.existsSync(join(input.destination, 'blobs', digest(unapproved)))).toBe(false);
    const permitted = new Set(
      approved.inventory.entries.flatMap((entry) =>
        entry.content === null ? [] : [entry.content.sha256],
      ),
    );
    expect(
      fs.readdirSync(join(input.destination, 'blobs')).every((hash) => permitted.has(hash)),
    ).toBe(true);
  });
  it('rejects an approved manifest mismatch before creating a destination', () => {
    const f = fixture(),
      input = {
        schemaVersion: 2,
        roots: { artifacts: f.input.roots.artifacts },
        destination: f.input.destination,
      },
      approved = inspectFileBackup(input);
    expect(() =>
      createBackup(input, { ...approved.manifest, bytes: approved.manifest.bytes + 1 }),
    ).toThrow('backup-approved-manifest-mismatch');
    expect(fs.existsSync(input.destination)).toBe(false);
    fs.writeFileSync(join(f.input.roots.artifacts, 'unapproved-before-call'), 'private');
    expect(() => createBackup(input, approved.manifest)).toThrow(
      'backup-approved-manifest-mismatch',
    );
    expect(fs.existsSync(input.destination)).toBe(false);
  });
  it.each(['bytes', 'mode', 'type', 'path'])(
    'refuses post-preflight changes to approved %s before publishing the entry',
    (kind) => {
      const f = fixture(),
        source = join(f.input.roots.artifacts, digest(f.fail)),
        input = {
          schemaVersion: 2,
          roots: { artifacts: f.input.roots.artifacts },
          destination: f.input.destination,
        },
        approved = inspectFileBackup(input),
        original = fs.mkdirSync;
      let writes = 0;
      const write = fs.writeFileSync;
      vi.spyOn(fs, 'writeFileSync').mockImplementation(
        (...args: Parameters<typeof fs.writeFileSync>) => {
          if (Buffer.isBuffer(args[1]) && args[1].equals(f.fail)) writes++;
          return write(...args);
        },
      );
      vi.spyOn(fs, 'mkdirSync').mockImplementation((...args: Parameters<typeof fs.mkdirSync>) => {
        if (args[0] === input.destination) {
          if (kind === 'bytes') fs.writeFileSync(source, 'private changed bytes');
          else if (kind === 'mode') fs.chmodSync(source, 0o700);
          else if (kind === 'type') {
            fs.unlinkSync(source);
            original(source);
          } else write(join(f.input.roots.artifacts, 'zz-unapproved-path'), f.fail);
        }
        return original(...args);
      });
      expect(() => createBackup(input, approved.manifest)).toThrow('backup-source-changed');
      expect(fs.existsSync(join(input.destination, '.backup-incomplete'))).toBe(true);
      expect(fs.existsSync(join(input.destination, 'manifest.json'))).toBe(false);
      expect(fs.readdirSync(join(input.destination, 'blobs'))).toEqual(
        kind === 'path' ? [digest(f.fail)] : [],
      );
      expect(writes).toBe(kind === 'path' ? 1 : 0);
    },
  );
  it('checks the native dump before publishing it after a preflight race', () => {
    const f = fixture(),
      original = fs.mkdirSync,
      unapproved = Buffer.from('PGDMP\0unapproved native dump');
    vi.spyOn(fs, 'mkdirSync').mockImplementation((...args: Parameters<typeof fs.mkdirSync>) => {
      if (args[0] === f.input.destination) fs.writeFileSync(f.input.persistence, unapproved);
      return original(...args);
    });
    expect(() => createBackup(f.input)).toThrow('backup-source-changed');
    expect(fs.readdirSync(join(f.input.destination, 'blobs'))).toEqual([]);
    expect(fs.existsSync(join(f.input.destination, 'manifest.json'))).toBe(false);
    expect(fs.existsSync(join(f.input.destination, 'blobs', digest(unapproved)))).toBe(false);
  });
  it.each([
    [{ schemaVersion: 3, roots: {} }, 'unexpected-fields'],
    [{ schemaVersion: 2, roots: {} }, 'backup-component-missing'],
    [{ schemaVersion: 2, roots: { foreign: '/tmp' } }, 'backup-component-invalid'],
  ])('rejects incomplete file-only declarations', (partial, error) => {
    const f = fixture();
    expect(() => createBackup({ ...partial, destination: f.input.destination })).toThrow(error);
  });
  it('rejects an incomplete marker even when a manifest was published before a crash', () => {
    const f = fixture(),
      restore = f.saved();
    fs.writeFileSync(join(restore.backup, '.backup-incomplete'), 'incomplete');
    expect(() => stageRestore(restore)).toThrow('backup-incomplete');
    expect(fs.existsSync(restore.destination)).toBe(false);
  });
  it('rejects hard-linked backup blobs before staging', () => {
    const f = fixture(),
      restore = f.saved();
    fs.linkSync(join(restore.backup, 'blobs', digest(f.fail)), join(f.root, 'hardlink'));
    expect(() => stageRestore(restore)).toThrow('backup-plain-file-required');
  });
});
