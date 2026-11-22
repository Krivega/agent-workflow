import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import type { CoderBrief } from '../core/coder.js';
import type { H04Pin } from './comparisonH04Contract.js';
import type { H06DelegatedPhase } from './comparisonH06DelegatedAuthority.js';
import { localFixture } from './localFixtures.js';
import {
  checkH06Package,
  bindH06Package,
  admitH06Package,
  settleH06Package,
  h06PackageEntry,
  h06PackageMain,
  planH06Package,
} from './comparisonH06Package.js';

const calls = vi.hoisted(() => ({
  autonomous: vi.fn(),
  authority: vi.fn(),
  claim: vi.fn(),
  temporal: vi.fn(),
  temporalRun: vi.fn(),
  temporalAutonomous: vi.fn(),
  temporalAutonomousRun: vi.fn(),
  start: vi.fn(),
  publish: vi.fn(),
  warm: vi.fn(),
  cold: vi.fn(),
  current: vi.fn(),
  execute: vi.fn(),
  inspect: vi.fn(),
  admit: vi.fn(),
  settle: vi.fn(),
  delivery: vi.fn(),
  wait: vi.fn<(ms: number) => Promise<void>>(),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: calls.wait }));
vi.mock('./comparisonH06DelegatedDelivery.js', () => ({
  planH06DelegatedDelivery: calls.delivery,
}));
vi.mock('./comparisonH06DelegatedAuthority.js', () => ({
  planH06AutonomousGrant: calls.autonomous,
  planH06DelegatedAuthority: calls.authority,
  readH06DelegatedAuthority: calls.claim,
  h06DelegatedStages: [
    'load',
    'warm-pause',
    'warm-resume',
    'cold-pause',
    'cold-resume',
    'completion',
  ],
  h06DelegatedPhaseAction: (stage: string) =>
    stage === 'load' ? 'LOAD' : stage.endsWith('pause') ? 'PAUSE' : 'RESUME',
  openH06DelegatedPhaseLedger: () => ({
    inspect: calls.inspect,
    admitPhase: calls.admit,
    settlePhase: calls.settle,
  }),
}));
vi.mock('./comparisonH06NativeAuthority.js', () => ({ currentH06HumanAuthority: calls.current }));
vi.mock('../adapters/storage/sqliteEvidenceStore.js', () => ({
  SqliteEvidenceStore: class {
    execute(value: unknown) {
      return calls.execute(value) as unknown;
    }
  },
  unwrap: (value: unknown) => value,
}));
vi.mock('./comparisonH06DelegatedRun.js', () => ({
  startH06DelegatedRun: calls.start,
  publishH06DelegatedCommand: calls.publish,
  runH06DelegatedWarm: calls.warm,
  runH06DelegatedCold: calls.cold,
}));
vi.mock('./comparisonH06NativeTemporalRun.js', () => ({
  planH06NativeTemporalRun: calls.temporal,
  h06NativeTemporalRunMain: calls.temporalRun,
}));
vi.mock('./comparisonH06TemporalAutonomousRun.js', () => ({
  planH06TemporalAutonomousRun: calls.temporalAutonomous,
  h06TemporalAutonomousRunMain: calls.temporalAutonomousRun,
}));

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture() {
  const f = await localFixture(),
    root = mkdtempSync(join(realpathSync(tmpdir()), "h06-package '$()-"));
  cleanup.push(f.dispose, () => rmSync(root, { recursive: true, force: true }));
  const pin = (path: string): H04Pin => ({ path, sha256: digest(readFileSync(path)) });
  const save = (name: string, value: unknown) => {
    const path = join(root, name);
    writeFileSync(path, canonical(value) + '\n');
    return pin(path);
  };
  await f.file('planning.json', JSON.stringify({ schema_version: 1, task_id: 'task' }));
  const spec: typeof f.spec = {
    ...f.spec,
    host_id: 'local',
    route: { kind: 'substantial', accepted_plan: await f.ref('planning.json') },
  };
  const bootstrap = {
    projectId: spec.project_id,
    runId: spec.run_id,
    actorId: spec.session_id,
    generation: 1,
  };
  const request = {
    binding: { operationId: 'task', workspaceRoot: f.root, node: save('node', 'fixture node') },
    runtime: [
      pin(fileURLToPath(import.meta.resolve('tsx'))),
      pin(h06PackageEntry),
      pin(fileURLToPath(new URL('../cli/main.ts', import.meta.url))),
    ],
    evidenceRoot: join(root, 'task'),
    bootstrap: save('bootstrap.json', bootstrap),
    chat: { threadId: 'root-thread', workspace: root },
  };
  const preparation = {
    kind: 'comparison-h06-native-legacy-preparation/2',
    descriptor: 'connection.json',
    planningFile: spec.route.kind === 'substantial' ? spec.route.accepted_plan!.locator : '',
    marker: 'package-load',
    spec,
  };
  const makeBrief = (id: string): CoderBrief => ({
    id,
    project_id: spec.project_id,
    task_id: 'task',
    parent_run_id: spec.run_id,
    parent_session_id: spec.session_id,
    source_root: f.root,
    copy_root: join(request.evidenceRoot, 'coder-workspaces', id),
    generation: 1,
    card: 'task_id' in spec.identity ? spec.identity.card : spec.assignment,
    authority: spec.assignment,
    paths: ['source.txt'],
    files: spec.sources,
    goal: 'fixture writer',
    criterion: 'same scope',
    checks: [],
    profile: { model: spec.requested.model, effort: spec.requested.effort },
    rules: spec.rules,
    procedures: spec.procedures,
  });
  const briefs = { warm: makeBrief('warm'), cold: makeBrief('cold'), final: makeBrief('final') };
  const config = {
    preparation: save('preparation.json', preparation),
    warm: save('warm.json', briefs.warm),
    cold: save('cold.json', briefs.cold),
    final: save('final.json', briefs.final),
  };
  let configPin = save('config.json', config);
  const attempt = save('attempt.json', request);
  const input = {
    kind: 'comparison-h06-package/1',
    profile: 'h06-autonomous-recovery/3',
    attempt,
    config: configPin,
    packets: Object.fromEntries(
      ['start', 'load', 'warmPause', 'warmResume', 'coldPause', 'coldResume'].map((stage) => [
        stage,
        join(root, stage + '.json'),
      ]),
    ),
  };
  const refresh = () => {
    config.preparation = save('preparation.json', preparation);
    for (const stage of ['warm', 'cold', 'final'] as const)
      config[stage] = save(stage + '.json', briefs[stage]);
    configPin = save('config.json', config);
    input.config = configPin;
    request.runtime.splice(3, Infinity, configPin, ...Object.values(config));
  };
  refresh();
  const plan = {
    request,
    requestHash: 'request-hash',
    expectedGrantText: 'exact-attempt-grant',
    input: { attempt },
    actorId: spec.session_id,
    source: { turnId: 'human-turn', source: { locator: 'native.jsonl#L3', hash: 'a'.repeat(64) } },
    grant: { sessionsRoot: root },
    workDeadlineMs: Date.now() + 60000,
  };
  calls.autonomous.mockReturnValue(plan);
  calls.authority.mockReturnValue(plan);
  calls.claim.mockReturnValue(plan);
  const nativeSource = {
    transcript: join(root, 'native.jsonl'),
    turnId: 'human-turn',
    source: plan.source.source,
  };
  calls.current.mockResolvedValue(nativeSource);
  const temporal = {
    plan: { attempt: plan, expectedGrantText: 'exact-server-grant' },
    worker: { fixture: true },
  };
  calls.temporal.mockReturnValue(temporal);
  const run = save('temporal-run.json', { fixture: 'existing temporal run' });
  return {
    ...f,
    root,
    pin,
    save,
    input,
    request,
    plan,
    nativeSource,
    temporal,
    run,
    preparation,
    briefs,
    config,
    refresh,
  };
}

