import {
  Client,
  Connection,
  ServiceError,
  WorkflowFailedError,
  WorkflowNotFoundError,
  isGrpcServiceError,
  type WorkflowExecutionStatusName,
} from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import { isDeepStrictEqual as same } from 'node:util';
import { basename } from 'node:path';
import { artifactStore } from '../adapters/artifacts/files.js';
import { taskBackendGuard } from '../adapters/project/taskBackend.js';
import type { TaskExecutionCompletion } from '../contracts/taskExecution.js';
import { object, parseProject, requireContract } from '../contracts/project.js';
import { localTaskKey, parseLocalTask } from '../policy/localTask.js';
import { checkRegistration } from '../policy/preparation.js';
import { controlRef } from '../policy/readerControl.js';
import { parseTaskStartAdmission, taskStartTarget } from '../policy/taskStartAdmission.js';
import { parsePreparedTaskRegistration, verifyPreparedTaskAdmission } from './localTask.js';

function localAssignment(
  guard: ReturnType<typeof taskBackendGuard>,
  projectId: string,
  taskId: string,
) {
  try {
    return guard.require(projectId, taskId, 'temporal', 'sdk');
  } catch (error) {
    if (error instanceof Error && error.message === 'backend-assignment-required') return null;
    throw error;
  }
}

async function finishedTask(
  client: Client,
  workflowId: string,
  runId: string,
  executionStatus: WorkflowExecutionStatusName,
) {
  try {
    const outcome = (await client.workflow
      .getHandle(workflowId, runId, { followRuns: false })
      .result()) as TaskExecutionCompletion;
    const summary = {
      history: outcome.history.map(controlRef),
      commands: outcome.commands.map(controlRef),
      checkpoint: outcome.checkpoint === null ? null : controlRef(outcome.checkpoint),
    };
    if (outcome.status === 'done')
      return {
        status: 'done',
        reason: null,
        evidence: {
          ...summary,
          result: controlRef(outcome.result),
          projection: controlRef(outcome.projection),
        },
      } as const;
    requireContract(outcome.status === 'cancelled', 'task-chat-temporal-result-invalid');
    return {
      status: 'cancelled',
      reason: outcome.error || outcome.stopFailure || 'task-cancelled',
      evidence: {
        ...summary,
        stop: controlRef(outcome.stop),
        held: outcome.held === null ? null : controlRef(outcome.held),
      },
    } as const;
  } catch (error) {
    if (!(error instanceof WorkflowFailedError)) throw error;
    return {
      status: executionStatus === 'CANCELLED' ? 'cancelled' : 'failed',
      reason: error.cause?.message ?? error.message,
    } as const;
  }
}

/** Read the latest execution in the registered task's Workflow ID chain. */
export async function readPreparedLocalTask(
  workspace: string,
  config: unknown,
  workflowId: string,
  action: 'status' | 'result',
) {
  const { address, namespace, taskQueue, registration } = parsePreparedTaskRegistration(
    config,
    workspace,
  );
  const project = parseProject(registration.project);
  const match =
    /^aw\/task\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/u.exec(
      workflowId,
    );
  requireContract(match !== null, 'task-chat-temporal-workflow-id');
  const projectId = match[1]!,
    taskId = match[2]!;
  requireContract(projectId === project.projectId, 'task-chat-temporal-read-registration');
  const guard = taskBackendGuard(workspace, true);
  const assignment = localAssignment(guard, projectId, taskId);
  const connection = Connection.lazy({ address });
  try {
    if (assignment !== null) {
      requireContract(
        assignment.schemaVersion === 2 &&
          same(assignment.route, { address: connection.options.address, namespace, taskQueue }),
        'task-chat-temporal-read-registration',
      );
      const store = artifactStore(registration.artifactRoot, { existingOnly: true });
      const admission = parseTaskStartAdmission(
        JSON.parse(store.read(assignment.startAdmission).toString()) as unknown,
      );
      const preparation = {
        schemaVersion: 1 as const,
        project,
        taskId,
        hostId: registration.hostId,
        owner: registration.owner,
        generation: registration.generation,
        revision: admission.target.requirementsRevision,
        card: admission.card.path,
      };
      requireContract(
        same(admission.target, taskStartTarget(preparation)),
        'task-chat-temporal-read-registration',
      );
      await verifyPreparedTaskAdmission(
        registration,
        assignment.startAdmission,
        preparation,
        admission.principal.threadId,
        assignment,
      );
    }
    const client = new Client({ connection, namespace });
    return await connection.withDeadline(Date.now() + 5000, async () => {
      const latest = client.workflow.getHandle(workflowId);
      let description = await latest.describe();
      if (description.status.name === 'CONTINUED_AS_NEW') description = await latest.describe();
      requireContract(
        description.status.name !== 'CONTINUED_AS_NEW',
        'task-chat-temporal-continuing',
      );
      const { runId } = description;
      requireContract(
        assignment?.schemaVersion === 2 &&
          description.workflowId === workflowId &&
          description.type === 'LocalTaskWorkflow' &&
          description.taskQueue === taskQueue,
        'task-chat-temporal-read-registration',
      );
      const history = await connection.workflowService.getWorkflowExecutionHistory({
        namespace,
        execution: { workflowId, runId },
        maximumPageSize: 1,
      });
      const payload =
        history.history?.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
      requireContract(payload !== undefined, 'task-chat-temporal-read-history');
      const input = parseLocalTask(defaultPayloadConverter.fromPayload(payload));
      requireContract(
        input.schemaVersion === 12 &&
          workflowId === localTaskKey(input) &&
          same(assignment.startAdmission, input.startAdmission) &&
          assignment.cardName === basename(input.admission.preparation.card),
        'task-chat-temporal-read-registration',
      );
      checkRegistration(input.admission.preparation, registration);
      requireContract(
        same(localAssignment(guard, projectId, taskId), assignment),
        'task-chat-temporal-read-registration',
      );

      const executionStatus = description.status.name;
      const execution = { workflowId, runId, executionStatus };
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT'].includes(executionStatus))
        return {
          ...execution,
          ...(await finishedTask(client, workflowId, runId, executionStatus)),
        };
      requireContract(
        executionStatus === 'RUNNING' || executionStatus === 'PAUSED',
        'task-chat-temporal-status-unknown',
      );
      const state = object(
        await client.workflow.getHandle(workflowId, runId).query('localTaskStatus'),
      );
      requireContract(
        state.runId === runId && typeof state.phase === 'string',
        'task-chat-temporal-status-binding',
      );
      const reason =
        [state.stopFailure, state.checkpointFailure, state.error, state.budgetFailure].find(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ) ??
        (
          {
            'waiting-human-gates': 'task-human-decision-required',
            'waiting-human': 'task-execution-held',
            'human-paused': 'task-human-paused',
          } as Record<string, string>
        )[state.phase] ??
        null;
      return {
        ...execution,
        status: action === 'result' ? ('pending' as const) : ('running' as const),
        phase: state.phase,
        reason,
      };
    });
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) throw Error('task-chat-temporal-task-not-found');
    const cause = error instanceof ServiceError ? error.cause : error;
    // gRPC DEADLINE_EXCEEDED / UNAVAILABLE.
    if (isGrpcServiceError(cause) && (cause.code === 4 || cause.code === 14))
      throw Error('task-chat-temporal-server-unavailable');
    throw error;
  } finally {
    await connection.close();
  }
}
