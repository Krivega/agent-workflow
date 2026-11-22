import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import { controlFixture } from './controlFixture.js';
import { readerDiagnostic, readerOperation } from '../../src/policy/readerStatus.js';
import { readerTarget, readerKey } from '../../src/policy/readerControl.js';
import { readerOperationId } from '../../src/adapters/codex/readerMessages.js';
import { readReaderStatus } from '../../src/client/readerStatus.js';
import type { ReaderStatus } from '../../src/contracts/readerControl.js';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(10000);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const f = controlFixture(),
    workflowId = readerKey(f.input);
  const status: ReaderStatus = {
    schemaVersion: 1,
    mode: 'running',
    revision: 0,
    attempt: 0,
    target: readerTarget(f.input, workflowId),
    runId: 'run',
    taskQueue: 'models',
    workerVersion: 'build-1',
    phase: 'loading',
    permit: f.permit,
    session: 'session',
    error: '',
    operation: readerOperation(f.input, 'loading', 0, false),
    diagnostic: readerDiagnostic({ mode: 'running', revision: 0, attempt: 0 }, '', false),
  };
  const description = {
    workflowId,
    runId: 'run',
    taskQueue: 'models',
    status: { name: 'RUNNING' },
    raw: {
      pendingActivities: [] as Record<string, unknown>[],
      pendingWorkflowTask: null as Record<string, unknown> | null,
      workflowExecutionInfo: { mostRecentWorkerVersionStamp: { buildId: 'last-build' } },
    },
  };
  const query = vi.fn(async () => status),
    describe = vi.fn(async () => description),
    reverse = vi.fn(async (): Promise<Record<string, unknown>> => ({ history: { events: [] } })),
    deadline = vi.fn(async (_time: number, fn: () => Promise<unknown>) => fn());
  const client = {
    options: { namespace: 'qualification' },
    workflow: { getHandle: vi.fn(() => ({ query, describe })) },
    connection: {
      withDeadline: deadline,
      workflowService: { getWorkflowExecutionHistoryReverse: reverse },
    },
  } as unknown as Client;
  return { ...f, workflowId, status, description, query, describe, reverse, deadline, client };
}

