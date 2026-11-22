import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { ArchiveCommand } from '../../src/contracts/readerControl.js';
import type { ArchivePayload, FinalizationInput } from '../../src/contracts/finalization.js';
import type { FinalizationActivities } from '../../src/contracts/finalization.js';
import type { LocalTaskInput } from '../../src/contracts/localTask.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
import { artifactStore, digest } from '../../src/adapters/artifacts/files.js';
import { inspectFileBackup } from '../../src/adapters/artifacts/backup.js';
import { finalizationActivities } from '../../src/activities/finalization.js';
import { makeArchiveCommand } from '../../src/client/finalization.js';
import { finalizationTarget } from '../../src/policy/finalization.js';
import { localTaskFixture } from './localTaskFixture.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';

export function completedArchiveFixture() {
  const f = localTaskFixture();
  const snapshot = f.save({ input: f.input });
  const projection = f.save({ kind: 'isolated-archive-test-projection' });
  const stop = f.save({ confirmed: true });
  const result = f.save({
    kind: 'local-task-result',
    input: f.input,
    complete: true,
    snapshot,
    review: f.proof,
    packet: f.proof,
    writer: { stop },
  });
  const completion = f.save({
    kind: 'task-completion-intent',
    input: f.input,
    result,
    snapshot,
    review: f.proof,
    packet: f.proof,
    projection,
  });
  const done = { status: 'done' as const, result, projection };
  const archive = archiveFixture(f, done);
  const grant = JSON.stringify({
    schemaVersion: 1,
    input: f.input,
    artifactRoot: f.registration.artifactRoot,
    source: taskFiles(f.registration.artifactRoot).binding(f.workspace),
  });
  mkdirSync(archive.taskDirectory, { recursive: true });
  for (const [name, content] of Object.entries({
    'grant.json': grant,
    'permission.json': JSON.stringify({ schemaVersion: 1, active: false, grant: digest(grant) }),
    'done.json': JSON.stringify(done),
    'completion-intent.json': JSON.stringify(completion),
  }))
    writeFileSync(join(archive.taskDirectory, name), content);
  return archive;
}

export function archiveFixture(
  f: Omit<ReturnType<typeof localTaskFixture>, 'input'> & { input: LocalTaskInput },
  done: { status: 'done'; result: ArtifactRef; projection: ArtifactRef },
) {
  const directory = join(f.root, 'finalization'),
    receipts = artifactStore(join(directory, 'artifacts'));
  const save = (value: unknown) => receipts.publish(Buffer.from(JSON.stringify(value)));
  const backup = {
    schemaVersion: 2 as const,
    roots: { artifacts: f.registration.artifactRoot },
    destination: join(f.root, 'archive'),
  };
  const inspected = inspectFileBackup(backup),
    inventory = save(inspected.inventory);
  expect(inventory).toEqual(inspected.manifest);
  const payload: ArchivePayload = {
    schemaVersion: 1,
    kind: 'task-archive-authorization',
    result: done.result,
    backup,
    inventory,
  };
  const raw: ArchiveCommand = {
    schemaVersion: 3,
    commandId: 'archive-one',
    hash: '0'.repeat(64),
    target: {
      workflowId: 'pending',
      projectId: 'p',
      taskId: 'one',
      roleId: 'finalization',
      hostId: 'mac',
      workspaceId: 'isolated',
      owner: 'user',
      generation: 1,
      requirementsRevision: 1,
    },
    expectedRevision: 0,
    author: f.input.admission.preparation.owner,
    action: 'archive',
    attempt: 0,
    source: save({ kind: 'simulated-human-source', native: false }),
    payload: save(payload),
  };
  const input: FinalizationInput = {
    schemaVersion: 1,
    operation: 'archive',
    preparation: f.input.admission.preparation,
    result: done.result,
    command: raw,
  };
  input.command = makeArchiveCommand({ ...raw, target: finalizationTarget(input) });
  const verify = vi.fn(async (command: ArchiveCommand) => ({
    origin: 'human' as const,
    author: command.author,
    hash: command.hash,
    proof: save({ kind: 'simulated-human-archive-authority', command, native: false }),
  }));
  const authority = { verify };
  const log = vi.fn();
  const environment = new MockActivityEnvironment(
    {},
    { logger: { log, trace: log, debug: log, info: log, warn: log, error: log } },
  );
  const actual = finalizationActivities(f.registration, authority, directory);
  type Archive = FinalizationActivities['archiveFinalizedTask'];
  const activity = {
    ...actual,
    archiveFinalizedTask: (...args: Parameters<typeof actual.archiveFinalizedTask>) =>
      environment.run<Parameters<Archive>, Awaited<ReturnType<Archive>>, Archive>(
        actual.archiveFinalizedTask,
        ...args,
      ),
  };
  const taskDirectory = join(
    f.workspace,
    '.git/agent-workflow/tasks',
    digest(`aw/task/${input.preparation.project.projectId}/one`),
    ...(f.input.schemaVersion === 10
      ? ['planning-attempts', String(f.input.continuation.attempt)]
      : []),
  );
  return {
    ...f,
    done,
    input,
    payload,
    backup,
    directory,
    receipts,
    saveReceipt: save,
    activity,
    environment,
    verify,
    authority,
    taskDirectory,
  };
}
