import { defineQuery, proxyActivities, setHandler } from '@temporalio/workflow';
import type {
  PreparationActivities,
  PreparationInput,
  PreparationResult,
} from '../contracts/preparation.js';
import { parsePreparation } from '../policy/preparation.js';

export const preparationInput = defineQuery<PreparationInput>('preparationInput');

const activities = proxyActivities<PreparationActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

export async function PreparationWorkflow(value: PreparationInput): Promise<PreparationResult> {
  const input = parsePreparation(value);
  setHandler(preparationInput, () => input);
  return activities.prepareProject(input);
}
