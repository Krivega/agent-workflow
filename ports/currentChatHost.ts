import type { ChatObservation } from '../core/currentChat.js';
import type { InputRef, LoadReceipt, LocalRun } from '../core/localRun.js';

export interface CurrentChatHost {
  reference(source: InputRef): Promise<void>;
  message(source: InputRef, previousTurn?: string): Promise<{ thread_id: string; turn_id: string }>;
  observe(): Promise<ChatObservation>;
  boundary(
    turn: string,
  ): Promise<{ kind: 'completed' | 'aborted' | 'compacted'; source: InputRef }>;
  continuation(turn: string): Promise<InputRef>;
  load(run: LocalRun, marker: string, reuse?: boolean): Promise<LoadReceipt>;
}
