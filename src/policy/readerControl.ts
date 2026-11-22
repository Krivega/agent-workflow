import type { ArtifactRef } from '../contracts/preparation.js';
import type { ReaderInput, ScopedReaderInput } from '../contracts/reader.js';
import type {
  ReaderCommand,
  ReaderControlState,
  ReaderTarget,
  ReaderOperationKey,
  AuthorizedReaderCommand,
  PayloadReaderCommand,
  ArchiveCommand,
} from '../contracts/readerControl.js';
import { exactFields, identifier, object, requireContract, text } from '../contracts/project.js';
import { parsePreparation } from './preparation.js';

export function parseReaderInput(value: unknown): ReaderInput {
  const raw = object(value);
  const scoped = Object.hasOwn(raw, 'schemaVersion');
  exactFields(
    raw,
    scoped
      ? ['schemaVersion', 'preparation', 'roleId', 'reviewId', 'review']
      : ['preparation', 'roleId'],
  );
  const preparation = parsePreparation(raw.preparation),
    roleId = identifier(raw.roleId);
  requireContract(
    preparation.project.roles.some((role) => role.id === roleId),
    'reader-role-not-declared',
  );
  if (!scoped) return { preparation, roleId };
  requireContract(raw.schemaVersion === 2, 'reader-schema-version-unsupported');
  return {
    schemaVersion: 2,
    preparation,
    roleId,
    reviewId: controlRef({ sha256: raw.reviewId, bytes: 0 }).sha256,
    review: controlRef(raw.review),
  };
}
export function scopedReader(input: ReaderInput): input is ScopedReaderInput {
  return 'schemaVersion' in input;
}

export function readerOperationKey(value: ReaderInput, attempt: number): ReaderOperationKey {
  const role = identifier(value.roleId),
    revision = value.preparation.revision;
  return scopedReader(value)
    ? [role, revision, value.reviewId, value.review, attempt]
    : attempt === 0
      ? [role, revision]
      : [role, revision, attempt];
}

