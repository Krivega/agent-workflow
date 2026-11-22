import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import type { CoderDependencies } from '../application/coderWorkflow.js';
import type { CoderBrief, CoderRun } from '../core/coder.js';
import type { H04Pin } from './comparisonH04Contract.js';
import {
  runDelegatedCompletion,
  runDelegatedWriterPhase,
  type H06DelegatedWriterInput,
  type H06DelegatedWriterOptions,
} from './comparisonH06DelegatedWriter.js';
import type { H06LegacyCoderRuntime } from './comparisonH06NativeLegacyTransportPhase.js';

const ops = vi.hoisted(() => ({
  claim: vi.fn(),
  ledger: vi.fn(),
  runtime: vi.fn(),
  budget: vi.fn(),
  start: vi.fn(),
  launch: vi.fn(),
  cancel: vi.fn(),
  complete: vi.fn(),
  integrate: vi.fn(),
  brief: vi.fn(),
  run: vi.fn(),
  verifyStop: vi.fn(),
}));
vi.mock('./comparisonH06DelegatedAuthority.js', () => ({
  readH06DelegatedAuthority: ops.claim,
  openH06DelegatedPhaseLedger: () => ({ inspect: ops.ledger }),
}));
vi.mock('./comparisonH06NativeLegacyTransportPhase.js', () => ({
  withH06LegacyCoderRuntime: ops.runtime,
}));
vi.mock('./comparisonH06NativeLegacyBudget.js', () => ({ enforceH06LegacyBudget: ops.budget }));
vi.mock('./comparisonH06NativeLegacyControl.js', () => ({ verifyCoderStop: ops.verifyStop }));
vi.mock('../application/coderWorkflow.js', () => ({
  startCoder: ops.start,
  launchCoder: ops.launch,
  cancelCoder: ops.cancel,
  runCoder: ops.complete,
  integrateCoder: ops.integrate,
}));
vi.mock('../core/coder.js', () => ({ validateCoderBrief: ops.brief, validateCoderRun: ops.run }));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(phase: 'warm' | 'cold' | 'completion' = 'warm') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'h06-delegated-writer-')));
  roots.push(root);
  vi.stubEnv('CODEX_THREAD_ID', 'actor');
  function pin(name: string, value: unknown) {
    const path = join(root, name),
      body = JSON.stringify(value);
    writeFileSync(path, body);
    return { path, sha256: digest(body) };
  }
  const context = {
    actor_id: 'actor',
    project_id: 'project',
    task_id: 'task',
    run_id: 'run',
    subtask_id: null,
    schema_version: 'aw-evidence/1-draft',
  };
  const claimPin = pin('delegated-claim.json', {}),
    bootstrap = pin('bootstrap.json', { projectId: 'project', runId: 'run' });
  const brief = {
    id: phase,
    project_id: 'project',
    task_id: 'task',
    parent_run_id: 'run',
    parent_session_id: 'actor',
    source_root: join(root, 'workspace'),
    copy_root: join(root, 'coder-workspaces', phase),
    generation: 1,
  } as CoderBrief;
  const briefPin = pin('brief.json', brief);
  const claim = {
    actorId: 'actor',
    generation: 1,
    receipt: claimPin,
    grant: { sessionsRoot: join(root, 'sessions') },
    request: {
      binding: { variant: 'legacy', workspaceRoot: brief.source_root, operationId: 'task' },
      evidenceRoot: root,
      bootstrap,
      runtime: [briefPin],
    },
    workDeadlineMs: Date.now() + 20_000,
    stopDeadlineMs: Date.now() + 30_000,
  };
  const stopped = { locator: join(root, 'stopped.json'), hash: 'a'.repeat(64) };
  const writer = {
    brief,
    status: 'running',
    session: { id: phase + '-session' },
    turn: phase + '-turn',
  } as CoderRun;
  const previousLabel = phase === 'completion' ? 'cold' : 'warm';
  const oldWriter = {
    brief: { ...brief, id: previousLabel },
    status: 'running',
    session: { id: previousLabel + '-session' },
    turn: previousLabel + '-turn',
  } as CoderRun;
  const control = { status: 'active', revision: 2 },
    ack = { operation_id: 'chat:control:resume', catalog_revision: 12 };
  const resumed: Record<string, unknown> = {
    kind: 'h06-delegated-control-result/1',
    claim: claimPin,
    context,
    event: { id: 'resume', type: 'RESUME', thread_id: 'actor', generation: 1, stopped },
    operation: ack.operation_id,
    ack,
    control,
    writer: { coder: oldWriter, stopped },
  };
  const resumePin = pin(`delegated-${previousLabel}-resume-result.json`, resumed);
  const state = { revision: 12, generation: 1, checkpoint: { chat_control: control } };
  const store = {
    root: join(root, 'legacy-store'),
    grant: { context, permissions: ['read', 'manage'] },
    execute: vi.fn((value: { command: { type: string } }) => ({
      ok: true,
      value: value.command.type === 'state' ? state : { status: 'confirmed', ack },
    })),
  } as unknown as H06LegacyCoderRuntime['store'];
  const delivery = pin('delivery.json', {});
  const outcome = pin('outcome.json', { result: resumePin, delivery });
  const settlement = pin('settlement.json', { outcome });
  const intentPin = pin('phase-intent.json', {});
  const phases: {
    phase: { stage: string; predecessor: H04Pin | null };
    intent: H04Pin;
    outcome: H04Pin | null;
  }[] = [
    {
      phase: { stage: phase === 'warm' ? 'load' : previousLabel + '-resume', predecessor: null },
      intent: intentPin,
      outcome: settlement,
    },
  ];
  if (phase === 'completion')
    phases.push({
      phase: { stage: 'completion', predecessor: settlement },
      intent: intentPin,
      outcome: null,
    });
  const previousThreads =
    phase === 'warm'
      ? []
      : [pin('delegated-warm-writer-thread.json', { thread: { id: 'warm-session' } })];
  if (phase === 'completion')
    previousThreads.push(
      pin('delegated-cold-writer-thread.json', { thread: { id: 'cold-session' } }),
    );
  const response = {
    thread: {
      id: writer.session!.id,
      cwd: brief.copy_root,
      turns: ['profile', 'load', 'implementation'].map((label, index) => ({
        id: index === 2 ? writer.turn : phase + '-' + label,
        status: index === 2 && phase !== 'completion' ? 'interrupted' : 'completed',
        items: [
          {
            type: 'userMessage',
            content: [
              {
                type: 'text',
                text: `Workflow delivery id: ${JSON.stringify(`coder:${phase}:${label}`)}\nbody`,
              },
            ],
          },
        ],
      })),
    },
  };
  const observation = {
    thread: writer.session!.id,
    turn: writer.turn,
    runtime: { pid: 123 },
    processes: [],
  };
  const rpc = vi.fn(async () => response),
    observe = vi.fn(async () => observation),
    physicalStop = vi.fn(async () => stopped);
  const journal = vi.fn(async () => ({ coders: { [oldWriter.brief.id]: oldWriter } }));
  const close = vi.fn(async () => {}),
    stop = vi.fn(async (cleanup: () => Promise<void>) => cleanup());
  const runtime = {
    store,
    coder: {
      journal: { read: journal },
      sessions: { observeLiveWriter: observe, stop: physicalStop },
    },
    rpc: { request: rpc },
    runWithinWork: async <T>(run: (signal: AbortSignal) => Promise<T>) =>
      run(new AbortController().signal),
    stop,
    closeOwned: close,
  } as unknown as H06LegacyCoderRuntime;
  ops.claim.mockReturnValue(claim);
  ops.ledger.mockImplementation(() => ({ phases }));
  ops.runtime.mockImplementation(
    async (
      current: typeof claim,
      _store: unknown,
      mode: 'create' | 'reopen',
      _previous: unknown,
      budget: (claim: typeof current, mode: 'create' | 'reopen') => unknown,
      run: (runtime: H06LegacyCoderRuntime) => Promise<unknown>,
    ) => {
      budget(current, mode);
      return run(runtime);
    },
  );
  ops.launch.mockResolvedValue(writer);
  ops.cancel.mockImplementation(async (_id: string, dependencies: CoderDependencies) => {
    await dependencies.sessions.stop(oldWriter);
    return { status: 'cancelled' };
  });
  ops.verifyStop.mockResolvedValue(true);
  ops.complete.mockResolvedValue({ ...writer, status: 'released' });
  ops.integrate.mockResolvedValue({ ...writer, status: 'integrated' });
  const pauseReceipt = () =>
    pin(`delegated-${phase}-pause-result.json`, {
      kind: 'h06-delegated-control-result/1',
      claim: claimPin,
      event: { type: 'PAUSE' },
      writer: {
        coder: writer,
        stopped,
        live: {
          path: join(root, `delegated-${phase}-writer-live.json`),
          sha256: digest(readFileSync(join(root, `delegated-${phase}-writer-live.json`))),
        },
      },
    });
  const awaitControl = vi.fn<H06DelegatedWriterOptions['awaitControl']>(
    async (_stage, _writer, stopWriter) => {
      await stopWriter();
      return { intent: pin('pause-intent.json', {}), receipt: pauseReceipt() };
    },
  );
  const input: H06DelegatedWriterInput = {
    claim: claimPin,
    brief: briefPin,
    phase: phase === 'completion' ? 'cold' : phase,
    previousResume: phase === 'warm' ? null : resumePin,
    previousThreads,
  };
  const options = { store, awaitControl };
  const completion = {
    claim: claimPin,
    phase: intentPin,
    delivery,
    brief: briefPin,
    coldResume: resumePin,
    previousThreads,
  };
  return {
    input,
    options,
    completion,
    root,
    pin,
    claim,
    brief,
    briefPin,
    writer,
    oldWriter,
    state,
    resumed,
    resumePin,
    phases,
    response,
    observation,
    runtime,
    rpc,
    observe,
    physicalStop,
    close,
    stop,
    awaitControl,
    pauseReceipt,
    journal,
    stopped,
  };
}

