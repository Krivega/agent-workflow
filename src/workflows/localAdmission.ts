import { ApplicationFailure, defineQuery, proxyActivities, setHandler } from '@temporalio/workflow';
import type { LocalAdmissionActivities, LocalAdmissionInput } from '../contracts/localAdmission.js';
import { parseLocalAdmission } from '../policy/localAdmission.js';
export { PreparationWorkflow } from './preparation.js';

export const localAdmissionInput = defineQuery<LocalAdmissionInput>('localAdmissionInput');
export async function LocalAdmissionWorkflow(raw: LocalAdmissionInput) {
  let input: LocalAdmissionInput;
  try {
    input = parseLocalAdmission(raw);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(String(error), 'LocalAdmissionRejected');
  }
  setHandler(localAdmissionInput, () => input);
  const activities = proxyActivities<LocalAdmissionActivities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 1 },
  });
  return activities.prepareLocalAdmission(input);
}
