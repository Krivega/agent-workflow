import type { RelayJournal } from '../../ports/relayJournal.js';
import type { RelayLog } from '../../core/relay.js';
import { replayRelay } from '../../core/relay.js';
import type { EvidenceStore } from '../../ports/evidenceStore.js';
import type { EvidenceContext, Json, TechnicalState } from '../../core/evidence.js';
import { object, requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import { requestHash } from './storeCodec.js';

// This belongs to the external controller, never to the namespace being released.
export class ControllerRelayJournal implements RelayJournal {
  constructor(
    private readonly store: EvidenceStore,
    private readonly context: EvidenceContext,
    private readonly generation: number,
  ) {}
  private async state() {
    const reply = await this.store.execute({
      context: this.context,
      command: { type: 'state', archive: 'current' },
    });
    requireWorkflow(reply.ok, 'relay-store-unavailable');
    return reply.value as TechnicalState;
  }
  private decode(state: TechnicalState): RelayLog | null {
    const value = state.checkpoint === null ? undefined : object(state.checkpoint).relay;
    if (value === undefined) return null;
    const log = value as unknown as RelayLog;
    replayRelay(log);
    return log;
  }
  async read() {
    return this.decode(await this.state());
  }
  async save(expected: RelayLog | null, next: RelayLog) {
    replayRelay(next);
    requireWorkflow(
      this.context.run_id !== next.seed.predecessor.spec.run_id,
      'relay-needs-external-controller',
    );
    requireWorkflow(
      expected === null
        ? next.events.length === 0
        : sameValue(expected.seed, next.seed) &&
            sameValue(expected.events, next.events.slice(0, -1)),
      'relay-log-not-append-only',
    );
    const state = await this.state(),
      current = this.decode(state);
    if (sameValue(current, next)) return;
    requireWorkflow(sameValue(current, expected), 'relay-revision-conflict');
    const request = {
      context: this.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: `relay:${next.seed.id}:${next.events.length}`,
          expected_revision: state.revision,
          owner_generation: this.generation,
          payload_hash: '',
        },
        change: {
          type: 'checkpoint' as const,
          state: {
            ...(state.checkpoint === null ? {} : object(state.checkpoint)),
            relay: next,
          } as unknown as Json,
          effects: [],
        },
      },
    };
    request.command.mutation.payload_hash = requestHash(request);
    requireWorkflow((await this.store.execute(request)).ok, 'relay-store-write-rejected');
  }
}
