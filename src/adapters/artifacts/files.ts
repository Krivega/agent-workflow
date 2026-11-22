import {
  constants,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  fsyncSync,
  mkdirSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { requireContract, relativePath } from '../../contracts/project.js';
import type { ArtifactRef } from '../../contracts/preparation.js';

export function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function syncDirectory(root: string): void {
  const fd = openSync(root, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function privateDirectory(root: string): string {
  const path = resolve(root);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  requireContract(realpathSync(path) === path && lstatSync(path).isDirectory(), 'unsafe-directory');
  return path;
}

export function readProjectFile(root: string, path: string): Buffer {
  const base = realpathSync(root);
  const target = resolve(base, relativePath(path));
  requireContract(
    realpathSync(target) === target && target.startsWith(base + sep),
    'unsafe-project-file',
  );
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function publishFile(path: string, bytes: Uint8Array): void {
  const temporary = join(dirname(path), `.pending-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    unlinkSync(temporary);
  }
}

export function readPrivateFile(path: string): Buffer {
  requireContract(realpathSync(path) === path && lstatSync(path).isFile(), 'unsafe-private-file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function artifactStore(directory: string, options: { existingOnly?: boolean } = {}) {
  const root = options.existingOnly ? resolve(directory) : privateDirectory(directory),
    existing = options.existingOnly ? lstatSync(root, { bigint: true }) : null;
  function boundRoot() {
    if (existing === null) return;
    const current = lstatSync(root, { bigint: true });
    requireContract(
      realpathSync(root) === root &&
        current.isDirectory() &&
        current.dev === existing.dev &&
        current.ino === existing.ino,
      'artifact-root-changed',
    );
  }
  boundRoot();
  const published = new Map<string, string>();
  function identity(path: string): string {
    const stat = lstatSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  }
  function read(ref: ArtifactRef): Buffer {
    boundRoot();
    requireContract(
      /^[a-f0-9]{64}$/u.test(ref.sha256) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0,
      'invalid-artifact-ref',
    );
    const bytes = readPrivateFile(join(root, ref.sha256));
    boundRoot();
    requireContract(
      bytes.length === ref.bytes && digest(bytes) === ref.sha256,
      'artifact-corrupted',
    );
    return bytes;
  }
  return {
    read,
    path(ref: ArtifactRef): string {
      read(ref);
      return join(root, ref.sha256);
    },
    publish(bytes: Uint8Array): ArtifactRef {
      boundRoot();
      const ref = { sha256: digest(bytes), bytes: bytes.length };
      const path = join(root, ref.sha256);
      const previous = published.get(ref.sha256);
      if (previous !== undefined) {
        try {
          if (identity(path) === previous) {
            read(ref);
            return ref;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        published.delete(ref.sha256);
      }
      try {
        publishFile(path, bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        syncDirectory(root);
      }
      read(ref);
      published.set(ref.sha256, identity(path));
      if (published.size > 1024) published.delete(published.keys().next().value!);
      return ref;
    },
  };
}
