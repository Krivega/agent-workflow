import { ActivityCancellationType, proxyActivities } from '@temporalio/workflow';
import type { InputRef } from '../core/localRun.js';
import type { H05WaitExecution } from './comparisonH05Contract.js';

export interface H05WorkflowInput {
  opId: string;
  execution: H05WaitExecution;
}

/** A known wait only. Retry after Worker shutdown reuses the persisted input and native turn. */
export async function ComparisonH05Workflow(input: H05WorkflowInput): Promise<InputRef> {
  const activity = proxyActivities<{ h05Wait(input: H05WorkflowInput): Promise<InputRef> }>({
    startToCloseTimeout: '20 minutes',
    heartbeatTimeout: '10 seconds',
    retry: { maximumAttempts: 2, initialInterval: '1 second', maximumInterval: '1 second' },
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  });
  return await activity.h05Wait(input);
}
