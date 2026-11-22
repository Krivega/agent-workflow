import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { object } from '../../src/contracts/project.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import type { TaskPermissionScope } from '../../src/contracts/taskRecovery.js';
import {
  taskHostPermissionOwner,
  taskPermissionBytes,
  taskPermissionLock,
  takeTaskRecoveryLock,
} from '../../src/adapters/project/taskPermissionLock.js';
import { taskHumanCompletionGate } from '../../src/adapters/project/taskHumanCompletionGate.js';
import { taskGate, taskGateBinding } from '../../src/adapters/project/taskGate.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import { privateDirectory, publishFile } from '../../src/adapters/artifacts/files.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';

// Candidate-only real-FS unit contracts. Synthetic STOP/seal are not Activity or process proof.
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = substantialTaskFixture();
  const input: HumanManagedTaskInput = {
    ...f.substantialInput,
    schemaVersion: 12,
    startAdmission: f.proof,
    continuation: { attempt: 0, previous: null },
  };
  const source = taskFiles(f.registration.artifactRoot).binding(f.workspace);
  const instance = 'unit-host-origin';
  function owner(id: string) {
    const root = privateDirectory(join(f.root, id));
    publishFile(
      join(root, 'host-owner'),
      Buffer.from(JSON.stringify({ pid: process.pid, id, tasks: true, taskBindings: 3 })),
    );
    return taskHostPermissionOwner(root, f.registration.artifactRoot, id);
  }
  const currentOwner = owner(instance);
  const writer = taskGate(
    input,
    source,
    f.profile,
    f.registration.artifactRoot,
    instance,
    currentOwner,
  );
  writer.install();
  writer.freeze();
  const stopped = f.save({
    kind: 'synthetic-unit-stop',
    confirmed: true,
    input,
  });
  const seal = f.save({
    kind: 'synthetic-unit-completion-seal',
    input,
    stopped,
  });
  publishFile(join(writer.directory, 'stopped.json'), Buffer.from(JSON.stringify(stopped)));
  writer.release();
  const binding = taskGateBinding(input, source, f.profile, f.registration.artifactRoot, instance);
  const scope: TaskPermissionScope = {
    source,
    directory: writer.directory,
    taskKey: localTaskKey(input),
    attempt: 0,
    grant: f.store.publish(binding.grant),
  };
  const gate = taskHumanCompletionGate(
    input,
    source,
    f.profile,
    f.registration.artifactRoot,
    stopped,
    seal,
    currentOwner,
  );
  const path = join(scope.directory, 'permission-lock');
  const projection = join(f.workspace, input.admission.preparation.card);
  const beforeCard = readFileSync(projection);
  const effect = vi.fn(() => {
    writeFileSync(
      projection,
      Buffer.concat([beforeCard, Buffer.from('\nUNEXPECTED PROJECTION\n')]),
    );
    return f.save({ kind: 'unexpected-reply' });
  });
  function unchanged() {
    expect(effect).not.toHaveBeenCalled();
    expect(readFileSync(projection)).toEqual(beforeCard);
    expect(f.state.creates).toBe(0);
    expect(f.state.starts).toBe(0);
  }
  return {
    ...f,
    input,
    source,
    scope,
    gate,
    writer,
    currentOwner,
    owner,
    path,
    reservation: binding.reservation,
    effect,
    unchanged,
  };
}

