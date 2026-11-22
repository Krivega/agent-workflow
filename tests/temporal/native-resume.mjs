import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  artifactStore,
  readPrivateFile,
  publishFile,
} from '../../dist/adapters/artifacts/files.js';
import { nativeReaderAuthority } from '../../dist/adapters/codex/readerAuthority.js';

// Qualification only: actual human issuer is another existing native chat; no simulated grant for RESUME.
const [model, grantFile] = process.argv.slice(2);
assert.ok(model && grantFile, 'Pass the authorized model and an absolute qualification grant file');
const grant = JSON.parse(readPrivateFile(grantFile).toString('utf8'));
assert.equal(grant.previousStarts, 4);
assert.equal(grant.maxAdditionalStarts, 2);
const version = spawnSync('codex', ['--version'], { encoding: 'utf8' })
  .stdout.trim()
  .replace('codex-cli ', '');
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
mkdirSync(resolve(packageRoot, 'tmp/temporal-native'), { recursive: true });
mkdirSync(resolve(packageRoot, 'tmp/temporal-downloads'), { recursive: true });
const evidence = realpathSync(mkdtempSync(resolve(packageRoot, 'tmp/temporal-native/resume-')));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aw-native-resume-')));
const record = (file, value) =>
  publishFile(join(evidence, file), Buffer.from(JSON.stringify(value)));
const started = Date.now(),
  startedTurns = [],
  usage = [];
