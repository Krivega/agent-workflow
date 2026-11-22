import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { HumanManagedTaskInput, TaskSnapshot } from '../contracts/localTask.js';
import type { ArtifactRef, LocalProjectRegistration } from '../contracts/preparation.js';
import type { ReaderExecution } from '../contracts/readerControl.js';
import type { ReviewInput } from '../contracts/review.js';
import type { TaskHumanState, TaskHumanTechnicalCompletion } from '../contracts/taskHuman.js';
import type { WriterProcesses } from '../contracts/writerProcesses.js';
import { exactFields, object, requireContract } from '../contracts/project.js';
import { textField } from '../contracts/localValues.js';
import { checkRegistration } from '../policy/preparation.js';
import { localTaskKey, parseLocalTask } from '../policy/localTask.js';
import { controlRef } from '../policy/readerControl.js';
import { parseReviewInput } from '../policy/review.js';
import { parseBoundTaskHumanManifest, taskHumanBlockers } from '../policy/taskHuman.js';
import { taskControlTarget } from '../policy/taskContinuation.js';
import { artifactStore, digest, readPrivateFile } from '../adapters/artifacts/files.js';
import { taskBackendHome } from '../adapters/project/taskBackend.js';
import { taskGateBinding } from '../adapters/project/taskGate.js';
import { taskFiles } from '../adapters/project/taskFiles.js';
import { inspectStoppedTask } from '../adapters/project/stoppedTask.js';

function humanInput(value: unknown): HumanManagedTaskInput {
  const input = parseLocalTask(value);
  requireContract(input.schemaVersion === 12, 'human-completion-input');
  return input;
}
function privateBytes(path: string) {
  const info = lstatSync(path);
  requireContract(
    realpathSync(path) === path &&
      info.isFile() &&
      info.nlink === 1 &&
      info.uid === process.getuid?.() &&
      (info.mode & 0o077) === 0,
    'human-completion-private-file',
  );
  return readPrivateFile(path);
}
function taskDirectory(registration: LocalProjectRegistration, input: HumanManagedTaskInput) {
  return join(
    taskBackendHome(registration.workspaceRoot),
    'tasks',
    digest(localTaskKey(input)),
    'execution-attempts',
    String(input.continuation.attempt),
  );
}

