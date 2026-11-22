import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import { historyFromJSON, historyToJSON, payloadToJSON } from '@temporalio/common/proto-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical } from '../adapters/storage/storeCodec.js';
import { digest } from '../src/adapters/artifacts/files.js';
import { localTaskKey, parseLocalTask } from '../src/policy/localTask.js';
import {
  captureH06NativeTemporalHistory,
  replayH06NativeTemporalHistory,
} from './comparisonH06NativeTemporalHistory.js';

const mocks = vi.hoisted(() => ({
  replay: vi.fn<(options: unknown, history: unknown, workflowId: string) => Promise<void>>(),
}));
vi.mock('@temporalio/worker', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  Worker: { runReplayHistory: mocks.replay },
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  mocks.replay.mockReset();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-history-'));
  roots.push(root);
  const evidence = join(root, 'attempt');
  const artifactRoot = join(evidence, 'artifacts');
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(workspaceRoot);
  function write(path: string, bytes: string) {
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  }
  function save(path: string, value: unknown) {
    return write(path, JSON.stringify(value));
  }
  const operationId = 'h06-1';
  const runId = 'run-1';
  const taskQueue = 'h06-task-queue';
  const input = parseLocalTask({
    schemaVersion: 11,
    admission: {
      schemaVersion: 3,
      preparation: {
        schemaVersion: 1,
        project: {
          schemaVersion: 1,
          projectId: 'project',
          workspaceId: 'workspace',
          rules: ['RULES.md'],
          cardRoot: 'tasks',
          roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
          checks: ['syntax', 'validate'],
        },
        taskId: 'task',
        hostId: operationId,
        owner: 'owner',
        generation: 1,
        revision: 1,
        card: 'tasks/task.md',
      },
      plan: { path: 'plan.json', sha256: digest('plan') },
      planning: { sha256: digest('planning'), bytes: 8 },
      acceptance: { sha256: digest('acceptance'), bytes: 10 },
    },
    executor: { path: 'executor.md', sha256: digest('executor') },
    baseline: 'syntax',
    continuation: { attempt: 0, previous: null },
  });
  const workflowId = localTaskKey(input);
  const workflows = write(join(root, 'workflows.js'), 'pinned workflows');
  const dependency = write(join(root, 'dependency.js'), 'pinned dependency');
  const start = {
    kind: 'h06-native-temporal-start',
    operationId,
    input,
    artifactRoot,
    workspaceRoot,
    workflowsPath: workflows.path,
    workflowId,
    taskQueue,
    firstExecutionRunId: runId,
  };
  const started = save(join(evidence, 'temporal-start.json'), start);
  const descriptor = {
    kind: 'comparison-h06-native-temporal-bootstrap/2',
    taskQueue,
    workflows,
    input,
  };
  const request = {
    kind: 'comparison-h06-native/2',
    binding: { operationId, variant: 'temporal', workspaceRoot },
    evidenceRoot: evidence,
    bootstrap: save(join(root, 'bootstrap.json'), descriptor),
    runtime: [workflows, dependency],
  };
  function claim() {
    const assets = {};
    return save(join(evidence, 'attempt-claim.json'), {
      kind: 'h06-native-attempt-claim',
      request,
      assets,
      requestHash: digest(canonical({ request, assets })),
    });
  }
  const attributes = {
    originalExecutionRunId: runId,
    workflowType: { name: 'LocalTaskWorkflow' },
    taskQueue: { name: taskQueue },
    input: { payloads: [payloadToJSON(defaultPayloadConverter.toPayload(input)!)] },
  };
  const begin = {
    eventId: '1',
    eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
    workflowExecutionStartedEventAttributes: attributes,
  };
  const scheduled = {
    eventId: '2',
    eventType: 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED',
    workflowTaskScheduledEventAttributes: {},
  };
  const history = () => historyFromJSON({ events: [begin, scheduled] });
  const description = { workflowId, runId, taskQueue, type: 'LocalTaskWorkflow', historyLength: 2 };
  const describe = vi.fn(async () => description);
  const fetchHistory = vi.fn(async () => history());
  const getHandle = vi.fn(() => ({ describe, fetchHistory }));
  const withDeadline = vi.fn(async (_deadline: number, call: () => Promise<unknown>) => call());
  const client = { workflow: { getHandle }, connection: { withDeadline } } as unknown as Pick<
    Client,
    'workflow' | 'connection'
  >;
  const deadline = () => Date.now() + 30_000;
  const capture = () => captureH06NativeTemporalHistory(client, started, 'paused', deadline());
  const historyPath = join(evidence, 'history-paused.json');
  return {
    root,
    evidence,
    input,
    start,
    started,
    workflows,
    dependency,
    descriptor,
    request,
    claim,
    write,
    save,
    attributes,
    begin,
    scheduled,
    description,
    describe,
    fetchHistory,
    getHandle,
    withDeadline,
    client,
    capture,
    history,
    historyPath,
    workflowId,
    runId,
  };
}

