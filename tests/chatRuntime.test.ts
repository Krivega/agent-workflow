import { DatabaseSync } from 'node:sqlite';
import type { SupervisionAction } from '../core/supervision.js';
import type { Json, TechnicalState } from '../core/evidence.js';
import type { AgentSession, DataAnswer } from '../core/dataRoute.js';
import type { CouncilSessions } from '../ports/agentSessions.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { execFileSync } from 'node:child_process';
import { declareBackendFixture } from './backendPolicyFixture.js';
import { existsSync } from 'node:fs';
import { reserveTaskBackend } from '../src/adapters/project/taskBackend.js';
import { freezeChecks } from '../adapters/project/preparedChecks.js';
import * as councilRunner from '../cli/taskChatCouncil.js';
import { readManaged } from '../adapters/storage/managedChatFiles.js';
const roleBackend = vi.hoisted(() => ({
  inspect: vi.fn(),
  observeAuditAttempt: vi.fn(),
  poll: vi.fn(),
  verifyReview: vi.fn<CouncilSessions['verifyReview']>(),
}));
vi.mock('../cli/chatRoles.js', () => ({
  withChatRoles: async (
    _request: unknown,
    _principal: string,
    _project: string,
    _host: unknown,
    action: (sessions: CouncilSessions) => Promise<unknown>,
  ) =>
    action({
      inspect: roleBackend.inspect,
      observeAuditAttempt: roleBackend.observeAuditAttempt,
      confirmAuditParent: async () => {},
      poll: roleBackend.poll,
      verifyReview: roleBackend.verifyReview,
    }),
}));
import { mkdtemp, rm, readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { executeChatRequest } from '../cli/chatRuntime.js';
import { runChatCommand } from '../cli/chatCommand.js';
import { readChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { encodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { StoreDatabase } from '../adapters/storage/storeDatabase.js';
import { compactArchive } from '../adapters/storage/archiveJson.js';
import { noStorageProbe } from '../adapters/storage/storeFiles.js';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { workflowFixture, executionEvent } from './workflowFixtures.js';
import * as localStores from '../adapters/storage/localRunStores.js';
import { SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { requestHash, canonical } from '../adapters/storage/storeCodec.js';
import { grant, signed } from './storageFixtures.js';
import { createCouncil, assignAdviser, answerCouncil } from '../core/council.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import type { Execution } from '../core/execution.js';
import type { ChatCheckProof } from '../adapters/project/chatChecks.js';
import type { InputRef, LocalRun, RunSpec, LocalImplementationPlan } from '../core/localRun.js';
import type { ChatMessageEvent } from '../core/chatMessages.js';
import { chatWriterLock } from '../adapters/storage/chatWriter.js';
import { NativeUserCommands } from '../adapters/codex/userCommands.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { FileChatRecovery } from '../adapters/project/chatRecovery.js';
import { councilWaitGuard } from '../cli/councilWaitGuard.js';
import { object } from '../core/connection.js';
import type { ChatAnchor } from '../core/currentChat.js';
let f: Awaited<ReturnType<typeof workflowFixture>>;
let external: string;
let request: Record<string, unknown>;
it('rejects an unrouted direct JSON command before writer lock or Store creation', async () => {
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  declareBackendFixture(f.root);
  await f.file(
    '.git/agent-workflow/backend-policy.json',
    JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
  );
  const root = String(object(request.storage).root);
  const lock = chatWriterLock(root);
  await writeFile(lock, 'existing-owner');
  await expect(executeChatRequest('bootstrap-chat', request)).rejects.toThrow(
    'backend-assignment-required',
  );
  expect(existsSync(root)).toBe(false);
  expect(await readFile(lock, 'utf8')).toBe('existing-owner');
  await rm(lock);
  reserveTaskBackend(f.root, {
    schemaVersion: 1,
    projectId: grant.context.project_id,
    taskId: grant.context.task_id,
    backend: 'legacy',
    cardName: 'task.md',
    origin: 'a'.repeat(64),
  });
  await executeChatRequest('bootstrap-chat', request);
  expect(await executeChatRequest('status-chat', request)).toMatchObject({
    ownership: { expired: false },
  });
});
beforeEach(async () => {
  f = await workflowFixture();
  external = await mkdtemp(resolve(dirname(f.root), 'chat-runtime-'));
  const connection = new FileTaskConnection(f.root);
  await connection.apply(
    await connection.preview('connection.json', f.card.locator, 'task'),
    resolve(external, 'connection'),
  );
  await f.file(
    'planning.json',
    JSON.stringify({ schema_version: 1, task_id: 'task', council: f.council('planning') }),
  );
  const spec = {
    ...f.executor.spec,
    host_id: 'local',
    identity: { task_id: 'task', card: await f.ref(f.card.locator) },
    route: { kind: 'substantial', accepted_plan: await f.ref('planning.json') },
  };
  const reads = [...f.loaded.procedures, ...f.loaded.rules].map((e) =>
    JSON.stringify({ chat_read: 'marker', locator: e.locator, hash: e.hash, content: e.content }),
  );
  const records = [
    {
      type: 'session_meta',
      payload: {
        id: 'session',
        session_id: 'session',
        cli_version: '0.162.0-alpha.17.2',
        cwd: f.root,
      },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Explicit isolated test authorization' }],
      },
    },
    {
      type: 'turn_context',
      payload: {
        turn_id: 'turn',
        cwd: f.root,
        model: 'fixture-model',
        effort: 'high',
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'session',
        turn_id: 'turn',
        item: {
          type: 'CommandExecution',
          cwd: f.root,
          exit_code: 0,
          status: 'completed',
          aggregated_output: reads.join('\n'),
        },
      },
    },
  ];
  await f.file('transcript.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const source = {
    locator: resolve(f.root, 'transcript.jsonl') + '#L3',
    hash: contentHash(JSON.stringify(records[2]) + '\n'),
  };
  request = {
    human_source: source,
    root: f.root,
    descriptor: 'connection.json',
    connection_journal: resolve(external, 'connection'),
    evidence_root: external,
    transcript: resolve(f.root, 'transcript.jsonl'),
    anchor: { thread_id: 'session', turn_id: 'turn', workspace: f.root, host_id: 'local' },
    storage: {
      root: resolve(external, 'store'),
      grant: { ...grant, context: { ...grant.context, actor_id: 'session' } },
    },
    generation: 1,
    // Keep explicit-expiry scenarios outside the proactive one-minute renewal window.
    lease_until: Date.now() + 120_000,
    marker: 'marker',
    planning_file: 'planning.json',
    spec,
  };
  vi.stubEnv('CODEX_THREAD_ID', 'session');
});
afterEach(async () => {
  await f.dispose();
  await rm(external, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('renews the accepted owner while an event wait preserves its exact requirements binding', async () => {
  await executeChatRequest('bootstrap-chat', request);
  const host = new FileCurrentChatHost(
    f.root,
    String(request.transcript),
    request.anchor as ChatAnchor,
  );
  const guard = councilWaitGuard(request, host);
  const binding = await guard.capture();
  await guard.verify(binding);
  const now = Date.now();
  const time = vi.spyOn(Date, 'now').mockReturnValue(now + 70_000);
  try {
    await guard.verify(binding);
    expect(await executeChatRequest('status-chat', request)).toMatchObject({
      ownership: { expired: false },
    });
  } finally {
    time.mockRestore();
  }
});
it.each([false, true])(
  'rejects superseding human input during a wait, continuation=%s',
  async (continuation) => {
    await executeChatRequest('bootstrap-chat', request);
    if (continuation) request.previous_source_turn = (request.anchor as ChatAnchor).turn_id;
    const transcript = String(request.transcript);
    const host = new FileCurrentChatHost(f.root, transcript, request.anchor as ChatAnchor);
    const guard = councilWaitGuard(request, host);
    const binding = await guard.capture();
    await writeFile(
      transcript,
      (await readFile(transcript, 'utf8')) +
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Cancel this operation now.' }],
          },
        }) +
        '\n',
    );
    await expect(guard.verify(binding)).rejects.toThrow('chat-continuation-human-superseded');
  },
);
it.each([
  'owner',
  'actor',
  'generation',
  'frozen',
  'released',
  'lease',
  'status',
  'observation',
  'control-generation',
  'messages-generation',
  'requirements',
  'control',
])('refuses a changed %s after starting an event wait', async (kind) => {
  await executeChatRequest('bootstrap-chat', request);
  const host = new FileCurrentChatHost(
    f.root,
    String(request.transcript),
    request.anchor as ChatAnchor,
  );
  const guard = councilWaitGuard(request, host);
  const binding = await guard.capture();
  const original = SqliteEvidenceStore.prototype.execute;
  const spy = vi.spyOn(SqliteEvidenceStore.prototype, 'execute').mockImplementation(function (
    this: SqliteEvidenceStore,
    command,
  ) {
    const reply = original.call(this, command);
    if (command.command.type !== 'state' || !reply.ok) return reply;
    const state = structuredClone(reply.value) as TechnicalState;
    const checkpoint = object(state.checkpoint),
      control = object(checkpoint.chat_control),
      messages = object(checkpoint.chat_messages);
    if (kind === 'owner') state.owner = 'other';
    if (kind === 'actor') state.owner = 'session';
    if (kind === 'generation') state.generation++;
    if (kind === 'frozen') state.frozen = true;
    if (kind === 'released') state.released = true;
    if (kind === 'lease') state.lease_until = 0;
    if (kind === 'status') control.status = 'cancelled';
    if (kind === 'observation')
      control.observed = { ...object(control.observed), model: 'changed' };
    if (kind === 'control-generation') control.generation = 9;
    if (kind === 'messages-generation') messages.generation = 9;
    if (kind === 'requirements') messages.requirements_revision = 1;
    if (kind === 'control') control.revision = 1;
    return { ...reply, value: state };
  });
  if (kind === 'actor') {
    const storage = object(request.storage);
    const alien = councilWaitGuard(
      {
        ...request,
        storage: {
          ...storage,
          grant: {
            ...object(storage.grant),
            context: { ...object(object(storage.grant).context), actor_id: 'other' },
          },
        },
      },
      host,
    );
    await expect(alien.capture()).rejects.toThrow('council-wait-owner-or-control-changed');
  } else
    await expect(guard.verify(binding)).rejects.toThrow(
      kind === 'requirements' || kind === 'control'
        ? 'council-wait-revision-changed'
        : 'council-wait-owner-or-control-changed',
    );
  spy.mockRestore();
});

it.each([false, true])(
  'previews exact compact context and admits only a new v3 run: enabled=%s',
  async (enabled) => {
    const spec = request.spec as RunSpec;
    spec.procedure_loading = 'by-action';
    if (enabled) spec.context_loading = 'fragments-v1';
    await executeChatRequest('bootstrap-chat', request);
    const action = {
      ...request,
      gates: [{ id: 'validate', kind: 'check', applicable: true, reason: 'fixture' }],
      code: true,
    };
    await executeChatRequest('execution-chat', action);
    await expect(
      executeChatRequest('compact-context-chat', { ...action, compact_action: 'execution-chat' }),
    ).rejects.toThrow('chat-compact-boundary-required');
    const transcript = String(request.transcript);
    const add = async (text: string) => {
      const record = {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'session',
          turn_id: 'turn',
          item: {
            type: 'CommandExecution',
            cwd: f.root,
            exit_code: 0,
            status: 'completed',
            aggregated_output: text,
          },
        },
      };
      await writeFile(
        transcript,
        (await readFile(transcript, 'utf8')) + JSON.stringify(record) + '\n',
      );
    };
    await writeFile(
      transcript,
      (await readFile(transcript, 'utf8')) +
        JSON.stringify({ type: 'compacted', payload: {} }) +
        '\n',
    );
    await add(
      f.loaded.rules
        .map((entry) =>
          JSON.stringify({
            chat_read: 'marker',
            locator: entry.locator,
            hash: entry.hash,
            content: entry.content,
          }),
        )
        .join('\n'),
    );
    const before = await executeChatRequest('status-chat', request);
    const info = await executeChatRequest('compact-context-chat', {
      ...action,
      compact_action: 'execution-chat',
    });
    expect(await executeChatRequest('status-chat', request)).toEqual(before);
    expect(info).toMatchObject({ status: enabled ? 'read-required' : 'preview', receipt: null });
    await add(JSON.stringify(info));
    if (enabled) {
      await executeChatRequest('execution-chat', action);
      const status = await executeChatRequest('status-chat', request);
      expect((status as { local: LocalRun }).local).toMatchObject({
        schema_version: 3,
        format: 'compact-context',
        loaded: { compact: { action: 'execution-chat' } },
      });
      const unknown = vi
        .spyOn(FileCurrentChatHost.prototype, 'load')
        .mockRejectedValueOnce('unknown');
      expect(
        await executeChatRequest('compact-context-chat', {
          ...action,
          compact_action: 'execution-chat',
        }),
      ).toMatchObject({
        status: 'full-recovery',
        receipt: null,
        reason: 'chat-compact-outcome-unknown',
      });
      unknown.mockRestore();
      const recoveryAction = { ...action, operation: 'compact-recovery-probe' };
      const candidate = (await executeChatRequest('compact-context-chat', {
        ...recoveryAction,
        compact_action: 'execution-chat',
      })) as Record<string, unknown>;
      const packet = JSON.parse(String(candidate.content)) as Record<string, unknown>;
      packet.role = 'auditor';
      const content = canonical(packet);
      await add(JSON.stringify({ ...candidate, content, hash: contentHash(content) }));
      await add(
        f.loaded.procedures
          .map((entry) =>
            JSON.stringify({
              chat_read: 'marker',
              locator: entry.locator,
              hash: entry.hash,
              content: entry.content,
            }),
          )
          .join('\n'),
      );
      expect(
        await executeChatRequest('compact-context-chat', {
          ...recoveryAction,
          compact_action: 'execution-chat',
        }),
      ).toMatchObject({
        status: 'full-recovery',
        receipt: { compact_fallback: 'chat-compact-context-stale' },
      });
    } else {
      await expect(executeChatRequest('execution-chat', action)).rejects.toThrow(
        'procedure-not-loaded:',
      );
    }
    await expect(
      executeChatRequest('compact-context-chat', { ...action, compact_action: 'invalid' }),
    ).rejects.toThrow('invalid-compact-action');
    await f.file(
      'compact-request.json',
      JSON.stringify({ schema_version: 1, ...action, compact_action: 'execution-chat' }),
    );
    const output: string[] = [];
    expect(
      await runChatCommand(
        ['compact-context-chat', resolve(f.root, 'compact-request.json')],
        (value) => output.push(value),
        () => {},
      ),
    ).toBe(0);
    expect(JSON.parse(output[0]!) as unknown).toMatchObject({ chat_compact: 'marker' });
  },
);

it.each([
  ['substantial', true],
  ['local', true],
  ['substantial', false],
  ['local', false],
] as const)(
  'reads compact context before binding the %s bootstrap route: observed=%s',
  async (route, observed) => {
    const spec = request.spec as RunSpec;
    spec.procedure_loading = 'by-action';
    spec.context_loading = 'fragments-v1';
    if (route === 'local') {
      f.target.inputs = await f.inputs.capture(
        { files: ['proof.txt', 'source.txt'], directories: [] },
        'local bootstrap',
      );
      for (const selected of Object.values(f.selection)) selected.inputs = f.target.inputs;
      const plan: LocalImplementationPlan = {
        schema_version: 1,
        requirement: f.proof,
        basis: [f.proof],
        owner: await f.ref('source.txt'),
        paths: ['source.txt'],
        consumers: [await f.ref('source.txt')],
        consumers_complete: true,
        risks: {
          new_behavior: false,
          new_contract: false,
          architecture: false,
          storage: false,
          authority: false,
          security: false,
          data_integrity: false,
          unknown_consumers: false,
        },
        reason: 'Existing local contract',
        checks: ['validate'],
        criterion: 'Boundary holds',
      };
      await f.file(
        'planning.json',
        JSON.stringify({
          schema_version: 2,
          task_id: 'task',
          council: createCouncil('planning', f.selection, f.target),
          local: { plan, source: f.proof, inputs: f.target.inputs, selection: f.selection },
        }),
      );
      spec.route = { kind: 'local', accepted_plan: await f.ref('planning.json'), plan };
    }
    await executeChatRequest('prepare-chat', {
      ...request,
      spec: { ...spec, route: { kind: 'substantial', accepted_plan: null } },
    });
    const transcript = String(request.transcript);
    const read = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'session',
        turn_id: 'turn',
        item: {
          type: 'CommandExecution',
          cwd: f.root,
          exit_code: 0,
          status: 'completed',
          aggregated_output: f.loaded.rules
            .map((entry) =>
              JSON.stringify({
                chat_read: 'marker',
                locator: entry.locator,
                hash: entry.hash,
                content: entry.content,
              }),
            )
            .join('\n'),
        },
      },
    };
    await writeFile(
      transcript,
      (await readFile(transcript, 'utf8')) +
        JSON.stringify({ type: 'compacted', payload: {} }) +
        '\n' +
        JSON.stringify(read) +
        '\n',
    );
    const before = await executeChatRequest('status-chat', request);
    const packet = (await executeChatRequest('compact-context-chat', {
      ...request,
      compact_action: 'bootstrap-chat',
    })) as Record<string, unknown>;
    expect(packet).toMatchObject({ status: 'read-required', receipt: null });
    expect(await executeChatRequest('status-chat', request)).toEqual(before);
    if (!observed) {
      await expect(executeChatRequest('bootstrap-chat', request)).rejects.toThrow(
        'chat-compact-full-load-required:chat-compact-read-unconfirmed',
      );
      expect(await executeChatRequest('status-chat', request)).toEqual(before);
      return;
    }
    read.payload.item.aggregated_output = JSON.stringify(packet);
    await writeFile(transcript, (await readFile(transcript, 'utf8')) + JSON.stringify(read) + '\n');
    expect(
      await executeChatRequest('compact-context-chat', {
        ...request,
        compact_action: 'bootstrap-chat',
      }),
    ).toMatchObject({ status: 'loaded', receipt: { compact: { action: 'bootstrap-chat' } } });
    const result = (await executeChatRequest('bootstrap-chat', request)) as { run: LocalRun };
    expect(result.run).toMatchObject({
      status: 'ready',
      schema_version: 3,
      spec: { route: spec.route },
      loaded: { compact: { action: 'bootstrap-chat', package_hash: packet.hash } },
    });
    expect(result.run.loaded!.compact_fallback).toBeUndefined();
    expect(await executeChatRequest('status-chat', request)).toMatchObject({ local: result.run });
  },
);

