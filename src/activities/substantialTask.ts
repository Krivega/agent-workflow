import { supervisedTask } from '../policy/localTask.js';
import { parseTaskProgressEvidence } from '../policy/progressAudit.js';
import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { HumanManagedTaskInput, LocalTaskInput, TaskTree } from '../contracts/localTask.js';
import type { ReviewInput, ReviewRequest } from '../contracts/review.js';
import type { LocalProjectRegistration } from './preparation.js';
import type { CodexRpc } from './reader.js';
import {
  preparationActivities,
  checkRegisteredCommands,
  preparationInputs,
} from './preparation.js';
import { reviewActivities } from './review.js';
import { confirmTaskPlanning } from './taskPlanning.js';
import { parseSubstantialPlan } from '../policy/substantialTask.js';
import { parseReviewRequest } from '../policy/review.js';
import { checkRegistration } from '../policy/preparation.js';
import {
  taskPathAllowed,
  taskPrivatePath,
  checkCorrectionRoles,
  correctingTask,
} from '../policy/localTask.js';
import { object, requireContract } from '../contracts/project.js';
import { controlRef } from '../policy/readerControl.js';
import { digest, readProjectFile } from '../adapters/artifacts/files.js';
import { resolveRegisteredCommands } from '../adapters/project/preparation.js';
import { taskFiles } from '../adapters/project/taskFiles.js';

type Input =
  | Extract<LocalTaskInput, { schemaVersion: 3 | 6 | 7 | 8 | 9 | 10 | 11 | 12 }>
  | (Extract<LocalTaskInput, { schemaVersion: 4 | 5 }> & {
      admission: Extract<
        LocalTaskInput,
        { schemaVersion: 3 | 6 | 7 | 8 | 9 | 10 | 11 | 12 }
      >['admission'];
    });
function checkSubstantialPlan(registration: LocalProjectRegistration, input: Input) {
  const bytes = readProjectFile(registration.workspaceRoot, input.admission.plan.path);
  requireContract(digest(bytes) === input.admission.plan.sha256, 'substantial-plan-changed');
  const plan = parseSubstantialPlan(JSON.parse(bytes.toString()) as unknown);
  const sources = [plan.requirement, ...plan.basis, plan.owner, ...plan.consumers];
  for (const source of sources)
    requireContract(
      !taskPrivatePath(source.locator) &&
        digest(readProjectFile(registration.workspaceRoot, source.locator)) === source.hash,
      'substantial-source-changed',
    );
  const p = input.admission.preparation;
  const fixed = [
    input.admission.plan.path,
    plan.requirement.locator,
    ...plan.basis.map((s) => s.locator),
    input.executor.path,
    p.card,
    ...p.project.rules,
    ...p.project.roles.map((r) => r.profile),
  ];
  requireContract(
    fixed.every((path) => !taskPathAllowed(plan.paths, path)) &&
      plan.paths.every((path) => !taskPrivatePath(path)),
    'substantial-protected-scope',
  );
  requireContract(
    digest(readProjectFile(registration.workspaceRoot, input.executor.path)) ===
      input.executor.sha256,
    'task-executor-profile-changed',
  );
  requireContract(
    p.project.checks.every((c) => plan.checks.includes(c)),
    'substantial-checks-incomplete',
  );
  checkRegisteredCommands(registration, [input.baseline, ...plan.checks]);
  return { plan, sources, fixed };
}