it('prepares and rechecks immutable source-free Legacy commands without executing authority', async () => {
  const f = await fixture(),
    manifest = planH06Package(f.input);
  expect(manifest).toMatchObject({
    source: null,
    claimIssued: false,
    mayRun: false,
    qualification: false,
    requestHash: 'request-hash',
    proposedGrants: { attempt: 'exact-attempt-grant' },
  });
  expect(checkH06Package(manifest)).toEqual(manifest);
  const commands = manifest.commands;
  expect(Object.keys(commands)).toEqual([
    'start',
    'load',
    'warmPause',
    'warmResume',
    'coldPause',
    'coldResume',
  ]);
  for (const command of Object.values(commands)) {
    const argv = execFileSync('/bin/sh', [
      '-c',
      'set -- ' + command.shell + '; printf "%s\\0" "$@"',
    ])
      .toString()
      .split('\0')
      .slice(0, -1);
    expect(argv).toEqual(command.argv);
    expect(argv.slice(3, 5)).toEqual([h06PackageEntry, argv[4]]);
    expect(argv.length).toBe(6);
  }
  const specFile = f.save('spec.json', f.input),
    manifestFile = f.save('manifest.json', manifest);
  await expect(h06PackageMain(['--prepare', specFile.path])).resolves.toEqual(manifest);
  await expect(h06PackageMain(['--check', manifestFile.path])).resolves.toEqual(manifest);
  for (const changed of [
    { source: 'forged' },
    { mayRun: true },
    { commands: {} },
    { proposedGrants: {} },
  ])
    expect(() => checkH06Package({ ...manifest, ...changed })).toThrow(
      'h06-package-manifest-changed',
    );
  expect(calls.authority).not.toHaveBeenCalled();
  for (const operation of [calls.start, calls.publish, calls.warm, calls.cold, calls.temporalRun])
    expect(operation).not.toHaveBeenCalled();
  writeFileSync(f.config.warm.path, 'changed');
  expect(() => checkH06Package(manifest)).toThrow('h04-pin-changed');
});

