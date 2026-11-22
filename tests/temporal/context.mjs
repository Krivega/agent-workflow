import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker } from '@temporalio/worker';
import { createReaderHost } from '../../dist/worker/readerHost.js';
import { bindTaskBackendClient } from '../../dist/client/taskBackend.js';
import {
  startControlledReader,
  makeReaderCommand,
  controlReader,
} from '../../dist/client/reader.js';
import { readerKey, readerTarget } from '../../dist/policy/readerControl.js';
import { artifactStore } from '../../dist/adapters/artifacts/files.js';
import { nativeReaderAuthority } from '../../dist/adapters/codex/readerAuthority.js';

const [model, grantFile] = process.argv.slice(2),
  native = model !== undefined;
assert.ok(
  !native || grantFile,
  'Native context qualification requires model and an issued human command file',
);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
mkdirSync(join(packageRoot, 'tmp/temporal-downloads'), { recursive: true });
const evidence = realpathSync(mkdtempSync(join(packageRoot, 'tmp/temporal-context-')));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aw-context-')));
const save = (file, value) =>
  writeFileSync(join(evidence, file), JSON.stringify(value), { mode: 0o600 });
const profile = { model: model ?? 'test-reader', effort: 'medium', clientVersion: '0.154.0' };
const usage = [],
  sessions = new Map();
let starts = 0,
  compactCalls = 0,
  environment,
  nativeRpc,
  port,
  sessionId,
  handle,
  cleanupFailure = null;
