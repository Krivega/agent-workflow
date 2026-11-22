import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import type { openNativeCoderSessions } from '../cli/nativeCoderSessions.js';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import type { CoderBrief, CoderRun } from '../core/coder.js';
import {
  runH06NativeLegacyCompletion,
  runH06NativeLegacyTransportPhase,
} from './comparisonH06NativeLegacyTransportPhase.js';
import type { runH06NativeLegacyWriterPhase } from './comparisonH06NativeLegacyWriterPhase.js';

type PhaseRuntime = Parameters<typeof runH06NativeLegacyWriterPhase>[1];
type OpenOptions = Parameters<typeof openNativeCoderSessions>[0];

const ops = vi.hoisted(() => ({
  claim: vi.fn(),
  lock: vi.fn(),
  bind: vi.fn(),
  parent: vi.fn(),
  coders: vi.fn(),
  workspace: vi.fn(),
  verifyCopy: vi.fn(),
  authorizeParent: vi.fn(),
  budget: vi.fn(),
  factory: vi.fn(),
  phase: vi.fn(),
  descendants: vi.fn(),
  alive: vi.fn(),
  wait: vi.fn(),
  brief: vi.fn(),
  integrated: vi.fn(),
  cancel: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  integrate: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('./comparisonH06NativeAttempt.js', () => ({ readH06NativeAttemptForReopen: ops.claim }));
vi.mock('../adapters/storage/chatWriter.js', () => ({
  withChatWriter: ops.lock,
  bindChatEvidence: ops.bind,
}));
vi.mock('../adapters/storage/localRunStores.js', () => ({
  TaskLocalRuns: class {
    constructor(private readonly persistence: { execute(value: unknown): Promise<unknown> }) {}
    async read(): Promise<unknown> {
      await this.persistence.execute('parent read');
      return ops.parent();
    }
  },
}));
vi.mock('../adapters/storage/workflowJournal.js', () => ({
  TaskWorkflowJournal: class {
    read = ops.coders;
  },
}));
vi.mock('../adapters/project/coderWorkspaces.js', () => ({
  FileCoderWorkspaces: class {
    constructor(source: string, evidence: string, authorize: unknown) {
      ops.workspace(source, evidence, authorize);
    }
    verifyCopy = ops.verifyCopy;
  },
}));
vi.mock('../core/coder.js', () => ({
  assertCoderParent: ops.authorizeParent,
  validateCoderBrief: ops.brief,
  validateCoderRun: ops.integrated,
}));
vi.mock('../application/coderWorkflow.js', () => ({
  cancelCoder: ops.cancel,
  startCoder: ops.start,
  runCoder: ops.complete,
  integrateCoder: ops.integrate,
}));
vi.mock('./comparisonH06NativeLegacyDispatch.js', () => ({
  captureH06NativeLegacyCompletedThread: ops.capture,
}));
vi.mock('./comparisonH06NativeLegacyBudget.js', () => ({ openH06NativeLegacyBudget: ops.budget }));
vi.mock('../cli/nativeCoderSessions.js', () => ({ openNativeCoderSessions: ops.factory }));
vi.mock('./comparisonH06NativeLegacyWriterPhase.js', () => ({
  runH06NativeLegacyWriterPhase: ops.phase,
}));
vi.mock('../adapters/codex/writerProcesses.js', () => ({
  NativeWriterProcesses: class {
    descendants = ops.descendants;
    alive = ops.alive;
    wait = ops.wait;
  },
}));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(phase: 'warm' | 'cold' = 'warm') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'h06-legacy-transport-phase-')));
  roots.push(root);
  vi.stubEnv('CODEX_THREAD_ID', 'actor');
  const pin = (name: string, value: unknown) => {
    const path = join(root, name);
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const receipt = pin('attempt-claim.json', {});
  const appServer = pin('codex', {});
  const previous = { thread: { id: 'warm' } };
  const warmThread = pin('legacy-warm-writer-thread.json', previous);
  const current = { thread: { id: 'current' } };
  const context = { actor_id: 'actor' };
  const state = {
    owner: 'actor',
    checkpoint: {} as object | null,
    frozen: false,
    released: false,
    lease_until: Date.now() + 60_000,
    generation: 1,
  };
  const store = {
    grant: { context },
    root: join(root, 'legacy-store'),
    execute: vi.fn(() => ({ ok: true, value: state })),
  };
  const claim = {
    receipt,
    request: {
      binding: { variant: 'legacy', workspaceRoot: join(root, 'material') },
      evidenceRoot: root,
      appServer,
      bootstrap: pin('bootstrap.json', { disabledMcpServers: ['one'] }),
    },
    workDeadlineMs: Date.now() + 15_000,
    stopDeadlineMs: Date.now() + 20_000,
  };
  const coderRun = {
    brief: { id: 'writer', copy_root: join(root, 'copy') },
    status: 'reserved',
  } as CoderRun;
  const input = {
    claim: receipt,
    started: pin('legacy-operator-start.json', {}),
    brief: pin('brief.json', {}),
    previousResume: null,
    phase,
  };
  const options = {
    store: store as unknown as PhaseRuntime['store'],
    awaitPause: vi.fn<PhaseRuntime['awaitPause']>(),
    warmThread: phase === 'warm' ? null : warmThread,
  };
  const processIdentity = { pid: 70_001, parent: process.pid, started: 'spawned' };
  const raw = {
    pid: processIdentity.pid as number | undefined,
    request: vi.fn(async () => current),
    completed: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const managed = { request: vi.fn(async () => ({ managed: true })) };
  const budget = {
    wrap: vi.fn(
      (_raw: unknown, _options: { readUsage(ledger: unknown): Promise<unknown> }) => managed,
    ),
    readUsage:
      vi.fn<
        (
          ledger: unknown,
          observe: (scope: { journal: string; session: string }) => unknown,
        ) => Promise<unknown>
      >(),
    runWithinWork: vi.fn(),
    stop: vi.fn(async (cleanup: () => Promise<void>) => cleanup()),
  };
  const sessions = {
    create: vi.fn(),
    recoverCreate: vi.fn(),
    load: vi.fn(),
    send: vi.fn(),
    result: vi.fn(),
    stop: vi.fn(),
    observeLiveWriter: vi.fn(),
  };
  const verify = vi.fn();
  const parent = { kind: 'owner' };
  ops.claim.mockReturnValue(claim);
  ops.lock.mockImplementation(async (_path, run: () => Promise<unknown>) => run());
  ops.bind.mockReturnValue(verify);
  ops.parent.mockResolvedValue(parent);
  ops.coders.mockResolvedValue({ coders: { writer: coderRun } });
  ops.budget.mockReturnValue(budget);
  ops.descendants.mockResolvedValue([processIdentity]);
  ops.alive.mockResolvedValue([]);
  ops.factory.mockImplementation(async ({ adopt }: OpenOptions) => {
    adopt(raw as unknown as Parameters<OpenOptions['adopt']>[0]);
    return sessions;
  });
  const run = () => runH06NativeLegacyTransportPhase(input, options);
  return {
    root,
    claim,
    coderRun,
    input,
    options,
    run,
    raw,
    managed,
    budget,
    state,
    store,
    processIdentity,
    previous,
    current,
    parent,
    verify,
    sessions,
    warmThread,
    pin,
  };
}

it.each(['warm', 'cold'] as const)(
  'binds %s to its budget and closes the owned transport',
  async (phase) => {
    const f = fixture(phase);
    const journal = join(f.root, 'coders', 'writer', 'transport.jsonl');
    const snapshot = { used: 1 };
    ops.alive.mockResolvedValueOnce([f.processIdentity]);
    f.budget.readUsage.mockImplementation(async (_ledger, observe) => [
      await observe({ journal, session: 'current' }),
      await observe({ journal: 'previous', session: 'warm' }),
    ]);
    ops.phase.mockImplementation(async (_input, runtime: PhaseRuntime) => {
      expect(runtime.store).toBe(f.store);
      expect(runtime.awaitPause).toBe(f.options.awaitPause);
      expect(runtime.runWithinWork).toBe(f.budget.runWithinWork);
      await runtime.coder.sessions.create(f.coderRun);
      await runtime.coder.sessions.recoverCreate(f.coderRun);
      await runtime.coder.sessions.load(f.coderRun, true);
      await runtime.coder.sessions.send(f.coderRun, true);
      await runtime.coder.sessions.result(f.coderRun);
      await runtime.coder.sessions.stop(f.coderRun);
      await runtime.coder.sessions.observeLiveWriter(f.coderRun);
      await expect(runtime.rpc.request('thread/read', {})).resolves.toEqual({ managed: true });
      const factory = ops.factory.mock.calls[0]![0] as OpenOptions;
      expect(factory.expectedDisabledMcpServers).toEqual(['one']);
      expect(factory.inventoryTimeoutMs).toBeGreaterThan(0);
      factory.beforeSpawn?.();
      await factory.authorize(f.coderRun);
      await factory.verifyCopy(f.coderRun);
      ops.coders.mockResolvedValueOnce({});
      const authorize = ops.workspace.mock.calls[0]![2] as (
        brief: CoderBrief,
        phase: CoderRun['status'] | null,
      ) => Promise<void>;
      await authorize(f.coderRun.brief, null);
      const { readUsage } = f.budget.wrap.mock.calls[0]![1];
      await expect(readUsage(snapshot)).resolves.toEqual([
        f.current,
        phase === 'warm' ? null : f.previous,
      ]);
      await runtime.stop(runtime.closeOwned);
      return { phase };
    });
    await expect(f.run()).resolves.toEqual({ phase });
    expect(ops.lock).toHaveBeenCalledWith(f.store.root, expect.any(Function));
    expect(ops.bind).toHaveBeenCalledWith(f.store.root, f.root, f.state);
    expect(ops.budget).toHaveBeenCalledWith(f.claim, phase === 'warm' ? 'create' : 'reopen');
    expect(ops.factory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        run: f.coderRun,
        binary: f.claim.request.appServer.path,
        journal,
      }),
    );
    expect(f.budget.wrap).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        root: f.coderRun.brief.copy_root,
        journal,
      }),
    );
    for (const action of Object.values(f.sessions)) expect(action).toHaveBeenCalledOnce();
    expect(ops.authorizeParent).toHaveBeenCalledWith(f.parent, f.coderRun.brief);
    expect(f.verify).toHaveBeenCalled();
    expect(f.store.execute).toHaveBeenCalledWith('parent read');
    expect(ops.verifyCopy).toHaveBeenCalledWith(f.coderRun);
    expect(f.raw.request).toHaveBeenCalledWith('thread/read', {
      threadId: 'current',
      includeTurns: false,
    });
    expect(f.raw.close).toHaveBeenCalledOnce();
    expect(ops.descendants).toHaveBeenCalledWith([f.processIdentity.pid]);
    expect(ops.wait).toHaveBeenCalledWith(25);
  },
);

