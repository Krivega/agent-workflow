import { requireLoadedProcedures } from './localRun.js';
import { createMachine, getInitialSnapshot, transition } from 'xstate';
import { requireWorkflow, textField } from './connection.js';
import { confirmLoad, startLocalRun, localRunVersionSupported } from './localRun.js';
import type { InputRef, LocalRun, LoadReceipt } from './localRun.js';
import type { Json } from './evidence.js';
import type { AgentSession } from './dataRoute.js';
import { sameValue } from './equality.js';

export interface Compaction {
  thread: string;
  turn: string;
  item: string;
  mode: 'manual' | 'auto';
  evidence: InputRef;
}
export interface RelaySeed {
  schema_version: 1;
  id: string;
  predecessor: LocalRun;
  native_project_id: string;
  trigger: Compaction;
  authority: InputRef;
  // Entire durable source checkpoint, including unknown fields and nested workflow/coordination.
  checkpoint: Json;
  snapshot: InputRef;
  progress: {
    active_stage: string;
    estimate_ms: number;
    elapsed_ms: number | null;
    external_wait_ms: number | null;
    next_action: string;
    audit_checkpoint: string;
    findings: Json;
    gates: Json;
    pending_human: Json;
    child_evidence: InputRef[];
    mapping: Json;
  };
}
export type RelayAction =
  | { type: 'STOP'; receipt: InputRef }
  | { type: 'RELEASE'; generation: number; snapshot: InputRef; receipt: InputRef }
  | { type: 'RESERVE'; operation: string }
  | { type: 'IDENTIFY'; session: AgentSession }
  | { type: 'LOAD'; receipt: LoadReceipt }
  | { type: 'ADOPT'; generation: number; snapshot: InputRef; release: InputRef; receipt: InputRef }
  | { type: 'CONTINUE'; session: string; action: string; receipt: InputRef }
  | { type: 'FAIL'; kind: 'permission-denied' | 'technical-unavailable'; receipt: InputRef }
  | { type: 'ASSIST'; coordinator: string; authority: InputRef; receipt: InputRef };
