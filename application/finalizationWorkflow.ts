import { applyFinalization, createFinalization, replayFinalization } from '../core/finalization.js';
import type { FinalizationSeed, FinalizationEvent } from '../core/finalization.js';
import type { FinalizationJournal, FinalizationProofs } from '../ports/finalization.js';
import { requireWorkflow } from '../core/connection.js';
import { sameValue } from '../core/equality.js';
import { collectInputRefs } from '../core/inputRefs.js';
export async function beginFinalization(
  seed: FinalizationSeed,
  journal: FinalizationJournal,
  proofs: FinalizationProofs,
) {
  createFinalization(seed);
  requireWorkflow((await journal.read()) === null, 'finalization-already-exists');
  await proofs.verify([
    seed.authority,
    seed.done,
    seed.stopped,
    ...seed.run.spec.procedures,
    ...seed.run.spec.rules,
    ...(seed.policy.mode === 'test-cleanup' ? [seed.policy.authority] : []),
  ]);
  await proofs.prepare(seed);
  const log = { schema_version: 1 as const, seed: structuredClone(seed), events: [] };
  await journal.save(null, log);
  return replayFinalization(log);
}
export async function advanceFinalization(
  event: FinalizationEvent,
  journal: FinalizationJournal,
  proofs: FinalizationProofs,
) {
  const log = await journal.read();
  requireWorkflow(log !== null, 'finalization-not-found');
  const current = replayFinalization(log),
    next = applyFinalization(log.seed, current, event);
  if (next === current) return current;
  await proofs.verify(collectInputRefs(event));
  await proofs.confirm(log.seed, current, event);
  requireWorkflow(sameValue(log, await journal.read()), 'finalization-observation-stale');
  await journal.save(log, { ...log, events: [...log.events, event] });
  return next;
}
