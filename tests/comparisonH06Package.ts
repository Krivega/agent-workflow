import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { evidenceSchema, type EvidenceGrant, type TechnicalState } from '../core/evidence.js';
import { validateCoderBrief, type CoderBrief } from '../core/coder.js';
import { localLocator } from '../core/connection.js';
import { startLocalRun, type RunSpec } from '../core/localRun.js';
import { exactFields, object, requireContract, text } from '../src/contracts/project.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { h06PlanningDirectory } from './comparisonH06Planning.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  planH06AutonomousGrant,
  planH06DelegatedAuthority,
  readH06DelegatedAuthority,
  openH06DelegatedPhaseLedger,
  h06DelegatedStages,
  h06DelegatedPhaseAction,
  type H06DelegatedStage,
} from './comparisonH06DelegatedAuthority.js';
import { currentH06HumanAuthority } from './comparisonH06NativeAuthority.js';
import { planH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import {
  publishH06DelegatedCommand,
  runH06DelegatedCold,
  runH06DelegatedWarm,
  startH06DelegatedRun,
} from './comparisonH06DelegatedRun.js';
import {
  h06NativeTemporalRunMain,
  planH06NativeTemporalRun,
} from './comparisonH06NativeTemporalRun.js';
import {
  h06TemporalAutonomousRunMain,
  planH06TemporalAutonomousRun,
} from './comparisonH06TemporalAutonomousRun.js';

export const h06PackageEntry = fileURLToPath(import.meta.url);
const tsxPath = fileURLToPath(import.meta.resolve('tsx'));
const stages = ['start', 'warm', 'cold', 'deliver'] as const;
const packetActions = {
  start: 'start',
  load: 'warm',
  warmPause: 'deliver',
  warmResume: 'deliver',
  coldPause: 'deliver',
  coldResume: 'cold',
} as const;
const pinFile = (path: string): H04Pin => ({ path, sha256: digest(h01RawFile(path)) });
const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
const absolute = (value: unknown) => h04Pin({ path: value, sha256: '0'.repeat(64) }).path;
function readerPin(request: { runtime: H04Pin[] }) {
  const pin = pinFile(fileURLToPath(new URL('../cli/main.ts', import.meta.url)));
  requireContract(
    request.runtime.some((bound) => same(bound, pin)),
    'h06-package-reader-pin',
  );
  return pin;
}

function runtime(request: { binding: { node: H04Pin }; runtime: H04Pin[] }) {
  const pins = {
    node: request.binding.node,
    tsx: pinFile(tsxPath),
    entry: pinFile(h06PackageEntry),
  };
  requireContract(
    [pins.tsx, pins.entry].every((pin) => request.runtime.some((bound) => same(pin, bound))),
    'h06-package-runtime',
  );
  for (const pin of Object.values(pins)) readH04Pin(pin);
  return pins;
}

function command(pins: ReturnType<typeof runtime>, stage: string, path: string) {
  const argv = [pins.node.path, '--import', pins.tsx.path, pins.entry.path, stage, path];
  return { argv, shell: argv.map((part) => "'" + part.replaceAll("'", "'\\''") + "'").join(' ') };
}

function save(path: string, value: unknown) {
  publishFile(path, Buffer.from(canonical(value) + '\n'));
  return pinFile(path);
}

function legacyComposition(
  request: ReturnType<typeof planH06AutonomousGrant>['request'],
  configPin: H04Pin,
) {
  const config = read(configPin);
  exactFields(config, ['preparation', 'warm', 'cold', 'final']);
  const pins = Object.fromEntries(Object.entries(config).map(([key, pin]) => [key, h04Pin(pin)]));
  for (const pin of [configPin, ...Object.values(pins)]) {
    readH04Pin(pin);
    requireContract(
      request.runtime.some((bound) => same(pin, bound)),
      'h06-package-config-pin',
    );
  }
  const bootstrap = read(request.bootstrap),
    preparation = read(pins.preparation!),
    spec = object(preparation.spec) as unknown as RunSpec;
  localLocator(preparation.descriptor);
  const planningFile = localLocator(preparation.planningFile);
  text(preparation.marker);
  startLocalRun(spec, Number(bootstrap.generation));
  requireContract(
    preparation.kind === 'comparison-h06-native-legacy-preparation/2' &&
      same(
        [
          spec.project_id,
          spec.run_id,
          spec.session_id,
          spec.workspace,
          spec.host_id,
          spec.parent_run_id,
        ],
        [
          bootstrap.projectId,
          bootstrap.runId,
          bootstrap.actorId,
          request.binding.workspaceRoot,
          'local',
          null,
        ],
      ) &&
      'task_id' in spec.identity &&
      spec.identity.task_id === request.binding.operationId &&
      (spec.route.kind === 'local' || spec.route.kind === 'substantial') &&
      spec.route.accepted_plan?.locator === planningFile,
    'h06-package-preparation-binding',
  );
  h06PlanningDirectory(
    spec.workspace,
    request.evidenceRoot,
    spec.route.accepted_plan,
    request.runtime,
  );
  const writers = ['warm', 'cold', 'final'].map((stage) => {
    const brief = read(pins[stage]!) as unknown as CoderBrief;
    validateCoderBrief(brief);
    requireContract(
      same(
        [
          brief.project_id,
          brief.task_id,
          brief.parent_run_id,
          brief.parent_session_id,
          brief.source_root,
          brief.generation,
        ],
        [
          bootstrap.projectId,
          request.binding.operationId,
          bootstrap.runId,
          bootstrap.actorId,
          request.binding.workspaceRoot,
          bootstrap.generation,
        ],
      ) &&
        brief.copy_root === join(request.evidenceRoot, 'coder-workspaces', brief.id) &&
        same(brief.profile, { model: spec.requested.model, effort: spec.requested.effort }),
      'h06-package-writer-binding',
    );
    return { stage, id: brief.id, profile: brief.profile };
  });
  requireContract(new Set(writers.map(({ id }) => id)).size === 3, 'h06-package-writer-ids');
  return { config: configPin, pins, reader: readerPin(request), actor: spec.requested, writers };
}

/** Compose exact existing APIs without opening a Store, observing authority or starting services. */
export function planH06Package(value: unknown) {
  const spec = object(value);
  requireContract(spec.kind === 'comparison-h06-package/1', 'h06-package-kind');
  const common = {
    kind: 'comparison-h06-package-manifest/1',
    spec,
    source: null,
    claimIssued: false,
    mayRun: false,
    qualification: false,
  } as const;
  if (spec.profile === 'h06-autonomous-temporal/3' || spec.profile === 'h06-reference-temporal/4') {
    exactFields(spec, ['kind', 'profile', 'run']);
    const run = h04Pin(spec.run),
      input = read(run);
    requireContract(
      input.kind ===
        (spec.profile === 'h06-autonomous-temporal/3'
          ? 'comparison-h06-temporal-autonomous-run/3'
          : 'comparison-h06-temporal-reference-run/4'),
      'h06-package-profile',
    );
    const { plan, worker } = planH06TemporalAutonomousRun(input);
    const pins = runtime(plan.request);
    const manifest = {
      ...common,
      run,
      requestHash: plan.requestHash,
      serverSetupHash: plan.serverSetupHash,
      runtime: pins,
      worker,
      commands: { run: command(pins, '--run', run.path) },
    };
    if (spec.profile === 'h06-reference-temporal/4') {
      requireContract(
        plan.input.kind === 'comparison-h06-temporal-reference/4' && plan.reference !== undefined,
        'h06-package-reference-authority',
      );
      return {
        ...manifest,
        referenceConfirmation: {
          kind: 'h06-temporal-reference-confirmation/4',
          approvedProposal: plan.input.approvedProposal,
          approvedGrantText: plan.reference.approvedGrantText,
        },
      };
    }
    return { ...manifest, proposedGrants: { attempt: plan.expectedGrantText } };
  }
  if (spec.profile === 'h06-autonomous-recovery/3') {
    exactFields(spec, ['kind', 'profile', 'attempt', 'config', 'packets']);
    const attempt = h04Pin(spec.attempt),
      plan = planH06AutonomousGrant(attempt);
    const pins = runtime(plan.request),
      composition = legacyComposition(plan.request, h04Pin(spec.config));
    const packets = object(spec.packets);
    exactFields(packets, Object.keys(packetActions));
    const commands = Object.fromEntries(
      Object.entries(packetActions).map(([stage, action]) => {
        const path = absolute(packets[stage]);
        requireContract(dirname(path) === dirname(attempt.path), 'h06-package-packet-root');
        return [stage, command(pins, action, path)];
      }),
    );
    requireContract(
      new Set(Object.values(packets)).size === Object.keys(packetActions).length &&
        Object.values(packets).every((path) =>
          [attempt, ...plan.request.runtime].every((pin) => pin.path !== path),
        ),
      'h06-package-packet-paths',
    );
    return {
      ...common,
      attempt,
      requestHash: plan.requestHash,
      runtime: pins,
      composition,
      commands,
      proposedGrants: { attempt: plan.expectedGrantText },
    };
  }
  requireContract(spec.profile === 'h06-native-temporal/2', 'h06-package-profile');
  exactFields(spec, ['kind', 'profile', 'run']);
  const run = h04Pin(spec.run),
    { plan, worker } = planH06NativeTemporalRun(read(run));
  const pins = runtime(plan.attempt.request);
  return {
    ...common,
    run,
    requestHash: plan.attempt.requestHash,
    runtime: pins,
    worker,
    commands: { run: command(pins, '--run', run.path) },
    proposedGrants: { server: plan.expectedGrantText, attempt: plan.attempt.expectedGrantText },
  };
}

/** Reject stale or edited manifests by rebuilding every pin, command and grant read-only. */
export function checkH06Package(value: unknown) {
  const manifest = object(value),
    expected = planH06Package(manifest.spec);
  requireContract(same(manifest, expected), 'h06-package-manifest-changed');
  return expected;
}

/** Bind only the current primary human input; a package proposal is never itself authority. */
export async function bindH06Package(manifestPin: H04Pin) {
  const manifest = checkH06Package(read(manifestPin)),
    spec = manifest.spec;
  requireContract(spec.profile === 'h06-autonomous-recovery/3', 'h06-package-bind-profile');
  const attempt = h04Pin(spec.attempt),
    plan = planH06AutonomousGrant(attempt);
  const source = await currentH06HumanAuthority(plan.request.chat, true);
  const authority = {
    kind: 'comparison-h06-delegated-legacy/1',
    attempt,
    budgetSource: { attempt, source },
    source,
    normalization: {
      kind: 'root-operator-normalization/1',
      decision: 'autonomous-legacy-warm-cold-completion',
    },
  };
  planH06DelegatedAuthority(authority);
  const start = save(absolute(object(spec.packets).start), {
    authority,
    config: h04Pin(spec.config),
    package: manifestPin,
  });
  const binding = save(join(dirname(attempt.path), 'package-binding.json'), { start });
  return { start, binding, source, claimIssued: false, mayRun: false } as const;
}

function legacyPackage(claimPin: H04Pin) {
  const claim = readH06DelegatedAuthority(claimPin),
    root = dirname(claim.input.attempt.path);
  const binding = read(pinFile(join(root, 'package-binding.json'))),
    start = read(h04Pin(binding.start));
  const manifest = read(h04Pin(start.package)),
    spec = object(manifest.spec);
  requireContract(
    same(spec.attempt, claim.input.attempt) && same(spec.config, start.config),
    'h06-package-claim-binding',
  );
  for (const path of Object.values(object(spec.packets)))
    requireContract(dirname(absolute(path)) === root, 'h06-package-packet-root');
  return { claim, root, spec, config: h04Pin(spec.config), packets: object(spec.packets) };
}

/** Admit one existing ledger phase and prepare connector arguments; never send the message. */
export function admitH06Package(claimPin: H04Pin, stage: H06DelegatedStage) {
  const { claim, root, spec, config, packets } = legacyPackage(claimPin);
  const bootstrap = read(claim.request.bootstrap);
  const grant: EvidenceGrant = {
    context: {
      schema_version: evidenceSchema,
      project_id: text(bootstrap.projectId),
      task_id: claim.request.binding.operationId,
      subtask_id: null,
      run_id: text(bootstrap.runId),
      actor_id: claim.actorId,
    },
    permissions: bootstrap.permissions as EvidenceGrant['permissions'],
  };
  const store = new SqliteEvidenceStore(
    join(claim.request.evidenceRoot, 'legacy-store'),
    grant,
    Date.now,
  );
  const state = unwrap<TechnicalState>(
    store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
  );
  const checkpoint = state.checkpoint === null ? {} : object(state.checkpoint);
  const ledger = openH06DelegatedPhaseLedger(claimPin),
    phases = ledger.inspect().phases;
  const pins = runtime(claim.request),
    preparation = read(h04Pin(read(config).preparation)),
    actor = object(preparation.spec) as unknown as RunSpec,
    ready = read(pinFile(join(claim.request.evidenceRoot, 'delegated-actor-ready.json'))),
    cli = readerPin(claim.request).path;
  requireContract(same(ready.config, spec.config), 'h06-package-ready-config');
  const initialFailure = h04Pin(ready.initialFailure);
  const phase = ledger.admitPhase({
    stage,
    nonce: randomUUID(),
    rootThread: claim.request.chat.threadId,
    actorThread: claim.actorId,
    requestHash: claim.requestHash,
    generation: state.generation,
    storeRevision: state.revision,
    controlRevision:
      checkpoint.chat_control === undefined ? 0 : object(checkpoint.chat_control).revision,
    requirementsRevision:
      checkpoint.chat_messages === undefined
        ? 0
        : object(checkpoint.chat_messages).requirements_revision,
    predecessor: phases.at(-1)?.outcome ?? null,
  });
  if (stage === 'completion')
    return {
      phase,
      admission: save(join(claim.request.evidenceRoot, 'delegated-completion-admission.json'), {
        claim: claimPin,
        phase,
      }),
      message: null,
    };
  const admitted = ledger.inspect().phases.at(-1)!;
  const commandValue = {
    kind: 'comparison-h06-delegated-command/1',
    nonce: admitted.phase.nonce,
    requestHash: claim.requestHash,
    action: h06DelegatedPhaseAction(stage),
    target: {
      claim: claimPin,
      intent: phase,
      stage,
      generation: admitted.phase.generation,
      storeRevision: admitted.phase.storeRevision,
      controlRevision: admitted.phase.controlRevision,
      requirementsRevision: admitted.phase.requirementsRevision,
    },
  };
  const key = {
    load: 'load',
    'warm-pause': 'warmPause',
    'warm-resume': 'warmResume',
    'cold-pause': 'coldPause',
    'cold-resume': 'coldResume',
  }[stage];
  const path = absolute(packets[key]),
    action = packetActions[key as keyof typeof packetActions];
  const launch = command(pins, action, path),
    reads: string[] = [];
  if (stage === 'load' || stage.endsWith('resume')) {
    const locators = [...new Set([...actor.rules, ...actor.procedures].map((ref) => ref.locator))];
    for (let i = 0; i < locators.length; i += 3) {
      const input = save(join(root, `package-${stage}-read-${i / 3 + 1}.json`), {
        schema_version: 1,
        root: claim.request.binding.workspaceRoot,
        descriptor: preparation.descriptor,
        marker: stage === 'load' ? preparation.marker : `delegated-${admitted.phase.nonce}`,
        locators: locators.slice(i, i + 3),
      });
      const argv = [
        pins.node.path,
        '--import',
        pins.tsx.path,
        cli,
        'read-chat',
        input.path,
        '--full',
      ];
      reads.push(argv.map((part) => "'" + part.replaceAll("'", "'\\''") + "'").join(' '));
    }
  }
  const seriesCommand =
    'Для попытки общей серии выполни каждую приведённую строку через один вызов text(await tools.exec_command({...})); с аргументами в JSON. Передай неизменную строку в cmd, текущий каталог задачи в workdir, shell: "/bin/sh" и login: false. Для чтения вывода терминала допускается text(await tools.write_stdin({...})); с пустым chars.\n';
  const prompt = `Делегированная команда H06/3 по отдельному первичному разрешению. Выполни только полный LOAD и указанную команду в текущем чате. Каждый LOAD выполни отдельным вызовом инструмента с лимитом вывода не менее 18000 токенов, без перенаправления и пересказа.\n${seriesCommand}${reads.join('\n')}\n${launch.shell}\n${action === 'warm' ? 'Запусти в PTY с yield_time_ms=1000; сохрани session_id и сразу заверши ход, оставив процесс работающим.\n' : ''}При ошибке или неизвестном исходе сохрани ошибку и не повторяй действие.\n${canonical(commandValue)}`;
  const deliveryInput = {
    kind: 'comparison-h06-delegated-delivery/1',
    sessionsRoot: claim.grant.sessionsRoot,
    root: {
      threadId: claim.request.chat.threadId,
      workspace: claim.request.chat.workspace,
      turnId: claim.source.turnId,
      user: claim.source.source,
    },
    actor: { threadId: claim.actorId, workspace: claim.request.binding.workspaceRoot },
    command: commandValue,
    prompt,
  };
  const packet = save(path, {
    claim: claimPin,
    phase,
    deliveryInput,
    config,
    initialFailure,
  });
  return { phase, packet, message: { threadId: claim.actorId, prompt } };
}

/** Settle only a real existing result through the ledger's original binding checks. */
export function settleH06Package(claimPin: H04Pin, stage: H06DelegatedStage) {
  const { claim } = legacyPackage(claimPin),
    ledger = openH06DelegatedPhaseLedger(claimPin),
    pending = ledger.inspect().phases.at(-1);
  requireContract(
    pending?.phase.stage === stage && pending.outcome === null,
    'h06-package-pending-phase',
  );
  const root = claim.request.evidenceRoot;
  const result = pinFile(
    join(
      root,
      stage === 'load'
        ? 'delegated-load-result.json'
        : stage === 'completion'
          ? 'delegated-completion-result.json'
          : `delegated-${stage}-result.json`,
    ),
  );
  const delivery = pinFile(
    join(root, `delegated-${stage === 'completion' ? 'cold-resume' : stage}-delivery.json`),
  );
  const outcome = save(join(root, `delegated-${stage}-outcome.json`), {
    kind: 'h06-delegated-phase-outcome/1',
    claim: claimPin,
    intent: pending.intent,
    stage,
    status: 'confirmed',
    delivery,
    result,
  });
  return ledger.settlePhase(outcome);
}

export async function h06PackageMain(args: readonly string[]) {
  if (args[0] === '--admit' || args[0] === '--settle') {
    const [action, claimPath, stage] = args;
    requireContract(
      args.length === 3 &&
        claimPath !== undefined &&
        h06DelegatedStages.some((value) => value === stage),
      'h06-package-phase-arguments',
    );
    const claim = pinFile(absolute(claimPath));
    return action === '--admit'
      ? admitH06Package(claim, stage as H06DelegatedStage)
      : settleH06Package(claim, stage as H06DelegatedStage);
  }
  const [action, inputPath] = args;
  requireContract(args.length === 2 && inputPath !== undefined, 'h06-package-arguments');
  const path = absolute(inputPath),
    packet = object(JSON.parse(h01RawFile(path).toString()));
  if (action === '--prepare') return planH06Package(packet);
  if (action === '--check') return checkH06Package(packet);
  if (action === '--bind') return bindH06Package(pinFile(path));
  if (action === '--run') {
    if (
      packet.kind === 'comparison-h06-temporal-autonomous-run/3' ||
      packet.kind === 'comparison-h06-temporal-reference-run/4'
    ) {
      runtime(planH06TemporalAutonomousRun(packet).plan.request);
      return h06TemporalAutonomousRunMain(['--run', path]);
    }
    runtime(planH06NativeTemporalRun(packet).plan.attempt.request);
    return h06NativeTemporalRunMain(['--run', path]);
  }
  requireContract(
    stages.some((stage) => stage === action),
    'h06-package-action',
  );
  if (action === 'start') {
    exactFields(packet, ['authority', 'config', 'package']);
    const manifest = checkH06Package(read(h04Pin(packet.package)));
    const plan = planH06DelegatedAuthority(packet.authority);
    runtime(plan.request);
    requireContract(
      same(manifest.spec.attempt, plan.input.attempt) &&
        same(manifest.spec.config, packet.config) &&
        object(manifest.spec.packets).start === path,
      'h06-package-start-binding',
    );
    requireContract(dirname(path) === dirname(plan.input.attempt.path), 'h06-package-packet-root');
    return startH06DelegatedRun(packet.authority, h04Pin(packet.config));
  }
  const claim = readH06DelegatedAuthority(h04Pin(packet.claim));
  runtime(claim.request);
  requireContract(dirname(path) === dirname(claim.input.attempt.path), 'h06-package-packet-root');
  const deadline = Math.min(Date.now() + 15000, claim.workDeadlineMs);
  for (;;) {
    requireContract(Date.now() < deadline, 'h06-package-delivery-timeout');
    try {
      planH06DelegatedDelivery(packet.deliveryInput);
      break;
    } catch (error) {
      requireContract(error instanceof Error, 'h06-package-delivery-error');
      if (
        !['outbound', 'inbound', 'confirmation', 'partial', 'context'].some(
          (code) => error.message === 'h06-delegated-delivery-' + code,
        )
      )
        throw error;
      await wait(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }
  requireContract(Date.now() < deadline, 'h06-package-delivery-timeout');
  const response = publishH06DelegatedCommand(pinFile(path));
  if (action === 'deliver') return response;
  const value = read(response),
    ticket = {
      claim: h04Pin(value.claim),
      phase: h04Pin(value.phase),
      delivery: h04Pin(value.delivery),
    };
  if (action === 'warm')
    return runH06DelegatedWarm(ticket, h04Pin(packet.config), h04Pin(packet.initialFailure));
  return runH06DelegatedCold(ticket, h04Pin(packet.config));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void h06PackageMain(process.argv.slice(2)).then(
    (result) => process.stdout.write(canonical(result) + '\n'),
    (error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    },
  );
