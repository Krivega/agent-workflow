import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContinuingTaskInput } from '../../src/contracts/localTask.js';
import type { AuthorizedReaderCommand } from '../../src/contracts/readerControl.js';
import type { TaskResumePayload } from '../../src/contracts/taskContinuation.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import { parseLocalTask, localTaskKey } from '../../src/policy/localTask.js';
import {
  parsePayloadReaderCommand,
  parseReaderCommand,
  readerCommandText,
  controlRef,
} from '../../src/policy/readerControl.js';
import {
  taskControlTarget,
  taskResumeCommand,
  checkTaskContinuation,
  parseTaskResumePayload,
} from '../../src/policy/taskContinuation.js';
import { makeTaskPlanningCommand } from '../../src/client/taskContinuation.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import { runReview, throughIntegration, acceptance } from './localTaskRun.js';
import { digest } from '../../src/adapters/artifacts/files.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = substantialTaskFixture(),
    input: ContinuingTaskInput = {
      ...f.substantialInput,
      schemaVersion: 10,
      continuation: { attempt: 0, previous: null },
    };
  const verify = vi.fn(async (command: AuthorizedReaderCommand) => ({
    origin: 'human' as const,
    author: command.author,
    hash: command.hash,
    proof: f.proof,
  }));
  const host = { ...f.host, authority: { verify } };
  const service = localTaskActivities(f.registration, host, f.rpc, f.profile, () => {});
  const taskCommand = (held = f.proof, admission = input.admission) =>
    makeTaskPlanningCommand({
      schemaVersion: 2,
      commandId: 'resume-one',
      target: taskControlTarget(input),
      expectedRevision: 0,
      author: input.admission.preparation.owner,
      action: 'resume',
      attempt: 1,
      source: f.proof,
      payload: f.save({ schemaVersion: 1, kind: 'task-planning-resume', held, admission }),
    });
  const result = { ...f, input, service, host, verify, taskCommand };
  const hold = async () => {
    const planning = await service.activities.prepareSubstantialPlanning(input);
    f.state.verdict = 'FAIL';
    const failed = await runReview(result, planning);
    const held = await service.continuationControls.holdTaskPlanning(
      input,
      planning,
      failed.manifest,
    );
    return { planning, failed, held };
  };
  return { ...result, hold };
}
describe('human continuation before the first writer', { timeout: 20000 }, () => {
  it('recovers a lost held publication after confirmed stop without reopening the frozen permit', async () => {
    const f = fixture(),
      planning = await f.service.activities.prepareSubstantialPlanning(f.input);
    f.state.verdict = 'FAIL';
    const failed = await runReview(f, planning),
      starts = f.state.starts;
    const files = await import('../../src/adapters/artifacts/files.js'),
      original = files.publishFile;
    const publish = vi.spyOn(files, 'publishFile').mockImplementation((path, bytes) => {
      if (path.endsWith('/held.json')) throw new Error('held-publication-lost');
      original(path, bytes);
    });
    await expect(
      f.service.continuationControls.holdTaskPlanning(f.input, planning, failed.manifest),
    ).rejects.toThrow('held-publication-lost');
    publish.mockRestore();
    const directory = join(
      f.workspace,
      '.git',
      'agent-workflow',
      'tasks',
      digest(localTaskKey(f.input)),
      'planning-attempts',
      '0',
    );
    const stopped = readFileSync(join(directory, 'stopped.json'));
    expect(existsSync(join(directory, 'held.json'))).toBe(false);
    expect(f.read(controlRef(JSON.parse(stopped.toString())))).toMatchObject({
      confirmed: true,
      input: f.input,
    });
    const held = await f.service.continuationControls.holdTaskPlanning(
      f.input,
      planning,
      failed.manifest,
    );
    expect(f.read(held)).toMatchObject({
      input: f.input,
      review: failed.manifest,
      stopped: controlRef(JSON.parse(stopped.toString())),
    });
    expect(readFileSync(join(directory, 'stopped.json'))).toEqual(stopped);
    expect(JSON.parse(readFileSync(join(directory, 'permission.json'), 'utf8'))).toMatchObject({
      active: false,
    });
    expect(f.read(failed.manifest).complete).toBe(false);
    expect(f.state.starts).toBe(starts);
    expect(f.state.creates).toBe(0);
  });
  it('keeps the original FAIL, stops before waiting, resumes the same task and completes fresh checks/acceptance', async () => {
    const f = fixture(),
      { planning, failed, held } = await f.hold();
    expect(f.read(failed.manifest).complete).toBe(false);
    expect(f.state.creates).toBe(0);
    expect(
      await f.service.continuationControls.holdTaskPlanning(f.input, planning, failed.manifest),
    ).toEqual(held);
    const command = f.taskCommand(held);
    const resumed = await f.service.continuationControls.resumeTaskPlanning(
      f.input,
      held,
      command,
      0,
    );
    expect(
      await f.service.continuationControls.resumeTaskPlanning(f.input, held, command, 0),
    ).toEqual(resumed);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(localTaskKey(resumed.input)).toBe(localTaskKey(f.input));
    expect(resumed.input.admission.preparation).toEqual(f.input.admission.preparation);
    expect(f.read(resumed.ack.authorization)).toMatchObject({
      input: f.input,
      held,
      invalidated: ['planning', 'baseline', 'candidate-checks', 'integrated-checks', 'acceptance'],
    });
    const fresh = await f.service.activities.prepareSubstantialPlanning(resumed.input);
    expect(fresh.reviewId).not.toBe(planning.reviewId);
    expect(f.read(fresh.request).evidence).toContainEqual(resumed.ack.authorization);
    f.state.verdict = 'PASS';
    const approved = await runReview(f, fresh);
    expect(f.state.readers).toBe(4);
    const run = await throughIntegration(f, resumed.input, approved.manifest);
    const accepted = await acceptance(f, run);
    expect(
      await run.a.finishLocalTask(resumed.input, run.snapshot, run.packet, accepted.manifest),
    ).toMatchObject({ status: 'done' });
    expect(f.read(failed.manifest).complete).toBe(false);
    expect(f.state.readers).toBe(6);
    expect(f.state.creates).toBe(1);
    expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).toContain('trim()');
  });
  it('accepts a new requirements revision within the old writer scope and repeats all planning roles', async () => {
    const f = fixture(),
      { held } = await f.hold();
    const bytes = Buffer.from(
      JSON.stringify({
        ...f.proposal,
        criterion: 'Trim names and preserve ordinary names after human clarification',
      }),
    );
    writeFileSync(join(f.workspace, 'plan.json'), bytes);
    const admission = {
      ...f.input.admission,
      plan: { ...f.input.admission.plan, sha256: digest(bytes) },
      preparation: { ...f.input.admission.preparation, revision: 2 },
    };
    const result = await f.service.continuationControls.resumeTaskPlanning(
      f.input,
      held,
      f.taskCommand(held, admission),
      0,
    );
    expect(result.input.admission.preparation.revision).toBe(2);
    const planning = await f.service.activities.prepareSubstantialPlanning(result.input);
    f.state.verdict = 'PASS';
    expect((await runReview(f, planning)).complete).toBe(true);
    expect(f.state.readers).toBe(4);
    expect(f.state.creates).toBe(0);
  });
  it.each([
    'authority',
    'initial-grant',
    'hash',
    'proof',
    'held',
    'scope',
    'revision',
    'payload',
    'plan',
    'writer-scope',
    'plan-scope',
  ])('rejects %s without starting a writer', async (defect) => {
    const f = fixture(),
      { held } = await f.hold();
    let command = f.taskCommand(held);
    if (defect === 'authority') delete (f.host as { authority?: unknown }).authority;
    if (defect === 'initial-grant')
      f.verify.mockResolvedValue({
        origin: 'initial-grant',
        author: command.author,
        hash: command.hash,
        proof: f.proof,
      } as never);
    if (defect === 'hash') command.hash = '0'.repeat(64);
    if (defect === 'proof')
      f.verify.mockResolvedValue({
        origin: 'human',
        author: command.author,
        hash: command.hash,
        proof: { sha256: 'a'.repeat(64), bytes: 1 },
      });
    if (defect === 'held') command = f.taskCommand(f.proof);
    if (defect === 'scope')
      command = f.taskCommand(held, {
        ...f.input.admission,
        preparation: { ...f.input.admission.preparation, owner: 'foreign' },
      });
    if (defect === 'revision')
      command = f.taskCommand(held, { ...f.input.admission, planning: f.proof });
    if (defect === 'payload')
      command = makeTaskPlanningCommand({ ...command, payload: f.save({}) });
    if (defect === 'plan') writeFileSync(join(f.workspace, 'plan.json'), '{}');
    if (defect === 'writer-scope' || defect === 'plan-scope') {
      const bytes = Buffer.from(
        JSON.stringify({
          ...f.proposal,
          ...(defect === 'writer-scope'
            ? { paths: ['owner.cjs', 'other.cjs'] }
            : { plan_id: 'other' }),
        }),
      );
      writeFileSync(join(f.workspace, 'plan.json'), bytes);
      command = f.taskCommand(held, {
        ...f.input.admission,
        plan: { path: 'plan.json', sha256: digest(bytes) },
        preparation: { ...f.input.admission.preparation, revision: 2 },
      });
    }
    await expect(
      f.service.continuationControls.resumeTaskPlanning(f.input, held, command, 0),
    ).rejects.toThrow();
    expect(f.state.creates).toBe(0);
  });
  it('refuses conflicting IDs, forged transitions and continuation after snapshot creation', async () => {
    const f = fixture(),
      { held } = await f.hold();
    const command = f.taskCommand(held),
      resumed = await f.service.continuationControls.resumeTaskPlanning(f.input, held, command, 0);
    await expect(
      f.service.continuationControls.resumeTaskPlanning(
        f.input,
        held,
        makeTaskPlanningCommand({ ...command, source: command.payload }),
        0,
      ),
    ).rejects.toThrow('task-command-id-conflict');
    await expect(
      f.service.activities.prepareSubstantialPlanning({
        ...resumed.input,
        continuation: { attempt: 2, previous: resumed.input.continuation.previous },
      }),
    ).rejects.toThrow('task-continuation-binding');
    const planning = await f.service.activities.prepareSubstantialPlanning(resumed.input);
    f.state.verdict = 'PASS';
    const approved = await runReview(f, planning);
    await f.service.activities.prepareLocalTask(resumed.input, approved.manifest);
    await expect(
      f.service.continuationControls.holdTaskPlanning(resumed.input, planning, approved.manifest),
    ).rejects.toThrow('task-continuation-after-writer');
  });
  it('keeps strict version, target, payload and requirements revision contracts', () => {
    const f = fixture(),
      c = f.taskCommand();
    expect(parseLocalTask(f.input)).toEqual(f.input);
    expect(parsePayloadReaderCommand(c)).toEqual(c);
    expect(taskResumeCommand(f.input, c, 0)).toEqual(c);
    expect(JSON.parse(readerCommandText(c))).toHaveLength(11);
    expect(() => parseReaderCommand(c)).toThrow();
    for (const continuation of [
      { attempt: -1, previous: null },
      { attempt: 1, previous: null },
      { attempt: 0, previous: f.proof },
      { attempt: 1.5, previous: f.proof },
    ])
      expect(() => parseLocalTask({ ...f.input, continuation })).toThrow(
        'task-continuation-invalid',
      );
    expect(
      parseLocalTask({ ...f.input, continuation: { attempt: 1, previous: f.proof } }),
    ).toHaveProperty('continuation.previous', f.proof);
    expect(() => parsePayloadReaderCommand({ ...c, schemaVersion: 1 })).toThrow();
    expect(() =>
      taskResumeCommand(f.input, { ...c, target: { ...c.target, generation: 2 } }, 0),
    ).toThrow('task-command-target-mismatch');
    expect(() => taskResumeCommand(f.input, { ...c, action: 'pause' }, 0)).toThrow(
      'task-command-action',
    );
    expect(() => taskResumeCommand(f.input, c, 1)).toThrow('task-command-stale');
    expect(() => taskResumeCommand(f.input, { ...c, attempt: 2 }, 0)).toThrow('task-command-stale');
    const payload: TaskResumePayload = {
      schemaVersion: 1,
      kind: 'task-planning-resume',
      held: f.proof,
      admission: f.input.admission,
    };
    expect(parseTaskResumePayload(payload)).toEqual(payload);
    expect(() => parseTaskResumePayload({ ...payload, kind: 'other' })).toThrow();
    expect(() =>
      checkTaskContinuation(f.input, {
        ...payload,
        admission: {
          ...payload.admission,
          preparation: { ...payload.admission.preparation, revision: 3 },
        },
      }),
    ).toThrow('task-resume-scope-changed');
  });
});
