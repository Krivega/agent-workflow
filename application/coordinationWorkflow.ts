import {
  coordinationSeed,
  applyCoordination,
  createCoordination,
  replayCoordination,
} from '../core/coordination.js';
import type { CoordinationEvent, CoordinationLog, CoordinationSeed } from '../core/coordination.js';
import { requireWorkflow } from '../core/connection.js';
import { sameValue } from '../core/equality.js';
import type { CoordinationJournal, CoordinationInputs } from '../ports/coordinationJournal.js';
import type { AgentSessions } from '../ports/agentSessions.js';
import { collectInputRefs } from '../core/inputRefs.js';
import { compareInputs } from '../core/evidence.js';

export async function beginCoordination(
  seed: CoordinationSeed,
  journal: CoordinationJournal,
  inputs: CoordinationInputs,
) {
  createCoordination(seed);
  requireWorkflow((await journal.read()) === null, 'coordination-already-exists');
  for (const scope of [...seed.children.map((c) => c.scope), seed.integration.scope])
    await inputs.workspace(scope);
  await inputs.evidence.verify(collectInputRefs(seed));
  const log: CoordinationLog = { schema_version: 1, seed: structuredClone(seed), events: [] };
  await journal.save(null, log);
  return replayCoordination(log);
}
export async function advanceCoordination(
  event: CoordinationEvent,
  journal: CoordinationJournal,
  inputs: CoordinationInputs,
  sessions: Pick<AgentSessions, 'inspect'>,
) {
  const log = await journal.read();
  requireWorkflow(log !== null, 'coordination-not-found');
  const state = replayCoordination(log);
  const next = applyCoordination(coordinationSeed(log), state, event);
  if (next === state) return state;
  if ('receipt' in event) await inputs.evidence.verify([event.receipt]);
  if (event.type === 'OBSERVE' && event.result !== null)
    await inputs.evidence.verify([event.result.evidence, event.result.acceptance.evidence]);
  if (event.type === 'INTEGRATE')
    await inputs.evidence.verify([event.boundaries.evidence, event.validation.evidence]);
  if (event.type === 'RESERVE')
    await inputs.workspace(state.children.find((c) => c.task.id === event.child)!.task.scope);
  if (event.type === 'BIND') {
    const task = state.children.find((c) => c.task.id === event.child)!.task;
    const session = await sessions.inspect(event.session);
    requireWorkflow(
      session !== null &&
        session.id === event.session &&
        session.project_id === task.native_project_id &&
        session.workspace === task.scope.workspace &&
        session.read_only === task.read_only &&
        session.model === task.profile.model &&
        session.effort === task.profile.effort &&
        session.forked_from === null,
      'child-identity-unconfirmed',
    );
  }
  if (event.type === 'ACCEPT') {
    const result = next.children.find((c) => c.task.id === event.child)!.result!;
    requireWorkflow(
      compareInputs(
        result.inputs,
        await (await inputs.workspace(result.scope)).current(event.current),
      ) === 'applicable',
      'child-inputs-changed',
    );
  }
  if (event.type === 'INTEGRATE') {
    requireWorkflow(
      compareInputs(
        event.inputs,
        await (
          await inputs.workspace(coordinationSeed(log).integration.scope)
        ).current(event.inputs),
      ) === 'applicable',
      'integration-inputs-changed',
    );
    for (const child of next.children)
      requireWorkflow(
        compareInputs(
          child.result!.inputs,
          await (
            await inputs.workspace(child.task.scope)
          ).current(event.child_inputs[child.task.id]!),
        ) === 'applicable',
        'integration-child-inputs-changed',
      );
  }
  // Every external observation may re-enter cancellation or replace the owner.
  requireWorkflow(sameValue(await journal.read(), log), 'coordination-observation-stale');
  await journal.save(log, { ...log, events: [...log.events, event] });
  return next;
}
