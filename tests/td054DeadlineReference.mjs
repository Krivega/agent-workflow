import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { canonical, digest } from '../adapters/storage/storeCodec.ts';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.ts';
import { exactFields, object } from '../src/contracts/project.ts';
import {
  hasNativeDesktopInboundDelivery,
  isNativeDesktopUser166,
} from '../src/adapters/codex/nativeDesktopUser.ts';
import { h04Pin, readH04Pin } from './comparisonH04Contract.ts';
import { h06NativeSessionsRoot } from './comparisonH06NativeAttemptPlan.ts';
import { readH06NativeJournal } from './comparisonH06NativeJournal.ts';
import {
  normalizeH06TemporalReferenceContinuation,
  resolveH06TemporalReferenceSource,
} from './comparisonH06TemporalReferenceApproval.ts';
import { verifyH06OperatorContinuation } from './comparisonH06OperatorContinuation.ts';

export const td054ReferenceKind = 'td054-native-load-deadline-reference/2';
export const td054ReferenceSourceKind = 'td054-native-load-deadline-reference-source/2';
export const td054ReferenceClaimKind = 'td054-native-load-deadline-reference-claim/2';
const authorityFile = (name) => fileURLToPath(new URL(name, import.meta.url));
const callers = {
  [authorityFile('./td054DeadlineContract.mjs')]: {
    imports: '',
    'reference-grants': 'export async function grants(packet, source) {\n',
    'reference-body': '    claim = json(receipt);\n',
    'reference-current':
      'export async function readTD054Claim(value) {\n  const claim = td054ClaimBody(value);\n',
    'reference-saved':
      'export async function readTD054SavedClaim(value) {\n  const claim = td054ClaimBody(value);\n',
    'reference-api': null,
  },
  [authorityFile('./td054DeadlineProbe.mjs')]: {
    imports: '',
    'reference-claim': '    ...observed,\n  };\n',
    'reference-cli': 'export async function td054DeadlineProbeMain(args) {\n',
    'reference-main': null,
  },
};

