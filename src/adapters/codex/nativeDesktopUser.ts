import { isDeepStrictEqual } from 'node:util';
import { object } from '../../contracts/project.js';

export const comparisonDesktopVersion = '0.169.0-alpha.11.1';

function isDesktopUserRoot(session: Record<string, unknown>, threadSource = 'user'): boolean {
  return (
    session.source === 'vscode' &&
    session.originator === 'codex_work_desktop' &&
    session.thread_source === threadSource &&
    !Object.hasOwn(session, 'forked_from_id') &&
    !Object.hasOwn(session, 'parent_thread_id')
  );
}

export function isComparisonDesktopUser(
  session: Record<string, unknown>,
): session is Record<string, unknown> & { cli_version: typeof comparisonDesktopVersion } {
  return session.cli_version === comparisonDesktopVersion && isDesktopUserRoot(session);
}

export function isTaskStartDesktopRoot(session: Record<string, unknown>): boolean {
  return (
    (session.cli_version === comparisonDesktopVersion ||
      session.cli_version === '0.169.1' ||
      session.cli_version === '0.171.0-alpha.13') &&
    isDesktopUserRoot(session)
  );
}

/** A delegated destination may be a Desktop chat created by the sending operator. */
export function isComparisonDesktopActor(
  session: Record<string, unknown>,
): session is Record<string, unknown> & { cli_version: typeof comparisonDesktopVersion } {
  return (
    isComparisonDesktopUser(session) ||
    (session.cli_version === comparisonDesktopVersion &&
      isDesktopUserRoot(session, 'agent_created_thread'))
  );
}

/** Primary same-root Desktop format observed in the exact 0.166 client. */
export function isNativeDesktopUser166(
  session: Record<string, unknown>,
): session is Record<string, unknown> & { cli_version: '0.166.0-alpha.6' } {
  return session.cli_version === '0.166.0-alpha.6' && isDesktopUserRoot(session);
}

export function comparisonDesktopHumanMessage(
  metadata: Record<string, unknown>,
  turnId: string,
): boolean {
  return (
    metadata.turn_id === turnId &&
    isDeepStrictEqual(metadata.content_item_kinds, ['user.text']) &&
    isDeepStrictEqual(metadata.content_item_metadata, [{ provenance: { type: 'user' } }])
  );
}

/** Desktop repeats the unchanged active context after persisting a compaction and its full world state. */
export function comparisonDesktopHistory<T extends { record: Record<string, unknown> }>(
  rows: readonly T[],
) {
  let previous: Record<string, unknown> | undefined;
  return rows.filter(({ record }, index) => {
    if (record.type !== 'turn_context') return true;
    const payload = object(record.payload),
      prior = previous;
    previous = payload;
    if (!isDeepStrictEqual(payload, prior)) return true;
    const compact = rows[index - 2]?.record,
      world = rows[index - 1]?.record;
    return !(
      compact?.type === 'compacted' &&
      world?.type === 'world_state' &&
      object(world.payload).full === true &&
      object(object(compact.payload).resume_metadata).last_started_turn_id === payload.turn_id
    );
  });
}

export function nativeDesktopCommandTurn(
  contexts: readonly Record<string, unknown>[],
  turnId: string,
  workspace: string,
): boolean {
  const turns = contexts.filter((context) => context.turn_id === turnId);
  return turns.length === 1 && turns[0]!.cwd === workspace;
}

export function hasNativeDesktopInboundDelivery(
  records: readonly Record<string, unknown>[],
  turnId: string,
): boolean {
  return records.some((record) => {
    if (record.type !== 'response_item') return false;
    const payload = object(record.payload);
    const metadata = payload.internal_chat_message_metadata_passthrough;
    return (
      payload.type === 'function_call_output' &&
      payload.call_id === undefined &&
      payload.namespace === 'codex_app' &&
      (payload.name === 'create_thread' || payload.name === 'send_message_to_thread') &&
      metadata !== null &&
      typeof metadata === 'object' &&
      'turn_id' in metadata &&
      metadata.turn_id === turnId
    );
  });
}

// Keep native rows and their original line references. Only a harness date refresh in the
// same turn and with the same timezone and filesystem as the prior environment is transparent.
export function comparisonDesktopRequestRows<T extends { record: Record<string, unknown> }>(
  rows: readonly T[],
): readonly T[] {
  let turn: unknown;
  let previousEnvironment: string | undefined;
  const environment = 'environments.environment_context';
  const harness = { provenance: { type: 'harness', hook: false } };
  return rows.filter(({ record }) => {
    const p = object(record.payload);
    if (record.type === 'event_msg' && p.type === 'task_started') turn = p.turn_id;
    if (record.type !== 'response_item' || p.type !== 'message' || p.role !== 'user') return true;
    const metadata = p.internal_chat_message_metadata_passthrough as
      | { turn_id?: unknown; content_item_kinds?: unknown; content_item_metadata?: unknown }
      | undefined;
    if (
      (record.metadata as { client_authored?: unknown } | undefined)?.client_authored !== false ||
      typeof turn !== 'string' ||
      metadata?.turn_id !== turn ||
      !Array.isArray(p.content)
    )
      return true;
    const pure =
      isDeepStrictEqual(metadata.content_item_kinds, [environment]) &&
      isDeepStrictEqual(metadata.content_item_metadata, [harness]) &&
      p.content.length === 1;
    const initial =
      isDeepStrictEqual(metadata.content_item_kinds, ['agents_md.instructions', environment]) &&
      isDeepStrictEqual(metadata.content_item_metadata, [
        { provenance: { type: 'agents_md' } },
        harness,
      ]) &&
      p.content.length === 2;
    if (!pure && !initial) return true;
    const part = object(p.content.at(-1));
    const shape =
      part.type === 'input_text' && typeof part.text === 'string'
        ? /^<environment_context>\n(  <cwd>[^<>\n]+<\/cwd>\n  <shell>[^<>\n]+<\/shell>\n)?  <current_date>\d{4}-\d{2}-\d{2}<\/current_date>\n(  <timezone>[^<>\n]+<\/timezone>\n  <filesystem>[^\n]+<\/filesystem>\n<\/environment_context>)$/u.exec(
            part.text,
          )
        : null;
    const baseline = previousEnvironment;
    previousEnvironment = shape?.[2];
    return !(pure && shape !== null && shape[1] === undefined && previousEnvironment === baseline);
  });
}