it.each(['warm', 'cold'] as const)(
  'runs %s through normal dispatch, live observation, one STOP and full snapshot',
  async (phase) => {
    const f = fixture(phase);
    const result = await runDelegatedWriterPhase(f.input, f.options);
    expect(ops.runtime.mock.calls[0]![2]).toBe(phase === 'warm' ? 'create' : 'reopen');
    expect(ops.budget).toHaveBeenCalledWith(
      f.claim,
      phase === 'warm' ? 'create' : 'reopen',
      f.claim.grant.sessionsRoot,
      'append-only',
    );
    expect(ops.start).toHaveBeenCalledWith(f.brief, f.runtime.coder);
    expect(ops.launch).toHaveBeenCalledWith(phase, f.runtime.coder);
    expect(f.observe).toHaveBeenCalledWith(f.writer);
    expect(JSON.parse(readFileSync(result.live.path, 'utf8'))).toMatchObject({
      writer: f.writer,
      observation: f.observation,
    });
    expect(f.awaitControl).toHaveBeenCalledWith(
      phase + '-pause',
      f.writer,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(f.physicalStop).toHaveBeenCalledTimes(1);
    expect(ops.verifyStop).toHaveBeenCalledWith(
      f.stopped,
      f.writer,
      f.root,
      expect.objectContaining({ status: 'live' }),
    );
    expect(JSON.parse(readFileSync(result.coder.path, 'utf8'))).toEqual(f.writer);
    expect(JSON.parse(readFileSync(result.thread.path, 'utf8'))).toEqual(f.response);
    expect(f.rpc).toHaveBeenCalledWith('thread/read', {
      threadId: f.writer.session!.id,
      includeTurns: true,
    });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(ops.cancel).toHaveBeenCalledTimes(phase === 'warm' ? 0 : 1);
  },
);

it('completes, releases and integrates a separate third Writer after confirmed cold RESUME', async () => {
  const f = fixture('completion');
  const result = await runDelegatedCompletion(f.completion, { store: f.options.store });
  expect(ops.runtime.mock.calls[0]![2]).toBe('reopen');
  expect(ops.budget).toHaveBeenCalledWith(
    f.claim,
    'reopen',
    f.claim.grant.sessionsRoot,
    'append-only',
  );
  expect(ops.cancel).toHaveBeenCalledWith('cold', expect.anything());
  expect(f.physicalStop).not.toHaveBeenCalled();
  expect(ops.complete).toHaveBeenCalledWith('completion', f.runtime.coder);
  expect(ops.integrate).toHaveBeenCalledWith('completion', f.runtime.coder);
  const integrated = JSON.parse(readFileSync(result.coder.path, 'utf8')) as { status: string };
  expect(integrated.status).toBe('integrated');
  expect(f.close).toHaveBeenCalledOnce();
});

it.each([
  [
    'actor',
    (f: ReturnType<typeof fixture>) => {
      f.claim.actorId = 'foreign';
    },
  ],
  [
    'variant',
    (f: ReturnType<typeof fixture>) => {
      f.claim.request.binding.variant = 'temporal';
    },
  ],
  [
    'store',
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.options.store, { root: f.options.store.root + '-foreign' });
    },
  ],
  [
    'unlisted brief',
    (f: ReturnType<typeof fixture>) => {
      f.claim.request.runtime = [];
    },
  ],
  [
    'brief parent',
    (f: ReturnType<typeof fixture>) => {
      f.brief.parent_session_id = 'other';
      f.input.brief = f.pin('brief2.json', f.brief);
      f.claim.request.runtime = [f.input.brief];
    },
  ],
  [
    'wrong copy',
    (f: ReturnType<typeof fixture>) => {
      f.brief.copy_root += '-other';
      f.input.brief = f.pin('brief2.json', f.brief);
      f.claim.request.runtime = [f.input.brief];
    },
  ],
  [
    'unsettled load',
    (f: ReturnType<typeof fixture>) => {
      f.phases[0]!.outcome = null;
    },
  ],
  [
    'wrong load',
    (f: ReturnType<typeof fixture>) => {
      f.phases[0]!.phase.stage = 'warm-pause';
    },
  ],
  [
    'warm resume supplied',
    (f: ReturnType<typeof fixture>) => {
      f.input.previousResume = f.resumePin;
    },
  ],
  [
    'unexpected previous snapshot',
    (f: ReturnType<typeof fixture>) => {
      f.input.previousThreads = [f.pin('unexpected.json', {})];
    },
  ],
] as const)('refuses %s before opening a transport', async (_label, mutate) => {
  const f = fixture();
  mutate(f);
  await expect(runDelegatedWriterPhase(f.input, f.options)).rejects.toThrow();
  expect(ops.runtime).not.toHaveBeenCalled();
  expect(ops.start).not.toHaveBeenCalled();
});

