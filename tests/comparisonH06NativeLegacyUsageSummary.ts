import { dirname, join } from 'node:path';
import type { NativeComparisonReceipt } from '../adapters/codex/comparisonUsage.js';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { checkH06NativeLegacyCouncilUsage } from './comparisonH06NativeLegacyCouncilUsage.js';
import { checkH06NativeLegacyParentUsage } from './comparisonH06NativeLegacyParentUsage.js';
import { checkH06NativeLegacyAttemptUsage } from './comparisonH06NativeLegacyUsage.js';

/** Sum independently bound receipts without claiming an exhaustive native roster. */
export function checkH06NativeLegacyUsageSummary(value: unknown) {
  const input = object(value);
  exactFields(input, ['started', 'dispatch', 'parent', 'council']);
  const started = h04Pin(input.started);
  const start = object(JSON.parse(readH04Pin(started).toString()));
  const claim = h04Pin(start.claim);
  requireContract(
    claim.path === join(dirname(started.path), 'attempt-claim.json'),
    'h06-legacy-usage-summary-claim',
  );
  const budget = object(object(object(JSON.parse(readH04Pin(claim).toString())).request).budget);
  const { maxInputUncached, maxOutput } = budget;
  requireContract(
    typeof maxInputUncached === 'number' &&
      Number.isSafeInteger(maxInputUncached) &&
      maxInputUncached > 0 &&
      typeof maxOutput === 'number' &&
      Number.isSafeInteger(maxOutput) &&
      maxOutput > 0,
    'h06-legacy-usage-summary-budget',
  );

  const dispatch = object(input.dispatch);
  exactFields(dispatch, [
    'database',
    'warm',
    'cold',
    ...(Object.hasOwn(dispatch, 'completion') ? ['completion'] : []),
  ]);
  const writers = checkH06NativeLegacyAttemptUsage({ started, ...dispatch }).writerUsage;
  const parent = available(() => {
    if (input.parent === null) return null;
    const evidence = object(input.parent);
    exactFields(evidence, ['usageStart', 'coldResume']);
    return checkH06NativeLegacyParentUsage({
      started,
      parent: h04Pin(evidence.usageStart),
      coldResume: h04Pin(evidence.coldResume),
    });
  });
  const council = available(() => {
    if (input.council === null) return null;
    const evidence = object(input.council);
    exactFields(evidence, ['roles']);
    return checkH06NativeLegacyCouncilUsage({ started, roles: evidence.roles }).councilUsage;
  });
  const all: NativeComparisonReceipt[] = [];
  const seen = new Set<string>();
  for (const group of [writers, parent, council]) {
    if (group === null) continue;
    const participants = new Set(group.receipts.map(({ participant }) => participant));
    requireContract(
      [...participants].every((id) => !seen.has(id)),
      'h06-legacy-usage-summary-overlap',
    );
    for (const id of participants) seen.add(id);
    all.push(...group.receipts);
  }
  const subtotal = (key: 'responses' | 'input_uncached' | 'input_cached' | 'output') => {
    const total = all.reduce((sum, row) => sum + (row[key] ?? 0), 0);
    requireContract(Number.isSafeInteger(total), 'h06-legacy-usage-summary-overflow');
    return total;
  };
  const knownSubtotal = {
    responses: subtotal('responses'),
    inputUncached: subtotal('input_uncached'),
    inputCached: subtotal('input_cached'),
    output: subtotal('output'),
  };
  return {
    status:
      knownSubtotal.inputUncached > maxInputUncached || knownSubtotal.output > maxOutput
        ? 'OVER_BUDGET'
        : 'UNKNOWN',
    knownSubtotal,
    writers: writers.status,
    parent: parent?.status ?? 'UNKNOWN',
    council: council?.status ?? 'UNKNOWN',
    receipts: all,
    qualification: false,
    wholeAttemptComplete: false,
  } as const;
}

function available<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}
