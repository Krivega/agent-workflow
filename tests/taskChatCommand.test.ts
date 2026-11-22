// @vitest-defer: multi-step CLI scenarios need the machine after other tool suites finish.
import process from 'node:process';
import type { ChatCheckProof } from '../adapters/project/chatChecks.js';
import type { Execution, ExecutionAction } from '../core/execution.js';
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { declareBackendFixture } from './backendPolicyFixture.js';
import { reserveTaskBackend } from '../src/adapters/project/taskBackend.js';
import { resolve, dirname } from 'node:path';
import metadata from '../package.json' with { type: 'json' };
import { executionEvent, designReviewFixture, workflowFixture } from './workflowFixtures.js';
import { runTaskChatCommand } from '../cli/taskChatCommand.js';
import { taskChatOptions, taskChatBrief, taskChatGates } from '../cli/taskChatInputs.js';
import {
  readCardMarkdown,
  adoptCardMarkdown,
  projectCardStatus,
} from '../adapters/project/cardMarkdown.js';
import {
  councilRoles,
  configuredRoles,
  selectedRole,
  createCouncil,
  councilProfileRefs,
  assignAdviser,
  answerCouncil,
  councilReviewRequest,
} from '../core/council.js';
import type { Council } from '../core/council.js';
import { startLocalRun, applyLocalEvent } from '../core/localRun.js';
import type { RunSpec, LocalRun } from '../core/localRun.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import type { ChatMessageEvent } from '../core/chatMessages.js';
import * as runtime from '../cli/chatRuntime.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { bindChatEvidence } from '../adapters/storage/chatWriter.js';
import type { EvidenceGrant, TechnicalState } from '../core/evidence.js';
import * as messages from '../application/chatMessages.js';
import type { Mock } from 'vitest';
import type { runTaskChatCouncil } from '../cli/taskChatCouncil.js';
import type { startPreparedLocalTask } from '../src/client/localTask.js';
import { saveCouncilProgress } from '../cli/councilProgress.js';
import { localPlanningRisks } from '../core/localRun.js';
import { object, textField } from '../core/connection.js';
import * as projectFiles from '../adapters/project/projectFiles.js';
const backend = vi.hoisted(
  (): { council: Mock<typeof runTaskChatCouncil>; verdict: 'PASS' | 'FAIL' } => ({
    council: vi.fn<typeof runTaskChatCouncil>(),
    verdict: 'PASS',
  }),
);
vi.mock('../cli/taskChatCouncil.js', () => ({
  runTaskChatCouncil: backend.council,
}));
const temporalStart = vi.hoisted(() => vi.fn<typeof startPreparedLocalTask>());
vi.mock('@krivega/agent-workflow/local-task', () => ({ startPreparedLocalTask: temporalStart }));
let f: Awaited<ReturnType<typeof workflowFixture>>, state: string, transcript: string;
let records: Record<string, unknown>[], turn: string;
const card = 'docs/exec-plans/active/task.md';
async function flush() {
  await writeFile(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
async function context(next = 'turn', human = true) {
  turn = next;
  records.push(
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: human ? 'user' : 'developer',
        content: [{ type: 'input_text', text: 'Явно разрешённая задача и совет' }],
      },
    },
    {
      type: 'turn_context',
      payload: {
        turn_id: turn,
        cwd: f.root,
        model: 'fixture-model',
        effort: 'high',
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
      },
    },
  );
  await flush();
}
async function invokeTaskChat(args: string[]) {
  const output: string[] = [],
    errors: string[] = [];
  const code = await runTaskChatCommand(
    args,
    f.root,
    (s) => output.push(s),
    (s) => errors.push(s),
  );
  return { code, output, errors };
}
async function invoke(action: string, ...args: string[]) {
  return invokeTaskChat([action, '--state', state, ...args]);
}
async function loadAll() {
  for (let i = 0; i < 30; i++) {
    const result = await invoke('load');
    expect(result.errors).toEqual([]);
    if (result.output.length === 0) return;
    records.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'session',
        turn_id: turn,
        item: {
          type: 'CommandExecution',
          cwd: f.root,
          exit_code: 0,
          status: 'completed',
          aggregated_output: result.output.join('\n'),
        },
      },
    });
    await flush();
  }
  throw new Error('LOAD did not finish');
}
async function start() {
  const skip = councilRoles
    .filter((r) => r !== 'architect')
    .flatMap((r) => ['--skip-role', `${r}:Вне предмета проверки`]);
  return invoke(
    'start',
    '--card',
    card,
    '--plan',
    'proposal.md',
    '--source',
    'source.txt',
    ...skip,
  );
}
it('starts with a root project descriptor and pins its runtime without rebasing resources', async () => {
  const oldDescriptor = resolve(f.root, 'tools/agent-workflow/project/workflow.json');
  await f.file('project/workflow.json', await readFile(oldDescriptor, 'utf8'));
  await rm(oldDescriptor);
  await f.file('CURRENT-CHAT.md', '# Current chat\n');
  expect((await start()).errors).toEqual([]);
  const managedPath = resolve(state, 'managed-chat.json');
  const managed = readManaged<{
    root: string;
    runtime_package_version: string;
    request: { descriptor: string };
  }>(managedPath)!;
  expect(managed.runtime_package_version).toBe(metadata.version);
  expect(managed.request.descriptor).toBe('project/workflow.json');
  expect(managed.root).toBe(f.root);
  await loadAll();
  expect(readManaged<typeof managed>(managedPath)!.runtime_package_version).toBe(metadata.version);
});
it.each(['missing', 'temporal'] as const)(
  'rejects a %s backend before creating managed state',
  async (backend) => {
    execFileSync('git', ['init', '-q'], { cwd: f.root });
    declareBackendFixture(f.root);
    await f.file(
      '.git/agent-workflow/backend-policy.json',
      JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
    );
    if (backend === 'temporal')
      reserveTaskBackend(f.root, {
        schemaVersion: 1,
        projectId: 'project',
        taskId: 'task',
        backend,
        cardName: 'task.md',
        origin: 'a'.repeat(64),
      });
    const before = await readdir(state);
    const result = await start();
    expect(result.code).toBe(1);
    expect(result.errors.join('\n')).toContain(
      backend === 'missing' ? 'backend-assignment-required' : 'backend-route-conflict',
    );
    expect(await readdir(state)).toEqual(before);
  },
);
it('checks saved managed identity for continue and repeated start before any write', async () => {
  expect((await start()).errors).toEqual([]);
  const path = resolve(state, 'managed-chat.json');
  const before = await readFile(path, 'utf8');
  const managed = readManaged<{ request: { storage: { grant: EvidenceGrant } } }>(path)!;
  const identity = managed.request.storage.grant.context;
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  declareBackendFixture(f.root);
  await f.file(
    '.git/agent-workflow/backend-policy.json',
    JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
  );
  reserveTaskBackend(f.root, {
    schemaVersion: 1,
    projectId: identity.project_id,
    taskId: identity.task_id,
    backend: 'temporal',
    cardName: 'task.md',
    origin: 'a'.repeat(64),
  });
  for (const action of ['continue', 'start']) {
    expect((await invoke(action)).errors.join('\n')).toContain('backend-route-conflict');
    expect(await readFile(path, 'utf8')).toBe(before);
  }
});

describe('task-chat Temporal start', () => {
  const inputPath = 'temporal-input.json';
  const input = { schemaVersion: 12, startAdmission: { id: 'admission' } };
  const registration = { schemaVersion: 1, taskQueue: 'task-queue' };
  const policyPath = '.git/agent-workflow/backend-policy.json';
  const policy = {
    schemaVersion: 2,
    newTasks: 'temporal',
    startAdmission: 'task-start-admission/1',
  };
  const settingsPath = () => resolve(state, 'registration.json');
  const flags = (path = settingsPath()) => [
    '--temporal-input',
    inputPath,
    '--temporal-registration',
    path,
  ];

  beforeEach(async () => {
    execFileSync('git', ['init', '-q'], { cwd: f.root });
    declareBackendFixture(f.root);
    await f.file(policyPath, JSON.stringify(policy));
    await f.file(inputPath, JSON.stringify(input));
    await writeFile(settingsPath(), JSON.stringify(registration), { mode: 0o600 });
  });

  async function refuse(args: string[], reason: string) {
    const before = await readdir(state);
    expect(await invokeTaskChat(['start', ...args])).toMatchObject({ code: 1, errors: [reason] });
    expect(temporalStart).not.toHaveBeenCalled();
    expect(backend.council).not.toHaveBeenCalled();
    expect(await readdir(state)).toEqual(before);
    expect(await readdir(resolve(f.root, '.git/agent-workflow'))).not.toContain(
      'backend-assignments',
    );
  }

  it.each([false, true])(
    'passes the same input and registration to the SDK with flags reversed=%s',
    async (reverse) => {
      const args = flags();
      const result = {
        status: 'accepted',
        backend: 'temporal',
        workflowId: 'aw/task/project/task',
      };
      temporalStart.mockResolvedValueOnce(result);
      expect(
        await invokeTaskChat([
          'start',
          ...(reverse ? [...args.slice(2), ...args.slice(0, 2)] : args),
        ]),
      ).toEqual({
        code: 0,
        errors: [],
        output: [JSON.stringify(result)],
      });
      expect(temporalStart).toHaveBeenCalledExactlyOnceWith(f.root, input, registration);
      expect(backend.council).not.toHaveBeenCalled();
      expect(await readdir(state)).toEqual(['registration.json']);
    },
  );

  it.each<[string, ...string[]]>([
    ['part of the argument pair', '--temporal-input', inputPath],
    ['duplicate options', '--temporal-input', inputPath, '--temporal-input', inputPath],
    ['legacy first', '--state', 'unused', '--temporal-registration', 'unused'],
    ['legacy second', '--temporal-input', inputPath, '--state', 'unused'],
    ['empty input', '--temporal-input', '', '--temporal-registration', 'unused'],
    ['empty registration', '--temporal-input', inputPath, '--temporal-registration', ''],
    ['input is an option', '--temporal-input', '--unused', '--temporal-registration', 'unused'],
    [
      'registration is an option',
      '--temporal-input',
      inputPath,
      '--temporal-registration',
      '--unused',
    ],
  ])('rejects %s before opening the SDK', async (_case, ...args) => {
    await refuse(args, 'task-chat-temporal-input-required');
  });

  it.each(['absent', 'version 1', 'blocked'] as const)(
    'rejects Temporal start with %s policy',
    async (mode) => {
      if (mode === 'absent') {
        for (const path of [
          policyPath,
          '.agent-workflow-backend.json',
          '.git/agent-workflow-backend.json',
        ])
          await rm(resolve(f.root, path));
      } else {
        await f.file(
          policyPath,
          JSON.stringify(
            mode === 'blocked'
              ? { ...policy, newTasks: 'blocked' }
              : { schemaVersion: 1, newTasks: 'temporal' },
          ),
        );
      }
      await refuse(
        flags(),
        mode === 'blocked' ? 'backend-new-tasks-blocked' : 'task-start-policy-required',
      );
    },
  );

  it.each([
    'workspace root',
    'inside workspace',
    'directory',
    'symlink',
    'hardlink',
    'other owner',
    'public mode',
  ] as const)('rejects non-private registration: %s', async (kind) => {
    let path = settingsPath();
    switch (kind) {
      case 'workspace root':
        path = f.root;
        break;
      case 'inside workspace':
        path = resolve(f.root, inputPath);
        break;
      case 'directory':
        path = state;
        break;
      case 'symlink':
        path = resolve(state, 'linked-registration.json');
        await symlink(settingsPath(), path);
        break;
      case 'hardlink':
        await link(path, resolve(state, 'linked-registration.json'));
        break;
      case 'other owner':
        vi.spyOn(process, 'getuid').mockReturnValue(999999);
        break;
      case 'public mode':
        await chmod(path, 0o644);
        break;
    }
    await refuse(flags(path), 'task-chat-temporal-registration-private');
  });
});

