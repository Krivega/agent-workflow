import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coderFixture } from './coderFixtures.js';
import { reserveCoder } from '../core/coder.js';
import type { CoderRun } from '../core/coder.js';
import { coderCreationRefusal, refuseCoderCreation } from '../adapters/codex/coderCreation.js';
let f: Awaited<ReturnType<typeof coderFixture>>, run: CoderRun, directory: string, journal: string;
beforeEach(async () => {
  f = await coderFixture();
  const brief = await f.brief();
  run = reserveCoder(f.executor, brief, await f.workspaces.capture(brief), []);
  directory = resolve(f.db.parent, 'refusal');
  journal = resolve(directory, 'transport.jsonl');
  await mkdir(directory);
});
afterEach(async () => {
  await f.dispose();
});
it('recovers the original refusal and a crash between immutable proof and disposition', async () => {
  expect(coderCreationRefusal(directory, journal, run)).toBeNull();
  const first = await refuseCoderCreation(directory, journal, run, 'fixture no native effect');
  expect(
    await refuseCoderCreation(directory, journal, run, 'new reason cannot replace original'),
  ).toEqual(first);
  await unlink(resolve(directory, 'creation-not-started.json'));
  expect(await refuseCoderCreation(directory, journal, run, 'fixture no native effect')).toEqual(
    first,
  );
  if (first.outcome !== 'not-started') throw Error('fixture refusal missing');
  await writeFile(first.receipt.locator, (await readFile(first.receipt.locator, 'utf8')) + ' ');
  expect(() => coderCreationRefusal(directory, journal, run)).toThrow('coder-refusal-unconfirmed');
});
