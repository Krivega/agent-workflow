import { object, requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import type { AgentSession } from '../../core/dataRoute.js';
import type { AppServerRpc } from './appServerTransport.js';

// Supplied by the controller from the authorized handoff, never inferred from the answer.
export interface CouncilSender {
  threadId: string;
  turnId: string;
  reason: string;
}

export async function confirmCouncilDelegation(
  rpc: Pick<AppServerRpc, 'request'>,
  sender: CouncilSender,
  session: AgentSession,
  answer: Record<string, unknown>,
  prompt: string,
) {
  requireWorkflow(
    sender.threadId !== session.id &&
      sender.turnId !== answer.id &&
      answer.rootTurnId === sender.turnId,
    'council-delegation-origin',
  );
  const envelope =
    '<codex_delegation>\n  <source_thread_id>' +
    sender.threadId +
    '</source_thread_id>\n  <input>' +
    prompt +
    '</input>\n</codex_delegation>';
  const inbound = (answer.items as unknown[])
    .map(object)
    .filter(
      (item) =>
        item.type === 'functionCallOutput' &&
        item.namespace === 'codex_app' &&
        item.name === 'send_message_to_thread',
    );
  requireWorkflow(
    inbound.length === 1 && inbound[0]!.output === envelope,
    'council-delegation-inbound',
  );
  const thread = object(
    object(await rpc.request('thread/read', { threadId: sender.threadId, includeTurns: true }))
      .thread,
  );
  requireWorkflow(
    thread.id === sender.threadId && Array.isArray(thread.turns),
    'council-delegation-sender',
  );
  const turns = thread.turns.map(object).filter((turn) => turn.id === sender.turnId);
  requireWorkflow(turns.length === 1 && Array.isArray(turns[0]!.items), 'council-delegation-turn');
  const calls = turns[0]!.items.map(object).filter(
    (item) =>
      item.type === 'mcpToolCall' &&
      item.server === 'codex_app' &&
      item.tool === 'send_message_to_thread' &&
      sameValue(item.arguments, {
        threadId: session.id,
        model: session.model,
        thinking: session.effort,
        prompt,
      }),
  );
  requireWorkflow(
    calls.length === 1 &&
      calls[0]!.status === 'completed' &&
      calls[0]!.error === null &&
      sameValue(object(calls[0]!.result).content, [
        { type: 'text', text: JSON.stringify({ threadId: session.id }) },
      ]),
    'council-delegation-outbound',
  );
  return { sender, outbound: calls[0], inbound: inbound[0] };
}
