import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import type { Json } from '../core/evidence.js';
import type { InputRef } from '../core/localRun.js';
import {
  comparisonDesktopHistory,
  comparisonDesktopRequestRows,
  comparisonDesktopHumanMessage,
  isComparisonDesktopActor,
  isComparisonDesktopUser,
  hasNativeDesktopInboundDelivery,
  isNativeDesktopUser166,
  nativeDesktopCommandTurn,
} from '../src/adapters/codex/nativeDesktopUser.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { h04Pin } from './comparisonH04Contract.js';
import { verifyH06OperatorContinuation } from './comparisonH06OperatorContinuation.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';

export interface H06DelegatedDeliveryInput {
  kind: 'comparison-h06-delegated-delivery/1';
  sessionsRoot: string;
  root: { threadId: string; workspace: string; turnId: string; user: InputRef };
  actor: { threadId: string; workspace: string };
  command: {
    kind: 'comparison-h06-delegated-command/1';
    nonce: string;
    requestHash: string;
    action: string;
    target: Record<string, Json>;
  };
  prompt: string;
}

export interface H06DelegatedDeliveryProof {
  kind: 'h06-delegated-delivery-proof/1';
  input: H06DelegatedDeliveryInput;
  user: InputRef;
  outbound: InputRef;
  inbound: InputRef;
  confirmation: InputRef;
  actorTurnId: string;
  authorityIssued: false;
  mayRun: false;
  qualification: false;
}

interface Row {
  record: Record<string, unknown>;
  turn: string;
  ref: InputRef;
  line: number;
}

function inputRef(value: unknown): InputRef {
  const ref = object(value);
  exactFields(ref, ['locator', 'hash']);
  const locator = text(ref.locator);
  const match = /^(.*)#L([1-9]\d*)$/u.exec(locator);
  requireContract(match !== null, 'h06-delegated-delivery-source');
  return { locator, hash: h04Pin({ path: match[1], sha256: ref.hash }).sha256 };
}

function parseInput(value: unknown): H06DelegatedDeliveryInput {
  const input = object(value);
  exactFields(input, ['kind', 'sessionsRoot', 'root', 'actor', 'command', 'prompt']);
  const root = object(input.root),
    actor = object(input.actor),
    command = object(input.command);
  exactFields(root, ['threadId', 'workspace', 'turnId', 'user']);
  exactFields(actor, ['threadId', 'workspace']);
  exactFields(command, ['kind', 'nonce', 'requestHash', 'action', 'target']);
  requireContract(
    input.kind === 'comparison-h06-delegated-delivery/1' &&
      command.kind === 'comparison-h06-delegated-command/1',
    'h06-delegated-delivery-kind',
  );
  const result: H06DelegatedDeliveryInput = {
    kind: 'comparison-h06-delegated-delivery/1',
    sessionsRoot: safeDirectory(text(input.sessionsRoot)),
    root: {
      threadId: identifier(root.threadId),
      workspace: safeDirectory(text(root.workspace)),
      turnId: identifier(root.turnId),
      user: inputRef(root.user),
    },
    actor: {
      threadId: identifier(actor.threadId),
      workspace: safeDirectory(text(actor.workspace)),
    },
    command: {
      kind: 'comparison-h06-delegated-command/1',
      nonce: identifier(command.nonce),
      requestHash: h04Pin({ path: '/h06-request', sha256: command.requestHash }).sha256,
      action: identifier(command.action),
      target: object(command.target) as Record<string, Json>,
    },
    prompt: input.prompt as string,
  };
  requireContract(
    result.root.threadId !== result.actor.threadId &&
      typeof result.prompt === 'string' &&
      result.prompt.endsWith(canonical(result.command)),
    'h06-delegated-delivery-prompt',
  );
  return result;
}

function transcript(sessionsRoot: string, threadId: string): string {
  const matches: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('-' + threadId + '.jsonl')) matches.push(path);
    }
  }
  visit(sessionsRoot);
  requireContract(matches.length === 1, 'h06-delegated-delivery-transcript');
  return matches[0]!;
}

function rows(path: string): Row[] {
  const bytes = readH06NativeJournal(path),
    body = bytes.toString('utf8');
  requireContract(Buffer.from(body).equals(bytes), 'h06-delegated-delivery-encoding');
  requireContract(body.endsWith('\n'), 'h06-delegated-delivery-partial');
  let turn = '';
  return body
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      const record = object(JSON.parse(line));
      const payload = object(record.payload);
      if (record.type === 'event_msg' && payload.type === 'task_started')
        turn = identifier(payload.turn_id);
      return {
        record,
        turn,
        ref: { locator: path + '#L' + (index + 1), hash: digest(line + '\n') },
        line: index + 1,
      };
    });
}

