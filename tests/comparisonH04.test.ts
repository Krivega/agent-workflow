import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type * as ChildProcess from 'node:child_process';
import type * as FileSystem from 'node:fs';
import type * as ProcessModule from 'node:process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  existsSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { digest } from '../adapters/storage/storeCodec.js';
import type * as ProgressModule from '../cli/councilProgress.js';
import type { H04WorkflowInput } from './comparisonH04Workflow.js';
import type { ArtifactRef } from '../src/contracts/preparation.js';
import { object } from '../src/contracts/project.js';
import { controlRef } from '../src/policy/readerControl.js';
import { effectJournal, lookupEffect } from '../src/adapters/artifacts/effects.js';
import { defaultPayloadConverter } from '@temporalio/common';
import { historyFromJSON, historyToJSON, payloadToJSON } from '@temporalio/common/proto-utils';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import {
  checkH04,
  checkH04Operation,
  h04InputHash,
  h04Pin,
  h04Intent,
  readH04Json,
  parseH04Request,
  readH04Pin,
  type H04Request,
  type H04OperationBinding,
  h04BoundIntent,
} from './comparisonH04Contract.js';
import {
  h04Legacy,
  h04Keeper,
  finishH04,
  h04Main,
  h04Operation,
  h04SourcePins,
  h04Temporal,
  h04Worker,
  planH04,
  runH04,
  saveH04,
} from './comparisonH04.js';
import { canonical } from '../adapters/storage/storeCodec.js';
import type { H01AttemptContext, H01BackendResult } from './comparisonH01Contract.js';
import { h01ReadJson } from './comparisonH01Contract.js';
import { createH04NativeLegacyAdapter } from './comparisonH04NativeLegacy.js';
import { createH04NativeTemporalAdapter } from './comparisonH04NativeTemporal.js';
import { verifyH04NativePrimary } from './comparisonH04NativeOperation.js';
import {
  h04Material,
  h04PreparedMetadata,
  h04NativeBinding,
  h04NativeWaitCommand,
  h04NativeLaunchCode,
  h04NativeWaitingCode,
  verifyH04NativeWait,
  type H04NativeOperationRequest,
  type H04NativeCaseReport,
  h04NativeRecord,
} from './comparisonH04NativeContract.js';
import { h04NativeWait } from './comparisonH04NativeWait.mjs';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  own: vi.fn(),
  now: 0,
  delay: vi.fn(),
  wait: vi.fn(),
  create: vi.fn(),
  environment: vi.fn(),
  activity: null as null | ((input: H04WorkflowInput) => Promise<unknown>),
  lastResult: null as unknown,
  result: vi.fn(),
  workflowStart: vi.fn(),
  fetchHistory: vi.fn(),
  teardown: vi.fn(),
  runUntil: vi.fn(),
  workflowActivity: vi.fn(),
  nativeCreate: vi.fn(),
  initialCheck: vi.fn(),
  sessionCreate: vi.fn(),
  sessionSend: vi.fn(),
  fsWatch: vi.fn(),
  originalWatch: null as null | typeof FileSystem.watch,
  fsLink: vi.fn(),
  originalLink: null as null | typeof FileSystem.linkSync,
  processOwner: null as null | NodeJS.Process,
}));
vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessModule & { default: typeof ProcessModule }>();
  const { EventEmitter: Emitter } = await import('node:events');
  const owner = Object.setPrototypeOf(new Emitter(), actual.default) as NodeJS.Process;
  Object.defineProperties(owner, {
    connected: { configurable: true, writable: true, value: true },
    disconnect: {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        Reflect.set(owner, 'connected', false);
      }),
    },
    exitCode: { configurable: true, writable: true, value: undefined },
  });
  mocks.processOwner = owner;
  return { ...actual, default: owner };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  mocks.originalWatch = actual.watch;
  mocks.originalLink = actual.linkSync;
  return { ...actual, watch: mocks.fsWatch, linkSync: mocks.fsLink };
});
vi.mock('./comparisonH02NativeRpc.js', () => ({ createH02NativeRpc: mocks.nativeCreate }));
vi.mock('./comparisonH01.js', () => ({ checkNativeCase: mocks.initialCheck }));
vi.mock('../adapters/codex/appServerSessions.js', () => ({
  AppServerSessions: class {
    create = mocks.sessionCreate;
    send = mocks.sessionSend;
  },
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: mocks.spawn,
}));
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }));
vi.mock('../examples/temporal-consumers/full/safety.mjs', () => ({ ownProcess: mocks.own }));
vi.mock('@temporalio/testing', () => ({
  TestWorkflowEnvironment: { createLocal: mocks.environment },
}));
vi.mock('@temporalio/worker', () => ({ Worker: { create: mocks.create } }));
vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ h04Operation: mocks.workflowActivity }),
}));
vi.mock('../cli/councilProgress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ProgressModule>()),
  waitCouncilProgress: mocks.wait,
}));

let root: string, request: H04Request;
let exitCode: typeof process.exitCode;
let actualNode: H04Request['node'] | undefined;
function useActualNode() {
  const path = realpathSync(process.execPath);
  actualNode ??= { path, sha256: digest(readFileSync(path)) };
  request.node = actualNode;
}
const stop = () => ({ stopped: true, code: 0, signal: null, deadlineReached: false });
const operation = () => ({
  kind: 'h04-operation-result',
  operationId: request.operationId,
  inputHash: h04InputHash(request),
  elapsedMs: 35000,
  logs: Array.from({ length: 6 }, (_, i) => ({ sequence: i + 1, elapsedMs: (i + 1) * 5000 })),
});
const write = (name: string, value: unknown) =>
  writeFileSync(join(request.outputRoot, name), JSON.stringify(value));