it.each([
  'wrong resume',
  'wrong snapshot path',
  'duplicate snapshot id',
  'resume ack',
  'retained coder changed',
  'STOP failed',
  'cancel failed',
])('refuses invalid cold predecessor: %s', async (name) => {
  const f = fixture('cold');
  if (name === 'wrong resume') f.input.previousResume = f.pin('foreign.json', {});
  if (name === 'wrong snapshot path')
    f.input.previousThreads = [f.pin('foreign.json', { thread: { id: 'warm-session' } })];
  if (name === 'duplicate snapshot id')
    f.input.previousThreads = [f.input.previousThreads[0]!, f.input.previousThreads[0]!];
  if (name === 'resume ack') f.state.revision++;
  if (name === 'retained coder changed') f.journal.mockResolvedValue({ coders: {} });
  if (name === 'STOP failed') ops.verifyStop.mockRejectedValue(new Error('stop-failed'));
  if (name === 'cancel failed') ops.cancel.mockResolvedValue({ status: 'running' });
  await expect(runDelegatedWriterPhase(f.input, f.options)).rejects.toThrow();
  expect(ops.start).not.toHaveBeenCalled();
  if (ops.runtime.mock.calls.length) expect(f.close).toHaveBeenCalledOnce();
});

it.each([
  'dispatch failed',
  'wrong live thread',
  'wrong live turn',
  'wrong runtime',
  'missing stop',
  'double stop',
  'wrong pause receipt',
  'snapshot mismatch',
  'snapshot missing turns',
  'snapshot changed delivery',
  'snapshot duplicate turns',
])('closes owned transport after %s', async (name) => {
  const f = fixture();
  if (name === 'dispatch failed') ops.launch.mockResolvedValue({ ...f.writer, status: 'reserved' });
  if (name === 'wrong live thread') f.observation.thread = 'foreign';
  if (name === 'wrong live turn') f.observation.turn = 'foreign';
  if (name === 'wrong runtime') ops.verifyStop.mockResolvedValue(false);
  if (name === 'missing stop')
    f.awaitControl.mockImplementation(async () => ({
      intent: f.pin('intent.json', {}),
      receipt: f.pauseReceipt(),
    }));
  if (name === 'double stop')
    f.awaitControl.mockImplementation(async (_stage, _writer, stop) => {
      await stop();
      await stop();
      throw new Error('unreachable');
    });
  if (name === 'wrong pause receipt')
    f.awaitControl.mockImplementation(async (_stage, _writer, stop) => {
      await stop();
      return { intent: f.pin('intent.json', {}), receipt: f.pin('receipt.json', {}) };
    });
  if (name === 'snapshot mismatch') f.response.thread.id = 'foreign';
  if (name === 'snapshot missing turns') f.response.thread.turns.pop();
  if (name === 'snapshot changed delivery')
    f.response.thread.turns[0]!.items[0]!.content[0]!.text = 'foreign';
  if (name === 'snapshot duplicate turns') f.response.thread.turns[0]!.id = f.writer.turn;
  await expect(runDelegatedWriterPhase(f.input, f.options)).rejects.toThrow();
  expect(f.close).toHaveBeenCalledOnce();
});

