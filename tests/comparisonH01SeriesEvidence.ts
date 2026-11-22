import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { defaultPayloadConverter } from '@temporalio/common';
import proto from '@temporalio/proto';
import suiteSource from '../comparison/suite.json' with { type: 'json' };
import { configuredRoles } from '../core/council.js';
import { confirmSession, type AgentSession } from '../core/dataRoute.js';
import type { CouncilConfiguration } from '../core/connection.js';
import { object, parseConnection, requireWorkflow, textField } from '../core/connection.js';
import { comparisonDuration, type ComparisonTiming } from '../core/comparison.js';
import { confirmLoad, requireLoadedProcedures } from '../core/localRun.js';
import type { InputRef, LocalRun, LoadReceipt } from '../core/localRun.js';
import type { Procedure } from '../core/connection.js';
import type { StoreRequest } from '../core/evidence.js';
import { normativeRules } from '../core/compactContext.js';
import { readFragmentFits } from '../core/readFragments.js';
import { canonical, digest, requestHash } from '../adapters/storage/storeCodec.js';
import { compactContextLine } from '../adapters/project/compactContext.js';
import type { CompactContextPacket } from '../adapters/project/compactContext.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { lookupEffect } from '../src/adapters/artifacts/effects.js';
import type { EffectIntent } from '../src/adapters/artifacts/effects.js';
import { confirmObservedLoad } from '../src/adapters/codex/observedLoad.js';
import { readerLoadObserved } from '../src/adapters/codex/readerLoadCommandOutputs.js';
import { readerContextCompacted } from '../src/adapters/codex/readerContext.js';
import { nativeReaderNotice } from '../src/adapters/codex/readerAuthority.js';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import {
  readerKey,
  readerTarget,
  parseReaderInput,
  parseReaderCommand,
  readerCommandText,
} from '../src/policy/readerControl.js';
import { reviewKey } from '../src/policy/review.js';
import type { ReviewInput } from '../src/contracts/review.js';
import type { ReaderInput } from '../src/contracts/reader.js';
import {
  readComparisonUsage,
  type ComparisonParticipant,
  type NativeComparisonReceipt,
} from '../adapters/codex/comparisonUsage.js';
import {
  comparisonLabel,
  parseH01Profile,
  parseH01GuardDescriptor,
  parseH01Runtime,
  h01RawFile,
  h01ReadJson,
  h01ReadPin,
  h01RequestHash,
  parseH01Request,
} from './comparisonH01Contract.js';
import { parseH01OperatorSpec } from './comparisonH01Preparation.js';
import { verifyNativeCompactionBarrier, verifyNativeCompactionSpan } from './comparisonH01Guard.js';
import {
  h03ReaderInput,
  h03Procedures,
  h03ProbeNames,
  h03ContextPath,
  h03PreparedMetadata,
} from './comparisonH03Contract.js';
import { verifyH04NativeWait, type H04NativeCaseReport } from './comparisonH04NativeContract.js';
import { verifyH04NativePrimary } from './comparisonH04NativeOperation.js';
import {
  h05ProbeIds,
  h05Procedures,
  h05PreparedMetadata,
  h05Material,
  verifyH05Primary,
  type H05CaseReport,
} from './comparisonH05Contract.js';
import { verifyH05TemporalExecution } from './comparisonH05Temporal.js';

export interface H01SeriesEvidenceInput {
  runId: string;
  opId: string;
  request: InputRef;
  spec: InputRef;
  command?: InputRef;
  operator: unknown;
}
export interface H01SeriesEvidenceSummary {
  outcome: 'accepted' | 'failed' | 'unknown';
  checks: Record<string, boolean> | null;
  stopped: boolean;
  accounting: {
    reservedManagedStarts: number | null;
    observedResponses: number | null;
    inputUncached: number | null;
    inputCached: number | null;
    output: number | null;
    unknown: boolean;
  };
  knownSubtotal: {
    observedResponses: number;
    inputUncached: number;
    inputCached: number;
    output: number;
  };
  operatorElapsedMs: number | null;
  startedNs: string | null;
  endedNs: string | null;
  blocking: string[];
  evidence: InputRef[];
  mapping: { runId: string; opId: string };
  partialScope: true;
  qualification: false;
}
const metricNames = ['observedResponses', 'inputUncached', 'inputCached', 'output'] as const;
const receiptNames = ['responses', 'input_uncached', 'input_cached', 'output'] as const;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
type Scenario = 'H-01' | 'H-02' | 'H-03' | 'H-04' | 'H-05';

