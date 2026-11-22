import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessIdentity, WriterProcesses } from '../../contracts/writerProcesses.js';
import { requireWorkflow } from '../../contracts/localValues.js';
const exec = promisify(execFile);
type Observation = ProcessIdentity & { state: string };
function identity({ pid, parent, started }: ProcessIdentity): ProcessIdentity {
  return { pid, parent, started };
}
function safePid(pid: number) {
  requireWorkflow(
    Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid,
    'invalid-owned-process',
  );
}
function signal(pid: number, name: 'SIGSTOP' | 'SIGKILL' | 'SIGCONT') {
  safePid(pid);
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as { code: string }).code !== 'ESRCH') throw error;
  }
}
export class NativeWriterProcesses implements WriterProcesses {
  private async table(): Promise<Observation[]> {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,stat=,lstart=']);
    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
        requireWorkflow(match !== null, 'process-observation-invalid');
        return {
          pid: Number(match[1]),
          parent: Number(match[2]),
          state: match[3]!,
          started: match[4]!,
        };
      });
  }
  async descendants(roots: number[]) {
    roots.forEach(safePid);
    const table = await this.table(),
      owned = new Set(roots);
    let added: boolean;
    do {
      added = false;
      for (const item of table)
        if (owned.has(item.parent) && !owned.has(item.pid)) {
          owned.add(item.pid);
          added = true;
        }
    } while (added);
    return table.filter((p) => owned.has(p.pid)).map(identity);
  }
  async alive(identities: ProcessIdentity[]) {
    const table = await this.table();
    return identities.filter((id) =>
      table.some((p) => p.pid === id.pid && p.started === id.started),
    );
  }
  async terminate(identities: ProcessIdentity[]) {
    identities.forEach((p) => safePid(p.pid));
    const tracked = new Map(identities.map((p) => [p.pid, p]));
    const suspended = new Map<number, ProcessIdentity>();
    let terminated = false;
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const table = await this.table();
        for (const p of tracked.values()) {
          const observed = table.find((entry) => entry.pid === p.pid);
          if (observed === undefined || observed.started !== p.started)
            throw new Error('writer-process-identity-lost', {
              cause: new Error(
                JSON.stringify({
                  reason: observed === undefined ? 'missing' : 'reused',
                  expectedPID: p.pid,
                  expectedStart: p.started,
                  observed: observed === undefined ? null : identity(observed),
                }),
              ),
            });
        }
        // Retain ancestry while parents are alive; a stopped parent cannot create new children.
        let added: boolean;
        do {
          added = false;
          for (const p of table)
            if (tracked.has(p.parent) && !tracked.has(p.pid)) {
              safePid(p.pid);
              tracked.set(p.pid, identity(p));
              added = true;
            }
        } while (added);
        const running = table.filter((p) => tracked.has(p.pid) && !/^[TZ]/u.test(p.state));
        if (running.length === 0) {
          // No signal handlers run and fork after this point, unlike SIGTERM-before-interrupt.
          for (const p of tracked.values()) signal(p.pid, 'SIGKILL');
          terminated = true;
          return [...tracked.values()];
        }
        for (const p of running) {
          signal(p.pid, 'SIGSTOP');
          suspended.set(p.pid, identity(p));
        }
        await this.wait(10);
      }
      throw new Error('writer-process-stop-unconfirmed');
    } finally {
      // A failed observation must neither authorize relay nor leave processes suspended by us.
      if (!terminated && suspended.size > 0)
        for (const p of await this.alive([...suspended.values()])) signal(p.pid, 'SIGCONT');
    }
  }
  async wait(milliseconds: number) {
    await new Promise((done) => setTimeout(done, milliseconds));
  }
}
