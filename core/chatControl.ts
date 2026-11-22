import { createMachine, getInitialSnapshot, transition } from 'xstate';
import { requireWorkflow, textField } from './connection.js';
import { sameValue, stableJson } from './equality.js';
import type { ChatObservation } from './currentChat.js';
import type { InputRef } from './localRun.js';

export interface ChatControl {
  schema_version: 1;
  revision: number;
  generation: number;
  status: 'active' | 'paused' | 'interrupted' | 'cancelling' | 'cancelled';
  observed: ChatObservation;
  reason: string | null;
  unfinished: string[];
  history: { id: string; payload: string }[];
  continuation?: { previous_turn: string; boundary: InputRef };
  origin?: ChatObservation;
  unreconciled_turns?: string[];
}
export type ChatControlEvent = {
  id: string;
  expected_revision: number;
  generation: number;
  thread_id: string;
  source: InputRef;
} & (
  | { type: 'PAUSE' | 'INTERRUPT'; reason: string }
  | { type: 'CANCEL'; reason: string; unfinished: string[] }
  | { type: 'STOP'; stopped: InputRef }
  | {
      type: 'RESUME';
      marker: string;
      stopped?: InputRef;
      authorization?: InputRef;
      previous_source_turn?: string;
    }
);
const machine = createMachine({
  types: {} as { events: { type: ChatControlEvent['type'] } },
  initial: 'active',
  states: {
    active: {
      on: { PAUSE: 'paused', INTERRUPT: 'interrupted', CANCEL: 'cancelling', RESUME: 'active' },
    },
    paused: { on: { INTERRUPT: 'interrupted', CANCEL: 'cancelling', RESUME: 'active' } },
    interrupted: { on: { CANCEL: 'cancelling', RESUME: 'active' } },
    cancelling: { on: { STOP: 'cancelled' } },
    cancelled: { type: 'final' },
  },
});
export function createChatControl(observed: ChatObservation, generation: number): ChatControl {
  requireWorkflow(Number.isSafeInteger(generation) && generation > 0, 'invalid-generation');
  return {
    schema_version: 1,
    revision: 0,
    generation,
    status: getInitialSnapshot(machine).value as ChatControl['status'],
    observed,
    origin: structuredClone(observed),
    unreconciled_turns: [],
    reason: null,
    unfinished: [],
    history: [],
  };
}
export function validateChatControl(control: ChatControl) {
  requireWorkflow(control.schema_version === 1, 'unsupported-chat-control');
  requireWorkflow(
    Number.isSafeInteger(control.revision) &&
      control.revision >= 0 &&
      Number.isSafeInteger(control.generation) &&
      control.generation > 0 &&
      Array.isArray(control.history) &&
      control.history.length === control.revision &&
      ['active', 'paused', 'interrupted', 'cancelling', 'cancelled'].includes(control.status),
    'invalid-chat-control',
  );
  [
    control.observed.thread_id,
    control.observed.turn_id,
    control.observed.source.locator,
    control.observed.source.hash,
  ].forEach(textField);
  if (control.continuation !== undefined)
    [
      control.continuation.previous_turn,
      control.continuation.boundary.locator,
      control.continuation.boundary.hash,
    ].forEach(textField);
  if (control.unreconciled_turns !== undefined) {
    requireWorkflow(Array.isArray(control.unreconciled_turns), 'invalid-chat-control');
    control.unreconciled_turns.forEach(textField);
  }
}
export function assertChatActive(control: ChatControl | null, observed: ChatObservation) {
  if (control === null) return;
  validateChatControl(control);
  requireWorkflow(control.status === 'active', 'chat-control-not-active');
  requireWorkflow(sameValue(control.observed, observed), 'chat-resume-required');
}
export function applyChatControl(
  state: ChatControl,
  event: ChatControlEvent,
  observed: ChatObservation,
): ChatControl {
  validateChatControl(state);
  requireWorkflow(
    ['PAUSE', 'INTERRUPT', 'CANCEL', 'STOP', 'RESUME'].includes(event.type),
    'unsupported-chat-control-event',
  );
  [event.id, event.source.locator, event.source.hash].forEach(textField);
  const payload = stableJson(event);
  const previous = state.history.find((e) => e.id === event.id);
  if (previous) {
    requireWorkflow(previous.payload === payload, 'chat-control-conflict');
    return state;
  }
  requireWorkflow(
    event.expected_revision === state.revision &&
      event.generation === state.generation &&
      event.thread_id === state.observed.thread_id &&
      observed.thread_id === event.thread_id,
    'stale-chat-control',
  );
  const snapshot = machine.resolveState({ value: state.status, context: {} });
  requireWorkflow(snapshot.can(event), 'chat-control-transition-forbidden');
  const moved = transition(machine, snapshot, event)[0];
  const next = structuredClone(state);
  if (event.type === 'PAUSE' || event.type === 'INTERRUPT' || event.type === 'CANCEL') {
    textField(event.reason);
    next.reason = event.reason;
  }
  if (event.type === 'CANCEL') {
    requireWorkflow(event.unfinished.length > 0, 'missing-unfinished-scope');
    event.unfinished.forEach(textField);
    next.unfinished = event.unfinished;
  }
  if (event.type === 'RESUME') {
    textField(event.marker);
    next.observed = observed;
    next.reason = null;
  }
  // Pause/cancel bind the actual turn which must stop, even if the prior active turn was lost.
  if (event.type === 'PAUSE' || event.type === 'CANCEL') {
    if (state.observed.turn_id !== observed.turn_id)
      next.unreconciled_turns = [
        ...new Set([...(state.unreconciled_turns ?? []), state.observed.turn_id]),
      ];
    next.observed = observed;
  }
  // INTERRUPT still cites the old terminal boundary, but the handling turn must also settle.
  if (event.type === 'INTERRUPT' && state.observed.turn_id !== observed.turn_id)
    next.unreconciled_turns = [...new Set([...(state.unreconciled_turns ?? []), observed.turn_id])];
  next.status = moved.value as ChatControl['status'];
  next.revision += 1;
  next.history.push({ id: event.id, payload });
  return next;
}
