import { createMachine, getInitialSnapshot, transition } from 'xstate';
import { stableJson, sameValue } from './equality.js';
import { procedureIds, requireWorkflow, textField } from './connection.js';
import type { Procedure, ProcedureId } from './connection.js';
import type { CardProjection, ProjectionResult } from './card.js';
import { validateLocalPlan } from '../src/policy/localPlanning.js';
import type { LocalImplementationPlan } from '../src/policy/localPlanning.js';
export { localPlanningRisks, validateLocalPlan } from '../src/policy/localPlanning.js';
export type { LocalImplementationPlan } from '../src/policy/localPlanning.js';

export type ExecutorType = 'executor' | 'orchestrator' | 'role';
export type DataRole = 'explorer' | 'raw-data-reader' | 'evidence-explorer';
export type RunAction = 'read' | 'implement' | 'coordinate' | 'update-card' | 'produce-evidence';
export interface InputRef {
  locator: string;
  hash: string;
}
export interface Profile {
  model: string;
  effort: string;
  permissions: RunAction[];
}
export interface RunSpec {
  project_id: string;
  identity: { task_id: string; card: InputRef } | { assignment_id: string };
  assignment: InputRef;
  product: boolean;
  run_id: string;
  session_id: string;
  host_id: string;
  workspace: string;
  parent_run_id: string | null;
  coordinator: boolean;
  role: DataRole | 'council-adviser' | 'arbiter' | 'auditor' | 'coder' | null;
  fork_turns: 'none' | 'all';
  scope: string[];
  outcome: string;
  criteria: string[];
  writer: string;
  requested: Profile;
  effective: Profile | null;
  sources: InputRef[];
  procedures: Procedure[];
  procedure_loading?: 'by-action';
  context_loading?: 'fragments-v1';
  rules: InputRef[];
  route:
    | { kind: 'substantial'; accepted_plan: InputRef | null }
    | { kind: 'mechanical'; accepted_material: InputRef; semantic_delta: boolean }
    | { kind: 'local'; accepted_plan: InputRef | null; plan: LocalImplementationPlan }
    | { kind: 'delegated'; authority: InputRef }
    | { kind: 'nonproduct' };
}
export type CompactRole = NonNullable<LocalRun['spec']['role']> | LocalRun['type'];
export interface CompactProof {
  schema_version: 1;
  package_hash: string;
  marker: string;
  action: string;
  payload_hash: string;
  state_hash: string;
  owner: string;
  generation: number;
  identity: LocalRun['spec']['identity'];
  role: CompactRole;
  procedures: Procedure[];
  rule_ids: string[];
}

export interface LoadReceipt {
  run_id: string;
  session_id: string;
  procedures: Procedure[];
  rules: InputRef[];
  observed_read: string;
  native?: InputRef;
  origin?: InputRef;
  compact?: CompactProof;
  compact_fallback?: string;
}
export interface LocalRun {
  schema_version: 1 | 2 | 3;
  format?: 'local-planning' | 'coder' | 'compact-context';
  coder_locks?: { id: string; workspace: string; paths: string[] }[];
  revision: number;
  generation: number;
  type: ExecutorType;
  status: 'inbox' | 'waiting' | 'ready' | 'cancelled';
  spec: RunSpec;
  loaded: LoadReceipt | null;
  elapsed_ms: number | null;
  external_wait_ms: number | null;
  history: { event_id: string; payload: string }[];
  results: { source: InputRef; outcome: 'PASS' | 'FAIL' | 'NOT RUN' | 'N/A' }[];
  cancellation: { reason: string; unfinished: string[]; stopped_receipt: string } | null;
  projection: { plan: CardProjection; result: ProjectionResult } | null;
}
export function localRunVersionSupported(run: LocalRun): boolean {
  if (run.schema_version === 3)
    return (
      run.format === 'compact-context' &&
      run.spec?.context_loading === 'fragments-v1' &&
      run.spec.role === null &&
      run.spec.parent_run_id === null &&
      run.spec.coordinator === false &&
      run.coder_locks === undefined
    );
  if (run.spec?.context_loading !== undefined || run.loaded?.compact !== undefined) return false;
  return run.schema_version === 1
    ? run.format === undefined &&
        run.coder_locks === undefined &&
        run.spec?.role !== 'coder' &&
        !['local', 'delegated'].includes(run.spec?.route?.kind)
    : run.schema_version === 2 && ['local-planning', 'coder'].includes(String(run.format));
}
export type LocalEvent = {
  event_id: string;
  expected_revision: number;
  generation: number;
} & (
  | { type: 'LOAD'; receipt: LoadReceipt }
  | { type: 'WAIT' }
  | { type: 'READY' }
  | { type: 'CODER_LOCKS'; locks: NonNullable<LocalRun['coder_locks']> }
  | {
      type: 'RESULT';
      session_id: string;
      source: InputRef;
      outcome: 'PASS' | 'FAIL' | 'NOT RUN' | 'N/A';
    }
  | { type: 'CANCEL'; reason: string; unfinished: string[]; stopped_receipt: string }
);

