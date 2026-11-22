import { createChatControl, applyChatControl } from '../core/chatControl.js';
import type { ChatControlEvent } from '../core/chatControl.js';
import { requireWorkflow, textField } from '../core/connection.js';
import { sameValue } from '../core/equality.js';
import { applyLocalEvent } from '../core/localRun.js';
import type { ChatContext, ChatContextJournal } from '../ports/chatContext.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import type { ChatRecovery } from '../ports/chatRecovery.js';
import type { RunInputs } from '../ports/localRuns.js';
import type { UserCommands } from '../ports/userCommands.js';

export async function initializeChatControl(
  journal: ChatContextJournal,
  host: Pick<CurrentChatHost, 'observe'>,
) {
  const state = await journal.read();
  if (state.control !== null) return state.control;
  const control = createChatControl(await host.observe(), state.run.generation);
  await journal.save(state, { ...state, control }, 'chat:control:begin');
  return control;
}
export async function advanceChatControl(
  event: ChatControlEvent,
  journal: ChatContextJournal,
  host: CurrentChatHost,
  inputs: RunInputs,
  recovery: ChatRecovery,
  commands?: UserCommands,
) {
  const { state, next } = await prepareChatControl(
    event,
    await journal.read(),
    host,
    inputs,
    recovery,
    commands,
  );
  if (next !== state) await journal.save(state, next, 'chat:control:' + event.id);
  return next;
}
export async function prepareChatControl(
  event: ChatControlEvent,
  state: ChatContext,
  host: CurrentChatHost,
  inputs: RunInputs,
  recovery: ChatRecovery,
  commands?: UserCommands,
) {
  requireWorkflow(state.control !== null, 'chat-control-missing');
  const observed = await host.observe();
  if (event.type === 'RESUME' && event.previous_source_turn !== undefined) {
    const prior = state.control.history.at(-1);
    const accepted = prior === undefined ? null : (JSON.parse(prior.payload) as ChatControlEvent);
    requireWorkflow(
      state.control.status === 'active' &&
        event.authorization === undefined &&
        accepted?.type === 'RESUME' &&
        sameValue(event.source, accepted.source),
      'chat-continuation-human-unaccepted',
    );
    await host.message(event.source, textField(event.previous_source_turn));
  }
  if (event.type === 'RESUME' && event.authorization !== undefined) {
    requireWorkflow(commands !== undefined, 'chat-command-verifier-required');
    requireWorkflow(sameValue(event.source, event.authorization), 'chat-command-source-mismatch');
    requireWorkflow('task_id' in state.run.spec.identity, 'chat-command-task-required');
    await commands.verify(event.authorization, {
      project_id: state.run.spec.project_id,
      task_id: state.run.spec.identity.task_id,
      run_id: state.run.spec.run_id,
      thread_id: observed.thread_id,
      generation: event.generation,
      control_revision: event.expected_revision,
      requirements_revision: state.messages?.requirements_revision ?? 0,
    });
  }
  let control = applyChatControl(state.control, event, observed);
  if (control === state.control) {
    if (event.type !== 'RESUME' || event.authorization === undefined)
      await host.reference(event.source);
    return { state, next: state };
  }
  requireWorkflow(!state.coordination_bound, 'chat-control-coordination-bound');
  let run = state.run;
  if (event.type === 'STOP' || event.type === 'INTERRUPT') {
    const boundary = await host.boundary(state.control.observed.turn_id);
    requireWorkflow(sameValue(event.source, boundary.source), 'chat-boundary-source-mismatch');
    if (event.type === 'STOP')
      requireWorkflow(boundary.kind !== 'compacted', 'chat-turn-not-stopped');
  } else if (event.type !== 'RESUME' || event.authorization === undefined) {
    requireWorkflow(
      (
        await host.message(
          event.source,
          event.type === 'RESUME' ? event.previous_source_turn : undefined,
        )
      ).thread_id === observed.thread_id,
      'chat-control-human-unconfirmed',
    );
  }
  const local = (
    detail: Parameters<typeof applyLocalEvent>[1] extends infer E
      ? E extends { type: string }
        ? Omit<E, 'event_id' | 'expected_revision' | 'generation'>
        : never
      : never,
  ) => {
    run = applyLocalEvent(run, {
      ...detail,
      event_id: event.id + ':' + detail.type,
      expected_revision: run.revision,
      generation: run.generation,
    });
  };
  if (event.type === 'RESUME') {
    requireWorkflow(state.control.origin !== undefined, 'chat-continuation-origin-unconfirmed');
    const previousIdentity = {
      ...state.control.origin,
      turn_id: observed.turn_id,
      source: observed.source,
    };
    requireWorkflow(
      sameValue(previousIdentity, observed) &&
        run.spec.session_id === observed.thread_id &&
        run.generation === state.control.generation,
      'chat-continuation-identity-mismatch',
    );
    await recovery.settled();
    for (const turn of state.control.unreconciled_turns ?? []) await host.continuation(turn);
    control = { ...control, unreconciled_turns: [] };
    if (event.stopped !== undefined) {
      const boundary = await host.boundary(state.control.observed.turn_id);
      requireWorkflow(boundary.kind !== 'compacted', 'chat-turn-not-stopped');
      await recovery.stopped(event.stopped, observed.thread_id, state.control.observed.turn_id);
    }
    if (state.control.observed.turn_id !== observed.turn_id || state.control.status === 'paused') {
      const previous = state.control.observed.turn_id;
      if (event.stopped === undefined) {
        control = {
          ...control,
          continuation: { previous_turn: previous, boundary: await host.continuation(previous) },
        };
      }
    } else if (!sameValue(state.control.observed, observed)) {
      requireWorkflow(
        (await host.boundary(observed.turn_id)).kind === 'compacted',
        'chat-compaction-unconfirmed',
      );
    }
    await inputs.verify(run);
    local({
      type: 'LOAD',
      receipt: await host.load(run, event.marker, event.previous_source_turn !== undefined),
    });
    if (run.spec.route.kind !== 'substantial' || run.spec.route.accepted_plan !== null)
      local({ type: 'READY' });
  } else if (event.type === 'STOP') {
    await recovery.settled();
    for (const turn of state.control.unreconciled_turns ?? []) await host.continuation(turn);
    await recovery.stopped(event.stopped, observed.thread_id, state.control.observed.turn_id);
    control = { ...control, unreconciled_turns: [] };
    local({
      type: 'CANCEL',
      reason: state.control.reason!,
      unfinished: state.control.unfinished,
      stopped_receipt: event.stopped.locator,
    });
  } else {
    if (run.status !== 'waiting') local({ type: 'WAIT' });
    run = { ...run, loaded: null };
  }
  const next = { ...state, control, run };
  return { state, next };
}
