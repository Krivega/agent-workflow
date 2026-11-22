import { comparisonTimings, type ComparisonInstant } from '../core/comparison.js';
import type { ComparisonResult, ComparisonRun } from '../core/comparison.js';
const runs: ComparisonRun[] = ['H-02', 'H-03'].flatMap((scenario) =>
  [1, 2].flatMap((pair) =>
    (['baseline', 'candidate'] as const).map((variant) => ({
      id: `${scenario}:${pair}:${variant}`,
      scenario,
      pair,
      variant,
      material_hash: '',
      profile_hash: '',
    })),
  ),
);
const instant = (value: number): ComparisonInstant => ({
  wall_ms: value + 1000,
  monotonic_ms: value,
  clock_id: 'clock-1',
});
const result = (run = runs[0]!, start = 0, end = 100): ComparisonResult => ({
  run: run.id,
  attempt: 1,
  outcome: 'accepted',
  checks: { quality: true },
  evidence: ['source'],
  timing: { start: instant(start), end: instant(end) },
});
it('computes both pair durations and medians without summing parallel participants', () => {
  const results = runs.map((run) =>
    result(run, 0, (run.pair === 1 ? 100 : 200) * (run.variant === 'baseline' ? 1 : 0.8)),
  );
  const report = comparisonTimings(runs, results);
  expect(report.comparisons).toEqual(
    ['H-02', 'H-03'].map((scenario) => ({
      scenario,
      baseline_ms: [100, 200],
      candidate_ms: [80, 160],
      median_baseline_ms: 150,
      median_candidate_ms: 120,
      reduction: 1 - 120 / 150,
    })),
  );
  expect(report.runs[0]).toMatchObject({
    observed_ms: 100,
    accepted_ms: 100,
    attempts: [{ elapsed_ms: 100 }],
  });
});
it('includes a failed attempt, correction and the gap before retry in accepted time', () => {
  const first = { ...result(), outcome: 'failed' as const };
  const retry = { ...result(runs[0], 150, 200), attempt: 2 };
  expect(comparisonTimings(runs, [first, retry]).runs[0]).toMatchObject({
    observed_ms: 200,
    accepted_ms: 200,
    attempts: [
      { outcome: 'failed', elapsed_ms: 100 },
      { outcome: 'accepted', elapsed_ms: 50 },
    ],
  });
  expect(comparisonTimings(runs, [first]).runs[0]).toMatchObject({
    observed_ms: 100,
    accepted_ms: null,
  });
  expect(
    comparisonTimings(runs, [{ ...result(), checks: { quality: false } }]).runs[0]!.accepted_ms,
  ).toBeNull();
});
it('keeps absent boundaries, unfinished acceptance and zero baseline unknown', () => {
  expect(comparisonTimings(runs, []).runs[0]).toMatchObject({
    observed_ms: null,
    accepted_ms: null,
  });
  const legacy = result();
  delete legacy.timing;
  expect(comparisonTimings(runs, [legacy]).runs[0]).toMatchObject({
    observed_ms: null,
    accepted_ms: null,
    attempts: [{ timing: null, elapsed_ms: null }],
  });
  const zero = runs.map((run) => result(run, 0, 0));
  expect(comparisonTimings(runs, zero).comparisons[0]!.reduction).toBeNull();
});
it.each([
  { clock_id: 'restarted' },
  { clock_id: '' },
  { monotonic_ms: -1 },
  { monotonic_ms: Number.NaN },
  { wall_ms: -1 },
  { wall_ms: 1.5 },
  { wall_ms: 900 },
  { wall_ms: 9000 },
])('keeps clock failures unknown %j', (patch) => {
  const attempt = result();
  Object.assign(attempt.timing!.end, patch);
  expect(comparisonTimings(runs, [attempt]).runs[0]!.accepted_ms).toBeNull();
});
it('rejects overlapping, regressing and discontinuous retry intervals', () => {
  const first = result();
  for (const start of [50, 110]) {
    const retry = { ...result(runs[0], start, 200), attempt: 2 };
    if (start === 110) retry.timing!.start.clock_id = retry.timing!.end.clock_id = 'restarted';
    expect(comparisonTimings(runs, [first, retry]).runs[0]!.accepted_ms).toBeNull();
  }
  const regressed = result(runs[0], 100, 50);
  expect(comparisonTimings(runs, [regressed]).runs[0]!.accepted_ms).toBeNull();
});

it('reconciles a lost result in the same attempt without creating another interval', () => {
  const unknown = { ...result(), outcome: 'unknown' as const };
  const reconciled = { ...result(runs[0], 0, 150), reconciles: 1 };
  expect(comparisonTimings(runs, [unknown, reconciled]).runs[0]).toMatchObject({
    observed_ms: 150,
    accepted_ms: 150,
    attempts: [{ outcome: 'unknown' }, { outcome: 'accepted' }],
  });
});
it('keeps a reconciliation with a replaced start or regressed end unknown', () => {
  const previous = { ...result(), outcome: 'unknown' as const };
  for (const timing of [result(runs[0], 10, 150).timing, result(runs[0], 0, 50).timing]) {
    const reconciled = { ...result(), reconciles: 1, timing: timing! };
    expect(comparisonTimings(runs, [previous, reconciled]).runs[0]!.accepted_ms).toBeNull();
  }
});
