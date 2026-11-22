import { isAbsolute, resolve, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type { TaskHumanTarget } from '../../contracts/taskHuman.js';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
  text,
} from '../../contracts/project.js';
import { textField } from '../../contracts/localValues.js';
import { parseTaskHumanTarget, taskHumanCanonical } from '../../policy/taskHuman.js';
import { controlRef } from '../../policy/readerControl.js';
import { digest } from '../artifacts/files.js';
import { isNativeDesktopUser166, hasNativeDesktopInboundDelivery } from './nativeDesktopUser.js';
import type { NativeTaskRow } from './nativeTaskSource.js';

export const taskHumanChoices = ['Принять', 'Отклонить'] as const;
export interface NativeHumanContext {
  kind: 'task-human-choice-context/1';
  questionId: string;
  criterion: { id: string; text: string };
  target: TaskHumanTarget;
  expectedHumanRevision: number;
  manifest: ArtifactRef;
  card: ArtifactRef & { path: string };
  candidate: ArtifactRef;
  technicalAcceptance: ArtifactRef;
  chat: { threadId: string; workspace: string; hostId: 'local' };
  author: string;
}
type PublishedLink = ArtifactRef & { path: string };
export interface NativeHumanLinks {
  context: PublishedLink;
  result: PublishedLink;
}
export type NativeHumanReferences = Record<
  'call' | 'publication' | 'reply' | 'delivery',
  { locator: string; hash: string }
