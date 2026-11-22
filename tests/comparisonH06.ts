import type { Worker as SDKWorker } from '@temporalio/worker';
import type { TestWorkflowEnvironment as SDKTestEnvironment } from '@temporalio/testing';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import {
  constants,
  openSync,
  closeSync,
  writeSync,
  existsSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import {
  ownProcess,
  type OwnedProcessIdentity,
} from '../examples/temporal-consumers/full/safety.mjs';
import { h01RawFile } from './comparisonH01Contract.js';
import { readH04Pin, readH04Json, h04Pin } from './comparisonH04Contract.js';
import {
  h06Assets,
  h06Checks,
  h06SourcePaths,
  h06Hash,
  h06Intent,
  h06Failure,
  h06Stopped,
  readH06WriterEffect,
  readH06Artifact,
  readH06Checkpoint,
  parseH06Request,
  checkH06,
  type H06Request,
} from './comparisonH06Contract.js';
import { canonical, digest, requestHash } from '../adapters/storage/storeCodec.js';
import { noStorageProbe } from '../adapters/storage/storeFiles.js';
import { StoreDatabase, initializeStore } from '../adapters/storage/storeDatabase.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { withActiveChatLease } from '../cli/chatContinuation.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { effectJournal } from '../src/adapters/artifacts/effects.js';
import { object, requireContract } from '../src/contracts/project.js';
import { controlRef } from '../src/policy/readerControl.js';
import { parseLocalTask, localTaskKey } from '../src/policy/localTask.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import {
  taskExecutionCommand,
  taskInterruption,
  parseTaskExecutionResume,
  checkTaskExecutionResume,
} from '../src/policy/taskExecution.js';
import { makeTaskExecutionCommand, controlTaskExecution } from '../src/client/taskExecution.js';
import { bindTaskBackendClient, type TaskBackendRegistration } from '../src/client/taskBackend.js';
import { historyToJSON } from '@temporalio/common/proto-utils';
import type {
  EvidenceGrant,
  StoreCommand,
  Change,
  StoreRequest,
  TechnicalState,
  StoredEvidence,
  OperationResult,
  WriteAck,
  EventRecord,
  EvidenceBody,
} from '../core/evidence.js';
import type { ArtifactRef } from '../src/contracts/preparation.js';
import type {
  ManagedTaskInput,
  LocalTaskActivities,
  LocalTaskControls,
} from '../src/contracts/localTask.js';
import type { TaskExecutionControls } from '../src/contracts/taskExecution.js';
import type { PayloadReaderCommand } from '../src/contracts/readerControl.js';

const SELF = fileURLToPath(import.meta.url);
export function saveH06(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function h06SourcePins() {
  return h06SourcePaths.map((path) => ({ path, sha256: digest(h01RawFile(path)) }));
}
export function planH06(value: unknown) {
  const request = parseH06Request(value);
  readH04Pin(request.node);
  if (request.server !== null) readH04Pin(request.server);
  requireContract(Boolean(lstatSync(request.node.path).mode & 0o111), 'h06-node-executable');
  return {
    kind: 'h06-model-free/2-plan',
    request,
    inputHash: h06Hash(request),
    sourcePins: h06SourcePins(),
    assets: h06Assets(),
    proposedStimulus: request.stimulus,
    proposedBudget: request.budget,
    mayRun: false,
    authority: null,
    qualification: false,
    allowedModelStarts: 0,
    historicalV1LeaseRenewedTemporal: 'UNMET',
    nativeChecks: h06Checks.map((id) => ({ id, status: 'NOT_PROVEN' })),
  };
}
export function h06Processes(timeout = 1500): OwnedProcessIdentity[] {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    timeout,
  })
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [, pid, ppid, pgid, identity] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u) ?? [];
      requireContract(identity !== undefined, 'h06-process-observation');
      return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), identity };
    });
}
const selfIdentity = () => {
  const row = h06Processes().find((p) => p.pid === process.pid);
  requireContract(row !== undefined, 'h06-self-identity');
  return row;
};
function publish(request: H06Request, value: unknown) {
  return artifactStore(join(request.outputRoot, 'artifacts')).publish(
    Buffer.from(canonical(value)),
  );
}
const workspace = (request: H06Request) => ({
  dev: String(lstatSync(request.outputRoot).dev),
  ino: String(lstatSync(request.outputRoot).ino),
});
const bound = (request: H06Request) => ({
  inputHash: h06Hash(request),
  identity: request.identity,
});
function pending(request: H06Request, checkpoint: ArtifactRef) {
  return publish(request, {
    ...bound(request),
    kind: 'h06-pending-operation',
    status: 'pending',
    operationId: request.operationId,
    effectIdentity: h06Intent(request),
    checkpoint,
  });
}
function heldState(request: H06Request, ref: ArtifactRef) {
  return {
    ...bound(request),
    operationId: request.operationId,
    status: 'pending',
    pending: { ...ref },
    frozen: false,
    released: false,
  };
}
function remaining(deadline: string, reserve = 0) {
  const ms = Number(BigInt(deadline) - process.hrtime.bigint()) / 1e6 - reserve;
  requireContract(Number.isFinite(ms) && ms > 0, 'h06-deadline');
  return ms;
}

