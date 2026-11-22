import { fork } from 'node:child_process';
import type * as ChildProcesses from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { digest } from '../src/adapters/artifacts/files.js';
import {
  nativeHumanAuthorizationText,
  nativeReaderNotice,
  type NativeReaderSource,
} from '../src/adapters/codex/readerAuthority.js';
import { makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import { object } from '../src/contracts/project.js';
import type * as Pins from './comparisonH04Contract.js';
import type * as Safety from '../examples/temporal-consumers/full/safety.mjs';
import type { H06TemporalCommandChat } from './comparisonH06NativeTemporalDriver.js';
import { h06TemporalWorkerProcesses } from './comparisonH06NativeTemporalProcesses.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  parent: vi.fn(),
  own: vi.fn(),
  read: vi.fn(),
  stageWarm: vi.fn(),
  stageCold: vi.fn(),
  stageDeadline: vi.fn(),
}));
vi.mock('./comparisonH06TemporalAutonomousAuthority.js', () => ({
  readH06TemporalAutonomousAuthority: mocks.parent,
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcesses>()),
  spawn: mocks.spawn,
}));
vi.mock('../examples/temporal-consumers/full/safety.mjs', () => ({ ownProcess: mocks.own }));
vi.mock('./comparisonH04Contract.js', async (original) => ({
  ...(await original<typeof Pins>()),
  readH04Pin: mocks.read,
}));
vi.mock('./comparisonH06NativeTemporalDriver.js', () => ({
  runH06NativeTemporalInitialAndWarm: mocks.stageWarm,
  runH06NativeTemporalCold: mocks.stageCold,
}));
vi.mock('./td054DeadlineNative.mjs', () => ({ runTD054DeadlineLoad: mocks.stageDeadline }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  for (const entry of readdirSync(outcomesRoot)) rmSync(join(outcomesRoot, entry));
});
const outcomesRoot = mkdtempSync(join(realpathSync(tmpdir()), 'h06-worker-outcomes-'));
afterAll(() => rmSync(outcomesRoot, { recursive: true, force: true }));

const pin = (path: string) => ({ path, sha256: '0'.repeat(64) });
const node = pin('/node');
const inputs = {
  node,
  entry: pin(fileURLToPath(new URL('./comparisonH06NativeTemporalProcesses.ts', import.meta.url))),
  tsx: pin(fileURLToPath(import.meta.resolve('tsx'))),
};
const attempt = {
  attempt: { binding: { node } },
  authority: {},
  server: pin(join(outcomesRoot, 'ready')),
};
const warm = {
  claim: pin('/claim'),
  started: pin('/started'),
  warm: {},
  cold: { server: attempt.server },
  coldPauseAck: pin('/pause'),
  duration: {},
};
const cold = { cold: {}, result: {}, history: pin('/history') };
const source: NativeReaderSource = {
  kind: 'codex-user-command',
  schemaVersion: 1,
  transcript: '/sessions/chat.jsonl',
  threadId: 'chat',
  turnId: 'turn',
  user: { line: 1, sha256: '0'.repeat(64) },
};
const target = {
  workflowId: 'workflow',
  projectId: 'project',
  taskId: 'task',
  roleId: 'task',
  hostId: 'host',
  workspaceId: 'workspace',
  owner: 'owner',
  generation: 1,
  requirementsRevision: 1,
};

function command(step: number) {
  const ids = ['h06-warm-pause', 'h06-warm-resume', 'h06-cold-pause', 'h06-cold-resume'];
  const bytes = Buffer.from(JSON.stringify(source));
  return makeTaskExecutionCommand({
    schemaVersion: 2,
    commandId: ids[step]!,
    author: target.owner,
    action: step % 2 === 0 ? 'pause' : 'resume',
    expectedRevision: step,
    attempt: [0, 1, 1, 2][step]!,
    target,
    source: { sha256: digest(bytes), bytes: bytes.length },
    payload: { sha256: '0'.repeat(64), bytes: 1 },
  });
}

function fixture(workMs = 30000) {
  const abort = new AbortController();
  const chat = { source: vi.fn(async () => source), record: vi.fn(async () => {}) };
  const deadlines = {
    workDeadlineMs: Date.now() + workMs,
    stopDeadlineMs: Date.now() + workMs + 2000,
  };
  const workers = h06TemporalWorkerProcesses({ ...inputs, ...deadlines }, chat);
  return { abort, chat, workers, deadlines };
}