it('uses the existing Temporal planner and carries separate server and attempt grants', async () => {
  const f = await fixture(),
    input = { kind: 'comparison-h06-package/1', profile: 'h06-native-temporal/2', run: f.run };
  const manifest = planH06Package(input);
  expect(manifest).toMatchObject({
    source: null,
    worker: f.temporal.worker,
    proposedGrants: { server: 'exact-server-grant', attempt: 'exact-attempt-grant' },
  });
  expect(manifest.commands.run?.argv.slice(-2)).toEqual(['--run', f.run.path]);
  calls.temporalRun.mockResolvedValue('completed');
  await expect(h06PackageMain(['--run', f.run.path])).resolves.toBe('completed');
  expect(calls.temporalRun).toHaveBeenCalledWith(['--run', f.run.path]);
  f.request.runtime.length = 0;
  await expect(h06PackageMain(['--run', f.run.path])).rejects.toThrow('h06-package-runtime');
  expect(calls.temporalRun).toHaveBeenCalledTimes(1);
});

it.each([
  ['h06-autonomous-temporal/3', 'comparison-h06-temporal-autonomous-run/3'],
  ['h06-reference-temporal/4', 'comparison-h06-temporal-reference-run/4'],
])('prepares %s and dispatches only its verified %s', async (profile, kind) => {
  const f = await fixture(),
    run = f.save('autonomous-run.json', { kind }),
    reference = profile === 'h06-reference-temporal/4';
  const approvedProposal = f.save('approved-proposal.json', { approved: 'old bounded proposal' });
  calls.temporalAutonomous.mockReturnValue({
    plan: {
      ...f.plan,
      input: reference
        ? { kind: 'comparison-h06-temporal-reference/4', approvedProposal }
        : { kind: 'comparison-h06-temporal-autonomous/3' },
      ...(reference ? { reference: { approvedGrantText: 'old-approved-grant' } } : {}),
      serverSetupHash: 'setup-hash',
    },
    worker: f.temporal.worker,
  });
  const input = { kind: 'comparison-h06-package/1', profile, run };
  const manifest = planH06Package(input);
  expect(checkH06Package(manifest)).toEqual(manifest);
  expect(manifest).toMatchObject({
    source: null,
    claimIssued: false,
    mayRun: false,
    requestHash: 'request-hash',
    serverSetupHash: 'setup-hash',
  });
  if (reference) {
    expect(manifest).not.toHaveProperty('proposedGrants');
    expect(manifest).toHaveProperty('referenceConfirmation', {
      kind: 'h06-temporal-reference-confirmation/4',
      approvedProposal,
      approvedGrantText: 'old-approved-grant',
    });
    expect(() =>
      checkH06Package({ ...manifest, proposedGrants: { attempt: 'new-unapproved-grant' } }),
    ).toThrow('h06-package-manifest-changed');
  } else {
    expect(manifest).not.toHaveProperty('referenceConfirmation');
    expect(manifest).toHaveProperty('proposedGrants', { attempt: 'exact-attempt-grant' });
  }
  expect(manifest.commands.run?.argv.slice(-2)).toEqual(['--run', run.path]);
  expect(calls.temporalAutonomous).toHaveBeenCalledWith({ kind });
  expect(calls.current).not.toHaveBeenCalled();
  expect(calls.temporalAutonomousRun).not.toHaveBeenCalled();
  calls.temporalAutonomousRun.mockResolvedValue('autonomous-completed');
  await expect(h06PackageMain(['--run', run.path])).resolves.toBe('autonomous-completed');
  expect(calls.temporalAutonomousRun).toHaveBeenCalledWith(['--run', run.path]);
  f.request.runtime.length = 0;
  await expect(h06PackageMain(['--run', run.path])).rejects.toThrow('h06-package-runtime');
  expect(calls.temporalAutonomousRun).toHaveBeenCalledTimes(1);
});