it('rejects a wrong actor, previous thread or Store state before dispatch', async () => {
  const f = fixture();
  vi.stubEnv('CODEX_THREAD_ID', 'other');
  await expect(f.run()).rejects.toThrow('h06-legacy-transport-binding');
  vi.stubEnv('CODEX_THREAD_ID', 'actor');
  f.options.warmThread = f.warmThread;
  await expect(f.run()).rejects.toThrow('h06-legacy-transport-binding');
  f.options.warmThread = null;
  f.state.frozen = true;
  await expect(f.run()).rejects.toThrow('h06-legacy-transport-store');
  expect(ops.phase).not.toHaveBeenCalled();
  expect(ops.factory).not.toHaveBeenCalled();
});

it('refuses RPC before adoption and does not open a transport after the work deadline', async () => {
  const f = fixture();
  f.claim.workDeadlineMs = Date.now() - 1;
  ops.phase.mockImplementation(async (_input, runtime: PhaseRuntime) => {
    expect(() => runtime.rpc.request('thread/read', {})).toThrow('h06-legacy-transport-not-open');
    try {
      return await runtime.coder.sessions.create(f.coderRun);
    } finally {
      await runtime.stop(runtime.closeOwned);
    }
  });
  await expect(f.run()).rejects.toThrow('h06-legacy-budget-work');
  expect(ops.factory).not.toHaveBeenCalled();
  expect(f.raw.close).not.toHaveBeenCalled();
});

