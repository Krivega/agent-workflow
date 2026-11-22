import { lstatSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { Client } from '@temporalio/client';
import type { NativeConnection } from '@temporalio/worker';
import { createPrivateDirectory, safeDirectory } from '../adapters/storage/storeFiles.js';
import {
  artifactStore,
  digest,
  publishFile,
  readPrivateFile,
} from '../src/adapters/artifacts/files.js';
import { type NativeReaderIssuer } from '../src/adapters/codex/readerAuthority.js';
import { startLocalTask } from '../src/client/localTask.js';
import { bindTaskBackendClient, requireClientTaskBackend } from '../src/client/taskBackend.js';
import { identifier, object, requireContract, text } from '../src/contracts/project.js';
import type { ReaderCommandAck } from '../src/contracts/readerControl.js';
import type { LocalTaskHost } from '../src/activities/localTask.js';
import { localTaskKey, parseLocalTask } from '../src/policy/localTask.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { createReaderHost, type ReaderProjectHost } from '../src/worker/readerHost.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { startH06NativeVariant } from './comparisonH06Native.js';
import type { H06NativeFailureBinding } from './comparisonH06NativeFailure.js';
import { planH06NativeResumeObservation } from './comparisonH06NativeResume.js';
import {
  openH06NativeTransport,
  type H06NativeTransportOptions,
} from './comparisonH06NativeTransport.js';

import {
  h06TemporalControlAuthority,
  readH06TemporalControlMode,
  type H06TemporalAutonomousMode,
} from './comparisonH06TemporalAutonomousControls.js';

export interface H06TemporalStage {
  controlMode?: H06TemporalAutonomousMode;
  client: Client;
  connection: NativeConnection;
  taskQueue: string;
  workflowsPath: string;
  registration: ReaderProjectHost['registration'];
  profile: LocalTaskHost['profile'];
  transportEvidenceRoot?: string;
  openProject(): Promise<
    Pick<ReaderProjectHost, 'rpc'> & { localTasks: LocalTaskHost; stop(): Promise<unknown> }
  >;
  issuer: NativeReaderIssuer;
  maxTurnStarts: number;
  workDeadlineMs: number;
}

/** Bind the owned transport to the registration and deadline without starting it. */
export function h06NativeTemporalServices(
  services: Omit<H06TemporalStage, 'profile' | 'openProject' | 'transportEvidenceRoot'>,
  transport: Omit<
    H06NativeTransportOptions,
    'operationId' | 'workspaceRoot' | 'copyRoot' | 'workDeadlineMs'
  >,
): H06TemporalStage {
  const options: H06NativeTransportOptions = {
    ...transport,
    operationId: services.registration.hostId,
    workspaceRoot: services.registration.workspaceRoot,
    copyRoot: join(services.registration.artifactRoot, 'copies'),
    workDeadlineMs: services.workDeadlineMs,
  };
  return {
    ...services,
    client: bindTaskBackendClient(services.client, services.registration),
    profile: options.profile,
    transportEvidenceRoot: options.evidenceRoot,
    openProject: () => openH06NativeTransport(options),
  };
}

export async function withH06TemporalProject<T>(
  services: H06TemporalStage,
  evidence: string,
  run: (transport: Awaited<ReturnType<H06TemporalStage['openProject']>>) => Promise<T>,
) {
  const transportRoot = services.transportEvidenceRoot;
  requireContract(
    transportRoot === undefined || dirname(transportRoot) === evidence,
    'h06-temporal-transport-evidence',
  );
  const transport = await services.openProject();
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    requireContract(
      same(transport.localTasks.profile, services.profile),
      'h06-temporal-transport-profile',
    );
    if (services.controlMode !== undefined) {
      readH06TemporalControlMode(services.controlMode);
      transport.localTasks = { ...transport.localTasks, executionCommandOrigin: 'initial-grant' };
    }
    result = { ok: true, value: await run(transport) };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    await transport.stop();
  } catch (error) {
    if (!result.ok)
      throw new AggregateError([result.error, error], 'h06-temporal-stage-and-stop-failed');
    throw error;
  }
  if (!result.ok) throw result.error;
  return result.value;
}

