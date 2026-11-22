import { join, sep } from 'node:path';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { withChatWriter } from '../adapters/storage/chatWriter.js';
import { unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { localLocator } from '../core/connection.js';
import type { ChatAnchor } from '../core/currentChat.js';
import type { TechnicalState } from '../core/evidence.js';
import type { InputRef } from '../core/localRun.js';
import { object, requireContract } from '../src/contracts/project.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { readH06NativeAttemptForReopen } from './comparisonH06NativeAttempt.js';
import {
  planH06NativeLegacyControl,
  runH06NativeLegacyControlOperator,
} from './comparisonH06NativeLegacyControlOperator.js';
import { prepareH06NativeLegacy } from './comparisonH06NativeLegacyPreparation.js';
import { runH06NativeLegacyTransportPhase } from './comparisonH06NativeLegacyTransportPhase.js';

type Store = Parameters<typeof runH06NativeLegacyControlOperator>[0];
type Control = Parameters<typeof runH06NativeLegacyControlOperator>[1]['control'];
type WriterPhase = Awaited<ReturnType<typeof runH06NativeLegacyTransportPhase>>;
type Phase = Control['phase'];
type Actor = { transcript: string; anchor: ChatAnchor };
type Attempt = {
  claim: H04Pin;
  started: H04Pin;
  preparation: H04Pin;
  actor: Actor;
};
type Paused = { paused: H04Pin; stoppedBy: H04Pin; stopped: InputRef };

export interface H06LegacyActorChat {
  control(
    proposal: { expectedText: string; control: Control },
    signal: AbortSignal,
  ): Promise<Control>;
}

function actorContext(attempt: Attempt, store: Store, signal: AbortSignal) {
  signal.throwIfAborted();
  const { request, grant, workDeadlineMs } = readH06NativeAttemptForReopen(attempt.claim);
  const { binding, evidenceRoot } = request;
  const { context } = store.grant;
  const { anchor, transcript } = attempt.actor;
  requireContract(
    binding.variant === 'legacy' &&
      process.env.CODEX_THREAD_ID === context.actor_id &&
      anchor.thread_id === context.actor_id &&
      anchor.workspace === binding.workspaceRoot &&
      anchor.host_id === 'local' &&
      transcript.startsWith(grant.sessionsRoot + sep) &&
      store.root === join(evidenceRoot, 'legacy-store') &&
      request.runtime.some((pin) => same(pin, attempt.preparation)),
    'h06-legacy-actor-binding',
  );
  const descriptor = localLocator(
    object(JSON.parse(readH04Pin(attempt.preparation).toString())).descriptor,
  );
  const remaining = workDeadlineMs - Date.now();
  requireContract(remaining > 0, 'h06-legacy-actor-deadline');
  const live = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
  const state = () => {
    live.throwIfAborted();
    const current = unwrap<TechnicalState>(
      store.execute({ context, command: { type: 'state', archive: 'current' } }),
    );
    requireContract(
      current.owner === context.actor_id &&
        !current.released &&
        !current.frozen &&
        Date.now() < current.lease_until,
      'h06-legacy-actor-owner',
    );
    return current;
  };
  return {
    binding,
    evidenceRoot,
    context,
    descriptor,
    live,
    state,
    longStageMs: request.stimulus.longStageMs,
  };
}

async function actorControl(
  attempt: Attempt,
  store: Store,
  chat: H06LegacyActorChat,
  phase: Phase,
  retained: Paused | null,
  signal: AbortSignal,
) {
  const { binding, evidenceRoot, context, descriptor, live, state } = actorContext(
    attempt,
    store,
    signal,
  );
  const before = state();
  const current = await new TaskChatContext(
    { execute: async (value) => store.execute(value) },
    context,
    before.generation,
  ).read();
  requireContract(
    same(before, state()) &&
      current.control !== null &&
      current.control.status === (retained === null ? 'active' : 'paused') &&
      current.messages !== null,
    'h06-legacy-actor-state',
  );
  const common = {
    workspaceRoot: binding.workspaceRoot,
    evidenceRoot,
    descriptor,
    ...attempt.actor,
    phase,
    storeRevision: before.revision,
    requirementsRevision: current.messages.requirements_revision,
  };
  const action = retained === null ? 'pause' : 'resume';
  const event = {
    id: `h06-legacy-${phase}-${action}`,
    expected_revision: current.control.revision,
    generation: before.generation,
    thread_id: context.actor_id,
    // The planner never reads this locator. Only the external actor supplies primary authority.
    source: { locator: attempt.actor.transcript + '#L1', hash: '0'.repeat(64) },
  };
  const proposal: Control =
    retained === null
      ? { ...common, event: { ...event, type: 'PAUSE', reason: 'H06/2 retained Writer' } }
      : {
          ...common,
          paused: retained.paused,
          stoppedBy: retained.stoppedBy,
          event: {
            ...event,
            type: 'RESUME',
            marker: `h06-legacy-${phase}-resume-load`,
            stopped: retained.stopped,
          },
        };
  const operation = { claim: attempt.claim, started: attempt.started, control: proposal };
  const { expectedText } = planH06NativeLegacyControl(store, operation);
  const control = structuredClone(
    await chat.control({ expectedText, control: structuredClone(proposal) }, live),
  );
  const { anchor, event: supplied, ...target } = control;
  const {
    source: _source,
    authorization: _authorization,
    ...command
  } = supplied as Control['event'] & { authorization?: InputRef };
  const { anchor: expectedAnchor, event: expectedEvent, ...expectedTarget } = proposal;
  const { source: _placeholder, ...expectedCommand } = expectedEvent;
  requireContract(
    same(target, expectedTarget) &&
      same({ ...anchor, turn_id: expectedAnchor.turn_id }, expectedAnchor) &&
      (supplied.type === 'RESUME' || _authorization === undefined) &&
      same(command, expectedCommand) &&
      same(state(), before) &&
      planH06NativeLegacyControl(store, { ...operation, control }).expectedText === expectedText,
    'h06-legacy-actor-control-changed',
  );
  return control;
}

async function resume(
  attempt: Attempt,
  store: Store,
  chat: H06LegacyActorChat,
  phase: Phase,
  retained: Paused,
  signal: AbortSignal,
) {
  const control = await actorControl(attempt, store, chat, phase, retained, signal);
  return withChatWriter(store.root, () => {
    signal.throwIfAborted();
    return runH06NativeLegacyControlOperator(store, {
      claim: attempt.claim,
      started: attempt.started,
      control,
    });
  });
}

function retained(phase: WriterPhase): Paused {
  return { paused: phase.pause.receipt, stoppedBy: phase.stop.link, stopped: phase.stop.stopped };
}

/** Invoke this stage under the attempt's prepared Store and lease in the real native actor. */
export async function runH06NativeLegacyInitialAndWarm(
  input: Attempt & { initialFailure: H04Pin; warmBrief: H04Pin; coldBrief: H04Pin },
  store: Store,
  chat: H06LegacyActorChat,
  verify: () => void,
  signal: AbortSignal,
) {
  const { initialFailure, warmBrief, coldBrief, ...attempt } = input;
  const { live, longStageMs } = actorContext(attempt, store, signal);
  const prepared = await prepareH06NativeLegacy(
    { claim: attempt.claim, initialFailure, input: attempt.preparation, ...attempt.actor },
    () => {
      live.throwIfAborted();
      verify();
    },
  );
  requireContract(prepared.execution?.status === 'implementing', 'h06-legacy-actor-execution');
  const writer = (
    phase: Phase,
    brief: H04Pin,
    previousResume: H04Pin | null,
    warmThread: H04Pin | null,
  ) =>
    runH06NativeLegacyTransportPhase(
      { claim: attempt.claim, started: attempt.started, phase, brief, previousResume },
      {
        store,
        warmThread,
        async awaitPause(_writer, stageSignal) {
          const commandSignal = AbortSignal.any([live, stageSignal]);
          if (phase === 'warm') await wait(longStageMs, undefined, { signal: commandSignal });
          verify();
          return actorControl(attempt, store, chat, phase, null, commandSignal);
        },
      },
    );
  const warm = await writer('warm', warmBrief, null, null);
  verify();
  const resumed = await resume(attempt, store, chat, 'warm', retained(warm), live);
  verify();
  const cold = await writer('cold', coldBrief, resumed.receipt, warm.thread);
  verify();
  return { attempt, warm, warmResume: resumed, cold };
}

/** Invoke from a new process in the same native actor after the warm process has exited. */
export async function runH06NativeLegacyCold(
  input: Awaited<ReturnType<typeof runH06NativeLegacyInitialAndWarm>>,
  store: Store,
  chat: H06LegacyActorChat,
  signal: AbortSignal,
) {
  return resume(input.attempt, store, chat, 'cold', retained(input.cold), signal);
}
