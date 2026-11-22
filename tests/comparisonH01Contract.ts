import type {
  ComparisonMaterial,
  ComparisonReceipt,
  ComparisonTiming,
} from '../core/comparison.js';
import type { ChatAnchor } from '../core/currentChat.js';
import type { InputRef } from '../core/localRun.js';
import type {
  ComparisonParticipant,
  NativeComparisonReceipt,
} from '../adapters/codex/comparisonUsage.js';
import type { NativeReaderIssuer } from '../src/adapters/codex/readerAuthority.js';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import process from 'node:process';
import { homedir } from 'node:os';
import { object, requireWorkflow, textField } from '../core/connection.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory, writePrivateFile } from '../adapters/storage/storeFiles.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';

export type H01Variant = 'baseline' | 'candidate';
export type NativeComparisonScenario = 'H-01' | 'H-02' | 'H-03' | 'H-04' | 'H-05';
export function comparisonLabel(scenario: NativeComparisonScenario) {
  const labels = {
    'H-01': 'h01',
    'H-02': 'h02',
    'H-03': 'h03',
    'H-04': 'h04',
    'H-05': 'h05',
  } as const;
  return labels[scenario];
}
export function comparisonEntrypoint(scenario: NativeComparisonScenario) {
  return scenario === 'H-01'
    ? 'tests/comparisonH01.ts'
    : scenario === 'H-02'
      ? 'tests/comparisonH02Native.ts'
      : scenario === 'H-03'
        ? 'tests/comparisonH03Native.ts'
        : scenario === 'H-04'
          ? 'tests/comparisonH04Native.ts'
          : 'tests/comparisonH05Native.ts';
}
export function comparisonKind<S extends string>(scenario: NativeComparisonScenario, suffix: S) {
  return `comparison-${comparisonLabel(scenario)}-${suffix}` as `comparison-${ReturnType<typeof comparisonLabel>}-${S}`;
}
export function requestScenario(request: { kind: unknown }): NativeComparisonScenario {
  requireWorkflow(
    [
      'comparison-h01-execution',
      'comparison-h02-execution',
      'comparison-h03-execution',
      'comparison-h04-execution',
      'comparison-h05-execution',
    ].includes(String(request.kind)),
    'comparison-scenario-kind',
  );
  return request.kind === 'comparison-h01-execution'
    ? 'H-01'
    : request.kind === 'comparison-h02-execution'
      ? 'H-02'
      : request.kind === 'comparison-h03-execution'
        ? 'H-03'
        : request.kind === 'comparison-h04-execution'
          ? 'H-04'
          : 'H-05';
}
export type H01Engine = 'legacy' | 'temporal';
export interface H01Budget {
  maxManagedStarts: number;
  maxElapsedMs: number;
  maxInputUncached: number;
  maxOutput: number;
  reserveMs: number;
}
export interface H01Roots {
  workspaceRoot: string;
  evidenceRoot: string;
  artifactRoot: string;
  hostRoot: string;
  stateRoot: string;
}
export interface H01Authorization {
  root: string;
  transcript: string;
  anchor: ChatAnchor;
  source: InputRef;
  requestHash: string;
}
export interface H01VerifiedAuthorization {
  kind:
    | 'comparison-h01-authorization-observation'
    | 'comparison-h02-authorization-observation'
    | 'comparison-h03-authorization-observation'
    | 'comparison-h04-authorization-observation'
    | 'comparison-h05-authorization-observation';
  executionVersion: 2;
  opId: string;
  requestHash: string;
  variant: H01Variant;
  budget: H01Budget;
  source: InputRef;
  transcript: string;
  context: {
    threadId: string;
    turnId: string;
    workspaceRoot: string;
    hostId: 'local';
    owner: string;
  };
  issuer?: NativeReaderIssuer;
}
export interface H01ExecutionRequest {
  kind:
    | 'comparison-h01-execution'
    | 'comparison-h02-execution'
    | 'comparison-h03-execution'
    | 'comparison-h04-execution'
    | 'comparison-h05-execution';
  executionVersion: 2;
  opId: string;
  variant: H01Variant;
  material: InputRef;
  criteria: InputRef;
  profile: InputRef;
  runtime: InputRef;
  bootstrap: InputRef;
  roots: H01Roots;
  identity: { taskId: string; owner: string; generation: number };
  budget: H01Budget;
  authorization: H01Authorization;
}
export interface H01NativeProfile {
  model: string;
  effort: string;
  clientVersion: string;
}
export interface H01Profile extends H01NativeProfile {
  binary: InputRef;
  rules: InputRef;
  executor: InputRef;
  reviewer: InputRef;
  disabledMcpServers?: string[];
}
export interface H01Runtime {
  engine: H01Engine;
  root: string;
  files: InputRef[];
}
export type H01Bootstrap =
  | {
      engine: 'legacy';
      runtimeRoot: string;
      modulesRoot: string;
      overlay: InputRef;
    }
  | {
      engine: 'temporal';
      address: string;
      namespace: string;
      taskQueue: string;
      workflowsPath: string;
      issuer: NativeReaderIssuer;
    };
