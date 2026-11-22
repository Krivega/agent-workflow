import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { withChatWriter } from '../adapters/storage/chatWriter.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest, requestHash } from '../adapters/storage/storeCodec.js';
import { evidenceSchema, type EvidenceGrant, type TechnicalState } from '../core/evidence.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { exactFields, object, requireContract, text } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h01RawFile } from './comparisonH01Contract.js';
import {
  consumeH06DelegatedAuthority,
  planH06DelegatedAuthority,
  openH06DelegatedPhaseLedger,
  readH06DelegatedAuthority,
  type H06DelegatedStage,
} from './comparisonH06DelegatedAuthority.js';
import { planH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import {
  applyH06DelegatedLegacyControl,
  prepareH06DelegatedLegacy,
  verifyH06DelegatedPhase,
  type H06DelegatedPhaseInput,
} from './comparisonH06DelegatedLegacy.js';
import { runDelegatedCompletion, runDelegatedWriterPhase } from './comparisonH06DelegatedWriter.js';
import { observeH06DelegatedUsage } from './comparisonH06DelegatedUsage.js';
import { verifyH06AutonomousAcceptance } from './comparisonH06AutonomousAcceptance.js';
import { runH06NativeLegacy } from './comparisonH06NativeLegacy.js';

const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
function save(path: string, value: unknown): H04Pin {
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}
function pinFile(path: string): H04Pin {
  return { path, sha256: digest(h01RawFile(path)) };
}

async function untilFile(path: string, deadline: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  while (!existsSync(path)) {
    requireContract(Date.now() < deadline, 'h06-delegated-relay-timeout');
    await wait(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  return pinFile(path);
}

function openStore(claimPin: H04Pin) {
  const claim = readH06DelegatedAuthority(claimPin),
    bootstrap = read(claim.request.bootstrap);
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
  return { claim, store };
}

export interface H06DelegatedRunConfig {
  preparation: H04Pin;
  warm: H04Pin;
  cold: H04Pin;
  final: H04Pin;
}
function boundConfig(
  request: ReturnType<typeof readH06DelegatedAuthority>['request'],
  configPin: H04Pin,
) {
  const value = read(configPin) as unknown as H06DelegatedRunConfig;
  exactFields(object(value), ['preparation', 'warm', 'cold', 'final']);
  for (const pin of [configPin, value.preparation, value.warm, value.cold, value.final]) {
    readH04Pin(h04Pin(pin));
    requireContract(
      request.runtime.some((bound) => same(bound, pin)),
      'h06-delegated-run-pin',
    );
  }
  return value;
}
function config(claimPin: H04Pin, configPin: H04Pin) {
  return boundConfig(readH06DelegatedAuthority(claimPin).request, configPin);
}

/** The root consumes the separate source once; the actor never receives a forged human grant. */
export async function startH06DelegatedRun(
  authority: unknown,
  configPin: H04Pin,
  signal?: AbortSignal,
  enclosingStartedAtMs?: number,
) {
  const proposed = planH06DelegatedAuthority(authority);
  boundConfig(proposed.request, configPin);
  signal?.throwIfAborted();
  const claim = consumeH06DelegatedAuthority(authority, enclosingStartedAtMs);
  config(claim.receipt, configPin);
  requireContract(claim.request.stimulus.initialLeaseMs !== null, 'h06-delegated-initial-lease');
  const { store } = openStore(claim.receipt),
    context = store.grant.context;
  const oldDeadline = Date.now() + claim.request.stimulus.initialLeaseMs!;
  const command = {
    type: 'mutate' as const,
    mutation: {
      operation_id: 'chat:initial-owner',
      expected_revision: 0,
      owner_generation: 0,
      payload_hash: '',
    },
    change: { type: 'claim' as const, lease_until: oldDeadline },
  };
  command.mutation.payload_hash = requestHash({ context, command });
  await withChatWriter(store.root, async () => {
    signal?.throwIfAborted();
    initializeStore(store.root, context);
    unwrap(store.execute({ context, command }));
  });
  signal?.throwIfAborted();
  const root = claim.request.evidenceRoot;
  save(join(root, 'delegated-start.json'), {
    claim: claim.receipt,
    config: configPin,
    context,
    oldDeadline,
  });
  const outcome = await runH06NativeLegacy(
    claim.request.binding,
    root,
    store,
    oldDeadline,
    claim.workDeadlineMs,
    async (verify, initialFailure) => {
      signal?.throwIfAborted();
      save(join(root, 'delegated-actor-ready.json'), {
        claim: claim.receipt,
        config: configPin,
        initialFailure,
      });
      const result = await untilFile(
        join(root, 'delegated-completion-result.json'),
        claim.workDeadlineMs,
        signal,
      );
      await settled(claim.receipt, 'completion', signal);
      signal?.throwIfAborted();
      verify();
      const ledger = openH06DelegatedPhaseLedger(claim.receipt).inspect();
      requireContract(
        ledger.phases.length === 6 && ledger.phases.every((phase) => phase.outcome !== null),
        'h06-delegated-run-unsettled',
      );
      return result;
    },
  );
  signal?.throwIfAborted();
  const result = read(outcome.writer.result);
  requireContract(
    result.kind === 'h06-delegated-completion-result/1' && same(result.claim, claim.receipt),
    'h06-delegated-final-binding',
  );
  const usage = object(result.usage);
  const acceptance = await verifyH06AutonomousAcceptance({ claim: claim.receipt }, store);
  return save(join(root, 'delegated-run-outcome.json'), {
    kind: 'h06-delegated-run-outcome/1',
    claim: claim.receipt,
    status:
      acceptance.status === 'PASS'
        ? 'completed'
        : acceptance.status === 'FAIL'
          ? 'acceptance-failed'
          : 'acceptance-unknown',
    acceptance,
    usage,
    outcome,
    delegated: true,
    qualification: false,
  });
}

/** Publish only an actually observed scoped app delivery, then let the retained host apply it. */
export function publishH06DelegatedCommand(packet: H04Pin) {
  const value = read(packet),
    claim = h04Pin(value.claim),
    phase = h04Pin(value.phase);
  const bound = readH06DelegatedAuthority(claim);
  requireContract(process.env.CODEX_THREAD_ID === bound.actorId, 'h06-delegated-actor-only');
  const proof = planH06DelegatedDelivery(value.deliveryInput);
  const pending = openH06DelegatedPhaseLedger(claim).inspect().phases.at(-1);
  requireContract(
    pending?.outcome === null && same(pending.intent, phase),
    'h06-delegated-command-pending',
  );
  const delivery = save(
    join(bound.request.evidenceRoot, `delegated-${pending.phase.stage}-delivery.json`),
    proof,
  );
  const ticket = { claim, phase, delivery };
  verifyH06DelegatedPhase(ticket);
  return save(
    join(bound.request.evidenceRoot, `delegated-${pending.phase.stage}-response.json`),
    ticket,
  );
}

async function requestControl(claim: H04Pin, stage: H06DelegatedStage) {
  const opened = openStore(claim),
    { store } = opened,
    { context } = store.grant;
  const state = unwrap<TechnicalState>(
    store.execute({ context, command: { type: 'state', archive: 'current' } }),
  );
  const chat = await new TaskChatContext(
    { execute: async (request) => store.execute(request) },
    context,
    state.generation,
  ).read();
  requireContract(chat.control !== null && chat.messages !== null, 'h06-delegated-run-context');
  const root = opened.claim.request.evidenceRoot;
  save(join(root, `delegated-${stage}-request.json`), {
    stage,
    generation: state.generation,
    storeRevision: state.revision,
    controlRevision: chat.control.revision,
    requirementsRevision: chat.messages.requirements_revision,
  });
  const response = read(
    await untilFile(join(root, `delegated-${stage}-response.json`), opened.claim.workDeadlineMs),
  );
  const ticket = { claim, phase: h04Pin(response.phase), delivery: h04Pin(response.delivery) };
  requireContract(
    same(response.claim, claim) && verifyH06DelegatedPhase(ticket).phase.stage === stage,
    'h06-delegated-relay-stage',
  );
  return ticket;
}

async function settled(claim: H04Pin, stage: H06DelegatedStage, signal?: AbortSignal) {
  const bound = readH06DelegatedAuthority(claim);
  for (;;) {
    signal?.throwIfAborted();
    const phase = openH06DelegatedPhaseLedger(claim)
      .inspect()
      .phases.find((p) => p.phase.stage === stage);
    if (phase?.outcome !== null && phase?.outcome !== undefined) return;
    requireContract(Date.now() < bound.workDeadlineMs, 'h06-delegated-relay-timeout');
    await wait(500, undefined, { signal });
  }
}

async function control(
  ticket: H06DelegatedPhaseInput,
  preparation: H04Pin,
  stopWriter?: NonNullable<Parameters<typeof applyH06DelegatedLegacyControl>[2]>['stopWriter'],
) {
  const { claim, store } = openStore(ticket.claim),
    bound = verifyH06DelegatedPhase(ticket);
  const source = { locator: ticket.delivery.path, hash: ticket.delivery.sha256 };
  const common = {
    id: bound.phase.nonce,
    expected_revision: bound.phase.controlRevision,
    generation: bound.phase.generation,
    thread_id: claim.actorId,
    source,
  };
  const descriptor = text(read(preparation).descriptor);
  const event = bound.phase.stage.endsWith('pause')
    ? { ...common, type: 'PAUSE' as const, reason: bound.phase.stage }
    : {
        ...common,
        type: 'RESUME' as const,
        marker: `delegated-${bound.phase.nonce}`,
        authorization: source,
        stopped: object(
          read(h04Pin(read(h04Pin(read(bound.phase.predecessor!).outcome)).result)).writer,
        ).stopped as { locator: string; hash: string },
      };
  // Writer callbacks already hold the Store lock for PAUSE; standalone RESUME takes it here.
  const apply = () =>
    applyH06DelegatedLegacyControl(
      { ...ticket, input: preparation, descriptor, event },
      store,
      stopWriter === undefined ? {} : { stopWriter },
    );
  return stopWriter === undefined ? withChatWriter(store.root, apply) : apply();
}

/** The warm host remains the same process through the first RESUME and the second PAUSE. */
export async function runH06DelegatedWarm(
  ticket: H06DelegatedPhaseInput,
  configPin: H04Pin,
  initialFailure: H04Pin,
) {
  const values = config(ticket.claim, configPin),
    { claim, store } = openStore(ticket.claim),
    root = claim.request.evidenceRoot;
  const prepared = await prepareH06DelegatedLegacy(
    { ...ticket, input: values.preparation, initialFailure },
    () => {
      readH06DelegatedAuthority(ticket.claim);
    },
  );
  const load = save(join(root, 'delegated-load-result.json'), {
    kind: 'h06-delegated-load-result/1',
    ...ticket,
    prepared,
    qualification: false,
  });
  await settled(ticket.claim, 'load');
  const warm = await runDelegatedWriterPhase(
    {
      claim: ticket.claim,
      brief: values.warm,
      phase: 'warm',
      previousResume: null,
      previousThreads: [],
    },
    {
      store,
      awaitControl: async (stage, _writer, stopWriter) =>
        control(await requestControl(ticket.claim, stage), values.preparation, stopWriter),
    },
  );
  await settled(ticket.claim, 'warm-pause');
  const resumed = await control(
    await requestControl(ticket.claim, 'warm-resume'),
    values.preparation,
  );
  await settled(ticket.claim, 'warm-resume');
  const cold = await runDelegatedWriterPhase(
    {
      claim: ticket.claim,
      brief: values.cold,
      phase: 'cold',
      previousResume: resumed.receipt,
      previousThreads: [warm.thread],
    },
    {
      store,
      awaitControl: async (stage, _writer, stopWriter) =>
        control(await requestControl(ticket.claim, stage), values.preparation, stopWriter),
    },
  );
  await settled(ticket.claim, 'cold-pause');
  return save(join(root, 'delegated-warm-host-result.json'), {
    claim: ticket.claim,
    config: configPin,
    load,
    warm,
    resumed,
    cold,
    qualification: false,
  });
}

/** A fresh actor process reopens the retained Store and starts only the separately admitted final Writer. */
export async function runH06DelegatedCold(ticket: H06DelegatedPhaseInput, configPin: H04Pin) {
  const values = config(ticket.claim, configPin),
    { claim, store } = openStore(ticket.claim),
    root = claim.request.evidenceRoot;
  const retained = read(pinFile(join(root, 'delegated-warm-host-result.json')));
  requireContract(
    same(retained.claim, ticket.claim) && same(retained.config, configPin),
    'h06-delegated-cold-retained',
  );
  const resumed = await control(ticket, values.preparation);
  await settled(ticket.claim, 'cold-resume');
  save(join(root, 'delegated-completion-request.json'), {
    stage: 'completion',
    coldResume: resumed.receipt,
  });
  const admission = read(
    await untilFile(join(root, 'delegated-completion-admission.json'), claim.workDeadlineMs),
  );
  const completed = await runDelegatedCompletion(
    {
      claim: ticket.claim,
      phase: h04Pin(admission.phase),
      delivery: ticket.delivery,
      brief: values.final,
      coldResume: resumed.receipt,
      previousThreads: [h04Pin(object(retained.warm).thread), h04Pin(object(retained.cold).thread)],
    },
    { store },
  );
  const usage = await observeH06DelegatedUsage({
    claim: ticket.claim,
    threads: [
      h04Pin(object(retained.warm).thread),
      h04Pin(object(retained.cold).thread),
      completed.thread,
    ],
  });
  return save(join(root, 'delegated-completion-result.json'), {
    kind: 'h06-delegated-completion-result/1',
    claim: ticket.claim,
    phase: h04Pin(admission.phase),
    delivery: ticket.delivery,
    resumed,
    completed,
    usage,
    qualification: false,
  });
}
