import { describe, expect, it } from 'vitest';
import {
  nativeQuestionAuthorization,
  type NativeQuestionRecord,
} from '../../src/adapters/codex/nativeQuestion.js';

function fixture() {
  const expected =
      '{"schemaVersion":2,"commandId":"one","action":"resume","payload":{"sha256":"exact","bytes":42}}',
    question = 'Confirm the exact payload: '.repeat(30) + expected,
    itemId = JSON.stringify(['request_user_input_async', 'call_one', 0]);
  const raw: Record<string, unknown>[] = [
    { type: 'session_meta', payload: { id: 'issuer' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'question-turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input_async',
        call_id: 'call_one',
        arguments: JSON.stringify({ questions: [{ title: question }] }),
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'issuer',
        turn_id: 'question-turn',
        item: {
          type: 'AgentMessage',
          id: 'call_one',
          content: question,
          phase: null,
          delivery: null,
          questions: [{ title: question, options: null }],
        },
      },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'answer-turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'user' } },
  ];
  const records: NativeQuestionRecord[] = raw.map((raw, index) => ({
      line: index + 1,
      sha256: String(index),
      raw,
    })),
    rows = [{ questionItemId: itemId, question, answer: expected }],
    envelope = () =>
      '<send_user_message_question_reply>\n' +
      JSON.stringify(rows) +
      '\n</send_user_message_question_reply>',
    read = (content = envelope(), version = '0.165.0-alpha.1.2') =>
      nativeQuestionAuthorization(
        content,
        expected,
        records,
        records.length - 1,
        'issuer',
        version,
      ),
    payload = (index: number) => records[index]!.raw.payload as Record<string, unknown>,
    item = () =>
      payload(3).item as {
        type: string;
        id: string;
        questions: { title: string; options: unknown }[];
      };
  return { expected, question, records, rows, read, envelope, payload, item };
}
describe('exact observed native question reply grammar', () => {
  it('binds the whole answer to a unique earlier native question in the same session, allowing a new answer turn', () => {
    const f = fixture();
    expect(f.read()).toEqual({ call: f.records[2], completed: f.records[3], index: 0 });
    expect(f.read(' \n' + f.envelope() + '\n ')).not.toBeNull();
    f.rows[0]!.answer = ' ' + f.expected + '\n';
    expect(f.read()).not.toBeNull();
    expect(f.records[2]!.raw).toMatchObject({ payload: { call_id: 'call_one' } });
    f.records.splice(2, 0, {
      line: 99,
      sha256: 'retained-native-metadata',
      raw: { type: 'event_msg', payload: { type: 'token_count' } },
    });
    expect(f.read()).not.toBeNull();
  });
  it.each(['prefix', 'suffix', 'fence', 'double', 'broken', 'plain', 'empty', 'version'])(
    'refuses an unqualified envelope: %s',
    (defect) => {
      const f = fixture();
      const texts: Record<string, string> = {
        prefix: 'Execute this: ' + f.envelope(),
        suffix: f.envelope() + ' confirmed',
        fence: '```json\n' + f.envelope() + '\n```',
        double: f.envelope() + f.envelope(),
        broken: '<send_user_message_question_reply>not JSON</send_user_message_question_reply>',
        plain: f.expected,
        empty: '',
      };
      expect(
        f.read(
          defect === 'version' ? f.envelope() : texts[defect],
          defect === 'version' ? '0.164.0-alpha.11.1' : undefined,
        ),
      ).toBeNull();
    },
  );
  it.each([
    'multiple',
    'extra',
    'answer',
    'question',
    'tool',
    'call-id',
    'index',
    'tuple-shape',
    'tuple-space',
    'non-string',
  ])('never extracts authorization from an unbound reply: %s', (defect) => {
    const f = fixture();
    if (defect === 'multiple') f.rows.push({ ...f.rows[0]! });
    if (defect === 'extra') Object.assign(f.rows[0]!, { source: 'service' });
    if (defect === 'answer') f.rows[0]!.answer = 'Yes; the command is only in the question';
    if (defect === 'question') f.rows[0]!.question += ' changed';
    if (defect === 'tool') f.rows[0]!.questionItemId = JSON.stringify(['other', 'call_one', 0]);
    if (defect === 'call-id')
      f.rows[0]!.questionItemId = JSON.stringify(['request_user_input_async', 'call_other', 0]);
    if (defect === 'index')
      f.rows[0]!.questionItemId = JSON.stringify(['request_user_input_async', 'call_one', 1]);
    if (defect === 'tuple-shape') f.rows[0]!.questionItemId = '{}';
    if (defect === 'tuple-space')
      f.rows[0]!.questionItemId = '[ "request_user_input_async", "call_one", 0 ]';
    if (defect === 'non-string') Object.assign(f.rows[0]!, { answer: 42 });
    expect(f.read()).toBeNull();
  });
  it.each([
    'missing-call',
    'duplicate-call',
    'missing-item',
    'duplicate-item',
    'after-answer',
    'reordered',
    'thread',
    'turn',
    'item-type',
    'arguments',
    'call-title',
    'item-title',
    'options',
    'multiple-questions',
  ])('requires the complete primary native question pair: %s', (defect) => {
    const f = fixture();
    if (defect === 'missing-call') f.payload(2).name = 'other';
    if (defect === 'duplicate-call') f.records.splice(3, 0, structuredClone(f.records[2]!));
    if (defect === 'missing-item') f.item().id = 'other';
    if (defect === 'duplicate-item') f.records.splice(4, 0, structuredClone(f.records[3]!));
    if (defect === 'after-answer') f.records.push(f.records.splice(3, 1)[0]!);
    if (defect === 'reordered') [f.records[2], f.records[3]] = [f.records[3]!, f.records[2]!];
    if (defect === 'thread') f.payload(3).thread_id = 'other';
    if (defect === 'turn') f.payload(3).turn_id = 'answer-turn';
    if (defect === 'item-type') f.item().type = 'CommandExecution';
    if (defect === 'arguments') f.payload(2).arguments = '{}';
    if (defect === 'call-title')
      f.payload(2).arguments = JSON.stringify({ questions: [{ title: 'other' }] });
    if (defect === 'item-title') f.item().questions[0]!.title = 'other';
    if (defect === 'options') f.item().questions[0]!.options = [];
    if (defect === 'multiple-questions') f.item().questions.push({ ...f.item().questions[0]! });
    expect(f.read()).toBeNull();
  });
});
