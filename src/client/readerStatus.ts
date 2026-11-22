import type { Client } from '@temporalio/client';
import type { ReaderDiagnostic, ReaderStatus } from '../contracts/readerControl.js';
import { requireContract, text } from '../contracts/project.js';
import { digest } from '../adapters/artifacts/files.js';

export interface ReaderObservation {
  workflowId: string;
  runId: string;
  taskQueue: string;
  executionStatus: string;
  workerVersion: string | null;
  reader: ReaderStatus | null;
  operationId: string | null;
  diagnostic: ReaderDiagnostic;
  pending: {
    id: string;
    type: string;
    attempt: number;
    maximumAttempts: number;
    waitedMs: number | null;
    lastFailure: string | null;
  }[];
  queryError: string | null;
  historyError: string | null;
}

function waited(
  value: { seconds?: unknown; nanos?: number | null } | null | undefined,
): number | null {
  if (value == null) return null;
  const time = Number(value.seconds) * 1000 + Number(value.nanos ?? 0) / 1e6;
  return Number.isFinite(time) ? Math.max(0, Date.now() - time) : null;
}

export async function readReaderStatus(
  client: Client,
  workflowId: string,
): Promise<ReaderObservation> {
  text(workflowId);
  const handle = client.workflow.getHandle(workflowId);
  const description = await client.connection.withDeadline(Date.now() + 5000, () =>
    handle.describe(),
  );
  let reader: ReaderStatus | null = null,
    queryError: string | null = null,
    historyError: string | null = null;
  let diagnostic: ReaderDiagnostic = {
    kind: 'terminal',
    reason: description.status.name,
    nextAction: 'Проверить сохранённый результат; завершение Temporal не означает PASS роли.',
    evidenceHash: null,
  };
  let operationId: string | null = null;
  const pending = (description.raw.pendingActivities ?? []).map((item) => ({
    id: item.activityId ?? '',
    type: item.activityType?.name ?? '',
    attempt: item.attempt ?? 0,
    maximumAttempts: item.maximumAttempts ?? 0,
    waitedMs: waited(item.scheduledTime),
    lastFailure: item.lastFailure?.message ?? null,
  }));
  let workerVersion =
    description.raw.workflowExecutionInfo?.mostRecentWorkerVersionStamp?.buildId ?? null;
  if (description.status.name === 'RUNNING') {
    try {
      const observed = await client.connection.withDeadline(Date.now() + 1000, () =>
        handle.query<ReaderStatus>('readerStatus'),
      );
      requireContract(
        observed.schemaVersion === 1 &&
          observed.target.workflowId === workflowId &&
          observed.runId === description.runId,
        'reader-status-binding-invalid',
      );
      operationId =
        observed.operation.key === null
          ? null
          : `reader-${observed.operation.name}-${digest(JSON.stringify(observed.operation.key))}`;
      reader = observed;
      diagnostic = observed.diagnostic;
      workerVersion = observed.workerVersion;
    } catch (error) {
      queryError = String(error);
      diagnostic = {
        kind: 'unavailable',
        reason: queryError,
        nextAction:
          'Проверить Worker и первичную историю; причина отсутствия ответа пока неизвестна.',
        evidenceHash: null,
      };
    }
    try {
      const result = await client.connection.withDeadline(Date.now() + 1000, () =>
        client.connection.workflowService.getWorkflowExecutionHistoryReverse({
          namespace: client.options.namespace,
          execution: { workflowId, runId: description.runId },
          maximumPageSize: 50,
        }),
      );
      const latestTask = (result.history?.events ?? []).find(
        (event) =>
          event.workflowTaskFailedEventAttributes || event.workflowTaskCompletedEventAttributes,
      );
      const failed = latestTask?.workflowTaskFailedEventAttributes;
      if (failed) {
        workerVersion = failed.workerVersion?.buildId ?? workerVersion;
        diagnostic = {
          kind: 'workflow-error',
          reason: failed.failure?.message ?? 'Workflow Task завершился ошибкой.',
          nextAction:
            'Проверить совместимость истории и сборки Worker; обычное ожидание не подтверждено.',
          evidenceHash: null,
        };
      } else {
        const failure = pending.find((item) => item.lastFailure !== null);
        const queued =
          (description.raw.pendingActivities ?? []).some((item) => item.state === 1) ||
          description.raw.pendingWorkflowTask?.state === 1;
        if (failure && (reader === null || diagnostic.kind === 'running'))
          diagnostic = {
            kind: 'technical-error',
            reason: failure.lastFailure!,
            nextAction: 'Проверить операцию, число попыток и предел времени в pending.',
            evidenceHash: null,
          };
        else if (queued && (reader === null || diagnostic.kind === 'running'))
          diagnostic = {
            kind: 'waiting-worker',
            reason: 'Задание ожидает Worker или свободного места; точная причина неизвестна.',
            nextAction: 'Проверить указанную очередь, хост и доступную ёмкость.',
            evidenceHash: null,
          };
      }
    } catch (error) {
      historyError = String(error);
    }
  }
  return {
    workflowId,
    runId: description.runId,
    taskQueue: description.taskQueue,
    executionStatus: description.status.name,
    workerVersion,
    reader,
    operationId,
    diagnostic,
    pending,
    queryError,
    historyError,
  };
}
