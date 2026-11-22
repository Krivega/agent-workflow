import {
  ApplicationFailure,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  condition,
  defineUpdate,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { ContinuingTaskInput, LocalTaskActivities } from '../contracts/localTask.js';
import type { ReaderCommandAck } from '../contracts/readerControl.js';
import type { TaskContinuationControls } from '../contracts/taskContinuation.js';
import { requireContract } from '../contracts/project.js';
import { parseLocalTask } from '../policy/localTask.js';
import { parsePayloadReaderCommand, readerCommandText } from '../policy/readerControl.js';
import { taskResumeCommand, checkTaskContinuation } from '../policy/taskContinuation.js';
import { reviewKey } from '../policy/review.js';
import { ReviewWorkflow } from './review.js';

export const taskPlanningControl = defineUpdate<ReaderCommandAck, [unknown]>('taskPlanningControl');
export interface TaskContinuationStatus {
  revision: number;
  waiting: boolean;
  held: ArtifactRef | null;
  history: ArtifactRef[];
}
export async function continuingTaskPlanning(
  initial: ContinuingTaskInput,
  activities: LocalTaskActivities,
  status: TaskContinuationStatus,
  changed: (input: ContinuingTaskInput, phase: string) => void,
) {
  let input = initial,
    resumed: ContinuingTaskInput | null = null;
  const controls = proxyActivities<TaskContinuationControls>({
    taskQueue: workflowInfo().taskQueue + '.control',
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 1 },
  });
  const accepted = new Map<string, { key: string; ack: ReaderCommandAck }>();
  let pending: { id: string; key: string; result: Promise<ReaderCommandAck> } | null = null;
  setHandler(taskPlanningControl, async (raw) => {
    try {
      const command = parsePayloadReaderCommand(raw),
        key = command.hash + readerCommandText(command);
      const prior = accepted.get(command.commandId);
      if (prior !== undefined) {
        requireContract(prior.key === key, 'task-command-id-conflict');
        return prior.ack;
      }
      if (pending !== null && pending.id === command.commandId) {
        requireContract(pending.key === key, 'task-command-id-conflict');
        return await pending.result;
      }
      requireContract(
        status.waiting && status.held !== null && pending === null,
        'task-resume-not-held',
      );
      taskResumeCommand(input, command, status.revision);
      const result = (async () => {
        const outcome = await controls.resumeTaskPlanning(
          input,
          status.held!,
          command,
          status.revision,
        );
        const next = parseLocalTask(outcome.input);
        requireContract(
          next.schemaVersion === 10 &&
            next.continuation.attempt === command.attempt &&
            next.continuation.previous !== null &&
            outcome.ack.commandId === command.commandId &&
            outcome.ack.hash === command.hash &&
            outcome.ack.revision === status.revision + 1,
          'task-command-receipt-invalid',
        );
        checkTaskContinuation(input, {
          schemaVersion: 1,
          kind: 'task-planning-resume',
          held: status.held!,
          admission: next.admission,
        });
        requireContract(
          JSON.stringify(next.executor) === JSON.stringify(input.executor) &&
            next.baseline === input.baseline,
          'task-command-receipt-invalid',
        );
        status.revision = outcome.ack.revision;
        status.waiting = false;
        resumed = next;
        accepted.set(command.commandId, { key, ack: outcome.ack });
        return outcome.ack;
      })();
      pending = { id: command.commandId, key, result };
      try {
        return await result;
      } finally {
        pending = null;
      }
    } catch (failure) {
      throw ApplicationFailure.nonRetryable(String(failure), 'TaskCommandRejected');
    }
  });
  for (;;) {
    changed(input, input.continuation.attempt === 0 ? 'planning' : 'replanning');
    const planning = await activities.prepareSubstantialPlanning(input);
    const review = await executeChild(ReviewWorkflow, {
      args: [planning],
      workflowId: reviewKey(planning),
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    });
    if (review.status === 'reviewed' && review.complete) {
      changed(input, 'preparing');
      return { input, review: review.manifest };
    }
    requireContract(review.status === 'reviewed', 'task-planning-unknown');
    changed(input, 'stopping-planning');
    status.held = await controls.holdTaskPlanning(input, planning, review.manifest);
    status.history.push(status.held);
    status.waiting = true;
    changed(input, 'waiting-human');
    await condition(() => resumed !== null && pending === null);
    input = resumed!;
    resumed = null;
  }
}
