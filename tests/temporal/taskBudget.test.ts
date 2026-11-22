import {
  mkdirSync,
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
