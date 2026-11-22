import * as fs from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import * as physical from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  engineDirectories,
  freezeComparisonSnapshot,
  materializeComparisonSnapshot,
  verifyComparisonClient,
  verifyComparisonMaterial,
  verifyComparisonSnapshot,
} from '../adapters/project/comparisonInputs.js';
import { readPrivateFile } from '../adapters/storage/storeFiles.js';
import * as store from '../adapters/storage/storeFiles.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import type { InputRef } from '../core/localRun.js';
import { filePointer, locatedPath, locationsName } from '../adapters/storage/fileLocations.js';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof physical>()),
}));

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    symlink: vi.fn(actual.symlink),
  };
});
let root: string, sources: string, snapshots: string, modules: string, destination: string;
const exec = promisify(execFile);
const file = async (path: string, text: string) => {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text);
};
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'comparison-inputs-')));
  sources = resolve(root, 'source');
  snapshots = resolve(root, 'snapshots');
  destination = resolve(root, 'copy');
  modules = await fs.realpath(resolve(import.meta.dirname, '../node_modules'));
  await fs.mkdir(snapshots);
  await file(resolve(sources, 'AGENTS.md'), 'rules');
  await file(resolve(sources, 'package.json'), '{"type":"module"}');
  await file(resolve(sources, 'yarn.lock'), 'lock');
  await file(resolve(sources, 'docs/plan.md'), 'plan');
  await file(resolve(sources, '.agents/README.md'), 'fixture skills');
  await file(
    resolve(sources, 'tools/agent-workflow/adapters/codex/currentChatHost.ts'),
    'export const isSupportedChatClientVersion = (v: string) => v === "0.164.0";',
  );
  await file(resolve(sources, 'tools/agent-workflow/empty'), '');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const snapshot = () => freezeComparisonSnapshot(sources, null, snapshots);
