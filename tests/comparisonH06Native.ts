import { lstatSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { createPrivateDirectory, safeDirectory } from '../adapters/storage/storeFiles.js';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import { taskChecks } from '../src/adapters/project/taskChecks.js';
import { requireContract } from '../src/contracts/project.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  checkH06NativeFailure,
  observeH06NativeFailure,
  validateH06NativeFailureBinding,
  type H06NativeFailureBinding,
} from './comparisonH06NativeFailure.js';

/** Entry stage of an authorized variant in its own fresh workspace and evidence root. */
export async function startH06NativeVariant<T>(
  binding: H06NativeFailureBinding,
  evidenceRoot: string,
  startWriter: (initialFailure: H04Pin) => Promise<T>,
) {
  const node = validateH06NativeFailureBinding(binding);
  const workspace = safeDirectory(binding.workspaceRoot);
  const evidence = safeDirectory(evidenceRoot);
  requireContract(
    evidence !== workspace &&
      !evidence.startsWith(workspace + sep) &&
      !workspace.startsWith(evidence + sep),
    'h06-f01-evidence-overlap',
  );
  const directory = join(evidence, 'f01');
  const identity = (path: string) => {
    const stat = lstatSync(safeDirectory(path), { bigint: true });
    return [stat.dev, stat.ino];
  };
  const workspaceIdentity = identity(workspace);
  const before = observeH06NativeFailure(workspace);
  readH04Pin(node);
  // The stage directory is also the one-shot claim, including after an interrupted check.
  createPrivateDirectory(directory);
  const stageIdentity = identity(directory);
  const command = {
    executable: node.path,
    sha256: node.sha256,
    args: ['checks.mjs'],
    timeoutMs: binding.timeoutMs,
  };
  const checks = taskChecks(join(directory, 'checker'), new NativeWriterProcesses());
  const outcome = await checks.run(workspace, command);
  readH04Pin(node);
  const after = observeH06NativeFailure(workspace);
  requireContract(
    same(identity(directory), stageIdentity) && same(identity(workspace), workspaceIdentity),
    'h06-f01-directory-changed',
  );
  const bytes = Buffer.from(
    JSON.stringify({ kind: 'h06-native-f01', binding, before, after, outcome }),
  );
  const path = join(directory, 'receipt.json');
  publishFile(path, bytes);
  const initialFailure = checkH06NativeFailure(binding, { path, sha256: digest(bytes) });
  return { initialFailure, writer: await startWriter(initialFailure) };
}
