import { lstatSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef, PreparationInput } from '../../contracts/preparation.js';
import type { TaskHumanCriterion, TaskHumanManifest } from '../../contracts/taskHuman.js';
import type {
  TaskStartAdmission,
  TaskStartAssignment,
  TaskStartDeclaration,
  TaskStartPrincipalAuthority,
  TaskStartRegistration,
  VerifiedStartAdmission,
} from '../../contracts/taskStartAdmission.js';
import { parseProject, requireContract } from '../../contracts/project.js';
import { checkRegistration, parsePreparation } from '../../policy/preparation.js';
import { controlRef } from '../../policy/readerControl.js';
import {
  parseTaskStartAdmission,
  parseTaskStartCriteria,
  parseTaskStartPrincipal,
  taskStartTarget,
} from '../../policy/taskStartAdmission.js';
import { taskHumanCanonical } from '../../policy/taskHuman.js';
import { artifactStore, digest, readProjectFile } from '../artifacts/files.js';
import { cardCriteria } from './cardCriteria.js';

function scope(registration: TaskStartRegistration, value: PreparationInput) {
  const input = parsePreparation(value);
  checkRegistration(input, registration);
  const workspace = realpathSync(registration.workspaceRoot),
    artifacts = realpathSync(registration.artifactRoot);
  requireContract(
    workspace === registration.workspaceRoot && artifacts === registration.artifactRoot,
    'task-start-root-alias',
  );
  const identity = lstatSync(workspace, { bigint: true });
  const store = artifactStore(artifacts, { existingOnly: true });
  function assert() {
    checkRegistration(input, registration);
    const now = lstatSync(workspace, { bigint: true });
    requireContract(
      registration.artifactRoot === artifacts &&
        realpathSync(registration.workspaceRoot) === workspace &&
        now.dev === identity.dev &&
        now.ino === identity.ino,
      'task-start-workspace-changed',
    );
  }
  function current() {
    assert();
    return readProjectFile(workspace, input.card);
  }
  return { input, store, current, assert };
}
function criteriaFromCard(
  content: string,
  declaration: Pick<TaskStartDeclaration, 'human' | 'inapplicable'>,
): TaskHumanCriterion[] {
  const criteria = cardCriteria(content);
  requireContract(
    new Set(declaration.human).size === declaration.human.length &&
      declaration.human.every((criterion) => criteria.includes(criterion)) &&
      !declaration.human.includes('validate'),
    'task-start-human-criterion',
  );
  const omitted = new Map(declaration.inapplicable.map((row) => [row.criterion, row.reason]));
  requireContract(
    omitted.size === declaration.inapplicable.length &&
      declaration.inapplicable.every(
        (row) =>
          criteria.includes(row.criterion) &&
          typeof row.reason === 'string' &&
          row.reason.length > 0,
      ),
    'task-start-inapplicable-criterion',
  );
  return criteria.map((text) => ({
    id: declaration.human.includes(text) ? text : (/^([a-zA-Z0-9_-]+): /u.exec(text)?.[1] ?? text),
    text,
    kind: declaration.human.includes(text) ? 'human' : 'check',
    applicable: !omitted.has(text),
    reason: omitted.get(text) ?? text,
  }));
}
function cardText(bytes: Buffer) {
  const text = bytes.toString();
  requireContract(Buffer.from(text).equals(bytes), 'task-start-card-encoding');
  return text;
}
function manifest(admission: TaskStartAdmission, ref: ArtifactRef): TaskHumanManifest {
  return {
    schemaVersion: 1,
    kind: 'task-human-gate-manifest',
    target: admission.target,
    card: admission.card,
    requirements: admission.requirements,
    declaration: ref,
    criteria: admission.criteria,
  };
}
function readDeclaration(store: ReturnType<typeof artifactStore>, ref: ArtifactRef) {
  const bytes = store.read(ref),
    admission = parseTaskStartAdmission(JSON.parse(bytes.toString()));
  requireContract(bytes.equals(Buffer.from(JSON.stringify(admission))), 'task-start-noncanonical');
  const card = store.read({ sha256: admission.card.sha256, bytes: admission.card.bytes });
  requireContract(card.equals(store.read(admission.requirements)), 'task-start-requirements');
  const derived = criteriaFromCard(cardText(card), {
    human: admission.criteria.filter((row) => row.kind === 'human').map((row) => row.text),
    inapplicable: admission.criteria
      .filter((row) => !row.applicable)
      .map((row) => ({ criterion: row.text, reason: row.reason })),
  });
  requireContract(same(admission.criteria, derived), 'task-start-incomplete-criteria');
  return admission;
}
async function verifyChain(
  store: ReturnType<typeof artifactStore>,
  authority: Pick<TaskStartPrincipalAuthority, 'verify'>,
  owner: string,
  ref: ArtifactRef,
  admission: TaskStartAdmission,
) {
  let initial = { ref, admission };
  while (true) {
    const value = initial.admission;
    requireContract(value.principal.owner === owner, 'task-start-principal-owner');
    await authority.verify(value.principal);
    if (value.previous === null) return initial;
    const prior = readDeclaration(store, value.previous);
    requireContract(
      same(
        { ...value.target, requirementsRevision: prior.target.requirementsRevision },
        prior.target,
      ) &&
        prior.target.requirementsRevision === value.target.requirementsRevision - 1 &&
        value.card.path === prior.card.path,
      'task-start-revision-chain',
    );
    initial = { ref: value.previous, admission: prior };
  }
}
export async function checkTaskStartAdmission(
  registration: TaskStartRegistration,
  authority: Pick<TaskStartPrincipalAuthority, 'verify'>,
  ref: ArtifactRef,
  preparation: PreparationInput,
  assignment?: TaskStartAssignment,
  options: { card: 'current' | 'retained' } = { card: 'current' },
): Promise<VerifiedStartAdmission> {
  requireContract(authority !== undefined, 'task-start-principal-required');
  requireContract(
    options.card === 'current' || options.card === 'retained',
    'task-start-read-mode',
  );
  const { input, store, current, assert } = scope(registration, preparation);
  const admission = readDeclaration(store, ref);
  requireContract(
    same(admission.target, taskStartTarget(input)) && admission.card.path === input.card,
    'task-start-binding',
  );
  const initial = await verifyChain(store, authority, registration.owner, ref, admission);
  if (assignment !== undefined)
    requireContract(
      assignment.projectId === input.project.projectId &&
        assignment.taskId === input.taskId &&
        assignment.cardName === basename(input.card) &&
        assignment.origin === initial.admission.card.sha256 &&
        same(assignment.startAdmission, initial.ref),
      'task-start-assignment',
    );
  assert();
  if (options.card === 'current') {
    const bytes = current();
    requireContract(
      digest(bytes) === admission.card.sha256 && bytes.length === admission.card.bytes,
      'task-start-card-changed',
    );
  }
  const value = manifest(admission, ref),
    encoded = Buffer.from(taskHumanCanonical(value)),
    manifestRef = { sha256: digest(encoded), bytes: encoded.length };
  requireContract(store.read(manifestRef).equals(encoded), 'task-start-manifest');
  return { ref, admission, initial, manifest: { manifest: value, ref: manifestRef } };
}