function session(records: Row[], peer: { threadId: string; workspace: string }, actor: boolean) {
  const sessions = records.filter(({ record }) => record.type === 'session_meta');
  requireContract(sessions.length === 1, 'h06-delegated-delivery-session');
  const value = object(sessions[0]!.record.payload);
  const comparison = actor ? isComparisonDesktopActor(value) : isComparisonDesktopUser(value);
  requireContract(
    (isNativeDesktopUser166(value) || (comparison && value.cwd === peer.workspace)) &&
      value.id === peer.threadId &&
      value.session_id === peer.threadId,
    'h06-delegated-delivery-session',
  );
  return comparison;
}

function context(records: Row[], turnId: string, workspace: string, expectedRoot?: string) {
  const contexts = records
    .filter(({ record }) => record.type === 'turn_context')
    .map(({ record }) => object(record.payload));
  requireContract(
    nativeDesktopCommandTurn(contexts, turnId, workspace) &&
      (expectedRoot === undefined ||
        contexts.find((row) => row.turn_id === turnId)!.root_turn_id === expectedRoot),
    'h06-delegated-delivery-context',
  );
}

function only(records: Row[], code: string): Row {
  requireContract(records.length === 1, code);
  return records[0]!;
}

/** Find one exact native delivery, retaining its real root-user source without issuing authority. */
export function planH06DelegatedDelivery(value: unknown): H06DelegatedDeliveryProof {
  const input = structuredClone(parseInput(value));
  const { root, actor, command, prompt } = input;
  const rootPath = transcript(input.sessionsRoot, root.threadId);
  const actorPath = transcript(input.sessionsRoot, actor.threadId);
  const rootRows = rows(rootPath),
    actorRows = rows(actorPath);
  const direct = session(rootRows, root, false),
    delegated = session(actorRows, actor, true);
  requireContract(direct === delegated, 'h06-delegated-delivery-version');
  const rootHistory = direct ? comparisonDesktopHistory(rootRows) : rootRows;
  context(rootHistory, root.turnId, root.workspace, direct ? root.turnId : undefined);
  requireContract(
    !hasNativeDesktopInboundDelivery(
      rootRows.map(({ record }) => record),
      root.turnId,
    ),
    'h06-delegated-delivery-root-delegated',
  );
  const user = only(
    rootRows.filter(({ ref }) => same(ref, root.user)),
    'h06-delegated-delivery-user-source',
  );
  const message = object(user.record.payload);
  requireContract(
    user.turn === root.turnId &&
      user.record.type === 'response_item' &&
      message.type === 'message' &&
      message.role === 'user' &&
      (!direct ||
        comparisonDesktopHumanMessage(
          object(message.internal_chat_message_metadata_passthrough),
          root.turnId,
        )) &&
      Array.isArray(message.content) &&
      message.content.length === 1 &&
      object(message.content[0]).type === 'input_text' &&
      typeof object(message.content[0]).text === 'string' &&
      (object(message.content[0]).text as string).trim().length > 0 &&
      !(object(message.content[0]).text as string).startsWith('<skill>') &&
      !(object(message.content[0]).text as string).startsWith('<external_codex_apps_open_page>'),
    'h06-delegated-delivery-user-source',
  );
  const sent = only(
    rootRows.filter(({ record }) => {
      const payload = object(record.payload);
      if (record.type !== 'event_msg' || payload.type !== 'item_completed') return false;
      const item = object(payload.item);
      if (
        item.type !== 'McpToolCall' ||
        item.server !== 'codex_app' ||
        item.tool !== 'send_message_to_thread'
      )
        return false;
      const args = object(item.arguments);
      return typeof args.prompt === 'string' && args.prompt.includes(command.nonce);
    }),
    'h06-delegated-delivery-outbound',
  );
  const sentPayload = object(sent.record.payload),
    call = object(sentPayload.item),
    args = object(call.arguments),
    result = object(call.result);
  identifier(call.id);
  const rootPrefix = rootRows.slice(0, sent.line);
  const latestUser = (direct ? comparisonDesktopRequestRows(rootPrefix) : rootPrefix)
    .filter(({ record }) => {
      const payload = object(record.payload);
      return (
        record.type === 'response_item' && payload.type === 'message' && payload.role === 'user'
      );
    })
    .at(-1);
  const hasHost = direct && Object.hasOwn(args, 'hostId');
  exactFields(args, hasHost ? ['threadId', 'prompt', 'hostId'] : ['threadId', 'prompt']);
  requireContract(
    verifyH06OperatorContinuation(
      (direct ? comparisonDesktopHistory(rootPrefix) : rootPrefix).map(({ record }) => record),
      root.turnId,
      sent.turn,
      root.workspace,
    ) &&
      !rootPrefix.some(
        ({ record, turn }) =>
          turn === sent.turn &&
          record.type === 'event_msg' &&
          ['task_complete', 'task_aborted', 'turn_aborted'].includes(
            String(object(record.payload).type),
          ),
      ) &&
      sent.line > user.line &&
      latestUser === user &&
      sentPayload.thread_id === root.threadId &&
      sentPayload.turn_id === sent.turn &&
      (!direct || sent.turn === root.turnId) &&
      (!hasHost || args.hostId === 'local') &&
      args.threadId === actor.threadId &&
      args.prompt === prompt &&
      call.status === 'completed' &&
      result.isError === false &&
      Array.isArray(result.content) &&
      result.content.length === 1 &&
      object(result.content[0]).type === 'text' &&
      same(JSON.parse(text(object(result.content[0]).text)), { threadId: actor.threadId }),
    'h06-delegated-delivery-outbound',
  );
  const envelope =
    '<codex_delegation>\n  <source_thread_id>' +
    root.threadId +
    '</source_thread_id>\n  <input>' +
    prompt +
    '</input>\n</codex_delegation>';
  const received = only(
    actorRows.filter(({ record }) => {
      const payload = object(record.payload);
      return (
        record.type === 'response_item' &&
        payload.type === 'function_call_output' &&
        payload.namespace === 'codex_app' &&
        payload.name === 'send_message_to_thread' &&
        payload.call_id === undefined &&
        typeof payload.output === 'string' &&
        payload.output.includes(command.nonce)
      );
    }),
    'h06-delegated-delivery-inbound',
  );
  const delivered = object(received.record.payload),
    metadata = object(delivered.internal_chat_message_metadata_passthrough),
    actorTurnId = identifier(metadata.turn_id);
  const deliveryId = identifier(delivered.id);
  requireContract(
    delivered.output === envelope && received.turn === actorTurnId,
    'h06-delegated-delivery-inbound',
  );
  context(
    delegated ? comparisonDesktopHistory(actorRows) : actorRows,
    actorTurnId,
    actor.workspace,
    delegated ? sent.turn : undefined,
  );
  if (delegated) {
    const start = only(
      actorRows.filter(
        ({ record }) =>
          record.type === 'event_msg' &&
          object(record.payload).type === 'task_started' &&
          object(record.payload).turn_id === actorTurnId,
      ),
      'h06-delegated-delivery-attribution',
    );
    const payload = object(start.record.payload),
      attribution = object(payload.turn_attribution);
    requireContract(
      start.line < received.line &&
        actorTurnId !== sent.turn &&
        payload.root_turn_id === sent.turn &&
        attribution.turn_id === actorTurnId &&
        attribution.root_turn_id === sent.turn &&
        attribution.parent_turn_id === sent.turn &&
        attribution.turn_trigger === 'app_tool_send_message' &&
        attribution.initiating_agent_path === null,
      'h06-delegated-delivery-attribution',
    );
  }
  const confirmation = only(
    actorRows.filter(({ record }) => {
      const payload = object(record.payload);
      if (record.type !== 'event_msg' || payload.type !== 'item_completed') return false;
      const item = object(payload.item);
      return item.type === 'FunctionCallOutput' && item.id === deliveryId;
    }),
    'h06-delegated-delivery-confirmation',
  );
  const confirmed = object(confirmation.record.payload),
    copy = object(confirmed.item);
  requireContract(
    (!delegated || confirmation.line > received.line) &&
      confirmed.thread_id === actor.threadId &&
      confirmed.turn_id === actorTurnId &&
      copy.name === delivered.name &&
      copy.namespace === delivered.namespace &&
      copy.output === envelope,
    'h06-delegated-delivery-confirmation',
  );
  return {
    kind: 'h06-delegated-delivery-proof/1',
    input,
    user: user.ref,
    outbound: sent.ref,
    inbound: received.ref,
    confirmation: confirmation.ref,
    actorTurnId,
    authorityIssued: false,
    mayRun: false,
    qualification: false,
  };
}

/** Re-read both native transcripts and reject any changed reference or delivery binding. */
export function verifyH06DelegatedDelivery(value: unknown): H06DelegatedDeliveryProof {
  const proof = object(value);
  const observed = planH06DelegatedDelivery(proof.input);
  requireContract(same(value, observed), 'h06-delegated-delivery-proof-changed');
  return observed;
}
