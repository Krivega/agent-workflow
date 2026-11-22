import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import console from 'node:console';
import process from 'node:process';
import { hash, sdkFixture } from './task-execution-sdk-fixture.mjs';
import { sdkProcessGuard, sdkProcessGuardSelfTest } from './task-execution-sdk-processes.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requirementsInterruption = 'pause';

export function checkSdkHistoryPrefix(before, after) {
  assert.ok(before.events?.length > 0, 'original history must be nonempty');
  assert.ok(after.events?.length >= before.events.length, 'history prefix was truncated');
  assert.deepEqual(
    after.events.slice(0, before.events.length),
    before.events,
    'original history prefix changed',
  );
  return { events: before.events.length, preserved: true };
}

export function checkSdkHeldContinuity(before, after, continued = false) {
  const {
    elapsedMs: elapsedBefore,
    runId: runBefore,
    checkpoint: checkpointBefore,
    ...old
  } = before;
  const {
    elapsedMs: elapsedAfter,
    runId: runAfter,
    checkpoint: checkpointAfter,
    ...current
  } = after;
  assert.deepEqual(current, old, 'restored held state changed');
  assert.ok(Number.isSafeInteger(elapsedBefore) && elapsedBefore >= 0);
  assert.ok(
    Number.isSafeInteger(elapsedAfter) && elapsedAfter >= elapsedBefore,
    'elapsed budget rewound',
  );
  if (continued) {
    assert.notEqual(runAfter, runBefore, 'Continue-As-New must change run ID');
    assert.ok(checkpointAfter, 'Continue-As-New checkpoint missing');
  } else {
    assert.equal(runAfter, runBefore, 'Worker replacement changed run ID');
    assert.deepEqual(checkpointAfter, checkpointBefore);
  }
  return { statePreserved: true, elapsedBefore, elapsedAfter, continued };
}

export function taskExecutionSdkPlan() {
  return {
    kind: 'input11-sdk-choreography',
    qualification: false,
    modelStarts: 0,
    installs: 0,
    network:
      'localhost SDK only; no download/fallback; clean loader/proxy-free child environment required',
    server:
      'two sequential modes, each with its own new localhost CLI1.9.1 and database; existing pinned cache only',
    workers: { workflowAndActivity: 1, independentControl: 1, activityConcurrencyEach: 1 },
    boundMs: 180000,
    cleanupReserveMs: 30000,
    kitBoundMs: 360000,
    sequentialServers: 2,
    cases: [
      'writer-pause-lost-response',
      'writer-held-main-worker-restart',
      'writer-cancel',
      'candidate-requirements-fresh-attempt',
      'integrated-pause',
      'finish-DONE-raw-cancel',
      'held-pending-resume-raw-cancel',
      'bounded-actual-server-CAN',
    ],
    modes: {
      basic: '--run: seven bounded scenarios including graceful held-state Worker replacement',
      can: '--run-can: only CAN, on a separate new server',
    },
    can: {
      signals: 12,
      observationMs: 5000,
      thresholdOverride: true,
      actualSuggestionRequired: true,
      extraArgs: ['--dynamic-config-value', 'limit.historyCount.suggestContinueAsNew=40'],
      absentSuggestion: 'FAIL/NOT_QUALIFIED',
      freshResumeBeforeNewEffects: true,
      sources: [
        'https://raw.githubusercontent.com/temporalio/temporal/v1.32.0/common/dynamicconfig/constants.go',
        'https://github.com/temporalio/documentation/blob/main/docs/cli/command-reference/server.mdx',
      ],
    },
    synthetic: [
      'Activities and their authority/stop/budget/storage ports',
      'Review Activity results; actual ReviewWorkflow remains',
    ],
    real: [
      'LocalTaskWorkflow/ManagedTaskWorkflow',
      'SDK Activity cancellation/completion',
      'Workflow Updates/cancellation/drain',
      'unfinished held Workflow rehydration on a distinct SDK main Worker and client',
      'server histories and any actual Continue-As-New',
    ],
    unchanged: [
      'b1',
      'runtime/contracts/Workflow',
      'M1 installed full consumer',
      'package scripts',
      'replay corpus',
    ],
    request: {
      evidence: 'new canonical absolute directory',
      temporalBinarySha256: 'expected SHA of tmp/temporal-downloads/temporal-v1.9.1',
    },
    execution:
      'separate service authorization and frozen T3/dist are required; --plan starts nothing',
    stopGate:
      'SDK teardown, absence of every captured OS descendant PID/start identity, and frontend refusal; any unknown is sticky FAIL/retain',
  };
}

