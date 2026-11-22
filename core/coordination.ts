import { requireLoadedProcedures } from './localRun.js';
import { createMachine, getInitialSnapshot, transition } from 'xstate';
import { localLocator, requireWorkflow, textField } from './connection.js';
import { assertRunAction, confirmLoad, startLocalRun } from './localRun.js';
import type { InputRef, LocalRun } from './localRun.js';
import type { InputManifest } from './evidence.js';
import { compareInputs } from './evidence.js';
import { sameValue } from './equality.js';
import type { Check } from './execution.js';

export interface WorkScope {
  workspace: string;
  paths: string[];
}
export interface ChildTask {
  id: string;
  scope: WorkScope;
  writer: string;
  read_only: boolean;
  dependencies: string[];
  criterion: string;
  authority: InputRef;
  native_project_id: string;
  profile: { model: string; effort: string };
}
export interface CoordinationSeed {
  schema_version: 1;
  run: LocalRun;
  children: ChildTask[];
  integration: { executor: string; scope: WorkScope; authority: InputRef };
  poll_interval_ms: number;
}
export interface ChildResult {
  scope: WorkScope;
  criterion: string;
  inputs: InputManifest;
  evidence: InputRef;
  acceptance: Check;
}
export interface CoordinatedChild {
  task: ChildTask;
  status:
    | 'pending'
    | 'reserved'
    | 'running'
    | 'completed'
    | 'accepted'
    | 'failed'
    | 'stalled'
    | 'stopping'
    | 'stopped';
  operation: string | null;
  session: string | null;
  cursor: number;
  result: ChildResult | null;
  stopped: InputRef | null;
}
export type CoordinationAction =
  | { type: 'RESERVE'; child: string; operation: string }
  | { type: 'BIND'; child: string; session: string; receipt: InputRef }
  | {
      type: 'OBSERVE';
      child: string;
      session: string;
      cursor: number;
      outcome: 'running' | 'completed' | 'failed' | 'stalled';
      result: ChildResult | null;
      receipt: InputRef;
    }
  | { type: 'ACCEPT'; child: string; current: InputManifest }
  | { type: 'CANCEL'; reason: string }
  | { type: 'STOPPED'; child: string; receipt: InputRef }
  | { type: 'UNAVAILABLE'; receipt: InputRef }
  | { type: 'RESUME'; owner: string; receipt: InputRef }
  | {
      type: 'INTEGRATE';
      executor: string;
      inputs: InputManifest;
      boundaries: Check;
      validation: Check;
      child_inputs: Record<string, InputManifest>;
    };
export type CoordinationEvent = CoordinationAction & {
  id: string;
  revision: number;
  generation: number;
};
export interface Coordination {
  status: 'active' | 'paused' | 'cancelling' | 'cancelled' | 'done';
  revision: number;
  children: CoordinatedChild[];
  integration: Extract<CoordinationAction, { type: 'INTEGRATE' }> | null;
  history: CoordinationEvent[];
}
export type CoordinationLog =
  | { schema_version: 1; seed: CoordinationSeed; events: CoordinationEvent[] }
  | { schema_version: 2; source: CoordinationLog; run: LocalRun; events: CoordinationEvent[] };
