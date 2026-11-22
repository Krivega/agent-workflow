import { ForksPoolWorker } from 'vitest/node';
import { externalToolSlots, usesExternalTools } from './vitestToolDependencies.mjs';

// One budget is shared by both projects. Waiting tools retain Vitest's worker lifecycle,
// RPC, cancellation and coverage; their total workers stay within maxWorkers.
const budgets = new WeakMap();
class ToolAwareWorker extends ForksPoolWorker {
  name = 'tool-aware';
  reportMemory = true;
  release;
  pending;
  stopped = false;
  constructor(options) {
    // shortcut: ARM64 V8 GC crash; remove after pinning nodejs/node@fb0d0ca28993802d67360edc84d467fe3ccdc20b.
    super(
      process.arch === 'arm64'
        ? { ...options, execArgv: [...options.execArgv, '--no-sparkplug'] }
        : options,
    );
    const ctx = options.project.vitest;
    if (!budgets.has(ctx))
      budgets.set(ctx, {
        active: 0,
        queue: [],
        limit: externalToolSlots(ctx.config.maxWorkers),
      });
    this.budget = budgets.get(ctx);
  }
  async start() {
    await super.start();
    this.on('message', (message) => {
      if (message?.__vitest_worker_response__ && message.type === 'testfileFinished') this.free();
    });
    this.on('error', () => this.free());
    this.on('exit', () => this.retire());
  }
  free() {
    if (!this.release) return;
    this.release = false;
    this.budget.active -= 1;
    this.budget.queue.shift()?.();
  }
  send(message) {
    const tool =
      (message.type === 'run' || message.type === 'collect') &&
      message.context.files.some(({ filepath }) => usesExternalTools(filepath));
    if (!tool) return super.send(message);
    const dispatch = () => {
      this.pending = undefined;
      if (this.stopped) return;
      this.budget.active += 1;
      this.release = true;
      super.send(message);
    };
    if (this.budget.active < this.budget.limit) dispatch();
    else {
      this.pending = dispatch;
      this.budget.queue.push(dispatch);
    }
  }
  retire() {
    this.stopped = true;
    if (this.pending)
      this.budget.queue = this.budget.queue.filter((dispatch) => dispatch !== this.pending);
    this.pending = undefined;
    this.free();
  }
  async stop() {
    this.retire();
    await super.stop();
  }
}
export default {
  name: 'tool-aware',
  createPoolWorker: (options) => new ToolAwareWorker(options),
};
