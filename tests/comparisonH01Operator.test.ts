import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import type * as Processes from 'node:child_process';
import { createConnection } from 'node:net';
import type * as Net from 'node:net';
import { EventEmitter } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { object, type Procedure } from '../core/connection.js';
import { AssignmentLocalRuns } from '../adapters/storage/localRunStores.js';
import {
  readComparisonUsage,
  type ComparisonParticipant,
} from '../adapters/codex/comparisonUsage.js';
import { effectJournal } from '../src/adapters/artifacts/effects.js';
import { h04BoundIntent } from './comparisonH04Contract.js';
import { defaultPayloadConverter } from '@temporalio/common';
import { payloadToJSON } from '@temporalio/common/proto-utils';
import {
  h04NativeBinding,
  h04NativeLaunchCode,
  h04NativeWaitingCode,
  h04NativeWaitCommand,
  verifyH04NativeWait,
  type H04NativeCaseReport,
  type H04NativeOperationRequest,
} from './comparisonH04NativeContract.js';
import { ownProcess } from '../examples/temporal-consumers/full/safety.mjs';
import type * as Safety from '../examples/temporal-consumers/full/safety.mjs';
import {
  applyLocalEvent,
  startLocalRun,
  type InputRef,
  type LocalRun,
  type LocalEvent,
  type RunSpec,
} from '../core/localRun.js';
import {
  h05ProbeIds,
  h05Procedures,
  h05PreparedMetadata,
  h05Material,
  verifyH05Primary,
  type H05CaseReport,
  type H05Binding,
} from './comparisonH05Contract.js';
import * as h05Temporal from './comparisonH05Temporal.js';
import {
  h01ReadJson,
  parseH01Profile,
  h01Record,
  h01RequestHash,
  observeH01Authorization,
  comparisonKind,
  comparisonEntrypoint,
  requestScenario,
} from './comparisonH01Contract.js';
import type * as Contract from './comparisonH01Contract.js';
import type { H01ExecutionRequest, H01VerifiedAuthorization } from './comparisonH01Contract.js';
import type { H01OperatorSpec } from './comparisonH01Preparation.js';
import { h01OperatorMain, planH01Operator, runH01Operator } from './comparisonH01Operator.js';
import { h02OperatorMain } from './comparisonH02Operator.js';
import { h03OperatorMain } from './comparisonH03Operator.js';
import { verifyH01Runtime } from './comparisonH01.js';
import * as operatorModule from './comparisonH01Operator.js';
import * as h06OperatorModule from './comparisonH06Operator.js';
import { h06Assets, h06Checks } from './comparisonH06Contract.js';
import * as seriesEvidenceModule from './comparisonH01SeriesEvidence.js';
import {
  h01SeriesMain,
  planH01Series,
  reconcileH01Series,
  stepH01Series,
  statusH01Series,
} from './comparisonH01Series.js';
import { checkComparisonReadiness } from './comparisonReadiness.js';
import { comparisonSchedule, parseComparisonSuite } from '../core/comparison.js';

vi.mock('node:child_process', async (load) => ({
  ...(await load<typeof Processes>()),
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock('node:net', async (load) => ({
  ...(await load<typeof Net>()),
  createConnection: vi.fn(),
}));
vi.mock('../examples/temporal-consumers/full/safety.mjs', async (load) => ({
  ...(await load<typeof Safety>()),
  ownProcess: vi.fn(),
}));
vi.mock('./comparisonH01Contract.js', async (load) => ({
  ...(await load<typeof Contract>()),
  observeH01Authorization: vi.fn(),
}));
vi.mock('./comparisonH01.js', () => ({ verifyH01Runtime: vi.fn(), planH01: vi.fn() }));
vi.mock('./comparisonReadiness.js', () => ({ checkComparisonReadiness: vi.fn() }));

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootNames = [
  'workspaceRoot',
  'stateRoot',
  'evidenceRoot',
  'artifactRoot',
  'hostRoot',
] as const;
const temporary: string[] = [];
const actualNodePath = process.execPath;
let now = 10_000_000_000n;
let active: ReturnType<typeof fixture>;
let listening = false;
let serverPid = 0;
let probeFailure: string | undefined;
let socketTimeout = false;
let preOpen = false;
let keepOpen = false;
let listenerPid: number | undefined;
let notReady = 0;
let effect: (() => void) | undefined;
let stopError = false;
let stopped = true;
let killed = false;
let serverKilled = false;
let serverExit = false;
let hangChild = false;
let code = 0;
let childResult: 'accepted' | 'failed' | 'unknown' = 'accepted';
let resultTransform: ((value: Record<string, unknown>) => void) | undefined;
let deliveryTransform: ((value: Record<string, unknown>) => void) | undefined;
let badExport = false;
let noEvidence = false;
let signal: NodeJS.Signals | null = null;
let rejectedOwner = false;
let synchronousStopError = false;
let noPid = false;
let badServerStop = false;

beforeEach(() => {
  now = 10_000_000_000n;
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => now);
  listening = false;
  serverPid = 0;
  probeFailure = undefined;
  socketTimeout = false;
  preOpen = false;
  keepOpen = false;
  listenerPid = undefined;
  notReady = 0;
  effect = undefined;
  stopError = false;
  stopped = true;
  killed = false;
  serverKilled = false;
  serverExit = false;
  hangChild = false;
  code = 0;
  childResult = 'accepted';
  resultTransform = undefined;
  deliveryTransform = undefined;
  badExport = false;
  noEvidence = false;
  signal = null;
  rejectedOwner = false;
  synchronousStopError = false;
  noPid = false;
  badServerStop = false;
  vi.mocked(observeH01Authorization)
    .mockReset()
    .mockImplementation(async () => {
      if (vi.mocked(observeH01Authorization).mock.calls.length === 1) {
        expect(existsSync(active.runBase)).toBe(false);
        effect?.();
      }
      return {
        kind: 'comparison-h01-authorization-observation',
      } as H01VerifiedAuthorization;
    });
  vi.mocked(verifyH01Runtime)
    .mockReset()
    .mockImplementation(async () => ({
      engine: active.request.variant === 'baseline' ? 'legacy' : 'temporal',
      root: runtimeRoot,
      files: [],
    }));
  vi.mocked(createConnection)
    .mockReset()
    .mockImplementation(() => {
      const socket = new EventEmitter();
      Object.assign(socket, {
        destroy: vi.fn(),
        setTimeout(_ms: number, timeout: () => void) {
          if (socketTimeout) queueMicrotask(timeout);
          return socket;
        },
      });
      queueMicrotask(() => {
        if (socketTimeout) return;
        if (probeFailure)
          socket.emit('error', Object.assign(new Error('probe'), { code: probeFailure }));
        else if (preOpen || (listening && notReady-- <= 0)) socket.emit('connect');
        else socket.emit('error', Object.assign(new Error('closed'), { code: 'ECONNREFUSED' }));
      });
      return socket as Net.Socket;
    });
  vi.mocked(execFileSync)
    .mockReset()
    .mockImplementation(() => String(listenerPid ?? serverPid));
  vi.mocked(spawn)
    .mockReset()
    .mockImplementation((_binary, args, options) => {
      const name = args![0] === 'server' ? 'server' : 'h01';
      const child = Object.assign(new EventEmitter(), {
        pid: noPid ? undefined : 900 + vi.mocked(spawn).mock.calls.length,
        exitCode: name === 'h01' && !hangChild ? code : serverExit ? 1 : null,
        signalCode: signal,
      });
      if (name === 'server') {
        serverPid = child.pid ?? 0;
        listening = true;
        writeFileSync(
          active.spec.temporal!.sqlitePath,
          'synthetic server data; never opened as SQLite',
        );
      } else if (!noEvidence) {
        for (const name of rootNames) mkdirSync(active.request.roots[name], { mode: 0o700 });
        const inner = active.request.roots.evidenceRoot;
        mkdirSync(join(inner, 'nested'));
        writeFileSync(
          join(inner, 'nested/raw.snapshot'),
          'ID=H01; hash=retained; FAIL; findings; Result',
        );
        if (badExport) symlinkSync(active.node.locator, join(inner, 'bad-link'));
        const value: Record<string, unknown> = {
          kind: comparisonKind(requestScenario(active.request), 'owned-report'),
          executionVersion: 2,
          opId: active.request.opId,
          requestHash: h01RequestHash(active.request),
          variant: active.request.variant,
          outcome: childResult,
          partialScope: true,
          qualification: false,
          accounting: {
            unknown: false,
            reservedManagedStarts: 2,
            observedResponses: 2,
            inputUncached: 10,
            inputCached: 2,
            output: 3,
          },
        };
        resultTransform?.(value);
        const report = h01Record(inner, 'owned-result', value);
        const stdio = options!.stdio as ['ignore', number, number];
        const delivered = { ...value, report };
        deliveryTransform?.(delivered);
        writeSync(stdio[1], JSON.stringify(delivered));
      }
      return child as ChildProcess;
    });
  vi.mocked(ownProcess)
    .mockReset()
    .mockImplementation((child, options) => {
      expect(options.now!()).toBe(Number(now / 1_000_000n));
      const isServer = child.pid === serverPid;
      const receipt = () => ({
        stopped: stopped && child.pid !== undefined,
        code: isServer ? (badServerStop ? 1 : 0) : code,
        signal: isServer ? (badServerStop ? null : ('SIGTERM' as const)) : signal,
        killed: killed || (isServer && serverKilled),
        deadlineReached: false,
        pids: child.pid === undefined ? [] : [child.pid],
        identities: [],
        groups: child.pid === undefined ? [] : [child.pid],
        retired: [],
        retiredGroups: [],
      });
      let finish: (value: ReturnType<typeof receipt>) => void = () => {};
      const done = rejectedOwner
        ? Promise.reject(new Error('observer lost'))
        : isServer || hangChild
          ? new Promise<ReturnType<typeof receipt>>((done) => {
              finish = done;
            })
          : Promise.resolve(receipt());
      return {
        child,
        done,
        stop() {
          if (synchronousStopError) throw new Error('synchronous stop unknown');
          if (stopError) return Promise.reject(new Error('stop unknown'));
          if (isServer && !keepOpen) listening = false;
          finish(receipt());
          return done;
        },
      };
    });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
  process.execPath = actualNodePath;
});

function fixture(candidate = false, scenario: 'H-01' | 'H-02' | 'H-03' | 'H-04' | 'H-05' = 'H-01') {
  mkdirSync(join(runtimeRoot, 'tmp'), { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'h01-op-unit-')));
  const input = realpathSync(mkdtempSync(join(runtimeRoot, 'tmp/h01-op-input-')));
  temporary.push(root, input);
  const pin = (name: string, bytes: string): InputRef => {
    const path = join(input, name);
    writeFileSync(path, bytes, { mode: 0o600 });
    return { locator: path, hash: digest(bytes) };
  };
  const runBase = join(root, 'attempt');
  const node = pin('node', 'fake Node; provider double only');
  chmodSync(node.locator, 0o700);
  process.execPath = node.locator;
  const common = join(runtimeRoot, comparisonEntrypoint(scenario));
  const operator = join(runtimeRoot, 'tests/comparisonH01Operator.ts');
  const ref = (path: string) => ({
    locator: path,
    hash: digest(readFileSync(path)),
  });
  const roots = {
    workspaceRoot: join(runBase, 'writer/workspace'),
    stateRoot: join(runBase, 'state'),
    evidenceRoot: join(runBase, 'h01-evidence'),
    artifactRoot: join(runBase, 'artifacts'),
    hostRoot: join(runBase, 'host'),
  };
  const budget = {
    maxManagedStarts: 4,
    maxElapsedMs: 1000,
    reserveMs: 200,
    maxInputUncached: 50,
    maxOutput: 50,
  };
  const spec: H01OperatorSpec = {
    kind: comparisonKind(scenario, 'operator'),
    schemaVersion: 1,
    opId: 'H01-operator-unit',
    variant: candidate ? 'candidate' : 'baseline',
    budget,
    roots,
    evidenceRoot: join(runBase, 'operator'),
    node,
    entrypoint: ref(common),
    runtimeRoot,
  };
  const files = [spec.entrypoint, ref(operator)];
  if (candidate) {
    const binary = pin('temporal.snapshot', 'fake CLI; never executed');
    chmodSync(binary.locator, 0o700);
    const workflows = pin('workflow.snapshot', 'pinned generated workflow fixture');
    files.push(workflows);
    spec.temporal = {
      binary,
      address: '127.0.0.1:17239',
      httpAddress: '127.0.0.1:17240',
      metricsAddress: '127.0.0.1:17241',
      namespace: 'default',
      taskQueue: 'h01-unit',
      workflowsPath: workflows.locator,
      sqlitePath: join(spec.evidenceRoot, 'temporal.sqlite'),
    };
  }
  const specRef = pin('operator.json', JSON.stringify(spec));
  files.push(specRef);
  const request: H01ExecutionRequest = {
    kind: comparisonKind(scenario, 'execution'),
    executionVersion: 2,
    opId: spec.opId,
    variant: spec.variant,
    material: pin('material.json', '{}'),
    criteria: pin('criteria.json', '{}'),
    profile: pin(
      'profile.json',
      JSON.stringify({
        model: 'fixture',
        effort: 'low',
        clientVersion: 'fixture',
        binary: node,
        rules: pin('rules.snapshot', 'rules'),
        executor: pin('executor.snapshot', 'executor'),
        reviewer: pin('reviewer.snapshot', 'reviewer'),
      }),
    ),
    runtime: pin(
      'runtime.json',
      JSON.stringify({
        engine: candidate ? 'temporal' : 'legacy',
        root: runtimeRoot,
        files,
      }),
    ),
    bootstrap: pin(
      'bootstrap.json',
      JSON.stringify(
        candidate
          ? {
              engine: 'temporal',
              address: spec.temporal!.address,
              namespace: 'default',
              taskQueue: spec.temporal!.taskQueue,
              workflowsPath: spec.temporal!.workflowsPath,
              issuer: {
                sessionsRoot: input,
                workspaceRoot: runtimeRoot,
                threadId: 'human',
                owner: 'operator',
              },
            }
          : {
              engine: 'legacy',
              runtimeRoot,
              modulesRoot: runtimeRoot,
              overlay: pin('overlay.json', '{}'),
            },
      ),
    ),
    roots,
    budget,
    identity: { taskId: 'H01', owner: 'operator', generation: scenario === 'H-05' ? 2 : 1 },
    authorization: {
      root: runtimeRoot,
      transcript: join(input, 'human.jsonl'),
      anchor: {
        thread_id: 'human',
        turn_id: 'turn',
        workspace: runtimeRoot,
        host_id: 'local',
      },
      source: {
        locator: join(input, 'human.jsonl') + '#L1',
        hash: digest('not actual authorization'),
      },
      requestHash: digest('pending'),
    },
  };
  request.authorization.requestHash = h01RequestHash(request);
  const requestRef = pin('request.json', JSON.stringify(request));
  const publish = () => {
    writeFileSync(specRef.locator, JSON.stringify(spec));
    specRef.hash = digest(readFileSync(specRef.locator));
    const runtime = JSON.parse(readFileSync(request.runtime.locator).toString()) as {
      files: InputRef[];
    };
    runtime.files = runtime.files.filter((ref) => ref.locator !== specRef.locator);
    runtime.files.push(specRef);
    writeFileSync(request.runtime.locator, JSON.stringify(runtime));
    request.runtime.hash = digest(readFileSync(request.runtime.locator));
    request.authorization.requestHash = h01RequestHash(request);
    writeFileSync(requestRef.locator, JSON.stringify(request));
    requestRef.hash = digest(readFileSync(requestRef.locator));
  };
  const f = {
    root,
    input,
    pin,
    node,
    spec,
    specRef,
    request,
    requestRef,
    runBase,
    publish,
  };
  active = f;
  return f;
}

it.each([false, true])(
  'binds H03 to its own operator and keeper protocol (candidate=%s)',
  async (candidate) => {
    const f = fixture(candidate, 'H-03');
    expect(() => planH01Operator(f.specRef, f.requestRef, 'H-02')).toThrow('h01-operator-version');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await h03OperatorMain(['--plan', f.specRef.locator, f.requestRef.locator]);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    await h03OperatorMain(['--run', f.specRef.locator, f.requestRef.locator]);
    const report = object(JSON.parse(String(output.mock.calls.at(-1)![0])) as unknown);
    expect(report).toMatchObject({ kind: 'comparison-h03-operator-report', outcome: 'accepted' });
    expect(report.stops).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'h03' })]),
    );
  },
);

it.each([false, true])(
  'owns one H02 interval with the common stop owner (candidate=%s)',
  async (candidate) => {
    const f = fixture(candidate, 'H-02');
    expect(() => planH01Operator(f.specRef, f.requestRef)).toThrow('h01-operator-version');
    expect(planH01Operator(f.specRef, f.requestRef, 'H-02')).toMatchObject({
      kind: 'comparison-h02-operator-plan',
      actualModelStarts: 0,
    });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await h02OperatorMain(['--plan', f.specRef.locator, f.requestRef.locator]);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    await h02OperatorMain(['--run', f.specRef.locator, f.requestRef.locator]);
    const report = object(JSON.parse(String(output.mock.calls.at(-1)![0])) as unknown);
    expect(report).toMatchObject({ kind: 'comparison-h02-operator-report', outcome: 'accepted' });
    expect(report.stops).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'h02' })]),
    );
  },
);