export function readerKey(input: ReaderInput): string {
  const parsed = parseReaderInput(input),
    { preparation, roleId } = parsed;
  if (scopedReader(parsed))
    return `aw/review-reader/${preparation.project.projectId}/${preparation.taskId}/${roleId}/${parsed.reviewId}`;
  return `aw/controlled-reader/${preparation.project.projectId}/${preparation.taskId}/${roleId}`;
}
export function readerTarget(input: ReaderInput, workflowId: string): ReaderTarget {
  const p = parsePreparation(input.preparation);
  requireContract(workflowId === readerKey(input), 'reader-workflow-id-mismatch');
  return {
    workflowId,
    projectId: p.project.projectId,
    taskId: p.taskId,
    roleId: identifier(input.roleId),
    hostId: p.hostId,
    workspaceId: p.project.workspaceId,
    owner: p.owner,
    generation: p.generation,
    requirementsRevision: p.revision,
  };
}
function integer(value: unknown): number {
  requireContract(
    Number.isSafeInteger(value) && Number(value) >= 0,
    'reader-control-revision-invalid',
  );
  return Number(value);
}
export function controlRef(value: unknown): ArtifactRef {
  const ref = object(value);
  exactFields(ref, ['sha256', 'bytes']);
  requireContract(
    typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(ref.sha256),
    'reader-control-proof-invalid',
  );
  return { sha256: ref.sha256, bytes: integer(ref.bytes) };
}
export function parseReaderCommand(value: unknown): ReaderCommand {
  const command = object(value);
  exactFields(command, [
    'schemaVersion',
    'commandId',
    'hash',
    'target',
    'expectedRevision',
    'author',
    'action',
    'attempt',
    'source',
  ]);
  requireContract(command.schemaVersion === 1, 'reader-command-version-unsupported');
  requireContract(
    command.action === 'pause' || command.action === 'resume' || command.action === 'cancel',
    'reader-command-action-invalid',
  );
  requireContract(
    typeof command.hash === 'string' && /^[a-f0-9]{64}$/u.test(command.hash),
    'reader-command-hash-invalid',
  );
  const raw = object(command.target);
  exactFields(raw, [
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
  const target = {
    workflowId: text(raw.workflowId),
    projectId: identifier(raw.projectId),
    taskId: identifier(raw.taskId),
    roleId: identifier(raw.roleId),
    hostId: identifier(raw.hostId),
    workspaceId: identifier(raw.workspaceId),
    owner: identifier(raw.owner),
    generation: integer(raw.generation),
    requirementsRevision: integer(raw.requirementsRevision),
  };
  requireContract(
    target.generation > 0 && target.requirementsRevision > 0,
    'reader-control-revision-invalid',
  );
  return {
    schemaVersion: 1,
    commandId: identifier(command.commandId),
    hash: command.hash,
    target,
    expectedRevision: integer(command.expectedRevision),
    author: identifier(command.author),
    action: command.action,
    attempt: integer(command.attempt),
    source: controlRef(command.source),
  };
}
export function parsePayloadReaderCommand(value: unknown): PayloadReaderCommand {
  const raw = object(value);
  exactFields(raw, [
    'schemaVersion',
    'commandId',
    'hash',
    'target',
    'expectedRevision',
    'author',
    'action',
    'attempt',
    'source',
    'payload',
  ]);
  requireContract(raw.schemaVersion === 2, 'reader-payload-command-version');
  const { payload, ...base } = raw;
  return {
    ...parseReaderCommand({ ...base, schemaVersion: 1 }),
    schemaVersion: 2,
    payload: controlRef(payload),
  };
}
export function parseArchiveCommand(value: unknown): ArchiveCommand {
  const raw = object(value);
  requireContract(raw.schemaVersion === 3 && raw.action === 'archive', 'archive-command-version');
  return {
    ...parsePayloadReaderCommand({ ...raw, schemaVersion: 2, action: 'resume' }),
    schemaVersion: 3,
    action: 'archive',
  };
}
export function readerCommandText(command: AuthorizedReaderCommand): string {
  const { target: t } = command;
  return JSON.stringify([
    command.schemaVersion,
    command.commandId,
    [
      t.workflowId,
      t.projectId,
      t.taskId,
      t.roleId,
      t.hostId,
      t.workspaceId,
      t.owner,
      t.generation,
      t.requirementsRevision,
    ],
    command.expectedRevision,
    command.author,
    command.action,
    command.attempt,
    command.source.sha256,
    command.source.bytes,
    ...(command.schemaVersion !== 1 ? [command.payload.sha256, command.payload.bytes] : []),
  ]);
}
export function checkReaderTarget(
  command: ReaderCommand,
  input: ReaderInput,
  workflowId: string,
): void {
  requireContract(
    JSON.stringify(command.target) === JSON.stringify(readerTarget(input, workflowId)) &&
      command.author === input.preparation.owner,
    'reader-command-target-mismatch',
  );
}
export function nextReaderControl(
  state: ReaderControlState,
  command: ReaderCommand,
): ReaderControlState {
  requireContract(
    command.expectedRevision === state.revision && state.revision < Number.MAX_SAFE_INTEGER,
    'reader-command-stale',
  );
  requireContract(!['cancelled', 'answered'].includes(state.mode), 'reader-control-terminal');
  requireContract(
    command.attempt >= state.attempt &&
      command.attempt - state.attempt <= 1 &&
      (command.action === 'resume' || command.attempt === state.attempt),
    'reader-command-attempt-invalid',
  );
  if (command.action === 'resume')
    requireContract(state.mode === 'paused', 'reader-resume-not-stopped');
  return {
    revision: state.revision + 1,
    attempt: command.attempt,
    mode:
      command.action === 'resume'
        ? 'running'
        : command.action === 'cancel'
          ? 'cancelling'
          : 'pausing',
  };
}