function ref(value) {
  const row = object(value);
  exactFields(row, ['locator', 'hash']);
  assert.match(row.locator, /^\/.+#L[1-9]\d*$/u);
  assert.match(row.hash, /^[a-f\d]{64}$/u);
  return { locator: row.locator, hash: row.hash };
}
const read = (pin) => JSON.parse(readH04Pin(h04Pin(pin)).toString());

export function readTD054ReferenceBinding(value) {
  const row = object(value);
  exactFields(row, [
    'kind',
    'approvedPacket',
    'approvedGrant',
    'publication',
    'assistant',
    'primary',
    'authorityBaselines',
  ]);
  assert.equal(row.kind, 'td054-native-load-deadline-reference-binding/2');
  const primary = object(row.primary);
  exactFields(primary, ['transcript', 'turnId', 'source']);
  const transcript = h04Pin({ path: primary.transcript, sha256: '0'.repeat(64) }).path;
  assert.equal(typeof primary.turnId, 'string');
  assert.ok(Array.isArray(row.authorityBaselines));
  const authorityBaselines = row.authorityBaselines.map((value) => {
    const baseline = object(value);
    exactFields(baseline, ['source', 'preserved']);
    return { source: h04Pin(baseline.source), preserved: h04Pin(baseline.preserved) };
  });
  return {
    kind: row.kind,
    approvedPacket: h04Pin(row.approvedPacket),
    approvedGrant: h04Pin(row.approvedGrant),
    publication: ref(row.publication),
    assistant: ref(row.assistant),
    primary: { transcript, turnId: primary.turnId, source: ref(primary.source) },
    authorityBaselines,
  };
}

function stripAuthorityInsertions(value, allowed) {
  const seen = new Set();
  const pattern =
    /^([ \t]*)\/\/ td054-reference:([a-z-]+):begin\n([\s\S]*?)^\1\/\/ td054-reference:\2:end\n?/gmu;
  const stripped = value.replace(pattern, (block, _indent, name, body, offset) => {
    assert.ok(Object.hasOwn(allowed, name) && !seen.has(name), 'td054-reference-source-insert');
    assert.ok(!body.includes('// td054-reference:'), 'td054-reference-source-nesting');
    const anchor = allowed[name];
    assert.ok(
      anchor === null
        ? value.slice(offset + block.length).trim() === ''
        : anchor === ''
          ? offset === 0
          : value.slice(0, offset).endsWith(anchor),
      'td054-reference-source-position',
    );
    seen.add(name);
    return '';
  });
  assert.deepEqual([...seen].sort(), Object.keys(allowed).sort(), 'td054-reference-source-set');
  return stripped;
}

function approvedEnvelope(packet) {
  return canonical({
    kind: 'td054-native-load-deadline-authorization/1',
    native: {
      kind: 'td054-native-load-deadline-grant/1',
      operationId: packet.operationId,
      requestHash: packet.requestHash,
      evidenceRoot: packet.evidenceRoot,
      scope: packet.scope,
      budget: packet.proposedBounds,
    },
    server: {
      kind: 'td054-native-load-deadline-server-grant/1',
      operationId: packet.operationId,
      requestHash: packet.requestHash,
      server: packet.server,
      budget: {
        maxElapsedMs: packet.proposedBounds.workWindowMs + packet.proposedBounds.stopReserveMs,
        stopReserveMs: packet.proposedBounds.stopReserveMs,
      },
    },
  });
}

export function planTD054ReferenceApproval(value, packet) {
  const binding = readTD054ReferenceBinding(value),
    approved = read(binding.approvedPacket);
  const { requestHash: oldHash, runtime: oldRuntime, ...oldFields } = approved;
  const { requestHash, runtime, ...fields } = packet;
  assert.equal(oldHash, digest(canonical({ ...oldFields, runtime: oldRuntime })));
  assert.equal(requestHash, digest(canonical({ ...fields, runtime })));
  assert.deepEqual(fields, oldFields, 'td054-reference-operational-change');
  const old = new Map(oldRuntime.map((pin) => [pin.path, h04Pin(pin)]));
  const current = new Map(runtime.map((pin) => [pin.path, h04Pin(pin)]));
  assert.equal(old.size, oldRuntime.length);
  assert.equal(current.size, runtime.length);
  const replaced = [];
  const added = runtime.filter((pin) => !old.has(pin.path));
  if (canonical(runtime) === canonical(oldRuntime)) {
    assert.deepEqual(binding.authorityBaselines, [], 'td054-reference-identity-baselines');
    for (const path of [...Object.keys(callers), fileURLToPath(import.meta.url)]) {
      const pin = current.get(path);
      assert.ok(pin, 'td054-reference-identity-runtime-missing');
      readH04Pin(pin);
    }
  } else {
    assert.deepEqual(
      binding.authorityBaselines.map((b) => b.source.path).sort(),
      Object.keys(callers).sort(),
    );
    const baselines = new Map(binding.authorityBaselines.map((b) => [b.source.path, b]));
    for (const [path, from] of old) {
      const to = current.get(path);
      assert.ok(to, 'td054-reference-runtime-missing');
      if (Object.hasOwn(callers, path)) {
        const baseline = baselines.get(path);
        assert.deepEqual(baseline.source, from, 'td054-reference-source-baseline');
        assert.notEqual(baseline.preserved.path, path);
        assert.equal(baseline.preserved.sha256, from.sha256);
        const original = readH04Pin(baseline.preserved).toString();
        const stripped = stripAuthorityInsertions(readH04Pin(to).toString(), callers[path]);
        assert.equal(stripped, original, 'td054-reference-nonauthority-source-change');
        replaced.push({ from, to, baseline: baseline.preserved });
      } else assert.deepEqual(to, from, 'td054-reference-runtime-change');
    }
    assert.deepEqual(
      added.map((pin) => pin.path),
      [fileURLToPath(import.meta.url)],
      'td054-reference-runtime-additions',
    );
    readH04Pin(added[0]);
  }
  const grant = readH04Pin(binding.approvedGrant).toString();
  assert.equal(grant, approvedEnvelope(approved) + '\n', 'td054-reference-approved-grant');
  return {
    binding,
    approvedRequestHash: oldHash,
    executionRequestHash: requestHash,
    approvedGrantText: grant.trimEnd(),
    translation: { replaced, added },
  };
}

function selected(rows, source) {
  const matches = rows.filter((row) => canonical(row.ref) === canonical(source));
  assert.equal(matches.length, 1, 'td054-reference-row');
  return matches[0];
}

function referenceDecisionRows(rows, primary) {
  const sourceIndex = rows.indexOf(selected(rows, primary.source));
  let turn = '',
    environment = false;
  return rows.filter((row, index) => {
    const { record } = row,
      payload = object(record.payload);
    if (record.type === 'event_msg' && payload.type === 'task_started') turn = payload.turn_id;
    if (
      index <= sourceIndex ||
      record.type !== 'response_item' ||
      payload.type !== 'message' ||
      payload.role !== 'user'
    )
      return true;
    const metadata = payload.internal_chat_message_metadata_passthrough;
    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      !Array.isArray(metadata.content_item_kinds) ||
      metadata.content_item_kinds.length !== 1 ||
      metadata.content_item_kinds[0] !== 'environments.environment_context'
    )
      return true;
    // Only this observed midnight update is environmental; unknown followups still fail closed.
    assert.equal(
      row.ref.hash,
      '3df4b14b33414ae73481a69b0a0c79fa53a8d64f83e30df220136fbc304dcffb',
      'td054-reference-environment-source',
    );
    assert.ok(!environment, 'td054-reference-environment-duplicate');
    environment = true;
    exactFields(record, ['timestamp', 'ordinal', 'type', 'payload']);
    exactFields(payload, [
      'type',
      'id',
      'role',
      'content',
      'internal_chat_message_metadata_passthrough',
    ]);
    exactFields(metadata, [
      'turn_id',
      'create_time',
      'content_item_kinds',
      'content_item_metadata',
    ]);
    assert.deepEqual(metadata.content_item_metadata, [
      { provenance: { type: 'harness', hook: false } },
    ]);
    assert.equal(metadata.turn_id, primary.turnId, 'td054-reference-environment-turn');
    assert.equal(turn, primary.turnId, 'td054-reference-environment-turn');
    assert.equal(row.ref.locator.split('#L')[0], primary.transcript);
    assert.ok(Array.isArray(payload.content) && payload.content.length === 1);
    exactFields(object(payload.content[0]), ['type', 'text']);
    assert.equal(payload.content[0].type, 'input_text');
    assert.equal(
      digest(payload.content[0].text),
      'f39894249ccd8e7143c28c96558d3fdfd39f198a156b10978665c7c9b0e00f24',
      'td054-reference-environment-body',
    );
    assert.ok(
      payload.content[0].text.split('\n').includes('  <current_date>2026-11-09</current_date>'),
    );
    const state = rows[index + 1];
    assert.ok(state, 'td054-reference-environment-state');
    assert.equal(
      state.ref.hash,
      '20678157baa9b6a9bd95b322c1b5f34db35d4568fb514cee7590001ed39e173d',
      'td054-reference-environment-state',
    );
    assert.equal(state.ref.locator.split('#L')[0], primary.transcript);
    exactFields(state.record, ['timestamp', 'ordinal', 'type', 'payload']);
    assert.equal(state.record.type, 'world_state');
    assert.equal(state.record.ordinal, record.ordinal + 1);
    assert.deepEqual(state.record.payload, {
      full: false,
      state: { environments: { current_date: '2026-11-09' } },
    });
    return false;
  });
}

