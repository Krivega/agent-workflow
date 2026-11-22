import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  observeH06NativeFailure,
  validateH06NativeFailureBinding,
  type H06NativeFailureBinding,
} from './comparisonH06NativeFailure.js';

function absolutePath(value: unknown) {
  return h04Pin({ path: value, sha256: '0'.repeat(64) }).path;
}

function overlaps(a: string, b: string) {
  return a === b || a.startsWith(join(b, sep)) || b.startsWith(join(a, sep));
}

function positive(value: unknown): number {
  requireContract(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    'h06-native-attempt-budget',
  );
  return value;
}

export function readH06NativeRequestSchema(value: unknown) {
  const input = object(value);
  exactFields(input, [
    'kind',
    'binding',
    'evidenceRoot',
    'chat',
    'budget',
    'stimulus',
    'appServer',
    'server',
    'bootstrap',
    'runtime',
  ]);
  requireContract(input.kind === 'comparison-h06-native/2', 'h06-native-attempt-kind');

  const f01 = object(input.binding);
  exactFields(f01, ['operationId', 'variant', 'workspaceRoot', 'node', 'timeoutMs']);
  requireContract(
    f01.variant === 'legacy' || f01.variant === 'temporal',
    'h06-native-attempt-variant',
  );
  const binding: H06NativeFailureBinding = {
    operationId: identifier(f01.operationId),
    variant: f01.variant,
    workspaceRoot: safeDirectory(absolutePath(f01.workspaceRoot)),
    node: h04Pin(f01.node),
    timeoutMs: positive(f01.timeoutMs),
  };
  validateH06NativeFailureBinding(binding);

  const evidenceRoot = absolutePath(input.evidenceRoot);
  safeDirectory(dirname(evidenceRoot));
  requireContract(
    evidenceRoot === join(dirname(evidenceRoot), binding.operationId) &&
      !overlaps(evidenceRoot, binding.workspaceRoot),
    'h06-native-attempt-roots',
  );
  const chatInput = object(input.chat);
  exactFields(chatInput, ['threadId', 'workspace']);
  const chat = {
    threadId: identifier(chatInput.threadId),
    workspace: safeDirectory(absolutePath(chatInput.workspace)),
  };
  requireContract(
    !overlaps(chat.workspace, binding.workspaceRoot) && !overlaps(chat.workspace, evidenceRoot),
    'h06-native-attempt-roots',
  );

  const caps = object(input.budget);
  exactFields(caps, [
    'maxElapsedMs',
    'reserveMs',
    'maxManagedStarts',
    'maxInputUncached',
    'maxOutput',
  ]);
  const budget = {
    maxElapsedMs: positive(caps.maxElapsedMs),
    reserveMs: positive(caps.reserveMs),
    maxManagedStarts: positive(caps.maxManagedStarts),
    maxInputUncached: positive(caps.maxInputUncached),
    maxOutput: positive(caps.maxOutput),
  };
  requireContract(budget.maxElapsedMs < 2 ** 31, 'h06-native-attempt-budget');
  const timing = object(input.stimulus);
  exactFields(timing, ['longStageMs', 'initialLeaseMs']);
  const longStageMs = positive(timing.longStageMs);
  const initialLeaseMs = timing.initialLeaseMs === null ? null : positive(timing.initialLeaseMs);
  requireContract(
    binding.timeoutMs + longStageMs < budget.maxElapsedMs - budget.reserveMs,
    'h06-native-attempt-budget',
  );
  requireContract(
    binding.variant === 'legacy'
      ? initialLeaseMs !== null &&
          binding.timeoutMs < initialLeaseMs &&
          initialLeaseMs < longStageMs &&
          initialLeaseMs <= 60000
      : initialLeaseMs === null,
    'h06-native-attempt-stimulus',
  );
  const stimulus = { longStageMs, initialLeaseMs };

  const appServer = h04Pin(input.appServer);
  const server = input.server === null ? null : h04Pin(input.server);
  const bootstrap = h04Pin(input.bootstrap);
  requireContract(
    (server !== null) === (binding.variant === 'temporal'),
    'h06-native-attempt-server',
  );
  requireContract(
    Array.isArray(input.runtime) && input.runtime.length > 0,
    'h06-native-attempt-runtime',
  );
  const runtime = input.runtime.map(h04Pin);
  const pins = [
    binding.node,
    appServer,
    bootstrap,
    ...runtime,
    ...(server === null ? [] : [server]),
  ];
  requireContract(
    new Set(pins.map((pin) => pin.path)).size === pins.length &&
      pins.every(
        (pin) => !overlaps(evidenceRoot, pin.path) && !overlaps(binding.workspaceRoot, pin.path),
      ),
    'h06-native-attempt-pins',
  );
  return {
    kind: 'comparison-h06-native/2',
    binding,
    evidenceRoot,
    chat,
    budget,
    stimulus,
    appServer,
    server,
    bootstrap,
    runtime,
  } as const;
}

export function readH06NativeRequestBinding(value: unknown) {
  const request = readH06NativeRequestSchema(value);
  const pins = [
    request.binding.node,
    request.appServer,
    request.bootstrap,
    ...request.runtime,
    ...(request.server === null ? [] : [request.server]),
    ...Object.values(h06Assets()),
  ];
  for (const pin of pins) readH04Pin(pin);
  return request;
}

export function readH06NativeRequest(value: unknown) {
  const request = readH06NativeRequestBinding(value);
  observeH06NativeFailure(request.binding.workspaceRoot);
  return request;
}

function fresh(evidenceRoot: string) {
  requireContract(
    lstatSync(evidenceRoot, { throwIfNoEntry: false }) === undefined,
    'h06-native-attempt-not-fresh',
  );
}

/** Read-only proposal. The exact grant is tied to the reviewed bytes, roots and limits. */
export function planH06NativeAttempt(value: unknown) {
  const request = readH06NativeRequest(value);
  fresh(request.evidenceRoot);
  const assets = h06Assets();
  const requestHash = digest(canonical({ request, assets }));
  const expectedGrantText = canonical({
    kind: 'comparison-h06-native-grant/2',
    operationId: request.binding.operationId,
    variant: request.binding.variant,
    requestHash,
    budget: request.budget,
  });
  return {
    request,
    assets,
    requestHash,
    expectedGrantText,
    mayRun: false,
    qualification: false,
  } as const;
}

export function h06NativeSessionsRoot() {
  return safeDirectory(resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'));
}
