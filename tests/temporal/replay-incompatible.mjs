import { proxyActivities } from '@temporalio/workflow';

export async function ControlledReaderWorkflow() {
  const activity = proxyActivities({ startToCloseTimeout: '1 minute' });
  return activity.deliberatelyIncompatibleActivity();
}
