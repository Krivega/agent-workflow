import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { workflowFixture, executionEvent } from './workflowFixtures.js';
import { applyExecution, createExecution } from '../core/execution.js';
import { evidenceSchema, type TechnicalState } from '../core/evidence.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import type { InputRef } from '../core/localRun.js';
import type * as ContractModule from './comparisonH01Contract.js';
import type {
  ComparisonH01SessionControls,
  ComparisonSessionRequest,
} from '../adapters/codex/comparisonSession.js';
import type {
  H01AttemptContext,
  H01NativeAccounting,
  H01NativeParticipant,
  H01ExecutionRequest,
  H01GuardDescriptor,
} from './comparisonH01Contract.js';
import { h01ReadJson, h01ReadPin, h01Record, h01RequestHash } from './comparisonH01Contract.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { object } from '../core/connection.js';
import {
  createH01NativeGuard,
  h01GuardRequest,
  h01LegacyOverlayPlan,
  prepareH01LegacyOverlay,
} from './comparisonH01Guard.js';
import {
  createH01LegacyAdapter,
  runH01NativeSession,
  verifyH01LegacyOutcome,
} from './comparisonH01Legacy.js';

const provider = vi.hoisted(() => ({
  session: vi.fn(),
  alive: vi.fn(),
  reference: vi.fn(),
}));
vi.mock('../adapters/codex/currentChatHost.js', () => ({
  FileCurrentChatHost: class {
    reference = provider.reference;
  },
}));
vi.mock('../adapters/codex/comparisonSession.js', () => ({
  comparisonSession: provider.session,
}));
vi.mock('../adapters/codex/writerProcesses.js', () => ({
  NativeWriterProcesses: class {
    alive = provider.alive;
  },
}));
vi.mock('./comparisonH01Contract.js', async (original) => ({
  ...(await original<typeof ContractModule>()),
  verifyH01GuardAuthorization: vi.fn(async () => {}),
}));
let root: string, context: H01AttemptContext, accounting: H01NativeAccounting;
let sourceFixture: Awaited<ReturnType<typeof workflowFixture>> | undefined;
const record = (label: string, value: unknown) => h01Record(root, label, value);
beforeEach(() => {
  vi.resetAllMocks();
  sourceFixture = undefined;
  root = realpathSync(mkdtempSync(resolve(tmpdir(), 'h01-legacy-')));
  accounting = {
    participants: [],
    receipts: [],
    reservedManagedStarts: 0,
    observedResponses: 0,
    inputUncached: 0,
    inputCached: 0,
    output: 0,
    unknown: false,
    evidence: [],
  };
  const ref = record('pin', { raw: true });
  context = {
    opId: 'op',
    requestHash: 'a'.repeat(64),
    variant: 'baseline',
    material: {
      ref,
      value: {
        id: 'H-01',
        instructions: 'fix',
        files: {},
        mutable: ['range.mjs'],
      },
    },
    criteria: {
      ref,
      value: {
        id: 'H-01',
        task: 'fix',
        stimulus: ['boundary'],
        checks: ['validation'],
      },
    },
    roots: {
      workspaceRoot: resolve(root, 'case'),
      evidenceRoot: root,
      artifactRoot: resolve(root, 'artifacts'),
      hostRoot: resolve(root, 'host'),
      stateRoot: resolve(root, 'state'),
    },
    identity: { taskId: 'task', owner: 'owner', generation: 1 },
    profile: { model: 'pinned', effort: 'high', clientVersion: 'v' },
    binary: ref,
    rules: ref,
    executor: ref,
    reviewer: ref,
    runtime: { engine: 'legacy', root, files: [ref] },
    bootstrap: {
      engine: 'legacy',
      runtimeRoot: resolve(root, 'state/legacy-runtime'),
      modulesRoot: root,
      overlay: ref,
    },
    verifiedAuthorization: ref,
    budget: {
      maxManagedStarts: 5,
      maxElapsedMs: 60000,
      reserveMs: 1000,
      maxInputUncached: 1000,
      maxOutput: 100,
    },
    deadlineNs: String(process.hrtime.bigint() + 60000000000n),
    workDeadlineNs: String(process.hrtime.bigint() + 59000000000n),
    signal: new AbortController().signal,
    nativeObserver: {
      controlRef: ref,
      verify: vi.fn(),
      beforeModelStart: vi.fn(async () => {
        accounting.reservedManagedStarts = Number(accounting.reservedManagedStarts) + 1;
      }),
      confirmModelStart: vi.fn(),
      registerCreation: vi.fn(),
      registerCapabilities: vi.fn(),
      registerParticipant: vi.fn((p: H01NativeParticipant) => {
        accounting.participants.push(p);
      }),
      observeParticipant: vi.fn(),
      completeParticipant: vi.fn(),
      accounting: () => accounting,
    },
  };
  provider.alive.mockResolvedValue([]);
  provider.session.mockImplementation(
    async (
      request: ComparisonSessionRequest,
      _register: unknown,
      verify: () => Promise<void>,
      controls: ComparisonH01SessionControls,
    ) => {
      await verify();
      controls.modelProbe({ data: [{ model: 'pinned' }] });
      await controls.dispatch('mcpServerStatus/list', {}, async () => ({
        data: [],
        nextCursor: null,
      }));
      const thread = { id: 'native', path: resolve(root, 'native.jsonl') };
      await controls.dispatch('thread/start', {}, async () => ({
        thread,
        model: 'pinned',
        reasoningEffort: 'high',
      }));
      controls.createdParticipant({
        session: 'native',
        transcript: thread.path,
        run: 'op',
        stage: request.stage,
      });
      controls.observedParticipant({
        session: 'native',
        transcript: thread.path,
        run: 'op',
        stage: 'helper',
      });
      await controls.dispatch('thread/read', {}, async () => ({ thread }));
      await controls.dispatch('turn/start', { threadId: 'native' }, async () => ({
        turn: { id: 'turn' },
      }));
      const stop = record('native-stop', {
        kind: 'writers-stopped',
        owned: {
          runtime: { process: { pid: 5, parent: 1, started: 'fixture' } },
        },
        active_turn: false,
        remaining_terminals: 0,
        remaining_processes: 0,
        before_hash: 'same',
        after_hash: 'same',
        processes: [],
      });
      return {
        source: record('answer', { stopped: stop }),
        status: 'completed',
        text: 'answer',
      };
    },
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sourceFixture?.dispose();
  rmSync(root, { recursive: true, force: true });
});
async function legacyStore(withEvidence = false) {
  const f = await workflowFixture();
  sourceFixture = f;
  context.roots.workspaceRoot = f.root;
  context.profile.model = f.executor.spec.requested.model;
  context.profile.effort = f.executor.spec.requested.effort;
  const stateRoot = resolve(context.roots.stateRoot, 'legacy-task'),
    storeRoot = resolve(stateRoot, 'store');
  mkdirSync(stateRoot, { recursive: true });
  const project = 'h01-' + digest(context.opId).slice(0, 16),
    runId = 'chat-' + digest(stateRoot).slice(0, 20);
  f.connection.project_id = project;
  const cardText = (await f.cards.read(f.card.locator)).content.replace(
    'project_id: "project"',
    `project_id: "${project}"`,
  );
  await f.file(f.card.locator, cardText);
  const loadedCard = await f.cards.read(f.card.locator),
    run = structuredClone(f.executor);
  run.spec.project_id = project;
  run.spec.identity = {
    task_id: 'task',
    card: { locator: f.card.locator, hash: loadedCard.revision },
  };
  run.spec.session_id = 'native';
  run.spec.run_id = runId;
  run.spec.workspace = f.root;
  run.spec.scope = ['range.mjs'];
  run.spec.outcome = `${context.criteria.value.task}\n\n${context.material.value.instructions}`;
  f.target.scope = run.spec.outcome;
  const owner = 'export const contains = (value, min, max) => value >= min && value <= max;\n';
  await f.file('range.mjs', owner);
  f.target.inputs.inputs.splice(0, f.target.inputs.inputs.length, {
    locator: 'range.mjs',
    hash: digest(owner),
  });
  if (withEvidence)
    f.target.evidence_inputs = {
      ...f.target.inputs,
      inputs: [...f.target.inputs.inputs, f.proof],
    };
  for (const [path, ref] of [
    ['.comparison/RULES.md', context.rules],
    ['.comparison/executor.md', context.executor],
    ['.comparison/reviewer.md', context.reviewer],
  ] as const) {
    await f.file(path, h01ReadPin(ref).toString('utf8'));
    run.spec.rules.push({ locator: path, hash: ref.hash });
    run.spec.sources.push({ locator: path, hash: ref.hash });
  }
  run.loaded!.rules = run.spec.rules;
  run.loaded!.run_id = runId;
  run.loaded!.session_id = 'native';
  run.loaded!.observed_read = JSON.stringify([
    { locator: resolve(root, 'native.jsonl') + '#L1', hash: 'a'.repeat(64) },
  ]);
  let execution = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'validation' }],
    true,
    'substantial',
  );
  execution = applyExecution(
    execution,
    executionEvent(execution, { type: 'PLAN', council: f.council('planning') }),
  );
  execution = applyExecution(
    execution,
    executionEvent(execution, {
      type: 'REVIEW',
      target: f.target,
      selection: f.selection,
      baseline: {
        kind: 'real',
        scenario: 'provider fixture',
        evidence: f.proof,
        inputs: f.target.inputs,
        elapsed_ms: 1,
        exit_code: 0,
      },
      checks: [
        {
          id: 'validate',
          verdict: 'PASS',
          reason: 'provider fixture',
          evidence: f.proof,
          inputs: f.target.inputs,
        },
      ],
    }),
  );
  execution = applyExecution(
    execution,
    executionEvent(execution, {
      type: 'ACCEPT',
      council: f.council('acceptance'),
      findings: [],
    }),
  );
  const result = {
    scope: f.target.scope,
    target: f.target,
    evidence: [f.proof, f.target.diff],
    child_results: [],
    limitations: ['provider double'],
    summary: 'fixture result',
  };
  execution = applyExecution(execution, executionEvent(execution, { type: 'RESULT', result }));
  execution = applyExecution(execution, executionEvent(execution, { type: 'DONE' }));
  const completion = { criteria: ['validate', 'validation'], ...result };
  const plan = await f.cards.prepare(loadedCard, 'completed', 'fixture-finish', completion);
  const projectionResult = await f.cards.apply(plan);
  if (projectionResult.status !== 'confirmed') throw new Error('fixture projection');
  run.projection = { plan, result: projectionResult };
  run.spec.identity = {
    task_id: 'task',
    card: {
      locator: projectionResult.locator,
      hash: projectionResult.revision,
    },
  };
  const identity = {
    schema_version: evidenceSchema,
    project_id: project,
    task_id: 'task',
    subtask_id: null,
    run_id: runId,
    actor_id: 'native',
  };
  initializeStore(storeRoot, identity);
  const state: TechnicalState = {
    revision: 1,
    generation: 1,
    owner: 'native',
    lease_until: 0,
    released: false,
    frozen: false,
    checkpoint: {
      local_run: run,
      workflow: { schema_version: 1, revision: 5, execution, readings: {} },
    } as unknown as TechnicalState['checkpoint'],
  };
  const databasePath = resolve(storeRoot, 'store.sqlite');
  const save = () => {
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare('UPDATE state SET body=?').run(canonical(state));
      db.prepare('INSERT OR REPLACE INTO events VALUES (1,?)').run(
        canonical({
          revision: 1,
          operation_id: 'last-checkpoint',
          context: identity,
          change: { type: 'checkpoint' },
        }),
      );
      db.prepare('INSERT OR REPLACE INTO operations VALUES (?,?,?)').run(
        'last-checkpoint',
        'a'.repeat(64),
        canonical({
          operation_id: 'last-checkpoint',
          catalog_revision: 1,
          generation: 1,
        }),
      );
    } finally {
      db.close();
    }
  };
  save();
  const db = new DatabaseSync(databasePath);
  db.prepare('INSERT INTO effects VALUES (?,?)').run(
    'known',
    canonical({ id: 'known', outcome: 'confirmed', intent: {}, receipt: {} }),
  );
  db.close();
  accounting.participants.push({
    session: 'native',
    transcript: resolve(root, 'native.jsonl'),
    run: context.opId,
    stage: 'execution',
  });
  const nativeAnswer = record('actual-native-answer-fixture', {
    thread: 'native',
    turn: 'turn',
    status: 'completed',
    stopped: record('sqlite-native-stop', {
      kind: 'writers-stopped',
      owned: {
        runtime: { process: { pid: 5, parent: 1, started: 'fixture' } },
      },
      active_turn: false,
      remaining_terminals: 0,
      remaining_processes: 0,
      before_hash: 'same',
      after_hash: 'same',
      processes: [],
    }),
  });
  const sessionRoot = resolve(context.roots.evidenceRoot, 'legacy-session');
  mkdirSync(sessionRoot);
  writeFileSync(
    resolve(sessionRoot, 'session.json'),
    canonical({ session: { id: 'native' }, answer: nativeAnswer }),
  );
  return { state, run, execution, save, databasePath, nativeAnswer };
}
it('reads actual SQLite core RESULT/DONE and projection state without changing the Store', async () => {
  const f = await legacyStore(),
    before = digest(readFileSync(f.databasePath));
  const proof = await verifyH01LegacyOutcome(context);
  expect(h01ReadJson(proof)).toMatchObject({
    kind: 'h01-legacy-engine-result',
    opId: context.opId,
    requestHash: context.requestHash,
  });
  expect(digest(readFileSync(f.databasePath))).toBe(before);
  expect(provider.reference).toHaveBeenCalledOnce();
});
it('returns a completed legacy engine result only after its actual SQLite receipt chain verifies', async () => {
  const f = await legacyStore();
  provider.session.mockResolvedValueOnce({
    source: f.nativeAnswer,
    status: 'completed',
    text: 'real Store fixture; native provider double',
  });
  const result = await createH01LegacyAdapter().execute(context);
  expect(result.outcome).toBe('completed');
  expect(h01ReadJson(result.projection)).toMatchObject({
    kind: 'h01-legacy-engine-result',
  });
});
it('retains an ordinary failed native attempt without claiming a legacy completion', async () => {
  provider.session.mockRejectedValueOnce(new Error('native failure'));
  expect((await createH01LegacyAdapter().execute(context)).outcome).toBe('unknown');
});
it.each([false, true])(
  'checks the full optional evidence manifest, changed=%s',
  async (changed) => {
    await legacyStore(true);
    if (changed) await sourceFixture!.file('proof.txt', 'changed after DONE');
    const result = verifyH01LegacyOutcome(context);
    if (changed) await expect(result).rejects.toThrow('h01-legacy-evidence-stale');
    else await expect(result).resolves.toBeDefined();
  },
);
it.each([
  'task',
  'op',
  'generation',
  'workspace',
  'scope',
  'profile',
  'sources',
  'result',
  'history',
  'event',
  'projection',
  'hash',
  'owner',
  'baseline',
  'effects',
])('refuses wrong legacy %s rather than accepting an outer edit', async (kind) => {
  const f = await legacyStore();
  if (kind === 'task') context.identity.taskId = 'other';
  if (kind === 'op') context.opId = 'other';
  if (kind === 'generation') f.state.generation = 2;
  if (kind === 'workspace') f.run.spec.workspace = root;
  if (kind === 'scope') f.run.spec.scope = ['elsewhere'];
  if (kind === 'profile') f.run.spec.requested.model = 'other';
  if (kind === 'sources') f.run.spec.sources = [];
  if (kind === 'result') f.execution.status = 'review';
  if (kind === 'history') f.execution.history = [];
  if (kind === 'event') f.state.revision = 2;
  if (kind === 'projection') f.run.projection = null;
  if (kind === 'baseline') f.execution.baseline = null;
  f.save();
  if (kind === 'owner')
    await sourceFixture!.file(
      'range.mjs',
      'export const contains = (value, min, max) => value >= min && value <= max;\n// changed after DONE\n',
    );
  if (kind === 'effects') {
    const db = new DatabaseSync(f.databasePath);
    db.prepare('UPDATE effects SET body=?').run(canonical({ id: 'known', outcome: 'unknown' }));
    db.close();
  }
  if (kind === 'hash') {
    const checkpoint = f.state.checkpoint as unknown as {
      local_run: { spec: { assignment: InputRef } };
    };
    checkpoint.local_run.spec.assignment.hash = 'a'.repeat(64);
    f.save();
  }
  await expect(verifyH01LegacyOutcome(context)).rejects.toThrow();
});
it('does not mistake a completed outer native edit for a real legacy engine result', async () => {
  const result = await createH01LegacyAdapter().execute(context);
  expect(result).toMatchObject({ outcome: 'unknown', nativeAcceptance: null });
  expect(context.nativeObserver.beforeModelStart).toHaveBeenCalledWith(
    expect.objectContaining({
      origin: 'legacy',
      stage: 'execution',
      session: 'native',
    }),
  );
  expect(context.nativeObserver.confirmModelStart).toHaveBeenCalledWith(
    expect.objectContaining({ turn: 'turn' }),
  );
  expect(context.nativeObserver.observeParticipant).toHaveBeenLastCalledWith(
    expect.objectContaining({ stage: 'execution' }),
  );
  expect(context.nativeObserver.completeParticipant).toHaveBeenCalledWith(
    'native',
    expect.objectContaining({ outcome: 'completed', stop: result.stop }),
  );
  expect(h01ReadJson(result.stop)).toMatchObject({
    confirmed: true,
    sessions: ['native'],
  });
  expect(provider.session.mock.calls[0]![0]).toMatchObject({
    binary: context.binary.locator,
    run: 'op',
    operation: 'h01-v2:op:execution',
    h01_control: context.nativeObserver.controlRef,
  });
});
it('uses the same production session seam read-only for common independent council', async () => {
  const result = await runH01NativeSession(context, 'council', 'inspect only');
  expect(result.nativeAcceptance).not.toBeNull();
  expect(context.nativeObserver.beforeModelStart).toHaveBeenCalledWith(
    expect.objectContaining({ origin: 'common-council', stage: 'council' }),
  );
  expect(provider.session.mock.calls[0]![0]).toMatchObject({ read_only: true });
});
it('forwards the explicit MCP deny targets to both common session and capability registration', async () => {
  const disabled = ['local_tools-1', 'Docs2'];
  Object.assign(context, { disabledMcpServers: disabled });
  await runH01NativeSession(context, 'council', 'inspect only');
  expect(provider.session.mock.calls[0]![0]).toMatchObject({
    disabled_mcp_servers: disabled,
  });
  expect(context.nativeObserver.registerCapabilities).toHaveBeenCalledWith(
    expect.objectContaining({ session: 'native', disabled }),
  );
  const effective = object(provider.session.mock.calls[0]![0]).disabled_mcp_servers;
  expect(effective).not.toBe(disabled);
  expect(vi.mocked(context.nativeObserver.registerCapabilities).mock.calls[0]![0].disabled).toBe(
    effective,
  );
});
it('keeps one effective MCP list when the context array changes during asynchronous verification', async () => {
  const targets = ['local_tools-1'];
  context.disabledMcpServers = targets;
  vi.mocked(context.nativeObserver.verify).mockImplementationOnce(async () => {
    targets.push('late-context-target');
  });
  const result = await runH01NativeSession(context, 'council', 'inspect only');
  expect(result.outcome).toBe('completed');
  expect(targets).toEqual(['local_tools-1', 'late-context-target']);
  const effective = object(provider.session.mock.calls[0]![0]).disabled_mcp_servers;
  expect(effective).toEqual(['local_tools-1']);
  expect(effective).not.toBe(targets);
  expect(vi.mocked(context.nativeObserver.registerCapabilities).mock.calls[0]![0].disabled).toBe(
    effective,
  );
});
it('retains the full MCP observation before an initial capability refusal without a new model start', async () => {
  const params = { limit: 100, detail: 'toolsAndAuthOnly' };
  const response = {
    data: [{ name: 'unexpected', tools: { external: {} } }],
    nextCursor: null,
  };
  provider.session.mockImplementationOnce(
    async (_r: unknown, _g: unknown, _v: unknown, controls: ComparisonH01SessionControls) => {
      await controls.dispatch('mcpServerStatus/list', params, async () => response);
      throw new Error('coder-external-tools-enabled');
    },
  );
  const result = await runH01NativeSession(context, 'council', 'inspect only');
  expect(result.outcome).toBe('unknown');
  expect(result.evidence.map(h01ReadJson)).toContainEqual({
    kind: 'h01-native-dispatch',
    method: 'mcpServerStatus/list',
    params,
    response,
  });
  expect(context.nativeObserver.beforeModelStart).not.toHaveBeenCalled();
  expect(context.nativeObserver.registerCreation).not.toHaveBeenCalled();
  expect(context.nativeObserver.registerCapabilities).not.toHaveBeenCalled();
});
it('does not send a turn when cancellation arrives during the asynchronous budget/authority gate', async () => {
  const controller = new AbortController();
  context.signal = controller.signal;
  vi.mocked(context.nativeObserver.beforeModelStart).mockImplementationOnce(async () => {
    await Promise.resolve();
    controller.abort(new Error('deferred cancel'));
  });
  const send = vi.fn();
  provider.session.mockImplementationOnce(
    async (_r: unknown, _g: unknown, _v: unknown, controls: ComparisonH01SessionControls) =>
      controls.dispatch('turn/start', { threadId: 'native' }, send),
  );
  expect((await runH01NativeSession(context, 'execution', 'task')).outcome).toBe('unknown');
  expect(send).not.toHaveBeenCalled();
});
it('keeps existing participant stage authoritative and does not enroll unexpected discovery', async () => {
  accounting.participants.push({
    session: 'old',
    transcript: '/old',
    stage: 'execution',
    run: 'op',
  });
  const original = provider.session.getMockImplementation()! as (
    ...args: unknown[]
  ) => Promise<unknown>;
  provider.session.mockImplementationOnce(
    async (request, register, verify, controls: ComparisonH01SessionControls) => {
      controls.observedParticipant({
        session: 'new-unexpected',
        transcript: '/unexpected',
        stage: 'helper',
        run: 'op',
      });
      expect(context.nativeObserver.observeParticipant).toHaveBeenLastCalledWith(
        expect.objectContaining({ stage: 'helper', session: 'new-unexpected' }),
      );
      return original(request, register, verify, controls);
    },
  );
  await runH01NativeSession(context, 'execution', 'task');
  expect(accounting.participants.some((p) => p.session === 'new-unexpected')).toBe(false);
});
it('refuses uncontrolled registration and preserves an empty failed state/non-error cause', async () => {
  provider.session.mockImplementationOnce(
    async (request: ComparisonSessionRequest, register: () => void) => {
      mkdirSync(request.directory);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(resolve(request.directory, 'session.json'), '{"runtime":null}');
      try {
        register();
      } catch {
        throw 'uncontrolled';
      }
    },
  );
  expect((await runH01NativeSession(context, 'execution', 'task')).outcome).toBe('unknown');
});
it('preserves a primary failed answer after confirmed stop without treating it as completion', async () => {
  const original = provider.session.getMockImplementation()! as (
    ...args: unknown[]
  ) => Promise<Record<string, unknown>>;
  provider.session.mockImplementationOnce(async (...args: unknown[]) => ({
    ...(await original(...args)),
    status: 'failed',
  }));
  expect((await runH01NativeSession(context, 'execution', 'task')).outcome).toBe('failed');
});
it('handles delayed primary path and refuses invented participants/capabilities', async () => {
  provider.session.mockImplementationOnce(
    async (_r: unknown, _g: unknown, _v: unknown, controls: ComparisonH01SessionControls) => {
      await controls.dispatch('mcpServerStatus/list', {}, async () => ({
        data: [],
      }));
      await controls.dispatch('thread/start', {}, async () => ({
        thread: { id: 'native', path: null },
      }));
      expect(context.nativeObserver.registerParticipant).not.toHaveBeenCalled();
      await controls.dispatch('thread/read', {}, async () => ({
        thread: { id: 'native', path: resolve(root, 'native.jsonl') },
      }));
      expect(
        vi.mocked(context.nativeObserver.registerParticipant).mock.calls[0]![0].pathObservation,
      ).toBeDefined();
      await controls.dispatch('thread/read', {}, async () => ({
        thread: { id: 'other', path: '/invented' },
      }));
    },
  );
  expect((await runH01NativeSession(context, 'execution', 'task')).outcome).toBe('unknown');
});
it('refuses a missing MCP probe before any model credit', async () => {
  provider.session.mockImplementationOnce(
    async (_r: unknown, _g: unknown, _v: unknown, controls: ComparisonH01SessionControls) => {
      await controls.dispatch('thread/start', {}, async () => ({
        thread: { id: 'native' },
      }));
    },
  );
  expect((await runH01NativeSession(context, 'execution', 'task')).outcome).toBe('unknown');
  expect(context.nativeObserver.beforeModelStart).not.toHaveBeenCalled();
});
it('does not treat live OS processes or incomplete stop proof as completed', async () => {
  provider.alive.mockResolvedValueOnce([{ pid: 5 }]);
  expect((await runH01NativeSession(context, 'execution', 'task')).outcome).toBe('unknown');
});
it('does not clear unknown accounting with a successful primary answer', async () => {
  accounting.unknown = true;
  expect((await runH01NativeSession(context, 'execution', 'task')).outcome).toBe('unknown');
});
it.each(['failed', 'no-state', 'live', 'observer-error'])(
  'retains failed native state %s without retrying a send',
  async (mode) => {
    provider.session.mockImplementationOnce(async (request: ComparisonSessionRequest) => {
      if (mode !== 'no-state') {
        mkdirSync(request.directory);
        const ref = record('runtime-state', {
          runtime: { process: { pid: 5 } },
        });
        const { copyFileSync } = await import('node:fs');
        copyFileSync(ref.locator, resolve(request.directory, 'session.json'));
      }
      if (mode === 'live') provider.alive.mockResolvedValueOnce([{ pid: 5 }]);
      if (mode === 'observer-error')
        provider.alive.mockRejectedValueOnce(new Error('observer unknown'));
      throw new Error('failed before first model');
    });
    const result = await runH01NativeSession(context, 'execution', 'task');
    expect(result.outcome).toBe(mode === 'failed' ? 'failed' : 'unknown');
    expect(provider.session).toHaveBeenCalledOnce();
  },
);
it('refuses changed variant/runtime root/binary and an aborted model dispatch', async () => {
  context.variant = 'candidate';
  await expect(createH01LegacyAdapter().execute(context)).rejects.toThrow('h01-legacy-engine');
  context.variant = 'baseline';
  context.bootstrap = {
    ...context.bootstrap,
    engine: 'legacy',
    runtimeRoot: '/outside',
  } as typeof context.bootstrap;
  await expect(createH01LegacyAdapter().execute(context)).rejects.toThrow(
    'h01-legacy-runtime-scope',
  );
  context.bootstrap = {
    engine: 'legacy',
    runtimeRoot: resolve(root, 'state/legacy-runtime'),
    modulesRoot: root,
    overlay: context.material.ref,
  };
  context.binary.hash = 'b'.repeat(64);
  await expect(createH01LegacyAdapter().execute(context)).rejects.toThrow('h01-pin-changed');
});

