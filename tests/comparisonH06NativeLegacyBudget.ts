import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as same } from 'node:util';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { observeH06NativeLegacyTranscript } from './comparisonH06NativeLegacyUsage.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';
import { checkH06NativeUsage } from './comparisonH06NativeUsage.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';

interface LegacyBudgetClaim {
  request: {
    binding: { variant: 'legacy' | 'temporal'; operationId: string };
    evidenceRoot: string;
    budget: {
      maxElapsedMs: number;
      reserveMs: number;
      maxManagedStarts: number;
      maxInputUncached: number;
      maxOutput: number;
    };
  };
  receipt: H04Pin;
  workDeadlineMs: number;
  stopDeadlineMs: number;
}

type Ledger = ReturnType<ReturnType<typeof openH06NativeTurnLedger<true>>['inspect']>;
type Scope = Ledger['admissions'][number]['scope'];
interface UsageObservation {
  status: 'WITHIN_BUDGET' | 'OVER_BUDGET' | 'UNKNOWN';
  knownSubtotal: { inputUncached: number; output: number };
}

interface LegacyTransport {
  root: string;
  journal: string;
  readUsage(ledger: Ledger): Promise<UsageObservation> | UsageObservation;
}

interface LegacyBudget {
  inspect(): Ledger;
  readUsage(
    ledger: Ledger,
    observeThread: (scope: Scope) => unknown | Promise<unknown>,
  ): Promise<UsageObservation & { providerHardCap: false; wholeAttemptComplete: false }>;
  runWithinWork<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T>;
  stop(cleanup: () => Promise<void> | void): Promise<void>;
  wrap(rpc: AppServerRpc, transport: LegacyTransport): AppServerRpc;
}

const workMethods = new Set(['initialize', 'model/list', 'mcpServerStatus/list']);
const cleanupMethods = new Set([
  'thread/read',
  'thread/loaded/list',
  'thread/backgroundTerminals/list',
  'turn/interrupt',
]);

