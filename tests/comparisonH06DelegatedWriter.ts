import { join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual as same } from 'node:util';
import { unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  cancelCoder,
  integrateCoder,
  launchCoder,
  runCoder,
  startCoder,
} from '../application/coderWorkflow.js';
import {
  validateCoderBrief,
  validateCoderRun,
  type CoderBrief,
  type CoderRun,
} from '../core/coder.js';
import type { OperationResult, TechnicalState } from '../core/evidence.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  openH06DelegatedPhaseLedger,
  readH06DelegatedAuthority,
} from './comparisonH06DelegatedAuthority.js';
import type { H06DelegatedStoppedWriter } from './comparisonH06DelegatedLegacy.js';
import { enforceH06LegacyBudget } from './comparisonH06NativeLegacyBudget.js';
import { verifyCoderStop } from './comparisonH06NativeLegacyControl.js';
import {
  withH06LegacyCoderRuntime,
  type H06LegacyCoderRuntime,
} from './comparisonH06NativeLegacyTransportPhase.js';

type Runtime = H06LegacyCoderRuntime;
type Store = Runtime['store'];
type Claim = ReturnType<typeof readH06DelegatedAuthority>;
type ControlResult = { intent: H04Pin; receipt: H04Pin };

export interface H06DelegatedWriterInput {
  claim: H04Pin;
  brief: H04Pin;
  phase: 'warm' | 'cold';
  previousResume: H04Pin | null;
  previousThreads: H04Pin[];
}

export interface H06DelegatedCompletionInput {
  claim: H04Pin;
  phase: H04Pin;
  delivery: H04Pin;
  brief: H04Pin;
  coldResume: H04Pin;
  previousThreads: H04Pin[];
}

export interface H06DelegatedWriterOptions {
  store: Store;
  signal?: AbortSignal;
  awaitControl(
    stage: 'warm-pause' | 'cold-pause',
    writer: CoderRun,
    stopWriter: () => Promise<H06DelegatedStoppedWriter>,
    signal: AbortSignal,
  ): Promise<ControlResult>;
}

function read(pin: H04Pin) {
  return object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
}

function save(path: string, value: unknown): H04Pin {
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

function binding(claimPin: H04Pin, briefPin: H04Pin, store: Store) {
  const claim = readH06DelegatedAuthority(claimPin),
    { request } = claim,
    { context } = store.grant;
  const bootstrap = read(request.bootstrap);
  requireContract(
    request.binding.variant === 'legacy' &&
      process.env.CODEX_THREAD_ID === claim.actorId &&
      context.actor_id === claim.actorId &&
      context.project_id === bootstrap.projectId &&
      context.run_id === bootstrap.runId &&
      context.task_id === request.binding.operationId &&
      store.root === join(request.evidenceRoot, 'legacy-store') &&
      request.runtime.some((pin) => same(pin, briefPin)),
    'h06-delegated-writer-binding',
  );
  const brief = read(briefPin) as unknown as CoderBrief;
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
        context.project_id,
        context.task_id,
        context.run_id,
        claim.actorId,
        request.binding.workspaceRoot,
        claim.generation,
      ],
    ) && brief.copy_root === join(request.evidenceRoot, 'coder-workspaces', brief.id),
    'h06-delegated-writer-brief',
  );
  return { claim, brief };
}

function previousThreads(claim: Claim, pins: H04Pin[], labels: ('warm' | 'cold')[]) {
  requireContract(pins.length === labels.length, 'h06-delegated-writer-threads');
  const previous = new Map<string, Record<string, unknown>>();
  pins.forEach((pin, index) => {
    const snapshot = read(pin),
      id = identifier(object(snapshot.thread).id);
    requireContract(
      pin.path ===
        join(claim.request.evidenceRoot, `delegated-${labels[index]}-writer-thread.json`) &&
        !previous.has(id),
      'h06-delegated-writer-threads',
    );
    previous.set(id, snapshot);
  });
  return previous;
}