async function revise(...args: string[]) {
  const skip = councilRoles
    .filter((role) => role !== 'architect')
    .flatMap((role) => ['--skip-role', `${role}:Вне предмета проверки`]);
  return invoke('revise', ...args, ...skip);
}

async function startCompact(initialize = start) {
  expect((await initialize()).output.join('\n')).toContain('LOAD_REQUIRED');
  const path = resolve(state, 'managed-chat.json');
  const pending = readManaged<{ request: { spec: RunSpec } }>(path)!;
  pending.request.spec.context_loading = 'fragments-v1';
  saveManaged(path, pending, true, 'minimal');
  await loadAll();
  const initialized = await initialize();
  expect(initialized.errors).toEqual([]);
  expect(initialized.code).toBe(0);
  expect(initialized.output.join('\n')).toContain('implementing');
  records.push({ type: 'compacted', payload: {} });
  await flush();
  return path;
}
it('loads a new v3 run after compaction through the managed CLI without upgrading an existing run', async () => {
  await startCompact();
  const needed = await invoke('continue');
  expect(needed.errors).toEqual([]);
  expect(needed.output.join('\n')).toContain('LOAD_REQUIRED');
  await loadAll();
  expect(records.some((record) => JSON.stringify(record).includes('chat_compact'))).toBe(true);
  const result = await invoke('continue');
  expect(result.errors).toEqual([]);
  expect(result.output.join('\n')).toContain('ready');
  const actual = readManaged<Record<string, unknown>>(resolve(state, 'request.json'))!;
  expect(await runtime.executeChatRequest('status-chat', actual)).toMatchObject({
    local: { schema_version: 3, loaded: { compact: { action: 'continue-chat' } } },
  });
});

it('starts a new v3 run with full initial LOAD after a historical compaction', async () => {
  records.push({ type: 'compacted', payload: {} });
  await flush();
  await startCompact();
  expect((await invoke('continue')).output.join('\n')).toContain('LOAD_REQUIRED');
  await loadAll();
  const result = await invoke('continue');
  expect(result.errors).toEqual([]);
  expect(result.output.join('\n')).toContain('ready');
  const request = readManaged<Record<string, unknown>>(resolve(state, 'request.json'))!;
  expect(await runtime.executeChatRequest('status-chat', request)).toMatchObject({
    local: { schema_version: 3, loaded: { compact: { action: 'continue-chat' } } },
  });
});

it('keeps v3 readable through waiting, local bootstrap and compact continuation', async () => {
  const skip = await localPlan();
  await startCompact(() =>
    invoke(
      'start',
      '--card',
      card,
      '--local-plan',
      'local.json',
      '--target',
      'source.txt',
      ...skip,
    ),
  );
  expect(backend.council).not.toHaveBeenCalled();
  expect((await invoke('continue')).output.join('\n')).toContain('LOAD_REQUIRED');
  await loadAll();
  const continued = await invoke('continue');
  expect(continued.errors).toEqual([]);
  expect(continued.output.join('\n')).toContain('ready');
  const request = readManaged<Record<string, unknown>>(resolve(state, 'request.json'))!;
  expect(await runtime.executeChatRequest('status-chat', request)).toMatchObject({
    local: {
      schema_version: 3,
      format: 'compact-context',
      spec: { route: { kind: 'local' } },
      loaded: { compact: { action: 'continue-chat' } },
    },
  });
});

it.each(['missing', 'mismatch'])(
  'continues through full R1 while the %s fragment catalog remains unusable',
  async (kind) => {
    const descriptor = 'tools/agent-workflow/project/workflow.json';
    const connection = JSON.parse(
      await readFile(resolve(f.root, descriptor), 'utf8'),
    ) as typeof f.connection;
    const bootstrap = connection.procedures.find((procedure) => procedure.id === 'bootstrap')!;
    if (kind === 'missing') delete bootstrap.fragments;
    else bootstrap.fragments = ['bootstrap.absent'];
    await f.file(descriptor, JSON.stringify(connection));
    await startCompact();
    expect((await invoke('continue')).output.join('\n')).toContain('LOAD_REQUIRED');
    await loadAll();
    const result = await invoke('continue');
    expect(result.errors).toEqual([]);
    expect(result.output.join('\n')).toContain('ready');
    const request = readManaged<Record<string, unknown>>(resolve(state, 'request.json'))!;
    const status = (await runtime.executeChatRequest('status-chat', request)) as {
      local: LocalRun;
    };
    expect(status.local.loaded!.compact).toBeUndefined();
    expect(status.local.loaded!.compact_fallback).toBe(
      kind === 'missing' ? 'compact-rule-catalog-missing' : 'compact-rule-catalog-mismatch',
    );
  },
);

it('loads directly after compaction before continuing the current action', async () => {
  const path = await startCompact();
  const pending = readManaged<{ request: { load_action?: string } }>(path)!;
  delete pending.request.load_action;
  saveManaged(path, pending, true, 'minimal');
  await loadAll();
  const result = await invoke('continue');
  expect(result.errors).toEqual([]);
  expect(result.output.join('\n')).toContain('ready');
});

it('requires LOAD when the compact reader reports an unknown outcome', async () => {
  await startCompact();
  const original = runtime.executeChatRequest;
  const fault = vi
    .spyOn(runtime, 'executeChatRequest')
    .mockImplementation((command, request) =>
      command === 'compact-context-chat'
        ? Promise.resolve({ outcome: 'unknown' as const })
        : original(command, request),
    );
  try {
    const needed = await invoke('continue');
    expect(needed.errors).toEqual([]);
    expect(needed.output.join('\n')).toContain(
      'Не подтверждено чтение краткого контекста текущего действия.',
    );
    expect(needed.output.join('\n')).toContain('LOAD_REQUIRED');
  } finally {
    fault.mockRestore();
  }
});

