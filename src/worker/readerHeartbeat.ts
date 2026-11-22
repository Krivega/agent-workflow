import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';

export async function readerHeartbeat<T>(run: () => Promise<T>): Promise<T> {
  const context = Context.current();
  const heartbeat = () => context.heartbeat();
  heartbeat();
  const timer = setInterval(heartbeat, 1000);
  try {
    return await run();
  } catch (error) {
    if (error instanceof CancelledFailure) throw error;
    throw ApplicationFailure.nonRetryable(String(error), 'ReaderActivityRejected');
  } finally {
    clearInterval(timer);
  }
}
