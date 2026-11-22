import { object, requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import { validateChatMessages } from '../../core/chatMessages.js';
import type { ChatMessages } from '../../core/chatMessages.js';
import { validateChatControl } from '../../core/chatControl.js';
import type { ChatControl } from '../../core/chatControl.js';
import type { EvidenceContext, Json, TechnicalState } from '../../core/evidence.js';
import type { LocalRun } from '../../core/localRun.js';
import { localRunVersionSupported } from '../../core/localRun.js';
import type { EvidenceStore } from '../../ports/evidenceStore.js';
import type { ChatContextJournal, ChatContext } from '../../ports/chatContext.js';
import type { WorkflowCheckpoint } from '../../ports/workflowJournal.js';
import { validateCheckpoint } from './workflowValidation.js';
import { requestHash } from './storeCodec.js';
import { retainStoreState, retentionFingerprint } from './retainedJson.js';
import { decodeWorkflowHistory } from './workflowJournal.js';
import { compactArchive } from './archiveJson.js';

export class TaskChatContext implements ChatContextJournal {
  readonly fingerprint?: (value: unknown) => string;
  private readonly historyCache = new Map<string, string>();
  constructor(
    private readonly store: EvidenceStore,
    private readonly context: EvidenceContext,
    private readonly generation: number,
    private readonly retention = true,
  ) {
    if (retention) this.fingerprint = retentionFingerprint;
  }
  private async state(full = false) {
    const reply = await this.store.execute({
      context: this.context,
      command: { type: 'state', archive: full ? 'full' : 'current' },
    });
    requireWorkflow(reply.ok, 'chat-store-unavailable');
    return reply.value as TechnicalState;
  }
  private decode(state: TechnicalState): ChatContext {
    const checkpoint = object(state.checkpoint),
      run = object(checkpoint.local_run) as unknown as LocalRun;
    requireWorkflow(localRunVersionSupported(run), 'unsupported-run-version');
    const messages =
      checkpoint.chat_messages === undefined
        ? null
        : (object(checkpoint.chat_messages) as unknown as ChatMessages);
    if (messages !== null) validateChatMessages(messages);
    const workflow =
      checkpoint.workflow === undefined
        ? { schema_version: 1 as const, revision: 0, execution: null, readings: {} }
        : (checkpoint.workflow as unknown as WorkflowCheckpoint);
    validateCheckpoint(workflow);
    const control =
      checkpoint.chat_control === undefined
        ? null
        : (checkpoint.chat_control as unknown as ChatControl);
    if (control !== null) validateChatControl(control);
    return {
      run,
      messages,
      workflow: decodeWorkflowHistory(workflow, this.historyCache),
      coordination_bound: checkpoint.coordination !== undefined,
      control,
    };
  }
  async read(options?: { archive: boolean }) {
    return this.decode(await this.state(options?.archive));
  }
  private async prepareSave(expected: ChatContext, next: ChatContext, operation: string) {
    requireWorkflow(next.messages !== null, 'chat-messages-missing');
    validateChatMessages(next.messages);
    validateCheckpoint(next.workflow);
    if (next.control !== null) validateChatControl(next.control);
    const state = await this.state(),
      current = this.decode(state);
    requireWorkflow(
      current.run.spec.session_id === this.context.actor_id &&
        current.run.spec.run_id === this.context.run_id &&
        current.run.generation === this.generation &&
        next.messages.generation === this.generation &&
        next.messages.thread_id === this.context.actor_id &&
        next.messages.task_id === this.context.task_id,
      'chat-context-owner-mismatch',
    );
    if (sameValue(current, next)) return null;
    const packed = this.retention
      ? { value: await retainStoreState(next, this.store, this.context), blobs: [] }
      : compactArchive(next);
    if (sameValue(current, packed.value)) return null;
    requireWorkflow(
      sameValue(current, expected) ||
        sameValue(compactArchive(current).value, compactArchive(expected).value),
      'chat-context-conflict',
    );
    const compact = packed.value as unknown as ChatContext;
    const request = {
      context: this.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: operation,
          expected_revision: state.revision,
          owner_generation: this.generation,
          payload_hash: '',
        },
        change: {
          type: 'checkpoint' as const,
          state: {
            ...object(state.checkpoint),
            local_run: compact.run,
            workflow: compact.workflow,
            chat_messages: compact.messages,
            ...(compact.control === null ? {} : { chat_control: compact.control }),
          } as unknown as Json,
          effects: [],
          blobs: packed.blobs,
          ...(this.retention ? { retention_version: 1 as const } : { archive_version: 1 as const }),
        },
      },
    };
    request.command.mutation.payload_hash = requestHash(request);
    return request;
  }
  async save(expected: ChatContext, next: ChatContext, operation: string) {
    const request = await this.prepareSave(expected, next, operation);
    if (request === null) return;
    requireWorkflow((await this.store.execute(request)).ok, 'chat-context-write-rejected');
  }
}
