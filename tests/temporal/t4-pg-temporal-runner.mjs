import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';
import process from 'node:process';
import { runInNewContext } from 'node:vm';
import { parseConfig, temporaryServicePlan, temporalAcquisition } from './t4-pg-temporal-plan.mjs';
import {
  assertAllExecutablePins,
  assertExecutablePin,
  pinnedSpawn,
  processSample,
} from './t4-pg-temporal-binaries.mjs';
import {
  acquireSdkResource,
  startOwnedSdkWorker,
  sdkAcquisitionProof,
  closeSdkAndServer,
  rootRemovalDecision,
} from './t4-pg-temporal-cleanup.mjs';
import {
  assertOwnedPostgres,
  assertServicesStopped,
  descendantPids,
} from './t4-pg-temporal-ownership.mjs';
import { sourceRetentionObservation, assertReadbackWindow } from './t4-pg-temporal-retention.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function childEnvironment(original, port, socket) {
  return {
    ...Object.fromEntries(
      Object.entries(original).filter(
        ([key]) =>
          !/^(PG|SQL_|TEMPORAL|DYLD_|LD_)/iu.test(key) &&
          !/^(NODE_OPTIONS|NODE_PATH)$/iu.test(key) &&
          !/proxy$/iu.test(key),
      ),
    ),
    NO_PROXY: '127.0.0.1,localhost,::1',
    PGHOST: socket ?? '127.0.0.1',
    PGPORT: String(port),
    PGUSER: 'aw_t4',
    PGCONNECT_TIMEOUT: '5',
  };
}
export function assertCleanSdkHostEnvironment(environment) {
  assert.ok(
    !Object.keys(environment).some(
      (key) => /^(DYLD_|LD_)/iu.test(key) || /^(NODE_OPTIONS|NODE_PATH)$/iu.test(key),
    ),
    'SDK host requires clean loader/Node environment; launch with a sanitized child environment',
  );
}
export function boundedExecutor(allowed, remaining, environment, execute = execFileSync, pins) {
  return (command) => {
    const [file, ...args] = command;
    assert.ok(allowed.has(file), 'unapproved executable');
    let timeout = Math.floor(remaining());
    assert.ok(timeout > 0, 'run budget exhausted');
    assertExecutablePin(file, pins);
    timeout = Math.floor(remaining());
    assert.ok(timeout > 0, 'run budget exhausted after executable verification');
    const output = execute(file, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: environment,
    });
    assert.ok(remaining() > 0, 'run budget exhausted after native command');
    return output.trim();
  };
}
export function boundedObservation(remaining, execute = spawnSync) {
  return (file, args, options) => {
    const timeout = Math.floor(Math.min(options.timeout ?? Infinity, remaining()));
    assert.ok(timeout > 0, 'process observation deadline exhausted');
    const result = execute(file, args, { ...options, timeout });
    assert.ok(remaining() > 0, 'process observation exceeded deadline');
    return result;
  };
}
export function captureRecoveryDump(store, scratchPath, readback) {
  const dump = store.publish(readFileSync(scratchPath)),
    result = readback(store.path(dump));
  store.read(dump);
  return { dump, readback: result };
}
async function terminate(child, cleanupMs = 15000) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const outerRemaining = typeof cleanupMs === 'function' ? cleanupMs : () => cleanupMs,
    ms = Math.floor(outerRemaining()),
    deadline = performance.now() + ms,
    remaining = () => Math.min(outerRemaining(), deadline - performance.now());
  assert.ok(ms > 0, 'Temporal stop deadline exhausted');
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(
    () => {
      if (remaining() > 0) child.kill('SIGKILL');
    },
    Math.min(5000, Math.max(1, Math.floor(ms / 2))),
  );
  let deadlineTimer;
  try {
    await Promise.race([
      ended,
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new Error('Temporal stop outcome unknown after deadline')),
          ms,
        );
      }),
    ]);
    assert.ok(remaining() > 0, 'Temporal stop confirmation exceeded deadline');
  } finally {
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
  }
}
function directoryBytes(path) {
  const stat = lstatSync(path);
  return stat.isDirectory()
    ? readdirSync(path).reduce((sum, name) => sum + directoryBytes(join(path, name)), 0)
    : stat.size;
}
async function requireFreePorts(ports, remaining) {
  const reserved = [];
  try {
    for (const port of ports) {
      assert.ok(remaining() > 0, 'run budget exhausted before port observation');
      const server = createServer();
      reserved.push(server);
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
    }
  } finally {
    await Promise.all(reserved.map((server) => new Promise((done) => server.close(done))));
  }
}
export async function resumeRestoredPending({
  context,
  expected,
  pending,
  handle,
  canonical,
  bounded,
  save,
}) {
  assert.equal(context.resumePending, true, 'pending resume requires explicit opt-in');
  assert.equal(context.freshSourceTarget, true, 'only a fresh synthetic source/target may resume');
  assert.equal(context.restoredWorker, true, 'restored target Worker required');
  assert.equal(context.models, 0);
  assert.equal(expected.pending, true);
  assert.equal(expected.namespace, 't4-recovery');
  assert.ok(expected.workflowId.startsWith('aw/t4/'));
  assert.equal(expected.workflowId, expected.value.taskId);
  assert.equal(pending.workflowId, expected.workflowId);
  assert.equal(pending.runId, expected.runId);
  assert.equal(pending.status, 'RUNNING');
  assert.equal(pending.originalPrefixEqual, true);
  assert.equal(pending.queryEqual, true);
  assert.equal(pending.signalSent, false);
  assert.equal(pending.resume, undefined, 'a signal attempt must never be retried');
  assert.ok(
    expected.original.events.every(
      (event) =>
        event.eventType !== 'EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED' &&
        event.eventType !== 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' &&
        !/ACTIVITY/u.test(event.eventType),
    ),
  );
  const resume = {
    state: 'intent',
    workflowId: expected.workflowId,
    runId: expected.runId,
    signal: 't4ResumePending',
    requestedSignalCalls: 1,
    signalCalls: 0,
    models: 0,
    activities: 0,
    retryAllowed: false,
  };
  save('pending-resume-intent.json', resume, true);
  pending.resume = resume;
  try {
    await bounded(() => {
      resume.signalCalls++;
      return handle.signal(resume.signal);
    });
    pending.signalSent = true;
    assert.deepEqual(await bounded(() => handle.result()), expected.value);
    const description = await bounded(() => handle.describe());
    assert.equal(description.runId, expected.runId);
    assert.equal(description.status.name, 'COMPLETED');
    const history = await bounded(() => handle.fetchHistory()),
      actual = canonical(history);
    assert.deepEqual(
      actual.events.slice(0, expected.original.events.length),
      expected.original.events,
    );
    const signals = actual.events.filter(
      (event) => event.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED',
    );
    const completions = actual.events.filter(
      (event) => event.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
    );
    const activities = actual.events.filter((event) => /ACTIVITY/u.test(event.eventType));
    assert.equal(signals.length, 1);
    assert.equal(signals[0].workflowExecutionSignaledEventAttributes.signalName, resume.signal);
    assert.equal(completions.length, 1);
    assert.equal(activities.length, 0);
    save('pending-resumed-history.json', history, true);
    Object.assign(resume, {
      state: 'completed',
      signalEvents: 1,
      completionEvents: 1,
      activityEvents: 0,
      resultEqual: true,
      originalPrefixEqual: true,
    });
    pending.status = 'COMPLETED';
    save('pending-resume-outcome.json', resume, true);
  } catch (error) {
    Object.assign(resume, { state: 'unknown', error: String(error) });
    save('pending-resume-outcome.json', resume, true);
    throw error;
  }
}

