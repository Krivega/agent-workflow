import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireWorkflow } from '../../core/connection.js';
import { readPrivateFile, safeDirectory } from '../storage/storeFiles.js';

export async function writerScopeHash(markers: string[], tree?: string): Promise<string> {
  const hash = createHash('sha256');
  for (const path of markers) {
    hash.update(path);
    hash.update(readPrivateFile(path));
  }
  if (tree !== undefined) {
    safeDirectory(tree);
    const root = await lstat(tree);
    hash.update(JSON.stringify({ tree, dev: root.dev, ino: root.ino }));
    const walk = async (directory: string) => {
      for (const name of (await readdir(directory)).sort()) {
        const path = resolve(directory, name),
          stat = await lstat(path);
        hash.update(JSON.stringify({ path, mode: stat.mode }));
        if (stat.isDirectory()) await walk(path);
        else if (stat.isSymbolicLink()) hash.update(await readlink(path));
        else {
          requireWorkflow(stat.isFile(), 'writer-scope-file-unsupported');
          hash.update(await readFile(path));
        }
      }
    };
    await walk(tree);
  }
  return hash.digest('hex');
}
