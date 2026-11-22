import { object, requireWorkflow, textField } from '../../core/connection.js';
import type { AgentSession } from '../../core/dataRoute.js';
import type { InputRef } from '../../core/localRun.js';
import type { AuditAttemptObservation } from '../../core/progressAudit.js';
import { readPrivateFile } from '../storage/storeFiles.js';
import type { AppServerRpc } from './appServerTransport.js';

export async function observeAuditRefusal(
  operation: string,
  primary: InputRef,
  receipt: (name: string, value: unknown) => Promise<InputRef>,
): Promise<AuditAttemptObservation> {
  return {
    outcome: 'not-started',
    operation,
    session: null,
    receipt: await receipt('audit-refusal', { operation, primary }),
  };
}
export async function observeAuditTerminal(
  rpc: Pick<AppServerRpc, 'request'>,
  operation: string,
  session: AgentSession,
  launch: InputRef,
  turnNotStarted: boolean,
  deliveries: string[],
  deliveryTurns: string[] | undefined,
  receipt: (name: string, value: unknown) => Promise<InputRef>,
): Promise<AuditAttemptObservation> {
  const raw = await rpc.request('thread/read', { threadId: session.id, includeTurns: true });
  const thread = object(object(raw).thread);
  requireWorkflow(thread.id === session.id && Array.isArray(thread.turns), 'wrong-thread-read');
  const turns = thread.turns.map(object);
  if (turns.length === 0) {
    if (!turnNotStarted) return { outcome: 'unknown' };
    return {
      outcome: 'idle',
      operation,
      session,
      receipt: await receipt(`audit-idle-${session.id}`, {
        operation,
        launch,
        observation: raw,
      }),
    };
  }
  let primary: { raw: string; record: Record<string, unknown> }[] | null = null;
  for (const [index, delivery] of deliveries.entries()) {
    const matching = turns.filter(
      (turn) =>
        Array.isArray(turn.items) &&
        turn.items
          .map(object)
          .some(
            (item) =>
              item.type === 'userMessage' &&
              Array.isArray(item.content) &&
              item.content
                .map(object)
                .some((part) => part.type === 'text' && part.text === delivery),
          ),
    );
    if (matching.length === 1) continue;
    if (
      matching.length > 1 ||
      deliveryTurns?.length !== deliveries.length ||
      session.native_child !== true ||
      typeof session.parent_id !== 'string'
    )
      return { outcome: 'unknown' };
    try {
      if (primary === null) {
        const raw = readPrivateFile(textField(thread.path)).toString('utf8');
        requireWorkflow(raw.endsWith('\n'), 'audit-transcript-partial');
        const records = raw
          .slice(0, -1)
          .split('\n')
          .map((line) => ({ raw: line + '\n', record: object(JSON.parse(line)) }));
        const meta = records.filter(({ record }) => record.type === 'session_meta');
        requireWorkflow(
          meta.length === 1 &&
            object(meta[0]!.record.payload).id === session.id &&
            object(meta[0]!.record.payload).parent_thread_id === session.parent_id,
          'audit-native-lineage-mismatch',
        );
        primary = records.filter(
          ({ record }) =>
            record.type === 'session_meta' ||
            (record.type === 'event_msg' && object(record.payload).type === 'task_started'),
        );
      }
      const attributed = primary.filter(({ record }) => {
        const payload = object(record.payload);
        return (
          record.type === 'event_msg' &&
          object(payload.turn_attribution ?? {}).parent_turn_id === deliveryTurns[index] &&
          turns.some((turn) => turn.id === payload.turn_id)
        );
      });
      requireWorkflow(attributed.length === 1, 'audit-native-delivery-unknown');
    } catch {
      return { outcome: 'unknown' };
    }
  }
  if (turns.some((t) => !['completed', 'failed', 'interrupted'].includes(String(t.status))))
    return { outcome: 'unknown' };
  const turn = turns.at(-1)!;
  const status = turn.status as 'completed' | 'failed' | 'interrupted';
  return {
    outcome: 'terminal',
    operation,
    session,
    turn: textField(turn.id),
    status,
    receipt: await receipt(`audit-terminal-${session.id}`, {
      operation,
      launch,
      observation: raw,
      ...(primary === null ? {} : { native_attribution: primary }),
    }),
  };
}
