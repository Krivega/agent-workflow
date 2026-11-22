import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, test } from 'node:test';
import { digest } from '../adapters/storage/storeCodec.ts';
import {
  checkTD054DeadlineProbe,
  prepareTD054DeadlineProbe,
  td054DeadlineProbeMain,
  td054ProposedBounds,
  planTD054DeadlineProbe,
  runTD054DeadlineProbe,
} from './td054DeadlineProbe.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(variant = 'temporal') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'td054-preparation-'));
  roots.push(root);
  const directories = ['workspace', 'chat', 'evidence'];
  for (const name of directories) mkdirSync(join(root, name));
  execFileSync('git', ['init', '--quiet'], { cwd: join(root, 'workspace') });
  function file(name, bytes) {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  }
  const request = {
    kind: 'comparison-h06-native/2',
    binding: {
      operationId: 'reference',
      variant,
      workspaceRoot: join(root, 'workspace'),
      node: file('node', 'never executed synthetic node'),
      timeoutMs: 1000,
    },
    evidenceRoot: join(root, 'evidence/reference'),
    chat: { threadId: 'fixture', workspace: join(root, 'chat') },
    budget: {
      maxElapsedMs: 90000,
      reserveMs: 15000,
      maxManagedStarts: 24,
      maxInputUncached: 100000,
      maxOutput: 2000,
    },
    stimulus: { longStageMs: 5000, initialLeaseMs: variant === 'temporal' ? null : 2000 },
    appServer: file('app-server', 'never executed synthetic app-server'),
    server: variant === 'temporal' ? file('server', 'never executed synthetic server') : null,
    bootstrap: file('bootstrap', '{}'),
    runtime: [file('runtime', 'existing reference only')],
  };
  for (const name of ['RULES.md', 'reviewer.md'])
    writeFileSync(join(root, 'workspace', name), 'read only');
  mkdirSync(join(root, 'workspace/tasks'));
  writeFileSync(join(root, 'workspace/tasks/task.md'), 'only LOAD');
  const preparation = {
    schemaVersion: 1,
    taskId: 'task',
    project: {
      schemaVersion: 1,
      projectId: 'project',
      workspaceId: 'workspace',
      rules: ['RULES.md'],
      cardRoot: 'tasks',
      roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
      checks: ['syntax'],
    },
    hostId: 'host',
    owner: 'owner',
    generation: 1,
    revision: 1,
    card: 'tasks/task.md',
  };
  request.bootstrap = file(
    'bootstrap',
    JSON.stringify({
      input: { admission: { preparation } },
      profile: { model: 'authorized-model', effort: 'medium', clientVersion: '0.154.0' },
      disabledServers: [],
      address: '127.0.0.1:7244',
      server: { httpPort: 7245, metricsPort: 7246 },
    }),
  );
  const reference = file('reference.json', JSON.stringify(request));
  return {
    root,
    request,
    reference,
    packet: () => prepareTD054DeadlineProbe('td054-test', reference),
  };
}

test('prepares deterministic proposal, verifies exact bytes, and keeps native status UNKNOWN', () => {
  const f = fixture();
  const packet = f.packet();
  assert.deepEqual(packet, f.packet());
  assert.equal(packet.proposedBounds.maxManagedStarts, 1);
  assert.deepEqual(packet.authority, { issued: false, source: null, claim: null });
  const packageRoot = realpathSync(new URL('..', import.meta.url));
  assert.ok(packet.runtime.some((value) => value.path === join(packageRoot, 'package.json')));
  assert.ok(packet.runtime.some((value) => value.path === join(packageRoot, 'yarn.lock')));
  assert.ok(
    packet.runtime.some(
      (value) =>
        value.path.endsWith('/package.json') &&
        JSON.parse(readFileSync(value.path, 'utf8')).name === '@temporalio/worker',
    ),
  );
  const checked = checkTD054DeadlineProbe(packet);
  assert.equal(checked.status, 'PREPARATION_PASS_NATIVE_UNKNOWN');
  assert.equal(checked.mayRun, false);
  assert.equal(checked.nativeDeadline, 'UNKNOWN');
  assert.equal(checked.r12FormalColdStop, 'UNKNOWN');
  assert.equal(checked.r13NormalCompletion, 'UNCHANGED');
});