it('closes an adopted process when initialization rejects, retaining the initialization error', async () => {
  const f = fixture();
  ops.factory.mockImplementation(async ({ adopt }: OpenOptions) => {
    adopt(f.raw as unknown as Parameters<OpenOptions['adopt']>[0]);
    throw new Error('initialization failed');
  });
  ops.phase.mockImplementation(async (_input, runtime: PhaseRuntime) => {
    try {
      return await runtime.coder.sessions.create(f.coderRun);
    } finally {
      await runtime.stop(runtime.closeOwned);
    }
  });
  await expect(f.run()).rejects.toThrow('initialization failed');
  expect(f.raw.close).toHaveBeenCalledOnce();
});

it.each(['unowned', 'deadline'] as const)(
  'cannot confirm STOP after %s, and still closes the transport',
  async (failure) => {
    const f = fixture();
    if (failure === 'unowned')
      ops.descendants.mockResolvedValue([{ ...f.processIdentity, parent: 1 }]);
    if (failure === 'deadline') {
      ops.alive.mockResolvedValue([f.processIdentity]);
      f.claim.stopDeadlineMs = Date.now() - 1;
    }
    ops.phase.mockImplementation(async (_input, runtime: PhaseRuntime) => {
      await runtime.coder.sessions.create(f.coderRun);
      await runtime.stop(runtime.closeOwned);
    });
    await expect(f.run()).rejects.toThrow(
      failure === 'unowned'
        ? 'h06-legacy-transport-owner'
        : 'h06-legacy-transport-stop-unconfirmed',
    );
    expect(f.raw.close).toHaveBeenCalledOnce();
  },
);

