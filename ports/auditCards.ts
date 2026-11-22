import type { AuditCard } from '../core/supervision.js';
import type { InputRef } from '../core/localRun.js';

export interface AuditCards {
  read(ref: InputRef): Promise<AuditCard>;
}
