import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import suiteSource from '../comparison/suite.json' with { type: 'json' };
import { comparisonSchedule, parseComparisonSuite } from '../core/comparison.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { readComparisonReport } from '../cli/comparisonReport.js';
import { runAgentWorkflow } from '../cli/runAgentWorkflow.js';
import type { WorkflowCliDependencies } from '../cli/runAgentWorkflow.js';

let directory: string;
let path: string;
let record: Record<string, unknown>;
const suite = parseComparisonSuite(suiteSource);
const save = () => writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
beforeEach(() => {
  directory = realpathSync(mkdtempSync(resolve(tmpdir(), 'comparison-report-')));
  path = resolve(directory, 'record.json');
  const snapshot = resolve(directory, 'snapshot.json');
  writeFileSync(snapshot, '{}', { mode: 0o600 });
  const pin = { locator: snapshot, hash: digest('{}') };
  record = {
    schema_version: 1,
    series_id: 'test-only',
    sources: { baseline: pin, candidate: pin },
    suite_hash: digest(canonical(suite)),
    schedule: comparisonSchedule(
      suite,
      Object.fromEntries(
        suite.scenarios.map((scenario) => [
          scenario.id,
          {
            material_hash: 'a'.repeat(64),
            profile_hash: 'b'.repeat(64),
          },
        ]),
      ),
    ),
    receipts: [],
    results: [],
    elapsed_ms: 0,
  };
  save();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('reads an immutable source-bound ledger without starting models or changing its inputs', async () => {
  expect(readComparisonReport(path)).toMatchObject({
    series_id: 'test-only',
    suite_id: suite.id,
    complete: false,
    comparison_eligible: false,
    may_start: true,
    record: { locator: path, hash: digest(JSON.stringify(record)) },
  });
  const output = vi.fn();
  const error = vi.fn();
  const deps = { write: output, writeError: error } as unknown as WorkflowCliDependencies;
  expect(await runAgentWorkflow(['comparison-report', path], deps)).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(readComparisonReport(path));
  expect(await runAgentWorkflow(['comparison-report'], deps)).toBe(2);
  expect(await runAgentWorkflow(['comparison-report', path, 'extra'], deps)).toBe(2);
  record.suite_hash = 'changed';
  save();
  expect(await runAgentWorkflow(['comparison-report', path], deps)).toBe(1);
  expect(error).toHaveBeenLastCalledWith('comparison-suite-changed');
});

it.each([
  { schema_version: 2 },
  { series_id: '' },
  { sources: {} },
  { sources: { baseline: { locator: 'relative', hash: '' }, candidate: {} } },
  { suite_hash: 'old' },
  { schedule: null },
  { receipts: null },
  { results: null },
  { runner_version: 2 },
  { runner_version: 1 },
  { runner_version: 1, pending: {} },
])('refuses an incompatible or unbound record %j', (patch) => {
  Object.assign(record, patch);
  save();
  expect(() => readComparisonReport(path)).toThrow();
});
it('preserves a pending native effect and accepts a cleared runner operation', () => {
  Object.assign(record, {
    runner_version: 1,
    pending: { run: 'H-01:1:baseline', operation: 'known', stage: 'execution' },
  });
  save();
  expect(readComparisonReport(path)).toMatchObject({
    may_start: false,
    stop: 'pending-operation',
    pending: record.pending,
  });
  record.pending = null;
  save();
  expect(readComparisonReport(path)).toMatchObject({ may_start: true, stop: null });
});

it('refuses a changed baseline instead of silently replacing the original comparison', () => {
  writeFileSync(resolve(directory, 'snapshot.json'), '{"changed":true}');
  expect(() => readComparisonReport(path)).toThrow('comparison-source-changed');
});
it('reports shared preparation separately and preserves missing historical times', () => {
  expect(readComparisonReport(path)).toMatchObject({
    preparation_ms: null,
    preparation_timing: null,
  });
  record.preparation_timing = {
    start: { wall_ms: 1000, monotonic_ms: 0, clock_id: 'clock' },
    end: { wall_ms: 1050, monotonic_ms: 50, clock_id: 'clock' },
  };
  save();
  expect(readComparisonReport(path)).toMatchObject({
    preparation_ms: 50,
    totals: { elapsed_ms: 0 },
  });
});
