import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPayloadConverter } from '@temporalio/common';
import { payloadToJSON } from '@temporalio/common/proto-utils';
import { afterEach, expect, it } from 'vitest';
import { canonical } from '../adapters/storage/storeCodec.js';
import { effectJournal } from '../src/adapters/artifacts/effects.js';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import { makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import { localTaskKey, parseLocalTask } from '../src/policy/localTask.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { checkH06NativeTemporalDuration } from './comparisonH06NativeTemporalDuration.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function payload(...values: unknown[]) {
  return {
    payloads: values.map((value) => payloadToJSON(defaultPayloadConverter.toPayload(value)!)),
  };
}

function stamp(milliseconds: number) {
  return new Date(Date.UTC(2026, 10, 4) + milliseconds).toISOString();
}

async function fixture(
  bad?: string,
  laterAttempt = false,
  delayedStartEvent = true,
  cancelRequestedFailure = false,
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-duration-'));
  roots.push(root);
  const operationId = 'h06-operation';
  const evidence = join(root, operationId);
  const workspaceRoot = join(root, 'source');
  const artifactRoot = join(evidence, 'runtime');
  const store = artifactStore(artifactRoot);
  const save = (value: unknown) => store.publish(Buffer.from(JSON.stringify(value)));
  const write = (path: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const input = parseLocalTask({
    schemaVersion: 11,
    admission: {
      schemaVersion: 3,
      preparation: {
        schemaVersion: 1,
        project: {
          schemaVersion: 1,
          projectId: 'h06',
          workspaceId: 'workspace',
          rules: ['RULES.md'],
          cardRoot: 'tasks',
          roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
          checks: ['syntax', 'validate'],
        },
        taskId: 'task',
        hostId: operationId,
        owner: 'task-owner',
        generation: 4,
        revision: 2,
        card: 'tasks/task.md',
      },
      plan: { path: 'plan.json', sha256: digest('plan') },
      planning: save({ kind: 'planning' }),
      acceptance: save({ kind: 'acceptance' }),
    },
    executor: { path: 'executor.md', sha256: digest('executor') },
    baseline: 'syntax',
    continuation: { attempt: 0, previous: null },
  });
  if (input.schemaVersion !== 11) throw new Error('fixture-input');
  const target = taskControlTarget(input);
  const workflowId = localTaskKey(input);
  const workflowHash = digest(workflowId);
  const runId = 'run-1';
  const taskQueue = 'h06-queue';
  const profile = { model: 'gpt-6-astra', effort: 'medium', clientVersion: '0.154.0' };
  const started = write(join(evidence, 'temporal-start.json'), {
    kind: 'h06-native-temporal-start',
    operationId,
    input,
    hostOwner: { id: 'owner-0' },
    artifactRoot,
    workspaceRoot,
    profile,
    workflowId,
    taskQueue,
    firstExecutionRunId: runId,
  });
  const request = {
    kind: bad === 'request-kind' ? 'other' : 'comparison-h06-native/2',
    binding: {
      operationId: bad === 'operation' ? 'foreign' : operationId,
      variant: bad === 'claim-variant' ? 'legacy' : 'temporal',
      workspaceRoot: bad === 'claim-workspace' ? '/foreign' : workspaceRoot,
    },
    evidenceRoot: bad === 'claim-root' ? '/foreign' : evidence,
    stimulus: {
      longStageMs:
        bad === 'stimulus-type'
          ? '35000'
          : bad === 'stimulus-fraction'
            ? 1.5
            : bad === 'stimulus-zero'
              ? 0
              : 35000,
      initialLeaseMs: bad === 'stimulus-lease' ? 20 : null,
    },
  };
  const assets = {};
  const claim = write(
    join(evidence, bad === 'claim-path' ? 'foreign.json' : 'attempt-claim.json'),
    {
      kind: bad === 'claim-kind' ? 'other' : 'h06-native-attempt-claim',
      request,
      assets,
      requestHash:
        bad === 'claim-hash' ? digest('foreign') : digest(canonical({ request, assets })),
    },
  );
  const gateRoot = join(
    root,
    'tasks',
    bad === 'gate-workflow' ? 'foreign' : workflowHash,
    bad === 'gate-path' ? 'foreign' : 'execution-attempts',
  );
  const gate = join(gateRoot, '0');
  mkdirSync(gate, { recursive: true });
  const source = { root: bad === 'source' ? '/foreign' : workspaceRoot, dev: '1', ino: '2' };
  const snapshot = save({
    kind: bad === 'snapshot-kind' ? 'other' : 'substantial-task',
    schemaVersion: bad === 'snapshot-version' ? 2 : 3,
    input: bad === 'snapshot-input' ? null : input,
    source,
    profile,
  });
  const progress = {
    phase: bad === 'progress-phase' ? 'preparing' : 'writing',
    snapshot: bad === 'progress-snapshot' ? null : snapshot,
    planning: null,
    records: [snapshot],
  };
  const stopped = save({
    kind: bad === 'stopped-kind' ? 'other' : 'task-stopped',
    confirmed: bad !== 'stopped-unconfirmed',
    input: bad === 'stopped-input' ? null : input,
  });
  const pause = makeTaskExecutionCommand({
    schemaVersion: 2,
    commandId: 'pause',
    target,
    expectedRevision: 0,
    author: target.owner,
    action: bad === 'not-pause' ? 'cancel' : 'pause',
    attempt: 0,
    payload: save({ schemaVersion: 1, kind: 'task-interruption', reason: 'long-stage-check' }),
    source: save({ kind: 'source' }),
  });
  const command = bad === 'command-hash' ? { ...pause, hash: digest('foreign') } : pause;
  const interruption = save({
    kind: bad === 'interrupt-kind' ? 'other' : 'task-execution-interruption',
    input: bad === 'interrupt-input' ? null : input,
    command,
  });
  const ack = {
    commandId: bad === 'ack-id' ? 'foreign' : command.commandId,
    hash: bad === 'ack-hash' ? digest('foreign') : command.hash,
    revision: bad === 'ack-revision' ? 2 : 1,
    authorization: interruption,
  };
  const reason = 'paused';
  const held = save({
    kind: bad === 'held-kind' ? 'other' : 'task-execution-held',
    input: bad === 'held-input' ? null : input,
    progress,
    stopped,
    reason,
    command: ack,
  });
  const status = write(
    join(evidence, bad === 'status-path' ? 'foreign-status.json' : 'status-paused-1.json'),
    {
      workflowId: bad === 'status-workflow' ? 'foreign' : workflowId,
      runId: bad === 'status-run' ? 'foreign' : runId,
      query: bad === 'status-query' ? 'other' : 'localTaskStatus',
      result: {
        runId: bad === 'result-run' ? 'foreign' : runId,
        phase: bad === 'status-phase' ? 'writing' : 'waiting-human',
        waiting: bad !== 'status-waiting',
        revision: bad === 'status-revision' ? 2 : 1,
        attempt: bad === 'status-attempt' ? 1 : 0,
        requirementsRevision: bad === 'status-requirements' ? 3 : 2,
        stopFailure: bad === 'stop-failure' ? 'failed' : '',
        budgetFailure: bad === 'budget-failure' ? 'failed' : '',
        checkpointFailure: bad === 'checkpoint-failure' ? 'failed' : '',
        snapshot: bad === 'status-snapshot' ? null : snapshot,
        history: bad === 'status-history' ? [] : [held],
        held,
        commands: bad === 'status-commands' ? [] : [interruption],
      },
    },
  );
  const events: Record<string, unknown>[] = [];
  const add = (eventType: string, key: string, body: object, eventTime?: string) => {
    const id = String(events.length + 1);
    events.push({ eventId: id, eventType: 'EVENT_TYPE_' + eventType, eventTime, [key]: body });
    return id;
  };
  if (bad !== 'workflow-absent')
    add(
      'WORKFLOW_EXECUTION_STARTED',
      'workflowExecutionStartedEventAttributes',
      {
        workflowType: { name: bad === 'workflow-type' ? 'ForeignWorkflow' : 'LocalTaskWorkflow' },
        originalExecutionRunId: bad === 'history-run' ? 'foreign' : runId,
        ...(bad === 'history-queue-absent'
          ? {}
          : { taskQueue: { name: bad === 'history-queue' ? 'foreign' : taskQueue } }),
        input: payload(bad === 'history-input' ? null : input),
      },
      stamp(0),
    );
  const writeArgs =
    bad === 'write-args' ? [input] : [bad === 'write-input' ? null : input, snapshot];
  const schedule = add(
    'ACTIVITY_TASK_SCHEDULED',
    'activityTaskScheduledEventAttributes',
    {
      activityType: { name: bad === 'write-absent' ? 'other' : 'writeLocalTask' },
      ...(bad === 'write-no-input' ? {} : { input: payload(...writeArgs) }),
      ...(bad === 'write-no-queue'
        ? {}
        : { taskQueue: { name: bad === 'write-queue' ? 'foreign' : taskQueue } }),
      ...(bad === 'write-no-retry'
        ? {}
        : { retryPolicy: { maximumAttempts: bad === 'write-retry' ? 2 : 1 } }),
    },
    bad === 'schedule-time-absent' ? undefined : stamp(bad === 'queue-time-reversed' ? 8000 : 1000),
  );
  const addStart = () =>
    add(
      'ACTIVITY_TASK_STARTED',
      'activityTaskStartedEventAttributes',
      {
        scheduledEventId: bad === 'activity-foreign' ? '999' : schedule,
        attempt: bad === 'activity-retried' ? 2 : 1,
      },
      bad === 'start-time-negative' ? '1969-12-31T23:59:59.999Z' : stamp(7000),
    );
  const startFirst = delayedStartEvent ? null : addStart();
  const cancel =
    bad === 'cancel-absent'
      ? undefined
      : add(
          'ACTIVITY_TASK_CANCEL_REQUESTED',
          'activityTaskCancelRequestedEventAttributes',
          {
            scheduledEventId: bad === 'cancel-foreign' ? '999' : schedule,
          },
          bad === 'nanos-short'
            ? stamp(41999).replace('999Z', '999999999Z')
            : stamp(
                bad === 'duration-short' ? 41000 : bad === 'active-time-reversed' ? 6000 : 42000,
              ),
        );
  const activityStart = startFirst ?? addStart();
  const cancelledAttrs = {
    scheduledEventId: bad === 'terminal-foreign' ? '999' : schedule,
    startedEventId: bad === 'terminal-start' ? '999' : activityStart,
    latestCancelRequestedEventId: bad === 'terminal-cancel' ? '999' : cancel,
  };
  function addTerminal() {
    const time = stamp(bad === 'cleanup-time-reversed' ? 41000 : 59000);
    if (bad?.startsWith('failure-') || cancelRequestedFailure) {
      return add(
        'ACTIVITY_TASK_FAILED',
        'activityTaskFailedEventAttributes',
        {
          scheduledEventId: schedule,
          startedEventId: activityStart,
          retryState:
            bad === 'failure-retry'
              ? 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED'
              : cancelRequestedFailure
                ? 'RETRY_STATE_CANCEL_REQUESTED'
                : 'RETRY_STATE_NON_RETRYABLE_FAILURE',
          ...(bad === 'failure-missing'
            ? {}
            : {
                failure: {
                  message: 'Error: task-turn-unconfirmed',
                  ...(bad === 'failure-no-application-info'
                    ? {}
                    : {
                        applicationFailureInfo: {
                          type: bad === 'failure-wrong-type' ? 'other' : 'ReaderActivityRejected',
                          nonRetryable: bad !== 'failure-retryable',
                        },
                      }),
                },
              }),
        },
        time,
      );
    }
    if (bad === 'terminal-timed-out')
      return add(
        'ACTIVITY_TASK_TIMED_OUT',
        'activityTaskTimedOutEventAttributes',
        {
          scheduledEventId: schedule,
          startedEventId: activityStart,
        },
        time,
      );
    if (bad === 'terminal-success')
      return add(
        'ACTIVITY_TASK_COMPLETED',
        'activityTaskCompletedEventAttributes',
        {
          scheduledEventId: schedule,
          startedEventId: activityStart,
        },
        time,
      );
    if (bad === 'terminal-cancel-with-failed-attributes')
      return add(
        'ACTIVITY_TASK_CANCELED',
        'activityTaskFailedEventAttributes',
        cancelledAttrs,
        time,
      );
    return add(
      'ACTIVITY_TASK_CANCELED',
      'activityTaskCanceledEventAttributes',
      cancelledAttrs,
      time,
    );
  }
  if (bad !== 'hold-too-early') addTerminal();
  const holdArgs = [
    bad === 'hold-task' ? null : input,
    bad === 'hold-progress' ? null : progress,
    bad === 'hold-stop' ? null : stopped,
    bad === 'hold-reason' ? 'foreign' : reason,
    bad === 'hold-ack' ? null : ack,
  ];
  const hold = add(
    'ACTIVITY_TASK_SCHEDULED',
    'activityTaskScheduledEventAttributes',
    {
      activityType: { name: bad === 'hold-absent' ? 'other' : 'holdTaskExecution' },
      taskQueue: { name: bad === 'hold-queue' ? taskQueue : taskQueue + '.control' },
      input: payload(...(bad === 'hold-arg-length' ? holdArgs.slice(0, 1) : holdArgs)),
    },
    stamp(60000),
  );
  if (bad === 'hold-too-early') addTerminal();
  const addLater = () =>
    add(
      'ACTIVITY_TASK_SCHEDULED',
      'activityTaskScheduledEventAttributes',
      {
        activityType: { name: 'writeLocalTask' },
        taskQueue: { name: taskQueue },
      },
      stamp(62000),
    );
  if (bad === 'later-too-early') addLater();
  add(
    'ACTIVITY_TASK_COMPLETED',
    'activityTaskCompletedEventAttributes',
    {
      scheduledEventId: bad === 'hold-completion-target' ? '999' : hold,
      result: payload(bad === 'hold-result' ? { status: 'done' } : { status: 'held', held }),
    },
    stamp(61000),
  );
  if (laterAttempt) addLater();
  if (bad === 'noncontiguous') events[0]!.eventId = '9';
  if (bad === 'start-after-terminal') {
    const activity = events[Number(activityStart) - 1]!;
    const terminalIndex = events.findIndex(
      (event) => event.eventType === 'EVENT_TYPE_ACTIVITY_TASK_CANCELED',
    );
    const terminal = events[terminalIndex]!;
    const newStartId = terminal.eventId;
    terminal.eventId = activityStart;
    activity.eventId = newStartId;
    cancelledAttrs.startedEventId = String(newStartId);
    events[terminalIndex] = activity;
    events[Number(activityStart) - 1] = terminal;
  }
  const history = write(join(bad === 'history-path' ? root : evidence, 'history.json'), { events });
  write(join(gate, 'grant.json'), {
    schemaVersion: bad === 'gate-version' ? 2 : 1,
    input: bad === 'gate-input' ? null : input,
    source: bad === 'gate-source' ? null : source,
    profile: bad === 'gate-profile' ? null : profile,
    artifactRoot: bad === 'gate-artifacts' ? '/foreign' : artifactRoot,
    instance: bad === 'gate-instance' ? 'foreign' : 'owner-0',
  });
  write(join(gate, 'execution-held.json'), bad === 'gate-held' ? null : held);
  write(join(gate, 'snapshot.json'), bad === 'gate-snapshot' ? null : snapshot);
  write(join(gate, 'stopped.json'), bad === 'gate-stopped' ? null : stopped);
  const writeOperation = 'task-write-' + workflowHash + '-a0';
  const journal = effectJournal(join(gate, 'task-effects'));
  if (bad !== 'pending-absent') {
    const intent = {
      ...target,
      operationId: writeOperation,
      requestHash: digest(JSON.stringify(bad === 'pending-other-snapshot' ? stopped : snapshot)),
    };
    const result = journal.execute(intent, async () => {
      if (bad !== 'pending-complete') throw new Error('simulated cancellation');
      return stopped;
    });
    if (bad === 'pending-complete') await result;
    else await expect(result).rejects.toThrow('simulated cancellation');
  }
  return {
    refs: { started, claim, status, history, gateRoot },
    workflowId,
    runId,
    writeOperation,
    held,
  };
}

it.each([false, true])(
  'measures server time before cancellation and binds the held pending write, including delayed history event order (%s)',
  async (laterAttempt) => {
    const { refs, workflowId, runId, writeOperation, held } = await fixture(
      undefined,
      laterAttempt,
      laterAttempt,
    );
    expect(checkH06NativeTemporalDuration(refs)).toMatchObject({
      status: 'LONG_STAGE_VERIFIED',
      runId,
      workflowId,
      operationId: writeOperation,
      held,
      attempt: 0,
      elapsedBeforeCancellationMs: 35000,
      scheduledToTerminalMs: 58000,
      minimumMs: 35000,
      qualification: false,
      mayRun: false,
    });
  },
);

it('recognizes the nonretryable Reader activity failure after the physical stop interrupts its turn', async () => {
  const { refs } = await fixture('failure-non-retryable');
  expect(checkH06NativeTemporalDuration(refs)).toMatchObject({
    status: 'LONG_STAGE_VERIFIED',
    terminal: 'failed-after-cancel-request',
    elapsedBeforeCancellationMs: 35000,
  });
});

it.each([false, true])(
  'recognizes a nonretryable Writer failure with the server cancellation retry state (%s)',
  async (delayedStartEvent) => {
    const { refs } = await fixture('failure-non-retryable', false, delayedStartEvent, true);
    expect(checkH06NativeTemporalDuration(refs)).toMatchObject({
      status: 'LONG_STAGE_VERIFIED',
      terminal: 'failed-after-cancel-request',
      elapsedBeforeCancellationMs: 35000,
      qualification: false,
      mayRun: false,
    });
  },
);

it.each([
  ['cancel-absent', 'cancel-request'],
  ['cancel-foreign', 'cancel-request'],
  ['failure-retry', 'write-terminal'],
  ['failure-missing', 'write-terminal'],
  ['failure-no-application-info', 'write-terminal'],
  ['failure-wrong-type', 'write-terminal'],
  ['failure-retryable', 'write-terminal'],
  ['activity-retried', 'write-events'],
  ['active-time-reversed', 'event-order'],
  ['duration-short', 'too-short'],
  ['stopped-unconfirmed', 'retained-write'],
  ['gate-stopped', 'gate-binding'],
  ['pending-complete', 'pending-write'],
])('refuses cancellation-state failure without its required proof: %s', async (bad, failure) => {
  const { refs } = await fixture(bad, false, true, true);
  expect(() => checkH06NativeTemporalDuration(refs)).toThrow('h06-duration-' + failure);
});

const badCases: Record<string, string[]> = {
  'evidence-root': ['claim-path', 'history-path', 'status-path'],
  claim: [
    'claim-kind',
    'request-kind',
    'claim-hash',
    'claim-root',
    'claim-variant',
    'operation',
    'claim-workspace',
  ],
  stimulus: ['stimulus-type', 'stimulus-fraction', 'stimulus-zero', 'stimulus-lease'],
  'workflow-start': ['workflow-absent'],
  'history-binding': [
    'noncontiguous',
    'workflow-type',
    'history-run',
    'history-queue',
    'history-queue-absent',
    'history-input',
  ],
  'write-schedule': ['write-absent'],
  'write-binding': [
    'write-args',
    'write-no-input',
    'write-input',
    'write-queue',
    'write-no-queue',
    'write-retry',
    'write-no-retry',
  ],
  'write-start': ['activity-foreign'],
  'cancel-request': ['cancel-foreign', 'cancel-absent'],
  'write-terminal': [
    'terminal-foreign',
    'terminal-cancel',
    'terminal-timed-out',
    'terminal-success',
    'terminal-cancel-with-failed-attributes',
    'failure-retry',
    'failure-missing',
    'failure-no-application-info',
    'failure-wrong-type',
    'failure-retryable',
  ],
  'write-events': ['activity-retried', 'terminal-start', 'start-after-terminal'],
  'event-time': ['schedule-time-absent', 'start-time-negative'],
  'event-order': ['queue-time-reversed', 'active-time-reversed', 'cleanup-time-reversed'],
  'too-short': ['duration-short', 'nanos-short'],
  'paused-status': [
    'status-query',
    'status-workflow',
    'status-run',
    'result-run',
    'status-phase',
    'status-waiting',
    'status-revision',
    'status-attempt',
    'status-requirements',
    'stop-failure',
    'budget-failure',
    'checkpoint-failure',
    'status-snapshot',
    'status-history',
  ],
  'retained-write': [
    'held-kind',
    'held-input',
    'progress-phase',
    'progress-snapshot',
    'stopped-kind',
    'stopped-unconfirmed',
    'stopped-input',
    'snapshot-kind',
    'snapshot-version',
    'snapshot-input',
    'source',
  ],
  pause: [
    'interrupt-kind',
    'interrupt-input',
    'not-pause',
    'command-hash',
    'ack-id',
    'ack-hash',
    'ack-revision',
    'status-commands',
  ],
  'hold-schedule': ['hold-absent', 'hold-task'],
  'hold-input': [
    'hold-too-early',
    'hold-queue',
    'hold-arg-length',
    'hold-progress',
    'hold-stop',
    'hold-reason',
    'hold-ack',
  ],
  'hold-completion': ['hold-completion-target'],
  'hold-result': ['hold-result', 'later-too-early'],
  'gate-root': ['gate-path', 'gate-workflow'],
  'gate-binding': [
    'gate-version',
    'gate-input',
    'gate-source',
    'gate-profile',
    'gate-artifacts',
    'gate-instance',
    'gate-held',
    'gate-snapshot',
    'gate-stopped',
  ],
  'pending-write': ['pending-absent', 'pending-complete'],
};
it.each(
  Object.entries(badCases).flatMap(([failure, cases]) => cases.map((name) => [name, failure])),
)('refuses unproven %s', async (name, failure) => {
  const { refs } = await fixture(name);
  expect(() => checkH06NativeTemporalDuration(refs)).toThrow('h06-duration-' + failure);
});

it('refuses a conflicting durable effect with the same operation identity', async () => {
  const { refs } = await fixture('pending-other-snapshot');
  expect(() => checkH06NativeTemporalDuration(refs)).toThrow('effect-id-conflict');
});