export function parseTaskExecutionSdkRequest(request) {
  assert.ok(
    request && typeof request === 'object' && !Array.isArray(request),
    'request object required',
  );
  assert.deepEqual(Object.keys(request).sort(), ['evidence', 'temporalBinarySha256']);
  assert.ok(
    typeof request.evidence === 'string' &&
      isAbsolute(request.evidence) &&
      resolve(request.evidence) === request.evidence &&
      !/[\0\r\n]/u.test(request.evidence),
    'canonical absolute evidence path required',
  );
  assert.match(request.temporalBinarySha256, /^[a-f0-9]{64}$/u);
  return request;
}
export async function taskExecutionSdkSelfTest() {
  const request = { evidence: '/absolute/new-evidence', temporalBinarySha256: 'a'.repeat(64) };
  assert.deepEqual(parseTaskExecutionSdkRequest(request), request);
  for (const changed of [
    { extra: true },
    { evidence: 'relative' },
    { temporalBinarySha256: 'bad' },
  ])
    assert.throws(() => parseTaskExecutionSdkRequest({ ...request, ...changed }));
  assert.throws(() => parseTaskExecutionSdkRequest(null));
  const plan = taskExecutionSdkPlan();
  assert.equal(plan.modelStarts, 0);
  assert.equal(plan.installs, 0);
  assert.equal(plan.qualification, false);
  assert.equal(plan.can.thresholdOverride, true);
  assert.equal(plan.sequentialServers, 2);
  assert.equal(plan.kitBoundMs, 360000);
  assert.deepEqual(plan.can.extraArgs, [
    '--dynamic-config-value',
    'limit.historyCount.suggestContinueAsNew=40',
  ]);
  assert.ok(plan.can.signals <= 12 && plan.can.actualSuggestionRequired);
  assert.ok(plan.cases.includes('writer-held-main-worker-restart'));
  const history = { events: [{ eventId: '1', workflowExecutionStartedEventAttributes: {} }] };
  assert.equal(
    checkSdkHistoryPrefix(history, { events: [...history.events, { eventId: '2' }] }).preserved,
    true,
  );
  assert.throws(() => checkSdkHistoryPrefix({ events: [] }, history), /nonempty/u);
  assert.throws(() => checkSdkHistoryPrefix(history, { events: [] }), /truncated/u);
  assert.throws(() => checkSdkHistoryPrefix(history, { events: [{ eventId: '2' }] }), /changed/u);
  const held = {
    runId: 'original',
    elapsedMs: 12,
    checkpoint: null,
    budget: { used: 1 },
    commands: ['pause'],
  };
  checkSdkHeldContinuity(held, { ...held, elapsedMs: 15 });
  checkSdkHeldContinuity(
    held,
    { ...held, runId: 'continued', elapsedMs: 15, checkpoint: { sha256: 'a' } },
    true,
  );
  for (const changed of [
    { elapsedMs: 11 },
    { budget: { used: 0 } },
    { commands: [] },
    { runId: 'other' },
  ])
    assert.throws(() => checkSdkHeldContinuity(held, { ...held, ...changed }));
  assert.throws(() => checkSdkHeldContinuity(held, held, true));
  assert.throws(() => checkSdkHeldContinuity(held, { ...held, runId: 'continued' }, true));
  const cleanup = await import('./t4-pg-temporal-cleanup.mjs');
  let drain;
  const events = [];
  const old = { shutdown: () => events.push('shutdown') };
  const state = { worker: old, workerRun: new Promise((resolve) => (drain = resolve)) };
  const close = (value) => cleanup.closeSdkResources(value, 100);
  const start = async () => {
    events.push('create');
    state.worker = { shutdown() {} };
    state.workerRun = Promise.resolve();
    return state.worker;
  };
  const replacing = replaceIdleMainWorker(state, close, start);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ['shutdown'], 'replacement must wait for actual old Worker drain');
  drain();
  assert.notEqual(await replacing, old);
  assert.deepEqual(events, ['shutdown', 'create']);
  assert.deepEqual(await close(state), []);
  let creates = 0;
  const mustNotStart = async () => {
    creates++;
    throw new Error('unexpected replacement');
  };
  const unknown = { worker: old, workerRun: Promise.resolve(), unknown: { worker: 'unknown' } };
  await assert.rejects(replaceIdleMainWorker(unknown, close, mustNotStart));
  const rejected = Promise.reject(new Error('old Worker drain failed'));
  rejected.catch(() => {});
  const failed = { worker: old, workerRun: rejected };
  await assert.rejects(replaceIdleMainWorker(failed, close, mustNotStart));
  assert.equal(failed.worker, old);
  assert.match(failed.unknown.worker, /drain failed/u);
  const retained = { worker: old, workerRun: Promise.resolve() };
  await assert.rejects(replaceIdleMainWorker(retained, async () => [], mustNotStart));
  const pending = { worker: old, workerRun: Promise.resolve(), acquisitions: { worker: {} } };
  await assert.rejects(replaceIdleMainWorker(pending, close, mustNotStart));
  assert.equal(creates, 0, 'unknown or unconfirmed drain must never acquire a new Worker');
  const acquisition = { worker: old, workerRun: Promise.resolve() };
  await assert.rejects(
    replaceIdleMainWorker(acquisition, close, () =>
      cleanup.acquireSdkResource(
        acquisition,
        'worker',
        async () => {
          throw new Error('replacement acquisition failed');
        },
        () => 100,
        100,
      ),
    ),
    /replacement acquisition failed/u,
  );
  assert.equal(acquisition.worker, null);
  assert.match(acquisition.unknown.workerAcquisition, /acquisition failed/u);
  return {
    status: 'PASS',
    scope: 'pure request/plan and graceful Worker replacement lifecycle doubles only',
    workerReplacement: 'PASS/drain-before-create, unknown/drain/acquisition refusal',
    continuity:
      'PASS/history truncation or substitution, state/command/budget rewind and missing CAN checkpoint refused',
    osProcessGuard: sdkProcessGuardSelfTest(),
    sdkStarts: 0,
    serverStarts: 0,
    qualification: false,
  };
}

async function replaceIdleMainWorker(state, close, start) {
  const previous = state.worker;
  assert.ok(previous && state.workerRun, 'main Worker ownership missing');
  assert.equal(Object.keys(state.unknown ?? {}).length, 0, 'main Worker outcome unknown');
  assert.equal(Object.keys(state.acquisitions ?? {}).length, 0, 'main Worker acquisition pending');
  assert.deepEqual(await close(state), [], 'old main Worker stop/drain was not confirmed');
  assert.equal(state.worker, null, 'old main Worker remains owned');
  assert.equal(state.workerRun, null, 'old main Worker run remains undrained');
  assert.equal(Object.keys(state.unknown ?? {}).length, 0, 'old main Worker cleanup unknown');
  assert.equal(
    Object.keys(state.acquisitions ?? {}).length,
    0,
    'old main Worker acquisition pending',
  );
  const next = await start();
  assert.notEqual(next, previous, 'replacement must be a distinct SDK Worker');
  assert.equal(state.worker, next, 'replacement ownership missing');
  assert.ok(state.workerRun, 'replacement Worker was not started');
  assert.equal(Object.keys(state.unknown ?? {}).length, 0, 'replacement Worker outcome unknown');
  return next;
}

