import { requireWorkflow, textField } from '../core/connection.js';
import { compareInputs, targetEvidenceInputs } from '../core/evidence.js';
import { sameValue } from '../core/equality.js';
import { councilBlockers, sameRefs, councilCurrentProfileRefs } from '../core/council.js';
import type { Council, CouncilRole } from '../core/council.js';
import type { RunSpec, LocalEvent, InputRef } from '../core/localRun.js';
import { confirmLoad } from '../core/localRun.js';
import type { ChatObservation } from '../core/currentChat.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import type { ChatContextJournal } from '../ports/chatContext.js';
import type { LocalRuns, RunInputs } from '../ports/localRuns.js';
import type { WorkflowInputs, WorkflowJournal } from '../ports/workflowJournal.js';
import type { ProjectCards } from '../ports/projectCards.js';
import { beginLocalWorkflow, advanceLocalWorkflow } from './localWorkflow.js';
import { beginExecution, advanceExecution, verifyCouncilInputs } from './executionWorkflow.js';
import { createExecution, executionBlockers } from '../core/execution.js';
import type { Execution, ExecutionEvent, Gate } from '../core/execution.js';
import { projectLocalCard } from './projectLocalCard.js';
import { initializeChatMessages } from './chatMessages.js';
import { initializeChatControl } from './chatControl.js';
import { localPlanRefs, validateLocalAdmission } from '../core/localPlanning.js';
import type { LocalAdmission } from '../core/localPlanning.js';