>;
function check(condition: unknown, reason: string): asserts condition {
  requireContract(condition, 'task-human-native-' + reason);
}
function equal(actual: unknown, expected: unknown, reason: string) {
  check(isDeepStrictEqual(actual, expected), reason);
}
function absolute(path: string) {
  check(isAbsolute(path) && resolve(path) === path, 'path');
}
export function nativeHumanContext(context: NativeHumanContext) {
  exactFields(object(context), [
    'kind',
    'questionId',
    'criterion',
    'target',
    'expectedHumanRevision',
    'manifest',
    'card',
    'candidate',
    'technicalAcceptance',
    'chat',
    'author',
  ]);
  check(context.kind === 'task-human-choice-context/1', 'context');
  identifier(context.questionId);
  exactFields(object(context.criterion), ['id', 'text']);
  textField(context.criterion.id);
  textField(context.criterion.text);
  equal(parseTaskHumanTarget(context.target), context.target, 'target');
  check(
    Number.isSafeInteger(context.expectedHumanRevision) && context.expectedHumanRevision >= 0,
    'revision',
  );
  controlRef(context.manifest);
  controlRef(context.candidate);
  controlRef(context.technicalAcceptance);
  exactFields(object(context.card), ['path', 'sha256', 'bytes']);
  relativePath(context.card.path);
  controlRef({ sha256: context.card.sha256, bytes: context.card.bytes });
  exactFields(object(context.chat), ['threadId', 'workspace', 'hostId']);
  identifier(context.chat.threadId);
  absolute(context.chat.workspace);
  check(context.chat.hostId === 'local' && context.author === context.target.owner, 'owner');
  const body = taskHumanCanonical(context);
  return { body, ref: { sha256: digest(body), bytes: Buffer.byteLength(body) } };
}
function artifactLink(value: PublishedLink, expected: ArtifactRef) {
  exactFields(object(value), ['path', 'sha256', 'bytes']);
  absolute(value.path);
  check(!/[<>\r\n]/u.test(value.path) && basename(value.path) === value.sha256, 'artifact-path');
  equal({ sha256: value.sha256, bytes: value.bytes }, expected, 'artifact-ref');
}
export function nativeHumanQuestion(context: NativeHumanContext, links: NativeHumanLinks) {
  const prepared = nativeHumanContext(context);
  exactFields(object(links), ['context', 'result']);
  artifactLink(links.context, prepared.ref);
  artifactLink(links.result, context.candidate);
  const wording = context.criterion.text.replace(
      /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/gu,
      '\\$&',
    ),
    link = (value: string) => value.split('/').map(encodeURIComponent).join('/');
  return {
    contextHash: prepared.ref.sha256,
    title:
      'Принять результат по критерию?\n\n' +
      wording +
      `\n\n[Проверенный результат](<${link(links.result.path)}>)\n\n` +
      `[Условия вопроса](<${link(links.context.path)}>)`,
    options: [...taskHumanChoices],
  };
}
function payload(row: NativeTaskRow) {
  return object(row.record.payload);
}
function selected(rows: NativeTaskRow[], ref: { locator: string; hash: string }) {
  exactFields(object(ref), ['locator', 'hash']);
  const found = rows.filter((row) => row.ref.locator === ref.locator && row.ref.hash === ref.hash);
  check(found.length === 1, 'reference');
  return found[0]!;
}
function nativeTurn(rows: NativeTaskRow[], at: NativeTaskRow, workspace: string) {
  const index = rows.indexOf(at),
    starts = rows
      .slice(0, index)
      .filter((row) => row.record.type === 'event_msg' && payload(row).type === 'task_started'),
    start = starts.at(-1);
  check(start !== undefined, 'position');
  const turnId = text(payload(start).turn_id),
    contexts = rows.filter(
      (row) => row.record.type === 'turn_context' && payload(row).turn_id === turnId,
    );
  check(
    starts.filter((row) => payload(row).turn_id === turnId).length === 1 && contexts.length === 1,
    'turn',
  );
  const context = contexts[0]!,
    value = payload(context);
  check(rows.indexOf(start) < rows.indexOf(context) && rows.indexOf(context) < index, 'position');
  check(value.cwd === workspace && value.approval_policy === 'never', 'permissions');
  equal(value.sandbox_policy, { type: 'danger-full-access' }, 'permissions');
  equal(value.permission_profile, { type: 'disabled' }, 'permissions');
  return turnId;
}
function completed(row: NativeTaskRow, threadId: string, turnId: string) {
  const value = payload(row);
  exactFields(value, ['type', 'thread_id', 'turn_id', 'item', 'started_at_ms', 'completed_at_ms']);
  check(
    row.record.type === 'event_msg' &&
      value.type === 'item_completed' &&
      value.thread_id === threadId &&
      value.turn_id === turnId,
    'completion',
  );
  check(
    Number.isSafeInteger(value.started_at_ms) &&
      Number(value.started_at_ms) >= 0 &&
      Number.isSafeInteger(value.completed_at_ms) &&
      Number(value.completed_at_ms) >= Number(value.started_at_ms),
    'completion-time',
  );
  return object(value.item);
}
/** Pure grammar check. Actual filesystem/current-host authority belongs to taskHumanAuthority. */
export function verifyNativeHumanChoice(input: {
  context: NativeHumanContext;
  links: NativeHumanLinks;
  transcript: string;
  rows: Pick<NativeTaskRow, 'raw' | 'ref'>[];
  references: NativeHumanReferences;
}) {
  exactFields(object(input), ['context', 'links', 'transcript', 'rows', 'references']);
  const { context, links } = input,
    question = nativeHumanQuestion(context, links);
  absolute(input.transcript);
  check(Array.isArray(input.rows) && input.rows.length > 0, 'rows');
  const rows: NativeTaskRow[] = input.rows.map((row, index) => {
    exactFields(object(row), ['raw', 'ref']);
    exactFields(object(row.ref), ['locator', 'hash']);
    equal(
      row.ref,
      { locator: input.transcript + '#L' + (index + 1), hash: digest(row.raw) },
      'row-ref',
    );
    check(
      row.raw.endsWith('\n') &&
        !row.raw.slice(0, -1).includes('\n') &&
        Buffer.from(row.raw).toString('utf8') === row.raw,
      'row-bytes',
    );
    const record = object(JSON.parse(row.raw) as unknown);
    object(record.payload);
    return { ...row, record };
  });
  exactFields(object(input.references), ['call', 'publication', 'reply', 'delivery']);
  const call = selected(rows, input.references.call),
    publication = selected(rows, input.references.publication),
    reply = selected(rows, input.references.reply),
    delivery = selected(rows, input.references.delivery);
  check(
    rows.indexOf(call) < rows.indexOf(publication) &&
      rows.indexOf(publication) < rows.indexOf(reply) &&
      rows.indexOf(reply) < rows.indexOf(delivery),
    'order',
  );
  const sessions = rows.filter((row) => row.record.type === 'session_meta');
  check(sessions.length === 1, 'session');
  const session = payload(sessions[0]!);
  check(
    isNativeDesktopUser166(session) &&
      session.id === context.chat.threadId &&
      session.session_id === context.chat.threadId &&
      session.cwd === context.chat.workspace,
    'session',
  );
  const questionTurn = nativeTurn(rows, call, context.chat.workspace),
    replyTurn = nativeTurn(rows, reply, context.chat.workspace);
  check(
    !hasNativeDesktopInboundDelivery(
      rows.map((row) => row.record),
      questionTurn,
    ) &&
      !hasNativeDesktopInboundDelivery(
        rows.map((row) => row.record),
        replyTurn,
      ),
    'inbound',
  );
  const request = payload(call),
    args = { questions: [{ title: question.title, options: question.options }] };
  check(
    call.record.type === 'response_item' &&
      request.type === 'function_call' &&
      request.name === 'request_user_input_async' &&
      request.status === 'completed' &&
      object(request.internal_chat_message_metadata_passthrough).turn_id === questionTurn,
    'call',
  );
  const callId = text(request.call_id);
  equal(request.arguments, JSON.stringify(args), 'question');
  check(
    rows.filter(
      (row) =>
        row.record.type === 'response_item' &&
        payload(row).type === 'function_call' &&
        payload(row).call_id === callId,
    ).length === 1,
    'duplicate-call',
  );
  const shown = completed(publication, context.chat.threadId, questionTurn);
  exactFields(shown, ['type', 'id', 'content', 'phase', 'delivery', 'questions']);
  check(
    shown.type === 'AgentMessage' &&
      shown.id === callId &&
      shown.phase === 'final_answer' &&
      shown.delivery === 'async',
    'publication',
  );
  equal(shown.questions, args.questions, 'publication');
  equal(
    shown.content,
    [{ type: 'Text', text: question.title + '\n- Принять\n- Отклонить' }],
    'publication',
  );
  check(nativeTurn(rows, publication, context.chat.workspace) === questionTurn, 'publication-turn');
  check(
    rows.filter(
      (row) =>
        row.record.type === 'event_msg' &&
        payload(row).type === 'item_completed' &&
        object(payload(row).item).id === callId,
    ).length === 1,
    'duplicate-publication',
  );
  const human = payload(reply);
  exactFields(human, [
    'type',
    'id',
    'role',
    'content',
    'internal_chat_message_metadata_passthrough',
  ]);
  check(
    reply.record.type === 'response_item' && human.type === 'message' && human.role === 'user',
    'user',
  );
  text(human.id);
  const metadata = object(human.internal_chat_message_metadata_passthrough);
  exactFields(metadata, ['turn_id', 'create_time', 'content_item_kinds', 'content_item_metadata']);
  check(
    metadata.turn_id === replyTurn &&
      typeof metadata.create_time === 'number' &&
      Number.isFinite(metadata.create_time),
    'user-turn',
  );
  equal(metadata.content_item_kinds, ['user.text'], 'provenance');
  equal(metadata.content_item_metadata, [{ provenance: { type: 'user' } }], 'provenance');
  check(Array.isArray(human.content) && human.content.length === 1, 'user-content');
  const part = object(human.content[0]);
  exactFields(part, ['type', 'text']);
  const body = part.text,
    prefix = '<send_user_message_question_reply>\n',
    suffix = '\n</send_user_message_question_reply>\n';
  check(
    part.type === 'input_text' &&
      typeof body === 'string' &&
      body.startsWith(prefix) &&
      body.endsWith(suffix),
    'answer',
  );
  const answers: unknown = JSON.parse(body.slice(prefix.length, -suffix.length));
  check(Array.isArray(answers) && answers.length === 1, 'answer');
  const answer = object(answers[0]);
  exactFields(answer, ['questionItemId', 'question', 'answer']);
  equal(
    answer.questionItemId,
    JSON.stringify(['request_user_input_async', callId, 0]),
    'question-id',
  );
  check(
    answer.question === question.title &&
      (answer.answer === taskHumanChoices[0] || answer.answer === taskHumanChoices[1]),
    'answer',
  );
  equal(body, prefix + JSON.stringify(answers) + suffix, 'answer-bytes');
  check(
    !rows.some(
      (row) =>
        rows.indexOf(row) > rows.indexOf(publication) &&
        row !== reply &&
        row.record.type === 'response_item' &&
        payload(row).type === 'message' &&
        payload(row).role === 'user',
    ),
    'other-user',
  );
  const delivered = completed(delivery, context.chat.threadId, replyTurn);
  exactFields(delivered, ['type', 'id', 'client_id', 'content']);
  check(delivered.type === 'UserMessage', 'delivery');
  text(delivered.id);
  text(delivered.client_id);
  equal(delivered.content, [{ type: 'text', text: body, text_elements: [] }], 'delivery');
  check(nativeTurn(rows, delivery, context.chat.workspace) === replyTurn, 'delivery-turn');
  check(
    rows.filter((row) => {
      if (
        row.record.type !== 'event_msg' ||
        payload(row).type !== 'item_completed' ||
        payload(row).turn_id !== replyTurn
      )
        return false;
      const item = object(payload(row).item);
      return (
        item.type === 'UserMessage' &&
        Array.isArray(item.content) &&
        item.content.some((p) => object(p).text === body)
      );
    }).length === 1,
    'duplicate-delivery',
  );
  return {
    kind: 'task-human-native-choice/1' as const,
    accepted: answer.answer === taskHumanChoices[0],
    questionId: context.questionId,
    criterionId: context.criterion.id,
    expectedHumanRevision: context.expectedHumanRevision,
    requirementsRevision: context.target.requirementsRevision,
    contextHash: question.contextHash,
    questionItemId: answer.questionItemId,
    questionTurn,
    replyTurn,
    references: structuredClone(input.references),
  };
}