function settled(claim: H04Pin, stage: 'load' | 'warm-resume' | 'cold-resume') {
  const phases = openH06DelegatedPhaseLedger(claim).inspect().phases,
    last = phases.at(-1);
  requireContract(
    last?.phase.stage === stage && last.outcome !== null,
    'h06-delegated-writer-order',
  );
  return { phases, last, outcome: read(h04Pin(read(last.outcome).outcome)) };
}

async function retire(
  claimPin: H04Pin,
  claim: Claim,
  resume: H04Pin,
  phase: 'warm' | 'cold',
  brief: CoderBrief,
  runtime: Runtime,
  snapshots: Map<string, Record<string, unknown>>,
) {
  const resumed = read(resume),
    { context } = runtime.store.grant,
    event = object(resumed.event);
  const operation = 'chat:control:' + identifier(event.id);
  const recorded = unwrap<OperationResult>(
    runtime.store.execute({ context, command: { type: 'operation', operation_id: operation } }),
  );
  const state = unwrap<TechnicalState>(
    runtime.store.execute({ context, command: { type: 'state', archive: 'current' } }),
  );
  const control = object(object(state.checkpoint).chat_control);
  const stoppedWriter = object(resumed.writer) as unknown as H06DelegatedStoppedWriter;
  validateCoderRun(stoppedWriter.coder);
  const { coder, stopped } = stoppedWriter;
  requireContract(
    resume.path === join(claim.request.evidenceRoot, `delegated-${phase}-resume-result.json`) &&
      resumed.kind === 'h06-delegated-control-result/1' &&
      same(resumed.claim, claimPin) &&
      same(resumed.context, context) &&
      event.type === 'RESUME' &&
      event.thread_id === claim.actorId &&
      event.generation === claim.generation &&
      resumed.operation === operation &&
      recorded.status === 'confirmed' &&
      recorded.ack.operation_id === operation &&
      same(recorded.ack, resumed.ack) &&
      state.revision === recorded.ack.catalog_revision &&
      state.generation === claim.generation &&
      control.status === 'active' &&
      same(control, resumed.control) &&
      coder.status === 'running' &&
      coder.brief.id !== brief.id &&
      coder.brief.parent_session_id === claim.actorId &&
      coder.brief.parent_run_id === context.run_id &&
      coder.brief.project_id === context.project_id &&
      coder.brief.task_id === context.task_id &&
      coder.brief.generation === claim.generation &&
      coder.brief.source_root === claim.request.binding.workspaceRoot &&
      same(event.stopped, stopped) &&
      coder.session !== null &&
      snapshots.has(coder.session.id) &&
      same((await runtime.coder.journal.read()).coders?.[coder.brief.id], coder),
    'h06-delegated-writer-resume',
  );
  await verifyCoderStop(stopped, coder, claim.request.evidenceRoot);
  const retired = await cancelCoder(coder.brief.id, {
    ...runtime.coder,
    sessions: { ...runtime.coder.sessions, stop: async () => stopped },
  });
  requireContract(retired.status === 'cancelled', 'h06-delegated-writer-retire');
}

