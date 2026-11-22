import { proxyActivities } from '@temporalio/workflow';
import type { ReaderActivities, ReaderInput } from '../contracts/reader.js';

const activities = proxyActivities<ReaderActivities>({
  startToCloseTimeout: '20 minutes',
  retry: { maximumAttempts: 1 },
});

export async function ReaderWorkflow(input: ReaderInput) {
  const prepared = await activities.prepareProject(input.preparation);
  const session = await activities.createReader(input, prepared);
  const load = await activities.loadReader(input, prepared, session);
  const answer = await activities.answerReader(input, prepared, session, load);
  return { status: 'answered' as const, answer };
}
