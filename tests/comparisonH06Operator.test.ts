import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import { h01ReadJson, h01Record } from './comparisonH01Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  h06OperatorMain,
  normalizeH06SeriesEvidence,
  planH06Operator,
  readH06OperatorBinding,
  runH06Operator,
} from './comparisonH06Operator.js';

const nativeRun = vi.hoisted(() => ({
  check: vi.fn(),
  bind: vi.fn(),
  legacy: vi.fn(),
  temporal: vi.fn(),
  legacyPrimary: vi.fn(),
  temporalPrimary: vi.fn(),
  accounting: vi.fn(),
}));
vi.mock('./comparisonH06Package.js', () => ({
  checkH06Package: nativeRun.check,
  bindH06Package: nativeRun.bind,
}));
vi.mock('./comparisonH06DelegatedRun.js', () => ({ startH06DelegatedRun: nativeRun.legacy }));
vi.mock('./comparisonH06TemporalAutonomousRun.js', () => ({
  runH06TemporalAutonomousFromChat: nativeRun.temporal,
}));
vi.mock('./comparisonH06OperatorLegacyEvidence.js', () => ({
  verifyH06LegacySeriesPrimary: nativeRun.legacyPrimary,
}));
vi.mock('./comparisonH06TemporalSeriesPrimary.js', () => ({
  verifyH06TemporalSeriesPrimary: nativeRun.temporalPrimary,
}));
vi.mock('./comparisonH06SeriesAccounting.js', () => ({
  verifyH06SeriesAccounting: nativeRun.accounting,
}));

