import type {
  EvidenceContext,
  MaintenanceAction,
  StoreReply,
  StoreRequest,
} from '../core/evidence.js';

export interface EvidenceStore {
  execute(request: StoreRequest): Promise<StoreReply>;
}
export interface EvidenceMaintenance {
  administer(context: EvidenceContext, action: MaintenanceAction): Promise<StoreReply>;
}