it.each(['wrong-kind', 'missing-reference'])(
  'refuses reference metadata from an unverified authority plan: %s',
  async (failure) => {
    const f = await fixture(),
      run = f.save('reference-run.json', { kind: 'comparison-h06-temporal-reference-run/4' });
    calls.temporalAutonomous.mockReturnValue({
      plan: {
        ...f.plan,
        input: {
          kind:
            failure === 'wrong-kind'
              ? 'comparison-h06-temporal-autonomous/3'
              : 'comparison-h06-temporal-reference/4',
          approvedProposal: f.input.attempt,
        },
        ...(failure === 'missing-reference'
          ? {}
          : { reference: { approvedGrantText: 'old-approved-grant' } }),
      },
      worker: f.temporal.worker,
    });
    expect(() =>
      planH06Package({
        kind: 'comparison-h06-package/1',
        profile: 'h06-reference-temporal/4',
        run,
      }),
    ).toThrow('h06-package-reference-authority');
    expect(calls.current).not.toHaveBeenCalled();
    expect(calls.temporalAutonomousRun).not.toHaveBeenCalled();
  },
);

it.each([
  ['h06-autonomous-temporal/3', 'comparison-h06-temporal-reference-run/4'],
  ['h06-reference-temporal/4', 'comparison-h06-temporal-autonomous-run/3'],
  ['h06-reference-temporal/4', 'comparison-h06-native-temporal-run/2'],
  ['h06-reference-temporal/4', 'comparison-h06-temporal-reference-run/3'],
])('rejects profile %s paired with run %s without fallback', async (profile, kind) => {
  const f = await fixture(),
    run = f.save('cross-mode-run.json', { kind });
  expect(() => planH06Package({ kind: 'comparison-h06-package/1', profile, run })).toThrow(
    'h06-package-profile',
  );
  expect(calls.temporalAutonomous).not.toHaveBeenCalled();
  expect(calls.temporal).not.toHaveBeenCalled();
  expect(calls.current).not.toHaveBeenCalled();
  expect(calls.temporalAutonomousRun).not.toHaveBeenCalled();
});

