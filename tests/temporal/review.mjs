import assert from 'node:assert/strict';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker } from '@temporalio/worker';
import { createReaderHost } from '../../dist/worker/readerHost.js';
import { startReview } from '../../dist/client/review.js';
import { bindTaskBackendClient } from '../../dist/client/taskBackend.js';
import { readerKey } from '../../dist/policy/readerControl.js';
import { artifactStore, digest } from '../../dist/adapters/artifacts/files.js';
import { supportedReaderClient } from '../../dist/policy/readerExecution.js';

const [mode, model, ...extra] = process.argv.slice(2);
assert.ok(
  (mode === undefined && model === undefined) ||
    (mode === '--bounded' && model === undefined) ||
    (mode === '--native' && typeof model === 'string' && model.length > 0 && extra.length === 0),
  'Use no arguments, --bounded (no model), or --native EXPLICITLY_AUTHORIZED_MODEL',
);
const native = mode === '--native',
  bounded = mode !== undefined;
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
mkdirSync(resolve(packageRoot, 'tmp/temporal-downloads'), { recursive: true });
const evidence = realpathSync(
  mkdtempSync(
    resolve(packageRoot, native ? 'tmp/temporal-native-review-' : 'tmp/temporal-review-'),
  ),
);
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aw-review-')));
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
let environment,
  nativeRpc,
  starts = 0,
  serial = 0,
  hold = false,
  holdStop = false,
  releaseStop;
const threads = new Map(),
  waiters = new Map(),
  histories = [];
const profile = { model: model ?? 'test-reader', effort: 'medium', clientVersion: '0.154.0' };
const usage = [],
  started = Date.now();
const saveFile = (name, v) =>
  writeFileSync(join(evidence, name), JSON.stringify(v), { mode: 0o600 });
