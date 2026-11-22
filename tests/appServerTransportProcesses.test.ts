import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { StdioAppServer } from '../adapters/codex/appServerTransport.js';
import { TransportJournal } from '../adapters/codex/transportJournal.js';

it.each(['recv', 'stderr'] as const)(
  'stops a real owned process after %s journaling fails, including ignored EOF/SIGTERM',
  async (channel) => {
    const directory = realpathSync(mkdtempSync(resolve(tmpdir(), 'rpc-journal-failure-')));
    const server = `
    process.on('SIGTERM', () => {});
    process.stdin.on('data', () => {
      ${channel === 'recv' ? 'process.stdout.write(JSON.stringify({id:1,result:{}})+"\\n");' : 'process.stderr.write("observed failure");'}
    });
    setInterval(() => {}, 1000);
  `;
    const original = TransportJournal.prototype.write;
    const spy = vi.spyOn(TransportJournal.prototype, 'write').mockImplementation(function (
      this: TransportJournal,
      direction,
      ...args
    ) {
      if (direction === channel) throw Object.assign(new Error('journal full'), { code: 'ENOSPC' });
      original.call(this, direction, ...args);
    });
    const rpc = new StdioAppServer(
      process.execPath,
      ['-e', server],
      directory,
      resolve(directory, 'transport.jsonl'),
    );
    try {
      await expect(rpc.request('probe', {})).rejects.toThrow('journal full');
      expect(() => rpc.request('retry', {})).toThrow('app-server-closed');
      const stopped = await new Promise<boolean>((done) => {
        const deadline = Date.now() + 4000;
        const check = () => {
          try {
            process.kill(rpc.pid!, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return done(true);
            throw error;
          }
          if (Date.now() >= deadline) return done(false);
          setTimeout(check, 20);
        };
        check();
      });
      expect(stopped).toBe(true);
    } finally {
      rpc.close();
      spy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
