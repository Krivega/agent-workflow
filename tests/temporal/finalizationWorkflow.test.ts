import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { NativeConnection } from '@temporalio/worker';
import type { FinalizationInput } from '../../src/contracts/finalization.js';
import { FinalizationWorkflow } from '../../src/workflows/finalization.js';
import { finalizationTarget, finalizationKey } from '../../src/policy/finalization.js';
import { makeArchiveCommand, startFinalization } from '../../src/client/finalization.js';
import { bindTaskBackendClient } from '../../src/client/taskBackend.js';
import { createFinalizationWorker } from '../../src/worker/finalizationHost.js';
import { controlFixture } from './controlFixture.js';
import { join } from 'node:path';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { FinalizationActivities } from '../../src/contracts/finalization.js';
const sdk = vi.hoisted(() => ({
  archiveFinalizedTask: vi.fn(),
  reconcileFinalizedTask: vi.fn(),
  condition: vi.fn(),
  proxy: vi.fn(),
  create: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cancelled: false,
  protected: false,
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: { nonRetryable: (s: string) => new Error(s) },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: 'WAIT_CANCELLATION_COMPLETED' },
  CancellationScope: {
    current: () => ({
      get consideredCancelled() {
        return sdk.cancelled;
      },
    }),
    nonCancellable: async (run: () => Promise<unknown>) => {
      sdk.protected = true;
      try {
        return await run();
      } finally {
        sdk.protected = false;
      }
    },
  },
  condition: sdk.condition,
  defineQuery: (s: string) => s,
  defineSignal: (s: string) => s,
  isCancellation: (failure: unknown) => failure instanceof Error && failure.message === 'cancelled',
  proxyActivities: (options: unknown) => {
    sdk.proxy(options);
    return sdk;
  },
  setHandler: (name: string, fn: (...args: unknown[]) => unknown) => sdk.handlers.set(name, fn),
}));
vi.mock('@temporalio/worker', () => ({ Worker: { create: sdk.create } }));
beforeEach(() => {
  vi.resetAllMocks();
  sdk.handlers.clear();
  sdk.cancelled = false;
  sdk.protected = false;
});
function fixture() {
  const f = controlFixture();
  const input: FinalizationInput = {
    schemaVersion: 1,
    operation: 'archive',
    preparation: f.input.preparation,
    result: f.proof,
    command: {
      ...f.command('resume', 0, 0),
      schemaVersion: 3,
      action: 'archive',
      payload: f.proof,
    },
  };
  input.command = makeArchiveCommand({ ...input.command, target: finalizationTarget(input) });
  const archived = { status: 'archived' as const, manifest: f.proof, receipt: f.proof };
  sdk.archiveFinalizedTask.mockResolvedValue(archived);
  sdk.reconcileFinalizedTask.mockResolvedValue(archived);
  return { ...f, input, archived };
}
describe('independent archive workflow and client', () => {
  it('finishes independently and never waits on or modifies the task lifecycle', async () => {
    const f = fixture();
    expect(await FinalizationWorkflow(f.input)).toEqual(f.archived);
    expect(sdk.handlers.get('finalizationInput')!()).toEqual(f.input);
    expect(sdk.handlers.get('finalizationStatus')!()).toMatchObject({
      phase: 'archived',
      error: '',
      result: f.proof,
    });
    expect(sdk.proxy).toHaveBeenCalledWith({
      startToCloseTimeout: '30 minutes',
      heartbeatTimeout: '30 minutes',
      cancellationType: 'WAIT_CANCELLATION_COMPLETED',
      retry: { maximumAttempts: 1 },
    });
  });
  it.each([false, true])(
    'retains an unknown failure until an explicit reconcile, cause=%s',
    async (cause) => {
      const f = fixture();
      sdk.archiveFinalizedTask.mockRejectedValueOnce(
        cause ? new Error('activity', { cause: new Error('unknown') }) : 'unknown',
      );
      sdk.condition.mockImplementationOnce(async (ready: () => boolean) => {
        expect(sdk.handlers.get('finalizationStatus')!()).toMatchObject({
          phase: 'unknown',
          error: cause ? 'Error: unknown' : 'unknown',
        });
        expect(ready()).toBe(false);
        sdk.handlers.get('finalizationReconcile')!();
        expect(ready()).toBe(true);
      });
      expect(await FinalizationWorkflow(f.input)).toEqual(f.archived);
      expect(sdk.archiveFinalizedTask.mock.calls).toEqual([[f.input]]);
      expect(sdk.reconcileFinalizedTask.mock.calls).toEqual([[f.input]]);
    },
  );
  it('preserves cancellation and rejects an unauthorized operation before an archive activity', async () => {
    const f = fixture();
    await expect(
      FinalizationWorkflow({ ...f.input, operation: 'cleanup' } as never),
    ).rejects.toThrow('finalization-operation');
    expect(sdk.archiveFinalizedTask).not.toHaveBeenCalled();
    sdk.cancelled = true;
    sdk.archiveFinalizedTask.mockRejectedValueOnce(new Error('cancelled'));
    await expect(FinalizationWorkflow(f.input)).rejects.toThrow('cancelled');
    expect(sdk.condition).not.toHaveBeenCalled();
  });
  it('keeps timeout and cancellation unknown across read-only retries until primary evidence exists', async () => {
    const f = fixture();
    sdk.archiveFinalizedTask.mockImplementationOnce(async () => {
      sdk.cancelled = true;
      throw new Error('activity timeout');
    });
    sdk.reconcileFinalizedTask.mockResolvedValueOnce({
      status: 'unknown',
      reason: 'archive-effect-missing',
    });
    sdk.reconcileFinalizedTask.mockRejectedValueOnce(
      new Error('read-only unavailable', { cause: new Error('lookup unavailable') }),
    );
    sdk.condition.mockImplementation(async (ready: () => boolean) => {
      expect(sdk.protected).toBe(true);
      expect(sdk.handlers.get('finalizationStatus')!()).toMatchObject({
        phase: 'unknown',
        cancellationRequested: true,
      });
      expect(ready()).toBe(false);
      sdk.handlers.get('finalizationReconcile')!();
      expect(ready()).toBe(true);
    });
    expect(await FinalizationWorkflow(f.input)).toEqual(f.archived);
    expect(sdk.archiveFinalizedTask).toHaveBeenCalledTimes(1);
    expect(sdk.reconcileFinalizedTask).toHaveBeenCalledTimes(3);
  });
  it.each(['lookup failed', new Error('lookup failed')])(
    'keeps a read-only lookup failure unknown: %s',
    async (failure) => {
      const f = fixture();
      sdk.archiveFinalizedTask.mockRejectedValueOnce(new Error('outcome unknown'));
      sdk.reconcileFinalizedTask.mockRejectedValueOnce(failure);
      sdk.condition.mockImplementation(async () => {
        sdk.handlers.get('finalizationReconcile')!();
      });
      expect(await FinalizationWorkflow(f.input)).toEqual(f.archived);
      expect(sdk.archiveFinalizedTask).toHaveBeenCalledTimes(1);
      expect(sdk.reconcileFinalizedTask).toHaveBeenCalledTimes(2);
    },
  );
  it('starts one stable task/result/command operation and detects conflicts without replacing it', async () => {
    const f = fixture(),
      query = vi.fn(async () => f.input),
      handle = { query },
      start = vi.fn(async () => handle),
      client = { workflow: { start } } as unknown as Client;
    bindTaskBackendClient(client, f.registration);
    expect(await startFinalization(client, f.input, 'archives')).toBe(handle);
    expect(start).toHaveBeenCalledWith(
      'FinalizationWorkflow',
      expect.objectContaining({
        args: [f.input],
        taskQueue: 'archives',
        workflowId: finalizationKey(f.input),
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      }),
    );
    const conflict = {
      ...f.input,
      command: { ...f.input.command, source: { sha256: 'f'.repeat(64), bytes: 1 } },
    };
    conflict.command = makeArchiveCommand(conflict.command);
    await expect(startFinalization(client, conflict, 'archives')).rejects.toThrow(
      'finalization-start-conflict',
    );
    await expect(
      startFinalization(
        client,
        { ...f.input, command: { ...f.input.command, hash: '0'.repeat(64) } },
        'archives',
      ),
    ).rejects.toThrow('archive-command-hash-invalid');
  });
  it('registers an independent one-slot archive worker with the real archive activity', async () => {
    const f = fixture(),
      worker = { run: vi.fn() };
    sdk.create.mockResolvedValue(worker);
    expect(
      await createFinalizationWorker(
        {} as NativeConnection,
        'archives',
        'finalization.js',
        f.registration,
        f.authority,
        join(f.root, 'archive-host'),
      ),
    ).toBe(worker);
    expect(sdk.create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskQueue: 'archives',
        workflowsPath: 'finalization.js',
        maxConcurrentActivityTaskExecutions: 1,
        maxHeartbeatThrottleInterval: '1 second',
      }),
    );
    const options = sdk.create.mock.calls[0]![0] as {
      activities: FinalizationActivities;
    };
    expect(options.activities.archiveFinalizedTask).toBeTypeOf('function');
    const environment = new MockActivityEnvironment(
      {},
      { logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } },
    );
    await expect(
      environment.run(options.activities.archiveFinalizedTask, f.input),
    ).rejects.toThrow();
    await expect(options.activities.reconcileFinalizedTask(f.input)).rejects.toThrow();
  });
});
