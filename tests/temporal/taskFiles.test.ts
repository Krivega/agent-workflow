import { join } from 'node:path';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
vi.mock('node:fs', async () => ({ ...(await vi.importActual<typeof fs>('node:fs')) }));
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { taskDelta, taskPathAllowed, taskPrivatePath } from '../../src/policy/localTask.js';
import type { TaskSnapshot, TaskIntegration } from '../../src/contracts/localTask.js';
import { localTaskFixture } from './localTaskFixture.js';
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const f = localTaskFixture();
  f.processes.wait = vi.fn(async () => {});
  const ref = await f.service.activities.prepareLocalTask(f.input),
    snapshot = f.read(ref) as unknown as TaskSnapshot,
    files = taskFiles(f.registration.artifactRoot);
  return { ...f, snapshot, files };
}
describe('isolated task files and conflict-safe integration', { timeout: 15000 }, () => {
  it('preserves a replacement failure even when temporary cleanup also fails', async () => {
    const f = await fixture(),
      version = f.snapshot.tree.files.find((f) => f.path === 'owner.cjs')!.version;
    expect(() =>
      f.files.replace(f.workspace, 'owner.cjs', {
        ...version,
        content: { sha256: '0'.repeat(64), bytes: 1 },
      }),
    ).toThrow();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    expect(() => f.files.replace(f.workspace, 'owner.cjs', version)).toThrow('rename failed');
    expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).toBe(
      'module.exports = name => name;\n',
    );
  });
  it('rejects changed source directory permissions and newly discovered empty directories', async () => {
    const f = await fixture(),
      s = f.snapshot;
    chmodSync(join(f.workspace, 'tasks'), 0o711);
    expect(() => f.files.sourceCurrent(s)).toThrow('task-source-directory-changed');
    chmodSync(join(f.workspace, 'tasks'), s.tree.directories.find((d) => d.path === 'tasks')!.mode);
    mkdirSync(join(f.workspace, 'scope'));
    s.plan.paths.push('scope');
    expect(() => f.files.sourceCurrent(s)).toThrow('task-discovery-changed');
  });
  it('deduplicates overlapping directory discoveries and retains multiple sorted directories', async () => {
    const f = await fixture();
    mkdirSync(join(f.workspace, 'a/b'), { recursive: true });
    writeFileSync(join(f.workspace, 'a/b/file'), 'value');
    const tree = f.files.capture(f.workspace, ['tasks', 'a', 'a/b']);
    expect(tree.directories.map((d) => d.path)).toEqual(['a', 'a/b', 'tasks']);
  });
  it('propagates unreadable inputs and cleanup failures without forging a version', async () => {
    const f = await fixture(),
      stat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path).endsWith('owner.cjs'))
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return Reflect.apply(stat, fs, [path, ...args]) as fs.Stats;
    }) as typeof fs.lstatSync);
    expect(() => f.files.version(f.workspace, 'owner.cjs')).toThrow('denied');
    vi.restoreAllMocks();
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (String(path).includes('.task-'))
        throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
      return unlink(path);
    });
    expect(() =>
      f.files.replace(
        f.workspace,
        'owner.cjs',
        f.snapshot.tree.files.find((f) => f.path === 'owner.cjs')!.version,
      ),
    ).toThrow('cleanup denied');
  });
  it('captures once, preserves file and directory modes, retries the same copy, and computes canonical deltas', async () => {
    const f = await fixture(),
      { files, snapshot: s } = f;
    expect(files.copy(s.source, s.tree, s.copy.root).tree).toEqual(s.tree);
    expect(files.capture(f.workspace, ['missing']).files).toEqual([]);
    expect(files.version(f.workspace, 'missing/nested/file')).toBeNull();
    expect(taskPathAllowed(['src'], 'src/a')).toBe(true);
    expect(taskPathAllowed(['src'], 'src2/a')).toBe(false);
    for (const name of ['.git/config', 'a/.ENV.local', 'a/key.PEM', '.ssh/id', 'node_modules/a'])
      expect(taskPrivatePath(name)).toBe(true);
    expect(taskPrivatePath('source/config.ts')).toBe(false);
    const file = s.tree.files[0]!;
    expect(
      taskDelta(s.tree, {
        ...s.tree,
        files: s.tree.files.map((f) => ({
          ...f,
          version: {
            mode: f.version.mode,
            content: { bytes: f.version.content.bytes, sha256: f.version.content.sha256 },
          },
        })),
      }),
    ).toEqual([]);
    expect(
      taskDelta({ files: [], directories: [] }, { files: [file], directories: [] }),
    ).toHaveLength(1);
    expect(
      taskDelta({ files: [file], directories: [] }, { files: [], directories: [] }),
    ).toHaveLength(1);
  });
  it.each(['symlink-file', 'hardlink', 'symlink-parent', 'alias-root', 'wrong-root', 'file-root'])(
    'rejects unsafe binding or path: %s',
    async (defect) => {
      const f = await fixture(),
        { files } = f;
      const copy = f.snapshot.copy.root;
      if (defect === 'symlink-file') {
        symlinkSync(join(f.workspace, 'owner.cjs'), join(copy, 'linked'));
        expect(() => files.tree(copy)).toThrow('task-path-unsafe');
        expect(() => files.version(copy, 'linked')).toThrow('task-file-unsafe');
      }
      if (defect === 'hardlink') {
        linkSync(join(copy, 'owner.cjs'), join(copy, 'linked'));
        expect(() => files.version(copy, 'linked')).toThrow('task-file-unsafe');
      }
      if (defect === 'symlink-parent') {
        symlinkSync(f.workspace, join(copy, 'dir'));
        expect(() => files.version(copy, 'dir/owner.cjs')).toThrow('task-path-unsafe');
      }
      if (defect === 'alias-root') {
        symlinkSync(copy, join(f.root, 'alias'));
        expect(() => files.binding(join(f.root, 'alias'))).toThrow('task-workspace-alias');
      }
      if (defect === 'wrong-root')
        expect(() => files.bound({ ...f.snapshot.copy, ino: 'foreign' })).toThrow(
          'task-workspace-changed',
        );
      if (defect === 'file-root')
        expect(() => files.binding(join(copy, 'owner.cjs'))).toThrow('task-workspace-invalid');
    },
  );
  it.each(['private', 'ignored', 'unsafe', 'copy-conflict', 'copy-foreign', 'source-changed'])(
    'rejects a changed or forbidden copy input: %s',
    async (defect) => {
      const f = await fixture(),
        { files, snapshot: s } = f;
      if (defect === 'private')
        expect(() => files.capture(f.workspace, ['.env.local'])).toThrow('task-private-input');
      if (defect === 'ignored') {
        writeFileSync(join(f.workspace, '.gitignore'), 'ignored\n');
        writeFileSync(join(f.workspace, 'ignored'), 'secret');
        expect(() => files.capture(f.workspace, ['ignored'])).toThrow('task-ignored-input');
      }
      if (defect === 'unsafe') {
        symlinkSync(join(f.workspace, 'owner.cjs'), join(f.workspace, 'alias'));
        expect(() => files.capture(f.workspace, ['alias'])).toThrow('task-path-unsafe');
      }
      if (defect === 'copy-conflict') {
        writeFileSync(join(s.copy.root, 'owner.cjs'), 'foreign');
        expect(() => files.copy(s.source, s.tree, s.copy.root)).toThrow('task-copy-conflict');
      }
      if (defect === 'copy-foreign') {
        const other = join(f.root, 'other');
        mkdirSync(other);
        writeFileSync(s.copy.root + '.binding.json', JSON.stringify(files.binding(other)));
        expect(() => files.copy(s.source, s.tree, s.copy.root)).toThrow('task-copy-binding');
      }
      if (defect === 'source-changed') {
        writeFileSync(join(f.workspace, 'owner.cjs'), 'foreign');
        expect(() => files.copy(s.source, s.tree, s.copy.root)).toThrow('task-source-changed');
      }
    },
  );
  it.each([
    'protected',
    'private',
    'empty-directory',
    'directory-mode',
    'removed-directory',
    'extra-source',
  ])('preserves scope and protected inputs: %s', async (defect) => {
    const f = await fixture(),
      { files, snapshot: s } = f;
    if (defect === 'protected') writeFileSync(join(s.copy.root, 'accepted.md'), 'new rules');
    if (defect === 'private') {
      s.plan.paths.push('scope');
      mkdirSync(join(s.copy.root, 'scope'));
      writeFileSync(join(s.copy.root, 'scope/.env'), 'secret');
    }
    if (defect === 'empty-directory') mkdirSync(join(s.copy.root, 'empty'));
    if (defect === 'directory-mode') chmodSync(join(s.copy.root, 'tasks'), 0o711);
    if (defect === 'removed-directory') rmSync(join(s.copy.root, 'tasks'), { recursive: true });
    if (defect === 'extra-source') {
      s.plan.paths = ['directory'];
      mkdirSync(join(f.workspace, 'directory'));
      writeFileSync(join(f.workspace, 'directory/foreign'), 'foreign');
      expect(() => files.sourceCurrent(s)).toThrow('task-discovery-changed');
      return;
    }
    expect(() => files.candidate(s)).toThrow();
  });
  it('retries a partial multi-file integration without rewriting an accepted file, including create/delete/mode changes', async () => {
    const f = await fixture(),
      { files, snapshot: s } = f;
    s.plan.paths = ['owner.cjs', 'consumer.cjs', 'tasks/added'];
    unlinkSync(join(s.copy.root, 'owner.cjs'));
    writeFileSync(join(s.copy.root, 'consumer.cjs'), 'replacement');
    chmodSync(join(s.copy.root, 'consumer.cjs'), 0o600);
    writeFileSync(join(s.copy.root, 'tasks/added'), 'new');
    const final = files.candidate(s),
      intent: TaskIntegration = {
        source: s.source,
        copy: s.copy,
        candidate: files.save(final),
        changes: taskDelta(s.tree, final),
        writer: {} as never,
      };
    let count = 0;
    await expect(
      files.integration(
        s,
        intent,
        (run) => run(),
        () => {
          if (++count === 2) throw new Error('crash between files');
        },
      ),
    ).rejects.toThrow('crash');
    await files.integration(s, intent, (run) => run());
    await files.integration(s, intent, (run) => run());
    for (const c of intent.changes) expect(files.version(f.workspace, c.path)).toEqual(c.after);
    expect(readFileSync(join(f.workspace, 'tasks/added'), 'utf8')).toBe('new');
  });
  it('yields between files so a revoked permission stops the remaining integration', async () => {
    const f = await fixture(),
      { files, snapshot: s } = f;
    s.plan.paths = ['owner.cjs', 'consumer.cjs'];
    for (const p of s.plan.paths) writeFileSync(join(s.copy.root, p), 'new');
    const final = files.candidate(s),
      intent = {
        source: s.source,
        copy: s.copy,
        candidate: files.save(final),
        changes: taskDelta(s.tree, final),
        writer: {} as never,
      };
    let active = true;
    await expect(
      files.integration(
        s,
        intent,
        (run) => {
          if (!active) throw new Error('revoked');
          run();
        },
        () => {
          setImmediate(() => {
            active = false;
          });
        },
      ),
    ).rejects.toThrow('revoked');
    expect(
      intent.changes.filter(
        (c) => JSON.stringify(files.version(f.workspace, c.path)) === JSON.stringify(c.after),
      ),
    ).toHaveLength(1);
  });
  it.each(['binding', 'candidate', 'delta', 'source'])(
    'rejects tampered integration: %s',
    async (defect) => {
      const f = await fixture(),
        { files, snapshot: s } = f;
      writeFileSync(join(s.copy.root, 'owner.cjs'), 'new');
      const final = files.candidate(s),
        intent = {
          source: s.source,
          copy: s.copy,
          candidate: files.save(final),
          changes: taskDelta(s.tree, final),
          writer: {} as never,
        };
      if (defect === 'binding') intent.source = { ...intent.source, ino: 'wrong' };
      if (defect === 'candidate') writeFileSync(join(s.copy.root, 'owner.cjs'), 'later');
      if (defect === 'delta') intent.changes = [];
      if (defect === 'source') writeFileSync(join(f.workspace, 'owner.cjs'), 'foreign');
      await expect(files.integration(s, intent, (run) => run())).rejects.toThrow();
    },
  );
  it('does not rebind a replaced copy inode', async () => {
    const f = await fixture(),
      s = f.snapshot;
    renameSync(s.copy.root, s.copy.root + '-old');
    mkdirSync(s.copy.root);
    expect(() => f.files.copy(s.source, s.tree, s.copy.root)).toThrow('task-workspace-changed');
  });
});