it('captures the complete stable exact run using the SDK JSON format and publishes once', async () => {
  const f = fixture();
  const pin = await f.capture();
  const json = historyToJSON(f.history());
  expect(pin).toEqual({ path: f.historyPath, sha256: digest(json) });
  expect(readFileSync(pin.path, 'utf8')).toBe(json);
  expect(f.getHandle).toHaveBeenCalledExactlyOnceWith(f.workflowId, f.runId);
  expect(f.withDeadline).toHaveBeenCalledTimes(1);
  expect(f.describe).toHaveBeenCalledTimes(2);
  await expect(f.capture()).rejects.toMatchObject({ code: 'EEXIST' });
  expect(readFileSync(pin.path, 'utf8')).toBe(json);
});

it.each([
  ['wrong-workflow-description', 'description'],
  ['wrong-run-description', 'description'],
  ['wrong-queue-description', 'description'],
  ['wrong-type-description', 'description'],
  ['truncated', 'incomplete-or-changed'],
  ['changed-count', 'incomplete-or-changed'],
  ['empty', 'empty'],
  ['no-events', 'empty'],
  ['gap', 'event-order'],
  ['no-start', 'start'],
  ['extra-start', 'start'],
  ['late-start', 'start'],
  ['no-attributes', 'execution'],
  ['wrong-run', 'execution'],
  ['wrong-type', 'execution'],
  ['wrong-queue', 'execution'],
  ['wrong-input', 'execution'],
] as const)('rejects %s before writing history', async (name, error) => {
  const f = fixture();
  if (name === 'wrong-workflow-description') f.description.workflowId = 'foreign';
  if (name === 'wrong-run-description') f.description.runId = 'foreign';
  if (name === 'wrong-queue-description') f.description.taskQueue = 'foreign';
  if (name === 'wrong-type-description') f.description.type = 'foreign';
  if (name === 'truncated') f.describe.mockResolvedValue({ ...f.description, historyLength: 3 });
  if (name === 'changed-count')
    f.describe
      .mockResolvedValueOnce(f.description)
      .mockResolvedValueOnce({ ...f.description, historyLength: 3 });
  if (name === 'empty') f.fetchHistory.mockResolvedValue({ events: [] });
  if (name === 'no-events') f.fetchHistory.mockResolvedValue({});
  if (name === 'gap') f.scheduled.eventId = '3';
  if (name === 'no-start')
    f.fetchHistory.mockResolvedValue(
      historyFromJSON({ events: [{ ...f.scheduled, eventId: '1' }] }),
    );
  if (name === 'extra-start')
    f.fetchHistory.mockResolvedValue(
      historyFromJSON({ events: [f.begin, { ...f.begin, eventId: '2' }] }),
    );
  if (name === 'late-start')
    f.fetchHistory.mockResolvedValue(
      historyFromJSON({
        events: [
          { ...f.scheduled, eventId: '1' },
          { ...f.begin, eventId: '2' },
        ],
      }),
    );
  if (name === 'no-attributes')
    f.fetchHistory.mockResolvedValue({
      events: [{ eventId: f.history().events![0]!.eventId!, eventType: 1 }],
    });
  if (name === 'wrong-run') f.attributes.originalExecutionRunId = 'foreign';
  if (name === 'wrong-type') f.attributes.workflowType.name = 'foreign';
  if (name === 'wrong-queue') f.attributes.taskQueue.name = 'foreign';
  if (name === 'wrong-input')
    f.attributes.input.payloads[0] = payloadToJSON(defaultPayloadConverter.toPayload('foreign')!);
  await expect(f.capture()).rejects.toThrow('h06-history-' + error);
  expect(existsSync(f.historyPath)).toBe(false);
});

it.each(['before', 'during', 'invalid'] as const)(
  'checks the deadline %s capture',
  async (when) => {
    const f = fixture();
    const now = Date.now();
    const limit = when === 'before' ? now : when === 'during' ? now + 100 : NaN;
    if (when === 'during')
      f.fetchHistory.mockImplementationOnce(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(limit);
        return f.history();
      });
    await expect(
      captureH06NativeTemporalHistory(f.client, f.started, 'paused', limit),
    ).rejects.toThrow('h06-history-deadline');
    expect(existsSync(f.historyPath)).toBe(false);
  },
);

it('fails closed if the start receipt changes during capture', async () => {
  const f = fixture();
  f.fetchHistory.mockImplementationOnce(async () => {
    f.write(f.started.path, '{}');
    return f.history();
  });
  await expect(f.capture()).rejects.toThrow('h04-pin-changed');
  expect(existsSync(f.historyPath)).toBe(false);
});

