import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { localLocator } from '../core/connection.js';
import type { Council } from '../core/council.js';
import type { InputRef } from '../core/localRun.js';
import { object, requireContract } from '../src/contracts/project.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';

/** Resolve existing reviewed inputs before a fresh Legacy attempt consumes its grant. */
export function h06PlanningDirectory(
  workspace: string,
  evidenceRoot: string,
  acceptedPlan: InputRef,
  runtime: readonly H04Pin[],
) {
  const path = join(workspace, localLocator(acceptedPlan.locator));
  const bytes = readH04Pin({ path, sha256: acceptedPlan.hash });
  const plan = object(decodeChatArtifact(dirname(path), bytes.toString('utf8'), false));
  requireContract(
    (plan.requirements_revision ?? 0) === 0,
    'h06-package-initial-requirements-revision',
  );
  if (plan.council_selection === undefined) return;
  let directory: string | undefined;
  const council = plan.council as Council;
  for (const [role, selected] of Object.entries(council.selection)) {
    if (!selected.trigger) continue;
    const snapshots = selected.requirements.filter(
      (ref) => isAbsolute(ref.locator) && basename(ref.locator).startsWith(`selection-${role}-`),
    );
    requireContract(snapshots.length === 1, 'h06-package-planning-snapshot');
    const { locator, hash } = snapshots[0]!;
    const pin = runtime.find((entry) => entry.path === locator && entry.sha256 === hash);
    requireContract(pin !== undefined, 'h06-package-planning-snapshot-unpinned');
    readH04Pin(pin);
    const parent = dirname(locator);
    requireContract(
      (directory === undefined || directory === parent) &&
        parent !== dirname(parent) &&
        ![workspace, evidenceRoot].some((root) => root === parent || root.startsWith(parent + sep)),
      'h06-package-planning-directory',
    );
    directory = parent;
  }
  return directory;
}
