import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fork, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Connection, Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { startReview } from '../../dist/client/review.js';
import { bindTaskBackendClient } from '../../dist/client/taskBackend.js';
import { recoverReaderHost } from '../../dist/worker/readerRecovery.js';
import { readerActivities } from '../../dist/activities/reader.js';
import { readerBoundary } from '../../dist/adapters/codex/readerBoundary.js';
import { readerExecution } from '../../dist/policy/readerExecution.js';
import { artifactStore, digest } from '../../dist/adapters/artifacts/files.js';
import { captureTaskBudget } from '../../dist/worker/taskBudget.js';

const [mode, model] = process.argv.slice(2),
  native = mode === '--native';
assert.ok(mode === undefined || (native && model), 'Use no arguments or --native AUTHORIZED_MODEL');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
mkdirSync(join(packageRoot, 'tmp/temporal-downloads'), { recursive: true });
const evidence = realpathSync(mkdtempSync(join(packageRoot, 'tmp/temporal-crash-')));
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
const profile = { model: model ?? 'test-reader', effort: 'medium', clientVersion: '0.154.0' };
const save = (name, value) =>
  writeFileSync(join(evidence, name), JSON.stringify(value), { mode: 0o600 });
let environment,
  starts = 0;
const usage = [],
  cases = [],
  histories = [],
  cleanupErrors = [];
