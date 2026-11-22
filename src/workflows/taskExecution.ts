import {
  ActivityCancellationType,
  ApplicationFailure,
  ContinueAsNew,
  CancellationScope,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  allHandlersFinished,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  defineUpdate,
  executeChild,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  ManagedTaskInput,
  AnyManagedTaskInput,
  HumanManagedTaskInput,
  LocalTaskActivities,
  LocalTaskControls,
} from '../contracts/localTask.js';
import type { TaskHumanActivities } from '../contracts/taskHuman.js';
import { taskHumanCanonical } from '../policy/taskHuman.js';
import { taskHumanController } from './taskHuman.js';
import type {
  TaskExecutionControls,
  TaskExecutionOutcome,
  TaskExecutionProgress,
  TaskExecutionBudget,
  TaskExecutionCompletion,
  TaskExecutionDiagnostic,
} from '../contracts/taskExecution.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { ReaderCommandAck, PayloadReaderCommand } from '../contracts/readerControl.js';
import { localTaskKey, parseLocalTask } from '../policy/localTask.js';
import { parsePayloadReaderCommand, readerCommandText } from '../policy/readerControl.js';
import { taskExecutionCommand, taskHumanExecutionCommand } from '../policy/taskExecution.js';
import { reviewKey } from '../policy/review.js';
import { requireContract } from '../contracts/project.js';
import { ReviewWorkflow } from './review.js';

export const taskExecutionControl = defineUpdate<ReaderCommandAck, [unknown]>(
  'taskExecutionControl',
);

