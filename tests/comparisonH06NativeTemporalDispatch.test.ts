import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultPayloadConverter } from '@temporalio/common';
import { payloadToJSON } from '@temporalio/common/proto-utils';
import { afterEach, expect, it } from 'vitest';
import { canonical } from '../adapters/storage/storeCodec.js';
import { effectJournal, type EffectIntent } from '../src/adapters/artifacts/effects.js';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import { parseLocalTask, localTaskKey } from '../src/policy/localTask.js';
import { checkH06NativeTemporalDispatch } from './comparisonH06NativeTemporalDispatch.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function payload(...items: unknown[]) {
  return { payloads: items.map((item) => payloadToJSON(defaultPayloadConverter.toPayload(item)!)) };
}

type Bad =
  | 'ledger-unknown'
  | 'no-start'
  | 'bad-event-id'
  | 'wrong-workflow'
  | 'wrong-run'
  | 'missing-queue'
  | 'wrong-input'
  | 'no-write'
  | 'retry'
  | 'missing-args'
  | 'missing-retry'
  | 'missing-activity-queue'
  | 'absent-activity-start'
  | 'duplicate-activity-start'
  | 'retried-activity-start'
  | 'wrong-attempt'
  | 'foreign-task'
  | 'foreign-initial'
  | 'foreign-instance'
  | 'foreign-copy'
  | 'extra-effects'
  | 'unconfirmed-stop'
  | 'unexpected-turn'
  | 'stopped-profile'
  | 'changed-prompt'
  | 'crossed-session'
  | 'outside-journal'
  | 'wrong-turn-id'
  | 'malformed-items'
  | 'missing-user'
  | 'malformed-content'
  | 'extra-content'
  | 'wrong-content-type'
  | 'wrong-content-value'
  | 'wrong-create'
  | 'pending-effect'
  | 'wrong-turn-effect'
  | 'absent-terminal'
  | 'wrong-terminal-target'
  | 'wrong-terminal-start'
  | 'duplicate-write'
  | 'overlap'
  | 'cancelled-result'
  | 'missing-result'
  | 'wrong-result'
  | 'wrong-claim'
  | 'wrong-gate'
  | 'orphan-gate'
  | 'wrong-history-path';

