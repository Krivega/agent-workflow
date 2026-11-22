import { join, sep } from 'node:path';
import process from 'node:process';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { createPrivateDirectory, safeDirectory } from '../adapters/storage/storeFiles.js';
import type { ChatAnchor } from '../core/currentChat.js';
import type { InputRef } from '../core/localRun.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  h06NativeSessionsRoot,
  planH06NativeAttempt,
  readH06NativeRequest,
} from './comparisonH06NativeAttemptPlan.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';
import { readH06TemporalAutonomousAuthority } from './comparisonH06TemporalAutonomousAuthority.js';
export {
  h06NativeSessionsRoot,
  planH06NativeAttempt,
  readH06NativeRequest,
  readH06NativeRequestBinding,
  readH06NativeRequestSchema,
} from './comparisonH06NativeAttemptPlan.js';
function absolutePath(value: unknown) {
  return h04Pin({ path: value, sha256: '0'.repeat(64) }).path;
}
function positive(value: unknown): number {
  requireContract(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    'h06-native-attempt-budget',
  );
  return value;
}

function autonomousAdmission(grant: Record<string, unknown>, pin: H04Pin) {
  if (grant.admission === undefined) return;
  const admission = object(grant.admission);
  exactFields(admission, ['kind', 'authority']);
  requireContract(admission.kind === 'temporal-autonomous/3', 'h06-native-attempt-admission');
  const authority = h04Pin(admission.authority);
  const parent = readH06TemporalAutonomousAuthority(authority);
  requireContract(
    parent.nativeClaim.path === pin.path && parent.nativeClaim.sha256 === pin.sha256,
    'h06-native-attempt-admission',
  );
  return { kind: 'temporal-autonomous/3', authority } as const;
}

function h06NativePrimaryGrant(
  plan: Pick<ReturnType<typeof planH06NativeAttempt>, 'request' | 'expectedGrantText'>,
  value: unknown,
  current: boolean,
) {
  const authority = object(value);
  exactFields(authority, ['transcript', 'turnId', 'source']);
  const transcript = absolutePath(authority.transcript);
  const sourceValue = object(authority.source);
  exactFields(sourceValue, ['locator', 'hash']);
  const source: InputRef = { locator: text(sourceValue.locator), hash: text(sourceValue.hash) };
  const match = /^(.*)#L([1-9]\d*)$/u.exec(source.locator);
  const sessions = h06NativeSessionsRoot();
  const { chat } = plan.request;
  const anchor: ChatAnchor = {
    thread_id: chat.threadId,
    turn_id: identifier(authority.turnId),
    workspace: chat.workspace,
    host_id: 'local',
  };
  requireContract(
    transcript.startsWith(sessions + sep) &&
      match?.[1] === transcript &&
      (!current || process.env.CODEX_THREAD_ID === anchor.thread_id),
    'h06-native-attempt-authority-source',
  );
  const bytes = h01RawFile(transcript).toString('utf8');
  requireContract(bytes.endsWith('\n'), 'h06-native-attempt-authority-partial');
  const line = bytes.slice(0, -1).split('\n')[Number(match[2]) - 1];
  requireContract(
    line !== undefined && digest(line + '\n') === source.hash,
    'h06-native-attempt-authority-line',
  );
  const record = object(JSON.parse(line));
  const payload = object(record.payload);
  requireContract(
    record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content) &&
      payload.content.length === 1,
    'h06-native-attempt-authority-body',
  );
  const body = object(payload.content[0]);
  requireContract(
    body.type === 'input_text' &&
      (body.text === plan.expectedGrantText || body.text === plan.expectedGrantText + '\n'),
    'h06-native-attempt-authority-body',
  );
  return { transcript, anchor, source, sessionsRoot: sessions };
}

export async function observeH06NativePrimaryGrant(
  plan: Pick<ReturnType<typeof planH06NativeAttempt>, 'request' | 'expectedGrantText'>,
  value: unknown,
) {
  const grant = h06NativePrimaryGrant(plan, value, true);
  await new FileCurrentChatHost(
    plan.request.chat.workspace,
    grant.transcript,
    grant.anchor,
  ).message(grant.source, grant.anchor.turn_id);
  return grant;
}

/** Read-only evidence for a consumed claim; never authorizes another attempt or process. */
export async function observeH06NativePrimaryGrantHistory(
  plan: Pick<ReturnType<typeof planH06NativeAttempt>, 'request' | 'expectedGrantText'>,
  value: unknown,
) {
  const grant = h06NativePrimaryGrant(plan, value, false);
  await new FileCurrentChatHost(
    plan.request.chat.workspace,
    grant.transcript,
    grant.anchor,
  ).message(grant.source);
  return grant;
}

