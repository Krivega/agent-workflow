import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { Context } from '@temporalio/activity';
import type { FinalizationActivities, FinalizationInput } from '../contracts/finalization.js';
import type { ReaderAuthority } from '../contracts/readerControl.js';
import type { LocalProjectRegistration } from './preparation.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { TaskBinding } from '../contracts/taskFiles.js';
import { object, requireContract } from '../contracts/project.js';
import { parseArchivePayload, parseFinalization } from '../policy/finalization.js';
import { parseLocalTask, localTaskKey } from '../policy/localTask.js';
import { checkRegistration } from '../policy/preparation.js';
import { taskBackendGuard } from '../adapters/project/taskBackend.js';
import { captureRegistration } from '../adapters/project/preparation.js';
import { controlRef, readerCommandText } from '../policy/readerControl.js';
import {
  artifactStore,
  digest,
  privateDirectory,
  readPrivateFile,
} from '../adapters/artifacts/files.js';
import { createBackup, inspectFileBackup, verifyBackup } from '../adapters/artifacts/backup.js';
import { effectJournal, lookupEffect } from '../adapters/artifacts/effects.js';
import { taskFiles } from '../adapters/project/taskFiles.js';
import { parseReviewInput } from '../policy/review.js';
import { requireTaskHumanCompletionSeal } from './taskHumanCompletion.js';

