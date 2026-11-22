import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { connect } from 'node:net';
import { setTimeout, clearTimeout } from 'node:timers';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, Connection } from '@temporalio/client';
import { Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { createReaderHost } from '@krivega/agent-workflow/reader-host';
import { startReview } from '@krivega/agent-workflow/review';
import { bindTaskBackendClient } from '@krivega/agent-workflow/task-backend';
import { startLocalTask } from '@krivega/agent-workflow/local-task';
import { digest, simulatedReadItems } from './spec.mjs';
import { verifyPinnedBinary } from './safety.mjs';

const configuration = JSON.parse(readFileSync('full-consumer.json', 'utf8'));
const installed = realpathSync(resolve('node_modules/@krivega/agent-workflow'));
assert.equal(installed, resolve('node_modules/@krivega/agent-workflow'));
const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
assert.equal(digest(readFileSync('../runtime.tgz')), configuration.packageSha256);
for (const key of Object.keys(metadata.exports)) {
  const url = import.meta.resolve(metadata.name + key.slice(1));
  assert.ok(realpathSync(fileURLToPath(url)).startsWith(installed + sep));
  await import(url);
}
const installedModule = async (path) => {
  const file = realpathSync(join(installed, 'dist', path));
  assert.ok(file.startsWith(installed + sep));
  return import(pathToFileURL(file).href);
};
const { artifactStore } = await installedModule('adapters/artifacts/files.js');
const workspace = realpathSync(resolve('task'));
const artifacts = realpathSync(resolve('artifacts'));
const store = artifactStore(artifacts);
const record = (value) => store.publish(Buffer.from(JSON.stringify(value)));
const read = (ref) => JSON.parse(store.read(ref).toString());
const ref = (locator) => ({ locator, hash: digest(readFileSync(join(workspace, locator))) });
const project = JSON.parse(readFileSync(join(workspace, 'project.json'), 'utf8'));
const preparation = {
  schemaVersion: 1,
  project,
  taskId: 'installed-full',
  hostId: 'sdk-copy',
  owner: 'qualification',
  generation: 1,
  revision: 1,
  card: configuration.card,
};
const registration = {
  project,
  hostId: preparation.hostId,
  owner: preparation.owner,
  generation: 1,
  workspaceRoot: workspace,
  artifactRoot: artifacts,
  commands: Object.fromEntries(
    ['baseline', 'validate'].map((kind) => [
      kind,
      {
        executable: process.execPath,
        args: [resolve('check-client.mjs'), configuration.socket, kind, configuration.owner],
        timeoutMs: 1200000,
      },
    ]),
  ),
};
execFileSync('git', ['init', '--quiet'], { cwd: workspace });
const material = {
  schemaVersion: 1,
  kind: 'mechanical-material',
  materialId: 'installed-exact-repair',
  requirement: ref(preparation.card),
  links: configuration.links.map(ref),
  linksComplete: true,
  semanticDelta: false,
  files: [
    {
      path: configuration.owner,
      before: {
        content: store.publish(readFileSync(join(workspace, configuration.owner))),
        mode: statSync(join(workspace, configuration.owner)).mode & 0o777,
      },
      after: {
        source: ref('approved/owner.txt'),
        mode: statSync(join(workspace, configuration.owner)).mode & 0o777,
      },
    },
  ],
  checks: [...project.checks],
  criterion:
    'Restore the exact approved application bytes and pass the complete registered validation without extending scope',
};
writeFileSync(join(workspace, 'material.json'), JSON.stringify(material));
const request = {
  schemaVersion: 1,
  phase: 'acceptance',
  scope: material.materialId,
  sharedPaths: ['material.json', 'approved/owner.txt', ...configuration.links],
  roles: project.roles.map((role) => ({
    roleId: role.id,
    applies: true,
    reason:
      'Deterministic SDK exercise of the exact material and primary check receipts; no native acceptance claim',
    paths: [configuration.owner],
    complete: true,
    attestedBy: 'SDK fixture',
    discoveryRule: 'pinned application consumer inventory',
    history: { complete: true, answers: [] },
  })),
};
const acceptance = record(request);
const planningInput = {
  schemaVersion: 1,
  preparation,
  reviewId: 'installed-planning',
  request: record({ ...request, phase: 'planning' }),
};
const profile = { model: 'test-reader', effort: 'medium', clientVersion: '0.154.0' };
const threads = new Map();
let starts = 0;
const rpc = {
  async completed() {},
  async request(method, params) {
    if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
    if (method === 'model/list')
      return {
        data: [
          { model: profile.model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
        ],
      };
    if (method === 'thread/start' || method === 'thread/resume') {
      const thread = threads.get(params.threadId) ?? {
        id: 'simulated-' + (threads.size + 1),
        cwd: workspace,
        path: resolve('simulated-' + (threads.size + 1) + '.jsonl'),
        turns: [],
        forkedFromId: null,
        parentThreadId: null,
        projectId: null,
      };
      threads.set(thread.id, thread);
      return {
        cwd: workspace,
        model: profile.model,
        reasoningEffort: params.config.model_reasoning_effort,
        approvalPolicy: 'never',
        sandbox: { type: 'readOnly', networkAccess: false },
        thread: globalThis.structuredClone(thread),
      };
    }
    if (method === 'thread/read')
      return { thread: globalThis.structuredClone(threads.get(params.threadId)) };
    if (method === 'thread/loaded/list') return { data: [...threads.keys()], nextCursor: null };
    if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') {
      assert.ok(++starts <= 4, 'only four simulated review turns are permitted');
      const text = params.input[0].text;
      const offset = text.indexOf('Пути и хеши: ');
      let items;
      if (offset >= 0) {
        const refs = JSON.parse(
          text.slice(offset + 'Пути и хеши: '.length, text.indexOf('. Для больших', offset)),
        );
        items = refs.flatMap((ref) => simulatedReadItems(ref, readFileSync(ref.path, 'utf8')));
      } else {
        const begin = text.indexOf('Markdown: ') + 'Markdown: '.length;
        const report = JSON.parse(text.slice(begin, text.indexOf('. PASS несовместим', begin)));
        if (report.phase === 'acceptance')
          assert.equal(
            digest(readFileSync(join(workspace, configuration.owner))),
            configuration.approvedSha256,
          );
        Object.assign(report, {
          verdict: 'PASS',
          coverage: 'complete',
          findings: [],
          limitations: ['Deterministic SDK role; no model or native independent acceptance.'],
        });
        items = [{ type: 'agentMessage', text: JSON.stringify(report) }];
      }
      const thread = threads.get(params.threadId),
        turn = {
          id: 'turn-' + (thread.turns.length + 1),
          status: 'completed',
          items: [{ type: 'userMessage', content: params.input }, ...items],
        };
      thread.turns.push(turn);
      return { turn: { id: turn.id } };
    }
    throw new Error('Unsupported simulated RPC: ' + method);
  },
};
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
let environment, host, handle, result;
const queue = 'installed-' + project.projectId;
const workflowsPath = join(installed, 'dist/workflows/localTask.js');
const makeHost = () =>
  createReaderHost(
    environment.nativeConnection,
    queue,
    workflowsPath,
    [
      {
        registration,
        rpc,
        authority: {
          async verify() {
            throw new Error('No human/native command is authorized in this SDK exercise');
          },
        },
        localTasks: {
          profile,
          createRuntime() {
            throw new Error('M1 must never start a writer/model');
          },
        },
      },
    ],
    profile,
    resolve('host'),
    4,
  );
try {
  verifyPinnedBinary(configuration.temporalBinary, configuration.temporalBinarySha256);
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      dbFilename: resolve('temporal.sqlite'),
      executable: { type: 'existing-path', path: configuration.temporalBinary },
    },
  });
  host = await makeHost();
  bindTaskBackendClient(environment.client, registration);
  let taskInput;
  await host.runUntil(async () => {
    const planning = await startReview(environment.client, planningInput, queue);
    const admitted = await planning.result();
    assert.equal(admitted.complete, true);
    taskInput = {
      schemaVersion: 2,
      admission: {
        schemaVersion: 2,
        preparation,
        plan: { path: 'material.json', sha256: ref('material.json').hash },
        accepted: admitted.manifest,
        acceptance,
      },
      baseline: 'baseline',
    };
    handle = await startLocalTask(environment.client, taskInput, queue);
    result = await handle.result();
    assert.equal(result.status, 'done');
    assert.equal(read(result.result).complete, true);
    assert.equal(
      digest(readFileSync(join(workspace, configuration.owner))),
      configuration.approvedSha256,
    );
    writeFileSync(
      'result.json',
      JSON.stringify(
        {
          result,
          primary: read(result.result),
          simulatedTurns: starts,
          modelCalls: 0,
          nativeAcceptance: false,
        },
        null,
        2,
      ) + '\n',
    );
  });
  assert.equal(starts, 4);
  host = await makeHost();
  await host.runUntil(async () => {
    const connection = await Connection.connect({
      address: environment.client.connection.options.address,
    });
    try {
      const client = new Client({ connection });
      bindTaskBackendClient(client, registration);
      const recovered = client.workflow.getHandle(handle.workflowId);
      const status = await recovered.query('localTaskStatus');
      const recoveredInput = await recovered.query('localTaskInput');
      assert.equal(status.phase, 'done');
      assert.deepEqual(recoveredInput, taskInput);
      assert.deepEqual(await recovered.result(), result);
      await assert.rejects(startLocalTask(client, taskInput, queue));
      assert.equal(starts, 4, 'completed-result recovery must not start another simulated turn');
      writeFileSync(
        'recovery.json',
        JSON.stringify(
          {
            status,
            input: recoveredInput,
            result,
            simulatedTurns: starts,
            newWorker: true,
            newClient: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await connection.close();
    }
  });
  const bundle = await bundleWorkflowCode({ workflowsPath });
  const listing = await environment.client.workflowService.listWorkflowExecutions({
    namespace: 'default',
    query: "ExecutionStatus != 'Running'",
    pageSize: 100,
  });
  assert.equal(listing.nextPageToken?.length ?? 0, 0, 'history listing must be complete');
  mkdirSync('histories');
  let replayed = 0;
  for (const entry of listing.executions) {
    const id = entry.execution.workflowId;
    const history = await environment.client.workflow.getHandle(id).fetchHistory();
    writeFileSync(join('histories', digest(id) + '.json'), JSON.stringify(history));
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, id);
    replayed++;
  }
  assert.equal(replayed, 5);
  console.log(
    JSON.stringify({
      status: 'done',
      consumer: project.projectId,
      packageSha256: configuration.packageSha256,
      simulatedTurns: starts,
      modelCalls: 0,
      replayed,
      recovery: 'completed result with a new Worker/client; no new turn',
      pendingRecovery: false,
      nativeAcceptance: false,
      qualification: false,
    }),
  );
} catch (error) {
  writeFileSync(
    'failure.json',
    JSON.stringify(
      {
        status: 'failed',
        error: String(error),
        simulatedTurns: starts,
        modelCalls: 0,
        qualification: false,
        result,
      },
      null,
      2,
    ) + '\n',
  );
  if (environment) {
    try {
      const listing = await environment.client.workflowService.listWorkflowExecutions({
        namespace: 'default',
        pageSize: 100,
      });
      mkdirSync('histories', { recursive: true });
      for (const entry of listing.executions) {
        const id = entry.execution.workflowId;
        writeFileSync(
          join('histories', digest(id) + '.json'),
          JSON.stringify(await environment.client.workflow.getHandle(id).fetchHistory()),
        );
      }
    } catch (failure) {
      writeFileSync('history-export-error.json', JSON.stringify({ error: String(failure) }));
    }
  }
  throw error;
} finally {
  if (environment) {
    const address = environment.client.connection.options.address;
    await environment.teardown();
    const [host, port] = address.split(':');
    const listenerClosed = await new Promise((resolve) => {
      const socket = connect({ host, port: Number(port) });
      const finish = (closed) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(closed);
      };
      const timer = setTimeout(() => finish(false), 2000);
      socket.once('connect', () => finish(false));
      socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'));
    });
    writeFileSync(
      'stop.json',
      JSON.stringify({ address, listenerClosed, workerRunUntilClosed: true }, null, 2),
    );
    assert.equal(listenerClosed, true, 'Temporal listener must be stopped before cleanup');
  }
}
