import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { writerScopeHash } from '../adapters/project/writerScope.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { TaskLocalRuns } from '../adapters/storage/localRunStores.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { backupSupervision } from '../adapters/storage/supervisionBackup.js';
import { FileCoderWorkspaces } from '../adapters/project/coderWorkspaces.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { readTaskCouncilSelection } from '../cli/taskChatSelection.js';
import { assignAdviser, answerCouncil, createCouncil, councilRoles } from '../core/council.js';
import { taskChatGates, taskChatSelection } from '../cli/taskChatInputs.js';
import { launchCoder, startCoder } from '../application/coderWorkflow.js';
import { createChatControl } from '../core/chatControl.js';
import type { ChatControlEvent } from '../core/chatControl.js';
import type { ChatObservation } from '../core/currentChat.js';
import type { TechnicalState } from '../core/evidence.js';
import type { ChatContext } from '../ports/chatContext.js';
import type { EvidenceStore } from '../ports/evidenceStore.js';
import type { EffectRecord } from '../core/evidence.js';
import { requiredProcedures, startLocalRun, type RunSpec } from '../core/localRun.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import type { UserCommandTarget } from '../ports/userCommands.js';
import { object } from '../src/contracts/project.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import type * as Authority from './comparisonH06DelegatedAuthority.js';
import type { H06DelegatedPhase } from './comparisonH06DelegatedAuthority.js';
import {
  openH06DelegatedPhaseLedger,
  readH06DelegatedAuthority,
} from './comparisonH06DelegatedAuthority.js';
import {
  verifyH06DelegatedDelivery,
  type H06DelegatedDeliveryProof,
} from './comparisonH06DelegatedDelivery.js';
import {
  applyH06DelegatedLegacyControl,
  h06DelegatedControlPorts,
  prepareH06DelegatedLegacy,
  verifyH06DelegatedPhase,
} from './comparisonH06DelegatedLegacy.js';
import { observeH06NativeFailure } from './comparisonH06NativeFailure.js';
import { grant, signed } from './storageFixtures.js';
import { workflowFixture } from './workflowFixtures.js';
import { coderFixture } from './coderFixtures.js';

vi.mock('./comparisonH06DelegatedAuthority.js', async (original) => ({
  ...(await original<typeof Authority>()),
  readH06DelegatedAuthority: vi.fn(),
  openH06DelegatedPhaseLedger: vi.fn(),
}));
vi.mock('./comparisonH06DelegatedDelivery.js', () => ({ verifyH06DelegatedDelivery: vi.fn() }));
const dispose: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of dispose.splice(0)) await cleanup();
});

