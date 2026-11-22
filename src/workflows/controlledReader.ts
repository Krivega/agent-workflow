import {
  allHandlersFinished,
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { ArtifactRef, PreparationResult } from '../contracts/preparation.js';
import type { ReaderInput, ReaderSession } from '../contracts/reader.js';
import type {
  ControlledReaderActivities,
  ReaderCommandAck,
  ReaderControlActivities,
  ReaderControlState,
  ReaderStatus,
  ReaderPhase,
} from '../contracts/readerControl.js';
import { requireContract } from '../contracts/project.js';
import {
  checkReaderTarget,
  nextReaderControl,
  parseReaderCommand,
  parseReaderInput,
  readerCommandText,
  readerTarget,
} from '../policy/readerControl.js';
import { readerDiagnostic, readerOperation } from '../policy/readerStatus.js';

export const readerControl = defineUpdate<ReaderCommandAck, [unknown]>('readerControl');
export const readerStatus = defineQuery<ReaderStatus>('readerStatus');
export const readerReconcile = defineSignal('readerReconcile');
export const readerInput = defineQuery<ReaderInput>('readerInput');

function failureText(failure: unknown): string {
  return String(
    failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure,
  );
}

export async function ControlledReaderWorkflow(input: ReaderInput) {
  const workflowId = workflowInfo().workflowId;
  try {
    input = parseReaderInput(input);
    readerTarget(input, workflowId);
  } catch (failure) {
    throw ApplicationFailure.nonRetryable(String(failure), 'ReaderStartRejected');
  }
  const controls = proxyActivities<ReaderControlActivities>({
    taskQueue: workflowInfo().taskQueue + '.control',
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 1 },
  });
  const models = proxyActivities<ControlledReaderActivities>({
    startToCloseTimeout: '20 minutes',
    heartbeatTimeout: '10 seconds',
    retry: { maximumAttempts: 2, initialInterval: '1 second', maximumInterval: '1 second' },
  });
  let state: ReaderControlState = { mode: 'running', revision: 0, attempt: 0 };
  let phase: ReaderPhase = 'registering';
  let permit: ArtifactRef | null = null,
    prepared: PreparationResult | null = null,
    session: ReaderSession | null = null,
    load: ArtifactRef | null = null;
  let scope: CancellationScope | null = null;
  let verifying = 0,
    notice = 0;
  let error = '',
    pendingStop = false,
    cancel = false,
    stopping = false,
    reloadRequired = false;
  const accepted = new Map<string, { key: string; ack: ReaderCommandAck }>();
  const pending = new Map<string, { key: string; result: Promise<ReaderCommandAck> }>();
  setHandler(readerInput, () => input);
  setHandler(readerStatus, () => ({
    schemaVersion: 1,
    ...state,
    target: readerTarget(input, workflowId),
    runId: workflowInfo().runId,
    taskQueue: workflowInfo().taskQueue,
    workerVersion: workflowInfo().currentBuildId ?? null,
    phase,
    permit,
    session: session?.id ?? null,
    error,
    operation: readerOperation(input, phase, state.attempt, stopping),
    diagnostic: readerDiagnostic(state, error, stopping),
  }));
  setHandler(readerReconcile, () => {
    notice++;
  });
  setHandler(readerControl, async (raw) => {
    try {
      const command = parseReaderCommand(raw);
      checkReaderTarget(command, input, workflowId);
      const key = command.hash + readerCommandText(command);
      const previous = accepted.get(command.commandId);
      if (previous !== undefined) {
        requireContract(previous.key === key, 'reader-command-id-conflict');
        return previous.ack;
      }
      const existing = pending.get(command.commandId);
      if (existing !== undefined) {
        requireContract(existing.key === key, 'reader-command-id-conflict');
        return await existing.result;
      }
      nextReaderControl(state, command);
      if (command.action === 'resume' && reloadRequired)
        requireContract(command.attempt > state.attempt, 'reader-reload-attempt-required');
      verifying++;
      const result = (async () => {
        try {
          await condition(() => permit !== null);
          const ack = await controls.applyReaderCommand(input, permit!, command);
          const next = nextReaderControl(state, command);
          requireContract(
            ack.commandId === command.commandId &&
              ack.hash === command.hash &&
              ack.revision === next.revision,
            'reader-command-receipt-invalid',
          );
          state = next;
          if (command.action === 'resume' && reloadRequired) {
            phase = 'loading';
            load = null;
            reloadRequired = false;
          }
          if (command.action !== 'resume') {
            pendingStop = true;
            cancel = command.action === 'cancel';
            scope?.cancel();
          }
          error = '';
          accepted.set(command.commandId, { key, ack });
          return ack;
        } finally {
          verifying--;
        }
      })();
      pending.set(command.commandId, { key, result });
      try {
        return await result;
      } finally {
        pending.delete(command.commandId);
      }
    } catch (failure) {
      throw ApplicationFailure.nonRetryable(String(failure), 'ReaderCommandRejected');
    }
  });
  async function run() {
    for (;;) {
      if (permit === null) {
        try {
          permit = await controls.registerReader(input, workflowId);
          phase = 'preparing';
        } catch (failure) {
          error = failureText(failure);
          state = { ...state, mode: 'blocked' };
          const observed = notice;
          await condition(() => notice !== observed);
          state = { ...state, mode: 'running' };
        }
        continue;
      }
      await condition(() => verifying === 0);
      if (pendingStop) {
        stopping = true;
        try {
          const stopped = await controls.stopReader(input, permit, state.revision);
          requireContract(stopped.status === 'stopped', 'reader-stop-unconfirmed');
          state = { ...state, mode: cancel ? 'cancelled' : 'paused' };
          pendingStop = false;
          stopping = false;
          error = '';
          if (cancel) {
            await condition(allHandlersFinished);
            return { status: 'cancelled' as const, stop: stopped.receipt };
          }
        } catch (failure) {
          error = failureText(failure);
          state = { ...state, mode: 'blocked' };
          const observed = notice;
          await condition(() => notice !== observed || state.mode !== 'blocked');
        }
        continue;
      }
      if (state.mode !== 'running') {
        const observed = notice;
        await condition(() => state.mode === 'running' || pendingStop || notice !== observed);
        if (state.mode === 'blocked') state = { ...state, mode: 'running' };
        continue;
      }
      const revision = state.revision;
      const epoch = { permit, revision, attempt: state.attempt };
      scope = new CancellationScope();
      try {
        const currentPhase = phase;
        const value = await scope.run(async () => {
          if (currentPhase === 'preparing') return models.prepareControlledReader(input, epoch);
          if (currentPhase === 'creating') return models.createReader(input, prepared!, epoch);
          if (currentPhase === 'loading')
            return models.loadReader(input, prepared!, session!, epoch);
          return models.answerReader(input, prepared!, session!, load!, epoch);
        });
        await condition(() => verifying === 0);
        if (state.revision !== revision || state.mode !== 'running') continue;
        error = '';
        if (currentPhase === 'preparing') {
          prepared = value as PreparationResult;
          phase = 'creating';
        } else if (currentPhase === 'creating') {
          session = value as ReaderSession;
          phase = 'loading';
        } else if (currentPhase === 'loading') {
          load = value as ArtifactRef;
          phase = 'answering';
        } else {
          state = { ...state, mode: 'answered' };
          await condition(allHandlersFinished);
          return { status: 'answered' as const, answer: value as ArtifactRef };
        }
      } catch (failure) {
        if (isCancellation(failure) && !pendingStop) throw failure;
        if (state.mode === 'running') {
          error = failureText(failure);
          if (error.includes('reader-context-compacted:')) reloadRequired = true;
          state = { ...state, mode: 'blocked' };
        }
      } finally {
        scope = null;
      }
    }
  }
  try {
    return await run();
  } catch (failure) {
    if (!isCancellation(failure)) throw failure;
    return CancellationScope.nonCancellable(async () => {
      stopping = true;
      for (;;) {
        try {
          permit ??= await controls.registerReader(input, workflowId);
          const revision = await controls.freezeReader(input, permit);
          state = { ...state, revision, mode: 'cancelling' };
          const stopped = await controls.stopReader(input, permit, revision);
          requireContract(stopped.status === 'stopped', 'reader-stop-unconfirmed');
          state = { ...state, mode: 'cancelled' };
          stopping = false;
          error = '';
          await condition(allHandlersFinished);
          return { status: 'cancelled' as const, stop: stopped.receipt };
        } catch (problem) {
          error = failureText(problem);
          state = { ...state, mode: 'blocked' };
          const observed = notice;
          await condition(() => notice !== observed);
        }
      }
    });
  }
}