/** Runs the initial stage inside the authorized operator's existing Temporal connections. */
export async function startH06NativeTemporal<T>(
  binding: H06NativeFailureBinding,
  evidenceRoot: string,
  value: unknown,
  services: H06TemporalStage,
  run: (handle: Awaited<ReturnType<typeof startLocalTask>>, started: H04Pin) => Promise<T>,
) {
  const input = parseLocalTask(value);
  const { preparation } = input.admission;
  const { registration, profile } = services;
  const evidence = safeDirectory(evidenceRoot);
  const hostRoot = join(evidence, 'temporal-host'),
    path = join(evidence, 'temporal-start.json');
  requireContract(
    binding.variant === 'temporal' &&
      input.schemaVersion === 11 &&
      input.continuation.attempt === 0 &&
      preparation.hostId === binding.operationId &&
      registration.workspaceRoot === binding.workspaceRoot &&
      preparation.hostId === registration.hostId &&
      preparation.owner === registration.owner &&
      preparation.owner === services.issuer.owner &&
      preparation.generation === registration.generation &&
      same(preparation.project, registration.project) &&
      safeDirectory(registration.artifactRoot).startsWith(evidence + sep),
    'h06-temporal-start-binding',
  );
  bindTaskBackendClient(services.client, registration);
  requireClientTaskBackend(services.client, preparation);
  identifier(services.taskQueue);
  requireContract(
    Number.isSafeInteger(services.maxTurnStarts) && services.maxTurnStarts > 0,
    'h06-temporal-start-budget',
  );
  const time = () =>
    requireContract(
      Number.isSafeInteger(services.workDeadlineMs) && Date.now() < services.workDeadlineMs,
      'h06-temporal-start-deadline',
    );
  time();
  requireContract(
    Date.now() + binding.timeoutMs < services.workDeadlineMs,
    'h06-temporal-start-deadline',
  );
  requireContract(
    lstatSync(path, { throwIfNoEntry: false }) === undefined &&
      lstatSync(hostRoot, { throwIfNoEntry: false }) === undefined,
    'h06-temporal-start-not-fresh',
  );
  return startH06NativeVariant(binding, evidence, async (initialFailure) => {
    time();
    const store = artifactStore(registration.artifactRoot, { existingOnly: true });
    const authority = h06TemporalControlAuthority(store, services.issuer, services.controlMode);
    createPrivateDirectory(hostRoot);
    return withH06TemporalProject(services, evidence, async ({ rpc, localTasks }) => {
      time();
      const host = await createReaderHost(
        services.connection,
        services.taskQueue,
        services.workflowsPath,
        [{ registration, rpc, localTasks, authority }],
        profile,
        hostRoot,
        services.maxTurnStarts,
      );
      return host.runUntil(async () => {
        time();
        const handle = await services.client.connection.withDeadline(services.workDeadlineMs, () =>
          startLocalTask(services.client, input, services.taskQueue),
        );
        requireContract(handle.workflowId === localTaskKey(input), 'h06-temporal-workflow-binding');
        const bytes = Buffer.from(
          JSON.stringify({
            kind: 'h06-native-temporal-start',
            ...(services.controlMode === undefined ? {} : { controlMode: services.controlMode }),
            operationId: binding.operationId,
            input,
            taskQueue: services.taskQueue,
            hostRoot,
            hostOwner: readH06NativeHostOwner(hostRoot),
            artifactRoot: registration.artifactRoot,
            transportRoot: services.transportEvidenceRoot ?? null,
            workspaceRoot: registration.workspaceRoot,
            workflowsPath: services.workflowsPath,
            profile,
            maxTurnStarts: services.maxTurnStarts,
            workflowId: handle.workflowId,
            firstExecutionRunId: identifier(handle.firstExecutionRunId),
            initialFailure,
          }),
        );
        publishFile(path, bytes);
        time();
        return run(handle, { path, sha256: digest(bytes) });
      });
    });
  });
}

export function readH06NativeHostOwner(hostRoot: string) {
  const owner = object(JSON.parse(readPrivateFile(join(hostRoot, 'host-owner')).toString()));
  const { pid } = owner;
  requireContract(
    typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      pid > 1 &&
      owner.tasks === true &&
      (owner.taskBindings === 2 || owner.taskBindings === 3) &&
      owner.audits === undefined,
    'h06-temporal-host-owner',
  );
  return { pid, id: identifier(owner.id), tasks: true, taskBindings: owner.taskBindings };
}

/** Observe the selected run after PAUSE and keep only a snapshot usable by the RESUME planner. */
export async function captureH06NativePausedStatus(
  client: Client,
  started: H04Pin,
  runId: string,
  pause: ReaderCommandAck,
  commandId: string,
  workDeadlineMs: number,
) {
  const { input, workflowId, evidence, artifactRoot } = readH06NativeTemporalStart(started);
  identifier(runId);
  requireContract(Number.isSafeInteger(pause?.revision), 'h06-temporal-pause-ack');
  requireContract(
    Number.isSafeInteger(workDeadlineMs) && Date.now() < workDeadlineMs,
    'h06-temporal-pause-deadline',
  );
  const result = await client.connection.withDeadline(workDeadlineMs, () =>
    client.workflow.getHandle(workflowId, runId).query<unknown>('localTaskStatus'),
  );
  const observation = { workflowId, runId, query: 'localTaskStatus', result };
  const plan = planH06NativeResumeObservation(artifactRoot, observation, commandId, pause);
  requireContract(same(plan.command.target, taskControlTarget(input)), 'h06-temporal-pause-target');
  requireContract(Date.now() < workDeadlineMs, 'h06-temporal-pause-deadline');
  const bytes = Buffer.from(JSON.stringify(observation));
  const path = join(evidence, `status-paused-${plan.command.expectedRevision}.json`);
  publishFile(path, bytes);
  return { status: { path, sha256: digest(bytes) }, plan };
}

export function readH06NativeTemporalStart(started: H04Pin) {
  const start = object(JSON.parse(readH04Pin(h04Pin(started)).toString()));
  const input = parseLocalTask(start.input);
  const workflowId = localTaskKey(input);
  const evidence = safeDirectory(dirname(started.path));
  const artifactRoot = safeDirectory(text(start.artifactRoot));
  requireContract(
    basename(started.path) === 'temporal-start.json' &&
      start.kind === 'h06-native-temporal-start' &&
      input.schemaVersion === 11 &&
      input.continuation.attempt === 0 &&
      start.operationId === input.admission.preparation.hostId &&
      start.workflowId === workflowId &&
      artifactRoot.startsWith(evidence + sep),
    'h06-temporal-pause-start-binding',
  );
  return { start, input, workflowId, evidence, artifactRoot };
}