const roots: string[] = [];
const ref = ({ path, sha256 }: { path: string; sha256: string }): InputRef => ({
  locator: path,
  hash: sha256,
});
const pin = (path: string) => ({ path, sha256: digest(readFileSync(path)) });
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(
  engine: 'legacy' | 'temporal',
  disabledMcpServers?: string[],
  withSeriesRuntime = true,
  legacyMcpServers?: string[],
  clientVersion = '0.154.0',
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'aw-h06-operator-'));
  roots.push(root);
  const save = (name: string, value: unknown) => {
    const path = join(root, name);
    writeFileSync(path, canonical(value));
    return ref(pin(path));
  };
  const directory = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    return path;
  };
  const assets = h06Assets();
  const variant = engine === 'legacy' ? 'baseline' : 'candidate';
  const library = directory('runtime');
  const entry = save('runtime/native.ts', 'source');
  const profile = {
    model: 'model',
    effort: 'high',
    clientVersion,
    binary: save('client', 'codex-app-server'),
    rules: save('rules', 'rules'),
    executor: save('executor', 'executor'),
    reviewer: save('reviewer', 'reviewer'),
    ...(disabledMcpServers === undefined ? {} : { disabledMcpServers }),
  };
  const asPin = ({ locator, hash }: InputRef) => ({ path: locator, sha256: hash });
  const opId = 'h06-test';
  const budget = {
    maxElapsedMs: 180_000,
    reserveMs: 120_000,
    maxManagedStarts: 20,
    maxInputUncached: 200_000,
    maxOutput: 20_000,
  };
  const profileRef = save('profile.json', profile);
  const runtime = save('runtime.json', { engine, root: library, files: [entry] });
  const requestInput = {
    kind: 'comparison-h06-execution',
    schemaVersion: 1,
    material: ref(assets.materials),
    criteria: ref(assets.suite),
    profile: profileRef,
    runtime,
  };
  const request = save('request.json', requestInput);
  const packets = directory('packets');
  const packetPaths = {
    load: join(packets, 'load.json'),
    warmPause: join(packets, 'warm-pause.json'),
    warmResume: join(packets, 'warm-resume.json'),
    coldPause: join(packets, 'cold-pause.json'),
    coldResume: join(packets, 'cold-resume.json'),
  };
  const seriesRuntime = {
    tsx: fileURLToPath(import.meta.resolve('tsx')),
    series: fileURLToPath(new URL('./comparisonH01Series.ts', import.meta.url)),
    reader: fileURLToPath(new URL('../cli/main.ts', import.meta.url)),
  };
  const attemptFile = engine === 'legacy' ? 'packets/attempt.json' : 'attempt.json';
  const config = save('packets/config.json', {});
  const bootstrap = {
    profile: { model: profile.model, effort: profile.effort, clientVersion: profile.clientVersion },
    disabledServers: [],
    ...(legacyMcpServers === undefined ? {} : { disabledMcpServers: legacyMcpServers }),
  };
  const native = {
    kind: 'comparison-h06-native/2',
    binding: {
      operationId: opId,
      variant: engine,
      workspaceRoot: directory('workspace'),
      node: pin(realpathSync(process.execPath)),
      timeoutMs: 5,
    },
    evidenceRoot: join(root, opId),
    chat: { threadId: 'test', workspace: directory('chat') },
    budget,
    stimulus: { longStageMs: 5_000, initialLeaseMs: engine === 'legacy' ? 1_000 : null },
    appServer: asPin(profile.binary),
    server: engine === 'legacy' ? null : asPin(save('server', 'temporal')),
    bootstrap: asPin(save('bootstrap.json', bootstrap)),
    runtime: [
      asPin(profileRef),
      asPin(profile.rules),
      asPin(entry),
      ...(withSeriesRuntime ? Object.values(seriesRuntime).map(pin) : []),
      ...readdirSync(import.meta.dirname)
        .filter(
          (name) => /^comparisonH06.*\.(?:ts|mts|mjs)$/u.test(name) && !/\.test\./u.test(name),
        )
        .concat('comparisonH04Contract.ts')
        .map((name) => pin(join(import.meta.dirname, name))),
    ],
  };
  const attempt = asPin(save(attemptFile, native));
  const code = 'proposed native grant';
  const run = {
    kind: 'comparison-h06-temporal-autonomous-run/3',
    authority: asPin(
      save('authority.json', {
        kind: 'comparison-h06-temporal-autonomous/3',
        attempt,
        budget,
      }),
    ),
  };
  const packageSpec =
    engine === 'legacy'
      ? {
          kind: 'comparison-h06-package/1',
          profile: 'h06-autonomous-recovery/3',
          attempt,
          config: asPin(config),
          packets: { start: join(packets, 'start.json'), ...packetPaths },
        }
      : {
          kind: 'comparison-h06-package/1',
          profile: 'h06-autonomous-temporal/3',
          run: asPin(save('run.json', run)),
        };
  const manifest = {
    kind: 'comparison-h06-package-manifest/1',
    spec: packageSpec,
    requestHash: digest(canonical({ request: native, assets })),
    proposedGrants: { attempt: code },
    ...(engine === 'legacy' ? { composition: { actor: profile } } : {}),
  };
  nativeRun.check.mockImplementation((value: unknown) => value);
  const operatorRoot = join(root, 'operator');
  const specInput = {
    kind: 'comparison-h06-operator',
    schemaVersion: 1,
    package: save('manifest.json', manifest),
    evidenceRoot: operatorRoot,
  };
  const spec = save('spec.json', specInput);
  const start = asPin(save('bound.json', { authority: { source: true }, config: asPin(config) }));
  nativeRun.bind.mockResolvedValue({ start });
  nativeRun.legacy.mockResolvedValue({ legacy: true });
  nativeRun.temporal.mockResolvedValue({ temporal: true });
  const primary = {
    knownSubtotal: { observedResponses: 5, inputUncached: 10, inputCached: 2, output: 4 },
    stopped: true,
    budgetExceeded: false,
    evidence: [profile.rules],
    failed: false,
    receipt: null,
  };
  nativeRun.legacyPrimary.mockReturnValue(primary);
  nativeRun.temporalPrimary.mockReturnValue(primary);
  return {
    root,
    spec,
    request,
    opId,
    budget,
    operatorRoot,
    code,
    profile,
    primary,
    variant,
    native,
    start,
    config,
    specInput,
    requestInput,
    packageSpec,
    manifest,
    packets,
    packetPaths,
    seriesRuntime,
    run,
    save,
  };
}

