import { applyCoder, assertCoderParent, coderOwnsSource, reserveCoder } from '../core/coder.js';
import type { CoderAction, CoderBrief, CoderRun, CoderEvent } from '../core/coder.js';
import { requireWorkflow } from '../core/connection.js';
import { sameValue } from '../core/equality.js';
import type { CoderSessions, CoderWorkspaces } from '../ports/coder.js';
import type { LocalRuns } from '../ports/localRuns.js';
import type { WorkflowJournal } from '../ports/workflowJournal.js';

export interface CoderDependencies {
  journal: WorkflowJournal;
  runs: LocalRuns;
  workspaces: CoderWorkspaces;
  sessions: CoderSessions;
}
async function parent(deps: CoderDependencies, brief: CoderBrief) {
  const local = await deps.runs.read();
  requireWorkflow(local !== null, 'coder-parent-missing');
  assertCoderParent(local, brief);
  return local;
}
async function save(deps: CoderDependencies, run: CoderRun, operation: string) {
  const local = await parent(deps, run.brief);
  const state = await deps.journal.read();
  requireWorkflow(
    state.execution !== null &&
      state.execution.generation === local.generation &&
      state.execution.status === 'implementing',
    'coder-execution-not-implementing',
  );
  await deps.journal.ensureReady(state.execution);
  const previous = state.coders?.[run.brief.id];
  if (previous !== undefined && sameValue(previous, run)) return previous;
  if (previous === undefined) {
    reserveCoder(local, run.brief, run.baseline, Object.values(state.coders ?? {}));
    requireWorkflow(run.history.length === 0, 'coder-reservation-history-mismatch');
  } else {
    const last = run.history.at(-1);
    requireWorkflow(
      last !== undefined &&
        sameValue(applyCoder(previous, JSON.parse(last.payload) as CoderEvent), run),
      'coder-revision-conflict',
    );
  }
  const coders = { ...state.coders, [run.brief.id]: run };
  await deps.journal.save(
    state,
    {
      ...state,
      schema_version: 2,
      revision: state.revision + 1,
      coders,
      execution: {
        ...state.execution,
        schema_version: 3,
        coder_reservations: Object.values(coders)
          .filter(coderOwnsSource)
          .map((child) => child.brief.id)
          .sort(),
      },
    },
    operation,
  );
  return (await deps.journal.read()).coders![run.brief.id]!;
}
async function step(deps: CoderDependencies, id: string, action: CoderAction) {
  const run = (await deps.journal.read()).coders?.[id];
  requireWorkflow(run !== undefined, 'coder-not-found');
  await parent(deps, run.brief);
  const event = { ...action, id: `${id}:${action.type}`, generation: run.brief.generation };
  const next = applyCoder(run, event);
  return next === run ? run : save(deps, next, `coder:${event.id}`);
}
export async function startCoder(brief: CoderBrief, deps: CoderDependencies): Promise<CoderRun> {
  const existing = (await deps.journal.read()).coders?.[brief.id];
  if (existing) {
    requireWorkflow(sameValue(existing.brief, brief), 'coder-brief-replay-conflict');
    await parent(deps, brief);
    return existing;
  }
  const local = await parent(deps, brief);
  const baseline = await deps.workspaces.capture(brief);
  const state = await deps.journal.read();
  const run = reserveCoder(local, brief, baseline, Object.values(state.coders ?? {}));
  return save(deps, run, `coder:${brief.id}:reserve`);
}
export async function launchCoder(id: string, deps: CoderDependencies): Promise<CoderRun> {
  let run = (await deps.journal.read()).coders?.[id];
  requireWorkflow(run !== undefined, 'coder-not-found');
  await parent(deps, run.brief);
  if (run.status === 'reserved') run = await step(deps, id, { type: 'COPY_INTENT' });
  if (run.status === 'copying')
    run = await step(deps, id, { type: 'COPIED', copy: await deps.workspaces.copy(run) });
  const freshCreate = run.status === 'copied';
  if (freshCreate) run = await step(deps, id, { type: 'CREATE_INTENT' });
  if (run.status === 'creating') {
    const created = freshCreate
      ? await deps.sessions.create(run)
      : await deps.sessions.recoverCreate(run);
    requireWorkflow(created !== null, 'coder-create-outcome-unknown');
    if (created.outcome === 'not-started')
      return step(deps, id, { type: 'NOT_STARTED', receipt: created.receipt });
    run = await step(deps, id, { type: 'BIND', session: created.session });
  }
  const freshLoad = run.status === 'created';
  if (freshLoad) run = await step(deps, id, { type: 'LOAD_INTENT' });
  if (run.status === 'loading') {
    const receipt = await deps.sessions.load(run, freshLoad);
    await deps.workspaces.verifyCopy(run);
    run = await step(deps, id, { type: 'LOADED', receipt });
  }
  const freshSend = run.status === 'ready';
  if (freshSend)
    run = await step(deps, id, { type: 'SEND_INTENT', delivery: `coder:${id}:implementation` });
  if (run.status === 'sending')
    run = await step(deps, id, { type: 'SENT', turn: await deps.sessions.send(run, freshSend) });
  return run;
}

