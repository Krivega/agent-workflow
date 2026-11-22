import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { object } from '../../src/contracts/project.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TaskHumanCommandContext,
  TaskHumanFinishRequest,
} from '../../src/contracts/taskHuman.js';
import { taskHumanLocalFixture } from './taskHumanLocalFixture.js';
import { acceptance, runReview, throughIntegration } from './localTaskRun.js';
import { closeTaskHuman, createTaskHumanState } from '../../src/policy/taskHuman.js';
import type { LocalTaskInput } from '../../src/contracts/localTask.js';
import { prepareTaskStartAdmission } from '../../src/adapters/project/taskStartAdmission.js';
import { makeTaskExecutionCommand } from '../../src/client/taskExecution.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { advanceTaskHumanRequirements } from '../../src/policy/taskHuman.js';
import { taskAdmissionIdentity } from '../../src/policy/taskRecovery.js';
import { localTaskKey, parseLocalTask } from '../../src/policy/localTask.js';
import type { ReaderProjectHost } from '../../src/worker/readerHost.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerExecution } from '../../src/policy/readerExecution.js';
import { parseReaderInput, readerKey, readerTarget } from '../../src/policy/readerControl.js';
import { localTaskFixture } from './localTaskFixture.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import * as taskGates from '../../src/adapters/project/taskGate.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { taskBackendHome, reserveTaskBackend } from '../../src/adapters/project/taskBackend.js';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { recoverReaderHost } from '../../src/worker/readerRecovery.js';
import * as taskRecovery from '../../src/worker/taskRecovery.js';
import * as permission from '../../src/adapters/project/taskPermissionLock.js';
import * as files from '../../src/adapters/artifacts/files.js';

