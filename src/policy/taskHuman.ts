import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
  text,
} from '../contracts/project.js';
import { textField } from '../contracts/localValues.js';
import { controlRef } from './readerControl.js';
import type {
  BoundTaskHumanManifest,
  TaskHumanCommand,
  TaskHumanCommandContext,
  TaskHumanCriterion,
  TaskHumanManifest,
  TaskHumanReceipt,
  TaskHumanState,
  TaskHumanTarget,
  TaskHumanTechnicalCompletion,
  VerifiedTaskHumanCommand,
  VerifiedTaskHumanRequirements,
} from '../contracts/taskHuman.js';

export function copyTaskHumanValue<
  T extends TaskHumanState | TaskHumanCommandContext | TaskHumanTechnicalCompletion | null,
>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function taskHumanCanonical(value: unknown): string {
  const sorted = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sorted);
    if (input !== null && typeof input === 'object') {
      const row = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((key) => [key, sorted(row[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sorted(value));
}
const same = (left: unknown, right: unknown) =>
  taskHumanCanonical(left) === taskHumanCanonical(right);
function integer(value: unknown, minimum = 0): number {
  requireContract(Number.isSafeInteger(value) && Number(value) >= minimum, 'human-integer');
  return Number(value);
}
export function parseTaskHumanTarget(value: unknown): TaskHumanTarget {
  const v = object(value);
  exactFields(v, [
    'workflowId',
    'projectId',
    'taskId',
    'roleId',
    'hostId',
    'workspaceId',
    'owner',
    'generation',
    'requirementsRevision',
  ]);
  requireContract(v.roleId === 'task', 'human-target-role');
  return {
    workflowId: text(v.workflowId),
    projectId: identifier(v.projectId),
    taskId: identifier(v.taskId),
    roleId: 'task',
    hostId: identifier(v.hostId),
    workspaceId: identifier(v.workspaceId),
    owner: identifier(v.owner),
    generation: integer(v.generation, 1),
    requirementsRevision: integer(v.requirementsRevision, 1),
  };
}
export function parseTaskHumanManifest(value: unknown): TaskHumanManifest {
  const v = object(value);
  exactFields(v, [
    'schemaVersion',
    'kind',
    'target',
    'card',
    'requirements',
    'declaration',
    'criteria',
  ]);
  requireContract(
    v.schemaVersion === 1 && v.kind === 'task-human-gate-manifest',
    'human-manifest-kind',
  );
  const card = object(v.card);
  exactFields(card, ['path', 'sha256', 'bytes']);
  requireContract(Array.isArray(v.criteria), 'human-criteria');
  const criteria = v.criteria.map(parseTaskHumanCriterion);
  requireContract(
    new Set(criteria.map((row) => row.id)).size === criteria.length,
    'human-duplicate-criterion',
  );
  return {
    schemaVersion: 1,
    kind: 'task-human-gate-manifest',
    target: parseTaskHumanTarget(v.target),
    card: {
      path: relativePath(card.path),
      ...controlRef({ sha256: card.sha256, bytes: card.bytes }),
    },
    requirements: controlRef(v.requirements),
    declaration: controlRef(v.declaration),
    criteria,
  };
}
export function parseTaskHumanCriterion(value: unknown): TaskHumanCriterion {
  const row = object(value);
  exactFields(row, ['id', 'text', 'kind', 'applicable', 'reason']);
  requireContract(row.kind === 'human' || row.kind === 'check', 'human-criterion-kind');
  requireContract(typeof row.applicable === 'boolean', 'human-applicability-unknown');
  return {
    id: textField(row.id),
    text: textField(row.text),
    kind: row.kind,
    applicable: row.applicable,
    reason: textField(row.reason),
  };
}
export function parseBoundTaskHumanManifest(value: unknown): BoundTaskHumanManifest {
  const v = object(value);
  exactFields(v, ['manifest', 'ref']);
  return { manifest: parseTaskHumanManifest(v.manifest), ref: controlRef(v.ref) };
}
export function parseTaskHumanCommand(value: unknown): TaskHumanCommand {
  const v = object(value);
  requireContract(v.action === 'ASK' || v.action === 'DECIDE', 'human-action');
  exactFields(v, [
    'schemaVersion',
    'commandId',
    'hash',
    'target',
    'manifest',
    'expectedRevision',
    'author',
    'source',
    'questionId',
    'criterionId',
    'action',
    ...(v.action === 'DECIDE' ? ['accepted'] : []),
  ]);
  requireContract(v.schemaVersion === 1, 'human-command-version');
  const fields = {
    schemaVersion: 1 as const,
    commandId: identifier(v.commandId),
    hash: controlRef({ sha256: v.hash, bytes: 0 }).sha256,
    target: parseTaskHumanTarget(v.target),
    manifest: controlRef(v.manifest),
    expectedRevision: integer(v.expectedRevision),
    author: identifier(v.author),
    source: controlRef(v.source),
    questionId: identifier(v.questionId),
    criterionId: textField(v.criterionId),
  };
  if (v.action === 'ASK') return { ...fields, action: 'ASK' };
  requireContract(typeof v.accepted === 'boolean', 'human-decision');
  return { ...fields, action: 'DECIDE', accepted: v.accepted };
}
export function taskHumanCommandText(value: TaskHumanCommand): string {
  const { hash: omitted, ...body } = parseTaskHumanCommand(value);
  void omitted;
  return taskHumanCanonical(body);
}

// The Activity has verified bytes and origin before this deterministic state is admitted.
export function createTaskHumanState(value: BoundTaskHumanManifest): TaskHumanState {
  return {
    schemaVersion: 1,
    current: parseBoundTaskHumanManifest(value),
    revision: 0,
    closed: false,
    pending: null,
    decisions: [],
    history: [],
  };
}
export function retainedTaskHumanReceipt(state: TaskHumanState, command: TaskHumanCommand) {
  const old = state.history.find((row) => row.receipt.commandId === command.commandId);
  if (old === undefined) return null;
  requireContract(old.kind === 'command' && same(old.command, command), 'human-command-conflict');
  return old.receipt;
}
export function checkTaskHumanCommand(state: TaskHumanState, raw: unknown): TaskHumanCommand {
  const command = parseTaskHumanCommand(raw);
  if (retainedTaskHumanReceipt(state, command) !== null) return command;
  requireContract(!state.closed, 'human-closed');
  requireContract(
    command.expectedRevision === state.revision && state.revision < Number.MAX_SAFE_INTEGER,
    'human-stale',
  );
  requireContract(
    same(command.target, state.current.manifest.target) &&
      same(command.manifest, state.current.ref) &&
      command.author === command.target.owner,
    'human-command-binding',
  );
  requireContract(
    state.current.manifest.criteria.some(
      (row) => row.id === command.criterionId && row.kind === 'human' && row.applicable,
    ),
    'human-criterion-not-applicable',
  );
  if (command.action === 'ASK') {
    requireContract(state.pending === null, 'human-question-pending');
    requireContract(
      !state.history.some(
        (row) => row.kind === 'command' && row.command.questionId === command.questionId,
      ),
      'human-question-reused',
    );
  } else {
    requireContract(
      state.pending?.questionId === command.questionId &&
        state.pending.criterionId === command.criterionId &&
        state.pending.requirementsRevision === command.target.requirementsRevision,
      'human-question-binding',
    );
  }
  return command;
}
export function applyTaskHumanCommand(
  state: TaskHumanState,
  raw: unknown,
  verified: VerifiedTaskHumanCommand,
): { state: TaskHumanState; receipt: TaskHumanReceipt } {
  const command = checkTaskHumanCommand(state, raw),
    retained = retainedTaskHumanReceipt(state, command);
  if (retained !== null) return { state, receipt: retained };
  requireContract(
    verified.kind === 'verified-task-human-command' &&
      verified.action === command.action &&
      same(parseTaskHumanCommand(verified.command), command),
    'human-verification-binding',
  );
  if (command.action === 'DECIDE')
    requireContract(
      verified.action === 'DECIDE' && verified.accepted === command.accepted,
      'human-decision-unconfirmed',
    );
  const proof = controlRef(verified.proof),
    revision = state.revision + 1,
    receipt = {
      commandId: command.commandId,
      hash: command.hash,
      revision,
      requirementsRevision: command.target.requirementsRevision,
      proof,
    },
    next = copyTaskHumanValue(state);
  next.revision = revision;
  if (command.action === 'ASK')
    next.pending = {
      questionId: command.questionId,
      criterionId: command.criterionId,
      requirementsRevision: command.target.requirementsRevision,
      askedRevision: revision,
    };
  else {
    next.decisions.push({
      questionId: command.questionId,
      criterionId: command.criterionId,
      requirementsRevision: command.target.requirementsRevision,
      accepted: command.accepted,
      source: command.source,
      receipt,
    });
    next.pending = null;
  }
  next.history.push({ kind: 'command', command, receipt });
  return { state: next, receipt };
}
export function taskHumanBlockers(state: TaskHumanState): string[] {
  const revision = state.current.manifest.target.requirementsRevision;
  return state.current.manifest.criteria
    .filter((row) => row.kind === 'human' && row.applicable)
    .filter((row) => {
      const latest = [...state.decisions]
        .reverse()
        .find(
          (decision) =>
            decision.criterionId === row.id && decision.requirementsRevision === revision,
        );
      return state.pending?.criterionId === row.id || latest?.accepted !== true;
    })
    .map((row) => row.id);
}
export function closeTaskHuman(state: TaskHumanState, expectedRevision: number): TaskHumanState {
  requireContract(!state.closed && state.revision === expectedRevision, 'human-stale');
  requireContract(
    state.pending === null && taskHumanBlockers(state).length === 0,
    'human-gates-open',
  );
  return { ...copyTaskHumanValue(state), closed: true };
}
export function advanceTaskHumanRequirements(
  state: TaskHumanState,
  verified: VerifiedTaskHumanRequirements,
): TaskHumanState {
  requireContract(!state.closed && state.revision === verified.expectedRevision, 'human-stale');
  requireContract(
    verified.kind === 'verified-task-human-requirements' &&
      same(verified.previousManifest, state.current.ref) &&
      state.revision < Number.MAX_SAFE_INTEGER,
    'human-requirements-binding',
  );
  const next = parseBoundTaskHumanManifest(verified.next),
    previous = state.current.manifest.target;
  requireContract(
    same(next.manifest.target, {
      ...previous,
      requirementsRevision: previous.requirementsRevision + 1,
    }),
    'human-requirements-target',
  );
  requireContract(
    !state.history.some((row) => row.receipt.commandId === verified.commandId),
    'human-command-conflict',
  );
  const receipt: TaskHumanReceipt = {
    commandId: identifier(verified.commandId),
    hash: controlRef({ sha256: verified.hash, bytes: 0 }).sha256,
    revision: state.revision + 1,
    requirementsRevision: next.manifest.target.requirementsRevision,
    proof: controlRef(verified.proof),
  };
  const copied = copyTaskHumanValue(state);
  return {
    ...copied,
    current: next,
    revision: receipt.revision,
    pending: null,
    history: [
      ...copied.history,
      {
        kind: 'requirements',
        previousManifest: copied.current.ref,
        nextManifest: next.ref,
        source: controlRef(verified.source),
        receipt,
      },
    ],
  };
}
