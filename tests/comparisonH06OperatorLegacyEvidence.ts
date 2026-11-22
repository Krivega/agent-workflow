import { join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import type { InputRef } from '../core/localRun.js';
import { identifier, object, requireContract, text } from '../src/contracts/project.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  h06DelegatedStages,
  openH06DelegatedPhaseLedger,
  readH06DelegatedAuthority,
} from './comparisonH06DelegatedAuthority.js';
import { verifyH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import {
  verifyH06ManagedProfiles,
  type H06ManagedProfile,
} from './comparisonH06ManagedProfiles.js';
import type { readH06NativeRequestBinding } from './comparisonH06NativeAttemptPlan.js';
import { readH06NativeJournal } from './comparisonH06NativeJournal.js';
import { checkH06NativeLegacyCrossing } from './comparisonH06NativeLegacy.js';
import { observeH06NativeLegacyTranscript } from './comparisonH06NativeLegacyUsage.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';
import { checkH06NativeUsage } from './comparisonH06NativeUsage.js';

/** Verify the retained Legacy claim, recovery and managed writer receipts without new effects. */
export function verifyH06LegacySeriesPrimary(
  value: unknown,
  request: ReturnType<typeof readH06NativeRequestBinding>,
  requestHash: string,
  profile?: H06ManagedProfile,
) {
  const root = request.evidenceRoot;
  const evidence: InputRef[] = [];
  function retain(value: unknown, expected?: string): H04Pin {
    const pin = h04Pin(value);
    requireContract(
      pin.path.startsWith(root + sep) && (expected === undefined || pin.path === expected),
      'h06-series-legacy-evidence-path',
    );
    evidence.push({ locator: pin.path, hash: pin.sha256 });
    return pin;
  }
  const read = (pin: H04Pin) => object(JSON.parse(readH04Pin(pin).toString('utf8')));
  const outcomePin = retain(value, join(root, 'delegated-run-outcome.json'));
  const outcome = read(outcomePin);
  const claimPin = retain(outcome.claim, join(root, 'delegated-claim.json'));
  const claim = readH06DelegatedAuthority(claimPin);
  const acceptance = object(outcome.acceptance);
  const managed = object(acceptance.managedUsage);
  requireContract(
    same(request, claim.request) &&
      requestHash === claim.requestHash &&
      outcome.kind === 'h06-delegated-run-outcome/1' &&
      same(acceptance.claim, claimPin) &&
      same(managed.claim, claimPin) &&
      acceptance.profile === 'h06-autonomous-recovery/3' &&
      acceptance.wholeAttemptComplete === false &&
      acceptance.externalUsage === 'UNKNOWN',
    'h06-series-legacy-authority',
  );
  const owned = object(outcome.outcome),
    writer = object(owned.writer);
  const renewal = retain(writer.renewal, join(root, 'legacy-renew.json'));
  const crossing = retain(writer.crossing, join(root, 'legacy-crossing.json'));
  const failure = retain(owned.initialFailure, join(root, 'f01', 'receipt.json'));
  requireContract(same(read(renewal).initialFailure, failure), 'h06-series-legacy-continuity');
  checkH06NativeLegacyCrossing(request.binding, renewal, crossing, request.stimulus.longStageMs);

  const phases = openH06DelegatedPhaseLedger(claimPin).inspect().phases;
  const acceptanceEvidence = object(acceptance.evidence);
  requireContract(
    same(
      phases.map(({ phase }) => phase.stage),
      h06DelegatedStages,
    ),
    'h06-series-legacy-phases',
  );
  const results = phases.map(({ phase, intent, outcome }) => {
    const settlement = retain(outcome);
    const settled = read(retain(read(settlement).outcome));
    const result = retain(settled.result, join(root, `delegated-${phase.stage}-result.json`));
    return { stage: phase.stage, intent: retain(intent), settlement, result };
  });
  requireContract(
    same(acceptanceEvidence.phases, results) && same(writer.result, results.at(-1)?.result),
    'h06-series-legacy-phases',
  );

  function stopped(coder: Record<string, unknown>, value: unknown) {
    const ref = object(value),
      session = object(coder.session),
      copy = object(coder.copy);
    const proof = read(retain({ path: ref.locator, sha256: ref.hash }));
    return (
      proof.kind === 'writers-stopped' &&
      proof.thread === session.id &&
      proof.active_turn === false &&
      proof.remaining_terminals === 0 &&
      proof.remaining_processes === 0 &&
      typeof proof.before_hash === 'string' &&
      proof.before_hash === proof.after_hash &&
      object(proof.owned).complete === true &&
      object(proof.owned).thread === session.id &&
      object(proof.owned).tree === object(copy.binding).root
    );
  }
  const warm = object(read(results[1]!.result).writer);
  const cold = object(read(results[3]!.result).writer);
  requireContract(
    [warm, cold].every((writer) => same(read(retain(writer.live)).writer, writer.coder)),
    'h06-series-legacy-live',
  );
  const completed = object(read(results[5]!.result).completed);
  const completion = retain(completed.coder);
  const final = read(completion);
  requireContract(
    same(completion, acceptanceEvidence.completionCoder) && final.status === 'integrated',
    'h06-series-legacy-completion',
  );
  const shutdown =
    stopped(object(warm.coder), warm.stopped) &&
    stopped(object(cold.coder), cold.stopped) &&
    stopped(final, final.stopped);

  const ledger = openH06NativeTurnLedger(join(root, 'legacy-turns'), {
    mode: 'reopen',
    operationId: request.binding.operationId,
    maxManagedStarts: request.budget.maxManagedStarts,
    legacy: true,
  }).inspect();
  requireContract(
    same(ledger, managed.ledger) && Array.isArray(managed.threads) && managed.threads.length === 3,
    'h06-series-legacy-managed',
  );
  const expected: Omit<ComparisonParticipant, 'through'>[] = [];
  const participants: ComparisonParticipant[] = [];
  const sealed: unknown[] | null = Array.isArray(managed.participants)
    ? managed.participants
    : null;
  const phasesByWriter = ['warm', 'cold', 'completion'];
  for (const [index, phase] of phasesByWriter.entries()) {
    const snapshot = retain(
      managed.threads[index],
      join(root, `delegated-${phase}-writer-thread.json`),
    );
    const thread = object(read(snapshot).thread);
    const session = identifier(thread.id);
    const transcript = text(thread.path);
    requireContract(
      transcript.startsWith(claim.grant.sessionsRoot + sep),
      'h06-series-legacy-managed-transcript',
    );
    const admitted = ledger.admissions.filter(({ scope }) => scope.session === session);
    requireContract(admitted.length > 0, 'h06-series-legacy-managed-inventory');
    const identity = {
      session,
      transcript,
      run: request.binding.operationId,
      stage: 'execution' as const,
    };
    expected.push(identity);
    const turns = admitted.flatMap(({ response }) =>
      response === null ? [] : [{ turn: response.turnId }],
    );
    const saved = sealed?.find((value: unknown) => object(value).session === session);
    const through = saved === undefined ? null : object(object(saved).through);
    const bytes = readH06NativeJournal(transcript);
    const rows =
      through === null
        ? bytes
        : (() => {
            const match = /^(.*)#L([1-9]\d*)$/u.exec(String(through.locator));
            requireContract(match?.[1] === transcript, 'h06-series-legacy-managed-terminal');
            return Buffer.from(
              bytes.toString().split('\n').slice(0, Number(match[2])).join('\n') + '\n',
            );
          })();
    const terminal =
      turns.length === 0
        ? null
        : observeH06NativeLegacyTranscript(rows, thread, {
            thread: session,
            turns,
          });
    if (terminal !== null)
      participants.push({
        ...identity,
        through: { locator: `${transcript}#L${terminal.line}`, hash: terminal.hash },
      });
  }
  const usage = checkH06NativeUsage({ expected, participants, budget: request.budget });
  if (sealed !== null)
    requireContract(
      same(participants, sealed) && same(usage.receipts, managed.receipts),
      'h06-series-legacy-managed-changed',
    );
  const { responses, inputUncached, inputCached, output } = usage.knownSubtotal;
  const receipt =
    profile !== undefined &&
    shutdown &&
    outcome.status === 'completed' &&
    acceptance.status === 'PASS' &&
    managed.status === 'WITHIN_BUDGET' &&
    usage.status === 'WITHIN_BUDGET' &&
    sealed !== null &&
    ledger.status === 'RECORDED' &&
    ledger.used === 9
      ? {
          root: {
            session: claim.request.chat.threadId,
            workspace: claim.request.chat.workspace,
            transcript: claim.source.transcript,
            turnId: claim.source.turnId,
            source: claim.source.source,
            startedAtMs: claim.startedAt,
          },
          actorDeliveries: results.slice(0, -1).map(({ settlement }) => {
            const outcome = read(retain(read(settlement).outcome));
            return verifyH06DelegatedDelivery(read(retain(outcome.delivery)));
          }),
          managed: { receipts: usage.receipts, starts: ledger.used },
        }
      : null;
  if (receipt !== null) {
    evidence.forEach(({ locator, hash }) => readH04Pin({ path: locator, sha256: hash }));
    evidence.push(...verifyH06ManagedProfiles(participants, ledger.admissions, profile!));
  }
  return {
    stopped: shutdown,
    budgetExceeded: usage.status === 'OVER_BUDGET',
    knownSubtotal: { observedResponses: responses, inputUncached, inputCached, output },
    evidence,
    receipt,
    failed: outcome.status === 'acceptance-failed' || acceptance.status === 'FAIL',
  };
}
