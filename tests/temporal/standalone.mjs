import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, delimiter, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { sourceCheckouts, copyValidationCheckout } from './sourceCheckouts.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repository = realpathSync(process.env.AGENT_WORKFLOW_CONSUMER_ROOT ?? source);
const sourceRepositories = sourceCheckouts([repository, source]);
const copyParent = realpathSync(tmpdir());
for (const root of sourceRepositories)
  assert.ok(
    copyParent !== root && !copyParent.startsWith(root + sep),
    'Isolated copy must be outside sources',
  );
const copy = realpathSync(mkdtempSync(join(copyParent, 'aw-standalone-')));
mkdirSync(join(source, 'tmp'), { recursive: true });
const evidence = mkdtempSync(join(source, 'tmp/standalone-evidence-'));
let commandIndex = 0;
let completed = false;
console.log(JSON.stringify({ standaloneEvidence: evidence }));
assert.equal(
  process.platform,
  'darwin',
  'The qualified isolation profile currently requires macOS',
);
const policy = `(version 1) (allow default) ${sourceRepositories
  .map((root) => `(deny file-read* (subpath ${JSON.stringify(root)}))`)
  .join(' ')}`;
writeFileSync(
  join(evidence, 'source-isolation.json'),
  JSON.stringify({ sourceRepositories, policy }),
);
// macOS rejects setuid /bin/ps under Seatbelt, including an allow-default policy.
// Keep all tests isolated; the outside observer exposes only the two fixed, data-only ps formats.
const socket = join(copy, 'ps-observer.sock'),
  bin = join(copy, 'test-bin');
