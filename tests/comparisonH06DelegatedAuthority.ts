import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual as same } from 'node:util';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { createPrivateDirectory, safeDirectory } from '../adapters/storage/storeFiles.js';
import type { InputRef } from '../core/localRun.js';
import { privateDirectory, publishFile } from '../src/adapters/artifacts/files.js';
import {
  comparisonDesktopHumanMessage,
  comparisonDesktopHistory,
  comparisonDesktopRequestRows,
  isComparisonDesktopUser,
  hasNativeDesktopInboundDelivery,
  isNativeDesktopUser166,
  nativeDesktopCommandTurn,
} from '../src/adapters/codex/nativeDesktopUser.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  h06NativeSessionsRoot,
  readH06NativeRequestBinding,
  readH06NativeRequestSchema,
} from './comparisonH06NativeAttempt.js';
import { planH06NativeLegacyOperator } from './comparisonH06NativeLegacyOperator.js';
import { verifyH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import { verifyH06OperatorContinuation } from './comparisonH06OperatorContinuation.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';

type LegacyPlan = ReturnType<typeof planH06NativeLegacyOperator>;

export const h06DelegatedStages = [
  'load',
  'warm-pause',
  'warm-resume',
  'cold-pause',
  'cold-resume',
  'completion',
] as const;
export type H06DelegatedStage = (typeof h06DelegatedStages)[number];

export function h06DelegatedPhaseAction(stage: H06DelegatedStage) {
  if (stage === 'load') return 'LOAD';
  if (stage === 'completion') return 'COMPLETE';
  return stage.endsWith('pause') ? 'PAUSE' : 'RESUME';
}

export interface H06DelegatedInput {
  kind: 'comparison-h06-delegated-legacy/1';
  attempt: H04Pin;
  source: { transcript: string; turnId: string; source: InputRef };
  budgetSource: {
    attempt: H04Pin;
    source: H06DelegatedInput['source'];
  };
  normalization: {
    kind: 'root-operator-normalization/1';
    decision: 'autonomous-legacy-warm-cold-completion';
  };
}

export interface H06DelegatedPhase {
  stage: H06DelegatedStage;
  nonce: string;
  rootThread: string;
  actorThread: string;
  requestHash: string;
  generation: number;
  storeRevision: number;
  controlRevision: number;
  requirementsRevision: number;
  predecessor: H04Pin | null;
}

export interface H06DelegatedOutcome {
  kind: 'h06-delegated-phase-outcome/1';
  claim: H04Pin;
  intent: H04Pin;
  stage: H06DelegatedStage;
  status: 'confirmed';
  delivery: H04Pin;
  result: H04Pin;
}

interface PhaseRecord {
  phase: H06DelegatedPhase;
  intent: H04Pin;
  outcome: H04Pin | null;
}

export interface SourceProof {
  transcript: string;
  turnId: string;
  source: InputRef;
  text: string;
  session: InputRef;
  context: InputRef;
}

export interface DelegatedClaim {
  kind: 'h06-delegated-legacy-claim/1';
  input: H06DelegatedInput;
  request: LegacyPlan['request'];
  assets: LegacyPlan['assets'];
  requestHash: string;
  actorId: string;
  generation: number;
  sourceKey: string;
  source: SourceProof;
  budget: {
    mode: 'autonomous-grant' | 'legacy-transfer';
    request: LegacyPlan['request'];
    requestHash: string;
    source: SourceProof;
    bridge: H04Pin;
    identity: string[];
  };
  reservation: H04Pin;
  identity: { reservation: string[]; evidence: string[] };
  startedAt: number;
  workDeadlineMs: number;
  stopDeadlineMs: number;
  qualification: false;
}

function read(pin: H04Pin) {
  return object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
}

function save(path: string, value: unknown): H04Pin {
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

function identity(path: string): string[] {
  const current = lstatSync(safeDirectory(path), { bigint: true });
  return [current.dev.toString(), current.ino.toString()];
}

function integer(value: unknown, minimum = 0): number {
  requireContract(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum,
    'h06-delegated-integer',
  );
  return value;
}

function parseSource(value: unknown): H06DelegatedInput['source'] {
  const source = object(value),
    reference = object(source.source);
  exactFields(source, ['transcript', 'turnId', 'source']);
  exactFields(reference, ['locator', 'hash']);
  const transcript = h04Pin({ path: source.transcript, sha256: '0'.repeat(64) }).path;
  requireContract(
    typeof reference.locator === 'string' &&
      typeof reference.hash === 'string' &&
      /^[a-f0-9]{64}$/u.test(reference.hash),
    'h06-delegated-source',
  );
  return {
    transcript,
    turnId: identifier(source.turnId),
    source: { locator: reference.locator, hash: reference.hash },
  };
}

function parseInput(value: unknown): H06DelegatedInput {
  const input = object(value);
  exactFields(input, ['kind', 'attempt', 'source', 'budgetSource', 'normalization']);
  const normalization = object(input.normalization),
    budgetSource = object(input.budgetSource);
  exactFields(normalization, ['kind', 'decision']);
  exactFields(budgetSource, ['attempt', 'source']);
  requireContract(
    input.kind === 'comparison-h06-delegated-legacy/1' &&
      normalization.kind === 'root-operator-normalization/1' &&
      normalization.decision === 'autonomous-legacy-warm-cold-completion',
    'h06-delegated-kind',
  );
  return {
    kind: 'comparison-h06-delegated-legacy/1',
    attempt: h04Pin(input.attempt),
    source: parseSource(input.source),
    budgetSource: {
      attempt: h04Pin(budgetSource.attempt),
      source: parseSource(budgetSource.source),
    },
    normalization: {
      kind: 'root-operator-normalization/1',
      decision: 'autonomous-legacy-warm-cold-completion',
    },
  };
}

function nativeSource(
  input: H06DelegatedInput,
  request: LegacyPlan['request'],
  current: boolean,
  source = input.source,
) {
  const sessions = h06NativeSessionsRoot();
  requireContract(source.transcript.startsWith(sessions + sep), 'h06-delegated-source-path');
  const matches: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('-' + request.chat.threadId + '.jsonl'))
        matches.push(path);
    }
  };
  visit(sessions);
  requireContract(
    matches.length === 1 && matches[0] === source.transcript,
    'h06-delegated-source-path',
  );
  const bytes = readH06NativeJournal(source.transcript).toString();
  requireContract(bytes.endsWith('\n'), 'h06-delegated-source-partial');
  let turn = '';
  const records = bytes
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      const record = object(JSON.parse(line)),
        payload = object(record.payload);
      if (record.type === 'event_msg' && payload.type === 'task_started')
        turn = identifier(payload.turn_id);
      return {
        record,
        payload,
        turn,
        ref: { locator: source.transcript + '#L' + (index + 1), hash: digest(line + '\n') },
      };
    });
  const sessionsFound = records.filter(({ record }) => record.type === 'session_meta');
  requireContract(sessionsFound.length === 1, 'h06-delegated-session');
  const session = sessionsFound[0]!;
  const comparison = isComparisonDesktopUser(session.payload);
  requireContract(
    (isNativeDesktopUser166(session.payload) || (comparison && directGrant(input))) &&
      session.payload.id === request.chat.threadId &&
      session.payload.session_id === request.chat.threadId,
    'h06-delegated-session',
  );
  const history = comparison ? comparisonDesktopHistory(records) : records;
  const contexts = history.filter(({ record }) => record.type === 'turn_context');
  requireContract(
    nativeDesktopCommandTurn(
      contexts.map(({ payload }) => payload),
      source.turnId,
      request.chat.workspace,
    ) &&
      !hasNativeDesktopInboundDelivery(
        records.map(({ record }) => record),
        source.turnId,
      ),
    'h06-delegated-source-scope',
  );
  const context = contexts.find(({ payload }) => payload.turn_id === source.turnId)!;
  requireContract(
    context.payload.approval_policy === 'never' &&
      object(context.payload.sandbox_policy).type === 'danger-full-access' &&
      object(context.payload.permission_profile).type === 'disabled',
    'h06-delegated-source-profile',
  );
  const user = records.find(({ ref }) => ref.locator === source.source.locator);
  requireContract(
    user !== undefined &&
      user.ref.hash === source.source.hash &&
      user.turn === source.turnId &&
      user.record.type === 'response_item' &&
      user.payload.type === 'message' &&
      user.payload.role === 'user' &&
      Array.isArray(user.payload.content) &&
      user.payload.content.length === 1,
    'h06-delegated-source',
  );
  if (comparison)
    requireContract(
      session.payload.cwd === request.chat.workspace &&
        context.payload.root_turn_id === source.turnId &&
        (!current || contexts.at(-1) === context) &&
        comparisonDesktopHumanMessage(
          object(user.payload.internal_chat_message_metadata_passthrough),
          source.turnId,
        ),
      'h06-delegated-direct-origin',
    );
  const body = object(user.payload.content[0]);
  requireContract(
    body.type === 'input_text' &&
      typeof body.text === 'string' &&
      body.text.trim().length > 0 &&
      body.text.length <= 65536 &&
      !body.text.startsWith('<skill>') &&
      !body.text.startsWith('<external_codex_apps_open_page>'),
    'h06-delegated-source-body',
  );
  if (current) {
    const users = (comparison ? comparisonDesktopRequestRows(records) : records).filter(
      ({ record, payload }) =>
        record.type === 'response_item' && payload.type === 'message' && payload.role === 'user',
    );
    const targetTurn = identifier(contexts.at(-1)?.payload.turn_id);
    requireContract(
      verifyH06OperatorContinuation(
        history.map(({ record }) => record),
        source.turnId,
        targetTurn,
        request.chat.workspace,
      ) &&
        users.at(-1) === user &&
        !records.some(
          ({ record, payload }) =>
            record.type === 'event_msg' &&
            payload.turn_id === targetTurn &&
            ['task_complete', 'task_aborted', 'turn_aborted'].includes(String(payload.type)),
        ),
      'h06-delegated-source-stale',
    );
  }
  return {
    ...source,
    text: body.text,
    session: session.ref,
    context: context.ref,
  } satisfies SourceProof;
}

