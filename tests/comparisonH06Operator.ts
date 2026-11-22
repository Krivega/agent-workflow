import { supportedTaskClient } from '../src/policy/readerExecution.js';
import { legacyDisabledMcpServers } from './comparisonH06NativeLegacyOperator.js';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { createPrivateDirectory, safeDirectory } from '../adapters/storage/storeFiles.js';
import type { InputRef } from '../core/localRun.js';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import {
  h01RawFile,
  h01ReadJson,
  h01ReadPin,
  h01Record,
  parseH01Profile,
  parseH01Runtime,
} from './comparisonH01Contract.js';
import type {
  H01SeriesEvidenceInput,
  H01SeriesEvidenceSummary,
} from './comparisonH01SeriesEvidence.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets, h06Checks } from './comparisonH06Contract.js';
import { readH06NativeRequestBinding } from './comparisonH06NativeAttemptPlan.js';
import { bindH06Package, checkH06Package } from './comparisonH06Package.js';
import { startH06DelegatedRun } from './comparisonH06DelegatedRun.js';
import { runH06TemporalAutonomousFromChat } from './comparisonH06TemporalAutonomousRun.js';
import { verifyH06LegacySeriesPrimary } from './comparisonH06OperatorLegacyEvidence.js';
import { verifyH06TemporalSeriesPrimary } from './comparisonH06TemporalSeriesPrimary.js';
import { verifyH06SeriesAccounting } from './comparisonH06SeriesAccounting.js';

const self = fileURLToPath(import.meta.url);
const seriesEntry = fileURLToPath(new URL('./comparisonH01Series.ts', import.meta.url));
const packageEntry = fileURLToPath(new URL('./comparisonH06Package.ts', import.meta.url));
const readerEntry = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const tsxEntry = fileURLToPath(import.meta.resolve('tsx'));
const absolute = (value: unknown) => h04Pin({ path: value, sha256: '0'.repeat(64) }).path;
const ref = ({ path, sha256 }: H04Pin): InputRef => ({ locator: path, hash: sha256 });
const asPin = ({ locator, hash }: InputRef): H04Pin => ({ path: locator, sha256: hash });
const pinFile = (path: string): InputRef => ({ locator: path, hash: digest(h01RawFile(path)) });
const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(pin).toString('utf8')));
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

function inputRef(value: unknown): InputRef {
  const input = object(value);
  exactFields(input, ['locator', 'hash']);
  return ref(h04Pin({ path: input.locator, sha256: input.hash }));
}

