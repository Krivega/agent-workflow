import { afterEach, expect, it, vi } from 'vitest';
import type * as Files from 'node:fs/promises';
import { lstat, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coderFixture } from './coderFixtures.js';
import { startCoder, runCoder, integrateCoder } from '../application/coderWorkflow.js';

vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof Files>('node:fs/promises');
  return { ...fs, lstat: vi.fn(fs.lstat), unlink: vi.fn(fs.unlink) };
});
let f: Awaited<ReturnType<typeof coderFixture>>;
afterEach(async () => {
  const actual = await vi.importActual<typeof Files>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(unlink).mockImplementation(actual.unlink);
  await f.dispose();
});
const io = () => Object.assign(Error('fixture disk I/O failure'), { code: 'EIO' });
it.each([1, 2])(
  'retains a source metadata failure at observation %s before reserving or copying',
  async (failAt) => {
    f = await coderFixture();
    const brief = await f.brief('one', ['source.txt']);
    const actual = await vi.importActual<typeof Files>('node:fs/promises');
    let reads = 0;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (args[0] === resolve(f.root, 'source.txt') && ++reads === failAt) throw io();
      return actual.lstat(...args);
    });
    await expect(startCoder(brief, f.deps)).rejects.toThrow('fixture disk I/O failure');
    expect((await f.deps.journal.read()).coders).toBeUndefined();
    expect(f.counts.creates).toBe(0);
  },
);
it('retains a corrupt copy binding instead of recreating the original directory', async () => {
  f = await coderFixture();
  await startCoder(await f.brief(), f.deps);
  const run = await runCoder('one', f.deps);
  await writeFile(resolve(f.db.parent, 'coder-artifacts/copy-one.json'), '{');
  await expect(f.workspaces.copy(run)).rejects.toBeInstanceOf(SyntaxError);
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('source revision 1');
  expect((await f.deps.runs.read())!.coder_locks).toHaveLength(1);
});
it.each(['copy', 'integrate'] as const)(
  'recovers an I/O failure cleaning a %s temporary file through the same intent',
  async (phase) => {
    f = await coderFixture();
    await startCoder(await f.brief(), f.deps);
    if (phase === 'integrate') await runCoder('one', f.deps);
    const actual = await vi.importActual<typeof Files>('node:fs/promises');
    vi.mocked(unlink).mockImplementation(async (path) => {
      if (String(path).includes('/.coder-')) throw io();
      return actual.unlink(path);
    });
    const perform = () =>
      phase === 'copy' ? runCoder('one', f.deps) : integrateCoder('one', f.deps);
    await expect(perform()).rejects.toThrow('fixture disk I/O failure');
    expect((await f.deps.runs.read())!.coder_locks).toHaveLength(1);
    vi.mocked(unlink).mockImplementation(actual.unlink);
    expect((await perform()).status).toBe(phase === 'copy' ? 'released' : 'integrated');
  },
);
it('handles absent nested parents and removed copy directories without writing source during preparation', async () => {
  f = await coderFixture();
  await f.file('module/remove/old.txt', 'old');
  const brief = await f.brief('one', ['module', 'absent/deep/new.txt']);
  f.deps.sessions.result = async (run) => {
    await rm(resolve(run.brief.copy_root, 'module/remove'), { recursive: true });
    await mkdir(resolve(run.brief.copy_root, 'absent/deep'), { recursive: true });
    await writeFile(resolve(run.brief.copy_root, 'absent/deep/new.txt'), 'new');
    return { outcome: 'PASS', evidence: f.proof, checks: [], errors: [], limitations: [] };
  };
  await startCoder(brief, f.deps);
  const run = await runCoder('one', f.deps);
  const intent = await f.workspaces.integration(run);
  expect(intent.changes.map((change) => change.path)).toEqual([
    'absent/deep/new.txt',
    'module/remove/old.txt',
  ]);
  await expect(lstat(resolve(f.root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(resolve(f.root, 'module/remove/old.txt'), 'utf8')).toBe('old');
  await integrateCoder('one', f.deps);
  expect(await readFile(resolve(f.root, 'absent/deep/new.txt'), 'utf8')).toBe('new');
  await expect(lstat(resolve(f.root, 'module/remove/old.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('propagates a parent-directory I/O failure instead of treating it as an absent path', async () => {
  f = await coderFixture();
  await f.file('module/before.txt', 'before');
  const brief = await f.brief('one', ['module/nested/new.txt']);
  const actual = await vi.importActual<typeof Files>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(async (...args) => {
    if (args[0] === resolve(f.root, 'module')) throw io();
    return actual.lstat(...args);
  });
  await expect(startCoder(brief, f.deps)).rejects.toThrow('fixture disk I/O failure');
  expect(f.counts.creates).toBe(0);
});