export interface H01Criteria {
  id: NativeComparisonScenario;
  task: string;
  stimulus: string[];
  checks: string[];
}
export interface H01GuardDescriptor {
  kind:
    | 'comparison-h01-guard'
    | 'comparison-h02-guard'
    | 'comparison-h03-guard'
    | 'comparison-h04-guard'
    | 'comparison-h05-guard';
  executionVersion: 2;
  opId: string;
  requestHash: string;
  request: InputRef;
  variant: H01Variant;
  roots: H01Roots;
  budget: H01Budget;
  profile: H01NativeProfile;
  binary: InputRef;
  authorization: H01Authorization;
  pins: InputRef[];
  startedNs: string;
  deadlineNs: string;
  workDeadlineNs: string;
}
export interface H01ModelStart {
  method?: 'thread/compact/start';
  before?: InputRef;
  origin: 'legacy' | 'temporal-host' | 'common-council';
  key: string;
  hash: string;
  session: string;
  stage: ComparisonReceipt['stage'];
}
export interface H01StartConfirmation {
  key: string;
  session: string;
  turn: string;
  evidence: InputRef;
}
export interface NativeCompactionConfirmation {
  key: string;
  session: string;
  before: InputRef;
  boundary: InputRef;
  evidence: InputRef;
  through?: InputRef;
}
export type H01NativeObservation =
  | {
      kind: 'h01-native-dispatch';
      method: 'thread/start' | 'thread/resume' | 'thread/read';
      params: Record<string, unknown>;
      response: unknown;
    }
  | {
      kind: 'h01-native-dispatch';
      method: 'turn/start';
      start: H01ModelStart;
      params: Record<string, unknown>;
      response: unknown;
    };
