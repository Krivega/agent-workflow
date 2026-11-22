import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  renameSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { requireStore, StoreFault } from '../../core/evidence.js';
import { digest } from './storeCodec.js';
import { fileLocation, locationPrefix } from './fileLocations.js';

export type StorageBoundary = 'blob-written' | 'blob-published' | 'before-commit' | 'after-commit';
export type StorageProbe = (boundary: StorageBoundary) => void;
export const noStorageProbe: StorageProbe = () => {};

export function safeDirectory(path: string): string {
  requireStore(isAbsolute(path) && resolve(path) === path, 'permission-denied');
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    requireStore(stat.isDirectory() && !stat.isSymbolicLink(), 'permission-denied');
  }
  return realpathSync(path);
}

export function createPrivateDirectory(path: string): void {
  safeDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  syncDirectory(dirname(path));
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readLocalFile(path: string, prefixBytes?: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireStore(stat.isFile() && stat.nlink === 1, 'permission-denied');
    if (prefixBytes === undefined) return readFileSync(fd);
    const prefix = Buffer.alloc(prefixBytes);
    return prefix.subarray(0, readSync(fd, prefix, 0, prefixBytes, 0));
  } finally {
    closeSync(fd);
  }
}
export function readPrivateFile(path: string, prefixBytes?: number): Buffer {
  const bytes = readLocalFile(path, prefixBytes);
  if (prefixBytes !== undefined) return bytes;
  const location = fileLocation(path, bytes, readLocalFile);
  if (location === null) return bytes;
  safeDirectory(dirname(location.path));
  const original = readLocalFile(location.path);
  requireStore(digest(original) === location.hash, 'corrupt');
  return original;
}
export function privateFileSource(path: string) {
  const prefix = readLocalFile(path, locationPrefix.length);
  const location =
    prefix.toString('utf8') === locationPrefix
      ? fileLocation(path, readLocalFile(path), readLocalFile)
      : null;
  const source = location?.path ?? path;
  safeDirectory(dirname(source));
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  try {
    const stat = fstatSync(fd);
    requireStore(stat.isFile() && stat.nlink === 1, 'permission-denied');
    const buffer = Buffer.alloc(65536);
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
  } finally {
    closeSync(fd);
  }
  const observed = hash.digest('hex');
  requireStore(location === null || observed === location.hash, 'corrupt');
  return { path: source, hash: observed, kind: location?.kind ?? null };
}

export function writePrivateFile(path: string, content: string | Buffer): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

export function databaseVersion(path: string): number {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(100);
    requireStore(
      readSync(descriptor, header, 0, 100, 0) === 100 &&
        header.subarray(0, 16).toString() === 'SQLite format 3\u0000',
      'corrupt',
    );
    return header.readUInt32BE(60);
  } finally {
    closeSync(descriptor);
  }
}

export class StoreFiles {
  private readonly identity: { dev: number; ino: number };
  private readonly pinned: { path: string; dev: number; ino: number }[];
  constructor(
    readonly root: string,
    private readonly probe: StorageProbe,
  ) {
    safeDirectory(root);
    const stat = lstatSync(root);
    requireStore((stat.mode & 0o077) === 0 && stat.uid === process.getuid!(), 'permission-denied');
    this.identity = { dev: stat.dev, ino: stat.ino };
    this.pinned = ['blobs', 'store.sqlite', 'identity.json'].map((name) => {
      const path = join(root, name);
      const identity = lstatSync(path);
      return { path, dev: identity.dev, ino: identity.ino };
    });
    this.assertRoot();
  }

  assertRoot(): void {
    safeDirectory(this.root);
    const stat = lstatSync(this.root);
    requireStore(
      stat.ino === this.identity.ino && stat.dev === this.identity.dev && (stat.mode & 0o077) === 0,
      'permission-denied',
    );
    safeDirectory(join(this.root, 'blobs'));
    for (const pin of this.pinned) {
      const current = lstatSync(pin.path);
      requireStore(current.ino === pin.ino && current.dev === pin.dev, 'permission-denied');
    }
    for (const name of ['store.sqlite', 'store.sqlite-journal', 'identity.json']) {
      const path = join(this.root, name);
      const file = lstatSync(path, { throwIfNoEntry: false });
      if (file) {
        requireStore(
          file.isFile() && !file.isSymbolicLink() && file.nlink === 1,
          'permission-denied',
        );
      }
    }
  }

  blobPath(hash: string): string {
    requireStore(/^[a-f0-9]{64}$/.test(hash), 'corrupt');
    this.assertRoot();
    return join(this.root, 'blobs', hash);
  }

  readBlob(hash: string): string {
    const content = readPrivateFile(this.blobPath(hash));
    requireStore(digest(content) === hash, 'corrupt');
    return content.toString('utf8');
  }

  publish(content: string): string {
    const hash = digest(content);
    const destination = this.blobPath(hash);
    if (existsSync(destination)) {
      this.readBlob(hash);
      return hash;
    }
    const temporary = join(this.root, 'blobs', `.pending-${randomUUID()}`);
    writePrivateFile(temporary, content);
    this.probe('blob-written');
    this.assertRoot();
    // The caller holds BEGIN IMMEDIATE, serializing publication in this private root.
    // rename avoids a hard-link window that could survive a killed writer.
    renameSync(temporary, destination);
    syncDirectory(dirname(destination));
    this.probe('blob-published');
    requireStore(this.readBlob(hash) === content, 'corrupt');
    return hash;
  }
}

export function parseStored<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new StoreFault('corrupt');
  }
}