/** Recover the stable bindings without reopening a fresh operation or consuming a grant. */
export function readH06OperatorBinding(
  specRef: InputRef,
  requestRef: InputRef,
  _mode: 'plan' | 'run',
) {
  const spec = object(h01ReadJson(specRef));
  exactFields(spec, ['kind', 'schemaVersion', 'package', 'evidenceRoot']);
  requireContract(
    spec.kind === 'comparison-h06-operator' && spec.schemaVersion === 1,
    'h06-series-spec',
  );
  const input = object(h01ReadJson(requestRef));
  exactFields(input, ['kind', 'schemaVersion', 'material', 'criteria', 'profile', 'runtime']);
  requireContract(
    input.kind === 'comparison-h06-execution' && input.schemaVersion === 1,
    'h06-series-request',
  );
  const operatorRoot = absolute(spec.evidenceRoot);
  safeDirectory(dirname(operatorRoot));
  const packageRef = inputRef(spec.package);
  const manifest = object(h01ReadJson(packageRef));
  const packageSpec = object(manifest.spec);
  const legacy = packageSpec.profile === 'h06-autonomous-recovery/3';
  requireContract(
    manifest.kind === 'comparison-h06-package-manifest/1' &&
      packageSpec.kind === 'comparison-h06-package/1' &&
      (legacy || packageSpec.profile === 'h06-autonomous-temporal/3'),
    'h06-series-package-profile',
  );
  const run = legacy ? null : read(h04Pin(packageSpec.run));
  const authority = run === null ? null : read(h04Pin(run.authority));
  const attempt = h04Pin(authority === null ? packageSpec.attempt : authority.attempt);
  const native = readH06NativeRequestBinding(read(attempt));
  const { binding, budget, stimulus, evidenceRoot, chat } = native;
  const assets = h06Assets();
  const nativeHash = digest(canonical({ request: native, assets }));
  requireContract(
    (legacy ? binding.variant === 'legacy' : binding.variant === 'temporal') &&
      manifest.requestHash === nativeHash &&
      (run === null || run.kind === 'comparison-h06-temporal-autonomous-run/3') &&
      (authority === null || authority.kind === 'comparison-h06-temporal-autonomous/3'),
    'h06-series-attempt-binding',
  );
  const material = inputRef(input.material),
    criteria = inputRef(input.criteria),
    profile = inputRef(input.profile),
    runtime = inputRef(input.runtime);
  const variant = legacy ? ('baseline' as const) : ('candidate' as const);
  const common = parseH01Runtime(runtime, variant);
  const commonProfile = parseH01Profile(profile);
  const runtimeFiles = native.runtime.map(ref);
  const pinnedRuntime = new Set(runtimeFiles.map(({ locator }) => locator));
  const directory = dirname(self);
  const h06Runtime = readdirSync(directory)
    .filter((name) => /^comparisonH06.*\.(?:ts|mts|mjs)$/u.test(name) && !/\.test\./u.test(name))
    .concat('comparisonH04Contract.ts');
  requireContract(
    same(material, ref(assets.materials)) &&
      same(criteria, ref(assets.suite)) &&
      same(commonProfile.binary, ref(native.appServer)) &&
      binding.node.path === realpathSync(process.execPath) &&
      [profile, commonProfile.rules, ...common.files].every((pinned) =>
        runtimeFiles.some((candidate) => same(candidate, pinned)),
      ) &&
      h06Runtime.every((file) => pinnedRuntime.has(join(directory, file))),
    'h06-series-runtime-profile',
  );
  const packetRoot = legacy ? dirname(attempt.path) : null;
  const packetPaths =
    packetRoot === null
      ? []
      : [
          ...Object.values(object(packageSpec.packets)).map(absolute),
          join(packetRoot, 'package-binding.json'),
        ];
  const config = legacy ? h04Pin(packageSpec.config) : null;
  const serverRoot = legacy ? null : evidenceRoot + '-server';
  const roots = [
    operatorRoot,
    evidenceRoot,
    binding.workspaceRoot,
    ...(packetRoot === null ? [] : [packetRoot]),
    ...(serverRoot === null ? [] : [serverRoot]),
  ];
  const pins = [
    specRef,
    requestRef,
    packageRef,
    ref(attempt),
    material,
    criteria,
    profile,
    runtime,
    ref(native.bootstrap),
    ref(native.appServer),
    ref(binding.node),
    ref(assets.acceptance),
    commonProfile.rules,
    commonProfile.executor,
    commonProfile.reviewer,
    ...runtimeFiles,
    ...(config === null ? [] : [ref(config)]),
    ...(native.server === null ? [] : [ref(native.server)]),
    ...(run === null ? [] : [ref(h04Pin(packageSpec.run)), ref(h04Pin(run.authority))]),
  ];
  requireContract(
    roots.every(
      (root, index) =>
        !overlaps(root, chat.workspace) &&
        !overlaps(root, common.root) &&
        roots.every((other, otherIndex) => index === otherIndex || !overlaps(root, other)),
    ) &&
      pins.every(({ locator }) =>
        roots.every((root) => root === packetRoot || !overlaps(root, locator)),
      ) &&
      packetPaths.every(
        (path) =>
          dirname(path) === packetRoot && !pins.some(({ locator }) => overlaps(path, locator)),
      ) &&
      new Set(packetPaths).size === packetPaths.length,
    'h06-series-roots-overlap',
  );
  return {
    opId: binding.operationId,
    variant,
    budget,
    requestHash: digest(canonical({ spec: specRef, request: requestRef, nativeHash })),
    nativeHash,
    profile,
    runtime,
    bootstrap: ref(native.bootstrap),
    material,
    criteria,
    pins,
    roots,
    evidenceRoot,
    operatorRoot,
    workspaceRoot: binding.workspaceRoot,
    chatRoot: chat.workspace,
    longStageMs: stimulus.longStageMs,
    runtimeFiles,
    packageRef,
    manifest,
    native,
    run,
    packetRoot,
    packetPaths,
    serverRoot,
  };
}

