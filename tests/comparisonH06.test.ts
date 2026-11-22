import * as FS from 'node:fs';
import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localTaskKey } from '../src/policy/localTask.js';
import type { ArtifactRef } from '../src/contracts/preparation.js';
import type { ManagedTaskInput } from '../src/contracts/localTask.js';
import { performance } from 'node:perf_hooks';
import { defaultPayloadConverter } from '@temporalio/common';
import { historyFromJSON, historyToJSON, payloadToJSON } from '@temporalio/common/proto-utils';
import { object } from '../src/contracts/project.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import * as Effects from '../src/adapters/artifacts/effects.js';
import * as Pins from './comparisonH04Contract.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  h06Assets,
  h06AssetHashes,
  h06Checks,
  h06Failure,
  h06Hash,
  h06Intent,
  h06SourcePaths,
  h06Stopped,
  parseH06Request,
  checkH06,
  type H06Request,
} from './comparisonH06Contract.js';
import * as Host from './comparisonH06.js';

interface UnitFixture {
  initial: ManagedTaskInput;
  state: { active: Set<string>; writers: number[]; stopConfirmed: boolean };
  activities: Record<string, (...args: unknown[]) => Promise<unknown>>;
  controls: Record<string, (...args: unknown[]) => Promise<unknown>>;
  release(name: string): void;
}
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  exec: vi.fn<(...args: unknown[]) => string>(),
  sync: vi.fn(),
  own: vi.fn(),
  delay: vi.fn(),
  now: 0,
  environment: vi.fn(),
  create: vi.fn(),
  replay: vi.fn(),
  nativeConnect: vi.fn(),
  connect: vi.fn(),
  client: null as unknown,
  factory: vi.fn(),
  fixture: null as UnitFixture | null,
  fixtureContext: null as unknown,
  gitWorkspace: '',
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FS>();
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    spawn: mocks.spawn,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const [file, argv, options] = args;
      if (
        file === 'git' &&
        options?.cwd === mocks.gitWorkspace &&
        (JSON.stringify(argv) === JSON.stringify(['init', '--quiet', '--template=']) ||
          JSON.stringify(argv) === JSON.stringify(['rev-parse', '--git-common-dir']))
      )
        return actual.execFileSync(...args);
      if (
        file === '/bin/ps' &&
        JSON.stringify(argv) === JSON.stringify(['-axo', 'pid=,ppid=,pgid=,lstart='])
      )
        return mocks.exec(...args);
      throw new Error('unexpected execFileSync in unit: ' + String(file));
    },
    spawnSync: mocks.sync,
    execFile: vi.fn(() => {
      throw new Error('unexpected execFile in unit');
    }),
  };
});
vi.mock('../examples/temporal-consumers/full/safety.mjs', () => ({ ownProcess: mocks.own }));
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }));
vi.mock('@temporalio/testing', () => ({
  TestWorkflowEnvironment: { createLocal: mocks.environment },
}));
vi.mock('@temporalio/worker', () => ({
  Worker: { create: mocks.create, runReplayHistory: mocks.replay },
  NativeConnection: { connect: mocks.nativeConnect },
}));
vi.mock('@temporalio/client', () => ({
  Connection: { connect: mocks.connect },
  Client: class {
    constructor() {
      return mocks.client as object;
    }
  },
}));
vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => ({ cancellationSignal: new AbortController().signal, heartbeat: vi.fn() }),
  },
}));
vi.mock('./temporal/task-execution-sdk-fixture.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: unknown[]) => unknown>>();
  return {
    sdkFixture: (...args: unknown[]) => {
      mocks.fixtureContext = args[4];
      const fixture = actual.sdkFixture!(...args) as UnitFixture;
      mocks.fixture = fixture;
      mocks.factory(fixture);
      return fixture;
    },
  };
});
let temp: string,
  request: H06Request,
  initial: Record<string, unknown>,
  cold: Record<string, unknown>;
let originalExit: typeof process.exitCode;
const write = (name: string, value: unknown) =>
  writeFileSync(join(request.outputRoot, name), JSON.stringify(value));
const read = (name: string): Record<string, unknown> =>
  object(JSON.parse(readFileSync(join(request.outputRoot, name), 'utf8')));
const bound = () => ({ inputHash: h06Hash(request), identity: request.identity });
const stop = (identities: unknown[] = []) => ({
  stopped: true,
  code: 0,
  signal: null,
  killed: false,
  deadlineReached: false,
  identities,
  pids: [] as number[],
  groups: [] as number[],
});
const publish = (value: unknown) =>
  artifactStore(join(request.outputRoot, 'artifacts')).publish(Buffer.from(canonical(value)));
