import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import type { H04Pin } from './comparisonH04Contract.js';
import { runH06NativeLegacyDriver } from './comparisonH06NativeLegacyDriver.js';

const operations = vi.hoisted(() => ({
  plan: vi.fn(),
  observe: vi.fn(),
  authority: vi.fn(),
  run: vi.fn(),
  control: vi.fn(),
  dispatch: vi.fn(),
  usage: vi.fn(),
}));
vi.mock('../adapters/codex/chatDiscovery.js', () => ({ discoverChat: operations.observe }));
vi.mock('./comparisonH06NativeAttempt.js', () => ({
  h06NativeSessionsRoot: () => '/fixture/sessions',
}));
vi.mock('./comparisonH06NativeAuthority.js', () => ({
  resolveH06NativeGrant: operations.authority,
}));
vi.mock('./comparisonH06NativeLegacyOperator.js', () => ({
  planH06NativeLegacyOperator: operations.plan,
  runH06NativeLegacyWithActor: operations.run,
}));
vi.mock('./comparisonH06NativeLegacyEvidence.js', () => ({
  checkH06NativeLegacyEvidence: operations.control,
}));
vi.mock('./comparisonH06NativeLegacyDispatch.js', () => ({
  checkH06NativeLegacyDispatch: operations.dispatch,
}));
vi.mock('./comparisonH06NativeLegacyUsageSummary.js', () => ({
  checkH06NativeLegacyUsageSummary: operations.usage,
}));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-legacy-driver-'));
  roots.push(root);
  mkdirSync(join(root, 'legacy-store'));
  const pin = (name: string, body: unknown = {}) => {
    const path = join(root, name),
      bytes = JSON.stringify(body);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const plan = {
    request: {
      binding: { workspaceRoot: join(root, 'material') },
      bootstrap: pin('bootstrap.json', { actorId: 'actor' }),
      evidenceRoot: root,
    },
  };
  const actor = { transcript: '/fixture/sessions/actor.jsonl', anchor: { thread_id: 'actor' } };
  const stage = {
    started: pin('legacy-operator-start.json'),
    claim: pin('attempt-claim.json'),
    initialFailure: pin('f01.json'),
    workDeadlineMs: Date.now() + 10000,
    stopDeadlineMs: Date.now() + 20000,
  };
  const parent = pin('parent.json');
  const database = pin('legacy-store/store.sqlite');
  const phase = (name: string) =>
    Object.fromEntries(
      ['pause', 'stop', 'resume', 'thread'].map((key) => [key, pin(`${name}-${key}.json`)]),
    ) as { pause: H04Pin; stop: H04Pin; resume: H04Pin; thread: H04Pin };
  const result = {
    warm: phase('warm'),
    cold: phase('cold'),
    completion: { coder: pin('completion-coder.json'), thread: pin('completion-thread.json') },
    council: null,
  };
  operations.plan.mockReturnValue(plan);
  operations.observe.mockResolvedValue(actor);
  operations.authority.mockResolvedValue('exact');
  const verify = vi.fn();
  type Callback = (
    verify: () => void,
    failure: H04Pin,
    preparation: { claim: { receipt: H04Pin; workDeadlineMs: number; stopDeadlineMs: number } },
  ) => Promise<unknown>;
  operations.run.mockImplementation(
    async (_value: unknown, _authority: unknown, _actor: unknown, run: Callback) => ({
      writer: {
        result: await run(verify, stage.initialFailure, {
          claim: { ...stage, receipt: stage.claim },
        }),
      },
      start: stage.started,
      parentUsage: parent,
      claim: stage.claim,
      continuity: 'verified',
    }),
  );
  operations.control.mockResolvedValue('control');
  operations.dispatch.mockReturnValue({ completion: { status: 'HARNESS_EVIDENCE_VERIFIED' } });
  operations.usage.mockReturnValue('usage');
  return {
    plan,
    actor,
    stage,
    result,
    parent,
    database,
    verify,
    controller: new AbortController(),
  };
}

it('forwards the current actor only after the grant and reconciles both retained phases', async () => {
  const f = fixture();
  const actorStage = vi.fn(async () => f.result);
  await expect(
    runH06NativeLegacyDriver(f.plan.request, actorStage, f.controller.signal),
  ).resolves.toMatchObject({
    claim: f.stage.claim,
    started: f.stage.started,
    continuity: 'verified',
    control: 'control',
    dispatch: { completion: { status: 'HARNESS_EVIDENCE_VERIFIED' } },
    usage: 'usage',
    qualification: false,
  });
  expect(operations.observe).toHaveBeenCalledWith(
    f.plan.request.binding.workspaceRoot,
    '/fixture/sessions',
    'actor',
  );
  expect(operations.run).toHaveBeenCalledWith(
    f.plan.request,
    'exact',
    f.actor,
    expect.any(Function),
  );
  expect(actorStage).toHaveBeenCalledWith({ actor: f.actor, ...f.stage }, expect.any(AbortSignal));
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(operations.dispatch).toHaveBeenCalledWith({
    started: f.stage.started,
    database: f.database,
    warm: { stop: f.result.warm.stop, thread: f.result.warm.thread },
    cold: { stop: f.result.cold.stop, thread: f.result.cold.thread },
    completion: f.result.completion,
  });
  expect(operations.usage).toHaveBeenCalledWith(
    expect.objectContaining({ parent: { usageStart: f.parent, coldResume: f.result.cold.resume } }),
  );
});

it('requires successful Harness evidence for the completing Writer', async () => {
  const f = fixture();
  operations.dispatch.mockReturnValueOnce({});
  await expect(
    runH06NativeLegacyDriver({}, async () => f.result, f.controller.signal),
  ).rejects.toThrow('h06-legacy-driver-completion');
  expect(operations.usage).not.toHaveBeenCalled();
});

it('does not enter an expired or interrupted stage', async () => {
  const f = fixture();
  const actor = vi.fn(async () => f.result);
  f.stage.workDeadlineMs = 1;
  await expect(runH06NativeLegacyDriver({}, actor, f.controller.signal)).rejects.toThrow(
    'h06-legacy-driver-deadline',
  );
  f.controller.abort(new Error('interrupted'));
  await expect(runH06NativeLegacyDriver({}, actor, f.controller.signal)).rejects.toThrow(
    'interrupted',
  );
  expect(actor).not.toHaveBeenCalled();
  expect(operations.dispatch).not.toHaveBeenCalled();
});
