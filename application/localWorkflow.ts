import { applyLocalEvent, startLocalRun } from '../core/localRun.js';
import type { LocalEvent, RunSpec } from '../core/localRun.js';
import { requireWorkflow } from '../core/connection.js';
import type { LocalRuns, RunInputs } from '../ports/localRuns.js';

export async function beginLocalWorkflow(
  spec: RunSpec,
  generation: number,
  runs: LocalRuns,
  inputs: RunInputs,
) {
  requireWorkflow((await runs.read()) === null, 'run-already-exists');
  const run = startLocalRun(spec, generation);
  await inputs.verify(run);
  await runs.save(null, run);
  return run;
}
export async function advanceLocalWorkflow(event: LocalEvent, runs: LocalRuns, inputs: RunInputs) {
  const run = await runs.read();
  requireWorkflow(run !== null, 'run-not-found');
  const next = applyLocalEvent(run, event);
  if (event.type === 'READY') await inputs.verify(next);
  if (next !== run) await runs.save(run, next);
  return next;
}