async function snapshot(
  runtime: Runtime,
  claim: Claim,
  writer: CoderRun,
  label: 'warm' | 'cold' | 'completion',
) {
  requireContract(writer.session !== null && writer.turn !== null, 'h06-delegated-writer-session');
  const response = object(
      await runtime.rpc.request('thread/read', { threadId: writer.session.id, includeTurns: true }),
    ),
    thread = object(response.thread),
    turns = thread.turns;
  requireContract(
    thread.id === writer.session.id &&
      thread.cwd === writer.brief.copy_root &&
      Array.isArray(turns) &&
      turns.length === 3,
    'h06-delegated-writer-snapshot',
  );
  const ids = turns.map((entry, index) => {
    const turn = object(entry),
      id = identifier(turn.id),
      label = ['profile', 'load', 'implementation'][index]!;
    requireContract(Array.isArray(turn.items), 'h06-delegated-writer-snapshot');
    const users = turn.items.map(object).filter((item) => item.type === 'userMessage');
    requireContract(
      users.length === 1 && Array.isArray(users[0]!.content) && users[0]!.content.length === 1,
      'h06-delegated-writer-snapshot',
    );
    const part = object(users[0]!.content[0]);
    requireContract(
      part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.startsWith(
          `Workflow delivery id: ${JSON.stringify(`coder:${writer.brief.id}:${label}`)}\n`,
        ) &&
        (index < 2 || writer.status === 'integrated'
          ? turn.status === 'completed'
          : ['completed', 'failed', 'interrupted'].includes(String(turn.status))),
      'h06-delegated-writer-snapshot',
    );
    return id;
  });
  requireContract(
    new Set(ids).size === 3 && ids.at(-1) === writer.turn,
    'h06-delegated-writer-snapshot',
  );
  return save(join(claim.request.evidenceRoot, `delegated-${label}-writer-thread.json`), response);
}

