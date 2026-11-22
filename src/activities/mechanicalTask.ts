import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../contracts/preparation.js';
import type {
  MechanicalAdmissionInput,
  MechanicalApplication,
} from '../contracts/mechanicalTask.js';
import type { TaskPlan } from '../contracts/localTask.js';
import type { ReviewInput } from '../contracts/review.js';
import type { LocalProjectRegistration } from './preparation.js';
import type { CodexRpc } from './reader.js';
import { preparationActivities, checkRegisteredCommands } from './preparation.js';
import { confirmTaskPlanning } from './taskPlanning.js';
import { parseMechanicalAdmission, parseMechanicalMaterial } from '../policy/mechanicalTask.js';
import { parseReviewRequest } from '../policy/review.js';
import { taskPrivatePath } from '../policy/localTask.js';
import { requireContract, object } from '../contracts/project.js';
import { digest, readProjectFile } from '../adapters/artifacts/files.js';
import { taskFiles } from '../adapters/project/taskFiles.js';

export async function prepareMechanicalTask(
  registration: LocalProjectRegistration,
  raw: MechanicalAdmissionInput,
  rpc: CodexRpc,
  profile: { model: string; effort: string; clientVersion: string },
) {
  const input = parseMechanicalAdmission(raw),
    files = taskFiles(registration.artifactRoot),
    store = files.store;
  const read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  const prepared = await preparationActivities(registration).prepareProject(input.preparation);
  const bytes = readProjectFile(registration.workspaceRoot, input.plan.path);
  requireContract(digest(bytes) === input.plan.sha256, 'mechanical-material-changed');
  const material = parseMechanicalMaterial(JSON.parse(bytes.toString()) as unknown);
  const sources = [
    material.requirement,
    ...material.links,
    ...material.files.flatMap((f) => (f.after === null ? [] : [f.after.source])),
  ];
  for (const source of sources) {
    requireContract(!taskPrivatePath(source.locator), 'mechanical-private-input');
    requireContract(
      digest(readProjectFile(registration.workspaceRoot, source.locator)) === source.hash,
      'mechanical-source-changed',
    );
  }
  const fixed = [
    input.plan.path,
    ...sources.map((s) => s.locator),
    ...input.preparation.project.rules,
    ...input.preparation.project.roles.map((r) => r.profile),
    input.preparation.card,
  ];
  requireContract(
    material.files.every((f) => !taskPrivatePath(f.path) && !fixed.includes(f.path)),
    'mechanical-protected-target',
  );
  requireContract(
    input.preparation.project.checks.every((check) => material.checks.includes(check)),
    'mechanical-checks-incomplete',
  );
  checkRegisteredCommands(registration, material.checks);
  const changes = material.files
    .map((f) => {
      const before = files.version(registration.workspaceRoot, f.path);
      requireContract(same(before, f.before), 'mechanical-before-changed');
      const after =
        f.after === null
          ? null
          : {
              content: store.publish(
                readProjectFile(registration.workspaceRoot, f.after.source.locator),
              ),
              mode: f.after.mode,
            };
      requireContract(!same(before, after), 'mechanical-empty-change');
      return { path: f.path, before, after };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const required = [
    ...new Set([
      input.plan.path,
      ...sources.map((s) => s.locator),
      ...changes.filter((c) => c.before !== null).map((c) => c.path),
    ]),
  ];
  const { sessions } = await confirmTaskPlanning(
    registration,
    {
      accepted: input.accepted,
      preparation: input.preparation,
      plan: input.plan,
      scope: material.materialId,
      paths: required,
      prefix: 'mechanical',
    },
    rpc,
    profile,
  );
  const acceptanceInput: ReviewInput = {
    schemaVersion: 1,
    preparation: input.preparation,
    reviewId: 'mechanical-admission',
    request: input.acceptance,
  };
  const acceptance = parseReviewRequest(read(input.acceptance), acceptanceInput);
  requireContract(
    acceptance.phase === 'acceptance' &&
      acceptance.roles.some((r) => r.applies === true) &&
      acceptance.roles.every((r) => r.applies !== null && r.complete && r.history.complete),
    'mechanical-acceptance-incomplete',
  );
  if (acceptance.schemaVersion !== 1)
    for (const evidence of acceptance.evidence) store.read(evidence);
  const paths = [
    ...new Set([
      ...acceptance.sharedPaths,
      ...acceptance.roles.filter((r) => r.applies === true).flatMap((r) => r.paths),
    ]),
  ];
  const acceptanceFiles = paths.map((path) => {
    const changed = changes.find((c) => c.path === path),
      version =
        changed === undefined ? files.version(registration.workspaceRoot, path) : changed.after;
    requireContract(version !== null, 'mechanical-acceptance-input-missing');
    return { path, ...version.content };
  });
  const plan: TaskPlan = {
    requirement: material.requirement,
    basis: [{ locator: input.plan.path, hash: input.plan.sha256 }, ...sources],
    paths: changes.map((c) => c.path),
    checks: material.checks,
    criterion: material.criterion,
  };
  const mechanical: MechanicalApplication = {
    materialId: material.materialId,
    accepted: input.accepted,
    sessions,
    changes,
  };
  return {
    manifest: files.save({
      schemaVersion: 2,
      kind: 'mechanical-admission',
      input,
      prepared,
      plan,
      mechanical,
      acceptanceFiles,
    }),
    plan,
    mechanical,
    acceptanceFiles,
  };
}
