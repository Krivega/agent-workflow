import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname, resolve } from 'node:path';
import { requireWorkflow } from '../../core/connection.js';
import { safeDirectory } from '../storage/storeFiles.js';
import { projectPath } from './projectFiles.js';

export async function verifyComparisonMaterial(
  root: string,
  files: Record<string, string>,
  mutable: string[],
) {
  const base = safeDirectory(root);
  requireWorkflow(base === root, 'unsafe-project-path');
  const version = (stat: Stats) => [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ];
  for (const [locator, content] of Object.entries(files)) {
    const path = await projectPath(base, locator);
    requireWorkflow(path === resolve(base, locator), 'unsafe-project-path');
    safeDirectory(dirname(path));
    const before = lstatSync(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      requireWorkflow(opened.isFile() && opened.nlink === 1, 'unsafe-project-file');
      safeDirectory(base);
      safeDirectory(dirname(path));
      requireWorkflow(
        isDeepStrictEqual(version(before), version(opened)) &&
          isDeepStrictEqual(version(lstatSync(path)), version(opened)),
        'comparison-material-changed',
      );
      const bytes = readFileSync(fd),
        after = fstatSync(fd);
      safeDirectory(base);
      safeDirectory(dirname(path));
      requireWorkflow(
        isDeepStrictEqual(version(opened), version(after)) &&
          isDeepStrictEqual(version(after), version(lstatSync(path))),
        'comparison-material-changed',
      );
      requireWorkflow(
        mutable.includes(locator) || bytes.equals(Buffer.from(content, 'utf8')),
        'comparison-material-changed',
      );
    } finally {
      closeSync(fd);
    }
  }
}