it('preserves strict reference fields and refuses cross-mode authority during package dispatch', async () => {
  const f = await fixture(),
    packet = { kind: 'comparison-h06-temporal-reference-run/4' },
    run = f.save('reference-run.json', packet),
    input = { kind: 'comparison-h06-package/1', profile: 'h06-reference-temporal/4', run };
  expect(() => planH06Package({ ...input, approvedProposal: f.input.attempt })).toThrow();
  calls.temporalAutonomous.mockImplementation(() => {
    throw new Error('h06-temporal-autonomous-run-authority-kind');
  });
  expect(() => planH06Package(input)).toThrow('h06-temporal-autonomous-run-authority-kind');
  await expect(h06PackageMain(['--run', run.path])).rejects.toThrow(
    'h06-temporal-autonomous-run-authority-kind',
  );
  expect(calls.temporal).not.toHaveBeenCalled();
  expect(calls.temporalAutonomousRun).not.toHaveBeenCalled();
  expect(calls.current).not.toHaveBeenCalled();
});

it('rejects unsupported profiles, fields, paths, aliases and missing runtime/config pins', async () => {
  const f = await fixture();
  for (const change of [{ kind: 'other' }, { profile: 'h06-manual-recovery/2' }, { source: null }])
    expect(() => planH06Package({ ...f.input, ...change })).toThrow();
  for (const path of ['relative.json', join(f.root, '..', 'foreign', 'packet.json')])
    expect(() =>
      planH06Package({ ...f.input, packets: { ...f.input.packets, start: path } }),
    ).toThrow();
  expect(() =>
    planH06Package({ ...f.input, packets: { ...f.input.packets, start: f.input.packets.load } }),
  ).toThrow('h06-package-packet-paths');
  const runtime = [...f.request.runtime];
  for (const removed of [runtime[0]!, runtime[1]!, f.input.config, f.config.preparation]) {
    f.request.runtime = runtime.filter((pin) => pin.path !== removed.path);
    expect(() => planH06Package(f.input)).toThrow();
  }
  f.request.runtime = runtime;
  for (const args of [
    [],
    ['--prepare'],
    ['--prepare', f.run.path, 'extra'],
    ['wrong', f.run.path],
    ['--prepare', 'relative'],
  ])
    await expect(h06PackageMain(args)).rejects.toThrow();
});

it('checks preparation identity and each writer binding before an authority is available', async () => {
  const f = await fixture();
  const original = structuredClone(f.preparation);
  const restore = () => {
    Object.assign(f.preparation, structuredClone(original));
    f.refresh();
  };
  const cases: Array<() => void> = [
    () => {
      f.preparation.kind = 'other';
    },
    () => {
      f.preparation.spec.project_id = 'foreign';
    },
    () => {
      f.preparation.spec.identity = { assignment_id: 'foreign' };
    },
    () => {
      f.preparation.spec.identity = {
        task_id: 'foreign',
        card:
          'task_id' in original.spec.identity
            ? original.spec.identity.card
            : original.spec.assignment,
      };
    },
    () => {
      f.preparation.spec.route = { kind: 'nonproduct' };
    },
    () => {
      f.preparation.planningFile = 'other.json';
    },
    () => {
      f.preparation.spec.route = { kind: 'substantial', accepted_plan: null };
    },
    () => {
      f.preparation.spec.requested.model = '';
    },
  ];
  for (const change of cases) {
    change();
    f.refresh();
    expect(() => planH06Package(f.input)).toThrow();
    restore();
  }
  f.briefs.warm.parent_session_id = 'foreign';
  f.refresh();
  expect(() => planH06Package(f.input)).toThrow('h06-package-writer-binding');
  f.briefs.warm.parent_session_id = original.spec.session_id;
  f.briefs.warm.copy_root = join(f.root, 'other-copy');
  f.refresh();
  expect(() => planH06Package(f.input)).toThrow('h06-package-writer-binding');
  f.briefs.warm.copy_root = f.briefs.cold.copy_root;
  f.briefs.warm.id = f.briefs.cold.id;
  f.refresh();
  expect(() => planH06Package(f.input)).toThrow('h06-package-writer-ids');
  expect(calls.start).not.toHaveBeenCalled();
});

