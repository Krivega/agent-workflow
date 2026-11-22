import type { EvidenceStore } from '../../ports/evidenceStore.js';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  BackupReceipt,
  EvidenceGrant,
  TechnicalState,
  OperationResult,
} from '../../core/evidence.js';
import type { InputRef } from '../../core/localRun.js';
import { requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import { exportStore } from './storeBackup.js';
import { readPrivateFile, safeDirectory } from './storeFiles.js';
import { digest, requestHash } from './storeCodec.js';

export async function backupSupervision(
  store: EvidenceStore,
  root: string,
  evidence: string,
  grant: EvidenceGrant,
  state: TechnicalState,
  operation: string,
): Promise<InputRef> {
  const mutation = async (type: 'freeze' | 'thaw', source: TechnicalState) => {
    const request = {
      context: grant.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: `supervision-backup:${digest(operation)}:${type}`,
          expected_revision: source.revision,
          owner_generation: source.generation,
          payload_hash: '',
        },
        change: { type },
      },
    };
    request.command.mutation.payload_hash = requestHash(request);
    const reply = await store.execute(request);
    requireWorkflow(reply.ok, `supervision-backup-${type}-rejected`);
  };
  const parent = resolve(evidence, 'supervision-backups');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  safeDirectory(parent);
  const destination = resolve(parent, digest(operation));
  const existing = existsSync(destination);
  if (existing) safeDirectory(destination);
  let frozen: TechnicalState;
  if (!existing) {
    requireWorkflow(!state.frozen, 'supervision-backup-source-frozen');
    await mutation('freeze', state);
    const frozenReply = await store.execute({
      context: grant.context,
      command: { type: 'state', archive: 'current' },
    });
    requireWorkflow(frozenReply.ok, 'supervision-backup-state-unavailable');
    frozen = frozenReply.value as TechnicalState;
    requireWorkflow(
      sameValue(frozen, { ...state, frozen: true, revision: state.revision + 1 }),
      'supervision-backup-source-changed',
    );
    await exportStore(root, destination, grant);
  } else {
    const bytes = readPrivateFile(resolve(destination, 'manifest.json'));
    frozen = (JSON.parse(bytes.toString('utf8')) as { state: TechnicalState }).state;
    const reply = await store.execute({
      context: grant.context,
      command: { type: 'operation', operation_id: `supervision-backup:${digest(operation)}:thaw` },
    });
    requireWorkflow(
      reply.ok && (reply.value as OperationResult).status === 'confirmed',
      'supervision-backup-outcome-unknown',
    );
    requireWorkflow(
      sameValue(state, { ...frozen, frozen: false, revision: frozen.revision + 1 }),
      'supervision-backup-source-changed',
    );
  }
  const locator = resolve(destination, 'receipt.json');
  const bytes = readPrivateFile(locator);
  const receipt = JSON.parse(bytes.toString('utf8')) as BackupReceipt;
  const manifestBytes = readPrivateFile(resolve(destination, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { state: TechnicalState };
  requireWorkflow(
    receipt.project_id === grant.context.project_id &&
      receipt.task_id === grant.context.task_id &&
      receipt.revision === frozen.revision &&
      digest(manifestBytes) === receipt.manifest_hash &&
      digest(readPrivateFile(resolve(destination, 'store.sqlite'))) === receipt.database_hash &&
      sameValue(manifest.state, frozen),
    'supervision-backup-mismatch',
  );
  for (const hash of receipt.blobs)
    requireWorkflow(
      digest(readPrivateFile(resolve(destination, 'blobs', hash))) === hash,
      'supervision-backup-corrupt',
    );
  if (!existing) await mutation('thaw', frozen);
  return { locator, hash: digest(bytes) };
}
