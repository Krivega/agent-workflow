import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker } from '@temporalio/worker';
import { StdioAppServer } from '../../adapters/codex/appServerTransport.ts';
import { readerActivities } from '../../dist/activities/reader.js';
import { artifactStore, digest } from '../../dist/adapters/artifacts/files.js';

const source = realpathSync(process.argv[2]);
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const evidence = realpathSync(mkdtempSync(resolve(packageRoot, 'tmp/temporal-native/recovery-')));
const report = JSON.parse(readFileSync(join(source, 'report.json'), 'utf8'));
assert.equal(report.status, 'PASS');
assert.equal(report.model, 'gpt-6-astra');
assert.equal(report.effort, 'medium');
const original = artifactStore(join(source, 'artifacts'));
const read = (ref) => JSON.parse(original.read(ref).toString());
const answer = read(report.result.answer);
const load = read(answer.load);
const creations = readdirSync(join(source, 'artifacts'))
  .filter((name) => /^[a-f0-9]{64}$/u.test(name))
  .map((name) => {
    const ref = { sha256: name, bytes: statSync(join(source, 'artifacts', name)).size };
    return { ref, value: read(ref) };
  })
  .filter(
    ({ value }) => value.kind === 'reader-session' && value.response.thread.id === report.session,
  );
assert.equal(creations.length, 1);
const creation = creations[0];
const input = creation.value.input;
const session = { id: report.session, creation: creation.ref };
const workspace = creation.value.response.cwd;
assert.equal(dirname(workspace), realpathSync(tmpdir()));
assert.ok(basename(workspace).startsWith('aw-native-reader-'));
assert.equal(existsSync(workspace), false, 'Never replace a workspace already in use');
const version = spawnSync('codex', ['--version'], { encoding: 'utf8' })
  .stdout.trim()
  .replace('codex-cli ', '');
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
let environment,
  rpc,
  createdWorkspace = false;
const denied = [];
try {
  mkdirSync(workspace, { mode: 0o700 });
  createdWorkspace = true;
  const expected = new Map(load.refs.map((ref) => [ref.path, ref.sha256]));
  const restored = new Set();
  for (const item of load.observed.items) {
    if (item.type !== 'commandExecution' || item.exitCode !== 0) continue;
    for (const line of item.aggregatedOutput.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      assert.ok(expected.has(entry.path));
      assert.equal(digest(entry.content), expected.get(entry.path));
      const path = relative(workspace, entry.path);
      assert.ok(path && !path.startsWith('..') && !path.startsWith('/'));
      mkdirSync(dirname(entry.path), { recursive: true, mode: 0o700 });
      writeFileSync(entry.path, entry.content, { flag: 'wx', mode: 0o600 });
      restored.add(entry.path);
    }
  }
  assert.equal(restored.size, expected.size);
  rpc = new StdioAppServer(
    'codex',
    ['app-server', '--stdio'],
    workspace,
    join(evidence, 'rpc.jsonl'),
  );
  await rpc.initialize();
  const port = {
    request(method, params) {
      if (!['model/list', 'thread/resume', 'thread/read'].includes(method)) {
        denied.push(method);
        throw new Error(`No external starts allowed in recovery qualification: ${method}`);
      }
      return rpc.request(method, params);
    },
    completed(thread, turn) {
      return rpc.completed(thread, turn);
    },
  };
  const before = await port.request('thread/read', { threadId: session.id, includeTurns: true });
  assert.ok(before.thread.turns.every((turn) => turn.status === 'completed'));
  function scenario(name, omit) {
    const root = join(evidence, name);
    cpSync(join(source, 'artifacts'), join(root, 'artifacts'), { recursive: true });
    const effects = join(root, 'effects');
    mkdirSync(effects, { mode: 0o700 });
    let omitted = 0;
    for (const file of readdirSync(join(source, 'effects'))) {
      const path = join(source, 'effects', file);
      if (file.endsWith('.receipt')) {
        const intent = JSON.parse(readFileSync(path.slice(0, -'.receipt'.length), 'utf8'));
        if (omit && intent[3].startsWith(`reader-${omit}-`)) {
          omitted++;
          continue;
        }
      }
      cpSync(path, join(effects, file));
    }
    assert.equal(omitted, omit ? 1 : 0);
    const registration = {
      project: input.preparation.project,
      hostId: input.preparation.hostId,
      owner: input.preparation.owner,
      generation: input.preparation.generation,
      workspaceRoot: workspace,
      artifactRoot: join(root, 'artifacts'),
      commands: { syntax: { executable: 'node', args: ['--check'] } },
    };
    return {
      root,
      store: artifactStore(registration.artifactRoot),
      activities: readerActivities(
        registration,
        port,
        { model: report.model, effort: report.effort, clientVersion: version },
        effects,
      ),
    };
  }
  const lostSend = scenario('lost-send-receipt', 'load');
  const recoveredLoad = await lostSend.activities.loadReader(input, load.prepared, session);
  const recoveredLoadValue = JSON.parse(lostSend.store.read(recoveredLoad).toString());
  assert.equal(recoveredLoadValue.observed.id, load.observed.id);
  assert.equal(recoveredLoadValue.session, session.id);
  const lostCompletion = scenario('lost-completion', null);
  const recoveredAnswer = await lostCompletion.activities.answerReader(
    input,
    load.prepared,
    session,
    answer.load,
  );
  const recoveredAnswerValue = JSON.parse(lostCompletion.store.read(recoveredAnswer).toString());
  assert.equal(recoveredAnswerValue.observed.id, answer.observed.id);
  assert.deepEqual(recoveredAnswerValue.observed.items, answer.observed.items);
  const lostCreate = scenario('lost-create-receipt', 'create');
  await assert.rejects(
    lostCreate.activities.createReader(input, load.prepared),
    /effect-outcome-unknown/u,
  );
  const after = await port.request('thread/read', { threadId: session.id, includeTurns: true });
  assert.deepEqual(
    after.thread.turns.map((turn) => turn.id),
    before.thread.turns.map((turn) => turn.id),
  );
  assert.deepEqual(denied, []);
  // Restart a closed test database copy, preserving the original qualification evidence.
  cpSync(join(source, 'temporal.sqlite'), join(evidence, 'temporal.sqlite'));
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      dbFilename: join(evidence, 'temporal.sqlite'),
      executable: {
        type: 'cached-download',
        version: 'v1.9.1',
        downloadDir: resolve(packageRoot, 'tmp/temporal-downloads'),
      },
    },
  });
  const handle = environment.client.workflow.getHandle('aw/native-reader/read-1');
  assert.deepEqual(await handle.result(), report.result);
  const history = await handle.fetchHistory();
  await Worker.runReplayHistory(
    { workflowsPath: resolve(packageRoot, 'dist/workflows/reader.js') },
    history,
  );
  writeFileSync(
    join(evidence, 'report.json'),
    JSON.stringify({
      status: 'PASS',
      scope: 'terminal session recovery only; active cancellation/control remains open',
      source,
      session: session.id,
      modelTurns: 0,
      externalStarts: denied,
      loadTurn: recoveredLoadValue.observed.id,
      answerTurn: recoveredAnswerValue.observed.id,
      recoveredLoad,
      recoveredAnswer,
      backendResult: report.result,
    }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: 'PASS',
      evidence,
      modelTurns: 0,
      session: session.id,
      cases: [
        'lost-send-receipt',
        'lost-completion',
        'unknown-create',
        'test-server-restart',
        'replay',
      ],
    }),
  );
} finally {
  rpc?.close();
  await environment?.teardown();
  if (createdWorkspace) rmSync(workspace, { recursive: true, force: true });
}
