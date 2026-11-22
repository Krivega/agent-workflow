import type { InputRef } from '../core/localRun.js';
export interface ChatRecovery {
  settled(): Promise<void>;
  stopped(source: InputRef, thread: string, turn: string): Promise<void>;
}
