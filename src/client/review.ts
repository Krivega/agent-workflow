import { requireClientTaskBackend } from './taskBackend.js';
import type { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import type { ReviewWorkflow } from '../workflows/review.js';
import type { ReviewInput } from '../contracts/review.js';
import { parseReviewInput, reviewKey } from '../policy/review.js';
import { requireContract } from '../contracts/project.js';
export async function startReview(client: Client, value: unknown, taskQueue: string) {
  const input = parseReviewInput(value);
  requireClientTaskBackend(client, input.preparation);
  const handle = await client.workflow.start<typeof ReviewWorkflow>('ReviewWorkflow', {
    args: [input],
    taskQueue,
    workflowId: reviewKey(input),
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
  });
  const accepted = parseReviewInput(await handle.query<ReviewInput>('reviewInput'));
  requireContract(JSON.stringify(accepted) === JSON.stringify(input), 'review-start-conflict');
  return handle;
}
