import type { PreparationInput } from '../contracts/preparation.js';
import type {
  TaskStartAdmission,
  TaskStartPrincipalBinding,
} from '../contracts/taskStartAdmission.js';
import type { TaskHumanTarget } from '../contracts/taskHuman.js';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
} from '../contracts/project.js';
import { parsePreparation } from './preparation.js';
import { controlRef } from './readerControl.js';
import { parseTaskHumanCriterion, parseTaskHumanTarget } from './taskHuman.js';

function nonempty(value: unknown): string {
  requireContract(typeof value === 'string' && value.length > 0, 'task-start-text');
  return value;
}
export function taskStartTarget(value: PreparationInput): TaskHumanTarget {
  const p = parsePreparation(value);
  return {
    workflowId: `aw/task/${p.project.projectId}/${p.taskId}`,
    projectId: p.project.projectId,
    workspaceId: p.project.workspaceId,
    taskId: p.taskId,
    roleId: 'task',
    hostId: p.hostId,
    owner: p.owner,
    generation: p.generation,
    requirementsRevision: p.revision,
  };
}
export function parseTaskStartPrincipal(value: unknown): TaskStartPrincipalBinding {
  const raw = object(value);
  exactFields(raw, ['owner', 'threadId', 'turnId', 'source', 'proof']);
  const source = object(raw.source);
  exactFields(source, ['locator', 'hash']);
  return {
    owner: identifier(raw.owner),
    threadId: identifier(raw.threadId),
    turnId: identifier(raw.turnId),
    source: {
      locator: nonempty(source.locator),
      hash: controlRef({ sha256: source.hash, bytes: 0 }).sha256,
    },
    proof: controlRef(raw.proof),
  };
}

export function parseTaskStartCriteria(value: unknown) {
  requireContract(Array.isArray(value), 'task-start-criteria');
  const criteria = value.map(parseTaskHumanCriterion);
  requireContract(
    new Set(criteria.map((row) => row.id)).size === criteria.length,
    'task-start-criterion-duplicate',
  );
  return criteria;
}

export function parseTaskStartAdmission(value: unknown): TaskStartAdmission {
  const raw = object(value);
  exactFields(raw, [
    'schemaVersion',
    'kind',
    'previous',
    'target',
    'card',
    'requirements',
    'principal',
    'criteria',
  ]);
  requireContract(
    raw.schemaVersion === 1 && raw.kind === 'task-start-admission',
    'task-start-schema',
  );
  const parsedTarget = parseTaskHumanTarget(raw.target);
  requireContract(
    parsedTarget.workflowId === `aw/task/${parsedTarget.projectId}/${parsedTarget.taskId}`,
    'task-start-workflow',
  );
  const card = object(raw.card);
  exactFields(card, ['path', 'sha256', 'bytes']);
  const criteria = parseTaskStartCriteria(raw.criteria);
  return {
    schemaVersion: 1,
    kind: 'task-start-admission',
    previous: raw.previous === null ? null : controlRef(raw.previous),
    target: parsedTarget,
    card: {
      path: relativePath(card.path),
      ...controlRef({ sha256: card.sha256, bytes: card.bytes }),
    },
    requirements: controlRef(raw.requirements),
    principal: parseTaskStartPrincipal(raw.principal),
    criteria,
  };
}