function sourceKey(input: H06DelegatedInput, rootThread: string) {
  return digest(canonical({ rootThread, ...input.budgetSource.source }));
}

function directGrant(input: H06DelegatedInput) {
  return (
    same(input.attempt, input.budgetSource.attempt) && same(input.source, input.budgetSource.source)
  );
}

function budgetBinding(
  input: H06DelegatedInput,
  request: LegacyPlan['request'],
  assets: LegacyPlan['assets'],
  current: SourceProof,
) {
  const previous = readH06NativeRequestSchema(read(input.budgetSource.attempt));
  const requestHash = digest(canonical({ request: previous, assets }));
  const source = nativeSource(input, previous, false, input.budgetSource.source);
  const direct = directGrant(input);
  requireContract(
    source.text.trim() ===
      (direct
        ? autonomousGrantText(previous, requestHash)
        : canonical({
            kind: 'comparison-h06-native-grant/2',
            operationId: previous.binding.operationId,
            variant: previous.binding.variant,
            requestHash,
            budget: previous.budget,
          })),
    'h06-delegated-budget-grant',
  );
  requireContract(
    same(previous.binding, request.binding) &&
      same(previous.chat, request.chat) &&
      same(previous.bootstrap, request.bootstrap) &&
      same(previous.appServer, request.appServer) &&
      same(previous.server, request.server) &&
      same(previous.budget, request.budget) &&
      same(previous.stimulus, request.stimulus),
    'h06-delegated-budget-scope',
  );
  requireContract(
    direct ||
      (source.transcript === current.transcript &&
        source.turnId !== current.turnId &&
        Number(source.source.locator.split('#L').at(-1)) <
          Number(current.source.locator.split('#L').at(-1))),
    'h06-delegated-budget-order',
  );
  return {
    request: previous,
    requestHash,
    source,
    mode: direct ? ('autonomous-grant' as const) : ('legacy-transfer' as const),
  };
}