it.each([new Error('compact renderer unavailable'), 'unknown'])(
  'recovers a failed compact renderer through observed full LOAD: %s',
  async (failure) => {
    await startCompact();
    const original = runtime.executeChatRequest;
    const fault = vi
      .spyOn(runtime, 'executeChatRequest')
      .mockImplementation((command, request) =>
        command === 'compact-context-chat' ? Promise.reject(failure) : original(command, request),
      );
    try {
      const needed = await invoke('continue');
      expect(needed.errors).toEqual([]);
      expect(needed.output.join('\n')).toContain(
        failure instanceof Error ? failure.message : 'chat-compact-outcome-unknown',
      );
      await loadAll();
    } finally {
      fault.mockRestore();
    }
    const result = await invoke('continue');
    expect(result.errors).toEqual([]);
    expect(result.output.join('\n')).toContain('ready');
  },
);
beforeEach(async () => {
  backend.verdict = 'PASS';
  f = await workflowFixture();
  state = await mkdtemp(resolve(dirname(f.root), 'managed-chat-'));
  transcript = resolve(f.root, 'native/sessions/rollout-test-session.jsonl');
  await mkdir(dirname(transcript), { recursive: true });
  await f.file(
    'tools/agent-workflow/project/workflow.json',
    await readFile(resolve(f.root, 'connection.json'), 'utf8'),
  );
  await f.file(
    card,
    '# Задача\n\n- **Статус:** `active`\n\n## Цель\n\nПроверяемый результат\n\n## Границы\n\n- source.txt\n\n## Критерии\n\n- [ ] C1: результат проверен\n',
  );
  await f.file('proposal.md', '# Предметный план\nИсправить source.txt, проверить результат.\n');
  records = [
    {
      type: 'session_meta',
      payload: {
        id: 'session',
        session_id: 'session',
        cli_version: '0.163.0-alpha.10.2',
        cwd: f.root,
      },
    },
  ];
  await context();
  vi.stubEnv('CODEX_HOME', resolve(f.root, 'native'));
  vi.stubEnv('CODEX_THREAD_ID', 'session');
  backend.council.mockImplementation(
    async (
      value: Council,
      spec: RunSpec,
      _directory: string,
      _binary: string,
      save: (v: Council) => void,
    ) => {
      let council = value;
      for (const role of configuredRoles(value.configuration)) {
        const selection = selectedRole(value.selection, role);
        if (!selection.trigger || value.advisers[role]?.status === 'answered') continue;
        const session = `adviser-${role}`;
        const rules = councilProfileRefs(role, selection.requirements, value.configuration);
        const roleSpec: RunSpec = {
          ...spec,
          parent_run_id: spec.run_id,
          run_id: session,
          session_id: session,
          role: 'council-adviser',
          product: false,
          writer: session,
          requested: { model: 'fixture', effort: 'high', permissions: ['read'] },
          effective: { model: 'fixture', effort: 'high', permissions: ['read'] },
          sources: selection.requirements,
          rules,
          route: { kind: 'nonproduct' },
        };
        delete roleSpec.context_loading;
        let run = startLocalRun(roleSpec, 1);
        run = applyLocalEvent(run, {
          type: 'LOAD',
          event_id: 'load',
          expected_revision: 0,
          generation: 1,
          receipt: {
            run_id: session,
            session_id: session,
            procedures: run.spec.procedures,
            rules,
            observed_read: 'fixture',
            native: f.proof,
            origin: f.proof,
          },
        });
        run = applyLocalEvent(run, {
          type: 'READY',
          event_id: 'ready',
          expected_revision: 1,
          generation: 1,
        });
        const advisers = { ...council.advisers };
        delete advisers[role];
        council = assignAdviser({ ...council, advisers }, role, run);
        const design = designReviewFixture(council.phase, council.target.inputs.inputs[0]!);
        design.ui.verdict = backend.verdict;
        council = answerCouncil(council, role, session, {
          ...f.answer(council),
          verdict: backend.verdict,
          ...(role === 'ui-ux-designer' ? { design } : {}),
          scope: value.target.scope,
          sources: selection.requirements,
          binding: {
            schema_version: 1,
            request: councilReviewRequest(council, role, run),
            load_turn: 'load',
            answer_turn: `answer-${council.history.length}`,
            answer_evidence: f.proof,
            evidence: f.proof,
          },
        });
        save(council);
      }
      return council;
    },
  );
});
afterEach(async () => {
  await f.dispose();
  await rm(state, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('starts from Markdown and resumes the same SQLite owner and inventoried Legacy backend in another turn', async () => {
  expect((await start()).output.join()).toContain('LOAD_REQUIRED');
  expect(backend.council).not.toHaveBeenCalled();
  const managed = readManaged<{ request: { storage: { grant: EvidenceGrant } } }>(
    resolve(state, 'managed-chat.json'),
  )!;
  const identity = managed.request.storage.grant.context;
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  declareBackendFixture(f.root);
  await f.file(
    '.git/agent-workflow/backend-policy.json',
    JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
  );
  reserveTaskBackend(f.root, {
    schemaVersion: 1,
    projectId: identity.project_id,
    taskId: identity.task_id,
    backend: 'legacy',
    cardName: 'task.md',
    origin: 'a'.repeat(64),
  });
  await loadAll();
  const result = await invoke('continue');
  expect(result.errors).toEqual([]);
  expect(result.output.join()).toContain('implementing');
  expect((await invoke('start')).errors).toEqual([]);
  records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
  await context('next');
  expect((await invoke('continue')).output.join()).toContain('LOAD_REQUIRED');
  await loadAll();
  const resumed = await invoke('continue');
  expect(resumed.errors).toEqual([]);
  expect(resumed.output.join()).toContain('ready');
  records.push(
    { type: 'compacted', payload: {} },
    [...records].reverse().find((r) => r.type === 'turn_context')!,
  );
  await flush();
  await loadAll();
  expect((await invoke('continue')).errors).toEqual([]);
  const requestPath = resolve(state, 'request.json');
  const request = readManaged<{ spec: RunSpec; runtime_package_version: string }>(requestPath)!;
  expect(request.spec.session_id).toBe('session');
  expect(request.runtime_package_version).toBe(metadata.version);
});

it.each([false, true])(
  'requires assessed applicability before writing new state or starting any adviser (state exists=%s)',
  async (stateExists) => {
    const before = await readFile(resolve(f.root, card), 'utf8');
    if (!stateExists) await rm(state, { recursive: true });
    const result = await invoke('start', '--card', card, '--plan', 'proposal.md');
    expect(result.code).toBe(1);
    expect(result.errors).toEqual(['council-selection-required']);
    expect(JSON.parse(result.output.join('\n')) as unknown).toMatchObject({
      reason: 'council-selection-required',
    });
    if (stateExists) expect(await readdir(state)).toEqual([]);
    else await expect(readdir(state)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(backend.council).not.toHaveBeenCalled();
    expect(await readFile(resolve(f.root, card), 'utf8')).toBe(before);
  },
);
it('refuses conflicting plan options before creating an operation and identifies the correction', async () => {
  const result = await invoke('start', '--plan', 'proposal.md', '--local-plan', 'local.json');
  expect(result.errors).toEqual(['conflicting-task-chat-plan']);
  expect(JSON.parse(result.output.join('\n')) as unknown).toMatchObject({
    status: 'refused',
    next_action: 'Оставить один параметр: --plan или --local-plan.',
  });
  expect(backend.council).not.toHaveBeenCalled();
  expect(readManaged(resolve(state, 'managed-chat.json'))).toBeNull();
  const details = object(object(JSON.parse(result.output.join('\n')) as unknown).details);
  expect(await readFile(textField(details.locator), 'utf8')).toContain('# Текущий чат Codex');
});

async function localPlan(path = 'local.json') {
  await f.file(
    path,
    JSON.stringify({
      schema_version: 1,
      requirement: f.proof,
      basis: [f.proof],
      owner: await f.ref('source.txt'),
      paths: ['source.txt'],
      consumers: [await f.ref('source.txt')],
      consumers_complete: true,
      risks: Object.fromEntries(localPlanningRisks.map((risk) => [risk, false])),
      reason: 'Existing declared fixture contract',
      checks: ['validate'],
      criterion: 'Existing boundary holds',
    }),
  );
  return councilRoles
    .filter((role) => role !== 'architect')
    .flatMap((role) => ['--skip-role', `${role}:Вне локального изменения`]);
}
it('starts and continues a local implementation through the real managed CLI without launching planning advisers', async () => {
  const skip = await localPlan();
  expect(
    (
      await invoke(
        'start',
        '--card',
        card,
        '--local-plan',
        'local.json',
        '--target',
        'source.txt',
        ...skip,
      )
    ).output.join(),
  ).toContain('LOAD_REQUIRED');
  await loadAll();
  const started = await invoke('continue');
  expect(started.errors).toEqual([]);
  expect(started.output.join()).toContain('implementing');
  expect(backend.council).not.toHaveBeenCalled();
  const managed = readManaged<{ schema_version: number; request: { spec: RunSpec } }>(
    resolve(state, 'managed-chat.json'),
  )!;
  expect(managed.schema_version).toBe(2);
  expect(managed.request.spec.route.kind).toBe('local');
  expect((await invoke('start')).errors).toEqual([]);
  records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
  await context('local-next');
  expect((await invoke('continue')).output.join()).toContain('LOAD_REQUIRED');
  await loadAll();
  expect((await invoke('continue')).errors).toEqual([]);
});
it.each([
  ['version', 'unsupported-local-plan'],
  ['consumers', 'local-consumers-incomplete'],
  ['scope', 'local-scope-incomplete'],
  ['risk', 'local-needs-council-planning'],
  ['checks', 'local-checks-missing'],
  ['json', 'invalid-local-plan-json'],
  ['null', 'invalid-object'],
  ['requirement', 'invalid-object'],
] as const)(
  'refuses an inadmissible local plan before creating an operation: %s',
  async (kind, reason) => {
    const skip = await localPlan();
    const plan = JSON.parse(await readFile(resolve(f.root, 'local.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (kind === 'version') plan.schema_version = 2;
    if (kind === 'consumers') plan.consumers_complete = false;
    if (kind === 'scope') plan.paths = [];
    if (kind === 'risk') plan.risks = { security: true };
    if (kind === 'checks') plan.checks = [];
    if (kind === 'requirement') delete plan.requirement;
    await f.file(
      'local.json',
      kind === 'json' ? '{' : JSON.stringify(kind === 'null' ? null : plan),
    );
    const result = await invoke('start', '--card', card, '--local-plan', 'local.json', ...skip);
    expect(result.errors).toEqual([reason]);
    const response = object(JSON.parse(result.output.join('\n')) as unknown);
    expect(response).toMatchObject({
      status: 'refused',
      reason,
      details: { locator: resolve(f.root, 'local.json') },
    });
    const details = object(response.details);
    expect(await readFile(textField(details.locator), 'utf8')).toBe(
      await readFile(resolve(f.root, 'local.json'), 'utf8'),
    );
    expect(backend.council).not.toHaveBeenCalled();
    expect(readManaged(resolve(state, 'managed-chat.json'))).toBeNull();
  },
);
it('keeps a controller integrity failure unknown when it overrides a refused local plan', async () => {
  const skip = await localPlan();
  const plan = object(JSON.parse(await readFile(resolve(f.root, 'local.json'), 'utf8')) as unknown);
  plan.consumers_complete = false;
  await f.file('local.json', JSON.stringify(plan));
  const read = projectFiles.projectText;
  const lock = resolve(state, 'controller/agent-workflow-chat-writer.lock');
  vi.spyOn(projectFiles, 'projectText').mockImplementation(async (root, path) => {
    const source = await read(root, path);
    if (path === 'local.json') await writeFile(lock, 'changed fixture ownership');
    return source;
  });
  const result = await invoke('start', '--card', card, '--local-plan', 'local.json', ...skip);
  expect(result.errors).toEqual(['chat-writer-lock-changed']);
  const response = object(JSON.parse(result.output.join('\n')) as unknown);
  expect(response).toMatchObject({ status: 'unknown', reason: 'chat-writer-lock-changed' });
  expect(textField(response.next_action)).toContain('исходную операцию');
  expect(await readFile(textField(object(response.details).locator), 'utf8')).toContain(
    '# Текущий чат Codex',
  );
  expect(await readFile(lock, 'utf8')).toBe('changed fixture ownership');
  expect(readManaged(resolve(state, 'managed-chat.json'))).toBeNull();
});
it('revises an existing substantial run to a local plan and returns to council planning when the requirement changes', async () => {
  await start();
  await loadAll();
  expect((await invoke('continue')).errors).toEqual([]);
  const calls = backend.council.mock.calls.length;
  const skip = await localPlan();
  expect(
    (
      await invoke('revise', '--local-plan', 'local.json', '--affected', 'C1', ...skip)
    ).output.join(),
  ).toContain('LOAD_REQUIRED');
  await loadAll();
  const revised = await invoke('revise', '--local-plan', 'local.json', '--affected', 'C1', ...skip);
  expect(revised.errors).toEqual([]);
  expect(backend.council.mock.calls.length).toBe(calls);
  expect(
    readManaged<{ request: { spec: RunSpec } }>(resolve(state, 'managed-chat.json'))!.request.spec
      .route.kind,
  ).toBe('local');
  await f.file('proposal-next.md', 'Substantial changed fixture requirement.');
  expect((await revise('--plan', 'proposal-next.md', '--affected', 'C1')).output.join()).toContain(
    'LOAD_REQUIRED',
  );
  await loadAll();
  expect((await revise('--plan', 'proposal-next.md', '--affected', 'C1')).errors).toEqual([]);
  expect(backend.council.mock.calls.length).toBeGreaterThan(calls);
});

it('reviews two selected roles and repeats only the changed role with the same history and current revision', async () => {
  await f.file('architect-scope.md', 'Границы и зависимости клиента.');
  await f.file('backend-scope.md', 'Серверный договор первой версии.');
  await f.file('api/server.ts', 'version one');
  const roles = Object.fromEntries(
    councilRoles.map((role) => [
      role,
      role === 'architect' || role === 'backend'
        ? {
            trigger: true,
            reason: role === 'architect' ? 'Границы модулей' : 'Серверный договор',
            requirements: [`${role}-scope.md`],
            inputs: {
              files: [role === 'architect' ? 'source.txt' : 'api/server.ts'],
              directories: [],
            },
          }
        : { trigger: false, reason: `Область ${role} не затронута` },
    ]),
  );
  await f.file('roles.json', JSON.stringify({ schema_version: 1, roles }));
  expect(
    (
      await invoke(
        'start',
        '--card',
        card,
        '--plan',
        'proposal.md',
        '--council-selection',
        'roles.json',
        '--target',
        'source.txt',
        '--target',
        'api/server.ts',
      )
    ).errors,
  ).toEqual([]);
  await loadAll();
  expect((await invoke('start', '--council-selection', 'roles.json')).errors).toEqual([]);
  const original = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!.council;
  expect(original.history.map((entry) => entry.role)).toEqual(['architect', 'backend']);
  await f.file('backend-scope.md', 'Серверный договор второй версии.');
  await f.file('api/server.ts', 'version two');
  await f.file('proposal-v2.md', 'Обновить только серверный договор.');
  const revisionArgs = [
    '--plan',
    'proposal-v2.md',
    '--affected',
    'C1',
    '--council-selection',
    'roles.json',
  ];
  expect((await invoke('revise', ...revisionArgs)).errors).toEqual([]);
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  const changed = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!.council;
  expect(changed.history.map((entry) => entry.role)).toEqual(['architect', 'backend']);
  expect(changed.review_turns?.map((entry) => entry.role)).toEqual([
    'architect',
    'backend',
    'backend',
  ]);
  expect(changed.advisers.architect).toEqual(original.advisers.architect);
  expect(changed.advisers.backend!.run.spec.session_id).toBe(
    original.advisers.backend!.run.spec.session_id,
  );
  expect(changed.advisers.backend!.answer!.sources).toContainEqual(await f.ref('backend-scope.md'));
  expect((await invoke('revise', ...revisionArgs)).errors).toEqual([]);
  expect(
    readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!.council.history,
  ).toEqual(changed.history);
  expect((await invoke('revise', '--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([
    'council-selection-required',
  ]);
  expect((await invoke('continue', '--skip-role', 'backend:Не требуется')).errors).toEqual([
    'managed-chat-selection-revision-required',
  ]);
  await f.file('roles.json', JSON.stringify({ schema_version: 1, roles: {} }));
  expect((await invoke('continue', '--council-selection', 'roles.json')).errors).toEqual([
    'workflow-input-changed',
  ]);
});

it('continues an automatic active turn with the same accepted authority and council', async () => {
  await start();
  await loadAll();
  expect((await invoke('continue')).errors).toEqual([]);
  expect((await invoke('continue')).errors).toEqual([]);
  const before = readManaged<Record<string, unknown>>(resolve(state, 'request.json'))!;
  records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
  await context('automatic', false);
  const resumed = await invoke('continue');
  expect(resumed.errors).toEqual([]);
  expect(resumed.output.join()).toContain('ready');
  const after = readManaged<Record<string, unknown>>(resolve(state, 'request.json'))!;
  expect(after.human_source).toEqual(before.human_source);
  expect(after.previous_source_turn).toBe('turn');
  expect(after.storage).toEqual(before.storage);
  expect(backend.council).toHaveBeenCalledTimes(1);
});

it('revises requirements atomically and retains previous council history on retry', async () => {
  const originalExecute = runtime.executeChatRequest;
  let sent: unknown;
  let legacyView = false;
  vi.spyOn(runtime, 'executeChatRequest').mockImplementation(async (command, request) => {
    if (command === 'messages-chat') sent = request.message;
    const result = await originalExecute(command, request);
    if (command === 'status-chat' && legacyView) {
      const status = structuredClone(result);
      const messages = (
        status as { messages: { history: { id: string; payload: string; fingerprint?: string }[] } }
      ).messages;
      const event = sent as { id: string };
      const receipt = messages.history.find((entry) => entry.id === event.id)!;
      receipt.payload = JSON.stringify(sent);
      delete receipt.fingerprint;
      return status;
    }
    return result;
  });
  await start();
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  const first = readManaged<{ request: { planning_file: string } }>(
    resolve(state, 'managed-chat.json'),
  )!;
  const originalPlan = await readFile(resolve(f.root, first.request.planning_file), 'utf8');
  await f.file('proposal-v2.md', '# Новый план\nСохранить старый результат, проверить новый.\n');
  const revised = await revise('--plan', 'proposal-v2.md', '--affected', 'C1');
  expect(revised.errors).toEqual([]);
  expect(revised.output.join()).toContain('LOAD_REQUIRED');
  await loadAll();
  const done = await invoke('continue');
  expect(done.errors).toEqual([]);
  const managed = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!;
  expect(managed.council.history.filter((h) => h.role === 'architect')).toHaveLength(1);
  expect(managed.council.review_turns?.filter((h) => h.role === 'architect')).toHaveLength(2);
  expect(await readFile(resolve(f.root, first.request.planning_file), 'utf8')).toBe(originalPlan);
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
  legacyView = true;
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
});

it('keeps a paused run paused until the explicit continuation route', async () => {
  await start();
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  const managed = readManaged<{ request: Record<string, unknown> }>(
    resolve(state, 'managed-chat.json'),
  )!;
  const request = managed.request;
  await runtime.executeChatRequest('control-chat', {
    ...request,
    control: {
      type: 'PAUSE',
      id: 'pause',
      expected_revision: 0,
      generation: 1,
      thread_id: 'session',
      source: request.human_source,
      reason: 'User pause',
    },
  });
  expect((await invoke('start')).errors).toEqual(['managed-chat-resume-required']);
});

it('recovers an expired lease before applying new requirements and separates mutable targets from stable sources', async () => {
  const skip = councilRoles
    .filter((r) => r !== 'architect')
    .flatMap((r) => ['--skip-role', `${r}:Вне предмета`]);
  await invoke('start', '--card', card, '--plan', 'proposal.md', '--target', 'source.txt', ...skip);
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  await f.file('source.txt', 'Implemented revision');
  records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
  await context('after-expiry');
  vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
  await f.file('proposal-v2.md', '# Revision\nVerify new implementation.');
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).output.join()).toContain(
    'LOAD_REQUIRED',
  );
  await loadAll();
  const changed = await revise('--plan', 'proposal-v2.md', '--affected', 'C1');
  expect(changed.errors).toEqual([]);
  expect(changed.output.join()).toContain('LOAD_REQUIRED');
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
});

it('revises a changed stable source after expiry without accepting the previous planning for the new inputs', async () => {
  await start();
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  const first = readManaged<{ request: Record<string, unknown>; council: Council }>(
    resolve(state, 'managed-chat.json'),
  )!;
  const originalCouncil = first.council;
  await f.file('source.txt', 'Explicitly revised stable requirement');
  await f.file('proposal-v2.md', '# Revision\nKeep task scope; review the updated requirement.');
  records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
  await context('after-requirements-expiry');
  vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
  expect((await invoke('continue')).output.join()).toContain('LOAD_REQUIRED');
  await loadAll();
  expect((await invoke('continue')).errors).toEqual(['source-revision-mismatch']);
  const changed = await revise('--plan', 'proposal-v2.md', '--affected', 'C1');
  expect(changed.errors).toEqual([]);
  expect(changed.output.join()).toContain('LOAD_REQUIRED');
  const managed = readManaged<{ request: Record<string, unknown>; council: Council }>(
    resolve(state, 'managed-chat.json'),
  )!;
  const status = (await runtime.executeChatRequest('status-chat', managed.request)) as {
    local: { status: string; spec: RunSpec };
    execution: { status: string };
    messages: { requirements_revision: number };
    ownership: { expired: boolean; owner: string; generation: number };
  };
  expect(status.local.status).not.toBe('ready');
  expect(status.local.spec.route).toEqual({ kind: 'substantial', accepted_plan: null });
  expect(status.messages.requirements_revision).toBe(1);
  expect(status.ownership).toMatchObject({ expired: false, owner: 'session', generation: 1 });
  expect(managed.council.history).toEqual(originalCouncil.history);
  expect(managed.council.advisers.architect?.run.spec.session_id).toBe(
    originalCouncil.advisers.architect?.run.spec.session_id,
  );
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  const done = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!;
  expect(done.council.history.filter((h) => h.role === 'architect')).toHaveLength(1);
  expect(done.council.review_turns?.filter((h) => h.role === 'architect')).toHaveLength(2);
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
  expect(
    readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!.council.history,
  ).toEqual(done.council.history);
});

it.each([false, true])(
  'refreshes project rules only through explicit revise with expired owner=%s',
  async (expired) => {
    await start();
    await loadAll();
    expect((await invoke('start')).errors).toEqual([]);
    const original = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!;
    records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
    await context('changed-project-rules');
    await f.file(
      'AGENTS.md',
      '# Revised rules\nFresh observed LOAD and renewed review are required.\n',
    );
    await f.file('proposal-v2.md', '# Revision\nKeep scope and review the current project rules.');
    if (expired) vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
    await loadAll();
    expect((await invoke('continue')).errors).toEqual(['rules-version-mismatch']);
    const changed = await revise('--plan', 'proposal-v2.md', '--affected', 'C1');
    expect(changed.errors).toEqual([]);
    expect(changed.output.join()).toContain('LOAD_REQUIRED');
    const managed = readManaged<{ request: Record<string, unknown>; council: Council }>(
      resolve(state, 'managed-chat.json'),
    )!;
    const status = (await runtime.executeChatRequest('status-chat', managed.request)) as {
      local: LocalRun;
      messages: { requirements_revision: number };
      ownership: { owner: string; generation: number; expired: boolean };
    };
    expect(status.local.spec.rules).toEqual([await f.ref('AGENTS.md')]);
    expect(status.local.spec.route).toEqual({ kind: 'substantial', accepted_plan: null });
    expect(status.local.status).not.toBe('ready');
    expect(status.messages.requirements_revision).toBe(1);
    expect(status.ownership).toMatchObject({ owner: 'session', generation: 1, expired: false });
    expect(managed.council.history).toEqual(original.council.history);
    expect(managed.council.advisers.architect?.run.spec.session_id).toBe(
      original.council.advisers.architect?.run.spec.session_id,
    );
    await loadAll();
    expect((await invoke('start')).errors).toEqual([]);
    const done = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!;
    expect(done.council.history.filter((h) => h.role === 'architect')).toHaveLength(1);
    expect(done.council.review_turns?.filter((h) => h.role === 'architect')).toHaveLength(2);
    expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
    expect(
      readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!.council.history,
    ).toEqual(done.council.history);
  },
);

it('recovers a committed combined revision after losing its reply without replaying the council', async () => {
  await start();
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  await f.file('source.txt', 'Changed stable requirement');
  await f.file('proposal-v2.md', '# Revised proposal\nKeep the same task.');
  records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
  await context('revision-with-lost-reply');
  vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
  await loadAll();
  const original = runtime.executeChatRequest;
  const call = vi
    .spyOn(runtime, 'executeChatRequest')
    .mockImplementation(async (command, request) => {
      const result = await original(command, request);
      if (command === 'continue-chat' && request.message !== undefined) {
        call.mockRestore();
        throw new Error('lost combined revision reply');
      }
      return result;
    });
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([
    'lost combined revision reply',
  ]);
  const managed = readManaged<{ request: Record<string, unknown> }>(
    resolve(state, 'managed-chat.json'),
  )!;
  expect(
    await original('status-chat', {
      ...managed.request,
      anchor: { ...(managed.request.anchor as Record<string, unknown>), turn_id: turn },
    }),
  ).toMatchObject({
    local: { status: 'waiting' },
    messages: { revision: 1, requirements_revision: 1 },
    control: { observed: { turn_id: turn } },
  });
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  expect(
    readManaged<{ council: Council }>(
      resolve(state, 'managed-chat.json'),
    )!.council.review_turns?.filter((h) => h.role === 'architect'),
  ).toHaveLength(2);
});

it('rejects unsafe state roots, missing state, conflicting card/plan, and unsupported native profiles', async () => {
  expect((await invoke('continue')).errors).toEqual(['managed-chat-not-started']);
  const errors: string[] = [];
  expect(
    await runTaskChatCommand(
      ['start', '--state', f.root],
      f.root,
      () => {},
      (s) => errors.push(s),
    ),
  ).toBe(1);
  expect(errors).toEqual(['chat-state-must-be-external']);
  await start();
  expect((await invoke('start', '--card', 'other.md')).errors).toEqual([
    'managed-chat-card-conflict',
  ]);
  const saved = readManaged<Record<string, unknown>>(resolve(state, 'managed-chat.json'))!;
  saved.owner = 'other';
  await writeFile(resolve(state, 'managed-chat.json'), JSON.stringify(saved));
  expect((await invoke('start')).errors).toEqual(['managed-chat-identity-mismatch']);
});

it('does not confirm LOAD from missing or truncated output, and uses a new marker after compaction', async () => {
  await start();
  const pending = await invoke('load');
  expect(pending.output.length).toBeGreaterThan(0);
  expect((await invoke('start')).output.join()).toContain('LOAD_REQUIRED');
  await loadAll();
  records.push(
    { type: 'compacted', payload: {} },
    records.find((r) => r.type === 'turn_context')!,
  );
  await flush();
  expect((await invoke('start')).output.join()).toContain('LOAD_REQUIRED');
});

it('uses an explicit LOAD budget without confirming unread or truncated output', async () => {
  await start();
  const small = await invoke('load', '--load-bytes', '1000');
  const large = await invoke('load', '--load-bytes', '512000');
  expect(small.errors).toEqual([]);
  expect(small.output.length).toBe(1);
  expect(large.output.length).toBeGreaterThan(small.output.length);
  expect((await invoke('start')).output.join()).toContain('LOAD_REQUIRED');
  records.push({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'session',
      turn_id: turn,
      item: {
        type: 'CommandExecution',
        cwd: f.root,
        exit_code: 0,
        status: 'completed',
        aggregated_output: large.output.join('\n'),
      },
    },
  });
  await flush();
  expect((await invoke('continue')).errors).toEqual([]);
});

it('waits on existing progress without a native chat, writer, or adviser dispatch', async () => {
  const directory = resolve(state, 'council');
  await mkdir(directory, { recursive: true });
  const snapshot = saveCouncilProgress(directory, {
    schema_version: 1,
    run_id: 'run',
    phase: 'planning',
    scope: 'scope',
    target_hash: 'hash',
    status: 'running',
    roles: { architect: { status: 'pending' } },
  });
  vi.stubEnv('CODEX_THREAD_ID', undefined);
  const result = await invoke('wait', '--after', snapshot.cursor, '--timeout-ms', '0');
  expect(result.errors).toEqual([]);
  expect(JSON.parse(result.output[0]!)).toEqual({ changed: false, timed_out: false, snapshot });
  expect(backend.council).not.toHaveBeenCalled();
  expect((await invoke('wait', '--timeout-ms', '0')).errors).toEqual([]);
  expect((await invoke('wait', '--timeout-ms', '0', '--until', 'settled')).errors).toEqual([]);
  expect((await invoke('wait', '--until', 'other')).errors).toContain(
    'invalid-task-chat-wait-mode',
  );
  expect((await invoke('load', '--until', 'settled')).errors).toContain(
    'invalid-task-chat-wait-mode',
  );
});

it.each([
  ['load', '--load-bytes', '999'],
  ['load', '--load-bytes', '512001'],
  ['load', '--load-bytes', 'NaN'],
  ['load', '--load-bytes', '1000.5'],
  ['start', '--load-bytes', '24000'],
  ['wait', '--timeout-ms', '-1'],
  ['wait', '--timeout-ms', '60001'],
  ['wait', '--timeout-ms', 'NaN'],
  ['wait', '--timeout-ms', '0.5'],
  ['start', '--after', 'cursor'],
  ['start', '--timeout-ms', '0'],
])('rejects invalid LOAD/wait options %j', (...args) => {
  expect(() => taskChatOptions([...args, '--state', '/external/task'])).toThrow();
});

it.each(
  [
    [],
    ['nope', '--state', '/tmp/test'],
    ['load'],
    ['load', '--state', '/tmp/test', '--bad', 'x'],
    ['load', '--state', '/tmp/test', '--card', 'a', '--card', 'b'],
    ['start', '--state', '/tmp/test', '--skip-role', '../other:reason'],
    ['start', '--state', '/tmp/test', '--skip-role', 'architect:'],
    [
      'start',
      '--state',
      '/tmp/test',
      '--skip-role',
      'architect:one',
      '--skip-role',
      'architect:two',
    ],
  ].map((args) => ({ args })),
)('rejects invalid arguments $args', ({ args }) => {
  expect(() => taskChatOptions(args)).toThrow();
});

it('replays a saved REQUIREMENTS intent after failure before its SQLite commit', async () => {
  await start();
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  await f.file('proposal-v2.md', '# Новая редакция\nНовые критерии.');
  const original = runtime.executeChatRequest;
  let failed = false;
  vi.spyOn(runtime, 'executeChatRequest').mockImplementation(async (command, request) => {
    if (command === 'messages-chat' && !failed) {
      failed = true;
      throw new Error('before commit');
    }
    return original(command, request);
  });
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([
    'before commit',
  ]);
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
});

it('recovers bootstrap after Store initialization but before the first checkpoint', async () => {
  await start();
  const managed = readManaged<{ request: { storage: { root: string; grant: EvidenceGrant } } }>(
    resolve(state, 'managed-chat.json'),
  )!;
  const storage = managed.request.storage;
  initializeStore(storage.root, storage.grant.context);
  const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
  const snapshot = unwrap<TechnicalState>(
    store.execute({ context: storage.grant.context, command: { type: 'state' } }),
  );
  bindChatEvidence(storage.root, state, snapshot);
  expect((await invoke('start')).output.join()).toContain('LOAD_REQUIRED');
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
});

it('continues the current owner before starting execution in a fresh turn and keeps plan conflicts explicit', async () => {
  await start();
  await loadAll();
  const initial = await invoke('start');
  expect(initial.errors).toEqual([]);
  expect(initial.output.join()).toContain('"status":"implementing"');
  expect(backend.council).toHaveBeenCalledTimes(1);
  records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
  await context('next-start');
  await loadAll();
  const resumed = await invoke('start');
  expect(resumed.errors).toEqual([]);
  expect(resumed.output.join()).toContain('"status":"implementing"');
  expect(backend.council).toHaveBeenCalledTimes(1);
  expect((await invoke('start', '--plan', 'other.md')).errors).toEqual([
    'managed-chat-plan-conflict',
  ]);
});

it('reports unexpected non-Error failures without claiming success', async () => {
  await start();
  await loadAll();
  backend.council.mockRejectedValue('transport unavailable');
  const result = await invoke('start');
  expect(result.code).toBe(1);
  expect(result.errors.join()).toContain('task-chat start');
});

it('recovers a persisted run before chat messages/control initialization', async () => {
  await start();
  await loadAll();
  const initialize = vi
    .spyOn(messages, 'initializeChatMessages')
    .mockRejectedValueOnce(new Error('before chat context'));
  expect((await invoke('start')).errors).toEqual(['before chat context']);
  initialize.mockRestore();
  expect((await invoke('start')).errors).toEqual([]);
});

it('revises a failed initial planning council before READY and keeps the FAIL', async () => {
  await start();
  await loadAll();
  backend.verdict = 'FAIL';
  expect((await invoke('start')).errors).toEqual(['chat-planning-unconfirmed']);
  await f.file('proposal-v2.md', '# Исправленный план\nСохранить исходный FAIL.');
  backend.verdict = 'PASS';
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
  await loadAll();
  expect((await invoke('continue')).errors).toEqual([]);
  const managed = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!;
  expect(
    managed.council.history.filter((h) => h.role === 'architect').map((h) => h.answer.verdict),
  ).toEqual(['FAIL', 'PASS']);
});

it('does not admit a failed planning council after excluding its adviser through a managed revision', async () => {
  await start();
  await loadAll();
  backend.verdict = 'FAIL';
  expect((await invoke('start')).errors).toEqual(['chat-planning-unconfirmed']);
  await f.file('proposal-v2.md', '# Пересмотр\nИсходный дефект ещё не закрыт.');
  const skipped = councilRoles.flatMap((role) => ['--skip-role', `${role}:Область снята`]);
  expect(
    (await invoke('revise', '--plan', 'proposal-v2.md', '--affected', 'C1', ...skipped)).errors,
  ).toEqual([]);
  await loadAll();
  expect((await invoke('continue')).errors).toEqual(['chat-planning-unconfirmed']);
  const managed = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!;
  expect(managed.council.selection.architect.trigger).toBe(false);
  expect(managed.council.history.map((entry) => entry.answer.verdict)).toEqual(['FAIL']);
  backend.verdict = 'PASS';
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
  await loadAll();
  expect((await invoke('continue')).errors).toEqual([]);
  const recovered = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!;
  expect(recovered.council.history.map((entry) => entry.answer.verdict)).toEqual(['FAIL', 'PASS']);
});

it.each(['start', 'continue', 'load'])(
  'rejects a replacement council map on existing %s without revision',
  async (action) => {
    await start();
    await loadAll();
    expect((await invoke('start')).errors).toEqual([]);
    const before = await readFile(resolve(state, 'managed-chat.json'), 'utf8');
    const reviews = backend.council.mock.calls.length;
    const result = await invoke(action, '--council-selection', 'replacement-roles.json');
    expect(result.code).toBe(1);
    expect(result.errors).toEqual(['managed-chat-selection-revision-required']);
    expect(await readFile(resolve(state, 'managed-chat.json'), 'utf8')).toBe(before);
    expect(backend.council.mock.calls).toHaveLength(reviews);
    expect((await invoke(action, '--skip-role', 'architect:Новая применимость')).errors).toEqual([
      'managed-chat-selection-revision-required',
    ]);
  },
);

it('updates applicable roles and human gates through revision options without editing technical state', async () => {
  const first = 'C1: результат проверен',
    second = 'C2: принято пользователем';
  const skip = councilRoles
    .filter((r) => r !== 'architect')
    .flatMap((r) => ['--skip-role', `${r}:Вне предмета`]);
  await invoke('start', '--card', card, '--plan', 'proposal.md', '--human', first, ...skip);
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  const content = await readFile(resolve(f.root, card), 'utf8');
  await f.file(card, content.replace(`- [ ] ${first}`, `- [ ] ${first}\n- [ ] ${second}`));
  await f.file('proposal-v2.md', '# Новый объём\nДополнительная приёмка человеком.');
  const revised = await invoke(
    'revise',
    '--plan',
    'proposal-v2.md',
    '--affected',
    'C2',
    '--human',
    second,
    '--skip-role',
    'devops:Среда и выпуск не меняются',
  );
  expect(revised.errors).toEqual([]);
  await loadAll();
  expect((await invoke('continue')).errors).toEqual([]);
  const managed = readManaged<{ human: string[]; council: Council }>(
    resolve(state, 'managed-chat.json'),
  )!;
  expect(managed.human).toEqual([first, second]);
  expect(managed.council.selection.product.trigger).toBe(true);
  expect(managed.council.history.filter((h) => h.role === 'architect')).toHaveLength(1);
  expect(managed.council.review_turns?.filter((h) => h.role === 'architect')).toHaveLength(2);
  const request = readManaged<{ gates: { id: string; kind: string }[] }>(
    resolve(state, 'request.json'),
  )!;
  expect(request.gates.filter((g) => g.kind === 'human').map((g) => g.id)).toEqual([first, second]);
});

it('rejects an incomplete compact card and preserves multiline goal and checked criteria', async () => {
  await f.file('bad.md', '# Без разделов\n');
  await expect(taskChatBrief(f.root, 'bad.md')).rejects.toThrow();
  await f.file(
    'bad.md',
    '## Цель\n\nРезультат\n\n## Границы\n\nПока нет\n\n## Критерии приёмки\n\n- [x] Проверено\n',
  );
  await expect(taskChatBrief(f.root, 'bad.md')).rejects.toThrow('task-chat-brief-incomplete');
});

it.each(['_compact-template.md', '_template.md'])(
  'reads the published %s without rewriting it',
  async (template) => {
    const content = await readFile(resolve('docs/exec-plans/active', template), 'utf8');
    await f.file('template.md', content);
    const brief = await taskChatBrief(f.root, 'template.md');
    expect(brief.outcome).toContain('{{');
    expect(brief.scope.length).toBeGreaterThan(0);
    expect(brief.criteria).toHaveLength(1);
    expect(
      taskChatGates(brief.criteria, []).every((gate) => /^[a-zA-Z0-9_-]+$/u.test(gate.id)),
    ).toBe(true);
    const adopted = adoptCardMarkdown(readCardMarkdown('template.md', content), 'p', 't');
    const projected = projectCardStatus(readCardMarkdown('template.md', adopted), 'completed', {
      criteria: brief.criteria,
      summary: 'Accepted result',
      evidence: [],
      limitations: [],
    });
    expect(projected).not.toContain('- [ ]');
    expect(projected).toContain('- [x]');
    expect(await readFile(resolve(f.root, 'template.md'), 'utf8')).toBe(content);
  },
);

it('uses explicit criterion IDs for executable gates while preserving the complete authoring card', async () => {
  expect(() => taskChatGates(['C1: first requirement', 'C1: second requirement'], [])).toThrow(
    'duplicate-criterion-id',
  );
  const content =
    '# Task\n\n## Цель\n\nFinish G1.\n\n## Границы\n\n- Sample only.\n\n## Критерии\n\n- [ ] G1-PLAY: Both investigation orders and restored state.\n  Preserve all negative cases.\n- [x] validate: Four metrics remain 100%.\n- [ ] legacy-check\n';
  await f.file('criteria.md', content);
  const brief = await taskChatBrief(f.root, 'criteria.md');
  expect(taskChatGates(brief.criteria, []).map((gate) => gate.id)).toEqual([
    'G1-PLAY',
    'validate',
    'legacy-check',
  ]);
  expect(brief.criteria).toContain(
    'G1-PLAY: Both investigation orders and restored state. Preserve all negative cases.',
  );
  expect(taskChatGates(brief.criteria, []).find((gate) => gate.id === 'validate')?.reason).toBe(
    'validate: Four metrics remain 100%.',
  );
  expect(await readFile(resolve(f.root, 'criteria.md'), 'utf8')).toBe(content);
});

it('keeps source files unchanged and exposes native primary source rather than a paraphrase', async () => {
  const before = await readFile(resolve(f.root, 'proposal.md'), 'utf8');
  await start();
  const stored = readManaged<{ request: Record<string, unknown> }>(
    resolve(state, 'managed-chat.json'),
  )!;
  const source = stored.request.human_source as { locator: string; hash: string };
  expect(source.locator).toBe(transcript + '#L3');
  expect(source.hash).toBe(contentHash(JSON.stringify(records[2]) + '\n'));
  expect(await readFile(resolve(f.root, 'proposal.md'), 'utf8')).toBe(before);
  await appendFile(transcript, '{');
  expect((await invoke('start')).errors).toEqual(['chat-transcript-partial']);
});

it('requires a fresh complete LOAD after rules change without accepting a truncated prior marker', async () => {
  await start();
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
  await context('rules-after-truncation');
  vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
  await f.file('AGENTS.md', '# Rules before native truncation\n');
  await f.file('proposal-v2.md', '# Same task with refreshed rules\n');
  const partial = await invoke('load');
  expect(partial.output.length).toBeGreaterThan(0);
  const originalMarker = (JSON.parse(partial.output[0]!) as { chat_read: string }).chat_read;
  records.push({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'session',
      turn_id: turn,
      item: {
        type: 'CommandExecution',
        cwd: f.root,
        exit_code: 0,
        status: 'completed',
        aggregated_output: partial.output[0]!.slice(0, -4),
      },
    },
  });
  await flush();
  const retry = await invoke('load');
  expect(retry.code).toBe(0);
  expect(retry.errors).toEqual([]);
  expect((JSON.parse(retry.output[0]!) as { chat_read: string }).chat_read).toBe(originalMarker);
  await f.file('AGENTS.md', '# Complete current rules after reducing native output\n');
  const fresh = await invoke('load');
  expect(fresh.errors).toEqual([]);
  expect((JSON.parse(fresh.output[0]!) as { chat_read: string }).chat_read).not.toBe(
    originalMarker,
  );
  await loadAll();
  const revised = await revise('--plan', 'proposal-v2.md', '--affected', 'C1');
  expect(revised.errors).toEqual([]);
  expect(revised.output.join()).toContain('LOAD_REQUIRED');
  await loadAll();
  expect((await invoke('start')).errors).toEqual([]);
  const managed = readManaged<{ request: Record<string, unknown> }>(
    resolve(state, 'managed-chat.json'),
  )!;
  const status = (await runtime.executeChatRequest('status-chat', managed.request)) as {
    ownership: { owner: string; generation: number; expired: boolean };
  };
  expect(status.ownership).toMatchObject({ owner: 'session', generation: 1, expired: false });
});

it.each(['settled', 'missing', 'pending-load', 'new-turn', 'wrong-session'])(
  'supersedes only an undispatched prepared planning revision: %s',
  async (scenario) => {
    await start();
    await loadAll();
    expect((await invoke('start')).errors).toEqual([]);
    await f.file('proposal-v2.md', '# Second proposal\n');
    expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
    const managed = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!;
    const prior = managed.council.history.find((entry) => entry.role === 'architect')!;
    await mkdir(resolve(state, 'council'), { recursive: true });
    if (scenario !== 'missing')
      await writeFile(
        resolve(state, 'council', 'architect.json'),
        JSON.stringify({
          session: { id: scenario === 'wrong-session' ? 'other' : prior.session },
          load_pending: scenario === 'pending-load',
          turn: scenario === 'new-turn' ? 'unaccepted-turn' : prior.answer.binding!.answer_turn,
        }),
      );
    await f.file('proposal-v3.md', '# Superseding proposal without dispatch\n');
    const result = await revise('--plan', 'proposal-v3.md', '--affected', 'C1');
    if (scenario !== 'settled') {
      expect(result.errors).toEqual(['planning-adviser-running']);
      return;
    }
    expect(result.errors).toEqual([]);
    expect(result.output.join()).toContain('LOAD_REQUIRED');
    const next = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!;
    expect(next.council.advisers.architect!.status).toBe('running');
    expect(next.council.advisers.architect!.answer).toBeNull();
    expect(next.council.history).toEqual(managed.council.history);
    expect(next.council.review_turns).toEqual(managed.council.review_turns);
    await loadAll();
    expect((await invoke('start')).errors).toEqual([]);
  },
);

it('loads the startup action without optional procedures and extends the native scope explicitly', async () => {
  expect((await start()).code).toBe(0);
  await loadAll();
  expect((await start()).output.join()).toContain('implementing');
  const managed = readManaged<{ request: { spec: RunSpec } }>(resolve(state, 'managed-chat.json'))!;
  expect(managed.request.spec.procedure_loading).toBe('by-action');
  expect(managed.request.spec.procedures).toHaveLength(12);
  const optional = managed.request.spec.procedures.find((p) => p.id === 'audit')!;
  expect(records.some((r) => JSON.stringify(r).includes(optional.locator))).toBe(false);
  const extension = await invoke('load', '--procedure', 'audit');
  expect(extension.errors).toEqual([]);
  expect(extension.output.map((line) => (JSON.parse(line) as { locator: string }).locator)).toEqual(
    [optional.locator],
  );
  expect((await invoke('load', '--procedure', 'unknown')).errors).toEqual([
    'invalid-task-chat-procedure',
  ]);
  expect((await invoke('start', '--procedure', 'audit')).errors).toEqual([
    'invalid-task-chat-procedure',
  ]);
});

it('continues and revises an existing full-LOAD managed snapshot without introducing the new mode', async () => {
  await start();
  const path = resolve(state, 'managed-chat.json');
  const legacy = readManaged<{ request: Record<string, unknown> & { spec: RunSpec } }>(path)!;
  delete legacy.request.spec.procedure_loading;
  delete legacy.request.load_procedures;
  await writeFile(path, JSON.stringify(legacy));
  await loadAll();
  expect((await invoke('start')).output.join()).toContain('implementing');
  const before = readManaged<{ request: Record<string, unknown> & { spec: RunSpec } }>(path)!;
  const status = (await runtime.executeChatRequest('status-chat', before.request)) as {
    local: LocalRun;
  };
  expect(status.local.loaded!.procedures).toHaveLength(12);
  records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
  await context('legacy-next');
  vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
  await f.file('proposal-v2.md', '# Legacy revision\nPreserve the existing full LOAD.');
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).output.join()).toContain(
    'LOAD_REQUIRED',
  );
  await loadAll();
  expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
  await loadAll();
  expect((await invoke('start')).output.join()).toContain('implementing');
  const after = readManaged<{ request: { spec: RunSpec } }>(path)!;
  expect(after.request.spec.procedure_loading).toBeUndefined();
});

it.each([false, true])(
  'refreshes a procedure descriptor without replacing Store or council history, expired=%s',
  async (expired) => {
    await start();
    await loadAll();
    expect((await invoke('start')).errors).toEqual([]);
    const original = readManaged<{
      request: Record<string, unknown> & { spec: RunSpec };
      council: Council;
    }>(resolve(state, 'managed-chat.json'))!;
    const oldJournal = original.request.connection_journal as string;
    const backup = await readFile(resolve(oldJournal, 'backup.json'), 'utf8');
    const descriptorPath = 'tools/agent-workflow/project/workflow.json';
    const descriptor = JSON.parse(await readFile(resolve(f.root, descriptorPath), 'utf8')) as {
      procedures: { id: string; version: string; locator: string; hash: string }[];
    };
    const procedure = descriptor.procedures[0]!;
    const previous = procedure.version;
    procedure.version = String(Number(previous) + 1);
    const source = (await readFile(resolve(f.root, procedure.locator), 'utf8')).replace(
      `Version: ${previous}`,
      `Version: ${procedure.version}`,
    );
    await f.file(procedure.locator, source);
    procedure.hash = contentHash(source);
    await f.file(descriptorPath, JSON.stringify(descriptor));
    if (expired) {
      records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } });
      await context('updated-descriptor');
      vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
    }
    const revised = await revise('--plan', 'proposal.md', '--affected', 'C1');
    expect(revised.errors).toEqual([]);
    expect(revised.output.join()).toContain('LOAD_REQUIRED');
    if (expired) {
      await loadAll();
      expect((await revise('--plan', 'proposal.md', '--affected', 'C1')).errors).toEqual([]);
    }
    const current = readManaged<{
      request: Record<string, unknown> & { spec: RunSpec };
      council: Council;
    }>(resolve(state, 'managed-chat.json'))!;
    expect(current.request.storage).toEqual(original.request.storage);
    expect(current.request.generation).toBe(original.request.generation);
    expect(current.request.spec.run_id).toBe(original.request.spec.run_id);
    expect(current.request.spec.identity).toEqual(original.request.spec.identity);
    expect(current.request.spec.procedures.find((p) => p.id === procedure.id)).toMatchObject(
      procedure,
    );
    expect(current.request.connection_journal).not.toBe(oldJournal);
    expect(await readFile(resolve(oldJournal, 'backup.json'), 'utf8')).toBe(backup);
    expect(current.council.history).toEqual(original.council.history);
  },
);