async function fixture(execution = false, desktop169 = false) {
  const f = await workflowFixture();
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-delegated-actor-'));
  dispose.push(f.dispose, () => rmSync(root, { recursive: true, force: true }));
  const pin = (name: string, value: unknown): H04Pin => {
    const path = join(root, name),
      bytes = canonical(value) + '\n';
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const assets = h06Assets();
  const materials = JSON.parse(readH04Pin(assets.materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  const material = materials.cases.find((v) => v.id === 'H-06')!.files;
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
    'task',
  );
  await f.file(f.card.locator, connection.after);
  const spec: RunSpec = {
    ...f.spec,
    identity: { task_id: 'task', card: await f.ref(f.card.locator) },
    host_id: 'local',
    session_id: grant.context.actor_id,
    requested: { ...f.spec.requested, permissions: [...f.spec.requested.permissions, 'implement'] },
    route: { kind: 'substantial', accepted_plan: await f.ref(planningFile) },
  };
  const marker = 'delegated-load';
  const preparation = {
    kind: 'comparison-h06-native-legacy-preparation/2',
    descriptor: 'connection.json',
    planningFile,
    marker,
    spec,
    ...(execution ? { gates: taskChatGates(spec.criteria, [spec.criteria[0]!]) } : {}),
  };
  const input = pin('preparation.json', preparation);
  const bootstrap = pin('bootstrap.json', {
    kind: 'comparison-h06-native-legacy-bootstrap/2',
    generation: 1,
    actorId: 'owner',
    projectId: 'project',
    runId: 'run',
    permissions: grant.permissions,
  });
  const evidenceRoot = join(root, 'evidence'),
    sessions = join(root, 'sessions');
  mkdirSync(evidenceRoot);
  mkdirSync(sessions);
  mkdirSync(join(evidenceRoot, 'f01'));
  const binding = {
    operationId: 'task',
    variant: 'legacy' as const,
    workspaceRoot: f.root,
    node: pin('node', 'node'),
    timeoutMs: 2000,
  };
  const observation = observeH06NativeFailure(f.root);
  const initialFailure = pin('failure.json', {});
  initialFailure.path = join(evidenceRoot, 'f01', 'receipt.json');
  const failure = {
    kind: 'h06-native-f01',
    binding,
    before: observation,
    after: observation,
    outcome: {
      command: {
        executable: binding.node.path,
        sha256: binding.node.sha256,
        args: ['checks.mjs'],
        timeoutMs: 2000,
      },
      stop: { confirmed: true, processes: [{}] },
      code: 1,
      signal: null,
      error: null,
      log: `Error: ENOENT: no such file or directory, open '${observation.missingManifest}'`,
    },
  };
  const bytes = canonical(failure) + '\n';
  writeFileSync(initialFailure.path, bytes);
  initialFailure.sha256 = digest(bytes);
  const storeRoot = join(evidenceRoot, 'legacy-store');
  initializeStore(storeRoot, grant.context);
  const store = new SqliteEvidenceStore(storeRoot, grant, Date.now);
  unwrap(
    store.execute(signed({ type: 'claim', lease_until: Date.now() + 600000 }, 0, 0, 'initial')),
  );
  const transcript = join(sessions, 'actor.jsonl');
  const reads = [...spec.rules, ...spec.procedures]
    .map(({ locator, hash }) =>
      JSON.stringify({
        chat_read: marker,
        locator,
        hash,
        content: readFileSync(join(f.root, locator), 'utf8'),
      }),
    )
    .join('\n');
  writeFileSync(
    transcript,
    [
      {
        type: 'session_meta',
        payload: {
          id: 'owner',
          session_id: 'owner',
          cwd: f.root,
          cli_version: desktop169 ? '0.169.0-alpha.11.1' : '0.166.0-alpha.6',
          source: 'vscode',
          originator: 'codex_work_desktop',
          thread_source: desktop169 ? 'agent_created_thread' : 'user',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'actor-turn' } },
      {
        type: 'turn_context',
        payload: {
          turn_id: 'actor-turn',
          ...(desktop169 ? { root_turn_id: 'root-turn' } : {}),
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
          thread_id: 'owner',
          turn_id: 'actor-turn',
          item: {
            type: 'CommandExecution',
            cwd: f.root,
            status: 'completed',
            exit_code: 0,
            aggregated_output: reads,
          },
        },
      },
    ]
      .map((v) => JSON.stringify(v))
      .join('\n') + '\n',
  );
  vi.stubEnv('CODEX_THREAD_ID', 'owner');
  const claimPin = pin('claim.json', {}),
    phasePin = pin('phase.json', {});
  const phase = {
    stage: 'load' as const,
    nonce: 'load-nonce',
    rootThread: 'controller',
    actorThread: 'owner',
    requestHash: 'request-hash',
    generation: 1,
    storeRevision: 1,
    controlRevision: 0,
    requirementsRevision: 0,
    predecessor: null,
  };
  const claimed = {
    kind: 'h06-delegated-legacy-claim/1',
    request: {
      binding,
      evidenceRoot,
      bootstrap,
      runtime: [input],
      chat: { threadId: 'controller', workspace: root },
    },
    actorId: 'owner',
    generation: 1,
    requestHash: 'request-hash',
    grant: { sessionsRoot: sessions },
    source: {
      turnId: 'root-turn',
      source: { locator: join(sessions, 'root.jsonl') + '#L4', hash: 'a'.repeat(64) },
    },
    workDeadlineMs: Date.now() + 600000,
  };
  const proof: H06DelegatedDeliveryProof = {
    kind: 'h06-delegated-delivery-proof/1',
    input: {
      kind: 'comparison-h06-delegated-delivery/1',
      sessionsRoot: sessions,
      root: {
        threadId: 'controller',
        workspace: root,
        turnId: 'root-turn',
        user: claimed.source.source,
      },
      actor: { threadId: 'owner', workspace: f.root },
      command: {
        kind: 'comparison-h06-delegated-command/1',
        nonce: phase.nonce,
        requestHash: phase.requestHash,
        action: 'LOAD',
        target: {
          claim: { ...claimPin },
          intent: { ...phasePin },
          stage: phase.stage,
          generation: 1,
          storeRevision: 1,
          controlRevision: 0,
          requirementsRevision: 0,
        },
      },
      prompt: 'fixture',
    },
    user: claimed.source.source,
    outbound: claimed.source.source,
    inbound: { locator: transcript + '#L4', hash: 'b'.repeat(64) },
    confirmation: claimed.source.source,
    actorTurnId: 'actor-turn',
    authorityIssued: false,
    mayRun: false,
    qualification: false,
  };
  const delivery = pin('delivery.json', proof);
  const pending = { phase, intent: phasePin, outcome: null };
  const ledger = { status: 'UNKNOWN', phases: [pending] };
  vi.mocked(readH06DelegatedAuthority).mockReturnValue(
    claimed as unknown as ReturnType<typeof readH06DelegatedAuthority>,
  );
  vi.mocked(openH06DelegatedPhaseLedger).mockReturnValue({
    inspect: () => ledger,
  } as unknown as ReturnType<typeof openH06DelegatedPhaseLedger>);
  vi.mocked(verifyH06DelegatedDelivery).mockImplementation(() => proof);
  return {
    f,
    pin,
    claimed,
    phase,
    pending,
    ledger,
    proof,
    preparation,
    store,
    storeRoot,
    evidenceRoot,
    value: { claim: claimPin, phase: phasePin, delivery, input, initialFailure },
    rewrite() {
      const next = pin('delivery.json', proof);
      this.value.delivery = next;
    },
    target: {
      project_id: 'project',
      task_id: 'task',
      run_id: 'run',
      thread_id: 'owner',
      generation: 1,
      control_revision: 0,
      requirements_revision: 0,
    } satisfies UserCommandTarget,
  };
}

it('binds one current phase and derives the native actor anchor without issuing authority', async () => {
  const f = await fixture(),
    bound = verifyH06DelegatedPhase(f.value);
  expect(bound.anchor).toEqual({
    thread_id: 'owner',
    turn_id: 'actor-turn',
    workspace: f.f.root,
    host_id: 'local',
  });
  expect(bound.transcript).toBe(f.proof.inbound.locator.replace(/#L4$/u, ''));
  expect(bound.source).toEqual({ locator: f.value.delivery.path, hash: f.value.delivery.sha256 });
  expect(bound.proof.qualification).toBe(false);
});

it.each([
  'sessions',
  'root-thread',
  'root-workspace',
  'root-turn',
  'root-user',
  'actor-thread',
  'actor-workspace',
  'nonce',
  'hash',
  'action',
  'target',
  'generation',
  'phase-root',
  'phase-actor',
  'phase-hash',
  'deadline',
])('rejects a changed %s before a delegated command', async (kind) => {
  const f = await fixture(),
    input = f.proof.input;
  if (kind === 'sessions') input.sessionsRoot += '-other';
  if (kind === 'root-thread') input.root.threadId = 'other';
  if (kind === 'root-workspace') input.root.workspace += '-other';
  if (kind === 'root-turn') input.root.turnId = 'other';
  if (kind === 'root-user') input.root.user = { ...input.root.user, hash: 'c'.repeat(64) };
  if (kind === 'actor-thread') input.actor.threadId = 'other';
  if (kind === 'actor-workspace') input.actor.workspace += '-other';
  if (kind === 'nonce') input.command.nonce = 'other';
  if (kind === 'hash') input.command.requestHash = 'other';
  if (kind === 'action') input.command.action = 'PAUSE';
  if (kind === 'target') input.command.target.controlRevision = 1;
  if (kind === 'generation') f.phase.generation++;
  if (kind === 'phase-root') f.phase.rootThread = 'other';
  if (kind === 'phase-actor') f.phase.actorThread = 'other';
  if (kind === 'phase-hash') f.phase.requestHash = 'other';
  if (kind === 'deadline') f.claimed.workDeadlineMs = Date.now() - 1;
  expect(() => verifyH06DelegatedPhase(f.value)).toThrow('h06-delegated-phase-delivery');
});
it.each(['absent', 'completed', 'other-intent'])('rejects a %s phase admission', async (kind) => {
  const f = await fixture();
  if (kind === 'absent') f.ledger.phases = [];
  if (kind === 'completed') Object.assign(f.pending, { outcome: f.value.claim });
  if (kind === 'other-intent') f.pending.intent = f.value.claim;
  expect(() => verifyH06DelegatedPhase(f.value)).toThrow('h06-delegated-current-phase');
});

it('forwards native observations, LOAD, boundary and continuation, while checking exact delegated references', async () => {
  const f = await fixture(),
    native = new FileCurrentChatHost(
      f.f.root,
      f.proof.inbound.locator.replace(/#L4$/u, ''),
      verifyH06DelegatedPhase(f.value).anchor,
    );
  const boundary = vi
    .spyOn(native, 'boundary')
    .mockResolvedValue({ kind: 'completed', source: f.claimed.source.source });
  const continuation = vi.spyOn(native, 'continuation').mockResolvedValue(f.claimed.source.source);
  const message = vi.spyOn(native, 'message'),
    reference = vi.spyOn(native, 'reference');
  const { host, commands } = h06DelegatedControlPorts(f.value, native, f.target);
  const source = verifyH06DelegatedPhase(f.value).source;
  expect(await host.observe()).toEqual(await native.observe());
  expect(await host.load(startLocalRun(f.preparation.spec, 1), 'delegated-load')).toMatchObject({
    session_id: 'owner',
  });
  await host.boundary('old');
  await host.continuation('old');
  expect(boundary).toHaveBeenCalledWith('old');
  expect(continuation).toHaveBeenCalledWith('old');
  await expect(host.message(source)).resolves.toEqual({
    thread_id: 'owner',
    turn_id: 'actor-turn',
  });
  await host.reference(source);
  await commands.verify(source, f.target);
  expect(message).not.toHaveBeenCalled();
  expect(reference).not.toHaveBeenCalled();
  await expect(host.message(source, 'old')).rejects.toThrow(
    'h06-delegated-previous-source-forbidden',
  );
  await expect(host.reference({ ...source, hash: 'other' })).rejects.toThrow(
    'h06-delegated-command-target',
  );
});

it.each([
  'project_id',
  'task_id',
  'run_id',
  'thread_id',
  'generation',
  'control_revision',
  'requirements_revision',
] as const)('rejects changed UserCommands target %s', async (key) => {
  const f = await fixture(),
    native = {} as CurrentChatHost;
  const { commands } = h06DelegatedControlPorts(f.value, native, f.target);
  const changed = { ...f.target, [key]: typeof f.target[key] === 'number' ? 2 : 'other' };
  await expect(commands.verify(verifyH06DelegatedPhase(f.value).source, changed)).rejects.toThrow(
    'h06-delegated-command-target',
  );
  const bad = h06DelegatedControlPorts(f.value, native, changed);
  await expect(
    bad.commands.verify(verifyH06DelegatedPhase(f.value).source, changed),
  ).rejects.toThrow('h06-delegated-command-target');
});

it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  'uses stock prepare/bootstrap/execution with real Store and LOAD, execution=%s, Desktop 0.169=%s',
  async (execution, desktop169) => {
    const f = await fixture(execution, desktop169),
      verify = vi.fn();
    const result = await prepareH06DelegatedLegacy(f.value, verify);
    expect(result.ready.run.status).toBe('ready');
    expect(result.request.storage).toEqual({ root: f.storeRoot, grant });
    expect(result.execution?.status ?? null).toBe(execution ? 'implementing' : null);
    expect(verify).toHaveBeenCalled();
    await expect(prepareH06DelegatedLegacy(f.value, verify)).rejects.toThrow(
      'h06-delegated-preparation-store',
    );
  },
);

it('bootstraps and begins execution with pinned council snapshots outside the fresh attempt', async () => {
  const f = await fixture(true);
  const source = f.f;
  const spec = f.preparation.spec;
  const directory = join(f.evidenceRoot, '..', 'review');
  mkdirSync(directory);
  const roles = Object.fromEntries(
    councilRoles.map((role) => [
      role,
      role === 'architect'
        ? {
            trigger: true,
            reason: 'contract',
            requirements: ['source.txt'],
            inputs: { files: ['source.txt'], directories: [] },
          }
        : { trigger: false, reason: 'outside scope' },
    ]),
  );
  await source.file('roles.json', JSON.stringify({ schema_version: 1, roles }));
  const plan = await readTaskCouncilSelection(source.root, 'roles.json');
  const files = new FileWorkflowInputs(source.root, directory);
  const shared = spec.sources.map((ref) => ref.locator);
  spec.sources = [...spec.sources, plan.ref];
  const { selection, inputs } = await taskChatSelection(files, shared, {}, [], {
    plan,
    directory,
    shared,
  });
  const target = { ...source.target, scope: spec.outcome, diff: spec.assignment, inputs };
  const assigned = assignAdviser(
    createCouncil('planning', selection, target),
    'architect',
    source.adviser,
  );
  const council = answerCouncil(assigned, 'architect', 'session', {
    ...source.answer(assigned),
    scope: target.scope,
  });
  await source.file(
    'planning.json',
    JSON.stringify({
      schema_version: 1,
      task_id: 'task',
      council,
      council_selection: plan.ref,
      requirements_revision: 0,
    }),
  );
  spec.route = { kind: 'substantial', accepted_plan: await source.ref('planning.json') };
  const snapshot = selection.architect.requirements.find((ref) =>
    ref.locator.includes('/selection-architect-'),
  )!;
  f.value.input = f.pin('preparation.json', f.preparation);
  f.claimed.request.runtime = [f.value.input, { path: snapshot.locator, sha256: snapshot.hash }];
  const result = await prepareH06DelegatedLegacy(f.value, () => {});
  expect(result.ready.run.status).toBe('ready');
  expect(result.execution?.status).toBe('implementing');
  expect(result.request.evidence_root).toBe(f.evidenceRoot);
});

it.each([
  'wrong-input',
  'wrong-failure',
  'other-stage',
  'other-actor',
  'other-owner',
  'expired-lease',
  'other-descriptor',
])('rejects %s before preparation effects', async (kind) => {
  const f = await fixture();
  if (kind === 'wrong-input') f.value.input = f.value.claim;
  if (kind === 'wrong-failure') f.value.initialFailure = f.value.claim;
  if (kind === 'other-stage') {
    Object.assign(f.phase, { stage: 'warm-pause' });
    f.proof.input.command.action = 'PAUSE';
    f.proof.input.command.target.stage = 'warm-pause';
  }
  if (kind === 'other-actor') vi.stubEnv('CODEX_THREAD_ID', 'other');
  if (kind === 'other-owner') vi.spyOn(f.store, 'execute');
  if (kind === 'expired-lease') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 700000);
  if (kind === 'other-descriptor') {
    f.preparation.descriptor = 'absent.json';
    f.value.input = f.pin('preparation.json', f.preparation);
    f.claimed.request.runtime = [f.value.input];
  }
  if (kind === 'other-owner') f.claimed.actorId = 'other';
  await expect(prepareH06DelegatedLegacy(f.value, () => {})).rejects.toThrow();
});

it('refuses control with a changed store revision before producing any effect', async () => {
  const f = await fixture();
  const input = {
    ...f.value,
    descriptor: 'connection.json',
    event: {
      type: 'PAUSE' as const,
      id: f.phase.nonce,
      expected_revision: 0,
      generation: 1,
      thread_id: 'owner',
      source: verifyH06DelegatedPhase(f.value).source,
      reason: 'fixture',
    },
  };
  await expect(applyH06DelegatedLegacyControl(input, f.store)).rejects.toThrow(
    'h06-delegated-control-binding',
  );
});

async function controlFixture() {
  const f = await fixture(),
    child = await coderFixture();
  dispose.push(child.dispose);
  const reserved = await startCoder(await child.brief(), child.deps);
  const coder = await launchCoder(reserved.brief.id, child.deps);
  f.claimed.actorId = 'session';
  f.claimed.request.binding.workspaceRoot = child.root;
  f.phase.actorThread = 'session';
  f.proof.input.actor = { threadId: 'session', workspace: child.root };
  f.proof.input.command.action = 'PAUSE';
  Object.assign(f.phase, { stage: 'warm-pause', nonce: 'pause-nonce', storeRevision: 5 });
  Object.assign(f.proof.input.command, {
    nonce: f.phase.nonce,
    target: { ...f.proof.input.command.target, stage: 'warm-pause', storeRevision: 5 },
  });
  vi.stubEnv('CODEX_THREAD_ID', 'session');
  f.rewrite();
  const source = () => verifyH06DelegatedPhase(f.value).source;
  const observed: ChatObservation & { effective_read_only: boolean } = {
    thread_id: 'session',
    turn_id: 'actor-turn',
    workspace: child.root,
    host_id: 'local',
    client_version: '0.166.0-alpha.6',
    model: child.executor.spec.requested.model,
    effort: child.executor.spec.requested.effort,
    approval_policy: 'never',
    sandbox_policy: 'danger-full-access',
    permission_profile: 'disabled',
    network_access: true,
    effective_read_only: false,
    source: child.proof,
  };
  let chat: ChatContext = {
    run: child.executor,
    messages: { requirements_revision: 0 } as ChatContext['messages'],
    workflow: await child.deps.journal.read(),
    coordination_bound: false,
    control: createChatControl(observed, 1),
  };
  let technical: TechnicalState = {
    revision: 5,
    generation: 1,
    owner: 'session',
    lease_until: Date.now() + 600000,
    released: false,
    frozen: false,
    checkpoint: null,
  };
  const context = { ...grant.context, actor_id: 'session' };
  let ackKnown = true,
    staleMutation = false;
  const store: Parameters<typeof applyH06DelegatedLegacyControl>[1] = {
    root: f.storeRoot,
    grant: { context, permissions: grant.permissions },
    execute({ command }) {
      if (command.type === 'state') return { ok: true, value: technical };
      if (command.type === 'effects')
        return {
          ok: true,
          value: [{ outcome: 'confirmed' }, { outcome: 'not-started' }] as EffectRecord[],
        };
      if (command.type === 'mutate') return { ok: true, value: technical };
      if (command.type === 'operation')
        return {
          ok: true,
          value: ackKnown
            ? {
                status: 'confirmed',
                ack: {
                  operation_id: command.operation_id,
                  catalog_revision: technical.revision,
                  generation: 1,
                  evidence_id: null,
                  revision: null,
                  content_hash: 'b'.repeat(64),
                  locator: 'fixture',
                },
              }
            : { status: 'unknown' },
        };
      throw Error('unexpected Store operation');
    },
  };
  vi.spyOn(TaskChatContext.prototype, 'read').mockImplementation(async function (
    this: TaskChatContext,
  ) {
    const adapter = (this as unknown as { store: EvidenceStore }).store;
    await adapter.execute({ context, command: { type: 'state', archive: 'current' } });
    return chat;
  });
  vi.spyOn(TaskChatContext.prototype, 'save').mockImplementation(async function (
    this: TaskChatContext,
    expected,
    next,
    operation,
  ) {
    const adapter = (this as unknown as { store: EvidenceStore }).store;
    await adapter.execute(
      signed(
        { type: 'checkpoint', state: {}, effects: [] },
        technical.revision + (staleMutation ? 1 : 0),
        1,
        operation,
        { context, permissions: grant.permissions },
      ),
    );
    expect(expected).toBe(chat);
    chat = next;
    technical = { ...technical, revision: technical.revision + 1 };
  });
  vi.spyOn(FileCurrentChatHost.prototype, 'observe').mockImplementation(async () => ({
    ...observed,
    turn_id: f.proof.actorTurnId,
  }));
  vi.spyOn(FileCurrentChatHost.prototype, 'load').mockImplementation(async (run) => ({
    ...child.executor.loaded!,
    session_id: run.spec.session_id,
    run_id: run.spec.run_id,
    procedures: run.spec.procedures,
    rules: run.spec.rules,
    observed_read: 'fresh fixture LOAD',
  }));
  vi.spyOn(FileCurrentChatHost.prototype, 'boundary').mockResolvedValue({
    kind: 'completed',
    source: child.proof,
  });
  const stopWriter = vi.fn(async () => {
    const markers = [coder.copy!.evidence.locator, coder.session!.receipt.locator];
    const hash = await writerScopeHash(markers, coder.copy!.binding.root);
    const pinned = f.pin('physical-stop.json', {
      kind: 'writers-stopped',
      thread: coder.session!.id,
      active_turn: false,
      remaining_terminals: 0,
      remaining_processes: 0,
      before_hash: hash,
      after_hash: hash,
      observation_ms: 1,
      owned: {
        thread: coder.session!.id,
        turn: coder.turn,
        tree: coder.copy!.binding.root,
        complete: true,
        markers,
      },
      processes: [],
    });
    const path = join(f.evidenceRoot, 'physical-stop.json'),
      bytes = readFileSync(pinned.path);
    writeFileSync(path, bytes);
    return { coder, stopped: { locator: path, hash: digest(bytes) } };
  });
  function event(): ChatControlEvent & { type: 'PAUSE' } {
    return {
      type: 'PAUSE',
      id: f.phase.nonce,
      expected_revision: f.phase.controlRevision,
      generation: 1,
      thread_id: 'session',
      source: source(),
      reason: 'fixture delegated pause',
    };
  }
  return {
    f,
    child,
    coder,
    store,
    stopWriter,
    event,
    source,
    get chat() {
      return chat;
    },
    get technical() {
      return technical;
    },
    controlValue: () => ({ ...f.value, event: event(), descriptor: 'connection.json' }),
    unknownAck() {
      ackKnown = false;
    },
    staleMutation() {
      staleMutation = true;
    },
    setState(change: Partial<TechnicalState>) {
      technical = { ...technical, ...change };
    },
  };
}

async function resumeFixture(mode: 'warm' | 'cold' = 'warm') {
  const c = await controlFixture();
  if (mode === 'cold') {
    Object.assign(c.f.phase, { stage: 'cold-pause' });
    c.f.proof.input.command.target.stage = 'cold-pause';
    c.f.rewrite();
  }
  const paused = await applyH06DelegatedLegacyControl(c.controlValue(), c.store, {
    stopWriter: c.stopWriter,
  });
  expect(c.chat.control?.status).toBe('paused');
  expect(c.stopWriter).toHaveBeenCalledOnce();
  const result = object(JSON.parse(readH04Pin(paused.receipt).toString()));
  expect(result).toMatchObject({
    kind: 'h06-delegated-control-result/1',
    qualification: false,
    writer: { coder: c.coder },
  });
  const pauseResult =
    mode === 'cold'
      ? c.f.pin('previous-host-result.json', { ...result, host: { pid: 89, startedAt: 1 } })
      : paused.receipt;
  const writer = result.writer as Awaited<ReturnType<typeof c.stopWriter>>;
  const outcome = c.f.pin('pause-outcome.json', {
    kind: 'h06-delegated-phase-outcome/1',
    status: 'confirmed',
    claim: c.f.value.claim,
    intent: c.f.value.phase,
    stage: mode + '-pause',
    delivery: c.f.value.delivery,
    result: pauseResult,
  });
  const settlement = c.f.pin('pause-settlement.json', {
    kind: 'h06-delegated-phase-settlement/1',
    intent: c.f.value.phase,
    outcome,
  });
  Object.assign(c.f.phase, {
    stage: mode + '-resume',
    nonce: 'resume-nonce',
    storeRevision: c.technical.revision,
    controlRevision: 1,
    predecessor: settlement,
  });
  c.f.value.phase = c.f.pin('resume-phase.json', {});
  c.f.pending.intent = c.f.value.phase;
  c.f.proof.actorTurnId = 'resume-turn';
  Object.assign(c.f.proof.input.command, {
    nonce: c.f.phase.nonce,
    action: 'RESUME',
    target: {
      claim: c.f.value.claim,
      intent: c.f.value.phase,
      stage: mode + '-resume',
      generation: 1,
      storeRevision: c.technical.revision,
      controlRevision: 1,
      requirementsRevision: 0,
    },
  });
  c.f.rewrite();
  const value = {
    ...c.f.value,
    descriptor: 'connection.json',
    event: {
      type: 'RESUME',
      id: c.f.phase.nonce,
      expected_revision: 1,
      generation: 1,
      thread_id: 'session',
      source: c.source(),
      authorization: c.source(),
      marker: 'fresh-resume',
      stopped: writer.stopped,
    },
  } as const;
  return { c, value, writer };
}

it.each(['warm', 'cold'] as const)('applies stock PAUSE/STOP and %s RESUME', async (mode) => {
  const { c, value, writer } = await resumeFixture(mode);
  if (mode === 'cold')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    });
  const resumed = await applyH06DelegatedLegacyControl(value, c.store);
  expect(c.chat.control?.status).toBe('active');
  expect(c.chat.run.loaded).not.toBeNull();
  expect(object(JSON.parse(readH04Pin(resumed.receipt).toString())).writer).toEqual(writer);
});

it.each([
  'frozen',
  'released',
  'lease',
  'generation',
  'owner',
  'revision',
  'wrong-source',
  'stop-required',
  'ack-unknown',
  'stale-mutation',
])('rejects %s during delegated control', async (kind) => {
  const c = await controlFixture(),
    value = c.controlValue();
  if (kind === 'frozen') c.setState({ frozen: true });
  if (kind === 'released') c.setState({ released: true });
  if (kind === 'lease') c.setState({ lease_until: Date.now() - 1 });
  if (kind === 'generation') c.setState({ generation: 2 });
  if (kind === 'owner') c.setState({ owner: 'other' });
  if (kind === 'revision') c.setState({ revision: 6 });
  if (kind === 'wrong-source') value.event.source = { ...value.event.source, hash: 'other' };
  if (kind === 'ack-unknown') c.unknownAck();
  if (kind === 'stale-mutation') c.staleMutation();
  await expect(
    applyH06DelegatedLegacyControl(
      value,
      c.store,
      kind === 'stop-required' ? {} : { stopWriter: c.stopWriter },
    ),
  ).rejects.toThrow();
  if (kind !== 'ack-unknown') expect(c.chat.control?.status).toBe('active');
  expect(c.stopWriter).not.toHaveBeenCalled();
});

it.each(['alive', 'denied'] as const)(
  'does not claim a cold restart when previous host is %s',
  async (kind) => {
    const { c, value } = await resumeFixture('cold');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (kind === 'denied') throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      return true;
    });
    await expect(applyH06DelegatedLegacyControl(value, c.store)).rejects.toThrow(
      kind === 'alive' ? 'h06-delegated-previous-host-active' : 'permission denied',
    );
    expect(c.chat.control?.status).toBe('paused');
  },
);

