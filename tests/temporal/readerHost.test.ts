import { CompleteAsyncError } from '@temporalio/common';
import type { TaskProgressAuditActivities } from '../../src/contracts/progressAudit.js';
import type { TaskContinuationControls } from '../../src/contracts/taskContinuation.js';
import type { TaskExecutionControls } from '../../src/contracts/taskExecution.js';
import type { TaskHumanActivities } from '../../src/contracts/taskHuman.js';
import type { TaskStageAuditActivities } from '../../src/contracts/stageAudit.js';
import type { TaskAuditActivities } from '../../src/contracts/taskAudit.js';
import type { TaskPlanningProgressActivities } from '../../src/contracts/taskAudit.js';
import { taskAuditFixture } from './taskAuditFixture.js';
import { reviewActivities } from '../../src/activities/review.js';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as files from '../../src/adapters/artifacts/files.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeConnection, WorkerOptions } from '@temporalio/worker';
import type {
  ControlledReaderActivities,
  ReaderControlActivities,
} from '../../src/contracts/readerControl.js';
import { controlFixture } from './controlFixture.js';
import { createReaderHost } from '../../src/worker/readerHost.js';
import { readerKey } from '../../src/policy/readerControl.js';
import type { ReviewActivities, ReviewInput } from '../../src/contracts/review.js';
import { requireScoped } from '../../src/policy/review.js';
import * as tasks from '../../src/activities/localTask.js';
import { localTaskFixture } from './localTaskFixture.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import type { ManagedTaskInput, AnyManagedTaskInput } from '../../src/contracts/localTask.js';
import type { LocalTaskActivities, LocalTaskControls } from '../../src/contracts/localTask.js';
import * as audits from '../../src/activities/audit.js';
import type { AuditorActivities, AuditorControls } from '../../src/contracts/audit.js';
import { auditParentProfile } from '../../src/adapters/codex/nativeAudit.js';
import { readerBudget } from '../../src/adapters/codex/readerBudget.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { taskGate } from '../../src/adapters/project/taskGate.js';
import { object, text } from '../../src/contracts/project.js';
import { taskAdmissionIdentity } from '../../src/policy/taskRecovery.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import { readerExecution } from '../../src/policy/readerExecution.js';

