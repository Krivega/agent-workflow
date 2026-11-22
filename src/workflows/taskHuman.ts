import {
  ApplicationFailure,
  ContinueAsNew,
  allHandlersFinished,
  condition,
  defineQuery,
  defineUpdate,
  setHandler,
  isCancellation,
} from '@temporalio/workflow';
import type { HumanManagedTaskInput } from '../contracts/localTask.js';
import type {
  TaskHumanActivities,
  TaskHumanCommandContext,
  TaskHumanReceipt,
  TaskHumanState,
  TaskHumanTechnicalCompletion,
} from '../contracts/taskHuman.js';
import {
  advanceTaskHumanRequirements,
  applyTaskHumanCommand,
  checkTaskHumanCommand,
  closeTaskHuman,
  copyTaskHumanValue,
  createTaskHumanState,
  retainedTaskHumanReceipt,
  taskHumanBlockers,
  taskHumanCanonical,
} from '../policy/taskHuman.js';
import { requireContract } from '../contracts/project.js';

export const taskHumanState = defineQuery<TaskHumanCommandContext | null>('taskHumanState');
export const taskHuman = defineUpdate<TaskHumanReceipt, [unknown]>('taskHuman');

export function taskHumanController(options: {
  input(): HumanManagedTaskInput;
  closing(): boolean;
  active(): boolean;
  paused(): boolean;
  interrupted(): boolean;
  controlPending(): boolean;
  close(): void;
  phase(value: string): void;
  diagnostic(phase: string, error: string): void;
  reconcile(): number;
  rolloverSuggested(): boolean;
  rollover(state: TaskHumanState, technical: TaskHumanTechnicalCompletion): Promise<void>;
  activities: TaskHumanActivities;
}) {
  let state: TaskHumanState | null = null;
  let technical: TaskHumanTechnicalCompletion | null = null;
  let pending: { id: string; key: string; result: Promise<TaskHumanReceipt> } | null = null;
  const context = (): TaskHumanCommandContext | null =>
    state === null || technical === null ? null : { input: options.input(), state, technical };
  setHandler(taskHumanState, () => {
    const current = context();
    return current === null ? null : copyTaskHumanValue(current);
  });
  setHandler(taskHuman, async (raw) => {
    try {
      requireContract(state !== null && technical !== null, 'human-technical-result-required');
      const command = checkTaskHumanCommand(state, raw),
        key = taskHumanCanonical(command),
        retained = retainedTaskHumanReceipt(state, command);
      if (retained !== null) return retained;
      if (pending?.id === command.commandId) {
        requireContract(pending.key === key, 'human-command-conflict');
        return await pending.result;
      }
      requireContract(pending === null, 'human-command-pending');
      requireContract(!options.controlPending(), 'human-control-pending');
      requireContract(!options.closing() && options.active(), 'human-not-waiting');
      const captured = context()!,
        witness = taskHumanCanonical(captured);
      const result = (async () => {
        const verified = await options.activities.verifyTaskHumanCommand(
          copyTaskHumanValue(captured),
          command,
        );
        requireContract(
          !options.closing() && options.active() && taskHumanCanonical(context()) === witness,
          'human-verification-stale',
        );
        const applied = applyTaskHumanCommand(state!, command, verified);
        state = applied.state;
        return applied.receipt;
      })();
      pending = { id: command.commandId, key, result };
      try {
        return await result;
      } finally {
        pending = null;
      }
    } catch (failure) {
      throw ApplicationFailure.nonRetryable(String(failure), 'TaskHumanCommandRejected');
    }
  });
  return {
    get state() {
      return state;
    },
    get technical() {
      return technical;
    },
    get pending() {
      return pending !== null;
    },
    restore(saved: { humanState: TaskHumanState; technical: TaskHumanTechnicalCompletion | null }) {
      requireContract(!saved.humanState.closed, 'human-checkpoint-closed');
      state = copyTaskHumanValue(saved.humanState);
      technical = copyTaskHumanValue(saved.technical);
    },
    async admit() {
      const bound = await options.activities.prepareTaskHuman(options.input());
      if (state === null) state = createTaskHumanState(bound);
      else if (taskHumanCanonical(state.current) !== taskHumanCanonical(bound)) {
        const before = state;
        state = advanceTaskHumanRequirements(state, {
          kind: 'verified-task-human-requirements',
          commandId: 'requirements-' + bound.manifest.target.requirementsRevision,
          hash: bound.ref.sha256,
          previousManifest: before.current.ref,
          next: bound,
          expectedRevision: before.revision,
          source: options.input().startAdmission,
          proof: bound.ref,
        });
        technical = null;
      }
      requireContract(
        state.current.manifest.target.requirementsRevision ===
          options.input().admission.preparation.revision,
        'human-admission-revision',
      );
    },
    async finish(completed: TaskHumanTechnicalCompletion) {
      requireContract(state !== null, 'human-admission-required');
      technical = completed;
      let failedRolloverAt: number | null = null;
      for (;;) {
        options.phase(
          failedRolloverAt === options.reconcile() ? 'checkpoint-unknown' : 'waiting-human-gates',
        );
        const rollover = () =>
          options.rolloverSuggested() && failedRolloverAt !== options.reconcile();
        await condition(
          () =>
            pending === null &&
            (options.interrupted() ||
              (options.active() && taskHumanBlockers(state!).length === 0) ||
              ((options.active() || options.paused()) && rollover())),
        );
        await condition(allHandlersFinished);
        if (options.interrupted()) throw new Error('human-control-interrupted');
        if (pending !== null) continue;
        if (options.active() && taskHumanBlockers(state).length === 0) break;
        if (rollover()) {
          const observed = options.reconcile();
          try {
            await options.rollover(copyTaskHumanValue(state), copyTaskHumanValue(technical));
          } catch (failure) {
            if (isCancellation(failure) || failure instanceof ContinueAsNew) throw failure;
            failedRolloverAt = observed;
            options.phase('checkpoint-unknown');
            options.diagnostic('checkpoint-unknown', String(failure));
          }
        }
      }
      requireContract(!options.closing() && options.active(), 'human-not-waiting');
      const revision = state.revision;
      state = closeTaskHuman(state, revision);
      options.close();
      options.phase('finishing');
      const request = {
        schemaVersion: 1,
        kind: 'task-human-finish',
        input: options.input(),
        state,
        technical,
        expectedRevision: revision,
      } as const;
      for (;;) {
        try {
          return await options.activities.finishTaskHuman(request);
        } catch (failure) {
          if (isCancellation(failure) || failure instanceof ContinueAsNew) throw failure;
          options.phase('completion-unknown');
          options.diagnostic('completion-unknown', String(failure));
          const observed = options.reconcile();
          await condition(() => options.reconcile() !== observed);
        }
      }
    },
  };
}