it('closes the raw transport when process observation never returns before the stop deadline', async () => {
  const f = fixture();
  ops.descendants.mockImplementation(async () => new Promise(() => {}));
  ops.phase.mockImplementation(async (_input, runtime: PhaseRuntime) => {
    await runtime.coder.sessions.create(f.coderRun);
    vi.spyOn(Date, 'now').mockReturnValueOnce(f.claim.stopDeadlineMs - 10);
    await runtime.stop(runtime.closeOwned);
  });
  await expect(f.run()).rejects.toThrow('h06-legacy-transport-stop-unconfirmed');
  expect(f.raw.close).toHaveBeenCalledOnce();
  expect(ops.alive).not.toHaveBeenCalled();
});

function completionFixture() {
  const f = fixture('cold');
  const context = {
    ...f.store.grant.context,
    project_id: 'project',
    task_id: 'operation',
    run_id: 'run',
  };
  Object.assign(f.store.grant.context, context);
  const binding = { ...f.claim.request.binding, operationId: 'operation' };
  const bootstrap = f.pin('bootstrap.json', {});
  const brief = {
    id: 'completion',
    project_id: context.project_id,
    task_id: context.task_id,
    parent_run_id: context.run_id,
    parent_session_id: context.actor_id,
    source_root: binding.workspaceRoot,
    copy_root: join(f.root, 'coder-workspaces', 'completion'),
    generation: 1,
  };
  const briefPin = f.pin('completion.json', brief);
  ops.claim.mockReturnValue({
    ...f.claim,
    request: { ...f.claim.request, binding, runtime: [briefPin], bootstrap },
  });
  const identity = {
    context,
    store: f.store.root,
    workspace: binding.workspaceRoot,
    evidence: f.root,
  };
  const started = f.pin('legacy-operator-start.json', {
    kind: 'h06-native-legacy-operator-start',
    claim: f.claim.receipt,
    context,
    bootstrap,
    generation: 1,
  });
  const previous = { brief: { id: 'cold-writer' }, status: 'running', session: { id: 'cold' } };
  mkdirSync(join(f.root, 'coders', 'cold-writer'), { recursive: true, mode: 0o700 });
  const stoppedPin = f.pin('coders/cold-writer/stopped.json', {
    kind: 'writers-stopped',
    thread: 'cold',
    active_turn: false,
    remaining_processes: 0,
    remaining_terminals: 0,
    before_hash: 'before',
    after_hash: 'before',
  });
  const stopped = { locator: stoppedPin.path, hash: stoppedPin.sha256 };
  const stopIntent = f.pin('legacy-cold-writer-stop-intent.json', {
    kind: 'h06-native-legacy-writer-stop-intent',
    phase: 'cold',
    identity,
    coder: previous,
  });
  const stoppedBy = f.pin('legacy-cold-writer-stop.json', {
    kind: 'h06-native-legacy-writer-stop',
    phase: 'cold',
    identity,
    stopped,
    intent: stopIntent,
    coderId: previous.brief.id,
  });
  const event = { id: 'cold-resume', type: 'RESUME', generation: 1, thread_id: 'actor', stopped };
  const control = { status: 'active', history: [{ id: event.id, payload: JSON.stringify(event) }] };
  const ack = { catalog_revision: 12, operation_id: 'chat:control:cold-resume' };
  const intent = f.pin('legacy-cold-resume-intent.json', { identity, event, stoppedBy });
  const resume = {
    kind: 'h06-native-legacy-resume',
    phase: 'cold',
    identity,
    operation: 'chat:control:cold-resume',
    event,
    intent,
    ack,
    control,
  };
  const coldResume = f.pin('legacy-cold-resume.json', resume);
  const coldThread = f.pin('legacy-cold-writer-thread.json', { thread: { id: 'cold' } });
  const input = {
    claim: f.claim.receipt,
    started,
    brief: briefPin,
    coldResume,
    warmThread: f.warmThread,
    coldThread,
  };
  const integrated = { brief, status: 'integrated' };
  const thread = f.pin('legacy-completion-writer-thread.json', {});
  const store = {
    ...f.store,
    execute(value: { command: { type: string } }) {
      return {
        ok: true,
        value:
          value.command.type === 'operation'
            ? { status: 'confirmed', ack }
            : { ...f.state, revision: 12, checkpoint: { chat_control: control } },
      };
    },
  };
  const options = {
    store: store as unknown as PhaseRuntime['store'],
    signal: new AbortController().signal,
  };
  f.budget.runWithinWork.mockImplementation(
    async (work: (signal: AbortSignal) => Promise<unknown>) => work(new AbortController().signal),
  );
  ops.coders.mockResolvedValue({ coders: { [previous.brief.id]: previous } });
  ops.cancel.mockImplementation(
    async (_id, deps: { sessions: { stop: (run: unknown) => Promise<unknown> } }) => {
      expect(await deps.sessions.stop(previous)).toEqual(stopped);
      return { status: 'cancelled' };
    },
  );
  ops.complete.mockImplementation(
    async (_id, deps: { sessions: { create: (run: CoderRun) => Promise<unknown> } }) => {
      await deps.sessions.create(f.coderRun);
      return { status: 'released' };
    },
  );
  ops.integrate.mockResolvedValue(integrated);
  ops.capture.mockImplementation((_rpc, coderPin: { path: string; sha256: string }) => {
    expect(coderPin.path).toBe(join(f.root, 'legacy-completion-coder.json'));
    expect(JSON.parse(readFileSync(coderPin.path, 'utf8')) as unknown).toEqual(integrated);
    expect(f.raw.close).not.toHaveBeenCalled();
    return thread;
  });
  return { ...f, input, options, resume, integrated, thread };
}

