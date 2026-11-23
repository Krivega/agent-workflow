import type * as ChildProcess from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Safety from '../examples/temporal-consumers/full/safety.mjs';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import { readH04Pin } from './comparisonH04Contract.js';
import { withH06NativeTemporalServer } from './comparisonH06NativeTemporalServerSetup.js';
import type { verifyH06NativeTemporalServer } from './comparisonH06NativeTemporalServer.js';

const ports = vi.hoisted(() => ({
  observe:
    vi.fn<
      (
        file: string,
        args: string[],
        options: { timeout: number },
      ) => Promise<{ stdout: string; stderr: string }>
    >(),
  spawn: vi.fn<(path: string, args: string[], options: object) => ChildProcess.ChildProcess>(),
  own: vi.fn<typeof Safety.ownProcess>(),
  verify: vi.fn<typeof verifyH06NativeTemporalServer>(),
}));
vi.mock('node:child_process', async (load) => {
  const original = await load<typeof ChildProcess>();
  return {
    ...original,
    spawn: ports.spawn,
    execFile: Object.assign(vi.fn(), {
      [Symbol.for('nodejs.util.promisify.custom')]: ports.observe,
    }),
  };
});
vi.mock('../examples/temporal-consumers/full/safety.mjs', async (load) => ({
  ...(await load<typeof Safety>()),
  ownProcess: ports.own,
}));
vi.mock('./comparisonH06NativeTemporalServer.js', () => ({
  verifyH06NativeTemporalServer: ports.verify,
}));

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  vi.resetAllMocks();
});

function useServerClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const start = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - start);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const started = 'Wed Nov  4 19:42:00 2026';
const output = (stdout: string) => ({ stdout, stderr: '' });
const absent = () =>
  Promise.reject(Object.assign(new Error('no listener'), { code: 1, stdout: '', stderr: '' }));

function fixture() {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'h06-server-setup-'));
  roots.push(parent);
  const root = join(parent, 'claimed');
  mkdirSync(root);
  const path = join(parent, 'temporal');
  const binaryBytes = 'mock executable, never run';
  writeFileSync(path, binaryBytes, { mode: 0o700 });
  const expected = {
    requestHash: 'a'.repeat(64),
    binary: { path, sha256: digest(binaryBytes) },
    address: '127.0.0.1:7244',
    httpPort: 7245,
    metricsPort: 7246,
    sqlitePath: join(root, 'temporal.sqlite'),
  };
  const setup = { expected, deadlineMs: Date.now() + 4000, stopReserveMs: 500 };
  const child = { pid: 1234 } as ChildProcess.ChildProcess;
  const stopResult = {
    stopped: true,
    code: 0,
    signal: null,
    pids: [1234],
    identities: [],
    groups: [],
    retired: [],
    retiredGroups: [],
    deadlineReached: false,
  };
  const ended = deferred<Safety.OwnedProcessReceipt>();
  let phase: 'before' | 'active' | 'stopped' = 'before';
  const stop = vi.fn(async () => {
    phase = 'stopped';
    ended.resolve(stopResult);
    return stopResult;
  });
  ports.spawn.mockImplementation(() => {
    phase = 'active';
    writeFileSync(expected.sqlitePath, 'mock database');
    return child;
  });
  ports.own.mockReturnValue({ child, done: ended.promise, stop });
  ports.observe.mockImplementation(async (file, args) => {
    if (file === '/bin/ps') return output(`${process.pid} ${started}\n`);
    if (phase === 'active' && args.includes('-iTCP:7244')) return output('1234\n');
    return absent();
  });
  const run = vi.fn(async () => 'done');
  return { root, parent, expected, setup, child, stopResult, stop, ended, run };
}

