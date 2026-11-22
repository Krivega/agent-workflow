import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { taskBackendGuard, taskBackendHome } from './taskBackend.js';
import type { TaskPermissionOwner } from '../../contracts/taskRecovery.js';
import { taskPermissionLock } from './taskPermissionLock.js';
import { randomUUID } from 'node:crypto';
import type { LocalTaskInput, TaskBinding } from '../../contracts/localTask.js';
import type { ReaderExecution } from '../../contracts/readerControl.js';
import { localTaskKey } from '../../policy/localTask.js';
import { object, requireContract } from '../../contracts/project.js';
import {
  digest,
  privateDirectory,
  publishFile,
  readPrivateFile,
  syncDirectory,
} from '../artifacts/files.js';

export function taskGateBinding(
  input: LocalTaskInput,
  source: TaskBinding,
  profile: ReaderExecution['profile'],
  artifactRoot: string,
  instance: string,
) {
  const home = taskBackendHome(source.root);
  const directory = join(
    home,
    'tasks',
    digest(localTaskKey(input)),
    ...(input.schemaVersion === 10 || input.schemaVersion === 11 || input.schemaVersion === 12
      ? [
          input.schemaVersion === 10 ? 'planning-attempts' : 'execution-attempts',
          String(input.continuation.attempt),
        ]
      : []),
  );
  const reservation = join(home, 'source-reservation');
  const grant = Buffer.from(
    JSON.stringify({ schemaVersion: 1, input, source, profile, artifactRoot, instance }),
  );
  return { home, directory, reservation, grant };
}

