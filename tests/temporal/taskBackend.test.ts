import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import * as files from '../../src/adapters/artifacts/files.js';
import {
  listTemporalTaskIds,
  requireLegacyCardBackend,
  requireTaskBackend,
  reserveTaskBackend,
  refuseUnroutedBackendConsumer,
  taskBackendHome,
  taskBackendGuard,
  taskBackendPolicy,
  type TaskBackendAssignment,
} from '../../src/adapters/project/taskBackend.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-backend-')));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const home = taskBackendHome(root);
  function policy(newTasks = 'temporal') {
    declareBackendFixture(root);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'backend-policy.json'),
      JSON.stringify({ schemaVersion: 1, newTasks }),
    );
  }
  const row: TaskBackendAssignment = {
    schemaVersion: 1,
    projectId: 'project',
    taskId: 'task',
    backend: 'legacy',
    cardName: 'one.md',
    origin: 'a'.repeat(64),
  };
  return { root, home, row, policy, path: join(home, 'backend-assignments/project/task.json') };
}
describe('immutable task backend assignment', () => {
  it('lists canonical Temporal assignments only for the registered project and route', () => {
    const f = fixture();
    f.policy();
    const route = { address: 'localhost:7233', namespace: 'default', taskQueue: 'tasks' };
    const list = () => listTemporalTaskIds(f.root, 'project', route);
    expect(list()).toEqual([]);
    reserveTaskBackend(f.root, f.row);
    expect(list()).toEqual([]);
    const row = {
      schemaVersion: 2,
      projectId: 'project',
      taskId: 'task',
      backend: 'temporal',
      cardName: 'one.md',
      origin: f.row.origin,
      startAdmission: { sha256: 'b'.repeat(64), bytes: 1 },
    };
    writeFileSync(f.path, JSON.stringify(row));
    expect(list()).toEqual([]);
    for (const changed of [
      { address: 'other' },
      { namespace: 'other' },
      { taskQueue: 'other' },
      {},
    ]) {
      writeFileSync(f.path, JSON.stringify({ ...row, route: { ...route, ...changed } }));
      expect(list()).toEqual(Object.keys(changed).length ? [] : ['task']);
    }
    renameSync(f.path, join(dirname(f.path), 'wrong.json'));
    expect(list).toThrow('backend-assignment-location');
  });
  it('requires an activation declaration and retains either declaration after losing the ledger', () => {
    const f = fixture();
    mkdirSync(f.home);
    writeFileSync(
      join(f.home, 'backend-policy.json'),
      JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
    );
    expect(() => taskBackendPolicy(f.root)).toThrow('backend-activation-required');
    f.policy();
    unlinkSync(join(f.root, '.agent-workflow-backend.json'));
    expect(taskBackendPolicy(f.root)).toMatchObject({ newTasks: 'temporal' });
    rmSync(f.home, { recursive: true });
    expect(() => taskBackendPolicy(f.root)).toThrow('backend-policy-required');
    unlinkSync(join(dirname(f.home), 'agent-workflow-backend.json'));
    writeFileSync(
      join(f.root, '.agent-workflow-backend.json'),
      JSON.stringify({ schemaVersion: 1, required: true }),
    );
    renameSync(join(f.root, '.git'), join(f.root, '.git-lost'));
    expect(() => taskBackendPolicy(f.root)).toThrow('backend-policy-required');
  });
  it('never falls back after observing activation, including a required restart after losing both declarations', () => {
    const f = fixture();
    f.policy();
    reserveTaskBackend(f.root, f.row);
    const guard = taskBackendGuard(f.root);
    expect(guard.require('project', 'task', 'legacy', 'legacy')).toEqual(f.row);
    rmSync(f.home, { recursive: true });
    unlinkSync(join(f.root, '.agent-workflow-backend.json'));
    unlinkSync(join(dirname(f.home), 'agent-workflow-backend.json'));
    expect(() => guard.require('project', 'task', 'legacy', 'legacy')).toThrow(
      'backend-policy-required',
    );
    expect(() =>
      taskBackendGuard(f.root, true).require('project', 'task', 'legacy', 'legacy'),
    ).toThrow('backend-policy-required');
  });
  it('rechecks the original workspace alias and rejects a Git root acquired after binding', () => {
    const f = fixture(),
      other = fixture();
    const alias = join(f.root, 'alias');
    symlinkSync(f.root, alias);
    const guard = taskBackendGuard(alias);
    unlinkSync(alias);
    symlinkSync(other.root, alias);
    expect(() => guard.assert()).toThrow('backend-workspace-changed');
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'aw-unbound-git-')));
    roots.push(plain);
    const unconfigured = taskBackendGuard(plain);
    execFileSync('git', ['init', '--quiet'], { cwd: plain });
    expect(() => unconfigured.assert()).toThrow('backend-git-root-changed');
  });
  it.each([
    { schemaVersion: 2, required: true },
    { schemaVersion: 1, required: false },
    { schemaVersion: 1, required: true, extra: true },
  ])('rejects an invalid declaration %j', (value) => {
    const f = fixture();
    f.policy();
    writeFileSync(join(f.root, '.agent-workflow-backend.json'), JSON.stringify(value));
    expect(() => taskBackendPolicy(f.root)).toThrow();
  });
  it('rejects linked declarations instead of treating them as missing', () => {
    const f = fixture();
    f.policy();
    const marker = join(f.root, '.agent-workflow-backend.json');
    linkSync(marker, join(f.root, 'linked-declaration'));
    expect(() => taskBackendPolicy(f.root)).toThrow('backend-declaration-linked');
  });
  it('keeps an unconfigured project unchanged, including non-Git qualification roots', () => {
    const f = fixture();
    expect(taskBackendPolicy(f.root)).toBeNull();
    expect(requireTaskBackend(f.root, 'project', 'task', 'temporal', 'sdk')).toBeNull();
    expect(() => requireLegacyCardBackend(f.root, 'project', 'one.md')).not.toThrow();
    expect(() => refuseUnroutedBackendConsumer(f.root)).not.toThrow();
    expect(existsSync(f.home)).toBe(false);
    const plain = join(f.root, 'plain');
    mkdirSync(plain);
    expect(taskBackendPolicy(plain)).toBeNull();
  });
  it('never reclassifies an inventoried old task after changing the new-task default', () => {
    const f = fixture();
    reserveTaskBackend(f.root, f.row);
    f.policy();
    const bytes = readFileSync(f.path);
    expect(
      requireTaskBackend(f.root, 'project', 'task', 'legacy', 'legacy', 'verifying/one.md'),
    ).toEqual(f.row);
    expect(() => requireTaskBackend(f.root, 'project', 'task', 'temporal', 'sdk')).toThrow(
      'backend-route-conflict',
    );
    f.policy('blocked');
    expect(requireTaskBackend(f.root, 'project', 'task', 'legacy', 'legacy')).toEqual(f.row);
    expect(readFileSync(f.path).equals(bytes)).toBe(true);
    expect(reserveTaskBackend(f.root, f.row)).toEqual(f.row);
    expect(() => reserveTaskBackend(f.root, { ...f.row, backend: 'temporal' })).toThrow(
      'backend-assignment-conflict',
    );
  });
  it('refuses missing assignments and unknown consumers before creating state', () => {
    const f = fixture();
    f.policy();
    expect(() => requireTaskBackend(f.root, 'project', 'task', 'legacy', 'legacy')).toThrow(
      'backend-assignment-required',
    );
    expect(() => requireLegacyCardBackend(f.root, 'project', 'one.md')).toThrow(
      'backend-assignment-required',
    );
    expect(() =>
      requireTaskBackend(f.root, 'project', 'task', 'legacy', 'foreign' as never),
    ).toThrow('backend-consumer-unknown');
    expect(() => refuseUnroutedBackendConsumer(f.root)).toThrow('backend-consumer-not-qualified');
    expect(existsSync(join(f.home, 'backend-assignments'))).toBe(false);
  });
  it('does not interpret a lost policy as permission to switch an assigned task', () => {
    const f = fixture();
    reserveTaskBackend(f.root, f.row);
    expect(() => taskBackendPolicy(f.root)).toThrow('backend-policy-required');
  });
  it.each([
    { schemaVersion: 2, newTasks: 'temporal' },
    { schemaVersion: 1, newTasks: 'legacy' },
    { schemaVersion: 1, newTasks: 'temporal', extra: true },
  ])('fails closed on unknown policy %j', (policy) => {
    const f = fixture();
    f.policy();
    writeFileSync(join(f.home, 'backend-policy.json'), JSON.stringify(policy));
    expect(() => taskBackendPolicy(f.root)).toThrow();
  });
  it('rejects linked and dangling policy files', () => {
    const f = fixture();
    f.policy();
    const path = join(f.home, 'backend-policy.json');
    linkSync(path, join(f.home, 'other'));
    expect(() => taskBackendPolicy(f.root)).toThrow('backend-policy-linked');
    unlinkSync(path);
    symlinkSync(join(f.home, 'missing'), path);
    expect(() => taskBackendPolicy(f.root)).toThrow();
  });
  it('rejects the same card or original source copied under another task ID', () => {
    const f = fixture();
    reserveTaskBackend(f.root, f.row);
    f.policy();
    expect(() => reserveTaskBackend(f.root, { ...f.row, taskId: 'clone' })).toThrow(
      'backend-task-alias',
    );
    expect(() =>
      reserveTaskBackend(f.root, { ...f.row, taskId: 'clone', cardName: 'renamed.md' }),
    ).toThrow('backend-task-alias');
    expect(existsSync(join(f.home, 'backend-assignments/project/assignment-lock'))).toBe(false);
    expect(() =>
      requireTaskBackend(f.root, 'project', 'task', 'legacy', 'legacy', 'other.md'),
    ).toThrow('backend-card-conflict');
  });
  it('allows distinct new tasks and preserves project isolation', () => {
    const f = fixture();
    reserveTaskBackend(f.root, f.row);
    f.policy();
    const other = {
      ...f.row,
      taskId: 'two',
      backend: 'temporal' as const,
      cardName: 'two.md',
      origin: 'b'.repeat(64),
    };
    reserveTaskBackend(f.root, other);
    reserveTaskBackend(f.root, { ...f.row, projectId: 'other' });
    expect(requireTaskBackend(f.root, 'project', 'two', 'temporal', 'worker')).toEqual(other);
    expect(() => requireLegacyCardBackend(f.root, 'project', 'one.md')).not.toThrow();
    expect(() => requireLegacyCardBackend(f.root, 'project', 'missing.md')).toThrow(
      'backend-assignment-required',
    );
    expect(() => requireLegacyCardBackend(f.root, 'project', 'two.md')).toThrow(
      'backend-route-conflict',
    );
  });
  it('retains unknown publication locks and rejects malformed assignments', () => {
    const f = fixture();
    const directory = join(f.home, 'backend-assignments/project');
    mkdirSync(directory, { recursive: true });
    const lock = join(directory, 'assignment-lock');
    mkdirSync(lock);
    expect(() => reserveTaskBackend(f.root, f.row)).toThrow('EEXIST');
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
    expect(() => reserveTaskBackend(f.root, { ...f.row, origin: 'unknown' })).toThrow(
      'backend-origin-invalid',
    );
    expect(() => reserveTaskBackend(f.root, { ...f.row, backend: 'foreign' as never })).toThrow(
      'backend-assignment-invalid',
    );
    expect(() => reserveTaskBackend(f.root, { ...f.row, cardName: 'dir/one.md' })).toThrow(
      'backend-card-invalid',
    );
  });
  it('refuses corrupt, linked and misplaced records', () => {
    const f = fixture();
    reserveTaskBackend(f.root, f.row);
    f.policy();
    writeFileSync(f.path, JSON.stringify(f.row, null, 2));
    expect(() => requireTaskBackend(f.root, 'project', 'task', 'legacy', 'legacy')).toThrow(
      'backend-assignment-noncanonical',
    );
    writeFileSync(f.path, JSON.stringify(f.row));
    linkSync(f.path, join(f.home, 'linked'));
    expect(() => requireTaskBackend(f.root, 'project', 'task', 'legacy', 'legacy')).toThrow(
      'backend-assignment-linked',
    );
    unlinkSync(join(f.home, 'linked'));
    writeFileSync(f.path, JSON.stringify({ ...f.row, projectId: 'foreign' }));
    expect(() =>
      reserveTaskBackend(f.root, {
        ...f.row,
        taskId: 'two',
        cardName: 'two.md',
        origin: 'b'.repeat(64),
      }),
    ).toThrow('backend-assignment-location');
    expect(() => requireTaskBackend(f.root, 'project', 'task', 'legacy', 'legacy')).toThrow(
      'backend-route-conflict',
    );
  });
  it('does not publish success after storage failure and releases only its own lock', () => {
    const f = fixture();
    vi.spyOn(files, 'publishFile').mockImplementation(() => {
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    });
    expect(() => reserveTaskBackend(f.root, f.row)).toThrow('full');
    expect(existsSync(f.path)).toBe(false);
    expect(existsSync(join(f.home, 'backend-assignments/project/assignment-lock'))).toBe(false);
  });
  it('reconciles an exact publication whose completion was lost', () => {
    const f = fixture();
    const publish = files.publishFile;
    vi.spyOn(files, 'publishFile').mockImplementation((path, bytes) => {
      publish(path, bytes);
      throw Object.assign(new Error('already published'), { code: 'EEXIST' });
    });
    expect(reserveTaskBackend(f.root, f.row)).toEqual(f.row);
  });
  it('rejects inherited Git redirection and does not hide discovery failures', () => {
    const f = fixture(),
      other = fixture();
    vi.stubEnv('GIT_DIR', join(other.root, '.git'));
    try {
      expect(taskBackendHome(f.root)).toBe(f.home);
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv('PATH', '/no-git-here');
    try {
      expect(() => taskBackendPolicy(f.root)).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'aw-no-git-')));
    roots.push(plain);
    expect(taskBackendPolicy(plain)).toBeNull();
    expect(() => taskBackendGuard(plain).assert()).not.toThrow();
  });
  it('retains the registered Git identity if its metadata disappears or is replaced', () => {
    const f = fixture();
    const guard = taskBackendGuard(f.root);
    expect(guard.require('project', 'task', 'legacy', 'legacy')).toBeNull();
    renameSync(join(f.root, '.git'), join(f.root, '.git-old'));
    expect(() => guard.assert()).toThrow('backend-git-root-changed');
    execFileSync('git', ['init', '--quiet'], { cwd: f.root });
    expect(() => guard.assert()).toThrow('backend-git-root-changed');
  });
  it('refuses a linked assignment directory before creating any descendant', () => {
    const f = fixture();
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    mkdirSync(f.home);
    symlinkSync(outside, join(f.home, 'backend-assignments'));
    expect(() => reserveTaskBackend(f.root, f.row)).toThrow('backend-parent-unsafe');
    expect(existsSync(join(outside, 'project'))).toBe(false);
  });
  it('does not confirm publication or remove a foreign lock after directory replacement', () => {
    const f = fixture();
    const publish = files.publishFile;
    const directory = join(f.home, 'backend-assignments/project');
    vi.spyOn(files, 'publishFile').mockImplementation((path, bytes) => {
      publish(path, bytes);
      renameSync(directory, directory + '-old');
      mkdirSync(directory);
      writeFileSync(path, bytes);
      mkdirSync(join(directory, 'assignment-lock'));
    });
    expect(() => reserveTaskBackend(f.root, f.row)).toThrow('backend-root-changed');
    expect(existsSync(join(directory, 'assignment-lock'))).toBe(true);
  });
});
