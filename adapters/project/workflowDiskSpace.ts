import { statfs } from 'node:fs/promises';
import { requireWorkflow } from '../../core/connection.js';

export async function requireWorkflowDiskSpace(root: string, evidence: string) {
  for (const directory of new Set([root, evidence])) {
    const space = await statfs(directory);
    const available = space.bavail * space.bsize;
    requireWorkflow(available >= 1024 ** 3, `workflow-disk-space-low:${directory}:${available}`);
  }
}
