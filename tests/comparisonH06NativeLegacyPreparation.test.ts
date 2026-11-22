import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { taskChatGates } from '../cli/taskChatInputs.js';
import type { RunSpec } from '../core/localRun.js';
import { object } from '../src/contracts/project.js';
import { readH04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import { beginH06NativeAttempt, planH06NativeAttempt } from './comparisonH06NativeAttempt.js';
import { observeH06NativeFailure } from './comparisonH06NativeFailure.js';
import { prepareH06NativeLegacy } from './comparisonH06NativeLegacyPreparation.js';
import { grant, signed } from './storageFixtures.js';
import { workflowFixture } from './workflowFixtures.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  option?:
    'missing-load' | 'stale-turn' | 'other-model' | 'unbound-input' | 'execution' | 'no-validate',
) {
  const f = await workflowFixture();
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-legacy-preparation-'));
  cleanups.push(f.dispose, () => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  const chat = join(root, 'chat');
  for (const directory of [sessions, chat]) mkdirSync(directory);
  const materials = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  const material = materials.cases.find(({ id }) => id === 'H-06')!.files;
  for (const [path, body] of Object.entries(material)) await f.file(path, body);
  const commands = Object.keys(object(object(JSON.parse(material['package.json']!)).scripts));
  await f.file('connection.json', JSON.stringify({ ...f.connection, commands }));
  const planningFile = 'planning.json';
  await f.file(
    planningFile,
    JSON.stringify({ schema_version: 1, task_id: 'task', council: f.council('planning') }),
  );
  const connection = await new FileTaskConnection(f.root).preview(
    'connection.json',
    f.card.locator,
    grant.context.task_id,
  );
  await f.file(f.card.locator, connection.after);
  const spec: RunSpec = {
    ...f.spec,
    identity: { task_id: grant.context.task_id, card: await f.ref(f.card.locator) },
    host_id: 'local',
    session_id: grant.context.actor_id,
    requested: {
      ...f.spec.requested,
      permissions: [...f.spec.requested.permissions, 'implement'],
    },
    route: { kind: 'substantial', accepted_plan: await f.ref(planningFile) },
  };
  const marker = 'h06-native-load';
  const pin = (path: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const input = pin(join(root, 'preparation.json'), {
    kind: 'comparison-h06-native-legacy-preparation/2',
    descriptor: 'connection.json',
    planningFile,
    marker,
    spec,
    ...(option === 'execution' ? { gates: taskChatGates(spec.criteria, [spec.criteria[0]!]) } : {}),
    ...(option === 'no-validate' ? { gates: [] } : {}),
  });
  const request = {
    kind: 'comparison-h06-native/2',
    binding: {
      operationId: 'task',
      variant: 'legacy' as const,
      workspaceRoot: f.root,
      node: pin(join(root, 'node'), 'node'),
      timeoutMs: 2000,
    },
    evidenceRoot: join(root, 'task'),
    chat: { threadId: 'controller', workspace: chat },
    budget: {
      maxElapsedMs: 180000,
      reserveMs: 30000,
      maxManagedStarts: 12,
      maxInputUncached: 10000,
      maxOutput: 3000,
    },
    stimulus: { longStageMs: 35000, initialLeaseMs: 20000 },
    appServer: pin(join(root, 'app-server'), 'app-server'),
    server: null,
    bootstrap: pin(join(root, 'bootstrap.json'), {
      kind: 'comparison-h06-native-legacy-bootstrap/2',
      projectId: grant.context.project_id,
      runId: grant.context.run_id,
      actorId: grant.context.actor_id,
      generation: 1,
      permissions: grant.permissions,
    }),
    runtime: option === 'unbound-input' ? [pin(join(root, 'other.json'), 'other')] : [input],
  };
  const native = (thread: string, workspace: string, model: string) => [
    {
      type: 'session_meta',
      payload: { id: thread, session_id: thread, cwd: workspace, cli_version: '0.154.0' },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'turn_context',
      payload: {
        turn_id: 'turn',
        cwd: workspace,
        model,
        effort: 'high',
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
      },
    },
  ];
  vi.stubEnv('CODEX_HOME', root);
  vi.stubEnv('CODEX_THREAD_ID', request.chat.threadId);
  const controller = join(sessions, 'controller.jsonl');
  const user = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: planH06NativeAttempt(request).expectedGrantText }],
    },
  });
  writeFileSync(
    controller,
    [
      ...native(request.chat.threadId, chat, 'fixture').map((entry) => JSON.stringify(entry)),
      user,
    ].join('\n') + '\n',
  );
  const claim = await beginH06NativeAttempt(request, {
    transcript: controller,
    turnId: 'turn',
    source: { locator: controller + '#L4', hash: digest(user + '\n') },
  });
  const storeRoot = join(request.evidenceRoot, 'legacy-store');
  initializeStore(storeRoot, grant.context);
  const store = new SqliteEvidenceStore(storeRoot, grant, Date.now);
  unwrap(store.execute(signed({ type: 'claim', lease_until: Date.now() + 600000 }, 0, 0, 'init')));
  const f01 = join(request.evidenceRoot, 'f01');
  mkdirSync(f01);
  const before = observeH06NativeFailure(f.root);
  const initialFailure = pin(join(f01, 'receipt.json'), {
    kind: 'h06-native-f01',
    binding: request.binding,
    before,
    after: before,
    outcome: {
      command: {
        executable: request.binding.node.path,
        sha256: request.binding.node.sha256,
        args: ['checks.mjs'],
        timeoutMs: 2000,
      },
      stop: { confirmed: true, processes: [{}] },
      code: 1,
      signal: null,
      error: null,
      log: `Error: ENOENT: no such file or directory, open '${before.missingManifest}'`,
    },
  });
  const actor = grant.context.actor_id;
  vi.stubEnv('CODEX_THREAD_ID', actor);
  const transcript = join(sessions, 'actor.jsonl');
  const reads = [...spec.rules, ...spec.procedures].map(({ locator, hash }) =>
    JSON.stringify({
      chat_read: marker,
      locator,
      hash,
      content: readFileSync(join(f.root, locator), 'utf8'),
    }),
  );
  writeFileSync(
    transcript,
    [
      ...native(actor, f.root, option === 'other-model' ? 'other' : spec.requested.model),
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: actor,
          turn_id: 'turn',
          item: {
            type: 'CommandExecution',
            cwd: f.root,
            status: 'completed',
            exit_code: 0,
            aggregated_output: option === 'missing-load' ? '' : reads.join('\n'),
          },
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  const anchor = {
    thread_id: actor,
    turn_id: option === 'stale-turn' ? 'stale' : 'turn',
    host_id: 'local' as const,
    workspace: f.root,
  };
  const state = () =>
    unwrap(
      store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    );
  return {
    value: { claim: claim.receipt, input, initialFailure, transcript, anchor },
    state,
    request,
    f,
    storeRoot,
    intent: join(request.evidenceRoot, 'legacy-preparation-intent.json'),
  };
}

it('prepares the claimed Store with confirmed native LOAD and READY exactly once', async () => {
  const f = await fixture();
  const verify = vi.fn();
  const { request, ready } = await prepareH06NativeLegacy(f.value, verify);
  expect(request.storage).toEqual({ root: f.storeRoot, grant });
  expect(ready.run).toMatchObject({
    status: 'ready',
    loaded: { run_id: 'run', session_id: grant.context.actor_id },
  });
  expect(ready.run.history.map(({ payload }) => object(JSON.parse(payload)).type)).toEqual([
    'WAIT',
    'LOAD',
    'READY',
  ]);
  const state = f.state();
  expect(state).toMatchObject({
    checkpoint: { chat_control: { status: 'active' }, chat_messages: { task_id: 'task' } },
  });
  await expect(prepareH06NativeLegacy(f.value, verify)).rejects.toThrow(
    'h06-legacy-preparation-store',
  );
  expect(f.state()).toEqual(state);
});

it.each([
  ['missing-load', 'chat-load-incomplete'],
  ['stale-turn', 'chat-identity-mismatch'],
  ['other-model', 'h06-legacy-preparation-profile'],
  ['unbound-input', 'h06-legacy-preparation-attempt'],
  ['no-validate', 'h06-legacy-preparation-gates'],
] as const)('rejects %s before changing the Store', async (option, error) => {
  const f = await fixture(option);
  const state = f.state();
  await expect(prepareH06NativeLegacy(f.value, () => {})).rejects.toThrow(error);
  expect(f.state()).toEqual(state);
  expect(existsSync(f.intent)).toBe(false);
});

it('records the accepted planning event before allowing the Writer phase', async () => {
  const f = await fixture('execution');
  const { execution, ready } = await prepareH06NativeLegacy(f.value, () => {});
  expect(execution).toMatchObject({
    status: 'implementing',
    task_id: grant.context.task_id,
    generation: ready.run.generation,
    history: [{ type: 'PLAN' }],
    gates: [
      { id: ready.run.spec.criteria[0], kind: 'human', applicable: true },
      { id: 'validate', kind: 'check', applicable: true },
    ],
  });
  expect(f.state()).toMatchObject({
    checkpoint: { workflow: { execution: { status: 'implementing' } } },
  });
});

it('retains the attempt and rejects replay after an interrupted preparation', async () => {
  const f = await fixture();
  const state = f.state();
  await expect(
    prepareH06NativeLegacy(f.value, () => {
      if (existsSync(f.intent)) throw new Error('fixture-lease-lost');
    }),
  ).rejects.toThrow('fixture-lease-lost');
  expect(existsSync(f.intent)).toBe(true);
  expect(f.state()).toEqual(state);
  await expect(prepareH06NativeLegacy(f.value, () => {})).rejects.toThrow('EEXIST');
  expect(f.state()).toEqual(state);
});