it('retires the confirmed cold STOP, integrates a third Writer and closes after preserving its native thread', async () => {
  const f = completionFixture();
  const result = await runH06NativeLegacyCompletion(f.input, f.options);
  expect(result.thread).toEqual(f.thread);
  expect(result.intent.path).toBe(join(f.root, 'legacy-completion-intent.json'));
  expect(ops.cancel).toHaveBeenCalledWith('cold-writer', expect.anything());
  expect(ops.start).toHaveBeenCalledWith(f.integrated.brief, expect.anything());
  expect(ops.complete).toHaveBeenCalledWith('completion', expect.anything());
  expect(ops.integrate).toHaveBeenCalledWith('completion', expect.anything());
  expect(ops.budget).toHaveBeenCalledWith(expect.anything(), 'reopen');
  const { readUsage } = f.budget.wrap.mock.calls[0]![1];
  f.budget.readUsage.mockImplementation(async (_ledger, observe) => [
    await observe({ journal: 'old-warm', session: 'warm' }),
    await observe({ journal: 'old-cold', session: 'cold' }),
    await observe({
      journal: join(f.root, 'coders', 'writer', 'transport.jsonl'),
      session: 'current',
    }),
  ]);
  await expect(readUsage({})).resolves.toEqual([f.previous, { thread: { id: 'cold' } }, f.current]);
  expect(f.raw.close).toHaveBeenCalledOnce();
});

it.each(['resume', 'stop', 'duplicate-thread'] as const)(
  'rejects invalid completion provenance before reserving a Writer (%s)',
  async (caseName) => {
    const f = completionFixture();
    if (caseName === 'resume') {
      f.input.coldResume = f.pin('legacy-cold-resume.json', { ...f.resume, ack: {} });
    } else if (caseName === 'stop') {
      ops.coders.mockResolvedValue({ coders: {} });
    } else {
      f.input.coldThread = f.pin('legacy-cold-writer-thread.json', f.previous);
    }
    await expect(runH06NativeLegacyCompletion(f.input, f.options)).rejects.toThrow(
      caseName === 'duplicate-thread'
        ? 'h06-legacy-transport-thread-duplicate'
        : 'h06-legacy-completion-' + caseName,
    );
    expect(ops.cancel).not.toHaveBeenCalled();
    expect(ops.start).not.toHaveBeenCalled();
  },
);