const began = Date.now();
async function until(read, accept) {
  const end = Date.now() + (native ? 5 * 60_000 : 25_000);
  for (;;) {
    const v = await read();
    if (accept(v)) return v;
    assert.ok(Date.now() < end, 'Crash qualification timed out');
    await delay(25);
  }
}
try {
  if (native)
    assert.equal(
      spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout.trim(),
      'codex-cli 0.154.0',
    );
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
  const workflowsPath = join(packageRoot, 'dist/workflows/review.js');
  for (const fault of ['completion', 'send', 'create']) {
    const startsBeforeFault = starts,
      budgetSnapshots = [],
      root = join(evidence, fault),
      workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aw-crash-')));
    mkdirSync(join(workspace, 'tasks'));
    for (const [path, body] of Object.entries({
      'RULES.md': 'Read only. No network, changes or helpers. Use declared inputs only.\n',
      'reviewer.md': 'Check that subject.ts exports VALUE = 7. Report PASS when it does.\n',
      'subject.ts': 'export const VALUE = 7;\n',
      'tasks/one.md': `# ${fault} recovery qualification\nCheck the criterion in reviewer.md. No implementation.\n`,
    }))
      writeFileSync(join(workspace, path), body);
    const project = {
      schemaVersion: 1,
      projectId: 'fault-' + fault,
      workspaceId: 'isolated',
      rules: ['RULES.md'],
      cardRoot: 'tasks',
      roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
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
      artifactRoot: join(root, 'artifacts'),
      commands: { syntax: { executable: 'node', args: [] } },
    };
    const store = artifactStore(registration.artifactRoot),
      read = (ref) => JSON.parse(store.read(ref).toString());
    const request = store.publish(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          phase: 'planning',
          scope: 'fault-scope',
          sharedPaths: [],
          roles: [
            {
              roleId: 'reviewer',
              applies: true,
              reason: fault + ' boundary',
              paths: ['subject.ts'],
              complete: true,
              attestedBy: 'qualification',
              discoveryRule: 'declared',
              history: { complete: true, answers: [] },
            },
          ],
        }),
      ),
    );
    const review = { schemaVersion: 1, preparation, reviewId: 'crash-' + fault, request };
    const roleId = `aw/review-reader/${project.projectId}/one/reviewer/${digest(JSON.stringify([review.reviewId, 'reviewer', 'planning', 'fault-scope']))}`;
    const threads = new Map(),
      owned = new Set();
    let serial = 0,
      creates = 0,
      nativeRpc,
      connection,
      child,
      reached,
      intercepted = false,
      busyRejected = false;
    const children = [],
      logs = [];
    function metadata(thread) {
      return {
        cwd: workspace,
        model: profile.model,
        reasoningEffort: profile.effort,
        approvalPolicy: 'never',
        sandbox: { type: 'readOnly', networkAccess: false },
        thread: globalThis.structuredClone(thread),
      };
    }
    let port = {
      async request(method, params) {
        if (method === 'model/list')
          return {
            data: [
              { model: profile.model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
            ],
          };
        if (method === 'thread/start') {
          const thread = {
            id: fault + '-session',
            cwd: workspace,
            forkedFromId: null,
            parentThreadId: null,
            projectId: null,
            turns: [],
          };
          threads.set(thread.id, thread);
          return metadata(thread);
        }
        if (method === 'thread/resume') return metadata(threads.get(params.threadId));
        if (method === 'thread/loaded/list') return { data: [...threads.keys()] };
        if (method === 'thread/read')
          return { thread: globalThis.structuredClone(threads.get(params.threadId)) };
        if (method === 'turn/start') {
          const message = params.input[0].text,
            offset = message.indexOf('Пути и хеши: ');
          let items;
          if (offset >= 0) {
            const refs = JSON.parse(
              message.slice(
                offset + 'Пути и хеши: '.length,
                message.indexOf('. Для больших', offset),
              ),
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
              answer = JSON.parse(
                message.slice(begin, message.indexOf('. PASS несовместим', begin)),
              );
            Object.assign(answer, {
              verdict: 'PASS',
              coverage: 'complete',
              findings: [],
              limitations: [],
            });
            items = [{ type: 'agentMessage', text: JSON.stringify(answer) }];
          }
          const turn = {
            id: 'turn-' + ++serial,
            status: fault === 'send' && serial === 1 ? 'inProgress' : 'completed',
            items: [{ type: 'userMessage', content: params.input }, ...items],
          };
          threads.get(params.threadId).turns.push(turn);
          return { turn: { id: turn.id } };
        }
        if (method === 'turn/interrupt') {
          threads.get(params.threadId).turns.find((t) => t.id === params.turnId).status =
            'interrupted';
          return {};
        }
        throw new Error('Unexpected test RPC: ' + method);
      },
      async completed(session, turn) {
        threads.get(session).turns.find((t) => t.id === turn).status = 'completed';
      },
    };
    if (native) {
      const { StdioAppServer } = await import('../../adapters/codex/appServerTransport.ts');
      nativeRpc = new StdioAppServer(
        'codex',
        ['app-server', '--stdio'],
        workspace,
        join(root, 'rpc.jsonl'),
      );
      nativeRpc.observe((message) => {
        if (message.method === 'thread/tokenUsage/updated') usage.push(message.params);
      });
      await nativeRpc.initialize();
      port = nativeRpc;
    }
    const rpc = {
      async request(method, params) {
        if (method === 'turn/start') {
          assert.ok(starts < 4, 'This crash batch permits at most four starts');
          starts++;
        }
        if (method === 'thread/start') creates++;
        const value = await port.request(method, params);
        if (method === 'thread/start') owned.add(value.thread.id);
        return value;
      },
      completed: (session, turn) => port.completed(session, turn),
    };
    const config = {
      address: environment.address,
      queue: 'crash-' + fault,
      workflowsPath,
      registration,
      profile,
      hostRoot: join(root, 'host'),
      maxStarts: 4,
    };
    const configFile = join(root, 'worker.json');
    save(fault + '-config.json', config);
    writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    async function launch() {
      const actor = fork(join(packageRoot, 'tests/temporal/crash-worker.mjs'), [configFile], {
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(actor);
      actor.stdout.on('data', (bytes) => logs.push(bytes.toString()));
      actor.stderr.on('data', (bytes) => logs.push(bytes.toString()));
      actor.on('message', async (message) => {
        if (message.type !== 'request') return;
        try {
          const value =
            message.method === '__completed'
              ? await rpc.completed(message.params.thread, message.params.turn)
              : await rpc.request(message.method, message.params);
          if (
            !intercepted &&
            ((fault === 'completion' && message.method === '__completed') ||
              (fault === 'send' && message.method === 'turn/start') ||
              (fault === 'create' && message.method === 'thread/start'))
          ) {
            intercepted = true;
            reached = { method: message.method, params: message.params, response: value };
            return;
          }
          if (actor.connected) actor.send({ type: 'response', id: message.id, value });
        } catch (error) {
          if (actor.connected)
            actor.send({ type: 'response', id: message.id, error: String(error) });
        }
      });
      await new Promise((resolve, reject) => {
        actor.on('message', (m) => {
          if (m.type === 'ready') resolve();
        });
        actor.once('exit', (code, signal) =>
          reject(new Error('Worker exited before READY: ' + code + '/' + signal)),
        );
        actor.once('error', reject);
      });
      return actor;
    }
    async function retain(handle) {
      const history = await handle.fetchHistory();
      histories.push({ history, workflowId: handle.workflowId });
      writeFileSync(
        join(root, digest(handle.workflowId) + '-history.json'),
        JSON.stringify(history),
        { mode: 0o600 },
      );
    }
    try {
      child = await launch();
      connection = await Connection.connect({ address: environment.address });
      let client = new Client({ connection });
      bindTaskBackendClient(client, registration);
      let parent = await startReview(client, review, config.queue);
      await until(() => Promise.resolve(reached), Boolean);
      const role = client.workflow.getHandle(roleId),
        input = await role.query('readerInput'),
        status = await role.query('readerStatus');
      if (fault === 'send') {
        const proofFiles = readdirSync(registration.artifactRoot).filter((name) =>
          /^[a-f0-9]{64}$/u.test(name),
        );
        const creation = proofFiles
          .map((name) => {
            const file = join(registration.artifactRoot, name);
            return {
              ref: { sha256: name, bytes: readFileSync(file).length },
              value: JSON.parse(readFileSync(file, 'utf8')),
            };
          })
          .find((v) => v.value.kind === 'reader-session');
        const gate = readerBoundary(
          join(config.hostRoot, digest(project.projectId), 'permissions'),
          store,
          workspace,
          readerExecution(profile),
        );
        const activity = readerActivities(
          registration,
          rpc,
          profile,
          join(config.hostRoot, digest(project.projectId), 'effects'),
          gate.boundary,
        );
        await assert.rejects(
          activity.loadReader(
            input,
            creation.value.prepared,
            { id: reached.params.threadId, creation: creation.ref },
            { permit: status.permit, revision: 0, attempt: 0 },
          ),
          /reader-previous-turn-active/u,
        );
        busyRejected = true;
        await rpc.completed(reached.params.threadId, reached.response.turn.id);
        const budget = captureTaskBudget(join(config.hostRoot, 'turn-credits'), store, null);
        const snapshot = {
          phase: 'before-worker-loss',
          budget,
          record: read(budget.manifest),
          observedStarts: starts - startsBeforeFault,
        };
        budgetSnapshots.push(snapshot);
        save('send-budget-before-loss.json', snapshot);
        assert.ok(budget.used > 0, 'Worker loss must follow a physical reserved credit');
        assert.equal(
          budget.limit,
          config.maxStarts,
          'Physical limit must match Worker configuration',
        );
        assert.equal(
          budget.used,
          snapshot.observedStarts,
          'Reserved credits must match observed starts',
        );
      }
      const oldPid = child.pid;
      const died = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await died;
      await connection.close();
      connection = await Connection.connect({ address: environment.address });
      client = new Client({ connection });
      bindTaskBackendClient(client, registration);
      parent = client.workflow.getHandle(parent.workflowId);
      const projects = [
        {
          registration,
          rpc,
          authority: {
            async verify() {
              throw new Error('No human command in crash probe');
            },
          },
        },
      ];
      if (fault === 'create') {
        await assert.rejects(
          recoverReaderHost(projects, config.hostRoot, profile, [input]),
          /reader-recovery-create-unknown/u,
        );
        assert.ok(existsSync(join(config.hostRoot, 'host-owner')));
        assert.equal(creates, 1);
        await parent.terminate('End isolated unknown-create probe; no model turn was started');
        await retain(parent);
        cases.push({ fault, status: 'unknown-not-reassigned', creates, starts: 0, oldPid });
      } else {
        const recovery = await recoverReaderHost(projects, config.hostRoot, profile, [input]);
        assert.equal(recovery.owner.pid, oldPid);
        if (fault === 'send') {
          const before = budgetSnapshots[0].budget,
            budget = captureTaskBudget(
              join(config.hostRoot, 'turn-credits'),
              store,
              before.manifest,
            ),
            snapshot = {
              phase: 'after-host-recovery-before-worker',
              budget,
              record: read(budget.manifest),
              observedStarts: starts - startsBeforeFault,
            };
          budgetSnapshots.push(snapshot);
          save('send-budget-after-recovery.json', snapshot);
          assert.equal(budget.used, before.used, 'Host recovery must not refund a reserved credit');
          assert.deepEqual(
            budget.manifest,
            before.manifest,
            'Recovery must preserve the physical checkpoint',
          );
          assert.equal(
            budget.used,
            snapshot.observedStarts,
            'Recovery must not dispatch another start',
          );
        }
        child = await launch();
        const result = await client.connection.withDeadline(
          Date.now() + (native ? 30 * 60_000 : 45000),
          () => parent.result(),
        );
        assert.equal(result.complete, true);
        assert.equal(creates, 1);
        const answer = read(result.answers[0].result.answer);
        assert.equal(answer.session, [...owned][0]);
        assert.equal(answer.report.verdict, 'PASS');
        await retain(parent);
        await retain(client.workflow.getHandle(roleId));
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.send({ type: 'finish' });
        assert.equal(await exited, 0);
        assert.equal(existsSync(join(config.hostRoot, 'host-owner')), false);
        if (fault === 'send') {
          const before = budgetSnapshots[1].budget,
            budget = captureTaskBudget(
              join(config.hostRoot, 'turn-credits'),
              store,
              before.manifest,
            ),
            snapshot = {
              phase: 'after-completion-and-worker-exit',
              budget,
              record: read(budget.manifest),
              observedStarts: starts - startsBeforeFault,
            };
          budgetSnapshots.push(snapshot);
          save('send-budget-after-resume.json', snapshot);
          assert.ok(
            budget.used >= before.used,
            'Replacement Worker must preserve the reserved prefix',
          );
          assert.equal(
            budget.used,
            snapshot.observedStarts,
            'Physical credits must match actual start dispatches',
          );
        }
        cases.push({
          fault,
          status: 'recovered',
          creates,
          starts: 2,
          session: answer.session,
          oldPid,
          newPid: child.pid,
          busyRejected,
          clientReconnected: true,
          ...(fault === 'send' ? { budgetSnapshots } : {}),
        });
      }
    } finally {
      for (const actor of children)
        if (actor.exitCode === null && actor.signalCode === null) {
          const done = new Promise((resolve) => actor.once('exit', resolve));
          actor.kill('SIGKILL');
          await done;
        }
      for (const session of owned) {
        try {
          const primary = await rpc.request('thread/read', {
            threadId: session,
            includeTurns: true,
          });
          for (const turn of primary.thread.turns)
            if (turn.status === 'inProgress') {
              await rpc.request('turn/interrupt', { threadId: session, turnId: turn.id });
              await rpc.completed(session, turn.id);
            }
        } catch (error) {
          if (fault !== 'create') cleanupErrors.push(String(error));
        }
      }
      nativeRpc?.close();
      await connection?.close();
      writeFileSync(join(root, 'workers.log'), logs.join(''), { mode: 0o600 });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  assert.deepEqual(cleanupErrors, []);
  const workflowBundle = await bundleWorkflowCode({ workflowsPath });
  for (const { history, workflowId } of histories)
    await Worker.runReplayHistory({ workflowBundle }, history, workflowId);
  assert.equal(starts, 4);
} catch (error) {
  save('failure.json', {
    status: 'FAIL',
    nativeModelStarts: native ? starts : 0,
    simulatedStarts: native ? 0 : starts,
    error: String(error),
    stack: error.stack,
    cases,
    usage,
  });
  throw error;
} finally {
  await environment?.teardown();
}
const report = {
  status: 'PASS',
  nativeModelStarts: native ? starts : 0,
  simulatedStarts: native ? 0 : starts,
  cases,
  replayed: histories.length,
  usage,
  elapsedMs: Date.now() - began,
};
save('report.json', report);
console.log(
  JSON.stringify({
    status: 'PASS',
    evidence,
    nativeModelStarts: report.nativeModelStarts,
    simulatedStarts: report.simulatedStarts,
    replayed: report.replayed,
  }),
);
