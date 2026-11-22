import { lstatSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { createPrivateDirectory, safeDirectory } from '../adapters/storage/storeFiles.js';
import type { ChatAnchor } from '../core/currentChat.js';
import type { InputRef } from '../core/localRun.js';
import { privateDirectory, publishFile } from '../src/adapters/artifacts/files.js';
import {
  comparisonDesktopHumanMessage,
  comparisonDesktopHistory,
  comparisonDesktopRequestRows,
  isComparisonDesktopUser,
  isNativeDesktopUser166,
} from '../src/adapters/codex/nativeDesktopUser.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  h06NativeSessionsRoot,
  readH06NativeRequestBinding,
} from './comparisonH06NativeAttemptPlan.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';
import { planH06NativeTemporalServerSetup } from './comparisonH06NativeTemporalPlan.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';
import { verifyH06OperatorContinuation } from './comparisonH06OperatorContinuation.js';
import {
  normalizeH06TemporalReferenceContinuation,
  planH06TemporalReferenceApproval,
  resolveH06TemporalReferenceSource,
  verifyH06TemporalReferenceApproval,
} from './comparisonH06TemporalReferenceApproval.js';

const acceptanceProfile = 'h06-autonomous-recovery/3' as const;
interface AuthorityInput {
  attempt: H04Pin;
  budget: { maxElapsedMs: number; stopReserveMs: number };
}
export type H06TemporalAutonomousInput = AuthorityInput &
  (
    | { kind: 'comparison-h06-temporal-autonomous/3' }
    | { kind: 'comparison-h06-temporal-reference/4'; approvedProposal: H04Pin }
  );
interface Primary {
  transcript: string;
  sourceTurnId: string;
  anchor: ChatAnchor;
  source: InputRef;
  sessionsRoot: string;
  nativePrefix: { bytes: number; sha256: string };
  referenceApproval?: ReturnType<typeof verifyH06TemporalReferenceApproval>;
}
type Setup = ReturnType<typeof planH06NativeTemporalServerSetup>;
type Plan = ReturnType<typeof planH06TemporalAutonomousAuthority>;
type GrantFields = {
  request: Setup['attempt']['request'];
  requestHash: string;
  serverSetupHash: string;
  budget: Setup['attempt']['request']['budget'];
};
interface AuthorityBody {
  kind: 'h06-temporal-autonomous-authority/3';
  acceptanceProfile: typeof acceptanceProfile;
  input: H06TemporalAutonomousInput;
  request: Plan['request'];
  assets: Plan['assets'];
  requestHash: string;
  serverSetupHash: string;
  server: Plan['server'];
  budget: Plan['budget'];
  grant: Primary;
  sourceKey: string;
  reservation: H04Pin;
  identity: { reservation: string[]; evidence: string[]; server: string[] };
  startedAt: number;
  workDeadlineMs: number;
  stopDeadlineMs: number;
  qualification: false;
}
const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
function record(path: string, value: unknown): H04Pin {
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}
function identity(path: string) {
  const stat = lstatSync(safeDirectory(path), { bigint: true });
  return [stat.dev.toString(), stat.ino.toString()];
}
function input(value: unknown): H06TemporalAutonomousInput {
  const row = object(value),
    budget = object(row.budget);
  const reference = row.kind === 'comparison-h06-temporal-reference/4';
  exactFields(
    row,
    reference ? ['kind', 'attempt', 'budget', 'approvedProposal'] : ['kind', 'attempt', 'budget'],
  );
  exactFields(budget, ['maxElapsedMs', 'stopReserveMs']);
  requireContract(
    row.kind === 'comparison-h06-temporal-autonomous/3' || reference,
    'h06-temporal-autonomous-kind',
  );
  const common = {
    attempt: h04Pin(row.attempt),
    budget: {
      maxElapsedMs: budget.maxElapsedMs as number,
      stopReserveMs: budget.stopReserveMs as number,
    },
  };
  return reference
    ? {
        ...common,
        kind: 'comparison-h06-temporal-reference/4',
        approvedProposal: h04Pin(row.approvedProposal),
      }
    : { ...common, kind: 'comparison-h06-temporal-autonomous/3' };
}
function grantText(plan: GrantFields) {
  return canonical({
    kind: 'comparison-h06-temporal-autonomous-grant/3',
    acceptanceProfile,
    variant: 'temporal',
    operationId: plan.request.binding.operationId,
    requestHash: plan.requestHash,
    serverSetupHash: plan.serverSetupHash,
    budget: plan.budget,
  });
}