const began = Date.now();
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
async function until(read, accept) {
  const end = Date.now() + (native ? 10 * 60_000 : 20000);
  for (;;) {
    const v = await read();
    if (accept(v)) return v;
    assert.ok(Date.now() < end, 'Context qualification timed out');
    await delay(25);
  }
}
try {
  mkdirSync(join(workspace, 'tasks'));
  for (const [path, body] of Object.entries({
    'RULES.md': 'Read only. No network, writing or helpers. Use only the declared inputs.\n',
    'reviewer.md':
      'Review the stated criterion. The host will compact context after the first LOAD.\n',
    'tasks/one.md':
      '# Context qualification\nCriterion: the number 7 is positive. Explain briefly. No implementation.\n',
  }))
    writeFileSync(join(workspace, path), body);
  const project = {
    schemaVersion: 1,
    projectId: 'native-context',
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
  const target = readerTarget(input, readerKey(input));
  const registration = {
    project,
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    workspaceRoot: workspace,
    artifactRoot: join(evidence, 'artifacts'),
    commands: { syntax: { executable: 'node', args: [] } },
  };
  const store = artifactStore(registration.artifactRoot),
    record = (v) => store.publish(Buffer.from(JSON.stringify(v)));
  const initial = record({
    kind: 'context-safety-grant',
    target,
    allowed: 'read only; pause/cancel; three turn starts and one explicit compaction',
  });
  const grant = native ? JSON.parse(readFileSync(grantFile, 'utf8')) : null;
  const source = native ? record(grant.source) : initial;
  const resume = makeReaderCommand({
    schemaVersion: 1,
    commandId: 'context-fresh-load',
    target,
    expectedRevision: 1,
    author: 'user',
    action: 'resume',
    attempt: 1,
    source,
  });
  if (native) assert.deepEqual(resume, grant.command);
  const primaryAuthority = native ? nativeReaderAuthority(store, grant.issuer) : null;
  const authority = {
    async verify(c) {
      if (c.action === 'resume') {
        assert.deepEqual(c, resume);
        return primaryAuthority
          ? primaryAuthority.verify(c)
          : { origin: 'human', author: c.author, hash: c.hash, proof: initial };
      }
      assert.deepEqual(c.source, initial);
      assert.deepEqual(c.target, target);
      return { origin: 'initial-grant', author: c.author, hash: c.hash, proof: initial };
    },
  };
  if (native) {
    assert.equal(
      spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout.trim(),
      'codex-cli 0.154.0',
    );
    await primaryAuthority.verify(resume);
    const { StdioAppServer } = await import('../../adapters/codex/appServerTransport.ts');
    nativeRpc = new StdioAppServer(
      'codex',
      ['app-server', '--stdio'],
      workspace,
      join(evidence, 'rpc.jsonl'),
    );
    nativeRpc.observe((message) => {
      if (message.method === 'thread/tokenUsage/updated') usage.push(message.params);
    });
    await nativeRpc.initialize();
    port = nativeRpc;
  } else {
    let serial = 0;
    port = {
      async request(method, params) {
        if (method === 'model/list')
          return {
            data: [
              { model: profile.model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
            ],
          };
        if (method === 'thread/start' || method === 'thread/resume') {
          const thread = sessions.get(params.threadId) ?? {
            id: 'context-session',
            cwd: workspace,
            forkedFromId: null,
            parentThreadId: null,
            projectId: null,
            turns: [],
          };
          sessions.set(thread.id, thread);
          return {
            cwd: workspace,
            model: profile.model,
            reasoningEffort: 'medium',
            approvalPolicy: 'never',
            sandbox: { type: 'readOnly', networkAccess: false },
            thread: globalThis.structuredClone(thread),
          };
        }
        if (method === 'thread/loaded/list') return { data: [...sessions.keys()] };
        if (method === 'thread/read')
          return { thread: globalThis.structuredClone(sessions.get(params.threadId)) };
        if (method === 'thread/compact/start') {
          sessions.get(params.threadId).turns.push({
            id: 'compact',
            status: 'completed',
            items: [{ type: 'contextCompaction' }],
          });
          return {};
        }
        if (method === 'turn/start') {
          const message = params.input[0].text,
            offset = message.indexOf('Пути и хеши: ');
          const refs =
            offset < 0
              ? []
              : JSON.parse(
                  message.slice(
                    offset + 'Пути и хеши: '.length,
                    message.indexOf('. Для больших', offset),
                  ),
                );
          const items = refs.length
            ? [
                {
                  type: 'commandExecution',
                  status: 'completed',
                  exitCode: 0,
                  aggregatedOutput: refs
                    .map((ref) =>
                      JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }),
                    )
                    .join('\n'),
                },
              ]
            : [{ type: 'agentMessage', text: 'Seven is greater than zero.' }];
          const turn = {
            id: 'turn-' + ++serial,
            status: 'completed',
            items: [{ type: 'userMessage', content: params.input }, ...items],
          };
          sessions.get(params.threadId).turns.push(turn);
          return { turn: { id: turn.id } };
        }
        throw new Error('Unexpected context RPC: ' + method);
      },
      async completed() {},
    };
  }
  let inject = true;
  const rpc = {
    async request(method, params) {
      if (method === 'turn/start') {
        assert.ok(starts < 3, 'Context batch permits three turn starts');
        starts++;
      }
      const response = await port.request(method, params);
      if (method === 'thread/start') {
        assert.equal(sessionId, undefined);
        sessionId = response.thread.id;
      }
      return response;
    },
    async completed(session, turn, signal) {
      await port.completed(session, turn, signal);
      // Inject the real native compaction after LOAD's completed notification, before its next primary observation.
      if (inject) {
        inject = false;
        compactCalls++;
        await port.request('thread/compact/start', { threadId: session });
        await until(
          () => port.request('thread/read', { threadId: session, includeTurns: true }),
          (v) =>
            v.thread.turns.some((t) =>
              t.items?.some((item) => item.type === 'contextCompaction'),
            ) &&
            v.thread.turns.every((t) => ['completed', 'failed', 'interrupted'].includes(t.status)),
        );
      }
    },
  };
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      dbFilename: join(evidence, 'temporal.sqlite'),
      executable: {
        type: 'cached-download',
        version: 'v1.9.1',
        downloadDir: join(packageRoot, 'tmp/temporal-downloads'),
      },
    },
  });
  const workflowsPath = join(packageRoot, 'dist/workflows/controlledReader.js');
  bindTaskBackendClient(environment.client, registration);
  const host = await createReaderHost(
    environment.nativeConnection,
    'context',
    workflowsPath,
    [{ registration, rpc, authority }],
    profile,
    join(evidence, 'host'),
    3,
  );
  await environment.client.connection.withDeadline(Date.now() + 30 * 60_000, () =>
    host.runUntil(async () => {
      handle = await startControlledReader(environment.client, input, 'context');
      const blocked = await until(
        () => handle.query('readerStatus'),
        (v) => v.mode === 'blocked',
      );
      assert.match(blocked.error, /reader-context-compacted:/u);
      assert.equal(blocked.diagnostic.kind, 'waiting-human');
      assert.equal(starts, 1);
      save('blocked.json', blocked);
      const pause = makeReaderCommand({
        schemaVersion: 1,
        commandId: 'context-pause',
        target,
        expectedRevision: 0,
        author: 'user',
        action: 'pause',
        attempt: 0,
        source: initial,
      });
      await controlReader(environment.client, readerKey(input), pause);
      await until(
        () => handle.query('readerStatus'),
        (v) => v.mode === 'paused',
      );
      await controlReader(environment.client, readerKey(input), resume);
      const result = await handle.result();
      assert.equal(result.status, 'answered');
      assert.equal(starts, 3);
      const answer = JSON.parse(store.read(result.answer).toString());
      assert.equal(answer.session, sessionId);
      const load = JSON.parse(store.read(answer.load).toString());
      assert.notEqual(load.observed.id, '');
      const primary = await rpc.request('thread/read', { threadId: sessionId, includeTurns: true });
      assert.ok(
        primary.thread.turns.every((t) =>
          ['completed', 'failed', 'interrupted'].includes(t.status),
        ),
      );
      const compactIndex = primary.thread.turns.findIndex((t) =>
        t.items.some((item) => item.type === 'contextCompaction'),
      );
      const loadIndex = primary.thread.turns.findIndex((t) => t.id === load.observed.id);
      assert.ok(loadIndex > compactIndex);
      save('primary.json', primary);
      save('result.json', result);
      const history = await handle.fetchHistory();
      save('history.json', history);
      await Worker.runReplayHistory({ workflowsPath }, history, handle.workflowId);
    }),
  );
  assert.equal(compactCalls, 1);
} catch (error) {
  save('failure.json', {
    status: 'FAIL',
    nativeModelStarts: native ? starts : 0,
    compactCalls,
    error: String(error),
    stack: error.stack,
    usage,
  });
  throw error;
} finally {
  try {
    if (port && sessionId) {
      const primary = await port.request('thread/read', {
        threadId: sessionId,
        includeTurns: true,
      });
      for (const turn of primary.thread.turns)
        if (turn.status === 'inProgress') {
          await port.request('turn/interrupt', { threadId: sessionId, turnId: turn.id });
          await port.completed(sessionId, turn.id);
        }
    }
  } catch (error) {
    cleanupFailure = String(error);
    save('cleanup-error.json', { status: 'UNKNOWN', error: cleanupFailure });
  } finally {
    try {
      nativeRpc?.close();
    } finally {
      try {
        await environment?.teardown();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  }
}
assert.equal(cleanupFailure, null, 'Unknown external stop cannot become PASS');
save('report.json', {
  status: 'PASS',
  nativeModelStarts: native ? starts : 0,
  simulatedStarts: native ? 0 : starts,
  compactCalls,
  sameSession: sessionId,
  humanResume: native,
  elapsedMs: Date.now() - began,
  usage,
});
console.log(
  JSON.stringify({
    status: 'PASS',
    evidence,
    nativeModelStarts: native ? starts : 0,
    simulatedStarts: native ? 0 : starts,
    compactCalls,
  }),
);