/** Check the packaged scenario and show its exact external grant, without issuing it. */
export function planH06Operator(spec: InputRef, request: InputRef) {
  const binding = readH06OperatorBinding(spec, request, 'plan');
  const manifest = checkH06Package(binding.manifest);
  const { model, effort, clientVersion, disabledMcpServers } = parseH01Profile(binding.profile);
  const actual =
    binding.variant === 'baseline'
      ? object(object(object(manifest).composition).actor)
      : object(read(binding.native.bootstrap).profile);
  requireContract(
    actual.model === model &&
      actual.effort === effort &&
      (binding.variant === 'baseline'
        ? supportedTaskClient(clientVersion) &&
          same(
            disabledMcpServers ?? [],
            legacyDisabledMcpServers(read(binding.native.bootstrap)) ?? [],
          )
        : actual.clientVersion === clientVersion &&
          same(disabledMcpServers ?? [], read(binding.native.bootstrap).disabledServers)),
    'h06-series-effective-profile',
  );
  for (const path of [
    binding.operatorRoot,
    ...(binding.serverRoot === null ? [] : [binding.serverRoot]),
    ...binding.packetPaths,
  ])
    requireContract(
      lstatSync(path, { throwIfNoEntry: false }) === undefined,
      'h06-series-not-fresh',
    );
  return {
    kind: 'comparison-h06-operator-plan',
    schemaVersion: 1,
    ...binding,
    spec,
    request,
    proposedGrants: object(manifest).proposedGrants,
    mayRun: false,
    qualification: false,
  } as const;
}

function rootIdentity(path: string) {
  const stat = lstatSync(safeDirectory(path), { bigint: true });
  return [stat.dev, stat.ino];
}

/** Run exactly one native H06 attempt using the native owner and existing recovery protocol. */
export async function runH06Operator(
  spec: InputRef,
  request: InputRef,
  signal?: AbortSignal,
  started?: { wall: number; ns: bigint },
) {
  const { ns: startedNs, wall: startedAtMs } = started ?? {
    ns: process.hrtime.bigint(),
    wall: Date.now(),
  };
  requireContract(
    Number.isSafeInteger(startedAtMs) &&
      startedAtMs > 0 &&
      startedAtMs <= Date.now() &&
      startedNs <= process.hrtime.bigint(),
    'h06-series-operator-clock',
  );
  const plan = planH06Operator(spec, request);
  const { operatorRoot, opId, requestHash, packageRef, variant, budget, native } = plan;
  const remaining =
    budget.maxElapsedMs -
    Math.max(
      Math.ceil(Number(process.hrtime.bigint() - startedNs) / 1e6),
      Date.now() - startedAtMs,
    );
  requireContract(remaining > budget.reserveMs, 'h06-series-operator-deadline');
  const deadline = AbortSignal.timeout(remaining);
  const live = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
  live.throwIfAborted();
  createPrivateDirectory(operatorRoot);
  const identity = rootIdentity(operatorRoot);
  const claim = h01Record(operatorRoot, 'operator-claim', { spec, request, requestHash, opId });
  let result: unknown = null;
  let failure: string | null = null;
  try {
    if (variant === 'baseline') {
      const bound = await bindH06Package(asPin(packageRef));
      const start = read(bound.start);
      live.throwIfAborted();
      result = await startH06DelegatedRun(start.authority, h04Pin(start.config), live, startedAtMs);
    } else {
      result = await runH06TemporalAutonomousFromChat(plan.run, live, startedAtMs);
    }
    live.throwIfAborted();
  } catch (error) {
    failure = String(error);
  }
  requireContract(same(rootIdentity(operatorRoot), identity), 'h06-series-operator-owner-changed');
  h01ReadPin(claim);
  for (const pin of plan.pins) h01ReadPin(pin);
  const endedNs = process.hrtime.bigint();
  const body = {
    kind: 'comparison-h06-operator-result',
    schemaVersion: 1,
    spec,
    request,
    requestHash,
    opId,
    variant,
    claim,
    nativeEvidenceRoot: native.evidenceRoot,
    startedNs: String(startedNs),
    endedNs: String(endedNs),
    result,
    failure,
    qualification: false,
  } as const;
  return { ...body, receipt: h01Record(operatorRoot, 'operator-result', body) };
}

