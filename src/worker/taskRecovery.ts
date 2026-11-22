import { existsSync, lstatSync, realpathSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ReaderProjectHost } from './readerHost.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { LocalTaskInput } from '../contracts/localTask.js';
import type {
  TaskPermissionOwner,
  TaskPermissionOwnerRef,
  TaskPermissionScope,
  TaskHostAdmission,
} from '../contracts/taskRecovery.js';
import { exactFields, object, parseProject, requireContract, text } from '../contracts/project.js';
import { parseLocalTask } from '../policy/localTask.js';
import { taskAdmissionIdentity, taskAdmissionsRelativePath } from '../policy/taskRecovery.js';
import { checkRegistration } from '../policy/preparation.js';
import { captureRegistration } from '../adapters/project/preparation.js';
import {
  artifactStore,
  digest,
  readPrivateFile,
  syncDirectory,
} from '../adapters/artifacts/files.js';
import { taskGateBinding } from '../adapters/project/taskGate.js';
import { inspectStoppedTask } from '../adapters/project/stoppedTask.js';
import { requireTaskHumanCompletionSeal } from '../activities/taskHumanCompletion.js';
import { controlRef } from '../policy/readerControl.js';
import { localTaskKey } from '../policy/localTask.js';
import {
  taskPermissionBytes,
  taskPermissionDirectoryIdentity,
  parseTaskPermissionOwnerRef,
  recoverTaskPermissionLock,
} from '../adapters/project/taskPermissionLock.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';

