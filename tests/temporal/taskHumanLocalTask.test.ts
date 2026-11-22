import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HumanManagedTaskInput, ManagedTaskInput } from '../../src/contracts/localTask.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import { taskHumanLocalFixture } from './taskHumanLocalFixture.js';
import { runReview, throughIntegration, acceptance } from './localTaskRun.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import * as artifacts from '../../src/adapters/artifacts/files.js';
import { controlRef } from '../../src/policy/readerControl.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { makeTaskExecutionCommand } from '../../src/client/taskExecution.js';
import { reserveTaskBackend, taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { captureTaskBudget } from '../../src/worker/taskBudget.js';
import type {
  TaskHumanCommand,
  TaskHumanCommandContext,
  TaskHumanFinishRequest,
  TaskHumanExecutionCheckpoint,
  TaskHumanActivities,
} from '../../src/contracts/taskHuman.js';
import {
  applyTaskHumanCommand,
  closeTaskHuman,
  createTaskHumanState,
  taskHumanCommandText,
} from '../../src/policy/taskHuman.js';

async function technical(human = true) {
  const f = await taskHumanLocalFixture(human),
    input = f.input,
    a = f.service.activities;
  await f.service.executionControls.prepareTaskExecution(input);
  const initialBudget = await f.service.executionControls.captureTaskExecutionBudget(input, null);
  const manifest = await f.service.humanActivities.prepareTaskHuman(input);
  const planning = await a.prepareSubstantialPlanning(input),
    approved = await runReview(f, planning);
  expect(approved.complete).toBe(true);
  const run = await throughIntegration(f, input, approved.manifest),
    accepted = await acceptance(f, run);
  expect(accepted.complete).toBe(true);
  const stopped = await f.service.controls.stopLocalTask(input);
  const context: TaskHumanCommandContext = {
    input,
    state: createTaskHumanState(manifest),
    technical: {
      input,
      snapshot: run.snapshot,
      packet: run.packet,
      acceptance: accepted.manifest,
      records: [
        planning.request,
        approved.manifest,
        run.snapshot,
        run.baseline.manifest,
        run.writer.answer,
        run.writer.stop,
        run.writer.tree,
        run.candidate.manifest,
        run.intent,
        run.integration,
        run.checked.manifest,
        run.packet.request,
        accepted.manifest,
      ],
      stopped,
    },
  };
  async function apply(action: 'ASK' | 'DECIDE', accepted = true) {
    const fields = {
      schemaVersion: 1 as const,
      commandId: action + context.state.revision,
      hash: 'a'.repeat(64),
      target: context.state.current.manifest.target,
      manifest: context.state.current.ref,
      expectedRevision: context.state.revision,
      author: input.admission.preparation.owner,
      source: f.save({ kind: 'synthetic-human-choice', action, revision: context.state.revision }),
      questionId: context.state.pending?.questionId ?? 'question' + context.state.revision,
      criterionId: f.criterion,
    };
    const raw = action === 'ASK' ? { ...fields, action } : { ...fields, action, accepted };
    const command: TaskHumanCommand = { ...raw, hash: digest(taskHumanCommandText(raw)) };
    f.allowHuman(command);
    const verified = await f.service.humanActivities.verifyTaskHumanCommand(context, command);
    context.state = applyTaskHumanCommand(context.state, command, verified).state;
    return command;
  }
  function request(): TaskHumanFinishRequest {
    return {
      schemaVersion: 1,
      kind: 'task-human-finish',
      ...context,
      state: closeTaskHuman(context.state, context.state.revision),
      expectedRevision: context.state.revision,
    };
  }
  const directory = join(
    f.workspace,
    '.git/agent-workflow/tasks',
    digest(context.state.current.manifest.target.workflowId),
    'execution-attempts',
    '0',
  );
  return { ...f, run, context, apply, request, directory, initialBudget };
}

afterEach(() => vi.restoreAllMocks());

describe('v12 local task admission and durable human completion', { timeout: 30000 }, () => {
  it('hands a private paused human checkpoint with real budget and pending proof to another factory under distinct Mock Activity runs', async () => {
    const f = await technical(),
      asked = await f.apply('ASK'),
      pause = makeTaskExecutionCommand({
        schemaVersion: 2,
        commandId: 'checkpoint-pause',
        action: 'pause',
        target: taskControlTarget(f.input),
        expectedRevision: 0,
        attempt: 0,
        author: f.input.admission.preparation.owner,
        source: f.proof,
        payload: f.save({
          schemaVersion: 1,
          kind: 'task-interruption',
          reason: 'Preserve pending question across a paused checkpoint',
        }),
      });
    const paused = await f.service.humanActivities.controlTaskHumanExecution(f.context, pause, 0),
      cold = f.makeService(),
      budget = await cold.executionControls.captureTaskExecutionBudget(
        f.input,
        f.initialBudget.manifest,
      );
    expect(budget.limit).toBe(f.initialBudget.limit);
    expect(budget.used).toBeGreaterThanOrEqual(f.initialBudget.used);
    expect(f.read(budget.manifest).kind).toBe('task-model-budget');
    const producerRun = 'synthetic-run',
      value: TaskHumanExecutionCheckpoint = {
        schemaVersion: 2,
        producer: { workflowId: localTaskKey(f.input), runId: producerRun },
        initial: f.input,
        input: f.input,
        revision: paused.ack.revision,
        history: [],
        commands: [paused.ack.authorization],
        previous: null,
        budget,
        beganAt: 42,
        diagnostics: [],
        humanState: f.context.state,
        technical: f.context.technical,
        wait: { kind: 'human-gates', paused: true },
      };
    await expect(
      f.service.humanActivities.saveTaskHumanCheckpoint({
        ...value,
        producer: { ...value.producer, runId: 'forged-producer' },
      }),
    ).rejects.toThrow('human-checkpoint-producer');
    const saved = await f.service.humanActivities.saveTaskHumanCheckpoint(value),
      pointer = join(
        taskBackendHome(f.workspace),
        'tasks',
        digest(localTaskKey(f.input)),
        'human-checkpoints',
        saved.sha256 + '.json',
      );
    expect(controlRef(JSON.parse(readFileSync(pointer, 'utf8')))).toEqual(saved);
    expect(lstatSync(pointer).mode & 0o077).toBe(0);
    expect(f.read(saved)).toMatchObject({
      kind: 'task-human-checkpoint',
      budget,
      wait: value.wait,
    });
    const consume = vi.fn(() => {
      throw new Error('Checkpoint handoff must not start a model');
    });
    const raw = localTaskActivities(f.registration, f.host, f.rpc, f.profile, consume, {
      instance: 'checkpoint-consumer-host',
      admitted: vi.fn(),
      taskQueue: f.taskQueue,
      namespace: f.namespace,
      budget: (_input, previous) => captureTaskBudget(f.budgetDirectory, f.store, previous),
    });
    const permission = readFileSync(join(f.directory, 'permission.json')),
      artifactsBefore = readdirSync(f.registration.artifactRoot).sort(),
      starts = f.state.starts,
      creates = f.state.creates,
      load = (predecessor = producerRun) =>
        f
          .environment('loadTaskHumanCheckpoint', 'checkpoint-consumer-run')
          .run<
            Parameters<TaskHumanActivities['loadTaskHumanCheckpoint']>,
            TaskHumanExecutionCheckpoint,
            TaskHumanActivities['loadTaskHumanCheckpoint']
          >(raw.humanActivities.loadTaskHumanCheckpoint, f.input, saved, predecessor);
    const loaded = await load();
    expect(loaded).toEqual(value);
    expect(loaded.humanState.pending?.questionId).toBe(asked.questionId);
    expect(loaded.technical).toEqual(f.context.technical);
    expect(loaded.humanState.history).toEqual(f.context.state.history);
    expect(loaded.humanState.decisions).toEqual([]);
    await expect(
      f
        .environment('loadTaskHumanCheckpoint')
        .run<
          Parameters<TaskHumanActivities['loadTaskHumanCheckpoint']>,
          TaskHumanExecutionCheckpoint,
          TaskHumanActivities['loadTaskHumanCheckpoint']
        >(raw.humanActivities.loadTaskHumanCheckpoint, f.input, saved, producerRun),
    ).rejects.toThrow('human-checkpoint-producer');
    await expect(load('forged-predecessor')).rejects.toThrow('human-checkpoint-producer');
    renameSync(pointer, pointer + '.retained');
    await expect(load()).rejects.toThrow();
    renameSync(pointer + '.retained', pointer);
    expect(await load()).toEqual(value);
    expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(permission);
    expect(readdirSync(f.registration.artifactRoot).sort()).toEqual(artifactsBefore);
    expect(f.state.starts).toBe(starts);
    expect(f.state.creates).toBe(creates);
    expect(consume).not.toHaveBeenCalled();
  });
  it('does not admit a task after stopAll overtakes its awaited start authority', async () => {
    const f = await taskHumanLocalFixture(),
      verify = f.startAuthority.verify.getMockImplementation()!;
    let entered = false,
      release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.startAuthority.verify.mockImplementationOnce(async (principal) => {
      entered = true;
      await waiting;
      return verify(principal);
    });
    const pending = f.service.executionControls.prepareTaskExecution(f.input),
      rejected = expect(pending).rejects.toThrow('local-task-host-closing');
    for (let tries = 0; !entered && tries < 100; tries++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(entered).toBe(true);
    await f.service.stopAll();
    await f.service.stopAll();
    release();
    await rejected;
    await expect(f.service.activities.prepareSubstantialPlanning(f.input)).rejects.toThrow(
      'local-task-host-closing',
    );
    expect(existsSync(join(taskBackendHome(f.workspace), 'tasks'))).toBe(false);
    expect(existsSync(join(f.registration.artifactRoot, 'copies'))).toBe(false);
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
    expect(f.state.readers).toBe(0);
  });
  it.each(['allow', 'missing', 'corrupt'] as const)(
    'requires a real prior v11 grant after policy2 activation: %s',
    async (mode) => {
      const f = substantialTaskFixture(),
        input: ManagedTaskInput = {
          ...f.substantialInput,
          schemaVersion: 11,
          continuation: { attempt: 0, previous: null },
        },
        home = taskBackendHome(f.workspace);
      declareBackendFixture(f.workspace);
      mkdirSync(home, { recursive: true });
      const policy = join(home, 'backend-policy.json');
      writeFileSync(policy, JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }));
      reserveTaskBackend(f.workspace, {
        schemaVersion: 1,
        projectId: input.admission.preparation.project.projectId,
        taskId: input.admission.preparation.taskId,
        backend: 'temporal',
        cardName: basename(input.admission.preparation.card),
        origin: digest(readFileSync(join(f.workspace, input.admission.preparation.card))),
      });
      const authority = {
          verify: vi.fn(async () => ({
            origin: 'human' as const,
            author: 'user',
            hash: f.proof.sha256,
            proof: f.proof,
          })),
        },
        host = { ...f.host, authority },
        budget = vi.fn(() => ({ limit: 20, used: 0, manifest: f.proof })),
        make = (instance: string) =>
          localTaskActivities(f.registration, host, f.rpc, f.profile, () => {}, {
            instance,
            admitted: vi.fn(),
            budget,
          });
      const directory = join(home, 'tasks', digest(localTaskKey(input)), 'execution-attempts', '0');
      let permission: Buffer | null = null;
      if (mode !== 'missing') {
        const old = make('prior-policy1-host');
        await old.executionControls.prepareTaskExecution(input);
        const planning = await old.activities.prepareSubstantialPlanning(input),
          accepted = await runReview({ ...f, input, service: old }, planning);
        expect(accepted.complete).toBe(true);
        await old.activities.prepareLocalTask(input, accepted.manifest);
        expect(existsSync(join(directory, 'grant.json'))).toBe(true);
        await old.controls.stopLocalTask(input);
        permission = readFileSync(join(directory, 'permission.json'));
        if (mode === 'corrupt') {
          const grant = JSON.parse(readFileSync(join(directory, 'grant.json'), 'utf8')) as Record<
            string,
            unknown
          >;
          writeFileSync(
            join(directory, 'grant.json'),
            JSON.stringify({ ...grant, input: { ...input, baseline: 'foreign' } }),
          );
        }
      }
      writeFileSync(
        policy,
        JSON.stringify({
          schemaVersion: 2,
          newTasks: 'temporal',
          startAdmission: 'task-start-admission/1',
        }),
      );
      const starts = f.state.starts,
        copies = existsSync(join(f.registration.artifactRoot, 'copies'));
      const cold = make('policy2-cold-reader');
      if (mode === 'allow') {
        expect(await cold.executionControls.captureTaskExecutionBudget(input, null)).toEqual({
          limit: 20,
          used: 0,
          manifest: f.proof,
        });
        expect(budget).toHaveBeenCalledExactlyOnceWith(input, null);
        expect(readFileSync(join(directory, 'permission.json'))).toEqual(permission);
      } else {
        await expect(
          cold.executionControls.captureTaskExecutionBudget(input, null),
        ).rejects.toThrow(mode === 'corrupt' ? 'task-start-legacy-admission-required' : undefined);
        expect(budget).not.toHaveBeenCalled();
      }
      expect(f.state.starts).toBe(starts);
      expect(f.state.creates).toBe(0);
      expect(existsSync(join(f.registration.artifactRoot, 'copies'))).toBe(copies);
    },
  );
  it('requires the assigned v12 principal authority before any technical task effects', async () => {
    const f = await taskHumanLocalFixture();
    Object.assign(f.host, { startAdmissionAuthority: undefined });
    const service = f.makeHumanService();
    await expect(service.activities.prepareSubstantialPlanning(f.input)).rejects.toThrow(
      'task-start-admission-required',
    );
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
    expect(existsSync(join(f.registration.artifactRoot, 'copies'))).toBe(false);
  });
  it('never permits the legacy public finish route to complete a registered v12 task', async () => {
    const f = await taskHumanLocalFixture();
    await expect(
      f.service.activities.finishLocalTask(
        f.input,
        f.proof,
        {
          schemaVersion: 1,
          preparation: f.input.admission.preparation,
          reviewId: 'unstarted',
          request: f.proof,
        },
        f.proof,
      ),
    ).rejects.toThrow('human-finish-required');
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
  });
  it('finishes from a cold host after real technical acceptance and stopped writer without obtaining a new writer lease', async () => {
    const f = await technical();
    const starts = f.state.starts,
      creates = f.state.creates;
    expect(creates).toBe(1);
    const source = taskFiles(f.registration.artifactRoot).binding(f.workspace);
    const before = readFileSync(join(f.directory, 'permission.json'));
    expect(JSON.parse(before.toString())).toMatchObject({ active: false });
    const budgetBefore = await f.service.executionControls.captureTaskExecutionBudget(
      f.input,
      f.initialBudget.manifest,
    );
    expect(budgetBefore.limit).toBe(f.initialBudget.limit);
    expect(budgetBefore.used).toBeGreaterThanOrEqual(f.initialBudget.used);
    const cold = f.makeHumanService('cold-human-worker'),
      command = (
        action: 'pause' | 'resume',
        revision: number,
        payload = f.save({
          schemaVersion: 1,
          kind: 'task-interruption',
          reason: 'Pause before human answer',
        }),
      ) =>
        makeTaskExecutionCommand({
          schemaVersion: 2,
          commandId: action + '-public',
          target: taskControlTarget(f.input),
          expectedRevision: revision,
          author: f.input.admission.preparation.owner,
          action,
          attempt: 0,
          source: f.proof,
          payload,
        });
    const paused = await f.service.humanActivities.controlTaskHumanExecution(
      f.context,
      command('pause', 0),
      0,
    );
    expect(paused.input).toEqual(f.input);
    const resume = f.save({
      schemaVersion: 2,
      kind: 'task-human-wait-resume',
      admission: f.input.admission,
      startAdmission: f.input.startAdmission,
    });
    expect(
      (
        await cold.humanActivities.controlTaskHumanExecution(
          f.context,
          command('resume', 1, resume),
          1,
        )
      ).input,
    ).toEqual(f.input);
    const budgetAfter = await cold.executionControls.captureTaskExecutionBudget(
      f.input,
      budgetBefore.manifest,
    );
    expect(budgetAfter.limit).toBe(budgetBefore.limit);
    expect(budgetAfter.used).toBe(budgetBefore.used);
    await f.apply('ASK');
    await f.apply('DECIDE', false);
    await f.apply('ASK');
    await f.apply('DECIDE');
    const request = f.request();
    const done = await cold.humanActivities.finishTaskHuman(request);
    expect(done.status).toBe('done');
    expect(await cold.humanActivities.finishTaskHuman(request)).toEqual(done);
    expect(f.read(done.result)).toMatchObject({ complete: true, input: f.input });
    expect(controlRef(f.read(done.result).humanCompletion)).toBeDefined();
    const intent = f.read(
      JSON.parse(readFileSync(join(f.directory, 'completion-intent.json'), 'utf8')) as {
        sha256: string;
        bytes: number;
      },
    );
    expect(intent.humanCompletion).toEqual(f.read(done.result).humanCompletion);
    expect(f.read(await cold.controls.stopLocalTask(f.input))).toMatchObject({
      confirmed: true,
      completed: true,
      input: f.input,
    });
    expect(
      await cold.executionControls.holdTaskExecution(
        f.input,
        { phase: 'done', snapshot: f.run.snapshot, planning: null, records: [] },
        f.context.technical.stopped,
        'read completed result',
        null,
      ),
    ).toEqual(done);
    await f.service.stopAll();
    const journalRoot = dirname(dirname(f.directory)),
      retained = () => ({
        artifacts: readdirSync(f.registration.artifactRoot).sort(),
        commands: ['execution-command-intents', 'execution-commands'].map((name) => ({
          name,
          files: readdirSync(join(journalRoot, name))
            .sort()
            .map((file) => ({
              file,
              bytes: readFileSync(join(journalRoot, name, file)),
            })),
        })),
      }),
      retainedBefore = retained();
    await expect(f.service.humanActivities.finishTaskHuman(request)).rejects.toThrow(
      'local-task-host-closing',
    );
    expect(retained()).toEqual(retainedBefore);
    expect(await cold.humanActivities.finishTaskHuman(request)).toEqual(done);
    expect(retained()).toEqual(retainedBefore);
    expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(before);
    expect(taskFiles(f.registration.artifactRoot).binding(f.workspace)).toEqual(source);
    expect(f.state.starts).toBe(starts);
    expect(f.state.creates).toBe(creates);
    expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).toContain('trim()');
  });
  it('completes a fully declared check-only task without manufacturing a human decision', async () => {
    const f = await technical(false),
      starts = f.state.starts;
    const result = await f
      .makeHumanService('cold-check-only')
      .humanActivities.finishTaskHuman(f.request());
    expect(result.status).toBe('done');
    expect(f.context.state.history).toEqual([]);
    expect(f.humanAuthority.verify).not.toHaveBeenCalled();
    expect(f.state.starts).toBe(starts);
  });
  it.each(['missing', 'mismatched'] as const)(
    'refuses a DONE result with %s human seal without another task effect',
    async (defect) => {
      const f = await technical();
      await f.apply('ASK');
      await f.apply('DECIDE');
      const request = f.request(),
        cold = f.makeHumanService('cold-done-inspector');
      const done = await cold.humanActivities.finishTaskHuman(request),
        body = { ...f.read(done.result) };
      if (defect === 'missing') delete body.humanCompletion;
      else body.humanCompletion = f.proof;
      const result = f.save(body),
        intentPath = join(f.directory, 'completion-intent.json');
      const commit = f.read(controlRef(JSON.parse(readFileSync(intentPath, 'utf8'))));
      const forgedCommit = f.save({ ...commit, result });
      writeFileSync(intentPath, JSON.stringify(forgedCommit));
      const card = readFileSync(join(f.workspace, f.input.admission.preparation.card)),
        starts = f.state.starts;
      await expect(cold.humanActivities.finishTaskHuman(request)).rejects.toThrow(
        'human-completion-result-binding',
      );
      expect(readFileSync(join(f.workspace, f.input.admission.preparation.card))).toEqual(card);
      expect(f.state.starts).toBe(starts);
      expect(f.state.creates).toBe(1);
    },
  );
  it.each(['missing', 'mismatched'] as const)(
    'refuses an interrupted completion intent with %s human seal before recovery effects',
    async (defect) => {
      const f = await technical();
      await f.apply('ASK');
      await f.apply('DECIDE');
      const request = f.request(),
        original = artifacts.publishFile;
      const disk = vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
        if (path.endsWith('/done.json')) throw new Error('done publication unavailable');
        original(path, bytes);
      });
      await expect(f.service.humanActivities.finishTaskHuman(request)).rejects.toThrow(
        'done publication unavailable',
      );
      disk.mockRestore();
      const intentPath = join(f.directory, 'completion-intent.json');
      const originalIntent = readFileSync(intentPath),
        commit = { ...f.read(controlRef(JSON.parse(originalIntent.toString()))) };
      if (defect === 'missing') delete commit.humanCompletion;
      else commit.humanCompletion = f.proof;
      writeFileSync(intentPath, JSON.stringify(f.save(commit)));
      const card = readFileSync(join(f.workspace, f.input.admission.preparation.card)),
        permission = readFileSync(join(f.directory, 'permission.json')),
        starts = f.state.starts;
      await expect(
        f.makeHumanService('cold-intent-inspector').humanActivities.finishTaskHuman(request),
      ).rejects.toThrow('human-completion-result-binding');
      expect(existsSync(join(f.directory, 'done.json'))).toBe(false);
      expect(readFileSync(join(f.workspace, f.input.admission.preparation.card))).toEqual(card);
      expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(permission);
      expect(f.state.starts).toBe(starts);
      expect(f.state.creates).toBe(1);
      writeFileSync(intentPath, originalIntent);
      const recovered = await f
        .makeHumanService('cold-valid-recovery')
        .humanActivities.finishTaskHuman(request);
      expect(recovered).toMatchObject({
        status: 'done',
        result: commit.result,
        projection: commit.projection,
      });
      expect(readFileSync(join(f.workspace, f.input.admission.preparation.card))).toEqual(card);
      expect(f.state.starts).toBe(starts);
      expect(f.state.creates).toBe(1);
    },
  );
  it('refuses raw v12 task entry before assignment or principal verification with zero task effects', async () => {
    const f = substantialTaskFixture();
    const input: HumanManagedTaskInput = {
      ...f.substantialInput,
      schemaVersion: 12,
      startAdmission: f.proof,
      continuation: { attempt: 0, previous: null },
    };
    const verify = vi.fn(async () => {});
    const service = localTaskActivities(
      f.registration,
      {
        ...f.host,
        startAdmissionAuthority: {
          issue: vi.fn(async () => ({
            owner: input.admission.preparation.owner,
            threadId: 'synthetic-thread',
            turnId: 'synthetic-turn',
            source: { locator: '/synthetic/primary.jsonl#L1', hash: f.proof.sha256 },
            proof: f.proof,
          })),
          verify,
        },
      },
      f.rpc,
      f.profile,
      () => {},
    );
    const request = {
      schemaVersion: 1 as const,
      preparation: input.admission.preparation,
      reviewId: 'not-executed',
      request: f.proof,
    };
    for (const action of [
      () => service.activities.prepareSubstantialPlanning(input),
      () => service.activities.prepareLocalTask(input, f.proof),
      () => service.activities.writeLocalTask(input, f.proof),
      () => service.activities.finishLocalTask(input, f.proof, request, f.proof),
      () => service.executionControls.prepareTaskExecution(input),
      () => service.humanActivities.prepareTaskHuman(input),
    ])
      await expect(action()).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
    expect(f.state.readers).toBe(0);
    expect(existsSync(join(f.registration.artifactRoot, 'copies'))).toBe(false);
    expect(existsSync(join(f.workspace, '.git/agent-workflow/tasks'))).toBe(false);
  });
});
