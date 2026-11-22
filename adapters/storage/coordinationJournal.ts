import type { EvidenceStore } from '../../ports/evidenceStore.js';
import type { CoordinationJournal } from '../../ports/coordinationJournal.js';
import type { EvidenceContext, Json, TechnicalState } from '../../core/evidence.js';
import { object, requireWorkflow } from '../../core/connection.js';
import { replayCoordination, coordinationSeed } from '../../core/coordination.js';
import type { CoordinationLog } from '../../core/coordination.js';
import { sameValue } from '../../core/equality.js';
import { assertRunAction } from '../../core/localRun.js';
import type { LocalRun } from '../../core/localRun.js';
import { requestHash } from './storeCodec.js';

export class TaskCoordinationJournal implements CoordinationJournal {
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
    requireWorkflow(reply.ok, 'coordination-store-unavailable');
    return reply.value as TechnicalState;
  }
  private decode(state: TechnicalState): CoordinationLog | null {
    const value = state.checkpoint === null ? undefined : object(state.checkpoint).coordination;
    if (value === undefined) return null;
    const log = value as unknown as CoordinationLog;
    replayCoordination(log);
    return log;
  }
  async read() {
    return this.decode(await this.state());
  }
  async save(expected: CoordinationLog | null, next: CoordinationLog) {
    replayCoordination(next);
    requireWorkflow(
      expected === null
        ? next.events.length === 0
        : sameValue({ ...expected, events: [] }, { ...next, events: [] }) &&
            sameValue(expected.events, next.events.slice(0, -1)),
      'coordination-log-not-append-only',
    );
    const state = await this.state();
    const local = object(object(state.checkpoint).local_run) as unknown as LocalRun;
    assertRunAction(local, 'coordinate');
    requireWorkflow(
      local.spec.run_id === this.context.run_id &&
        local.generation === this.generation &&
        local.spec.project_id === this.context.project_id &&
        'task_id' in local.spec.identity &&
        local.spec.identity.task_id === this.context.task_id &&
        sameValue(local, coordinationSeed(next).run),
      'wrong-local-coordinator',
    );
    const current = this.decode(state);
    if (sameValue(current, next)) return;
    requireWorkflow(sameValue(current, expected), 'coordination-revision-conflict');
    const request = {
      context: this.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: `coordination:${this.generation}:${this.context.run_id}:${next.events.length}`,
          expected_revision: state.revision,
          owner_generation: this.generation,
          payload_hash: '',
        },
        change: {
          type: 'checkpoint' as const,
          state: { ...object(state.checkpoint), coordination: next } as unknown as Json,
          effects: [],
        },
      },
    };
    request.command.mutation.payload_hash = requestHash(request);
    const reply = await this.store.execute(request);
    requireWorkflow(reply.ok, 'coordination-store-write-rejected');
  }
}
