import { taskAuditMaterials, taskAuditSnapshot } from './taskAuditMaterials.js';
import { isDeepStrictEqual as same } from 'node:util';
import type { LocalProjectRegistration } from './preparation.js';
import type { CodexRpc } from '../contracts/codex.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { StageSupervisedTaskInput } from '../contracts/localTask.js';
import type { TaskStageAuditActivities, TaskStageContext } from '../contracts/stageAudit.js';
import { taskAuditStages } from '../contracts/localTask.js';
import { object, requireContract } from '../contracts/project.js';
import { parseTaskStageContext, parseTaskStageAudit } from '../policy/stageAudit.js';
import { parseAuditCard, parseAuditTiming, auditClaim } from '../policy/audit.js';
import { controlRef } from '../policy/readerControl.js';
import { taskFiles } from '../adapters/project/taskFiles.js';
import { verifyAuditResult } from '../adapters/codex/auditProof.js';
import { confirmAuditorInputs } from '../adapters/codex/auditInputs.js';

function stageInputs(registration: LocalProjectRegistration, value: TaskStageContext) {
  const context = parseTaskStageContext(value);
  return {
    context,
    ...taskAuditSnapshot(registration, context.input, context.snapshot, context.completed),
  };
}

export function taskStageAuditActivities(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
): TaskStageAuditActivities {
  return {
    async prepareTaskStageAudit(value, rawTiming, preflight) {
      const { context, files, snapshot } = stageInputs(registration, value),
        timing = parseAuditTiming(rawTiming);
      requireContract(
        timing.stage === context.stage &&
          timing.estimateMs === context.input.audit.stages[context.stage] &&
          timing.externalWaitMs === 0,
        'task-stage-time',
      );
      const claim = auditClaim(timing, context.stage + '-overrun', { kind: 'overrun' }, []);
      const original = files.save({
        kind: 'task-stage-audit-context',
        context,
        timing,
        claim,
        limitation:
          'These are the exact completed artifacts and the original stage estimate. The in-flight operation has not returned; its result and any unobserved model progress remain unknown. This audit cannot grant technical acceptance.',
      });
      const materials = taskAuditMaterials(
        registration,
        files,
        snapshot,
        context.snapshot,
        context.completed,
      );
      const completed = [
        ...new Map([original, ...materials.completed].map((ref) => [ref.sha256, ref])).values(),
      ];
      const card = files.save(
        parseAuditCard({
          schemaVersion: 1,
          kind: 'audit-card',
          preparation: context.input.admission.preparation,
          goal: materials.goal,
          criteria: [snapshot.plan.criterion],
          completed,
          openFindings: [
            'Незавершённая операция и неполученные ответы остаются неизвестными. Исходные FAIL и обязательная техническая приёмка сохраняются.',
          ],
          checkpoint: context.stage + '-overrun',
          timing,
          trigger: { kind: 'overrun' },
          sources: materials.sources,
          nextAction:
            'Завершить исходную операцию; продолжать только после полного аудита continue, подтверждённой остановки аудитора и собственных проверок операции.',
        }),
      );
      const input = {
        schemaVersion: 1 as const,
        preparation: context.input.admission.preparation,
        auditId: context.stage + '-overrun',
        card,
        preflight,
      };
      confirmAuditorInputs(registration, input);
      return input;
    },
    async finishTaskStageAudit(value) {
      const record = parseTaskStageAudit(value, value.context.input);
      const { files } = stageInputs(registration, record.context);
      const ref = files.save(record);
      await confirmTaskStageAudit(registration, rpc, record.context.input, ref);
      return ref;
    },
  };
}
export async function confirmTaskStageAudit(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  input: StageSupervisedTaskInput,
  ref: ArtifactRef,
) {
  const files = taskFiles(registration.artifactRoot),
    record = parseTaskStageAudit(JSON.parse(files.store.read(ref).toString()) as unknown, input);
  const { snapshot } = stageInputs(registration, record.context);
  if (record.audit === null) return { record, proof: null };
  const card = parseAuditCard(
    JSON.parse(files.store.read(record.audit.input.card).toString()) as unknown,
  );
  const context = object(JSON.parse(files.store.read(card.completed[0]!).toString()) as unknown);
  requireContract(
    context.kind === 'task-stage-audit-context' &&
      same(context.context, record.context) &&
      context.claim === record.claim &&
      card.goal.path === snapshot.plan.requirement.locator &&
      card.goal.sha256 === snapshot.plan.requirement.hash &&
      same(card.criteria, [snapshot.plan.criterion]) &&
      card.checkpoint === record.context.stage + '-overrun' &&
      same(context.timing, card.timing) &&
      card.trigger.kind === 'overrun' &&
      card.timing !== null &&
      card.timing.stage === record.context.stage &&
      card.timing.estimateMs === record.timing.estimateMs &&
      card.timing.knownElapsedMs <= record.timing.knownElapsedMs &&
      [record.context.snapshot, ...record.context.completed].every((required) =>
        card.completed.some((r) => same(r, required)),
      ),
    'task-stage-card-binding',
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
    'task-stage-audit-held',
  );
  return { record, proof: verified.proof };
}
export async function confirmTaskStages(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  input: StageSupervisedTaskInput,
  snapshot: ArtifactRef,
  refs: ArtifactRef[],
) {
  requireContract(refs.length === taskAuditStages.length, 'task-stages-incomplete');
  const proofs = [];
  for (const [index, ref] of refs.entries()) {
    const verified = await confirmTaskStageAudit(registration, rpc, input, controlRef(ref));
    requireContract(
      verified.record.context.stage === taskAuditStages[index] &&
        same(verified.record.context.snapshot, snapshot),
      'task-stages-order',
    );
    proofs.push(verified.proof);
  }
  return proofs;
}
