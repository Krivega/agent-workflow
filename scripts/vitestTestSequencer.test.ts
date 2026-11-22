import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { usesExternalTools } from './vitestToolDependencies.mjs';

const directories: string[] = [];
const vitestCli = resolve('node_modules/vitest/vitest.mjs');
const sequencer = resolve('scripts/vitestTestSequencer.mjs');
const runner = resolve('scripts/vitestToolAwarePool.mjs');

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(names: readonly string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vitest-sequence-')));
  directories.push(root);
  const paths = names.map((name, index) => {
    const path = join(root, `${name}.test.js`);
    writeFileSync(
      path,
      `${name.startsWith('tool') ? "import {spawnSync} from 'node:child_process';\n" : ''}/*${'x'.repeat(index * 7)}*/\ntest('fixture',()=>expect(true).toBe(true));\n`,
    );
    return path;
  });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const config = join(root, 'vitest.config.mjs');
  writeFileSync(
    config,
    `import pool from ${JSON.stringify(runner)};import Sequencer from ${JSON.stringify(sequencer)};export default {cacheDir:${JSON.stringify(join(root, 'cache'))},test:{root:${JSON.stringify(root)},globals:true,sequence:{sequencer:Sequencer},environment:'node',include:['*.test.js'],coverage:{provider:'istanbul'},pool}};\n`,
  );
  // Child fixtures own their worker budget; keep the parent validation limit out of them.
  const childEnvironment = { ...process.env };
  delete childEnvironment.VITEST_MAX_WORKERS;
  const run = (args: string[], serial = true) =>
    spawnSync(
      process.execPath,
      [vitestCli, 'run', '--config', config, ...(serial ? ['--maxWorkers=1'] : []), ...args],
      { encoding: 'utf8', env: childEnvironment },
    );
  const listing = join(root, 'order.jsonl');
  const reporter = join(root, 'order-reporter.mjs');
  writeFileSync(
    reporter,
    `import {appendFileSync} from 'node:fs';export default class {onTestModuleStart(module){appendFileSync(${JSON.stringify(listing)},JSON.stringify(module.moduleId)+'\\n')}}`,
  );
  const list = (args: string[] = [], expectedExitCode = 0): string[] => {
    writeFileSync(listing, '');
    const result = run(['--reporter', reporter, ...args]);
    expect(result.status).toBe(expectedExitCode);
    return z.array(z.string()).parse(
      readFileSync(listing, 'utf8')
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line)),
    );
  };
  return { root, paths, run, list };
}

