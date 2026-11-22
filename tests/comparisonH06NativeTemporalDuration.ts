import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { defaultPayloadConverter, fromPayloadsAtIndex } from '@temporalio/common';
import { historyFromJSON } from '@temporalio/common/proto-utils';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { canonical } from '../adapters/storage/storeCodec.js';
import { lookupEffect } from '../src/adapters/artifacts/effects.js';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { controlRef, readerCommandText } from '../src/policy/readerControl.js';
import { taskExecutionCommand } from '../src/policy/taskExecution.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { readH06NativeTemporalStart } from './comparisonH06NativeTemporal.js';

// The SDK decodes protobuf history event and retry-state names to their wire enum values.
const eventType = {
  workflowStarted: 1,
  activityScheduled: 10,
  activityStarted: 11,
  activityCompleted: 12,
  activityFailed: 13,
  activityCancelRequested: 15,
  activityCancelled: 16,
};
const nonRetryableFailure = 2;
const cancelRequestedFailure = 7;
type HistoryEvent = NonNullable<ReturnType<typeof historyFromJSON>['events']>[number];

function one<T>(matches: T[], error: string): T {
  requireContract(matches.length === 1, error);
  return matches[0]!;
}

function readJson(bytes: Buffer) {
  return JSON.parse(bytes.toString()) as unknown;
}

function eventId(event: HistoryEvent) {
  return Number(event.eventId);
}

function nanos(event: HistoryEvent): bigint {
  const time = event.eventTime;
  requireContract(time?.seconds != null, 'h06-duration-event-time');
  const seconds = BigInt(time.seconds.toString());
  const fraction = time.nanos ?? 0;
  requireContract(
    seconds >= 0n &&
      seconds <= 253402300799n &&
      Number.isInteger(fraction) &&
      fraction >= 0 &&
      fraction < 1000000000,
    'h06-duration-event-time',
  );
  return seconds * 1000000000n + BigInt(fraction);
}

