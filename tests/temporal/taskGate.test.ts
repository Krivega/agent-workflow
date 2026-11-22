import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { reserveTaskBackend, taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTaskFixture } from './localTaskFixture.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { taskGate } from '../../src/adapters/project/taskGate.js';
import { object } from '../../src/contracts/project.js';
import * as artifacts from '../../src/adapters/artifacts/files.js';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = localTaskFixture(),
    source = taskFiles(f.registration.artifactRoot).binding(f.workspace),
    gate = taskGate(f.input, source, f.profile, f.registration.artifactRoot, 'host-instance');
  return {
    ...f,
    source,
    gate,
    reservation: join(f.workspace, '.git/agent-workflow/source-reservation'),
  };
}
describe('source reservation and frozen write permission', () => {
  it.each(['owned', 'cold'] as const)(
    'observes a stopped %s grant inside its original permission lock without changing revocation',
    async (mode) => {
      const f = fixture();
      f.gate.install();
      f.gate.freeze();
      const gate =
          mode === 'owned'
            ? f.gate
            : taskGate(f.input, f.source, f.profile, f.registration.artifactRoot, 'cold-instance'),
        permission = readFileSync(join(gate.directory, 'permission.json')),
        revoked = readFileSync(join(gate.directory, 'revoked.json')),
        commit = vi.fn();
      await gate.recordStopped(async () => {
        const inventory = readdirSync(gate.directory).sort();
        expect(inventory).toContain('permission-lock');
        return () => {
          expect(readdirSync(gate.directory).sort()).toEqual(inventory);
          commit();
        };
      });
      expect(commit).toHaveBeenCalledOnce();
      expect(readFileSync(join(gate.directory, 'permission.json'))).toEqual(permission);
      expect(readFileSync(join(gate.directory, 'revoked.json'))).toEqual(revoked);
      expect(existsSync(join(gate.directory, 'permission-lock'))).toBe(false);
      expect(() => gate.assert()).toThrow();
    },
  );
  it('never observes an active owned grant through the closed-stop path', async () => {
    const f = fixture();
    f.gate.install();
    const observe = vi.fn(async () => () => {});
    await expect(f.gate.recordStopped(observe)).rejects.toThrow();
    expect(observe).not.toHaveBeenCalled();
    expect(existsSync(join(f.gate.directory, 'permission-lock'))).toBe(false);
  });
  it('rechecks backend at permission effects while retaining freeze and release after policy loss', () => {
    const f = fixture();
    declareBackendFixture(f.workspace);
    const home = taskBackendHome(f.workspace);
    writeFileSync(
      join(home, 'backend-policy.json'),
      JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
    );
    reserveTaskBackend(f.workspace, {
      schemaVersion: 1,
      projectId: 'neutral',
      taskId: 'one',
      backend: 'temporal',
      cardName: 'one.md',
      origin: 'a'.repeat(64),
    });
    f.gate.install();
    unlinkSync(join(home, 'backend-policy.json'));
    expect(() => f.gate.assert()).toThrow('backend-policy-required');
    expect(() => f.gate.install()).toThrow('backend-policy-required');
    f.gate.freeze();
    f.gate.release();
    expect(existsSync(join(f.gate.directory, 'revoked.json'))).toBe(true);
    expect(existsSync(f.reservation)).toBe(false);
  });
  it('does not let inherited Git variables redirect the real permission directory', () => {
    const f = fixture(),
      other = localTaskFixture();
    vi.stubEnv('GIT_DIR', join(other.workspace, '.git'));
    try {
      const gate = taskGate(
        f.input,
        f.source,
        f.profile,
        f.registration.artifactRoot,
        'other-instance',
      );
      expect(gate.directory.startsWith(join(f.workspace, '.git/agent-workflow/tasks/'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('runs the intent callback after strict guards and before revocation', () => {
    const f = fixture();
    f.gate.install();
    const intent = vi.fn(() => {
      expect(existsSync(join(f.gate.directory, 'revoked.json'))).toBe(false);
      expect(
        object(JSON.parse(readFileSync(join(f.gate.directory, 'permission.json'), 'utf8'))).active,
      ).toBe(true);
    });
    f.gate.freeze(intent);
    expect(intent).toHaveBeenCalledOnce();
    expect(
      object(JSON.parse(readFileSync(join(f.gate.directory, 'permission.json'), 'utf8'))).active,
    ).toBe(false);
  });
  it('refuses a conflicting revocation published after the intent callback without reporting success', () => {
    const f = fixture(),
      before = vi.fn(() =>
        artifacts.publishFile(
          join(f.gate.directory, 'revoked.json'),
          Buffer.from('foreign revocation'),
        ),
      );
    expect(() => f.gate.freeze(before)).toThrow('task-grant-conflict');
    expect(before).toHaveBeenCalledOnce();
    expect(existsSync(join(f.gate.directory, 'permission-lock'))).toBe(false);
  });
  it.each(['released', 'retained'])(
    'holds the permission lock through asynchronous retained-stop observation with a %s source reservation',
    async (reservation) => {
      const f = fixture();
      f.gate.install();
      f.gate.freeze();
      if (reservation === 'released') f.gate.release();
      const gate = taskGate(
          f.input,
          f.source,
          f.profile,
          f.registration.artifactRoot,
          'replacement-host',
        ),
        before = ['grant.json', 'permission.json', 'revoked.json'].map((name) =>
          readFileSync(join(gate.directory, name)),
        ),
        metadata = join(gate.directory, 'metadata.json');
      let finish: (() => void) | undefined,
        committed = false;
      const barrier = new Promise<void>((resolve) => {
          finish = resolve;
        }),
        pending = gate.recordRetainedStop(async (grant) => {
          expect(grant).toEqual(before[0]);
          await barrier;
          return () => {
            expect(existsSync(join(gate.directory, 'permission-lock'))).toBe(true);
            artifacts.publishFile(metadata, Buffer.from('cancelled'));
            committed = true;
            return 'recorded';
          };
        });
      expect(existsSync(join(gate.directory, 'permission-lock'))).toBe(true);
      expect(() => gate.install()).toThrow('EEXIST');
      expect(() => f.gate.freeze()).toThrow('EEXIST');
      expect(committed).toBe(false);
      if (finish === undefined) throw new Error('fixture-barrier-missing');
      finish();
      expect(await pending).toBe('recorded');
      expect(committed).toBe(true);
      expect(existsSync(join(gate.directory, 'permission-lock'))).toBe(false);
      expect(
        ['grant.json', 'permission.json', 'revoked.json'].map((name) =>
          readFileSync(join(gate.directory, name)),
        ),
      ).toEqual(before);
      expect(existsSync(f.reservation)).toBe(reservation === 'retained');
      expect(() => gate.assert()).toThrow();
    },
  );
  it('releases only its permission lock when retained observation rejects', async () => {
    const f = fixture();
    f.gate.install();
    f.gate.freeze();
    const gate = taskGate(
        f.input,
        f.source,
        f.profile,
        f.registration.artifactRoot,
        'replacement-host',
      ),
      observe = vi.fn(async () => {
        throw new Error('stop remains unknown');
      });
    await expect(gate.recordRetainedStop(observe)).rejects.toThrow('stop remains unknown');
    expect(existsSync(join(gate.directory, 'permission-lock'))).toBe(false);
    expect(readFileSync(f.reservation)).toEqual(readFileSync(join(gate.directory, 'grant.json')));
  });
  it.each(['owned', 'active', 'revocation', 'foreign-reservation', 'changed-after-observe'])(
    'refuses a retained-stop metadata commit with %s',
    async (defect) => {
      const f = fixture();
      f.gate.install();
      f.gate.freeze();
      const gate = taskGate(
          f.input,
          f.source,
          f.profile,
          f.registration.artifactRoot,
          defect === 'owned' ? 'host-instance' : 'replacement-host',
        ),
        permission = join(gate.directory, 'permission.json'),
        revoked = join(gate.directory, 'revoked.json'),
        original = object(JSON.parse(readFileSync(permission, 'utf8'))),
        commit = vi.fn();
      if (defect === 'active')
        writeFileSync(permission, JSON.stringify({ ...original, active: true }));
      if (defect === 'revocation')
        writeFileSync(revoked, JSON.stringify({ schemaVersion: 1, grant: 'a'.repeat(64) }));
      if (defect === 'foreign-reservation') writeFileSync(f.reservation, 'foreign source owner');
      await expect(
        gate.recordRetainedStop(async () => {
          if (defect === 'changed-after-observe')
            writeFileSync(permission, JSON.stringify({ ...original, active: true }));
          return commit;
        }),
      ).rejects.toThrow();
      expect(commit).not.toHaveBeenCalled();
      expect(existsSync(join(gate.directory, 'permission-lock'))).toBe(false);
    },
  );
  it('retains the historical Input10 planning-attempt directory', () => {
    const f = substantialTaskFixture(),
      input = {
        ...f.substantialInput,
        schemaVersion: 10 as const,
        continuation: { attempt: 0, previous: null },
      },
      gate = taskGate(
        input,
        taskFiles(f.registration.artifactRoot).binding(f.workspace),
        f.profile,
        f.registration.artifactRoot,
        'original-host',
      );
    expect(gate.directory).toContain('/planning-attempts/0');
    gate.freeze();
    expect(() => gate.install()).toThrow('task-permit-revoked');
    expect(f.state.creates).toBe(0);
  });
  it('propagates a failed durable revocation without reporting a completed stop', () => {
    const f = fixture(),
      publish = artifacts.publishFile;
    f.gate.install();
    vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
      if (path.endsWith('revoked.json'))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      publish(path, bytes);
    });
    expect(() => f.gate.freeze()).toThrow('disk full');
    expect(existsSync(join(f.gate.directory, 'revoked.json'))).toBe(false);
    expect(existsSync(join(f.gate.directory, 'permission-lock'))).toBe(false);
  });
  it('revokes an uninstalled grant durably before a delayed admission can reserve the source', () => {
    const f = fixture();
    f.gate.freeze();
    f.gate.freeze();
    expect(existsSync(f.reservation)).toBe(false);
    expect(existsSync(join(f.gate.directory, 'permission.json'))).toBe(false);
    expect(() => f.gate.install()).toThrow('task-permit-revoked');
    expect(existsSync(f.reservation)).toBe(false);
  });
  it('serializes revocation with an in-flight grant installation', () => {
    const f = fixture(),
      original = artifacts.publishFile;
    vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
      if (path === f.reservation) {
        expect(() => f.gate.freeze()).toThrow();
        expect(existsSync(join(f.gate.directory, 'revoked.json'))).toBe(false);
      }
      original(path, bytes);
    });
    f.gate.install();
    f.gate.freeze();
    expect(() => f.gate.assert()).toThrow('task-permit-revoked');
    expect(readFileSync(f.reservation)).toEqual(readFileSync(join(f.gate.directory, 'grant.json')));
  });
  it('installs exactly once, freezes before release and never resurrects a closed grant', () => {
    const f = fixture();
    f.gate.install();
    f.gate.install();
    expect(f.gate.admission().mode).toBe('owned');
    expect(f.gate.exclusive(() => 42)).toBe(42);
    f.gate.freeze();
    f.gate.freeze();
    expect(() => f.gate.assert()).toThrow('task-permit-revoked');
    expect(() => f.gate.exclusive(() => 42)).toThrow('task-permit-revoked');
    expect(() => f.gate.install()).toThrow('task-permit-revoked');
    f.gate.release();
    f.gate.release();
    expect(existsSync(f.reservation)).toBe(false);
    writeFileSync(join(f.gate.directory, 'stopped.json'), '{}');
    expect(() => f.gate.install()).toThrow('task-already-closed');
  });
  it('reserves a whole source across task ids and host instances, leaving foreign bytes intact', () => {
    const f = fixture();
    f.gate.install();
    const bytes = readFileSync(f.reservation),
      next = {
        ...f.input,
        admission: {
          ...f.input.admission,
          preparation: { ...f.input.admission.preparation, taskId: 'two' },
        },
      };
    const other = taskGate(next, f.source, f.profile, f.registration.artifactRoot, 'host-instance');
    expect(() => other.install()).toThrow('task-source-reserved');
    other.release();
    expect(readFileSync(f.reservation)).toEqual(bytes);
    const recovered = taskGate(
      f.input,
      f.source,
      f.profile,
      f.registration.artifactRoot,
      'new-host',
    );
    expect(() => recovered.install()).toThrow('task-permit-revoked');
    expect(recovered.admission().mode).toBe('retained');
    expect(readFileSync(f.reservation)).toEqual(bytes);
    expect(() => recovered.freeze()).toThrow('task-grant-conflict');
    expect(existsSync(join(recovered.directory, 'permission-lock'))).toBe(false);
  });
  it('rejects tampered immutable grant, reservation and permission independently', () => {
    for (const kind of ['grant', 'reservation', 'permission']) {
      const f = fixture();
      f.gate.install();
      if (kind === 'grant') {
        writeFileSync(join(f.gate.directory, 'grant.json'), 'foreign');
        expect(() => f.gate.install()).toThrow('task-grant-conflict');
        expect(() => f.gate.admission()).toThrow();
      }
      if (kind === 'reservation') {
        writeFileSync(f.reservation, 'foreign');
        expect(() => f.gate.assert()).toThrow('task-source-reserved');
        f.gate.release();
        expect(readFileSync(f.reservation, 'utf8')).toBe('foreign');
      }
      if (kind === 'permission') {
        writeFileSync(join(f.gate.directory, 'permission.json'), '{}');
        expect(() => f.gate.assert()).toThrow('task-permit-revoked');
      }
    }
  });
  it.each(['source-reservation', 'grant.json', 'permission.json'])(
    'propagates storage failure while publishing %s',
    (name) => {
      const f = fixture(),
        original = artifacts.publishFile;
      vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
        if (path.endsWith(name)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return original(path, bytes);
      });
      expect(() => f.gate.install()).toThrow('disk full');
    },
  );
  it('rejects an existing foreign permission after immutable grant checks', () => {
    const f = fixture();
    f.gate.install();
    unlinkSync(join(f.gate.directory, 'permission.json'));
    const original = artifacts.publishFile;
    vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
      if (path.endsWith('permission.json')) {
        original(path, Buffer.from('{}'));
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      return original(path, bytes);
    });
    expect(() => f.gate.install()).toThrow('task-permit-revoked');
  });
});
