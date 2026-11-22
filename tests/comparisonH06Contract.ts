import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import { parseLocalTask, localTaskKey } from '../src/policy/localTask.js';
import { controlRef } from '../src/policy/readerControl.js';
import { lookupEffect } from '../src/adapters/artifacts/effects.js';
import type { ArtifactRef } from '../src/contracts/preparation.js';
import type { EffectIntent } from '../src/adapters/artifacts/effects.js';
import { historyFromJSON } from '@temporalio/common/proto-utils';
import { defaultPayloadConverter, fromPayloadsAtIndex } from '@temporalio/common';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, readH04Json, type H04Pin } from './comparisonH04Contract.js';

export const h06Checks = [
  'ownership-continuity-across-long-stage',
  'live-writer-detected',
  'stop-confirmed',
  'resume-distinct',
  'no-double-launch',
  'harness-compatible',
  'fail-history',
] as const;
export const h06AssetHashes = {
  'suite.json': '571e38933ef284d88fae801b632c220c48847eca728c6127dc02506b40954e37',
  'materials.json': 'ff17050ec0de67190a04aa1108379e25c86b06db48a324c37ce121b018b90bfa',
  'accepted-criteria-freeze.json':
    'de4c99c7e215c72fc9f6c0d94b0a3ac46fe0238e4a3150038945c97272528dea',
} as const;
export const h06SourcePaths = [
  './comparisonH06.ts',
  './comparisonH06Contract.ts',
  './comparisonH04Contract.ts',
  './temporal/task-execution-sdk-fixture.mjs',
  '../cli/chatContinuation.ts',
  '../adapters/storage/sqliteEvidenceStore.ts',
  '../src/workflows/localTask.ts',
  '../src/workflows/taskExecution.ts',
  '../examples/temporal-consumers/full/safety.mjs',
  '../src/adapters/artifacts/effects.ts',
].map((p) => fileURLToPath(new URL(p, import.meta.url)));
export interface H06Request {
  schemaVersion: 1;
  kind: 'comparison-h06-model-free/2';
  operationId: string;
  variant: 'legacy' | 'temporal';
  outputRoot: string;
  node: H04Pin;
  server: H04Pin | null;
  assets: { suite: H04Pin; materials: H04Pin; acceptance: H04Pin };
  identity: {
    owner: 'synthetic-human';
    generation: 1;
    workspace: 'sdk-copy';
    scope: 'model-free-h06';
  };
  stimulus: { stageMs: 35000; oldLeaseMs: 20000 };
  budget: { totalMs: 180000; stopMs: 30000 };
}
export function h06Assets() {
  const pin = (
    name: keyof typeof h06AssetHashes,
    directory = './fixtures/qualification/ownership-continuity-v2/',
  ): H04Pin => ({
    path: fileURLToPath(new URL(directory + name, import.meta.url)),
    sha256: h06AssetHashes[name],
  });
  return {
    suite: pin('suite.json'),
    materials: pin('materials.json'),
    acceptance: pin(
      'accepted-criteria-freeze.json',
      '../docs/evidence/qualification/ownership-continuity-v2/',
    ),
  };
}
export function parseH06Request(value: unknown): H06Request {
  const v = object(value);
  exactFields(v, [
    'schemaVersion',
    'kind',
    'operationId',
    'variant',
    'outputRoot',
    'node',
    'server',
    'assets',
    'identity',
    'stimulus',
    'budget',
  ]);
  requireContract(v.schemaVersion === 1 && v.kind === 'comparison-h06-model-free/2', 'h06-schema');
  requireContract(
    typeof v.operationId === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(v.operationId),
    'h06-operation-id',
  );
  requireContract(v.variant === 'legacy' || v.variant === 'temporal', 'h06-variant');
  h04Pin({ path: v.outputRoot, sha256: '0'.repeat(64) });
  h04Pin(v.node);
  if (v.server !== null) h04Pin(v.server);
  requireContract((v.variant === 'temporal') === (v.server !== null), 'h06-server');
  requireContract(same(v.assets, h06Assets()), 'h06-assets');
  for (const pin of Object.values(h06Assets())) readH04Pin(pin);
  const suite = object(JSON.parse(readH04Pin(h06Assets().suite).toString()));
  const scenarios = suite.scenarios;
  requireContract(Array.isArray(scenarios), 'h06-suite');
  const scenario = scenarios.map(object).find((s) => s.id === 'H-06');
  requireContract(same(scenario?.checks, h06Checks), 'h06-criteria');
  requireContract(
    same(v.identity, {
      owner: 'synthetic-human',
      generation: 1,
      workspace: 'sdk-copy',
      scope: 'model-free-h06',
    }),
    'h06-model-free-identity',
  );
  requireContract(same(v.stimulus, { stageMs: 35000, oldLeaseMs: 20000 }), 'h06-stimulus');
  requireContract(same(v.budget, { totalMs: 180000, stopMs: 30000 }), 'h06-budget');
  return v as unknown as H06Request;
}
export const h06Hash = (request: H06Request) => digest(canonical(request));
export function h06Intent(request: H06Request): EffectIntent {
  return {
    projectId: 'h06',
    taskId: request.operationId,
    operationId: request.operationId + '-writer',
    requestHash: h06Hash(request),
    hostId: 'h06-model-free',
    workspaceId: request.identity.workspace,
    owner: request.identity.owner,
    generation: request.identity.generation,
  };
}
export function h06Failure(request: H06Request): Buffer {
  return Buffer.from(
    canonical({
      id: 'F-01',
      result: 'FAIL',
      operationId: request.operationId,
      inputHash: h06Hash(request),
      scope: request.identity.scope,
    }) + '\n',
  );
}
export function h06Stopped(value: unknown): boolean {
  const v = object(value);
  return (
    v.stopped === true &&
    v.code === 0 &&
    v.signal === null &&
    v.killed !== true &&
    v.deadlineReached === false
  );
}
function bound(request: H06Request, value: unknown) {
  const v = object(value);
  requireContract(
    v.inputHash === h06Hash(request) && same(v.identity, request.identity),
    'h06-identity',
  );
  return v;
}
export function readH06Artifact(root: string, value: unknown) {
  const ref = controlRef(value),
    bytes = readH04Pin({ path: join(root, 'artifacts', ref.sha256), sha256: ref.sha256 });
  requireContract(bytes.length === ref.bytes, 'h06-artifact-size');
  return object(JSON.parse(bytes.toString()));
}
export function readH06WriterEffect(request: H06Request): ArtifactRef | null {
  const root = request.outputRoot,
    journal = join(root, 'effects'),
    snapshot = () =>
      readdirSync(journal)
        .sort()
        .map((name) => ({ name, sha256: digest(h01RawFile(join(journal, name))) })),
    before = snapshot();
  const effect = lookupEffect(journal, h06Intent(request));
  if (effect.status !== 'completed') return null;
  requireContract(before.length === 2, 'h06-duplicate-writer-effect');
  requireContract(same(before, snapshot()), 'h06-effect-changed');
  const intent = h06Intent(request),
    key = digest(JSON.stringify([intent.projectId, intent.taskId, intent.operationId]));
  requireContract(
    same(controlRef(readH04Json(join(journal, key + '.receipt'))), effect.receipt),
    'h06-effect-receipt-changed',
  );
  return controlRef(effect.receipt);
}
export function readH06Checkpoint(request: H06Request, value: unknown) {
  const body = bound(request, value);
  requireContract(
    body.kind === 'h06-pending-operation' &&
      body.operationId === request.operationId &&
      body.status === 'pending' &&
      same(body.effectIdentity, h06Intent(request)),
    'h06-pending-binding',
  );
  const root =
    request.variant === 'legacy' ? request.outputRoot : join(request.outputRoot, 'sdk-fixture');
  const checkpoint = readH06Artifact(root, body.checkpoint);
  if (request.variant === 'legacy')
    requireContract(
      checkpoint.inputHash === h06Hash(request) && checkpoint.unfinished === request.operationId,
      'h06-legacy-checkpoint',
    );
  else {
    const initial = readH04Json(join(request.outputRoot, 'workflow-input.json'));
    requireContract(
      checkpoint.syntheticHeld === true && same(checkpoint.input, initial),
      'h06-temporal-checkpoint',
    );
  }
  return checkpoint;
}
export function checkH06(request: H06Request) {
  const root = request.outputRoot;
  requireContract(realpathSync(root) === root, 'h06-output-alias');
  const pins: unknown = readH04Json(join(root, 'source-pins.json'));
  requireContract(Array.isArray(pins), 'h06-source-pins');
  requireContract(
    same(
      pins.map((p) => h04Pin(p).path),
      h06SourcePaths,
    ),
    'h06-source-paths',
  );
  pins.map(h04Pin).forEach(readH04Pin);
  readH04Pin(request.node);
  if (request.server !== null) readH04Pin(request.server);
  const unknown = (reason: string) => ({
    outcome: 'UNKNOWN',
    qualification: false,
    modelFree: 'UNKNOWN',
    reason,
    historicalV1LeaseRenewedTemporal: 'UNMET',
    checks: h06Checks.map((id) => ({ id, status: 'NOT_PROVEN' })),
  });
  for (const name of [
    'initial.json',
    'cold.json',
    'initial-stop.json',
    'cold-stop.json',
    'worker-stop.json',
    'stop.json',
  ])
    if (!existsSync(join(root, name))) return unknown('missing-' + name);
  for (const name of ['initial-stop.json', 'cold-stop.json', 'worker-stop.json', 'stop.json'])
    if (!h06Stopped(readH04Json(join(root, name)))) return unknown('unconfirmed-' + name);
  const first = bound(request, readH04Json(join(root, 'initial.json'))),
    cold = bound(request, readH04Json(join(root, 'cold.json')));
  requireContract(
    first.phase === 'same-environment' && cold.phase === 'cold-host-reopen',
    'h06-resume-paths',
  );
  const oldHost = object(first.host),
    newHost = object(cold.host);
  requireContract(
    Number.isSafeInteger(oldHost.pid) &&
      Number.isSafeInteger(newHost.pid) &&
      Number(oldHost.pid) > 1 &&
      Number(newHost.pid) > 1 &&
      oldHost.pid !== newHost.pid,
    'h06-cold-host-not-distinct',
  );
  for (const [name, host] of [
    ['initial-stop.json', oldHost],
    ['cold-stop.json', newHost],
  ] as const) {
    const receipt = object(readH04Json(join(root, name)));
    requireContract(
      Array.isArray(receipt.identities) && receipt.identities.some((p) => same(p, host)),
      'h06-host-process-binding',
    );
  }
  const workspace = { dev: String(lstatSync(root).dev), ino: String(lstatSync(root).ino) };
  requireContract(
    same(first.workspace, workspace) && same(cold.workspace, workspace),
    'h06-workspace-changed',
  );
  const pending = controlRef(first.pending);
  controlRef(cold.pending);
  const pendingBody = readH06Artifact(root, pending);
  readH06Checkpoint(request, pendingBody);
  for (const raw of [first.state, cold.state]) {
    const state = bound(request, raw);
    requireContract(
      state.operationId === request.operationId &&
        state.status === 'pending' &&
        same(state.pending, pending) &&
        state.frozen === false &&
        state.released === false,
      'h06-state-binding',
    );
  }
  requireContract(
    same(first.pending, cold.pending) && same(first.state, cold.state),
    'h06-cold-state-changed',
  );
  requireContract(
    cold.dispatches === 0 &&
      cold.frozenReleasedRefused === true &&
      cold.unknownEffectRefused === true,
    'h06-cold-dispatch',
  );
  requireContract(
    Number.isSafeInteger(first.stageStartedAt) &&
      Number.isSafeInteger(first.stageEndedAt) &&
      typeof first.stageStartedAt === 'number' &&
      typeof first.stageEndedAt === 'number' &&
      first.clockBasis === 'Date.now+performance.now' &&
      first.stageEndedAt - first.stageStartedAt >= request.stimulus.stageMs &&
      typeof first.stageElapsedMs === 'number' &&
      Number.isFinite(first.stageElapsedMs) &&
      first.stageElapsedMs >= request.stimulus.stageMs,
    'h06-stage-too-short',
  );
  const failure = readH04Pin(h04Pin(first.failure));
  requireContract(
    failure.equals(h06Failure(request)) && same(first.failure, cold.failure),
    'h06-fail-history',
  );
  const live = bound(request, readH04Json(join(root, 'writer-live.json'))),
    stopped = object(readH04Json(join(root, 'writer-stop.json'))),
    stability = object(readH04Json(join(root, 'writer-stability.json')));
  const liveIdentity = object(live.process),
    writerStop = object(stopped.receipt);
  requireContract(
    Number.isSafeInteger(liveIdentity.pid) &&
      Number(liveIdentity.pid) > 1 &&
      typeof liveIdentity.identity === 'string' &&
      liveIdentity.identity.trim().length > 0,
    'h06-writer-process',
  );
  if (!h06Stopped(writerStop)) return unknown('writer-stop-unconfirmed');
  requireContract(
    Array.isArray(writerStop.identities) &&
      writerStop.identities.some((p) => same(p, liveIdentity)),
    'h06-writer-identity',
  );
  requireContract(
    live.observedBeforeStop === true && stopped.inputHash === h06Hash(request),
    'h06-live-before-stop',
  );
  requireContract(
    stability.identitiesAbsent === true &&
      stability.listenersClosed === true &&
      stability.noLateWrite === true,
    'h06-writer-still-active',
  );
  const log = readH04Pin(h04Pin(stability.log));
  requireContract(log.length > 0, 'h06-writer-log-empty');
  const stopRef = readH06WriterEffect(request);
  if (stopRef === null) return unknown('writer-effect-unconfirmed');
  requireContract(same(readH06Artifact(root, stopRef), stopped), 'h06-effect-stop-binding');
  if (request.variant === 'legacy') {
    const lease = bound(request, readH04Json(join(root, 'lease.json'))),
      previous = object(lease.before),
      renewed = object(lease.renewed),
      after = object(lease.after),
      ack = object(lease.ack),
      operation = object(lease.operation),
      event = object(lease.event);
    requireContract(
      lease.automatic === true &&
        Number.isSafeInteger(lease.renewAcceptedAt) &&
        Number.isSafeInteger(previous.lease_until) &&
        Number.isSafeInteger(renewed.lease_until) &&
        typeof lease.renewAcceptedAt === 'number' &&
        typeof previous.lease_until === 'number' &&
        typeof renewed.lease_until === 'number',
      'h06-lease-proof',
    );
    requireContract(
      lease.renewAcceptedAt < previous.lease_until &&
        previous.lease_until < first.stageEndedAt &&
        first.stageEndedAt < renewed.lease_until,
      'h06-renew-order',
    );
    for (const state of [previous, renewed, after])
      requireContract(
        state.owner === request.identity.owner &&
          state.generation === request.identity.generation &&
          state.released === false &&
          state.frozen === false,
        'h06-owner-changed',
      );
    requireContract(
      typeof previous.revision === 'number' &&
        renewed.revision === previous.revision + 1 &&
        same(after, renewed),
      'h06-renew-transition',
    );
    requireContract(
      ack.operation_id === `chat:lease:${request.identity.generation}:${previous.revision}` &&
        ack.operation_id === event.operation_id &&
        operation.status === 'confirmed' &&
        same(operation.ack, ack) &&
        object(event.change).type === 'renew' &&
        object(event.change).lease_until === renewed.lease_until &&
        ack.catalog_revision === renewed.revision &&
        event.revision === ack.catalog_revision &&
        ack.generation === request.identity.generation,
      'h06-renew-receipt',
    );
    const context = object(event.context);
    requireContract(
      context.actor_id === request.identity.owner &&
        context.project_id === 'h06' &&
        context.task_id === request.operationId,
      'h06-renew-context',
    );
  } else {
    const initial = object(readH04Json(join(root, 'workflow-input.json'))),
      identity = object(object(initial.admission).preparation);
    requireContract(
      initial.schemaVersion === 11 &&
        identity.owner === request.identity.owner &&
        identity.generation === request.identity.generation &&
        object(identity.project).workspaceId === request.identity.workspace &&
        object(identity.project).projectId === request.operationId,
      'h06-workflow-owner',
    );
    const old = object(first.workflow),
      next = object(cold.workflow);
    requireContract(
      same(old, next) && old.workflowId === localTaskKey(parseLocalTask(initial)),
      'h06-workflow-changed',
    );
    for (const name of ['status-before.json', 'status-after.json']) {
      const query = object(readH04Json(join(root, name))),
        result = object(query.result);
      requireContract(
        query.workflowId === old.workflowId &&
          query.runId === old.runId &&
          query.query === 'localTaskStatus' &&
          result.waiting === true &&
          result.runId === old.runId &&
          same(result.held, pendingBody.checkpoint),
        'h06-query-binding',
      );
    }
    const beforeHistory = readH04Json(join(root, 'history-before.json')),
      afterHistory = readH04Json(join(root, 'history-after.json'));
    const history = historyFromJSON(beforeHistory),
      events = history.events!;
    const started = events.filter((e) => e.eventType === 1);
    requireContract(started.length === 1, 'h06-workflow-start');
    const attributes = started[0]!.workflowExecutionStartedEventAttributes!;
    requireContract(
      attributes.workflowType?.name === 'LocalTaskWorkflow' &&
        attributes.originalExecutionRunId === old.runId &&
        same(fromPayloadsAtIndex(defaultPayloadConverter, 0, attributes.input?.payloads), initial),
      'h06-workflow-input',
    );
    const later = historyFromJSON(afterHistory).events!;
    requireContract(
      later.length >= events.length && same(later.slice(0, events.length), events),
      'h06-history-prefix',
    );
    requireContract(
      later.filter(
        (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'writeLocalTask',
      ).length === 1,
      'h06-duplicate-workflow-writer',
    );
    const held = later.filter(
      (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'holdTaskExecution',
    );
    requireContract(held.length === 1, 'h06-hold-history');
    const completed = later.filter(
      (e) =>
        String(e.activityTaskCompletedEventAttributes?.scheduledEventId) ===
        String(held[0]!.eventId),
    );
    requireContract(completed.length === 1, 'h06-hold-completion');
    const heldResult = object(
      fromPayloadsAtIndex(
        defaultPayloadConverter,
        0,
        completed[0]!.activityTaskCompletedEventAttributes!.result?.payloads,
      ),
    );
    requireContract(
      heldResult.status === 'held' && same(heldResult.held, pendingBody.checkpoint),
      'h06-hold-result',
    );
    const replay = object(readH04Json(join(root, 'replay.json')));
    requireContract(
      replay.success === true &&
        replay.historyHash === digest(canonical(afterHistory)) &&
        replay.workflowId === old.workflowId &&
        replay.runId === old.runId,
      'h06-replay',
    );
    const warm = object(first.sameEnvironment);
    requireContract(
      warm.oldWorkerDrained === true &&
        warm.distinctWorker === true &&
        warm.freshClient === true &&
        same(warm.pending, pendingBody.checkpoint) &&
        warm.inputHash === digest(canonical(initial)),
      'h06-warm-recovery',
    );
    requireContract(
      same(first.pauseAck, cold.pauseAck) &&
        first.writerDrained === true &&
        cold.freshClient === true,
      'h06-worker-recovery',
    );
  }
  return {
    ...unknown('UNMET_PRIMARY_NATIVE_H06_PROOF'),
    modelFree: 'PASS',
    modelFreeChecks: h06Checks.map((id) => ({ id, status: 'PASS_SCOPED_MODEL_FREE' })),
    recoveryScope:
      'same-environment vs cold-host-reopen; not backend restore, RPO or native RESUME',
  };
}
