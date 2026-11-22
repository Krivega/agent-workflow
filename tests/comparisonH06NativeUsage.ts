import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import {
  readComparisonUsage,
  sealComparisonUsage,
  type ComparisonParticipant,
  type NativeComparisonReceipt,
} from '../adapters/codex/comparisonUsage.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { openH06NativeAttemptTurnLedger } from './comparisonH06NativeAttempt.js';

type ExpectedParticipant = Omit<ComparisonParticipant, 'through'>;
type UsageMetric = (typeof metrics)[number];

const metrics = ['responses', 'input_uncached', 'input_cached', 'output'] as const;

interface UsageRequest {
  expected: readonly ExpectedParticipant[];
  participants: readonly ComparisonParticipant[];
  budget: { maxInputUncached: number; maxOutput: number };
}

/** Seal the native range after its owned runtime has stopped. The transcript is read only. */
export function sealH06NativeUsage(participant: ComparisonParticipant) {
  safeDirectory(dirname(participant.transcript));
  return sealComparisonUsage(participant);
}

/** Account for the supplied participant inventory, independently of any provider limit. */
export function checkH06NativeUsage({ expected, participants, budget }: UsageRequest) {
  for (const cap of [budget.maxInputUncached, budget.maxOutput])
    requireContract(Number.isSafeInteger(cap) && cap > 0, 'h06-usage-budget');

  const inventory = new Map<string, ExpectedParticipant>();
  const transcripts = new Set<string>();
  for (const entry of expected) {
    const session = identifier(entry.session);
    const { transcript } = entry;
    requireContract(
      isAbsolute(transcript) &&
        resolve(transcript) === transcript &&
        !transcripts.has(transcript) &&
        !inventory.has(session),
      'h06-usage-inventory',
    );
    inventory.set(session, entry);
    transcripts.add(transcript);
  }

  const observed = new Map<string, ComparisonParticipant>();
  for (const participant of participants) {
    const { through: _through, ...identity } = participant;
    requireContract(
      !observed.has(participant.session) && same(inventory.get(participant.session), identity),
      'h06-usage-participant-binding',
    );
    observed.set(participant.session, participant);
  }

  const receipts: NativeComparisonReceipt[] = [];
  const missing: { session: string; reason: 'unsealed' | 'transcript-absent' }[] = [];
  for (const session of inventory.keys()) {
    const participant = observed.get(session);
    if (participant?.through === undefined) {
      missing.push({ session, reason: 'unsealed' });
      continue;
    }
    try {
      receipts.push(...readComparisonUsage(participant));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push({ session, reason: 'transcript-absent' });
    }
  }

  const subtotal: Record<UsageMetric, number> = {
    responses: 0,
    input_uncached: 0,
    input_cached: 0,
    output: 0,
  };
  const incomplete = new Set<UsageMetric>(metrics);
  if (inventory.size > 0 && missing.length === 0) incomplete.clear();
  for (const receipt of receipts) {
    for (const metric of metrics) {
      const count = receipt[metric];
      if (count === null) incomplete.add(metric);
      else {
        subtotal[metric] += count;
        requireContract(Number.isSafeInteger(subtotal[metric]), 'h06-usage-overflow');
      }
    }
  }
  const total = (metric: UsageMetric) => (incomplete.has(metric) ? null : subtotal[metric]);
  const exceeded = {
    inputUncached: subtotal.input_uncached > budget.maxInputUncached,
    output: subtotal.output > budget.maxOutput,
  };
  return {
    status:
      exceeded.inputUncached || exceeded.output
        ? ('OVER_BUDGET' as const)
        : incomplete.size
          ? ('UNKNOWN' as const)
          : ('WITHIN_BUDGET' as const),
    totals: {
      responses: total('responses'),
      inputUncached: total('input_uncached'),
      inputCached: total('input_cached'),
      output: total('output'),
    },
    knownSubtotal: {
      responses: subtotal.responses,
      inputUncached: subtotal.input_uncached,
      inputCached: subtotal.input_cached,
      output: subtotal.output,
    },
    exceeded,
    missing,
    receipts,
    providerHardCap: false,
    wholeAttemptComplete: false,
  } as const;
}

type TransportScope = {
  role: 'reader' | 'writer';
  root: string;
  journal: string;
  session: string;
};

type MissingSource = {
  scope: TransportScope;
  reason: 'transport-unconfirmed' | 'transcript-unavailable' | 'session-origin-unknown';
};

