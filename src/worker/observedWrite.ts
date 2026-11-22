import { isDeepStrictEqual as same } from 'node:util';
import { join } from 'node:path';
import type { Client } from '@temporalio/client';
import type { LocalTaskHost } from '../activities/localTask.js';
import { localTaskActivities } from '../activities/localTask.js';
import type { ReaderProjectHost } from './readerHost.js';
import type { LocalTaskInput } from '../contracts/localTask.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import { requireContract } from '../contracts/project.js';
import { digest, publishFile, readPrivateFile } from '../adapters/artifacts/files.js';
import { localTaskKey } from '../policy/localTask.js';
import { taskAdmissionIdentity, taskAdmissionsRelativePath } from '../policy/taskRecovery.js';
import { readerBudget } from '../adapters/codex/readerBudget.js';
import { recordWrittenActivity, writtenActivityReceipt } from './writtenTaskRecovery.js';

/** Delivered over private host IPC. Never persist the Temporal task token. */
export interface WriteObservation {
  input: LocalTaskInput;
  snapshot: ArtifactRef;
  execution: { workflowId: string; runId: string };
  activityId: string;
  taskToken: Uint8Array;
  instance: string;
  workerPid: number;
}

export async function observeLocalWrite(
  client: Client,
  directory: string,
  project: ReaderProjectHost & { localTasks: LocalTaskHost },
  maxTurnStarts: number,
  job: WriteObservation,
) {
  const { execution, instance, input, activityId, taskToken } = job;
  const owner = { pid: job.workerPid, id: instance };
  requireContract(
    process.pid !== owner.pid &&
      input.schemaVersion === 1 &&
      execution.workflowId === localTaskKey(input) &&
      same(JSON.parse(readPrivateFile(join(directory, 'host-owner')).toString()), {
        ...owner,
        tasks: true,
        taskBindings: 3,
      }),
    'observed-write-owner',
  );
  const admission = join(
    directory,
    taskAdmissionsRelativePath(instance, 3),
    digest(taskAdmissionIdentity(input)),
  );
  const receipt = writtenActivityReceipt(directory, instance, execution, activityId);
  await client.activity.heartbeat(taskToken);
  // A second delivery must never acquire the same write, including after an unknown exit.
  publishFile(
    receipt + '-observer',
    Buffer.from(JSON.stringify({ execution, activityId, owner, pid: process.pid })),
  );
  const host = project.localTasks;
  const consume = readerBudget(join(directory, 'turn-credits'), maxTurnStarts);
  let failed: unknown,
    closed = false;
  let runtime: ReturnType<typeof host.createRuntime> | undefined;
  let beat: Promise<void> | undefined;
  const timer = setInterval(() => {
    beat ??= client.activity
      .heartbeat(taskToken)
      .catch((error: unknown) => {
        failed = error;
        runtime?.close();
      })
      .finally(() => {
        beat = undefined;
      });
  }, 1000);
  try {
    const ensureLive = () => {
      if (failed) throw failed;
    };
    const local = localTaskActivities(
      project.registration,
      {
        ...host,
        createRuntime(root) {
          ensureLive();
          runtime = host.createRuntime(root);
          return runtime;
        },
      },
      project.rpc,
      host.profile,
      (key, hash) => {
        ensureLive();
        consume(key, hash);
      },
      {
        instance,
        admitted(value, gate) {
          requireContract(
            same(JSON.parse(readPrivateFile(admission).toString()), {
              schemaVersion: 1,
              host: owner,
              input: value,
              gate,
            }),
            'observed-write-admission',
          );
        },
      },
    );
    const result = await local.activities.writeLocalTask(input, job.snapshot);
    clearInterval(timer);
    await beat;
    ensureLive();
    await client.activity.heartbeat(taskToken);
    recordWrittenActivity(receipt, result);
    closed = true;
    await client.activity.complete(taskToken, result);
  } catch (error) {
    if (!closed) {
      runtime?.close();
      await client.activity.fail(taskToken, error);
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
}
