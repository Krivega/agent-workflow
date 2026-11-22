import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { NativeReaderSource } from '../src/adapters/codex/readerAuthority.js';
import { digest } from '../src/adapters/artifacts/files.js';
import { taskFiles } from '../src/adapters/project/taskFiles.js';
import { taskGateBinding } from '../src/adapters/project/taskGate.js';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import type { H04Pin } from './comparisonH04Contract.js';
import { planH06NativeAttempt } from './comparisonH06NativeAttempt.js';
import {
  captureH06NativePausedStatus,
  readH06NativeTemporalStart,
  type H06TemporalStage,
} from './comparisonH06NativeTemporal.js';
import { checkH06NativeTemporalDuration } from './comparisonH06NativeTemporalDuration.js';
import { checkH06NativeTemporalEvidence } from './comparisonH06NativeTemporalEvidence.js';
import {
  captureH06NativeTemporalHistory,
  replayH06NativeTemporalHistory,
} from './comparisonH06NativeTemporalHistory.js';
import {
  reopenH06NativeTemporalOperator,
  runH06NativeTemporalOperator,
  runH06NativeTemporalServerSetup,
  type H06NativeTemporalOperatorContext,
  type H06NativeTemporalRetainedOpening,
} from './comparisonH06NativeTemporalOperator.js';
import {
  issueH06NativeTemporalPause,
  observeH06NativeTemporalWriterReady,
  pauseH06NativeTemporal,
  planH06NativeTemporalPause,
} from './comparisonH06NativeTemporalPause.js';
import { issueH06NativeTemporalResume } from './comparisonH06NativeTemporalResume.js';
import {
  checkH06NativeTemporalAttemptUsage,
  sealH06NativeUsage,
} from './comparisonH06NativeUsage.js';

import {
  isH06TemporalAutonomousMode,
  readH06TemporalControlMode,
  type H06TemporalControlSource,
} from './comparisonH06TemporalAutonomousControls.js';
import {
  readH06TemporalAutonomousAuthority,
  openH06TemporalAutonomousNativeClaim,
} from './comparisonH06TemporalAutonomousAuthority.js';
import { withH06NativeTemporalServer } from './comparisonH06NativeTemporalServerSetup.js';
import {
  assertH06NativeReaderNotBlocked,
  withH06NativeReaderFailure,
} from './comparisonH06NativeReaderFailure.js';

export interface H06TemporalCommandChat {
  source(text: string, signal: AbortSignal): Promise<NativeReaderSource>;
  record(notice: string, source: NativeReaderSource, signal: AbortSignal): Promise<void>;
}

type Paused = Awaited<ReturnType<typeof pauseStage>>;
type Phase = 'warm' | 'cold';

function pin(path: string): H04Pin {
  return { path, sha256: digest(h01RawFile(path)) };
}

function deadline(signal: AbortSignal, limit: number) {
  const remaining = limit - Date.now();
  requireContract(remaining > 0, 'h06-temporal-driver-deadline');
  return AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
}

function activeRun(client: H06TemporalStage['client'], started: H04Pin) {
  const { start, workflowId } = readH06NativeTemporalStart(started);
  const runId = identifier(start.firstExecutionRunId);
  return { runId, handle: client.workflow.getHandle(workflowId, runId, { followRuns: false }) };
}

