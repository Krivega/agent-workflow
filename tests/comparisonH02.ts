import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { readPrivateFile, safeDirectory, syncDirectory } from '../adapters/storage/storeFiles.js';
import { requireWorkflow } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { h02Material, h02Scenario, type H02CaseSummary } from './comparisonH02Contract.js';
import { createH02LegacyFixture } from './comparisonH02LegacyFixture.js';
import { runH02LegacyCase } from './comparisonH02Legacy.js';
import { createH02TemporalFixture } from './comparisonH02TemporalFixture.js';
import { runH02TemporalCase } from './comparisonH02Temporal.js';

const flags = {
  qualification: false,
  nativeAcceptance: false,
  partialScope: true,
  nativeUsage: null,
  nativeModelStarts: 0,
  serviceStarts: 0,
} as const;

export function planH02Technical() {
  return {
    kind: 'comparison-h02-technical-plan',
    schemaVersion: 1,
    ...flags,
    mayRun: false,
    allowedModelStarts: 0,
    scenario: h02Scenario.id,
    checks: h02Scenario.checks,
    materialHash: digest(canonical(h02Material)),
    variants: ['legacy-council', 'temporal-activities'],
    initial: 'pricing FAIL at 5; logging/storage complete PASS',
    repaired: 'pricing 7; one new pricing review; retained logging/storage answers',
    scope:
      'fixed local RPC fixtures and real policy/activities; not Workflow or native qualification',
  };
}

function confirmed(report: H02CaseSummary, variant: H02CaseSummary['variant']) {
  requireWorkflow(
    report.variant === variant &&
      report.engine === (variant === 'legacy' ? 'legacy-council' : 'temporal-activities') &&
      ['accepted', 'failed', 'unknown'].includes(report.outcome) &&
      canonical(Object.keys(report.checks).sort()) === canonical([...h02Scenario.checks].sort()) &&
      Object.values(report.checks).every((value) => typeof value === 'boolean') &&
      report.qualification === false &&
      report.nativeAcceptance === false &&
      report.partialScope === true &&
      report.nativeUsage === null,
    'h02-technical-report-shape',
  );
  for (const value of [report.effects, ...Object.values(report.effects.byPhase)])
    requireWorkflow(
      ['threadStarts', 'turnStarts'].every(
        (key) =>
          Number.isSafeInteger(value[key as keyof typeof value]) &&
          Number(value[key as keyof typeof value]) >= 0,
      ),
      'h02-technical-counts',
    );
  requireWorkflow(
    (['threadStarts', 'turnStarts'] as const).every(
      (key) =>
        Object.values(report.effects.byPhase).reduce((sum, value) => sum + value[key], 0) ===
        report.effects[key],
    ),
    'h02-technical-count-total',
  );
  requireWorkflow(report.evidence.length > 0, 'h02-technical-evidence-missing');
  for (const ref of report.evidence) {
    requireWorkflow(
      isAbsolute(ref.locator) && resolve(ref.locator) === ref.locator,
      'h02-technical-evidence-path',
    );
    safeDirectory(dirname(ref.locator));
    requireWorkflow(
      digest(readPrivateFile(ref.locator)) === ref.hash,
      'h02-technical-evidence-changed',
    );
  }
  return (
    report.outcome === 'accepted' &&
    report.blocking.length === 0 &&
    Object.values(report.checks).every(Boolean)
  );
}

/** Runs fixed local ports only. This entrypoint never constructs a native client or SDK service. */
export async function selfTestH02(output: string, signal?: AbortSignal) {
  requireWorkflow(isAbsolute(output) && resolve(output) === output, 'h02-technical-output-path');
  safeDirectory(dirname(output));
  requireWorkflow(!existsSync(output), 'h02-technical-output-exists');
  signal?.throwIfAborted();
  mkdirSync(output, { mode: 0o700 });
  syncDirectory(dirname(output));
  const owner = lstatSync(output);
  const verifyOwner = () => {
    safeDirectory(output);
    const actual = lstatSync(output);
    requireWorkflow(
      actual.dev === owner.dev && actual.ino === owner.ino,
      'h02-technical-owner-changed',
    );
  };
  const save = (name: string, value: unknown): InputRef => {
    verifyOwner();
    const locator = join(output, name),
      bytes = Buffer.from(canonical(value) + '\n');
    writeFileSync(locator, bytes, { flag: 'wx', mode: 0o600 });
    syncDirectory(output);
    return { locator, hash: digest(bytes) };
  };
  const started = performance.now();
  save('technical-start.json', planH02Technical());
  const cases: {
    variant: H02CaseSummary['variant'];
    passed: boolean;
    report: InputRef;
    effects: H02CaseSummary['effects'];
  }[] = [];
  for (const variant of ['legacy', 'temporal'] as const) {
    signal?.throwIfAborted();
    const root = join(output, variant);
    const report: H02CaseSummary =
      variant === 'legacy'
        ? await runH02LegacyCase(await createH02LegacyFixture(root, signal))
        : await runH02TemporalCase(createH02TemporalFixture(root, signal));
    verifyOwner();
    signal?.throwIfAborted();
    cases.push({
      variant,
      passed: confirmed(report, variant),
      report: save(variant + '-report.json', report),
      effects: report.effects,
    });
  }
  const result = {
    kind: 'comparison-h02-technical-report',
    schemaVersion: 1,
    status: cases.every((entry) => entry.passed) ? 'PASS' : 'FAIL',
    ...flags,
    cases,
    elapsedMs: performance.now() - started,
    scope: 'fixed local RPC fixtures; policy/activities only; native usage remains unknown',
  };
  return { ...result, report: save('technical-result.json', result) };
}

export async function h02Main(args: string[]) {
  requireWorkflow(
    (args.length === 1 && args[0] === '--plan') || (args.length === 2 && args[0] === '--self-test'),
    'h02-technical-usage',
  );
  const result = args[0] === '--plan' ? planH02Technical() : await selfTestH02(resolve(args[1]!));
  process.stdout.write(canonical(result) + '\n');
  if ('status' in result && result.status !== 'PASS') process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h02Main(process.argv.slice(2)).catch(() => {
    process.stderr.write('h02-technical-failed\n');
    process.exitCode = 1;
  });
