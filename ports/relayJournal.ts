import type { RelayLog, RelayEvent, RelaySeed, RelayState } from '../core/relay.js';
import type { InputRef } from '../core/localRun.js';
export interface RelayJournal {
  read(): Promise<RelayLog | null>;
  save(expected: RelayLog | null, next: RelayLog): Promise<void>;
}
export interface RelayProofs {
  verify(refs: InputRef[]): Promise<void>;
  prepare(seed: RelaySeed): Promise<void>;
  confirm(seed: RelaySeed, state: RelayState, event: RelayEvent): Promise<void>;
}
