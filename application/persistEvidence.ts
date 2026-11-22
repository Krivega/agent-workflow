import type { StoreReply, StoreRequest } from '../core/evidence.js';
import type { EvidenceStore } from '../ports/evidenceStore.js';
import type { EvidenceFallback, FallbackReceipt } from '../ports/evidenceFallback.js';

export async function persistEvidence(
  store: EvidenceStore,
  fallback: EvidenceFallback,
  request: StoreRequest,
  summary: string,
): Promise<StoreReply | { ok: false; store: StoreReply; fallback: FallbackReceipt }> {
  const result = await store.execute(request);
  if (result.ok) return result;
  if (!['unavailable', 'unknown-outcome', 'corrupt'].includes(result.error.code)) return result;
  return { ok: false, store: result, fallback: await fallback.save(request, summary) };
}
