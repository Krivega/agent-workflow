import { join } from 'node:path';
import {
  requireStore,
  type OperationResult,
  type StoreReply,
  type StoreRequest,
} from '../../core/evidence.js';
import type { EvidenceStore } from '../../ports/evidenceStore.js';
import type { FallbackReceipt } from '../../ports/evidenceFallback.js';
import { canonical, digest } from './storeCodec.js';
import {
  createPrivateDirectory,
  parseStored,
  readPrivateFile,
  safeDirectory,
  writePrivateFile,
} from './storeFiles.js';

export function saveFallback(
  assignmentRoot: string,
  request: StoreRequest,
  summary: string,
): FallbackReceipt {
  requireStore(
    request.command.type === 'mutate' &&
      ['write', 'supersede'].includes(request.command.change.type),
    'invalid-context',
  );
  requireStore(Buffer.byteLength(summary) <= 5000, 'budget-exhausted');
  safeDirectory(assignmentRoot);
  const serialized = canonical(request);
  const hash = digest(serialized);
  const root = join(assignmentRoot, hash);
  createPrivateDirectory(root);
  // Full request retains command, exit, provenance, inputs and raw output without truncation.
  writePrivateFile(join(root, 'request.json'), serialized);
  const receipt: FallbackReceipt = {
    status: 'fallback',
    store_check: 'NOT RUN',
    locator: root,
    summary,
    request_hash: hash,
  };
  writePrivateFile(join(root, 'receipt.json'), canonical(receipt));
  return receipt;
}

export async function importFallback(locator: string, store: EvidenceStore): Promise<StoreReply> {
  safeDirectory(locator);
  const receipt = parseStored<FallbackReceipt>(
    readPrivateFile(join(locator, 'receipt.json')).toString('utf8'),
  );
  const content = readPrivateFile(join(locator, 'request.json')).toString('utf8');
  requireStore(digest(content) === receipt.request_hash, 'corrupt');
  const request = parseStored<StoreRequest>(content);
  requireStore(request.command.type === 'mutate', 'invalid-context');
  const recovery = await store.execute({
    context: request.context,
    command: { type: 'operation', operation_id: request.command.mutation.operation_id },
  });
  if (!recovery.ok) return recovery;
  const result = recovery.value as OperationResult;
  if (result.status === 'unknown')
    return {
      ok: false,
      error: {
        code: 'unknown-outcome',
        operation_id: request.command.mutation.operation_id,
        observed_revision: null,
        retryable: false,
        recovery_locator: locator,
      },
    };
  // Even confirmed replay checks the original request hash; never invent a new operation ID/CAS.
  return store.execute(request);
}
