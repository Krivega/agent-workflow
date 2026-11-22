import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localLocator, requireWorkflow } from '../../core/connection.js';
import type { WorkScope } from '../../core/coordination.js';

export async function verifyWorkScope(scope: WorkScope) {
  requireWorkflow(
    (await realpath(scope.workspace)) === scope.workspace,
    'workspace-alias-forbidden',
  );
  for (const path of scope.paths) {
    localLocator(path);
    let current = scope.workspace;
    for (const part of path.split('/')) {
      current = resolve(current, part);
      const stat = await lstat(current).catch((error: unknown) => {
        if ((error as { code: string }).code === 'ENOENT') return null;
        throw error;
      });
      if (stat === null) break;
      requireWorkflow(
        !stat.isSymbolicLink() && (stat.isDirectory() || stat.nlink === 1),
        'scope-alias-forbidden',
      );
    }
  }
}

import { FileWorkflowInputs } from './workflowInputs.js';
import type { CoordinationInputs } from '../../ports/coordinationJournal.js';
export class FileCoordinationInputs implements CoordinationInputs {
  readonly evidence: FileWorkflowInputs;
  constructor(
    root: string,
    private readonly roots: string[],
    private readonly evidenceRoot: string,
  ) {
    this.evidence = new FileWorkflowInputs(root, evidenceRoot);
  }
  async workspace(scope: WorkScope) {
    requireWorkflow(this.roots.includes(scope.workspace), 'coordination-workspace-not-authorized');
    await verifyWorkScope(scope);
    return new FileWorkflowInputs(scope.workspace, this.evidenceRoot);
  }
}