async function pauseStage(
  started: H04Pin,
  phase: Phase,
  minimumWritingMs: number,
  context: H06NativeTemporalOperatorContext,
  chat: H06TemporalCommandChat,
  signal: AbortSignal,
) {
  const { client, issuer, workDeadlineMs } = context;
  const { handle, runId } = activeRun(client, started);
  const query = async () => {
    signal.throwIfAborted();
    const status = object(
      await client.connection.withDeadline(workDeadlineMs, () =>
        handle.query<unknown>('localTaskStatus'),
      ),
    );
    requireContract(status.runId === runId, 'h06-temporal-driver-run');
    return status;
  };
  let writingSince: number | undefined;
  for (;;) {
    if (context.controlMode !== undefined)
      await assertH06NativeReaderNotBlocked(client, started, runId, workDeadlineMs, signal);
    const status = await query();
    requireContract(
      status.waiting === false &&
        ['admitting', 'planning', 'preparing', 'baseline', 'writing'].includes(
          String(status.phase),
        ),
      'h06-temporal-driver-writing-unavailable',
    );
    if (status.phase === 'writing') {
      const ready =
        context.controlMode === undefined ||
        (await observeH06NativeTemporalWriterReady(client, started, runId, workDeadlineMs));
      if (ready) {
        writingSince ??= performance.now();
        if (performance.now() - writingSince >= minimumWritingMs) break;
      } else requireContract(writingSince === undefined, 'h06-temporal-driver-writer-ended');
    } else requireContract(writingSince === undefined, 'h06-temporal-driver-writing-ended');
    await wait(150, undefined, { signal });
  }
  const request = {
    started,
    runId,
    commandId: `h06-${phase}-pause`,
    reason: `H06/2: preserve the pending Writer for ${phase} recovery`,
  };
  const proposal = await planH06NativeTemporalPause(client, request, workDeadlineMs);
  const source: H06TemporalControlSource =
    context.controlMode === undefined
      ? await chat.source(proposal.authorizationText, signal)
      : {
          kind: 'h06-temporal-autonomous-phase/3',
          mode: context.controlMode,
          started,
          runId,
          phase: `${phase}-pause`,
        };
  signal.throwIfAborted();
  const issued = await issueH06NativeTemporalPause(client, request, issuer, source, workDeadlineMs);
  if (source.kind === 'codex-user-command') await chat.record(issued.notice, source, signal);
  signal.throwIfAborted();
  const pause = await pauseH06NativeTemporal(
    client,
    started,
    runId,
    issued.command,
    issuer,
    workDeadlineMs,
  );
  for (;;) {
    const status = await query();
    requireContract(
      status.stopFailure === '' && !['done', 'cancelled'].includes(String(status.phase)),
      'h06-temporal-driver-stop-unconfirmed',
    );
    if (status.phase === 'waiting-human' && status.waiting === true && status.held !== null) break;
    await wait(150, undefined, { signal });
  }
  const commandId = `h06-${phase}-resume`;
  const captured = await captureH06NativePausedStatus(
    client,
    started,
    runId,
    pause.ack,
    commandId,
    workDeadlineMs,
  );
  return {
    pauseAck: pause.receipt,
    resume: { started, status: captured.status, commandId },
    authorizationText: captured.plan.authorizationText,
    issuer,
    workDeadlineMs,
    runId,
    controlMode: context.controlMode,
  };
}

function stoppedUsage(claim: H04Pin, phases: readonly string[]) {
  const stops = phases.map((phase) =>
    pin(join(dirname(claim.path), `transport-${phase}`, 'transport-stop.json')),
  );
  const { binding } = checkH06NativeTemporalAttemptUsage({ claim, stops, participants: [] });
  return { stops, participants: binding.participants.map(sealH06NativeUsage) };
}

async function authorizeResume(paused: Paused, chat: H06TemporalCommandChat, signal: AbortSignal) {
  const live = deadline(signal, paused.workDeadlineMs);
  const source: H06TemporalControlSource =
    paused.controlMode === undefined
      ? await chat.source(paused.authorizationText, live)
      : {
          kind: 'h06-temporal-autonomous-phase/3',
          mode: paused.controlMode,
          started: paused.resume.started,
          runId: paused.runId,
          phase: paused.resume.commandId === 'h06-warm-resume' ? 'warm-resume' : 'cold-resume',
        };
  live.throwIfAborted();
  const issued = await issueH06NativeTemporalResume(paused.resume, paused.issuer, source);
  if (source.kind === 'codex-user-command') await chat.record(issued.notice, source, live);
  live.throwIfAborted();
  return issued.command;
}

type InitialWorkerInput = {
  attempt: unknown;
  authority: unknown;
  server: H04Pin;
};

