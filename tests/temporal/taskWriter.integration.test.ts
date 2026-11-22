import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { localTaskFixture } from './localTaskFixture.js';
import { taskWriter, inspectTaskWriter } from '../../src/adapters/codex/taskWriter.js';
import { NativeWriterProcesses } from '../../src/adapters/codex/writerProcesses.js';
import { readerBudget } from '../../src/adapters/codex/readerBudget.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { taskGate } from '../../src/adapters/project/taskGate.js';
import { captureTaskBudget } from '../../src/worker/taskBudget.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import type { TaskSnapshot } from '../../src/contracts/localTask.js';

describe('owned Writer process loss with a protocol double', { timeout: 15000 }, () => {
  it.each(['cleanup', 'external-loss'] as const)(
    'retains logical UNKNOWN and spent credit after %s',
    async (mode) => {
      const f = localTaskFixture();
      const snapshot = await f.service.activities.prepareLocalTask(f.input);
      const body = f.read(snapshot) as unknown as TaskSnapshot;
      const directory = join(
        f.workspace,
        '.git/agent-workflow/tasks',
        digest(localTaskKey(f.input)),
      );
      const grant = JSON.parse(readFileSync(join(directory, 'grant.json'), 'utf8')) as {
        instance: string;
      };
      const gate = taskGate(
        body.input,
        body.source,
        f.profile,
        f.registration.artifactRoot,
        grant.instance,
      );
      const files = taskFiles(f.registration.artifactRoot);
      const processes = new NativeWriterProcesses();
      const terminate = vi.spyOn(processes, 'terminate');
      const credits = join(f.root, 'physical-turn-credits');
      const consume = readerBudget(credits, 4);
      const lost = new Error('owned-writer-lost');
      const history = new Error(
        'app-server-error:{"code":-32601,"message":"list_turns is not supported yet"}',
      );
      let child: ChildProcess | undefined;
      let writes = 0;
      let enter!: () => void;
      let rejectCompletion!: (error: Error) => void;
      let exited!: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
      const active = new Promise<void>((done) => {
        enter = done;
      });
      const completion = new Promise<void>((_resolve, reject) => {
        rejectCompletion = reject;
      });
      void completion.catch(() => {});
      const factory = vi.fn((root: string) => {
        const base = f.createRuntime(root);
        child = spawn(
          process.execPath,
          [
            '--input-type=commonjs',
            '-e',
            `const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r+');const bytes=fs.readFileSync(fd);let writes=0;setInterval(()=>{fs.writeSync(fd,bytes,0,bytes.length,0);process.send({writes:++writes})},15);`,
            join(root, 'owner.cjs'),
          ],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
        );
        const actor = child;
        const ready = new Promise<void>((resolve, reject) => {
          actor.once('message', () => resolve());
          actor.once('error', reject);
        });
        actor.on('message', (message: { writes: number }) => {
          writes = message.writes;
        });
        exited = new Promise((resolve) => {
          actor.once('exit', (code, signal) => {
            rejectCompletion(lost);
            resolve({ code, signal });
          });
        });
        return {
          ...base,
          pid: actor.pid!,
          initialize: async () => {
            await ready;
          },
          completed: () => completion,
          request: async (method: string, params: Record<string, unknown>) => {
            if (method === 'thread/read') throw history;
            const result = await base.request(method, params);
            if (method === 'turn/start') enter();
            return result;
          },
        };
      });
      const writer = taskWriter(body, files, gate, factory, processes, consume);
      try {
        const outcome = writer.write().catch((error: unknown) => error);
        await Promise.race([
          active,
          outcome.then(() => {
            throw new Error('Writer ended before the active turn');
          }),
        ]);
        expect(writes).toBeGreaterThan(0);
        const before = captureTaskBudget(credits, files.store, null);
        expect({ used: before.used, limit: before.limit }).toEqual({ used: 1, limit: 4 });
        expect((await inspectTaskWriter(body, files, directory, processes)).status).toBe('live');
        const replacement = vi.fn((root: string) => factory(root));
        const restarted = taskWriter(body, files, gate, replacement, processes, consume);
        await expect(restarted.write()).rejects.toThrow('task-writer-runtime-unknown');
        await expect(restarted.stop()).rejects.toThrow('task-writer-runtime-unknown');
        expect(replacement).not.toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();
        if (mode === 'cleanup') await expect(writer.stop()).rejects.toBe(history);
        else expect(child!.kill('SIGKILL')).toBe(true);
        expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
        expect(await outcome).toBe(lost);
        expect(await inspectTaskWriter(body, files, directory, processes)).toEqual({
          status: 'unknown',
          reason: 'task-writer-stop-unconfirmed',
        });
        await expect(restarted.stop()).rejects.toThrow('task-writer-runtime-unknown');
        const after = captureTaskBudget(credits, files.store, before.manifest);
        expect(after).toEqual(before);
        expect(existsSync(join(directory, 'writer-stopped.json'))).toBe(false);
        expect(existsSync(join(f.workspace, '.git/agent-workflow/source-reservation'))).toBe(true);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(f.state.starts).toBe(1);
        console.info(
          JSON.stringify({
            kind: 'owned-writer-process-loss',
            mode,
            pid: child!.pid,
            signal: 'SIGKILL',
            physicalWritesObserved: writes,
            fakeStarts: 1,
            reservedCredits: after.used,
            logicalStop: 'unknown',
            actualNativeModels: 0,
          }),
        );
      } finally {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
        terminate.mockRestore();
      }
    },
  );
});
