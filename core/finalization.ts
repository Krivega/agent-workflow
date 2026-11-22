import { requireLoadedProcedures } from './localRun.js';
import { createMachine, getInitialSnapshot, transition } from 'xstate';
import type { BackupReceipt, FinalizationManifest } from './evidence.js';
import type { InputRef, LocalRun } from './localRun.js';
import { confirmLoad } from './localRun.js';
import { requireWorkflow, textField } from './connection.js';
import { sameValue } from './equality.js';

export interface FinalizationSeed {
  schema_version: 1;
  id: string;
  run: LocalRun;
  authority: InputRef;
  done: InputRef;
  stopped: InputRef;
  significant: { id: string; revision: number }[];
  policy:
    | { mode: 'retain' }
    | {
        mode: 'test-cleanup';
        version: string;
        operator: string;
        authority: InputRef;
        grace_ms: number;
      };
}
export type FinalizationAction =
  | { type: 'CATALOG'; manifest: FinalizationManifest }
  | { type: 'EXPORT'; receipt: BackupReceipt; proof: InputRef }
  | { type: 'RESTORE'; receipt: BackupReceipt; proof: InputRef }
  | { type: 'ARCHIVE'; authority: InputRef; at: number; proof: InputRef }
  | { type: 'RESERVE_CLEANUP'; operator: string; now: number; authority: InputRef }
  | { type: 'CLEANED'; proof: InputRef }
  | { type: 'CANCEL'; reason: string };
export type FinalizationEvent = FinalizationAction & { id: string; revision: number };
export interface FinalizationLog {
  schema_version: 1;
  seed: FinalizationSeed;
  events: FinalizationEvent[];
}
export interface FinalizationState {
  phase:
    | 'started'
    | 'catalogued'
    | 'exported'
    | 'restored'
    | 'archived'
    | 'cleanup-reserved'
    | 'cleaned'
    | 'cancelled';
  revision: number;
  manifest: FinalizationManifest | null;
  archive: { at: number; proof: InputRef } | null;
  exported: BackupReceipt | null;
  history: FinalizationEvent[];
}
const machine = createMachine({
  id: 'finalization',
  initial: 'started',
  states: {
    started: { on: { CATALOG: 'catalogued', CANCEL: 'cancelled' } },
    catalogued: { on: { EXPORT: 'exported', CANCEL: 'cancelled' } },
    exported: { on: { RESTORE: 'restored', CANCEL: 'cancelled' } },
    restored: { on: { ARCHIVE: 'archived', CANCEL: 'cancelled' } },
    archived: { on: { RESERVE_CLEANUP: 'cleanup-reserved' } },
    'cleanup-reserved': { on: { CLEANED: 'cleaned' } },
    cleaned: { type: 'final' },
    cancelled: { type: 'final' },
  },
});
export function createFinalization(seed: FinalizationSeed): FinalizationState {
  requireWorkflow(seed.schema_version === 1, 'unsupported-finalization-version');
  textField(seed.id);
  requireWorkflow(
    seed.run.status === 'ready' && 'task_id' in seed.run.spec.identity,
    'finalization-task-required',
  );
  requireWorkflow(seed.run.loaded !== null, 'finalization-load-required');
  confirmLoad(seed.run, seed.run.loaded);
  requireLoadedProcedures(seed.run, ['finalization']);
  requireWorkflow(
    seed.run.spec.procedures.some((p) => p.id === 'finalization') &&
      seed.run.spec.procedures.some(
        (p) => p.id === 'evidence' && ['2', '3', '4'].includes(p.version),
      ),
    'finalization-procedure-required',
  );
  requireWorkflow(
    seed.significant.length > 0 &&
      seed.significant.every(
        (e) => e.id.trim() && Number.isSafeInteger(e.revision) && e.revision > 0,
      ),
    'significant-evidence-required',
  );
  if (seed.policy.mode === 'test-cleanup') {
    textField(seed.policy.version);
    textField(seed.policy.operator);
    requireWorkflow(
      Number.isSafeInteger(seed.policy.grace_ms) && seed.policy.grace_ms > 0,
      'cleanup-grace-required',
    );
  }
  return {
    phase: 'started',
    revision: 0,
    manifest: null,
    archive: null,
    exported: null,
    history: [],
  };
}
export function applyFinalization(
  seed: FinalizationSeed,
  state: FinalizationState,
  event: FinalizationEvent,
): FinalizationState {
  textField(event.id);
  const prior = state.history.find((e) => e.id === event.id);
  if (prior) {
    requireWorkflow(sameValue(prior, event), 'finalization-event-conflict');
    return state;
  }
  requireWorkflow(event.revision === state.revision, 'finalization-revision-conflict');
  const initial = getInitialSnapshot(machine);
  const snapshot = machine.resolveState({ value: state.phase, context: initial.context });
  const [result] = transition(machine, snapshot, { type: event.type });
  requireWorkflow(result.value !== state.phase, 'invalid-finalization-transition');
  const next = structuredClone(state);
  next.phase = result.value as FinalizationState['phase'];
  switch (event.type) {
    case 'CATALOG': {
      const m = event.manifest;
      requireWorkflow(
        m.schema_version === 'aw-evidence/1-draft' &&
          m.state.frozen &&
          m.context.project_id === seed.run.spec.project_id &&
          'task_id' in seed.run.spec.identity &&
          m.context.task_id === seed.run.spec.identity.task_id,
        'finalization-catalog-mismatch',
      );
      requireWorkflow(
        m.effects.every((e) => e.outcome === 'confirmed' || e.outcome === 'not-started'),
        'unreconciled-effects',
      );
      requireWorkflow(
        seed.significant.every((e) =>
          m.entries.some((v) => v.id === e.id && v.revision === e.revision),
        ),
        'missing-significant-evidence',
      );
      next.manifest = m;
      break;
    }
    case 'EXPORT': {
      requireWorkflow(
        event.receipt.revision === state.manifest!.state.revision &&
          event.receipt.project_id === state.manifest!.context.project_id &&
          event.receipt.task_id === state.manifest!.context.task_id &&
          sameValue(event.receipt.blobs, state.manifest!.blobs),
        'export-catalog-mismatch',
      );
      next.exported = event.receipt;
      break;
    }
    case 'RESTORE':
      requireWorkflow(sameValue(event.receipt, state.exported), 'restore-export-mismatch');
      break;
    case 'ARCHIVE':
      requireWorkflow(Number.isSafeInteger(event.at) && event.at >= 0, 'invalid-archive-time');
      next.archive = { at: event.at, proof: event.proof };
      break;
    case 'RESERVE_CLEANUP': {
      requireWorkflow(seed.policy.mode === 'test-cleanup', 'retention-forbids-cleanup');
      requireWorkflow(
        event.operator === seed.policy.operator &&
          sameValue(event.authority, seed.policy.authority),
        'cleanup-authority-mismatch',
      );
      requireWorkflow(
        Number.isSafeInteger(event.now) && event.now >= state.archive!.at + seed.policy.grace_ms,
        'cleanup-grace-pending',
      );
      break;
    }
    case 'CLEANED':
      break;
    case 'CANCEL':
      textField(event.reason);
      break;
  }
  next.revision++;
  next.history.push(structuredClone(event));
  return next;
}
export function replayFinalization(log: FinalizationLog): FinalizationState {
  requireWorkflow(log.schema_version === 1, 'unsupported-finalization-log');
  return log.events.reduce(
    (state, event) => applyFinalization(log.seed, state, event),
    createFinalization(log.seed),
  );
}
