import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectManifestReader } from '../../ports/projectManifestReader.js';

export const fileProjectManifestReader: ProjectManifestReader = {
  async read(root) {
    const content = await readFile(resolve(root, 'package.json'), 'utf8');
    return JSON.parse(content) as unknown;
  },
};
