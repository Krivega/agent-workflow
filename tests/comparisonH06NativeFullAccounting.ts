import { isDeepStrictEqual as same } from 'node:util';
import {
  readComparisonUsage,
  type NativeComparisonReceipt,
} from '../adapters/codex/comparisonUsage.js';
import { digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import { identifier, object, requireContract, text } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { verifyH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';

interface SharedSource {
  label: string;
  session: string;
  transcript: string;
  turns: readonly string[];
}

interface AccountingInput {
  outcome: H04Pin;
  deliveries: readonly H04Pin[];
  shared: readonly SharedSource[];
}

const json = (pin: H04Pin) => object(JSON.parse(readH04Pin(h04Pin(pin)).toString()));
const metrics = ['responses', 'input_uncached', 'input_cached', 'output'] as const;

function subtotal(receipts: readonly NativeComparisonReceipt[]) {
  const known = { responses: 0, input_uncached: 0, input_cached: 0, output: 0 };
  for (const receipt of receipts) {
    for (const key of metrics) {
      const value = receipt[key];
      requireContract(value !== null, 'h06-full-accounting-incomplete-usage');
      known[key] += value;
      requireContract(Number.isSafeInteger(known[key]), 'h06-full-accounting-overflow');
    }
  }
  return known;
}

/** Derive a separate cost report; never upgrade the sealed recovery result or shared attribution. */
export function checkH06NativeFullAccounting(input: AccountingInput) {
  const outcome = json(input.outcome),
    claimPin = h04Pin(outcome.claim),
    claim = json(claimPin),
    managed = object(outcome.usage),
    ledger = object(managed.ledger),
    source = object(claim.source),
    acceptance = object(outcome.acceptance),
    operation = identifier(object(object(claim.request).binding).operationId);
  requireContract(
    outcome.kind === 'h06-delegated-run-outcome/1' &&
      outcome.status === 'completed' &&
      acceptance.status === 'PASS' &&
      acceptance.profile === 'h06-autonomous-recovery/3' &&
      acceptance.wholeAttemptComplete === false &&
      acceptance.qualification === false &&
      managed.wholeAttemptComplete === false &&
      same(managed.claim, claimPin) &&
      ledger.status === 'RECORDED' &&
      ledger.used === 9 &&
      Array.isArray(ledger.admissions) &&
      ledger.admissions.length === 9 &&
      Array.isArray(managed.nativeSources) &&
      managed.nativeSources.length === 3 &&
      input.deliveries.length === 5,
    'h06-full-accounting-attempt',
  );
  const proofs = input.deliveries.map((pin) => verifyH06DelegatedDelivery(json(pin)));
  const snapshots = new Map<string, { bytes: Buffer; lines: string[] }>();
  function journal(path: string) {
    if (!snapshots.has(path)) {
      const bytes = readH06NativeJournal(path);
      snapshots.set(path, { bytes, lines: bytes.toString().trimEnd().split('\n') });
    }
    return snapshots.get(path)!;
  }
  function ref(path: string, index: number): InputRef {
    return { locator: `${path}#L${index + 1}`, hash: digest(journal(path).lines[index]! + '\n') };
  }
  function turns(session: string, transcript: string, selected: readonly string[]) {
    identifier(session);
    requireContract(
      selected.length > 0 && new Set(selected).size === selected.length,
      'h06-full-accounting-turn-inventory',
    );
    const rows = journal(transcript).lines.map((line) => object(JSON.parse(line)));
    const receipts: NativeComparisonReceipt[] = [];
    const windows = selected.map((turn) => {
      identifier(turn);
      const boundary = (kind: string) =>
        rows.flatMap((row, index) =>
          row.type === 'event_msg' &&
          object(row.payload).type === kind &&
          object(row.payload).turn_id === turn
            ? [index]
            : [],
        );
      const started = boundary('task_started'),
        completed = boundary('task_complete');
      requireContract(
        started.length === 1 && completed.length === 1 && started[0]! < completed[0]!,
        'h06-full-accounting-terminal',
      );
      const first = started[0]!,
        last = completed[0]!,
        terminal = object(rows[last]!.payload),
        duration = terminal.duration_ms;
      requireContract(
        duration === undefined ||
          (typeof duration === 'number' && Number.isSafeInteger(duration) && duration >= 0),
        'h06-full-accounting-duration',
      );
      const contexts = rows.flatMap((row, index) =>
        index > first &&
        index < last &&
        row.type === 'turn_context' &&
        object(row.payload).turn_id === turn
          ? [index]
          : [],
      );
      requireContract(contexts.length === 1, 'h06-full-accounting-context');
      const context = object(rows[contexts[0]!]!.payload);
      const through = ref(transcript, last);
      const turnReceipts = readComparisonUsage({
        session,
        transcript,
        run: operation,
        stage: 'execution',
        through,
      }).filter((receipt) => {
        const index = Number(receipt.source.locator.split('#L').at(-1)) - 1;
        return index >= first && index <= last && object(rows[index]!.payload).turn_id === turn;
      });
      receipts.push(...turnReceipts);
      return {
        turn,
        knownSubtotal: subtotal(turnReceipts),
        started: ref(transcript, first),
        completed: through,
        context: ref(transcript, contexts[0]!),
        model: text(context.model),
        effort: text(context.effort),
        attribution: object(rows[first]!.payload).turn_attribution,
        durationMs: duration ?? null,
      };
    });
    return { session, transcript, windows, receipts };
  }
  const rootSession = identifier(object(object(claim.request).chat).threadId),
    rootTurn = identifier(source.turnId),
    rootTranscript = text(source.transcript),
    actor = identifier(claim.actorId);
  for (const proof of proofs) {
    requireContract(
      proof.input.root.threadId === rootSession &&
        proof.input.root.turnId === rootTurn &&
        same(proof.user, source.source) &&
        proof.input.actor.threadId === actor &&
        proof.input.command.requestHash === claim.requestHash &&
        same(proof.input.command.target.claim, claimPin),
      'h06-full-accounting-delivery-binding',
    );
  }
  const root = turns(rootSession, rootTranscript, [rootTurn]);
  const actorPaths = new Set(proofs.map((proof) => proof.inbound.locator.split('#L')[0]!));
  requireContract(actorPaths.size === 1, 'h06-full-accounting-actor-path');
  const actorUsage = turns(
    actor,
    [...actorPaths][0]!,
    proofs.map((proof) => proof.actorTurnId),
  );
  for (const window of actorUsage.windows) {
    const attribution = object(window.attribution);
    requireContract(
      attribution.turn_trigger === 'app_tool_send_message' &&
        attribution.parent_turn_id === rootTurn &&
        attribution.root_turn_id === rootTurn,
      'h06-full-accounting-actor-attribution',
    );
  }
  const admitted = ledger.admissions.map((raw) => object(raw));
  const writers = managed.nativeSources.map((raw) => {
    const native = object(raw),
      session = identifier(native.session);
    const owned = admitted.filter((entry) => object(entry.scope).session === session);
    requireContract(owned.length === 3, 'h06-full-accounting-writer-inventory');
    for (const entry of owned) {
      const admission = json(h04Pin(entry.pin)),
        response = json(h04Pin(object(entry.response).pin));
      requireContract(
        same(admission.scope, entry.scope) &&
          same(response.admission, entry.pin) &&
          response.turnId === object(entry.response).turnId,
        'h06-full-accounting-ledger-binding',
      );
    }
    return turns(
      session,
      text(native.transcript),
      owned.map((entry) => identifier(object(entry.response).turnId)),
    );
  });
  const direct = [
    { ...root, role: 'coordinator' as const },
    { ...actorUsage, role: 'actor' as const },
    ...writers.map((writer) => ({ ...writer, role: 'writer' as const })),
  ];
  requireContract(
    new Set(direct.map((entry) => entry.session)).size === 5,
    'h06-full-accounting-roster',
  );
  function unique(groups: readonly ReturnType<typeof turns>[]) {
    const seen = new Map<string, NativeComparisonReceipt>();
    for (const group of groups) {
      for (const receipt of group.receipts) {
        const index = Number(receipt.source.locator.split('#L').at(-1)) - 1;
        const row = object(JSON.parse(journal(group.transcript).lines[index]!));
        requireContract(row.type === 'token_usage_record', 'h06-full-accounting-primary-usage');
        const id = identifier(object(row.payload).response_id),
          previous = seen.get(id);
        requireContract(
          previous === undefined || same(previous, receipt),
          'h06-full-accounting-response-conflict',
        );
        seen.set(id, receipt);
      }
    }
    return [...seen.values()];
  }
  const receipts = unique(direct);
  const writerSubtotal = subtotal(unique(writers));
  requireContract(
    same(writerSubtotal, {
      responses: object(managed.knownSubtotal).responses,
      input_uncached: object(managed.knownSubtotal).inputUncached,
      input_cached: object(managed.knownSubtotal).inputCached,
      output: object(managed.knownSubtotal).output,
    }),
    'h06-full-accounting-managed-subtotal',
  );
  const shared = input.shared.map((entry) => ({
    label: text(entry.label),
    attribution: 'SHARED_NOT_ALLOCATED' as const,
    ...turns(entry.session, entry.transcript, entry.turns),
  }));
  unique([...direct, ...shared]);
  for (const [path, snapshot] of snapshots)
    requireContract(
      readH06NativeJournal(path).subarray(0, snapshot.bytes.length).equals(snapshot.bytes),
      'h06-full-accounting-prefix-changed',
    );
  const knownDirect = subtotal(receipts),
    caps = object(managed.caps),
    rootDurationMs = root.windows[0]!.durationMs;
  for (const cap of [caps.maxInputUncached, caps.maxOutput, caps.maxElapsedMs])
    requireContract(
      typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0,
      'h06-full-accounting-caps',
    );
  return {
    kind: 'h06-native-full-accounting/1',
    outcome: input.outcome,
    nativePrefixes: [...snapshots].map(([path, snapshot]) => ({
      path,
      bytes: snapshot.bytes.length,
      sha256: digest(snapshot.bytes),
    })),
    deliveries: input.deliveries,
    direct: {
      knownSubtotal: knownDirect,
      participants: direct.map((entry) => ({ ...entry, knownSubtotal: subtotal(entry.receipts) })),
      receipts,
    },
    shared: shared.map((entry) => ({ ...entry, knownSubtotal: subtotal(entry.receipts) })),
    rootDurationMs,
    knownDirectLowerBoundOverNumericCaps: {
      inputUncached: knownDirect.input_uncached > (caps.maxInputUncached as number),
      output: knownDirect.output > (caps.maxOutput as number),
      rootElapsedMs:
        rootDurationMs === null ? null : rootDurationMs > (caps.maxElapsedMs as number),
    },
    currencyCost: 'UNKNOWN',
    budgetScope: 'managed-writers-only',
    sealedManagedUsage: managed,
    wholeAttemptCost: 'UNKNOWN',
    wholeAttemptComplete: false,
    qualification: false,
    gaps: [
      'shared-preparation-and-debug-attribution',
      'complete-preparation-roster',
      'comparable-temporal-attempt',
    ],
  } as const;
}
