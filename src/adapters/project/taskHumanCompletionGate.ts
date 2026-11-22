import { existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { HumanManagedTaskInput, TaskBinding } from '../../contracts/localTask.js';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type { ReaderExecution } from '../../contracts/readerControl.js';
import { exactFields, object, requireContract } from '../../contracts/project.js';
import { controlRef } from '../../policy/readerControl.js';
import { taskAdmissionIdentity } from '../../policy/taskRecovery.js';
import { localTaskKey } from '../../policy/localTask.js';
import {
  artifactStore,
  digest,
  publishFile,
  readPrivateFile,
  syncDirectory,
} from '../artifacts/files.js';
import { taskBackendGuard } from './taskBackend.js';
import { taskGateBinding } from './taskGate.js';
import type { TaskPermissionOwner } from '../../contracts/taskRecovery.js';
import { taskPermissionLock } from './taskPermissionLock.js';
import { taskFiles } from './taskFiles.js';

/** Completion-only reservation after trusted STOP inspection; never installs a Writer lease. */
export function taskHumanCompletionGate(
  input: HumanManagedTaskInput,
  source: TaskBinding,
  profile: ReaderExecution['profile'],
  artifactRoot: string,
  stopped: ArtifactRef,
  seal: ArtifactRef,
  owner?: TaskPermissionOwner,
  kind: 'task-human-completion' | 'task-integrated-recheck' = 'task-human-completion',
) {
  const binding = taskGateBinding(input, source, profile, artifactRoot, 'completion-only'),
    expected = object(JSON.parse(binding.grant.toString('utf8')) as unknown),
    { home, directory, reservation } = binding,
    backend = taskBackendGuard(source.root),
    store = artifactStore(artifactRoot, { existingOnly: true }),
    files = taskFiles(artifactRoot, { existingOnly: true }),
    sourceBinding = { ...source },
    stoppedRef = controlRef(stopped),
    sealRef = controlRef(seal),
    token = Buffer.from(
      JSON.stringify({
        ...(owner === undefined
          ? {}
          : { schemaVersion: 2, owner: owner.ref, taskAdmission: taskAdmissionIdentity(input) }),
        kind,
        taskKey: localTaskKey(input),
        seal: sealRef,
        ownerPid: process.pid,
        nonce: randomUUID(),
      }),
    );
  requireContract(owner === undefined || owner.ref.kind === 'host', 'human-completion-host-owner');
  const paths = ['grant.json', 'permission.json', 'revoked.json', 'stopped.json'].map((name) =>
    join(directory, name),
  );
  function plain(path: string) {
    const info = lstatSync(path);
    requireContract(
      realpathSync(path) === path && info.isFile() && info.nlink === 1,
      'human-completion-unsafe-file',
    );
    return info;
  }
  const pins = paths.map((path) => {
    const stat = plain(path),
      bytes = readPrivateFile(path);
    return {
      path,
      bytes,
      identity: [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink].join(':'),
    };
  });
  const old = object(JSON.parse(pins[0]!.bytes.toString('utf8')) as unknown);
  exactFields(old, ['schemaVersion', 'input', 'source', 'profile', 'artifactRoot', 'instance']);
  requireContract(
    typeof old.instance === 'string' &&
      old.instance.length > 0 &&
      isDeepStrictEqual({ ...old, instance: 'completion-only' }, expected),
    'human-completion-grant-binding',
  );
  const permission = object(JSON.parse(pins[1]!.bytes.toString('utf8')) as unknown),
    revoked = object(JSON.parse(pins[2]!.bytes.toString('utf8')) as unknown);
  exactFields(permission, ['schemaVersion', 'grant', 'active']);
  exactFields(revoked, ['schemaVersion', 'grant']);
  requireContract(
    permission.schemaVersion === 1 &&
      permission.active === false &&
      permission.grant === digest(pins[0]!.bytes) &&
      revoked.schemaVersion === 1 &&
      revoked.grant === permission.grant,
    'human-completion-writer-not-revoked',
  );
  requireContract(
    isDeepStrictEqual(
      controlRef(JSON.parse(pins[3]!.bytes.toString('utf8')) as unknown),
      stoppedRef,
    ),
    'human-completion-stop-binding',
  );
  const sealBytes = store.read(sealRef),
    stopBytes = store.read(stoppedRef);
  let acquired = false;
  function closed() {
    owner?.assertCurrent();
    if (owner !== undefined)
      requireContract(
        !readdirSync(home).some((name) => name.startsWith('.pending-')),
        'human-completion-publication-unknown',
      );
    backend.require(
      input.admission.preparation.project.projectId,
      input.admission.preparation.taskId,
      'temporal',
      'worker',
      input.admission.preparation.card,
    );
    requireContract(
      isDeepStrictEqual(files.binding(sourceBinding.root), sourceBinding),
      'human-completion-source-changed',
    );
    for (const pin of pins) {
      const stat = plain(pin.path);
      requireContract(
        [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink].join(':') ===
          pin.identity && readPrivateFile(pin.path).equals(pin.bytes),
        'human-completion-pins-changed',
      );
    }
    requireContract(
      store.read(sealRef).equals(sealBytes) && store.read(stoppedRef).equals(stopBytes),
      'human-completion-artifact-changed',
    );
  }
  function locked<T>(run: () => T): T {
    const lock = taskPermissionLock(
      {
        source: sourceBinding,
        directory,
        taskKey: localTaskKey(input),
        attempt: input.continuation.attempt,
        grant: { sha256: digest(pins[0]!.bytes), bytes: pins[0]!.bytes.length },
      },
      owner,
    );
    lock.acquire();
    try {
      return run();
    } finally {
      lock.release();
    }
  }
  function assert() {
    closed();
    if (acquired) plain(reservation);
    requireContract(
      acquired && readPrivateFile(reservation).equals(token),
      'human-completion-reservation-changed',
    );
  }
  function releaseOwned() {
    if (!existsSync(reservation)) {
      acquired = false;
      return;
    }
    requireContract(
      readPrivateFile(reservation).equals(token),
      'human-completion-reservation-changed',
    );
    unlinkSync(reservation);
    syncDirectory(home);
    acquired = false;
  }
  return {
    directory,
    acquire() {
      locked(() => {
        closed();
        if (acquired) {
          assert();
          return;
        }
        requireContract(!existsSync(reservation), 'human-completion-source-reserved');
        // publishFile uses an exclusive link and never overwrites another source owner.
        publishFile(reservation, token);
        acquired = true;
        try {
          assert();
        } catch (error) {
          releaseOwned();
          throw error;
        }
      });
    },
    assert,
    exclusive<T>(run: () => T): T {
      return locked(() => {
        assert();
        return run();
      });
    },
    release() {
      if (!acquired) return;
      locked(releaseOwned);
    },
  };
}