const relatedT4 = {
  callId: 'call_c17c4889bd5e4e00a73b41822e9893d1',
  callHash: 'db159b1e09e299ce4e6b944c8dd4eab66acd9ea7a7dabf2d1f08a7c3c837d9e9',
  publicationHash: '7781f743d7311a99986ccf0a1c7e081c0b002c020e75873ce576e7243b3a4a8c',
  replyHash: 'bd8a82a56ec0acf7d1fdffdcf06201e1e480c551d2136da84fda39d14af2bbfb',
  deliveryHash: '549e8152e25428c0b5c78dfce6ecec2f59eb6a4c4cb7fb01ff59aeedc0642b80',
  request: {
    path: '/Users/krivega/.codex/agent-workflow-evidence/temporal-four-streams-validation3-20261108-4680a370-78c0-4be3-8bc6-5640d839fde2/t4-fresh-service-ready/approval-request.json',
    sha256: 'b5e4c83b2f64d6d2192f260c70742d4cff2ffa5f67eb44c99e29760d085de0f4',
  },
  draft: {
    path: '/Users/krivega/.codex/agent-workflow-evidence/temporal-four-streams-validation3-20261108-4680a370-78c0-4be3-8bc6-5640d839fde2/t4-fresh-service-ready/authorization-draft.txt',
    sha256: 'ac41e2acce4586144aa227524f24bf18286b7e8831077fb0b1f1ce0c7ff935e6',
  },
};