type H06SeriesEvidenceSummary = H01SeriesEvidenceSummary & {
  reconciliation?: {
    window: { startedAtMs: number; endedAtMs: number };
    externalTurns: string[];
  };
};

function reconciliationExecution(
  plan: ReturnType<typeof readH06OperatorBinding>,
  input: H01SeriesEvidenceInput,
) {
  const command = inputRef(input.command);
  const step = object(h01ReadJson(command));
  requireContract(
    step.kind === 'comparison-h01-series-step' &&
      step.schemaVersion === 6 &&
      step.runId === input.runId &&
      same(step.request, input.request),
    'h06-series-reconciliation-step',
  );
  const { evidenceRoot, native, variant, runtimeFiles } = plan;
  const legacy = variant === 'baseline';
  requireContract(
    [tsxEntry, seriesEntry, ...(legacy ? [packageEntry, readerEntry] : [])].every((path) =>
      runtimeFiles.some(({ locator }) => locator === path),
    ),
    'h06-series-reconciliation-runtime',
  );
  const execution = {
    node: native.binding.node.path,
    tsx: tsxEntry,
    series: seriesEntry,
    step: command.locator,
    evidenceRoot,
  };
  if (!legacy) return execution;
  const packets = object(object(plan.manifest.spec).packets);
  return {
    ...execution,
    legacy: {
      package: packageEntry,
      reader: readerEntry,
      packets: {
        load: absolute(packets.load),
        warmPause: absolute(packets.warmPause),
        warmResume: absolute(packets.warmResume),
        coldPause: absolute(packets.coldPause),
        coldResume: absolute(packets.coldResume),
      },
    },
  };
}

