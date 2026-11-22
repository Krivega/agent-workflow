import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyCoder, type CoderAction, type CoderRun } from '../core/coder.js';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import { localTaskKey, parseLocalTask } from '../src/policy/localTask.js';
import { coderFixture } from './coderFixtures.js';
import { checkH06NativeHarness } from './comparisonH06NativeHarness.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

function directory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-harness-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const profile = { model: 'model', effort: 'medium', clientVersion: '0.154.0' };

function context(root: string, turn_id: string, selected = profile) {
  return {
    turn_id,
    cwd: root,
    model: selected.model,
    effort: selected.effort,
    approval_policy: 'never',
    sandbox_policy: {
      type: 'workspace-write',
      network_access: false,
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
    },
    permission_profile: {
      type: 'managed',
      network: 'restricted',
      file_system: {
        type: 'restricted',
        entries: [
          { access: 'read', path: { type: 'path', path: '/read' } },
          { access: 'write', path: { type: 'path', path: root } },
        ],
      },
    },
  };
}

function created(root: string, id: string, selected = profile) {
  return {
    thread: { id, projectId: null, parentThreadId: null, forkedFromId: null, turns: [] },
    cwd: root,
    model: selected.model,
    reasoningEffort: selected.effort,
    approvalPolicy: 'never',
    sandbox: {
      type: 'workspaceWrite',
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
      writableRoots: [root],
    },
  };
}

function pin(path: string, value: unknown) {
  const bytes = JSON.stringify(value);
  writeFileSync(path, bytes);
  return { path, sha256: digest(bytes) };
}

function completed(id: string, items: unknown[] = []) {
  return { id, status: 'completed', items };
}

function loadCommand(path: string, content: string) {
  return {
    type: 'commandExecution',
    status: 'completed',
    exitCode: 0,
    aggregatedOutput: JSON.stringify({ path, sha256: digest(content), content }) + '\n',
  };
}