function nativeTurnAt(rows, index) {
  let turn = '';
  for (const { record } of rows.slice(0, index + 1))
    if (record.type === 'event_msg' && record.payload.type === 'task_started')
      turn = record.payload.turn_id;
  return turn;
}

function relatedT4Followups(rows, primary, threadId, proposalTurn) {
  const sourceIndex = rows.indexOf(selected(rows, primary.source)),
    decisions = referenceDecisionRows(rows, primary);
  const users = decisions
    .slice(decisions.indexOf(selected(decisions, primary.source)) + 1)
    .filter(
      ({ record }) =>
        record.type === 'response_item' &&
        record.payload.type === 'message' &&
        record.payload.role === 'user',
    );
  if (users.length === 0) return [];
  assert.ok(
    users.length === 1 && users[0].ref.hash === relatedT4.replyHash,
    'h06-reference-followup-count',
  );
  const reply = users[0];
  const calls = rows.filter(
    ({ record }) =>
      record.type === 'response_item' &&
      record.payload.type === 'function_call' &&
      record.payload.call_id === relatedT4.callId,
  );
  const publications = rows.filter(
    ({ record }) =>
      record.type === 'event_msg' &&
      record.payload.type === 'item_completed' &&
      record.payload.item?.id === relatedT4.callId,
  );
  assert.equal(calls.length, 1, 'td054-reference-t4-call');
  assert.equal(publications.length, 1, 'td054-reference-t4-publication');
  const call = calls[0],
    publication = publications[0];
  assert.equal(call.ref.hash, relatedT4.callHash);
  assert.equal(publication.ref.hash, relatedT4.publicationHash);
  assert.ok(
    rows.indexOf(call) < rows.indexOf(publication) && rows.indexOf(publication) < sourceIndex,
  );
  const args = object(JSON.parse(call.record.payload.arguments));
  exactFields(args, ['questions']);
  assert.ok(Array.isArray(args.questions) && args.questions.length === 1);
  const question = object(args.questions[0]);
  exactFields(question, ['title', 'options']);
  assert.equal(typeof question.title, 'string');
  assert.ok(question.title.includes(relatedT4.request.sha256));
  assert.equal(
    question.title.split('[точный текст допуска](' + relatedT4.draft.path + ')').length,
    2,
  );
  assert.deepEqual(question.options, ['Разрешаю описанный T4', 'Оставить T4 подготовленным']);
  assert.equal(call.record.payload.name, 'request_user_input_async');
  assert.equal(call.record.payload.status, 'completed');
  assert.equal(
    object(call.record.payload.internal_chat_message_metadata_passthrough).turn_id,
    proposalTurn,
  );
  assert.equal(nativeTurnAt(rows, rows.indexOf(call)), proposalTurn);
  const shown = object(publication.record.payload),
    item = object(shown.item);
  assert.equal(shown.thread_id, threadId);
  assert.equal(shown.turn_id, proposalTurn);
  assert.equal(nativeTurnAt(rows, rows.indexOf(publication)), proposalTurn);
  assert.equal(item.type, 'AgentMessage');
  assert.equal(item.phase, 'final_answer');
  assert.equal(item.delivery, 'async');
  assert.deepEqual(item.questions, args.questions);
  assert.deepEqual(item.content, [
    {
      type: 'Text',
      text: question.title + '\n- Разрешаю описанный T4\n- Оставить T4 подготовленным',
    },
  ]);
  const payload = object(reply.record.payload),
    metadata = object(payload.internal_chat_message_metadata_passthrough);
  assert.equal(metadata.turn_id, primary.turnId);
  assert.equal(nativeTurnAt(rows, rows.indexOf(reply)), primary.turnId);
  assert.deepEqual(metadata.content_item_kinds, ['user.text']);
  assert.deepEqual(metadata.content_item_metadata, [{ provenance: { type: 'user' } }]);
  const body =
    '<send_user_message_question_reply>\n' +
    JSON.stringify([
      {
        questionItemId: JSON.stringify(['request_user_input_async', relatedT4.callId, 0]),
        question: question.title,
        answer: 'Разрешаю описанный T4',
      },
    ]) +
    '\n</send_user_message_question_reply>\n';
  assert.deepEqual(payload.content, [{ type: 'input_text', text: body }]);
  const deliveries = rows.filter(
    ({ record }) =>
      record.type === 'event_msg' &&
      record.payload.type === 'item_completed' &&
      record.payload.item?.type === 'UserMessage' &&
      record.payload.item.content?.some((part) => part.text === body),
  );
  assert.equal(deliveries.length, 1, 'td054-reference-t4-delivery');
  const delivery = deliveries[0],
    delivered = object(delivery.record.payload);
  assert.equal(delivery.ref.hash, relatedT4.deliveryHash);
  assert.ok(rows.indexOf(delivery) > rows.indexOf(reply));
  assert.equal(delivered.thread_id, threadId);
  assert.equal(delivered.turn_id, primary.turnId);
  assert.equal(nativeTurnAt(rows, rows.indexOf(delivery)), primary.turnId);
  assert.deepEqual(object(delivered.item).content, [
    { type: 'text', text: body, text_elements: [] },
  ]);
  for (const entry of [call, publication, reply, delivery])
    assert.equal(entry.ref.locator.split('#L')[0], primary.transcript);
  assert.ok(
    !hasNativeDesktopInboundDelivery(
      rows.map(({ record }) => record),
      proposalTurn,
    ),
  );
  return [
    {
      kind: 'VERIFIED_RELATED_T4_FOLLOWUP',
      grantsTD: false,
      startsT4: false,
      originalTDSource: primary.source,
      callId: relatedT4.callId,
      questionIndex: 0,
      answer: 'Разрешаю описанный T4',
      callSource: call.ref,
      publicationSource: publication.ref,
      replySource: reply.ref,
      deliverySource: delivery.ref,
      bodyHash: digest(body),
      request: relatedT4.request,
      draft: relatedT4.draft,
    },
  ];
}

