import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { EvidenceStore } from '../../ports/evidenceStore.js';
import type { EvidenceContext, OperationResult, TechnicalState } from '../../core/evidence.js';
import type { RelaySeed } from '../../core/relay.js';
import { adoptedCheckpoint } from '../../core/relayCheckpoint.js';
import type { LocalRun, InputRef } from '../../core/localRun.js';
import { requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import { requestHash } from './storeCodec.js';
import { readPrivateFile } from './storeFiles.js';

export class TaskRelayOwnership {
  constructor(
    private readonly store: EvidenceStore,
    private readonly context: EvidenceContext,
  ) {}
  private async state() {
    const reply = await this.store.execute({ context: this.context, command: { type: 'state' } });
    requireWorkflow(reply.ok, 'relay-source-unavailable');
    return reply.value as TechnicalState;
  }
  async release(seed: RelaySeed, stopped: InputRef, receiptPath: string) {
    const state = await this.state();
    requireWorkflow(
      this.context.run_id === seed.predecessor.spec.run_id &&
        state.generation === seed.predecessor.generation &&
        sameValue(state.checkpoint, seed.checkpoint),
      'relay-source-changed',
    );
    const operation = `${seed.id}:release`;
    let revision = state.revision;
    if (state.released) {
      const reply = await this.store.execute({
        context: this.context,
        command: { type: 'operation', operation_id: operation },
      });
      requireWorkflow(reply.ok, 'relay-release-unknown');
      const recovered = reply.value as OperationResult;
      requireWorkflow(recovered.status === 'confirmed', 'relay-source-changed');
      requireWorkflow(
        recovered.ack.operation_id === operation &&
          recovered.ack.generation === state.generation &&
          recovered.ack.catalog_revision === state.revision,
        'relay-source-changed',
      );
      // Replay the original request so the Store checks its exact context and payload hash.
      revision = recovered.ack.catalog_revision - 1;
    }
    const request = {
      context: this.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: operation,
          expected_revision: revision,
          owner_generation: state.generation,
          payload_hash: '',
        },
        change: {
          type: 'release' as const,
          stopped_writers_receipt: stopped.locator,
          checkpoint: seed.checkpoint,
        },
      },
    };
    request.command.mutation.payload_hash = requestHash(request);
    requireWorkflow((await this.store.execute(request)).ok, 'relay-release-unknown');
    const after = await this.state();
    requireWorkflow(
      after.released &&
        after.generation === state.generation &&
        sameValue(after.checkpoint, seed.checkpoint),
      'relay-release-unconfirmed',
    );
    const proof = {
      kind: 'release',
      predecessor: seed.predecessor.spec.run_id,
      generation: state.generation,
      released: true,
      snapshot: seed.snapshot,
      stopped,
      store: after,
    };
    const text = JSON.stringify(proof, null, 2) + '\n';
    try {
      await writeFile(receiptPath, text, { flag: 'wx' });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      requireWorkflow(
        readPrivateFile(receiptPath).toString('utf8') === text,
        'relay-release-receipt-conflict',
      );
    }
    return { locator: receiptPath, hash: createHash('sha256').update(text).digest('hex') };
  }
  async claim(seed: RelaySeed, leaseUntil: number) {
    const state = await this.state();
    requireWorkflow(
      this.context.run_id === `${seed.id}:successor` &&
        state.released &&
        state.generation === seed.predecessor.generation &&
        sameValue(state.checkpoint, seed.checkpoint),
      'relay-claim-forbidden',
    );
    const request = {
      context: this.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: `${seed.id}:claim`,
          expected_revision: state.revision,
          owner_generation: state.generation,
          payload_hash: '',
        },
        change: { type: 'claim' as const, lease_until: leaseUntil },
      },
    };
    request.command.mutation.payload_hash = requestHash(request);
    requireWorkflow((await this.store.execute(request)).ok, 'relay-claim-unknown');
    const after = await this.state();
    requireWorkflow(
      !after.released &&
        after.generation === seed.predecessor.generation + 1 &&
        after.owner === this.context.actor_id,
      'relay-claim-unconfirmed',
    );
    return after;
  }
  async adopt(seed: RelaySeed, run: LocalRun) {
    const state = await this.state();
    requireWorkflow(
      this.context.run_id === run.spec.run_id &&
        !state.released &&
        state.generation === run.generation &&
        state.owner === this.context.actor_id &&
        sameValue(state.checkpoint, seed.checkpoint),
      'relay-adoption-ownership-mismatch',
    );
    const checkpoint = adoptedCheckpoint(seed, run);
    const request = {
      context: this.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: `${seed.id}:adopt`,
          expected_revision: state.revision,
          owner_generation: state.generation,
          payload_hash: '',
        },
        change: { type: 'checkpoint' as const, state: checkpoint, effects: [] },
      },
    };
    request.command.mutation.payload_hash = requestHash(request);
    requireWorkflow((await this.store.execute(request)).ok, 'relay-adoption-unknown');
    const after = await this.state();
    requireWorkflow(sameValue(after.checkpoint, checkpoint), 'relay-adoption-unconfirmed');
    return after;
  }
}
