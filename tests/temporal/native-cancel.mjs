import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker } from '@temporalio/worker';
import { StdioAppServer } from '../../adapters/codex/appServerTransport.ts';
import { createReaderHost } from '../../dist/worker/readerHost.js';
import { bindTaskBackendClient } from '../../dist/client/taskBackend.js';
import {
  makeReaderCommand,
  startControlledReader,
  controlReader,
} from '../../dist/client/reader.js';
import { readerKey, readerTarget } from '../../dist/policy/readerControl.js';
import { artifactStore } from '../../dist/adapters/artifacts/files.js';

const model = process.argv[2];
assert.ok(model, 'Pass the explicitly authorized model');
const version = spawnSync('codex', ['--version'], { encoding: 'utf8' })
  .stdout.trim()
  .replace('codex-cli ', '');
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
mkdirSync(resolve(packageRoot, 'tmp/temporal-native'), { recursive: true });
mkdirSync(resolve(packageRoot, 'tmp/temporal-downloads'), { recursive: true });
const evidence = realpathSync(mkdtempSync(resolve(packageRoot, 'tmp/temporal-native/cancel-')));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aw-native-cancel-')));
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
let environment, rpc, handle;
let starts = 0,
  startedTurn = null;
const usage = [],
  started = Date.now();
try {
  mkdirSync(join(workspace, 'tasks'));
  writeFileSync(
    join(workspace, 'RULES.md'),
    'Read only. No network, helpers or changes. Report only observed facts.\n',
  );
  writeFileSync(
    join(workspace, 'reviewer.md'),
    'Review the task using the declared inputs only.\n',
  );
  writeFileSync(
    join(workspace, 'tasks/one.md'),
    '# Active cancellation qualification\nThis run will be stopped during LOAD. Do not implement anything.\n',
  );
  const project = {
    schemaVersion: 1,
    projectId: 'native-cancel',
    workspaceId: 'isolated',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
    checks: ['syntax'],
  };
  const input = {
    preparation: {
      schemaVersion: 1,
      project,
      taskId: 'one',
      hostId: 'mac',
      owner: 'user',
      generation: 1,
      revision: 1,
      card: 'tasks/one.md',
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
  const store = artifactStore(registration.artifactRoot);
  const save = (value) => store.publish(Buffer.from(JSON.stringify(value)));
  const target = readerTarget(input, readerKey(input));
  const proof = save({
    kind: 'initial-qualification-grant',
    target,
    model,
    effort: 'medium',
    allowed: 'one read-only turn, safety cancel during LOAD, temporary localhost only',
    userDecision:
      'Accepted limited T2/B1; selected gpt-6-astra / medium; total at most six starts, 45 minutes; temporary local service must stop',
    previousStarts: 3,
    maxAdditionalStarts: 1,
  });
  const authority = {
    async verify(c) {
      assert.equal(c.action, 'cancel');
      assert.equal(c.author, 'user');
      assert.deepEqual(c.target, target);
      assert.deepEqual(c.source, proof);
      return { origin: 'initial-grant', author: c.author, hash: c.hash, proof };
    },
  };
  rpc = new StdioAppServer(
    'codex',
    ['app-server', '--stdio'],
    workspace,
    join(evidence, 'rpc.jsonl'),
  );
  rpc.observe((message) => {
    if (message.method === 'thread/tokenUsage/updated') usage.push(message.params);
    if (message.method === 'turn/started') startedTurn = message.params;
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
  const port = {
    request(method, params) {
      if (method === 'turn/start') {
        assert.ok(starts < 1, 'Only one newly authorized cancellation test turn is allowed');
        starts++;
      }
      return rpc.request(method, params);
    },
    completed: (thread, turn, signal) => rpc.completed(thread, turn, signal),
  };
  const workflowsPath = resolve(packageRoot, 'dist/workflows/controlledReader.js');
  bindTaskBackendClient(environment.client, registration);
  const host = await createReaderHost(
    environment.nativeConnection,
    'native-cancel',
    workflowsPath,
    [{ registration, rpc: port, authority }],
    { model, effort: 'medium', clientVersion: version },
    join(evidence, 'host'),
    1,
  );
  let result, ack, primaryBefore, primaryAfter, history, latency;
  await environment.client.connection.withDeadline(Date.now() + 45_000, () =>
    host.runUntil(async () => {
      handle = await startControlledReader(environment.client, input, 'native-cancel');
      const deadline = Date.now() + 20_000;
      while (startedTurn === null) {
        assert.ok(Date.now() < deadline, 'No native active turn observed');
        await delay(20);
      }
      const { threadId, turn } = startedTurn;
      primaryBefore = save(await rpc.request('thread/read', { threadId, includeTurns: true }));
      const before = JSON.parse(store.read(primaryBefore).toString());
      assert.equal(before.thread.id, threadId);
      assert.equal(
        before.thread.turns.filter((t) => t.id === turn.id && t.status === 'inProgress').length,
        1,
      );
      const command = makeReaderCommand({
        schemaVersion: 1,
        commandId: 'qualification-cancel',
        target,
        expectedRevision: 0,
        author: 'user',
        action: 'cancel',
        attempt: 0,
        source: proof,
      });
      const requested = Date.now();
      ack = await controlReader(environment.client, readerKey(input), command);
      result = await handle.result();
      latency = Date.now() - requested;
      assert.equal(result.status, 'cancelled');
      assert.equal(starts, 1);
      primaryAfter = save(await rpc.request('thread/read', { threadId, includeTurns: true }));
      const after = JSON.parse(store.read(primaryAfter).toString());
      assert.equal(
        after.thread.turns.filter((t) => t.id === turn.id && t.status === 'interrupted').length,
        1,
      );
      assert.ok(
        after.thread.turns.every((t) => ['completed', 'failed', 'interrupted'].includes(t.status)),
      );
      const stop = JSON.parse(store.read(result.stop).toString());
      assert.equal(stop.confirmed, true);
      history = await handle.fetchHistory();
      writeFileSync(join(evidence, 'history.json'), JSON.stringify(history), { mode: 0o600 });
    }),
  );
  await Worker.runReplayHistory({ workflowsPath }, history, handle.workflowId);
  writeFileSync(
    join(evidence, 'report.json'),
    JSON.stringify({
      status: 'PASS',
      model,
      effort: 'medium',
      turns: starts,
      elapsedMs: Date.now() - started,
      cancelLatencyMs: latency,
      ack,
      result,
      startedTurn,
      primaryBefore,
      primaryAfter,
      usage,
      scope:
        'active native safety cancellation under initial grant; no cross-chat human RESUME qualification',
    }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ status: 'PASS', evidence, turns: starts, cancelLatencyMs: latency }),
  );
} catch (error) {
  if (handle)
    try {
      writeFileSync(join(evidence, 'history.json'), JSON.stringify(await handle.fetchHistory()), {
        mode: 0o600,
      });
    } catch (historyError) {
      writeFileSync(
        join(evidence, 'history-error.json'),
        JSON.stringify({ error: String(historyError) }),
        { mode: 0o600 },
      );
    }
  writeFileSync(
    join(evidence, 'report.json'),
    JSON.stringify({
      status: 'FAIL',
      model,
      turns: starts,
      elapsedMs: Date.now() - started,
      startedTurn,
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
