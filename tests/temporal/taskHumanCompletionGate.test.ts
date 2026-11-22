import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import { taskHumanCompletionGate } from '../../src/adapters/project/taskHumanCompletionGate.js';
import { taskGate } from '../../src/adapters/project/taskGate.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import * as artifacts from '../../src/adapters/artifacts/files.js';
import { object } from '../../src/contracts/project.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';

afterEach(() => vi.restoreAllMocks());
function fixture(release = true) {
  const f = substantialTaskFixture(),
    input: HumanManagedTaskInput = {
      ...f.substantialInput,
      schemaVersion: 12,
      continuation: { attempt: 0, previous: null },
      startAdmission: f.proof,
    },
    source = taskFiles(f.registration.artifactRoot).binding(f.workspace),
    writer = taskGate(
      input,
      source,
      f.profile,
      f.registration.artifactRoot,
      'original-host-instance',
    );
  writer.install();
  writer.freeze();
  const stopped = f.save({ kind: 'synthetic-unit-stop', confirmed: true, input }),
    seal = f.save({ kind: 'synthetic-unit-completion-seal', input, stopped });
  artifacts.publishFile(
    join(writer.directory, 'stopped.json'),
    Buffer.from(JSON.stringify(stopped)),
  );
  if (release) writer.release();
  const reservation = join(f.workspace, '.git/agent-workflow/source-reservation'),
    create = () =>
      taskHumanCompletionGate(input, source, f.profile, f.registration.artifactRoot, stopped, seal),
    gate = create();
  return { ...f, input, source, writer, stopped, seal, reservation, gate, create };
}
describe('cold completion-only gate after revoked Writer and root-verified STOP (synthetic unit receipt)', () => {
  it('allows only narrow completion and preserves the old revoked permission across cold owner instances', () => {
    const f = fixture(),
      paths = ['grant.json', 'permission.json', 'revoked.json', 'stopped.json'].map((name) =>
        join(f.gate.directory, name),
      ),
      before = paths.map((path) => readFileSync(path));
    expect(() => f.gate.assert()).toThrow('reservation-changed');
    f.gate.acquire();
    f.gate.acquire();
    f.gate.assert();
    const token = object(JSON.parse(readFileSync(f.reservation, 'utf8')) as unknown);
    expect(token.kind).toBe('task-human-completion');
    expect(token.ownerPid).toBe(process.pid);
    expect(token.seal).toEqual(f.seal);
    expect(typeof token.nonce).toBe('string');
    expect(() => f.writer.assert()).toThrow();
    expect(
      f.gate.exclusive(() => {
        expect(existsSync(join(f.gate.directory, 'permission-lock'))).toBe(true);
        return 'completion-only';
      }),
    ).toBe('completion-only');
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
    expect(object(JSON.parse(readFileSync(paths[1]!, 'utf8')) as unknown).active).toBe(false);
    f.gate.release();
    f.gate.release();
    expect(existsSync(f.reservation)).toBe(false);
    expect(() => f.writer.install()).toThrow('already-closed');
    const recovered = f.create();
    recovered.acquire();
    recovered.release();
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  });
  it('does not adopt any existing Writer or same-seal completion reservation', () => {
    const retained = fixture(false),
      before = readFileSync(retained.reservation);
    expect(() => retained.gate.acquire()).toThrow('source-reserved');
    retained.gate.release();
    expect(readFileSync(retained.reservation)).toEqual(before);
    retained.writer.release();
    retained.gate.acquire();
    const other = retained.create(),
      own = readFileSync(retained.reservation);
    expect(() => other.acquire()).toThrow('source-reserved');
    other.release();
    expect(readFileSync(retained.reservation)).toEqual(own);
    retained.gate.release();
  });
  it('refuses a real exclusive publication collision and never overwrites or releases the foreign bytes', () => {
    const f = fixture(),
      publish = artifacts.publishFile;
    vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
      if (path === f.reservation) writeFileSync(path, 'foreign writer reservation');
      return publish(path, bytes);
    });
    expect(() => f.gate.acquire()).toThrow();
    f.gate.release();
    expect(readFileSync(f.reservation, 'utf8')).toBe('foreign writer reservation');
    expect(existsSync(join(f.gate.directory, 'permission-lock'))).toBe(false);
  });
  it('cleans only its own reservation after a post-publication pin failure', () => {
    const f = fixture(),
      publish = artifacts.publishFile;
    vi.spyOn(artifacts, 'publishFile').mockImplementation((path, bytes) => {
      publish(path, bytes);
      if (path === f.reservation)
        writeFileSync(join(f.gate.directory, 'revoked.json'), 'changed revocation');
    });
    expect(() => f.gate.acquire()).toThrow('pins-changed');
    expect(existsSync(f.reservation)).toBe(false);
    expect(existsSync(join(f.gate.directory, 'permission-lock'))).toBe(false);
  });
  it('retains a replacement foreign reservation during failure cleanup and normal release', () => {
    const f = fixture();
    f.gate.acquire();
    writeFileSync(f.reservation, 'foreign replacement');
    const effect = vi.fn<() => void>();
    expect(() => f.gate.exclusive(effect)).toThrow('reservation-changed');
    expect(effect).not.toHaveBeenCalled();
    expect(() => f.gate.release()).toThrow('reservation-changed');
    expect(readFileSync(f.reservation, 'utf8')).toBe('foreign replacement');
    expect(existsSync(join(f.gate.directory, 'permission-lock'))).toBe(false);
  });
  it('releases the lock after callback failure and handles an already missing own reservation', () => {
    const f = fixture();
    f.gate.acquire();
    expect(() =>
      f.gate.exclusive(() => {
        throw Error('actual completion error');
      }),
    ).toThrow('actual completion error');
    expect(existsSync(join(f.gate.directory, 'permission-lock'))).toBe(false);
    f.gate.assert();
    unlinkSync(f.reservation);
    f.gate.release();
    expect(existsSync(f.reservation)).toBe(false);
  });
  it.each(['grant.json', 'permission.json', 'revoked.json', 'stopped.json'])(
    'rejects changed immutable %s before a card-writing callback',
    (name) => {
      const f = fixture(),
        path = join(f.gate.directory, name),
        effect = vi.fn<() => void>();
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
      expect(() => f.gate.acquire()).toThrow('pins-changed');
      expect(() => f.gate.exclusive(effect)).toThrow('pins-changed');
      expect(effect).not.toHaveBeenCalled();
      expect(existsSync(f.reservation)).toBe(false);
    },
  );
  it('rejects an identical-byte metadata replacement, changed modes and a replaced source directory', () => {
    const f = fixture(),
      path = join(f.gate.directory, 'revoked.json'),
      copy = path + '.replacement';
    writeFileSync(copy, readFileSync(path));
    renameSync(copy, path);
    expect(() => f.gate.acquire()).toThrow('pins-changed');
    const g = fixture();
    chmodSync(join(g.gate.directory, 'permission.json'), 0o644);
    expect(() => g.gate.acquire()).toThrow('pins-changed');
    const h = fixture(),
      previous = h.workspace + '-previous';
    renameSync(h.workspace, previous);
    mkdirSync(h.workspace);
    renameSync(join(previous, '.git'), join(h.workspace, '.git'));
    expect(() => h.gate.acquire()).toThrow();
    expect(existsSync(h.reservation)).toBe(false);
  });
  it.each(['seal', 'stopped'] as const)(
    'requires the exact immutable %s artifact bytes',
    (kind) => {
      const f = fixture(),
        ref = f[kind];
      writeFileSync(f.store.path(ref), 'corrupted artifact');
      expect(() => f.gate.acquire()).toThrow('artifact-corrupted');
      expect(existsSync(f.reservation)).toBe(false);
    },
  );
  it('requires matching prior input/profile/artifact scope and an inactive revoked Writer', () => {
    const f = fixture();
    expect(() =>
      taskHumanCompletionGate(
        { ...f.input, baseline: 'different' },
        f.source,
        f.profile,
        f.registration.artifactRoot,
        f.stopped,
        f.seal,
      ),
    ).toThrow('grant-binding');
    expect(() =>
      taskHumanCompletionGate(
        f.input,
        f.source,
        { ...f.profile, effort: 'high' },
        f.registration.artifactRoot,
        f.stopped,
        f.seal,
      ),
    ).toThrow('grant-binding');
    const other = fixture();
    expect(() =>
      taskHumanCompletionGate(
        f.input,
        f.source,
        f.profile,
        other.registration.artifactRoot,
        f.stopped,
        f.seal,
      ),
    ).toThrow('grant-binding');
    const permission = join(f.gate.directory, 'permission.json'),
      old = object(JSON.parse(readFileSync(permission, 'utf8')) as unknown);
    writeFileSync(permission, JSON.stringify({ ...old, active: true }));
    expect(() => f.create()).toThrow('writer-not-revoked');
    writeFileSync(permission, JSON.stringify(old));
    writeFileSync(
      join(f.gate.directory, 'revoked.json'),
      JSON.stringify({ schemaVersion: 1, grant: '0'.repeat(64) }),
    );
    expect(() => f.create()).toThrow('writer-not-revoked');
    const g = fixture();
    writeFileSync(join(g.gate.directory, 'stopped.json'), JSON.stringify(g.proof));
    expect(() => g.create()).toThrow('stop-binding');
  });
  it('refuses an existing permission lock without removing it', () => {
    const f = fixture(),
      lock = join(f.gate.directory, 'permission-lock');
    mkdirSync(lock, { mode: 0o700 });
    expect(() => f.gate.acquire()).toThrow();
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(f.reservation)).toBe(false);
  });
});