async function retainedSqliteFixture(
  options: { spaced?: boolean; otherTurn?: boolean; unknownEffect?: boolean } = {},
) {
  const f = await fixture(true),
    nativePorts = await coderFixture();
  dispose.push(nativePorts.dispose);
  execFileSync('git', ['init', '-q'], { cwd: f.f.root });
  await f.f.file(
    'tools/agent-workflow/roles/coder.md',
    readFileSync(new URL('../roles/coder.md', import.meta.url), 'utf8'),
  );
  const artifact = (name: string, value: unknown): H04Pin => {
    const path = join(f.evidenceRoot, name),
      bytes = canonical(value) + '\n';
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const phases: Array<{ phase: H06DelegatedPhase; intent: H04Pin; outcome: H04Pin | null }> = [
    { phase: { ...f.phase }, intent: f.value.phase, outcome: null },
  ];
  Object.assign(f.claimed, { startedAt: performance.timeOrigin - 1000 });
  vi.mocked(openH06DelegatedPhaseLedger).mockReturnValue({
    inspect: () => ({ status: phases.at(-1)?.outcome === null ? 'UNKNOWN' : 'RECORDED', phases }),
  } as ReturnType<typeof openH06DelegatedPhaseLedger>);
  vi.mocked(verifyH06DelegatedDelivery).mockImplementation(
    (value) => value as H06DelegatedDeliveryProof,
  );
  const loadTicket = { claim: f.value.claim, phase: f.value.phase, delivery: f.value.delivery };
  const prepared = await prepareH06DelegatedLegacy(f.value, () => {});
  const loadResult = artifact('delegated-load-result.json', {
    kind: 'h06-delegated-load-result/1',
    ...loadTicket,
    prepared,
    qualification: false,
  });
  function settle(index: number, result: H04Pin, delivery: H04Pin) {
    const p = phases[index]!;
    const outcome = artifact(index + '-outcome.json', {
      kind: 'h06-delegated-phase-outcome/1',
      claim: f.value.claim,
      intent: p.intent,
      stage: p.phase.stage,
      status: 'confirmed',
      delivery,
      result,
    });
    p.outcome = artifact(index + '-settlement.json', {
      kind: 'h06-delegated-phase-settlement/1',
      intent: p.intent,
      outcome,
    });
  }
  settle(0, loadResult, loadTicket.delivery);
  const persistence = {
    execute: async (value: Parameters<typeof f.store.execute>[0]) => f.store.execute(value),
  };
  const backup = (state: TechnicalState, operation: string) =>
    backupSupervision(persistence, f.storeRoot, f.evidenceRoot, grant, state, operation);
  const runs = new TaskLocalRuns(persistence, grant.context, 1, true, backup),
    journal = new TaskWorkflowJournal(persistence, grant.context, 1, true, backup);
  const parent = (await runs.read())!;
  const rules = [await f.f.ref('AGENTS.md'), await f.f.ref('tools/agent-workflow/roles/coder.md')];
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
    ].map((path) => f.f.ref(path)),
  );
  const brief = {
    id: 'retained',
    project_id: 'project',
    task_id: 'task',
    parent_run_id: 'run',
    parent_session_id: 'owner',
    generation: 1,
    card: await f.f.ref(f.f.card.locator),
    authority:
      f.preparation.spec.route.kind === 'substantial'
        ? f.preparation.spec.route.accepted_plan!
        : f.f.proof,
    source_root: f.f.root,
    copy_root: join(f.evidenceRoot, 'coder-workspaces', 'retained'),
    paths: ['source.txt'],
    files,
    rules,
    procedures,
    goal: 'Fixture retained warm host',
    criterion: 'Only source.txt',
    checks: [],
    profile: { model: parent.spec.requested.model, effort: parent.spec.requested.effort },
  };
  const deps = {
    runs,
    journal,
    workspaces: new FileCoderWorkspaces(f.f.root, f.evidenceRoot, async () => {}),
    sessions: nativePorts.deps.sessions,
  };
  await startCoder(brief, deps);
  const coder = await launchCoder(brief.id, deps);
  const runner = f.pin(
      options.spaced ? 'runner spaced.mjs' : 'runner.mjs',
      'fixture pinned runner',
    ),
    loader = f.pin('loader.mjs', 'fixture pinned loader');
  const config = f.pin('config.json', {
    preparation: f.value.input,
    warm: f.pin('warm-brief.json', brief),
    cold: f.pin('cold-brief.json', brief),
    final: f.pin('final-brief.json', brief),
  });
  f.claimed.request.runtime.push(runner, loader, config);
  const configPins = JSON.parse(readH04Pin(config).toString()) as {
    warm: H04Pin;
    cold: H04Pin;
    final: H04Pin;
  };
  f.claimed.request.runtime.push(configPins.warm, configPins.cold, configPins.final);
  f.claimed.request.binding.node = {
    path: process.execPath,
    sha256: digest(readFileSync(process.execPath)),
  };
  const packet = f.pin('load-packet.json', {
    claim: f.value.claim,
    phase: loadTicket.phase,
    config,
    initialFailure: f.value.initialFailure,
    deliveryInput: structuredClone(f.proof.input),
  });
  const argv = process.argv,
    execArgv = process.execArgv;
  process.argv = [process.execPath, runner.path, 'warm', packet.path];
  process.execArgv = ['--import', loader.path];
  dispose.push(() => {
    process.argv = argv;
    process.execArgv = execArgv;
  });
  const command = [process.execPath, ...process.execArgv, ...process.argv.slice(1)]
    .map((p) => (/^[a-zA-Z0-9_./:=+-]+$/u.test(p) ? p : "'" + p.replaceAll("'", "'\\''") + "'"))
    .join(' ');
  const transcript = f.proof.inbound.locator.replace(/#L4$/u, '');
  const initial = readFileSync(transcript, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => object(JSON.parse(line)));
  const callId = 'call_G0vdSDDQmRyd4r99oibK8LXZ';
  initial.push(
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        id: 'native-retained-call',
        status: 'completed',
        call_id: callId,
        name: 'exec',
        input: `text(await tools.exec_command({cmd:${JSON.stringify(command)},tty:true,yield_time_ms:1000,max_output_tokens:18000}));\n`,
        internal_chat_message_metadata_passthrough: { turn_id: 'actor-turn' },
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        id: 'native-retained-output',
        call_id: callId,
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 1.2 seconds\nOutput:\n' },
          {
            type: 'input_text',
            text: JSON.stringify({
              chunk_id: '230c62',
              wall_time_seconds: 1.002665125,
              session_id: 56810,
              original_token_count: 0,
              output: '',
            }),
          },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: 'actor-turn' },
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'actor-turn' } },
  );
  function write() {
    writeFileSync(transcript, initial.map(canonical).join('\n') + '\n');
  }
  if (options.otherTurn) {
    initial.push(
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'other-turn' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'other-turn' } },
    );
    const chat = new TaskChatContext(persistence, grant.context, 1),
      current = await chat.read();
    await chat.save(
      current,
      { ...current, control: { ...current.control!, unreconciled_turns: ['other-turn'] } },
      'fixture:other-unreconciled',
    );
  }
  function next(stage: 'warm-pause' | 'warm-resume', turn: string) {
    const chatState = unwrap<TechnicalState>(
      f.store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    );
    const p: H06DelegatedPhase = {
      stage,
      nonce: stage + '-nonce',
      rootThread: 'controller',
      actorThread: 'owner',
      requestHash: f.claimed.requestHash,
      generation: 1,
      storeRevision: chatState.revision,
      controlRevision: stage === 'warm-pause' ? 0 : 1,
      requirementsRevision: 0,
      predecessor: phases.at(-1)!.outcome,
    };
    const intent = artifact(stage + '-phase.json', {
      kind: 'h06-delegated-phase-intent/1',
      claim: f.value.claim,
      index: phases.length + 1,
      phase: p,
      admittedAt: Date.now(),
    });
    phases.push({ phase: p, intent, outcome: null });
    const proof = structuredClone(f.proof);
    proof.actorTurnId = turn;
    proof.input.command = {
      ...proof.input.command,
      nonce: p.nonce,
      action: stage === 'warm-pause' ? 'PAUSE' : 'RESUME',
      target: {
        claim: { ...f.value.claim },
        intent: { ...intent },
        stage,
        generation: 1,
        storeRevision: p.storeRevision,
        controlRevision: p.controlRevision,
        requirementsRevision: 0,
      },
    };
    const delivery = artifact(stage + '-delivery.json', proof);
    initial.push(
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
      {
        type: 'turn_context',
        payload: {
          turn_id: turn,
          cwd: f.f.root,
          model: parent.spec.requested.model,
          effort: parent.spec.requested.effort,
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
    );
    write();
    return {
      claim: f.value.claim,
      phase: intent,
      delivery,
      input: f.value.input,
      descriptor: 'connection.json',
    };
  }
  const pauseTicket = next('warm-pause', 'pause-turn'),
    pauseSource = { locator: pauseTicket.delivery.path, hash: pauseTicket.delivery.sha256 };
  const stop = async () => {
    const markers = [coder.copy!.evidence.locator, coder.session!.receipt.locator],
      hash = await writerScopeHash(markers, coder.copy!.binding.root);
    const pin = artifact('physical-stop.json', {
      kind: 'writers-stopped',
      thread: coder.session!.id,
      active_turn: false,
      remaining_terminals: 0,
      remaining_processes: 0,
      before_hash: hash,
      after_hash: hash,
      observation_ms: 1,
      owned: {
        thread: coder.session!.id,
        turn: coder.turn,
        tree: coder.copy!.binding.root,
        complete: true,
        markers,
      },
      processes: [],
    });
    return { coder, stopped: { locator: pin.path, hash: pin.sha256 } };
  };
  const paused = await applyH06DelegatedLegacyControl(
    {
      ...pauseTicket,
      event: {
        type: 'PAUSE',
        id: 'warm-pause-nonce',
        expected_revision: 0,
        generation: 1,
        thread_id: 'owner',
        source: pauseSource,
        reason: 'fixture',
      },
    },
    f.store,
    { stopWriter: stop },
  );
  settle(1, paused.receipt, pauseTicket.delivery);
  if (options.unknownEffect) {
    const before = unwrap<TechnicalState>(
      f.store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    );
    unwrap(
      f.store.execute(
        signed(
          {
            type: 'checkpoint',
            state: before.checkpoint,
            effects: [{ id: 'unrelated-pending', intent: { kind: 'fixture pending' } }],
          },
          before.revision,
          1,
          'fixture:pending',
        ),
      ),
    );
  }
  initial.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'pause-turn' } });
  const resume = next('warm-resume', 'resume-turn'),
    resumeSource = { locator: resume.delivery.path, hash: resume.delivery.sha256 },
    marker = 'resume-load';
  const reads = [...parent.spec.rules, ...parent.spec.procedures].map(({ locator, hash }) =>
    JSON.stringify({
      chat_read: marker,
      locator,
      hash,
      content: readFileSync(join(f.f.root, locator), 'utf8'),
    }),
  );
  initial.push({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'owner',
      turn_id: 'resume-turn',
      item: {
        type: 'CommandExecution',
        id: 'resume-read',
        status: 'completed',
        exit_code: 0,
        cwd: f.f.root,
        aggregated_output: reads.join('\n'),
      },
    },
  });
  write();
  const writer = object(JSON.parse(readH04Pin(paused.receipt).toString())).writer as {
    stopped: { locator: string; hash: string };
  };
  const value = {
    ...resume,
    event: {
      type: 'RESUME' as const,
      id: 'warm-resume-nonce',
      expected_revision: 1,
      generation: 1,
      thread_id: 'owner',
      source: resumeSource,
      authorization: resumeSource,
      marker,
      stopped: writer.stopped,
    },
  };
  return { f, value, initial, write, transcript, phases, packet, paused, artifact };
}

