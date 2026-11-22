import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import type {
  TaskHumanActivities,
  TaskHumanCommand,
  TaskHumanCommandContext,
} from '../../src/contracts/taskHuman.js';
import { taskHumanController } from '../../src/workflows/taskHuman.js';

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  watches: [] as { ready(): boolean; resolve(): void }[],
  afterDrain: null as (() => void) | null,
  ContinueSignal: class extends Error {},
}));
vi.mock('@temporalio/workflow', () => {
  const drained = () => true;
  return {
    ApplicationFailure: { nonRetryable: (message: string) => new Error(message) },
    ContinueAsNew: sdk.ContinueSignal,
    isCancellation: (value: unknown) => value instanceof Error && value.message === 'cancelled',
    defineQuery: (name: string) => name,
    defineUpdate: (name: string) => name,
    setHandler: (name: string, handler: (...args: unknown[]) => unknown) =>
      sdk.handlers.set(name, handler),
    allHandlersFinished: drained,
    condition: (ready: () => boolean) => {
      if (!ready()) return new Promise<void>((resolve) => sdk.watches.push({ ready, resolve }));
      if (ready === drained && sdk.afterDrain !== null) {
        const callback = sdk.afterDrain;
        sdk.afterDrain = null;
        queueMicrotask(callback);
      }
      return Promise.resolve();
    },
  };
});
beforeEach(() => {
  vi.stubGlobal('structuredClone', undefined);
  sdk.handlers.clear();
  sdk.watches.length = 0;
  sdk.afterDrain = null;
});
afterEach(() => vi.unstubAllGlobals());
async function until(ready: () => boolean) {
  for (let n = 0; n < 100 && !ready(); n++) {
    for (const watch of [...sdk.watches])
      if (watch.ready()) {
        sdk.watches.splice(sdk.watches.indexOf(watch), 1);
        watch.resolve();
      }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(ready()).toBe(true);
}
const ref = { sha256: 'a'.repeat(64), bytes: 10 };
function fixture() {
  const preparation = {
    schemaVersion: 1 as const,
    project: {
      schemaVersion: 1 as const,
      projectId: 'project',
      workspaceId: 'workspace',
      rules: ['RULES.md'],
      cardRoot: 'tasks',
      roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
      checks: ['syntax'],
    },
    taskId: 'task',
    hostId: 'host',
    owner: 'owner',
    generation: 1,
    revision: 1,
    card: 'tasks/task.md',
  };
  const input: HumanManagedTaskInput = {
    schemaVersion: 12,
    admission: {
      schemaVersion: 3,
      preparation,
      plan: { path: 'plan.json', sha256: ref.sha256 },
      planning: ref,
      acceptance: ref,
    },
    executor: { path: 'executor.md', sha256: ref.sha256 },
    baseline: 'syntax',
    continuation: { attempt: 0, previous: null },
    startAdmission: ref,
  };
  const bound = {
    ref,
    manifest: {
      schemaVersion: 1 as const,
      kind: 'task-human-gate-manifest' as const,
      target: {
        workflowId: 'aw/task/project/task',
        projectId: 'project',
        taskId: 'task',
        roleId: 'task' as const,
        hostId: 'host',
        workspaceId: 'workspace',
        owner: 'owner',
        generation: 1,
        requirementsRevision: 1,
      },
      card: { path: 'tasks/task.md', ...ref },
      declaration: ref,
      requirements: ref,
      criteria: [
        {
          id: 'Критерий',
          text: 'Критерий',
          kind: 'human' as const,
          applicable: true,
          reason: 'Explicit',
        },
      ],
    },
  };
  const technical = {
    input,
    snapshot: ref,
    packet: { schemaVersion: 1 as const, preparation, reviewId: 'review', request: ref },
    acceptance: ref,
    records: [ref],
    stopped: ref,
  };
  const flags = {
    active: true,
    closing: false,
    interrupted: false,
    controlPending: false,
    suggested: false,
    reconcile: 0,
    phase: '',
  };
  const activities: TaskHumanActivities = {
    prepareTaskHuman: vi.fn(async () => bound),
    verifyTaskHumanCommand: vi.fn<TaskHumanActivities['verifyTaskHumanCommand']>(
      async (_context, command) =>
        command.action === 'ASK'
          ? {
              kind: 'verified-task-human-command' as const,
              action: 'ASK' as const,
              command,
              proof: ref,
            }
          : {
              kind: 'verified-task-human-command' as const,
              action: 'DECIDE' as const,
              command,
              proof: ref,
              accepted: command.accepted,
            },
    ),
    finishTaskHuman: vi.fn(async () => ({ status: 'done' as const, result: ref, projection: ref })),
    controlTaskHumanExecution: vi.fn(),
    saveTaskHumanCheckpoint: vi.fn(),
    loadTaskHumanCheckpoint: vi.fn(),
  };
  const rollover = vi.fn<Parameters<typeof taskHumanController>[0]['rollover']>(async () => {}),
    diagnostic = vi.fn();
  const controller = taskHumanController({
    input: () => input,
    active: () => flags.active,
    paused: () => !flags.active,
    closing: () => flags.closing,
    interrupted: () => flags.interrupted,
    controlPending: () => flags.controlPending,
    close: () => {
      flags.closing = true;
    },
    phase: (phase) => {
      flags.phase = phase;
    },
    diagnostic,
    reconcile: () => flags.reconcile,
    rolloverSuggested: () => flags.suggested,
    rollover,
    activities,
  });
  const context = () => sdk.handlers.get('taskHumanState')!() as TaskHumanCommandContext | null;
  const command = (action: 'ASK' | 'DECIDE'): TaskHumanCommand => {
    const state = context()!.state;
    const fields = {
      schemaVersion: 1 as const,
      commandId: action + state.revision,
      hash: ref.sha256,
      target: bound.manifest.target,
      manifest: ref,
      expectedRevision: state.revision,
      author: 'owner',
      source: ref,
      questionId: state.pending?.questionId ?? 'q' + state.revision,
      criterionId: 'Критерий',
    };
    return action === 'ASK' ? { ...fields, action } : { ...fields, action, accepted: true };
  };
  const update = (value: unknown) => sdk.handlers.get('taskHuman')!(value) as Promise<unknown>;
  return {
    controller,
    activities,
    flags,
    rollover,
    diagnostic,
    technical,
    context,
    command,
    update,
  };
}
it('isolates JSON query and verification snapshots without structuredClone', async () => {
  const f = fixture();
  expect(f.context()).toBeNull();
  await f.controller.admit();
  const finish = f.controller.finish(f.technical),
    before = JSON.stringify(f.context()),
    query = f.context()!;
  query.input.admission.preparation.project.rules.push('query-only.md');
  query.state.current.manifest.criteria[0]!.text = 'Changed query';
  query.technical.records[0]!.bytes++;
  expect(JSON.stringify(f.context())).toBe(before);
  vi.mocked(f.activities.verifyTaskHumanCommand).mockImplementationOnce(
    async (captured, command) => {
      captured.input.admission.preparation.project.rules.push('activity-only.md');
      captured.state.current.manifest.criteria[0]!.text = 'Changed Activity copy';
      captured.technical.records.push({ ...ref, bytes: 99 });
      return { kind: 'verified-task-human-command', action: 'ASK', command, proof: ref };
    },
  );
  await f.update(f.command('ASK'));
  expect(f.context()!.state.current.manifest.criteria[0]!.text).toBe('Критерий');
  expect(f.context()!.input.admission.preparation.project.rules).toEqual(['RULES.md']);
  expect(f.context()!.technical.records).toEqual([ref]);
  await f.update(f.command('DECIDE'));
  await until(() => f.flags.closing);
  expect(await finish).toMatchObject({ status: 'done' });
});
it('isolates restored state and Continue-As-New snapshots without structuredClone', async () => {
  const original = fixture();
  await original.controller.admit();
  const saved = { humanState: original.controller.state!, technical: original.technical },
    before = JSON.stringify(saved),
    f = fixture();
  f.controller.restore({ ...saved, technical: null });
  expect(f.context()).toBeNull();
  f.controller.restore(saved);
  saved.humanState.current.manifest.criteria[0]!.text = 'Changed checkpoint source';
  saved.technical.records.push({ ...ref, bytes: 99 });
  expect(
    JSON.stringify({ humanState: f.controller.state, technical: f.controller.technical }),
  ).toBe(before);
  f.flags.suggested = true;
  f.rollover.mockImplementationOnce(async (state, technical) => {
    state.current.manifest.criteria[0]!.text = 'Changed rollover state';
    technical.records.push({ ...ref, bytes: 98 });
    f.flags.suggested = false;
  });
  const finish = f.controller.finish(f.controller.technical!);
  await until(() => f.rollover.mock.calls.length === 1);
  expect(
    JSON.stringify({ humanState: f.controller.state, technical: f.controller.technical }),
  ).toBe(before);
  await f.update(f.command('ASK'));
  await f.update(f.command('DECIDE'));
  await until(() => f.flags.closing);
  expect(await finish).toMatchObject({ status: 'done' });
});
it('rechecks active state after verification even without a competing execution control', async () => {
  const f = fixture();
  await f.controller.admit();
  const finish = f.controller.finish(f.technical);
  let release!: (value: Awaited<ReturnType<TaskHumanActivities['verifyTaskHumanCommand']>>) => void;
  vi.mocked(f.activities.verifyTaskHumanCommand).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const command = f.command('ASK'),
    update = f.update(command),
    rejected = expect(update).rejects.toThrow('human-verification-stale');
  f.flags.active = false;
  release({ kind: 'verified-task-human-command', action: 'ASK', command, proof: ref });
  await rejected;
  expect(f.context()!.state.revision).toBe(0);
  f.flags.active = true;
  await f.update(f.command('ASK'));
  await f.update(f.command('DECIDE'));
  await until(() => f.flags.closing);
  expect(await finish).toMatchObject({ status: 'done' });
});
it('deduplicates an in-flight exact command and rejects conflicting or concurrent bodies before another Activity', async () => {
  const f = fixture();
  expect(f.context()).toBeNull();
  await expect(f.update({})).rejects.toThrow('human-technical-result-required');
  await f.controller.admit();
  const finish = f.controller.finish(f.technical);
  let release!: (value: Awaited<ReturnType<TaskHumanActivities['verifyTaskHumanCommand']>>) => void;
  vi.mocked(f.activities.verifyTaskHumanCommand).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const command = f.command('ASK'),
    first = f.update(command),
    duplicate = f.update(command);
  await expect(f.update({ ...command, source: { ...ref, bytes: 11 } })).rejects.toThrow(
    'human-command-conflict',
  );
  await expect(f.update({ ...command, commandId: 'different' })).rejects.toThrow(
    'human-command-pending',
  );
  release({ kind: 'verified-task-human-command', action: 'ASK', command, proof: ref });
  expect(await duplicate).toEqual(await first);
  expect(f.activities.verifyTaskHumanCommand).toHaveBeenCalledOnce();
  await f.update(f.command('DECIDE'));
  await until(() => f.flags.closing);
  expect(await finish).toMatchObject({ status: 'done' });
});
it('does not close when a new Update arrives after handlers drained but before the closing continuation', async () => {
  const f = fixture();
  await f.controller.admit();
  const finish = f.controller.finish(f.technical);
  await f.update(f.command('ASK'));
  let release!: (value: Awaited<ReturnType<TaskHumanActivities['verifyTaskHumanCommand']>>) => void;
  let raced: Promise<unknown> = Promise.resolve();
  sdk.afterDrain = () => {
    vi.mocked(f.activities.verifyTaskHumanCommand).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    raced = f.update(f.command('ASK'));
  };
  await f.update(f.command('DECIDE'));
  await until(() => f.controller.pending);
  expect(f.flags.closing).toBe(false);
  const command = f.command('ASK');
  release({ kind: 'verified-task-human-command', action: 'ASK', command, proof: ref });
  await raced;
  await f.update(f.command('DECIDE'));
  await until(() => f.flags.closing);
  expect(await finish).toMatchObject({ status: 'done' });
});
it('retains a failed checkpoint diagnostic and retries only after reconciliation', async () => {
  const f = fixture();
  await f.controller.admit();
  f.flags.suggested = true;
  f.rollover.mockRejectedValueOnce(new Error('checkpoint lost'));
  f.rollover.mockImplementationOnce(async () => {
    f.flags.suggested = false;
  });
  const finish = f.controller.finish(f.technical);
  await until(() => f.diagnostic.mock.calls.length === 1);
  expect(f.flags.phase).toBe('checkpoint-unknown');
  expect(f.rollover).toHaveBeenCalledOnce();
  f.flags.reconcile++;
  await until(() => f.rollover.mock.calls.length === 2);
  expect(f.activities.finishTaskHuman).not.toHaveBeenCalled();
  await f.update(f.command('ASK'));
  await f.update(f.command('DECIDE'));
  await until(() => f.flags.closing);
  expect(await finish).toMatchObject({ status: 'done' });
});
it('rechecks a winning pause after draining and never treats it as permission to finish', async () => {
  const f = fixture();
  await f.controller.admit();
  const finish = f.controller.finish(f.technical);
  await f.update(f.command('ASK'));
  sdk.afterDrain = () => {
    f.flags.active = false;
  };
  await f.update(f.command('DECIDE'));
  await until(() => !f.flags.active);
  expect(f.activities.finishTaskHuman).not.toHaveBeenCalled();
  f.flags.active = true;
  await until(() => f.flags.closing);
  expect(await finish).toMatchObject({ status: 'done' });
});
it.each(['cancelled', 'continue'])(
  'propagates %s from checkpoint/finish without manufacturing another consent',
  async (kind) => {
    const f = fixture();
    await f.controller.admit();
    const error =
      kind === 'cancelled' ? new Error('cancelled') : new sdk.ContinueSignal('continue');
    if (kind === 'continue') {
      f.flags.suggested = true;
      f.rollover.mockRejectedValue(error);
    } else vi.mocked(f.activities.finishTaskHuman).mockRejectedValue(error);
    const finish = f.controller.finish(f.technical),
      rejected = expect(finish).rejects.toThrow(kind);
    if (kind === 'cancelled') {
      await f.update(f.command('ASK'));
      await f.update(f.command('DECIDE'));
    }
    await until(() => (kind === 'continue' ? f.rollover.mock.calls.length > 0 : f.flags.closing));
    await rejected;
  },
);