/** Read-only retained technical proof. Process/inventory rechecks must run outside permission-lock. */
export async function inspectTaskHumanTechnical(
  registration: LocalProjectRegistration,
  profile: ReaderExecution['profile'],
  disabledServers: readonly string[],
  processes: WriterProcesses,
  technical: TaskHumanTechnicalCompletion,
) {
  technical = structuredClone(technical);
  const input = humanInput(technical.input);
  checkRegistration(input.admission.preparation, registration);
  const files = taskFiles(registration.artifactRoot, { existingOnly: true }),
    store = files.store,
    source = files.binding(registration.workspaceRoot),
    artifacts = files.binding(registration.artifactRoot),
    directory = taskGateBinding(
      input,
      source,
      profile,
      registration.artifactRoot,
      'read-only-human-inspection',
    ).directory,
    stamp = (name: string) => {
      const path = join(directory, name);
      return { path, bytes: privateBytes(path) };
    },
    stamps = ['grant.json', 'snapshot.json', 'stopped.json', 'acceptance.json'].map(stamp),
    read = (ref: ArtifactRef) =>
      object(JSON.parse(store.read(controlRef(ref)).toString('utf8')) as unknown),
    grant = object(JSON.parse(stamps[0]!.bytes.toString('utf8')) as unknown),
    snapshot = read(technical.snapshot) as unknown as TaskSnapshot,
    accepted = object(JSON.parse(stamps[3]!.bytes.toString('utf8')) as unknown),
    packet = parseReviewInput(technical.packet),
    review = read(technical.acceptance),
    stopped = read(technical.stopped);
  stamps.push(
    stamp(
      accepted.recheck === undefined
        ? 'checks-integrated.json'
        : 'recheck-' + controlRef(accepted.recheck).sha256 + '.json',
    ),
  );
  exactFields(grant, ['schemaVersion', 'input', 'source', 'profile', 'artifactRoot', 'instance']);
  requireContract(
    grant.schemaVersion === 1 &&
      same(grant.input, input) &&
      same(grant.source, source) &&
      same(grant.profile, profile) &&
      grant.artifactRoot === registration.artifactRoot &&
      typeof grant.instance === 'string' &&
      grant.instance.length > 0,
    'human-technical-grant',
  );
  requireContract(
    snapshot.schemaVersion === 3 &&
      snapshot.kind === 'substantial-task' &&
      same(snapshot.input, input) &&
      same(snapshot.source, source) &&
      same(snapshot.profile, profile) &&
      same(snapshot.disabledServers, [...disabledServers]) &&
      snapshot.copy.root ===
        join(
          registration.artifactRoot,
          'copies',
          digest(localTaskKey(input)) + '-a' + input.continuation.attempt,
        ),
    'human-technical-snapshot',
  );
  requireContract(
    same(
      controlRef(JSON.parse(stamps[1]!.bytes.toString('utf8')) as unknown),
      technical.snapshot,
    ) &&
      same(controlRef(JSON.parse(stamps[2]!.bytes.toString('utf8')) as unknown), technical.stopped),
    'human-technical-private-binding',
  );
  requireContract(
    same(packet.preparation, input.admission.preparation) &&
      same(accepted.review, packet) &&
      review.kind === 'reader-review-result' &&
      review.complete === true &&
      same(review.input, packet),
    'human-technical-acceptance',
  );
  requireContract(
    ['task-stopped', 'task-not-started'].includes(String(stopped.kind)) &&
      stopped.confirmed === true &&
      same(stopped.input, input),
    'human-technical-stop',
  );
  const writer = object(accepted.result),
    finalRef = controlRef(accepted.finalChecks),
    final = read(finalRef),
    finalPointer = object(JSON.parse(stamps[4]!.bytes.toString('utf8')) as unknown);
  requireContract(
    same(controlRef(writer.stop), controlRef(stopped.writer)) &&
      same(controlRef(finalPointer.manifest), finalRef) &&
      final.kind === 'task-checks' &&
      final.status === 'PASS' &&
      final.stage === 'integrated' &&
      same(final.input, input) &&
      same(final.snapshot, technical.snapshot),
    'human-technical-checks',
  );
  store.read(controlRef(snapshot.admission));
  store.read(packet.request);
  for (const ref of technical.records) store.read(controlRef(ref));
  function assertBindings() {
    files.bound(source);
    files.bound(artifacts);
    files.bound(snapshot.copy);
    for (const stamp of stamps)
      requireContract(
        privateBytes(stamp.path).equals(stamp.bytes),
        'human-technical-journal-changed',
      );
    store.read(technical.snapshot);
    store.read(technical.acceptance);
    store.read(technical.stopped);
    for (const command of Object.values(snapshot.commands))
      requireContract(
        digest(readFileSync(command.executable)) === command.sha256,
        'task-check-runtime-changed',
      );
  }
  assertBindings();
  const retained = await inspectStoppedTask({
    input,
    source,
    artifacts,
    directory,
    grant: stamps[0]!.bytes,
    processes,
  });
  assertBindings();
  const inspection = {
    ...retained,
    async recheck() {
      assertBindings();
      await retained.recheck();
      assertBindings();
    },
  };
  return {
    source,
    directory,
    inspection,
    snapshot,
    packet,
    acceptance: technical.acceptance,
    assertBindings,
  };
}

export interface TaskHumanCompletionExpected {
  snapshot?: ArtifactRef;
  packet?: ReviewInput;
  review?: ArtifactRef;
  seal?: ArtifactRef;
  producer?: { namespace: string; taskQueue: string };
}