/** A read-only view of one pinned operator graph; it never grants another attempt. */
export function normalizeH01SeriesEvidence(
  input: H01SeriesEvidenceInput,
  scenario: Scenario = 'H-01',
): H01SeriesEvidenceSummary {
  const label = comparisonLabel(scenario);
  const requiredChecks = suiteSource.scenarios.find((row) => row.id === scenario)!.checks;
  const summary: H01SeriesEvidenceSummary = {
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
    blocking: [],
    evidence: [],
    mapping: { runId: input.runId, opId: input.opId },
    partialScope: true,
    qualification: false,
  };
  const evidence = new Map<string, InputRef>();
  const read = (value: unknown) => {
    const raw = object(value);
    requireWorkflow(same(Object.keys(raw).sort(), ['hash', 'locator']), 'h01-series-pin');
    const ref = { locator: textField(raw.locator), hash: textField(raw.hash) };
    const bytes = h01ReadPin(ref);
    evidence.set(ref.locator, ref);
    return { ref, bytes };
  };
  const json = (value: unknown) => object(JSON.parse(read(value).bytes.toString('utf8')));
  const refs = (value: unknown) => {
    requireWorkflow(Array.isArray(value), 'h01-series-evidence');
    return value.map((value) => read(value).ref);
  };
  const stop = (value: unknown, session?: string) => {
    const proof = json(value);
    refs(proof.evidence);
    return (
      proof.kind === `comparison-${label}-stop` &&
      proof.executionVersion === 2 &&
      proof.opId === input.opId &&
      proof.confirmed === true &&
      Array.isArray(proof.remainingProcesses) &&
      proof.remainingProcesses.length === 0 &&
      Array.isArray(proof.evidence) &&
      proof.evidence.length > 0 &&
      (session === undefined || (Array.isArray(proof.sessions) && proof.sessions.includes(session)))
    );
  };
  try {
    const request = parseH01Request(h01ReadJson(input.request), 'plan', scenario);
    const spec = parseH01OperatorSpec(h01ReadJson(input.spec), scenario);
    read(input.request);
    read(input.spec);
    const expectedHash = h01RequestHash(request);
    requireWorkflow(
      /^H-0[12345]:[12]:(?:baseline|candidate)$/u.test(input.runId) &&
        input.runId.startsWith(scenario + ':') &&
        input.runId.endsWith(':' + request.variant) &&
        request.opId === input.opId &&
        spec.opId === input.opId &&
        spec.variant === request.variant &&
        same(spec.budget, request.budget) &&
        same(spec.roots, request.roots),
      'h01-series-binding',
    );
    const delivered = object(input.operator),
      outer = json(delivered.report);
    const { report: _outerRef, ...outerDelivered } = delivered;
    requireWorkflow(same(outer, outerDelivered), 'h01-series-delivery');
    const bound = (report: Record<string, unknown>, kind: string) => {
      requireWorkflow(
        report.kind === kind &&
          report.opId === input.opId &&
          report.variant === request.variant &&
          report.requestHash === expectedHash &&
          report.partialScope === true &&
          report.qualification === false,
        'h01-series-report-binding',
      );
    };
    bound(outer, `comparison-${label}-operator-report`);
    requireWorkflow(
      outer.schemaVersion === 1 &&
        same(outer.specRef, input.spec) &&
        same(outer.requestRef, input.request),
      'h01-series-operator-binding',
    );
    const ownedDelivered = object(outer.child),
      owned = json(ownedDelivered.report);
    const { report: _ownedRef, ...ownedValue } = ownedDelivered;
    requireWorkflow(same(owned, ownedValue), 'h01-series-owned-delivery');
    bound(owned, `comparison-${label}-owned-report`);
    const child = json(owned.child);
    bound(child, `comparison-${label}-execution-report`);
    requireWorkflow(
      owned.executionVersion === 2 && child.executionVersion === 2,
      'h01-series-version',
    );
    const accounting = object(child.accounting);
    requireWorkflow(
      same(accounting, owned.accounting) && typeof accounting.unknown === 'boolean',
      'h01-series-accounting-binding',
    );
    requireWorkflow(Array.isArray(accounting.evidence), 'h01-series-accounting-evidence');
    const accountingEvidence = accounting.evidence as InputRef[];
    requireWorkflow(
      Array.isArray(accounting.participants) &&
        accounting.participants.length > 0 &&
        Array.isArray(accounting.receipts),
      'h01-series-accounting',
    );
    const observed: NativeComparisonReceipt[] = [];
    const completions: { participant: ComparisonParticipant; ref: InputRef | undefined }[] = [];
    const transcriptPins = new Map<string, InputRef>();
    for (const value of accounting.participants) {
      const participant = object(value) as unknown as ComparisonParticipant;
      requireWorkflow(
        participant.run === input.opId &&
          typeof participant.session === 'string' &&
          typeof participant.transcript === 'string',
        'h01-series-participant',
      );
      const bytes = h01RawFile(participant.transcript);
      const transcript = { locator: participant.transcript, hash: digest(bytes) };
      const previous = transcriptPins.get(participant.session);
      requireWorkflow(
        previous === undefined || same(previous, transcript),
        'h01-series-session-source',
      );
      transcriptPins.set(participant.session, transcript);
      const unsealed = participant.through === undefined;
      if (unsealed) summary.blocking.push('usage-unsealed');
      const receipts = readComparisonUsage(participant, unsealed);
      requireWorkflow(h01RawFile(participant.transcript).equals(bytes), 'h01-series-usage-changed');
      requireWorkflow(
        new Set([...observed, ...receipts].map((receipt) => receipt.id)).size ===
          observed.length + receipts.length,
        'h01-series-duplicate-usage',
      );
      for (const [index, name] of metricNames.entries()) {
        const metric = receiptNames[index]!;
        const next =
          summary.knownSubtotal[name] +
          receipts.reduce((sum, receipt) => sum + (receipt[metric] ?? 0), 0);
        requireWorkflow(integer(next), 'h01-series-usage-overflow');
        summary.knownSubtotal[name] = next;
      }
      observed.push(...receipts);
      const completed = accountingEvidence.find(
        (ref) => basename(ref.locator) === `complete-${digest(participant.session)}.json`,
      );
      completions.push({ participant, ref: completed });
    }
    const order = (values: NativeComparisonReceipt[]) =>
      [...values].sort((a, b) => a.id.localeCompare(b.id));
    for (const [index, name] of metricNames.entries()) {
      const metric = receiptNames[index]!;
      const declared = accounting[name];
      requireWorkflow(
        declared === null ||
          (integer(declared) &&
            observed.every((receipt) => receipt[metric] !== null) &&
            declared === summary.knownSubtotal[name]),
        'h01-series-usage-total',
      );
      summary.accounting[name] = declared as number | null;
    }
    requireWorkflow(
      same(order(observed), order(accounting.receipts as NativeComparisonReceipt[])),
      'h01-series-primary-usage',
    );
    const budgets = accountingEvidence
      .filter((ref) => /^budget-[0-9]{16}\.json$/u.test(basename(ref.locator)))
      .map(json);
    const latest = budgets.sort((a, b) => Number(a.used) - Number(b.used)).at(-1);
    if (accounting.reservedManagedStarts !== null) {
      requireWorkflow(
        latest !== undefined &&
          integer(latest.used) &&
          latest.limit === request.budget.maxManagedStarts &&
          latest.used === accounting.reservedManagedStarts,
        'h01-series-budget-evidence',
      );
      const manifest = object(latest.manifest);
      const manifestBytes = read({
        locator: join(request.roots.artifactRoot, textField(manifest.sha256)),
        hash: manifest.sha256,
      }).bytes;
      const budget = object(JSON.parse(manifestBytes.toString('utf8')));
      requireWorkflow(
        manifestBytes.length === manifest.bytes &&
          budget.kind === 'task-model-budget' &&
          budget.schemaVersion === 1 &&
          budget.limit === latest.limit &&
          Array.isArray(budget.credits) &&
          budget.credits.length === latest.used,
        'h01-series-budget-manifest',
      );
      summary.accounting.reservedManagedStarts = latest.used;
    }
    summary.accounting.unknown =
      accounting.unknown ||
      summary.accounting.reservedManagedStarts === null ||
      metricNames.some((name) => summary.accounting[name] === null);

    const checks = object(child.checks);
    requireWorkflow(
      same(Object.keys(checks).sort(), [...requiredChecks].sort()) &&
        Object.values(checks).every((value) => typeof value === 'boolean'),
      'h01-series-checks',
    );
    summary.checks = checks as Record<string, boolean>;
    refs(outer.evidence);
    refs(owned.evidence);
    refs(child.evidence);
    refs(accounting.evidence);
    if (child.nativeAcceptance !== null) read(child.nativeAcceptance);
    let participantsStopped = true;
    for (const { participant, ref } of completions) {
      if (ref === undefined) participantsStopped = false;
      else {
        const completion = json(ref);
        requireWorkflow(same(completion.participant, participant), 'h01-series-completion-binding');
        const result = object(completion.completion);
        refs(result.evidence);
        participantsStopped =
          stop(result.stop, participant.session) &&
          result.outcome !== 'unknown' &&
          participantsStopped;
      }
    }

    const keeper = json(owned.stop);
    refs(keeper.evidence);
    const keeperStopped =
      keeper.kind === `${label}-keeper-stop` &&
      keeper.opId === input.opId &&
      keeper.stopped === true &&
      keeper.ready === true &&
      keeper.softStop === false &&
      keeper.forcedStop === false &&
      keeper.error === null &&
      keeper.signal === null &&
      keeper.killed === false &&
      keeper.deadlineReached === false;
    requireWorkflow(
      Array.isArray(outer.stops) && Array.isArray(outer.portStops),
      'h01-series-outer-stop',
    );
    const stops = outer.stops.map(object);
    const names = spec.temporal === undefined ? [label] : [label, 'server'];
    const processStops =
      same(stops.map((entry) => entry.name).sort(), names.sort()) &&
      stops.every((entry) => {
        const receipt = object(entry.receipt);
        return (
          entry.error === null &&
          Number.isSafeInteger(entry.pid) &&
          Number(entry.pid) > 0 &&
          receipt.stopped === true &&
          receipt.killed === false &&
          receipt.deadlineReached === false &&
          (entry.name === 'server'
            ? receipt.code === 0 || receipt.signal === 'SIGTERM'
            : integer(receipt.code) && receipt.signal === null)
        );
      });
    const addresses =
      spec.temporal === undefined
        ? []
        : [spec.temporal.address, spec.temporal.httpAddress, spec.temporal.metricsAddress];
    const portStops = outer.portStops.map(object);
    const portsStopped =
      same(portStops.map((entry) => entry.address).sort(), addresses.sort()) &&
      portStops.every((entry) => entry.closed === true);
    const primaryOuter = (outer.evidence as InputRef[]).map((ref) => ({
      ref,
      value:
        basename(ref.locator).startsWith('stop-') ||
        basename(ref.locator).startsWith('ports-stopped-')
          ? json(ref)
          : null,
    }));
    const primaryProcesses = stops.every((entry) =>
      primaryOuter.some(
        ({ ref, value }) =>
          basename(ref.locator).startsWith(`stop-${String(entry.name)}-`) &&
          same(value, {
            ...object(entry.receipt),
            pid: entry.pid,
            error: entry.error,
            owned: true,
          }),
      ),
    );
    const primaryPorts = primaryOuter.some(
      ({ ref, value }) =>
        basename(ref.locator).startsWith('ports-stopped-') &&
        same(value, { portStops: outer.portStops }),
    );
    summary.stopped =
      stop(child.stop) &&
      participantsStopped &&
      keeperStopped &&
      processStops &&
      portsStopped &&
      primaryProcesses &&
      primaryPorts;
    if (!summary.stopped) summary.blocking.push('stop-unconfirmed');
    if (summary.accounting.unknown) summary.blocking.push('accounting-unknown');
    const timing = owned.timing as ComparisonTiming;
    const elapsed = comparisonDuration(timing.start, timing.end);
    if (elapsed === null || elapsed !== owned.elapsedMs) summary.blocking.push('timing-unknown');
    const outcomes = [outer.outcome, owned.outcome, child.outcome];
    const startedNs = BigInt(textField(outer.startedNs)),
      endedNs = BigInt(textField(outer.endedNs));
    const operatorElapsedMs = Number(endedNs - startedNs) / 1_000_000;
    requireWorkflow(
      startedNs >= 0n &&
        endedNs >= startedNs &&
        Number.isFinite(operatorElapsedMs) &&
        operatorElapsedMs === outer.elapsedMs &&
        same(outer.budget, request.budget),
      'h01-series-operator-timing',
    );
    summary.operatorElapsedMs = operatorElapsedMs;
    summary.startedNs = String(startedNs);
    summary.endedNs = String(endedNs);
    if (
      operatorElapsedMs >= request.budget.maxElapsedMs ||
      endedNs >= BigInt(textField(outer.deadlineNs))
    )
      summary.blocking.push('operator-deadline');
    const allChecks = Object.values(checks).every(Boolean);
    const finalStop = json(child.stop),
      finalEvidence = refs(finalStop.evidence);
    let councilAccepted = false,
      checkerPassed = false;
    if (scenario === 'H-01') {
      const council = (accounting.participants as ComparisonParticipant[]).filter(
        (participant) => participant.stage === 'council',
      );

      for (const ref of finalEvidence) {
        if (!basename(ref.locator).startsWith('answer-')) continue;
        const answer = json(ref);
        if (
          !council.some((participant) => answer.thread === participant.session) ||
          answer.status !== 'completed' ||
          typeof answer.text !== 'string'
        )
          continue;
        const result = object(JSON.parse(answer.text)),
          nativeStop = json(answer.stopped);
        councilAccepted =
          result.outcome === 'accepted' &&
          same(result.checks, checks) &&
          nativeStop.kind === 'writers-stopped' &&
          nativeStop.active_turn === false &&
          nativeStop.remaining_terminals === 0 &&
          nativeStop.remaining_processes === 0 &&
          typeof nativeStop.before_hash === 'string' &&
          /^[a-f0-9]{64}$/u.test(nativeStop.before_hash) &&
          nativeStop.before_hash === nativeStop.after_hash &&
          Array.isArray(nativeStop.processes);
      }
      for (const ref of child.evidence as InputRef[]) {
        if (!basename(ref.locator).startsWith('checker-')) continue;
        const proof = json(ref);
        if (proof.kind !== 'comparison-h01-check') continue;
        read(proof.stdout);
        read(proof.stderr);
        const receipt = object(proof.stop);
        checkerPassed =
          proof.passed === true &&
          receipt.stopped === true &&
          receipt.code === 0 &&
          receipt.signal === null &&
          receipt.killed === false &&
          receipt.deadlineReached === false;
      }
    } else {
      councilAccepted =
        scenario === 'H-02'
          ? verifyH02()
          : scenario === 'H-03'
            ? verifyH03()
            : scenario === 'H-04'
              ? verifyH04()
              : verifyH05();
      checkerPassed = councilAccepted;
    }
    function verifyH02() {
      const projection = json(child.projection);
      requireWorkflow(
        projection.kind === 'comparison-h02-native-projection' &&
          projection.scenario === 'H-02' &&
          projection.opId === input.opId &&
          projection.engine === (request.variant === 'baseline' ? 'legacy' : 'temporal'),
        'h02-series-projection',
      );
      const report = json(projection.caseReport);
      refs(report.evidence);
      requireWorkflow(
        report.outcome === 'accepted' &&
          Array.isArray(report.blocking) &&
          report.blocking.length === 0 &&
          same(report.checks, checks) &&
          Object.values(checks).every(Boolean),
        'h02-series-case',
      );
      const effects = object(report.effects),
        phases = object(effects.byPhase);
      const expected = request.variant === 'baseline' ? 3 : 4;
      requireWorkflow(
        effects.threadStarts === expected &&
          effects.turnStarts === 8 &&
          accounting.reservedManagedStarts === 8,
        'h02-series-effects',
      );
      const sessions = (accounting.participants as ComparisonParticipant[]).map(
        (row) => row.session,
      );
      requireWorkflow(sessions.length === expected, 'h02-series-sessions');
      const artifact = (value: unknown) => {
        const ref = object(value);
        const source = {
          locator: join(request.roots.artifactRoot, textField(ref.sha256)),
          hash: ref.sha256,
        };
        const bytes = read(source).bytes;
        requireWorkflow(bytes.length === ref.bytes, 'h02-series-artifact');
        return object(JSON.parse(bytes.toString()));
      };
      if (request.variant === 'baseline') {
        const round = (ref: unknown) => {
          const value = read(ref);
          return object(decodeChatArtifact(dirname(value.ref.locator), value.bytes.toString()));
        };
        const rounds = object(report.rounds),
          initial = round(rounds.initial),
          corrected = round(rounds.corrected);
        const before = object(object(initial.council).advisers),
          after = object(object(corrected.council).advisers);
        requireWorkflow(
          initial.kind === 'h02-initial-council' && corrected.kind === 'h02-corrected-council',
          'h02-series-round',
        );
        requireWorkflow(
          object(object(before.pricing).answer).verdict === 'FAIL' &&
            object(object(after.pricing).answer).verdict === 'PASS',
          'h02-series-verdicts',
        );
        for (const role of ['logging', 'storage']) {
          const answer = object(object(before[role]).answer);
          requireWorkflow(
            answer.verdict === 'PASS' &&
              answer.coverage === 'complete' &&
              same(before[role], after[role]),
            'h02-series-reuse',
          );
        }
        requireWorkflow(same(child.nativeAcceptance, rounds.corrected), 'h02-series-acceptance');
        requireWorkflow(Array.isArray(report.localRpcObservations), 'h02-series-turns');
        const observations = report.localRpcObservations.map(object),
          reviews = observations.filter((row) => row.kind === 'review');
        requireWorkflow(
          observations.length === 8 &&
            reviews.length === 4 &&
            same(
              reviews
                .slice(0, 3)
                .map((row) => row.role)
                .sort(),
              ['logging', 'pricing', 'storage'],
            ) &&
            reviews[3]!.role === 'pricing' &&
            observations.every((row) => sessions.includes(textField(row.session))),
          'h02-series-turns',
        );
        requireWorkflow(
          same(phases.initial, { threadStarts: 3, turnStarts: 6 }) &&
            same(phases.correction, { threadStarts: 0, turnStarts: 2 }) &&
            same(phases.probes, { threadStarts: 0, turnStarts: 0 }),
          'h02-series-phases',
        );
        const probes = object(report.probes);
        requireWorkflow(
          same(Object.keys(probes).sort(), [...requiredChecks].sort()),
          'h02-series-probes',
        );
        const outcomes = Object.fromEntries(
          Object.entries(probes).map(([name, pin]) => {
            const proof = round(pin);
            requireWorkflow(proof.kind === 'h02-' + name, 'h02-series-probe-kind');
            return [name, proof];
          }),
        );
        const roles = ['pricing', 'logging', 'storage'];
        const statuses = (name: string, running: string[]) => {
          const advisers = object(object(outcomes[name]!.council).advisers);
          requireWorkflow(
            same(Object.keys(advisers).sort(), [...roles].sort()),
            'h02-series-probe-roles',
          );
          for (const role of roles)
            requireWorkflow(
              running.includes(role)
                ? object(advisers[role]).status === 'running'
                : object(advisers[role]).status === 'answered' && same(advisers[role], after[role]),
              'h02-series-probe-status',
            );
        };
        statuses('unchanged-pass', []);
        statuses('changed-dependency', ['pricing']);
        const changedBasis = object(outcomes['changed-dependency']!.basis);
        requireWorkflow(
          changedBasis.inputs === 'changed' &&
            changedBasis.requirements === 'changed' &&
            changedBasis.rationale === 'unchanged',
          'h02-series-probe-basis',
        );
        statuses('new-dependency', ['pricing']);
        requireWorkflow(
          same(outcomes['new-dependency']!.roles, ['pricing']),
          'h02-series-probe-roles',
        );
        statuses('shared-scope', roles);
        const rationale = outcomes['role-rationale']!,
          basis = object(rationale.basis);
        requireWorkflow(
          same(rationale.roles, ['pricing']) &&
            basis.rationale === 'changed' &&
            basis.inputs === 'applicable' &&
            basis.requirements === 'unchanged',
          'h02-series-probe-basis',
        );
        requireWorkflow(
          same(outcomes['open-fail']!.blockers, ['pricing:unresolved-failure']) &&
            same(outcomes['open-fail']!.history, object(initial.council).history),
          'h02-series-probe-open-fail',
        );
        const incomplete = outcomes['incomplete-map']!,
          missingBasis = object(incomplete.missingBasis),
          incompleteBasis = object(incomplete.incompleteBasis);
        const base = object(corrected.council),
          removed = { ...object(base.selection) };
        delete removed.pricing;
        const partial = structuredClone(base);
        object(object(object(partial.selection).pricing).inputs).complete = false;
        requireWorkflow(
          incomplete.missingError === 'missing-role-selection' &&
            incomplete.incompleteError === 'pricing:incomplete-inputs' &&
            same(
              [...configuredRoles(missingBasis.configuration as CouncilConfiguration)].sort(),
              [...roles].sort(),
            ) &&
            same(missingBasis.configuration, base.configuration) &&
            missingBasis.phase === base.phase &&
            same(missingBasis.selection, removed) &&
            same(missingBasis.target, base.target) &&
            same(incompleteBasis.council, partial) &&
            same(incompleteBasis.target, base.target),
          'h02-series-probe-incomplete',
        );
      } else {
        requireWorkflow(
          projection.sdk === true &&
            Array.isArray(projection.workflowEvidence) &&
            projection.workflowEvidence.length === 2,
          'h02-series-sdk',
        );
        requireWorkflow(
          Array.isArray(report.rounds) && report.rounds.length === 2,
          'h02-series-round',
        );
        const rounds = report.rounds.map(object),
          initial = rounds[0]!,
          repaired = rounds[1]!;
        requireWorkflow(
          initial.name === 'initial' && repaired.name === 'repaired',
          'h02-series-round',
        );
        const initialReaders = (initial.readers as unknown[]).map(object),
          repairedReaders = (repaired.readers as unknown[]).map(object);
        requireWorkflow(
          initialReaders.length === 3 &&
            repairedReaders.length === 1 &&
            repairedReaders[0]!.roleId === 'pricing' &&
            [...initialReaders, ...repairedReaders].every((row) =>
              sessions.includes(textField(row.session)),
            ),
          'h02-series-readers',
        );
        requireWorkflow(
          same(
            initialReaders.map((row) => object(artifact(row.answer).report).verdict),
            ['FAIL', 'PASS', 'PASS'],
          ) && object(artifact(repairedReaders[0]!.answer).report).verdict === 'PASS',
          'h02-series-verdicts',
        );
        const decisions = (object(repaired.plan).decisions as unknown[]).map(object);
        requireWorkflow(
          same(
            decisions.map((row) => row.action),
            ['review', 'reuse', 'reuse'],
          ) &&
            same(decisions[1]!.answer, initialReaders[1]!.answer) &&
            same(decisions[2]!.answer, initialReaders[2]!.answer) &&
            object(initial.completion).complete === false &&
            object(repaired.completion).complete === true,
          'h02-series-reuse',
        );
        requireWorkflow(
          same(phases.initial, { threadStarts: 3, turnStarts: 6 }) &&
            same(phases.repaired, { threadStarts: 1, turnStarts: 2 }),
          'h02-series-phases',
        );
        for (const [name, value] of Object.entries(phases))
          if (name !== 'initial' && name !== 'repaired')
            requireWorkflow(same(value, { threadStarts: 0, turnStarts: 0 }), 'h02-series-phases');
        const accepted = object(object(repaired.completion).manifest);
        requireWorkflow(
          same(child.nativeAcceptance, {
            locator: join(request.roots.artifactRoot, textField(accepted.sha256)),
            hash: accepted.sha256,
          }),
          'h02-series-acceptance',
        );
        requireWorkflow(Array.isArray(report.probes), 'h02-series-probes');
        const probeNames = [
          'unchanged',
          'changed-dependency',
          'new-dependency',
          'shared-scope',
          'role-rationale',
          'open-FAIL',
          'missing-role',
          'incomplete-map',
        ];
        const probes = report.probes.map(object);
        requireWorkflow(
          same(probes.map((row) => row.name).sort(), [...probeNames].sort()),
          'h02-series-probes',
        );
        const baselineAnswers = [
          repairedReaders[0]!.answer,
          initialReaders[1]!.answer,
          initialReaders[2]!.answer,
        ];
        for (const probe of probes) {
          const name = textField(probe.name);
          requireWorkflow(
            same(phases[name], { threadStarts: 0, turnStarts: 0 }),
            'h02-series-probe-effect',
          );
          if (name === 'missing-role') {
            requireWorkflow(
              probe.plan === null &&
                probe.completion === null &&
                probe.error === 'review-role-selection-incomplete',
              'h02-series-probe-missing-role',
            );
            const failures = (report.evidence as InputRef[])
              .map(json)
              .filter(
                (proof) => proof.kind === 'h02-temporal-probe-failure' && proof.name === name,
              );
            requireWorkflow(
              failures.length === 1 && failures[0]!.error === probe.error,
              'h02-series-probe-missing-role',
            );
            const failedInput = object(failures[0]!.request),
              failedRequest = artifact(failedInput.request);
            requireWorkflow(
              same(failedInput.preparation, object(initial.input).preparation) &&
                failedInput.reviewId === 'h02-' + name &&
                Array.isArray(failedRequest.roles) &&
                same(
                  failedRequest.roles.map((role) => object(role).roleId),
                  ['pricing', 'logging'],
                ),
              'h02-series-probe-missing-role',
            );
            continue;
          }
          requireWorkflow(probe.error === null, 'h02-series-probe-error');
          const plan = object(probe.plan),
            primary = artifact(plan.manifest),
            primaryInput = object(primary.input);
          const decisions = (plan.decisions as unknown[]).map(object);
          requireWorkflow(
            primary.kind === 'reader-review-plan' &&
              primary.schemaVersion === 1 &&
              same(primary.decisions, plan.decisions) &&
              same(primaryInput.preparation, object(initial.input).preparation) &&
              primaryInput.reviewId === 'h02-' + name &&
              same(artifact(primaryInput.request), primary.request) &&
              same(
                decisions.map((row) => row.roleId),
                ['pricing', 'logging', 'storage'],
              ),
            'h02-series-probe-plan',
          );
          const actions =
            name === 'unchanged'
              ? ['reuse', 'reuse', 'reuse']
              : name === 'shared-scope'
                ? ['review', 'review', 'review']
                : ['review', 'reuse', 'reuse'];
          requireWorkflow(
            same(
              decisions.map((row) => row.action),
              actions,
            ),
            'h02-series-probe-actions',
          );
          const reason = {
            unchanged: 'complete-pass-with-unchanged-inputs',
            'changed-dependency': 'input-changed:pricing.json',
            'new-dependency': 'input-changed:logging.json',
            'shared-scope': 'review-target-changed',
            'role-rationale': 'role-obligation-changed',
            'open-FAIL': 'open-failure',
            'incomplete-map': 'dependencies-unknown',
          }[name]!;
          for (const [index, row] of decisions.entries()) {
            const required =
              name === 'shared-scope' || index === 0
                ? reason
                : 'complete-pass-with-unchanged-inputs';
            requireWorkflow(
              Array.isArray(row.reasons) &&
                row.reasons.includes(required) &&
                (row.action !== 'reuse' || same(row.answer, baselineAnswers[index])),
              'h02-series-probe-reason',
            );
          }
          if (name === 'incomplete-map') {
            const completion = object(probe.completion),
              primary = artifact(completion.manifest);
            requireWorkflow(
              completion.complete === false &&
                primary.kind === 'reader-review-result' &&
                primary.complete === false &&
                same(primary.input, primaryInput) &&
                same(primary.plan, plan.manifest),
              'h02-series-probe-completion',
            );
          } else requireWorkflow(probe.completion === null, 'h02-series-probe-completion');
        }
        const workflowProofs = projection.workflowEvidence.map(json);
        requireWorkflow(
          same(workflowProofs.map((proof) => proof.round).sort(), ['initial', 'repaired']),
          'h02-series-workflow',
        );
        for (const proof of workflowProofs) {
          const round = rounds.find((row) => row.name === proof.round);
          requireWorkflow(
            proof.kind === 'comparison-h02-review-workflow-proof' &&
              proof.scenario === 'H-02' &&
              proof.opId === input.opId &&
              round !== undefined &&
              proof.status === 'COMPLETED' &&
              proof.workflowId === reviewKey(proof.input as ReviewInput) &&
              same(proof.input, round.input),
            'h02-series-workflow',
          );
          textField(proof.runId);
          const result = object(proof.result);
          requireWorkflow(
            result.status === 'reviewed' &&
              same(result.plan, object(round.plan).manifest) &&
              same(result.manifest, object(round.completion).manifest) &&
              result.complete === object(round.completion).complete,
            'h02-series-workflow-result',
          );
          const historyProof = json(proof.history);
          requireWorkflow(
            historyProof.kind === 'comparison-h02-review-history' &&
              historyProof.scenario === 'H-02' &&
              historyProof.opId === input.opId &&
              historyProof.round === proof.round &&
              historyProof.workflowId === proof.workflowId &&
              historyProof.runId === proof.runId,
            'h02-series-history',
          );
          const history = proto.temporal.api.history.v1.History.fromObject(
            object(historyProof.history),
          );
          const events = history.events.map(object);
          const decoded = (value: unknown) => {
            const payloads = object(value).payloads;
            requireWorkflow(
              Array.isArray(payloads) && payloads.length === 1,
              'h02-series-history-payload',
            );
            return defaultPayloadConverter.fromPayload<unknown>(
              proto.temporal.api.common.v1.Payload.fromObject(object(payloads[0])),
            );
          };
          const start = events.find((row) => row.workflowExecutionStartedEventAttributes != null);
          requireWorkflow(
            start !== undefined &&
              object(object(start.workflowExecutionStartedEventAttributes).workflowType).name ===
                'ReviewWorkflow' &&
              object(start.workflowExecutionStartedEventAttributes).originalExecutionRunId ===
                proof.runId,
            'h02-series-history',
          );
          requireWorkflow(
            same(decoded(object(start.workflowExecutionStartedEventAttributes).input), proof.input),
            'h02-series-history-input',
          );
          const initiated = events
            .filter((row) => row.startChildWorkflowExecutionInitiatedEventAttributes != null)
            .map((row) => object(row.startChildWorkflowExecutionInitiatedEventAttributes));
          const planned = (object(round.plan).decisions as unknown[])
            .map(object)
            .filter((row) => row.action === 'review');
          for (const row of initiated) {
            const expected = planned.find(
              (decision) => readerKey(decision.input as ReaderInput) === row.workflowId,
            );
            requireWorkflow(
              expected !== undefined && same(decoded(row.input), expected.input),
              'h02-series-history-child-input',
            );
          }
          const completed = events.filter(
            (row) => row.workflowExecutionCompletedEventAttributes != null,
          );
          requireWorkflow(
            completed.length === 1 &&
              same(
                decoded(object(completed[0]!.workflowExecutionCompletedEventAttributes).result),
                proof.result,
              ),
            'h02-series-history-result',
          );
          requireWorkflow(
            same(
              initiated.map((row) => row.workflowId).sort(),
              planned.map((row) => readerKey(row.input as ReaderInput)).sort(),
            ) &&
              initiated.every(
                (row) => object(row.workflowType).name === 'ControlledReaderWorkflow',
              ) &&
              events.some((row) => row.workflowExecutionCompletedEventAttributes != null),
            'h02-series-history',
          );
        }
      }
      return true;
    }
    function verifyH03() {
      const projection = json(child.projection),
        report = json(projection.caseReport);
      const engine = request.variant === 'baseline' ? 'legacy' : 'temporal';
      requireWorkflow(
        projection.kind === 'comparison-h03-native-projection' &&
          projection.scenario === 'H-03' &&
          projection.opId === input.opId &&
          projection.engine === engine &&
          report.kind === 'comparison-h03-case' &&
          report.scenario === 'H-03' &&
          report.opId === input.opId &&
          report.engine === engine &&
          report.outcome === 'accepted' &&
          same(report.checks, checks) &&
          Object.values(checks).every(Boolean) &&
          Array.isArray(report.blocking) &&
          report.blocking.length === 0 &&
          report.nativeAcceptance === false &&
          report.qualification === false &&
          report.partialScope === true,
        'h03-series-case',
      );
      const session = textField(report.session),
        participants = accounting.participants as ComparisonParticipant[];
      requireWorkflow(
        participants.length === 1 &&
          participants[0]!.session === session &&
          participants[0]!.stage === 'execution',
        'h03-series-session',
      );
      const participant = participants[0]!,
        transcript = h01RawFile(participant.transcript).toString();
      requireWorkflow(transcript.endsWith('\n'), 'h03-series-history-partial');
      const records = transcript
        .slice(0, -1)
        .split('\n')
        .map((line, index) => ({
          line: index + 1,
          raw: object(JSON.parse(line)),
          ref: {
            locator: participant.transcript + '#L' + String(index + 1),
            hash: digest(line + '\n'),
          },
        }));
      const nativeLine = (value: unknown, path = participant.transcript) => {
        const ref = object(value),
          match = textField(ref.locator).match(/^(.*)#L([1-9]\d*)$/u);
        requireWorkflow(match !== null && match[1] === path, 'h03-series-native-line');
        const bytes = h01RawFile(path).toString();
        requireWorkflow(bytes.endsWith('\n'), 'h03-series-history-partial');
        const row = bytes.slice(0, -1).split('\n')[Number(match![2]) - 1];
        requireWorkflow(
          row !== undefined && digest(row + '\n') === ref.hash,
          'h03-series-native-line',
        );
        const pin = { locator: textField(ref.locator), hash: textField(ref.hash) };
        evidence.set(pin.locator, pin);
        return { line: Number(match![2]), raw: object(JSON.parse(row!)), ref: pin };
      };
      refs(report.evidence);
      requireWorkflow(stop(report.stop, session), 'h03-series-stop');
      const initial = object(report.initial),
        recovered = object(report.recovered),
        compact = object(report.compaction),
        retained = object(report.retained);
      const context = json(report.context),
        failureContext = object(context.failure),
        pendingContext = object(context.pending);
      requireWorkflow(
        object(report.context).locator === join(request.roots.workspaceRoot, h03ContextPath) &&
          context.kind === 'comparison-h03-context' &&
          context.opId === input.opId &&
          context.requestHash === expectedHash &&
          same(context.identity, request.identity) &&
          failureContext.id === 'F-01' &&
          same(failureContext.source, retained.failure) &&
          same(pendingContext.source, retained.pending) &&
          failureContext.text === read(retained.failure).bytes.toString() &&
          pendingContext.text === read(retained.pending).bytes.toString(),
        'h03-series-observed-context',
      );
      const before = nativeLine(compact.before),
        boundary = nativeLine(compact.boundary),
        descriptor = json(compact.receipt),
        dispatch = json(compact.request),
        start = object(dispatch.start);
      requireWorkflow(
        boundary.raw.type === 'compacted' &&
          boundary.line > before.line &&
          descriptor.kind === 'comparison-native-compaction' &&
          descriptor.scenario === 'H-03' &&
          descriptor.opId === input.opId &&
          descriptor.session === session &&
          same(descriptor.before, compact.before) &&
          same(descriptor.boundary, compact.boundary) &&
          same(descriptor.request, compact.request) &&
          same(descriptor.usage, compact.usage),
        'h03-series-compaction',
      );
      requireWorkflow(
        dispatch.kind === 'comparison-native-compaction-dispatch' &&
          dispatch.scenario === 'H-03' &&
          dispatch.opId === input.opId &&
          dispatch.method === 'thread/compact/start' &&
          same(dispatch.before, compact.before) &&
          object(dispatch.params).threadId === session &&
          start.session === session &&
          start.method === 'thread/compact/start' &&
          same(start.before, compact.before) &&
          start.hash === digest(canonical(dispatch.params)),
        'h03-series-compaction-dispatch',
      );
      const guardStart = accountingEvidence.find(
        (ref) => basename(ref.locator) === 'start-' + String(start.key) + '.json',
      );
      const guardConfirmation = accountingEvidence.find(
        (ref) => basename(ref.locator) === 'confirmed-' + String(start.key) + '.json',
      );
      requireWorkflow(
        guardStart !== undefined &&
          guardConfirmation !== undefined &&
          same(json(guardStart), start),
        'h03-series-compaction-ledger',
      );
      const confirmed = json(guardConfirmation),
        through = nativeLine(descriptor.through);
      requireWorkflow(
        confirmed.kind === 'comparison-native-compaction-confirmation' &&
          confirmed.key === start.key &&
          confirmed.session === session &&
          same(confirmed.before, compact.before) &&
          same(confirmed.boundary, compact.boundary) &&
          same(confirmed.evidence, compact.request) &&
          same(confirmed.through, descriptor.through) &&
          through.line >= boundary.line,
        'h03-series-compaction-ledger',
      );
      const priorTurn = verifyNativeCompactionBarrier(participant, before.ref).turn;
      const usage = verifyNativeCompactionSpan(participant, {
        before: before.ref,
        boundary: boundary.ref,
        through: through.ref,
      });
      requireWorkflow(
        same(usage, confirmed.usage) &&
          same(
            usage.map((receipt) => receipt.source),
            compact.usage,
          ) &&
          usage.every((receipt) => observed.some((global) => same(global, receipt))),
        'h03-series-compaction-usage',
      );
      requireWorkflow(
        same(child.nativeAcceptance, recovered.load) && !same(initial.load, recovered.load),
        'h03-series-native-acceptance',
      );
      const checker = (pin: unknown) => {
        const proof = json(pin),
          receipt = object(proof.stop);
        read(proof.stdout);
        read(proof.stderr);
        requireWorkflow(
          proof.kind === 'comparison-h03-check' &&
            proof.opId === input.opId &&
            proof.requestHash === expectedHash &&
            same(proof.material, request.material) &&
            proof.cwd === request.roots.workspaceRoot &&
            proof.passed === false &&
            receipt.stopped === true &&
            integer(receipt.code) &&
            Number(receipt.code) > 0 &&
            receipt.signal === null &&
            receipt.killed === false &&
            receipt.deadlineReached === false,
          'h03-series-initial-fail',
        );
      };
      const artifact = (value: unknown) => {
        const ref = object(value),
          source = {
            locator: join(request.roots.artifactRoot, textField(ref.sha256)),
            hash: textField(ref.sha256),
          },
          raw = read(source).bytes;
        requireWorkflow(raw.length === ref.bytes, 'h03-series-artifact');
        return object(JSON.parse(raw.toString()));
      };
      const probeRows = object(report.probes);
      requireWorkflow(
        same(Object.keys(probeRows).sort(), [...h03ProbeNames].sort()),
        'h03-series-probes',
      );
      if (engine === 'legacy') {
        const load = (pin: unknown, fresh: boolean) => {
          const proof = json(pin),
            run = proof.run as LocalRun,
            receipt = proof.receipt as LoadReceipt,
            host = object(proof.host),
            anchor = object(host.anchor);
          requireWorkflow(
            proof.kind === 'comparison-h03-native-load' &&
              proof.session === session &&
              host.root === request.roots.workspaceRoot &&
              host.transcript === participant.transcript &&
              anchor.thread_id === session &&
              anchor.turn_id === proof.turn &&
              anchor.workspace === host.root &&
              run.spec.session_id === session &&
              run.spec.run_id === input.opId &&
              run.spec.workspace === host.root,
            'h03-series-load',
          );
          const profile = parseH01Profile(request.profile),
            metadata = h03PreparedMetadata(
              h01ReadPin(profile.rules).toString(),
              h01ReadPin(profile.executor).toString(),
            );
          const expectedRules = ['.h03/rules.md', '.h03/executor.md']
            .map((locator) => ({ locator, hash: digest(metadata[locator]!) }))
            .concat({ locator: h03ContextPath, hash: object(report.context).hash as string });
          requireWorkflow(same(run.spec.rules, expectedRules), 'h03-series-context-rule');
          confirmLoad(run, receipt);
          const expected = [...receipt.procedures, ...receipt.rules],
            assembled = new Map<string, string>();
          const readRefs = JSON.parse(receipt.observed_read) as unknown[];
          requireWorkflow(Array.isArray(readRefs) && readRefs.length > 0, 'h03-series-read');
          for (const pin of new Map(readRefs.map((ref) => [canonical(ref), ref])).values()) {
            const row = nativeLine(pin),
              payload = object(row.raw.payload),
              item = object(payload.item);
            requireWorkflow(
              (fresh ? row.line > boundary.line : row.line < before.line) &&
                row.raw.type === 'event_msg' &&
                payload.type === 'item_completed' &&
                payload.thread_id === session &&
                payload.turn_id === proof.turn &&
                item.type === 'CommandExecution' &&
                item.status === 'completed' &&
                item.exit_code === 0 &&
                item.cwd === request.roots.workspaceRoot,
              'h03-series-read',
            );
            for (const line of textField(item.aggregated_output)
              .split('\n')
              .filter((line) => line.startsWith('{"chat_read":' + JSON.stringify(proof.marker)))) {
              const entry = object(JSON.parse(line)),
                locator = textField(entry.locator),
                content = textField(entry.content),
                declared = expected.find((ref) => ref.locator === locator);
              requireWorkflow(
                declared !== undefined && declared.hash === entry.hash,
                'h03-series-read-source',
              );
              if (entry.offset !== undefined) {
                const prior = assembled.get(locator) ?? '';
                requireWorkflow(
                  readFragmentFits(prior, content, entry.offset, entry.length),
                  'h03-series-read-fragment',
                );
                assembled.set(locator, prior + content);
              } else {
                requireWorkflow(!assembled.has(locator), 'h03-series-read-duplicate');
                assembled.set(locator, content);
              }
            }
          }
          for (const ref of expected)
            requireWorkflow(
              assembled.has(ref.locator) &&
                digest(assembled.get(ref.locator)!) === ref.hash &&
                digest(h01RawFile(join(request.roots.workspaceRoot, ref.locator))) === ref.hash,
              'h03-series-read-complete',
            );
          if (fresh) {
            requireWorkflow(
              receipt.compact === undefined &&
                receipt.compact_fallback === 'chat-compact-read-unconfirmed',
              'h03-series-full-load',
            );
            requireLoadedProcedures({ ...run, loaded: receipt }, [...h03Procedures]);
          }
          return proof;
        };
        const first = load(initial.load, false),
          final = load(recovered.load, true);
        requireWorkflow(
          first.turn === priorTurn &&
            first.turn !== final.turn &&
            same(object(first.run).spec, object(final.run).spec) &&
            !same(object(first.receipt).observed_read, object(final.receipt).observed_read),
          'h03-series-fresh-load',
        );
        const beforeState = json(retained.before),
          afterState = json(retained.after),
          failure = json(retained.failure),
          pending = json(retained.pending);
        requireWorkflow(
          same(initial.state, retained.before) &&
            same(recovered.state, retained.after) &&
            beforeState.kind === 'comparison-h03-state' &&
            afterState.kind === beforeState.kind &&
            failure.kind === 'comparison-h03-initial-failure' &&
            pending.kind === 'comparison-h03-pending-intent',
          'h03-series-state',
        );
        checker(failure.check);
        const mutation = (proof: Record<string, unknown>) => {
          const request = proof.request as StoreRequest,
            command = object(request.command),
            change = object(command.change),
            reply = object(proof.reply);
          requireWorkflow(
            command.type === 'mutate' &&
              object(command.mutation).payload_hash === requestHash(request) &&
              textField(object(command.mutation).operation_id).startsWith(input.opId + ':') &&
              object(request.context).actor_id === session &&
              reply.ok === true &&
              object(reply.value).operation_id === object(command.mutation).operation_id,
            'h03-series-state-write',
          );
          return change;
        };
        const written = mutation(failure),
          checkpoint = mutation(pending),
          stored = object(failure.stored),
          metadata = object(stored.metadata);
        requireWorkflow(
          written.type === 'write' &&
            written.id === 'F-01' &&
            same(written.body, stored.body) &&
            object(stored.body).result === 'FAIL' &&
            metadata.id === 'F-01' &&
            metadata.result === 'FAIL' &&
            metadata.revision === 1 &&
            metadata.head_revision === 1 &&
            stored.successor === null &&
            same(beforeState.failure, stored) &&
            same(afterState.failure, stored) &&
            same(beforeState.effects, afterState.effects) &&
            checkpoint.type === 'checkpoint',
          'h03-series-state-retained',
        );
        const effects = (beforeState.effects as unknown[]).map(object),
          effect = effects.find((row) => row.id === pending.id);
        requireWorkflow(
          effect !== undefined &&
            effect.outcome === 'pending' &&
            object(effect.intent).opId === input.opId &&
            Array.isArray(checkpoint.effects) &&
            checkpoint.effects.some(
              (row) => same(object(row).intent, effect.intent) && object(row).id === pending.id,
            ),
          'h03-series-pending',
        );
        for (const snapshot of [beforeState, afterState]) {
          const state = object(snapshot.state),
            execution = object(object(object(state.checkpoint).workflow).execution);
          requireWorkflow(
            state.owner === session &&
              Array.isArray(execution.findings) &&
              execution.findings.some(
                (row) => object(row).id === 'F-01' && object(row).resolution === null,
              ),
            'h03-series-open-failure',
          );
        }
        for (const name of h03ProbeNames) {
          const row = object(probeRows[name]),
            basis = json(row.basis),
            result = json(row.observed),
            expected = object(basis.expected),
            packet = object(basis.packet),
            host = object(basis.host),
            anchor = object(host.anchor),
            source = json(basis.input);
          const error =
            name === 'new-action'
              ? 'chat-compact-full-load-required:chat-compact-read-unconfirmed'
              : 'chat-compact-full-load-required:chat-compact-context-stale';
          requireWorkflow(
            row.refused === true &&
              row.error === error &&
              basis.kind === 'comparison-h03-probe-basis' &&
              basis.probe === name &&
              result.kind === 'comparison-h03-load-refused' &&
              result.probe === name &&
              same(result.basis, row.basis) &&
              result.error === error &&
              host.transcript === participant.transcript &&
              host.root === request.roots.workspaceRoot &&
              anchor.thread_id === session &&
              source.kind === 'comparison-h03-probe-input' &&
              source.probe === name &&
              same(source.packet, packet) &&
              same(
                JSON.parse(textField(source.line)),
                compactContextLine(packet as unknown as CompactContextPacket),
              ),
            'h03-series-probe',
          );
          requireWorkflow(
            expected.session_id === session &&
              expected.run_id === input.opId &&
              same(expected.boundary, compact.boundary) &&
              expected.marker === basis.marker &&
              packet.marker === basis.marker,
            'h03-series-probe-binding',
          );
          const run = basis.run as LocalRun;
          requireWorkflow(
            run.spec.session_id === session &&
              run.spec.run_id === input.opId &&
              expected.owner === session &&
              expected.generation === run.generation &&
              same(expected.identity, run.spec.identity) &&
              expected.workspace === request.roots.workspaceRoot &&
              same(expected.rules, run.spec.rules) &&
              expected.payload_hash === expectedHash,
            'h03-series-probe-binding',
          );
          const procedures = expected.procedures as { source: Procedure; rules: unknown[] }[];
          for (const procedure of procedures) {
            const content = h01RawFile(join(request.roots.workspaceRoot, procedure.source.locator));
            requireWorkflow(
              digest(content) === procedure.source.hash &&
                same(normativeRules(procedure.source, content.toString()), procedure.rules),
              'h03-series-mandatory-rules',
            );
          }
          const changed = structuredClone(expected);
          if (name === 'missing-rule') {
            const procedure = (
              changed.procedures as { source: Procedure; rules: { id: string }[] }[]
            ).find((row) => row.source.id === 'evidence')!;
            requireWorkflow(
              procedure.rules.some((row) => row.id === 'evidence.03'),
              'h03-series-mandatory-rules',
            );
            procedure.rules = procedure.rules.filter((row) => row.id !== 'evidence.03');
          }
          if (name === 'stale-source') {
            const list = changed.procedures as { source: Procedure }[],
              actual = (packet.procedures as { source: Procedure }[])[0]!.source;
            requireWorkflow(actual.hash !== list[0]!.source.hash, 'h03-series-stale-source');
            list[0]!.source.hash = actual.hash;
          }
          if (name === 'wrong-role') {
            requireWorkflow(
              expected.role !== 'auditor' && packet.role === 'auditor',
              'h03-series-wrong-role',
            );
            changed.role = 'auditor';
          }
          if (name === 'new-action') {
            requireWorkflow(
              expected.action === 'execution-chat' &&
                packet.action === 'continue-chat' &&
                procedures.some((row) => row.source.id === 'implementation') &&
                !(packet.procedures as { source: Procedure }[]).some(
                  (row) => row.source.id === 'implementation',
                ),
              'h03-series-new-action',
            );
            changed.action = packet.action;
            changed.procedures = packet.procedures;
          }
          requireWorkflow(same(changed, packet), 'h03-series-probe-mutation');
          const visible = records
            .filter(
              (event) =>
                event.line > boundary.line &&
                event.raw.type === 'event_msg' &&
                object(event.raw.payload).type === 'item_completed' &&
                object(event.raw.payload).thread_id === session &&
                object(event.raw.payload).turn_id === anchor.turn_id,
            )
            .some((event) => {
              const item = object(object(event.raw.payload).item);
              return (
                item.type === 'CommandExecution' &&
                item.status === 'completed' &&
                item.exit_code === 0 &&
                typeof item.aggregated_output === 'string' &&
                item.aggregated_output.split('\n').includes(source.line as string)
              );
            });
          requireWorkflow(visible, 'h03-series-native-probe-read');
        }
      } else {
        requireWorkflow(
          projection.sdk === true &&
            Array.isArray(projection.workflowEvidence) &&
            projection.workflowEvidence.length === 1,
          'h03-series-sdk',
        );
        const proof = json(projection.workflowEvidence[0]),
          reader = parseReaderInput(proof.input),
          expectedReader = h03ReaderInput({ opId: input.opId, identity: request.identity });
        const first = json(initial.load),
          final = json(recovered.load),
          firstState = json(initial.state),
          finalState = json(recovered.state),
          store = artifactStore(request.roots.artifactRoot, { existingOnly: true }),
          profile = parseH01Profile(request.profile);
        const load = (value: Record<string, unknown>, fresh: boolean) => {
          requireWorkflow(
            value.kind === 'reader-load' &&
              value.session === session &&
              value.roleId === reader.roleId,
            'h03-series-load',
          );
          const prepared = artifact(object(value.prepared).manifest);
          requireWorkflow(
            prepared.kind === 'preparation' && same(prepared.input, reader.preparation),
            'h03-series-preparation',
          );
          const role = reader.preparation.project.roles.find((row) => row.id === reader.roleId)!;
          const paths = [
            ...new Set([
              ...reader.preparation.project.rules,
              role.profile,
              reader.preparation.card,
            ]),
          ];
          const refs = paths.map((path) => ({
            path: join(request.roots.workspaceRoot, path),
            sha256: digest(h01RawFile(join(request.roots.workspaceRoot, path))),
          }));
          requireWorkflow(same(value.refs, refs), 'h03-series-load-inputs');
          confirmObservedLoad(
            readerLoadObserved(
              store,
              object(value.observed),
              value.commandOutputs,
              request.roots.workspaceRoot,
              profile,
              session,
            ),
            refs,
          );
          requireWorkflow(
            records.some(
              (row) =>
                row.raw.type === 'turn_context' &&
                object(row.raw.payload).turn_id === object(value.observed).id &&
                (fresh ? row.line > boundary.line : row.line < before.line),
            ),
            'h03-series-load-order',
          );
        };
        requireWorkflow(
          proof.kind === 'comparison-h03-reader-workflow-proof' &&
            proof.scenario === 'H-03' &&
            proof.opId === input.opId &&
            proof.status === 'COMPLETED' &&
            same(reader, expectedReader) &&
            proof.workflowId === readerKey(reader) &&
            same(proof.initial, initial.state) &&
            same(proof.recovered, recovered.state),
          'h03-series-workflow',
        );
        load(first, false);
        load(final, true);
        requireWorkflow(
          object(first.observed).id === priorTurn &&
            object(first.observed).id !== object(final.observed).id &&
            same(first.prepared, final.prepared) &&
            firstState.mode === 'blocked' &&
            firstState.phase === 'answering' &&
            firstState.revision === 0 &&
            firstState.attempt === 0 &&
            firstState.session === session &&
            finalState.mode === 'answered' &&
            finalState.revision === 2 &&
            finalState.attempt === 1 &&
            finalState.session === session,
          'h03-series-reload',
        );
        const invalidation = textField(firstState.error).match(
            /^reader-context-compacted:([a-f0-9]{64})$/u,
          ),
          invalidationPin = (report.evidence as InputRef[]).find(
            (ref) => ref.hash === invalidation?.[1],
          );
        requireWorkflow(invalidationPin !== undefined, 'h03-series-invalidation');
        const invalid = json(invalidationPin);
        requireWorkflow(
          invalid.kind === 'reader-compacted-context' &&
            invalid.session === session &&
            invalid.loadTurn === object(first.observed).id &&
            readerContextCompacted(invalid.primary, session, textField(invalid.loadTurn)),
          'h03-series-invalidation',
        );
        checker(retained.failure);
        const beforeState = json(retained.before),
          afterState = json(retained.after),
          intent = object(beforeState.intent) as unknown as EffectIntent;
        read(retained.pending);
        requireWorkflow(
          same(beforeState.intent, afterState.intent) &&
            same(beforeState.failure, retained.failure) &&
            same(afterState.failure, retained.failure) &&
            same(beforeState.pending, retained.pending) &&
            same(afterState.pending, retained.pending) &&
            object(beforeState.state).status === 'pending' &&
            object(afterState.state).status === 'pending' &&
            afterState.repeated === false &&
            textField(afterState.error).includes('effect-outcome-unknown') &&
            intent.projectId === reader.preparation.project.projectId &&
            intent.taskId === reader.preparation.taskId &&
            intent.hostId === reader.preparation.hostId &&
            intent.workspaceId === reader.preparation.project.workspaceId &&
            intent.owner === reader.preparation.owner &&
            intent.generation === reader.preparation.generation &&
            intent.requestHash ===
              digest(canonical({ opId: input.opId, material: request.material })) &&
            lookupEffect(dirname(object(retained.pending).locator as string), intent).status ===
              'pending',
          'h03-series-pending',
        );
        const commands = object(proof.commands),
          pause = parseReaderCommand(commands.pause),
          resume = parseReaderCommand(commands.resume);
        for (const command of [pause, resume])
          requireWorkflow(
            same(command.target, readerTarget(reader, readerKey(reader))) &&
              command.author === request.identity.owner &&
              command.hash === digest(readerCommandText(command)),
            'h03-series-command',
          );
        requireWorkflow(
          pause.action === 'pause' &&
            pause.expectedRevision === 0 &&
            pause.attempt === 0 &&
            resume.action === 'resume' &&
            resume.expectedRevision === 1 &&
            resume.attempt === 1,
          'h03-series-human-reload',
        );
        const objects = (report.evidence as InputRef[]).flatMap((ref) => {
          try {
            return [json(ref)];
          } catch {
            return [];
          }
        });
        for (const command of [pause, resume]) {
          const human = objects.find(
            (row) => row.kind === 'reader-native-human-authorization' && same(row.command, command),
          );
          requireWorkflow(human !== undefined, 'h03-series-human-authorization');
          const source = object(human.source),
            user = object(source.user),
            observed = object(human.observed),
            issued = object(observed.issued);
          requireWorkflow(
            same(source, artifact(command.source)) &&
              source.schemaVersion === 1 &&
              source.kind === 'codex-user-command' &&
              String(source.transcript) + '#L' + String(user.line) ===
                request.authorization.source.locator &&
              user.sha256 === request.authorization.source.hash &&
              source.transcript === request.authorization.transcript &&
              source.threadId === request.authorization.anchor.thread_id &&
              source.turnId === request.authorization.anchor.turn_id,
            'h03-series-human-source',
          );
          const userRow = nativeLine(
              { locator: String(source.transcript) + '#L' + String(user.line), hash: user.sha256 },
              source.transcript as string,
            ),
            notice = nativeLine(
              {
                locator: String(source.transcript) + '#L' + String(issued.line),
                hash: issued.sha256,
              },
              source.transcript as string,
            ),
            payload = object(notice.raw.payload),
            item = object(payload.item);
          requireWorkflow(
            same(userRow.raw, object(observed.user).raw) &&
              same(notice.raw, issued.raw) &&
              userRow.raw.type === 'response_item' &&
              object(userRow.raw.payload).role === 'user' &&
              notice.line > userRow.line &&
              notice.raw.type === 'event_msg' &&
              payload.thread_id === source.threadId &&
              payload.turn_id === source.turnId &&
              payload.type === 'item_completed' &&
              item.type === 'CommandExecution' &&
              item.status === 'completed' &&
              item.exit_code === 0 &&
              item.cwd === request.authorization.root &&
              textField(item.aggregated_output).split('\n').includes(nativeReaderNotice(command)),
            'h03-series-human-issuance',
          );
        }
        for (const name of h03ProbeNames) {
          const row = object(probeRows[name]),
            basis = json(row.basis),
            result = json(row.observed);
          const codes = {
            'missing-rule': 'project-registration-mismatch',
            'stale-source': 'reader-input-changed',
            'wrong-role': 'reader-role-not-declared',
            'new-action': 'reader-command-action-invalid',
          };
          requireWorkflow(
            row.refused === true &&
              textField(row.error).includes(codes[name]) &&
              result.kind === 'comparison-h03-probe-observation' &&
              result.probe === name &&
              same(result.basis, row.basis) &&
              result.error === row.error &&
              integer(result.beforeStarts) &&
              result.beforeStarts === result.afterStarts,
            'h03-series-probe',
          );
          if (name === 'missing-rule') {
            const registration = object(basis.registration),
              changed = structuredClone(reader);
            changed.preparation.project.rules = changed.preparation.project.rules.slice(1);
            requireWorkflow(
              same(registration.project, reader.preparation.project) && same(basis.input, changed),
              'h03-series-missing-rule',
            );
          }
          if (name === 'stale-source') {
            const before = object(basis.before),
              after = object(basis.after);
            requireWorkflow(
              same(basis.load, initial.load) &&
                same(basis.prepared, first.prepared) &&
                before.path === reader.preparation.project.rules[0] &&
                after.path === before.path &&
                before.sha256 !== after.sha256 &&
                before.sha256 ===
                  digest(h01RawFile(join(request.roots.workspaceRoot, textField(before.path)))) &&
                read(before.content).ref.hash === before.sha256 &&
                read(after.content).ref.hash === after.sha256 &&
                read(before.content).bytes.length === before.bytes &&
                read(after.content).bytes.length === after.bytes,
              'h03-series-stale-source',
            );
          }
          if (name === 'wrong-role') {
            requireWorkflow(
              same(basis, { ...reader, roleId: 'not-executor' }),
              'h03-series-wrong-role',
            );
            let error = '';
            try {
              parseReaderInput(basis);
            } catch (value) {
              error = String(value);
            }
            requireWorkflow(error.includes(codes[name]), 'h03-series-owner-refusal');
          }
          if (name === 'new-action') {
            requireWorkflow(same(basis, { ...resume, action: 'write' }), 'h03-series-new-action');
            let error = '';
            try {
              parseReaderCommand(basis);
            } catch (value) {
              error = String(value);
            }
            requireWorkflow(error.includes(codes[name]), 'h03-series-owner-refusal');
          }
        }
        const historyProof = json(proof.history);
        requireWorkflow(
          historyProof.kind === 'comparison-h03-reader-history' &&
            historyProof.scenario === 'H-03' &&
            historyProof.opId === input.opId &&
            historyProof.workflowId === proof.workflowId &&
            historyProof.runId === proof.runId,
          'h03-series-history',
        );
        const events = proto.temporal.api.history.v1.History.fromObject(
          object(historyProof.history),
        ).events.map(object);
        const decoded = (value: unknown) => {
          const payloads = object(value).payloads;
          requireWorkflow(
            Array.isArray(payloads) && payloads.length === 1,
            'h03-series-history-payload',
          );
          return defaultPayloadConverter.fromPayload<unknown>(
            proto.temporal.api.common.v1.Payload.fromObject(object(payloads[0])),
          );
        };
        const started = events.filter((row) => row.workflowExecutionStartedEventAttributes != null),
          completed = events.filter((row) => row.workflowExecutionCompletedEventAttributes != null);
        requireWorkflow(
          started.length === 1 &&
            completed.length === 1 &&
            object(object(started[0]!.workflowExecutionStartedEventAttributes).workflowType)
              .name === 'ControlledReaderWorkflow' &&
            object(started[0]!.workflowExecutionStartedEventAttributes).originalExecutionRunId ===
              proof.runId &&
            same(
              decoded(object(started[0]!.workflowExecutionStartedEventAttributes).input),
              reader,
            ) &&
            same(
              decoded(object(completed[0]!.workflowExecutionCompletedEventAttributes).result),
              proof.result,
            ),
          'h03-series-history-payload',
        );
        const result = object(proof.result),
          answer = artifact(result.answer);
        requireWorkflow(
          result.status === 'answered' &&
            answer.kind === 'reader-answer' &&
            answer.session === session &&
            same(answer.load, {
              sha256: object(recovered.load).hash,
              bytes: read(recovered.load).bytes.length,
            }),
          'h03-series-answer',
        );
        const updates = events
          .filter((row) => row.workflowExecutionUpdateAcceptedEventAttributes != null)
          .map((row) =>
            object(object(row.workflowExecutionUpdateAcceptedEventAttributes).acceptedRequest),
          );
        const actual = updates.map((row) => {
          const value = object(row.input);
          requireWorkflow(value.name === 'readerControl', 'h03-series-update');
          return decoded(value.args);
        });
        requireWorkflow(same(actual, [pause, resume]), 'h03-series-update');
      }
      return true;
    }
    function verifyH04() {
      const projection = json(child.projection),
        report = json(projection.caseReport);
      const engine = request.variant === 'baseline' ? 'legacy' : 'temporal';
      requireWorkflow(
        projection.kind === 'comparison-h04-native-projection' &&
          projection.scenario === 'H-04' &&
          projection.opId === input.opId &&
          projection.engine === engine &&
          report.kind === 'comparison-h04-case' &&
          report.scenario === 'H-04' &&
          report.opId === input.opId &&
          report.engine === engine &&
          report.outcome === 'accepted' &&
          same(report.checks, checks) &&
          Object.values(checks).every(Boolean) &&
          same(report.blocking, []) &&
          report.nativeAcceptance === false &&
          report.qualification === false &&
          report.partialScope === true,
        'h04-series-case',
      );
      refs(report.evidence);
      const session = textField(report.session),
        participants = accounting.participants as ComparisonParticipant[];
      requireWorkflow(
        participants.length === 1 &&
          participants[0]!.session === session &&
          participants[0]!.stage === 'execution',
        'h04-series-session',
      );
      requireWorkflow(stop(report.stop, session), 'h04-series-stop');
      const guards = accountingEvidence
        .map((ref) => ({ ref, value: json(ref) }))
        .filter(({ value }) => value.kind === 'comparison-h04-guard');
      requireWorkflow(guards.length === 1, 'h04-series-guard');
      const guard = parseH01GuardDescriptor(guards[0]!.ref, 'H-04');
      requireWorkflow(
        same(parseH01Request(h01ReadJson(guard.request), 'run', 'H-04'), request) &&
          BigInt(guard.startedNs) >= startedNs &&
          BigInt(guard.startedNs) <= endedNs,
        'h04-series-guard-binding',
      );
      const operationRef = read(report.request).ref,
        operation = json(operationRef);
      const runtime = parseH01Runtime(request.runtime, request.variant),
        waiter = runtime.files.find(
          (ref) => ref.locator === join(runtime.root, 'tests/comparisonH04NativeWait.mjs'),
        );
      requireWorkflow(
        same(
          Object.keys(operation).sort(),
          [
            'kind',
            'schemaVersion',
            'opId',
            'requestHash',
            'material',
            'failure',
            'engine',
            'operationId',
            'outputRoot',
            'workspace',
            'deadlineNs',
            'node',
            'waiter',
          ].sort(),
        ) &&
          operation.kind === 'comparison-h04-native-operation' &&
          operation.schemaVersion === 1 &&
          operation.opId === input.opId &&
          operation.requestHash === expectedHash &&
          same(operation.material, request.material) &&
          operation.engine === engine &&
          operation.operationId === 'h04-' + digest(input.opId).slice(0, 32) &&
          operation.outputRoot === join(request.roots.evidenceRoot, 'h04-operation') &&
          operation.workspace === request.roots.workspaceRoot &&
          operationRef.locator ===
            join(request.roots.workspaceRoot, 'evidence/h04-operation-request.json') &&
          same(operation.node, spec.node) &&
          waiter !== undefined &&
          same(operation.waiter, waiter) &&
          operation.deadlineNs === guard.workDeadlineNs,
        'h04-series-operation-binding',
      );
      read(operation.material);
      read(operation.failure);
      read(operation.node);
      read(operation.waiter);
      const primary = object(report.primary);
      requireWorkflow(
        same(
          Object.keys(primary).sort(),
          [
            'result',
            'application',
            'effectStart',
            'gate',
            'history',
            'workflow',
            'terminal',
            'wait',
          ].sort(),
        ),
        'h04-series-primary',
      );
      for (const value of Object.values(primary)) if (value !== null) read(value);
      const native = verifyH04NativeWait(
        operationRef,
        participants[0]!,
        read(primary.terminal).ref,
      );
      requireWorkflow(same(report.nativeWait, native), 'h04-series-native-wait');
      for (const name of ['launch', 'started', 'wait', 'completed', 'terminal'] as const)
        evidence.set(native[name].locator, native[name]);
      verifyH04NativePrimary(operationRef, report as unknown as H04NativeCaseReport);
      const acceptance = json(child.nativeAcceptance);
      requireWorkflow(
        same(acceptance, {
          kind: 'comparison-h04-native-acceptance',
          opId: input.opId,
          request: operationRef,
          proof: native,
          primary: report.primary,
          qualification: false,
        }),
        'h04-series-native-acceptance',
      );
      return true;
    }
    function verifyH05() {
      const projection = json(child.projection),
        report = json(projection.caseReport),
        engine = request.variant === 'baseline' ? 'legacy' : 'temporal';
      requireWorkflow(
        projection.kind === 'comparison-h05-native-projection' &&
          projection.scenario === 'H-05' &&
          projection.opId === input.opId &&
          projection.engine === engine &&
          report.kind === 'comparison-h05-case' &&
          report.scenario === 'H-05' &&
          report.opId === input.opId &&
          report.engine === engine &&
          report.outcome === 'accepted' &&
          same(report.checks, checks) &&
          Object.values(checks).every(Boolean) &&
          same(report.blocking, []) &&
          report.nativeAcceptance === false &&
          report.qualification === false &&
          report.partialScope === true,
        'h05-series-case',
      );
      refs(report.evidence);
      const session = textField(report.session),
        turn = textField(report.turn),
        participants = accounting.participants as ComparisonParticipant[];
      requireWorkflow(
        participants.length === 1 &&
          participants[0]!.session === session &&
          participants[0]!.stage === 'execution',
        'h05-series-session',
      );
      requireWorkflow(stop(report.stop, session), 'h05-series-stop');
      const bindingRef = read(report.binding).ref,
        binding = json(bindingRef);
      requireWorkflow(
        binding.kind === 'comparison-h05-binding' &&
          binding.schemaVersion === 1 &&
          binding.opId === input.opId &&
          binding.requestHash === expectedHash &&
          binding.engine === engine &&
          same(binding.identity, request.identity) &&
          same(binding.material, request.material) &&
          binding.workspace === request.roots.workspaceRoot &&
          binding.stateRoot === join(request.roots.stateRoot, 'h05-waiting') &&
          binding.evidenceRoot === request.roots.evidenceRoot &&
          object(binding.session).id === session &&
          binding.turn === turn &&
          binding.nativeTranscript === participants[0]!.transcript,
        'h05-series-binding',
      );
      read(binding.material);
      read(binding.failure);
      const profile = parseH01Profile(request.profile),
        metadata = h05PreparedMetadata(
          read(profile.rules).bytes.toString(),
          read(profile.executor).bytes.toString(),
        ),
        query = object(binding.query);
      const nativeSession = object(binding.session);
      requireWorkflow(
        nativeSession.workspace === request.roots.workspaceRoot &&
          nativeSession.project_id === 'h05-' + digest(input.opId).slice(0, 16),
        'h05-series-session-profile',
      );
      confirmSession(
        nativeSession as unknown as AgentSession,
        { model: profile.model, effort: profile.effort, reason: 'H05 known native reader' },
        true,
      );
      const rules = ['.h05/rules.md', '.h05/executor.md'].map((locator) => ({
          locator,
          hash: digest(metadata[locator]!),
        })),
        assignment = { locator: '.h05/task.md', hash: digest(h05Material.instructions + '\n') };
      requireWorkflow(
        same(query.rules, rules) && same(query.sources, [assignment, binding.failure]),
        'h05-series-required-inputs',
      );
      for (const ref of [...rules, assignment])
        read({ locator: join(request.roots.workspaceRoot, ref.locator), hash: ref.hash });
      const runtime = parseH01Runtime(request.runtime, request.variant),
        descriptor = runtime.files.find(
          (ref) => ref.locator === join(runtime.root, 'project/workflow.json'),
        );
      requireWorkflow(descriptor !== undefined, 'h05-series-descriptor');
      const project = parseConnection(json(descriptor)),
        procedures = h05Procedures.flatMap((id) =>
          project.procedures.filter((procedure) => procedure.id === id),
        );
      requireWorkflow(
        Array.isArray(query.procedures) &&
          same(
            query.procedures.map((procedure) => object(procedure).id),
            h05Procedures,
          ) &&
          same(query.procedures, procedures),
        'h05-series-required-procedures',
      );
      for (const procedure of procedures) {
        const ref = { locator: join(runtime.root, procedure.locator), hash: procedure.hash };
        requireWorkflow(
          runtime.files.some((value) => same(value, ref)),
          'h05-series-procedure-pin',
        );
        read(ref);
      }

      const primary = object(report.native),
        before = json(primary.prefixBefore),
        after = json(primary.prefixAfter),
        participant = participants[0]!;
      requireWorkflow(
        before.transcript === participant.transcript &&
          after.transcript === participant.transcript &&
          typeof before.content === 'string' &&
          typeof after.content === 'string',
        'h05-series-transcript',
      );
      const bytes = h01RawFile(participant.transcript).toString('utf8');
      requireWorkflow(
        bytes.endsWith('\n') &&
          participant.after === undefined &&
          participant.through !== undefined,
        'h05-series-native-range',
      );
      const lines = bytes.slice(0, -1).split('\n'),
        through = participant.through!,
        end = Number(through.locator.slice(through.locator.lastIndexOf('#L') + 2));
      requireWorkflow(
        after.content ===
          lines
            .slice(0, end)
            .map((line) => line + '\n')
            .join('') && after.content.startsWith(before.content),
        'h05-series-native-prefix',
      );
      read(primary.primary);
      refs(primary.journals);
      verifyH05Primary(bindingRef, report as unknown as H05CaseReport);
      const probes = object(report.probes);
      for (const id of h05ProbeIds) {
        const probe = object(probes[id]);
        for (const key of ['before', 'after', 'basis', 'observation'] as const) read(probe[key]);
        refs(probe.reads);
        if (id === 'owner-fenced') continue;
        const execution = object(probe.execution);
        refs(execution.evidence);
        if (engine === 'temporal')
          verifyH05TemporalExecution(
            input.opId,
            {
              id,
              binding: bindingRef,
              mode:
                id === 'restart-reconciled'
                  ? 'restart'
                  : id === 'late-cancel-refused'
                    ? 'cancel'
                    : 'wait',
            },
            execution as unknown as Parameters<typeof verifyH05TemporalExecution>[2],
          );
      }
      const acceptance = json(child.nativeAcceptance);
      requireWorkflow(
        same(acceptance, {
          kind: 'comparison-h05-native-acceptance',
          opId: input.opId,
          binding: bindingRef,
          caseReport: projection.caseReport,
          qualification: false,
        }),
        'h05-series-native-acceptance',
      );
      return true;
    }
    const accepted =
      outcomes.every((outcome) => outcome === 'accepted') &&
      allChecks &&
      councilAccepted &&
      checkerPassed &&
      (scenario !== 'H-01' ||
        (accounting.participants as ComparisonParticipant[]).some(
          (participant) => participant.stage === 'execution',
        )) &&
      outer.error === null &&
      Array.isArray(outer.errors) &&
      outer.errors.length === 0 &&
      outer.timedOut === false &&
      keeper.code === 0 &&
      stops.every((entry) => entry.name !== label || object(entry.receipt).code === 0);
    summary.outcome =
      summary.blocking.length > 0
        ? 'unknown'
        : accepted
          ? 'accepted'
          : outcomes.every((outcome) => outcome === 'failed')
            ? 'failed'
            : 'unknown';
    if (summary.outcome !== 'accepted')
      summary.blocking.push(
        summary.outcome === 'failed' ? `${label}-failed` : `${label}-outcome-unknown`,
      );
  } catch {
    summary.outcome = 'unknown';
    summary.accounting.unknown = true;
    summary.blocking.push('invalid-primary-evidence');
  }
  summary.evidence = [...evidence.values()];
  return summary;
}
