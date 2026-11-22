import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, closeSync, constants, openSync, writeFileSync } from 'node:fs';
import { object, requireWorkflow } from '../../core/connection.js';
import { TransportJournal } from './transportJournal.js';
import { AppServerWaits } from './appServerWaits.js';

export interface AppServerRpc {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  completed(
    thread: string,
    turn: string,
    signal?: AbortSignal,
    verify?: () => Promise<void>,
  ): Promise<void>;
}
export class StdioAppServer implements AppServerRpc {
  private readonly process;
  get pid() {
    return this.process.pid;
  }
  private serial = 0;
  private captureSequence = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly waits = new AppServerWaits((method, params) => this.request(method, params));
  private closed = false;
  private readonly journal: TransportJournal;
  private readonly observers = new Set<(message: Record<string, unknown>) => void>();
  observe(listener: (message: Record<string, unknown>) => void) {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }
  constructor(
    binary: string,
    args: string[],
    cwd: string,
    journal: string,
    creationOperation?: string,
    private readonly fullJournal?: string,
  ) {
    this.journal = new TransportJournal(journal, creationOperation);
    if (fullJournal !== undefined)
      writeFileSync(fullJournal, '', { flag: 'wx', mode: 0o600, flush: true });
    this.process = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('error', (error) => this.fail(error));
    this.process.stderr.on('error', (error) => this.fail(error));
    lines.on('line', (line) => {
      if (this.closed) return;
      try {
        this.capture('recv', line);
        this.receive(object(JSON.parse(line) as unknown), line);
      } catch {
        if (!this.closed) this.fail(new Error('invalid-app-server-message'));
      }
    });
    this.process.stderr.on('data', (bytes: Buffer) => {
      if (this.closed) return;
      try {
        this.record('stderr', bytes.toString(), bytes.toString());
      } catch {
        // record already rejected pending work and stopped this owned transport.
      }
    });
    this.process.on('error', (error) => this.fail(error));
    this.process.stdin.on('error', (error) => this.fail(error));
    this.process.on('exit', () => {
      lines.close();
      this.fail(new Error('app-server-exited'));
    });
  }
  private write(message: unknown) {
    requireWorkflow(!this.closed, 'app-server-closed');
    const raw = JSON.stringify(message);
    this.capture('send', raw);
    this.record('send', message, raw);
    this.process.stdin.write(raw + '\n');
  }
  private receive(message: Record<string, unknown>, raw: string) {
    this.record('recv', message, raw);
    if (!('id' in message)) for (const listener of this.observers) listener(message);
    if ('id' in message && 'method' in message) {
      this.write({
        id: message.id,
        error: { code: -32601, message: 'No authority for a server-requested action' },
      });
    } else if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ('error' in message)
        pending.reject(new Error(`app-server-error:${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    } else this.waits.observe(message);
  }

  private capture(side: 'send' | 'recv', raw: string) {
    if (this.fullJournal === undefined) return;
    try {
      const fd = openSync(
        this.fullJournal,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      try {
        appendFileSync(fd, JSON.stringify({ seq: ++this.captureSequence, side, raw }) + '\n', {
          flush: true,
        });
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('app-server-capture-failed'));
      throw error;
    }
  }
  private record(...args: Parameters<TransportJournal['write']>) {
    try {
      this.journal.write(...args);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('app-server-journal-failed'));
      throw error;
    }
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.waits.close(error);
    this.stop();
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    requireWorkflow(!this.closed, 'app-server-closed');
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('app-server-outcome-unknown'));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'agent_workflow', title: 'Local agent workflow', version: 'aw5/1' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
  }
  completed(thread: string, turn: string, signal?: AbortSignal, verify?: () => Promise<void>) {
    return this.waits.completed(thread, turn, signal, verify);
  }
  private stop() {
    // EOF lets the owned server release its session writers, including a CLI launcher child.
    let forced: ReturnType<typeof setTimeout> | undefined;
    const fallback = setTimeout(() => {
      forced = setTimeout(() => this.process.kill('SIGKILL'), 1_000);
      this.process.kill('SIGTERM');
    }, 1_000);
    this.process.once('exit', () => {
      clearTimeout(fallback);
      clearTimeout(forced);
    });
    this.process.stdin.end();
  }
  close() {
    this.fail(new Error('app-server-closed'));
  }
}