export async function runCoder(id: string, deps: CoderDependencies): Promise<CoderRun> {
  let run = await launchCoder(id, deps);
  if (run.status === 'running')
    run = await step(deps, id, { type: 'RESULT', result: await deps.sessions.result(run) });
  if (run.status === 'candidate')
    run = await step(deps, id, { type: 'STOP_INTENT', reason: 'complete' });
  if (run.status === 'stopping')
    run = await step(deps, id, { type: 'STOPPED', receipt: await deps.sessions.stop(run) });
  if (run.status === 'stopped') run = await step(deps, id, { type: 'RELEASE' });
  return run;
}
export async function integrateCoder(id: string, deps: CoderDependencies): Promise<CoderRun> {
  let run = (await deps.journal.read()).coders?.[id];
  requireWorkflow(run !== undefined, 'coder-not-found');
  await parent(deps, run.brief);
  if (run.status === 'integrated') return run;
  if (run.status === 'released') {
    const intent = await deps.workspaces.integration(run);
    run = await step(deps, id, { type: 'INTEGRATE_INTENT', intent });
  }
  requireWorkflow(run.status === 'integrating', 'coder-not-released');
  const receipt = await deps.workspaces.integrate(run);
  return step(deps, id, { type: 'INTEGRATED', receipt });
}
export async function cancelCoder(id: string, deps: CoderDependencies): Promise<CoderRun> {
  let run = (await deps.journal.read()).coders?.[id];
  requireWorkflow(run !== undefined, 'coder-not-found');
  await parent(deps, run.brief);
  if (['cancelled', 'not-started'].includes(run.status)) return run;
  requireWorkflow(
    !['integrating', 'integrated'].includes(run.status),
    'coder-integration-already-started',
  );
  if (run.status === 'creating' && run.session === null) {
    const session = await deps.sessions.recoverCreate(run);
    requireWorkflow(session !== null, 'coder-create-outcome-unknown');
    if (session.outcome === 'not-started')
      return step(deps, id, { type: 'NOT_STARTED', receipt: session.receipt });
    run = await step(deps, id, { type: 'BIND', session: session.session });
  }
  if (['reserved', 'copied', 'released'].includes(run.status))
    return step(deps, id, { type: 'CANCEL_IDLE', receipt: run.stopped ?? run.baseline.evidence });
  requireWorkflow(run.session !== null, 'coder-create-outcome-unknown');
  if (run.status !== 'stopping' && run.status !== 'stopped')
    run = await step(deps, id, { type: 'STOP_INTENT', reason: 'cancel' });
  if (run.status === 'stopping')
    run = await step(deps, id, { type: 'STOPPED', receipt: await deps.sessions.stop(run) });
  run = await step(deps, id, { type: 'RELEASE' });
  if (run.status === 'released')
    return step(deps, id, { type: 'CANCEL_IDLE', receipt: run.stopped! });
  return run;
}
