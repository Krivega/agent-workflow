import { isDeepStrictEqual as same } from 'node:util';
import type { LocalProjectRegistration } from './preparation.js';
import type { StageSupervisedTaskInput, TaskSnapshot } from '../contracts/localTask.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import { object, requireContract } from '../contracts/project.js';
import {
  parseLocalTask,
  stageSupervisedTask,
  taskPrivatePath,
  taskPathAllowed,
} from '../policy/localTask.js';
import { checkRegistration } from '../policy/preparation.js';
import { parseReviewInput, parseReviewRequest } from '../policy/review.js';
import { taskFiles } from '../adapters/project/taskFiles.js';
import { controlRef } from '../policy/readerControl.js';

export function taskAuditSnapshot(
  registration: LocalProjectRegistration,
  value: StageSupervisedTaskInput,
  ref: ArtifactRef,
  evidence: ArtifactRef[],
) {
  const input = parseLocalTask(value),
    files = taskFiles(registration.artifactRoot);
  requireContract(stageSupervisedTask(input), 'task-stage-input');
  checkRegistration(input.admission.preparation, registration);
  const snapshot = object(
    JSON.parse(files.store.read(ref).toString()) as unknown,
  ) as unknown as TaskSnapshot;
  requireContract(
    snapshot.schemaVersion === 3 &&
      same(snapshot.input, input) &&
      same(snapshot.source, files.binding(registration.workspaceRoot)),
    'task-stage-snapshot-binding',
  );
  for (const item of evidence) files.store.read(item);
  return { files, snapshot };
}
export function taskAuditMaterials(
  registration: LocalProjectRegistration,
  files: ReturnType<typeof taskFiles>,
  snapshot: Extract<TaskSnapshot, { schemaVersion: 3 }>,
  ref: ArtifactRef,
  evidence: ArtifactRef[],
) {
  requireContract(snapshot.supervision !== undefined, 'task-stage-supervision-required');
  const paths = [...new Set([...snapshot.tree.files.map((f) => f.path), ...snapshot.plan.paths])];
  requireContract(
    paths.every((path) => !taskPrivatePath(path)),
    'task-stage-private-source',
  );
  const observed = files.capture(registration.workspaceRoot, paths);
  const sources = observed.files
    .filter((f) => !taskPathAllowed(snapshot.plan.paths, f.path))
    .map((f) => ({ path: f.path, ...f.version.content }));
  const goal = sources.find(
    (s) =>
      s.path === snapshot.plan.requirement.locator && s.sha256 === snapshot.plan.requirement.hash,
  );
  requireContract(goal !== undefined, 'task-stage-goal-changed');
  const sourceSnapshot = files.save({
    kind: 'task-stage-source-snapshot',
    files: observed.files,
  });
  const planning = object(
    JSON.parse(files.store.read(snapshot.planning.accepted).toString()) as unknown,
  );
  const review = parseReviewInput(planning.input);
  const request = parseReviewRequest(
    JSON.parse(files.store.read(review.request).toString()) as unknown,
    review,
  );
  requireContract(request.schemaVersion !== 1, 'task-stage-planning-evidence');
  requireContract(
    Array.isArray(planning.reports) && planning.reports.length > 0,
    'task-audit-planning-reports',
  );
  const answers = planning.reports.map((row) => controlRef(object(row).answer));
  for (const answer of answers) files.store.read(answer);
  const completed = [
    ...new Map(
      [
        sourceSnapshot,
        ...observed.files.map((f) => f.version.content),
        ...snapshot.tree.files.map((f) => f.version.content),
        ref,
        snapshot.admission,
        snapshot.planning.accepted,
        ...answers,
        snapshot.supervision,
        review.request,
        ...request.evidence,
        snapshot.input.admission.planning,
        snapshot.input.admission.acceptance,
        ...evidence,
      ].map((ref) => [ref.sha256, ref]),
    ).values(),
  ];
  return { goal, sources, completed };
}
