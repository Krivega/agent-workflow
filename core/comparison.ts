import { object, requireWorkflow, textField, localLocator } from './connection.js';
import { sameValue } from './equality.js';

export interface ComparisonSuite {
  schema_version: 1;
  id: string;
  pairs: 2;
  reserve: number;
  limits: { elapsed_ms: number; responses: number; input_uncached: number; output: number };
  scenarios: { id: string; task: string; stimulus: string[]; checks: string[] }[];
}
export type ComparisonVariant = 'baseline' | 'candidate';
export interface ComparisonRun {
  id: string;
  scenario: string;
  pair: number;
  variant: ComparisonVariant;
  material_hash: string;
  profile_hash: string;
}
export interface ComparisonReceipt {
  id: string;
  run: string | null;
  participant: string;
  stage:
    | 'preparation'
    | 'execution'
    | 'council'
    | 'helper'
    | 'checks'
    | 'recovery'
    | 'correction'
    | 'shutdown';
  responses: number | null;
  input_uncached: number | null;
  input_cached: number | null;
  output: number | null;
}
export interface ComparisonResult {
  run: string;
  attempt: number;
  reconciles?: number;
  timing?: ComparisonTiming;
  outcome: 'accepted' | 'failed' | 'harness-error' | 'unknown';
  checks: Record<string, boolean>;
  evidence: string[];
}
const metrics = ['responses', 'input_uncached', 'input_cached', 'output'] as const;
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const hash = (value: string) => /^[a-f0-9]{64}$/u.test(value);

export interface ComparisonMaterial {
  id: string;
  instructions: string;
  files: Record<string, string>;
  mutable: string[];
}
export function parseComparisonMaterials(
  value: unknown,
  suite: ComparisonSuite,
): ComparisonMaterial[] {
  const source = object(value);
  requireWorkflow(
    source.schema_version === 1 &&
      Array.isArray(source.cases) &&
      source.cases.length === suite.scenarios.length,
    'comparison-materials-incomplete',
  );
  return source.cases.map((raw, index) => {
    const entry = object(raw),
      files = object(entry.files);
    requireWorkflow(
      entry.id === suite.scenarios[index]!.id && Array.isArray(entry.mutable),
      'comparison-material-order',
    );
    textField(entry.instructions);
    requireWorkflow(
      typeof files['checks.mjs'] === 'string' && typeof files['package.json'] === 'string',
      'comparison-material-checks-missing',
    );
    for (const [name, content] of Object.entries(files)) {
      localLocator(name);
      requireWorkflow(typeof content === 'string', 'comparison-material-content-invalid');
    }
    const mutable = entry.mutable.map(textField);
    requireWorkflow(
      new Set(mutable).size === mutable.length &&
        mutable.every(
          (name) => Object.hasOwn(files, name) && !['checks.mjs', 'package.json'].includes(name),
        ),
      'comparison-material-checks-mutable',
    );
    return {
      id: entry.id as string,
      instructions: entry.instructions as string,
      files: files as Record<string, string>,
      mutable,
    };
  });
}

export function parseComparisonSuite(value: unknown): ComparisonSuite {
  const suite = object(value);
  const limits = object(suite.limits);
  requireWorkflow(
    suite.schema_version === 1 &&
      suite.pairs === 2 &&
      suite.reserve === 0.1 &&
      limits.elapsed_ms === 28_800_000 &&
      limits.responses === 600 &&
      limits.input_uncached === 3_000_000 &&
      limits.output === 600_000,
    'unsupported-comparison-suite',
  );
  textField(suite.id);
  requireWorkflow(
    Array.isArray(suite.scenarios) && suite.scenarios.length === 6,
    'comparison-scenarios-missing',
  );
  const scenarios = suite.scenarios.map((raw, index) => {
    const scenario = object(raw);
    requireWorkflow(scenario.id === `H-0${index + 1}`, 'comparison-scenario-order');
    textField(scenario.task);
    for (const key of ['stimulus', 'checks']) {
      const entries = scenario[key];
      requireWorkflow(
        Array.isArray(entries) && entries.length > 0,
        'comparison-scenario-incomplete',
      );
      entries.forEach(textField);
      requireWorkflow(new Set(entries).size === entries.length, 'comparison-duplicate-check');
    }
    return scenario as unknown as ComparisonSuite['scenarios'][number];
  });
  return { ...suite, limits, scenarios } as ComparisonSuite;
}

