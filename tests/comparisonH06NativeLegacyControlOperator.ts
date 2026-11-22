import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual as same } from 'node:util';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { OperationResult } from '../core/evidence.js';
import type { InputRef } from '../core/localRun.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { exactFields, object, requireContract, text } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { readH06NativeAttemptForReopen } from './comparisonH06NativeAttempt.js';
import { runH06NativeLegacyControl } from './comparisonH06NativeLegacyControl.js';

type Store = Parameters<typeof runH06NativeLegacyControl>[0];
type Control = Parameters<typeof runH06NativeLegacyControl>[1];

interface LegacyControlOperation {
  claim: H04Pin;
  started: H04Pin;
  control: Control;
}

function controlPlan(store: Store, operation: LegacyControlOperation) {
  const claim = readH06NativeAttemptForReopen(operation.claim);
  const { request } = claim;
  const { control } = operation;
  const { event, phase } = control;
  const { context } = store.grant;
  const started = h04Pin(operation.started);
  const initial = object(JSON.parse(readH04Pin(started).toString()));
  requireContract(
    request.binding.variant === 'legacy' &&
      started.path === join(request.evidenceRoot, 'legacy-operator-start.json') &&
      initial.kind === 'h06-native-legacy-operator-start' &&
      same(initial.claim, claim.receipt) &&
      same(initial.bootstrap, request.bootstrap) &&
      same(initial.context, context) &&
      context.task_id === request.binding.operationId &&
      initial.generation === event.generation &&
      store.root === join(request.evidenceRoot, 'legacy-store') &&
      initial.storeRoot === store.root &&
      control.evidenceRoot === request.evidenceRoot &&
      control.workspaceRoot === request.binding.workspaceRoot &&
      event.thread_id === context.actor_id &&
      control.anchor.thread_id === event.thread_id &&
      control.anchor.workspace === control.workspaceRoot &&
      control.anchor.host_id === 'local' &&
      (phase === 'warm' || phase === 'cold') &&
      (event.type === 'PAUSE' || event.type === 'RESUME'),
    'h06-legacy-control-operator-binding',
  );
  const command =
    event.type === 'PAUSE'
      ? { action: event.type, reason: event.reason }
      : { action: event.type, marker: event.marker, stopped: event.stopped };
  const expectedText = canonical({
    kind: 'comparison-h06-native-legacy-control/2',
    claim: claim.receipt,
    phase,
    target: {
      ...context,
      generation: event.generation,
      storeRevision: control.storeRevision,
      controlRevision: event.expected_revision,
      requirementsRevision: control.requirementsRevision,
    },
    commandId: event.id,
    ...command,
    ...('paused' in control ? { paused: control.paused, stoppedBy: control.stoppedBy } : {}),
  });
  return {
    expectedText,
    sessionsRoot: claim.grant.sessionsRoot,
    workDeadlineMs: claim.workDeadlineMs,
  };
}

function beforeDeadline(workDeadlineMs: number) {
  requireContract(Date.now() < workDeadlineMs, 'h06-legacy-control-operator-binding');
}

/** The source locator and the issuing turn are observed after the exact text is sent. */
export function planH06NativeLegacyControl(store: Store, operation: LegacyControlOperation) {
  const { expectedText, sessionsRoot, workDeadlineMs } = controlPlan(store, operation);
  beforeDeadline(workDeadlineMs);
  return { expectedText, sessionsRoot, mayRun: false } as const;
}

function exactSource(control: Control) {
  const { event, transcript, anchor } = control;
  if (event.type === 'PAUSE') return event.source;
  requireContract(
    event.authorization !== undefined &&
      same(event.source, event.authorization) &&
      event.previous_source_turn === undefined,
    'h06-legacy-control-operator-authorization',
  );
  const bytes = readH04Pin({ path: event.authorization.locator, sha256: event.authorization.hash });
  const command = object(JSON.parse(bytes.toString()));
  const issuer = object(command.issuer);
  requireContract(
    command.schema_version === 1 &&
      command.action === 'RESUME' &&
      issuer.transcript === transcript &&
      same(issuer.anchor, anchor),
    'h06-legacy-control-operator-authorization',
  );
  const source = object(issuer.source);
  return { locator: text(source.locator), hash: text(source.hash) } satisfies InputRef;
}

function verifyText(transcript: string, source: InputRef, expected: string) {
  const locator = /^(.*)#L([1-9]\d*)$/u.exec(source.locator);
  requireContract(locator?.[1] === transcript, 'h06-legacy-control-operator-source');
  const content = h01RawFile(transcript).toString('utf8');
  requireContract(content.endsWith('\n'), 'h06-legacy-control-operator-source');
  const line = content.slice(0, -1).split('\n')[Number(locator[2]) - 1];
  requireContract(
    line !== undefined && digest(line + '\n') === source.hash,
    'h06-legacy-control-operator-source',
  );
  const record = object(JSON.parse(line));
  const payload = object(record.payload);
  requireContract(
    record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content) &&
      payload.content.length === 1,
    'h06-legacy-control-operator-human',
  );
  const body = object(payload.content[0]);
  requireContract(
    body.type === 'input_text' && (body.text === expected || body.text === expected + '\n'),
    'h06-legacy-control-operator-human',
  );
}

function controlOutcome(store: Store, operationId: string) {
  return unwrap<OperationResult>(
    store.execute({
      context: store.grant.context,
      command: { type: 'operation', operation_id: operationId },
    }),
  );
}

