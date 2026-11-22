import type {
  StageSupervisedTaskInput,
  ProgressSupervisedTaskInput,
} from '../../src/contracts/localTask.js';
import type { TaskStageContext, TaskStageAudit } from '../../src/contracts/stageAudit.js';
import { taskAuditStages } from '../../src/contracts/localTask.js';
import { supervisedTaskStage } from '../../src/workflows/stageAudit.js';
import type { TaskPlanningAudit } from '../../src/contracts/taskAudit.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskAuditFixture } from './taskAuditFixture.js';
import { LocalTaskWorkflow } from '../../src/workflows/localTask.js';
import { supervisedPlanning, type PlanningAuditStatus } from '../../src/workflows/taskAudit.js';
import { ReviewWorkflow } from '../../src/workflows/review.js';
import { AuditWorkflow } from '../../src/workflows/audit.js';

const sdk = vi.hoisted(() => ({
  preflightAuditor: vi.fn(),
  captureTaskPlanningProgress: vi.fn(),
  patched: true,
  prepareTaskPlanningAudit: vi.fn(),
  verifyAuditResult: vi.fn(),
  finishTaskPlanningAudit: vi.fn(),
  prepareTaskStageAudit: vi.fn(),
  finishTaskStageAudit: vi.fn(),
  prepareTaskProgressAudit: vi.fn(),
  finishTaskProgressAudit: vi.fn(),
  prepareSubstantialPlanning: vi.fn(),
  prepareLocalTask: vi.fn(),
  checkLocalTask: vi.fn(),
  writeLocalTask: vi.fn(),
  planLocalIntegration: vi.fn(),
  integrateLocalTask: vi.fn(),
  prepareLocalAcceptance: vi.fn(),
  finishLocalTask: vi.fn(),
  stopLocalTask: vi.fn(),
  executeChild: vi.fn(),
  condition: vi.fn(),
  cancel: vi.fn(),
  nonCancellable: vi.fn(),
  cancelled: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: { nonRetryable: (s: string) => new Error(s) },
  CancellationScope: class {
    run<T>(fn: () => Promise<T>) {
      return fn();
    }
    cancel() {
      sdk.cancel();
    }
    static current() {
      return {
        consideredCancelled: sdk.cancelled,
        get cancelRequested() {
          return Promise.reject(new Error('parent cancelled'));
        },
      };
    }
    static nonCancellable<T>(fn: () => Promise<T>) {
      sdk.nonCancellable();
      return fn();
    }
  },
  ChildWorkflowCancellationType: { WAIT_CANCELLATION_COMPLETED: 'WAIT' },
  ParentClosePolicy: { REQUEST_CANCEL: 'REQUEST_CANCEL' },
  condition: sdk.condition,
  patched: () => sdk.patched,
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
  sdk.patched = true;
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = taskAuditFixture();
  const { planning } = await f.prepare();
  const auditInput = {
    schemaVersion: 1 as const,
    preparation: f.input.admission.preparation,
    auditId: 'planning-overrun',
    card: f.proof,
    preflight: f.proof,
  };
  const review = { status: 'reviewed' as const, complete: true, manifest: f.proof, plan: f.proof };
  const audit = {
    status: 'audited' as const,
    manifest: f.proof,
    stop: f.proof,
    report: { coverage: 'complete', direction: 'continue' },
  };
  sdk.preflightAuditor.mockResolvedValue(f.proof);
  sdk.captureTaskPlanningProgress.mockResolvedValue(f.proof);
  sdk.prepareTaskPlanningAudit.mockResolvedValue(auditInput);
  sdk.verifyAuditResult.mockResolvedValue({ proof: f.proof, report: audit.report });
  sdk.finishTaskPlanningAudit.mockResolvedValue(f.proof);
  sdk.finishTaskStageAudit.mockResolvedValue(f.proof);
  sdk.finishTaskProgressAudit.mockResolvedValue(f.proof);
  sdk.prepareTaskProgressAudit.mockResolvedValue({
    ...auditInput,
    auditId: 'progress-before-writing',
  });
  sdk.prepareTaskStageAudit.mockResolvedValue(auditInput);
  sdk.prepareSubstantialPlanning.mockResolvedValue(planning);
  sdk.prepareLocalTask.mockResolvedValue(f.proof);
  sdk.checkLocalTask.mockResolvedValue({ status: 'PASS', manifest: f.proof });
  sdk.writeLocalTask.mockResolvedValue({
    session: 'writer',
    answer: f.proof,
    stop: f.proof,
    tree: f.proof,
  });
  sdk.planLocalIntegration.mockResolvedValue(f.proof);
  sdk.integrateLocalTask.mockResolvedValue(f.proof);
  sdk.prepareLocalAcceptance.mockResolvedValue(planning);
  sdk.finishLocalTask.mockResolvedValue({ status: 'done', result: f.proof, projection: f.proof });
  sdk.stopLocalTask.mockResolvedValue(f.proof);
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const time = (value: number) => {
    now = value;
  };
  const status: PlanningAuditStatus = {
    claim: null,
    audit: null,
    result: null,
    stop: null,
    supervision: null,
  };
  return { ...f, planning, auditInput, review, audit, time, status };
}

describe('durable main task planning audit', () => {
  it('completes under the original estimate without starting an auditor and retains supervision in the task result', async () => {
    const f = await fixture();
    sdk.executeChild.mockResolvedValue(f.review);
    sdk.condition.mockImplementation(async (ready: () => boolean, timeout: number) => {
      expect(timeout).toBe(2000);
      await Promise.resolve();
      expect(ready()).toBe(true);
    });
    expect(await LocalTaskWorkflow(f.input)).toMatchObject({
      status: 'done',
      planningAudit: { claim: null, supervision: f.proof },
    });
    expect(sdk.handlers.get('localTaskInput')!()).toEqual(f.input);
    expect(sdk.handlers.get('localTaskStatus')!()).toHaveProperty(
      'planningAudit.supervision',
      f.proof,
    );
    expect(sdk.prepareLocalTask).toHaveBeenCalledWith(f.input, f.proof, f.proof);
    expect(sdk.prepareTaskPlanningAudit).not.toHaveBeenCalled();
    expect(sdk.executeChild).toHaveBeenCalledTimes(2);
  });
  it('claims once at 2x, audits while the original council remains pending, then waits for that same council before writer', async () => {
    const f = await fixture();
    let resolve!: (v: typeof f.review) => void;
    const pending = new Promise<typeof f.review>((r) => {
      resolve = r;
    });
    sdk.executeChild.mockImplementation(async (workflow: unknown) => {
      if (workflow === ReviewWorkflow) return pending;
      expect(workflow).toBe(AuditWorkflow);
      expect(sdk.handlers.get('localTaskStatus')!()).toHaveProperty(
        'planningAudit.claim',
        'planning:overrun',
      );
      expect(sdk.prepareLocalTask).not.toHaveBeenCalled();
      return f.audit;
    });
    sdk.condition.mockImplementation(async (ready: () => boolean) => {
      expect(ready()).toBe(false);
      f.time(2000);
    });
    sdk.verifyAuditResult.mockImplementation(async () => {
      expect(sdk.prepareLocalTask).not.toHaveBeenCalled();
      f.time(20000);
      resolve(f.review);
      return { proof: f.proof, report: f.audit.report };
    });
    expect(await LocalTaskWorkflow(f.input)).toMatchObject({
      status: 'done',
      planningAudit: { claim: 'planning:overrun', result: f.proof, stop: f.proof },
    });
    expect(sdk.prepareTaskPlanningAudit).toHaveBeenCalledTimes(1);
    expect(sdk.condition).toHaveBeenCalledTimes(1);
    expect(sdk.finishTaskPlanningAudit.mock.calls[0]![0]).toMatchObject({
      timing: { estimateMs: 1000, knownElapsedMs: 20000 },
      claim: 'planning:overrun',
    });
    expect(sdk.executeChild.mock.calls[1]![1]).toMatchObject({
      taskQueue: 'q.audit',
      cancellationType: 'WAIT',
      parentClosePolicy: 'REQUEST_CANCEL',
    });
  });
  it.each([
    'partial',
    'replace-approach',
    'replace-executor',
    'reconsider-constraints',
    'blocked',
    'cancelled',
    'verify-error',
    'parent-cancel',
  ])(
    'cancels and waits for the original council before holding the main task: %s',
    async (direction) => {
      const f = await fixture();
      let resolve!: (v: typeof f.review) => void;
      let councilStopped = false;
      const pending = new Promise<typeof f.review>((r) => {
        resolve = r;
      }).then((v) => {
        councilStopped = true;
        return v;
      });
      sdk.executeChild.mockImplementation((workflow: unknown) =>
        workflow === ReviewWorkflow
          ? pending
          : Promise.resolve({
              ...f.audit,
              ...(['blocked', 'cancelled'].includes(direction) ? { status: direction } : {}),
            }),
      );
      sdk.condition.mockImplementation(async () => f.time(2000));
      sdk.cancel.mockImplementation(() => resolve(f.review));
      sdk.stopLocalTask.mockImplementation(async () => {
        expect(councilStopped).toBe(true);
        return f.proof;
      });
      if (direction === 'parent-cancel') sdk.cancelled = true;
      if (direction === 'verify-error')
        sdk.verifyAuditResult.mockRejectedValue(new Error('primary unavailable'));
      else
        sdk.verifyAuditResult.mockResolvedValue({
          proof: f.proof,
          report: {
            coverage: direction === 'partial' ? 'partial' : 'complete',
            direction: direction === 'partial' ? null : direction,
          },
        });
      expect(await LocalTaskWorkflow(f.input)).toMatchObject({
        status: sdk.cancelled ? 'cancelled' : 'blocked',
        planningAudit: { claim: 'planning:overrun', stop: f.proof },
      });
      expect(sdk.cancel).toHaveBeenCalledTimes(1);
      expect(sdk.prepareLocalTask).not.toHaveBeenCalled();
      expect(sdk.writeLocalTask).not.toHaveBeenCalled();
    },
  );
  it.each(['under', 'threshold', 'legacy', 'error', 'late-error', 'clock', 'cancel'])(
    'handles completion, failure, clock uncertainty and cancellation at the timer boundary: %s',
    async (mode) => {
      const f = await fixture();
      if (mode === 'legacy') sdk.patched = false;
      let resolve!: (v: typeof f.review) => void, reject!: (e: Error) => void;
      const pending = new Promise<typeof f.review>((r, j) => {
        resolve = r;
        reject = j;
      });
      sdk.executeChild.mockImplementation((workflow: unknown) =>
        workflow === ReviewWorkflow ? pending : Promise.resolve(f.audit),
      );
      sdk.condition.mockImplementation(async () => {
        if (mode === 'cancel') throw new Error('cancelled');
        f.time(
          mode === 'threshold' || mode === 'legacy' || mode === 'late-error'
            ? 2000
            : mode === 'clock'
              ? -1
              : 1000,
        );
        if (mode === 'error') reject(new Error('council failed'));
        else if (mode !== 'late-error') resolve(f.review);
        await Promise.resolve();
      });
      sdk.cancel.mockImplementation(() => reject(new Error('council cancelled')));
      if (mode === 'late-error')
        sdk.verifyAuditResult.mockImplementation(async () => {
          reject(new Error('late council failure'));
          return { proof: f.proof, report: f.audit.report };
        });
      if (mode === 'error' || mode === 'late-error' || mode === 'cancel')
        await expect(supervisedPlanning(f.input, f.planning, f.status)).rejects.toThrow();
      else {
        await supervisedPlanning(f.input, f.planning, f.status);
        expect(sdk.prepareTaskPlanningAudit).toHaveBeenCalledTimes(
          mode === 'threshold' || mode === 'legacy' ? 1 : 0,
        );
        expect(sdk.captureTaskPlanningProgress).toHaveBeenCalledTimes(mode === 'threshold' ? 1 : 0);
        expect(
          (sdk.finishTaskPlanningAudit.mock.calls[0]![0] as TaskPlanningAudit).timing.elapsedMs,
        ).toBe(mode === 'clock' ? null : mode === 'threshold' || mode === 'legacy' ? 2000 : 1000);
      }
    },
  );
});

describe('stage supervision in the main task', () => {
  it('stops a failed supervised writer and retains the completed stage without entering acceptance', async () => {
    const f = await fixture();
    const input = {
      ...f.input,
      schemaVersion: 8 as const,
      audit: {
        ...f.input.audit,
        stages: Object.fromEntries(taskAuditStages.map((stage) => [stage, 1000])),
      },
    } as StageSupervisedTaskInput;
    sdk.executeChild.mockResolvedValue(f.review);
    sdk.condition.mockImplementation(async (ready: () => boolean) => {
      for (let tick = 0; tick < 10 && !ready(); tick++) await Promise.resolve();
      expect(ready()).toBe(true);
    });
    sdk.writeLocalTask.mockRejectedValue(new Error('writer failed'));
    expect(await LocalTaskWorkflow(input)).toMatchObject({
      status: 'blocked',
      error: 'Error: writer failed',
      stageRecords: [f.proof],
    });
    expect(sdk.prepareLocalAcceptance).not.toHaveBeenCalled();
    expect(sdk.finishLocalTask).not.toHaveBeenCalled();
    expect(sdk.stopLocalTask).toHaveBeenCalledExactlyOnceWith(input);
  });
  it('collects six ordered stage receipts and supplies them before DONE without auditing fast operations', async () => {
    const f = await fixture();
    const input = {
      ...f.input,
      schemaVersion: 8 as const,
      audit: {
        ...f.input.audit,
        stages: Object.fromEntries(taskAuditStages.map((stage) => [stage, 1000])),
      },
    } as StageSupervisedTaskInput;
    sdk.executeChild.mockResolvedValue(f.review);
    sdk.condition.mockImplementation(async (ready: () => boolean) => {
      for (let tick = 0; tick < 10 && !ready(); tick++) await Promise.resolve();
      expect(ready()).toBe(true);
    });
    expect(await LocalTaskWorkflow(input)).toMatchObject({
      status: 'done',
      stageRecords: Array(6).fill(f.proof),
    });
    expect(
      sdk.finishTaskStageAudit.mock.calls.map((call) => (call[0] as TaskStageAudit).context.stage),
    ).toEqual(taskAuditStages);
    expect(sdk.prepareTaskStageAudit).not.toHaveBeenCalled();
    expect(sdk.finishLocalTask).toHaveBeenCalledWith(
      input,
      f.proof,
      f.planning,
      f.proof,
      Array(6).fill(f.proof),
    );
    expect(sdk.handlers.get('localTaskStatus')!()).toHaveProperty('stageRecords.length', 6);
  });
  it.each(taskAuditStages)(
    'audits %s once while its original operation is pending',
    async (stage) => {
      const f = await fixture();
      const input = {
        ...f.input,
        schemaVersion: 8 as const,
        audit: {
          ...f.input.audit,
          stages: Object.fromEntries(taskAuditStages.map((stage) => [stage, 1000])),
        },
      } as StageSupervisedTaskInput;
      const context: TaskStageContext = { input, stage, snapshot: f.proof, completed: [] };
      let resolve!: (v: string) => void;
      const pending = new Promise<string>((r) => {
        resolve = r;
      });
      sdk.condition.mockImplementation(async () => f.time(2000));
      sdk.executeChild.mockResolvedValue(f.audit);
      sdk.verifyAuditResult.mockImplementation(async () => {
        f.time(3000);
        resolve('original-result');
        return { proof: f.proof, report: f.audit.report };
      });
      expect(await supervisedTaskStage(context, f.status, () => pending)).toEqual({
        result: 'original-result',
        supervision: f.proof,
      });
      expect(f.status.claim).toBe(stage + ':overrun');
      expect(sdk.prepareTaskStageAudit).toHaveBeenCalledExactlyOnceWith(
        context,
        { stage, estimateMs: 1000, elapsedMs: 2000, knownElapsedMs: 2000, externalWaitMs: 0 },
        f.proof,
      );
    },
  );
});

describe('main task progress checkpoint without an active stage', () => {
  it.each(['no-progress', 'doubt'] as const)(
    'runs one explicit %s audit between baseline and writer without adding a stage timer',
    async (kind) => {
      const f = await fixture();
      const input = taskAuditFixture(true, kind).input as ProgressSupervisedTaskInput;
      sdk.condition.mockImplementation(async (ready: () => boolean) => {
        for (let tick = 0; tick < 10 && !ready(); tick++) await Promise.resolve();
        expect(ready()).toBe(true);
      });
      sdk.executeChild.mockImplementation(async (workflow: unknown) => {
        if (workflow === AuditWorkflow) {
          expect(sdk.checkLocalTask).toHaveBeenCalledTimes(1);
          expect(sdk.writeLocalTask).not.toHaveBeenCalled();
          expect(sdk.handlers.get('localTaskStatus')!()).toMatchObject({
            phase: 'progress-audit',
            stageRecords: [f.proof],
          });
          return f.audit;
        }
        return f.review;
      });
      const result = await LocalTaskWorkflow(input);
      expect(result).toMatchObject({
        status: 'done',
        progressAudit: {
          claim: `task-progress:before-writing:${kind}:${input.progress.trigger.evidence.sha256}`,
          supervision: f.proof,
        },
      });
      expect(sdk.prepareTaskProgressAudit).toHaveBeenCalledExactlyOnceWith(
        { input, snapshot: f.proof, baseline: f.proof, taskElapsedMs: 0 },
        f.proof,
      );
      expect(sdk.finishTaskProgressAudit.mock.calls[0]![0]).toMatchObject({ timing: null });
      expect(sdk.condition).toHaveBeenCalledTimes(7);
      expect(sdk.executeChild).toHaveBeenCalledTimes(3);
      expect(sdk.prepareTaskStageAudit).not.toHaveBeenCalled();
      expect(sdk.finishLocalTask).toHaveBeenCalledExactlyOnceWith(
        input,
        f.proof,
        f.planning,
        f.proof,
        Array(6).fill(f.proof),
        f.proof,
      );
    },
  );
  it.each([
    'partial',
    'replace-approach',
    'replace-executor',
    'reconsider-constraints',
    'blocked',
    'cancelled',
    'verify-error',
    'parent-cancel',
  ])(
    'prevents the first writer and stops the task for a held progress audit: %s',
    async (direction) => {
      const f = await fixture(),
        input = taskAuditFixture(true, 'no-progress').input as ProgressSupervisedTaskInput;
      sdk.condition.mockImplementation(async (ready: () => boolean) => {
        for (let tick = 0; tick < 10 && !ready(); tick++) await Promise.resolve();
      });
      sdk.executeChild.mockImplementation(async (workflow: unknown) => {
        if (workflow !== AuditWorkflow) return f.review;
        if (direction === 'parent-cancel') sdk.cancelled = true;
        return {
          ...f.audit,
          ...(['blocked', 'cancelled'].includes(direction) ? { status: direction } : {}),
        };
      });
      if (direction === 'verify-error')
        sdk.verifyAuditResult.mockRejectedValue(new Error('primary lost'));
      else
        sdk.verifyAuditResult.mockResolvedValue({
          proof: f.proof,
          report: {
            coverage: direction === 'partial' ? 'partial' : 'complete',
            direction: direction === 'partial' ? null : direction,
          },
        });
      expect(await LocalTaskWorkflow(input)).toMatchObject({
        status: direction === 'parent-cancel' ? 'cancelled' : 'blocked',
        progressAudit: { stop: f.proof },
        stageRecords: [f.proof],
      });
      expect(sdk.writeLocalTask).not.toHaveBeenCalled();
      expect(sdk.finishLocalTask).not.toHaveBeenCalled();
      expect(sdk.stopLocalTask).toHaveBeenCalledExactlyOnceWith(input);
    },
  );
});

it('keeps a rolled-back task clock unknown at the progress checkpoint without inventing a stage estimate', async () => {
  const f = await fixture(),
    input = taskAuditFixture(true, 'no-progress').input as ProgressSupervisedTaskInput;
  sdk.condition.mockImplementation(async (ready: () => boolean) => {
    for (let tick = 0; tick < 10 && !ready(); tick++) await Promise.resolve();
  });
  sdk.executeChild.mockImplementation(async (workflow: unknown) =>
    workflow === AuditWorkflow ? f.audit : f.review,
  );
  sdk.finishTaskStageAudit.mockImplementation(async (value: TaskStageAudit) => {
    if (value.context.stage === 'baseline') f.time(-1);
    return f.proof;
  });
  expect(await LocalTaskWorkflow(input)).toMatchObject({ status: 'done' });
  expect(sdk.prepareTaskProgressAudit).toHaveBeenCalledWith(
    { input, snapshot: f.proof, baseline: f.proof, taskElapsedMs: null },
    f.proof,
  );
  expect(sdk.finishTaskProgressAudit.mock.calls[0]![0]).toMatchObject({
    timing: null,
    context: { taskElapsedMs: null },
  });
});
