import { comparisonCompaction } from '../adapters/codex/comparisonCompaction.js';
import type { InputRef } from '../core/localRun.js';
import type { StdioAppServer } from '../adapters/codex/appServerTransport.js';

let notify: () => void;
let boundary: InputRef | undefined;
let rpc: {
  observe: ReturnType<typeof vi.fn<StdioAppServer['observe']>>;
  request: ReturnType<typeof vi.fn<StdioAppServer['request']>>;
};
let stop: ReturnType<typeof vi.fn<() => void>>;
let verify: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  vi.useFakeTimers();
  boundary = undefined;
  stop = vi.fn();
  verify = vi.fn(async () => {});
  rpc = {
    observe: vi.fn((listener: (message: Record<string, unknown>) => void) => {
      notify = () => listener({});
      return stop;
    }),
    request: vi.fn(async () => ({})),
  };
});
afterEach(() => vi.useRealTimers());
const host = { compaction: async () => boundary };
const ref = { locator: '/primary#L4', hash: 'new' };

it('subscribes before the one native effect and reconciles lost notifications inside the wait', async () => {
  const result = comparisonCompaction(rpc, host, 'thread', verify);
  await vi.advanceTimersByTimeAsync(0);
  expect(rpc.observe.mock.invocationCallOrder[0]).toBeLessThan(
    rpc.request.mock.invocationCallOrder[0]!,
  );
  expect(rpc.request).toHaveBeenCalledWith('thread/compact/start', { threadId: 'thread' });
  boundary = ref;
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toEqual(ref);
  expect(stop).toHaveBeenCalledOnce();
  notify();
  await vi.runAllTimersAsync();
  expect(rpc.request).toHaveBeenCalledOnce();
});
it('requires a new primary boundary and wakes on delivery while the response is lost', async () => {
  boundary = { ...ref, hash: 'old' };
  rpc.request.mockImplementation(() => new Promise(() => {}));
  const result = comparisonCompaction(rpc, host, 'thread', verify);
  await vi.advanceTimersByTimeAsync(1000);
  expect(stop).not.toHaveBeenCalled();
  boundary = ref;
  notify();
  await expect(result).resolves.toEqual(ref);
});
it('ignores overlapping checks and fails closed when authority is revoked', async () => {
  let reject!: (e: Error) => void;
  verify.mockImplementation(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const result = comparisonCompaction(rpc, host, 'thread', verify);
  const rejection = expect(result).rejects.toThrow('revoked');
  await vi.advanceTimersByTimeAsync(2000);
  notify();
  expect(verify).toHaveBeenCalledOnce();
  reject(new Error('revoked'));
  await rejection;
  boundary = ref;
  notify();
  expect(stop).toHaveBeenCalledOnce();
});
it('does not repeat an unknown compact operation after a timeout or rejected request', async () => {
  const result = comparisonCompaction(rpc, host, 'thread', verify);
  const rejection = expect(result).rejects.toThrow('comparison-compaction-outcome-unknown');
  await vi.advanceTimersByTimeAsync(60000);
  await rejection;
  expect(rpc.request).toHaveBeenCalledOnce();
  rpc.request.mockRejectedValueOnce(new Error('lost'));
  await expect(comparisonCompaction(rpc, host, 'thread', verify)).rejects.toThrow('lost');
  expect(stop).toHaveBeenCalledTimes(2);
});
it('ignores a late failed response after a primary compact boundary was accepted', async () => {
  let reject!: (error: Error) => void;
  rpc.request.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const result = comparisonCompaction(rpc, host, 'thread', verify);
  await vi.advanceTimersByTimeAsync(0);
  boundary = ref;
  notify();
  await expect(result).resolves.toEqual(ref);
  reject(new Error('late failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(stop).toHaveBeenCalledOnce();
});
