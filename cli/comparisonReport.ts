import { isAbsolute } from 'node:path';
import suiteSource from '../comparison/suite.json' with { type: 'json' };
import { object, requireWorkflow, textField } from '../core/connection.js';
import {
  comparisonReport,
  parseComparisonSuite,
  type ComparisonReceipt,
  type ComparisonResult,
  type ComparisonRun,
} from '../core/comparison.js';
import { comparisonDuration, type ComparisonTiming } from '../core/comparison.js';
import { readPrivateFile } from '../adapters/storage/storeFiles.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';

export function readComparisonReport(path: string) {
  const bytes = readPrivateFile(path);
  const request = object(JSON.parse(bytes.toString('utf8')));
  requireWorkflow(request.schema_version === 1, 'unsupported-comparison-record');
  textField(request.series_id);
  const pins = object(request.sources);
  requireWorkflow(
    Object.keys(pins).sort().join(',') === 'baseline,candidate',
    'comparison-source-pins-missing',
  );
  for (const raw of Object.values(pins)) {
    const pin = object(raw);
    const locator = textField(pin.locator);
    requireWorkflow(
      isAbsolute(locator) && digest(readPrivateFile(locator)) === pin.hash,
      'comparison-source-changed',
    );
  }
  const suite = parseComparisonSuite(suiteSource);
  requireWorkflow(request.suite_hash === digest(canonical(suite)), 'comparison-suite-changed');
  requireWorkflow(
    Array.isArray(request.schedule) &&
      Array.isArray(request.receipts) &&
      Array.isArray(request.results),
    'comparison-record-incomplete',
  );
  const report = comparisonReport(
    suite,
    request.schedule as ComparisonRun[],
    request.receipts as ComparisonReceipt[],
    request.results as ComparisonResult[],
    request.elapsed_ms as number,
  );
  requireWorkflow(
    request.runner_version === undefined || request.runner_version === 1,
    'unsupported-comparison-runner',
  );
  const pending = request.runner_version === 1 ? request.pending : null;
  if (pending !== null) {
    const operation = object(pending);
    for (const key of ['run', 'operation', 'stage']) textField(operation[key]);
  }
  return {
    series_id: request.series_id,
    suite_id: suite.id,
    suite_hash: request.suite_hash,
    sources: pins,
    record: { locator: path, hash: digest(bytes) },
    ...report,
    preparation_timing: request.preparation_timing ?? null,
    preparation_ms:
      request.preparation_timing === undefined
        ? null
        : comparisonDuration(
            (request.preparation_timing as ComparisonTiming).start,
            (request.preparation_timing as ComparisonTiming).end,
          ),
    ...(pending === null
      ? {}
      : {
          pending,
          complete: false,
          may_start: false,
          comparison_eligible: false,
          stop: 'pending-operation',
        }),
  };
}
