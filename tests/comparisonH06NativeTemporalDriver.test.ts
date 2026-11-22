import type { H06TemporalAutonomousMode } from './comparisonH06TemporalAutonomousControls.js';
import { afterEach, expect, it, vi } from 'vitest';
import {
  runH06NativeTemporalCold,
  runH06TemporalAutonomousDriver,
  runH06NativeTemporalDriver,
  runH06NativeTemporalInitialAndWarm,
} from './comparisonH06NativeTemporalDriver.js';

const mock = vi.hoisted(() => ({
  attempt: vi.fn(),
  parent: vi.fn(),
  openParent: vi.fn(),
  autonomousServer: vi.fn(),
  setup: vi.fn(),
  initial: vi.fn(),
  reopen: vi.fn(),
  start: vi.fn(),
  paused: vi.fn(),
  duration: vi.fn(),
  evidence: vi.fn(),
  history: vi.fn(),
  replay: vi.fn(),
  planPause: vi.fn(),
  writerReady: vi.fn(),
  usage: vi.fn(),
  issuePause: vi.fn(),
  deliverPause: vi.fn(),
  issueResume: vi.fn(),
  readerFailure: vi.fn(),
  watchReader: vi.fn(),
}));
vi.mock('./comparisonH06NativeReaderFailure.js', () => ({
  assertH06NativeReaderNotBlocked: mock.readerFailure,
  withH06NativeReaderFailure: mock.watchReader,
}));
vi.mock('./comparisonH06TemporalAutonomousAuthority.js', () => ({
  readH06TemporalAutonomousAuthority: mock.parent,
  openH06TemporalAutonomousNativeClaim: mock.openParent,
}));
vi.mock('./comparisonH06NativeTemporalServerSetup.js', () => ({
  withH06NativeTemporalServer: mock.autonomousServer,
}));
vi.mock('./comparisonH06NativeTemporalOperator.js', () => ({
  runH06NativeTemporalServerSetup: mock.setup,
  runH06NativeTemporalOperator: mock.initial,
  reopenH06NativeTemporalOperator: mock.reopen,
}));
vi.mock('./comparisonH06NativeTemporal.js', () => ({
  captureH06NativePausedStatus: mock.paused,
  readH06NativeTemporalStart: mock.start,
}));
vi.mock('./comparisonH06NativeTemporalDuration.js', () => ({
  checkH06NativeTemporalDuration: mock.duration,
}));
vi.mock('./comparisonH06NativeTemporalEvidence.js', () => ({
  checkH06NativeTemporalEvidence: mock.evidence,
}));
vi.mock('./comparisonH06NativeTemporalHistory.js', () => ({
  captureH06NativeTemporalHistory: mock.history,
  replayH06NativeTemporalHistory: mock.replay,
}));
vi.mock('./comparisonH06NativeTemporalPause.js', () => ({
  planH06NativeTemporalPause: mock.planPause,
  observeH06NativeTemporalWriterReady: mock.writerReady,
  issueH06NativeTemporalPause: mock.issuePause,
  pauseH06NativeTemporal: mock.deliverPause,
}));
vi.mock('./comparisonH06NativeTemporalResume.js', () => ({
  issueH06NativeTemporalResume: mock.issueResume,
}));
vi.mock('./comparisonH06NativeAttempt.js', () => ({
  planH06NativeAttempt: mock.attempt,
}));
vi.mock('./comparisonH01Contract.js', () => ({
  h01RawFile: (path: string) => Buffer.from(path),
}));
vi.mock('../src/adapters/project/taskFiles.js', () => ({
  taskFiles: () => ({ binding: () => ({ root: '/material' }) }),
}));
vi.mock('../src/adapters/project/taskGate.js', () => ({
  taskGateBinding: () => ({ directory: '/gate/execution-attempts/0' }),
}));
vi.mock('./comparisonH06NativeUsage.js', () => ({
  checkH06NativeTemporalAttemptUsage: mock.usage,
  sealH06NativeUsage: (value: string) => value + '-sealed',
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const pinned = (path: string) => ({ path, sha256: '0'.repeat(64) });
const started = pinned('/attempt/temporal-start.json');
const server = pinned('/server/ready.json');
const workerSignal = new AbortController().signal;
const runId = 'selected-run';
type Pin = ReturnType<typeof pinned>;
type Stage = (value: unknown, pin: Pin, signal: AbortSignal, context: unknown) => Promise<unknown>;
type ChatCommand = { commandId: string };
const start = {
  start: { firstExecutionRunId: runId, hostOwner: { id: 'owner' }, profile: {} },
  workflowId: 'workflow',
  artifactRoot: '/attempt/artifacts',
  input: {},
};

function fixture(longStageMs = 0) {
  const events: string[] = [];
  mock.usage.mockReturnValue({
    status: 'WITHIN_BUDGET',
    binding: { participants: ['participant'] },
  });
  mock.evidence.mockReturnValue({ status: 'CHAIN_VERIFIED' });
  mock.replay.mockReturnValue({ status: 'REPLAY_VERIFIED' });
  const source = {
    kind: 'codex-user-command',
    schemaVersion: 1,
    transcript: '/sessions/chat.jsonl',
    threadId: 'chat',
    turnId: 'turn',
    user: { line: 1, sha256: '0'.repeat(64) },
  } as const;
  const chat = {
    source: vi.fn(async (text: string) => {
      events.push(text);
      return source;
    }),
    record: vi.fn(async (text: string) => {
      events.push(text);
    }),
  };
  const signal = new AbortController().signal;
  const query = vi.fn();
  const result = vi.fn(async () => ({ status: 'done' }));
  const getHandle = vi.fn(() => ({ query, result }));
  const context = {
    controlMode: undefined as H06TemporalAutonomousMode | undefined,
    client: {
      connection: { withDeadline: (_deadline: number, fn: () => unknown) => fn() },
      workflow: { getHandle },
    },
    issuer: { owner: 'owner' },
    workDeadlineMs: Date.now() + 60_000,
  };
  mock.attempt.mockReturnValue({
    request: {
      binding: { operationId: 'operation', workspaceRoot: '/material' },
      evidenceRoot: '/attempt',
      stimulus: { longStageMs },
    },
  });
  mock.start.mockReturnValue(start);
  mock.writerReady.mockResolvedValue(true);
  mock.watchReader.mockImplementation(
    (
      _client,
      _started,
      _runId,
      _deadline,
      signal: AbortSignal,
      run: (signal: AbortSignal) => Promise<unknown>,
    ) => run(signal),
  );
  mock.initial.mockImplementation(async (_attempt, _authority, _server, next: Stage) => {
    const value = await next({}, started, workerSignal, context);
    events.push('stop-initial');
    return { initialFailure: pinned('/attempt/f01.json'), writer: value };
  });
  mock.reopen.mockImplementation(async (retained: { opening: { phase: string } }, next: Stage) => {
    const { phase } = retained.opening;
    events.push('open-' + String(phase));
    const value = await next(
      { receipt: pinned('/resume-' + String(phase)) },
      pinned('/host-' + String(phase)),
      workerSignal,
      context,
    );
    events.push('stop-' + String(phase));
    return value;
  });
  mock.planPause.mockImplementation((_client, request: ChatCommand) => ({
    authorizationText: 'human-' + request.commandId,
  }));
  mock.issuePause.mockImplementation((_client, request: ChatCommand) => ({
    notice: 'notice-' + request.commandId,
    command: request.commandId,
  }));
  mock.deliverPause.mockImplementation((_client, _started, _runId, command: string) => {
    events.push('send-' + command);
    return { ack: { commandId: command }, receipt: pinned('/pause-' + command) };
  });
  mock.paused.mockImplementation((_client, _started, _runId, _ack, commandId) => ({
    status: pinned('/status-' + String(commandId)),
    plan: { authorizationText: 'human-' + String(commandId) },
  }));
  mock.issueResume.mockImplementation((request: ChatCommand) => ({
    notice: 'notice-' + request.commandId,
    command: request.commandId,
  }));
  mock.history.mockImplementation((_client, _started, label) =>
    pinned('/history-' + String(label)),
  );
  mock.duration.mockReturnValue('duration-verified');
  return { chat, context, events, getHandle, query, signal };
}

function writingThenHeld(query: ReturnType<typeof vi.fn>) {
  query.mockResolvedValueOnce({ runId, phase: 'writing', waiting: false });
  query.mockResolvedValueOnce({
    runId,
    phase: 'waiting-human',
    waiting: true,
    held: {},
    stopFailure: '',
  });
}

it('sequences both exact command pairs, stops between stages and follows only one Run ID', async () => {
  const { chat, events, getHandle, query, signal } = fixture();
  writingThenHeld(query);
  writingThenHeld(query);
  const first = await runH06NativeTemporalInitialAndWarm(
    { attempt: {}, authority: {}, server },
    chat,
    signal,
  );
  expect(first.cold.opening).toEqual({
    phase: 'cold',
    warm: pinned('/host-warm'),
    readers: [],
    tasks: [start.input],
  });
  expect(first.cold.stops.map(({ path }) => path)).toEqual([
    '/attempt/transport-initial/transport-stop.json',
    '/attempt/transport-warm/transport-stop.json',
  ]);
  expect(first.cold.participants).toEqual(['participant-sealed']);
  expect(mock.readerFailure).not.toHaveBeenCalled();
  expect(mock.duration).toHaveBeenCalledWith(
    expect.objectContaining({
      status: pinned('/status-h06-warm-resume'),
      history: pinned('/history-initial-paused'),
    }),
  );
  await expect(runH06NativeTemporalCold(first, signal)).resolves.toMatchObject({
    history: pinned('/history-complete'),
    result: { status: 'done' },
  });
  expect(getHandle).toHaveBeenCalledTimes(3);
  expect(mock.watchReader).not.toHaveBeenCalled();
  for (const call of getHandle.mock.calls)
    expect(call).toEqual(['workflow', runId, { followRuns: false }]);
  expect(events).toEqual([
    'human-h06-warm-pause',
    'notice-h06-warm-pause',
    'send-h06-warm-pause',
    'stop-initial',
    'human-h06-warm-resume',
    'notice-h06-warm-resume',
    'open-warm',
    'human-h06-cold-pause',
    'notice-h06-cold-pause',
    'send-h06-cold-pause',
    'stop-warm',
    'human-h06-cold-resume',
    'notice-h06-cold-resume',
    'open-cold',
    'stop-cold',
  ]);
});

it('does not dispatch PAUSE when the current human turn has no completed notice', async () => {
  const { chat, query, signal } = fixture();
  writingThenHeld(query);
  chat.record.mockRejectedValueOnce(new Error('notice missing'));
  await expect(
    runH06NativeTemporalInitialAndWarm({ attempt: {}, authority: {}, server }, chat, signal),
  ).rejects.toThrow('notice missing');
  expect(mock.deliverPause).not.toHaveBeenCalled();
  expect(mock.reopen).not.toHaveBeenCalled();
});

it('waits through preflight and the minimum writing window, then awaits a retained STOP', async () => {
  const { chat, query, signal } = fixture(100);
  query.mockResolvedValueOnce({ runId, phase: 'planning', waiting: false });
  query.mockResolvedValueOnce({ runId, phase: 'writing', waiting: false });
  query.mockResolvedValueOnce({ runId, phase: 'writing', waiting: false });
  query.mockResolvedValueOnce({ runId, phase: 'writing', waiting: false, stopFailure: '' });
  query.mockResolvedValueOnce({
    runId,
    phase: 'waiting-human',
    waiting: true,
    held: {},
    stopFailure: '',
  });
  writingThenHeld(query);
  await expect(
    runH06NativeTemporalInitialAndWarm({ attempt: {}, authority: {}, server }, chat, signal),
  ).resolves.toMatchObject({ duration: 'duration-verified' });
  expect(query).toHaveBeenCalledTimes(7);
});

it('waits for the server supervisor STOP before replay', async () => {
  const { events } = fixture();
  const claim = pinned('/attempt/attempt-claim.json');
  const history = pinned('/history-complete');
  const stopped = pinned('/server/stop.json');
  const workers = {
    initialAndWarm: vi.fn(async () => {
      events.push('warm-exited');
      return { claim, started, warm: 'warm', duration: 'duration' };
    }),
    cold: vi.fn(async () => {
      events.push('cold-exited');
      return { history, result: 'result', cold: 'cold' };
    }),
  } as unknown as Parameters<typeof runH06NativeTemporalDriver>[3];
  mock.setup.mockImplementation(
    async (
      _attempt,
      _budget,
      _authority,
      run: (pin: Pin, signal: AbortSignal) => Promise<unknown>,
    ) => {
      const result = await run(server, workerSignal);
      events.push('server-stopped');
      return { ready: server, stopped, result };
    },
  );
  mock.evidence.mockReturnValue('evidence');
  mock.replay.mockImplementation(() => {
    events.push('replay');
    return 'replay';
  });
  await expect(
    runH06NativeTemporalDriver(
      {},
      {},
      {
        async attempt() {
          events.push('attempt-grant');
          return {};
        },
        server: {},
      },
      workers,
    ),
  ).resolves.toMatchObject({
    server: { ready: server, stopped },
    replay: 'replay',
    qualification: false,
    usage: { status: 'WITHIN_BUDGET' },
  });
  expect(events).toEqual([
    'attempt-grant',
    'warm-exited',
    'cold-exited',
    'server-stopped',
    'replay',
  ]);
  expect(mock.replay).toHaveBeenCalledExactlyOnceWith({ claim, started, history });
});

it('runs all four derived controls without requesting or recording human messages', async () => {
  const f = fixture(),
    mode = { kind: 'temporal-autonomous/3', authority: pinned('/parent.json') } as const;
  f.context.controlMode = mode;
  mock.parent.mockReturnValue({});
  mock.openParent.mockReturnValue(mock.attempt());
  writingThenHeld(f.query);
  writingThenHeld(f.query);
  f.chat.source.mockRejectedValue(new Error('must not ask human'));
  f.chat.record.mockRejectedValue(new Error('must not fake human'));
  const result = await runH06NativeTemporalInitialAndWarm(
    { attempt: {}, authority: mode, server },
    f.chat,
    f.signal,
  );
  expect(result.cold.controlMode).toEqual(mode);
  await expect(runH06NativeTemporalCold(result, f.signal)).resolves.toMatchObject({
    result: { status: 'done' },
  });
  expect(mock.readerFailure).toHaveBeenCalledTimes(2);
  expect(mock.watchReader).toHaveBeenCalledWith(
    f.context.client,
    started,
    runId,
    f.context.workDeadlineMs,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(f.chat.source).not.toHaveBeenCalled();
  expect(f.chat.record).not.toHaveBeenCalled();
  expect(mock.issuePause.mock.calls.map((call): unknown => call[3])).toEqual([
    expect.objectContaining({ kind: 'h06-temporal-autonomous-phase/3', mode, phase: 'warm-pause' }),
    expect.objectContaining({ kind: 'h06-temporal-autonomous-phase/3', mode, phase: 'cold-pause' }),
  ]);
  expect(mock.issueResume.mock.calls.map((call): unknown => call[2])).toEqual([
    expect.objectContaining({ phase: 'warm-resume' }),
    expect.objectContaining({ phase: 'cold-resume' }),
  ]);
});

it('propagates an autonomous Reader failure before creating a pause intent or reopening', async () => {
  const f = fixture();
  const mode = { kind: 'temporal-autonomous/3', authority: pinned('/parent.json') } as const;
  f.context.controlMode = mode;
  mock.openParent.mockReturnValue(mock.attempt());
  mock.readerFailure.mockRejectedValue(new Error('reader-load-invalid-fragment'));
  await expect(
    runH06NativeTemporalInitialAndWarm({ attempt: {}, authority: mode, server }, f.chat, f.signal),
  ).rejects.toThrow('reader-load-invalid-fragment');
  expect(mock.planPause).not.toHaveBeenCalled();
  expect(mock.reopen).not.toHaveBeenCalled();
});

it('unwinds the cold operator when the Reader fails while the main result is pending', async () => {
  const f = fixture();
  const mode = { kind: 'temporal-autonomous/3', authority: pinned('/parent.json') } as const;
  f.context.controlMode = mode;
  mock.openParent.mockReturnValue(mock.attempt());
  writingThenHeld(f.query);
  writingThenHeld(f.query);
  const initial = await runH06NativeTemporalInitialAndWarm(
    { attempt: {}, authority: mode, server },
    f.chat,
    f.signal,
  );
  const closed = vi.fn();
  mock.reopen.mockImplementation(async (_retained, next: Stage) => {
    try {
      return await next(
        { receipt: pinned('/cold-resume') },
        pinned('/cold-host'),
        workerSignal,
        f.context,
      );
    } finally {
      closed();
    }
  });
  mock.watchReader.mockRejectedValue(
    new Error('h06-temporal-reader-blocked: reader-load-invalid-fragment'),
  );
  await expect(runH06NativeTemporalCold(initial, f.signal)).rejects.toThrow(
    'reader-load-invalid-fragment',
  );
  expect(closed).toHaveBeenCalledOnce();
  expect(mock.history).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    'complete',
    expect.anything(),
  );
});

it.each([
  'success',
  'claim-path',
  'claim-hash',
  'expired',
  'late-finalization',
  'late-replay',
] as const)('uses the one pre-server parent clock and sealed claim: %s', async (kind) => {
  const f = fixture(),
    parentPin = pinned('/parent.json'),
    claim = pinned('/attempt/attempt-claim.json');
  const parent = {
    receipt: parentPin,
    nativeClaim: claim,
    request: { kind: 'request' },
    server: { expected: { kind: 'expected' } },
    budget: { reserveMs: 1200 },
    workDeadlineMs: Date.now() + 50000,
    stopDeadlineMs: Date.now() + 51200,
  };
  mock.parent.mockReturnValue(parent);
  const workers = {
    initialAndWarm: vi.fn(async () => ({
      claim:
        kind === 'claim-path'
          ? pinned('/other')
          : kind === 'claim-hash'
            ? { ...claim, sha256: '1'.repeat(64) }
            : claim,
      started,
      warm: {},
      duration: {},
    })),
    cold: vi.fn(async () => ({ cold: {}, result: 'done', history: pinned('/history') })),
  } as unknown as Parameters<typeof runH06TemporalAutonomousDriver>[1];
  mock.autonomousServer.mockImplementation(
    async (_options, run: (ready: Pin, signal: AbortSignal) => Promise<unknown>) => {
      try {
        return {
          ready: server,
          stopped: pinned('/stop'),
          result: await run(server, workerSignal),
        };
      } finally {
        if (kind === 'late-finalization')
          vi.spyOn(Date, 'now').mockReturnValue(parent.stopDeadlineMs + 1);
        f.events.push('server-stopped');
      }
    },
  );
  if (kind === 'expired') parent.workDeadlineMs = 1;
  if (kind === 'late-replay')
    mock.replay.mockImplementation(() => {
      vi.spyOn(Date, 'now').mockReturnValue(parent.stopDeadlineMs + 1);
      return { status: 'REPLAY_VERIFIED' };
    });
  if (kind === 'late-finalization' || kind === 'late-replay') {
    const result = await runH06TemporalAutonomousDriver(parentPin, workers);
    expect(result.finalization).toBe('UNKNOWN_PARENT_DEADLINE');
    expect(result.usage.status).toBe('UNKNOWN_PARENT_DEADLINE');
    if (kind === 'late-finalization') expect(result.replay.status).toBe('UNKNOWN_PARENT_DEADLINE');
  } else if (kind === 'success') {
    await expect(runH06TemporalAutonomousDriver(parentPin, workers)).resolves.toMatchObject({
      acceptanceProfile: 'h06-autonomous-recovery/3',
      humanControl: 'NOT_EVALUATED',
      qualification: false,
    });
    expect(mock.autonomousServer.mock.calls[0]![0]).toEqual({
      expected: parent.server.expected,
      deadlineMs: parent.stopDeadlineMs,
      stopReserveMs: 1200,
    });
    expect(workers.initialAndWarm).toHaveBeenCalledWith(
      {
        attempt: parent.request,
        authority: { kind: 'temporal-autonomous/3', authority: parentPin },
        server,
      },
      workerSignal,
    );
  } else
    await expect(runH06TemporalAutonomousDriver(parentPin, workers)).rejects.toThrow(
      kind === 'expired' ? 'h06-temporal-driver-deadline' : 'h06-temporal-driver-autonomous-claim',
    );
  if (kind === 'expired') expect(mock.autonomousServer).not.toHaveBeenCalled();
  else expect(f.events).toContain('server-stopped');
});

it('waits for the second real implementation dispatch before cold PAUSE even with minimum zero', async () => {
  const f = fixture(),
    mode = { kind: 'temporal-autonomous/3', authority: pinned('/parent.json') } as const;
  f.context.controlMode = mode;
  mock.parent.mockReturnValue({});
  mock.openParent.mockReturnValue(mock.attempt());
  writingThenHeld(f.query);
  f.query.mockResolvedValueOnce({ runId, phase: 'writing', waiting: false });
  writingThenHeld(f.query);
  mock.writerReady
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const initial = await runH06NativeTemporalInitialAndWarm(
    { attempt: {}, authority: mode, server },
    f.chat,
    f.signal,
  );
  expect(mock.writerReady).toHaveBeenCalledTimes(3);
  expect(mock.planPause.mock.invocationCallOrder[1]).toBeGreaterThan(
    mock.writerReady.mock.invocationCallOrder[2]!,
  );
  expect(f.chat.source).not.toHaveBeenCalled();
  expect(f.chat.record).not.toHaveBeenCalled();
  expect(mock.reopen.mock.calls[0]![0]).toMatchObject({
    opening: { phase: 'warm' },
    controlMode: mode,
  });
  expect(initial.cold.controlMode).toEqual(mode);
});
it('does not create a phase intent if a previously live implementation becomes unknown', async () => {
  const f = fixture(1000),
    mode = { kind: 'temporal-autonomous/3', authority: pinned('/parent.json') } as const;
  f.context.controlMode = mode;
  mock.parent.mockReturnValue({});
  mock.openParent.mockReturnValue(mock.attempt());
  f.query.mockResolvedValue({ runId, phase: 'writing', waiting: false });
  mock.writerReady.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    runH06NativeTemporalInitialAndWarm({ attempt: {}, authority: mode, server }, f.chat, f.signal),
  ).rejects.toThrow('h06-temporal-driver-writer-ended');
  expect(mock.planPause).not.toHaveBeenCalled();
  expect(mock.issuePause).not.toHaveBeenCalled();
});

it.each(['pass', 'chain', 'replay', 'usage', 'over', 'late', 'abort-stop'] as const)(
  'combines explicit autonomous acceptance without false PASS: %s',
  async (kind) => {
    fixture();
    const abort = new AbortController(),
      parentPin = pinned('/parent'),
      claim = pinned('/attempt/attempt-claim.json');
    const parent = {
      receipt: parentPin,
      nativeClaim: claim,
      request: {},
      server: { expected: {} },
      budget: { reserveMs: 1000 },
      workDeadlineMs: Date.now() + 10000,
      stopDeadlineMs: Date.now() + 11000,
    };
    mock.parent.mockReturnValue(parent);
    const workers = {
      initialAndWarm: vi.fn(async () => ({ claim, started, warm: {}, duration: {} })),
      cold: vi.fn(async () => ({ cold: {}, result: 'done', history: pinned('/history') })),
    } as unknown as Parameters<typeof runH06TemporalAutonomousDriver>[1];
    if (kind === 'chain') mock.evidence.mockReturnValue({ status: 'UNKNOWN' });
    if (kind === 'replay') mock.replay.mockReturnValue({ status: 'UNKNOWN' });
    if (kind === 'usage' || kind === 'over')
      mock.usage.mockReturnValue({
        status: kind === 'over' ? 'OVER_BUDGET' : 'UNKNOWN',
        binding: { participants: [] },
      });
    mock.autonomousServer.mockImplementation(
      async (
        options: { signal: AbortSignal },
        run: (server: Pin, signal: AbortSignal) => Promise<unknown>,
      ) => {
        expect(options.signal).toBe(abort.signal);
        const result = await run(server, abort.signal);
        if (kind === 'late') vi.spyOn(Date, 'now').mockReturnValue(parent.stopDeadlineMs + 1);
        if (kind === 'abort-stop') abort.abort(new Error('abort during stop'));
        return { result, ready: server, stopped: pinned('/stop') };
      },
    );
    if (kind === 'abort-stop') {
      await expect(
        runH06TemporalAutonomousDriver(parentPin, workers, abort.signal),
      ).rejects.toThrow('abort during stop');
      expect(mock.replay).not.toHaveBeenCalled();
    } else {
      const result = await runH06TemporalAutonomousDriver(parentPin, workers, abort.signal);
      expect(result.acceptance).toEqual({
        profile: 'h06-autonomous-recovery/3',
        status: kind === 'pass' ? 'PASS' : kind === 'over' ? 'FAIL' : 'UNKNOWN',
        humanControl: 'NOT_EVALUATED',
        wholeAttemptComplete: false,
        externalUsage: 'UNKNOWN',
        qualification: false,
      });
    }
  },
);
it('forwards a manual cancellation signal and skips finalization when stopping aborts', async () => {
  fixture();
  const abort = new AbortController(),
    claim = pinned('/attempt/attempt-claim.json');
  const workers = {
    initialAndWarm: vi.fn(async () => ({ claim, started, warm: {}, duration: {} })),
    cold: vi.fn(async () => ({ cold: {}, result: 'done', history: pinned('/history') })),
  } as unknown as Parameters<typeof runH06NativeTemporalDriver>[3];
  mock.setup.mockImplementation(
    async (
      _attempt,
      _budget,
      _grant,
      run: (server: Pin, signal: AbortSignal) => Promise<unknown>,
      signal: AbortSignal,
    ) => {
      expect(signal).toBe(abort.signal);
      const result = await run(server, signal);
      abort.abort(new Error('manual stop aborted'));
      return { result, ready: server, stopped: pinned('/stop') };
    },
  );
  await expect(
    runH06NativeTemporalDriver(
      {},
      {},
      { server: {}, attempt: async () => ({}) },
      workers,
      abort.signal,
    ),
  ).rejects.toThrow('manual stop aborted');
  expect(mock.replay).not.toHaveBeenCalled();
});
