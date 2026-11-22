import { object, requireContract, text } from '../../contracts/project.js';

export function sentMessage(input: unknown): string {
  requireContract(Array.isArray(input) && input.length > 0, 'reader-reconciliation-input-invalid');
  const parts = input.map(object);
  requireContract(
    parts.every((part) => part.type === 'text' && typeof part.text === 'string'),
    'reader-reconciliation-input-invalid',
  );
  return parts.map((part) => part.text).join('');
}

export function recoverSentTurn(
  response: unknown,
  session: string,
  message: string,
): string | null {
  const thread = object(object(response).thread);
  requireContract(
    thread.id === session && Array.isArray(thread.turns),
    'reader-reconciliation-history-incomplete',
  );
  const matches = thread.turns.map(object).filter((turn) => {
    requireContract(Array.isArray(turn.items), 'reader-reconciliation-history-incomplete');
    return turn.items.map(object).some((item) => {
      if (item.type !== 'userMessage') return false;
      requireContract(Array.isArray(item.content), 'reader-reconciliation-history-incomplete');
      const parts = item.content.map(object);
      requireContract(
        parts.every((part) => part.type === 'text' && typeof part.text === 'string'),
        'reader-reconciliation-history-incomplete',
      );
      return parts.map((part) => part.text).join('') === message;
    });
  });
  return matches.length === 1 ? text(matches[0]!.id) : null;
}
