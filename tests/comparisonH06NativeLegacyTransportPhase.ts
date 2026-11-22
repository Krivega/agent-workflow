import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import type { AppServerCoderSessions } from '../adapters/codex/appServerCoder.js';
import type { AppServerRpc, StdioAppServer } from '../adapters/codex/appServerTransport.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import { FileCoderWorkspaces } from '../adapters/project/coderWorkspaces.js';
import { bindChatEvidence, withChatWriter } from '../adapters/storage/chatWriter.js';
import { TaskLocalRuns } from '../adapters/storage/localRunStores.js';
import { backupSupervision } from '../adapters/storage/supervisionBackup.js';
import { unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { cancelCoder, integrateCoder, runCoder, startCoder } from '../application/coderWorkflow.js';
import { openNativeCoderSessions } from '../cli/nativeCoderSessions.js';
import {
  assertCoderParent,
  validateCoderBrief,
  validateCoderRun,
  type CoderBrief,
  type CoderRun,
} from '../core/coder.js';
import type { OperationResult, TechnicalState } from '../core/evidence.js';
import type { ProcessIdentity } from '../ports/writerProcesses.js';
import { publishFile } from '../src/adapters/artifacts/files.js';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { readH06NativeAttemptForReopen } from './comparisonH06NativeAttempt.js';
import { legacyDisabledMcpServers } from './comparisonH06NativeLegacyOperator.js';
import { openH06NativeLegacyBudget } from './comparisonH06NativeLegacyBudget.js';
import { captureH06NativeLegacyCompletedThread } from './comparisonH06NativeLegacyDispatch.js';
import { runH06NativeLegacyWriterPhase } from './comparisonH06NativeLegacyWriterPhase.js';

type PhaseInput = Parameters<typeof runH06NativeLegacyWriterPhase>[0];
type PhaseRuntime = Parameters<typeof runH06NativeLegacyWriterPhase>[1];
type Claim = ReturnType<typeof readH06NativeAttemptForReopen>;
type Transport = Omit<PhaseRuntime, 'awaitPause'>;
export type H06LegacyCoderRuntime = Transport;

function read(pin: H04Pin) {
  return object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
}

function priorThreads(pins: H04Pin[]) {
  const previous = new Map<string, Record<string, unknown>>();
  for (const pin of pins) {
    const response = read(pin);
    const session = identifier(object(response.thread).id);
    requireContract(!previous.has(session), 'h06-legacy-transport-thread-duplicate');
    previous.set(session, response);
  }
  return previous;
}

/** Run the scoped Writer phase with the same App Server policies used by the normal Legacy CLI. */
export async function runH06NativeLegacyTransportPhase(
  input: PhaseInput,
  options: Pick<PhaseRuntime, 'store' | 'awaitPause'> & { warmThread: H04Pin | null },
) {
  const claim = readH06NativeAttemptForReopen(input.claim);
  const { request } = claim;
  const { binding, evidenceRoot } = request;
  const { store, warmThread } = options;
  const { context } = store.grant;
  requireContract(
    binding.variant === 'legacy' &&
      process.env.CODEX_THREAD_ID === context.actor_id &&
      store.root === join(evidenceRoot, 'legacy-store') &&
      (input.phase === 'warm'
        ? warmThread === null
        : warmThread?.path === join(evidenceRoot, 'legacy-warm-writer-thread.json')),
    'h06-legacy-transport-binding',
  );
  const previous = priorThreads(warmThread === null ? [] : [warmThread]);
  return withH06LegacyCoderRuntime(
    claim,
    store,
    input.phase === 'warm' ? 'create' : 'reopen',
    previous,
    openH06NativeLegacyBudget,
    (runtime) =>
      runH06NativeLegacyWriterPhase(input, { ...runtime, awaitPause: options.awaitPause }),
  );
}

export function withH06LegacyCoderRuntime<
  T,
  C extends Pick<Claim, 'request' | 'receipt' | 'workDeadlineMs' | 'stopDeadlineMs'>,
>(
  claim: C,
  store: PhaseRuntime['store'],
  mode: 'create' | 'reopen',
  previous: ReturnType<typeof priorThreads>,
  openBudget: (claim: C, mode: 'create' | 'reopen') => ReturnType<typeof openH06NativeLegacyBudget>,
  run: (runtime: Transport) => Promise<T>,
  signal?: AbortSignal,
) {
  const { request, workDeadlineMs, stopDeadlineMs } = claim;
  const { binding, evidenceRoot } = request;
  const { context } = store.grant;
  const monotonicWork = performance.now() + (workDeadlineMs - Date.now());
  return withChatWriter(store.root, async () => {
    const state = () =>
      unwrap<TechnicalState>(
        store.execute({ context, command: { type: 'state', archive: 'current' } }),
      );
    const initial = state();
    const generation = initial.generation;
    requireContract(
      initial.owner === context.actor_id &&
        initial.checkpoint !== null &&
        !initial.frozen &&
        !initial.released &&
        Date.now() < initial.lease_until,
      'h06-legacy-transport-store',
    );
    function working() {
      signal?.throwIfAborted();
      requireContract(
        Date.now() < workDeadlineMs && performance.now() < monotonicWork,
        'h06-legacy-budget-work',
      );
      const current = state();
      requireContract(
        current.owner === context.actor_id &&
          current.generation === generation &&
          !current.released &&
          !current.frozen &&
          Date.now() < current.lease_until,
        'h06-legacy-transport-work-owner',
      );
    }
    const verify = bindChatEvidence(store.root, evidenceRoot, initial);
    const persistence = {
      execute: async (value: Parameters<typeof store.execute>[0]) => {
        verify();
        return store.execute(value);
      },
    };
    const backup = (source: TechnicalState, operation: string) =>
      backupSupervision(persistence, store.root, evidenceRoot, store.grant, source, operation);
    const runs = new TaskLocalRuns(persistence, context, initial.generation, true, backup);
    const journal = new TaskWorkflowJournal(persistence, context, initial.generation, true, backup);
    const authorize = async (brief: CoderBrief, phase: CoderRun['status'] | null) => {
      const parent = await runs.read();
      requireContract(parent !== null, 'h06-legacy-transport-parent');
      assertCoderParent(parent, brief);
      const current = (await journal.read()).coders?.[brief.id];
      requireContract(
        phase === null
          ? current === undefined
          : current?.status === phase && same(current.brief, brief),
        'h06-legacy-transport-writer',
      );
    };
    const workspaces = new FileCoderWorkspaces(
      binding.workspaceRoot,
      evidenceRoot,
      async (brief, phase) => {
        working();
        await authorize(brief, phase);
        working();
      },
    );
    const processes = new NativeWriterProcesses();
    const budget = openBudget(claim, mode);
    let raw: StdioAppServer | undefined;
    let rpc: AppServerRpc | undefined;
    let native: Promise<AppServerCoderSessions> | undefined;
    function sessions(run: CoderRun) {
      return (native ??= (async () => {
        working();
        const directory = join(evidenceRoot, 'coders', identifier(run.brief.id));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        readH04Pin(request.appServer);
        const journalPath = join(directory, 'transport.jsonl');
        const remaining = workDeadlineMs - Date.now();
        requireContract(remaining > 0, 'h06-legacy-budget-work');
        return openNativeCoderSessions({
          run,
          binary: request.appServer.path,
          journal: journalPath,
          processes,
          expectedDisabledMcpServers: legacyDisabledMcpServers(read(request.bootstrap)),
          inventoryTimeoutMs: remaining,
          beforeSpawn() {
            working();
            readH04Pin(request.appServer);
          },
          authorize: (current) => authorize(current.brief, current.status),
          verifyCopy: (current) => workspaces.verifyCopy(current),
          adopt(transport) {
            raw = transport;
            rpc = budget.wrap(
              {
                request(method, params) {
                  if (['thread/start', 'thread/resume', 'turn/start'].includes(method)) working();
                  return transport.request(method, params);
                },
                completed: (thread, turn, signal, verify) =>
                  transport.completed(thread, turn, signal, verify),
              },
              {
                root: run.brief.copy_root,
                journal: journalPath,
                readUsage: (ledger) =>
                  budget.readUsage(ledger, (scope) =>
                    scope.journal === journalPath
                      ? transport.request('thread/read', {
                          threadId: scope.session,
                          includeTurns: false,
                        })
                      : (previous.get(scope.session) ?? null),
                  ),
              },
            );
            return rpc;
          },
        });
      })());
    }
    const port: PhaseRuntime['coder']['sessions'] = {
      create: async (run) => (await sessions(run)).create(run),
      recoverCreate: async (run) => (await sessions(run)).recoverCreate(run),
      load: async (run, fresh) => (await sessions(run)).load(run, fresh),
      send: async (run, fresh) => (await sessions(run)).send(run, fresh),
      result: async (run) => (await sessions(run)).result(run),
      stop: async (run) => (await sessions(run)).stop(run),
      observeLiveWriter: async (run) => (await sessions(run)).observeLiveWriter(run),
    };
    async function observeBeforeStop<T>(observe: () => Promise<T>) {
      const remaining = stopDeadlineMs - Date.now();
      requireContract(remaining > 0, 'h06-legacy-transport-stop-unconfirmed');
      const timer = new AbortController();
      try {
        return await Promise.race([
          observe(),
          wait(remaining, undefined, { signal: timer.signal }).then(() => {
            throw new Error('h06-legacy-transport-stop-unconfirmed');
          }),
        ]);
      } finally {
        timer.abort();
      }
    }
    async function closeOwned() {
      if (raw === undefined) return;
      let identities: ProcessIdentity[] = [];
      try {
        const pid = raw.pid;
        requireContract(pid !== undefined, 'h06-legacy-transport-owner');
        identities = await observeBeforeStop(() => processes.descendants([pid]));
        requireContract(
          identities.some((entry) => entry.pid === pid && entry.parent === process.pid),
          'h06-legacy-transport-owner',
        );
      } finally {
        raw.close();
      }
      while ((await observeBeforeStop(() => processes.alive(identities))).length > 0) {
        requireContract(Date.now() < stopDeadlineMs, 'h06-legacy-transport-stop-unconfirmed');
        await processes.wait(25);
      }
    }
    return run({
      store,
      coder: { journal, runs, workspaces, sessions: port },
      rpc: {
        request(method, params) {
          requireContract(rpc !== undefined, 'h06-legacy-transport-not-open');
          return rpc.request(method, params);
        },
      },
      runWithinWork: budget.runWithinWork,
      stop: budget.stop,
      closeOwned,
    });
  });
}

interface CompletionInput {
  claim: H04Pin;
  started: H04Pin;
  brief: H04Pin;
  coldResume: H04Pin;
  warmThread: H04Pin;
  coldThread: H04Pin;
}

function saveCompletion(path: string, value: unknown) {
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { path, sha256: digest(bytes) };
}

/** Complete the third Writer only after the cold actor has resumed the retained task. */
export async function runH06NativeLegacyCompletion(
  input: CompletionInput,
  { store, signal }: { store: PhaseRuntime['store']; signal: AbortSignal },
) {
  signal.throwIfAborted();
  const { started, coldResume, warmThread, coldThread } = input;
  const claim = readH06NativeAttemptForReopen(input.claim);
  const { request } = claim;
  const { evidenceRoot, binding } = request;
  const { context } = store.grant;
  const start = read(started);
  const briefPin = h04Pin(input.brief);
  requireContract(
    binding.variant === 'legacy' &&
      process.env.CODEX_THREAD_ID === context.actor_id &&
      context.task_id === binding.operationId &&
      store.root === join(evidenceRoot, 'legacy-store') &&
      started.path === join(evidenceRoot, 'legacy-operator-start.json') &&
      start.kind === 'h06-native-legacy-operator-start' &&
      same(start.claim, claim.receipt) &&
      same(start.context, context) &&
      same(start.bootstrap, request.bootstrap) &&
      request.runtime.some((pin) => same(pin, briefPin)) &&
      coldResume.path === join(evidenceRoot, 'legacy-cold-resume.json') &&
      warmThread.path === join(evidenceRoot, 'legacy-warm-writer-thread.json') &&
      coldThread.path === join(evidenceRoot, 'legacy-cold-writer-thread.json'),
    'h06-legacy-completion-binding',
  );
  const brief = read(briefPin) as unknown as CoderBrief;
  validateCoderBrief(brief);
  requireContract(
    brief.project_id === context.project_id &&
      brief.task_id === context.task_id &&
      brief.parent_run_id === context.run_id &&
      brief.parent_session_id === context.actor_id &&
      brief.source_root === binding.workspaceRoot &&
      brief.generation === start.generation &&
      brief.copy_root === join(evidenceRoot, 'coder-workspaces', brief.id),
    'h06-legacy-completion-brief',
  );
  const previous = priorThreads([warmThread, coldThread]);
  return withH06LegacyCoderRuntime(
    claim,
    store,
    'reopen',
    previous,
    openH06NativeLegacyBudget,
    async (runtime) => {
      const { coder, rpc } = runtime;
      async function complete(work: AbortSignal) {
        const live = AbortSignal.any([signal, work]);
        function working() {
          live.throwIfAborted();
          requireContract(Date.now() < claim.workDeadlineMs, 'h06-legacy-budget-work');
        }
        working();
        const resumed = read(coldResume);
        const event = object(resumed.event);
        const identity = object(resumed.identity);
        const operation = 'chat:control:' + identifier(event.id);
        const recorded = unwrap<OperationResult>(
          store.execute({ context, command: { type: 'operation', operation_id: operation } }),
        );
        const state = unwrap<TechnicalState>(
          store.execute({ context, command: { type: 'state', archive: 'current' } }),
        );
        const control = object(object(state.checkpoint).chat_control);
        const history: unknown = control.history;
        requireContract(Array.isArray(history), 'h06-legacy-completion-resume');
        const last = object((history as unknown[]).at(-1));
        requireContract(
          resumed.kind === 'h06-native-legacy-resume' &&
            resumed.phase === 'cold' &&
            event.type === 'RESUME' &&
            resumed.operation === operation &&
            same(identity.context, context) &&
            identity.store === store.root &&
            identity.workspace === binding.workspaceRoot &&
            identity.evidence === evidenceRoot &&
            event.generation === brief.generation &&
            event.thread_id === context.actor_id &&
            recorded.status === 'confirmed' &&
            recorded.ack.operation_id === operation &&
            same(recorded.ack, resumed.ack) &&
            state.revision === recorded.ack.catalog_revision &&
            state.generation === brief.generation &&
            control.status === 'active' &&
            same(resumed.control, control) &&
            last.id === event.id &&
            same(object(JSON.parse(String(last.payload))), event),
          'h06-legacy-completion-resume',
        );
        const resumeIntent = h04Pin(resumed.intent);
        const intent = read(resumeIntent);
        const stoppedBy = h04Pin(intent.stoppedBy);
        const link = read(stoppedBy);
        const stopIntent = h04Pin(link.intent);
        const stopped = object(link.stopped);
        const stoppedPin = h04Pin({ path: stopped.locator, sha256: stopped.hash });
        const proof = read(stoppedPin);
        const prior = read(stopIntent);
        const id = identifier(link.coderId);
        const run = (await coder.journal.read()).coders?.[id];
        requireContract(
          resumeIntent.path === join(evidenceRoot, 'legacy-cold-resume-intent.json') &&
            same(intent.identity, identity) &&
            same(intent.event, event) &&
            stoppedBy.path === join(evidenceRoot, 'legacy-cold-writer-stop.json') &&
            link.kind === 'h06-native-legacy-writer-stop' &&
            link.phase === 'cold' &&
            same(link.identity, identity) &&
            same(link.stopped, event.stopped) &&
            stopIntent.path === join(evidenceRoot, 'legacy-cold-writer-stop-intent.json') &&
            dirname(stoppedPin.path) === join(evidenceRoot, 'coders', id) &&
            prior.kind === 'h06-native-legacy-writer-stop-intent' &&
            prior.phase === 'cold' &&
            same(prior.identity, identity) &&
            id !== brief.id &&
            run?.status === 'running' &&
            same(run, prior.coder) &&
            run.session !== null &&
            object(read(coldThread).thread).id === run.session.id &&
            proof.kind === 'writers-stopped' &&
            proof.thread === run.session.id &&
            proof.active_turn === false &&
            proof.remaining_processes === 0 &&
            proof.remaining_terminals === 0 &&
            typeof proof.before_hash === 'string' &&
            proof.before_hash === proof.after_hash,
          'h06-legacy-completion-stop',
        );
        working();
        const completionIntent = saveCompletion(
          join(evidenceRoot, 'legacy-completion-intent.json'),
          {
            claim: claim.receipt,
            started,
            coldResume,
            brief: briefPin,
            warmThread,
            coldThread,
          },
        );
        working();
        const retired = await cancelCoder(id, {
          ...coder,
          sessions: {
            ...coder.sessions,
            stop: async () => ({ locator: stoppedPin.path, hash: stoppedPin.sha256 }),
          },
        });
        requireContract(retired.status === 'cancelled', 'h06-legacy-completion-retire');
        working();
        await startCoder(brief, coder);
        working();
        const completed = await runCoder(brief.id, coder);
        requireContract(completed.status === 'released', 'h06-legacy-completion-writer');
        working();
        const integrated = await integrateCoder(brief.id, coder);
        validateCoderRun(integrated);
        requireContract(
          integrated.status === 'integrated' && same(integrated.brief, brief),
          'h06-legacy-completion-integration',
        );
        working();
        const coderPin = saveCompletion(
          join(evidenceRoot, 'legacy-completion-coder.json'),
          integrated,
        );
        const thread = await captureH06NativeLegacyCompletedThread(rpc, coderPin);
        return { coder: coderPin, thread, intent: completionIntent };
      }
      const outcome = await runtime.runWithinWork(complete).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await runtime.stop(runtime.closeOwned);
      } catch (cleanup) {
        if (!outcome.ok)
          throw new AggregateError(
            [outcome.error, cleanup],
            'h06-legacy-completion-and-stop-failed',
          );
        throw cleanup;
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    signal,
  );
}