function fakeProcess(
  stage: 'initial-and-warm' | 'cold' | 'deadline-load',
  options: {
    corrupt?: 'proposal' | 'notice' | 'binding' | 'send' | 'worker-error' | 'no-pid';
    pid?: number;
    autonomous?: boolean;
    cancelDelayMs?: number;
    ignoreCancel?: boolean;
  } = {},
) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
  });
  const pid = options.pid ?? 10000;
  let settle: (result: { stopped: boolean; code: number | null; signal: string | null }) => void;
  const done = new Promise((accept: typeof settle) => {
    settle = accept;
  });
  function finish(
    exit = true,
    stopped = true,
    code: number | null = 0,
    signal: string | null = null,
  ) {
    if (exit) {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
    }
    settle({ stopped, code, signal });
  }
  const stop = vi.fn(async () => {
    finish(true, true, null, 'SIGTERM');
    return done;
  });
  let reported!: () => void;
  const resultSent = new Promise<void>((accept) => {
    reported = accept;
  });
  const send = vi.fn((raw: unknown, callback: (error: Error | null) => void) => {
    const message = object(raw);
    const { kind, parent, nonce } = message;
    const step = Number(message.step);
    function reply(type: string, extra: Record<string, unknown>) {
      child.emit('message', { kind, stage, parent, nonce, pid, type, ...extra });
    }
    function propose(next: number) {
      const text = nativeHumanAuthorizationText(command(next));
      reply('source', {
        step: next,
        text: options.corrupt === 'proposal' ? '{}' : text,
        ...(options.corrupt === 'binding' ? { nonce: 'another-worker' } : {}),
      });
    }
    if (options.corrupt === 'send') {
      callback(new Error('write failed'));
      return false;
    }
    callback(null);
    if (message.type === 'cancel') {
      if (!options.ignoreCancel)
        setTimeout(() => finish(true, true, 1), options.cancelDelayMs ?? 0);
      return true;
    }
    queueMicrotask(() => {
      if (message.type === 'start' && stage === 'deadline-load' && options.corrupt === undefined)
        return;
      if (message.type === 'start' && options.corrupt === 'worker-error')
        reply('error', { message: 'worker refused' });
      else if (message.type === 'start' && stage === 'initial-and-warm' && !options.autonomous)
        propose(0);
      else if (message.type === 'source') {
        const notice = nativeReaderNotice(command(step));
        reply('record', {
          step,
          source: message.source,
          notice: options.corrupt === 'notice' ? '{}' : notice,
        });
      } else if (message.type === 'record' && step < 3) propose(step + 1);
      else {
        reply('result', { value: stage === 'cold' ? cold : warm });
        reported();
      }
    });
    return true;
  });
  mocks.spawn.mockReturnValueOnce(
    Object.assign(child, { pid: options.corrupt === 'no-pid' ? undefined : pid, send }),
  );
  mocks.own.mockReturnValueOnce({ done, stop });
  return { child, finish, resultSent, send, stop };
}

