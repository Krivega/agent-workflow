// Unit verification child. Technical/seal/authority ports are synthetic; SDK import is real.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL, fileURLToPath } from 'node:url';

assert.equal(process.argv.length, 7);
const [role, descriptorPath, descriptorHash, nonce, marker] = process.argv.slice(2);
assert.equal(marker, 'TD056_OWNED_UNIT_PROCESS_V1');
assert.ok(role === 'hold' || role === 'recover');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const descriptorBytes = readFileSync(descriptorPath);
assert.equal(hash(descriptorBytes), descriptorHash);
const d = JSON.parse(descriptorBytes.toString());
assert.equal(d.kind, 'td056-owned-process-unit-fixture/1');
assert.equal(d.nonce, nonce);
assert.equal(d.nodeExecPath, process.execPath);
assert.equal(d.childPath, fileURLToPath(import.meta.url));
assert.equal(process.argv[1], d.childPath);
assert.equal(d.syntheticPorts, true);
assert.equal(d.syncWaitMs, 5000);
assert.ok(Date.now() < d.deadline);
for (const pin of d.modulePins) assert.equal(hash(readFileSync(pin.path)), pin.sha256, pin.path);
const counters = {
  sdkImports: true,
  capturedWorkerCreates: 0,
  capturedWorkerRuns: 0,
  capturedWorkerShutdowns: 0,
  actualWorkerCreates: 0,
  actualConnections: 0,
  actualRuntimes: 0,
  forbiddenRpcCalls: 0,
  syntheticReadCalls: 0,
  writerStarts: 0,
  processObservations: 0,
};
const restore = [];
function replace(object, name, value) {
  const prior = Object.getOwnPropertyDescriptor(object, name);
  assert.ok(prior && typeof prior.value === 'function' && prior.writable);
  Object.defineProperty(object, name, { ...prior, value });
  restore.push(() => Object.defineProperty(object, name, prior));
}
const require = createRequire(join(d.packageRoot, 'package.json'));
const workerDirectory = dirname(require.resolve('@temporalio/worker'));
const { Runtime } = require(join(workerDirectory, 'runtime.js'));
assert.equal(Runtime._instance, undefined, 'SDK module import must not initialize Runtime');
for (const name of ['install', 'instance', 'create'])
  replace(Runtime, name, () => {
    counters.actualRuntimes++;
    throw new Error('No actual Runtime API in this unit process');
  });
const { NativeConnection } = require(join(workerDirectory, 'connection.js'));
for (const name of ['create', 'connect'])
  replace(NativeConnection, name, () => {
    counters.actualConnections++;
    throw new Error('No actual NativeConnection API in this unit process');
  });
const { Worker } = require('@temporalio/worker');
const connection = new Proxy(Object.freeze({}), {
  get() {
    counters.actualConnections++;
    throw new Error('The passed NativeConnection sentinel is inert');
  },
});
let controls;
replace(Worker, 'create', async (options) => {
  counters.capturedWorkerCreates++;
  assert.ok(counters.capturedWorkerCreates <= 2);
  assert.equal(options.connection, connection);
  assert.equal(options.maxConcurrentActivityTaskExecutions, 1);
  if (options.taskQueue === d.controlQueue) controls = options.activities;
  let stop;
  const ended = new Promise((resolve) => {
    stop = resolve;
  });
  return {
    run() {
      counters.capturedWorkerRuns++;
      return ended;
    },
    shutdown() {
      counters.capturedWorkerShutdowns++;
      stop();
    },
  };
});
const module = (path) =>
  import(pathToFileURL(join(d.packageRoot, 'dist', path.replace(/\.ts$/u, '.js'))).href);
