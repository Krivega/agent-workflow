import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskHumanCommandContext } from '../../src/contracts/taskHuman.js';
import type { PayloadReaderCommand } from '../../src/contracts/readerControl.js';
import { inspectStoppedTask } from '../../src/adapters/project/stoppedTask.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import * as checks from '../../src/adapters/project/taskChecks.js';
import { taskHumanLocalFixture } from './taskHumanLocalFixture.js';
import { runReview, throughIntegration, acceptance } from './localTaskRun.js';
import { closeTaskHuman, createTaskHumanState } from '../../src/policy/taskHuman.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { makeTaskExecutionCommand } from '../../src/client/taskExecution.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { prepareTaskStartAdmission } from '../../src/adapters/project/taskStartAdmission.js';
import * as artifacts from '../../src/adapters/artifacts/files.js';
import {
  nativeHumanAuthorizationText,
  nativeReaderAuthority,
} from '../../src/adapters/codex/readerAuthority.js';
import { readerCommandText } from '../../src/policy/readerControl.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function technical() {
  const f = await taskHumanLocalFixture();
  await f.service.executionControls.prepareTaskExecution(f.input);
  const manifest = await f.service.humanActivities.prepareTaskHuman(f.input),
    planning = await f.service.activities.prepareSubstantialPlanning(f.input),
    approved = await runReview(f, planning),
    run = await throughIntegration(f, f.input, approved.manifest),
    accepted = await acceptance(f, run),
    stopped = await f.service.controls.stopLocalTask(f.input);
  const context: TaskHumanCommandContext = {
    input: f.input,
    state: createTaskHumanState(manifest),
    technical: {
      input: f.input,
      snapshot: run.snapshot,
      packet: run.packet,
      acceptance: accepted.manifest,
      records: [planning.request, approved.manifest, accepted.manifest],
      stopped,
    },
  };
  const directory = join(
      f.workspace,
      '.git/agent-workflow/tasks',
      digest(taskControlTarget(f.input).workflowId),
    ),
    attempt = join(directory, 'execution-attempts/0'),
    journal = join(directory, 'execution-commands');
  function command(
    action: 'pause' | 'resume' | 'cancel',
    revision: number,
    payload?: PayloadReaderCommand['payload'],
    attemptNumber = 0,
    id = action + '-' + revision,
  ) {
    return makeTaskExecutionCommand({
      schemaVersion: 2,
      commandId: id,
      target: taskControlTarget(f.input),
      expectedRevision: revision,
      author: f.input.admission.preparation.owner,
      source: f.proof,
      action,
      attempt: attemptNumber,
      payload:
        payload ??
        f.save({
          schemaVersion: 1,
          kind: 'task-interruption',
          reason: 'Synthetic operator ' + action,
        }),
    });
  }
  return { ...f, context, run, directory, attempt, journal, executionCommand: command };
}
async function nativeCommand(f: Awaited<ReturnType<typeof technical>>, raw: PayloadReaderCommand) {
  const sessions = join(f.root, 'synthetic-sessions'),
    transcript = join(sessions, 'source.jsonl'),
    threadId = 'synthetic-issuer',
    turnId = 'synthetic-turn',
    records = [
      {
        type: 'session_meta',
        payload: {
          id: threadId,
          session_id: threadId,
          cwd: f.workspace,
          cli_version: '0.166.0-alpha.6',
          source: 'vscode',
          originator: 'codex_work_desktop',
          thread_source: 'user',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'turn_context', payload: { turn_id: turnId, cwd: f.workspace } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: nativeHumanAuthorizationText(raw) }],
        },
      },
    ];
  mkdirSync(sessions, { mode: 0o700 });
  writeFileSync(transcript, records.map((r) => JSON.stringify(r) + '\n').join(''), {
    mode: 0o600,
  });
  const source = f.save({
      schemaVersion: 1,
      kind: 'codex-user-command',
      transcript,
      threadId,
      turnId,
      user: { line: 4, sha256: digest(JSON.stringify(records[3]) + '\n') },
    }),
    authorized = { ...raw, source },
    command = { ...authorized, hash: digest(readerCommandText(authorized)) },
    authority = nativeReaderAuthority(f.store, {
      sessionsRoot: sessions,
      workspaceRoot: f.workspace,
      threadId,
      owner: command.author,
    });
  vi.stubEnv('CODEX_THREAD_ID', threadId);
  vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
  const notice = await authority.issue(command);
  appendFileSync(
    transcript,
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: turnId,
        item: {
          type: 'CommandExecution',
          cwd: f.workspace,
          aggregated_output: notice,
          status: 'completed',
          exit_code: 0,
        },
      },
    }) + '\n',
  );
  Object.assign(f.host, { authority });
  const verify = vi.spyOn(authority, 'verify');
  return {
    command,
    verify,
    append() {
      appendFileSync(
        transcript,
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Later' },
        }) + '\n',
      );
    },
  };
}
describe('v12 shared execution journal after technical STOP', { timeout: 30000 }, () => {
  it.each([false, true])(
    'resumes an actual held v12 attempt with ordinary payload2 (requirements changed=%s), rejects legacy payload1 before another grant',
    async (changed) => {
      const f = await taskHumanLocalFixture(),
        seal = await f.service.executionControls.prepareTaskExecution(f.input);
      const command = (
        action: 'pause' | 'resume',
        revision: number,
        payload: PayloadReaderCommand['payload'],
      ) =>
        makeTaskExecutionCommand({
          schemaVersion: 2,
          commandId: action + '-held',
          target: taskControlTarget(f.input),
          expectedRevision: revision,
          author: f.input.admission.preparation.owner,
          source: f.proof,
          action,
          attempt: action === 'resume' ? 1 : 0,
          payload,
        });
      const pause = command(
          'pause',
          0,
          f.save({ schemaVersion: 1, kind: 'task-interruption', reason: 'Synthetic held pause' }),
        ),
        ack = await f.service.executionControls.interruptTaskExecution(f.input, pause, 0),
        stop = await f.service.controls.stopLocalTask(f.input),
        held = await f.service.executionControls.holdTaskExecution(
          f.input,
          { phase: 'admitting', snapshot: null, planning: null, records: [seal] },
          stop,
          'pause',
          ack,
        );
      if (held.status !== 'held') throw new Error('actual held receipt required');
      let admission = f.input.admission,
        startAdmission = f.input.startAdmission;
      if (changed) {
        const preparation = { ...f.input.admission.preparation, revision: 2 };
        writeFileSync(
          join(f.workspace, preparation.card),
          readFileSync(join(f.workspace, preparation.card)).toString() +
            '- [ ] T2: Новый договор\n',
        );
        const declared = await prepareTaskStartAdmission(f.registration, f.startAuthority, {
          preparation,
          previous: startAdmission,
          human: [f.criterion],
          inapplicable: [],
        });
        startAdmission = declared.ref;
        f.proposal.requirement.hash = digest(readFileSync(join(f.workspace, preparation.card)));
        const bytes = Buffer.from(JSON.stringify(f.proposal));
        writeFileSync(join(f.workspace, f.input.admission.plan.path), bytes);
        admission = {
          ...f.input.admission,
          preparation,
          plan: { ...f.input.admission.plan, sha256: digest(bytes) },
        };
      }
      const legacy = f.save({
        schemaVersion: 1,
        kind: 'task-execution-resume',
        held: held.held,
        admission,
      });
      await expect(
        f.service.executionControls.resumeTaskExecution(
          f.input,
          held.held,
          command('resume', 1, legacy),
          1,
        ),
      ).rejects.toThrow();
      const payload = f.save({
          schemaVersion: 2,
          kind: 'task-execution-resume',
          held: held.held,
          admission,
          startAdmission,
        }),
        resume = command('resume', 1, payload),
        outcome = await f.service.executionControls.resumeTaskExecution(
          f.input,
          held.held,
          resume,
          1,
        );
      expect(outcome.input.schemaVersion).toBe(12);
      if (outcome.input.schemaVersion !== 12) throw new Error('human continuation required');
      expect(outcome.input.startAdmission).toEqual(startAdmission);
      expect(outcome.input.continuation).toEqual({
        attempt: 1,
        previous: outcome.ack.authorization,
      });
      expect(f.read(outcome.ack.authorization)).toMatchObject({
        kind: 'task-execution-continuation',
        held: held.held,
        startAdmission,
      });
      expect(
        await f.service.executionControls.resumeTaskExecution(f.input, held.held, resume, 1),
      ).toEqual(outcome);
      await f.service.executionControls.prepareTaskExecution(outcome.input);
      await f.service.activities.prepareSubstantialPlanning(outcome.input);
      expect(f.state.creates).toBe(0);
      expect(f.state.starts).toBe(0);
      await f.service.controls.stopLocalTask(outcome.input);
    },
  );
  it.each(['owned', 'cold'] as const)(
    'keeps human-wait pause/resume/cancel and duplicates on a stopped %s host without a Writer grant',
    async (mode) => {
      const f = await technical(),
        service = mode === 'owned' ? f.service : f.makeHumanService('cold-control'),
        permission = readFileSync(join(f.attempt, 'permission.json')),
        revoked = readFileSync(join(f.attempt, 'revoked.json')),
        starts = f.state.starts,
        creates = f.state.creates;
      const pause = f.executionCommand('pause', 0),
        paused = await service.humanActivities.controlTaskHumanExecution(f.context, pause, 0);
      expect(paused.input).toEqual(f.input);
      expect(await service.humanActivities.controlTaskHumanExecution(f.context, pause, 0)).toEqual(
        paused,
      );
      const payload = f.save({
          schemaVersion: 2,
          kind: 'task-human-wait-resume',
          admission: f.input.admission,
          startAdmission: f.input.startAdmission,
        }),
        resume = f.executionCommand('resume', 1, payload),
        resumed = await service.humanActivities.controlTaskHumanExecution(f.context, resume, 1),
        cancel = f.executionCommand('cancel', 2),
        cancelled = await service.humanActivities.controlTaskHumanExecution(f.context, cancel, 2);
      expect(resumed.input).toEqual(f.input);
      expect(cancelled.input).toEqual(f.input);
      expect(cancelled.ack.revision).toBe(3);
      expect(f.verify).toHaveBeenCalledTimes(3);
      expect(readFileSync(join(f.attempt, 'permission.json'))).toEqual(permission);
      expect(readFileSync(join(f.attempt, 'revoked.json'))).toEqual(revoked);
      expect(f.state.starts).toBe(starts);
      expect(f.state.creates).toBe(creates);
      expect(readdirSync(f.journal)).toHaveLength(3);
      const proof = f.read(resumed.ack.authorization);
      expect(proof).toMatchObject({ kind: 'task-human-execution-control', replan: false });
      expect(proof).not.toHaveProperty('held');
      expect(await service.executionControls.findTaskExecutionCommand(f.input, resume)).toEqual(
        resumed.ack,
      );
    },
  );
  it('recovers its own reservation left after actual STOP and preserves the control receipt across a cold host without another Writer', async () => {
    const f = await technical(),
      reservation = join(f.workspace, '.git/agent-workflow/source-reservation'),
      grant = readFileSync(join(f.attempt, 'grant.json')),
      permission = readFileSync(join(f.attempt, 'permission.json')),
      revoked = readFileSync(join(f.attempt, 'revoked.json')),
      starts = f.state.starts,
      creates = f.state.creates;
    expect(f.read(f.context.technical.stopped)).toMatchObject({
      kind: 'task-stopped',
      confirmed: true,
      input: f.input,
    });
    expect(existsSync(reservation)).toBe(false);
    writeFileSync(reservation, grant, { mode: 0o600 });
    const pause = f.executionCommand('pause', 0),
      outcome = await f.service.humanActivities.controlTaskHumanExecution(f.context, pause, 0);
    expect(outcome.input).toEqual(f.input);
    expect(outcome.ack).toMatchObject({
      commandId: pause.commandId,
      hash: pause.hash,
      revision: 1,
    });
    expect(readFileSync(reservation)).toEqual(grant);
    expect(readFileSync(join(f.attempt, 'grant.json'))).toEqual(grant);
    expect(readFileSync(join(f.attempt, 'permission.json'))).toEqual(permission);
    expect(readFileSync(join(f.attempt, 'revoked.json'))).toEqual(revoked);
    expect(await f.service.controls.stopLocalTask(f.input)).toEqual(f.context.technical.stopped);
    expect(existsSync(reservation)).toBe(false);
    const cold = f.makeHumanService('cold-own-reservation');
    expect(await cold.executionControls.findTaskExecutionCommand(f.input, pause)).toEqual(
      outcome.ack,
    );
    expect(await cold.humanActivities.controlTaskHumanExecution(f.context, pause, 0)).toEqual(
      outcome,
    );
    expect(readdirSync(f.journal)).toEqual([pause.commandId + '.json']);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.state.starts).toBe(starts);
    expect(f.state.creates).toBe(creates);
    expect(readFileSync(join(f.attempt, 'permission.json'))).toEqual(permission);
    expect(readFileSync(join(f.attempt, 'revoked.json'))).toEqual(revoked);
  });
  it('fails source, attempt, context, and declaration substitution before reserving a control or another Writer', async () => {
    const f = await technical(),
      starts = f.state.starts,
      creates = f.state.creates;
    const same = f.save({
      schemaVersion: 2,
      kind: 'task-human-wait-resume',
      admission: f.input.admission,
      startAdmission: f.input.startAdmission,
    });
    await expect(
      f.service.humanActivities.controlTaskHumanExecution(
        f.context,
        f.executionCommand('resume', 0, same, 1),
        0,
      ),
    ).rejects.toThrow('task-command-stale');
    const foreign = f.save({
      schemaVersion: 2,
      kind: 'task-human-wait-resume',
      admission: f.input.admission,
      startAdmission: f.proof,
    });
    await expect(
      f.service.humanActivities.controlTaskHumanExecution(
        f.context,
        f.executionCommand('resume', 0, foreign),
        0,
      ),
    ).rejects.toThrow('human-resume-declaration-revision');
    const changed = structuredClone(f.context);
    changed.technical.input.baseline = 'foreign';
    await expect(
      f.service.humanActivities.controlTaskHumanExecution(
        changed,
        f.executionCommand('pause', 0),
        0,
      ),
    ).rejects.toThrow();
    f.verify.mockResolvedValueOnce({
      origin: 'initial-grant',
      author: f.input.admission.preparation.owner,
      hash: f.executionCommand('pause', 0).hash,
      proof: f.proof,
    });
    await expect(
      f.service.humanActivities.controlTaskHumanExecution(
        f.context,
        f.executionCommand('pause', 0),
        0,
      ),
    ).rejects.toThrow('task-human-authorization-required');
    const reservation = join(f.workspace, '.git/agent-workflow/source-reservation'),
      foreignReservation = Buffer.from('foreign active source owner');
    writeFileSync(reservation, foreignReservation, { mode: 0o600 });
    await expect(
      f.service.humanActivities.controlTaskHumanExecution(
        f.context,
        f.executionCommand('pause', 0),
        0,
      ),
    ).rejects.toThrow('task-source-reserved');
    expect(readFileSync(reservation)).toEqual(foreignReservation);
    expect(existsSync(f.journal)).toBe(false);
    expect(f.state.starts).toBe(starts);
    expect(f.state.creates).toBe(creates);
  });
  it('records one native RESUME for a full next declaration, validates its continuation, and preserves prior integration without a fake held record', async () => {
    const f = await technical();
    const original = readFileSync(join(f.workspace, f.input.admission.preparation.card));
    writeFileSync(
      join(f.workspace, f.input.admission.preparation.card),
      original.toString() + '- [ ] T2: Подтвердить новый договор\n',
    );
    const preparation = { ...f.input.admission.preparation, revision: 2 },
      declaration = await prepareTaskStartAdmission(f.registration, f.startAuthority, {
        preparation,
        previous: f.input.startAdmission,
        human: [f.criterion],
        inapplicable: [],
      });
    f.proposal.requirement.hash = digest(readFileSync(join(f.workspace, preparation.card)));
    f.proposal.owner.hash = digest(readFileSync(join(f.workspace, f.proposal.owner.locator)));
    const bytes = Buffer.from(JSON.stringify(f.proposal));
    writeFileSync(join(f.workspace, f.input.admission.plan.path), bytes);
    const admission = {
        ...f.input.admission,
        preparation,
        plan: { ...f.input.admission.plan, sha256: digest(bytes) },
      },
      payload = f.save({
        schemaVersion: 2,
        kind: 'task-human-wait-resume',
        admission,
        startAdmission: declaration.ref,
      }),
      native = await nativeCommand(f, f.executionCommand('resume', 0, payload, 1)),
      command = native.command,
      outcome = await f.service.humanActivities.controlTaskHumanExecution(f.context, command, 0),
      next = outcome.input,
      proof = f.read(outcome.ack.authorization);
    expect(next.startAdmission).toEqual(declaration.ref);
    expect(next.continuation).toEqual({ attempt: 1, previous: outcome.ack.authorization });
    expect(proof).toMatchObject({ kind: 'task-human-execution-control', replan: true });
    expect(proof).not.toHaveProperty('held');
    expect(next.admission.preparation.revision).toBe(2);
    expect(f.state.creates).toBe(1);
    const authorization = proof.authorization as PayloadReaderCommand['source'],
      authorizationPath = f.store.path(authorization),
      retainedBytes = readFileSync(authorizationPath);
    native.append();
    const observedAgain = await native.verify(command);
    expect(observedAgain.proof).not.toEqual(authorization);
    native.verify.mockClear();
    await f.service.executionControls.prepareTaskExecution(next);
    renameSync(authorizationPath, authorizationPath + '.retained');
    await expect(f.service.activities.prepareSubstantialPlanning(next)).rejects.toThrow();
    renameSync(authorizationPath + '.retained', authorizationPath);
    writeFileSync(authorizationPath, Buffer.from('tampered retained authorization'));
    await expect(f.service.activities.prepareSubstantialPlanning(next)).rejects.toThrow(
      'artifact-corrupted',
    );
    writeFileSync(authorizationPath, retainedBytes);
    const intentPath = join(f.directory, 'execution-command-intents/1.json'),
      intentBytes = readFileSync(intentPath);
    renameSync(intentPath, intentPath + '.retained');
    await expect(f.service.activities.prepareSubstantialPlanning(next)).rejects.toThrow();
    renameSync(intentPath + '.retained', intentPath);
    const changedIntent = JSON.parse(intentBytes.toString()) as Record<string, unknown>;
    changedIntent.authorization = observedAgain.proof;
    writeFileSync(intentPath, JSON.stringify(changedIntent));
    await expect(f.service.activities.prepareSubstantialPlanning(next)).rejects.toThrow(
      'task-command-receipt-invalid',
    );
    writeFileSync(intentPath, intentBytes);
    const planning = await f.service.activities.prepareSubstantialPlanning(next),
      approved = await runReview(f, planning),
      run = await throughIntegration(f, next, approved.manifest),
      accepted = await acceptance(f, run);
    expect(accepted.complete).toBe(true);
    expect(f.state.creates).toBe(2);
    expect(f.read(run.intent)).toHaveProperty('previousIntegration');
    expect(f.assignment.startAdmission).toEqual(f.input.startAdmission);
    expect(native.verify).not.toHaveBeenCalled();
    await f.service.controls.stopLocalTask(next);
  });
  it('retains a lost control publication through the existing intent and reuses it without native or Writer replay', async () => {
    const f = await technical(),
      native = await nativeCommand(f, f.executionCommand('pause', 0)),
      command = native.command,
      publish = artifacts.publishFile;
    let failed = false;
    vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
      if (!failed && path === join(f.journal, command.commandId + '.json')) {
        failed = true;
        throw new Error('synthetic control receipt lost');
      }
      publish(path, bytes);
    });
    await expect(
      f.service.humanActivities.controlTaskHumanExecution(f.context, command, 0),
    ).rejects.toThrow('synthetic control receipt lost');
    native.append();
    const outcome = await f.service.humanActivities.controlTaskHumanExecution(
      f.context,
      command,
      0,
    );
    expect(outcome.input).toEqual(f.input);
    expect(outcome.ack.revision).toBe(1);
    expect(f.state.creates).toBe(1);
    expect(readdirSync(f.journal)).toEqual([command.commandId + '.json']);
    expect(native.verify).toHaveBeenCalledTimes(1);
    const verified = native.verify.mock.calls.length;
    expect(
      await f.service.humanActivities.controlTaskHumanExecution(f.context, command, 0),
    ).toEqual(outcome);
    expect(native.verify).toHaveBeenCalledTimes(verified);
  });
});

