import { proxyActivities } from '@temporalio/workflow';
import type { ArtifactRef } from '../src/contracts/preparation.js';

export interface H04WorkflowInput {
  operationId: string;
  inputHash: string;
}
const activity = proxyActivities<{ h04Operation(input: H04WorkflowInput): Promise<ArtifactRef> }>({
  startToCloseTimeout: '60 seconds',
  retry: { maximumAttempts: 1 },
});

export async function ComparisonH04Workflow(input: H04WorkflowInput): Promise<ArtifactRef> {
  return await activity.h04Operation(input);
}
