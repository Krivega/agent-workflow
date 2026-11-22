import type { ChatMessages } from '../core/chatMessages.js';
import type { ChatControl } from '../core/chatControl.js';
import type { LocalRun } from '../core/localRun.js';
import type { WorkflowCheckpoint } from './workflowJournal.js';
export interface ChatContext {
  messages: ChatMessages | null;
  run: LocalRun;
  workflow: WorkflowCheckpoint;
  coordination_bound: boolean;
  control: ChatControl | null;
}
export interface ChatContextJournal {
  fingerprint?: (value: unknown) => string;
  read(options?: { archive: boolean }): Promise<ChatContext>;
  save(expected: ChatContext, next: ChatContext, operation: string): Promise<void>;
}