export type RelayEvent = RelayAction & { id: string; revision: number };
export interface RelayState {
  phase:
    | 'stopping'
    | 'released-needed'
    | 'released'
    | 'reserved'
    | 'identified'
    | 'loaded'
    | 'adopted'
    | 'continued';
  revision: number;
  stopped: InputRef | null;
  release: InputRef | null;
  operation: string | null;
  successor: AgentSession | null;
  loaded: LoadReceipt | null;
  adoption: InputRef | null;
  continuation: InputRef | null;
  denied: boolean;
  failures: Extract<RelayAction, { type: 'FAIL' }>[];
  assistance: Extract<RelayAction, { type: 'ASSIST' }>[];
  events: RelayEvent[];
}
export interface RelayLog {
  schema_version: 1;
  seed: RelaySeed;
  events: RelayEvent[];
}
const machine = createMachine({
  types: {} as { events: { type: RelayAction['type'] } },
  initial: 'stopping',
  states: {
    stopping: { on: { STOP: 'released-needed' } },
    'released-needed': { on: { RELEASE: 'released' } },
    released: { on: { RESERVE: 'reserved' } },
    reserved: { on: { IDENTIFY: 'identified' } },
    identified: { on: { LOAD: 'loaded' } },
    loaded: { on: { ADOPT: 'adopted' } },
    adopted: { on: { CONTINUE: 'continued' } },
    continued: { type: 'final' },
  },
});
function ref(value: InputRef) {
  textField(value.locator);
  textField(value.hash);
}
export function createRelay(seed: RelaySeed): RelayState {
  requireWorkflow(seed.schema_version === 1, 'unsupported-relay-seed');
  [
    seed.id,
    seed.native_project_id,
    seed.trigger.turn,
    seed.trigger.item,
    seed.progress.active_stage,
    seed.progress.next_action,
    seed.progress.audit_checkpoint,
  ].forEach(textField);
  requireWorkflow(seed.predecessor.status === 'ready', 'predecessor-not-ready');
  requireWorkflow((seed.predecessor.coder_locks?.length ?? 0) === 0, 'coder-writers-pending');
  requireWorkflow(
    seed.predecessor.type === 'executor' || seed.predecessor.type === 'orchestrator',
    'role-cannot-relay',
  );
  requireWorkflow(
    seed.trigger.thread === seed.predecessor.spec.session_id &&
      ['manual', 'auto'].includes(seed.trigger.mode),
    'compaction-trigger-unconfirmed',
  );
  requireWorkflow(seed.predecessor.loaded !== null, 'predecessor-load-missing');
  confirmLoad(seed.predecessor, seed.predecessor.loaded);
  requireLoadedProcedures(seed.predecessor, ['relay']);
  requireWorkflow(
    seed.predecessor.spec.procedures.some((p) => p.id === 'relay'),
    'relay-procedure-missing',
  );
  requireWorkflow(seed.checkpoint !== null, 'relay-checkpoint-missing');
  requireWorkflow(
    Number.isSafeInteger(seed.progress.estimate_ms) &&
      seed.progress.estimate_ms > 0 &&
      seed.progress.estimate_ms <= 3600000,
    'invalid-relay-estimate',
  );
  for (const value of [seed.progress.elapsed_ms, seed.progress.external_wait_ms])
    requireWorkflow(
      value === null || (Number.isFinite(value) && value >= 0),
      'invalid-relay-elapsed',
    );
  requireWorkflow(
    seed.predecessor.type !== 'orchestrator' || seed.progress.mapping !== null,
    'coordinator-mapping-missing',
  );
  [seed.authority, seed.snapshot, seed.trigger.evidence, ...seed.progress.child_evidence].forEach(
    ref,
  );
  return {
    phase: getInitialSnapshot(machine).value as RelayState['phase'],
    revision: 0,
    stopped: null,
    release: null,
    operation: null,
    successor: null,
    loaded: null,
    adoption: null,
    continuation: null,
    denied: false,
    failures: [],
    assistance: [],
    events: [],
  };
}
export function successorRun(seed: RelaySeed, session: AgentSession): LocalRun {
  requireWorkflow(localRunVersionSupported(seed.predecessor), 'unsupported-run-version');
  const run = startLocalRun(
    {
      ...structuredClone(seed.predecessor.spec),
      run_id: `${seed.id}:successor`,
      session_id: session.id,
      writer:
        seed.predecessor.type === 'executor'
          ? `${seed.id}:successor`
          : seed.predecessor.spec.writer,
      effective: {
        model: session.model,
        effort: session.effort,
        permissions: seed.predecessor.spec.requested.permissions,
      },
    },
    seed.predecessor.generation + 1,
  );
  if (seed.predecessor.schema_version === 1) return run;
  requireWorkflow(seed.predecessor.format !== undefined, 'unsupported-run-version');
  return {
    ...run,
    schema_version: 2,
    format: seed.predecessor.format,
    ...(seed.predecessor.coder_locks === undefined ? {} : { coder_locks: [] }),
  };
}
export function applyRelay(seed: RelaySeed, state: RelayState, event: RelayEvent): RelayState {
  const previous = state.events.find((e) => e.id === event.id);
  if (previous) {
    requireWorkflow(sameValue(previous, event), 'relay-event-conflict');
    return state;
  }
  textField(event.id);
  requireWorkflow(event.revision === state.revision, 'stale-relay-event');
  requireWorkflow(state.phase !== 'continued' && !state.denied, 'relay-closed');
  const next = structuredClone(state);
  if (event.type === 'FAIL') {
    ref(event.receipt);
    next.failures.push(event);
    next.denied = event.kind === 'permission-denied';
  } else if (event.type === 'ASSIST') {
    requireWorkflow(
      next.failures.at(-1)?.kind === 'technical-unavailable',
      'assistance-without-technical-failure',
    );
    textField(event.coordinator);
    ref(event.authority);
    ref(event.receipt);
    next.assistance.push(event);
  } else {
    const changed = transition(
      machine,
      machine.resolveState({ value: state.phase, context: {} }),
      event,
    )[0].value as RelayState['phase'];
    requireWorkflow(changed !== state.phase, 'relay-order-violation');
    switch (event.type) {
      case 'STOP':
        ref(event.receipt);
        next.stopped = event.receipt;
        break;
      case 'RELEASE':
        requireWorkflow(
          event.generation === seed.predecessor.generation &&
            sameValue(event.snapshot, seed.snapshot),
          'release-checkpoint-mismatch',
        );
        ref(event.receipt);
        next.release = event.receipt;
        break;
      case 'RESERVE':
        textField(event.operation);
        next.operation = event.operation;
        break;
      case 'IDENTIFY': {
        const session = event.session,
          profile = seed.predecessor.spec.requested;
        requireWorkflow(
          session.id !== seed.predecessor.spec.session_id &&
            !session.id.startsWith('clientThreadId:') &&
            session.project_id === seed.native_project_id &&
            session.workspace === seed.predecessor.spec.workspace &&
            session.forked_from === null &&
            session.initial_turns === 0,
          'successor-identity-unconfirmed',
        );
        requireWorkflow(
          session.model === profile.model &&
            session.effort === profile.effort &&
            !session.network &&
            session.read_only === !profile.permissions.includes('implement'),
          'successor-profile-unconfirmed',
        );
        ref(session.receipt);
        next.successor = session;
        break;
      }
      case 'LOAD':
        confirmLoad(successorRun(seed, next.successor!), event.receipt);
        requireLoadedProcedures({ ...successorRun(seed, next.successor!), loaded: event.receipt }, [
          'relay',
        ]);
        next.loaded = event.receipt;
        break;
      case 'ADOPT':
        requireWorkflow(
          event.generation === seed.predecessor.generation + 1 &&
            sameValue(event.snapshot, seed.snapshot) &&
            sameValue(event.release, next.release),
          'adoption-checkpoint-mismatch',
        );
        ref(event.receipt);
        next.adoption = event.receipt;
        break;
      case 'CONTINUE':
        requireWorkflow(
          event.session === next.successor!.id && event.action === seed.progress.next_action,
          'continuation-unconfirmed',
        );
        ref(event.receipt);
        next.continuation = event.receipt;
        break;
    }
    next.phase = changed;
  }
  next.revision++;
  next.events.push(structuredClone(event));
  return next;
}
export function replayRelay(log: RelayLog) {
  requireWorkflow(log.schema_version === 1, 'unsupported-relay-log');
  return log.events.reduce(
    (state, event) => applyRelay(log.seed, state, event),
    createRelay(log.seed),
  );
}