describe('source-aware permission lock and completion callback ownership', () => {
  it('never mints a current recovery owner from an administrative directory it did not acquire', () => {
    const f = fixture();
    const path = join(f.root, 'old-administrative-lock');
    mkdirSync(path, { mode: 0o700 });
    const before = lstatSync(path);
    expect(() => takeTaskRecoveryLock(path)).toThrow();
    expect(lstatSync(path).ino).toBe(before.ino);
    expect(existsSync(join(path, 'owner.json'))).toBe(false);
    f.unchanged();
  });

  it('limits an actual recovery-owner handle to its declared source inventory and invalidates it on release', () => {
    const f = fixture();
    const admin = takeTaskRecoveryLock(join(f.root, 'owned-administrative-lock'));
    const owner = admin.owner(f.registration.artifactRoot, {
      kind: 'task-completion-recovery',
      tasks: [],
    });
    expect(owner.ref.kind).toBe('recovery');
    expect(owner.ref.pid).toBe(process.pid);
    owner.assertCurrent();
    const lock = taskPermissionLock(f.scope, owner);
    expect(() => lock.acquire()).toThrow();
    expect(existsSync(f.path)).toBe(false);
    admin.release();
    expect(() => owner.assertCurrent()).toThrow();
    f.unchanged();
  });
  it('uses one private regular lock and releases only its acquired exact owner', () => {
    const f = fixture();
    const lock = taskPermissionLock(f.scope, f.currentOwner);
    lock.acquire();
    const stamp = taskPermissionBytes(f.path);
    expect(lstatSync(f.path).isFile()).toBe(true);
    expect(lstatSync(f.path).mode & 0o777).toBe(0o600);
    expect(lstatSync(f.path).nlink).toBe(1);
    expect(object(JSON.parse(stamp.bytes.toString()) as unknown).owner).toEqual(f.currentOwner.ref);
    lock.assert();
    lock.release();
    lock.release();
    expect(existsSync(f.path)).toBe(false);
    expect(() => f.writer.assert()).toThrow();
    f.unchanged();
  });

  it('keeps the exact live foreign lock and refuses completion before projection/reply', () => {
    const f = fixture();
    const foreignOwner = f.owner('other-live-host');
    const foreign = taskPermissionLock(f.scope, foreignOwner);
    foreign.acquire();
    const before = taskPermissionBytes(f.path);
    expect(foreignOwner.ref.pid).toBe(process.pid);
    expect(() => f.gate.acquire()).toThrow();
    expect(() => f.gate.exclusive(f.effect)).toThrow();
    expect(taskPermissionBytes(f.path)).toEqual(before);
    expect(existsSync(f.reservation)).toBe(false);
    f.unchanged();
    foreign.release();
  });

  it('does not inspect an unknown foreign stamp into permission or remove its bytes', () => {
    const f = fixture();
    publishFile(f.path, Buffer.from('UNKNOWN FOREIGN LOCK'));
    const before = taskPermissionBytes(f.path);
    expect(() => f.gate.acquire()).toThrow();
    expect(() => f.gate.exclusive(f.effect)).toThrow();
    expect(taskPermissionBytes(f.path)).toEqual(before);
    f.unchanged();
  });

  it('retains ownerless legacy mkdir semantics without granting a recovery-capable stamp', () => {
    const f = fixture();
    const old = taskPermissionLock(f.scope);
    old.acquire();
    old.assert();
    expect(lstatSync(f.path).isDirectory()).toBe(true);
    expect(() => f.gate.acquire()).toThrow();
    expect(() => f.gate.exclusive(f.effect)).toThrow();
    expect(lstatSync(f.path).isDirectory()).toBe(true);
    f.unchanged();
    old.release();
    expect(existsSync(f.path)).toBe(false);
  });

  it('never claims or deletes a pre-existing empty directory from an old host', () => {
    const f = fixture();
    mkdirSync(f.path, { mode: 0o700 });
    const before = lstatSync(f.path);
    expect(() => f.gate.acquire()).toThrow();
    expect(() => f.gate.exclusive(f.effect)).toThrow();
    expect(lstatSync(f.path).ino).toBe(before.ino);
    expect(lstatSync(f.path).isDirectory()).toBe(true);
    f.unchanged();
  });

  it('retains a link-before-unlink partial publication as UNKNOWN, including its pending name', () => {
    const f = fixture();
    const lock = taskPermissionLock(f.scope, f.currentOwner);
    lock.acquire();
    const bytes = readFileSync(f.path);
    const pending = join(f.scope.directory, '.pending-synthetic-interrupted-publication');
    linkSync(f.path, pending);
    expect(lstatSync(f.path).nlink).toBe(2);
    expect(() => lock.assert()).toThrow();
    expect(() => lock.release()).toThrow();
    expect(() => f.gate.exclusive(f.effect)).toThrow();
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(readFileSync(pending)).toEqual(bytes);
    expect(lstatSync(f.path).nlink).toBe(2);
    f.unchanged();
  });

  it('refuses identical-byte inode replacement before own release', () => {
    const f = fixture();
    const lock = taskPermissionLock(f.scope, f.currentOwner);
    lock.acquire();
    const initial = taskPermissionBytes(f.path);
    const replacement = f.path + '.foreign-replacement';
    publishFile(replacement, initial.bytes);
    renameSync(replacement, f.path);
    const foreign = taskPermissionBytes(f.path);
    expect(foreign.bytes).toEqual(initial.bytes);
    expect(foreign.identity).not.toBe(initial.identity);
    expect(() => lock.assert()).toThrow();
    expect(() => lock.release()).toThrow();
    expect(taskPermissionBytes(f.path)).toEqual(foreign);
    f.unchanged();
  });

  it.each(['mode', 'owner-bytes'] as const)(
    'does not release or enter a completion callback after %s mutation',
    (defect) => {
      const f = fixture();
      const lock = taskPermissionLock(f.scope, f.currentOwner);
      lock.acquire();
      const before = readFileSync(f.path);
      if (defect === 'mode') chmodSync(f.path, 0o644);
      else writeFileSync(join(f.currentOwner.ref.root, 'host-owner'), 'changed current host');
      expect(() => lock.assert()).toThrow();
      expect(() => lock.release()).toThrow();
      expect(readFileSync(f.path)).toEqual(before);
      f.unchanged();
    },
  );

  it.each(['grant.json', 'permission.json', 'revoked.json', 'stopped.json'])(
    'refuses a changed %s pin before a projection/reply callback',
    (name) => {
      const f = fixture();
      f.gate.acquire();
      const reservation = readFileSync(f.reservation);
      const path = join(f.scope.directory, name);
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
      expect(() => f.gate.exclusive(f.effect)).toThrow();
      expect(readFileSync(f.reservation)).toEqual(reservation);
      f.unchanged();
    },
  );

  it('retains a competing foreign lock replacement rather than cleaning it as same-owner work', () => {
    const f = fixture();
    const own = taskPermissionLock(f.scope, f.currentOwner);
    own.acquire();
    unlinkSync(f.path);
    const other = taskPermissionLock(f.scope, f.owner('gap-winner'));
    other.acquire();
    const winner = taskPermissionBytes(f.path);
    expect(() => own.release()).toThrow();
    expect(() => f.gate.exclusive(f.effect)).toThrow();
    expect(taskPermissionBytes(f.path)).toEqual(winner);
    f.unchanged();
    other.release();
  });
});
