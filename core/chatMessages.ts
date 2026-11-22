import { requireWorkflow, textField } from './connection.js';
import { stableJson } from './equality.js';
import { compareInputs } from './evidence.js';
import type { InputRef, RunSpec } from './localRun.js';
import type { Gate, Execution, HumanCompletion } from './execution.js';
export type { HumanCompletion } from './execution.js';
import type { ReviewTarget } from './council.js';

export interface ChatMessages {
  schema_version: 1;
  revision: number;
  requirements_revision: number;
  task_id: string;
  thread_id: string;
  generation: number;
  initial_assignment: InputRef;
  question: { id: string; action: string; revision: number } | null;
  decisions: {
    question_id: string;
    action: string;
    revision: number;
    accepted: boolean;
    source: InputRef;
  }[];
  history_format?: 1;
  history: {
    id: string;
    payload: string;
    fingerprint?: string;
    expected_revision?: number;
    generation?: number;
    type?: string;
  }[];
}
export type ChatMessageEvent = {
  id: string;
  expected_revision: number;
  generation: number;
  thread_id: string;
  source: InputRef;
} & (
  | { type: 'ASK'; question_id: string; action: string }
  | {
      type: 'DECIDE';
      question_id: string;
      action: string;
      requirements_revision: number;
      accepted: boolean;
    }
  | {
      type: 'REQUIREMENTS';
      affected: string[];
      revision: Pick<RunSpec, 'assignment' | 'sources' | 'scope' | 'outcome' | 'criteria'> & {
        card: InputRef;
        rules?: RunSpec['rules'];
        procedures?: RunSpec['procedures'];
      };
      target: ReviewTarget;
      gates: Gate[];
    }
);
export function createChatMessages(
  task: string,
  thread: string,
  generation: number,
  assignment: InputRef,
): ChatMessages {
  [task, thread, assignment.locator, assignment.hash].forEach(textField);
  requireWorkflow(Number.isSafeInteger(generation) && generation > 0, 'invalid-generation');
  return {
    schema_version: 1,
    revision: 0,
    requirements_revision: 0,
    task_id: task,
    thread_id: thread,
    generation,
    initial_assignment: assignment,
    question: null,
    decisions: [],
    history: [],
  };
}
export function validateChatMessages(value: ChatMessages) {
  requireWorkflow(value.schema_version === 1, 'unsupported-chat-messages');
  [
    value.task_id,
    value.thread_id,
    value.initial_assignment.locator,
    value.initial_assignment.hash,
  ].forEach(textField);
  requireWorkflow(
    Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      Number.isSafeInteger(value.requirements_revision) &&
      value.requirements_revision >= 0 &&
      Array.isArray(value.history) &&
      value.history.length === value.revision &&
      Array.isArray(value.decisions),
    'invalid-chat-messages',
  );
  requireWorkflow(
    value.history_format === undefined || value.history_format === 1,
    'unsupported-chat-history-format',
  );
  for (const entry of value.history)
    if (entry.fingerprint !== undefined)
      requireWorkflow(
        value.history_format === 1 &&
          /^[a-f0-9]{64}$/u.test(entry.fingerprint) &&
          entry.payload === '',
        'invalid-chat-receipt',
      );
}
export function applyChatMessage(
  state: ChatMessages,
  event: ChatMessageEvent,
  fingerprint?: (value: unknown) => string,
): ChatMessages {
  validateChatMessages(state);
  requireWorkflow(
    ['ASK', 'DECIDE', 'REQUIREMENTS'].includes(event.type),
    'unsupported-chat-message',
  );
  textField(event.id);
  [event.source.locator, event.source.hash].forEach(textField);
  const hash = fingerprint?.(event);
  requireWorkflow(hash === undefined || /^[a-f0-9]{64}$/u.test(hash), 'invalid-chat-fingerprint');
  requireWorkflow(
    state.history_format === undefined || fingerprint !== undefined,
    'chat-fingerprint-required',
  );
  const payload = hash === undefined ? stableJson(event) : '',
    previous = state.history.find((e) => e.id === event.id);
  if (previous) {
    requireWorkflow(
      previous.fingerprint === undefined
        ? previous.payload === (hash === undefined ? payload : stableJson(event))
        : hash === previous.fingerprint,
      'chat-message-conflict',
    );
    return state;
  }
  requireWorkflow(
    state.revision === event.expected_revision &&
      state.generation === event.generation &&
      state.thread_id === event.thread_id,
    'stale-chat-message',
  );
  const next = structuredClone(state);
  if (event.type === 'ASK') {
    [event.question_id, event.action].forEach(textField);
    requireWorkflow(state.question === null, 'chat-question-pending');
    next.question = {
      id: event.question_id,
      action: event.action,
      revision: state.requirements_revision,
    };
  } else if (event.type === 'DECIDE') {
    requireWorkflow(
      state.question?.id === event.question_id &&
        state.question.action === event.action &&
        state.question.revision === event.requirements_revision &&
        event.requirements_revision === state.requirements_revision &&
        typeof event.accepted === 'boolean',
      'chat-decision-unbound',
    );
    next.decisions.push({
      question_id: event.question_id,
      action: event.action,
      revision: event.requirements_revision,
      accepted: event.accepted,
      source: event.source,
    });
    next.question = null;
  } else {
    requireWorkflow(
      Object.keys(event.revision).every((key) =>
        [
          'assignment',
          'sources',
          'scope',
          'outcome',
          'criteria',
          'card',
          'rules',
          'procedures',
        ].includes(key),
      ),
      'chat-requirements-authority-change',
    );
    requireWorkflow(event.affected.length > 0, 'chat-affected-scope-required');
    event.affected.forEach(textField);
    next.requirements_revision += 1;
    next.question = null;
  }
  next.revision += 1;
  if (hash !== undefined) next.history_format = 1;
  next.history.push({
    id: event.id,
    payload,
    ...(hash === undefined
      ? {}
      : {
          fingerprint: hash,
          expected_revision: event.expected_revision,
          generation: event.generation,
          type: event.type,
        }),
  });
  return next;
}
export function requireChatDecision(
  state: ChatMessages,
  action: string,
  accepted: boolean,
  source: InputRef,
) {
  validateChatMessages(state);
  const decision = [...state.decisions]
    .reverse()
    .find((d) => d.action === action && d.revision === state.requirements_revision);
  requireWorkflow(
    state.question?.action !== action &&
      decision !== undefined &&
      decision.accepted === accepted &&
      decision.source.locator === source.locator &&
      decision.source.hash === source.hash,
    'chat-human-decision-unconfirmed',
  );
}

