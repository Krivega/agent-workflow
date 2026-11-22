import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { Client } from '@temporalio/client';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import { lookupEffect } from '../src/adapters/artifacts/effects.js';
import {
  nativeHumanAuthorizationText,
  type NativeReaderIssuer,
} from '../src/adapters/codex/readerAuthority.js';
import { inspectTaskWriter } from '../src/adapters/codex/taskWriter.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import { taskFiles } from '../src/adapters/project/taskFiles.js';
import { taskGate } from '../src/adapters/project/taskGate.js';
import { controlTaskExecution, makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import { requireClientTaskBackend } from '../src/client/taskBackend.js';
import type { TaskSnapshot } from '../src/contracts/localTask.js';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { parseLocalTask } from '../src/policy/localTask.js';
import { controlRef } from '../src/policy/readerControl.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { taskExecutionCommand, taskInterruption } from '../src/policy/taskExecution.js';
import type { H04Pin } from './comparisonH04Contract.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { openH06NativeAttemptTurnLedger } from './comparisonH06NativeAttempt.js';
import { localTaskKey } from '../src/policy/localTask.js';
import {
  readH06NativeHostOwner,
  readH06NativeTemporalStart,
} from './comparisonH06NativeTemporal.js';

import {
  h06TemporalControlAuthority,
  publishH06TemporalControlSource,
  verifyH06TemporalControlProof,
  type H06TemporalControlSource,
  type H06TemporalAutonomousMode,
} from './comparisonH06TemporalAutonomousControls.js';

async function pauseContext(client: Client, started: H04Pin, runId: string, deadline: number) {
  const {
    start,
    input: initial,
    evidence,
    artifactRoot,
    workflowId,
  } = readH06NativeTemporalStart(started);
  identifier(runId);
  const time = () =>
    requireContract(
      Number.isSafeInteger(deadline) && Date.now() < deadline,
      'h06-temporal-pause-deadline',
    );
  time();
  const readStatus = async () =>
    object(
      await client.connection.withDeadline(deadline, () =>
        client.workflow.getHandle(workflowId, runId).query<unknown>('localTaskStatus'),
      ),
    );
  const status = await readStatus();
  const snapshotRef = controlRef(status.snapshot);
  const files = taskFiles(artifactRoot, { existingOnly: true });
  const read = (ref: unknown) => object(JSON.parse(files.store.read(controlRef(ref)).toString()));
  const rawSnapshot = read(snapshotRef);
  const input = parseLocalTask(rawSnapshot.input);
  requireContract(
    status.runId === runId &&
      status.phase === 'writing' &&
      status.waiting === false &&
      Number.isSafeInteger(status.revision) &&
      input.schemaVersion === 11 &&
      status.attempt === input.continuation.attempt &&
      same(taskControlTarget(input), taskControlTarget(initial)) &&
      rawSnapshot.kind === 'substantial-task' &&
      rawSnapshot.schemaVersion === 3 &&
      object(rawSnapshot.source).root === start.workspaceRoot &&
      same(rawSnapshot.profile, start.profile),
    'h06-temporal-pause-live-state',
  );
  return {
    start,
    evidence,
    artifactRoot,
    workflowId,
    time,
    readStatus,
    status,
    snapshotRef,
    files,
    read,
    input,
    snapshot: rawSnapshot as unknown as TaskSnapshot,
  };
}

/** Observe a live implementation turn before any autonomous phase intent is published. */
export async function observeH06NativeTemporalWriterReady(
  client: Client,
  started: H04Pin,
  runId: string,
  deadline: number,
) {
  const context = await pauseContext(client, started, runId, deadline);
  const { start, evidence, artifactRoot, input, snapshot, files } = context;
  const owner = readH06NativeHostOwner(join(evidence, 'temporal-host'));
  const gate = taskGate(input, snapshot.source, snapshot.profile, artifactRoot, owner.id);
  gate.assert();
  const observed = await inspectTaskWriter(
    snapshot,
    files,
    gate.directory,
    new NativeWriterProcesses(),
  );
  if (observed.status !== 'live') return false;
  requireContract(start.hostRoot === join(evidence, 'temporal-host'), 'h06-temporal-pause-host');
  const target = taskControlTarget(input);
  const key = digest(localTaskKey(input));
  const created = lookupEffect(join(gate.directory, 'writer-effects'), {
    projectId: target.projectId,
    taskId: target.taskId,
    operationId: `task-create-${key}-a${input.continuation.attempt}`,
    requestHash: digest(JSON.stringify({ snapshot })),
    hostId: target.hostId,
    workspaceId: target.workspaceId,
    owner: target.owner,
    generation: target.generation,
  });
  if (created.status !== 'completed') return false;
  const creation = context.read(created.receipt);
  const identity = object(creation.identity);
  const raw = object(creation.raw);
  const thread = object(raw.thread);
  const session = identifier(identity.session);
  // The immutable live marker precedes thread/start; the completed create proof binds its session.
  requireContract(
    creation.kind === 'task-writer-session' &&
      same(creation.input, input) &&
      same(identity.processes, observed.runtime.processes) &&
      (observed.runtime.session === null || observed.runtime.session === session) &&
      thread.id === session &&
      thread.cwd === snapshot.copy.root &&
      raw.cwd === snapshot.copy.root &&
      raw.model === snapshot.profile.model &&
      raw.reasoningEffort === snapshot.profile.effort,
    'h06-temporal-ready-session',
  );
  const path = join(evidence, 'attempt-claim.json');
  const ledger = openH06NativeAttemptTurnLedger({
    path,
    sha256: digest(h01RawFile(path)),
  }).inspect();
  const operation = `task-implement-${key}-a${input.continuation.attempt}`;
  context.time();
  return (
    ledger.status === 'RECORDED' &&
    ledger.admissions.some(
      ({ scope, response }) =>
        scope.role === 'writer' &&
        scope.root === snapshot.copy.root &&
        scope.session === session &&
        scope.operation === operation &&
        response !== null,
    )
  );
}

interface PauseRequest {
  started: H04Pin;
  runId: string;
  commandId: string;
  reason: string;
}

function pausePlan(context: Awaited<ReturnType<typeof pauseContext>>, request: PauseRequest) {
  const { input, status, snapshotRef } = context;
  const payload = { schemaVersion: 1, kind: 'task-interruption', reason: request.reason };
  taskInterruption(payload);
  const bytes = Buffer.from(JSON.stringify(payload));
  const target = taskControlTarget(input);
  const command = {
    schemaVersion: 2 as const,
    commandId: identifier(request.commandId),
    target,
    expectedRevision: Number(status.revision),
    author: target.owner,
    action: 'pause' as const,
    attempt: input.continuation.attempt,
    payload: { sha256: digest(bytes), bytes: bytes.length },
  };
  const formatted = taskExecutionCommand(
    input,
    makeTaskExecutionCommand({ ...command, source: snapshotRef }),
    command.expectedRevision,
  );
  return { command, payload, authorizationText: nativeHumanAuthorizationText(formatted) };
}

/** Read the current writing state and format the exact human PAUSE proposal. */
export async function planH06NativeTemporalPause(
  client: Client,
  request: PauseRequest,
  deadline: number,
) {
  const context = await pauseContext(client, request.started, request.runId, deadline);
  context.time();
  return { ...pausePlan(context, request), mayRun: false, qualification: false } as const;
}

/** Emit the returned notice in the native human turn, then deliver PAUSE separately. */
export async function issueH06NativeTemporalPause(
  client: Client,
  request: PauseRequest,
  issuer: NativeReaderIssuer,
  source: H06TemporalControlSource,
  deadline: number,
) {
  const context = await pauseContext(client, request.started, request.runId, deadline);
  const plan = pausePlan(context, request);
  context.time();
  const { store } = context.files;
  const payload = store.publish(Buffer.from(JSON.stringify(plan.payload)));
  const command = makeTaskExecutionCommand({
    ...plan.command,
    payload,
    source: publishH06TemporalControlSource(store, source, plan.command),
  });
  const authority = h06TemporalControlAuthority(
    store,
    issuer,
    context.start.controlMode as H06TemporalAutonomousMode | undefined,
  );
  return { command, notice: await authority.issue(command) };
}

/** Deliver an already issued PAUSE only after observing the current owned Writer alive. */
export async function pauseH06NativeTemporal(
  client: Client,
  started: H04Pin,
  runId: string,
  rawCommand: unknown,
  issuer: NativeReaderIssuer,
  deadline: number,
) {
  const {
    start,
    evidence,
    artifactRoot,
    workflowId,
    time,
    readStatus,
    status,
    snapshotRef,
    files,
    read,
    input,
    snapshot,
  } = await pauseContext(client, started, runId, deadline);
  requireClientTaskBackend(client, input.admission.preparation);
  const command = taskExecutionCommand(input, rawCommand, Number(status.revision));
  requireContract(command.action === 'pause', 'h06-temporal-pause-command');
  taskInterruption(read(command.payload));
  const mode = start.controlMode as H06TemporalAutonomousMode | undefined;
  const authority = h06TemporalControlAuthority(files.store, issuer, mode);
  await authority.issue(command);
  const proof = await authority.verify(command);
  files.bound(snapshot.source);
  files.bound(snapshot.copy);
  const hostRoot = join(evidence, 'temporal-host');
  requireContract(start.hostRoot === hostRoot, 'h06-temporal-pause-host');
  const owner = readH06NativeHostOwner(hostRoot);
  const gate = taskGate(input, snapshot.source, snapshot.profile, artifactRoot, owner.id);
  requireContract(gate.admission().mode === 'owned', 'h06-temporal-pause-host');
  gate.assert();
  const processes = new NativeWriterProcesses();
  const observed = await inspectTaskWriter(snapshot, files, gate.directory, processes);
  requireContract(observed.status === 'live', 'h06-temporal-pause-writer-not-live');
  const owned = await processes.descendants(observed.processes.map((p) => p.pid));
  requireContract(
    observed.processes.every((identity) => owned.some((candidate) => same(candidate, identity))),
    'h06-temporal-pause-writer-not-live',
  );
  const current = await readStatus();
  requireContract(
    current.runId === runId &&
      current.phase === 'writing' &&
      current.waiting === false &&
      current.revision === status.revision &&
      same(current.snapshot, snapshotRef) &&
      same(readH06NativeHostOwner(hostRoot), owner),
    'h06-temporal-pause-live-state',
  );
  await authority.issue(command);
  gate.assert();
  time();
  const path = join(evidence, `pause-${command.expectedRevision + 1}`);
  const intentPath = path + '-intent.json';
  const bytes = Buffer.from(
    JSON.stringify({
      kind: 'h06-native-temporal-pause-intent',
      started,
      workflowId,
      runId,
      owner,
      command,
      snapshot: snapshotRef,
      proof: proof.proof,
      observed,
      owned,
      observedAt: Date.now(),
    }),
  );
  publishFile(intentPath, bytes);
  const ack = await client.connection.withDeadline(deadline, () =>
    controlTaskExecution(client, workflowId, command, runId),
  );
  const interruption = read(ack.authorization);
  const authorization = read(interruption.authorization);
  requireContract(
    interruption.kind === 'task-execution-interruption' &&
      same(interruption.input, input) &&
      same(interruption.command, command) &&
      (mode === undefined
        ? authorization.kind === 'reader-native-human-authorization'
        : authorization.kind === 'reader-h06-temporal-initial-grant-authorization/3') &&
      same(authorization.command, command),
    'h06-temporal-pause-receipt',
  );
  if (mode !== undefined) verifyH06TemporalControlProof(files.store, mode, command, authorization);
  const receiptPath = path + '-ack.json';
  const receipt = Buffer.from(
    JSON.stringify({
      kind: 'h06-native-temporal-pause-ack',
      intent: { path: intentPath, sha256: digest(bytes) },
      ack,
    }),
  );
  publishFile(receiptPath, receipt);
  return { ack, receipt: { path: receiptPath, sha256: digest(receipt) } };
}