let observer;
try {
  copyValidationCheckout(source, copy);
  mkdirSync(bin);
  writeFileSync(join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  observer = spawn(
    process.execPath,
    [
      '-e',
      `const net=require('node:net'),{execFile}=require('node:child_process');const allowed=[['-axo','pid=,ppid=,stat=,lstart='],['-axo','pgid=,pid=']];net.createServer(c=>{let data='';c.on('data',chunk=>{data+=chunk;if(data.length>1024){c.destroy();return;}let args;try{args=JSON.parse(data);}catch{return;}if(!allowed.some(a=>JSON.stringify(a)===JSON.stringify(args))){c.end(JSON.stringify({code:2,stdout:'',stderr:'unsupported process query'}));return;}execFile('/bin/ps',args,{maxBuffer:4*1024*1024},(error,stdout,stderr)=>c.end(JSON.stringify({code:error?1:0,stdout,stderr})));});}).listen(process.argv[1],()=>process.stdout.write('ready'));`,
      socket,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise((resolve, reject) => {
    observer.stdout.once('data', resolve);
    observer.once('error', reject);
    observer.once('exit', () => reject(new Error('process observer exited')));
  });
  writeFileSync(
    join(bin, 'ps'),
    `#!${process.execPath}\nconst net=require('node:net');const c=net.connect(${JSON.stringify(socket)});let data='';c.on('connect',()=>c.write(JSON.stringify(process.argv.slice(2))));c.on('data',chunk=>data+=chunk);c.on('end',()=>{const r=JSON.parse(data);process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.code;});c.on('error',e=>{process.stderr.write(String(e));process.exitCode=1;});\n`,
    { mode: 0o700 },
  );
  mkdirSync(join(copy, 'tmp/temporal-downloads'), { recursive: true });
  cpSync(
    join(source, 'tmp/temporal-downloads/temporal-v1.9.1'),
    join(copy, 'tmp/temporal-downloads/temporal-v1.9.1'),
  );
  const temporalBinarySha256 = createHash('sha256')
    .update(readFileSync(join(copy, 'tmp/temporal-downloads/temporal-v1.9.1')))
    .digest('hex');
  for (const name of ['basic', 'can'])
    writeFileSync(
      join(copy, 'tmp/task-execution-' + name + '.json'),
      JSON.stringify({
        evidence: join(copy, 'tmp/task-execution-sdk-' + name),
        temporalBinarySha256,
      }),
    );
  function run(command, args) {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, command, ...args], {
      cwd: copy,
      encoding: 'utf8',
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH },
    });
    const label = String(++commandIndex).padStart(2, '0') + '-' + args[0];
    writeFileSync(join(evidence, label + '.stdout.log'), result.stdout ?? '');
    writeFileSync(join(evidence, label + '.stderr.log'), result.stderr ?? '');
    writeFileSync(
      join(evidence, label + '.json'),
      JSON.stringify({ command, args, status: result.status, signal: result.signal }),
    );
    const coverage = join(copy, 'coverage/lcov.info');
    if (args[0] === 'validate' && (result.status === 0 || existsSync(coverage))) {
      const destination = join(evidence, 'lcov.info');
      cpSync(coverage, destination);
      assert.ok(readFileSync(destination).equals(readFileSync(coverage)));
    }
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  for (const root of sourceRepositories) {
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const forbidden = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', policy, '/bin/cat', join(root, 'package.json')],
      { cwd: copy, encoding: 'utf8' },
    );
    assert.notEqual(
      forbidden.status,
      0,
      'The isolation profile must actually deny access to the source repository: ' + root,
    );
    assert.match(forbidden.stderr, /Operation not permitted/u);
  }
  const rejected = spawnSync(join(bin, 'ps'), ['unsupported'], { encoding: 'utf8' });
  assert.equal(
    rejected.status,
    2,
    'Process observer must reject other arguments: ' + rejected.stderr,
  );
  run('yarn', [
    'install',
    '--frozen-lockfile',
    '--offline',
    '--non-interactive',
    '--ignore-scripts',
  ]);
  run('yarn', ['validate']);
  run('yarn', ['test:replay']);
  run('yarn', ['test:backup']);
  run('yarn', ['test:legacy-archive']);
  run('yarn', ['test:retention']);
  run('yarn', ['test:postgres-restore:self']);
  run('yarn', ['test:pg-temporal-recovery:self']);
  run('yarn', ['test:temporal-restore:self']);
  run('yarn', ['test:audit']);
  run('yarn', ['test:local-task']);
  run('yarn', ['test:mechanical-task']);
  run('yarn', ['test:substantial-task']);
  run('yarn', ['test:supervised-task']);
  run('yarn', ['test:supervised-cancel']);
  run('yarn', ['test:stage-supervised-task']);
  run('yarn', ['test:stage-supervised-cancel']);
  run('yarn', ['test:progress-task']);
  run('yarn', ['test:progress-doubt']);
  run('yarn', ['test:progress-cancel']);
  run('yarn', ['test:progress-held']);
  run('yarn', ['test:progress-partial']);
  run('yarn', ['test:continuation']);
  run('yarn', ['test:requirements']);
  run('yarn', ['test:task-execution', '--run', join(copy, 'tmp/task-execution-basic.json')]);
  run('yarn', ['test:task-execution', '--run-can', join(copy, 'tmp/task-execution-can.json')]);
  run('yarn', ['test:finalization']);
  run('yarn', ['test:finalization-cancel-before']);
  run('yarn', ['test:finalization-cancel-after']);
  run('yarn', ['test:finalization-timeout-cancel']);

  run('yarn', ['test:correction']);
  run('yarn', ['test:arbitration']);
  run('yarn', ['test:initial-conflict']);
  completed = true;
} finally {
  if (observer && observer.exitCode === null && observer.signalCode === null) {
    const exited = new Promise((resolve) => observer.once('exit', resolve));
    observer.kill('SIGTERM');
    await exited;
  }
  let exported = false;
  try {
    const runtime = join(copy, 'tmp');
    if (existsSync(runtime))
      for (const name of readdirSync(runtime))
        if (name !== 'temporal-downloads')
          cpSync(join(runtime, name), join(evidence, 'runtime-tmp', name), { recursive: true });
    if (completed)
      for (const name of ['basic', 'can']) {
        const report = join('tmp', 'task-execution-sdk-' + name, 'report.json');
        assert.ok(
          readFileSync(join(copy, report)).equals(
            readFileSync(
              join(evidence, 'runtime-tmp', 'task-execution-sdk-' + name, 'report.json'),
            ),
          ),
          'Primary SDK report must survive standalone cleanup',
        );
      }
    writeFileSync(
      join(evidence, 'runtime-export.json'),
      JSON.stringify({
        source: runtime,
        destination: join(evidence, 'runtime-tmp'),
        excluded: ['temporal-downloads'],
        copyCompleted: true,
        byteVerifiedSdkReports: completed ? ['basic', 'can'] : [],
        activationAllowed: false,
      }),
    );
    exported = true;
  } catch (error) {
    writeFileSync(join(evidence, 'export-error.json'), JSON.stringify({ error: String(error) }));
    process.exitCode = 1;
  }
  if (completed && exported) {
    rmSync(copy, { recursive: true });
    console.log(
      'PASS: standalone frozen installation, build, all tests, 100% coverage, replay and SDK with OS-enforced denial of both source repositories; primary runtime evidence exported',
    );
  } else {
    writeFileSync(
      join(evidence, 'retained-copy.json'),
      JSON.stringify({ copy, completed, exported }),
    );
    console.log(JSON.stringify({ retainedCopy: copy, completed, exported }));
  }
}
