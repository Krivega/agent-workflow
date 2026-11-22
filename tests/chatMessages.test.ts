import {
  applyChatMessage,
  createChatMessages,
  requireChatDecision,
  validateChatMessages,
} from '../core/chatMessages.js';
import type { ChatMessageEvent } from '../core/chatMessages.js';
import { advanceChatMessages, prepareChatMessage } from '../application/chatMessages.js';
import type { ChatContext } from '../ports/chatContext.js';
import { workflowFixture } from './workflowFixtures.js';
const ref = { locator: 'primary', hash: 'a'.repeat(64) };
function initial() {
  return createChatMessages('task', 'thread', 1, ref);
}
const ask: ChatMessageEvent = {
  type: 'ASK',
  id: 'ask',
  expected_revision: 0,
  generation: 1,
  thread_id: 'thread',
  source: ref,
  question_id: 'q',
  action: 'publish',
};
it('binds one answer to the exact question, action and requirements revision and retains its source', () => {
  const state = initial(),
    asked = applyChatMessage(state, ask);
  expect(applyChatMessage(asked, ask)).toBe(asked);
  expect(() => applyChatMessage(asked, { ...ask, action: 'other' })).toThrow(
    'chat-message-conflict',
  );
  expect(() => applyChatMessage(state, { ...ask, expected_revision: 1 })).toThrow(
    'stale-chat-message',
  );
  expect(() => applyChatMessage(asked, { ...ask, id: 'second', expected_revision: 1 })).toThrow(
    'chat-question-pending',
  );
  const answer: ChatMessageEvent = {
    type: 'DECIDE',
    id: 'answer',
    expected_revision: 1,
    generation: 1,
    thread_id: 'thread',
    source: ref,
    question_id: 'q',
    action: 'publish',
    requirements_revision: 0,
    accepted: false,
  };
  const decided = applyChatMessage(asked, answer);
  expect(decided.decisions).toEqual([
    { question_id: 'q', action: 'publish', revision: 0, accepted: false, source: ref },
  ]);
  expect(() => requireChatDecision(decided, 'publish', false, ref)).not.toThrow();
  expect(() => requireChatDecision(decided, 'other', false, ref)).toThrow(
    'chat-human-decision-unconfirmed',
  );
  expect(() => applyChatMessage(asked, { ...answer, requirements_revision: 1 })).toThrow(
    'chat-decision-unbound',
  );
  const again = applyChatMessage(decided, {
    ...ask,
    id: 'ask-again',
    question_id: 'q2',
    expected_revision: 2,
  });
  expect(() => requireChatDecision(again, 'publish', false, ref)).toThrow(
    'chat-human-decision-unconfirmed',
  );
  const superseded = applyChatMessage(again, {
    ...answer,
    id: 'answer-again',
    question_id: 'q2',
    expected_revision: 3,
    accepted: true,
  });
  expect(() => requireChatDecision(superseded, 'publish', false, ref)).toThrow(
    'chat-human-decision-unconfirmed',
  );
  expect(() => requireChatDecision(superseded, 'publish', true, ref)).not.toThrow();
});
it('rejects unknown schemas, malformed state and an invalid generation without a write', () => {
  expect(() => createChatMessages('task', 'thread', 0, ref)).toThrow('invalid-generation');
  expect(() => validateChatMessages({ ...initial(), schema_version: 2 as 1 })).toThrow(
    'unsupported-chat-messages',
  );
  expect(() => validateChatMessages({ ...initial(), revision: 1 })).toThrow(
    'invalid-chat-messages',
  );
});

it('allows refreshed declared inputs but never changes executor authority through requirements', async () => {
  const f = await workflowFixture();
  try {
    const update: ChatMessageEvent = {
      ...ask,
      type: 'REQUIREMENTS',
      id: 'requirements',
      affected: ['artifact'],
      revision: {
        assignment: f.proof,
        sources: [f.proof],
        scope: ['scope'],
        outcome: 'updated',
        criteria: ['artifact'],
        card: { locator: f.card.locator, hash: f.card.revision },
        rules: f.executor.spec.rules,
        procedures: f.executor.spec.procedures,
      },
      target: f.target,
      gates: [],
    };
    const state: ChatContext = {
      messages: initial(),
      run: f.executor,
      workflow: { schema_version: 1, revision: 0, execution: null, readings: {} },
      coordination_bound: false,
      control: null,
    };
    const host = {
      reference: async () => undefined,
      message: async () => ({ thread_id: 'thread', turn_id: 'turn' }),
    };
    const inputs = { verify: async () => undefined };
    const prepared = await prepareChatMessage(update, state, host, inputs);
    expect(prepared.next.messages!.requirements_revision).toBe(1);
    expect(
      await advanceChatMessages(
        update,
        { read: async () => prepared.next, save: async () => undefined },
        host,
        inputs,
      ),
    ).toBe(prepared.next);
    for (const key of ['session_id', 'run_id', 'requested', 'effective', 'writer', 'generation']) {
      const changed = { ...update, revision: { ...update.revision, [key]: 'foreign' } };
      expect(() => applyChatMessage(initial(), changed)).toThrow(
        'chat-requirements-authority-change',
      );
    }
  } finally {
    await f.dispose();
  }
});