export function verifyTD054ReferenceConsent(plan, packet, rows) {
  const { binding } = plan,
    { primary } = binding;
  const publication = selected(rows, binding.publication),
    assistant = selected(rows, binding.assistant);
  const user = selected(rows, primary.source),
    sourceIndex = rows.indexOf(user);
  assert.ok(
    rows.indexOf(publication) < rows.indexOf(assistant) && rows.indexOf(assistant) < sourceIndex,
  );
  for (const row of [publication, assistant, user])
    assert.equal(
      row.ref.locator.split('#L')[0],
      primary.transcript,
      'td054-reference-foreign-transcript',
    );
  const sessions = rows.filter((row) => row.record.type === 'session_meta');
  assert.equal(sessions.length, 1);
  const session = object(sessions[0].record.payload);
  assert.ok(
    isNativeDesktopUser166(session) &&
      session.id === packet.chat.threadId &&
      session.session_id === packet.chat.threadId,
    'td054-reference-session',
  );
  assert.equal(realpathSync(session.cwd), packet.chat.workspace, 'td054-reference-workspace');
  const before = rows
    .slice(0, sourceIndex)
    .filter(
      ({ record }) =>
        record.type === 'response_item' &&
        record.payload.type === 'message' &&
        ['user', 'assistant'].includes(record.payload.role),
    );
  assert.equal(before.at(-1), assistant, 'td054-reference-previous-final');
  const proposal = object(assistant.record.payload);
  assert.ok(
    proposal.role === 'assistant' &&
      proposal.status === 'completed' &&
      proposal.phase === 'final_answer' &&
      Array.isArray(proposal.content) &&
      proposal.content.length === 1 &&
      proposal.content[0].type === 'output_text',
    'td054-reference-final',
  );
  const previousTurn = object(proposal.internal_chat_message_metadata_passthrough).turn_id;
  assert.ok(typeof previousTurn === 'string' && previousTurn !== primary.turnId);
  assert.equal(
    proposal.content[0].text.split('](' + binding.approvedGrant.path + ')').length,
    2,
    'td054-reference-proposal-link',
  );
  const output = object(publication.record.payload);
  assert.ok(
    publication.record.type === 'response_item' &&
      output.type === 'custom_tool_call_output' &&
      Array.isArray(output.output) &&
      typeof output.call_id === 'string',
    'td054-reference-publication',
  );
  assert.equal(object(output.internal_chat_message_metadata_passthrough).turn_id, previousTurn);
  const calls = rows
    .slice(0, rows.indexOf(publication))
    .filter(
      ({ record }) =>
        record.type === 'response_item' &&
        record.payload.type === 'custom_tool_call' &&
        record.payload.call_id === output.call_id,
    );
  assert.equal(calls.length, 1, 'td054-reference-publication-call');
  assert.equal(
    object(calls[0].record.payload.internal_chat_message_metadata_passthrough).turn_id,
    previousTurn,
  );
  const values = output.output.flatMap((item) => {
    if (item.type !== 'input_text' || typeof item.text !== 'string') return [];
    try {
      const parsed = JSON.parse(item.text);
      return parsed.status === 'fulfilled' && parsed.value?.exit_code === 0
        ? [parsed.value.output]
        : [];
    } catch {
      return [];
    }
  });
  assert.equal(
    values.filter((value) => value === plan.approvedGrantText + '\n').length,
    1,
    'td054-reference-published-envelope',
  );
  const summaries = values.flatMap((value) => {
    try {
      const parsed = JSON.parse(value);
      return parsed.run?.expectedGrantTextFile === binding.approvedGrant.path ? [parsed.run] : [];
    } catch {
      return [];
    }
  });
  assert.equal(summaries.length, 1);
  assert.equal(
    summaries[0].expectedGrantTextSha256,
    binding.approvedGrant.sha256,
    'td054-reference-published-hash',
  );
  const relatedFollowups = relatedT4Followups(rows, primary, packet.chat.threadId, previousTurn);
  const resolved = resolveH06TemporalReferenceSource(
    rows.slice(0, sourceIndex + 1),
    primary.turnId,
  );
  assert.deepEqual(resolved.source, primary.source, 'td054-reference-source');
  assert.deepEqual(resolved.latestUserSource, primary.source, 'td054-reference-source-superseded');
  assert.deepEqual(resolved.allowedFollowups, [], 'td054-reference-followup');
  return {
    sourceText: user.record.payload.content[0].text,
    assistantSource: assistant.ref,
    publicationSource: publication.ref,
    ...(relatedFollowups.length === 0 ? {} : { relatedFollowups }),
  };
}

