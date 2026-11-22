import { beforeEach, describe, expect, it, vi } from 'vitest';
import { controlFixture } from './controlFixture.js';
import { ReviewWorkflow } from '../../src/workflows/review.js';
import type { ReviewInput, ReviewPlan } from '../../src/contracts/review.js';
const sdk = vi.hoisted(() => ({
  prepareReviewPlan: vi.fn(),
  finishReview: vi.fn(),
  executeChild: vi.fn(),
  cancel: vi.fn(),
  handlers: new Map<string, () => unknown>(),
}));
vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: { nonRetryable: (message: string) => new Error(message) },
  ChildWorkflowCancellationType: { WAIT_CANCELLATION_COMPLETED: 'WAIT_CANCELLATION_COMPLETED' },
  ParentClosePolicy: { REQUEST_CANCEL: 'REQUEST_CANCEL' },
  defineQuery: (s: string) => s,
  defineSignal: (s: string) => s,
  defineUpdate: (s: string) => s,
  setHandler: (name: string, handler: () => unknown) => sdk.handlers.set(name, handler),
  proxyActivities: () => sdk,
  executeChild: sdk.executeChild,
  CancellationScope: class {
    run<T>(run: () => Promise<T>) {
      return run();
    }
    cancel() {
      sdk.cancel();
    }
    static nonCancellable<T>(run: () => Promise<T>) {
      return run();
    }
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  sdk.handlers.clear();
});
describe('scoped review coordinator', () => {
  function fixture() {
    const f = controlFixture();
    const input: ReviewInput = {
      schemaVersion: 1,
      preparation: f.input.preparation,
      reviewId: 'one',
      request: f.proof,
    };
    const row: ReviewPlan['decisions'][number] = {
      roleId: 'reviewer',
      action: 'review',
      reasons: ['new'],
      input: {
        schemaVersion: 2,
        preparation: f.input.preparation,
        roleId: 'reviewer',
        reviewId: 'a'.repeat(64),
        review: f.proof,
      },
      answer: null,
    };
    sdk.prepareReviewPlan.mockResolvedValue({ manifest: f.proof, decisions: [row] });
    sdk.finishReview.mockResolvedValue({ manifest: f.proof, complete: true });
    sdk.executeChild.mockResolvedValue({ status: 'answered', answer: f.proof });
    return { ...f, reviewInput: input, row };
  }
  it('finishes new roles only after final evidence verification and sets safe child cancellation policies', async () => {
    const f = fixture(),
      result = await ReviewWorkflow(f.reviewInput);
    expect(result).toMatchObject({ status: 'reviewed', complete: true });
    expect(sdk.handlers.get('reviewInput')!()).toEqual(f.reviewInput);
    expect(sdk.executeChild.mock.calls[0]![1]).toMatchObject({
      parentClosePolicy: 'REQUEST_CANCEL',
      cancellationType: 'WAIT_CANCELLATION_COMPLETED',
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
    expect(sdk.finishReview.mock.calls[0]![0]).toMatchObject({
      answers: [{ roleId: 'reviewer', answer: f.proof }],
    });
  });
  it('starts no children or completion on blocked admission, and reuses without spawning', async () => {
    const f = fixture();
    f.row.action = 'blocked';
    expect((await ReviewWorkflow(f.reviewInput)).status).toBe('blocked');
    expect(sdk.executeChild).not.toHaveBeenCalled();
    expect(sdk.finishReview).not.toHaveBeenCalled();
    f.row.action = 'reuse';
    f.row.answer = f.proof;
    await ReviewWorkflow(f.reviewInput);
    expect(sdk.executeChild).not.toHaveBeenCalled();
    f.row.action = 'not-applicable';
    f.row.answer = null;
    await ReviewWorkflow(f.reviewInput);
    expect(sdk.finishReview.mock.calls.at(-1)![0]).toMatchObject({
      answers: [{ roleId: 'reviewer', answer: null }],
    });
  });
  it('keeps cancelled child results incomplete and propagates admission, child and evidence failures', async () => {
    const f = fixture();
    sdk.executeChild.mockResolvedValueOnce({ status: 'cancelled', stop: f.proof });
    await ReviewWorkflow(f.reviewInput);
    expect(sdk.finishReview.mock.calls[0]![0]).toMatchObject({
      answers: [{ roleId: 'reviewer', answer: null }],
    });
    f.row.input = null;
    await expect(ReviewWorkflow(f.reviewInput)).rejects.toThrow('review-reader-input-missing');
    await expect(
      ReviewWorkflow({ ...f.reviewInput, schemaVersion: 2 } as unknown as ReviewInput),
    ).rejects.toThrow('review-schema-unsupported');
    sdk.prepareReviewPlan.mockRejectedValueOnce(new Error('missing input'));
    await expect(ReviewWorkflow(f.reviewInput)).rejects.toThrow('missing input');
    f.row.input = {
      schemaVersion: 2,
      preparation: f.input.preparation,
      roleId: 'reviewer',
      reviewId: 'b'.repeat(64),
      review: f.proof,
    };
    sdk.executeChild.mockRejectedValueOnce(new Error('child failed'));
    await expect(ReviewWorkflow(f.reviewInput)).rejects.toThrow('child failed');
    sdk.finishReview.mockRejectedValueOnce(new Error('evidence stale'));
    await expect(ReviewWorkflow(f.reviewInput)).rejects.toThrow('evidence stale');
  });
  it('waits for another child to stop before exposing a peer failure', async () => {
    const f = fixture();
    sdk.prepareReviewPlan.mockResolvedValue({ manifest: f.proof, decisions: [f.row, f.row] });
    let stopped!: () => void;
    const pending = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    sdk.executeChild.mockRejectedValueOnce(new Error('child failed'));
    sdk.executeChild.mockImplementationOnce(async () => {
      await pending;
      return { status: 'cancelled', stop: f.proof };
    });
    let settled = false;
    const result = ReviewWorkflow(f.reviewInput).catch((error: unknown) => {
      settled = true;
      return error;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(sdk.cancel).toHaveBeenCalledTimes(1);
    stopped();
    expect(await result).toMatchObject({ message: 'child failed' });
    expect(sdk.finishReview).not.toHaveBeenCalled();
  });
});