it('preserves caller imports and environment in real CPU and tool workers while protecting ARM64', () => {
  const f = fixture(['tool-flags', 'cpu-flags']);
  const marker = join(f.root, 'worker-import.mjs');
  writeFileSync(marker, "globalThis.td057WorkerImport = 'caller-import';\n");
  const config = join(f.root, 'vitest.config.mjs');
  writeFileSync(
    config,
    readFileSync(config, 'utf8').replace(
      "environment:'node'",
      `environment:'node',execArgv:['--import',${JSON.stringify(marker)}],env:{TD057_WORKER_ENV:'caller-env'}`,
    ),
  );
  for (const file of f.paths) {
    const tool = basename(file).startsWith('tool');
    writeFileSync(
      file,
      `${tool ? "import {spawnSync} from 'node:child_process';" : ''}
test('worker arguments',()=>{
 expect(globalThis.td057WorkerImport).toBe('caller-import');
 expect(process.env.TD057_WORKER_ENV).toBe('caller-env');
 expect(process.execArgv).toContain('--import');
 expect(process.execArgv).toContain(${JSON.stringify(marker)});
 expect(process.execArgv.includes('--no-sparkplug')).toBe(process.arch==='arm64');
 ${tool ? "expect(spawnSync(process.execPath,['-e','']).status).toBe(0);" : ''}
});`,
    );
  }
  const result = f.run([]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it('copies ARM64 worker arguments without changing x64 arguments or the original options', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict';
import pool from ${JSON.stringify(runner)};
const ctx={config:{coverage:{enabled:true},maxWorkers:2},logger:{outputStream:process.stdout,errorStream:process.stderr}};
const options={project:{vitest:ctx},distPath:'.',execArgv:['--conditions=caller'],env:{CALLER_ENV:'retained'}};
for(const arch of ['arm64','x64']) {
 Object.defineProperty(process,'arch',{value:arch});
 const worker=pool.createPoolWorker(options);
 assert.deepEqual(worker.execArgv,arch==='arm64'?['--conditions=caller','--no-sparkplug']:['--conditions=caller']);
 assert.equal(worker.env,options.env);
 assert.deepEqual(options.execArgv,['--conditions=caller']);
}
console.log('architecture scope and caller options preserved');
`,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('architecture scope and caller options preserved');
});

it('mixes real CLI suites with CPU work, retaining every test and both native shards', () => {
  const f = fixture(['tool-a', 'tool-b', 'cpu-a', 'cpu-b', 'cpu-c', 'cpu-d']);
  const all = f.list();
  expect(all.map((path) => basename(path).startsWith('tool'))).toEqual([
    true,
    false,
    false,
    true,
    false,
    false,
  ]);
  expect(all).toHaveLength(f.paths.length);
  expect(new Set(all)).toEqual(new Set(f.paths));
  const first = f.list(['--shard=1/2']);
  const second = f.list(['--shard=2/2']);
  expect(first).toHaveLength(3);
  expect(second).toHaveLength(3);
  expect(first.some((path) => second.includes(path))).toBe(false);
  expect(new Set([...first, ...second])).toEqual(new Set(all));
});

it('keeps a previously failed CPU suite first through the real Vitest performance cache', () => {
  const f = fixture(['tool-a', 'cpu-failing', 'cpu-a']);
  const failing = f.paths[1]!;
  writeFileSync(failing, "test('fixture',()=>expect(false).toBe(true));\n");
  expect(f.run([]).status).toBe(1);
  const all = f.list([], 1);
  expect(all[0]).toBe(failing);
  expect(all).toHaveLength(f.paths.length);
  expect(new Set(all)).toEqual(new Set(f.paths));
});

it('defers marked native tools, keeping all files and the failed-suite order in each group', () => {
  const f = fixture(['tool-a', 'tool-deferred', 'cpu-a']);
  const deferred = f.paths[1]!;
  writeFileSync(
    deferred,
    "// @vitest-defer: expensive native tools\nimport {spawnSync} from 'node:child_process';\ntest('fixture',()=>expect(false).toBe(true));\n",
  );
  expect(f.run([]).status).toBe(1);
  const all = f.list([], 1);
  expect(all.at(-1)).toBe(deferred);
  expect(new Set(all)).toEqual(new Set(f.paths));
  writeFileSync(deferred, readFileSync(deferred, 'utf8').replace('expect(false)', 'expect(true)'));
  const first = f.list(['--shard=1/2']);
  const second = f.list(['--shard=2/2']);
  expect(first.some((path) => second.includes(path))).toBe(false);
  expect(new Set([...first, ...second])).toEqual(new Set(all));
});

it.each(['tool', 'cpu'])('retains an entire homogeneous %s collection', (kind) => {
  const f = fixture([`${kind}-a`, `${kind}-b`, `${kind}-c`]);
  const all = f.list();
  expect(all).toHaveLength(f.paths.length);
  expect(new Set(all)).toEqual(new Set(f.paths));
});

it('continues queued tools after a real worker exits while preserving the original failure', () => {
  const f = fixture(['tool-crash', 'tool-next']);
  const events = join(f.root, 'events.txt');
  writeFileSync(
    f.paths[0]!,
    `import {spawnSync} from 'node:child_process';import {appendFileSync} from 'node:fs';
test('crash',()=>{appendFileSync(${JSON.stringify(events)},'crash\\n');process.kill(process.pid,'SIGKILL')});`,
  );
  writeFileSync(
    f.paths[1]!,
    `// @vitest-defer: must follow the crashing tool
import {spawnSync} from 'node:child_process';import {appendFileSync,readFileSync} from 'node:fs';
test('next tool',()=>{expect(readFileSync(${JSON.stringify(events)},'utf8')).toBe('crash\\n');expect(spawnSync(process.execPath,['-e','']).status).toBe(0);appendFileSync(${JSON.stringify(events)},'next\\n')});`,
  );
  // A timed-out diagnostic must not leave its waiting worker behind.
  const cleanup = join(f.root, 'parent-disconnect.mjs');
  writeFileSync(
    cleanup,
    "const exit=process.exit.bind(process);process.once('disconnect',()=>exit(0));",
  );
  const config = join(f.root, 'vitest.config.mjs');
  writeFileSync(
    config,
    readFileSync(config, 'utf8').replace(
      "environment:'node'",
      `environment:'node',execArgv:['--import',${JSON.stringify(cleanup)}]`,
    ),
  );
  const result = spawnSync(process.execPath, [vitestCli, 'run', '--config', config], {
    encoding: 'utf8',
    env: { ...process.env, VITEST_MAX_WORKERS: '1' },
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Worker exited unexpectedly with signal SIGKILL');
  expect(readFileSync(events, 'utf8')).toBe('crash\nnext\n');
}, 20_000);

it('retires exited or stopped queued workers and frees each acquired slot only once', () => {
  const f = fixture(['tool-input']);
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import pool from ${JSON.stringify(runner)};
const request={type:'run',context:{files:[{filepath:${JSON.stringify(f.paths[0])}}]}};
for(const terminal of ['exit','stop']) {
 const ctx={config:{coverage:{enabled:true},maxWorkers:1},logger:{outputStream:process.stdout,errorStream:process.stderr}};
 async function create() {
  const worker=pool.createPoolWorker({project:{vitest:ctx},distPath:'.',execArgv:[],env:{}});
  const child=new EventEmitter();child.sent=[];child.send=message=>child.sent.push(message);
  child.kill=()=>{child.exitCode=0;child.emit('exit',0,null)};
  worker._fork=child;await worker.start();return {worker,child};
 }
 const active=await create(),queued=await create();
 active.worker.send(request);queued.worker.send(request);
 assert.equal(active.worker.budget.active,1);assert.equal(active.worker.budget.queue.length,1);
 if(terminal==='exit')queued.child.emit('exit',17,null);else await queued.worker.stop();
 assert.equal(queued.worker.stopped,true);assert.equal(queued.worker.pending,undefined);
 assert.equal(active.worker.budget.queue.length,0);assert.equal(active.worker.budget.active,1);
 const next=await create();next.worker.send(request);
 active.child.emit('exit',17,null);
 assert.equal(next.child.sent.length,1);assert.equal(queued.child.sent.length,0);
 assert.equal(active.worker.budget.active,1);
 active.child.emit('exit',17,null);active.worker.free();
 assert.equal(active.worker.budget.active,1);
 next.child.emit('message',{__vitest_worker_response__:true,type:'testfileFinished'});
 await next.worker.stop();next.worker.free();
 assert.equal(active.worker.budget.active,0);assert.equal(active.worker.budget.queue.length,0);
}
console.log('terminal cleanup and idempotent release passed');
`,
    ],
    { encoding: 'utf8', env: { ...process.env, VITEST_MAX_WORKERS: '1' } },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('terminal cleanup and idempotent release passed');
});

it('follows imported helpers, reexports, require and literal dynamic imports through cycles', () => {
  const f = fixture(['cpu-entry']);
  const entry = f.paths[0]!;
  const first = join(f.root, 'first.ts');
  const second = join(f.root, 'second.ts');
  writeFileSync(entry, "import './first.js';");
  writeFileSync(first, "export * from './second.js';");
  writeFileSync(second, "import './first.js';");
  expect(usesExternalTools(entry)).toBe(false);
  for (const code of [
    "import 'node:child_process';",
    "require('child_process');",
    "import('node:child_process');",
  ]) {
    writeFileSync(second, `import './first.js'; ${code}`);
    expect(usesExternalTools(entry)).toBe(true);
    expect(usesExternalTools(first)).toBe(true);
    expect(usesExternalTools(second)).toBe(true);
  }
  writeFileSync(second, "const example = 'node:child_process';");
  expect(usesExternalTools(entry)).toBe(false);
});

it.each([
  [false, 3, 4],
  [true, 3, 4],
  [true, 1, 2],
] as const)(
  'limits native tools alongside CPU work (coverage %s, %i slots, %i workers)',
  (coverage, toolSlots, workers) => {
    const f = fixture(['tool-a', 'tool-b', 'tool-c', 'cpu-a', 'cpu-b']);
    const common = `
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';const __dirname=path.dirname(fileURLToPath(import.meta.url));
const mark=(name)=>path.join(__dirname,name);
const pause=()=>new Promise(done=>setTimeout(done,20));
const waitFor=async(name)=>{for(let i=0;i<150;i++){if(fs.existsSync(mark(name)))return;await pause()}throw new Error('Parallel group did not start: '+name)};
`;
    for (const file of f.paths) {
      const tool = basename(file).startsWith('tool');
      writeFileSync(
        file,
        common +
          (tool
            ? `
import {spawnSync} from 'node:child_process';
test('tool',async()=>{
 let slot;
 for(let i=0;i<${toolSlots};i++){try{slot=mark('tool-slot-'+i);fs.mkdirSync(slot);break}catch(error){slot=undefined;if(error.code!=='EEXIST')throw error}}
 if(slot===undefined)throw new Error('Too many concurrent native tools');
 try{fs.writeFileSync(mark('tool-started'),'');await waitFor('cpu-started');await pause();expect(spawnSync(process.execPath,['-e','']).status).toBe(0)}finally{fs.rmdirSync(slot)}
});`
            : `test('cpu',async()=>{fs.writeFileSync(mark('cpu-started'),'');await waitFor('tool-started');await pause()});`),
      );
    }
    writeFileSync(
      join(f.root, 'native-helper.js'),
      "export {spawnSync} from 'node:child_process';",
    );
    const indirect = f.paths[2]!;
    writeFileSync(
      indirect,
      readFileSync(indirect, 'utf8').replace(
        "import {spawnSync} from 'node:child_process';",
        "import {spawnSync} from './native-helper.js';",
      ),
    );
    const report = join(f.root, 'result.json');
    expect(
      f.run(
        [
          `--maxWorkers=${workers}`,
          '--reporter=json',
          '--outputFile',
          report,
          ...(coverage ? ['--coverage'] : []),
        ],
        false,
      ).status,
    ).toBe(0);
    expect(
      z
        .object({
          numTotalTests: z.literal(5),
          numPassedTests: z.literal(5),
          numFailedTests: z.literal(0),
        })
        .parse(JSON.parse(readFileSync(report, 'utf8'))),
    ).toEqual({ numTotalTests: 5, numPassedTests: 5, numFailedTests: 0 });
  },
);

it('starts every CPU file while native slots await it, without filling workers with queued tools', () => {
  const f = fixture([
    'tool-a',
    'tool-b',
    'tool-c',
    'tool-d',
    ...Array.from({ length: 8 }, (_, index) => `cpu-${index}`),
  ]);
  for (const file of f.paths) {
    const tool = basename(file).startsWith('tool');
    writeFileSync(
      file,
      `
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';const root=path.dirname(fileURLToPath(import.meta.url));
${tool ? "import {spawnSync} from 'node:child_process';" : ''}
test('resource scheduling',async()=>{
${
  tool
    ? `
for(let step=0;step<200;step++){
 if(fs.readdirSync(root).filter(name=>name.startsWith('ready-cpu-')).length===8){expect(spawnSync(process.execPath,['-e','']).status).toBe(0);return}
 await new Promise(done=>setTimeout(done,10));
}
throw new Error('CPU files were starved by queued native tools');`
    : `fs.writeFileSync(path.join(root,'ready-${basename(file)}'),'');`
}
});
`,
    );
  }
  expect(f.run(['--maxWorkers=4', '--coverage'], false).status).toBe(0);
});