it('publishes checked READY and confirms STOP without spawning a real server', async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  const result = await withH06NativeTemporalServer(f.setup, async (ready, state) => {
    signal = state;
    expect(state.aborted).toBe(false);
    expect(JSON.parse(readH04Pin(ready).toString()) as unknown).toEqual({
      kind: 'comparison-h06-native-temporal-server/2',
      ...f.expected,
      process: { pid: f.child.pid, parent: process.pid, started },
    });
    return 'callback result';
  });
  expect(result.result).toBe('callback result');
  expect(signal?.aborted).toBe(true);
  expect(ports.spawn).toHaveBeenCalledExactlyOnceWith(
    f.expected.binary.path,
    [
      'server',
      'start-dev',
      '--ip',
      '127.0.0.1',
      '--port',
      '7244',
      '--http-port',
      '7245',
      '--metrics-port',
      '7246',
      '--headless',
      '--db-filename',
      f.expected.sqlitePath,
    ],
    {
      cwd: f.root,
      detached: true,
      stdio: 'ignore',
      env: {
        LC_ALL: 'C',
        LANG: 'C',
        TZ: 'UTC',
        NODE_ENV: 'production',
        PATH: '/usr/bin:/bin',
        TMPDIR: f.root,
      },
    },
  );
  expect(ports.own).toHaveBeenCalledExactlyOnceWith(
    f.child,
    expect.objectContaining({
      stopMs: f.setup.stopReserveMs,
      termGraceMs: Math.ceil(f.setup.stopReserveMs / 2),
      listenerPaths: [f.expected.sqlitePath],
    }),
  );
  expect(ports.verify).toHaveBeenCalledExactlyOnceWith(
    f.expected,
    { path: join(f.root, 'server-process.json'), sha256: result.ready.sha256 },
    expect.any(Number),
  );
  expect(result.ready.path).toBe(join(f.root, 'server-ready.json'));
  expect(result.stopped.path).toBe(join(f.root, 'server-stop.json'));
  expect(JSON.parse(readH04Pin(result.stopped).toString()) as unknown).toMatchObject({
    kind: 'comparison-h06-native-temporal-server-stop/2',
    ready: result.ready,
    ports: [7244, 7245, 7246],
    receipt: f.stopResult,
  });
  expect(f.stop).toHaveBeenCalledTimes(1);
});

it.each(['', '-wal', '-shm', '-journal'])(
  'refuses an existing SQLite file or companion %j',
  async (suffix) => {
    const f = fixture();
    writeFileSync(f.expected.sqlitePath + suffix, 'existing');
    await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
      'h06-temporal-setup-database-present',
    );
    expect(ports.spawn).not.toHaveBeenCalled();
  },
);

it.each([
  { requestHash: 'invalid' },
  { address: '0.0.0.0:7244' },
  { httpPort: 0 },
  { httpPort: 65536 },
  { metricsPort: 7244 },
  { sqlitePath: 'relative' },
  { sqlitePath: '/alias/../file' },
  { sqlitePath: '/contains space/file' },
])('rejects invalid server binding %j', async (change) => {
  const f = fixture();
  Object.assign(f.expected, change);
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-binding',
  );
  expect(ports.spawn).not.toHaveBeenCalled();
});

it('rejects a SQLite path equal to the pinned executable', async () => {
  const f = fixture();
  f.expected.sqlitePath = f.expected.binary.path;
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-binding',
  );
});

it.each([
  { deadlineMs: 1.5 },
  { stopReserveMs: 1.5 },
  { stopReserveMs: 0 },
  { stopReserveMs: 8000 },
  { deadlineMs: Number.MAX_SAFE_INTEGER },
])('rejects unsafe lifecycle budget %j', async (change) => {
  const f = fixture();
  Object.assign(f.setup, change);
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-budget',
  );
  expect(ports.spawn).not.toHaveBeenCalled();
});

it.each([
  { stdout: '9999\n', stderr: '', error: 'h06-temporal-setup-port-in-use' },
  { stdout: 'broken\n', stderr: '', error: 'h06-temporal-setup-port-unknown' },
  { stdout: '9999\n', stderr: 'warning', error: 'h06-temporal-setup-port-unknown' },
])('refuses occupied or ambiguous ports before spawn %j', async ({ stdout, stderr, error }) => {
  const f = fixture();
  ports.observe.mockResolvedValueOnce({ stdout, stderr });
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(error);
  expect(ports.spawn).not.toHaveBeenCalled();
});

it('refuses uncertain errors from a listener probe', async () => {
  const f = fixture();
  ports.observe.mockRejectedValueOnce(
    Object.assign(new Error('partial'), { code: 1, stdout: '', stderr: 'denied' }),
  );
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-port-unknown',
  );
  expect(ports.spawn).not.toHaveBeenCalled();
});