const changedSnapshot = async (
  change: (value: Record<string, unknown>) => void,
): Promise<InputRef> => {
  const ref = await snapshot();
  const value = JSON.parse(readPrivateFile(ref.locator).toString('utf8')) as Record<
    string,
    unknown
  >;
  change(value);
  const bytes = canonical(value) + '\n';
  const locator = resolve(snapshots, 'changed.json');
  await file(locator, bytes);
  return { locator, hash: digest(bytes) };
};
it('freezes a tree once, reproduces immutable bytes and shares the identical dependency runtime', async () => {
  const ref = await snapshot();
  expect(await snapshot()).toEqual(ref);
  await materializeComparisonSnapshot(ref, destination, modules);
  await materializeComparisonSnapshot(ref, destination, modules);
  await verifyComparisonSnapshot(ref, destination);
  expect(await fs.realpath(resolve(destination, 'node_modules'))).toBe(modules);
  expect(await fs.readFile(resolve(destination, 'tools/agent-workflow/empty'), 'utf8')).toBe('');
  await file(resolve(destination, 'docs/new.md'), 'changed');
  await expect(verifyComparisonSnapshot(ref, destination)).rejects.toThrow(
    'comparison-workspace-changed',
  );
  await fs.rm(resolve(destination, 'docs/new.md'));
  await file(resolve(destination, 'AGENTS.md'), 'tampered');
  await expect(materializeComparisonSnapshot(ref, destination, modules)).rejects.toThrow(
    'comparison-workspace-changed',
  );
  await expect(verifyComparisonSnapshot(ref, destination)).rejects.toThrow(
    'comparison-workspace-changed',
  );
});
it('uses an exact immutable Git revision instead of current uncommitted files', async () => {
  await exec('git', ['init', '-q'], { cwd: sources });
  await exec('git', ['add', '.'], { cwd: sources });
  await exec(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
    { cwd: sources },
  );
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: sources })).stdout.trim();
  await file(resolve(sources, 'AGENTS.md'), 'changed');
  const ref = await freezeComparisonSnapshot(sources, revision, snapshots);
  await materializeComparisonSnapshot(ref, destination, modules);
  expect(await fs.readFile(resolve(destination, 'AGENTS.md'), 'utf8')).toBe('rules');
  await expect(freezeComparisonSnapshot(sources, 'HEAD', snapshots)).rejects.toThrow(
    'comparison-source-revision-unpinned',
  );
  const empty = resolve(root, 'empty');
  await fs.mkdir(empty);
  await exec('git', ['init', '-q'], { cwd: empty });
  await exec(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'empty',
    ],
    { cwd: empty },
  );
  const rev = (await exec('git', ['rev-parse', 'HEAD'], { cwd: empty })).stdout.trim();
  await expect(freezeComparisonSnapshot(empty, rev, snapshots)).rejects.toThrow(
    'comparison-source-incomplete',
  );
});
it('materializes and verifies the standalone client from working and pinned variants', async () => {
  const host = 'adapters/codex/currentChatHost.ts';
  await file(resolve(sources, 'CURRENT-CHAT.md'), 'standalone guide');
  await file(
    resolve(sources, host),
    await fs.readFile(resolve(sources, 'tools/agent-workflow', host), 'utf8'),
  );
  for (const directory of engineDirectories)
    await file(resolve(sources, directory, 'fixture.txt'), directory);
  await exec('git', ['init', '-q'], { cwd: sources });
  await exec('git', ['add', '.'], { cwd: sources });
  await exec(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'standalone',
    ],
    { cwd: sources },
  );
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: sources })).stdout.trim();
  const binary = resolve(root, 'version');
  await file(binary, '#!/bin/sh\necho codex 0.164.0\n');
  await fs.chmod(binary, 0o700);
  for (const selected of [null, revision]) {
    const ref = await freezeComparisonSnapshot(sources, selected, snapshots);
    const target = resolve(root, selected ?? 'working');
    await materializeComparisonSnapshot(ref, target, modules);
    await verifyComparisonSnapshot(ref, target);
    expect(await fs.readFile(resolve(target, 'CURRENT-CHAT.md'), 'utf8')).toBe('standalone guide');
    expect(await verifyComparisonClient(target, binary)).toBe('0.164.0');
  }
});
it.each(['AGENTS.md', 'package.json', 'yarn.lock'])(
  'rejects missing %s in a standalone working tree and its pinned revision',
  async (missing) => {
    await file(resolve(sources, 'adapters/codex/currentChatHost.ts'), 'export {};');
    for (const directory of engineDirectories)
      await fs.mkdir(resolve(sources, directory), { recursive: true });
    await fs.rm(resolve(sources, missing));
    await expect(snapshot()).rejects.toMatchObject({
      code: 'ENOENT',
      path: resolve(sources, missing),
    });
    await exec('git', ['init', '-q'], { cwd: sources });
    await exec('git', ['add', '.'], { cwd: sources });
    await exec(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'incomplete',
      ],
      { cwd: sources },
    );
    const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: sources })).stdout.trim();
    await file(resolve(sources, missing), 'restored only in the working tree');
    await expect(freezeComparisonSnapshot(sources, revision, snapshots)).rejects.toThrow(
      'comparison-source-incomplete',
    );
    expect(await fs.readdir(snapshots)).toEqual([]);
  },
);
it('requires one compatible installed client in each actual copied variant', async () => {
  await materializeComparisonSnapshot(await snapshot(), destination, modules);
  const binary = resolve(root, 'codex');
  await file(binary, '#!/bin/sh\necho codex-cli 0.164.0\n');
  await fs.chmod(binary, 0o700);
  expect(await verifyComparisonClient(destination, binary)).toBe('0.164.0');
  await file(binary, '#!/bin/sh\necho codex-cli 0.140.0\n');
  await expect(verifyComparisonClient(destination, binary)).rejects.toThrow(
    'comparison-common-client-unsupported',
  );
});
it('preserves mutable case files while refusing changed acceptance material', async () => {
  await file(resolve(root, 'target'), 'new');
  await file(resolve(root, 'checks'), 'original');
  await verifyComparisonMaterial(root, { target: 'old', checks: 'original' }, ['target']);
  await expect(verifyComparisonMaterial(root, { checks: 'changed' }, [])).rejects.toThrow(
    'comparison-material-changed',
  );
});
it.each([
  ['mutable internal symlink', true, 'inside'],
  ['mutable outside symlink', true, 'outside'],
  ['immutable same-bytes symlink', false, 'outside'],
  ['mutable hardlink', true, 'hardlink'],
  ['immutable hardlink', false, 'hardlink'],
  ['missing mutable', true, 'missing'],
  ['mutable parent alias', true, 'parent'],
] as const)('rejects %s as comparison material', async (_name, mutable, kind) => {
  const workspace = resolve(root, 'case');
  await fs.mkdir(workspace);
  const outside = resolve(root, 'outside.mjs');
  await file(outside, 'original');
  let locator = 'target.mjs';
  if (kind === 'inside') {
    const inside = resolve(workspace, 'original.mjs');
    await file(inside, 'original');
    await fs.symlink(inside, resolve(workspace, locator));
  } else if (kind === 'outside') await fs.symlink(outside, resolve(workspace, locator));
  else if (kind === 'hardlink') await fs.link(outside, resolve(workspace, locator));
  else if (kind === 'parent') {
    const parent = resolve(root, 'outside-directory');
    await file(resolve(parent, locator), 'original');
    await fs.symlink(parent, resolve(workspace, 'parent'));
    locator = 'parent/' + locator;
  }
  await expect(
    verifyComparisonMaterial(workspace, { [locator]: 'original' }, mutable ? [locator] : []),
  ).rejects.toThrow();
});
it('preserves nested mutable edits, extra evidence and literal file-location bytes', async () => {
  const workspace = resolve(root, 'case');
  const entry = {
    hash: digest('archived bytes'),
    bytes: 14,
    mode: 0o600,
    kind: 'archive' as const,
  };
  const pointer = filePointer(entry.hash);
  const locator = 'nested/checks.mjs';
  await file(resolve(workspace, locator), pointer);
  await file(resolve(workspace, 'nested/target.mjs'), 'edited mutable');
  await file(resolve(workspace, 'evidence/manifest.json'), '{"locator":"/external","hash":"data"}');
  await file(locatedPath(workspace, locator, entry), 'archived bytes');
  await file(
    resolve(workspace, locationsName),
    JSON.stringify({
      schema_version: 1,
      root: workspace,
      operation_hash: 'fixture',
      complete: true,
      files: { [locator]: entry },
    }),
  );
  expect(readPrivateFile(resolve(workspace, locator)).toString()).toBe('archived bytes');
  await verifyComparisonMaterial(
    workspace,
    {
      [locator]: pointer,
      'nested/target.mjs': 'original mutable',
    },
    ['nested/target.mjs'],
  );
  await expect(
    verifyComparisonMaterial(workspace, { [locator]: 'archived bytes' }, []),
  ).rejects.toThrow('comparison-material-changed');
  expect(await fs.readFile(resolve(workspace, 'evidence/manifest.json'), 'utf8')).toBe(
    '{"locator":"/external","hash":"data"}',
  );
});
it.each(['directory', 'root-alias', 'escape', 'invalid-utf8'] as const)(
  'rejects %s physical material',
  async (kind) => {
    const workspace = resolve(root, 'case');
    await fs.mkdir(workspace);
    let base = workspace,
      locator = 'target.mjs';
    if (kind === 'directory') await fs.mkdir(resolve(base, locator));
    else if (kind === 'root-alias') {
      await file(resolve(workspace, locator), 'original');
      base = resolve(root, 'case-alias');
      await fs.symlink(workspace, base);
    } else if (kind === 'escape') {
      await file(resolve(root, locator), 'original');
      locator = '../' + locator;
    } else await fs.writeFile(resolve(workspace, locator), Buffer.from([0xff]));
    await expect(
      verifyComparisonMaterial(
        base,
        { [locator]: kind === 'invalid-utf8' ? '\uFFFD' : 'original' },
        [],
      ),
    ).rejects.toThrow();
  },
);
it.each(['replacement', 'hardlink', 'directory', 'symlink'] as const)(
  'rejects an open-time %s and closes every opened descriptor',
  async (kind) => {
    const target = resolve(root, 'target.mjs'),
      outside = resolve(root, 'outside.mjs');
    await file(target, 'original');
    await file(outside, 'original');
    const open = physical.openSync;
    let descriptor: number | undefined;
    vi.spyOn(physical, 'openSync').mockImplementationOnce((path, flags) => {
      physical.renameSync(target, target + '.before');
      if (kind === 'replacement') physical.writeFileSync(target, 'original');
      else if (kind === 'hardlink') physical.linkSync(outside, target);
      else if (kind === 'directory') physical.mkdirSync(target);
      else physical.symlinkSync(outside, target);
      descriptor = open(path, flags);
      return descriptor;
    });
    await expect(
      verifyComparisonMaterial(root, { 'target.mjs': 'original' }, ['target.mjs']),
    ).rejects.toThrow();
    if (kind === 'symlink') expect(descriptor).toBeUndefined();
    else expect(() => physical.fstatSync(descriptor!)).toThrow(/EBADF/u);
  },
);
it.each(['content', 'path', 'parent-alias', 'read-error'] as const)(
  'rejects a read-time %s and closes its descriptor',
  async (kind) => {
    const workspace = resolve(root, 'case'),
      parent = resolve(workspace, 'nested');
    const target = resolve(parent, 'target.mjs');
    await file(target, 'original');
    const read = physical.readFileSync;
    let descriptor: number | undefined;
    vi.spyOn(physical, 'readFileSync').mockImplementationOnce((fd) => {
      expect(typeof fd).toBe('number');
      descriptor = fd as number;
      if (kind === 'read-error') throw new Error('read denied');
      const bytes = read(fd);
      if (kind === 'content') physical.writeFileSync(target, 'changed length');
      else if (kind === 'path') {
        physical.renameSync(target, target + '.before');
        physical.writeFileSync(target, 'original');
      } else {
        const moved = resolve(root, 'moved-parent');
        physical.renameSync(parent, moved);
        physical.symlinkSync(moved, parent);
      }
      return bytes;
    });
    await expect(
      verifyComparisonMaterial(workspace, { 'nested/target.mjs': 'original' }, [
        'nested/target.mjs',
      ]),
    ).rejects.toThrow();
    expect(() => physical.fstatSync(descriptor!)).toThrow(/EBADF/u);
  },
);
it.each(['parent', 'root'] as const)(
  'refuses a persistent %s alias inserted before lstat without reading its opened file',
  async (kind) => {
    const workspace = resolve(root, 'case'),
      parent = resolve(workspace, 'nested'),
      target = resolve(parent, 'target.mjs'),
      outside = resolve(root, 'outside');
    await file(target, 'original');
    await file(
      resolve(outside, kind === 'parent' ? 'target.mjs' : 'nested/target.mjs'),
      'outside secret',
    );
    const stat = physical.lstatSync,
      open = physical.openSync;
    let injected = false,
      descriptor: number | undefined;
    vi.spyOn(physical, 'lstatSync').mockImplementation((path) => {
      if (path === target && !injected) {
        injected = true;
        const alias = kind === 'parent' ? parent : workspace;
        physical.renameSync(alias, resolve(root, 'original-directory'));
        physical.symlinkSync(outside, alias);
      }
      return stat(path);
    });
    vi.spyOn(physical, 'openSync').mockImplementationOnce((path, flags) => {
      descriptor = open(path, flags);
      return descriptor;
    });
    const read = vi.spyOn(physical, 'readFileSync');
    await expect(
      verifyComparisonMaterial(workspace, { 'nested/target.mjs': 'original' }, [
        'nested/target.mjs',
      ]),
    ).rejects.toThrow();
    expect(injected).toBe(true);
    expect(descriptor).toBeTypeOf('number');
    expect(read.mock.calls.filter(([fd]) => fd === descriptor)).toEqual([]);
    expect(() => physical.fstatSync(descriptor!)).toThrow(/EBADF/u);
    expect((await fs.lstat(kind === 'parent' ? parent : workspace)).isSymbolicLink()).toBe(true);
  },
);
it('refuses an outside path returned after a root alias without opening or reading it', async () => {
  const workspace = resolve(root, 'case'),
    outside = resolve(root, 'outside');
  await file(resolve(workspace, 'target.mjs'), 'original');
  await file(resolve(outside, 'target.mjs'), 'outside secret');
  const realpath = fs.realpath;
  vi.spyOn(fs, 'realpath').mockImplementationOnce(async (path) => {
    expect(path).toBe(workspace);
    physical.renameSync(workspace, resolve(root, 'original-directory'));
    physical.symlinkSync(outside, workspace);
    return realpath(path);
  });
  const open = vi.spyOn(physical, 'openSync'),
    read = vi.spyOn(physical, 'readFileSync');
  await expect(
    verifyComparisonMaterial(workspace, { 'target.mjs': 'original' }, ['target.mjs']),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it('refuses an outside base returned by the initial directory check without opening it', async () => {
  const workspace = resolve(root, 'case'),
    outside = resolve(root, 'outside');
  await file(resolve(workspace, 'target.mjs'), 'original');
  await file(resolve(outside, 'target.mjs'), 'outside secret');
  const realpath = physical.realpathSync;
  vi.spyOn(physical, 'realpathSync').mockImplementationOnce((path) => {
    expect(path).toBe(workspace);
    physical.renameSync(workspace, resolve(root, 'original-directory'));
    physical.symlinkSync(outside, workspace);
    return realpath(path);
  });
  const open = vi.spyOn(physical, 'openSync'),
    read = vi.spyOn(physical, 'readFileSync');
  await expect(
    verifyComparisonMaterial(workspace, { 'target.mjs': 'original' }, ['target.mjs']),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it('refuses a path replaced after fstat without reading the original open descriptor', async () => {
  const target = resolve(root, 'target.mjs');
  await file(target, 'original');
  const stat = physical.fstatSync;
  let descriptor: number | undefined;
  vi.spyOn(physical, 'fstatSync').mockImplementationOnce((fd) => {
    descriptor = fd;
    const value = stat(fd);
    physical.renameSync(target, target + '.before');
    physical.writeFileSync(target, 'replacement');
    return value;
  });
  const read = vi.spyOn(physical, 'readFileSync');
  await expect(
    verifyComparisonMaterial(root, { 'target.mjs': 'original' }, ['target.mjs']),
  ).rejects.toThrow();
  expect(read.mock.calls.filter(([fd]) => fd === descriptor)).toEqual([]);
  expect(() => physical.fstatSync(descriptor!)).toThrow(/EBADF/u);
});
it.each([
  (value: Record<string, unknown>) => {
    value.schema_version = 2;
  },
  (value: Record<string, unknown>) => {
    value.files = [];
  },
  (value: Record<string, unknown>) => {
    value.files = [{ locator: '../outside', content: '', hash: digest('') }];
  },
  (value: Record<string, unknown>) => {
    value.files = [{ locator: 'AGENTS.md', content: null }];
  },
  (value: Record<string, unknown>) => {
    value.files = [{ locator: 'AGENTS.md', content: 'eA==', hash: 'bad' }];
  },
])('rejects an incomplete or altered snapshot %#', async (change) => {
  await expect(
    materializeComparisonSnapshot(await changedSnapshot(change), destination, modules),
  ).rejects.toThrow();
});
it('rejects source/runtime aliases, changed snapshots and unexpected I/O failures', async () => {
  const alias = resolve(root, 'alias');
  await fs.symlink(sources, alias);
  await expect(freezeComparisonSnapshot(alias, null, snapshots)).rejects.toThrow(
    'comparison-source-root-alias',
  );
  const ref = await snapshot();
  const bad = { ...ref, hash: 'bad' };
  await expect(materializeComparisonSnapshot(bad, destination, modules)).rejects.toThrow(
    'comparison-source-changed',
  );
  await expect(verifyComparisonSnapshot(bad, destination)).rejects.toThrow(
    'comparison-source-changed',
  );
  await fs.symlink(modules, resolve(root, 'module-alias'));
  await expect(
    materializeComparisonSnapshot(ref, destination, resolve(root, 'module-alias')),
  ).rejects.toThrow('comparison-runtime-alias');
  await fs.symlink(sources, resolve(destination, 'node_modules'));
  await expect(materializeComparisonSnapshot(ref, destination, modules)).rejects.toThrow(
    'comparison-runtime-alias',
  );
  await fs.rm(resolve(destination, 'node_modules'));
  vi.mocked(fs.symlink).mockRejectedValueOnce(new Error('symlink denied'));
  await expect(materializeComparisonSnapshot(ref, destination, modules)).rejects.toThrow(
    'symlink denied',
  );
  vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('write denied'));
  await expect(materializeComparisonSnapshot(ref, destination, modules)).rejects.toThrow(
    'write denied',
  );
  vi.spyOn(store, 'writePrivateFile').mockImplementationOnce(() => {
    throw new Error('snapshot denied');
  });
  await expect(snapshot()).rejects.toThrow('snapshot denied');
});
it('rejects a source race and an incomplete discovery before publishing a snapshot', async () => {
  const original = FileWorkflowInputs.prototype.capture;
  vi.spyOn(FileWorkflowInputs.prototype, 'capture').mockImplementationOnce(async function (
    this: FileWorkflowInputs,
    discovery,
    attested,
  ) {
    const manifest = await original.call(this, discovery, attested);
    await file(resolve(sources, 'AGENTS.md'), 'raced');
    return manifest;
  });
  await expect(snapshot()).rejects.toThrow('comparison-source-changed');
  vi.mocked(FileWorkflowInputs.prototype.capture).mockImplementationOnce(async function (
    this: FileWorkflowInputs,
    discovery,
    attested,
  ) {
    return {
      ...(await original.call(this, discovery, attested)),
      complete: false,
    };
  });
  await expect(snapshot()).rejects.toThrow('comparison-source-incomplete');
});