export function comparisonSchedule(
  suite: ComparisonSuite,
  inputs: Record<string, { material_hash: string; profile_hash: string }>,
): ComparisonRun[] {
  return suite.scenarios.flatMap((scenario) => {
    const input = inputs[scenario.id];
    requireWorkflow(
      input !== undefined && hash(input.material_hash) && hash(input.profile_hash),
      'comparison-input-unpinned',
    );
    return [0, 1].flatMap((pair) =>
      (pair === 0
        ? (['baseline', 'candidate'] as const)
        : (['candidate', 'baseline'] as const)
      ).map((variant) => ({
        id: `${scenario.id}:${pair + 1}:${variant}`,
        scenario: scenario.id,
        pair: pair + 1,
        variant,
        ...input,
      })),
    );
  });
}

export function comparisonReport(
  suite: ComparisonSuite,
  schedule: ComparisonRun[],
  receipts: ComparisonReceipt[],
  results: ComparisonResult[],
  elapsedMs: number,
) {
  requireWorkflow(integer(elapsedMs), 'comparison-invalid-elapsed');
  const expected = comparisonSchedule(
    suite,
    Object.fromEntries(
      schedule.map((run) => [
        run.scenario,
        { material_hash: run.material_hash, profile_hash: run.profile_hash },
      ]),
    ),
  );
  requireWorkflow(sameValue(schedule, expected), 'comparison-schedule-mismatch');
  const runs = new Set(schedule.map((run) => run.id));
  const ids = new Set<string>();
  const totals = { responses: 0, input_uncached: 0, input_cached: 0, output: 0 };
  let missingMetrics = false;
  for (const receipt of receipts) {
    textField(receipt.id);
    textField(receipt.participant);
    requireWorkflow(!ids.has(receipt.id), 'comparison-duplicate-receipt');
    ids.add(receipt.id);
    requireWorkflow(receipt.run === null || runs.has(receipt.run), 'comparison-foreign-run');
    requireWorkflow(
      [
        'preparation',
        'execution',
        'council',
        'helper',
        'checks',
        'recovery',
        'correction',
        'shutdown',
      ].includes(receipt.stage),
      'comparison-invalid-stage',
    );
    for (const key of metrics) {
      const value = receipt[key];
      requireWorkflow(value === null || integer(value), 'comparison-invalid-usage');
      if (value === null) missingMetrics = true;
      else totals[key] += value;
    }
  }
  const completed = new Map<string, ComparisonResult>();
  for (const result of results) {
    const previous = completed.get(result.run);
    if (result.reconciles !== undefined) {
      requireWorkflow(
        previous?.outcome === 'unknown' &&
          result.reconciles === previous.attempt &&
          result.attempt === previous.attempt &&
          result.outcome !== 'unknown',
        'comparison-invalid-reconciliation',
      );
    } else {
      requireWorkflow(previous?.outcome !== 'unknown', 'comparison-unknown-outcome');
      requireWorkflow(
        result.attempt === (previous?.attempt ?? 0) + 1,
        'comparison-result-conflict',
      );
    }
    requireWorkflow(runs.has(result.run), 'comparison-result-conflict');
    completed.set(result.run, result);
    requireWorkflow(
      ['accepted', 'failed', 'harness-error', 'unknown'].includes(result.outcome),
      'comparison-invalid-outcome',
    );
    requireWorkflow(result.evidence.length > 0, 'comparison-evidence-missing');
    result.evidence.forEach(textField);
    const scenario = suite.scenarios.find(
      (entry) => entry.id === schedule.find((run) => run.id === result.run)!.scenario,
    )!;
    requireWorkflow(
      Object.keys(result.checks).length === scenario.checks.length &&
        scenario.checks.every((check) => typeof result.checks[check] === 'boolean'),
      'comparison-checks-incomplete',
    );
    requireWorkflow(
      receipts.some((receipt) => receipt.run === result.run),
      'comparison-run-unaccounted',
    );
  }
  const usage = { ...totals, elapsed_ms: elapsedMs };
  const exhausted = Object.entries(suite.limits).some(
    ([key, limit]) => usage[key as keyof typeof usage] >= limit,
  );
  const reserve = Object.entries(suite.limits).some(
    ([key, limit]) => usage[key as keyof typeof usage] >= limit * (1 - suite.reserve),
  );
  const latest = [...completed.values()];
  const unknown = latest.some((result) => result.outcome === 'unknown');
  const quality = latest.every(
    (result) => result.outcome === 'accepted' && Object.values(result.checks).every(Boolean),
  );
  const missed = results.some(
    (result) =>
      result.outcome === 'accepted' && Object.values(result.checks).some((passed) => !passed),
  );
  const complete = completed.size === schedule.length && !missingMetrics && !unknown;
  const retryable = latest.some(
    (result) => result.outcome === 'failed' || result.outcome === 'harness-error',
  );
  return {
    totals: usage,
    timings: comparisonTimings(schedule, results),
    by_participant: [...new Set(receipts.map((receipt) => receipt.participant))].map(
      (participant) => ({
        participant,
        stages: [
          ...new Set(
            receipts
              .filter((receipt) => receipt.participant === participant)
              .map((receipt) => receipt.stage),
          ),
        ].map((stage) => ({
          stage,
          ...Object.fromEntries(
            metrics.map((metric) => {
              const values = receipts
                .filter((receipt) => receipt.participant === participant && receipt.stage === stage)
                .map((receipt) => receipt[metric]);
              return [
                metric,
                values.some((value) => value === null)
                  ? null
                  : values.reduce<number>((sum, value) => sum + value!, 0),
              ];
            }),
          ),
        })),
      }),
    ),
    missing_metrics: missingMetrics,
    complete,
    may_start: !exhausted && !reserve && !missingMetrics && !unknown && (!complete || retryable),
    stop: exhausted
      ? 'limit'
      : reserve
        ? 'reserve'
        : missingMetrics
          ? 'missing-metrics'
          : unknown
            ? 'unknown-outcome'
            : null,
    comparison_eligible: complete && quality && !missed && !exhausted,
    harness_errors: results
      .filter((result) => result.outcome === 'harness-error')
      .map((result) => result.run),
  };
}

