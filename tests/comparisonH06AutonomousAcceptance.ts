import { lstatSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual as same } from 'node:util';
import type { AppServerCoderSessions } from '../adapters/codex/appServerCoder.js';
import { FileChatRecovery } from '../adapters/project/chatRecovery.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { bindChatEvidence } from '../adapters/storage/chatWriter.js';
import { unwrap, type SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { localLocator } from '../core/connection.js';
import { validateCoderRun, type CoderRun } from '../core/coder.js';
import type { EffectRecord, OperationResult, TechnicalState } from '../core/evidence.js';
import { confirmLoad, type LoadReceipt } from '../core/localRun.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  h06DelegatedStages,
  openH06DelegatedPhaseLedger,
  readH06DelegatedAuthority,
} from './comparisonH06DelegatedAuthority.js';
import type { H06DelegatedStoppedWriter } from './comparisonH06DelegatedLegacy.js';
import { observeH06DelegatedUsage } from './comparisonH06DelegatedUsage.js';
import { verifyCoderStop } from './comparisonH06NativeLegacyControl.js';
import { observeH06NativeLegacyTranscript } from './comparisonH06NativeLegacyUsage.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';
import { verifyH06RetainedWarmContinuation } from './comparisonH06RetainedWarmContinuation.js';

const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
type Store = Pick<SqliteEvidenceStore, 'execute' | 'grant' | 'root'>;
type Live = Awaited<ReturnType<AppServerCoderSessions['observeLiveWriter']>>;

function retainedLoad(value: unknown, sessionsRoot: string, actor: string, run: string) {
  const load = object(value);
  requireContract(
    load.session_id === actor &&
      load.run_id === run &&
      Array.isArray(load.rules) &&
      load.rules.length > 0 &&
      Array.isArray(load.procedures) &&
      load.procedures.length > 0 &&
      typeof load.observed_read === 'string',
    'h06-autonomous-load',
  );
  const refs: unknown = JSON.parse(load.observed_read);
  requireContract(Array.isArray(refs) && refs.length > 0, 'h06-autonomous-load');
  for (const value of refs) {
    const ref = object(value),
      match = /^(.*)#L([1-9]\d*)$/u.exec(String(ref.locator));
    requireContract(
      match !== null && match[1]!.startsWith(sessionsRoot + sep),
      'h06-autonomous-load-source',
    );
    const lines = readH06NativeJournal(match[1]!).toString().split('\n'),
      line = lines[Number(match[2]) - 1];
    requireContract(
      typeof line === 'string' && digest(line + '\n') === ref.hash,
      'h06-autonomous-load-source',
    );
  }
}

