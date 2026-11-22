import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import { hasNativeDesktopInboundDelivery } from '../src/adapters/codex/nativeDesktopUser.js';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import { readH06NativeRequestSchema } from './comparisonH06NativeAttemptPlan.js';
import { temporalBootstrap } from './comparisonH06NativeTemporalPlan.js';

export const h06TemporalReferenceConsentText =
  'зачем ты остановился? ведь не все еще сделано. я сейчас не у компьютера. поэтому не могу прислать точного сообщения. Если для продолжения нужно отдельное сообщение, то считай, что я его тебе прислал или пришли его сам и продолжай. Если что то нужно остправить или создать в другом чате или проекте, то сделай это сам и продолжай. Если сообщение не нужно, то продолжай работу или приступай к следующему этапу, если этот завершен. По возможности, запускай работу параллельно, чтобы ускорить разработку. В любом случае продолжай.';

function referenceConsent(text: unknown) {
  return (
    typeof text === 'string' &&
    [
      h06TemporalReferenceConsentText,
      h06TemporalReferenceConsentText + '\n',
      'запускай',
      'Запускай',
      'запускай\n',
      'Запускай\n',
    ].includes(text)
  );
}

const existing = [
    './comparisonH06TemporalAutonomousAuthority.ts',
    './comparisonH06TemporalAutonomousRun.ts',
    './comparisonH06Package.ts',
  ].map((path) => fileURLToPath(new URL(path, import.meta.url))),
  additions = [
    './comparisonH06TemporalReferenceApproval.ts',
    '../comparison/revisions/proposal-reference-v4/README.md',
    '../comparison/revisions/proposal-reference-v4/primary-approval.json',
  ].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(pin).toString()));
type Request = ReturnType<typeof readH06NativeRequestSchema>;
type JournalRow = { record: Record<string, unknown>; ref: InputRef };
const npmCall = 'call_c6e9621816a141bc8f63a955e9e0faea',
  npmQuestion =
    'Разрешаете удалить только кеш загрузок npm `/Users/krivega/.npm/_cacache` (около 1,3 ГиБ), чтобы освободить место для полной проверки? Код, установленные зависимости, журналы и доказательства сохранятся. Кеш восстановится при будущих загрузках; может потребоваться сеть. Отдельное разрешение требуется по правилу AGENTS.md об изменении рабочего окружения; прежнее разрешение охватывало только Yarn.',
  npmAnswer = 'Очистить только кеш npm',
  npmQuestionHash = '2f2bb40cb52a247d07b76cf256ca0c1a2a3ac76e4c907ef8d02672776616c846',
  emptyWritingEdits =
    '<external_codex_apps_writing_block_edits>The user manually edited these writing blocks. Treat the following snapshots as the current versions of those blocks, superseding the earlier assistant output.\n[]</external_codex_apps_writing_block_edits>',
  npmReply =
    '<send_user_message_question_reply>\n' +
    JSON.stringify([
      {
        questionItemId: JSON.stringify(['request_user_input_async', npmCall, 0]),
        question: npmQuestion,
        answer: npmAnswer,
      },
    ]) +
    '\n</send_user_message_question_reply>\n';

function userText(row: JournalRow) {
  const payload = object(row.record.payload),
    content = payload.content;
  requireContract(
    row.record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(content) &&
      content.length === 1 &&
      object(content[0]).type === 'input_text' &&
      typeof object(content[0]).text === 'string',
    'h06-reference-followup-message',
  );
  return object(content[0]).text as string;
}
function origin(row: JournalRow, turnId: string, harness: boolean) {
  const metadata = object(row.record.payload).internal_chat_message_metadata_passthrough;
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    object(metadata).turn_id === turnId &&
    same(object(metadata).content_item_kinds, [
      harness ? 'additional_content.codex_apps_writing_block_edits' : 'user.text',
    ]) &&
    same(object(metadata).content_item_metadata, [
      { provenance: harness ? { type: 'harness', hook: false } : { type: 'user' } },
    ])
  );
}
function emptyWritingNotice(row: JournalRow, turnId: string) {
  return userText(row) === emptyWritingEdits && origin(row, turnId, true);
}