function update(name: string, f: (v: Record<string, unknown>) => void) {
  const v = read(name);
  f(v);
  write(name, v);
}
function payload(value: unknown) {
  return { payloads: [payloadToJSON(defaultPayloadConverter.toPayload(value)!)] };
}
function history(input: unknown, held: ArtifactRef) {
  return object(
    JSON.parse(
      historyToJSON(
        historyFromJSON({
          events: [
            {
              eventId: '1',
              eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
              workflowExecutionStartedEventAttributes: {
                workflowType: { name: 'LocalTaskWorkflow' },
                originalExecutionRunId: 'run-1',
                input: payload(input),
              },
            },
            {
              eventId: '2',
              eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED',
              activityTaskScheduledEventAttributes: { activityType: { name: 'writeLocalTask' } },
            },
            {
              eventId: '3',
              eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED',
              activityTaskScheduledEventAttributes: { activityType: { name: 'holdTaskExecution' } },
            },
            {
              eventId: '4',
              eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED',
              activityTaskCompletedEventAttributes: {
                scheduledEventId: '3',
                result: payload({ status: 'held', held }),
              },
            },
          ],
        }),
      ),
    ),
  );
}
async function fixture(
  variant: 'legacy' | 'temporal' = 'legacy',
  retainRoot = false,
  skipStop = false,
) {
  request.variant = variant;
  request.server = variant === 'temporal' ? request.node : null;
  if (!retainRoot) mkdirSync(request.outputRoot);
  write(
    'source-pins.json',
    h06SourcePaths.map((path) => ({ path, sha256: digest(readFileSync(path)) })),
  );
  const input =
    variant === 'temporal'
      ? (await Host.createH06Fixture(request)).initial
      : {
          schemaVersion: 11,
          admission: {
            preparation: {
              owner: request.identity.owner,
              generation: 1,
              project: { workspaceId: request.identity.workspace },
            },
          },
        };
  write('workflow-input.json', input);
  const checkpoint =
    variant === 'legacy'
      ? publish({ inputHash: h06Hash(request), unfinished: request.operationId })
      : artifactStore(join(request.outputRoot, 'sdk-fixture', 'artifacts')).publish(
          Buffer.from(canonical({ syntheticHeld: true, input })),
        );
  const pending = publish({
    ...bound(),
    kind: 'h06-pending-operation',
    status: 'pending',
    operationId: request.operationId,
    effectIdentity: h06Intent(request),
    checkpoint,
  });
  const state = {
    ...bound(),
    operationId: request.operationId,
    status: 'pending',
    pending,
    frozen: false,
    released: false,
  };
  const firstHost = { pid: 100, ppid: 99, pgid: 100, identity: 'first-start' },
    nextHost = { pid: 101, ppid: 99, pgid: 101, identity: 'next-start' };
  const s = lstatSync(request.outputRoot),
    workspace = { dev: String(s.dev), ino: String(s.ino) };
  const failurePath = join(request.outputRoot, 'F-01.json');
  writeFileSync(failurePath, h06Failure(request));
  const failure = { path: failurePath, sha256: digest(h06Failure(request)) };
  initial = {
    ...bound(),
    phase: 'same-environment',
    host: firstHost,
    workspace,
    pending,
    state,
    stageStartedAt: 100000,
    stageEndedAt: 135000,
    stageElapsedMs: 35000,
    clockBasis: 'Date.now+performance.now',
    failure,
    workflow: { workflowId: 'workflow-1', runId: 'run-1' },
    pauseAck: { command: 'pause' },
    writerDrained: true,
  };
  cold = {
    ...bound(),
    phase: 'cold-host-reopen',
    host: nextHost,
    workspace,
    pending,
    state,
    failure,
    dispatches: 0,
    frozenReleasedRefused: true,
    unknownEffectRefused: true,
    workflow: initial.workflow,
    pauseAck: initial.pauseAck,
    freshClient: true,
  };
  write('initial.json', initial);
  write('cold.json', cold);
  write('initial-stop.json', stop([firstHost]));
  write('cold-stop.json', stop([nextHost]));
  write('worker-stop.json', stop());
  if (!skipStop) write('stop.json', stop());
  const process = { pid: 102, ppid: 100, pgid: 102, identity: 'writer-start' };
  write('writer-live.json', { ...bound(), process, observedBeforeStop: true });
  const stopped = { inputHash: h06Hash(request), receipt: stop([process]) };
  write('writer-stop.json', stopped);
  const log = join(request.outputRoot, 'writer.log');
  writeFileSync(log, 'writer-live\n');
  write('writer-stability.json', {
    identitiesAbsent: true,
    listenersClosed: true,
    noLateWrite: true,
    log: { path: log, sha256: digest('writer-live\n') },
  });
  await Effects.effectJournal(join(request.outputRoot, 'effects')).execute(
    h06Intent(request),
    async () => publish(stopped),
  );
  const before = {
    owner: request.identity.owner,
    generation: 1,
    released: false,
    frozen: false,
    revision: 3,
    lease_until: 120000,
  };
  const renewed = { ...before, revision: 4, lease_until: 200000 };
  const ack = { operation_id: 'chat:lease:1:3', catalog_revision: 4, generation: 1 };
  write('lease.json', {
    ...bound(),
    automatic: true,
    before,
    renewed,
    after: renewed,
    renewAcceptedAt: 100001,
    ack,
    operation: { status: 'confirmed', ack },
    event: {
      operation_id: ack.operation_id,
      revision: 4,
      change: { type: 'renew', lease_until: renewed.lease_until },
      context: {
        actor_id: request.identity.owner,
        project_id: 'h06',
        task_id: request.operationId,
      },
    },
  });
  write('workflow-input.json', input);
  const workflowId =
    variant === 'temporal' ? localTaskKey(input as ManagedTaskInput) : 'workflow-1';
  initial.sameEnvironment = {
    oldWorkerDrained: true,
    distinctWorker: true,
    freshClient: true,
    pending: checkpoint,
    inputHash: digest(canonical(input)),
  };
  initial.workflow = { workflowId, runId: 'run-1' };
  cold.workflow = initial.workflow;
  write('initial.json', initial);
  write('cold.json', cold);
  const query = {
    workflowId,
    runId: 'run-1',
    query: 'localTaskStatus',
    result: { waiting: true, runId: 'run-1', held: checkpoint },
  };
  write('status-before.json', query);
  write('status-after.json', query);
  const hist = history(input, checkpoint);
  write('history-before.json', hist);
  write('history-after.json', hist);
  write('replay.json', {
    success: true,
    historyHash: digest(canonical(hist)),
    workflowId,
    runId: 'run-1',
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.factory.mockReset();
  originalExit = process.exitCode;
  mocks.now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => mocks.now);
  mocks.delay.mockImplementation(async (ms: number) => {
    mocks.now += ms;
  });
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'aw-h06-unit-')));
  mocks.gitWorkspace = join(temp, 'out', 'sdk-fixture');
  const node = join(temp, 'node');
  writeFileSync(node, 'unit-node');
  chmodSync(node, 0o700);
  request = {
    schemaVersion: 1,
    kind: 'comparison-h06-model-free/2',
    operationId: 'h06-unit',
    variant: 'legacy',
    outputRoot: join(temp, 'out'),
    node: { path: node, sha256: digest('unit-node') },
    server: null,
    assets: h06Assets(),
    identity: {
      owner: 'synthetic-human',
      generation: 1,
      workspace: 'sdk-copy',
      scope: 'model-free-h06',
    },
    stimulus: { stageMs: 35000, oldLeaseMs: 20000 },
    budget: { totalMs: 180000, stopMs: 30000 },
  };
});
afterEach(() => {
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(temp, { recursive: true, force: true });
});
it('binds exact r03 accepted assets and leaves native criteria unproven in both variants', async () => {
  expect(parseH06Request(request)).toEqual(request);
  expect(h06AssetHashes['accepted-criteria-freeze.json']).toBe(
    'de4c99c7e215c72fc9f6c0d94b0a3ac46fe0238e4a3150038945c97272528dea',
  );
  await fixture();
  expect(checkH06(request)).toMatchObject({
    outcome: 'UNKNOWN',
    qualification: false,
    modelFree: 'PASS',
    reason: 'UNMET_PRIMARY_NATIVE_H06_PROOF',
    historicalV1LeaseRenewedTemporal: 'UNMET',
  });
  expect(checkH06(request).checks).toEqual(h06Checks.map((id) => ({ id, status: 'NOT_PROVEN' })));
});
it('binds real SDK history format and replay without claiming actual SDK execution', async () => {
  await fixture('temporal');
  expect(parseH06Request(request)).toEqual(request);
  expect(checkH06(request).modelFree).toBe('PASS');
});
it.each([
  [
    'schema',
    (v: Record<string, unknown>) => {
      v.schemaVersion = 2;
    },
  ],
  [
    'kind',
    (v: Record<string, unknown>) => {
      v.kind = 'native';
    },
  ],
  [
    'operation',
    (v: Record<string, unknown>) => {
      v.operationId = '../bad';
    },
  ],
  [
    'variant',
    (v: Record<string, unknown>) => {
      v.variant = 'baseline';
    },
  ],
  [
    'server',
    (v: Record<string, unknown>) => {
      v.server = request.node;
    },
  ],
  [
    'assets',
    (v: Record<string, unknown>) => {
      v.assets = {};
    },
  ],
  [
    'identity',
    (v: Record<string, unknown>) => {
      v.identity = { owner: 'other' };
    },
  ],
  [
    'stimulus',
    (v: Record<string, unknown>) => {
      v.stimulus = { stageMs: 34999, oldLeaseMs: 20000 };
    },
  ],
  [
    'budget',
    (v: Record<string, unknown>) => {
      v.budget = { totalMs: 180001, stopMs: 30000 };
    },
  ],
])('rejects request %s', (_name, mutate) => {
  const v = structuredClone(request) as unknown as Record<string, unknown>;
  mutate(v);
  expect(() => parseH06Request(v)).toThrow();
});
it('rejects malformed pinned suite semantics even when supplied by the strict reader port', () => {
  const original = Pins.readH04Pin;
  const spy = vi
    .spyOn(Pins, 'readH04Pin')
    .mockImplementation((pin) =>
      pin.path === h06Assets().suite.path ? Buffer.from('{"scenarios":{}}') : original(pin),
    );
  expect(() => parseH06Request(request)).toThrow('h06-suite');
  spy.mockImplementation((pin) =>
    pin.path === h06Assets().suite.path ? Buffer.from('{"scenarios":[]}') : original(pin),
  );
  expect(() => parseH06Request(request)).toThrow('h06-criteria');
});
it.each([
  'initial.json',
  'cold.json',
  'initial-stop.json',
  'cold-stop.json',
  'worker-stop.json',
  'stop.json',
])('keeps missing %s unknown', async (name) => {
  await fixture();
  rmSync(join(request.outputRoot, name));
  expect(checkH06(request)).toMatchObject({ modelFree: 'UNKNOWN', reason: 'missing-' + name });
});
it.each(['initial-stop.json', 'cold-stop.json', 'worker-stop.json', 'stop.json'])(
  'keeps unconfirmed %s unknown',
  async (name) => {
    await fixture();
    write(name, { ...stop(), stopped: false });
    expect(checkH06(request)).toMatchObject({
      modelFree: 'UNKNOWN',
      reason: 'unconfirmed-' + name,
    });
  },
);
it.each([
  [
    'initial.json',
    'h06-identity',
    (v: Record<string, unknown>) => {
      v.identity = { owner: 'foreign' };
    },
  ],
  [
    'cold.json',
    'h06-resume-paths',
    (v: Record<string, unknown>) => {
      v.phase = 'same-environment';
    },
  ],
  [
    'cold.json',
    'h06-cold-host-not-distinct',
    (v: Record<string, unknown>) => {
      v.host = initial.host;
    },
  ],
  [
    'initial-stop.json',
    'h06-host-process-binding',
    (v: Record<string, unknown>) => {
      v.identities = [];
    },
  ],
  [
    'cold.json',
    'h06-workspace-changed',
    (v: Record<string, unknown>) => {
      v.workspace = {};
    },
  ],
  [
    'cold.json',
    'h06-cold-dispatch',
    (v: Record<string, unknown>) => {
      v.dispatches = 1;
    },
  ],
  [
    'initial.json',
    'h06-stage-too-short',
    (v: Record<string, unknown>) => {
      v.stageElapsedMs = 34999;
    },
  ],
  [
    'initial.json',
    'h06-stage-too-short',
    (v: Record<string, unknown>) => {
      v.stageElapsedMs = Infinity;
    },
  ],
  [
    'initial.json',
    'h06-stage-too-short',
    (v: Record<string, unknown>) => {
      v.stageStartedAt = 200000;
    },
  ],
  [
    'initial.json',
    'h06-stage-too-short',
    (v: Record<string, unknown>) => {
      v.clockBasis = 'model-claim';
    },
  ],
  [
    'writer-live.json',
    'h06-writer-process',
    (v: Record<string, unknown>) => {
      v.process = { pid: 1, identity: '' };
    },
  ],
  [
    'writer-live.json',
    'h06-live-before-stop',
    (v: Record<string, unknown>) => {
      v.observedBeforeStop = false;
    },
  ],
  [
    'writer-stability.json',
    'h06-writer-still-active',
    (v: Record<string, unknown>) => {
      v.noLateWrite = false;
    },
  ],
])('refuses %s %s', async (name, reason, mutate) => {
  await fixture();
  update(name, mutate);
  expect(() => checkH06(request)).toThrow(reason);
});
it.each([undefined, {}, { status: 'pending' }])(
  'rejects absent/empty pending state %j',
  async (value) => {
    await fixture();
    initial.state = value;
    write('initial.json', initial);
    expect(() => checkH06(request)).toThrow();
  },
);
it.each([undefined, {}])('rejects absent pending artifact %j', async (value) => {
  await fixture();
  initial.pending = value;
  write('initial.json', initial);
  expect(() => checkH06(request)).toThrow();
});
it.each(['frozen', 'released'])('refuses %s state', async (key) => {
  await fixture();
  const state = { ...(initial.state as object), [key]: true };
  write('initial.json', { ...initial, state });
  expect(() => checkH06(request)).toThrow('h06-state-binding');
});
it('refuses changed cold state/pending identity', async () => {
  await fixture();
  write('cold.json', { ...cold, state: { ...(cold.state as object), extra: true } });
  expect(() => checkH06(request)).toThrow('h06-cold-state-changed');
});
it('detects F01 tamper from physical bytes', async () => {
  await fixture();
  writeFileSync(join(request.outputRoot, 'F-01.json'), 'PASS');
  expect(() => checkH06(request)).toThrow();
});
it('requires PID/start identity and confirmed writer drain', async () => {
  await fixture();
  update('writer-stop.json', (v) => {
    v.receipt = { ...stop(), identities: [{ pid: 102, identity: 'reused' }] };
  });
  expect(() => checkH06(request)).toThrow('h06-writer-identity');
  update('writer-stop.json', (v) => {
    v.receipt = { ...stop(), stopped: false };
  });
  expect(checkH06(request)).toMatchObject({
    reason: 'writer-stop-unconfirmed',
    modelFree: 'UNKNOWN',
  });
});
it('missing durable writer receipt remains UNKNOWN, not safe to repeat', async () => {
  await fixture();
  const intent = h06Intent(request),
    key = digest(JSON.stringify([intent.projectId, intent.taskId, intent.operationId]));
  rmSync(join(request.outputRoot, 'effects', key + '.receipt'));
  expect(checkH06(request)).toMatchObject({
    modelFree: 'UNKNOWN',
    reason: 'writer-effect-unconfirmed',
  });
});
it('rejects a duplicate journal entry', async () => {
  await fixture();
  writeFileSync(join(request.outputRoot, 'effects', 'extra'), 'unexpected');
  expect(() => checkH06(request)).toThrow('h06-duplicate-writer-effect');
});
it('detects effect mutation during phase observation', async () => {
  await fixture();
  const lookup = Effects.lookupEffect;
  vi.spyOn(Effects, 'lookupEffect').mockImplementation((dir, intent) => {
    const result = lookup(dir, intent);
    writeFileSync(join(dir, 'late'), 'late');
    return result;
  });
  expect(() => checkH06(request)).toThrow('h06-effect-changed');
});
it.each([
  [
    'h06-lease-proof',
    (v: Record<string, unknown>) => {
      v.automatic = false;
    },
  ],
  [
    'h06-renew-order',
    (v: Record<string, unknown>) => {
      v.renewAcceptedAt = 120000;
    },
  ],
  [
    'h06-owner-changed',
    (v: Record<string, unknown>) => {
      v.after = { ...(v.after as object), owner: 'foreign' };
    },
  ],
  [
    'h06-renew-transition',
    (v: Record<string, unknown>) => {
      v.after = { ...(v.after as object), revision: 5 };
    },
  ],
  [
    'h06-renew-receipt',
    (v: Record<string, unknown>) => {
      v.operation = { status: 'pending', ack: v.ack };
    },
  ],
  [
    'h06-renew-receipt',
    (v: Record<string, unknown>) => {
      v.event = { ...(v.event as object), change: { type: 'recover-owner', lease_until: 200000 } };
    },
  ],
  [
    'h06-renew-context',
    (v: Record<string, unknown>) => {
      v.event = {
        ...(v.event as object),
        context: { actor_id: 'foreign', project_id: 'h06', task_id: request.operationId },
      };
    },
  ],
])('requires lease causal proof %s', async (reason, mutate) => {
  await fixture();
  update('lease.json', mutate);
  expect(() => checkH06(request)).toThrow(reason);
});
it.each([
  [
    'workflow-input.json',
    'h06-temporal-checkpoint',
    (v: Record<string, unknown>) => {
      v.schemaVersion = 10;
    },
  ],
  [
    'cold.json',
    'h06-workflow-changed',
    (v: Record<string, unknown>) => {
      v.workflow = { workflowId: 'other', runId: 'run-1' };
    },
  ],
  [
    'history-before.json',
    'h06-workflow-start',
    (v: Record<string, unknown>) => {
      v.events = [];
    },
  ],
  [
    'history-after.json',
    'h06-history-prefix',
    (v: Record<string, unknown>) => {
      v.events = [];
    },
  ],
  [
    'replay.json',
    'h06-replay',
    (v: Record<string, unknown>) => {
      v.success = false;
    },
  ],
  [
    'initial.json',
    'h06-worker-recovery',
    (v: Record<string, unknown>) => {
      v.writerDrained = false;
    },
  ],
])('binds Temporal %s %s', async (name, reason, mutate) => {
  await fixture('temporal');
  update(name, mutate);
  expect(() => checkH06(request)).toThrow(reason);
});
it('rejects historical replay from another operation and a duplicate writer schedule', async () => {
  await fixture('temporal');
  update('replay.json', (v) => {
    v.workflowId = 'foreign';
  });
  expect(() => checkH06(request)).toThrow('h06-replay');
});
it('refuses unsafe output aliases and source path substitution', async () => {
  await fixture();
  const alias = join(temp, 'alias');
  symlinkSync(request.outputRoot, alias);
  expect(() => checkH06({ ...request, outputRoot: alias })).toThrow('h06-output-alias');
  write('source-pins.json', {});
  expect(() => checkH06(request)).toThrow('h06-source-pins');
  write('source-pins.json', []);
  expect(() => checkH06(request)).toThrow('h06-source-paths');
});
it('plans only, pins all sources, and checks executable/node bytes without dispatch', () => {
  expect(Host.planH06(request)).toMatchObject({
    mayRun: false,
    authority: null,
    qualification: false,
    allowedModelStarts: 0,
    historicalV1LeaseRenewedTemporal: 'UNMET',
  });
  request.variant = 'temporal';
  request.server = request.node;
  expect(Host.planH06(request).sourcePins).toHaveLength(h06SourcePaths.length);
  chmodSync(request.node.path, 0o600);
  expect(() => Host.planH06(request)).toThrow('h06-node-executable');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('requires a parseable complete process observation, never guesses an identity', () => {
  mocks.exec.mockReturnValue(' 101 1 101 Mon Nov 1 00:00:00 2026\n');
  expect(Host.h06Processes()).toEqual([
    { pid: 101, ppid: 1, pgid: 101, identity: 'Mon Nov 1 00:00:00 2026' },
  ]);
  mocks.exec.mockReturnValue('garbage');
  expect(() => Host.h06Processes(9)).toThrow('h06-process-observation');
  expect(mocks.exec).toHaveBeenLastCalledWith('/bin/ps', expect.any(Array), {
    encoding: 'utf8',
    timeout: 9,
  });
});
it.each([undefined, {}, { frozen: true, released: false, status: 'pending' }])(
  'recovery never accepts unbound state %j',
  (value) => {
    expect(() => Host.h06RecoveryState(request, value)).toThrow();
  },
);
it('recovery requires exact pending ref and refuses released/frozen state', () => {
  const state = {
    ...bound(),
    frozen: false,
    released: false,
    status: 'pending',
    pending: { sha256: '1'.repeat(64), bytes: 1 },
  };
  expect(Host.h06RecoveryState(request, state)).toEqual(state);
  for (const key of ['released', 'frozen'])
    expect(() => Host.h06RecoveryState(request, { ...state, [key]: true })).toThrow(
      'h06-recovery-frozen-released',
    );
});
it('stop status cannot hide a forced signal, deadline or nonzero exit', () => {
  expect(h06Stopped(stop())).toBe(true);
  for (const value of [
    { stopped: false },
    { code: 1 },
    { signal: 'SIGTERM' },
    { killed: true },
    { deadlineReached: true },
  ])
    expect(h06Stopped({ ...stop(), ...value })).toBe(false);
});
function deadline(ms = 180000) {
  return String(process.hrtime.bigint() + BigInt(ms) * 1000000n);
}
function writerMock(
  options: {
    receipt?: ReturnType<typeof stop>;
    observation?: string;
    listener?: object;
    lateWrite?: boolean;
    premature?: boolean;
    error?: boolean;
    readyPid?: number;
  } = {},
) {
  const child = Object.assign(new EventEmitter(), { pid: 202, send: vi.fn() });
  let finish!: (v: ReturnType<typeof stop>) => void,
    alive = true;
  const done = new Promise<ReturnType<typeof stop>>((resolve) => {
    finish = resolve;
  });
  const receipt = options.receipt ?? {
    ...stop([{ pid: 202, ppid: process.pid, pgid: 202, identity: 'unit-writer' }]),
    pids: [202],
    groups: [202],
  };
  const cleanup = vi.fn(async () => {
    alive = false;
    finish(receipt);
    return receipt;
  });
  child.send.mockImplementation(() => {
    alive = false;
    finish(receipt);
  });
  mocks.spawn.mockImplementation(() => {
    writeFileSync(join(request.outputRoot, 'writer.log'), 'unit-write\n');
    queueMicrotask(() => {
      if (options.premature) finish(receipt);
      else if (options.error) child.emit('error', new Error('unit-spawn-error'));
      else child.emit('message', { ready: true, pid: options.readyPid ?? 202 });
    });
    return child;
  });
  mocks.own.mockReturnValue({ done, stop: cleanup });
  mocks.exec.mockImplementation(
    () =>
      options.observation ??
      `${process.pid} 1 ${process.pid} unit-host\n${alive ? '202 ' + process.pid + ' 202 unit-writer\n' : ''}`,
  );
  mocks.sync.mockReturnValue(
    options.listener ?? { status: 1, signal: null, stdout: '', stderr: '' },
  );
  mocks.delay.mockImplementation(async (ms: number) => {
    mocks.now += ms;
    if (options.lateWrite) writeFileSync(join(request.outputRoot, 'writer.log'), 'late');
  });
  return { child, cleanup };
}
it('writes a durable intent/stop receipt for one owned writer and confirms no late writes through mock ports', async () => {
  mkdirSync(request.outputRoot);
  const f = writerMock();
  const writer = await Host.startH06Writer(request, deadline());
  const ref = await writer.stop();
  expect(ref.bytes).toBeGreaterThan(0);
  expect(read('writer-stability.json')).toMatchObject({
    identitiesAbsent: true,
    listenersClosed: true,
    noLateWrite: true,
  });
  expect(f.child.send).toHaveBeenCalledOnce();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  await expect(Host.startH06Writer(request, deadline())).rejects.toThrow('h06-writer-not-new');
  expect(mocks.spawn).toHaveBeenCalledOnce();
});
it.each([
  ['unconfirmed stop', { receipt: { ...stop(), stopped: false } }, 'h06-writer-stop-unknown'],
  [
    'unknown listeners',
    { listener: { status: 1, signal: null, stdout: 'partial', stderr: '' } },
    'h06-listeners-unknown',
  ],
  ['late writes', { lateWrite: true }, 'h06-writer-still-active'],
])('writer refuses %s', async (_name, options, reason) => {
  mkdirSync(request.outputRoot);
  writerMock(options);
  const writer = await Host.startH06Writer(request, deadline());
  await expect(writer.stop()).rejects.toThrow(reason);
});
it('writer cleanup retains the original premature-exit refusal', async () => {
  mkdirSync(request.outputRoot);
  const f = writerMock({ premature: true });
  await expect(Host.startH06Writer(request, deadline())).rejects.toThrow(
    'h06-writer-exited-before-ready',
  );
  expect(f.cleanup).toHaveBeenCalledOnce();
});
it('writer cleanup handles child spawn error', async () => {
  mkdirSync(request.outputRoot);
  const f = writerMock({ error: true });
  await expect(Host.startH06Writer(request, deadline())).rejects.toThrow('unit-spawn-error');
  expect(f.cleanup).toHaveBeenCalledOnce();
});
it('the writer subprocess requires IPC before creating any file', async () => {
  const saved = Object.getOwnPropertyDescriptor(process, 'connected');
  Object.defineProperty(process, 'connected', { configurable: true, value: false });
  try {
    await expect(Host.h06WriterProgram(request, deadline())).rejects.toThrow(
      'h06-writer-owner-required',
    );
  } finally {
    if (saved) Object.defineProperty(process, 'connected', saved);
    else Reflect.deleteProperty(process, 'connected');
  }
});
it.each(['message', 'disconnect', 'deadline', 'owner-already-lost'] as const)(
  'writer releases timers/fd on %s without a real child',
  async (event) => {
    vi.useFakeTimers();
    mkdirSync(request.outputRoot);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'connected'),
      send = Object.getOwnPropertyDescriptor(process, 'send'),
      disconnect = Object.getOwnPropertyDescriptor(process, 'disconnect');
    Object.defineProperty(process, 'connected', { configurable: true, value: true });
    Object.defineProperty(process, 'send', { configurable: true, value: vi.fn() });
    Object.defineProperty(process, 'disconnect', { configurable: true, value: vi.fn() });
    const callbacks = new Map<string | symbol, (...args: unknown[]) => void>();
    vi.spyOn(process, 'once').mockImplementation((name, callback) => {
      callbacks.set(name, callback);
      return process;
    });
    vi.spyOn(process, 'removeListener').mockReturnValue(process);
    try {
      await Host.h06WriterProgram(request, deadline(1000));
      vi.advanceTimersByTime(100);
      if (event === 'deadline') vi.advanceTimersByTime(1000);
      else {
        if (event === 'owner-already-lost')
          Object.defineProperty(process, 'connected', { configurable: true, value: false });
        const callback = callbacks.get(event === 'owner-already-lost' ? 'disconnect' : event)!;
        callback();
        callback();
      }
      expect(process.disconnect).toHaveBeenCalledTimes(event === 'owner-already-lost' ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
      expect(process.exitCode).toBe(event === 'message' ? originalExit : 1);
    } finally {
      for (const [key, value] of [
        ['connected', descriptor],
        ['send', send],
        ['disconnect', disconnect],
      ] as const) {
        if (value) Object.defineProperty(process, key, value);
        else Reflect.deleteProperty(process, key);
      }
    }
  },
);
it('runs legacy lease protocol against the actual Store with injected clocks and no subprocess', async () => {
  mkdirSync(request.outputRoot);
  writeFileSync(join(request.outputRoot, 'F-01.json'), h06Failure(request));
  let wall = 100000;
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  writerMock();
  mocks.delay.mockImplementation(async (ms: number) => {
    mocks.now += ms;
    wall += ms;
  });
  await withIPC(async () => {
    await Host.h06Phase(request, 'initial', null, deadline());
  });
  expect(read('lease.json')).toMatchObject({
    automatic: true,
    before: { lease_until: 120000 },
    renewed: { owner: 'synthetic-human', generation: 1 },
    event: { change: { type: 'renew' } },
  });
  const lease = read('lease.json');
  expect(lease.renewAcceptedAt).toBeLessThan((lease.before as { lease_until: number }).lease_until);
  expect((lease.after as { lease_until: number }).lease_until).toBeGreaterThan(wall);
  await withIPC(async () => {
    await Host.h06Phase(request, 'cold', null, deadline());
  });
  expect(read('cold.json')).toMatchObject({
    dispatches: 0,
    unknownEffectRefused: true,
    frozenReleasedRefused: true,
  });
  expect(mocks.spawn).toHaveBeenCalledOnce();
});
it('Store mutate and read ports refuse wrong owner/generation without a writer launch', () => {
  mkdirSync(request.outputRoot);
  const f = Host.h06Store(request);
  expect(f.mutate({ type: 'claim', lease_until: Date.now() + 1000 }, 999, 0, 'bad')).toMatchObject({
    ok: false,
  });
  expect(mocks.spawn).not.toHaveBeenCalled();
});
async function withIPC(
  body: (callbacks: Map<string | symbol, (...args: unknown[]) => void>) => Promise<void>,
) {
  const keys = ['connected', 'disconnect', 'send'] as const,
    descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(process, key));
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  Object.defineProperty(process, 'disconnect', { configurable: true, value: vi.fn() });
  Object.defineProperty(process, 'send', { configurable: true, value: vi.fn() });
  const callbacks = new Map<string | symbol, (...args: unknown[]) => void>();
  vi.spyOn(process, 'once').mockImplementation((name, fn) => {
    callbacks.set(name, fn);
    return process;
  });
  vi.spyOn(process, 'removeListener').mockReturnValue(process);
  try {
    await body(callbacks);
  } finally {
    keys.forEach((key, i) => {
      const saved = descriptors[i];
      if (saved) Object.defineProperty(process, key, saved);
      else Reflect.deleteProperty(process, key);
    });
  }
}
function phaseMock(
  options: { fail?: boolean; receipt?: ReturnType<typeof stop>; disconnected?: () => void } = {},
) {
  const child = Object.assign(new EventEmitter(), { pid: 333 });
  const cleanup = vi.fn().mockResolvedValue(options.receipt ?? stop());
  mocks.spawn.mockReturnValue(child);
  mocks.own.mockImplementation(() => ({
    done: Promise.resolve().then(async () => {
      options.disconnected?.();
      if (options.fail) throw new Error('unit-owned-failure');
      await completeEffect();
      return options.receipt ?? stop();
    }),
    stop: cleanup,
  }));
  return cleanup;
}
it('phase and keeper enforce owner IPC and original deadline before spawning', async () => {
  await withIPC(async () => {
    mkdirSync(request.outputRoot);
    await expect(Host.h06Keeper(request, '0')).rejects.toThrow('h06-deadline');
    await expect(Host.h06Keeper(request, deadline(181000))).rejects.toThrow('h06-keeper-deadline');
    await expect(Host.runH06Phase(request, 'initial', null, '0')).rejects.toThrow('h06-deadline');
  });
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it.each(['initial', 'cold'] as const)(
  'phase %s persists exact clean receipt after mock process completion',
  async (phase) => {
    await withIPC(async () => {
      mkdirSync(request.outputRoot);
      if (phase === 'cold') await completeEffect();
      phaseMock();
      await Host.runH06Phase(request, phase, null, deadline());
      expect(read(phase + '-stop.json')).toEqual(stop());
    });
  },
);
it('keeper disconnect always stops its owned subprocess and retains refusal', async () => {
  await withIPC(async (callbacks) => {
    mkdirSync(request.outputRoot);
    const cleanup = phaseMock({ fail: true, disconnected: () => callbacks.get('disconnect')?.() });
    await expect(Host.h06Keeper(request, deadline())).rejects.toThrow('unit-owned-failure');
    expect(cleanup).toHaveBeenCalled();
    expect(read('worker-stop.json')).toEqual(stop());
  });
});
it('phase disconnect invokes stop and preserves monitor error', async () => {
  await withIPC(async (callbacks) => {
    mkdirSync(request.outputRoot);
    const cleanup = phaseMock({ fail: true, disconnected: () => callbacks.get('disconnect')?.() });
    await expect(Host.runH06Phase(request, 'initial', null, deadline())).rejects.toThrow(
      'unit-owned-failure',
    );
    expect(cleanup).toHaveBeenCalled();
    expect(read('initial-stop.json')).toEqual(stop());
  });
});
it('keeper rejects unknown stop instead of disconnecting as success', async () => {
  await withIPC(async () => {
    mkdirSync(request.outputRoot);
    phaseMock({ receipt: { ...stop(), stopped: false } });
    await expect(Host.h06Keeper(request, deadline())).rejects.toThrow(
      'h06-operation-stop-unconfirmed',
    );
    expect(process.disconnect).not.toHaveBeenCalled();
  });
});
it('keeper completes only after a clean owned worker stop', async () => {
  await withIPC(async () => {
    mkdirSync(request.outputRoot);
    phaseMock();
    await Host.h06Keeper(request, deadline());
    expect(process.disconnect).toHaveBeenCalledOnce();
  });
});
it('coordinator runs initial then cold once and closes only its own local environment', async () => {
  await withIPC(async () => {
    request.variant = 'temporal';
    request.server = request.node;
    mkdirSync(request.outputRoot);
    phaseMock();
    const teardown = vi.fn();
    mocks.environment.mockResolvedValue({ address: '127.0.0.1:7233', teardown });
    await Host.h06Operation(request, deadline());
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(teardown).toHaveBeenCalledOnce();
    expect(mocks.environment.mock.calls[0]?.[0]).toEqual({
      server: {
        ip: '127.0.0.1',
        ui: false,
        executable: { type: 'existing-path', path: request.node.path },
        dbFilename: join(request.outputRoot, 'temporal.sqlite'),
      },
    });
  });
});
it('coordinator tears down environment after failed first phase and never starts cold', async () => {
  await withIPC(async () => {
    request.variant = 'temporal';
    request.server = request.node;
    mkdirSync(request.outputRoot);
    phaseMock({ fail: true });
    const teardown = vi.fn();
    mocks.environment.mockResolvedValue({ address: '127.0.0.1:7233', teardown });
    await expect(Host.h06Operation(request, deadline())).rejects.toThrow('unit-owned-failure');
    expect(teardown).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
});
it('legacy coordinator never creates a Temporal environment', async () => {
  await withIPC(async () => {
    mkdirSync(request.outputRoot);
    phaseMock();
    await Host.h06Operation(request, deadline());
    expect(mocks.environment).not.toHaveBeenCalled();
  });
});
it('run rejects a fake executable pin before any process spawn', async () => {
  await expect(Host.runH06(request)).rejects.toThrow('h06-actual-node-required');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('run preserves original stop error and creates a stop receipt without inventing PASS', async () => {
  request.node = {
    path: realpathSync(process.execPath),
    sha256: digest(readFileSync(realpathSync(process.execPath))),
  };
  const cleanup = phaseMock({ fail: true });
  await expect(Host.runH06(request)).rejects.toThrow('unit-owned-failure');
  expect(cleanup).toHaveBeenCalledOnce();
  expect(read('stop.json')).toEqual(stop());
  expect(() => read('report.json')).toThrow();
});
it('main validates argument counts and never interprets unknown commands as run', async () => {
  const config = join(temp, 'request.json');
  writeFileSync(config, JSON.stringify(request));
  expect(await Host.h06Main(['--plan', config])).toMatchObject({ mayRun: false });
  await expect(Host.h06Main([])).rejects.toThrow('h06-arguments');
  await expect(Host.h06Main(['--unknown', config, deadline()])).rejects.toThrow('h06-arguments');
  await expect(Host.h06Main(['--plan', config, 'extra'])).rejects.toThrow('h06-arguments');
  await fixture();
  expect(await Host.h06Main(['--check', config])).toMatchObject({
    modelFree: 'PASS',
    qualification: false,
  });
  await expect(Host.h06Main(['--run', config])).rejects.toThrow('h06-actual-node-required');
});
function sdkMock() {
  const native = { close: vi.fn() },
    connection = { close: vi.fn() },
    fresh = { close: vi.fn() };
  mocks.nativeConnect.mockResolvedValue(native);
  mocks.connect.mockResolvedValue(connection);
  let input: ManagedTaskInput,
    workflowId = '',
    command: unknown,
    ack: unknown,
    activityDone: Promise<unknown> | undefined;
  let held: ArtifactRef,
    activities: Record<string, (...args: unknown[]) => Promise<unknown>> = {},
    controls: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const workers: { shutdown: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> }[] = [];
  mocks.factory.mockImplementation((f: UnitFixture) => {
    input = f.initial;
    held = artifactStore(join(request.outputRoot, 'sdk-fixture', 'artifacts')).publish(
      Buffer.from(canonical({ syntheticHeld: true, input: f.initial })),
    );
    let drain!: () => void;
    f.activities.writeLocalTask = async () => {
      f.state.writers.push(0);
      f.state.active.add('writer');
      return await new Promise((resolve) => {
        drain = () => {
          f.state.active.clear();
          resolve({});
        };
      });
    };
    f.controls.stopLocalTask = async () => {
      f.state.stopConfirmed = true;
      drain();
      return publish({ stop: true });
    };
  });
  mocks.create.mockImplementation(
    async (options: {
      taskQueue: string;
      activities: Record<string, (...args: unknown[]) => Promise<unknown>>;
    }) => {
      if (options.taskQueue.endsWith('.control')) controls = options.activities;
      else activities = options.activities;
      const worker = { shutdown: vi.fn(), run: vi.fn().mockResolvedValue(undefined) };
      workers.push(worker);
      return worker;
    },
  );
  const query = vi.fn(async (name: string) =>
    name === 'localTaskInput' ? input : { waiting: true, held, runId: 'run-1' },
  );
  const handle = {
    workflowId,
    query,
    describe: vi.fn(async () => ({ runId: 'run-1' })),
    fetchHistory: vi.fn(async () => historyFromJSON(history(input, held))),
    executeUpdate: vi.fn(
      async (
        _name: string,
        options: { args: [{ commandId: string; hash: string; expectedRevision: number }] },
      ) => {
        const value = options.args[0];
        if (controls.findTaskExecutionCommand && !controls.stopLocalTask)
          return await controls.findTaskExecutionCommand(input, value);
        if (ack === undefined) {
          command = value;
          await controls.stopLocalTask!();
          await activityDone;
          ack = {
            commandId: value.commandId,
            hash: value.hash,
            revision: value.expectedRevision + 1,
            authorization: publish({ command: 'pause' }),
          };
          write('sdk-fixture/synthetic-command-journal.json', [{ command, ack }]);
        }
        return ack;
      },
    ),
  };
  const start = vi.fn(
    async (_type: string, options: { workflowId: string; args: [ManagedTaskInput] }) => {
      input = options.args[0];
      workflowId = options.workflowId;
      handle.workflowId = workflowId;
      activityDone = activities.writeLocalTask!(input);
      return handle;
    },
  );
  mocks.client = { workflow: { start, getHandle: vi.fn(() => handle) } };
  mocks.replay.mockResolvedValue(undefined);
  return {
    native,
    connection,
    fresh,
    handle,
    start,
    workers,
    get input() {
      return input;
    },
    get held() {
      return held;
    },
    get activities() {
      return activities;
    },
    get controls() {
      return controls;
    },
  };
}
it('drains writer, replaces main worker and reopens same workflow with mock SDK ports, never a native RESUME', async () => {
  request.variant = 'temporal';
  request.server = request.node;
  mkdirSync(request.outputRoot);
  writeFileSync(join(request.outputRoot, 'F-01.json'), h06Failure(request));
  writerMock();
  const sdk = sdkMock();
  await withIPC(async () => {
    await Host.h06Phase(request, 'initial', { address: '127.0.0.1:7233' }, deadline());
  });
  expect(read('initial.json')).toMatchObject({
    writerDrained: true,
    sameEnvironment: { oldWorkerDrained: true, distinctWorker: true, freshClient: true },
  });
  expect(sdk.start).toHaveBeenCalledOnce();
  expect(sdk.workers).toHaveLength(3);
  expect(sdk.workers.every((w) => w.shutdown.mock.calls.length === 1)).toBe(true);
  await Host.h06TemporalPhase(request, 'cold', '127.0.0.1:7233', deadline());
  expect(read('cold.json')).toMatchObject({
    dispatches: 0,
    freshClient: true,
    frozenReleasedRefused: true,
    unknownEffectRefused: true,
  });
  expect(sdk.start).toHaveBeenCalledOnce();
  expect(mocks.replay).toHaveBeenCalledWith(
    expect.any(Object),
    expect.any(Object),
    sdk.handle.workflowId,
  );
  await expect(sdk.activities.writeLocalTask!()).rejects.toThrow('h06-cold-dispatch-forbidden');
  await expect(
    sdk.controls.findTaskExecutionCommand!(sdk.input, { commandId: 'foreign' }),
  ).rejects.toThrow('h06-cold-command-unconfirmed');
});
it('rejects nonloopback SDK address before any connection', async () => {
  await expect(
    Host.h06TemporalPhase(request, 'initial', 'foreign:7233', deadline()),
  ).rejects.toThrow('h06-backend-address');
  expect(mocks.nativeConnect).not.toHaveBeenCalled();
});
it('closes native connection if public client connection fails during setup', async () => {
  const sdk = sdkMock();
  mocks.connect.mockRejectedValue(new Error('connect-refused'));
  await expect(
    Host.h06TemporalPhase(request, 'initial', '127.0.0.1:7233', deadline()),
  ).rejects.toThrow('connect-refused');
  expect(sdk.native.close).toHaveBeenCalledOnce();
});
it('refusal probe reports both valid and rejected states without inventing native authority', () => {
  const state = {
    ...bound(),
    frozen: false,
    released: false,
    status: 'pending',
    pending: { sha256: '1'.repeat(64), bytes: 1 },
  };
  expect(Host.h06RecoveryRefused(request, state)).toBe(false);
  expect(Host.h06RecoveryRefused(request, undefined)).toBe(true);
  expect(Host.h06Refusals(request, state)).toEqual({
    frozenReleasedRefused: true,
    unknownEffectRefused: true,
  });
});
it('full parent run can accept only scoped local PASS while native remains UNKNOWN', async () => {
  request.node = {
    path: realpathSync(process.execPath),
    sha256: digest(readFileSync(realpathSync(process.execPath))),
  };
  mocks.spawn.mockReturnValue({ pid: 401 });
  mocks.own.mockImplementation(() => ({
    done: Promise.resolve().then(async () => {
      await fixture('legacy', true, true);
      return stop();
    }),
    stop: vi.fn(),
  }));
  const report = await Host.runH06(request);
  expect(report).toMatchObject({ modelFree: 'PASS', qualification: false, outcome: 'UNKNOWN' });
  expect(read('report.json')).toEqual(report);
  expect(mocks.spawn).toHaveBeenCalledOnce();
});
it('signals stop the currently owned parent child; uncertain stop remains UNKNOWN', async () => {
  request.node = {
    path: realpathSync(process.execPath),
    sha256: digest(readFileSync(realpathSync(process.execPath))),
  };
  await withIPC(async (callbacks) => {
    const cleanup = vi.fn().mockResolvedValue({ ...stop(), stopped: false });
    mocks.spawn.mockReturnValue({ pid: 402 });
    mocks.own.mockImplementation(() => ({
      done: Promise.resolve().then(() => {
        callbacks.get('SIGTERM')?.();
        return { ...stop(), stopped: false };
      }),
      stop: cleanup,
    }));
    await expect(Host.runH06(request)).rejects.toThrow('h06-cancelled');
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
it('main worker subcommands require IPC rather than starting unowned work', async () => {
  const config = join(temp, 'request.json');
  writeFileSync(config, JSON.stringify(request));
  const saved = Object.getOwnPropertyDescriptor(process, 'connected');
  Object.defineProperty(process, 'connected', { configurable: true, value: false });
  try {
    for (const command of ['--worker', '--operation', '--writer'])
      await expect(Host.h06Main([command, config, deadline()])).rejects.toThrow('owner-required');
  } finally {
    if (saved) Object.defineProperty(process, 'connected', saved);
    else Reflect.deleteProperty(process, 'connected');
  }
});
it('main phase reads its exact backend pin but refuses a nonloopback address before connect', async () => {
  request.variant = 'temporal';
  request.server = request.node;
  const config = join(temp, 'request.json'),
    backend = join(temp, 'backend.json');
  writeFileSync(config, JSON.stringify(request));
  writeFileSync(backend, '{"address":"foreign:1"}');
  const pin = { path: backend, sha256: digest(readFileSync(backend)) };
  await withIPC(async () => {
    await expect(
      Host.h06Main(['--phase', config, 'initial', JSON.stringify(pin), deadline()]),
    ).rejects.toThrow('h06-backend-address');
  });
  expect(mocks.connect).not.toHaveBeenCalled();
});
it.each([false, true])(
  'entrypoint explicitly emits a plan or error, without starting a child: %s',
  async (failed) => {
    const oldArgs = process.argv,
      config = join(temp, 'entry.json');
    writeFileSync(config, JSON.stringify(request));
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true),
      stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.argv = [
      process.execPath,
      fileURLToPath(new URL('./comparisonH06.ts', import.meta.url)),
      failed ? '--bad' : '--plan',
      config,
    ];
    vi.resetModules();
    try {
      await import('./comparisonH06.js');
      await vi.waitFor(() => expect(failed ? stderr : stdout).toHaveBeenCalled());
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally {
      process.argv = oldArgs;
    }
  },
);
it.each(['status-before.json', 'status-after.json'])(
  'requires exact SDK query identity %s',
  async (name) => {
    await fixture('temporal');
    update(name, (v) => {
      v.runId = 'foreign';
    });
    expect(() => checkH06(request)).toThrow('h06-query-binding');
  },
);
it('binds held checkpoint to the exact completed Activity result', async () => {
  await fixture('temporal');
  const hist = read('history-after.json');
  const events = hist.events as Record<string, unknown>[];
  const completion = events[3]!;
  completion.activityTaskCompletedEventAttributes = {
    scheduledEventId: '3',
    result: payload({ status: 'held', held: publish({ foreign: true }) }),
  };
  write('history-after.json', hist);
  expect(() => checkH06(request)).toThrow('h06-history-prefix');
  write('history-before.json', hist);
  expect(() => checkH06(request)).toThrow('h06-hold-result');
});
it('refuses duplicate writer Activity scheduling even with otherwise matching SDK prefix', async () => {
  await fixture('temporal');
  update('history-after.json', (v) => {
    const events = v.events as Record<string, unknown>[];
    events.push({ ...events[1], eventId: '5' });
  });
  expect(() => checkH06(request)).toThrow('h06-duplicate-workflow-writer');
});
it('requires exact started Workflow input instead of a history from a foreign operation', async () => {
  await fixture('temporal');
  const hist = read('history-before.json');
  (hist.events as Record<string, unknown>[])[0]!.workflowExecutionStartedEventAttributes = {
    workflowType: { name: 'LocalTaskWorkflow' },
    originalExecutionRunId: 'foreign',
    input: payload(read('workflow-input.json')),
  };
  write('history-before.json', hist);
  expect(() => checkH06(request)).toThrow('h06-workflow-input');
});
it('main worker success returns null only after a persisted clean stop', async () => {
  const config = join(temp, 'request.json');
  writeFileSync(config, JSON.stringify(request));
  mkdirSync(request.outputRoot);
  await withIPC(async () => {
    phaseMock();
    expect(await Host.h06Main(['--worker', config, deadline()])).toBeNull();
    expect(read('worker-stop.json')).toEqual(stop());
  });
});
async function completeEffect(receipt: unknown = stop()) {
  if (!FS.existsSync(join(request.outputRoot, 'initial.json'))) {
    const input =
      request.variant === 'temporal' ? (await Host.createH06Fixture(request)).initial : null;
    if (input) write('workflow-input.json', input);
    const checkpoint =
      request.variant === 'legacy'
        ? publish({ inputHash: h06Hash(request), unfinished: request.operationId })
        : artifactStore(join(request.outputRoot, 'sdk-fixture', 'artifacts')).publish(
            Buffer.from(canonical({ syntheticHeld: true, input })),
          );
    const pending = publish({
      ...bound(),
      kind: 'h06-pending-operation',
      operationId: request.operationId,
      status: 'pending',
      effectIdentity: h06Intent(request),
      checkpoint,
    });
    write('initial.json', { pending });
  }
  return await Effects.effectJournal(join(request.outputRoot, 'effects')).execute(
    h06Intent(request),
    async () => publish({ inputHash: h06Hash(request), receipt }),
  );
}
it('cold recovery refuses missing/pending effects before any SDK acquisition', async () => {
  mkdirSync(request.outputRoot);
  mkdirSync(join(request.outputRoot, 'effects'));
  await expect(
    Host.h06TemporalPhase(request, 'cold', '127.0.0.1:7233', deadline()),
  ).rejects.toThrow('h06-pending-effect-refuses-recovery');
  expect(mocks.nativeConnect).not.toHaveBeenCalled();
  await expect(
    Effects.effectJournal(join(request.outputRoot, 'effects')).execute(
      h06Intent(request),
      async () => {
        throw new Error('lost stop');
      },
    ),
  ).rejects.toThrow('lost stop');
  expect(() => Host.h06ConfirmRecoveryEffect(request)).toThrow(
    'h06-pending-effect-refuses-recovery',
  );
});
it('cold recovery rejects a completed effect with an unconfirmed physical stop', async () => {
  mkdirSync(request.outputRoot);
  await completeEffect({ ...stop(), stopped: false });
  expect(() => Host.h06ConfirmRecoveryEffect(request)).toThrow('h06-recovery-stop-unconfirmed');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('cleanup/drain have a bounded held-promise timeout and require an actual run promise', async () => {
  vi.useFakeTimers();
  const worker = { shutdown: vi.fn() };
  await expect(Host.h06DrainWorker(worker, undefined, deadline())).rejects.toThrow(
    'h06-worker-run-missing',
  );
  expect(worker.shutdown).toHaveBeenCalledOnce();
  const cleanup = Host.h06CleanupAwait(new Promise<void>(() => {}), deadline());
  const rejected = expect(cleanup).rejects.toThrow('h06-sdk-cleanup-unknown');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  await expect(Host.h06CleanupAwait(new Promise<void>(() => {}), '0')).rejects.toThrow(
    'h06-deadline',
  );
});
it('SDK cleanup closes all acquired connections after early worker construction failure', async () => {
  mkdirSync(request.outputRoot);
  const sdk = sdkMock();
  mocks.create.mockRejectedValueOnce(new Error('worker-create-refused'));
  await expect(
    Host.h06TemporalPhase(request, 'initial', '127.0.0.1:7233', deadline()),
  ).rejects.toThrow('worker-create-refused');
  expect(sdk.connection.close).toHaveBeenCalledOnce();
  expect(sdk.native.close).toHaveBeenCalledOnce();
});
it('the SDK fixture activity context is explicit and injectable without an SDK Activity', async () => {
  mkdirSync(request.outputRoot);
  await Host.createH06Fixture(request);
  expect(typeof mocks.fixtureContext).toBe('function');
  expect(
    typeof object(Reflect.apply(mocks.fixtureContext as () => unknown, undefined, [])).heartbeat,
  ).toBe('function');
});
it('SDK run rejection is observed and all independently acquired workers/connections close', async () => {
  request.variant = 'temporal';
  request.server = request.node;
  mkdirSync(request.outputRoot);
  writerMock();
  const sdk = sdkMock(),
    create = mocks.create.getMockImplementation()!;
  mocks.create.mockImplementation(async (...args: unknown[]) => {
    const worker = (await Reflect.apply(create, undefined, args)) as {
      run: ReturnType<typeof vi.fn>;
    };
    worker.run.mockRejectedValue(new Error('worker-run-refused'));
    return worker;
  });
  await withIPC(async () => {
    await expect(
      Host.h06TemporalPhase(request, 'initial', '127.0.0.1:7233', deadline()),
    ).rejects.toThrow('worker-run-refused');
  });
  expect(sdk.connection.close).toHaveBeenCalledOnce();
  expect(sdk.native.close).toHaveBeenCalledOnce();
});
it('a foreign writer ready PID rejects the promise and cleans up without unhandled error', async () => {
  mkdirSync(request.outputRoot);
  const f = writerMock({ readyPid: 999 });
  await expect(Host.startH06Writer(request, deadline())).rejects.toThrow('h06-writer-ready');
  expect(f.cleanup).toHaveBeenCalledOnce();
});
it.each([3, 4, 5])(
  'observes rejected replacement/cold Worker.run %s and closes all acquired clients',
  async (rejectedWorker) => {
    request.variant = 'temporal';
    request.server = request.node;
    mkdirSync(request.outputRoot);
    writerMock();
    const sdk = sdkMock(),
      create = mocks.create.getMockImplementation()!;
    let index = 0;
    mocks.create.mockImplementation(async (...args: unknown[]) => {
      const worker = (await Reflect.apply(create, undefined, args)) as {
        run: ReturnType<typeof vi.fn>;
      };
      if (++index === rejectedWorker)
        worker.run.mockRejectedValue(new Error('worker-run-' + index));
      return worker;
    });
    await withIPC(async () => {
      if (rejectedWorker === 3)
        await expect(
          Host.h06TemporalPhase(request, 'initial', '127.0.0.1:7233', deadline()),
        ).rejects.toThrow('worker-run-3');
      else {
        await Host.h06TemporalPhase(request, 'initial', '127.0.0.1:7233', deadline());
        await expect(
          Host.h06TemporalPhase(request, 'cold', '127.0.0.1:7233', deadline()),
        ).rejects.toThrow('worker-run-' + rejectedWorker);
      }
    });
    expect(sdk.native.close).toHaveBeenCalled();
    expect(sdk.connection.close).toHaveBeenCalled();
  },
);
it('owner loss during final SDK close never emits a successful IPC disconnect or dispatches again', async () => {
  request.variant = 'temporal';
  request.server = request.node;
  mkdirSync(request.outputRoot);
  writerMock();
  const sdk = sdkMock();
  await withIPC(async () => {
    sdk.native.close.mockImplementation(() =>
      Object.defineProperty(process, 'connected', { configurable: true, value: false }),
    );
    await Host.h06Phase(request, 'initial', { address: '127.0.0.1:7233' }, deadline());
    expect(process.disconnect).not.toHaveBeenCalled();
  });
  expect(sdk.start).toHaveBeenCalledOnce();
});
it('owner loss while tearing down the sole backend cannot signal a successful coordinator disconnect', async () => {
  request.variant = 'temporal';
  request.server = request.node;
  mkdirSync(request.outputRoot);
  phaseMock();
  await withIPC(async () => {
    mocks.environment.mockResolvedValue({
      address: '127.0.0.1:7233',
      teardown: vi.fn(async () => {
        Object.defineProperty(process, 'connected', { configurable: true, value: false });
      }),
    });
    await Host.h06Operation(request, deadline());
    expect(process.disconnect).not.toHaveBeenCalled();
  });
});
it('main accepts cold phase syntax only with its exact backend pin', async () => {
  const config = join(temp, 'request.json'),
    backend = join(temp, 'backend.json');
  writeFileSync(config, JSON.stringify(request));
  writeFileSync(backend, 'null');
  const pin = { path: backend, sha256: digest(readFileSync(backend)) };
  await withIPC(async () => {
    Object.defineProperty(process, 'connected', { configurable: true, value: false });
    await expect(
      Host.h06Main(['--phase', config, 'cold', JSON.stringify(pin), deadline()]),
    ).rejects.toThrow('h06-phase-owner-required');
  });
});
it.each(['expired', 'over-budget', 'nonfinite', 'missing-IPC'] as const)(
  'writer admission refuses %s before opening file, timer or effect intent',
  async (kind) => {
    mkdirSync(request.outputRoot);
    vi.useFakeTimers();
    await withIPC(async () => {
      if (kind === 'missing-IPC')
        Object.defineProperty(process, 'connected', { configurable: true, value: false });
      const bound =
        kind === 'expired'
          ? '0'
          : kind === 'over-budget'
            ? deadline(181000)
            : kind === 'nonfinite'
              ? '1' + '0'.repeat(400)
              : deadline();
      await expect(Host.h06WriterProgram(request, bound)).rejects.toThrow();
      await expect(Host.startH06Writer(request, bound)).rejects.toThrow();
      expect(readdirSync(request.outputRoot)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.own).not.toHaveBeenCalled();
      expect(process.send).not.toHaveBeenCalled();
    });
  },
);
it('writer dispatch refuses an exhausted stop reserve before creating an effect journal', async () => {
  mkdirSync(request.outputRoot);
  await withIPC(async () => {
    await expect(Host.startH06Writer(request, deadline(29000))).rejects.toThrow('h06-deadline');
  });
  expect(readdirSync(request.outputRoot)).toEqual([]);
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it.each([
  undefined,
  {},
  { oldWorkerDrained: false, distinctWorker: true, freshClient: true },
  { oldWorkerDrained: true, distinctWorker: false, freshClient: true },
  { oldWorkerDrained: true, distinctWorker: true, freshClient: false },
])('missing or false same-environment proof cannot qualify %j', async (value) => {
  await fixture('temporal');
  initial.sameEnvironment = value;
  write('initial.json', initial);
  expect(() => checkH06(request)).toThrow();
});
it.each(['pending', 'inputHash'] as const)(
  'warm descriptor binds exact %s instead of an unrelated warm observation',
  async (field) => {
    await fixture('temporal');
    const warm = {
      ...(initial.sameEnvironment as object),
      [field]: field === 'pending' ? publish({ unrelated: true }) : 'f'.repeat(64),
    };
    write('initial.json', { ...initial, sameEnvironment: warm });
    expect(() => checkH06(request)).toThrow('h06-warm-recovery');
  },
);
it('synchronous IPC ready-send failure closes writer fd and timers while retaining original error', async () => {
  vi.useFakeTimers();
  mkdirSync(request.outputRoot);
  await withIPC(async () => {
    const failure = new Error('unit-ERR_IPC_CHANNEL_CLOSED');
    vi.mocked(process.send!).mockImplementation(() => {
      throw failure;
    });
    const close = vi.mocked(FS.closeSync);
    close.mockClear();
    await expect(Host.h06WriterProgram(request, deadline())).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    const fd: unknown = vi.mocked(FS.openSync).mock.results.at(-1)?.value;
    if (typeof fd !== 'number') throw new Error('unit writer fd missing');
    expect(() => FS.fstatSync(fd)).toThrow(/EBADF/);
    expect(process.exitCode).toBe(1);
    expect(process.disconnect).toHaveBeenCalledOnce();
  });
});
function checkpointPath(variant: H06Request['variant']) {
  const ref = initial.pending as ArtifactRef;
  const body = JSON.parse(
    readFileSync(join(request.outputRoot, 'artifacts', ref.sha256), 'utf8'),
  ) as { checkpoint: ArtifactRef };
  return join(
    request.outputRoot,
    ...(variant === 'legacy' ? ['artifacts'] : ['sdk-fixture', 'artifacts']),
    body.checkpoint.sha256,
  );
}
it.each(['legacy', 'temporal'] as const)(
  'missing %s checkpoint bytes refuse checker and cold SDK acquisition',
  async (variant) => {
    await fixture(variant);
    rmSync(checkpointPath(variant));
    expect(() => checkH06(request)).toThrow();
    await expect(
      Host.h06TemporalPhase(request, 'cold', '127.0.0.1:7233', deadline()),
    ).rejects.toThrow();
    expect(mocks.nativeConnect).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
);
it.each(['legacy', 'temporal'] as const)(
  'corrupt %s checkpoint bytes cannot become successful recovery',
  async (variant) => {
    await fixture(variant);
    writeFileSync(checkpointPath(variant), 'corrupt');
    expect(() => checkH06(request)).toThrow();
    expect(() => Host.h06ConfirmRecoveryEffect(request)).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
);
it.each(['legacy', 'temporal'] as const)(
  'foreign but hash-valid %s checkpoint body is refused before cold connect',
  async (variant) => {
    await fixture(variant);
    const pending = initial.pending as ArtifactRef,
      body = object(
        JSON.parse(readFileSync(join(request.outputRoot, 'artifacts', pending.sha256), 'utf8')),
      );
    const bytes = Buffer.from(
      canonical(
        variant === 'legacy'
          ? { inputHash: h06Hash(request), unfinished: 'foreign' }
          : { syntheticHeld: true, input: { foreign: true } },
      ),
    );
    const checkpoint = artifactStore(
      join(
        request.outputRoot,
        ...(variant === 'legacy' ? ['artifacts'] : ['sdk-fixture', 'artifacts']),
      ),
    ).publish(bytes);
    const replacement = publish({ ...body, checkpoint });
    initial.pending = replacement;
    write('initial.json', initial);
    expect(() => Host.h06ConfirmRecoveryEffect(request)).toThrow('h06-' + variant + '-checkpoint');
    await expect(
      Host.h06TemporalPhase(request, 'cold', '127.0.0.1:7233', deadline()),
    ).rejects.toThrow('h06-' + variant + '-checkpoint');
    expect(mocks.nativeConnect).not.toHaveBeenCalled();
  },
);
