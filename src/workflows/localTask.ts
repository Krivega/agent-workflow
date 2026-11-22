import { taskProgressCheckpoint } from './progressAudit.js';
import { ManagedTaskWorkflow } from './taskExecution.js';
export { ManagedTaskWorkflow } from './taskExecution.js';
import { continuingTaskPlanning, type TaskContinuationStatus } from './taskContinuation.js';
import {
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  condition,
  defineQuery,
  defineSignal,
  executeChild,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { ReviewInput } from '../contracts/review.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import type {
  LocalTaskActivities,
  LocalTaskControls,
  LocalTaskInput,
} from '../contracts/localTask.js';
import {
  parseLocalTask,
  correctingTask,
  supervisedTask,
  stageSupervisedTask,
} from '../policy/localTask.js';
import { reviewKey } from '../policy/review.js';
import { ReviewWorkflow } from './review.js';
export { ReviewWorkflow, ControlledReaderWorkflow } from './review.js';
import { supervisedPlanning, type PlanningAuditStatus } from './taskAudit.js';
import { supervisedTaskStage, type StageAuditStatus } from './stageAudit.js';
import type { TaskAuditStage } from '../contracts/localTask.js';
export { AuditWorkflow } from './audit.js';

export const localTaskInput = defineQuery<LocalTaskInput>('localTaskInput');
export const localTaskStatus = defineQuery('localTaskStatus');
export const localTaskReconcile = defineSignal('localTaskReconcile');
export async function LocalTaskWorkflow(raw: LocalTaskInput, checkpoint?: ArtifactRef) {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    (raw.schemaVersion === 11 || raw.schemaVersion === 12)
  )
    return ManagedTaskWorkflow(raw, checkpoint ?? null);
  if (checkpoint !== undefined)
    throw ApplicationFailure.nonRetryable('task-checkpoint-version-required', 'LocalTaskRejected');
  let input: LocalTaskInput;
  const initial = raw;
  try {
    input = parseLocalTask(raw);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(String(error), 'LocalTaskRejected');
  }
  const activities = proxyActivities<LocalTaskActivities>({
    startToCloseTimeout: '30 minutes',
    heartbeatTimeout: '10 seconds',
    retry: { maximumAttempts: 1 },
  });
  const controls = proxyActivities<LocalTaskControls>({
    taskQueue: workflowInfo().taskQueue + '.control',
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 1 },
  });
  let phase = 'preparing',
    error = '',
    stopFailure = '',
    revision = 0,
    snapshot: ArtifactRef | null = null,
    round = 0,
    lastReview: ArtifactRef | null = null;
  let arbitration: ArtifactRef | null = null;
  const planningAudit: PlanningAuditStatus = {
    claim: null,
    audit: null,
    result: null,
    stop: null,
    supervision: null,
  };
  const stageAudits: (StageAuditStatus & { stage: TaskAuditStage })[] = [],
    stageRecords: ArtifactRef[] = [];
  async function supervise<T>(
    stage: TaskAuditStage,
    completed: ArtifactRef[],
    operation: () => Promise<T>,
  ) {
    if (!stageSupervisedTask(input)) return operation();
    const status: StageAuditStatus & { stage: TaskAuditStage } = {
      stage,
      claim: null,
      audit: null,
      result: null,
      stop: null,
      supervision: null,
    };
    stageAudits.push(status);
    const observed = await supervisedTaskStage(
      {
        input,
        stage,
        snapshot: snapshot!,
        completed: [
          ...new Map(
            [
              ...completed,
              ...(input.schemaVersion === 9 && progressAudit.supervision !== null
                ? [
                    progressAudit.supervision,
                    progressAudit.result!,
                    progressAudit.stop!,
                    progressAudit.audit!.card,
                  ]
                : []),
            ].map((ref) => [ref.sha256, ref]),
          ).values(),
        ],
      },
      status,
      operation,
    );
    stageRecords.push(observed.supervision);
    return observed.result;
  }
  const progressAudit: StageAuditStatus = {
    claim: null,
    audit: null,
    result: null,
    stop: null,
    supervision: null,
  };
  const began = Date.now();
  const continuation: TaskContinuationStatus = {
    revision: 0,
    waiting: false,
    held: null,
    history: [],
  };
  setHandler(localTaskInput, () => initial);
  setHandler(localTaskStatus, () => ({
    phase,
    error,
    stopFailure,
    snapshot,
    ...(correctingTask(input) ? { round, review: lastReview } : {}),
    ...(stageSupervisedTask(input) ? { stageAudits, stageRecords } : {}),
    ...(input.schemaVersion === 9 ? { progressAudit } : {}),
    ...(input.schemaVersion === 10
      ? {
          continuation,
          requirementsRevision: input.admission.preparation.revision,
          attempt: input.continuation.attempt,
        }
      : {}),
    ...(input.schemaVersion === 5 || input.schemaVersion === 6 ? { arbitration } : {}),
    ...(supervisedTask(input) ? { planningAudit } : {}),
    runId: workflowInfo().runId,
    elapsedMs: Date.now() - began,
  }));
  setHandler(localTaskReconcile, () => {
    revision++;
  });
  try {
    if (input.schemaVersion === 10) {
      if (input.continuation.attempt !== 0)
        throw ApplicationFailure.nonRetryable(
          'task-continuation-start-forbidden',
          'LocalTaskRejected',
        );
      const continued = await continuingTaskPlanning(
        input,
        activities,
        continuation,
        (next, nextPhase) => {
          input = next;
          phase = nextPhase;
        },
      );
      input = continued.input;
      snapshot = await activities.prepareLocalTask(input, continued.review);
    } else if (
      input.schemaVersion === 3 ||
      input.schemaVersion === 6 ||
      supervisedTask(input) ||
      (correctingTask(input) && input.admission.schemaVersion === 3)
    ) {
      phase = 'planning';
      const planning = await activities.prepareSubstantialPlanning(input);
      const supervised = supervisedTask(input)
        ? await supervisedPlanning(input, planning, planningAudit)
        : null;
      let review =
        supervised !== null
          ? supervised.review
          : await executeChild(ReviewWorkflow, {
              args: [planning],
              workflowId: reviewKey(planning),
              workflowIdReusePolicy: 'REJECT_DUPLICATE',
              cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
              parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
            });
      if (input.schemaVersion === 6 && review.status === 'reviewed' && !review.complete) {
        phase = 'initial-arbitration';
        const requested = await activities.prepareInitialArbitration(
          input,
          planning,
          review.manifest,
        );
        arbitration = requested.manifest;
        const adjudicated = await executeChild(ReviewWorkflow, {
          args: [requested.review],
          taskQueue: workflowInfo().taskQueue + '.arbitration',
          workflowId: reviewKey(requested.review),
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
          parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
        });
        if (adjudicated.status !== 'reviewed')
          throw ApplicationFailure.nonRetryable(
            'initial-arbitration-review-blocked',
            'InitialArbitrationFailed',
          );
        const resolution = await activities.finishInitialArbitration(
          input,
          requested.manifest,
          adjudicated.manifest,
        );
        arbitration = resolution.manifest;
        if (resolution.planning === null)
          throw ApplicationFailure.nonRetryable(
            'initial-arbitration-held:' + arbitration.sha256,
            'InitialArbitrationFailed',
          );
        phase = 'replanning';
        review = await executeChild(ReviewWorkflow, {
          args: [resolution.planning],
          workflowId: reviewKey(resolution.planning),
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
          parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
        });
      }
      if (review.status !== 'reviewed' || !review.complete)
        throw ApplicationFailure.nonRetryable(
          'task-planning-failed:' + review.plan.sha256,
          'SubstantialPlanningFailed',
        );
      phase = 'preparing';
      snapshot =
        supervised === null
          ? await activities.prepareLocalTask(input, review.manifest)
          : await activities.prepareLocalTask(input, review.manifest, supervised.supervision);
    } else snapshot = await activities.prepareLocalTask(input);
    for (;;) {
      phase = 'baseline';
      const baseline = await supervise('baseline', [], () =>
        activities.checkLocalTask(input, snapshot!, 'baseline', null, null),
      );
      if (baseline.status !== 'PASS')
        throw ApplicationFailure.nonRetryable(
          'task-baseline-failed:' + baseline.manifest.sha256,
          'LocalTaskCheckFailed',
        );
      if (input.schemaVersion === 9) {
        phase = 'progress-audit';
        const taskElapsedMs = Date.now() - began;
        await taskProgressCheckpoint(
          {
            input,
            snapshot,
            baseline: baseline.manifest,
            taskElapsedMs:
              Number.isSafeInteger(taskElapsedMs) && taskElapsedMs >= 0 ? taskElapsedMs : null,
          },
          progressAudit,
        );
      }
      phase = input.schemaVersion !== 2 ? 'writing' : 'applying-material';
      const writer = await supervise('writing', [baseline.manifest], () =>
        input.schemaVersion === 9
          ? activities.writeLocalTask(input, snapshot!, progressAudit.supervision!)
          : activities.writeLocalTask(input, snapshot!),
      );
      phase = 'candidate-checks';
      const candidate = await supervise(
        'candidate-checks',
        [baseline.manifest, writer.answer, writer.stop, writer.tree],
        () => activities.checkLocalTask(input, snapshot!, 'candidate', writer, null),
      );
      if (candidate.status !== 'PASS')
        throw ApplicationFailure.nonRetryable(
          'task-candidate-checks-failed:' + candidate.manifest.sha256,
          'LocalTaskCheckFailed',
        );
      phase = 'integration';
      const { intent, integration } = await supervise(
        'integration',
        [baseline.manifest, writer.answer, writer.stop, writer.tree, candidate.manifest],
        async () => {
          const intent = await activities.planLocalIntegration(
            input,
            snapshot!,
            writer,
            candidate.manifest,
          );
          const integration = await activities.integrateLocalTask(input, snapshot!, intent);
          return { intent, integration };
        },
      );
      phase = 'integrated-checks';
      const checked = await supervise(
        'integrated-checks',
        [
          baseline.manifest,
          writer.answer,
          writer.stop,
          writer.tree,
          candidate.manifest,
          intent,
          integration,
        ],
        () => activities.checkLocalTask(input, snapshot!, 'integrated', writer, integration),
      );
      if (checked.status !== 'PASS')
        throw ApplicationFailure.nonRetryable(
          'task-integrated-checks-failed:' + checked.manifest.sha256,
          'LocalTaskCheckFailed',
        );
      phase = 'acceptance';
      const packet: ReviewInput = await activities.prepareLocalAcceptance(
        input,
        snapshot,
        writer,
        candidate.manifest,
        intent,
        integration,
        checked.manifest,
        baseline.manifest,
      );
      const review = await supervise(
        'acceptance',
        [
          baseline.manifest,
          writer.answer,
          writer.stop,
          writer.tree,
          candidate.manifest,
          intent,
          integration,
          checked.manifest,
          packet.request,
        ],
        () =>
          executeChild(ReviewWorkflow, {
            args: [packet],
            workflowId: reviewKey(packet),
            workflowIdReusePolicy: 'REJECT_DUPLICATE',
            cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
            parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
          }),
      );
      if (correctingTask(input) && review.status === 'reviewed') lastReview = review.manifest;
      if (review.status !== 'reviewed' || !review.complete) {
        if (correctingTask(input) && review.status === 'reviewed') {
          if (input.schemaVersion === 5 && round >= 2) {
            if (round !== 2)
              throw ApplicationFailure.nonRetryable(
                'task-arbitration-followup-failed:' + review.manifest.sha256,
                'LocalTaskArbitrationFailed',
              );
            phase = 'arbitrating';
            const requested = await activities.prepareLocalArbitration(
              input,
              snapshot,
              packet,
              review.manifest,
            );
            arbitration = requested.manifest;
            const adjudicated = await executeChild(ReviewWorkflow, {
              args: [requested.review],
              taskQueue: workflowInfo().taskQueue + '.arbitration',
              workflowId: reviewKey(requested.review),
              workflowIdReusePolicy: 'REJECT_DUPLICATE',
              cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
              parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
            });
            if (adjudicated.status !== 'reviewed')
              throw ApplicationFailure.nonRetryable(
                'task-arbitration-review-blocked',
                'LocalTaskArbitrationFailed',
              );
            const resolution: Awaited<ReturnType<LocalTaskActivities['finishLocalArbitration']>> =
              await activities.finishLocalArbitration(
                input,
                snapshot,
                requested.manifest,
                adjudicated.manifest,
              );
            arbitration = resolution.manifest;
            if (!resolution.ready || resolution.snapshot === null)
              throw ApplicationFailure.nonRetryable(
                'task-arbitration-held:' + arbitration.sha256,
                'LocalTaskArbitrationFailed',
              );
            snapshot = resolution.snapshot;
            round++;
            continue;
          }
          phase = 'correcting';
          snapshot = await activities.prepareLocalCorrection(
            input,
            snapshot,
            packet,
            review.manifest,
          );
          round++;
          continue;
        }
        throw ApplicationFailure.nonRetryable(
          'task-acceptance-failed:' + review.plan.sha256,
          'LocalTaskAcceptanceFailed',
        );
      }
      phase = 'finishing';
      const result =
        input.schemaVersion === 9
          ? await activities.finishLocalTask(
              input,
              snapshot,
              packet,
              review.manifest,
              stageRecords,
              progressAudit.supervision!,
            )
          : stageSupervisedTask(input)
            ? await activities.finishLocalTask(
                input,
                snapshot,
                packet,
                review.manifest,
                stageRecords,
              )
            : await activities.finishLocalTask(input, snapshot, packet, review.manifest);
      phase = 'done';
      return {
        ...result,
        ...(correctingTask(input) ? { corrections: round } : {}),
        ...(stageSupervisedTask(input) ? { stageAudits, stageRecords } : {}),
        ...(input.schemaVersion === 9 ? { progressAudit } : {}),
        ...(input.schemaVersion === 10 ? { continuation } : {}),
        ...(input.schemaVersion === 5 || input.schemaVersion === 6 ? { arbitration } : {}),
        ...(supervisedTask(input) ? { planningAudit } : {}),
        elapsedMs: Date.now() - began,
      };
    }
  } catch (failure) {
    continuation.waiting = false;
    const cancelled = isCancellation(failure);
    error = String(
      failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure,
    );
    phase = 'stopping';
    return CancellationScope.nonCancellable(async () => {
      for (;;)
        try {
          const stop = await controls.stopLocalTask(input);
          phase = cancelled ? 'cancelled' : 'blocked';
          return {
            status: cancelled ? ('cancelled' as const) : ('blocked' as const),
            error,
            stopFailure,
            snapshot,
            ...(correctingTask(input) ? { round, review: lastReview } : {}),
            ...(stageSupervisedTask(input) ? { stageAudits, stageRecords } : {}),
            ...(input.schemaVersion === 9 ? { progressAudit } : {}),
            ...(input.schemaVersion === 10 ? { continuation } : {}),
            ...(input.schemaVersion === 5 || input.schemaVersion === 6 ? { arbitration } : {}),
            stop,
            ...(supervisedTask(input) ? { planningAudit } : {}),
            elapsedMs: Date.now() - began,
          };
        } catch (stopError) {
          stopFailure = String(stopError);
          phase = 'stop-unknown';
          const observed = revision;
          await condition(() => revision !== observed);
        }
    });
  }
}
