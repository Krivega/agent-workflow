import type { WorkflowInputs } from './workflowJournal.js';
import type { WorkScope } from '../core/coordination.js';
import type { CoordinationLog } from '../core/coordination.js';
export interface CoordinationJournal {
  read(): Promise<CoordinationLog | null>;
  save(expected: CoordinationLog | null, next: CoordinationLog): Promise<void>;
}

export interface CoordinationInputs {
  evidence: WorkflowInputs;
  workspace(scope: WorkScope): Promise<WorkflowInputs>;
}