async function owned<T>(runtime: Runtime, work: (signal: AbortSignal) => Promise<T>) {
  const outcome = await Promise.resolve()
    .then(() => runtime.runWithinWork(work))
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  try {
    await runtime.stop(runtime.closeOwned);
  } catch (cleanup) {
    if (!outcome.ok)
      throw new AggregateError([outcome.error, cleanup], 'h06-delegated-writer-and-stop-failed');
    throw cleanup;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Start one retained Writer; the caller applies PAUSE with the supplied physical STOP callback. */
export async function runDelegatedWriterPhase(
  input: H06DelegatedWriterInput,
  options: H06DelegatedWriterOptions,
) {
  const { claim, brief } = binding(input.claim, input.brief, options.store),
    { phase } = input;
  requireContract(phase === 'warm' || phase === 'cold', 'h06-delegated-writer-phase');
  const previous = settled(input.claim, phase === 'warm' ? 'load' : 'warm-resume');
  requireContract(
    phase === 'warm'
      ? input.previousResume === null
      : same(previous.outcome.result, input.previousResume),
    'h06-delegated-writer-order',
  );
  const snapshots = previousThreads(claim, input.previousThreads, phase === 'warm' ? [] : ['warm']);
  return withH06LegacyCoderRuntime(
    claim,
    options.store,
    phase === 'warm' ? 'create' : 'reopen',
    snapshots,
    (current, mode) =>
      enforceH06LegacyBudget(current, mode, current.grant.sessionsRoot, 'append-only'),
    (runtime) =>
      owned(runtime, async (work) => {
        const signal =
          options.signal === undefined ? work : AbortSignal.any([work, options.signal]);
        const working = () => {
          signal.throwIfAborted();
          readH06DelegatedAuthority(input.claim);
          readH04Pin(input.brief);
        };
        working();
        const intent = save(
          join(claim.request.evidenceRoot, `delegated-${phase}-writer-intent.json`),
          input,
        );
        if (phase === 'cold') {
          await retire(
            input.claim,
            claim,
            input.previousResume!,
            'warm',
            brief,
            runtime,
            snapshots,
          );
          working();
        }
        await startCoder(brief, runtime.coder);
        working();
        const writer = await launchCoder(brief.id, runtime.coder);
        requireContract(
          writer.status === 'running' && same(writer.brief, brief),
          'h06-delegated-writer-not-running',
        );
        const observation = await runtime.coder.sessions.observeLiveWriter(writer);
        requireContract(
          observation.thread === writer.session?.id && observation.turn === writer.turn,
          'h06-delegated-writer-observation',
        );
        working();
        const live = save(join(claim.request.evidenceRoot, `delegated-${phase}-writer-live.json`), {
          claim: input.claim,
          phase,
          writer,
          observation,
          observedAt: Date.now(),
        });
        let stoppedWriter: H06DelegatedStoppedWriter | undefined;
        let stopping = false;
        const stopWriter = async () => {
          requireContract(!stopping, 'h06-delegated-writer-stop-repeated');
          stopping = true;
          working();
          const stopped = await runtime.coder.sessions.stop(writer);
          requireContract(
            await verifyCoderStop(stopped, writer, claim.request.evidenceRoot, {
              status: 'live',
              observedAt: Date.now(),
              observation,
            }),
            'h06-delegated-writer-stop-runtime',
          );
          stoppedWriter = { coder: writer, stopped, live };
          return stoppedWriter;
        };
        const pause = await options.awaitControl(`${phase}-pause`, writer, stopWriter, signal);
        working();
        requireContract(stoppedWriter !== undefined, 'h06-delegated-writer-stop-missing');
        const receipt = read(pause.receipt);
        requireContract(
          receipt.kind === 'h06-delegated-control-result/1' &&
            same(receipt.claim, input.claim) &&
            object(receipt.event).type === 'PAUSE' &&
            same(receipt.writer, stoppedWriter),
          'h06-delegated-writer-pause',
        );
        readH04Pin(pause.intent);
        const coder = save(
          join(claim.request.evidenceRoot, `delegated-${phase}-writer-coder.json`),
          writer,
        );
        const thread = await snapshot(runtime, claim, writer, phase);
        return { intent, live, coder, thread, stopped: stoppedWriter.stopped, pause, writer };
      }),
    options.signal,
  );
}

/** Finish a separate third Writer under the retained, confirmed cold RESUME delivery. */
export async function runDelegatedCompletion(
  input: H06DelegatedCompletionInput,
  options: { store: Store; signal?: AbortSignal },
) {
  const { claim, brief } = binding(input.claim, input.brief, options.store);
  const phases = openH06DelegatedPhaseLedger(input.claim).inspect().phases,
    pending = phases.at(-1),
    prior = phases.at(-2);
  requireContract(
    pending?.phase.stage === 'completion' &&
      pending.outcome === null &&
      same(pending.intent, input.phase) &&
      prior?.phase.stage === 'cold-resume' &&
      prior.outcome !== null &&
      same(pending.phase.predecessor, prior.outcome),
    'h06-delegated-completion-order',
  );
  const resumed = read(h04Pin(read(prior.outcome).outcome));
  requireContract(
    same(resumed.delivery, input.delivery) && same(resumed.result, input.coldResume),
    'h06-delegated-completion-delivery',
  );
  const snapshots = previousThreads(claim, input.previousThreads, ['warm', 'cold']);
  return withH06LegacyCoderRuntime(
    claim,
    options.store,
    'reopen',
    snapshots,
    (current, mode) =>
      enforceH06LegacyBudget(current, mode, current.grant.sessionsRoot, 'append-only'),
    (runtime) =>
      owned(runtime, async (work) => {
        const signal =
          options.signal === undefined ? work : AbortSignal.any([work, options.signal]);
        const working = () => {
          signal.throwIfAborted();
          readH06DelegatedAuthority(input.claim);
          readH04Pin(input.brief);
        };
        working();
        const intent = save(
          join(claim.request.evidenceRoot, 'delegated-completion-intent.json'),
          input,
        );
        await retire(input.claim, claim, input.coldResume, 'cold', brief, runtime, snapshots);
        working();
        await startCoder(brief, runtime.coder);
        working();
        const completed = await runCoder(brief.id, runtime.coder);
        requireContract(completed.status === 'released', 'h06-delegated-completion-result');
        working();
        const integrated = await integrateCoder(brief.id, runtime.coder);
        validateCoderRun(integrated);
        requireContract(
          integrated.status === 'integrated' && same(integrated.brief, brief),
          'h06-delegated-completion-integration',
        );
        working();
        const coder = save(
          join(claim.request.evidenceRoot, 'delegated-completion-writer-coder.json'),
          integrated,
        );
        const thread = await snapshot(runtime, claim, integrated, 'completion');
        return { intent, coder, thread };
      }),
    options.signal,
  );
}
