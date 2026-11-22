import { object } from '../../core/connection.js';
import type { InputRef } from '../../core/localRun.js';

export type AuditLaunchObservation =
  | { outcome: 'unknown' }
  | { outcome: 'not-started'; receipt: InputRef }
  | {
      outcome: 'created';
      session: string;
      turn_not_started: boolean;
      deliveries: string[];
      delivery_turns?: string[];
      receipt: InputRef;
    };

// Only a correlated, explicit no-effect result proves refusal; arbitrary tool errors stay unknown.
export function auditLaunchObservation(
  records: { record: Record<string, unknown>; ref: InputRef }[],
  operation: string,
): AuditLaunchObservation {
  const calls = records.filter(({ record }) => {
    if (record.type !== 'response_item') return false;
    const p = object(record.payload);
    if (
      p.type !== 'function_call' ||
      !['collaboration.spawn_agent', 'spawn_agent'].includes(String(p.name))
    )
      return false;
    try {
      const args = object(JSON.parse(String(p.arguments)));
      return args.task_name === operation && args.agent_type === 'auditor';
    } catch {
      return false;
    }
  });
  if (calls.length !== 1) return { outcome: 'unknown' };
  const call = object(calls[0]!.record.payload);
  const outputs = records.filter(({ record }) => {
    if (record.type !== 'response_item') return false;
    const p = object(record.payload);
    return (
      record.type === 'response_item' &&
      p.type === 'function_call_output' &&
      p.call_id === call.call_id
    );
  });
  if (typeof call.call_id !== 'string' || outputs.length !== 1) return { outcome: 'unknown' };
  const output = outputs[0]!;
  let value: Record<string, unknown>;
  try {
    value = object(JSON.parse(String(object(output.record.payload).output)));
  } catch {
    return { outcome: 'unknown' };
  }
  if (
    value.outcome === 'not-started' &&
    value.dispatched === false &&
    value.operation === operation &&
    value.session === null
  )
    return { outcome: 'not-started', receipt: output.ref };
  let receipt = output.ref;
  const nativePath = typeof value.task_name === 'string';
  if (nativePath) {
    const parentTurn = object(call.internal_chat_message_metadata_passthrough ?? {}).turn_id;
    const activities = records.filter(({ record }) => {
      if (record.type !== 'event_msg') return false;
      const payload = object(record.payload);
      const item = object(payload.item ?? {});
      return (
        payload.type === 'item_completed' &&
        payload.turn_id === parentTurn &&
        typeof parentTurn === 'string' &&
        item.type === 'SubAgentActivity' &&
        item.id === call.call_id &&
        item.kind === 'started' &&
        item.agent_path === value.task_name
      );
    });
    if (activities.length !== 1 || !String(value.task_name).endsWith('/' + operation))
      return { outcome: 'unknown' };
    value = {
      ...value,
      agent_id: object(object(activities[0]!.record.payload).item).agent_thread_id,
      canonical_name: value.task_name,
    };
    receipt = activities[0]!.ref;
  }
  if (typeof value.agent_id !== 'string' || !value.agent_id.trim()) return { outcome: 'unknown' };
  // A pending later send may still create a turn even when thread/read currently shows no active turn.
  const sends = records.filter(({ record }) => {
    if (record.type !== 'response_item') return false;
    const p = object(record.payload);
    if (
      p.type !== 'function_call' ||
      ![
        'collaboration.followup_task',
        'collaboration.send_message',
        'followup_task',
        'send_message',
      ].includes(String(p.name))
    )
      return false;
    try {
      const target = object(JSON.parse(String(p.arguments))).target;
      return (
        target === value.agent_id ||
        target === value.canonical_name ||
        target === operation ||
        (typeof target === 'string' && target.endsWith('/' + operation))
      );
    } catch {
      return true;
    }
  });
  if (
    sends.some(
      ({ record }) =>
        !records.some((entry) => {
          const p = object(entry.record.payload);
          return (
            entry.record.type === 'response_item' &&
            p.type === 'function_call_output' &&
            p.call_id === object(record.payload).call_id
          );
        }),
    )
  )
    return { outcome: 'unknown' };
  const noSend =
    value.turn_started === false &&
    value.send_outcome === 'not-started' &&
    value.send_dispatched === false;
  let deliveries: unknown[];
  try {
    const initial = object(JSON.parse(String(call.arguments)));
    deliveries = (noSend ? [] : [initial.message]).concat(
      sends.map(
        ({ record }) => object(JSON.parse(String(object(record.payload).arguments))).message,
      ),
    );
  } catch {
    return { outcome: 'unknown' };
  }
  if (
    deliveries.some((message) => typeof message !== 'string' || !message.trim()) ||
    new Set(deliveries).size !== deliveries.length
  )
    return { outcome: 'unknown' };
  const deliveryTurns = (noSend ? [] : [call])
    .concat(sends.map(({ record }) => object(record.payload)))
    .map((payload) => object(payload.internal_chat_message_metadata_passthrough ?? {}).turn_id);
  if (
    nativePath &&
    (deliveryTurns.some((turn) => typeof turn !== 'string' || !turn.trim()) ||
      new Set(deliveryTurns).size !== deliveryTurns.length)
  )
    return { outcome: 'unknown' };
  return {
    outcome: 'created',
    session: value.agent_id,
    turn_not_started: noSend && sends.length === 0,
    deliveries: deliveries as string[],
    ...(nativePath ? { delivery_turns: deliveryTurns as string[] } : {}),
    receipt,
  };
}
