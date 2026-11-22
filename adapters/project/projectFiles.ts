import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { localLocator, requireWorkflow } from '../../core/connection.js';
import { readPrivateFile } from '../storage/storeFiles.js';

export const contentHash = (content: string) => createHash('sha256').update(content).digest('hex');

export async function projectPath(root: string, locator: string): Promise<string> {
  localLocator(locator);
  const base = await realpath(root);
  const path = resolve(base, locator);
  // Reject aliases as well as escapes; a descriptor is never authority over another root.
  const actual = await realpath(path);
  requireWorkflow(actual === path && actual.startsWith(base + sep), 'unsafe-project-path');
  const stat = await lstat(path);
  requireWorkflow(stat.isFile() && stat.nlink === 1, 'unsafe-project-file');
  return path;
}
export async function projectText(root: string, locator: string): Promise<string> {
  return readPrivateFile(await projectPath(root, locator)).toString('utf8');
}
