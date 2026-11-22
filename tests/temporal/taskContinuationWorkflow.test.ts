import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { ContinuingTaskInput } from '../../src/contracts/localTask.js';
import { LocalTaskWorkflow } from '../../src/workflows/localTask.js';
import { startLocalTask } from '../../src/client/localTask.js';
import { bindTaskBackendClient } from '../../src/client/taskBackend.js';
import { controlTaskPlanning, makeTaskPlanningCommand } from '../../src/client/taskContinuation.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
const sdk = vi.hoisted(() => ({
  prepareLocalTask: vi.fn(),
  prepareSubstantialPlanning: vi.fn(),
  checkLocalTask: vi.fn(),
  writeLocalTask: vi.fn(),
  planLocalIntegration: vi.fn(),
  integrateLocalTask: vi.fn(),
  prepareLocalAcceptance: vi.fn(),
  finishLocalTask: vi.fn(),
  stopLocalTask: vi.fn(),
  holdTaskPlanning: vi.fn(),
  resumeTaskPlanning: vi.fn(),
  executeChild: vi.fn(),
  condition: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cancelled: false,
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: { nonRetryable: (s: string) => new Error(s) },
  CancellationScope: { nonCancellable: (run: () => unknown) => run() },
  ChildWorkflowCancellationType: { WAIT_CANCELLATION_COMPLETED: 'WAIT' },
  ParentClosePolicy: { REQUEST_CANCEL: 'REQUEST_CANCEL' },
  condition: sdk.condition,
  defineQuery: (s: string) => s,
  defineSignal: (s: string) => s,
  defineUpdate: (s: string) => s,
  executeChild: sdk.executeChild,
  isCancellation: () => sdk.cancelled,
  proxyActivities: () => sdk,
  setHandler: (name: string, handler: (...args: unknown[]) => unknown) =>
    sdk.handlers.set(name, handler),
  workflowInfo: () => ({ runId: 'run', taskQueue: 'q' }),
}));
beforeEach(() => {
  vi.resetAllMocks();
  sdk.handlers.clear();
  sdk.cancelled = false;
});
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = substantialTaskFixture(),
    input: ContinuingTaskInput = {
      ...f.substantialInput,
      schemaVersion: 10,
      continuation: { attempt: 0, previous: null },
    };
  const next: ContinuingTaskInput = {
    ...input,
    admission: { ...input.admission, preparation: { ...input.admission.preparation, revision: 2 } },
    continuation: { attempt: 1, previous: f.proof },
  };
  const command = makeTaskPlanningCommand({
    schemaVersion: 2,
    commandId: 'human-one',
    target: taskControlTarget(input),
    author: input.admission.preparation.owner,
    expectedRevision: 0,
    action: 'resume',
    attempt: 1,
    source: f.proof,
    payload: f.proof,
  });
  const ack = {
    commandId: command.commandId,
    hash: command.hash,
    revision: 1,
    authorization: f.proof,
  };
  const planning = {
    schemaVersion: 1,
    preparation: input.admission.preparation,
    reviewId: 'planning',
    request: f.proof,
  };
  sdk.prepareSubstantialPlanning.mockResolvedValue(planning);
  sdk.prepareLocalTask.mockResolvedValue(f.proof);
  sdk.checkLocalTask.mockResolvedValue({ status: 'PASS', manifest: f.proof });
  sdk.writeLocalTask.mockResolvedValue({ answer: f.proof, stop: f.proof, tree: f.proof });
  sdk.planLocalIntegration.mockResolvedValue(f.proof);
  sdk.integrateLocalTask.mockResolvedValue(f.proof);
  sdk.prepareLocalAcceptance.mockResolvedValue({ ...planning, reviewId: 'acceptance' });
  sdk.executeChild.mockResolvedValue({ status: 'reviewed', complete: true, manifest: f.proof });
  sdk.finishLocalTask.mockResolvedValue({ status: 'done', result: f.proof, projection: f.proof });
  sdk.stopLocalTask.mockResolvedValue(f.proof);
  sdk.holdTaskPlanning.mockResolvedValue(f.proof);
  sdk.resumeTaskPlanning.mockResolvedValue({ input: next, ack });
  const control = (value: unknown = command) =>
    sdk.handlers.get('taskPlanningControl')!(value) as Promise<unknown>;
  return { ...f, input, next, command, ack, control };
}
describe('durable pre-writer continuation and client', () => {
  it('waits after a failed planning round, deduplicates delivery and invalidates planning for the new requirements', async () => {
    const f = fixture();
    sdk.executeChild.mockResolvedValueOnce({
      status: 'reviewed',
      complete: false,
      manifest: f.proof,
    });
    sdk.condition.mockImplementation(async (ready: () => boolean) => {
      expect(sdk.handlers.get('localTaskStatus')!()).toMatchObject({
        phase: 'waiting-human',
        continuation: { waiting: true, held: f.proof },
        attempt: 0,
      });
      expect(sdk.writeLocalTask).not.toHaveBeenCalled();
      expect(await f.control()).toEqual(f.ack);
      expect(await f.control()).toEqual(f.ack);
      await expect(f.control({ ...f.command, hash: 'a'.repeat(64) })).rejects.toThrow(
        'task-command-id-conflict',
      );
      expect(ready()).toBe(true);
    });
    expect(await LocalTaskWorkflow(f.input)).toMatchObject({
      status: 'done',
      continuation: { revision: 1, history: [f.proof], waiting: false },
    });
    expect(sdk.prepareSubstantialPlanning.mock.calls.map((row: unknown[]) => row[0])).toEqual([
      f.input,
      f.next,
    ]);
    expect(sdk.prepareLocalTask).toHaveBeenCalledWith(f.next, f.proof);
    expect(sdk.resumeTaskPlanning).toHaveBeenCalledTimes(1);
    expect(sdk.handlers.get('localTaskInput')!()).toEqual(f.input);
    expect(sdk.handlers.get('localTaskStatus')!()).toMatchObject({
      phase: 'done',
      requirementsRevision: 2,
      attempt: 1,
    });
    expect(await f.control()).toEqual(f.ack);
    await expect(f.control({ ...f.command, commandId: 'late' })).rejects.toThrow(
      'task-resume-not-held',
    );
  });
  it('shares an in-flight duplicate and rejects competing or conflicting commands without another external call', async () => {
    const f = fixture();
    sdk.executeChild.mockResolvedValueOnce({
      status: 'reviewed',
      complete: false,
      manifest: f.proof,
    });
    sdk.condition.mockImplementation(async () => {
      let finish!: (value: unknown) => void;
      sdk.resumeTaskPlanning.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const first = f.control(),
        duplicate = f.control();
      await expect(f.control({ ...f.command, hash: 'b'.repeat(64) })).rejects.toThrow(
        'task-command-id-conflict',
      );
      await expect(f.control({ ...f.command, commandId: 'other' })).rejects.toThrow(
        'task-resume-not-held',
      );
      finish({ input: f.next, ack: f.ack });
      expect(await first).toEqual(f.ack);
      expect(await duplicate).toEqual(f.ack);
    });
    expect((await LocalTaskWorkflow(f.input)).status).toBe('done');
    expect(sdk.resumeTaskPlanning).toHaveBeenCalledTimes(1);
  });
  it.each(['invalid-receipt', 'authority', 'stale', 'target'])(
    'rejects %s and retains the held state for a correct command',
    async (defect) => {
      const f = fixture();
      sdk.executeChild.mockResolvedValueOnce({
        status: 'reviewed',
        complete: false,
        manifest: f.proof,
      });
      sdk.condition.mockImplementation(async () => {
        let command = f.command;
        if (defect === 'invalid-receipt')
          sdk.resumeTaskPlanning.mockResolvedValueOnce({
            input: f.next,
            ack: { ...f.ack, hash: 'c'.repeat(64) },
          });
        if (defect === 'authority')
          sdk.resumeTaskPlanning.mockRejectedValueOnce(new Error('human-unconfirmed'));
        if (defect === 'stale') command = { ...command, expectedRevision: 1 };
        if (defect === 'target')
          command = { ...command, target: { ...command.target, generation: 2 } };
        await expect(f.control(command)).rejects.toThrow();
        expect(sdk.handlers.get('localTaskStatus')!()).toMatchObject({
          continuation: { waiting: true, revision: 0 },
        });
        expect(await f.control()).toEqual(f.ack);
      });
      expect((await LocalTaskWorkflow(f.input)).status).toBe('done');
    },
  );
  it.each(['unknown', 'stop', 'cancel', 'restart'])(
    'preserves %s as blocked/cancelled with no writer',
    async (mode) => {
      const f = fixture();
      if (mode === 'restart') f.input.continuation = { attempt: 1, previous: f.proof };
      else
        sdk.executeChild.mockResolvedValueOnce({
          status: mode === 'unknown' ? 'blocked' : 'reviewed',
          complete: false,
          manifest: f.proof,
        });
      if (mode === 'stop') sdk.holdTaskPlanning.mockRejectedValueOnce(new Error('stop-unknown'));
      if (mode === 'cancel')
        sdk.condition.mockImplementationOnce(() => {
          sdk.cancelled = true;
          throw new Error('cancel');
        });
      expect(await LocalTaskWorkflow(f.input)).toMatchObject({
        status: mode === 'cancel' ? 'cancelled' : 'blocked',
        continuation: { waiting: false },
      });
      expect(sdk.writeLocalTask).not.toHaveBeenCalled();
    },
  );
  it('rejects control before held and refuses starting a later attempt as a new task', async () => {
    const f = fixture();
    sdk.prepareSubstantialPlanning.mockImplementation(async () => {
      await expect(f.control()).rejects.toThrow('task-resume-not-held');
      return {
        schemaVersion: 1,
        preparation: f.input.admission.preparation,
        reviewId: 'plan',
        request: f.proof,
      };
    });
    expect((await LocalTaskWorkflow(f.input)).status).toBe('done');
    await expect(
      startLocalTask(bindTaskBackendClient({} as Client, f.registration), f.next, 'q'),
    ).rejects.toThrow('task-continuation-start-forbidden');
  });
  it('builds and sends only payload-bound task RESUME, and verifies the acknowledgement', async () => {
    const f = fixture(),
      executeUpdate = vi.fn(async () => f.ack),
      client = { workflow: { getHandle: vi.fn(() => ({ executeUpdate })) } } as unknown as Client;
    bindTaskBackendClient(client, f.registration);
    expect(await controlTaskPlanning(client, f.command.target.workflowId, f.command)).toEqual(
      f.ack,
    );
    expect(executeUpdate).toHaveBeenCalledWith('taskPlanningControl', { args: [f.command] });
    for (const value of [
      { ...f.command, hash: '0'.repeat(64) },
      { ...f.command, target: { ...f.command.target, workflowId: 'other' } },
      { ...f.command, action: 'cancel' },
      { ...f.command, target: { ...f.command.target, roleId: 'reader' } },
    ])
      await expect(controlTaskPlanning(client, f.command.target.workflowId, value)).rejects.toThrow(
        'task-command-hash-invalid',
      );
    executeUpdate.mockResolvedValueOnce({ ...f.ack, revision: 2 });
    await expect(
      controlTaskPlanning(client, f.command.target.workflowId, f.command),
    ).rejects.toThrow('task-command-receipt-invalid');
    expect(() => makeTaskPlanningCommand({ ...f.command, action: 'pause' })).toThrow(
      'task-command-action',
    );
  });
});