function checkSubstantialReviews(
  registration: LocalProjectRegistration,
  input: Input,
  { plan, sources, fixed }: ReturnType<typeof checkSubstantialPlan>,
  files: Pick<ReturnType<typeof taskFiles>, 'store' | 'version' | 'capture'>,
) {
  const p = input.admission.preparation,
    { store } = files;
  const review = (request: ArtifactRef, id: string): ReviewInput => ({
    schemaVersion: 1,
    preparation: p,
    request,
    reviewId: id,
  });
  const planning = review(
    input.admission.planning,
    'planning-' +
      input.admission.plan.sha256.slice(0, 32) +
      (input.schemaVersion === 10 || input.schemaVersion === 11 || input.schemaVersion === 12
        ? '-c' + input.continuation.attempt
        : ''),
  );
  const request = parseReviewRequest(
    JSON.parse(store.read(planning.request).toString()) as unknown,
    planning,
  );
  const acceptance = parseReviewRequest(
    JSON.parse(store.read(input.admission.acceptance).toString()) as unknown,
    review(input.admission.acceptance, 'substantial-admission'),
  );
  for (const [phase, r] of [
    ['planning', request],
    ['acceptance', acceptance],
  ] as const) {
    if (supervisedTask(input))
      requireContract(
        r.roles.some((row) => row.roleId === 'auditor' && row.applies === false),
        'task-auditor-cannot-accept',
      );
    requireContract(
      r.phase === phase &&
        r.scope === plan.plan_id &&
        r.roles.some((row) => row.applies === true) &&
        r.roles.every((row) => row.applies !== null && row.complete && row.history.complete),
      'substantial-review-incomplete',
    );
    if (r.schemaVersion !== 1) for (const ref of r.evidence) store.read(ref);
  }
  if (correctingTask(input)) checkCorrectionRoles(input, acceptance.roles);
  const acceptancePaths = [
    ...new Set([
      ...acceptance.sharedPaths,
      ...acceptance.roles.filter((r) => r.applies === true).flatMap((r) => r.paths),
    ]),
  ];
  const acceptanceFiles = acceptancePaths.flatMap((path) => {
    requireContract(!taskPrivatePath(path), 'task-private-input');
    const version = files.version(registration.workspaceRoot, path);
    requireContract(
      version !== null || plan.paths.includes(path),
      'substantial-acceptance-input-missing',
    );
    return version === null ? [] : [{ path, ...version.content }];
  });
  const targets = plan.paths.map((path) => ({
    path,
    version: files.version(registration.workspaceRoot, path),
  }));
  const required = [
    ...new Set([
      input.admission.plan.path,
      ...sources.map((s) => s.locator),
      ...targets.filter((t) => t.version !== null).map((t) => t.path),
    ]),
  ];
  requireContract(
    request.roles
      .filter((r) => r.applies === true)
      .every((r) => [...request.sharedPaths, ...r.paths].includes(input.admission.plan.path)) &&
      required.every(
        (path) =>
          [p.card, ...p.project.rules].includes(path) ||
          request.sharedPaths.includes(path) ||
          request.roles.some((r) => r.applies === true && r.paths.includes(path)),
      ),
    'substantial-planning-inputs-incomplete',
  );
  if (request.schemaVersion !== 1)
    for (const expected of request.expectedFiles) {
      const current = files.version(registration.workspaceRoot, expected.path);
      requireContract(
        current !== null &&
          same(current.content, { sha256: expected.sha256, bytes: expected.bytes }),
        'substantial-planning-input-changed',
      );
    }
  const paths = [...new Set([...required, ...fixed, ...plan.paths, ...acceptancePaths])];
  const tree = files.capture(registration.workspaceRoot, paths);
  return { planning, request, acceptance, required, paths, targets, tree, acceptanceFiles };
}

function reviewPaths(request: ReviewRequest) {
  return [
    ...request.sharedPaths,
    ...request.roles
      .filter((role) => role.applies === true || role.history.answers.length > 0)
      .flatMap((role) => role.paths),
  ];
}

/** Checks the initial Workflow inputs without retaining files or starting a review. */
export function checkSubstantialStartInputs(
  registration: LocalProjectRegistration,
  input: HumanManagedTaskInput,
): void {
  const preparation = input.admission.preparation;
  checkRegistration(preparation, registration);
  preparationInputs(registration.workspaceRoot, preparation);
  const files = taskFiles(registration.artifactRoot, { existingOnly: true });
  const inspected = checkSubstantialPlan(registration, input);
  resolveRegisteredCommands(registration, [input.baseline, ...inspected.plan.checks]);
  const { request, acceptance, tree } = checkSubstantialReviews(registration, input, inspected, {
    store: files.store,
    version: files.observeVersion,
    capture: files.observeCapture,
  });
  requireContract(
    request.schemaVersion !== 4 && acceptance.schemaVersion !== 4,
    'substantial-start-review-schema',
  );
  for (const review of [request, acceptance])
    for (const role of review.roles) for (const ref of role.history.answers) files.store.read(ref);

  const present = new Map(tree.files.map(({ path, version }) => [path, version.content]));
  requireContract(
    reviewPaths(request).every((path) => present.has(path)),
    'substantial-planning-inputs-incomplete',
  );
  const declaredOutput = (path: string) => inspected.plan.paths.includes(path);
  requireContract(
    reviewPaths(acceptance).every((path) => present.has(path) || declaredOutput(path)),
    'substantial-acceptance-input-missing',
  );
  if (acceptance.schemaVersion !== 1)
    for (const { path, sha256, bytes } of acceptance.expectedFiles)
      requireContract(
        declaredOutput(path) || same(present.get(path), { sha256, bytes }),
        'substantial-acceptance-expected-input-changed',
      );
}

