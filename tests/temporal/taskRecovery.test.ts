import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskHumanLocalFixture } from './taskHumanLocalFixture.js';
import { localTaskFixture } from './localTaskFixture.js';
import { localTaskActivities } from '../../src/activities/localTask.js';
import { taskAdmissionIdentity } from '../../src/policy/taskRecovery.js';
import { localTaskKey, parseLocalTask } from '../../src/policy/localTask.js';
import { taskGateBinding } from '../../src/adapters/project/taskGate.js';
import * as permissionLocks from '../../src/adapters/project/taskPermissionLock.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerExecution } from '../../src/policy/readerExecution.js';
import { readerKey, readerTarget } from '../../src/policy/readerControl.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { inspectTaskAdmissions } from '../../src/worker/taskRecovery.js';
import { recoverReaderHost, recoverUnstartedBaseline } from '../../src/worker/readerRecovery.js';
import * as files from '../../src/adapters/artifacts/files.js';
import type { TaskHostAdmission } from '../../src/contracts/taskRecovery.js';
import type { LocalTaskInput } from '../../src/contracts/localTask.js';
import { mechanicalTaskFixture } from './mechanicalTaskFixture.js';
import { correctionFixture } from './correctionFixture.js';
import { acceptance, runReview, throughIntegration } from './localTaskRun.js';
import * as taskChecks from '../../src/adapters/project/taskChecks.js';
import { object, text } from '../../src/contracts/project.js';

afterEach(() => vi.restoreAllMocks());

function fixture(
  base = localTaskFixture(),
  input: LocalTaskInput = base.input,
  taskBindings: 1 | 2 = 1,
) {
  const f = { ...base, input: parseLocalTask(input) },
    root = join(f.root, 'bound-host'),
    host = { pid: 999999, id: 'dead-owner' },
    admissions =
      taskBindings === 2
        ? join(root, 'task-admissions-v2', host.id)
        : join(root, 'task-admissions'),
    key = files.digest(taskAdmissionIdentity(f.input)),
    admission = join(admissions, key);
  mkdirSync(admissions, { recursive: true });
  mkdirSync(join(root, 'admissions'));
  mkdirSync(join(root, files.digest(f.registration.project.projectId), 'permissions'), {
    recursive: true,
  });
  const owner = join(root, 'host-owner');
  writeFileSync(owner, JSON.stringify({ ...host, tasks: true, taskBindings }));
  const service = localTaskActivities(f.registration, f.host, f.rpc, f.profile, vi.fn(), {
    instance: host.id,
    admitted(input, gate) {
      const record: TaskHostAdmission = { schemaVersion: 1, host, input, gate };
      files.publishFile(admission, Buffer.from(JSON.stringify(record)));
    },
  });
  const binding = taskGateBinding(
      parseLocalTask(f.input),
      taskFiles(f.registration.artifactRoot).binding(f.workspace),
      f.profile,
      f.registration.artifactRoot,
      host.id,
    ),
    projects = [
      { registration: f.registration, rpc: f.rpc, authority: f.authority, localTasks: f.host },
    ],
    inspect = () => inspectTaskAdmissions(projects, root, host, [f.input], taskBindings),
    recover = () => recoverReaderHost(projects, root, f.profile, [], [f.input]);
  const dead = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  });
  async function stopped(withChecks = false) {
    const snapshot = await service.activities.prepareLocalTask(f.input);
    if (withChecks)
      await service.activities.checkLocalTask(f.input, snapshot, 'baseline', null, null);
    const writer = await service.activities.writeLocalTask(f.input, snapshot);
    const stop = await service.controls.stopLocalTask(f.input);
    files.publishFile(binding.reservation, binding.grant);
    return { snapshot, writer, stop };
  }
  return {
    ...f,
    root,
    hostOwner: host,
    owner,
    admission,
    admissions,
    service,
    binding,
    projects,
    inspect,
    recover,
    stopped,
    dead,
  };
}

function bindRecoveryReader(
  f: ReturnType<typeof fixture>,
  preparation: LocalTaskInput['admission']['preparation'],
) {
  const reader = { preparation, roleId: preparation.project.roles[0]!.id };
  const target = readerTarget(reader, readerKey(reader)),
    key = files.digest(JSON.stringify(target));
  const permissions = join(f.root, files.digest(preparation.project.projectId), 'permissions');
  const gate = readerBoundary(permissions, f.store, f.workspace, readerExecution(f.profile));
  const permit = gate.install(reader),
    epoch = { permit, revision: 0, attempt: 0 };
  const permissionPath = join(permissions, key, 'permission.json');
  files.publishFile(
    join(f.root, 'admissions', key),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        target,
        inputHash: files.digest(JSON.stringify(reader)),
        permit,
      }),
    ),
  );
  const recover = () => recoverReaderHost(f.projects, f.root, f.profile, [reader], [f.input]);
  return { reader, gate, epoch, permissionPath, recover };
}

