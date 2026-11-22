import type { StoreRequest } from '../core/evidence.js';

export interface FallbackReceipt {
  status: 'fallback';
  store_check: 'NOT RUN';
  locator: string;
  summary: string;
  request_hash: string;
}
export interface EvidenceFallback {
  save(request: StoreRequest, summary: string): Promise<FallbackReceipt>;
}
