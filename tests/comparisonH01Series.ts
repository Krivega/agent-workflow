import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  readPrivateFile,
  safeDirectory,
  syncDirectory,
  writePrivateFile,
} from '../adapters/storage/storeFiles.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import { parseComparisonMaterials, parseComparisonSuite } from '../core/comparison.js';
import type { InputRef } from '../core/localRun.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { checkComparisonReadiness } from './comparisonReadiness.js';
import { planH01, verifyH01Runtime } from './comparisonH01.js';
import { planH01Operator, runH01Operator } from './comparisonH01Operator.js';
import { parseH01OperatorSpec } from './comparisonH01Preparation.js';
import {
  h01ReadJson,
  h01ReadPin,
  h01RequestHash,
  parseH01Profile,
  parseH01Request,
  parseH01Runtime,
} from './comparisonH01Contract.js';
import {
  normalizeH01SeriesEvidence,
  type H01SeriesEvidenceInput,
} from './comparisonH01SeriesEvidence.js';
import {
  normalizeH06SeriesEvidence,
  planH06Operator,
  readH06OperatorBinding,
  runH06Operator,
} from './comparisonH06Operator.js';
import { h06Assets, h06Checks } from './comparisonH06Contract.js';
import { readH04Pin } from './comparisonH04Contract.js';