it('retains the original diagnostic when stdout is unavailable during a refusal', async () => {
  const errors: string[] = [];
  expect(
    await runTaskChatCommand(
      ['invalid-action'],
      f.root,
      () => {
        throw new Error('stdout lost');
      },
      (message) => errors.push(message),
    ),
  ).toBe(1);
  expect(errors).toEqual(['task-chat-action-required']);
});
it.each(['lost-intent', 'corrupt-header'] as const)(
  'recovers only the exact accepted revision after LOAD: %s',
  async (kind) => {
    await start();
    await loadAll();
    expect((await invoke('start')).errors).toEqual([]);
    const before = await readFile(resolve(f.root, 'source.txt'), 'utf8');
    await f.file('proposal-v2.md', '# Revised plan\nSame owner and bounded implementation.');
    expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).output.join()).toContain(
      'LOAD_REQUIRED',
    );
    const path = resolve(state, 'managed-chat.json');
    const managed = readManaged<{ revision_event: ChatMessageEvent | null }>(path)!;
    const original = structuredClone(managed.revision_event!);
    if (kind === 'lost-intent') managed.revision_event = null;
    else managed.revision_event!.expected_revision += 1;
    saveManaged(path, managed, true, 'minimal');
    await loadAll();
    await f.file('source.txt', 'implementation changed after accepted REQUIREMENTS');
    const result = await revise('--plan', 'proposal-v2.md', '--affected', 'C1');
    if (kind === 'corrupt-header') {
      expect(result.errors).toEqual(['chat-revision-intent-unrecoverable']);
      expect(readManaged<{ revision_event: ChatMessageEvent }>(path)!.revision_event).toEqual(
        managed.revision_event,
      );
    } else {
      expect(result.errors).toEqual(['workflow-input-changed']);
      expect(readManaged<{ revision_event: ChatMessageEvent }>(path)!.revision_event).toEqual(
        original,
      );
      await f.file('source.txt', before);
      expect((await revise('--plan', 'proposal-v2.md', '--affected', 'C1')).errors).toEqual([]);
    }
  },
);

