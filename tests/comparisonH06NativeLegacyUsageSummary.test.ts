import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import { checkH06NativeLegacyUsageSummary } from './comparisonH06NativeLegacyUsageSummary.js';

const evidence = vi.hoisted(() => ({ writers: vi.fn(), parent: vi.fn(), council: vi.fn() }));
vi.mock('./comparisonH06NativeLegacyUsage.js', () => ({
  checkH06NativeLegacyAttemptUsage: evidence.writers,
}));
vi.mock('./comparisonH06NativeLegacyParentUsage.js', () => ({
  checkH06NativeLegacyParentUsage: evidence.parent,
}));
vi.mock('./comparisonH06NativeLegacyCouncilUsage.js', () => ({
  checkH06NativeLegacyCouncilUsage: evidence.council,
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function usage(participant: string, input: number | null, output: number | null) {
  return {
    status: 'RECORDED',
    receipts: [{ participant, responses: 1, input_uncached: input, input_cached: 2, output }],
  };
}

beforeEach(() => {
  evidence.writers.mockReset().mockReturnValue({ writerUsage: usage('writer', 9, 1) });
  evidence.parent.mockReset().mockReturnValue(usage('actor', 2, 2));
  evidence.council.mockReset().mockReturnValue({ councilUsage: usage('adviser', null, 3) });
});

function fixture(
  maxInputUncached: unknown = 20,
  maxOutput: unknown = 20,
  name = 'attempt-claim.json',
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-usage-summary-'));
  roots.push(root);
  const pin = (name: string, value: unknown) => {
    const path = join(root, name);
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const claim = pin(name, { request: { budget: { maxInputUncached, maxOutput } } });
  const started = pin('legacy-operator-start.json', { claim });
  return {
    started,
    dispatch: { database: null, warm: null, cold: null },
    parent: { usageStart: pin('parent.json', {}), coldResume: pin('cold.json', {}) },
    council: { roles: [] },
  };
}

it('adds independent lower bounds and leaves the whole attempt unqualified', () => {
  expect(checkH06NativeLegacyUsageSummary(fixture())).toMatchObject({
    status: 'UNKNOWN',
    knownSubtotal: { responses: 3, inputUncached: 11, inputCached: 6, output: 6 },
    writers: 'RECORDED',
    parent: 'RECORDED',
    council: 'RECORDED',
    wholeAttemptComplete: false,
    qualification: false,
  });
  for (const caps of [
    [10, 20],
    [20, 5],
  ])
    expect(checkH06NativeLegacyUsageSummary(fixture(...caps)).status).toBe('OVER_BUDGET');
});

it('keeps the Writer subtotal when an optional source is absent, but propagates other errors', () => {
  const f = fixture();
  evidence.parent.mockImplementation(() => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  expect(checkH06NativeLegacyUsageSummary({ ...f, council: null })).toMatchObject({
    parent: 'UNKNOWN',
    council: 'UNKNOWN',
    knownSubtotal: { responses: 1, inputUncached: 9 },
  });
  expect(checkH06NativeLegacyUsageSummary({ ...f, parent: null }).parent).toBe('UNKNOWN');
  evidence.parent.mockImplementation(() => {
    throw new Error('tampered');
  });
  expect(() => checkH06NativeLegacyUsageSummary(f)).toThrow('tampered');
});

it('forwards the explicit third Writer evidence through the summary', () => {
  const f = fixture();
  const dispatch = { ...f.dispatch, completion: { coder: f.started, thread: f.parent.coldResume } };
  const result = checkH06NativeLegacyUsageSummary({ ...f, dispatch });
  expect(result.writers).toBe('RECORDED');
  expect(evidence.writers).toHaveBeenCalledExactlyOnceWith({ started: f.started, ...dispatch });
});

it('rejects duplicate participants, overflow and a foreign claim', () => {
  const f = fixture();
  evidence.parent.mockReturnValueOnce(usage('writer', 2, 2));
  expect(() => checkH06NativeLegacyUsageSummary(f)).toThrow('h06-legacy-usage-summary-overlap');
  evidence.parent.mockReturnValueOnce(usage('actor', Number.MAX_SAFE_INTEGER, 2));
  expect(() => checkH06NativeLegacyUsageSummary(f)).toThrow('h06-legacy-usage-summary-overflow');
  expect(() => checkH06NativeLegacyUsageSummary(fixture(10, 10, 'foreign.json'))).toThrow(
    'h06-legacy-usage-summary-claim',
  );
});

it.each([
  ['10', 10],
  [1.5, 10],
  [0, 10],
  [10, '10'],
  [10, 1.5],
  [10, 0],
])('rejects invalid caps %s/%s', (input, output) => {
  expect(() => checkH06NativeLegacyUsageSummary(fixture(input, output))).toThrow(
    'h06-legacy-usage-summary-budget',
  );
});
