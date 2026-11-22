import { auditLaunchObservation } from '../adapters/codex/auditLaunchObservation.js';
const ref = { locator: 'native#L1', hash: 'native-hash' };
const entry = (payload: unknown) => ({ record: { type: 'response_item', payload }, ref });
const call = () =>
  entry({
    type: 'function_call',
    name: 'collaboration.spawn_agent',
    call_id: 'c',
    arguments: JSON.stringify({ task_name: 'attempt', agent_type: 'auditor', message: 'card.md' }),
  });
const output = (value: unknown) =>
  entry({ type: 'function_call_output', call_id: 'c', output: JSON.stringify(value) });
it('distinguishes a primary correlated refusal from an unknown error and allows absent identity only for no effect', () => {
  const refused = {
    outcome: 'not-started',
    dispatched: false,
    operation: 'attempt',
    session: null,
  };
  expect(auditLaunchObservation([call(), output(refused)], 'attempt')).toEqual({
    outcome: 'not-started',
    receipt: ref,
  });
  for (const records of [
    [],
    [call()],
    [call(), call(), output(refused)],
    [call(), output(refused), output(refused)],
    [call(), output({ error: 'timeout' })],
    [call(), output({ ...refused, dispatched: true })],
    [call(), output({ ...refused, operation: 'other' })],
    [call(), output({ ...refused, session: 'maybe-created' })],
    [call(), output({ agent_id: '' })],
    [entry({ type: 'function_call', name: 'unrelated' })],
    [entry({ type: 'function_call', name: 'spawn_agent', arguments: '{' })],
    [call(), entry({ type: 'function_call_output', call_id: 'c', output: '{' })],
  ]) {
    expect(auditLaunchObservation(records, 'attempt')).toEqual({ outcome: 'unknown' });
  }
});
it('records created identity and keeps an uncertain follow-up blocked', () => {
  const created = output({
    agent_id: 'auditor',
    turn_started: false,
    send_outcome: 'not-started',
    send_dispatched: false,
  });
  expect(auditLaunchObservation([call(), created], 'attempt')).toEqual({
    outcome: 'created',
    session: 'auditor',
    turn_not_started: true,
    deliveries: [],
    receipt: ref,
  });
  const send = entry({
    type: 'function_call',
    name: 'collaboration.followup_task',
    call_id: 's',
    arguments: JSON.stringify({ target: 'auditor', message: 'next.md' }),
  });
  expect(auditLaunchObservation([call(), created, send], 'attempt')).toEqual({
    outcome: 'unknown',
  });
  const ack = entry({ type: 'function_call_output', call_id: 's', output: '{}' });
  expect(auditLaunchObservation([call(), created, send, ack], 'attempt')).toMatchObject({
    outcome: 'created',
    turn_not_started: false,
  });
  expect(
    auditLaunchObservation([call(), output({ agent_id: 'auditor' })], 'attempt'),
  ).toMatchObject({ outcome: 'created', turn_not_started: false });
});

it('rejects malformed, repeated or aliased deliveries and never treats queued send as not-started', () => {
  const created = output({ agent_id: 'auditor', canonical_name: '/root/attempt' });
  const send = (target: string, message: unknown = 'next.md') =>
    entry({
      type: 'function_call',
      name: 'send_message',
      call_id: 's',
      arguments: JSON.stringify({ target, message }),
    });
  const ack = entry({ type: 'function_call_output', call_id: 's', output: '{}' });
  expect(
    auditLaunchObservation(
      [{ record: { type: 'session_meta', payload: {} }, ref }, call(), created],
      'attempt',
    ),
  ).toMatchObject({ outcome: 'created' });
  for (const target of ['auditor', '/root/attempt', 'attempt', '/other/attempt'])
    expect(auditLaunchObservation([call(), created, send(target)], 'attempt')).toEqual({
      outcome: 'unknown',
    });
  expect(auditLaunchObservation([call(), created, send('other'), ack], 'attempt')).toMatchObject({
    outcome: 'created',
    deliveries: ['card.md'],
  });
  expect(auditLaunchObservation([call(), created, send('auditor', null), ack], 'attempt')).toEqual({
    outcome: 'unknown',
  });
  expect(
    auditLaunchObservation([call(), created, send('auditor', 'card.md'), ack], 'attempt'),
  ).toEqual({ outcome: 'unknown' });
  expect(
    auditLaunchObservation(
      [
        call(),
        created,
        entry({ type: 'function_call', name: 'followup_task', call_id: 's', arguments: '{' }),
      ],
      'attempt',
    ),
  ).toEqual({ outcome: 'unknown' });
  expect(
    auditLaunchObservation(
      [call(), output({ agent_id: 'auditor', turn_started: false })],
      'attempt',
    ),
  ).toMatchObject({ outcome: 'created', turn_not_started: false, deliveries: ['card.md'] });
});

it('keeps acknowledged malformed delivery data unknown', () => {
  const send = entry({
    type: 'function_call',
    name: 'followup_task',
    call_id: 'bad-send',
    arguments: '{',
  });
  const ack = entry({ type: 'function_call_output', call_id: 'bad-send', output: '{}' });
  expect(
    auditLaunchObservation([call(), output({ agent_id: 'auditor' }), send, ack], 'attempt'),
  ).toEqual({ outcome: 'unknown' });
});

it('resolves a native V2 task path only through its correlated primary activity', () => {
  const spawn = call();
  Object.assign(spawn.record.payload as object, {
    internal_chat_message_metadata_passthrough: { turn_id: 'parent-turn' },
  });
  const activity = (patch = {}) => ({
    record: {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'parent-turn',
        item: {
          type: 'SubAgentActivity',
          id: 'c',
          kind: 'started',
          agent_path: '/root/attempt',
          agent_thread_id: 'native-child',
          ...patch,
        },
      },
    },
    ref,
  });
  const result = output({ task_name: '/root/attempt' });
  expect(auditLaunchObservation([spawn, activity(), result], 'attempt')).toMatchObject({
    outcome: 'created',
    session: 'native-child',
    delivery_turns: ['parent-turn'],
  });
  for (const items of [
    [],
    [activity(), activity()],
    [activity({ kind: 'completed' })],
    [activity({ id: 'different' })],
    [activity({ agent_path: '/root/other' })],
    [activity({ agent_thread_id: '' })],
    [{ ...activity(), record: { type: 'event_msg', payload: { type: 'other' } } }],
  ])
    expect(auditLaunchObservation([spawn, ...items, result], 'attempt')).toEqual({
      outcome: 'unknown',
    });
  expect(
    auditLaunchObservation(
      [spawn, activity({ agent_path: '/root/other' }), output({ task_name: '/root/other' })],
      'attempt',
    ),
  ).toEqual({ outcome: 'unknown' });
  const noMetadata = call();
  expect(auditLaunchObservation([noMetadata, activity(), result], 'attempt')).toEqual({
    outcome: 'unknown',
  });
  const followup = entry({
    type: 'function_call',
    name: 'followup_task',
    call_id: 'send',
    arguments: JSON.stringify({ target: '/root/attempt', message: 'next.md' }),
  });
  const ack = entry({ type: 'function_call_output', call_id: 'send', output: '{}' });
  expect(auditLaunchObservation([spawn, activity(), result, followup, ack], 'attempt')).toEqual({
    outcome: 'unknown',
  });
});
