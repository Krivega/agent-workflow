import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
vi.mock('node:child_process', async () => ({
  ...(await vi.importActual<typeof childProcess>('node:child_process')),
}));
import { taskChecks } from '../../src/adapters/project/taskChecks.js';
import { NativeWriterProcesses } from '../../src/adapters/codex/writerProcesses.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('waits for physical disappearance and ignores unrelated supervisor notifications', async () => {
  const f = fixture(),
    real = new NativeWriterProcesses();
  let held: Parameters<NativeWriterProcesses['terminate']>[0] = [];
  const processes = {
    descendants: real.descendants.bind(real),
    alive: real.alive.bind(real),
    terminate: async (ids: typeof held) => {
      held = ids;
      return ids;
    },
    wait: vi.fn(async () => {
      await real.terminate(held);
      await real.wait(20);
    }),
  };
  const spawn = childProcess.spawn;
  vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof spawn>) => {
    const child = Reflect.apply(spawn, childProcess, args);
    child.on('message', (message) => {
      if ((message as { type: string }).type === 'finished')
        child.emit('message', { type: 'diagnostic' });
    });
    return child;
  }) as typeof spawn);
  const run = taskChecks(join(f.root, 'delayed'), processes);
  try {
    const result = await run.run(f.root, {
      executable: process.execPath,
      args: ['-e', "console.log('done')"],
      timeoutMs: 1000,
    });
    expect(result.code).toBe(0);
    expect(processes.wait).toHaveBeenCalledWith(20);
  } finally {
    const alive = await real.alive(held);
    if (alive.length) await real.terminate(alive);
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-check-')));
  roots.push(root);
  return { root, checks: taskChecks(join(root, 'logs'), new NativeWriterProcesses()) };
}
it('runs a real registered command, retains output and stops its dedicated supervisor', async () => {
  const f = fixture();
  const result = await f.checks.run(f.root, {
    executable: process.execPath,
    args: ['-e', "console.log('real check')"],
    timeoutMs: 1000,
  });
  expect(result).toMatchObject({ code: 0, signal: null, error: null });
  expect(result.log).toContain('real check');
  expect(result.elapsedMs).toBeGreaterThan(0);
  expect(result.stop.confirmed).toBe(true);
  expect(result.stop.processes.length).toBeGreaterThan(0);
  expect(await new NativeWriterProcesses().alive([...result.stop.processes])).toEqual([]);
  await f.checks.stop();
});
it('retains nonzero exit and spawn failure without success', async () => {
  const f = fixture();
  expect(
    (
      await f.checks.run(f.root, {
        executable: process.execPath,
        args: ['-e', 'process.exit(7)'],
        timeoutMs: 1000,
      })
    ).code,
  ).toBe(7);
  const missing = await f.checks.run(f.root, {
    executable: join(f.root, 'missing-command'),
    args: [],
    timeoutMs: 1000,
  });
  expect(missing.code).toBeNull();
  expect(missing.error).toContain('ENOENT');
});
it('bounds a long check and independently stops an active process tree', async () => {
  const f = fixture();
  const timeout = await f.checks.run(f.root, {
    executable: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    timeoutMs: 20,
  });
  expect(timeout.signal).toBe('timeout');
  const marker = join(f.root, 'started'),
    running = f.checks.run(f.root, {
      executable: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`,
      ],
      timeoutMs: 5000,
    });
  const outcome = expect(running).rejects.toThrow('task-check-interrupted');
  for (let i = 0; i < 200 && !existsSync(marker); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(existsSync(marker)).toBe(true);
  await expect(
    f.checks.run(f.root, { executable: 'none', args: [], timeoutMs: 1 }),
  ).rejects.toThrow('task-check-busy');
  await f.checks.stop();
  await outcome;
  await f.checks.stop();
});
it('preserves a startup error when the supervisor has no live PID', async () => {
  const f = fixture();
  await expect(
    f.checks.run(join(f.root, 'missing'), {
      executable: process.execPath,
      args: [],
      timeoutMs: 1000,
    }),
  ).rejects.toThrow('ENOENT');
});
