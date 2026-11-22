import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import {
  h06NativeTemporalRunMain,
  planH06NativeTemporalRun,
  runH06NativeTemporalFromChat,
} from './comparisonH06NativeTemporalRun.js';

const operations = vi.hoisted(() => ({
  plan: vi.fn(),
  resolve: vi.fn(),
  workers: vi.fn(),
  run: vi.fn<
    (
      attempt: unknown,
      budget: unknown,
      grants: { server: unknown; attempt(signal: AbortSignal): Promise<unknown> },
      workers: {
        initialAndWarm(input: string, signal: AbortSignal): Promise<string>;
        cold(input: string, signal: AbortSignal): Promise<string>;
      },
      signal?: AbortSignal,
    ) => Promise<unknown>
  >(),
}));
vi.mock('./comparisonH06NativeAuthority.js', () => ({ resolveH06NativeGrant: operations.resolve }));
vi.mock('./comparisonH06NativeTemporalDriver.js', () => ({
  runH06NativeTemporalDriver: operations.run,
}));
vi.mock('./comparisonH06NativeTemporalOperator.js', () => ({
  planH06NativeTemporalServerSetup: operations.plan,
}));
vi.mock('./comparisonH06NativeTemporalProcesses.js', () => ({
  h06TemporalWorkerProcesses: operations.workers,
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-temporal-run-'));
  roots.push(root);
  const pin = (path: string) => ({ path, sha256: digest(readFileSync(path)) });
  const json = (name: string, value: unknown) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return pin(path);
  };
  const node = json('node', 'fixture binary');
  const tsx = pin(fileURLToPath(import.meta.resolve('tsx')));
  const entry = pin(
    fileURLToPath(new URL('./comparisonH06NativeTemporalProcesses.ts', import.meta.url)),
  );
  const attempt = {
    expectedGrantText: 'attempt-grant',
    request: { binding: { node }, runtime: [tsx, entry] },
  };
  const plan = {
    attempt,
    budget: { maxElapsedMs: 30000, stopReserveMs: 4000 },
    expectedGrantText: 'server-grant',
  };
  const setup = {
    kind: 'comparison-h06-native-server-setup/2',
    attempt: json('attempt.json', attempt.request),
    budget: plan.budget,
  };
  const value = {
    kind: 'comparison-h06-native-temporal-run/2',
    setup: json('setup.json', setup),
    worker: { node, tsx, entry },
  };
  const controller = new AbortController();
  const channel = {
    input: new PassThrough(),
    output: new PassThrough(),
    signal: controller.signal,
  };
  const workers = { initialAndWarm: vi.fn(async () => 'warm'), cold: vi.fn(async () => 'cold') };
  operations.plan.mockReturnValue(plan);
  operations.resolve.mockResolvedValue('server-authority');
  operations.workers.mockReturnValue(workers);
  return { value, plan, attempt, setup, json, controller, channel, workers };
}

it('plans from the exact existing worker files and rejects an unpinned launch', async () => {
  const f = fixture();
  const path = f.json('run.json', f.value).path;
  await expect(h06NativeTemporalRunMain(['--plan', path])).resolves.toEqual({
    plan: f.plan,
    worker: f.value.worker,
  });
  await expect(h06NativeTemporalRunMain(['--other', path])).rejects.toThrow(
    'h06-temporal-run-arguments',
  );
  expect(() => planH06NativeTemporalRun({ ...f.value, kind: 'other' })).toThrow(
    'h06-temporal-run-kind',
  );
  expect(() =>
    planH06NativeTemporalRun({
      ...f.value,
      setup: f.json('wrong.json', { ...f.setup, kind: 'other' }),
    }),
  ).toThrow('h06-native-stand-server-kind');
  for (const field of ['node', 'tsx', 'entry'] as const) {
    const worker = { ...f.value.worker, [field]: f.json('other.json', 'foreign') };
    expect(() => planH06NativeTemporalRun({ ...f.value, worker })).toThrow(
      'h06-temporal-run-unpinned-worker',
    );
  }
  f.attempt.request.runtime.length = 0;
  expect(() => planH06NativeTemporalRun(f.value)).toThrow('h06-temporal-run-unpinned-worker');
  expect(operations.run).not.toHaveBeenCalled();
});

it('does not open workers or the driver before the current server grant', async () => {
  const f = fixture();
  operations.resolve.mockRejectedValueOnce(new Error('wrong grant'));
  await expect(runH06NativeTemporalFromChat(f.value, f.channel)).rejects.toThrow('wrong grant');
  f.controller.abort(new Error('aborted'));
  await expect(runH06NativeTemporalFromChat(f.value, f.channel)).rejects.toThrow('aborted');
  expect(operations.workers).not.toHaveBeenCalled();
  expect(operations.run).not.toHaveBeenCalled();
});

it('passes an attempt source only after READY requests it and carries both worker exits', async () => {
  const f = fixture();
  f.channel.output.on('data', (bytes: Buffer) => {
    const line = JSON.parse(bytes.toString()) as { body: unknown; id: number };
    expect(line.body).toEqual({ expectedGrantText: 'attempt-grant' });
    f.channel.input.write(JSON.stringify({ id: line.id, value: 'attempt-authority' }) + '\n');
  });
  operations.run.mockImplementation(async (_attempt, _budget, grants, workers) => {
    const { signal } = new AbortController();
    expect(grants.server).toBe('server-authority');
    expect(await grants.attempt(signal)).toBe('attempt-authority');
    expect(await workers.initialAndWarm('input', signal)).toBe('warm');
    return workers.cold('warm', signal);
  });
  await expect(runH06NativeTemporalFromChat(f.value, f.channel)).resolves.toBe('cold');
  expect(operations.resolve).toHaveBeenCalledWith({
    request: f.attempt.request,
    expectedGrantText: 'server-grant',
  });
  expect(f.workers.initialAndWarm).toHaveBeenCalledWith('input', expect.any(AbortSignal));
  expect(f.workers.cold).toHaveBeenCalledWith('warm', expect.any(AbortSignal));
});

it('reports a failed direct CLI run and removes its signal handlers', async () => {
  const f = fixture();
  operations.resolve.mockRejectedValue(new Error('grant refused'));
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const argv = process.argv;
  const exitCode = process.exitCode;
  const listeners = process.listenerCount('SIGINT');
  try {
    process.argv = [
      'node',
      fileURLToPath(new URL('./comparisonH06NativeTemporalRun.ts', import.meta.url)),
      '--run',
      f.json('run.json', f.value).path,
    ];
    vi.resetModules();
    await import('./comparisonH06NativeTemporalRun.js');
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Error: grant refused\n'));
    expect(process.exitCode).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});

it('prints the direct read-only plan and aborts a run on SIGTERM before opening the driver', async () => {
  const f = fixture();
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const argv = process.argv;
  const path = f.json('run.json', f.value).path;
  try {
    process.argv = [
      'node',
      fileURLToPath(new URL('./comparisonH06NativeTemporalRun.ts', import.meta.url)),
      '--plan',
      path,
    ];
    vi.resetModules();
    await import('./comparisonH06NativeTemporalRun.js');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('server-grant'));

    let resolve!: (value: string) => void;
    operations.resolve.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const running = h06NativeTemporalRunMain(['--run', path]);
    process.emit('SIGTERM');
    resolve('server-authority');
    await expect(running).rejects.toThrow('h06-temporal-run-interrupted');
    expect(operations.run).not.toHaveBeenCalled();
  } finally {
    process.argv = argv;
  }
});

it('carries manual cancellation into server startup before READY without requesting an attempt or starting Workers', async () => {
  const f = fixture();
  let entered!: () => void;
  const beforeReady = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const notice = vi.fn();
  f.channel.output.on('data', notice);
  operations.run.mockImplementation(async (_request, _budget, grants, workers, signal) => {
    expect(signal).toBe(f.channel.signal);
    expect(grants.server).toBe('server-authority');
    expect(workers).toBeDefined();
    const source = grants.attempt;
    expect(source).toBeTypeOf('function');
    entered();
    return new Promise((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
    );
  });
  const running = runH06NativeTemporalFromChat(f.value, f.channel);
  await beforeReady;
  f.controller.abort(new Error('manual stop before READY'));
  await expect(running).rejects.toThrow('manual stop before READY');
  expect(notice).not.toHaveBeenCalled();
  expect(f.workers.initialAndWarm).not.toHaveBeenCalled();
  expect(f.workers.cold).not.toHaveBeenCalled();
  expect(f.channel.input.listenerCount('data')).toBe(0);
});