export function requireHumanCompletionFloor(
  current: Execution | null,
  next: Execution,
): asserts current is Execution {
  const fields = [
    'task_id',
    'generation',
    'requirements_revision',
    'gates',
    'target',
    'checks',
    'baseline',
    'acceptance',
    'human_completion',
  ] as const;
  requireWorkflow(
    current !== null &&
      current.status === 'review' &&
      fields.every((field) => stableJson(current[field]) === stableJson(next[field])),
    'chat-human-completion-floor',
  );
}
export function requireCurrentHumanCompletion(run: Execution, messages: ChatMessages | null) {
  const gates = run.gates.filter((gate) => gate.kind === 'human' && gate.applicable);
  if (gates.length === 0) return;
  requireWorkflow(messages !== null, 'chat-messages-missing');
  validateChatMessages(messages);
  requireWorkflow(
    messages.task_id === run.task_id &&
      messages.generation === run.generation &&
      messages.requirements_revision === (run.requirements_revision ?? 0),
    'chat-human-check-context',
  );
  for (const gate of gates) {
    const check = run.checks.find((check) => check.id === gate.id);
    requireWorkflow(
      check?.verdict === 'PASS' && compareInputs(check.inputs, run.target.inputs) === 'applicable',
      'chat-human-check-unconfirmed',
    );
    requireChatDecision(messages, gate.id, true, check.evidence);
  }
}
export function sealHumanCompletion(run: Execution, messages: ChatMessages): HumanCompletion {
  requireCurrentHumanCompletion(run, messages);
  return {
    schema_version: 1,
    task_id: run.task_id,
    generation: run.generation,
    requirements_revision: messages.requirements_revision,
    message_revision: messages.revision,
    target: structuredClone(run.target),
    decisions: run.gates
      .filter((gate) => gate.kind === 'human' && gate.applicable)
      .map((gate) =>
        structuredClone(
          [...messages.decisions]
            .reverse()
            .find(
              (decision) =>
                decision.action === gate.id && decision.revision === messages.requirements_revision,
            )!,
        ),
      ),
  };
}
export function requireSealedHumanCompletion(run: Execution) {
  const gates = run.gates.filter((gate) => gate.kind === 'human' && gate.applicable);
  if (gates.length === 0) return;
  const seal = run.human_completion;
  requireWorkflow(
    run.status === 'done' &&
      seal !== undefined &&
      seal.schema_version === 1 &&
      seal.task_id === run.task_id &&
      seal.generation === run.generation &&
      seal.requirements_revision === (run.requirements_revision ?? 0) &&
      Number.isSafeInteger(seal.message_revision) &&
      seal.message_revision >= 0 &&
      stableJson(seal.target) === stableJson(run.target) &&
      seal.decisions.length === gates.length &&
      new Set(seal.decisions.map((decision) => decision.action)).size === gates.length,
    'chat-human-completion-unbound',
  );
  for (const gate of gates) {
    const check = run.checks.find((check) => check.id === gate.id),
      decision = seal.decisions.find((decision) => decision.action === gate.id);
    requireWorkflow(
      check?.verdict === 'PASS' &&
        compareInputs(check.inputs, run.target.inputs) === 'applicable' &&
        decision?.accepted === true &&
        decision.revision === seal.requirements_revision &&
        decision.source.locator === check.evidence.locator &&
        decision.source.hash === check.evidence.hash,
      'chat-human-completion-unbound',
    );
  }
}
