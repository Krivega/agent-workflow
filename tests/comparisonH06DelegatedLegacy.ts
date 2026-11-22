import { h06PlanningDirectory } from './comparisonH06Planning.js';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as same } from 'node:util';
import {
  FileCurrentChatHost,
  verifyChatContinuation,
  type RecordLine,
} from '../adapters/codex/currentChatHost.js';
import { observedLaunches, serialInvocations } from '../adapters/codex/chatCommandSettlement.js';
import { FileChatRecovery } from '../adapters/project/chatRecovery.js';
import { fileRunInputs } from '../adapters/project/fileRunInputs.js';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { bindChatEvidence } from '../adapters/storage/chatWriter.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { prepareChatControl } from '../application/chatControl.js';
import type { beginChatExecution, readyCurrentChat } from '../application/currentChatWorkflow.js';
import { executeChatRequest } from '../cli/chatRuntime.js';
import { taskChatGates } from '../cli/taskChatInputs.js';
import type { ChatControlEvent } from '../core/chatControl.js';
import { validateCoderRun, type CoderRun } from '../core/coder.js';
import { localLocator } from '../core/connection.js';
import {
  evidenceSchema,
  type EvidenceGrant,
  type EffectRecord,
  type OperationResult,
  type TechnicalState,
} from '../core/evidence.js';
import { startLocalRun, type InputRef, type RunSpec } from '../core/localRun.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import type { UserCommands, UserCommandTarget } from '../ports/userCommands.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import { identifier, object, requireContract, text } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  h06DelegatedPhaseAction,
  openH06DelegatedPhaseLedger,
  readH06DelegatedAuthority,
} from './comparisonH06DelegatedAuthority.js';
import { verifyH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import { checkH06NativeFailure } from './comparisonH06NativeFailure.js';
import { verifyCoderStop } from './comparisonH06NativeLegacyControl.js';
import {
  verifyH06RetainedWarmContinuation,
  type H06RetainedWarmContinuationProof,
} from './comparisonH06RetainedWarmContinuation.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';

export interface H06DelegatedPhaseInput {
  claim: H04Pin;
  phase: H04Pin;
  delivery: H04Pin;
}

const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(pin).toString()));
const reference = (pin: H04Pin): InputRef => ({ locator: pin.path, hash: pin.sha256 });
function save(path: string, value: unknown): H04Pin {
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

/** A delivery is useful only under the one currently pending, scoped phase admission. */
export function verifyH06DelegatedPhase(value: H06DelegatedPhaseInput) {
  const claim = readH06DelegatedAuthority(value.claim);
  const ledger = openH06DelegatedPhaseLedger(value.claim).inspect();
  const pending = ledger.phases.at(-1);
  requireContract(
    pending !== undefined && pending.outcome === null && same(pending.intent, value.phase),
    'h06-delegated-current-phase',
  );
  const phase = pending.phase;
  const proof = verifyH06DelegatedDelivery(read(value.delivery));
  const { input } = proof;
  requireContract(
    input.sessionsRoot === claim.grant.sessionsRoot &&
      input.root.threadId === claim.request.chat.threadId &&
      input.root.workspace === claim.request.chat.workspace &&
      input.root.turnId === claim.source.turnId &&
      same(input.root.user, claim.source.source) &&
      input.actor.threadId === claim.actorId &&
      input.actor.workspace === claim.request.binding.workspaceRoot &&
      phase.rootThread === input.root.threadId &&
      phase.actorThread === input.actor.threadId &&
      phase.requestHash === claim.requestHash &&
      phase.generation === claim.generation &&
      input.command.nonce === phase.nonce &&
      input.command.requestHash === claim.requestHash &&
      input.command.action === h06DelegatedPhaseAction(phase.stage) &&
      same(input.command.target, {
        claim: value.claim,
        intent: value.phase,
        stage: phase.stage,
        generation: phase.generation,
        storeRevision: phase.storeRevision,
        controlRevision: phase.controlRevision,
        requirementsRevision: phase.requirementsRevision,
      }) &&
      Date.now() < claim.workDeadlineMs,
    'h06-delegated-phase-delivery',
  );
  return {
    claim,
    phase,
    proof,
    source: reference(value.delivery),
    transcript: proof.inbound.locator.replace(/#L[1-9]\d*$/u, ''),
    anchor: {
      thread_id: input.actor.threadId,
      turn_id: proof.actorTurnId,
      workspace: input.actor.workspace,
      host_id: 'local' as const,
    },
  };
}

function delegatedHost(bound: ReturnType<typeof verifyH06DelegatedPhase>) {
  return new FileCurrentChatHost(
    bound.anchor.workspace,
    bound.transcript,
    bound.anchor,
    null,
    false,
    { senderTurn: bound.proof.input.root.turnId },
  );
}

/** Explicit delegated ports; they never reinterpret an inbound envelope as a native human. */
export function h06DelegatedControlPorts(
  value: H06DelegatedPhaseInput,
  native: CurrentChatHost,
  target: UserCommandTarget,
) {
  function verify(source: InputRef) {
    const bound = verifyH06DelegatedPhase(value);
    requireContract(
      same(source, bound.source) &&
        same(target, {
          project_id: identifier(read(bound.claim.request.bootstrap).projectId),
          task_id: bound.claim.request.binding.operationId,
          run_id: identifier(read(bound.claim.request.bootstrap).runId),
          thread_id: bound.claim.actorId,
          generation: bound.phase.generation,
          control_revision: bound.phase.controlRevision,
          requirements_revision: bound.phase.requirementsRevision,
        }),
      'h06-delegated-command-target',
    );
    return bound;
  }
  const host: CurrentChatHost = {
    observe: () => native.observe(),
    load: (run, marker, reuse) => native.load(run, marker, reuse),
    boundary: (turn) => native.boundary(turn),
    continuation: (turn) => native.continuation(turn),
    async reference(source) {
      verify(source);
    },
    async message(source, previousTurn) {
      const bound = verify(source);
      requireContract(previousTurn === undefined, 'h06-delegated-previous-source-forbidden');
      return { thread_id: bound.anchor.thread_id, turn_id: bound.anchor.turn_id };
    },
  };
  const commands: UserCommands = {
    async verify(source, requested) {
      verify(source);
      requireContract(same(requested, target), 'h06-delegated-command-target');
    },
  };
  return { host, commands };
}

export async function prepareH06DelegatedLegacy(
  value: H06DelegatedPhaseInput & { input: H04Pin; initialFailure: H04Pin },
  verify: () => void,
) {
  const bound = verifyH06DelegatedPhase(value);
  const { request, actorId, generation, workDeadlineMs } = bound.claim;
  const { binding, evidenceRoot } = request;
  requireContract(
    bound.phase.stage === 'load' &&
      request.runtime.some((pin) => same(pin, value.input)) &&
      value.initialFailure.path === join(evidenceRoot, 'f01', 'receipt.json'),
    'h06-delegated-preparation-input',
  );
  checkH06NativeFailure(binding, value.initialFailure);
  const bootstrap = read(request.bootstrap),
    config = read(value.input);
  const spec = object(config.spec) as unknown as RunSpec;
  const descriptor = localLocator(config.descriptor),
    planningFile = localLocator(config.planningFile),
    marker = text(config.marker);
  const permissions = bootstrap.permissions as EvidenceGrant['permissions'];
  requireContract(
    config.kind === 'comparison-h06-native-legacy-preparation/2' &&
      bootstrap.kind === 'comparison-h06-native-legacy-bootstrap/2' &&
      bootstrap.actorId === actorId &&
      bootstrap.generation === generation &&
      Array.isArray(permissions) &&
      new Set(permissions).size === permissions.length &&
      permissions.every((p) => ['read', 'manage', 'produce', 'resolve'].includes(p)) &&
      permissions.includes('read') &&
      permissions.includes('manage') &&
      spec.project_id === bootstrap.projectId &&
      spec.run_id === bootstrap.runId &&
      spec.session_id === actorId &&
      spec.host_id === 'local' &&
      spec.workspace === binding.workspaceRoot &&
      spec.parent_run_id === null &&
      'task_id' in spec.identity &&
      spec.identity.task_id === binding.operationId &&
      (spec.route.kind === 'local' || spec.route.kind === 'substantial') &&
      spec.route.accepted_plan?.locator === planningFile,
    'h06-delegated-preparation-binding',
  );
  const planningDirectory = h06PlanningDirectory(
    spec.workspace,
    evidenceRoot,
    spec.route.accepted_plan,
    request.runtime,
  );
  const host = delegatedHost(bound);
  const observed = await host.observe();
  requireContract(
    process.env.CODEX_THREAD_ID === actorId &&
      observed.model === spec.requested.model &&
      observed.effort === spec.requested.effort &&
      observed.sandbox_policy === 'danger-full-access' &&
      observed.approval_policy === 'never' &&
      observed.permission_profile === 'disabled',
    'h06-delegated-preparation-profile',
  );
  const load = await host.load(startLocalRun(spec, generation), marker);
  const grant: EvidenceGrant = {
    context: {
      schema_version: evidenceSchema,
      project_id: spec.project_id,
      task_id: binding.operationId,
      subtask_id: null,
      run_id: spec.run_id,
      actor_id: actorId,
    },
    permissions,
  };
  const storeRoot = safeDirectory(join(evidenceRoot, 'legacy-store'));
  const store = new SqliteEvidenceStore(storeRoot, grant, Date.now);
  const state = unwrap<TechnicalState>(
    store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
  );
  requireContract(
    state.owner === actorId &&
      state.generation === generation &&
      state.revision === bound.phase.storeRevision &&
      !state.released &&
      !state.frozen &&
      state.lease_until > Date.now() &&
      state.checkpoint === null,
    'h06-delegated-preparation-store',
  );
  const connections = new FileTaskConnection(binding.workspaceRoot);
  const connection = await connections.preview(
    descriptor,
    spec.identity.card.locator,
    binding.operationId,
  );
  requireContract(
    connection.from_version === 2 &&
      connection.before === connection.after &&
      digest(connection.before) === spec.identity.card.hash,
    'h06-delegated-preparation-card',
  );
  async function beforeEffect() {
    verify();
    verifyH06DelegatedPhase(value);
    readH04Pin(value.input);
    readH04Pin(value.initialFailure);
    requireContract(
      Date.now() < workDeadlineMs && same(await host.observe(), observed),
      'h06-delegated-preparation-changed',
    );
    const latest = unwrap<TechnicalState>(
      store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    );
    requireContract(
      latest.owner === actorId &&
        latest.generation === generation &&
        !latest.released &&
        !latest.frozen &&
        latest.lease_until > Date.now(),
      'h06-delegated-preparation-store',
    );
  }
  await beforeEffect();
  save(join(evidenceRoot, 'delegated-preparation-intent.json'), {
    kind: 'h06-delegated-preparation-intent/1',
    ...value,
    load,
    observed,
  });
  const connectionJournal = join(evidenceRoot, 'legacy-connection');
  await connections.apply(connection, connectionJournal);
  const chatRequest = {
    root: binding.workspaceRoot,
    evidence_root: evidenceRoot,
    storage: { root: storeRoot, grant },
    generation,
    descriptor,
    connection_journal: connectionJournal,
    planning_file: planningFile,
    marker,
    spec,
    transcript: bound.transcript,
    anchor: bound.anchor,
  };
  await beforeEffect();
  const actor = { senderTurn: bound.proof.input.root.turnId, planningDirectory };
  await executeChatRequest('prepare-chat', chatRequest, actor);
  await beforeEffect();
  const ready = (await executeChatRequest('bootstrap-chat', chatRequest, actor)) as Awaited<
    ReturnType<typeof readyCurrentChat>
  >;
  requireContract(
    ready.run.status === 'ready' && same(ready.run.loaded, load) && same(ready.observed, observed),
    'h06-delegated-preparation-ready',
  );
  let execution: Awaited<ReturnType<typeof beginChatExecution>> | null = null;
  if (config.gates !== undefined) {
    requireContract(Array.isArray(config.gates), 'h06-delegated-preparation-gates');
    const gates = config.gates.map(object);
    requireContract(
      same(
        gates,
        taskChatGates(
          spec.criteria,
          gates.filter((g) => g.kind === 'human').map((g) => text(g.id)),
        ),
      ),
      'h06-delegated-preparation-gates',
    );
    await beforeEffect();
    execution = (await executeChatRequest(
      'execution-chat',
      {
        ...chatRequest,
        code: true,
        gates,
      },
      actor,
    )) as Awaited<ReturnType<typeof beginChatExecution>>;
    requireContract(
      execution.status === 'implementing' &&
        execution.generation === generation &&
        execution.task_id === binding.operationId,
      'h06-delegated-preparation-execution',
    );
  }
  await beforeEffect();
  return { request: chatRequest, ready, execution };
}

type ControlEvent =
  Extract<ChatControlEvent, { type: 'RESUME' }> | (ChatControlEvent & { type: 'PAUSE' });
type Store = Pick<SqliteEvidenceStore, 'execute' | 'grant' | 'root'>;
export interface H06DelegatedStoppedWriter {
  coder: CoderRun;
  stopped: InputRef;
  live?: H04Pin;
}

function nativeRows(path: string, bytes: Buffer): RecordLine[] {
  return bytes
    .toString()
    .slice(0, -1)
    .split('\n')
    .map((line, index) => ({
      record: object(JSON.parse(line)),
      ref: { locator: path + '#L' + (index + 1), hash: digest(line + '\n') },
    }));
}

/** Retain the one owned warm process without inventing a terminal event for its native command. */
async function prepareH06RetainedWarmContinuation(
  value: H06DelegatedPhaseInput & { input: H04Pin; paused: H04Pin; turn: string },
) {
  const bound = verifyH06DelegatedPhase(value);
  requireContract(bound.phase.stage === 'warm-resume', 'h06-delegated-retained-stage');
  const host = {
    pid: process.pid,
    startedAt: performance.timeOrigin,
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    argv: [...process.argv],
  };
  requireContract(
    same(read(value.paused).host, { pid: host.pid, startedAt: host.startedAt }) &&
      host.argv.length === 4 &&
      host.argv[0] === host.execPath &&
      host.argv[2] === 'warm' &&
      host.execArgv.length === 2 &&
      host.execArgv[0] === '--import',
    'h06-delegated-retained-host',
  );
  const quote = (part: string) =>
    /^[a-zA-Z0-9_./:=+-]+$/u.test(part) ? part : "'" + part.replaceAll("'", "'\\''") + "'";
  const command = [host.execPath, ...host.execArgv, ...host.argv.slice(1)].map(quote).join(' ');
  const phases = openH06DelegatedPhaseLedger(value.claim).inspect().phases;
  function bundle(stage: 'load' | 'warm-pause') {
    const entry = phases.find((p) => p.phase.stage === stage);
    requireContract(
      entry !== undefined && entry.outcome !== null,
      'h06-delegated-retained-history',
    );
    const outcome = read(h04Pin(read(entry.outcome).outcome));
    return {
      intent: entry.intent,
      settlement: entry.outcome,
      result: h04Pin(outcome.result),
      delivery: h04Pin(outcome.delivery),
    };
  }
  const load = bundle('load'),
    pause = bundle('warm-pause');
  const native = delegatedHost(bound);
  requireContract(
    value.turn !== (await native.observe()).turn_id,
    'chat-continuation-turn-required',
  );
  const boundary = await native.boundary(value.turn);
  requireContract(boundary.kind === 'completed', 'h06-delegated-retained-boundary');
  const bytes = readH06NativeJournal(bound.transcript),
    rows = nativeRows(bound.transcript, bytes);
  const start = rows.findIndex(
    ({ record }) =>
      record.type === 'event_msg' &&
      object(record.payload).type === 'task_started' &&
      object(record.payload).turn_id === value.turn,
  );
  const end = rows.findIndex(({ ref }) => same(ref, boundary.source));
  requireContract(start >= 0 && end > start, 'h06-delegated-retained-history');
  const prior = rows.slice(start + 1, end);
  const launches = prior.filter(({ record }) => {
    const payload = object(record.payload);
    if (
      record.type !== 'response_item' ||
      payload.type !== 'custom_tool_call' ||
      payload.name !== 'exec' ||
      typeof payload.input !== 'string'
    )
      return false;
    const parsed = serialInvocations(payload.input);
    return (
      parsed !== null &&
      parsed.length === 1 &&
      'command' in parsed[0]! &&
      parsed[0].command === command
    );
  });
  requireContract(launches.length === 1, 'h06-delegated-retained-single-launch');
  const call = launches[0]!,
    callId = object(call.record.payload).call_id;
  const replies = prior.filter(
    ({ record }) =>
      record.type === 'response_item' &&
      object(record.payload).type === 'custom_tool_call_output' &&
      object(record.payload).call_id === callId,
  );
  requireContract(replies.length === 1, 'h06-delegated-retained-single-result');
  const output = replies[0]!,
    blocks = object(output.record.payload).output;
  requireContract(
    Array.isArray(blocks) &&
      blocks.length === 2 &&
      typeof object(blocks[0]).text === 'string' &&
      String(object(blocks[0]).text).startsWith('Script completed\n'),
    'h06-delegated-retained-script',
  );
  const result = object(JSON.parse(text(object(blocks[1]).text)));
  requireContract(
    Number.isSafeInteger(result.session_id) &&
      Number(result.session_id) > 0 &&
      result.exit_code === undefined,
    'h06-delegated-retained-session',
  );
  const session = String(result.session_id);
  requireContract(
    observedLaunches(prior).get(session) === command,
    'h06-delegated-retained-command',
  );
  const removed = new Set([call.ref.locator, output.ref.locator]);
  const projected = rows.filter(({ ref }) => !removed.has(ref.locator));
  const source = verifyChatContinuation(
    projected,
    bound.anchor.thread_id,
    value.turn,
    bound.claim.request.binding.workspaceRoot,
    boundary.source,
  );
  const packet = { path: host.argv[3]!, sha256: digest(h01RawFile(host.argv[3]!)) };
  const configuration = read(h04Pin(read(packet).config));
  requireContract(
    same(configuration.preparation, value.input),
    'h06-delegated-retained-preparation',
  );
  const proof: H06RetainedWarmContinuationProof = {
    kind: 'h06-delegated-retained-host-continuation/1',
    claim: value.claim,
    phase: value.phase,
    delivery: value.delivery,
    load,
    pause,
    host,
    packet,
    transcript: bound.transcript,
    nativePrefix: { bytes: bytes.length, sha256: digest(bytes) },
    launch: { call: call.ref, output: output.ref, session, command },
    boundary: boundary.source,
    source,
  };
  const receipt = save(
    join(bound.claim.request.evidenceRoot, 'delegated-warm-resume-retained-host.json'),
    proof,
  );
  await verifyH06RetainedWarmContinuation({ claim: value.claim, proof: receipt });
  function recheck() {
    verifyH06DelegatedPhase(value);
    readH04Pin(receipt);
    readH04Pin(packet);
    requireContract(
      same(host, {
        pid: process.pid,
        startedAt: performance.timeOrigin,
        execPath: process.execPath,
        execArgv: process.execArgv,
        argv: process.argv,
      }),
      'h06-delegated-retained-host-changed',
    );
    const current = readH06NativeJournal(bound.transcript);
    requireContract(
      current.length >= bytes.length && current.subarray(0, bytes.length).equals(bytes),
      'h06-delegated-retained-prefix-changed',
    );
    requireContract(
      same(
        verifyChatContinuation(
          nativeRows(bound.transcript, current).filter(({ ref }) => !removed.has(ref.locator)),
          bound.anchor.thread_id,
          value.turn,
          bound.claim.request.binding.workspaceRoot,
          boundary.source,
        ),
        source,
      ),
      'h06-delegated-retained-source-changed',
    );
  }
  recheck();
  return { source, receipt, recheck };
}

/** Caller owns the canonical Store writer lock for the complete control and STOP transaction. */
export async function applyH06DelegatedLegacyControl(
  value: H06DelegatedPhaseInput & { event: ControlEvent; descriptor: string; input: H04Pin },
  store: Store,
  runtime: { stopWriter?: () => Promise<H06DelegatedStoppedWriter> } = {},
) {
  const bound = verifyH06DelegatedPhase(value),
    { phase, claim } = bound;
  const { event } = value,
    evidence = safeDirectory(claim.request.evidenceRoot),
    workspace = safeDirectory(claim.request.binding.workspaceRoot);
  const { context } = store.grant;
  const state = () =>
    unwrap<TechnicalState>(
      store.execute({ context, command: { type: 'state', archive: 'current' } }),
    );
  const before = state();
  function owner(current: TechnicalState) {
    requireContract(
      current.owner === claim.actorId &&
        current.generation === phase.generation &&
        !current.released &&
        !current.frozen &&
        current.lease_until > Date.now(),
      'h06-delegated-control-owner',
    );
  }
  owner(before);
  const bootstrap = read(claim.request.bootstrap);
  requireContract(
    claim.request.runtime.some((pin) => same(pin, value.input)),
    'h06-delegated-control-input',
  );
  const preparation = read(value.input);
  requireContract(
    store.root === join(evidence, 'legacy-store') &&
      context.actor_id === claim.actorId &&
      context.project_id === bootstrap.projectId &&
      context.run_id === bootstrap.runId &&
      context.task_id === claim.request.binding.operationId &&
      store.grant.permissions.includes('manage') &&
      phase.storeRevision === before.revision &&
      ['warm-pause', 'warm-resume', 'cold-pause', 'cold-resume'].includes(phase.stage) &&
      event.type === h06DelegatedPhaseAction(phase.stage) &&
      event.id === phase.nonce &&
      event.generation === phase.generation &&
      event.expected_revision === phase.controlRevision &&
      event.thread_id === claim.actorId &&
      same(event.source, bound.source) &&
      process.env.CODEX_THREAD_ID === claim.actorId &&
      preparation.kind === 'comparison-h06-native-legacy-preparation/2' &&
      value.descriptor === preparation.descriptor,
    'h06-delegated-control-binding',
  );
  const verifyRuntime = bindChatEvidence(store.root, evidence, before);
  const retainedChecks: Array<() => void> = [];
  const retainedContinuations: H04Pin[] = [];
  function unchanged() {
    verifyH06DelegatedPhase(value);
    verifyRuntime();
    for (const recheck of retainedChecks) recheck();
    const latest = state();
    owner(latest);
    const effects = unwrap<EffectRecord[]>(
      store.execute({ context, command: { type: 'effects' } }),
    );
    requireContract(
      same(before, latest) &&
        effects.every((e) => e.outcome === 'confirmed' || e.outcome === 'not-started'),
      'h06-delegated-control-store-changed',
    );
  }
  const operation = 'chat:control:' + event.id;
  const journal = new TaskChatContext(
    {
      async execute(command) {
        verifyRuntime();
        if (command.command.type === 'mutate') {
          unchanged();
          requireContract(
            command.command.mutation.operation_id === operation &&
              command.command.mutation.expected_revision === before.revision,
            'h06-delegated-control-cas',
          );
        }
        return store.execute(command);
      },
    },
    context,
    event.generation,
  );
  const current = await journal.read(),
    control = current.control;
  requireContract(
    control !== null &&
      control.status === (event.type === 'PAUSE' ? 'active' : 'paused') &&
      control.revision === phase.controlRevision &&
      !control.history.some((e) => e.id === event.id) &&
      control.generation === phase.generation &&
      current.run.generation === phase.generation &&
      current.run.spec.session_id === claim.actorId &&
      current.run.spec.workspace === workspace &&
      current.run.spec.project_id === context.project_id &&
      current.run.spec.run_id === context.run_id &&
      'task_id' in current.run.spec.identity &&
      current.run.spec.identity.task_id === context.task_id &&
      current.messages?.requirements_revision === phase.requirementsRevision,
    'h06-delegated-control-context',
  );
  const native = delegatedHost(bound);
  const observation = await native.observe();
  const expected = current.run.spec.requested;
  requireContract(
    observation.model === expected.model &&
      observation.effort === expected.effort &&
      observation.approval_policy === 'never' &&
      observation.sandbox_policy === 'danger-full-access' &&
      observation.permission_profile === 'disabled',
    'h06-delegated-control-profile',
  );
  const ports = h06DelegatedControlPorts(value, native, {
    project_id: context.project_id,
    task_id: context.task_id,
    run_id: context.run_id,
    thread_id: claim.actorId,
    generation: phase.generation,
    control_revision: phase.controlRevision,
    requirements_revision: phase.requirementsRevision,
  });
  let stoppedWriter: H06DelegatedStoppedWriter | null = null;
  let pausedResult: H04Pin | null = null;
  const hostIdentity = { pid: process.pid, startedAt: performance.timeOrigin };
  if (event.type === 'RESUME') {
    requireContract(
      event.previous_source_turn === undefined &&
        same(event.authorization, bound.source) &&
        phase.predecessor !== null,
      'h06-delegated-resume-authorization',
    );
    const settlement = read(phase.predecessor);
    const predecessor = read(h04Pin(settlement.outcome));
    pausedResult = h04Pin(predecessor.result);
    const paused = read(pausedResult);
    requireContract(
      predecessor.kind === 'h06-delegated-phase-outcome/1' &&
        predecessor.status === 'confirmed' &&
        same(predecessor.claim, value.claim) &&
        predecessor.stage === phase.stage.replace('resume', 'pause') &&
        paused.kind === 'h06-delegated-control-result/1' &&
        same(paused.claim, value.claim) &&
        same(paused.phase, predecessor.intent) &&
        same(paused.delivery, predecessor.delivery) &&
        same(paused.control, control) &&
        same(paused.context, context),
      'h06-delegated-resume-predecessor',
    );
    const previousHost = object(paused.host);
    requireContract(
      Number.isSafeInteger(previousHost.pid) &&
        Number(previousHost.pid) > 1 &&
        typeof previousHost.startedAt === 'number' &&
        Number.isFinite(previousHost.startedAt) &&
        (phase.stage === 'warm-resume'
          ? same(previousHost, hostIdentity)
          : !same(previousHost, hostIdentity)),
      'h06-delegated-resume-host',
    );
    if (phase.stage === 'cold-resume') {
      let absent = false;
      try {
        process.kill(Number(previousHost.pid), 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        absent = true;
      }
      requireContract(absent, 'h06-delegated-previous-host-active');
    }
    stoppedWriter = object(paused.writer) as unknown as H06DelegatedStoppedWriter;
    validateCoderRun(stoppedWriter.coder);
    requireContract(
      same(stoppedWriter.stopped, event.stopped) &&
        same(current.workflow.coders?.[stoppedWriter.coder.brief.id], stoppedWriter.coder),
      'h06-delegated-resume-writer',
    );
  } else requireContract(runtime.stopWriter !== undefined, 'h06-delegated-pause-stop-required');
  function verifyWriter(writer: H06DelegatedStoppedWriter, coders: typeof current.workflow.coders) {
    const { coder } = writer;
    validateCoderRun(coder);
    requireContract(
      same(coders?.[coder.brief.id], coder) &&
        coder.session !== null &&
        coder.copy !== null &&
        coder.session.id !== claim.actorId &&
        coder.brief.parent_session_id === claim.actorId &&
        coder.brief.parent_run_id === context.run_id &&
        coder.brief.task_id === context.task_id &&
        coder.brief.project_id === context.project_id &&
        coder.brief.source_root === workspace &&
        coder.baseline.source.root === workspace &&
        coder.brief.generation === phase.generation &&
        coder.copy.binding.root === coder.brief.copy_root &&
        coder.session.workspace === coder.brief.copy_root &&
        coder.session.project_id === context.project_id &&
        coder.turn !== null,
      'h06-delegated-writer-binding',
    );
    for (const directory of [coder.baseline.source, coder.copy.binding]) {
      const actual = statSync(safeDirectory(directory.root));
      requireContract(
        actual.dev === directory.dev && actual.ino === directory.ino,
        'h06-delegated-writer-directory',
      );
    }
    for (const ref of [coder.copy.evidence, coder.session.receipt])
      readH04Pin({ path: ref.locator, sha256: ref.hash });
  }
  if (stoppedWriter !== null) verifyWriter(stoppedWriter, current.workflow.coders);
  if (event.type === 'RESUME' && phase.stage === 'warm-resume') {
    const strictContinuation = ports.host.continuation;
    ports.host.continuation = async (turn) => {
      if (turn !== control.origin?.turn_id) return strictContinuation(turn);
      requireContract(pausedResult !== null, 'h06-delegated-retained-pause-required');
      const retained = await prepareH06RetainedWarmContinuation({
        claim: value.claim,
        phase: value.phase,
        delivery: value.delivery,
        input: value.input,
        paused: pausedResult,
        turn,
      });
      retainedChecks.push(retained.recheck);
      retainedContinuations.push(retained.receipt);
      return retained.source;
    };
  }
  const recovery = new FileChatRecovery(workspace, evidence, journal, new NativeWriterProcesses());
  unchanged();
  const { next } = await prepareChatControl(
    event,
    current,
    ports.host,
    fileRunInputs(workspace, value.descriptor),
    {
      settled: () => recovery.settled(),
      async stopped(ref, thread, turn) {
        requireContract(
          stoppedWriter !== null &&
            same(ref, stoppedWriter.stopped) &&
            thread === claim.actorId &&
            turn === control.observed.turn_id,
          'h06-delegated-stop-binding',
        );
        await verifyCoderStop(ref, stoppedWriter.coder, evidence);
      },
    },
    ports.commands,
  );
  unchanged();
  requireContract(
    same(await native.observe(), observation) &&
      next.control?.revision === phase.controlRevision + 1 &&
      next.control.history.at(-1)?.id === event.id &&
      (event.type === 'PAUSE'
        ? next.control.status === 'paused' && next.run.loaded === null
        : next.control.status === 'active' && next.run.loaded !== null),
    'h06-delegated-control-result',
  );
  const intent = save(join(evidence, `delegated-${phase.stage}-control-intent.json`), {
    kind: 'h06-delegated-control-intent/1',
    ...value,
    context,
    host: hostIdentity,
  });
  await journal.save(current, next, operation);
  const ack = unwrap<OperationResult>(
    store.execute({ context, command: { type: 'operation', operation_id: operation } }),
  );
  const after = state();
  owner(after);
  requireContract(
    ack.status === 'confirmed' &&
      ack.ack.operation_id === operation &&
      ack.ack.generation === phase.generation &&
      ack.ack.catalog_revision === before.revision + 1 &&
      after.revision === ack.ack.catalog_revision,
    'h06-delegated-control-ack-unknown',
  );
  if (event.type === 'PAUSE') {
    verifyH06DelegatedPhase(value);
    verifyRuntime();
    owner(state());
    requireContract(
      same(after, state()) && same(await native.observe(), observation),
      'h06-delegated-stop-context-changed',
    );
    stoppedWriter = await runtime.stopWriter!();
    verifyWriter(stoppedWriter, next.workflow.coders);
    await verifyCoderStop(stoppedWriter.stopped, stoppedWriter.coder, evidence);
    verifyH06DelegatedPhase(value);
    verifyRuntime();
    owner(state());
    requireContract(same(after, state()), 'h06-delegated-stop-store-changed');
  }
  const receipt = save(join(evidence, `delegated-${phase.stage}-result.json`), {
    kind: 'h06-delegated-control-result/1',
    claim: value.claim,
    phase: value.phase,
    delivery: value.delivery,
    context,
    host: hostIdentity,
    intent,
    event,
    operation,
    ack: ack.ack,
    control: next.control,
    load: next.run.loaded,
    writer: stoppedWriter,
    retainedContinuations,
    qualification: false,
  });
  return { intent, receipt };
}