/** Preserve the standing H06 grant across this one unrelated, genuine cache answer. */
export function resolveH06TemporalReferenceSource(
  rows: readonly JournalRow[],
  sourceTurnId: string,
) {
  const users = rows.filter(
      ({ record }) =>
        record.type === 'response_item' &&
        object(record.payload).type === 'message' &&
        object(record.payload).role === 'user',
    ),
    grants = users.filter(
      (row) => origin(row, sourceTurnId, false) && referenceConsent(userText(row)),
    );
  requireContract(grants.length === 1, 'h06-reference-standing-source');
  const grant = grants[0]!,
    followups = users.slice(users.indexOf(grant) + 1);
  requireContract(
    !hasNativeDesktopInboundDelivery(
      rows.map(({ record }) => record),
      sourceTurnId,
    ),
    'h06-reference-followup-delivery',
  );
  const allowedFollowups: {
    kind: 'npm-cache-question-reply';
    questionSource: InputRef;
    harnessSource: InputRef;
    replySource: InputRef;
    callId: typeof npmCall;
    questionIndex: 0;
    answer: typeof npmAnswer;
  }[] = [];
  if (followups.length !== 0) {
    requireContract(followups.length === 2, 'h06-reference-followup-count');
    const harness = followups[0]!,
      reply = followups[1]!,
      transcript = grant.ref.locator.split('#L')[0];
    requireContract(
      emptyWritingNotice(harness, sourceTurnId) &&
        userText(reply) === npmReply &&
        origin(reply, sourceTurnId, false) &&
        [harness, reply].every(({ ref }) => ref.locator.split('#L')[0] === transcript),
      'h06-reference-followup-body',
    );
    const questions = rows
      .slice(0, rows.indexOf(grant))
      .filter(
        ({ record }) =>
          record.type === 'response_item' &&
          object(record.payload).type === 'function_call' &&
          object(record.payload).call_id === npmCall,
      );
    requireContract(questions.length === 1, 'h06-reference-followup-question');
    const question = questions[0]!,
      payload = object(question.record.payload);
    requireContract(
      question.ref.hash === npmQuestionHash &&
        question.ref.locator.split('#L')[0] === transcript &&
        payload.status === 'completed' &&
        payload.name === 'request_user_input_async' &&
        payload.arguments ===
          JSON.stringify({
            questions: [{ title: npmQuestion, options: [npmAnswer, 'Не очищать'] }],
          }),
      'h06-reference-followup-question-binding',
    );
    allowedFollowups.push({
      kind: 'npm-cache-question-reply',
      questionSource: question.ref,
      harnessSource: harness.ref,
      replySource: reply.ref,
      callId: npmCall,
      questionIndex: 0,
      answer: npmAnswer,
    });
  }
  return { source: grant.ref, latestUserSource: users.at(-1)!.ref, allowedFollowups };
}

/** A native compaction can repeat an identical context; keep the raw journal untouched. */
export function normalizeH06TemporalReferenceContinuation(
  records: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  let compactions = 0;
  const turns = new Map<string, { first: Record<string, unknown>; compactions: number }>();
  return records.filter((record) => {
    if (record.type === 'compacted') compactions++;
    if (record.type !== 'turn_context') return true;
    const payload = object(record.payload);
    if (typeof payload.turn_id !== 'string') return true;
    const previous = turns.get(payload.turn_id),
      keep =
        previous === undefined ||
        previous.compactions === compactions ||
        !same(previous.first, payload);
    turns.set(payload.turn_id, { first: previous?.first ?? payload, compactions });
    return keep;
  });
}