async function fixture() {
  mkdirSync(request.outputRoot);
  write('source-pins.json', h04SourcePins());
  const value = operation(),
    result = artifactStore(join(request.outputRoot, 'artifacts')).publish(
      Buffer.from(JSON.stringify(value)),
    );
  write('operation-start.json', {
    operationId: request.operationId,
    inputHash: h04InputHash(request),
  });
  for (const log of value.logs) write(`log-${log.sequence}.json`, log);
  write('applied.json', { operationId: request.operationId, result });
  write('worker.json', {
    status: 'completed',
    inputHash: h04InputHash(request),
    result,
    waitCalls: 1,
    operationStarts: 1,
    appliedEffects: 1,
  });
  write('stop.json', stop());
  write('worker-stop.json', stop());
  write('wait.json', {
    timed_out: false,
    snapshot: {
      status: 'completed',
      run_id: request.operationId,
      target_hash: h04InputHash(request),
    },
  });
  for (const stage of ['run', 'apply'] as const)
    await effectJournal(join(request.outputRoot, 'effects')).execute(
      h04Intent(request, stage),
      async () => result,
    );
  if (request.variant === 'temporal') {
    write('history.json', JSON.parse(historyToJSON(history(result))));
    write('workflow.json', { workflowId: request.operationId, runId: 'h04-run' });
  }
  return result;
}
function history(ref: ArtifactRef, binding?: H04OperationBinding) {
  const payload = (value: unknown) => ({
    payloads: [payloadToJSON(defaultPayloadConverter.toPayload(value)!)],
  });
  const input =
    binding === undefined
      ? { operationId: request.operationId, inputHash: h04InputHash(request) }
      : { operationId: binding.operationId, inputHash: binding.inputHash };
  return historyFromJSON({
    events: [
      {
        eventId: '1',
        eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
        workflowExecutionStartedEventAttributes: {
          workflowType: { name: 'ComparisonH04Workflow' },
          originalExecutionRunId: 'h04-run',
          input: payload(input),
        },
      },
      {
        eventId: '2',
        eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED',
        activityTaskScheduledEventAttributes: {
          activityType: { name: 'h04Operation' },
          input: payload(input),
        },
      },
      {
        eventId: '3',
        eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED',
        activityTaskCompletedEventAttributes: { scheduledEventId: '2', result: payload(ref) },
      },
      {
        eventId: '4',
        eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
        workflowExecutionCompletedEventAttributes: { result: payload(ref) },
      },
    ],
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fsWatch.mockImplementation(mocks.originalWatch!);
  mocks.fsLink.mockImplementation(mocks.originalLink!);
  exitCode = process.exitCode;
  mocks.processOwner!.exitCode = undefined;
  mocks.now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => mocks.now);
  mocks.delay.mockImplementation(async (ms: number) => {
    mocks.now += ms;
  });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-h04-unit-')));
  const binary = join(root, 'node');
  writeFileSync(binary, 'pinned binary');
  request = {
    schemaVersion: 1,
    kind: 'comparison-h04-model-free',
    operationId: 'h04-test',
    variant: 'legacy',
    outputRoot: join(root, 'out'),
    node: { path: binary, sha256: digest('pinned binary') },
    server: null,
  };
  mocks.wait.mockResolvedValue({
    timed_out: false,
    snapshot: {
      status: 'completed',
      run_id: request.operationId,
      target_hash: h04InputHash(request),
    },
  });
  mocks.runUntil.mockImplementation(async (body: () => Promise<unknown>) => await body());
  mocks.create.mockImplementation(
    async (options: {
      activities: { h04Operation: (input: H04WorkflowInput) => Promise<unknown> };
    }) => {
      mocks.activity = options.activities.h04Operation;
      return { runUntil: mocks.runUntil };
    },
  );
  mocks.workflowStart.mockResolvedValue({
    result: mocks.result,
    fetchHistory: mocks.fetchHistory,
    workflowId: request.operationId,
    firstExecutionRunId: 'h04-run',
  });
  mocks.result.mockImplementation(async () => {
    mocks.lastResult = await mocks.activity!({
      operationId: request.operationId,
      inputHash: h04InputHash(request),
    });
    return mocks.lastResult;
  });
  mocks.fetchHistory.mockImplementation(async () => history(controlRef(mocks.lastResult)));
  mocks.environment.mockResolvedValue({
    nativeConnection: {},
    client: { workflow: { start: mocks.workflowStart } },
    teardown: mocks.teardown,
  });
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function ipc() {
  Object.defineProperty(mocks.processOwner!, 'connected', {
    configurable: true,
    writable: true,
    value: true,
  });
  Object.defineProperty(mocks.processOwner!, 'disconnect', {
    configurable: true,
    value: vi.fn(() => Reflect.set(mocks.processOwner!, 'connected', false)),
  });
}
function keeperMock(callback: () => unknown = () => stop()) {
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() },
    cleanup = vi.fn().mockResolvedValue(stop());
  mocks.spawn.mockReturnValue(child);
  mocks.own.mockImplementation(() => ({ done: Promise.resolve().then(callback), stop: cleanup }));
  return { child, cleanup };
}
it('requires a live owner and an unextended absolute keeper deadline', async () => {
  Object.defineProperty(mocks.processOwner!, 'connected', { configurable: true, value: false });
  await expect(h04Keeper(request, String(process.hrtime.bigint()))).rejects.toThrow(
    'h04-owner-ipc-required',
  );
  ipc();
  await expect(h04Keeper(request, '0')).rejects.toThrow('h04-owner-deadline');
  await expect(h04Keeper(request, String(process.hrtime.bigint() + 121000000000n))).rejects.toThrow(
    'h04-owner-deadline',
  );
});
it('keeper forwards bounded output, confirms worker stop and detaches the disconnect hook', async () => {
  ipc();
  const previousDisconnectListeners = mocks.processOwner!.listeners('disconnect');
  mkdirSync(request.outputRoot);
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true),
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const { child } = keeperMock(() => {
    child.stdout.emit('data', Buffer.from('out'));
    child.stderr.emit('data', Buffer.from('err'));
    return stop();
  });
  await h04Keeper(request, String(process.hrtime.bigint() + 110000000000n));
  expect(stdout).toHaveBeenCalledWith(Buffer.from('out'));
  expect(stderr).toHaveBeenCalledWith(Buffer.from('err'));
  expect(readH04Json(join(request.outputRoot, 'worker-stop.json'))).toEqual(stop());
  expect(mocks.processOwner!.listeners('disconnect')).toEqual(previousDisconnectListeners);
});
it.each([{ stopped: false }, { code: 1 }, { signal: 'SIGKILL' }, { deadlineReached: true }])(
  'keeper preserves failed stop %o',
  async (mutation) => {
    ipc();
    mkdirSync(request.outputRoot);
    keeperMock(() => ({ ...stop(), ...mutation }));
    await h04Keeper(request, String(process.hrtime.bigint() + 110000000000n));
    expect(mocks.processOwner!.exitCode).toBe(1);
  },
);
it('parent loss stops the worker and prevents any late application', async () => {
  ipc();
  mkdirSync(request.outputRoot);
  const foreign = vi.fn();
  mocks.processOwner!.on('disconnect', foreign);
  const previousDisconnectListeners = mocks.processOwner!.listeners('disconnect');
  const { cleanup } = keeperMock(() => {
    Reflect.set(mocks.processOwner!, 'connected', false);
    const owned = mocks
      .processOwner!.listeners('disconnect')
      .filter((listener) => !previousDisconnectListeners.includes(listener));
    expect(owned).toHaveLength(1);
    owned[0]!();
    return stop();
  });
  try {
    await h04Keeper(request, String(process.hrtime.bigint() + 110000000000n));
    expect(mocks.processOwner!.listeners('disconnect')).toEqual(previousDisconnectListeners);
    expect(foreign).not.toHaveBeenCalled();
  } finally {
    mocks.processOwner!.removeListener('disconnect', foreign);
  }
  expect(cleanup).toHaveBeenCalledOnce();
  expect(mocks.processOwner!.exitCode).toBe(1);
  expect(() => readH04Json(join(request.outputRoot, 'applied.json'))).toThrow();
});
it('keeper stops a noisy worker and retains an unknown monitor failure', async () => {
  ipc();
  mkdirSync(request.outputRoot);
  const { child, cleanup } = keeperMock(() => {
    child.stdout.emit('data', Buffer.alloc(1048577));
    return stop();
  });
  await h04Keeper(request, String(process.hrtime.bigint() + 110000000000n));
  expect(cleanup).toHaveBeenCalledOnce();
  expect(mocks.processOwner!.exitCode).toBe(1);
  rmSync(join(request.outputRoot, 'worker-stop.json'));
  ipc();
  mocks.own.mockImplementation(() => ({
    done: Promise.reject(new Error('lost monitor')),
    stop: cleanup,
  }));
  await expect(h04Keeper(request, String(process.hrtime.bigint() + 110000000000n))).rejects.toThrow(
    'lost monitor',
  );
  expect(cleanup).toHaveBeenCalledTimes(2);
});
it('main internal keeper entry remains owner-bound', async () => {
  ipc();
  mkdirSync(request.outputRoot);
  keeperMock();
  const config = join(root, 'keeper.json');
  saveH04(config, request);
  expect(
    await h04Main(['--worker', config, String(process.hrtime.bigint() + 110000000000n)]),
  ).toBeNull();
});

