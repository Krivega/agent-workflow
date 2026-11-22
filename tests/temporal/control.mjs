import assert from 'node:assert/strict';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker } from '@temporalio/worker';
import { createReaderHost } from '../../dist/worker/readerHost.js';
import { bindTaskBackendClient } from '../../dist/client/taskBackend.js';
import {
  makeReaderCommand,
  startControlledReader,
  controlReader,
} from '../../dist/client/reader.js';
import { readerKey, readerTarget } from '../../dist/policy/readerControl.js';
import { artifactStore, digest } from '../../dist/adapters/artifacts/files.js';
import { readReaderStatus } from '../../dist/client/readerStatus.js';

// Real Temporal scheduling and Activity cancellation; native Codex is an explicit test double.
mkdirSync(resolve('tmp/temporal-downloads'), { recursive: true });
const root = realpathSync(mkdtempSync(resolve('tmp/temporal-control-')));
const workspaces = realpathSync(mkdtempSync(join(tmpdir(), 'aw-control-workspaces-')));
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
const profile = { model: 'test-reader', effort: 'medium', clientVersion: '0.154.0' };
let environment;
const waits = [];
async function until(read, check) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    assert.ok(Date.now() < deadline, 'Timed out waiting for observed state');
    await delay(25);
  }
}
function fixture(id) {
  const workspace = join(workspaces, id);
  mkdirSync(join(workspace, 'tasks'), { recursive: true });
  for (const path of ['RULES.md', 'reviewer.md', 'tasks/one.md'])
    writeFileSync(join(workspace, path), path);
  const project = {
    schemaVersion: 1,
    projectId: id,
    workspaceId: 'main',
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
    artifactRoot: join(root, id + '-artifacts'),
    commands: { syntax: { executable: 'node', args: [] } },
  };
  const store = artifactStore(registration.artifactRoot),
    proof = store.publish(Buffer.from('Explicit test fixture, no real human authorization'));
  const thread = {
    id: id + '-session',
    cwd: workspace,
    forkedFromId: null,
    parentThreadId: null,
    projectId: null,
    turns: [],
  };
  let starts = 0;
  const rpc = {
    async request(method, params) {
      if (method === 'model/list')
        return {
          data: [
            { model: profile.model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
          ],
        };
      if (method === 'thread/start' || method === 'thread/resume')
        return {
          cwd: workspace,
          model: profile.model,
          reasoningEffort: 'medium',
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
          thread: globalThis.structuredClone(thread),
        };
      if (method === 'thread/loaded/list') return { data: [thread.id] };
      if (method === 'thread/read') return { thread: globalThis.structuredClone(thread) };
      if (method === 'turn/start') {
        const id = String(++starts);
        thread.turns.push({
          id,
          status: 'inProgress',
          items: [{ type: 'userMessage', content: params.input }],
        });
        return { turn: { id } };
      }
      if (method === 'turn/interrupt') {
        thread.turns.find((t) => t.id === params.turnId).status = 'interrupted';
        for (const waiter of waits.filter(
          (w) => w.thread === thread.id && w.turn === params.turnId,
        ))
          waiter.resolve();
        return {};
      }
      throw new Error('unexpected-rpc:' + method);
    },
    completed(session, turn) {
      if (thread.turns.find((t) => t.id === turn)?.status === 'interrupted')
        return Promise.resolve();
      return new Promise((resolve) => waits.push({ thread: session, turn, resolve }));
    },
  };
  const authority = {
    async verify(c) {
      if (c.commandId === 'denied') {
        await delay(50);
        throw new Error('explicit test authority denial');
      }
      return { origin: 'human', author: c.author, hash: c.hash, proof };
    },
  };
  const command = (action, revision, attempt = 0, id = action) =>
    makeReaderCommand({
      schemaVersion: 1,
      commandId: id,
      target: readerTarget(input, readerKey(input)),
      expectedRevision: revision,
      author: 'user',
      action,
      attempt,
      source: proof,
    });
  return { registration, rpc, authority, input, command, starts: () => starts, thread };
}
try {
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      executable: {
        type: 'cached-download',
        version: 'v1.9.1',
        downloadDir: resolve('tmp/temporal-downloads'),
      },
      dbFilename: join(root, 'temporal.sqlite'),
    },
  });
  const a = fixture('first'),
    b = fixture('second'),
    workflowsPath = resolve('dist/workflows/controlledReader.js');
  bindTaskBackendClient(environment.client, a.registration);
  bindTaskBackendClient(environment.client, b.registration);
  const host = await createReaderHost(
    environment.nativeConnection,
    'control-test',
    workflowsPath,
    [a, b],
    profile,
    join(root, 'host'),
    2,
  );
  const histories = [];
  let report;
  const waiting = await environment.client.workflow.start('ControlledReaderWorkflow', {
    workflowId: readerKey(a.input),
    taskQueue: 'control-test',
    args: [a.input],
  });
  const unavailable = await readReaderStatus(environment.client, waiting.workflowId);
  assert.equal(unavailable.diagnostic.kind, 'waiting-worker');
  writeFileSync(join(root, 'waiting-worker.json'), JSON.stringify(unavailable), { mode: 0o600 });
  await environment.client.connection.withDeadline(Date.now() + 45_000, () =>
    host.runUntil(async () => {
      const one = await startControlledReader(environment.client, a.input, 'control-test');
      await until(
        () => Promise.resolve(a.starts()),
        (n) => n === 1,
      );
      const two = await startControlledReader(environment.client, b.input, 'control-test');
      await until(
        () => two.query('readerStatus'),
        (s) => s.permit !== null,
      );
      assert.equal(b.starts(), 0);
      const queued = await readReaderStatus(environment.client, readerKey(b.input));
      assert.equal(queued.diagnostic.kind, 'waiting-worker');
      assert.ok(queued.pending.length > 0);
      const started = Date.now();
      const secondCancel = b.command('cancel', 0);
      await controlReader(environment.client, readerKey(b.input), secondCancel);
      assert.equal((await two.result()).status, 'cancelled');
      const latency = Date.now() - started;
      assert.ok(latency < 5_000, 'Control must not wait for the occupied model slot');
      const denied = a.command('pause', 0, 0, 'denied');
      await Promise.all([
        assert.rejects(controlReader(environment.client, readerKey(a.input), denied)),
        assert.rejects(controlReader(environment.client, readerKey(a.input), denied)),
      ]);
      assert.equal((await one.query('readerStatus')).revision, 0);
      const pause = a.command('pause', 0),
        ack = await controlReader(environment.client, readerKey(a.input), pause);
      assert.deepEqual(await controlReader(environment.client, readerKey(a.input), pause), ack);
      await assert.rejects(
        controlReader(
          environment.client,
          readerKey(a.input),
          makeReaderCommand({ ...pause, action: 'cancel' }),
        ),
      );
      await until(
        () => one.query('readerStatus'),
        (s) => s.mode === 'paused',
      );
      await assert.rejects(
        controlReader(environment.client, readerKey(a.input), a.command('cancel', 0)),
      );
      await controlReader(environment.client, readerKey(a.input), a.command('resume', 1, 1));
      await until(
        () => Promise.resolve(a.starts()),
        (n) => n === 2,
      );
      const projectRoot = join(root, 'host', digest(a.registration.project.projectId)),
        permissions = join(projectRoot, 'permissions'),
        folder = join(permissions, readdirSync(permissions)[0]),
        backup = join(root, 'dispatch-backup');
      cpSync(folder, backup, { recursive: true });
      rmSync(join(projectRoot, 'effects'), { recursive: true });
      for (const name of readdirSync(folder).filter((name) => name.startsWith('request-')))
        rmSync(join(folder, name));
      await controlReader(environment.client, readerKey(a.input), a.command('cancel', 2, 1));
      await until(
        () => one.query('readerStatus'),
        (s) => s.mode === 'blocked' && s.error.includes('reader-dispatch-journal-incomplete'),
      );
      assert.equal(a.thread.turns.at(-1).status, 'inProgress');
      assert.equal(a.starts(), 2);
      const blocked = await readReaderStatus(environment.client, readerKey(a.input));
      assert.equal(blocked.diagnostic.kind, 'unknown-effect');
      assert.equal(blocked.reader.operation.name, 'stop');
      const revoked = readFileSync(join(folder, 'permission.json'));
      rmSync(permissions, { recursive: true });
      await one.signal('readerReconcile');
      await until(
        () => one.query('readerStatus'),
        (s) => s.mode === 'blocked' && s.error.includes('ENOENT'),
      );
      assert.equal(a.thread.turns.at(-1).status, 'inProgress');
      cpSync(backup, folder, { recursive: true });
      writeFileSync(join(folder, 'permission.json'), revoked);
      const request = readdirSync(folder).find((name) => /^request-[a-f0-9]{64}$/u.test(name));
      writeFileSync(join(folder, request), '{}');
      await one.signal('readerReconcile');
      await until(
        () => one.query('readerStatus'),
        (s) => s.mode === 'blocked' && s.error.includes('reader-dispatch-corrupted'),
      );
      cpSync(join(backup, request), join(folder, request));
      await one.signal('readerReconcile');
      assert.equal((await one.result()).status, 'cancelled');
      assert.equal(a.thread.turns.at(-1).status, 'interrupted');
      assert.equal(a.starts() + b.starts(), 2);
      for (const [name, handle] of [
        ['first', one],
        ['second', two],
      ]) {
        const history = await handle.fetchHistory();
        histories.push({ history, workflowId: handle.workflowId });
        writeFileSync(join(root, name + '-history.json'), JSON.stringify(history), { mode: 0o600 });
      }
      report = {
        status: 'PASS',
        nativeModelStarts: 0,
        simulatedStarts: 2,
        controlLatencyMs: latency,
        projects: 2,
        modelSlots: 1,
        controlSlots: 1,
        journalLoss: ['dispatches-and-effects', 'all-permissions', 'corruption', 'exact-restore'],
        scope: 'real SDK scheduling, simulated native stop and human authority',
      };
    }),
  );
  for (const { history, workflowId } of histories)
    await Worker.runReplayHistory({ workflowsPath }, history, workflowId);
  writeFileSync(join(root, 'report.json'), JSON.stringify(report), { mode: 0o600 });
  console.log(
    JSON.stringify({
      status: 'PASS',
      root,
      scope:
        'two projects, occupied model slot, reserved controls, pause/resume/cancel, duplicate/stale/conflicting commands, replay',
      nativeModelStarts: 0,
    }),
  );
} catch (error) {
  writeFileSync(
    join(root, 'failure.json'),
    JSON.stringify({ status: 'FAIL', error: String(error), stack: error.stack }),
    { mode: 0o600 },
  );
  throw error;
} finally {
  await environment?.teardown();
  rmSync(workspaces, { recursive: true, force: true });
}
