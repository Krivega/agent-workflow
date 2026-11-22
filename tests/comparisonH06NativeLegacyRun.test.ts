import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import { evidenceSchema } from '../core/evidence.js';
import type { H06LegacyActorChat } from './comparisonH06NativeLegacyActor.js';
import type { runH06NativeLegacyDriver } from './comparisonH06NativeLegacyDriver.js';
import { h06NativeLegacyRunMain } from './comparisonH06NativeLegacyRun.js';

const ports = vi.hoisted(() => ({
  discover: vi.fn(),
  reopen: vi.fn(),
  bind: vi.fn(),
  verify: vi.fn(),
  store: vi.fn(),
  execute: vi.fn(),
  run: vi.fn(),
  warm: vi.fn(),
  cold: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('../adapters/codex/chatDiscovery.js', () => ({ discoverChat: ports.discover }));
vi.mock('../adapters/storage/chatWriter.js', () => ({ bindChatEvidence: ports.bind }));
vi.mock('../adapters/storage/sqliteEvidenceStore.js', () => ({
  SqliteEvidenceStore: class {
    execute = ports.execute;
    constructor(root: string, grant: unknown, now: () => number) {
      ports.store(root, grant, now);
    }
  },
  unwrap: <T>(result: { value: T }) => result.value,
}));
vi.mock('./comparisonH06NativeAttempt.js', () => ({
  readH06NativeAttemptForReopen: ports.reopen,
}));
vi.mock('./comparisonH06NativeLegacyActor.js', () => ({
  runH06NativeLegacyInitialAndWarm: ports.warm,
  runH06NativeLegacyCold: ports.cold,
}));
vi.mock('./comparisonH06NativeLegacyDriver.js', () => ({
  runH06NativeLegacyDriver: ports.run,
}));
vi.mock('./comparisonH06NativeLegacyTransportPhase.js', () => ({
  runH06NativeLegacyCompletion: ports.complete,
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  vi.stubEnv('CODEX_THREAD_ID', 'actor');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-legacy-run-'));
  roots.push(root);
  const pin = (path: string) => ({ path, sha256: digest(readFileSync(path)) });
  const json = (name: string, value: unknown) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return pin(path);
  };
  const context = {
    schema_version: evidenceSchema,
    project_id: 'project',
    task_id: 'operation',
    subtask_id: null,
    run_id: 'run',
    actor_id: 'actor',
  };
  const actor = {
    transcript: join(root, 'actor.jsonl'),
    anchor: { thread_id: 'actor', turn_id: 'turn', workspace: root, host_id: 'local' },
  };
  const actorNext = { ...actor, anchor: { ...actor.anchor, turn_id: 'next-turn' } };
  const state = {
    owner: 'actor',
    generation: 1,
    frozen: false,
    released: false,
    lease_until: Date.now() + 30_000,
  };
  const bootstrapValue = {
    kind: 'comparison-h06-native-legacy-bootstrap/2',
    actorId: 'actor',
    projectId: 'project',
    runId: 'run',
    generation: 1,
    permissions: ['read', 'manage'],
  };
  const bootstrap = json('bootstrap.json', bootstrapValue);
  const claim = json('attempt-claim.json', {});
  const startedValue = {
    kind: 'h06-native-legacy-operator-start',
    claim,
    bootstrap,
    storeRoot: join(root, 'legacy-store'),
    generation: 1,
    context,
  };
  mkdirSync(startedValue.storeRoot, { mode: 0o700 });
  const runtimePath = json('legacy-store/chat-runtime.json', {}).path;
  const started = json('legacy-operator-start.json', startedValue);
  const inputs = {
    claim,
    started,
    initialFailure: json('initial-failure.json', {}),
    preparation: json('preparation.json', {}),
    warmBrief: json('warm-brief.json', { id: 'warm' }),
    coldBrief: json('cold-brief.json', { id: 'cold' }),
    completionBrief: json('completion-brief.json', { id: 'complete' }),
  };
  const phase = (name: 'warm' | 'cold') => ({
    pause: { receipt: json(name + '-pause.json', {}) },
    stop: { link: json(name + '-stop.json', {}) },
    thread: json(name + '-thread.json', {}),
  });
  const retained = {
    attempt: { claim, started, preparation: inputs.preparation, actor },
    warm: phase('warm'),
    warmResume: { receipt: json('warm-resume.json', {}) },
    cold: phase('cold'),
  };
  const coldResume = { receipt: json('cold-resume.json', {}) };
  const completion = {
    coder: json('completion-coder.json', {}),
    thread: json('completion-thread.json', {}),
  };
  const controller = new AbortController();
  const channel = {
    input: new PassThrough(),
    output: new PassThrough(),
    signal: controller.signal,
  };
  const binding = { variant: 'legacy', workspaceRoot: root, operationId: 'operation' };
  ports.reopen.mockReturnValue({
    request: {
      binding,
      evidenceRoot: root,
      bootstrap,
      runtime: [inputs.warmBrief, inputs.coldBrief, inputs.completionBrief],
    },
    grant: { sessionsRoot: root },
  });
  ports.discover.mockResolvedValueOnce(actor).mockResolvedValueOnce(actorNext);
  ports.bind.mockReturnValue(ports.verify);
  ports.execute.mockReturnValue({ ok: true, value: state });
  ports.warm.mockResolvedValue(retained);
  ports.cold.mockResolvedValue(coldResume);
  ports.complete.mockResolvedValue(completion);
  return {
    root,
    json,
    context,
    actor,
    actorNext,
    state,
    bootstrap,
    bootstrapValue,
    binding,
    startedValue,
    claim,
    started,
    inputs,
    retained,
    coldResume,
    completion,
    channel,
    runtimePath,
  };
}

function respond(
  channel: ReturnType<typeof fixture>['channel'],
  reply: (line: { kind: string; id: number; body: unknown }) => unknown,
) {
  channel.output.on('data', (bytes: Buffer) => {
    const line = JSON.parse(bytes.toString()) as Parameters<typeof reply>[0];
    channel.input.write(JSON.stringify({ id: line.id, value: reply(line) }) + '\n');
  });
}

it('relays the requested native actor stage through --run', async () => {
  const f = fixture();
  const request = { kind: 'attempt' };
  const path = f.json('run.json', request).path;
  const result = { actor: 'retained-primary-output' };
  const stage = {
    actor: f.actor,
    claim: f.claim,
    started: f.started,
    initialFailure: f.inputs.initialFailure,
    workDeadlineMs: Date.now() + 1_000,
    stopDeadlineMs: Date.now() + 2_000,
  } as Parameters<Parameters<typeof runH06NativeLegacyDriver>[1]>[0];
  respond(f.channel, (frame) => {
    expect(frame).toEqual({ kind: 'h06-legacy-actor-stage', id: 1, body: stage });
    return result;
  });
  ports.run.mockImplementation(
    async (
      value: unknown,
      actorStage: Parameters<typeof runH06NativeLegacyDriver>[1],
      signal: AbortSignal,
    ) => {
      expect(value).toEqual(request);
      expect(signal).toBe(f.channel.signal);
      return actorStage(stage, signal);
    },
  );
  await expect(h06NativeLegacyRunMain(['--run', path], f.channel)).resolves.toEqual(result);
  expect(ports.warm).not.toHaveBeenCalled();
  expect(ports.cold).not.toHaveBeenCalled();
});

it('prepares the Store, relays the exact warm control and continues the pinned cold receipt', async () => {
  const f = fixture();
  const proposal = {
    expectedText: 'exact-plan',
    control: { event: 'proposal' },
  } as unknown as Parameters<H06LegacyActorChat['control']>[0];
  const primary = { event: 'primary' };
  respond(f.channel, (frame) => {
    expect(frame).toEqual({ kind: 'h06-legacy-control', id: 1, body: proposal });
    return primary;
  });
  ports.warm.mockImplementation(
    async (_input, _store, chat: H06LegacyActorChat, verify: () => void, signal: AbortSignal) => {
      verify();
      expect(await chat.control(proposal, signal)).toEqual(primary);
      return f.retained;
    },
  );
  const warm = await h06NativeLegacyRunMain(
    ['--warm', f.json('warm.json', f.inputs).path],
    f.channel,
  );
  expect(warm).toHaveProperty('retained.path', join(f.root, 'legacy-actor-retained.json'));
  const stored = join(f.root, 'legacy-actor-retained.json');
  expect(JSON.parse(readFileSync(stored, 'utf8')) as unknown).toEqual({
    stage: f.retained,
    completionBrief: f.inputs.completionBrief,
  });
  const retained = { path: stored, sha256: digest(readFileSync(stored)) };
  expect(warm).toEqual({ retained });
  const channel = { ...f.channel, input: new PassThrough(), output: new PassThrough() };
  const coldProposal = { ...proposal, expectedText: 'exact-cold-plan' };
  respond(channel, (frame) => {
    expect(frame).toEqual({ kind: 'h06-legacy-control', id: 1, body: coldProposal });
    return primary;
  });
  ports.cold.mockImplementation(
    async (_input, _store, chat: H06LegacyActorChat, signal: AbortSignal) => {
      expect(await chat.control(coldProposal, signal)).toEqual(primary);
      return f.coldResume;
    },
  );
  const result = await h06NativeLegacyRunMain(
    ['--cold', f.json('cold.json', retained).path],
    channel,
  );
  expect(result).toEqual({
    warm: {
      pause: f.retained.warm.pause.receipt,
      stop: f.retained.warm.stop.link,
      resume: f.retained.warmResume.receipt,
      thread: f.retained.warm.thread,
    },
    cold: {
      pause: f.retained.cold.pause.receipt,
      stop: f.retained.cold.stop.link,
      resume: f.coldResume.receipt,
      thread: f.retained.cold.thread,
    },
    completion: f.completion,
    council: null,
  });
  expect(ports.store).toHaveBeenCalledWith(
    f.startedValue.storeRoot,
    { context: f.context, permissions: f.bootstrapValue.permissions },
    Date.now,
  );
  const { completionBrief, ...original } = f.inputs;
  expect(ports.warm).toHaveBeenCalledWith(
    { ...original, actor: f.actor },
    expect.anything(),
    expect.anything(),
    expect.any(Function),
    f.channel.signal,
  );
  expect(ports.cold).toHaveBeenCalledWith(
    { ...f.retained, attempt: { ...f.retained.attempt, actor: f.actorNext } },
    expect.anything(),
    expect.anything(),
    channel.signal,
  );
  const store: unknown = expect.anything();
  expect(ports.complete).toHaveBeenCalledWith(
    {
      claim: f.claim,
      started: f.started,
      brief: completionBrief,
      coldResume: f.coldResume.receipt,
      warmThread: f.retained.warm.thread,
      coldThread: f.retained.cold.thread,
    },
    { store, signal: channel.signal },
  );
});

it.each([
  ['actor', 'h06-legacy-run-actor'],
  ['store-root', 'h06-legacy-run-store'],
  ['store-owner', 'h06-legacy-run-store'],
  ['store-binding', 'ENOENT'],
  ['retained', 'h06-legacy-run-retained'],
  ['unpinned-completion', 'h06-legacy-run-writer-briefs'],
  ['duplicate-completion', 'h06-legacy-run-writer-briefs'],
  ['arguments', 'h06-legacy-run-arguments'],
] as const)('rejects unsafe %s before the actor runs', async (kind, error) => {
  const f = fixture();
  let args = ['--warm', f.json('warm.json', f.inputs).path];
  if (kind === 'actor') vi.stubEnv('CODEX_THREAD_ID', 'other');
  if (kind === 'store-root') {
    const started = f.json('legacy-operator-start.json', {
      ...f.startedValue,
      storeRoot: '/foreign',
    });
    args = ['--warm', f.json('warm.json', { ...f.inputs, started }).path];
  }
  if (kind === 'store-owner') f.state.owner = 'foreign';
  if (kind === 'store-binding') rmSync(f.runtimePath);
  if (kind === 'retained')
    args = [
      '--cold',
      f.json(
        'cold.json',
        f.json('unbound.json', { stage: f.retained, completionBrief: f.inputs.completionBrief }),
      ).path,
    ];
  if (kind === 'unpinned-completion')
    args = [
      '--warm',
      f.json('warm.json', {
        ...f.inputs,
        completionBrief: f.json('foreign.json', { id: 'foreign' }),
      }).path,
    ];
  if (kind === 'duplicate-completion')
    args = [
      '--warm',
      f.json('warm.json', { ...f.inputs, completionBrief: f.inputs.warmBrief }).path,
    ];
  if (kind === 'arguments') args = ['--other', args[1]!];
  await expect(h06NativeLegacyRunMain(args, f.channel)).rejects.toThrow(error);
  expect(ports.warm).not.toHaveBeenCalled();
  expect(ports.cold).not.toHaveBeenCalled();
  if (kind === 'store-owner' || kind === 'store-binding') expect(ports.bind).not.toHaveBeenCalled();
});

it.each(['success', 'signal'] as const)(
  'reports the direct entry and clears signal hooks (%s)',
  async (mode) => {
    const f = fixture();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    if (mode === 'success') ports.run.mockResolvedValue({ finished: true });
    else
      ports.run.mockImplementation(
        async (_input, _actor, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );
    const argv = process.argv;
    const exitCode = process.exitCode;
    const listeners = process.listeners('SIGTERM');
    try {
      process.argv = [
        process.execPath,
        fileURLToPath(new URL('./comparisonH06NativeLegacyRun.ts', import.meta.url)),
        '--run',
        f.json('direct.json', {}).path,
      ];
      vi.resetModules();
      await import('./comparisonH06NativeLegacyRun.js');
      if (mode === 'signal') {
        const interrupt = process
          .listeners('SIGTERM')
          .find((listener) => !listeners.includes(listener));
        expect(interrupt).toBeDefined();
        interrupt?.('SIGTERM');
        await vi.waitFor(() =>
          expect(stderr).toHaveBeenCalledWith('Error: h06-legacy-run-interrupted\n'),
        );
        expect(process.exitCode).toBe(1);
      } else await vi.waitFor(() => expect(stdout).toHaveBeenCalledWith('{"finished":true}\n'));
      expect(process.listeners('SIGTERM')).toEqual(listeners);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
    }
  },
);