it.each(['legacy', 'temporal'] as const)(
  'plans and binds the existing %s route',
  async (engine) => {
    const f = fixture(engine);
    expect(await h06OperatorMain(['--plan', f.spec.locator, f.request.locator])).toMatchObject({
      opId: f.opId,
      variant: f.variant,
      mayRun: false,
      qualification: false,
      budget: f.budget,
      proposedGrants: { attempt: f.code },
    });
    expect(lstatSync(f.operatorRoot, { throwIfNoEntry: false })).toBeUndefined();
    expect(nativeRun.bind).not.toHaveBeenCalled();
    const began = Date.now();
    const operator = await h06OperatorMain(['--run', f.spec.locator, f.request.locator]);
    const interval =
      engine === 'legacy' ? nativeRun.legacy.mock.calls[0]! : nativeRun.temporal.mock.calls[0]!;
    expect(interval.at(-1)).toBeGreaterThanOrEqual(began);
    expect(interval.at(-2)).toBeInstanceOf(AbortSignal);
    if (engine === 'legacy') expect(nativeRun.bind).toHaveBeenCalledOnce();
    else expect(nativeRun.bind).not.toHaveBeenCalled();
    expect(() => planH06Operator(f.spec, f.request)).toThrow('h06-series-not-fresh');
    const evidence = normalizeH06SeriesEvidence({
      runId: 'h06-slot',
      opId: f.opId,
      spec: f.spec,
      request: f.request,
      operator,
    });
    expect(evidence).toMatchObject({
      outcome: 'unknown',
      stopped: true,
      accounting: { unknown: true, output: null },
      knownSubtotal: f.primary.knownSubtotal,
      blocking: [
        'h06-series-whole-attempt-accounting-unknown',
        'h06-series-effective-participants-unconfirmed',
      ],
    });
    expect(evidence.operatorElapsedMs).toBeGreaterThan(0);
  },
);

it('preserves an unknown attempt as one consumed operator interval after a native refusal', async () => {
  const f = fixture('legacy');
  const signal = new AbortController();
  nativeRun.bind.mockRejectedValue(new Error('no primary grant'));
  const operator = await runH06Operator(f.spec, f.request, signal.signal);
  expect(operator.failure).toContain('no primary grant');
  expect(nativeRun.legacy).not.toHaveBeenCalled();
  expect(
    normalizeH06SeriesEvidence({
      runId: 'row',
      opId: f.opId,
      spec: f.spec,
      request: f.request,
      operator,
    }).blocking,
  ).toContain('h06-series-native-execution-unconfirmed');
  await expect(runH06Operator(f.spec, f.request)).rejects.toThrow('h06-series-not-fresh');
});

it('refuses an already aborted command before reserving its operation', async () => {
  const f = fixture('legacy');
  await expect(runH06Operator(f.spec, f.request, AbortSignal.abort())).rejects.toThrow();
  expect(lstatSync(f.operatorRoot, { throwIfNoEntry: false })).toBeUndefined();
});

it('preserves the work reserve before starting any managed work', async () => {
  const f = fixture('legacy');
  const start = { ns: process.hrtime.bigint() - 60_000_000_000n, wall: Date.now() - 60_000 };
  await expect(runH06Operator(f.spec, f.request, undefined, start)).rejects.toThrow(
    'h06-series-operator-deadline',
  );
  expect(nativeRun.bind).not.toHaveBeenCalled();
});

it.each(['legacy', 'temporal'] as const)(
  'inherits the series admission clocks in %s',
  async (engine) => {
    const f = fixture(engine);
    const start = { ns: process.hrtime.bigint() - 1_000_000_000n, wall: Date.now() - 1_000 };
    const result = await runH06Operator(f.spec, f.request, undefined, start);
    const native = engine === 'legacy' ? nativeRun.legacy : nativeRun.temporal;
    expect(native.mock.calls[0]!.at(-1)).toBe(start.wall);
    expect(result.startedNs).toBe(String(start.ns));
  },
);

it('rejects a malformed or future series clock without admission', async () => {
  const f = fixture('legacy');
  const start = { ns: process.hrtime.bigint(), wall: Date.now() };
  for (const clock of [
    { ...start, wall: NaN },
    { ...start, wall: 0 },
    { ...start, wall: start.wall + 60_000 },
    { ...start, ns: start.ns + 60_000_000_000n },
  ]) {
    await expect(runH06Operator(f.spec, f.request, undefined, clock)).rejects.toThrow(
      'h06-series-operator-clock',
    );
  }
  expect(nativeRun.bind).not.toHaveBeenCalled();
});

