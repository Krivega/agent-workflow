import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Long from 'long';
import { WorkflowClient } from '@temporalio/client';
import { defaultPayloadConverter as converter } from '@temporalio/common';
import { Worker, type NativeConnection, type WorkerOptions } from '@temporalio/worker';
import { localTaskFixture } from './localTaskFixture.js';
import { createReaderHost } from '../../src/worker/readerHost.js';
import {
  claimWrittenTask,
  recordWrittenActivity,
  writtenActivityReceipt,
} from '../../src/worker/writtenTaskRecovery.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import {
  taskAdmissionIdentity,
  taskAdmissionsRelativePath,
} from '../../src/policy/taskRecovery.js';
import type { LocalTaskActivities } from '../../src/contracts/localTask.js';

const activity = vi.hoisted(() => ({
  info: { workflowExecution: { workflowId: '', runId: '' } },
  heartbeat() {},
}));
vi.mock('@temporalio/activity', () => ({ Context: { current: () => activity } }));

function write(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
}
beforeEach(() => vi.restoreAllMocks());
async function fixture() {
  const f = localTaskFixture(),
    a = f.service.activities;
  const snapshot = await a.prepareLocalTask(f.input);
  await a.checkLocalTask(f.input, snapshot, 'baseline', null, null);
  const writer = await a.writeLocalTask(f.input, snapshot);
  const root = join(f.root, 'cold-host');
  const run = { workflowId: localTaskKey(f.input), runId: 'original-run' };
  const dir = join(f.workspace, '.git/agent-workflow/tasks', digest(run.workflowId));
  const grant = readFileSync(join(dir, 'grant.json'));
  const id = (JSON.parse(grant.toString()) as { instance: string }).instance;
  const owner = { pid: 2147483647, id, tasks: true, taskBindings: 3 };
  const newOwner = Buffer.from(JSON.stringify({ ...owner, id: 'second-host', pid: process.pid }));
  const admissions = join(root, taskAdmissionsRelativePath(id, 3));
  const readers = join(
    root,
    digest(f.input.admission.preparation.project.projectId),
    'permissions',
  );
  for (const path of [readers, admissions, join(root, 'admissions')])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  write(join(root, 'host-owner'), owner);
  const row = {
    schemaVersion: 1,
    host: { pid: owner.pid, id },
    input: f.input,
    gate: { directory: dir, grant: { sha256: digest(grant), bytes: grant.length }, mode: 'owned' },
  };
  const key = digest(taskAdmissionIdentity(f.input));
  write(join(admissions, key), row);
  const scheduled = (name: string, i: number, values: unknown[] = []) => ({
    eventId: Long.fromInt(i),
    activityTaskScheduledEventAttributes: {
      activityType: { name },
      activityId: String(i),
      input: { payloads: values.map((v) => converter.toPayload(v)) },
    },
  });
  const receipt = writtenActivityReceipt(root, id, run, '3');
  recordWrittenActivity(receipt, writer);
  const start = {
    workflowType: { name: 'LocalTaskWorkflow' },
    originalExecutionRunId: run.runId,
    input: { payloads: [converter.toPayload(f.input)] },
  };
  const result = {
    scheduledEventId: Long.fromInt(3),
    result: { payloads: [converter.toPayload(writer)] },
  };
  const writeEvent = scheduled('writeLocalTask', 3, [f.input, snapshot]);
  const events: unknown[] = [
    { workflowExecutionStartedEventAttributes: start },
    scheduled('prepareLocalTask', 1),
    scheduled('checkLocalTask', 2),
    writeEvent,
    { activityTaskCompletedEventAttributes: result },
  ];
  const description = { runId: run.runId, status: { name: 'RUNNING' }, taskQueue: 'q' };
  const getHandle = vi.spyOn(WorkflowClient.prototype, 'getHandle').mockReturnValue({
    describe: async () => description,
    fetchHistory: async () => ({ events }),
  } as never);
  const connection = {} as NativeConnection;
  const project = {
    registration: f.registration,
    localTasks: f.host,
    rpc: f.rpc,
    authority: f.authority,
  };
  const claim = () =>
    claimWrittenTask(connection, 'q', [project], f.profile, root, run, newOwner, 'recovery');
  const host = () => createReaderHost(connection, 'q', 'w', [project], f.profile, root, 5, run);
  return {
    getHandle,
    f,
    run,
    dir,
    root,
    owner,
    row,
    admissions,
    readers,
    key,
    claim,
    host,
    description,
    start,
    events,
    result,
    writeEvent,
    writer,
    snapshot,
    newOwner,
    receipt,
  };
}
describe('post-write Worker replacement', { timeout: 20000 }, () => {
  it('reconciles a timed-out write against the original accepted native turn without transferring its grant', async () => {
    const v = await fixture();
    const savedOwner = readFileSync(join(v.root, 'host-owner'));
    const savedGrant = readFileSync(join(v.dir, 'grant.json'));
    const scheduledEventId = Long.fromInt(3);
    const startedEventId = Long.fromInt(4);
    const timeout = { activityTaskTimedOutEventAttributes: { scheduledEventId, startedEventId } };
    v.events.pop();
    v.events.push(timeout);
    await expect(v.claim()).rejects.toThrow('written-task-history');
    v.events.splice(-1, 0, {
      eventId: startedEventId,
      activityTaskStartedEventAttributes: { scheduledEventId },
    });
    await expect(v.claim()).rejects.toThrow('written-task-unsettled');
    unlinkSync(join(v.dir, 'writer-result.json'));
    unlinkSync(join(v.dir, 'writer-stopped.json'));
    await expect(v.claim()).rejects.toThrow('task-writer-turn-outcome-unknown');
    const transcript = join(v.f.root, 'writer-transcript.jsonl');
    for (const type of ['task_started', 'turn_aborted'])
      appendFileSync(
        transcript,
        JSON.stringify({ type: 'event_msg', payload: { type, turn_id: 'writer-turn-3' } }) + '\n',
      );
    await expect(v.claim()).rejects.toMatchObject({
      message: 'written-task-turn-interrupted-stop-unconfirmed',
      cause: { session: 'writer', turn: 'writer-turn-3' },
    });
    appendFileSync(
      transcript,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'writer-turn-3' },
      }) + '\n',
    );
    await expect(v.claim()).rejects.toThrow('task-writer-turn-outcome-unknown');
    expect(readFileSync(join(v.root, 'host-owner'))).toEqual(savedOwner);
    expect(readFileSync(join(v.dir, 'grant.json'))).toEqual(savedGrant);
  });
  it('keeps the previous owner until history, the grant, the stopped Writer and both file trees agree', async () => {
    const v = await fixture(),
      op = join(v.root, 'host-owner'),
      original = readFileSync(op);
    async function refuses(reason: string) {
      await expect(v.claim()).rejects.toThrow(reason);
      expect(readFileSync(op)).toEqual(original);
    }
    write(op, { ...v.owner, pid: process.pid });
    await expect(v.claim()).rejects.toThrow('reader-host-still-alive');
    write(op, v.owner);
    write(op, { ...v.owner, pid: -1 });
    await expect(v.claim()).rejects.toThrow('written-task-former-owner');
    write(op, v.owner);
    v.description.taskQueue = 'wrong';
    await refuses('written-task-execution');
    v.description.taskQueue = 'q';
    v.start.originalExecutionRunId = 'wrong';
    await refuses('written-task-run-binding');
    v.start.originalExecutionRunId = v.run.runId;
    v.events.push({ workflowExecutionSignaledEventAttributes: {} });
    await refuses('written-task-history');
    v.events.pop();
    v.events.push(v.writeEvent);
    await refuses('written-task-stage');
    v.events.pop();
    const last = v.events.pop();
    await refuses('written-task-completion-required');
    v.events.push(last);
    const wrongRef = converter.toPayload(v.f.proof),
      args = v.writeEvent.activityTaskScheduledEventAttributes.input.payloads;
    const prior = args[1]!;
    args[1] = wrongRef;
    await refuses('written-task-snapshot');
    args[1] = prior;
    write(join(v.readers, 'extra'), {});
    await refuses('written-task-inventory');
    unlinkSync(join(v.readers, 'extra'));
    write(join(v.admissions, v.key), { ...v.row, host: { pid: 123, id: v.owner.id } });
    await refuses('written-task-admission');
    write(join(v.admissions, v.key), v.row);
    const perm = join(v.dir, 'permission.json'),
      active = readFileSync(perm);
    write(perm, {});
    await refuses('written-task-permission');
    writeFileSync(perm, active);
    write(join(v.dir, 'permission-lock'), {});
    await refuses('written-task-unsettled');
    unlinkSync(join(v.dir, 'permission-lock'));
    recordWrittenActivity(v.receipt, v.writer);
    expect(() => recordWrittenActivity(v.receipt, { ...v.writer, stop: v.f.proof })).toThrow(
      'written-task-activity-conflict',
    );
    expect(() => recordWrittenActivity(join(v.dir, 'missing', 'path'), v.writer)).toThrow('ENOENT');
    v.result.result.payloads[0] = converter.toPayload({ ...v.writer, stop: v.f.proof });
    await refuses('written-task-activity-binding');
    write(v.receipt, { ...v.writer, stop: v.f.proof });
    await refuses('written-task-stop');
    v.result.result.payloads[0] = converter.toPayload({ ...v.writer, answer: v.f.proof });
    write(v.receipt, { ...v.writer, answer: v.f.proof });
    await refuses('written-task-result');
    write(v.receipt, v.writer);
    v.result.result.payloads[0] = converter.toPayload(v.writer);
    const src = join(v.f.workspace, 'owner.cjs');
    const before = readFileSync(src);
    writeFileSync(src, 'changed');
    await refuses('task-source-conflict');
    writeFileSync(src, before);
    const first = await v.claim();
    expect(v.getHandle.mock.contexts.at(-1)).toMatchObject({ options: { namespace: 'recovery' } });
    expect(first.input).toEqual(v.f.input);
    expect(readFileSync(op)).toEqual(v.newOwner);
    expect(readFileSync(join(v.admissions, v.key), 'utf8')).toBe(JSON.stringify(v.row));
    first.restoreFormer();
    expect(readFileSync(op)).toEqual(original);
    expect(() => first.restoreFormer()).toThrow('written-task-owner-changed');
  });
  it('follows the original grant when a recovered host dies before polling', async () => {
    const v = await fixture();
    Reflect.deleteProperty(v.f.host, 'disabledServers');
    const prior = { ...v.owner, id: 'former-successor' };
    const admissions = join(v.root, taskAdmissionsRelativePath(prior.id, 3));
    mkdirSync(admissions, { mode: 0o700 });
    write(join(v.root, 'host-owner'), prior);
    write(join(admissions, v.key), {
      ...v.row,
      host: { pid: prior.pid, id: prior.id },
      gate: { ...v.row.gate, mode: 'retained' },
    });
    expect((await v.claim()).instance).toBe(v.owner.id);
  });
  it('attaches the existing grant, fences unrelated runs and restores ownership after setup fails', async () => {
    const v = await fixture(),
      op = join(v.root, 'host-owner'),
      former = readFileSync(op);
    const factory = vi
      .spyOn(Worker, 'create')
      .mockRejectedValueOnce(new Error('SDK startup failed'));
    await expect(v.host()).rejects.toThrow('SDK startup failed');
    expect(readFileSync(op)).toEqual(former);
    let stop!: () => void;
    const ended = new Promise<void>((resolve) => {
      stop = resolve;
    });
    factory.mockResolvedValue({ run: () => ended, shutdown: () => stop() } as Worker);
    const host = await v.host();
    const workers = factory.mock.calls.map(([options]: [WorkerOptions]) => options);
    const acts = workers.at(-1)!.activities as LocalTaskActivities;
    const controls = workers.at(-2)!.activities as {
      stopLocalTask: LocalTaskActivities['prepareLocalTask'];
    };
    activity.info.workflowExecution = { ...v.run, runId: 'foreign' };
    expect(() => controls.stopLocalTask(v.f.input)).toThrow('written-task-run-mismatch');
    await expect(
      acts.checkLocalTask(v.f.input, v.snapshot, 'candidate', v.writer, null),
    ).rejects.toThrow('written-task-run-mismatch');
    activity.info.workflowExecution = v.run;
    await expect(acts.writeLocalTask(v.f.input, v.snapshot)).rejects.toThrow(
      'written-task-writer-already-completed',
    );
    await host.runUntil(async () => {
      expect(
        (await acts.checkLocalTask(v.f.input, v.snapshot, 'candidate', v.writer, null)).status,
      ).toBe('PASS');
    });
    expect(v.f.state.creates).toBe(1);
  });
});