it.each([
  'missing pending',
  'settled completion',
  'wrong intent',
  'wrong predecessor',
  'wrong delivery',
  'wrong result',
  'duplicate prior threads',
  'writer unfinished',
  'integration unfinished',
])('rejects completion with %s', async (name) => {
  const f = fixture('completion');
  if (name === 'missing pending') f.phases.pop();
  if (name === 'settled completion') f.phases.at(-1)!.outcome = f.pin('settled.json', {});
  if (name === 'wrong intent') f.completion.phase = f.pin('other-intent.json', {});
  if (name === 'wrong predecessor') f.phases.at(-1)!.phase.predecessor = null;
  if (name === 'wrong delivery') f.completion.delivery = f.pin('other-delivery.json', {});
  if (name === 'wrong result') f.completion.coldResume = f.pin('other-resume.json', {});
  if (name === 'duplicate prior threads')
    f.completion.previousThreads[1] = f.pin('delegated-cold-writer-thread.json', {
      thread: { id: 'warm-session' },
    });
  if (name === 'writer unfinished') ops.complete.mockResolvedValue({ status: 'running' });
  if (name === 'integration unfinished') ops.integrate.mockResolvedValue({ status: 'released' });
  await expect(runDelegatedCompletion(f.completion, { store: f.options.store })).rejects.toThrow();
  if (ops.runtime.mock.calls.length) expect(f.close).toHaveBeenCalledOnce();
});

