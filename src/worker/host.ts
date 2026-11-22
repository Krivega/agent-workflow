import { Worker } from '@temporalio/worker';
import type { NativeConnection } from '@temporalio/worker';
import { preparationActivities } from '../activities/preparation.js';
import { localAdmissionActivities } from '../activities/localAdmission.js';
import type { LocalProjectRegistration } from '../activities/preparation.js';

export function createPreparationWorker(
  connection: NativeConnection,
  taskQueue: string,
  workflowsPath: string,
  registration: LocalProjectRegistration,
): Promise<Worker> {
  return Worker.create({
    connection,
    taskQueue,
    workflowsPath,
    activities: {
      ...preparationActivities(registration),
      ...localAdmissionActivities(registration),
    },
    maxConcurrentActivityTaskExecutions: 1,
  });
}
