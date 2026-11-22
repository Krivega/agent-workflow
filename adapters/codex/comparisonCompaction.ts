import { sameValue } from '../../core/equality.js';
import type { InputRef } from '../../core/localRun.js';
import type { StdioAppServer } from './appServerTransport.js';
import type { FileCurrentChatHost } from './currentChatHost.js';

export async function comparisonCompaction(
  rpc: Pick<StdioAppServer, 'observe' | 'request'>,
  host: Pick<FileCurrentChatHost, 'compaction'>,
  thread: string,
  verify: () => Promise<void>,
): Promise<InputRef> {
  const before = await host.compaction();
  return new Promise((resolve, reject) => {
    let settled = false,
      busy = false;
    const close = () => {
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      stop();
    };
    const fail = (error: unknown) => {
      if (!settled) {
        close();
        reject(error);
      }
    };
    const check = async () => {
      if (settled || busy) return;
      busy = true;
      try {
        await verify();
        const boundary = await host.compaction();
        if (!settled && boundary !== undefined && !sameValue(before, boundary)) {
          close();
          resolve(boundary);
        }
      } catch (error) {
        fail(error);
      } finally {
        busy = false;
      }
    };
    const stop = rpc.observe(() => {
      void check();
    });
    const poll = setInterval(() => {
      void check();
    }, 1000);
    const timeout = setTimeout(
      () => fail(new Error('comparison-compaction-outcome-unknown')),
      60_000,
    );
    void rpc.request('thread/compact/start', { threadId: thread }).then(check, fail);
  });
}