export async function taskExecutionSdkContractSmoke(compiledRoot = packageRoot) {
  const root = realpathSync(compiledRoot);
  const modules = [
    'client/taskExecution.js',
    'client/taskBackend.js',
    'adapters/project/taskBackend.js',
    'policy/taskExecution.js',
    'policy/localTask.js',
    'policy/taskContinuation.js',
    'policy/readerControl.js',
  ];
  const inventory = () =>
    modules.map((name) => {
      const bytes = readFileSync(join(root, 'dist', name));
      return { path: 'dist/' + name, sha256: hash(bytes), bytes: bytes.length };
    });
  const before = inventory();
  const loaded = await Promise.all(
    modules.map((name) => import(pathToFileURL(join(root, 'dist', name)).href)),
  );
  const api = Object.assign({}, ...loaded);
  const temporary = join(packageRoot, 'tmp');
  mkdirSync(temporary, { recursive: true });
  const evidence = realpathSync(mkdtempSync(join(temporary, 'task-execution-contract-')));
  const fixture = sdkFixture(join(evidence, 'fixture'), 'sdk-contract-smoke', {}, api, () => {
    throw new Error('contract smoke must never enter an Activity Context');
  });
  const { Client } = await import('@temporalio/client'),
    client = new Client();
  try {
    const preparation = fixture.initial.admission.preparation;
    assert.throws(
      () => api.requireClientTaskBackend(client, preparation),
      /backend-client-unbound/u,
    );
    api.bindTaskBackendClient(client, fixture.registration);
    api.requireClientTaskBackend(client, preparation);
  } finally {
    await client.connection.close();
  }
  const held = fixture.save({ syntheticHeld: true, input: fixture.initial });
  const checked = [];
  const payload = (command) => {
    const bytes = readFileSync(join(evidence, 'fixture/artifacts', command.payload.sha256));
    assert.equal(hash(bytes), command.payload.sha256);
    assert.equal(bytes.length, command.payload.bytes);
    return JSON.parse(bytes.toString());
  };
  function check(label, action, revision, input = fixture.initial, changed = false) {
    const command = fixture.command(
      action,
      revision,
      input,
      action === 'resume' ? held : null,
      changed,
    );
    api.parsePayloadReaderCommand(command);
    api.taskExecutionCommand(input, command, revision);
    assert.equal(command.hash, hash(api.readerCommandText(command)));
    if (action === 'resume') {
      const resumed = api.parseTaskExecutionResume(payload(command));
      api.checkTaskExecutionResume(input, resumed);
      assert.deepEqual(resumed.held, held);
      if (changed) {
        assert.equal(
          resumed.admission.preparation.revision,
          input.admission.preparation.revision + 1,
        );
        assert.notEqual(resumed.admission.plan.sha256, input.admission.plan.sha256);
      } else assert.deepEqual(resumed.admission, input.admission);
    } else assert.equal(typeof api.taskInterruption(payload(command)), 'string');
    checked.push({ label, action, revision, attempt: command.attempt, hash: command.hash });
    return command;
  }
  check('writer-pause/lost-response', 'pause', 0);
  check('writer-cancel', 'cancel', 0);
  check('candidate-requirements uses pause', requirementsInterruption, 0);
  const changed = check(
    'requirements RESUME carries changed admission',
    'resume',
    1,
    fixture.initial,
    true,
  );
  check('integrated-pause', 'pause', 0);
  check('held-pending RESUME', 'resume', 1);
  check('cancel while held', 'cancel', 1);
  const originalPause = check('CAN pause', 'pause', 0);
  assert.deepEqual(check('CAN duplicate pause', 'pause', 0), originalPause);
  check('CAN fresh RESUME', 'resume', 1);
  const continued = api.parseLocalTask({
    ...fixture.initial,
    admission: payload(changed).admission,
    continuation: { attempt: 1, previous: held },
  });
  check('continued attempt pause', 'pause', 2, continued);
  check('continued attempt cancel', 'cancel', 2, continued);
  assert.throws(() => fixture.command('requirements', 0), /reader-command-action-invalid/u);
  assert.deepEqual(inventory(), before, 'compiled API changed during contract smoke');
  const report = {
    status: 'PASS',
    kind: 'compiled command contract smoke',
    compiledRoot: root,
    evidence,
    checked,
    rejectedLegacyRequirementsAction: true,
    source: before,
    sdkStarts: 0,
    sdkClientBindings: 1,
    serverStarts: 0,
    modelStarts: 0,
    qualification: false,
  };
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

export async function runTaskExecutionSdk(request, mode = 'basic') {
  assert.ok(mode === 'basic' || mode === 'can', 'unknown SDK mode');
  parseTaskExecutionSdkRequest(request);
  assert.ok(
    isAbsolute(request.evidence) && !existsSync(request.evidence),
    'new absolute evidence directory required',
  );
  assert.match(request.temporalBinarySha256, /^[a-f0-9]{64}$/u);
  const began = performance.now(),
    deadline = began + 180000,
    mainDeadline = deadline - 30000;
  const remaining = () => Math.max(0, mainDeadline - performance.now());
  const evidence = request.evidence;
  assert.equal(
    realpathSync(dirname(evidence)),
    dirname(evidence),
    'canonical evidence parent required',
  );
  mkdirSync(evidence, { mode: 0o700 });
  mkdirSync(join(evidence, 'cases'));
  mkdirSync(join(evidence, 'histories'));
  const report = {
    ...taskExecutionSdkPlan(),
    mode,
    status: 'RUNNING',
    evidence,
    request,
    scenarios: [],
    sourceStable: false,
    stop: null,
    actual: {
      serverCreateCalls: 0,
      serverReady: false,
      workersCreated: 0,
      workerRunCalls: 0,
      modelStarts: 0,
      gracefulMainWorkerReplacements: 0,
      replacementClientsCreated: 0,
    },
  };
  report.can = { ...report.can, status: mode === 'can' ? 'PENDING' : 'NOT_RUN/NOT_QUALIFIED' };
  const resources = { server: {}, main: {}, control: {}, restartClient: {} },
    fixtures = [],
    handles = [];
  const processes = sdkProcessGuard(process.pid);
  let environment, bundle, api, hostCleanup, historyToJSON;
  const save = (name, value) =>
    writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n');
  function observeProcesses(stage, stopped = false) {
    const okay = stopped ? processes.assertStopped() : processes.capture(stage);
    if (!okay) report.osStopUnknown = true;
    try {
      save('processes.json', processes.proof());
    } catch (error) {
      report.osStopUnknown = true;
      report.osObservationExportError = String(error);
    }
    return okay && !report.osStopUnknown;
  }
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  const budgetTimer = setTimeout(interrupt, 150000);
  async function bounded(name, operation, maximumMs = 15000, cleanup = false) {
    const ms = Math.floor(
      Math.min(maximumMs, (cleanup ? deadline : mainDeadline) - performance.now()),
    );
    assert.ok(ms > 0 && (cleanup || !interrupted), name + ': SDK window exhausted');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(name + ': deadline exceeded')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function until(name, read, accept, maximumMs = 10000) {
    const untilDeadline = Math.min(mainDeadline, performance.now() + maximumMs);
    while (!interrupted && performance.now() < untilDeadline) {
      const value = await bounded(name, read, Math.max(1, untilDeadline - performance.now()));
      if (accept(value)) return value;
      await delay(25);
    }
    throw new Error(name + ': expected real SDK state not observed');
  }
  const sourcePaths = [
    'package.json',
    'src/workflows/taskExecution.ts',
    'src/workflows/localTask.ts',
    'src/workflows/review.ts',
    'src/contracts/taskExecution.ts',
    'src/contracts/localTask.ts',
    'src/policy/taskExecution.ts',
    'src/policy/taskContinuation.ts',
    'src/client/taskBackend.ts',
    'src/adapters/project/taskBackend.ts',
    'dist/workflows/taskExecution.js',
    'dist/workflows/localTask.js',
    'dist/workflows/review.js',
    'dist/client/taskExecution.js',
    'dist/client/taskBackend.js',
    'dist/adapters/project/taskBackend.js',
    'dist/policy/taskExecution.js',
    'dist/policy/taskContinuation.js',
    'dist/policy/localTask.js',
    'tests/temporal/task-execution-sdk.mjs',
    'tests/temporal/task-execution-sdk-fixture.mjs',
    'tests/temporal/task-execution-sdk-processes.mjs',
    'tests/temporal/t4-pg-temporal-cleanup.mjs',
    'tests/temporal/t4-pg-temporal-runner.mjs',
    'tests/temporal/t4-pg-temporal-retention.mjs',
    'examples/temporal-consumers/full/safety.mjs',
  ];
  const inventory = () =>
    sourcePaths.map((path) => {
      const bytes = readFileSync(join(packageRoot, path));
      return { path, sha256: hash(bytes), bytes: bytes.length };
    });
  let before;
  const resultPath = (name) => join(evidence, 'cases', name);
  async function snapshot(fixture, label, suppliedRunId) {
    const current = environment.client.workflow.getHandle(api.localTaskKey(fixture.initial));
    const description = await bounded('describe ' + label, () => current.describe(), 5000, true);
    const runId = suppliedRunId ?? description.runId;
    const history = await bounded(
      'history ' + label,
      () => environment.client.workflow.getHandle(current.workflowId, runId).fetchHistory(),
      5000,
      true,
    );
    writeFileSync(
      join(resultPath(fixture.state.id), label + '-' + runId + '.json'),
      historyToJSON(history),
    );
    return { description, history, runId };
  }
  async function control(fixture, handle, command, client = environment.client) {
    assert.equal(handle.workflowId, api.localTaskKey(fixture.initial));
    return bounded('taskExecutionControl', () =>
      api.controlTaskExecution(client, handle.workflowId, command),
    );
  }
  async function started(name, options) {
    const fixture = sdkFixture(resultPath(name), name, options, api, api.context);
    fixtures.push(fixture);
    api.bindTaskBackendClient(environment.client, fixture.registration);
    const handle = await bounded('start Input11', () =>
      environment.client.workflow.start('LocalTaskWorkflow', {
        workflowId: api.localTaskKey(fixture.initial),
        taskQueue: queue,
        args: [fixture.initial],
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      }),
    );
    handles.push(handle);
    await until(
      'late Activity entered',
      async () => fixture.state.active.size,
      (size) => size === 1,
    );
    return { fixture, handle };
  }
  async function interruptAndDrain(name, options, action, raw = false) {
    const { fixture, handle } = await started(name, options);
    const first = await snapshot(fixture, 'unfinished-before-control');
    fixture.state.firstRunId = first.runId;
    if (raw) await bounded('raw cancel', () => handle.cancel());
    else {
      const command = fixture.command(action, 0);
      if (options.loseResponse) {
        await assert.rejects(control(fixture, handle, command));
        await snapshot(fixture, 'unfinished-lost-response');
      }
      const ack = await control(fixture, handle, command);
      fixture.state.acceptedCommand = command;
      fixture.state.acceptedAck = ack;
    }
    await until(
      'physical stop port entered',
      async () => fixture.state.stopCalls,
      (count) => count > 0,
    );
    const beforeStop = await bounded('not held before stop', () => handle.query('localTaskStatus'));
    assert.equal(beforeStop.held, null);
    assert.equal(fixture.state.holds.length, 0);
    fixture.release('stop');
    await until('physical stop port confirmed', async () => fixture.state.stopConfirmed, Boolean);
    assert.equal(fixture.state.holds.length, 0, 'held before long Activity drain');
    assert.equal(
      (await bounded('still running before drain', () => handle.describe())).status.name,
      'RUNNING',
    );
    await snapshot(fixture, 'unfinished-stop-confirmed-activity-undrained');
    fixture.release('activity');
    await until(
      'actual Activity function drained',
      async () => fixture.state.active.size,
      (size) => size === 0,
    );
    return { fixture, handle };
  }
  async function completed(fixture, handle, expected) {
    const outcome = await bounded('terminal result', () => handle.result());
    assert.equal(outcome.status, expected);
    const held = fixture.state.holds[0];
    if (held) {
      assert.ok(held.sequence > held.stopSequence);
      assert.ok(fixture.state.returns.some((item) => item.sequence < held.sequence));
    }
    const captured = await snapshot(fixture, 'final');
    const activityHistory = Object.fromEntries(
      [
        'activityTaskCompletedEventAttributes',
        'activityTaskCanceledEventAttributes',
        'activityTaskTimedOutEventAttributes',
        'activityTaskCancelRequestedEventAttributes',
      ].map((name) => [name, captured.history.events.filter((event) => event[name]).length]),
    );
    save('cases/' + fixture.state.id + '/outcome.json', {
      outcome,
      fixture: fixture.summary(),
      historyEvents: captured.history.events.length,
      actualActivityHistory: activityHistory,
    });
    report.scenarios.push({
      name: fixture.state.id,
      status: 'PASS',
      syntheticActivities: true,
      actualSdk: true,
    });
    return outcome;
  }
  async function cancelHeld(fixture, handle, revision = 1) {
    await control(fixture, handle, fixture.command('cancel', revision));
    return completed(fixture, handle, 'cancelled');
  }
  const queue = 'input11-sdk-' + randomUUID();
  try {
    const { assertCleanSdkHostEnvironment } = await import('./t4-pg-temporal-runner.mjs');
    assertCleanSdkHostEnvironment(process.env);
    assert.ok(
      !Object.keys(process.env).some((key) => /proxy$/iu.test(key)),
      'SDK host requires a proxy-free child environment',
    );
    hostCleanup = await import('./t4-pg-temporal-cleanup.mjs');
    const { copyPinnedBinary, verifyPinnedBinary } =
      await import('../../examples/temporal-consumers/full/safety.mjs');
    const binary = copyPinnedBinary(
      realpathSync(join(packageRoot, 'tmp/temporal-downloads/temporal-v1.9.1')),
      request.temporalBinarySha256,
      join(evidence, 'temporal'),
    );
    assert.match(
      execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim(),
      /^temporal version 1\.9\.1\b/u,
    );
    before = inventory();
    save('source-before.json', before);
    const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(metadata.exports['./task-execution'], './dist/client/taskExecution.js');
    const [
      { TestWorkflowEnvironment },
      { Runtime, Worker, bundleWorkflowCode },
      { Context },
      task,
      policy,
      local,
      continuation,
      backend,
      proto,
      { Client, Connection },
    ] = await Promise.all([
      import('@temporalio/testing'),
      import('@temporalio/worker'),
      import('@temporalio/activity'),
      import('@krivega/agent-workflow/task-execution'),
      import('../../dist/policy/taskExecution.js'),
      import('../../dist/policy/localTask.js'),
      import('../../dist/policy/taskContinuation.js'),
      import('@krivega/agent-workflow/task-backend'),
      import('@temporalio/common/proto-utils'),
      import('@temporalio/client'),
    ]);
    historyToJSON = proto.historyToJSON;
    api = {
      ...task,
      ...policy,
      ...local,
      ...continuation,
      ...backend,
      context: () => Context.current(),
    };
    const projectFor = (input) =>
      fixtures.find(
        (fixture) =>
          fixture.initial.admission.preparation.project.projectId ===
            input.admission?.preparation.project.projectId ||
          fixture.initial.admission.preparation.project.projectId ===
            input.preparation?.project.projectId,
      );
    function activity(name) {
      return (...args) => {
        const input =
          name === 'finishReview'
            ? args[0].input
            : name === 'saveTaskExecutionCheckpoint'
              ? args[0].initial
              : args[0];
        const fixture = projectFor(input);
        assert.ok(fixture, 'unregistered synthetic fixture');
        return (fixture.activities[name] ?? fixture.controls[name])(...args);
      };
    }
    const activityNames = [
      'prepareSubstantialPlanning',
      'prepareReviewPlan',
      'finishReview',
      'prepareLocalTask',
      'checkLocalTask',
      'writeLocalTask',
      'planLocalIntegration',
      'integrateLocalTask',
      'prepareLocalAcceptance',
      'finishLocalTask',
    ];
    const controlNames = [
      'prepareTaskExecution',
      'captureTaskExecutionBudget',
      'findTaskExecutionCommand',
      'interruptTaskExecution',
      'stopLocalTask',
      'holdTaskExecution',
      'resumeTaskExecution',
      'saveTaskExecutionCheckpoint',
      'loadTaskExecutionCheckpoint',
    ];
    save('schema.json', {
      input: 11,
      command: 2,
      workflowType: 'LocalTaskWorkflow',
      actualTaskExecutionExports: Object.keys(task),
      activityNames,
      controlNames,
      syntheticPortsOnly: true,
    });
    const log = (level, message) => {
      try {
        writeFileSync(join(evidence, 'sdk-' + level + '.log'), String(message) + '\n', {
          flag: 'a',
        });
      } catch {
        report.sdkLogUnknown = true;
      }
    };
    Runtime.install({
      logger: {
        log(entry) {
          let text;
          try {
            text = JSON.stringify(entry);
          } catch {
            text = String(entry);
          }
          log('entries', text);
        },
        trace(message) {
          log('trace', message);
        },
        debug(message) {
          log('debug', message);
        },
        info(message) {
          log('info', message);
        },
        warn(message) {
          log('warn', message);
        },
        error(message) {
          log('error', message);
        },
      },
    });
    const changed = () =>
      save(
        'resources.json',
        Object.fromEntries(
          Object.entries(resources).map(([name, state]) => [
            name,
            {
              acquisitions: hostCleanup.sdkAcquisitionProof(state),
              unknown: state.unknown ?? {},
              workerOwned: Boolean(state.worker),
              serverOwned: Boolean(state.connection),
            },
          ]),
        ),
      );
    bundle = await bounded(
      'real Workflow bundle',
      () => bundleWorkflowCode({ workflowsPath: join(packageRoot, 'dist/workflows/localTask.js') }),
      30000,
    );
    save('workflow-bundle.json', {
      sha256: hash(bundle.code),
      bytes: Buffer.byteLength(bundle.code),
      source: 'actual dist/workflows/localTask.js with ManagedTaskWorkflow and ReviewWorkflow',
    });
    verifyPinnedBinary(binary, request.temporalBinarySha256);
    const server = await hostCleanup.acquireSdkResource(
      resources.server,
      'connection',
      async () => {
        report.actual.serverCreateCalls++;
        const configuration = {
          ip: '127.0.0.1',
          ui: false,
          dbFilename: join(evidence, 'temporal.sqlite'),
          executable: { type: 'existing-path', path: binary },
          ...(mode === 'can' ? { extraArgs: taskExecutionSdkPlan().can.extraArgs } : {}),
        };
        save('server-configuration.json', { mode, ...configuration });
        const value = await TestWorkflowEnvironment.createLocal({ server: configuration });
        return { value, close: () => value.teardown() };
      },
      remaining,
      10000,
      changed,
    );
    environment = server.value;
    report.actual.serverReady = true;
    report.serverAddress = environment.client.connection.options.address;
    assert.equal(
      observeProcesses('after-environment-acquired'),
      true,
      'OS descendant acquisition observation unknown',
    );
    async function startWorker(name, names) {
      const worker = await hostCleanup.acquireSdkResource(
        resources[name],
        'worker',
        () =>
          Worker.create({
            connection: environment.nativeConnection,
            taskQueue: name === 'main' ? queue : queue + '.control',
            ...(name === 'main' ? { workflowBundle: bundle } : {}),
            activities: Object.fromEntries(names.map((key) => [key, activity(key)])),
            maxConcurrentActivityTaskExecutions: 1,
            maxConcurrentWorkflowTaskExecutions: 2,
            defaultHeartbeatThrottleInterval: '100ms',
            maxHeartbeatThrottleInterval: '100ms',
            shutdownGraceTime: '0ms',
            shutdownForceTime: '5s',
          }),
        remaining,
        10000,
        changed,
      );
      report.actual.workersCreated++;
      resources[name].workerRun = worker.run();
      report.actual.workerRunCalls++;
      resources[name].workerRun.catch((error) => {
        resources[name].unknown ??= {};
        resources[name].unknown.run = String(error);
        changed();
      });
      return worker;
    }
    await startWorker('main', activityNames);
    await startWorker('control', controlNames);

    if (mode === 'basic') {
      {
        const { fixture, handle } = await interruptAndDrain(
          'writer-pause-lost-response',
          { stage: 'writer', loseResponse: true },
          'pause',
        );
        await until(
          'writer held',
          () => handle.query('localTaskStatus'),
          (value) => value.waiting,
        );
        assert.deepEqual(
          await control(fixture, handle, fixture.state.acceptedCommand),
          fixture.state.acceptedAck,
          'duplicate command must reuse receipt',
        );
        assert.equal(fixture.state.calls.filter((item) => item.name === 'candidate').length, 0);
        await snapshot(fixture, 'unfinished-held-before-human');
        await cancelHeld(fixture, handle);
      }
      {
        const { fixture, handle } = await interruptAndDrain(
          'writer-held-main-worker-restart',
          { stage: 'writer' },
          'pause',
        );
        const held = await until(
          'writer held before replacement',
          () => handle.query('localTaskStatus'),
          (value) => value.waiting,
        );
        assert.ok(held.held && fixture.state.stopConfirmed && fixture.state.active.size === 0);
        const input = await bounded('input before replacement', () =>
          handle.query('localTaskInput'),
        );
        const beforeReplacement = await snapshot(
          fixture,
          'unfinished-held-before-worker-replacement',
        );
        assert.equal(beforeReplacement.description.status.name, 'RUNNING');
        const calls = fixture.state.calls.map((item) => ({ ...item }));
        const writers = [...fixture.state.writers];
        const previous = resources.main.worker;
        const replacement = await replaceIdleMainWorker(
          resources.main,
          (state) => hostCleanup.closeSdkResources(state, Math.max(1, Math.min(5000, remaining()))),
          () => startWorker('main', activityNames),
        );
        report.actual.gracefulMainWorkerReplacements++;
        changed();
        const fresh = await hostCleanup.acquireSdkResource(
          resources.restartClient,
          'connection',
          async () => {
            const connection = await Connection.connect({ address: environment.address });
            return { value: new Client({ connection }), close: () => connection.close() };
          },
          remaining,
          5000,
          changed,
        );
        report.actual.replacementClientsCreated++;
        api.bindTaskBackendClient(fresh.value, fixture.registration);
        const recovered = fresh.value.workflow.getHandle(handle.workflowId);
        assert.equal(recovered.workflowId, handle.workflowId);
        const description = await bounded('describe after replacement', () => recovered.describe());
        assert.equal(description.runId, beforeReplacement.runId);
        assert.equal(description.status.name, 'RUNNING');
        assert.deepEqual(
          await bounded('input after replacement', () => recovered.query('localTaskInput')),
          input,
        );
        const continuity = checkSdkHeldContinuity(
          held,
          await bounded('held after replacement', () => recovered.query('localTaskStatus')),
        );
        assert.deepEqual(
          await control(fixture, recovered, fixture.state.acceptedCommand, fresh.value),
          fixture.state.acceptedAck,
        );
        assert.deepEqual(
          fixture.state.calls,
          calls,
          'Worker replacement must not repeat Activity effects',
        );
        assert.deepEqual(
          fixture.state.writers,
          writers,
          'Worker replacement must not repeat a synthetic writer',
        );
        const afterReplacement = await snapshot(
          fixture,
          'unfinished-held-after-worker-replacement',
        );
        const historyPrefix = checkSdkHistoryPrefix(
          beforeReplacement.history,
          afterReplacement.history,
        );
        save('cases/' + fixture.state.id + '/worker-replacement.json', {
          kind: 'graceful-sdk-main-worker-replacement',
          oldWorkerDrained: true,
          distinctWorker: previous !== replacement,
          freshClient: true,
          workflowId: handle.workflowId,
          runId: description.runId,
          input,
          held,
          pauseCommand: fixture.state.acceptedCommand,
          duplicatePauseReceipt: fixture.state.acceptedAck,
          effectsUnchanged: true,
          continuity,
          historyPrefix,
          syntheticActivities: true,
          physicalProcessLoss: false,
          nativeWriterLoss: false,
        });
        await control(fixture, recovered, fixture.command('cancel', 1), fresh.value);
        await completed(fixture, recovered, 'cancelled');
        assert.deepEqual(fixture.state.writers, writers);
        assert.deepEqual(
          fixture.state.calls,
          calls,
          'held cancellation must not reissue Activity effects',
        );
        assert.deepEqual(
          await hostCleanup.closeSdkResources(
            resources.restartClient,
            Math.max(1, Math.min(5000, remaining())),
          ),
          [],
        );
        changed();
      }
      {
        const { fixture, handle } = await interruptAndDrain(
          'writer-cancel',
          { stage: 'writer' },
          'cancel',
        );
        await completed(fixture, handle, 'cancelled');
        assert.equal(
          fixture.state.calls.filter((item) => item.name === 'plan-integration').length,
          0,
        );
      }
      {
        const { fixture, handle } = await interruptAndDrain(
          'candidate-requirements',
          { stage: 'candidate' },
          requirementsInterruption,
        );
        const held = await until(
          'requirements held',
          () => handle.query('localTaskStatus'),
          (value) => value.waiting,
        );
        assert.equal(fixture.state.calls.filter((item) => item.name === 'integration').length, 0);
        await snapshot(fixture, 'unfinished-requirements-held');
        await control(
          fixture,
          handle,
          fixture.command('resume', 1, fixture.initial, held.held, true),
        );
        await completed(fixture, handle, 'done');
        assert.equal(fixture.state.next.admission.preparation.revision, 2);
        assert.notEqual(
          fixture.state.next.admission.plan.sha256,
          fixture.initial.admission.plan.sha256,
        );
        for (const name of [
          'planning',
          'baseline',
          'writer',
          'candidate',
          'integration',
          'integrated',
          'acceptance',
        ])
          assert.equal(
            fixture.state.calls.filter((item) => item.name === name && item.attempt === 1).length,
            1,
            'fresh attempt missing ' + name,
          );
        assert.equal(
          fixture.state.calls.filter((item) => item.name === 'acceptance' && item.attempt === 0)
            .length,
          0,
        );
      }
      {
        const { fixture, handle } = await interruptAndDrain(
          'integrated-pause',
          { stage: 'integrated' },
          'pause',
        );
        await until(
          'integrated held',
          () => handle.query('localTaskStatus'),
          (value) => value.waiting,
        );
        assert.equal(fixture.state.calls.filter((item) => item.name === 'acceptance').length, 0);
        await cancelHeld(fixture, handle);
      }
      {
        const { fixture, handle } = await interruptAndDrain(
          'finish-DONE-raw-cancel',
          { stage: 'finish' },
          null,
          true,
        );
        await completed(fixture, handle, 'done');
      }
      {
        const { fixture, handle } = await interruptAndDrain(
          'held-pending-resume',
          { stage: 'writer', pendingResume: true },
          'pause',
        );
        const held = await until(
          'held before pending resume',
          () => handle.query('localTaskStatus'),
          (value) => value.waiting,
        );
        const update = control(
          fixture,
          handle,
          fixture.command('resume', 1, fixture.initial, held.held),
        ).then(
          (value) => ({ value }),
          (error) => ({ error: String(error) }),
        );
        await until(
          'real control Activity entered',
          async () => fixture.state.resumeEntered,
          Boolean,
        );
        await bounded('raw cancel while Update pending', () => handle.cancel());
        await until(
          'real SDK cancellation delivered to control Activity',
          async () => fixture.state.resumeCancelled,
          Boolean,
        );
        assert.equal((await handle.describe()).status.name, 'RUNNING');
        await snapshot(fixture, 'unfinished-raw-cancel-pending-update');
        fixture.release('resume');
        const updateOutcome = await bounded('pending Update drained', () => update);
        assert.ok(updateOutcome.error, 'cancelled resume must not create a new continuation');
        await completed(fixture, handle, 'cancelled');
        assert.equal(fixture.state.continuations, 0);
        assert.deepEqual(fixture.state.writers, [0]);
        const { history } = await snapshot(fixture, 'final-update-drain');
        const accepted = history.events.filter(
          (event) => event.workflowExecutionUpdateAcceptedEventAttributes,
        ).length;
        const finished = history.events.filter(
          (event) => event.workflowExecutionUpdateCompletedEventAttributes,
        ).length;
        assert.ok(
          accepted >= 2 && accepted === finished,
          'unfinished Update handler at Workflow close',
        );
      }
    }
    if (mode === 'can') {
      {
        const { fixture, handle } = await interruptAndDrain(
          'bounded-actual-CAN',
          { stage: 'writer' },
          'pause',
        );
        const heldBeforeCan = await until(
          'held for server CAN probe',
          () => handle.query('localTaskStatus'),
          (value) => value.waiting,
        );
        const first = await snapshot(
          fixture,
          'unfinished-before-CAN-probe',
          fixture.state.firstRunId,
        );
        const probeDeadline = Math.min(mainDeadline, performance.now() + 5000);
        let history = first.history,
          continuation = history.events.find(
            (event) => event.workflowExecutionContinuedAsNewEventAttributes,
          ),
          signals = 0;
        while (!continuation && signals < 12 && performance.now() < probeDeadline) {
          await bounded('bounded reconcile signal', () => handle.signal('localTaskReconcile'));
          signals++;
          await delay(50);
          history = (await snapshot(fixture, 'CAN-probe-' + signals, first.runId)).history;
          continuation = history.events.find(
            (event) => event.workflowExecutionContinuedAsNewEventAttributes,
          );
          if (continuation) break;
        }
        const suggested = history.events.some(
          (event) => event.workflowTaskStartedEventAttributes?.suggestContinueAsNew === true,
        );
        if (suggested && !continuation) {
          const observed = await until(
            'server-suggested CAN completed',
            () => snapshot(fixture, 'CAN-suggestion-await-transition', first.runId),
            (value) =>
              value.history.events.some(
                (event) => event.workflowExecutionContinuedAsNewEventAttributes,
              ),
            Math.max(1, probeDeadline - performance.now()),
          );
          history = observed.history;
          continuation = history.events.find(
            (event) => event.workflowExecutionContinuedAsNewEventAttributes,
          );
        }
        if (continuation) {
          assert.equal(
            suggested,
            true,
            'CAN requires actual server suggestion, never a mocked flag',
          );
          const next = await until(
            'new run restored held',
            () => environment.client.workflow.getHandle(handle.workflowId).query('localTaskStatus'),
            (value) => value.runId !== first.runId && value.waiting,
          );
          assert.equal(
            next.runId,
            continuation.workflowExecutionContinuedAsNewEventAttributes.newExecutionRunId,
          );
          assert.equal(
            (await environment.client.workflow.getHandle(handle.workflowId).describe()).type,
            'LocalTaskWorkflow',
          );
          const continuity = checkSdkHeldContinuity(heldBeforeCan, next, true);
          assert.equal(next.budget.used, 1);
          assert.equal(next.budget.limit, 16);
          assert.deepEqual(
            await environment.client.workflow.getHandle(handle.workflowId).query('localTaskInput'),
            fixture.initial,
          );
          assert.deepEqual(fixture.state.writers, [0]);
          assert.equal(
            fixture.state.continuations,
            0,
            'no new attempt before a fresh human RESUME port',
          );
          assert.equal(
            fixture.state.calls.some((item) => item.attempt > 0),
            false,
          );
          assert.deepEqual(
            await control(fixture, handle, fixture.state.acceptedCommand),
            fixture.state.acceptedAck,
          );
          await snapshot(fixture, 'unfinished-new-run-held-before-fresh-RESUME');
          const resume = fixture.command('resume', 1, fixture.initial, next.held);
          await control(fixture, environment.client.workflow.getHandle(handle.workflowId), resume);
          await completed(
            fixture,
            environment.client.workflow.getHandle(handle.workflowId),
            'done',
          );
          assert.deepEqual(fixture.state.writers, [0, 1]);
          for (const name of [
            'planning',
            'baseline',
            'writer',
            'candidate',
            'integration',
            'integrated',
            'acceptance',
          ])
            assert.equal(
              fixture.state.calls.filter((item) => item.name === name && item.attempt === 1).length,
              1,
              'fresh post-CAN attempt missing ' + name,
            );
          report.can = {
            status: 'PASS',
            actualSuggestion: true,
            firstRunId: first.runId,
            nextRunId: next.runId,
            signals,
            syntheticCheckpointStorage: true,
            freshSyntheticHumanResume: resume,
            effectsBeforeResume: false,
            continuity,
          };
        } else {
          assert.equal(
            suggested,
            false,
            'server suggested CAN but no transition was observed within the fixed probe',
          );
          report.can = {
            status: 'NOT_QUALIFIED',
            signals,
            actualSuggestion: false,
            reason:
              'fixed threshold40 was supplied but no actual server suggestion/transition appeared within 12 signals/5s; no mocked suggestion or fallback',
          };
          await snapshot(fixture, 'unfinished-after-failed-CAN-probe');
          await cancelHeld(fixture, environment.client.workflow.getHandle(handle.workflowId));
        }
        report.scenarios.at(-1).status = report.can.status;
      }
    }
    report.status = mode === 'basic' || report.can.status === 'PASS' ? 'PASS' : 'FAIL';
  } catch (error) {
    report.status = 'FAIL';
    report.error = error instanceof Error ? error.stack : String(error);
  } finally {
    clearTimeout(budgetTimer);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
    for (const handle of handles) {
      try {
        await bounded('cleanup Workflow cancel', () => handle.cancel(), 1500, true);
      } catch {
        /* Completed or already cancelled; preserve observed histories below. */
      }
    }
    for (const fixture of fixtures) fixture.releaseAll();
    if (environment && historyToJSON) {
      try {
        const listing = await bounded(
          'export all isolated histories',
          () =>
            environment.client.workflowService.listWorkflowExecutions({
              namespace: 'default',
              pageSize: 100,
            }),
          3000,
          true,
        );
        assert.ok(!listing.nextPageToken?.length, 'complete history listing required');
        for (const row of listing.executions) {
          const { workflowId, runId } = row.execution;
          const history = await bounded(
            'export ' + workflowId,
            () => environment.client.workflow.getHandle(workflowId, runId).fetchHistory(),
            1000,
            true,
          );
          writeFileSync(
            join(evidence, 'histories', hash(workflowId + '/' + runId) + '.json'),
            historyToJSON(history),
          );
        }
      } catch (error) {
        report.historyExportError = String(error);
        report.status = 'FAIL';
      }
    }
    const stops = [];
    if (hostCleanup) {
      for (const name of ['restartClient', 'main', 'control', 'server']) {
        if (name === 'server' && environment) observeProcesses('before-SDK-teardown');
        try {
          stops.push({
            name,
            errors: await hostCleanup.closeSdkResources(
              resources[name],
              Math.max(1, Math.min(5000, deadline - performance.now())),
            ),
          });
        } catch (error) {
          stops.push({ name, errors: [String(error)] });
        }
      }
    }
    const osStopped = environment ? observeProcesses('after-SDK-teardown', true) : false;
    let listenerClosed = false;
    if (report.serverAddress) {
      const [host, port] = report.serverAddress.split(':');
      listenerClosed = await new Promise((done) => {
        const socket = connect({ host, port: Number(port) });
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          done(value);
        };
        const timer = setTimeout(() => finish(false), 1000);
        socket.once('connect', () => finish(false));
        socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'));
      });
    }
    report.stop = {
      stops,
      listenerClosed,
      resourceStates: Object.fromEntries(
        Object.entries(resources).map(([name, state]) => [
          name,
          {
            acquisitions: hostCleanup?.sdkAcquisitionProof(state),
            unknown: state.unknown ?? {},
            workerOwned: Boolean(state.worker),
            serverOwned: Boolean(state.connection),
          },
        ]),
      ),
      filesRetained: true,
      os: processes.proof(),
      confirmed: Boolean(
        environment &&
        osStopped &&
        listenerClosed &&
        !report.osStopUnknown &&
        stops.every((stop) => stop.errors.length === 0) &&
        Object.values(resources).every(
          (state) =>
            !Object.keys(state.unknown ?? {}).length &&
            !Object.keys(state.acquisitions ?? {}).length &&
            !state.worker &&
            !state.workerRun &&
            !state.connection,
        ),
      ),
      qualification:
        'SDK workerRun/teardown, captured OS descendant identities absent, and frontend refusal',
    };
    save('stop.json', report.stop);
    if (report.osStopUnknown || !report.stop.confirmed) report.status = 'FAIL';
    if (before) {
      try {
        const after = inventory();
        save('source-after.json', after);
        assert.deepEqual(after, before);
        report.sourceStable = true;
      } catch (error) {
        report.sourceError = String(error);
        report.status = 'FAIL';
      }
    }
    if (report.sdkLogUnknown || performance.now() > deadline) {
      report.status = 'FAIL';
      report.cleanupOrLogUnknown = true;
    }
    report.elapsedMs = Math.round(performance.now() - began);
    save('report.json', report);
  }
  console.log(
    JSON.stringify({
      status: report.status,
      evidence,
      qualification: false,
      can: report.can ?? null,
    }),
  );
  if (report.status === 'FAIL') process.exitCode = 1;
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--plan')
    console.log(JSON.stringify(taskExecutionSdkPlan(), null, 2));
  else if (process.argv.length === 3 && process.argv[2] === '--self-test')
    console.log(JSON.stringify(await taskExecutionSdkSelfTest()));
  else if (
    (process.argv.length === 3 || process.argv.length === 4) &&
    process.argv[2] === '--contract-smoke'
  )
    console.log(
      JSON.stringify(
        await taskExecutionSdkContractSmoke(
          process.argv[3] ? resolve(process.argv[3]) : packageRoot,
        ),
      ),
    );
  else {
    assert.ok(
      ['--run', '--run-can'].includes(process.argv[2]),
      'Use --plan, --self-test, --contract-smoke [COMPILED_PACKAGE_ROOT], --run REQUEST.json or --run-can REQUEST.json; a new SDK service authorization is required for run modes',
    );
    assert.equal(process.argv.length, 4);
    await runTaskExecutionSdk(
      JSON.parse(readFileSync(process.argv[3], 'utf8')),
      process.argv[2] === '--run-can' ? 'can' : 'basic',
    );
  }
}
