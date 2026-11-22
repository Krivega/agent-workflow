import type { LocalRun } from '../core/localRun.js';
export interface LocalRuns {
  read(): Promise<LocalRun | null>;
  save(expected: LocalRun | null, next: LocalRun): Promise<void>;
}
export interface RunInputs {
  verify(run: LocalRun): Promise<void>;
}