export interface H01StopObservation {
  kind:
    | 'comparison-h01-stop'
    | 'comparison-h02-stop'
    | 'comparison-h03-stop'
    | 'comparison-h04-stop'
    | 'comparison-h05-stop';
  executionVersion: 2;
  opId: string;
  confirmed: boolean;
  sessions: string[];
  remainingProcesses: { pid: number; parent: number; started: string }[];
  evidence: InputRef[];
  reason?: string;
}
export interface H01NativeParticipant extends ComparisonParticipant {
  creation: InputRef;
  pathObservation?: InputRef;
}
export interface H01ThreadCreation {
  session: string;
  run: string;
  stage: ComparisonReceipt['stage'];
  creation: InputRef;
}
export interface H01Capabilities {
  session: string;
  evidence: InputRef;
  disabled: string[];
}
export interface H01ParticipantCompletion {
  outcome: 'completed' | 'failed' | 'unknown';
  stop: InputRef;
  evidence: InputRef[];
}
export interface H01NativeAccounting {
  participants: ComparisonParticipant[];
  receipts: NativeComparisonReceipt[];
  reservedManagedStarts: number | null;
  observedResponses: number | null;
  inputUncached: number | null;
  inputCached: number | null;
  output: number | null;
  unknown: boolean;
  evidence: InputRef[];
}
export interface H01NativeObserver {
  readonly controlRef: InputRef;
  assertRecoveryParticipant?(session: string, creation: InputRef, transcript: string): void;
  beforeModelStart(start: H01ModelStart): Promise<void>;
  confirmModelStart(confirmation: H01StartConfirmation): void;
  confirmCompaction?(confirmation: NativeCompactionConfirmation): void;
  registerCreation(creation: H01ThreadCreation): void;
  registerCapabilities(capabilities: H01Capabilities): void;
  registerParticipant(participant: H01NativeParticipant): void;
  observeParticipant(participant: ComparisonParticipant): void;
  completeParticipant(session: string, completion: H01ParticipantCompletion): void;
  verify(): Promise<void>;
  accounting(): H01NativeAccounting;
}
export const h01TaskPaths = {
  card: '.comparison/task.md',
  basis: '.comparison/accepted.md',
  rules: '.comparison/RULES.md',
  executor: '.comparison/executor.md',
  reviewer: '.comparison/reviewer.md',
} as const;
export interface H01AttemptContext {
  opId: string;
  requestHash: string;
  variant: H01Variant;
  material: { ref: InputRef; value: ComparisonMaterial };
  criteria: { ref: InputRef; value: H01Criteria };
  roots: H01Roots;
  identity: H01ExecutionRequest['identity'];
  profile: H01NativeProfile;
  disabledMcpServers?: string[];
  binary: InputRef;
  rules: InputRef;
  executor: InputRef;
  reviewer: InputRef;
  runtime: H01Runtime;
  bootstrap: H01Bootstrap;
  verifiedAuthorization: InputRef;
  budget: H01Budget;
  // One host process.hrtime.bigint() clock, including child processes.
  deadlineNs: string;
  workDeadlineNs: string;
  signal: AbortSignal;
  nativeObserver: H01NativeObserver;
}
export interface H01BackendResult {
  outcome: 'completed' | 'failed' | 'unknown';
  evidence: InputRef[];
  stop: InputRef;
  projection: InputRef;
  nativeAcceptance: InputRef | null;
  ready?: InputRef;
}
export interface H01BackendAdapter {
  execute(context: H01AttemptContext): Promise<H01BackendResult>;
}
export interface H01KeeperInput {
  entrypoint: InputRef;
  request: InputRef;
  controlRef: InputRef;
  evidenceRoot: string;
  deadlineNs: string;
  workDeadlineNs: string;
  opId: string;
}
export interface H01KeeperResult {
  outcome: 'completed' | 'failed' | 'unknown';
  stop: InputRef;
  report?: InputRef;
  evidence: InputRef[];
}
export interface H01ExecutionReport {
  kind:
    | 'comparison-h01-execution-report'
    | 'comparison-h02-execution-report'
    | 'comparison-h03-execution-report'
    | 'comparison-h04-execution-report'
    | 'comparison-h05-execution-report';
  executionVersion: 2;
  opId: string;
  requestHash: string;
  variant: H01Variant;
  outcome: 'accepted' | 'failed' | 'unknown';
  checks: Record<string, boolean>;
  evidence: InputRef[];
  stop: InputRef;
  nativeAcceptance: InputRef | null;
  accounting: H01NativeAccounting;
  timing: ComparisonTiming;
  elapsedMs: number | null;
  unproven: string[];
  partialScope: true;
  qualification: false;
}

