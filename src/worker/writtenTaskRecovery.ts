import { mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import type { NativeConnection } from '@temporalio/worker';
import {
  digest,
  publishFile,
  readPrivateFile,
  syncDirectory,
} from '../adapters/artifacts/files.js';
import { inspectTaskWriter, interruptedWriterTurn } from '../adapters/codex/taskWriter.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import { taskFiles } from '../adapters/project/taskFiles.js';
import { taskGateBinding } from '../adapters/project/taskGate.js';
import {
  takeTaskRecoveryLock,
  taskPermissionBytes,
} from '../adapters/project/taskPermissionLock.js';
import { controlRef } from '../policy/readerControl.js';
import { localTaskKey, parseLocalTask } from '../policy/localTask.js';
import { taskAdmissionIdentity, taskAdmissionsRelativePath } from '../policy/taskRecovery.js';
import { checkRegistration } from '../policy/preparation.js';
import { object, requireContract, text } from '../contracts/project.js';
import type { TaskSnapshot, WriterResult } from '../contracts/localTask.js';
import type { ReaderProjectHost } from './readerHost.js';
import type { ReaderExecution } from '../contracts/readerControl.js';

export interface WrittenTaskExecution {
  workflowId: string;
  runId: string;
}

// Bind the local result to the SDK Activity that returned it to this run.
export function writtenActivityReceipt(
  root: string,
  instance: string,
  execution: WrittenTaskExecution,
  activityId: string,
) {
  return join(
    root,
    'written-activity-' +
      digest(JSON.stringify([instance, execution.workflowId, execution.runId, activityId])),
  );
}

export function recordWrittenActivity(path: string, result: WriterResult) {
  const bytes = Buffer.from(JSON.stringify(result));
  try {
    publishFile(path, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    requireContract(readPrivateFile(path).equals(bytes), 'written-task-activity-conflict');
  }
}

async function readCompletedWrite(
  connection: NativeConnection,
  queue: string,
  execution: WrittenTaskExecution,
  namespace: string,
) {
  const client = new Client({ connection, namespace });
  const handle = client.workflow.getHandle(execution.workflowId, execution.runId);
  const description = await handle.describe();
  requireContract(
    same(
      [description.runId, description.status.name, description.taskQueue],
      [execution.runId, 'RUNNING', queue],
    ),
    'written-task-execution',
  );
  const { events } = await handle.fetchHistory();
  requireContract(
    events!.every((event) =>
      [
        'workflowExecutionStartedEventAttributes',
        'workflowTaskScheduledEventAttributes',
        'workflowTaskStartedEventAttributes',
        'workflowTaskCompletedEventAttributes',
        'workflowTaskTimedOutEventAttributes',
        'activityTaskScheduledEventAttributes',
        'activityTaskStartedEventAttributes',
        'activityTaskCompletedEventAttributes',
        'activityTaskTimedOutEventAttributes',
      ].some((key) => Object.hasOwn(event, key)),
    ),
    'written-task-history',
  );
  const start = events![0]!.workflowExecutionStartedEventAttributes!;
  const input = parseLocalTask(defaultPayloadConverter.fromPayload(start.input!.payloads![0]!));
  requireContract(
    input.schemaVersion === 1 &&
      localTaskKey(input) === execution.workflowId &&
      start.originalExecutionRunId === execution.runId &&
      start.workflowType!.name === 'LocalTaskWorkflow',
    'written-task-run-binding',
  );
  const scheduled = events!.flatMap((e) => (e.activityTaskScheduledEventAttributes ? [e] : []));
  requireContract(
    same(
      scheduled.map((e) => e.activityTaskScheduledEventAttributes!.activityType!.name),
      ['prepareLocalTask', 'checkLocalTask', 'writeLocalTask'],
    ),
    'written-task-stage',
  );
  const write = scheduled[2]!;
  const completed = events!.flatMap((e) =>
    e.activityTaskCompletedEventAttributes?.scheduledEventId?.equals(write.eventId!)
      ? [e.activityTaskCompletedEventAttributes]
      : [],
  );
  const timeouts = events!.flatMap((e) =>
    e.activityTaskTimedOutEventAttributes ? [e.activityTaskTimedOutEventAttributes] : [],
  );
  if (timeouts.length) {
    requireContract(
      timeouts.length === 1 &&
        completed.length === 0 &&
        timeouts[0]!.scheduledEventId?.equals(write.eventId!) &&
        events!.some(
          (e) =>
            e.eventId?.equals(timeouts[0]!.startedEventId!) &&
            e.activityTaskStartedEventAttributes?.scheduledEventId?.equals(write.eventId!),
        ),
      'written-task-history',
    );
    return { input, write: write.activityTaskScheduledEventAttributes!, result: null };
  }
  requireContract(completed.length === 1, 'written-task-completion-required');
  const result = object(defaultPayloadConverter.fromPayload(completed[0]!.result!.payloads![0]!));
  return { input, write: write.activityTaskScheduledEventAttributes!, result };
}

// The old host has relinquished its Writer but still owns the reservation for integration.
export async function claimWrittenTask(
  connection: NativeConnection,
  queue: string,
  projects: ReaderProjectHost[],
  profile: ReaderExecution['profile'],
  root: string,
  execution: WrittenTaskExecution,
  nextOwner: Buffer,
  namespace: string,
) {
  const lock = takeTaskRecoveryLock(join(root, 'host-recovery-lock'));
  try {
    const ownerPath = join(root, 'host-owner');
    const former = taskPermissionBytes(ownerPath);
    const raw = object(JSON.parse(former.bytes.toString()));
    const host = { pid: Number(raw.pid), id: text(raw.id) };
    requireContract(
      same(raw, { ...host, tasks: true, taskBindings: 3 }) &&
        Number.isSafeInteger(host.pid) &&
        host.pid > 1,
      'written-task-former-owner',
    );
    try {
      process.kill(host.pid, 0);
      throw new Error('reader-host-still-alive');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    const project = projects[0]!;
    requireContract(
      projects.length === 1 && project.localTasks !== undefined && project.auditor !== true,
      'written-task-project',
    );
    const { input, write, result } = await readCompletedWrite(
      connection,
      queue,
      execution,
      namespace,
    );
    checkRegistration(input.admission.preparation, project.registration);
    const { registration } = project;
    const files = taskFiles(registration.artifactRoot, { existingOnly: true });
    const source = files.binding(registration.workspaceRoot);
    const grantFor = (id: string) =>
      taskGateBinding(input, source, profile, registration.artifactRoot, id);
    const read = (path: string) => JSON.parse(readPrivateFile(path).toString()) as unknown;
    const instance = text(object(read(join(grantFor(host.id).directory, 'grant.json'))).instance);
    const binding = grantFor(instance);
    const dir = binding.directory;
    const admission = digest(taskAdmissionIdentity(input));
    const priorAdmissions = join(root, taskAdmissionsRelativePath(host.id, 3));
    const grant = { sha256: digest(binding.grant), bytes: binding.grant.length };
    const sameGrant = host.id === instance;
    const projectId = digest(input.admission.preparation.project.projectId);
    const verifyFiles = () => {
      const current = taskPermissionBytes(ownerPath);
      requireContract(
        current.identity === former.identity && current.bytes.equals(former.bytes),
        'written-task-owner-changed',
      );
      requireContract(
        same(readdirSync(join(root, 'admissions')), []) &&
          same(
            readdirSync(root).filter((n) => /^[a-f0-9]{64}$/u.test(n)),
            [projectId],
          ) &&
          same(readdirSync(join(root, projectId, 'permissions')), []) &&
          same(readdirSync(priorAdmissions), [admission]) &&
          !readdirSync(binding.home).some((name) => name.startsWith('.pending-')),
        'written-task-inventory',
      );
      requireContract(
        same(read(join(priorAdmissions, admission)), {
          schemaVersion: 1,
          host,
          input,
          gate: { directory: dir, grant, mode: sameGrant ? 'owned' : 'retained' },
        }),
        'written-task-admission',
      );
      requireContract(
        readPrivateFile(binding.reservation).equals(binding.grant) &&
          readPrivateFile(join(dir, 'grant.json')).equals(binding.grant) &&
          same(read(join(dir, 'permission.json')), {
            schemaVersion: 1,
            grant: grant.sha256,
            active: true,
          }),
        'written-task-permission',
      );
      const expected = [
        'grant.json',
        'permission.json',
        'snapshot.json',
        'checks-baseline-intent.json',
        'checks-baseline.json',
        'check-logs',
        'task-effects',
        'writer-effects',
        'writer-runtime.json',
        'runtime-identity.json',
        ...(result === null ? [] : ['writer-stopped.json', 'writer-result.json']),
      ];
      requireContract(same(readdirSync(dir).sort(), expected.sort()), 'written-task-unsettled');
    };
    verifyFiles();
    const snapshotRef = controlRef(read(join(dir, 'snapshot.json')));
    requireContract(
      same(
        write.input!.payloads!.map((p) => defaultPayloadConverter.fromPayload(p)),
        [input, snapshotRef],
      ),
      'written-task-snapshot',
    );
    const snapshot = JSON.parse(files.store.read(snapshotRef).toString()) as TaskSnapshot;
    requireContract(
      same(snapshot.input, input) &&
        same(snapshot.source, source) &&
        same(snapshot.profile, profile) &&
        same(project.localTasks.profile, profile) &&
        same(snapshot.disabledServers, project.localTasks.disabledServers ?? []),
      'written-task-scope',
    );
    if (result === null) {
      const turn = interruptedWriterTurn(snapshot, files, dir);
      throw new Error('written-task-turn-interrupted-stop-unconfirmed', { cause: turn });
    }
    const receipt = writtenActivityReceipt(root, instance, execution, text(write.activityId));
    requireContract(same(read(receipt), result), 'written-task-activity-binding');
    const stopped = await inspectTaskWriter(snapshot, files, dir, new NativeWriterProcesses());
    requireContract(
      stopped.status === 'stopped' &&
        same(stopped.receipt, result.stop) &&
        stopped.runtime.session === result.session,
      'written-task-stop',
    );
    files.sourceCurrent(snapshot);
    requireContract(
      same(
        files.candidate(snapshot),
        JSON.parse(files.store.read(controlRef(result.tree)).toString()),
      ) &&
        same(
          result,
          JSON.parse(
            files.store.read(controlRef(read(join(dir, 'writer-result.json')))).toString(),
          ),
        ),
      'written-task-result',
    );
    const next = object(JSON.parse(nextOwner.toString()));
    const nextAdmissions = join(root, taskAdmissionsRelativePath(text(next.id), 3));
    mkdirSync(nextAdmissions, { mode: 0o700 });
    publishFile(
      join(nextAdmissions, admission),
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          host: { pid: next.pid, id: next.id },
          input,
          gate: { directory: dir, grant, mode: 'retained' },
        }),
      ),
    );
    const before = files.store.publish(former.bytes);
    const handoff = {
      execution,
      snapshot: snapshotRef,
      result,
      former: before,
      successor: files.store.publish(nextOwner),
    };
    publishFile(
      join(root, 'written-task-handoff-' + text(next.id)),
      Buffer.from(JSON.stringify(handoff)),
    );
    verifyFiles();
    const pending = join(root, 'host-successor-' + text(next.id));
    publishFile(pending, nextOwner);
    renameSync(pending, ownerPath);
    syncDirectory(root);
    return {
      input,
      instance,
      restoreFormer() {
        const rollback = takeTaskRecoveryLock(join(root, 'host-recovery-lock'));
        try {
          requireContract(
            readPrivateFile(ownerPath).equals(nextOwner),
            'written-task-owner-changed',
          );
          publishFile(pending, files.store.read(before));
          renameSync(pending, ownerPath);
          syncDirectory(root);
        } finally {
          rollback.release();
        }
      },
    };
  } finally {
    lock.release();
  }
}
