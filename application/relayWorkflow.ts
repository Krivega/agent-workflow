import { applyRelay, createRelay, replayRelay } from '../core/relay.js';
import type { RelaySeed, RelayEvent } from '../core/relay.js';
import type { RelayJournal, RelayProofs } from '../ports/relayJournal.js';
import { requireWorkflow } from '../core/connection.js';
import { sameValue } from '../core/equality.js';
import { collectInputRefs } from '../core/inputRefs.js';

export async function beginRelay(seed: RelaySeed, journal: RelayJournal, proofs: RelayProofs) {
  createRelay(seed);
  requireWorkflow((await journal.read()) === null, 'relay-already-exists');
  await proofs.verify([
    seed.authority,
    seed.snapshot,
    seed.trigger.evidence,
    ...seed.progress.child_evidence,
    ...seed.predecessor.spec.procedures,
    ...seed.predecessor.spec.rules,
  ]);
  await proofs.prepare(seed);
  const log = { schema_version: 1 as const, seed: structuredClone(seed), events: [] };
  await journal.save(null, log);
  return replayRelay(log);
}
export async function advanceRelay(event: RelayEvent, journal: RelayJournal, proofs: RelayProofs) {
  const log = await journal.read();
  requireWorkflow(log !== null, 'relay-not-found');
  const state = replayRelay(log);
  const next = applyRelay(log.seed, state, event);
  if (next === state) return state;
  await proofs.verify(collectInputRefs(event));
  await proofs.confirm(log.seed, state, event);
  requireWorkflow(sameValue(log, await journal.read()), 'relay-observation-stale');
  await journal.save(log, { ...log, events: [...log.events, event] });
  return next;
}

import type { RelaySessions } from '../ports/relaySessions.js';
export async function dispatchRelay(
  operation: string,
  journal: RelayJournal,
  proofs: RelayProofs,
  sessions: RelaySessions,
) {
  const log = await journal.read();
  requireWorkflow(log !== null, 'relay-not-found');
  const current = replayRelay(log);
  requireWorkflow(current.phase === 'released', 'relay-create-already-reserved');
  const reserved = await advanceRelay(
    { type: 'RESERVE', operation, id: `${operation}:reserve`, revision: current.revision },
    journal,
    proofs,
  );
  // Unknown response intentionally leaves the durable reservation. Never retry create here.
  const session = await sessions.create(log.seed);
  return advanceRelay(
    { type: 'IDENTIFY', session, id: `${operation}:identity`, revision: reserved.revision },
    journal,
    proofs,
  );
}
