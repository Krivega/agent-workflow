import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { requireWorkflow } from '../../core/connection.js';
import { archiveHashes, decodeArchivedJson, readArchive } from './archiveJson.js';
import { canonical, digest } from './storeCodec.js';
import { readArtifactBlob } from './sharedArtifacts.js';
import {
  createPrivateDirectory,
  readPrivateFile,
  safeDirectory,
  writePrivateFile,
} from './storeFiles.js';

// A legacy file is replaced only after its exact bytes and reachable pool are recoverable.
export function preserveManagedOriginal(path: string, original: Buffer): void {
  const hash = digest(original),
    parent = path + '.originals',
    root = resolve(parent, hash);
  const directory = (path: string) => {
    if (!existsSync(path)) createPrivateDirectory(path);
    safeDirectory(path);
  };
  directory(parent);
  directory(root);
  const files: Record<string, string> = {};
  const publish = (name: string, bytes: Buffer) => {
    const target = resolve(root, name),
      expected = digest(bytes);
    if (!existsSync(target)) writePrivateFile(target, bytes);
    requireWorkflow(digest(readPrivateFile(target)) === expected, 'managed-original-corrupt');
    files[name] = expected;
  };
  publish('original', original);
  const read = (child: string) => {
    requireWorkflow(/^[a-f0-9]{64}$/u.test(child), 'managed-original-corrupt');
    const name = 'shared-json/' + child;
    const bytes = Buffer.from(readArtifactBlob(dirname(path), child));
    requireWorkflow(digest(bytes) === child, 'managed-original-corrupt');
    directory(resolve(root, 'shared-json'));
    publish(name, bytes);
    return bytes.toString('utf8');
  };
  const value = decodeArchivedJson(original.toString('utf8'), read, false);
  for (const child of archiveHashes(value)) readArchive(child, read);
  publish(
    'manifest.json',
    Buffer.from(canonical({ schema_version: 1, source: path, hash, files: { ...files } })),
  );
}
