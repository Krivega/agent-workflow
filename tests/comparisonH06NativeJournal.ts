import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { requireContract } from '../src/contracts/project.js';

const identity = (stat: Stats) => [stat.dev, stat.ino, stat.mode, stat.nlink];

function readExactly(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, { offset, length: size - offset, position: offset });
    requireContract(count > 0, 'h06-native-journal-short-read');
    offset += count;
  }
  return bytes;
}

/** Read one stable complete JSONL prefix while allowing a native host to append new bytes. */
export function readH06NativeJournal(path: string): Buffer {
  requireContract(isAbsolute(path) && resolve(path) === path, 'h06-native-journal-path');
  const parent = dirname(path);
  requireContract(
    safeDirectory(parent) === parent && realpathSync(path) === path,
    'h06-native-journal-alias',
  );
  const before = lstatSync(path);
  requireContract(before.isFile() && before.nlink === 1, 'h06-native-journal-kind');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd),
      current = lstatSync(path);
    requireContract(opened.isFile() && opened.nlink === 1, 'h06-native-journal-kind');
    requireContract(
      Number.isSafeInteger(opened.size) && opened.size >= 0,
      'h06-native-journal-size',
    );
    requireContract(
      safeDirectory(parent) === parent &&
        same(identity(before), identity(opened)) &&
        same(identity(opened), identity(current)) &&
        opened.size >= before.size &&
        current.size >= opened.size,
      'h06-native-journal-changed',
    );
    const bytes = readExactly(fd, opened.size);
    // Compare the entire initial snapshot, including its unfinished tail, without following growth.
    requireContract(readExactly(fd, opened.size).equals(bytes), 'h06-native-journal-changed');
    const after = fstatSync(fd),
      retained = lstatSync(path);
    requireContract(
      safeDirectory(parent) === parent &&
        realpathSync(path) === path &&
        same(identity(opened), identity(after)) &&
        same(identity(opened), identity(retained)) &&
        after.size >= opened.size &&
        retained.size >= opened.size,
      'h06-native-journal-changed',
    );
    const prefix = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
    requireContract(
      Buffer.from(prefix.toString('utf8')).equals(prefix),
      'h06-native-journal-encoding',
    );
    return prefix;
  } finally {
    closeSync(fd);
  }
}