describe('reader diagnostics without new model calls', () => {
  it('keeps operation IDs stable and exposes their exact logical binding', () => {
    const f = controlFixture();
    for (const phase of ['creating', 'loading', 'answering'] as const) {
      const operation = readerOperation(f.input, phase, 1, false);
      expect(operation.key).not.toBeNull();
      expect(readerOperationId(f.input, operation.name, phase === 'creating' ? 0 : 1)).toMatch(
        /^reader-(create|load|answer)-[a-f0-9]{64}$/u,
      );
    }
    expect(readerOperation(f.input, 'preparing', 0, false).key).toBeNull();
    expect(readerOperation(f.input, 'registering', 0, true)).toEqual({ name: 'stop', key: null });
  });
  it('distinguishes terminal, human, technical and unknown outcomes with the next permitted action', () => {
    const state = { revision: 0, attempt: 0 };
    for (const mode of ['answered', 'cancelled'] as const)
      expect(readerDiagnostic({ ...state, mode }, '', false).kind).toBe('terminal');
    expect(readerDiagnostic({ ...state, mode: 'paused' }, '', false).kind).toBe('waiting-human');
    expect(
      readerDiagnostic({ ...state, mode: 'blocked' }, 'reader-model-budget-exhausted', false).kind,
    ).toBe('waiting-human');
    for (const mode of ['pausing', 'cancelling'] as const)
      expect(readerDiagnostic({ ...state, mode }, '', false).kind).toBe('stopping');
    expect(readerDiagnostic({ ...state, mode: 'blocked' }, 'offline', true).kind).toBe(
      'unknown-effect',
    );
    const hash = 'a'.repeat(64);
    expect(
      readerDiagnostic({ ...state, mode: 'blocked' }, 'reader-send-unknown:' + hash, false),
    ).toMatchObject({ kind: 'unknown-effect', evidenceHash: hash });
    for (const error of ['', 'missing input'])
      expect(readerDiagnostic({ ...state, mode: 'blocked' }, error, false).kind).toBe(
        'technical-error',
      );
  });
  it('combines one bound Query snapshot with primary service metadata and unchanged operation ID', async () => {
    const f = fixture(),
      observed = await readReaderStatus(f.client, f.workflowId);
    expect(observed.reader).toEqual(f.status);
    expect(observed.operationId).toBe(readerOperationId(f.input, 'load', 0));
    expect(observed.diagnostic.kind).toBe('running');
    expect(f.reverse).toHaveBeenCalledWith({
      namespace: 'qualification',
      execution: { workflowId: f.workflowId, runId: 'run' },
      maximumPageSize: 50,
    });
    expect(f.deadline.mock.calls.map(([time]) => time)).toEqual([15000, 11000, 11000]);
    f.status.operation = readerOperation(f.input, 'preparing', 0, false);
    expect((await readReaderStatus(f.client, f.workflowId)).operationId).toBeNull();
  });
  it('shows a queued activity or Workflow Task without claiming the Worker is offline', async () => {
    const f = fixture();
    f.description.raw.pendingActivities = [
      {
        activityId: 'one',
        activityType: { name: 'loadReader' },
        state: 1,
        attempt: 1,
        maximumAttempts: 1,
        scheduledTime: { seconds: 9, nanos: 0 },
      },
    ];
    expect(await readReaderStatus(f.client, f.workflowId)).toMatchObject({
      diagnostic: { kind: 'waiting-worker' },
      pending: [{ waitedMs: 1000, lastFailure: null }],
    });
    f.description.raw.pendingActivities = [];
    f.description.raw.pendingWorkflowTask = { state: 1 };
    f.query.mockRejectedValueOnce(new Error('deadline'));
    expect(await readReaderStatus(f.client, f.workflowId)).toMatchObject({
      reader: null,
      queryError: 'Error: deadline',
      diagnostic: { kind: 'waiting-worker' },
    });
  });
  it('reports activity failures and attempt bounds and preserves a confirmed human wait', async () => {
    const f = fixture();
    f.description.raw.pendingActivities = [
      {
        lastFailure: { message: 'temporarily offline' },
        attempt: 3,
        maximumAttempts: 5,
        scheduledTime: { seconds: 'bad' },
      },
      {},
      { scheduledTime: { seconds: 20 } },
    ];
    expect(await readReaderStatus(f.client, f.workflowId)).toMatchObject({
      diagnostic: { kind: 'technical-error' },
      pending: [
        { waitedMs: null },
        { waitedMs: null, id: '', type: '', attempt: 0, maximumAttempts: 0 },
        { waitedMs: 0 },
      ],
    });
    f.status.diagnostic = readerDiagnostic({ mode: 'paused', revision: 1, attempt: 0 }, '', false);
    expect((await readReaderStatus(f.client, f.workflowId)).diagnostic.kind).toBe('waiting-human');
    f.query.mockRejectedValueOnce(new Error('deadline'));
    expect((await readReaderStatus(f.client, f.workflowId)).diagnostic.kind).toBe(
      'technical-error',
    );
  });
  it('makes an incompatible Workflow Task visible instead of ordinary waiting', async () => {
    const f = fixture();
    f.reverse.mockResolvedValueOnce({
      history: {
        events: [
          {
            workflowTaskFailedEventAttributes: {
              failure: { message: 'nondeterminism' },
              workerVersion: { buildId: 'incompatible-build' },
            },
          },
        ],
      },
    });
    expect(await readReaderStatus(f.client, f.workflowId)).toMatchObject({
      diagnostic: { kind: 'workflow-error', reason: 'nondeterminism' },
      workerVersion: 'incompatible-build',
    });
    f.reverse.mockResolvedValueOnce({
      history: { events: [{ workflowTaskFailedEventAttributes: {} }] },
    });
    expect((await readReaderStatus(f.client, f.workflowId)).diagnostic.kind).toBe('workflow-error');
    f.reverse.mockResolvedValueOnce({
      history: {
        events: [
          { workflowTaskCompletedEventAttributes: {} },
          { workflowTaskFailedEventAttributes: {} },
        ],
      },
    });
    expect((await readReaderStatus(f.client, f.workflowId)).diagnostic.kind).toBe('running');
  });
  it('keeps missing evidence unknown, rejects a foreign Query and never restarts a closed execution', async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ ...f.status, schemaVersion: 2 } as unknown as ReaderStatus);
    f.reverse.mockResolvedValueOnce({});
    expect((await readReaderStatus(f.client, f.workflowId)).diagnostic.kind).toBe('unavailable');
    f.query.mockResolvedValueOnce({
      ...f.status,
      target: { ...f.status.target, workflowId: 'foreign' },
    });
    expect((await readReaderStatus(f.client, f.workflowId)).reader).toBeNull();
    f.query.mockResolvedValueOnce({ ...f.status, runId: 'foreign' });
    f.reverse.mockRejectedValueOnce(new Error('history offline'));
    expect(await readReaderStatus(f.client, f.workflowId)).toMatchObject({
      historyError: 'Error: history offline',
      diagnostic: { kind: 'unavailable' },
    });
    f.description.raw.pendingActivities = undefined as never;
    expect((await readReaderStatus(f.client, f.workflowId)).diagnostic.kind).toBe('running');
    f.description.status.name = 'COMPLETED';
    f.query.mockClear();
    f.reverse.mockClear();
    f.description.raw.workflowExecutionInfo = undefined as never;
    f.description.raw.pendingActivities = undefined as never;
    expect(await readReaderStatus(f.client, f.workflowId)).toMatchObject({
      diagnostic: { kind: 'terminal' },
      reader: null,
      workerVersion: null,
    });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.reverse).not.toHaveBeenCalled();
  });
});
