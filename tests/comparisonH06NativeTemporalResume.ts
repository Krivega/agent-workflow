import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { Client } from '@temporalio/client';
import { artifactStore, digest, publishFile } from '../src/adapters/artifacts/files.js';
import { type NativeReaderIssuer } from '../src/adapters/codex/readerAuthority.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import { taskFiles } from '../src/adapters/project/taskFiles.js';
import { taskGateBinding } from '../src/adapters/project/taskGate.js';
import { controlTaskExecution, makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import { bindTaskBackendClient, requireClientTaskBackend } from '../src/client/taskBackend.js';
import type { PayloadReaderCommand, ReaderCommandAck } from '../src/contracts/readerControl.js';
import type { LocalTaskInput } from '../src/contracts/localTask.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import type { ReaderInput } from '../src/contracts/reader.js';
import { parseLocalTask } from '../src/policy/localTask.js';
import { controlRef } from '../src/policy/readerControl.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { createReaderHost } from '../src/worker/readerHost.js';
import { recoverReaderHost } from '../src/worker/readerRecovery.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  planH06NativeResume,
  planH06NativeResumeObservation,
} from './comparisonH06NativeResume.js';
import {
  readH06NativeHostOwner,
  readH06NativeTemporalStart,
  withH06TemporalProject,
  type H06TemporalStage,
} from './comparisonH06NativeTemporal.js';

import {
  h06TemporalControlAuthority,
  publishH06TemporalControlSource,
  verifyH06TemporalControlProof,
  type H06TemporalAutonomousMode,
  type H06TemporalControlSource,
} from './comparisonH06TemporalAutonomousControls.js';

export interface H06ResumeRequest {
  started: H04Pin;
  status: H04Pin;
  commandId: string;
}

export type H06Opening =
  | { phase: 'warm' }
  | { phase: 'cold'; warm: H04Pin; readers: ReaderInput[]; tasks: LocalTaskInput[] };

function resumePlanContext(request: H06ResumeRequest) {
  const started = readH06NativeTemporalStart(request.started);
  const { artifactRoot, evidence, input } = started;
  const plan = planH06NativeResume({
    kind: 'comparison-h06-native-resume-plan',
    artifactRoot,
    status: request.status,
    commandId: request.commandId,
  });
  requireContract(
    request.status.path === join(evidence, `status-paused-${plan.command.expectedRevision}.json`) &&
      same(plan.command.target, taskControlTarget(input)),
    'h06-temporal-resume-binding',
  );
  const store = artifactStore(artifactRoot, { existingOnly: true });
  return { ...started, plan, store };
}

function resumeContext(request: H06ResumeRequest, issuer: NativeReaderIssuer) {
  const context = resumePlanContext(request);
  requireContract(issuer.owner === context.plan.command.author, 'h06-temporal-resume-binding');
  return {
    ...context,
    authority: h06TemporalControlAuthority(
      context.store,
      issuer,
      context.start.controlMode as H06TemporalAutonomousMode | undefined,
    ),
  };
}

