import type { ArchivePayload, FinalizationInput } from '../contracts/finalization.js';
import type { ReaderTarget } from '../contracts/readerControl.js';
import { exactFields, object, requireContract, text } from '../contracts/project.js';
import { controlRef, parseArchiveCommand } from './readerControl.js';
import { parsePreparation } from './preparation.js';

export function finalizationKey(
  input: Pick<FinalizationInput, 'preparation' | 'result' | 'command'>,
): string {
  const p = input.preparation;
  return `aw/finalization/${p.project.projectId}/${p.taskId}/${input.result.sha256}/${input.command.commandId}`;
}
export function finalizationTarget(
  input: Pick<FinalizationInput, 'preparation' | 'result' | 'command'>,
): ReaderTarget {
  const p = input.preparation;
  return {
    workflowId: finalizationKey(input),
    projectId: p.project.projectId,
    taskId: p.taskId,
    roleId: 'finalization',
    hostId: p.hostId,
    workspaceId: p.project.workspaceId,
    owner: p.owner,
    generation: p.generation,
    requirementsRevision: p.revision,
  };
}
export function parseFinalization(value: unknown): FinalizationInput {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'operation', 'preparation', 'result', 'command']);
  requireContract(v.schemaVersion === 1 && v.operation === 'archive', 'finalization-operation');
  const input: FinalizationInput = {
    schemaVersion: 1,
    operation: 'archive',
    preparation: parsePreparation(v.preparation),
    result: controlRef(v.result),
    command: parseArchiveCommand(v.command),
  };
  requireContract(
    JSON.stringify(input.command.target) === JSON.stringify(finalizationTarget(input)) &&
      input.command.author === input.preparation.owner &&
      input.command.expectedRevision === 0 &&
      input.command.attempt === 0,
    'archive-command-target',
  );
  return input;
}
export function parseArchivePayload(value: unknown): ArchivePayload {
  const v = object(value);
  exactFields(v, ['schemaVersion', 'kind', 'result', 'backup', 'inventory']);
  requireContract(
    v.schemaVersion === 1 && v.kind === 'task-archive-authorization',
    'archive-payload-kind',
  );
  const b = object(v.backup);
  exactFields(b, ['schemaVersion', 'roots', 'destination']);
  requireContract(b.schemaVersion === 2, 'archive-backup-version');
  const raw = object(b.roots),
    roots: ArchivePayload['backup']['roots'] = {};
  requireContract(Object.keys(raw).length > 0, 'archive-roots-required');
  for (const [name, path] of Object.entries(raw)) {
    requireContract(
      ['artifacts', 'receipts', 'workspaces', 'build', 'projections', 'legacy'].includes(name),
      'archive-root-invalid',
    );
    roots[name as keyof typeof roots] = text(path);
  }
  return {
    schemaVersion: 1,
    kind: 'task-archive-authorization',
    result: controlRef(v.result),
    backup: { schemaVersion: 2, roots, destination: text(b.destination) },
    inventory: controlRef(v.inventory),
  };
}
