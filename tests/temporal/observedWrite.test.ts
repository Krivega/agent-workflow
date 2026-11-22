import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@temporalio/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeLocalWrite, type WriteObservation } from '../../src/worker/observedWrite.js';
import * as activities from '../../src/activities/localTask.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { writtenActivityReceipt } from '../../src/worker/writtenTaskRecovery.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import {
  taskAdmissionIdentity,
  taskAdmissionsRelativePath,
} from '../../src/policy/taskRecovery.js';
import { localTaskFixture } from './localTaskFixture.js';

async function fixture() {
  const f = localTaskFixture();
  const root = join(f.root, 'observer-host');
  const snapshot = await f.service.activities.prepareLocalTask(f.input);
  await f.service.activities.checkLocalTask(f.input, snapshot, 'baseline', null, null);
  const workflowId = localTaskKey(f.input);
  const directory = join(f.workspace, '.git/agent-workflow/tasks', digest(workflowId));
  const grant = readFileSync(join(directory, 'grant.json'));
  const instance = (JSON.parse(grant.toString()) as { instance: string }).instance;
  const owner = { pid: 2147483647, id: instance };
  const path = join(root, taskAdmissionsRelativePath(instance, 3));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  function put(path: string, data: unknown) {
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  }
  put(join(root, 'host-owner'), { ...owner, tasks: true, taskBindings: 3 });
  const admission = join(path, digest(taskAdmissionIdentity(f.input)));
  put(admission, {
    schemaVersion: 1,
    host: owner,
    input: f.input,
    gate: { directory, grant: { sha256: digest(grant), bytes: grant.length }, mode: 'owned' },
  });
  const job: WriteObservation = {
    input: f.input,
    snapshot,
    instance,
    execution: { workflowId, runId: 'original' },
    activityId: 'write',
    taskToken: Buffer.from('token'),
    workerPid: owner.pid,
  };
  const activity = {
    heartbeat: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  };
  const project = {
    registration: f.registration,
    authority: f.authority,
    rpc: f.rpc,
    localTasks: f.host,
  };
  const run = () => observeLocalWrite({ activity } as unknown as Client, root, project, 5, job);
  const receipt = writtenActivityReceipt(root, instance, job.execution, job.activityId);
  return { f, activity, job, run, receipt, admission };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('independent B1 write observer', () => {
  it('finishes the original activity only once and ties its result to the physical stop', async () => {
    const v = await fixture();
    await v.run();
    const result: unknown = JSON.parse(readFileSync(v.receipt, 'utf8'));
    expect(v.activity.complete).toHaveBeenCalledWith(v.job.taskToken, result);
    await expect(v.run()).rejects.toThrow('EEXIST');
    expect(v.activity.complete).toHaveBeenCalledTimes(1);
  });
  it('refuses same-process observation and a changed admission before native dispatch', async () => {
    const v = await fixture(),
      pid = v.job.workerPid;
    v.job.workerPid = process.pid;
    await expect(v.run()).rejects.toThrow('observed-write-owner');
    v.job.workerPid = pid;
    writeFileSync(v.admission, '{}');
    await expect(v.run()).rejects.toThrow('observed-write-admission');
    expect(v.activity.fail).toHaveBeenCalledTimes(1);
    expect(v.activity.complete).not.toHaveBeenCalled();
  });
  it('keeps an ambiguous completion intact when delivery of the result fails', async () => {
    const v = await fixture();
    v.activity.complete.mockRejectedValueOnce(Error('delivery unknown'));
    await expect(v.run()).rejects.toThrow('delivery unknown');
    expect(readFileSync(v.receipt).length).toBeGreaterThan(0);
    expect(v.activity.fail).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'fences future model requests after a heartbeat rejection, already started=%s',
    async (started) => {
      const v = await fixture();
      vi.useFakeTimers();
      let reject!: (error: Error) => void;
      v.activity.heartbeat.mockResolvedValueOnce().mockImplementationOnce(
        () =>
          new Promise<void>((_, no) => {
            reject = no;
          }),
      );
      const close = vi.fn();
      vi.spyOn(v.f.host, 'createRuntime').mockImplementation(() => ({ close }) as never);
      vi.spyOn(activities, 'localTaskActivities').mockImplementation(
        (_r, host, _rpc, _p, consume) =>
          ({
            activities: {
              async writeLocalTask() {
                if (started) host.createRuntime(v.f.root);
                await vi.advanceTimersByTimeAsync(2300);
                reject(Error('activity lost'));
                await vi.advanceTimersByTimeAsync(0);
                if (started) consume('unused', 'unused');
                else host.createRuntime(v.f.root);
              },
            },
          }) as never,
      );
      await expect(v.run()).rejects.toThrow('activity lost');
      expect(v.activity.complete).not.toHaveBeenCalled();
      expect(close.mock.calls.length > 0).toBe(started);
    },
  );
});