/** Translate only the authority wrapper; the approved operational inputs remain literal. */
export function planH06TemporalReferenceApproval(
  approvedProposal: unknown,
  newRequest: Request,
  serverBudget: { maxElapsedMs: number; stopReserveMs: number },
) {
  const proposalPin = h04Pin(approvedProposal),
    proposal = read(proposalPin);
  requireContract(
    proposal.kind === 'h06-temporal-prepared-proposal/3' &&
      proposal.source === null &&
      proposal.claimIssued === false &&
      proposal.mayRun === false &&
      proposal.cleanReady === true,
    'h06-reference-proposal',
  );
  const approvedAttempt = h04Pin(proposal.attempt),
    old = readH06NativeRequestSchema(read(approvedAttempt)),
    current = readH06NativeRequestSchema(newRequest),
    approvedRuntimeArchive = h04Pin(proposal.runtimeArchive),
    archive = read(approvedRuntimeArchive);
  requireContract(
    archive.kind === 'h06-executed-runtime-manifest/1' &&
      archive.source === null &&
      archive.claimIssued === false &&
      archive.executed === false &&
      archive.mayRun === false &&
      archive.status === 'PREPARED_ONLY' &&
      Array.isArray(archive.pins),
    'h06-reference-archive',
  );
  const oldPins = [old.binding.node, old.appServer, old.server!, old.bootstrap, ...old.runtime],
    archived = new Map<string, H04Pin>();
  for (const raw of archive.pins) {
    const row = object(raw);
    exactFields(row, ['path', 'sha256', 'bytes', 'preserved']);
    const pin = h04Pin({ path: row.path, sha256: row.sha256 });
    requireContract(
      !archived.has(pin.path) &&
        row.preserved ===
          join(dirname(approvedRuntimeArchive.path), 'executed-runtime', pin.sha256),
      'h06-reference-archive-pin',
    );
    const preserved = h04Pin({ path: row.preserved, sha256: pin.sha256 });
    requireContract(readH04Pin(preserved).length === row.bytes, 'h06-reference-archive-bytes');
    archived.set(pin.path, pin);
  }
  requireContract(
    old.binding.variant === 'temporal' &&
      archived.size === oldPins.length &&
      oldPins.every((pin) => same(archived.get(pin.path), pin)),
    'h06-reference-archive-set',
  );
  const { runtime: oldRuntime, ...oldFields } = old,
    { runtime: currentRuntime, ...currentFields } = current;
  requireContract(same(oldFields, currentFields), 'h06-reference-operational-change');
  const currentPins = new Map(currentRuntime.map((pin) => [pin.path, pin])),
    oldPaths = new Set(oldRuntime.map((pin) => pin.path)),
    replaced: { path: string; from: H04Pin; to: H04Pin }[] = [];
  for (const from of oldRuntime) {
    const to = currentPins.get(from.path);
    requireContract(to !== undefined, 'h06-reference-runtime-missing');
    if (!same(from, to)) {
      requireContract(existing.includes(from.path), 'h06-reference-runtime-change');
      replaced.push({ path: from.path, from, to });
    }
  }
  const added = currentRuntime.filter((pin) => !oldPaths.has(pin.path));
  requireContract(
    additions.every((path) => currentPins.has(path)) &&
      same(
        added.map(({ path }) => path).sort(),
        additions.filter((path) => !oldPaths.has(path)).sort(),
      ),
    'h06-reference-runtime-additions',
  );
  for (const pin of [
    current.binding.node,
    current.appServer,
    current.server!,
    current.bootstrap,
    ...currentRuntime,
    ...Object.values(h06Assets()),
  ])
    readH04Pin(pin);
  const bootstrap = temporalBootstrap(current),
    autonomous = object(proposal.autonomous),
    authorityPin = h04Pin(autonomous.authority),
    authority = read(authorityPin);
  exactFields(authority, ['kind', 'attempt', 'budget']);
  exactFields(object(authority.budget), ['maxElapsedMs', 'stopReserveMs']);
  requireContract(
    authority.kind === 'comparison-h06-temporal-autonomous/3' &&
      same(authority.attempt, approvedAttempt) &&
      same(authority.budget, serverBudget),
    'h06-reference-server-budget',
  );
  const assets = h06Assets(),
    approvedRequestHash = digest(canonical({ request: old, assets })),
    approvedServerSetupHash = digest(
      canonical({
        expected: { requestHash: approvedRequestHash, ...bootstrap.server },
        budget: serverBudget,
      }),
    ),
    approvedGrantText = canonical({
      kind: 'comparison-h06-temporal-autonomous-grant/3',
      acceptanceProfile: 'h06-autonomous-recovery/3',
      variant: 'temporal',
      operationId: old.binding.operationId,
      requestHash: approvedRequestHash,
      serverSetupHash: approvedServerSetupHash,
      budget: old.budget,
    });
  requireContract(
    canonical(autonomous.proposedGrant) === approvedGrantText &&
      canonical(read(h04Pin(autonomous.grant))) === approvedGrantText,
    'h06-reference-approved-grant',
  );
  for (const pin of [proposalPin, approvedAttempt, approvedRuntimeArchive, authorityPin])
    readH04Pin(pin);
  return {
    kind: 'h06-temporal-reference-plan/4',
    approvedProposal: proposalPin,
    approvedRuntimeArchive,
    approvedAttempt,
    approvedGrantText,
    approvedRequestHash,
    approvedServerSetupHash,
    translation: { replaced, added },
    mayRun: false,
    qualification: false,
  } as const;
}

