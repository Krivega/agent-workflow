import { writeFile } from 'node:fs/promises';
import { readPrivateFile } from '../storage/storeFiles.js';
import { createHash } from 'node:crypto';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import type { AppServerRpc } from './appServerTransport.js';
import { sameValue } from '../../core/equality.js';
import type { ProcessIdentity, WriterProcesses } from '../../ports/writerProcesses.js';
import type { InputRef } from '../../core/localRun.js';
import { writerScopeHash } from '../project/writerScope.js';
export interface OwnedWriter {
  thread: string;
  turn: string | null;
  terminals: { process: string; pid: number | null }[];
  bindings?: { terminal: string; processes: ProcessIdentity[]; evidence: InputRef }[];
  runtime?: { process: ProcessIdentity; policy: InputRef };
  markers: string[];
  complete: boolean;
  tree?: string;
}
export async function ownedRuntimeProcesses(
  rpc: Pick<AppServerRpc, 'request'>,
  processes: WriterProcesses,
  root: ProcessIdentity,
  thread: string,
  policy: InputRef,
) {
  const loaded = object(await rpc.request('thread/loaded/list', { limit: 100 }));
  requireWorkflow(
    Array.isArray(loaded.data) &&
      loaded.data.length <= 1 &&
      loaded.data.every((id) => id === thread) &&
      (loaded.nextCursor === null || loaded.nextCursor === undefined),
    'writer-runtime-list-incomplete',
  );
  const descendants = async (roots: number[]) => {
    const observed = await processes.descendants([...new Set([root.pid, ...roots])]);
    requireWorkflow(
      observed.some((entry) => sameValue(entry, root)),
      'writer-process-identity-changed',
    );
    return observed.filter((entry) => entry.pid !== root.pid);
  };
  await descendants([]);
  const scoped: WriterProcesses = {
    descendants,
    alive: async (identities) => {
      const live = [...(await processes.alive(identities)), ...(await descendants([]))];
      return [...new Map(live.map((entry) => [entry.pid, entry])).values()];
    },
    terminate: (identities) => processes.terminate(identities),
    wait: (milliseconds) => processes.wait(milliseconds),
  };
  return { processes: scoped, runtime: { process: root, policy } };
}
export class AppServerWriters {
  constructor(
    private readonly rpc: Pick<AppServerRpc, 'request'>,
    private readonly processes: WriterProcesses,
  ) {}
  private async loaded(thread: string) {
    const response = object(await this.rpc.request('thread/loaded/list', { limit: 100 }));
    requireWorkflow(
      Array.isArray(response.data) &&
        response.data.every((id) => typeof id === 'string') &&
        (response.nextCursor === null || response.nextCursor === undefined),
      'writer-runtime-list-incomplete',
    );
    requireWorkflow(response.data.includes(thread), 'writer-runtime-unbound');
  }
  private async terminals(thread: string) {
    const response = object(
      await this.rpc.request('thread/backgroundTerminals/list', { threadId: thread, limit: 100 }),
    );
    requireWorkflow(
      Array.isArray(response.data) &&
        (response.nextCursor === null || response.nextCursor === undefined),
      'writer-list-incomplete',
    );
    return response.data.map(object);
  }
  async stop(owned: OwnedWriter, receiptPath: string): Promise<InputRef> {
    requireWorkflow(owned.complete && owned.markers.length > 0, 'writer-scope-incomplete');
    [owned.thread, ...(owned.turn === null ? [] : [owned.turn]), ...owned.markers].forEach(
      textField,
    );
    await this.loaded(owned.thread);
    const before = await this.terminals(owned.thread);
    requireWorkflow(
      before.every((t) =>
        owned.terminals.some((p) => p.process === t.processId && p.pid === t.osPid),
      ),
      'unknown-writer',
    );
    const bound: ProcessIdentity[] = [];
    const liveBound: ProcessIdentity[] = [];
    const roots: number[] = [];
    for (const terminal of owned.terminals) {
      if (terminal.pid !== null) roots.push(terminal.pid);
      else {
        const binding = owned.bindings?.find((item) => item.terminal === terminal.process);
        requireWorkflow(
          binding !== undefined && binding.processes.length > 0,
          'writer-process-binding-missing',
        );
        const bytes = readPrivateFile(binding.evidence.locator);
        requireWorkflow(
          createHash('sha256').update(bytes).digest('hex') === binding.evidence.hash,
          'writer-process-binding-changed',
        );
        const proof = object(JSON.parse(bytes.toString('utf8')) as unknown);
        requireWorkflow(
          proof.kind === 'process-binding' &&
            proof.thread === owned.thread &&
            proof.terminal === terminal.process &&
            proof.scope_complete === true &&
            sameValue(proof.processes, binding.processes),
          'writer-process-binding-unconfirmed',
        );
        const live = await this.processes.alive(binding.processes);
        bound.push(...binding.processes);
        liveBound.push(...live);
        roots.push(...live.map((p) => p.pid));
      }
    }
    const unique = new Map<number, ProcessIdentity>();
    const descendants = await this.processes.descendants(roots);
    requireWorkflow(
      roots.every((pid) => descendants.some((p) => p.pid === pid)),
      'writer-process-identity-lost',
    );
    for (const identity of [...bound, ...descendants]) {
      const previous = unique.get(identity.pid);
      requireWorkflow(
        previous === undefined || previous.started === identity.started,
        'writer-process-identity-changed',
      );
      unique.set(identity.pid, identity);
    }
    const observed = [...unique.values()].filter((p) =>
      [...liveBound, ...descendants].some((live) => live.pid === p.pid),
    );
    const current = object(
      object(await this.rpc.request('thread/read', { threadId: owned.thread, includeTurns: true }))
        .thread,
    );
    requireWorkflow(
      current.id === owned.thread && Array.isArray(current.turns),
      'writer-thread-unconfirmed',
    );
    const activeTurns = current.turns.map(object).filter((t) => t.status === 'inProgress');
    requireWorkflow(
      activeTurns.every((t) => t.id === owned.turn),
      'unknown-active-turn',
    );
    // Stop the tree before RPC interruption can kill a parent and orphan its late children.
    const processes = await this.processes.terminate(observed);
    if (activeTurns.length > 0)
      await this.rpc.request('turn/interrupt', { threadId: owned.thread, turnId: owned.turn });
    const remaining = await this.terminals(owned.thread);
    requireWorkflow(
      remaining.every((t) =>
        owned.terminals.some((p) => p.process === t.processId && p.pid === t.osPid),
      ),
      'unknown-late-writer',
    );
    for (const terminal of remaining)
      await this.rpc.request('thread/backgroundTerminals/terminate', {
        threadId: owned.thread,
        processId: textField(terminal.processId),
      });
    for (
      let attempt = 0;
      attempt < 20 && (await this.processes.alive(processes)).length > 0;
      attempt++
    )
      await this.processes.wait(50);
    const live = await this.processes.alive(processes);
    const final = await this.terminals(owned.thread);
    const thread = object(
      object(await this.rpc.request('thread/read', { threadId: owned.thread, includeTurns: true }))
        .thread,
    );
    requireWorkflow(
      thread.id === owned.thread && Array.isArray(thread.turns),
      'writer-thread-unconfirmed',
    );
    const active = thread.turns.map(object).some((turn) => turn.status === 'inProgress');
    requireWorkflow(live.length === 0 && final.length === 0 && !active, 'writers-still-active');
    const first = await writerScopeHash(owned.markers, owned.tree);
    await this.processes.wait(250);
    const last = await writerScopeHash(owned.markers, owned.tree);
    requireWorkflow(
      first === last && (await this.processes.alive(processes)).length === 0,
      'late-writer-detected',
    );
    const proof = {
      kind: 'writers-stopped',
      thread: owned.thread,
      active_turn: false,
      remaining_terminals: final.length,
      remaining_processes: live.length,
      before_hash: first,
      after_hash: last,
      observation_ms: 250,
      owned,
      processes,
    };
    const bytes = JSON.stringify(proof, null, 2) + '\n';
    await writeFile(receiptPath, bytes, { flag: 'wx' });
    return { locator: receiptPath, hash: createHash('sha256').update(bytes).digest('hex') };
  }
}