/** Match admitted participants to exact thread responses retained in confirmed transport stops. */
export function bindH06NativeUsageParticipants(input: {
  operationId: string;
  stops: readonly H04Pin[];
  admissions: readonly { scope: TransportScope }[];
}) {
  const operationId = identifier(input.operationId);
  const ports = new Map<
    string,
    { role: unknown; root: unknown; transcripts: Map<string, string> }
  >();
  const started = new Set<string>();
  const allTranscripts = new Map<string, string>();
  const unavailable: H04Pin[] = [];
  function read(pin: H04Pin) {
    try {
      return object(JSON.parse(readH04Pin(pin).toString()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      unavailable.push(pin);
      return null;
    }
  }
  for (const stopPin of input.stops) {
    const stop = h04Pin(stopPin);
    const directory = dirname(stop.path);
    const receipt = read(stop);
    if (receipt === null) continue;
    exactFields(receipt, ['kind', 'operationId', 'receipts']);
    requireContract(
      basename(stop.path) === 'transport-stop.json' &&
        receipt.kind === 'h06-native-transport-stop' &&
        receipt.operationId === operationId &&
        Array.isArray(receipt.receipts) &&
        receipt.receipts.length > 0,
      'h06-usage-transport-stop',
    );
    for (const rawPort of receipt.receipts) {
      const { role, root, journal, processes, confirmed, sessions } = object(rawPort);
      requireContract(
        (role === 'reader' || role === 'writer') &&
          typeof root === 'string' &&
          typeof journal === 'string' &&
          dirname(journal) === directory &&
          new RegExp(`^${role}-[0-9]+\\.jsonl$`, 'u').test(basename(journal)) &&
          confirmed === true &&
          Array.isArray(processes) &&
          processes.length > 0 &&
          Array.isArray(sessions) &&
          !ports.has(journal),
        'h06-usage-transport-port',
      );
      const transcripts = new Map<string, string>();
      for (const [index, raw] of sessions.entries()) {
        const pin = h04Pin(raw);
        requireContract(
          pin.path === join(directory, basename(journal, '.jsonl') + '-session-' + index + '.json'),
          'h06-usage-transport-source',
        );
        const observation = read(pin);
        if (observation === null) continue;
        const { method, session } = observation;
        const id = identifier(session);
        const thread = object(object(observation.response).thread);
        requireContract(
          observation.kind === 'h06-native-transport-session' &&
            observation.operationId === operationId &&
            observation.role === role &&
            observation.root === root &&
            observation.journal === journal &&
            thread.id === id &&
            thread.cwd === root &&
            (method === 'thread/start' || method === 'thread/resume' || method === 'thread/read'),
          'h06-usage-transport-source',
        );
        if (method === 'thread/start') {
          requireContract(!started.has(id), 'h06-usage-transport-origin');
          started.add(id);
        }
        if (thread.path == null) continue;
        const { path } = thread;
        requireContract(
          typeof path === 'string' && isAbsolute(path) && resolve(path) === path,
          'h06-usage-transcript-path',
        );
        const previous = allTranscripts.get(id);
        requireContract(
          previous === undefined || previous === path,
          'h06-usage-transcript-changed',
        );
        allTranscripts.set(id, path);
        transcripts.set(id, path);
      }
      ports.set(journal, { role, root, transcripts });
    }
  }

  const bound = new Map<string, { participant: ExpectedParticipant; role: string; root: string }>();
  const missing: MissingSource[] = [];
  const visited = new Set<string>();
  for (const { scope } of input.admissions) {
    const { role, root, journal, session } = scope;
    const key = JSON.stringify([journal, session, role, root]);
    if (visited.has(key)) continue;
    visited.add(key);
    const port = ports.get(journal);
    if (port === undefined) {
      missing.push({ scope, reason: 'transport-unconfirmed' });
      continue;
    }
    requireContract(port.role === role && port.root === root, 'h06-usage-transport-scope');
    const transcript = port.transcripts.get(session);
    if (transcript === undefined) {
      missing.push({ scope, reason: 'transcript-unavailable' });
      continue;
    }
    if (!started.has(session)) {
      missing.push({ scope, reason: 'session-origin-unknown' });
      continue;
    }
    const participant = { session, transcript, run: operationId, stage: 'execution' as const };
    const evidence = { participant, role, root };
    const existing = bound.get(session);
    requireContract(
      existing === undefined || same(existing, evidence),
      'h06-usage-transport-scope',
    );
    bound.set(session, evidence);
  }
  return {
    status:
      bound.size > 0 && missing.length === 0 && unavailable.length === 0
        ? ('BOUND' as const)
        : ('UNKNOWN' as const),
    participants: [...bound.values()].map(({ participant }) => participant),
    missing,
    unavailable,
  };
}

/** Read the ledger and token caps from the same pinned attempt as the stopped transports. */
export function checkH06NativeTemporalAttemptUsage(input: {
  claim: H04Pin;
  stops: readonly H04Pin[];
  participants: readonly ComparisonParticipant[];
}) {
  const claim = h04Pin(input.claim);
  const request = object(object(JSON.parse(readH04Pin(claim).toString())).request);
  const operationId = identifier(object(request.binding).operationId);
  const caps = object(request.budget);
  const attemptRoot = dirname(claim.path);
  for (const stop of input.stops)
    requireContract(
      dirname(dirname(h04Pin(stop).path)) === attemptRoot,
      'h06-usage-attempt-stop-root',
    );

  let ledger: ReturnType<ReturnType<typeof openH06NativeAttemptTurnLedger>['inspect']> | null;
  try {
    ledger = openH06NativeAttemptTurnLedger(claim).inspect();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    ledger = null;
  }
  const admissions = ledger?.admissions ?? [];
  const binding = bindH06NativeUsageParticipants({ operationId, stops: input.stops, admissions });
  const known = new Set(binding.participants.map(({ session }) => session));
  if (ledger !== null) {
    const admitted = new Set(admissions.map(({ scope }) => scope.session));
    for (const participant of input.participants)
      requireContract(admitted.has(participant.session), 'h06-usage-attempt-participant');
  }
  const usage = checkH06NativeUsage({
    expected: binding.participants,
    participants: input.participants.filter(({ session }) => known.has(session)),
    budget: {
      maxInputUncached: caps.maxInputUncached as number,
      maxOutput: caps.maxOutput as number,
    },
  });
  const ledgerStatus = ledger?.status ?? 'UNKNOWN';
  const incomplete = ledgerStatus === 'UNKNOWN' || binding.status === 'UNKNOWN';
  return {
    ...usage,
    status: incomplete && usage.status !== 'OVER_BUDGET' ? ('UNKNOWN' as const) : usage.status,
    totals: incomplete
      ? { responses: null, inputUncached: null, inputCached: null, output: null }
      : usage.totals,
    binding,
    ledgerStatus,
  };
}
