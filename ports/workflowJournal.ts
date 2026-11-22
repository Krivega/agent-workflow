import type { DataReading } from '../core/dataRoute.js';
import type { Execution } from '../core/execution.js';
import type { InputManifest } from '../core/evidence.js';
import type { InputRef, LocalRun } from '../core/localRun.js';
import type { CoderRun } from '../core/coder.js';

export interface WorkflowCheckpoint {
  schema_version: 1 | 2;
  format_backup?: InputRef;
  coders?: Record<string, CoderRun>;
  revision: number;
  supervision_backup?: InputRef;
  execution: Execution | null;
  readings: Record<string, DataReading>;
}
export interface WorkflowJournal {
  fingerprint?: (value: unknown) => string;
  ensureReady(run: Execution): Promise<void>;
  checkHumanCompletion?(run: Execution): Promise<void>;
  read(options?: { archive: boolean }): Promise<WorkflowCheckpoint>;
  readEvent?(hash: string): Promise<string>;
  save(expected: WorkflowCheckpoint, next: WorkflowCheckpoint, operation: string): Promise<void>;
}
export interface WorkflowInputs {
  verify(refs: InputRef[], projection?: LocalRun['projection']): Promise<void>;
  current(manifest: InputManifest, projection?: LocalRun['projection']): Promise<InputManifest>;
}