it('plans without primary observation, directory writes, network or process effects', async () => {
  const f = fixture();
  f.request.authorization.source = { locator: '', hash: '' };
  f.request.authorization.requestHash = '';
  f.request.authorization.anchor.turn_id = '';
  f.publish();
  expect(planH01Operator(f.specRef, f.requestRef)).toMatchObject({
    mayRun: false,
    qualification: false,
    actualModelStarts: 0,
    actualServices: 0,
  });
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await h01OperatorMain(['--plan', f.specRef.locator, f.requestRef.locator]);
  expect(output).toHaveBeenCalledOnce();
  expect(observeH01Authorization).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(createConnection).not.toHaveBeenCalled();
  expect(existsSync(f.runBase)).toBe(false);
});

it.each([false, true])(
  'runs one fixed CLI after readonly authority and preserves byte-verified evidence (candidate=%s)',
  async (candidate) => {
    const f = fixture(candidate);
    vi.stubEnv('NODE_OPTIONS', '--require unapproved');
    vi.stubEnv('LD_PRELOAD', 'foreign');
    vi.stubEnv('DYLD_INSERT_LIBRARIES', 'foreign');
    vi.stubEnv('NODE_PATH', 'foreign');
    vi.stubEnv('TSX_TSCONFIG_PATH', 'foreign');
    vi.stubEnv('TEMPORAL_ADDRESS', 'foreign');
    const report = await runH01Operator(f.specRef, f.requestRef);
    expect(report).toMatchObject({
      outcome: 'accepted',
      qualification: false,
      partialScope: true,
      rootsRetained: true,
      activationAllowed: false,
      elapsedMs: 0,
    });
    expect(report.stops).toHaveLength(candidate ? 2 : 1);
    for (const [child, options] of vi.mocked(ownProcess).mock.calls) {
      if (candidate && child.pid === serverPid) expect(options).toHaveProperty('termGraceMs', 100);
      else expect(options).not.toHaveProperty('termGraceMs');
    }
    const call = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(call[0]).toBe(f.node.locator);
    expect(call[1]).toEqual([
      '--import',
      'tsx',
      f.spec.entrypoint.locator,
      '--run',
      f.requestRef.locator,
    ]);
    expect(call[2]).toMatchObject({ cwd: runtimeRoot, detached: true });
    for (const key of [
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'NODE_PATH',
      'TSX_TSCONFIG_PATH',
      'TEMPORAL_ADDRESS',
    ])
      expect(call[2]!.env![key]).toBeUndefined();
    expect(process.env.NODE_OPTIONS).toBe('--require unapproved');
    expect(
      readFileSync(join(f.spec.evidenceRoot, 'export/nested/raw.snapshot')).toString(),
    ).toContain('FAIL; findings; Result');
    expect(existsSync(f.request.roots.evidenceRoot)).toBe(true);
    expect(h01ReadJson(report.report)).toMatchObject({ outcome: 'accepted' });
    if (candidate) {
      expect(execFileSync).toHaveBeenCalledWith(
        '/usr/sbin/lsof',
        expect.any(Array),
        expect.any(Object),
      );
      expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual([
        'server',
        'start-dev',
        '--ip',
        '127.0.0.1',
        '--port',
        '17239',
        '--http-port',
        '17240',
        '--metrics-port',
        '17241',
        '--headless',
        '--db-filename',
        f.spec.temporal!.sqlitePath,
      ]);
    }
  },
);

it.each([1, 3, 120_000])(
  'keeps the server TERM grace within the stop budget for reserveMs=%s',
  async (reserveMs) => {
    const f = fixture(true);
    f.spec.budget.reserveMs = reserveMs;
    f.spec.budget.maxElapsedMs = 2_700_000;
    f.publish();
    const report = await runH01Operator(f.specRef, f.requestRef);
    expect(report.outcome).toBe('accepted');
    const server = vi.mocked(ownProcess).mock.calls.find(([child]) => child.pid === serverPid)!;
    expect(server[1].termGraceMs).toBe(Math.ceil(reserveMs / 2));
    expect(server[1].stopMs).toBe(reserveMs);
  },
);

it('preserves UNKNOWN for a forced server stop after an accepted child', async () => {
  const f = fixture(true);
  serverKilled = true;
  const report = await runH01Operator(f.specRef, f.requestRef);
  expect(report.child).toMatchObject({ outcome: 'accepted' });
  expect(report.outcome).toBe('unknown');
  expect(report.errors).toEqual([]);
  expect(report.stops.find((resource) => resource.name === 'server')?.receipt).toMatchObject({
    stopped: true,
    killed: true,
  });
  expect(report.stops.find((resource) => resource.name === 'h01')?.receipt).toMatchObject({
    stopped: true,
    killed: false,
  });
});