const { MockActivityEnvironment } = require('@temporalio/testing');
const { createReaderHost } = await module('worker/readerHost.ts');
const { recoverReaderHost } = await module('worker/readerRecovery.ts');
const { NativeWriterProcesses } = await module('adapters/codex/writerProcesses.ts');
const { taskHostPermissionOwner } = await module('adapters/project/taskPermissionLock.ts');
const { taskHumanCompletionGate } = await module('adapters/project/taskHumanCompletionGate.ts');
const { requireTaskHumanCompletionSeal, inspectTaskHumanTechnical } = await module(
  'activities/taskHumanCompletion.ts',
);
const { artifactStore } = await module('adapters/artifacts/files.ts');
const { localTaskKey } = await module('policy/localTask.ts');
const { taskAdmissionIdentity } = await module('policy/taskRecovery.ts');
const store = artifactStore(d.registration.artifactRoot, { existingOnly: true });
const native = new NativeWriterProcesses();
const processes = {
  async alive(ids) {
    counters.processObservations++;
    return native.alive(ids);
  },
  async descendants(ids) {
    counters.processObservations++;
    return native.descendants(ids);
  },
  async terminate() {
    throw new Error('Unit recovery must not signal any Writer');
  },
  async wait(ms) {
    return native.wait(ms);
  },
};
const snapshotStat = lstatSync(d.syntheticReads.path);
assert.ok(
  snapshotStat.isFile() &&
    snapshotStat.nlink === 1 &&
    snapshotStat.uid === process.getuid?.() &&
    (snapshotStat.mode & 0o077) === 0,
);
const snapshotBytes = readFileSync(d.syntheticReads.path);
assert.equal(snapshotBytes.length, d.syntheticReads.bytes);
assert.ok(snapshotBytes.length <= 1024 * 1024);
assert.equal(hash(snapshotBytes), d.syntheticReads.sha256);
const snapshots = JSON.parse(snapshotBytes.toString());
assert.equal(snapshots.kind, 'SYNTHETIC_FIXTURE_READER_HISTORY_NOT_NATIVE_AUTHORITY');
assert.ok(snapshots.rows.length > 0 && snapshots.rows.length <= 8);
assert.equal(snapshots.rows.length, d.syntheticReads.count);
assert.equal(new Set(snapshots.rows.map((row) => row.params.threadId)).size, snapshots.rows.length);
for (const row of snapshots.rows) {
  assert.deepEqual(Object.keys(row.params).sort(), ['includeTurns', 'threadId']);
  assert.equal(row.params.includeTurns, true);
  assert.equal(row.response.thread.id, row.params.threadId);
  assert.equal(hash(Buffer.from(JSON.stringify(row.response))), row.sha256);
}
const usedSnapshots = new Set();
const denied = async () => {
  counters.forbiddenRpcCalls++;
  throw new Error('No external, mutating or unlisted RPC allowed');
};
const rpc = {
  async request(method, params) {
    const row = snapshots.rows.find((entry) => entry.params.threadId === params.threadId);
    if (method !== 'thread/read' || !row || usedSnapshots.has(row.params.threadId)) return denied();
    assert.deepEqual(params, row.params);
    assert.equal(hash(Buffer.from(JSON.stringify(row.response))), row.sha256);
    usedSnapshots.add(row.params.threadId);
    counters.syntheticReadCalls++;
    return globalThis.structuredClone(row.response);
  },
  completed: denied,
};
const localTasks = {
  profile: d.profile,
  disabledServers: [],
  processes,
  createRuntime() {
    counters.writerStarts++;
    throw new Error('No Writer in proof phase');
  },
  startAdmissionAuthority: {
    async issue() {
      throw new Error('No new declaration authority in proof child');
    },
    async verify(binding) {
      assert.deepEqual(binding, d.syntheticPrincipal);
      store.read(d.syntheticPrincipal.proof);
    },
  },
  humanAuthority: {
    async verify() {
      throw new Error('No new ASK/DECIDE in proof child');
    },
  },
};
const projects = [{ registration: d.registration, rpc, authority: { verify: denied }, localTasks }];
function activity(name, call) {
  return new MockActivityEnvironment({
    isLocal: false,
    workflowType: 'LocalTaskWorkflow',
    workflowExecution: { workflowId: localTaskKey(d.input), runId: 'owned-process-unit-run' },
    activityType: name,
    taskQueue: d.controlQueue,
    namespace: 'default',
  }).run(call);
}
function emit(value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  assert.ok(bytes.length <= 64 * 1024);
  assert.equal(writeSync(1, bytes), bytes.length);
}
function boundedReadyWait() {
  assert.ok(Date.now() < d.deadline);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, d.syncWaitMs);
  throw new Error('READY bounded wait expired without the parent SIGKILL');
}
function noSurface() {
  assert.equal(counters.capturedWorkerCreates, 2);
  assert.equal(counters.actualWorkerCreates, 0);
  assert.equal(counters.actualConnections, 0);
  assert.equal(counters.actualRuntimes, 0);
  assert.equal(counters.forbiddenRpcCalls, 0);
  assert.equal(counters.syntheticReadCalls, role === 'hold' ? 0 : snapshots.rows.length);
  assert.equal(counters.writerStarts, 0);
  assert.equal(Runtime._instance, undefined);
}
const watchdog = setTimeout(
  () => {
    writeSync(2, 'owned process unit deadline exceeded\n');
    process.exit(124);
  },
  Math.max(1, d.deadline - Date.now()),
);
try {
  let recovered = null;
  let result = null;
  if (role === 'recover') {
    assert.ok(Number.isSafeInteger(d.formerPid) && d.formerPid !== process.pid);
    assert.throws(
      () => process.kill(d.formerPid, 0),
      (error) => error.code === 'ESRCH',
    );
    recovered = await recoverReaderHost(projects, d.hostRoot, d.profile, [], [d.input]);
    assert.equal(recovered.owner.pid, d.formerPid);
    assert.equal(recovered.owner.taskBindings, 3);
    assert.equal(existsSync(d.reservation), false);
    assert.equal(existsSync(d.lockPath), false);
    assert.equal(existsSync(join(d.hostRoot, 'host-owner')), false);
    assert.equal(hash(readFileSync(d.card)), d.cardBeforeHash);
    for (const pin of d.closedPins) assert.equal(hash(readFileSync(pin.path)), pin.sha256);
  }
  const host = await createReaderHost(
    connection,
    d.modelQueue,
    'CAPTURE_ONLY_NO_WORKFLOW_BUNDLE',
    projects,
    d.profile,
    d.hostRoot,
    1,
  );
  await host.runUntil(async () => {
    assert.ok(controls);
    const budget = await activity('captureTaskExecutionBudget', () =>
      controls.captureTaskExecutionBudget(d.input, role === 'recover' ? d.previousBudget : null),
    );
    assert.equal(budget.limit, 1);
    assert.equal(budget.used, 0);
    if (role === 'recover') assert.deepEqual(budget.manifest, d.previousBudget);
    const ownerBytes = readFileSync(join(d.hostRoot, 'host-owner'));
    const owner = JSON.parse(ownerBytes.toString());
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.taskBindings, 3);
    const admissionPath = join(
      d.hostRoot,
      'task-admissions-v2',
      owner.id,
      hash(taskAdmissionIdentity(d.input)),
    );
    const admission = JSON.parse(readFileSync(admissionPath).toString());
    assert.deepEqual(admission.host, { pid: process.pid, id: owner.id });
    assert.deepEqual(admission.input, d.input);
    assert.equal(admission.gate.mode, 'retained');
    if (role === 'hold') {
      const proof = requireTaskHumanCompletionSeal(d.registration, d.input, { seal: d.seal });
      const technical = await inspectTaskHumanTechnical(
        d.registration,
        d.profile,
        [],
        processes,
        d.request.technical,
      );
      const current = taskHostPermissionOwner(d.hostRoot, d.registration.artifactRoot, owner.id);
      const gate = taskHumanCompletionGate(
        d.input,
        technical.source,
        d.profile,
        d.registration.artifactRoot,
        d.request.technical.stopped,
        proof.ref,
        current,
      );
      await technical.inspection.recheck();
      gate.acquire();
      try {
        const ready = () => {
          noSurface();
          emit({
            kind: 'td056-unit-child-ready/1',
            nonce: d.nonce,
            pid: process.pid,
            owner,
            admissionPath,
            budget: budget.manifest,
            tokenHash: hash(readFileSync(d.reservation)),
            lockHash: d.withLock ? hash(readFileSync(d.lockPath)) : null,
            counters,
          });
          boundedReadyWait();
        };
        if (d.withLock) gate.exclusive(ready);
        else {
          assert.equal(existsSync(d.lockPath), false);
          ready();
        }
      } finally {
        gate.release();
      }
    } else {
      const first = await activity('finishTaskHuman', () => controls.finishTaskHuman(d.request));
      const firstCardHash = hash(readFileSync(d.card));
      const cardStamp = () => {
        const stat = lstatSync(d.card, { bigint: true });
        return [
          stat.dev,
          stat.ino,
          stat.mode,
          stat.uid,
          stat.gid,
          stat.nlink,
          stat.size,
          stat.mtimeNs,
          stat.ctimeNs,
        ];
      };
      const firstCardStat = cardStamp();
      const firstResult = store.read(first.result);
      const firstProjection = store.read(first.projection);
      const second = await activity('finishTaskHuman', () => controls.finishTaskHuman(d.request));
      assert.deepEqual(second, first);
      assert.equal(hash(readFileSync(d.card)), firstCardHash);
      assert.deepEqual(cardStamp(), firstCardStat);
      assert.deepEqual(store.read(second.result), firstResult);
      assert.deepEqual(store.read(second.projection), firstProjection);
      assert.equal(first.status, 'done');
      assert.deepEqual(JSON.parse(firstResult.toString()).humanCompletion, d.seal);
      for (const pin of d.closedPins) assert.equal(hash(readFileSync(pin.path)), pin.sha256);
      noSurface();
      result = {
        kind: 'td056-unit-child-recovered/1',
        nonce: d.nonce,
        pid: process.pid,
        formerPid: recovered.owner.pid,
        currentOwner: owner,
        outcome: first,
        cardHash: firstCardHash,
        counters,
      };
    }
  });
  noSurface();
  assert.equal(counters.capturedWorkerShutdowns, 2);
  assert.equal(existsSync(join(d.hostRoot, 'host-owner')), false);
  assert.ok(result);
  emit(result);
} finally {
  clearTimeout(watchdog);
  for (const undo of restore.reverse()) undo();
}
