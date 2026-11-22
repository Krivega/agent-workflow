import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { readerBudget } from '../../src/adapters/codex/readerBudget.js';
import { captureTaskBudget } from '../../src/worker/taskBudget.js';
import type { TaskExecutionControls } from '../../src/contracts/taskExecution.js';
import type { ManagedTaskInput } from '../../src/contracts/localTask.js';
import type { ReaderAuthority } from '../../src/contracts/readerControl.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import { makeTaskExecutionCommand } from '../../src/client/taskExecution.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { object } from '../../src/contracts/project.js';
import { controlRef } from '../../src/policy/readerControl.js';
import * as artifacts from '../../src/adapters/artifacts/files.js';
import * as gates from '../../src/adapters/project/taskGate.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import { runReview, throughIntegration, acceptance } from './localTaskRun.js';
import { archiveFixture } from './finalizationFixture.js';

afterEach(() => vi.restoreAllMocks());
function fixture(base = substantialTaskFixture(), executionCommandOrigin?: 'initial-grant') {
  const f = base,
    input: ManagedTaskInput = {
      ...f.substantialInput,
      schemaVersion: 11,
      continuation: { attempt: 0, previous: null },
    },
    verify = vi.fn<ReaderAuthority['verify']>(async (command) => ({
      origin: 'human',
      author: command.author,
      hash: command.hash,
      proof: f.proof,
    })),
    host = {
      ...f.host,
      authority: { verify },
      ...(executionCommandOrigin === undefined ? {} : { executionCommandOrigin }),
    },
    budgetDirectory = join(f.root, 'model-credits'),
    charge = readerBudget(budgetDirectory, 15),
    credits = new Map<string, string>(),
    consume = vi.fn((id: string, hash: string) => {
      charge(id, hash);
      const previous = credits.get(id);
      if (previous !== undefined && previous !== hash) throw new Error('fixture-credit-conflict');
      credits.set(id, hash);
    }),
    service = localTaskActivities(f.registration, host, f.rpc, f.profile, consume, {
      instance: 'unit-host',
      admitted: vi.fn(),
      budget: (_input, previous) => captureTaskBudget(budgetDirectory, f.store, previous),
    }),
    environment = new MockActivityEnvironment();
  const controls: TaskExecutionControls = {
    ...service.executionControls,
    interruptTaskExecution: (...args) =>
      environment.run(() => service.executionControls.interruptTaskExecution(...args)),
    resumeTaskExecution: (...args) =>
      environment.run(() => service.executionControls.resumeTaskExecution(...args)),
    saveTaskExecutionCheckpoint: (...args) =>
      environment.run(() => service.executionControls.saveTaskExecutionCheckpoint(...args)),
    loadTaskExecutionCheckpoint: (...args) =>
      environment.run(() => service.executionControls.loadTaskExecutionCheckpoint(...args)),
  };
  const command = (
    action: 'pause' | 'resume' | 'cancel',
    revision: number,
    payload = f.save({
      schemaVersion: 1,
      kind: 'task-interruption',
      reason: 'Human requested a safe pause',
    }),
    current = input,
    id = action + '-' + revision,
  ) =>
    makeTaskExecutionCommand({
      schemaVersion: 2,
      commandId: id,
      target: taskControlTarget(current),
      expectedRevision: revision,
      author: current.admission.preparation.owner,
      action,
      attempt: current.continuation.attempt + (action === 'resume' ? 1 : 0),
      source: f.proof,
      payload,
    });
  const result = {
    ...f,
    input,
    host,
    verify,
    service,
    executionControls: controls,
    executionCommand: command,
    consume,
    credits,
    environment,
    budgetDirectory,
  };
  async function paused() {
    const seal = await controls.prepareTaskExecution(input),
      pause = command('pause', 0),
      ack = await controls.interruptTaskExecution(input, pause, 0),
      stopped = await service.controls.stopLocalTask(input),
      outcome = await controls.holdTaskExecution(
        input,
        { phase: 'admitting', snapshot: null, planning: null, records: [seal] },
        stopped,
        'pause',
        ack,
      );
    if (outcome.status !== 'held') throw new Error('fixture-not-held');
    return { seal, pause, ack, stopped, held: outcome.held };
  }
  async function integratedPause() {
    const seal = await controls.prepareTaskExecution(input),
      planning = await service.activities.prepareSubstantialPlanning(input),
      approved = await runReview(result, planning),
      run = await throughIntegration(result, input, approved.manifest),
      pause = command('pause', 0),
      ack = await controls.interruptTaskExecution(input, pause, 0),
      stopped = await service.controls.stopLocalTask(input),
      outcome = await controls.holdTaskExecution(
        input,
        {
          phase: 'integrated-checks',
          snapshot: run.snapshot,
          planning,
          records: [seal, approved.manifest, run.intent, run.integration, run.checked.manifest],
        },
        stopped,
        'Clarify requirements after integration',
        ack,
      );
    if (outcome.status !== 'held') throw new Error('fixture-not-held');
    const bytes = Buffer.from(
      JSON.stringify({
        ...f.proposal,
        owner: {
          ...f.proposal.owner,
          hash: digest(readFileSync(join(f.workspace, f.proposal.owner.locator))),
        },
        criterion: f.proposal.criterion + '; independently verify the integrated implementation',
      }),
    );
    writeFileSync(join(f.workspace, 'plan.json'), bytes);
    const admission = {
        ...input.admission,
        plan: { ...input.admission.plan, sha256: digest(bytes) },
        preparation: { ...input.admission.preparation, revision: 2 },
      },
      resume = command(
        'resume',
        1,
        f.save({ schemaVersion: 1, kind: 'task-execution-resume', held: outcome.held, admission }),
      ),
      next = await controls.resumeTaskExecution(input, outcome.held, resume, 1);
    if (next.input.schemaVersion !== 11) throw new Error('fixture-requires-schema11');
    await controls.prepareTaskExecution(next.input);
    const nextPlanning = await service.activities.prepareSubstantialPlanning(next.input),
      nextApproved = await runReview(result, nextPlanning),
      snapshot = await service.activities.prepareLocalTask(next.input, nextApproved.manifest),
      baseline = await service.activities.checkLocalTask(
        next.input,
        snapshot,
        'baseline',
        null,
        null,
      ),
      writer = await service.activities.writeLocalTask(next.input, snapshot),
      candidate = await service.activities.checkLocalTask(
        next.input,
        snapshot,
        'candidate',
        writer,
        null,
      );
    return { run, next: next.input, snapshot, writer, baseline, candidate };
  }
  async function writerHeld() {
    const seal = await controls.prepareTaskExecution(input),
      planning = await service.activities.prepareSubstantialPlanning(input),
      approved = await runReview(result, planning),
      snapshot = await service.activities.prepareLocalTask(input, approved.manifest),
      baseline = await service.activities.checkLocalTask(input, snapshot, 'baseline', null, null),
      writer = await service.activities.writeLocalTask(input, snapshot),
      pause = command('pause', 0),
      ack = await controls.interruptTaskExecution(input, pause, 0),
      stopped = await service.controls.stopLocalTask(input),
      held = await controls.holdTaskExecution(
        input,
        {
          phase: 'writing',
          snapshot,
          planning,
          records: [
            seal,
            approved.manifest,
            baseline.manifest,
            writer.answer,
            writer.stop,
            writer.tree,
          ],
        },
        stopped,
        'Pause before replacing the Worker',
        ack,
      );
    if (held.status !== 'held') throw new Error('fixture-not-held');
    const directory = join(
        f.workspace,
        '.git/agent-workflow/tasks',
        digest('aw/task/neutral/one'),
        'execution-attempts/0',
      ),
      grant = readFileSync(join(directory, 'grant.json')),
      permission = readFileSync(join(directory, 'permission.json')),
      stoppedBytes = readFileSync(join(directory, 'stopped.json'));
    function replacement() {
      const admitted = vi.fn(),
        service = localTaskActivities(f.registration, host, f.rpc, f.profile, consume, {
          instance: 'replacement-host',
          admitted,
          budget: (_input, previous) => captureTaskBudget(budgetDirectory, f.store, previous),
        });
      return { ...service, admitted };
    }
    return {
      directory,
      grant,
      permission,
      stoppedBytes,
      stopped,
      held: held.held,
      writer,
      snapshot,
      replacement,
      resumeCommand: () =>
        command(
          'resume',
          1,
          f.save({
            schemaVersion: 1,
            kind: 'task-execution-resume',
            held: held.held,
            admission: input.admission,
          }),
        ),
    };
  }
  return { ...result, paused, integratedPause, writerHeld };
}