it.each(['0.154.0', '0.169.1', '0.171.0-alpha.13'])(
  'accepts the inventory pinned by Legacy on %s',
  (version) => {
    const f = fixture('legacy', ['extra-tool'], true, ['extra-tool'], version);
    expect(planH06Operator(f.spec, f.request).mayRun).toBe(false);
  },
);

it('accepts the Temporal bootstrap pinned to the Desktop CLI version', () => {
  const f = fixture('temporal', [], true, [], '0.171.0-alpha.13');
  expect(planH06Operator(f.spec, f.request).mayRun).toBe(false);
});

it('rejects a shared MCP restriction that the Legacy transport cannot enforce', () => {
  const f = fixture('legacy', ['extra-tool']);
  expect(() => planH06Operator(f.spec, f.request)).toThrow('h06-series-effective-profile');
  expect(nativeRun.bind).not.toHaveBeenCalled();
});

it('prints its direct plan and closes signal handlers after interruption', async () => {
  const f = fixture('temporal');
  const argv = process.argv,
    exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    process.argv = [
      'node',
      fileURLToPath(new URL('./comparisonH06Operator.ts', import.meta.url)),
      '--plan',
      f.spec.locator,
      f.request.locator,
    ];
    vi.resetModules();
    await import('./comparisonH06Operator.js');
    await vi.waitFor(() => expect(output).toHaveBeenCalledWith(expect.stringContaining(f.code)));
    nativeRun.temporal.mockImplementationOnce((_input, signal: AbortSignal) => {
      process.emit('SIGINT');
      signal.throwIfAborted();
    });
    process.argv[2] = '--run';
    vi.resetModules();
    await import('./comparisonH06Operator.js');
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('h06-series-operator-interrupted'),
      ),
    );
    process.argv[2] = '--unsupported';
    vi.resetModules();
    await import('./comparisonH06Operator.js');
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('h06-series-operator-arguments')),
    );
    expect(process.exitCode).toBe(1);
    process.argv = [];
    vi.resetModules();
    await import('./comparisonH06Operator.js');
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});

it('retains known excessive spend and missing STOP without upgrading accounting', async () => {
  const f = fixture('temporal');
  nativeRun.temporalPrimary.mockReturnValue({ ...f.primary, budgetExceeded: true, stopped: false });
  const operator = await runH06Operator(f.spec, f.request);
  const input = { runId: 'row', opId: f.opId, spec: f.spec, request: f.request, operator };
  const evidence = normalizeH06SeriesEvidence(input);
  expect(evidence).toMatchObject({
    outcome: 'failed',
    stopped: false,
    accounting: { unknown: true },
  });
  expect(evidence.blocking).toContain('h06-series-stop-unconfirmed');
  expect(evidence.blocking).toContain('h06-series-known-budget-exceeded');
  expect(
    normalizeH06SeriesEvidence({ ...input, operator: { ...operator, opId: 'changed' } }).blocking,
  ).toContain('h06-series-primary-unconfirmed');
  const { receipt, ...body } = operator;
  expect(h01ReadJson(receipt)).toEqual(body);
  for (const times of [
    { startedNs: 'bad', endedNs: '1' },
    { startedNs: '1', endedNs: 'bad' },
    { startedNs: '2', endedNs: '1' },
    { startedNs: '1', endedNs: '9990000000000' },
  ]) {
    const amended = { ...body, ...times };
    const evidence = normalizeH06SeriesEvidence({
      ...input,
      operator: { ...amended, receipt: h01Record(f.operatorRoot, 'operator-result', amended) },
    });
    expect(evidence.blocking).toContain(
      times.endedNs.length > 3 ? 'h06-series-operator-deadline' : 'h06-series-primary-unconfirmed',
    );
  }
});