/** Review one whole-attempt cap; preparation does not consume a source or create either root. */
export function planH06TemporalAutonomousAuthority(value: unknown) {
  const parsed = input(value),
    setup = planH06NativeTemporalServerSetup(read(parsed.attempt), parsed.budget);
  const { request, assets, requestHash } = setup.attempt;
  const reference =
    parsed.kind === 'comparison-h06-temporal-reference/4'
      ? planH06TemporalReferenceApproval(parsed.approvedProposal, request, parsed.budget)
      : undefined;
  const plan = {
    input: parsed,
    acceptanceProfile,
    request,
    assets,
    requestHash,
    serverSetupHash: setup.setupHash,
    server: { expected: setup.expected, budget: setup.budget, root: setup.root },
    budget: request.budget,
  };
  return {
    ...plan,
    ...(reference === undefined ? {} : { reference }),
    expectedGrantText: grantText(plan),
    source: null,
    mayRun: false,
    qualification: false,
  } as const;
}

function nativeSource(
  plan: Pick<Plan, 'request' | 'expectedGrantText'> & {
    reference?: ReturnType<typeof planH06TemporalReferenceApproval>;
  },
  value: unknown,
  historical?: Primary,
) {
  const source = object(value),
    ref = object(source.source);
  exactFields(source, ['transcript', 'turnId', 'source']);
  exactFields(ref, ['locator', 'hash']);
  const transcript = h04Pin({ path: source.transcript, sha256: '0'.repeat(64) }).path,
    sessionsRoot = h06NativeSessionsRoot();
  requireContract(transcript.startsWith(sessionsRoot + sep), 'h06-temporal-autonomous-native-path');
  const current = readH06NativeJournal(transcript);
  const bytes =
    historical === undefined ? current : current.subarray(0, historical.nativePrefix.bytes);
  requireContract(
    historical === undefined ||
      (current.length >= historical.nativePrefix.bytes &&
        digest(bytes) === historical.nativePrefix.sha256),
    'h06-temporal-autonomous-prefix',
  );
  const rows = bytes
    .toString()
    .trimEnd()
    .split('\n')
    .map((line, index) => ({
      record: object(JSON.parse(line)),
      ref: { locator: transcript + '#L' + (index + 1), hash: digest(line + '\n') },
    }));
  const session = rows.filter(({ record }) => record.type === 'session_meta');
  requireContract(session.length === 1, 'h06-temporal-autonomous-native-session');
  const meta = object(session[0]!.record.payload),
    chat = plan.request.chat;
  const comparison = plan.reference === undefined && isComparisonDesktopUser(meta);
  requireContract(
    (isNativeDesktopUser166(meta) || comparison) &&
      meta.id === chat.threadId &&
      meta.session_id === chat.threadId,
    'h06-temporal-autonomous-native-session',
  );
  const history = comparison ? comparisonDesktopHistory(rows) : rows;
  const contexts = history.filter(({ record }) => record.type === 'turn_context'),
    context = object(contexts.at(-1)?.record.payload);
  const anchor: ChatAnchor = {
    thread_id: chat.threadId,
    turn_id: identifier(context.turn_id),
    workspace: chat.workspace,
    host_id: 'local',
  };
  const resolved =
      plan.reference === undefined
        ? undefined
        : resolveH06TemporalReferenceSource(rows, identifier(source.turnId)),
    grantedRef = resolved?.source ?? ref;
  requireContract(
    resolved === undefined ||
      same(ref, historical === undefined ? resolved.latestUserSource : resolved.source),
    'h06-reference-current-source',
  );
  const message = rows.find(({ ref: candidate }) => same(candidate, grantedRef));
  const payload = object(message?.record.payload);
  requireContract(
    message?.record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content) &&
      payload.content.length === 1 &&
      object(payload.content[0]).type === 'input_text' &&
      (plan.reference !== undefined ||
        [plan.expectedGrantText, plan.expectedGrantText + '\n'].includes(
          String(object(payload.content[0]).text),
        )),
    'h06-temporal-autonomous-native-body',
  );
  if (comparison) {
    const start = rows
      .slice(0, rows.indexOf(message))
      .reverse()
      .find(
        ({ record }) =>
          record.type === 'event_msg' && object(record.payload).type === 'task_started',
      );
    requireContract(
      meta.cwd === chat.workspace &&
        context.root_turn_id === anchor.turn_id &&
        source.turnId === anchor.turn_id &&
        object(start?.record.payload).turn_id === source.turnId &&
        comparisonDesktopHumanMessage(
          object(payload.internal_chat_message_metadata_passthrough),
          anchor.turn_id,
        ),
      'h06-temporal-autonomous-direct-origin',
    );
  }
  const referenceApproval =
    plan.reference === undefined
      ? undefined
      : verifyH06TemporalReferenceApproval(
          plan.reference,
          rows,
          { locator: String(grantedRef.locator), hash: String(grantedRef.hash) },
          identifier(source.turnId),
        );
  requireContract(
    verifyH06OperatorContinuation(
      plan.reference === undefined
        ? history.map(({ record }) => record)
        : normalizeH06TemporalReferenceContinuation(rows.map(({ record }) => record)),
      identifier(source.turnId),
      anchor.turn_id,
      chat.workspace,
    ),
    'h06-temporal-autonomous-native-continuation',
  );
  const primary: Primary = {
    transcript,
    sourceTurnId: identifier(source.turnId),
    anchor,
    source: { locator: String(grantedRef.locator), hash: String(grantedRef.hash) },
    sessionsRoot,
    nativePrefix: { bytes: bytes.length, sha256: digest(bytes) },
    ...(referenceApproval === undefined ? {} : { referenceApproval }),
  };
  if (historical !== undefined)
    requireContract(same(primary, historical), 'h06-temporal-autonomous-native-source');
  return { primary, rows: comparison ? comparisonDesktopRequestRows(rows) : rows };
}
/** Check the real current source before full validation, without reserving it or opening clocks. */
export async function observeH06TemporalAutonomousSource(plan: Plan, value: unknown) {
  const { primary, rows } = nativeSource(plan, value);
  const observedSource = primary.referenceApproval?.latestUserSource ?? primary.source;
  const users = rows.filter(
    ({ record }) =>
      record.type === 'response_item' &&
      object(record.payload).type === 'message' &&
      object(record.payload).role === 'user',
  );
  requireContract(
    process.env.CODEX_THREAD_ID === plan.request.chat.threadId &&
      same(users.at(-1)?.ref, observedSource) &&
      !rows.some(
        ({ record }) =>
          record.type === 'event_msg' &&
          object(record.payload).turn_id === primary.anchor.turn_id &&
          ['task_complete', 'task_aborted', 'turn_aborted'].includes(
            String(object(record.payload).type),
          ),
      ),
    'h06-temporal-autonomous-current-source',
  );
  const host = new FileCurrentChatHost(
    plan.request.chat.workspace,
    primary.transcript,
    primary.anchor,
    null,
    false,
    plan.reference === undefined,
  );
  await host.observe();
  await host.message(observedSource, identifier(object(value).turnId));
  return primary;
}
function sourceKey(primary: Primary) {
  return digest(
    canonical({
      sessionsRoot: primary.sessionsRoot,
      thread: primary.anchor.thread_id,
      source: primary.source,
    }),
  );
}
function reservationRoot(key: string) {
  return join(
    dirname(h06NativeSessionsRoot()),
    'agent-workflow-evidence',
    'h06-temporal-autonomous-authority',
    key,
  );
}
function nativeBody(claim: AuthorityBody, receipt: H04Pin) {
  const { request, assets, requestHash, startedAt, workDeadlineMs, stopDeadlineMs, grant } = claim;
  const { nativePrefix: _prefix, referenceApproval: _reference, ...primary } = grant;
  return {
    kind: 'h06-native-attempt-claim',
    request,
    assets,
    requestHash,
    grant: { ...primary, admission: { kind: 'temporal-autonomous/3', authority: receipt } },
    startedAt,
    workDeadlineMs,
    stopDeadlineMs,
  };
}