it('composes real SQLite and FileHost RESUME around the one verified retained warm command', async () => {
  const x = await retainedSqliteFixture();
  const host = new FileCurrentChatHost(x.f.f.root, x.transcript, {
    thread_id: 'owner',
    turn_id: 'resume-turn',
    workspace: x.f.f.root,
    host_id: 'local',
  });
  await expect(host.continuation('actor-turn')).rejects.toThrow(
    'chat-continuation-operation-pending',
  );
  const resumed = await applyH06DelegatedLegacyControl(x.value, x.f.store);
  const result = object(JSON.parse(readH04Pin(resumed.receipt).toString()));
  expect(result).toMatchObject({ control: { status: 'active', revision: 2 } });
  expect(result.retainedContinuations).toHaveLength(1);
  const current = await new TaskChatContext(
    { execute: async (request) => x.f.store.execute(request) },
    grant.context,
    1,
  ).read();
  expect(current.control?.unreconciled_turns).toEqual([]);
  expect(current.run.loaded).not.toBeNull();
});

it('keeps other completed turns strict and binds a shell-quoted pinned runner', async () => {
  const x = await retainedSqliteFixture({ spaced: true, otherTurn: true });
  const resumed = await applyH06DelegatedLegacyControl(x.value, x.f.store);
  const result = object(JSON.parse(readH04Pin(resumed.receipt).toString()));
  expect(result).toMatchObject({
    control: { status: 'active', revision: 2, unreconciled_turns: [] },
  });
  expect(result.retainedContinuations).toHaveLength(1);
});