/** Consume one exact grant before bootstrap. A claimed root cannot be retried after partial failure. */
export async function beginH06NativeAttempt(value: unknown, authority: unknown) {
  const plan = planH06NativeAttempt(value);
  const grant = await observeH06NativePrimaryGrant(plan, authority);
  const current = planH06NativeAttempt(value);
  requireContract(current.requestHash === plan.requestHash, 'h06-native-attempt-request-changed');
  const { request, assets, requestHash } = current;
  await new FileCurrentChatHost(request.chat.workspace, grant.transcript, grant.anchor).message(
    grant.source,
    grant.anchor.turn_id,
  );
  const startedAt = Date.now();
  const stopDeadlineMs = startedAt + request.budget.maxElapsedMs;
  const workDeadlineMs = stopDeadlineMs - request.budget.reserveMs;
  const claim = {
    kind: 'h06-native-attempt-claim',
    request,
    assets,
    requestHash,
    grant,
    startedAt,
    workDeadlineMs,
    stopDeadlineMs,
  };
  claimH06NativeAttemptDirectory(request.evidenceRoot);
  if (request.binding.variant === 'temporal')
    openH06NativeTurnLedger(join(request.evidenceRoot, 'turns'), {
      mode: 'create',
      operationId: request.binding.operationId,
      maxManagedStarts: request.budget.maxManagedStarts,
    });
  const path = join(request.evidenceRoot, 'attempt-claim.json');
  const bytes = Buffer.from(canonical(claim) + '\n');
  publishFile(path, bytes);
  return { ...claim, receipt: { path, sha256: digest(bytes) } satisfies H04Pin };
}

/** Atomic, one-shot root shared by independently validated exact native grant kinds. */
export function claimH06NativeAttemptDirectory(evidenceRoot: string): void {
  createPrivateDirectory(evidenceRoot);
}

/** Read a trusted claim for an authorized continuation without reusing the original chat turn. */
export function readH06NativeAttemptForReopen(receipt: H04Pin) {
  const pin = h04Pin(receipt);
  const claim = object(JSON.parse(readH04Pin(pin).toString()));
  const request = readH06NativeRequest(claim.request);
  const assets = h06Assets();
  const requestHash = digest(canonical({ request, assets }));
  requireContract(
    claim.kind === 'h06-native-attempt-claim' &&
      pin.path === join(safeDirectory(request.evidenceRoot), 'attempt-claim.json') &&
      canonical(claim.assets) === canonical(assets) &&
      claim.requestHash === requestHash,
    'h06-native-attempt-reopen-binding',
  );
  const startedAt = positive(claim.startedAt);
  const stopDeadlineMs = startedAt + request.budget.maxElapsedMs;
  const workDeadlineMs = stopDeadlineMs - request.budget.reserveMs;
  requireContract(
    Number.isSafeInteger(stopDeadlineMs) &&
      startedAt <= Date.now() &&
      claim.stopDeadlineMs === stopDeadlineMs &&
      claim.workDeadlineMs === workDeadlineMs,
    'h06-native-attempt-reopen-clock',
  );
  const grant = object(claim.grant);
  const admission = autonomousAdmission(grant, pin);
  const anchor = object(grant.anchor);
  const sessionsRoot = safeDirectory(absolutePath(grant.sessionsRoot));
  requireContract(
    anchor.thread_id === request.chat.threadId &&
      anchor.workspace === request.chat.workspace &&
      anchor.host_id === 'local' &&
      absolutePath(grant.transcript).startsWith(join(sessionsRoot, '/')),
    'h06-native-attempt-reopen-issuer',
  );
  return {
    request,
    receipt: pin,
    requestHash,
    grant: { sessionsRoot, ...(admission === undefined ? {} : { admission }) },
    workDeadlineMs,
    stopDeadlineMs,
  };
}

/** Reopen the same admitted start budget for initial, warm and cold Temporal transport. */
export function openH06NativeAttemptTurnLedger(
  receipt: H04Pin,
): ReturnType<typeof openH06NativeTurnLedger<undefined>> {
  const path = h04Pin(receipt).path;
  const claim = object(JSON.parse(readH04Pin(receipt).toString()));
  const request = object(claim.request);
  const binding = object(request.binding);
  const budget = object(request.budget);
  const evidenceRoot = safeDirectory(absolutePath(request.evidenceRoot));
  requireContract(
    claim.kind === 'h06-native-attempt-claim' &&
      request.kind === 'comparison-h06-native/2' &&
      binding.variant === 'temporal' &&
      path === join(evidenceRoot, 'attempt-claim.json') &&
      claim.requestHash === digest(canonical({ request, assets: claim.assets })),
    'h06-native-attempt-ledger-binding',
  );
  if (claim.grant !== undefined) autonomousAdmission(object(claim.grant), receipt);
  return openH06NativeTurnLedger(join(evidenceRoot, 'turns'), {
    mode: 'reopen',
    operationId: identifier(binding.operationId),
    maxManagedStarts: positive(budget.maxManagedStarts),
  });
}
