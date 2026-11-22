import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { body, fixture, grant, signed } from './storageFixtures.js';

it('leaves a real hot rollback journal untouched for an explicit live recovery', async () => {
  const f = fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    f.claim();
    const request = signed({ type: 'write', id: 'candidate', body }, 1);
    child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        `
      import {writeSync} from 'node:fs';
      import {SqliteEvidenceStore} from ${JSON.stringify(new URL('../adapters/storage/sqliteEvidenceStore.ts', import.meta.url).href)};
      const store=new SqliteEvidenceStore(${JSON.stringify(f.root)},${JSON.stringify(grant)},()=>100,(boundary)=>{
        if(boundary==='before-commit'){writeSync(1,'ready\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
      });
      store.execute(${JSON.stringify(request)});
    `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    await once(child.stdout!, 'data');
    child.kill('SIGKILL');
    await exited;
    const snapshot = () =>
      Object.fromEntries(
        readdirSync(f.root)
          .filter((name) => name !== 'blobs')
          .map((name) => [name, readFileSync(join(f.root, name))]),
      );
    const before = snapshot();
    expect(Object.keys(before)).toContain('store.sqlite-journal');
    const reader = new SqliteEvidenceStore(f.root, grant, () => 100, undefined, 'inspect');
    expect(reader.execute({ context: grant.context, command: { type: 'state' } })).toMatchObject({
      ok: false,
      error: { code: 'recovery-required', retryable: false },
    });
    expect(snapshot()).toEqual(before);
    expect(f.execute({ type: 'operation', operation_id: 'op-1' })).toMatchObject({
      ok: true,
      value: { status: 'not-started' },
    });
    expect(f.store.execute(request).ok).toBe(true);
    expect(reader.execute({ context: grant.context, command: { type: 'state' } })).toMatchObject({
      ok: true,
      value: { revision: 2 },
    });
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    f.dispose();
  }
});