it('keeps cold RESUME strict for the same pending warm native command', async () => {
  const x = await retainedSqliteFixture();
  const paused = object(JSON.parse(readH04Pin(x.paused.receipt).toString()));
  const result = x.artifact('cold-pause-synthetic.json', {
    ...paused,
    host: { pid: 89, startedAt: 1 },
  });
  const outcome = x.artifact('cold-pause-outcome.json', {
    kind: 'h06-delegated-phase-outcome/1',
    claim: x.f.value.claim,
    intent: paused.phase,
    stage: 'cold-pause',
    status: 'confirmed',
    delivery: paused.delivery,
    result,
  });
  const predecessor = x.artifact('cold-pause-settlement.json', {
    kind: 'h06-delegated-phase-settlement/1',
    intent: paused.phase,
    outcome,
  });
  const last = x.phases.at(-1)!;
  last.phase.stage = 'cold-resume';
  last.phase.predecessor = predecessor;
  const proof = JSON.parse(readH04Pin(x.value.delivery).toString()) as H06DelegatedDeliveryProof;
  proof.input.command.target.stage = 'cold-resume';
  x.value.delivery = x.artifact('cold-resume-delivery.json', proof);
  const source = { locator: x.value.delivery.path, hash: x.value.delivery.sha256 };
  x.value.event.source = source;
  x.value.event.authorization = source;
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('absent'), { code: 'ESRCH' });
  });
  await expect(applyH06DelegatedLegacyControl(x.value, x.f.store)).rejects.toThrow(
    'chat-continuation-operation-pending',
  );
});

