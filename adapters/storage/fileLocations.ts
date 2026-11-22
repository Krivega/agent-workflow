import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { requireStore } from '../../core/evidence.js';
import { canonicalHash } from './storeCodec.js';

export const locationsName = '.workflow-files.json';
export const locationPrefix = 'AWLOCATION1\n';
export interface LocatedFile {
  hash: string;
  bytes: number;
  mode: number;
  kind: 'archive' | 'tool';
  bundle?: string;
}
export interface FileLocations {
  schema_version: 1;
  root: string;
  operation_hash: string;
  complete: boolean;
  files: Record<string, LocatedFile>;
}
export const filePointer = (hash: string) => locationPrefix + hash + '\n';
export function locatedPath(root: string, name: string, entry: LocatedFile) {
  requireStore(
    /^[a-f0-9]{64}$/u.test(entry.hash) &&
      Number.isSafeInteger(entry.bytes) &&
      entry.bytes >= 0 &&
      Number.isSafeInteger(entry.mode),
    'corrupt',
  );
  requireStore(
    resolve(root, name).startsWith(root + '/') && relative(root, resolve(root, name)) === name,
    'permission-denied',
  );
  if (entry.kind === 'tool') {
    requireStore(
      typeof entry.bundle === 'string' &&
        /^[a-f0-9]{64}$/u.test(entry.bundle) &&
        name.startsWith('native-tools/'),
      'corrupt',
    );
    return resolve(dirname(root), 'tool-cache', entry.bundle, name.slice('native-tools/'.length));
  }
  requireStore(entry.kind === 'archive', 'corrupt');
  return resolve(dirname(root), 'archives', canonicalHash(root), entry.hash);
}
export function fileLocation(path: string, bytes: Buffer, read: (path: string) => Buffer) {
  if (!bytes.toString('utf8', 0, locationPrefix.length).startsWith(locationPrefix)) return null;
  for (let root = dirname(path); root !== dirname(root); root = dirname(root)) {
    const index = resolve(root, locationsName);
    if (!existsSync(index)) continue;
    const value = JSON.parse(read(index).toString('utf8')) as FileLocations;
    requireStore(
      value.schema_version === 1 &&
        value.root === root &&
        value.files !== null &&
        typeof value.files === 'object' &&
        !Array.isArray(value.files),
      'corrupt',
    );
    const name = relative(root, path),
      entry = Object.hasOwn(value.files, name) ? value.files[name] : undefined;
    if (entry === undefined) return null;
    requireStore(bytes.toString('utf8') === filePointer(entry.hash), 'corrupt');
    return { path: locatedPath(root, name, entry), hash: entry.hash, kind: entry.kind };
  }
  return null;
}