// Candidate-only real FS / canonical recovery tests. Process.kill(0) ESRCH is SYNTHETIC.
// These do not qualify actual process death, installed consumers, Native UI, or SDK/CAN.
afterEach(() => vi.restoreAllMocks());
async function interruptedAfterAcquire(
  nextRequirements = false,
  committed = false,
  unlockBeforeCrash = false,
) {
  const base = await taskHumanLocalFixture(false);
  function owned(id: string) {
    const root = files.privateDirectory(join(base.root, id));
    const admissions = files.privateDirectory(join(root, 'task-admissions-v2', id));
    files.privateDirectory(join(root, 'admissions'));
    files.privateDirectory(
      join(root, files.digest(base.registration.project.projectId), 'permissions'),
    );
    const ownerFile = join(root, 'host-owner');
    files.publishFile(
      ownerFile,
      Buffer.from(JSON.stringify({ pid: process.pid, id, tasks: true, taskBindings: 3 })),
    );
    const inputs: LocalTaskInput[] = [];
    const owner = permission.taskHostPermissionOwner(root, base.registration.artifactRoot, id);
    const service = base.makeHumanService(id, {
      owner,
      admitted(input, gate) {
        if (!inputs.some((prior) => taskAdmissionIdentity(prior) === taskAdmissionIdentity(input)))
          inputs.push(structuredClone(input));
        const path = join(admissions, files.digest(taskAdmissionIdentity(input)));
        const bytes = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            host: { pid: process.pid, id },
            input,
            gate,
          }),
        );
        if (existsSync(path)) expect(readFileSync(path)).toEqual(bytes);
        else files.publishFile(path, bytes);
      },
    });
    return { id, root, admissions, ownerFile, owner, service, inputs };
  }
  const former = owned('former-completion-host');
  const f = { ...base, service: former.service };
  async function technical() {
    await f.service.executionControls.prepareTaskExecution(f.input);
    const manifest = await f.service.humanActivities.prepareTaskHuman(f.input);
    const planning = await f.service.activities.prepareSubstantialPlanning(f.input);
    const approved = await runReview(f, planning);
    const run = await throughIntegration(f, f.input, approved.manifest);
    const accepted = await acceptance(f, run);
    expect(accepted.complete).toBe(true);
    const stopped = await f.service.controls.stopLocalTask(f.input);
    const context: TaskHumanCommandContext = {
      input: f.input,
      state: createTaskHumanState(manifest),
      technical: {
        input: f.input,
        snapshot: run.snapshot,
        packet: run.packet,
        acceptance: accepted.manifest,
        stopped,
        records: [
          planning.request,
          approved.manifest,
          run.snapshot,
          run.intent,
          run.integration,
          run.checked.manifest,
          run.packet.request,
          accepted.manifest,
        ],
      },
    };
    return { context, run, manifest };
  }
  let ready = await technical();
  if (nextRequirements) {
    const previousInput = f.input,
      previousState = ready.context.state;
    const cardPath = join(f.workspace, previousInput.admission.preparation.card);
    writeFileSync(
      cardPath,
      readFileSync(cardPath, 'utf8') +
        '- [ ] T2: Сохранить подтверждённый результат после восстановления\n',
    );
    const preparation = {
      ...previousInput.admission.preparation,
      revision: previousInput.admission.preparation.revision + 1,
    };
    const declaration = await prepareTaskStartAdmission(f.registration, f.startAuthority, {
      preparation,
      previous: previousInput.startAdmission,
      human: [],
      inapplicable: [],
    });
    f.proposal.requirement.hash = files.digest(readFileSync(cardPath));
    f.proposal.owner.hash = files.digest(readFileSync(join(f.workspace, f.proposal.owner.locator)));
    const planBytes = Buffer.from(JSON.stringify(f.proposal));
    writeFileSync(join(f.workspace, previousInput.admission.plan.path), planBytes);
    const admission = {
      ...previousInput.admission,
      preparation,
      plan: { ...previousInput.admission.plan, sha256: files.digest(planBytes) },
    };
    const command = makeTaskExecutionCommand({
      schemaVersion: 2,
      commandId: 'real-requirements-resume',
      target: taskControlTarget(previousInput),
      expectedRevision: 0,
      author: preparation.owner,
      source: f.proof,
      action: 'resume',
      attempt: 1,
      payload: f.save({
        schemaVersion: 2,
        kind: 'task-human-wait-resume',
        admission,
        startAdmission: declaration.ref,
      }),
    });
    const resumed = await f.service.humanActivities.controlTaskHumanExecution(
      ready.context,
      command,
      0,
    );
    f.input = resumed.input;
    ready = await technical();
    ready.context.state = advanceTaskHumanRequirements(previousState, {
      kind: 'verified-task-human-requirements',
      commandId: 'requirements-2',
      hash: ready.manifest.ref.sha256,
      previousManifest: previousState.current.ref,
      next: ready.manifest,
      expectedRevision: previousState.revision,
      source: f.input.startAdmission,
      proof: ready.manifest.ref,
    });
    expect(
      former.inputs.map((input) => (input.schemaVersion === 12 ? input.continuation.attempt : -1)),
    ).toEqual([0, 1]);
    expect(localTaskKey(previousInput)).toBe(localTaskKey(f.input));
  }
  const { context, run } = ready;
  const request: TaskHumanFinishRequest = {
    schemaVersion: 1,
    kind: 'task-human-finish',
    ...context,
    state: closeTaskHuman(context.state, context.state.revision),
    expectedRevision: context.state.revision,
  };
  const directory = join(
    f.workspace,
    '.git/agent-workflow/tasks',
    files.digest(localTaskKey(f.input)),
    'execution-attempts/' + f.input.continuation.attempt,
  );
  const reservation = join(f.workspace, '.git/agent-workflow/source-reservation');
  const lockPath = join(directory, 'permission-lock');
  const original = permission.taskPermissionLock;
  let armed = true;
  const capturedScopes: Parameters<typeof permission.taskPermissionLock>[0][] = [];
  const fault = vi.spyOn(permission, 'taskPermissionLock').mockImplementation((scope, owner) => {
    const lock = original(scope, owner);
    return {
      ...lock,
      release() {
        if (
          armed &&
          scope.directory === directory &&
          existsSync(reservation) &&
          object(JSON.parse(readFileSync(reservation, 'utf8')) as unknown).kind ===
            'task-human-completion' &&
          (!committed || existsSync(join(directory, 'done.json')))
        ) {
          armed = false;
          capturedScopes.push(scope);
          if (unlockBeforeCrash) lock.release();
          throw new Error('synthetic crash boundary after actual completion acquire');
        }
        lock.release();
      },
    };
  });
  await expect(f.service.humanActivities.finishTaskHuman(request)).rejects.toThrow();
  fault.mockRestore();
  expect(armed).toBe(false);
  expect(existsSync(lockPath)).toBe(!unlockBeforeCrash);
  if (!unlockBeforeCrash) expect(lstatSync(lockPath).isFile()).toBe(true);
  const token = readFileSync(reservation);
  expect(object(JSON.parse(token.toString()) as unknown)).toMatchObject({
    schemaVersion: 2,
    owner: former.owner.ref,
  });
  expect(capturedScopes).toHaveLength(1);
  const scope = capturedScopes[0]!;
  const sealPointer = join(
    f.workspace,
    '.git/agent-workflow/tasks',
    files.digest(localTaskKey(f.input)),
    'human-completion',
    run.snapshot.sha256 + '.json',
  );
  const seal = JSON.parse(readFileSync(sealPointer, 'utf8')) as typeof f.proof;
  expect(f.read(seal)).toMatchObject({
    kind: 'task-human-completion-seal',
    request,
  });
  expect(existsSync(join(directory, 'completion-intent.json'))).toBe(committed);
  expect(existsSync(join(directory, 'done.json'))).toBe(committed);
  const priorIntent = committed ? readFileSync(join(directory, 'completion-intent.json')) : null;
  const priorDone = committed ? readFileSync(join(directory, 'done.json')) : null;
  const card = join(f.workspace, f.input.admission.preparation.card);
  const beforeCard = readFileSync(card);
  const permissionBefore = readFileSync(join(directory, 'permission.json'));
  const counts = {
    creates: f.state.creates,
    starts: f.state.starts,
    readers: f.state.readers,
  };
  const projects: ReaderProjectHost[] = [
    {
      registration: f.registration,
      rpc: f.rpc,
      authority: f.authority,
      localTasks: f.host,
    },
  ];
  const dead = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('SYNTHETIC_ESRCH_NOT_NATIVE_PROOF'), {
      code: 'ESRCH',
    });
  });
  function noWorkOrProjection(observedCard = card) {
    expect({
      creates: f.state.creates,
      starts: f.state.starts,
      readers: f.state.readers,
    }).toEqual(counts);
    expect(readFileSync(observedCard)).toEqual(beforeCard);
    if (priorDone === null) expect(existsSync(join(directory, 'done.json'))).toBe(false);
    else expect(readFileSync(join(directory, 'done.json'))).toEqual(priorDone);
    if (priorIntent === null)
      expect(existsSync(join(directory, 'completion-intent.json'))).toBe(false);
    else expect(readFileSync(join(directory, 'completion-intent.json'))).toEqual(priorIntent);
  }
  return {
    ...f,
    former,
    owned,
    request,
    directory,
    reservation,
    lockPath,
    token,
    scope,
    seal,
    card,
    beforeCard,
    permissionBefore,
    counts,
    projects,
    dead,
    noWorkOrProjection,
    priorDone,
    priorIntent,
    recover: () => recoverReaderHost(projects, former.root, f.profile, [], former.inputs),
  };
}

