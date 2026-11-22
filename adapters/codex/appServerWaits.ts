import { object, requireWorkflow } from '../../core/connection.js';

/** Completion delivery and primary-history reconciliation for one owned native transport. */
export class AppServerWaits {
  private readonly turns = new Set<string>();
  private readonly waiters = new Map<string, { resolve(): void; reject(error: Error): void }[]>();
  private closed = false;
  constructor(
    private readonly read: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ) {}
  observe(message: Record<string, unknown>) {
    if (this.closed || 'id' in message || message.method !== 'turn/completed') return;
    const params = object(message.params);
    const turn = object(params.turn);
    const key = `${String(params.threadId)}:${String(turn.id)}`;
    this.turns.add(key);
    for (const waiter of this.waiters.get(key) ?? []) waiter.resolve();
    this.waiters.delete(key);
  }
  async completed(
    thread: string,
    turn: string,
    signal?: AbortSignal,
    verify?: () => Promise<void>,
  ) {
    requireWorkflow(!this.closed, 'app-server-closed');
    requireWorkflow(!signal?.aborted, 'app-server-wait-cancelled');
    if (verify !== undefined) {
      await verify();
      requireWorkflow(!this.closed, 'app-server-closed');
      requireWorkflow(!signal?.aborted, 'app-server-wait-cancelled');
    }
    const key = `${thread}:${turn}`;
    if (this.turns.has(key)) return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        const remaining = (this.waiters.get(key) ?? []).filter((entry) => entry !== waiter);
        if (remaining.length === 0) this.waiters.delete(key);
        else this.waiters.set(key, remaining);
        if (error === undefined) resolve();
        else reject(error);
      };
      const cancel = () => finish(new Error('app-server-wait-cancelled'));
      const complete = async () => {
        try {
          await verify?.();
          finish();
        } catch (error) {
          finish(error);
        }
      };
      const waiter = {
        resolve: () => {
          void complete();
        },
        reject: (error: Error) => finish(error),
      };
      const reconcile = async () => {
        try {
          await verify?.();
          if (settled) return;
          const response = await this.read('thread/read', {
            threadId: thread,
            includeTurns: true,
          });
          if (settled) return;
          const current = object(object(response).thread);
          requireWorkflow(
            current.id === thread && Array.isArray(current.turns),
            'app-server-thread-unconfirmed',
          );
          const matches = current.turns.map(object).filter((entry) => entry.id === turn);
          requireWorkflow(matches.length === 1, 'app-server-turn-unconfirmed');
          const status = matches[0]!.status;
          requireWorkflow(
            ['inProgress', 'completed', 'failed', 'interrupted'].includes(String(status)),
            'app-server-turn-unconfirmed',
          );
          if (status === 'inProgress')
            timer = setTimeout(() => {
              void reconcile();
            }, 1000);
          else {
            this.turns.add(key);
            await complete();
          }
        } catch (error) {
          finish(error);
        }
      };
      this.waiters.set(key, [...(this.waiters.get(key) ?? []), waiter]);
      signal?.addEventListener('abort', cancel, { once: true });
      // Notifications wake immediately; primary history repairs a lost delivery inside this call.
      timer = setTimeout(() => {
        void reconcile();
      }, 1000);
    });
  }
  close(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.waiters.clear();
  }
}