const hashPattern = /^[a-f0-9]{64}$/u;
function fields(value: unknown, names: string[]) {
  const result = object(value);
  requireWorkflow(isDeepStrictEqual(Object.keys(result).sort(), names.sort()), 'h01-fields');
  return result;
}
function absolute(value: unknown) {
  const path = textField(value);
  requireWorkflow(isAbsolute(path) && resolve(path) === path && !/[\r\n]/u.test(path), 'h01-path');
  return path;
}
function positive(value: unknown) {
  requireWorkflow(Number.isSafeInteger(value) && Number(value) > 0, 'h01-limit');
  return Number(value);
}
function pin(value: unknown): InputRef {
  const ref = fields(value, ['locator', 'hash']);
  requireWorkflow(typeof ref.hash === 'string' && hashPattern.test(ref.hash), 'h01-hash');
  return { locator: absolute(ref.locator), hash: ref.hash };
}
export function parseH01Request(
  value: unknown,
  mode: 'plan' | 'run' = 'run',
  scenario: NativeComparisonScenario = 'H-01',
): H01ExecutionRequest {
  const request = fields(value, [
    'kind',
    'executionVersion',
    'opId',
    'variant',
    'material',
    'criteria',
    'profile',
    'runtime',
    'bootstrap',
    'roots',
    'identity',
    'budget',
    'authorization',
  ]);
  requireWorkflow(
    request.kind === comparisonKind(scenario, 'execution') && request.executionVersion === 2,
    'h01-version',
  );
  textField(request.opId);
  requireWorkflow(request.variant === 'baseline' || request.variant === 'candidate', 'h01-variant');
  for (const name of ['material', 'criteria', 'profile', 'runtime', 'bootstrap'])
    pin(request[name]);
  const roots = fields(request.roots, [
    'workspaceRoot',
    'evidenceRoot',
    'artifactRoot',
    'hostRoot',
    'stateRoot',
  ]);
  const paths = Object.values(roots).map(absolute);
  requireWorkflow(
    paths.every((path, i) =>
      paths.every((other, j) => i === j || (path !== other && !path.startsWith(other + sep))),
    ),
    'h01-roots-overlap',
  );
  const identity = fields(request.identity, ['taskId', 'owner', 'generation']);
  textField(identity.taskId);
  textField(identity.owner);
  positive(identity.generation);
  requireWorkflow(
    scenario !== 'H-05' || Number(identity.generation) >= 2,
    'h05-generation-required',
  );
  const budget = fields(request.budget, [
    'maxManagedStarts',
    'maxElapsedMs',
    'maxInputUncached',
    'maxOutput',
    'reserveMs',
  ]);
  Object.values(budget).forEach(positive);
  requireWorkflow(Number(budget.reserveMs) < Number(budget.maxElapsedMs), 'h01-reserve');
  const auth = fields(request.authorization, [
    'root',
    'transcript',
    'anchor',
    'source',
    'requestHash',
  ]);
  absolute(auth.root);
  absolute(auth.transcript);
  const anchor = fields(auth.anchor, ['thread_id', 'turn_id', 'workspace', 'host_id']);
  textField(anchor.thread_id);
  absolute(anchor.workspace);
  requireWorkflow(
    anchor.workspace === auth.root && anchor.host_id === 'local',
    'h01-authority-context',
  );
  if (mode === 'run') textField(anchor.turn_id);
  else requireWorkflow(typeof anchor.turn_id === 'string', 'h01-authority-context');
  const source = fields(auth.source, ['locator', 'hash']);
  if (!(mode === 'plan' && source.locator === '' && source.hash === '')) {
    requireWorkflow(
      typeof source.locator === 'string' &&
        source.locator.startsWith(String(auth.transcript) + '#L') &&
        /#L[1-9]\d*$/u.test(source.locator),
      'h01-authority-source',
    );
    requireWorkflow(typeof source.hash === 'string' && hashPattern.test(source.hash), 'h01-hash');
  }
  requireWorkflow(
    typeof auth.requestHash === 'string' &&
      ((mode === 'plan' && auth.requestHash === '') || hashPattern.test(auth.requestHash)),
    'h01-hash',
  );
  return request as unknown as H01ExecutionRequest;
}
export function h01RequestHash(request: H01ExecutionRequest): string {
  const { source: _source, requestHash: _hash, anchor, ...authority } = request.authorization;
  const { turn_id: _turn, ...stableAnchor } = anchor;
  return digest(
    canonical({
      ...request,
      authorization: { ...authority, anchor: stableAnchor },
    }),
  );
}
export function h01GrantText(request: H01ExecutionRequest): string {
  return canonical({
    kind: comparisonKind(requestScenario(request), 'grant'),
    executionVersion: 2,
    requestHash: h01RequestHash(request),
    opId: request.opId,
    variant: request.variant,
    budget: request.budget,
  });
}
export function h01RawFile(path: string): Buffer {
  absolute(path);
  requireWorkflow(
    safeDirectory(dirname(path)) === dirname(path) && realpathSync(path) === path,
    'h01-file-alias',
  );
  const version = (stat: ReturnType<typeof fstatSync>) => [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ];
  const before = lstatSync(path),
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    requireWorkflow(opened.isFile() && opened.nlink === 1, 'h01-file-kind');
    requireWorkflow(
      safeDirectory(dirname(path)) === dirname(path) &&
        isDeepStrictEqual(version(before), version(opened)) &&
        isDeepStrictEqual(version(lstatSync(path)), version(opened)),
      'h01-file-changed',
    );
    const bytes = readFileSync(fd),
      after = fstatSync(fd);
    requireWorkflow(
      safeDirectory(dirname(path)) === dirname(path) &&
        isDeepStrictEqual(version(opened), version(after)) &&
        isDeepStrictEqual(version(after), version(lstatSync(path))),
      'h01-file-changed',
    );
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function h01ReadPin(ref: InputRef): Buffer {
  pin(ref);
  const bytes = h01RawFile(ref.locator);
  requireWorkflow(digest(bytes) === ref.hash, 'h01-pin-changed');
  return bytes;
}
export function h01ReadJson(ref: InputRef): unknown {
  return JSON.parse(h01ReadPin(ref).toString('utf8')) as unknown;
}
export function h01Record(root: string, label: string, value: unknown): InputRef {
  requireWorkflow(/^[a-z0-9-]+$/u.test(label), 'h01-record-label');
  requireWorkflow(safeDirectory(root) === root, 'h01-file-alias');
  const bytes = Buffer.from(canonical(value) + '\n'),
    hash = digest(bytes),
    locator = resolve(root, `${label}-${hash}.json`);
  try {
    writePrivateFile(locator, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    requireWorkflow(h01RawFile(locator).equals(bytes), 'h01-record-changed');
  }
  return { locator, hash };
}
export function parseH01DisabledMcpServers(value: unknown): string[] {
  requireWorkflow(
    Array.isArray(value) &&
      value.every((name) => typeof name === 'string' && /^[a-zA-Z0-9_-]+$/u.test(name)) &&
      new Set(value).size === value.length,
    'h01-mcp-disabled-targets',
  );
  return value as string[];
}
export function parseH01Profile(ref: InputRef): H01Profile {
  const value = object(h01ReadJson(ref));
  const profile = fields(value, [
    'model',
    'effort',
    'clientVersion',
    'binary',
    'rules',
    'executor',
    'reviewer',
    ...(Object.hasOwn(value, 'disabledMcpServers') ? ['disabledMcpServers'] : []),
  ]);
  for (const name of ['model', 'effort', 'clientVersion']) textField(profile[name]);
  for (const name of ['binary', 'rules', 'executor', 'reviewer']) h01ReadPin(pin(profile[name]));
  if (Object.hasOwn(profile, 'disabledMcpServers'))
    parseH01DisabledMcpServers(profile.disabledMcpServers);
  return profile as unknown as H01Profile;
}
export function parseH01Runtime(ref: InputRef, variant: H01Variant): H01Runtime {
  const runtime = fields(h01ReadJson(ref), ['engine', 'root', 'files']);
  requireWorkflow(
    runtime.engine === (variant === 'baseline' ? 'legacy' : 'temporal'),
    'h01-engine',
  );
  const root = absolute(runtime.root);
  requireWorkflow(
    safeDirectory(root) === root && Array.isArray(runtime.files) && runtime.files.length > 0,
    'h01-runtime',
  );
  const refs = runtime.files.map(pin);
  requireWorkflow(
    new Set(refs.map((ref) => ref.locator)).size === refs.length &&
      refs.every((ref) => ref.locator.startsWith(root + sep)),
    'h01-runtime-path',
  );
  refs.forEach(h01ReadPin);
  return {
    engine: variant === 'baseline' ? 'legacy' : 'temporal',
    root,
    files: refs,
  };
}
export function parseH01Bootstrap(ref: InputRef, variant: H01Variant): H01Bootstrap {
  const value = object(h01ReadJson(ref));
  if (variant === 'baseline') {
    const input = fields(value, ['engine', 'runtimeRoot', 'modulesRoot', 'overlay']);
    requireWorkflow(input.engine === 'legacy', 'h01-engine');
    absolute(input.runtimeRoot);
    absolute(input.modulesRoot);
    pin(input.overlay);
    return input as unknown as H01Bootstrap;
  }
  const input = fields(value, [
    'engine',
    'address',
    'namespace',
    'taskQueue',
    'workflowsPath',
    'issuer',
  ]);
  requireWorkflow(input.engine === 'temporal', 'h01-engine');
  for (const name of ['address', 'namespace', 'taskQueue']) textField(input[name]);
  const address = String(input.address).match(
    /^(?:localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/u,
  );
  requireWorkflow(address !== null && Number(address[1]) <= 65535, 'h01-temporal-loopback');
  absolute(input.workflowsPath);
  const issuer = fields(input.issuer, ['sessionsRoot', 'workspaceRoot', 'threadId', 'owner']);
  absolute(issuer.sessionsRoot);
  absolute(issuer.workspaceRoot);
  textField(issuer.threadId);
  textField(issuer.owner);
  return input as unknown as H01Bootstrap;
}
async function primaryAuthorization(
  request: H01ExecutionRequest,
): Promise<H01VerifiedAuthorization> {
  parseH01Request(request, 'run', requestScenario(request));
  requireWorkflow(
    request.authorization.requestHash === h01RequestHash(request),
    'h01-authorization-binding',
  );
  const auth = request.authorization,
    host = new FileCurrentChatHost(auth.root, auth.transcript, auth.anchor, null, false, true);
  const sessionsRoot = resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'sessions');
  requireWorkflow(
    safeDirectory(sessionsRoot) === sessionsRoot &&
      realpathSync(auth.transcript).startsWith(sessionsRoot + sep),
    'h01-native-primary-source',
  );
  const observed = await host.observe();
  await host.message(auth.source, observed.turn_id);
  const match = auth.source.locator.match(/^(.*)#L([1-9]\d*)$/u)!;
  requireWorkflow(match[1] === auth.transcript, 'h01-authority-source');
  const bytes = h01RawFile(auth.transcript).toString('utf8');
  requireWorkflow(bytes.endsWith('\n'), 'h01-authority-partial');
  const line = bytes.slice(0, -1).split('\n')[Number(match[2]) - 1];
  requireWorkflow(
    line !== undefined && digest(line + '\n') === auth.source.hash,
    'h01-authority-line',
  );
  const record = object(JSON.parse(line)),
    payload = object(record.payload);
  requireWorkflow(
    record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content) &&
      payload.content.length === 1,
    'h01-authority-body',
  );
  const body = object(payload.content[0]);
  const expected = h01GrantText(request);
  requireWorkflow(
    body.type === 'input_text' && (body.text === expected || body.text === expected + '\n'),
    'h01-authority-body',
  );
  await host.message(auth.source, observed.turn_id);
  const result: H01VerifiedAuthorization = {
    kind: comparisonKind(requestScenario(request), 'authorization-observation'),
    executionVersion: 2,
    opId: request.opId,
    requestHash: h01RequestHash(request),
    variant: request.variant,
    budget: request.budget,
    source: auth.source,
    transcript: auth.transcript,
    context: {
      threadId: observed.thread_id,
      turnId: observed.turn_id,
      workspaceRoot: observed.workspace,
      hostId: observed.host_id,
      owner: request.identity.owner,
    },
  };
  if (request.variant === 'candidate') {
    const bootstrap = parseH01Bootstrap(request.bootstrap, request.variant);
    requireWorkflow(bootstrap.engine === 'temporal', 'h01-engine');
    const issuer = bootstrap.issuer;
    requireWorkflow(
      issuer.sessionsRoot === sessionsRoot &&
        safeDirectory(issuer.sessionsRoot) === issuer.sessionsRoot &&
        realpathSync(auth.transcript).startsWith(issuer.sessionsRoot + sep) &&
        issuer.threadId === observed.thread_id &&
        issuer.workspaceRoot === observed.workspace &&
        issuer.owner === request.identity.owner,
      'h01-issuer-binding',
    );
    result.issuer = issuer;
  }
  return result;
}
export async function observeH01Authorization(
  request: H01ExecutionRequest,
): Promise<H01VerifiedAuthorization> {
  const result = await primaryAuthorization(request);
  requireWorkflow(process.env.CODEX_THREAD_ID === result.context.threadId, 'h01-root-thread');
  return result;
}
export async function verifyH01Authorization(request: H01ExecutionRequest): Promise<InputRef> {
  return h01Record(
    request.roots.evidenceRoot,
    'authorization',
    await observeH01Authorization(request),
  );
}
export async function verifyH01GuardAuthorization(descriptor: H01GuardDescriptor): Promise<void> {
  const request = parseH01Request(
    h01ReadJson(descriptor.request),
    'run',
    descriptor.kind === 'comparison-h01-guard'
      ? 'H-01'
      : descriptor.kind === 'comparison-h02-guard'
        ? 'H-02'
        : descriptor.kind === 'comparison-h03-guard'
          ? 'H-03'
          : descriptor.kind === 'comparison-h04-guard'
            ? 'H-04'
            : 'H-05',
  );
  requireWorkflow(
    h01RequestHash(request) === descriptor.requestHash &&
      request.opId === descriptor.opId &&
      request.variant === descriptor.variant &&
      isDeepStrictEqual(request.roots, descriptor.roots) &&
      isDeepStrictEqual(request.budget, descriptor.budget) &&
      isDeepStrictEqual(request.authorization, descriptor.authorization),
    'h01-guard-binding',
  );
  const profile = parseH01Profile(request.profile);
  requireWorkflow(
    isDeepStrictEqual(descriptor.profile, {
      model: profile.model,
      effort: profile.effort,
      clientVersion: profile.clientVersion,
    }) && isDeepStrictEqual(profile.binary, descriptor.binary),
    'h01-guard-profile',
  );
  descriptor.pins.forEach(h01ReadPin);
  await primaryAuthorization(request);
}
export function parseH01GuardDescriptor(
  ref: InputRef,
  scenario: NativeComparisonScenario = 'H-01',
): H01GuardDescriptor {
  const value = fields(h01ReadJson(ref), [
    'kind',
    'executionVersion',
    'opId',
    'requestHash',
    'request',
    'variant',
    'roots',
    'budget',
    'profile',
    'binary',
    'authorization',
    'pins',
    'startedNs',
    'deadlineNs',
    'workDeadlineNs',
  ]);
  requireWorkflow(
    value.kind === comparisonKind(scenario, 'guard') && value.executionVersion === 2,
    'h01-guard-version',
  );
  const request = parseH01Request(h01ReadJson(pin(value.request)), 'run', scenario);
  requireWorkflow(
    value.opId === request.opId &&
      value.requestHash === h01RequestHash(request) &&
      value.variant === request.variant &&
      isDeepStrictEqual(value.roots, request.roots) &&
      isDeepStrictEqual(value.budget, request.budget) &&
      isDeepStrictEqual(value.authorization, request.authorization),
    'h01-guard-binding',
  );
  const profile = fields(value.profile, ['model', 'effort', 'clientVersion']);
  Object.values(profile).forEach(textField);
  pin(value.binary);
  requireWorkflow(Array.isArray(value.pins) && value.pins.length > 0, 'h01-guard-pins');
  value.pins.forEach(pin);
  for (const key of ['startedNs', 'deadlineNs', 'workDeadlineNs'])
    requireWorkflow(typeof value[key] === 'string' && /^\d{1,30}$/u.test(value[key]), 'h01-clock');
  const started = BigInt(String(value.startedNs)),
    deadline = BigInt(String(value.deadlineNs)),
    work = BigInt(String(value.workDeadlineNs));
  requireWorkflow(
    deadline - started === BigInt(request.budget.maxElapsedMs) * 1000000n &&
      deadline - work === BigInt(request.budget.reserveMs) * 1000000n,
    'h01-clock',
  );
  return value as unknown as H01GuardDescriptor;
}