it('routes exact Legacy packets to the existing one-shot APIs and keeps warm argv compatible', async () => {
  const f = await fixture(),
    authority = { fixture: 'observed human source' };
  const start = f.save('start.json', {
    authority,
    config: f.input.config,
    package: f.save('manifest.json', planH06Package(f.input)),
  });
  calls.start.mockResolvedValue('started');
  await expect(h06PackageMain(['start', start.path])).resolves.toBe('started');
  expect(calls.start).toHaveBeenCalledWith(authority, f.input.config);
  const ticket = {
    claim: f.save('claim.json', {}),
    phase: f.save('phase.json', {}),
    delivery: f.save('delivery.json', {}),
  };
  const response = f.save('response.json', ticket),
    initialFailure = f.save('failure.json', {});
  const packet = f.save('actor.json', { ...ticket, config: f.input.config, initialFailure });
  calls.publish.mockReturnValue(response);
  calls.warm.mockResolvedValue('warm-result');
  calls.cold.mockResolvedValue('cold-result');
  await expect(h06PackageMain(['warm', packet.path])).resolves.toBe('warm-result');
  expect(calls.warm).toHaveBeenCalledWith(ticket, f.input.config, initialFailure);
  await expect(h06PackageMain(['cold', packet.path])).resolves.toBe('cold-result');
  expect(calls.cold).toHaveBeenCalledWith(ticket, f.input.config);
  await expect(h06PackageMain(['deliver', packet.path])).resolves.toEqual(response);
  expect(calls.publish).toHaveBeenCalledWith(packet);
  f.plan.input.attempt = { ...f.plan.input.attempt, path: join(f.root, 'other', 'attempt.json') };
  await expect(h06PackageMain(['start', start.path])).rejects.toThrow('h06-package-start-binding');
  await expect(h06PackageMain(['deliver', packet.path])).rejects.toThrow('h06-package-packet-root');
});

it('reports the direct CLI result and failure without swallowing rejection', async () => {
  const f = await fixture(),
    argv = process.argv,
    exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    process.argv = ['node', h06PackageEntry, '--prepare', f.save('cli-spec.json', f.input).path];
    vi.resetModules();
    await import('./comparisonH06Package.js');
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith(canonical(planH06Package(f.input)) + '\n'),
    );
    process.argv = ['node', h06PackageEntry, 'unsupported', f.run.path];
    vi.resetModules();
    await import('./comparisonH06Package.js');
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Error: h06-package-action\n'));
    expect(process.exitCode).toBe(1);
    process.argv = [];
    vi.resetModules();
    await import('./comparisonH06Package.js');
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});

async function operatorFixture() {
  const f = await fixture(),
    manifest = f.save('manifest.json', planH06Package(f.input));
  const bound = await bindH06Package(manifest);
  mkdirSync(f.request.evidenceRoot);
  const claim = f.save('claim.json', {}),
    failure = f.save('failure.json', {});
  f.save('task/delegated-actor-ready.json', { config: f.input.config, initialFailure: failure });
  const phases: Array<{ phase: H06DelegatedPhase; intent: H04Pin; outcome: H04Pin | null }> = [];
  calls.inspect.mockImplementation(() => ({ phases }));
  calls.admit.mockImplementation((phase: H06DelegatedPhase) => {
    const intent = f.save('intent-' + phases.length + '.json', phase);
    phases.push({ phase, intent, outcome: null });
    return intent;
  });
  calls.execute.mockReturnValue({ generation: 1, revision: 2, checkpoint: null });
  calls.settle.mockImplementation((outcome: H04Pin) => {
    phases.at(-1)!.outcome = outcome;
    return outcome;
  });
  return { ...f, manifest, bound, claim, phases };
}

