import { createMachine, getInitialSnapshot, transition } from 'xstate';
import { localLocator, requireWorkflow, textField } from './connection.js';
import type { Procedure } from './connection.js';
import { sameValue, stableJson } from './equality.js';
import { scopesOverlap } from './coordination.js';
import { localPathAllowed } from './localPlanning.js';
import {
  applyLocalEvent,
  assertRunAction,
  requireLoadedProcedures,
  startLocalRun,
} from './localRun.js';
import type { InputRef, LoadReceipt, LocalRun } from './localRun.js';
import type { AgentSession } from './dataRoute.js';

export interface CoderBrief {
  id: string;
  project_id: string;
  task_id: string;
  parent_run_id: string;
  parent_session_id: string;
  generation: number;
  card: InputRef;
  authority: InputRef;
  source_root: string;
  copy_root: string;
  paths: string[];
  files: InputRef[];
  goal: string;
  criterion: string;
  checks: string[];
  profile: { model: string; effort: string };
  rules: InputRef[];
  procedures: Procedure[];
}
export interface CoderRoot {
  root: string;
  dev: number;
  ino: number;
}
export interface CoderVersion {
  content: InputRef;
  mode: number;
}
export interface CoderBaseline {
  source: CoderRoot;
  files: { path: string; version: CoderVersion }[];
  evidence: InputRef;
}
export interface CoderCopy {
  binding: CoderRoot;
  directories: { path: string; mode: number }[];
  evidence: InputRef;
}
export interface CoderSession extends AgentSession {
  policy: InputRef;
  read_only: false;
  network: false;
  sandbox: 'workspace-write';
  approval: 'never';
  write_roots: string[];
  exclude_slash_tmp: true;
  exclude_tmpdir: true;
}
export interface CoderResult {
  outcome: 'PASS' | 'FAIL' | 'NOT RUN';
  evidence: InputRef;
  checks: { command: string; exit_code: number | null; evidence: InputRef }[];
  errors: string[];
  limitations: string[];
}
export interface CoderIntegration {
  operation: string;
  project_id: string;
  task_id: string;
  parent_run_id: string;
  generation: number;
  source: CoderRoot;
  copy: CoderRoot;
  result: InputRef;
  stopped: InputRef;
  changes: { path: string; before: CoderVersion | null; after: CoderVersion | null }[];
  evidence: InputRef;
}
export interface CoderRun {
  schema_version: 1;
  brief: CoderBrief;
  baseline: CoderBaseline;
  status:
    | 'reserved'
    | 'copying'
    | 'copied'
    | 'creating'
    | 'created'
    | 'loading'
    | 'ready'
    | 'sending'
    | 'running'
    | 'candidate'
    | 'stopping'
    | 'stopped'
    | 'released'
    | 'integrating'
    | 'integrated'
    | 'cancelled'
    | 'not-started';
  copy: CoderCopy | null;
  session: CoderSession | null;
  writer: LocalRun | null;
  delivery: string | null;
  turn: string | null;
  result: CoderResult | null;
  stop_reason: 'complete' | 'cancel' | null;
  stopped: InputRef | null;
  integration: CoderIntegration | null;
  receipt: InputRef | null;
  history: { id: string; payload: string }[];
}
export type CoderAction =
  | { type: 'COPY_INTENT' }
  | { type: 'COPIED'; copy: CoderCopy }
  | { type: 'CREATE_INTENT' }
  | { type: 'BIND'; session: CoderSession }
  | { type: 'NOT_STARTED'; receipt: InputRef }
  | { type: 'LOAD_INTENT' }
  | { type: 'LOADED'; receipt: LoadReceipt }
  | { type: 'SEND_INTENT'; delivery: string }
  | { type: 'SENT'; turn: string }
  | { type: 'RESULT'; result: CoderResult }
  | { type: 'STOP_INTENT'; reason: 'complete' | 'cancel' }
  | { type: 'STOPPED'; receipt: InputRef }
  | { type: 'RELEASE' }
  | { type: 'CANCEL_IDLE'; receipt: InputRef }
  | { type: 'INTEGRATE_INTENT'; intent: CoderIntegration }
  | { type: 'INTEGRATED'; receipt: InputRef };
export type CoderEvent = CoderAction & { id: string; generation: number };

