import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import { AppServerWriters } from '../adapters/codex/appServerWriters.js';

it('stops a real owned parent and descendant without late marker writes', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'aw8-native-')));
  const script = resolve(root, 'writer.cjs');
  await writeFile(
    script,
    `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=process.argv[2];let n=0;if(!child){const p=spawn(process.execPath,[__filename,'child'],{stdio:'ignore'});process.stdout.write(String(p.pid)+'\\n');}const timer=setInterval(()=>writeFileSync(__dirname+'/'+(child?'child':'parent')+'.txt',String(++n)),10);setTimeout(()=>{clearInterval(timer);process.exit(0)},3000);`,
  );
  const parent = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const control = new NativeWriterProcesses();
  let childPid: number | null = null;
  try {
    childPid = await new Promise<number>((done, reject) => {
      parent.stdout.once('data', (data: Buffer) => done(Number(data.toString().trim())));
      parent.once('error', reject);
    });
    const owned = await control.descendants([parent.pid!]);
    expect(owned.some((p) => p.pid === childPid)).toBe(true);
    await control.wait(120);
    await control.terminate(owned);
    for (let n = 0; n < 20 && (await control.alive(owned)).length; n++) await control.wait(25);
    expect(await control.alive(owned)).toEqual([]);
    const before = await Promise.all(
      ['parent', 'child'].map((name) => readFile(resolve(root, name + '.txt'), 'utf8')),
    );
    await control.wait(250);
    expect(
      await Promise.all(
        ['parent', 'child'].map((name) => readFile(resolve(root, name + '.txt'), 'utf8')),
      ),
    ).toEqual(before);
  } finally {
    await control.terminate(
      await control.descendants(childPid === null ? [parent.pid!] : [parent.pid!, childPid]),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('includes a detached child spawned after the first snapshot and prevents its delayed write', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'aw8-late-child-')));
  const marker = resolve(root, 'marker.txt');
  const trigger = resolve(root, 'trigger');
  const script = resolve(root, 'writer.cjs');
  await writeFile(marker, 'before');
  await writeFile(
    script,
    `
    const {spawn}=require('node:child_process');
    const {existsSync,writeFileSync}=require('node:fs');
    if(process.argv[2]==='child') {
      setInterval(()=>{if(existsSync(${JSON.stringify(trigger)})) writeFileSync(${JSON.stringify(marker)},'late')},10);
    } else {
      process.on('message',()=>{
        const child=spawn(process.execPath,[__filename,'child'],{detached:true,stdio:'ignore'});
        child.unref();process.send(child.pid);
      });
    }
    setTimeout(()=>process.exit(0),5000);
  `,
  );
  const parent = spawn(process.execPath, [script], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const control = new NativeWriterProcesses();
  let childPid: number | null = null;
  const observations: number[][] = [];
  const original = control.descendants.bind(control);
  vi.spyOn(control, 'descendants').mockImplementation(async (roots) => {
    const found = await original(roots);
    observations.push(found.map((p) => p.pid));
    return found;
  });
  let reads = 0;
  let lists = 0;
  try {
    const rpc = {
      completed: async () => {},
      request: async (method: string) => {
        if (method === 'thread/loaded/list') return { data: ['thread'], nextCursor: null };
        if (method === 'thread/backgroundTerminals/list')
          return { data: lists++ === 0 ? [{ processId: 'process', osPid: parent.pid! }] : [] };
        if (method === 'thread/read') {
          if (reads++ === 0) {
            childPid = await new Promise<number>((done, reject) => {
              parent.once('message', (pid) => done(Number(pid)));
              parent.once('error', reject);
              parent.send('spawn');
            });
            return { thread: { id: 'thread', turns: [{ id: 'turn', status: 'inProgress' }] } };
          }
          return { thread: { id: 'thread', turns: [] } };
        }
        return {};
      },
    };
    const receipt = await new AppServerWriters(rpc, control).stop(
      {
        thread: 'thread',
        turn: 'turn',
        complete: true,
        terminals: [{ process: 'process', pid: parent.pid! }],
        markers: [marker],
      },
      resolve(root, 'receipt.json'),
    );
    expect(observations[0]).toEqual([parent.pid]);
    const proof = JSON.parse(await readFile(receipt.locator, 'utf8')) as {
      processes: { pid: number }[];
    };
    expect(proof.processes.map((p) => p.pid)).toContain(childPid);
    expect(await original([parent.pid!, childPid!])).toEqual([]);
    await writeFile(trigger, 'write now');
    await control.wait(350);
    expect(await readFile(marker, 'utf8')).toBe('before');
  } finally {
    await control.terminate(
      await original(childPid === null ? [parent.pid!] : [parent.pid!, childPid]),
    );
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