const sdk = vi.hoisted(() => ({
  create: vi.fn<(_options: WorkerOptions) => Promise<ReturnType<typeof fakeWorker>>>(),
}));
vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => ({
      heartbeat() {},
      info: { workflowExecution: { workflowId: 'fixture', runId: 'run' }, activityId: 'writer' },
    }),
  },
}));
vi.mock('@temporalio/worker', () => ({ Worker: { create: sdk.create } }));
function fakeWorker() {
  let stop!: () => void;
  const ended = new Promise<void>((resolve) => {
    stop = resolve;
  });
  return { run: vi.fn(() => ended), shutdown: vi.fn(() => stop()), stop };
}
beforeEach(() => {
  vi.resetAllMocks();
  sdk.create.mockImplementation(async () => fakeWorker());
});
const connection = {} as NativeConnection;
async function fixture(clientVersion = '0.154.0') {
  const f = controlFixture(),
    root = join(f.root, 'host');
  f.profile.clientVersion = clientVersion;
  const host = await createReaderHost(
    connection,
    'models',
    'workflow.js',
    [{ registration: f.registration, rpc: f.rpc, authority: f.authority }],
    f.profile,
    root,
    2,
  );
  const controls = sdk.create.mock.calls.at(-2)![0].activities as ReaderControlActivities,
    models = sdk.create.mock.calls.at(-1)![0].activities as ControlledReaderActivities &
      ReviewActivities;
  return { ...f, root, host, controls, models };
}
describe('shared reader host', () => {
  it('hands the original B1 Activity to the configured observer without creating a local Writer', async () => {
    const f = localTaskFixture(),
      dispatchObservedWrite = vi.fn(async () => {});
    const host = await createReaderHost(
      connection,
      'q',
      'w',
      [
        {
          registration: f.registration,
          rpc: f.rpc,
          authority: f.authority,
          localTasks: f.host,
          dispatchObservedWrite,
        },
      ],
      f.profile,
      join(f.root, 'host'),
      5,
    );
    const model = sdk.create.mock.calls.at(-1)![0].activities as LocalTaskActivities;
    await host.runUntil(async () => {
      await expect(model.writeLocalTask(f.input, f.proof)).rejects.toBeInstanceOf(
        CompleteAsyncError,
      );
      expect(dispatchObservedWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          workerPid: process.pid,
          activityId: 'writer',
          input: f.input,
          snapshot: f.proof,
        }),
      );
    });
  });
  it('keeps one registration snapshot before lazy model factories and preserves the live RPC port', async () => {
    const f = await fixture(),
      other = controlFixture();
    f.registration.workspaceRoot = other.workspace;
    f.registration.owner = 'replacement';
    f.registration.commands.syntax.executable = '';
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'model/list')
        return {
          data: [
            {
              model: f.profile.model,
              supportedReasoningEfforts: [{ reasoningEffort: f.profile.effort }],
            },
          ],
        };
      if (method === 'thread/start') return structuredClone(f.response);
      return original(method, params);
    });
    try {
      const permit = await f.controls.registerReader(f.input, readerKey(f.input));
      const epoch = { permit, revision: 0, attempt: 0 };
      const prepared = await f.models.prepareControlledReader(f.input, epoch);
      expect((await f.models.createReader(f.input, prepared, epoch)).id).toBe('session');
      expect(f.rpc.request.mock.calls.find(([method]) => method === 'thread/start')![1].cwd).toBe(
        f.workspace,
      );
    } finally {
      await f.host.runUntil(async () => {});
    }
  });
  it('binds task admissions and primary budget snapshots to the actual host without starting a writer', async () => {
    const f = substantialTaskFixture(),
      root = join(f.root, 'budget-host'),
      input: ManagedTaskInput = {
        ...f.substantialInput,
        schemaVersion: 11,
        continuation: { attempt: 0, previous: null },
      },
      host = await createReaderHost(
        connection,
        'q',
        'w',
        [{ registration: f.registration, rpc: f.rpc, authority: f.authority, localTasks: f.host }],
        f.profile,
        root,
        5,
      ),
      controls = sdk.create.mock.calls.at(-2)![0].activities as TaskExecutionControls,
      publish = files.publishFile;
    let admissionFailure: 'denied' | 'lost-response' | null = 'denied';
    const publication = vi.spyOn(files, 'publishFile').mockImplementation((path, bytes) => {
      if (path.includes('/task-admissions-v2/') && admissionFailure !== null) {
        const failure = admissionFailure;
        admissionFailure = failure === 'denied' ? 'lost-response' : null;
        if (failure === 'denied')
          throw Object.assign(new Error('task admission disk denied'), { code: 'EACCES' });
        publish(path, bytes);
        throw Object.assign(new Error('identical admission already persisted'), { code: 'EEXIST' });
      }
      publish(path, bytes);
    });
    try {
      await host.runUntil(async () => {
        await expect(controls.captureTaskExecutionBudget(input, null)).rejects.toThrow(
          'task admission disk denied',
        );
        expect(f.state.creates).toBe(0);
        expect(f.state.starts).toBe(0);
        const snapshot = await controls.captureTaskExecutionBudget(input, null);
        expect(snapshot).toMatchObject({ limit: 5, used: 0 });
        expect(await controls.captureTaskExecutionBudget(input, snapshot.manifest)).toEqual(
          snapshot,
        );
        expect(f.state.creates).toBe(0);
        expect(f.state.starts).toBe(0);
        expect(JSON.parse(readFileSync(join(root, 'host-owner'), 'utf8'))).toHaveProperty(
          'taskBindings',
          3,
        );
      });
    } finally {
      publication.mockRestore();
    }
  });
  it('reopens the same host root with retained task evidence and the original spent credit', async () => {
    const f = substantialTaskFixture(),
      root = join(f.root, 'replacement-host'),
      input: ManagedTaskInput = {
        ...f.substantialInput,
        schemaVersion: 11,
        continuation: { attempt: 0, previous: null },
      },
      projects = [
        { registration: f.registration, rpc: f.rpc, authority: f.authority, localTasks: f.host },
      ],
      create = () => createReaderHost(connection, 'q', 'w', projects, f.profile, root, 2),
      controls = () => sdk.create.mock.calls.at(-2)![0].activities as TaskExecutionControls,
      first = await create(),
      owner = object(JSON.parse(readFileSync(join(root, 'host-owner'), 'utf8'))),
      instance = text(owner.id),
      key = files.digest(taskAdmissionIdentity(input)),
      gate = taskGate(
        parseLocalTask(input),
        taskFiles(f.registration.artifactRoot).binding(f.workspace),
        readerExecution(f.host.profile).profile,
        f.registration.artifactRoot,
        instance,
      );
    expect(first.taskAdmissionsDirectory).toBe(join(root, 'task-admissions-v2', instance));
    const firstBudget = await first.runUntil(async () => {
      readerBudget(join(root, 'turn-credits'), 2)('a'.repeat(64), 'b'.repeat(64));
      const budget = await controls().captureTaskExecutionBudget(input, null);
      gate.install();
      return budget;
    });
    expect(firstBudget).toMatchObject({ limit: 2, used: 1 });
    expect(existsSync(join(root, 'host-owner'))).toBe(false);
    const firstPath = join(first.taskAdmissionsDirectory!, key),
      previous = readFileSync(firstPath),
      grant = readFileSync(join(gate.directory, 'grant.json')),
      stop = readFileSync(join(gate.directory, 'stopped.json')),
      second = await create();
    expect(second.taskAdmissionsDirectory).not.toBe(first.taskAdmissionsDirectory);
    await second.runUntil(async () => {
      expect(await controls().captureTaskExecutionBudget(input, firstBudget.manifest)).toEqual(
        firstBudget,
      );
      expect(
        JSON.parse(readFileSync(join(second.taskAdmissionsDirectory!, key), 'utf8')),
      ).toMatchObject({
        gate: { mode: 'retained', directory: gate.directory },
      });
    });
    expect(readFileSync(firstPath)).toEqual(previous);
    expect(readFileSync(join(gate.directory, 'grant.json'))).toEqual(grant);
    expect(readFileSync(join(gate.directory, 'stopped.json'))).toEqual(stop);
    expect(f.state.creates).toBe(0);
    expect(f.state.starts).toBe(0);
  });
  it('captures registered and primary planning observations on the reserved controls queue', async () => {
    const f = taskAuditFixture(),
      { planning } = await f.prepare();
    const selection = await reviewActivities(f.registration, f.rpc, f.profile).prepareReviewPlan(
      planning,
    );
    const reader = selection.decisions.find((row) => row.action === 'review')!.input!;
    const host = await createReaderHost(
      connection,
      'q',
      'w',
      [{ registration: f.registration, rpc: f.rpc, authority: f.authority, localTasks: f.host }],
      f.profile,
      join(f.root, 'progress-host'),
      2,
    );
    const models = sdk.create.mock.calls.at(-1)![0].activities as ControlledReaderActivities;
    const controls = sdk.create.mock.calls.at(-2)![0].activities as ReaderControlActivities &
      TaskPlanningProgressActivities;
    await host.runUntil(async () => {
      const permit = await controls.registerReader(reader, readerKey(reader));
      const first = f.read(await controls.captureTaskPlanningProgress(f.input, planning));
      expect(first.roles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ roleId: reader.roleId, observation: 'registered' }),
        ]),
      );
      const epoch = { permit, revision: 0, attempt: 0 };
      const prepared = await models.prepareControlledReader(reader, epoch);
      await models.createReader(reader, prepared, epoch);
      const observed = f.read(await controls.captureTaskPlanningProgress(f.input, planning));
      expect(observed.roles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ roleId: reader.roleId, observation: 'session-observed' }),
        ]),
      );
    });
    expect(() => controls.captureTaskPlanningProgress(f.input, planning)).toThrow(
      'reader-host-closing',
    );
    const unregistered = await fixture();
    await unregistered.host.runUntil(async () => {
      const controls = unregistered.controls as ReaderControlActivities &
        TaskPlanningProgressActivities;
      expect(() =>
        controls.captureTaskPlanningProgress(
          {
            ...f.input,
            admission: { ...f.input.admission, preparation: unregistered.input.preparation },
          },
          planning,
        ),
      ).toThrow('local-task-host-unregistered');
    });
  });
  it('routes native audit activities through an explicitly registered host and keeps its owner until all children stop', async () => {
    const f = controlFixture(),
      root = join(f.root, 'audit-host');
    const names = [
      'preflightAuditor',
      'registerAuditor',
      'launchAuditor',
      'observeAuditorLoad',
      'prepareAuditQuestion',
      'answerAuditor',
      'observeAuditAnswer',
      'finishAudit',
      'verifyAuditResult',
      'prepareTaskPlanningAudit',
      'finishTaskPlanningAudit',
      'prepareTaskStageAudit',
      'finishTaskStageAudit',
      'prepareTaskProgressAudit',
      'finishTaskProgressAudit',
    ] as const;
    const activities = Object.fromEntries(
      names.map((name) => [name, vi.fn(async () => f.proof)]),
    ) as unknown as AuditorActivities &
      TaskAuditActivities &
      TaskStageAuditActivities &
      TaskProgressAuditActivities;
    const controls = { stopAuditor: vi.fn(async () => f.proof) },
      stopAll = vi.fn(async () => {});
    const spy = vi
      .spyOn(audits, 'auditorActivities')
      .mockReturnValue({ activities, controls, stopAll });
    try {
      const host = await createReaderHost(
        connection,
        'q.audit',
        'w',
        [{ registration: f.registration, rpc: f.rpc, authority: f.authority, auditor: true }],
        auditParentProfile,
        root,
        4,
      );
      const models = sdk.create.mock.calls.at(-1)![0].activities as AuditorActivities &
          TaskAuditActivities &
          TaskStageAuditActivities &
          TaskProgressAuditActivities,
        control = sdk.create.mock.calls.at(-2)![0].activities as AuditorControls;
      const input = {
        schemaVersion: 1 as const,
        preparation: f.input.preparation,
        auditId: 'one',
        card: f.proof,
        preflight: f.proof,
      };
      await host.runUntil(async () => {
        expect(JSON.parse(readFileSync(join(root, 'host-owner'), 'utf8'))).toHaveProperty(
          'audits',
          true,
        );
        for (const name of names) {
          const invoke = models[name] as (...args: unknown[]) => Promise<unknown>;
          await invoke(
            name === 'preflightAuditor'
              ? input.preparation
              : name === 'prepareTaskStageAudit' || name === 'prepareTaskProgressAudit'
                ? { input: { admission: { preparation: input.preparation } } }
                : name === 'finishTaskStageAudit' || name === 'finishTaskProgressAudit'
                  ? { context: { input: { admission: { preparation: input.preparation } } } }
                  : name === 'prepareTaskPlanningAudit'
                    ? { admission: { preparation: input.preparation } }
                    : name === 'finishTaskPlanningAudit'
                      ? { input: { admission: { preparation: input.preparation } } }
                      : input,
            null,
            null,
            null,
            null,
            null,
            null,
          );
          expect(activities[name]).toHaveBeenCalled();
        }
        expect(await control.stopAuditor(input, f.proof)).toEqual(f.proof);
      });
      expect(stopAll).toHaveBeenCalledTimes(1);
      expect(existsSync(join(root, 'host-owner'))).toBe(false);
      await expect(models.registerAuditor(input)).rejects.toThrow('reader-host-closing');
    } finally {
      spy.mockRestore();
    }
  });
  it('refuses audit effects and stops on a host without the explicit capability', async () => {
    const f = await fixture(),
      input = {
        schemaVersion: 1 as const,
        preparation: f.input.preparation,
        auditId: 'one',
        card: f.proof,
        preflight: f.proof,
      };
    const models = f.models as unknown as AuditorActivities,
      controls = f.controls as unknown as AuditorControls;
    await f.host.runUntil(async () => {
      await expect(models.registerAuditor(input)).rejects.toThrow('auditor-host-unregistered');
      expect(() => controls.stopAuditor(input, f.proof)).toThrow('auditor-host-unregistered');
    });
  });
  it('routes all task effects through the shared model slot and reserved controls, with a writer-aware owner', async () => {
    const f = localTaskFixture(),
      root = join(f.root, 'task-host');
    const names = [
      'prepareInitialArbitration',
      'finishInitialArbitration',
      'prepareLocalArbitration',
      'finishLocalArbitration',
      'prepareLocalCorrection',
      'prepareSubstantialPlanning',
      'prepareLocalTask',
      'checkLocalTask',
      'recheckIntegratedTask',
      'writeLocalTask',
      'planLocalIntegration',
      'integrateLocalTask',
      'prepareLocalAcceptance',
      'finishLocalTask',
    ] as const;
    const activities = Object.fromEntries(
      names.map((name) => [name, vi.fn(async () => f.proof)]),
    ) as unknown as LocalTaskActivities;
    const controls = { stopLocalTask: vi.fn(async () => f.proof) },
      continuationControls = {
        holdTaskPlanning: vi.fn(async () => f.proof),
        resumeTaskPlanning: vi.fn(async () => f.proof),
      } as unknown as TaskContinuationControls,
      stopAll = vi.fn(async () => {});
    const ack = { commandId: 'one', hash: 'a'.repeat(64), revision: 1, authorization: f.proof };
    const executionControls: TaskExecutionControls = {
      captureTaskExecutionBudget: vi.fn(async () => ({ limit: 15, used: 0, manifest: f.proof })),
      saveTaskExecutionCheckpoint: vi.fn(async () => f.proof),
      loadTaskExecutionCheckpoint: vi.fn(async (initial: ManagedTaskInput) => ({
        initial,
        input: initial,
        revision: 0,
        held: f.proof,
        history: [],
        commands: [],
        previous: null,
        budget: { limit: 15, used: 0, manifest: f.proof },
        beganAt: 0,
        diagnostics: [],
        stop: f.proof,
      })),
      prepareTaskExecution: vi.fn(async () => f.proof),
      findTaskExecutionCommand: vi.fn(async () => null),
      interruptTaskExecution: vi.fn(async () => ack),
      holdTaskExecution: vi.fn(async () => ({ status: 'held' as const, held: f.proof })),
      resumeTaskExecution: vi.fn(async (input: AnyManagedTaskInput) => ({ input, ack })),
    };
    const humanNames = [
      'prepareTaskHuman',
      'verifyTaskHumanCommand',
      'controlTaskHumanExecution',
      'finishTaskHuman',
      'saveTaskHumanCheckpoint',
      'loadTaskHumanCheckpoint',
    ] as const;
    const humanActivities = Object.fromEntries(
      humanNames.map((name) => [name, vi.fn(async () => f.proof)]),
    ) as unknown as TaskHumanActivities;
    const spy = vi.spyOn(tasks, 'localTaskActivities').mockReturnValue({
      activities,
      controls,
      continuationControls,
      executionControls,
      humanActivities,
      stopAll,
    });
    try {
      const host = await createReaderHost(
        connection,
        'q',
        'w',
        [{ registration: f.registration, rpc: f.rpc, authority: f.authority, localTasks: f.host }],
        f.profile,
        root,
        5,
        undefined,
        't7-custom',
      );
      expect(
        sdk.create.mock.calls.map(([options]) => [options.taskQueue, options.namespace]),
      ).toEqual([
        ['q.control', 't7-custom'],
        ['q', 't7-custom'],
      ]);
      const model = sdk.create.mock.calls.at(-1)![0].activities as LocalTaskActivities,
        control = sdk.create.mock.calls.at(-2)![0].activities as LocalTaskControls &
          TaskContinuationControls &
          TaskExecutionControls &
          TaskHumanActivities;
      await host.runUntil(async () => {
        expect(JSON.parse(readFileSync(join(root, 'host-owner'), 'utf8'))).toHaveProperty(
          'tasks',
          true,
        );
        for (const name of names) {
          const invoke = model[name] as (...args: unknown[]) => Promise<unknown>;
          expect(await invoke(f.input, f.proof, null, null, null, null, null, null)).toEqual(
            f.proof,
          );
          expect(activities[name]).toHaveBeenCalled();
        }
        expect(
          await model.writeLocalTask(
            {
              schemaVersion: 2,
              admission: { ...f.input.admission, schemaVersion: 2, accepted: f.proof },
              baseline: 'smoke',
            },
            f.proof,
          ),
        ).toEqual(f.proof);
        expect(await control.stopLocalTask(f.input)).toEqual(f.proof);
        for (const name of humanNames) {
          expect(model).not.toHaveProperty(name);
          const invoke = control[name] as (...args: unknown[]) => Promise<unknown>;
          const context = { input: f.input };
          const first = [
            'verifyTaskHumanCommand',
            'controlTaskHumanExecution',
            'finishTaskHuman',
            'saveTaskHumanCheckpoint',
          ].includes(name)
            ? context
            : f.input;
          expect(await invoke(first, f.proof, 'previous-run')).toEqual(f.proof);
          expect(humanActivities[name]).toHaveBeenCalledTimes(1);
        }
        expect(spy.mock.calls[0]![5]).toMatchObject({
          taskQueue: 'q.control',
          namespace: 't7-custom',
        });
        for (const name of ['holdTaskPlanning', 'resumeTaskPlanning'] as const) {
          const invoke = control[name] as (...args: unknown[]) => Promise<unknown>;
          expect(await invoke(f.input, f.proof, f.proof, 0)).toEqual(f.proof);
          expect(continuationControls[name]).toHaveBeenCalled();
        }
        for (const name of Object.keys(executionControls) as (keyof TaskExecutionControls)[]) {
          const invoke = control[name] as (...args: unknown[]) => Promise<unknown>;
          if (name === 'saveTaskExecutionCheckpoint') await invoke({ input: f.input });
          else await invoke(f.input, f.proof, f.proof, 0, null);
          expect(executionControls[name]).toHaveBeenCalledTimes(1);
        }
      });
      expect(stopAll).toHaveBeenCalledTimes(1);
      await expect(model.prepareLocalTask(f.input)).rejects.toThrow('reader-host-closing');
    } finally {
      spy.mockRestore();
      vi.restoreAllMocks();
    }
  });
  it('rejects task effects on a reader-only project', async () => {
    const f = await fixture(),
      input = {
        schemaVersion: 1,
        admission: {
          schemaVersion: 1,
          preparation: f.input.preparation,
          plan: { path: 'plan.json', sha256: f.proof.sha256 },
          acceptance: f.proof,
        },
        executor: { path: 'executor.md', sha256: f.proof.sha256 },
        baseline: 'smoke',
      } as const;
    await f.host.runUntil(async () => {
      await expect(
        (f.models as unknown as LocalTaskActivities).prepareLocalTask(input),
      ).rejects.toThrow('local-task-host-unregistered');
      expect(() => (f.controls as unknown as LocalTaskControls).stopLocalTask(input)).toThrow(
        'local-task-host-unregistered',
      );
    });
  });
  it('rechecks immutable admissions and propagates storage errors before model work', async () => {
    const f = await fixture();
    await f.host.runUntil(async () => {
      const permit = await f.controls.registerReader(f.input, readerKey(f.input));
      expect(await f.controls.registerReader(f.input, readerKey(f.input))).toEqual(permit);
      const publish = vi.spyOn(files, 'publishFile').mockImplementation(() => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      });
      await expect(f.controls.registerReader(f.input, readerKey(f.input))).rejects.toThrow(
        'disk full',
      );
      publish.mockRestore();
    });
  });
  it.each(['0.154.0', '0.165.0-alpha.1.2', '0.169.1'])(
    'runs scoped preflight, preparation and final verification without creating a native actor: %s',
    async (clientVersion) => {
      const f = await fixture(clientVersion),
        input: ReviewInput = {
          schemaVersion: 1,
          preparation: f.input.preparation,
          reviewId: 'scoped',
          request: f.save({
            schemaVersion: 1,
            phase: 'planning',
            scope: 'scope',
            sharedPaths: [],
            roles: [
              {
                roleId: 'reviewer',
                applies: true,
                reason: 'Own scope',
                paths: [],
                complete: true,
                attestedBy: 'adapter',
                discoveryRule: 'declared',
                history: { complete: true, answers: [] },
              },
            ],
          }),
        };
      await f.host.runUntil(async () => {
        const plan = await f.models.prepareReviewPlan(input),
          reader = requireScoped(plan.decisions[0]!.input);
        const permit = await f.controls.registerReader(reader, readerKey(reader));
        expect(
          (await f.models.prepareControlledReader(reader, { permit, revision: 0, attempt: 0 }))
            .status,
        ).toBe('prepared');
        expect(
          (
            await f.models.finishReview({
              schemaVersion: 1,
              input,
              plan: plan.manifest,
              answers: [{ roleId: 'reviewer', answer: null }],
            })
          ).complete,
        ).toBe(false);
      });
      expect(() => f.models.prepareReviewPlan(input)).toThrow('reader-host-closing');
      expect(() =>
        f.models.finishReview({ schemaVersion: 1, input, plan: f.proof, answers: [] }),
      ).toThrow('reader-host-closing');
      expect(f.rpc.request).not.toHaveBeenCalled();
    },
  );
  it('reserves a separate control Worker and one model slot across projects and stops before releasing owner', async () => {
    const f = controlFixture(),
      second = controlFixture(),
      root = join(f.root, 'host');
    second.registration.project.projectId = 'second';
    const host = await createReaderHost(
      connection,
      'models',
      'workflow.js',
      [
        { registration: f.registration, rpc: f.rpc, authority: f.authority },
        { registration: second.registration, rpc: second.rpc, authority: second.authority },
      ],
      f.profile,
      root,
      2,
    );
    expect(
      sdk.create.mock.calls.map(([o]) => ({
        queue: o.taskQueue,
        slots: o.maxConcurrentActivityTaskExecutions,
      })),
    ).toEqual([
      { queue: 'models.control', slots: 1 },
      { queue: 'models', slots: 1 },
    ]);
    const controls = sdk.create.mock.calls[0]![0].activities as ReaderControlActivities,
      models = sdk.create.mock.calls[1]![0].activities as ControlledReaderActivities;
    await host.runUntil(async () => {
      const permit = await controls.registerReader(f.input, readerKey(f.input)),
        epoch = { permit, revision: 0, attempt: 0 };
      const prepared = await models.prepareControlledReader(f.input, epoch);
      expect(prepared.status).toBe('prepared');
      expect(() => models.createReader(f.input, prepared, undefined)).toThrow(
        'reader-epoch-required',
      );
      const absentSession = { id: 'absent', creation: f.proof };
      await expect(models.loadReader(f.input, prepared, absentSession, epoch)).rejects.toThrow();
      await expect(
        models.answerReader(f.input, prepared, absentSession, f.proof, epoch),
      ).rejects.toThrow();
      await expect(models.createReader(f.input, prepared, epoch)).rejects.toThrow(
        'unexpected-rpc:model/list',
      );
      await expect(
        models.prepareControlledReader(
          {
            ...f.input,
            preparation: {
              ...f.input.preparation,
              project: { ...f.input.preparation.project, projectId: 'unknown' },
            },
          },
          epoch,
        ),
      ).rejects.toThrow('reader-host-project-unregistered');
      expect((await controls.applyReaderCommand(f.input, permit, f.command())).revision).toBe(1);
      expect((await controls.stopReader(f.input, permit, 1)).status).toBe('stopped');
      expect(await controls.freezeReader(f.input, permit)).toBe(2);
      expect(existsSync(join(root, 'host-owner'))).toBe(true);
    });
    expect(existsSync(join(root, 'host-owner'))).toBe(false);
    await expect(controls.registerReader(f.input, readerKey(f.input))).rejects.toThrow(
      'reader-host-closing',
    );
    await expect(models.prepareControlledReader(f.input, f.epoch)).rejects.toThrow(
      'reader-host-closing',
    );
    expect(() =>
      models.createReader(f.input, { status: 'prepared', manifest: f.proof }, f.epoch),
    ).toThrow('reader-host-closing');
  });
  it('rejects duplicate host owners, unsupported profiles and inconsistent registrations', async () => {
    const f = await fixture();
    await expect(createReaderHost(connection, 'q', 'w', [], f.profile, f.root, 1)).rejects.toThrow(
      'EEXIST',
    );
    await f.host.runUntil(async () => {});
    for (const [projects, profile, cap, error] of [
      [[], f.profile, 1, 'reader-host-projects-required'],
      [
        [{ registration: f.registration, rpc: f.rpc, authority: f.authority }],
        { ...f.profile, clientVersion: 'other' },
        1,
        'unsupported-codex-client',
      ],
      [
        [{ registration: f.registration, rpc: f.rpc, authority: f.authority }],
        f.profile,
        -1,
        'reader-model-budget-invalid',
      ],
      [
        [
          { registration: f.registration, rpc: f.rpc, authority: f.authority },
          { registration: f.registration, rpc: f.rpc, authority: f.authority },
        ],
        f.profile,
        2,
        'reader-host-project-duplicate',
      ],
      [
        [
          { registration: f.registration, rpc: f.rpc, authority: f.authority },
          {
            registration: { ...f.registration, hostId: 'other' },
            rpc: f.rpc,
            authority: f.authority,
          },
        ],
        f.profile,
        2,
        'reader-host-owner-mismatch',
      ],
      [
        [
          { registration: f.registration, rpc: f.rpc, authority: f.authority },
          {
            registration: { ...f.registration, owner: 'other' },
            rpc: f.rpc,
            authority: f.authority,
          },
        ],
        f.profile,
        2,
        'reader-host-owner-mismatch',
      ],
    ] as const) {
      await expect(
        createReaderHost(connection, 'q', 'w', projects as never, profile, f.root, cap),
      ).rejects.toThrow(error);
      expect(existsSync(join(f.root, 'host-owner'))).toBe(false);
    }
  });
  it('waits for in-flight registration and refuses automatic takeover after an unknown native effect', async () => {
    const f = await fixture();
    let admission: Promise<unknown> | undefined;
    await f.host.runUntil(async () => {
      admission = f.controls.registerReader(f.input, readerKey(f.input));
    });
    await admission;
    expect(existsSync(join(f.root, 'host-owner'))).toBe(false);
    const g = await fixture();
    const primary = g.rpc.request.getMockImplementation()!;
    g.rpc.request.mockImplementation((m, p) =>
      m === 'model/list'
        ? Promise.resolve({
            data: [
              {
                model: g.profile.model,
                supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
              },
            ],
          })
        : m === 'thread/start'
          ? Promise.reject(new Error('lost'))
          : primary(m, p),
    );
    await expect(
      g.host.runUntil(async () => {
        const permit = await g.controls.registerReader(g.input, readerKey(g.input)),
          epoch = { permit, revision: 0, attempt: 0 };
        const prepared = await g.models.prepareControlledReader(g.input, epoch);
        await expect(g.models.createReader(g.input, prepared, epoch)).rejects.toThrow('lost');
      }),
    ).rejects.toThrow('reader-stop-unknown');
    expect(existsSync(join(g.root, 'host-owner'))).toBe(true);
  });
  it('releases on worker construction failure, propagates unexpected stop, and preserves a changed owner', async () => {
    const f = controlFixture(),
      root = join(f.root, 'host');
    sdk.create.mockRejectedValueOnce(new Error('connection'));
    await expect(
      createReaderHost(
        connection,
        'q',
        'w',
        [{ registration: f.registration, rpc: f.rpc, authority: f.authority }],
        f.profile,
        root,
        1,
      ),
    ).rejects.toThrow('connection');
    expect(existsSync(join(root, 'host-owner'))).toBe(false);
    const worker = fakeWorker();
    sdk.create.mockResolvedValue(worker);
    const host = await createReaderHost(
      connection,
      'q',
      'w',
      [{ registration: f.registration, rpc: f.rpc, authority: f.authority }],
      f.profile,
      root,
      1,
    );
    await expect(
      host.runUntil(async () => {
        worker.stop();
        return new Promise(() => {});
      }),
    ).rejects.toThrow('reader-host-stopped');
    sdk.create.mockImplementation(async () => fakeWorker());
    const next = await createReaderHost(
      connection,
      'q',
      'w',
      [{ registration: f.registration, rpc: f.rpc, authority: f.authority }],
      f.profile,
      root,
      1,
    );
    await expect(
      next.runUntil(async () => {
        writeFileSync(join(root, 'host-owner'), 'foreign');
      }),
    ).rejects.toThrow('reader-host-owner-changed');
  });
});