export async function runPgTemporal(raw) {
  const started = performance.now(),
    config = parseConfig(raw),
    workDeadline = started + config.budget.mainMs,
    outerDeadline = started + config.budget.outerMs,
    remaining = () => workDeadline - performance.now(),
    cleanupRemaining = () =>
      Math.max(0, Math.min(config.budget.cleanupMs, outerDeadline - performance.now()));
  const checkOuter = () =>
    assert.ok(performance.now() < outerDeadline, 'outer run deadline exhausted');
  assertCleanSdkHostEnvironment(process.env);
  assert.ok(
    typeof config.authorization.evidence === 'string' &&
      config.authorization.evidence.length > 20 &&
      !config.authorization.evidence.includes('REPLACE'),
    'new direct acquisition/service run authorization required',
  );
  assert.ok(
    config.executables.postgresDirectory &&
      config.executables.temporalServer &&
      config.executables.temporalSqlTool,
    'existing pinned executables required; this runner never downloads',
  );
  assert.equal(
    config.recoverySet,
    null,
    'this runner creates a fresh isolated source; existing storage is never imported',
  );
  assert.ok(remaining() > 0, 'run budget exhausted before executable verification');
  const executableInventory = assertAllExecutablePins(config, temporalAcquisition.sha256);
  assert.ok(remaining() > 0, 'run budget exhausted after executable verification');
  const { Client, Connection } = await import('@temporalio/client'),
    { NativeConnection, Worker, bundleWorkflowCode } = await import('@temporalio/worker'),
    { historyToJSON } = await import('@temporalio/common/proto-utils'),
    { createBackup, inspectFileBackup, verifyTemporalRecoverySet, stageTemporalRecoverySet } =
      await import(join(packageRoot, 'dist/adapters/artifacts/backup.js')),
    { artifactStore, digest } = await import(join(packageRoot, 'dist/adapters/artifacts/files.js'));
  assert.ok(remaining() > 0, 'run budget exhausted after SDK imports');
  const root = realpathSync(mkdtempSync(join(config.target.parent, 'aw-t4-pg-temporal-'))),
    evidence = realpathSync(mkdtempSync(join(packageRoot, 'tmp/t4-pg-temporal-'))),
    sourceFiles = join(root, 'source-files'),
    restored = join(root, 'restored'),
    pg = config.executables.postgresDirectory,
    toolsRoot = dirname(config.executables.temporalServer),
    plan = temporaryServicePlan(config, root, toolsRoot),
    environment = childEnvironment(process.env, config.target.postgresPort, join(root, 'socket')),
    allowed = new Set(
      ['postgres', 'initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore', 'createdb']
        .map((name) => join(pg, name))
        .concat(config.executables.temporalSqlTool, config.executables.temporalServer),
    ),
    command = boundedExecutor(allowed, remaining, environment, execFileSync, config.executablePins),
    proof = {
      schemaVersion: 1,
      scope: 'isolated-real-postgresql-temporal-restore',
      status: 'RUNNING',
      evidence,
      root,
      authorization: config.authorization.evidence,
      serverStarts: 0,
      postgresStarts: 0,
      sdkWorkerStarts: 0,
      modelStarts: 0,
      clock: {
        kind: 'monotonic-common-work-and-outer-deadlines',
        mainMs: config.budget.mainMs,
        outerMs: config.budget.outerMs,
        cleanupMs: config.budget.cleanupMs,
        synchronousIoInterruption: 'NOT_QUALIFIED',
      },
      resumePending: config.resumePending === true,
      closed: [],
      pending: null,
      commands: [],
      samples: [],
      cleanup: {},
      applicationActivationAllowed: false,
      unknown: {
        grants: 'unknown; never adopted',
        activeExternalWriter: 'NOT QUALIFIED',
        productionRestore: 'NOT QUALIFIED',
      },
    };
  const save = (name, value, exclusive = false) =>
      writeFileSync(join(evidence, name), JSON.stringify(value, null, 2), {
        mode: 0o600,
        ...(exclusive ? { flag: 'wx' } : {}),
      }),
    canonical = (history) => JSON.parse(historyToJSON(history));
  let child,
    activePg,
    cleaning = false,
    observationDeadline = Infinity;
  const observe = boundedObservation(() =>
    Math.min(cleaning ? cleanupRemaining() : remaining(), observationDeadline - performance.now()),
  );
  const sdk = { worker: null, workerRun: null, native: null, connection: null, unknown: {} },
    temporalPids = new Set(),
    postgresPids = new Set();
  const proxyVariables = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /proxy$/iu.test(key)),
  );
  save('operator-config.json', config);
  save('service-plan.json', plan);
  function sample() {
    const pids = [];
    if (activePg && existsSync(join(activePg, 'postmaster.pid')))
      pids.push(Number(readFileSync(join(activePg, 'postmaster.pid'), 'utf8').split('\n')[0]));
    if (child?.pid && child.exitCode === null) pids.push(child.pid);
    const observed = processSample(config.executablePins, observe, environment);
    if (observed.status !== 0) {
      proof.samples.push({ elapsedMs: Math.round(performance.now() - started), status: 'unknown' });
      return;
    }
    const rows = observed.stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/u)),
      owned = new Set(pids);
    for (let previous = -1; previous !== owned.size;) {
      previous = owned.size;
      for (const row of rows) if (owned.has(Number(row[1]))) owned.add(Number(row[0]));
    }
    proof.samples.push({
      elapsedMs: Math.round(performance.now() - started),
      processes: rows
        .filter((row) => owned.has(Number(row[0])))
        .map((row) => ({ pid: Number(row[0]), rssKb: Number(row[2]), cpu: row[3] })),
      caveat: 'observed samples; shared pages counted per process; no hard RSS peak',
    });
    if (child?.pid) for (const pid of descendantPids(child.pid, observed)) temporalPids.add(pid);
    if (activePg && pids[0])
      for (const pid of descendantPids(pids[0], observed)) postgresPids.add(pid);
    const latest = proof.samples.at(-1),
      temporalRss = latest.processes.find((row) => row.pid === child?.pid)?.rssKb ?? 0;
    assert.ok(
      temporalRss * 1024 <= config.budget.temporalMaxObservedRssBytes,
      'observed Temporal RSS budget exceeded',
    );
    proof.observedDiskBytes = directoryBytes(root) + directoryBytes(evidence);
    latest.diskBytes = proof.observedDiskBytes;
    proof.maxObservedDiskBytes = Math.max(proof.maxObservedDiskBytes ?? 0, proof.observedDiskBytes);
    assert.ok(
      proof.observedDiskBytes <= config.budget.maxObservedDiskBytes,
      'observed disk budget exceeded',
    );
  }
  function ownedPg() {
    const identity = assertOwnedPostgres(
      activePg,
      join(root, 'socket'),
      config.target.postgresPort,
      join(pg, 'postgres'),
      config.executablePins,
      environment,
      observe,
    );
    for (const pid of identity.descendants) postgresPids.add(pid);
    return identity;
  }
  function run(args) {
    if ([join(pg, 'initdb'), join(pg, 'pg_ctl')].includes(args[0]))
      assertExecutablePin(join(pg, 'postgres'), config.executablePins);
    if (
      activePg &&
      [
        config.executables.temporalSqlTool,
        ...['psql', 'createdb', 'pg_dump', 'pg_restore'].map((name) => join(pg, name)),
      ].includes(args[0])
    )
      proof.lastPostgresIdentity = ownedPg();
    const before = performance.now(),
      output = command(args);
    proof.commands.push({
      executable: args[0],
      args: args.slice(1),
      elapsedMs: Math.round(performance.now() - before),
    });
    sample();
    save('proof.json', proof);
    return output;
  }
  async function bounded(operation) {
    const ms = Math.floor(remaining());
    assert.ok(ms > 0, 'run budget exhausted');
    let timeout;
    try {
      const value = await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('run budget exhausted')), ms);
        }),
      ]);
      assert.ok(remaining() > 0, 'run budget exhausted after SDK operation');
      return value;
    } finally {
      clearTimeout(timeout);
    }
  }
  function acquisitionChanged() {
    proof.cleanup.sdkAcquisitions = sdkAcquisitionProof(sdk);
    if (Object.keys(sdk.unknown).length) {
      proof.status = 'FAIL';
      proof.cleanup.sdkUnknown = { ...sdk.unknown };
    }
    save('sdk-acquisitions.json', proof.cleanup.sdkAcquisitions);
    save('proof.json', proof);
  }
  function acquire(name, operation) {
    return acquireSdkResource(
      sdk,
      name,
      operation,
      remaining,
      cleanupRemaining,
      acquisitionChanged,
    );
  }
  async function stopServer() {
    const stageDeadline = Math.min(outerDeadline, performance.now() + config.budget.cleanupMs),
      stageRemaining = () => Math.max(0, stageDeadline - performance.now()),
      previous = observationDeadline;
    observationDeadline = Math.min(observationDeadline, stageDeadline);
    try {
      await closeSdkAndServer(sdk, stageRemaining, async () => {
        if (!child) return;
        for (const pid of descendantPids(
          child.pid,
          processSample(config.executablePins, observe, environment),
        ))
          temporalPids.add(pid);
        const descendants = [...temporalPids];
        await terminate(child, stageRemaining);
        assert.ok(
          child.exitCode !== null || child.signalCode !== null,
          'owned Temporal process still alive',
        );
        proof.cleanup.temporalExit = {
          pid: child.pid,
          code: child.exitCode,
          signal: child.signalCode,
          ...assertServicesStopped(
            descendants,
            Array.from({ length: 8 }, (_, index) => config.target.grpcPort + index),
            null,
            config.executablePins,
            environment,
            observe,
          ),
        };
        (proof.cleanup.temporalStops ??= []).push(proof.cleanup.temporalExit);
        child = null;
        temporalPids.clear();
      });
    } finally {
      observationDeadline = previous;
      if (Object.keys(sdk.unknown).length) proof.cleanup.sdkUnknown = { ...sdk.unknown };
    }
  }
  function stopPg() {
    if (!activePg) return;
    const stageDeadline = Math.min(outerDeadline, performance.now() + config.budget.cleanupMs),
      stageRemaining = () => Math.max(0, stageDeadline - performance.now()),
      previous = observationDeadline;
    observationDeadline = Math.min(observationDeadline, stageDeadline);
    try {
      ownedPg();
      const stop = pinnedSpawn(
          join(pg, 'pg_ctl'),
          ['-D', activePg, '-m', 'immediate', '-w', 'stop'],
          {
            encoding: 'utf8',
            timeout: stageRemaining(),
            env: environment,
          },
          config.executablePins,
          observe,
        ),
        status = pinnedSpawn(
          join(pg, 'pg_ctl'),
          ['-D', activePg, 'status'],
          {
            encoding: 'utf8',
            timeout: Math.min(5000, stageRemaining()),
            env: environment,
          },
          config.executablePins,
          observe,
        );
      proof.cleanup.postgres = {
        data: activePg,
        stop: stop.status,
        status: status.status,
        ...assertServicesStopped(
          [...postgresPids],
          [config.target.postgresPort],
          join(root, 'socket', '.s.PGSQL.' + config.target.postgresPort),
          config.executablePins,
          environment,
          observe,
        ),
      };
      (proof.cleanup.postgresStops ??= []).push(proof.cleanup.postgres);
      assert.equal(status.status, 3, 'owned PostgreSQL still active');
      assert.equal(stop.status, 0, 'PostgreSQL stop outcome unknown');
      activePg = null;
      postgresPids.clear();
    } finally {
      observationDeadline = previous;
    }
  }
  function startPg(data) {
    run([
      join(pg, 'initdb'),
      '-D',
      data,
      '-A',
      'trust',
      '-U',
      'aw_t4',
      '--no-locale',
      '-E',
      'UTF8',
    ]);
    const socket = join(root, 'socket');
    if (!existsSync(socket)) mkdirSync(socket, { mode: 0o700 });
    appendFileSync(
      join(data, 'postgresql.conf'),
      `\nlisten_addresses='127.0.0.1'\nunix_socket_directories='${socket.replaceAll("'", "''")}'\nport=${config.target.postgresPort}\nshared_buffers='${config.budget.postgresSharedBuffersMb}MB'\nmax_connections=${config.budget.postgresMaxConnections}\nwork_mem='1MB'\nmaintenance_work_mem='16MB'\nmax_parallel_workers=0\nmax_worker_processes=0\nautovacuum=off\nmax_wal_size='128MB'\nmin_wal_size='32MB'\nfsync=on\n`,
    );
    activePg = data;
    proof.postgresStarts++;
    assertExecutablePin(join(pg, 'postgres'), config.executablePins);
    run([
      join(pg, 'pg_ctl'),
      '-D',
      data,
      '-p',
      join(pg, 'postgres'),
      '-l',
      join(evidence, data.endsWith('source') ? 'pg-source.log' : 'pg-target.log'),
      '-w',
      'start',
    ]);
    proof.lastPostgresIdentity = ownedPg();
  }
  async function startServer(bundle, label) {
    proof.lastPostgresIdentity = ownedPg();
    const configFile =
      label === 'source' ? join(root, 'temporal.json') : join(restored, 'build/server.json');
    if (label === 'source')
      writeFileSync(configFile, JSON.stringify(plan.serverConfiguration), { mode: 0o600 });
    else assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), plan.serverConfiguration);
    const stdout = openSync(join(evidence, label + '-server.stdout.log'), 'wx', 0o600),
      stderr = openSync(join(evidence, label + '-server.stderr.log'), 'wx', 0o600);
    try {
      child = pinnedSpawn(
        config.executables.temporalServer,
        ['--config-file', configFile, '--allow-no-auth', 'start'],
        { cwd: root, env: environment, stdio: ['ignore', stdout, stderr] },
        config.executablePins,
        (...args) => {
          assert.ok(remaining() > 0, 'run budget exhausted before Temporal spawn');
          return spawn(...args);
        },
      );
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    child.on('error', (error) => {
      proof.spawnError = String(error);
    });
    proof.serverStarts++;
    let listener;
    do {
      assert.ok(
        child.pid && child.exitCode === null && child.signalCode === null && remaining() > 0,
        'owned Temporal failed before opening its listener',
      );
      listener = pinnedSpawn(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-p', String(child.pid), '-iTCP:' + config.target.grpcPort, '-sTCP:LISTEN'],
        { encoding: 'utf8', timeout: Math.min(2000, remaining()), env: environment },
        config.executablePins,
        observe,
      );
      if (listener.status !== 0) await new Promise((done) => setTimeout(done, 100));
    } while (listener.status !== 0);
    assert.ok(
      listener.stdout.includes('127.0.0.1:' + config.target.grpcPort),
      'frontend must be owned and bound to loopback',
    );
    save(label + '-listener.json', { pid: child.pid, raw: listener.stdout });
    proof.lastPostgresIdentity = ownedPg();
    const address = '127.0.0.1:' + config.target.grpcPort;
    await acquire('connection', () =>
      Connection.connect({
        address,
        connectTimeout: Math.max(1, remaining()),
        channelArgs: { 'grpc.enable_http_proxy': 0 },
      }),
    );
    if (label === 'source')
      await bounded(() =>
        sdk.connection.workflowService.registerNamespace({
          namespace: 't4-recovery',
          workflowExecutionRetentionPeriod: { seconds: 86400 },
          description: 'isolated T4 model-free storage recovery',
        }),
      );
    await acquire('native', () => NativeConnection.connect({ address }));
    await acquire('worker', () =>
      Worker.create({
        connection: sdk.native,
        namespace: 't4-recovery',
        taskQueue: 't4-storage',
        workflowBundle: bundle,
        shutdownGraceTime: '0ms',
        shutdownForceTime: '5s',
      }),
    );
    startOwnedSdkWorker(sdk, remaining);
    sdk.workerRun.catch((error) => {
      proof.workerError = String(error);
    });
    proof.sdkWorkerStarts++;
    sample();
    return new Client({ connection: sdk.connection, namespace: 't4-recovery' });
  }
  function schemaVersion(database) {
    return run([
      join(pg, 'psql'),
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-d',
      database,
      '-c',
      'SELECT curr_version,min_compatible_version FROM schema_version',
    ]);
  }
  try {
    for (const key of Object.keys(proxyVariables)) delete process.env[key];
    process.env.NO_PROXY = '127.0.0.1,localhost,::1';
    proof.versions = {
      temporal: run([config.executables.temporalServer, '--version']),
      sqlTool: run([config.executables.temporalSqlTool, '--version']),
      postgresql: run([join(pg, 'postgres'), '--version']),
    };
    assert.match(proof.versions.temporal, /\b1\.32\.0\b/u);
    assert.match(proof.versions.sqlTool, /\b1\.32\.0\b/u);
    proof.executables = executableInventory;
    const bundle = await bounded(() =>
      bundleWorkflowCode({
        workflowsPath: join(packageRoot, 'tests/temporal/t4-pg-temporal-workflows.mjs'),
      }),
    );
    await bounded(() =>
      requireFreePorts(
        [
          config.target.postgresPort,
          ...Array.from({ length: 8 }, (_, index) => config.target.grpcPort + index),
        ],
        remaining,
      ),
    );
    const roots = Object.fromEntries(
      ['artifacts', 'receipts', 'projections', 'workspaces', 'build'].map((name) => [
        name,
        join(sourceFiles, name),
      ]),
    );
    mkdirSync(sourceFiles, { mode: 0o700 });
    for (const directory of Object.values(roots)) mkdirSync(directory, { mode: 0o700 });
    const store = artifactStore(roots.artifacts),
      resultValue = {
        outcome: 'FAIL',
        findings: [{ id: 'F-1', disposition: 'retained' }],
        Result: 'original failing evidence',
        raw: 'unchanged',
      },
      evidenceRef = store.publish(Buffer.from(JSON.stringify(resultValue))),
      configuration = {
        sha256: digest(JSON.stringify(plan.serverConfiguration)),
        bytes: Buffer.byteLength(JSON.stringify(plan.serverConfiguration)),
      },
      buildBytes = Buffer.from(bundle.code),
      workerBuild = { sha256: digest(buildBytes), bytes: buildBytes.length };
    writeFileSync(join(roots.build, 'server.json'), JSON.stringify(plan.serverConfiguration), {
      mode: 0o600,
    });
    writeFileSync(join(roots.build, 'worker.js'), buildBytes, { mode: 0o600 });
    writeFileSync(
      join(roots.build, 'runtime-versions.json'),
      JSON.stringify({
        versions: proof.versions,
        executables: proof.executables,
        node: process.version,
      }),
      { mode: 0o600 },
    );
    mkdirSync(join(roots.workspaces, 'source-copy'));
    writeFileSync(
      join(roots.workspaces, 'source-copy/unfinished.txt'),
      'original unintegrated files; no real external writer',
      { mode: 0o600 },
    );
    writeFileSync(
      join(roots.receipts, 'unknown-grant.json'),
      '{"outcome":"unknown","activationAllowed":false,"externalWriter":"not qualified"}',
      { mode: 0o600 },
    );
    startPg(join(root, 'postgres-source'));
    for (const args of plan.schemaCreate)
      run([config.executables.temporalSqlTool, ...args.slice(1)]);
    const schemas = {
        t4_temporal: schemaVersion('t4_temporal'),
        t4_visibility: schemaVersion('t4_visibility'),
      },
      client = await startServer(bundle, 'source'),
      nonce = randomUUID(),
      primary = [];
    for (const [name, pending] of [
      ['pass', false],
      ['fail', false],
      ['pending', true],
    ]) {
      const value = {
          taskId: 'aw/t4/' + nonce + '/' + name,
          evidence: evidenceRef,
          result: name === 'pass' ? { outcome: 'PASS', original: true } : resultValue,
        },
        handle = await bounded(() =>
          client.workflow.start('t4StorageCase', {
            workflowId: value.taskId,
            taskQueue: 't4-storage',
            args: [
              {
                pending,
                result: value,
                ...(config.resumePending === true ? { resumePending: true } : {}),
              },
            ],
          }),
        );
      if (!pending) assert.deepEqual(await bounded(() => handle.result()), value);
      else
        assert.deepEqual(await bounded(() => handle.query('t4RecoveryState')), {
          waiting: true,
          original: value,
        });
      const description = await bounded(() => handle.describe()),
        history = await bounded(() => handle.fetchHistory()),
        bytes = Buffer.from(JSON.stringify(history)),
        historyRef = store.publish(bytes),
        resultRef = pending ? null : store.publish(Buffer.from(JSON.stringify(value)));
      primary.push({
        namespace: 't4-recovery',
        workflowId: handle.workflowId,
        runId: description.runId,
        description: {
          workflowId: handle.workflowId,
          runId: description.runId,
          status: description.status.name,
        },
        rawDescription: description.raw,
        history: historyRef,
        result: resultRef,
        pending,
        value,
        original: canonical(history),
      });
      save(name + '-primary-history.json', history);
      save(name + '-primary-description.json', description.raw);
      sample();
    }
    const namespaceResponse = await bounded(() =>
      sdk.connection.workflowService.describeNamespace({ namespace: 't4-recovery' }),
    );
    save('source-namespace-response.json', namespaceResponse);
    const namespaceRef = store.publish(Buffer.from(JSON.stringify(namespaceResponse)));
    await stopServer();
    const cutBytes = Buffer.from(
        JSON.stringify({
          id: nonce,
          models: 0,
          SDKWorkersStopped: true,
          temporalStopped: proof.cleanup.temporalExit,
          grants: 'unknown; not authority',
        }),
      ),
      cutReceipt = { sha256: digest(cutBytes), bytes: cutBytes.length };
    writeFileSync(join(roots.receipts, 'cut.json'), cutBytes, { mode: 0o600 });
    const snapshotAt = performance.now(),
      datastores = [];
    let timerSql;
    for (const [index, name] of ['t4_temporal', 't4_visibility'].entries()) {
      const dump = join(root, name + '.pgdump');
      run([join(pg, 'pg_dump'), '-Fc', '-d', name, '-f', dump]);
      const captured = captureRecoveryDump(store, dump, (immutableDump) => {
        run([join(pg, 'pg_restore'), '--list', immutableDump]);
        return index === 0
          ? run([
              join(pg, 'pg_restore'),
              '--data-only',
              '--table=timer_tasks',
              '--file=-',
              immutableDump,
            ]) + '\n'
          : null;
      });
      if (index === 0) {
        timerSql = captured.readback;
        save('source-timer-tasks.json', { dump: captured.dump, dumpReadOnly: true, sql: timerSql });
      }
      datastores.push({
        role: index === 0 ? 'default' : 'visibility',
        source: 'owned-source-' + nonce,
        database: name,
        schemaVersion: schemas[name],
        dump: captured.dump,
      });
    }
    const retentionObservation = sourceRetentionObservation(namespaceResponse, primary, timerSql),
      retentionRef = store.publish(Buffer.from(JSON.stringify(retentionObservation))),
      timerRef = store.publish(Buffer.from(timerSql)),
      primaryRef = store.publish(Buffer.from(JSON.stringify(primary)));
    save('source-retention-observation.json', retentionObservation);
    stopPg();
    const snapshot = {
        schemaVersion: 1,
        kind: 'temporal-storage-snapshot',
        backend: 'postgresql',
        versions: { temporal: proof.versions.temporal, postgresql: proof.versions.postgresql },
        configuration,
        workerBuild,
        cut: { id: nonce, capturedAt: new Date().toISOString(), receipt: cutReceipt },
        datastores,
        workflows: primary.map(({ namespace, workflowId, runId, history, result }) => ({
          namespace,
          workflowId,
          runId,
          history,
          result,
        })),
        evidence: [
          { id: 'F-1', content: evidenceRef },
          { id: 'source-namespace-response', content: namespaceRef },
          { id: 'source-timer-tasks', content: timerRef },
          { id: 'source-primary-readback', content: primaryRef },
          { id: 'source-retention-observation', content: retentionRef },
        ],
        workcopies: [{ id: 'unknown-external-writer', root: 'workspaces/source-copy' }],
      },
      snapshotBytes = Buffer.from(JSON.stringify(snapshot)),
      snapshotRef = { sha256: digest(snapshotBytes), bytes: snapshotBytes.length };
    writeFileSync(join(roots.build, 'storage-snapshot.json'), snapshotBytes, { mode: 0o600 });
    writeFileSync(
      join(roots.projections, 'closed.json'),
      JSON.stringify(
        primary.map((item) => ({
          id: item.workflowId,
          pending: item.pending,
          result: item.result,
        })),
      ),
      { mode: 0o600 },
    );
    const backupInput = { schemaVersion: 2, roots, destination: join(evidence, 'backup') },
      inspected = inspectFileBackup(backupInput),
      saved = createBackup(backupInput, inspected.manifest),
      recoverySet = {
        schemaVersion: 1,
        backup: backupInput.destination,
        manifest: saved.manifest,
        snapshot: snapshotRef,
      };
    const verifiedSet = verifyTemporalRecoverySet(recoverySet);
    assert.equal(verifiedSet.activationAllowed, false);
    assert.equal(verifiedSet.requiresReconciliation, true);
    save('recovery-set.json', recoverySet);
    save('snapshot.json', snapshot);
    save('primary.json', primary);
    const archivedReadback = {
      kind: 't4-archived-readback/1',
      snapshot: snapshotRef,
      defaultDump: datastores[0].dump,
      workflows: retentionObservation.workflows,
    };
    save('archived-readback.json', archivedReadback);
    proof.retentionWindow = assertReadbackWindow(
      archivedReadback.workflows,
      Date.now(),
      config.budget.outerMs,
    );
    proof.recoverySet = recoverySet;
    const lossAt = performance.now();
    rmSync(sourceFiles, { recursive: true });
    rmSync(join(root, 'postgres-source'), { recursive: true });
    for (const database of ['t4_temporal', 't4_visibility'])
      unlinkSync(join(root, database + '.pgdump'));
    proof.sourceCopiesRemovedBeforeRestore = true;
    const stagedSet = stageTemporalRecoverySet({ ...recoverySet, destination: restored });
    assert.equal(stagedSet.activationAllowed, false);
    assert.equal(stagedSet.requiresReconciliation, true);
    proof.unknownGrantsDidNotAuthorizeActivation = true;
    startPg(join(root, 'postgres-target'));
    for (const entry of datastores) {
      run([join(pg, 'createdb'), entry.database]);
      run([
        join(pg, 'pg_restore'),
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--single-transaction',
        '-d',
        entry.database,
        join(restored, 'artifacts', entry.dump.sha256),
      ]);
      assert.equal(schemaVersion(entry.database), entry.schemaVersion);
    }
    const restoredBundle = { code: readFileSync(join(restored, 'build/worker.js'), 'utf8') };
    assert.equal(digest(restoredBundle.code), workerBuild.sha256);
    proof.retentionWindowBeforeTargetStart = assertReadbackWindow(
      archivedReadback.workflows,
      Date.now(),
      config.budget.outerMs,
    );
    const restoredClient = await startServer(restoredBundle, 'target');
    for (const expected of primary) {
      const handle = restoredClient.workflow.getHandle(expected.workflowId, expected.runId),
        description = await bounded(() => handle.describe()),
        history = await bounded(() => handle.fetchHistory());
      assert.equal(description.runId, expected.runId);
      assert.equal(description.status.name, expected.pending ? 'RUNNING' : 'COMPLETED');
      const actual = canonical(history);
      assert.deepEqual(
        expected.pending ? actual.events.slice(0, expected.original.events.length) : actual.events,
        expected.original.events,
      );
      save(
        expected.pending
          ? 'pending-restored-history.json'
          : expected.value.result?.outcome === 'PASS'
            ? 'pass-restored-history.json'
            : 'fail-restored-history.json',
        history,
      );
      if (expected.pending) {
        assert.deepEqual(await bounded(() => handle.query('t4RecoveryState')), {
          waiting: true,
          original: expected.value,
        });
        proof.pending = {
          workflowId: expected.workflowId,
          runId: expected.runId,
          status: 'RUNNING',
          originalPrefixEqual: true,
          queryEqual: true,
          signalSent: false,
          grants: 'unknown',
          activationAllowed: false,
        };
        if (config.resumePending === true)
          await resumeRestoredPending({
            context: {
              resumePending: true,
              freshSourceTarget: config.recoverySet === null,
              restoredWorker: proof.sdkWorkerStarts === 2 && proof.serverStarts === 2,
              models: proof.modelStarts,
            },
            expected,
            pending: proof.pending,
            handle,
            canonical,
            bounded,
            save,
          });
      } else {
        assert.deepEqual(await bounded(() => handle.result()), expected.value);
        proof.closed.push({
          workflowId: expected.workflowId,
          runId: expected.runId,
          status: 'COMPLETED',
          historyEqual: true,
          resultEqual: true,
        });
      }
    }
    assert.equal(
      readFileSync(join(restored, 'workspaces/source-copy/unfinished.txt'), 'utf8'),
      'original unintegrated files; no real external writer',
    );
    assert.equal(
      digest(readFileSync(join(restored, 'artifacts', evidenceRef.sha256))),
      evidenceRef.sha256,
    );
    assert.match(readFileSync(join(restored, 'receipts/unknown-grant.json'), 'utf8'), /unknown/u);
    proof.rpoMs = Math.round(lossAt - snapshotAt);
    proof.rtoMs = Math.round(performance.now() - lossAt);
    assert.ok(remaining() > 0, 'run budget exhausted before qualification');
    proof.status = 'PASS';
  } catch (error) {
    proof.status = 'FAIL';
    proof.error = error instanceof Error ? error.stack : String(error);
  } finally {
    cleaning = true;
    try {
      await stopServer();
    } catch (error) {
      proof.status = 'FAIL';
      proof.cleanup.serverError = String(error);
    }
    try {
      stopPg();
    } catch (error) {
      proof.status = 'FAIL';
      proof.cleanup.postgresError = String(error);
    }
    if (child) {
      try {
        await terminate(child, cleanupRemaining);
      } catch (error) {
        proof.status = 'FAIL';
        proof.cleanup.temporalStopError = String(error);
      }
    }
    if (proof.recoverySet) {
      try {
        checkOuter();
        verifyTemporalRecoverySet(proof.recoverySet);
        checkOuter();
        proof.cleanup.immutableRecoverySetVerified = true;
      } catch (error) {
        proof.status = 'FAIL';
        proof.cleanup.setError = String(error);
      }
    }
    proof.elapsedMs = Math.round(performance.now() - started);
    if (proof.elapsedMs > config.budget.outerMs) {
      proof.status = 'FAIL';
      proof.cleanup.outerBudgetError = 'proposed outer run window exceeded';
    }
    proof.resources = {
      nodeMaxRssKb: process.resourceUsage().maxRSS,
      samplesAreObservedOnly: true,
    };
    for (const key of Object.keys(process.env).filter((key) => /proxy$/iu.test(key)))
      delete process.env[key];
    Object.assign(process.env, proxyVariables);
    try {
      if (proof.status === 'PASS' && proof.cleanup.immutableRecoverySetVerified === true) {
        checkOuter();
        const files = {};
        function inventory(directory, relative = '') {
          for (const name of readdirSync(directory)) {
            checkOuter();
            const path = join(directory, name),
              key = relative ? relative + '/' + name : name,
              stat = lstatSync(path);
            assert.ok(!stat.isSymbolicLink(), 'evidence symlink rejected');
            if (stat.isDirectory()) inventory(path, key);
            else {
              assert.ok(stat.isFile() && stat.nlink === 1, 'regular evidence required');
              if (key !== 'proof.json' && key !== 'evidence-inventory.json') {
                const bytes = readFileSync(path);
                files[key] = { sha256: digest(bytes), bytes: bytes.length };
              }
            }
          }
        }
        inventory(evidence);
        checkOuter();
        for (const required of [
          'operator-config.json',
          'service-plan.json',
          'recovery-set.json',
          'snapshot.json',
          'primary.json',
          'source-namespace-response.json',
          'source-timer-tasks.json',
          'source-retention-observation.json',
          'archived-readback.json',
          'pass-primary-description.json',
          'fail-primary-description.json',
          'pending-primary-description.json',
        ])
          assert.ok(files[required], 'missing exported evidence: ' + required);
        save('evidence-inventory.json', files);
        for (const [path, expected] of Object.entries(
          JSON.parse(readFileSync(join(evidence, 'evidence-inventory.json'), 'utf8')),
        )) {
          checkOuter();
          const bytes = readFileSync(join(evidence, path));
          assert.deepEqual({ sha256: digest(bytes), bytes: bytes.length }, expected);
        }
        checkOuter();
        proof.cleanup.evidenceVerified = true;
      }
    } catch (error) {
      proof.status = 'FAIL';
      proof.cleanup.evidenceError = String(error);
    }
    proof.elapsedMs = Math.round(performance.now() - started);
    if (proof.elapsedMs > config.budget.outerMs) {
      proof.status = 'FAIL';
      proof.cleanup.outerBudgetError = 'proposed outer run window exceeded';
    }
    save('proof.json', proof);
    const proofSaved =
        JSON.stringify(JSON.parse(readFileSync(join(evidence, 'proof.json'), 'utf8'))) ===
        JSON.stringify(proof),
      decision = rootRemovalDecision(proof, { ...sdk, child, activePg }, proofSaved);
    proof.cleanup.rootRemoval = decision;
    if (decision.allowed) {
      try {
        checkOuter();
        rmSync(root, { recursive: true });
        checkOuter();
        proof.cleanup.temporaryCopiesRemoved = !existsSync(root);
      } catch (error) {
        proof.status = 'FAIL';
        proof.cleanup.removalError = String(error);
        proof.cleanup.workingRootRetained = root;
      }
    } else {
      proof.cleanup.workingRootRetained = root;
      if (proof.status === 'PASS') {
        proof.status = 'FAIL';
        proof.cleanup.keeperError = decision.reasons.join('; ');
      }
    }
    proof.elapsedMs = Math.round(performance.now() - started);
    if (performance.now() >= outerDeadline) {
      proof.status = 'FAIL';
      proof.cleanup.outerBudgetError = 'proposed outer run window exhausted';
    }
    save('proof.json', proof);
    console.log(
      JSON.stringify({
        status: proof.status,
        evidence,
        closed: proof.closed.length,
        pending: proof.pending,
        rpoMs: proof.rpoMs ?? null,
        rtoMs: proof.rtoMs ?? null,
        modelStarts: 0,
        cleanup: proof.cleanup,
      }),
    );
  }
  if (proof.status !== 'PASS') process.exitCode = 1;
  return proof;
}
export async function fakeExecSelfTest() {
  const original = {
      KEEP: 'yes',
      PGSERVICE: 'bad',
      PGHOSTADDR: 'bad',
      PGPASSWORD: 'hidden',
      SQL_CONNECT_ATTRIBUTES: 'bad',
      SQL_TLS: 'bad',
      TEMPORAL_ADDRESS: 'bad',
    },
    environment = childEnvironment(original, 55438);
  assert.deepEqual(Object.keys(environment).sort(), [
    'KEEP',
    'NO_PROXY',
    'PGCONNECT_TIMEOUT',
    'PGHOST',
    'PGPORT',
    'PGUSER',
  ]);
  assert.equal(environment.PGHOST, '127.0.0.1');
  class FakeChild extends EventEmitter {
    pid = 123;
    exitCode = null;
    signalCode = null;
    signals = [];
    kill(signal) {
      this.signals.push(signal);
      this.signalCode = signal;
      this.emit('exit', null, signal);
      return true;
    }
  }
  const owned = new FakeChild();
  await terminate(owned);
  assert.deepEqual(owned.signals, ['SIGTERM']);
  await terminate({
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill() {
      throw new Error('must not touch an unowned process');
    },
  });
  console.log(
    JSON.stringify({
      status: 'PASS',
      scope: 'environment-and-owned-child-termination',
      serverStarts: 0,
      modelStarts: 0,
      actualTemporalPostgresqlRestore: 'NOT RUN',
    }),
  );
}

