import { lstatSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import type { HumanManagedTaskInput, TaskSnapshot } from '../contracts/localTask.js';
import type { LocalProjectRegistration } from '../contracts/preparation.js';
import type { SubstantialCriterionCheck } from '../contracts/substantialTask.js';
import type { VerifiedStartAdmission } from '../contracts/taskStartAdmission.js';
import { checkSubstantialStartInputs } from '../activities/substantialTask.js';
import { digest } from '../adapters/artifacts/files.js';
import { requireContract } from '../contracts/project.js';

type Inspected = ReturnType<typeof checkSubstantialStartInputs>;
type Criterion = VerifiedStartAdmission['admission']['criteria'][number];
type Check = {
  stage: SubstantialCriterionCheck['stage'] | 'human';
  participant: string;
  evidence: string | null;
  success: string | null;
} & ({ subject: string } | { commandId: string; command: TaskSnapshot['commands'][string] });

function criterionId(criterion: Criterion) {
  return /^([a-zA-Z0-9_-]+): /u.exec(criterion.text)?.[1] ?? criterion.id;
}

function criterionAssignments(
  criteria: Criterion[],
  { plan, commands }: Pick<Inspected, 'plan' | 'commands'>,
) {
  const declared = plan.criterion_checks ?? [];
  const rows = criteria.map((criterion) => {
    const id = criterionId(criterion);
    const checks: Check[] = declared
      .filter((check) => check.criterion === id || check.criterion === criterion.text)
      .map(({ evidence, success, ...check }) => ({
        stage: check.stage,
        ...('roleId' in check
          ? { participant: check.roleId, subject: check.subject }
          : { participant: 'Хост', commandId: check.command, command: commands[check.command]! }),
        evidence: evidence ?? null,
        success: success ?? null,
      }));
    if (criterion.kind === 'human' && criterion.applicable)
      checks.push({
        stage: 'human',
        participant: 'Владелец задачи',
        subject: criterion.text,
        evidence: 'Зафиксированное решение человека по критерию текущей редакции',
        success: 'Человек подтвердил выполнение критерия',
      });
    return {
      id,
      text: criterion.text,
      applicable: criterion.applicable,
      reason: criterion.applicable ? null : criterion.reason,
      checks,
    };
  });
  for (const check of declared)
    requireContract(
      rows.filter((row) => check.criterion === row.id || check.criterion === row.text).length === 1,
      'substantial-criterion-check-target',
    );
  return rows;
}

function criterionGaps(criteria: ReturnType<typeof criterionAssignments>) {
  const withoutReviewer = criteria
    .filter((row) => row.applicable && row.checks.length === 0)
    .map(({ id, text }) => ({ id, text, reason: 'Проверяющий не назначен' }));
  const incompleteChecks = criteria
    .filter((row) => row.applicable)
    .flatMap(({ id, text, checks }) =>
      checks
        .filter((check) => check.evidence === null || check.success === null)
        .map(({ stage, participant, evidence, success }) => ({
          id,
          text,
          stage,
          participant,
          missing: [
            ...(evidence === null ? ['Доказательство не указано'] : []),
            ...(success === null ? ['Условие успеха не задано'] : []),
          ],
        })),
    );
  return { withoutReviewerCount: withoutReviewer.length, withoutReviewer, incompleteChecks };
}

export function buildPreparedTaskPreview(
  registration: LocalProjectRegistration,
  input: HumanManagedTaskInput,
  admitted: VerifiedStartAdmission,
) {
  const { plan, commands, request, acceptance, tree } = checkSubstantialStartInputs(
    registration,
    input,
  );
  const { card, project } = input.admission.preparation;
  const retainedCard = admitted.admission.card;
  requireContract(
    same(admitted.ref, input.startAdmission) &&
      same(tree.files.find((file) => file.path === card)?.version.content, {
        sha256: retainedCard.sha256,
        bytes: retainedCard.bytes,
      }),
    'task-start-card-changed',
  );
  const criteria = criterionAssignments(admitted.admission.criteria, { plan, commands });
  const assigned = (stage: Check['stage']) =>
    criteria.filter((row) => row.checks.some((check) => check.stage === stage)).map(({ id }) => id);
  const profiles = new Map(project.roles.map(({ id, profile }) => [id, profile]));
  const reviewers = (review: Inspected['request']) =>
    review.roles
      .filter((role) => role.applies === true)
      .map(({ roleId }) => ({ roleId, profile: profiles.get(roleId)! }));
  const command = (id: string) => ({ id, ...commands[id]! });
  const roots = [registration.workspaceRoot, registration.artifactRoot].map((path) => {
    const { dev, ino } = lstatSync(path, { bigint: true });
    return { path, dev: String(dev), ino: String(ino) };
  });
  return {
    fingerprint: digest(
      Buffer.from(JSON.stringify({ roots, tree, commands, admission: admitted.manifest.ref })),
    ),
    summary: {
      gaps: criterionGaps(criteria),
      card,
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      workspaceRoot: registration.workspaceRoot,
      plan: { id: plan.plan_id, path: input.admission.plan.path, reason: plan.reason },
      criteria,
      stages: {
        planning: { task: 'Проверить и согласовать план', roles: reviewers(request) },
        baseline: {
          participant: 'Хост',
          commands: [command(input.baseline)],
          criteria: assigned('baseline'),
        },
        writing: {
          task: 'Реализовать согласованный план в копии',
          profile: input.executor.path,
          paths: plan.paths,
          criterion: plan.criterion,
          criteria: criteria
            .filter(({ id, text }) => plan.criterion === id || plan.criterion === text)
            .map(({ id }) => id),
        },
        candidate: {
          participant: 'Хост',
          commands: plan.checks.map(command),
          criteria: assigned('candidate'),
        },
        integrated: {
          participant: 'Хост',
          commands: plan.checks.map(command),
          criteria: assigned('integrated'),
        },
        acceptance: {
          task: 'Проверить результат и материалы',
          roles: reviewers(acceptance),
          criteria: assigned('acceptance'),
        },
        human: { participant: 'Владелец задачи', criteria: assigned('human') },
      },
      effects: {
        preview:
          'Читает и проверяет локальные файлы и выданный допуск, не резервируя назначение и не обращаясь к Temporal или моделям.',
        start:
          'Сверяет закреплённый вход и допуск, резервирует назначение и запрашивает запуск в Temporal.',
        worker: [
          'После допуска проверяет план с применимыми ролями. Модель вызывается, если для роли нужен новый ответ.',
          'После приёмки плана выполняет исходную проверку. При её успехе запускает модель исполнителя с записью в копию только в указанной области.',
          'Проверяет кандидат и после успешных проверок и сверки исходного дерева переносит изменения в рабочую копию.',
          'Проверяет рабочую копию после переноса. При успехе готовит материалы для применимых ролей приёмки и вызывает модель, если нужен новый ответ.',
          'Завершает задачу после технической приёмки и применимых решений человека.',
        ],
      },
    },
  };
}
