import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { LocalRuns } from '../../ports/localRuns.js';
import type { RelaySeed } from '../../core/relay.js';
import type { InputRef, LocalRun } from '../../core/localRun.js';
import { applyLocalEvent } from '../../core/localRun.js';
import { requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';

// Source and successor are separate cardless assignments. No task ID/Store is invented.
export class AssignmentRelayOwnership {
  constructor(
    private readonly source: LocalRuns,
    private readonly successor: LocalRuns,
  ) {}
  async release(seed: RelaySeed, stopped: InputRef, receiptPath: string) {
    const current = await this.source.read();
    requireWorkflow(
      current !== null &&
        'assignment_id' in current.spec.identity &&
        sameValue(current, seed.predecessor),
      'assignment-relay-source-changed',
    );
    const released = applyLocalEvent(current, {
      type: 'CANCEL',
      event_id: `${seed.id}:release`,
      expected_revision: current.revision,
      generation: current.generation,
      reason: 'relay',
      unfinished: current.spec.scope,
      stopped_receipt: stopped.locator,
    });
    await this.source.save(current, released);
    requireWorkflow(
      sameValue(await this.source.read(), released),
      'assignment-release-unconfirmed',
    );
    const text =
      JSON.stringify(
        {
          kind: 'release',
          predecessor: current.spec.run_id,
          generation: current.generation,
          released: true,
          snapshot: seed.snapshot,
          stopped,
          assignment: released,
        },
        null,
        2,
      ) + '\n';
    await writeFile(receiptPath, text, { flag: 'wx' });
    return { locator: receiptPath, hash: createHash('sha256').update(text).digest('hex') };
  }
  async claim(seed: RelaySeed, run: LocalRun) {
    const source = await this.source.read();
    requireWorkflow(
      source !== null &&
        source.status === 'cancelled' &&
        source.generation === run.generation &&
        source.spec.run_id === seed.predecessor.spec.run_id &&
        run.spec.run_id === `${seed.id}:successor` &&
        run.generation === seed.predecessor.generation + 1 &&
        'assignment_id' in run.spec.identity &&
        sameValue(run.spec.identity, source.spec.identity),
      'assignment-claim-forbidden',
    );
    requireWorkflow((await this.successor.read()) === null, 'assignment-successor-exists');
    await this.successor.save(null, run);
    requireWorkflow(sameValue(await this.successor.read(), run), 'assignment-claim-unconfirmed');
    return run;
  }
}