export async function prepareTaskStartAdmission(
  registration: TaskStartRegistration,
  authority: TaskStartPrincipalAuthority,
  declaration: TaskStartDeclaration,
): Promise<VerifiedStartAdmission> {
  requireContract(authority !== undefined, 'task-start-principal-required');
  parseProject(registration.project);
  const { input, store, current } = scope(registration, declaration.preparation);
  const bytes = current(),
    card = { sha256: digest(bytes), bytes: bytes.length },
    target = taskStartTarget(input),
    criteria = parseTaskStartCriteria(criteriaFromCard(cardText(bytes), declaration)),
    previous = declaration.previous === null ? null : controlRef(declaration.previous);
  if (previous !== null) {
    const prior = readDeclaration(store, previous);
    requireContract(
      same({ ...target, requirementsRevision: prior.target.requirementsRevision }, prior.target) &&
        prior.target.requirementsRevision === target.requirementsRevision - 1 &&
        input.card === prior.card.path,
      'task-start-revision-chain',
    );
    await verifyChain(store, authority, registration.owner, previous, prior);
    requireContract(current().equals(bytes), 'task-start-card-changed');
  }
  const principal = parseTaskStartPrincipal(await authority.issue());
  requireContract(principal.owner === registration.owner, 'task-start-principal-owner');
  const value = parseTaskStartAdmission({
    schemaVersion: 1,
    kind: 'task-start-admission',
    previous,
    target,
    card: { path: input.card, ...card },
    requirements: card,
    principal,
    criteria,
  });
  requireContract(
    same(parseTaskStartPrincipal(await authority.issue()), principal),
    'task-start-principal-changed',
  );
  requireContract(current().equals(bytes), 'task-start-card-changed');
  store.publish(bytes);
  const ref = store.publish(Buffer.from(JSON.stringify(value)));
  store.publish(Buffer.from(taskHumanCanonical(manifest(value, ref))));
  return checkTaskStartAdmission(registration, authority, ref, input);
}
