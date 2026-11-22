import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { WriterProcesses, ProcessIdentity } from '../../contracts/writerProcesses.js';
import { requireContract } from '../../contracts/project.js';
import { privateDirectory } from '../artifacts/files.js';

// Keep the dedicated supervisor alive until its process group has been stopped and observed.
const supervisor = `const {spawn}=require('node:child_process');process.on('message',m=>{if(m.type!=='start')return;const c=spawn(m.command.executable,m.command.args,{cwd:m.cwd,env:{PATH:process.env.PATH,LANG:process.env.LANG,LC_ALL:process.env.LC_ALL,TMPDIR:m.cwd},stdio:['ignore',1,2]});c.on('error',e=>process.send({type:'finished',code:null,signal:null,error:String(e)}));c.on('close',(code,signal)=>process.send({type:'finished',code,signal,error:null}));});process.send({type:'ready'});`;
const exec = promisify(execFile);
async function group(pid: number) {
  const { stdout } = await exec('ps', ['-axo', 'pgid=,pid=']);
  return stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter(([pgid]) => pgid === pid)
    .map(([, member]) => member!);
}
export function taskChecks(directory: string, processes: WriterProcesses) {
  privateDirectory(directory);
  let active: {
    child: ChildProcess;
    identity: ProcessIdentity[];
    stop: Promise<readonly ProcessIdentity[]> | null;
  } | null = null;
  async function stop() {
    if (active === null) return [];
    const own = active;
    if (own.stop === null)
      own.stop = (async () => {
        const retained = await processes.alive(own.identity),
          members = await group(own.child.pid!);
        requireContract(members.includes(own.child.pid!), 'task-check-group-unknown');
        const observed = await processes.descendants([
          ...new Set([...members, ...retained.map((p) => p.pid)]),
        ]);
        requireContract(
          observed.some((o) =>
            own.identity.some(
              (p) => p.pid === own.child.pid && p.pid === o.pid && p.started === o.started,
            ),
          ),
          'task-check-process-changed:' +
            JSON.stringify({
              pid: own.child.pid,
              initial: own.identity,
              retained,
              observed,
              exitCode: own.child.exitCode,
              signalCode: own.child.signalCode,
            }),
        );
        await processes.terminate(observed);
        for (let i = 0; i < 100 && (await processes.alive(observed)).length; i++)
          await processes.wait(20);
        requireContract(
          (await processes.alive(observed)).length === 0 &&
            (await group(own.child.pid!)).length === 0,
          'task-check-stop-unknown',
        );
        return observed;
      })();
    try {
      const stopped = await own.stop;
      if (active === own) active = null;
      return stopped;
    } catch (error) {
      own.stop = null;
      throw error;
    }
  }
  async function run(
    cwd: string,
    command: { executable: string; args: readonly string[]; timeoutMs: number },
  ) {
    requireContract(active === null, 'task-check-busy');
    const file = join(directory, randomUUID() + '.log'),
      fd = openSync(file, 'wx', 0o600),
      began = performance.now();
    const child = spawn(process.execPath, ['-e', supervisor], {
      cwd,
      detached: true,
      stdio: ['ignore', fd, fd, 'ipc'],
    });
    const current = {
      child,
      identity: [] as ProcessIdentity[],
      stop: null as Promise<readonly ProcessIdentity[]> | null,
    };
    active = current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('task-check-supervisor-exited')));
        child.on('message', (m) => {
          if ((m as { type: string }).type === 'ready') resolve();
        });
      });
      current.identity = await processes.descendants([child.pid!]);
      requireContract(
        current.identity.some((p) => p.pid === child.pid),
        'task-check-process-unknown',
      );
      const outcome = await new Promise<{
        code: number | null;
        signal: string | null;
        error: string | null;
      }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('task-check-interrupted')));
        child.on('message', (message) => {
          const m = message as {
            type: string;
            code: number | null;
            signal: string | null;
            error: string | null;
          };
          if (m.type === 'finished') resolve({ code: m.code, signal: m.signal, error: m.error });
        });
        timer = setTimeout(
          () => resolve({ code: null, signal: 'timeout', error: 'task-check-timeout' }),
          command.timeoutMs,
        );
        child.send({ type: 'start', command, cwd });
      });
      const stopped = await stop();
      return {
        ...outcome,
        elapsedMs: performance.now() - began,
        command,
        log: readFileSync(file, 'utf8'),
        stop: { confirmed: true as const, processes: stopped },
      };
    } catch (error) {
      try {
        await stop();
      } catch {
        /* Preserve the operation failure; control retains an unknown stop. */
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      closeSync(fd);
    }
  }
  return { run, stop };
}