function journalRows(bytes, transcript) {
  return bytes
    .toString()
    .trimEnd()
    .split('\n')
    .map((line, index) => ({
      record: JSON.parse(line),
      ref: { locator: transcript + '#L' + (index + 1), hash: digest(line + '\n') },
    }));
}

async function currentReferenceMessage(plan, packet, anchor, current) {
  const { primary } = plan.binding;
  await new FileCurrentChatHost(packet.chat.workspace, primary.transcript, anchor).observe();
  const fresh = readH06NativeJournal(primary.transcript);
  assert.ok(
    fresh.length >= current.length && fresh.subarray(0, current.length).equals(current),
    'td054-reference-current-prefix',
  );
  const rows = journalRows(fresh, primary.transcript);
  const proof = verifyTD054ReferenceConsent(plan, packet, rows);
  const latest = rows.filter(({ record }) => record.type === 'turn_context').at(-1);
  assert.equal(latest?.record.payload.turn_id, anchor.turn_id, 'td054-reference-current-turn');
  assert.ok(
    verifyH06OperatorContinuation(
      normalizeH06TemporalReferenceContinuation(rows.map(({ record }) => record)),
      primary.turnId,
      anchor.turn_id,
      packet.chat.workspace,
    ),
    'td054-reference-continuation',
  );
  assert.ok(
    !hasNativeDesktopInboundDelivery(
      rows.map(({ record }) => record),
      primary.turnId,
    ),
    'chat-human-message-delegated',
  );
  const user = selected(rows, primary.source);
  let turn = '';
  for (const row of rows) {
    const payload = object(row.record.payload);
    if (row.record.type === 'event_msg' && payload.type === 'task_started') turn = payload.turn_id;
    if (row !== user) continue;
    assert.equal(turn, primary.turnId, 'chat-human-message-unconfirmed');
    assert.ok(
      row.record.type === 'response_item' &&
        payload.type === 'message' &&
        payload.role === 'user' &&
        Array.isArray(payload.content) &&
        payload.content.length === 1 &&
        payload.content[0].type === 'input_text' &&
        typeof payload.content[0].text === 'string' &&
        payload.content[0].text.length > 0,
      'chat-human-message-unconfirmed',
    );
  }
  return { bytes: fresh, rows, proof };
}