export interface ComparisonInstant {
  wall_ms: number;
  monotonic_ms: number;
  clock_id: string;
}
export interface ComparisonTiming {
  start: ComparisonInstant;
  end: ComparisonInstant;
}

export function comparisonDuration(
  start: ComparisonInstant,
  end: ComparisonInstant,
): number | null {
  const elapsed = end.monotonic_ms - start.monotonic_ms;
  return [start, end].every(
    (instant) =>
      Number.isSafeInteger(instant.wall_ms) &&
      instant.wall_ms >= 0 &&
      Number.isFinite(instant.monotonic_ms) &&
      instant.monotonic_ms >= 0 &&
      typeof instant.clock_id === 'string' &&
      instant.clock_id.length > 0,
  ) &&
    start.clock_id === end.clock_id &&
    elapsed >= 0 &&
    end.wall_ms >= start.wall_ms &&
    // Wall time is a cross-check; discontinuous clocks cannot demonstrate acceleration.
    Math.abs(end.wall_ms - start.wall_ms - elapsed) <= 1000
    ? elapsed
    : null;
}

export function comparisonTimings(schedule: ComparisonRun[], results: ComparisonResult[]) {
  const runs = schedule.map((run) => {
    const attempts = results.filter((result) => result.run === run.id);
    const first = attempts[0]?.timing;
    let previous: ComparisonTiming | undefined;
    let valid = attempts.length > 0;
    for (const attempt of attempts) {
      const timing = attempt.timing;
      if (
        timing === undefined ||
        comparisonDuration(timing.start, timing.end) === null ||
        (previous !== undefined &&
          (attempt.reconciles === undefined
            ? comparisonDuration(previous.end, timing.start) === null
            : !sameValue(previous.start, timing.start) ||
              comparisonDuration(previous.end, timing.end) === null))
      )
        valid = false;
      previous = timing;
    }
    const last = attempts.at(-1);
    const observed =
      valid && first !== undefined && last?.timing !== undefined
        ? comparisonDuration(first.start, last.timing.end)
        : null;
    return {
      run: run.id,
      scenario: run.scenario,
      pair: run.pair,
      variant: run.variant,
      attempts: attempts.map((attempt) => ({
        attempt: attempt.attempt,
        outcome: attempt.outcome,
        timing: attempt.timing ?? null,
        elapsed_ms:
          attempt.timing === undefined
            ? null
            : comparisonDuration(attempt.timing.start, attempt.timing.end),
      })),
      observed_ms: observed,
      accepted_ms:
        last?.outcome === 'accepted' && Object.values(last.checks).every(Boolean) ? observed : null,
    };
  });
  const comparisons = ['H-02', 'H-03'].map((scenario) => {
    const durations = (variant: 'baseline' | 'candidate') =>
      runs
        .filter((run) => run.scenario === scenario && run.variant === variant)
        .map((run) => run.accepted_ms);
    const baseline = durations('baseline'),
      candidate = durations('candidate');
    const median = (values: (number | null)[]) =>
      values.length === 2 && values.every((value) => value !== null)
        ? (values[0]! + values[1]!) / 2
        : null;
    const before = median(baseline),
      after = median(candidate);
    return {
      scenario,
      baseline_ms: baseline,
      candidate_ms: candidate,
      median_baseline_ms: before,
      median_candidate_ms: after,
      reduction: before !== null && before > 0 && after !== null ? 1 - after / before : null,
    };
  });
  return { runs, comparisons };
}
