import { requireWorkflow, textField } from '../core/connection.js';
import type { ProcedureId } from '../core/connection.js';
import type { LocalRun } from '../core/localRun.js';
import type { EffectRecord, TechnicalState } from '../core/evidence.js';
import type { ChatContextJournal } from '../ports/chatContext.js';
import type { LoadedConnection } from '../ports/projectConnection.js';
import type { RunInputs } from '../ports/localRuns.js';
import type { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import type { SqliteEvidenceStore } from '../adapters/storage/sqliteEvidenceStore.js';
import { unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { buildCompactContext } from '../adapters/project/compactContext.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';

export function chatCompactContext(
  command: string,
  request: Record<string, unknown>,
  host: FileCurrentChatHost,
  store: SqliteEvidenceStore,
  chat: ChatContextJournal,
  loaded: LoadedConnection,
  inputs: RunInputs,
) {
  return async (run: LocalRun, marker: string) => {
    await inputs.verify(run);
    const state = () =>
      unwrap<TechnicalState>(
        store.execute({
          context: store.grant.context,
          command: { type: 'state', archive: 'current' },
        }),
      );
    const before = state();
    const context = await chat.read();
    const effects = unwrap<EffectRecord[]>(
      store.execute({ context: store.grant.context, command: { type: 'effects' } }),
    );
    requireWorkflow(state().revision === before.revision, 'compact-context-snapshot-changed');
    const boundary = await host.compaction();
    requireWorkflow(boundary !== undefined, 'chat-compact-boundary-required');
    const action = command === 'compact-context-chat' ? textField(request.compact_action) : command;
    const payload = { ...request };
    delete payload.compact_action;
    delete payload.load_action;
    delete payload.load_procedures;
    // Lease renewals are checked separately and do not create a new task action.
    delete payload.lease_until;
    const additional = request.load_procedures ?? [];
    requireWorkflow(Array.isArray(additional), 'invalid-compact-action-procedures');
    const procedures = [
      ...new Set([
        ...(additional.map(textField) as ProcedureId[]),
        ...(run.loaded?.procedures.map((procedure) => procedure.id) ?? []),
      ]),
    ];
    return buildCompactContext(
      run,
      marker,
      action,
      digest(canonical(payload)),
      boundary,
      context,
      before,
      effects,
      loaded,
      procedures,
      Date.now(),
    );
  };
}