export async function h06WriterProgram(request: H06Request, deadline: string) {
  requireContract(process.connected === true, 'h06-writer-owner-required');
  const admittedAt = performance.now(),
    allowedMs = remaining(deadline);
  requireContract(allowedMs <= request.budget.totalMs, 'h06-writer-deadline');
  const fd = openSync(
      join(request.outputRoot, 'writer.log'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    ),
    began = performance.now();
  let sequence = 0;
  const tick = () =>
    writeSync(
      fd,
      JSON.stringify({ sequence: ++sequence, elapsedMs: performance.now() - began }) + '\n',
    );
  tick();
  const timer = setInterval(tick, 100),
    limit = setTimeout(
      () => finish(true),
      Math.max(1, allowedMs - (performance.now() - admittedAt)),
    );
  const disconnect = () => finish(true),
    message = () => finish(false);
  let closed = false;
  function finish(failed: boolean) {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(limit);
    process.removeListener('message', message);
    process.removeListener('disconnect', disconnect);
    closeSync(fd);
    if (failed) process.exitCode = 1;
    if (process.connected) process.disconnect!();
  }
  process.once('disconnect', disconnect);
  process.once('message', message);
  try {
    process.send!({ ready: true, pid: process.pid });
  } catch (error) {
    finish(true);
    throw error;
  }
}
export async function startH06Writer(request: H06Request, deadline: string) {
  requireContract(process.connected === true, 'h06-writer-owner-required');
  const admittedMs = remaining(deadline, request.budget.stopMs);
  requireContract(
    admittedMs <= request.budget.totalMs - request.budget.stopMs,
    'h06-writer-deadline',
  );
  let release!: () => void, admitted!: () => void;
  const gate = new Promise<void>((done) => {
      release = done;
    }),
    ready = new Promise<void>((done) => {
      admitted = done;
    });
  const result = effectJournal(join(request.outputRoot, 'effects')).execute(
    h06Intent(request),
    async () => {
      readH04Pin(request.node);
      const child = spawn(
        request.node.path,
        ['--import', 'tsx', SELF, '--writer', join(request.outputRoot, 'request.json'), deadline],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env },
      );
      const owned = ownProcess(child, {
        deadline: performance.now() + remaining(deadline),
        stopMs: request.budget.stopMs,
      });
      let stopped;
      try {
        await Promise.race([
          new Promise<void>((done, reject) => {
            child.once('message', (value) => {
              try {
                requireContract(object(value).pid === child.pid, 'h06-writer-ready');
                done();
              } catch (error) {
                reject(error);
              }
            });
            child.once('error', reject);
          }),
          owned.done.then(() => {
            throw new Error('h06-writer-exited-before-ready');
          }),
        ]);
        admitted();
        await gate;
        const live = h06Processes().find((p) => p.pid === child.pid);
        requireContract(live !== undefined, 'h06-live-writer-missing');
        saveH06(join(request.outputRoot, 'writer-live.json'), {
          ...bound(request),
          process: live,
          observedBeforeStop: true,
          atMonotonicMs: performance.now(),
        });
        child.send({ stop: true });
        stopped = await owned.done;
      } finally {
        stopped ??= await owned.stop();
      }
      const record = { inputHash: h06Hash(request), receipt: stopped };
      saveH06(join(request.outputRoot, 'writer-stop.json'), record);
      requireContract(h06Stopped(stopped), 'h06-writer-stop-unknown');
      const frame = h06Processes(),
        gone = !frame.some((p) => stopped.pids.includes(p.pid) || stopped.groups.includes(p.pgid));
      const listening = spawnSync(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'pPn'],
        { encoding: 'utf8', timeout: 1500 },
      );
      requireContract(
        !listening.error &&
          listening.status === 1 &&
          listening.signal === null &&
          listening.stdout.trim() === '' &&
          listening.stderr.trim() === '',
        'h06-listeners-unknown',
      );
      const log = join(request.outputRoot, 'writer.log'),
        bytes = h01RawFile(log);
      await delay(150);
      const stable = bytes.equals(h01RawFile(log));
      requireContract(gone && stable, 'h06-writer-still-active');
      saveH06(join(request.outputRoot, 'writer-stability.json'), {
        identitiesAbsent: gone,
        listenersClosed: true,
        listenerObservation: {
          status: listening.status,
          signal: listening.signal,
          stdout: listening.stdout,
          stderr: listening.stderr,
        },
        noLateWrite: stable,
        log: { path: log, sha256: digest(bytes) },
      });
      return publish(request, record);
    },
  );
  await Promise.race([
    ready,
    result.then(() => {
      throw new Error('h06-writer-not-new');
    }),
  ]);
  return {
    async stop() {
      release();
      return await result;
    },
  };
}
export function h06Store(request: H06Request) {
  const grant: EvidenceGrant = {
    context: {
      schema_version: 'aw-evidence/1-draft',
      project_id: 'h06',
      task_id: request.operationId,
      run_id: request.operationId,
      subtask_id: null,
      actor_id: request.identity.owner,
    },
    permissions: ['read', 'produce', 'manage', 'resolve'],
  };
  const root = join(request.outputRoot, 'store'),
    store = new SqliteEvidenceStore(root, grant, Date.now);
  return {
    root,
    store,
    grant,
    read: (command: StoreCommand) => store.execute({ context: grant.context, command }),
    mutate(change: Change, revision: number, generation: number, id: string) {
      const signed: StoreRequest & { command: Extract<StoreCommand, { type: 'mutate' }> } = {
        context: grant.context,
        command: {
          type: 'mutate',
          mutation: {
            operation_id: id,
            expected_revision: revision,
            owner_generation: generation,
            payload_hash: '',
          },
          change,
        },
      };
      signed.command.mutation.payload_hash = requestHash(signed);
      return store.execute(signed);
    },
  };
}
export function h06RecoveryState(request: H06Request, state: unknown) {
  const v = object(state);
  requireContract(
    v.inputHash === h06Hash(request) && same(v.identity, request.identity),
    'h06-recovery-identity',
  );
  requireContract(
    v.frozen === false && v.released === false && v.status === 'pending',
    'h06-recovery-frozen-released',
  );
  controlRef(v.pending);
  return v;
}
export async function h06LegacyInitial(request: H06Request, deadline: string) {
  const began = Date.now(),
    monotonic = performance.now(),
    f = h06Store(request);
  initializeStore(f.root, f.grant.context);
  unwrap(
    f.mutate({ type: 'claim', lease_until: began + request.stimulus.oldLeaseMs }, 0, 0, 'claim'),
  );
  const body: EvidenceBody = {
    kind: 'check',
    result: 'FAIL',
    scope: request.identity.scope,
    criterion: 'F-01',
    summary: 'Model-free initial FAIL retained',
    command: 'h06-model-free',
    exit_code: 1,
    limitations: ['not native'],
    provenance: {
      head: '',
      base: '',
      dirty_diff: '',
      untracked: '',
      rules: {},
      tools: {},
      environment: {},
    },
    manifest: {
      complete: true,
      attested_by: 'h06-model-free',
      discovery_rule: 'test-owned',
      inputs: [{ locator: 'request', hash: h06Hash(request) }],
    },
    links: ['F-01'],
    raw: { input: '', output: h06Failure(request).toString() },
  };
  unwrap(f.mutate({ type: 'write', id: 'F-01', body }, 1, 1, 'failure'));
  const checkpoint = publish(request, {
      inputHash: h06Hash(request),
      unfinished: request.operationId,
    }),
    ref = pending(request, checkpoint),
    state = heldState(request, ref);
  unwrap(f.mutate({ type: 'checkpoint', state, effects: [] }, 2, 1, 'checkpoint'));
  const before = unwrap<TechnicalState>(f.read({ type: 'state' }));
  let renewed!: TechnicalState, renewAcceptedAt!: number;
  await withActiveChatLease(
    f.store,
    () => {
      const actual = unwrap<TechnicalState>(f.read({ type: 'state' }));
      requireContract(
        actual.owner === request.identity.owner &&
          actual.generation === request.identity.generation &&
          !actual.frozen &&
          !actual.released,
        'h06-legacy-owner',
      );
      remaining(deadline, request.budget.stopMs);
    },
    async (verify) => {
      renewed = unwrap<TechnicalState>(f.read({ type: 'state' }));
      renewAcceptedAt = Date.now();
      const writer = await startH06Writer(request, deadline);
      try {
        await delay(request.stimulus.stageMs);
        verify();
      } finally {
        await writer.stop();
      }
    },
  );
  const after = unwrap<TechnicalState>(f.read({ type: 'state' })),
    id = `chat:lease:${before.generation}:${before.revision}`;
  const operation = unwrap<OperationResult>(f.read({ type: 'operation', operation_id: id }));
  const database = new StoreDatabase(f.root, f.grant.context, noStorageProbe);
  let ack: WriteAck, event: EventRecord;
  try {
    // Finalization requires freeze; read existing immutable receipts without freezing the live owner.
    const a = database.db.prepare('SELECT ack FROM operations WHERE id=?').get(id),
      e = database.db.prepare('SELECT body FROM events WHERE revision=?').get(renewed.revision);
    requireContract(a !== undefined && e !== undefined, 'h06-renew-not-recorded');
    ack = database.decode<WriteAck>(String(a.ack));
    event = database.decode<EventRecord>(String(e.body));
  } finally {
    database.close();
  }
  saveH06(join(request.outputRoot, 'lease.json'), {
    ...bound(request),
    automatic: true,
    before,
    renewed,
    after,
    renewAcceptedAt,
    ack,
    event,
    operation,
  });
  const failure = unwrap<StoredEvidence>(f.read({ type: 'read', id: 'F-01', revision: 1 }));
  requireContract(
    failure.body.raw.output === h06Failure(request).toString(),
    'h06-store-fail-changed',
  );
  saveH06(join(request.outputRoot, 'initial.json'), {
    ...bound(request),
    phase: 'same-environment',
    host: selfIdentity(),
    workspace: workspace(request),
    state: h06RecoveryState(request, after.checkpoint),
    pending: ref,
    stageStartedAt: began,
    stageEndedAt: Date.now(),
    stageElapsedMs: performance.now() - monotonic,
    clockBasis: 'Date.now+performance.now',
    failure: { path: join(request.outputRoot, 'F-01.json'), sha256: digest(h06Failure(request)) },
  });
}
export async function h06CleanupAwait(operation: Promise<void>, deadline: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('h06-sdk-cleanup-unknown')),
          Math.min(5000, remaining(deadline)),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function h06DrainWorker(
  worker: Pick<SDKWorker, 'shutdown'>,
  running: Promise<void> | undefined,
  deadline: string,
) {
  worker.shutdown();
  requireContract(running !== undefined, 'h06-worker-run-missing');
  await h06CleanupAwait(running, deadline);
}
export function h06ConfirmRecoveryEffect(request: H06Request) {
  const effect = readH06WriterEffect(request);
  requireContract(effect !== null, 'h06-pending-effect-refuses-recovery');
  const saved = readH06Artifact(request.outputRoot, effect);
  requireContract(
    saved.inputHash === h06Hash(request) && h06Stopped(saved.receipt),
    'h06-recovery-stop-unconfirmed',
  );
  const initial = object(readH04Json(join(request.outputRoot, 'initial.json')));
  readH06Checkpoint(request, readH06Artifact(request.outputRoot, initial.pending));
}
interface H06Fixture {
  registration: TaskBackendRegistration;
  initial: ManagedTaskInput;
  state: { active: Set<string>; stopConfirmed: boolean; writers: number[]; calls: unknown[] };
  activities: LocalTaskActivities;
  controls: TaskExecutionControls & LocalTaskControls;
  command(action: 'pause', revision: number): PayloadReaderCommand;
  release(name: string): void;
}
export async function createH06Fixture(request: H06Request): Promise<H06Fixture> {
  const path = fileURLToPath(new URL('./temporal/task-execution-sdk-fixture.mjs', import.meta.url));
  const loaded: unknown = await import(pathToFileURL(path).href),
    factory = object(loaded).sdkFixture;
  requireContract(typeof factory === 'function', 'h06-sdk-fixture-missing');
  const { Context } = await import('@temporalio/activity');
  const raw: unknown = Reflect.apply(factory, undefined, [
    join(request.outputRoot, 'sdk-fixture'),
    request.operationId,
    { stage: 'writer' },
    {
      parseLocalTask,
      taskExecutionCommand,
      taskInterruption,
      makeTaskExecutionCommand,
      parseTaskExecutionResume,
      checkTaskExecutionResume,
      taskControlTarget,
    },
    () => Context.current(),
  ]);
  const value = object(raw),
    initial = parseLocalTask(value.initial);
  requireContract(initial.schemaVersion === 11, 'h06-managed-workflow-required');
  // This ABI is the pinned, existing model-free Activity fixture, never a native authority port.
  const fixture = raw as H06Fixture;
  requireContract(
    initial.admission.preparation.owner === request.identity.owner &&
      initial.admission.preparation.generation === request.identity.generation,
    'h06-fixture-owner',
  );
  return fixture;
}
async function untilH06(
  deadline: string,
  read: () => Promise<unknown>,
  accept: (value: unknown) => boolean,
) {
  for (;;) {
    remaining(deadline, 30000);
    const value = await read();
    if (accept(value)) return value;
    await delay(25);
  }
}
export async function h06TemporalPhase(
  request: H06Request,
  phase: 'initial' | 'cold',
  address: string,
  deadline: string,
) {
  requireContract(/^127\.0\.0\.1:[0-9]+$/u.test(address), 'h06-backend-address');
  const { Worker, NativeConnection } = await import('@temporalio/worker');
  const { Client, Connection } = await import('@temporalio/client');
  let native: Awaited<ReturnType<typeof NativeConnection.connect>> | undefined,
    connection: Awaited<ReturnType<typeof Connection.connect>> | undefined;
  const workflowsPath = fileURLToPath(new URL('../src/workflows/localTask.ts', import.meta.url)),
    queue = request.operationId;
  let worker: Awaited<ReturnType<typeof Worker.create>> | undefined,
    workerRun: Promise<void> | undefined,
    controls: Awaited<ReturnType<typeof Worker.create>> | undefined,
    controlsRun: Promise<void> | undefined,
    fresh: Awaited<ReturnType<typeof Connection.connect>> | undefined;
  const begin = Date.now(),
    monotonic = performance.now();
  try {
    if (phase === 'cold') h06ConfirmRecoveryEffect(request);
    native = await NativeConnection.connect({ address });
    connection = await Connection.connect({
      address,
      connectTimeout: Math.min(5000, remaining(deadline, request.budget.stopMs)),
    });
    const client = new Client({ connection });
    remaining(deadline, request.budget.stopMs);
    if (phase === 'initial') {
      const fixture = await createH06Fixture(request);
      bindTaskBackendClient(client, fixture.registration);
      let writer: Awaited<ReturnType<typeof startH06Writer>> | undefined;
      const oldWrite = fixture.activities.writeLocalTask,
        oldStop = fixture.controls.stopLocalTask;
      fixture.activities.writeLocalTask = async (...args) => {
        writer = await startH06Writer(request, deadline);
        return await oldWrite(...args);
      };
      fixture.controls.stopLocalTask = async (...args) => {
        requireContract(writer !== undefined, 'h06-writer-not-owned');
        await writer.stop();
        fixture.release('stop');
        fixture.release('activity');
        return await oldStop(...args);
      };
      controls = await Worker.create({
        connection: native,
        taskQueue: queue + '.control',
        workflowsPath,
        activities: fixture.controls,
      });
      controlsRun = controls.run();
      void controlsRun.catch(() => undefined);
      worker = await Worker.create({
        connection: native,
        taskQueue: queue,
        workflowsPath,
        activities: fixture.activities,
      });
      workerRun = worker.run();
      void workerRun.catch(() => undefined);
      const handle = await client.workflow.start('LocalTaskWorkflow', {
        workflowId: localTaskKey(fixture.initial),
        taskQueue: queue,
        args: [fixture.initial],
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      });
      await untilH06(
        deadline,
        async () => fixture.state.active.size,
        (v) => v === 1,
      );
      const stageStartedAt = Date.now(),
        stageMonotonic = performance.now();
      await delay(request.stimulus.stageMs);
      remaining(deadline, request.budget.stopMs);
      const command = fixture.command('pause', 0),
        ack = await controlTaskExecution(client, handle.workflowId, command);
      const held = object(
        await untilH06(
          deadline,
          () => handle.query('localTaskStatus'),
          (v) => object(v).waiting === true,
        ),
      );
      requireContract(
        fixture.state.active.size === 0 && fixture.state.stopConfirmed,
        'h06-writer-not-drained',
      );
      const input: unknown = await handle.query('localTaskInput');
      requireContract(same(input, fixture.initial), 'h06-input-changed');
      const description = await handle.describe(),
        history = await handle.fetchHistory();
      saveH06(join(request.outputRoot, 'workflow-input.json'), input);
      saveH06(join(request.outputRoot, 'pause-command.json'), command);
      const checkpoint = controlRef(held.held),
        ref = pending(request, checkpoint),
        state = heldState(request, ref);
      const previous = worker;
      await h06DrainWorker(worker, workerRun, deadline);
      worker = undefined;
      workerRun = undefined;
      remaining(deadline, request.budget.stopMs);
      requireContract(process.connected === true, 'h06-phase-owner-lost');
      worker = await Worker.create({
        connection: native,
        taskQueue: queue,
        workflowsPath,
        activities: fixture.activities,
      });
      requireContract(worker !== previous, 'h06-worker-not-distinct');
      workerRun = worker.run();
      void workerRun.catch(() => undefined);
      fresh = await Connection.connect({ address });
      const freshClient = bindTaskBackendClient(
          new Client({ connection: fresh }),
          fixture.registration,
        ),
        resumed = freshClient.workflow.getHandle(handle.workflowId, description.runId);
      const status = object(await resumed.query('localTaskStatus'));
      requireContract(
        same(status.held, held.held) && same(await resumed.query('localTaskInput'), input),
        'h06-same-environment-changed',
      );
      requireContract(
        same(await controlTaskExecution(freshClient, handle.workflowId, command), ack),
        'h06-duplicate-pause',
      );
      requireContract(fixture.state.writers.length === 1, 'h06-writer-reissued');
      saveH06(join(request.outputRoot, 'history-before.json'), JSON.parse(historyToJSON(history)));
      saveH06(join(request.outputRoot, 'status-before.json'), {
        workflowId: handle.workflowId,
        runId: description.runId,
        query: 'localTaskStatus',
        result: held,
      });
      saveH06(join(request.outputRoot, 'initial.json'), {
        ...bound(request),
        phase: 'same-environment',
        host: selfIdentity(),
        workspace: workspace(request),
        state,
        pending: ref,
        workflow: { workflowId: handle.workflowId, runId: description.runId },
        stageStartedAt,
        stageEndedAt: Date.now(),
        stageElapsedMs: performance.now() - stageMonotonic,
        clockBasis: 'Date.now+performance.now',
        failure: {
          path: join(request.outputRoot, 'F-01.json'),
          sha256: digest(h06Failure(request)),
        },
        pauseAck: ack,
        writerDrained: true,
        sameEnvironment: {
          oldWorkerDrained: true,
          distinctWorker: true,
          freshClient: true,
          pending: status.held,
          inputHash: digest(canonical(input)),
        },
      });
    } else {
      const first = object(readH04Json(join(request.outputRoot, 'initial.json'))),
        workflow = object(first.workflow),
        ref = controlRef(first.pending),
        doc = readH06Artifact(request.outputRoot, ref);
      const input = parseLocalTask(readH04Json(join(request.outputRoot, 'workflow-input.json')));
      requireContract(input.schemaVersion === 11, 'h06-managed-workflow-required');
      bindTaskBackendClient(client, {
        ...input.admission.preparation,
        workspaceRoot: realpathSync(join(request.outputRoot, 'sdk-fixture')),
      });
      const handle = client.workflow.getHandle(String(workflow.workflowId), String(workflow.runId));
      const journal: unknown = readH04Json(
        join(request.outputRoot, 'sdk-fixture', 'synthetic-command-journal.json'),
      );
      requireContract(Array.isArray(journal), 'h06-command-journal');
      let dispatches = 0;
      controls = await Worker.create({
        connection: native,
        taskQueue: queue + '.control',
        activities: {
          findTaskExecutionCommand: async (_input: unknown, command: PayloadReaderCommand) => {
            const retained = journal
              .map(object)
              .find((row) => object(row.command).commandId === command.commandId);
            requireContract(
              retained !== undefined && same(retained.command, command),
              'h06-cold-command-unconfirmed',
            );
            return retained.ack;
          },
        },
      });
      controlsRun = controls.run();
      void controlsRun.catch(() => undefined);
      worker = await Worker.create({
        connection: native,
        taskQueue: queue,
        workflowsPath,
        activities: {
          writeLocalTask: async () => {
            dispatches++;
            throw new Error('h06-cold-dispatch-forbidden');
          },
        },
      });
      workerRun = worker.run();
      void workerRun.catch(() => undefined);
      const status = object(await handle.query('localTaskStatus')),
        description = await handle.describe();
      requireContract(
        description.runId === workflow.runId &&
          same(await handle.query('localTaskInput'), input) &&
          same(status.held, doc.checkpoint),
        'h06-cold-workflow-changed',
      );
      const command = readH04Json(join(request.outputRoot, 'pause-command.json')),
        ack = await controlTaskExecution(client, handle.workflowId, command);
      requireContract(same(ack, first.pauseAck), 'h06-cold-duplicate-receipt');
      const history = await handle.fetchHistory(),
        serialized: unknown = JSON.parse(historyToJSON(history));
      saveH06(join(request.outputRoot, 'history-after.json'), serialized);
      saveH06(join(request.outputRoot, 'status-after.json'), {
        workflowId: handle.workflowId,
        runId: description.runId,
        query: 'localTaskStatus',
        result: status,
      });
      await Worker.runReplayHistory({ workflowsPath }, history, handle.workflowId);
      saveH06(join(request.outputRoot, 'replay.json'), {
        success: true,
        historyHash: digest(canonical(serialized)),
        workflowId: handle.workflowId,
        runId: description.runId,
      });
      const state = heldState(request, ref);
      h06RecoveryState(request, state);
      saveH06(join(request.outputRoot, 'cold.json'), {
        ...bound(request),
        phase: 'cold-host-reopen',
        host: selfIdentity(),
        workspace: workspace(request),
        state,
        pending: ref,
        workflow: { workflowId: handle.workflowId, runId: description.runId },
        failure: first.failure,
        pauseAck: ack,
        freshClient: true,
        dispatches,
        ...h06Refusals(request, state),
        beganAt: begin,
        elapsedMs: performance.now() - monotonic,
      });
    }
  } finally {
    try {
      if (worker) await h06DrainWorker(worker, workerRun, deadline);
    } finally {
      try {
        if (controls) await h06DrainWorker(controls, controlsRun, deadline);
      } finally {
        try {
          if (fresh) await h06CleanupAwait(fresh.close(), deadline);
        } finally {
          try {
            if (connection) await h06CleanupAwait(connection.close(), deadline);
          } finally {
            if (native) await h06CleanupAwait(native.close(), deadline);
          }
        }
      }
    }
  }
}
export function h06RecoveryRefused(request: H06Request, value: unknown) {
  try {
    h06RecoveryState(request, value);
    return false;
  } catch {
    return true;
  }
}
export function h06Refusals(request: H06Request, state: Record<string, unknown>) {
  return {
    frozenReleasedRefused:
      h06RecoveryRefused(request, { ...state, frozen: true }) &&
      h06RecoveryRefused(request, { ...state, released: true }),
    unknownEffectRefused: h06RecoveryRefused(request, { ...state, pending: null }),
  };
}
export function h06LegacyCold(request: H06Request) {
  h06ConfirmRecoveryEffect(request);
  const first = object(readH04Json(join(request.outputRoot, 'initial.json'))),
    f = h06Store(request),
    state = unwrap<TechnicalState>(f.read({ type: 'state' }));
  const checkpoint = h06RecoveryState(request, state.checkpoint),
    failure = unwrap<StoredEvidence>(f.read({ type: 'read', id: 'F-01', revision: 1 }));
  requireContract(
    failure.body.raw.output === h06Failure(request).toString() &&
      state.owner === request.identity.owner &&
      state.generation === request.identity.generation &&
      !state.frozen &&
      !state.released,
    'h06-cold-store-changed',
  );
  saveH06(join(request.outputRoot, 'cold.json'), {
    ...bound(request),
    phase: 'cold-host-reopen',
    host: selfIdentity(),
    workspace: workspace(request),
    state: checkpoint,
    pending: checkpoint.pending,
    failure: first.failure,
    dispatches: 0,
    ...h06Refusals(request, checkpoint),
  });
}
export async function h06Phase(
  request: H06Request,
  phase: 'initial' | 'cold',
  backend: unknown,
  deadline: string,
) {
  requireContract(process.connected === true, 'h06-phase-owner-required');
  remaining(deadline, request.budget.stopMs);
  if (request.variant === 'legacy') {
    if (phase === 'initial') await h06LegacyInitial(request, deadline);
    else h06LegacyCold(request);
  } else await h06TemporalPhase(request, phase, String(object(backend).address), deadline);
  if (process.connected) process.disconnect!();
}
export async function runH06Phase(
  request: H06Request,
  phase: 'initial' | 'cold',
  backend: unknown,
  deadline: string,
) {
  remaining(deadline, request.budget.stopMs);
  requireContract(process.connected === true, 'h06-coordinator-owner-required');
  if (phase === 'cold') h06ConfirmRecoveryEffect(request);
  readH04Pin(request.node);
  const path = join(request.outputRoot, phase + '-backend.json');
  saveH06(path, backend);
  const ref = { path, sha256: digest(h01RawFile(path)) };
  const out = openSync(
      join(request.outputRoot, phase + '-stdout.log'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    ),
    err = openSync(
      join(request.outputRoot, phase + '-stderr.log'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  let child;
  try {
    child = spawn(
      request.node.path,
      [
        '--import',
        'tsx',
        SELF,
        '--phase',
        join(request.outputRoot, 'request.json'),
        phase,
        JSON.stringify(ref),
        deadline,
      ],
      { detached: true, stdio: ['ignore', out, err, 'ipc'], env: process.env },
    );
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const owned = ownProcess(child, {
    deadline: performance.now() + remaining(deadline),
    stopMs: request.budget.stopMs,
  });
  const disconnect = () => {
    void owned.stop();
  };
  process.once('disconnect', disconnect);
  let receipt;
  try {
    receipt = await owned.done;
  } finally {
    receipt ??= await owned.stop();
    saveH06(join(request.outputRoot, phase + '-stop.json'), receipt);
    process.removeListener('disconnect', disconnect);
  }
  requireContract(process.connected === true && h06Stopped(receipt), 'h06-phase-stop-unconfirmed');
}
export async function h06Operation(request: H06Request, deadline: string) {
  requireContract(process.connected === true, 'h06-operation-owner-required');
  remaining(deadline, request.budget.stopMs);
  let environment: SDKTestEnvironment | undefined;
  try {
    let backend: unknown = null;
    if (request.variant === 'temporal') {
      requireContract(request.server !== null, 'h06-server');
      readH04Pin(request.server);
      const { TestWorkflowEnvironment } = await import('@temporalio/testing');
      environment = await TestWorkflowEnvironment.createLocal({
        server: {
          ip: '127.0.0.1',
          ui: false,
          executable: { type: 'existing-path', path: request.server.path },
          dbFilename: join(request.outputRoot, 'temporal.sqlite'),
        },
      });
      backend = { address: environment.address, taskQueue: request.operationId };
    }
    await runH06Phase(request, 'initial', backend, deadline);
    await runH06Phase(request, 'cold', backend, deadline);
  } finally {
    if (environment) await h06CleanupAwait(environment.teardown(), deadline);
  }
  if (process.connected) process.disconnect!();
}
export async function h06Keeper(request: H06Request, deadline: string) {
  requireContract(process.connected === true, 'h06-keeper-owner-required');
  const ms = remaining(deadline);
  requireContract(ms <= request.budget.totalMs, 'h06-keeper-deadline');
  readH04Pin(request.node);
  const child = spawn(
    request.node.path,
    ['--import', 'tsx', SELF, '--operation', join(request.outputRoot, 'request.json'), deadline],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env },
  );
  const owned = ownProcess(child, {
    deadline: performance.now() + ms,
    stopMs: request.budget.stopMs,
  });
  const disconnected = () => {
    void owned.stop();
  };
  process.once('disconnect', disconnected);
  let stop;
  try {
    stop = await owned.done;
  } finally {
    stop ??= await owned.stop();
    saveH06(join(request.outputRoot, 'worker-stop.json'), stop);
    process.removeListener('disconnect', disconnected);
  }
  requireContract(process.connected === true && h06Stopped(stop), 'h06-operation-stop-unconfirmed');
  process.disconnect!();
}
export async function runH06(value: unknown) {
  const { request, sourcePins } = planH06(value);
  requireContract(request.node.path === realpathSync(process.execPath), 'h06-actual-node-required');
  requireContract(!existsSync(request.outputRoot), 'h06-output-exists');
  const parent = resolve(request.outputRoot, '..');
  requireContract(realpathSync(parent) === parent, 'h06-output-parent-alias');
  mkdirSync(request.outputRoot, { mode: 0o700 });
  requireContract(realpathSync(request.outputRoot) === request.outputRoot, 'h06-output-alias');
  saveH06(join(request.outputRoot, 'request.json'), request);
  saveH06(join(request.outputRoot, 'source-pins.json'), sourcePins);
  writeFileSync(join(request.outputRoot, 'F-01.json'), h06Failure(request), {
    flag: 'wx',
    mode: 0o600,
  });
  const deadline = String(process.hrtime.bigint() + BigInt(request.budget.totalMs) * 1000000n);
  const out = openSync(
      join(request.outputRoot, 'stdout.log'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    ),
    err = openSync(
      join(request.outputRoot, 'stderr.log'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  let child;
  try {
    child = spawn(
      request.node.path,
      ['--import', 'tsx', SELF, '--worker', join(request.outputRoot, 'request.json'), deadline],
      {
        detached: true,
        stdio: ['ignore', out, err, 'ipc'],
        env: {
          ...process.env,
          TSX_DISABLE_CACHE: '1',
          NODE_DISABLE_COMPILE_CACHE: '1',
          TMPDIR: request.outputRoot,
        },
      },
    );
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const owned = ownProcess(child, {
    deadline: performance.now() + remaining(deadline),
    stopMs: request.budget.stopMs,
  });
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void owned.stop();
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let stop;
  try {
    stop = await owned.done;
  } finally {
    stop ??= await owned.stop();
    saveH06(join(request.outputRoot, 'stop.json'), stop);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
  requireContract(!cancelled, 'h06-cancelled');
  for (const ref of sourcePins) readH04Pin(ref);
  const report = checkH06(request);
  saveH06(join(request.outputRoot, 'report.json'), report);
  return report;
}
export async function h06Main(args: string[]) {
  const [command, path] = args;
  requireContract(typeof path === 'string', 'h06-arguments');
  const value = readH04Json(path);
  if (command === '--plan') {
    requireContract(args.length === 2, 'h06-arguments');
    return planH06(value);
  }
  const request = parseH06Request(value);
  if (command === '--check') {
    requireContract(args.length === 2, 'h06-arguments');
    return checkH06(request);
  }
  if (command === '--run') {
    requireContract(args.length === 2, 'h06-arguments');
    return await runH06(request);
  }
  if (command === '--phase') {
    requireContract(
      args.length === 5 && (args[2] === 'initial' || args[2] === 'cold'),
      'h06-arguments',
    );
    await h06Phase(
      request,
      args[2],
      JSON.parse(readH04Pin(h04Pin(JSON.parse(args[3]!))).toString()),
      args[4]!,
    );
  } else {
    requireContract(args.length === 3, 'h06-arguments');
    const deadline = args[2]!;
    if (command === '--worker') await h06Keeper(request, deadline);
    else if (command === '--operation') await h06Operation(request, deadline);
    else {
      requireContract(command === '--writer', 'h06-arguments');
      await h06WriterProgram(request, deadline);
    }
  }
  return null;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  h06Main(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    });
}