export async function resumePendingSelfTest() {
  const events = [
    { eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED' },
    { eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED' },
  ];
  const expected = {
    workflowId: 'aw/t4/fixture/pending',
    runId: 'original-run',
    namespace: 't4-recovery',
    pending: true,
    value: { taskId: 'aw/t4/fixture/pending', result: { outcome: 'FAIL', original: true } },
    original: { events },
  };
  function fixture() {
    const writes = new Map(),
      calls = [];
    const context = {
      resumePending: true,
      freshSourceTarget: true,
      restoredWorker: true,
      models: 0,
    };
    const pending = {
      workflowId: expected.workflowId,
      runId: expected.runId,
      status: 'RUNNING',
      originalPrefixEqual: true,
      queryEqual: true,
      signalSent: false,
    };
    const handle = {
      signal: async (...args) => {
        assert.equal(writes.get('pending-resume-intent.json').state, 'intent');
        calls.push(args);
      },
      result: async () => expected.value,
      describe: async () => ({ runId: expected.runId, status: { name: 'COMPLETED' } }),
      fetchHistory: async () => ({
        events: [
          ...events,
          {
            eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED',
            workflowExecutionSignaledEventAttributes: { signalName: 't4ResumePending' },
          },
          { eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' },
        ],
      }),
    };
    const save = (name, value, exclusive) => {
      if (exclusive)
        assert.equal(writes.has(name), false, 'existing intent/outcome must not be overwritten');
      writes.set(name, globalThis.structuredClone(value));
    };
    return {
      context,
      expected,
      pending,
      handle,
      canonical: (value) => value,
      bounded: (fn) => fn(),
      save,
      writes,
      calls,
    };
  }
  const valid = fixture();
  await resumeRestoredPending(valid);
  assert.deepEqual(valid.calls, [['t4ResumePending']]);
  assert.equal(valid.pending.status, 'COMPLETED');
  assert.equal(valid.pending.resume.signalCalls, 1);
  assert.equal(valid.pending.resume.signalEvents, 1);
  assert.equal(valid.pending.resume.completionEvents, 1);
  assert.equal(valid.pending.resume.activityEvents, 0);
  assert.equal(valid.writes.get('pending-resume-intent.json').state, 'intent');
  await assert.rejects(resumeRestoredPending(valid));
  assert.equal(valid.calls.length, 1);
  for (const key of ['resumePending', 'freshSourceTarget', 'restoredWorker']) {
    const invalid = fixture();
    invalid.context[key] = false;
    await assert.rejects(resumeRestoredPending(invalid));
    assert.equal(invalid.calls.length, 0);
    assert.equal(invalid.writes.size, 0);
  }
  const model = fixture();
  model.context.models = 1;
  await assert.rejects(resumeRestoredPending(model));
  assert.equal(model.calls.length, 0);
  const deadline = fixture();
  deadline.bounded = async () => {
    throw Error('fixture deadline before dispatch');
  };
  await assert.rejects(resumeRestoredPending(deadline), /deadline before dispatch/);
  assert.equal(deadline.calls.length, 0);
  assert.equal(deadline.pending.resume.signalCalls, 0);
  assert.equal(deadline.pending.resume.state, 'unknown');
  for (const change of ['namespace', 'identity', 'pending', 'prefix', 'query']) {
    const invalid = fixture();
    invalid.expected = globalThis.structuredClone(expected);
    if (change === 'namespace') invalid.expected.namespace = 'real-user';
    if (change === 'identity') invalid.expected.workflowId = 'other';
    if (change === 'pending') invalid.expected.pending = false;
    if (change === 'prefix') invalid.pending.originalPrefixEqual = false;
    if (change === 'query') invalid.pending.queryEqual = false;
    await assert.rejects(resumeRestoredPending(invalid));
    assert.equal(invalid.calls.length, 0);
    assert.equal(invalid.writes.size, 0);
  }
  const existing = fixture();
  existing.writes.set('pending-resume-intent.json', {});
  await assert.rejects(resumeRestoredPending(existing));
  assert.equal(existing.calls.length, 0);
  for (const phase of ['signal', 'result']) {
    const failed = fixture();
    failed.handle[phase] = async () => {
      if (phase === 'signal') failed.calls.push(['t4ResumePending']);
      throw Error('fixture unknown ' + phase);
    };
    await assert.rejects(resumeRestoredPending(failed), /fixture unknown/);
    assert.equal(failed.pending.resume.state, 'unknown');
    await assert.rejects(resumeRestoredPending(failed));
    assert.equal(failed.calls.length, 1);
    assert.equal(failed.writes.get('pending-resume-outcome.json').state, 'unknown');
  }
  for (const change of ['run', 'result', 'prefix', 'signals', 'completion', 'activity']) {
    const failed = fixture();
    if (change === 'run')
      failed.handle.describe = async () => ({ runId: 'other', status: { name: 'COMPLETED' } });
    if (change === 'result') failed.handle.result = async () => ({ changed: true });
    const history = await failed.handle.fetchHistory();
    if (change === 'prefix') history.events[0] = { changed: true };
    if (change === 'signals') history.events.push(history.events[events.length]);
    if (change === 'completion') history.events.pop();
    if (change === 'activity')
      history.events.push({ eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED' });
    failed.handle.fetchHistory = async () => history;
    await assert.rejects(resumeRestoredPending(failed));
    assert.equal(failed.pending.resume.state, 'unknown');
  }
  const workflowSource = readFileSync(
    new URL('./t4-pg-temporal-workflows.mjs', import.meta.url),
    'utf8',
  )
    .replace(/^import[^\n]+\n/u, '')
    .replace(/export /gu, '');
  for (const optIn of [false, true]) {
    const handlers = new Map();
    let predicate, release;
    const run = runInNewContext(workflowSource + '\nt4StorageCase', {
      defineQuery: (name) => name,
      defineSignal: (name) => name,
      setHandler: (name, fn) =>
        handlers.set(name, (...args) => {
          const value = fn(...args);
          if (predicate?.()) release();
          return value;
        }),
      condition: (fn) => {
        predicate = fn;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const value = { original: true },
      result = run({ pending: true, result: value, ...(optIn ? { resumePending: true } : {}) });
    assert.equal(handlers.get('t4RecoveryState')().waiting, true);
    assert.equal(predicate(), false);
    assert.equal(handlers.has('t4ResumePending'), optIn);
    if (optIn) {
      handlers.get('t4ResumePending')();
      assert.deepEqual(await result, value);
      assert.equal(handlers.get('t4RecoveryState')().waiting, false);
    }
  }
  console.log(
    JSON.stringify({
      status: 'PASS',
      scope: 'pure-opt-in-pending-resume-contract',
      services: 0,
      models: 0,
      SDK: 0,
    }),
  );
}