test('rejects mutated qualification, fake source/grant, changed source pin or extra fields', () => {
  const f = fixture();
  const original = f.packet();
  for (const mutate of [
    (p) => {
      p.acceptance.nativeDeadline = 'PASS';
    },
    (p) => {
      p.acceptance.mayRun = true;
    },
    (p) => {
      p.authority.source = '/invented/source';
    },
    (p) => {
      p.authority.issued = true;
    },
    (p) => {
      p.runtime[0].sha256 = '0'.repeat(64);
    },
    (p) => {
      p.requestHash = '0'.repeat(64);
    },
    (p) => {
      p.unrecognized = true;
    },
  ]) {
    const changed = JSON.parse(JSON.stringify(original));
    mutate(changed);
    assert.throws(() => checkTD054DeadlineProbe(changed));
  }
});

test('rejects changed reference or binary bytes rather than transferring prior qualification', () => {
  const first = fixture(),
    packet = first.packet();
  writeFileSync(first.request.appServer.path, 'changed');
  assert.throws(() => checkTD054DeadlineProbe(packet), /h04-pin-changed/u);
  const second = fixture(),
    next = second.packet();
  writeFileSync(second.reference.path, '{}');
  assert.throws(() => checkTD054DeadlineProbe(next), /h04-pin-changed/u);
});

test('rejects invalid bounds, missing quiet reserve, extra starts and inconsistent global window', () => {
  const f = fixture();
  for (const proposed of [
    null,
    [],
    {},
    { ...td054ProposedBounds, maxOutput: 0 },
    { ...td054ProposedBounds, maxElapsedMs: 2 ** 31 },
    { ...td054ProposedBounds, maxManagedStarts: 2 },
    { ...td054ProposedBounds, quietWindowMs: 15000 },
    { ...td054ProposedBounds, activeLoadByMs: 80000 },
  ])
    assert.throws(() => prepareTD054DeadlineProbe('td054-test', f.reference, proposed));
});

test('requires dedicated operation, Temporal reference and canonical packet schema', () => {
  const temporal = fixture(),
    legacy = fixture('legacy');
  assert.throws(() => prepareTD054DeadlineProbe('h06-rerun', temporal.reference));
  assert.throws(() => prepareTD054DeadlineProbe('td054-test', legacy.reference));
  for (const value of [null, [], 'packet']) assert.throws(() => checkTD054DeadlineProbe(value));
  const pin = { path: temporal.reference.path, sha256: '0'.repeat(64) };
  assert.throws(() => prepareTD054DeadlineProbe('td054-test', pin), /h04-pin-changed/u);
});

test('CLI writes a new immutable proposal, checks it and prints exact future grant bodies', async () => {
  const f = fixture(),
    output = join(f.root, 'packet.json');
  const prepared = await td054DeadlineProbeMain([
    '--prepare',
    f.reference.path,
    'td054-cli',
    output,
  ]);
  assert.equal(prepared.mayRun, false);
  assert.equal(
    (await td054DeadlineProbeMain(['--check', output])).requestHash,
    prepared.requestHash,
  );
  const plan = await td054DeadlineProbeMain(['--show-run-plan', output]);
  assert.equal(
    JSON.parse(plan.expectedGrantText).kind,
    'td054-native-load-deadline-authorization/1',
  );
  assert.equal(JSON.parse(plan.expectedNativeGrantText).kind, 'td054-native-load-deadline-grant/1');
  assert.equal(
    JSON.parse(plan.expectedServerGrantText).kind,
    'td054-native-load-deadline-server-grant/1',
  );
  await assert.rejects(
    () => td054DeadlineProbeMain(['--prepare', f.reference.path, 'td054-cli', output]),
    /EEXIST/u,
  );
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).operationId, 'td054-cli');
});