it('composes REAL guard/legacy/overlay: acknowledged parent without usage may dispatch a nested role, then final raw usage becomes known', async () => {
  // Only native RPC/OS providers and primary authority are doubles; ledger, overlay, accounting and adapter are real.
  for (const name of ['workspaceRoot', 'artifactRoot', 'hostRoot', 'stateRoot'] as const)
    mkdirSync(context.roots[name], { recursive: true });
  context.roots.evidenceRoot = resolve(root, 'evidence');
  mkdirSync(context.roots.evidenceRoot);
  const plan = h01LegacyOverlayPlan(),
    runtimeRoot = resolve(context.roots.stateRoot, 'legacy-runtime');
  mkdirSync(runtimeRoot);
  const source = resolve(import.meta.dirname, '..');
  for (const entry of plan.sources) {
    const target = resolve(runtimeRoot, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    const fixturePath =
      entry.path === 'cli/taskChatCouncil.ts'
        ? 'tests/temporal/fixtures/h01-legacy-task-chat-council.snapshot'
        : entry.path;
    copyFileSync(resolve(source, fixturePath), target);
  }
  const profile = record('real-profile', {
    ...context.profile,
    binary: context.binary,
    rules: context.rules,
    executor: context.executor,
    reviewer: context.reviewer,
  });
  const overlay = record('real-overlay-plan', plan);
  const request: H01ExecutionRequest = {
    kind: 'comparison-h01-execution',
    executionVersion: 2,
    opId: 'op',
    variant: 'baseline',
    material: context.material.ref,
    criteria: context.criteria.ref,
    profile,
    runtime: record('real-runtime', context.runtime),
    bootstrap: record('real-bootstrap', {
      engine: 'legacy',
      runtimeRoot,
      modulesRoot: root,
      overlay,
    }),
    roots: context.roots,
    identity: context.identity,
    budget: context.budget,
    authorization: {
      root,
      transcript: resolve(root, 'primary.jsonl'),
      anchor: {
        thread_id: 'primary',
        turn_id: 'turn',
        workspace: root,
        host_id: 'local',
      },
      source: {
        locator: resolve(root, 'primary.jsonl') + '#L1',
        hash: 'a'.repeat(64),
      },
      requestHash: '',
    },
  };
  request.authorization.requestHash = h01RequestHash(request);
  const start = process.hrtime.bigint();
  const descriptor: H01GuardDescriptor = {
    kind: 'comparison-h01-guard',
    executionVersion: 2,
    opId: 'op',
    requestHash: h01RequestHash(request),
    request: record('real-request', request),
    variant: 'baseline',
    roots: context.roots,
    budget: context.budget,
    profile: context.profile,
    binary: context.binary,
    authorization: request.authorization,
    pins: [profile],
    startedNs: String(start),
    deadlineNs: String(start + 60000000000n),
    workDeadlineNs: String(start + 59000000000n),
  };
  const controlRef = record('real-descriptor', descriptor);
  writeFileSync(
    resolve(runtimeRoot, '.comparison-h01-owner.json'),
    canonical({
      kind: 'comparison-h01-runtime-owner',
      opId: 'op',
      requestHash: descriptor.requestHash,
      controlRef,
    }),
  );
  prepareH01LegacyOverlay(runtimeRoot, controlRef);
  context.nativeObserver = createH01NativeGuard(controlRef);
  context.bootstrap = {
    engine: 'legacy',
    runtimeRoot,
    modulesRoot: root,
    overlay,
  };
  const transcript = (session: string, withUsage: boolean) => {
    const rows: unknown[] = [{ type: 'session_meta', payload: { id: session } }];
    if (withUsage)
      rows.push({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
            },
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
            },
          },
        },
      });
    writeFileSync(
      resolve(root, session + '.jsonl'),
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
  };
  const thread = (id: string) => ({
    thread: { id, path: resolve(root, id + '.jsonl'), turns: [] },
    model: context.profile.model,
    reasoningEffort: context.profile.effort,
  });
  provider.session.mockImplementationOnce(
    async (
      _r: unknown,
      _g: unknown,
      verify: () => Promise<void>,
      controls: ComparisonH01SessionControls,
    ) => {
      await verify();
      transcript('native', false);
      transcript('nested', false);
      await controls.dispatch('mcpServerStatus/list', {}, async () => ({
        data: [],
      }));
      await controls.dispatch('thread/start', {}, async () => thread('native'));
      await controls.dispatch('turn/start', { threadId: 'native' }, async () => ({
        turn: { id: 'parent-turn' },
      }));
      expect(context.nativeObserver.accounting()).toMatchObject({
        reservedManagedStarts: 1,
        inputUncached: null,
        unknown: true,
      });
      await context.nativeObserver.verify();
      await h01GuardRequest(context.nativeObserver, 'council', 'thread/start', {}, async () =>
        thread('nested'),
      );
      await h01GuardRequest(
        context.nativeObserver,
        'council',
        'turn/start',
        { threadId: 'nested' },
        async () => ({ turn: { id: 'nested-turn' } }),
        { disabled: [], request: async () => ({ data: [] }) },
      );
      expect(context.nativeObserver.accounting().reservedManagedStarts).toBe(2);
      transcript('nested', true);
      transcript('native', true);
      const stopped = record('composed-native-stop', {
        kind: 'writers-stopped',
        owned: {
          runtime: { process: { pid: 5, parent: 1, started: 'fixture' } },
        },
        active_turn: false,
        remaining_terminals: 0,
        remaining_processes: 0,
        before_hash: 'same',
        after_hash: 'same',
        processes: [],
      });
      return {
        source: record('composed-answer', { stopped }),
        status: 'completed',
        text: 'primary answer',
      };
    },
  );
  let result;
  try {
    result = await runH01NativeSession(
      context,
      'execution',
      'composed fixture; no actual qualification',
    );
  } catch (error) {
    const { readdirSync } = await import('node:fs');
    const failure = readdirSync(context.roots.evidenceRoot).find((name) =>
      name.startsWith('legacy-failure-'),
    );
    if (failure)
      throw new Error(readFileSync(resolve(context.roots.evidenceRoot, failure), 'utf8'), {
        cause: error,
      });
    throw error;
  }
  expect(result.outcome).toBe('completed');
  expect(context.nativeObserver.accounting()).toMatchObject({
    reservedManagedStarts: 2,
    observedResponses: 2,
    inputUncached: 20,
    output: 10,
    unknown: false,
  });
  const generated = readFileSync(
    resolve(runtimeRoot, 'adapters/codex/appServerTransport.ts'),
    'utf8',
  );
  expect(generated).toContain(controlRef.hash);
  expect(digest(generated)).not.toBe(plan.sources[0]!.hash);
});
