import {
  mkdirSync,
  rmdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlFixture } from './controlFixture.js';
import { readerBudget } from '../../src/adapters/codex/readerBudget.js';
import {
  captureTaskBudget,
  inspectTaskBudget,
  extendTaskBudget,
  verifyTaskBudget,
} from '../../src/worker/taskBudget.js';
import * as files from '../../src/adapters/artifacts/files.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = controlFixture(),
    directory = join(f.root, 'credits'),
    charge = readerBudget(directory, 3),
    one = [files.digest('first-operation'), files.digest('first-request')] as const;
  charge(...one);
  const before = captureTaskBudget(directory, f.store, null);
  return {
    ...f,
    directory,
    charge,
    one,
    before,
    capture: () => captureTaskBudget(directory, f.store, before.manifest),
  };
}
function snapshot(directory: string): unknown[] {
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const path = join(directory, name);
      return {
        name,
        content: lstatSync(path).isDirectory()
          ? snapshot(path)
          : readFileSync(path).toString('hex'),
      };
    });
}
describe('readonly model budget verification', () => {
  it('inspects a zero-credit ledger without creating a budget-zero artifact or any file', () => {
    const f = controlFixture(),
      directory = join(f.root, 'zero-credits');
    readerBudget(directory, 0);
    const before = snapshot(f.root),
      publish = vi.spyOn(f.store, 'publish');
    expect(inspectTaskBudget(directory, f.store, null)).toMatchObject({ limit: 0, credits: [] });
    expect(publish).not.toHaveBeenCalled();
    expect(snapshot(f.root)).toEqual(before);
  });
  it('returns exactly the capture record and verifies its entire image without a write', () => {
    const f = fixture(),
      before = snapshot(f.root),
      publish = vi.spyOn(f.store, 'publish');
    const record = inspectTaskBudget(f.directory, f.store, f.before.manifest);
    expect(verifyTaskBudget(f.directory, f.store, f.before)).toEqual(record);
    expect(Buffer.from(JSON.stringify(record))).toEqual(f.store.read(f.before.manifest));
    expect(record.credits).toEqual([
      {
        index: 0,
        key: f.one[0],
        hash: f.one[1],
        ref: {
          sha256: files.digest(readFileSync(join(f.directory, '0.credit'))),
          bytes: readFileSync(join(f.directory, '0.credit')).length,
        },
      },
    ]);
    expect(publish).not.toHaveBeenCalled();
    expect(snapshot(f.root)).toEqual(before);
  });
  it('keeps capture bytes, return shape and its one final publication unchanged', () => {
    const f = fixture(),
      record = inspectTaskBudget(f.directory, f.store, f.before.manifest),
      publish = vi.spyOn(f.store, 'publish');
    expect(f.capture()).toEqual(f.before);
    expect(publish).toHaveBeenCalledExactlyOnceWith(Buffer.from(JSON.stringify(record)));
  });
  it('accepts growth only through a new capture and preserves both immutable prefixes', () => {
    const f = fixture();
    f.charge(files.digest('second-operation'), files.digest('second-request'));
    expect(inspectTaskBudget(f.directory, f.store, f.before.manifest).credits).toHaveLength(2);
    const publish = vi.spyOn(f.store, 'publish');
    expect(() => verifyTaskBudget(f.directory, f.store, f.before)).toThrow(
      'task-budget-current-mismatch',
    );
    expect(publish).not.toHaveBeenCalled();
    publish.mockRestore();
    const next = f.capture(),
      before = snapshot(f.root);
    expect(verifyTaskBudget(f.directory, f.store, next).credits).toHaveLength(2);
    expect(JSON.parse(f.store.read(f.before.manifest).toString()) as unknown).toMatchObject({
      credits: [{ index: 0 }],
    });
    expect(snapshot(f.root)).toEqual(before);
  });
  it.each([
    'missing',
    'extra',
    'corrupt',
    'lock',
    'limit',
    'used',
    'manifest-whitespace',
    'manifest-extra',
  ])('refuses %s without repairing or publishing the budget', (mode) => {
    const f = fixture(),
      expected = { ...f.before };
    if (mode === 'missing') unlinkSync(join(f.directory, '0.credit'));
    if (mode === 'extra') writeFileSync(join(f.directory, 'extra.credit'), '{}');
    if (mode === 'corrupt')
      writeFileSync(
        join(f.directory, '0.credit'),
        JSON.stringify({ key: f.one[0], hash: 'unknown' }),
      );
    if (mode === 'lock') mkdirSync(join(f.directory, 'lock'));
    if (mode === 'limit') expected.limit++;
    if (mode === 'used') expected.used++;
    if (mode.startsWith('manifest-')) {
      const bytes = f.store.read(f.before.manifest);
      expected.manifest = f.store.publish(
        mode === 'manifest-whitespace'
          ? Buffer.concat([bytes, Buffer.from('\n')])
          : Buffer.from(
              JSON.stringify({ ...(JSON.parse(bytes.toString()) as object), extra: true }),
            ),
      );
    }
    const before = snapshot(f.root),
      publish = vi.spyOn(f.store, 'publish');
    expect(() => verifyTaskBudget(f.directory, f.store, expected)).toThrow();
    expect(publish).not.toHaveBeenCalled();
    expect(snapshot(f.root)).toEqual(before);
  });
  it.each([
    { schemaVersion: 2, limit: 3 },
    { schemaVersion: 1, limit: -1 },
    { schemaVersion: 1, limit: 1.5 },
    { schemaVersion: 1, limit: '3' },
  ])('preserves the existing malformed limit refusal %j', (limit) => {
    const f = fixture();
    writeFileSync(join(f.directory, 'limit'), JSON.stringify(limit));
    expect(() => inspectTaskBudget(f.directory, f.store, null)).toThrow(
      'task-budget-limit-unknown',
    );
  });
  it.each([
    { key: null, hash: 'a'.repeat(64) },
    { key: 'unknown', hash: 'a'.repeat(64) },
    { key: 'a'.repeat(64), hash: null },
  ])('preserves the existing malformed credit refusal %j', (credit) => {
    const f = fixture();
    writeFileSync(join(f.directory, '0.credit'), JSON.stringify(credit));
    expect(() => inspectTaskBudget(f.directory, f.store, null)).toThrow(
      'task-budget-credit-unknown',
    );
  });
  it.each(['extra', 'lock', 'limit', 'credit', 'root'])(
    'detects a concurrent %s change without a false readonly verification',
    (mode) => {
      const f = fixture(),
        read = files.readPrivateFile,
        publish = vi.spyOn(f.store, 'publish');
      let reads = 0;
      vi.spyOn(files, 'readPrivateFile').mockImplementation((path) => {
        const bytes = read(path);
        if (path === join(f.directory, '0.credit') && ++reads === (mode === 'root' ? 2 : 1)) {
          if (mode === 'extra') writeFileSync(join(f.directory, 'late'), '{}');
          if (mode === 'lock') mkdirSync(join(f.directory, 'lock'));
          if (mode === 'limit')
            writeFileSync(
              join(f.directory, 'limit'),
              JSON.stringify({ schemaVersion: 1, limit: 3 }) + '\n',
            );
          if (mode === 'credit')
            writeFileSync(path, JSON.stringify({ key: f.one[0], hash: files.digest('late') }));
          if (mode === 'root') {
            renameSync(f.directory, f.directory + '-old');
            mkdirSync(f.directory);
            for (const name of ['limit', '0.credit'])
              writeFileSync(
                join(f.directory, name),
                readFileSync(join(f.directory + '-old', name)),
              );
          }
        }
        return bytes;
      });
      expect(() => verifyTaskBudget(f.directory, f.store, f.before)).toThrow(
        mode === 'root' ? 'task-budget-root-unknown' : 'task-budget-inventory-changed',
      );
      expect(publish).not.toHaveBeenCalled();
    },
  );
});
describe('primary model budget prefix across Workflow rollover', () => {
  it('retains already reserved unknown expense and only grows the same immutable prefix', () => {
    const f = fixture();
    expect(f.before).toMatchObject({ limit: 3, used: 1 });
    f.charge(...f.one);
    expect(f.capture().used).toBe(1);
    f.charge(files.digest('second-operation'), files.digest('second-request'));
    const next = f.capture();
    expect(next).toMatchObject({ limit: 3, used: 2 });
    expect(next.manifest).not.toEqual(f.before.manifest);
    expect(JSON.parse(f.store.read(next.manifest).toString())).toMatchObject({
      kind: 'task-model-budget',
      credits: [{ index: 0 }, { index: 1 }],
    });
  });
  it.each(['reset', 'limit', 'changed-credit', 'gap', 'duplicate', 'extra', 'lock', 'root'])(
    'rejects %s instead of presenting previously used model starts as zero',
    (defect) => {
      const f = fixture(),
        publish = vi.spyOn(f.store, 'publish');
      if (defect === 'reset') unlinkSync(join(f.directory, '0.credit'));
      if (defect === 'limit')
        writeFileSync(join(f.directory, 'limit'), JSON.stringify({ schemaVersion: 1, limit: 15 }));
      if (defect === 'changed-credit')
        writeFileSync(
          join(f.directory, '0.credit'),
          JSON.stringify({ key: f.one[0], hash: files.digest('other') }),
        );
      if (defect === 'gap')
        renameSync(join(f.directory, '0.credit'), join(f.directory, '1.credit'));
      if (defect === 'duplicate')
        writeFileSync(join(f.directory, '1.credit'), readFileSync(join(f.directory, '0.credit')));
      if (defect === 'extra') writeFileSync(join(f.directory, 'unregistered'), '{}');
      if (defect === 'lock') mkdirSync(join(f.directory, 'lock'));
      if (defect === 'root') {
        renameSync(f.directory, f.directory + '-original');
        mkdirSync(f.directory);
        for (const name of ['limit', '0.credit'])
          writeFileSync(
            join(f.directory, name),
            readFileSync(join(f.directory + '-original', name)),
          );
      }
      expect(f.capture).toThrow();
      expect(publish).not.toHaveBeenCalled();
    },
  );
  it('detects a changed credit after its first read without publishing a false budget snapshot', () => {
    const f = fixture(),
      read = files.readPrivateFile,
      publish = vi.spyOn(f.store, 'publish');
    let changed = false;
    vi.spyOn(files, 'readPrivateFile').mockImplementation((path) => {
      const bytes = read(path);
      if (path === join(f.directory, '0.credit') && !changed) {
        changed = true;
        writeFileSync(path, JSON.stringify({ key: f.one[0], hash: files.digest('late-change') }));
      }
      return bytes;
    });
    expect(f.capture).toThrow('task-budget-inventory-changed');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('explicit dedicated host budget extension', () => {
  it('keeps the first two credits and their immutable receipt across a 7 to 9 extension and restart', () => {
    const f = controlFixture(),
      directory = join(f.root, 'credits'),
      old = readerBudget(directory, 7);
    const spend = (consumer: typeof old, n: number) =>
      consumer(files.digest('key' + n), files.digest('request' + n));
    spend(old, 0);
    spend(old, 1);
    const held = captureTaskBudget(directory, f.store, null),
      original = snapshot(directory);
    expect(() => readerBudget(directory, 9)).toThrow('reader-model-budget-conflict');
    extendTaskBudget(directory, f.store, held, 9, 'run');
    expect(
      snapshot(directory).filter((x) => (x as { name: string }).name !== 'extension.json'),
    ).toEqual(original);
    const first = captureTaskBudget(directory, f.store, held.manifest);
    expect(first).toMatchObject({ limit: 9, used: 2, extendedFrom: held.manifest });
    expect(() => readerBudget(directory, 7)).toThrow('reader-model-budget-conflict');
    const resumed = readerBudget(directory, 9);
    for (let n = 0; n < 9; n++) spend(resumed, n);
    expect(() => spend(resumed, 9)).toThrow('reader-model-budget-exhausted');
    const final = captureTaskBudget(directory, f.store, first.manifest);
    expect(final).toMatchObject({ limit: 9, used: 9 });
    expect(final.extendedFrom).toEqual({ ...held.manifest, runId: 'run' });
    extendTaskBudget(directory, f.store, held, 9, 'run');
    expect(() => extendTaskBudget(directory, f.store, held, 10, 'run')).toThrow(
      'task-budget-extension-conflict',
    );
    const grant = join(directory, 'extension.json'),
      savedGrant = readFileSync(grant);
    unlinkSync(grant);
    expect(() => spend(resumed, 2)).toThrow('task-budget-extension-changed');
    writeFileSync(grant, savedGrant);
    const credit = join(directory, '0.credit');
    writeFileSync(credit, readFileSync(join(directory, '1.credit')));
    expect(() => readerBudget(directory, 9)).toThrow('task-budget-extension-prefix');
  });
  it('retains both grants and all five credits across restart and duplicate requests', () => {
    const f = controlFixture();
    const directory = join(f.root, 'credits');
    const initial = readerBudget(directory, 7);
    const spend = (consumer: typeof initial, n: number) =>
      consumer(files.digest('key' + n), files.digest('request' + n));
    spend(initial, 0);
    spend(initial, 1);
    const first = captureTaskBudget(directory, f.store, null);
    extendTaskBudget(directory, f.store, first, 9, 'run');
    const nine = readerBudget(directory, 9);
    for (let n = 2; n < 5; n++) spend(nine, n);
    const second = captureTaskBudget(directory, f.store, first.manifest);
    expect(second).toMatchObject({ limit: 9, used: 5 });
    const before = snapshot(directory);
    expect(() => extendTaskBudget(directory, f.store, second, 12, 'other')).toThrow(
      'task-budget-extension-conflict',
    );
    extendTaskBudget(directory, f.store, second, 12, 'run');
    expect(
      snapshot(directory).filter((x) => (x as { name: string }).name !== 'extension-9.json'),
    ).toEqual(before);
    const expected = snapshot(directory);
    extendTaskBudget(directory, f.store, second, 12, 'run');
    extendTaskBudget(directory, f.store, first, 9, 'run');
    expect(snapshot(directory)).toEqual(expected);
    expect(() => spend(nine, 5)).toThrow('task-budget-extension-changed');
    const reopened = readerBudget(directory, 12);
    expect(captureTaskBudget(directory, f.store, second.manifest)).toMatchObject({
      limit: 12,
      used: 5,
      extendedFrom: { ...second.manifest, runId: 'run' },
    });
    for (let n = 0; n < 12; n++) spend(reopened, n);
    expect(() => spend(reopened, 12)).toThrow('reader-model-budget-exhausted');
    const parent = join(directory, 'extension.json');
    const bytes = readFileSync(parent);
    writeFileSync(parent, Buffer.concat([bytes, Buffer.from(' ')]));
    expect(() => readerBudget(directory, 12)).toThrow('task-budget-extension-mismatch');
    unlinkSync(parent);
    expect(() => readerBudget(directory, 12)).toThrow('task-budget-extension-chain');
  });
  it('rejects invalid grants, stale usage, wrong directories and pending operations', () => {
    const f = fixture();
    expect(() => extendTaskBudget(f.directory, f.store, f.before, 3, 'run')).toThrow(
      'task-budget-extension-invalid',
    );
    expect(() =>
      extendTaskBudget(f.directory, f.store, { ...f.before, used: 0 }, 4, 'run'),
    ).toThrow('task-budget-current-mismatch');
    f.charge(files.digest('other'), files.digest('other-request'));
    expect(() => extendTaskBudget(f.directory, f.store, f.before, 4, 'run')).toThrow(
      'task-budget-current-mismatch',
    );
    const current = f.capture();
    mkdirSync(join(f.directory, 'lock'));
    expect(() => extendTaskBudget(f.directory, f.store, current, 4, 'run')).toThrow();
    rmdirSync(join(f.directory, 'lock'));
    extendTaskBudget(f.directory, f.store, current, 4, 'run');
    const other = join(f.root, 'other');
    readerBudget(other, 3);
    writeFileSync(join(other, 'extension.json'), readFileSync(join(f.directory, 'extension.json')));
    expect(() => readerBudget(other, 4)).toThrow('task-budget-extension-mismatch');
  });
});
