import {
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  defineQuery,
  executeChild,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { ReviewActivities, ReviewInput } from '../contracts/review.js';
import { parseReviewInput } from '../policy/review.js';
import { readerKey } from '../policy/readerControl.js';
import { requireContract } from '../contracts/project.js';
import { ControlledReaderWorkflow } from './controlledReader.js';
export { ControlledReaderWorkflow } from './controlledReader.js';

export const reviewInput = defineQuery<ReviewInput>('reviewInput');
export async function ReviewWorkflow(raw: ReviewInput) {
  let input: ReviewInput;
  try {
    input = parseReviewInput(raw);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(String(error), 'ReviewInputRejected');
  }
  setHandler(reviewInput, () => input);
  const activity = proxyActivities<ReviewActivities>({
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 1 },
  });
  const plan = await activity.prepareReviewPlan(input);
  if (plan.decisions.some((r) => r.action === 'blocked'))
    return { status: 'blocked' as const, plan: plan.manifest, answers: [] };
  const scope = new CancellationScope();
  const children = plan.decisions.map((row) =>
    scope.run(async () => {
      if (row.action !== 'review')
        return { roleId: row.roleId, source: row.action, answer: row.answer };
      requireContract(row.input !== null, 'review-reader-input-missing');
      const result = await executeChild(ControlledReaderWorkflow, {
        args: [row.input],
        workflowId: readerKey(row.input),
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      });
      return { roleId: row.roleId, source: 'new' as const, result };
    }),
  );
  let answers: Awaited<(typeof children)[number]>[];
  try {
    answers = await Promise.all(children);
  } catch (failure) {
    scope.cancel();
    await CancellationScope.nonCancellable(() => Promise.allSettled(children));
    throw failure;
  }
  const verified = await activity.finishReview({
    schemaVersion: 1,
    input,
    plan: plan.manifest,
    answers: answers.map((row) => ({
      roleId: row.roleId,
      answer:
        'result' in row
          ? row.result.status === 'answered'
            ? row.result.answer
            : null
          : row.answer,
    })),
  });
  return { status: 'reviewed' as const, plan: plan.manifest, answers, ...verified };
}
