import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalTaskActivities,
  LocalTaskControls,
  ManagedTaskInput,
  HumanManagedTaskInput,
} from '../../src/contracts/localTask.js';
import type { TaskExecutionControls } from '../../src/contracts/taskExecution.js';
import type { ReviewInput } from '../../src/contracts/review.js';
import type { ReaderCommandAck, PayloadReaderCommand } from '../../src/contracts/readerControl.js';
import { ManagedTaskWorkflow } from '../../src/workflows/taskExecution.js';
import { LocalTaskWorkflow } from '../../src/workflows/localTask.js';
import { makeTaskExecutionCommand } from '../../src/client/taskExecution.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import type {
  TaskHumanActivities,
  TaskHumanCommand,
  TaskHumanCommandContext,
  TaskHumanExecutionCheckpoint,
} from '../../src/contracts/taskHuman.js';

const sdk = vi.hoisted(() => ({
  prepareTaskExecution: vi.fn<TaskExecutionControls['prepareTaskExecution']>(),
  prepareTaskHuman: vi.fn<TaskHumanActivities['prepareTaskHuman']>(),
  verifyTaskHumanCommand: vi.fn<TaskHumanActivities['verifyTaskHumanCommand']>(),
  controlTaskHumanExecution: vi.fn<TaskHumanActivities['controlTaskHumanExecution']>(),
  finishTaskHuman: vi.fn<TaskHumanActivities['finishTaskHuman']>(),
  saveTaskHumanCheckpoint: vi.fn<TaskHumanActivities['saveTaskHumanCheckpoint']>(),
  loadTaskHumanCheckpoint: vi.fn<TaskHumanActivities['loadTaskHumanCheckpoint']>(),
  continuedFrom: undefined as string | undefined,
  ContinueSignal: class extends Error {},
  findTaskExecutionCommand: vi.fn<TaskExecutionControls['findTaskExecutionCommand']>(),
  interruptTaskExecution: vi.fn<TaskExecutionControls['interruptTaskExecution']>(),
  captureTaskExecutionBudget: vi.fn<TaskExecutionControls['captureTaskExecutionBudget']>(),
  saveTaskExecutionCheckpoint: vi.fn<TaskExecutionControls['saveTaskExecutionCheckpoint']>(),
  loadTaskExecutionCheckpoint: vi.fn<TaskExecutionControls['loadTaskExecutionCheckpoint']>(),
  continueAsNew: vi.fn<(...args: unknown[]) => Promise<never>>(),
  patched: true,
  suggested: false,
  holdTaskExecution: vi.fn<TaskExecutionControls['holdTaskExecution']>(),
  resumeTaskExecution: vi.fn<TaskExecutionControls['resumeTaskExecution']>(),
  stopLocalTask: vi.fn<LocalTaskControls['stopLocalTask']>(),
  prepareSubstantialPlanning: vi.fn<LocalTaskActivities['prepareSubstantialPlanning']>(),
  prepareLocalTask: vi.fn<LocalTaskActivities['prepareLocalTask']>(),
  checkLocalTask: vi.fn<LocalTaskActivities['checkLocalTask']>(),
  writeLocalTask: vi.fn<LocalTaskActivities['writeLocalTask']>(),
  planLocalIntegration: vi.fn<LocalTaskActivities['planLocalIntegration']>(),
  integrateLocalTask: vi.fn<LocalTaskActivities['integrateLocalTask']>(),
  recheckIntegratedTask: vi.fn<LocalTaskActivities['recheckIntegratedTask']>(),
  prepareLocalAcceptance: vi.fn<LocalTaskActivities['prepareLocalAcceptance']>(),
  finishLocalTask: vi.fn<LocalTaskActivities['finishLocalTask']>(),
  executeChild: vi.fn<(workflow: unknown, options: Record<string, unknown>) => Promise<unknown>>(),
  options: [] as Record<string, unknown>[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  watches: [] as { ready: () => boolean; resolve(): void; reject(error: Error): void }[],
  handlerCount: 0,
  active: null as { cancelled: boolean } | null,
}));
function flush() {
  for (const watch of [...sdk.watches])
    if (watch.ready()) {
      sdk.watches.splice(sdk.watches.indexOf(watch), 1);
      watch.resolve();
    }
}
vi.mock('@temporalio/workflow', () => {
  class Scope {
    cancelled = false;
    run<T>(fn: () => Promise<T>) {
      sdk.active = this;
      return fn();
    }
    cancel() {
      this.cancelled = true;
    }
    static nonCancellable<T>(fn: () => Promise<T>) {
      return fn();
    }
  }
  return {
    ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: 'WAIT_ACTIVITY' },
    ChildWorkflowCancellationType: { WAIT_CANCELLATION_COMPLETED: 'WAIT_CHILD' },
    ParentClosePolicy: { REQUEST_CANCEL: 'REQUEST_CANCEL' },
    ApplicationFailure: { nonRetryable: (message: string) => new Error(message) },
    ContinueAsNew: sdk.ContinueSignal,
    CancellationScope: Scope,
    allHandlersFinished: () => sdk.handlerCount === 0,
    condition: (ready: () => boolean) =>
      ready()
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => sdk.watches.push({ ready, resolve, reject })),
    continueAsNew: (...args: unknown[]) => sdk.continueAsNew(...args),
    defineQuery: (name: string) => name,
    defineSignal: (name: string) => name,
    defineUpdate: (name: string) => name,
    isCancellation: (error: unknown) => error instanceof Error && error.message === 'cancelled',
    patched: () => sdk.patched,
    workflowInfo: () => ({
      workflowId: 'aw/task/neutral/one',
      taskQueue: 'q',
      runId: 'run',
      continueAsNewSuggested: sdk.suggested,
      continuedFromExecutionRunId: sdk.continuedFrom,
    }),
    setHandler(name: string, handler: (...args: unknown[]) => unknown) {
      sdk.handlers.set(
        name,
        name !== 'taskExecutionControl' && name !== 'taskHuman'
          ? handler
          : async (...args) => {
              sdk.handlerCount++;
              try {
                return await handler(...args);
              } finally {
                sdk.handlerCount--;
                flush();
              }
            },
      );
    },
    proxyActivities(options: Record<string, unknown>) {
      sdk.options.push(options);
      if (options.taskQueue !== undefined) return sdk;
      return new Proxy(sdk, {
        get(target, key) {
          const method = target[key as keyof typeof target];
          if (typeof method !== 'function') return method;
          return async (...args: unknown[]) => {
            const scope = sdk.active;
            if (scope?.cancelled) throw new Error('cancelled');
            const result: unknown = await Reflect.apply(method, target, args);
            if (scope?.cancelled) throw new Error('cancelled');
            return result;
          };
        },
      });
    },
    executeChild: (workflow: unknown, options: Record<string, unknown>) =>
      sdk.executeChild(workflow, options),
  };
});
beforeEach(() => {
  vi.resetAllMocks();
  sdk.handlers.clear();
  sdk.watches.length = 0;
  sdk.options.length = 0;
  sdk.handlerCount = 0;
  sdk.active = null;
  sdk.suggested = false;
  sdk.patched = true;
  sdk.continuedFrom = undefined;
});
afterEach(() => vi.restoreAllMocks());
async function until(ready: () => boolean) {
  for (let attempt = 0; attempt < 100 && !ready(); attempt++) {
    flush();
    await new Promise<void>((done) => setImmediate(done));
  }
  expect(ready()).toBe(true);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const f = substantialTaskFixture(),
    input: ManagedTaskInput = {
      ...f.substantialInput,
      schemaVersion: 11,
      continuation: { attempt: 0, previous: null },
    },
    next: ManagedTaskInput = {
      ...input,
      admission: {
        ...input.admission,
        preparation: { ...input.admission.preparation, revision: 2 },
      },
      continuation: { attempt: 1, previous: f.proof },
    },
    journal = new Map<string, { key: string; ack: ReaderCommandAck }>(),
    command = (action: 'pause' | 'resume' | 'cancel', revision: number, current = input) =>
      makeTaskExecutionCommand({
        schemaVersion: 2,
        commandId: action + revision,
        target: taskControlTarget(current),
        expectedRevision: revision,
        author: current.admission.preparation.owner,
        action,
        attempt: current.continuation.attempt + (action === 'resume' ? 1 : 0),
        source: f.proof,
        payload: f.proof,
      }),
    record = (c: PayloadReaderCommand) => {
      const ack = {
        commandId: c.commandId,
        hash: c.hash,
        revision: c.expectedRevision + 1,
        authorization: f.proof,
      };
      journal.set(c.commandId, { key: JSON.stringify(c), ack });
      return ack;
    };
  sdk.findTaskExecutionCommand.mockImplementation(async (_input, c: PayloadReaderCommand) => {
    const prior = journal.get(c.commandId);
    if (prior === undefined) return null;
    if (prior.key !== JSON.stringify(c)) throw new Error('task-command-id-conflict');
    return prior.ack;
  });
  sdk.interruptTaskExecution.mockImplementation(async (_input, c: PayloadReaderCommand) =>
    record(c),
  );
  sdk.resumeTaskExecution.mockImplementation(async (_input, _held, c: PayloadReaderCommand) => ({
    input: next,
    ack: record(c),
  }));
  sdk.prepareTaskExecution.mockResolvedValue(f.proof);
  sdk.captureTaskExecutionBudget.mockResolvedValue({ limit: 15, used: 0, manifest: f.proof });
  sdk.saveTaskExecutionCheckpoint.mockResolvedValue(f.proof);
  const planning: ReviewInput = {
    schemaVersion: 1,
    preparation: input.admission.preparation,
    reviewId: 'planning',
    request: f.proof,
  };
  sdk.prepareSubstantialPlanning.mockResolvedValue(planning);
  sdk.prepareLocalTask.mockResolvedValue(f.proof);
  sdk.checkLocalTask.mockResolvedValue({ status: 'PASS', manifest: f.proof });
  const writer = { session: 'writer', answer: f.proof, stop: f.proof, tree: f.proof };
  sdk.writeLocalTask.mockResolvedValue(writer);
  sdk.planLocalIntegration.mockResolvedValue(f.proof);
  sdk.integrateLocalTask.mockResolvedValue(f.proof);
  sdk.prepareLocalAcceptance.mockResolvedValue({ ...planning, reviewId: 'acceptance' });
  sdk.executeChild.mockResolvedValue({ status: 'reviewed', complete: true, manifest: f.proof });
  sdk.finishLocalTask.mockResolvedValue({ status: 'done', result: f.proof, projection: f.proof });
  sdk.stopLocalTask.mockResolvedValue(f.proof);
  sdk.holdTaskExecution.mockResolvedValue({ status: 'held', held: f.proof });
  const status = () =>
      sdk.handlers.get('localTaskStatus')!() as {
        phase: string;
        attempt: number;
        waiting: boolean;
      },
    control = (c: PayloadReaderCommand) =>
      sdk.handlers.get('taskExecutionControl')!(c) as Promise<ReaderCommandAck>;
  return { ...f, input, next, executionCommand: command, control, status, writer, record, journal };
}
function humanFixture() {
  const f = fixture(),
    input: HumanManagedTaskInput = { ...f.input, schemaVersion: 12, startAdmission: f.proof };
  const manifest = {
    manifest: {
      schemaVersion: 1 as const,
      kind: 'task-human-gate-manifest' as const,
      target: { ...taskControlTarget(input), roleId: 'task' as const },
      card: { path: input.admission.preparation.card, ...f.proof },
      requirements: f.proof,
      declaration: f.proof,
      criteria: [
        {
          id: 'C1: результат проверен',
          text: 'Проверить результат',
          kind: 'human' as const,
          applicable: true,
          reason: 'Explicit owner criterion',
        },
      ],
    },
    ref: f.proof,
  };
  sdk.prepareTaskHuman.mockResolvedValue(manifest);
  sdk.verifyTaskHumanCommand.mockImplementation(async (_context, command) =>
    command.action === 'ASK'
      ? { kind: 'verified-task-human-command', action: 'ASK', command, proof: f.proof }
      : {
          kind: 'verified-task-human-command',
          action: 'DECIDE',
          command,
          accepted: command.accepted,
          proof: f.proof,
        },
  );
  sdk.finishTaskHuman.mockResolvedValue({ status: 'done', result: f.proof, projection: f.proof });
  sdk.controlTaskHumanExecution.mockImplementation(async (context, command) => ({
    input: context.input,
    ack: f.record(command),
  }));
  sdk.saveTaskHumanCheckpoint.mockResolvedValue(f.proof);
  const context = () => sdk.handlers.get('taskHumanState')!() as TaskHumanCommandContext | null;
  const command = (action: 'ASK' | 'DECIDE', accepted = true): TaskHumanCommand => {
    const state = context()!.state,
      fields = {
        schemaVersion: 1 as const,
        commandId: action.toLowerCase() + state.revision,
        hash: f.proof.sha256,
        target: state.current.manifest.target,
        manifest: state.current.ref,
        expectedRevision: state.revision,
        author: input.admission.preparation.owner,
        source: f.proof,
        questionId: state.pending?.questionId ?? 'q' + state.revision,
        criterionId: 'C1: результат проверен',
      };
    return action === 'ASK' ? { ...fields, action } : { ...fields, action, accepted };
  };
  const update = (value: unknown) => sdk.handlers.get('taskHuman')!(value) as Promise<unknown>;
  return { ...f, input, manifest, context, humanCommand: command, humanUpdate: update };
}
function humanCheckpoint(
  f: ReturnType<typeof humanFixture>,
  paused = false,
): TaskHumanExecutionCheckpoint {
  sdk.continuedFrom = 'predecessor';
  return {
    schemaVersion: 2,
    producer: { workflowId: 'aw/task/neutral/one', runId: 'predecessor' },
    initial: f.input,
    input: f.input,
    revision: 0,
    history: [],
    commands: [],
    previous: null,
    budget: { limit: 15, used: 0, manifest: f.proof },
    beganAt: 42,
    diagnostics: [],
    humanState: {
      schemaVersion: 1,
      current: f.manifest,
      revision: 0,
      closed: false,
      pending: null,
      decisions: [],
      history: [],
    },
    technical: {
      input: f.input,
      snapshot: f.proof,
      packet: {
        schemaVersion: 1,
        preparation: f.input.admission.preparation,
        reviewId: 'acceptance',
        request: f.proof,
      },
      acceptance: f.proof,
      records: [f.proof],
      stopped: f.proof,
    },
    wait: { kind: 'human-gates', paused },
  };
}
describe('v12 human gate controller after completed technical acceptance', () => {
  it.each([false, true])(
    'resumes an integrated failure in-place; changed files=%s',
    async (changed) => {
      const f = humanFixture(),
        original = f.input;
      sdk.checkLocalTask.mockImplementation(async (_input, _snapshot, stage) => ({
        status: stage === 'integrated' ? 'FAIL' : 'PASS',
        manifest: f.proof,
      }));
      sdk.resumeTaskExecution.mockImplementation(async (_input, _held, cmd) => ({
        input: original,
        ack: f.record(cmd),
      }));
      const packet = {
        schemaVersion: 1 as const,
        preparation: original.admission.preparation,
        reviewId: 'acceptance',
        request: f.proof,
      };
      if (changed) sdk.recheckIntegratedTask.mockRejectedValue(new Error('task-source-conflict'));
      else
        sdk.recheckIntegratedTask.mockResolvedValue({
          snapshot: f.proof,
          packet,
          records: [f.proof],
          stopped: f.proof,
        });
      const run = ManagedTaskWorkflow(original);
      await until(() => f.status().waiting);
      const command = makeTaskExecutionCommand({ ...f.executionCommand('resume', 0), attempt: 0 });
      await f.control(command);
      if (changed) {
        await until(() => sdk.recheckIntegratedTask.mock.calls.length === 1 && f.status().waiting);
        expect(sdk.executeChild).toHaveBeenCalledTimes(1);
        await f.control(f.executionCommand('cancel', 1));
        expect(await run).toMatchObject({ status: 'cancelled' });
      } else {
        await until(() => f.context() !== null);
        expect(sdk.executeChild).toHaveBeenCalledTimes(2);
        await f.humanUpdate(f.humanCommand('ASK'));
        await f.humanUpdate(f.humanCommand('DECIDE'));
        expect(await run).toMatchObject({ status: 'done' });
      }
      expect(sdk.writeLocalTask).toHaveBeenCalledOnce();
      expect(sdk.prepareSubstantialPlanning).toHaveBeenCalledOnce();
    },
  );
  it('uses versioned execution-held resume before technical acceptance', async () => {
    const f = humanFixture(),
      saved = humanCheckpoint(f);
    saved.technical = null;
    saved.wait = { kind: 'execution-held', held: f.proof, stop: f.proof };
    sdk.loadTaskHumanCheckpoint.mockResolvedValue(saved);
    sdk.resumeTaskExecution.mockImplementationOnce(async (_input, _held, command) => ({
      input: { ...f.input, continuation: { attempt: 1, previous: f.proof } },
      ack: f.record(command),
    }));
    const run = ManagedTaskWorkflow(f.input, f.proof);
    await until(() => f.status().waiting);
    await f.control(f.executionCommand('resume', 0));
    await until(() => f.context() !== null);
    expect(f.status().attempt).toBe(1);
    await f.humanUpdate(f.humanCommand('ASK'));
    await f.humanUpdate(f.humanCommand('DECIDE'));
    await until(() => sdk.finishTaskHuman.mock.calls.length === 1);
    expect(await run).toMatchObject({ status: 'done' });
    expect(sdk.writeLocalTask).toHaveBeenCalledOnce();
  });
  it('does not continue a human checkpoint superseded by a verified command while saving', async () => {
    const f = humanFixture(),
      saving = deferred<typeof f.proof>();
    sdk.saveTaskHumanCheckpoint.mockReturnValueOnce(saving.promise);
    const run = ManagedTaskWorkflow(f.input);
    await until(() => f.context() !== null);
    sdk.suggested = true;
    await until(() => sdk.saveTaskHumanCheckpoint.mock.calls.length === 1);
    await f.humanUpdate(f.humanCommand('ASK'));
    sdk.suggested = false;
    saving.resolve(f.proof);
    await until(() => f.status().phase === 'waiting-human-gates');
    expect(sdk.continueAsNew).not.toHaveBeenCalled();
    await f.humanUpdate(f.humanCommand('DECIDE'));
    await until(() => sdk.finishTaskHuman.mock.calls.length === 1);
    expect(await run).toMatchObject({ status: 'done' });
  });
  it('rejects an invalid human checkpoint version and can cancel a genuine restored execution hold', async () => {
    const f = humanFixture(),
      saved = humanCheckpoint(f);
    sdk.loadTaskHumanCheckpoint.mockResolvedValueOnce({
      ...saved,
      schemaVersion: 3,
    } as unknown as TaskHumanExecutionCheckpoint);
    await expect(ManagedTaskWorkflow(f.input, f.proof)).rejects.toThrow('human-checkpoint-version');
    saved.wait = { kind: 'execution-held', held: f.proof, stop: f.proof };
    saved.technical = null;
    sdk.loadTaskHumanCheckpoint.mockResolvedValueOnce(saved);
    const run = ManagedTaskWorkflow(f.input, f.proof);
    await until(() => f.status().waiting);
    await f.control(f.executionCommand('cancel', 0));
    await until(() => f.status().phase === 'cancelled');
    expect(await run).toMatchObject({ status: 'cancelled' });
    expect(sdk.writeLocalTask).not.toHaveBeenCalled();
  });
  it('retains a paused cold human wait and restores it without execution or hidden resume', async () => {
    const f = humanFixture();
    sdk.loadTaskHumanCheckpoint.mockResolvedValue(humanCheckpoint(f, true));
    const run = ManagedTaskWorkflow(f.input, f.proof);
    await until(() => f.status().phase === 'waiting-human-gates');
    expect(f.status().waiting).toBe(true);
    await expect(f.humanUpdate(f.humanCommand('ASK'))).rejects.toThrow('human-not-waiting');
    const command = { ...f.executionCommand('resume', 0), attempt: 0 };
    await f.control(command);
    await f.humanUpdate(f.humanCommand('ASK'));
    await f.humanUpdate(f.humanCommand('DECIDE'));
    await until(() => sdk.finishTaskHuman.mock.calls.length === 1);
    expect(await run).toMatchObject({ status: 'done' });
    expect(sdk.writeLocalTask).not.toHaveBeenCalled();
  });
  it.each(['reconcile', 'cancel', 'replan', 'raw cancellation', 'wait failure'] as const)(
    'retains completed technical proof after failed cold admission: %s',
    async (action) => {
      const f = humanFixture();
      sdk.loadTaskHumanCheckpoint.mockResolvedValue(humanCheckpoint(f));
      sdk.prepareTaskExecution.mockRejectedValueOnce(new Error('source verification unavailable'));
      const run = ManagedTaskWorkflow(f.input, f.proof);
      const failed =
        action === 'wait failure' ? expect(run).rejects.toThrow('condition failed') : null;
      await until(() => f.status().phase === 'human-admission-unknown');
      expect(sdk.writeLocalTask).not.toHaveBeenCalled();
      expect(sdk.holdTaskExecution).not.toHaveBeenCalled();
      if (action === 'raw cancellation' || action === 'wait failure') {
        sdk.watches
          .at(-1)!
          .reject(new Error(action === 'raw cancellation' ? 'cancelled' : 'condition failed'));
        if (failed !== null) {
          await failed;
          return;
        }
      } else if (action === 'cancel') await f.control(f.executionCommand('cancel', 0));
      else if (action === 'replan') {
        const next = {
          ...f.input,
          admission: f.next.admission,
          startAdmission: { ...f.proof, bytes: f.proof.bytes + 1 },
          continuation: { attempt: 1, previous: f.proof },
        };
        sdk.controlTaskHumanExecution.mockImplementationOnce(async (_context, command) => ({
          input: next,
          ack: f.record(command),
        }));
        sdk.prepareTaskHuman.mockResolvedValueOnce({
          ref: next.startAdmission,
          manifest: {
            ...f.manifest.manifest,
            declaration: next.startAdmission,
            target: { ...f.manifest.manifest.target, requirementsRevision: 2 },
          },
        });
        await f.control(f.executionCommand('resume', 0));
      } else sdk.handlers.get('localTaskReconcile')!();
      if (action === 'cancel' || action === 'raw cancellation') {
        await until(() => f.status().phase === 'cancelled');
        expect(await run).toMatchObject({ status: 'cancelled', stop: f.proof });
      } else {
        await until(() => f.status().phase === 'waiting-human-gates');
        await f.humanUpdate(f.humanCommand('ASK'));
        await f.humanUpdate(f.humanCommand('DECIDE'));
        await until(() => sdk.finishTaskHuman.mock.calls.length === 1);
        expect(await run).toMatchObject({ status: 'done' });
        expect(sdk.writeLocalTask).toHaveBeenCalledTimes(action === 'replan' ? 1 : 0);
      }
      expect(sdk.holdTaskExecution).not.toHaveBeenCalled();
    },
  );
  it('pauses and resumes a human wait without changing input, attempt or running the technical chain again', async () => {
    const f = humanFixture(),
      run = ManagedTaskWorkflow(f.input);
    await until(() => f.context() !== null);
    const completed = f.context()!.technical;
    await f.control(f.executionCommand('pause', 0));
    expect(f.status().waiting).toBe(true);
    await expect(f.humanUpdate(f.humanCommand('ASK'))).rejects.toThrow('human-not-waiting');
    const resume = { ...f.executionCommand('resume', 1), attempt: 0 };
    await f.control(resume);
    expect(f.status().waiting).toBe(false);
    expect(f.context()!.input).toEqual(f.input);
    expect(f.context()!.technical).toEqual(completed);
    await f.humanUpdate(f.humanCommand('ASK'));
    await f.humanUpdate(f.humanCommand('DECIDE'));
    await until(() => sdk.finishTaskHuman.mock.calls.length === 1);
    expect(await run).toMatchObject({ status: 'done' });
    expect(sdk.writeLocalTask).toHaveBeenCalledTimes(1);
    expect(sdk.checkLocalTask).toHaveBeenCalledTimes(3);
    expect(sdk.holdTaskExecution).not.toHaveBeenCalled();
    expect(sdk.controlTaskHumanExecution).toHaveBeenCalledTimes(2);
  });
  it('invalidates human consent and the completed technical candidate on an authorized requirements revision', async () => {
    const f = humanFixture(),
      next: HumanManagedTaskInput = {
        ...f.input,
        startAdmission: { ...f.proof, sha256: 'b'.repeat(64) },
        admission: {
          ...f.input.admission,
          preparation: { ...f.input.admission.preparation, revision: 2 },
        },
        continuation: { attempt: 1, previous: f.proof },
      };
    sdk.prepareTaskHuman.mockImplementation(async (input) => ({
      manifest: {
        ...f.manifest.manifest,
        target: { ...taskControlTarget(input), roleId: 'task' },
        declaration: input.startAdmission,
      },
      ref: input.startAdmission,
    }));
    const run = ManagedTaskWorkflow(f.input);
    await until(() => f.context() !== null);
    await f.humanUpdate(f.humanCommand('ASK'));
    await f.humanUpdate(f.humanCommand('DECIDE', false));
    sdk.controlTaskHumanExecution.mockImplementationOnce(async (_context, command) => ({
      input: next,
      ack: f.record(command),
    }));
    await f.control(f.executionCommand('resume', 0));
    await until(
      () =>
        f.context()?.input.admission.preparation.revision === 2 &&
        sdk.writeLocalTask.mock.calls.length === 2 &&
        f.status().phase === 'waiting-human-gates',
    );
    expect(f.context()!.state.decisions).toHaveLength(1);
    expect(f.context()!.state.current.manifest.target.requirementsRevision).toBe(2);
    expect(sdk.finishTaskHuman).not.toHaveBeenCalled();
    await f.humanUpdate(f.humanCommand('ASK'));
    await f.humanUpdate(f.humanCommand('DECIDE'));
    await until(() => sdk.finishTaskHuman.mock.calls.length === 1);
    expect(await run).toMatchObject({ status: 'done' });
    expect(sdk.holdTaskExecution).not.toHaveBeenCalled();
    expect(sdk.executeChild).toHaveBeenCalledTimes(4);
  });
  it('waits on pending/negative consent and finishes once after an exact verified acceptance', async () => {
    const f = humanFixture(),
      run = LocalTaskWorkflow(f.input);
    await until(() => f.context() !== null && f.status().phase === 'waiting-human-gates');
    expect(sdk.finishLocalTask).not.toHaveBeenCalled();
    expect(sdk.finishTaskHuman).not.toHaveBeenCalled();
    const before = f.context()!.technical;
    const ask = f.humanCommand('ASK');
    const receipt = await f.humanUpdate(ask);
    expect(await f.humanUpdate(ask)).toEqual(receipt);
    expect(sdk.verifyTaskHumanCommand).toHaveBeenCalledTimes(1);
    await f.humanUpdate(f.humanCommand('DECIDE', false));
    expect(sdk.finishTaskHuman).not.toHaveBeenCalled();
    await f.humanUpdate(f.humanCommand('ASK'));
    await f.humanUpdate(f.humanCommand('DECIDE'));
    await until(() => sdk.finishTaskHuman.mock.calls.length === 1);
    expect(await run).toMatchObject({ status: 'done' });
    expect(sdk.finishTaskHuman.mock.calls[0]![0]).toMatchObject({
      kind: 'task-human-finish',
      state: { closed: true },
      technical: before,
    });
    expect(sdk.writeLocalTask).toHaveBeenCalledTimes(1);
    expect(sdk.executeChild).toHaveBeenCalledTimes(2);
    expect(sdk.finishLocalTask).not.toHaveBeenCalled();
    expect(await f.humanUpdate(ask)).toEqual(receipt);
  });
  it('refuses execution control before its Node effect when a human command is being verified', async () => {
    const f = humanFixture(),
      run = ManagedTaskWorkflow(f.input);
    await until(() => f.context() !== null);
    const verification =
      deferred<Awaited<ReturnType<TaskHumanActivities['verifyTaskHumanCommand']>>>();
    sdk.verifyTaskHumanCommand.mockReturnValueOnce(verification.promise);
    const command = f.humanCommand('ASK'),
      update = f.humanUpdate(command);
    await expect(f.control(f.executionCommand('pause', 0))).rejects.toThrow(
      'human-command-pending',
    );
    expect(sdk.controlTaskHumanExecution).not.toHaveBeenCalled();
    verification.resolve({
      kind: 'verified-task-human-command',
      action: 'ASK',
      command,
      proof: f.proof,
    });
    expect(await update).toMatchObject({ commandId: command.commandId, revision: 1 });
    expect(f.context()!.state.revision).toBe(1);
    await f.control(f.executionCommand('cancel', 0));
    await until(() => f.status().phase === 'cancelled');
    expect(await run).toMatchObject({ status: 'cancelled' });
    expect(sdk.finishTaskHuman).not.toHaveBeenCalled();
  });
  it('refuses a new human verification before its Node effect while execution control is pending', async () => {
    const f = humanFixture(),
      run = ManagedTaskWorkflow(f.input);
    await until(() => f.context() !== null);
    const controlling =
      deferred<Awaited<ReturnType<TaskHumanActivities['controlTaskHumanExecution']>>>();
    sdk.controlTaskHumanExecution.mockReturnValueOnce(controlling.promise);
    const pause = f.executionCommand('pause', 0),
      update = f.control(pause);
    await until(() => sdk.controlTaskHumanExecution.mock.calls.length === 1);
    await expect(f.humanUpdate(f.humanCommand('ASK'))).rejects.toThrow('human-control-pending');
    expect(sdk.verifyTaskHumanCommand).not.toHaveBeenCalled();
    controlling.resolve({ input: f.input, ack: f.record(pause) });
    expect(await update).toMatchObject({ commandId: pause.commandId, revision: 1 });
    expect(f.context()!.state.revision).toBe(0);
    await f.control({ ...f.executionCommand('resume', 1), attempt: 0 });
    await f.humanUpdate(f.humanCommand('ASK'));
    await f.humanUpdate(f.humanCommand('DECIDE'));
    await until(() => sdk.finishTaskHuman.mock.calls.length === 1);
    expect(await run).toMatchObject({ status: 'done' });
  });
  it('refuses a raw checkpoint start and restores completed human waits only from server continuation', async () => {
    const f = humanFixture();
    await expect(ManagedTaskWorkflow(f.input, f.proof)).rejects.toThrow(
      'human-checkpoint-server-continuation-required',
    );
    expect(sdk.loadTaskHumanCheckpoint).not.toHaveBeenCalled();
    sdk.continuedFrom = 'predecessor';
    const state = {
      schemaVersion: 1 as const,
      current: f.manifest,
      revision: 0,
      closed: false,
      pending: null,
      decisions: [],
      history: [],
    };
    const technical = {
      input: f.input,
      snapshot: f.proof,
      packet: {
        schemaVersion: 1 as const,
        preparation: f.input.admission.preparation,
        reviewId: 'acceptance',
        request: f.proof,
      },
      acceptance: f.proof,
      records: [f.proof],
      stopped: f.proof,
    };
    sdk.loadTaskHumanCheckpoint.mockResolvedValue({
      schemaVersion: 2,
      producer: { workflowId: 'aw/task/neutral/one', runId: 'predecessor' },
      initial: f.input,
      input: f.input,
      revision: 0,
      history: [f.proof],
      commands: [],
      previous: null,
      budget: { limit: 15, used: 4, manifest: f.proof },
      beganAt: 42,
      diagnostics: [],
      humanState: state,
      technical,
      wait: { kind: 'human-gates', paused: false },
    });
    sdk.captureTaskExecutionBudget.mockResolvedValue({ limit: 15, used: 4, manifest: f.proof });
    const run = ManagedTaskWorkflow(f.input, f.proof);
    await until(() => f.status().phase === 'waiting-human-gates');
    expect(f.context()!.technical).toEqual(technical);
    expect(sdk.loadTaskHumanCheckpoint).toHaveBeenCalledExactlyOnceWith(
      f.input,
      f.proof,
      'predecessor',
    );
    await f.humanUpdate(f.humanCommand('ASK'));
    await f.humanUpdate(f.humanCommand('DECIDE'));
    await until(() => sdk.finishTaskHuman.mock.calls.length === 1);
    expect(await run).toMatchObject({ status: 'done' });
    expect(sdk.writeLocalTask).not.toHaveBeenCalled();
    expect(sdk.checkLocalTask).not.toHaveBeenCalled();
    expect(sdk.executeChild).not.toHaveBeenCalled();
  });
  it('continues an unanswered human wait with its own producer binding and no stop/re-execution', async () => {
    const f = humanFixture();
    sdk.continueAsNew.mockRejectedValue(new sdk.ContinueSignal('server continuation'));
    const run = ManagedTaskWorkflow(f.input),
      rejected = expect(run).rejects.toThrow('server continuation');
    await until(() => f.status().phase === 'waiting-human-gates');
    sdk.suggested = true;
    await until(() => sdk.continueAsNew.mock.calls.length === 1);
    await rejected;
    expect(sdk.saveTaskHumanCheckpoint.mock.calls[0]![0]).toMatchObject({
      schemaVersion: 2,
      producer: { workflowId: 'aw/task/neutral/one', runId: 'run' },
      wait: { kind: 'human-gates' },
      technical: { input: f.input },
      humanState: { revision: 0 },
    });
    expect(sdk.stopLocalTask).toHaveBeenCalledOnce();
    expect(sdk.finishTaskHuman).not.toHaveBeenCalled();
  });
  it.each(['current', 'legacy'])('retains v12 checkpoint diagnostics: %s', async (mode) => {
    const f = humanFixture(),
      saved = humanCheckpoint(f, true),
      pause = f.executionCommand('pause', 0),
      pauseAck = f.record(pause),
      old = { phase: 'checkpoint-unknown', error: 'Error: earlier save unavailable' },
      recent = { phase: 'checkpoint-unknown', error: 'Error: restore unavailable' };
    sdk.patched = mode === 'current';
    sdk.loadTaskHumanCheckpoint
      .mockRejectedValueOnce(new Error('restore unavailable'))
      .mockResolvedValue({
        ...saved,
        revision: 1,
        commands: [pauseAck.authorization],
        diagnostics: [old],
      });
    sdk.continueAsNew.mockRejectedValue(new sdk.ContinueSignal('server continuation'));
    const run = ManagedTaskWorkflow(f.input, f.proof),
      rejected = expect(run).rejects.toThrow('server continuation');
    await until(() => f.status().phase === 'checkpoint-unknown');
    const repeat = f.control(pause);
    await until(() => sdk.handlerCount === 1);
    expect(sdk.findTaskExecutionCommand).not.toHaveBeenCalled();
    expect(sdk.prepareTaskExecution).not.toHaveBeenCalled();
    sdk.handlers.get('localTaskReconcile')!();
    await until(() => sdk.findTaskExecutionCommand.mock.calls.length === 1);
    expect(await repeat).toEqual(pauseAck);
    await until(() => f.status().phase === 'waiting-human-gates');
    sdk.suggested = true;
    await until(() => sdk.continueAsNew.mock.calls.length === 1);
    await rejected;
    expect(sdk.saveTaskHumanCheckpoint.mock.calls[0]![0]).toMatchObject({
      diagnostics: sdk.patched ? [old, recent] : [recent, old],
      commands: [pauseAck.authorization],
      wait: { kind: 'human-gates', paused: true },
      previous: f.proof,
    });
    expect(sdk.controlTaskHumanExecution).not.toHaveBeenCalled();
    expect(sdk.writeLocalTask).not.toHaveBeenCalled();
  });
  it('keeps execution-held continuation distinct from human gates and propagates server rollover', async () => {
    const f = humanFixture();
    sdk.checkLocalTask.mockResolvedValueOnce({ status: 'FAIL', manifest: f.proof });
    sdk.continueAsNew.mockRejectedValue(new sdk.ContinueSignal('held continuation'));
    const run = ManagedTaskWorkflow(f.input),
      rejected = expect(run).rejects.toThrow('held continuation');
    await until(() => f.status().waiting);
    sdk.suggested = true;
    await until(() => sdk.continueAsNew.mock.calls.length === 1);
    await rejected;
    expect(sdk.saveTaskHumanCheckpoint.mock.calls[0]![0]).toMatchObject({
      schemaVersion: 2,
      wait: { kind: 'execution-held', held: f.proof, stop: f.proof },
      technical: null,
      humanState: { revision: 0 },
    });
    expect(sdk.writeLocalTask).not.toHaveBeenCalled();
    expect(sdk.finishTaskHuman).not.toHaveBeenCalled();
  });
  it('keeps a v12 execution-held checkpoint failure unknown until reconciliation', async () => {
    const f = humanFixture();
    sdk.checkLocalTask.mockResolvedValueOnce({ status: 'FAIL', manifest: f.proof });
    sdk.saveTaskHumanCheckpoint.mockRejectedValueOnce(new Error('checkpoint write uncertain'));
    sdk.continueAsNew.mockRejectedValue(new sdk.ContinueSignal('held continuation'));
    const run = ManagedTaskWorkflow(f.input),
      rejected = expect(run).rejects.toThrow('held continuation');
    await until(() => f.status().waiting);
    sdk.suggested = true;
    await until(() => f.status().phase === 'checkpoint-unknown');
    expect(sdk.saveTaskHumanCheckpoint).toHaveBeenCalledOnce();
    expect(sdk.continueAsNew).not.toHaveBeenCalled();
    sdk.handlers.get('localTaskReconcile')!();
    await until(() => sdk.continueAsNew.mock.calls.length === 1);
    await rejected;
    expect(sdk.saveTaskHumanCheckpoint).toHaveBeenCalledTimes(2);
    expect(sdk.writeLocalTask).not.toHaveBeenCalled();
  });
  it('keeps an unknown finish closed and retries only its same request after explicit reconciliation', async () => {
    const f = humanFixture(),
      run = ManagedTaskWorkflow(f.input);
    sdk.finishTaskHuman.mockRejectedValueOnce(new Error('uncertain projection'));
    await until(() => f.context() !== null);
    await f.humanUpdate(f.humanCommand('ASK'));
    await f.humanUpdate(f.humanCommand('DECIDE'));
    await until(() => f.status().phase === 'completion-unknown');
    expect(f.context()!.state.closed).toBe(true);
    expect(sdk.finishTaskHuman).toHaveBeenCalledOnce();
    await expect(f.humanUpdate(f.humanCommand('ASK'))).rejects.toThrow('human-closed');
    sdk.handlers.get('localTaskReconcile')!();
    await until(() => sdk.finishTaskHuman.mock.calls.length === 2);
    expect(await run).toMatchObject({ status: 'done' });
    expect(sdk.finishTaskHuman.mock.calls[0]).toEqual(sdk.finishTaskHuman.mock.calls[1]);
    expect(sdk.writeLocalTask).toHaveBeenCalledOnce();
  });
});
describe('active task Workflow interruption and draining', () => {
  it('accepts interruption during admission before planning can start', async () => {
    const f = fixture(),
      preparing = deferred<typeof f.proof>();
    sdk.prepareTaskExecution.mockReturnValueOnce(preparing.promise);
    const run = ManagedTaskWorkflow(f.input),
      update = f.control(f.executionCommand('pause', 0));
    await until(() => sdk.findTaskExecutionCommand.mock.calls.length === 1);
    expect(sdk.interruptTaskExecution).not.toHaveBeenCalled();
    preparing.resolve(f.proof);
    await until(() => sdk.interruptTaskExecution.mock.calls.length === 1);
    await update;
    await until(() => f.status().waiting);
    await f.control(f.executionCommand('cancel', 1));
    await until(() => f.status().phase === 'cancelled');
    expect(await run).toMatchObject({ status: 'cancelled' });
    expect(sdk.executeChild).not.toHaveBeenCalled();
  });
  it('keeps a control handler pending until the primary checkpoint restoration completes', async () => {
    const f = fixture(),
      restoring =
        deferred<Awaited<ReturnType<TaskExecutionControls['loadTaskExecutionCheckpoint']>>>();
    sdk.loadTaskExecutionCheckpoint.mockReturnValueOnce(restoring.promise);
    const run = LocalTaskWorkflow(f.input, f.proof),
      update = f.control(f.executionCommand('cancel', 0));
    await new Promise<void>((done) => setImmediate(done));
    expect(sdk.findTaskExecutionCommand).not.toHaveBeenCalled();
    restoring.resolve({
      initial: f.input,
      input: f.input,
      revision: 0,
      held: f.proof,
      history: [],
      commands: [],
      previous: null,
      budget: { limit: 15, used: 4, manifest: f.proof },
      beganAt: 42,
      diagnostics: [],
      stop: f.proof,
    });
    await until(() => sdk.findTaskExecutionCommand.mock.calls.length === 1);
    await update;
    await until(() => f.status().phase === 'cancelled');
    expect(await run).toMatchObject({ status: 'cancelled' });
    expect(sdk.prepareTaskExecution).not.toHaveBeenCalled();
    expect(sdk.executeChild).not.toHaveBeenCalled();
  });
  it('honours cancellation accepted during held publication before considering rollover', async () => {
    const f = fixture(),
      writing = deferred<typeof f.writer>(),
      publishing = deferred<{ status: 'held'; held: typeof f.proof }>();
    sdk.writeLocalTask.mockReturnValueOnce(writing.promise);
    sdk.holdTaskExecution.mockReturnValueOnce(publishing.promise);
    sdk.suggested = true;
    const run = ManagedTaskWorkflow(f.input);
    await until(() => f.status().phase === 'writing');
    await f.control(f.executionCommand('pause', 0));
    writing.resolve(f.writer);
    await until(() => sdk.holdTaskExecution.mock.calls.length === 1);
    await f.control(f.executionCommand('cancel', 1));
    publishing.resolve({ status: 'held', held: f.proof });
    await until(() => f.status().phase === 'cancelled');
    expect(await run).toMatchObject({ status: 'cancelled' });
    expect(sdk.saveTaskExecutionCheckpoint).not.toHaveBeenCalled();
    expect(sdk.continueAsNew).not.toHaveBeenCalled();
  });
  it.each(['planning', 'acceptance'])(
    'retains an unreviewed %s proof and does not substitute a PASS',
    async (phase) => {
      const f = fixture();
      if (phase === 'acceptance')
        sdk.executeChild.mockResolvedValueOnce({
          status: 'reviewed',
          complete: true,
          manifest: f.proof,
        });
      sdk.executeChild.mockResolvedValueOnce({ status: 'not-applicable', plan: f.proof });
      const run = ManagedTaskWorkflow(f.input);
      await until(() => f.status().waiting);
      await f.control(f.executionCommand('cancel', 0));
      await until(() => f.status().phase === 'cancelled');
      expect(await run).toMatchObject({
        status: 'cancelled',
        error: `Error: task-${phase}-failed:${f.proof.sha256}`,
      });
      expect(sdk.finishLocalTask).not.toHaveBeenCalled();
    },
  );
  it.each(['done', 'cancelled'])(
    'preserves actual %s after cancellation drains a held finishing Activity',
    async (status) => {
      const f = fixture(),
        finishing = deferred<{
          status: 'done';
          result: typeof f.proof;
          projection: typeof f.proof;
        }>(),
        done = { status: 'done' as const, result: f.proof, projection: f.proof };
      sdk.finishLocalTask.mockReturnValueOnce(finishing.promise);
      if (status === 'done') sdk.holdTaskExecution.mockResolvedValueOnce(done);
      const run = ManagedTaskWorkflow(f.input);
      await until(() => f.status().phase === 'finishing');
      await f.control(f.executionCommand('cancel', 0));
      await until(() => sdk.stopLocalTask.mock.calls.length === 1);
      finishing.resolve(done);
      await until(() => f.status().phase === status);
      expect(await run).toMatchObject({ status });
      expect(sdk.finishLocalTask).toHaveBeenCalledTimes(1);
    },
  );
  it('retains a failed checkpoint save, waits for reconciliation and then rolls over with the original diagnostic', async () => {
    const f = fixture();
    sdk.executeChild.mockResolvedValueOnce({
      status: 'reviewed',
      complete: false,
      manifest: f.proof,
    });
    sdk.suggested = true;
    sdk.saveTaskExecutionCheckpoint.mockRejectedValueOnce(
      new Error('primary-checkpoint-write-unknown'),
    );
    sdk.continueAsNew.mockImplementation(async () => {
      throw new Error('CONTINUE_AFTER_RECONCILE');
    });
    const run = ManagedTaskWorkflow(f.input),
      completed = expect(run).rejects.toThrow('CONTINUE_AFTER_RECONCILE');
    await until(() => f.status().phase === 'checkpoint-unknown');
    await expect(f.control(f.executionCommand('resume', 0))).rejects.toThrow(
      'task-budget-or-checkpoint-unknown',
    );
    expect(sdk.saveTaskExecutionCheckpoint).toHaveBeenCalledTimes(1);
    sdk.handlers.get('localTaskReconcile')!();
    await until(() => sdk.continueAsNew.mock.calls.length === 1);
    await completed;
    expect(sdk.saveTaskExecutionCheckpoint.mock.calls[1]![0].diagnostics).toContainEqual({
      phase: 'checkpoint-unknown',
      error: 'Error: primary-checkpoint-write-unknown',
    });
  });
  it('drains a cancelled checkpoint save instead of attempting rollover', async () => {
    const f = fixture();
    sdk.executeChild.mockResolvedValueOnce({
      status: 'reviewed',
      complete: false,
      manifest: f.proof,
    });
    sdk.suggested = true;
    sdk.saveTaskExecutionCheckpoint.mockRejectedValueOnce(new Error('cancelled'));
    const run = ManagedTaskWorkflow(f.input);
    await until(() => f.status().phase === 'cancelled');
    expect(await run).toMatchObject({ status: 'cancelled' });
    expect(sdk.continueAsNew).not.toHaveBeenCalled();
  });
  it('propagates an unexpected held wait failure without mislabelling it terminal cancellation', async () => {
    const f = fixture();
    sdk.executeChild.mockResolvedValueOnce({
      status: 'reviewed',
      complete: false,
      manifest: f.proof,
    });
    const run = ManagedTaskWorkflow(f.input),
      rejected = expect(run).rejects.toThrow('unknown-scheduler');
    await until(() => f.status().waiting);
    sdk.watches.pop()!.reject(new Error('unknown-scheduler'));
    await rejected;
    expect(f.status().phase).not.toBe('cancelled');
  });
  it('rejects an externally supplied resumed start before admission or models', async () => {
    const f = fixture();
    await expect(ManagedTaskWorkflow(f.next)).rejects.toThrow('task-continuation-start-forbidden');
    expect(sdk.prepareTaskExecution).not.toHaveBeenCalled();
    expect(sdk.executeChild).not.toHaveBeenCalled();
  });
  it.each(['negative-attempt', 'initial-previous', 'lost-previous'])(
    'rejects malformed Input11 continuation %s before any Activity',
    async (defect) => {
      const f = fixture(),
        continuation = {
          attempt: defect === 'negative-attempt' ? -1 : defect === 'lost-previous' ? 1 : 0,
          previous: defect === 'initial-previous' ? f.proof : null,
        };
      await expect(ManagedTaskWorkflow({ ...f.input, continuation })).rejects.toThrow(
        'task-continuation-invalid',
      );
      expect(sdk.options).toEqual([]);
      expect(sdk.prepareTaskExecution).not.toHaveBeenCalled();
      expect(sdk.executeChild).not.toHaveBeenCalled();
    },
  );
  it('deduplicates a pending identical command and refuses conflicting commands before the original authority response', async () => {
    const f = fixture(),
      writing = deferred<typeof f.writer>(),
      response = deferred<ReaderCommandAck>();
    sdk.writeLocalTask.mockReturnValueOnce(writing.promise);
    sdk.interruptTaskExecution.mockReturnValueOnce(response.promise);
    const run = ManagedTaskWorkflow(f.input);
    await until(() => f.status().phase === 'writing');
    const pause = f.executionCommand('pause', 0),
      update = f.control(pause),
      duplicate = f.control(pause);
    await until(() => sdk.interruptTaskExecution.mock.calls.length === 1);
    await expect(f.control({ ...pause, hash: 'f'.repeat(64) })).rejects.toThrow(
      'task-command-id-conflict',
    );
    await expect(f.control({ ...pause, commandId: 'competing' })).rejects.toThrow(
      'task-command-pending',
    );
    const ack = f.record(pause);
    response.resolve(ack);
    expect(await update).toEqual(ack);
    expect(await duplicate).toEqual(ack);
    writing.resolve(f.writer);
    await until(() => f.status().waiting);
    await f.control(f.executionCommand('cancel', 1));
    await until(() => f.status().phase === 'cancelled');
    expect(await run).toMatchObject({ status: 'cancelled' });
    expect(sdk.interruptTaskExecution).toHaveBeenCalledTimes(2);
  });
  it.each(['bound', 'wrong-run', 'wrong-manifest', 'wrong-size', 'no-grant', 'rewound'])(
    'accepts a budget increase only for the retained receipt and Run ID: %s',
    async (mode) => {
      const f = fixture(),
        old = { limit: 7, used: 2, manifest: f.proof },
        next = {
          limit: 9,
          used: mode === 'rewound' ? 1 : 2,
          manifest: f.proof,
          ...(mode === 'no-grant'
            ? {}
            : {
                extendedFrom: {
                  ...f.proof,
                  runId: mode === 'wrong-run' ? 'other' : 'run',
                  sha256: mode === 'wrong-manifest' ? 'e'.repeat(64) : f.proof.sha256,
                  bytes: mode === 'wrong-size' ? 0 : f.proof.bytes,
                },
              }),
        };
      sdk.captureTaskExecutionBudget.mockResolvedValueOnce(old).mockResolvedValue(next);
      const outcome = await ManagedTaskWorkflow(f.input);
      if (mode === 'bound')
        expect(outcome).toMatchObject({ budget: { limit: 9, used: 2 }, budgetFailure: '' });
      else
        expect(outcome).toMatchObject({
          budget: null,
          budgetFailure: 'Error: task-budget-rewound',
        });
    },
  );
  it('keeps unknown spent budget and its original diagnostic while forbidding RESUME and rollover', async () => {
    const f = fixture();
    sdk.captureTaskExecutionBudget.mockRejectedValue(new Error('task-budget-rewound'));
    sdk.suggested = true;
    const run = ManagedTaskWorkflow(f.input);
    await until(() => f.status().waiting);
    await expect(f.control(f.executionCommand('resume', 0))).rejects.toThrow(
      'task-budget-or-checkpoint-unknown',
    );
    expect(sdk.continueAsNew).not.toHaveBeenCalled();
    await f.control(f.executionCommand('cancel', 0));
    await until(() => f.status().phase === 'cancelled');
    const outcome = await run;
    expect(outcome.diagnostics).toContainEqual({
      phase: 'budget-unknown',
      error: 'Error: task-budget-rewound',
    });
    expect(outcome).toMatchObject({
      status: 'cancelled',
      budget: null,
      budgetFailure: 'Error: task-budget-rewound',
    });
    expect(sdk.executeChild).not.toHaveBeenCalled();
  });
  it('does not roll over a checkpoint snapshot superseded by an accepted RESUME during its save', async () => {
    const f = fixture(),
      saving = deferred<typeof f.proof>();
    sdk.executeChild.mockResolvedValueOnce({
      status: 'reviewed',
      complete: false,
      manifest: f.proof,
    });
    sdk.suggested = true;
    sdk.saveTaskExecutionCheckpoint.mockReturnValueOnce(saving.promise);
    const run = ManagedTaskWorkflow(f.input);
    await until(() => sdk.saveTaskExecutionCheckpoint.mock.calls.length === 1);
    await f.control(f.executionCommand('resume', 0));
    saving.resolve(f.proof);
    await until(() => f.status().phase === 'done');
    expect(await run).toMatchObject({ status: 'done' });
    expect(sdk.continueAsNew).not.toHaveBeenCalled();
  });
  it('retains a checkpoint restore failure until explicit reconciliation without launching models', async () => {
    const f = fixture();
    sdk.loadTaskExecutionCheckpoint
      .mockRejectedValueOnce(new Error('original-journal-unknown'))
      .mockResolvedValue({
        initial: f.input,
        input: f.input,
        revision: 0,
        held: f.proof,
        history: [],
        commands: [],
        previous: null,
        budget: { limit: 15, used: 4, manifest: f.proof },
        beganAt: 42,
        diagnostics: [],
        stop: f.proof,
      });
    const run = ManagedTaskWorkflow(f.input, f.proof);
    await until(() => f.status().phase === 'checkpoint-unknown');
    expect(sdk.prepareTaskExecution).not.toHaveBeenCalled();
    expect(sdk.executeChild).not.toHaveBeenCalled();
    sdk.handlers.get('localTaskReconcile')!();
    await until(() => f.status().waiting);
    await f.control(f.executionCommand('cancel', 0));
    await until(() => f.status().phase === 'cancelled');
    expect(await run).toMatchObject({
      status: 'cancelled',
      diagnostics: [{ phase: 'checkpoint-unknown', error: 'Error: original-journal-unknown' }],
    });
  });
  it('drains a held pending RESUME after raw cancellation even when the control Activity returns a late completion', async () => {
    const f = fixture(),
      response = deferred<{ input: ManagedTaskInput; ack: ReaderCommandAck }>();
    sdk.executeChild.mockResolvedValueOnce({
      status: 'reviewed',
      complete: false,
      manifest: f.proof,
    });
    sdk.resumeTaskExecution.mockReturnValueOnce(response.promise);
    let settled = false;
    const run = ManagedTaskWorkflow(f.input).finally(() => {
      settled = true;
    });
    await until(() => f.status().waiting);
    const command = f.executionCommand('resume', 0),
      update = f.control(command);
    await until(() => sdk.resumeTaskExecution.mock.calls.length === 1);
    const watch = sdk.watches.pop()!;
    watch.reject(new Error('cancelled'));
    await until(() => sdk.stopLocalTask.mock.calls.length === 2);
    expect(settled).toBe(false);
    const ack = f.record(command);
    response.resolve({ input: f.next, ack });
    expect(await update).toEqual(ack);
    await until(() => settled);
    expect(await run).toMatchObject({ status: 'cancelled', commands: [f.proof] });
    expect(sdk.prepareSubstantialPlanning).toHaveBeenCalledTimes(1);
    expect(sdk.writeLocalTask).not.toHaveBeenCalled();
  });
  it('applies the original durable outcome after a lost Update response instead of treating its unapplied ack as already delivered', async () => {
    const f = fixture(),
      writing = deferred<typeof f.writer>();
    sdk.writeLocalTask.mockReturnValueOnce(writing.promise);
    sdk.interruptTaskExecution.mockImplementationOnce(
      async (_input, command: PayloadReaderCommand) => {
        f.record(command);
        throw new Error('update-response-lost');
      },
    );
    const run = ManagedTaskWorkflow(f.input);
    await until(() => f.status().phase === 'writing');
    const pause = f.executionCommand('pause', 0);
    await expect(f.control(pause)).rejects.toThrow('update-response-lost');
    expect(f.status().phase).toBe('writing');
    await f.control(pause);
    await until(() => sdk.stopLocalTask.mock.calls.length === 1);
    writing.resolve(f.writer);
    await until(() => f.status().waiting);
    await f.control(f.executionCommand('cancel', 1));
    await until(() => f.status().phase === 'cancelled');
    expect(await run).toMatchObject({ status: 'cancelled' });
    expect(sdk.writeLocalTask).toHaveBeenCalledTimes(1);
  });
  it.each(['current', 'legacy'])('restores held evidence: %s', async (mode) => {
    const f = fixture();
    const writing = deferred<typeof f.writer>();
    sdk.writeLocalTask.mockReturnValueOnce(writing.promise);
    sdk.stopLocalTask.mockRejectedValueOnce(new Error('original-stop-unknown'));
    sdk.captureTaskExecutionBudget
      .mockResolvedValueOnce({ limit: 15, used: 0, manifest: f.proof })
      .mockResolvedValue({ limit: 15, used: 4, manifest: f.proof });
    sdk.suggested = true;
    sdk.continueAsNew.mockImplementation(async () => {
      sdk.suggested = false;
      throw new Error('CONTINUE_AS_NEW');
    });
    const first = ManagedTaskWorkflow(f.input),
      expected = expect(first).rejects.toThrow('CONTINUE_AS_NEW');
    await until(() => f.status().phase === 'writing');
    const pause = f.executionCommand('pause', 0),
      pauseAck = await f.control(pause);
    writing.resolve(f.writer);
    await until(() => f.status().phase === 'stop-unknown');
    sdk.handlers.get('localTaskReconcile')!();
    await until(() => sdk.continueAsNew.mock.calls.length === 1);
    await expected;
    const saved = sdk.saveTaskExecutionCheckpoint.mock.calls[0]![0];
    expect(saved).toMatchObject({
      initial: f.input,
      input: f.input,
      revision: 1,
      history: [f.proof],
      commands: [pauseAck.authorization],
      diagnostics: [{ phase: 'stop-unknown', error: 'Error: original-stop-unknown' }],
      budget: { limit: 15, used: 4 },
    });
    expect(sdk.continueAsNew).toHaveBeenCalledWith(f.input, f.proof);
    expect(sdk.checkLocalTask).toHaveBeenCalledTimes(1);
    sdk.patched = mode === 'current';
    sdk.loadTaskExecutionCheckpoint
      .mockRejectedValueOnce(new Error('restore-unknown'))
      .mockResolvedValue({ ...saved, stop: f.proof });
    sdk.captureTaskExecutionBudget
      .mockReset()
      .mockResolvedValueOnce({ limit: 15, used: 4, manifest: f.proof })
      .mockResolvedValue({ limit: 15, used: 15, manifest: f.proof });
    const continued = ManagedTaskWorkflow(f.input, f.proof);
    await until(() => f.status().phase === 'checkpoint-unknown');
    sdk.handlers.get('localTaskReconcile')!();
    await until(() => f.status().waiting);
    expect(sdk.handlers.get('localTaskInput')!()).toEqual(f.input);
    expect(await f.control(pause)).toEqual(pauseAck);
    expect(sdk.interruptTaskExecution).toHaveBeenCalledTimes(1);
    const resumeAck = await f.control(f.executionCommand('resume', 1));
    await until(() => f.status().phase === 'done');
    expect(await continued).toMatchObject({
      status: 'done',
      checkpoint: f.proof,
      budget: { limit: 15, used: 15 },
      history: sdk.patched ? saved.history : [],
      commands: [...(sdk.patched ? saved.commands : []), resumeAck.authorization],
      diagnostics: [
        ...(sdk.patched ? saved.diagnostics : []),
        { phase: 'checkpoint-unknown', error: 'Error: restore-unknown' },
      ],
    });
    expect(sdk.prepareSubstantialPlanning.mock.calls.map((row) => row[0])).toEqual([
      f.input,
      f.next,
    ]);
  });
  it('keeps the complete planning/checks/reviewer route and uses explicit WAIT before terminal completion', async () => {
    const f = fixture(),
      run = LocalTaskWorkflow(f.input);
    await until(() => f.status().phase === 'done');
    expect(await run).toMatchObject({ status: 'done', history: [] });
    expect(sdk.executeChild).toHaveBeenCalledTimes(2);
    expect(sdk.checkLocalTask.mock.calls.map((row) => row[2])).toEqual([
      'baseline',
      'candidate',
      'integrated',
    ]);
    expect(sdk.options.every((options) => options.cancellationType === 'WAIT_ACTIVITY')).toBe(true);
    expect(
      sdk.executeChild.mock.calls.every(
        (row) =>
          row[1].cancellationType === 'WAIT_CHILD' && row[1].parentClosePolicy === 'REQUEST_CANCEL',
      ),
    ).toBe(true);
    expect(sdk.handlers.get('localTaskInput')!()).toEqual(f.input);
    await expect(f.control(f.executionCommand('pause', 0))).rejects.toThrow('task-already-closed');
  });
  it('waits for both physical stop and a held writer Activity, then resumes the same task with fresh planning', async () => {
    const f = fixture(),
      writing = deferred<typeof f.writer>(),
      stopping = deferred<typeof f.proof>();
    sdk.writeLocalTask.mockReturnValueOnce(writing.promise);
    sdk.stopLocalTask.mockReturnValueOnce(stopping.promise);
    let settled = false;
    const run = ManagedTaskWorkflow(f.input).finally(() => {
      settled = true;
    });
    await until(() => f.status().phase === 'writing');
    const pause = f.executionCommand('pause', 0),
      ack = await f.control(pause);
    flush();
    await until(() => sdk.stopLocalTask.mock.calls.length === 1);
    expect(settled).toBe(false);
    stopping.resolve(f.proof);
    flush();
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    expect(sdk.holdTaskExecution).not.toHaveBeenCalled();
    writing.resolve(f.writer);
    await until(() => f.status().waiting);
    expect(sdk.checkLocalTask).toHaveBeenCalledTimes(1);
    expect(await f.control(pause)).toEqual(ack);
    await expect(f.control({ ...pause, hash: 'b'.repeat(64) })).rejects.toThrow(
      'task-command-id-conflict',
    );
    await f.control(f.executionCommand('resume', 1));
    await until(() => f.status().phase === 'done');
    expect(await run).toMatchObject({ status: 'done', history: [f.proof] });
    expect(sdk.prepareSubstantialPlanning.mock.calls.map((row) => row[0])).toEqual([
      f.input,
      f.next,
    ]);
    expect(sdk.interruptTaskExecution).toHaveBeenCalledTimes(1);
    expect(sdk.handlers.get('localTaskInput')!()).toEqual(f.input);
  });
  it('retains an unknown stop until explicit reconciliation and accepts cancellation while held', async () => {
    const f = fixture(),
      writing = deferred<typeof f.writer>();
    sdk.writeLocalTask.mockReturnValueOnce(writing.promise);
    sdk.stopLocalTask.mockRejectedValueOnce(new Error('unknown-stop'));
    let settled = false;
    const run = ManagedTaskWorkflow(f.input).finally(() => {
      settled = true;
    });
    await until(() => f.status().phase === 'writing');
    await f.control(f.executionCommand('pause', 0));
    await until(() => f.status().phase === 'stop-unknown');
    expect(settled).toBe(false);
    expect(sdk.stopLocalTask).toHaveBeenCalledTimes(1);
    sdk.handlers.get('localTaskReconcile')!();
    await until(() => sdk.stopLocalTask.mock.calls.length === 2);
    writing.resolve(f.writer);
    await until(() => f.status().waiting);
    await f.control(f.executionCommand('cancel', 1));
    await until(() => settled);
    expect(await run).toMatchObject({ status: 'cancelled', held: f.proof });
    expect(sdk.writeLocalTask).toHaveBeenCalledTimes(1);
  });
});