export interface ChatPlanning {
  task_id: string;
  council: Council;
  local?: LocalAdmission;
  source: InputRef;
  retained_source?: InputRef;
  requirements_revision?: number;
  assignment?: InputRef;
  role_requirements?: Partial<Record<CouncilRole, InputRef[]>>;
}
export interface ChatDependencies {
  beforeReady?: () => Promise<void>;
  requirements_revision?: number;
  host: CurrentChatHost;
  runs: LocalRuns;
  runInputs: RunInputs;
  inputs: WorkflowInputs;
  journal: WorkflowJournal;
  cards: ProjectCards;
}
export async function prepareCurrentChat(
  spec: RunSpec,
  generation: number,
  marker: unknown,
  observed: Pick<ChatObservation, 'model' | 'effort'>,
  reuseLoad: boolean,
  chat: ChatContextJournal,
  deps: Pick<ChatDependencies, 'runs' | 'runInputs'> & {
    host: Pick<CurrentChatHost, 'load' | 'observe'>;
  },
) {
  const effective = {
    model: observed.model,
    effort: observed.effort,
    permissions: [...spec.requested.permissions],
  };
  let run =
    (await deps.runs.read()) ??
    (await beginLocalWorkflow({ ...spec, effective }, generation, deps.runs, deps.runInputs));
  requireWorkflow(
    run.generation === generation && sameValue(run.spec, { ...spec, effective }),
    'chat-prepare-conflict',
  );
  await deps.runInputs.verify(run);
  confirmLoad(run, await deps.host.load(run, textField(marker), reuseLoad));
  if (run.status === 'inbox')
    run = await advanceLocalWorkflow(
      { type: 'WAIT', event_id: 'chat:prepare', expected_revision: run.revision, generation },
      deps.runs,
      deps.runInputs,
    );
  await initializeChatMessages(chat);
  await initializeChatControl(chat, deps.host);
  return chat.read();
}
export async function readyCurrentChat(
  spec: RunSpec,
  generation: number,
  marker: string,
  planning: ChatPlanning,
  deps: ChatDependencies,
) {
  requireWorkflow(
    'task_id' in spec.identity &&
      spec.identity.task_id === planning.task_id &&
      (spec.route.kind === 'substantial' || spec.route.kind === 'local') &&
      spec.route.accepted_plan !== null &&
      sameRefs([spec.route.accepted_plan], [planning.source]) &&
      (spec.route.kind === 'local'
        ? planning.local !== undefined && sameValue(spec.route.plan, planning.local.plan)
        : planning.local === undefined &&
          planning.council.phase === 'planning' &&
          councilBlockers(planning.council).length === 0),
    'chat-planning-unconfirmed',
  );
  const revision = deps.requirements_revision ?? 0;
  requireWorkflow(
    (planning.requirements_revision ?? 0) === revision,
    'chat-planning-revision-stale',
  );
  if (planning.role_requirements !== undefined)
    requireWorkflow(
      sameRefs([planning.council.target.diff], [spec.assignment]) &&
        planning.council.target.scope === spec.outcome,
      'chat-scoped-plan-stale',
    );
  if (revision > 0) {
    requireWorkflow(
      planning.assignment !== undefined && sameRefs([planning.assignment], [spec.assignment]),
      'chat-planning-assignment-stale',
    );
    if (planning.local === undefined)
      for (const [role, selected] of Object.entries(planning.council.selection)) {
        if (!selected.trigger) continue;
        const adviser = planning.council.advisers[role as keyof typeof planning.council.advisers];
        const requirements = planning.role_requirements?.[role as CouncilRole] ?? [spec.assignment];
        requireWorkflow(
          requirements.length > 0 &&
            requirements.every(
              (required) =>
                selected.requirements.some((r) => sameRefs([r], [required])) &&
                adviser?.answer?.sources.some((r) => sameRefs([r], [required])),
            ),
          'chat-revised-requirements-unreviewed',
        );
      }
  }
  if (planning.local) {
    validateLocalAdmission(planning.local, planning.council.target);
    requireWorkflow(
      sameValue(planning.local.selection, planning.council.selection) &&
        sameValue(planning.local.configuration, planning.council.configuration),
      'local-selection-mismatch',
    );
    await deps.inputs.verify([planning.local.source, ...localPlanRefs(planning.local.plan)]);
  }
  await deps.inputs.verify([
    planning.source,
    planning.council.target.diff,
    ...Object.values(planning.council.selection).flatMap((s) => s.requirements),
    ...(planning.local
      ? []
      : Object.values(planning.council.advisers).flatMap((a) =>
          a.answer === null ? [] : [a.answer.evidence, ...a.answer.sources],
        )),
    ...planning.council.history.map((h) => h.answer.evidence),
  ]);
  requireWorkflow(
    compareInputs(
      planning.council.target.inputs,
      await deps.inputs.current(planning.council.target.inputs),
    ) === 'applicable',
    'chat-planning-inputs-stale',
  );
  if (planning.council.target.evidence_inputs !== undefined)
    requireWorkflow(
      compareInputs(
        targetEvidenceInputs(planning.council.target),
        await deps.inputs.current(planning.council.target.evidence_inputs),
      ) === 'applicable',
      'chat-planning-evidence-stale',
    );
  const observed = await deps.host.observe();
  requireWorkflow(
    observed.sandbox_policy === 'danger-full-access' &&
      observed.approval_policy === 'never' &&
      observed.permission_profile === 'disabled',
    'chat-write-profile-unsupported',
  );
  requireWorkflow(
    spec.session_id === observed.thread_id &&
      spec.host_id === observed.host_id &&
      spec.workspace === observed.workspace &&
      spec.requested.model === observed.model &&
      spec.requested.effort === observed.effort &&
      spec.parent_run_id === null,
    'chat-executor-mismatch',
  );
  const effective = {
    model: observed.model,
    effort: observed.effort,
    permissions: [...spec.requested.permissions],
  };
  const previous = await deps.runs.read();
  let current = previous;
  if (
    current !== null &&
    current.status === 'waiting' &&
    (current.spec.route.kind === 'substantial' || current.spec.route.kind === 'local') &&
    current.spec.route.accepted_plan === null
  ) {
    requireWorkflow(
      sameValue({ ...current.spec, route: spec.route, effective }, { ...spec, effective }),
      'chat-bootstrap-conflict',
    );
    const bound = {
      ...current,
      ...(spec.route.kind === 'local' && current.schema_version !== 3
        ? { schema_version: 2 as const, format: 'local-planning' as const }
        : {}),
      revision: current.revision + 1,
      spec: { ...current.spec, route: spec.route, effective },
    };
    await deps.runInputs.verify(bound);
    current = bound;
  }
  let run =
    current ??
    (await beginLocalWorkflow({ ...spec, effective }, generation, deps.runs, deps.runInputs));
  requireWorkflow(
    run.generation === generation && sameValue(run.spec, { ...spec, effective }),
    'chat-bootstrap-conflict',
  );
  await deps.beforeReady?.();
  // Read the pre-action context before persisting the accepted planning route.
  const receipt = await deps.host.load(previous ?? run, marker);
  if (previous !== null && previous !== run) await deps.runs.save(previous, run);
  for (const detail of [{ type: 'LOAD', receipt }, { type: 'READY' }] as const) {
    const id = `chat:${marker}:${detail.type}`;
    const previous = run.history.find((e) => e.event_id === id);
    const event: LocalEvent = previous
      ? (JSON.parse(previous.payload) as LocalEvent)
      : { event_id: id, expected_revision: run.revision, generation, ...detail };
    if (event.type === 'LOAD')
      requireWorkflow(sameValue(event.receipt, receipt), 'chat-load-replay-conflict');
    run = await advanceLocalWorkflow(event, deps.runs, deps.runInputs);
  }
  return { run, observed };
}
export async function beginChatExecution(
  planning: ChatPlanning,
  gates: Gate[],
  code: boolean,
  deps: ChatDependencies,
) {
  const local = await deps.runs.read();
  requireWorkflow(
    local !== null &&
      (local.spec.route.kind === 'substantial' || local.spec.route.kind === 'local') &&
      local.spec.route.accepted_plan !== null &&
      sameRefs([local.spec.route.accepted_plan], [planning.source]),
    'chat-planning-unconfirmed',
  );
  await deps.inputs.verify([planning.source]);
  let execution = (await deps.journal.read()).execution;
  if (execution === null) {
    execution = createExecution(
      planning.task_id,
      local.generation,
      planning.council.target,
      gates,
      code,
      planning.local ? 'local' : 'substantial',
    );
    execution.requirements_revision = deps.requirements_revision ?? 0;
    await beginExecution(execution, deps.journal);
  }
  requireWorkflow(
    execution.task_id === planning.task_id &&
      execution.code === code &&
      sameValue(execution.gates, gates),
    'chat-execution-conflict',
  );
  const action = planning.local
    ? { type: 'LOCAL' as const, admission: planning.local }
    : { type: 'PLAN' as const, council: planning.council };
  const id =
    `chat:${planning.local ? 'local' : 'planning'}:` +
    (planning.retained_source ?? planning.source).hash;
  const previous = execution.history.find((e) => e.id === id);
  if (previous?.fingerprint !== undefined) {
    requireWorkflow(
      previous.type === action.type &&
        Number.isSafeInteger(previous.expected_revision) &&
        Number.isSafeInteger(previous.generation) &&
        deps.journal.fingerprint !== undefined &&
        deps.journal.fingerprint({
          ...action,
          id,
          expected_revision: previous.expected_revision,
          generation: previous.generation,
        }) === previous.fingerprint,
      'chat-planning-replay-conflict',
    );
    return execution;
  }
  if (previous?.archive !== undefined)
    requireWorkflow(deps.journal.readEvent !== undefined, 'execution-history-reader-required');
  const event: ExecutionEvent = previous
    ? (JSON.parse(
        previous.archive === undefined
          ? previous.payload
          : await deps.journal.readEvent!(previous.archive.hash),
      ) as ExecutionEvent)
    : {
        ...action,
        id,
        expected_revision: execution.revision,
        generation: local.generation,
      };
  requireWorkflow(event.type === 'PLAN' || event.type === 'LOCAL', 'chat-planning-replay-conflict');
  requireWorkflow(
    event.type === action.type &&
      sameValue(
        event.type === 'PLAN' ? event.council : event.admission,
        planning.local ?? planning.council,
      ),
    'chat-planning-replay-conflict',
  );
  return advanceExecution(event, deps.journal, deps.inputs);
}
export async function finishChatProjection(operation: string, deps: ChatDependencies) {
  const execution = (await deps.journal.read()).execution;
  requireWorkflow(
    execution?.status === 'done' &&
      execution.result !== null &&
      executionBlockers(execution).length === 0,
    'chat-completion-not-accepted',
  );
  const current = await deps.runs.read();
  const projection = current?.projection;
  for (const council of [execution.planning, execution.acceptance])
    if (council !== null) await deps.inputs.verify(councilCurrentProfileRefs(council), projection);
  requireWorkflow(
    compareInputs(
      execution.target.inputs,
      await deps.inputs.current(execution.target.inputs, projection),
    ) === 'applicable',
    'chat-result-stale',
  );
  if (execution.target.evidence_inputs !== undefined)
    requireWorkflow(
      compareInputs(
        targetEvidenceInputs(execution.target),
        await deps.inputs.current(execution.target.evidence_inputs, projection),
      ) === 'applicable',
      'chat-result-evidence-stale',
    );
  await verifyCouncilInputs(execution.acceptance, deps.inputs, projection);
  await deps.inputs.verify([execution.target.diff, ...execution.result.evidence], projection);
  if (current?.projection?.result.status === 'confirmed') {
    requireWorkflow(
      current.projection.plan.operation_id === operation && 'task_id' in current.spec.identity,
      'chat-projection-operation-conflict',
    );
    const card = await deps.cards.read(current.spec.identity.card.locator);
    requireWorkflow(
      card.revision === current.spec.identity.card.hash && card.status === 'completed',
      'chat-projection-changed',
    );
    return current;
  }
  if (execution.gates.some((gate) => gate.kind === 'human' && gate.applicable)) {
    requireWorkflow(
      deps.journal.checkHumanCompletion !== undefined,
      'chat-human-completion-reader-required',
    );
    await deps.journal.checkHumanCompletion(execution);
  }
  const run = await projectLocalCard(
    'completed',
    operation,
    deps.runs,
    deps.cards,
    deps.runInputs,
    {
      criteria: execution.gates
        .filter((gate) => gate.applicable)
        .flatMap((gate) => [gate.id, gate.reason]),
      summary: execution.result.summary,
      limitations: execution.result.limitations,
      evidence: execution.result.evidence,
    },
  );
  requireWorkflow(run.projection?.result.status === 'confirmed', 'chat-projection-pending');
  return run;
}
export function chatStatus(execution: Execution | null) {
  return execution === null
    ? { status: 'not-started', blockers: ['execution-not-started'] }
    : {
        status: execution.status,
        blockers: executionBlockers(execution),
        result: execution.result,
      };
}
