import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { isDeepStrictEqual as same } from 'node:util';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import type { AppServerCoderSessions } from '../adapters/codex/appServerCoder.js';
import { NativeUserCommands } from '../adapters/codex/userCommands.js';
import { FileChatRecovery } from '../adapters/project/chatRecovery.js';
import { fileRunInputs } from '../adapters/project/fileRunInputs.js';
import { writerScopeHash } from '../adapters/project/writerScope.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { bindChatEvidence } from '../adapters/storage/chatWriter.js';
import { unwrap, type SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { prepareChatControl } from '../application/chatControl.js';
import type { ChatControlEvent } from '../core/chatControl.js';
import type { CoderRun } from '../core/coder.js';
import type { ChatAnchor } from '../core/currentChat.js';
import type { EffectRecord, OperationResult, TechnicalState } from '../core/evidence.js';
import type { InputRef } from '../core/localRun.js';
import type { ChatContext } from '../ports/chatContext.js';
import type { ProcessIdentity } from '../ports/writerProcesses.js';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';

type Pause = Extract<ChatControlEvent, { reason: string }> & { type: 'PAUSE' };
type Resume = Extract<ChatControlEvent, { type: 'RESUME' }> & { stopped: InputRef };

interface LegacyControlBinding {
  workspaceRoot: string;
  evidenceRoot: string;
  descriptor: string;
  transcript: string;
  anchor: ChatAnchor;
  phase: 'warm' | 'cold';
  storeRevision: number;
  requirementsRevision: number;
}

type LegacyControlRequest = LegacyControlBinding &
  ({ event: Pause } | { event: Resume; paused: H04Pin; stoppedBy: H04Pin });

type LegacyStore = Pick<SqliteEvidenceStore, 'execute' | 'grant' | 'root'>;
type LegacySessions = Pick<AppServerCoderSessions, 'stop'> &
  Partial<Pick<AppServerCoderSessions, 'observeLiveWriter'>>;
type LegacyLiveness =
  | {
      status: 'live';
      observedAt: number;
      observation: Awaited<ReturnType<AppServerCoderSessions['observeLiveWriter']>>;
    }
  | { status: 'unknown'; reason: 'no-observer' | 'observation-unconfirmed' | 'stop-scope-changed' };

function pin(path: string, value: unknown): H04Pin {
  const bytes = Buffer.from(JSON.stringify(value));
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

function readPin(value: H04Pin) {
  return object(JSON.parse(readH04Pin(value).toString()));
}

function stopPaths(evidence: string, phase: 'warm' | 'cold') {
  return {
    intent: join(evidence, `legacy-${phase}-writer-stop-intent.json`),
    link: join(evidence, `legacy-${phase}-writer-stop.json`),
  };
}

function coderBinding(current: ChatContext, store: LegacyStore, workspace: string, id: string) {
  const coder = current.workflow.coders?.[identifier(id)];
  const { context } = store.grant;
  requireContract(
    coder !== undefined &&
      coder.brief.id === id &&
      coder.brief.project_id === context.project_id &&
      coder.brief.task_id === context.task_id &&
      coder.brief.parent_run_id === context.run_id &&
      coder.brief.parent_session_id === context.actor_id &&
      coder.brief.generation === current.run.generation &&
      coder.brief.source_root === workspace &&
      coder.baseline.source.root === workspace &&
      coder.session !== null &&
      coder.copy !== null &&
      coder.copy.binding.root === coder.brief.copy_root &&
      coder.session.workspace === coder.brief.copy_root &&
      coder.session.project_id === context.project_id &&
      coder.session.id !== context.actor_id &&
      coder.turn !== null,
    'h06-legacy-writer-binding',
  );
  for (const binding of [coder.baseline.source, coder.copy.binding]) {
    const stat = statSync(safeDirectory(binding.root));
    requireContract(
      stat.dev === binding.dev && stat.ino === binding.ino,
      'h06-legacy-writer-directory-changed',
    );
  }
  for (const ref of [coder.copy.evidence, coder.session.receipt])
    readH04Pin({ path: ref.locator, sha256: ref.hash });
  return coder;
}

export async function verifyCoderStop(
  ref: InputRef,
  coder: CoderRun,
  evidence: string,
  liveness?: LegacyLiveness,
) {
  requireContract(
    coder.session !== null && coder.copy !== null && ref.locator.startsWith(evidence + sep),
    'h06-legacy-writer-stop-binding',
  );
  const proof = readPin({ path: ref.locator, sha256: ref.hash });
  const owned = object(proof.owned);
  const markers = [coder.copy.evidence.locator, coder.session.receipt.locator];
  requireContract(
    proof.kind === 'writers-stopped' &&
      proof.thread === coder.session.id &&
      proof.active_turn === false &&
      proof.remaining_terminals === 0 &&
      proof.remaining_processes === 0 &&
      typeof proof.before_hash === 'string' &&
      proof.before_hash === proof.after_hash &&
      typeof proof.observation_ms === 'number' &&
      proof.observation_ms > 0 &&
      owned.thread === coder.session.id &&
      owned.turn === coder.turn &&
      owned.tree === coder.copy.binding.root &&
      owned.complete === true &&
      same(owned.markers, markers) &&
      Array.isArray(proof.processes),
    'h06-legacy-writer-stop-binding',
  );
  const processes = proof.processes.map((value): ProcessIdentity => {
    const process = object(value);
    const { pid, parent, started } = process;
    requireContract(
      typeof pid === 'number' &&
        Number.isSafeInteger(pid) &&
        pid > 1 &&
        typeof parent === 'number' &&
        Number.isSafeInteger(parent) &&
        parent >= 0 &&
        typeof started === 'string' &&
        started.length > 0,
      'h06-legacy-writer-process-identity',
    );
    return { pid, parent, started };
  });
  const observed = liveness?.status === 'live' ? liveness.observation : null;
  const sameRuntime = observed !== null && same(observed.runtime, owned.runtime);
  requireContract(
    (await new NativeWriterProcesses().alive([...processes, ...(observed?.processes ?? [])]))
      .length === 0 &&
      (await writerScopeHash(markers, coder.copy.binding.root)) === proof.after_hash,
    'h06-legacy-writer-stop-changed',
  );
  readH04Pin({ path: ref.locator, sha256: ref.hash });
  return sameRuntime;
}

async function observeLegacyWriter(
  sessions: LegacySessions,
  coder: CoderRun,
): Promise<LegacyLiveness> {
  if (sessions.observeLiveWriter === undefined) return { status: 'unknown', reason: 'no-observer' };
  try {
    const observation = await sessions.observeLiveWriter(coder);
    requireContract(
      observation.thread === coder.session?.id && observation.turn === coder.turn,
      'h06-legacy-live-writer-binding',
    );
    return { status: 'live', observedAt: Date.now(), observation };
  } catch {
    return { status: 'unknown', reason: 'observation-unconfirmed' };
  }
}

/** Stop the persisted child coder using the same app-server session owner that started it. */
export async function stopH06NativeLegacyWriter(
  store: LegacyStore,
  sessions: LegacySessions,
  request: Pick<LegacyControlBinding, 'workspaceRoot' | 'evidenceRoot' | 'phase'> & {
    paused: H04Pin;
    coderId: string;
  },
) {
  const workspace = safeDirectory(request.workspaceRoot);
  const evidence = safeDirectory(request.evidenceRoot);
  const { context } = store.grant;
  const { phase } = request;
  requireContract(phase === 'warm' || phase === 'cold', 'h06-legacy-writer-stop-phase');
  const state = () =>
    unwrap<TechnicalState>(
      store.execute({ context, command: { type: 'state', archive: 'current' } }),
    );
  const before = state();
  const identity = {
    workspace,
    store: store.root,
    evidence,
    context,
    generation: before.generation,
  };
  const paused = readPin(request.paused);
  const journal = new TaskChatContext(
    {
      async execute(command) {
        return store.execute(command);
      },
    },
    context,
    before.generation,
  );
  const current = await journal.read();
  const control = current.control;
  requireContract(
    request.paused.path === join(evidence, `legacy-${phase}-pause.json`) &&
      paused.kind === 'h06-native-legacy-pause' &&
      paused.phase === phase &&
      same(paused.identity, identity) &&
      control !== null &&
      control.status === 'paused' &&
      control.generation === before.generation &&
      control.observed.workspace === workspace &&
      paused.controlRevision === control.revision &&
      same(paused.control, control) &&
      paused.operation === 'chat:control:' + control.history.at(-1)?.id,
    'h06-legacy-writer-pause-binding',
  );
  const pauseAck = unwrap<OperationResult>(
    store.execute({ context, command: { type: 'operation', operation_id: paused.operation } }),
  );
  requireContract(
    pauseAck.status === 'confirmed' &&
      same(pauseAck.ack, paused.ack) &&
      pauseAck.ack.catalog_revision <= before.revision,
    'h06-legacy-writer-pause-ack',
  );
  const coder = coderBinding(current, store, workspace, request.coderId);
  const verifyRuntime = bindChatEvidence(store.root, evidence, before);
  function unchanged() {
    verifyRuntime();
    const latest = state();
    const effects = unwrap<EffectRecord[]>(
      store.execute({ context, command: { type: 'effects' } }),
    );
    requireContract(
      same(latest, before) &&
        latest.owner === context.actor_id &&
        !latest.released &&
        !latest.frozen &&
        Number.isSafeInteger(latest.lease_until) &&
        Date.now() < latest.lease_until &&
        store.grant.permissions.includes('manage') &&
        effects.every(({ outcome }) => outcome === 'confirmed' || outcome === 'not-started'),
      'h06-legacy-writer-stop-state',
    );
  }
  unchanged();
  const observed = await observeLegacyWriter(sessions, coder);
  unchanged();
  const paths = stopPaths(evidence, phase);
  const intent = pin(paths.intent, {
    kind: 'h06-native-legacy-writer-stop-intent',
    phase,
    identity,
    paused: request.paused,
    coder,
    parentTurn: control.observed.turn_id,
    liveness: observed,
  });
  const stopped = await sessions.stop(coder);
  const sameRuntime = await verifyCoderStop(stopped, coder, evidence, observed);
  unchanged();
  const liveness: LegacyLiveness =
    observed.status === 'live' && !sameRuntime
      ? { status: 'unknown', reason: 'stop-scope-changed' }
      : observed;
  const link = pin(paths.link, {
    kind: 'h06-native-legacy-writer-stop',
    phase,
    identity,
    intent,
    paused: request.paused,
    coderId: coder.brief.id,
    parentTurn: control.observed.turn_id,
    stopped,
    liveness,
  });
  return { stopped, intent, link, liveness };
}

/** Apply one native command to the existing Legacy Store. The caller owns the host and physical STOP. */
export async function runH06NativeLegacyControl(
  store: Pick<SqliteEvidenceStore, 'execute' | 'grant' | 'root'>,
  request: LegacyControlRequest,
) {
  const workspace = safeDirectory(request.workspaceRoot);
  const evidence = safeDirectory(request.evidenceRoot);
  const { event, phase } = request;
  const nativeSessions = realpathSync(
    resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
  );
  requireContract(
    request.transcript.startsWith(nativeSessions + sep) &&
      realpathSync(request.transcript) === request.transcript,
    'h06-legacy-control-native-transcript',
  );
  const { context } = store.grant;
  const state = () =>
    unwrap<TechnicalState>(
      store.execute({ context, command: { type: 'state', archive: 'current' } }),
    );
  const before = state();
  function owner(current: TechnicalState) {
    requireContract(
      current.owner === context.actor_id &&
        current.generation === event.generation &&
        !current.released &&
        !current.frozen &&
        Number.isSafeInteger(current.lease_until) &&
        Date.now() < current.lease_until,
      'h06-legacy-control-owner',
    );
  }
  owner(before);
  requireContract(
    (phase === 'warm' || phase === 'cold') &&
      (event.type === 'PAUSE' || event.type === 'RESUME') &&
      request.storeRevision === before.revision &&
      event.thread_id === context.actor_id &&
      request.anchor.thread_id === event.thread_id &&
      request.anchor.workspace === workspace &&
      store.grant.permissions.includes('manage'),
    'h06-legacy-control-binding',
  );
  const verifyRuntime = bindChatEvidence(store.root, evidence, before);
  const operation = 'chat:control:' + event.id;
  const journal = new TaskChatContext(
    {
      async execute(command) {
        verifyRuntime();
        if (command.command.type === 'mutate')
          requireContract(
            command.command.mutation.operation_id === operation &&
              command.command.mutation.expected_revision === before.revision,
            'h06-legacy-control-store-changed',
          );
        return store.execute(command);
      },
    },
    context,
    event.generation,
  );
  const current = await journal.read();
  const control = current.control;
  requireContract(
    control !== null &&
      control.status === (event.type === 'PAUSE' ? 'active' : 'paused') &&
      control.revision === event.expected_revision &&
      !control.history.some(({ id }) => id === event.id) &&
      control.generation === event.generation &&
      control.observed.workspace === workspace &&
      current.run.spec.project_id === context.project_id &&
      current.run.spec.run_id === context.run_id &&
      current.run.spec.session_id === context.actor_id &&
      current.run.generation === event.generation &&
      'task_id' in current.run.spec.identity &&
      current.run.spec.identity.task_id === context.task_id &&
      current.messages !== null &&
      current.messages.requirements_revision === request.requirementsRevision,
    'h06-legacy-control-context',
  );
  const hostIdentity = { pid: process.pid, startedAt: performance.timeOrigin };
  const identity = {
    workspace,
    store: store.root,
    evidence,
    context,
    generation: event.generation,
  };
  const receiptPath = (action: string) => join(evidence, `legacy-${phase}-${action}.json`);
  let stoppedCoder: CoderRun | null = null;
  if (event.type === 'RESUME') {
    requireContract('paused' in request && event.stopped !== undefined, 'h06-legacy-control-stop');
    const paused = object(JSON.parse(readH04Pin(request.paused).toString()));
    const previousHost = object(paused.host);
    requireContract(
      request.paused.path === receiptPath('pause') &&
        paused.kind === 'h06-native-legacy-pause' &&
        paused.phase === phase &&
        same(paused.identity, identity) &&
        paused.controlRevision === control.revision &&
        paused.operation === 'chat:control:' + control.history.at(-1)?.id &&
        Number.isSafeInteger(previousHost.pid) &&
        Number(previousHost.pid) > 1 &&
        typeof previousHost.startedAt === 'number' &&
        Number.isFinite(previousHost.startedAt) &&
        (phase === 'warm' ? same(previousHost, hostIdentity) : !same(previousHost, hostIdentity)),
      'h06-legacy-control-handoff',
    );
    if (phase === 'cold') {
      let absent = false;
      try {
        process.kill(Number(previousHost.pid), 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        absent = true;
      }
      requireContract(absent, 'h06-legacy-control-old-host-active');
    }
    const link = readPin(request.stoppedBy);
    const paths = stopPaths(evidence, phase);
    const intent = object(link.intent);
    requireContract(
      request.stoppedBy.path === paths.link &&
        intent.path === paths.intent &&
        typeof intent.sha256 === 'string' &&
        link.kind === 'h06-native-legacy-writer-stop' &&
        link.phase === phase &&
        same(link.identity, identity) &&
        same(link.paused, request.paused) &&
        link.parentTurn === control.observed.turn_id &&
        same(link.stopped, event.stopped),
      'h06-legacy-control-stop-link',
    );
    const prepared = readPin({ path: paths.intent, sha256: intent.sha256 });
    stoppedCoder = coderBinding(current, store, workspace, identifier(link.coderId));
    requireContract(
      prepared.kind === 'h06-native-legacy-writer-stop-intent' &&
        prepared.phase === phase &&
        same(prepared.identity, identity) &&
        same(prepared.paused, request.paused) &&
        same(prepared.coder, stoppedCoder) &&
        prepared.parentTurn === control.observed.turn_id,
      'h06-legacy-control-stop-link',
    );
  }
  function unchanged() {
    verifyRuntime();
    const current = state();
    owner(current);
    requireContract(same(current, before), 'h06-legacy-control-store-changed');
    const effects = unwrap<EffectRecord[]>(
      store.execute({ context, command: { type: 'effects' } }),
    );
    requireContract(
      effects.every(({ outcome }) => outcome === 'confirmed' || outcome === 'not-started'),
      'h06-legacy-control-effect-unknown',
    );
  }
  const host = new FileCurrentChatHost(workspace, request.transcript, request.anchor);
  const inputs = fileRunInputs(workspace, request.descriptor);
  const recovery = new FileChatRecovery(workspace, evidence, journal, new NativeWriterProcesses());
  unchanged();
  const { next } = await prepareChatControl(
    event,
    current,
    host,
    inputs,
    {
      settled: () => recovery.settled(),
      async stopped(ref, thread, turn) {
        requireContract(
          stoppedCoder !== null &&
            event.type === 'RESUME' &&
            same(ref, event.stopped) &&
            thread === context.actor_id &&
            turn === control.observed.turn_id,
          'h06-legacy-control-stop-link',
        );
        await verifyCoderStop(ref, stoppedCoder, evidence);
      },
    },
    new NativeUserCommands(workspace),
  );
  unchanged();
  const revision = event.expected_revision + 1;
  requireContract(
    next.control?.revision === revision &&
      next.control.history.at(-1)?.id === event.id &&
      (event.type === 'PAUSE'
        ? next.control.status === 'paused' && next.run.loaded === null
        : next.control.status === 'active' && next.run.loaded !== null),
    'h06-legacy-control-result',
  );
  const action = event.type === 'PAUSE' ? 'pause' : 'resume';
  const intent = pin(join(evidence, `legacy-${phase}-${action}-intent.json`), {
    kind: 'h06-native-legacy-control-intent',
    phase,
    identity,
    host: hostIdentity,
    event,
    operation,
    storeRevision: before.revision,
    requirementsRevision: request.requirementsRevision,
    ...('stoppedBy' in request ? { stoppedBy: request.stoppedBy } : {}),
  });
  await journal.save(current, next, operation);
  const result = unwrap<OperationResult>(
    store.execute({ context, command: { type: 'operation', operation_id: operation } }),
  );
  const after = state();
  owner(after);
  requireContract(
    result.status === 'confirmed' &&
      result.ack.operation_id === operation &&
      result.ack.generation === event.generation &&
      result.ack.catalog_revision === before.revision + 1 &&
      after.revision === result.ack.catalog_revision,
    'h06-legacy-control-ack-unknown',
  );
  const receipt = pin(receiptPath(action), {
    kind: `h06-native-legacy-${action}`,
    phase,
    identity,
    host: hostIdentity,
    intent,
    event,
    operation,
    controlRevision: revision,
    ack: result.ack,
    control: next.control,
    load: next.run.loaded,
  });
  return { intent, receipt };
}