/** Trusts only the retained private issuance pointer; this does not replay native human history. */
export function requireTaskHumanCompletionSeal(
  registration: LocalProjectRegistration,
  raw: HumanManagedTaskInput,
  expected: TaskHumanCompletionExpected = {},
) {
  const input = humanInput(raw);
  checkRegistration(input.admission.preparation, registration);
  const store = artifactStore(registration.artifactRoot, { existingOnly: true }),
    read = (ref: ArtifactRef) =>
      object(JSON.parse(store.read(controlRef(ref)).toString('utf8')) as unknown),
    directory = taskDirectory(registration, input),
    snapshot = controlRef(
      JSON.parse(privateBytes(join(directory, 'snapshot.json')).toString('utf8')) as unknown,
    ),
    pointer = join(
      taskBackendHome(registration.workspaceRoot),
      'tasks',
      digest(localTaskKey(input)),
      'human-completion',
      snapshot.sha256 + '.json',
    ),
    ref = controlRef(JSON.parse(privateBytes(pointer).toString('utf8')) as unknown),
    seal = read(ref),
    storedSnapshot = read(snapshot);
  requireContract(
    storedSnapshot.schemaVersion === 3 &&
      storedSnapshot.kind === 'substantial-task' &&
      same(storedSnapshot.input, input),
    'human-completion-snapshot',
  );
  exactFields(seal, ['kind', 'request', 'producer']);
  requireContract(seal.kind === 'task-human-completion-seal', 'human-completion-seal-kind');
  const request = object(seal.request),
    technical = object(request.technical),
    producer = object(seal.producer),
    state = object(request.state),
    bound = parseBoundTaskHumanManifest(state.current);
  exactFields(request, [
    'schemaVersion',
    'kind',
    'input',
    'state',
    'technical',
    'expectedRevision',
  ]);
  exactFields(producer, [
    'workflowId',
    'runId',
    'activityId',
    'activityType',
    'taskQueue',
    'namespace',
    'workflowType',
    'isLocal',
  ]);
  requireContract(
    producer.workflowId === localTaskKey(input) &&
      producer.workflowType === 'LocalTaskWorkflow' &&
      producer.isLocal === false &&
      producer.activityType === 'finishTaskHuman',
    'human-completion-producer',
  );
  for (const name of ['runId', 'activityId', 'taskQueue', 'namespace']) textField(producer[name]);
  if (expected.producer !== undefined)
    requireContract(
      producer.namespace === expected.producer.namespace &&
        producer.taskQueue === expected.producer.taskQueue,
      'human-completion-producer-scope',
    );
  requireContract(
    request.schemaVersion === 1 &&
      request.kind === 'task-human-finish' &&
      same(request.input, input) &&
      same(technical.input, input) &&
      same(controlRef(technical.snapshot), snapshot) &&
      request.expectedRevision === state.revision &&
      Number.isSafeInteger(state.revision) &&
      Number(state.revision) >= 0,
    'human-completion-request',
  );
  requireContract(
    state.schemaVersion === 1 &&
      state.closed === true &&
      state.pending === null &&
      Array.isArray(state.history) &&
      Array.isArray(state.decisions) &&
      state.revision === state.history.length &&
      same(bound.manifest.target, taskControlTarget(input)) &&
      same(bound.manifest.declaration, input.startAdmission) &&
      bound.manifest.card.path === input.admission.preparation.card &&
      same(read(bound.ref), bound.manifest),
    'human-completion-state',
  );
  requireContract(
    taskHumanBlockers(state as unknown as TaskHumanState).length === 0,
    'human-completion-gates-open',
  );
  const packet = parseReviewInput(technical.packet),
    review = controlRef(technical.acceptance);
  requireContract(same(packet.preparation, input.admission.preparation), 'human-completion-packet');
  for (const artifact of [snapshot, packet.request, review, controlRef(technical.stopped)])
    store.read(artifact);
  if (expected.snapshot !== undefined)
    requireContract(same(expected.snapshot, snapshot), 'human-completion-snapshot');
  if (expected.packet !== undefined)
    requireContract(same(expected.packet, packet), 'human-completion-packet');
  if (expected.review !== undefined)
    requireContract(same(expected.review, review), 'human-completion-review');
  if (expected.seal !== undefined)
    requireContract(same(expected.seal, ref), 'human-completion-seal');
  const intentPath = join(directory, 'completion-intent.json'),
    donePath = join(directory, 'done.json');
  if (existsSync(intentPath)) {
    const commit = read(
        controlRef(JSON.parse(privateBytes(intentPath).toString('utf8')) as unknown),
      ),
      result = read(controlRef(commit.result));
    requireContract(
      commit.kind === 'task-completion-intent' &&
        same(commit.input, input) &&
        same(commit.snapshot, snapshot) &&
        same(commit.packet, packet) &&
        same(commit.review, review) &&
        same(commit.humanCompletion, ref) &&
        result.kind === 'local-task-result' &&
        result.complete === true &&
        same(result.input, input) &&
        same(result.snapshot, snapshot) &&
        same(result.packet, packet) &&
        same(result.review, review) &&
        same(result.humanCompletion, ref),
      'human-completion-result-binding',
    );
    if (existsSync(donePath)) {
      const done = object(JSON.parse(privateBytes(donePath).toString('utf8')) as unknown);
      requireContract(
        done.status === 'done' &&
          same(done.result, commit.result) &&
          same(done.projection, commit.projection),
        'human-completion-done-binding',
      );
    }
  } else requireContract(!existsSync(donePath), 'human-completion-intent-required');
  return { ref, seal, request, snapshot, packet, review, directory };
}
