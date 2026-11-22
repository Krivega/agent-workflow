import suiteSource from '../comparison/suite.json' with { type: 'json' };
import {
  comparisonReport,
  comparisonSchedule,
  parseComparisonSuite,
  type ComparisonReceipt,
  type ComparisonResult,
} from '../core/comparison.js';

const suite = parseComparisonSuite(suiteSource);
const inputs = Object.fromEntries(
  suite.scenarios.map((scenario) => [
    scenario.id,
    {
      material_hash: 'a'.repeat(64),
      profile_hash: 'b'.repeat(64),
    },
  ]),
);
const schedule = comparisonSchedule(suite, inputs);
const receipt = (run: string | null = null): ComparisonReceipt => ({
  id: run ?? 'preparation',
  run,
  participant: 'executor',
  stage: 'execution',
  responses: 1,
  input_uncached: 100,
  input_cached: 50,
  output: 10,
});
const results = (): ComparisonResult[] =>
  schedule.map((run) => ({
    run: run.id,
    attempt: 1,
    outcome: 'accepted',
    evidence: [`receipt:${run.id}`],
    checks: Object.fromEntries(
      suite.scenarios
        .find((scenario) => scenario.id === run.scenario)!
        .checks.map((check) => [check, true]),
    ),
  }));
const receipts = () => [receipt(), ...schedule.map((run) => receipt(run.id))];

it('pins identical material and profiles, reverses pair order and keeps all 24 executions', () => {
  expect(schedule).toHaveLength(24);
  for (const scenario of suite.scenarios) {
    const runs = schedule.filter((run) => run.scenario === scenario.id);
    expect(runs.map((run) => run.variant)).toEqual([
      'baseline',
      'candidate',
      'candidate',
      'baseline',
    ]);
    expect(runs.every((run) => run.material_hash === inputs[scenario.id]!.material_hash)).toBe(
      true,
    );
  }
  expect(() => comparisonSchedule(suite, {})).toThrow('comparison-input-unpinned');
  expect(() =>
    comparisonSchedule(suite, { ...inputs, 'H-01': { material_hash: 'bad', profile_hash: 'bad' } }),
  ).toThrow('comparison-input-unpinned');
});

it.each([
  { schema_version: 2 },
  { pairs: 3 },
  { reserve: 0.2 },
  { id: '' },
  { limits: { ...suite.limits, responses: 601 } },
  { scenarios: [] },
  { scenarios: suite.scenarios.map((scenario) => ({ ...scenario, id: 'other' })) },
  { scenarios: suite.scenarios.map((scenario) => ({ ...scenario, task: '' })) },
  { scenarios: suite.scenarios.map((scenario) => ({ ...scenario, checks: [] })) },
  { scenarios: suite.scenarios.map((scenario) => ({ ...scenario, stimulus: ['same', 'same'] })) },
])('refuses a changed or incomplete suite contract %j', (patch) => {
  expect(() => parseComparisonSuite({ ...suite, ...patch })).toThrow();
});

it('counts preparation, advisers, helpers, recovery and corrections without adding reasoning output again', () => {
  const stages = [
    'preparation',
    'execution',
    'council',
    'helper',
    'checks',
    'recovery',
    'correction',
    'shutdown',
  ] as const;
  const ledger = stages.map((stage) => ({ ...receipt(), id: stage, stage, participant: stage }));
  const report = comparisonReport(suite, schedule, ledger, [], 1000);
  expect(report.by_participant).toContainEqual({
    participant: 'council',
    stages: [{ stage: 'council', responses: 1, input_uncached: 100, input_cached: 50, output: 10 }],
  });
  expect(report).toMatchObject({
    totals: { responses: 8, input_uncached: 800, input_cached: 400, output: 80, elapsed_ms: 1000 },
    may_start: true,
    complete: false,
    comparison_eligible: false,
    stop: null,
  });
  expect(comparisonReport(suite, schedule, receipts(), results(), 1000)).toMatchObject({
    complete: true,
    may_start: false,
    comparison_eligible: true,
  });
});

it.each(Object.keys(suite.limits) as (keyof typeof suite.limits)[])(
  'reserves the last ten percent and stops at the %s limit',
  (metric) => {
    const limit = suite.limits[metric];
    const check = (value: number) =>
      comparisonReport(
        suite,
        schedule,
        [{ ...receipt(), ...(metric === 'elapsed_ms' ? {} : { [metric]: value }) }],
        [],
        metric === 'elapsed_ms' ? value : 1,
      );
    expect(check(limit * 0.9 - 1).may_start).toBe(true);
    expect(check(limit * 0.9)).toMatchObject({ may_start: false, stop: 'reserve' });
    expect(check(limit + 1)).toMatchObject({
      may_start: false,
      stop: 'limit',
      comparison_eligible: false,
    });
  },
);

it.each(['responses', 'input_uncached', 'input_cached', 'output'] as const)(
  'retains unknown %s and blocks new experiments instead of counting it as zero',
  (metric) => {
    expect(
      comparisonReport(suite, schedule, [{ ...receipt(), [metric]: null }], [], 1),
    ).toMatchObject({
      missing_metrics: true,
      may_start: false,
      complete: false,
      stop: 'missing-metrics',
      comparison_eligible: false,
    });
    expect(() =>
      comparisonReport(suite, schedule, [{ ...receipt(), [metric]: -1 }], [], 1),
    ).toThrow('comparison-invalid-usage');
  },
);

