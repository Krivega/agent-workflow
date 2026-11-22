import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivateFile, safeDirectory, syncDirectory, writePrivateFile } from './storeFiles.js';
import { encodeChatArtifact, decodeChatArtifact, retainedInlinePrefix } from './sharedArtifacts.js';
import { canonical, digest } from './storeCodec.js';
import { preserveManagedOriginal } from './managedOriginal.js';
import { requireWorkflow } from '../../core/connection.js';

export function readManaged<T>(path: string, options?: { archive: boolean }): T | null {
  if (!existsSync(path)) return null;
  return decodeChatArtifact(
    dirname(path),
    readPrivateFile(path).toString('utf8'),
    options?.archive ?? false,
  ) as T;
}
export function saveManaged(
  path: string,
  value: unknown,
  shared = true,
  archive: boolean | 'minimal' = false,
) {
  safeDirectory(dirname(path));
  let original: Buffer | null = null;
  if (existsSync(path)) {
    const prefix = readPrivateFile(
      path,
      archive === 'minimal' ? Buffer.byteLength(retainedInlinePrefix) : 0,
    );
    if (archive === 'minimal' && prefix.toString('utf8') !== retainedInlinePrefix) {
      original = readPrivateFile(path);
      preserveManagedOriginal(path, original);
    }
  }
  const temporary = resolve(dirname(path), `.managed-${randomUUID()}`);
  writePrivateFile(
    temporary,
    shared ? encodeChatArtifact(dirname(path), value, archive) : canonical(value) + '\n',
  );
  try {
    if (original !== null)
      requireWorkflow(
        digest(readPrivateFile(path)) === digest(original),
        'managed-original-changed',
      );
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
