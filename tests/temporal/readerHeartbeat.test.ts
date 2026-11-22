import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { readerHeartbeat } from '../../src/worker/readerHeartbeat.js';
const context = vi.hoisted(() => ({ heartbeat: vi.fn() }));
vi.mock('@temporalio/activity', () => ({ Context: { current: () => context } }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('reader activity liveness', () => {
  it('heartbeats while waiting without polling a model and clears its timer after completion', async () => {
    vi.useFakeTimers();
    let release!: (v: string) => void;
    const work = readerHeartbeat(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    expect(context.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(context.heartbeat).toHaveBeenCalledTimes(3);
    release('done');
    expect(await work).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not turn unknown/contract failures into automatic retries and preserves cancellation', async () => {
    const cancelled = new CancelledFailure('cancel');
    await expect(
      readerHeartbeat(async () => {
        throw cancelled;
      }),
    ).rejects.toBe(cancelled);
    const error = await readerHeartbeat(async () => {
      throw new Error('effect-outcome-unknown');
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error).toMatchObject({ nonRetryable: true, type: 'ReaderActivityRejected' });
  });
});
