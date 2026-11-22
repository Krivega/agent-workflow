import type { PreparationInput } from '../contracts/preparation.js';
import {
  exactFields,
  identifier,
  object,
  parseProject,
  relativePath,
  requireContract,
} from '../contracts/project.js';

export function parsePreparation(value: unknown): PreparationInput {
  const input = object(value);
  exactFields(input, [
    'schemaVersion',
    'taskId',
    'project',
    'hostId',
    'owner',
    'generation',
    'revision',
    'card',
  ]);
  requireContract(input.schemaVersion === 1, 'unsupported-preparation-schema');
  requireContract(
    Number.isSafeInteger(input.generation) && Number(input.generation) > 0,
    'invalid-generation',
  );
  requireContract(
    Number.isSafeInteger(input.revision) && Number(input.revision) > 0,
    'invalid-revision',
  );
  const project = parseProject(input.project);
  const card = relativePath(input.card);
  requireContract(card.startsWith(`${project.cardRoot}/`), 'card-outside-root');
  return {
    schemaVersion: 1,
    taskId: identifier(input.taskId),
    project,
    hostId: identifier(input.hostId),
    owner: identifier(input.owner),
    generation: Number(input.generation),
    revision: Number(input.revision),
    card,
  };
}

export function checkRegistration(
  input: PreparationInput,
  registration: { project: unknown; hostId: string; owner: string; generation: number },
): void {
  requireContract(
    JSON.stringify(input.project) === JSON.stringify(parseProject(registration.project)),
    'project-registration-mismatch',
  );
  requireContract(
    input.hostId === registration.hostId &&
      input.owner === registration.owner &&
      input.generation === registration.generation,
    'preparation-grant-mismatch',
  );
}
