import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { object, requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import type { CoderRun } from '../../core/coder.js';
import type { CoderCreation } from '../../ports/coder.js';
import type { InputRef } from '../../core/localRun.js';
import { nativeCreationProof } from './transportJournal.js';
import { canonical, digest } from '../storage/storeCodec.js';
import { readPrivateFile, safeDirectory } from '../storage/storeFiles.js';

export function coderCreationRefusal(
  directory: string,
  journal: string,
  run: CoderRun,
): CoderCreation | null {
  const path = resolve(directory, 'creation-not-started.json');
  if (!existsSync(path)) return null;
  const source = object(JSON.parse(readPrivateFile(path).toString('utf8')) as unknown);
  requireWorkflow(
    source.schema_version === 1 &&
      sameValue(source.brief, run.brief) &&
      nativeCreationProof(journal, `coder:${run.brief.id}:create`) === null,
    'coder-refusal-unconfirmed',
  );
  const receipt = object(source.receipt) as unknown as InputRef;
  const bytes = readPrivateFile(receipt.locator),
    proof = object(JSON.parse(bytes.toString('utf8')) as unknown);
  requireWorkflow(
    digest(bytes) === receipt.hash &&
      proof.kind === 'coder-not-started' &&
      proof.operation === `coder:${run.brief.id}:create` &&
      proof.native_creation === null &&
      sameValue(proof.brief, run.brief),
    'coder-refusal-unconfirmed',
  );
  return { outcome: 'not-started', receipt };
}
export async function refuseCoderCreation(
  directory: string,
  journal: string,
  run: CoderRun,
  reason: string,
): Promise<CoderCreation> {
  const previous = coderCreationRefusal(directory, journal, run);
  if (previous !== null) return previous;
  requireWorkflow(
    nativeCreationProof(journal, `coder:${run.brief.id}:create`) === null,
    'coder-creation-outcome-unknown',
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  safeDirectory(directory);
  const bytes =
    canonical({
      kind: 'coder-not-started',
      operation: `coder:${run.brief.id}:create`,
      brief: run.brief,
      native_creation: null,
      reason,
    }) + '\n';
  const hash = digest(bytes),
    locator = resolve(directory, `not-started-${hash}.json`);
  if (existsSync(locator))
    requireWorkflow(readPrivateFile(locator).toString('utf8') === bytes, 'coder-refusal-conflict');
  else await writeFile(locator, bytes, { flag: 'wx', mode: 0o600 });
  const receipt = { locator, hash };
  await writeFile(
    resolve(directory, 'creation-not-started.json'),
    canonical({ schema_version: 1, brief: run.brief, receipt }),
    { flag: 'wx', mode: 0o600 },
  );
  return { outcome: 'not-started', receipt };
}
