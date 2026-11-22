import { describe, expect, it } from 'vitest';
import { recoverSentTurn, sentMessage } from '../../src/adapters/codex/recoveredSend.js';

it('reconciles a full native prompt without the short identifier limit', () => {
  const message = 'long native LOAD '.repeat(1000);
  expect(
    sentMessage([
      { type: 'text', text: message },
      { type: 'text', text: 'end' },
    ]),
  ).toBe(message + 'end');
  for (const input of [null, [], [{ type: 'image', text: 'x' }], [{ type: 'text', text: 7 }]])
    expect(() => sentMessage(input)).toThrow('reader-reconciliation-input-invalid');
});

const message = 'Workflow operation: operation-1\nExact task';
const item = { type: 'userMessage', content: [{ type: 'text', text: message }] };
const turn = { id: 'turn-1', items: [{ type: 'agentMessage', text: message }, item] };
function history(turns: unknown[]) {
  return { thread: { id: 'session', turns } };
}

describe('primary send reconciliation', () => {
  it('finds exactly the original user message and ignores agent text', () => {
    expect(recoverSentTurn(history([turn]), 'session', message)).toBe('turn-1');
    expect(
      recoverSentTurn(
        history([{ ...turn, items: [{ type: 'agentMessage', text: message }] }]),
        'session',
        message,
      ),
    ).toBeNull();
    expect(
      recoverSentTurn(
        history([
          {
            ...turn,
            items: [
              {
                ...item,
                content: [
                  { type: 'text', text: 'Workflow operation: operation-1\n' },
                  { type: 'text', text: 'Exact task' },
                ],
              },
            ],
          },
        ]),
        'session',
        message,
      ),
    ).toBe('turn-1');
  });
  it('keeps no match, another payload and multiple matches unknown', () => {
    expect(recoverSentTurn(history([]), 'session', message)).toBeNull();
    expect(recoverSentTurn(history([turn]), 'session', message + ' changed')).toBeNull();
    expect(
      recoverSentTurn(history([turn, { ...turn, id: 'turn-2' }]), 'session', message),
    ).toBeNull();
  });
  it.each([
    { thread: { id: 'other', turns: [] } },
    { thread: { id: 'session', turns: null } },
    history([{ id: 'turn-1' }]),
    history([{ ...turn, items: [{ type: 'userMessage' }] }]),
    history([{ ...turn, items: [{ ...item, content: [{ type: 'image' }] }] }]),
    history([{ ...turn, items: [{ ...item, content: [{ type: 'text', text: 1 }] }] }]),
  ])('rejects incomplete or foreign history before confirming an outcome', (response) => {
    expect(() => recoverSentTurn(response, 'session', message)).toThrow(
      'reader-reconciliation-history-incomplete',
    );
  });
});