it.each(['legacy', 'temporal'] as const)(
  'reconciles a completed %s attempt without rewriting its operator result',
  async (engine) => {
    const f = fixture(engine);
    const operator = await runH06Operator(f.spec, f.request);
    const command = f.save('step.json', {
      kind: 'comparison-h01-series-step',
      schemaVersion: 6,
      runId: 'row',
      request: f.request,
    });
    const input = {
      runId: 'row',
      opId: f.opId,
      spec: f.spec,
      request: f.request,
      operator,
      command,
    };
    const reconciliation = f.save('accounting.json', {});
    const receipt = {
      root: { session: 'root', startedAtMs: 1000 },
      managed: { receipts: [], starts: 3 },
    };
    const verify = engine === 'legacy' ? nativeRun.legacyPrimary : nativeRun.temporalPrimary;
    verify.mockReturnValue({ ...f.primary, receipt });
    const totals = { ...f.primary.knownSubtotal, observedResponses: 10, reservedManagedStarts: 4 };
    const window = { startedAtMs: 900, endedAtMs: 1200 };
    const externalTurns = ['root:approved'];
    nativeRun.accounting.mockReturnValue({
      totals,
      window,
      externalTurns,
      evidence: [reconciliation],
    });
    const verified = normalizeH06SeriesEvidence(input, reconciliation);
    expect(verified).toMatchObject({
      outcome: 'accepted',
      accounting: { ...totals, unknown: false },
      reconciliation: { window, externalTurns },
      blocking: [],
      startedNs: operator.startedNs,
      endedNs: operator.endedNs,
    });
    expect(Object.values(verified.checks!)).toEqual(Array(7).fill(true));
    expect(nativeRun.accounting).toHaveBeenCalledWith(reconciliation, {
      operator: operator.receipt,
      opId: f.opId,
      profile: f.profile,
      ...receipt,
      execution: {
        node: f.native.binding.node.path,
        tsx: f.seriesRuntime.tsx,
        series: f.seriesRuntime.series,
        step: command.locator,
        evidenceRoot: f.native.evidenceRoot,
        ...(engine === 'legacy'
          ? {
              legacy: {
                package: fileURLToPath(new URL('./comparisonH06Package.ts', import.meta.url)),
                reader: f.seriesRuntime.reader,
                packets: f.packetPaths,
              },
            }
          : {}),
      },
    });
    expect(normalizeH06SeriesEvidence(input).outcome).toBe('unknown');
    const { receipt: pin, ...original } = operator;
    expect(h01ReadJson(pin)).toEqual(original);

    for (const beyond of [
      { totals: { ...totals, reservedManagedStarts: f.budget.maxManagedStarts + 1 } },
      { totals: { ...totals, inputUncached: f.budget.maxInputUncached + 1 } },
      { totals: { ...totals, output: f.budget.maxOutput + 1 } },
      { window: { ...window, endedAtMs: window.startedAtMs + f.budget.maxElapsedMs + 1 } },
    ]) {
      nativeRun.accounting.mockReturnValue({
        totals,
        window,
        externalTurns,
        evidence: [],
        ...beyond,
      });
      expect(normalizeH06SeriesEvidence(input, reconciliation)).toMatchObject({
        outcome: 'failed',
        checks: verified.checks,
        accounting: { unknown: false },
        blocking: ['h06-series-whole-attempt-budget-exceeded'],
      });
    }
    nativeRun.accounting.mockReturnValue({
      totals: { ...totals, output: 0 },
      window,
      externalTurns,
      evidence: [],
    });
    expect(normalizeH06SeriesEvidence(input, reconciliation).blocking).toContain(
      'h06-series-reconciliation-unconfirmed',
    );
    verify.mockReturnValue({ ...f.primary, receipt, failed: true });
    expect(normalizeH06SeriesEvidence(input, reconciliation)).toMatchObject({
      outcome: 'failed',
      accounting: { unknown: true },
    });
  },
);