function temporalFixture(bad?: string) {
  const root = directory();
  const evidence = join(root, 'evidence');
  mkdirSync(evidence);
  const artifactRoot = join(evidence, 'artifacts');
  const store = artifactStore(artifactRoot);
  const save = (value: unknown) => store.publish(Buffer.from(JSON.stringify(value)));
  const input = parseLocalTask({
    schemaVersion: 11,
    admission: {
      schemaVersion: 3,
      preparation: {
        schemaVersion: 1,
        project: {
          schemaVersion: 1,
          projectId: 'project',
          workspaceId: 'workspace',
          rules: ['RULES.md'],
          cardRoot: 'tasks',
          roles: [{ id: 'reviewer', profile: 'review.md' }],
          checks: ['syntax', 'validate'],
        },
        taskId: 'one',
        hostId: 'h06',
        owner: 'owner',
        generation: 2,
        revision: 1,
        card: 'tasks/one.md',
      },
      plan: { path: 'plan.json', sha256: digest('plan') },
      planning: save({}),
      acceptance: save({}),
    },
    executor: { path: 'executor.md', sha256: digest('executor') },
    baseline: 'syntax',
    continuation: { attempt: 0, previous: null },
  });
  const workspaceRoot = join(root, 'source');
  const copy = {
    root: join(
      artifactRoot,
      'copies',
      bad === 'copy' ? 'other' : digest(localTaskKey(input)) + '-a0',
    ),
    dev: '1',
    ino: '2',
  };
  const source = { root: workspaceRoot, dev: '1', ino: '1' };
  const started = pin(join(evidence, 'temporal-start.json'), {
    kind: 'h06-native-temporal-start',
    operationId: 'h06',
    workflowId: localTaskKey(input),
    workspaceRoot,
    input,
    artifactRoot,
    profile,
  });
  const original = {
    path: 'RULES.md',
    version: { content: store.publish(Buffer.from('rules')), mode: 0o644 },
  };
  const addition = {
    path: bad === 'scope' ? 'outside' : 'evidence/manifest.json',
    version: { content: store.publish(Buffer.from('{}')), mode: 0o644 },
  };
  const before = { files: [original], directories: [{ path: 'evidence', mode: 0o700 }] };
  const after = { files: [original, addition], directories: before.directories };
  const command = {
    executable: '/node',
    args: [bad === 'command' ? 'other.mjs' : 'checks.mjs'],
    timeoutMs: 10,
    sha256: digest('node'),
  };
  const snapshot = save({
    schemaVersion: 3,
    kind: 'substantial-task',
    input,
    copy,
    source,
    profile,
    tree: before,
    plan: {
      paths: ['evidence'],
      checks: ['validate'],
      requirement: { locator: 'RULES.md' },
      basis: [{ locator: 'RULES.md' }],
    },
    commands: { validate: command },
  });
  const session = 'writer';
  const first = completed('profile');
  const second = completed(
    'load',
    bad === 'load' ? [] : [loadCommand(join(copy.root, 'RULES.md'), 'rules')],
  );
  const third = completed('implement', bad === 'compacted' ? [{ type: 'contextCompaction' }] : []);
  const thread = { id: session, cwd: copy.root, turns: [first, second, third] };
  const load = { thread: { ...thread, turns: [first, second] }, turn: second };
  const ready = save({
    kind: 'task-writer-ready',
    input,
    session,
    loadTurnId: bad === 'ready' ? 'different' : second.id,
    load: save(load),
    grant: { sha256: digest('grant'), bytes: 5 },
  });
  const response = created(copy.root, session);
  if (bad === 'creation') response.sandbox.networkAccess = true;
  const effectiveProfiles = thread.turns.map(({ id }) =>
    save({
      kind: 'task-effective-profile',
      session,
      turnId: id,
      contexts: [
        context(copy.root, id, bad === 'profile' ? { ...profile, model: 'different' } : profile),
      ],
    }),
  );
  const result = save({
    session,
    tree: save(after),
    stop: save({
      kind: 'task-writers-stopped',
      schemaVersion: 2,
      confirmed: bad !== 'stop',
      session,
      input,
      copy,
      source,
      before: after,
      after,
      primary: { thread },
    }),
    answer: save({
      kind: 'task-writer-answer',
      input,
      ready,
      load,
      primary: { thread, turn: third },
      effectiveProfiles,
      created: save({ kind: 'task-writer-session', input, identity: { session }, raw: response }),
    }),
  });
  const checks = save({
    kind: 'task-checks',
    stage: 'candidate',
    status: 'PASS',
    snapshot,
    tree: after,
    input,
    outcomes: [
      {
        name: bad === 'check-inventory' ? 'syntax' : 'validate',
        status: 'PASS',
        proof: save({
          kind: 'task-check',
          name: 'validate',
          stage: 'candidate',
          status: 'PASS',
          input,
          command,
          code: bad === 'check-proof' ? 1 : 0,
          signal: null,
          error: null,
          before: after,
          after,
          stop: { confirmed: true, processes: [{ pid: 32, parent: 1, started: 'one' }] },
        }),
      },
    ],
  });
  return { variant: 'temporal', started, snapshot, result, checks };
}

it('joins the completed Temporal Writer, READY, primary LOAD, checks and stopped-tree diff', () => {
  expect(checkH06NativeHarness(temporalFixture())).toEqual({
    status: 'HARNESS_EVIDENCE_VERIFIED',
    variant: 'temporal',
    session: 'writer',
    loadTurn: 'load',
    implementationTurn: 'implement',
    checks: ['validate'],
    changed: ['evidence/manifest.json'],
    qualification: false,
  });
});

it.each([
  ['scope', 'h06-harness-temporal-diff'],
  ['load', 'reader-load-unconfirmed'],
  ['compacted', 'h06-harness-temporal-stop-turns'],
  ['ready', 'h06-harness-temporal-ready'],
  ['creation', 'h06-harness-creation'],
  ['profile', 'h06-harness-effective-profile'],
  ['stop', 'h06-harness-temporal-stop-turns'],
  ['check-inventory', 'h06-harness-temporal-check-inventory'],
  ['check-proof', 'h06-harness-temporal-check-proof'],
  ['copy', 'h06-harness-temporal-copy'],
  ['command', 'h06-harness-temporal-validation-command'],
])('rejects incomplete or crossed Temporal %s evidence', (bad, error) => {
  expect(() => checkH06NativeHarness(temporalFixture(bad))).toThrow(error);
});