const limits = [
  'maxElapsedMs',
  'reserveMs',
  'maxManagedStarts',
  'maxInputUncached',
  'maxOutput',
] as const;
const rootNames = [
  'workspaceRoot',
  'stateRoot',
  'evidenceRoot',
  'artifactRoot',
  'hostRoot',
] as const;
const scenarios = ['H-01', 'H-02', 'H-03', 'H-04', 'H-05', 'H-06'] as const;
const versions = [1, 2, 3, 4, 5, 6] as const;
type Scenario = (typeof scenarios)[number];
type SeriesVersion = (typeof versions)[number];
type Cap = Record<(typeof limits)[number], number>;
type Step = { runId: string; spec: InputRef; request: InputRef };
type Evidence = ReturnType<typeof normalizeH01SeriesEvidence>;
type ReconciledEvidence = ReturnType<typeof normalizeH06SeriesEvidence>;
type Clock = { observedAtMs: number; observedNs: string; elapsedMs: number };
const budgetMetrics = [
  ['maxManagedStarts', 'reservedManagedStarts'],
  ['maxInputUncached', 'inputUncached'],
  ['maxOutput', 'output'],
] as const;
const accountingMetrics = [
  'reservedManagedStarts',
  'observedResponses',
  'inputUncached',
  'inputCached',
  'output',
] as const;
interface RecordEntry {
  runId: string;
  opId: string;
  requestHash: string;
  command: InputRef;
  request: InputRef;
  operator: unknown;
  evidence: Evidence;
  blocked: string[];
  startedAtMs: number;
  endedAtMs: number;
  startedNs: string;
  endedNs: string;
  elapsedMs: number;
}
interface State {
  kind: 'comparison-h01-series-state';
  schemaVersion: SeriesVersion;
  manifest: InputRef;
  schedule: ReturnType<typeof checkComparisonReadiness>['schedule'];
  startedAtMs: number;
  observedAtMs: number;
  observedNs: string;
  elapsedMs: number;
  records: RecordEntry[];
  pending: null | {
    runId: string;
    opId: string;
    requestHash: string;
    command: InputRef;
    request: InputRef;
    startedAtMs: number;
  };
  blocked: string[];
  partialScope: true;
  qualification: false;
}
function fields(value: unknown, names: readonly string[]) {
  const v = object(value);
  requireWorkflow(
    canonical(Object.keys(v).sort()) === canonical([...names].sort()),
    'series-step-fields',
  );
  return v;
}
function absolute(value: unknown) {
  const path = textField(value);
  requireWorkflow(
    isAbsolute(path) && resolve(path) === path && !/[\r\n]/u.test(path),
    'series-step-path',
  );
  return path;
}
function ref(value: unknown): InputRef {
  const v = fields(value, ['locator', 'hash']);
  requireWorkflow(typeof v.hash === 'string' && /^[a-f0-9]{64}$/u.test(v.hash), 'series-step-hash');
  return { locator: absolute(v.locator), hash: v.hash };
}
function fileRef(path: string): InputRef {
  return { locator: path, hash: digest(readPrivateFile(path)) };
}
function integer(value: unknown) {
  requireWorkflow(Number.isSafeInteger(value) && Number(value) > 0, 'series-step-limit');
  return Number(value);
}
function overlaps(a: string, b: string) {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function seriesVersion(value: unknown): value is SeriesVersion {
  return (versions as readonly unknown[]).includes(value);
}
function seriesSchedule(
  schedule: ReturnType<typeof checkComparisonReadiness>['schedule'],
  version: SeriesVersion,
) {
  if (version !== 6) return schedule;
  const assets = h06Assets();
  const suite = parseComparisonSuite(JSON.parse(readH04Pin(assets.suite).toString('utf8')));
  const material = parseComparisonMaterials(
    JSON.parse(readH04Pin(assets.materials).toString('utf8')),
    suite,
  ).find((row) => row.id === 'H-06')!;
  const materialHash = digest(canonical(material));
  return schedule.map((row) =>
    row.scenario === 'H-06' ? { ...row, material_hash: materialHash } : row,
  );
}
function readStepHash(step: Step & { scenario: Scenario }, request: InputRef) {
  return step.scenario === 'H-06'
    ? readH06OperatorBinding(step.spec, request, 'run').requestHash
    : h01RequestHash(parseH01Request(h01ReadJson(request), 'run', step.scenario));
}
function normalizeStep(input: H01SeriesEvidenceInput, scenario: Scenario): Evidence {
  return scenario === 'H-06'
    ? normalizeH06SeriesEvidence(input)
    : normalizeH01SeriesEvidence(input, scenario);
}
function boundStepTiming(
  evidence: Evidence,
  scenario: Scenario,
  startedNs: string,
  endedNs: string,
): Evidence {
  if (
    scenario !== 'H-06' ||
    (evidence.startedNs !== null &&
      evidence.endedNs !== null &&
      BigInt(evidence.startedNs) >= BigInt(startedNs) &&
      BigInt(evidence.endedNs) >= BigInt(evidence.startedNs) &&
      BigInt(evidence.endedNs) <= BigInt(endedNs))
  )
    return evidence;
  return {
    ...evidence,
    outcome: 'unknown',
    blocking: [...evidence.blocking, 'series-step-operator-clock'],
  };
}
function loadManifest(manifestRef: InputRef) {
  const input = fields(h01ReadJson(manifestRef), [
    'kind',
    'schemaVersion',
    'readiness',
    'outputRoot',
    'startedAtMs',
    'cap',
    'steps',
  ]);
  requireWorkflow(
    input.kind === 'comparison-h01-series' && seriesVersion(input.schemaVersion),
    'series-step-version',
  );
  const readinessRef = ref(input.readiness),
    readinessInput = object(h01ReadJson(readinessRef));
  requireWorkflow(readinessInput.schema_version === 2, 'series-step-source-readiness-required');
  const readiness = checkComparisonReadiness(readinessInput),
    outputRoot = absolute(input.outputRoot);
  safeDirectory(dirname(outputRoot));
  const capInput = fields(input.cap, limits),
    cap = Object.fromEntries(limits.map((name) => [name, integer(capInput[name])])) as Cap;
  requireWorkflow(cap.reserveMs < cap.maxElapsedMs, 'series-step-reserve');
  requireWorkflow(cap.maxElapsedMs <= 2_147_483_647, 'series-step-limit');
  const startedAtMs = integer(input.startedAtMs);
  requireWorkflow(startedAtMs <= Date.now(), 'series-step-clock');
  requireWorkflow(Array.isArray(input.steps), 'series-step-list');
  const steps: Step[] = input.steps.map((raw: unknown) => {
    const row = fields(raw, ['runId', 'spec', 'request']);
    return { runId: textField(row.runId), spec: ref(row.spec), request: ref(row.request) };
  });
  const schemaVersion = input.schemaVersion;
  const enabled: readonly string[] = scenarios.slice(0, schemaVersion);
  const schedule = seriesSchedule(readiness.schedule, schemaVersion);
  const slots = schedule.filter((run) => enabled.includes(run.scenario));
  requireWorkflow(
    same(
      steps.map((row) => row.runId),
      slots.map((run) => run.id),
    ),
    'series-step-order',
  );
  const pins: InputRef[] = [manifestRef, readinessRef],
    roots: string[] = [outputRoot],
    h06WritePaths: string[] = [],
    h06ChatRoots: string[] = [],
    h06Stimuli = new Set<number>(),
    operations = new Set<string>();
  const prepared = steps.map((step, index) => {
    const slot = slots[index]!;
    const scenario = slot.scenario as Scenario,
      variant = slot.variant,
      source = object(object(readinessInput.variants)[variant]),
      profile = object(source.profile);
    const loaded =
      scenario === 'H-06'
        ? { scenario, binding: readH06OperatorBinding(step.spec, step.request, 'plan') }
        : {
            scenario,
            parsed: parseH01Request(h01ReadJson(step.request), 'plan', scenario),
            spec: parseH01OperatorSpec(h01ReadJson(step.spec), scenario),
          };
    const request = loaded.scenario === 'H-06' ? loaded.binding : loaded.parsed;
    const actualProfile = parseH01Profile(request.profile),
      runtime = parseH01Runtime(request.runtime, variant);
    requireWorkflow(
      request.variant === variant &&
        (loaded.scenario === 'H-06' ||
          (loaded.spec.variant === variant && loaded.spec.opId === request.opId)),
      'series-step-slot-binding',
    );
    requireWorkflow(!operations.has(request.opId), 'series-step-op-conflict');
    operations.add(request.opId);
    const common = parseH01Runtime(readiness.variants[variant].runtime.artifact, variant);
    requireWorkflow(
      runtime.root === common.root &&
        same(
          [...runtime.files].sort((a, b) => a.locator.localeCompare(b.locator)),
          (loaded.scenario === 'H-06' ? [...common.files] : [...common.files, step.spec]).sort(
            (a, b) => a.locator.localeCompare(b.locator),
          ),
        ),
      'series-step-runtime-binding',
    );
    requireWorkflow(
      ['model', 'effort', 'clientVersion'].every(
        (key) => profile[key] === actualProfile[key as 'model' | 'effort' | 'clientVersion'],
      ) &&
        same(profile.client, actualProfile.binary) &&
        same(profile.rules, actualProfile.rules),
      'series-step-profile-binding',
    );
    pins.push(
      step.spec,
      step.request,
      request.material,
      request.criteria,
      request.profile,
      request.runtime,
      request.bootstrap,
      actualProfile.binary,
      actualProfile.rules,
      actualProfile.executor,
      actualProfile.reviewer,
      ...runtime.files,
      readiness.variants[variant].runtime.artifact,
    );
    const preparedStep = {
      ...step,
      opId: request.opId,
      budget: request.budget,
      actualProfile,
      variant,
    };
    if (loaded.scenario === 'H-06') {
      const { binding } = loaded;
      requireWorkflow(
        !overlaps(outputRoot, runtime.root) &&
          binding.roots.every((root) => !overlaps(root, runtime.root)),
        'series-step-output-overlap',
      );
      h06Stimuli.add(binding.longStageMs);
      h06WritePaths.push(
        ...binding.roots.filter((root) => root !== binding.packetRoot),
        ...binding.packetPaths,
      );
      h06ChatRoots.push(binding.chatRoot);
      roots.push(...binding.roots);
      pins.push(...binding.pins);
      return { ...preparedStep, scenario: 'H-06' as const, requestHash: binding.requestHash };
    }
    const { scenario: legacyScenario, parsed, spec } = loaded;
    const base = dirname(spec.evidenceRoot);
    requireWorkflow(
      !overlaps(outputRoot, runtime.root) && !overlaps(base, runtime.root),
      'series-step-output-overlap',
    );
    requireWorkflow(
      rootNames.every((name) => parsed.roots[name].startsWith(base + sep)),
      'series-step-root-binding',
    );
    roots.push(base);
    pins.push(spec.node);
    if (spec.temporal !== undefined) pins.push(spec.temporal.binary);
    planH01(parsed, legacyScenario);
    return {
      ...preparedStep,
      scenario: legacyScenario,
      requestHash: h01RequestHash(parsed),
      parsed,
    };
  });
  requireWorkflow(
    prepared.every((step) => same(step.actualProfile, prepared[0]!.actualProfile)),
    'series-step-role-profile-mismatch',
  );
  requireWorkflow(h06Stimuli.size <= 1, 'series-step-stimulus-mismatch');
  requireWorkflow(
    roots.every((path, i) => roots.every((other, j) => i === j || !overlaps(path, other))),
    'series-step-roots-overlap',
  );
  const snapshots = object(object(readinessInput.sourceSnapshot).roots);
  requireWorkflow(
    Object.values(snapshots).every((path) =>
      roots.every((base) => !overlaps(base, textField(path))),
    ) &&
      pins.every((pin) => !overlaps(outputRoot, pin.locator)) &&
      h06WritePaths.every((root) => pins.every((pin) => !overlaps(root, pin.locator))) &&
      h06ChatRoots.every((chat) => roots.every((root) => !overlaps(root, chat))),
    'series-step-output-overlap',
  );
  for (const key of ['maxManagedStarts', 'maxInputUncached', 'maxOutput'] as const)
    requireWorkflow(
      prepared.reduce((n, step) => n + step.budget[key], 0) <= cap[key],
      'series-step-cap-insufficient',
    );
  requireWorkflow(
    prepared.reduce((n, step) => n + step.budget.maxElapsedMs, 0) + cap.reserveMs <=
      cap.maxElapsedMs,
    'series-step-cap-insufficient',
  );
  const uniquePins = [
    ...new Map(pins.map((pin) => [canonical([pin.locator, pin.hash]), pin])).values(),
  ];
  const verify = () => uniquePins.forEach(h01ReadPin);
  verify();
  return { readiness, schedule, prepared, outputRoot, cap, startedAtMs, schemaVersion, verify };
}

/** Reads the versioned immutable schedule prefix; it issues no grant and never invokes the operator. */
export async function planH01Series(manifestRef: InputRef, completed: readonly string[] = []) {
  const value = loadManifest(ref(manifestRef)),
    verified = new Set<string>();
  for (const step of value.prepared) {
    if (step.scenario === 'H-06') {
      if (!completed.includes(step.runId)) planH06Operator(step.spec, step.request);
      value.verify();
      continue;
    }
    if (!completed.includes(step.runId)) planH01Operator(step.spec, step.request, step.scenario);
    const runtimeHash =
      step.scenario + ':' + value.readiness.variants[step.parsed.variant].runtime.artifact.hash;
    if (!verified.has(runtimeHash)) {
      await verifyH01Runtime(step.parsed);
      verified.add(runtimeHash);
    }
    value.verify();
  }
  return {
    kind: 'comparison-h01-series-plan',
    schemaVersion: value.schemaVersion,
    manifest: manifestRef,
    schedule: value.schedule,
    executable: value.prepared.map(({ runId, requestHash }) => ({ runId, requestHash })),
    cap: value.cap,
    startedAtMs: value.startedAtMs,
    partialScope: true,
    qualification: false,
    mayRun: false,
    allowedModelStarts: 0,
  };
}
function readState(path: string): State {
  const state = fields(JSON.parse(readPrivateFile(path).toString()), [
    'kind',
    'schemaVersion',
    'manifest',
    'schedule',
    'startedAtMs',
    'observedAtMs',
    'observedNs',
    'elapsedMs',
    'records',
    'pending',
    'blocked',
    'partialScope',
    'qualification',
  ]);
  requireWorkflow(
    state.kind === 'comparison-h01-series-state' &&
      seriesVersion(state.schemaVersion) &&
      state.partialScope === true &&
      state.qualification === false &&
      Array.isArray(state.records) &&
      Array.isArray(state.blocked),
    'series-step-state-version',
  );
  ref(state.manifest);
  integer(state.startedAtMs);
  integer(state.observedAtMs);
  requireWorkflow(
    typeof state.observedNs === 'string' &&
      /^\d+$/u.test(state.observedNs) &&
      Number.isFinite(state.elapsedMs) &&
      Number(state.elapsedMs) >= 0,
    'series-step-state-clock',
  );
  requireWorkflow(
    state.records.length <= state.schemaVersion * 4 &&
      state.blocked.every((reason: unknown) => typeof reason === 'string'),
    'series-step-state-version',
  );
  for (const raw of state.records) {
    const row = fields(raw, [
      'runId',
      'opId',
      'requestHash',
      'command',
      'request',
      'operator',
      'evidence',
      'blocked',
      'startedAtMs',
      'endedAtMs',
      'startedNs',
      'endedNs',
      'elapsedMs',
    ]);
    textField(row.runId);
    textField(row.opId);
    textField(row.requestHash);
    ref(row.command);
    ref(row.request);
    integer(row.startedAtMs);
    integer(row.endedAtMs);
    requireWorkflow(
      Array.isArray(row.blocked) &&
        row.blocked.every((reason: unknown) => typeof reason === 'string'),
      'series-step-state-version',
    );
  }
  if (state.pending !== null) {
    const row = fields(state.pending, [
      'runId',
      'opId',
      'requestHash',
      'command',
      'request',
      'startedAtMs',
    ]);
    textField(row.runId);
    textField(row.opId);
    textField(row.requestHash);
    ref(row.command);
    ref(row.request);
    integer(row.startedAtMs);
  }
  return state as unknown as State;
}
function completeAccounting(evidence: Evidence) {
  return (
    !evidence.accounting.unknown &&
    accountingMetrics.every(
      (metric) =>
        Number.isSafeInteger(evidence.accounting[metric]) &&
        Number(evidence.accounting[metric]) >= 0,
    )
  );
}
function accepted(evidence: Evidence) {
  return (
    evidence.outcome === 'accepted' &&
    evidence.stopped &&
    evidence.blocking.length === 0 &&
    completeAccounting(evidence)
  );
}
function seriesClock(anchor: Clock, wall = Date.now(), ns = process.hrtime.bigint()) {
  const delta = Number(ns - BigInt(anchor.observedNs)) / 1e6,
    wallDelta = wall - anchor.observedAtMs;
  requireWorkflow(
    delta >= 0 && wallDelta >= 0 && Math.abs(delta - wallDelta) <= 1000,
    'series-step-clock',
  );
  return { wall, ns, elapsedMs: anchor.elapsedMs + Math.max(delta, wallDelta) };
}
function endOfRecord(record: RecordEntry): Clock {
  return {
    observedAtMs: record.endedAtMs,
    observedNs: record.endedNs,
    elapsedMs: record.elapsedMs,
  };
}
function evidenceInput(record: RecordEntry, spec: InputRef): H01SeriesEvidenceInput {
  return {
    runId: record.runId,
    opId: record.opId,
    request: record.request,
    spec,
    operator: record.operator,
    command: record.command,
  };
}
function readReconciliationCommand(commandRef: InputRef) {
  const command = fields(h01ReadJson(commandRef), [
    'kind',
    'schemaVersion',
    'manifest',
    'runId',
    'previousState',
    'record',
    'settlement',
  ]);
  requireWorkflow(
    command.kind === 'comparison-h01-series-reconcile' && command.schemaVersion === 6,
    'series-reconciliation-version',
  );
  return {
    manifest: ref(command.manifest),
    runId: textField(command.runId),
    previousState: ref(command.previousState),
    record: ref(command.record),
    settlement: ref(command.settlement),
  };
}
function readReconciliationReceipt(receipt: InputRef) {
  const value = fields(h01ReadJson(receipt), [
    'kind',
    'schemaVersion',
    'command',
    'evidence',
    'observedAtMs',
    'observedNs',
    'elapsedMs',
  ]);
  requireWorkflow(
    value.kind === 'comparison-h01-series-reconciliation' &&
      value.schemaVersion === 6 &&
      typeof value.observedNs === 'string' &&
      /^\d+$/u.test(value.observedNs) &&
      typeof value.elapsedMs === 'number',
    'series-reconciliation-receipt',
  );
  return {
    command: ref(value.command),
    evidence: value.evidence,
    observedAtMs: integer(value.observedAtMs),
    observedNs: value.observedNs,
    elapsedMs: value.elapsedMs,
  };
}
const resolvableBlockers = new Set([
  'h06-series-whole-attempt-accounting-unknown',
  'h06-series-effective-participants-unconfirmed',
  'series-step-outcome-unconfirmed',
  'series-step-budget-cap',
]);
function reconcileEvidence(
  planned: Step & { scenario: Scenario },
  record: RecordEntry,
  settlement: InputRef,
  precedingEnd: number,
  observedAtMs: number,
  previousTurns: ReadonlySet<string>,
): ReconciledEvidence {
  const original = record.evidence;
  requireWorkflow(
    planned.scenario === 'H-06' &&
      original.outcome === 'unknown' &&
      record.blocked.every((reason) => resolvableBlockers.has(reason)),
    'series-reconciliation-original',
  );
  const updated = normalizeH06SeriesEvidence(evidenceInput(record, planned.spec), settlement);
  requireWorkflow(
    (accepted(updated) ||
      (updated.outcome === 'failed' &&
        updated.stopped &&
        completeAccounting(updated) &&
        same(updated.blocking, ['h06-series-whole-attempt-budget-exceeded']))) &&
      updated.startedNs === original.startedNs &&
      updated.endedNs === original.endedNs &&
      updated.operatorElapsedMs === original.operatorElapsedMs &&
      same(updated.mapping, original.mapping) &&
      updated.partialScope === true &&
      updated.qualification === false &&
      same(updated.checks, Object.fromEntries(h06Checks.map((id) => [id, true]))) &&
      original.evidence.every((pin) => updated.evidence.some((next) => same(pin, next))),
    'series-reconciliation-unconfirmed',
  );
  requireWorkflow(
    accountingMetrics.every(
      (metric) => updated.accounting[metric]! >= (original.accounting[metric] ?? 0),
    ) &&
      (['observedResponses', 'inputUncached', 'inputCached', 'output'] as const).every(
        (metric) => updated.accounting[metric]! >= original.knownSubtotal[metric],
      ),
    'series-reconciliation-budget-cap',
  );
  const detail = updated.reconciliation;
  requireWorkflow(detail !== undefined, 'series-reconciliation-unconfirmed');
  const { window, externalTurns } = detail;
  requireWorkflow(
    window.startedAtMs >= precedingEnd &&
      window.startedAtMs <= record.startedAtMs &&
      window.endedAtMs >= record.endedAtMs &&
      window.endedAtMs <= observedAtMs,
    'series-reconciliation-window',
  );
  requireWorkflow(
    externalTurns.length > 0 &&
      new Set(externalTurns).size === externalTurns.length &&
      externalTurns.every((turn) => !previousTurns.has(turn)),
    'series-reconciliation-turn-reuse',
  );
  return updated;
}
function verifyReconciliationClock(record: RecordEntry, sample: Clock, cap: Cap) {
  const observed = seriesClock(endOfRecord(record), sample.observedAtMs, BigInt(sample.observedNs));
  requireWorkflow(
    observed.elapsedMs === sample.elapsedMs &&
      observed.elapsedMs + cap.reserveMs < cap.maxElapsedMs,
    'series-reconciliation-time-cap',
  );
}
function reconciliationPath(outputRoot: string, index: number) {
  return join(outputRoot, `reconciliation-${index}.json`);
}
function historicalStateRef(state: State, outputRoot: string, index: number, record: RecordEntry) {
  return {
    locator: join(outputRoot, 'state.json'),
    hash: digest(
      canonical({
        ...state,
        ...endOfRecord(record),
        records: state.records.slice(0, index + 1),
        pending: null,
        blocked: record.blocked,
      }),
    ),
  };
}
function history(state: State, value: ReturnType<typeof loadManifest>) {
  const entries = readdirSync(value.outputRoot);
  const count = entries.filter((name) => /^record-\d+\.json$/u.test(name)).length;
  requireWorkflow(
    count === state.records.length ||
      (existsSync(join(value.outputRoot, 'pending.json')) && count === state.records.length + 1),
    'series-step-record-count',
  );
  const reconciliationIndices = new Set(
    entries
      .filter((name) => name.startsWith('reconciliation-'))
      .map((name) => {
        const match = /^reconciliation-(0|[1-9]\d*)\.json$/u.exec(name);
        requireWorkflow(
          state.schemaVersion === 6 && match !== null && Number(match[1]) < state.records.length,
          'series-reconciliation-order',
        );
        return Number(match[1]);
      }),
  );
  const reconciliations = new Map<
    number,
    { receipt: InputRef; command: InputRef; settlement: InputRef; clock: Clock }
  >();
  const spent = { reservedManagedStarts: 0, inputUncached: 0, output: 0 };
  const blocked: string[] = [];
  const externalTurns = new Set<string>();
  let precedingEnd = state.startedAtMs;
  let previousEnd = precedingEnd;
  let priorBlocked = false;
  for (const [index, record] of state.records.entries()) {
    previousEnd = precedingEnd;
    priorBlocked = blocked.length > 0;
    const planned = value.prepared[index];
    const recordPath = join(value.outputRoot, `record-${index}.json`);
    requireWorkflow(
      planned !== undefined &&
        record.runId === planned.runId &&
        record.opId === planned.opId &&
        record.requestHash === planned.requestHash &&
        same(JSON.parse(readPrivateFile(recordPath).toString()), record),
      'series-step-record-order',
    );
    const predecessor = reconciliations.get(index - 1);
    if (predecessor !== undefined) {
      seriesClock(predecessor.clock, record.startedAtMs, BigInt(record.startedNs));
      const end = seriesClock(predecessor.clock, record.endedAtMs, BigInt(record.endedNs));
      requireWorkflow(record.elapsedMs >= end.elapsedMs, 'series-reconciliation-time-cap');
    }
    const command = fields(h01ReadJson(ref(record.command)), [
      'kind',
      'schemaVersion',
      'manifest',
      'runId',
      'request',
      'previousState',
    ]);
    requireWorkflow(
      command.kind === 'comparison-h01-series-step' &&
        command.schemaVersion === state.schemaVersion &&
        same(command.manifest, state.manifest) &&
        command.runId === record.runId &&
        same(command.request, record.request) &&
        readStepHash(planned, ref(record.request)) === record.requestHash,
      'series-step-history-binding',
    );
    const evidence = boundStepTiming(
      normalizeStep(evidenceInput(record, planned.spec), planned.scenario),
      planned.scenario,
      record.startedNs,
      record.endedNs,
    );
    requireWorkflow(same(evidence, record.evidence), 'series-step-prior-unconfirmed');
    let effective = evidence;
    if (reconciliationIndices.has(index)) {
      requireWorkflow(blocked.length === 0, 'series-reconciliation-order');
      const receipt = fileRef(reconciliationPath(value.outputRoot, index));
      const { command, evidence: stored, ...clock } = readReconciliationReceipt(receipt);
      const input = readReconciliationCommand(command);
      requireWorkflow(
        same(input.manifest, state.manifest) &&
          input.runId === record.runId &&
          same(input.previousState, historicalStateRef(state, value.outputRoot, index, record)) &&
          same(input.record, fileRef(recordPath)) &&
          !overlaps(input.settlement.locator, value.outputRoot),
        'series-reconciliation-binding',
      );
      h01ReadPin(input.settlement);
      verifyReconciliationClock(record, clock, value.cap);
      const updated = reconcileEvidence(
        planned,
        record,
        input.settlement,
        precedingEnd,
        clock.observedAtMs,
        externalTurns,
      );
      requireWorkflow(same(updated, stored), 'series-reconciliation-changed');
      const terms = updated.reconciliation!;
      terms.externalTurns.forEach((turn) => externalTurns.add(turn));
      reconciliations.set(index, { receipt, command, settlement: input.settlement, clock });
      effective = updated;
      precedingEnd = clock.observedAtMs;
    } else {
      requireWorkflow(
        accepted(evidence) || record.blocked.length > 0,
        'series-step-blockers-changed',
      );
      blocked.push(...record.blocked);
      precedingEnd = record.endedAtMs;
    }
    for (const [, metric] of budgetMetrics)
      spent[metric] += effective.accounting[metric] ?? Number.POSITIVE_INFINITY;
    if (reconciliationIndices.has(index)) {
      blocked.push(...effective.blocking);
      if (
        budgetMetrics.some(
          ([cap, metric]) =>
            spent[metric] > value.cap[cap] || effective.accounting[metric]! > planned.budget[cap],
        )
      )
        blocked.push('series-step-budget-cap');
    }
  }
  requireWorkflow(
    same(state.blocked, state.records.at(-1)?.blocked ?? []),
    'series-step-blockers-changed',
  );
  const last = state.records.at(-1);
  if (last !== undefined && state.pending === null)
    requireWorkflow(
      state.observedNs === last.endedNs &&
        state.observedAtMs === last.endedAtMs &&
        state.elapsedMs === last.elapsedMs,
      'series-step-state-clock',
    );
  return {
    blocked: [...new Set(blocked)],
    spent,
    reconciliations,
    externalTurns,
    previousEnd,
    priorBlocked,
  };
}
function bindState(path: string, state: State, manifest: ReturnType<typeof loadManifest>) {
  requireWorkflow(
    path === join(manifest.outputRoot, 'state.json') &&
      same(state.schedule, manifest.schedule) &&
      state.startedAtMs === manifest.startedAtMs &&
      state.schemaVersion === manifest.schemaVersion,
    'series-step-state-binding',
  );
}
function status(path: string, state: State) {
  const manifest = loadManifest(ref(state.manifest));
  bindState(path, state, manifest);
  const pendingPath = join(manifest.outputRoot, 'pending.json');
  const pending = existsSync(pendingPath)
    ? (JSON.parse(readPrivateFile(pendingPath).toString()) as State['pending'])
    : state.pending;
  const proof = history(state, manifest);
  const blocked = proof.blocked.length > 0;
  const latest = proof.reconciliations.get(state.records.length - 1);
  const complete =
    state.records.length === manifest.prepared.length &&
    state.records.length === state.schedule.length;
  return {
    ...state,
    pending,
    ...(pending === null && latest !== undefined ? latest.clock : {}),
    blocked: proof.blocked,
    ...(proof.reconciliations.size > 0
      ? { reconciliations: [...proof.reconciliations.values()].map(({ receipt }) => receipt) }
      : {}),
    state: fileRef(path),
    next: pending === null && !blocked ? (state.schedule[state.records.length]?.id ?? null) : null,
    status:
      pending !== null
        ? 'pending'
        : blocked
          ? 'blocked'
          : complete
            ? 'complete'
            : state.records.length === manifest.prepared.length
              ? 'adapter-required'
              : 'ready',
  };
}
export function statusH01Series(path: string) {
  path = absolute(path);
  safeDirectory(dirname(path));
  return status(path, readState(path));
}
function seriesWriter(outputRoot: string) {
  safeDirectory(outputRoot);
  const lock = join(outputRoot, 'writer');
  mkdirSync(lock, { mode: 0o700 });
  syncDirectory(outputRoot);
  const identity = (directory: string) => {
    safeDirectory(directory);
    const stat = lstatSync(directory);
    return canonical([stat.dev, stat.ino]);
  };
  const owner = identity(outputRoot),
    locked = identity(lock);
  const holds = () => identity(outputRoot) === owner && identity(lock) === locked;
  return {
    lock,
    assert() {
      requireWorkflow(holds(), 'series-step-writer-changed');
    },
    close() {
      if (holds()) {
        const temporary = join(lock, 'state.json');
        if (existsSync(temporary)) unlinkSync(temporary);
        rmdirSync(lock);
        syncDirectory(outputRoot);
      }
    },
  };
}

/** One exact scenario grant per command; durable pending forbids automatic retry after uncertainty. */
export async function stepH01Series(commandRef: InputRef, signal?: AbortSignal) {
  commandRef = ref(commandRef);
  const command = fields(h01ReadJson(commandRef), [
    'kind',
    'schemaVersion',
    'manifest',
    'runId',
    'request',
    'previousState',
  ]);
  requireWorkflow(
    command.kind === 'comparison-h01-series-step' && seriesVersion(command.schemaVersion),
    'series-step-command-version',
  );
  const manifestRef = ref(command.manifest),
    value = loadManifest(manifestRef),
    runId = textField(command.runId),
    requestRef = ref(command.request);
  requireWorkflow(command.schemaVersion === value.schemaVersion, 'series-step-command-version');
  const selected = value.prepared.find((step) => step.runId === runId);
  requireWorkflow(selected !== undefined, 'series-step-request-binding');
  requireWorkflow(
    selected.requestHash === readStepHash(selected, requestRef),
    'series-step-request-binding',
  );
  const previous = command.previousState === null ? null : ref(command.previousState),
    path = join(value.outputRoot, 'state.json'),
    pendingPath = join(value.outputRoot, 'pending.json');
  if (!existsSync(value.outputRoot)) {
    requireWorkflow(previous === null, 'series-step-state-missing');
    mkdirSync(value.outputRoot, { mode: 0o700 });
    syncDirectory(dirname(value.outputRoot));
  }
  const writer = seriesWriter(value.outputRoot);
  let state: State;
  let stateHash: string | null = existsSync(path) ? fileRef(path).hash : null;
  const retained: InputRef[] = [];
  const assert = () => {
    writer.assert();
    value.verify();
    h01ReadPin(commandRef);
    h01ReadPin(requestRef);
    retained.forEach(h01ReadPin);
    requireWorkflow(
      (existsSync(path) ? fileRef(path).hash : null) === stateHash,
      'series-step-state-changed',
    );
  };
  const save = () => {
    assert();
    const temporary = join(writer.lock, 'state.json');
    writePrivateFile(temporary, canonical(state));
    assert();
    renameSync(temporary, path);
    syncDirectory(value.outputRoot);
    stateHash = fileRef(path).hash;
  };
  try {
    if (stateHash === null) {
      requireWorkflow(previous === null, 'series-step-state-missing');
      state = {
        kind: 'comparison-h01-series-state',
        schemaVersion: value.schemaVersion,
        manifest: manifestRef,
        schedule: value.schedule,
        startedAtMs: value.startedAtMs,
        observedAtMs: Date.now(),
        observedNs: String(process.hrtime.bigint()),
        elapsedMs: Date.now() - value.startedAtMs,
        records: [],
        pending: null,
        blocked: [],
        partialScope: true,
        qualification: false,
      };
    } else {
      state = readState(path);
      requireWorkflow(same(state.manifest, manifestRef), 'series-step-manifest-changed');
      bindState(path, state, value);
    }
    requireWorkflow(!existsSync(pendingPath) && state.pending === null, 'series-step-pending');
    const proof = history(state, value);
    for (const { receipt, command, settlement } of proof.reconciliations.values())
      retained.push(receipt, command, settlement);
    const repeated = state.records.find((record) => record.runId === runId);
    if (repeated !== undefined) {
      requireWorkflow(
        same(repeated.command, commandRef) && same(repeated.request, requestRef),
        'series-step-replay-conflict',
      );
      assert();
      return status(path, state);
    }
    requireWorkflow(
      stateHash === null ||
        (previous !== null && previous.locator === path && previous.hash === stateHash),
      'series-step-previous-state',
    );
    requireWorkflow(proof.blocked.length === 0, 'series-step-blocked');
    requireWorkflow(state.schedule[state.records.length]?.id === runId, 'series-step-next-slot');
    const reserveBudget = () => {
      requireWorkflow(
        budgetMetrics.every(
          ([key, metric]) => proof.spent[metric] + selected.budget[key] <= value.cap[key],
        ),
        'series-step-budget-cap',
      );
    };
    reserveBudget();
    let anchor = proof.reconciliations.get(state.records.length - 1)?.clock ?? state;
    const clock = () => seriesClock(anchor);
    const before = clock();
    requireWorkflow(
      before.elapsedMs + selected.budget.maxElapsedMs + value.cap.reserveMs <=
        value.cap.maxElapsedMs,
      'series-step-time-cap',
    );
    await planH01Series(
      manifestRef,
      state.records.map((record) => record.runId),
    );
    assert();
    loadManifest(manifestRef);
    const rechecked = history(state, value);
    requireWorkflow(
      rechecked.blocked.length === 0 && same(rechecked.spent, proof.spent),
      'series-step-prior-unconfirmed',
    );
    signal?.throwIfAborted();
    const startClock = clock(),
      start = startClock.wall,
      monotonicStart = startClock.ns;
    const elapsed = startClock.elapsedMs;
    requireWorkflow(
      elapsed + selected.budget.maxElapsedMs + value.cap.reserveMs <= value.cap.maxElapsedMs,
      'series-step-time-cap',
    );
    reserveBudget();
    state.pending = {
      runId,
      opId: selected.opId,
      requestHash: selected.requestHash,
      command: commandRef,
      request: requestRef,
      startedAtMs: start,
    };
    state.observedAtMs = start;
    state.observedNs = String(monotonicStart);
    state.elapsedMs = elapsed;
    anchor = state;
    writePrivateFile(pendingPath, canonical(state.pending));
    save();
    const dispatch = selected.scenario === 'H-06' ? clock() : startClock;
    const remaining = value.cap.maxElapsedMs - dispatch.elapsedMs - value.cap.reserveMs;
    requireWorkflow(selected.budget.maxElapsedMs <= remaining, 'series-step-time-cap');
    signal?.throwIfAborted();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, remaining);
    try {
      const operator =
        selected.scenario === 'H-06'
          ? await runH06Operator(selected.spec, requestRef, controller.signal, {
              wall: dispatch.wall,
              ns: dispatch.ns,
            })
          : await runH01Operator(selected.spec, requestRef, controller.signal, selected.scenario);
      assert();
      loadManifest(manifestRef);
      const normalized = normalizeStep(
        {
          runId,
          opId: selected.opId,
          request: requestRef,
          spec: selected.spec,
          operator,
          command: commandRef,
        },
        selected.scenario,
      );
      const endClock = clock(),
        endedAtMs = endClock.wall;
      const evidence = boundStepTiming(
        normalized,
        selected.scenario,
        String(monotonicStart),
        String(endClock.ns),
      );
      state.blocked = [...evidence.blocking];
      if (!accepted(evidence)) state.blocked.push('series-step-outcome-unconfirmed');
      if (
        controller.signal.aborted ||
        signal?.aborted ||
        endClock.elapsedMs + value.cap.reserveMs >= value.cap.maxElapsedMs
      )
        state.blocked.push('series-step-time-cap');
      state.records.push({
        runId,
        opId: selected.opId,
        requestHash: selected.requestHash,
        command: commandRef,
        request: requestRef,
        operator,
        evidence,
        blocked: [],
        startedAtMs: start,
        endedAtMs,
        startedNs: String(monotonicStart),
        endedNs: String(endClock.ns),
        elapsedMs: endClock.elapsedMs,
      });
      if (
        !budgetMetrics.every(
          ([key, metric]) =>
            proof.spent[metric] + (evidence.accounting[metric] ?? Number.POSITIVE_INFINITY) <=
            value.cap[key],
        )
      )
        state.blocked.push('series-step-budget-cap');
      state.pending = null;
      state.observedAtMs = endedAtMs;
      state.observedNs = String(endClock.ns);
      state.elapsedMs = endClock.elapsedMs;
      state.blocked = [...new Set(state.blocked)];
      state.records.at(-1)!.blocked = [...state.blocked];
      writePrivateFile(
        join(value.outputRoot, `record-${state.records.length - 1}.json`),
        canonical(state.records.at(-1)!),
      );
      save();
      unlinkSync(pendingPath);
      syncDirectory(value.outputRoot);
      return status(path, state);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  } finally {
    writer.close();
  }
}

/** Resolve a recorded H06 UNKNOWN from closed, pinned evidence without invoking an operator. */
export function reconcileH01Series(commandRef: InputRef, signal?: AbortSignal) {
  commandRef = ref(commandRef);
  const input = readReconciliationCommand(commandRef);
  const value = loadManifest(input.manifest);
  const path = join(value.outputRoot, 'state.json');
  requireWorkflow(
    value.schemaVersion === 6 &&
      input.previousState.locator === path &&
      !overlaps(input.settlement.locator, value.outputRoot) &&
      !overlaps(commandRef.locator, value.outputRoot),
    'series-reconciliation-binding',
  );
  signal?.throwIfAborted();
  const snapshot = readState(path);
  bindState(path, snapshot, value);
  const snapshotIndex = snapshot.records.findIndex((record) => record.runId === input.runId);
  const published = reconciliationPath(value.outputRoot, snapshotIndex);
  if (existsSync(published)) {
    const previous = readReconciliationReceipt(fileRef(published));
    requireWorkflow(same(previous.command, commandRef), 'series-reconciliation-conflict');
    return status(path, snapshot);
  }
  const writer = seriesWriter(value.outputRoot);
  try {
    const stateRef = fileRef(path),
      state = readState(path);
    bindState(path, state, value);
    requireWorkflow(
      same(state.manifest, input.manifest) &&
        state.pending === null &&
        !existsSync(join(value.outputRoot, 'pending.json')),
      'series-reconciliation-pending',
    );
    const proof = history(state, value);
    const index = state.records.findIndex((record) => record.runId === input.runId);
    requireWorkflow(!proof.reconciliations.has(index), 'series-reconciliation-conflict');
    const record = state.records[index],
      planned = value.prepared[index];
    requireWorkflow(!proof.priorBlocked, 'series-reconciliation-order');
    requireWorkflow(
      record !== undefined &&
        planned !== undefined &&
        index === state.records.length - 1 &&
        same(input.previousState, stateRef) &&
        same(input.previousState, historicalStateRef(state, value.outputRoot, index, record)) &&
        same(input.record, fileRef(join(value.outputRoot, `record-${index}.json`))),
      'series-reconciliation-binding',
    );
    const anchor = endOfRecord(record);
    const bound = seriesClock(anchor);
    h01ReadPin(input.settlement);
    const evidence = reconcileEvidence(
      planned,
      record,
      input.settlement,
      proof.previousEnd,
      bound.wall,
      proof.externalTurns,
    );
    writer.assert();
    value.verify();
    h01ReadPin(stateRef);
    h01ReadPin(input.record);
    h01ReadPin(input.settlement);
    h01ReadPin(commandRef);
    for (const { receipt, command, settlement } of proof.reconciliations.values())
      [receipt, command, settlement].forEach(h01ReadPin);
    signal?.throwIfAborted();
    const end = seriesClock(anchor);
    const clock = { observedAtMs: end.wall, observedNs: String(end.ns), elapsedMs: end.elapsedMs };
    verifyReconciliationClock(record, clock, value.cap);
    publishFile(
      reconciliationPath(value.outputRoot, index),
      Buffer.from(
        canonical({
          kind: 'comparison-h01-series-reconciliation',
          schemaVersion: 6,
          command: commandRef,
          evidence,
          ...clock,
        }),
      ),
    );
    return status(path, state);
  } finally {
    writer.close();
  }
}

function emitH06StepReceipt(command: InputRef, result: ReturnType<typeof statusH01Series>) {
  if (result.status !== 'blocked' || result.pending !== null) return;
  const index = result.records.length - 1;
  if (result.schedule[index]?.scenario !== 'H-06') return;
  const record = result.records[index]!;
  if (!same(record.command, command) || record.blocked.length === 0) return;
  const receipt = record.evidence.evidence.find((pin) =>
    same(pin, object(record.operator).receipt ?? null),
  );
  if (receipt === undefined) return;
  h01ReadPin(receipt);
  process.stderr.write('comparison-h06-step-record:' + receipt.hash + '\n');
}

export async function h01SeriesMain(args: string[]) {
  requireWorkflow(
    args.length === 2 && ['--plan', '--step', '--status', '--reconcile'].includes(args[0]!),
    'series-step-usage',
  );
  const path = resolve(args[1]!),
    controller = new AbortController(),
    abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    const step = args[0] === '--step' ? fileRef(path) : null;
    const result =
      args[0] === '--plan'
        ? await planH01Series(fileRef(path))
        : step !== null
          ? await stepH01Series(step, controller.signal)
          : args[0] === '--reconcile'
            ? reconcileH01Series(fileRef(path), controller.signal)
            : statusH01Series(path);
    if (step !== null && 'status' in result) emitH06StepReceipt(step, result);
    process.stdout.write(canonical(result) + '\n');
    if ('status' in result && (result.status === 'blocked' || result.status === 'pending'))
      process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h01SeriesMain(process.argv.slice(2)).catch(() => {
    process.stderr.write('series-step-failed\n');
    process.exitCode = 1;
  });
