import { object, requireWorkflow, textField } from '../core/connection.js';
import { sameValue } from '../core/equality.js';
import type { ChatControl } from '../core/chatControl.js';
import type { ChatMessages } from '../core/chatMessages.js';
import type { InputRef } from '../core/localRun.js';
import type { EvidenceGrant, TechnicalState } from '../core/evidence.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import type { CouncilWaitGuard } from '../ports/councilWait.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { bindChatEvidence } from '../adapters/storage/chatWriter.js';
import { refreshChatLease } from './chatContinuation.js';

export function councilWaitGuard(
  request: Record<string, unknown>,
  host: CurrentChatHost,
): CouncilWaitGuard {
  const storage = object(request.storage);
  const store = new SqliteEvidenceStore(
    textField(storage.root),
    storage.grant as EvidenceGrant,
    Date.now,
  );
  const capture = async () => {
    const observed = await host.observe();
    await host.message(
      request.human_source as InputRef,
      (request.previous_source_turn as string | undefined) ?? observed.turn_id,
    );
    const state = unwrap<TechnicalState>(
      store.execute({
        context: store.grant.context,
        command: { type: 'state', archive: 'current' },
      }),
    );
    const checkpoint = object(state.checkpoint);
    const control = checkpoint.chat_control as ChatControl;
    const messages = checkpoint.chat_messages as ChatMessages;
    requireWorkflow(
      state.owner === observed.thread_id &&
        state.owner === store.grant.context.actor_id &&
        state.generation === request.generation &&
        !state.frozen &&
        !state.released &&
        state.lease_until > Date.now() &&
        control.status === 'active' &&
        sameValue(control.observed, observed) &&
        control.generation === state.generation &&
        messages.generation === state.generation,
      'council-wait-owner-or-control-changed',
    );
    bindChatEvidence(textField(storage.root), textField(request.evidence_root), state)();
    refreshChatLease(store);
    return {
      run_id: textField(store.grant.context.run_id),
      owner: state.owner,
      generation: state.generation,
      requirements_revision: messages.requirements_revision,
      control_revision: control.revision,
      turn_id: observed.turn_id,
      source: observed.source,
    };
  };
  return {
    capture,
    verify: async (binding) => {
      requireWorkflow(sameValue(await capture(), binding), 'council-wait-revision-changed');
    },
  };
}
