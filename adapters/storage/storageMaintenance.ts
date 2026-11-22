import {
  requireStore,
  type EvidenceGrant,
  type MaintenanceAction,
  type StoreReply,
  type StoreRequest,
} from '../../core/evidence.js';
import { exportStore, restoreStore } from './storeBackup.js';
import { failure } from './storeCodec.js';
import { initializeStore } from './storeDatabase.js';
import { authorize } from './sqliteEvidenceStore.js';

export async function maintainStore(
  root: string,
  grant: EvidenceGrant,
  request: StoreRequest,
  action: MaintenanceAction,
): Promise<StoreReply> {
  try {
    authorize(request, grant);
    requireStore(grant.permissions.includes('manage'), 'permission-denied');
    requireStore(['initialize', 'backup', 'restore'].includes(action.type), 'invalid-context');
    switch (action.type) {
      case 'initialize':
        initializeStore(root, request.context);
        return { ok: true, value: { status: 'initialized' } };
      case 'backup':
        return { ok: true, value: await exportStore(root, action.destination, grant) };
      case 'restore':
        return { ok: true, value: restoreStore(action.source, root, grant) };
    }
  } catch (error) {
    return failure(error, request, root);
  }
}