export function finalizationActivities(
  registration: LocalProjectRegistration,
  authority: ReaderAuthority,
  directory: string,
): FinalizationActivities {
  const backend = taskBackendGuard(
    registration.workspaceRoot,
    registration.taskBackend === 'required',
  );
  registration = captureRegistration(registration);
  const root = realpathSync(privateDirectory(directory)),
    receipts = artifactStore(join(root, 'artifacts'));
  const source = artifactStore(registration.artifactRoot),
    journal = effectJournal(join(root, 'effects'));
  const read = (ref: ArtifactRef) => object(JSON.parse(source.read(ref).toString()));
  const intent = (input: FinalizationInput) => {
    const p = input.preparation;
    return {
      projectId: p.project.projectId,
      taskId: p.taskId,
      hostId: p.hostId,
      workspaceId: p.project.workspaceId,
      owner: p.owner,
      generation: p.generation,
      operationId: 'archive-' + digest(JSON.stringify([input.result, input.command.commandId])),
      requestHash: digest(JSON.stringify(input)),
    };
  };
  const checkCancellation = () => Context.current().cancellationSignal.throwIfAborted();
  function completed(input: FinalizationInput) {
    checkRegistration(input.preparation, registration);
    backend.require(
      input.preparation.project.projectId,
      input.preparation.taskId,
      'temporal',
      'worker',
      input.preparation.card,
    );
    const result = read(input.result),
      task = parseLocalTask(result.input);
    requireContract(
      result.kind === 'local-task-result' &&
        result.complete === true &&
        same(task.admission.preparation, input.preparation),
      'archive-result-binding',
    );
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: registration.workspaceRoot,
      encoding: 'utf8',
    }).trim();
    const taskDirectory = join(
      resolve(registration.workspaceRoot, common),
      'agent-workflow',
      'tasks',
      digest(localTaskKey(task)),
      ...(task.schemaVersion === 10 || task.schemaVersion === 11 || task.schemaVersion === 12
        ? [
            task.schemaVersion === 10 ? 'planning-attempts' : 'execution-attempts',
            String(task.continuation.attempt),
          ]
        : []),
    );
    const done = object(JSON.parse(readPrivateFile(join(taskDirectory, 'done.json')).toString()));
    const bytes = readPrivateFile(join(taskDirectory, 'grant.json')),
      grant = object(JSON.parse(bytes.toString()));
    const permission = object(
      JSON.parse(readPrivateFile(join(taskDirectory, 'permission.json')).toString()),
    );
    const snapshot = read(controlRef(result.snapshot));
    const completionDirectory =
      snapshot.schemaVersion === 4 && Number(object(snapshot.correction).round) > 0
        ? join(taskDirectory, 'corrections', String(object(snapshot.correction).round))
        : taskDirectory;
    const commit = read(
      controlRef(
        JSON.parse(readPrivateFile(join(completionDirectory, 'completion-intent.json')).toString()),
      ),
    );
    requireContract(
      done.status === 'done' &&
        same(done.result, input.result) &&
        same(done.projection, commit.projection) &&
        commit.kind === 'task-completion-intent' &&
        same(commit.input, task) &&
        same(commit.result, input.result) &&
        same(commit.snapshot, result.snapshot) &&
        same(commit.review, result.review) &&
        same(commit.packet, result.packet) &&
        same(snapshot.input, task) &&
        grant.schemaVersion === 1 &&
        same(grant.input, task) &&
        grant.artifactRoot === registration.artifactRoot &&
        permission.schemaVersion === 1 &&
        permission.active === false &&
        permission.grant === digest(bytes),
      'archive-done-unconfirmed',
    );
    if (task.schemaVersion === 12)
      requireTaskHumanCompletionSeal(registration, task, {
        snapshot: controlRef(result.snapshot),
        packet: parseReviewInput(result.packet),
        review: controlRef(result.review),
        seal: controlRef(result.humanCompletion),
      });
    const binding = grant.source as unknown as TaskBinding;
    requireContract(binding.root === registration.workspaceRoot, 'archive-workspace-changed');
    taskFiles(registration.artifactRoot).bound(binding);
    const stop = read(controlRef(object(result.writer).stop));
    requireContract(stop.confirmed === true, 'archive-writer-stop-unconfirmed');
    return result;
  }
  return {
    async reconcileFinalizedTask(raw) {
      const input = parseFinalization(raw);
      requireContract(
        digest(readerCommandText(input.command)) === input.command.hash,
        'archive-command-hash-invalid',
      );
      completed(input);
      const observed = lookupEffect(join(root, 'effects'), intent(input));
      if (observed.status !== 'completed')
        return { status: 'unknown', reason: 'archive-effect-' + observed.status };
      const record = object(JSON.parse(receipts.read(observed.receipt).toString()));
      const payload = parseArchivePayload(
        JSON.parse(receipts.read(input.command.payload).toString()),
      );
      requireContract(
        record.kind === 'task-archived' &&
          same(record.input, input) &&
          same(record.manifest, payload.inventory) &&
          same(record.payload, input.command.payload) &&
          record.destination === payload.backup.destination &&
          same(payload.result, input.result),
        'archive-receipt-binding',
      );
      receipts.read(controlRef(record.authorization));
      verifyBackup({
        schemaVersion: 1,
        backup: payload.backup.destination,
        manifest: payload.inventory,
      });
      return { status: 'archived', manifest: payload.inventory, receipt: observed.receipt };
    },
    async archiveFinalizedTask(raw) {
      checkCancellation();
      const input = parseFinalization(raw),
        command = input.command;
      requireContract(
        digest(readerCommandText(command)) === command.hash,
        'archive-command-hash-invalid',
      );
      completed(input);
      const payload = parseArchivePayload(JSON.parse(receipts.read(command.payload).toString()));
      requireContract(
        same(payload.result, input.result) &&
          payload.backup.roots.artifacts === registration.artifactRoot,
        'archive-payload-binding',
      );
      requireContract(
        Object.values(payload.backup.roots).every((path) => {
          const source = resolve(path);
          return (
            root !== source && !root.startsWith(source + sep) && !source.startsWith(root + sep)
          );
        }),
        'archive-receipts-overlap',
      );
      const inventory: unknown = JSON.parse(receipts.read(payload.inventory).toString());
      const authorization = await authority.verify(command);
      checkCancellation();
      requireContract(
        authorization.origin === 'human' &&
          authorization.author === command.author &&
          authorization.hash === command.hash,
        'archive-human-authorization-required',
      );
      receipts.read(authorization.proof);
      const outcome = () => {
        verifyBackup({
          schemaVersion: 1,
          backup: payload.backup.destination,
          manifest: payload.inventory,
        });
        return receipts.publish(
          Buffer.from(
            JSON.stringify({
              kind: 'task-archived',
              input,
              authorization: authorization.proof,
              payload: command.payload,
              manifest: payload.inventory,
              destination: payload.backup.destination,
              scope: 'files-only',
              cleanup: false,
            }),
          ),
        );
      };
      checkCancellation();
      const receipt = await journal.execute(
        intent(input),
        async () => {
          checkCancellation();
          const observed = inspectFileBackup(payload.backup);
          requireContract(
            same(observed.manifest, payload.inventory) && same(observed.inventory, inventory),
            'archive-inventory-changed',
          );
          requireContract(!existsSync(payload.backup.destination), 'archive-destination-exists');
          completed(input);
          checkCancellation();
          const saved = createBackup(payload.backup, payload.inventory);
          requireContract(same(saved.manifest, payload.inventory), 'archive-manifest-changed');
          return outcome();
        },
        async () => (existsSync(payload.backup.destination) ? outcome() : null),
      );
      const record = object(JSON.parse(receipts.read(receipt).toString()));
      requireContract(
        record.kind === 'task-archived' &&
          same(record.input, input) &&
          same(record.manifest, payload.inventory),
        'archive-receipt-binding',
      );
      verifyBackup({
        schemaVersion: 1,
        backup: payload.backup.destination,
        manifest: payload.inventory,
      });
      return { status: 'archived', manifest: payload.inventory, receipt };
    },
  };
}