function resumePaths(evidence: string, revision: number) {
  const prefix = join(evidence, `resume-${revision}`);
  return { intentPath: prefix + '-intent.json', receiptPath: prefix + '-ack.json' };
}

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** A previous ACK is returned from the retained workflow journal without any live calls. */
export function readH06NativeTemporalResumeReceipt(
  request: H06ResumeRequest,
  command: PayloadReaderCommand,
  opening?: H06Opening,
) {
  const { start, evidence, artifactRoot, plan, store } = resumePlanContext(request);
  requireContract(
    same(command, makeTaskExecutionCommand({ ...plan.command, source: command.source })),
    'h06-temporal-resume-command',
  );
  const revision = command.expectedRevision + 1;
  const { intentPath, receiptPath } = resumePaths(evidence, revision);
  const hostPath =
    opening === undefined ? null : join(evidence, `temporal-${opening.phase}-host.json`);
  if (!present(intentPath) && !present(receiptPath)) {
    requireContract(
      hostPath === null || (!present(hostPath) && !present(hostPath + '.intent')),
      'h06-temporal-resume-outcome-unknown',
    );
    return null;
  }
  requireContract(
    present(intentPath) && present(receiptPath),
    'h06-temporal-resume-outcome-unknown',
  );
  const intentBytes = h01RawFile(intentPath);
  const intent = object(JSON.parse(intentBytes.toString()));
  const bytes = h01RawFile(receiptPath);
  const receipt = object(JSON.parse(bytes.toString()));
  exactFields(intent, ['kind', 'request', 'workflowId', 'runId', 'command', 'proof', 'opened']);
  exactFields(receipt, ['kind', 'intent', 'workflowId', 'runId', 'ack']);
  requireContract(
    intent.kind === 'h06-native-temporal-resume-intent' &&
      same(intent.request, request) &&
      intent.workflowId === plan.workflowId &&
      intent.runId === plan.runId &&
      same(intent.command, command) &&
      receipt.kind === 'h06-native-temporal-resume-ack' &&
      receipt.workflowId === plan.workflowId &&
      receipt.runId === plan.runId &&
      same(receipt.intent, { path: intentPath, sha256: digest(intentBytes) }),
    'h06-temporal-resume-replay-binding',
  );
  let opened: H04Pin | null = null;
  if (opening === undefined) {
    requireContract(intent.opened === null, 'h06-temporal-resume-replay-opening');
  } else {
    opened = h04Pin(intent.opened);
    requireContract(opened.path === hostPath, 'h06-temporal-resume-replay-opening');
    const recorded = object(JSON.parse(readH04Pin(opened).toString()));
    const hostIntent = object(JSON.parse(h01RawFile(opened.path + '.intent').toString()));
    const phase = opening.phase;
    const hostRoot = join(evidence, 'temporal-host');
    let previous = start.hostOwner;
    if (phase === 'cold') {
      requireContract(
        opening.warm.path === join(evidence, 'temporal-warm-host.json'),
        'h06-temporal-resume-replay-opening',
      );
      previous = object(JSON.parse(readH04Pin(h04Pin(opening.warm)).toString())).owner;
    }
    requireContract(
      recorded.kind === 'h06-native-temporal-reopen' &&
        recorded.phase === phase &&
        same(recorded.started, request.started) &&
        same(recorded.status, request.status) &&
        recorded.hostRoot === hostRoot &&
        same(recorded.previous, previous) &&
        same(hostIntent, { phase, previous, started: request.started, status: request.status }) &&
        command.attempt === (phase === 'warm' ? 1 : 2),
      'h06-temporal-resume-replay-opening',
    );
  }

  const rawAck = object(receipt.ack);
  exactFields(rawAck, ['commandId', 'hash', 'revision', 'authorization']);
  requireContract(
    rawAck.commandId === command.commandId &&
      rawAck.hash === command.hash &&
      rawAck.revision === revision,
    'h06-temporal-resume-replay-ack',
  );
  const ack: ReaderCommandAck = {
    commandId: command.commandId,
    hash: command.hash,
    revision,
    authorization: controlRef(rawAck.authorization),
  };
  const artifact = (ref: unknown) => object(JSON.parse(store.read(controlRef(ref)).toString()));
  const transition = artifact(ack.authorization);
  const prior = parseLocalTask(artifact(plan.held).input);
  requireContract(
    transition.kind === 'task-execution-continuation' &&
      same(transition.input, prior) &&
      same(transition.held, plan.held) &&
      same(transition.command, command) &&
      same(transition.admission, plan.payload.admission),
    'h06-temporal-resume-replay-transition',
  );
  const source = artifact(command.source);
  for (const ref of [intent.proof, transition.authorization]) {
    const proof = artifact(ref);
    requireContract(
      (start.controlMode === undefined
        ? proof.kind === 'reader-native-human-authorization'
        : proof.kind === 'reader-h06-temporal-initial-grant-authorization/3') &&
        same(proof.command, command) &&
        same(proof.source, source),
      'h06-temporal-resume-replay-proof',
    );
    if (start.controlMode !== undefined)
      verifyH06TemporalControlProof(
        store,
        start.controlMode as H06TemporalAutonomousMode,
        command,
        proof,
      );
  }

  const workspace = text(start.workspaceRoot);
  const gate = taskGateBinding(
    prior,
    taskFiles(artifactRoot, { existingOnly: true }).binding(workspace),
    start.profile as H06TemporalStage['profile'],
    artifactRoot,
    identifier(object(start.hostOwner).id),
  );
  const journal = dirname(dirname(gate.directory));
  const workflowIntent = object(
    JSON.parse(
      h01RawFile(join(journal, 'execution-command-intents', `${revision}.json`)).toString(),
    ),
  );
  const workflowRecord = object(
    JSON.parse(
      h01RawFile(join(journal, 'execution-commands', `${command.commandId}.json`)).toString(),
    ),
  );
  const next = parseLocalTask({
    ...prior,
    admission: plan.payload.admission,
    continuation: { attempt: command.attempt, previous: ack.authorization },
  });
  requireContract(
    same(workflowIntent, { input: prior, command, authorization: transition.authorization }) &&
      same(workflowRecord, { command, ack, next }),
    'h06-temporal-resume-replay-journal',
  );
  store.read(command.payload);
  return { ack, receipt: { path: receiptPath, sha256: digest(bytes) }, opened };
}

