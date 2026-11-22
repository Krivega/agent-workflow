import type { Json } from './evidence.js';
import type { RelaySeed, RelayState } from './relay.js';
import { successorRun } from './relay.js';
import { applyLocalEvent } from './localRun.js';
import type { LocalRun } from './localRun.js';
import { object, requireWorkflow } from './connection.js';
import { sameValue } from './equality.js';
import { replayCoordination } from './coordination.js';
import type { CoordinationLog } from './coordination.js';

export function readySuccessor(seed: RelaySeed, state: RelayState): LocalRun {
  requireWorkflow(state.successor !== null && state.loaded !== null, 'successor-load-required');
  let run = successorRun(seed, state.successor);
  run = applyLocalEvent(run, {
    type: 'LOAD',
    event_id: 'relay-load',
    expected_revision: 0,
    generation: run.generation,
    receipt: state.loaded,
  });
  run = applyLocalEvent(run, {
    type: 'READY',
    event_id: 'relay-ready',
    expected_revision: 1,
    generation: run.generation,
  });
  return {
    ...run,
    elapsed_ms: seed.predecessor.elapsed_ms,
    external_wait_ms: seed.predecessor.external_wait_ms,
  };
}
export function adoptedCheckpoint(seed: RelaySeed, successor: LocalRun): Json {
  const original = object(seed.checkpoint);
  requireWorkflow(
    sameValue(original.local_run, seed.predecessor),
    'source-local-checkpoint-mismatch',
  );
  requireWorkflow(
    successor.status === 'ready' &&
      successor.generation === seed.predecessor.generation + 1 &&
      successor.spec.run_id === `${seed.id}:successor`,
    'successor-not-adoptable',
  );
  const result: Record<string, unknown> = { ...structuredClone(original), local_run: successor };
  if (original.workflow !== undefined) {
    const workflow = object(result.workflow);
    requireWorkflow(
      [1, 2].includes(workflow.schema_version as number),
      'unsupported-relay-workflow',
    );
    requireWorkflow(
      workflow.coders === undefined ||
        Object.values(object(workflow.coders)).every((run) =>
          ['integrated', 'cancelled', 'not-started'].includes(String(object(run).status)),
        ),
      'coder-writers-pending',
    );
    if (workflow.execution !== null) {
      const execution = object(workflow.execution);
      requireWorkflow(
        [2, 3].includes(execution.schema_version as number) &&
          execution.generation === seed.predecessor.generation,
        'unsupported-relay-execution',
      );
      workflow.execution = { ...execution, generation: successor.generation };
    }
    result.workflow = workflow;
  }
  if (original.coordination !== undefined) {
    const source = original.coordination as unknown as CoordinationLog;
    const adopted: CoordinationLog = { schema_version: 2, source, run: successor, events: [] };
    replayCoordination(adopted);
    result.coordination = adopted;
  }
  return result as unknown as Json;
}