it('loads a large Unicode project rule in bounded native commands before READY', async () => {
  const content = '# Правила\n' + 'Полный исходник — 🦊.\n'.repeat(900);
  await f.file('AGENTS.md', content);
  expect((await start()).output.join('\n')).toContain('LOAD_REQUIRED');
  const small = await invoke('load', '--load-bytes', '1000');
  expect(small.errors).toEqual([]);
  expect(Buffer.byteLength(small.output.join('\n') + '\n')).toBeLessThanOrEqual(1000);
  await loadAll();
  const native = records
    .flatMap((record) => {
      if (record.type !== 'event_msg') return [];
      const payload = record.payload as { item?: { aggregated_output?: string } };
      return (payload.item?.aggregated_output ?? '')
        .split('\n')
        .filter((line) => line.startsWith('{"chat_read":'))
        .map(
          (line) =>
            JSON.parse(line) as {
              locator: string;
              content: string;
              offset?: number;
              length?: number;
            },
        );
    })
    .filter((row) => row.locator === 'AGENTS.md');
  expect(native.length).toBeGreaterThan(1);
  expect(native.map((row) => row.content).join('')).toBe(content);
  expect(native.every((row) => row.content.length <= 8000 && row.length === content.length)).toBe(
    true,
  );
  expect(native.map((row) => row.offset)).toEqual(native.map((_, index) => index * 8000));
  const accepted = await start();
  expect(accepted.errors).toEqual([]);
  expect(accepted.output.join('\n')).toContain('implementing');
});