const machine = createMachine({
  types: {} as { events: CoderAction },
  initial: 'reserved',
  states: {
    reserved: { on: { COPY_INTENT: 'copying', CANCEL_IDLE: 'cancelled' } },
    copying: { on: { COPIED: 'copied' } },
    copied: { on: { CREATE_INTENT: 'creating', CANCEL_IDLE: 'cancelled' } },
    creating: { on: { BIND: 'created', NOT_STARTED: 'not-started' } },
    created: { on: { LOAD_INTENT: 'loading', STOP_INTENT: 'stopping' } },
    loading: { on: { LOADED: 'ready', STOP_INTENT: 'stopping' } },
    ready: { on: { SEND_INTENT: 'sending', STOP_INTENT: 'stopping' } },
    sending: { on: { SENT: 'running', STOP_INTENT: 'stopping' } },
    running: { on: { RESULT: 'candidate', STOP_INTENT: 'stopping' } },
    candidate: { on: { STOP_INTENT: 'stopping' } },
    stopping: { on: { STOPPED: 'stopped' } },
    stopped: { on: { RELEASE: 'released' } },
    released: { on: { INTEGRATE_INTENT: 'integrating', CANCEL_IDLE: 'cancelled' } },
    integrating: { on: { INTEGRATED: 'integrated' } },
    integrated: { type: 'final' },
    cancelled: { type: 'final' },
    'not-started': { type: 'final' },
  },
});
function ref(value: InputRef) {
  textField(value.locator);
  requireWorkflow(/^[a-f0-9]{64}$/u.test(value.hash), 'invalid-coder-ref');
}
function root(value: string) {
  requireWorkflow(
    value.startsWith('/') &&
      !value.endsWith('/') &&
      value
        .slice(1)
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    'noncanonical-coder-root',
  );
}
export function validateCoderBrief(brief: CoderBrief): void {
  [
    brief.id,
    brief.project_id,
    brief.task_id,
    brief.parent_run_id,
    brief.parent_session_id,
    brief.goal,
    brief.criterion,
    brief.profile.model,
    brief.profile.effort,
  ].forEach(textField);
  requireWorkflow(/^[a-zA-Z0-9_-]+$/u.test(brief.id), 'unsafe-coder-id');
  requireWorkflow(
    Number.isSafeInteger(brief.generation) && brief.generation > 0,
    'invalid-coder-generation',
  );
  root(brief.source_root);
  root(brief.copy_root);
  requireWorkflow(
    brief.source_root !== brief.copy_root &&
      !brief.copy_root.startsWith(brief.source_root + '/') &&
      !brief.source_root.startsWith(brief.copy_root + '/'),
    'coder-copy-not-isolated',
  );
  requireWorkflow(
    brief.paths.length > 0 && new Set(brief.paths).size === brief.paths.length,
    'incomplete-coder-scope',
  );
  brief.paths.forEach(localLocator);
  requireWorkflow(
    brief.files.length > 0 && brief.rules.length > 0 && brief.procedures.length > 0,
    'incomplete-coder-brief',
  );
  [brief.card, brief.authority, ...brief.files, ...brief.rules].forEach(ref);
  brief.files.forEach((file) => localLocator(file.locator));
  brief.rules.forEach((rule) => localLocator(rule.locator));
  brief.checks.forEach(textField);
}
function binding(value: CoderRoot, expected: string) {
  requireWorkflow(
    value.root === expected &&
      [value.dev, value.ino].every((n) => Number.isSafeInteger(n) && n >= 0),
    'coder-root-binding-mismatch',
  );
}
function version(value: CoderVersion | null) {
  if (value === null) return;
  ref(value.content);
  requireWorkflow(
    Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777,
    'invalid-coder-mode',
  );
}
export function coderOwnsSource(run: CoderRun): boolean {
  return !['integrated', 'cancelled', 'not-started'].includes(run.status);
}
export function coderProtectedPath(brief: CoderBrief, path: string): boolean {
  return (
    path === brief.card.locator ||
    brief.rules.some((rule) => path === rule.locator) ||
    [
      'AGENTS.md',
      'project/workflow.json',
      'tools/agent-workflow/project/workflow.json',
      'tools/agent-workflow/roles/coder.md',
    ].includes(path) ||
    path
      .split('/')
      .some(
        (part) =>
          ['.git', '.agents', '.codex', '.aws', '.ssh', '.gnupg', 'node_modules'].includes(
            part.toLowerCase(),
          ) ||
          /^\.env(?:\.|$)/iu.test(part) ||
          /\.(?:pem|key|p12|pfx)$/iu.test(part),
      )
  );
}
export function assertCoderParent(parent: LocalRun, brief: CoderBrief): void {
  requireWorkflow(parent.spec.context_loading === undefined, 'compact-coder-not-supported');
  assertRunAction(parent, 'implement');
  requireLoadedProcedures(parent, ['coordination']);
  requireWorkflow(
    parent.type === 'executor' &&
      parent.spec.role === null &&
      'task_id' in parent.spec.identity &&
      parent.spec.identity.task_id === brief.task_id &&
      sameValue(parent.spec.identity.card, brief.card) &&
      parent.spec.project_id === brief.project_id &&
      parent.spec.run_id === brief.parent_run_id &&
      parent.generation === brief.generation &&
      parent.spec.session_id === brief.parent_session_id &&
      parent.spec.requested.model === brief.profile.model &&
      parent.spec.requested.effort === brief.profile.effort &&
      parent.spec.workspace === brief.source_root,
    'coder-parent-mismatch',
  );
  const route = parent.spec.route;
  requireWorkflow(
    (route.kind === 'substantial' || route.kind === 'local') &&
      route.accepted_plan !== null &&
      sameValue(route.accepted_plan, brief.authority),
    'coder-authority-mismatch',
  );
  if (route.kind === 'local')
    requireWorkflow(
      brief.paths.every((path) => localPathAllowed(route.plan.paths, path)),
      'coder-outside-parent-local-scope',
    );
}
export function reserveCoder(
  parent: LocalRun,
  brief: CoderBrief,
  baseline: CoderBaseline,
  existing: CoderRun[],
): CoderRun {
  validateCoderBrief(brief);
  requireWorkflow(
    !brief.paths.some((path) => coderProtectedPath(brief, path)),
    'coder-protected-scope',
  );
  assertCoderParent(parent, brief);
  requireWorkflow(!existing.some((run) => run.brief.id === brief.id), 'coder-already-reserved');
  requireWorkflow(
    !existing.some(
      (run) =>
        run.brief.copy_root === brief.copy_root ||
        run.brief.copy_root.startsWith(brief.copy_root + '/') ||
        brief.copy_root.startsWith(run.brief.copy_root + '/'),
    ),
    'coder-copy-reused',
  );
  requireWorkflow(
    !existing.some(
      (run) =>
        coderOwnsSource(run) &&
        scopesOverlap(
          { workspace: run.brief.source_root, paths: run.brief.paths },
          { workspace: brief.source_root, paths: brief.paths },
        ),
    ),
    'coder-source-overlap',
  );
  binding(baseline.source, brief.source_root);
  ref(baseline.evidence);
  requireWorkflow(
    new Set(baseline.files.map((file) => file.path)).size === baseline.files.length,
    'duplicate-coder-file',
  );
  for (const file of baseline.files) {
    localLocator(file.path);
    version(file.version);
  }
  requireWorkflow(
    [...brief.files, ...brief.rules, ...brief.procedures].every((file) =>
      baseline.files.some(
        (entry) => entry.path === file.locator && entry.version.content.hash === file.hash,
      ),
    ),
    'coder-source-version-mismatch',
  );
  return {
    schema_version: 1,
    brief: structuredClone(brief),
    baseline: structuredClone(baseline),
    status: getInitialSnapshot(machine).value as CoderRun['status'],
    copy: null,
    session: null,
    writer: null,
    delivery: null,
    turn: null,
    result: null,
    stop_reason: null,
    stopped: null,
    integration: null,
    receipt: null,
    history: [],
  };
}
function writer(brief: CoderBrief, session: CoderSession): LocalRun {
  return startLocalRun(
    {
      project_id: brief.project_id,
      identity: { task_id: brief.task_id, card: brief.card },
      assignment: brief.authority,
      product: true,
      run_id: `coder:${brief.id}`,
      session_id: session.id,
      host_id: 'local',
      workspace: brief.copy_root,
      parent_run_id: brief.parent_run_id,
      coordinator: false,
      role: 'coder',
      fork_turns: 'none',
      scope: brief.paths,
      outcome: brief.goal,
      criteria: [brief.criterion],
      writer: `coder:${brief.id}`,
      requested: { ...brief.profile, permissions: ['read', 'implement', 'produce-evidence'] },
      effective: {
        model: session.model,
        effort: session.effort,
        permissions: ['read', 'implement', 'produce-evidence'],
      },
      sources: [brief.authority, ...brief.files],
      procedures: brief.procedures,
      procedure_loading: 'by-action',
      rules: brief.rules,
      route: { kind: 'delegated', authority: brief.authority },
    },
    brief.generation,
  );
}
export function applyCoder(run: CoderRun, event: CoderEvent): CoderRun {
  textField(event.id);
  const payload = stableJson(event),
    previous = run.history.find((entry) => entry.id === event.id);
  if (previous) {
    requireWorkflow(previous.payload === payload, 'coder-event-conflict');
    return run;
  }
  requireWorkflow(event.generation === run.brief.generation, 'stale-coder-generation');
  const snapshot = machine.resolveState({ value: run.status, context: {} });
  const status = transition(machine, snapshot, event)[0].value as CoderRun['status'];
  requireWorkflow(status !== run.status, 'wrong-coder-phase');
  const next = structuredClone(run);
  if (event.type === 'COPIED') {
    binding(event.copy.binding, run.brief.copy_root);
    requireWorkflow(
      new Set(event.copy.directories.map((dir) => dir.path)).size === event.copy.directories.length,
      'duplicate-coder-directory',
    );
    for (const dir of event.copy.directories) {
      localLocator(dir.path);
      requireWorkflow(
        Number.isInteger(dir.mode) && dir.mode >= 0 && dir.mode <= 0o777,
        'invalid-coder-mode',
      );
    }
    ref(event.copy.evidence);
    next.copy = event.copy;
  } else if (event.type === 'BIND') {
    const session = event.session;
    requireWorkflow(
      session.id !== run.brief.parent_session_id &&
        session.workspace === run.brief.copy_root &&
        session.project_id === run.brief.project_id &&
        session.model === run.brief.profile.model &&
        session.effort === run.brief.profile.effort &&
        session.read_only === false &&
        session.network === false &&
        session.sandbox === 'workspace-write' &&
        session.approval === 'never' &&
        session.exclude_slash_tmp === true &&
        session.exclude_tmpdir === true &&
        sameValue(session.write_roots, [run.brief.copy_root]) &&
        session.forked_from === null &&
        session.initial_turns === 0 &&
        session.parent_id === null &&
        session.native_child === false &&
        session.native_project_id === null,
      'coder-profile-unconfirmed',
    );
    textField(session.id);
    ref(session.receipt);
    ref(session.policy);
    next.session = session;
    next.writer = writer(run.brief, session);
  } else if (event.type === 'LOADED') {
    requireWorkflow(run.writer !== null, 'coder-writer-missing');
    let local = applyLocalEvent(run.writer, {
      type: 'LOAD',
      event_id: event.id + ':load',
      expected_revision: run.writer.revision,
      generation: event.generation,
      receipt: event.receipt,
    });
    local = applyLocalEvent(local, {
      type: 'READY',
      event_id: event.id + ':ready',
      expected_revision: local.revision,
      generation: event.generation,
    });
    assertRunAction(local, 'implement');
    next.writer = local;
  } else if (event.type === 'SEND_INTENT') {
    textField(event.delivery);
    next.delivery = event.delivery;
  } else if (event.type === 'SENT') {
    textField(event.turn);
    next.turn = event.turn;
  } else if (event.type === 'RESULT') {
    ref(event.result.evidence);
    requireWorkflow(
      ['PASS', 'FAIL', 'NOT RUN'].includes(event.result.outcome),
      'invalid-coder-result',
    );
    for (const check of event.result.checks) {
      requireWorkflow(run.brief.checks.includes(check.command), 'coder-check-outside-brief');
      ref(check.evidence);
      requireWorkflow(
        check.exit_code === null || Number.isSafeInteger(check.exit_code),
        'invalid-coder-exit',
      );
    }
    [...event.result.errors, ...event.result.limitations].forEach(textField);
    requireWorkflow(
      event.result.outcome !== 'PASS' ||
        (event.result.errors.length === 0 &&
          event.result.checks.every((check) => check.exit_code === 0)),
      'coder-result-overclaims',
    );
    next.result = event.result;
  } else if (event.type === 'STOP_INTENT') {
    requireWorkflow(
      event.reason === 'complete' || event.reason === 'cancel',
      'invalid-coder-stop-reason',
    );
    requireWorkflow(
      run.session !== null && (event.reason === 'cancel' || run.result !== null),
      'coder-stop-unconfirmed',
    );
    next.stop_reason = event.reason;
  } else if (event.type === 'STOPPED') {
    ref(event.receipt);
    next.stopped = event.receipt;
  } else if (event.type === 'RELEASE') {
    requireWorkflow(run.stopped !== null && run.stop_reason !== null, 'coder-stop-unconfirmed');
    if (run.stop_reason === 'cancel') next.status = 'cancelled';
  } else if (event.type === 'NOT_STARTED' || event.type === 'CANCEL_IDLE') {
    requireWorkflow(
      run.session === null || (event.type === 'CANCEL_IDLE' && run.stopped !== null),
      'coder-session-still-bound',
    );
    ref(event.receipt);
    next.receipt = event.receipt;
  } else if (event.type === 'INTEGRATE_INTENT') {
    const intent = event.intent;
    requireWorkflow(
      run.result?.outcome === 'PASS' &&
        run.copy !== null &&
        run.stopped !== null &&
        intent.project_id === run.brief.project_id &&
        intent.task_id === run.brief.task_id &&
        intent.parent_run_id === run.brief.parent_run_id &&
        intent.generation === run.brief.generation &&
        sameValue(intent.source, run.baseline.source) &&
        sameValue(intent.copy, run.copy.binding) &&
        sameValue(intent.result, run.result.evidence) &&
        sameValue(intent.stopped, run.stopped),
      'coder-integration-binding-mismatch',
    );
    textField(intent.operation);
    ref(intent.evidence);
    requireWorkflow(
      new Set(intent.changes.map((change) => change.path)).size === intent.changes.length,
      'duplicate-coder-change',
    );
    for (const change of intent.changes) {
      localLocator(change.path);
      version(change.before);
      version(change.after);
      requireWorkflow(
        localPathAllowed(run.brief.paths, change.path) &&
          !coderProtectedPath(run.brief, change.path) &&
          sameValue(
            change.before,
            run.baseline.files.find((file) => file.path === change.path)?.version ?? null,
          ) &&
          !sameValue(change.before, change.after),
        'coder-change-outside-scope',
      );
    }
    next.integration = intent;
  } else if (event.type === 'INTEGRATED') {
    requireWorkflow(run.integration !== null, 'coder-integration-intent-missing');
    ref(event.receipt);
    next.receipt = event.receipt;
  }
  if (next.status === run.status) next.status = status;
  next.history.push({ id: event.id, payload });
  return next;
}
export function validateCoderRun(run: CoderRun): void {
  requireWorkflow(
    run.schema_version === 1 && Array.isArray(run.history),
    'unsupported-coder-version',
  );
  validateCoderBrief(run.brief);
  binding(run.baseline.source, run.brief.source_root);
  ref(run.baseline.evidence);
  for (const file of run.baseline.files) {
    localLocator(file.path);
    version(file.version);
  }
  let rebuilt: CoderRun = {
    schema_version: 1,
    brief: structuredClone(run.brief),
    baseline: structuredClone(run.baseline),
    status: 'reserved',
    copy: null,
    session: null,
    writer: null,
    delivery: null,
    turn: null,
    result: null,
    stop_reason: null,
    stopped: null,
    integration: null,
    receipt: null,
    history: [],
  };
  for (const entry of run.history) {
    const event = JSON.parse(entry.payload) as CoderEvent;
    requireWorkflow(entry.id === event.id, 'coder-history-mismatch');
    rebuilt = applyCoder(rebuilt, event);
  }
  requireWorkflow(sameValue(rebuilt, run), 'coder-history-mismatch');
}