it('refuses binary drift and a repeated immutable launch', async () => {
  const f = fixture();
  writeFileSync(f.expected.binary.path, 'different');
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow('binary hash mismatch');
  expect(ports.spawn).not.toHaveBeenCalled();

  const retry = fixture();
  writeFileSync(join(retry.root, 'server-launch.json'), 'already attempted');
  await expect(withH06NativeTemporalServer(retry.setup, retry.run)).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(ports.spawn).not.toHaveBeenCalled();
});

it('rechecks SQLite absence and root identity after observing ports', async () => {
  const f = fixture();
  ports.observe.mockImplementationOnce(async () => {
    writeFileSync(f.expected.sqlitePath, 'raced');
    return absent();
  });
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-database-present',
  );

  const replacement = fixture();
  ports.observe.mockImplementationOnce(async () => {
    renameSync(replacement.root, join(replacement.parent, 'retired'));
    mkdirSync(replacement.root);
    return absent();
  });
  await expect(withH06NativeTemporalServer(replacement.setup, replacement.run)).rejects.toThrow(
    'h06-temporal-setup-root-changed',
  );
  expect(ports.spawn).not.toHaveBeenCalled();
});

it('polls until the owned listener and SQLite file appear', async () => {
  const f = fixture();
  ports.spawn.mockReturnValue(f.child);
  let visits = 0;
  ports.observe.mockImplementation(async (file, args) => {
    if (file === '/bin/ps') return output(`${process.pid} ${started}\n`);
    if (!args.includes('-iTCP:7244')) return absent();
    visits++;
    if (visits < 3 || visits > 4) return absent();
    if (visits === 4) writeFileSync(f.expected.sqlitePath, 'mock database');
    return output('1234\n');
  });
  const result = await withH06NativeTemporalServer(f.setup, f.run);
  expect(result.result).toBe('done');
});

it.each([undefined, 1, 1.5])('cleans up an unobserved child identity %j', async (pid) => {
  const f = fixture();
  Object.assign(f.child, { pid });
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-pid',
  );
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.run).not.toHaveBeenCalled();
  expect(existsSync(join(f.root, 'server-stop.json'))).toBe(true);
});

it('does not promote a foreign listener to READY', async () => {
  const f = fixture();
  ports.observe
    .mockImplementationOnce(absent)
    .mockImplementationOnce(absent)
    .mockImplementationOnce(absent)
    .mockResolvedValueOnce(output('9999\n'));
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-listener-owner',
  );
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.run).not.toHaveBeenCalled();
});

it.each([
  { stdout: 'wrong\n', stderr: '' },
  { stdout: '1 Wed Nov  4 19:42:00 2026\n', stderr: '' },
  { stdout: `${process.pid} ${started}\n`, stderr: 'warning' },
])('requires the current exact owner of the spawned process %j', async (row) => {
  const f = fixture();
  const observe = ports.observe.getMockImplementation()!;
  ports.observe.mockImplementation(async (file, args, options) =>
    file === '/bin/ps' ? row : observe(file, args, options),
  );
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-process-owner',
  );
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.run).not.toHaveBeenCalled();
});

it('retains observation but no READY when the ownership verifier rejects', async () => {
  const f = fixture();
  ports.verify.mockRejectedValueOnce(new Error('ownership lost'));
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow('ownership lost');
  expect(existsSync(join(f.root, 'server-process.json'))).toBe(true);
  expect(existsSync(join(f.root, 'server-ready.json'))).toBe(false);
  expect(f.stop).toHaveBeenCalledTimes(1);
});

it('confirms cleanup after callback failure', async () => {
  const f = fixture();
  const failure = new Error('callback failed');
  f.run.mockRejectedValueOnce(failure);
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toBe(failure);
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(existsSync(join(f.root, 'server-stop.json'))).toBe(true);
});

it('aborts a callback when the owned server unexpectedly exits', async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  const result = withH06NativeTemporalServer(f.setup, async (_ready, state) => {
    signal = state;
    f.ended.resolve(f.stopResult);
    return new Promise(() => {});
  });
  await expect(result).rejects.toThrow('h06-temporal-setup-server-exited');
  expect(signal?.aborted).toBe(true);
  expect(f.stop).toHaveBeenCalledTimes(1);
});