describe(
  'active task control and requirements in the original writer scope',
  { timeout: 20000 },
  () => {
    it('completes clarified requirements after prior integration with fresh planning, writer, checks and independent acceptance', async () => {
      const f = fixture(),
        p = await f.integratedPause(),
        a = f.service.activities,
        before = readFileSync(join(f.workspace, 'owner.cjs')),
        identity = lstatSync(join(f.workspace, 'owner.cjs')),
        intent = await a.planLocalIntegration(p.next, p.snapshot, p.writer, p.candidate.manifest);
      expect(f.read(intent)).toMatchObject({ changes: [], previousIntegration: p.run.integration });
      const integration = await a.integrateLocalTask(p.next, p.snapshot, intent),
        checked = await a.checkLocalTask(p.next, p.snapshot, 'integrated', p.writer, integration),
        packet = await a.prepareLocalAcceptance(
          p.next,
          p.snapshot,
          p.writer,
          p.candidate.manifest,
          intent,
          integration,
          checked.manifest,
          p.baseline.manifest,
        ),
        accepted = await runReview(f, packet),
        done = await a.finishLocalTask(p.next, p.snapshot, packet, accepted.manifest);
      expect(done.status).toBe('done');
      expect(checked.status).toBe('PASS');
      expect(readFileSync(join(f.workspace, 'owner.cjs'))).toEqual(before);
      expect(f.state.creates).toBe(2);
      expect(f.state.readers).toBe(6);
      const after = lstatSync(join(f.workspace, 'owner.cjs'));
      expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({
        ino: identity.ino,
        mtimeMs: identity.mtimeMs,
      });
      const archive = archiveFixture({ ...f, input: p.next }, done);
      expect((await archive.activity.archiveFinalizedTask(archive.input)).status).toBe('archived');
    });
    it('rejects an empty delta when the held chain has no successful primary integration', async () => {
      const base = substantialTaskFixture(),
        bytes = Buffer.from('module.exports = name => name.trim();\n');
      writeFileSync(join(base.workspace, 'owner.cjs'), bytes);
      base.proposal.owner.hash = digest(bytes);
      const plan = Buffer.from(JSON.stringify(base.proposal));
      writeFileSync(join(base.workspace, 'plan.json'), plan);
      base.substantialInput.admission.plan.sha256 = digest(plan);
      const f = fixture(base),
        { held } = await f.paused(),
        command = f.executionCommand(
          'resume',
          1,
          f.save({
            schemaVersion: 1,
            kind: 'task-execution-resume',
            held,
            admission: f.input.admission,
          }),
        ),
        next = await f.executionControls.resumeTaskExecution(f.input, held, command, 1),
        a = f.service.activities;
      await f.executionControls.prepareTaskExecution(next.input);
      const planning = await a.prepareSubstantialPlanning(next.input),
        reviewed = await runReview(f, planning),
        snapshot = await a.prepareLocalTask(next.input, reviewed.manifest);
      await a.checkLocalTask(next.input, snapshot, 'baseline', null, null);
      const writer = await a.writeLocalTask(next.input, snapshot),
        candidate = await a.checkLocalTask(next.input, snapshot, 'candidate', writer, null);
      expect(candidate.status).toBe('PASS');
      await expect(
        a.planLocalIntegration(next.input, snapshot, writer, candidate.manifest),
      ).rejects.toThrow('task-result-empty');
      await f.service.controls.stopLocalTask(next.input);
      expect(readFileSync(join(f.workspace, 'owner.cjs'))).toEqual(bytes);
    });
    it('follows multiple no-write continuations back to the original verified integration without repeating a source write', async () => {
      const f = fixture(),
        p = await f.integratedPause(),
        a = f.service.activities,
        intent = await a.planLocalIntegration(p.next, p.snapshot, p.writer, p.candidate.manifest),
        integration = await a.integrateLocalTask(p.next, p.snapshot, intent),
        pause = f.executionCommand('pause', 2, undefined, p.next),
        ack = await f.executionControls.interruptTaskExecution(p.next, pause, 2),
        stopped = await f.service.controls.stopLocalTask(p.next),
        outcome = await f.executionControls.holdTaskExecution(
          p.next,
          {
            phase: 'integrated-checks',
            snapshot: p.snapshot,
            planning: null,
            records: [intent, integration],
          },
          stopped,
          'Recheck the unchanged integrated result',
          ack,
        );
      if (outcome.status !== 'held') throw new Error('fixture-not-held');
      const resume = f.executionCommand(
          'resume',
          3,
          f.save({
            schemaVersion: 1,
            kind: 'task-execution-resume',
            held: outcome.held,
            admission: p.next.admission,
          }),
          p.next,
        ),
        next = await f.executionControls.resumeTaskExecution(p.next, outcome.held, resume, 3),
        before = lstatSync(join(f.workspace, 'owner.cjs'));
      await f.executionControls.prepareTaskExecution(next.input);
      const planning = await a.prepareSubstantialPlanning(next.input),
        reviewed = await runReview(f, planning),
        snapshot = await a.prepareLocalTask(next.input, reviewed.manifest);
      await a.checkLocalTask(next.input, snapshot, 'baseline', null, null);
      const writer = await a.writeLocalTask(next.input, snapshot),
        candidate = await a.checkLocalTask(next.input, snapshot, 'candidate', writer, null),
        chained = await a.planLocalIntegration(next.input, snapshot, writer, candidate.manifest);
      expect(f.read(chained)).toMatchObject({
        changes: [],
        previousIntegration: p.run.integration,
      });
      expect(f.read(intent)).toMatchObject({ previousIntegration: p.run.integration });
      expect(candidate.status).toBe('PASS');
      expect(lstatSync(join(f.workspace, 'owner.cjs')).ino).toBe(before.ino);
      expect(f.state.creates).toBe(3);
      expect(f.credits.size).toBe(9);
      await f.service.controls.stopLocalTask(next.input);
    });
    it.each([
      'stale-bytes',
      'stale-mode',
      'substituted-effect',
      'foreign-owner',
      'foreign-generation',
    ])('rejects an empty new delta with %s and publishes no new integration', async (defect) => {
      const f = fixture(),
        p = await f.integratedPause(),
        folder = join(
          f.workspace,
          '.git/agent-workflow/tasks',
          digest('aw/task/neutral/one'),
          'execution-attempts',
          '0',
        );
      if (defect === 'stale-bytes')
        writeFileSync(join(f.workspace, 'owner.cjs'), 'module.exports = name => name;\n');
      if (defect === 'stale-mode') chmodSync(join(f.workspace, 'owner.cjs'), 0o700);
      if (defect === 'substituted-effect')
        writeFileSync(join(folder, 'integration-receipt.json'), JSON.stringify(f.proof));
      if (defect === 'foreign-owner' || defect === 'foreign-generation') {
        const original = f.read(p.run.integration),
          foreign = f.save({
            ...original,
            input: {
              ...f.input,
              admission: {
                ...f.input.admission,
                preparation: {
                  ...f.input.admission.preparation,
                  ...(defect === 'foreign-owner'
                    ? { owner: 'foreign' }
                    : { generation: f.input.admission.preparation.generation + 1 }),
                },
              },
            },
          });
        writeFileSync(join(folder, 'integration-receipt.json'), JSON.stringify(foreign));
      }
      await expect(
        f.service.activities.planLocalIntegration(
          p.next,
          p.snapshot,
          p.writer,
          p.candidate.manifest,
        ),
      ).rejects.toThrow();
      expect(existsSync(join(folder, '../1/integration-intent.json'))).toBe(false);
      expect(existsSync(join(folder, '../1/integration-receipt.json'))).toBe(false);
      expect(f.state.creates).toBe(2);
    });
    it('does not mutate permission or create a command intent after cancellation is observed during human verification', async () => {
      const f = fixture();
      await f.executionControls.prepareTaskExecution(f.input);
      f.verify.mockImplementation(async (command) => {
        f.environment.cancel();
        return { origin: 'human', author: command.author, hash: command.hash, proof: f.proof };
      });
      await expect(
        f.executionControls.interruptTaskExecution(f.input, f.executionCommand('pause', 0), 0),
      ).rejects.toThrow();
      const folder = join(f.workspace, '.git/agent-workflow/tasks', digest('aw/task/neutral/one'));
      expect(existsSync(join(folder, 'execution-command-intents'))).toBe(false);
      expect(f.state.starts).toBe(0);
      expect(f.state.creates).toBe(0);
    });
    it('retains a lost acknowledgement as a single pending command and recovers only its original outcome', async () => {
      const f = fixture(),
        original = artifacts.publishFile;
      await f.executionControls.prepareTaskExecution(f.input);
      const command = f.executionCommand('pause', 0);
      const publish = vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
        if (path.includes('/execution-commands/')) throw new Error('lost-command-ack');
        original(path, bytes);
      });
      await expect(f.executionControls.interruptTaskExecution(f.input, command, 0)).rejects.toThrow(
        'lost-command-ack',
      );
      publish.mockRestore();
      await expect(
        f.executionControls.findTaskExecutionCommand(
          f.input,
          f.executionCommand('pause', 0, undefined, f.input, 'competing'),
        ),
      ).rejects.toThrow('task-command-pending');
      const ack = await f.executionControls.interruptTaskExecution(f.input, command, 0);
      expect(await f.executionControls.findTaskExecutionCommand(f.input, command)).toEqual(ack);
      expect(f.verify).toHaveBeenCalledTimes(2);
      expect(f.state.starts).toBe(0);
      expect(f.state.creates).toBe(0);
    });
    it('accepts a new cancel for a confirmed held writer under a replacement host without adopting its grant', async () => {
      const f = fixture(),
        p = await f.writerHeld(),
        replacement = p.replacement(),
        before = { starts: f.state.starts, creates: f.state.creates, credits: f.credits.size };
      expect(f.read(p.stopped)).toMatchObject({ confirmed: true, writer: p.writer.stop });
      expect(await replacement.controls.stopLocalTask(f.input)).toEqual(p.stopped);
      expect(replacement.admitted).toHaveBeenCalledExactlyOnceWith(
        f.input,
        expect.objectContaining({
          directory: p.directory,
          mode: 'retained',
          grant: { sha256: digest(p.grant), bytes: p.grant.length },
        }),
      );
      const cancel = f.executionCommand('cancel', 1),
        ack = await f.environment.run(() =>
          replacement.executionControls.interruptTaskExecution(f.input, cancel, 1),
        );
      expect(ack).toMatchObject({ commandId: cancel.commandId, revision: 2 });
      expect(
        await f.environment.run(() =>
          replacement.executionControls.interruptTaskExecution(f.input, cancel, 1),
        ),
      ).toEqual(ack);
      expect(await replacement.executionControls.findTaskExecutionCommand(f.input, cancel)).toEqual(
        ack,
      );
      expect(f.verify).toHaveBeenCalledTimes(2);
      expect(readFileSync(join(p.directory, 'grant.json'))).toEqual(p.grant);
      expect(readFileSync(join(p.directory, 'permission.json'))).toEqual(p.permission);
      expect(readFileSync(join(p.directory, 'stopped.json'))).toEqual(p.stoppedBytes);
      expect(existsSync(join(p.directory, 'permission-lock'))).toBe(false);
      expect({ starts: f.state.starts, creates: f.state.creates, credits: f.credits.size }).toEqual(
        before,
      );
    });
    it('records one retained RESUME under a replacement host and reuses its exact acknowledgement', async () => {
      const f = fixture(),
        p = await f.writerHeld(),
        replacement = p.replacement(),
        resume = p.resumeCommand(),
        before = { starts: f.state.starts, creates: f.state.creates, credits: f.credits.size };
      f.processes.alive.mockClear();
      const resumed = await f.environment.run(() =>
        replacement.executionControls.resumeTaskExecution(f.input, p.held, resume, 1),
      );
      const result = object(resumed),
        ack = object(result.ack);
      expect(ack).toMatchObject({
        commandId: resume.commandId,
        revision: 2,
        hash: resume.hash,
      });
      expect(result.input).toEqual({
        ...f.input,
        continuation: { attempt: 1, previous: ack.authorization },
      });
      expect(f.read(controlRef(ack.authorization))).toMatchObject({
        kind: 'task-execution-continuation',
        held: p.held,
        command: resume,
      });
      expect(f.processes.alive).toHaveBeenCalled();
      f.processes.alive.mockClear();
      // Re-delivery reads the retained outcome even if fresh observation would now refuse.
      f.state.alive = true;
      expect(
        await f.environment.run(() =>
          replacement.executionControls.resumeTaskExecution(f.input, p.held, resume, 1),
        ),
      ).toEqual(resumed);
      expect(f.processes.alive).not.toHaveBeenCalled();
      expect(f.verify).toHaveBeenCalledTimes(2);
      expect(readFileSync(join(p.directory, 'grant.json'))).toEqual(p.grant);
      expect(readFileSync(join(p.directory, 'permission.json'))).toEqual(p.permission);
      expect(readFileSync(join(p.directory, 'stopped.json'))).toEqual(p.stoppedBytes);
      expect(existsSync(join(p.directory, 'permission-lock'))).toBe(false);
      expect({ starts: f.state.starts, creates: f.state.creates, credits: f.credits.size }).toEqual(
        before,
      );
    });

    it.each([
      'copy-mutation',
      'live',
      'active-permission',
      'initial-grant',
      'late-held',
      'late-plan',
      'late-admission',
      'late-done',
      'cancelled',
    ])('rejects retained RESUME with %s before creating a new command intent', async (defect) => {
      const f = fixture(),
        p = await f.writerHeld(),
        replacement = p.replacement(),
        resume = p.resumeCommand(),
        before = { starts: f.state.starts, creates: f.state.creates, credits: f.credits.size };
      if (defect === 'copy-mutation')
        writeFileSync(
          join(String(object(f.read(p.snapshot).copy).root), 'owner.cjs'),
          'late write',
        );
      if (defect === 'live') f.state.alive = true;
      if (defect === 'active-permission')
        writeFileSync(
          join(p.directory, 'permission.json'),
          JSON.stringify({ ...JSON.parse(p.permission.toString()), active: true }),
        );
      if (defect === 'initial-grant')
        f.verify.mockImplementationOnce(async (command) => ({
          origin: 'initial-grant',
          author: command.author,
          hash: command.hash,
          proof: f.proof,
        }));
      const mutateDuringInspection = defect.startsWith('late-') || defect === 'cancelled';
      let reads = 0;
      if (mutateDuringInspection) {
        f.processes.alive.mockImplementation(async () => {
          if (++reads === 2) {
            if (defect === 'late-held')
              writeFileSync(join(p.directory, 'execution-held.json'), JSON.stringify(f.proof));
            if (defect === 'late-plan')
              writeFileSync(join(f.workspace, 'plan.json'), 'changed plan');
            if (defect === 'late-admission')
              writeFileSync(join(p.directory, 'execution-admission.json'), JSON.stringify(f.proof));
            if (defect === 'late-done')
              writeFileSync(join(p.directory, 'done.json'), JSON.stringify({ result: f.proof }));
            if (defect === 'cancelled') f.environment.cancel();
          }
          return [];
        });
      }
      await expect(
        f.environment.run(() =>
          replacement.executionControls.resumeTaskExecution(f.input, p.held, resume, 1),
        ),
      ).rejects.toThrow(
        defect === 'initial-grant' ? 'task-human-authorization-required' : undefined,
      );
      if (mutateDuringInspection) expect(reads).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(p.directory, '../../execution-command-intents/2.json'))).toBe(false);
      expect(existsSync(join(p.directory, '../../execution-commands/resume-1.json'))).toBe(false);
      expect(existsSync(join(p.directory, 'permission-lock'))).toBe(false);
      expect({ starts: f.state.starts, creates: f.state.creates, credits: f.credits.size }).toEqual(
        before,
      );
    });
    it.each(['copy', 'authority-proof', 'foreign-intent'])(
      'rejects retained RESUME when %s changes after the final writer observation',
      async (defect) => {
        const f = fixture(),
          p = await f.writerHeld(),
          replacement = p.replacement(),
          resume = p.resumeCommand(),
          proof = f.save({ kind: 'resume-authority' }),
          intent = join(p.directory, '../../execution-command-intents/2.json'),
          foreign = Buffer.from(
            JSON.stringify({ input: f.input, command: resume, authorization: f.proof }),
          );
        f.verify.mockImplementationOnce(async (command) => ({
          origin: 'human',
          author: command.author,
          hash: command.hash,
          proof,
        }));
        let observations = 0;
        let changed = false;
        f.processes.alive.mockImplementation(async (owned) => {
          if (owned.length > 0) observations++;
          if (!changed && observations === 3 && owned.length === 0) {
            changed = true;
            if (defect === 'copy')
              writeFileSync(
                join(String(object(f.read(p.snapshot).copy).root), 'owner.cjs'),
                'write after final writer observation',
              );
            if (defect === 'authority-proof')
              unlinkSync(join(f.registration.artifactRoot, proof.sha256));
            if (defect === 'foreign-intent') artifacts.publishFile(intent, foreign);
          }
          return [];
        });
        await expect(
          f.environment.run(() =>
            replacement.executionControls.resumeTaskExecution(f.input, p.held, resume, 1),
          ),
        ).rejects.toThrow();
        expect(changed).toBe(true);
        if (defect === 'foreign-intent') expect(readFileSync(intent)).toEqual(foreign);
        else expect(existsSync(intent)).toBe(false);
        expect(existsSync(join(p.directory, '../../execution-commands/resume-1.json'))).toBe(false);
        expect(existsSync(join(p.directory, 'permission-lock'))).toBe(false);
      },
    );
    it('finishes only the original legacy pending cancel after full retained-stop verification', async () => {
      const f = fixture(),
        p = await f.writerHeld(),
        cancel = f.executionCommand('cancel', 1),
        verified = await f.verify(cancel);
      // Emulate the historical order proven by the primary RED: verified intent before the strict foreign freeze.
      artifacts.publishFile(
        join(p.directory, '../../execution-command-intents/2.json'),
        Buffer.from(
          JSON.stringify({ input: f.input, command: cancel, authorization: verified.proof }),
        ),
      );
      const legacy = gates.taskGate(
        f.input,
        taskFiles(f.registration.artifactRoot).binding(f.workspace),
        f.profile,
        f.registration.artifactRoot,
        'replacement-host',
      );
      expect(() => legacy.freeze()).toThrow('task-grant-conflict');
      const intent = join(p.directory, '../../execution-command-intents/2.json'),
        before = readFileSync(intent),
        replacement = p.replacement(),
        competing = f.executionCommand('cancel', 1, undefined, f.input, 'different-cancel'),
        resume = f.executionCommand(
          'resume',
          1,
          f.save({
            schemaVersion: 1,
            kind: 'task-execution-resume',
            held: p.held,
            admission: f.input.admission,
          }),
        ),
        starts = { starts: f.state.starts, creates: f.state.creates, credits: f.credits.size };
      await expect(
        f.environment.run(() =>
          replacement.executionControls.interruptTaskExecution(f.input, competing, 1),
        ),
      ).rejects.toThrow('task-command-pending');
      await expect(
        f.environment.run(() =>
          replacement.executionControls.resumeTaskExecution(f.input, p.held, resume, 1),
        ),
      ).rejects.toThrow('task-command-pending');
      f.verify.mockImplementationOnce(async (command) => ({
        origin: 'initial-grant',
        author: command.author,
        hash: command.hash,
        proof: f.proof,
      }));
      await expect(
        f.environment.run(() =>
          replacement.executionControls.interruptTaskExecution(f.input, cancel, 1),
        ),
      ).rejects.toThrow('task-human-authorization-required');
      expect(readFileSync(intent)).toEqual(before);
      expect(existsSync(join(p.directory, '../../execution-commands/cancel-1.json'))).toBe(false);
      f.verify.mockImplementationOnce(async (command) => ({
        origin: 'human',
        author: command.author,
        hash: command.hash,
        proof: f.save({ kind: 'substituted-primary-authorization' }),
      }));
      await expect(
        f.environment.run(() =>
          replacement.executionControls.interruptTaskExecution(f.input, cancel, 1),
        ),
      ).rejects.toThrow('task-human-authorization-required');
      expect(readFileSync(intent)).toEqual(before);
      const ack = await f.environment.run(() =>
        replacement.executionControls.interruptTaskExecution(f.input, cancel, 1),
      );
      expect(ack).toMatchObject({ commandId: cancel.commandId, hash: cancel.hash, revision: 2 });
      expect(readFileSync(intent)).toEqual(before);
      expect(f.verify).toHaveBeenCalledTimes(5);
      expect(readFileSync(join(p.directory, 'grant.json'))).toEqual(p.grant);
      expect(readFileSync(join(p.directory, 'permission.json'))).toEqual(p.permission);
      expect(readFileSync(join(p.directory, 'stopped.json'))).toEqual(p.stoppedBytes);
      expect({ starts: f.state.starts, creates: f.state.creates, credits: f.credits.size }).toEqual(
        starts,
      );
    });
    it.each([
      'pause',
      'live',
      'missing-stop',
      'missing-held',
      'foreign-held',
      'foreign-stop',
      'active-permission',
      'foreign-reservation',
      'changed-grant',
      'missing-runtime',
      'missing-check-intent',
      'copy-mutation',
      'foreign-host',
      'late-live',
      'late-held',
      'late-reservation',
      'cancel-during-inspection',
    ])(
      'rejects retained metadata cancellation with %s before a new command intent',
      async (defect) => {
        const f = fixture(),
          p = await f.writerHeld(),
          before = { starts: f.state.starts, creates: f.state.creates, credits: f.credits.size },
          path = (name: string) => join(p.directory, name),
          source = join(f.workspace, '.git/agent-workflow/source-reservation');
        if (defect === 'live') f.state.alive = true;
        if (defect === 'missing-stop') unlinkSync(path('stopped.json'));
        if (defect === 'missing-held') unlinkSync(path('execution-held.json'));
        if (defect === 'foreign-held')
          writeFileSync(
            path('execution-held.json'),
            JSON.stringify(
              f.save({
                ...f.read(p.held),
                input: { ...f.input, continuation: { attempt: 9, previous: null } },
              }),
            ),
          );
        if (defect === 'foreign-stop') writeFileSync(path('stopped.json'), JSON.stringify(f.proof));
        if (defect === 'active-permission')
          writeFileSync(
            path('permission.json'),
            JSON.stringify({ ...JSON.parse(p.permission.toString()), active: true }),
          );
        if (defect === 'foreign-reservation')
          writeFileSync(source, 'another task owns this source');
        if (defect === 'changed-grant')
          writeFileSync(
            path('grant.json'),
            JSON.stringify({ ...JSON.parse(p.grant.toString()), artifactRoot: 'foreign' }),
          );
        if (defect === 'missing-runtime') unlinkSync(path('writer-runtime.json'));
        if (defect === 'missing-check-intent') unlinkSync(path('checks-baseline-intent.json'));
        if (defect === 'copy-mutation')
          writeFileSync(
            join(String(object(f.read(p.snapshot).copy).root), 'owner.cjs'),
            'late mutation',
          );
        if (defect.startsWith('late-') || defect === 'cancel-during-inspection') {
          let reads = 0;
          f.processes.alive.mockImplementation(async (owned) => {
            if (++reads === 2) {
              if (defect === 'late-live') f.state.alive = true;
              if (defect === 'late-held')
                writeFileSync(path('execution-held.json'), JSON.stringify(f.proof));
              if (defect === 'late-reservation') writeFileSync(source, 'foreign source owner');
              if (defect === 'cancel-during-inspection') f.environment.cancel();
            }
            return f.state.alive ? owned : [];
          });
        }
        const replacement =
            defect === 'foreign-host'
              ? localTaskActivities(
                  { ...f.registration, hostId: 'foreign' },
                  f.host,
                  f.rpc,
                  f.profile,
                  f.consume,
                  { instance: 'replacement-host', admitted: vi.fn() },
                )
              : p.replacement(),
          command = f.executionCommand(defect === 'pause' ? 'pause' : 'cancel', 1);
        await expect(
          f.environment.run(() =>
            replacement.executionControls.interruptTaskExecution(f.input, command, 1),
          ),
        ).rejects.toThrow();
        expect(existsSync(join(p.directory, '../../execution-command-intents/2.json'))).toBe(false);
        expect(existsSync(join(p.directory, '../../execution-commands/cancel-1.json'))).toBe(false);
        expect(existsSync(path('permission-lock'))).toBe(false);
        expect({
          starts: f.state.starts,
          creates: f.state.creates,
          credits: f.credits.size,
        }).toEqual(before);
      },
    );
    it('rejects an owned admission with a former uninstalled grant revocation before reserving a command', async () => {
      const f = fixture(),
        { stopped } = await f.paused(),
        admitted = vi.fn(),
        replacement = localTaskActivities(f.registration, f.host, f.rpc, f.profile, f.consume, {
          instance: 'replacement-host',
          admitted,
        }),
        cancel = f.executionCommand('cancel', 1),
        directory = join(
          f.workspace,
          '.git/agent-workflow/tasks',
          digest('aw/task/neutral/one'),
          'execution-attempts/0',
        ),
        permission = readFileSync(join(directory, 'revoked.json'));
      expect(f.read(stopped)).toMatchObject({ kind: 'task-not-started', confirmed: true });
      expect(existsSync(join(directory, 'grant.json'))).toBe(false);
      await expect(
        f.environment.run(() =>
          replacement.executionControls.interruptTaskExecution(f.input, cancel, 1),
        ),
      ).rejects.toThrow('task-grant-conflict');
      expect(admitted).toHaveBeenCalledWith(f.input, expect.objectContaining({ mode: 'owned' }));
      expect(existsSync(join(directory, '../../execution-command-intents/2.json'))).toBe(false);
      expect(readFileSync(join(directory, 'revoked.json'))).toEqual(permission);
      const permitted = f.executionCommand(
        'cancel',
        1,
        undefined,
        f.input,
        'cancel-by-original-instance',
      );
      expect(await f.executionControls.interruptTaskExecution(f.input, permitted, 1)).toMatchObject(
        { commandId: permitted.commandId, revision: 2 },
      );
      expect(f.state.creates).toBe(0);
      expect(f.state.starts).toBe(0);
      expect(f.credits.size).toBe(0);
    });
    it('observes Activity cancellation after owned freeze guards and before any new command intent', async () => {
      const f = fixture(),
        factory = gates.taskGate;
      const injected = vi.spyOn(gates, 'taskGate').mockImplementation((...args) => {
        const gate = factory(...args);
        function freeze(before?: () => void) {
          gate.freeze(
            before === undefined
              ? undefined
              : () => {
                  f.environment.cancel();
                  before();
                },
          );
        }
        return { ...gate, freeze };
      });
      await f.executionControls.prepareTaskExecution(f.input);
      const command = f.executionCommand('pause', 0),
        directory = join(f.workspace, '.git/agent-workflow/tasks', digest('aw/task/neutral/one'));
      await expect(
        f.executionControls.interruptTaskExecution(f.input, command, 0),
      ).rejects.toThrow();
      injected.mockRestore();
      expect(existsSync(join(directory, 'execution-command-intents'))).toBe(false);
      expect(existsSync(join(directory, 'execution-attempts/0/revoked.json'))).toBe(false);
      const next = localTaskActivities(f.registration, f.host, f.rpc, f.profile, f.consume, {
          instance: 'unit-host',
          admitted: vi.fn(),
        }),
        fresh = new MockActivityEnvironment(),
        permitted = f.executionCommand('pause', 0, undefined, f.input, 'allowed-next');
      expect(
        await fresh.run(() => next.executionControls.interruptTaskExecution(f.input, permitted, 0)),
      ).toMatchObject({ commandId: permitted.commandId, revision: 1 });
      expect(f.state.creates).toBe(0);
      expect(f.state.starts).toBe(0);
      expect(f.credits.size).toBe(0);
    });
    it('propagates a command-intent disk failure before revocation and permits only a newly verified retry', async () => {
      const f = fixture(),
        publish = artifacts.publishFile;
      await f.executionControls.prepareTaskExecution(f.input);
      const command = f.executionCommand('pause', 0),
        injected = vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
          if (path.includes('/execution-command-intents/'))
            throw Object.assign(new Error('command intent disk full'), { code: 'ENOSPC' });
          publish(path, bytes);
        });
      await expect(f.executionControls.interruptTaskExecution(f.input, command, 0)).rejects.toThrow(
        'command intent disk full',
      );
      injected.mockRestore();
      const directory = join(
        f.workspace,
        '.git/agent-workflow/tasks',
        digest('aw/task/neutral/one'),
        'execution-attempts/0',
      );
      expect(existsSync(join(directory, 'revoked.json'))).toBe(false);
      expect(await f.executionControls.findTaskExecutionCommand(f.input, command)).toBeNull();
      expect((await f.executionControls.interruptTaskExecution(f.input, command, 0)).revision).toBe(
        1,
      );
      expect(f.verify).toHaveBeenCalledTimes(2);
      expect(f.state.starts).toBe(0);
      expect(f.state.creates).toBe(0);
    });
    it.each(['next-admission', 'authority-ref', 'interruption-reason'])(
      'rejects a substituted durable command outcome: %s',
      async (defect) => {
        const f = fixture(),
          { held, pause } = await f.paused(),
          resume = f.executionCommand(
            'resume',
            1,
            f.save({
              schemaVersion: 1,
              kind: 'task-execution-resume',
              held,
              admission: f.input.admission,
            }),
          );
        await f.executionControls.resumeTaskExecution(f.input, held, resume, 1);
        const command = defect === 'interruption-reason' ? pause : resume,
          path = join(
            f.workspace,
            '.git/agent-workflow/tasks',
            digest('aw/task/neutral/one'),
            'execution-commands',
            command.commandId + '.json',
          ),
          record = object(JSON.parse(readFileSync(path).toString()));
        if (defect === 'next-admission')
          object(object(object(record.next).admission).preparation).owner = 'other';
        if (defect !== 'next-admission') {
          const proof = f.read(controlRef(object(record.ack).authorization));
          object(record.ack).authorization = f.save({
            ...proof,
            ...(defect === 'authority-ref'
              ? { authorization: f.save({ substituted: true }) }
              : { reason: 'substituted reason' }),
          });
        }
        writeFileSync(path, JSON.stringify(record));
        await expect(
          f.executionControls.findTaskExecutionCommand(f.input, command),
        ).rejects.toThrow('task-command-receipt-invalid');
        expect(f.state.creates).toBe(0);
        expect(f.state.starts).toBe(0);
      },
    );
    it('pins the complete command journal, original start and spent budget before rollover and refuses rewound credits', async () => {
      const f = fixture(),
        { held, ack, pause, stopped } = await f.paused();
      f.consume(digest('reserved-unknown-turn'), digest('original-request'));
      const budget = await f.executionControls.captureTaskExecutionBudget(f.input, null),
        checkpointInput = {
          initial: f.input,
          input: f.input,
          revision: 1,
          held,
          history: [held],
          commands: [ack.authorization],
          previous: null,
          budget,
          beganAt: 42,
          diagnostics: [{ phase: 'stop-unknown', error: 'original stop uncertainty' }],
        },
        checkpoint = await f.executionControls.saveTaskExecutionCheckpoint(checkpointInput),
        restored = await f.executionControls.loadTaskExecutionCheckpoint(f.input, checkpoint);
      expect(restored).toMatchObject({
        initial: f.input,
        input: f.input,
        revision: 1,
        held,
        stop: stopped,
        beganAt: 42,
        diagnostics: [{ phase: 'stop-unknown', error: 'original stop uncertainty' }],
        budget: { limit: 15, used: 1 },
      });
      const nextCheckpoint = await f.executionControls.saveTaskExecutionCheckpoint({
          ...checkpointInput,
          previous: checkpoint,
        }),
        nextRestored = await f.executionControls.loadTaskExecutionCheckpoint(
          f.input,
          nextCheckpoint,
        );
      expect(nextRestored).toMatchObject({
        initial: f.input,
        previous: checkpoint,
        beganAt: 42,
        budget: { limit: 15, used: 1 },
      });
      await expect(
        f.executionControls.saveTaskExecutionCheckpoint({
          ...checkpointInput,
          previous: checkpoint,
          beganAt: 43,
        }),
      ).rejects.toThrow('task-checkpoint-prefix-invalid');
      expect(await f.executionControls.findTaskExecutionCommand(f.input, pause)).toEqual(ack);
      await expect(
        f.executionControls.loadTaskExecutionCheckpoint(
          { ...f.input, baseline: 'other' },
          checkpoint,
        ),
      ).rejects.toThrow('task-checkpoint-invalid');
      const bytes = readFileSync(join(f.budgetDirectory, '0.credit'));
      unlinkSync(join(f.budgetDirectory, '0.credit'));
      await expect(
        f.executionControls.loadTaskExecutionCheckpoint(f.input, checkpoint),
      ).rejects.toThrow('task-budget-rewound');
      writeFileSync(join(f.budgetDirectory, '0.credit'), bytes);
      expect(
        (await f.executionControls.loadTaskExecutionCheckpoint(f.input, checkpoint)).budget.used,
      ).toBe(1);
      expect(f.state.starts).toBe(0);
      expect(f.state.creates).toBe(0);
    });
    it('revokes before a first writer, deduplicates commands and requires a separate exact RESUME payload', async () => {
      const f = fixture(),
        { pause, ack, held } = await f.paused();
      expect(await f.executionControls.findTaskExecutionCommand(f.input, pause)).toEqual(ack);
      expect(await f.executionControls.interruptTaskExecution(f.input, pause, 0)).toEqual(ack);
      await expect(
        f.executionControls.findTaskExecutionCommand(f.input, { ...pause, hash: 'a'.repeat(64) }),
      ).rejects.toThrow('task-command-id-conflict');
      await expect(f.service.activities.prepareSubstantialPlanning(f.input)).rejects.toThrow(
        'task-already-closed',
      );
      const resume = f.executionCommand(
          'resume',
          1,
          f.save({
            schemaVersion: 1,
            kind: 'task-execution-resume',
            held,
            admission: f.input.admission,
          }),
        ),
        continued = await f.executionControls.resumeTaskExecution(f.input, held, resume, 1);
      expect(await f.executionControls.resumeTaskExecution(f.input, held, resume, 1)).toEqual(
        continued,
      );
      expect(continued.input.continuation.attempt).toBe(1);
      expect(f.verify).toHaveBeenCalledTimes(2);
      expect(f.read(continued.ack.authorization)).toMatchObject({
        input: f.input,
        held,
        invalidated: [
          'planning',
          'baseline',
          'writer',
          'candidate-checks',
          'integration',
          'integrated-checks',
          'acceptance',
          'result',
        ],
      });
      expect(f.state.creates).toBe(0);
      expect(f.state.starts).toBe(0);
    });
    it('holds a real stopped writer, preserves its candidate and reruns fresh planning, writer, checks and acceptance for clarified requirements', async () => {
      const f = fixture(),
        seal = await f.executionControls.prepareTaskExecution(f.input),
        planning = await f.service.activities.prepareSubstantialPlanning(f.input),
        approved = await runReview(f, planning),
        snapshot = await f.service.activities.prepareLocalTask(f.input, approved.manifest),
        baseline = await f.service.activities.checkLocalTask(
          f.input,
          snapshot,
          'baseline',
          null,
          null,
        ),
        writer = await f.service.activities.writeLocalTask(f.input, snapshot);
      const pause = f.executionCommand('pause', 0),
        ack = await f.executionControls.interruptTaskExecution(f.input, pause, 0),
        stopped = await f.service.controls.stopLocalTask(f.input),
        outcome = await f.executionControls.holdTaskExecution(
          f.input,
          {
            phase: 'writing',
            snapshot,
            planning,
            records: [
              seal,
              approved.manifest,
              baseline.manifest,
              writer.answer,
              writer.stop,
              writer.tree,
            ],
          },
          stopped,
          'requirements clarification',
          ack,
        );
      if (outcome.status !== 'held') throw new Error('fixture-not-held');
      const previous = f.read(snapshot),
        oldCopy = String((previous.copy as { root: string }).root),
        candidate = readFileSync(join(oldCopy, 'owner.cjs'));
      const bytes = Buffer.from(
        JSON.stringify({
          ...f.proposal,
          criterion: 'Trim surrounding spaces and preserve ordinary names after clarification',
        }),
      );
      writeFileSync(join(f.workspace, 'plan.json'), bytes);
      const admission = {
          ...f.input.admission,
          plan: { ...f.input.admission.plan, sha256: digest(bytes) },
          preparation: { ...f.input.admission.preparation, revision: 2 },
        },
        resume = f.executionCommand(
          'resume',
          1,
          f.save({
            schemaVersion: 1,
            kind: 'task-execution-resume',
            held: outcome.held,
            admission,
          }),
        ),
        continued = await f.executionControls.resumeTaskExecution(f.input, outcome.held, resume, 1);
      if (continued.input.schemaVersion !== 11) throw new Error('fixture-requires-schema11');
      await f.executionControls.prepareTaskExecution(continued.input);
      const nextPlanning = await f.service.activities.prepareSubstantialPlanning(continued.input);
      expect(nextPlanning.reviewId).not.toBe(planning.reviewId);
      const nextApproved = await runReview(f, nextPlanning),
        run = await throughIntegration(f, continued.input, nextApproved.manifest),
        accepted = await acceptance(f, run),
        done = await f.service.activities.finishLocalTask(
          continued.input,
          run.snapshot,
          run.packet,
          accepted.manifest,
        );
      expect(done.status).toBe('done');
      const terminalStop = await f.service.controls.stopLocalTask(continued.input);
      expect(
        await f.executionControls.holdTaskExecution(
          continued.input,
          {
            phase: 'finishing',
            snapshot: run.snapshot,
            planning: nextPlanning,
            records: [done.result],
          },
          terminalStop,
          'late cancellation',
          null,
        ),
      ).toEqual(done);
      expect(f.state.creates).toBe(2);
      expect(f.state.readers).toBe(6);
      expect(f.consume).toHaveBeenCalledTimes(6);
      expect(f.credits.size).toBe(6);
      expect(readFileSync(join(oldCopy, 'owner.cjs'))).toEqual(candidate);
      expect(f.read(run.snapshot).copy).not.toEqual(previous.copy);
      expect(existsSync(oldCopy)).toBe(true);
      await expect(
        f.executionControls.interruptTaskExecution(
          continued.input,
          f.executionCommand('cancel', 2, undefined, continued.input),
          2,
        ),
      ).rejects.toThrow('task-already-closed');
    });
    it.each(['hash', 'initial-grant', 'held', 'scope', 'revision', 'writer-scope', 'kind'])(
      'rejects %s without another writer or grant',
      async (defect) => {
        const f = fixture(),
          { held } = await f.paused();
        let admission = f.input.admission,
          heldRef = held;
        if (defect === 'initial-grant')
          f.verify.mockImplementation(async (command) => ({
            origin: 'initial-grant',
            author: command.author,
            hash: command.hash,
            proof: f.proof,
          }));
        if (defect === 'held') heldRef = f.proof;
        if (defect === 'scope')
          admission = { ...admission, preparation: { ...admission.preparation, owner: 'other' } };
        if (defect === 'revision')
          admission = { ...admission, plan: { ...admission.plan, sha256: 'a'.repeat(64) } };
        if (defect === 'writer-scope') {
          const bytes = Buffer.from(
            JSON.stringify({ ...f.proposal, paths: ['owner.cjs', 'consumer.cjs'] }),
          );
          writeFileSync(join(f.workspace, 'plan.json'), bytes);
          admission = {
            ...admission,
            plan: { ...admission.plan, sha256: digest(bytes) },
            preparation: { ...admission.preparation, revision: 2 },
          };
        }
        let command = f.executionCommand(
          'resume',
          1,
          f.save({
            schemaVersion: 1,
            kind: defect === 'kind' ? 'task-planning-resume' : 'task-execution-resume',
            held: heldRef,
            admission,
          }),
        );
        if (defect === 'hash') command = { ...command, hash: '0'.repeat(64) };
        await expect(
          f.executionControls.resumeTaskExecution(f.input, held, command, 1),
        ).rejects.toThrow();
        expect(f.state.creates).toBe(0);
        expect(f.state.starts).toBe(0);
      },
    );
  },
);

