import {
  ApplicationFailure,
  ActivityCancellationType,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { FinalizationActivities, FinalizationInput } from '../contracts/finalization.js';
import { parseFinalization } from '../policy/finalization.js';

export const finalizationInput = defineQuery<FinalizationInput>('finalizationInput');
export const finalizationStatus = defineQuery('finalizationStatus');
export const finalizationReconcile = defineSignal('finalizationReconcile');
export async function FinalizationWorkflow(raw: FinalizationInput) {
  let input: FinalizationInput;
  try {
    input = parseFinalization(raw);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(String(error), 'FinalizationRejected');
  }
  const activities = proxyActivities<FinalizationActivities>({
    startToCloseTimeout: '30 minutes',
    heartbeatTimeout: '30 minutes',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });
  const observations = proxyActivities<FinalizationActivities>({
    startToCloseTimeout: '1 minute',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });
  const scope = CancellationScope.current();
  let phase = 'archiving',
    error = '',
    notice = 0;
  setHandler(finalizationInput, () => input);
  setHandler(finalizationStatus, () => ({
    phase,
    error,
    result: input.result,
    cancellationRequested: scope.consideredCancelled,
  }));
  setHandler(finalizationReconcile, () => {
    notice++;
  });
  try {
    const result = await activities.archiveFinalizedTask(input);
    phase = 'archived';
    return result;
  } catch (failure) {
    if (isCancellation(failure)) throw failure;
    error = String(
      failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure,
    );
  }
  return CancellationScope.nonCancellable(async () => {
    for (;;) {
      phase = 'unknown';
      const observed = notice;
      await condition(() => notice !== observed);
      phase = 'reconciling';
      try {
        const result = await observations.reconcileFinalizedTask(input);
        if (result.status === 'archived') {
          phase = 'archived';
          error = '';
          return result;
        }
        error = result.reason;
      } catch (failure) {
        error = String(
          failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure,
        );
      }
    }
  });
}