it('uses the work deadline to abort an unfinished callback and preserve cleanup time', async () => {
  useServerClock();
  const f = fixture();
  f.setup.deadlineMs = Date.now() + 300;
  f.setup.stopReserveMs = 150;
  const entered = deferred<AbortSignal>();
  const result = withH06NativeTemporalServer(f.setup, async (_ready, signal) => {
    entered.resolve(signal);
    return new Promise(() => {});
  });
  const rejected = expect(result).rejects.toThrow('h06-temporal-setup-deadline');
  const signal = await entered.promise;
  await vi.advanceTimersByTimeAsync(149);
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  await vi.runAllTimersAsync();
  await rejected;
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(existsSync(join(f.root, 'server-stop.json'))).toBe(true);
});

it('keeps the server alive for cooperative cleanup beyond one second after the work deadline', async () => {
  useServerClock();
  const f = fixture();
  const workMs = 100;
  const cleanupMs = 1200;
  f.setup.stopReserveMs = 2200;
  f.setup.deadlineMs = Date.now() + workMs + f.setup.stopReserveMs;
  const path = join(f.root, 'transport-stop.json');
  const entered = deferred<void>();
  const result = withH06NativeTemporalServer(f.setup, async (_ready, signal) => {
    entered.resolve();
    try {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    } finally {
      await new Promise((resolve) => setTimeout(resolve, cleanupMs));
      expect(f.stop).not.toHaveBeenCalled();
      expect(Date.now()).toBeLessThan(f.setup.deadlineMs);
      publishFile(path, Buffer.from('confirmed transport STOP'));
    }
  });
  const rejected = expect(result).rejects.toThrow('h06-temporal-setup-deadline');
  await entered.promise;
  await vi.advanceTimersByTimeAsync(workMs + cleanupMs);
  await rejected;
  expect(readFileSync(path, 'utf8')).toBe('confirmed transport STOP');
  expect(() => publishFile(path, Buffer.from('late replacement'))).toThrow();
  expect(existsSync(join(f.root, 'server-stop.json'))).toBe(true);
  expect(f.stop).toHaveBeenCalledOnce();
});

it('interrupts pending verification before READY when the server exits', async () => {
  const f = fixture();
  const verify = deferred<void>();
  ports.verify.mockImplementationOnce(async () => {
    f.ended.resolve(f.stopResult);
    return verify.promise;
  });
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-server-exited',
  );
  verify.resolve(undefined);
  await Promise.resolve();
  expect(existsSync(join(f.root, 'server-ready.json'))).toBe(false);
  expect(f.run).not.toHaveBeenCalled();
});

it.each([false, true])(
  'leaves STOP unconfirmed when owned cleanup fails (callback error: %s)',
  async (callbackFails) => {
    const f = fixture();
    f.stopResult.stopped = false;
    if (callbackFails) f.run.mockRejectedValueOnce(new Error('callback failure'));
    const result = withH06NativeTemporalServer(f.setup, f.run);
    if (callbackFails) {
      await expect(result).rejects.toMatchObject({
        message: 'h06-temporal-setup-and-stop-failed',
        errors: [new Error('callback failure'), new Error('h06-temporal-setup-stop-unconfirmed')],
      });
    } else {
      await expect(result).rejects.toThrow('h06-temporal-setup-stop-unconfirmed');
    }
    expect(existsSync(join(f.root, 'server-stop.json'))).toBe(false);
  },
);

it('refuses a STOP if any listener still exists after process cleanup', async () => {
  const f = fixture();
  const observe = ports.observe.getMockImplementation()!;
  ports.observe.mockImplementation(async (file, args, options) => {
    if (f.stop.mock.calls.length > 0) return output('9999\n');
    return observe(file, args, options);
  });
  await expect(withH06NativeTemporalServer(f.setup, f.run)).rejects.toThrow(
    'h06-temporal-setup-listener-remains',
  );
  expect(existsSync(join(f.root, 'server-stop.json'))).toBe(false);
  expect(readFileSync(join(f.root, 'server-ready.json'), 'utf8')).toContain('1234');
});