async function heldIntegration() {
  const f = await taskHumanLocalFixture(false),
    { input } = f,
    flag = join(f.root, 'fail-integrated');
  f.registration.commands.validate.args = [
    process.execPath,
    '-e',
    `if(require('fs').existsSync(${JSON.stringify(flag)}))process.exit(1);require('./validate.cjs')`,
  ];
  const service = f.makeHumanService(),
    a = service.activities,
    c = service.executionControls;
  await c.prepareTaskExecution(input);
  const planning = await a.prepareSubstantialPlanning(input),
    review = await runReview(f, planning);
  const snapshot = await a.prepareLocalTask(input, review.manifest);
  const baseline = await a.checkLocalTask(input, snapshot, 'baseline', null, null);
  const writer = await a.writeLocalTask(input, snapshot);
  const candidate = await a.checkLocalTask(input, snapshot, 'candidate', writer, null);
  const intent = await a.planLocalIntegration(input, snapshot, writer, candidate.manifest);
  const integration = await a.integrateLocalTask(input, snapshot, intent);
  writeFileSync(flag, 'fail');
  const failed = await a.checkLocalTask(input, snapshot, 'integrated', writer, integration);
  expect(failed.status).toBe('FAIL');
  const stopped = await service.controls.stopLocalTask(input);
  const held = await c.holdTaskExecution(
    input,
    {
      phase: 'integrated-checks',
      snapshot,
      planning,
      records: [baseline.manifest, candidate.manifest, intent, integration, failed.manifest],
    },
    stopped,
    'Error: task-integrated-checks-failed:' + failed.manifest.sha256,
    null,
  );
  if (held.status !== 'held') throw Error('hold required');
  const command = makeTaskExecutionCommand({
    schemaVersion: 2,
    commandId: 'recheck',
    target: taskControlTarget(input),
    expectedRevision: 0,
    author: input.admission.preparation.owner,
    action: 'resume',
    attempt: 0,
    source: f.proof,
    payload: f.save({
      schemaVersion: 2,
      kind: 'task-execution-resume',
      admission: input.admission,
      startAdmission: input.startAdmission,
      held: held.held,
    }),
  });
  const { ack } = await c.resumeTaskExecution(input, held.held, command, 0);
  return { f, input, flag, held, ack, service, failed, command };
}