async function until(fn, predicate) {
  const end = Date.now() + 15_000;
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    assert.ok(Date.now() < end, 'Timed out waiting for primary state');
    await delay(25);
  }
}
try {
  mkdirSync(join(workspace, 'tasks'));
  const inputs = {
    'RULES.md':
      'Read only. No network, changes or helpers. Review only declared inputs against the task criterion.\n',
    'front.md':
      'Review front.ts: it must export FRONT = 7; shared.json must have contractVersion = 1.\n',
    'back.md':
      'Review back.ts: it must export BACK = 11; shared.json must have contractVersion = 1.\n',
    'tasks/one.md':
      '# Read-only qualification\nEach role checks its constant and the shared contract against its profile. Report observed evidence in the required structured answer. No implementation is requested.\n',
    'front.ts': 'export const FRONT = 7;\n',
    'back.ts': 'export const BACK = 11;\n',
    'shared.json': '{"contractVersion":1}\n',
  };
  for (const [path, content] of Object.entries(inputs))
    writeFileSync(join(workspace, path), content);
  const project = {
    schemaVersion: 1,
    projectId: 'neutral-review',
    workspaceId: 'isolated',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [
      { id: 'frontend', profile: 'front.md' },
      { id: 'backend', profile: 'back.md' },
    ],
    checks: ['syntax'],
  };
  const preparation = {
    schemaVersion: 1,
    project,
    taskId: 'one',
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    revision: 1,
    card: 'tasks/one.md',
  };
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
    publish = (v) => store.publish(Buffer.from(JSON.stringify(v))),
    read = (ref) => JSON.parse(store.read(ref).toString());
  const request = {
    schemaVersion: 1,
    phase: 'planning',
    scope: 'feature',
    sharedPaths: ['shared.json'],
    roles: project.roles.map((r, i) => ({
      roleId: r.id,
      applies: true,
      reason: 'Own subsystem',
      paths: [i === 0 ? 'front.ts' : 'back.ts'],
      complete: true,
      attestedBy: 'neutral adapter',
      discoveryRule: 'declared-v1',
      history: { complete: true, answers: [] },
    })),
  };
  const input = (id) => ({
    schemaVersion: 1,
    preparation,
    reviewId: id,
    request: publish(request),
  });
  function metadata(thread) {
    return {
      cwd: workspace,
      model: profile.model,
      reasoningEffort: 'medium',
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: globalThis.structuredClone(thread),
    };
  }
  let rpc = {
    async request(method, p) {
      if (method === 'model/list')
        return {
          data: [
            { model: profile.model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
          ],
        };
      if (method === 'thread/start') {
        const thread = {
          id: 'session-' + String(++serial),
          cwd: workspace,
          parentThreadId: null,
          forkedFromId: null,
          projectId: null,
          turns: [],
        };
        threads.set(thread.id, thread);
        return metadata(thread);
      }
      if (method === 'thread/resume') return metadata(threads.get(p.threadId));
      if (method === 'thread/loaded/list') return { data: [...threads.keys()] };
      if (method === 'thread/read')
        return { thread: globalThis.structuredClone(threads.get(p.threadId)) };
      if (method === 'turn/start') {
        const thread = threads.get(p.threadId),
          message = p.input[0].text,
          marker = 'Пути и хеши: ',
          offset = message.indexOf(marker);
        let items;
        if (offset >= 0) {
          const refs = JSON.parse(
            message.slice(offset + marker.length, message.indexOf('. Для больших', offset)),
          );
          items = [
            {
              type: 'commandExecution',
              status: 'completed',
              exitCode: 0,
              aggregatedOutput: refs
                .map((ref) => JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }))
                .join('\n'),
            },
          ];
        } else {
          const begin = message.indexOf('Markdown: ') + 'Markdown: '.length,
            report = JSON.parse(message.slice(begin, message.indexOf('. PASS несовместим', begin)));
          report.verdict = 'PASS';
          report.coverage = 'complete';
          report.findings = [];
          report.limitations = [];
          items = [{ type: 'agentMessage', text: JSON.stringify(report) }];
        }
        const turn = {
          id: 'turn-' + String(++starts),
          status: hold ? 'inProgress' : 'completed',
          items: [{ type: 'userMessage', content: [{ type: 'text', text: message }] }, ...items],
        };
        thread.turns.push(turn);
        return { turn: { id: turn.id } };
      }
      if (method === 'turn/interrupt') {
        if (holdStop)
          await new Promise((resolve) => {
            releaseStop = resolve;
          });
        const turn = threads.get(p.threadId).turns.find((t) => t.id === p.turnId);
        turn.status = 'interrupted';
        for (const fn of waiters.get(p.turnId) ?? []) fn();
        return {};
      }
      throw new Error('Unexpected test RPC: ' + method);
    },
    completed(thread, turn) {
      if (threads.get(thread).turns.find((t) => t.id === turn).status !== 'inProgress')
        return Promise.resolve();
      return new Promise((resolve) => {
        const list = waiters.get(turn) ?? [];
        list.push(resolve);
        waiters.set(turn, list);
      });
    },
  };
  if (native) {
    profile.clientVersion = spawnSync('codex', ['--version'], { encoding: 'utf8' })
      .stdout.trim()
      .replace('codex-cli ', '');
    assert.equal(supportedReaderClient(profile.clientVersion), true, 'Unsupported reader client');
    // Only this qualification host reuses the narrow legacy transport, never its runtime.
    const { StdioAppServer } = await import('../../adapters/codex/appServerTransport.ts');
    nativeRpc = new StdioAppServer(
      'codex',
      [
        '-c',
        'features.apps=false',
        '-c',
        'features.plugins=false',
        '-c',
        'features.multi_agent=false',
        'app-server',
        '--stdio',
      ],
      workspace,
      join(evidence, 'rpc.jsonl'),
    );
    nativeRpc.observe((message) => {
      if (message.method === 'thread/tokenUsage/updated') usage.push(message.params);
    });
    await nativeRpc.initialize();
    rpc = {
      request(method, params) {
        if (method === 'turn/start') {
          assert.ok(starts < 4, 'This native qualification permits at most four turn starts');
          starts++;
        }
        return nativeRpc.request(method, params);
      },
      completed(thread, turn, signal) {
        return nativeRpc.completed(thread, turn, signal);
      },
    };
  }
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
  const workflowsPath = resolve(packageRoot, 'dist/workflows/review.js');
  bindTaskBackendClient(environment.client, registration);
  const host = await createReaderHost(
    environment.nativeConnection,
    'review-sdk',
    workflowsPath,
    [
      {
        registration,
        rpc,
        authority: {
          async verify() {
            throw new Error('No human grant in this test');
          },
        },
      },
    ],
    profile,
    join(evidence, 'host'),
    bounded ? 4 : 20,
  );
  const cases = [];
  async function retain(handle) {
    const history = await handle.fetchHistory();
    histories.push({ history, id: handle.workflowId });
    saveFile(digest(handle.workflowId) + '-history.json', history);
  }
  await environment.client.connection.withDeadline(
    Date.now() + (native ? 45 * 60_000 : 90_000),
    () =>
      host.runUntil(async () => {
        try {
          async function run(id) {
            const handle = await startReview(environment.client, input(id), 'review-sdk'),
              result = await handle.result();
            await retain(handle);
            if (result.status === 'reviewed') {
              assert.equal(result.complete, true);
              const plan = read(result.plan);
              for (const row of result.answers)
                if (row.source === 'new') {
                  const decision = plan.decisions.find((d) => d.roleId === row.roleId);
                  await retain(environment.client.workflow.getHandle(readerKey(decision.input)));
                  request.roles
                    .find((r) => r.roleId === row.roleId)
                    .history.answers.push(row.result.answer);
                }
            }
            cases.push({
              id,
              status: result.status,
              starts,
              actions: read(result.plan).decisions.map((r) => r.action),
            });
            return { handle, result };
          }
          const first = await run('initial');
          assert.equal(starts, 4);
          assert.equal(
            new Set(first.result.answers.map((row) => read(row.result.answer).session)).size,
            2,
          );
          if (!native) assert.equal(threads.size, 2);
          await assert.rejects(startReview(environment.client, input('initial'), 'review-sdk'));
          await run('unchanged');
          assert.equal(starts, 4);
          if (!native) assert.equal(threads.size, 2);
          if (bounded) return;
          writeFileSync(join(workspace, 'front.ts'), 'local fix');
          await run('local-fix');
          assert.equal(starts, 6);
          assert.equal(threads.size, 3);
          writeFileSync(join(workspace, 'shared.json'), 'shared contract');
          await run('shared-fix');
          assert.equal(starts, 10);
          assert.equal(threads.size, 5);
          rmSync(join(workspace, 'back.ts'));
          const missing = await startReview(environment.client, input('missing'), 'review-sdk');
          await assert.rejects(missing.result());
          await retain(missing);
          assert.equal(starts, 10);
          writeFileSync(join(workspace, 'back.ts'), 'back.ts');
          request.roles[0].applies = null;
          assert.equal((await run('unknown')).result.status, 'blocked');
          assert.equal(starts, 10);
          request.roles[0].applies = true;
          hold = true;
          writeFileSync(join(workspace, 'front.ts'), 'cancel-boundary');
          const cancelInput = input('cancel'),
            cancelled = await startReview(environment.client, cancelInput, 'review-sdk');
          await until(
            () => Promise.resolve(starts),
            (n) => n === 11,
          );
          await cancelled.cancel();
          await assert.rejects(cancelled.result());
          await until(
            () => Promise.resolve([...threads.values()].flatMap((t) => t.turns)),
            (turns) => turns.every((t) => t.status !== 'inProgress'),
          );
          await retain(cancelled);
          for (const role of project.roles.filter((r) => r.id === 'frontend')) {
            const token = digest(JSON.stringify(['cancel', role.id, request.phase, request.scope]));
            const id = `aw/review-reader/${project.projectId}/one/${role.id}/${token}`;
            await retain(environment.client.workflow.getHandle(id));
          }
          assert.equal(starts, 11);
          writeFileSync(join(workspace, 'shared.json'), 'peer-failure-boundary');
          holdStop = true;
          const peerId = 'peer-failure',
            peer = await startReview(environment.client, input(peerId), 'review-sdk');
          let parentSettled = false;
          const peerResult = peer.result().then(
            (value) => {
              parentSettled = true;
              return value;
            },
            (error) => {
              parentSettled = true;
              return error;
            },
          );
          await until(
            () => Promise.resolve(starts),
            (n) => n === 12,
          );
          const peers = project.roles.map((role) => {
            const token = digest(JSON.stringify([peerId, role.id, request.phase, request.scope]));
            return environment.client.workflow.getHandle(
              `aw/review-reader/${project.projectId}/one/${role.id}/${token}`,
            );
          });
          const states = await Promise.all(peers.map((handle) => handle.query('readerStatus'))),
            idle = states.findIndex(
              (state) => state.session === null || threads.get(state.session).turns.length === 0,
            );
          assert.ok(idle >= 0);
          assert.ok(states.some((state) => state.phase === 'loading'));
          await peers[idle].terminate('SDK probe: child with no external session');
          await until(
            () => Promise.resolve(releaseStop),
            (fn) => typeof fn === 'function',
          );
          assert.equal(parentSettled, false, 'Parent must wait for its active child to stop');
          assert.equal([...threads.values()].flatMap((t) => t.turns).at(-1).status, 'inProgress');
          releaseStop();
          assert.ok((await peerResult) instanceof Error);
          assert.ok(
            [...threads.values()].flatMap((t) => t.turns).every((t) => t.status !== 'inProgress'),
          );
          await retain(peer);
          for (const handle of peers) await retain(handle);
          cases.push({ id: peerId, status: 'failed-after-confirmed-peer-stop', starts });
          assert.equal(starts, 12);
          assert.equal((await first.handle.result()).complete, true);
        } finally {
          holdStop = false;
          releaseStop?.();
        }
      }),
  );
  for (const { history, id } of histories)
    await Worker.runReplayHistory({ workflowsPath }, history, id);
  saveFile('report.json', {
    status: 'PASS',
    nativeModelStarts: native ? starts : 0,
    simulatedStarts: native ? 0 : starts,
    profile,
    usage,
    elapsedMs: Date.now() - started,
    cases,
    replayed: histories.length,
    scope: native
      ? 'native targeted LOAD, primary structured answer, unchanged reuse and replay; no RESULT/DONE'
      : 'real SDK admission, targeted LOAD, reuse, early refusal, child cancellation and replay; simulated Codex only',
  });
  console.log(
    JSON.stringify({
      status: 'PASS',
      evidence,
      nativeModelStarts: native ? starts : 0,
      simulatedStarts: native ? 0 : starts,
      replayed: histories.length,
    }),
  );
} catch (error) {
  saveFile('failure.json', {
    status: 'FAIL',
    nativeModelStarts: native ? starts : 0,
    simulatedStarts: native ? 0 : starts,
    profile,
    usage,
    error: String(error),
    stack: error.stack,
  });
  throw error;
} finally {
  nativeRpc?.close();
  await environment?.teardown();
  rmSync(workspace, { recursive: true, force: true });
}