describe(
  'canonical forward completion recovery with actual private inventory and synthetic ESRCH',
  { timeout: 30000 },
  () => {
    it('recovers exact attempt1 among two admitted inputs sharing taskKey and returns its already sealed DONE without repeating projection', async () => {
      const f = await interruptedAfterAcquire(true, true);
      expect(f.former.inputs).toHaveLength(2);
      const firstInput = f.former.inputs[0]!;
      const secondInput = f.former.inputs[1]!;
      expect(localTaskKey(firstInput)).toBe(localTaskKey(secondInput));
      expect(taskAdmissionIdentity(firstInput)).not.toBe(taskAdmissionIdentity(secondInput));
      expect(f.priorDone).not.toBeNull();
      const original = object(JSON.parse(f.priorDone!.toString()) as unknown);
      const token = object(JSON.parse(f.token.toString()) as unknown);
      expect(token.taskAdmission).toBe(taskAdmissionIdentity(secondInput));
      await expect(f.recover()).resolves.toMatchObject({ owner: { taskBindings: 3 } });
      expect(existsSync(f.reservation)).toBe(false);
      expect(existsSync(f.lockPath)).toBe(false);
      f.noWorkOrProjection();
      const cold = f.owned('cold-attempt1-reply');
      const first = await cold.service.humanActivities.finishTaskHuman(f.request);
      const second = await cold.service.humanActivities.finishTaskHuman(f.request);
      expect(first).toEqual(original);
      expect(second).toEqual(original);
      expect(f.read(first.result).humanCompletion).toEqual(f.seal);
      f.noWorkOrProjection();
    });

    it.each([
      'old-token-no-admission',
      'stale-attempt0',
      'foreign-admission',
      'unsupported-owner-kind',
    ] as const)(
      'retains both actual attempt inventories and the sealed result for %s',
      async (defect) => {
        const f = await interruptedAfterAcquire(true, true);
        const token = object(JSON.parse(f.token.toString()) as unknown);
        if (defect === 'old-token-no-admission') delete token.taskAdmission;
        if (defect === 'stale-attempt0')
          token.taskAdmission = taskAdmissionIdentity(f.former.inputs[0]!);
        if (defect === 'foreign-admission') token.taskAdmission = 'foreign-unregistered-attempt';
        if (defect === 'unsupported-owner-kind')
          token.owner = { ...f.former.owner.ref, kind: 'foreign' };
        writeFileSync(f.reservation, JSON.stringify(token));
        const unknown = readFileSync(f.reservation);
        const owner = readFileSync(f.former.ownerFile);
        await expect(f.recover()).rejects.toThrow();
        expect(readFileSync(f.reservation)).toEqual(unknown);
        expect(readFileSync(f.former.ownerFile)).toEqual(owner);
        for (const input of f.former.inputs)
          expect(
            existsSync(join(f.former.admissions, files.digest(taskAdmissionIdentity(input)))),
          ).toBe(true);
        f.noWorkOrProjection();
      },
    );
    it('dispatches taskBindings3 to the exact v2 admission namespace, reclaims only after STOP/inventory, and returns one sealed outcome without another Writer', async () => {
      const f = await interruptedAfterAcquire();
      const oldPoison = files.privateDirectory(join(f.former.root, 'task-admissions'));
      files.publishFile(join(oldPoison, 'poison-v1-must-not-be-read'), Buffer.from('not JSON'));
      const oldAdmission = readFileSync(
        join(f.former.admissions, files.digest(taskAdmissionIdentity(f.input))),
      );
      await expect(f.recover()).resolves.toMatchObject({
        owner: { taskBindings: 3 },
      });
      expect(existsSync(f.reservation)).toBe(false);
      expect(existsSync(f.lockPath)).toBe(false);
      expect(existsSync(f.former.ownerFile)).toBe(false);
      expect(readFileSync(join(oldPoison, 'poison-v1-must-not-be-read'), 'utf8')).toBe('not JSON');
      expect(
        readFileSync(join(f.former.admissions, files.digest(taskAdmissionIdentity(f.input)))),
      ).toEqual(oldAdmission);
      expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(f.permissionBefore);
      f.noWorkOrProjection();
      const next = f.owned('next-completion-host');
      const admissionPath = join(next.admissions, files.digest(taskAdmissionIdentity(f.input)));
      expect(next.inputs).toEqual([]);
      expect(existsSync(admissionPath)).toBe(false);
      const grantPath = join(f.directory, 'grant.json');
      const grant = readFileSync(grantPath);
      const expectedAdmission = {
        schemaVersion: 1,
        host: { pid: process.pid, id: next.id },
        input: f.input,
        gate: {
          directory: f.directory,
          grant: { sha256: files.digest(grant), bytes: grant.length },
          mode: 'retained',
        },
      };
      const actualLock = permission.taskPermissionLock;
      let observedAdmissionBeforeAcquire = false;
      let firstAdmissionBytes: Buffer | null = null;
      const observer = vi
        .spyOn(permission, 'taskPermissionLock')
        .mockImplementation((scope, owner) => {
          const lock = actualLock(scope, owner);
          return {
            ...lock,
            acquire() {
              if (
                !observedAdmissionBeforeAcquire &&
                scope.directory === f.directory &&
                owner?.ref.id === next.id
              ) {
                expect(owner.ref).toEqual(next.owner.ref);
                firstAdmissionBytes = files.readPrivateFile(admissionPath);
                expect(object(JSON.parse(firstAdmissionBytes.toString()) as unknown)).toEqual(
                  expectedAdmission,
                );
                expect(readFileSync(grantPath)).toEqual(grant);
                expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(
                  f.permissionBefore,
                );
                f.noWorkOrProjection();
                observedAdmissionBeforeAcquire = true;
              }
              lock.acquire();
            },
          };
        });
      const first = await next.service.humanActivities.finishTaskHuman(f.request);
      expect(observedAdmissionBeforeAcquire).toBe(true);
      expect(firstAdmissionBytes).not.toBeNull();
      observer.mockRestore();
      expect(files.readPrivateFile(admissionPath)).toEqual(firstAdmissionBytes);
      expect(readFileSync(grantPath)).toEqual(grant);
      const completedCard = readFileSync(f.card);
      const second = await next.service.humanActivities.finishTaskHuman(f.request);
      expect(files.readPrivateFile(admissionPath)).toEqual(firstAdmissionBytes);
      expect(second).toEqual(first);
      expect(first.status).toBe('done');
      expect(f.read(first.result).humanCompletion).toEqual(f.seal);
      expect(readFileSync(f.card)).toEqual(completedCard);
      expect({
        creates: f.state.creates,
        starts: f.state.starts,
        readers: f.state.readers,
      }).toEqual(f.counts);
      expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(f.permissionBefore);
    });

    it('reclaims a sealed source token after the real lock was already released before projection', async () => {
      const f = await interruptedAfterAcquire(false, false, true);
      expect(existsSync(f.lockPath)).toBe(false);
      expect(readFileSync(f.reservation)).toEqual(f.token);
      await expect(f.recover()).resolves.toMatchObject({ owner: { taskBindings: 3 } });
      expect(existsSync(f.reservation)).toBe(false);
      expect(existsSync(f.lockPath)).toBe(false);
      expect(existsSync(f.former.ownerFile)).toBe(false);
      expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(f.permissionBefore);
      f.noWorkOrProjection();
    });

    it('rechecks a real retained Reader journal together with the completion inventory', async () => {
      const f = await interruptedAfterAcquire();
      const input = parseReaderInput({
        preparation: f.input.admission.preparation,
        roleId: 'reviewer',
      });
      const permissions = join(
        f.former.root,
        files.digest(f.registration.project.projectId),
        'permissions',
      );
      const boundary = readerBoundary(
        permissions,
        f.store,
        f.workspace,
        readerExecution(f.profile),
      );
      const permit = boundary.install(input);
      const key = files.digest(JSON.stringify(readerTarget(input, readerKey(input))));
      // SYNTHETIC_ADMISSION: canonical unit format, not actual createReaderHost publication.
      const admission = join(f.former.root, 'admissions', key);
      files.publishFile(
        admission,
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            target: readerTarget(input, readerKey(input)),
            inputHash: files.digest(JSON.stringify(input)),
            permit,
          }),
        ),
      );
      const admissionBytes = readFileSync(admission);
      await boundary.boundary.dispatch(
        input,
        { permit, revision: 0, attempt: 0 },
        'create',
        'thread/start',
        { config: { model_reasoning_effort: f.profile.effort } },
        () =>
          f.rpc.request('thread/start', {
            config: { model_reasoning_effort: f.profile.effort },
          }),
      );
      const snapshot = boundary.inspect(input);
      expect(snapshot.requests).toHaveLength(1);
      expect(snapshot.requests[0]!.response).not.toBeNull();
      f.counts.readers = f.state.readers;
      const result = await recoverReaderHost(
        f.projects,
        f.former.root,
        f.profile,
        [input],
        f.former.inputs,
      );
      expect(result.tasks).toHaveLength(1);
      expect(f.read(result.proofs[0]!.receipt)).toMatchObject({
        kind: 'reader-host-recovery',
        observed: [expect.objectContaining({ permit })],
      });
      expect(boundary.inspect(input)).toEqual(snapshot);
      expect(readFileSync(admission)).toEqual(admissionBytes);
      expect(existsSync(f.reservation)).toBe(false);
      expect(existsSync(f.former.ownerFile)).toBe(false);
      expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(f.permissionBefore);
      f.noWorkOrProjection();
    });

    it('releases an owned ordinary Writer reservation on source B after completion recovery on source A', async () => {
      const f = await interruptedAfterAcquire();
      const ordinary = localTaskFixture();
      const project = { ...ordinary.registration.project, projectId: 'ordinary-project' };
      const registration = { ...ordinary.registration, project };
      const input = parseLocalTask({
        ...ordinary.input,
        admission: {
          ...ordinary.input.admission,
          preparation: { ...ordinary.input.admission.preparation, project },
        },
      });
      declareBackendFixture(ordinary.workspace);
      const home = files.privateDirectory(taskBackendHome(ordinary.workspace));
      files.publishFile(
        join(home, 'backend-policy.json'),
        Buffer.from(JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' })),
      );
      reserveTaskBackend(ordinary.workspace, {
        schemaVersion: 1,
        projectId: project.projectId,
        taskId: input.admission.preparation.taskId,
        backend: 'temporal',
        cardName: basename(input.admission.preparation.card),
        origin: files.digest(
          readFileSync(join(ordinary.workspace, input.admission.preparation.card)),
        ),
      });
      files.privateDirectory(join(f.former.root, files.digest(project.projectId), 'permissions'));
      const owner = permission.taskHostPermissionOwner(
        f.former.root,
        registration.artifactRoot,
        f.former.id,
      );
      const source = taskFiles(registration.artifactRoot).binding(ordinary.workspace);
      const gate = taskGates.taskGate(
        input,
        source,
        ordinary.profile,
        registration.artifactRoot,
        f.former.id,
        owner,
      );
      gate.install();
      const reservation = join(home, 'source-reservation');
      const grant = readFileSync(reservation);
      const card = readFileSync(join(ordinary.workspace, input.admission.preparation.card));
      const create = taskGates.taskGate;
      let interrupted = false;
      const stopGap = vi.spyOn(taskGates, 'taskGate').mockImplementation((...args) => {
        const actual = create(...args);
        return {
          ...actual,
          release() {
            interrupted = true;
            throw new Error('synthetic loss after actual ordinary STOP before source release');
          },
        };
      });
      const service = localTaskActivities(
        registration,
        ordinary.host,
        ordinary.rpc,
        ordinary.profile,
        () => {},
        {
          instance: f.former.id,
          owner,
          admitted(admitted, retained) {
            expect(admitted).toEqual(input);
            f.former.inputs.push(admitted);
            files.publishFile(
              join(f.former.admissions, files.digest(taskAdmissionIdentity(admitted))),
              Buffer.from(
                JSON.stringify({
                  schemaVersion: 1,
                  host: { pid: process.pid, id: f.former.id },
                  input: admitted,
                  gate: retained,
                }),
              ),
            );
          },
        },
      );
      await expect(service.controls.stopLocalTask(input)).rejects.toThrow(
        'synthetic loss after actual ordinary STOP before source release',
      );
      stopGap.mockRestore();
      expect(interrupted).toBe(true);
      expect(
        ordinary.read(
          JSON.parse(
            readFileSync(join(gate.directory, 'stopped.json'), 'utf8'),
          ) as typeof ordinary.proof,
        ),
      ).toMatchObject({
        kind: 'task-not-started',
        input,
        confirmed: true,
      });
      const permissionBytes = readFileSync(join(gate.directory, 'permission.json'));
      expect(object(JSON.parse(permissionBytes.toString()) as unknown).active).toBe(false);
      expect(readFileSync(reservation)).toEqual(grant);
      expect(readFileSync(f.reservation)).toEqual(f.token);
      f.projects.push({
        registration,
        rpc: ordinary.rpc,
        authority: ordinary.authority,
        localTasks: ordinary.host,
      });
      const result = await f.recover();
      expect(result.tasks).toHaveLength(2);
      expect(existsSync(reservation)).toBe(false);
      expect(existsSync(f.reservation)).toBe(false);
      expect(existsSync(f.former.ownerFile)).toBe(false);
      expect(readFileSync(join(gate.directory, 'permission.json'))).toEqual(permissionBytes);
      expect(readFileSync(join(ordinary.workspace, input.admission.preparation.card))).toEqual(
        card,
      );
      expect(ordinary.state.creates).toBe(0);
      expect(ordinary.state.starts).toBe(0);
      expect(existsSync(join(gate.directory, 'done.json'))).toBe(false);
      expect(existsSync(join(gate.directory, 'completion-intent.json'))).toBe(false);
      f.noWorkOrProjection();
    });

    it.each([
      'live-host',
      'unknown-host',
      'missing-admission',
      'ownerless-old-token',
      'old-empty-lock',
      'nlink2-pending',
    ] as const)(
      'retains source/host and denies any new Writer/projection/reply for %s',
      async (defect) => {
        const f = await interruptedAfterAcquire();
        if (defect === 'live-host') f.dead.mockImplementation(() => true);
        if (defect === 'unknown-host')
          f.dead.mockImplementation(() => {
            throw Object.assign(new Error('unknown owner access'), {
              code: 'EPERM',
            });
          });
        if (defect === 'missing-admission')
          unlinkSync(join(f.former.admissions, files.digest(taskAdmissionIdentity(f.input))));
        if (defect === 'ownerless-old-token') {
          const old = object(JSON.parse(f.token.toString()) as unknown);
          delete old.schemaVersion;
          delete old.owner;
          delete old.taskAdmission;
          writeFileSync(f.reservation, JSON.stringify(old));
        }
        if (defect === 'old-empty-lock') {
          unlinkSync(f.lockPath);
          mkdirSync(f.lockPath, { mode: 0o700 });
        }
        const pending = join(f.directory, '.pending-interrupted-shared-lock');
        if (defect === 'nlink2-pending') linkSync(f.lockPath, pending);
        const owner = readFileSync(f.former.ownerFile);
        const token = readFileSync(f.reservation);
        await expect(f.recover()).rejects.toThrow();
        expect(readFileSync(f.former.ownerFile)).toEqual(owner);
        expect(readFileSync(f.reservation)).toEqual(token);
        if (defect === 'old-empty-lock') expect(lstatSync(f.lockPath).isDirectory()).toBe(true);
        if (defect === 'nlink2-pending') {
          expect(readFileSync(pending)).toEqual(readFileSync(f.lockPath));
          expect(lstatSync(f.lockPath).nlink).toBe(2);
        }
        f.noWorkOrProjection();
      },
    );

    it.each(['permission-pin', 'identical-lock-inode'] as const)(
      'rejects a %s change after the real inventory inspection without releasing source',
      async (defect) => {
        const f = await interruptedAfterAcquire();
        const inspect = taskRecovery.inspectTaskAdmissions;
        vi.spyOn(taskRecovery, 'inspectTaskAdmissions').mockImplementation(async (...args) => {
          const inspected = await inspect(...args);
          if (defect === 'permission-pin') {
            const path = join(f.directory, 'permission.json');
            writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
          } else {
            const path = f.lockPath + '.identical-replacement';
            files.publishFile(path, readFileSync(f.lockPath));
            renameSync(path, f.lockPath);
          }
          return inspected;
        });
        const owner = readFileSync(f.former.ownerFile);
        await expect(f.recover()).rejects.toThrow();
        expect(readFileSync(f.former.ownerFile)).toEqual(owner);
        expect(readFileSync(f.reservation)).toEqual(f.token);
        f.noWorkOrProjection();
      },
    );

    it.each(['permission-active', 'stopped-pointer', 'source-inode'] as const)(
      'rechecks actual source/STOP after R publication and retains token after gap mutation: %s',
      async (defect) => {
        const f = await interruptedAfterAcquire();
        const publish = files.publishFile;
        let armed = true;
        let observedCard = f.card;
        vi.spyOn(files, 'publishFile').mockImplementation((path, bytes) => {
          publish(path, bytes);
          if (
            armed &&
            path === f.lockPath &&
            object(object(JSON.parse(Buffer.from(bytes).toString()) as unknown).owner).kind ===
              'recovery'
          ) {
            armed = false;
            if (defect === 'permission-active') {
              const permissionPath = join(f.directory, 'permission.json');
              const permission = object(
                JSON.parse(readFileSync(permissionPath, 'utf8')) as unknown,
              );
              writeFileSync(permissionPath, JSON.stringify({ ...permission, active: true }));
            } else if (defect === 'stopped-pointer') {
              writeFileSync(join(f.directory, 'stopped.json'), JSON.stringify(f.proof));
            } else {
              const retainedSource = f.workspace + '-retained-source';
              renameSync(f.workspace, retainedSource);
              mkdirSync(f.workspace, { mode: 0o700 });
              renameSync(join(retainedSource, '.git'), join(f.workspace, '.git'));
              observedCard = join(retainedSource, f.input.admission.preparation.card);
            }
          }
        });
        const owner = readFileSync(f.former.ownerFile);
        await expect(f.recover()).rejects.toThrow();
        expect(armed).toBe(false);
        expect(readFileSync(f.reservation)).toEqual(f.token);
        expect(readFileSync(f.former.ownerFile)).toEqual(owner);
        f.noWorkOrProjection(observedCard);
      },
    );

    it('rechecks the whole admission inventory after the new R-locked actual process observation awaits', async () => {
      const f = await interruptedAfterAcquire();
      const alive = f.processes.alive.getMockImplementation()!;
      let armed = true;
      f.processes.alive.mockImplementation(async (ids) => {
        const observed = await alive(ids);
        if (
          armed &&
          existsSync(f.lockPath) &&
          object(object(JSON.parse(readFileSync(f.lockPath, 'utf8')) as unknown).owner).kind ===
            'recovery'
        ) {
          armed = false;
          files.publishFile(
            join(f.former.admissions, 'unexpected-admission-during-stop-await'),
            Buffer.from('new inventory entry'),
          );
        }
        return observed;
      });
      const owner = readFileSync(f.former.ownerFile);
      await expect(f.recover()).rejects.toThrow();
      expect(armed).toBe(false);
      expect(readFileSync(f.reservation)).toEqual(f.token);
      expect(readFileSync(f.former.ownerFile)).toEqual(owner);
      expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(f.permissionBefore);
      f.noWorkOrProjection();
    });

    it('retains an unknown source publication appearing during the R-locked process observation', async () => {
      const f = await interruptedAfterAcquire();
      const alive = f.processes.alive.getMockImplementation()!;
      const pending = join(taskBackendHome(f.workspace), '.pending-late-source-publication');
      const pendingBytes = Buffer.from('UNKNOWN late source publication');
      let armed = true;
      f.processes.alive.mockImplementation(async (ids) => {
        const observed = await alive(ids);
        if (
          armed &&
          existsSync(f.lockPath) &&
          object(object(JSON.parse(readFileSync(f.lockPath, 'utf8')) as unknown).owner).kind ===
            'recovery'
        ) {
          armed = false;
          files.publishFile(pending, pendingBytes);
        }
        return observed;
      });
      const owner = readFileSync(f.former.ownerFile);
      await expect(f.recover()).rejects.toThrow('task-recovery-completion-publication-unknown');
      expect(armed).toBe(false);
      expect(readFileSync(pending)).toEqual(pendingBytes);
      expect(lstatSync(pending).nlink).toBe(1);
      expect(readFileSync(f.reservation)).toEqual(f.token);
      expect(readFileSync(f.former.ownerFile)).toEqual(owner);
      expect(readFileSync(join(f.directory, 'permission.json'))).toEqual(f.permissionBefore);
      f.noWorkOrProjection();
    });

    it('keeps the competing actor winning old-unlink/new-acquire gap and retains the old source token', async () => {
      const f = await interruptedAfterAcquire();
      const winnerOwner = f.owned('competing-live-host');
      const winner = permission.taskPermissionLock(f.scope, winnerOwner.owner);
      const sync = files.syncDirectory;
      let armed = true;
      let winnerBytes: Buffer | null = null;
      vi.spyOn(files, 'syncDirectory').mockImplementation((path) => {
        sync(path);
        if (armed && path === f.directory && !existsSync(f.lockPath) && existsSync(f.reservation)) {
          armed = false;
          winner.acquire();
          winnerBytes = readFileSync(f.lockPath);
        }
      });
      await expect(f.recover()).rejects.toThrow();
      expect(armed).toBe(false);
      expect(winnerBytes).not.toBeNull();
      expect(readFileSync(f.lockPath)).toEqual(winnerBytes);
      expect(readFileSync(f.reservation)).toEqual(f.token);
      expect(existsSync(f.former.ownerFile)).toBe(true);
      await expect(
        winnerOwner.service.humanActivities.finishTaskHuman(f.request),
      ).rejects.toThrow();
      expect(readFileSync(f.lockPath)).toEqual(winnerBytes);
      expect(readFileSync(f.reservation)).toEqual(f.token);
      f.noWorkOrProjection();
    });
  },
);