it('rechecks the stopped integration and rejects changed files before independent acceptance', async () => {
  const { f, input, flag, ack, service, failed, command, held } = await heldIntegration();
  const activity = f.makeHumanService('replacement').activities;
  expect(
    (await service.executionControls.resumeTaskExecution(input, held.held, command, 0)).ack,
  ).toEqual(ack);
  await expect(activity.recheckIntegratedTask(input, f.proof)).rejects.toThrow(
    'task-recheck-authorization',
  );
  const attempt = join(
    f.workspace,
    '.git/agent-workflow/tasks',
    digest(taskControlTarget(input).workflowId),
    'execution-attempts/0',
  );
  const receipt = join(attempt, 'integration-receipt.json'),
    original = readFileSync(receipt);
  writeFileSync(receipt, JSON.stringify(held.held));
  await expect(activity.recheckIntegratedTask(input, ack.authorization)).rejects.toThrow(
    'task-integrated-recheck-binding',
  );
  writeFileSync(receipt, original);
  const target = join(f.workspace, 'owner.cjs'),
    bytes = readFileSync(target);
  appendFileSync(target, '// changed\n');
  await expect(activity.recheckIntegratedTask(input, ack.authorization)).rejects.toThrow(
    /task-source-conflict|task-check-input-changed/,
  );
  expect(f.state.creates).toBe(1);
  writeFileSync(target, bytes);
  renameSync(flag, flag + '.cleared');
  const packet = await activity.recheckIntegratedTask(input, ack.authorization);
  expect(await activity.recheckIntegratedTask(input, ack.authorization)).toEqual(packet);
  const accepted = await runReview(f, packet.packet);
  expect(accepted.complete).toBe(true);
  const human = f.makeHumanService('reviewer-host').humanActivities;
  const state = createTaskHumanState(await human.prepareTaskHuman(input));
  expect(
    await human.finishTaskHuman({
      schemaVersion: 1,
      kind: 'task-human-finish',
      expectedRevision: 0,
      input,
      state: closeTaskHuman(state, 0),
      technical: { input, ...packet, acceptance: accepted.manifest },
    }),
  ).toMatchObject({ status: 'done' });
  expect(f.state.creates).toBe(1);
  expect(f.read(failed.manifest).status).toBe('FAIL');
  const files = taskFiles(f.registration.artifactRoot, { existingOnly: true });
  const observed = await inspectStoppedTask({
    input,
    directory: attempt,
    source: files.binding(f.workspace),
    artifacts: files.binding(f.registration.artifactRoot),
    grant: readFileSync(join(attempt, 'grant.json')),
    processes: f.processes,
  });
  expect(observed.outcome).toMatchObject({ status: 'done' });
  await observed.recheck();
});

it('withholds STOP while an integrated recheck is running', async () => {
  const { f, input, ack, flag } = await heldIntegration();
  renameSync(flag, flag + '.cleared');
  const create = vi.mocked(checks.taskChecks).getMockImplementation()!;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
  vi.mocked(checks.taskChecks).mockImplementation((...args) => {
    const checker = create(...args);
    return {
      ...checker,
      async run(...command) {
        entered();
        await wait;
        return checker.run(...command);
      },
    };
  });
  const cold = f.makeHumanService('replacement');
  const result = cold.activities.recheckIntegratedTask(input, ack.authorization);
  await started;
  let acknowledged = false;
  const stopping = cold.controls.stopLocalTask(input).then((receipt) => {
    acknowledged = true;
    return receipt;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(acknowledged).toBe(false);
  const refused = expect(result).rejects.toThrow();
  release();
  await refused;
  const stopped = await stopping;
  expect(f.read(stopped).confirmed).toBe(true);
  await expect(cold.activities.recheckIntegratedTask(input, ack.authorization)).rejects.toThrow(
    'task-recovery-check-stop-unknown',
  );
  expect(f.state.creates).toBe(1);
});