export function taskGate(
  input: LocalTaskInput,
  source: TaskBinding,
  profile: ReaderExecution['profile'],
  artifactRoot: string,
  instance: string,
  owner?: TaskPermissionOwner,
) {
  const backend = taskBackendGuard(source.root);
  const preparation = input.admission.preparation;
  const { home, directory, reservation, grant } = taskGateBinding(
    input,
    source,
    profile,
    artifactRoot,
    instance,
  );
  privateDirectory(home);
  privateDirectory(directory);
  const permission = join(directory, 'permission.json');
  const revoked = join(directory, 'revoked.json');
  function permissionLock(retainedStop = false) {
    const path = join(directory, 'grant.json'),
      retained = existsSync(path) ? readPrivateFile(path) : grant;
    return taskPermissionLock(
      {
        source,
        directory,
        taskKey: localTaskKey(input),
        attempt:
          input.schemaVersion === 10 || input.schemaVersion === 11 || input.schemaVersion === 12
            ? input.continuation.attempt
            : 0,
        grant: { sha256: digest(retained), bytes: retained.length },
      },
      owner,
      retainedStop,
    );
  }
  function locked<T>(run: () => T): T {
    const lock = permissionLock();
    lock.acquire();
    try {
      return run();
    } finally {
      lock.release();
    }
  }
  function install() {
    backend.require(
      preparation.project.projectId,
      preparation.taskId,
      'temporal',
      'worker',
      preparation.card,
    );
    return locked(() => {
      requireContract(
        !existsSync(join(directory, 'done.json')) && !existsSync(join(directory, 'stopped.json')),
        'task-already-closed',
      );
      requireContract(!existsSync(revoked), 'task-permit-revoked');
      if (existsSync(permission)) {
        const current = JSON.parse(readPrivateFile(permission).toString()) as {
          grant: string;
          active: boolean;
        };
        requireContract(current.grant === digest(grant) && current.active, 'task-permit-revoked');
      }
      try {
        publishFile(reservation, grant);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      requireContract(readPrivateFile(reservation).equals(grant), 'task-source-reserved');
      try {
        publishFile(join(directory, 'grant.json'), grant);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      requireContract(
        readPrivateFile(join(directory, 'grant.json')).equals(grant),
        'task-grant-conflict',
      );
      try {
        publishFile(
          permission,
          Buffer.from(JSON.stringify({ schemaVersion: 1, grant: digest(grant), active: true })),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      assert();
    });
  }
  function assert() {
    backend.require(
      preparation.project.projectId,
      preparation.taskId,
      'temporal',
      'worker',
      preparation.card,
    );
    requireContract(readPrivateFile(reservation).equals(grant), 'task-source-reserved');
    requireContract(!existsSync(revoked), 'task-permit-revoked');
    const p = JSON.parse(readPrivateFile(permission).toString()) as {
      schemaVersion: number;
      grant: string;
      active: boolean;
    };
    requireContract(
      p.schemaVersion === 1 && p.grant === digest(grant) && p.active,
      'task-permit-revoked',
    );
  }
  function freeze(before?: () => void) {
    return locked(() => {
      if (existsSync(join(directory, 'grant.json')))
        requireContract(
          readPrivateFile(join(directory, 'grant.json')).equals(grant),
          'task-grant-conflict',
        );
      const old = existsSync(permission)
        ? (JSON.parse(readPrivateFile(permission).toString()) as {
            schemaVersion: number;
            grant: string;
            active: boolean;
          })
        : null;
      requireContract(
        old === null || (old.schemaVersion === 1 && old.grant === digest(grant)),
        'task-grant-conflict',
      );
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, grant: digest(grant) }));
      if (existsSync(revoked))
        requireContract(readPrivateFile(revoked).equals(bytes), 'task-grant-conflict');
      before?.();
      try {
        publishFile(revoked, bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        requireContract(readPrivateFile(revoked).equals(bytes), 'task-grant-conflict');
      }
      if (old === null) return;
      const temp = join(directory, '.permission-' + randomUUID());
      publishFile(temp, Buffer.from(JSON.stringify({ ...old, active: false })));
      renameSync(temp, permission);
      syncDirectory(directory);
    });
  }
  function release() {
    if (!existsSync(reservation) || !readPrivateFile(reservation).equals(grant)) return;
    unlinkSync(reservation);
    syncDirectory(home);
  }
  function exclusive<T>(run: () => T): T {
    return locked(() => {
      assert();
      return run();
    });
  }
  function admission(): {
    directory: string;
    grant: { sha256: string; bytes: number };
    mode: 'owned' | 'retained';
  } {
    const path = join(directory, 'grant.json');
    if (!existsSync(path) || readPrivateFile(path).equals(grant))
      return { directory, grant: { sha256: digest(grant), bytes: grant.length }, mode: 'owned' };
    const bytes = readPrivateFile(path),
      prior = object(JSON.parse(bytes.toString()));
    requireContract(
      typeof prior.instance === 'string' &&
        Buffer.from(JSON.stringify({ ...prior, instance })).equals(grant),
      'task-grant-conflict',
    );
    return { directory, grant: { sha256: digest(bytes), bytes: bytes.length }, mode: 'retained' };
  }
  async function recordClosedStop<T>(
    observe: (grant: Buffer) => Promise<() => T>,
    retainedOnly: boolean,
  ): Promise<T> {
    const lock = permissionLock(retainedOnly);
    lock.acquire();
    try {
      const prior = readPrivateFile(join(directory, 'grant.json')),
        revocation = readPrivateFile(revoked),
        permissionBytes = readPrivateFile(permission);
      function closed() {
        const retained = admission(),
          r = object(JSON.parse(readPrivateFile(revoked).toString())),
          p = object(JSON.parse(readPrivateFile(permission).toString()));
        requireContract(
          (!retainedOnly || retained.mode === 'retained') &&
            readPrivateFile(join(directory, 'grant.json')).equals(prior) &&
            readPrivateFile(revoked).equals(revocation) &&
            readPrivateFile(permission).equals(permissionBytes) &&
            r.schemaVersion === 1 &&
            r.grant === digest(prior) &&
            p.schemaVersion === 1 &&
            p.grant === digest(prior) &&
            p.active === false,
          'task-retained-stop-permission',
        );
        requireContract(
          !existsSync(reservation) || readPrivateFile(reservation).equals(prior),
          'task-source-reserved',
        );
      }
      closed();
      const commit = await observe(Buffer.from(prior));
      closed();
      return commit();
    } finally {
      lock.release();
    }
  }
  async function recordRetainedStop<T>(observe: (grant: Buffer) => Promise<() => T>): Promise<T> {
    return recordClosedStop(observe, true);
  }
  async function recordStopped<T>(observe: (grant: Buffer) => Promise<() => T>): Promise<T> {
    return recordClosedStop(observe, false);
  }
  return {
    directory,
    binding: { directory, grant: { sha256: digest(grant), bytes: grant.length } },
    admission,
    recordRetainedStop,
    recordStopped,
    install,
    assert,
    freeze,
    release,
    exclusive,
  };
}
