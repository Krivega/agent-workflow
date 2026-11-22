import { dirname } from 'node:path';
import type { InputRef } from '../../core/localRun.js';
import { requireWorkflow } from '../../core/connection.js';
import { digest } from './storeCodec.js';
import { archiveHashes, archivePrefix, decodeArchivedJson, readArchive } from './archiveJson.js';
import { retainedPrefix } from './sharedJson.js';
import {
  artifactBlobPath,
  decodeChatArtifact,
  readArtifactBlob,
  retainedInlinePrefix,
} from './sharedArtifacts.js';
import { privateFileSource, readPrivateFile } from './storeFiles.js';

export function artifactDependencies(
  ref: InputRef,
  authorize: (path: string) => void,
  original?: string,
): InputRef[] {
  const path = ref.locator;
  const source =
    original === undefined ? privateFileSource(path) : { path, hash: digest(original) };
  requireWorkflow(source.hash === ref.hash, 'workflow-input-changed');
  const prefix =
    original === undefined
      ? readPrivateFile(source.path, 16).toString('utf8')
      : original.slice(0, 16);
  if (
    !['AWJSON1\n', archivePrefix, retainedPrefix, retainedInlinePrefix].some((p) =>
      prefix.startsWith(p),
    )
  )
    return [];
  const bytes = original ?? readPrivateFile(path).toString('utf8');
  requireWorkflow(digest(bytes) === ref.hash, 'workflow-input-changed');
  if (bytes.startsWith(retainedInlinePrefix)) {
    decodeChatArtifact(dirname(path), bytes);
    return [];
  }
  const dependencies = new Map<string, InputRef>();
  const read = (hash: string) => {
    const locator = artifactBlobPath(dirname(path), hash);
    authorize(locator);
    const content = readArtifactBlob(dirname(path), hash);
    dependencies.set(locator, { locator, hash });
    return content;
  };
  const value = decodeArchivedJson(bytes, read, false);
  for (const hash of archiveHashes(value)) readArchive(hash, read);
  return [...dependencies.values()];
}
