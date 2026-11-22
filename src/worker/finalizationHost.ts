import { Worker } from '@temporalio/worker';
import type { NativeConnection } from '@temporalio/worker';
import type { ReaderAuthority } from '../contracts/readerControl.js';
import type { LocalProjectRegistration } from '../activities/preparation.js';
import { finalizationActivities } from '../activities/finalization.js';
import { readerHeartbeat } from './readerHeartbeat.js';

export function createFinalizationWorker(
  connection: NativeConnection,
  taskQueue: string,
  workflowsPath: string,
  registration: LocalProjectRegistration,
  authority: ReaderAuthority,
  directory: string,
) {
  const actual = finalizationActivities(registration, authority, directory);
  return Worker.create({
    connection,
    taskQueue,
    workflowsPath,
    activities: {
      reconcileFinalizedTask: actual.reconcileFinalizedTask,
      archiveFinalizedTask: (...args: Parameters<typeof actual.archiveFinalizedTask>) =>
        readerHeartbeat(() => actual.archiveFinalizedTask(...args)),
    },
    maxConcurrentActivityTaskExecutions: 1,
    maxHeartbeatThrottleInterval: '1 second',
  });
}
