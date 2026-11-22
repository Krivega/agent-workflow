import { object, requireContract } from '../../contracts/project.js';

export function readerContextCompacted(
  response: unknown,
  session: string,
  loadTurn: string,
): boolean {
  const thread = object(object(response).thread);
  requireContract(thread.id === session && Array.isArray(thread.turns), 'reader-context-unknown');
  const turns = thread.turns.map(object),
    matches = turns.filter((turn) => turn.id === loadTurn);
  requireContract(matches.length === 1, 'reader-context-unknown');
  return turns.slice(turns.indexOf(matches[0]!)).some((turn) => {
    requireContract(Array.isArray(turn.items), 'reader-context-unknown');
    return turn.items.map(object).some((item) => item.type === 'contextCompaction');
  });
}
