import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runTD054DeadlineLoad } from './td054DeadlineNative.mjs';
import type * as ServerVerifier from './comparisonH06NativeTemporalServer.js';

const mock = vi.hoisted(() => ({
  claim: vi.fn(),
  server: vi.fn(),
  transport: vi.fn(),
  host: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  alive: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  authority: vi.fn(),
  bind: vi.fn(),
  request: vi.fn(),
  events: [] as string[],
}));
vi.mock('./td054DeadlineContract.mjs', () => ({
  readTD054Claim: mock.claim,
  observeTD054Processes: mock.alive,
  remainingTD054: (deadline: number) => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('td054-observation-deadline');
    return ms;
  },
}));
vi.mock('./comparisonH06NativeTemporalServer.js', () => ({
  verifyH06NativeTemporalServer: mock.server,
}));
vi.mock('./comparisonH06NativeTransport.js', () => ({ openH06NativeTransport: mock.transport }));
vi.mock('./comparisonH06NativeTurnLedger.js', () => ({
  openH06NativeTurnLedger: () => ({ admitTurn: vi.fn(), recordTurn: vi.fn() }),
}));
vi.mock('../src/worker/readerHost.js', () => ({ createReaderHost: mock.host }));
vi.mock('../src/client/reader.js', () => ({ startControlledReader: mock.start }));
vi.mock('../src/client/taskBackend.js', () => ({ bindTaskBackendClient: mock.bind }));
vi.mock('../src/adapters/codex/readerAuthority.js', () => ({
  nativeReaderAuthority: mock.authority,
}));
vi.mock('@temporalio/worker', () => ({ NativeConnection: { connect: mock.connect } }));
vi.mock('@temporalio/client', () => ({
  Client: class {
    connection = { withDeadline: (_n: number, operation: () => unknown) => operation() };
  },
}));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  mock.events.splice(0);
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode = 'active') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'td054-worker-'));
  roots.push(root);
  const abort = new AbortController(),
    now = Date.now();
  const pin = (path: string) => ({ path, sha256: '0'.repeat(64) });
  const node = pin('/node'),
    input = {
      claim: pin('/claim'),
      node,
      server: pin(join(root, 'server-proof-not-created.json')),
    };
  const packet = {
    evidenceRoot: root,
    operationId: 'td054-worker',
    requestHash: 'a'.repeat(64),
    taskQueue: 'td054-worker',
    binaryPins: { node, appServer: pin('/app') },
    workspaceRoot: root,
    workflows: pin('/workflows'),
    server: {
      binary: pin('/temporal'),
      address: '127.0.0.1:7244',
      httpPort: 7245,
      metricsPort: 7246,
      sqlitePath: join(root, 'temporal.sqlite'),
    },
    proposedBounds: { foregroundWaitMs: 120000 },
    disabledServers: [],
    profile: {},
    chat: { workspace: root, threadId: 'thread' },
    input: { preparation: { project: { checks: ['syntax'] }, owner: 'owner', generation: 1 } },
  };
  const claim = {
    packet,
    workDeadlineMs: mode === 'early-abort' ? now + 60000 : now - 10,
    stopDeadlineMs: now + 30000,
    nativeGrant: { sessionsRoot: root },
  };
  mock.claim.mockResolvedValue(claim);
  mock.server.mockImplementation(async (expected: unknown, server: unknown, deadline: unknown) => {
    expect(expected).toEqual({ ...packet.server, requestHash: packet.requestHash });
    expect(server).toEqual(input.server);
    expect(deadline).toBe(claim.workDeadlineMs);
  });
  mock.connect.mockResolvedValue({ close: mock.close });
  mock.bind.mockImplementation((client: unknown) => client);
  mock.start.mockResolvedValue({
    workflowId: 'workflow',
    firstExecutionRunId: 'run',
    result: () =>
      mode === 'completed' ? Promise.resolve({ status: 'answered' }) : new Promise(() => {}),
    cancel: mock.cancel,
  });
  mock.cancel.mockImplementation(async () => {
    mock.events.push('cancel');
  });
  mock.alive.mockReturnValue([]);
  const turn = {
    role: 'reader',
    root,
    session: 'session',
    turnId: 'turn',
    response: { turn: { id: 'turn' } },
    params: {},
    journal: '/journal',
  };
  mock.request.mockImplementation(async () => {
    if (mode === 'read-fails') throw new Error('primary unavailable');
    return {
      thread: {
        id: mode === 'foreign' ? 'foreign' : 'session',
        turns: [{ id: 'turn', status: mode === 'terminal' ? 'completed' : 'inProgress' }],
      },
    };
  });
  let configuration: { recordTurn(turn: unknown): Promise<void> };
  mock.transport.mockImplementation(async (options: unknown) => {
    configuration = options as typeof configuration;
    return {
      rpc: { request: mock.request },
      async stop() {
        mock.events.push('transport-stop');
        const directory = join(root, 'transport-initial');
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'transport-stop.json'),
          JSON.stringify({
            receipts: [{ processes: [{ pid: 123, parent: 456, started: 'identity' }] }],
          }),
        );
      },
    };
  });
  mock.host.mockResolvedValue({
    async runUntil(run: () => Promise<unknown>) {
      if (mode !== 'missing-start') await configuration.recordTurn(turn);
      const running = run();
      const timer = setTimeout(() => abort.abort(new Error('deadline cancel')), 5);
      try {
        return await running;
      } finally {
        clearTimeout(timer);
        mock.events.push('host-stop');
      }
    },
  });
  return { root, abort, input, claim };
}

