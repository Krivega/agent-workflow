import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { workflowFixture } from './workflowFixtures.js';
import { runChatCheck, verifyChatCheck } from '../adapters/project/chatChecks.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { encodeSharedJson } from '../adapters/storage/sharedJson.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  shareArtifactPool,
  readArtifactFile,
  saveChatArtifact,
  readChatArtifact,
  readArtifactBlob,
  encodeProofArtifact,
} from '../adapters/storage/sharedArtifacts.js';
import { saveCouncilRequestFile } from '../adapters/codex/councilRequestFile.js';
import { councilReviewRequest } from '../core/council.js';
import { runChatCommand } from '../cli/chatCommand.js';
import { saveManaged, readManaged } from '../adapters/storage/managedChatFiles.js';
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});
it('stores even a small input list once while preserving independent decoded fields', () => {
  const list = f.target.inputs.inputs;
  const content = encodeProofArtifact(f.root, { before: list, after: list });
  const path = resolve(f.root, 'small.json');
  writeFileSync(path, content);
  const value = readArtifactFile(path) as { before: typeof list; after: typeof list };
  expect(value.before).toEqual(list);
  expect(value.after).toEqual(list);
  value.before[0]!.hash = 'changed';
  expect(value.after).toEqual(list);
  expect(readdirSync(resolve(f.root, 'shared-json'))).toHaveLength(1);
});
it('stores a real input list once across proof fields, intents, checks and Council request files and keeps all readers exact', async () => {
  const discovery = { files: [] as string[], directories: [] };
  for (let i = 0; i < 220; i++) {
    const name = `source-${i}-${'a'.repeat(140)}.txt`;
    discovery.files.push(name);
    writeFileSync(resolve(f.root, name), 'source ' + i);
  }
  const inputs = new FileWorkflowInputs(f.root, f.root),
    manifest = await inputs.capture(discovery, 'owner');
  const request = {
    id: 'first',
    command: { file: process.execPath, args: ['-e', 'console.log("observed")'] },
    discovery,
    attested_by: 'owner',
  };
  const first = await runChatCheck(f.root, f.root, request);
  const second = await runChatCheck(f.root, f.root, { ...request, id: 'second' });
  expect(first).toMatchObject({ exit_code: 0, check: { verdict: 'PASS' } });
  expect(second).toMatchObject({ exit_code: 0, check: { verdict: 'PASS' } });
  expect(first.before).toEqual(manifest);
  expect(first.before).toEqual(first.after);
  expect((await verifyChatCheck(f.root, f.root, second.check)).operation_id).toBe('second');
  expect(await runChatCheck(f.root, f.root, request)).toEqual(first);
  expect(readArtifactFile(resolve(f.root, 'first.json'))).toEqual(first);
  const encoded = JSON.parse(
    encodeSharedJson(manifest.inputs, digest).slice('AWJSON1\n'.length),
  ) as [string, string];
  expect(encoded[0]).toBe('ref');
  const pool = resolve(f.root, 'shared-json');
  expect(readdirSync(pool).filter((name) => name === encoded[1])).toHaveLength(1);
  for (const name of ['first.json', 'first.intent.json', 'second.json', 'second.intent.json'])
    expect(readFileSync(resolve(f.root, name)).length).toBeLessThan(
      JSON.stringify(manifest).length / 2,
    );
  const directory = resolve(f.root, 'council');
  mkdirSync(directory);
  shareArtifactPool(directory, f.root);
  shareArtifactPool(directory, f.root);
  f.target.inputs = manifest;
  f.selection.architect.inputs = manifest;
  const council = f.council('planning'),
    review = councilReviewRequest(council, 'architect', f.adviser);
  const file = await saveCouncilRequestFile(directory, review);
  expect(readChatArtifact(file)).toEqual(review);
  expect(exists(directory, 'shared-json')).toBe(false);
  const output: string[] = [];
  expect(
    await runChatCommand(
      ['read-artifact', file.locator + '.ref.json'],
      (line) => output.push(line),
      (line) => output.push(line),
    ),
  ).toBe(0);
  expect(JSON.parse(output[0]!) as unknown).toEqual(review);
  expect(readdirSync(pool).filter((name) => name === encoded[1])).toHaveLength(1);
  const state = resolve(directory, 'state.json');
  saveManaged(state, { before: manifest, after: manifest });
  saveManaged(state, readManaged(state), true, 'minimal');
  const original = resolve(
    state + '.originals',
    digest(
      readFileSync(
        resolve(state + '.originals', readdirSync(state + '.originals')[0]!, 'original'),
      ),
    ),
    'original',
  );
  expect(readManaged(original)).toEqual({ before: manifest, after: manifest });
});
function exists(directory: string, name: string) {
  return readdirSync(directory).includes(name);
}
it('fails on a forged shared-pool boundary or blob and preserves legacy local pools', () => {
  const child = resolve(f.root, 'child');
  mkdirSync(child);
  const value = { large: 'facts '.repeat(20000) };
  const legacy = saveChatArtifact(child, 'legacy', value);
  shareArtifactPool(child, f.root);
  expect(readChatArtifact(legacy)).toEqual(value);
  const shared = saveChatArtifact(child, 'new', { ...value, extra: true });
  expect(readChatArtifact(shared)).toEqual({ ...value, extra: true });
  expect(() => shareArtifactPool(child, resolve(f.root, 'foreign'))).toThrow(
    'chat-artifact-pool-outside-root',
  );
  writeFileSync(
    resolve(child, '.workflow-pool.json'),
    canonical({ schema_version: 2, parent: '..' }),
  );
  expect(() => saveChatArtifact(child, 'bad', value)).toThrow('chat-artifact-pool-outside-root');
  writeFileSync(
    resolve(child, '.workflow-pool.json'),
    canonical({ schema_version: 1, parent: '../..' }),
  );
  expect(() => saveChatArtifact(child, 'bad', value)).toThrow('chat-artifact-pool-outside-root');
  expect(() => readArtifactBlob(child, '../escape')).toThrow('chat-artifact-conflict');
});