/** Read the original operator result and, when supplied, an explicitly pinned accounting closure. */
export function normalizeH06SeriesEvidence(
  input: H01SeriesEvidenceInput,
  reconciliation?: InputRef,
): H06SeriesEvidenceSummary {
  const summary: H06SeriesEvidenceSummary = {
    outcome: 'unknown',
    checks: null,
    stopped: false,
    accounting: {
      reservedManagedStarts: null,
      observedResponses: null,
      inputUncached: null,
      inputCached: null,
      output: null,
      unknown: true,
    },
    knownSubtotal: { observedResponses: 0, inputUncached: 0, inputCached: 0, output: 0 },
    operatorElapsedMs: null,
    startedNs: null,
    endedNs: null,
    blocking: [
      'h06-series-whole-attempt-accounting-unknown',
      'h06-series-effective-participants-unconfirmed',
    ],
    evidence: [],
    mapping: { runId: input.runId, opId: input.opId },
    partialScope: true,
    qualification: false,
  };
  try {
    const plan = readH06OperatorBinding(input.spec, input.request, 'run');
    const outer = object(input.operator);
    const { receipt: rawReceipt, ...body } = outer;
    const receipt = inputRef(rawReceipt);
    const claim = inputRef(body.claim);
    requireContract(
      dirname(receipt.locator) === plan.operatorRoot &&
        dirname(claim.locator) === plan.operatorRoot &&
        same(h01ReadJson(receipt), body) &&
        same(h01ReadJson(claim), {
          spec: input.spec,
          request: input.request,
          requestHash: plan.requestHash,
          opId: plan.opId,
        }) &&
        body.kind === 'comparison-h06-operator-result' &&
        body.schemaVersion === 1 &&
        same(body.spec, input.spec) &&
        same(body.request, input.request) &&
        body.opId === input.opId &&
        input.opId === plan.opId &&
        body.requestHash === plan.requestHash &&
        body.variant === plan.variant &&
        body.nativeEvidenceRoot === plan.evidenceRoot &&
        body.qualification === false,
      'h06-series-result-binding',
    );
    summary.evidence.push(receipt, claim);
    const { startedNs, endedNs } = body;
    requireContract(
      typeof startedNs === 'string' &&
        /^\d+$/u.test(startedNs) &&
        typeof endedNs === 'string' &&
        /^\d+$/u.test(endedNs) &&
        BigInt(endedNs) >= BigInt(startedNs),
      'h06-series-operator-clock',
    );
    summary.startedNs = startedNs;
    summary.endedNs = endedNs;
    summary.operatorElapsedMs = Number(BigInt(endedNs) - BigInt(startedNs)) / 1e6;
    if (body.failure !== null || body.result === null)
      summary.blocking.push('h06-series-native-execution-unconfirmed');
    if (summary.operatorElapsedMs > plan.budget.maxElapsedMs)
      summary.blocking.push('h06-series-operator-deadline');
    if (body.result !== null) {
      const profile = reconciliation === undefined ? undefined : parseH01Profile(plan.profile);
      const primary =
        plan.variant === 'baseline'
          ? verifyH06LegacySeriesPrimary(body.result, plan.native, plan.nativeHash, profile)
          : verifyH06TemporalSeriesPrimary(
              body.result,
              plan.evidenceRoot,
              plan.nativeHash,
              profile,
            );
      summary.stopped = primary.stopped;
      summary.knownSubtotal = primary.knownSubtotal;
      summary.evidence.push(...primary.evidence);
      if (!primary.stopped) summary.blocking.push('h06-series-stop-unconfirmed');
      if (primary.budgetExceeded) {
        summary.outcome = 'failed';
        summary.blocking.push('h06-series-known-budget-exceeded');
      }
      if (primary.failed) {
        summary.outcome = 'failed';
        summary.blocking.push('h06-series-native-failed');
      }
      if (reconciliation !== undefined) {
        try {
          requireContract(
            summary.outcome === 'unknown' &&
              summary.blocking.length === 2 &&
              primary.receipt !== null &&
              profile !== undefined,
            'h06-series-native-reconciliation',
          );
          const { totals, evidence, window, externalTurns } = verifyH06SeriesAccounting(
            reconciliation,
            {
              operator: receipt,
              opId: input.opId,
              profile,
              ...primary.receipt,
              execution: reconciliationExecution(plan, input),
            },
          );
          requireContract(
            Object.entries(summary.knownSubtotal).every(
              ([metric, lower]) => totals[metric as keyof typeof totals] >= lower,
            ),
            'h06-series-reconciled-subtotal',
          );
          plan.pins.forEach(h01ReadPin);
          const overBudget =
            window.endedAtMs - window.startedAtMs > plan.budget.maxElapsedMs ||
            totals.reservedManagedStarts > plan.budget.maxManagedStarts ||
            totals.inputUncached > plan.budget.maxInputUncached ||
            totals.output > plan.budget.maxOutput;
          summary.accounting = { ...totals, unknown: false };
          summary.reconciliation = { window, externalTurns };
          summary.evidence.push(...evidence);
          summary.blocking = overBudget ? ['h06-series-whole-attempt-budget-exceeded'] : [];
          summary.outcome = overBudget ? 'failed' : 'accepted';
          summary.checks = Object.fromEntries(h06Checks.map((key) => [key, true]));
        } catch {
          summary.blocking.push('h06-series-reconciliation-unconfirmed');
        }
      }
    }
  } catch {
    summary.blocking.push('h06-series-primary-unconfirmed');
  }
  return summary;
}

export async function h06OperatorMain(args: string[]) {
  const [command, spec, request] = args;
  requireContract(
    args.length === 3 && (command === '--plan' || command === '--run'),
    'h06-series-operator-arguments',
  );
  const specRef = pinFile(resolve(spec!)),
    requestRef = pinFile(resolve(request!));
  if (command === '--plan') return planH06Operator(specRef, requestRef);
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('h06-series-operator-interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await runH06Operator(specRef, requestRef, abort.signal);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void h06OperatorMain(process.argv.slice(2)).then(
    (result) => process.stdout.write(canonical(result) + '\n'),
    (error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    },
  );
