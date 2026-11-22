import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import type { ArtifactRef } from '../src/contracts/preparation.js';
import { controlRef } from '../src/policy/readerControl.js';
import { lookupEffect } from '../src/adapters/artifacts/effects.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { historyFromJSON } from '@temporalio/common/proto-utils';
import { defaultPayloadConverter, fromPayloadsAtIndex } from '@temporalio/common';
import type { EffectIntent } from '../src/adapters/artifacts/effects.js';

export const h04SourcePaths = [
  './comparisonH04.ts',
  './comparisonH04Contract.ts',
  './comparisonH04Workflow.ts',
  '../cli/councilProgress.ts',
  '../src/adapters/artifacts/effects.ts',
  '../examples/temporal-consumers/full/safety.mjs',
  './comparisonH01Contract.ts',
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export const h04Checks = [
  'one-wait-call',
  'no-model-poll',
  'same-turn',
  'primary-result',
  'no-duplicate-effect',
] as const;
export interface H04Pin {
  path: string;
  sha256: string;
}
export interface H04Request {
  schemaVersion: 1;
  kind: 'comparison-h04-model-free';
  operationId: string;
  variant: 'legacy' | 'temporal';
  outputRoot: string;
  node: H04Pin;
  server: H04Pin | null;
}
export interface H04Operation {
  kind: 'h04-operation-result';
  operationId: string;
  inputHash: string;
  elapsedMs: number;
  logs: { sequence: number; elapsedMs: number }[];
}
export interface H04OperationBinding {
  operationId: string;
  inputHash: string;
  outputRoot: string;
}
export function h04Binding(request: H04Request): H04OperationBinding {
  return {
    operationId: request.operationId,
    inputHash: h04InputHash(request),
    outputRoot: request.outputRoot,
  };
}
export function h04Pin(value: unknown): H04Pin {
  const v = object(value);
  exactFields(v, ['path', 'sha256']);
  requireContract(
    typeof v.path === 'string' && isAbsolute(v.path) && resolve(v.path) === v.path,
    'h04-path',
  );
  requireContract(typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(v.sha256), 'h04-hash');
  return v as unknown as H04Pin;
}
export function readH04Pin(pin: H04Pin): Buffer {
  const bytes = h01RawFile(pin.path);
  requireContract(digest(bytes) === pin.sha256, 'h04-pin-changed');
  return bytes;
}
export function parseH04Request(value: unknown): H04Request {
  const v = object(value);
  exactFields(v, [
    'schemaVersion',
    'kind',
    'operationId',
    'variant',
    'outputRoot',
    'node',
    'server',
  ]);
  requireContract(v.schemaVersion === 1 && v.kind === 'comparison-h04-model-free', 'h04-schema');
  requireContract(
    typeof v.operationId === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(v.operationId),
    'h04-operation-id',
  );
  requireContract(v.variant === 'legacy' || v.variant === 'temporal', 'h04-variant');
  requireContract(
    typeof v.outputRoot === 'string' &&
      isAbsolute(v.outputRoot) &&
      resolve(v.outputRoot) === v.outputRoot,
    'h04-path',
  );
  h04Pin(v.node);
  if (v.server !== null) h04Pin(v.server);
  requireContract((v.variant === 'temporal') === (v.server !== null), 'h04-server');
  return v as unknown as H04Request;
}
export function h04InputHash(request: H04Request): string {
  return digest(canonical(request));
}
export function h04Intent(request: H04Request, operation: 'run' | 'apply'): EffectIntent {
  return h04BoundIntent(h04Binding(request), operation);
}
export function h04BoundIntent(
  binding: H04OperationBinding,
  operation: 'run' | 'apply',
): EffectIntent {
  return {
    projectId: 'h04',
    taskId: binding.operationId,
    operationId: binding.operationId + '-' + operation,
    requestHash: binding.inputHash,
    hostId: 'local',
    workspaceId: 'h04',
    owner: 'h04-host',
    generation: 1,
  };
}
export function readH04Json(path: string): unknown {
  return JSON.parse(h01RawFile(path).toString());
}
export function checkH04Operation(request: H04Request, value: unknown): H04Operation {
  return checkH04BoundOperation(h04Binding(request), value);
}
export function checkH04BoundOperation(binding: H04OperationBinding, value: unknown): H04Operation {
  const v = object(value);
  exactFields(v, ['kind', 'operationId', 'inputHash', 'elapsedMs', 'logs']);
  requireContract(
    v.kind === 'h04-operation-result' &&
      v.operationId === binding.operationId &&
      v.inputHash === binding.inputHash,
    'h04-result-binding',
  );
  requireContract(
    typeof v.elapsedMs === 'number' && Number.isFinite(v.elapsedMs) && v.elapsedMs >= 35000,
    'h04-duration',
  );
  requireContract(Array.isArray(v.logs) && v.logs.length === 6, 'h04-six-logs');
  let previous = 0;
  v.logs.forEach((raw, i) => {
    const log = object(raw);
    exactFields(log, ['sequence', 'elapsedMs']);
    requireContract(
      log.sequence === i + 1 &&
        typeof log.elapsedMs === 'number' &&
        log.elapsedMs >= (i + 1) * 5000 &&
        log.elapsedMs > previous &&
        log.elapsedMs < Number(v.elapsedMs),
      'h04-log-order',
    );
    previous = log.elapsedMs;
  });
  return v as unknown as H04Operation;
}
export function inspectH04Primary(request: H04Request) {
  const root = request.outputRoot;
  requireContract(realpathSync(root) === root, 'h04-output-alias');
  readH04Pin(request.node);
  if (request.server !== null) readH04Pin(request.server);
  const pins = readH04Json(join(root, 'source-pins.json'));
  requireContract(Array.isArray(pins) && pins.length === h04SourcePaths.length, 'h04-source-pins');
  requireContract(
    isDeepStrictEqual(
      pins.map((p) => h04Pin(p).path),
      h04SourcePaths,
    ),
    'h04-source-paths',
  );
  pins.map(h04Pin).forEach(readH04Pin);
  const report = existsSync(join(root, 'worker.json'))
    ? object(readH04Json(join(root, 'worker.json')))
    : { status: 'missing', inputHash: h04InputHash(request) };
  requireContract(report.inputHash === h04InputHash(request), 'h04-report-binding');
  const stops = [
    readH04Json(join(root, 'stop.json')),
    existsSync(join(root, 'worker-stop.json'))
      ? readH04Json(join(root, 'worker-stop.json'))
      : { missing: true },
  ];
  const stopped = stops.every((raw) => {
    const stop = object(raw);
    return (
      stop.stopped === true &&
      stop.code === 0 &&
      stop.signal === null &&
      stop.deadlineReached === false &&
      stop.killed !== true
    );
  });
  if (report.status !== 'completed' || !stopped)
    return {
      outcome: 'UNKNOWN',
      qualification: false,
      modelFree: 'UNKNOWN' as const,
      reason: 'operation-or-stop-unconfirmed',
      checks: h04Checks.map((id) => ({ id, status: 'NOT_PROVEN' })),
    };
  const ref = controlRef(report.result);
  const path = join(root, 'artifacts', ref.sha256);
  const bytes = readH04Pin({ path, sha256: ref.sha256 });
  requireContract(bytes.length === ref.bytes, 'h04-result-size');
  const operation = checkH04Operation(request, JSON.parse(bytes.toString()));
  confirmH04Effect(request, 'run', ref);
  requireContract(
    isDeepStrictEqual(readH04Json(join(root, 'operation-start.json')), {
      operationId: request.operationId,
      inputHash: h04InputHash(request),
    }),
    'h04-start-binding',
  );
  for (const log of operation.logs)
    requireContract(
      isDeepStrictEqual(readH04Json(join(root, `log-${log.sequence}.json`)), log),
      'h04-log-binding',
    );
  requireContract(report.waitCalls === 1 && report.operationStarts === 1, 'h04-effect-count');
  if (request.variant === 'temporal') {
    const history = historyFromJSON(readH04Json(join(root, 'history.json')));
    const events = history.events!;
    const only = (type: number) => {
      const selected = events.filter((e) => e.eventType === type);
      requireContract(selected.length === 1, 'h04-history-count');
      return selected[0]!;
    };
    const started = only(1).workflowExecutionStartedEventAttributes!,
      scheduled = only(10),
      completed = only(12).activityTaskCompletedEventAttributes!,
      finished = only(2).workflowExecutionCompletedEventAttributes!;
    const workflow = object(readH04Json(join(root, 'workflow.json')));
    requireContract(
      workflow.workflowId === request.operationId &&
        typeof workflow.runId === 'string' &&
        workflow.runId.length > 0 &&
        started.originalExecutionRunId === workflow.runId &&
        started.workflowType?.name === 'ComparisonH04Workflow',
      'h04-workflow-binding',
    );
    const input = { operationId: request.operationId, inputHash: h04InputHash(request) };
    requireContract(
      isDeepStrictEqual(
        fromPayloadsAtIndex(defaultPayloadConverter, 0, started.input?.payloads),
        input,
      ),
      'h04-workflow-input',
    );
    const activity = scheduled.activityTaskScheduledEventAttributes!;
    requireContract(
      activity.activityType?.name === 'h04Operation' &&
        String(completed.scheduledEventId) === String(scheduled.eventId),
      'h04-activity-binding',
    );
    requireContract(
      isDeepStrictEqual(
        fromPayloadsAtIndex(defaultPayloadConverter, 0, activity.input?.payloads),
        input,
      ),
      'h04-activity-input',
    );
    for (const value of [completed.result, finished.result])
      requireContract(
        isDeepStrictEqual(fromPayloadsAtIndex(defaultPayloadConverter, 0, value?.payloads), ref),
        'h04-history-result',
      );
  } else {
    const waited = object(readH04Json(join(root, 'wait.json'))),
      snapshot = object(waited.snapshot);
    requireContract(
      waited.timed_out === false &&
        snapshot.status === 'completed' &&
        snapshot.run_id === request.operationId &&
        snapshot.target_hash === h04InputHash(request),
      'h04-wait-binding',
    );
  }
  return {
    outcome: 'UNKNOWN',
    qualification: false,
    modelFree: 'PENDING_APPLICATION' as const,
    reason: 'UNMET_PRIMARY_NATIVE_CURRENT_TURN_WAIT_PROOF',
    result: ref,
    checks: h04Checks.map((id) => ({ id, status: 'NOT_PROVEN' })),
  };
}

function confirmH04Effect(request: H04Request, stage: 'run' | 'apply', ref: ArtifactRef) {
  const directory = join(request.outputRoot, 'effects'),
    intent = h04Intent(request, stage);
  const snapshot = () =>
    readdirSync(directory)
      .sort()
      .map((name) => ({ name, sha256: digest(h01RawFile(join(directory, name))) }));
  const before = snapshot();
  const effect = lookupEffect(directory, intent);
  requireContract(effect.status === 'completed', 'h04-effect-unconfirmed');
  const key = digest(JSON.stringify([intent.projectId, intent.taskId, intent.operationId]));
  const strictReceipt = controlRef(readH04Json(join(directory, key + '.receipt')));
  // Phase observations bind the existing reader; this is not an atomic ABA guarantee.
  requireContract(
    isDeepStrictEqual(snapshot(), before) && isDeepStrictEqual(effect.receipt, strictReceipt),
    'h04-effect-changed',
  );
  requireContract(isDeepStrictEqual(effect.receipt, ref), 'h04-effect-result');
}
export function checkH04(request: H04Request) {
  const primary = inspectH04Primary(request);
  if (primary.modelFree === 'UNKNOWN') return primary;
  confirmH04Effect(request, 'apply', primary.result);
  requireContract(
    readdirSync(join(request.outputRoot, 'effects')).length === 4,
    'h04-extra-effect',
  );
  requireContract(
    isDeepStrictEqual(readH04Json(join(request.outputRoot, 'applied.json')), {
      operationId: request.operationId,
      result: primary.result,
    }),
    'h04-effect-binding',
  );
  return { ...primary, modelFree: 'PASS' as const };
}
