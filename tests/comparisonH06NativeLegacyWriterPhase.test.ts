import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import type { CoderDependencies } from '../application/coderWorkflow.js';
import type { CoderRun } from '../core/coder.js';
import { runH06NativeLegacyWriterPhase } from './comparisonH06NativeLegacyWriterPhase.js';

const ops = vi.hoisted(() => ({
  readClaim: vi.fn(),
  start: vi.fn(),
  launch: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
  stop: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('../application/coderWorkflow.js', () => ({
  startCoder: ops.start,
  launchCoder: ops.launch,
  cancelCoder: ops.cancel,
}));
vi.mock('./comparisonH06NativeAttempt.js', () => ({
  readH06NativeAttemptForReopen: ops.readClaim,
}));
vi.mock('./comparisonH06NativeLegacyControlOperator.js', () => ({
  runH06NativeLegacyControlOperator: ops.pause,
}));
vi.mock('./comparisonH06NativeLegacyControl.js', () => ({ stopH06NativeLegacyWriter: ops.stop }));
vi.mock('./comparisonH06NativeLegacyDispatch.js', () => ({
  captureH06NativeLegacyDispatchThread: ops.capture,
}));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(phase: 'warm' | 'cold' = 'warm') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-writer-phase-'));
  roots.push(root);
  vi.stubEnv('CODEX_THREAD_ID', 'actor');
  const workspace = join(root, 'material');
  const pin = (name: string, body: unknown) => {
    const path = join(root, name);
    const bytes = JSON.stringify(body);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const claim = pin('attempt-claim.json', {});
  const context = { project_id: 'project', task_id: 'task', run_id: 'parent', actor_id: 'actor' };
  const start = { claim, context, generation: 1, kind: 'h06-native-legacy-operator-start' };
  const started = pin('legacy-operator-start.json', start);
  const file = { locator: 'evidence/README.md', hash: digest('test file') };
  const brief = {
    id: 'next',
    project_id: context.project_id,
    task_id: context.task_id,
    parent_run_id: context.run_id,
    parent_session_id: context.actor_id,
    generation: 1,
    source_root: workspace,
    copy_root: join(root, 'coder-workspaces', 'next'),
    card: file,
    authority: file,
    paths: ['evidence/manifest.json'],
    files: [file],
    rules: [file],
    goal: 'Test H06',
    criterion: 'Verify',
    checks: ['checks'],
    profile: { model: 'fixture', effort: 'medium' },
    procedures: [{}],
  };
  const briefPin = pin('writer.json', brief);
  const binding = { variant: 'legacy', workspaceRoot: workspace };
  const request = { binding, evidenceRoot: root, runtime: [briefPin] };
  const stopped = pin('stop-proof.json', {});
  const stopRef = { locator: stopped.path, hash: stopped.sha256 };
  const oldWriter = { status: 'running' };
  const warmStop = pin('legacy-warm-writer-stop.json', {
    kind: 'h06-native-legacy-writer-stop',
    phase: 'warm',
    coderId: 'previous',
    stopped: stopRef,
    intent: pin('legacy-warm-writer-stop-intent.json', { coder: oldWriter }),
  });
  const ack = { operation_id: 'chat:control:resume' };
  const previousResume = pin('legacy-warm-resume.json', {
    kind: 'h06-native-legacy-resume',
    phase: 'warm',
    identity: { context },
    ack,
    event: { id: 'resume', stopped: stopRef },
    intent: pin('legacy-warm-resume-intent.json', { stoppedBy: warmStop }),
  });
  const writer = { status: 'running' };
  const control = { phase, event: { type: 'PAUSE' } };
  const phasePause = { receipt: pin('pause.json', {}) };
  const phaseStop = { link: pin('stop.json', {}) };
  const thread = pin('thread.json', {});
  ops.readClaim.mockReturnValue({ request });
  ops.launch.mockResolvedValue(writer);
  ops.pause.mockResolvedValue(phasePause);
  ops.stop.mockResolvedValue(phaseStop);
  ops.capture.mockResolvedValue(thread);
  const runtime = {
    store: {
      root: join(root, 'legacy-store'),
      grant: { context },
      execute: vi.fn(() => ({ ok: true, value: { status: 'confirmed', ack } })),
    },
    coder: {
      sessions: {},
      journal: { read: vi.fn(async () => ({ coders: { previous: oldWriter } })) },
    },
    rpc: {},
    runWithinWork: vi.fn(async (run: (signal: AbortSignal) => Promise<unknown>) =>
      run(new AbortController().signal),
    ),
    stop: vi.fn(async (cleanup: () => Promise<void>) => cleanup()),
    closeOwned: vi.fn(async () => {}),
    awaitPause: vi.fn(async () => control),
  };
  const input = {
    claim,
    started,
    brief: briefPin,
    previousResume: phase === 'warm' ? null : previousResume,
    phase,
  };
  const run = () =>
    runH06NativeLegacyWriterPhase(
      input,
      runtime as unknown as Parameters<typeof runH06NativeLegacyWriterPhase>[1],
    );
  return { input, run, runtime, phasePause, phaseStop, thread, control, request, brief, pin };
}

it.each(['warm', 'cold'] as const)(
  'captures %s STOP before closing its transport',
  async (phase) => {
    const f = fixture(phase);
    ops.cancel.mockImplementation(async (_id: string, deps: CoderDependencies) =>
      deps.sessions.stop({} as CoderRun),
    );
    await expect(f.run()).resolves.toMatchObject({
      pause: f.phasePause,
      stop: f.phaseStop,
      thread: f.thread,
    });
    expect(ops.launch).toHaveBeenCalledExactlyOnceWith('next', f.runtime.coder);
    expect(ops.cancel).toHaveBeenCalledTimes(phase === 'cold' ? 1 : 0);
    expect(ops.capture.mock.invocationCallOrder[0]!).toBeLessThan(
      f.runtime.closeOwned.mock.invocationCallOrder[0]!,
    );
    await expect(f.run()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(ops.launch).toHaveBeenCalledTimes(1);
  },
);

it('refuses the wrong actor, missing runtime pin or missing previous RESUME before dispatch', async () => {
  const f = fixture('cold');
  vi.stubEnv('CODEX_THREAD_ID', 'other');
  await expect(f.run()).rejects.toThrow('h06-legacy-writer-phase-binding');
  vi.stubEnv('CODEX_THREAD_ID', 'actor');
  const prior = f.input.previousResume;
  f.input.previousResume = null;
  await expect(f.run()).rejects.toThrow('h06-legacy-writer-phase-order');
  f.input.previousResume = prior;
  f.request.runtime.length = 0;
  await expect(f.run()).rejects.toThrow('h06-legacy-writer-phase-binding');
  expect(ops.launch).not.toHaveBeenCalled();
});

it('refuses to release a previous Writer when the retained Store changed', async () => {
  const f = fixture('cold');
  f.runtime.coder.journal.read.mockResolvedValueOnce({
    coders: { previous: { status: 'stopped' } },
  });
  await expect(f.run()).rejects.toThrow('h06-legacy-writer-phase-order');
  expect(ops.cancel).not.toHaveBeenCalled();
  expect(ops.launch).not.toHaveBeenCalled();
});

it('closes once when the accepted PAUSE is unavailable, preserving both failures', async () => {
  const f = fixture();
  const pause = new Error('no native PAUSE');
  const cleanup = new Error('unconfirmed stop');
  f.runtime.awaitPause.mockRejectedValueOnce(pause);
  f.runtime.closeOwned.mockRejectedValueOnce(cleanup);
  await expect(f.run()).rejects.toMatchObject({ errors: [pause, cleanup] });
  expect(f.runtime.closeOwned).toHaveBeenCalledTimes(1);
});

it('does not consume a foreign or non-PAUSE phase', async () => {
  const f = fixture();
  f.control.event.type = 'RESUME';
  await expect(f.run()).rejects.toThrow('h06-legacy-writer-phase-pause');
  expect(ops.pause).not.toHaveBeenCalled();
  expect(f.runtime.closeOwned).toHaveBeenCalledTimes(1);
});

it('retains a refused Writer and propagates a failed transport close', async () => {
  const rejected = fixture();
  ops.launch.mockResolvedValueOnce({ status: 'not-started' });
  await expect(rejected.run()).rejects.toThrow('h06-legacy-writer-not-dispatched');
  const sent = fixture();
  sent.runtime.closeOwned.mockRejectedValueOnce(new Error('close refused'));
  await expect(sent.run()).rejects.toThrow('close refused');
  expect(sent.runtime.closeOwned).toHaveBeenCalledTimes(1);
});