it('binds the current discovered primary source and refuses missing authority or duplicate output', async () => {
  const f = await fixture(),
    manifest = f.save('manifest.json', planH06Package(f.input));
  calls.current.mockRejectedValueOnce(new Error('wrong root/native source'));
  await expect(bindH06Package(manifest)).rejects.toThrow('wrong root/native source');
  expect(existsSync(f.input.packets.start!)).toBe(false);
  calls.authority.mockImplementationOnce(() => {
    throw new Error('exact grant refused');
  });
  await expect(bindH06Package(manifest)).rejects.toThrow('exact grant refused');
  expect(existsSync(f.input.packets.start!)).toBe(false);
  calls.authority.mockReturnValue(f.plan);
  const bound = await h06PackageMain(['--bind', manifest.path]);
  expect(bound).toMatchObject({
    source: f.nativeSource,
    claimIssued: false,
    mayRun: false,
  });
  const packet = JSON.parse(readFileSync(f.input.packets.start!, 'utf8')) as Record<
    string,
    unknown
  >;
  expect(packet).toMatchObject({
    package: manifest,
    config: f.input.config,
    authority: { attempt: f.input.attempt, source: f.nativeSource },
  });
  expect(calls.current).toHaveBeenCalledWith(f.request.chat, true);
  await expect(h06PackageMain(['--bind', manifest.path])).rejects.toThrow();
  const temporal = f.save(
    'temporal-manifest.json',
    planH06Package({
      kind: 'comparison-h06-package/1',
      profile: 'h06-native-temporal/2',
      run: f.run,
    }),
  );
  await expect(bindH06Package(temporal)).rejects.toThrow('h06-package-bind-profile');
  expect(calls.start).not.toHaveBeenCalled();
});

it('admits six immutable phases, prepares full LOAD and connector arguments, then settles real files', async () => {
  const f = await operatorFixture();
  for (const stage of [
    'load',
    'warm-pause',
    'warm-resume',
    'cold-pause',
    'cold-resume',
    'completion',
  ] as const) {
    const admission = (await h06PackageMain(['--admit', f.claim.path, stage])) as ReturnType<
      typeof admitH06Package
    >;
    expect(admission.phase).toEqual(f.phases.at(-1)!.intent);
    if (admission.message) {
      expect(admission.message.threadId).toBe(f.plan.actorId);
      expect(admission.message.prompt).toContain('Делегированная команда H06/3');
      expect(admission.message.prompt).toContain('text(await tools.exec_command({...}));');
      if (stage === 'load' || stage.endsWith('resume'))
        expect(admission.message.prompt).toContain('read-chat');
      const packet = JSON.parse(readFileSync(admission.packet!.path, 'utf8')) as {
        deliveryInput: { command: { target: { stage: string } } };
      };
      expect(packet.deliveryInput.command.target.stage).toBe(stage);
      if (stage === 'load') expect(admission.message.prompt).toContain('yield_time_ms=1000');
    } else expect(stage).toBe('completion');
    f.save(`task/delegated-${stage === 'load' ? 'load' : stage}-result.json`, { stage });
    if (stage !== 'completion') f.save(`task/delegated-${stage}-delivery.json`, { stage });
    const result = await h06PackageMain(['--settle', f.claim.path, stage]);
    expect(result).toEqual(f.phases.at(-1)!.outcome);
    expect(calls.settle).toHaveBeenCalledWith(result);
    calls.execute.mockReturnValue({
      generation: 1,
      revision: 4,
      checkpoint: { chat_control: { revision: 3 }, chat_messages: { requirements_revision: 2 } },
    });
  }
  expect(calls.admit).toHaveBeenCalledTimes(6);
  expect(calls.admit.mock.calls.at(-1)![0]).toMatchObject({
    controlRevision: 3,
    requirementsRevision: 2,
    predecessor: f.phases.at(-2)!.outcome,
  });
  await expect(h06PackageMain(['--settle', f.claim.path, 'completion'])).rejects.toThrow(
    'h06-package-pending-phase',
  );
  expect(calls.publish).not.toHaveBeenCalled();
  expect(calls.start).not.toHaveBeenCalled();
});

it('blocks phase assembly before admission on package, reader or ready-config mismatch', async () => {
  const f = await operatorFixture();
  expect(() => settleH06Package(f.claim, 'load')).toThrow('h06-package-pending-phase');
  const originalConfig = f.input.config;
  f.save('task/delegated-actor-ready.json', { config: f.input.attempt, initialFailure: f.claim });
  expect(() => admitH06Package(f.claim, 'load')).toThrow('h06-package-ready-config');
  f.save('task/delegated-actor-ready.json', { config: originalConfig, initialFailure: f.claim });
  f.request.runtime = f.request.runtime.filter((pin) => !pin.path.endsWith('/cli/main.ts'));
  expect(() => admitH06Package(f.claim, 'load')).toThrow('h06-package-reader-pin');
  expect(calls.admit).not.toHaveBeenCalled();
  f.plan.input.attempt = { ...f.input.attempt, sha256: '0'.repeat(64) };
  expect(() => admitH06Package(f.claim, 'load')).toThrow('h06-package-claim-binding');
  for (const args of [
    ['--admit'],
    ['--settle', f.claim.path],
    ['--admit', f.claim.path, 'other'],
    ['--settle', f.claim.path, 'load', 'extra'],
  ])
    await expect(h06PackageMain(args)).rejects.toThrow('h06-package-phase-arguments');
});

