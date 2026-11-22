import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { SupervisedTaskInput } from '../contracts/localTask.js';
import type { TaskAuditActivities, PlanningReaderObservation } from '../contracts/taskAudit.js';
import type { ReviewInput } from '../contracts/review.js';
import type { CodexRpc } from '../contracts/codex.js';
import type { LocalProjectRegistration } from './preparation.js';
import { object, requireContract } from '../contracts/project.js';
import { parseLocalTask, supervisedTask } from '../policy/localTask.js';
import { parseReviewInput, parseReviewRequest } from '../policy/review.js';
import { parseSubstantialPlan } from '../policy/substantialTask.js';
import { auditClaim, parseAuditCard, parseAuditTiming } from '../policy/audit.js';
import { parsePlanningSupervision } from '../policy/taskAudit.js';
import { checkRegistration } from '../policy/preparation.js';
import { artifactStore, digest, readProjectFile } from '../adapters/artifacts/files.js';
import { verifyAuditResult } from '../adapters/codex/auditProof.js';
import { confirmAuditorInputs } from '../adapters/codex/auditInputs.js';
import { taskFiles } from '../adapters/project/taskFiles.js';
import { reviewActivities } from './review.js';
import { readerSession } from '../adapters/codex/readerSession.js';
import { scopedReviewInputs } from '../adapters/codex/reviewInputs.js';
import { confirmObservedLoad } from '../adapters/codex/observedLoad.js';
import { readerKey, readerTarget, controlRef } from '../policy/readerControl.js';
import { readerExecution } from '../policy/readerExecution.js';
import { nativeReaderHeader, unpersistedReaderHistory } from '../adapters/codex/readerHeader.js';

function planningInputs(
  registration: LocalProjectRegistration,
  value: SupervisedTaskInput,
  raw: ReviewInput,
) {
  const input = parseLocalTask(value),
    planning = parseReviewInput(raw),
    store = artifactStore(registration.artifactRoot);
  requireContract(
    supervisedTask(input) && same(planning.preparation, input.admission.preparation),
    'task-supervision-input',
  );
  checkRegistration(input.admission.preparation, registration);
  const bytes = readProjectFile(registration.workspaceRoot, input.admission.plan.path);
  requireContract(digest(bytes) === input.admission.plan.sha256, 'substantial-plan-changed');
  const plan = parseSubstantialPlan(JSON.parse(bytes.toString()) as unknown);
  const request = parseReviewRequest(
    JSON.parse(store.read(planning.request).toString()) as unknown,
    planning,
  );
  requireContract(
    request.schemaVersion === 3 &&
      request.phase === 'planning' &&
      request.scope === plan.plan_id &&
      request.evidence.length > 0 &&
      (() => {
        const ref = request.evidence.at(-1)!;
        const body = object(JSON.parse(store.read(ref).toString()) as unknown);
        return (
          body.kind === 'substantial-proposal' && same(body.input, input) && same(body.plan, plan)
        );
      })(),
    'task-supervision-planning',
  );
  return { input, planning, plan, request, sources: request.expectedFiles };
}