describe('bound task inventory and dead host recovery', () => {
  function v2Fixture() {
    const base = localTaskFixture();
    return fixture(base, base.input, 2);
  }
  it('recovers only the current v2 owner and leaves previous admissions intact', async () => {
    const f = v2Fixture();
    await f.stopped();
    const legacy = join(f.root, 'task-admissions'),
      prior = join(f.root, 'task-admissions-v2', 'previous-owner');
    mkdirSync(legacy);
    mkdirSync(prior);
    const history = [join(legacy, 'historical-record'), join(prior, 'historical-record')];
    for (const path of history) writeFileSync(path, 'previous immutable bytes');
    const admission = readFileSync(f.admission);
    await expect(f.recover()).resolves.toMatchObject({ owner: { taskBindings: 2 } });
    expect(existsSync(f.owner)).toBe(false);
    expect(existsSync(f.binding.reservation)).toBe(false);
    expect(readFileSync(f.admission)).toEqual(admission);
    for (const path of history) expect(readFileSync(path, 'utf8')).toBe('previous immutable bytes');
  });
  it.each([
    ['live-owner', 'reader-host-still-alive'],
    ['live-writer', 'task-recovery-writer-stop-unknown'],
    ['missing-stop', 'stopped.json'],
    ['invalid-instance', 'invalid-identifier'],
    ['aliased-namespace', 'task-recovery-admission-directory-unsafe'],
  ])('preserves the v2 owner and reservation for %s', async (defect, reason) => {
    const f = v2Fixture();
    await f.stopped();
    if (defect === 'live-owner') f.dead.mockImplementation(() => true);
    if (defect === 'live-writer') f.state.alive = true;
    if (defect === 'missing-stop') unlinkSync(join(f.binding.directory, 'stopped.json'));
    if (defect === 'invalid-instance') {
      writeFileSync(
        f.owner,
        JSON.stringify({ ...f.hostOwner, id: '../foreign', tasks: true, taskBindings: 2 }),
      );
    }
    if (defect === 'aliased-namespace') {
      renameSync(f.admissions, f.admissions + '-retained');
      symlinkSync(f.admissions + '-retained', f.admissions);
    }
    const owner = readFileSync(f.owner);
    await expect(f.recover()).rejects.toThrow(reason);
    expect(readFileSync(f.owner)).toEqual(owner);
    expect(readFileSync(f.binding.reservation)).toEqual(f.binding.grant);
    expect(f.state.creates).toBe(1);
    expect(f.state.starts).toBe(3);
  });
  it('refuses a replaced v2 admission directory even if it contains the same bytes', async () => {
    const f = v2Fixture();
    await f.stopped();
    const inspected = await f.inspect(),
      previous = readFileSync(f.admission);
    renameSync(f.admissions, f.admissions + '-retained');
    mkdirSync(f.admissions);
    writeFileSync(f.admission, previous);
    await expect(inspected.recheck()).rejects.toThrow('task-recovery-admission-directory-changed');
    expect(existsSync(f.owner)).toBe(true);
    expect(readFileSync(f.binding.reservation)).toEqual(f.binding.grant);
  });
  it.each(['missing', 'replaced'])(
    'does not recreate a %s artifact root between registration validation and inspection',
    async (defect) => {
      const f = fixture();
      await f.stopped();
      const original = files.artifactStore,
        target = f.registration.artifactRoot;
      vi.spyOn(files, 'artifactStore').mockImplementation((directory, options) => {
        expect(options).toEqual({ existingOnly: true });
        renameSync(target, target + '-retained');
        if (defect === 'replaced') mkdirSync(target);
        return original(directory, options);
      });
      await expect(f.inspect()).rejects.toThrow();
      expect(existsSync(target)).toBe(defect === 'replaced');
      if (defect === 'replaced') expect(readdirSync(target)).toEqual([]);
      expect(existsSync(f.owner)).toBe(true);
      expect(readFileSync(f.binding.reservation)).toEqual(f.binding.grant);
    },
  );
  it('refuses an artifact root replaced after the first read-only inspection', async () => {
    const f = fixture();
    await f.stopped();
    const inspected = await f.inspect(),
      target = f.registration.artifactRoot;
    renameSync(target, target + '-retained');
    mkdirSync(target);
    await expect(inspected.recheck()).rejects.toThrow('task-workspace-changed');
    expect(readdirSync(target)).toEqual([]);
    expect(existsSync(f.owner)).toBe(true);
  });
  it.each(['mechanical-stop', 'mechanical-done', 'writer-done'])(
    'verifies a genuine %s and its complete linked checks before host release',
    async (route) => {
      const base = route.startsWith('mechanical')
          ? await mechanicalTaskFixture()
          : localTaskFixture(),
        input = parseLocalTask('mechanicalInput' in base ? base.mechanicalInput : base.input),
        f = fixture(base, input);
      if (route === 'mechanical-stop') {
        await f.service.activities.prepareLocalTask(f.input);
        await f.service.controls.stopLocalTask(f.input);
      } else {
        const run = await throughIntegration(f),
          verdict = await acceptance(f, run),
          done = await f.service.activities.finishLocalTask(
            f.input,
            run.snapshot,
            run.packet,
            verdict.manifest,
          );
        expect(done.status).toBe('done');
      }
      const published = vi.spyOn(files, 'publishFile'),
        inspection = await f.inspect();
      await inspection.recheck();
      expect(published).not.toHaveBeenCalled();
      await f.recover();
      expect(existsSync(f.owner)).toBe(false);
      expect(existsSync(f.binding.reservation)).toBe(false);
    },
  );
  it('recovers the reader of a completed task only against its original or exact projected card', async () => {
    const f = fixture(),
      preparation = f.input.admission.preparation;
    const { reader, gate, epoch, permissionPath, recover } = bindRecoveryReader(f, preparation);
    const run = await throughIntegration(f),
      verdict = await acceptance(f, run);
    await f.service.activities.finishLocalTask(f.input, run.snapshot, run.packet, verdict.manifest);
    const card = join(f.workspace, preparation.card),
      projected = readFileSync(card);
    const permitBytes = readFileSync(permissionPath);
    writeFileSync(
      permissionPath,
      JSON.stringify({ ...JSON.parse(permitBytes.toString()), cardHash: 'a'.repeat(64) }),
    );
    await expect(recover()).rejects.toThrow('reader-card-changed');
    writeFileSync(permissionPath, permitBytes);
    writeFileSync(card, Buffer.concat([projected, Buffer.from('edited')]));
    await expect(recover()).rejects.toThrow('reader-card-changed');
    expect(existsSync(f.owner)).toBe(true);
    writeFileSync(card, projected);
    expect(() => gate.boundary.assert(reader, epoch)).toThrow('reader-card-changed');
    const donePath = join(f.binding.directory, 'done.json'),
      doneBytes = readFileSync(donePath);
    const done = object(JSON.parse(doneBytes.toString()));
    writeFileSync(donePath, JSON.stringify({ ...done, projection: done.result }));
    await expect(recover()).rejects.toThrow('reader-card-changed');
    writeFileSync(donePath, doneBytes);
    await expect(recover()).resolves.toMatchObject({ tasks: [{ outcome: done }] });
    expect(existsSync(f.owner)).toBe(false);
    expect(readFileSync(permissionPath)).toEqual(permitBytes);
    expect(() => gate.boundary.assert(reader, epoch)).toThrow('reader-card-changed');
  });
  it.each(['stopped', 'other-task'])(
    'rejects changed cards without a matching completed task: %s',
    async (route) => {
      const f = fixture(),
        preparation = f.input.admission.preparation;
      const { recover } = bindRecoveryReader(
        f,
        route === 'stopped' ? preparation : { ...preparation, taskId: 'other' },
      );
      if (route === 'stopped') {
        await f.stopped();
        writeFileSync(join(f.workspace, preparation.card), 'manual edit');
      } else {
        const run = await throughIntegration(f),
          verdict = await acceptance(f, run);
        await f.service.activities.finishLocalTask(
          f.input,
          run.snapshot,
          run.packet,
          verdict.manifest,
        );
      }
      await expect(recover()).rejects.toThrow('reader-card-changed');
      expect(existsSync(f.owner)).toBe(true);
    },
  );
  it('retains real FAIL and both correction scopes while recovering only stopped writers', async () => {
    const base = correctionFixture(),
      f = fixture(base, base.correctionInput),
      a = f.service.activities,
      planning = await a.prepareSubstantialPlanning(f.input),
      approved = await runReview(f, planning),
      first = await throughIntegration(f, f.input, approved.manifest),
      failed = await acceptance(f, first);
    expect(failed.complete).toBe(false);
    await a.prepareLocalCorrection(f.input, first.snapshot, first.packet, failed.manifest);
    const stopped = await f.service.controls.stopLocalTask(f.input),
      published = vi.spyOn(files, 'publishFile'),
      inspected = await f.inspect();
    await inspected.recheck();
    expect(inspected.observed[0]!.writers).toHaveLength(2);
    expect(published).not.toHaveBeenCalled();
    expect(f.read(stopped).rounds).toHaveLength(2);
    await f.recover();
    expect(existsSync(f.owner)).toBe(false);
    expect(f.read(failed.manifest).complete).toBe(false);
    expect(f.state.creates).toBe(1);
  }, 15_000);
  it.each(['lost-markers', 'lost-journal'])(
    'keeps a prepared native snapshot unknown after %s',
    async (defect) => {
      const f = fixture(),
        { stop } = await f.stopped(),
        original = f.read(stop);
      delete original.writer;
      writeFileSync(join(f.binding.directory, 'stopped.json'), JSON.stringify(f.save(original)));
      for (const name of [
        'writer-runtime.json',
        'runtime-identity.json',
        'writer-stopped.json',
        'writer-result.json',
      ])
        unlinkSync(join(f.binding.directory, name));
      if (defect === 'lost-journal')
        rmSync(join(f.binding.directory, 'writer-effects'), { recursive: true });
      const failure =
        defect === 'lost-journal'
          ? 'task-recovery-operation-unknown'
          : 'task-recovery-writer-stop-unknown';
      const published = vi.spyOn(files, 'publishFile');
      await expect(f.inspect()).rejects.toThrow(failure);
      expect(published).not.toHaveBeenCalled();
      await expect(f.recover()).rejects.toThrow(failure);
      expect(existsSync(f.owner)).toBe(true);
      expect(readFileSync(f.binding.reservation)).toEqual(f.binding.grant);
    },
  );
  it('keeps mechanical runtime markers, substituted results and changed copies unknown after genuine DONE', async () => {
    const base = await mechanicalTaskFixture(),
      f = fixture(base, base.mechanicalInput),
      run = await throughIntegration(f),
      verdict = await acceptance(f, run);
    await f.service.activities.finishLocalTask(f.input, run.snapshot, run.packet, verdict.manifest);
    const writerFile = join(f.binding.directory, 'writer-result.json'),
      saved = readFileSync(writerFile),
      body = f.read(run.snapshot),
      source = join(text(object(body.copy).root), 'owner.cjs'),
      original = readFileSync(source);
    writeFileSync(join(f.binding.directory, 'writer-runtime.json'), '{}');
    await expect(f.inspect()).rejects.toThrow('task-recovery-operation-unknown');
    unlinkSync(join(f.binding.directory, 'writer-runtime.json'));
    writeFileSync(writerFile, JSON.stringify(f.proof));
    await expect(f.inspect()).rejects.toThrow();
    writeFileSync(writerFile, saved);
    writeFileSync(source, 'changed stopped mechanical copy');
    await expect(f.inspect()).rejects.toThrow('task-late-writer');
    writeFileSync(source, original);
    await f.inspect();
    expect(existsSync(f.owner)).toBe(true);
    expect(f.state.creates).toBe(0);
  });
  it('observes nonempty retained check process identities and blocks a process that becomes live before release', async () => {
    const base = localTaskFixture(),
      implementation = vi.mocked(taskChecks.taskChecks).getMockImplementation();
    if (implementation === undefined) throw new Error('fixture-check-adapter-missing');
    const owned = [{ pid: 888881, parent: 1, started: 'unit-check-process' }];
    vi.mocked(taskChecks.taskChecks).mockImplementation((...args) => {
      const actor = implementation(...args);
      return {
        stop: async () => owned,
        run: async (...args) => ({
          ...(await actor.run(...args)),
          stop: { confirmed: true, processes: owned },
        }),
      };
    });
    const f = fixture(base);
    await f.stopped(true);
    const inspected = await f.inspect();
    let live = false;
    f.processes.alive.mockImplementation(async (ids) =>
      live && ids.some((p) => p.pid === owned[0]!.pid) ? ids : [],
    );
    await inspected.recheck();
    live = true;
    await expect(inspected.recheck()).rejects.toThrow('task-recovery-check-live');
    expect(existsSync(f.owner)).toBe(true);
    expect(existsSync(f.binding.reservation)).toBe(true);
  });
  it('uses the native read-only process observer when the host has no custom observer', async () => {
    const f = fixture();
    await f.stopped(true);
    const writer = f.projects[0]!.localTasks;
    await inspectTaskAdmissions(
      [
        {
          ...f.projects[0]!,
          localTasks: { profile: writer.profile, createRuntime: writer.createRuntime },
        },
      ],
      f.root,
      f.hostOwner,
      [f.input],
    );
    expect(existsSync(f.owner)).toBe(true);
  });
  it('persists the exact host/task/grant binding before admission can install permission', async () => {
    const f = fixture(),
      publish = vi.spyOn(files, 'publishFile'),
      snapshot = await f.service.activities.prepareLocalTask(f.input),
      admission = JSON.parse(readFileSync(f.admission, 'utf8')) as TaskHostAdmission;
    expect(admission).toMatchObject({ schemaVersion: 1, host: f.hostOwner, input: f.input });
    expect(admission.gate).toEqual({
      directory: f.binding.directory,
      grant: { sha256: files.digest(f.binding.grant), bytes: f.binding.grant.length },
      mode: 'owned',
    });
    expect(publish.mock.calls.findIndex(([path]) => path === f.admission)).toBeLessThan(
      publish.mock.calls.findIndex(([path]) => path === f.binding.reservation),
    );
    expect(f.read(snapshot).input).toEqual(f.input);
  });
  it('recovers an exactly stopped bound host without minting a grant or restarting work', async () => {
    const f = fixture(),
      { writer, stop } = await f.stopped(),
      permission = readFileSync(join(f.binding.directory, 'permission.json')),
      published = vi.spyOn(files, 'publishFile');
    const inspection = await f.inspect();
    expect(inspection.observed).toMatchObject([{ outcome: stop, writers: [writer.stop] }]);
    expect(published).not.toHaveBeenCalled();
    expect(existsSync(f.binding.reservation)).toBe(true);
    await f.recover();
    expect(existsSync(f.owner)).toBe(false);
    expect(existsSync(f.binding.reservation)).toBe(false);
    expect(readFileSync(join(f.binding.directory, 'permission.json'))).toEqual(permission);
    expect(f.state.creates).toBe(1);
    expect(f.state.starts).toBe(3);
    expect(readdirSync(f.root).filter((name) => name.startsWith('recovery-'))).toHaveLength(1);
  });
  it.each(['unlinked', 'linked'])(
    'keeps the %s pending source publication unknown',
    async (state) => {
      const f = fixture();
      await f.stopped();
      const pending = join(f.binding.home, '.pending-interrupted-source');
      if (state === 'linked') linkSync(f.binding.reservation, pending);
      else files.publishFile(pending, f.binding.grant);
      const owner = readFileSync(f.owner);
      await expect(f.recover()).rejects.toThrow('task-recovery-reservation-publication-unknown');
      expect(readFileSync(f.owner)).toEqual(owner);
      expect(readFileSync(f.binding.reservation)).toEqual(f.binding.grant);
      expect(readFileSync(pending)).toEqual(f.binding.grant);
      expect(lstatSync(f.binding.reservation).nlink).toBe(state === 'linked' ? 2 : 1);
      expect(f.state.starts).toBe(3);
    },
  );
  it('rejects foreign bytes at the initial reservation pin even if the grant bytes reappear', async () => {
    const f = fixture();
    await f.stopped();
    const path = f.binding.reservation,
      original = lstatSync(path),
      owner = readFileSync(f.owner),
      read = permissionLocks.taskPermissionBytes;
    let armed = true;
    vi.spyOn(permissionLocks, 'taskPermissionBytes').mockImplementation((target) => {
      if (!armed || target !== path) return read(target);
      armed = false;
      const replacement = path + '.foreign';
      files.publishFile(replacement, Buffer.from('foreign reservation'));
      renameSync(replacement, path);
      const foreign = read(path);
      writeFileSync(path, f.binding.grant);
      return foreign;
    });
    await expect(f.recover()).rejects.toThrow('task-recovery-reservation-changed');
    expect(lstatSync(path).ino).not.toBe(original.ino);
    expect(readFileSync(path)).toEqual(f.binding.grant);
    expect(readFileSync(f.owner)).toEqual(owner);
    expect(f.state.starts).toBe(3);
  });
  it.each([
    ['reservation-inode', 'task-recovery-reservation-changed'],
    ['reservation-bytes', 'task-recovery-reservation-changed'],
    ['pending-publication', 'task-recovery-reservation-publication-unknown'],
    ['permission', 'task-recovery-journal-changed'],
  ])(
    'keeps the source reserved when %s changes after the recovery receipt',
    async (defect, error) => {
      const f = fixture();
      await f.stopped();
      const publish = files.publishFile,
        path = f.binding.reservation,
        original = lstatSync(path),
        owner = readFileSync(f.owner),
        foreign = Buffer.from('foreign reservation'),
        pending = join(f.binding.home, '.pending-after-recovery-receipt'),
        permission = join(f.binding.directory, 'permission.json'),
        changedPermission = Buffer.from(JSON.stringify({ schemaVersion: 1, active: true }));
      vi.spyOn(files, 'publishFile').mockImplementation((target, bytes) => {
        publish(target, bytes);
        if (!target.startsWith(join(f.root, 'recovery-'))) return;
        if (defect === 'reservation-inode') {
          const replacement = path + '.replacement';
          publish(replacement, f.binding.grant);
          renameSync(replacement, path);
        }
        if (defect === 'reservation-bytes') writeFileSync(path, foreign);
        if (defect === 'pending-publication') publish(pending, foreign);
        if (defect === 'permission') writeFileSync(permission, changedPermission);
      });
      await expect(f.recover()).rejects.toThrow(error);
      if (defect === 'reservation-inode') expect(lstatSync(path).ino).not.toBe(original.ino);
      if (defect === 'pending-publication') expect(readFileSync(pending)).toEqual(foreign);
      if (defect === 'permission') expect(readFileSync(permission)).toEqual(changedPermission);
      expect(readFileSync(path)).toEqual(
        defect === 'reservation-bytes' ? foreign : f.binding.grant,
      );
      expect(readFileSync(f.owner)).toEqual(owner);
      expect(f.state.starts).toBe(3);
    },
  );
  it('recovers a permanently revoked admission that was stopped before any grant or writer', async () => {
    const f = fixture();
    await f.service.controls.stopLocalTask(f.input);
    await f.recover();
    expect(existsSync(f.owner)).toBe(false);
    expect(existsSync(join(f.binding.directory, 'grant.json'))).toBe(false);
    expect(f.state.starts).toBe(0);
    expect(f.state.creates).toBe(0);
  });
  it('records a retained closed grant under a replacement host without adopting its writer permission', async () => {
    const f = fixture();
    await f.stopped();
    const root = join(f.root, 'replacement-host'),
      owner = { pid: 999998, id: 'replacement-owner' },
      admissions = join(root, 'task-admissions');
    mkdirSync(admissions, { recursive: true });
    mkdirSync(join(root, 'admissions'));
    mkdirSync(join(root, files.digest(f.registration.project.projectId), 'permissions'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'host-owner'),
      JSON.stringify({ ...owner, tasks: true, taskBindings: 1 }),
    );
    const host = f.projects[0]!.localTasks,
      service = localTaskActivities(f.registration, host, f.rpc, f.profile, vi.fn(), {
        instance: owner.id,
        admitted(input, gate) {
          files.publishFile(
            join(admissions, files.digest(taskAdmissionIdentity(input))),
            Buffer.from(JSON.stringify({ schemaVersion: 1, host: owner, input, gate })),
          );
        },
      });
    await service.controls.stopLocalTask(f.input);
    const admission = JSON.parse(
      readFileSync(join(admissions, files.digest(taskAdmissionIdentity(f.input))), 'utf8'),
    ) as TaskHostAdmission;
    expect(admission.gate.mode).toBe('retained');
    expect(readFileSync(f.binding.reservation)).toEqual(f.binding.grant);
    await expect(service.activities.prepareLocalTask(f.input)).rejects.toThrow(
      'task-already-closed',
    );
    await recoverReaderHost(f.projects, root, f.profile, [], [f.input]);
    expect(existsSync(join(root, 'host-owner'))).toBe(false);
    expect(existsSync(f.binding.reservation)).toBe(false);
    expect(f.state.creates).toBe(1);
  });
  it.each([
    'missing-admission',
    'extra-admission',
    'changed-admission',
    'grant',
    'active',
    'missing-stop',
    'live',
    'unknown-writer',
    'pending-check',
  ])('keeps the previous host and source reserved for %s', async (defect) => {
    const f = fixture();
    await f.stopped();
    if (defect === 'missing-admission') unlinkSync(f.admission);
    if (defect === 'extra-admission') writeFileSync(join(f.admissions, 'unknown'), '{}');
    if (defect === 'changed-admission') writeFileSync(f.admission, '{}');
    if (defect === 'grant') writeFileSync(join(f.binding.directory, 'grant.json'), '{}');
    if (defect === 'active') {
      const path = join(f.binding.directory, 'permission.json'),
        permission = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...permission, active: true }));
    }
    if (defect === 'missing-stop') unlinkSync(join(f.binding.directory, 'stopped.json'));
    if (defect === 'live') f.state.alive = true;
    if (defect === 'unknown-writer') unlinkSync(join(f.binding.directory, 'writer-stopped.json'));
    if (defect === 'pending-check')
      writeFileSync(join(f.binding.directory, 'checks-baseline-intent.json'), '{}');
    const published = vi.spyOn(files, 'publishFile');
    await expect(f.inspect()).rejects.toThrow();
    expect(published).not.toHaveBeenCalled();
    await expect(f.recover()).rejects.toThrow();
    expect(existsSync(f.owner)).toBe(true);
    expect(readFileSync(f.binding.reservation)).toEqual(f.binding.grant);
    expect(f.state.starts).toBe(3);
  });
  it.each(['mutation', 'replaced', 'missing-copy'])(
    'keeps the former host and reservation when its stopped copy has %s',
    async (defect) => {
      const f = fixture(),
        { snapshot } = await f.stopped(),
        body = f.read(snapshot),
        copy = (body.copy as { root: string }).root;
      if (defect === 'mutation')
        writeFileSync(join(copy, 'owner.cjs'), 'changed after primary stop');
      if (defect === 'replaced') {
        renameSync(copy, copy + '-original');
        mkdirSync(copy);
      }
      if (defect === 'missing-copy') rmSync(copy, { recursive: true });
      const published = vi.spyOn(files, 'publishFile');
      await expect(f.inspect()).rejects.toThrow();
      expect(published).not.toHaveBeenCalled();
      await expect(f.recover()).rejects.toThrow();
      expect(existsSync(f.owner)).toBe(true);
      expect(readFileSync(f.binding.reservation)).toEqual(f.binding.grant);
      expect(f.state.creates).toBe(1);
    },
  );
  it.each(['lost-runtime', 'lost-intent', 'outer-writer'])(
    'keeps an incomplete linked operation inventory unknown: %s',
    async (defect) => {
      const f = fixture(),
        { stop } = await f.stopped(defect === 'lost-intent');
      if (defect === 'lost-runtime') {
        unlinkSync(join(f.binding.directory, 'writer-runtime.json'));
        f.state.alive = true;
      }
      if (defect === 'lost-intent')
        unlinkSync(join(f.binding.directory, 'checks-baseline-intent.json'));
      if (defect === 'outer-writer')
        writeFileSync(
          join(f.binding.directory, 'stopped.json'),
          JSON.stringify(f.save({ ...f.read(stop), writer: f.proof })),
        );
      await expect(f.inspect()).rejects.toThrow();
      await expect(f.recover()).rejects.toThrow();
      expect(existsSync(f.owner)).toBe(true);
      expect(readFileSync(f.binding.reservation)).toEqual(f.binding.grant);
    },
  );
  it('rechecks the whole inventory, journal and process outcome before releasing anything', async () => {
    const f = fixture();
    await f.stopped();
    const inspection = await f.inspect(),
      original = readFileSync(f.admission);
    writeFileSync(f.admission, '{}');
    await expect(inspection.recheck()).rejects.toThrow('task-recovery-journal-changed');
    writeFileSync(f.admission, original);
    f.state.alive = true;
    await expect(inspection.recheck()).rejects.toThrow('task-recovery-writer-changed');
    expect(existsSync(f.owner)).toBe(true);
    expect(existsSync(f.binding.reservation)).toBe(true);
  });
});