export function coordinationSeed(log: CoordinationLog): CoordinationSeed {
  requireWorkflow(
    log.schema_version === 1 || log.schema_version === 2,
    'unsupported-coordination-log',
  );
  if (log.schema_version === 1) return log.seed;
  const prior = coordinationSeed(log.source);
  requireWorkflow(
    log.run.generation === prior.run.generation + 1 &&
      log.run.spec.run_id !== prior.run.spec.run_id &&
      log.run.spec.session_id !== prior.run.spec.session_id &&
      log.run.spec.project_id === prior.run.spec.project_id &&
      log.run.spec.workspace === prior.run.spec.workspace &&
      sameValue(log.run.spec.identity, prior.run.spec.identity),
    'coordination-adoption-mismatch',
  );
  return { ...prior, run: log.run };
}
const machine = createMachine({
  types: {} as { events: { type: 'CANCEL' | 'STOP' | 'UNAVAILABLE' | 'RESUME' | 'INTEGRATE' } },
  initial: 'active',
  states: {
    active: { on: { CANCEL: 'cancelling', UNAVAILABLE: 'paused', INTEGRATE: 'done' } },
    paused: { on: { CANCEL: 'cancelling', RESUME: 'active' } },
    cancelling: { on: { STOP: 'cancelled' } },
    cancelled: { type: 'final' },
    done: { type: 'final' },
  },
});
export function scopesOverlap(a: WorkScope, b: WorkScope): boolean {
  const absolute = (value: WorkScope) => value.paths.map((path) => `${value.workspace}/${path}`);
  return absolute(a).some((x) =>
    absolute(b).some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)),
  );
}
function scope(value: WorkScope) {
  requireWorkflow(
    value.workspace.startsWith('/') &&
      !value.workspace.endsWith('/') &&
      !value.workspace.split('/').some((p) => p === '.' || p === '..'),
    'noncanonical-workspace',
  );
  requireWorkflow(
    value.paths.length > 0 && new Set(value.paths).size === value.paths.length,
    'incomplete-work-scope',
  );
  value.paths.forEach(localLocator);
}
export function coordinationRef(ref: InputRef) {
  textField(ref.locator);
  textField(ref.hash);
}
export function createCoordination(seed: CoordinationSeed): Coordination {
  requireWorkflow(seed.schema_version === 1, 'unsupported-coordination-seed');
  startLocalRun(seed.run.spec, seed.run.generation);
  assertRunAction(seed.run, 'coordinate');
  requireWorkflow(seed.run.loaded !== null, 'coordination-load-missing');
  confirmLoad(seed.run, seed.run.loaded);
  requireLoadedProcedures(seed.run, ['coordination']);
  requireWorkflow(
    seed.run.spec.procedures.some((p) => p.id === 'coordination'),
    'coordination-procedure-missing',
  );
  requireWorkflow(
    Number.isSafeInteger(seed.poll_interval_ms) && seed.poll_interval_ms > 0,
    'invalid-poll-interval',
  );
  textField(seed.integration.executor);
  requireWorkflow(
    seed.integration.executor !== seed.run.spec.run_id,
    'coordinator-cannot-integrate',
  );
  coordinationRef(seed.integration.authority);
  scope(seed.integration.scope);
  requireWorkflow(
    seed.children.length > 0 &&
      new Set(seed.children.map((c) => c.id)).size === seed.children.length,
    'duplicate-or-missing-child',
  );
  const visited = new Set<string>();
  const visit = (id: string, ancestors: string[]) => {
    requireWorkflow(!ancestors.includes(id), 'dependency-cycle');
    const child = seed.children.find((c) => c.id === id);
    requireWorkflow(child !== undefined, 'dependency-missing');
    if (visited.has(id)) return;
    child.dependencies.forEach((dep) => visit(dep, [...ancestors, id]));
    visited.add(id);
  };
  for (const child of seed.children) {
    [
      child.id,
      child.writer,
      child.criterion,
      child.native_project_id,
      child.profile.model,
      child.profile.effort,
    ].forEach(textField);
    coordinationRef(child.authority);
    scope(child.scope);
    visit(child.id, []);
    requireWorkflow(
      child.read_only || !scopesOverlap(child.scope, seed.integration.scope),
      'shared-contract-owned-by-integrator',
    );
    requireWorkflow(
      child.read_only ||
        seed.children.every(
          (other) =>
            other.id === child.id || other.read_only || !scopesOverlap(child.scope, other.scope),
        ),
      'competing-scope-writers',
    );
  }
  return {
    status: getInitialSnapshot(machine).value as Coordination['status'],
    revision: 0,
    children: seed.children.map((task) => ({
      task: structuredClone(task),
      status: 'pending',
      operation: null,
      session: null,
      cursor: -1,
      result: null,
      stopped: null,
    })),
    integration: null,
    history: [],
  };
}
export function applyCoordination(
  seed: CoordinationSeed,
  state: Coordination,
  event: CoordinationEvent,
): Coordination {
  const prior = state.history.find((e) => e.id === event.id);
  if (prior) {
    requireWorkflow(sameValue(prior, event), 'coordination-event-conflict');
    return state;
  }
  textField(event.id);
  requireWorkflow(
    event.revision === state.revision && event.generation === seed.run.generation,
    'stale-coordination-event',
  );
  requireWorkflow(state.status !== 'done' && state.status !== 'cancelled', 'coordination-closed');
  const next = structuredClone(state);
  const move = (type: 'CANCEL' | 'STOP' | 'UNAVAILABLE' | 'RESUME' | 'INTEGRATE') => {
    next.status = transition(machine, machine.resolveState({ value: next.status, context: {} }), {
      type,
    })[0].value as Coordination['status'];
  };
  if ('child' in event) {
    const child = next.children.find((c) => c.task.id === event.child);
    requireWorkflow(child !== undefined, 'child-missing');
    if (event.type === 'RESERVE') {
      requireWorkflow(next.status === 'active' && child.status === 'pending', 'dispatch-not-ready');
      requireWorkflow(
        child.task.dependencies.every((dep) =>
          next.children.some((c) => c.task.id === dep && c.status === 'accepted'),
        ),
        'dependency-not-accepted',
      );
      textField(event.operation);
      requireWorkflow(
        next.children.every((c) => c.operation !== event.operation),
        'duplicate-dispatch-operation',
      );
      child.operation = event.operation;
      child.status = 'reserved';
    } else if (event.type === 'BIND') {
      requireWorkflow(child.operation !== null && child.session === null, 'dispatch-already-bound');
      textField(event.session);
      coordinationRef(event.receipt);
      requireWorkflow(
        next.children.every((c) => c.session !== event.session),
        'child-session-reused',
      );
      child.session = event.session;
      child.status = next.status === 'cancelling' ? 'stopping' : 'running';
    } else if (event.type === 'STOPPED') {
      requireWorkflow(
        next.status === 'cancelling' && child.status === 'stopping',
        'stop-not-requested',
      );
      coordinationRef(event.receipt);
      child.stopped = event.receipt;
      child.status = 'stopped';
    } else if (event.type === 'OBSERVE') {
      requireWorkflow(
        child.session === event.session && child.session !== null,
        'wrong-child-session',
      );
      coordinationRef(event.receipt);
      requireWorkflow(
        Number.isSafeInteger(event.cursor) && event.cursor >= 0,
        'invalid-observation-cursor',
      );
      if (event.cursor === child.cursor) {
        const previous = [...state.history]
          .reverse()
          .find(
            (e) => e.type === 'OBSERVE' && e.child === event.child && e.cursor === event.cursor,
          ) as Extract<CoordinationEvent, { type: 'OBSERVE' }>;
        requireWorkflow(
          previous.outcome === event.outcome && sameValue(previous.result, event.result),
          'observation-cursor-conflict',
        );
      }
      if (event.cursor > child.cursor) {
        child.cursor = event.cursor;
        if (next.status !== 'cancelling') {
          requireWorkflow(next.status === 'active', 'coordinator-unavailable');
          if (child.result !== null)
            requireWorkflow(
              event.outcome === 'completed' && sameValue(event.result, child.result),
              'completion-conflict',
            );
          else {
            requireWorkflow(
              (event.outcome === 'completed') === (event.result !== null),
              'completion-result-missing',
            );
            if (event.result !== null) {
              requireWorkflow(
                sameValue(event.result.scope, child.task.scope) &&
                  event.result.criterion === child.task.criterion,
                'wrong-child-result',
              );
              requireWorkflow(
                compareInputs(event.result.inputs, event.result.inputs) === 'applicable',
                'incomplete-child-inputs',
              );
              coordinationRef(event.result.evidence);
              requireWorkflow(
                event.result.acceptance.verdict === 'PASS' &&
                  compareInputs(event.result.inputs, event.result.acceptance.inputs) ===
                    'applicable',
                'child-acceptance-missing',
              );
              coordinationRef(event.result.acceptance.evidence);
            }
            child.result = event.result;
            child.status = event.outcome;
          }
        }
      }
    } else {
      requireWorkflow(
        next.status === 'active' && child.status === 'completed' && child.result !== null,
        'child-not-completed',
      );
      requireWorkflow(
        compareInputs(child.result.inputs, event.current) === 'applicable',
        'child-result-stale',
      );
      child.status = 'accepted';
    }
  } else if (event.type === 'CANCEL') {
    textField(event.reason);
    move('CANCEL');
    for (const child of next.children)
      child.status = child.operation === null || child.stopped !== null ? 'stopped' : 'stopping';
  } else if (event.type === 'UNAVAILABLE') {
    requireWorkflow(next.status === 'active', 'coordinator-not-active');
    coordinationRef(event.receipt);
    move('UNAVAILABLE');
  } else if (event.type === 'RESUME') {
    requireWorkflow(
      next.status === 'paused' && event.owner === seed.run.spec.run_id,
      'coordinator-owner-unconfirmed',
    );
    coordinationRef(event.receipt);
    move('RESUME');
  } else {
    requireWorkflow(
      next.status === 'active' && event.executor === seed.integration.executor,
      'integration-owner-unconfirmed',
    );
    requireWorkflow(
      next.children.every((c) => c.status === 'accepted'),
      'children-not-accepted',
    );
    requireWorkflow(
      compareInputs(event.inputs, event.inputs) === 'applicable',
      'integration-inputs-incomplete',
    );
    for (const child of next.children)
      requireWorkflow(
        event.child_inputs[child.task.id] !== undefined &&
          compareInputs(child.result!.inputs, event.child_inputs[child.task.id]!) === 'applicable',
        'integration-child-stale',
      );
    requireWorkflow(
      event.boundaries.verdict === 'PASS' &&
        event.validation.id === 'validate' &&
        event.validation.verdict === 'PASS' &&
        [event.boundaries, event.validation].every(
          (c) => compareInputs(event.inputs, c.inputs) === 'applicable',
        ),
      'integration-checks-incomplete',
    );
    coordinationRef(event.boundaries.evidence);
    coordinationRef(event.validation.evidence);
    next.integration = event;
    move('INTEGRATE');
  }
  if (next.status === 'cancelling' && next.children.every((c) => c.status === 'stopped'))
    move('STOP');
  next.revision++;
  next.history.push(structuredClone(event));
  return next;
}
export function replayCoordination(log: CoordinationLog): Coordination {
  const seed = coordinationSeed(log);
  const fresh = createCoordination(seed);
  const initial = log.schema_version === 1 ? fresh : replayCoordination(log.source);
  return log.events.reduce((state, event) => applyCoordination(seed, state, event), initial);
}
export function observationWait(
  interval: number,
  sinceLastPoll: number,
  eventDelivered: boolean,
): number {
  requireWorkflow(
    Number.isFinite(interval) &&
      interval > 0 &&
      Number.isFinite(sinceLastPoll) &&
      sinceLastPoll >= 0,
    'invalid-observation-time',
  );
  return eventDelivered ? 0 : Math.min(60_000, Math.max(0, interval - sinceLastPoll));
}
