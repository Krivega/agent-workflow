import { isDeepStrictEqual as same } from 'node:util';
import type { LocalProjectRegistration } from './preparation.js';
import type { CodexRpc } from '../contracts/codex.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { ProgressSupervisedTaskInput } from '../contracts/localTask.js';
import type {
  TaskProgressContext,
  TaskProgressAuditActivities,
} from '../contracts/progressAudit.js';
import { object, requireContract } from '../contracts/project.js';
import { auditClaim, parseAuditCard } from '../policy/audit.js';
import {
  parseTaskProgressContext,
  parseTaskProgressAudit,
  parseTaskProgressEvidence,
  taskProgressAuditId,
} from '../policy/progressAudit.js';
import { controlRef } from '../policy/readerControl.js';
import { taskFiles } from '../adapters/project/taskFiles.js';
import { confirmAuditorInputs } from '../adapters/codex/auditInputs.js';
import { verifyAuditResult } from '../adapters/codex/auditProof.js';
import { taskAuditSnapshot, taskAuditMaterials } from './taskAuditMaterials.js';

function progressInputs(registration: LocalProjectRegistration, value: TaskProgressContext) {
  const context = parseTaskProgressContext(value);
  const { files, snapshot } = taskAuditSnapshot(registration, context.input, context.snapshot, [
    context.baseline,
  ]);
  requireContract(snapshot.supervision !== undefined, 'task-progress-planning-required');
  const baseline = object(JSON.parse(files.store.read(context.baseline).toString()) as unknown);
  requireContract(
    baseline.kind === 'task-checks' &&
      same(baseline.input, context.input) &&
      same(baseline.snapshot, context.snapshot) &&
      baseline.stage === 'baseline' &&
      baseline.status === 'PASS' &&
      Array.isArray(baseline.outcomes) &&
      baseline.outcomes.length === 1,
    'task-progress-baseline-binding',
  );
  const outcome = object(baseline.outcomes[0]);
  requireContract(
    outcome.name === context.input.baseline && outcome.status === 'PASS',
    'task-progress-baseline-binding',
  );
  const proof = controlRef(outcome.proof),
    check = object(JSON.parse(files.store.read(proof).toString()) as unknown);
  requireContract(
    check.kind === 'task-check' &&
      same(check.input, context.input) &&
      check.stage === 'baseline' &&
      check.name === context.input.baseline &&
      check.status === 'PASS' &&
      check.code === 0 &&
      check.signal === null &&
      check.error === null &&
      same(check.before, check.after),
    'task-progress-baseline-proof',
  );
  return { context, files, snapshot, proof };
}

export function taskProgressAuditActivities(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
): TaskProgressAuditActivities {
  return {
    async prepareTaskProgressAudit(value, preflight) {
      const { context, files, snapshot, proof } = progressInputs(registration, value);
      const materials = taskAuditMaterials(registration, files, snapshot, context.snapshot, [
        context.baseline,
        proof,
      ]);
      const request = context.input.progress,
        note = parseTaskProgressEvidence(
          JSON.parse(files.store.read(request.trigger.evidence).toString()) as unknown,
          context.input,
          materials.goal,
        );
      for (const ref of note.evidence) files.store.read(ref);
      const claim = auditClaim(null, request.checkpoint, request.trigger, []);
      const record = files.save({
        kind: 'task-progress-audit-context',
        context,
        timing: null,
        claim,
        location: 'after-baseline-before-writing',
        limitation:
          'The trigger is a caller-reported request for independent assessment, not proof of a stalled model or missing progress. There is no active stage at this checkpoint. No stage, estimate or stage elapsed is inferred. Task elapsed is the original Workflow clock observation; null remains unknown. Only the completed chain and primary evidence are confirmed.',
      });
      const completed = [
        ...new Map(
          [record, request.trigger.evidence, ...note.evidence, ...materials.completed].map(
            (ref) => [ref.sha256, ref],
          ),
        ).values(),
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
            ...new Set([
              note.reason,
              'Проверь основание запроса по исходной цели и завершённой цепочке. Причина обращения не доказывает отсутствие прогресса. Будущая реализация, проверки и приёмка ещё неизвестны.',
            ]),
          ],
          checkpoint: request.checkpoint,
          timing: null,
          trigger: request.trigger,
          sources: materials.sources,
          nextAction:
            'Начать первый writer только после полного независимого continue и подтверждённой остановки аудитора. Затем выполнить все обязательные проверки и техническую приёмку.',
        }),
      );
      const input = {
        schemaVersion: 1 as const,
        preparation: context.input.admission.preparation,
        auditId: taskProgressAuditId(context.input),
        card,
        preflight,
      };
      confirmAuditorInputs(registration, input);
      return input;
    },
    async finishTaskProgressAudit(value) {
      const record = parseTaskProgressAudit(value, value.context.input),
        { files } = progressInputs(registration, record.context);
      const ref = files.save(record);
      await confirmTaskProgressAudit(
        registration,
        rpc,
        record.context.input,
        record.context.snapshot,
        record.context.baseline,
        ref,
      );
      return ref;
    },
  };
}
export async function confirmTaskProgressAudit(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  input: ProgressSupervisedTaskInput,
  snapshotRef: ArtifactRef,
  baselineRef: ArtifactRef,
  ref: ArtifactRef,
) {
  const files = taskFiles(registration.artifactRoot);
  const record = parseTaskProgressAudit(
    JSON.parse(files.store.read(ref).toString()) as unknown,
    input,
  );
  requireContract(
    same(record.context.snapshot, snapshotRef) && same(record.context.baseline, baselineRef),
    'task-progress-context-binding',
  );
  const { snapshot, proof } = progressInputs(registration, record.context);
  const card = parseAuditCard(
    JSON.parse(files.store.read(record.audit.input.card).toString()) as unknown,
  );
  const context = object(JSON.parse(files.store.read(card.completed[0]!).toString()) as unknown);
  requireContract(
    context.kind === 'task-progress-audit-context' &&
      same(context.context, record.context) &&
      context.timing === null &&
      context.claim === record.claim &&
      card.timing === null &&
      card.checkpoint === input.progress.checkpoint &&
      same(card.trigger, input.progress.trigger) &&
      card.goal.path === snapshot.plan.requirement.locator &&
      card.goal.sha256 === snapshot.plan.requirement.hash &&
      same(card.criteria, [snapshot.plan.criterion]) &&
      [snapshotRef, baselineRef, proof, input.progress.trigger.evidence].every((required) =>
        card.completed.some((row) => same(row, required)),
      ),
    'task-progress-card-binding',
  );
  const note = parseTaskProgressEvidence(
    JSON.parse(files.store.read(input.progress.trigger.evidence).toString()) as unknown,
    input,
    card.goal,
  );
  requireContract(
    note.evidence.every((required) => card.completed.some((row) => same(row, required))) &&
      card.openFindings.includes(note.reason),
    'task-progress-source-missing',
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
    'task-progress-audit-held',
  );
  return verified.proof;
}