export async function ManagedTaskWorkflow(
  raw: AnyManagedTaskInput,
  checkpoint: ArtifactRef | null = null,
): Promise<TaskExecutionCompletion> {
  let initial: AnyManagedTaskInput;
  try {
    const parsed = parseLocalTask(raw);
    requireContract(
      (parsed.schemaVersion === 11 || parsed.schemaVersion === 12) &&
        parsed.continuation.attempt === 0,
      'task-continuation-start-forbidden',
    );
    requireContract(
      workflowInfo().workflowId === localTaskKey(parsed),
      'task-workflow-target-mismatch',
    );
    initial = parsed;
    if (parsed.schemaVersion === 12 && checkpoint !== null)
      requireContract(
        typeof workflowInfo().continuedFromExecutionRunId === 'string',
        'human-checkpoint-server-continuation-required',
      );
  } catch (failure) {
    throw ApplicationFailure.nonRetryable(String(failure), 'LocalTaskRejected');
  }
  let input = initial,
    revision = 0,
    reconcile = 0,
    waiting = false,
    admitted = false,
    closing = false,
    error = '',
    stopFailure = '',
    budgetFailure = '',
    checkpointFailure = '',
    restored = checkpoint === null,
    budget: TaskExecutionBudget | null = null,
    previousCheckpoint = checkpoint,
    held: ArtifactRef | null = null,
    resumed: AnyManagedTaskInput | null = null,
    recheck: { authorization: ArtifactRef; held: ArtifactRef } | null = null,
    humanReplan: HumanManagedTaskInput | null = null,
    requested: { command: PayloadReaderCommand; ack: ReaderCommandAck } | null = null,
    scope: CancellationScope | null = null;
  let progress: TaskExecutionProgress = {
    phase: 'admitting',
    snapshot: null,
    planning: null,
    records: [],
  };
  let began = Date.now();
  const history: ArtifactRef[] = [],
    commands: ArtifactRef[] = [],
    diagnostics: TaskExecutionDiagnostic[] = [];
  const activities = proxyActivities<LocalTaskActivities>({
    startToCloseTimeout: '30 minutes',
    heartbeatTimeout: '10 seconds',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });
  const controls = proxyActivities<TaskExecutionControls & LocalTaskControls & TaskHumanActivities>(
    {
      taskQueue: workflowInfo().taskQueue + '.control',
      startToCloseTimeout: '1 minute',
      cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
      retry: { maximumAttempts: 1 },
    },
  );
  let pending: { id: string; key: string; result: Promise<ReaderCommandAck> } | null = null;
  const human =
    initial.schemaVersion === 12
      ? taskHumanController({
          input: () => {
            requireContract(input.schemaVersion === 12, 'human-input-required');
            return input;
          },
          closing: () => closing,
          active: () => admitted && !waiting && requested === null && humanReplan === null,
          paused: () => admitted && waiting && requested === null && humanReplan === null,
          interrupted: () => requested !== null || humanReplan !== null,
          controlPending: () => pending !== null,
          close: () => {
            closing = true;
          },
          phase: (phase) => {
            progress.phase = phase;
          },
          diagnostic: (phase, error) => {
            diagnostics.push({ phase, error });
          },
          reconcile: () => reconcile,
          rolloverSuggested: () =>
            workflowInfo().continueAsNewSuggested && budget !== null && budgetFailure === '',
          async rollover(humanState, technical) {
            requireContract(
              initial.schemaVersion === 12 && input.schemaVersion === 12 && budget !== null,
              'human-checkpoint-input',
            );
            const witness = taskHumanCanonical({ input, revision, humanState, technical }),
              saved = await controls.saveTaskHumanCheckpoint({
                schemaVersion: 2,
                producer: { workflowId: workflowInfo().workflowId, runId: workflowInfo().runId },
                initial,
                input,
                revision,
                history,
                commands,
                previous: previousCheckpoint,
                budget,
                beganAt: began,
                diagnostics,
                humanState,
                technical,
                wait: { kind: 'human-gates', paused: waiting },
              });
            await condition(() => pending === null && !human!.pending && allHandlersFinished());
            if (
              !closing &&
              taskHumanCanonical({
                input,
                revision,
                humanState: human!.state,
                technical: human!.technical,
              }) === witness
            )
              return continueAsNew<typeof ManagedTaskWorkflow>(initial, saved);
          },
          activities: controls,
        })
      : null;
  function currentRequest(): { command: PayloadReaderCommand; ack: ReaderCommandAck } | null {
    return requested;
  }
  setHandler(defineQuery('localTaskInput'), () => initial);
  setHandler(defineQuery('localTaskStatus'), () => ({
    phase: progress.phase,
    error,
    stopFailure,
    snapshot: progress.snapshot,
    revision,
    attempt: input.continuation.attempt,
    requirementsRevision: input.admission.preparation.revision,
    waiting,
    held,
    history,
    commands,
    checkpoint: previousCheckpoint,
    checkpointFailure,
    budget: budgetFailure === '' ? budget : null,
    budgetFailure,
    runId: workflowInfo().runId,
    elapsedMs: Date.now() - began,
    diagnostics,
  }));
  setHandler(defineSignal('localTaskReconcile'), () => {
    reconcile++;
  });
  setHandler(taskExecutionControl, async (value) => {
    try {
      const command = parsePayloadReaderCommand(value),
        key = command.hash + readerCommandText(command);
      if (pending?.id === command.commandId) {
        requireContract(pending.key === key, 'task-command-id-conflict');
        return await pending.result;
      }
      requireContract(pending === null, 'task-command-pending');
      const result = (async () => {
        await condition(() => restored || closing);
        const previous = await controls.findTaskExecutionCommand(input, command);
        if (previous !== null && previous.revision <= revision) return previous;
        requireContract(!closing, 'task-already-closed');
        await condition(() => admitted || closing);
        requireContract(!closing, 'task-already-closed');
        if (input.schemaVersion === 12 && human?.state !== null && human?.technical != null) {
          requireContract(!human!.pending, 'human-command-pending');
          taskHumanExecutionCommand(input, command, revision);
          requireContract(command.action !== 'pause' || !waiting, 'task-control-not-running');
          const captured = { input, state: human!.state!, technical: human!.technical },
            witness = taskHumanCanonical({ context: captured, revision }),
            outcome = await controls.controlTaskHumanExecution(captured, command, revision);
          requireContract(
            !closing &&
              taskHumanCanonical({
                context: { input, state: human!.state, technical: human!.technical },
                revision,
              }) === witness,
            'human-verification-stale',
          );
          const next = parseLocalTask(outcome.input);
          requireContract(
            next.schemaVersion === 12 &&
              outcome.ack.commandId === command.commandId &&
              outcome.ack.hash === command.hash &&
              outcome.ack.revision === revision + 1,
            'task-command-receipt-invalid',
          );
          const changed =
            next.admission.preparation.revision !== input.admission.preparation.revision;
          requireContract(
            command.action === 'resume' || taskHumanCanonical(next) === taskHumanCanonical(input),
            'human-control-input-change',
          );
          requireContract(
            changed
              ? next.admission.preparation.revision === input.admission.preparation.revision + 1 &&
                  next.continuation.attempt === input.continuation.attempt + 1 &&
                  command.attempt === next.continuation.attempt
              : taskHumanCanonical(next) === taskHumanCanonical(input) &&
                  command.attempt === input.continuation.attempt,
            'human-control-input-change',
          );
          revision = outcome.ack.revision;
          commands.push(outcome.ack.authorization);
          if (changed) {
            humanReplan = next;
            scope?.cancel();
          } else if (command.action === 'pause') {
            waiting = true;
            progress.phase = 'human-paused';
          } else if (command.action === 'resume') {
            waiting = false;
            progress.phase = 'waiting-human-gates';
          } else {
            requested = { command, ack: outcome.ack };
            scope?.cancel();
          }
          return outcome.ack;
        }
        taskExecutionCommand(input, command, revision);
        if (command.action === 'resume') {
          requireContract(
            budgetFailure === '' && checkpointFailure === '',
            'task-budget-or-checkpoint-unknown',
          );
          requireContract(waiting && held !== null, 'task-resume-not-held');
          const sameAttempt = command.attempt === input.continuation.attempt;
          requireContract(
            !sameAttempt ||
              (input.schemaVersion === 12 && patched('task-held-integrated-recheck-v1')),
            'task-command-stale',
          );
          const outcome = await controls.resumeTaskExecution(input, held, command, revision);
          const next = parseLocalTask(outcome.input);
          requireContract(
            (next.schemaVersion === 11 || next.schemaVersion === 12) &&
              next.schemaVersion === initial.schemaVersion &&
              next.continuation.attempt === command.attempt &&
              outcome.ack.hash === command.hash &&
              outcome.ack.commandId === command.commandId &&
              outcome.ack.revision === revision + 1,
            'task-command-receipt-invalid',
          );
          revision = outcome.ack.revision;
          commands.push(outcome.ack.authorization);
          if (sameAttempt) {
            requireContract(
              taskHumanCanonical(input) === taskHumanCanonical(next),
              'task-recheck-admission-changed',
            );
            recheck = { authorization: outcome.ack.authorization, held };
          }
          resumed = next;
          waiting = false;
          return outcome.ack;
        }
        requireContract(
          requested === null && (!waiting || command.action === 'cancel'),
          'task-control-not-running',
        );
        const ack = await controls.interruptTaskExecution(input, command, revision);
        requireContract(
          ack.hash === command.hash &&
            ack.commandId === command.commandId &&
            ack.revision === revision + 1,
          'task-command-receipt-invalid',
        );
        revision = ack.revision;
        commands.push(ack.authorization);
        requested = { command, ack };
        scope?.cancel();
        return ack;
      })();
      pending = { id: command.commandId, key, result };
      try {
        return await result;
      } finally {
        pending = null;
      }
    } catch (failure) {
      throw ApplicationFailure.nonRetryable(String(failure), 'TaskCommandRejected');
    }
  });

  async function execute(): Promise<TaskExecutionOutcome> {
    progress.phase = 'planning';
    const planning = await activities.prepareSubstantialPlanning(input);
    progress.planning = planning;
    progress.records.push(planning.request);
    const reviewed = await executeChild(ReviewWorkflow, {
      args: [planning],
      workflowId: reviewKey(planning),
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    });
    const planningResult = reviewed.status === 'reviewed' ? reviewed.manifest : reviewed.plan;
    progress.records.push(planningResult);
    requireContract(
      reviewed.status === 'reviewed' && reviewed.complete,
      'task-planning-failed:' + planningResult.sha256,
    );
    progress.phase = 'preparing';
    const snapshot = await activities.prepareLocalTask(input, reviewed.manifest);
    progress.snapshot = snapshot;
    progress.records.push(snapshot);
    progress.phase = 'baseline';
    const baseline = await activities.checkLocalTask(input, snapshot, 'baseline', null, null);
    progress.records.push(baseline.manifest);
    requireContract(baseline.status === 'PASS', 'task-baseline-failed:' + baseline.manifest.sha256);
    progress.phase = 'writing';
    const writer = await activities.writeLocalTask(input, snapshot);
    progress.records.push(writer.answer, writer.stop, writer.tree);
    progress.phase = 'candidate-checks';
    const candidate = await activities.checkLocalTask(input, snapshot, 'candidate', writer, null);
    progress.records.push(candidate.manifest);
    requireContract(
      candidate.status === 'PASS',
      'task-candidate-checks-failed:' + candidate.manifest.sha256,
    );
    progress.phase = 'integration';
    const intent = await activities.planLocalIntegration(
      input,
      snapshot,
      writer,
      candidate.manifest,
    );
    progress.records.push(intent);
    const integration = await activities.integrateLocalTask(input, snapshot, intent);
    progress.records.push(integration);
    progress.phase = 'integrated-checks';
    const checked = await activities.checkLocalTask(
      input,
      snapshot,
      'integrated',
      writer,
      integration,
    );
    progress.records.push(checked.manifest);
    requireContract(
      checked.status === 'PASS',
      'task-integrated-checks-failed:' + checked.manifest.sha256,
    );
    progress.phase = 'acceptance';
    const packet = await activities.prepareLocalAcceptance(
      input,
      snapshot,
      writer,
      candidate.manifest,
      intent,
      integration,
      checked.manifest,
      baseline.manifest,
    );
    progress.records.push(packet.request);
    return accept(snapshot, packet);
  }
  function takeRecheck(): { authorization: ArtifactRef; held: ArtifactRef } | null {
    const retry = recheck;
    recheck = null;
    return retry;
  }
  async function recheckTransferred(authorization: ArtifactRef) {
    requireContract(input.schemaVersion === 12, 'human-input-required');
    progress.phase = 'integrated-checks';
    const verified = await activities.recheckIntegratedTask(input, authorization);
    progress.snapshot = verified.snapshot;
    progress.records.push(...verified.records);
    progress.phase = 'acceptance';
    return accept(verified.snapshot, verified.packet);
  }
  async function accept(
    snapshot: ArtifactRef,
    packet: Awaited<ReturnType<LocalTaskActivities['prepareLocalAcceptance']>>,
  ) {
    const accepted = await executeChild(ReviewWorkflow, {
      args: [packet],
      workflowId: reviewKey(packet),
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    });
    const acceptanceResult = accepted.status === 'reviewed' ? accepted.manifest : accepted.plan;
    progress.records.push(acceptanceResult);
    requireContract(
      accepted.status === 'reviewed' && accepted.complete,
      'task-acceptance-failed:' + acceptanceResult.sha256,
    );
    if (human !== null) {
      requireContract(input.schemaVersion === 12, 'human-input-required');
      const stopped = await controls.stopLocalTask(input);
      return human.finish({
        input,
        snapshot,
        packet,
        acceptance: accepted.manifest,
        records: [...progress.records],
        stopped,
      });
    }
    progress.phase = 'finishing';
    return activities.finishLocalTask(input, snapshot, packet, accepted.manifest);
  }
  async function stop() {
    return CancellationScope.nonCancellable(async () => {
      for (;;) {
        progress.phase = 'stopping';
        try {
          return await controls.stopLocalTask(input);
        } catch (failure) {
          stopFailure = String(failure);
          diagnostics.push({ phase: 'stop-unknown', error: stopFailure });
          progress.phase = 'stop-unknown';
          const observed = reconcile;
          await condition(() => reconcile !== observed);
        }
      }
    });
  }
  function summary() {
    return {
      history,
      commands,
      checkpoint: previousCheckpoint,
      budget: budgetFailure === '' ? budget : null,
      budgetFailure,
      elapsedMs: Date.now() - began,
      diagnostics,
    };
  }
  async function observeBudget() {
    try {
      const value = await controls.captureTaskExecutionBudget(input, budget?.manifest ?? null);
      requireContract(
        Number.isSafeInteger(value.limit) &&
          Number.isSafeInteger(value.used) &&
          value.used >= 0 &&
          value.used <= value.limit,
        'task-budget-receipt-invalid',
      );
      requireContract(
        (value.extendedFrom === undefined || value.extendedFrom.runId === workflowInfo().runId) &&
          (budget === null ||
            ((value.limit === budget.limit ||
              (value.limit > budget.limit &&
                value.extendedFrom?.sha256 === budget.manifest.sha256 &&
                value.extendedFrom.bytes === budget.manifest.bytes)) &&
              value.used >= budget.used)),
        'task-budget-rewound',
      );
      budget = { limit: value.limit, used: value.used, manifest: value.manifest };
      budgetFailure = '';
    } catch (failure) {
      budgetFailure = String(failure);
      diagnostics.push({ phase: 'budget-unknown', error: budgetFailure });
      throw failure;
    }
  }
  async function finalBudget() {
    try {
      await CancellationScope.nonCancellable(observeBudget);
    } catch {
      /* Preserve unknown usage; it never becomes zero. */
    }
  }
  function cancelled(
    stopped: ArtifactRef,
  ): Extract<TaskExecutionCompletion, { status: 'cancelled' }> {
    return { status: 'cancelled', stop: stopped, held, error, stopFailure, ...summary() };
  }
  async function waitHeld(
    stopped: ArtifactRef,
  ): Promise<Extract<TaskExecutionCompletion, { status: 'cancelled' }> | null> {
    waiting = true;
    progress.phase = 'waiting-human';
    const readyForRollover = () =>
      workflowInfo().continueAsNewSuggested &&
      checkpointFailure === '' &&
      budgetFailure === '' &&
      budget !== null;
    try {
      for (;;) {
        if (readyForRollover()) {
          await condition(() => pending === null && allHandlersFinished());
          if (resumed === null && requested === null) {
            const observedRevision = revision,
              observedHeld = held;
            try {
              const saved =
                initial.schemaVersion === 12
                  ? await controls.saveTaskHumanCheckpoint({
                      schemaVersion: 2,
                      producer: {
                        workflowId: workflowInfo().workflowId,
                        runId: workflowInfo().runId,
                      },
                      initial,
                      input: input as HumanManagedTaskInput,
                      revision,
                      history,
                      commands,
                      previous: previousCheckpoint,
                      budget: budget!,
                      beganAt: began,
                      diagnostics,
                      humanState: human!.state!,
                      technical: human!.technical,
                      wait: { kind: 'execution-held', held: held!, stop: stopped },
                    })
                  : await controls.saveTaskExecutionCheckpoint({
                      initial,
                      input: input as ManagedTaskInput,
                      revision,
                      held: held!,
                      history,
                      commands,
                      previous: previousCheckpoint,
                      budget: budget!,
                      beganAt: began,
                      diagnostics,
                    });
              await condition(() => pending === null && allHandlersFinished());
              if (
                revision === observedRevision &&
                held === observedHeld &&
                resumed === null &&
                requested === null
              )
                return continueAsNew<typeof ManagedTaskWorkflow>(initial, saved);
            } catch (failure) {
              if (
                isCancellation(failure) ||
                (initial.schemaVersion === 12 && failure instanceof ContinueAsNew)
              )
                throw failure;
              checkpointFailure = String(failure);
              diagnostics.push({ phase: 'checkpoint-unknown', error: checkpointFailure });
              progress.phase = 'checkpoint-unknown';
            }
          }
        }
        const observedReconcile = reconcile;
        await condition(
          () =>
            pending === null &&
            (resumed !== null ||
              requested !== null ||
              reconcile !== observedReconcile ||
              readyForRollover()),
        );
        if (resumed !== null || requested !== null) break;
        checkpointFailure = '';
        progress.phase = 'waiting-human';
      }
    } catch (failure) {
      if (!isCancellation(failure)) throw failure;
      diagnostics.push({ phase: progress.phase, error: String(failure) });
      closing = true;
      waiting = false;
      return CancellationScope.nonCancellable(async () => {
        const confirmed = await stop();
        await condition(allHandlersFinished);
        await finalBudget();
        progress.phase = 'cancelled';
        return cancelled(confirmed);
      });
    }
    if (requested !== null) {
      closing = true;
      waiting = false;
      await CancellationScope.nonCancellable(async () => condition(allHandlersFinished));
      progress.phase = 'cancelled';
      return cancelled(stopped);
    }
    input = resumed!;
    resumed = null;
    error = '';
    stopFailure = '';
    checkpointFailure = '';
    return null;
  }
  if (checkpoint !== null) {
    progress.phase = 'restoring';
    const saved = await CancellationScope.nonCancellable(async () => {
      for (;;) {
        try {
          return initial.schemaVersion === 12
            ? await controls.loadTaskHumanCheckpoint(
                initial,
                checkpoint,
                workflowInfo().continuedFromExecutionRunId!,
              )
            : await controls.loadTaskExecutionCheckpoint(initial, checkpoint);
        } catch (failure) {
          checkpointFailure = String(failure);
          diagnostics.push({ phase: 'checkpoint-unknown', error: checkpointFailure });
          progress.phase = 'checkpoint-unknown';
          const observed = reconcile;
          await condition(() => reconcile !== observed);
        }
      }
    });
    input = saved.input;
    revision = saved.revision;
    held =
      'schemaVersion' in saved
        ? saved.wait.kind === 'execution-held'
          ? saved.wait.held
          : null
        : saved.held;
    budget = saved.budget;
    began = saved.beganAt;
    checkpointFailure = '';
    admitted = true;
    restored = true;
    if ('schemaVersion' in saved) {
      requireContract(
        initial.schemaVersion === 12 && saved.schemaVersion === 2,
        'human-checkpoint-version',
      );
      human!.restore(saved);
      history.push(...saved.history);
      commands.push(...saved.commands);
      if (patched('task-human-restore-diagnostic-order')) diagnostics.unshift(...saved.diagnostics);
      else diagnostics.push(...saved.diagnostics);
      previousCheckpoint = checkpoint;
      if (saved.wait.kind === 'execution-held') {
        const result = await waitHeld(saved.wait.stop);
        if (result !== null) return result;
      } else waiting = saved.wait.paused;
    } else {
      if (patched('task-execution-restore-checkpoint-evidence')) {
        history.push(...saved.history);
        commands.push(...saved.commands);
        diagnostics.unshift(...saved.diagnostics);
      }
      const result = await waitHeld(saved.stop);
      if (result !== null) return result;
    }
  }
  for (;;) {
    progress = { phase: 'admitting', snapshot: null, planning: null, records: [] };
    admitted = false;
    const retry = takeRecheck();
    held = null;
    const humanPaused = human?.technical != null && waiting;
    let wasCancelled = false;
    let running: Promise<{ result: TaskExecutionOutcome } | { failure: unknown }> | null = null;
    scope = new CancellationScope();
    try {
      progress.records.push(await controls.prepareTaskExecution(input));
      if (human !== null) await human.admit();
      await observeBudget();
      admitted = true;
      if (humanPaused) waiting = true;
      await condition(() => pending === null);
      if (requested === null) {
        running = scope
          .run(() =>
            human?.technical !== null && human?.technical !== undefined
              ? human.finish(human.technical)
              : retry
                ? recheckTransferred(retry.authorization)
                : execute(),
          )
          .then(
            (result) => ({ result }),
            (failure: unknown) => ({ failure }),
          );
        const outcome = await Promise.race([
          running,
          condition(() => requested !== null).then(() => null),
        ]);
        if (outcome !== null && 'result' in outcome) {
          closing = true;
          await finalBudget();
          await condition(allHandlersFinished);
          progress.phase = 'done';
          return { ...outcome.result, ...summary() };
        }
        if (outcome !== null) {
          if (human !== null && outcome.failure instanceof ContinueAsNew) throw outcome.failure;
          error = String(outcome.failure);
          diagnostics.push({ phase: progress.phase, error });
          wasCancelled = isCancellation(outcome.failure);
        }
      }
    } catch (failure) {
      if (human !== null && failure instanceof ContinueAsNew) throw failure;
      error = String(failure);
      diagnostics.push({ phase: progress.phase, error });
      wasCancelled = isCancellation(failure);
    }
    admitted = true;
    scope.cancel();
    const failedAt = progress.phase,
      stopped = human?.technical?.stopped ?? (await stop());
    await CancellationScope.nonCancellable(async () => {
      if (running !== null) await running;
      await condition(allHandlersFinished);
      await finalBudget();
    });
    const interruption = currentRequest();
    requested = null;
    if (human?.technical != null) {
      if (humanReplan !== null) {
        input = humanReplan;
        humanReplan = null;
        waiting = false;
        error = '';
        stopFailure = '';
        checkpointFailure = '';
        continue;
      }
      if (wasCancelled || interruption?.command.action === 'cancel') {
        closing = true;
        progress.phase = 'cancelled';
        return cancelled(stopped);
      }
      progress.phase = 'human-admission-unknown';
      const observed = reconcile;
      let cancelledWhileWaiting = false;
      try {
        await condition(
          () => reconcile !== observed || currentRequest() !== null || humanReplan !== null,
        );
      } catch (failure) {
        if (!isCancellation(failure)) throw failure;
        cancelledWhileWaiting = true;
      }
      const late = currentRequest();
      if (cancelledWhileWaiting || late?.command.action === 'cancel') {
        closing = true;
        await condition(allHandlersFinished);
        progress.phase = 'cancelled';
        return cancelled(stopped);
      }
      if (humanReplan !== null) {
        input = humanReplan;
        humanReplan = null;
        waiting = false;
      }
      error = '';
      continue;
    }
    const heldResult = retry
      ? { status: 'held' as const, held: retry.held }
      : await CancellationScope.nonCancellable(() =>
          controls.holdTaskExecution(
            input,
            { ...progress, phase: failedAt },
            stopped,
            error,
            interruption?.ack ?? null,
          ),
        );
    if (heldResult.status === 'done') {
      closing = true;
      progress.phase = 'done';
      return { ...heldResult, ...summary() };
    }
    held = heldResult.held;
    history.push(held);
    if (wasCancelled || interruption?.command.action === 'cancel') {
      closing = true;
      progress.phase = 'cancelled';
      return cancelled(stopped);
    }
    const result = await waitHeld(stopped);
    if (result !== null) return result;
  }
}