it.each([
  'other-call',
  'other-cell',
  'other-command',
  'other-item',
  'mixed-commands',
  'wrong-packet',
] as const)('refuses %s while the retained host remains unresolved', async (kind) => {
  const x = await retainedSqliteFixture();
  const boundary = x.initial.findIndex(
    (r) =>
      r.type === 'event_msg' &&
      object(r.payload).type === 'task_complete' &&
      object(r.payload).turn_id === 'actor-turn',
  );
  if (kind === 'other-call')
    x.initial.splice(boundary, 0, {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'unrelated', name: 'unknown', arguments: '{}' },
    });
  if (kind === 'other-cell')
    x.initial.splice(
      boundary,
      0,
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'cell',
          name: 'exec',
          input: 'await unresolved();',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'cell',
          output: 'Script running with cell ID unrelated-cell',
        },
      },
    );
  if (kind === 'other-command')
    x.initial.splice(
      boundary,
      0,
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'other-command',
          name: 'exec',
          input: 'text(await tools.exec_command({cmd:"true"}));',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'other-command',
          output: [
            { type: 'input_text', text: 'Script completed\n' },
            { type: 'input_text', text: JSON.stringify({ session_id: 999, output: '' }) },
          ],
        },
      },
    );
  if (kind === 'other-item')
    x.initial.splice(boundary, 0, {
      type: 'event_msg',
      payload: {
        type: 'item_started',
        thread_id: 'owner',
        turn_id: 'actor-turn',
        item: { id: 'other-item', type: 'CommandExecution', status: 'inProgress' },
      },
    });
  if (kind === 'mixed-commands') {
    const launch = x.initial.find(
      (r) =>
        r.type === 'response_item' &&
        object(r.payload).call_id === 'call_G0vdSDDQmRyd4r99oibK8LXZ' &&
        object(r.payload).type === 'custom_tool_call',
    )!;
    object(launch.payload).input =
      String(object(launch.payload).input) + 'text(await tools.exec_command({cmd:"true"}));';
  }
  if (kind === 'wrong-packet') writeFileSync(x.packet.path, '{}');
  x.write();
  await expect(applyH06DelegatedLegacyControl(x.value, x.f.store)).rejects.toThrow();
  const current = await new TaskChatContext(
    { execute: async (request) => x.f.store.execute(request) },
    grant.context,
    1,
  ).read();
  expect(current.control?.status).toBe('paused');
  expect(current.control?.revision).toBe(1);
});

it('refuses a real unrelated pending Store effect before reconciling the retained launch', async () => {
  const x = await retainedSqliteFixture({ unknownEffect: true });
  await expect(applyH06DelegatedLegacyControl(x.value, x.f.store)).rejects.toThrow(
    'h06-delegated-control-store-changed',
  );
});