it.each(['failed', 'harness-error'] as const)(
  'allows a final %s attempt to be corrected within the original budget',
  (outcome) => {
    const ledger = results();
    const last = ledger.at(-1)!;
    last.outcome = outcome;
    expect(comparisonReport(suite, schedule, receipts(), ledger, 1000)).toMatchObject({
      complete: true,
      comparison_eligible: false,
      may_start: true,
      stop: null,
    });
    expect(
      comparisonReport(suite, schedule, receipts(), ledger, suite.limits.elapsed_ms * 0.9),
    ).toMatchObject({ may_start: false, stop: 'reserve' });
    expect(
      comparisonReport(suite, schedule, receipts(), ledger, suite.limits.elapsed_ms),
    ).toMatchObject({ may_start: false, stop: 'limit' });
    const unknown = [...ledger, { ...last, attempt: 2, outcome: 'unknown' as const }];
    expect(comparisonReport(suite, schedule, receipts(), unknown, 1000)).toMatchObject({
      may_start: false,
      stop: 'unknown-outcome',
    });
    expect(
      comparisonReport(
        suite,
        schedule,
        [...receipts(), { ...receipt(last.run), id: 'correction', output: null }],
        ledger,
        1000,
      ),
    ).toMatchObject({ may_start: false, stop: 'missing-metrics' });
    const repaired = { ...last, attempt: 2, outcome: 'accepted' as const };
    expect(
      comparisonReport(
        suite,
        schedule,
        [...receipts(), { ...receipt(last.run), id: 'correction' }],
        [...ledger, repaired],
        2000,
      ),
    ).toMatchObject({
      complete: true,
      comparison_eligible: true,
      may_start: false,
      totals: { responses: 26, input_uncached: 2600, input_cached: 1300, output: 260 },
      harness_errors: outcome === 'harness-error' ? [last.run] : [],
    });
  },
);

it('preserves harness errors and refuses an unknown outcome or missed defect as evidence of savings', () => {
  for (const outcome of ['failed', 'harness-error', 'unknown'] as const) {
    const ledger = results();
    ledger[0]!.outcome = outcome;
    const report = comparisonReport(suite, schedule, receipts(), ledger, 1);
    expect(report.comparison_eligible).toBe(false);
    expect(report.harness_errors).toEqual(outcome === 'harness-error' ? [schedule[0]!.id] : []);
    if (outcome === 'unknown')
      expect(report).toMatchObject({ may_start: false, stop: 'unknown-outcome', complete: false });
  }
  const ledger = results();
  ledger[0]!.checks['root-cause'] = false;
  expect(comparisonReport(suite, schedule, receipts(), ledger, 1).comparison_eligible).toBe(false);
  expect(
    comparisonReport(suite, schedule, receipts(), [...ledger, { ...results()[0]!, attempt: 2 }], 1)
      .comparison_eligible,
  ).toBe(false);
  const failed = { ...results()[0]!, outcome: 'harness-error' as const };
  const repaired = { ...results()[0]!, attempt: 2 };
  const attempts = [failed, repaired, ...results().slice(1)];
  const report = comparisonReport(suite, schedule, receipts(), attempts, 1);
  expect(report).toMatchObject({ comparison_eligible: true, harness_errors: [failed.run] });
  expect(() =>
    comparisonReport(suite, schedule, receipts(), [{ ...failed, outcome: 'unknown' }, repaired], 1),
  ).toThrow('comparison-unknown-outcome');
  const reconciled = [
    { ...failed, outcome: 'unknown' as const },
    { ...results()[0]!, reconciles: 1 },
    ...results().slice(1),
  ];
  expect(comparisonReport(suite, schedule, receipts(), reconciled, 1).comparison_eligible).toBe(
    true,
  );
  for (const patch of [{ reconciles: 2 }, { attempt: 2 }, { outcome: 'unknown' }]) {
    expect(() =>
      comparisonReport(
        suite,
        schedule,
        receipts(),
        [reconciled[0]!, { ...reconciled[1]!, ...patch } as ComparisonResult],
        1,
      ),
    ).toThrow('comparison-invalid-reconciliation');
  }
  expect(() =>
    comparisonReport(suite, schedule, receipts(), [{ ...results()[0]!, reconciles: 1 }], 1),
  ).toThrow('comparison-invalid-reconciliation');
});

it('rejects modified inputs, duplicated receipts, foreign runs, unaccounted work and incomplete evidence', () => {
  expect(() => comparisonReport(suite, schedule, [], [], -1)).toThrow('comparison-invalid-elapsed');
  expect(() =>
    comparisonReport(
      suite,
      [{ ...schedule[0]!, material_hash: 'c'.repeat(64) }, ...schedule.slice(1)],
      [],
      [],
      1,
    ),
  ).toThrow('comparison-schedule-mismatch');
  expect(() => comparisonReport(suite, schedule, [receipt(), receipt()], [], 1)).toThrow(
    'comparison-duplicate-receipt',
  );
  expect(() => comparisonReport(suite, schedule, [receipt('foreign')], [], 1)).toThrow(
    'comparison-foreign-run',
  );
  expect(() =>
    comparisonReport(
      suite,
      schedule,
      [{ ...receipt(), stage: 'other' as ComparisonReceipt['stage'] }],
      [],
      1,
    ),
  ).toThrow('comparison-invalid-stage');
  expect(() => comparisonReport(suite, schedule, [], results(), 1)).toThrow(
    'comparison-run-unaccounted',
  );
  for (const patch of [{ run: 'foreign' }, { outcome: 'other' }, { evidence: [] }, { checks: {} }])
    expect(() =>
      comparisonReport(
        suite,
        schedule,
        receipts(),
        [{ ...results()[0]!, ...patch } as ComparisonResult],
        1,
      ),
    ).toThrow();
  expect(() =>
    comparisonReport(suite, schedule, receipts(), [results()[0]!, results()[0]!], 1),
  ).toThrow('comparison-result-conflict');
});
