import { afterEach, expect, it, vi } from 'vitest';
import type * as Files from 'node:fs';
import type * as AsyncFiles from 'node:fs/promises';
import { lstat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coderFixture } from './coderFixtures.js';
import { startCoder, runCoder, integrateCoder } from '../application/coderWorkflow.js';

const observations = vi.hoisted(() => ({
  events: [] as string[],
  descriptors: new Map<number, string>(),
  source: '',
  fail: null as 'file' | 'directory' | 'artifact' | null,
}));
const io = () => Object.assign(Error('fixture fsync failure'), { code: 'EIO' });
vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof Files>('node:fs');
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      observations.descriptors.set(fd, String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number) => {
      const path = observations.descriptors.get(fd)!;
      observations.events.push('sync:' + path);
      if (
        (observations.fail === 'directory' && path === observations.source) ||
        (observations.fail === 'artifact' && path.includes('/coder-artifacts/'))
      )
        throw io();
      fs.fsyncSync(fd);
    },
  };
});
vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof AsyncFiles>('node:fs/promises');
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args),
        sync = handle.sync.bind(handle),
        path = String(args[0]);
      handle.sync = async () => {
        observations.events.push('sync:' + path);
        if (observations.fail === 'file' && path.includes('/.coder-')) throw io();
        await sync();
      };
      return handle;
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      observations.events.push('write:' + String(args[0]));
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      observations.events.push('rename:' + String(args[1]));
    },
  };
});
let f: Awaited<ReturnType<typeof coderFixture>>;
afterEach(async () => {
  observations.fail = null;
  await f.dispose();
  observations.events = [];
  observations.descriptors.clear();
});
it('flushes file contents before rename, then the directory before confirming integration', async () => {
  f = await coderFixture();
  await startCoder(await f.brief('one', ['source.txt']), f.deps);
  await runCoder('one', f.deps);
  observations.source = f.root;
  observations.events = [];
  expect((await integrateCoder('one', f.deps)).status).toBe('integrated');
  const rename = observations.events.indexOf('rename:' + resolve(f.root, 'source.txt')),
    write = observations.events.findIndex((event) =>
      event.startsWith('write:' + f.root + '/.coder-'),
    ),
    sync = observations.events.findIndex((event) =>
      event.startsWith('sync:' + f.root + '/.coder-'),
    ),
    directory = observations.events.indexOf('sync:' + f.root, rename);
  expect(write).toBeGreaterThanOrEqual(0);
  expect(sync).toBeGreaterThan(write);
  expect(rename).toBeGreaterThan(sync);
  expect(directory).toBeGreaterThan(rename);
  expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
});
it.each(['file', 'directory', 'artifact'] as const)(
  'retains the reservation after a %s fsync failure and recovers the same import',
  async (failure) => {
    f = await coderFixture();
    await startCoder(await f.brief('one', ['source.txt']), f.deps);
    await runCoder('one', f.deps);
    observations.source = f.root;
    observations.fail = failure;
    await expect(integrateCoder('one', f.deps)).rejects.toThrow();
    expect((await f.deps.journal.read()).coders!.one!.status).not.toBe('integrated');
    expect((await f.deps.runs.read())!.coder_locks).toHaveLength(1);
    observations.fail = null;
    expect((await integrateCoder('one', f.deps)).status).toBe('integrated');
    expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
  },
);
it('flushes an already applied deletion on retry after a directory fsync failure', async () => {
  f = await coderFixture();
  f.deps.sessions.result = async (run) => {
    await unlink(resolve(run.brief.copy_root, 'source.txt'));
    return { outcome: 'PASS', evidence: f.proof, checks: [], errors: [], limitations: [] };
  };
  await startCoder(await f.brief('one', ['source.txt']), f.deps);
  await runCoder('one', f.deps);
  observations.source = f.root;
  observations.fail = 'directory';
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('fixture fsync failure');
  await expect(lstat(resolve(f.root, 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.deps.runs.read())!.coder_locks).toHaveLength(1);
  observations.fail = null;
  observations.events = [];
  expect((await integrateCoder('one', f.deps)).status).toBe('integrated');
  expect(observations.events).toContain('sync:' + f.root);
});

it('retries every created ancestor after a parent fsync failure before confirming a nested import', async () => {
  f = await coderFixture();
  await f.file('module/before.txt', 'preserved');
  f.deps.sessions.result = async (run) => {
    const fs = await vi.importActual<typeof AsyncFiles>('node:fs/promises');
    await fs.mkdir(resolve(run.brief.copy_root, 'module/new/deep'), { recursive: true });
    await fs.writeFile(resolve(run.brief.copy_root, 'module/new/deep/value.txt'), 'after');
    return { outcome: 'PASS', evidence: f.proof, checks: [], errors: [], limitations: [] };
  };
  await startCoder(await f.brief('one', ['module/new/deep/value.txt']), f.deps);
  await runCoder('one', f.deps);
  observations.source = resolve(f.root, 'module');
  observations.fail = 'directory';
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('fixture fsync failure');
  expect((await lstat(resolve(f.root, 'module/new'))).isDirectory()).toBe(true);
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('fixture fsync failure');
  expect((await f.deps.journal.read()).coders!.one!.status).toBe('integrating');
  expect((await f.deps.runs.read())!.coder_locks).toHaveLength(1);
  observations.fail = null;
  observations.events = [];
  expect((await integrateCoder('one', f.deps)).status).toBe('integrated');
  const renamed = observations.events.indexOf(
    'rename:' + resolve(f.root, 'module/new/deep/value.txt'),
  );
  for (const directory of [f.root, resolve(f.root, 'module'), resolve(f.root, 'module/new')]) {
    const synced = observations.events.indexOf('sync:' + directory);
    expect(synced).toBeGreaterThanOrEqual(0);
    expect(renamed).toBeGreaterThan(synced);
  }
  expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
});