/** Reserve the primary source once before server setup; every child inherits these clocks. */
export async function consumeH06TemporalAutonomousAuthority(
  value: unknown,
  source: unknown,
  enclosingStartedAtMs?: number,
  signal?: AbortSignal,
) {
  const first = planH06TemporalAutonomousAuthority(value);
  await observeH06TemporalAutonomousSource(first, source);
  const plan = planH06TemporalAutonomousAuthority(value),
    grant = await observeH06TemporalAutonomousSource(plan, source);
  requireContract(
    plan.requestHash === first.requestHash && plan.serverSetupHash === first.serverSetupHash,
    'h06-temporal-autonomous-changed',
  );
  const key = sourceKey(grant),
    root = reservationRoot(key),
    path = join(plan.request.evidenceRoot, 'temporal-autonomous-authority.json');
  for (const boundary of [
    plan.request.evidenceRoot,
    plan.server.root,
    plan.request.chat.workspace,
    plan.request.binding.workspaceRoot,
  ])
    requireContract(
      boundary !== root && !boundary.startsWith(root + sep) && !root.startsWith(boundary + sep),
      'h06-temporal-autonomous-reservation-path',
    );
  const now = Date.now(),
    startedAt = enclosingStartedAtMs ?? now,
    stopDeadlineMs = startedAt + plan.budget.maxElapsedMs,
    workDeadlineMs = stopDeadlineMs - plan.budget.reserveMs;
  requireContract(
    Number.isSafeInteger(startedAt) &&
      startedAt > 0 &&
      startedAt <= now &&
      now < workDeadlineMs &&
      Number.isSafeInteger(stopDeadlineMs),
    'h06-temporal-autonomous-clock',
  );
  signal?.throwIfAborted();
  privateDirectory(dirname(root));
  createPrivateDirectory(root);
  const reservation = record(join(root, 'reservation.json'), {
    kind: 'h06-temporal-autonomous-source-reservation/3',
    sourceKey: key,
    requestHash: plan.requestHash,
    serverSetupHash: plan.serverSetupHash,
    authorityPath: path,
  });
  createPrivateDirectory(plan.request.evidenceRoot);
  createPrivateDirectory(plan.server.root);
  const claim: AuthorityBody = {
    kind: 'h06-temporal-autonomous-authority/3',
    acceptanceProfile,
    input: plan.input,
    request: plan.request,
    assets: plan.assets,
    requestHash: plan.requestHash,
    serverSetupHash: plan.serverSetupHash,
    server: plan.server,
    budget: plan.budget,
    grant,
    sourceKey: key,
    reservation,
    identity: {
      reservation: identity(root),
      evidence: identity(plan.request.evidenceRoot),
      server: identity(plan.server.root),
    },
    startedAt,
    workDeadlineMs,
    stopDeadlineMs,
    qualification: false,
  };
  const receipt = record(path, claim);
  record(join(root, 'issued.json'), {
    kind: 'h06-temporal-autonomous-issued/3',
    reservation,
    authority: receipt,
  });
  openH06NativeTurnLedger(join(plan.request.evidenceRoot, 'turns'), {
    mode: 'create',
    operationId: plan.request.binding.operationId,
    maxManagedStarts: plan.budget.maxManagedStarts,
  });
  record(join(plan.request.evidenceRoot, 'attempt-claim.json'), nativeBody(claim, receipt));
  return readH06TemporalAutonomousAuthority(receipt);
}