async function within<T>(
  until: number,
  code: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remaining = until - performance.now();
  requireContract(remaining > 0, code);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      reject(error);
      abort.abort(error);
    }, remaining);
  });
  try {
    return await Promise.race([expired, operation(abort.signal)]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bound managed Legacy Writer dispatch and cleanup to the consumed attempt. */
export function openH06NativeLegacyBudget(
  claim: LegacyBudgetClaim,
  mode: 'create' | 'reopen',
): LegacyBudget {
  const { request, receipt, workDeadlineMs, stopDeadlineMs } = structuredClone(claim);
  const { evidenceRoot, binding } = request;
  const record = object(JSON.parse(readH04Pin(receipt).toString('utf8')));
  const sessionsRoot = object(record.grant).sessionsRoot;
  requireContract(
    binding.variant === 'legacy' &&
      record.kind === 'h06-native-attempt-claim' &&
      object(record.request).kind === 'comparison-h06-native/2' &&
      safeDirectory(evidenceRoot) === evidenceRoot &&
      receipt.path === join(evidenceRoot, 'attempt-claim.json') &&
      same(record.request, request) &&
      record.requestHash === digest(canonical({ request, assets: record.assets })) &&
      record.workDeadlineMs === workDeadlineMs &&
      record.stopDeadlineMs === stopDeadlineMs &&
      typeof sessionsRoot === 'string' &&
      safeDirectory(sessionsRoot) === sessionsRoot,
    'h06-legacy-budget-claim',
  );
  return enforceH06LegacyBudget(claim, mode, sessionsRoot);
}

/** Enforce limits for an already verified scoped claim without issuing authority. */
export function enforceH06LegacyBudget(
  claim: LegacyBudgetClaim,
  mode: 'create' | 'reopen',
  sessionsRoot: string,
  nativeJournals: 'immutable' | 'append-only' = 'immutable',
): LegacyBudget {
  const { request, receipt, workDeadlineMs, stopDeadlineMs } = structuredClone(claim);
  const { evidenceRoot, binding, budget } = request;
  const readJournal = nativeJournals === 'append-only' ? readH06NativeJournal : h01RawFile;
  const record = object(JSON.parse(readH04Pin(receipt).toString('utf8')));
  requireContract(
    [
      budget.maxElapsedMs,
      budget.reserveMs,
      budget.maxManagedStarts,
      budget.maxInputUncached,
      budget.maxOutput,
    ].every((cap) => Number.isSafeInteger(cap) && cap > 0),
    'h06-legacy-budget-caps',
  );
  const wall = Date.now();
  const monotonic = performance.now();
  const { startedAt } = record;
  requireContract(
    typeof startedAt === 'number' &&
      Number.isSafeInteger(startedAt) &&
      startedAt > 0 &&
      startedAt <= wall &&
      Number.isSafeInteger(workDeadlineMs) &&
      Number.isSafeInteger(stopDeadlineMs) &&
      stopDeadlineMs === startedAt + budget.maxElapsedMs &&
      workDeadlineMs === stopDeadlineMs - budget.reserveMs &&
      startedAt < workDeadlineMs &&
      budget.maxElapsedMs < 2 ** 31 &&
      stopDeadlineMs - wall < 2 ** 31,
    'h06-legacy-budget-clock',
  );
  const work = monotonic + (workDeadlineMs - wall);
  const hard = monotonic + (stopDeadlineMs - wall);
  const turns = openH06NativeTurnLedger(join(evidenceRoot, 'legacy-turns'), {
    mode,
    operationId: binding.operationId,
    maxManagedStarts: budget.maxManagedStarts,
    legacy: true,
  });
  let stopping: Promise<void> | undefined;

  const { inspect } = turns;

  function working() {
    requireContract(stopping === undefined && performance.now() < work, 'h06-legacy-budget-work');
  }

  async function runWithinWork<T>(run: (signal: AbortSignal) => Promise<T>) {
    working();
    return within(work, 'h06-legacy-budget-work', run);
  }

  function wrap(rpc: AppServerRpc, { root, journal, readUsage }: LegacyTransport): AppServerRpc {
    requireContract(
      safeDirectory(root) === root &&
        isAbsolute(journal) &&
        resolve(journal) === journal &&
        journal.startsWith(evidenceRoot + sep) &&
        safeDirectory(dirname(journal)) === dirname(journal),
      'h06-legacy-budget-transport',
    );
    const sessions = new Set<string>();
    return {
      async request(method, params) {
        if (cleanupMethods.has(method))
          return within(hard, 'h06-legacy-budget-stop', () => rpc.request(method, params));
        working();
        if (method === 'thread/start' || method === 'thread/resume') {
          requireContract(params.cwd === root, 'h06-legacy-budget-thread');
          const reply = await runWithinWork(() => rpc.request(method, params));
          const body = object(reply);
          const thread = object(body.thread);
          const id = identifier(thread.id);
          requireContract(
            body.cwd === root && (method !== 'thread/resume' || id === params.threadId),
            'h06-legacy-budget-thread',
          );
          sessions.add(id);
          return reply;
        }
        if (method !== 'turn/start') {
          requireContract(workMethods.has(method), 'h06-legacy-budget-method');
          return runWithinWork(() => rpc.request(method, params));
        }
        const request = structuredClone(params);
        const session = identifier(request.threadId);
        requireContract(sessions.has(session), 'h06-legacy-budget-session');
        const ledger = inspect();
        requireContract(
          ledger.status === 'RECORDED' && ledger.used < budget.maxManagedStarts,
          'h06-legacy-budget-starts',
        );
        if (ledger.used > 0) {
          const usage = await runWithinWork(async () => readUsage(ledger));
          const { inputUncached, output } = usage.knownSubtotal;
          requireContract(
            usage.status === 'WITHIN_BUDGET' &&
              Number.isSafeInteger(inputUncached) &&
              inputUncached >= 0 &&
              inputUncached < budget.maxInputUncached &&
              Number.isSafeInteger(output) &&
              output >= 0 &&
              output < budget.maxOutput,
            'h06-legacy-budget-usage',
          );
        }
        working();
        readH04Pin(receipt);
        const turn = { role: 'legacy-writer' as const, root, journal, session, params: request };
        await turns.admitTurn(turn, ledger.used);
        const reply = await runWithinWork(() => rpc.request(method, request));
        const turnId = identifier(object(object(reply).turn).id);
        await within(hard, 'h06-legacy-budget-stop', () =>
          turns.recordTurn({ ...turn, turnId, response: reply }),
        );
        return reply;
      },
      completed(thread, turn, signal, verify) {
        return within(hard, 'h06-legacy-budget-stop', (deadline) =>
          rpc.completed(
            thread,
            turn,
            signal ? AbortSignal.any([signal, deadline]) : deadline,
            verify,
          ),
        );
      },
    };
  }

  async function readUsage(
    ledger: Ledger,
    observeThread: (scope: Scope) => unknown | Promise<unknown>,
  ) {
    requireContract(same(ledger, inspect()), 'h06-legacy-budget-usage-ledger');
    const bySession = new Map<string, Ledger['admissions']>();
    for (const row of ledger.admissions) {
      const previous = bySession.get(row.scope.session) ?? [];
      previous.push(row);
      bySession.set(row.scope.session, previous);
    }
    const sources: { participant: ComparisonParticipant; sha256: string; bytes: Buffer }[] = [];
    for (const rows of bySession.values()) {
      const { scope } = rows[0]!;
      const { session, root, journal } = scope;
      const completed = rows.flatMap(({ response }) =>
        response === null ? [] : [{ turn: response.turnId }],
      );
      if (
        completed.length !== rows.length ||
        !rows.every(({ scope }) => scope.root === root && scope.journal === journal)
      )
        continue;
      try {
        const thread = object(object(await observeThread(scope)).thread);
        const transcript = thread.path;
        if (
          thread.id !== session ||
          thread.cwd !== root ||
          typeof transcript !== 'string' ||
          !transcript.startsWith(sessionsRoot + sep)
        )
          continue;
        const bytes = readJournal(transcript);
        const terminal = observeH06NativeLegacyTranscript(bytes, thread, {
          thread: session,
          turns: completed,
        });
        if (terminal === null) continue;
        sources.push({
          participant: {
            session,
            transcript,
            run: binding.operationId,
            stage: 'execution',
            through: { locator: `${transcript}#L${terminal.line}`, hash: terminal.hash },
          },
          sha256: digest(bytes),
          bytes,
        });
      } catch {
        // An unavailable or invalid source cannot supply a known count for this session.
      }
    }
    const participants = sources.map(({ participant }) => participant);
    let usage: ReturnType<typeof checkH06NativeUsage> | null = null;
    try {
      const observed = checkH06NativeUsage({
        expected: participants.map(({ through: _through, ...participant }) => participant),
        participants,
        budget,
      });
      if (
        sources.every(({ participant, sha256, bytes }) => {
          const current = readJournal(participant.transcript);
          return nativeJournals === 'append-only'
            ? current.subarray(0, bytes.length).equals(bytes)
            : digest(current) === sha256;
        })
      )
        usage = observed;
    } catch {
      // A source changed or failed a primary usage check after its initial observation.
    }
    return {
      status:
        usage && (usage.status === 'OVER_BUDGET' || participants.length === bySession.size)
          ? usage.status
          : ('UNKNOWN' as const),
      knownSubtotal: usage?.knownSubtotal ?? { inputUncached: 0, output: 0 },
      participants: usage === null ? [] : participants,
      receipts: usage?.receipts ?? [],
      providerHardCap: false,
      wholeAttemptComplete: false,
    } as const;
  }

  function stop(cleanup: () => Promise<void> | void): Promise<void> {
    return (stopping ??= Promise.resolve().then(async () => {
      const cleanupWork = Promise.resolve().then(cleanup);
      if (performance.now() >= hard) {
        // Closing owned transport is still necessary when the budget has expired.
        void cleanupWork.catch(() => undefined);
        throw new Error('h06-legacy-budget-stop');
      }
      await within(hard, 'h06-legacy-budget-stop', () => cleanupWork);
    }));
  }

  return { inspect, readUsage, runWithinWork, stop, wrap };
}