it.each(['warm', 'completion'] as const)(
  'preserves %s work and cleanup failures together',
  async (phase) => {
    const f = fixture(phase);
    ops.start.mockRejectedValue(new Error('work-failed'));
    f.stop.mockRejectedValue(new Error('cleanup-failed'));
    const run =
      phase === 'warm'
        ? runDelegatedWriterPhase(f.input, f.options)
        : runDelegatedCompletion(f.completion, { store: f.options.store });
    await expect(run).rejects.toMatchObject({
      message: 'h06-delegated-writer-and-stop-failed',
      errors: [
        expect.objectContaining({ message: 'work-failed' }),
        expect.objectContaining({ message: 'cleanup-failed' }),
      ],
    });
  },
);

it.each(['warm', 'completion'] as const)(
  'does not return %s evidence if owned STOP failed',
  async (phase) => {
    const f = fixture(phase);
    f.stop.mockRejectedValue(new Error('cleanup-failed'));
    const run =
      phase === 'warm'
        ? runDelegatedWriterPhase(f.input, f.options)
        : runDelegatedCompletion(f.completion, { store: f.options.store });
    await expect(run).rejects.toThrow('cleanup-failed');
  },
);

it.each(['warm', 'completion'] as const)(
  'honors an aborted %s signal before effects and still closes owned runtime',
  async (phase) => {
    const f = fixture(phase),
      signal = AbortSignal.abort(new Error('aborted'));
    const run =
      phase === 'warm'
        ? runDelegatedWriterPhase(f.input, { ...f.options, signal })
        : runDelegatedCompletion(f.completion, { store: f.options.store, signal });
    await expect(run).rejects.toThrow('aborted');
    expect(ops.start).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  },
);

it('closes owned runtime even when the deadline wrapper throws synchronously', async () => {
  const f = fixture();
  f.runtime.runWithinWork = () => {
    throw new Error('work-deadline');
  };
  await expect(runDelegatedWriterPhase(f.input, f.options)).rejects.toThrow('work-deadline');
  expect(f.close).toHaveBeenCalledOnce();
  expect(ops.start).not.toHaveBeenCalled();
});
