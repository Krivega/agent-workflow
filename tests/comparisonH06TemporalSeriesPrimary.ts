import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import type { InputRef } from '../core/localRun.js';
import { object, requireContract } from '../src/contracts/project.js';
import { h01ReadPin } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  verifyH06ManagedProfiles,
  type H06ManagedProfile,
} from './comparisonH06ManagedProfiles.js';
import { openH06NativeAttemptTurnLedger } from './comparisonH06NativeAttempt.js';
import { checkH06NativeFailure } from './comparisonH06NativeFailure.js';
import { readH06NativeTemporalStart } from './comparisonH06NativeTemporal.js';
import { checkH06NativeTemporalEvidence } from './comparisonH06NativeTemporalEvidence.js';
import {
  checkH06NativeTemporalAttemptUsage,
  sealH06NativeUsage,
} from './comparisonH06NativeUsage.js';
import { readH06TemporalAutonomousAuthority } from './comparisonH06TemporalAutonomousAuthority.js';

/** Verify the owned Temporal chain and its managed costs. External usage remains unknown. */
export function verifyH06TemporalSeriesPrimary(
  result: unknown,
  evidenceRoot: string,
  requestHash: string,
  profile?: H06ManagedProfile,
) {
  const row = object(result),
    primary = object(row.primary),
    server = object(row.server);
  const evidence: InputRef[] = [];
  function record(pin: H04Pin) {
    evidence.push({ locator: pin.path, hash: pin.sha256 });
    return pin;
  }
  function bound(value: unknown, path: string) {
    const pin = h04Pin(value);
    requireContract(pin.path === path, 'h06-series-temporal-path');
    return record(pin);
  }
  function read(value: unknown, path: string) {
    return object(JSON.parse(readH04Pin(bound(value, path)).toString()));
  }

  const authority = readH06TemporalAutonomousAuthority(record(h04Pin(primary.authority)));
  requireContract(
    authority.requestHash === requestHash && authority.request.evidenceRoot === evidenceRoot,
    'h06-series-temporal-authority',
  );
  const started = record(h04Pin(primary.started));
  const execution = readH06NativeTemporalStart(started);
  requireContract(
    execution.evidence === evidenceRoot &&
      execution.start.operationId === authority.request.binding.operationId &&
      same(execution.start.controlMode, {
        kind: 'temporal-autonomous/3',
        authority: authority.receipt,
      }),
    'h06-series-temporal-execution',
  );
  checkH06NativeFailure(
    authority.request.binding,
    bound(execution.start.initialFailure, join(evidenceRoot, 'f01', 'receipt.json')),
  );
  const warm = object(primary.warm),
    cold = object(primary.cold);
  for (const phase of [warm, cold])
    for (const key of ['pauseAck', 'status', 'host', 'resumeAck'] as const)
      record(h04Pin(phase[key]));
  const chain = checkH06NativeTemporalEvidence({ started, warm, cold });
  requireContract(same(chain, row.evidence), 'h06-series-temporal-chain');
  read(primary.history, join(evidenceRoot, 'history-complete.json'));

  const serverRoot = authority.server.root;
  const ready = read(server.ready, join(serverRoot, 'server-ready.json'));
  const stopped = read(server.stopped, join(serverRoot, 'server-stop.json'));
  const launch = read(stopped.launch, join(serverRoot, 'server-launch.json'));
  const { kind, process, ...serverBinding } = ready;
  const serverPid = object(process).pid;
  requireContract(
    kind === 'comparison-h06-native-temporal-server/2' &&
      same(serverBinding, authority.server.expected) &&
      launch.kind === 'comparison-h06-native-temporal-server-launch/2' &&
      same(launch.expected, authority.server.expected) &&
      launch.deadlineMs === authority.stopDeadlineMs &&
      launch.stopReserveMs === authority.budget.reserveMs &&
      stopped.kind === 'comparison-h06-native-temporal-server-stop/2' &&
      stopped.requestHash === requestHash &&
      same(stopped.ready, server.ready),
    'h06-series-temporal-server',
  );
  const processIds = new Set<unknown>();
  function confirmStop(pid: unknown, proof: unknown) {
    const receipt = object(proof);
    requireContract(
      typeof pid === 'number' &&
        Number.isSafeInteger(pid) &&
        pid > 1 &&
        !processIds.has(pid) &&
        receipt.stopped === true &&
        Array.isArray(receipt.pids) &&
        receipt.pids.includes(pid),
      'h06-series-temporal-stop',
    );
    processIds.add(pid);
    return receipt;
  }
  confirmStop(serverPid, stopped.receipt);
  const { workerStops, transportStops } = primary;
  requireContract(
    Array.isArray(workerStops) && workerStops.length === 2,
    'h06-series-temporal-worker-inventory',
  );
  requireContract(
    Array.isArray(transportStops) && transportStops.length === 3,
    'h06-series-temporal-transport-inventory',
  );
  for (const [index, [stage, phase]] of (
    [
      ['initial-and-warm', warm],
      ['cold', cold],
    ] as const
  ).entries()) {
    const worker = read(workerStops[index], join(serverRoot, `worker-${stage}-outcome.json`));
    const host = object(JSON.parse(readH04Pin(h04Pin(phase.host)).toString()));
    const receipt = confirmStop(worker.pid, worker.receipt);
    requireContract(
      worker.kind === 'h06-native-temporal-process-outcome/1' &&
        worker.stage === stage &&
        worker.pid === object(host.owner).pid &&
        same(worker.server, server.ready) &&
        worker.workDeadlineMs === authority.workDeadlineMs &&
        worker.stopDeadlineMs === authority.stopDeadlineMs &&
        typeof worker.recordedAt === 'number' &&
        Number.isSafeInteger(worker.recordedAt) &&
        worker.recordedAt >= authority.startedAt &&
        worker.recordedAt <= authority.stopDeadlineMs &&
        worker.observedExit === true &&
        worker.failure === null &&
        receipt.code === 0 &&
        receipt.signal === null &&
        receipt.killed === false &&
        receipt.deadlineReached === false,
      'h06-series-temporal-worker',
    );
  }

  const stops = ['initial', 'warm', 'cold'].map((phase, index) =>
    bound(transportStops[index], join(evidenceRoot, `transport-${phase}`, 'transport-stop.json')),
  );
  const claim = record(authority.nativeClaim);
  const sealed = Array.isArray(primary.participants)
    ? (primary.participants as ComparisonParticipant[])
    : null;
  const { binding } = checkH06NativeTemporalAttemptUsage({ claim, stops, participants: [] });
  if (sealed !== null)
    requireContract(
      same(
        sealed.map(({ through, ...identity }) => {
          requireContract(through !== undefined, 'h06-series-temporal-managed-end');
          return identity;
        }),
        binding.participants,
      ),
      'h06-series-temporal-managed-inventory',
    );
  const usage = checkH06NativeTemporalAttemptUsage({
    claim,
    stops,
    participants: sealed ?? binding.participants.map(sealH06NativeUsage),
  });
  requireContract(same(usage, row.usage), 'h06-series-temporal-usage-changed');
  const { responses, inputUncached, inputCached, output } = usage.knownSubtotal;
  evidence.forEach(h01ReadPin);
  const acceptance = row.acceptance === undefined ? null : object(row.acceptance);
  const complete =
    profile !== undefined &&
    sealed !== null &&
    acceptance?.profile === 'h06-autonomous-recovery/3' &&
    acceptance.status === 'PASS' &&
    row.finalization === 'WITHIN_PARENT_DEADLINE' &&
    usage.status === 'WITHIN_BUDGET' &&
    object(row.duration).status === 'LONG_STAGE_VERIFIED' &&
    object(row.duration).minimumMs === authority.request.stimulus.longStageMs &&
    object(row.result).status === 'done' &&
    object(row.replay).status === 'REPLAY_VERIFIED' &&
    same(object(row.replay).history, primary.history) &&
    object(row.replay).workflowId === chain.workflowId &&
    object(row.replay).runId === chain.runId &&
    authority.grant.sourceTurnId === authority.grant.anchor.turn_id;
  const ledger = complete ? openH06NativeAttemptTurnLedger(claim).inspect() : null;
  if (ledger !== null)
    evidence.push(...verifyH06ManagedProfiles(sealed!, ledger.admissions, profile!));
  const receipt =
    ledger !== null
      ? {
          root: {
            session: authority.request.chat.threadId,
            workspace: authority.request.chat.workspace,
            transcript: authority.grant.transcript,
            turnId: authority.grant.sourceTurnId,
            source: authority.grant.source,
            startedAtMs: authority.startedAt,
          },
          managed: { receipts: usage.receipts, starts: ledger.used },
        }
      : null;
  return {
    stopped: usage.binding.unavailable.length === 0,
    budgetExceeded: usage.status === 'OVER_BUDGET',
    knownSubtotal: { observedResponses: responses, inputUncached, inputCached, output },
    evidence,
    receipt,
    failed: acceptance?.status === 'FAIL',
  };
}