it('bounds escaped control characters by UTF-8 bytes and completes all fragments', async () => {
  const content = '# Правила\n' + '\u0001\\"🦊'.repeat(4500);
  await f.file('AGENTS.md', content);
  await start();
  await loadAll();
  const outputs = records.flatMap((record) => {
    const payload = record.payload as { item?: { aggregated_output?: string } };
    return payload.item?.aggregated_output?.startsWith('{"chat_read":')
      ? [payload.item.aggregated_output]
      : [];
  });
  expect(outputs.length).toBeGreaterThan(1);
  expect(outputs.every((output) => Buffer.byteLength(output + '\n') <= 24000)).toBe(true);
  expect((await start()).output.join()).toContain('implementing');
});

async function completeNeutralTask(planning: Council, command: { file: string; args: string[] }) {
  const request = readManaged<Record<string, unknown>>(resolve(state, 'request.json'))!;
  let run = (await runtime.executeChatRequest('execution-chat', request)) as Execution;
  const advance = async (event: ExecutionAction) => {
    run = (await runtime.executeChatRequest('execution-chat', {
      ...request,
      event: executionEvent(run, event),
    })) as Execution;
  };
  await f.file('answer.txt', '42');
  const discovery = {
    files: [...planning.target.inputs.inputs.map((ref) => ref.locator), 'answer.txt'],
    directories: [],
  };
  const proof = async (id: string) =>
    runtime.executeChatRequest('check-chat', {
      ...request,
      check: { id, command, discovery, attested_by: 'neutral quality command' },
    }) as Promise<ChatCheckProof>;
  const criterion = await proof('C1');
  const validation = await proof('validate');
  expect([criterion.check.verdict, validation.check.verdict]).toEqual(['PASS', 'PASS']);
  const target = {
    ...planning.target,
    diff: await f.ref('answer.txt'),
    inputs: validation.check.inputs,
  };
  await advance({
    type: 'REVIEW',
    selection: planning.selection,
    target,
    baseline: {
      kind: 'real',
      scenario: 'Run the neutral quality checker',
      evidence: criterion.check.evidence,
      inputs: criterion.check.inputs,
      elapsed_ms: criterion.elapsed_ms,
      exit_code: criterion.exit_code!,
    },
    checks: [criterion.check, validation.check],
  });
  const acceptance = (await runtime.executeChatRequest('council-run-chat', {
    ...request,
    council_file: resolve(state, 'acceptance.json'),
    council: createCouncil('acceptance', planning.selection, target, planning.configuration),
  })) as Council;
  await advance({ type: 'ACCEPT', council: acceptance, findings: [] });
  await advance({
    type: 'RESULT',
    result: {
      scope: target.scope,
      target,
      evidence: [criterion.check.evidence, validation.check.evidence, f.proof],
      child_results: [],
      limitations: ['Deterministic reviewer fixture'],
      summary: 'The neutral checker verified the answer',
    },
  });
  await advance({ type: 'DONE' });
  expect(run.status).toBe('done');
  expect(
    await runtime.executeChatRequest('project-chat', { ...request, operation: 'project' }),
  ).toMatchObject({ projection: { result: { status: 'confirmed' } } });
  expect(await readFile(resolve(f.root, 'docs/exec-plans/completed/task.md'), 'utf8')).toContain(
    'completed',
  );
}

