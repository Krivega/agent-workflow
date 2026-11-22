import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import {
  h06TemporalAutonomousRunMain,
  planH06TemporalAutonomousRun,
  runH06TemporalAutonomousFromChat,
} from './comparisonH06TemporalAutonomousRun.js';

const operations = vi.hoisted(() => ({
  plan: vi.fn(),
  source: vi.fn(),
  consume: vi.fn(),
  workers: vi.fn(),
  run: vi.fn(),
}));
vi.mock('./comparisonH06NativeAuthority.js', () => ({
  currentH06HumanAuthority: operations.source,
}));
vi.mock('./comparisonH06TemporalAutonomousAuthority.js', () => ({
  planH06TemporalAutonomousAuthority: operations.plan,
  consumeH06TemporalAutonomousAuthority: operations.consume,
}));
vi.mock('./comparisonH06NativeTemporalDriver.js', () => ({
  runH06TemporalAutonomousDriver: operations.run,
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
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-autonomous-run-'));
  roots.push(root);
  const pin = (path: string) => ({ path, sha256: digest(readFileSync(path)) });
  const save = (name: string, value: unknown) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return pin(path);
  };
  const node = save('node', 'fixture node');
  const worker = {
    node,
    tsx: pin(fileURLToPath(import.meta.resolve('tsx'))),
    entry: pin(
      fileURLToPath(new URL('./comparisonH06NativeTemporalProcesses.ts', import.meta.url)),
    ),
  };
  const plan = {
    input: { kind: 'comparison-h06-temporal-autonomous/3' },
    request: { binding: { node }, chat: { threadId: 'root' }, runtime: [worker.tsx, worker.entry] },
    expectedGrantText: 'exact-autonomous-grant',
  };
  const authority = { kind: 'authority-fixture' };
  const input = {
    kind: 'comparison-h06-temporal-autonomous-run/3',
    authority: save('authority.json', authority),
    worker,
  };
  const claim = {
    receipt: save('claim.json', 'validated parent fixture'),
    workDeadlineMs: Date.now() + 20000,
    stopDeadlineMs: Date.now() + 30000,
  };
  const workers = {
    initialAndWarm: vi.fn(async (_input: unknown, _signal: AbortSignal) => 'warm'),
    cold: vi.fn(async (_input: unknown, _signal: AbortSignal) => 'cold'),
  };
  operations.plan.mockReturnValue(plan);
  operations.source.mockResolvedValue('primary-source');
  operations.consume.mockResolvedValue(claim);
  operations.workers.mockReturnValue(workers);
  const abort = new AbortController();
  return { input, plan, save, claim, authority, worker, workers, abort };
}

it('plans exact pinned workers without observing or consuming authority', async () => {
  const f = fixture();
  expect(planH06TemporalAutonomousRun(f.input)).toEqual({
    authority: f.input.authority,
    plan: f.plan,
    worker: f.worker,
  });
  await expect(
    h06TemporalAutonomousRunMain(['--plan', f.save('run.json', f.input).path]),
  ).resolves.toMatchObject({ plan: f.plan });
  expect(operations.source).not.toHaveBeenCalled();
  expect(operations.consume).not.toHaveBeenCalled();
  expect(operations.workers).not.toHaveBeenCalled();
  expect(() => planH06TemporalAutonomousRun({ ...f.input, kind: 'wrong' })).toThrow(
    'h06-temporal-autonomous-run-kind',
  );
  for (const field of ['node', 'tsx', 'entry'] as const)
    expect(() =>
      planH06TemporalAutonomousRun({
        ...f.input,
        worker: { ...f.worker, [field]: f.save('other.json', 'foreign') },
      }),
    ).toThrow('h06-temporal-autonomous-run-worker');
  f.plan.request.runtime.length = 0;
  expect(() => planH06TemporalAutonomousRun(f.input)).toThrow('h06-temporal-autonomous-run-worker');
  await expect(h06TemporalAutonomousRunMain([])).rejects.toThrow(
    'h06-temporal-autonomous-run-arguments',
  );
  await expect(h06TemporalAutonomousRunMain(['--wrong', 'path'])).rejects.toThrow(
    'h06-temporal-autonomous-run-arguments',
  );
});

it('routes the explicit reference run through the same single admission and driver', async () => {
  const f = fixture();
  f.plan.input.kind = 'comparison-h06-temporal-reference/4';
  f.input.kind = 'comparison-h06-temporal-reference-run/4';
  const authority = { kind: 'comparison-h06-temporal-reference/4', approvedProposal: 'pinned' };
  f.input.authority = f.save('reference-authority.json', authority);
  expect(planH06TemporalAutonomousRun(f.input)).toMatchObject({ plan: f.plan, worker: f.worker });
  expect(operations.source).not.toHaveBeenCalled();
  expect(operations.consume).not.toHaveBeenCalled();
  operations.run.mockResolvedValueOnce('reference-completed');
  await expect(
    h06TemporalAutonomousRunMain(['--run', f.save('reference-run.json', f.input).path]),
  ).resolves.toBe('reference-completed');
  expect(operations.consume).toHaveBeenCalledExactlyOnceWith(
    authority,
    'primary-source',
    undefined,
    expect.any(AbortSignal),
  );
  expect(operations.run).toHaveBeenCalledExactlyOnceWith(
    f.claim.receipt,
    expect.any(Object),
    expect.any(AbortSignal),
  );
});

it.each([
  ['comparison-h06-temporal-autonomous-run/3', 'comparison-h06-temporal-reference/4'],
  ['comparison-h06-temporal-reference-run/4', 'comparison-h06-temporal-autonomous/3'],
  ['comparison-h06-temporal-reference-run/4', 'comparison-h06-temporal-reference/5'],
])('rejects outer %s paired with authority %s before admission', async (runKind, authorityKind) => {
  const f = fixture();
  f.input.kind = runKind;
  f.plan.input.kind = authorityKind;
  await expect(runH06TemporalAutonomousFromChat(f.input, f.abort.signal)).rejects.toThrow(
    'h06-temporal-autonomous-run-authority-kind',
  );
  expect(operations.source).not.toHaveBeenCalled();
  expect(operations.consume).not.toHaveBeenCalled();
  expect(operations.workers).not.toHaveBeenCalled();
});

it('rejects a reference kind replayed as another version or with extra run authority fields', () => {
  const f = fixture();
  f.plan.input.kind = 'comparison-h06-temporal-reference/4';
  expect(() =>
    planH06TemporalAutonomousRun({ ...f.input, kind: 'comparison-h06-temporal-reference-run/3' }),
  ).toThrow('h06-temporal-autonomous-run-kind');
  expect(() =>
    planH06TemporalAutonomousRun({
      ...f.input,
      kind: 'comparison-h06-temporal-reference-run/4',
      source: 'synthetic',
    }),
  ).toThrow();
  expect(operations.source).not.toHaveBeenCalled();
  expect(operations.consume).not.toHaveBeenCalled();
});

it('does not start workers or server before the single admission and preserves its clocks', async () => {
  const f = fixture();
  operations.consume.mockRejectedValueOnce(new Error('invalid primary grant'));
  await expect(runH06TemporalAutonomousFromChat(f.input, f.abort.signal)).rejects.toThrow(
    'invalid primary grant',
  );
  expect(operations.workers).not.toHaveBeenCalled();
  expect(operations.run).not.toHaveBeenCalled();
  operations.workers.mockReturnValue(f.workers);
  operations.run.mockImplementation(async (receipt, workers: typeof f.workers) => {
    expect(receipt).toEqual(f.claim.receipt);
    const signal = new AbortController().signal;
    expect(await workers.initialAndWarm('input', signal)).toBe('warm');
    return workers.cold('warm', signal);
  });
  await expect(runH06TemporalAutonomousFromChat(f.input, f.abort.signal, 10)).resolves.toBe('cold');
  expect(operations.run).toHaveBeenCalledWith(f.claim.receipt, expect.any(Object), f.abort.signal);
  expect(operations.consume).toHaveBeenLastCalledWith(
    f.authority,
    'primary-source',
    10,
    f.abort.signal,
  );
  expect(operations.workers).toHaveBeenCalledWith(
    { ...f.worker, workDeadlineMs: f.claim.workDeadlineMs, stopDeadlineMs: f.claim.stopDeadlineMs },
    expect.any(Object),
  );
  expect(f.workers.initialAndWarm).toHaveBeenCalledWith('input', expect.any(AbortSignal));
  expect(f.workers.cold).toHaveBeenCalledWith('warm', expect.any(AbortSignal));
  const chat = operations.workers.mock.calls[0]![1] as {
    source(): Promise<unknown>;
    record(): Promise<unknown>;
  };
  await expect(chat.source()).rejects.toThrow('h06-temporal-autonomous-unexpected-human-source');
  await expect(chat.record()).rejects.toThrow('h06-temporal-autonomous-unexpected-human-notice');
});

it('aborts before admission, after source observation and after admission without resetting it', async () => {
  const f = fixture();
  f.abort.abort(new Error('before-source'));
  await expect(runH06TemporalAutonomousFromChat(f.input, f.abort.signal)).rejects.toThrow(
    'before-source',
  );
  expect(operations.source).not.toHaveBeenCalled();
  const sourceAbort = new AbortController();
  operations.source.mockImplementationOnce(async () => {
    sourceAbort.abort(new Error('after-source'));
    return 'source';
  });
  await expect(runH06TemporalAutonomousFromChat(f.input, sourceAbort.signal)).rejects.toThrow(
    'after-source',
  );
  expect(operations.consume).not.toHaveBeenCalled();
  const claimAbort = new AbortController();
  operations.consume.mockImplementationOnce(async () => {
    claimAbort.abort(new Error('after-claim'));
    return f.claim;
  });
  await expect(runH06TemporalAutonomousFromChat(f.input, claimAbort.signal)).rejects.toThrow(
    'after-claim',
  );
  expect(operations.consume).toHaveBeenCalledTimes(1);
  expect(operations.run).not.toHaveBeenCalled();
});

it('cleans signal handlers on CLI failure and handles interruption during source observation', async () => {
  const f = fixture(),
    path = f.save('run.json', f.input).path;
  operations.source.mockRejectedValueOnce(new Error('source unavailable'));
  const before = process.listenerCount('SIGINT');
  await expect(h06TemporalAutonomousRunMain(['--run', path])).rejects.toThrow('source unavailable');
  expect(process.listenerCount('SIGINT')).toBe(before);
  operations.source.mockImplementationOnce(async () => {
    process.emit('SIGTERM');
    return 'primary';
  });
  await expect(h06TemporalAutonomousRunMain(['--run', path])).rejects.toThrow(
    'h06-temporal-autonomous-run-interrupted',
  );
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(operations.consume).not.toHaveBeenCalled();
});

it('does not wait for an absent Worker when the server fails before READY', async () => {
  const f = fixture();
  operations.run.mockRejectedValueOnce(new Error('before-ready'));
  await expect(runH06TemporalAutonomousFromChat(f.input, f.abort.signal)).rejects.toThrow(
    'before-ready',
  );
  expect(f.workers.initialAndWarm).not.toHaveBeenCalled();
  expect(operations.consume).toHaveBeenCalledTimes(1);
});

it('waits for the owned Worker cleanup after the server abort race and never retries admission', async () => {
  const f = fixture();
  let finish!: () => void;
  const cleaned = new Promise<string>((_resolve, reject) => {
    finish = () => reject(new Error('worker-stopped'));
  });
  f.workers.initialAndWarm.mockReturnValue(cleaned);
  operations.run.mockImplementationOnce(async (_receipt, workers: typeof f.workers) => {
    void workers.initialAndWarm('input', f.abort.signal).catch(() => undefined);
    throw new Error('server-aborted');
  });
  let settled = false;
  const running = runH06TemporalAutonomousFromChat(f.input, f.abort.signal);
  const checked = expect(running)
    .rejects.toThrow('server-aborted')
    .then(() => {
      settled = true;
    });
  await vi.waitFor(() => expect(f.workers.initialAndWarm).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  finish();
  await checked;
  expect(settled).toBe(true);
  expect(operations.consume).toHaveBeenCalledTimes(1);
  expect(f.workers.cold).not.toHaveBeenCalled();
});

it('prints a direct plan and reports a failed direct execution', async () => {
  const f = fixture(),
    path = f.save('run.json', f.input).path;
  const argv = process.argv,
    exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    process.argv = [
      'node',
      fileURLToPath(new URL('./comparisonH06TemporalAutonomousRun.ts', import.meta.url)),
      '--plan',
      path,
    ];
    vi.resetModules();
    await import('./comparisonH06TemporalAutonomousRun.js');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('exact-autonomous-grant'));
    operations.source.mockRejectedValueOnce(new Error('grant rejected'));
    process.argv[2] = '--run';
    vi.resetModules();
    await import('./comparisonH06TemporalAutonomousRun.js');
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Error: grant rejected\n'));
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