// This observes a closed former host; it never grants, starts or repeats task work.
export async function inspectTaskAdmissions(
  projects: ReaderProjectHost[],
  root: string,
  host: { pid: number; id: string },
  assignments: LocalTaskInput[],
  version: 1 | 2 | 3 = 1,
) {
  projects = projects.map((project) => ({
    ...project,
    registration: captureRegistration(project.registration),
  }));
  const admissions = join(root, taskAdmissionsRelativePath(host.id, version)),
    inputs = assignments.map(parseLocalTask),
    keys = inputs.map((input) => digest(taskAdmissionIdentity(input))).sort();
  function directoryIdentity() {
    const stat = lstatSync(admissions);
    requireContract(
      stat.isDirectory() && realpathSync(admissions) === admissions,
      'task-recovery-admission-directory-unsafe',
    );
    return [stat.dev, stat.ino];
  }
  const initialDirectory = version === 2 || version === 3 ? directoryIdentity() : null;
  requireContract(
    new Set(keys).size === keys.length && same(readdirSync(admissions).sort(), keys),
    'task-recovery-inventory-incomplete',
  );
  const stamps = new Map<string, Buffer>();
  const retained = (path: string) => {
    const bytes = readPrivateFile(path);
    stamps.set(path, bytes);
    return object(JSON.parse(bytes.toString()));
  };
  const observed = [];
  const checks: (() => Promise<void>)[] = [];
  const reservations: (() => void)[] = [];
  const completions: {
    reservation: string;
    home: string;
    token: Buffer;
    lock: ReturnType<typeof taskPermissionBytes> | null;
    scope: TaskPermissionScope;
    owner: TaskPermissionOwnerRef;
    assertUnchanged(): void;
    inspect(): Promise<Awaited<ReturnType<typeof inspectStoppedTask>>>;
  }[] = [];
  for (const input of inputs) {
    const project = projects.find(
      (p) =>
        parseProject(p.registration.project).projectId ===
        input.admission.preparation.project.projectId,
    );
    requireContract(
      project !== undefined && project.localTasks !== undefined,
      'task-recovery-project-unregistered',
    );
    const registration = project.registration,
      artifactStat = lstatSync(registration.artifactRoot);
    checkRegistration(input.admission.preparation, registration);
    requireContract(
      realpathSync(registration.workspaceRoot) === registration.workspaceRoot &&
        realpathSync(registration.artifactRoot) === registration.artifactRoot &&
        artifactStat.isDirectory(),
      'task-recovery-root-unsafe',
    );
    const stat = lstatSync(registration.workspaceRoot),
      source = { root: registration.workspaceRoot, dev: String(stat.dev), ino: String(stat.ino) },
      original = taskGateBinding(
        input,
        source,
        project.localTasks.profile,
        registration.artifactRoot,
        host.id,
      ),
      path = join(admissions, digest(taskAdmissionIdentity(input))),
      declaration = retained(path),
      mode = object(declaration.gate).mode;
    requireContract(mode === 'owned' || mode === 'retained', 'task-recovery-admission-mismatch');
    const priorInstance =
      mode === 'retained'
        ? text(
            object(JSON.parse(readPrivateFile(join(original.directory, 'grant.json')).toString()))
              .instance,
          )
        : host.id;
    requireContract(
      mode !== 'retained' || priorInstance !== host.id,
      'task-recovery-admission-mismatch',
    );
    const binding =
        mode === 'owned'
          ? original
          : taskGateBinding(
              input,
              source,
              project.localTasks.profile,
              registration.artifactRoot,
              priorInstance,
            ),
      record: TaskHostAdmission = {
        schemaVersion: 1,
        host,
        input,
        gate: {
          directory: binding.directory,
          grant: { sha256: digest(binding.grant), bytes: binding.grant.length },
          mode,
        },
      };
    requireContract(same(declaration, record), 'task-recovery-admission-mismatch');
    if (
      existsSync(binding.reservation) &&
      readPrivateFile(binding.reservation).equals(binding.grant)
    ) {
      function settledReservation() {
        requireContract(
          !readdirSync(binding.home).some((name) => name.startsWith('.pending-')),
          'task-recovery-reservation-publication-unknown',
        );
        return taskPermissionBytes(binding.reservation);
      }
      const originalReservation = settledReservation();
      requireContract(
        originalReservation.bytes.equals(binding.grant),
        'task-recovery-reservation-changed',
      );
      stamps.set(binding.reservation, originalReservation.bytes);
      reservations.push(() => {
        stopped.assertUnchanged();
        const current = settledReservation();
        requireContract(
          current.identity === originalReservation.identity &&
            current.bytes.equals(originalReservation.bytes),
          'task-recovery-reservation-changed',
        );
        unlinkSync(binding.reservation);
        syncDirectory(binding.home);
      });
    }
    let completion: {
      token: ArtifactRef;
      lock: ArtifactRef | null;
      seal: ReturnType<typeof controlRef>;
      owner: TaskPermissionOwnerRef;
      scope: TaskPermissionScope;
    } | null = null;
    if (
      version === 3 &&
      existsSync(binding.reservation) &&
      !readPrivateFile(binding.reservation).equals(binding.grant)
    ) {
      const token = taskPermissionBytes(binding.reservation),
        body = object(JSON.parse(token.bytes.toString()) as unknown);
      requireContract(
        body.schemaVersion === 2 &&
          body.kind === 'task-human-completion' &&
          typeof body.taskAdmission === 'string' &&
          typeof body.nonce === 'string' &&
          body.nonce.length > 0,
        'task-recovery-completion-token',
      );
      if (
        body.taskKey === localTaskKey(input) &&
        body.taskAdmission === taskAdmissionIdentity(input)
      ) {
        requireContract(input.schemaVersion === 12, 'task-recovery-completion-input');
        exactFields(body, [
          'schemaVersion',
          'owner',
          'kind',
          'taskKey',
          'taskAdmission',
          'seal',
          'ownerPid',
          'nonce',
        ]);
        const owner = parseTaskPermissionOwnerRef(body.owner),
          ownerBytes = taskPermissionBytes(join(root, 'host-owner')),
          store = artifactStore(registration.artifactRoot, { existingOnly: true });
        requireContract(
          owner.kind === 'host' &&
            owner.root === root &&
            owner.rootIdentity === taskPermissionDirectoryIdentity(root) &&
            owner.id === host.id &&
            owner.pid === host.pid &&
            body.ownerPid === host.pid &&
            owner.artifactRoot === registration.artifactRoot &&
            store.read(owner.record).equals(ownerBytes.bytes),
          'task-recovery-completion-owner',
        );
        const seal = requireTaskHumanCompletionSeal(registration, input, {
          seal: controlRef(body.seal),
        });
        const scope: TaskPermissionScope = {
          source,
          directory: binding.directory,
          taskKey: localTaskKey(input),
          attempt: input.continuation.attempt,
          grant: { sha256: digest(binding.grant), bytes: binding.grant.length },
        };
        const lockPath = join(binding.directory, 'permission-lock'),
          lock = existsSync(lockPath) ? taskPermissionBytes(lockPath) : null;
        if (lock !== null) {
          const stamp = object(JSON.parse(lock.bytes.toString()) as unknown);
          requireContract(
            stamp.schemaVersion === 1 &&
              stamp.kind === 'task-permission-lock' &&
              same(stamp.scope, scope) &&
              same(parseTaskPermissionOwnerRef(stamp.owner), owner),
            'task-recovery-completion-lock',
          );
        }
        const permitPins = ['grant.json', 'permission.json', 'revoked.json', 'stopped.json'].map(
          (name) => {
            const path = join(binding.directory, name);
            return { path, ...taskPermissionBytes(path) };
          },
        );
        const pin = () => {
          requireContract(
            !readdirSync(binding.home).some((name) => name.startsWith('.pending-')),
            'task-recovery-completion-publication-unknown',
          );
          const current = taskPermissionBytes(binding.reservation),
            hostNow = taskPermissionBytes(join(root, 'host-owner'));
          requireContract(
            current.identity === token.identity &&
              current.bytes.equals(token.bytes) &&
              hostNow.identity === ownerBytes.identity &&
              hostNow.bytes.equals(ownerBytes.bytes),
            'task-recovery-completion-changed',
          );
          for (const before of permitPins) {
            const now = taskPermissionBytes(before.path);
            requireContract(
              now.identity === before.identity && now.bytes.equals(before.bytes),
              'task-recovery-completion-permission-changed',
            );
          }
          requireTaskHumanCompletionSeal(registration, input, { seal: seal.ref });
        };
        pin();
        completions.push({
          reservation: binding.reservation,
          home: binding.home,
          token: token.bytes,
          lock,
          scope,
          owner,
          assertUnchanged: pin,
          async inspect() {
            const fresh = await inspectStoppedTask(inspection);
            requireContract(
              same(fresh.outcome, stopped.outcome) && same(fresh.writers, stopped.writers),
              'task-recovery-completion-stop-changed',
            );
            return fresh;
          },
        });
        completion = {
          token: store.publish(token.bytes),
          lock: lock === null ? null : store.publish(lock.bytes),
          seal: seal.ref,
          owner,
          scope,
        };
      } else
        requireContract(
          inputs.some(
            (other) =>
              localTaskKey(other) === body.taskKey &&
              taskAdmissionIdentity(other) === body.taskAdmission,
          ),
          'task-recovery-completion-inventory',
        );
    }
    const inspection = {
      input,
      source,
      artifacts: {
        root: registration.artifactRoot,
        dev: String(artifactStat.dev),
        ino: String(artifactStat.ino),
      },
      directory: binding.directory,
      grant: binding.grant,
      processes: project.localTasks.processes ?? new NativeWriterProcesses(),
    };
    const stopped = await inspectStoppedTask(inspection);
    checks.push(stopped.recheck);
    observed.push({
      admission: record,
      outcome: stopped.outcome,
      writers: stopped.writers,
      ...(completion === null ? {} : { completion }),
    });
  }
  function assertUnchanged() {
    if (initialDirectory !== null)
      requireContract(
        same(directoryIdentity(), initialDirectory),
        'task-recovery-admission-directory-changed',
      );
    requireContract(same(readdirSync(admissions).sort(), keys), 'task-recovery-inventory-changed');
    for (const [path, bytes] of stamps)
      requireContract(readPrivateFile(path).equals(bytes), 'task-recovery-journal-changed');
  }
  async function recheck() {
    assertUnchanged();
    for (const completion of completions) completion.assertUnchanged();
    for (const verify of checks) await verify();
    assertUnchanged();
  }
  await recheck();
  return {
    observed,
    recheck,
    needsCompletionOwner: completions.length > 0,
    assertRecoveryReleased(owner: TaskPermissionOwnerRef) {
      for (const completion of completions) {
        const path = join(completion.scope.directory, 'permission-lock');
        if (!existsSync(path)) continue;
        const retained = taskPermissionBytes(path),
          stamp = object(JSON.parse(retained.bytes.toString()) as unknown);
        requireContract(!same(stamp.owner, owner), 'task-recovery-owned-lock-retained');
      }
    },
    releaseReservations(current?: TaskPermissionOwner, assertFormer?: () => void) {
      if (completions.length === 0) {
        for (const release of reservations) release();
        return;
      }
      requireContract(
        current !== undefined && assertFormer !== undefined && current.ref.kind === 'recovery',
        'task-recovery-current-owner-required',
      );
      return (async () => {
        for (const completion of completions) {
          completion.assertUnchanged();
          const lock = recoverTaskPermissionLock(
            completion.scope,
            completion.owner,
            current,
            completion.lock,
            assertFormer,
          );
          try {
            const stopped = await completion.inspect();
            await stopped.recheck();
            current.assertCurrent();
            assertFormer();
            completion.assertUnchanged();
            stopped.assertUnchanged();
            assertUnchanged();
            lock.assert();
            unlinkSync(completion.reservation);
            syncDirectory(completion.home);
          } finally {
            lock.release();
          }
        }
        for (const release of reservations) release();
      })();
    },
  };
}
