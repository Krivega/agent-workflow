import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { saveManaged, readManaged } from '../adapters/storage/managedChatFiles.js';
import * as artifacts from '../adapters/storage/sharedArtifacts.js';
import * as files from '../adapters/storage/storeFiles.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { workflowFixture } from './workflowFixtures.js';
import type { Council } from '../core/council.js';
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});
function legacy() {
  const council = f.council('planning');
  const answer = council.advisers.architect!.answer!;
  council.history = ['first', 'second'].map((turn) => ({
    role: 'architect',
    session: 'session',
    answer: { ...answer, binding: { ...answer.binding!, answer_turn: turn } },
  }));
  return council;
}
it('reads only the format header on subsequent minimal saves and only metadata on ordinary saves', () => {
  const path = resolve(f.root, 'current.json');
  saveManaged(path, { current: 'large '.repeat(200000) }, true, 'minimal');
  const read = vi.spyOn(files, 'readPrivateFile');
  saveManaged(path, { current: 'next' }, true, 'minimal');
  expect(read.mock.calls.filter(([name]) => name === path)).toEqual([
    [path, Buffer.byteLength(artifacts.retainedInlinePrefix)],
  ]);
  expect(existsSync(path + '.originals')).toBe(false);
  const ordinary = resolve(f.root, 'ordinary.json');
  saveManaged(ordinary, { receipt: 'first' }, false);
  saveManaged(ordinary, { receipt: 'next' }, false);
  expect(read.mock.calls.filter(([name]) => name === ordinary)).toEqual([[ordinary, 0]]);
});
it.each([false, true])(
  'preserves exact legacy bytes and reachable archive before replacing a managed file, archived=%s',
  (archived) => {
    const path = resolve(f.root, 'managed.json');
    saveManaged(path, legacy(), true, archived);
    const original = readFileSync(path),
      hash = digest(original);
    const full = readManaged<Council>(path, { archive: true });
    saveManaged(path, readManaged(path), true, 'minimal');
    const root = resolve(path + '.originals', hash);
    expect(readFileSync(resolve(root, 'original'))).toEqual(original);
    expect(readManaged(resolve(root, 'original'), { archive: true })).toEqual(full);
    expect(readManaged<Council>(path)!.history).toHaveLength(1);
    expect(readFileSync(path, 'utf8').startsWith(artifacts.retainedInlinePrefix)).toBe(true);
    saveManaged(path, readManaged(path), true, 'minimal');
    expect(readdirSync(path + '.originals')).toEqual([hash]);
    writeFileSync(resolve(root, 'original'), 'corrupt');
    writeFileSync(path, original);
    expect(() => saveManaged(path, readManaged(path), true, 'minimal')).toThrow(
      'managed-original-corrupt',
    );
    expect(readFileSync(path)).toEqual(original);
  },
);
it('does not replace a legacy file with missing archive data or an encoding failure', () => {
  const path = resolve(f.root, 'managed.json');
  saveManaged(path, legacy(), true, true);
  const original = readFileSync(path),
    current = readManaged(path);
  unlinkSync(resolve(f.root, 'shared-json', readdirSync(resolve(f.root, 'shared-json'))[0]!));
  expect(() => saveManaged(path, current, true, 'minimal')).toThrow();
  expect(readFileSync(path)).toEqual(original);
  const plain = resolve(f.root, 'plain.json');
  saveManaged(plain, { old: true });
  expect(() => saveManaged(plain, undefined, true, 'minimal')).toThrow('invalid-context');
  expect(readManaged(plain)).toEqual({ old: true });
});
it('refuses replacement if another writer changed the original during preparation', () => {
  const path = resolve(f.root, 'managed.json');
  saveManaged(path, { old: true });
  const encode = artifacts.encodeChatArtifact;
  vi.spyOn(artifacts, 'encodeChatArtifact').mockImplementationOnce((...args) => {
    writeFileSync(path, '{"concurrent":true}');
    return encode(...args);
  });
  expect(() => saveManaged(path, { new: true }, true, 'minimal')).toThrow(
    'managed-original-changed',
  );
  expect(readManaged(path)).toEqual({ concurrent: true });
  expect(readdirSync(f.root).some((name) => name.startsWith('.managed-'))).toBe(false);
});