export async function taskPlanningProgress(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  profile: { model: string; effort: string; clientVersion: string },
  value: SupervisedTaskInput,
  rawPlanning: ReviewInput,
  readers: PlanningReaderObservation[],
) {
  const { input, planning } = planningInputs(registration, value, rawPlanning);
  const files = taskFiles(registration.artifactRoot),
    store = files.store;
  const read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  const plan = await reviewActivities(registration, rpc, profile).prepareReviewPlan(planning);
  const roles = await Promise.all(
    plan.decisions.map(async (row) => {
      if (row.action !== 'review')
        return {
          roleId: row.roleId,
          action: row.action,
          answer: row.answer === null ? null : { ref: row.answer, content: read(row.answer) },
        };
      const observed = readers.find((r) => same(r.input, row.input));
      if (observed === undefined)
        return {
          roleId: row.roleId,
          action: row.action,
          observation: 'unobserved',
          limitation:
            'The host has no confirmed registration; no claim of absent or stalled model work.',
        };
      const permit = read(observed.permit);
      requireContract(
        permit.kind === 'reader-permit' &&
          same(permit.target, readerTarget(observed.input, readerKey(observed.input))) &&
          same(permit.workspace, files.binding(registration.workspaceRoot)) &&
          same(permit.execution, readerExecution(profile)),
        'task-progress-permit-binding',
      );
      const operations = observed.operations === undefined ? null : read(observed.operations);
      if (operations !== null)
        requireContract(
          operations.kind === 'task-planning-reader-operations' &&
            same(operations.input, observed.input) &&
            same(operations.permit, observed.permit),
          'task-progress-operations-binding',
        );
      if (observed.session === null)
        return {
          roleId: row.roleId,
          action: row.action,
          observation: 'registered',
          permit: { ref: observed.permit, content: permit },
          operations,
          limitation: 'No confirmed model session yet; registration alone is not model progress.',
        };
      requireContract(row.input !== null, 'task-progress-reader-required');
      const creation = read(observed.session.creation);
      requireContract(
        creation.kind === 'reader-session' && same(creation.input, row.input),
        'task-progress-session-binding',
      );
      readerSession(creation.response, registration.workspaceRoot, profile, observed.session.id);
      const scoped = scopedReviewInputs(registration, row.input);
      let raw: unknown,
        historyError: string | null = null;
      try {
        raw = await rpc.request('thread/read', {
          threadId: observed.session.id,
          includeTurns: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!unpersistedReaderHistory(error, profile.clientVersion)) throw error;
        historyError = message;
        raw = (
          await nativeReaderHeader(rpc, registration.workspaceRoot, profile, observed.session.id)
        ).raw;
      }
      const primary = object(object(raw).thread);
      requireContract(
        primary.id === observed.session.id &&
          primary.cwd === registration.workspaceRoot &&
          primary.parentThreadId === null &&
          primary.forkedFromId === null &&
          (historyError !== null || Array.isArray(primary.turns)),
        'task-progress-primary-binding',
      );
      const first = historyError === null ? (primary.turns as unknown[]).map(object)[0] : undefined;
      const loadConfirmed = first !== undefined && first.status === 'completed';
      if (loadConfirmed) confirmObservedLoad(first, scoped.refs);
      return {
        roleId: row.roleId,
        action: row.action,
        observation: 'session-observed',
        permit: { ref: observed.permit, content: permit },
        operations,
        session: {
          id: observed.session.id,
          creation: { ref: observed.session.creation, content: creation },
        },
        snapshot: { ref: row.input.review, content: scoped.snapshot },
        preparation: {
          ref: controlRef(object(creation.prepared).manifest),
          content: read(controlRef(object(creation.prepared).manifest)),
        },
        primary,
        historyError,
        loadConfirmed,
        limitation:
          historyError === null
            ? 'Observed turns and any raw answer are evidence at this checkpoint, not technical acceptance.'
            : 'Native history is unavailable before the first persisted turn in CLI 0.154.0. Only the native header, creation and permission are confirmed; no claim that model work is absent, stopped or accepted.',
      };
    }),
  );
  return store.publish(
    Buffer.from(
      JSON.stringify({
        kind: 'task-planning-progress',
        input,
        planning,
        plan: { ref: plan.manifest, content: read(plan.manifest) },
        roles,
      }),
    ),
  );
}
export function taskAuditActivities(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
): TaskAuditActivities {
  const store = artifactStore(registration.artifactRoot),
    save = (v: unknown) => store.publish(Buffer.from(JSON.stringify(v)));
  return {
    async prepareTaskPlanningAudit(value, rawPlanning, preflight, rawTiming, progress) {
      const { input, planning, plan, request, sources } = planningInputs(
          registration,
          value,
          rawPlanning,
        ),
        timing = parseAuditTiming(rawTiming);
      requireContract(
        timing.stage === 'planning' &&
          timing.estimateMs === input.audit.planningEstimateMs &&
          timing.externalWaitMs === 0,
        'task-supervision-time',
      );
      const claim = auditClaim(timing, 'planning-overrun', { kind: 'overrun' }, []);
      requireContract(progress !== undefined, 'task-progress-required');
      const observed = object(JSON.parse(store.read(progress).toString()) as unknown);
      requireContract(
        observed.kind === 'task-planning-progress' &&
          same(observed.input, input) &&
          same(observed.planning, planning),
        'task-progress-binding',
      );
      for (const source of sources) {
        const bytes = readProjectFile(registration.workspaceRoot, source.path);
        requireContract(
          bytes.length === source.bytes && digest(bytes) === source.sha256,
          'task-supervision-source-changed',
        );
      }
      const goal = sources.find(
        (source) =>
          source.path === plan.requirement.locator && source.sha256 === plan.requirement.hash,
      );
      requireContract(goal !== undefined, 'task-supervision-goal-missing');
      const context = save({
        kind: 'task-planning-audit-context',
        input,
        planning,
        timing,
        claim,
        progress,
        limitation:
          'Unreceived role findings remain unknown. Full primary role observations and their limitations are supplied separately, without inferring acceptance.',
      });
      const card = save(
        parseAuditCard({
          schemaVersion: 1,
          kind: 'audit-card',
          preparation: input.admission.preparation,
          goal,
          criteria: [plan.criterion],
          completed: [
            ...new Map(
              [
                context,
                planning.request,
                ...request.evidence,
                input.admission.planning,
                input.admission.acceptance,
                progress,
              ].map((ref) => [ref.sha256, ref]),
            ).values(),
          ],
          openFindings: [
            'Состояние ролей и исходные ответы приведены в первичных наблюдениях. Неполученные ответы и неустановленные факты остаются неизвестными; аудит не выдаёт техническую приёмку.',
          ],
          checkpoint: 'planning-overrun',
          timing,
          trigger: { kind: 'overrun' },
          sources,
          nextAction:
            'Получить исходный полный совет. Допустить реализацию только после полного аудита с направлением continue и подтверждённой остановки аудитора; не заменять техническую приёмку.',
        }),
      );
      const result = {
        schemaVersion: 1 as const,
        preparation: input.admission.preparation,
        auditId: 'planning-overrun',
        card,
        preflight,
      };
      confirmAuditorInputs(registration, result);
      return result;
    },
    async finishTaskPlanningAudit(value) {
      const record = parsePlanningSupervision(value, value.input);
      planningInputs(registration, record.input, record.planning);
      await confirmPlanningSupervision(
        registration,
        rpc,
        record.input,
        record.planning,
        save(record),
      );
      return save(record);
    },
  };
}
export async function confirmPlanningSupervision(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  input: SupervisedTaskInput,
  expectedPlanning: ReviewInput,
  ref: ArtifactRef,
) {
  const store = artifactStore(registration.artifactRoot),
    record = parsePlanningSupervision(JSON.parse(store.read(ref).toString()) as unknown, input);
  const { plan, sources, request } = planningInputs(registration, input, expectedPlanning);
  requireContract(same(record.planning, expectedPlanning), 'task-supervision-planning-binding');
  if (record.audit === null) return null;
  const card = parseAuditCard(
    JSON.parse(store.read(record.audit.input.card).toString()) as unknown,
  );
  requireContract(
    card.trigger.kind === 'overrun' &&
      card.timing !== null &&
      card.timing.stage === 'planning' &&
      card.timing.estimateMs === input.audit.planningEstimateMs &&
      card.timing.knownElapsedMs <= record.timing.knownElapsedMs &&
      same(card.sources, sources) &&
      card.goal.path === plan.requirement.locator &&
      card.goal.sha256 === plan.requirement.hash &&
      same(card.criteria, [plan.criterion]),
    'task-supervision-card-binding',
  );
  requireContract(card.completed.length > 0, 'task-supervision-context-binding');
  const context = object(JSON.parse(store.read(card.completed[0]!).toString()) as unknown);
  requireContract(
    context.kind === 'task-planning-audit-context' &&
      same(context.input, input) &&
      same(context.planning, record.planning) &&
      same(context.timing, card.timing) &&
      context.claim === record.claim &&
      [
        record.planning.request,
        ...request.evidence,
        input.admission.planning,
        input.admission.acceptance,
        controlRef(context.progress),
      ].every((required) => card.completed.some((ref) => same(ref, required))),
    'task-supervision-context-binding',
  );
  const verified = await verifyAuditResult(
    registration,
    rpc,
    record.audit.input,
    record.audit.result,
    record.audit.stop,
  );
  requireContract(
    verified.report.coverage === 'complete' && verified.report.direction === 'continue',
    'task-supervision-held',
  );
  return verified.proof;
}