async function deliveryFixture() {
  const f = await fixture(),
    claim = f.save('claim.json', {});
  const packet = f.save('delivery-packet.json', {
    claim,
    deliveryInput: { fixture: 'native snapshots' },
  });
  const response = f.save('delivery-response.json', {});
  calls.publish.mockReturnValue(response);
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  calls.wait.mockImplementation((ms: number) => {
    now += ms;
    return Promise.resolve();
  });
  return {
    ...f,
    packet,
    response,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it('waits only for asynchronous native delivery snapshots and publishes once', async () => {
  const f = await deliveryFixture();
  f.plan.workDeadlineMs = 2000;
  calls.delivery.mockImplementationOnce(() => {
    throw new Error('h06-delegated-delivery-partial');
  });
  calls.delivery.mockImplementationOnce(() => {
    throw new Error('h06-delegated-delivery-outbound');
  });
  await expect(h06PackageMain(['deliver', f.packet.path])).resolves.toEqual(f.response);
  expect(f.now()).toBe(1200);
  expect(calls.delivery).toHaveBeenCalledTimes(3);
  expect(calls.publish).toHaveBeenCalledTimes(1);
  expect(calls.start).not.toHaveBeenCalled();
});

it('bounds read-only delivery waiting by both the original work deadline and fifteen seconds', async () => {
  const f = await deliveryFixture();
  f.plan.workDeadlineMs = 1150;
  calls.delivery.mockImplementation(() => {
    throw new Error('h06-delegated-delivery-inbound');
  });
  await expect(h06PackageMain(['deliver', f.packet.path])).rejects.toThrow(
    'h06-package-delivery-timeout',
  );
  expect(f.now()).toBe(1150);
  expect(calls.wait.mock.calls.map(([ms]) => ms)).toEqual([100, 50]);
  f.plan.workDeadlineMs = 100000;
  await expect(h06PackageMain(['deliver', f.packet.path])).rejects.toThrow(
    'h06-package-delivery-timeout',
  );
  expect(f.now()).toBe(16150);
  expect(calls.publish).not.toHaveBeenCalled();
});

it('fails immediately on malformed delivery and never retries publication or a late successful snapshot', async () => {
  const f = await deliveryFixture();
  f.plan.workDeadlineMs = 2000;
  calls.delivery.mockImplementationOnce(() => {
    throw new Error('h06-delegated-delivery-kind');
  });
  await expect(h06PackageMain(['deliver', f.packet.path])).rejects.toThrow(
    'h06-delegated-delivery-kind',
  );
  calls.delivery.mockImplementationOnce(() => {
    throw 'invalid native snapshot';
  });
  await expect(h06PackageMain(['deliver', f.packet.path])).rejects.toThrow(
    'h06-package-delivery-error',
  );
  expect(calls.wait).not.toHaveBeenCalled();
  calls.publish.mockImplementationOnce(() => {
    throw new Error('publication unknown');
  });
  await expect(h06PackageMain(['deliver', f.packet.path])).rejects.toThrow('publication unknown');
  expect(calls.publish).toHaveBeenCalledTimes(1);
  calls.delivery.mockImplementationOnce(() => {
    f.advance(1000);
  });
  await expect(h06PackageMain(['deliver', f.packet.path])).rejects.toThrow(
    'h06-package-delivery-timeout',
  );
  expect(calls.publish).toHaveBeenCalledTimes(1);
  await expect(h06PackageMain(['deliver', f.packet.path])).rejects.toThrow(
    'h06-package-delivery-timeout',
  );
});
