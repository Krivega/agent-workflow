import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import type {
  TaskPermissionOwner,
  TaskPermissionOwnerRef,
  TaskPermissionScope,
} from '../../contracts/taskRecovery.js';
import { exactFields, object, requireContract } from '../../contracts/project.js';
import { controlRef } from '../../policy/readerControl.js';
import {
  artifactStore,
  digest,
  publishFile,
  readPrivateFile,
  syncDirectory,
} from '../artifacts/files.js';

function noPending(path: string) {
  requireContract(
    !readdirSync(path).some((name) => name.startsWith('.pending-')),
    'task-lock-publication-unknown',
  );
}
export function taskPermissionDirectoryIdentity(path: string) {
  noPending(path);
  const stat = lstatSync(path);
  requireContract(
    realpathSync(path) === path &&
      stat.isDirectory() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0,
    'task-lock-unsafe-directory',
  );
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(':');
}
export function taskPermissionBytes(path: string) {
  const stat = lstatSync(path);
  requireContract(
    realpathSync(path) === path &&
      stat.isFile() &&
      stat.nlink === 1 &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0,
    'task-lock-unsafe-file',
  );
  return {
    bytes: readPrivateFile(path),
    identity: [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink].join(':'),
  };
}
export function parseTaskPermissionOwnerRef(raw: unknown): TaskPermissionOwnerRef {
  const value = object(raw);
  exactFields(value, ['kind', 'root', 'rootIdentity', 'artifactRoot', 'record', 'pid', 'id']);
  requireContract(
    (value.kind === 'host' || value.kind === 'recovery') &&
      typeof value.root === 'string' &&
      typeof value.rootIdentity === 'string' &&
      value.rootIdentity.length > 0 &&
      typeof value.artifactRoot === 'string' &&
      typeof value.id === 'string' &&
      value.id.length > 0 &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 1,
    'task-lock-owner',
  );
  return {
    kind: value.kind,
    root: value.root,
    rootIdentity: value.rootIdentity,
    artifactRoot: value.artifactRoot,
    record: controlRef(value.record),
    pid: Number(value.pid),
    id: value.id,
  };
}
function ownerHandle(raw: TaskPermissionOwnerRef, path: string): TaskPermissionOwner {
  const ref = Object.freeze({ ...raw, record: Object.freeze({ ...raw.record }) });
  const rootIdentity = taskPermissionDirectoryIdentity(ref.root),
    initial = taskPermissionBytes(path),
    store = artifactStore(ref.artifactRoot, { existingOnly: true });
  requireContract(
    rootIdentity === ref.rootIdentity && store.read(ref.record).equals(initial.bytes),
    'task-lock-owner-binding',
  );
  function assertCurrent() {
    const now = taskPermissionBytes(path);
    requireContract(
      ref.pid === process.pid &&
        taskPermissionDirectoryIdentity(ref.root) === rootIdentity &&
        now.identity === initial.identity &&
        now.bytes.equals(initial.bytes) &&
        store.read(ref.record).equals(initial.bytes),
      'task-lock-current-owner-changed',
    );
  }
  assertCurrent();
  return { ref, assertCurrent };
}
export function taskHostPermissionOwner(
  root: string,
  artifactRoot: string,
  instance: string,
): TaskPermissionOwner {
  taskPermissionDirectoryIdentity(root);
  const path = join(root, 'host-owner'),
    initial = taskPermissionBytes(path),
    owner = object(JSON.parse(initial.bytes.toString()) as unknown);
  requireContract(
    owner.pid === process.pid &&
      owner.id === instance &&
      owner.tasks === true &&
      owner.taskBindings === 3,
    'task-lock-host-owner',
  );
  const record = artifactStore(artifactRoot).publish(initial.bytes);
  return ownerHandle(
    {
      kind: 'host',
      root,
      rootIdentity: taskPermissionDirectoryIdentity(root),
      artifactRoot,
      record,
      pid: process.pid,
      id: instance,
    },
    path,
  );
}
export function takeTaskRecoveryLock(root: string) {
  mkdirSync(root, { mode: 0o700 });
  const initial = taskPermissionDirectoryIdentity(root),
    pid = process.pid;
  let current: TaskPermissionOwner | null = null,
    publishing = false,
    released = false;
  function assertCurrent() {
    requireContract(
      !released && pid === process.pid && taskPermissionDirectoryIdentity(root) === initial,
      'task-recovery-lock-changed',
    );
    current?.assertCurrent();
  }
  return {
    assertCurrent,
    owner(artifactRoot: string, scope: unknown): TaskPermissionOwner {
      assertCurrent();
      requireContract(current === null && !publishing, 'task-recovery-owner-already-issued');
      publishing = true;
      const id = randomUUID(),
        bytes = Buffer.from(
          JSON.stringify({ schemaVersion: 1, kind: 'task-recovery-owner', pid, id, scope }),
        ),
        path = join(root, 'owner.json');
      const record = artifactStore(artifactRoot).publish(bytes);
      publishFile(path, bytes);
      syncDirectory(root);
      current = ownerHandle(
        { kind: 'recovery', root, rootIdentity: initial, artifactRoot, record, pid, id },
        path,
      );
      publishing = false;
      return current;
    },
    release() {
      assertCurrent();
      requireContract(!publishing, 'task-recovery-owner-publication-unknown');
      if (current !== null) {
        current.assertCurrent();
        unlinkSync(join(root, 'owner.json'));
        syncDirectory(root);
      }
      rmdirSync(root);
      released = true;
    },
  };
}
function recoveryScope(owner: TaskPermissionOwner, scope: TaskPermissionScope) {
  const record = object(
      JSON.parse(
        artifactStore(owner.ref.artifactRoot, { existingOnly: true })
          .read(owner.ref.record)
          .toString(),
      ) as unknown,
    ),
    bound = object(record.scope);
  requireContract(
    record.schemaVersion === 1 &&
      record.kind === 'task-recovery-owner' &&
      record.pid === owner.ref.pid &&
      record.id === owner.ref.id &&
      bound.kind === 'task-completion-recovery' &&
      Array.isArray(bound.tasks),
    'task-lock-recovery-scope',
  );
  const row = bound.tasks
    .map((entry) => object(entry))
    .find((entry) => entry.completion !== undefined && same(object(entry.completion).scope, scope));
  requireContract(row !== undefined, 'task-lock-recovery-scope');
  return object(row.completion);
}
function assertOwnerScope(
  owner: TaskPermissionOwner,
  scope: TaskPermissionScope,
  retainedStop: boolean,
) {
  owner.assertCurrent();
  if (owner.ref.kind === 'recovery') {
    if (retainedStop) {
      const record = object(
        JSON.parse(
          artifactStore(owner.ref.artifactRoot, { existingOnly: true })
            .read(owner.ref.record)
            .toString(),
        ),
      );
      const bound = object(record.scope);
      if (bound.kind === 'unstarted-baseline-stop') {
        requireContract(same(bound.permission, scope), 'task-lock-recovery-scope');
        return;
      }
    }
    recoveryScope(owner, scope);
  }
}
export function taskPermissionLock(
  scope: TaskPermissionScope,
  owner?: TaskPermissionOwner,
  retainedStop = false,
) {
  const path = join(scope.directory, 'permission-lock');
  let held: ReturnType<typeof taskPermissionBytes> | null = null,
    legacy = false;
  const bytes =
    owner === undefined
      ? null
      : Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            kind: 'task-permission-lock',
            scope,
            owner: owner.ref,
            nonce: randomUUID(),
          }),
        );
  function assert() {
    if (legacy) return;
    requireContract(held !== null && bytes !== null, 'task-lock-not-owned');
    assertOwnerScope(owner!, scope, retainedStop);
    const actual = taskPermissionBytes(path);
    requireContract(
      actual.identity === held.identity && actual.bytes.equals(bytes),
      'task-lock-changed',
    );
  }
  return {
    acquire() {
      requireContract(held === null && !legacy, 'task-lock-already-owned');
      if (owner === undefined) {
        mkdirSync(path, { mode: 0o700 });
        legacy = true;
        return;
      }
      assertOwnerScope(owner, scope, retainedStop);
      noPending(scope.directory);
      publishFile(path, bytes!);
      held = taskPermissionBytes(path);
      assert();
    },
    assert,
    release() {
      if (legacy) {
        rmdirSync(path);
        legacy = false;
        return;
      }
      if (held === null) return;
      assert();
      unlinkSync(path);
      syncDirectory(scope.directory);
      held = null;
    },
  };
}
export function recoverTaskPermissionLock(
  scope: TaskPermissionScope,
  former: TaskPermissionOwnerRef,
  current: TaskPermissionOwner,
  expected: ReturnType<typeof taskPermissionBytes> | null,
  assertFormer: () => void,
) {
  requireContract(
    former.kind === 'host' && current.ref.kind === 'recovery',
    'task-lock-recovery-binding',
  );
  current.assertCurrent();
  assertFormer();
  noPending(scope.directory);
  const permitted = recoveryScope(current, scope);
  requireContract(
    same(parseTaskPermissionOwnerRef(permitted.owner), former) &&
      (expected === null
        ? permitted.lock === null
        : same(controlRef(permitted.lock), {
            sha256: digest(expected.bytes),
            bytes: expected.bytes.length,
          })),
    'task-lock-recovery-scope',
  );
  const path = join(scope.directory, 'permission-lock');
  if (expected !== null) {
    const initial = taskPermissionBytes(path),
      stamp = object(JSON.parse(initial.bytes.toString()) as unknown);
    exactFields(stamp, ['schemaVersion', 'kind', 'scope', 'owner', 'nonce']);
    requireContract(
      initial.bytes.equals(expected.bytes) &&
        initial.identity === expected.identity &&
        stamp.schemaVersion === 1 &&
        stamp.kind === 'task-permission-lock' &&
        same(stamp.scope, scope) &&
        same(parseTaskPermissionOwnerRef(stamp.owner), former) &&
        typeof stamp.nonce === 'string' &&
        stamp.nonce.length > 0,
      'task-lock-recovery-stamp',
    );
    current.assertCurrent();
    assertFormer();
    const final = taskPermissionBytes(path);
    requireContract(
      final.identity === initial.identity && final.bytes.equals(initial.bytes),
      'task-lock-recovery-changed',
    );
    unlinkSync(path);
    syncDirectory(scope.directory);
  } else requireContract(!existsSync(path), 'task-lock-recovery-changed');
  const acquired = taskPermissionLock(scope, current);
  acquired.acquire();
  return acquired;
}
