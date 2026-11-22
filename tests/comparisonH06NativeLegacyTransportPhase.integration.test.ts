import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { restoreStore } from '../adapters/storage/storeBackup.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { startCoder } from '../application/coderWorkflow.js';
import { executeChatRequest } from '../cli/chatRuntime.js';
import { taskChatGates } from '../cli/taskChatInputs.js';
import type { CoderBrief } from '../core/coder.js';
import type { TechnicalState } from '../core/evidence.js';
import { requiredProcedures, type RunSpec } from '../core/localRun.js';
import { requireContract } from '../src/contracts/project.js';
import { readH04Pin } from './comparisonH04Contract.js';
import { openH06NativeLegacyBudget } from './comparisonH06NativeLegacyBudget.js';
import { withH06LegacyCoderRuntime } from './comparisonH06NativeLegacyTransportPhase.js';
import { grant, signed } from './storageFixtures.js';
import { workflowFixture } from './workflowFixtures.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dispose of cleanups.splice(0)) await dispose();
});

async function fixture() {
  const f = await workflowFixture(),
    root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-real-bootstrap-reserve-'));
  cleanups.push(f.dispose, () => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  const evidenceRoot = join(root, 'evidence'),
    sessionsRoot = join(root, 'sessions');
  mkdirSync(evidenceRoot);
  mkdirSync(sessionsRoot);
  await f.file(
    'tools/agent-workflow/roles/coder.md',
    await readFile(new URL('../roles/coder.md', import.meta.url), 'utf8'),
  );
  const descriptor = 'connection.json',
    planningFile = 'planning.json',
    marker = 'real-bootstrap-load';
  const connection = await new FileTaskConnection(f.root).preview(
    descriptor,
    f.card.locator,
    'task',
  );
  await f.file(f.card.locator, connection.after);
  const connectionJournal = join(evidenceRoot, 'connection');
  await new FileTaskConnection(f.root).apply(connection, connectionJournal);
  await f.file(
    planningFile,
    JSON.stringify({ schema_version: 1, task_id: 'task', council: f.council('planning') }),
  );
  const spec: RunSpec = {
    ...f.spec,
    identity: { task_id: 'task', card: await f.ref(f.card.locator) },
    host_id: 'local',
    session_id: grant.context.actor_id,
    requested: { ...f.spec.requested, permissions: [...f.spec.requested.permissions, 'implement'] },
    route: { kind: 'substantial', accepted_plan: await f.ref(planningFile) },
  };
  const transcript = join(sessionsRoot, 'actor.jsonl'),
    anchor = {
      thread_id: grant.context.actor_id,
      turn_id: 'turn',
      host_id: 'local' as const,
      workspace: f.root,
    };
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
      {
        type: 'session_meta',
        payload: {
          id: anchor.thread_id,
          session_id: anchor.thread_id,
          cwd: f.root,
          cli_version: '0.166.0-alpha.6',
          source: 'vscode',
          originator: 'codex_work_desktop',
          thread_source: 'user',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      {
        type: 'turn_context',
        payload: {
          turn_id: 'turn',
          cwd: f.root,
          model: spec.requested.model,
          effort: spec.requested.effort,
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: anchor.thread_id,
          turn_id: 'turn',
          item: {
            type: 'CommandExecution',
            cwd: f.root,
            status: 'completed',
            exit_code: 0,
            aggregated_output: reads.join('\n'),
          },
        },
      },
    ]
      .map(canonical)
      .join('\n') + '\n',
  );
  vi.stubEnv('CODEX_THREAD_ID', grant.context.actor_id);
  const storeRoot = join(evidenceRoot, 'legacy-store');
  initializeStore(storeRoot, grant.context);
  const store = new SqliteEvidenceStore(storeRoot, grant, Date.now);
  unwrap(
    store.execute(
      signed({ type: 'claim', lease_until: Date.now() + 30 * 60000 }, 0, 0, 'initial-owner'),
    ),
  );
  const request = {
    root: f.root,
    evidence_root: evidenceRoot,
    storage: { root: storeRoot, grant },
    generation: 1,
    descriptor,
    connection_journal: connectionJournal,
    planning_file: planningFile,
    marker,
    spec,
    transcript,
    anchor,
  };
  await executeChatRequest('prepare-chat', request);
  await executeChatRequest('bootstrap-chat', request);
  await executeChatRequest('execution-chat', {
    ...request,
    code: true,
    gates: taskChatGates(spec.criteria, [spec.criteria[0]!]),
  });
  const persistence = {
    execute: async (value: Parameters<typeof store.execute>[0]) => store.execute(value),
  };
  const journal = new TaskWorkflowJournal(persistence, grant.context, 1);
  expect(await journal.read()).toMatchObject({
    schema_version: 1,
    execution: { status: 'implementing' },
  });
  const parent = (await new TaskChatContext(persistence, grant.context, 1).read()).run;
  const rules = [await f.ref('AGENTS.md'), await f.ref('tools/agent-workflow/roles/coder.md')];
  const procedures = parent.spec.procedures.filter((p) =>
    requiredProcedures('role', 'coder').includes(p.id),
  );
  const files = await Promise.all(
    [
      ...new Set([
        'source.txt',
        ...rules.map((r) => r.locator),
        ...procedures.map((p) => p.locator),
      ]),
    ].map((p) => f.ref(p)),
  );
  const brief: CoderBrief = {
    id: 'first',
    project_id: 'project',
    task_id: 'task',
    parent_run_id: 'run',
    parent_session_id: grant.context.actor_id,
    generation: 1,
    card: await f.ref(f.card.locator),
    authority: spec.route.kind === 'substantial' ? spec.route.accepted_plan! : f.proof,
    source_root: f.root,
    copy_root: join(evidenceRoot, 'coder-workspaces', 'first'),
    paths: ['source.txt'],
    files,
    rules,
    procedures,
    goal: 'Reserve one isolated fixture Writer without starting it',
    criterion: 'No native session is created',
    checks: [],
    profile: { model: spec.requested.model, effort: spec.requested.effort },
  };
  const pin = (name: string, value: unknown) => {
    const path = join(evidenceRoot, name),
      bytes = canonical(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const startedAt = Date.now(),
    budget = {
      maxElapsedMs: 60000,
      reserveMs: 10000,
      maxManagedStarts: 9,
      maxInputUncached: 10000,
      maxOutput: 1000,
    };
  const nativeRequest = {
    kind: 'comparison-h06-native/2' as const,
    binding: {
      variant: 'legacy' as const,
      operationId: 'task',
      workspaceRoot: f.root,
      node: pin('node.json', {}),
      timeoutMs: 2000,
    },
    evidenceRoot,
    chat: { threadId: 'controller', workspace: root },
    budget,
    stimulus: { initialLeaseMs: 20000, longStageMs: 35000 },
    appServer: pin('app-server.json', {}),
    server: null,
    bootstrap: pin('bootstrap.json', {}),
    runtime: [pin('brief.json', brief)],
  };
  const workDeadlineMs = startedAt + budget.maxElapsedMs - budget.reserveMs,
    stopDeadlineMs = startedAt + budget.maxElapsedMs;
  const claim = {
    request: nativeRequest,
    receipt: pin('attempt-claim.json', {
      kind: 'h06-native-attempt-claim',
      request: nativeRequest,
      assets: {},
      requestHash: digest(canonical({ request: nativeRequest, assets: {} })),
      grant: { sessionsRoot },
      startedAt,
      workDeadlineMs,
      stopDeadlineMs,
    }),
    workDeadlineMs,
    stopDeadlineMs,
  };
  const state = () =>
    unwrap<TechnicalState>(
      store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    );
  return { f, root, evidenceRoot, store, brief, claim, state, journal };
}

it('migrates a real bootstrapped schema-1 Store through reserve and restores its verified prior snapshot', async () => {
  const f = await fixture(),
    before = f.state();
  const reserved = await withH06LegacyCoderRuntime(
    f.claim,
    f.store,
    'create',
    new Map(),
    openH06NativeLegacyBudget,
    async (runtime) => {
      const coder = await startCoder(f.brief, runtime.coder);
      expect((await runtime.coder.runs.read())?.schema_version).toBe(2);
      return coder;
    },
  );
  expect(reserved.status).toBe('reserved');
  expect(reserved.copy).toBeNull();
  expect(reserved.session).toBeNull();
  expect(existsSync(join(f.evidenceRoot, 'coders'))).toBe(false);
  expect(openH06NativeLegacyBudget(f.claim, 'reopen').inspect()).toMatchObject({
    status: 'RECORDED',
    used: 0,
  });
  const workflow = await f.journal.read();
  expect(workflow).toMatchObject({ schema_version: 2, coders: { first: { status: 'reserved' } } });
  expect(workflow.format_backup).toBeDefined();
  const receipt = JSON.parse(
    readH04Pin({
      path: workflow.format_backup!.locator,
      sha256: workflow.format_backup!.hash,
    }).toString(),
  ) as { revision: number };
  expect(receipt.revision).toBe(before.revision + 1);
  expect(f.state()).toMatchObject({
    owner: before.owner,
    generation: before.generation,
    frozen: false,
    released: false,
  });
  const restoredRoot = join(f.root, 'restored-store');
  restoreStore(dirname(workflow.format_backup!.locator), restoredRoot, grant);
  const restored = new SqliteEvidenceStore(restoredRoot, grant, Date.now);
  expect(
    unwrap<TechnicalState>(
      restored.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    ),
  ).toEqual({ ...before, frozen: true, revision: before.revision + 1 });
  const restoredJournal = new TaskWorkflowJournal(
    { execute: async (value) => restored.execute(value) },
    grant.context,
    1,
  );
  expect(await restoredJournal.read()).toMatchObject({
    schema_version: 1,
    execution: { status: 'implementing' },
  });
});

it('exposes the standard temporary freeze to the existing strict ownership observer', async () => {
  const f = await fixture(),
    execute = f.store.execute.bind(f.store);
  let observedFrozen = false;
  vi.spyOn(f.store, 'execute').mockImplementation((request) => {
    const result = execute(request);
    if (
      request.command.type === 'mutate' &&
      request.command.change.type === 'freeze' &&
      result.ok
    ) {
      const current = unwrap<TechnicalState>(
        execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
      );
      expect(() => requireContract(!current.frozen, 'h06-legacy-owner')).toThrow(
        'h06-legacy-owner',
      );
      observedFrozen = true;
    }
    return result;
  });
  await withH06LegacyCoderRuntime(
    f.claim,
    f.store,
    'create',
    new Map(),
    openH06NativeLegacyBudget,
    async (runtime) => startCoder(f.brief, runtime.coder),
  );
  expect(observedFrozen).toBe(true);
  expect(f.state().frozen).toBe(false);
});