const localMachine = createMachine({
  types: {} as { events: { type: 'WAIT' | 'READY' | 'CANCEL' } },
  id: 'local-bootstrap',
  initial: 'inbox',
  states: {
    inbox: { on: { WAIT: 'waiting', READY: 'ready', CANCEL: 'cancelled' } },
    waiting: { on: { READY: 'ready', CANCEL: 'cancelled' } },
    ready: { on: { WAIT: 'waiting', CANCEL: 'cancelled' } },
    cancelled: { type: 'final' },
  },
});
export function executorType(spec: Pick<RunSpec, 'parent_run_id' | 'coordinator'>): ExecutorType {
  return spec.parent_run_id !== null ? 'role' : spec.coordinator ? 'orchestrator' : 'executor';
}
const actions: Record<ExecutorType, RunAction[]> = {
  executor: ['read', 'implement', 'update-card', 'produce-evidence'],
  orchestrator: ['read', 'coordinate', 'produce-evidence'],
  role: ['read'],
};
function allowedActions(type: ExecutorType, role: RunSpec['role']): RunAction[] {
  return type === 'role' && role === 'coder'
    ? ['read', 'implement', 'produce-evidence']
    : actions[type];
}
export function startLocalRun(spec: RunSpec, generation: number): LocalRun {
  actionProcedureLoading(spec);
  for (const value of [
    spec.project_id,
    spec.run_id,
    spec.session_id,
    spec.host_id,
    spec.workspace,
    spec.outcome,
    spec.writer,
    spec.requested.model,
    spec.requested.effort,
  ])
    textField(value);
  requireWorkflow(generation > 0 && Number.isSafeInteger(generation), 'invalid-generation');
  requireWorkflow(
    spec.scope.length > 0 && spec.criteria.length > 0 && spec.sources.length > 0,
    'incomplete-brief',
  );
  [...spec.scope, ...spec.criteria].forEach(textField);
  requireWorkflow(!spec.product || 'task_id' in spec.identity, 'product-needs-card');
  textField('task_id' in spec.identity ? spec.identity.task_id : spec.identity.assignment_id);
  const type = executorType(spec);
  requireWorkflow((type === 'role') === (spec.role !== null), 'wrong-role-profile');
  requireWorkflow(type !== 'role' || spec.fork_turns === 'none', 'parent-history-forbidden');
  requireWorkflow(
    spec.requested.permissions.length > 0 &&
      spec.requested.permissions.every((action) =>
        allowedActions(type, spec.role).includes(action),
      ),
    'action-forbidden',
  );
  requireWorkflow(
    spec.role !== 'evidence-explorer' || 'task_id' in spec.identity,
    'evidence-role-needs-task',
  );
  return {
    schema_version:
      spec.context_loading === 'fragments-v1'
        ? 3
        : spec.role === 'coder' || spec.route.kind === 'local'
          ? 2
          : 1,
    ...(spec.context_loading === 'fragments-v1'
      ? { format: 'compact-context' as const }
      : spec.role === 'coder'
        ? { format: 'coder' as const }
        : spec.route.kind === 'local'
          ? { format: 'local-planning' as const }
          : {}),
    revision: 0,
    generation,
    type,
    status: getInitialSnapshot(localMachine).value as LocalRun['status'],
    spec: structuredClone(spec),
    loaded: null,
    elapsed_ms: null,
    external_wait_ms: null,
    history: [],
    results: [],
    cancellation: null,
    projection: null,
  };
}
function sameRefs(expected: InputRef[], actual: InputRef[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((ref) =>
      actual.some((item) => item.locator === ref.locator && item.hash === ref.hash),
    )
  );
}
export function confirmCompactProof(run: LocalRun, proof: CompactProof, procedures: Procedure[]) {
  requireWorkflow(run.spec.context_loading === 'fragments-v1', 'compact-context-disabled');
  requireWorkflow(proof.schema_version === 1, 'unsupported-compact-proof');
  for (const value of [proof.marker, proof.action]) textField(value);
  requireWorkflow(
    [proof.package_hash, proof.payload_hash, proof.state_hash].every(
      (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash),
    ),
    'compact-proof-hash-invalid',
  );
  requireWorkflow(
    proof.owner === run.spec.session_id &&
      proof.generation === run.generation &&
      sameValue(proof.identity, run.spec.identity) &&
      proof.role === (run.spec.role ?? run.type),
    'compact-proof-binding-mismatch',
  );
  requireWorkflow(
    procedures.length > 0 && sameValue(proof.procedures, procedures),
    'compact-proof-procedures-mismatch',
  );
  requireWorkflow(
    procedures.every(
      (procedure) => procedure.fragments !== undefined && procedure.fragments.length > 0,
    ) &&
      sameValue(
        proof.rule_ids,
        procedures.flatMap((procedure) => procedure.fragments!),
      ),
    'compact-proof-rules-incomplete',
  );
}

