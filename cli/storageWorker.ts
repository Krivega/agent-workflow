import { readFileSync } from 'node:fs';
import type { EvidenceGrant, MaintenanceAction, StoreRequest } from '../core/evidence.js';
import { SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { maintainStore } from '../adapters/storage/storageMaintenance.js';
import { refuseUnroutedBackendConsumer } from '../src/adapters/project/taskBackend.js';

refuseUnroutedBackendConsumer(process.cwd());

const input = JSON.parse(readFileSync(0, 'utf8')) as {
  root: string;
  grant: EvidenceGrant;
  request: StoreRequest;
  maintenance: MaintenanceAction | null;
};
const store = new SqliteEvidenceStore(input.root, input.grant, Date.now);
const reply = input.maintenance
  ? await maintainStore(input.root, input.grant, input.request, input.maintenance)
  : store.execute(input.request);
process.stdout.write(JSON.stringify(reply));