it('admits only the explicitly configured initial-grant origin for managed pause and resume', async () => {
  const f = fixture(undefined, 'initial-grant');
  f.verify.mockImplementation(async (command) => ({
    origin: 'initial-grant',
    author: command.author,
    hash: command.hash,
    proof: f.proof,
  }));
  const paused = await f.paused();
  const resume = f.executionCommand(
    'resume',
    1,
    f.save({
      schemaVersion: 1,
      kind: 'task-execution-resume',
      held: paused.held,
      admission: f.input.admission,
    }),
  );
  const outcome = await f.executionControls.resumeTaskExecution(f.input, paused.held, resume, 1);
  expect(outcome.input.continuation.attempt).toBe(1);
  expect(outcome.ack).toMatchObject({ hash: resume.hash, revision: 2 });
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(f.credits.size).toBe(0);
});
it.each(['human', 'author', 'hash', 'proof'] as const)(
  'refuses a mismatched %s under explicit initial-grant execution authority',
  async (defect) => {
    const f = fixture(undefined, 'initial-grant');
    await f.executionControls.prepareTaskExecution(f.input);
    f.verify.mockImplementation(async (command) => ({
      origin: defect === 'human' ? 'human' : 'initial-grant',
      author: defect === 'author' ? 'other' : command.author,
      hash: defect === 'hash' ? '0'.repeat(64) : command.hash,
      proof: defect === 'proof' ? { sha256: '0'.repeat(64), bytes: 1 } : f.proof,
    }));
    await expect(
      f.executionControls.interruptTaskExecution(f.input, f.executionCommand('pause', 0), 0),
    ).rejects.toThrow();
    expect(f.credits.size).toBe(0);
  },
);