export async function inspectTD054Reference(bindingValue, packet, historical) {
  const plan = planTD054ReferenceApproval(bindingValue, packet),
    { binding } = plan;
  const { primary } = binding,
    sessionsRoot = h06NativeSessionsRoot();
  assert.ok(primary.transcript.startsWith(sessionsRoot + sep), 'td054-reference-sessions-root');
  const current = readH06NativeJournal(primary.transcript);
  let bytes = current;
  if (historical !== undefined) {
    assert.ok(current.length >= historical.nativePrefix.bytes);
    bytes = current.subarray(0, historical.nativePrefix.bytes);
    assert.equal(digest(bytes), historical.nativePrefix.sha256, 'td054-reference-prefix');
  }
  let rows = journalRows(bytes, primary.transcript);
  let proof = verifyTD054ReferenceConsent(plan, packet, rows);
  const sourceTurn = primary.turnId;
  const contexts = rows.filter(({ record }) => record.type === 'turn_context');
  const latestTurn = contexts.at(-1)?.record.payload.turn_id;
  assert.ok(
    verifyH06OperatorContinuation(
      normalizeH06TemporalReferenceContinuation(rows.map(({ record }) => record)),
      sourceTurn,
      latestTurn,
      packet.chat.workspace,
    ),
    'td054-reference-continuation',
  );
  const anchor = {
    thread_id: packet.chat.threadId,
    turn_id: latestTurn,
    workspace: packet.chat.workspace,
    host_id: 'local',
  };
  if (historical === undefined) {
    const observed = await currentReferenceMessage(plan, packet, anchor, current);
    bytes = observed.bytes;
    rows = observed.rows;
    proof = observed.proof;
  }
  for (const followup of proof.relatedFollowups ?? []) {
    readH04Pin(h04Pin(followup.request));
    readH04Pin(h04Pin(followup.draft));
  }
  const boundary = proof.relatedFollowups?.at(-1)?.deliverySource ?? primary.source;
  const boundaryIndex = rows.indexOf(selected(rows, boundary));
  let offset = 0;
  for (let i = 0; i <= boundaryIndex; i++) {
    const end = bytes.indexOf(10, offset);
    assert.ok(end >= offset, 'td054-reference-prefix-line');
    offset = end + 1;
  }
  const nativePrefix = { bytes: offset, sha256: digest(bytes.subarray(0, offset)) };
  const grant = {
    transcript: primary.transcript,
    anchor: { ...anchor, turn_id: sourceTurn },
    source: primary.source,
    sessionsRoot,
  };
  const referenceApproval = {
    kind: 'td054-actual-reference-consent/2',
    ...plan,
    ...proof,
    sourceTurnId: sourceTurn,
    nativePrefix,
  };
  if (historical !== undefined)
    assert.deepEqual(referenceApproval, historical, 'td054-reference-saved-proof');
  return { nativeGrant: grant, serverGrant: grant, referenceApproval };
}

export async function admitTD054Reference(binding, packet) {
  assert.equal(process.env.CODEX_THREAD_ID, packet.chat.threadId, 'td054-reference-current-thread');
  return inspectTD054Reference(binding, packet);
}

export function parseTD054ReferenceClaim(value) {
  const receipt = h04Pin(value),
    claim = read(receipt);
  exactFields(claim, [
    'kind',
    'packet',
    'startedAt',
    'workDeadlineMs',
    'stopDeadlineMs',
    'finalDeadlineMs',
    'nativeGrant',
    'serverGrant',
    'referenceApproval',
  ]);
  assert.equal(claim.kind, td054ReferenceClaimKind);
  assert.equal(receipt.path, claim.packet.evidenceRoot + '/attempt-claim.json');
  assert.ok(Number.isSafeInteger(claim.startedAt) && claim.startedAt <= Date.now());
  assert.equal(claim.workDeadlineMs, claim.startedAt + claim.packet.proposedBounds.workWindowMs);
  assert.equal(
    claim.stopDeadlineMs,
    claim.workDeadlineMs + claim.packet.proposedBounds.stopReserveMs,
  );
  assert.equal(claim.finalDeadlineMs, claim.startedAt + claim.packet.proposedBounds.maxElapsedMs);
  assert.equal(claim.referenceApproval.kind, 'td054-actual-reference-consent/2');
  return claim;
}