it('resolves bare node commands through the pinned Node directory before fixed system paths', async () => {
  const f = fixture();
  vi.stubEnv('PATH', '/unapproved/toolchain');
  const report = await runH01Operator(f.specRef, f.requestRef);
  expect(report.outcome).toBe('accepted');
  const child = vi.mocked(spawn).mock.calls.at(-1)!;
  const path = child[2]!.env!.PATH!;
  expect(path).toBe([dirname(f.node.locator), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'));
  const resolved = path
    .split(':')
    .map((directory) => join(directory, 'node'))
    .find(existsSync);
  expect(resolved).toBe(f.node.locator);
  expect(digest(readFileSync(resolved!))).toBe(f.node.hash);
  expect(process.env.PATH).toBe('/unapproved/toolchain');
});

it('retains a known failed H01 result, raw FAIL evidence and all roots', async () => {
  const f = fixture();
  code = 1;
  childResult = 'failed';
  const report = await runH01Operator(f.specRef, f.requestRef);
  expect(report.outcome).toBe('failed');
  expect(report.child).toMatchObject({ outcome: 'failed' });
  expect(existsSync(join(f.spec.evidenceRoot, 'export/nested/raw.snapshot'))).toBe(true);
  expect(Object.values(f.request.roots).every(existsSync)).toBe(true);
});

it.each([false, true])(
  'retains a bound exit1 UNKNOWN report without inventing an operator binding failure, candidate=%s',
  async (candidate) => {
    const f = fixture(candidate);
    code = 1;
    childResult = 'unknown';
    const report = await runH01Operator(f.specRef, f.requestRef);
    const delivered = JSON.parse(
      readFileSync(join(f.spec.evidenceRoot, 'h01.stdout'), 'utf8'),
    ) as Record<string, unknown> & { report: InputRef };
    const { report: ref, ...stored } = delivered;
    expect(h01ReadJson(ref)).toEqual(stored);
    expect(report.outcome).toBe('unknown');
    expect(report.child).toEqual(delivered);
    expect(report.error).toBeNull();
    expect(report.errors).toEqual([]);
    expect(report.evidence).toContainEqual(ref);
    expect(Object.values(f.request.roots).every(existsSync)).toBe(true);
  },
);

it.each([
  [0, 'unknown'],
  [2, 'unknown'],
  [1, 'accepted'],
] as const)('refuses inconsistent child exit %s and outcome %s', async (exit, outcome) => {
  const f = fixture();
  code = exit;
  childResult = outcome;
  const report = await runH01Operator(f.specRef, f.requestRef);
  expect(report.outcome).toBe('unknown');
  expect(report.error).toBe('Error: h01-operator-result-binding');
  expect(report.rootsRetained).toBe(true);
});

it.each([
  'opId',
  'requestHash',
  'variant',
  'kind',
  'partialScope',
  'qualification',
  'stored-bytes',
  'corrupt-stored',
] as const)('refuses a bound UNKNOWN delivery with tampered %s', async (failure) => {
  const f = fixture();
  code = 1;
  childResult = 'unknown';
  resultTransform = (value) => {
    if (failure === 'opId') value.opId = 'foreign-operation';
    if (failure === 'requestHash') value.requestHash = digest('foreign-request');
    if (failure === 'variant')
      value.variant = f.request.variant === 'candidate' ? 'baseline' : 'candidate';
    if (failure === 'kind') value.kind = 'foreign-report';
    if (failure === 'partialScope') value.partialScope = false;
    if (failure === 'qualification') value.qualification = true;
  };
  deliveryTransform = (value) => {
    if (failure === 'stored-bytes') value.unstoredField = true;
    if (failure === 'corrupt-stored') writeFileSync((value.report as InputRef).locator, '{}\n');
  };
  const report = await runH01Operator(f.specRef, f.requestRef);
  expect(report.outcome).toBe('unknown');
  expect(report.error).not.toBeNull();
  if (failure !== 'corrupt-stored') expect(report.error).toBe('Error: h01-operator-result-binding');
  expect(report.rootsRetained).toBe(true);
});

it('dispatches the fixed run CLI and removes only its signal listeners', async () => {
  const f = fixture();
  code = 1;
  childResult = 'failed';
  const term = process.listenerCount('SIGTERM'),
    interrupt = process.listenerCount('SIGINT');
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h01OperatorMain(['--run', f.specRef.locator, f.requestRef.locator]);
  expect(process.exitCode).toBe(1);
  expect(process.listenerCount('SIGTERM')).toBe(term);
  expect(process.listenerCount('SIGINT')).toBe(interrupt);
});

it('handles a queued CLI cancellation without granting or starting a child', async () => {
  const f = fixture();
  effect = () => process.listeners('SIGINT').at(-1)!('SIGINT');
  await expect(
    h01OperatorMain(['--run', f.specRef.locator, f.requestRef.locator]),
  ).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
  expect(existsSync(f.runBase)).toBe(false);
});

it('runs the module CLI only when explicitly selected and records invalid delivery', async () => {
  const before = process.argv;
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [before[0]!];
    await import('./comparisonH01Operator.js');
    process.argv = [before[0]!, join(runtimeRoot, 'tests/comparisonH01Operator.ts'), '--invalid'];
    vi.resetModules();
    await import('./comparisonH01Operator.js');
    await new Promise((done) => setImmediate(done));
    expect(stderr).toHaveBeenCalledWith('Error: h01-operator-usage\n');
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    process.argv = before;
  }
});

describe('pre-effect boundaries', () => {
  it('rejects a different pinned executable before primary observation or exec', async () => {
    const f = fixture();
    const other = f.pin('other-node.snapshot', 'different executable with a valid physical hash');
    chmodSync(other.locator, 0o700);
    f.spec.node = other;
    f.publish();
    await expect(runH01Operator(f.specRef, f.requestRef)).rejects.toThrow('node-binding');
    expect(observeH01Authorization).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(f.runBase)).toBe(false);
  });
  it('rejects an invalid primary grant before creating the owned base or any process', async () => {
    const f = fixture();
    vi.mocked(observeH01Authorization).mockRejectedValue(new Error('primary rejected'));
    await expect(runH01Operator(f.specRef, f.requestRef)).rejects.toThrow('primary rejected');
    expect(existsSync(f.runBase)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rechecks pins and freshness after awaited primary authorization', async () => {
    const f = fixture();
    effect = () => writeFileSync(f.node.locator, 'changed');
    await expect(runH01Operator(f.specRef, f.requestRef)).rejects.toThrow();
    expect(existsSync(f.runBase)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects occupied run base, aliases, overlapping roots and a noncanonical entrypoint', () => {
    const f = fixture();
    mkdirSync(f.runBase);
    expect(() => planH01Operator(f.specRef, f.requestRef)).toThrow('run-base');
    rmSync(f.runBase, { recursive: true });
    f.spec.entrypoint = f.node;
    f.publish();
    expect(() => planH01Operator(f.specRef, f.requestRef)).toThrow('binding');
    f.spec.roots.hostRoot = f.spec.evidenceRoot;
    f.publish();
    expect(() => planH01Operator(f.specRef, f.requestRef)).toThrow();
  });
  it('requires an executable pinned Node and immutable spec inventory membership', () => {
    const f = fixture();
    chmodSync(f.node.locator, 0o600);
    expect(() => planH01Operator(f.specRef, f.requestRef)).toThrow('executable');
    chmodSync(f.node.locator, 0o700);
    const runtime = JSON.parse(readFileSync(f.request.runtime.locator).toString()) as {
      files: InputRef[];
    };
    runtime.files = runtime.files.filter((ref) => ref.locator !== f.specRef.locator);
    writeFileSync(f.request.runtime.locator, JSON.stringify(runtime));
    f.request.runtime.hash = digest(readFileSync(f.request.runtime.locator));
    writeFileSync(f.requestRef.locator, JSON.stringify(f.request));
    f.requestRef.hash = digest(readFileSync(f.requestRef.locator));
    expect(() => planH01Operator(f.specRef, f.requestRef)).toThrow('binding');
  });
  it('rejects queued cancellation or the original elapsed deadline after authorization', async () => {
    const f = fixture();
    const controller = new AbortController();
    effect = () => controller.abort();
    await expect(runH01Operator(f.specRef, f.requestRef, controller.signal)).rejects.toThrow();
    expect(existsSync(f.runBase)).toBe(false);
    effect = () => {
      now += 1_000_000_000n;
    };
    vi.mocked(observeH01Authorization).mockClear();
    await expect(runH01Operator(f.specRef, f.requestRef)).rejects.toThrow('deadline');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('bounds a stuck readonly authorization without creating resources', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture();
    vi.mocked(observeH01Authorization).mockImplementation(() => new Promise(() => {}));
    const running = runH01Operator(f.specRef, f.requestRef);
    const assertion = expect(running).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(800);
    await assertion;
    expect(existsSync(f.runBase)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rechecks the same primary grant after preparation and before launching H01', async () => {
    const f = fixture();
    let calls = 0;
    vi.mocked(observeH01Authorization).mockImplementation(async () => {
      if (++calls === 3) throw new Error('grant no longer observable');
      return {} as H01VerifiedAuthorization;
    });
    const report = await runH01Operator(f.specRef, f.requestRef);
    expect(report).toMatchObject({
      outcome: 'unknown',
      error: 'Error: grant no longer observable',
    });
    expect(existsSync(f.spec.evidenceRoot)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects source namespace drift before any exec and retains the owned evidence', async () => {
    const f = fixture();
    vi.mocked(verifyH01Runtime).mockResolvedValueOnce({
      engine: 'legacy',
      root: runtimeRoot,
      files: [],
    });
    vi.mocked(verifyH01Runtime).mockRejectedValue(new Error('runtime namespace changed'));
    const report = await runH01Operator(f.specRef, f.requestRef);
    expect(report.outcome).toBe('unknown');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('refuses a physical parent alias or observation error without authorizing writes', () => {
    const f = fixture();
    const move = (base: string) => {
      for (const name of Object.keys(f.request.roots) as (keyof H01ExecutionRequest['roots'])[])
        f.request.roots[name] = f.request.roots[name].replace(dirname(f.spec.evidenceRoot), base);
      f.spec.evidenceRoot = join(base, 'operator');
      f.publish();
    };
    symlinkSync(f.root, join(f.root, 'alias'));
    move(join(f.root, 'alias/new-base'));
    expect(() => planH01Operator(f.specRef, f.requestRef)).toThrow();
    rmSync(join(f.root, 'alias'));
    symlinkSync(join(f.root, 'loop'), join(f.root, 'loop'));
    move(join(f.root, 'loop/base'));
    expect(() => planH01Operator(f.specRef, f.requestRef)).toThrow();
    expect(observeH01Authorization).not.toHaveBeenCalled();
  });
});

describe('unknown preservation and stops', () => {
  it.each([
    'missing-accounting',
    'wrong-binding',
    'unknown-result',
    'wrong-code',
    'missing-evidence',
    'bad-export',
    'unconfirmed-stop',
    'forced-stop',
    'stop-error',
    'signal-stop',
    'observer-error',
    'synchronous-stop-error',
    'missing-pid',
    'clock-rollback',
    'corrupt-stop-export',
  ])('retains the complete owned root and refuses PASS for %s', async (failure) => {
    const f = fixture();
    if (failure === 'missing-accounting')
      resultTransform = (value) => {
        value.accounting = { unknown: false, reservedManagedStarts: null };
      };
    if (failure === 'wrong-binding')
      resultTransform = (value) => {
        value.requestHash = digest('other request');
      };
    if (failure === 'unknown-result') {
      childResult = 'unknown';
      code = 1;
    }
    if (failure === 'wrong-code') code = 2;
    if (failure === 'missing-evidence') noEvidence = true;
    if (failure === 'bad-export') badExport = true;
    if (failure === 'unconfirmed-stop') stopped = false;
    if (failure === 'forced-stop') killed = true;
    if (failure === 'stop-error') {
      stopped = false;
      stopError = true;
    }
    if (failure === 'signal-stop') signal = 'SIGTERM';
    if (failure === 'observer-error') rejectedOwner = true;
    if (failure === 'synchronous-stop-error') {
      stopped = false;
      synchronousStopError = true;
    }
    if (failure === 'missing-pid') noPid = true;
    if (failure === 'clock-rollback')
      resultTransform = () => {
        now -= 1n;
      };
    if (failure === 'corrupt-stop-export')
      resultTransform = () => {
        const hash = digest(canonical({ portStops: [] }) + '\n');
        writeFileSync(
          join(f.spec.evidenceRoot, 'ports-stopped-' + hash + '.json'),
          'corrupt proof',
        );
      };
    const report = await runH01Operator(f.specRef, f.requestRef);
    expect(report.outcome).toBe('unknown');
    expect(report.rootsRetained).toBe(true);
    expect(existsSync(f.spec.evidenceRoot)).toBe(true);
    expect(readdirSync(f.spec.evidenceRoot)).toContain('h01.stdout');
  });
  it('cancels a running child, retains its handle and cannot accept a late successful report', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture();
    hangChild = true;
    const running = runH01Operator(f.specRef, f.requestRef);
    await vi.advanceTimersByTimeAsync(0);
    now += 800_000_000n;
    await vi.advanceTimersByTimeAsync(800);
    const report = await running;
    expect(report).toMatchObject({
      outcome: 'unknown',
      timedOut: true,
      rootsRetained: true,
    });
    expect(report.stops).toHaveLength(1);
    expect(existsSync(f.spec.evidenceRoot)).toBe(true);
  });
  it('retains an unconfirmed child PID when ownership setup fails, without raw PID signals', async () => {
    const f = fixture();
    vi.mocked(ownProcess).mockImplementationOnce(() => {
      throw new Error('ownership unavailable');
    });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const report = await runH01Operator(f.specRef, f.requestRef);
    expect(report.outcome).toBe('unknown');
    expect(report.stops).toEqual([{ name: 'h01', pid: 901, receipt: null, error: null }]);
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(f.spec.evidenceRoot)).toBe(true);
  });
  it('waits for the owned server and stops it when a later primary check fails', async () => {
    const f = fixture(true);
    notReady = 1;
    let calls = 0;
    vi.mocked(observeH01Authorization).mockImplementation(async () => {
      if (++calls === 4) throw new Error('primary unavailable before H01');
      return {} as H01VerifiedAuthorization;
    });
    const report = await runH01Operator(f.specRef, f.requestRef);
    expect(report.outcome).toBe('unknown');
    expect(report.stops).toHaveLength(1);
    expect(report.portStops).toHaveLength(3);
    expect(report.portStops.every((proof) => proof.closed)).toBe(true);
    expect(vi.mocked(spawn).mock.calls).toHaveLength(1);
  });
  it.each([
    'occupied',
    'foreign-listener',
    'server-exit',
    'port-error',
    'port-timeout',
    'listener-remains',
    'bad-server-stop',
  ])('fails closed for Temporal %s without retrying H01', async (failure) => {
    const f = fixture(true);
    if (failure === 'occupied') preOpen = true;
    if (failure === 'foreign-listener') listenerPid = 99999;
    if (failure === 'server-exit') serverExit = true;
    if (failure === 'port-error') probeFailure = 'EACCES';
    if (failure === 'port-timeout') socketTimeout = true;
    if (failure === 'listener-remains') keepOpen = true;
    if (failure === 'bad-server-stop') badServerStop = true;
    const report = await runH01Operator(f.specRef, f.requestRef);
    expect(report.outcome).toBe('unknown');
    expect(vi.mocked(spawn).mock.calls.filter((call) => call[1]![0] !== 'server')).toHaveLength(
      ['listener-remains', 'bad-server-stop'].includes(failure) ? 1 : 0,
    );
    expect(existsSync(f.spec.evidenceRoot)).toBe(true);
  });
});

/** Unit routing: real series persistence with fixed operator/readiness/evidence boundaries. */
function versionedSeriesFixture(version: 1 | 2 | 3 | 4 | 5 | 6 = 4) {
  const suite = parseComparisonSuite(
    JSON.parse(readFileSync(join(runtimeRoot, 'comparison/suite.json'), 'utf8')),
  );
  const materials = JSON.parse(
    readFileSync(join(runtimeRoot, 'comparison/materials.json'), 'utf8'),
  ) as { cases: unknown[] };
  const schedule = comparisonSchedule(
    suite,
    Object.fromEntries(
      materials.cases.map((material, index) => [
        suite.scenarios[index]!.id,
        { material_hash: digest(canonical(material)), profile_hash: 'a'.repeat(64) },
      ]),
    ),
  );
  const selected = schedule.slice(0, version * 4);
  const operations = selected.slice(0, 20).map((slot, index) => {
    const scenario = slot.scenario as Parameters<typeof fixture>[1];
    const value = fixture(slot.variant === 'candidate', scenario);
    value.spec.opId = 'v' + version + '-operator-' + index;
    value.request.opId = value.spec.opId;
    const scenarioIndex = Number(slot.scenario.slice(-2)) - 1;
    value.request.material = value.pin(
      'actual-material.json',
      canonical(materials.cases[scenarioIndex]),
    );
    value.request.criteria = value.pin(
      'actual-criteria.json',
      canonical(suite.scenarios[scenarioIndex]),
    );
    return value;
  });
  const first = operations[0]!,
    commonProfile = first.request.profile,
    profile = object(h01ReadJson(commonProfile));
  const commonFiles = new Map<string, InputRef>();
  for (const operation of operations)
    for (const ref of object(h01ReadJson(operation.request.runtime)).files as InputRef[])
      if (ref.locator !== operation.specRef.locator) commonFiles.set(ref.locator, ref);
  const commonRuntime = Object.fromEntries(
    (['baseline', 'candidate'] as const).map((variant) => [
      variant,
      first.pin(
        'common-' + variant + '.json',
        canonical({
          engine: variant === 'baseline' ? 'legacy' : 'temporal',
          root: runtimeRoot,
          files: [...commonFiles.values()],
        }),
      ),
    ]),
  ) as Record<'baseline' | 'candidate', InputRef>;
  for (const operation of operations) {
    operation.spec.node = first.node;
    operation.request.profile = commonProfile;
    operation.request.runtime = operation.pin(
      'shared-runtime.json',
      canonical({
        engine: operation.request.variant === 'baseline' ? 'legacy' : 'temporal',
        root: runtimeRoot,
        files: [...commonFiles.values(), operation.specRef],
      }),
    );
    operation.publish();
  }
  const variants = Object.fromEntries(
    (['baseline', 'candidate'] as const).map((variant) => [
      variant,
      {
        runtime: {
          engine: variant === 'baseline' ? 'legacy' : 'temporal',
          artifact: commonRuntime[variant],
        },
        profile: {
          model: profile.model,
          effort: profile.effort,
          clientVersion: profile.clientVersion,
          client: profile.binary,
          rules: profile.rules,
        },
      },
    ]),
  );
  const source = {
    schema_version: 2,
    variants,
    sourceSnapshot: {
      roots: {
        source: join(first.root, 'source-snapshot'),
        baseline: join(first.root, 'baseline-snapshot'),
        candidate: join(first.root, 'candidate-snapshot'),
      },
    },
  };
  const parsedVariant = (variant: 'baseline' | 'candidate') => ({
    runtime: {
      engine: variant === 'baseline' ? 'legacy' : 'temporal',
      artifact: commonRuntime[variant],
    },
    taskSource: first.request.material,
    declaredSourceRevision: null,
    criteria: first.request.criteria,
    profileHash: 'a'.repeat(64),
    profileRefs: { client: first.node, rules: profile.rules as InputRef },
    environmentHash: 'b'.repeat(64),
    environmentRefs: {},
  });
  vi.mocked(checkComparisonReadiness).mockReturnValue({
    schema_version: 2,
    kind: 'temporal-comparison-readiness-report',
    status: 'PASS',
    mayRun: false,
    qualification: false,
    allowedModelStarts: 0,
    authorization: null,
    canonicalManifestHash: digest(canonical(source)),
    variants: { baseline: parsedVariant('baseline'), candidate: parsedVariant('candidate') },
    schedule,
    unproven: ['Synthetic provider routing, no native qualification.'],
  });
  const started = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(started);
  const h06Steps = selected.slice(20).map((slot, index) => {
    const root = join(first.root, 'h06-' + index);
    const spec = first.pin('h06-spec-' + index + '.json', canonical({ runId: slot.id }));
    const request = first.pin('h06-request-' + index + '.json', canonical({ runId: slot.id }));
    const workspaceRoot = join(root, 'workspace'),
      operatorRoot = join(root, 'operator'),
      evidenceRoot = join(root, 'evidence'),
      packetRoot = slot.variant === 'baseline' ? join(root, 'packet') : null;
    return {
      runId: slot.id,
      spec,
      request,
      binding: {
        opId: 'v6-h06-operator-' + index,
        variant: slot.variant,
        budget: { ...first.request.budget, maxElapsedMs: 100_000 },
        profile: commonProfile,
        runtime: commonRuntime[slot.variant],
        bootstrap: first.request.bootstrap,
        material: first.request.material,
        criteria: first.request.criteria,
        evidenceRoot,
        operatorRoot,
        workspaceRoot,
        chatRoot: join(root, 'chat'),
        longStageMs: 35_000,
        roots: [
          workspaceRoot,
          operatorRoot,
          evidenceRoot,
          ...(packetRoot === null ? [] : [packetRoot]),
        ],
        packetRoot,
        packetPaths: packetRoot === null ? [] : [join(packetRoot, 'start.json')],
        pins: [] as InputRef[],
        runtimeFiles: [] as InputRef[],
      },
    };
  });
  process.execPath = first.node.locator;
  if (version === 6)
    vi.spyOn(operatorModule, 'planH01Operator').mockReturnValue(
      {} as ReturnType<typeof planH01Operator>,
    );
  vi.spyOn(h06OperatorModule, 'readH06OperatorBinding').mockImplementation((spec, request) => {
    const { binding } = h06Steps.find((step) => step.spec.locator === spec.locator)!;
    return {
      ...binding,
      requestHash: digest(canonical({ spec, request })),
    } as unknown as ReturnType<typeof h06OperatorModule.readH06OperatorBinding>;
  });
  const h06Plan = vi
    .spyOn(h06OperatorModule, 'planH06Operator')
    .mockImplementation((spec, request) => {
      return { spec, request } as ReturnType<typeof h06OperatorModule.planH06Operator>;
    });
  const h06Run = vi
    .spyOn(h06OperatorModule, 'runH06Operator')
    .mockImplementation(async (spec, request) => {
      return {
        spec,
        request,
        startedNs: String(now),
        endedNs: String(now),
      } as Awaited<ReturnType<typeof h06OperatorModule.runH06Operator>>;
    });
  const h06Evidence = vi
    .spyOn(h06OperatorModule, 'normalizeH06SeriesEvidence')
    .mockImplementation(({ runId, opId, operator }) => {
      const account = { observedResponses: 2, inputUncached: 10, inputCached: 2, output: 3 },
        timing = object(operator);
      return {
        outcome: 'accepted',
        checks: { 'unit-routing': true },
        stopped: true,
        accounting: { ...account, reservedManagedStarts: 2, unknown: false },
        knownSubtotal: account,
        operatorElapsedMs: 0,
        startedNs: String(timing.startedNs),
        endedNs: String(timing.endedNs),
        blocking: [],
        evidence: [],
        mapping: { runId, opId },
        partialScope: true,
        qualification: false,
      };
    });
  const manifest = {
    kind: 'comparison-h01-series',
    schemaVersion: version,
    readiness: first.pin('readiness.json', canonical(source)),
    outputRoot: join(first.root, 'series'),
    startedAtMs: started - 100,
    cap: {
      maxElapsedMs: 500_000,
      reserveMs: 1000,
      maxManagedStarts: 100,
      maxInputUncached: 1200,
      maxOutput: 1200,
    },
    steps: [
      ...operations.map((operation, index) => ({
        runId: selected[index]!.id,
        spec: operation.specRef,
        request: operation.requestRef,
      })),
      ...h06Steps.map(({ runId, spec, request }) => ({ runId, spec, request })),
    ],
  };
  let manifestRef = first.pin('series-manifest.json', canonical(manifest)),
    ordinal = 0;
  const operator = vi
    .spyOn(operatorModule, 'runH01Operator')
    .mockImplementation(async (spec, request, _signal, scenario) => {
      const operation = operations.find((operation) => operation.specRef.locator === spec.locator)!;
      const accounting = {
        reservedManagedStarts: 2,
        observedResponses: 2,
        inputUncached: 10,
        inputCached: 2,
        output: 3,
        unknown: false,
      };
      const raw = {
        kind: comparisonKind(scenario!, 'operator-report'),
        schemaVersion: 1,
        opId: operation.request.opId,
        variant: operation.request.variant,
        requestHash: h01RequestHash(h01ReadJson(request) as H01ExecutionRequest),
        partialScope: true,
        qualification: false,
        requestRef: request,
        specRef: spec,
        outcome: 'accepted',
        error: null,
        errors: [],
        timedOut: false,
        budget: operation.request.budget,
        startedNs: String(now),
        endedNs: String(now),
        deadlineNs: String(now + 1_000_000_000n),
        elapsedMs: 0,
        child: { accounting },
        stops: [],
        portStops: [],
        evidence: [],
        rootsRetained: true,
        activationAllowed: false,
        clockBoundary: 'synthetic unit boundary',
        unproven: ['No native qualification'],
      };
      return {
        ...raw,
        report: first.pin('synthetic-operator-' + operation.request.opId + '.json', canonical(raw)),
      } as Awaited<ReturnType<typeof runH01Operator>>;
    });
  const normalized = vi
    .spyOn(seriesEvidenceModule, 'normalizeH01SeriesEvidence')
    .mockImplementation(({ runId, opId, operator }) => {
      const raw = object(operator),
        owned = object(raw.child),
        account = object(owned.accounting);
      return {
        outcome: 'accepted',
        checks: { 'unit-routing': true },
        stopped: true,
        accounting: {
          reservedManagedStarts: Number(account.reservedManagedStarts),
          observedResponses: Number(account.observedResponses),
          inputUncached: Number(account.inputUncached),
          inputCached: Number(account.inputCached),
          output: Number(account.output),
          unknown: false,
        },
        knownSubtotal: {
          observedResponses: Number(account.observedResponses),
          inputUncached: Number(account.inputUncached),
          inputCached: Number(account.inputCached),
          output: Number(account.output),
        },
        operatorElapsedMs: Number(raw.elapsedMs),
        startedNs: String(raw.startedNs),
        endedNs: String(raw.endedNs),
        blocking: [],
        evidence: [],
        mapping: { runId, opId },
        partialScope: true,
        qualification: false,
      };
    });
  return {
    manifest,
    operations,
    operator,
    normalized,
    h06Steps,
    h06Plan,
    h06Run,
    h06Evidence,
    first,
    get manifestRef() {
      return manifestRef;
    },
    save() {
      manifestRef = first.pin('series-manifest.json', canonical(manifest));
      return manifestRef;
    },
    command(
      index: number,
      previousState: InputRef | null = null,
      extra: Record<string, unknown> = {},
    ) {
      const step = manifest.steps[index]!;
      let requestRef = step.request;
      if (index < 20) {
        const request = structuredClone(operations[index]!.request);
        request.authorization.anchor.turn_id = 'v' + version + '-grant-' + index;
        request.authorization.source = {
          locator: request.authorization.transcript + '#L1',
          hash: 'a'.repeat(64),
        };
        request.authorization.requestHash = h01RequestHash(request);
        requestRef = first.pin('sealed-' + index + '.json', canonical(request));
      }
      return first.pin(
        'step-' + ordinal++ + '.json',
        canonical({
          kind: 'comparison-h01-series-step',
          schemaVersion: version,
          manifest: manifestRef,
          runId: selected[index]!.id,
          request: requestRef,
          previousState,
          ...extra,
        }),
      );
    },
    statePath: join(manifest.outputRoot, 'state.json'),
  };
}
async function seedSeriesPrefix(f: ReturnType<typeof versionedSeriesFixture>, slotIndex: number) {
  mkdirSync(f.manifest.outputRoot, { mode: 0o700 });
  const records = [];
  for (let index = 0; index < slotIndex; index++) {
    const command = f.command(index),
      input = object(h01ReadJson(command)),
      request = input.request as InputRef,
      operation = f.operations[index]!,
      runId = f.manifest.steps[index]!.runId,
      opId = operation.request.opId;
    const operator = await f.operator(
      operation.specRef,
      request,
      undefined,
      requestScenario(operation.request),
    );
    const evidence = f.normalized(
      { runId, opId, request, spec: operation.specRef, operator },
      requestScenario(operation.request),
    );
    const record = {
      runId,
      opId,
      requestHash: h01RequestHash(operation.request),
      command,
      request,
      operator,
      evidence,
      blocked: [],
      startedAtMs: Date.now(),
      endedAtMs: Date.now(),
      startedNs: String(now),
      endedNs: String(now),
      elapsedMs: 100,
    };
    records.push(record);
    writeFileSync(join(f.manifest.outputRoot, 'record-' + index + '.json'), canonical(record), {
      mode: 0o600,
    });
  }
  const state = {
    kind: 'comparison-h01-series-state',
    schemaVersion: f.manifest.schemaVersion,
    manifest: f.manifestRef,
    schedule:
      f.manifest.schemaVersion === 6
        ? (await planH01Series(f.manifestRef)).schedule
        : checkComparisonReadiness({}).schedule,
    startedAtMs: f.manifest.startedAtMs,
    observedAtMs: Date.now(),
    observedNs: String(now),
    elapsedMs: 100,
    records,
    pending: null,
    blocked: [],
    partialScope: true,
    qualification: false,
  };
  writeFileSync(f.statePath, canonical(state), { mode: 0o600 });
  const previous: InputRef = { locator: f.statePath, hash: digest(readFileSync(f.statePath)) };
  f.operator.mockClear();
  return previous;
}
describe('H04 versioned comparison series', () => {
  it('plans sixteen immutable slots without starting a provider', async () => {
    const f = versionedSeriesFixture(),
      plan = await planH01Series(f.manifestRef);
    expect(plan).toMatchObject({
      schemaVersion: 4,
      mayRun: false,
      allowedModelStarts: 0,
      partialScope: true,
      qualification: false,
    });
    expect(plan.executable).toHaveLength(16);
    expect(plan.schedule).toHaveLength(24);
    expect(f.operator).not.toHaveBeenCalled();
    expect(existsSync(f.manifest.outputRoot)).toBe(false);
  });
  it.each([12, 13, 14, 15])(
    'continues the persisted prefix at H04 slot %s with the shared controller',
    async (slotIndex) => {
      const f = versionedSeriesFixture();
      const previous = await seedSeriesPrefix(f, slotIndex);
      const command = f.command(slotIndex, previous),
        result = await stepH01Series(command);
      expect(result.records).toHaveLength(slotIndex + 1);
      expect(result.schemaVersion).toBe(4);
      if (slotIndex === 12) expect((await stepH01Series(command)).records).toHaveLength(13);
      if (slotIndex === 15)
        expect(statusH01Series(f.statePath)).toMatchObject({
          schemaVersion: 4,
          status: 'adapter-required',
          next: 'H-05:1:baseline',
        });
      expect(f.operator).toHaveBeenCalledTimes(1);
      expect(f.operator.mock.calls[0]![3]).toBe('H-04');
    },
    30_000,
  );
  it.each(['v3', 'incomplete', 'command-version', 'h03-request'] as const)(
    'refuses a crossed H04 boundary: %s',
    async (mode) => {
      const f = versionedSeriesFixture();
      if (mode === 'v3') {
        f.manifest.schemaVersion = 3;
        f.save();
        await expect(planH01Series(f.manifestRef)).rejects.toThrow('series-step-order');
      }
      if (mode === 'incomplete') {
        f.manifest.steps.pop();
        f.save();
        await expect(planH01Series(f.manifestRef)).rejects.toThrow('series-step-order');
      }
      if (mode === 'command-version')
        await expect(stepH01Series(f.command(0, null, { schemaVersion: 3 }))).rejects.toThrow(
          'series-step-command-version',
        );
      if (mode === 'h03-request') {
        f.operations[12]!.request.kind = 'comparison-h03-execution';
        f.operations[12]!.publish();
        f.manifest.steps[12]!.request = f.operations[12]!.requestRef;
        f.save();
        await expect(planH01Series(f.manifestRef)).rejects.toThrow('h01-version');
      }
      expect(f.operator).not.toHaveBeenCalled();
    },
  );
});

/** Synthetic primary records exercise both shared read-only owners; no provider is started. */
async function h04SeriesEvidenceFixture(candidate = false, missingWaiter = false) {
  const f = fixture(candidate, 'H-04'),
    request = f.request,
    opId = request.opId;
  let ordinal = 0;
  const record = (name: string, value: unknown) =>
    f.pin('evidence-' + name + '-' + ordinal++ + '.json', canonical(value) + '\n');
  const primary = (name: string, value: unknown, root = request.roots.evidenceRoot) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const locator = join(root, name),
      bytes = Buffer.from(JSON.stringify(value) + '\n');
    writeFileSync(locator, bytes, { mode: 0o600 });
    return { locator, hash: digest(bytes) };
  };
  const materials = object(
    JSON.parse(readFileSync(join(runtimeRoot, 'comparison/materials.json'), 'utf8')),
  );
  request.material = record('material', (materials.cases as unknown[])[3]);
  const scenario = parseComparisonSuite(
    JSON.parse(readFileSync(join(runtimeRoot, 'comparison/suite.json'), 'utf8')),
  ).scenarios[3]!;
  request.criteria = record('criteria', scenario);
  const waiterPath = join(runtimeRoot, 'tests/comparisonH04NativeWait.mjs');
  const waiter = { locator: waiterPath, hash: digest(readFileSync(waiterPath)) };
  const runtime = object(h01ReadJson(request.runtime));
  runtime.files = [...(runtime.files as InputRef[]), ...(missingWaiter ? [] : [waiter])];
  request.runtime = record('runtime', runtime);
  request.budget.maxInputUncached = 1000;
  request.budget.maxOutput = 1000;
  request.budget.maxElapsedMs = 60000;
  request.budget.reserveMs = 2000;
  f.spec.budget = request.budget;
  f.publish();
  const requestHash = h01RequestHash(request),
    clean = { stopped: true, code: 0, signal: null, killed: false, deadlineReached: false };
  const checker = record('initial-check', {
    kind: 'comparison-h04-check',
    opId,
    requestHash,
    material: request.material,
    cwd: request.roots.workspaceRoot,
    known: true,
    passed: false,
    stop: { ...clean, code: 1 },
    stdout: record('stdout', { failure: 'F-01' }),
    stderr: record('stderr', ''),
  });
  const failure = record('failure', {
    kind: 'comparison-h04-initial-failure',
    opId,
    failed: true,
    evidence: checker,
  });
  const profile = parseH01Profile(request.profile);
  const guard = {
    kind: 'comparison-h04-guard',
    executionVersion: 2,
    opId,
    requestHash,
    request: f.requestRef,
    variant: request.variant,
    roots: request.roots,
    budget: request.budget,
    profile: { model: profile.model, effort: profile.effort, clientVersion: profile.clientVersion },
    binary: profile.binary,
    authorization: request.authorization,
    pins: [request.material],
    startedNs: '10000000001',
    deadlineNs: '70000000001',
    workDeadlineNs: '68000000001',
  };
  const outputRoot = join(request.roots.evidenceRoot, 'h04-operation');
  mkdirSync(outputRoot, { recursive: true });
  const operation: H04NativeOperationRequest = {
    kind: 'comparison-h04-native-operation',
    schemaVersion: 1,
    opId,
    requestHash,
    material: request.material,
    failure,
    engine: candidate ? 'temporal' : 'legacy',
    operationId: 'h04-' + digest(opId).slice(0, 32),
    outputRoot,
    workspace: request.roots.workspaceRoot,
    deadlineNs: '68000000001',
    node: f.node,
    waiter,
  };
  let operationRef = primary(
    'h04-operation-request.json',
    operation,
    join(request.roots.workspaceRoot, 'evidence'),
  );
  const binding = h04NativeBinding(operation),
    logs = Array.from({ length: 6 }, (_, index) => ({
      sequence: index + 1,
      elapsedMs: (index + 1) * 5000,
    }));
  const result = primary(
    'result.json',
    {
      kind: 'h04-operation-result',
      operationId: binding.operationId,
      inputHash: binding.inputHash,
      elapsedMs: 35000,
      logs,
    },
    outputRoot,
  );
  const ref = { sha256: result.hash, bytes: readFileSync(result.locator).length };
  for (const stage of ['run', 'apply'] as const)
    await effectJournal(join(outputRoot, 'effects')).execute(
      h04BoundIntent(binding, stage),
      async () => ref,
    );
  for (const log of logs) primary('log-' + log.sequence + '.json', log, outputRoot);
  const application = primary(
    'applied.json',
    { operationId: binding.operationId, result: ref },
    outputRoot,
  );
  const effectStart = primary(
    'operation-start.json',
    { operationId: binding.operationId, inputHash: binding.inputHash },
    outputRoot,
  );
  const terminal = primary(
    'terminal.json',
    {
      kind: 'comparison-h04-native-terminal',
      opId,
      operationId: binding.operationId,
      inputHash: binding.inputHash,
      result: ref,
    },
    outputRoot,
  );
  const session = 'h04-native-session',
    turn = 'h04-native-turn',
    command = h04NativeWaitCommand(operation, operationRef),
    sessionId = 7;
  const gate = record('gate', {
    kind: 'comparison-h04-native-gate',
    opId,
    atMs: 100,
    atNs: '10100000000',
    notification: {
      method: 'item/started',
      params: {
        threadId: session,
        turnId: turn,
        item: { id: 'command-1', type: 'commandExecution', command },
      },
    },
  });
  const rows: Record<string, unknown>[] = [
    { type: 'session_meta', payload: { id: session } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'launch',
        input: h04NativeLaunchCode(operation, operationRef),
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'item_started',
        thread_id: session,
        turn_id: turn,
        item: { type: 'CommandExecution', id: 'command-1', command: ['/bin/zsh', '-lc', command] },
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'launch',
        output: [
          {
            type: 'input_text',
            text: JSON.stringify({ session_id: sessionId, output: 'waiting' }),
          },
        ],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'wait',
        input: h04NativeWaitingCode(sessionId),
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        started_at_ms: 100,
        completed_at_ms: 35100,
        thread_id: session,
        turn_id: turn,
        item: {
          type: 'CommandExecution',
          id: 'command-1',
          command: ['/bin/zsh', '-lc', command],
          process_id: String(sessionId),
          cwd: operation.workspace,
          status: 'completed',
          exit_code: 0,
        },
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'wait',
        output: [
          {
            type: 'input_text',
            text: JSON.stringify({ exit_code: 0, output: readFileSync(terminal.locator, 'utf8') }),
          },
        ],
      },
    },
    {
      type: 'token_usage_record',
      payload: {
        thread_id: session,
        session_id: session,
        turn_id: turn,
        response_id: 'h04-response',
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
        thread_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } },
  ];
  const transcript = join(f.root, 'h04-session.jsonl');
  const participant: ComparisonParticipant = { run: opId, session, transcript, stage: 'execution' };
  const physical = record('physical', {
    kind: 'writers-stopped',
    active_turn: false,
    remaining_terminals: 0,
    remaining_processes: 0,
    before_hash: 'a'.repeat(64),
    after_hash: 'a'.repeat(64),
    processes: [],
  });
  const stopBody = {
    kind: 'comparison-h04-stop',
    executionVersion: 2,
    opId,
    confirmed: true,
    sessions: [session],
    remainingProcesses: [],
    evidence: [physical],
  };
  let stop = record('native-stop', stopBody);
  const checks = Object.fromEntries(scenario.checks.map((name) => [name, true]));
  const payload = (value: unknown) => ({
    payloads: [payloadToJSON(defaultPayloadConverter.toPayload(value)!)],
  });
  const sdkInput = { operationId: binding.operationId, inputHash: binding.inputHash };
  const history = candidate
    ? record('history', {
        events: [
          {
            eventId: '1',
            eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
            workflowExecutionStartedEventAttributes: {
              workflowType: { name: 'ComparisonH04Workflow' },
              originalExecutionRunId: 'sdk-run',
              input: payload(sdkInput),
            },
          },
          {
            eventId: '2',
            eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED',
            activityTaskScheduledEventAttributes: {
              activityType: { name: 'h04Operation' },
              input: payload(sdkInput),
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
      })
    : null;
  const report: H04NativeCaseReport = {
    kind: 'comparison-h04-case',
    scenario: 'H-04',
    opId,
    engine: operation.engine,
    session,
    outcome: 'accepted',
    checks,
    blocking: [],
    request: operationRef,
    nativeWait: null,
    primary: {
      result,
      application,
      effectStart,
      gate,
      history,
      workflow: candidate
        ? record('workflow', { workflowId: binding.operationId, runId: 'sdk-run' })
        : null,
      terminal,
      wait: candidate
        ? null
        : record('wait', {
            timed_out: false,
            snapshot: {
              status: 'completed',
              run_id: binding.operationId,
              target_hash: binding.inputHash,
            },
          }),
    },
    stop,
    evidence: [failure, checker],
    nativeAcceptance: false,
    qualification: false,
    partialScope: true,
  };
  const graph = nativeSeriesEvidenceGraph(
    f,
    'H-04',
    report,
    rows,
    participant,
    physical,
    stopBody,
    guard,
    record,
    primary,
    () => {
      if (report.nativeWait === null)
        report.nativeWait = verifyH04NativeWait(operationRef, participant, terminal);
    },
    () => ({
      kind: 'comparison-h04-native-acceptance',
      opId,
      request: operationRef,
      proof: report.nativeWait,
      primary: report.primary,
      qualification: false,
    }),
  );
  const changeOperation = (update: Partial<H04NativeOperationRequest>) => {
    Object.assign(operation, update);
    operationRef = primary(
      'h04-operation-request.json',
      operation,
      join(request.roots.workspaceRoot, 'evidence'),
    );
    report.request = operationRef;
  };
  graph.refresh();
  return { ...graph, operation, changeOperation };
}
function nativeSeriesEvidenceGraph<T extends H04NativeCaseReport | H05CaseReport>(
  f: ReturnType<typeof fixture>,
  scenario: 'H-04' | 'H-05',
  report: T,
  rows: Record<string, unknown>[],
  participant: ComparisonParticipant,
  physical: InputRef,
  stopBody: {
    kind: string;
    executionVersion: number;
    opId: string;
    confirmed: boolean;
    sessions: string[];
    remainingProcesses: unknown[];
    evidence: InputRef[];
  },
  guard: Record<string, unknown>,
  record: (name: string, value: unknown) => InputRef,
  primary: (name: string, value: unknown, root?: string) => InputRef,
  onRefresh: () => void,
  nativeAcceptance: (caseReport: InputRef) => Record<string, unknown>,
) {
  const request = f.request,
    opId = request.opId,
    requestHash = h01RequestHash(request),
    checks = report.checks,
    candidate = request.variant === 'candidate',
    label = scenario === 'H-04' ? 'h04' : 'h05',
    transcript = participant.transcript,
    clean = { stopped: true, code: 0, signal: null, killed: false, deadlineReached: false };
  let stop = report.stop,
    guardRefs: InputRef[] | undefined;
  const timing = {
    start: { wall_ms: 1000, monotonic_ms: 0, clock_id: 'host' },
    end: { wall_ms: 1100, monotonic_ms: 100, clock_id: 'host' },
  };
  const bindingReport = {
    opId,
    variant: request.variant,
    requestHash,
    partialScope: true,
    qualification: false,
  };
  const accounting = {
    participants: [participant],
    receipts: [] as ReturnType<typeof readComparisonUsage>,
    reservedManagedStarts: 2,
    observedResponses: 1,
    inputUncached: 80,
    inputCached: 20,
    output: 10,
    unknown: false,
    evidence: [] as InputRef[],
  };
  const child = {
    ...bindingReport,
    kind: comparisonKind(scenario, 'execution-report'),
    executionVersion: 2,
    outcome: 'accepted',
    checks,
    stop,
    nativeAcceptance: null as InputRef | null,
    projection: null as InputRef | null,
    accounting,
    timing,
    elapsedMs: 100,
    evidence: [] as InputRef[],
  };
  const stops = [label, ...(candidate ? ['server'] : [])].map((name, index) => ({
    name,
    pid: 100 + index,
    error: null,
    receipt: { ...clean },
  }));
  const ports = candidate
    ? [f.spec.temporal!.address, f.spec.temporal!.httpAddress, f.spec.temporal!.metricsAddress].map(
        (address) => ({ address, closed: true }),
      )
    : [];
  const projection: Record<string, unknown> = {
    kind: 'comparison-' + label + '-native-projection',
    scenario,
    opId,
    engine: report.engine,
    caseReport: null,
  };
  let acceptance: Record<string, unknown> | undefined;
  const refresh = () => {
    const lines = rows.map((row) => canonical(row) + '\n');
    writeFileSync(transcript, lines.join(''));
    participant.through = {
      locator: transcript + '#L' + lines.length,
      hash: digest(lines.at(-1)!),
    };
    onRefresh();
    const budgetBytes = Buffer.from(
      canonical({
        kind: 'task-model-budget',
        schemaVersion: 1,
        limit: request.budget.maxManagedStarts,
        credits: [{}, {}],
      }),
    );
    mkdirSync(request.roots.artifactRoot, { recursive: true });
    const budget = { sha256: digest(budgetBytes), bytes: budgetBytes.length };
    writeFileSync(join(request.roots.artifactRoot, budget.sha256), budgetBytes);
    stop = record('native-stop', stopBody);
    report.stop = stop;
    child.stop = stop;
    accounting.receipts = accounting.participants.flatMap((entry) => readComparisonUsage(entry));
    accounting.evidence = [
      ...(guardRefs ?? [record('guard', guard)]),
      primary('budget-0000000000000002.json', {
        limit: request.budget.maxManagedStarts,
        used: 2,
        manifest: budget,
      }),
      ...accounting.participants.map((entry) =>
        primary('complete-' + digest(entry.session) + '.json', {
          participant: entry,
          completion: {
            outcome: 'completed',
            stop:
              entry === participant
                ? stop
                : record('other-stop', { ...stopBody, sessions: [entry.session] }),
            evidence: [physical],
          },
        }),
      ),
    ];
    projection.caseReport = record('case', report);
    child.projection = record('projection', projection);
    child.nativeAcceptance = record(
      'acceptance',
      acceptance ?? nativeAcceptance(projection.caseReport as InputRef),
    );
    const childRef = record('child', child),
      keeper = record('keeper', {
        ...clean,
        kind: label + '-keeper-stop',
        opId,
        ready: true,
        softStop: false,
        forcedStop: false,
        error: null,
        evidence: [childRef],
      });
    const owned = {
      ...bindingReport,
      kind: comparisonKind(scenario, 'owned-report'),
      executionVersion: 2,
      outcome: 'accepted',
      child: childRef,
      stop: keeper,
      evidence: [childRef, keeper],
      accounting,
      timing,
      elapsedMs: 100,
    };
    const outer = {
      ...bindingReport,
      kind: comparisonKind(scenario, 'operator-report'),
      schemaVersion: 1,
      requestRef: f.requestRef,
      specRef: f.specRef,
      outcome: 'accepted',
      error: null,
      errors: [],
      timedOut: false,
      budget: request.budget,
      startedNs: '10000000000',
      endedNs: '46000000000',
      deadlineNs: '70000000000',
      elapsedMs: 36000,
      child: { ...owned, report: record('owned', owned) },
      stops,
      portStops: ports,
      evidence: [
        ...stops.map((entry) =>
          record('stop-' + entry.name, {
            ...entry.receipt,
            pid: entry.pid,
            error: null,
            owned: true,
          }),
        ),
        record('ports-stopped', { portStops: ports }),
      ],
    };
    // STOP filenames are primary contract fields, not labels chosen by the caller.
    outer.evidence = stops
      .map((entry) =>
        primary('stop-' + entry.name + '-unit.json', {
          ...entry.receipt,
          pid: entry.pid,
          error: null,
          owned: true,
        }),
      )
      .concat(primary('ports-stopped-unit.json', { portStops: ports }));
    return {
      runId: scenario + ':1:' + request.variant,
      opId,
      request: f.requestRef,
      spec: f.specRef,
      operator: { ...outer, report: record('outer', outer) },
    };
  };
  return {
    f,
    report,
    projection,
    guard,
    child,
    rows,
    accounting,
    stopBody,
    refresh,
    record,
    setGuards(refs: InputRef[]) {
      guardRefs = refs;
    },
    addParticipant() {
      const path = join(f.root, 'other-transcript.jsonl'),
        line = canonical({ type: 'session_meta', payload: { id: 'other-session' } }) + '\n';
      writeFileSync(path, line);
      accounting.participants.push({
        ...participant,
        session: 'other-session',
        transcript: path,
        through: { locator: path + '#L1', hash: digest(line) },
      });
    },
    setAcceptance(value: Record<string, unknown>) {
      acceptance = value;
    },
  };
}
describe('H04 series primary normalization', () => {
  it.each([false, true])(
    'verifies native wait, effects, application, SDK payloads and full STOP; candidate=%s',
    async (candidate) => {
      const f = await h04SeriesEvidenceFixture(candidate),
        summary = seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-04');
      expect(summary).toMatchObject({
        outcome: 'accepted',
        stopped: true,
        accounting: { unknown: false },
        partialScope: true,
        qualification: false,
        blocking: [],
      });
    },
  );
  it.each([
    'case',
    'session',
    'stop',
    'operation',
    'wait',
    'effect',
    'acceptance',
    'sdk',
    'model-free',
  ] as const)('rejects substituted H04 %s evidence', async (mode) => {
    const f = await h04SeriesEvidenceFixture(mode === 'sdk');
    if (mode === 'case') f.report.scenario = 'H-03' as 'H-04';
    if (mode === 'session') f.report.session = 'another-session';
    if (mode === 'stop') f.stopBody.confirmed = false;
    if (mode === 'operation') f.changeOperation({ requestHash: 'f'.repeat(64) });
    if (mode === 'wait') f.report.nativeWait!.sessionId = 999;
    if (mode === 'effect')
      writeFileSync(join(f.operation.outputRoot, 'effects', 'extra'), 'unexpected');
    if (mode === 'acceptance')
      f.setAcceptance({ kind: 'comparison-h04-native-acceptance', qualification: false });
    if (mode === 'sdk') f.report.primary.history = f.record('empty-history', { events: [] });
    if (mode === 'model-free')
      f.changeOperation({ kind: 'comparison-h04-model-free' as H04NativeOperationRequest['kind'] });
    const summary = seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-04');
    expect(summary.outcome).toBe('unknown');
    expect(summary.blocking).toContain('invalid-primary-evidence');
  });
});

describe('H04 series source substitutions', () => {
  it.each([
    ['projection', 'kind', 'comparison-h03-native-projection'],
    ['projection', 'scenario', 'H-03'],
    ['projection', 'opId', 'other-op'],
    ['projection', 'engine', 'temporal'],
    ['report', 'kind', 'comparison-h03-case'],
    ['report', 'scenario', 'H-03'],
    ['report', 'opId', 'other-op'],
    ['report', 'engine', 'temporal'],
    ['report', 'outcome', 'failed'],
    ['report', 'checks', {}],
    ['report', 'blocking', ['not-proven']],
    ['report', 'nativeAcceptance', true],
    ['report', 'qualification', true],
    ['report', 'partialScope', false],
  ])('refuses %s.%s', async (owner, field, value) => {
    const f = await h04SeriesEvidenceFixture();
    object(owner === 'projection' ? f.projection : f.report)[String(field)] = value;
    expect(seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-04').outcome).toBe(
      'unknown',
    );
  });
  it.each([
    'false-check',
    'stage',
    'primary-fields',
    'operation-path',
    'missing-runtime-waiter',
    'participant-count',
  ] as const)('refuses %s', async (mode) => {
    const f = await h04SeriesEvidenceFixture(false, mode === 'missing-runtime-waiter');
    if (mode === 'false-check') {
      const name = Object.keys(f.report.checks)[0]!;
      f.report.checks = { ...f.report.checks, [name]: false };
      f.child.checks = f.report.checks;
    }
    if (mode === 'participant-count') f.addParticipant();
    if (mode === 'stage') f.accounting.participants[0]!.stage = 'council';
    if (mode === 'primary-fields') object(f.report.primary).extra = f.report.primary.result;
    if (mode === 'operation-path') f.report.request = f.record('relocated-operation', f.operation);
    expect(seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-04').outcome).toBe(
      'unknown',
    );
  });
  it.each([
    ['extra', true],
    ['kind', 'comparison-h04-model-free'],
    ['schemaVersion', 2],
    ['opId', 'other-op'],
    ['requestHash', 'f'.repeat(64)],
    ['material', null],
    ['engine', 'temporal'],
    ['operationId', 'other-operation'],
    ['outputRoot', '/different-output'],
    ['workspace', '/different-workspace'],
    ['node', null],
    ['waiter', null],
    ['deadlineNs', '1'],
    ['deadlineNs', '999999999999'],
  ])('refuses a substituted operation %s=%s', async (field, value) => {
    const f = await h04SeriesEvidenceFixture();
    f.changeOperation({ [String(field)]: value });
    expect(seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-04').outcome).toBe(
      'unknown',
    );
  });
});

describe('H04 series guard binding', () => {
  it.each(['missing', 'duplicate', 'request', 'before', 'after'] as const)(
    'refuses guard %s',
    async (mode) => {
      const f = await h04SeriesEvidenceFixture();
      if (mode === 'missing') f.setGuards([]);
      if (mode === 'duplicate')
        f.setGuards([f.record('guard-a', f.guard), f.record('guard-b', f.guard)]);
      if (mode === 'request') {
        const request = structuredClone(f.f.request);
        request.authorization.anchor.turn_id = 'another-grant';
        f.guard.request = f.record('other-request', request);
        f.guard.authorization = request.authorization;
      }
      if (mode === 'before' || mode === 'after') {
        const start = mode === 'before' ? 9_000_000_000n : 50_000_000_000n;
        f.guard.startedNs = String(start);
        f.guard.deadlineNs = String(start + 60_000_000_000n);
        f.guard.workDeadlineNs = String(start + 58_000_000_000n);
      }
      expect(seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-04').outcome).toBe(
        'unknown',
      );
    },
  );
});

describe('H05 versioned comparison series', () => {
  it('plans exactly the first twenty immutable schedule slots without granting a provider', async () => {
    const f = versionedSeriesFixture(5),
      plan = await planH01Series(f.manifestRef);
    expect(plan).toMatchObject({
      schemaVersion: 5,
      mayRun: false,
      allowedModelStarts: 0,
      partialScope: true,
      qualification: false,
    });
    expect(plan.executable).toHaveLength(20);
    expect(plan.schedule).toHaveLength(24);
    expect(plan.executable.map((slot) => slot.runId)).toEqual(
      plan.schedule.slice(0, 20).map((slot) => slot.id),
    );
    expect(f.operator).not.toHaveBeenCalled();
    expect(existsSync(f.manifest.outputRoot)).toBe(false);
  });
  it.each([16, 17, 18, 19])(
    'continues the persisted prefix at H05 slot %s and retains shared replay safety',
    async (slotIndex) => {
      const f = versionedSeriesFixture(5),
        previous = await seedSeriesPrefix(f, slotIndex),
        command = f.command(slotIndex, previous),
        result = await stepH01Series(command);
      expect(result.records).toHaveLength(slotIndex + 1);
      expect(result.schemaVersion).toBe(5);
      if (slotIndex === 16) expect((await stepH01Series(command)).records).toHaveLength(17);
      if (slotIndex === 19)
        expect(statusH01Series(f.statePath)).toMatchObject({
          schemaVersion: 5,
          status: 'adapter-required',
          next: 'H-06:1:baseline',
        });
      expect(f.operator).toHaveBeenCalledTimes(1);
      expect(f.operator.mock.calls[0]![3]).toBe('H-05');
    },
    30_000,
  );
  it.each(['v4', 'incomplete', 'command-version', 'h04-request'] as const)(
    'refuses an H05 version/scenario substitution: %s',
    async (mode) => {
      const f = versionedSeriesFixture(5);
      if (mode === 'v4') {
        f.manifest.schemaVersion = 4;
        f.save();
        await expect(planH01Series(f.manifestRef)).rejects.toThrow('series-step-order');
      }
      if (mode === 'incomplete') {
        f.manifest.steps.pop();
        f.save();
        await expect(planH01Series(f.manifestRef)).rejects.toThrow('series-step-order');
      }
      if (mode === 'command-version')
        await expect(stepH01Series(f.command(0, null, { schemaVersion: 4 }))).rejects.toThrow(
          'series-step-command-version',
        );
      if (mode === 'h04-request') {
        f.operations[16]!.request.kind = 'comparison-h04-execution';
        f.operations[16]!.publish();
        f.manifest.steps[16]!.request = f.operations[16]!.requestRef;
        f.save();
        await expect(planH01Series(f.manifestRef)).rejects.toThrow('h01-version');
      }
      expect(f.operator).not.toHaveBeenCalled();
    },
  );
});

describe('H06 in the version 6 comparison series', () => {
  it('plans exactly 24 ordered slots with four H06 plans and no starts', async () => {
    const f = versionedSeriesFixture(6);
    const plan = await planH01Series(f.manifestRef);
    expect(plan).toMatchObject({
      schemaVersion: 6,
      mayRun: false,
      allowedModelStarts: 0,
      partialScope: true,
      qualification: false,
    });
    expect(plan.executable).toHaveLength(24);
    expect(plan.executable.map((slot) => slot.runId)).toEqual(plan.schedule.map((slot) => slot.id));
    const original = checkComparisonReadiness({}).schedule;
    const acceptedMaterial = object(JSON.parse(readFileSync(h06Assets().materials.path, 'utf8')))
      .cases as Array<{ id: string }>;
    expect(plan.schedule.slice(0, 20)).toEqual(original.slice(0, 20));
    expect(plan.schedule.slice(20)).toEqual(
      original.slice(20).map((slot) => ({
        ...slot,
        material_hash: digest(canonical(acceptedMaterial.find(({ id }) => id === 'H-06'))),
      })),
    );
    expect(plan.schedule[20]!.material_hash).not.toBe(original[20]!.material_hash);
    expect(f.h06Plan.mock.calls).toEqual(f.h06Steps.map(({ spec, request }) => [spec, request]));
    expect(f.operator).not.toHaveBeenCalled();
    expect(f.h06Run).not.toHaveBeenCalled();
    expect(existsSync(f.manifest.outputRoot)).toBe(false);
  });

  it('emits the saved H06 receipt before the blocked step report', async () => {
    const f = versionedSeriesFixture(6);
    const previous = await seedSeriesPrefix(f, 20);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const earlier = f.command(20, previous);
    await h01SeriesMain(['--step', earlier.locator]);
    expect(stderr).not.toHaveBeenCalled();

    const first = statusH01Series(f.statePath);
    const blocked = f.command(21, first.state);
    const body = { startedNs: String(now), endedNs: String(now) };
    const receipt = f.first.pin('h06-operator-receipt.json', canonical(body));
    f.h06Run.mockResolvedValueOnce({
      ...body,
      receipt,
    } as Awaited<ReturnType<typeof h06OperatorModule.runH06Operator>>);
    const original = f.h06Evidence.getMockImplementation()!;
    f.h06Evidence.mockImplementation((input) => {
      const evidence = original(input);
      if (input.runId === f.h06Steps[1]!.runId) {
        evidence.outcome = 'unknown';
        evidence.blocking = ['h06-series-whole-attempt-accounting-unknown'];
        evidence.evidence = [input.spec, receipt];
      }
      return evidence;
    });

    stdout.mockClear();
    await h01SeriesMain(['--step', blocked.locator]);
    expect(stderr.mock.calls).toEqual([['comparison-h06-step-record:' + receipt.hash + '\n']]);
    expect(stderr.mock.invocationCallOrder[0]!).toBeLessThan(stdout.mock.invocationCallOrder[0]!);
    expect(process.exitCode).toBe(1);
    const saved = statusH01Series(f.statePath);
    expect(saved).toMatchObject({ status: 'blocked', pending: null });
    expect(object(saved.records.at(-1)!.operator).receipt).toEqual(receipt);
    await h01SeriesMain(['--status', f.statePath]);
    await h01SeriesMain(['--step', earlier.locator]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(f.h06Run).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('executes each separate H06 step and completes the local ledger without qualification', async () => {
    const f = versionedSeriesFixture(6);
    let previous = await seedSeriesPrefix(f, 20);
    for (let index = 20; index < 24; index++) {
      const command = f.command(index, previous);
      const result = await stepH01Series(command);
      const step = f.h06Steps[index - 20]!;
      expect(f.h06Run).toHaveBeenLastCalledWith(step.spec, step.request, expect.any(AbortSignal), {
        wall: Date.now(),
        ns: now,
      });
      expect(result).toMatchObject({
        schemaVersion: 6,
        status: index === 23 ? 'complete' : 'ready',
        next: f.h06Steps[index - 19]?.runId ?? null,
        partialScope: true,
        qualification: false,
        pending: null,
      });
      expect(result.records.at(-1)?.evidence.mapping).toEqual({
        runId: step.runId,
        opId: step.binding.opId,
      });
      if (index === 23) expect(await stepH01Series(command)).toEqual(result);
      previous = result.state;
    }
    expect(statusH01Series(f.statePath).records).toHaveLength(24);
    expect(f.h06Run).toHaveBeenCalledTimes(4);
    expect(f.operator).not.toHaveBeenCalled();
  }, 30_000);

  it.each([
    'variant',
    'stimulus',
    'runtime',
    'output-runtime',
    'reused-root',
    'mutable-input',
    'packet-input',
    'authority-root',
  ] as const)('refuses an H06 %s mismatch before a start', async (mode) => {
    const f = versionedSeriesFixture(6);
    const first = f.h06Steps[0]!.binding;
    const other = f.h06Steps[1]!.binding;
    let error = 'series-step-output-overlap';
    if (mode === 'variant') {
      first.variant = 'candidate';
      error = 'series-step-slot-binding';
    }
    if (mode === 'stimulus') {
      first.longStageMs++;
      error = 'series-step-stimulus-mismatch';
    }
    if (mode === 'runtime') {
      first.runtime = f.operations[0]!.request.runtime;
      error = 'series-step-runtime-binding';
    }
    if (mode === 'output-runtime') first.roots[0] = runtimeRoot;
    if (mode === 'reused-root') {
      first.roots[0] = other.roots[0]!;
      error = 'series-step-roots-overlap';
    }
    if (mode === 'mutable-input')
      first.pins.push({ locator: join(first.workspaceRoot, 'input.json'), hash: 'a'.repeat(64) });
    if (mode === 'packet-input')
      first.pins.push({ locator: first.packetPaths[0]!, hash: 'a'.repeat(64) });
    if (mode === 'authority-root') first.chatRoot = f.manifest.outputRoot;
    await expect(planH01Series(f.manifestRef)).rejects.toThrow(error);
    expect(f.h06Plan).not.toHaveBeenCalled();
    expect(f.h06Run).not.toHaveBeenCalled();
  });

  it('rejects a different sealed request and prevents replay after an interrupted H06 call', async () => {
    const f = versionedSeriesFixture(6);
    const previous = await seedSeriesPrefix(f, 20);
    await expect(
      stepH01Series(f.command(20, previous, { request: f.h06Steps[1]!.request })),
    ).rejects.toThrow('series-step-request-binding');
    const command = f.command(20, previous);
    f.h06Run.mockRejectedValueOnce(new Error('H06 interrupted'));
    await expect(stepH01Series(command)).rejects.toThrow('H06 interrupted');
    expect(statusH01Series(f.statePath)).toMatchObject({
      status: 'pending',
      next: null,
      pending: { runId: f.h06Steps[0]!.runId },
    });
    await expect(stepH01Series(command)).rejects.toThrow('series-step-pending');
    expect(f.h06Run).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('keeps pending and refuses H06 dispatch when persisting the claim consumes its reserve', async () => {
    const f = versionedSeriesFixture(6);
    const previous = await seedSeriesPrefix(f, 20);
    const base = Date.now();
    const writeCost = () => (existsSync(join(f.manifest.outputRoot, 'pending.json')) ? 450_000 : 0);
    vi.spyOn(Date, 'now').mockImplementation(() => base + writeCost());
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(
      () => now + BigInt(writeCost()) * 1_000_000n,
    );
    await expect(stepH01Series(f.command(20, previous))).rejects.toThrow('series-step-time-cap');
    expect(statusH01Series(f.statePath)).toMatchObject({ status: 'pending', next: null });
    expect(f.h06Run).not.toHaveBeenCalled();
  }, 30_000);

  it.each(['accounting', 'missing-start', 'missing-end', 'early', 'reversed', 'late'] as const)(
    'blocks the next step when H06 %s cannot be confirmed',
    async (mode) => {
      const f = versionedSeriesFixture(6);
      const primary = f.h06Evidence.getMockImplementation()!;
      f.h06Evidence.mockImplementation((input) => {
        const evidence = primary(input);
        if (mode === 'accounting') {
          evidence.outcome = 'unknown';
          evidence.accounting.unknown = true;
          evidence.accounting.observedResponses = null;
          evidence.blocking.push('h06-series-whole-attempt-accounting-unknown');
          evidence.evidence.push(input.spec);
        }
        if (mode === 'missing-start') evidence.startedNs = null;
        if (mode === 'missing-end') evidence.endedNs = null;
        if (mode === 'early') evidence.startedNs = String(now - 1n);
        if (mode === 'reversed') evidence.endedNs = String(now - 1n);
        if (mode === 'late') evidence.endedNs = String(now + 1n);
        return evidence;
      });
      const command = f.command(20, await seedSeriesPrefix(f, 20));
      const result = await stepH01Series(command);
      expect(result.status).toBe('blocked');
      expect(result.blocked).toContain(
        mode === 'accounting'
          ? 'h06-series-whole-attempt-accounting-unknown'
          : 'series-step-operator-clock',
      );
      expect(result.records.at(-1)?.evidence.outcome).toBe('unknown');
      expect(result.next).toBeNull();
      await expect(stepH01Series(f.command(21, result.state))).rejects.toThrow(
        'series-step-blocked',
      );
      if (mode === 'accounting') {
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        await h01SeriesMain(['--step', command.locator]);
        expect(stderr).not.toHaveBeenCalled();
      }
      expect(f.h06Run).toHaveBeenCalledTimes(1);
    },
    30_000,
  );
});

/** Exercise append-only series persistence with a fixed native accounting verifier. */
async function h06ReconciliationFixture(original: 'unknown' | 'failed' = 'unknown') {
  const f = versionedSeriesFixture(6);
  const primary = f.h06Evidence.getMockImplementation()!;
  f.h06Evidence.mockImplementation((input, settlement) => {
    const evidence = primary(input);
    evidence.evidence = [input.spec];
    if (settlement === undefined) {
      evidence.outcome = original;
      evidence.knownSubtotal.output = 3;
      evidence.accounting.inputUncached = null;
      evidence.accounting.unknown = true;
      evidence.blocking = ['h06-series-whole-attempt-accounting-unknown'];
      return evidence;
    }
    const update = object(h01ReadJson(settlement));
    const result: ReturnType<typeof h06OperatorModule.normalizeH06SeriesEvidence> = {
      ...evidence,
      checks: Object.fromEntries(h06Checks.map((key) => [key, true])),
      evidence: [...evidence.evidence, settlement],
      reconciliation: {
        window: { startedAtMs: 0, endedAtMs: 0 },
        externalTurns: ['coordinator:closed'],
      },
      ...update,
    };
    if (update.reconciliation === null) delete result.reconciliation;
    return result;
  });
  const initial = await seedSeriesPrefix(f, 20);
  const originalCommand = f.command(20, initial);
  const blocked = await stepH01Series(originalCommand);
  expect(blocked.status).toBe('blocked');
  const startWall = Date.now(),
    startNs = now;
  const time = (ms: number) => {
    vi.spyOn(Date, 'now').mockReturnValue(startWall + ms);
    now = startNs + BigInt(ms) * 1_000_000n;
  };
  time(20);
  let ordinal = 0;
  const rowPath = (index: number) => join(f.manifest.outputRoot, 'record-' + index + '.json');
  const refOf = (locator: string) => ({ locator, hash: digest(readFileSync(locator)) });
  const receiptPath = join(f.manifest.outputRoot, 'reconciliation-20.json');
  const make = (
    updated: Record<string, unknown> = {},
    command: Record<string, unknown> = {},
    index = 20,
  ) => {
    const id = ordinal++;
    const record = object(JSON.parse(readFileSync(rowPath(index), 'utf8')));
    const settlement = f.first.pin(
      'settlement-' + id + '.json',
      canonical({
        reconciliation: {
          window: { startedAtMs: record.startedAtMs, endedAtMs: Date.now() },
          externalTurns: ['coordinator:closed'],
        },
        ...updated,
      }),
    );
    const request = f.first.pin(
      'reconcile-' + id + '.json',
      canonical({
        kind: 'comparison-h01-series-reconcile',
        schemaVersion: 6,
        manifest: f.manifestRef,
        runId: record.runId,
        previousState: refOf(f.statePath),
        record: refOf(rowPath(index)),
        settlement,
        ...command,
      }),
    );
    return { request, settlement };
  };
  return { ...f, originalCommand, blocked, time, startWall, rowPath, receiptPath, make, refOf };
}

describe('H06 series reconciliation', () => {
  it('keeps the original bytes, charges elapsed reconciliation and permits the next exact step', async () => {
    const f = await h06ReconciliationFixture();
    const before = f.refOf(f.statePath),
      record = f.refOf(f.rowPath(20));
    const { request } = f.make();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await h01SeriesMain(['--reconcile', request.locator]);
    const lock = join(f.manifest.outputRoot, 'writer');
    mkdirSync(lock, { mode: 0o700 });
    const settled = reconcileH01Series(request);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
    expect(output).toHaveBeenCalledWith(canonical(settled) + '\n');
    expect(settled).toMatchObject({
      status: 'ready',
      next: f.h06Steps[1]!.runId,
      state: before,
      blocked: [],
      elapsedMs: f.blocked.elapsedMs + 20,
      observedAtMs: f.startWall + 20,
      records: f.blocked.records,
      reconciliations: [f.refOf(f.receiptPath)],
    });
    expect(f.refOf(f.statePath)).toEqual(before);
    expect(f.refOf(f.rowPath(20))).toEqual(record);
    expect(f.h06Run).toHaveBeenCalledTimes(1);
    expect(f.operator).not.toHaveBeenCalled();
    expect(() => reconcileH01Series(f.make().request)).toThrow('series-reconciliation-conflict');

    f.time(10);
    await expect(stepH01Series(f.command(21, settled.state))).rejects.toThrow('series-step-clock');
    f.time(30);
    const next = await stepH01Series(f.command(21, settled.state));
    expect(next).toMatchObject({
      status: 'blocked',
      elapsedMs: f.blocked.elapsedMs + 30,
    });
    expect(next.records).toContainEqual(f.blocked.records.at(-1)!);
    f.time(40);
    const duplicate = f.make({}, {}, 21);
    expect(() => reconcileH01Series(duplicate.request)).toThrow('series-reconciliation-turn-reuse');
    const originalReceipt = readFileSync(f.receiptPath);
    rmSync(f.receiptPath);
    expect(() => reconcileH01Series(duplicate.request)).toThrow('series-reconciliation-order');
    writeFileSync(f.receiptPath, originalReceipt, { mode: 0o600 });
    const distinct = f.make(
      {
        reconciliation: {
          window: { startedAtMs: f.startWall + 30, endedAtMs: f.startWall + 40 },
          externalTurns: ['coordinator:another-closed-turn'],
        },
      },
      {},
      21,
    );
    expect(reconcileH01Series(distinct.request)).toMatchObject({
      status: 'ready',
      next: f.h06Steps[2]!.runId,
      reconciliations: [
        f.refOf(f.receiptPath),
        f.refOf(join(f.manifest.outputRoot, 'reconciliation-21.json')),
      ],
    });
    expect(f.h06Run).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('refuses incomplete, moved, budget-reducing, stale or out-of-window settlements', async () => {
    const f = await h06ReconciliationFixture();
    const state = f.refOf(f.statePath);
    const window = { startedAtMs: f.startWall, endedAtMs: f.startWall + 20 };
    const usage = f.blocked.records.at(-1)!.evidence.accounting;
    const cases = [
      [{ stopped: false }, {}, 'series-reconciliation-unconfirmed'],
      [{ startedNs: '0' }, {}, 'series-reconciliation-unconfirmed'],
      [{ endedNs: '0' }, {}, 'series-reconciliation-unconfirmed'],
      [{ operatorElapsedMs: 99 }, {}, 'series-reconciliation-unconfirmed'],
      [{ mapping: {} }, {}, 'series-reconciliation-unconfirmed'],
      [{ partialScope: false }, {}, 'series-reconciliation-unconfirmed'],
      [{ qualification: true }, {}, 'series-reconciliation-unconfirmed'],
      [{ checks: {} }, {}, 'series-reconciliation-unconfirmed'],
      [{ evidence: [] }, {}, 'series-reconciliation-unconfirmed'],
      [{ reconciliation: null }, {}, 'series-reconciliation-unconfirmed'],
      [
        { accounting: { ...usage, unknown: false, inputUncached: 10, reservedManagedStarts: 1 } },
        {},
        'series-reconciliation-budget-cap',
      ],
      [
        { accounting: { ...usage, unknown: false, inputUncached: 1 } },
        {},
        'series-reconciliation-budget-cap',
      ],
      [
        { accounting: { ...usage, unknown: false, inputUncached: 10, output: 0 } },
        {},
        'series-reconciliation-budget-cap',
      ],
      ...[
        { ...window, startedAtMs: f.startWall - 1 },
        { ...window, startedAtMs: f.startWall + 1 },
        { ...window, endedAtMs: f.startWall - 1 },
        { ...window, endedAtMs: f.startWall + 21 },
      ].map(
        (bounds) =>
          [
            { reconciliation: { window: bounds, externalTurns: ['coordinator:closed'] } },
            {},
            'series-reconciliation-window',
          ] as const,
      ),
      ...[[], ['same', 'same']].map(
        (externalTurns) =>
          [
            { reconciliation: { window, externalTurns } },
            {},
            'series-reconciliation-turn-reuse',
          ] as const,
      ),
      [{}, { kind: 'step' }, 'series-reconciliation-version'],
      [{}, { schemaVersion: 5 }, 'series-reconciliation-version'],
      [{}, { previousState: { ...state, hash: 'b'.repeat(64) } }, 'series-reconciliation-binding'],
      [{}, { previousState: f.manifestRef }, 'series-reconciliation-binding'],
      [{}, { record: state }, 'series-reconciliation-binding'],
      [{}, { settlement: state }, 'series-reconciliation-binding'],
      [{}, { runId: 'unknown' }, 'series-reconciliation-binding'],
      [{}, { runId: f.manifest.steps[19]!.runId }, 'series-reconciliation-binding'],
    ] as const;
    for (const [updates, command, error] of cases)
      expect(() => reconcileH01Series(f.make(updates, command).request)).toThrow(error);
    expect(f.refOf(f.statePath)).toEqual(state);
    expect(existsSync(f.receiptPath)).toBe(false);
    expect(f.h06Run).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('keeps a terminal budget failure and its known cost after a valid settlement', async () => {
    const f = await h06ReconciliationFixture();
    const usage = f.blocked.records.at(-1)!.evidence.accounting;
    const { request } = f.make({
      outcome: 'failed',
      blocking: ['h06-series-whole-attempt-budget-exceeded'],
      accounting: { ...usage, unknown: false, inputUncached: 10, output: 51 },
    });
    const settled = reconcileH01Series(request);
    expect(settled).toMatchObject({ status: 'blocked', next: null, records: f.blocked.records });
    expect(settled.blocked).toEqual([
      'h06-series-whole-attempt-budget-exceeded',
      'series-step-budget-cap',
    ]);
    const receipt = object(h01ReadJson(f.refOf(f.receiptPath)));
    expect(receipt.evidence).toMatchObject({ outcome: 'failed', accounting: { output: 51 } });
  }, 30_000);

  it('refuses to replace an original FAIL with a settlement', async () => {
    const f = await h06ReconciliationFixture('failed');
    expect(() => reconcileH01Series(f.make().request)).toThrow('series-reconciliation-original');
    expect(existsSync(f.receiptPath)).toBe(false);
  }, 30_000);

  it('reopens pinned primary evidence and rejects a tampered receipt and namespace', async () => {
    const f = await h06ReconciliationFixture();
    const { request, settlement } = f.make();
    const malformed = join(f.manifest.outputRoot, 'reconciliation-999.json');
    writeFileSync(malformed, '{}', { mode: 0o600 });
    expect(() => statusH01Series(f.statePath)).toThrow('series-reconciliation-order');
    rmSync(malformed);
    reconcileH01Series(request);
    const prior = object(h01ReadJson(f.refOf(f.receiptPath)));
    const writeReceipt = (update: Record<string, unknown>) => {
      writeFileSync(f.receiptPath, canonical({ ...prior, ...update }), { mode: 0o600 });
    };
    const expectBadReceipt = (value: Record<string, unknown>, error: string) => {
      writeReceipt(value);
      expect(() => statusH01Series(f.statePath)).toThrow(error);
    };
    expectBadReceipt({ kind: 'changed' }, 'series-reconciliation-receipt');
    expectBadReceipt({ schemaVersion: 7 }, 'series-reconciliation-receipt');
    expectBadReceipt({ observedNs: 'bad' }, 'series-reconciliation-receipt');
    expectBadReceipt({ observedNs: 0 }, 'series-reconciliation-receipt');
    expectBadReceipt({ elapsedMs: 'unexpected' }, 'series-reconciliation-receipt');
    expectBadReceipt({ elapsedMs: 12345 }, 'series-reconciliation-time-cap');
    expectBadReceipt({ evidence: false }, 'series-reconciliation-changed');
    const command = object(h01ReadJson(request));
    const swappedFields = [
      { manifest: f.refOf(f.statePath) },
      { runId: 'crossed' },
      { previousState: f.manifestRef },
      { previousState: { ...f.refOf(f.statePath), hash: 'b'.repeat(64) } },
      { record: f.refOf(f.statePath) },
      { settlement: f.refOf(f.statePath) },
    ];
    for (const [index, fields] of swappedFields.entries())
      expectBadReceipt(
        {
          command: f.first.pin('swapped-' + index + '.json', canonical({ ...command, ...fields })),
        },
        'series-reconciliation-binding',
      );
    writeReceipt({});
    writeFileSync(settlement.locator, '{}', { mode: 0o600 });
    expect(() => statusH01Series(f.statePath)).toThrow('h01-pin-changed');
    expect(f.h06Run).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('refuses while pending, under another writer or after the total deadline', async () => {
    const f = await h06ReconciliationFixture();
    const { request } = f.make();
    const signal = AbortSignal.abort(new Error('fixture interrupted'));
    expect(() => reconcileH01Series(request, signal)).toThrow('fixture interrupted');
    const lock = join(f.manifest.outputRoot, 'writer');
    mkdirSync(lock, { mode: 0o700 });
    expect(() => reconcileH01Series(request)).toThrow('EEXIST');
    rmSync(lock, { recursive: true });
    const pending = join(f.manifest.outputRoot, 'pending.json');
    writeFileSync(pending, 'null', { mode: 0o600 });
    expect(() => reconcileH01Series(request)).toThrow('series-reconciliation-pending');
    rmSync(pending);
    f.time(f.manifest.cap.maxElapsedMs);
    expect(() => reconcileH01Series(request)).toThrow('series-reconciliation-time-cap');
    expect(existsSync(f.receiptPath)).toBe(false);
  }, 30_000);
});

/** Real persisted LocalRun/event replay with synthetic native/process primary records; SDK boundary has its own owner suite. */
async function h05SeriesEvidenceFixture(
  candidate = false,
  missingRuntime: 'none' | 'descriptor' | 'procedure' = 'none',
  executorSubstitution = false,
  recoverySubstitution:
    | 'none'
    | 'missing-resume'
    | 'creation-receipt'
    | 'missing-read'
    | 'missing-retired-stop'
    | 'missing-current-stop'
    | 'same-process' = 'none',
) {
  const f = fixture(candidate, 'H-05'),
    request = f.request,
    opId = request.opId;
  let ordinal = 0;
  const record = (name: string, value: unknown) =>
    f.pin('h05-' + name + '-' + ordinal++ + '.json', canonical(value) + '\n');
  const primary = (name: string, value: unknown, root = request.roots.evidenceRoot) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const locator = join(root, name),
      bytes = Buffer.from(JSON.stringify(value) + '\n');
    writeFileSync(locator, bytes, { mode: 0o600 });
    return { locator, hash: digest(bytes) };
  };
  const source = (locator: string, content: string) => {
    const path = join(request.roots.workspaceRoot, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { locator, hash: digest(content) };
  };
  const materials = object(
      JSON.parse(readFileSync(join(runtimeRoot, 'comparison/materials.json'), 'utf8')),
    ),
    suite = parseComparisonSuite(
      JSON.parse(readFileSync(join(runtimeRoot, 'comparison/suite.json'), 'utf8')),
    ),
    scenario = suite.scenarios[4]!;
  request.material = record('material', (materials.cases as unknown[])[4]);
  request.criteria = record('criteria', scenario);
  request.identity.generation = 2;
  request.budget.maxElapsedMs = 60000;
  request.budget.reserveMs = 2000;
  request.budget.maxInputUncached = 1000;
  request.budget.maxOutput = 1000;
  f.spec.budget = request.budget;
  const descriptorPath = join(runtimeRoot, 'project/workflow.json'),
    stock = object(JSON.parse(readFileSync(descriptorPath, 'utf8'))),
    stockProcedures = h05Procedures.flatMap((id) =>
      (stock.procedures as Procedure[]).filter((procedure) => procedure.id === id),
    );
  const runtime = object(h01ReadJson(request.runtime)),
    inventory = [
      ...(runtime.files as InputRef[]),
      ...(missingRuntime === 'descriptor'
        ? []
        : [{ locator: descriptorPath, hash: digest(readFileSync(descriptorPath)) }]),
      ...stockProcedures
        .filter((_, index) => missingRuntime !== 'procedure' || index !== 0)
        .map((procedure) => ({
          locator: join(runtimeRoot, procedure.locator),
          hash: procedure.hash,
        })),
    ];
  request.runtime = record('runtime', { ...runtime, files: inventory });
  f.publish();
  const requestHash = h01RequestHash(request),
    profile = parseH01Profile(request.profile),
    clean = { stopped: true, code: 0, signal: null, killed: false, deadlineReached: false };
  const check = record('checker', {
    kind: 'comparison-h05-check',
    opId,
    requestHash,
    material: request.material,
    cwd: request.roots.workspaceRoot,
    passed: false,
    stop: { ...clean, code: 1 },
    stdout: record('stdout', { id: 'F-01' }),
    stderr: record('stderr', ''),
  });
  const failure = record('failure', {
    kind: 'comparison-h05-initial-failure',
    opId,
    id: 'F-01',
    check,
  });
  const metadata = h05PreparedMetadata(
    readFileSync(profile.rules.locator, 'utf8'),
    readFileSync(profile.executor.locator, 'utf8'),
  );
  const assignment = source('.h05/task.md', h05Material.instructions + '\n'),
    rules = ['.h05/rules.md', '.h05/executor.md'].map((path) =>
      source(
        path,
        path === '.h05/executor.md' && executorSubstitution
          ? h05PreparedMetadata(
              readFileSync(profile.rules.locator, 'utf8'),
              'Substituted executor outside the pinned profile.',
            )[path]!
          : metadata[path]!,
      ),
    );
  const procedures = stockProcedures;
  for (const procedure of procedures)
    source(procedure.locator, readFileSync(join(runtimeRoot, procedure.locator), 'utf8'));
  const query: H05Binding['query'] = {
    kind: 'unknown-source',
    question: 'Read the H05 primary sources.',
    scope: ['evidence/'],
    sources: [assignment, failure],
    criterion: 'Preserve F-01 and the known native result.',
    format: 'JSON DataAnswer',
    rules,
    procedures,
    entrypoints: ['.h05/task.md'],
  };
  const session = 'h05-native-session',
    turn = 'h05-native-turn',
    transcript = join(f.root, 'h05-session.jsonl'),
    creation = record('creation', {
      operation: 'thread/start',
      session: {
        model: profile.model,
        reasoningEffort: profile.effort,
        cwd: request.roots.workspaceRoot,
        sandbox: { type: 'readOnly', networkAccess: false },
        thread: {
          id: session,
          path: transcript,
          cwd: request.roots.workspaceRoot,
          projectId: null,
          turns: [],
          agentRole: null,
          parentThreadId: null,
          forkedFromId: null,
        },
      },
      parent: null,
    });
  const binding: H05Binding = {
    kind: 'comparison-h05-binding',
    schemaVersion: 1,
    opId,
    requestHash,
    engine: candidate ? 'temporal' : 'legacy',
    identity: structuredClone(request.identity),
    material: request.material,
    failure,
    workspace: request.roots.workspaceRoot,
    stateRoot: join(request.roots.stateRoot, 'h05-waiting'),
    evidenceRoot: request.roots.evidenceRoot,
    session: {
      id: session,
      agent_role: null,
      native_project_id: null,
      parent_id: null,
      model: profile.model,
      effort: profile.effort,
      workspace: request.roots.workspaceRoot,
      project_id: 'h05-' + digest(opId).slice(0, 16),
      read_only: true,
      network: false,
      forked_from: null,
      initial_turns: 0,
      receipt: creation,
    },
    turn,
    deliveryId: opId + ':h05-known-turn',
    nativeTranscript: transcript,
    query,
  };
  let bindingRef = record('binding', binding);
  const answer = {
    outcome: 'PASS',
    scope: query.scope,
    sources: query.sources,
    coverage: 'complete',
    content: 'Known H05 read completed; original F-01 remains unresolved.',
    continuation: null,
    limitations: [],
  };
  const refs = [...query.rules, ...query.procedures, ...query.sources];
  const readItems = refs.flatMap((ref) => {
    const content = readFileSync(
      ref.locator.startsWith('/') ? ref.locator : join(request.roots.workspaceRoot, ref.locator),
      'utf8',
    );
    const pieces = [];
    for (let offset = 0; offset < content.length; offset += 7000) {
      const part = {
        format: 'aw-native-read-parts/1',
        path: ref.locator,
        sha256: ref.hash,
        content: content.slice(offset, offset + 7000),
        offset,
        length: content.length,
      };
      pieces.push({
        type: 'commandExecution',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: JSON.stringify(part) + '\n',
      });
    }
    return pieces;
  });
  const nativeTurn = {
    id: turn,
    status: 'completed',
    items: [
      {
        type: 'userMessage',
        content: [
          {
            type: 'text',
            text:
              'Workflow delivery id: ' +
              JSON.stringify(binding.deliveryId) +
              '\nSynthetic known native LOAD.',
          },
        ],
      },
      ...readItems,
      { type: 'agentMessage', text: canonical(answer) },
    ],
  };
  const load = record('load', {
    session,
    turn,
    refs: [...query.procedures, ...query.rules].map(({ locator, hash }) => ({ locator, hash })),
    observation: nativeTurn,
  });
  const response = { thread: { id: session, turns: [nativeTurn] } },
    rawPorts = [
      {
        path: join(request.roots.evidenceRoot, 'native-rpc-h05-initial', 'primary.jsonl'),
        lines: [] as string[],
        serial: 0,
      },
      {
        path: join(request.roots.evidenceRoot, 'native-rpc-h05-recovery', 'primary.jsonl'),
        lines: [] as string[],
        serial: 0,
      },
    ];
  for (const journal of rawPorts)
    mkdirSync(dirname(journal.path), { recursive: true, mode: 0o700 });
  const capture = (side: 'send' | 'recv', message: unknown, port = 0) => {
    const journal = rawPorts[port]!,
      line =
        JSON.stringify({ seq: journal.lines.length + 1, side, raw: JSON.stringify(message) }) +
        '\n';
    journal.lines.push(line);
    writeFileSync(journal.path, journal.lines.join(''), { mode: 0o600 });
    return { locator: journal.path + '#L' + journal.lines.length, hash: digest(line) };
  };
  const originalSession = object(h01ReadJson(creation)).session;
  const createId = ++rawPorts[0]!.serial;
  capture('send', {
    id: createId,
    method: 'thread/start',
    params: {
      projectId: null,
      cwd: binding.workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: false,
      allowProviderModelFallback: false,
      model: profile.model,
      config: { model_reasoning_effort: profile.effort },
    },
  });
  capture('recv', { id: createId, result: originalSession });
  const nativeCreation = record('native-creation', {
    kind: 'h01-native-dispatch',
    method: 'thread/start',
    params: object(JSON.parse(object(JSON.parse(rawPorts[0]!.lines[0]!)).raw as string)).params,
    response: originalSession,
  });
  const turnId = ++rawPorts[0]!.serial;
  capture('send', {
    id: turnId,
    method: 'turn/start',
    params: {
      threadId: session,
      input: [
        {
          type: 'text',
          text:
            'Workflow delivery id: ' +
            JSON.stringify(binding.deliveryId) +
            '\nSynthetic known native LOAD.',
        },
      ],
      environments: [
        {
          environmentId: 'local',
          cwd: binding.workspace,
          runtimeWorkspaceRoots: [binding.workspace],
        },
      ],
    },
  });
  capture('recv', { id: turnId, result: { turn: { id: turn } } });
  const progressMessage = {
      method: 'item/started',
      params: { threadId: session, turnId: turn, item: { type: 'commandExecution', id: 'read-0' } },
    },
    terminalMessage = { method: 'turn/completed', params: { threadId: session, turn: nativeTurn } };
  const progressSource = capture('recv', progressMessage),
    terminalSource = capture('recv', terminalMessage);
  const readTrace = (id: string, phase: string, port = 0) => {
    const rpcId = ++rawPorts[port]!.serial,
      params = { threadId: session, includeTurns: true },
      requestSource = capture('send', { id: rpcId, method: 'thread/read', params }, port),
      responseSource = capture('recv', { id: rpcId, result: response }, port);
    return record('primary-read', {
      kind: 'comparison-h05-primary-read',
      opId,
      id,
      phase,
      method: 'thread/read',
      params,
      response,
      requestSource,
      responseSource,
    });
  };
  const primaryRead = readTrace('initial', 'source');
  const rows: Record<string, unknown>[] = [
    { type: 'session_meta', payload: { id: session, cwd: binding.workspace } },
    { type: 'event_msg', payload: { type: 'task_started', thread_id: session, turn_id: turn } },
    ...readItems.map((item, index) => ({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: session,
        turn_id: turn,
        item: {
          id: 'read-' + index,
          type: 'CommandExecution',
          status: 'completed',
          exit_code: 0,
          aggregated_output: item.aggregatedOutput,
          cwd: request.roots.workspaceRoot,
        },
      },
    })),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: canonical(answer) }],
      },
    },
    {
      type: 'token_usage_record',
      payload: {
        thread_id: session,
        session_id: session,
        turn_id: turn,
        response_id: 'h05-response',
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
        thread_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', thread_id: session, turn_id: turn } },
  ];
  const rawContent = rows.map((row) => canonical(row) + '\n').join(''),
    prefixValue = {
      kind: 'comparison-h05-native-prefix',
      opId,
      transcript,
      content: rawContent,
      hash: digest(rawContent),
      bytes: Buffer.byteLength(rawContent),
    };
  const prefixBefore = record('prefix-before', prefixValue),
    prefixAfter = record('prefix-after', prefixValue);
  const physical = record('physical', {
    kind: 'writers-stopped',
    active_turn: false,
    remaining_terminals: 0,
    remaining_processes: 0,
    before_hash: digest(rawContent),
    after_hash: digest(rawContent),
    processes: [],
  });
  // Stable process identities are unit doubles, never evidence of live native qualification.
  const initialIdentity = { pid: 7001, parent: process.pid, started: 'unit-h05-initial-rpc' },
    recoveryIdentity =
      recoverySubstitution === 'same-process'
        ? { ...initialIdentity }
        : { pid: 7002, parent: process.pid, started: 'unit-h05-recovery-rpc' };
  const initialProcess = record('initial-rpc-process', {
      kind: 'h02-native-rpc-process',
      label: 'h05-initial',
      initial: initialIdentity,
    }),
    initialProcessStop = record('initial-process-stop', {
      kind: 'h02-native-process-stop',
      initial: initialIdentity,
      processes: [initialIdentity],
      confirmed: true,
    });
  const recoveryProcess = record('recovery-rpc-process', {
      kind: 'h02-native-rpc-process',
      label: 'h05-recovery',
      initial: recoveryIdentity,
    }),
    recoveryProcessStop = record('recovery-process-stop', {
      kind: 'h02-native-process-stop',
      initial: recoveryIdentity,
      processes: [recoveryIdentity],
      confirmed: true,
    });
  const detachedStop = record('detached-stop', {
    kind: 'comparison-h05-stop',
    executionVersion: 2,
    opId,
    confirmed: true,
    readersStopped: true,
    transportClosed: true,
    sessions: [session],
    remainingProcesses: [],
    evidence: [
      physical,
      initialProcess,
      ...(recoverySubstitution === 'missing-retired-stop' ? [] : [initialProcessStop]),
    ],
  });
  const detached = record('detached', {
    kind: 'comparison-h05-recovery-binding',
    opId,
    requestHash,
    binding: canonical({ opId, requestHash, identity: request.identity }),
    session,
    creation: nativeCreation,
    turn,
    pathObservation: null,
    transcript,
    stop: detachedStop,
    prefix: { bytes: Buffer.byteLength(rawContent), hash: digest(rawContent) },
  });
  const stopBody = {
    kind: 'comparison-h05-stop',
    executionVersion: 2,
    opId,
    confirmed: true,
    readersStopped: true,
    transportClosed: true,
    sessions: [session],
    remainingProcesses: [] as unknown[],
    evidence: [
      physical,
      detachedStop,
      detached,
      recoveryProcess,
      ...(recoverySubstitution === 'missing-current-stop' ? [] : [recoveryProcessStop]),
    ],
  };
  const report: H05CaseReport = {
    kind: 'comparison-h05-case',
    scenario: 'H-05',
    opId,
    engine: binding.engine,
    session,
    turn,
    outcome: 'accepted',
    checks: Object.fromEntries(h05ProbeIds.map((id) => [id, true])),
    blocking: [],
    binding: bindingRef,
    initial: { failure, load, state: null },
    native: { primary: primaryRead, prefixBefore, prefixAfter, journals: [] },
    probes: {},
    restart: { waiting: null, detached, resumed: null, state: null },
    retained: { before: null, after: null },
    stop: record('stop', stopBody),
    evidence: [failure, check, load, primaryRead, prefixBefore, prefixAfter, detached],
    nativeAcceptance: false,
    qualification: false,
    partialScope: true,
  };
  const spec: RunSpec = {
    project_id: binding.session.project_id,
    identity: { assignment_id: opId },
    assignment,
    product: false,
    run_id: opId,
    session_id: session,
    host_id: 'local',
    workspace: binding.workspace,
    parent_run_id: null,
    coordinator: false,
    role: null,
    fork_turns: 'none',
    scope: ['evidence/'],
    outcome: h05Material.instructions,
    criteria: [...scenario.checks],
    writer: binding.identity.owner,
    requested: { model: profile.model, effort: profile.effort, permissions: ['read'] },
    effective: { model: profile.model, effort: profile.effort, permissions: ['read'] },
    sources: [...query.sources, bindingRef],
    procedures,
    rules,
    procedure_loading: 'by-action',
    route: { kind: 'nonproduct' },
  };
  const runs = new AssignmentLocalRuns(binding.stateRoot);
  let retained: LocalRun | null = null;
  const snapshot = async (run: LocalRun) => {
    await runs.save(retained, run);
    retained = structuredClone(run);
    const locator = join(binding.stateRoot, 'assignment.json'),
      text = readFileSync(locator, 'utf8');
    return record('state', {
      kind: 'comparison-h05-state',
      opId,
      binding: bindingRef,
      source: { locator, hash: digest(text) },
      text,
    });
  };
  let run = startLocalRun(spec, binding.identity.generation);
  run = applyLocalEvent(run, {
    type: 'WAIT',
    event_id: opId + ':waiting',
    expected_revision: run.revision,
    generation: run.generation,
  });
  run = applyLocalEvent(run, {
    type: 'LOAD',
    event_id: opId + ':load',
    expected_revision: run.revision,
    generation: run.generation,
    receipt: {
      run_id: opId,
      session_id: session,
      procedures,
      rules,
      observed_read: load.locator,
      native: load,
    },
  });
  run = applyLocalEvent(run, {
    type: 'RESULT',
    event_id: opId + ':initial-failure',
    expected_revision: run.revision,
    generation: run.generation,
    session_id: session,
    source: failure,
    outcome: 'FAIL',
  });
  let previous = await snapshot(run);
  report.initial.state = previous;
  report.retained.before = previous;
  const result = record('known-result', {
    kind: 'comparison-h05-wait-result',
    binding: bindingRef,
    answer,
    source: primaryRead,
  });
  const event: LocalEvent = {
    type: 'RESULT',
    event_id: opId + ':known-result',
    expected_revision: run.revision,
    generation: run.generation,
    session_id: session,
    source: result,
    outcome: 'PASS',
  };
  const terminal = record('notification', {
      kind: 'comparison-h05-native-notification',
      opId,
      sequence: 2,
      message: terminalMessage,
      source: terminalSource,
    }),
    progress = record('progress', {
      kind: 'comparison-h05-native-notification',
      opId,
      sequence: 1,
      message: progressMessage,
      source: progressSource,
    });
  for (const id of h05ProbeIds) {
    const before = previous;
    let observation: Record<string, unknown> = {
      kind: 'comparison-h05-event',
      id,
      binding: bindingRef,
      event,
    };
    let execution: NonNullable<H05CaseReport['probes'][typeof id]>['execution'] = {
        outcome: 'completed',
        result,
        evidence: [],
      },
      probeResult: InputRef | null = result;
    if (id === 'owner-fenced') {
      const attempts = [
        {
          event: {
            ...event,
            event_id: opId + ':old-generation',
            expected_revision: run.revision,
            generation: run.generation - 1,
          } as LocalEvent,
          error: '',
        },
        {
          event: {
            ...event,
            event_id: opId + ':wrong-owner',
            expected_revision: run.revision,
            session_id: 'another-owner-session',
          } as LocalEvent,
          error: '',
        },
      ];
      for (const attempt of attempts)
        try {
          applyLocalEvent(run, attempt.event);
        } catch (error) {
          attempt.error = (error as Error).message;
        }
      observation = { kind: 'comparison-h05-event', id, binding: bindingRef, attempts };
      execution = null;
      probeResult = null;
    } else if (id === 'late-cancel-refused') {
      const cancel: LocalEvent = {
        type: 'CANCEL',
        event_id: opId + ':cancel',
        expected_revision: run.revision,
        generation: run.generation,
        reason: 'H05 expected cancellation',
        unfinished: ['evidence/'],
        stopped_receipt: detached.locator,
      };
      run = applyLocalEvent(run, cancel);
      const late: LocalEvent = {
        ...event,
        event_id: opId + ':late-result',
        expected_revision: run.revision,
        source: primaryRead,
      };
      let error = '';
      try {
        applyLocalEvent(run, late);
      } catch (failure) {
        error = (failure as Error).message;
      }
      observation = { kind: 'comparison-h05-event', id, binding: bindingRef, cancel, late, error };
      execution = { outcome: 'cancelled', result: null, evidence: [] };
      probeResult = null;
    } else run = applyLocalEvent(run, event);
    const after = await snapshot(run);
    previous = after;
    const delivered =
      id === 'delivery-recovered' || id === 'restart-reconciled' || id === 'owner-fenced'
        ? []
        : id === 'deduplicated'
          ? [terminal, terminal]
          : id === 'reordered'
            ? [terminal, progress]
            : [terminal];
    const basis = record('delivery', {
      kind: 'comparison-h05-delivery',
      id,
      binding: bindingRef,
      terminal,
      progress,
      subscription: id === 'pre-subscription' ? 'after-delivery' : 'before-delivery',
      delivered,
    });
    if (id === 'restart-reconciled') {
      const params = {
          threadId: session,
          cwd: binding.workspace,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          excludeTurns: true,
          model: profile.model,
          config: { model_reasoning_effort: profile.effort },
        },
        recoveryReads: InputRef[] = [];
      if (recoverySubstitution !== 'missing-resume') {
        const rpcId = ++rawPorts[1]!.serial,
          requestSource = capture('send', { id: rpcId, method: 'thread/resume', params }, 1),
          responseSource = capture('recv', { id: rpcId, result: originalSession }, 1);
        recoveryReads.push(
          record('resume-read', {
            kind: 'comparison-h05-primary-read',
            opId,
            id,
            phase: 'resume',
            method: 'thread/resume',
            params,
            response: originalSession,
            requestSource,
            responseSource,
          }),
        );
      }
      const recovered = readTrace(id, 'resume', 1);
      if (recoverySubstitution !== 'missing-read') recoveryReads.push(recovered);
      const receipt =
        recoverySubstitution === 'creation-receipt'
          ? creation
          : record('resume-receipt', {
              operation: 'thread/resume',
              session: originalSession,
              parent: null,
            });
      report.restart.resumed = record('resumed', {
        kind: 'comparison-h05-resumed',
        opId,
        session,
        turn,
        deliveryId: binding.deliveryId,
        detached,
        receipt,
        reads: recoveryReads,
      });
      report.evidence.push(report.restart.resumed);
    }
    const reads =
      id === 'owner-fenced' || id === 'late-cancel-refused'
        ? []
        : [
            ...(id === 'delivery-recovered' || id === 'restart-reconciled'
              ? [readTrace(id, 'reconcile', id === 'restart-reconciled' ? 1 : 0)]
              : []),
            readTrace(id, 'result', id === 'restart-reconciled' ? 1 : 0),
          ];
    report.probes[id] = {
      before,
      after,
      basis,
      observation: record('event', observation),
      reads,
      execution,
      result: probeResult,
    };
    if (id === 'restart-reconciled') {
      report.restart.waiting = before;
      report.restart.state = before;
    }
  }
  report.retained.after = previous;
  report.native.journals = rawPorts.map((journal) => ({
    locator: journal.path,
    hash: digest(readFileSync(journal.path)),
  }));
  report.evidence.push(...report.native.journals);
  const guard = {
    kind: 'comparison-h05-guard',
    executionVersion: 2,
    opId,
    requestHash,
    request: f.requestRef,
    variant: request.variant,
    roots: request.roots,
    budget: request.budget,
    profile: { model: profile.model, effort: profile.effort, clientVersion: profile.clientVersion },
    binary: profile.binary,
    authorization: request.authorization,
    pins: [request.material],
    startedNs: '10000000001',
    deadlineNs: '70000000001',
    workDeadlineNs: '68000000001',
  };
  const participant: ComparisonParticipant = { run: opId, session, transcript, stage: 'execution' };
  let rangeMode: 'none' | 'partial' | 'after' | 'unsealed' = 'none',
    rangeHook = () => {};
  const graph = nativeSeriesEvidenceGraph(
    f,
    'H-05',
    report,
    rows,
    participant,
    physical,
    stopBody,
    guard,
    record,
    primary,
    () => rangeHook(),
    (caseReport) => ({
      kind: 'comparison-h05-native-acceptance',
      opId,
      binding: bindingRef,
      caseReport,
      qualification: false,
    }),
  );
  rangeHook = () => {
    if (rangeMode === 'partial')
      writeFileSync(transcript, readFileSync(transcript, 'utf8') + 'partial native tail');
    if (rangeMode === 'unsealed') delete participant.through;
    if (rangeMode === 'after') {
      const index = rows.findIndex((row) => row.type === 'token_usage_record');
      participant.after = {
        locator: transcript + '#L' + (index + 1),
        hash: digest(canonical(rows[index]) + '\n'),
      };
      for (const name of ['observedResponses', 'inputUncached', 'inputCached', 'output'])
        object(graph.accounting)[name] = null;
      graph.accounting.unknown = true;
    }
  };
  const sdk = candidate
    ? vi.spyOn(h05Temporal, 'verifyH05TemporalExecution').mockImplementation(() => {})
    : null;
  graph.refresh();
  return {
    ...graph,
    binding,
    participant,
    sdk,
    range(mode: typeof rangeMode) {
      rangeMode = mode;
    },
    changeBinding(update: Partial<H05Binding>) {
      Object.assign(binding, update);
      bindingRef = record('changed-binding', binding);
      report.binding = bindingRef;
    },
    setPrefix(which: 'prefixBefore' | 'prefixAfter', update: Record<string, unknown>) {
      report.native[which] = record('changed-prefix', { ...prefixValue, ...update });
    },
  };
}

describe('H05 series primary normalization', () => {
  it.each([false, true])(
    'replays persisted owner/generation, original FAIL, one result and refused late application; candidate=%s',
    async (candidate) => {
      const f = await h05SeriesEvidenceFixture(candidate),
        summary = seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-05');
      expect(summary).toMatchObject({
        outcome: 'accepted',
        stopped: true,
        accounting: { unknown: false },
        partialScope: true,
        qualification: false,
        blocking: [],
      });
      if (candidate) {
        expect(f.sdk).toHaveBeenCalledTimes(6);
        expect(f.sdk!.mock.calls.map((call) => [call[1].id, call[1].mode])).toEqual([
          ['pre-subscription', 'wait'],
          ['delivery-recovered', 'wait'],
          ['deduplicated', 'wait'],
          ['reordered', 'wait'],
          ['restart-reconciled', 'restart'],
          ['late-cancel-refused', 'cancel'],
        ]);
      }
    },
  );
  it.each(['case', 'session', 'stop', 'binding', 'raw', 'primary', 'acceptance', 'sdk'] as const)(
    'refuses H05 substituted %s',
    async (mode) => {
      const f = await h05SeriesEvidenceFixture(mode === 'sdk');
      if (mode === 'case') f.report.scenario = 'H-04' as 'H-05';
      if (mode === 'session') f.report.session = 'another-session';
      if (mode === 'stop') f.stopBody.confirmed = false;
      if (mode === 'binding') f.changeBinding({ requestHash: 'f'.repeat(64) });
      if (mode === 'raw') f.setPrefix('prefixAfter', { content: 'unrelated raw primary' });
      if (mode === 'primary')
        f.report.probes['deduplicated']!.basis = f.record('forged-delivery', {
          kind: 'comparison-h05-delivery',
          id: 'deduplicated',
          binding: f.report.binding,
          delivered: [],
        });
      if (mode === 'acceptance')
        f.setAcceptance({ kind: 'comparison-h05-native-acceptance', qualification: false });
      if (mode === 'sdk')
        f.sdk!.mockImplementation(() => {
          throw new Error('sdk-primary-substitution');
        });
      const summary = seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-05');
      expect(summary.outcome).toBe('unknown');
      expect(summary.knownSubtotal.observedResponses).toBe(1);
    },
  );
});

describe('H05 series source substitutions', () => {
  it.each([
    ['projection', 'kind', 'comparison-h04-native-projection'],
    ['projection', 'scenario', 'H-04'],
    ['projection', 'opId', 'other-op'],
    ['projection', 'engine', 'temporal'],
    ['report', 'kind', 'comparison-h04-case'],
    ['report', 'scenario', 'H-04'],
    ['report', 'opId', 'other-op'],
    ['report', 'engine', 'temporal'],
    ['report', 'outcome', 'failed'],
    ['report', 'checks', {}],
    ['report', 'blocking', ['unknown']],
    ['report', 'nativeAcceptance', true],
    ['report', 'qualification', true],
    ['report', 'partialScope', false],
  ])('refuses %s.%s', async (owner, field, value) => {
    const f = await h05SeriesEvidenceFixture();
    object(owner === 'projection' ? f.projection : f.report)[String(field)] = value;
    expect(seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-05').outcome).toBe(
      'unknown',
    );
  });
  it.each([
    ['kind', 'comparison-h04-binding'],
    ['schemaVersion', 2],
    ['opId', 'other-op'],
    ['requestHash', 'f'.repeat(64)],
    ['engine', 'temporal'],
    ['identity', { taskId: 'H01', owner: 'other-owner', generation: 2 }],
    ['material', null],
    ['workspace', '/different-workspace'],
    ['stateRoot', '/different-state'],
    ['evidenceRoot', '/different-evidence'],
    ['session', { id: 'different-session' }],
    ['turn', 'different-turn'],
    ['nativeTranscript', '/different-transcript'],
  ])('refuses binding %s', async (field, value) => {
    const f = await h05SeriesEvidenceFixture();
    f.changeBinding({ [String(field)]: value });
    expect(seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-05').outcome).toBe(
      'unknown',
    );
  });
  it.each([
    'false-check',
    'stage',
    'participant-count',
    'rules',
    'sources',
    'procedure-array',
    'procedure-ids',
    'procedure-shape',
    'descriptor',
    'procedure',
  ] as const)('refuses %s primary scope', async (mode) => {
    const f = await h05SeriesEvidenceFixture(
      false,
      mode === 'descriptor' || mode === 'procedure' ? mode : 'none',
    );
    if (mode === 'false-check') {
      f.report.checks = { ...f.report.checks, [h05ProbeIds[0]]: false };
      f.child.checks = f.report.checks;
    }
    if (mode === 'stage') f.accounting.participants[0]!.stage = 'council';
    if (mode === 'participant-count') f.addParticipant();
    const query = structuredClone(f.binding.query);
    if (mode === 'rules') query.rules = query.rules.slice(0, 1);
    if (mode === 'sources') query.sources = query.sources.slice(0, 1);
    if (mode === 'procedure-array') object(query).procedures = null;
    if (mode === 'procedure-ids') query.procedures = query.procedures.slice(0, 1);
    if (mode === 'procedure-shape') query.procedures[0]!.version = 'different-version';
    if (['rules', 'sources', 'procedure-array', 'procedure-ids', 'procedure-shape'].includes(mode))
      f.changeBinding({ query });
    expect(seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-05').outcome).toBe(
      'unknown',
    );
  });
  it.each([
    'before-path',
    'after-path',
    'before-content',
    'after-content',
    'before-prefix',
    'partial',
    'after',
    'unsealed',
  ] as const)('refuses native source %s', async (mode) => {
    const f = await h05SeriesEvidenceFixture();
    if (mode === 'before-path') f.setPrefix('prefixBefore', { transcript: '/other-transcript' });
    if (mode === 'after-path') f.setPrefix('prefixAfter', { transcript: '/other-transcript' });
    if (mode === 'before-content') f.setPrefix('prefixBefore', { content: 42 });
    if (mode === 'after-content') f.setPrefix('prefixAfter', { content: 42 });
    if (mode === 'before-prefix') f.setPrefix('prefixBefore', { content: 'unrelated prefix' });
    if (mode === 'partial' || mode === 'after' || mode === 'unsealed') f.range(mode);
    expect(seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-05').outcome).toBe(
      'unknown',
    );
  });
});

describe('H05 series native profile binding', () => {
  it.each([
    ['model', 'another-model'],
    ['effort', 'another-effort'],
    ['read_only', false],
    ['network', true],
    ['forked_from', 'another-parent'],
    ['initial_turns', 1],
    ['workspace', '/other-workspace'],
    ['project_id', 'other-project'],
  ])('refuses native session %s', async (field, value) => {
    const f = await h05SeriesEvidenceFixture();
    f.changeBinding({ session: { ...f.binding.session, [String(field)]: value } });
    expect(seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-05').outcome).toBe(
      'unknown',
    );
  });
});

it('rejects a coordinated executor/spec/LOAD/raw substitution against the pinned outer profile', async () => {
  const f = await h05SeriesEvidenceFixture(false, 'none', true),
    input = f.refresh();
  expect(() => verifyH05Primary(f.report.binding!, f.report)).not.toThrow();
  const summary = seriesEvidenceModule.normalizeH01SeriesEvidence(input, 'H-05');
  expect(summary.outcome).toBe('unknown');
  expect(summary.knownSubtotal.observedResponses).toBe(1);
});

describe('H05 recovery primary evidence', () => {
  it('requires correlated recovery reads and two distinct process STOP witnesses in a unit graph', async () => {
    const f = await h05SeriesEvidenceFixture(),
      input = f.refresh(),
      detached = object(h01ReadJson(f.report.restart.detached!)),
      retired = object(h01ReadJson(detached.stop as InputRef)),
      current = object(h01ReadJson(f.report.stop)),
      resumed = object(h01ReadJson(f.report.restart.resumed!));
    const receipt = object(h01ReadJson(resumed.receipt as InputRef));
    expect(receipt.operation).toBe('thread/resume');
    expect(
      (resumed.reads as InputRef[]).map((ref) => {
        const proof = object(h01ReadJson(ref));
        return [proof.phase, proof.method];
      }),
    ).toEqual([
      ['resume', 'thread/resume'],
      ['resume', 'thread/read'],
    ]);
    const processProof = (stop: Record<string, unknown>) =>
      (stop.evidence as InputRef[])
        .map((ref) => object(h01ReadJson(ref)))
        .filter((value) => value.kind === 'h02-native-process-stop');
    const before = processProof(retired),
      after = processProof(current);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(before[0]!.initial).not.toEqual(after[0]!.initial);
    expect(() => verifyH05Primary(f.report.binding!, f.report)).not.toThrow();
    expect(seriesEvidenceModule.normalizeH01SeriesEvidence(input, 'H-05')).toMatchObject({
      outcome: 'accepted',
      qualification: false,
      partialScope: true,
    });
  });
  it.each([
    'missing-resume',
    'creation-receipt',
    'missing-read',
    'missing-retired-stop',
    'missing-current-stop',
    'same-process',
  ] as const)('refuses a recovery witness substitution: %s', async (mode) => {
    const f = await h05SeriesEvidenceFixture(false, 'none', false, mode);
    expect(() => verifyH05Primary(f.report.binding!, f.report)).toThrow();
    const summary = seriesEvidenceModule.normalizeH01SeriesEvidence(f.refresh(), 'H-05');
    expect(summary.outcome).toBe('unknown');
    expect(summary.knownSubtotal.observedResponses).toBe(1);
  });
});