function autonomousGrantText(request: LegacyPlan['request'], requestHash: string): string {
  return canonical({
    acceptanceProfile: 'h06-autonomous-recovery/3',
    kind: 'comparison-h06-autonomous-grant/3',
    operationId: request.binding.operationId,
    variant: 'legacy',
    requestHash,
    budget: request.budget,
  });
}

function overlaps(a: string, b: string) {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

function reservationRoot(key: string) {
  return join(
    dirname(h06NativeSessionsRoot()),
    'agent-workflow-evidence',
    'h06-delegated-authority',
    key,
  );
}

/** Prepare one reviewable autonomous grant without consuming or inventing a human source. */
export function planH06AutonomousGrant(attempt: H04Pin) {
  const plan = planH06NativeLegacyOperator(JSON.parse(readH04Pin(h04Pin(attempt)).toString()));
  const budget = plan.request.budget;
  requireContract(
    budget.maxElapsedMs <= 1500000 &&
      budget.reserveMs >= 120000 &&
      budget.maxManagedStarts <= 24 &&
      budget.maxInputUncached <= 500000 &&
      budget.maxOutput <= 30000,
    'h06-delegated-cap',
  );
  return { ...plan, expectedGrantText: autonomousGrantText(plan.request, plan.requestHash) };
}

/** Bind autonomous acceptance to either a new exact grant or an explicit legacy-budget transfer. */
export function planH06DelegatedAuthority(value: unknown) {
  const input = parseInput(value);
  const plan = planH06AutonomousGrant(input.attempt);
  const bootstrap = read(plan.request.bootstrap);
  const actorId = identifier(bootstrap.actorId),
    generation = integer(bootstrap.generation, 1);
  const source = nativeSource(input, plan.request, true);
  const budgetSource = budgetBinding(input, plan.request, plan.assets, source);
  const key = sourceKey(input, plan.request.chat.threadId);
  const capRoot = reservationRoot(key);
  requireContract(
    [
      plan.request.chat.workspace,
      plan.request.binding.workspaceRoot,
      plan.request.evidenceRoot,
      budgetSource.request.evidenceRoot,
    ].every(
      (root) =>
        root !== capRoot && !root.startsWith(capRoot + sep) && !capRoot.startsWith(root + sep),
    ),
    'h06-delegated-reservation-path',
  );
  requireContract(
    (budgetSource.mode === 'autonomous-grant' ||
      !overlaps(plan.request.evidenceRoot, budgetSource.request.evidenceRoot)) &&
      !overlaps(budgetSource.request.evidenceRoot, input.attempt.path) &&
      lstatSync(budgetSource.request.evidenceRoot, { throwIfNoEntry: false }) === undefined,
    'h06-delegated-budget-consumed',
  );
  return {
    input,
    request: plan.request,
    assets: plan.assets,
    requestHash: plan.requestHash,
    actorId,
    generation,
    source,
    budgetSource,
    sourceKey: key,
    mayRun: false,
    qualification: false,
  } as const;
}

/** Consume the original budget once, bridging its old evidence root before any bootstrap. */
export function consumeH06DelegatedAuthority(value: unknown, enclosingStartedAtMs?: number) {
  const plan = planH06DelegatedAuthority(value);
  requireContract(
    process.env.CODEX_THREAD_ID === plan.request.chat.threadId,
    'h06-delegated-root-only',
  );
  const now = Date.now();
  const startedAt = integer(enclosingStartedAtMs ?? now, 1);
  const stopDeadlineMs = startedAt + plan.request.budget.maxElapsedMs;
  const workDeadlineMs = stopDeadlineMs - plan.request.budget.reserveMs;
  requireContract(
    startedAt <= now && now < workDeadlineMs && Number.isSafeInteger(stopDeadlineMs),
    'h06-delegated-clock',
  );
  const capRoot = reservationRoot(plan.sourceKey);
  privateDirectory(dirname(capRoot));
  createPrivateDirectory(capRoot);
  const claimPath = join(plan.request.evidenceRoot, 'delegated-claim.json');
  const reservation = save(join(capRoot, 'reservation.json'), {
    kind: 'h06-delegated-source-reservation/1',
    inputHash: digest(canonical(plan.input)),
    requestHash: plan.requestHash,
    sourceKey: plan.sourceKey,
    claimPath,
  });
  createPrivateDirectory(plan.budgetSource.request.evidenceRoot);
  const bridge = save(join(plan.budgetSource.request.evidenceRoot, 'autonomous-reservation.json'), {
    kind: 'h06-autonomous-budget-reservation/1',
    sourceKey: plan.sourceKey,
    source: plan.input.budgetSource.source,
    attempt: plan.input.budgetSource.attempt,
    requestHash: plan.budgetSource.requestHash,
    reservation,
    claimPath,
  });
  // The source reservation remains consumed if evidence preparation is interrupted.
  if (plan.budgetSource.mode === 'legacy-transfer')
    createPrivateDirectory(plan.request.evidenceRoot);
  const claim: DelegatedClaim = {
    kind: 'h06-delegated-legacy-claim/1',
    input: plan.input,
    request: plan.request,
    assets: plan.assets,
    requestHash: plan.requestHash,
    actorId: plan.actorId,
    generation: plan.generation,
    sourceKey: plan.sourceKey,
    source: plan.source,
    budget: {
      ...plan.budgetSource,
      bridge,
      identity: identity(plan.budgetSource.request.evidenceRoot),
    },
    reservation,
    identity: { reservation: identity(capRoot), evidence: identity(plan.request.evidenceRoot) },
    startedAt,
    workDeadlineMs,
    stopDeadlineMs,
    qualification: false,
  };
  const receipt = save(claimPath, claim);
  save(join(capRoot, 'issued.json'), {
    kind: 'h06-delegated-issued/1',
    reservation,
    claim: receipt,
  });
  createPrivateDirectory(join(plan.request.evidenceRoot, 'delegated-phases'));
  return { ...claim, receipt, grant: { sessionsRoot: h06NativeSessionsRoot() } };
}

/** Reopen the exact issued claim without converting it to a primary-human /2 receipt. */
export function readH06DelegatedAuthority(receipt: H04Pin) {
  const supplied = h04Pin(receipt);
  const claim = read(supplied) as unknown as DelegatedClaim;
  exactFields(object(claim), [
    'kind',
    'input',
    'request',
    'assets',
    'requestHash',
    'actorId',
    'generation',
    'sourceKey',
    'source',
    'budget',
    'reservation',
    'identity',
    'startedAt',
    'workDeadlineMs',
    'stopDeadlineMs',
    'qualification',
  ]);
  requireContract(claim.kind === 'h06-delegated-legacy-claim/1', 'h06-delegated-claim-kind');
  const input = parseInput(claim.input);
  const request = readH06NativeRequestBinding(read(input.attempt));
  const budget = budgetBinding(input, request, claim.assets, claim.source);
  exactFields(object(claim.budget), [
    'request',
    'requestHash',
    'source',
    'mode',
    'bridge',
    'identity',
  ]);
  requireContract(
    same(budget.request, claim.budget.request) &&
      same(budget.source, claim.budget.source) &&
      budget.requestHash === claim.budget.requestHash &&
      budget.mode === claim.budget.mode &&
      same(identity(budget.request.evidenceRoot), claim.budget.identity),
    'h06-delegated-budget-changed',
  );
  requireContract(
    same(request, claim.request) &&
      same(claim.assets, h06Assets()) &&
      digest(canonical({ request: claim.request, assets: claim.assets })) === claim.requestHash &&
      supplied.path === join(claim.request.evidenceRoot, 'delegated-claim.json') &&
      claim.sourceKey === sourceKey(input, claim.request.chat.threadId),
    'h06-delegated-claim-binding',
  );
  const capRoot = reservationRoot(claim.sourceKey);
  requireContract(
    same(identity(capRoot), claim.identity.reservation) &&
      same(identity(claim.request.evidenceRoot), claim.identity.evidence),
    'h06-delegated-root-changed',
  );
  const issued = read({
    path: join(capRoot, 'issued.json'),
    sha256: digest(h01RawFile(join(capRoot, 'issued.json'))),
  });
  exactFields(issued, ['kind', 'reservation', 'claim']);
  requireContract(
    issued.kind === 'h06-delegated-issued/1' &&
      same(issued.claim, supplied) &&
      same(issued.reservation, claim.reservation),
    'h06-delegated-issued-binding',
  );
  const reserved = read(claim.reservation);
  exactFields(reserved, ['kind', 'inputHash', 'requestHash', 'sourceKey', 'claimPath']);
  requireContract(
    claim.reservation.path === join(capRoot, 'reservation.json') &&
      reserved.kind === 'h06-delegated-source-reservation/1' &&
      reserved.inputHash === digest(canonical(input)) &&
      reserved.requestHash === claim.requestHash &&
      reserved.sourceKey === claim.sourceKey &&
      reserved.claimPath === supplied.path,
    'h06-delegated-reservation-binding',
  );
  requireContract(
    claim.budget.bridge.path === join(budget.request.evidenceRoot, 'autonomous-reservation.json') &&
      same(read(claim.budget.bridge), {
        kind: 'h06-autonomous-budget-reservation/1',
        sourceKey: claim.sourceKey,
        source: input.budgetSource.source,
        attempt: input.budgetSource.attempt,
        requestHash: budget.requestHash,
        reservation: claim.reservation,
        claimPath: supplied.path,
      }),
    'h06-delegated-budget-bridge',
  );
  const bootstrap = read(claim.request.bootstrap);
  requireContract(
    bootstrap.actorId === claim.actorId &&
      bootstrap.generation === claim.generation &&
      same(nativeSource(input, claim.request, false), claim.source),
    'h06-delegated-source-changed',
  );
  requireContract(
    integer(claim.startedAt, 1) <= Date.now() &&
      claim.stopDeadlineMs === claim.startedAt + claim.request.budget.maxElapsedMs &&
      claim.workDeadlineMs === claim.stopDeadlineMs - claim.request.budget.reserveMs &&
      claim.qualification === false,
    'h06-delegated-clock',
  );
  return { ...claim, receipt: supplied, grant: { sessionsRoot: h06NativeSessionsRoot() } };
}

function phaseInput(value: unknown): H06DelegatedPhase {
  const phase = object(value);
  exactFields(phase, [
    'stage',
    'nonce',
    'rootThread',
    'actorThread',
    'requestHash',
    'generation',
    'storeRevision',
    'controlRevision',
    'requirementsRevision',
    'predecessor',
  ]);
  requireContract(
    h06DelegatedStages.includes(phase.stage as H06DelegatedStage),
    'h06-delegated-stage',
  );
  requireContract(
    typeof phase.requestHash === 'string' && /^[a-f0-9]{64}$/u.test(phase.requestHash),
    'h06-delegated-request-hash',
  );
  return {
    stage: phase.stage as H06DelegatedStage,
    nonce: identifier(phase.nonce),
    rootThread: identifier(phase.rootThread),
    actorThread: identifier(phase.actorThread),
    requestHash: phase.requestHash,
    generation: integer(phase.generation, 1),
    storeRevision: integer(phase.storeRevision),
    controlRevision: integer(phase.controlRevision),
    requirementsRevision: integer(phase.requirementsRevision),
    predecessor: phase.predecessor === null ? null : h04Pin(phase.predecessor),
  };
}

/** Reserve phase commands before delivery. A missing result remains unknown across processes. */
export function openH06DelegatedPhaseLedger(receipt: H04Pin) {
  const claimed = readH06DelegatedAuthority(receipt);
  const directory = join(claimed.request.evidenceRoot, 'delegated-phases');
  const initialIdentity = identity(directory);
  function bound() {
    const claim = readH06DelegatedAuthority(receipt);
    requireContract(same(identity(directory), initialIdentity), 'h06-delegated-phase-root-changed');
    return claim;
  }
  function confirmed(
    outcome: H04Pin,
    intent: H04Pin,
    phase: H06DelegatedPhase,
    previous?: PhaseRecord,
  ) {
    const result = read(outcome);
    exactFields(result, ['kind', 'claim', 'intent', 'stage', 'status', 'delivery', 'result']);
    requireContract(
      result.kind === 'h06-delegated-phase-outcome/1' &&
        result.status === 'confirmed' &&
        same(result.claim, receipt) &&
        same(result.intent, intent) &&
        result.stage === phase.stage,
      'h06-delegated-outcome-binding',
    );
    readH04Pin(h04Pin(result.result));
    // Completion is the finishing Writer in the same cold-resume delivery, not another command.
    if (phase.stage === 'completion') {
      requireContract(
        previous?.phase.stage === 'cold-resume' &&
          previous.outcome !== null &&
          same(phase.predecessor, previous.outcome),
        'h06-delegated-completion-predecessor',
      );
      const prior = read(h04Pin(read(previous.outcome).outcome));
      requireContract(same(prior.delivery, result.delivery), 'h06-delegated-completion-delivery');
      phase = previous.phase;
      intent = previous.intent;
    }
    const delivery = verifyH06DelegatedDelivery(read(h04Pin(result.delivery)));
    const command = delivery.input.command;
    requireContract(
      delivery.input.root.threadId === claimed.request.chat.threadId &&
        delivery.input.root.workspace === claimed.request.chat.workspace &&
        delivery.input.root.turnId === claimed.source.turnId &&
        same(delivery.input.root.user, claimed.source.source) &&
        delivery.input.actor.threadId === claimed.actorId &&
        delivery.input.actor.workspace === claimed.request.binding.workspaceRoot &&
        command.requestHash === claimed.requestHash &&
        command.nonce === phase.nonce &&
        command.action === h06DelegatedPhaseAction(phase.stage) &&
        same(command.target, {
          claim: receipt,
          intent,
          stage: phase.stage,
          generation: phase.generation,
          storeRevision: phase.storeRevision,
          controlRevision: phase.controlRevision,
          requirementsRevision: phase.requirementsRevision,
        }),
      'h06-delegated-delivery-binding',
    );
  }
  function inspect() {
    bound();
    const files = new Set(
      readdirSync(directory).filter((name) => !/^\.pending-[a-f0-9-]{36}$/u.test(name)),
    );
    const phases: PhaseRecord[] = [];
    for (let index = 1; files.delete(index + '-intent.json'); index++) {
      requireContract(
        index <= h06DelegatedStages.length && phases.at(-1)?.outcome !== null,
        'h06-delegated-phase-order',
      );
      const path = join(directory, index + '-intent.json');
      const intent = { path, sha256: digest(h01RawFile(path)) };
      const record = read(intent);
      exactFields(record, ['kind', 'claim', 'index', 'phase', 'admittedAt']);
      const phase = phaseInput(record.phase);
      requireContract(
        record.kind === 'h06-delegated-phase-intent/1' &&
          same(record.claim, receipt) &&
          record.index === index &&
          phase.stage === h06DelegatedStages[index - 1] &&
          phase.rootThread === claimed.request.chat.threadId &&
          phase.actorThread === claimed.actorId &&
          phase.requestHash === claimed.requestHash &&
          phase.generation === claimed.generation &&
          same(phase.predecessor, phases.at(-1)?.outcome ?? null) &&
          !phases.some((entry) => entry.phase.nonce === phase.nonce) &&
          phases.every(
            (entry) =>
              phase.storeRevision >= entry.phase.storeRevision &&
              phase.controlRevision >= entry.phase.controlRevision &&
              phase.requirementsRevision === entry.phase.requirementsRevision,
          ) &&
          integer(record.admittedAt, claimed.startedAt) < claimed.workDeadlineMs &&
          integer(record.admittedAt, claimed.startedAt) <= Date.now(),
        'h06-delegated-phase-binding',
      );
      let outcome: H04Pin | null = null;
      if (files.delete(index + '-outcome.json')) {
        const outcomePath = join(directory, index + '-outcome.json');
        outcome = { path: outcomePath, sha256: digest(h01RawFile(outcomePath)) };
        const record = read(outcome);
        exactFields(record, ['kind', 'intent', 'outcome', 'settledAt']);
        requireContract(
          record.kind === 'h06-delegated-phase-settlement/1' && same(record.intent, intent),
          'h06-delegated-phase-settlement',
        );
        requireContract(
          integer(record.settledAt, Number(read(intent).admittedAt)) <= Date.now(),
          'h06-delegated-clock',
        );
        confirmed(h04Pin(record.outcome), intent, phase, phases.at(-1));
      }
      phases.push({ phase, intent, outcome });
    }
    requireContract(files.size === 0, 'h06-delegated-phase-files');
    bound();
    return { status: phases.at(-1)?.outcome === null ? 'UNKNOWN' : 'RECORDED', phases } as const;
  }
  function admitPhase(value: unknown) {
    const claim = bound();
    const phase = phaseInput(value);
    const state = inspect();
    requireContract(state.status === 'RECORDED', 'h06-delegated-phase-unknown');
    requireContract(Date.now() < claim.workDeadlineMs, 'h06-delegated-work-expired');
    nativeSource(claim.input, claim.request, true);
    const index = state.phases.length + 1;
    requireContract(
      phase.stage === h06DelegatedStages[index - 1] &&
        phase.rootThread === claim.request.chat.threadId &&
        phase.actorThread === claim.actorId &&
        phase.requestHash === claim.requestHash &&
        phase.generation === claim.generation &&
        same(phase.predecessor, state.phases.at(-1)?.outcome ?? null) &&
        !state.phases.some((entry) => entry.phase.nonce === phase.nonce) &&
        state.phases.every(
          (entry) =>
            phase.storeRevision >= entry.phase.storeRevision &&
            phase.controlRevision >= entry.phase.controlRevision &&
            phase.requirementsRevision === entry.phase.requirementsRevision,
        ),
      'h06-delegated-phase-binding',
    );
    return save(join(directory, index + '-intent.json'), {
      kind: 'h06-delegated-phase-intent/1',
      claim: receipt,
      index,
      phase,
      admittedAt: Date.now(),
    });
  }
  function settlePhase(outcome: H04Pin) {
    bound();
    const state = inspect();
    const pending = state.phases.at(-1);
    requireContract(
      state.status === 'UNKNOWN' && pending !== undefined,
      'h06-delegated-phase-not-pending',
    );
    confirmed(outcome, pending.intent, pending.phase, state.phases.at(-2));
    return save(join(directory, state.phases.length + '-outcome.json'), {
      kind: 'h06-delegated-phase-settlement/1',
      intent: pending.intent,
      outcome,
      settledAt: Date.now(),
    });
  }
  return { inspect, admitPhase, settlePhase };
}