it('rejects reconciliation without a bound, immutable series step and runtime', async () => {
  const f = fixture('temporal', undefined, false);
  const operator = await runH06Operator(f.spec, f.request);
  const input = { runId: 'row', opId: f.opId, spec: f.spec, request: f.request, operator };
  const reconciliation = f.save('accounting.json', {});
  const step = {
    kind: 'comparison-h01-series-step',
    schemaVersion: 6,
    runId: 'row',
    request: f.request,
  };
  nativeRun.temporalPrimary.mockReturnValue({ ...f.primary, receipt: {} });
  const commands = [
    {},
    ...[{ kind: 'foreign' }, { schemaVersion: 5 }, { runId: 'other' }, { request: f.spec }, {}].map(
      (updates) => ({ command: f.save('step.json', { ...step, ...updates }) }),
    ),
  ];
  for (const command of commands)
    expect(normalizeH06SeriesEvidence({ ...input, ...command }, reconciliation).blocking).toContain(
      'h06-series-reconciliation-unconfirmed',
    );
  expect(nativeRun.accounting).not.toHaveBeenCalled();
});

it('keeps a missing native recovery or STOP ineligible for reconciliation', async () => {
  const f = fixture('legacy');
  const operator = await runH06Operator(f.spec, f.request);
  const input = { runId: 'row', opId: f.opId, spec: f.spec, request: f.request, operator };
  const reconciliation = f.save('accounting.json', {});
  for (const primary of [
    f.primary,
    { ...f.primary, stopped: false },
    { ...f.primary, budgetExceeded: true },
  ]) {
    nativeRun.legacyPrimary.mockReturnValue(primary);
    expect(normalizeH06SeriesEvidence(input, reconciliation).blocking).toContain(
      'h06-series-reconciliation-unconfirmed',
    );
  }
  expect(nativeRun.accounting).not.toHaveBeenCalled();
});

it('rejects wrapper and pinned package substitutions before reserving resources', async () => {
  const f = fixture('legacy');
  const assertSpec = (value: unknown, reason: string) =>
    expect(() => readH06OperatorBinding(f.save('bad-spec.json', value), f.request, 'run')).toThrow(
      reason,
    );
  const assertRequest = (value: unknown, reason: string) =>
    expect(() => readH06OperatorBinding(f.spec, f.save('bad-request.json', value), 'run')).toThrow(
      reason,
    );
  for (const spec of [{ kind: 'wrong' }, { schemaVersion: 2 }])
    assertSpec({ ...f.specInput, ...spec }, 'h06-series-spec');
  for (const req of [{ kind: 'wrong' }, { schemaVersion: 2 }])
    assertRequest({ ...f.requestInput, ...req }, 'h06-series-request');
  for (const pair of [
    ['material', f.profile.rules],
    ['criteria', f.profile.rules],
    ['profile', f.save('bad-profile.json', { ...f.profile, binary: f.profile.rules })],
    [
      'runtime',
      f.save('bad-runtime.json', {
        engine: 'legacy',
        root: join(f.root, 'runtime'),
        files: [f.save('runtime/foreign.ts', 'foreign')],
      }),
    ],
  ])
    assertRequest({ ...f.requestInput, [String(pair[0])]: pair[1] }, 'h06-series-runtime-profile');
  for (const path of [
    f.native.chat.workspace,
    f.native.evidenceRoot,
    f.native.binding.workspaceRoot,
    join(f.root, 'runtime'),
    f.request.locator,
    f.packets,
  ])
    assertSpec({ ...f.specInput, evidenceRoot: path }, 'h06-series-roots-overlap');
  for (const [manifest, reason] of [
    [{ ...f.manifest, kind: 'wrong' }, 'h06-series-package-profile'],
    [{ ...f.manifest, spec: { ...f.packageSpec, kind: 'wrong' } }, 'h06-series-package-profile'],
    [{ ...f.manifest, spec: { ...f.packageSpec, profile: 'wrong' } }, 'h06-series-package-profile'],
    [{ ...f.manifest, requestHash: 'bad' }, 'h06-series-attempt-binding'],
    [
      { ...f.manifest, spec: { ...f.packageSpec, packets: { start: f.spec.locator } } },
      'h06-series-roots-overlap',
    ],
  ] as const)
    assertSpec({ ...f.specInput, package: f.save('bad-manifest.json', manifest) }, reason);
  await expect(h06OperatorMain([])).rejects.toThrow('h06-series-operator-arguments');
  await expect(h06OperatorMain(['--bad', f.spec.locator, f.request.locator])).rejects.toThrow(
    'h06-series-operator-arguments',
  );
});