it('issues only a bound no-start stop, checks late changes and finishes a partial publication', async () => {
  const f = await taskHumanLocalFixture(false),
    id = 'former',
    host = { id, pid: 2147483646 };
  const input = parseLocalTask(f.input);
  const root = files.privateDirectory(join(f.root, 'former-host')),
    admissions = files.privateDirectory(join(root, 'task-admissions-v2', id));
  const verifiedFiles = taskFiles(f.registration.artifactRoot),
    source = verifiedFiles.binding(f.workspace);
  const binding = taskGateBinding(input, source, f.profile, f.registration.artifactRoot, id);
  const dir = files.privateDirectory(binding.directory),
    copy = verifiedFiles.binding(files.privateDirectory(join(f.root, 'copy')));
  const put = (name: string, value: unknown) =>
    files.publishFile(join(dir, name), Buffer.from(JSON.stringify(value)));
  files.publishFile(
    join(root, 'host-owner'),
    Buffer.from(JSON.stringify({ ...host, tasks: true, taskBindings: 3 })),
  );
  files.publishFile(
    join(admissions, files.digest(taskAdmissionIdentity(input))),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        host,
        input: input,
        gate: {
          directory: dir,
          grant: { sha256: files.digest(binding.grant), bytes: binding.grant.length },
          mode: 'owned',
        },
      }),
    ),
  );
  files.publishFile(join(dir, 'grant.json'), binding.grant);
  put('permission.json', { schemaVersion: 1, grant: files.digest(binding.grant), active: false });
  put('revoked.json', { schemaVersion: 1, grant: files.digest(binding.grant) });
  mkdirSync(join(dir, 'writer-effects'));
  writeFileSync(join(copy.root, 'owner'), 'original');
  const tree = verifiedFiles.tree(copy.root),
    name = input.baseline,
    command = { executable: '/bin/false', args: [], timeoutMs: 1, sha256: '0'.repeat(64) };
  const snapshot = verifiedFiles.save({
    input: input,
    source,
    copy,
    tree,
    commands: { [name]: command },
  });
  put('snapshot.json', snapshot);
  writeFileSync(join(copy.root, 'cache'), 'captured');
  const proof = verifiedFiles.save({
    kind: 'task-check',
    input: input,
    name,
    stage: 'baseline',
    status: 'FAIL',
    command,
    before: tree,
    after: verifiedFiles.tree(copy.root),
    stop: { confirmed: true, processes: [{ pid: host.pid, parent: 1, started: 'gone' }] },
  });
  const baseline = verifiedFiles.save({
    kind: 'task-checks',
    stage: 'baseline',
    status: 'FAIL',
    snapshot,
    input: input,
    tree,
    outcomes: [{ name, status: 'FAIL', proof }],
  });
  put('checks-baseline.json', { status: 'FAIL', manifest: baseline });
  put('checks-baseline-intent.json', {
    snapshot,
    stage: 'baseline',
    result: null,
    integration: null,
  });
  const scope = {
    source,
    directory: dir,
    taskKey: localTaskKey(input),
    attempt: 0,
    grant: { sha256: files.digest(binding.grant), bytes: binding.grant.length },
  };
  for (const kind of ['unstarted-baseline-stop', 'unrelated-recovery']) {
    const lock = permissionLocks.takeTaskRecoveryLock(join(root, 'test-recovery-lock'));
    try {
      const owner = lock.owner(f.registration.artifactRoot, {
        kind,
        permission: { ...scope, attempt: 1 },
      });
      expect(() => permissionLocks.taskPermissionLock(scope, owner, true).acquire()).toThrow(
        'task-lock-recovery-scope',
      );
      expect(() => permissionLocks.taskPermissionLock(scope, owner).acquire()).toThrow(
        'task-lock-recovery-scope',
      );
    } finally {
      lock.release();
    }
  }
  const recover = (ref = baseline) =>
    recoverUnstartedBaseline(f.registration, root, input, f.profile, { snapshot, baseline: ref });
  await expect(recover(snapshot)).rejects.toThrow('task-baseline-stop-binding');
  writeFileSync(join(copy.root, 'cache'), 'late');
  await expect(recover()).rejects.toThrow('task-baseline-stop-binding');
  writeFileSync(join(copy.root, 'cache'), 'captured');
  put('writer-runtime.json', {});
  await expect(recover()).rejects.toThrow('task-writer-runtime-unknown');
  unlinkSync(join(dir, 'writer-runtime.json'));
  expect(existsSync(join(dir, 'stopped.json'))).toBe(false);
  const first = await recover();
  unlinkSync(join(dir, 'stopped.json'));
  expect(await recover()).toEqual(first);
  expect(await recover()).toEqual(first);
});
