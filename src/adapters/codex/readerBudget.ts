import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory, publishFile, readPrivateFile } from '../artifacts/files.js';
import { requireContract } from '../../contracts/project.js';

import { budgetExtensions } from './budgetExtension.js';

export function readerBudget(directory: string, limit: number) {
  requireContract(Number.isSafeInteger(limit) && limit >= 0, 'reader-model-budget-invalid');
  const root = privateDirectory(directory);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, limit }));
  const extension = budgetExtensions(root).at(-1);
  if (extension === undefined) {
    try {
      publishFile(join(root, 'limit'), bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    requireContract(
      readPrivateFile(join(root, 'limit')).equals(bytes),
      'reader-model-budget-conflict',
    );
  } else {
    requireContract(extension.limit === limit, 'reader-model-budget-conflict');
  }
  return (key: string, hash: string) => {
    requireContract(
      /^[a-f0-9]{64}$/u.test(key) && /^[a-f0-9]{64}$/u.test(hash),
      'reader-model-credit-invalid',
    );
    const lock = join(root, 'lock');
    mkdirSync(lock, { mode: 0o700 });
    try {
      const current = budgetExtensions(root).at(-1);
      requireContract(
        current ? extension?.bytes.equals(current.bytes) : extension === undefined,
        'task-budget-extension-changed',
      );
      for (let index = 0; index < limit; index++) {
        const path = join(root, `${index}.credit`);
        const credit = Buffer.from(JSON.stringify({ key, hash }));
        try {
          publishFile(path, credit);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const previous = JSON.parse(readPrivateFile(path).toString('utf8')) as {
          key: string;
          hash: string;
        };
        if (previous.key === key) {
          requireContract(previous.hash === hash, 'reader-model-credit-conflict');
          return;
        }
      }
      throw new Error('reader-model-budget-exhausted');
    } finally {
      rmdirSync(lock);
    }
  };
}