function replayControl(
  store: Store,
  control: Control,
  prefix: string,
  authority: H04Pin,
  controlHash: string,
) {
  const completedPath = prefix + '-completion.json';
  requireContract(
    lstatSync(completedPath, { throwIfNoEntry: false }) !== undefined,
    'h06-legacy-control-operator-replay-incomplete',
  );
  readH04Pin(authority);
  const completed = object(JSON.parse(h01RawFile(completedPath).toString()));
  exactFields(completed, ['kind', 'authority', 'controlHash', 'intent', 'receipt']);
  requireContract(
    same(
      { kind: completed.kind, authority: completed.authority, controlHash: completed.controlHash },
      { kind: 'h06-native-legacy-control-completion', authority, controlHash },
    ),
    'h06-legacy-control-operator-replay-conflict',
  );
  const intent = h04Pin(completed.intent);
  const receipt = h04Pin(completed.receipt);
  requireContract(
    same([intent.path, receipt.path], [prefix + '-intent.json', prefix + '.json']),
    'h06-legacy-control-operator-replay-conflict',
  );
  const prepared = object(JSON.parse(readH04Pin(intent).toString()));
  const result = object(JSON.parse(readH04Pin(receipt).toString()));
  const { event, phase } = control;
  const operation = 'chat:control:' + event.id;
  const identity = {
    workspace: control.workspaceRoot,
    store: store.root,
    evidence: control.evidenceRoot,
    context: store.grant.context,
    generation: event.generation,
  };
  const binding = { phase, identity, event, operation };
  requireContract(
    same(
      {
        kind: prepared.kind,
        phase: prepared.phase,
        identity: prepared.identity,
        event: prepared.event,
        operation: prepared.operation,
        storeRevision: prepared.storeRevision,
        requirementsRevision: prepared.requirementsRevision,
      },
      {
        ...binding,
        kind: 'h06-native-legacy-control-intent',
        storeRevision: control.storeRevision,
        requirementsRevision: control.requirementsRevision,
      },
    ) &&
      same(
        {
          kind: result.kind,
          phase: result.phase,
          identity: result.identity,
          event: result.event,
          operation: result.operation,
          intent: result.intent,
          host: result.host,
          controlRevision: result.controlRevision,
        },
        {
          ...binding,
          kind: 'h06-native-legacy-' + event.type.toLowerCase(),
          intent,
          host: prepared.host,
          controlRevision: event.expected_revision + 1,
        },
      ),
    'h06-legacy-control-operator-replay-conflict',
  );
  const outcome = controlOutcome(store, operation);
  requireContract(
    outcome.status === 'confirmed' &&
      same(outcome.ack, result.ack) &&
      same(
        [outcome.ack.operation_id, outcome.ack.generation, outcome.ack.catalog_revision],
        [operation, event.generation, control.storeRevision + 1],
      ),
    'h06-legacy-control-operator-replay-unconfirmed',
  );
  return { intent, receipt, authority };
}

/** Consume one phase-specific authorization, or read back an already confirmed exact repeat. */
export async function runH06NativeLegacyControlOperator(
  store: Store,
  value: LegacyControlOperation,
) {
  const operation = structuredClone(value);
  const { control } = operation;
  const { anchor, event, transcript } = control;
  const plan = controlPlan(store, operation);
  requireContract(
    transcript.startsWith(join(plan.sessionsRoot, '/')) &&
      process.env.CODEX_THREAD_ID === anchor.thread_id,
    'h06-legacy-control-operator-transcript',
  );
  const source = exactSource(control);
  verifyText(transcript, source, plan.expectedText);
  const prefix = join(control.evidenceRoot, `legacy-${control.phase}-${event.type.toLowerCase()}`);
  const bytes = Buffer.from(
    canonical({
      kind: 'h06-native-legacy-control-authority',
      claim: operation.claim,
      started: operation.started,
      transcript,
      anchor,
      source,
      expectedText: plan.expectedText,
      event,
    }) + '\n',
  );
  const authority = { path: prefix + '-authority.json', sha256: digest(bytes) };
  const controlHash = digest(canonical(control));
  const replay = () => replayControl(store, control, prefix, authority, controlHash);
  if (lstatSync(authority.path, { throwIfNoEntry: false }) !== undefined) return replay();
  beforeDeadline(plan.workDeadlineMs);
  const host = new FileCurrentChatHost(control.workspaceRoot, transcript, anchor);
  await host.message(source, anchor.turn_id);
  planH06NativeLegacyControl(store, operation);
  await host.message(source, anchor.turn_id);
  for (const suffix of ['-intent.json', '.json', '-completion.json'])
    requireContract(
      lstatSync(prefix + suffix, { throwIfNoEntry: false }) === undefined,
      'h06-legacy-control-operator-replay-incomplete',
    );
  requireContract(
    controlOutcome(store, 'chat:control:' + event.id).status === 'not-started',
    'h06-legacy-control-operator-replay-unconfirmed',
  );
  try {
    publishFile(authority.path, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return replay();
  }
  const result = await runH06NativeLegacyControl(store, control);
  publishFile(
    prefix + '-completion.json',
    Buffer.from(
      canonical({
        kind: 'h06-native-legacy-control-completion',
        authority,
        controlHash,
        ...result,
      }) + '\n',
    ),
  );
  return { ...result, authority };
}