describe.each(['substantial', 'local'])('neutral %s task with a project-owned profile', (route) => {
  const path = 'project/workflow.json';
  const command = { file: process.execPath, args: ['quality.mjs'] };
  let restored: Council;
  beforeEach(async () => {
    await f.file(
      'quality.mjs',
      "import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('answer.txt','utf8'), '42');",
    );
    const fresh = {
      ...f.connection,
      council: {
        catalog: 'review/catalog.md',
        profiles: { maintainer: 'review/maintenance.md' },
      },
      validation_commands: [command],
    };
    await f.file(path, JSON.stringify(fresh));
    await rm(resolve(f.root, 'package.json'));
    await rm(resolve(f.root, 'tools/agent-workflow'), { recursive: true });
    await f.file('review/catalog.md', 'Project reviewers');
    await f.file('review/maintenance.md', 'Maintenance contract');
    await f.file(
      'review/selection.json',
      JSON.stringify({
        schema_version: 1,
        roles: {
          maintainer: {
            trigger: true,
            reason: 'Review the maintenance contract',
            requirements: ['source.txt', 'quality.mjs'],
            inputs: { files: ['source.txt'], directories: [] },
          },
        },
      }),
    );
    const local = route === 'local';
    if (local) {
      await localPlan();
      const bounded = JSON.parse(await readFile(resolve(f.root, 'local.json'), 'utf8')) as {
        paths: string[];
      };
      bounded.paths.push('answer.txt');
      await f.file('local.json', JSON.stringify(bounded));
    }
    const result = await invoke(
      'start',
      '--card',
      card,
      ...(local
        ? ['--local-plan', 'local.json', '--target', 'source.txt']
        : ['--plan', 'proposal.md']),
      '--council-selection',
      'review/selection.json',
    );
    expect(result.errors).toEqual([]);
    await loadAll();
    const ready = await invoke('continue');
    expect(ready.errors).toEqual([]);
    expect(ready.output.join()).toContain('implementing');
    restored = readManaged<{ council: Council }>(resolve(state, 'managed-chat.json'))!.council;
    expect(Object.keys(restored.selection)).toEqual(['maintainer']);
    if (local) expect(restored.advisers).toEqual({});
    else
      expect(restored.advisers.maintainer!.run.spec.rules.map((ref) => ref.locator)).toEqual([
        'review/catalog.md',
        'review/maintenance.md',
      ]);
  });
  it('accepts a real validation receipt, completes the task and projects the result', async () => {
    await completeNeutralTask(restored, command);
  });
  it('stops on a changed council configuration', async () => {
    const fresh = JSON.parse(await readFile(resolve(f.root, path), 'utf8')) as {
      council: { catalog: string; profiles: Record<string, string> };
    };
    await f.file(
      path,
      JSON.stringify({
        ...fresh,
        council: { ...fresh.council, profiles: { qa: 'review/maintenance.md' } },
      }),
    );
    expect((await invoke('continue')).output.join()).toContain('council-configuration-changed');
  });
});
