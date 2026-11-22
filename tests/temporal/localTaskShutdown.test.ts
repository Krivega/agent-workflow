import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTaskFixture } from './localTaskFixture.js';
import { taskHumanLocalFixture } from './taskHumanLocalFixture.js';
import { acceptance, throughIntegration } from './localTaskRun.js';
import * as checks from '../../src/adapters/project/taskChecks.js';
import { taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { MockActivityEnvironment } from '@temporalio/testing';
import { localTaskActivities } from '../../src/activities/localTask.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import type { ManagedTaskInput } from '../../src/contracts/localTask.js';
import type { ReaderAuthority } from '../../src/contracts/readerControl.js';
import { makeTaskExecutionCommand } from '../../src/client/taskExecution.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { object } from '../../src/contracts/project.js';
import { controlRef } from '../../src/policy/readerControl.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function controlledChecks() {
  const original = vi.mocked(checks.taskChecks).getMockImplementation()!;
  const stop = vi.fn<ReturnType<typeof checks.taskChecks>['stop']>(async () => []);
  vi.mocked(checks.taskChecks).mockImplementation((...args) => ({ ...original(...args), stop }));
  return stop;
}
afterEach(() => vi.restoreAllMocks());
describe('local task host shutdown phases', { timeout: 30000 }, () => {
  it('retains completed legacy bindings and original terminal errors after successful shutdown, without another Writer', async () => {
    const f = localTaskFixture(),
      run = await throughIntegration(f),
      reviewed = await acceptance(f, run);
    const done = await f.service.activities.finishLocalTask(
      f.input,
      run.snapshot,
      run.packet,
      reviewed.manifest,
    );
    const before = { starts: f.state.starts, creates: f.state.creates };
    await f.service.stopAll();
    await expect(f.service.activities.prepareLocalTask(f.input)).rejects.toThrow(
      'task-already-closed',
    );
    expect(
      await f.service.activities.finishLocalTask(
        f.input,
        run.snapshot,
        run.packet,
        reviewed.manifest,
      ),
    ).toEqual(done);
    await expect(
      f.service.activities.finishLocalTask(
        f.input,
        run.snapshot,
        { ...run.packet, reviewId: 'foreign' },
        reviewed.manifest,
      ),
    ).rejects.toThrow('task-completion-binding');
    expect({ starts: f.state.starts, creates: f.state.creates }).toEqual(before);
  });
  it('keeps every non-STOP fenced until the last known actor has actually stopped, while preserving unknown STOP metadata', async () => {
    const f = localTaskFixture(),
      stop = controlledChecks();
    await f.service.activities.prepareLocalTask(f.input);
    await f.service.controls.stopLocalTask(f.input);
    const second = structuredClone(f.input);
    second.admission.preparation.taskId = 'second';
    await f.service.activities.prepareLocalTask(second);
    const entered = deferred(),
      release = deferred();
    stop.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
    const shutting = f.service.stopAll();
    await entered.promise;
    await expect(f.service.activities.prepareLocalTask(f.input)).rejects.toThrow(
      'local-task-host-closing',
    );
    const unknown = structuredClone(f.input);
    unknown.admission.preparation.taskId = 'unknown';
    await expect(f.service.activities.prepareLocalTask(unknown)).rejects.toThrow(
      'local-task-host-closing',
    );
    const notStarted = await f.service.controls.stopLocalTask(unknown);
    expect(f.read(notStarted)).toMatchObject({ kind: 'task-not-started', confirmed: true });
    const directory = join(taskBackendHome(f.workspace), 'tasks', digest(localTaskKey(unknown)));
    expect(existsSync(join(directory, 'grant.json'))).toBe(false);
    expect(existsSync(join(directory, 'permission.json'))).toBe(false);
    release.resolve();
    await shutting;
    expect(await f.service.controls.stopLocalTask(unknown)).toEqual(notStarted);
    await expect(f.service.activities.prepareLocalTask(unknown)).rejects.toThrow(
      'local-task-host-closing',
    );
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
  });
  it('retains the shutdown fence after a failed STOP and allows a verified retry without restoring permission', async () => {
    const f = localTaskFixture(),
      stop = controlledChecks();
    await f.service.activities.prepareLocalTask(f.input);
    stop.mockRejectedValueOnce(new Error('synthetic STOP failure'));
    await expect(f.service.stopAll()).rejects.toThrow('synthetic STOP failure');
    await expect(f.service.activities.prepareLocalTask(f.input)).rejects.toThrow(
      'local-task-host-closing',
    );
    const directory = join(taskBackendHome(f.workspace), 'tasks', digest(localTaskKey(f.input)));
    expect(JSON.parse(readFileSync(join(directory, 'permission.json'), 'utf8'))).toMatchObject({
      active: false,
    });
    await f.service.stopAll();
    expect(await f.service.controls.stopLocalTask(f.input)).toBeDefined();
    expect(JSON.parse(readFileSync(join(directory, 'permission.json'), 'utf8'))).toMatchObject({
      active: false,
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
  });
  it('keeps known version12 operations closed after successful shutdown and permits retained reads only through a new host', async () => {
    const f = await taskHumanLocalFixture();
    await f.service.executionControls.prepareTaskExecution(f.input);
    await f.service.stopAll();
    await expect(f.service.humanActivities.prepareTaskHuman(f.input)).rejects.toThrow(
      'local-task-host-closing',
    );
    await expect(f.service.executionControls.prepareTaskExecution(f.input)).rejects.toThrow(
      'local-task-host-closing',
    );
    const cold = f.makeHumanService('cold-after-shutdown');
    expect(await cold.humanActivities.prepareTaskHuman(f.input)).toEqual(f.declaration.manifest);
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
  });
  it('rejects a fresh valid held11 RESUME after shutdown before native verification or a new command intent and ACK', async () => {
    const f = substantialTaskFixture(),
      input: ManagedTaskInput = {
        ...f.substantialInput,
        schemaVersion: 11,
        continuation: { attempt: 0, previous: null },
      },
      verify = vi.fn<ReaderAuthority['verify']>(async (command) => ({
        origin: 'human',
        author: command.author,
        hash: command.hash,
        proof: f.proof,
      })),
      service = localTaskActivities(
        f.registration,
        { ...f.host, authority: { verify } },
        f.rpc,
        f.profile,
        () => {},
      ),
      environment = new MockActivityEnvironment();
    const run = <T>(invoke: () => Promise<T>) => environment.run<[], T, () => Promise<T>>(invoke);
    const command = (
      action: 'pause' | 'resume',
      revision: number,
      payload = f.save({ schemaVersion: 1, kind: 'task-interruption', reason: 'Synthetic pause' }),
    ) =>
      makeTaskExecutionCommand({
        schemaVersion: 2,
        commandId: action + '-shutdown',
        action,
        author: input.admission.preparation.owner,
        target: taskControlTarget(input),
        expectedRevision: revision,
        attempt: action === 'resume' ? 1 : 0,
        source: f.proof,
        payload,
      });
    const seal = await run(() => service.executionControls.prepareTaskExecution(input)),
      pause = command('pause', 0),
      ack = await run(() => service.executionControls.interruptTaskExecution(input, pause, 0)),
      stopped = await service.controls.stopLocalTask(input),
      held = await run(() =>
        service.executionControls.holdTaskExecution(
          input,
          { phase: 'admitting', snapshot: null, planning: null, records: [controlRef(seal)] },
          stopped,
          'Synthetic held task',
          ack,
        ),
      );
    if (object(held).status !== 'held') throw new Error('actual held receipt required');
    const heldRef = controlRef(object(held).held),
      resume = command(
        'resume',
        1,
        f.save({
          schemaVersion: 1,
          kind: 'task-execution-resume',
          held: heldRef,
          admission: input.admission,
        }),
      );
    await service.stopAll();
    const directory = join(taskBackendHome(f.workspace), 'tasks', digest(localTaskKey(input))),
      paths = ['execution-command-intents/1.json', 'execution-commands/pause-shutdown.json'],
      before = paths.map((path) => readFileSync(join(directory, path)));
    await expect(
      run(() => service.executionControls.resumeTaskExecution(input, heldRef, resume, 1)),
    ).rejects.toThrow('local-task-host-closing');
    expect(paths.map((path) => readFileSync(join(directory, path)))).toEqual(before);
    expect(readdirSync(join(directory, 'execution-command-intents'))).toEqual(['1.json']);
    expect(readdirSync(join(directory, 'execution-commands'))).toEqual(['pause-shutdown.json']);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
  });
});