it('reports integration and transport shutdown failure without claiming completion', async () => {
  const f = completionFixture();
  ops.integrate.mockRejectedValueOnce(new Error('integration failed'));
  ops.descendants.mockResolvedValueOnce([]);
  await expect(runH06NativeLegacyCompletion(f.input, f.options)).rejects.toThrow(
    'h06-legacy-completion-and-stop-failed',
  );
  expect(f.raw.close).toHaveBeenCalledOnce();
  expect(ops.capture).not.toHaveBeenCalled();
});

it('does not return the saved completion when transport STOP is unconfirmed', async () => {
  const f = completionFixture();
  ops.descendants.mockResolvedValueOnce([]);
  await expect(runH06NativeLegacyCompletion(f.input, f.options)).rejects.toThrow(
    'h06-legacy-transport-owner',
  );
  expect(ops.capture).toHaveBeenCalledOnce();
  expect(f.raw.close).toHaveBeenCalledOnce();
});

it.each(['authorizer', 'integration'] as const)(
  'denies late completion work at the %s boundary and still closes the owned process',
  async (boundary) => {
    const f = completionFixture();
    ops.complete.mockImplementation(
      async (_id, deps: { sessions: { create: (run: CoderRun) => Promise<unknown> } }) => {
        await deps.sessions.create(f.coderRun);
        vi.spyOn(Date, 'now').mockReturnValue(f.claim.workDeadlineMs + 1);
        if (boundary === 'authorizer') {
          const authorize = ops.workspace.mock.calls[0]![2] as (
            brief: CoderBrief,
            phase: CoderRun['status'] | null,
          ) => Promise<void>;
          await authorize(f.coderRun.brief, 'integrating');
        }
        return { status: 'released' };
      },
    );
    await expect(runH06NativeLegacyCompletion(f.input, f.options)).rejects.toThrow(
      'h06-legacy-budget-work',
    );
    expect(ops.integrate).not.toHaveBeenCalled();
    expect(f.raw.close).toHaveBeenCalledOnce();
  },
);

it.each(['owner', 'generation', 'released', 'frozen', 'lease', 'deadline'] as const)(
  'blocks new native effects after %s changes while keeping cleanup available',
  async (failure) => {
    const f = fixture();
    ops.phase.mockImplementation(async (_input, runtime: PhaseRuntime) => {
      await runtime.coder.sessions.create(f.coderRun);
      const boundary = f.budget.wrap.mock.calls[0]![0] as AppServerRpc;
      await boundary.request('thread/start', { allowed: true });
      expect(f.raw.request).toHaveBeenCalledWith('thread/start', { allowed: true });
      f.raw.request.mockClear();
      if (failure === 'owner') f.state.owner = 'foreign';
      if (failure === 'generation') f.state.generation++;
      if (failure === 'released') f.state.released = true;
      if (failure === 'frozen') f.state.frozen = true;
      if (failure === 'lease') f.state.lease_until = Date.now() - 1;
      if (failure === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(f.claim.workDeadlineMs + 1);
      for (const method of ['thread/start', 'thread/resume', 'turn/start']) {
        expect(() => boundary.request(method, {})).toThrow(
          failure === 'deadline' ? 'h06-legacy-budget-work' : 'h06-legacy-transport-work-owner',
        );
        expect(f.raw.request).not.toHaveBeenCalledWith(method, {});
      }
      await boundary.request('thread/read', {});
      await boundary.request('turn/interrupt', {});
      await boundary.completed('session', 'turn');
      await runtime.coder.sessions.stop(f.coderRun);
      await runtime.stop(runtime.closeOwned);
    });
    await f.run();
    expect(f.raw.request).toHaveBeenCalledWith('thread/read', {});
    expect(f.raw.request).toHaveBeenCalledWith('turn/interrupt', {});
    expect(f.raw.completed).toHaveBeenCalledWith('session', 'turn', undefined, undefined);
    expect(f.sessions.stop).toHaveBeenCalledWith(f.coderRun);
    expect(f.raw.close).toHaveBeenCalledOnce();
  },
);
