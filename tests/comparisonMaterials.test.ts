import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import materialsSource from '../comparison/materials.json' with { type: 'json' };
import suiteSource from '../comparison/suite.json' with { type: 'json' };
import { parseComparisonMaterials, parseComparisonSuite } from '../core/comparison.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  checkH02Material,
  h02Material,
  h02Scenario,
  type H02CaseSummary,
} from './comparisonH02Contract.js';
import { h02Main, planH02Technical, selfTestH02 } from './comparisonH02.js';
import * as H02Legacy from './comparisonH02Legacy.js';
import * as H02Temporal from './comparisonH02Temporal.js';

afterEach(() => vi.restoreAllMocks());
const suite = parseComparisonSuite(suiteSource);
it('freezes concrete tasks and reproduces both local defects before their repairs', () => {
  const materials = parseComparisonMaterials(materialsSource, suite);
  expect(materials.map((material) => material.id)).toEqual(
    suite.scenarios.map((scenario) => scenario.id),
  );
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'comparison-material-')));
  try {
    for (const material of materials.slice(0, 2)) {
      for (const [name, content] of Object.entries(material.files))
        writeFileSync(resolve(root, name), content);
      expect(() =>
        execFileSync(process.execPath, ['checks.mjs'], { cwd: root, stdio: 'pipe' }),
      ).toThrow();
      if (material.id === 'H-01')
        writeFileSync(
          resolve(root, 'range.mjs'),
          'export const contains = (value, min, max) => value >= min && value <= max;\n',
        );
      else writeFileSync(resolve(root, 'pricing.json'), '{"rate":7}\n');
      execFileSync(process.execPath, ['checks.mjs'], { cwd: root, stdio: 'pipe' });
    }
    for (const material of materials.slice(2)) {
      for (const [name, content] of Object.entries(material.files))
        writeFileSync(resolve(root, name), content);
      expect(() =>
        execFileSync(process.execPath, ['checks.mjs'], { cwd: root, stdio: 'pipe' }),
      ).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each([
  { schema_version: 2 },
  { cases: null },
  { cases: [] },
  { cases: materialsSource.cases.map((material) => ({ ...material, id: 'wrong' })) },
  { cases: materialsSource.cases.map((material) => ({ ...material, mutable: null })) },
  { cases: materialsSource.cases.map((material) => ({ ...material, instructions: '' })) },
  { cases: materialsSource.cases.map((material) => ({ ...material, files: {} })) },
  {
    cases: materialsSource.cases.map((material) => ({
      ...material,
      files: { ...material.files, bad: 1 },
    })),
  },
  {
    cases: materialsSource.cases.map((material) => ({
      ...material,
      files: { ...material.files, '../outside': 'bad' },
    })),
  },
  { cases: materialsSource.cases.map((material) => ({ ...material, mutable: ['checks.mjs'] })) },
  { cases: materialsSource.cases.map((material) => ({ ...material, mutable: ['package.json'] })) },
  { cases: materialsSource.cases.map((material) => ({ ...material, mutable: ['absent'] })) },
  {
    cases: materialsSource.cases.map((material) => ({
      ...material,
      mutable: ['checks.mjs', 'checks.mjs'],
    })),
  },
])('rejects incomplete materials or an editable validation %j', (patch) => {
  expect(() => parseComparisonMaterials({ ...materialsSource, ...patch }, suite)).toThrow();
});

it('runs both real H02 technical adapters with fixed local ports and retains primary reports', async () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'h02-technical-cli-')));
  try {
    const plan = planH02Technical();
    expect(plan).toMatchObject({
      mayRun: false,
      allowedModelStarts: 0,
      nativeUsage: null,
      qualification: false,
    });
    expect(plan.checks).toEqual(h02Scenario.checks);
    const result = await selfTestH02(resolve(root, 'run'), new AbortController().signal);
    expect(result).toMatchObject({
      status: 'PASS',
      nativeModelStarts: 0,
      serviceStarts: 0,
      qualification: false,
      nativeAcceptance: false,
      partialScope: true,
    });
    expect(result.cases.map((entry) => entry.variant)).toEqual(['legacy', 'temporal']);
    for (const entry of result.cases) {
      expect(digest(readFileSync(entry.report.locator))).toBe(entry.report.hash);
      const report = JSON.parse(readFileSync(entry.report.locator, 'utf8')) as H02CaseSummary;
      expect(report.checks).toEqual(
        Object.fromEntries(h02Scenario.checks.map((key) => [key, true])),
      );
      expect(report.nativeUsage).toBeNull();
    }
    await expect(selfTestH02(resolve(root, 'run'))).rejects.toThrow('h02-technical-output-exists');
    await expect(selfTestH02('relative')).rejects.toThrow('h02-technical-output-path');
    const controller = new AbortController();
    controller.abort();
    await expect(selfTestH02(resolve(root, 'aborted'), controller.signal)).rejects.toThrow();
    expect(existsSync(resolve(root, 'aborted'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it('executes only the original checker and rejects changes to its immutable inputs', async () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'h02-oracle-')));
  try {
    for (const [name, bytes] of Object.entries(h02Material.files))
      writeFileSync(resolve(root, name), bytes);
    expect(await checkH02Material(root)).toBe(false);
    writeFileSync(resolve(root, 'pricing.json'), '{"rate":7}\n');
    expect(await checkH02Material(root)).toBe(true);
    writeFileSync(resolve(root, 'pricing.json'), '{"rate":8}\n');
    expect(await checkH02Material(root)).toBe(false);
    writeFileSync(resolve(root, 'pricing.json'), '{"rate":7}\n');
    expect(await checkH02Material(root)).toBe(true);
    writeFileSync(resolve(root, 'checks.mjs'), 'throw new Error("replacement")');
    await expect(checkH02Material(root)).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects malformed technical summaries and preserves failed checks without granting native acceptance', async () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'h02-summary-')));
  const proof = resolve(root, 'proof.json');
  writeFileSync(proof, '{}\n');
  const make = (variant: 'legacy' | 'temporal'): H02CaseSummary => ({
    variant,
    engine: variant === 'legacy' ? 'legacy-council' : 'temporal-activities',
    outcome: 'accepted',
    checks: Object.fromEntries(h02Scenario.checks.map((key) => [key, true])),
    blocking: [],
    effects: {
      threadStarts: 0,
      turnStarts: 0,
      byPhase: { initial: { threadStarts: 0, turnStarts: 0 } },
    },
    evidence: [{ locator: proof, hash: digest('{}\n') }],
    nativeUsage: null,
    nativeAcceptance: false,
    qualification: false,
    partialScope: true,
  });
  const legacy = vi.spyOn(H02Legacy, 'runH02LegacyCase');
  const temporal = vi.spyOn(H02Temporal, 'runH02TemporalCase');
  const deliver = (report: H02CaseSummary) => {
    legacy.mockResolvedValue(report as Awaited<ReturnType<typeof H02Legacy.runH02LegacyCase>>);
    temporal.mockResolvedValue(
      make('temporal') as Awaited<ReturnType<typeof H02Temporal.runH02TemporalCase>>,
    );
  };
  try {
    const mutations: ((report: H02CaseSummary) => void)[] = [
      (r) => {
        r.variant = 'temporal';
      },
      (r) => {
        r.engine = 'temporal-activities';
      },
      (r) => {
        r.outcome = 'invalid' as H02CaseSummary['outcome'];
      },
      (r) => {
        r.checks = {};
      },
      (r) => {
        r.checks['unchanged-pass'] = null as unknown as boolean;
      },
      (r) => {
        r.nativeAcceptance = true as unknown as false;
      },
      (r) => {
        r.qualification = true as unknown as false;
      },
      (r) => {
        r.partialScope = false as unknown as true;
      },
      (r) => {
        r.nativeUsage = {} as unknown as null;
      },
      (r) => {
        r.effects.turnStarts = -1;
      },
      (r) => {
        r.effects.threadStarts = Number.NaN;
      },
      (r) => {
        r.effects.turnStarts = 1;
      },
      (r) => {
        r.evidence = [];
      },
      (r) => {
        r.evidence[0]!.locator = 'relative';
      },
      (r) => {
        r.evidence[0]!.hash = '0'.repeat(64);
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const report = make('legacy');
      mutate(report);
      deliver(report);
      await expect(selfTestH02(resolve(root, 'invalid-' + index))).rejects.toThrow();
    }
    for (const [index, mutate] of [
      (r: H02CaseSummary) => {
        r.outcome = 'failed';
      },
      (r: H02CaseSummary) => {
        r.blocking = ['not-confirmed'];
      },
      (r: H02CaseSummary) => {
        r.checks['open-fail'] = false;
      },
    ].entries()) {
      const report = make('legacy');
      mutate(report);
      deliver(report);
      expect((await selfTestH02(resolve(root, 'failed-' + index))).status).toBe('FAIL');
    }
    deliver(make('legacy'));
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const previous = process.exitCode;
    try {
      await h02Main(['--plan']);
      expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
        mayRun: false,
        qualification: false,
      });
      output.mockClear();
      await h02Main(['--self-test', resolve(root, 'cli')]);
      expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
        status: 'PASS',
        nativeAcceptance: false,
      });
      const report = make('legacy');
      report.outcome = 'unknown';
      deliver(report);
      await h02Main(['--self-test', resolve(root, 'cli-fail')]);
      expect(process.exitCode).toBe(1);
      await expect(h02Main([])).rejects.toThrow('h02-technical-usage');
    } finally {
      process.exitCode = previous;
    }
    expect(canonical(make('legacy'))).not.toContain('provider');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it('starts the H02 CLI only at its own entrypoint and hides native exception text', async () => {
  const argv = process.argv,
    previous = process.exitCode;
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const entry = fileURLToPath(new URL('./comparisonH02.ts', import.meta.url));
  try {
    process.argv = ['node'];
    vi.resetModules();
    await import('./comparisonH02.js');
    expect(stdout).not.toHaveBeenCalled();
    process.argv = ['node', entry, '--plan'];
    vi.resetModules();
    await import('./comparisonH02.js');
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({
      mayRun: false,
      qualification: false,
    });
    process.argv = ['node', entry, '--invalid'];
    vi.resetModules();
    await import('./comparisonH02.js');
    await Promise.resolve();
    expect(stderr.mock.calls.flat().join('')).toBe('h02-technical-failed\n');
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = argv;
    process.exitCode = previous;
  }
});
