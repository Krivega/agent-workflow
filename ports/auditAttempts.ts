import type { AuditAttemptObservation } from '../core/progressAudit.js';
import type { AuditReservation } from '../core/supervision.js';

export interface AuditAttempts {
  confirmAuditParent(parent: string): Promise<void>;
  observeAuditAttempt(reservation: AuditReservation): Promise<AuditAttemptObservation>;
}
