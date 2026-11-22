import { watch } from 'node:fs';
import { resolve } from 'node:path';
import type { Council, CouncilRole } from '../core/council.js';
import type { councilReviewBasis } from '../core/council.js';
import { requireWorkflow } from '../core/connection.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';

export interface CouncilProgress {
  schema_version: 1;
  run_id: string;
  phase: Council['phase'];
  scope: string;
  target_hash: string;
  status: 'running' | 'completed' | 'failed';
  error?: string;
  roles: Partial<
    Record<
      CouncilRole,
      {
        status: 'pending' | 'loading' | 'reviewing' | 'retrying' | 'accepted' | 'failed';
        reason?: string;
        review_basis?: ReturnType<typeof councilReviewBasis>;
        session?: string;
        turn?: string;
        verdict?: string;
        error?: string;
      }
    >
  >;
}
export type CouncilSnapshot = CouncilProgress & { cursor: string };

export function saveCouncilProgress(directory: string, progress: CouncilProgress) {
  const snapshot = { ...progress, cursor: digest(canonical(progress)) };
  saveManaged(resolve(directory, 'progress.json'), snapshot, false);
  return snapshot;
}

export async function waitCouncilProgress(
  directory: string,
  after: string | null,
  timeoutMs: number,
  options: { until?: 'changed' | 'settled'; signal?: AbortSignal } = {},
) {
  requireWorkflow(
    Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60_000,
    'invalid-council-wait-timeout',
  );
  requireWorkflow(
    options.until === undefined || ['changed', 'settled'].includes(options.until),
    'invalid-council-wait-mode',
  );
  requireWorkflow(!options.signal?.aborted, 'council-wait-cancelled');
  safeDirectory(directory);
  const read = () => {
    const snapshot = readManaged<CouncilSnapshot>(resolve(directory, 'progress.json'));
    requireWorkflow(snapshot !== null, 'council-progress-missing');
    const { cursor, ...progress } = snapshot;
    requireWorkflow(
      progress.schema_version === 1 && cursor === digest(canonical(progress)),
      'invalid-council-progress',
    );
    return snapshot;
  };
  if (timeoutMs === 0) {
    const snapshot = read();
    return { changed: snapshot.cursor !== after, timed_out: false, snapshot };
  }
  return new Promise<{ changed: boolean; timed_out: boolean; snapshot: CouncilSnapshot }>(
    (resolve, reject) => {
      // Subscribe before reading: an atomic rename between these operations must not be missed.
      const watcher = watch(directory, (_event, name) => {
        if (name === null || name.toString() === 'progress.json') check(false);
      });
      const timer = setTimeout(() => check(true), timeoutMs);
      const reconcile = setInterval(() => check(false), 1000);
      let identity: string | undefined;
      let settled = false;
      const cancel = () => fail(new Error('council-wait-cancelled'));
      const close = () => {
        settled = true;
        clearTimeout(timer);
        clearInterval(reconcile);
        watcher.close();
        options.signal?.removeEventListener('abort', cancel);
      };
      const fail = (error: unknown) => {
        close();
        reject(error);
      };
      const check = (timedOut: boolean) => {
        if (settled) return;
        try {
          const snapshot = read();
          const target = canonical([
            snapshot.run_id,
            snapshot.phase,
            snapshot.scope,
            snapshot.target_hash,
          ]);
          requireWorkflow(
            identity === undefined || identity === target,
            'council-wait-target-changed',
          );
          identity = target;
          const changed = snapshot.cursor !== after;
          if (
            (changed && options.until !== 'settled') ||
            snapshot.status !== 'running' ||
            timedOut
          ) {
            close();
            resolve({
              changed,
              timed_out:
                timedOut &&
                snapshot.status === 'running' &&
                (options.until === 'settled' || !changed),
              snapshot,
            });
          }
        } catch (error) {
          fail(error);
        }
      };
      watcher.on('error', fail);
      options.signal?.addEventListener('abort', cancel, { once: true });
      check(false);
    },
  );
}
