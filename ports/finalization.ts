import type {
  FinalizationEvent,
  FinalizationLog,
  FinalizationSeed,
  FinalizationState,
} from '../core/finalization.js';
import type { InputRef } from '../core/localRun.js';
export interface FinalizationJournal {
  read(): Promise<FinalizationLog | null>;
  save(expected: FinalizationLog | null, next: FinalizationLog): Promise<void>;
}
export interface FinalizationProofs {
  verify(refs: InputRef[]): Promise<void>;
  prepare(seed: FinalizationSeed): Promise<void>;
  confirm(
    seed: FinalizationSeed,
    state: FinalizationState,
    event: FinalizationEvent,
  ): Promise<void>;
}
