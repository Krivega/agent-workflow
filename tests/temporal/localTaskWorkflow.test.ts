import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import { localTaskFixture } from './localTaskFixture.js';
import { initialArbitrationFixture } from './initialArbitrationFixture.js';
import { LocalTaskWorkflow } from '../../src/workflows/localTask.js';
import { startLocalTask } from '../../src/client/localTask.js';
import { bindTaskBackendClient } from '../../src/client/taskBackend.js';
const sdk = vi.hoisted(() => ({
  prepareLocalTask: vi.fn(),
  prepareSubstantialPlanning: vi.fn(),
  prepareLocalCorrection: vi.fn(),
  prepareLocalArbitration: vi.fn(),
  finishLocalArbitration: vi.fn(),
  prepareInitialArbitration: vi.fn(),
  finishInitialArbitration: vi.fn(),
  checkLocalTask: vi.fn(),
  writeLocalTask: vi.fn(),
  planLocalIntegration: vi.fn(),
  integrateLocalTask: vi.fn(),
  prepareLocalAcceptance: vi.fn(),
  finishLocalTask: vi.fn(),
  stopLocalTask: vi.fn(),
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
  const f = localTaskFixture(),
    ref = f.proof,
    review = {
      schemaVersion: 1,
      preparation: f.input.admission.preparation,
      reviewId: 'accept',
      request: ref,
    };
  sdk.prepareLocalTask.mockResolvedValue(ref);
  sdk.checkLocalTask.mockResolvedValue({ status: 'PASS', manifest: ref });
  sdk.writeLocalTask.mockResolvedValue({ session: 'writer' });
  sdk.planLocalIntegration.mockResolvedValue(ref);
  sdk.integrateLocalTask.mockResolvedValue(ref);
  sdk.prepareLocalAcceptance.mockResolvedValue(review);
  sdk.executeChild.mockResolvedValue({ status: 'reviewed', complete: true, manifest: ref });
  sdk.finishLocalTask.mockResolvedValue({ status: 'done', result: ref, projection: ref });
  sdk.stopLocalTask.mockResolvedValue(ref);
  return f;
}
describe('B1 durable coordinator and explicit client', () => {
  it.each([
    'pass',
    'initial-pass',
    'planning-blocked',
    'arbitration-blocked',
    'held',
    'replanning-fail',
  ])('keeps initial conflict gates before writer: %s', async (mode) => {
    const f = fixture(),
      initial = initialArbitrationFixture(),
      input = initial.initialInput,
      review = {
        schemaVersion: 1 as const,
        preparation: input.admission.preparation,
        reviewId: 'planning',
        request: f.proof,
      },
      arbitration = { ...review, reviewId: 'arbitration' },
      replanning = { ...review, reviewId: 'replanning' };
    sdk.prepareSubstantialPlanning.mockResolvedValue(review);
    sdk.prepareInitialArbitration.mockResolvedValue({ manifest: f.proof, review: arbitration });
    sdk.finishInitialArbitration.mockResolvedValue({
      manifest: f.proof,
      planning: mode === 'held' ? null : replanning,
    });
    const passed = { status: 'reviewed', complete: true, manifest: f.proof, plan: f.proof };
    sdk.executeChild.mockResolvedValueOnce(
      mode === 'planning-blocked'
        ? { ...passed, status: 'blocked' }
        : { ...passed, complete: mode === 'initial-pass' },
    );
    if (mode !== 'initial-pass' && mode !== 'planning-blocked') {
      sdk.executeChild.mockResolvedValueOnce(
        mode === 'arbitration-blocked'
          ? { ...passed, status: 'blocked' }
          : { ...passed, complete: false },
      );
      if (mode !== 'arbitration-blocked' && mode !== 'held')
        sdk.executeChild.mockResolvedValueOnce({ ...passed, complete: mode !== 'replanning-fail' });
    }
    const result = await LocalTaskWorkflow(input),
      done = mode === 'pass' || mode === 'initial-pass';
    expect(result.status).toBe(done ? 'done' : 'blocked');
    expect(sdk.writeLocalTask).toHaveBeenCalledTimes(done ? 1 : 0);
    if (mode === 'initial-pass' || mode === 'planning-blocked')
      expect(sdk.prepareInitialArbitration).not.toHaveBeenCalled();
    if (mode === 'arbitration-blocked') expect(sdk.finishInitialArbitration).not.toHaveBeenCalled();
    if (mode === 'pass') {
      expect(sdk.executeChild.mock.calls[1]![1]).toMatchObject({ taskQueue: 'q.arbitration' });
      expect(sdk.prepareLocalTask).toHaveBeenCalledWith(input, f.proof);
    }
    expect(sdk.handlers.get('localTaskStatus')!()).toHaveProperty('arbitration');
  });
  it('orders the whole B1 and uses independently cancelled child policy', async () => {
    const f = fixture();
    expect((await LocalTaskWorkflow(f.input)).status).toBe('done');
    expect(sdk.checkLocalTask.mock.calls.map((c) => c[2] as unknown)).toEqual([
      'baseline',
      'candidate',
      'integrated',
    ]);
    expect(sdk.executeChild.mock.calls[0]![1]).toMatchObject({
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      parentClosePolicy: 'REQUEST_CANCEL',
      cancellationType: 'WAIT',
    });
    expect(sdk.handlers.get('localTaskInput')!()).toEqual(f.input);
    expect(sdk.handlers.get('localTaskStatus')!()).toMatchObject({ phase: 'done', runId: 'run' });
  });
  it('routes M1 through the same coordinator without a native executor', async () => {
    const f = fixture();
    const input = {
      schemaVersion: 2,
      baseline: f.input.baseline,
      admission: {
        schemaVersion: 2,
        preparation: f.input.admission.preparation,
        plan: f.input.admission.plan,
        accepted: f.proof,
        acceptance: f.input.admission.acceptance,
      },
    } as const;
    sdk.writeLocalTask.mockImplementation(async () => {
      expect(sdk.handlers.get('localTaskStatus')!()).toMatchObject({ phase: 'applying-material' });
      return { session: null };
    });
    expect((await LocalTaskWorkflow(input)).status).toBe('done');
    expect(sdk.finishLocalTask).toHaveBeenCalled();
  });
  it.each([true, false])(
    'gates substantial implementation on a complete planning result: %s',
    async (complete) => {
      const f = fixture();
      const input = {
        ...f.input,
        schemaVersion: 3 as const,
        admission: { ...f.input.admission, schemaVersion: 3 as const, planning: f.proof },
      };
      sdk.prepareSubstantialPlanning.mockResolvedValue({
        schemaVersion: 1,
        preparation: input.admission.preparation,
        reviewId: 'plan',
        request: f.proof,
      });
      sdk.executeChild.mockResolvedValueOnce({
        status: 'reviewed',
        complete,
        manifest: f.proof,
        plan: f.proof,
      });
      const result = await LocalTaskWorkflow(input);
      expect(result.status).toBe(complete ? 'done' : 'blocked');
      if (complete) {
        expect(sdk.prepareLocalTask).toHaveBeenCalledWith(input, f.proof);
        expect(sdk.executeChild).toHaveBeenCalledTimes(2);
      } else {
        expect(sdk.prepareLocalTask).not.toHaveBeenCalled();
        expect(sdk.writeLocalTask).not.toHaveBeenCalled();
      }
    },
  );
  it('owns the correction loop and preserves the latest review at exhaustion', async () => {
    const f = fixture();
    const input = {
      ...f.input,
      schemaVersion: 4 as const,
      admission: { ...f.input.admission, schemaVersion: 3 as const, planning: f.proof },
      corrections: { maxRounds: 1 as const, checks: [{ roleId: 'reviewer', commands: ['smoke'] }] },
    };
    sdk.prepareSubstantialPlanning.mockResolvedValue({
      schemaVersion: 1,
      preparation: input.admission.preparation,
      reviewId: 'plan',
      request: f.proof,
    });
    sdk.prepareLocalCorrection.mockResolvedValue(f.proof);
    sdk.executeChild
      .mockResolvedValueOnce({
        status: 'reviewed',
        complete: true,
        manifest: f.proof,
        plan: f.proof,
      })
      .mockResolvedValueOnce({
        status: 'reviewed',
        complete: false,
        manifest: f.proof,
        plan: f.proof,
      })
      .mockResolvedValueOnce({
        status: 'reviewed',
        complete: true,
        manifest: f.proof,
        plan: f.proof,
      });
    expect(await LocalTaskWorkflow(input)).toMatchObject({ status: 'done', corrections: 1 });
    expect(sdk.handlers.get('localTaskStatus')!()).toMatchObject({ round: 1, review: f.proof });
    expect(sdk.prepareLocalCorrection).toHaveBeenCalledTimes(1);
    expect(sdk.checkLocalTask).toHaveBeenCalledTimes(6);
    sdk.executeChild.mockResolvedValue({
      status: 'reviewed',
      complete: false,
      manifest: f.proof,
      plan: f.proof,
    });
    sdk.executeChild.mockResolvedValueOnce({
      status: 'reviewed',
      complete: true,
      manifest: f.proof,
      plan: f.proof,
    });
    sdk.prepareLocalCorrection.mockRejectedValue(new Error('task-correction-budget-exhausted'));
    expect(await LocalTaskWorkflow(input)).toMatchObject({ status: 'blocked', review: f.proof });
  });
  it.each(['baseline', 'candidate', 'integrated'])(
    'blocks on %s FAIL without publishing DONE',
    async (stage) => {
      const f = fixture();
      sdk.checkLocalTask.mockImplementation(async (_i, _s, current) => ({
        status: current === stage ? 'FAIL' : 'PASS',
        manifest: f.proof,
      }));
      const result = await LocalTaskWorkflow(f.input);
      expect(result).toMatchObject({ status: 'blocked', stop: f.proof });
      expect(result).toHaveProperty('error', expect.stringContaining('failed'));
      expect(sdk.finishLocalTask).not.toHaveBeenCalled();
      expect(sdk.executeChild).not.toHaveBeenCalled();
    },
  );
  it.each([
    { status: 'cancelled', complete: false },
    { status: 'reviewed', complete: false },
  ])('requires a complete independent review: %s', async (review) => {
    const f = fixture();
    sdk.executeChild.mockResolvedValue({ ...review, plan: f.proof });
    expect((await LocalTaskWorkflow(f.input)).status).toBe('blocked');
    expect(sdk.finishLocalTask).not.toHaveBeenCalled();
  });
  it('waits for reconciliation of an unknown stop and preserves the original cause', async () => {
    const f = fixture();
    sdk.writeLocalTask.mockRejectedValue(
      Object.assign(new Error('outer'), { cause: new Error('writer failed') }),
    );
    sdk.stopLocalTask.mockRejectedValueOnce(new Error('unknown stop'));
    sdk.condition.mockImplementation(async (predicate: () => boolean) => {
      expect(predicate()).toBe(false);
      expect(sdk.handlers.get('localTaskStatus')!()).toMatchObject({
        phase: 'stop-unknown',
        error: 'Error: writer failed',
        stopFailure: 'Error: unknown stop',
      });
      sdk.handlers.get('localTaskReconcile')!();
      expect(predicate()).toBe(true);
    });
    expect(await LocalTaskWorkflow(f.input)).toMatchObject({
      status: 'blocked',
      error: 'Error: writer failed',
      stopFailure: 'Error: unknown stop',
    });
    expect(sdk.stopLocalTask).toHaveBeenCalledTimes(2);
  });
  it('stops under cancellation and rejects malformed input before any activity', async () => {
    const f = fixture();
    sdk.cancelled = true;
    sdk.prepareLocalTask.mockRejectedValue('cancelled');
    expect(await LocalTaskWorkflow(f.input)).toMatchObject({
      status: 'cancelled',
      snapshot: null,
      error: 'cancelled',
    });
    await expect(LocalTaskWorkflow({ ...f.input, schemaVersion: 13 } as never)).rejects.toThrow(
      'local-task-schema',
    );
  });
  it('rejects a checkpoint on the historical task route before any Activity', async () => {
    const f = fixture();
    await expect(LocalTaskWorkflow(f.input, f.proof)).rejects.toThrow(
      'task-checkpoint-version-required',
    );
    expect(sdk.prepareLocalTask).not.toHaveBeenCalled();
    expect(sdk.stopLocalTask).not.toHaveBeenCalled();
    expect(sdk.executeChild).not.toHaveBeenCalled();
  });
  it('attaches to the exact stable task and rejects a conflicting existing input', async () => {
    const f = fixture(),
      query = vi.fn().mockResolvedValue(f.input),
      handle = { query },
      start = vi.fn().mockResolvedValue(handle),
      client = { workflow: { start } } as unknown as Client;
    bindTaskBackendClient(client, f.registration);
    expect(await startLocalTask(client, f.input, 'q')).toBe(handle);
    expect(start).toHaveBeenCalledWith(
      'LocalTaskWorkflow',
      expect.objectContaining({
        workflowId: 'aw/task/neutral/one',
        taskQueue: 'q',
        args: [f.input],
      }),
    );
    query.mockResolvedValue({ ...f.input, baseline: 'other' });
    await expect(startLocalTask(client, f.input, 'q')).rejects.toThrow('local-task-start-conflict');
  });
});

it.each(['done', 'held', 'post-fail', 'arb-blocked', 'cancel'])(
  'coordinates bounded arbitration: %s',
  async (outcome) => {
    const f = fixture();
    f.input.admission.preparation.project.roles.push({ id: 'arbiter', profile: 'arbiter.md' });
    const input = {
      ...f.input,
      schemaVersion: 5 as const,
      corrections: {
        maxRounds: 2 as const,
        checks: [
          { roleId: 'reviewer', commands: ['smoke'] },
          { roleId: 'arbiter', commands: [] },
        ],
      },
      arbitration: {
        roleId: 'arbiter',
        profile: { ...f.profile, effort: 'high' },
        compromiseFindings: [],
      },
    };
    sdk.prepareLocalCorrection.mockResolvedValue(f.proof);
    sdk.prepareLocalArbitration.mockResolvedValue({
      manifest: f.proof,
      review: {
        schemaVersion: 1,
        preparation: input.admission.preparation,
        reviewId: 'arbitration',
        request: f.proof,
      },
    });
    sdk.finishLocalArbitration.mockResolvedValue({
      manifest: f.proof,
      ready: outcome !== 'held',
      snapshot: outcome === 'held' ? null : f.proof,
    });
    let calls = 0;
    sdk.executeChild.mockImplementation(async () => {
      const n = calls++;
      if (n === 3 && outcome === 'cancel') {
        sdk.cancelled = true;
        throw new Error('cancelled arbitration');
      }
      return {
        status: n === 3 && outcome === 'arb-blocked' ? 'blocked' : 'reviewed',
        complete: n === 4 && outcome !== 'post-fail',
        manifest: f.proof,
        plan: f.proof,
      };
    });
    const result = await LocalTaskWorkflow(input);
    expect(result).toMatchObject({
      status: outcome === 'done' ? 'done' : outcome === 'cancel' ? 'cancelled' : 'blocked',
      arbitration: f.proof,
    });
    expect(sdk.executeChild.mock.calls[3]![1]).toMatchObject({ taskQueue: 'q.arbitration' });
    expect(sdk.handlers.get('localTaskStatus')!()).toMatchObject({ arbitration: f.proof });
    expect(sdk.prepareLocalArbitration).toHaveBeenCalledTimes(1);
    expect(sdk.finishLocalTask).toHaveBeenCalledTimes(outcome === 'done' ? 1 : 0);
  },
);