export function confirmLoad(run: LocalRun, receipt: LoadReceipt): void {
  if (run.spec.context_loading !== undefined)
    requireWorkflow(localRunVersionSupported(run), 'unsupported-run-version');
  requireWorkflow(
    receipt.run_id === run.spec.run_id && receipt.session_id === run.spec.session_id,
    'wrong-load-identity',
  );
  textField(receipt.observed_read);
  if (receipt.compact !== undefined) confirmCompactProof(run, receipt.compact, receipt.procedures);
  if (receipt.compact_fallback !== undefined) {
    textField(receipt.compact_fallback);
    requireWorkflow(receipt.compact === undefined, 'compact-fallback-is-not-compact-load');
  }
  requireWorkflow(sameRefs(run.spec.rules, receipt.rules), 'rules-not-loaded');
  const scoped = actionProcedureLoading(run.spec);
  const expected = scoped ? receipt.procedures : run.spec.procedures;
  const actual = scoped ? run.spec.procedures : receipt.procedures;
  requireWorkflow(
    (scoped
      ? new Set(receipt.procedures.map((p) => p.id)).size === receipt.procedures.length
      : receipt.procedures.length === run.spec.procedures.length) &&
      expected.every((p) =>
        actual.some(
          (r) =>
            r.id === p.id &&
            r.version === p.version &&
            r.hash === p.hash &&
            r.locator === p.locator &&
            (receipt.compact === undefined || sameValue(r.fragments, p.fragments)),
        ),
      ),
    'procedures-not-loaded',
  );
}
export function requiredProcedures(
  type: ExecutorType,
  role: RunSpec['role'] = null,
  loading?: RunSpec['procedure_loading'],
): ProcedureId[] {
  if (type === 'role' && role === 'arbiter') return ['arbitration', 'evidence'];
  if (type === 'role' && role === 'auditor') return ['audit', 'evidence'];
  if (type === 'role' && role === 'coder')
    return ['bootstrap', 'implementation', 'boundary-review', 'evidence'];
  if (type === 'role' && role === 'council-adviser')
    return ['bootstrap', 'data-roles', 'evidence', 'boundary-review', 'council'];
  return type === 'role'
    ? ['bootstrap', 'data-roles', 'evidence']
    : loading === 'by-action'
      ? ['bootstrap', 'task', 'evidence']
      : [...procedureIds];
}
export function actionProcedureLoading(spec: RunSpec): boolean {
  requireWorkflow(
    spec.context_loading === undefined ||
      (spec.context_loading === 'fragments-v1' &&
        spec.procedure_loading === 'by-action' &&
        spec.role === null &&
        spec.parent_run_id === null &&
        spec.coordinator === false),
    'unsupported-context-loading',
  );
  requireWorkflow(
    spec.procedure_loading === undefined || spec.procedure_loading === 'by-action',
    'unsupported-procedure-loading',
  );
  return spec.procedure_loading === 'by-action';
}
const procedureDependencies: Partial<Record<ProcedureId, ProcedureId[]>> = {
  implementation: ['boundary-review'],
  council: ['data-roles', 'boundary-review'],
  arbitration: ['evidence'],
  audit: ['evidence'],
  relay: ['evidence'],
  finalization: ['evidence'],
};
export function selectedProcedures(spec: RunSpec, additional: ProcedureId[] = []): Procedure[] {
  if (!actionProcedureLoading(spec)) return spec.procedures;
  const required = new Set([
    ...requiredProcedures(executorType(spec), spec.role, spec.procedure_loading),
    ...additional.flatMap((id) => [id, ...(procedureDependencies[id] ?? [])]),
  ]);
  requireWorkflow(
    [...required].every((id) => spec.procedures.some((p) => p.id === id)),
    'missing-procedure',
  );
  return spec.procedures.filter((p) => required.has(p.id));
}
export function requireLoadedProcedures(run: LocalRun, additional: ProcedureId[] = []): void {
  if (!actionProcedureLoading(run.spec)) return;
  requireWorkflow(run.loaded !== null, 'load-unconfirmed');
  confirmLoad(run, run.loaded);
  for (const procedure of selectedProcedures(run.spec, additional))
    requireWorkflow(
      run.loaded.procedures.some((p) => p.id === procedure.id),
      `procedure-not-loaded:${procedure.id}`,
    );
}
function ready(run: LocalRun): void {
  requireWorkflow(run.loaded !== null, 'load-unconfirmed');
  requireWorkflow(run.projection?.result.status !== 'pending', 'reconciliation-pending');
  confirmLoad(run, run.loaded);
  requireWorkflow(
    requiredProcedures(run.type, run.spec.role, run.spec.procedure_loading).every((id) =>
      run.spec.procedures.some((p) => p.id === id),
    ),
    'missing-procedure',
  );
  requireLoadedProcedures(run);
  const effective = run.spec.effective;
  requireWorkflow(
    effective !== null &&
      effective.model === run.spec.requested.model &&
      effective.effort === run.spec.requested.effort &&
      effective.permissions.length === run.spec.requested.permissions.length &&
      effective.permissions.every((p) => run.spec.requested.permissions.includes(p)),
    'profile-unconfirmed',
  );
  const route = run.spec.route;
  requireWorkflow(
    ['substantial', 'mechanical', 'local', 'delegated', 'nonproduct'].includes(route.kind),
    'unsupported-run-route',
  );
  if (route.kind === 'substantial')
    requireWorkflow(route.accepted_plan !== null, 'planning-required');
  if (route.kind === 'mechanical')
    requireWorkflow(!route.semantic_delta, 'semantic-delta-needs-planning');
  if (route.kind === 'local') {
    requireWorkflow(
      (run.schema_version === 2 || run.schema_version === 3) && route.accepted_plan !== null,
      'local-plan-required',
    );
    validateLocalPlan(route.plan);
  }
  if (route.kind === 'delegated') {
    requireWorkflow(
      run.schema_version === 2 &&
        run.format === 'coder' &&
        run.spec.role === 'coder' &&
        run.spec.parent_run_id !== null,
      'coder-authority-required',
    );
    [route.authority.locator, route.authority.hash].forEach(textField);
  }
  if (route.kind === 'nonproduct') requireWorkflow(!run.spec.product, 'product-needs-planning');
}
export function assertRunAction(run: LocalRun, action: RunAction): void {
  requireWorkflow(
    !['implement', 'update-card'].includes(action) || run.spec.writer === run.spec.run_id,
    'not-card-writer',
  );
  requireWorkflow(
    run.status === 'ready' &&
      run.spec.requested.permissions.includes(action) &&
      allowedActions(run.type, run.spec.role).includes(action),
    'action-forbidden',
  );
  requireLoadedProcedures(
    run,
    action === 'implement' ? ['implementation'] : action === 'coordinate' ? ['coordination'] : [],
  );
}
export function continueRole(
  run: LocalRun,
  session: string,
  sources: InputRef[],
  revisionChecked: boolean,
): void {
  requireWorkflow(
    run.type === 'role' && run.status !== 'cancelled' && session === run.spec.session_id,
    'role-identity-lost',
  );
  requireWorkflow(
    sameRefs(run.spec.sources, sources) || revisionChecked,
    'source-revision-changed',
  );
}
export function applyLocalEvent(run: LocalRun, event: LocalEvent): LocalRun {
  const payload = stableJson(event);
  const previous = run.history.find((item) => item.event_id === event.event_id);
  if (previous) {
    requireWorkflow(
      stableJson(JSON.parse(previous.payload) as unknown) === payload,
      'event-conflict',
    );
    return run;
  }
  requireWorkflow(run.status !== 'cancelled', 'run-cancelled');
  requireWorkflow(
    run.generation === event.generation && run.revision === event.expected_revision,
    'stale-event',
  );
  const next = structuredClone(run);
  if (event.type === 'LOAD') {
    confirmLoad(run, event.receipt);
    next.loaded = structuredClone(event.receipt);
  } else if (event.type === 'CODER_LOCKS') {
    requireWorkflow(run.spec.context_loading === undefined, 'compact-coder-not-supported');
    requireWorkflow(run.type === 'executor' && run.spec.role === null, 'coder-parent-mismatch');
    next.schema_version = 2;
    next.format ??= 'coder';
    next.coder_locks = structuredClone(event.locks);
  } else if (event.type === 'RESULT') {
    requireWorkflow(event.session_id === run.spec.session_id, 'wrong-result-identity');
    next.results.push({ source: event.source, outcome: event.outcome });
  } else {
    if (event.type === 'READY') ready(run);
    if (event.type === 'CANCEL') {
      requireWorkflow((run.coder_locks?.length ?? 0) === 0, 'coder-writers-pending');
      textField(event.reason);
      textField(event.stopped_receipt);
      requireWorkflow(event.unfinished.length > 0, 'missing-unfinished-scope');
      next.cancellation = {
        reason: event.reason,
        unfinished: event.unfinished,
        stopped_receipt: event.stopped_receipt,
      };
      next.generation += 1;
    }
    const snapshot = localMachine.resolveState({ value: run.status, context: {} });
    next.status = transition(localMachine, snapshot, event)[0].value as LocalRun['status'];
  }
  next.revision += 1;
  next.history.push({ event_id: event.event_id, payload });
  return next;
}
