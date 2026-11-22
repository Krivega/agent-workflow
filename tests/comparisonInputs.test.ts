import * as fs from 'node:fs/promises';
import * as physical from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { verifyComparisonMaterial } from '../adapters/project/comparisonInputs.js';
import { readPrivateFile } from '../adapters/storage/storeFiles.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { filePointer, locatedPath, locationsName } from '../adapters/storage/fileLocations.js';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof physical>()),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
}));

let root: string;
const file = async (path: string, text: string) => {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text);
};
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'comparison-inputs-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
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
