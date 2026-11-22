import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { ownProcess, verifyPinnedBinary } from '../examples/temporal-consumers/full/safety.mjs';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import { requireContract } from '../src/contracts/project.js';
import { h04Pin, type H04Pin } from './comparisonH04Contract.js';
import { verifyH06NativeTemporalServer } from './comparisonH06NativeTemporalServer.js';

const exec = promisify(execFile);
const observationEnv = { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', NODE_ENV: 'production' } as const;

type Expected = Parameters<typeof verifyH06NativeTemporalServer>[0];

interface OwnedServerSetup {
  expected: Expected;
  deadlineMs: number;
  stopReserveMs: number;
  signal?: AbortSignal;
}

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

function record(path: string, value: unknown): H04Pin {
  const bytes = Buffer.from(JSON.stringify(value));
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

function remaining(deadline: number) {
  const ms = Math.floor(deadline - performance.now());
  requireContract(ms > 0, 'h06-temporal-setup-deadline');
  return ms;
}

async function listener(port: number, deadline: number) {
  const timeout = Math.min(remaining(deadline), 2000);
  try {
    const { stdout, stderr } = await exec(
      '/usr/sbin/lsof',
      ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN'],
      { encoding: 'utf8', env: observationEnv, timeout, maxBuffer: 1024 * 1024 },
    );
    requireContract(
      stderr === '' && /^[1-9]\d*(?:\n[1-9]\d*)*\n$/u.test(stdout),
      'h06-temporal-setup-port-output',
    );
    return stdout.trim();
  } catch (error) {
    const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (result.code === 1 && result.stdout === '' && result.stderr === '') return '';
    throw new Error('h06-temporal-setup-port-unknown', { cause: error });
  }
}

async function noListeners(ports: readonly number[], deadline: number, failure: string) {
  const rows = await Promise.all(ports.map((port) => listener(port, deadline)));
  requireContract(
    rows.every((row) => row === ''),
    failure,
  );
  remaining(deadline);
}

/** Run one already authorized server within its separately claimed directory. */
export async function withH06NativeTemporalServer<T>(
  setup: OwnedServerSetup,
  run: (ready: H04Pin, signal: AbortSignal) => Promise<T>,
) {
  const { signal, ...configuration } = setup;
  signal?.throwIfAborted();
  const { expected, deadlineMs, stopReserveMs } = structuredClone(configuration);
  const { address, binary: binaryPin, httpPort, metricsPort, sqlitePath, requestHash } = expected;
  const binary = h04Pin(binaryPin);
  const grpc = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(address);
  const ports = [Number(grpc?.[1]), httpPort, metricsPort];
  requireContract(
    /^[a-f0-9]{64}$/u.test(requestHash) &&
      ports.every((port) => Number.isSafeInteger(port) && port >= 1 && port <= 65535) &&
      new Set(ports).size === 3 &&
      isAbsolute(sqlitePath) &&
      resolve(sqlitePath) === sqlitePath &&
      binary.path !== sqlitePath &&
      !/[\s\p{Cc}]/u.test(binary.path + sqlitePath),
    'h06-temporal-setup-binding',
  );
  const lifetime = deadlineMs - Date.now();
  requireContract(
    Number.isSafeInteger(deadlineMs) &&
      Number.isSafeInteger(stopReserveMs) &&
      stopReserveMs > 0 &&
      lifetime > stopReserveMs &&
      lifetime <= 2147483647,
    'h06-temporal-setup-budget',
  );
  const deadline = performance.now() + lifetime;
  const workDeadline = deadline - stopReserveMs;
  const forceStopMs = Math.min(2000, stopReserveMs / 4);
  const root = safeDirectory(dirname(sqlitePath));
  const identity = lstatSync(root, { bigint: true });
  function checkRoot() {
    const current = lstatSync(safeDirectory(root), { bigint: true });
    requireContract(
      current.dev === identity.dev && current.ino === identity.ino,
      'h06-temporal-setup-root-changed',
    );
  }
  function checkDatabase() {
    requireContract(
      ['', '-wal', '-shm', '-journal'].every((suffix) => !present(sqlitePath + suffix)),
      'h06-temporal-setup-database-present',
    );
  }
  checkDatabase();
  await noListeners(ports, workDeadline, 'h06-temporal-setup-port-in-use');
  signal?.throwIfAborted();
  checkRoot();
  checkDatabase();
  verifyPinnedBinary(binary.path, binary.sha256);
  const argv = [
    'server',
    'start-dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(ports[0]),
    '--http-port',
    String(httpPort),
    '--metrics-port',
    String(metricsPort),
    '--headless',
    '--db-filename',
    sqlitePath,
  ];
  const launch = record(join(root, 'server-launch.json'), {
    kind: 'comparison-h06-native-temporal-server-launch/2',
    expected,
    argv,
    deadlineMs,
    stopReserveMs,
  });
  remaining(workDeadline);
  signal?.throwIfAborted();
  const child: ChildProcess = spawn(binary.path, argv, {
    cwd: root,
    detached: true,
    env: { ...observationEnv, PATH: '/usr/bin:/bin', TMPDIR: root },
    stdio: 'ignore',
  });
  const owner = ownProcess(child, {
    deadline,
    listenerPaths: [sqlitePath],
    automaticStopAt: deadline - forceStopMs,
    stopMs: stopReserveMs,
    termGraceMs: Math.ceil(stopReserveMs / 2),
  });
  const controller = new AbortController();
  let rejectAbort!: (reason: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort();
    rejectAbort(new Error('h06-temporal-setup-interrupted', { cause: signal?.reason }));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  function workRemaining() {
    requireContract(!controller.signal.aborted, 'h06-temporal-setup-interrupted');
    return remaining(workDeadline);
  }
  let ready: H04Pin | null = null;
  let running = false;
  async function action() {
    const pid: unknown = child.pid;
    requireContract(
      typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1,
      'h06-temporal-setup-pid',
    );
    for (;;) {
      workRemaining();
      const row = await listener(ports[0]!, workDeadline);
      if (row !== '') {
        requireContract(row === String(pid), 'h06-temporal-setup-listener-owner');
        if (present(sqlitePath)) break;
      }
      await pause(Math.min(25, workRemaining()));
    }
    const observation = await exec('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'lstart='], {
      encoding: 'utf8',
      env: observationEnv,
      timeout: Math.min(workRemaining(), 2000),
      maxBuffer: 1024 * 1024,
    });
    const processLine = /^(\d+)\s+([A-Za-z]{3} .+)$/u.exec(observation.stdout.trim());
    requireContract(
      observation.stderr === '' && processLine !== null && Number(processLine[1]) === process.pid,
      'h06-temporal-setup-process-owner',
    );
    workRemaining();
    checkRoot();
    const body = {
      kind: 'comparison-h06-native-temporal-server/2',
      ...expected,
      process: { pid, parent: process.pid, started: processLine[2] },
    };
    const observed = record(join(root, 'server-process.json'), body);
    await verifyH06NativeTemporalServer(expected, observed, Date.now() + workRemaining());
    workRemaining();
    checkRoot();
    const proof = record(join(root, 'server-ready.json'), body);
    workRemaining();
    ready = proof;
    running = true;
    const result = await run(proof, controller.signal);
    workRemaining();
    return { result, ready: proof };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expires = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('h06-temporal-setup-deadline')),
      Math.max(0, workDeadline - performance.now()),
    );
  });
  const exited = owner.done.then(() => {
    throw new Error('h06-temporal-setup-server-exited');
  });
  const active = action();
  const outcome = await Promise.race([active, expires, exited, interrupted])
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  controller.abort(outcome.ok ? undefined : outcome.error);
  if (!outcome.ok && running) {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.catch(() => {}),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(
            resolve,
            Math.max(0, deadline - forceStopMs - performance.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
  const stopDeadline = Math.min(deadline, performance.now() + stopReserveMs);
  let stopped: H04Pin;
  try {
    const receipt = await owner.stop();
    requireContract(receipt.stopped, 'h06-temporal-setup-stop-unconfirmed');
    await noListeners(ports, stopDeadline, 'h06-temporal-setup-listener-remains');
    checkRoot();
    stopped = record(join(root, 'server-stop.json'), {
      kind: 'comparison-h06-native-temporal-server-stop/2',
      requestHash,
      launch,
      ready,
      ports,
      receipt,
    });
  } catch (failure) {
    if (!outcome.ok)
      throw new AggregateError([outcome.error, failure], 'h06-temporal-setup-and-stop-failed');
    throw failure;
  }
  if (!outcome.ok) throw outcome.error;
  return { ...outcome.value, stopped };
}
