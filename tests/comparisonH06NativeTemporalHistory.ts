import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { Client } from '@temporalio/client';
import { defaultPayloadConverter, fromPayloadsAtIndex } from '@temporalio/common';
import { historyFromJSON, historyToJSON, type History } from '@temporalio/common/proto-utils';
import { Worker } from '@temporalio/worker';
import { canonical } from '../adapters/storage/storeCodec.js';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { parseLocalTask } from '../src/policy/localTask.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { readH06NativeTemporalStart } from './comparisonH06NativeTemporal.js';

function temporalExecution(started: H04Pin) {
  const execution = readH06NativeTemporalStart(started);
  return {
    ...execution,
    runId: identifier(execution.start.firstExecutionRunId),
    taskQueue: identifier(execution.start.taskQueue),
  };
}

type Execution = ReturnType<typeof temporalExecution>;

function checkHistory(history: History, execution: Execution) {
  const { events } = history;
  requireContract(Array.isArray(events) && events.length > 0, 'h06-history-empty');
  requireContract(
    events.every((event, index) => String(event.eventId) === String(index + 1)),
    'h06-history-event-order',
  );
  const starts = events.filter(({ eventType }) => eventType === 1);
  requireContract(starts.length === 1 && starts[0] === events[0], 'h06-history-start');
  const start = starts[0]!.workflowExecutionStartedEventAttributes;
  requireContract(
    start?.originalExecutionRunId === execution.runId &&
      start.workflowType?.name === 'LocalTaskWorkflow' &&
      start.taskQueue?.name === execution.taskQueue &&
      same(fromPayloadsAtIndex(defaultPayloadConverter, 0, start.input?.payloads), execution.input),
    'h06-history-execution',
  );
  return events.length;
}

/** Capture a stable prefix from the exact run using the SDK's portable proto3 JSON. */
export async function captureH06NativeTemporalHistory(
  client: Pick<Client, 'workflow' | 'connection'>,
  started: H04Pin,
  label: string,
  deadline: number,
): Promise<H04Pin> {
  const execution = temporalExecution(started);
  const { workflowId, runId, taskQueue, evidence } = execution;
  const path = join(evidence, `history-${identifier(label)}.json`);
  const time = () =>
    requireContract(
      Number.isSafeInteger(deadline) && Date.now() < deadline,
      'h06-history-deadline',
    );
  time();
  const handle = client.workflow.getHandle(workflowId, runId);
  const history = await client.connection.withDeadline(deadline, async () => {
    async function count() {
      const described = await handle.describe();
      requireContract(
        described.workflowId === workflowId &&
          described.runId === runId &&
          described.type === 'LocalTaskWorkflow' &&
          described.taskQueue === taskQueue,
        'h06-history-description',
      );
      return described.historyLength;
    }
    const before = await count();
    const observed = await handle.fetchHistory();
    const length = checkHistory(observed, execution);
    const after = await count();
    requireContract(before === length && after === length, 'h06-history-incomplete-or-changed');
    return observed;
  });
  const bytes = Buffer.from(historyToJSON(history));
  readH04Pin(started);
  time();
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

/** Replay only the pinned workflow source and captured run, without acquiring a live connection. */
export async function replayH06NativeTemporalHistory(value: unknown) {
  const input = object(value);
  exactFields(input, ['started', 'claim', 'history']);
  const started = h04Pin(input.started);
  const claim = h04Pin(input.claim);
  const historyPin = h04Pin(input.history);
  const execution = temporalExecution(started);
  const { evidence, start, workflowId, runId, taskQueue } = execution;
  requireContract(
    claim.path === join(evidence, 'attempt-claim.json') &&
      dirname(historyPin.path) === evidence &&
      /^history-[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(basename(historyPin.path)),
    'h06-history-replay-root',
  );
  const saved = object(JSON.parse(readH04Pin(claim).toString()));
  const request = object(saved.request);
  const binding = object(request.binding);
  requireContract(
    saved.kind === 'h06-native-attempt-claim' &&
      saved.requestHash === digest(canonical({ request, assets: saved.assets })) &&
      request.kind === 'comparison-h06-native/2' &&
      request.evidenceRoot === evidence &&
      binding.variant === 'temporal' &&
      binding.operationId === start.operationId &&
      binding.workspaceRoot === start.workspaceRoot,
    'h06-history-replay-claim',
  );
  const bootstrap = h04Pin(request.bootstrap);
  const descriptor = object(JSON.parse(readH04Pin(bootstrap).toString()));
  const workflows = h04Pin(descriptor.workflows);
  requireContract(
    descriptor.kind === 'comparison-h06-native-temporal-bootstrap/2' &&
      descriptor.taskQueue === taskQueue &&
      same(parseLocalTask(descriptor.input), execution.input) &&
      workflows.path === start.workflowsPath &&
      Array.isArray(request.runtime) &&
      request.runtime.some((pin) => same(pin, workflows)),
    'h06-history-replay-bootstrap',
  );
  const pins = [started, claim, historyPin, bootstrap, ...request.runtime.map(h04Pin)];
  const history = historyFromJSON(JSON.parse(readH04Pin(historyPin).toString()));
  const eventCount = checkHistory(history, execution);
  for (const pin of pins) readH04Pin(pin);
  await Worker.runReplayHistory({ workflowsPath: workflows.path }, history, workflowId);
  for (const pin of pins) readH04Pin(pin);
  return {
    status: 'REPLAY_VERIFIED',
    qualification: false,
    workflowId,
    runId,
    eventCount,
    history: historyPin,
  } as const;
}