async function legacyFixture(bad?: string) {
  const f = await coderFixture();
  cleanup.push(f.dispose);
  const directoryPath = directory();
  const path = bad === 'scope' ? 'second.txt' : 'evidence/manifest.json';
  const brief = { ...(await f.brief()), paths: [path], checks: ['node checks.mjs'] };
  const source = { root: brief.source_root, dev: 1, ino: 2 };
  const binding = { root: brief.copy_root, dev: 1, ino: 3 };
  const proof = (name: string, value: unknown) => {
    const file = pin(join(directoryPath, name + '.json'), value);
    return { locator: file.path, hash: file.sha256 };
  };
  const files = brief.files.map(({ locator, hash }) => ({
    path: locator,
    version: { content: { locator: join(brief.source_root, locator), hash }, mode: 0o644 },
  }));
  const baseline = {
    source,
    files,
    evidence: proof('baseline', { kind: 'coder-baseline', brief, source, files }),
  };
  let run: CoderRun = {
    schema_version: 1,
    brief,
    baseline,
    status: 'reserved',
    copy: null,
    session: null,
    writer: null,
    delivery: null,
    turn: null,
    result: null,
    stop_reason: null,
    stopped: null,
    integration: null,
    receipt: null,
    history: [],
  };
  const act = (action: CoderAction) => {
    run = applyCoder(run, { ...action, id: action.type, generation: brief.generation });
  };
  act({ type: 'COPY_INTENT' });
  const copy = {
    binding,
    directories: [],
    evidence: proof('copy', {
      kind: 'coder-copy',
      baseline: baseline.evidence,
      binding,
      directories: [],
    }),
  };
  act({ type: 'COPIED', copy });
  act({ type: 'CREATE_INTENT' });
  const session = await f.session(run);
  const selected = { ...profile, ...brief.profile };
  session.receipt = proof('create', { result: created(brief.copy_root, session.id, selected) });
  act({ type: 'BIND', session });
  act({ type: 'LOAD_INTENT' });
  const transcript = join(directoryPath, 'native.jsonl');
  const records = ['probe', 'load', 'implement'].map((id) => ({
    type: 'turn_context',
    payload: context(
      brief.copy_root,
      id,
      bad === 'profile' ? { ...selected, model: 'other' } : selected,
    ),
  }));
  const lines = records.map((row) => JSON.stringify(row) + '\n');
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: bad === 'session' ? 'other' : session.id,
        session_id: session.id,
        cwd: brief.copy_root,
      },
    }) +
      '\n' +
      lines.join(''),
  );
  const contexts = records.map((record, index) => ({
    record,
    ref: { locator: transcript + '#L' + (index + 2), hash: digest(lines[index]!) },
  }));
  const profileRef = (expected: string, count: number) =>
    proof(expected + '-profile', {
      kind: 'coder-profile',
      session: session.id,
      creation: session.receipt,
      expected_turn: expected,
      operation: brief.id,
      policy: session.policy,
      bindings: [],
      contexts: contexts.slice(0, count),
    });
  const first = profileRef('probe', 1);
  const last = profileRef('load', contexts.length);
  const procedures = run.writer!.spec.procedures;
  const refs = [...procedures, ...brief.rules].map(({ locator, hash }) => ({ locator, hash }));
  const { readFile } = await import('node:fs/promises');
  const commands = await Promise.all(
    refs.map(async ({ locator }) =>
      loadCommand(locator, await readFile(join(brief.source_root, locator), 'utf8')),
    ),
  );
  const load = proof('load', {
    session: session.id,
    turn: 'load',
    refs,
    creation: session.receipt,
    observation: completed('load', bad === 'load' ? [] : commands),
  });
  const origin = proof('origin', { creation: session.receipt, profile: first, load });
  act({
    type: 'LOADED',
    receipt: {
      run_id: run.writer!.spec.run_id,
      session_id: session.id,
      procedures,
      rules: brief.rules,
      observed_read: load.locator,
      native: load,
      origin,
    },
  });
  act({ type: 'SEND_INTENT', delivery: 'coder:one:implementation' });
  act({ type: 'SENT', turn: 'implement' });
  const command = {
    type: 'commandExecution',
    status: 'completed',
    command: brief.checks[0]!,
    exitCode: bad === 'check' ? 1 : 0,
  };
  const result = proof('result', {
    session: session.id,
    turn: completed('implement', [command]),
    profile: last,
    errors: [],
  });
  act({
    type: 'RESULT',
    result: {
      outcome: 'PASS',
      evidence: result,
      checks: [{ command: command.command, exit_code: 0, evidence: proof('check', command) }],
      errors: [],
      limitations: [],
    },
  });
  act({ type: 'STOP_INTENT', reason: 'complete' });
  const stopped = proof('stopped', {
    kind: 'writers-stopped',
    thread: session.id,
    active_turn: false,
    remaining_processes: bad === 'stop' ? 1 : 0,
    remaining_terminals: 0,
    before_hash: digest('scope'),
    after_hash: digest('scope'),
    owned: {
      tree: brief.copy_root,
      thread: session.id,
      turn: 'implement',
      complete: true,
      markers: [copy.evidence.locator, session.receipt.locator],
    },
  });
  act({ type: 'STOPPED', receipt: stopped });
  act({ type: 'RELEASE' });
  const newFile = join(directoryPath, 'manifest');
  writeFileSync(newFile, '{}');
  const changes = [
    {
      path,
      before: files.find((file) => file.path === path)?.version ?? null,
      after: { content: { locator: newFile, hash: digest('{}') }, mode: 0o644 },
    },
  ];
  const intent = {
    operation: 'coder:one:integrate',
    project_id: brief.project_id,
    task_id: brief.task_id,
    parent_run_id: brief.parent_run_id,
    generation: brief.generation,
    source,
    copy: binding,
    result,
    stopped,
    changes,
  };
  const evidence = proof('intent', { kind: 'coder-integration-intent', ...intent });
  act({ type: 'INTEGRATE_INTENT', intent: { ...intent, evidence } });
  const integrated = proof('integrated', {
    kind: 'coder-integrated',
    intent: evidence,
    operation: bad === 'integrated' ? 'other' : intent.operation,
    changes,
  });
  act({ type: 'INTEGRATED', receipt: integrated });
  return {
    variant: 'legacy',
    coder: pin(join(directoryPath, 'coder.json'), run),
    integrated: { path: integrated.locator, sha256: integrated.hash },
  };
}

it('joins the completed Legacy Writer, native LOAD and check items to the accepted diff', async () => {
  expect(checkH06NativeHarness(await legacyFixture())).toMatchObject({
    status: 'HARNESS_EVIDENCE_VERIFIED',
    variant: 'legacy',
    loadTurn: 'load',
    implementationTurn: 'implement',
    checks: ['node checks.mjs'],
    changed: ['evidence/manifest.json'],
    qualification: false,
  });
});

it.each([
  ['scope', 'h06-harness-legacy-diff'],
  ['load', 'procedure-read-unconfirmed'],
  ['profile', 'h06-harness-effective-profile'],
  ['check', 'h06-harness-legacy-check-proof'],
  ['stop', 'h06-harness-legacy-stop'],
  ['integrated', 'h06-harness-legacy-integration'],
  ['session', 'h06-harness-legacy-context-session'],
])('rejects incomplete or crossed Legacy %s evidence', async (bad, error) => {
  const awaitedFixture = await legacyFixture(bad);
  expect(() => checkH06NativeHarness(awaitedFixture)).toThrow(error);
});
