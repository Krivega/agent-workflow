import {
  hasNativeDesktopInboundDelivery,
  nativeDesktopCommandTurn,
} from '../src/adapters/codex/nativeDesktopUser.js';
import { object } from '../src/contracts/project.js';

const terminalTypes = new Set(['task_complete', 'task_aborted', 'turn_aborted']);

/** Only native capacity retries retain the original decision; callers check its latest user and active target. */
export function verifyH06OperatorContinuation(
  records: readonly Record<string, unknown>[],
  sourceTurnId: string,
  targetTurnId: string,
  workspace: string,
): boolean {
  try {
    const rows = records.map((record, index) => ({
      record,
      payload: object(record.payload),
      index,
    }));
    const starts = rows.filter(
      ({ record, payload }) => record.type === 'event_msg' && payload.type === 'task_started',
    );
    const source = starts.findIndex(({ payload }) => payload.turn_id === sourceTurnId);
    const target = starts.findIndex(({ payload }) => payload.turn_id === targetTurnId);
    if (source < 0 || target < source) return false;
    const chain = starts.slice(source, target + 1);
    const contexts = rows.filter(({ record }) => record.type === 'turn_context');
    for (const [index, start] of chain.entries()) {
      const turn = start.payload.turn_id;
      const next = chain[index + 1];
      if (
        typeof turn !== 'string' ||
        starts.filter(({ payload }) => payload.turn_id === turn).length !== 1 ||
        !nativeDesktopCommandTurn(
          contexts.map(({ payload }) => payload),
          turn,
          workspace,
        ) ||
        hasNativeDesktopInboundDelivery(records, turn)
      )
        return false;
      const context = contexts.find(({ payload }) => payload.turn_id === turn)!;
      if (
        context.index <= start.index ||
        context.index >= (next?.index ?? records.length) ||
        context.payload.approval_policy !== 'never' ||
        object(context.payload.sandbox_policy).type !== 'danger-full-access' ||
        object(context.payload.permission_profile).type !== 'disabled'
      )
        return false;
      if (next === undefined) continue;
      const terminals = rows
        .slice(start.index + 1, next.index)
        .filter(
          ({ record, payload }) =>
            record.type === 'event_msg' && terminalTypes.has(String(payload.type)),
        );
      if (terminals.length !== 1) return false;
      const ended = terminals[0]!;
      const attribution = object(next.payload.turn_attribution);
      if (
        ended.index <= context.index ||
        ended.payload.type !== 'task_complete' ||
        ended.payload.turn_id !== turn ||
        ended.payload.root_turn_id !== turn ||
        ended.payload.last_agent_message !== null ||
        object(ended.payload.error).codex_error_info !== 'server_overloaded' ||
        attribution.turn_id !== next.payload.turn_id ||
        attribution.turn_trigger !== 'capacity_retry_manual' ||
        attribution.root_turn_id !== next.payload.turn_id ||
        attribution.parent_turn_id !== null ||
        attribution.initiating_agent_path !== null
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