test('CLI rejects incomplete live and offline arguments', async () => {
  for (const args of [
    ['--run', '/missing'],
    ['--prepare'],
    ['--check'],
    ['--show-run-plan', '/missing', 'extra'],
    [],
  ])
    await assert.rejects(() => td054DeadlineProbeMain(args));
});

test('requires one current exact envelope with both sections before claim or process start', async () => {
  const f = fixture(),
    packet = f.packet(),
    plan = planTD054DeadlineProbe(packet);
  const sessions = join(f.root, 'sessions');
  mkdirSync(sessions);
  const filename = join(sessions, 'grant.jsonl');
  const previousHome = process.env.CODEX_HOME,
    previousThread = process.env.CODEX_THREAD_ID;
  process.env.CODEX_HOME = f.root;
  process.env.CODEX_THREAD_ID = 'fixture';
  const source = (body, role = 'user', superseded = false) => {
    const records = [
      {
        type: 'session_meta',
        payload: {
          id: 'fixture',
          session_id: 'fixture',
          cwd: f.request.chat.workspace,
          cli_version: '0.154.0',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      {
        type: 'turn_context',
        payload: {
          turn_id: 'turn',
          cwd: f.request.chat.workspace,
          model: 'fixture',
          effort: 'medium',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role, content: [{ type: 'input_text', text: body }] },
      },
      ...(superseded
        ? [
            {
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'later user request' }],
              },
            },
          ]
        : []),
    ].map((record) => JSON.stringify(record));
    writeFileSync(filename, records.join('\n') + '\n');
    return {
      transcript: filename,
      turnId: 'turn',
      source: { locator: filename + '#L4', hash: digest(records[3] + '\n') },
    };
  };
  const envelope = JSON.parse(plan.expectedGrantText),
    changedNative = JSON.parse(plan.expectedGrantText),
    changedServer = JSON.parse(plan.expectedGrantText);
  changedNative.native.requestHash = '0'.repeat(64);
  changedServer.server.budget.maxElapsedMs++;
  try {
    for (const [body, role, stale] of [
      [JSON.stringify(changedNative), 'user', false],
      [JSON.stringify(changedServer), 'user', false],
      [plan.expectedNativeGrantText, 'user', false],
      [plan.expectedServerGrantText, 'user', false],
      [JSON.stringify({ ...envelope, kind: 'comparison-h06-native-grant/2' }), 'user', false],
      [plan.expectedGrantText, 'assistant', false],
      [plan.expectedGrantText, 'user', true],
    ]) {
      await assert.rejects(() =>
        runTD054DeadlineProbe(
          packet,
          source(body, role, stale),
          new globalThis.AbortController().signal,
        ),
      );
      assert.equal((await import('node:fs')).existsSync(packet.evidenceRoot), false);
      assert.equal((await import('node:fs')).existsSync(packet.serverRoot), false);
    }
    const abort = new globalThis.AbortController();
    abort.abort(new Error('synthetic pre-start interruption'));
    await assert.rejects(
      () => runTD054DeadlineProbe(packet, source(plan.expectedGrantText), abort.signal),
      /synthetic pre-start interruption/u,
    );
    assert.equal((await import('node:fs')).existsSync(packet.evidenceRoot), false);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
  }
});

test('active backend policy with a missing diagnostic assignment blocks preparation', () => {
  const f = fixture();
  writeFileSync(
    join(f.request.binding.workspaceRoot, '.agent-workflow-backend.json'),
    JSON.stringify({ schemaVersion: 1, required: true }),
  );
  mkdirSync(join(f.request.binding.workspaceRoot, '.git/agent-workflow'));
  writeFileSync(
    join(f.request.binding.workspaceRoot, '.git/agent-workflow/backend-policy.json'),
    JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
  );
  assert.throws(f.packet, /backend-assignment/u);
});
