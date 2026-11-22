import { taskAuditStages } from '../contracts/localTask.js';
import type { ReviewRole } from '../contracts/review.js';
import type {
  CorrectingTaskInput,
  StageSupervisedTaskInput,
  SupervisedTaskInput,
  ProgressSupervisedTaskInput,
  LocalTaskInput,
  TaskTree,
  TaskIntegration,
} from '../contracts/localTask.js';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
} from '../contracts/project.js';
import { parseLocalAdmission } from './localAdmission.js';
import { controlRef } from './readerControl.js';
import { parseSubstantialAdmission } from './substantialTask.js';
import { readerExecution, supportedTaskClient } from './readerExecution.js';
import { parseMechanicalAdmission } from './mechanicalTask.js';

export function parseLocalTask(value: unknown): LocalTaskInput {
  const v = object(value);
  requireContract(
    v.schemaVersion === 1 ||
      v.schemaVersion === 2 ||
      v.schemaVersion === 3 ||
      v.schemaVersion === 4 ||
      v.schemaVersion === 5 ||
      v.schemaVersion === 6 ||
      v.schemaVersion === 7 ||
      v.schemaVersion === 8 ||
      v.schemaVersion === 9 ||
      v.schemaVersion === 10 ||
      v.schemaVersion === 11 ||
      v.schemaVersion === 12,
    'local-task-schema',
  );
  if (v.schemaVersion === 2) {
    exactFields(v, ['schemaVersion', 'admission', 'baseline']);
    return {
      schemaVersion: 2,
      admission: parseMechanicalAdmission(v.admission),
      baseline: identifier(v.baseline),
    };
  }
  exactFields(v, [
    'schemaVersion',
    'admission',
    'executor',
    'baseline',
    ...(v.schemaVersion === 4 || v.schemaVersion === 5 ? ['corrections'] : []),
    ...(v.schemaVersion === 5 || v.schemaVersion === 6 ? ['arbitration'] : []),
    ...(v.schemaVersion === 7 || v.schemaVersion === 8 || v.schemaVersion === 9 ? ['audit'] : []),
    ...(v.schemaVersion === 9 ? ['progress'] : []),
    ...(v.schemaVersion === 10 || v.schemaVersion === 11 || v.schemaVersion === 12
      ? ['continuation']
      : []),
    ...(v.schemaVersion === 12 ? ['startAdmission'] : []),
  ]);
  let corrections: CorrectingTaskInput['corrections'] | undefined;
  if (v.schemaVersion === 4 || v.schemaVersion === 5) {
    const raw = object(v.corrections);
    exactFields(raw, ['maxRounds', 'checks']);
    requireContract(raw.maxRounds === 1 || raw.maxRounds === 2, 'task-correction-budget-invalid');
    requireContract(Array.isArray(raw.checks), 'task-correction-checks-incomplete');
    const checks = raw.checks.map((value) => {
      const row = object(value);
      exactFields(row, ['roleId', 'commands']);
      requireContract(
        Array.isArray(row.commands) && new Set(row.commands).size === row.commands.length,
        'task-correction-checks-incomplete',
      );
      return { roleId: identifier(row.roleId), commands: row.commands.map(identifier) };
    });
    const admission = object(v.admission);
    const project = (
      admission.schemaVersion === 1
        ? parseLocalAdmission(admission)
        : parseSubstantialAdmission(admission)
    ).preparation.project;
    requireContract(
      checks.length === project.roles.length &&
        new Set(checks.map((row) => row.roleId)).size === checks.length &&
        project.roles.every((role) => checks.some((row) => row.roleId === role.id)) &&
        checks.every((row) => row.commands.every((command) => project.checks.includes(command))),
      'task-correction-checks-incomplete',
    );
    corrections = { maxRounds: raw.maxRounds, checks };
  }
  const executor = object(v.executor);
  exactFields(executor, ['path', 'sha256']);
  return {
    ...(v.schemaVersion === 1
      ? { schemaVersion: 1 as const, admission: parseLocalAdmission(v.admission) }
      : v.schemaVersion === 4 || v.schemaVersion === 5
        ? {
            ...(v.schemaVersion === 5
              ? {
                  schemaVersion: 5 as const,
                  arbitration: parseArbitrationConfig(v.arbitration, v.admission, corrections!),
                }
              : { schemaVersion: 4 as const }),
            admission:
              object(v.admission).schemaVersion === 1
                ? parseLocalAdmission(v.admission)
                : parseSubstantialAdmission(v.admission),
            corrections: corrections!,
          }
        : v.schemaVersion === 12
          ? {
              schemaVersion: 12 as const,
              admission: parseSubstantialAdmission(v.admission),
              continuation: parseContinuation(v.continuation),
              startAdmission: controlRef(v.startAdmission),
            }
          : v.schemaVersion === 10 || v.schemaVersion === 11
            ? {
                schemaVersion: v.schemaVersion,
                admission: parseSubstantialAdmission(v.admission),
                continuation: parseContinuation(v.continuation),
              }
            : v.schemaVersion === 7 || v.schemaVersion === 8 || v.schemaVersion === 9
              ? {
                  ...(v.schemaVersion === 7
                    ? {
                        schemaVersion: 7 as const,
                        audit: parseTaskAudit(v.audit, v.admission, 7),
                      }
                    : {
                        ...(v.schemaVersion === 9
                          ? { schemaVersion: 9 as const, progress: parseTaskProgress(v.progress) }
                          : { schemaVersion: 8 as const }),
                        audit: parseTaskAudit(v.audit, v.admission, 8) as {
                          planningEstimateMs: number;
                          stages: Record<(typeof taskAuditStages)[number], number>;
                        },
                      }),
                  admission: parseSubstantialAdmission(v.admission),
                }
              : v.schemaVersion === 6
                ? {
                    schemaVersion: 6 as const,
                    admission: parseSubstantialAdmission(v.admission),
                    arbitration: parseInitialArbitrationConfig(v.arbitration, v.admission),
                  }
                : { schemaVersion: 3 as const, admission: parseSubstantialAdmission(v.admission) }),
    executor: {
      path: relativePath(executor.path),
      sha256: controlRef({ sha256: executor.sha256, bytes: 0 }).sha256,
    },
    baseline: identifier(v.baseline),
  };
}
function parseContinuation(value: unknown) {
  const raw = object(value);
  exactFields(raw, ['attempt', 'previous']);
  requireContract(
    Number.isSafeInteger(raw.attempt) &&
      Number(raw.attempt) >= 0 &&
      (raw.attempt === 0) === (raw.previous === null),
    'task-continuation-invalid',
  );
  return {
    attempt: Number(raw.attempt),
    previous: raw.previous === null ? null : controlRef(raw.previous),
  };
}
function parseTaskAudit(value: unknown, admission: unknown, version: 7 | 8) {
  const raw = object(value);
  exactFields(raw, ['planningEstimateMs', ...(version === 8 ? ['stages'] : [])]);
  requireContract(
    Number.isSafeInteger(raw.planningEstimateMs) &&
      Number(raw.planningEstimateMs) > 0 &&
      Number(raw.planningEstimateMs) <= 3_600_000,
    'task-audit-estimate-invalid',
  );
  requireContract(
    parseSubstantialAdmission(admission).preparation.project.roles.some((r) => r.id === 'auditor'),
    'task-auditor-required',
  );
  if (version === 7) return { planningEstimateMs: Number(raw.planningEstimateMs) };
  const stages = object(raw.stages);
  exactFields(stages, [...taskAuditStages]);
  requireContract(
    taskAuditStages.every(
      (stage) =>
        Number.isSafeInteger(stages[stage]) &&
        Number(stages[stage]) > 0 &&
        Number(stages[stage]) <= 3_600_000,
    ),
    'task-audit-estimate-invalid',
  );
  return {
    planningEstimateMs: Number(raw.planningEstimateMs),
    stages: stages as Record<(typeof taskAuditStages)[number], number>,
  };
}
function parseTaskProgress(value: unknown): ProgressSupervisedTaskInput['progress'] {
  const raw = object(value);
  exactFields(raw, ['checkpoint', 'trigger']);
  const trigger = object(raw.trigger);
  exactFields(trigger, ['kind', 'evidence']);
  requireContract(
    trigger.kind === 'no-progress' || trigger.kind === 'doubt',
    'task-progress-trigger',
  );
  const checkpoint = identifier(raw.checkpoint);
  identifier('progress-' + checkpoint);
  return {
    checkpoint,
    trigger: { kind: trigger.kind, evidence: controlRef(trigger.evidence) },
  };
}
export function stageSupervisedTask(input: LocalTaskInput): input is StageSupervisedTaskInput {
  return input.schemaVersion === 8 || input.schemaVersion === 9;
}
export function supervisedTask(input: LocalTaskInput): input is SupervisedTaskInput {
  return input.schemaVersion === 7 || stageSupervisedTask(input);
}
export function localTaskKey(input: LocalTaskInput): string {
  const p = parseLocalTask(input).admission.preparation;
  return `aw/task/${p.project.projectId}/${p.taskId}`;
}
export function taskPathAllowed(paths: readonly string[], path: string): boolean {
  return paths.some((scope) => path === scope || path.startsWith(scope + '/'));
}
export function taskPrivatePath(path: string): boolean {
  return path
    .split('/')
    .some(
      (part) =>
        ['.git', '.agents', '.codex', '.aws', '.ssh', '.gnupg', 'node_modules'].includes(
          part.toLowerCase(),
        ) ||
        /^\.env(?:\.|$)/iu.test(part) ||
        /\.(?:pem|key|p12|pfx)$/iu.test(part),
    );
}
export function taskDelta(before: TaskTree, after: TaskTree): TaskIntegration['changes'] {
  const paths = [
    ...new Set([...before.files.map((f) => f.path), ...after.files.map((f) => f.path)]),
  ];
  const key = (version: TaskIntegration['changes'][number]['before']) =>
    version === null
      ? null
      : JSON.stringify([version.mode, version.content.sha256, version.content.bytes]);
  return paths
    .map((path) => ({
      path,
      before: before.files.find((f) => f.path === path)?.version ?? null,
      after: after.files.find((f) => f.path === path)?.version ?? null,
    }))
    .filter((change) => key(change.before) !== key(change.after));
}