it('captures primary ACTIVE at deadline, uses canonical backend-bound start, and awaits owned STOP', async () => {
  const f = fixture();
  await expect(runTD054DeadlineLoad(f.input, f.abort.signal)).rejects.toThrow('deadline cancel');
  expect(mock.bind).toHaveBeenCalledOnce();
  expect(mock.start).toHaveBeenCalledOnce();
  expect(mock.events).toEqual(['cancel', 'host-stop', 'transport-stop']);
  const active = JSON.parse(readFileSync(join(f.root, 'load-at-deadline.json'), 'utf8')) as {
    primary: unknown;
    observedAt: number;
  };
  expect(active.primary).toMatchObject({ thread: { turns: [{ status: 'inProgress' }] } });
  expect(active.observedAt).toBeGreaterThanOrEqual(f.claim.workDeadlineMs);
  expect(existsSync(join(f.root, 'transport-stop-observed.json'))).toBe(true);
  expect(mock.close).toHaveBeenCalledOnce();
  const verifier = await vi.importActual<typeof ServerVerifier>(
    './comparisonH06NativeTemporalServer.js',
  );
  const actualArgs = mock.server.mock.calls[0] as Parameters<
    typeof verifier.verifyH06NativeTemporalServer
  >;
  // The real contract must accept expected before reaching the deliberately absent proof file.
  await expect(verifier.verifyH06NativeTemporalServer(...actualArgs)).rejects.toThrow('ENOENT');
  expect(mock.alive).toHaveBeenCalledWith(expect.any(Array), f.claim.stopDeadlineMs);
});

it.each(['terminal', 'foreign', 'read-fails', 'missing-start', 'early-abort', 'completed'])(
  'keeps native ACTIVE unknown but still closes owned resources (%s)',
  async (mode) => {
    const f = fixture(mode);
    await expect(runTD054DeadlineLoad(f.input, f.abort.signal)).rejects.toThrow();
    expect(existsSync(join(f.root, 'active-confirmed.json'))).toBe(false);
    expect(mock.cancel).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledOnce();
    expect(mock.events).toContain('transport-stop');
  },
);

it('rejects corrupt identity and pre-abort before any native connection', async () => {
  const f = fixture();
  await expect(
    runTD054DeadlineLoad(
      { ...f.input, node: { ...f.input.node, path: '/foreign' } },
      f.abort.signal,
    ),
  ).rejects.toThrow();
  expect(mock.connect).not.toHaveBeenCalled();
  f.abort.abort(new Error('before start'));
  await expect(runTD054DeadlineLoad(f.input, f.abort.signal)).rejects.toThrow('before start');
  expect(mock.connect).not.toHaveBeenCalled();
});

it('refuses a superseded current claim before server verification or native connection', async () => {
  const f = fixture();
  mock.claim.mockRejectedValue(new Error('chat-continuation-human-superseded'));
  await expect(runTD054DeadlineLoad(f.input, f.abort.signal)).rejects.toThrow('human-superseded');
  expect(mock.server).not.toHaveBeenCalled();
  expect(mock.connect).not.toHaveBeenCalled();
  expect(mock.transport).not.toHaveBeenCalled();
});

it('retains transport STOP failure and still closes the SDK connection', async () => {
  const f = fixture();
  mock.alive.mockReturnValue([{ pid: 123 }]);
  await expect(runTD054DeadlineLoad(f.input, f.abort.signal)).rejects.toThrow();
  expect(existsSync(join(f.root, 'transport-stop-observed.json'))).toBe(false);
  expect(mock.close).toHaveBeenCalledOnce();
});