it('refuses an already aborted attempt before any probe, launch record or spawn', async () => {
  const f = fixture(),
    abort = new AbortController(),
    reason = new Error('stop before setup');
  abort.abort(reason);
  await expect(
    withH06NativeTemporalServer({ ...f.setup, signal: abort.signal }, f.run),
  ).rejects.toBe(reason);
  expect(ports.observe).not.toHaveBeenCalled();
  expect(ports.spawn).not.toHaveBeenCalled();
  expect(existsSync(join(f.root, 'server-launch.json'))).toBe(false);
});

it('does not spawn after cancellation arrives while checking the ports', async () => {
  const f = fixture(),
    abort = new AbortController(),
    reason = new Error('stop during preflight');
  ports.observe.mockImplementationOnce(async () => {
    abort.abort(reason);
    return absent();
  });
  await expect(
    withH06NativeTemporalServer({ ...f.setup, signal: abort.signal }, f.run),
  ).rejects.toBe(reason);
  expect(ports.spawn).not.toHaveBeenCalled();
  expect(ports.own).not.toHaveBeenCalled();
  expect(existsSync(join(f.root, 'server-launch.json'))).toBe(false);
});

it('confirms STOP when cancellation arrives immediately after spawn before listener registration', async () => {
  const f = fixture(),
    abort = new AbortController();
  ports.own.mockImplementationOnce(() => {
    abort.abort(new Error('stop at ownership boundary'));
    return { child: f.child, done: f.ended.promise, stop: f.stop };
  });
  await expect(
    withH06NativeTemporalServer({ ...f.setup, signal: abort.signal }, f.run),
  ).rejects.toThrow('h06-temporal-setup-interrupted');
  expect(ports.spawn).toHaveBeenCalledTimes(1);
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.run).not.toHaveBeenCalled();
  expect(existsSync(join(f.root, 'server-stop.json'))).toBe(true);
});

it('aborts pending READY verification, confirms STOP and prevents the late callback', async () => {
  const f = fixture(),
    abort = new AbortController(),
    entered = deferred<void>(),
    verification = deferred<void>();
  const add = vi.spyOn(abort.signal, 'addEventListener'),
    remove = vi.spyOn(abort.signal, 'removeEventListener');
  ports.verify.mockImplementationOnce(async () => {
    entered.resolve(undefined);
    await verification.promise;
  });
  const result = withH06NativeTemporalServer({ ...f.setup, signal: abort.signal }, f.run);
  await entered.promise;
  abort.abort(new Error('stop before READY'));
  await expect(result).rejects.toThrow('h06-temporal-setup-interrupted');
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(existsSync(join(f.root, 'server-stop.json'))).toBe(true);
  expect(existsSync(join(f.root, 'server-ready.json'))).toBe(false);
  expect(f.run).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0]![1]);
  verification.resolve(undefined);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.run).not.toHaveBeenCalled();
  expect(existsSync(join(f.root, 'server-ready.json'))).toBe(false);
});

it('propagates cancellation to an active callback and confirms owned STOP before rejecting', async () => {
  const f = fixture(),
    abort = new AbortController(),
    entered = deferred<AbortSignal>();
  const result = withH06NativeTemporalServer(
    { ...f.setup, signal: abort.signal },
    async (_ready, signal) => {
      entered.resolve(signal);
      return new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  );
  const signal = await entered.promise;
  expect(signal.aborted).toBe(false);
  abort.abort(new Error('stop running stage'));
  await expect(result).rejects.toThrow('h06-temporal-setup-interrupted');
  expect(signal.aborted).toBe(true);
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(existsSync(join(f.root, 'server-ready.json'))).toBe(true);
  expect(existsSync(join(f.root, 'server-stop.json'))).toBe(true);
});

it.each([false, true])(
  'removes the external listener on settled setup (failure=%s)',
  async (failure) => {
    const f = fixture(),
      abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener'),
      remove = vi.spyOn(abort.signal, 'removeEventListener');
    if (failure) f.stopResult.stopped = false;
    const result = withH06NativeTemporalServer({ ...f.setup, signal: abort.signal }, f.run);
    if (failure) await expect(result).rejects.toThrow('h06-temporal-setup-stop-unconfirmed');
    else expect((await result).result).toBe('done');
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0]![1]);
    abort.abort(new Error('late external abort'));
    expect(f.stop).toHaveBeenCalledTimes(1);
  },
);
