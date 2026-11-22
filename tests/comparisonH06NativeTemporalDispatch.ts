import { readdirSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { defaultPayloadConverter, fromPayloadsAtIndex } from '@temporalio/common';
import { historyFromJSON } from '@temporalio/common/proto-utils';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { lookupEffect, type EffectIntent } from '../src/adapters/artifacts/effects.js';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { parseLocalTask } from '../src/policy/localTask.js';
import { controlRef } from '../src/policy/readerControl.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { openH06NativeAttemptTurnLedger } from './comparisonH06NativeAttempt.js';
import { readH06NativeTemporalStart } from './comparisonH06NativeTemporal.js';

const turnOperations = ['profile', 'load', 'implement'] as const;

function readFile(path: string) {
  return JSON.parse(h01RawFile(path).toString()) as unknown;
}

function one<T>(values: readonly T[], failure: string): T {
  requireContract(values.length === 1, failure);
  return values[0]!;
}

function message(turn: Record<string, unknown>) {
  requireContract(Array.isArray(turn.items), 'h06-dispatch-native-message');
  const user = one(
    turn.items.map(object).filter(({ type }) => type === 'userMessage'),
    'h06-dispatch-native-message',
  );
  requireContract(Array.isArray(user.content), 'h06-dispatch-native-message');
  const part = object(one(user.content, 'h06-dispatch-native-message'));
  requireContract(
    part.type === 'text' && typeof part.text === 'string',
    'h06-dispatch-native-message',
  );
  return part.text;
}

/** Reconciles stopped native Writer attempts in one pinned Temporal run history. */
export function checkH06NativeTemporalDispatch(value: unknown) {
  const request = object(value);
  exactFields(request, ['started', 'history', 'claim', 'gateRoot']);
  const {
    start,
    input: initial,
    workflowId,
    evidence,
    artifactRoot,
  } = readH06NativeTemporalStart(h04Pin(request.started));
  const runId = identifier(start.firstExecutionRunId);
  const taskQueue = identifier(start.taskQueue);
  const gateRoot = safeDirectory(text(request.gateRoot));
  const workflowHash = digest(workflowId);
  requireContract(
    basename(gateRoot) === 'execution-attempts' && basename(dirname(gateRoot)) === workflowHash,
    'h06-dispatch-gate-root',
  );
  const claim = h04Pin(request.claim);
  const historyPin = h04Pin(request.history);
  requireContract(
    claim.path === join(evidence, 'attempt-claim.json') && dirname(historyPin.path) === evidence,
    'h06-dispatch-evidence-root',
  );
  const claimBinding = object(
    object(object(JSON.parse(readH04Pin(claim).toString())).request).binding,
  );
  requireContract(
    claimBinding.operationId === start.operationId &&
      claimBinding.workspaceRoot === start.workspaceRoot,
    'h06-dispatch-attempt-claim',
  );
  const ledger = openH06NativeAttemptTurnLedger(claim);
  const recorded = ledger.inspect();
  requireContract(recorded.status === 'RECORDED', 'h06-dispatch-ledger-unknown');
  const writers = recorded.admissions.filter(({ scope }) => scope.role === 'writer');
  const events = historyFromJSON(JSON.parse(readH04Pin(historyPin).toString())).events!;
  const started = one(
    events.filter((event) => event.eventType === 1),
    'h06-dispatch-workflow-start',
  ).workflowExecutionStartedEventAttributes!;
  requireContract(
    events.every((event, index) => String(event.eventId) === String(index + 1)) &&
      started.workflowType?.name === 'LocalTaskWorkflow' &&
      started.originalExecutionRunId === runId &&
      started.taskQueue?.name === taskQueue &&
      same(fromPayloadsAtIndex(defaultPayloadConverter, 0, started.input?.payloads), initial),
    'h06-dispatch-workflow-binding',
  );
  const scheduled = events.filter(
    (event) =>
      event.eventType === 10 &&
      event.activityTaskScheduledEventAttributes?.activityType?.name === 'writeLocalTask',
  );
  requireContract(
    scheduled.length > 0 && writers.length === scheduled.length * turnOperations.length,
    'h06-dispatch-writer-count',
  );
  requireContract(
    same(readdirSync(gateRoot).sort(), scheduled.map((_, attempt) => String(attempt)).sort()),
    'h06-dispatch-gate-attempts',
  );
  const store = artifactStore(artifactRoot, { existingOnly: true });
  const artifact = (ref: unknown) => object(JSON.parse(store.read(controlRef(ref)).toString()));
  const target = taskControlTarget(initial);
  const sessions = new Set<string>();
  const attempts = scheduled.map((event, attempt) => {
    const activity = event.activityTaskScheduledEventAttributes!;
    const args = activity.input?.payloads;
    requireContract(
      args?.length === 2 &&
        activity.retryPolicy?.maximumAttempts === 1 &&
        activity.taskQueue?.name === taskQueue,
      'h06-dispatch-activity-options',
    );
    const input = parseLocalTask(fromPayloadsAtIndex(defaultPayloadConverter, 0, args));
    requireContract(
      input.schemaVersion === 11 &&
        input.continuation.attempt === attempt &&
        same(taskControlTarget(input), target) &&
        (attempt !== 0 || same(input, initial)),
      'h06-dispatch-attempt',
    );
    const snapshotRef = controlRef(fromPayloadsAtIndex(defaultPayloadConverter, 1, args));
    const snapshot = artifact(snapshotRef);
    const source = object(snapshot.source);
    const copy = object(snapshot.copy);
    const copyRoot = join(artifactRoot, 'copies', workflowHash + '-a' + attempt);
    const gate = safeDirectory(join(gateRoot, String(attempt)));
    const grant = object(readFile(join(gate, 'grant.json')));
    requireContract(
      snapshot.kind === 'substantial-task' &&
        snapshot.schemaVersion === 3 &&
        same(snapshot.input, input) &&
        same(snapshot.profile, start.profile) &&
        source.root === start.workspaceRoot &&
        copy.root === copyRoot &&
        grant.schemaVersion === 1 &&
        same(grant.input, input) &&
        same(grant.source, source) &&
        same(grant.profile, start.profile) &&
        grant.artifactRoot === artifactRoot &&
        same(readFile(join(gate, 'snapshot.json')), snapshotRef),
      'h06-dispatch-snapshot',
    );
    const instance = identifier(grant.instance);
    requireContract(
      attempt !== 0 || instance === object(start.hostOwner).id,
      'h06-dispatch-host-instance',
    );
    const stopRef = controlRef(readFile(join(gate, 'writer-stopped.json')));
    const stop = artifact(stopRef);
    const thread = object(object(stop.primary).thread);
    const nativeTurns = thread.turns;
    const session = identifier(thread.id);
    requireContract(
      stop.kind === 'task-writers-stopped' &&
        stop.schemaVersion === 2 &&
        stop.confirmed === true &&
        same(stop.input, input) &&
        same(stop.source, source) &&
        same(stop.copy, copy) &&
        stop.session === session &&
        thread.cwd === copyRoot &&
        !sessions.has(session) &&
        Array.isArray(nativeTurns) &&
        nativeTurns.length === turnOperations.length,
      'h06-dispatch-native-stop',
    );
    sessions.add(session);
    const intent = (operation: string, payload: unknown): EffectIntent => ({
      projectId: target.projectId,
      taskId: target.taskId,
      operationId: 'task-' + operation + '-' + workflowHash + '-a' + attempt,
      requestHash: digest(JSON.stringify(payload)),
      hostId: target.hostId,
      workspaceId: target.workspaceId,
      owner: target.owner,
      generation: target.generation,
    });
    const writerEffects = safeDirectory(join(gate, 'writer-effects'));
    function completed(effect: EffectIntent) {
      const result = lookupEffect(writerEffects, effect);
      requireContract(result.status === 'completed', 'h06-dispatch-writer-effect');
      return artifact(result.receipt);
    }
    requireContract(
      readdirSync(writerEffects).length === 2 * (1 + turnOperations.length),
      'h06-dispatch-effect-count',
    );
    const creation = completed(intent('create', { snapshot }));
    const created = object(creation.raw);
    requireContract(
      creation.kind === 'task-writer-session' &&
        same(creation.input, input) &&
        object(creation.identity).session === session &&
        object(created.thread).id === session &&
        created.cwd === copyRoot,
      'h06-dispatch-session',
    );
    const turns = turnOperations.map((operation, index) => {
      const turn = object(nativeTurns[index]);
      const turnId = identifier(turn.id);
      const body = message(turn);
      const prompt = body.slice(body.indexOf('\n') + 1);
      const effect = intent(operation, { thread: session, prompt });
      const admission = writers[attempt * turnOperations.length + index]!;
      requireContract(
        (operation === 'implement'
          ? ['completed', 'failed', 'interrupted'].includes(String(turn.status))
          : turn.status === 'completed') &&
          body === `Workflow operation: ${effect.operationId}\n${prompt}` &&
          admission.scope.operation === effect.operationId &&
          admission.scope.session === session &&
          admission.scope.root === copyRoot &&
          admission.scope.journal.startsWith(evidence + sep) &&
          admission.scope.messageHash === digest(body) &&
          admission.response?.turnId === turnId,
        'h06-dispatch-turn-binding',
      );
      requireContract(same(completed(effect), { turnId }), 'h06-dispatch-turn-effect');
      return {
        operationId: effect.operationId,
        turnId,
        admission: admission.pin,
        response: admission.response.pin,
      };
    });
    const outer = safeDirectory(join(gate, 'task-effects'));
    const write = lookupEffect(outer, intent('write', snapshotRef));
    const scheduledId = String(event.eventId);
    const later = events.slice(Number(scheduledId));
    const activityStart = one(
      later.filter(
        (item) =>
          item.eventType === 11 &&
          String(item.activityTaskStartedEventAttributes?.scheduledEventId) === scheduledId,
      ),
      'h06-dispatch-activity-started',
    );
    requireContract(
      activityStart.activityTaskStartedEventAttributes?.attempt === 1,
      'h06-dispatch-activity-retry',
    );
    const terminal = one(
      events.slice(Number(String(activityStart.eventId))).filter((item) => {
        const attributes =
          item.activityTaskCompletedEventAttributes ??
          item.activityTaskCanceledEventAttributes ??
          item.activityTaskFailedEventAttributes;
        return (
          attributes != null &&
          [12, 13, 16].some((type) => type === item.eventType) &&
          String(attributes.scheduledEventId) === scheduledId &&
          String(attributes.startedEventId) === String(activityStart.eventId)
        );
      }),
      'h06-dispatch-activity-terminal',
    );
    const completedActivity = terminal.activityTaskCompletedEventAttributes;
    const next = scheduled[attempt + 1];
    requireContract(
      next === undefined || Number(String(terminal.eventId)) < Number(String(next.eventId)),
      'h06-dispatch-activity-overlap',
    );
    if (completedActivity == null) {
      requireContract(
        write.status === 'pending' && readdirSync(outer).length === 1,
        'h06-dispatch-cancelled-effect',
      );
    } else {
      requireContract(
        write.status === 'completed' && readdirSync(outer).length === 2,
        'h06-dispatch-write-effect',
      );
      const result = artifact(write.receipt);
      requireContract(
        same(
          result,
          fromPayloadsAtIndex(defaultPayloadConverter, 0, completedActivity.result?.payloads),
        ) &&
          result.session === session &&
          same(result.stop, stopRef) &&
          same(readFile(join(gate, 'writer-result.json')), write.receipt),
        'h06-dispatch-write-result',
      );
    }
    return { attempt, session, turns };
  });
  requireContract(same(ledger.inspect(), recorded), 'h06-dispatch-ledger-changed');
  return {
    status: 'DISPATCH_CHAIN_VERIFIED' as const,
    workflowId,
    runId,
    attempts,
    qualification: false as const,
    mayRun: false as const,
  };
}
