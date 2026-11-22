import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import {
  CancelledFailure,
  WorkflowIdReusePolicy,
  defaultPayloadConverter,
} from '@temporalio/common';
import { historyFromJSON, historyToJSON } from '@temporalio/common/proto-utils';
import proto from '@temporalio/proto';
import type { WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { object, requireWorkflow } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { readerHeartbeat } from '../src/worker/readerHeartbeat.js';
import type { H01BackendAdapter } from './comparisonH01Contract.js';
import { h01ReadJson, h01ReadPin, h01Record } from './comparisonH01Contract.js';
import type { H01TemporalServices } from './comparisonH01Temporal.js';
import type { H05WaitExecution, H05WaitExecutor, H05WaitResult } from './comparisonH05Contract.js';
import { runH05Case } from './comparisonH05Legacy.js';
import type { ComparisonH05Workflow, H05WorkflowInput } from './comparisonH05Workflow.js';

/** SDK primary replay only; generic native/owner/generation rules remain in H05Contract. */
export function verifyH05TemporalExecution(
  opId: string,
  execution: H05WaitExecution,
  result: H05WaitResult,
): void {
  const expected = { opId, execution },
    key = digest(canonical(expected));
  const proofs = result.evidence
    .map((ref) => object(h01ReadJson(ref)))
    .filter((value) => value.kind === 'comparison-h05-sdk-proof');
  requireWorkflow(proofs.length === 1, 'h05-sdk-proof-count');
  const proof = proofs[0]!,
    cancelled = execution.mode === 'cancel';
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  requireWorkflow(
    proof.scenario === 'H-05' &&
      proof.opId === opId &&
      same(proof.input, expected) &&
      proof.workflowId === 'aw/comparison-h05/' + key &&
      typeof proof.runId === 'string' &&
      proof.runId.length > 0 &&
      typeof proof.taskQueue === 'string' &&
      proof.taskQueue.endsWith('.h05.' + key.slice(0, 20)) &&
      proof.status === (cancelled ? 'CANCELLED' : 'COMPLETED') &&
      same(proof.result, result.result) &&
      result.outcome === (cancelled ? 'cancelled' : 'completed'),
    'h05-sdk-proof-binding',
  );
  const history = historyFromJSON(h01ReadJson(proof.history as InputRef));
  const events = history.events!;
  requireWorkflow(Array.isArray(events), 'h05-sdk-history-shape');
  const starts = events.filter((event) => event.workflowExecutionStartedEventAttributes != null),
    scheduled = events.filter((event) => event.activityTaskScheduledEventAttributes != null),
    running = events.filter((event) => event.activityTaskStartedEventAttributes != null),
    activityResults = events.filter((event) => event.activityTaskCompletedEventAttributes != null),
    completed = events.filter((event) => event.workflowExecutionCompletedEventAttributes != null),
    activityCancelled = events.filter((event) => event.activityTaskCanceledEventAttributes != null),
    workflowCancelled = events.filter(
      (event) => event.workflowExecutionCanceledEventAttributes != null,
    );
  const payload = (value: proto.temporal.api.common.v1.IPayloads | null | undefined): unknown => {
    requireWorkflow(
      value != null && Array.isArray(value.payloads) && value.payloads.length === 1,
      'h05-sdk-payload',
    );
    return defaultPayloadConverter.fromPayload(value!.payloads![0]!);
  };
  requireWorkflow(
    starts.length === 1 && scheduled.length === 1 && running.length === 1,
    'h05-sdk-history-shape',
  );
  const start = starts[0]!.workflowExecutionStartedEventAttributes!,
    activity = scheduled[0]!.activityTaskScheduledEventAttributes!,
    finalAttempt = running[0]!.activityTaskStartedEventAttributes!;
  requireWorkflow(
    start.workflowType?.name === 'ComparisonH05Workflow' &&
      start.originalExecutionRunId === proof.runId &&
      start.taskQueue?.name === proof.taskQueue &&
      same(payload(start.input), expected) &&
      activity.activityType?.name === 'h05Wait' &&
      activity.taskQueue?.name === proof.taskQueue &&
      same(payload(activity.input), expected) &&
      String(finalAttempt.scheduledEventId) === String(scheduled[0]!.eventId),
    'h05-sdk-history-input',
  );
  const attempts = (proof.attempts as InputRef[]).map((ref) => object(h01ReadJson(ref))),
    stops = (proof.workerStops as InputRef[]).map((ref) => object(h01ReadJson(ref))),
    cancellations = (proof.cancellations as InputRef[]).map((ref) => object(h01ReadJson(ref)));
  const count = execution.mode === 'restart' ? 2 : 1;
  requireWorkflow(
    attempts.length === count &&
      stops.length === count &&
      new Set(attempts.map((value) => value.identity)).size === count,
    'h05-sdk-attempt-count',
  );
  for (const [index, observed] of attempts.entries()) {
    const stop = stops[index]!;
    requireWorkflow(
      observed.kind === 'comparison-h05-sdk-activity' &&
        same(observed.input, expected) &&
        observed.workflowId === proof.workflowId &&
        observed.runId === proof.runId &&
        observed.activityId === activity.activityId &&
        observed.attempt === index + 1 &&
        observed.identity === 'h05-' + key.slice(0, 20) + '-' + String(index + 1) &&
        stop.kind === 'comparison-h05-sdk-worker-stop' &&
        same(stop.input, expected) &&
        stop.ordinal === index + 1 &&
        stop.identity === observed.identity &&
        stop.taskQueue === proof.taskQueue &&
        stop.state === 'STOPPED',
      'h05-sdk-worker-binding',
    );
  }
  requireWorkflow(
    finalAttempt.attempt === count && finalAttempt.identity === attempts.at(-1)!.identity,
    'h05-sdk-final-attempt',
  );
  if (execution.mode === 'restart') {
    const pending = object(h01ReadJson(proof.restartPending as InputRef)),
      raw = object(pending.raw),
      info = object(object(raw.workflowExecutionInfo).execution);
    const entries = (raw.pendingActivities as unknown[]).map(object);
    requireWorkflow(
      pending.kind === 'comparison-h05-sdk-restart-pending' &&
        same(pending.input, expected) &&
        pending.workflowId === proof.workflowId &&
        pending.runId === proof.runId &&
        info.workflowId === proof.workflowId &&
        info.runId === proof.runId &&
        entries.length === 1 &&
        entries[0]!.activityId === activity.activityId &&
        entries[0]!.attempt === 1 &&
        entries[0]!.lastWorkerIdentity === attempts[0]!.identity,
      'h05-sdk-restart-pending',
    );
  } else requireWorkflow(proof.restartPending === null, 'h05-sdk-unexpected-restart');
  if (execution.mode !== 'wait') {
    requireWorkflow(
      cancellations.length === 1 &&
        cancellations[0]!.kind === 'comparison-h05-sdk-activity-cancel' &&
        same(cancellations[0]!.activity, attempts[0]) &&
        object(cancellations[0]!.error).name === 'CancelledFailure' &&
        (execution.mode !== 'restart' ||
          object(cancellations[0]!.error).message === 'WORKER_SHUTDOWN'),
      'h05-sdk-cancellation',
    );
  } else requireWorkflow(cancellations.length === 0, 'h05-sdk-unexpected-cancellation');
  if (cancelled)
    requireWorkflow(
      result.result === null &&
        activityResults.length === 0 &&
        completed.length === 0 &&
        activityCancelled.length === 1 &&
        workflowCancelled.length === 1 &&
        String(activityCancelled[0]!.activityTaskCanceledEventAttributes!.scheduledEventId) ===
          String(scheduled[0]!.eventId) &&
        String(activityCancelled[0]!.activityTaskCanceledEventAttributes!.startedEventId) ===
          String(running[0]!.eventId),
      'h05-sdk-cancelled-result',
    );
  else {
    requireWorkflow(
      result.result !== null &&
        activityResults.length === 1 &&
        completed.length === 1 &&
        activityCancelled.length === 0 &&
        workflowCancelled.length === 0 &&
        same(
          payload(activityResults[0]!.activityTaskCompletedEventAttributes!.result),
          result.result,
        ) &&
        same(
          payload(completed[0]!.workflowExecutionCompletedEventAttributes!.result),
          result.result,
        ) &&
        String(activityResults[0]!.activityTaskCompletedEventAttributes!.scheduledEventId) ===
          String(scheduled[0]!.eventId) &&
        String(activityResults[0]!.activityTaskCompletedEventAttributes!.startedEventId) ===
          String(running[0]!.eventId),
      'h05-sdk-completed-result',
    );
    h01ReadPin(result.result);
  }
}

/** Construction starts no process, Worker or model. The common owner supplies the native wait. */
export function createH05TemporalAdapter(services: H01TemporalServices): H01BackendAdapter {
  return {
    async execute(ctx) {
      requireWorkflow(ctx.criteria.value.id === 'H-05', 'h05-temporal-scenario');
      requireWorkflow(ctx.bootstrap.engine === 'temporal', 'h05-temporal-bootstrap');
      requireWorkflow(
        ctx.bootstrap.namespace === 'default' &&
          services.client.options.namespace === ctx.bootstrap.namespace &&
          object(object(services.client.connection).options).address === ctx.bootstrap.address &&
          ctx.bootstrap.taskQueue === services.taskQueue &&
          ctx.bootstrap.workflowsPath === services.workflowsPath,
        'h05-temporal-service-binding',
      );
      const sdkEvidence: InputRef[] = [];
      const saved = (label: string, value: unknown) => {
        const ref = h01Record(ctx.roots.evidenceRoot, 'h05-sdk-' + label, value);
        sdkEvidence.push(ref);
        return ref;
      };
      const working = () => {
        ctx.signal.throwIfAborted();
        requireWorkflow(
          BigInt(ctx.workDeadlineNs) > process.hrtime.bigint(),
          'h05-temporal-work-deadline',
        );
      };
      const executeWait: H05WaitExecutor = async (execution, wait) => {
        working();
        h01ReadPin(execution.binding);
        const input: H05WorkflowInput = { opId: ctx.opId, execution },
          key = digest(canonical(input)),
          workflowId = 'aw/comparison-h05/' + key,
          taskQueue = services.taskQueue + '.h05.' + key.slice(0, 20);
        const evidence: InputRef[] = [],
          attempts: InputRef[] = [],
          workerStops: InputRef[] = [],
          cancellations: InputRef[] = [];
        const record = (label: string, value: unknown) => {
          const ref = saved(execution.id + '-' + label, value);
          evidence.push(ref);
          return ref;
        };
        const workers: {
          worker: Worker;
          running: Promise<void>;
          ordinal: number;
          identity: string;
          stopped: boolean;
        }[] = [];
        let handle: WorkflowHandle<typeof ComparisonH05Workflow> | undefined,
          firstRunId: string | undefined,
          result: InputRef | null = null,
          cancelled = false,
          restartPending: InputRef | null = null;
        let started!: () => void;
        const activityStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        const createWorker = async () => {
          const ordinal = workers.length + 1,
            identity = 'h05-' + key.slice(0, 20) + '-' + String(ordinal);
          const worker = await Worker.create({
            connection: services.nativeConnection,
            taskQueue,
            identity,
            workflowsPath: fileURLToPath(new URL('./comparisonH05Workflow.ts', import.meta.url)),
            maxConcurrentActivityTaskExecutions: 1,
            activities: {
              h05Wait: (actual: H05WorkflowInput) =>
                readerHeartbeat(async () => {
                  working();
                  requireWorkflow(
                    canonical(actual) === canonical(input),
                    'h05-temporal-activity-binding',
                  );
                  h01ReadPin(execution.binding);
                  const activity = Context.current(),
                    current = activity.info.workflowExecution;
                  requireWorkflow(
                    current !== undefined &&
                      current.workflowId === workflowId &&
                      activity.info.attempt === ordinal,
                    'h05-temporal-activity-execution',
                  );
                  const activityObservation = {
                    kind: 'comparison-h05-sdk-activity',
                    input,
                    workflowId: current.workflowId,
                    runId: current.runId,
                    activityId: activity.info.activityId,
                    attempt: activity.info.attempt,
                    identity,
                  };
                  attempts.push(record('activity', activityObservation));
                  const signal = AbortSignal.any([ctx.signal, activity.cancellationSignal]);
                  try {
                    const pending = wait(signal);
                    started();
                    const accepted = await pending;
                    signal.throwIfAborted();
                    working();
                    h01ReadPin(accepted);
                    return accepted;
                  } catch (error) {
                    // Preserve SDK's WORKER_SHUTDOWN reason so its existing retry resumes the same Activity.
                    if (activity.cancellationSignal.aborted) {
                      try {
                        await activity.cancelled;
                      } catch (cancelled) {
                        requireWorkflow(cancelled instanceof Error, 'h05-sdk-cancel-error');
                        cancellations.push(
                          record('activity-cancel', {
                            kind: 'comparison-h05-sdk-activity-cancel',
                            activity: activityObservation,
                            error: { name: cancelled.name, message: cancelled.message },
                          }),
                        );
                        throw cancelled;
                      }
                    }
                    throw error;
                  }
                }),
            },
          });
          const running = worker.run();
          void running.catch(() => {});
          const own = { worker, running, ordinal, identity, stopped: false };
          workers.push(own);
          record('worker-created', {
            kind: 'comparison-h05-sdk-worker',
            input,
            ordinal,
            identity,
            taskQueue,
            state: worker.getState(),
          });
          working();
          return own;
        };
        const stopped = async (own: (typeof workers)[number]) => {
          if (own.stopped) return;
          if (own.worker.getState() === 'RUNNING') own.worker.shutdown();
          try {
            await own.running;
          } finally {
            const state = own.worker.getState();
            workerStops.push(
              record('worker-stop', {
                kind: 'comparison-h05-sdk-worker-stop',
                input,
                ordinal: own.ordinal,
                identity: own.identity,
                taskQueue,
                state,
              }),
            );
            own.stopped = state === 'STOPPED';
          }
          requireWorkflow(own.stopped, 'h05-temporal-worker-stop-unknown');
        };
        const ended = (own: (typeof workers)[number]) => {
          const failure = own.running.then(() => {
            throw new Error('h05-temporal-worker-ended');
          });
          void failure.catch(() => {});
          return failure;
        };
        const abort = () => {
          if (handle !== undefined) void handle.cancel().catch(() => {});
        };
        ctx.signal.addEventListener('abort', abort, { once: true });
        try {
          const first = await createWorker();
          working();
          const startedHandle = await services.client.workflow.start<typeof ComparisonH05Workflow>(
            'ComparisonH05Workflow',
            {
              args: [input],
              taskQueue,
              workflowId,
              workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
            },
          );
          handle = startedHandle;
          firstRunId = startedHandle.firstExecutionRunId;
          requireWorkflow(
            typeof firstRunId === 'string' && firstRunId.length > 0,
            'h05-temporal-run-unconfirmed',
          );
          record('started', {
            kind: 'comparison-h05-sdk-start',
            input,
            workflowId,
            runId: firstRunId,
            taskQueue,
          });
          if (ctx.signal.aborted) {
            abort();
            working();
          }
          working();
          const workflowResult = handle.result();
          void workflowResult.catch(() => {});
          if (execution.mode !== 'wait') {
            const early = workflowResult.then(() => {
              throw new Error('h05-temporal-wait-ended-before-intervention');
            });
            void early.catch(() => {});
            await Promise.race([activityStarted, ended(first), early]);
            working();
          }
          if (execution.mode === 'restart') {
            const pending = await handle.describe();
            working();
            requireWorkflow(pending.runId === firstRunId, 'h05-temporal-restart-run');
            restartPending = record('restart-pending', {
              kind: 'comparison-h05-sdk-restart-pending',
              input,
              workflowId,
              runId: firstRunId,
              raw: proto.temporal.api.workflowservice.v1.DescribeWorkflowExecutionResponse.fromObject(
                pending.raw,
              ).toJSON(),
            });
            await stopped(first);
            working();
            handle = services.client.workflow.getHandle<typeof ComparisonH05Workflow>(
              workflowId,
              firstRunId,
            );
            await createWorker();
            working();
          } else if (execution.mode === 'cancel') {
            await handle.cancel();
            working();
          }
          try {
            result = await Promise.race([workflowResult, ended(workers.at(-1)!)]);
          } catch (error) {
            requireWorkflow(
              execution.mode === 'cancel' &&
                error instanceof Error &&
                error.cause instanceof CancelledFailure,
              'h05-temporal-workflow-outcome-unknown',
            );
            cancelled = true;
          }
          working();
        } finally {
          ctx.signal.removeEventListener('abort', abort);
          for (const own of workers) await stopped(own);
        }
        working();
        requireWorkflow(
          handle !== undefined && firstRunId !== undefined,
          'h05-temporal-workflow-unstarted',
        );
        requireWorkflow(
          cancelled === (execution.mode === 'cancel'),
          'h05-temporal-cancel-unconfirmed',
        );
        const description = await handle.describe();
        working();
        requireWorkflow(
          description.runId === firstRunId &&
            description.status.name === (cancelled ? 'CANCELLED' : 'COMPLETED'),
          'h05-temporal-workflow-status',
        );
        requireWorkflow(
          attempts.length > 0 &&
            attempts.every((ref) => {
              const activity = object(h01ReadJson(ref));
              return activity.workflowId === workflowId && activity.runId === firstRunId;
            }),
          'h05-temporal-activity-run',
        );
        requireWorkflow(
          execution.mode !== 'restart' || (workers.length === 2 && attempts.length === 2),
          'h05-temporal-restart-unconfirmed',
        );
        const primaryHistory = await handle.fetchHistory();
        working();
        const history = record('history', JSON.parse(historyToJSON(primaryHistory)) as unknown);
        record('workflow', {
          kind: 'comparison-h05-sdk-proof',
          scenario: 'H-05',
          opId: ctx.opId,
          input,
          workflowId,
          runId: firstRunId,
          taskQueue,
          status: description.status.name,
          result,
          history,
          attempts,
          workerStops,
          cancellations,
          restartPending,
        });
        const executionResult: H05WaitResult = {
          outcome: cancelled ? 'cancelled' : 'completed',
          result,
          evidence,
        };
        verifyH05TemporalExecution(ctx.opId, execution, executionResult);
        working();
        return executionResult;
      };
      const result = await runH05Case(ctx, 'temporal', executeWait);
      return {
        ...result,
        ...(ctx.signal.aborted ? { outcome: 'unknown' as const, nativeAcceptance: null } : {}),
        evidence: [
          ...new Map(
            [...result.evidence, ...sdkEvidence].map((ref) => [canonical(ref), ref]),
          ).values(),
        ],
      };
    },
  };
}