it('passes only the original pinned workflow source, typed history and actual workflow ID to offline replay', async () => {
  const f = fixture();
  const history = await f.capture();
  const claim = f.claim();
  expect(await replayH06NativeTemporalHistory({ started: f.started, claim, history })).toEqual({
    status: 'REPLAY_VERIFIED',
    qualification: false,
    workflowId: f.workflowId,
    runId: f.runId,
    eventCount: 2,
    history,
  });
  expect(mocks.replay).toHaveBeenCalledExactlyOnceWith(
    { workflowsPath: f.workflows.path },
    historyFromJSON(JSON.parse(readFileSync(history.path, 'utf8'))),
    f.workflowId,
  );
});

it.each([
  ['claim-path', 'root'],
  ['history-path', 'root'],
  ['history-name', 'root'],
  ['claim-kind', 'claim'],
  ['claim-hash', 'claim'],
  ['request-kind', 'claim'],
  ['request-root', 'claim'],
  ['variant', 'claim'],
  ['operation', 'claim'],
  ['workspace', 'claim'],
  ['bootstrap-kind', 'bootstrap'],
  ['bootstrap-queue', 'bootstrap'],
  ['bootstrap-input', 'bootstrap'],
  ['workflow-path', 'bootstrap'],
  ['no-runtime', 'bootstrap'],
  ['unbound-workflows', 'bootstrap'],
] as const)('rejects invalid replay inputs (%s)', async (name, error) => {
  const f = fixture();
  let history = await f.capture();
  if (name === 'history-path')
    history = f.write(join(f.root, 'history-paused.json'), historyToJSON(f.history()));
  if (name === 'history-name')
    history = f.write(join(f.evidence, 'paused.json'), historyToJSON(f.history()));
  if (name === 'request-kind') f.request.kind = 'foreign';
  if (name === 'request-root') f.request.evidenceRoot = f.root;
  if (name === 'variant') f.request.binding.variant = 'legacy';
  if (name === 'operation') f.request.binding.operationId = 'foreign';
  if (name === 'workspace') f.request.binding.workspaceRoot = f.root;
  if (name === 'bootstrap-kind') f.descriptor.kind = 'foreign';
  if (name === 'bootstrap-queue') f.descriptor.taskQueue = 'foreign';
  if (name === 'bootstrap-input') f.descriptor.input = { ...f.input, baseline: 'foreign' };
  if (name === 'workflow-path') f.descriptor.workflows = f.dependency;
  if (name === 'no-runtime') Object.assign(f.request, { runtime: null });
  if (name === 'unbound-workflows') f.request.runtime = [f.dependency];
  f.request.bootstrap = f.save(f.request.bootstrap.path, f.descriptor);
  let claim = f.claim();
  if (name === 'claim-path')
    claim = f.write(join(f.root, 'attempt-claim.json'), readFileSync(claim.path, 'utf8'));
  if (name === 'claim-kind' || name === 'claim-hash') {
    const value = JSON.parse(readFileSync(claim.path, 'utf8')) as Record<string, unknown>;
    value[name === 'claim-kind' ? 'kind' : 'requestHash'] = 'foreign';
    claim = f.save(claim.path, value);
  }
  await expect(
    replayH06NativeTemporalHistory({ started: f.started, claim, history }),
  ).rejects.toThrow('h06-history-replay-' + error);
  expect(mocks.replay).not.toHaveBeenCalled();
});

it.each(['history', 'bootstrap', 'workflow', 'dependency'] as const)(
  'verifies the original %s bytes before replay',
  async (which) => {
    const f = fixture();
    const history = await f.capture();
    const claim = f.claim();
    const path = {
      history: history.path,
      bootstrap: f.request.bootstrap.path,
      workflow: f.workflows.path,
      dependency: f.dependency.path,
    }[which];
    f.write(path, 'changed bytes');
    await expect(
      replayH06NativeTemporalHistory({ started: f.started, claim, history }),
    ).rejects.toThrow('h04-pin-changed');
    expect(mocks.replay).not.toHaveBeenCalled();
  },
);

it.each(['drift', 'nondeterminism'] as const)(
  'withholds the replay result on %s',
  async (which) => {
    const f = fixture();
    const history = await f.capture();
    const claim = f.claim();
    mocks.replay.mockImplementationOnce(async () => {
      if (which === 'nondeterminism') throw new Error('nondeterminism');
      f.write(f.dependency.path, 'changed during replay');
    });
    await expect(
      replayH06NativeTemporalHistory({ started: f.started, claim, history }),
    ).rejects.toThrow(which === 'drift' ? 'h04-pin-changed' : which);
  },
);