async function fixture(bad?: Bad, failedActivity = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-dispatch-'));
  roots.push(root);
  const evidence = join(root, 'evidence');
  const artifactRoot = join(evidence, 'runtime');
  const store = artifactStore(artifactRoot);
  const save = (value: unknown) => store.publish(Buffer.from(JSON.stringify(value)));
  const write = (path: string, value: unknown) => {
    const bytes = Buffer.from(canonical(value) + '\n');
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const workspace = join(root, 'source');
  const operationId = 'h06-operation';
  const initial = parseLocalTask({
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
          checks: ['validate'],
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
    baseline: 'validate',
    continuation: { attempt: 0, previous: null },
  });
  if (initial.schemaVersion !== 11) throw new Error('fixture-input');
  const workflowId = localTaskKey(initial);
  const workflowHash = digest(workflowId);
  const runId = 'run-1';
  const taskQueue = 'h06-queue';
  const profile = { model: 'gpt-6-astra', effort: 'medium', clientVersion: '0.154.0' };
  const started = write(join(evidence, 'temporal-start.json'), {
    kind: 'h06-native-temporal-start',
    operationId,
    input: initial,
    hostOwner: { id: 'owner-0' },
    artifactRoot,
    workspaceRoot: workspace,
    profile,
    workflowId,
    taskQueue,
    firstExecutionRunId: runId,
  });
  const request = {
    kind: 'comparison-h06-native/2',
    binding: {
      operationId,
      variant: 'temporal',
      workspaceRoot: bad === 'wrong-claim' ? '/foreign' : workspace,
    },
    evidenceRoot: evidence,
    budget: { maxManagedStarts: 8 },
  };
  const assets = {};
  const claim = write(join(evidence, 'attempt-claim.json'), {
    kind: 'h06-native-attempt-claim',
    request,
    assets,
    requestHash: digest(canonical({ request, assets })),
  });
  const ledger = openH06NativeTurnLedger(join(evidence, 'turns'), {
    mode: 'create',
    operationId,
    maxManagedStarts: 8,
  });
  const gateRoot = join(root, 'tasks', workflowHash, 'execution-attempts');
  const events: Record<string, unknown>[] = [];
  const add = (type: string, field: string, attrs: object) => {
    const id = String(events.length + 1);
    events.push({ eventId: id, eventType: 'EVENT_TYPE_' + type, [field]: attrs });
    return id;
  };
  if (bad !== 'no-start')
    add('WORKFLOW_EXECUTION_STARTED', 'workflowExecutionStartedEventAttributes', {
      workflowType: { name: bad === 'wrong-workflow' ? 'OtherWorkflow' : 'LocalTaskWorkflow' },
      originalExecutionRunId: bad === 'wrong-run' ? 'foreign-run' : runId,
      ...(bad === 'missing-queue' ? {} : { taskQueue: { name: taskQueue } }),
      input: payload(bad === 'wrong-input' ? null : initial),
    });
  const source = { root: workspace, dev: '1', ino: '2' };
  let delayedTerminal: (() => void) | null = null;
  for (const attempt of [0, 1]) {
    const active = attempt === 0;
    const preparation = initial.admission.preparation;
    const continued = {
      ...initial,
      continuation: { attempt, previous: attempt === 0 ? null : save({ kind: 'continuation' }) },
    };
    const input =
      active && bad === 'foreign-task'
        ? {
            ...continued,
            admission: {
              ...continued.admission,
              preparation: { ...preparation, owner: 'foreign' },
            },
          }
        : active && bad === 'foreign-initial'
          ? { ...continued, executor: { ...continued.executor, sha256: digest('foreign') } }
          : active && bad === 'wrong-attempt'
            ? { ...continued, continuation: { attempt: 1, previous: save({ kind: 'other' }) } }
            : continued;
    const copyRoot = join(artifactRoot, 'copies', workflowHash + '-a' + attempt);
    const copy = { ...source, root: active && bad === 'foreign-copy' ? '/foreign' : copyRoot };
    const snapshot = { schemaVersion: 3, kind: 'substantial-task', input, source, copy, profile };
    const snapshotRef = save(snapshot);
    const scheduled = {
      activityType: { name: bad === 'no-write' ? 'other' : 'writeLocalTask' },
      ...(active && bad === 'missing-args' ? {} : { input: payload(input, snapshotRef) }),
      ...(active && bad === 'missing-retry'
        ? {}
        : {
            retryPolicy: { maximumAttempts: active && bad === 'retry' ? 2 : 1 },
          }),
      ...(active && bad === 'missing-activity-queue' ? {} : { taskQueue: { name: taskQueue } }),
    };
    const schedule = () =>
      add('ACTIVITY_TASK_SCHEDULED', 'activityTaskScheduledEventAttributes', scheduled);
    const eventId = schedule();
    if (active && bad === 'duplicate-write') schedule();
    if (!active) delayedTerminal?.();
    const startActivity = () =>
      add('ACTIVITY_TASK_STARTED', 'activityTaskStartedEventAttributes', {
        scheduledEventId: eventId,
        attempt: active && bad === 'retried-activity-start' ? 2 : 1,
      });
    const startedEventId = active && bad === 'absent-activity-start' ? '100' : startActivity();
    if (active && bad === 'duplicate-activity-start') startActivity();
    const gate = join(gateRoot, String(attempt));
    mkdirSync(gate, { recursive: true });
    write(join(gate, 'grant.json'), {
      schemaVersion: 1,
      input,
      source,
      profile,
      artifactRoot,
      instance: active && bad === 'foreign-instance' ? 'foreign' : 'owner-' + attempt,
    });
    write(join(gate, 'snapshot.json'), snapshotRef);
    const session = 'writer-' + attempt;
    const writer = effectJournal(join(gate, 'writer-effects'));
    const intent = (stage: string, body: unknown): EffectIntent => ({
      projectId: preparation.project.projectId,
      taskId: preparation.taskId,
      operationId: 'task-' + stage + '-' + workflowHash + '-a' + attempt,
      requestHash: digest(JSON.stringify(body)),
      hostId: operationId,
      workspaceId: preparation.project.workspaceId,
      owner: preparation.owner,
      generation: preparation.generation,
    });
    const writeIntent = intent('write', snapshotRef);
    await writer.execute(intent('create', { snapshot }), async () =>
      save({
        kind: active && bad === 'wrong-create' ? 'foreign' : 'task-writer-session',
        input,
        identity: { session },
        raw: { cwd: copyRoot, thread: { id: session } },
      }),
    );
    const turns = [];
    for (const [index, stage] of ['profile', 'load', 'implement'].entries()) {
      const first = active && index === 0;
      const prompt = 'prompt-' + stage;
      const effect = intent(stage, { thread: session, prompt });
      const turnId = 'turn-' + attempt + '-' + index;
      const message = `Workflow operation: ${effect.operationId}\n${prompt}`;
      const failure = new Error('dispatch not recorded');
      if (first && bad === 'pending-effect') {
        await expect(
          writer.execute(effect, async () => {
            throw failure;
          }),
        ).rejects.toBe(failure);
        write(join(gate, 'writer-effects', 'extra'), {});
      } else {
        await writer.execute(effect, async () =>
          save({
            turnId: first && bad === 'wrong-turn-effect' ? 'foreign-turn' : turnId,
          }),
        );
      }
      const recorded = {
        role: 'writer' as const,
        root: copyRoot,
        session: first && bad === 'crossed-session' ? 'foreign' : session,
        journal: join(first && bad === 'outside-journal' ? root : evidence, 'journal-' + attempt),
        params: {
          threadId: first && bad === 'crossed-session' ? 'foreign' : session,
          input: [{ type: 'text', text: message }],
        },
      };
      await ledger.admitTurn(recorded);
      const response = { ...recorded, turnId, response: { turn: { id: turnId } } };
      if (bad !== 'ledger-unknown' || active || index !== 2) await ledger.recordTurn(response);
      const part = {
        type: first && bad === 'wrong-content-type' ? 'input_image' : 'text',
        text:
          first && bad === 'changed-prompt'
            ? message + 'changed'
            : first && bad === 'wrong-content-value'
              ? false
              : message,
      };
      const user = {
        type: first && bad === 'missing-user' ? 'agentMessage' : 'userMessage',
        content:
          first && bad === 'malformed-content'
            ? {}
            : first && bad === 'extra-content'
              ? [part, part]
              : [part],
      };
      turns.push({
        id: first && bad === 'wrong-turn-id' ? 'foreign-turn' : turnId,
        status:
          first && bad === 'stopped-profile'
            ? 'interrupted'
            : active && stage === 'implement'
              ? 'interrupted'
              : 'completed',
        items: first && bad === 'malformed-items' ? {} : [user],
      });
    }
    if (active && bad === 'extra-effects') write(join(gate, 'writer-effects', 'extra'), {});
    const stop = save({
      schemaVersion: 2,
      kind: 'task-writers-stopped',
      confirmed: !(active && bad === 'unconfirmed-stop'),
      input,
      source,
      copy,
      session,
      primary: {
        thread: {
          id: session,
          cwd: copyRoot,
          turns: active && bad === 'unexpected-turn' ? [...turns, turns[0]] : turns,
        },
      },
    });
    write(join(gate, 'writer-stopped.json'), stop);
    const outer = effectJournal(join(gate, 'task-effects'));
    const result = { stop, session, answer: save({ result: true }), tree: save({ files: [] }) };
    if ((active && bad !== 'cancelled-result') || (!active && bad === 'missing-result')) {
      const stopped = new Error('writer interrupted');
      await expect(
        outer.execute(writeIntent, async () => {
          throw stopped;
        }),
      ).rejects.toBe(stopped);
    } else {
      const resultRef = await outer.execute(writeIntent, async () => save(result));
      write(join(gate, 'writer-result.json'), resultRef);
    }
    if (active && bad === 'absent-terminal') continue;
    const terminate = () => {
      if (active)
        add(
          failedActivity ? 'ACTIVITY_TASK_FAILED' : 'ACTIVITY_TASK_CANCELED',
          failedActivity
            ? 'activityTaskFailedEventAttributes'
            : 'activityTaskCanceledEventAttributes',
          {
            scheduledEventId: bad === 'wrong-terminal-target' ? '100' : eventId,
            startedEventId: bad === 'wrong-terminal-start' ? '100' : startedEventId,
          },
        );
      else
        add('ACTIVITY_TASK_COMPLETED', 'activityTaskCompletedEventAttributes', {
          scheduledEventId: eventId,
          startedEventId,
          result: payload(bad === 'wrong-result' ? { ...result, session: 'other' } : result),
        });
    };
    if (active && bad === 'overlap') delayedTerminal = terminate;
    else terminate();
  }
  if (bad === 'bad-event-id') events.at(-1)!.eventId = '100';
  if (bad === 'orphan-gate') mkdirSync(join(gateRoot, '2'));
  const history = write(join(bad === 'wrong-history-path' ? root : evidence, 'history.json'), {
    events,
  });
  return {
    started,
    history,
    claim,
    gateRoot: bad === 'wrong-gate' ? evidence : gateRoot,
  };
}

it.each([false, true])(
  'binds native dispatches to the single run and separate attempts (failed: %s)',
  async (failed) => {
    const result = checkH06NativeTemporalDispatch(await fixture(undefined, failed));
    expect(result).toMatchObject({
      status: 'DISPATCH_CHAIN_VERIFIED',
      runId: 'run-1',
      qualification: false,
      mayRun: false,
      attempts: [
        { attempt: 0, session: 'writer-0' },
        { attempt: 1, session: 'writer-1' },
      ],
    });
    expect(result.attempts.map(({ turns }) => turns.map(({ turnId }) => turnId))).toEqual([
      ['turn-0-0', 'turn-0-1', 'turn-0-2'],
      ['turn-1-0', 'turn-1-1', 'turn-1-2'],
    ]);
  },
);

it('verifies the pinned parent before accepting an explicit autonomous admission', async () => {
  const request = await fixture();
  const parent = join(dirname(request.claim.path), 'invalid-parent.json');
  writeFileSync(parent, 'null');
  const bytes = JSON.stringify({
    ...JSON.parse(readFileSync(request.claim.path, 'utf8')),
    grant: {
      admission: {
        kind: 'temporal-autonomous/3',
        authority: { path: parent, sha256: digest('null') },
      },
    },
  });
  writeFileSync(request.claim.path, bytes);
  expect(() =>
    checkH06NativeTemporalDispatch({
      ...request,
      claim: { path: request.claim.path, sha256: digest(bytes) },
    }),
  ).toThrow('object-required');
});

it.each([
  [null, 'object-required'],
  [{ admission: { kind: 'other', authority: {} } }, 'h06-native-attempt-admission'],
] as const)(
  'rejects a malformed present admission in the binding-only claim (%j)',
  async (grant, error) => {
    const request = await fixture();
    const bytes = JSON.stringify({
      ...JSON.parse(readFileSync(request.claim.path, 'utf8')),
      grant,
    });
    writeFileSync(request.claim.path, bytes);
    expect(() =>
      checkH06NativeTemporalDispatch({
        ...request,
        claim: { path: request.claim.path, sha256: digest(bytes) },
      }),
    ).toThrow(error);
  },
);

it.each([
  ['ledger-unknown', 'ledger-unknown'],
  ['no-start', 'workflow-start'],
  ['bad-event-id', 'workflow-binding'],
  ['wrong-workflow', 'workflow-binding'],
  ['wrong-run', 'workflow-binding'],
  ['missing-queue', 'workflow-binding'],
  ['wrong-input', 'workflow-binding'],
  ['no-write', 'writer-count'],
  ['retry', 'activity-options'],
  ['missing-args', 'activity-options'],
  ['missing-retry', 'activity-options'],
  ['missing-activity-queue', 'activity-options'],
  ['absent-activity-start', 'activity-started'],
  ['duplicate-activity-start', 'activity-started'],
  ['retried-activity-start', 'activity-retry'],
  ['wrong-attempt', 'attempt'],
  ['foreign-task', 'attempt'],
  ['foreign-initial', 'attempt'],
  ['foreign-instance', 'host-instance'],
  ['foreign-copy', 'snapshot'],
  ['extra-effects', 'effect-count'],
  ['unconfirmed-stop', 'native-stop'],
  ['unexpected-turn', 'native-stop'],
  ['stopped-profile', 'turn-binding'],
  ['changed-prompt', 'turn-binding'],
  ['crossed-session', 'turn-binding'],
  ['outside-journal', 'turn-binding'],
  ['wrong-turn-id', 'turn-binding'],
  ['malformed-items', 'native-message'],
  ['missing-user', 'native-message'],
  ['malformed-content', 'native-message'],
  ['extra-content', 'native-message'],
  ['wrong-content-type', 'native-message'],
  ['wrong-content-value', 'native-message'],
  ['wrong-create', 'session'],
  ['pending-effect', 'writer-effect'],
  ['wrong-turn-effect', 'turn-effect'],
  ['absent-terminal', 'activity-terminal'],
  ['wrong-terminal-target', 'activity-terminal'],
  ['wrong-terminal-start', 'activity-terminal'],
  ['duplicate-write', 'writer-count'],
  ['overlap', 'activity-overlap'],
  ['cancelled-result', 'cancelled-effect'],
  ['missing-result', 'write-effect'],
  ['wrong-result', 'write-result'],
  ['wrong-claim', 'attempt-claim'],
  ['wrong-gate', 'gate-root'],
  ['orphan-gate', 'gate-attempts'],
  ['wrong-history-path', 'evidence-root'],
] as const)('rejects %s evidence', async (bad, error) => {
  const request = await fixture(bad);
  expect(() => checkH06NativeTemporalDispatch(request)).toThrow('h06-dispatch-' + error);
});