/** Verify the initial Writer activity's pre-cancellation interval and its retained paused write. */
export function checkH06NativeTemporalDuration(value: unknown) {
  const refs = object(value);
  exactFields(refs, ['claim', 'started', 'history', 'status', 'gateRoot']);
  const { start, input, workflowId, evidence, artifactRoot } = readH06NativeTemporalStart(
    h04Pin(refs.started),
  );
  const runId = identifier(start.firstExecutionRunId);
  const taskQueue = identifier(start.taskQueue);
  const claimPin = h04Pin(refs.claim);
  const historyPin = h04Pin(refs.history);
  const statusPin = h04Pin(refs.status);
  requireContract(
    claimPin.path === join(evidence, 'attempt-claim.json') &&
      dirname(historyPin.path) === evidence &&
      statusPin.path === join(evidence, 'status-paused-1.json'),
    'h06-duration-evidence-root',
  );

  // Qualification may run after integration, when the fresh-workspace preflight no longer applies.
  const claim = object(readJson(readH04Pin(claimPin)));
  const request = object(claim.request);
  const binding = object(request.binding);
  requireContract(
    claim.kind === 'h06-native-attempt-claim' &&
      request.kind === 'comparison-h06-native/2' &&
      claim.requestHash === digest(canonical({ request, assets: claim.assets })) &&
      request.evidenceRoot === evidence &&
      binding.variant === 'temporal' &&
      binding.operationId === start.operationId &&
      binding.workspaceRoot === start.workspaceRoot,
    'h06-duration-claim',
  );
  const { longStageMs, initialLeaseMs } = object(request.stimulus);
  requireContract(
    typeof longStageMs === 'number' &&
      Number.isSafeInteger(longStageMs) &&
      longStageMs > 0 &&
      initialLeaseMs === null,
    'h06-duration-stimulus',
  );

  const history = historyFromJSON(
    readJson(readH04Pin(historyPin)) as Parameters<typeof historyFromJSON>[0],
  );
  const events = history.events!;
  const workflowStart = one(
    events.filter((event) => event.eventType === eventType.workflowStarted),
    'h06-duration-workflow-start',
  ).workflowExecutionStartedEventAttributes;
  requireContract(
    events.every((event, index) => eventId(event) === index + 1) &&
      workflowStart?.workflowType?.name === 'LocalTaskWorkflow' &&
      workflowStart.originalExecutionRunId === runId &&
      workflowStart.taskQueue?.name === taskQueue &&
      same(fromPayloadsAtIndex(defaultPayloadConverter, 0, workflowStart.input?.payloads), input),
    'h06-duration-history-binding',
  );

  const scheduled = events.filter(
    (event) =>
      event.eventType === eventType.activityScheduled &&
      event.activityTaskScheduledEventAttributes?.activityType?.name === 'writeLocalTask',
  );
  const schedule = scheduled[0];
  requireContract(schedule !== undefined, 'h06-duration-write-schedule');
  const write = schedule.activityTaskScheduledEventAttributes!;
  const writeArgs = write.input?.payloads;
  requireContract(
    writeArgs?.length === 2 &&
      write.retryPolicy?.maximumAttempts === 1 &&
      write.taskQueue?.name === taskQueue &&
      same(fromPayloadsAtIndex(defaultPayloadConverter, 0, writeArgs), input),
    'h06-duration-write-binding',
  );
  const snapshot = controlRef(fromPayloadsAtIndex(defaultPayloadConverter, 1, writeArgs));
  const scheduleId = eventId(schedule);
  const activityStart = one(
    events.filter(
      (event) =>
        event.eventType === eventType.activityStarted &&
        Number(event.activityTaskStartedEventAttributes?.scheduledEventId) === scheduleId,
    ),
    'h06-duration-write-start',
  );
  const cancel = one(
    events.filter(
      (event) =>
        event.eventType === eventType.activityCancelRequested &&
        Number(event.activityTaskCancelRequestedEventAttributes?.scheduledEventId) === scheduleId,
    ),
    'h06-duration-cancel-request',
  );
  const terminal = one(
    events.filter(
      (event) =>
        Number(
          event.activityTaskCanceledEventAttributes?.scheduledEventId ??
            event.activityTaskFailedEventAttributes?.scheduledEventId ??
            event.activityTaskCompletedEventAttributes?.scheduledEventId ??
            event.activityTaskTimedOutEventAttributes?.scheduledEventId,
        ) === scheduleId,
    ),
    'h06-duration-write-terminal',
  );
  const cancellation = terminal.activityTaskCanceledEventAttributes;
  const failure = terminal.activityTaskFailedEventAttributes;
  const isCancelled = terminal.eventType === eventType.activityCancelled;
  // The physical stop can interrupt a native turn before the Writer activity handles cancellation.
  requireContract(
    (isCancelled && Number(cancellation?.latestCancelRequestedEventId) === eventId(cancel)) ||
      (terminal.eventType === eventType.activityFailed &&
        (failure?.retryState === nonRetryableFailure ||
          failure?.retryState === cancelRequestedFailure) &&
        failure.failure?.applicationFailureInfo?.type === 'ReaderActivityRejected' &&
        failure.failure.applicationFailureInfo.nonRetryable === true),
    'h06-duration-write-terminal',
  );
  requireContract(
    activityStart.activityTaskStartedEventAttributes?.attempt === 1 &&
      Number(isCancelled ? cancellation!.startedEventId : failure!.startedEventId) ===
        eventId(activityStart) &&
      scheduleId < Math.min(eventId(activityStart), eventId(cancel)) &&
      Math.max(eventId(activityStart), eventId(cancel)) < eventId(terminal),
    'h06-duration-write-events',
  );
  const [scheduledAt, startedAt, canceledAt, finishedAt] = [
    schedule,
    activityStart,
    cancel,
    terminal,
  ].map(nanos) as [bigint, bigint, bigint, bigint];
  requireContract(
    scheduledAt <= startedAt && startedAt <= canceledAt && canceledAt <= finishedAt,
    'h06-duration-event-order',
  );
  const activeNs = canceledAt - startedAt;
  requireContract(activeNs >= BigInt(longStageMs) * 1000000n, 'h06-duration-too-short');

  const store = artifactStore(artifactRoot, { existingOnly: true });
  const artifact = (ref: unknown) => object(readJson(store.read(controlRef(ref))));
  const status = object(readJson(readH04Pin(statusPin)));
  const result = object(status.result);
  const held = controlRef(result.held);
  requireContract(
    status.query === 'localTaskStatus' &&
      status.workflowId === workflowId &&
      status.runId === runId &&
      result.runId === runId &&
      result.phase === 'waiting-human' &&
      result.waiting === true &&
      result.revision === 1 &&
      result.attempt === 0 &&
      result.requirementsRevision === input.admission.preparation.revision &&
      result.stopFailure === '' &&
      result.budgetFailure === '' &&
      result.checkpointFailure === '' &&
      same(result.snapshot, snapshot) &&
      same(result.history, [held]),
    'h06-duration-paused-status',
  );
  const retained = artifact(held);
  const progress = object(retained.progress);
  const stopped = controlRef(retained.stopped);
  const stop = artifact(stopped);
  const prepared = artifact(snapshot);
  requireContract(
    retained.kind === 'task-execution-held' &&
      same(retained.input, input) &&
      progress.phase === 'writing' &&
      same(progress.snapshot, snapshot) &&
      stop.kind === 'task-stopped' &&
      stop.confirmed === true &&
      same(stop.input, input) &&
      prepared.kind === 'substantial-task' &&
      prepared.schemaVersion === 3 &&
      same(prepared.input, input) &&
      object(prepared.source).root === start.workspaceRoot,
    'h06-duration-retained-write',
  );
  const ack = object(retained.command);
  const interruption = artifact(ack.authorization);
  const command = taskExecutionCommand(input, interruption.command, 0);
  requireContract(
    interruption.kind === 'task-execution-interruption' &&
      same(interruption.input, input) &&
      command.action === 'pause' &&
      command.hash === digest(readerCommandText(command)) &&
      ack.commandId === command.commandId &&
      ack.hash === command.hash &&
      ack.revision === 1 &&
      same(result.commands, [ack.authorization]),
    'h06-duration-pause',
  );

  const hold = one(
    events.filter((event) => {
      const attrs = event.activityTaskScheduledEventAttributes;
      return (
        event.eventType === eventType.activityScheduled &&
        attrs?.activityType?.name === 'holdTaskExecution' &&
        same(fromPayloadsAtIndex(defaultPayloadConverter, 0, attrs.input?.payloads), input)
      );
    }),
    'h06-duration-hold-schedule',
  );
  const holdAttrs = hold.activityTaskScheduledEventAttributes!;
  const args = holdAttrs.input?.payloads;
  requireContract(
    eventId(hold) > eventId(terminal) &&
      holdAttrs.taskQueue?.name === taskQueue + '.control' &&
      args?.length === 5 &&
      same(fromPayloadsAtIndex(defaultPayloadConverter, 1, args), progress) &&
      same(fromPayloadsAtIndex(defaultPayloadConverter, 2, args), stopped) &&
      same(fromPayloadsAtIndex(defaultPayloadConverter, 3, args), retained.reason) &&
      same(fromPayloadsAtIndex(defaultPayloadConverter, 4, args), ack),
    'h06-duration-hold-input',
  );
  const heldResult = one(
    events.filter(
      (event) =>
        event.eventType === eventType.activityCompleted &&
        Number(event.activityTaskCompletedEventAttributes?.scheduledEventId) === eventId(hold),
    ),
    'h06-duration-hold-completion',
  );
  requireContract(
    eventId(heldResult) > eventId(hold) &&
      (scheduled.length === 1 || eventId(heldResult) < eventId(scheduled[1]!)) &&
      same(
        fromPayloadsAtIndex(
          defaultPayloadConverter,
          0,
          heldResult.activityTaskCompletedEventAttributes?.result?.payloads,
        ),
        { status: 'held', held },
      ),
    'h06-duration-hold-result',
  );

  const workflowHash = digest(workflowId);
  const gateRoot = safeDirectory(text(refs.gateRoot));
  requireContract(
    basename(gateRoot) === 'execution-attempts' && basename(dirname(gateRoot)) === workflowHash,
    'h06-duration-gate-root',
  );
  const gate = safeDirectory(join(gateRoot, '0'));
  const grant = object(readJson(h01RawFile(join(gate, 'grant.json'))));
  requireContract(
    grant.schemaVersion === 1 &&
      same(grant.input, input) &&
      same(grant.source, prepared.source) &&
      same(grant.profile, start.profile) &&
      grant.artifactRoot === artifactRoot &&
      grant.instance === object(start.hostOwner).id &&
      same(readJson(h01RawFile(join(gate, 'execution-held.json'))), held) &&
      same(readJson(h01RawFile(join(gate, 'snapshot.json'))), snapshot) &&
      same(readJson(h01RawFile(join(gate, 'stopped.json'))), stopped),
    'h06-duration-gate-binding',
  );
  const { projectId, taskId, hostId, workspaceId, owner, generation } = taskControlTarget(input);
  const operationId = 'task-write-' + workflowHash + '-a0';
  const effect = lookupEffect(safeDirectory(join(gate, 'task-effects')), {
    projectId,
    taskId,
    operationId,
    requestHash: digest(JSON.stringify(snapshot)),
    hostId,
    workspaceId,
    owner,
    generation,
  });
  requireContract(effect.status === 'pending', 'h06-duration-pending-write');

  return {
    status: 'LONG_STAGE_VERIFIED',
    workflowId,
    runId,
    attempt: 0,
    operationId,
    scheduledEventId: scheduleId,
    activityStartedEventId: eventId(activityStart),
    cancelRequestedEventId: eventId(cancel),
    terminalEventId: eventId(terminal),
    terminal: isCancelled ? 'cancelled' : 'failed-after-cancel-request',
    held,
    elapsedBeforeCancellationMs: Number(activeNs / 1000000n),
    scheduledToTerminalMs: Number((finishedAt - scheduledAt) / 1000000n),
    minimumMs: longStageMs,
    qualification: false,
    mayRun: false,
  } as const;
}