it('uses pinned Node, exchanges exact command notices and waits for observed exit in each stage', async () => {
  const { abort, chat, workers } = fixture();
  const first = fakeProcess('initial-and-warm');
  let exited = false;
  const running = workers.initialAndWarm(attempt, abort.signal).then((value) => {
    exited = true;
    return value;
  });
  await first.resultSent;
  expect(exited).toBe(false);
  expect(chat.source).toHaveBeenCalledTimes(4);
  expect(chat.record).toHaveBeenCalledTimes(4);
  expect(chat.record).toHaveBeenCalledWith(
    nativeReaderNotice(command(2)),
    source,
    expect.any(AbortSignal),
  );
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
    node.path,
    [
      '--import',
      inputs.tsx.path,
      inputs.entry.path,
      '--h06-temporal-worker',
      'initial-and-warm',
      expect.any(String),
    ],
    expect.objectContaining({ detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  );
  first.finish();
  const initial = await running;
  const second = fakeProcess('cold', { pid: 10001 });
  const resumed = workers.cold(initial, abort.signal);
  await second.resultSent;
  expect(chat.source).toHaveBeenCalledTimes(4);
  second.finish();
  await expect(resumed).resolves.toEqual(cold);
  expect(first.stop).not.toHaveBeenCalled();
  expect(second.stop).not.toHaveBeenCalled();
});

it.each([
  ['proposal', 'unexpected-field'],
  ['notice', 'h06-temporal-process-notice'],
  ['binding', 'h06-temporal-process-binding'],
  ['send', 'write failed'],
  ['worker-error', 'worker refused'],
  ['no-pid', 'h06-temporal-process-pid'],
] as const)('stops the owned child when its %s fails validation', async (corrupt, error) => {
  const { abort, chat, workers } = fixture();
  const child = fakeProcess('initial-and-warm', { corrupt });
  await expect(workers.initialAndWarm(attempt, abort.signal)).rejects.toThrow(error);
  expect(child.stop).toHaveBeenCalledOnce();
  expect(chat.record).not.toHaveBeenCalled();
});

it('never accepts a result without an observed exit', async () => {
  const { abort, workers } = fixture();
  const child = fakeProcess('initial-and-warm');
  const running = workers.initialAndWarm(attempt, abort.signal);
  await child.resultSent;
  child.finish(false);
  await expect(running).rejects.toThrow('h06-temporal-process-stop-unconfirmed');
  expect(
    JSON.parse(
      readFileSync(join(outcomesRoot, 'worker-initial-and-warm-outcome.json'), 'utf8'),
    ) as unknown,
  ).toMatchObject({ observedExit: false });
});

it.each(['root', 'server'] as const)(
  'refuses outcome publication after bound %s drift',
  async (kind) => {
    const f = fixture();
    const child = fakeProcess('initial-and-warm');
    const running = f.workers.initialAndWarm(attempt, f.abort.signal);
    await child.resultSent;
    const retired = outcomesRoot + '-retired';
    try {
      if (kind === 'root') {
        renameSync(outcomesRoot, retired);
        mkdirSync(outcomesRoot);
      } else
        mocks.read.mockImplementation((value: Pins.H04Pin) => {
          if (value.path === attempt.server.path) throw new Error('server pin drift');
        });
      child.finish();
      await expect(running).rejects.toThrow(
        kind === 'root' ? 'h06-temporal-process-root-changed' : 'server pin drift',
      );
      expect(existsSync(join(outcomesRoot, 'worker-initial-and-warm-outcome.json'))).toBe(false);
    } finally {
      rmSync(retired, { recursive: true, force: true });
    }
  },
);

it.each([new Error('operator abort'), 'operator abort'])(
  'waits for owned cleanup on cancellation while reading a human turn (%s)',
  async (reason) => {
    const { abort, chat, workers } = fixture();
    const child = fakeProcess('initial-and-warm');
    let read!: () => void;
    const reading = new Promise<void>((accept) => {
      read = accept;
    });
    chat.source.mockImplementation(() => {
      read();
      return new Promise(() => {});
    });
    const running = workers.initialAndWarm(attempt, abort.signal);
    await reading;
    abort.abort(reason);
    await expect(running).rejects.toThrow('operator abort');
    expect(child.stop).not.toHaveBeenCalled();
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cancel' }),
      expect.any(Function),
    );
    expect(chat.record).not.toHaveBeenCalled();
  },
);

it('stops the owned worker when a human response exceeds the work deadline', async () => {
  const { abort, chat, workers } = fixture(80);
  const child = fakeProcess('initial-and-warm');
  chat.source.mockImplementation(() => new Promise(() => {}));
  await expect(workers.initialAndWarm(attempt, abort.signal)).rejects.toThrow(
    'h06-temporal-process-deadline',
  );
  expect(child.stop).not.toHaveBeenCalled();
  expect(child.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'cancel' }),
    expect.any(Function),
  );
  expect(chat.record).not.toHaveBeenCalled();
});

it.each(['callback', 'throw'] as const)(
  'uses forced cleanup when cooperative IPC fails (%s)',
  async (kind) => {
    const f = fixture();
    const child = fakeProcess('initial-and-warm');
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.chat.source.mockImplementation(() => {
      entered();
      return new Promise(() => {});
    });
    const running = f.workers.initialAndWarm(attempt, f.abort.signal);
    await reading;
    child.send.mockImplementationOnce((_frame, callback) => {
      if (kind === 'throw') throw new Error('closed channel');
      callback(new Error('closed channel'));
      return false;
    });
    f.abort.abort(new Error('cancel active stage'));
    child.child.emit('message', {});
    await expect(running).rejects.toThrow('cancel active stage');
    expect(child.stop).toHaveBeenCalledOnce();
  },
);