/** Emit the returned notice in the same native human turn before delivering the command. */
export async function issueH06NativeTemporalResume(
  request: H06ResumeRequest,
  issuer: NativeReaderIssuer,
  source: H06TemporalControlSource,
) {
  const { plan, store, authority } = resumeContext(request, issuer);
  const payload = store.publish(Buffer.from(JSON.stringify(plan.payload)));
  requireContract(same(payload, plan.command.payload), 'h06-temporal-resume-payload');
  const command = makeTaskExecutionCommand({
    ...plan.command,
    source: publishH06TemporalControlSource(store, source, plan.command),
  });
  return { command, notice: await authority.issue(command) };
}

async function verifiedResume(
  request: H06ResumeRequest,
  issuer: NativeReaderIssuer,
  command: PayloadReaderCommand,
) {
  const context = resumeContext(request, issuer);
  requireContract(
    same(command, makeTaskExecutionCommand({ ...context.plan.command, source: command.source })),
    'h06-temporal-resume-command',
  );
  await context.authority.issue(command);
  const authorization = await context.authority.verify(command);
  context.store.read(command.payload);
  return { ...context, authorization };
}

/** Check the exact current native RESUME before acquiring a new SDK connection. */
export async function verifyH06NativeTemporalResume(
  request: H06ResumeRequest,
  issuer: NativeReaderIssuer,
  command: PayloadReaderCommand,
) {
  await verifiedResume(request, issuer, command);
}

async function dispatchResume(
  context: Awaited<ReturnType<typeof verifiedResume>>,
  request: H06ResumeRequest,
  client: Client,
  command: PayloadReaderCommand,
  deadline: number,
  opened: H04Pin | null = null,
) {
  const { artifactRoot, authority, evidence, plan, store } = context;
  requireClientTaskBackend(client, context.input.admission.preparation);
  const checkTime = () =>
    requireContract(
      Number.isSafeInteger(deadline) && Date.now() < deadline,
      'h06-temporal-resume-deadline',
    );
  checkTime();
  const { workflowId, runId } = plan;
  const result = await client.connection.withDeadline(deadline, () =>
    client.workflow.getHandle(workflowId, runId).query<unknown>('localTaskStatus'),
  );
  const live = planH06NativeResumeObservation(
    artifactRoot,
    { workflowId, runId, query: 'localTaskStatus', result },
    command.commandId,
  );
  requireContract(same(live, plan), 'h06-temporal-resume-state-changed');
  await authority.issue(command);
  checkTime();
  const { intentPath, receiptPath } = resumePaths(evidence, command.expectedRevision + 1);
  const intent = {
    kind: 'h06-native-temporal-resume-intent',
    request,
    workflowId,
    runId,
    command,
    proof: context.authorization.proof,
    opened,
  };
  const intentBytes = Buffer.from(JSON.stringify(intent));
  publishFile(intentPath, intentBytes);
  const ack = await client.connection.withDeadline(deadline, () =>
    controlTaskExecution(client, workflowId, command, runId),
  );
  const transition = object(JSON.parse(store.read(controlRef(ack.authorization)).toString()));
  const proof = object(JSON.parse(store.read(controlRef(transition.authorization)).toString()));
  requireContract(
    transition.kind === 'task-execution-continuation' &&
      same(transition.held, plan.held) &&
      same(transition.command, command) &&
      (context.start.controlMode === undefined
        ? proof.kind === 'reader-native-human-authorization'
        : proof.kind === 'reader-h06-temporal-initial-grant-authorization/3') &&
      same(proof.command, command),
    'h06-temporal-resume-receipt',
  );
  if (context.start.controlMode !== undefined)
    verifyH06TemporalControlProof(
      store,
      context.start.controlMode as H06TemporalAutonomousMode,
      command,
      proof,
    );
  const bytes = Buffer.from(
    JSON.stringify({
      kind: 'h06-native-temporal-resume-ack',
      intent: { path: intentPath, sha256: digest(intentBytes) },
      workflowId,
      runId,
      ack,
    }),
  );
  publishFile(receiptPath, bytes);
  return { ack, receipt: { path: receiptPath, sha256: digest(bytes) } };
}

/** An uncertain update leaves its immutable intent and requires reconciliation. */
export async function deliverH06NativeTemporalResume(
  request: H06ResumeRequest,
  issuer: NativeReaderIssuer,
  client: Client,
  command: PayloadReaderCommand,
  workDeadlineMs: number,
) {
  const previous = readH06NativeTemporalResumeReceipt(request, command);
  if (previous !== null) return { ack: previous.ack, receipt: previous.receipt };
  const context = await verifiedResume(request, issuer, command);
  return dispatchResume(context, request, client, command, workDeadlineMs);
}

