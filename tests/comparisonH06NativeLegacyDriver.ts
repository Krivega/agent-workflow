import { join } from 'node:path';
import { discoverChat } from '../adapters/codex/chatDiscovery.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { identifier, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06NativeSessionsRoot } from './comparisonH06NativeAttempt.js';
import { resolveH06NativeGrant } from './comparisonH06NativeAuthority.js';
import { checkH06NativeLegacyDispatch } from './comparisonH06NativeLegacyDispatch.js';
import { checkH06NativeLegacyEvidence } from './comparisonH06NativeLegacyEvidence.js';
import {
  planH06NativeLegacyOperator,
  runH06NativeLegacyWithActor,
} from './comparisonH06NativeLegacyOperator.js';
import { checkH06NativeLegacyUsageSummary } from './comparisonH06NativeLegacyUsageSummary.js';

type LegacyStage = Parameters<typeof runH06NativeLegacyWithActor>[3];
type Actor = Parameters<typeof runH06NativeLegacyWithActor>[2];

interface LegacyPhaseEvidence {
  pause: H04Pin;
  stop: H04Pin;
  resume: H04Pin;
  thread: H04Pin;
}

interface LegacyActorResult {
  warm: LegacyPhaseEvidence;
  cold: LegacyPhaseEvidence;
  completion: { coder: H04Pin; thread: H04Pin };
  council: { roles: unknown[] } | null;
}

type ActorStage = (
  input: {
    actor: Actor;
    claim: H04Pin;
    started: H04Pin;
    initialFailure: H04Pin;
    workDeadlineMs: number;
    stopDeadlineMs: number;
  },
  signal: AbortSignal,
) => Promise<LegacyActorResult>;

function pin(path: string): H04Pin {
  return { path, sha256: digest(h01RawFile(path)) };
}

/** Coordinate the Legacy actor from its exact initial grant and reconcile retained phase proofs. */
export async function runH06NativeLegacyDriver(
  value: unknown,
  actorStage: ActorStage,
  signal: AbortSignal,
) {
  const plan = planH06NativeLegacyOperator(value);
  const { binding, bootstrap, evidenceRoot } = plan.request;
  const actorId = identifier(object(JSON.parse(readH04Pin(bootstrap).toString())).actorId);
  const { transcript, anchor } = await discoverChat(
    binding.workspaceRoot,
    h06NativeSessionsRoot(),
    actorId,
  );
  const actor = { transcript, anchor };
  const authority = await resolveH06NativeGrant(plan);
  signal.throwIfAborted();
  const stage = async (...[verify, initialFailure, preparation]: Parameters<LegacyStage>) => {
    const { receipt: claim, workDeadlineMs, stopDeadlineMs } = preparation.claim;
    const remaining = workDeadlineMs - Date.now();
    requireContract(remaining > 0, 'h06-legacy-driver-deadline');
    const live = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    const started = pin(join(evidenceRoot, 'legacy-operator-start.json'));
    verify();
    live.throwIfAborted();
    const result = await actorStage(
      { actor, claim, started, initialFailure, workDeadlineMs, stopDeadlineMs },
      live,
    );
    live.throwIfAborted();
    verify();
    return result;
  };
  const owned = await runH06NativeLegacyWithActor(plan.request, authority, actor, stage);
  const result = owned.writer.result;
  const started = owned.start;
  const control = await checkH06NativeLegacyEvidence({
    started,
    warm: { pause: result.warm.pause, stop: result.warm.stop, resume: result.warm.resume },
    cold: { pause: result.cold.pause, stop: result.cold.stop, resume: result.cold.resume },
  });
  const dispatchInput = {
    database: pin(join(evidenceRoot, 'legacy-store', 'store.sqlite')),
    warm: { stop: result.warm.stop, thread: result.warm.thread },
    cold: { stop: result.cold.stop, thread: result.cold.thread },
    completion: result.completion,
  };
  const dispatch = checkH06NativeLegacyDispatch({ started, ...dispatchInput });
  requireContract(
    dispatch.completion?.status === 'HARNESS_EVIDENCE_VERIFIED',
    'h06-legacy-driver-completion',
  );
  const usage = checkH06NativeLegacyUsageSummary({
    started,
    dispatch: dispatchInput,
    parent: { usageStart: owned.parentUsage, coldResume: result.cold.resume },
    council: result.council,
  });
  return {
    claim: owned.claim,
    started,
    continuity: owned.continuity,
    control,
    dispatch,
    usage,
    qualification: false,
  } as const;
}