export function checkCorrectionRoles(input: CorrectingTaskInput, roles: ReviewRole[]) {
  requireContract(
    roles.every(
      (role) =>
        role.applies !== true ||
        input.corrections.checks.find((row) => row.roleId === role.roleId)!.commands.length > 0,
    ),
    'task-role-checks-incomplete',
  );
}

export function correctingTask(input: LocalTaskInput): input is CorrectingTaskInput {
  return input.schemaVersion === 4 || input.schemaVersion === 5;
}
function parseInitialArbitrationConfig(value: unknown, admission: unknown) {
  const raw = object(value);
  exactFields(raw, ['roleId', 'profile']);
  const roleId = identifier(raw.roleId),
    profile = readerExecution(
      object(raw.profile) as unknown as Parameters<typeof readerExecution>[0],
    ).profile;
  requireContract(
    parseSubstantialAdmission(admission).preparation.project.roles.some((r) => r.id === roleId) &&
      supportedTaskClient(profile.clientVersion),
    'task-arbitration-role-invalid',
  );
  return { roleId, profile };
}
function parseArbitrationConfig(
  value: unknown,
  admission: unknown,
  corrections: CorrectingTaskInput['corrections'],
) {
  const raw = object(value);
  exactFields(raw, ['roleId', 'profile', 'compromiseFindings']);
  requireContract(corrections.maxRounds === 2, 'task-arbitration-two-corrections-required');
  const a = object(admission),
    project = (a.schemaVersion === 1 ? parseLocalAdmission(a) : parseSubstantialAdmission(a))
      .preparation.project;
  const roleId = identifier(raw.roleId),
    profile = readerExecution(
      object(raw.profile) as unknown as Parameters<typeof readerExecution>[0],
    ).profile;
  requireContract(
    project.roles.some((role) => role.id === roleId) && supportedTaskClient(profile.clientVersion),
    'task-arbitration-role-invalid',
  );
  requireContract(Array.isArray(raw.compromiseFindings), 'task-arbitration-findings-invalid');
  const compromiseFindings = raw.compromiseFindings.map((value) => {
    const row = object(value);
    exactFields(row, ['roleId', 'findingId']);
    return { roleId: identifier(row.roleId), findingId: identifier(row.findingId) };
  });
  requireContract(
    compromiseFindings.every(
      (row) => row.roleId !== roleId && project.roles.some((role) => role.id === row.roleId),
    ) &&
      new Set(compromiseFindings.map((row) => JSON.stringify(row))).size ===
        compromiseFindings.length,
    'task-arbitration-findings-invalid',
  );
  return { roleId, profile, compromiseFindings };
}