let environment,
  rpc,
  handle,
  starts = 0;
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
async function until(read, accept, timeout = 20_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < end, 'Qualification wait timed out');
    await delay(25);
  }
}
try {
  mkdirSync(join(workspace, 'tasks'));
  writeFileSync(
    join(workspace, 'RULES.md'),
    'Read only. No network, helpers or changes. Report observed facts only.\n',
  );
  writeFileSync(
    join(workspace, 'reviewer.md'),
    'Use only the declared inputs. The host may pause and interrupt this qualification.\n',
  );
  writeFileSync(
    join(workspace, 'tasks/one.md'),
    '# Human resume qualification\nThe original session must survive a pause and an authorized resume. Do not implement anything.\n',
  );
  const project = {
    schemaVersion: 1,
    projectId: 'native-resume',
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
  const store = artifactStore(registration.artifactRoot),
    save = (v) => store.publish(Buffer.from(JSON.stringify(v)));
  const target = readerTarget(input, readerKey(input));
  const initial = save({
    kind: 'initial-T2-qualification-grant',
    target,
    model,
    effort: 'medium',
    grant,
    allowed: 'two read-only starts; safety pause and cancel; human RESUME verified separately',
  });
  const native = nativeReaderAuthority(store, grant.issuer);
  const authority = {
    async verify(c) {
      if (c.source.sha256 === initial.sha256) {
        assert.deepEqual(c.source, initial);
        assert.ok(c.action === 'pause' || c.action === 'cancel');
        assert.deepEqual(c.target, target);
        assert.equal(c.author, 'user');
        return { origin: 'initial-grant', author: c.author, hash: c.hash, proof: initial };
      }
      assert.equal(c.action, 'resume');
      return native.verify(c);
    },
  };
  rpc = new StdioAppServer(
    'codex',
    ['app-server', '--stdio'],
    workspace,
    join(evidence, 'rpc.jsonl'),
  );
  rpc.observe((message) => {
    if (message.method === 'turn/started') startedTurns.push(message.params);
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
  const port = {
    request(method, params) {
      if (method === 'turn/start') {
        assert.ok(
          starts < 2,
          'The shared qualification budget permits at most two additional turn starts',
        );
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
    'native-resume',
    workflowsPath,
    [{ registration, rpc: port, authority }],
    { model, effort: 'medium', clientVersion: version },
    join(evidence, 'host'),
    2,
  );
  let history, summary;
  await environment.client.connection.withDeadline(Date.now() + 120_000, () =>
    host.runUntil(async () => {
      handle = await startControlledReader(environment.client, input, 'native-resume');
      const first = await until(() => Promise.resolve(startedTurns[0]), Boolean);
      const firstPrimary = await rpc.request('thread/read', {
        threadId: first.threadId,
        includeTurns: true,
      });
      assert.equal(
        firstPrimary.thread.turns.find((t) => t.id === first.turn.id)?.status,
        'inProgress',
      );
      const pause = makeReaderCommand({
        schemaVersion: 1,
        commandId: 'qualification-pause',
        target,
        expectedRevision: 0,
        author: 'user',
        action: 'pause',
        attempt: 0,
        source: initial,
      });
      const pauseAck = await controlReader(environment.client, readerKey(input), pause);
      const paused = await until(
        () => handle.query('readerStatus'),
        (s) => s.mode === 'paused',
      );
      assert.equal(paused.revision, 1);
      assert.equal(paused.session, first.threadId);
      assert.notEqual(first.threadId, grant.issuer.threadId);
      record('paused-state.json', {
        status: 'paused',
        target,
        session: first.threadId,
        revision: 1,
        attempt: 0,
        issuer: grant.issuer,
        source: grant.source,
        artifactRoot: registration.artifactRoot,
      });
      console.log(
        JSON.stringify({
          status: 'PAUSED',
          evidence,
          modelStarts: starts,
          session: first.threadId,
        }),
      );
      const delivery = join(evidence, 'resume-delivery.json');
      await until(() => Promise.resolve(existsSync(delivery)), Boolean, 90_000);
      const command = JSON.parse(
        store.read(JSON.parse(readPrivateFile(delivery).toString())).toString(),
      );
      assert.equal(command.action, 'resume');
      assert.deepEqual(command.target, target);
      assert.equal(command.expectedRevision, 1);
      assert.equal(command.attempt, 1);
      const resumedAt = Date.now(),
        resumeAck = await controlReader(environment.client, readerKey(input), command);
      assert.deepEqual(
        await controlReader(environment.client, readerKey(input), command),
        resumeAck,
      );
      const second = await until(() => Promise.resolve(startedTurns[1]), Boolean);
      assert.equal(second.threadId, first.threadId);
      assert.notEqual(second.turn.id, first.turn.id);
      const duringResume = save(
        await rpc.request('thread/read', { threadId: second.threadId, includeTurns: true }),
      );
      const cancel = makeReaderCommand({
        schemaVersion: 1,
        commandId: 'qualification-cancel',
        target,
        expectedRevision: 2,
        author: 'user',
        action: 'cancel',
        attempt: 1,
        source: initial,
      });
      const cancelAck = await controlReader(environment.client, readerKey(input), cancel),
        result = await handle.result();
      assert.equal(result.status, 'cancelled');
      assert.equal(starts, 2);
      assert.equal(startedTurns.length, 2);
      const primary = await rpc.request('thread/read', {
        threadId: first.threadId,
        includeTurns: true,
      });
      assert.equal(primary.thread.turns.length, 2);
      for (const entry of startedTurns)
        assert.equal(
          primary.thread.turns.filter((t) => t.id === entry.turn.id && t.status === 'interrupted')
            .length,
          1,
        );
      const authorization = JSON.parse(store.read(resumeAck.authorization).toString());
      assert.equal(authorization.verified.origin, 'human');
      const nativeProof = JSON.parse(store.read(authorization.verified.proof).toString());
      assert.equal(nativeProof.source.threadId, grant.issuer.threadId);
      assert.equal(JSON.parse(store.read(result.stop).toString()).confirmed, true);
      history = await handle.fetchHistory();
      record('history.json', history);
      summary = {
        status: 'PASS',
        scope:
          'actual native human RESUME from another existing chat, same owner/generation/requirements/workspace/session; interrupted LOAD, no full read result',
        model,
        effort: 'medium',
        turns: starts,
        elapsedMs: Date.now() - started,
        resumeToFinalStopMs: Date.now() - resumedAt,
        session: first.threadId,
        issuerThread: grant.issuer.threadId,
        startedTurns,
        pauseAck,
        resumeAck,
        cancelAck,
        result,
        duringResume,
        primary: save(primary),
        usage,
      };
    }),
  );
  await Worker.runReplayHistory({ workflowsPath }, history, handle.workflowId);
  record('report.json', summary);
  console.log(
    JSON.stringify({
      status: 'PASS',
      evidence,
      modelTurns: starts,
      elapsedMs: Date.now() - started,
    }),
  );
} catch (error) {
  if (handle)
    try {
      record('failure-history.json', await handle.fetchHistory());
    } catch (historyError) {
      record('history-error.json', { error: String(historyError) });
    }
  record('report.json', {
    status: 'FAIL',
    model,
    turns: starts,
    elapsedMs: Date.now() - started,
    startedTurns,
    usage,
    error: String(error),
    cause: String(error.cause?.cause ?? error.cause),
  });
  console.error(JSON.stringify({ status: 'FAIL', evidence, turns: starts }));
  throw error;
} finally {
  rpc?.close();
  await environment?.teardown();
  rmSync(workspace, { recursive: true, force: true });
}