export async function preflightSubstantialTask(
  registration: LocalProjectRegistration,
  input: Input,
  rpc: CodexRpc,
  profile: { model: string; effort: string; clientVersion: string },
) {
  const files = taskFiles(registration.artifactRoot),
    store = files.store;
  const prepared = await preparationActivities(registration).prepareProject(
    input.admission.preparation,
  );
  const inspected = checkSubstantialPlan(registration, input),
    { plan } = inspected;
  const progressEvidence: ArtifactRef[] = [];
  if (input.schemaVersion === 9) {
    const goalBytes = readProjectFile(registration.workspaceRoot, plan.requirement.locator);
    const request = parseTaskProgressEvidence(
      JSON.parse(store.read(input.progress.trigger.evidence).toString()) as unknown,
      input,
      { path: plan.requirement.locator, sha256: digest(goalBytes), bytes: goalBytes.length },
    );
    for (const ref of request.evidence) store.read(ref);
    progressEvidence.push(input.progress.trigger.evidence, ...request.evidence);
  }
  const { planning, request, required, paths, targets, tree, acceptanceFiles } =
    checkSubstantialReviews(registration, input, inspected, files);
  const continuationEvidence: ArtifactRef[] = [];
  if (input.schemaVersion === 10 && input.continuation.previous !== null) {
    const transition = object(JSON.parse(store.read(input.continuation.previous).toString()));
    const held = controlRef(transition.held),
      record = object(JSON.parse(store.read(held).toString()));
    continuationEvidence.push(input.continuation.previous, held, controlRef(record.review));
    for (const ref of continuationEvidence) store.read(ref);
  }
  if (
    (input.schemaVersion === 11 || input.schemaVersion === 12) &&
    input.continuation.previous !== null
  ) {
    const transition = object(JSON.parse(store.read(input.continuation.previous).toString()));
    if (input.schemaVersion === 12 && transition.kind === 'task-human-execution-control') {
      const context = object(transition.context),
        technical = object(context.technical);
      requireContract(
        transition.replan === true &&
          same(context.input, transition.input) &&
          Array.isArray(technical.records),
        'task-continuation-binding',
      );
      continuationEvidence.push(
        input.continuation.previous,
        controlRef(technical.snapshot),
        controlRef(technical.acceptance),
        controlRef(technical.stopped),
        ...technical.records.map(controlRef),
      );
    } else {
      const held = controlRef(transition.held),
        record = object(JSON.parse(store.read(held).toString())),
        progress = object(record.progress);
      requireContract(
        transition.kind === 'task-execution-continuation' &&
          record.kind === 'task-execution-held' &&
          Array.isArray(progress.records),
        'task-continuation-binding',
      );
      continuationEvidence.push(
        input.continuation.previous,
        held,
        controlRef(record.stopped),
        ...progress.records.map(controlRef),
      );
    }
    for (const ref of continuationEvidence) store.read(ref);
  }
  const evidence = files.save({ kind: 'substantial-proposal', input, plan, targets });
  const checkedRequest = {
    ...request,
    schemaVersion: input.schemaVersion === 6 ? (6 as const) : (3 as const),
    evidence: [
      ...(request.schemaVersion !== 1 ? request.evidence : []),
      ...progressEvidence,
      ...continuationEvidence,
      evidence,
    ],
    expectedFiles: tree.files.map((f) => ({ path: f.path, ...f.version.content })),
  };
  planning.request = files.save(checkedRequest);
  const selection = await reviewActivities(registration, rpc, profile).prepareReviewPlan(planning);
  requireContract(
    selection.decisions.every((r) => r.action !== 'blocked'),
    'substantial-review-incomplete',
  );
  requireContract(
    same(files.capture(registration.workspaceRoot, paths), tree),
    'substantial-preflight-input-changed',
  );
  return {
    manifest: files.save({
      kind: 'substantial-preflight',
      input,
      prepared,
      plan,
      planning,
      required,
      paths,
      tree,
      acceptanceFiles,
    }),
    planning,
  };
}
export async function admitSubstantialTask(
  registration: LocalProjectRegistration,
  input: Input,
  preflight: ArtifactRef,
  accepted: ArtifactRef,
  rpc: CodexRpc,
  profile: { model: string; effort: string; clientVersion: string },
) {
  const files = taskFiles(registration.artifactRoot);
  const before = object(JSON.parse(files.store.read(preflight).toString()) as unknown);
  requireContract(
    before.kind === 'substantial-preflight' && same(before.input, input),
    'substantial-preflight-binding',
  );
  const plan = parseSubstantialPlan(before.plan),
    tree = before.tree as TaskTree,
    paths = before.paths as string[];
  requireContract(
    same(files.capture(registration.workspaceRoot, paths), tree),
    'substantial-preflight-input-changed',
  );
  const planning = await confirmTaskPlanning(
    registration,
    {
      accepted,
      preparation: input.admission.preparation,
      plan: input.admission.plan,
      scope: plan.plan_id,
      paths: before.required as string[],
      prefix: 'substantial',
    },
    rpc,
    profile,
  );
  const outcome = object(JSON.parse(files.store.read(accepted).toString()) as unknown);
  requireContract(same(outcome.input, before.planning), 'substantial-planning-target-changed');
  requireContract(
    same(files.capture(registration.workspaceRoot, paths), tree),
    'substantial-preflight-input-changed',
  );
  return {
    manifest: files.save({
      kind: 'substantial-admission',
      input,
      preflight,
      prepared: before.prepared,
      plan,
      planning,
      acceptanceFiles: before.acceptanceFiles,
    }),
    plan,
    planning,
    tree,
  };
}