it('plans read-only with source pins and never qualifies claims of a native turn', () => {
  expect(planH04(request)).toMatchObject({ mayRun: false, qualification: false, logs: 6 });
  expect(parseH04Request(request)).toEqual(request);
  expect(h04Pin(request.node)).toEqual(request.node);
  expect(readH04Pin(request.node).toString()).toBe('pinned binary');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it.each([
  { schemaVersion: 2 },
  { kind: 'h01' },
  { operationId: '' },
  { operationId: 1 },
  { variant: 'other' },
  { outputRoot: 'relative' },
  { outputRoot: 1 },
  { outputRoot: '/x/../y' },
  { server: { path: '/server', sha256: '0'.repeat(64) } },
])('refuses incompatible request %o', (mutation) => {
  expect(() => parseH04Request({ ...request, ...mutation })).toThrow();
});
it('requires exact fields and a server for Temporal', () => {
  expect(() => parseH04Request({ ...request, nativeProof: true })).toThrow();
  expect(() => parseH04Request({ ...request, variant: 'temporal' })).toThrow('h04-server');
  expect(() => h04Pin({ path: 1, sha256: '' })).toThrow();
  expect(() => h04Pin({ path: 'relative', sha256: '' })).toThrow();
  expect(() => h04Pin({ path: '/x/../y', sha256: '' })).toThrow();
  expect(() => h04Pin({ path: '/x', sha256: 1 })).toThrow();
  expect(() => h04Pin({ path: '/x', sha256: 'bad' })).toThrow();
});
it('refuses changed bytes, aliases, directories and hardlinks', () => {
  expect(() => readH04Pin({ ...request.node, sha256: '0'.repeat(64) })).toThrow('h04-pin-changed');
  const alias = join(root, 'alias');
  symlinkSync(request.node.path, alias);
  expect(() => readH04Pin({ ...request.node, path: alias })).toThrow();
  expect(() => readH04Pin({ ...request.node, path: root })).toThrow();
  linkSync(request.node.path, join(root, 'hardlink'));
  expect(() => readH04Pin(request.node)).toThrow();
});
it('refuses an output parent alias and validates the Temporal binary without starting it', () => {
  request.variant = 'temporal';
  request.server = request.node;
  expect(planH04(request).request.server).toEqual(request.node);
  const alias = join(root, 'alias');
  symlinkSync(root, alias);
  request.outputRoot = join(alias, 'out');
  expect(() => planH04(request)).toThrow('h04-parent-alias');
});
it('executes the operation once with a fake monotonic clock and reuses the real journal receipt', async () => {
  mkdirSync(request.outputRoot);
  const ref = await h04Operation(request);
  const value: unknown = JSON.parse(
    artifactStore(join(request.outputRoot, 'artifacts')).read(ref).toString(),
  );
  expect(checkH04Operation(request, value).elapsedMs).toBe(35000);
  expect(mocks.delay).toHaveBeenCalledTimes(7);
  expect(await h04Operation(request)).toEqual(ref);
  expect(mocks.delay).toHaveBeenCalledTimes(7);
});
it('retains an unknown intent and refuses to run it again after a lost effect', async () => {
  mkdirSync(request.outputRoot);
  mocks.delay.mockRejectedValueOnce(new Error('lost'));
  await expect(h04Operation(request)).rejects.toThrow('lost');
  await expect(h04Operation(request)).rejects.toThrow('effect-outcome-unknown');
  expect(mocks.delay).toHaveBeenCalledOnce();
});
it('uses one legacy settled waiter, ignoring intermediate logs as model events', async () => {
  mkdirSync(request.outputRoot);
  await h04Legacy(request);
  expect(mocks.wait).toHaveBeenCalledOnce();
  expect(mocks.wait).toHaveBeenCalledWith(request.outputRoot, expect.any(String), 60000, {
    until: 'settled',
  });
});
it.each([
  { timed_out: true, snapshot: { status: 'completed' } },
  { timed_out: false, snapshot: { status: 'running' } },
])('refuses a nonterminal legacy wait %o', async (waited) => {
  mkdirSync(request.outputRoot);
  mocks.wait.mockResolvedValue(waited);
  await expect(h04Legacy(request)).rejects.toThrow('h04-wait-unconfirmed');
});
it('preserves operation failure while the legacy wait is pending', async () => {
  mkdirSync(request.outputRoot);
  mocks.delay.mockRejectedValueOnce(new Error('cancelled'));
  await expect(h04Legacy(request)).rejects.toThrow('cancelled');
});
it('awaits one real SDK API result in the protocol mock and tears it down', async () => {
  request.variant = 'temporal';
  request.server = request.node;
  mkdirSync(request.outputRoot);
  await h04Temporal(request);
  expect(mocks.environment).toHaveBeenCalledWith(
    expect.objectContaining({
      server: expect.objectContaining({
        executable: { type: 'existing-path', path: request.node.path },
      }) as unknown,
    }),
  );
  expect(mocks.result).toHaveBeenCalledOnce();
  expect(mocks.teardown).toHaveBeenCalledOnce();
  expect(mocks.workflowStart).toHaveBeenCalledWith(
    'ComparisonH04Workflow',
    expect.objectContaining({ workflowIdReusePolicy: 'REJECT_DUPLICATE' }),
  );
});
it('does not hide a Temporal failure and never downloads a missing binary', async () => {
  await expect(h04Temporal(request)).rejects.toThrow('h04-server');
  request.server = request.node;
  mocks.create.mockRejectedValue(new Error('SDK refused'));
  await expect(h04Temporal(request)).rejects.toThrow('SDK refused');
  expect(mocks.teardown).toHaveBeenCalledOnce();
});
it('the test-owned Workflow invokes exactly one Activity', async () => {
  const { ComparisonH04Workflow } = await import('./comparisonH04Workflow.js');
  mocks.workflowActivity.mockResolvedValue({ sha256: 'x', bytes: 1 });
  expect(
    await ComparisonH04Workflow({
      operationId: request.operationId,
      inputHash: h04InputHash(request),
    }),
  ).toEqual({ sha256: 'x', bytes: 1 });
  expect(mocks.workflowActivity).toHaveBeenCalledOnce();
});
it.each(['legacy', 'temporal'] as const)(
  'publishes completed worker evidence for %s without native claims',
  async (variant) => {
    request.variant = variant;
    if (variant === 'temporal') request.server = request.node;
    mkdirSync(request.outputRoot);
    await h04Worker(request);
    write('source-pins.json', h04SourcePins());
    write('stop.json', stop());
    write('worker-stop.json', stop());
    await finishH04(request);
    expect(checkH04(request)).toMatchObject({
      modelFree: 'PASS',
      outcome: 'UNKNOWN',
      qualification: false,
    });
  },
);
it.each([new Error('cancelled'), 'not-an-error'])(
  'exports worker failure %s without a fake effect',
  async (failure) => {
    mkdirSync(request.outputRoot);
    mocks.delay.mockRejectedValueOnce(failure);
    await h04Worker(request);
    expect(JSON.parse(readFileSync(join(request.outputRoot, 'worker.json'), 'utf8'))).toMatchObject(
      { status: 'unknown' },
    );
    expect(mocks.processOwner!.exitCode).toBe(1);
  },
);
it('refuses altered result bytes and primary metadata', async () => {
  const ref = await fixture();
  writeFileSync(join(request.outputRoot, 'artifacts', ref.sha256), 'tampered');
  expect(() => checkH04(request)).toThrow('h04-pin-changed');
});
it.each([
  ['worker.json', { inputHash: 'other' }, 'h04-report-binding'],
  ['source-pins.json', [], 'h04-source-pins'],
  ['source-pins.json', {}, 'h04-source-pins'],
  ['operation-start.json', {}, 'h04-start-binding'],
  ['log-3.json', {}, 'h04-log-binding'],
  ['applied.json', {}, 'h04-effect-binding'],
])('refuses tampered %s', async (path, value, error) => {
  await fixture();
  write(path, value);
  expect(() => checkH04(request)).toThrow(error as string);
});
it.each(['waitCalls', 'operationStarts'])('refuses a second %s', async (field) => {
  await fixture();
  const report = object(readH04Json(join(request.outputRoot, 'worker.json')));
  report[field] = 2;
  write('worker.json', report);
  expect(() => checkH04(request)).toThrow('h04-effect-count');
});
it('refuses size mismatch', async () => {
  await fixture();
  const report = object(readH04Json(join(request.outputRoot, 'worker.json')));
  report.result = { ...controlRef(report.result), bytes: controlRef(report.result).bytes + 1 };
  write('worker.json', report);
  expect(() => checkH04(request)).toThrow('h04-result-size');
});
it.each([
  { stopped: false },
  { code: 1 },
  { signal: 'SIGKILL' },
  { deadlineReached: true },
  { killed: true },
])('retains unknown stop %o', async (mutation) => {
  await fixture();
  write('stop.json', { ...stop(), ...mutation });
  expect(checkH04(request)).toMatchObject({ modelFree: 'UNKNOWN', qualification: false });
});
it('retains missing/failed worker as UNKNOWN and does not accept native booleans', async () => {
  await fixture();
  rmSync(join(request.outputRoot, 'worker.json'));
  expect(checkH04(request).modelFree).toBe('UNKNOWN');
  write('worker.json', {
    inputHash: h04InputHash(request),
    status: 'unknown',
    native: { sameTurn: true },
  });
  expect(checkH04(request).qualification).toBe(false);
});
it('retains absent keeper stop and missing worker without applying anything', async () => {
  await fixture();
  rmSync(join(request.outputRoot, 'worker-stop.json'));
  rmSync(join(request.outputRoot, 'worker.json'));
  expect(checkH04(request).modelFree).toBe('UNKNOWN');
  expect(await finishH04(request)).toMatchObject({ modelFree: 'UNKNOWN' });
});
it('does not upgrade an otherwise passing bundle with invented native booleans', async () => {
  await fixture();
  const report = object(readH04Json(join(request.outputRoot, 'worker.json')));
  write('worker.json', { ...report, native: { sameTurn: true, noModelPoll: true, oneWait: true } });
  expect(checkH04(request)).toMatchObject({
    modelFree: 'PASS',
    qualification: false,
    outcome: 'UNKNOWN',
  });
});
it('verifies primary bytes before any owner application', async () => {
  mkdirSync(request.outputRoot);
  await h04Worker(request);
  write('source-pins.json', h04SourcePins());
  write('stop.json', stop());
  write('worker-stop.json', stop());
  const ref = controlRef(object(readH04Json(join(request.outputRoot, 'worker.json'))).result);
  writeFileSync(join(request.outputRoot, 'artifacts', ref.sha256), 'corrupt');
  await expect(finishH04(request)).rejects.toThrow('h04-pin-changed');
  expect(() => readH04Json(join(request.outputRoot, 'applied.json'))).toThrow();
});
it('does not repeat application after a lost commit receipt', async () => {
  mkdirSync(request.outputRoot);
  await h04Worker(request);
  write('source-pins.json', h04SourcePins());
  write('stop.json', stop());
  write('worker-stop.json', stop());
  const result = controlRef(object(readH04Json(join(request.outputRoot, 'worker.json'))).result);
  write('applied.json', { operationId: request.operationId, result });
  await expect(finishH04(request)).rejects.toThrow();
  await expect(finishH04(request)).rejects.toThrow('effect-outcome-unknown');
  expect(readH04Json(join(request.outputRoot, 'applied.json'))).toEqual({
    operationId: request.operationId,
    result,
  });
});
it('refuses changed source list and legacy terminal binding', async () => {
  await fixture();
  const pins = h04SourcePins();
  pins.reverse();
  write('source-pins.json', pins);
  expect(() => checkH04(request)).toThrow('h04-source-paths');
  write('source-pins.json', h04SourcePins());
  write('wait.json', {
    timed_out: false,
    snapshot: { status: 'completed', run_id: 'foreign', target_hash: h04InputHash(request) },
  });
  expect(() => checkH04(request)).toThrow('h04-wait-binding');
});
it.each(['run', 'apply'] as const)(
  'refuses missing or conflicting durable %s receipt',
  async (stage) => {
    await fixture();
    const intent = h04Intent(request, stage),
      key = digest(JSON.stringify([intent.projectId, intent.taskId, intent.operationId]));
    rmSync(join(request.outputRoot, 'effects', key + '.receipt'));
    expect(() => checkH04(request)).toThrow('h04-effect-unconfirmed');
    writeFileSync(
      join(request.outputRoot, 'effects', key + '.receipt'),
      JSON.stringify({ sha256: 'a'.repeat(64), bytes: 1 }),
    );
    expect(() => checkH04(request)).toThrow('h04-effect-result');
  },
);
it('refuses an unaccounted effect file', async () => {
  await fixture();
  writeFileSync(join(request.outputRoot, 'effects', 'foreign'), 'extra');
  expect(() => checkH04(request)).toThrow('h04-extra-effect');
});
it.each([
  'workflow',
  'input',
  'activity',
  'activityInput',
  'activityResult',
  'workflowResult',
] as const)('refuses cross-bound SDK %s evidence', async (kind) => {
  request.variant = 'temporal';
  request.server = request.node;
  const ref = await fixture();
  const value = JSON.parse(historyToJSON(history(ref))) as { events: Record<string, unknown>[] };
  if (kind === 'workflow') write('workflow.json', { workflowId: 'foreign', runId: 'h04-run' });
  else {
    const mapping = {
      input: [0, 'workflowExecutionStartedEventAttributes', 'input'],
      activity: [1, 'activityTaskScheduledEventAttributes', 'activityType'],
      activityInput: [1, 'activityTaskScheduledEventAttributes', 'input'],
      activityResult: [2, 'activityTaskCompletedEventAttributes', 'result'],
      workflowResult: [3, 'workflowExecutionCompletedEventAttributes', 'result'],
    } as const;
    const [index, field, key] = mapping[kind];
    const row = object(value.events[index]![field]);
    row[key] =
      key === 'activityType'
        ? { name: 'foreign' }
        : { payloads: [payloadToJSON(defaultPayloadConverter.toPayload('foreign')!)] };
    write('history.json', value);
  }
  expect(() => checkH04(request)).toThrow();
});
it('rejects a foreign activity input before starting the operation', async () => {
  request.server = request.node;
  mkdirSync(request.outputRoot);
  mocks.result.mockImplementation(
    async () => await mocks.activity!({ operationId: 'foreign', inputHash: h04InputHash(request) }),
  );
  await expect(h04Temporal(request)).rejects.toThrow('h04-activity-input');
  expect(mocks.delay).not.toHaveBeenCalled();
});
it.each([
  { kind: 'other' },
  { operationId: 'foreign' },
  { inputHash: 'foreign' },
  { elapsedMs: 34999 },
  { elapsedMs: '35000' },
  { elapsedMs: Infinity },
  { logs: [] },
  { logs: {} },
])('refuses invalid operation %o', (mutation) => {
  expect(() => checkH04Operation(request, { ...operation(), ...mutation })).toThrow();
});
it.each([{ sequence: 2 }, { elapsedMs: '5000' }, { elapsedMs: 4999 }, { elapsedMs: 35000 }])(
  'refuses malformed intermediate log %o',
  (mutation) => {
    const value = operation();
    Object.assign(value.logs[0]!, mutation);
    expect(() => checkH04Operation(request, value)).toThrow('h04-log-order');
  },
);
it('refuses duplicate monotonic boundaries', () => {
  const value = operation();
  value.logs[0]!.elapsedMs = 10000;
  value.logs[1]!.elapsedMs = 10000;
  expect(() => checkH04Operation(request, value)).toThrow('h04-log-order');
});
it.each([
  {},
  {
    events: [
      { eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED' },
      { eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED' },
    ],
  },
  {
    events: [
      { eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED' },
      { eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED' },
      { eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED' },
      { eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' },
    ],
  },
  {
    events: [
      { eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED' },
      { eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED' },
      { eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED' },
      { eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' },
    ],
  },
])('refuses incomplete or duplicated SDK history %o', async (history) => {
  request.variant = 'temporal';
  request.server = request.node;
  await fixture();
  write('history.json', history);
  expect(() => checkH04(request)).toThrow();
});
it('runs one bounded owned child and exports primary output before checking it', async () => {
  useActualNode();
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  mocks.spawn.mockImplementation(() => {
    fixtureAfterRunStart();
    return child;
  });
  function fixtureAfterRunStart() {
    write('worker.json', { status: 'unknown', inputHash: h04InputHash(request) });
    write('worker-stop.json', stop());
  }
  mocks.own.mockImplementation(() => ({
    done: Promise.resolve().then(() => {
      child.stdout.emit('data', Buffer.from('stdout'));
      child.stderr.emit('data', Buffer.from('stderr'));
      return stop();
    }),
    stop: vi.fn(),
  }));
  expect(await runH04(request)).toMatchObject({ qualification: false, modelFree: 'UNKNOWN' });
  expect(readFileSync(join(request.outputRoot, 'stdout.log'), 'utf8')).toBe('stdout');
  expect(mocks.own).toHaveBeenCalledWith(child, {
    deadline: expect.any(Number) as unknown,
    stopMs: 30000,
  });
  expect(object(mocks.spawn.mock.calls[0]![2] as unknown).env).toMatchObject({
    TSX_DISABLE_CACHE: '1',
    NODE_DISABLE_COMPILE_CACHE: '1',
    TMPDIR: request.outputRoot,
  });
  await expect(runH04(request)).rejects.toThrow('h04-output-exists');
});
it('always invokes stop after a failed monitor, retaining the original error', async () => {
  useActualNode();
  mocks.spawn.mockReturnValue({ stdout: new EventEmitter(), stderr: new EventEmitter() });
  const cleanup = vi.fn().mockResolvedValue(stop());
  mocks.own.mockReturnValue({ done: Promise.reject(new Error('monitor failed')), stop: cleanup });
  await expect(runH04(request)).rejects.toThrow('monitor failed');
  expect(cleanup).toHaveBeenCalledOnce();
});
it.each(['stdout', 'stderr'] as const)(
  'stops and records refusal when child %s is missing',
  async (stream) => {
    useActualNode();
    const child: { stdout: EventEmitter | null; stderr: EventEmitter | null } = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    };
    child[stream] = null;
    const cleanup = vi.fn().mockResolvedValue(stop());
    mocks.spawn.mockReturnValue(child);
    mocks.own.mockReturnValue({ done: new Promise(() => {}), stop: cleanup });
    await expect(runH04(request)).rejects.toThrow('h04-child-streams-missing');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(readH04Json(join(request.outputRoot, 'stop.json'))).toEqual(stop());
    expect(() => readH04Json(join(request.outputRoot, 'applied.json'))).toThrow();
  },
);
it('main plan/check/worker/run paths are explicit and import starts nothing', async () => {
  const config = join(root, 'config.json');
  saveH04(config, request);
  expect(await h04Main(['--plan', config])).toMatchObject({ mayRun: false });
  await expect(h04Main([])).rejects.toThrow('h04-arguments');
  await expect(h04Main(['--unsupported', config])).rejects.toThrow('h04-arguments');
  await fixture();
  expect(await h04Main(['--check', config])).toMatchObject({ outcome: 'UNKNOWN' });
  await expect(h04Main(['--run', config])).rejects.toThrow('h04-actual-node-required');
  rmSync(request.outputRoot, { recursive: true });
  mkdirSync(request.outputRoot);
  expect(await h04Main(['--operation', config])).toBeNull();
});
it.each([false, true])('entrypoint exports output or error: %s', async (failed) => {
  const original = process.argv;
  const file = fileURLToPath(new URL('./comparisonH04.ts', import.meta.url)),
    config = join(root, 'entry.json');
  saveH04(config, request);
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true),
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  process.argv = [process.execPath, file, failed ? '--bad' : '--plan', config];
  vi.resetModules();
  try {
    await import('./comparisonH04.js');
    await vi.waitFor(() => expect(failed ? stderr : stdout).toHaveBeenCalled());
  } finally {
    process.argv = original;
  }
});

function nativeFixture(engine: 'legacy' | 'temporal' = 'legacy') {
  const directory = join(root, 'native');
  mkdirSync(directory);
  const pin = (path: string, value: unknown) => {
    const text = typeof value === 'string' ? value : canonical(value) + '\n';
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, { mode: 0o600 });
    return { locator: path, hash: digest(text) };
  };
  const roots = Object.fromEntries(
    ['workspaceRoot', 'evidenceRoot', 'artifactRoot', 'stateRoot', 'hostRoot'].map((name) => {
      const path = join(directory, name);
      mkdirSync(path);
      return [name, path];
    }),
  ) as unknown as H01AttemptContext['roots'];
  const rules = pin(join(directory, 'rules.md'), 'fixed rules'),
    executor = pin(join(directory, 'executor.md'), 'fixed executor');
  const files = { ...h04Material.files, ...h04PreparedMetadata('fixed rules', 'fixed executor') };
  for (const [path, text] of Object.entries(files)) pin(join(roots.workspaceRoot, path), text);
  const runtimeRoot = join(directory, 'runtime'),
    waiterPath = join(runtimeRoot, 'tests/comparisonH04NativeWait.mjs');
  const waiter = pin(
    waiterPath,
    readFileSync(fileURLToPath(new URL('./comparisonH04NativeWait.mjs', import.meta.url)), 'utf8'),
  );
  const material = pin(join(directory, 'material.json'), h04Material);
  const checker = pin(join(directory, 'check.json'), {
    kind: 'comparison-h04-check',
    opId: 'h04-native-unit',
    requestHash: 'a'.repeat(64),
    material,
    cwd: roots.workspaceRoot,
    passed: false,
    stdout: pin(join(directory, 'check.stdout'), ''),
    stderr: pin(join(directory, 'check.stderr'), 'F-01'),
    stop: { stopped: true, code: 1, signal: null, killed: false, deadlineReached: false },
  });
  const primaryStop = pin(join(directory, 'stop.json'), {
    kind: 'comparison-h04-stop',
    executionVersion: 2,
    opId: 'h04-native-unit',
    confirmed: true,
    readersStopped: true,
    transportClosed: true,
    sessions: ['session'],
    remainingProcesses: [],
    evidence: [],
  });
  const transcript = join(directory, 'native.jsonl');
  const controller = new AbortController();
  const verify = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const ctx = {
    opId: 'h04-native-unit',
    requestHash: 'a'.repeat(64),
    variant: engine === 'legacy' ? 'baseline' : 'candidate',
    material: { ref: material, value: h04Material },
    criteria: { ref: material, value: { id: 'H-04' } },
    roots,
    identity: { taskId: 'task', owner: 'owner', generation: 1 },
    profile: { model: 'fixed-model', effort: 'low' },
    rules,
    executor,
    runtime: { engine, root: runtimeRoot, files: [waiter] },
    verifiedAuthorization: rules,
    workDeadlineNs: String(process.hrtime.bigint() + 120000000000n),
    deadlineNs: String(process.hrtime.bigint() + 150000000000n),
    signal: controller.signal,
    nativeObserver: {
      verify,
      accounting: vi.fn(() => ({
        participants: [
          { session: 'session', transcript, run: 'h04-native-unit', stage: 'execution' },
        ],
      })),
    },
  } as unknown as H01AttemptContext;
  const services = {
    client: { workflow: { start: mocks.workflowStart } },
    nativeConnection: {},
  } as unknown as Parameters<typeof createH04NativeTemporalAdapter>[0];
  let observed: (message: Record<string, unknown>) => void;
  let instruction = '';
  let gateAt: number | null = null;
  const gate = () => {
    const requestPath = join(roots.workspaceRoot, 'evidence/h04-operation-request.json'),
      r = JSON.parse(readFileSync(requestPath, 'utf8')) as H04NativeOperationRequest;
    gateAt = Date.now() - 1;
    observed({
      method: 'item/started',
      params: {
        threadId: 'session',
        turnId: 'turn',
        item: {
          type: 'commandExecution',
          id: 'command',
          command: h04NativeWaitCommand(r, {
            locator: requestPath,
            hash: digest(readFileSync(requestPath)),
          }),
        },
      },
    });
  };
  const complete = vi.fn(async () => {
    const requestPath = join(roots.workspaceRoot, 'evidence/h04-operation-request.json'),
      r = JSON.parse(readFileSync(requestPath, 'utf8')) as H04NativeOperationRequest;
    const requestRef = { locator: requestPath, hash: digest(readFileSync(requestPath)) },
      binding = h04NativeBinding(r),
      command = h04NativeWaitCommand(r, requestRef);
    mocks.wait.mockResolvedValue({
      timed_out: false,
      snapshot: {
        status: 'completed',
        run_id: binding.operationId,
        target_hash: binding.inputHash,
      },
    });
    mocks.workflowStart.mockResolvedValue({
      result: mocks.result,
      fetchHistory: mocks.fetchHistory,
      workflowId: binding.operationId,
      firstExecutionRunId: 'h04-run',
    });
    mocks.result.mockImplementation(async () => {
      mocks.lastResult = await mocks.activity!({
        operationId: binding.operationId,
        inputHash: binding.inputHash,
      });
      return mocks.lastResult;
    });
    mocks.fetchHistory.mockImplementation(async () =>
      history(controlRef(mocks.lastResult), binding),
    );
    if (gateAt === null) gate();
    const beganAt = gateAt!;
    await vi.waitFor(() => expect(existsSync(join(r.outputRoot, 'terminal.json'))).toBe(true), {
      interval: 1,
    });
    const terminal = readFileSync(join(r.outputRoot, 'terminal.json'), 'utf8');
    const item = {
      type: 'CommandExecution',
      id: 'command',
      process_id: '123',
      command: ['/bin/zsh', '-lc', command],
      cwd: r.workspace,
      status: 'completed',
      exit_code: 0,
    };
    const records = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'launch',
          input: h04NativeLaunchCode(r, requestRef),
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'item_started', thread_id: 'session', turn_id: 'turn', item },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'launch',
          output: [{ text: JSON.stringify({ session_id: 123, output: '' }) }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'wait',
          input: h04NativeWaitingCode(123),
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'session',
          turn_id: 'turn',
          item,
          started_at_ms: beganAt,
          completed_at_ms: beganAt + 35001,
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'wait',
          output: [{ text: JSON.stringify({ exit_code: 0, output: terminal }) }],
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    ];
    writeFileSync(transcript, records.map((r) => JSON.stringify(r) + '\n').join(''));
  });
  const nativeStop = vi
    .fn<() => Promise<H01BackendResult['stop']>>()
    .mockResolvedValue(primaryStop);
  mocks.nativeCreate.mockImplementation(
    (_ctx: unknown, _label: unknown, options: { observe: typeof observed }) => {
      observed = options.observe;
      return { rpc: { completed: complete }, stop: nativeStop, evidence: [] };
    },
  );
  mocks.initialCheck.mockResolvedValue({ failed: true, evidence: checker });
  mocks.sessionCreate.mockResolvedValue({ id: 'session' });
  mocks.sessionSend.mockImplementation((_session: unknown, text: string) => {
    instruction = text;
    return 'turn';
  });
  return {
    ctx,
    services,
    pin,
    directory,
    complete,
    nativeStop,
    controller,
    verify,
    transcript,
    checker,
    gate,
    notify: (message: Record<string, unknown>) => observed(message),
    instruction: () => instruction,
    run: () =>
      engine === 'legacy'
        ? createH04NativeLegacyAdapter().execute(ctx)
        : createH04NativeTemporalAdapter(services).execute(ctx),
    report(result: H01BackendResult) {
      return h01ReadJson(
        (h01ReadJson(result.projection) as { caseReport: { locator: string; hash: string } })
          .caseReport,
      ) as H04NativeCaseReport;
    },
  };
}
it.each(['legacy', 'temporal'] as const)(
  'runs H04 %s with a read-only native waiter and host-owned primary effects (unit double)',
  async (engine) => {
    const f = nativeFixture(engine),
      result = await f.run(),
      report = f.report(result);
    expect(result.outcome, JSON.stringify(report.blocking)).toBe('completed');
    expect(report).toMatchObject({
      outcome: 'accepted',
      nativeAcceptance: false,
      qualification: false,
      partialScope: true,
    });
    expect(report.nativeWait).toMatchObject({ sessionId: 123, turn: 'turn' });
    expect(f.instruction()).toContain('No other tools');
    expect(mocks.nativeCreate.mock.calls[0]![2]).toMatchObject({ stage: 'execution' });
    expect(verifyH04NativePrimary(report.request!, report).operation.logs).toHaveLength(6);
    expect(await h04NativeWait(['--wait', report.request!.locator, report.request!.hash])).toBe(
      readFileSync(report.primary.terminal!.locator, 'utf8'),
    );
    expect(
      JSON.parse(readFileSync(join(f.ctx.roots.workspaceRoot, 'evidence/manifest.json'), 'utf8')),
    ).toMatchObject({ initial_failure: 'F-01' });
    expect(f.nativeStop).toHaveBeenCalledOnce();
  },
);

it('requires one completed wait in the same native turn, exact invocation parameters and original primary outputs', async () => {
  const f = nativeFixture(),
    report = f.report(await f.run());
  const original = JSON.parse(
    '[' + readFileSync(f.transcript, 'utf8').trim().split('\n').join(',') + ']',
  ) as { type: string; payload: Record<string, unknown> }[];
  const participant = f.ctx.nativeObserver.accounting().participants[0]!;
  const run = () => verifyH04NativeWait(report.request!, participant, report.primary.terminal!);
  type Records = typeof original;
  const payload = (rows: Records, index: number) => rows[index]!.payload;
  const value = (rows: Records, index: number) =>
    JSON.parse((payload(rows, index).output as { text: string }[])[0]!.text) as Record<
      string,
      unknown
    >;
  const update = (rows: Records, index: number, v: Record<string, unknown>) => {
    payload(rows, index).output = [{ text: JSON.stringify(v) }];
  };
  const changes: ((rows: Records) => void)[] = [
    (r) => {
      r.shift();
    },
    (r) => {
      r.pop();
    },
    (r) => {
      r.push(structuredClone(r[0]!));
    },
    (r) => {
      payload(r, 7).turn_id = 'other';
    },
    (r) => {
      [r[0], r[7]] = [r[7]!, r[0]!];
    },
    (r) => {
      r.splice(4, 1);
    },
    (r) => {
      payload(r, 1).type = 'function_call';
    },
    (r) => {
      payload(r, 1).name = 'wait';
    },
    (r) => {
      payload(r, 1).input = 5;
    },
    (r) => {
      payload(r, 1).input = 'unknown()';
    },
    (r) => {
      payload(r, 1).input =
        'text(await tools.exec_command({cmd:"x"}));text(await tools.exec_command({cmd:"x"}));';
    },
    (r) => {
      payload(r, 3).call_id = 'other';
    },
    (r) => {
      [r[1], r[3]] = [r[3]!, r[1]!];
    },
    (r) => {
      payload(r, 3).output = 'bad';
    },
    (r) => {
      payload(r, 3).output = [];
    },
    (r) => {
      payload(r, 3).output = [{ text: 5 }];
    },
    (r) => {
      payload(r, 3).output = [{ text: '{}', type: 'image' }];
    },
    (r) => {
      payload(r, 3).output = [{ text: '{}', extra: true }];
    },
    (r) => {
      payload(r, 3).output = [{ text: 5 }, { text: '{}' }];
    },
    (r) => {
      payload(r, 3).output = [{ text: 'bad header' }, { text: '{}' }];
    },
    (r) => {
      payload(r, 3).output = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
    },
    (r) => update(r, 3, { output: '' }),
    (r) => update(r, 3, { session_id: -1, output: '' }),
    (r) => update(r, 3, { session_id: 123, exit_code: 0, output: '' }),
    (r) => {
      payload(r, 1).input = h04NativeWaitingCode(123);
    },
    (r) => {
      payload(r, 1).input = 'text(await tools.exec_command({cmd:"other"}));';
    },
    (r) => {
      payload(r, 4).input = h04NativeWaitingCode(456);
    },
    (r) => {
      payload(r, 4).input = payload(r, 1).input;
    },
    (r) => {
      [r[3], r[4]] = [r[4]!, r[3]!];
    },
    (r) => update(r, 6, { session_id: 123, output: '' }),
    (r) => update(r, 6, { exit_code: 1, output: '' }),
    (r) => {
      payload(r, 4).input = (payload(r, 4).input as string).replace('60000', '1000');
    },
    (r) => {
      const v = value(r, 6);
      v.output = 'forged result';
      update(r, 6, v);
    },
    (r) => {
      r.splice(2, 1);
    },
    (r) => {
      r.splice(5, 1);
    },
    ...[
      ['thread_id', 'other'],
      ['turn_id', 'other'],
    ].flatMap(([key, v]) =>
      [2, 5].map((index) => (r: Records) => {
        payload(r, index)[key!] = v;
      }),
    ),
    ...[
      ['type', 'Other'],
      ['id', 'other'],
      ['process_id', '456'],
      ['cwd', '/foreign'],
      ['status', 'failed'],
      ['exit_code', 1],
    ].map(([key, v]) => (r: Records) => {
      (payload(r, 5).item as Record<string, unknown>)[String(key)] = v;
    }),
    (r) => {
      (payload(r, 2).item as Record<string, unknown>).type = 'Other';
    },
    (r) => {
      (payload(r, 2).item as Record<string, unknown>).id = 1;
    },
    (r) => {
      (payload(r, 2).item as Record<string, unknown>).id = '';
    },
    (r) => {
      (payload(r, 2).item as Record<string, unknown>).command = 'bad';
      (payload(r, 5).item as Record<string, unknown>).command = 'bad';
    },
    (r) => {
      (payload(r, 2).item as Record<string, unknown>).command = [];
      (payload(r, 5).item as Record<string, unknown>).command = [];
    },
    (r) => {
      for (const i of [2, 5])
        (payload(r, i).item as Record<string, unknown>).command = ['zsh', '-x', 'other'];
    },
    (r) => {
      for (const i of [2, 5])
        (payload(r, i).item as Record<string, unknown>).command = ['zsh', '-c', 'other'];
    },
    (r) => {
      [r[2], r[3]] = [r[3]!, r[2]!];
    },
    (r) => {
      [r[4], r[5]] = [r[5]!, r[4]!];
    },
    (r) => {
      [r[5], r[6]] = [r[6]!, r[5]!];
    },
  ];
  for (const change of changes) {
    const rows = structuredClone(original);
    change(rows);
    writeFileSync(f.transcript, rows.map((r) => JSON.stringify(r) + '\n').join(''));
    expect(run).toThrow();
  }
  writeFileSync(f.transcript, original.map((r) => JSON.stringify(r) + '\n').join(''));
  for (const i of [3, 6]) {
    const rows = structuredClone(original);
    payload(rows, i).output = [
      { type: 'input_text', text: 'Script completed\nWall time 1.2 seconds\nOutput:\n' },
      { type: 'input_text', text: (payload(rows, i).output as { text: string }[])[0]!.text },
    ];
    writeFileSync(f.transcript, rows.map((r) => JSON.stringify(r) + '\n').join(''));
    expect(run()).toMatchObject({ sessionId: 123 });
  }
  writeFileSync(f.transcript, original.map((r) => JSON.stringify(r) + '\n').join(''));
  const ref = (line: number) => ({
    locator: f.transcript + '#L' + line,
    hash: digest(JSON.stringify(original[line - 1]) + '\n'),
  });
  expect(() => h04NativeRecord({ ...ref(1), locator: f.transcript })).toThrow('h04-native-line');
  expect(() => h04NativeRecord({ ...ref(1), hash: '0'.repeat(64) })).toThrow('h04-native-line-pin');
  expect(() => h04NativeRecord({ ...ref(1), locator: f.transcript + '#L9999' })).toThrow(
    'h04-native-line-pin',
  );
  expect(h04NativeRecord(ref(1)).type).toBe('event_msg');
  expect(() =>
    verifyH04NativeWait(
      report.request!,
      { ...participant, through: { ...ref(1), hash: '0'.repeat(64) } },
      report.primary.terminal!,
    ),
  ).toThrow('h04-native-range');
  const prefixed = [{ type: 'session_meta', payload: {} }, ...original];
  writeFileSync(f.transcript, prefixed.map((r) => JSON.stringify(r) + '\n').join(''));
  expect(
    verifyH04NativeWait(
      report.request!,
      {
        ...participant,
        after: { locator: f.transcript + '#L1', hash: digest(JSON.stringify(prefixed[0]) + '\n') },
        through: {
          locator: f.transcript + '#L9',
          hash: digest(JSON.stringify(prefixed[8]) + '\n'),
        },
      },
      report.primary.terminal!,
    ),
  ).toMatchObject({ sessionId: 123 });
  writeFileSync(f.transcript, 'partial');
  expect(run).toThrow('h04-native-history-partial');
});

it('never applies a result after a second model wait, substituted output, or unconfirmed native stop', async () => {
  const f = nativeFixture(),
    complete = f.complete.getMockImplementation()!;
  f.complete.mockImplementation(async () => {
    await complete();
    const lines = readFileSync(f.transcript, 'utf8').trim().split('\n');
    lines.splice(-1, 0, lines[4]!);
    writeFileSync(f.transcript, lines.join('\n') + '\n');
  });
  const report = f.report(await f.run()),
    request = h01ReadJson(report.request!) as H04NativeOperationRequest,
    binding = h04NativeBinding(request);
  expect(report.outcome).toBe('unknown');
  expect(report.primary.result).not.toBeNull();
  expect(report.primary.application).toBeNull();
  expect(
    lookupEffect(join(request.outputRoot, 'effects'), h04BoundIntent(binding, 'apply')).status,
  ).toBe('missing');
  expect(existsSync(join(request.outputRoot, 'applied.json'))).toBe(false);
});

it('defers a primary command notice until its exact turn ACK and ignores unrelated read-only notifications', async () => {
  const f = nativeFixture();
  mocks.sessionSend.mockImplementation(() => {
    f.notify({ method: 'turn/completed' });
    f.notify({ method: 'item/started', params: { item: { type: 'agentMessage' } } });
    f.gate();
    return 'turn';
  });
  const report = f.report(await f.run());
  expect(report.outcome, report.blocking.join(',')).toBe('accepted');
});
it.each(['foreign-turn', 'duplicate-command', 'no-command'] as const)(
  'refuses %s without applying or blindly restarting',
  async (mode) => {
    const f = nativeFixture();
    f.complete.mockImplementation(async () => {
      if (mode === 'no-command') return;
      const path = join(f.ctx.roots.workspaceRoot, 'evidence/h04-operation-request.json'),
        r = JSON.parse(readFileSync(path, 'utf8')) as H04NativeOperationRequest;
      const message = {
        method: 'item/started',
        params: {
          threadId: 'session',
          turnId: mode === 'foreign-turn' ? 'other' : 'turn',
          item: {
            type: 'commandExecution',
            id: 'command',
            command: h04NativeWaitCommand(r, { locator: path, hash: digest(readFileSync(path)) }),
          },
        },
      };
      f.notify(message);
      if (mode === 'duplicate-command') f.notify(message);
      await Promise.resolve();
    });
    const report = f.report(await f.run());
    expect(report.outcome).toBe('unknown');
    expect(report.primary.application).toBeNull();
  },
);
it.each(['unavailable', 'checker', 'opaque', 'cancel', 'stop'] as const)(
  'retains H04 %s as unknown or not-run, never accepted',
  async (mode) => {
    const f = nativeFixture();
    if (mode === 'unavailable') f.ctx.runtime.files = [];
    if (mode === 'checker') mocks.initialCheck.mockResolvedValue({ failed: false });
    if (mode === 'opaque') mocks.initialCheck.mockRejectedValue('opaque primary failure');
    if (mode === 'cancel') f.controller.abort();
    if (mode === 'stop')
      f.nativeStop.mockResolvedValue(
        f.pin(join(f.directory, 'unknown-stop.json'), { confirmed: false }),
      );
    const report = f.report(await f.run());
    expect(report.outcome).not.toBe('accepted');
    expect(report.primary.application).toBeNull();
  },
);

function waiterFixture(extra: Record<string, unknown> = {}) {
  const dir = join(root, 'waiter');
  mkdirSync(dir);
  const pin = (name: string, value: unknown) => {
    const path = join(dir, name),
      bytes = Buffer.isBuffer(value)
        ? value
        : Buffer.from(typeof value === 'string' ? value : canonical(value) + '\n');
    writeFileSync(path, bytes, { mode: 0o600 });
    return { locator: path, hash: digest(bytes) };
  };
  const binary = pin('binary', Buffer.from([255, 254, 128, 0])),
    waiter = pin('waiter.mjs', 'read-only pinned code');
  const r = {
    kind: 'comparison-h04-native-operation',
    schemaVersion: 1,
    opId: 'wait-unit',
    operationId: 'wait-unit',
    deadlineNs: String(process.hrtime.bigint() + 1000000000n),
    outputRoot: dir,
    node: binary,
    waiter,
    ...extra,
  };
  const ref = pin('request.json', r),
    terminal = {
      kind: 'comparison-h04-native-terminal',
      opId: r.opId,
      operationId: r.operationId,
      inputHash: digest(canonical(r)),
      result: { sha256: 'a'.repeat(64), bytes: 1 },
    };
  return {
    dir,
    pin,
    request: r,
    ref,
    terminal,
    args: ['--wait', ref.locator, ref.hash],
    publish: () => pin('terminal.json', terminal),
  };
}
it('the read-only H04 waiter wakes on primary publication and closes before late callbacks', async () => {
  const f = waiterFixture({ extra: [null, true] }),
    watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  let callback: () => void = () => {};
  mocks.fsWatch.mockImplementation(((_path: unknown, fn: () => void) => {
    callback = fn;
    return watcher;
  }) as unknown as typeof fs.watch);
  const waiting = h04NativeWait(f.args);
  f.publish();
  callback();
  expect(await waiting).toBe(readFileSync(join(f.dir, 'terminal.json'), 'utf8'));
  callback();
  watcher.emit('error', new Error('late error'));
  expect(watcher.close).toHaveBeenCalledOnce();
});
it.each([
  'usage',
  'flag',
  'kind',
  'version',
  'deadline-shape',
  'expired',
  'far-deadline',
  'pin',
  'directory',
  'large',
  'terminal-kind',
  'terminal-operation',
  'terminal-hash',
  'terminal-owner',
  'missing-parent',
  'timeout',
  'watch-error',
] as const)('read-only waiter rejects %s without side effects', async (mode) => {
  const f = waiterFixture();
  if (mode === 'usage') f.args = [];
  if (mode === 'flag') f.args[0] = '--bad';
  if (mode === 'kind') f.request.kind = 'foreign';
  if (mode === 'version') f.request.schemaVersion = 2;
  if (mode === 'deadline-shape') f.request.deadlineNs = 'x';
  if (mode === 'expired') f.request.deadlineNs = '0';
  if (mode === 'far-deadline')
    f.request.deadlineNs = String(process.hrtime.bigint() + 3000000000000000n);
  if (mode === 'pin') f.request.node.hash = '0'.repeat(64);
  if (mode === 'directory') f.request.node.locator = f.dir;
  if (mode === 'large') {
    truncateSync(f.request.node.locator, 513 * 1024 * 1024);
  }
  if (mode.startsWith('terminal-')) {
    f.publish();
    const v = JSON.parse(readFileSync(join(f.dir, 'terminal.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    v[
      {
        'terminal-kind': 'kind',
        'terminal-operation': 'operationId',
        'terminal-hash': 'inputHash',
        'terminal-owner': 'opId',
      }[mode as 'terminal-kind']
    ] = 'foreign';
    f.pin('terminal.json', v);
  }
  if (mode === 'missing-parent') f.request.outputRoot = join(f.dir, 'missing');
  if (mode === 'timeout') f.request.deadlineNs = String(process.hrtime.bigint() + 20000000n);
  if (mode === 'watch-error') {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    mocks.fsWatch.mockReturnValue(watcher as unknown as ReturnType<typeof fs.watch>);
    setTimeout(() => watcher.emit('error', new Error('watch failed')), 1);
  }
  if (!['usage', 'flag'].includes(mode)) {
    const ref = f.pin('request.json', f.request);
    f.args = ['--wait', ref.locator, ref.hash];
  }
  await expect(h04NativeWait(f.args)).rejects.toThrow();
  expect(existsSync(join(f.dir, 'applied.json'))).toBe(false);
});
it.each([false, true])(
  'plain Node waiter entrypoint emits its terminal or rejection: %s',
  async (failed) => {
    const f = waiterFixture();
    f.publish();
    const argv = process.argv;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true),
      stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.argv = [
      process.execPath,
      fileURLToPath(new URL('./comparisonH04NativeWait.mjs', import.meta.url)),
      ...(failed ? ['--bad'] : f.args),
    ];
    vi.resetModules();
    try {
      await import('./comparisonH04NativeWait.mjs');
      await vi.waitFor(() => expect(failed ? stderr : stdout).toHaveBeenCalled());
    } finally {
      process.argv = argv;
    }
  },
);

it.each(['material', 'run-result', 'gate', 'checker-source', 'history'] as const)(
  'refuses changed %s after the native wait before applying',
  async (target) => {
    const f = nativeFixture(target === 'history' ? 'temporal' : 'legacy'),
      complete = f.complete.getMockImplementation()!;
    f.complete.mockImplementation(async () => {
      await complete();
      if (target === 'material')
        writeFileSync(join(f.ctx.roots.workspaceRoot, 'checks.mjs'), 'changed immutable bytes');
      if (target === 'checker-source')
        writeFileSync(join(f.directory, 'check.stderr'), 'changed primary error');
      if (target === 'run-result') {
        const r = JSON.parse(
          readFileSync(
            join(f.ctx.roots.workspaceRoot, 'evidence/h04-operation-request.json'),
            'utf8',
          ),
        ) as H04NativeOperationRequest;
        const t = JSON.parse(readFileSync(join(r.outputRoot, 'terminal.json'), 'utf8')) as {
          result: ArtifactRef;
        };
        writeFileSync(join(r.outputRoot, 'artifacts', t.result.sha256), 'changed run result');
      }
      if (target === 'gate' || target === 'history') {
        const name = fs
          .readdirSync(f.ctx.roots.evidenceRoot)
          .find((name) => name.startsWith('h04-' + target + '-'))!;
        writeFileSync(join(f.ctx.roots.evidenceRoot, name), 'changed primary ' + target);
      }
    });
    const report = f.report(await f.run());
    expect(report.outcome).toBe('unknown');
    expect(report.primary.application).toBeNull();
  },
);
it('binds a gate to the exact native command item and turn before claiming accepted primary evidence', async () => {
  const f = nativeFixture(),
    report = f.report(await f.run()),
    gate = h01ReadJson(report.primary.gate!) as Record<string, unknown>;
  for (const target of ['turn', 'item', 'atMs'] as const) {
    const changed = structuredClone(gate),
      params = object(object(changed.notification).params);
    if (target === 'turn') params.turnId = 'other';
    if (target === 'item') object(params.item).id = 'other';
    if (target === 'atMs') changed.atMs = 0;
    const candidate = structuredClone(report);
    candidate.primary.gate = f.pin(join(f.directory, target + '-gate.json'), changed);
    expect(() => verifyH04NativePrimary(report.request!, candidate)).toThrow(
      'h04-native-gate-binding',
    );
  }
});
it.each(['cancel', 'material', 'metadata', 'run-result', 'deadline', 'extra-effect'] as const)(
  'checks %s again after its final asynchronous guard before apply',
  async (target) => {
    const f = nativeFixture(),
      stopped = f.nativeStop.getMockImplementation()!;
    f.nativeStop.mockImplementation(async () => {
      const stop = await stopped();
      f.verify.mockImplementation(async () => {
        if (target === 'cancel') f.controller.abort();
        if (target === 'material')
          writeFileSync(join(f.ctx.roots.workspaceRoot, 'checks.mjs'), 'changed in guard await');
        if (target === 'metadata')
          writeFileSync(join(f.ctx.roots.workspaceRoot, '.h04/rules.md'), 'changed in guard await');
        if (target === 'deadline') f.ctx.workDeadlineNs = '0';
        if (target === 'run-result' || target === 'extra-effect') {
          const r = JSON.parse(
            readFileSync(
              join(f.ctx.roots.workspaceRoot, 'evidence/h04-operation-request.json'),
              'utf8',
            ),
          ) as H04NativeOperationRequest;
          if (target === 'extra-effect')
            writeFileSync(join(r.outputRoot, 'effects/extra'), 'foreign');
          else {
            const terminal = JSON.parse(
              readFileSync(join(r.outputRoot, 'terminal.json'), 'utf8'),
            ) as { result: ArtifactRef };
            writeFileSync(
              join(r.outputRoot, 'artifacts', terminal.result.sha256),
              'changed in guard await',
            );
          }
        }
      });
      return stop;
    });
    const report = f.report(await f.run());
    expect(report.outcome).toBe('unknown');
    expect(report.primary.application).toBeNull();
  },
);

it('publishes a complete H04 terminal atomically while its actual read-only waiter observes staging', async () => {
  const f = nativeFixture();
  type Notice = (event: 'rename' | 'change', filename: string | null) => void;
  const observed: {
    notify: Notice | null;
    waiting: Promise<string> | null;
    staged: string | null;
    bytes: Buffer | null;
  } = { notify: null, waiting: null, staged: null, bytes: null };
  mocks.fsWatch.mockImplementation((path: string, notify: Notice) => {
    observed.notify = notify;
    return mocks.originalWatch!(path, notify);
  });
  mocks.fsLink.mockImplementation((from: FileSystem.PathLike, to: FileSystem.PathLike) => {
    const terminal = String(to).endsWith('/terminal.json');
    if (terminal) {
      observed.staged = String(from);
      observed.bytes = readFileSync(from);
      expect(basename(String(from))).toMatch(/^\.pending-/u);
      expect(existsSync(to)).toBe(false);
      expect(JSON.parse(observed.bytes.toString())).toMatchObject({
        kind: 'comparison-h04-native-terminal',
        opId: f.ctx.opId,
      });
      const path = join(f.ctx.roots.workspaceRoot, 'evidence/h04-operation-request.json');
      observed.waiting = h04NativeWait(['--wait', path, digest(readFileSync(path))]);
      // Preserve the promise for the terminal assertion; an early refusal must still fail this test.
      void observed.waiting.catch(() => undefined);
      expect(observed.notify).not.toBeNull();
      observed.notify!('rename', basename(String(from)));
      expect(existsSync(to)).toBe(false);
    }
    mocks.originalLink!(from, to);
    if (terminal) {
      expect(readFileSync(to)).toEqual(observed.bytes);
      observed.notify!('rename', 'terminal.json');
    }
  });
  const result = await f.run(),
    report = f.report(result);
  expect(result.outcome, report.blocking.join(',')).toBe('completed');
  expect(observed.waiting).not.toBeNull();
  expect(await observed.waiting).toBe(observed.bytes!.toString());
  expect(existsSync(observed.staged!)).toBe(false);
  expect(fs.statSync(report.primary.terminal!.locator).mode & 0o777).toBe(0o600);
  expect(fs.statSync(report.primary.terminal!.locator).nlink).toBe(1);
  expect(report.primary.application).not.toBeNull();
});