it.each([
  ['initial-and-warm', false],
  ['initial-and-warm', true],
  ['deadline-load', false],
  ['deadline-load', true],
] as const)(
  'cancels %s at work deadline and retains cleanup before the unchanged hard fallback (hung=%s)',
  async (stage, hung) => {
    vi.useFakeTimers();
    const actual = await vi.importActual<typeof Safety>(
      '../examples/temporal-consumers/full/safety.mjs',
    );
    const f = fixture(10000);
    const child = fakeProcess(stage, {
      pid: 911111,
      cancelDelayMs: 1200,
      ignoreCancel: hung,
    });
    let release: (value: NativeReaderSource) => void = () => {};
    f.chat.source.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const signals: string[] = [];
    let receipt!: Promise<Safety.OwnedProcessReceipt>;
    mocks.own.mockReset();
    mocks.own.mockImplementationOnce(
      (process: ChildProcesses.ChildProcess, options: Parameters<typeof Safety.ownProcess>[1]) => {
        const began = Date.now(),
          clock = performance.now();
        const owned = actual.ownProcess(process, {
          ...options,
          now: () => clock + Date.now() - began,
          snapshot: () =>
            child.child.exitCode === null && child.child.signalCode === null
              ? [{ pid: 911111, ppid: 1, pgid: 911111, identity: 'owned-worker' }]
              : [],
          listeners: () => false,
          pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          signal: (_pid, signal) => {
            signals.push(signal);
            if (signal === 'SIGKILL') child.finish(true, true, null, signal);
          },
        });
        receipt = owned.done;
        return owned;
      },
    );
    const invoke = () =>
      stage === 'deadline-load'
        ? f.workers.deadlineLoad(
            { claim: warm.claim, server: attempt.server, node },
            f.abort.signal,
          )
        : f.workers.initialAndWarm(attempt, f.abort.signal);
    const result = invoke().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(signals).toEqual([]);
    expect(child.send.mock.calls.filter(([frame]) => object(frame).type === 'cancel')).toHaveLength(
      1,
    );
    release(source);
    await vi.advanceTimersByTimeAsync(1250);
    expect(f.chat.record).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
    if (hung) await vi.advanceTimersByTimeAsync(650);
    expect(await result).toMatchObject({ message: 'h06-temporal-process-deadline' });
    expect(await receipt).toMatchObject({
      stopped: true,
      code: hung ? null : 1,
      signal: hung ? 'SIGKILL' : null,
      killed: hung,
      deadlineReached: hung,
    });
    expect(signals).toEqual(hung ? ['SIGTERM', 'SIGKILL'] : []);
    const outcome = JSON.parse(
      readFileSync(join(outcomesRoot, `worker-${stage}-outcome.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(outcome).toMatchObject({
      kind: 'h06-native-temporal-process-outcome/1',
      failure: 'Error: h06-temporal-process-deadline',
      observedExit: true,
      receipt: { signal: hung ? 'SIGKILL' : null, killed: hung },
    });
    if (stage === 'deadline-load')
      expect(outcome.deadlineCancel).toEqual({
        sentAt: f.deadlines.workDeadlineMs,
        deliveredAt: f.deadlines.workDeadlineMs,
      });
    await expect(invoke()).rejects.toThrow('already-attempted');
    expect(Date.now()).toBeLessThan(f.deadlines.stopDeadlineMs);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(child.stop).not.toHaveBeenCalled();
  },
);

it('rejects a malformed start over real Node IPC before entering a native stage', async () => {
  const nonce = randomUUID();
  const child = fork(inputs.entry.path, ['--h06-temporal-worker', 'cold', nonce], {
    execPath: process.execPath,
    execArgv: ['--import', inputs.tsx.path],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const signal = AbortSignal.timeout(5000);
  try {
    const reply: Promise<unknown[]> = once(child, 'message', { signal });
    const exit: Promise<unknown[]> = once(child, 'exit', { signal });
    const identity = {
      kind: 'h06-native-temporal-process/2',
      stage: 'cold',
      nonce,
      parent: process.pid,
      pid: child.pid,
    };
    child.send({ ...identity, type: 'start', input: {} });
    const [[message], status] = await Promise.all([reply, exit]);
    expect(message).toEqual({
      ...identity,
      type: 'error',
      message: expect.stringContaining('unexpected-field') as unknown,
    });
    expect(status).toEqual([1, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}, 6000);

function inMemoryWorker(
  stage: 'initial-and-warm' | 'cold' | 'deadline-load',
  mode: 'normal' | 'bad-reply' | 'send-error' | 'disconnected' = 'normal',
) {
  const emitter = new EventEmitter();
  const nonce = randomUUID();
  const identity = {
    kind: 'h06-native-temporal-process/2',
    stage,
    nonce,
    parent: 201,
    pid: 202,
  };
  const disconnect = vi.fn();
  const channel = Object.assign(emitter, {
    argv: [process.execPath, inputs.entry.path, '--h06-temporal-worker', stage, nonce],
    pid: identity.pid,
    ppid: identity.parent,
    connected: true,
    exitCode: undefined as number | undefined,
    disconnect,
    send: vi.fn((raw: unknown, callback: (error: Error | null) => void) => {
      const message = object(raw);
      if (message.type === 'source' && mode === 'send-error') {
        callback(new Error('broken IPC write'));
        return;
      }
      callback(null);
      if (message.type === 'source' || message.type === 'record')
        queueMicrotask(() => {
          emitter.emit('message', {
            ...identity,
            type: message.type,
            step: mode === 'bad-reply' ? -1 : message.step,
            ...(message.type === 'source' ? { source } : {}),
          });
        });
    }),
  });
  let started = false;
  emitter.on('newListener', (event) => {
    if (event !== 'message' || started) return;
    started = true;
    queueMicrotask(() => {
      if (mode === 'disconnected') {
        channel.connected = false;
        emitter.emit('disconnect');
      } else
        emitter.emit('message', {
          ...identity,
          type: 'start',
          input: stage === 'initial-and-warm' ? attempt : warm,
        });
    });
  });
  const facade = new Proxy(channel, {
    get(target, property, receiver): unknown {
      return property in target
        ? (Reflect.get(target, property, receiver) as unknown)
        : (Reflect.get(process, property, process) as unknown);
    },
  });
  async function run() {
    vi.doMock('node:process', () => ({ default: facade }));
    vi.resetModules();
    try {
      await import('./comparisonH06NativeTemporalProcesses.js');
    } finally {
      vi.doUnmock('node:process');
      vi.resetModules();
    }
  }
  return { channel, identity, run };
}

it.each(['normal', 'bad-reply', 'send-error'] as const)(
  'uses or rejects the child phase exchange in memory (%s)',
  async (mode) => {
    const { channel, identity, run } = inMemoryWorker('initial-and-warm', mode);
    const text = nativeHumanAuthorizationText(command(0));
    const notice = nativeReaderNotice(command(0));
    mocks.stageWarm.mockImplementation(
      async (_input: unknown, chat: H06TemporalCommandChat, signal: AbortSignal) => {
        const answer = await chat.source(text, signal);
        expect(answer).toEqual(source);
        await chat.record(notice, answer, signal);
        return warm;
      },
    );
    await run();
    expect(channel.disconnect).toHaveBeenCalledOnce();
    expect(channel.send.mock.calls.map(([message]) => message)).toEqual(
      mode === 'normal'
        ? [
            { ...identity, type: 'source', step: 0, text },
            { ...identity, type: 'record', step: 0, notice, source },
            { ...identity, type: 'result', value: warm },
          ]
        : [
            { ...identity, type: 'source', step: 0, text },
            {
              ...identity,
              type: 'error',
              message: expect.stringContaining(
                mode === 'send-error' ? 'broken IPC write' : 'h06-temporal-process-reply',
              ) as unknown,
            },
          ],
    );
    expect(channel.exitCode).toBe(mode === 'normal' ? undefined : 1);
  },
);

it('opens the child cold entry only with its bound start frame', async () => {
  const { channel, identity, run } = inMemoryWorker('cold');
  mocks.stageCold.mockResolvedValue(cold);
  await run();
  expect(mocks.stageCold).toHaveBeenCalledExactlyOnceWith(warm, expect.any(AbortSignal));
  expect(channel.send.mock.calls[0]?.[0]).toEqual({ ...identity, type: 'result', value: cold });
});

it.each(['bound', 'nonce', 'fields'] as const)(
  'cancels the active child through checked IPC (%s)',
  async (kind) => {
    const { channel, identity, run } = inMemoryWorker('cold');
    let cleaned = false;
    mocks.stageCold.mockImplementation(async (_input: unknown, signal: AbortSignal) => {
      try {
        queueMicrotask(() =>
          channel.emit('message', {
            ...identity,
            type: 'cancel',
            ...(kind === 'nonce' ? { nonce: 'foreign' } : {}),
            ...(kind === 'fields' ? { extra: true } : {}),
          }),
        );
        await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      } finally {
        cleaned = true;
      }
    });
    await run();
    expect(cleaned).toBe(true);
    expect(channel.exitCode).toBe(1);
    expect(channel.send.mock.calls.map(([frame]) => object(frame).type)).toEqual(['error']);
    expect(object(channel.send.mock.calls[0]![0]).message).toEqual(
      expect.stringContaining(
        kind === 'bound'
          ? 'h06-temporal-process-cancelled'
          : kind === 'nonce'
            ? 'h06-temporal-process-binding'
            : 'unexpected-field',
      ),
    );
    expect(channel.listenerCount('message')).toBe(0);
  },
);

it('retains nested cleanup failures and their causes in the bounded worker error message', async () => {
  const { channel, run } = inMemoryWorker('cold');
  const failure = new AggregateError(
    [
      new AggregateError(
        [new Error('writer-process-identity-lost', { cause: new Error('missing PID 8123') })],
        'h06-transport-stop-unknown',
      ),
    ],
    'h06-temporal-stage-and-stop-failed',
  );
  Object.assign(failure, { token: 'private-unrelated-property' });
  mocks.stageCold.mockRejectedValue(failure);
  await run();
  const message = object(channel.send.mock.calls[0]![0]);
  expect(message.type).toBe('error');
  expect(message.message).toEqual(expect.stringContaining('h06-temporal-stage-and-stop-failed'));
  expect(message.message).toEqual(expect.stringContaining('h06-transport-stop-unknown'));
  expect(message.message).toEqual(expect.stringContaining('writer-process-identity-lost'));
  expect(message.message).toEqual(expect.stringContaining('missing PID 8123'));
  expect(message.message).not.toEqual(expect.stringContaining('private-unrelated-property'));
  expect(String(message.message).length).toBeLessThanOrEqual(2048);
});

it.each(['plain', 'large', 'many', 'cycle', 'malformed-aggregate'] as const)(
  'bounds worker diagnostics without reading arbitrary properties (%s)',
  async (kind) => {
    const { channel, run } = inMemoryWorker('cold');
    let failure: unknown = 'plain worker failure';
    if (kind === 'large')
      failure = new AggregateError(
        Array.from({ length: 8 }, (_, index) => new Error(`${index}:` + 'x'.repeat(3000))),
        'many failures',
      );
    if (kind === 'many')
      failure = new AggregateError(
        Array.from({ length: 8 }, (_, index) => new Error(`failure-${index}`)),
        'many failures',
      );
    if (kind === 'cycle') {
      const loop = new Error('cyclic failure');
      loop.cause = loop;
      failure = loop;
    }
    if (kind === 'malformed-aggregate')
      failure = Object.assign(new AggregateError([], 'bad aggregate'), {
        errors: null,
        cause: 'retained scalar cause',
      });
    mocks.stageCold.mockRejectedValue(failure);
    await run();
    const message = String(object(channel.send.mock.calls[0]![0]).message);
    expect(message.length).toBeLessThanOrEqual(2048);
    if (kind === 'plain') expect(message).toBe(failure);
    if (kind === 'large') {
      expect(message).toContain('0:');
      expect(message).not.toContain('4:');
    }
    if (kind === 'many') {
      expect(message).toContain('failure-0');
      expect(message).toContain('failure-3');
      expect(message).not.toContain('failure-4');
    }
    if (kind === 'cycle') expect(message.match(/cyclic failure/gu)).toHaveLength(4);
    if (kind === 'malformed-aggregate') expect(message).toContain('retained scalar cause');
  },
);

it('cancels a child whose parent disconnects before start', async () => {
  const { channel, run } = inMemoryWorker('cold', 'disconnected');
  await run();
  expect(channel.exitCode).toBe(1);
  expect(channel.send).not.toHaveBeenCalled();
  expect(channel.disconnect).not.toHaveBeenCalled();
  expect(mocks.stageCold).not.toHaveBeenCalled();
});

it('runs only the deadline child hook and rejects an ordinary result or mismatched Node pin', async () => {
  const { channel, run } = inMemoryWorker('deadline-load');
  mocks.stageDeadline.mockRejectedValue(new Error('deadline hook cancelled'));
  await run();
  expect(mocks.stageDeadline).toHaveBeenCalled();
  expect(mocks.stageWarm).not.toHaveBeenCalled();
  expect(mocks.stageCold).not.toHaveBeenCalled();
  expect(object(channel.send.mock.calls[0]![0])).toMatchObject({
    type: 'error',
    message: expect.stringContaining('deadline hook cancelled') as unknown,
  });
  const f = fixture();
  expect(() =>
    f.workers.deadlineLoad(
      { claim: warm.claim, server: attempt.server, node: pin('/foreign') },
      f.abort.signal,
    ),
  ).toThrow('h06-temporal-process-node');
  const child = fakeProcess('deadline-load', { corrupt: 'worker-error' });
  await expect(
    f.workers.deadlineLoad({ claim: warm.claim, server: attempt.server, node }, f.abort.signal),
  ).rejects.toThrow('worker refused');
  expect(child.stop).toHaveBeenCalled();
});

it('rejects any terminal result from the LOAD-only stage', async () => {
  const f = fixture();
  const child = fakeProcess('deadline-load', { corrupt: 'proposal' });
  await expect(
    f.workers.deadlineLoad({ claim: warm.claim, server: attempt.server, node }, f.abort.signal),
  ).rejects.toThrow('h06-temporal-process-unexpected-load-result');
  expect(child.stop).toHaveBeenCalled();
});

it('passes the pinned autonomous mode across both processes without any human exchange', async () => {
  const f = fixture(),
    mode = { kind: 'temporal-autonomous/3', authority: pin('/parent') } as const;
  mocks.parent.mockReturnValue({
    ...f.deadlines,
    request: attempt.attempt,
    nativeClaim: warm.claim,
  });
  const child = fakeProcess('initial-and-warm', { autonomous: true });
  const running = f.workers.initialAndWarm({ ...attempt, authority: mode }, f.abort.signal);
  await child.resultSent;
  child.finish();
  const initial = await running;
  expect(f.chat.source).not.toHaveBeenCalled();
  expect(f.chat.record).not.toHaveBeenCalled();
  const second = fakeProcess('cold', { autonomous: true, pid: 10001 });
  const coldRunning = f.workers.cold(
    { ...initial, cold: { ...initial.cold, controlMode: mode, claim: warm.claim } },
    f.abort.signal,
  );
  await second.resultSent;
  second.finish();
  await expect(coldRunning).resolves.toEqual(cold);
  expect(f.chat.source).not.toHaveBeenCalled();
  expect(f.chat.record).not.toHaveBeenCalled();
});
it.each(['clock', 'request', 'claim', 'source'] as const)(
  'rejects autonomous IPC %s mismatch before any human relay',
  async (kind) => {
    const f = fixture(),
      mode = { kind: 'temporal-autonomous/3', authority: pin('/parent') } as const;
    mocks.parent.mockReturnValue({
      ...f.deadlines,
      request: kind === 'request' ? {} : attempt.attempt,
      nativeClaim: pin('/wrong'),
      ...(kind === 'clock' ? { stopDeadlineMs: 1 } : {}),
    });
    if (kind === 'source') {
      const child = fakeProcess('initial-and-warm');
      await expect(
        f.workers.initialAndWarm({ ...attempt, authority: mode }, f.abort.signal),
      ).rejects.toThrow('h06-temporal-process-order');
      expect(child.stop).toHaveBeenCalled();
    } else if (kind === 'claim')
      await expect(
        f.workers.cold(
          { ...warm, cold: { claim: warm.claim, controlMode: mode } } as unknown as Parameters<
            typeof f.workers.cold
          >[0],
          f.abort.signal,
        ),
      ).rejects.toThrow('h06-temporal-process-autonomous-input');
    else
      await expect(
        f.workers.initialAndWarm({ ...attempt, authority: mode }, f.abort.signal),
      ).rejects.toThrow(
        kind === 'clock'
          ? 'h06-temporal-process-autonomous-clock'
          : 'h06-temporal-process-autonomous-input',
      );
    expect(f.chat.source).not.toHaveBeenCalled();
    expect(f.chat.record).not.toHaveBeenCalled();
  },
);