/** Historical reopening validates the original source and reservation; it never starts a new budget. */
export function readH06TemporalAutonomousAuthority(value: H04Pin) {
  const receipt = h04Pin(value),
    row = read(receipt);
  exactFields(row, [
    'kind',
    'acceptanceProfile',
    'input',
    'request',
    'assets',
    'requestHash',
    'serverSetupHash',
    'server',
    'budget',
    'grant',
    'sourceKey',
    'reservation',
    'identity',
    'startedAt',
    'workDeadlineMs',
    'stopDeadlineMs',
    'qualification',
  ]);
  const claim = row as unknown as AuthorityBody,
    parsed = input(claim.input),
    request = readH06NativeRequestBinding(read(parsed.attempt)),
    assets = h06Assets();
  requireContract(
    claim.kind === 'h06-temporal-autonomous-authority/3' &&
      claim.acceptanceProfile === acceptanceProfile &&
      claim.qualification === false &&
      request.binding.variant === 'temporal' &&
      same(request, claim.request) &&
      same(assets, claim.assets) &&
      claim.requestHash === digest(canonical({ request, assets })) &&
      same(claim.budget, request.budget),
    'h06-temporal-autonomous-binding',
  );
  const bootstrap = read(request.bootstrap),
    server = object(bootstrap.server),
    expected = {
      requestHash: claim.requestHash,
      binary: request.server,
      address: bootstrap.address,
      httpPort: server.httpPort,
      metricsPort: server.metricsPort,
      sqlitePath: server.sqlitePath,
    };
  requireContract(
    same(claim.server.budget, parsed.budget) &&
      same(claim.server.expected, expected) &&
      claim.server.root === request.evidenceRoot + '-server' &&
      server.sqlitePath === join(claim.server.root, 'temporal.sqlite') &&
      claim.serverSetupHash === digest(canonical({ expected, budget: parsed.budget })),
    'h06-temporal-autonomous-server',
  );
  const grant = claim.grant;
  const reference =
    parsed.kind === 'comparison-h06-temporal-reference/4'
      ? planH06TemporalReferenceApproval(parsed.approvedProposal, request, parsed.budget)
      : undefined;
  nativeSource(
    {
      request,
      expectedGrantText: grantText(claim),
      ...(reference === undefined ? {} : { reference }),
    },
    { transcript: grant.transcript, turnId: grant.sourceTurnId, source: grant.source },
    grant,
  );
  const key = sourceKey(grant),
    root = reservationRoot(key),
    reservation = read(claim.reservation),
    issued = read({
      path: join(root, 'issued.json'),
      sha256: digest(h01RawFile(join(root, 'issued.json'))),
    });
  requireContract(
    claim.sourceKey === key &&
      receipt.path === join(request.evidenceRoot, 'temporal-autonomous-authority.json') &&
      claim.reservation.path === join(root, 'reservation.json') &&
      same(reservation, {
        kind: 'h06-temporal-autonomous-source-reservation/3',
        sourceKey: key,
        requestHash: claim.requestHash,
        serverSetupHash: claim.serverSetupHash,
        authorityPath: receipt.path,
      }) &&
      same(issued, {
        kind: 'h06-temporal-autonomous-issued/3',
        reservation: claim.reservation,
        authority: receipt,
      }) &&
      same(claim.identity, {
        reservation: identity(root),
        evidence: identity(request.evidenceRoot),
        server: identity(claim.server.root),
      }),
    'h06-temporal-autonomous-reservation',
  );
  requireContract(
    Number.isSafeInteger(claim.startedAt) &&
      claim.startedAt > 0 &&
      claim.startedAt <= Date.now() &&
      Number.isSafeInteger(claim.stopDeadlineMs) &&
      claim.stopDeadlineMs === claim.startedAt + request.budget.maxElapsedMs &&
      claim.workDeadlineMs === claim.stopDeadlineMs - request.budget.reserveMs,
    'h06-temporal-autonomous-clock',
  );
  const nativePath = join(request.evidenceRoot, 'attempt-claim.json'),
    nativeClaim = { path: nativePath, sha256: digest(h01RawFile(nativePath)) };
  requireContract(
    same(read(nativeClaim), nativeBody(claim, receipt)),
    'h06-temporal-autonomous-native-claim',
  );
  return { ...claim, receipt, nativeClaim };
}

/** Return only the already-issued native claim, after validating the whole parent admission. */
export function openH06TemporalAutonomousNativeClaim(value: H04Pin) {
  const authority = readH06TemporalAutonomousAuthority(value);
  return { ...nativeBody(authority, authority.receipt), receipt: authority.nativeClaim };
}