/** Execute both stages in one Worker process. The supervisor waits for its exit before cold reopen. */
export async function runH06NativeTemporalInitialAndWarm(
  input: InitialWorkerInput,
  chat: H06TemporalCommandChat,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { request } = isH06TemporalAutonomousMode(input.authority)
    ? openH06TemporalAutonomousNativeClaim(readH06TemporalControlMode(input.authority).authority)
    : planH06NativeAttempt(input.attempt);
  const { writer: initial } = await runH06NativeTemporalOperator(
    input.attempt,
    input.authority,
    input.server,
    async (_handle, started, stageSignal, context) => {
      const live = AbortSignal.any([signal, stageSignal]);
      const paused = await pauseStage(
        started,
        'warm',
        request.stimulus.longStageMs,
        context,
        chat,
        live,
      );
      live.throwIfAborted();
      const history = await captureH06NativeTemporalHistory(
        context.client,
        started,
        'initial-paused',
        context.workDeadlineMs,
      );
      return { paused, history };
    },
  );
  const { started } = initial.paused.resume;
  const claim = pin(join(request.evidenceRoot, 'attempt-claim.json'));
  const start = readH06NativeTemporalStart(started);
  const gateRoot = dirname(
    taskGateBinding(
      start.input,
      taskFiles(start.artifactRoot, { existingOnly: true }).binding(request.binding.workspaceRoot),
      start.start.profile as H06TemporalStage['profile'],
      start.artifactRoot,
      identifier(object(start.start.hostOwner).id),
    ).directory,
  );
  const duration = checkH06NativeTemporalDuration({
    claim,
    started,
    history: initial.history,
    status: initial.paused.resume.status,
    gateRoot,
  });
  const firstUsage = stoppedUsage(claim, ['initial']);
  const warmCommand = await authorizeResume(initial.paused, chat, signal);
  const warm = await reopenH06NativeTemporalOperator(
    {
      claim,
      server: input.server,
      resume: initial.paused.resume,
      opening: { phase: 'warm' },
      command: warmCommand,
      ...firstUsage,
      ...(initial.paused.controlMode === undefined
        ? {}
        : { controlMode: initial.paused.controlMode }),
    },
    async (resume, host, stageSignal, context) => ({
      warm: {
        pauseAck: initial.paused.pauseAck,
        status: initial.paused.resume.status,
        host,
        resumeAck: resume.receipt,
      },
      paused: await pauseStage(
        started,
        'cold',
        0,
        context,
        chat,
        AbortSignal.any([signal, stageSignal]),
      ),
    }),
  );
  requireContract('warm' in warm, 'h06-temporal-driver-warm-outcome-retained');
  const usage = stoppedUsage(claim, ['initial', 'warm']);
  const command = await authorizeResume(warm.paused, chat, signal);
  const cold: H06NativeTemporalRetainedOpening = {
    claim,
    server: input.server,
    resume: warm.paused.resume,
    opening: { phase: 'cold', warm: warm.warm.host, readers: [], tasks: [start.input] },
    command,
    ...usage,
    ...(warm.paused.controlMode === undefined ? {} : { controlMode: warm.paused.controlMode }),
  };
  return { claim, started, warm: warm.warm, cold, coldPauseAck: warm.paused.pauseAck, duration };
}

type InitialAndWarm = Awaited<ReturnType<typeof runH06NativeTemporalInitialAndWarm>>;

/** Execute only in the new process after the initial/warm process has stopped. */
export async function runH06NativeTemporalCold(initial: InitialAndWarm, signal: AbortSignal) {
  signal.throwIfAborted();
  const cold = await reopenH06NativeTemporalOperator(
    initial.cold,
    async (resume, host, stageSignal, { client, workDeadlineMs, controlMode }) => {
      const live = AbortSignal.any([signal, stageSignal]);
      const { handle, runId } = activeRun(client, initial.started);
      live.throwIfAborted();
      const complete = () => client.connection.withDeadline(workDeadlineMs, () => handle.result());
      const result: unknown =
        controlMode === undefined
          ? await complete()
          : await withH06NativeReaderFailure(
              client,
              initial.started,
              runId,
              workDeadlineMs,
              live,
              complete,
            );
      requireContract(object(result).status === 'done', 'h06-temporal-driver-result');
      live.throwIfAborted();
      const history = await captureH06NativeTemporalHistory(
        client,
        initial.started,
        'complete',
        workDeadlineMs,
      );
      return {
        cold: {
          pauseAck: initial.coldPauseAck,
          status: initial.cold.resume.status,
          host,
          resumeAck: resume.receipt,
        },
        result,
        history,
      };
    },
  );
  requireContract('cold' in cold, 'h06-temporal-driver-cold-outcome-retained');
  return cold;
}