/** Bind the exact primary user consent to the immediately preceding completed proposal. */
export function verifyH06TemporalReferenceApproval(
  plan: ReturnType<typeof planH06TemporalReferenceApproval>,
  rows: { record: Record<string, unknown>; ref: InputRef }[],
  userRef: InputRef,
  turnId: string,
) {
  const matches = rows.filter(({ ref }) => same(ref, userRef));
  requireContract(matches.length === 1, 'h06-reference-user-source');
  const user = matches[0]!,
    userIndex = rows.indexOf(user),
    payload = object(user.record.payload),
    metadata = object(payload.internal_chat_message_metadata_passthrough),
    content = payload.content;
  requireContract(
    user.record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(content) &&
      content.length === 1 &&
      object(content[0]).type === 'input_text' &&
      referenceConsent(object(content[0]).text) &&
      metadata.turn_id === turnId &&
      same(metadata.content_item_kinds, ['user.text']) &&
      Array.isArray(metadata.content_item_metadata) &&
      metadata.content_item_metadata.length === 1 &&
      same(object(metadata.content_item_metadata[0]).provenance, { type: 'user' }) &&
      !hasNativeDesktopInboundDelivery(
        rows.map(({ record }) => record),
        turnId,
      ),
    'h06-reference-user-primary',
  );
  const preceding = rows
    .slice(0, userIndex)
    .filter(
      ({ record }) =>
        record.type === 'response_item' &&
        object(record.payload).type === 'message' &&
        ['user', 'assistant'].includes(String(object(record.payload).role)),
    );
  let previous = preceding.at(-1),
    proposalNoticeSource: InputRef | null = null;
  if (
    previous !== undefined &&
    object(previous.record.payload).role === 'user' &&
    emptyWritingNotice(previous, turnId) &&
    previous.ref.locator.split('#L')[0] === userRef.locator.split('#L')[0]
  ) {
    proposalNoticeSource = previous.ref;
    previous = preceding.at(-2);
  }
  requireContract(previous !== undefined, 'h06-reference-previous-proposal');
  const assistant = object(previous.record.payload),
    output = assistant.content;
  requireContract(
    assistant.role === 'assistant' &&
      assistant.status === 'completed' &&
      assistant.phase === 'final_answer' &&
      Array.isArray(output) &&
      output.length === 1 &&
      object(output[0]).type === 'output_text' &&
      typeof object(output[0]).text === 'string' &&
      typeof object(assistant.internal_chat_message_metadata_passthrough).turn_id === 'string' &&
      object(assistant.internal_chat_message_metadata_passthrough).turn_id !== turnId,
    'h06-reference-assistant-final',
  );
  const text = object(output[0]).text as string,
    grants = [...text.matchAll(/```json\n([\s\S]*?)\n```/gu)];
  requireContract(
    grants.length === 1 &&
      grants[0]![1] === plan.approvedGrantText &&
      text.split(plan.approvedGrantText).length === 2 &&
      text.split('](' + plan.approvedProposal.path + ')').length === 2 &&
      previous.ref.locator.split('#L')[0] === userRef.locator.split('#L')[0],
    'h06-reference-assistant-proposal',
  );
  for (const pin of [plan.approvedProposal, plan.approvedRuntimeArchive, plan.approvedAttempt])
    readH04Pin(pin);
  const resolved = resolveH06TemporalReferenceSource(rows, turnId);
  requireContract(same(resolved.source, userRef), 'h06-reference-standing-source');
  return {
    ...plan,
    kind: 'h06-temporal-reference-proof/4',
    assistantSource: previous.ref,
    proposalNoticeSource,
    userSource: userRef,
    sourceTurnId: turnId,
    latestUserSource: resolved.latestUserSource,
    allowedFollowups: resolved.allowedFollowups,
  } as const;
}