/** Reopen the retained host root, then use the same run-bound delivery as a live host. */
export async function reopenH06NativeTemporal<T>(
  request: H06ResumeRequest,
  services: H06TemporalStage,
  command: PayloadReaderCommand,
  opening: H06Opening,
  run: (resume: Awaited<ReturnType<typeof dispatchResume>>, opened: H04Pin) => Promise<T>,
) {
  const replayed = readH06NativeTemporalResumeReceipt(request, command, opening);
  if (replayed !== null) return replayed;
  const context = await verifiedResume(request, services.issuer, command);
  const { start, input, evidence, artifactRoot } = context;
  const { registration, profile } = services;
  const { workDeadlineMs, taskQueue, workflowsPath, maxTurnStarts } = services;
  const hostRoot = join(evidence, 'temporal-host');
  requireContract(
    start.hostRoot === hostRoot &&
      start.workspaceRoot === registration.workspaceRoot &&
      start.artifactRoot === registration.artifactRoot &&
      registration.artifactRoot === artifactRoot &&
      input.admission.preparation.hostId === registration.hostId &&
      input.admission.preparation.owner === registration.owner &&
      input.admission.preparation.generation === registration.generation &&
      same(input.admission.preparation.project, registration.project) &&
      start.taskQueue === taskQueue &&
      start.workflowsPath === workflowsPath &&
      start.maxTurnStarts === maxTurnStarts &&
      same(start.profile, profile) &&
      command.attempt === (opening.phase === 'warm' ? 1 : 2),
    'h06-temporal-reopen-binding',
  );
  bindTaskBackendClient(services.client, registration);
  requireClientTaskBackend(services.client, input.admission.preparation);
  const time = () =>
    requireContract(
      Number.isSafeInteger(workDeadlineMs) && Date.now() < workDeadlineMs,
      'h06-temporal-resume-deadline',
    );
  time();
  const hasOwner = lstatSync(join(hostRoot, 'host-owner'), { throwIfNoEntry: false }) !== undefined;
  let previous = object(start.hostOwner);
  if (opening.phase === 'cold') {
    const warm = object(JSON.parse(readH04Pin(h04Pin(opening.warm)).toString()));
    requireContract(
      opening.warm.path === join(evidence, 'temporal-warm-host.json') &&
        warm.kind === 'h06-native-temporal-reopen' &&
        warm.phase === 'warm' &&
        same(warm.started, request.started) &&
        warm.hostRoot === hostRoot,
      'h06-temporal-warm-receipt',
    );
    previous = object(warm.owner);
  }
  const previousId = identifier(previous.id);
  const previousPid = previous.pid;
  requireContract(
    typeof previousPid === 'number' &&
      Number.isSafeInteger(previousPid) &&
      previousPid > 1 &&
      (opening.phase === 'warm'
        ? previousPid === process.pid && !hasOwner
        : previousPid !== process.pid),
    'h06-temporal-reopen-owner',
  );
  if (hasOwner)
    requireContract(same(readH06NativeHostOwner(hostRoot), previous), 'h06-temporal-reopen-owner');
  const path = join(evidence, `temporal-${opening.phase}-host.json`);
  publishFile(
    path + '.intent',
    Buffer.from(
      JSON.stringify({
        phase: opening.phase,
        previous,
        started: request.started,
        status: request.status,
      }),
    ),
  );
  const previousProcesses =
    opening.phase === 'cold' && !hasOwner
      ? await new NativeWriterProcesses().descendants([previousPid])
      : null;
  requireContract(
    previousProcesses === null || previousProcesses.length === 0,
    'h06-temporal-reopen-owner',
  );
  time();
  await context.authority.issue(command);
  return withH06TemporalProject(services, evidence, async ({ rpc, localTasks }) => {
    const projects = [{ registration, rpc, localTasks, authority: context.authority }];
    const recovery =
      opening.phase === 'cold' && hasOwner
        ? await recoverReaderHost(projects, hostRoot, profile, opening.readers, opening.tasks)
        : null;
    time();
    await context.authority.issue(command);
    const host = await createReaderHost(
      services.connection,
      taskQueue,
      workflowsPath,
      projects,
      profile,
      hostRoot,
      maxTurnStarts,
    );
    return host.runUntil(async () => {
      const owner = readH06NativeHostOwner(hostRoot);
      requireContract(
        owner.id !== previousId && owner.pid === process.pid,
        'h06-temporal-reopen-owner',
      );
      const bytes = Buffer.from(
        JSON.stringify({
          kind: 'h06-native-temporal-reopen',
          phase: opening.phase,
          started: request.started,
          status: request.status,
          transportRoot: services.transportEvidenceRoot ?? null,
          hostRoot,
          previous,
          owner,
          recovery,
          previousProcesses,
        }),
      );
      publishFile(path, bytes);
      const opened = { path, sha256: digest(bytes) };
      const resume = await dispatchResume(
        context,
        request,
        services.client,
        command,
        workDeadlineMs,
        opened,
      );
      time();
      return run(resume, opened);
    });
  });
}
