import { requireWorkflow, textField } from '../../core/connection.js';
import { normativeRules } from '../../core/compactContext.js';
import type { NormativeRule } from '../../core/compactContext.js';
import type { CompactProof, CompactRole } from '../../core/localRun.js';
import type { Procedure } from '../../core/connection.js';
import type { LocalRun, InputRef } from '../../core/localRun.js';
import type { EffectRecord, Json, TechnicalState } from '../../core/evidence.js';
import type { ChatContext } from '../../ports/chatContext.js';
import type { LoadedConnection } from '../../ports/projectConnection.js';
import { selectedProcedures } from '../../core/localRun.js';
import type { ProcedureId } from '../../core/connection.js';
import { councilBlockers } from '../../core/council.js';
import { sameValue } from '../../core/equality.js';
import { canonical, digest } from '../storage/storeCodec.js';

export interface CompactContextPacket {
  schema_version: 1;
  run_id: string;
  session_id: string;
  workspace: string;
  project_id: string;
  marker: string;
  action: string;
  payload_hash: string;
  boundary: InputRef;
  owner: string;
  generation: number;
  role: CompactRole;
  identity: LocalRun['spec']['identity'];
  assignment: InputRef;
  admission: { route: LocalRun['spec']['route']['kind']; accepted: InputRef | null };
  outcome: string;
  scope: string[];
  criteria: string[];
  permissions: LocalRun['spec']['requested']['permissions'];
  profile: { requested: LocalRun['spec']['requested']; effective: LocalRun['spec']['effective'] };
  sources: InputRef[];
  rules: InputRef[];
  procedures: { source: Procedure; rules: NormativeRule[] }[];
  state: Json;
}

export function buildCompactContext(
  run: LocalRun,
  marker: string,
  action: string,
  payloadHash: string,
  boundary: InputRef,
  context: ChatContext,
  ownership: TechnicalState,
  effects: EffectRecord[],
  loaded: LoadedConnection,
  additional: ProcedureId[],
  now: number,
): CompactContextPacket {
  requireWorkflow(
    ownership.owner === run.spec.session_id &&
      ownership.generation === run.generation &&
      context.run.generation === run.generation &&
      sameValue(context.run.spec, run.spec),
    'compact-context-owner-mismatch',
  );
  requireWorkflow(!context.coordination_bound, 'compact-coordination-not-supported');
  requireWorkflow(
    context.messages !== null && context.control !== null,
    'compact-context-incomplete',
  );
  const execution = context.workflow.execution;
  const state = {
    requirements_revision: context.messages.requirements_revision,
    decisions: context.messages.decisions,
    question: context.messages.question,
    control: {
      status: context.control.status,
      reason: context.control.reason,
      unfinished: context.control.unfinished,
      source: context.control.observed.source,
    },
    constraints: {
      frozen: ownership.frozen,
      released: ownership.released,
      lease_expired: ownership.lease_until <= now,
    },
    execution:
      execution === null
        ? null
        : {
            status: execution.status,
            compromise: execution.compromise,
            gates: execution.gates,
            findings: execution.findings.filter((finding) => finding.resolution === null),
            checks: execution.checks.map(({ id, verdict, reason, evidence }) => ({
              id,
              verdict,
              reason,
              evidence,
            })),
            baseline:
              execution.baseline === null
                ? null
                : {
                    kind: execution.baseline.kind,
                    scenario: execution.baseline.scenario,
                    evidence: execution.baseline.evidence,
                    elapsed_ms: execution.baseline.elapsed_ms,
                    exit_code: execution.baseline.exit_code,
                  },
            child_results: execution.child_results.map(({ scope, criterion, evidence, valid }) => ({
              scope,
              criterion,
              evidence,
              valid,
            })),
            result:
              execution.result === null
                ? null
                : {
                    scope: execution.result.scope,
                    summary: execution.result.summary,
                    evidence: execution.result.evidence,
                    limitations: execution.result.limitations,
                  },
            target: {
              scope: execution.target.scope,
              base: execution.target.base,
              diff: execution.target.diff,
            },
            councils: [execution.planning, execution.acceptance]
              .filter((council) => council !== null)
              .map((council) => ({
                phase: council.phase,
                scope: council.target.scope,
                blockers: councilBlockers(council),
                failures: council.history
                  .filter((entry) => entry.answer.verdict === 'FAIL')
                  .map((entry) => ({
                    role: entry.role,
                    session: entry.session,
                    verdict: entry.answer.verdict,
                    coverage: entry.answer.coverage,
                    evidence: entry.answer.evidence,
                  })),
              })),
            coder_reservations: execution.coder_reservations ?? [],
          },
    children: Object.values(context.workflow.coders ?? {}).map((coder) => ({
      id: coder.brief.id,
      status: coder.status,
      paths: coder.brief.paths,
      source_root: coder.brief.source_root,
      copy_root: coder.brief.copy_root,
      session: coder.session?.id ?? null,
    })),
    results: context.run.results,
    pending_operations: effects
      .filter((effect) => effect.outcome === 'pending' || effect.outcome === 'unknown')
      .map(({ id, outcome }) => ({ id, outcome })),
  };
  const procedures = selectedProcedures(run.spec, additional).map((source) => {
    const current = loaded.procedures.find((procedure) => procedure.id === source.id);
    requireWorkflow(current !== undefined, 'compact-procedure-stale');
    const { content, ...actual } = current;
    requireWorkflow(
      sameValue(source, actual) && digest(content) === source.hash,
      'compact-procedure-stale',
    );
    return { source, rules: normativeRules(source, content) };
  });
  return {
    schema_version: 1,
    run_id: run.spec.run_id,
    session_id: run.spec.session_id,
    workspace: run.spec.workspace,
    project_id: run.spec.project_id,
    marker: textField(marker),
    action: textField(action),
    payload_hash: textField(payloadHash),
    boundary,
    owner: ownership.owner!,
    generation: ownership.generation,
    role: run.spec.role ?? run.type,
    identity: run.spec.identity,
    assignment: run.spec.assignment,
    admission: {
      route: run.spec.route.kind,
      accepted:
        'accepted_plan' in run.spec.route
          ? run.spec.route.accepted_plan
          : run.spec.route.kind === 'mechanical'
            ? run.spec.route.accepted_material
            : run.spec.route.kind === 'delegated'
              ? run.spec.route.authority
              : null,
    },
    outcome: run.spec.outcome,
    scope: run.spec.scope,
    criteria: run.spec.criteria,
    permissions: run.spec.requested.permissions,
    profile: { requested: run.spec.requested, effective: run.spec.effective },
    sources: run.spec.sources,
    rules: run.spec.rules,
    procedures,
    state: JSON.parse(canonical(state)) as Json,
  };
}

export function compactProof(packet: CompactContextPacket): CompactProof {
  return {
    schema_version: 1,
    package_hash: digest(canonical(packet)),
    marker: packet.marker,
    action: packet.action,
    payload_hash: packet.payload_hash,
    state_hash: digest(canonical(packet.state)),
    owner: packet.owner,
    generation: packet.generation,
    identity: packet.identity,
    role: packet.role,
    procedures: packet.procedures.map((procedure) => procedure.source),
    rule_ids: packet.procedures.flatMap((procedure) => procedure.rules.map((rule) => rule.id)),
  };
}
export function compactContextLine(packet: CompactContextPacket) {
  const content = canonical(packet);
  return {
    chat_compact: packet.marker,
    action: packet.action,
    payload_hash: packet.payload_hash,
    state_hash: digest(canonical(packet.state)),
    hash: digest(content),
    content,
  };
}