export interface H06TemporalWorkerProcesses {
  initialAndWarm(input: InitialWorkerInput, signal: AbortSignal): Promise<InitialAndWarm>;
  cold(
    input: InitialAndWarm,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof runH06NativeTemporalCold>>>;
}

/** The supervisor owns the server. Both Worker process ports resolve only after process exit. */
export async function runH06NativeTemporalDriver(
  attempt: unknown,
  serverBudget: unknown,
  grants: { attempt(signal: AbortSignal): Promise<unknown>; server: unknown },
  workers: H06TemporalWorkerProcesses,
  signal?: AbortSignal,
) {
  const owned = await runH06NativeTemporalServerSetup(
    attempt,
    serverBudget,
    grants.server,
    async (server, signal) => {
      const authority = await grants.attempt(signal);
      signal.throwIfAborted();
      const initial = await workers.initialAndWarm({ attempt, authority, server }, signal);
      signal.throwIfAborted();
      const cold = await workers.cold(initial, signal);
      signal.throwIfAborted();
      const evidence = checkH06NativeTemporalEvidence({
        started: initial.started,
        warm: initial.warm,
        cold: cold.cold,
      });
      return { initial, cold, evidence };
    },
    signal,
  );
  signal?.throwIfAborted();
  const { initial, cold, evidence } = owned.result;
  const replay = await replayH06NativeTemporalHistory({
    started: initial.started,
    claim: initial.claim,
    history: cold.history,
  });
  const usage = checkH06NativeTemporalAttemptUsage({
    claim: initial.claim,
    ...stoppedUsage(initial.claim, ['initial', 'warm', 'cold']),
  });
  return {
    server: { ready: owned.ready, stopped: owned.stopped },
    evidence,
    duration: initial.duration,
    result: cold.result,
    replay,
    usage,
    qualification: false,
  } as const;
}

/** Reuse the already consumed parent clock; server and both Worker processes share its stop bound. */
export async function runH06TemporalAutonomousDriver(
  authorityPin: H04Pin,
  workers: H06TemporalWorkerProcesses,
  signal?: AbortSignal,
) {
  const parent = readH06TemporalAutonomousAuthority(authorityPin);
  requireContract(Date.now() < parent.workDeadlineMs, 'h06-temporal-driver-deadline');
  const mode = { kind: 'temporal-autonomous/3', authority: parent.receipt } as const;
  const owned = await withH06NativeTemporalServer(
    {
      expected: parent.server.expected,
      deadlineMs: parent.stopDeadlineMs,
      stopReserveMs: parent.budget.reserveMs,
      ...(signal === undefined ? {} : { signal }),
    },
    async (server, signal) => {
      signal.throwIfAborted();
      const initial = await workers.initialAndWarm(
        { attempt: { ...parent.request }, authority: mode, server },
        signal,
      );
      requireContract(
        initial.claim.path === parent.nativeClaim.path &&
          initial.claim.sha256 === parent.nativeClaim.sha256,
        'h06-temporal-driver-autonomous-claim',
      );
      const warmStop = pin(join(dirname(server.path), 'worker-initial-and-warm-outcome.json'));
      signal.throwIfAborted();
      const cold = await workers.cold(initial, signal);
      signal.throwIfAborted();
      const coldStop = pin(join(dirname(server.path), 'worker-cold-outcome.json'));
      const evidence = checkH06NativeTemporalEvidence({
        started: initial.started,
        warm: initial.warm,
        cold: cold.cold,
      });
      return { initial, cold, evidence, workerStops: [warmStop, coldStop] };
    },
  );
  signal?.throwIfAborted();
  const { initial, cold, evidence, workerStops } = owned.result;
  const beforeStopDeadline = () => Date.now() < parent.stopDeadlineMs;
  const replay = beforeStopDeadline()
    ? await replayH06NativeTemporalHistory({
        started: initial.started,
        claim: initial.claim,
        history: cold.history,
      })
    : { status: 'UNKNOWN_PARENT_DEADLINE' as const };
  const usageSources = beforeStopDeadline()
    ? stoppedUsage(initial.claim, ['initial', 'warm', 'cold'])
    : null;
  const usage =
    usageSources !== null
      ? checkH06NativeTemporalAttemptUsage({ claim: initial.claim, ...usageSources })
      : { status: 'UNKNOWN_PARENT_DEADLINE' as const };
  const timely = beforeStopDeadline();
  const status =
    usage.status === 'OVER_BUDGET'
      ? 'FAIL'
      : timely &&
          evidence.status === 'CHAIN_VERIFIED' &&
          replay.status === 'REPLAY_VERIFIED' &&
          usage.status === 'WITHIN_BUDGET'
        ? 'PASS'
        : 'UNKNOWN';
  return {
    acceptance: {
      profile: 'h06-autonomous-recovery/3',
      status,
      humanControl: 'NOT_EVALUATED',
      wholeAttemptComplete: false,
      externalUsage: 'UNKNOWN',
      qualification: false,
    },
    server: { ready: owned.ready, stopped: owned.stopped },
    evidence,
    duration: initial.duration,
    result: cold.result,
    replay,
    usage,
    finalization: timely ? 'WITHIN_PARENT_DEADLINE' : 'UNKNOWN_PARENT_DEADLINE',
    primary: {
      authority: parent.receipt,
      started: initial.started,
      warm: initial.warm,
      cold: cold.cold,
      history: cold.history,
      workerStops,
      transportStops: usageSources?.stops ?? null,
      participants: usageSources?.participants ?? null,
    },
    acceptanceProfile: 'h06-autonomous-recovery/3',
    humanControl: 'NOT_EVALUATED',
    qualification: false,
  } as const;
}