it('dispatches an isolated coder through the current-chat writer gates and exposes a confirmed no-session refusal', async () => {
  await f.file(
    'tools/agent-workflow/roles/coder.md',
    await readFile(resolve(import.meta.dirname, '../roles/coder.md'), 'utf8'),
  );
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  await executeChatRequest('bootstrap-chat', request);
  await executeChatRequest('execution-chat', {
    ...request,
    gates: [{ id: 'validate', kind: 'check', applicable: true, reason: 'fixture code' }],
    code: true,
  });
  const coderRequest = {
    ...request,
    binary: 'fixture-codex-missing',
    coder: {
      action: 'run',
      id: 'bounded',
      assignment: {
        goal: 'fixture isolated operation',
        paths: ['source.txt'],
        files: ['source.txt'],
        checks: [],
        criterion: 'fixture preserves source',
      },
    },
  };
  expect(await executeChatRequest('coder-chat', coderRequest)).toMatchObject({
    status: 'not-started',
    session: null,
  });
  expect(await executeChatRequest('status-chat', request)).toMatchObject({
    coders: [{ id: 'bounded', status: 'not-started', native_policy: null }],
  });
});

it('preflights and resumes a prepared batch under the real owner and writer gates without repeating processes', async () => {
  await f.file(
    f.card.locator,
    (await readFile(resolve(f.root, f.card.locator), 'utf8')) +
      '\n## Критерии\n\n- [ ] C1: observed check\n',
  );
  const spec = request.spec as LocalRun['spec'];
  request.spec = { ...spec, identity: { task_id: 'task', card: await f.ref(f.card.locator) } };
  const counter = resolve(external, 'batch-count.log');
  const executable = resolve(external, 'yarn');
  await writeFile(
    executable,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(counter)}, process.argv[2]+'\\n');\n`,
  );
  await chmod(executable, 0o700);
  vi.stubEnv('PATH', external + ':' + process.env.PATH);
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  await executeChatRequest('bootstrap-chat', request);
  const check = {
    id: 'unit',
    criterion: 'C1',
    command: { file: 'yarn', args: ['unit'] },
    discovery: { files: ['source.txt', f.card.locator, executable], directories: [] },
    attested_by: 'owner',
  };
  const map = ['C1', 'validate'].map((criterion) => ({
    criterion,
    implementation: ['source.txt'],
    verification: [f.card.locator],
    check:
      criterion === 'C1'
        ? check
        : { ...check, id: 'full', criterion, command: { file: 'yarn', args: ['validate:brief'] } },
  }));
  request.check_plan = await freezeChecks(f.root, external, f.card.locator, map, [
    { ...check, id: 'startup', criterion: 'startup' },
  ]);
  expect(await executeChatRequest('preflight-checks-chat', request)).toMatchObject({
    ready: true,
    scope: 'startup-only',
  });
  const packet = resolve(external, 'batch-request.json');
  await writeFile(packet, JSON.stringify({ schema_version: 1, ...request }));
  const output: string[] = [];
  expect(
    await runChatCommand(
      ['checks-chat', packet],
      (v) => output.push(v),
      (v) => {
        throw new Error(v);
      },
    ),
  ).toBe(0);
  expect(JSON.parse(output[0]!) as { ready: boolean }).toMatchObject({ ready: true });
  const details = (JSON.parse(output[0]!) as { details: InputRef }).details;
  expect(readChatArtifact(details)).toMatchObject({ purpose: 'check-package' });
  await executeChatRequest('checks-chat', request);
  expect((await readFile(counter, 'utf8')).trim().split('\n')).toEqual([
    'unit',
    'unit',
    'validate:brief',
  ]);
  const storage = request.storage as { root: string };
  await writeFile(chatWriterLock(storage.root), 'another owner');
  await expect(executeChatRequest('preflight-checks-chat', request)).rejects.toThrow(
    'chat-writer-busy-or-unknown',
  );
  await rm(chatWriterLock(storage.root));
  await f.file('other-plan.md', '# Other\n## Критерии\n- [ ] C1: other\n');
  const otherMap = map.map((entry) => ({ ...entry, verification: ['other-plan.md'] }));
  request.check_plan = await freezeChecks(f.root, external, 'other-plan.md', otherMap);
  await expect(executeChatRequest('checks-chat', request)).rejects.toThrow(
    'prepared-check-task-mismatch',
  );
}, 15_000);

it.each([undefined, 'by-action'] as const)(
  'runs a persisted council checkpoint through the %s managed gate and rejects replacement scope and external paths',
  async (mode) => {
    if (mode !== undefined) (request.spec as RunSpec).procedure_loading = mode;
    await executeChatRequest('bootstrap-chat', request);
    request.council = f.council('acceptance');
    const path = resolve(external, 'managed-acceptance.json');
    request.council_file = path;
    expect(await executeChatRequest('council-run-chat', request)).toHaveProperty(
      'phase',
      'acceptance',
    );
    expect(readManaged(path)).toHaveProperty('phase', 'acceptance');
    const saved = vi
      .spyOn(councilRunner, 'runTaskChatCouncil')
      .mockImplementationOnce(
        async (council, _spec, _directory, _binary, save) => save(council) ?? council,
      );
    request.binary = 'fixture-codex';
    await executeChatRequest('council-run-chat', request);
    expect(saved).toHaveBeenCalledOnce();
    saved.mockRestore();
    request.council = { ...f.council('acceptance'), target: { ...f.target, scope: 'different' } };
    await expect(executeChatRequest('council-run-chat', request)).rejects.toThrow(
      'council-checkpoint-conflict',
    );
    delete request.council;
    await executeChatRequest('council-run-chat', request);
    request.council_file = resolve(external, 'missing-council.json');
    await expect(executeChatRequest('council-run-chat', request)).rejects.toThrow(
      'council-checkpoint-required',
    );
    request.council_file = resolve(f.root, 'outside-council.json');
    await expect(executeChatRequest('council-run-chat', request)).rejects.toThrow(
      'council-checkpoint-outside-evidence',
    );
    await f.file('package.txt', 'observed evidence');
    const council = f.council('acceptance');
    council.target.evidence_inputs = await f.inputs.capture(
      { files: ['source.txt', 'package.txt'], directories: [] },
      'package',
    );
    request.council = council;
    request.council_file = resolve(external, 'evidence-council.json');
    await f.file('package.txt', 'changed before council');
    await expect(executeChatRequest('council-run-chat', request)).rejects.toThrow(
      'council-target-stale',
    );
    expect(readManaged(request.council_file as string)).toBeNull();
  },
);

it('loads a retained planning certificate and exports an existing legacy archive through --full', async () => {
  request.code = false;
  request.gates = [{ id: 'proof', kind: 'check', applicable: true, reason: 'proof' }];
  const previous = await f.ref('planning.json');
  const plan = JSON.parse(await readFile(resolve(f.root, 'planning.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  await f.file(
    'planning.json',
    encodeChatArtifact(f.root, { ...plan, retained_source: previous }, 'minimal'),
  );
  const spec = request.spec as LocalRun['spec'];
  spec.route = { kind: 'substantial', accepted_plan: await f.ref('planning.json') };
  await executeChatRequest('bootstrap-chat', request);
  await executeChatRequest('execution-chat', request);
  const storage = request.storage as { root: string; grant: typeof grant };
  const db = new StoreDatabase(storage.root, storage.grant.context, noStorageProbe);
  const state = db.state('current');
  const checkpoint = state.checkpoint as unknown as { workflow: { execution: Execution } };
  const payload = JSON.stringify({ text: 'legacy '.repeat(1000) });
  checkpoint.workflow.execution.history.push({ id: 'legacy', payload });
  const packed = compactArchive(state.checkpoint);
  for (const blob of packed.blobs) db.files.publish(blob.content);
  state.checkpoint = packed.value;
  delete state.retention_gc;
  db.retained = false;
  db.save(state, true);
  db.close();
  await f.file('legacy-request.json', JSON.stringify({ ...request, schema_version: 1 }));
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runChatCommand(
    ['execution-chat', resolve(f.root, 'legacy-request.json'), '--full'],
    (text) => output.push(text),
    (text) => errors.push(text),
  );
  expect(errors).toEqual([]);
  expect(code).toBe(0);
  expect((JSON.parse(output[0]!) as Execution).history.at(-1)).toMatchObject({
    id: 'legacy',
    payload,
  });
});
async function continuationTurn(human = true) {
  const records = (await readFile(request.transcript as string, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const previousContext = records.find((r) => r.type === 'turn_context')!.payload as Record<
    string,
    unknown
  >;
  const previousRead = records.find(
    (r) =>
      r.type === 'event_msg' && (r.payload as Record<string, unknown>).type === 'item_completed',
  )!.payload as Record<string, unknown>;
  records.push(
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } },
  );
  const index = records.length;
  records.push(
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: human ? 'user' : 'developer',
        content: [{ type: 'input_text', text: 'Продолжай' }],
      },
    },
    { type: 'turn_context', payload: { ...previousContext, turn_id: 'next' } },
    { type: 'event_msg', payload: { ...previousRead, turn_id: 'next' } },
  );
  await writeFile(
    request.transcript as string,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  request.anchor = { ...(request.anchor as Record<string, unknown>), turn_id: 'next' };
  request.human_source = {
    locator: request.transcript + '#L' + (index + 1),
    hash: contentHash(JSON.stringify(records[index]) + '\n'),
  };
}
async function revisedRequirements(): Promise<ChatMessageEvent> {
  const spec = request.spec as LocalRun['spec'];
  await f.file('assignment-v2.txt', 'Explicit new requirements; retain task identity and history.');
  const assignment = await f.ref('assignment-v2.txt');
  return {
    type: 'REQUIREMENTS',
    id: 'resume-requirements',
    expected_revision: 0,
    generation: 1,
    thread_id: 'session',
    source: request.human_source as { locator: string; hash: string },
    affected: ['probe'],
    revision: {
      assignment,
      sources: await Promise.all(spec.sources.map((s) => f.ref(s.locator))),
      scope: spec.scope,
      outcome: spec.outcome,
      criteria: spec.criteria,
      card: await f.ref(f.card.locator),
    },
    target: { ...f.target, base: assignment.hash, diff: assignment },
    gates: [],
  };
}
it('keeps a combined revision uncommitted on same-turn expiry and rejects unbound revision commands', async () => {
  await executeChatRequest('bootstrap-chat', request);
  const message = await revisedRequirements();
  for (const invalid of [null, { ...message, type: 'ASK' }, { ...message, source: f.proof }]) {
    request.message = invalid;
    await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
      'chat-continuation-requirements-source-mismatch',
    );
  }
  request.message = message;
  request.authorization = request.human_source;
  await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
    'chat-continuation-requirements-source-mismatch',
  );
  delete request.authorization;
  vi.spyOn(Date, 'now').mockReturnValue((request.lease_until as number) + 1);
  await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
    'chat-expired-owner-boundary-required',
  );
  expect(await executeChatRequest('status-chat', request)).toMatchObject({
    ownership: { expired: true },
    messages: { requirements_revision: 0 },
    control: { observed: { turn_id: 'turn' } },
  });
});
it('retries a combined revision after checkpoint failure without an executable partial revision', async () => {
  await executeChatRequest('bootstrap-chat', request);
  await continuationTurn();
  await f.file('source.txt', 'Changed stable requirements');
  request.message = await revisedRequirements();
  vi.spyOn(Date, 'now').mockReturnValue((request.lease_until as number) + 1);
  vi.spyOn(TaskChatContext.prototype, 'save').mockRejectedValueOnce(
    new Error('checkpoint write refused'),
  );
  await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
    'checkpoint write refused',
  );
  expect(await executeChatRequest('status-chat', request)).toMatchObject({
    ownership: { expired: false },
    messages: { requirements_revision: 0 },
    control: { observed: { turn_id: 'turn' } },
  });
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow('chat-resume-required');
  const revised = await executeChatRequest('continue-chat', request);
  expect(revised).toMatchObject({
    run: { status: 'waiting', spec: { route: { kind: 'substantial', accepted_plan: null } } },
    messages: { requirements_revision: 1 },
    control: { observed: { turn_id: 'next' } },
  });
  expect(await executeChatRequest('continue-chat', request)).toEqual(revised);
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow('action-forbidden');
});
it('continues an active same-turn request but refuses expired same-turn recovery without a terminal boundary', async () => {
  await executeChatRequest('bootstrap-chat', request);
  vi.spyOn(Date, 'now').mockReturnValue((request.lease_until as number) + 1);
  await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
    'chat-expired-owner-boundary-required',
  );
  vi.restoreAllMocks();
  expect(await executeChatRequest('continue-chat', request)).toMatchObject({
    run: { status: 'ready' },
  });
});
it('renews a repeated live continuation without duplicating control history or changing the owner', async () => {
  await executeChatRequest('bootstrap-chat', request);
  const continued = await executeChatRequest('continue-chat', request);
  const before = await executeChatRequest('status-chat', request);
  const storage = request.storage as { root: string; grant: typeof grant };
  const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
  const state = store.execute({ context: storage.grant.context, command: { type: 'state' } });
  if (!state.ok) throw new Error('fixture state');
  const snapshot = state.value as TechnicalState;
  const now = snapshot.lease_until - 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  expect(await executeChatRequest('continue-chat', request)).toEqual(continued);
  expect(await executeChatRequest('status-chat', request)).toMatchObject({
    ...before,
    checkpoint: { ...object(object(before).checkpoint), revision: snapshot.revision + 1 },
    ownership: {
      owner: snapshot.owner,
      generation: snapshot.generation,
      lease_until: now + 30 * 60_000,
      expired: false,
    },
  });
});
it('automatically recovers the accepted owner before the next execution command', async () => {
  await executeChatRequest('bootstrap-chat', request);
  await executeChatRequest('continue-chat', request);
  const status = (await executeChatRequest('status-chat', request)) as {
    ownership: { lease_until: number };
  };
  vi.spyOn(Date, 'now').mockReturnValue(status.ownership.lease_until + 1);
  request.gates = [{ id: 'probe', kind: 'check', applicable: true, reason: 'bounded check' }];
  request.code = false;
  await expect(executeChatRequest('execution-chat', request)).resolves.toMatchObject({
    status: 'implementing',
  });
  expect(await executeChatRequest('status-chat', request)).toMatchObject({
    ownership: { expired: false, owner: 'session' },
  });
});
it('revalidates and recovers only an already accepted live same-turn owner with a durable proof', async () => {
  await executeChatRequest('bootstrap-chat', request);
  await executeChatRequest('continue-chat', request);
  const storage = request.storage as { root: string; grant: typeof grant };
  const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
  const journal = new TaskChatContext(
    { execute: async (r) => store.execute(r) },
    storage.grant.context,
    1,
  );
  const before = await journal.read();
  const legacy = structuredClone(before);
  delete legacy.control!.unreconciled_turns;
  await journal.save(before, legacy, 'fixture:legacy-live-control');
  const state = store.execute({ context: storage.grant.context, command: { type: 'state' } });
  if (!state.ok) throw new Error('fixture state');
  const snapshot = state.value as TechnicalState;
  vi.spyOn(Date, 'now').mockReturnValue(snapshot.lease_until + 1);
  const settled = vi.spyOn(FileChatRecovery.prototype, 'settled');
  const load = vi.spyOn(FileCurrentChatHost.prototype, 'load');
  await expect(executeChatRequest('continue-chat', request)).resolves.toMatchObject({
    run: { status: 'ready' },
  });
  expect(settled).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledOnce();
  expect(await executeChatRequest('status-chat', request)).toMatchObject({
    ownership: { owner: snapshot.owner, generation: snapshot.generation, expired: false },
  });
  const recovered = store.execute({ context: storage.grant.context, command: { type: 'state' } });
  if (!recovered.ok) throw new Error('fixture state');
  const renewed = recovered.value as TechnicalState;
  expect(renewed.checkpoint).toEqual(snapshot.checkpoint);
  expect(renewed.lease_until).toBe(snapshot.lease_until + 1 + 30 * 60_000);
});
it.each([false, true])(
  'recovers after fresh compaction LOAD only for an accepted active continuation: %s',
  async (accepted) => {
    await executeChatRequest('bootstrap-chat', request);
    if (accepted) await executeChatRequest('continue-chat', request);
    const records = (await readFile(request.transcript as string, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const context = records.find((record) => record.type === 'turn_context')!;
    const reads = records.at(-1)!;
    records.push({ type: 'compacted', payload: {} }, context);
    await writeFile(
      request.transcript as string,
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    vi.spyOn(Date, 'now').mockReturnValue((request.lease_until as number) + 30 * 60_000 + 1);
    await expect(executeChatRequest('continue-chat', request)).rejects.toThrow();
    records.push(reads);
    await writeFile(
      request.transcript as string,
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    if (accepted) {
      expect(await executeChatRequest('continue-chat', request)).toMatchObject({
        run: { status: 'ready' },
      });
      expect(await executeChatRequest('status-chat', request)).toMatchObject({
        ownership: { generation: 1, expired: false },
      });
    } else {
      await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
        'chat-expired-owner-boundary-required',
      );
    }
  },
);
it('cannot recover a cached live owner with unsettled writers or changed inputs', async () => {
  await executeChatRequest('bootstrap-chat', request);
  await executeChatRequest('continue-chat', request);
  const storage = request.storage as { root: string; grant: typeof grant };
  const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
  const result = store.execute({ context: storage.grant.context, command: { type: 'state' } });
  if (!result.ok) throw new Error('fixture state');
  const state = result.value as TechnicalState;
  vi.spyOn(Date, 'now').mockReturnValue(state.lease_until + 1);
  vi.spyOn(FileChatRecovery.prototype, 'settled').mockRejectedValueOnce(
    new Error('unsettled writer'),
  );
  await expect(executeChatRequest('continue-chat', request)).rejects.toThrow('unsettled writer');
  const read = TaskChatContext.prototype.read;
  const journal = vi.spyOn(TaskChatContext.prototype, 'read').mockImplementation(async function (
    this: TaskChatContext,
  ) {
    const context = await read.call(this);
    context.control!.unreconciled_turns = ['earlier'];
    return context;
  });
  vi.spyOn(FileCurrentChatHost.prototype, 'continuation').mockRejectedValueOnce(
    new Error('old writer not stopped'),
  );
  await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
    'old writer not stopped',
  );
  journal.mockRestore();
  await f.file('source.txt', 'changed source');
  await expect(executeChatRequest('continue-chat', request)).rejects.toThrow();
  expect(await executeChatRequest('status-chat', request)).toMatchObject({
    ownership: { lease_until: state.lease_until, expired: true },
  });
});
it('continues an active automatic native turn from the last accepted human source', async () => {
  await executeChatRequest('bootstrap-chat', request);
  await executeChatRequest('continue-chat', request);
  const human = request.human_source;
  await continuationTurn(false);
  request.human_source = human;
  request.previous_source_turn = 'turn';
  request.marker = 'automatic-marker';
  const resumed = await executeChatRequest('continue-chat', request);
  expect(resumed).toMatchObject({
    run: { status: 'ready', generation: 1 },
    control: { status: 'active', observed: { turn_id: 'next' } },
  });
  expect(await executeChatRequest('continue-chat', request)).toEqual(resumed);
  request.check = {
    id: 'automatic-probe',
    command: { file: process.execPath, args: ['-e', "console.log('automatic check')"] },
    discovery: { files: ['source.txt'], directories: [] },
    attested_by: 'owner',
  };
  expect(await executeChatRequest('check-chat', request)).toMatchObject({
    check: { verdict: 'PASS' },
  });
});
it.each(['unaccepted', 'paused', 'new-human', 'wrong-turn', 'requirements'])(
  'refuses inherited human authority for %s',
  async (fault) => {
    await executeChatRequest('bootstrap-chat', request);
    if (fault !== 'unaccepted') await executeChatRequest('continue-chat', request);
    const human = request.human_source;
    if (fault === 'paused')
      await executeChatRequest('control-chat', {
        ...request,
        control: {
          type: 'PAUSE',
          id: 'pause',
          expected_revision: 1,
          generation: 1,
          thread_id: 'session',
          source: human,
          reason: 'Explicit test pause',
        },
      });
    await continuationTurn(fault === 'new-human');
    request.human_source = human;
    request.previous_source_turn = fault === 'wrong-turn' ? 'other' : 'turn';
    if (fault === 'requirements') request.message = await revisedRequirements();
    await expect(executeChatRequest('continue-chat', request)).rejects.toThrow();
    expect(await executeChatRequest('status-chat', request)).toMatchObject({
      control: { observed: { turn_id: 'turn' } },
    });
  },
);
it.each(
  (['pending', 'unknown', 'confirmed', 'not-started'] as const).flatMap((outcome) =>
    [false, true].flatMap((requirements) =>
      [false, true].map((cached) => ({ outcome, requirements, cached })),
    ),
  ),
)(
  'checks Store effects before continuation: $outcome requirements=$requirements cached=$cached',
  async ({ outcome, requirements, cached }) => {
    await executeChatRequest('bootstrap-chat', request);
    await continuationTurn();
    if (requirements) request.message = await revisedRequirements();
    if (cached) await executeChatRequest('continue-chat', request);
    const storage = request.storage as { root: string; grant: typeof grant };
    const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
    const state = store.execute({ context: storage.grant.context, command: { type: 'state' } });
    if (!state.ok) throw new Error('fixture state');
    let snapshot = state.value as TechnicalState;
    expect(
      store.execute(
        signed(
          {
            type: 'checkpoint',
            state: snapshot.checkpoint,
            effects: [{ id: 'pending', intent: {} }],
          },
          snapshot.revision,
          1,
          'pending',
          storage.grant,
        ),
      ).ok,
    ).toBe(true);
    if (outcome !== 'pending') {
      snapshot = (
        store.execute({ context: storage.grant.context, command: { type: 'state' } }) as {
          ok: true;
          value: TechnicalState;
        }
      ).value;
      expect(
        store.execute(
          signed(
            { type: 'effect', id: 'pending', outcome, receipt: {} },
            snapshot.revision,
            1,
            'effect',
            storage.grant,
          ),
        ).ok,
      ).toBe(true);
    }
    if (outcome === 'pending' || outcome === 'unknown')
      await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
        'chat-effect-outcome-unknown',
      );
    else
      expect(await executeChatRequest('continue-chat', request)).toMatchObject({
        run: { status: requirements ? 'waiting' : 'ready' },
      });
  },
);
it.each([false, true])(
  'refuses a concurrent Store revision before recovery, requirements=%s',
  async (requirements) => {
    await executeChatRequest('bootstrap-chat', request);
    await continuationTurn();
    if (requirements) request.message = await revisedRequirements();
    const storage = request.storage as { root: string; grant: typeof grant };
    const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
    const original = FileCurrentChatHost.prototype.load;
    vi.spyOn(FileCurrentChatHost.prototype, 'load').mockImplementationOnce(async function (
      this: FileCurrentChatHost,
      run,
      marker,
    ) {
      const proof = await original.call(this, run, marker);
      const snapshot = store.execute({
        context: storage.grant.context,
        command: { type: 'state' },
      });
      if (!snapshot.ok) throw new Error('fixture state');
      expect(
        store.execute(
          signed(
            { type: 'renew', lease_until: Date.now() + 60_000 },
            (snapshot.value as TechnicalState).revision,
            1,
            'concurrent-renew',
            storage.grant,
          ),
        ).ok,
      ).toBe(true);
      return proof;
    });
    await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
      'chat-owner-recovery-conflict',
    );
    expect(await executeChatRequest('status-chat', request)).toMatchObject({
      control: { observed: { turn_id: 'turn' } },
    });
  },
);
it('continues the same owner after expiry with one command and does not repeat a delivered command', async () => {
  await executeChatRequest('bootstrap-chat', request);
  await continuationTurn();
  vi.spyOn(Date, 'now').mockReturnValue((request.lease_until as number) + 1);
  const continued = await executeChatRequest('continue-chat', request);
  expect(continued).toMatchObject({
    run: { status: 'ready', generation: 1 },
    control: { observed: { turn_id: 'next' }, status: 'active' },
  });
  const status = await executeChatRequest('status-chat', request);
  expect(status).toMatchObject({ ownership: { expired: false, owner: 'session', generation: 1 } });
  expect(await executeChatRequest('continue-chat', request)).toEqual(continued);
  const output: string[] = [];
  request.gates = [{ id: 'probe', kind: 'check', applicable: true, reason: 'isolated process' }];
  request.code = false;
  await f.file('continue-request.json', JSON.stringify({ schema_version: 1, ...request }));
  expect(
    await runChatCommand(
      ['continue-chat', resolve(f.root, 'continue-request.json')],
      (s) => output.push(s),
      () => {},
    ),
  ).toBe(0);
  const brief = JSON.parse(output[0]!) as { details: { locator: string; hash: string } };
  const full = await readFile(brief.details.locator, 'utf8');
  expect(contentHash(full)).toBe(brief.details.hash);
  expect(full.length).toBeLessThan(2048);
  expect(JSON.parse(full) as unknown).toMatchObject({
    purpose: 'operation-result',
    outcome: { command: 'continue-chat', status: 'ready' },
  });
  output.length = 0;
  expect(
    await runChatCommand(
      ['continue-chat', resolve(f.root, 'continue-request.json'), '--full'],
      (s) => output.push(s),
      () => {},
    ),
  ).toBe(0);
  expect(JSON.parse(output[0]!)).toEqual(continued);
  output.length = 0;
  expect(
    await runChatCommand(
      ['status-chat', resolve(f.root, 'continue-request.json'), '--brief'],
      (s) => output.push(s),
      () => {},
    ),
  ).toBe(0);
  expect(JSON.parse(output[0]!)).toMatchObject({
    command: 'status-chat',
    run_id: 'run',
    control: 'active',
    ownership: { expired: false },
  });
  output.length = 0;
  const errors: string[] = [];
  const exit = await runChatCommand(
    ['execution-chat', resolve(f.root, 'continue-request.json'), '--brief'],
    (s) => output.push(s),
    (s) => errors.push(s),
  );
  expect(errors).toEqual([]);
  expect(exit).toBe(0);
  expect(JSON.parse(output[0]!)).toMatchObject({
    command: 'execution-chat',
    status: 'implementing',
  });
  expect(typeof (JSON.parse(output[0]!) as { details: { hash: string } }).details.hash).toBe(
    'string',
  );
});
it.each([false, true])(
  'refuses a service message and unfinished old operation before recovery, requirements=%s',
  async (requirements) => {
    await executeChatRequest('bootstrap-chat', request);
    await continuationTurn(false);
    if (requirements) request.message = await revisedRequirements();
    vi.spyOn(Date, 'now').mockReturnValue((request.lease_until as number) + 1);
    await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
      'chat-human-message-unconfirmed',
    );
    expect(await executeChatRequest('status-chat', request)).toMatchObject({
      ownership: { expired: true },
    });
    const source = request.human_source as { locator: string; hash: string };
    const lines = (await readFile(request.transcript as string, 'utf8')).trimEnd().split('\n');
    const index = Number(source.locator.split('#L')[1]) - 1;
    lines[index] = lines[index]!.replace('developer', 'user');
    source.hash = contentHash(lines[index] + '\n');
    lines.splice(
      5,
      0,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_started',
          thread_id: 'session',
          turn_id: 'turn',
          item: { type: 'CommandExecution', id: 'unfinished' },
        },
      }),
    );
    source.locator = (request.transcript as string) + '#L' + (index + 2);
    await writeFile(request.transcript as string, lines.join('\n') + '\n');
    await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
      'chat-continuation-operation-pending',
    );
    expect(await executeChatRequest('status-chat', request)).toMatchObject({
      ownership: { expired: true },
    });
  },
);
it('accepts a verified user command from another chat without asking for a new human message', async () => {
  await executeChatRequest('bootstrap-chat', request);
  await continuationTurn(false);
  await mkdir(resolve(external, 'sessions'), { recursive: true });
  const transcript = resolve(external, 'sessions/issuer.jsonl');
  const original = (await readFile(request.transcript as string, 'utf8'))
    .trimEnd()
    .split('\n')
    .slice(0, 4)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  (original[0]!.payload as Record<string, unknown>).id = 'issuer';
  (original[0]!.payload as Record<string, unknown>).session_id = 'issuer';
  await writeFile(transcript, original.map((r) => JSON.stringify(r)).join('\n') + '\n');
  vi.stubEnv('CODEX_HOME', external);
  vi.stubEnv('CODEX_THREAD_ID', 'issuer');
  const authority = await new NativeUserCommands(f.root).issue({
    transcript,
    anchor: { thread_id: 'issuer', turn_id: 'turn', workspace: f.root, host_id: 'local' },
    human_source: {
      locator: transcript + '#L3',
      hash: contentHash(JSON.stringify(original[2]) + '\n'),
    },
    command_root: external,
    target: {
      project_id: 'project',
      task_id: 'task',
      run_id: 'run',
      thread_id: 'session',
      generation: 1,
      control_revision: 0,
      requirements_revision: 0,
    },
  });
  original.push({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'issuer',
      turn_id: 'turn',
      item: {
        type: 'CommandExecution',
        cwd: f.root,
        status: 'completed',
        exit_code: 0,
        aggregated_output: JSON.stringify(authority),
      },
    },
  });
  await writeFile(transcript, original.map((r) => JSON.stringify(r)).join('\n') + '\n');
  vi.stubEnv('CODEX_THREAD_ID', 'session');
  request.authorization = authority.authorization;
  const result = await executeChatRequest('continue-chat', request);
  expect(result).toMatchObject({ run: { status: 'ready' }, control: { status: 'active' } });
  expect(await executeChatRequest('continue-chat', request)).toEqual(result);
});
it.each([false, true])(
  'retains retry receipts through LOAD, checks and projection with frozen sources=%s',
  async (frozen) => {
    const discovery = {
      files: frozen ? ['source.txt', f.card.locator] : ['source.txt'],
      directories: [],
      ...(frozen ? { repository: true as const } : {}),
    };
    if (frozen) {
      execFileSync('git', ['init', '-q'], { cwd: f.root });
      f.target.inputs = await new FileWorkflowInputs(f.root, external).capture(discovery, 'owner');
      const spec = request.spec as LocalRun['spec'];
      request.spec = {
        ...spec,
        sources: [...spec.sources, spec.assignment, ...spec.rules, await f.ref(f.card.locator)],
      };
    }
    const boot = (await executeChatRequest('bootstrap-chat', request)) as { run: LocalRun };
    expect(boot.run.status).toBe('ready');
    expect(await executeChatRequest('bootstrap-chat', request)).toMatchObject({
      run: { status: 'ready' },
    });
    expect(await executeChatRequest('status-chat', request)).toMatchObject({
      execution: { status: 'not-started' },
    });
    request.gates = [
      { id: 'probe', kind: 'check', applicable: true, reason: 'isolated real process' },
    ];
    request.code = false;
    let run = (await executeChatRequest('execution-chat', request)) as Execution;
    expect(run.status).toBe('implementing');
    const storage = request.storage as { root: string; grant: typeof grant };
    const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
    const context = new TaskChatContext(
      { execute: async (value) => store.execute(value) },
      storage.grant.context,
      1,
    );
    const checkpoint = await context.read({ archive: true });
    const history = [
      {
        id: 'historical-failure',
        payload: JSON.stringify({ verdict: 'FAIL', text: 'ёж\n\uD800'.repeat(17000) }),
      },
      ...checkpoint.workflow.execution!.history,
    ];
    run = { ...run, history };
    await context.save(
      checkpoint,
      { ...checkpoint, workflow: { ...checkpoint.workflow, execution: run } },
      'historical-checkpoint',
    );
    const continued = await executeChatRequest('continue-chat', request);
    expect(await executeChatRequest('continue-chat', request)).toEqual(continued);
    const retainedHistory = (await context.read()).workflow.execution!.history;
    expect(retainedHistory.map((entry) => entry.id)).toEqual(history.map((entry) => entry.id));
    expect(
      retainedHistory.every((entry) => entry.payload === '' && entry.fingerprint?.length === 64),
    ).toBe(true);
    request.check = {
      id: 'probe',
      command: { file: process.execPath, args: ['-e', "console.log('checked')"] },
      discovery,
      attested_by: 'owner',
    };
    const proof = (await executeChatRequest('check-chat', request)) as ChatCheckProof;
    expect(proof.check.verdict).toBe('PASS');
    expect(await executeChatRequest('check-chat', request)).toEqual(proof);
    expect(await executeChatRequest('status-chat', request)).toMatchObject({
      local: { results: [{ outcome: 'PASS' }] },
    });
    request.event = executionEvent(run, {
      type: 'REVIEW',
      target: f.target,
      selection: f.selection,
      baseline: {
        kind: 'real',
        scenario: 'native process in isolated fixture',
        evidence: proof.check.evidence,
        inputs: f.target.inputs,
        elapsed_ms: proof.elapsed_ms,
        exit_code: proof.exit_code!,
      },
      checks: [
        { ...proof.check, inputs: f.target.inputs },
        {
          id: 'info',
          verdict: 'N/A',
          reason: 'not a process gate',
          evidence: f.proof,
          inputs: f.target.inputs,
        },
      ],
    });
    run = (await executeChatRequest('execution-chat', request)) as Execution;
    request.event = executionEvent(run, {
      type: 'ACCEPT',
      council: f.council('acceptance'),
      findings: [],
    });
    run = (await executeChatRequest('execution-chat', request)) as Execution;
    await writeFile(
      resolve(external, 'accept-request.json'),
      JSON.stringify({ schema_version: 1, ...request }),
    );
    const output: string[] = [],
      errors: string[] = [];
    expect(
      await runChatCommand(
        ['execution-chat', resolve(external, 'accept-request.json')],
        (value) => output.push(value),
        (value) => errors.push(value),
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(output[0]!.length).toBeLessThan(2048);
    const receipt = JSON.parse(output[0]!) as {
      status: string;
      details: { locator: string; hash: string };
    };
    expect(receipt.status).toBe('review');
    expect(readChatArtifact(receipt.details)).toMatchObject({
      purpose: 'operation-result',
      outcome: { command: 'execution-chat', status: 'review' },
    });
    const full: string[] = [];
    expect(
      await runChatCommand(
        ['execution-chat', resolve(external, 'accept-request.json'), '--full'],
        (value) => full.push(value),
        (value) => errors.push(value),
      ),
    ).toBe(0);
    expect(JSON.parse(full[0]!)).toEqual(
      (await context.read({ archive: true })).workflow.execution,
    );
    request.event = executionEvent(run, {
      type: 'RESULT',
      result: {
        scope: run.target.scope,
        target: run.target,
        evidence: [f.proof, proof.check.evidence],
        child_results: [],
        limitations: ['isolated host fixture'],
        summary: 'done',
      },
    });
    run = (await executeChatRequest('execution-chat', request)) as Execution;
    request.event = executionEvent(run, { type: 'DONE' });
    run = (await executeChatRequest('execution-chat', request)) as Execution;
    expect(await executeChatRequest('execution-chat', request)).toEqual(run);
    expect(run.status).toBe('done');
    const before = await executeChatRequest('status-chat', request);
    expect(before).toMatchObject({ execution: { status: 'done' } });
    request.operation = 'project';
    const originalSave = localStores.TaskLocalRuns.prototype.save;
    const failure = vi
      .spyOn(localStores.TaskLocalRuns.prototype, 'save')
      .mockImplementation(async function (this: localStores.TaskLocalRuns, expected, next) {
        if (next.projection?.result.status === 'confirmed')
          throw new Error('crash after card effect');
        return originalSave.call(this, expected, next);
      });
    await expect(executeChatRequest('project-chat', request)).rejects.toThrow(
      'crash after card effect',
    );
    failure.mockRestore();
    await expect(executeChatRequest('check-chat', request)).rejects.toThrow(
      'reconciliation-pending',
    );
    const firstProjection = await executeChatRequest('project-chat', request);
    expect(await executeChatRequest('project-chat', request)).toEqual(firstProjection);
    expect(firstProjection).toMatchObject({
      projection: { result: { status: 'confirmed' } },
    });
    const final = (await context.read({ archive: true })).workflow.execution!;
    expect(final.history.slice(0, history.length)).toEqual(retainedHistory);
    expect(final.history.map((entry) => entry.id)).toEqual([
      ...history.map((entry) => entry.id),
      'event-1',
      'event-2',
      'event-3',
      'event-4',
    ]);
  },
);
it('rejects wrong generations, actors, disconnected tasks, unknown state and an unready executor', async () => {
  await expect(executeChatRequest('bootstrap-chat', { ...request, generation: 0 })).rejects.toThrow(
    'invalid-generation',
  );
  vi.stubEnv('CODEX_THREAD_ID', 'other');
  await expect(executeChatRequest('bootstrap-chat', request)).rejects.toThrow(
    'chat-environment-identity-mismatch',
  );
  vi.stubEnv('CODEX_THREAD_ID', 'session');
  await expect(executeChatRequest('status-chat', request)).rejects.toThrow(
    'chat-store-unavailable',
  );
  const storage = request.storage as { root: string; grant: typeof grant };
  await expect(
    executeChatRequest('bootstrap-chat', { ...request, storage: { ...storage, grant } }),
  ).rejects.toThrow('chat-store-actor-mismatch');
  await executeChatRequest('bootstrap-chat', request);
  await expect(executeChatRequest('execution-chat', { ...request, generation: 2 })).rejects.toThrow(
    'chat-owner-unconfirmed',
  );
  await new FileTaskConnection(f.root).change(request.connection_journal as string, 'DISABLE');
  await expect(executeChatRequest('status-chat', request)).rejects.toThrow(
    'chat-connection-not-enabled',
  );
});
it('returns compact runtime receipts by default and leaves the complete result addressable', async () => {
  await f.file('runtime-request.json', JSON.stringify({ schema_version: 1, ...request }));
  const output: string[] = [],
    errors: string[] = [];
  expect(
    await runChatCommand(
      ['bootstrap-chat', resolve(f.root, 'runtime-request.json')],
      (s) => output.push(s),
      (s) => errors.push(s),
    ),
  ).toBe(0);
  expect(errors).toEqual([]);
  const result = JSON.parse(output[0]!) as {
    command: string;
    details: { locator: string; hash: string };
  };
  expect(result.command).toBe('bootstrap-chat');
  expect(readChatArtifact(result.details)).toMatchObject({
    purpose: 'operation-result',
    state: { context: { actor_id: 'session' } },
  });
});

it('rejects expired/frozen/readonly ownership and a changed native permission profile before command effects', async () => {
  await executeChatRequest('bootstrap-chat', request);
  request.check = {
    id: 'not-started',
    command: {
      file: process.execPath,
      args: ['-e', "require('fs').writeFileSync('unauthorized.txt','wrong')"],
    },
    discovery: { files: ['source.txt'], directories: [] },
    attested_by: 'owner',
  };
  const storage = request.storage as { root: string; grant: typeof grant };
  await expect(
    executeChatRequest('check-chat', {
      ...request,
      storage: { ...storage, grant: { ...storage.grant, permissions: ['read'] } },
    }),
  ).rejects.toThrow('chat-owner-unconfirmed');
  await expect(
    executeChatRequest('check-chat', {
      ...request,
      storage: {
        ...storage,
        grant: { ...storage.grant, context: { ...storage.grant.context, run_id: 'other' } },
      },
    }),
  ).rejects.toThrow('wrong-local-executor');
  const transcript = await readFile(request.transcript as string, 'utf8');
  await f.file('transcript.jsonl', transcript.replace('danger-full-access', 'read-only'));
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow(
    'chat-write-profile-unsupported',
  );
  await f.file('transcript.jsonl', transcript);
  vi.spyOn(Date, 'now').mockReturnValue((request.lease_until as number) + 1);
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow(
    'chat-expired-owner-boundary-required',
  );
  vi.restoreAllMocks();
  const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
  const snapshot = store.execute({ context: storage.grant.context, command: { type: 'state' } });
  if (!snapshot.ok) throw new Error('fixture state');
  const mutation = {
    context: storage.grant.context,
    command: {
      type: 'mutate' as const,
      mutation: {
        operation_id: 'freeze',
        expected_revision: (snapshot.value as { revision: number }).revision,
        owner_generation: 1,
        payload_hash: '',
      },
      change: { type: 'freeze' as const },
    },
  };
  mutation.command.mutation.payload_hash = requestHash(mutation);
  expect(store.execute(mutation).ok).toBe(true);
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow('chat-owner-unconfirmed');
  vi.spyOn(Date, 'now').mockReturnValue((request.lease_until as number) + 1);
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow('chat-owner-unconfirmed');
  vi.restoreAllMocks();
  await expect(readFile(resolve(f.root, 'unauthorized.txt'))).rejects.toThrow('ENOENT');
});

it('rejects changed stable assignment, future card notes and a changed connection descriptor before process effects', async () => {
  await executeChatRequest('bootstrap-chat', request);
  request.check = {
    id: 'no-effect',
    command: {
      file: process.execPath,
      args: ['-e', "require('fs').writeFileSync('unauthorized.txt','wrong')"],
    },
    discovery: { files: ['source.txt'], directories: [] },
    attested_by: 'owner',
  };
  const assignment = await readFile(resolve(f.root, 'assignment.txt'), 'utf8');
  await f.file('assignment.txt', 'new requirements');
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow(
    'source-revision-mismatch',
  );
  await f.file('assignment.txt', assignment);
  const card = await readFile(resolve(f.root, f.card.locator), 'utf8');
  await f.file(f.card.locator, card.replace('schema_version: 2', 'schema_version: 99'));
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow('card-identity-mismatch');
  await f.file(f.card.locator, card);
  await f.file(
    'connection.json',
    JSON.stringify({ ...f.connection, commands: ['validate', 'other'] }),
  );
  await f.file(
    'package.json',
    JSON.stringify({ scripts: { validate: 'echo test', other: 'echo other' } }),
  );
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow(
    'chat-connection-inputs-changed',
  );
  await expect(readFile(resolve(f.root, 'unauthorized.txt'))).rejects.toThrow('ENOENT');
});

it.each([false, true])(
  'binds decisions and reopens revised requirements with existing execution=%s',
  async (started) => {
    await executeChatRequest('bootstrap-chat', request);
    const source = request.human_source;
    const ask = {
      type: 'ASK',
      id: 'ask',
      expected_revision: 0,
      generation: 1,
      thread_id: 'session',
      source,
      question_id: 'question',
      action: 'human-gate',
    };
    request.message = ask;
    expect(await executeChatRequest('messages-chat', request)).toMatchObject({
      messages: { question: { id: 'question' } },
    });
    expect(await executeChatRequest('messages-chat', request)).toMatchObject({
      messages: { revision: 1 },
    });
    request.message = {
      ...ask,
      type: 'DECIDE',
      id: 'wrong',
      expected_revision: 1,
      question_id: 'other',
      requirements_revision: 0,
      accepted: true,
    };
    await expect(executeChatRequest('messages-chat', request)).rejects.toThrow(
      'chat-decision-unbound',
    );
    request.message = {
      ...ask,
      type: 'DECIDE',
      id: 'decision',
      expected_revision: 1,
      requirements_revision: 0,
      accepted: true,
    };
    expect(await executeChatRequest('messages-chat', request)).toMatchObject({
      messages: { decisions: [{ action: 'human-gate', accepted: true }] },
    });
    request.gates = [{ id: 'probe', kind: 'check', applicable: true, reason: 'process' }];
    request.code = false;
    if (started) await executeChatRequest('execution-chat', request);
    await f.file('assignment-v2.txt', 'Updated criteria, original source retained.');
    const spec = request.spec as LocalRun['spec'];
    request.message = {
      type: 'REQUIREMENTS',
      id: 'requirements',
      expected_revision: 2,
      generation: 1,
      thread_id: 'session',
      source,
      affected: ['probe'],
      revision: {
        assignment: await f.ref('assignment-v2.txt'),
        sources: spec.sources,
        scope: spec.scope,
        outcome: 'Revised task',
        criteria: ['updated check'],
        card: spec.identity as unknown,
      },
      target: f.target,
      gates: request.gates,
    };
    (request.message as { revision: { card: unknown } }).revision.card =
      'task_id' in spec.identity ? spec.identity.card : null;
    const revised = (await executeChatRequest('messages-chat', request)) as {
      run: LocalRun;
      messages: { requirements_revision: number };
      workflow: { execution: Execution };
    };
    expect(revised).toMatchObject({
      run: { status: 'waiting', loaded: null },
      messages: { requirements_revision: 1 },
      workflow: { execution: started ? { status: 'planning', result: null } : null },
    });
    request.check = {
      id: 'blocked',
      command: { file: process.execPath, args: ['-v'] },
      discovery: { files: ['source.txt'], directories: [] },
      attested_by: 'owner',
    };
    await expect(executeChatRequest('check-chat', request)).rejects.toThrow('action-forbidden');
    request.message = {
      ...ask,
      type: 'DECIDE',
      id: 'late',
      expected_revision: 3,
      requirements_revision: 0,
      accepted: true,
    };
    await expect(executeChatRequest('messages-chat', request)).rejects.toThrow(
      'chat-decision-unbound',
    );
    const assignment = await f.ref('assignment-v2.txt');
    const selection = {
      ...f.selection,
      architect: { ...f.selection.architect, requirements: [assignment, ...f.profiles.architect] },
    };
    const proposed = assignAdviser(
      createCouncil('planning', selection, f.target),
      'architect',
      f.adviser,
    );
    const council = answerCouncil(proposed, 'architect', f.adviser.spec.session_id, {
      ...f.answer(proposed),
      sources: [assignment, f.proof],
    });
    await f.file(
      'planning-v2.json',
      JSON.stringify({
        schema_version: 1,
        task_id: 'task',
        council,
        requirements_revision: 1,
        assignment,
      }),
    );
    request.planning_file = 'planning-v2.json';
    request.spec = {
      ...revised.run.spec,
      route: { kind: 'substantial', accepted_plan: await f.ref('planning-v2.json') },
    };
    request.marker = 'marker-v2';
    const oldLog = await readFile(request.transcript as string, 'utf8');
    const entries = oldLog
      .trimEnd()
      .split('\n')
      .map(
        (s) => JSON.parse(s) as { type: string; payload: { item?: { aggregated_output: string } } },
      );
    const read = structuredClone(entries.at(-1)!);
    read.payload.item!.aggregated_output = read.payload.item!.aggregated_output.replaceAll(
      'marker',
      'marker-v2',
    );
    await f.file('transcript.jsonl', oldLog + JSON.stringify(read) + '\n');
    expect(await executeChatRequest('bootstrap-chat', request)).toMatchObject({
      run: { status: 'ready' },
    });
    delete request.event;
    expect(await executeChatRequest('execution-chat', request)).toMatchObject({
      status: 'implementing',
      requirements_revision: 1,
    });
    request.message = {
      type: 'REQUIREMENTS',
      id: 'requirements-again',
      expected_revision: 3,
      generation: 1,
      thread_id: 'session',
      source,
      affected: ['probe'],
      revision: {
        assignment,
        sources: spec.sources,
        scope: spec.scope,
        outcome: 'Further refinement',
        criteria: ['updated check'],
        card: 'task_id' in spec.identity ? spec.identity.card : null,
      },
      target: f.target,
      gates: request.gates,
    };
    expect(await executeChatRequest('messages-chat', request)).toMatchObject({
      messages: { requirements_revision: 2 },
      workflow: { execution: { requirements_revision: 2, status: 'planning' } },
    });
  },
);

async function humanDecision(action: string, accepted = true) {
  const status = (await executeChatRequest('status-chat', request)) as {
    messages: { revision: number; requirements_revision: number };
  };
  const base = {
    generation: 1,
    thread_id: 'session',
    source: request.human_source,
    question_id: action,
    action,
  };
  request.message = {
    ...base,
    type: 'ASK',
    id: 'ask-' + action,
    expected_revision: status.messages.revision,
  };
  await executeChatRequest('messages-chat', request);
  request.message = {
    ...base,
    type: 'DECIDE',
    id: 'decide-' + action,
    expected_revision: status.messages.revision + 1,
    requirements_revision: status.messages.requirements_revision,
    accepted,
  };
  await executeChatRequest('messages-chat', request);
}
it('routes council observations and human gates, and delegates invalid supervision to its existing owner', async () => {
  await executeChatRequest('bootstrap-chat', request);
  const roleRun = structuredClone(f.adviser);
  roleRun.spec.session_id = 'helper';
  roleRun.spec.parent_run_id = f.executor.spec.run_id;
  roleRun.loaded!.session_id = 'helper';
  const native: AgentSession = {
    id: 'helper',
    parent_id: null,
    native_child: false,
    name: 'Советник: Архитектор',
    observed_turn: 'review-turn',
    model: roleRun.spec.requested.model,
    effort: roleRun.spec.requested.effort,
    workspace: f.root,
    project_id: 'project',
    read_only: true,
    network: false,
    forked_from: null,
    initial_turns: 0,
    receipt: f.proof,
  };
  const council = createCouncil('planning', f.selection, f.target),
    answer = f.answer(council);
  const data: DataAnswer = {
    outcome: 'PASS',
    scope: [f.target.scope],
    sources: answer.sources,
    coverage: 'complete',
    content: JSON.stringify(answer),
    continuation: null,
    limitations: ['mock native port'],
    evidence: f.proof,
  };
  roleBackend.verifyReview.mockImplementation(async (_session, request, turn, evidence) => ({
    schema_version: 1,
    request,
    load_turn: 'load',
    answer_turn: turn,
    answer_evidence: evidence,
    evidence: f.proof,
  }));
  roleBackend.inspect.mockResolvedValue(native);
  roleBackend.poll.mockResolvedValue({ status: 'completed', answer: data });
  Object.assign(request, {
    council,
    role: 'architect',
    role_run: roleRun,
    role_turn: 'review-turn',
  });
  request.council = {
    ...council,
    configuration: { catalog: 'other/catalog.md', profiles: { qa: 'other/qa.md' } },
  };
  await expect(executeChatRequest('council-chat', request)).rejects.toThrow(
    'wrong-council-configuration',
  );
  request.council = council;
  roleRun.spec.parent_run_id = 'wrong-parent';
  await expect(executeChatRequest('council-chat', request)).rejects.toThrow(
    'chat-council-parent-run-mismatch',
  );
  roleRun.spec.parent_run_id = f.executor.spec.run_id;
  expect(await executeChatRequest('council-chat', request)).toMatchObject({
    advisers: { architect: { status: 'answered' } },
  });
  request.gates = [
    { id: 'human-gate', kind: 'human', applicable: true, reason: 'bound human decision' },
  ];
  request.code = false;
  const run = (await executeChatRequest('execution-chat', request)) as Execution;
  request.event = executionEvent(run, {
    type: 'REPLAN',
    target: f.target,
    requirements: { revision: 1, source: f.proof },
  });
  await expect(executeChatRequest('execution-chat', request)).rejects.toThrow(
    'chat-requirements-message-required',
  );
  const review = {
    type: 'REVIEW' as const,
    target: f.target,
    selection: f.selection,
    baseline: {
      kind: 'real' as const,
      scenario: 'isolated binding contract',
      evidence: f.proof,
      inputs: f.target.inputs,
      elapsed_ms: 1,
      exit_code: 0,
    },
    checks: [
      {
        id: 'human-gate',
        verdict: 'PASS' as const,
        reason: 'human accepted',
        evidence: request.human_source as { locator: string; hash: string },
        inputs: f.target.inputs,
      },
    ],
  };
  request.event = executionEvent(run, {
    ...review,
    checks: [{ ...review.checks[0]!, verdict: 'NOT RUN' as const }],
  });
  const waiting = (await executeChatRequest('execution-chat', request)) as Execution;
  request.event = executionEvent(waiting, { type: 'CORRECT', findings: [] });
  const corrected = (await executeChatRequest('execution-chat', request)) as Execution;
  request.event = executionEvent(corrected, review);
  await expect(executeChatRequest('execution-chat', request)).rejects.toThrow(
    'chat-human-decision-unconfirmed',
  );
  await humanDecision('human-gate');
  const reviewed = (await executeChatRequest('execution-chat', request)) as Execution;
  request.event = {
    type: 'SUPERVISE',
    id: 'missing-arbiter',
    expected_revision: reviewed.revision,
    generation: 1,
    action: { kind: 'arbitrate', id: 'a', finding: 'missing' },
  };
  await expect(executeChatRequest('execution-chat', request)).rejects.toThrow(
    'arbitration-finding-missing',
  );
  request.event = {
    type: 'SUPERVISE',
    id: 'missing-audit',
    expected_revision: reviewed.revision,
    generation: 1,
    action: { kind: 'audit', id: 'audit', stage: 'missing' },
  };
  await expect(executeChatRequest('execution-chat', request)).rejects.toThrow('stage-not-found');
  request.event = executionEvent(reviewed, {
    type: 'SUPERVISE',
    action: {
      kind: 'human',
      id: 'missing',
      accepted: true,
      evidence: request.human_source as { locator: string; hash: string },
    },
  });
  await humanDecision('arbitration:missing');
  await expect(executeChatRequest('execution-chat', request)).rejects.toThrow(
    'arbitration-not-found',
  );
  request.event = executionEvent(reviewed, { type: 'REPLAN', target: f.target });
  expect(await executeChatRequest('execution-chat', request)).toHaveProperty('status', 'planning');
});
it('uses the authorized current orchestrator for coordination without creating another principal', async () => {
  const spec = request.spec as LocalRun['spec'];
  request.spec = {
    ...spec,
    coordinator: true,
    requested: { ...spec.requested, permissions: ['read', 'coordinate', 'produce-evidence'] },
  };
  const boot = (await executeChatRequest('bootstrap-chat', request)) as { run: LocalRun };
  request.coordination_roots = [f.root];
  request.seed = {
    schema_version: 1,
    run: boot.run,
    children: ['a', 'b'].map((id) => ({
      id,
      scope: { workspace: f.root, paths: [id + '.txt'] },
      writer: id,
      read_only: false,
      dependencies: [],
      criterion: id,
      authority: f.proof,
      native_project_id: 'native',
      profile: { model: 'fixture', effort: 'high' },
    })),
    integration: {
      executor: 'integrator',
      scope: { workspace: f.root, paths: ['common.txt'] },
      authority: f.proof,
    },
    poll_interval_ms: 210_000,
  };
  expect(await executeChatRequest('coordination-chat', request)).toMatchObject({
    status: 'active',
  });
  request.message = {
    type: 'REQUIREMENTS',
    id: 'unsafe-coordination-revision',
    expected_revision: 0,
    generation: 1,
    thread_id: 'session',
    source: request.human_source,
    affected: ['a'],
    revision: {
      assignment: spec.assignment,
      sources: spec.sources,
      scope: spec.scope,
      outcome: spec.outcome,
      criteria: spec.criteria,
      card: 'task_id' in spec.identity ? spec.identity.card : null,
    },
    target: f.target,
    gates: [],
  };
  await expect(executeChatRequest('messages-chat', request)).rejects.toThrow(
    'chat-requirements-coordination-bound',
  );
  expect(await executeChatRequest('status-chat', request)).toHaveProperty('local.status', 'ready');
  request.event = {
    type: 'RESERVE',
    id: 'reserve-a',
    revision: 0,
    generation: 1,
    child: 'a',
    operation: 'create-a',
  };
  expect(await executeChatRequest('coordination-chat', request)).toMatchObject({
    children: [expect.objectContaining({ status: 'reserved' }), expect.anything()],
  });
  request.event = {
    type: 'UNAVAILABLE',
    id: 'coordinator-paused',
    revision: 1,
    generation: 1,
    receipt: f.proof,
  };
  expect(await executeChatRequest('coordination-chat', request)).toHaveProperty('status', 'paused');
  const log = await readFile(request.transcript as string, 'utf8');
  const entries = log
    .trimEnd()
    .split('\n')
    .map((s) => JSON.parse(s) as { type: string; payload: Record<string, unknown> });
  const context = structuredClone(entries[3]!),
    read = structuredClone(entries[4]!);
  context.payload.turn_id = 'coord-next';
  read.payload.turn_id = 'coord-next';
  await f.file(
    'transcript.jsonl',
    log + JSON.stringify(context) + '\n' + JSON.stringify(read) + '\n',
  );
  request.anchor = { ...(request.anchor as Record<string, unknown>), turn_id: 'coord-next' };
  request.event = {
    type: 'RESUME',
    id: 'coordinator-resumed',
    revision: 2,
    generation: 1,
    owner: boot.run.spec.run_id,
    receipt: f.proof,
  };
  expect(await executeChatRequest('coordination-chat', request)).toHaveProperty('status', 'active');
  request.event = {
    type: 'CANCEL',
    id: 'cancel-coordination',
    revision: 3,
    generation: 1,
    reason: 'Changed requirements rejected safely',
  };
  expect(await executeChatRequest('coordination-chat', request)).toHaveProperty(
    'status',
    'cancelling',
  );
});
it('preserves adjacent checkpoint fields and refuses unknown message schemas and context conflicts', async () => {
  await executeChatRequest('bootstrap-chat', request);
  const storage = request.storage as { root: string; grant: typeof grant };
  const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
  const journal = new TaskChatContext(
    { execute: async (r) => store.execute(r) },
    storage.grant.context,
    1,
  );
  const context = await journal.read();
  await journal.save(context, context, 'same');
  request.message = {
    type: 'ASK',
    id: 'question',
    expected_revision: 0,
    generation: 1,
    thread_id: 'session',
    source: request.human_source,
    question_id: 'q',
    action: 'a',
  };
  await executeChatRequest('messages-chat', request);
  await expect(journal.save(context, context, 'stale')).rejects.toThrow('chat-context-conflict');
  const raw = store.execute({ context: storage.grant.context, command: { type: 'state' } });
  if (!raw.ok) throw new Error('fixture');
  const state = raw.value as { revision: number; checkpoint: Record<string, unknown> };
  const mutate = {
    context: storage.grant.context,
    command: {
      type: 'mutate' as const,
      mutation: {
        operation_id: 'future-messages',
        expected_revision: state.revision,
        owner_generation: 1,
        payload_hash: '',
      },
      change: {
        type: 'checkpoint' as const,
        state: {
          ...state.checkpoint,
          adjacent: 'keep',
          chat_messages: { schema_version: 99 },
        } as unknown as Json,
        effects: [],
      },
    },
  };
  mutate.command.mutation.payload_hash = requestHash(mutate);
  expect(store.execute(mutate).ok).toBe(true);
  await expect(executeChatRequest('bootstrap-chat', request)).rejects.toThrow(
    'unsupported-chat-messages',
  );
});
it('persists pause and native-bound resume, confirms cancellation separately and projects only cancelled', async () => {
  await executeChatRequest('bootstrap-chat', request);
  request.control = {
    type: 'PAUSE',
    id: 'pause',
    expected_revision: 0,
    generation: 1,
    thread_id: 'session',
    source: request.human_source,
    reason: 'User pause',
  };
  await executeChatRequest('control-chat', request);
  await expect(executeChatRequest('bootstrap-chat', request)).rejects.toThrow(
    'chat-control-not-active',
  );
  await expect(
    executeChatRequest('cancel-project-chat', { ...request, operation: 'cancel' }),
  ).rejects.toThrow('chat-cancellation-unconfirmed');
  const original = await readFile(request.transcript as string, 'utf8');
  const rows = original
    .trimEnd()
    .split('\n')
    .map((s) => JSON.parse(s) as Record<string, unknown>);
  const human = structuredClone(rows[2]!),
    context = structuredClone(rows[3]!),
    read = structuredClone(rows[4]!);
  (context.payload as Record<string, unknown>).turn_id = 'next';
  const payload = read.payload as Record<string, unknown>;
  payload.turn_id = 'next';
  (payload.item as { aggregated_output: string }).aggregated_output = (
    payload.item as { aggregated_output: string }
  ).aggregated_output.replaceAll('marker', 'next-marker');
  rows.push(
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } },
    human,
    context,
    read,
  );
  await f.file('transcript.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  request.anchor = { ...(request.anchor as Record<string, unknown>), turn_id: 'next' };
  request.marker = 'next-marker';
  const source = {
    locator: (request.transcript as string) + '#L8',
    hash: contentHash(JSON.stringify(human) + '\n'),
  };
  request.message = {
    type: 'ASK',
    id: 'question-while-paused',
    expected_revision: 0,
    generation: 1,
    thread_id: 'session',
    source,
    question_id: 'future-question',
    action: 'future-action',
  };
  expect(await executeChatRequest('messages-chat', request)).toHaveProperty(
    'messages.question.id',
    'future-question',
  );
  const stopped = async (turn: string) => {
    const marker = resolve(f.root, 'source.txt'),
      hash = createHash('sha256')
        .update(marker)
        .update(await readFile(marker))
        .digest('hex');
    const text = JSON.stringify({
      kind: 'writers-stopped',
      thread: 'session',
      active_turn: false,
      remaining_terminals: 0,
      remaining_processes: 0,
      before_hash: hash,
      after_hash: hash,
      observation_ms: 250,
      owned: { thread: 'session', turn, complete: true, markers: [marker] },
      processes: [],
    });
    const locator = resolve(external, 'stop-' + turn + '.json');
    await writeFile(locator, text, { mode: 0o600 });
    return { locator, hash: contentHash(text) };
  };
  request.control = {
    type: 'RESUME',
    id: 'resume',
    expected_revision: 1,
    generation: 1,
    thread_id: 'session',
    source,
    marker: 'next-marker',
  };
  expect(await executeChatRequest('control-chat', request)).toHaveProperty('run.status', 'ready');
  request.control = {
    type: 'CANCEL',
    id: 'cancel',
    expected_revision: 2,
    generation: 1,
    thread_id: 'session',
    source,
    reason: 'User cancellation',
    unfinished: ['remaining scope'],
  };
  expect(await executeChatRequest('control-chat', request)).toHaveProperty(
    'control.status',
    'cancelling',
  );
  await expect(executeChatRequest('messages-chat', request)).rejects.toThrow(
    'chat-control-not-active',
  );
  const ended = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'next' } };
  rows.push(ended);
  await f.file('transcript.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  request.control = {
    type: 'STOP',
    id: 'stop',
    expected_revision: 3,
    generation: 1,
    thread_id: 'session',
    source: {
      locator: (request.transcript as string) + '#L11',
      hash: contentHash(JSON.stringify(ended) + '\n'),
    },
    stopped: await stopped('next'),
  };
  expect(await executeChatRequest('control-chat', request)).toHaveProperty(
    'run.status',
    'cancelled',
  );
  await executeChatRequest('control-chat', request);
  request.operation = 'cancelled-projection';
  const cancelled = await executeChatRequest('cancel-project-chat', request);
  expect(cancelled).toHaveProperty('projection.result.status', 'confirmed');
  expect(await executeChatRequest('cancel-project-chat', request)).toEqual(cancelled);
  await expect(
    executeChatRequest('cancel-project-chat', { ...request, operation: 'different' }),
  ).rejects.toThrow('chat-projection-operation-conflict');
});
it('serializes a preparing check against pause and rejects a replacement evidence directory', async () => {
  await executeChatRequest('bootstrap-chat', request);
  request.gates = [{ id: 'probe', kind: 'check', applicable: true, reason: 'bounded check' }];
  request.code = false;
  await executeChatRequest('execution-chat', request);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  const capture = FileWorkflowInputs.prototype.capture;
  vi.spyOn(FileWorkflowInputs.prototype, 'capture').mockImplementationOnce(async function (
    this: FileWorkflowInputs,
    ...args: Parameters<FileWorkflowInputs['capture']>
  ) {
    const result = await capture.apply(this, args);
    entered();
    await held;
    return result;
  });
  request.check = {
    id: 'serialized',
    criterion: 'probe',
    command: { file: process.execPath, args: ['-v'] },
    discovery: { files: ['source.txt'], directories: [] },
    attested_by: 'owner',
  };
  const running = executeChatRequest('check-chat', request);
  await Promise.race([ready, running]);
  const pause = {
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
  };
  try {
    await expect(executeChatRequest('control-chat', pause)).rejects.toThrow(
      'chat-writer-busy-or-unknown',
    );
    expect(await executeChatRequest('status-chat', request)).toHaveProperty(
      'control.status',
      'active',
    );
  } finally {
    release();
  }
  await running;
  await expect(
    executeChatRequest('control-chat', { ...pause, evidence_root: f.root }),
  ).rejects.toThrow('chat-evidence-root-mismatch');
  expect(await executeChatRequest('control-chat', pause)).toHaveProperty(
    'control.status',
    'paused',
  );
});
it('rejects evidence replacement during preparation before starting a process and retains exclusion', async () => {
  const evidence = resolve(external, 'runtime');
  await mkdir(evidence);
  request.evidence_root = evidence;
  await executeChatRequest('bootstrap-chat', request);
  request.gates = [{ id: 'probe', kind: 'check', applicable: true, reason: 'bounded check' }];
  request.code = false;
  await executeChatRequest('execution-chat', request);
  await writeFile(resolve(evidence, 'old.intent.json'), '{}');
  const capture = FileWorkflowInputs.prototype.capture;
  vi.spyOn(FileWorkflowInputs.prototype, 'capture').mockImplementationOnce(async function (
    this: FileWorkflowInputs,
    ...args: Parameters<FileWorkflowInputs['capture']>
  ) {
    const result = await capture.apply(this, args);
    await rename(evidence, evidence + '-original');
    await mkdir(evidence);
    return result;
  });
  const marker = resolve(f.root, 'process-started.txt');
  request.check = {
    id: 'new',
    criterion: 'probe',
    command: {
      file: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker],
    },
    discovery: { files: ['source.txt'], directories: [] },
    attested_by: 'owner',
  };
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow(
    'chat-runtime-directory-changed',
  );
  await expect(readFile(marker)).rejects.toHaveProperty('code', 'ENOENT');
  expect(await readFile(chatWriterLock(resolve(external, 'store')), 'utf8')).toContain('token');
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow(
    'chat-writer-busy-or-unknown',
  );
  expect(await readFile(resolve(evidence + '-original', 'old.intent.json'), 'utf8')).toBe('{}');
});

it('never exposes READY without control after a crash, and refuses legacy READY without a binding', async () => {
  const save = TaskChatContext.prototype.save;
  const fault = vi.spyOn(TaskChatContext.prototype, 'save').mockImplementation(async function (
    this: TaskChatContext,
    expected,
    next,
    operation,
  ) {
    if (operation === 'chat:control:begin') throw new Error('control checkpoint interrupted');
    return save.call(this, expected, next, operation);
  });
  await expect(executeChatRequest('bootstrap-chat', request)).rejects.toThrow(
    'control checkpoint interrupted',
  );
  expect(await executeChatRequest('status-chat', request)).toMatchObject({
    local: { status: 'inbox' },
    control: null,
  });
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow('chat-control-missing');
  fault.mockRestore();
  const log = await readFile(request.transcript as string, 'utf8');
  const entries = log
    .trimEnd()
    .split('\n')
    .map((s) => JSON.parse(s) as { type: string; payload: Record<string, unknown> });
  const context = structuredClone(entries[3]!),
    read = structuredClone(entries[4]!);
  context.payload.turn_id = 'recovery';
  read.payload.turn_id = 'recovery';
  await f.file(
    'transcript.jsonl',
    log + JSON.stringify(context) + '\n' + JSON.stringify(read) + '\n',
  );
  request.anchor = { ...(request.anchor as Record<string, unknown>), turn_id: 'recovery' };
  expect(await executeChatRequest('bootstrap-chat', request)).toHaveProperty('run.status', 'ready');
  const storage = request.storage as { root: string; grant: typeof grant };
  const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
  const response = store.execute({ context: storage.grant.context, command: { type: 'state' } });
  if (!response.ok) throw new Error('fixture state unavailable');
  const state = response.value as TechnicalState;
  const checkpoint = { ...(state.checkpoint as Record<string, Json>) };
  delete checkpoint.chat_control;
  const mutation = {
    context: storage.grant.context,
    command: {
      type: 'mutate' as const,
      mutation: {
        operation_id: 'legacy-checkpoint',
        expected_revision: state.revision,
        owner_generation: 1,
        payload_hash: '',
      },
      change: { type: 'checkpoint' as const, state: checkpoint, effects: [] },
    },
  };
  mutation.command.mutation.payload_hash = requestHash(mutation);
  expect(store.execute(mutation).ok).toBe(true);
  await expect(executeChatRequest('bootstrap-chat', request)).rejects.toThrow(
    'chat-control-missing',
  );
});
it('records a new human refinement and pause while writer recovery stays blocked', async () => {
  await executeChatRequest('bootstrap-chat', request);
  const log = await readFile(request.transcript as string, 'utf8');
  const rows = log
    .trimEnd()
    .split('\n')
    .map((s) => JSON.parse(s) as { type: string; payload: Record<string, unknown> });
  const human = structuredClone(rows[2]!),
    context = structuredClone(rows[3]!);
  context.payload.turn_id = 'human-refinement';
  rows.push(
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'human-refinement' } },
    human,
    context,
  );
  await f.file('transcript.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  request.anchor = { ...(request.anchor as Record<string, unknown>), turn_id: 'human-refinement' };
  const source = {
    locator: (request.transcript as string) + '#L8',
    hash: contentHash(JSON.stringify(human) + '\n'),
  };
  const spec = request.spec as LocalRun['spec'];
  request.message = {
    type: 'REQUIREMENTS',
    id: 'new-human-requirements',
    expected_revision: 0,
    generation: 1,
    thread_id: 'session',
    source,
    affected: ['artifact'],
    revision: {
      assignment: spec.assignment,
      sources: spec.sources,
      scope: spec.scope,
      outcome: spec.outcome,
      criteria: ['refined requirement'],
      card: 'task_id' in spec.identity ? spec.identity.card : null,
    },
    target: f.target,
    gates: [],
  };
  expect(await executeChatRequest('messages-chat', request)).toMatchObject({
    run: { status: 'waiting', loaded: null },
    messages: { requirements_revision: 1 },
  });
  await expect(executeChatRequest('check-chat', request)).rejects.toThrow('chat-resume-required');
  request.control = {
    type: 'PAUSE',
    id: 'pause-after-refinement',
    expected_revision: 0,
    generation: 1,
    thread_id: 'session',
    source,
    reason: 'human requested pause',
  };
  expect(await executeChatRequest('control-chat', request)).toHaveProperty(
    'control.status',
    'paused',
  );
});

it('persists scoped native LOAD expansion before execution while preserving the same SQLite owner', async () => {
  request.code = false;
  request.gates = [{ id: 'proof', kind: 'check', applicable: true, reason: 'proof' }];
  const spec = request.spec as RunSpec;
  spec.procedure_loading = 'by-action';
  const records = (await readFile(String(request.transcript), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const item = (records[4]!.payload as { item: { aggregated_output: string } }).item;
  const all = item.aggregated_output
    .split('\n')
    .map((line) => JSON.parse(line) as { locator: string });
  const base = new Set([
    ...spec.procedures
      .filter((p) => ['bootstrap', 'task', 'evidence'].includes(p.id))
      .map((p) => p.locator),
    ...spec.rules.map((r) => r.locator),
  ]);
  item.aggregated_output = all
    .filter((r) => base.has(r.locator))
    .map((r) => JSON.stringify(r))
    .join('\n');
  const save = () =>
    writeFile(String(request.transcript), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await save();
  await executeChatRequest('bootstrap-chat', request);
  await expect(executeChatRequest('execution-chat', request)).rejects.toThrow(
    'procedure-not-loaded:implementation',
  );
  const before = (await executeChatRequest('status-chat', request)) as {
    local: LocalRun;
    ownership: unknown;
    execution: unknown;
  };
  expect(before.execution).toMatchObject({ status: 'not-started' });
  expect(before.local.loaded!.procedures).toHaveLength(3);
  const implementation = new Set(
    spec.procedures
      .filter((p) => ['implementation', 'boundary-review'].includes(p.id))
      .map((p) => p.locator),
  );
  records.push({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'session',
      turn_id: 'turn',
      item: {
        type: 'CommandExecution',
        cwd: f.root,
        exit_code: 0,
        status: 'completed',
        aggregated_output: all
          .filter((r) => implementation.has(r.locator))
          .map((r) => JSON.stringify(r))
          .join('\n'),
      },
    },
  });
  await save();
  await executeChatRequest('execution-chat', request);
  const after = (await executeChatRequest('status-chat', request)) as {
    local: LocalRun;
    ownership: { owner: string; generation: number };
  };
  expect(after.local.loaded!.procedures).toHaveLength(5);
  expect(after.local.generation).toBe(before.local.generation);
  expect(after.local.spec.session_id).toBe(before.local.spec.session_id);
  expect(after.ownership).toMatchObject({ owner: 'session', generation: 1 });
  const count = after.local.history.length;
  await executeChatRequest('execution-chat', request);
  expect(
    ((await executeChatRequest('status-chat', request)) as { local: LocalRun }).local.history,
  ).toHaveLength(count);
});

it.each([
  { command: 'council-chat', error: 'procedure-not-loaded:data-roles' },
  { command: 'council-run-chat', error: 'procedure-not-loaded:data-roles' },
  { command: 'coordination-chat', error: 'procedure-not-loaded:coordination' },
  {
    command: 'execution-chat',
    event: { type: 'REVIEW' },
    error: 'procedure-not-loaded:data-roles',
  },
  {
    command: 'execution-chat',
    event: { type: 'ACCEPT' },
    error: 'procedure-not-loaded:data-roles',
  },
  {
    command: 'execution-chat',
    event: { type: 'SUPERVISE', action: { kind: 'audit' } },
    error: 'procedure-not-loaded:audit',
  },
  {
    command: 'execution-chat',
    event: { type: 'SUPERVISE', action: { kind: 'arbitrate' } },
    error: 'procedure-not-loaded:arbitration',
  },
  {
    command: 'execution-chat',
    event: {
      type: 'SUPERVISE',
      action: { kind: 'stage', id: 'stage', estimate_ms: 1000, checkpoint: 'next' },
    },
    error: 'execution-not-found',
  },
  { command: 'execution-chat', event: { type: 'CORRECT' }, error: 'execution-not-found' },
] as const)(
  'blocks $command before its dependent effect when scoped procedures are missing ($error)',
  async (test) => {
    const spec = request.spec as RunSpec;
    spec.procedure_loading = 'by-action';
    if (test.command === 'coordination-chat') {
      spec.coordinator = true;
      spec.requested.permissions = ['read', 'coordinate'];
    }
    const records = (await readFile(String(request.transcript), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const item = (records[4]!.payload as { item: { aggregated_output: string } }).item;
    const allowed = new Set([
      ...spec.procedures
        .filter((p) =>
          ['bootstrap', 'task', 'evidence', 'implementation', 'boundary-review'].includes(p.id),
        )
        .map((p) => p.locator),
      ...spec.rules.map((r) => r.locator),
    ]);
    item.aggregated_output = item.aggregated_output
      .split('\n')
      .filter((line) => allowed.has((JSON.parse(line) as { locator: string }).locator))
      .join('\n');
    await writeFile(
      String(request.transcript),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    await executeChatRequest('bootstrap-chat', request);
    const before = (await executeChatRequest('status-chat', request)) as { local: LocalRun };
    await expect(
      executeChatRequest(test.command, {
        ...request,
        ...('event' in test ? { event: test.event } : {}),
      }),
    ).rejects.toThrow(test.error);
    expect(
      ((await executeChatRequest('status-chat', request)) as { local: LocalRun }).local,
    ).toEqual(before.local);
  },
);

it('routes progress reservation, backup, primary observation and settlement through the live CLI adapters', async () => {
  const { FileAuditCards } = await import('../adapters/project/fileAuditCards.js');
  request.spec = { ...(request.spec as RunSpec), procedure_loading: 'by-action' };
  request.load_procedures = ['audit', 'implementation', 'council'];
  request.gates = [{ id: 'proof', kind: 'check', applicable: true, reason: 'required' }];
  request.code = false;
  await executeChatRequest('bootstrap-chat', request);
  let run = (await executeChatRequest('execution-chat', request)) as Execution;
  const cards = new FileAuditCards(f.root, f.connection, resolve(f.root, 'audit-journal'));
  const card = await cards.prepare(
    `${f.connection.plans.active}/progress.md`,
    'task',
    'prepare-progress',
    {
      goal: 'Original goal',
      criteria: ['Observable result'],
      completed: [f.proof],
      open_findings: [],
      timing: null,
      progress: {
        schema_version: 1,
        task_id: 'task',
        scope: f.target.scope,
        goal_source: f.target.inputs.inputs[0]!,
        checkpoint: 'cp',
        evidence: f.proof,
        inputs: f.target.inputs,
        estimate_ms: null,
        elapsed_ms: null,
        external_wait_ms: null,
      },
      next_action: 'Produce the original result',
    },
    null,
  );
  const advance = async (action: SupervisionAction) => {
    request.event = executionEvent(run, { type: 'SUPERVISE', action });
    run = (await executeChatRequest('execution-chat', request)) as Execution;
  };
  await advance({ kind: 'reserve-audit', id: 'progress', card });
  request.audit_id = 'progress';
  expect(await executeChatRequest('observe-audit-chat', request)).toMatchObject({
    outcome: 'not-started',
    session: null,
  });
  await advance({
    kind: 'launch-audit',
    id: 'progress',
    operation: 'attempt',
    parent: 'audit-parent',
  });
  await continuationTurn();
  await executeChatRequest('continue-chat', request);
  await expect(
    advance({
      kind: 'launch-audit',
      id: 'progress',
      operation: 'duplicate',
      parent: 'audit-parent',
    }),
  ).rejects.toThrow('audit-launch-already-claimed');
  roleBackend.observeAuditAttempt.mockResolvedValue({ outcome: 'unknown' });
  expect(await executeChatRequest('observe-audit-chat', request)).toEqual({ outcome: 'unknown' });
  const observation = {
    outcome: 'not-started' as const,
    operation: 'attempt',
    session: null,
    receipt: f.proof,
  };
  roleBackend.observeAuditAttempt.mockResolvedValue(observation);
  expect(await executeChatRequest('observe-audit-chat', request)).toEqual(observation);
  await advance({ kind: 'settle-audit', id: 'progress', observation });
  expect(run.supervision!.reservations![0]!.settled).toEqual(observation);
  request.audit_id = 'absent';
  await expect(executeChatRequest('observe-audit-chat', request)).rejects.toThrow(
    'audit-reservation-not-open',
  );
});

it.each([null, 1, [], { kind: 'progress-audit' }])(
  'never authorizes continuation from an unrelated or malformed audit intent: %j',
  async (intent) => {
    await executeChatRequest('bootstrap-chat', request);
    const storage = request.storage as { root: string; grant: typeof grant };
    const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
    const reply = store.execute({
      context: storage.grant.context,
      command: { type: 'state', archive: 'current' },
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw new Error('state unavailable');
    const state = reply.value as TechnicalState;
    const change = signed(
      {
        type: 'checkpoint',
        state: state.checkpoint,
        effects: [{ id: 'progress-audit:forged', intent }],
      },
      state.revision,
      state.generation,
      'forged-audit',
      storage.grant,
    );
    expect(store.execute(change).ok).toBe(true);
    await continuationTurn();
    await expect(executeChatRequest('continue-chat', request)).rejects.toThrow(
      'chat-effect-outcome-unknown',
    );
  },
);

it.each(['pending', 'unknown'] as const)(
  'exposes the current checkpoint and %s operations without permitting blind continuation',
  async (outcome) => {
    await executeChatRequest('bootstrap-chat', request);
    await executeChatRequest('continue-chat', request);
    request.gates = [{ id: 'probe', kind: 'check', applicable: true, reason: 'bounded check' }];
    request.code = false;
    await executeChatRequest('execution-chat', request);
    const storage = request.storage as { root: string; grant: typeof grant };
    const store = new SqliteEvidenceStore(storage.root, storage.grant, Date.now);
    const read = () => {
      const reply = store.execute({
        context: storage.grant.context,
        command: { type: 'state', archive: 'current' },
      });
      if (!reply.ok) throw new Error('fixture state');
      return reply.value as TechnicalState;
    };
    const before = read();
    expect(
      store.execute(
        signed(
          {
            type: 'checkpoint',
            state: before.checkpoint,
            effects: [{ id: 'uncertain-operation', intent: { kind: 'probe' } }],
          },
          before.revision,
          1,
          'fixture:uncertain',
          storage.grant,
        ),
      ).ok,
    ).toBe(true);
    if (outcome === 'unknown')
      expect(
        store.execute(
          signed(
            { type: 'effect', id: 'uncertain-operation', outcome, receipt: null },
            read().revision,
            1,
            'fixture:lost',
            storage.grant,
          ),
        ).ok,
      ).toBe(true);
    const current = read();
    const path = resolve(external, 'status.json');
    await writeFile(path, JSON.stringify({ schema_version: 1, ...request }));
    const output: string[] = [];
    expect(
      await runChatCommand(
        ['status-chat', path, '--brief'],
        (s) => output.push(s),
        () => {},
      ),
    ).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      checkpoint: {
        locator: storage.root + '#state',
        revision: current.revision,
        generation: current.generation,
      },
      requirements_revision: 0,
      execution_status: 'implementing',
      pending_operations: [{ id: 'uncertain-operation', outcome }],
      next_action: 'Проверить исходную операцию и её квитанцию; не запускать повтор с новым ID.',
    });
    expect(read()).toEqual(current);
  },
);

it('refuses a mixed status when another writer commits between checkpoint and effects', async () => {
  await executeChatRequest('bootstrap-chat', request);
  const original = SqliteEvidenceStore.prototype.execute;
  let effectsRead = false;
  vi.spyOn(SqliteEvidenceStore.prototype, 'execute').mockImplementation(function (
    this: SqliteEvidenceStore,
    command,
  ) {
    const reply = original.call(this, command);
    if (command.command.type === 'effects') effectsRead = true;
    if (effectsRead && command.command.type === 'state' && reply.ok)
      return {
        ...reply,
        value: {
          ...(reply.value as TechnicalState),
          revision: (reply.value as TechnicalState).revision + 1,
        },
      };
    return reply;
  });
  await expect(executeChatRequest('status-chat', request)).rejects.toThrow(
    'chat-status-checkpoint-changed',
  );
});

it('keeps status reads byte-for-byte unchanged and refuses unsupported WAL sources without creating sidecars', async () => {
  await executeChatRequest('bootstrap-chat', request);
  const storage = object(request.storage),
    path = resolve(String(storage.root), 'store.sqlite');
  const before = await readFile(path),
    files = await readdir(String(storage.root));
  await executeChatRequest('status-chat', request);
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(String(storage.root))).toEqual(files);
  const writer = new DatabaseSync(path);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.close();
  const wal = await readFile(path),
    walFiles = await readdir(String(storage.root));
  for (const command of ['status-chat', 'compact-context-chat'] as const)
    await expect(
      executeChatRequest(command, { ...request, compact_action: 'execution-chat' }),
    ).rejects.toThrow('chat-store-recovery-required');
  expect(await readFile(path)).toEqual(wal);
  expect(await readdir(String(storage.root))).toEqual(walFiles);
});
