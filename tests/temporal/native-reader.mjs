import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker } from '@temporalio/worker';
import { WorkflowIdReusePolicy } from '@temporalio/common';
// Only the qualification host reuses the existing narrow stdio transport, never its controller.
import { StdioAppServer } from '../../adapters/codex/appServerTransport.ts';
import { readerActivities } from '../../dist/activities/reader.js';
import { artifactStore } from '../../dist/adapters/artifacts/files.js';

const model = process.argv[2];
assert.ok(model, 'Pass the explicitly authorized model as the sole argument');
const version = spawnSync('codex', ['--version'], { encoding: 'utf8' })
  .stdout.trim()
  .replace('codex-cli ', '');
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
mkdirSync(resolve(packageRoot, 'tmp/temporal-native'), { recursive: true });
mkdirSync(resolve(packageRoot, 'tmp/temporal-downloads'), { recursive: true });
const evidence = realpathSync(mkdtempSync(resolve(packageRoot, 'tmp/temporal-native/read-')));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aw-native-reader-')));
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
let environment, rpc, handle;
let starts = 0;
const usage = [];
const started = Date.now();
try {
  mkdirSync(join(workspace, 'tasks'));
  writeFileSync(
    join(workspace, 'RULES.md'),
    'Read only. No network, helpers or changes. Report observed facts and missing evidence.\n',
  );
  writeFileSync(
    join(workspace, 'reviewer.md'),
    'You review the task against its stated acceptance criterion. Use only the declared inputs.\n',
  );
  writeFileSync(
    join(workspace, 'tasks/example.md'),
    '# Read-only qualification\nReport the two prohibitions in RULES.md: writes and network. No implementation is requested.\n',
  );
  const project = {
    schemaVersion: 1,
    projectId: 'native-reader',
    workspaceId: 'isolated',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
    checks: ['syntax'],
  };
  const input = {
    preparation: {
      schemaVersion: 1,
      taskId: 'read-1',
      project,
      hostId: 'mac',
      owner: 'user',
      generation: 1,
      revision: 1,
      card: 'tasks/example.md',
    },
    roleId: 'reviewer',
  };
  const registration = {
    project,
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    workspaceRoot: workspace,
    artifactRoot: join(evidence, 'artifacts'),
    commands: { syntax: { executable: 'node', args: ['--check'] } },
  };
  rpc = new StdioAppServer(
    'codex',
    ['app-server', '--stdio'],
    workspace,
    join(evidence, 'rpc.jsonl'),
  );
  rpc.observe((message) => {
    if (message.method === 'thread/tokenUsage/updated') usage.push(message.params);
  });
  await rpc.initialize();
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      executable: {
        type: 'cached-download',
        version: 'v1.9.1',
        downloadDir: resolve(packageRoot, 'tmp/temporal-downloads'),
      },
      dbFilename: join(evidence, 'temporal.sqlite'),
    },
  });
  const activities = readerActivities(
    registration,
    {
      request(method, params) {
        if (method === 'turn/start') {
          assert.ok(
            starts < 2,
            'The ordinary read qualification permits at most two model turn starts',
          );
          starts++;
        }
        return rpc.request(method, params);
      },
      completed(thread, turn, signal) {
        return rpc.completed(thread, turn, signal);
      },
    },
    { model, effort: 'medium', clientVersion: version },
    join(evidence, 'effects'),
  );
  const workflowsPath = resolve(packageRoot, 'dist/workflows/reader.js');
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: 'native-reader',
    workflowsPath,
    activities,
    maxConcurrentActivityTaskExecutions: 1,
  });
  await worker.runUntil(async () => {
    handle = await environment.client.workflow.start('ReaderWorkflow', {
      workflowId: 'aw/native-reader/read-1',
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      taskQueue: 'native-reader',
      args: [input],
    });
    const result = await handle.result();
    assert.equal(result.status, 'answered');
    const store = artifactStore(registration.artifactRoot);
    const answer = JSON.parse(store.read(result.answer).toString());
    const load = JSON.parse(store.read(answer.load).toString());
    assert.equal(load.observed.status, 'completed');
    assert.equal(answer.observed.status, 'completed');
    assert.equal(load.session, answer.session);
    const history = await handle.fetchHistory();
    writeFileSync(join(evidence, 'history.json'), JSON.stringify(history), { mode: 0o600 });
    await Worker.runReplayHistory({ workflowsPath }, history);
    writeFileSync(
      join(evidence, 'report.json'),
      JSON.stringify({
        status: 'PASS',
        scope: 'ordinary read route only; T2 fault/control qualification remains open',
        model,
        effort: 'medium',
        turns: starts,
        elapsedMs: Date.now() - started,
        result,
        session: answer.session,
        usage,
      }),
      { mode: 0o600 },
    );
  });
  for (const file of ['RULES.md', 'reviewer.md', 'tasks/example.md'])
    assert.equal(typeof readFileSync(join(workspace, file), 'utf8'), 'string');
  console.log(
    JSON.stringify({
      status: 'PASS',
      route: 'Temporal -> create -> observed LOAD -> primary answer -> replay',
      modelTurns: starts,
      evidence,
      elapsedMs: Date.now() - started,
    }),
  );
} catch (error) {
  if (handle)
    writeFileSync(join(evidence, 'history.json'), JSON.stringify(await handle.fetchHistory()), {
      mode: 0o600,
    });
  writeFileSync(
    join(evidence, 'report.json'),
    JSON.stringify({
      status: 'FAIL',
      model,
      effort: 'medium',
      turns: starts,
      elapsedMs: Date.now() - started,
      usage,
      error: String(error),
      cause: String(error.cause?.cause ?? error.cause),
    }),
    { mode: 0o600 },
  );
  console.error(JSON.stringify({ status: 'FAIL', evidence, turns: starts }));
  throw error;
} finally {
  rpc?.close();
  await environment?.teardown();
  rmSync(workspace, { recursive: true, force: true });
}