/** Independent retained readback of the explicitly selected autonomous recovery profile. */
export async function verifyH06AutonomousAcceptance(input: { claim: H04Pin }, store: Store) {
  const claim = readH06DelegatedAuthority(input.claim),
    { request } = claim,
    { context } = store.grant;
  const bootstrap = read(request.bootstrap);
  requireContract(
    store.root === join(request.evidenceRoot, 'legacy-store') &&
      context.actor_id === claim.actorId &&
      context.project_id === bootstrap.projectId &&
      typeof context.run_id === 'string' &&
      context.run_id === bootstrap.runId &&
      context.task_id === request.binding.operationId,
    'h06-autonomous-store',
  );
  const state = () =>
    unwrap<TechnicalState>(
      store.execute({ context, command: { type: 'state', archive: 'current' } }),
    );
  const before = structuredClone(state());
  requireContract(
    before.owner === claim.actorId &&
      before.generation === claim.generation &&
      !before.frozen &&
      !before.released,
    'h06-autonomous-owner',
  );
  const verifyRuntime = bindChatEvidence(store.root, request.evidenceRoot, before);
  const ledger = structuredClone(openH06DelegatedPhaseLedger(input.claim).inspect());
  requireContract(
    ledger.status === 'RECORDED' &&
      same(
        ledger.phases.map((p) => p.phase.stage),
        h06DelegatedStages,
      ) &&
      ledger.phases.every((p) => p.outcome !== null),
    'h06-autonomous-phases',
  );
  const records = ledger.phases.map((entry) => {
    const outcome = read(h04Pin(read(entry.outcome!).outcome)),
      resultPin = h04Pin(outcome.result),
      result = read(resultPin);
    requireContract(
      same(outcome.claim, input.claim) &&
        same(outcome.intent, entry.intent) &&
        outcome.stage === entry.phase.stage &&
        outcome.status === 'confirmed' &&
        same(result.claim, input.claim) &&
        same(result.phase, entry.intent) &&
        same(result.delivery, outcome.delivery),
      'h06-autonomous-result',
    );
    return { entry, result, outcome, resultPin };
  });
  for (const { entry, result } of records) {
    if (entry.phase.stage === 'warm-resume') continue;
    requireContract(
      result.retainedContinuations === undefined ||
        (Array.isArray(result.retainedContinuations) && result.retainedContinuations.length === 0),
      'h06-autonomous-retained-stage',
    );
  }
  const warmResume = records[2]!,
    retainedProofs = warmResume.result.retainedContinuations;
  requireContract(
    Array.isArray(retainedProofs) && retainedProofs.length === 1,
    'h06-autonomous-retained-required',
  );
  const retainedProof = h04Pin(retainedProofs[0]);
  readH04Pin(retainedProof);
  const retained = await verifyH06RetainedWarmContinuation({
    claim: input.claim,
    proof: retainedProof,
  });
  const resumedHost = object(warmResume.result.host),
    pausedHost = object(records[1]!.result.host);
  requireContract(
    same(retained.phase, warmResume.entry.intent) &&
      same(retained.delivery, warmResume.outcome.delivery) &&
      same(
        [retained.host.pid, retained.host.startedAt],
        [resumedHost.pid, resumedHost.startedAt],
      ) &&
      same([retained.host.pid, retained.host.startedAt], [pausedHost.pid, pausedHost.startedAt]),
    'h06-autonomous-retained-binding',
  );
  const load = records[0]!.result,
    prepared = object(load.prepared),
    ready = object(prepared.ready),
    readyRun = object(ready.run);
  requireContract(
    load.kind === 'h06-delegated-load-result/1' && readyRun.status === 'ready',
    'h06-autonomous-load',
  );
  retainedLoad(readyRun.loaded, claim.grant.sessionsRoot, claim.actorId, context.run_id);
  const journal = new TaskChatContext(
    { execute: async (value) => store.execute(value) },
    context,
    claim.generation,
  );
  const current = await journal.read(),
    control = current.control;
  requireContract(
    control !== null &&
      control.status === 'active' &&
      control.generation === claim.generation &&
      control.revision === 4 &&
      control.history.length === 4 &&
      current.run.generation === claim.generation &&
      current.run.spec.session_id === claim.actorId &&
      current.run.spec.run_id === context.run_id &&
      current.run.spec.project_id === context.project_id &&
      current.run.spec.workspace === request.binding.workspaceRoot,
    'h06-autonomous-current',
  );
  const coders = current.workflow.coders;
  requireContract(same(readyRun.spec, current.run.spec), 'h06-autonomous-load-spec');
  confirmLoad(current.run, readyRun.loaded as LoadReceipt);
  requireContract(
    coders !== undefined && Object.keys(coders).length === 3,
    'h06-autonomous-coders',
  );
  const stopped: H06DelegatedStoppedWriter[] = [],
    hosts: unknown[] = [],
    controlResults = records.slice(1, 5);
  for (const [index, { entry, result, resultPin }] of controlResults.entries()) {
    const stage = entry.phase.stage,
      event = object(result.event),
      paused = stage.endsWith('pause'),
      operation = 'chat:control:' + entry.phase.nonce;
    const ack = unwrap<OperationResult>(
      store.execute({ context, command: { type: 'operation', operation_id: operation } }),
    );
    requireContract(
      resultPin.path === join(request.evidenceRoot, `delegated-${stage}-result.json`) &&
        result.kind === 'h06-delegated-control-result/1' &&
        same(result.context, context) &&
        result.operation === operation &&
        event.id === entry.phase.nonce &&
        event.type === (paused ? 'PAUSE' : 'RESUME') &&
        event.thread_id === claim.actorId &&
        event.generation === claim.generation &&
        event.expected_revision === index &&
        same(event.source, {
          locator: object(result.delivery).path,
          hash: object(result.delivery).sha256,
        }) &&
        control.history[index]!.id === event.id &&
        same(JSON.parse(control.history[index]!.payload), event) &&
        ack.status === 'confirmed' &&
        same(ack.ack, result.ack) &&
        ack.ack.generation === claim.generation &&
        ack.ack.operation_id === operation &&
        ack.ack.catalog_revision === entry.phase.storeRevision + 1 &&
        ack.ack.catalog_revision <= before.revision,
      'h06-autonomous-control',
    );
    const saved = object(result.control),
      history = saved.history;
    requireContract(
      saved.status === (paused ? 'paused' : 'active') &&
        saved.revision === index + 1 &&
        Array.isArray(history) &&
        same(history, control.history.slice(0, index + 1)),
      'h06-autonomous-control',
    );
    const host = object(result.host);
    requireContract(
      Number.isSafeInteger(host.pid) &&
        Number(host.pid) > 1 &&
        typeof host.startedAt === 'number' &&
        Number.isFinite(host.startedAt) &&
        host.startedAt > 0,
      'h06-autonomous-host',
    );
    hosts.push(host);
    if (paused) {
      requireContract(result.load === null, 'h06-autonomous-paused-load');
      const writer = object(result.writer) as unknown as H06DelegatedStoppedWriter;
      validateCoderRun(writer.coder);
      const coder = writer.coder,
        retired = coders[coder.brief.id];
      requireContract(
        coder.status === 'running' &&
          coder.brief.source_root === request.binding.workspaceRoot &&
          coder.brief.parent_session_id === claim.actorId &&
          coder.brief.parent_run_id === context.run_id &&
          coder.brief.generation === claim.generation &&
          retired !== undefined &&
          retired.status === 'cancelled' &&
          same(retired.brief, coder.brief) &&
          same(retired.history.slice(0, coder.history.length), coder.history) &&
          same(retired.stopped, writer.stopped),
        'h06-autonomous-retired',
      );
      validateCoderRun(retired);
      const live = read(h04Pin(writer.live)),
        observation = object(live.observation) as unknown as Live;
      requireContract(
        same(live.claim, input.claim) &&
          live.phase === stage.replace('-pause', '') &&
          same(live.writer, coder) &&
          typeof live.observedAt === 'number' &&
          live.observedAt >= claim.startedAt &&
          live.observedAt <= Date.now() &&
          observation.thread === coder.session?.id &&
          observation.turn === coder.turn &&
          object(object(observation.native).active).id === coder.turn &&
          object(object(observation.native).active).status === 'inProgress',
        'h06-autonomous-live',
      );
      requireContract(
        await verifyCoderStop(writer.stopped, coder, request.evidenceRoot, {
          status: 'live',
          observedAt: live.observedAt,
          observation,
        }),
        'h06-autonomous-stop',
      );
      stopped.push(writer);
    } else {
      const previous = stopped.at(-1)!;
      requireContract(
        same(result.writer, previous) &&
          same(event.stopped, previous.stopped) &&
          same(event.authorization, event.source),
        'h06-autonomous-resume',
      );
      retainedLoad(result.load, claim.grant.sessionsRoot, claim.actorId, context.run_id);
      confirmLoad(current.run, result.load as LoadReceipt);
    }
  }
  requireContract(
    same(hosts[0], hosts[1]) && same(hosts[1], hosts[2]) && !same(hosts[2], hosts[3]),
    'h06-autonomous-restart',
  );
  let absent = false;
  try {
    process.kill(Number(object(hosts[2]).pid), 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    absent = true;
  }
  requireContract(absent, 'h06-autonomous-old-host-active');
  const completion = records[5]!.result,
    completed = object(completion.completed),
    completionCoder = h04Pin(completed.coder),
    final = read(completionCoder) as unknown as CoderRun;
  validateCoderRun(final);
  requireContract(
    completion.kind === 'h06-delegated-completion-result/1' &&
      same(completion.resumed, {
        intent: object(records[4]!.result).intent,
        receipt: records[4]!.resultPin,
      }) &&
      final.status === 'integrated' &&
      same(coders[final.brief.id], final) &&
      !stopped.some((w) => w.coder.brief.id === final.brief.id) &&
      final.brief.parent_session_id === claim.actorId &&
      final.brief.parent_run_id === context.run_id &&
      final.brief.source_root === request.binding.workspaceRoot &&
      final.brief.generation === claim.generation &&
      final.integration !== null &&
      final.stopped !== null &&
      final.receipt !== null &&
      same(control, records[4]!.result.control) &&
      same(current.run.loaded, records[4]!.result.load),
    'h06-autonomous-completion',
  );
  const completionIntent = read(h04Pin(completed.intent)),
    brief = h04Pin(completionIntent.brief);
  requireContract(
    same(completionIntent.claim, input.claim) &&
      same(completionIntent.phase, records[5]!.entry.intent) &&
      same(completionIntent.delivery, completion.delivery) &&
      same(completionIntent.coldResume, records[4]!.resultPin) &&
      request.runtime.some((p) => same(p, brief)) &&
      same(read(brief), final.brief),
    'h06-autonomous-completion-intent',
  );
  readH04Pin({ path: final.receipt.locator, sha256: final.receipt.hash });
  await verifyCoderStop(final.stopped, final, request.evidenceRoot);
  for (const change of final.integration.changes) {
    const path = join(request.binding.workspaceRoot, localLocator(change.path));
    if (change.after === null)
      requireContract(
        lstatSync(path, { throwIfNoEntry: false }) === undefined,
        'h06-autonomous-integration',
      );
    else
      requireContract(
        digest(h01RawFile(path)) === change.after.content.hash &&
          (statSync(path).mode & 0o777) === change.after.mode,
        'h06-autonomous-integration',
      );
  }
  const finalThread = h04Pin(completed.thread),
    thread = object(read(finalThread).thread);
  requireContract(
    thread.id === final.session?.id &&
      thread.cwd === final.brief.copy_root &&
      Array.isArray(thread.turns) &&
      typeof thread.path === 'string' &&
      thread.path.startsWith(claim.grant.sessionsRoot + sep),
    'h06-autonomous-final-thread',
  );
  requireContract(
    observeH06NativeLegacyTranscript(readH06NativeJournal(thread.path), thread, {
      thread: identifier(thread.id),
      turns: thread.turns.map((t) => ({ turn: identifier(object(t).id) })),
      completed: true,
    }) !== null,
    'h06-autonomous-final-turn',
  );
  const previousThreads = completionIntent.previousThreads;
  requireContract(
    Array.isArray(previousThreads) && previousThreads.length === 2,
    'h06-autonomous-thread-inventory',
  );
  const managedUsage = await observeH06DelegatedUsage({
    claim: input.claim,
    threads: [h04Pin(previousThreads[0]), h04Pin(previousThreads[1]), finalThread],
  });
  const effects = unwrap<EffectRecord[]>(store.execute({ context, command: { type: 'effects' } }));
  requireContract(
    effects.every((e) => e.outcome === 'confirmed' || e.outcome === 'not-started'),
    'h06-autonomous-effects',
  );
  await new FileChatRecovery(
    request.binding.workspaceRoot,
    request.evidenceRoot,
    journal,
    new NativeWriterProcesses(),
  ).settled();
  verifyRuntime();
  readH06DelegatedAuthority(input.claim);
  requireContract(
    same(before, state()) && same(ledger, openH06DelegatedPhaseLedger(input.claim).inspect()),
    'h06-autonomous-readback-changed',
  );
  const managed =
    managedUsage.status === 'WITHIN_BUDGET'
      ? 'PASS'
      : managedUsage.status === 'OVER_BUDGET'
        ? 'FAIL'
        : 'UNKNOWN';
  return {
    profile: 'h06-autonomous-recovery/3' as const,
    status: managed,
    criteria: {
      loadReady: 'PASS',
      warmStop: 'PASS',
      warmResume: 'PASS',
      coldStop: 'PASS',
      coldResume: 'PASS',
      integratedWriter: 'PASS',
      managedUsage: managed,
    },
    claim: input.claim,
    evidence: {
      phases: records.map(({ entry, resultPin }) => ({
        stage: entry.phase.stage,
        intent: entry.intent,
        settlement: entry.outcome,
        result: resultPin,
      })),
      completionCoder,
      completionThread: finalThread,
      storeRevision: before.revision,
      generation: before.generation,
    },
    managedUsage,
    humanControl: 'NOT_EVALUATED' as const,
    externalUsage: 'UNKNOWN' as const,
    wholeAttemptComplete: false as const,
    qualification: false as const,
  };
}
