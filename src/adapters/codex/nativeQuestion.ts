import { exactFields, object, requireContract, text } from '../../contracts/project.js';

export interface NativeQuestionRecord {
  line: number;
  sha256: string;
  raw: Record<string, unknown>;
}
export interface NativeQuestionProof {
  call: NativeQuestionRecord;
  completed: NativeQuestionRecord;
  index: 0;
}

// Only the observed native card grammar is a human answer; question text stays opaque.
export function nativeQuestionAuthorization(
  content: string,
  expected: string,
  records: NativeQuestionRecord[],
  humanIndex: number,
  threadId: string,
  clientVersion: unknown,
): NativeQuestionProof | null {
  try {
    requireContract(clientVersion === '0.165.0-alpha.1.2', 'question-source-version');
    const envelope =
      /^<send_user_message_question_reply>\s*([\s\S]*)\s*<\/send_user_message_question_reply>$/u.exec(
        content.trim(),
      );
    requireContract(envelope !== null, 'question-envelope');
    const rows: unknown = JSON.parse(envelope[1]!);
    requireContract(Array.isArray(rows) && rows.length === 1, 'question-answer-count');
    const answer = object(rows[0]);
    exactFields(answer, ['questionItemId', 'question', 'answer']);
    requireContract(
      typeof answer.answer === 'string' &&
        answer.answer.trim() === expected &&
        typeof answer.question === 'string',
      'question-answer-mismatch',
    );
    const id: unknown = JSON.parse(text(answer.questionItemId));
    requireContract(
      Array.isArray(id) &&
        id.length === 3 &&
        id[0] === 'request_user_input_async' &&
        typeof id[1] === 'string' &&
        id[2] === 0 &&
        JSON.stringify(id) === answer.questionItemId,
      'question-identity',
    );
    const prefix = records.slice(0, humanIndex),
      calls = prefix
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => {
          if (entry.raw.type !== 'response_item') return false;
          const p = object(entry.raw.payload);
          return (
            p.type === 'function_call' &&
            p.name === 'request_user_input_async' &&
            p.call_id === id[1]
          );
        });
    requireContract(calls.length === 1, 'question-call-unconfirmed');
    const call = calls[0]!,
      payload = object(call.entry.raw.payload);
    requireContract(typeof payload.arguments === 'string', 'question-arguments');
    const args = object(JSON.parse(payload.arguments));
    exactFields(args, ['questions']);
    requireContract(Array.isArray(args.questions) && args.questions.length === 1, 'question-count');
    const question = object(args.questions[0]);
    exactFields(question, ['title']);
    requireContract(question.title === answer.question, 'question-title-mismatch');
    const completed = prefix
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => {
        if (entry.raw.type !== 'event_msg') return false;
        const p = object(entry.raw.payload);
        return p.type === 'item_completed' && object(p.item).id === id[1];
      });
    requireContract(
      completed.length === 1 && completed[0]!.index > call.index,
      'question-item-unconfirmed',
    );
    const itemRecord = completed[0]!,
      p = object(itemRecord.entry.raw.payload),
      item = object(p.item);
    exactFields(item, ['type', 'id', 'content', 'phase', 'delivery', 'questions']);
    requireContract(
      item.type === 'AgentMessage' &&
        p.thread_id === threadId &&
        Array.isArray(item.questions) &&
        item.questions.length === 1,
      'question-item-unconfirmed',
    );
    const shown = object(item.questions[0]);
    exactFields(shown, ['title', 'options']);
    requireContract(
      shown.title === answer.question && shown.options === null,
      'question-title-mismatch',
    );
    let turn = '';
    for (const entry of prefix.slice(0, itemRecord.index)) {
      if (entry.raw.type !== 'event_msg') continue;
      const p = object(entry.raw.payload);
      if (p.type === 'task_started') turn = text(p.turn_id);
    }
    requireContract(turn !== '' && p.turn_id === turn, 'question-turn-unconfirmed');
    return { call: call.entry, completed: itemRecord.entry, index: 0 };
  } catch {
    return null;
  }
}
