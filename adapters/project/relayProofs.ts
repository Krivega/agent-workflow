import { readPrivateFile } from '../storage/storeFiles.js';
import { decodeChatArtifact } from '../storage/sharedArtifacts.js';
import { resolve, isAbsolute, dirname } from 'node:path';
import type { RelayProofs } from '../../ports/relayJournal.js';
import type { RelaySeed, RelayEvent, RelayState } from '../../core/relay.js';
import type { InputRef } from '../../core/localRun.js';
import { object, requireWorkflow } from '../../core/connection.js';
import { adoptedCheckpoint, readySuccessor } from '../../core/relayCheckpoint.js';
import { sameValue } from '../../core/equality.js';
import { FileWorkflowInputs } from './workflowInputs.js';
import { compactionEvent } from '../codex/compactionEvents.js';

export class FileRelayProofs implements RelayProofs {
  private readonly inputs: FileWorkflowInputs;
  constructor(
    private readonly root: string,
    evidenceRoot: string,
  ) {
    this.inputs = new FileWorkflowInputs(root, evidenceRoot);
  }
  async verify(refs: InputRef[]) {
    await this.inputs.verify(refs);
  }
  private async read(ref: InputRef) {
    await this.verify([ref]);
    const path = isAbsolute(ref.locator) ? ref.locator : resolve(this.root, ref.locator);
    return object(decodeChatArtifact(dirname(path), readPrivateFile(path).toString('utf8')));
  }
  async prepare(seed: RelaySeed) {
    const snapshot = await this.read(seed.snapshot);
    requireWorkflow(
      sameValue(snapshot.checkpoint, seed.checkpoint) &&
        sameValue(snapshot.progress, seed.progress),
      'relay-snapshot-content-mismatch',
    );
    const trigger = await this.read(seed.trigger.evidence);
    requireWorkflow(
      sameValue(
        compactionEvent(
          trigger.notification,
          seed.trigger.thread,
          seed.trigger.mode,
          seed.trigger.evidence,
        ),
        seed.trigger,
      ),
      'native-compaction-unconfirmed',
    );
    requireWorkflow(
      trigger.mode === seed.trigger.mode &&
        (seed.trigger.mode === 'manual'
          ? trigger.manual_request !== null
          : trigger.manual_request === null),
      'compaction-origin-unconfirmed',
    );
  }
  async confirm(seed: RelaySeed, state: RelayState, event: RelayEvent) {
    if (event.type === 'RESERVE') return;
    if (event.type === 'LOAD') {
      const proof = await this.read({
        locator: event.receipt.observed_read,
        hash: (await this.inputs.ref(event.receipt.observed_read)).hash,
      });
      requireWorkflow(
        proof.session === state.successor!.id &&
          Array.isArray(proof.refs) &&
          [...event.receipt.procedures, ...event.receipt.rules].every((ref) =>
            (proof.refs as InputRef[]).some(
              (actual) => actual.locator === ref.locator && actual.hash === ref.hash,
            ),
          ),
        'relay-load-observation-mismatch',
      );
      return;
    }
    const receipt = event.type === 'IDENTIFY' ? event.session.receipt : event.receipt;
    const proof = await this.read(receipt);
    if (event.type === 'STOP') {
      requireWorkflow(
        proof.kind === 'writers-stopped' &&
          proof.thread === seed.predecessor.spec.session_id &&
          proof.active_turn === false &&
          proof.remaining_terminals === 0 &&
          proof.remaining_processes === 0 &&
          proof.before_hash === proof.after_hash &&
          typeof proof.before_hash === 'string' &&
          typeof proof.observation_ms === 'number' &&
          proof.observation_ms > 0,
        'writers-stop-unconfirmed',
      );
    } else if (event.type === 'RELEASE') {
      requireWorkflow(
        proof.kind === 'release' &&
          proof.predecessor === seed.predecessor.spec.run_id &&
          proof.generation === event.generation &&
          proof.released === true &&
          sameValue(proof.snapshot, seed.snapshot) &&
          sameValue(proof.stopped, state.stopped),
        'native-release-unconfirmed',
      );
    } else if (event.type === 'IDENTIFY') {
      const raw = object(proof.session),
        thread = object(raw.thread),
        sandbox = object(raw.sandbox);
      requireWorkflow(
        thread.id === event.session.id &&
          thread.projectId === seed.native_project_id &&
          raw.cwd === seed.predecessor.spec.workspace &&
          thread.forkedFromId === null &&
          Array.isArray(thread.turns) &&
          thread.turns.length === 0 &&
          raw.model === event.session.model &&
          raw.reasoningEffort === event.session.effort &&
          (sandbox.type === 'readOnly') === event.session.read_only &&
          sandbox.networkAccess === false,
        'native-successor-unconfirmed',
      );
    } else if (event.type === 'ADOPT') {
      requireWorkflow(
        proof.kind === 'adoption' &&
          proof.session === state.successor!.id &&
          proof.generation === event.generation &&
          sameValue(proof.snapshot, seed.snapshot) &&
          sameValue(proof.release, state.release) &&
          sameValue(proof.checkpoint, seed.checkpoint) &&
          sameValue(proof.progress, seed.progress) &&
          sameValue(proof.working_checkpoint, adoptedCheckpoint(seed, readySuccessor(seed, state))),
        'native-adoption-unconfirmed',
      );
    } else if (event.type === 'CONTINUE') {
      requireWorkflow(
        proof.kind === 'continuation' &&
          proof.session === event.session &&
          proof.action === event.action &&
          sameValue(proof.adoption, state.adoption),
        'native-continuation-unconfirmed',
      );
      const observed = object(proof.observed) as unknown as InputRef;
      await this.verify([observed]);
    } else if (event.type === 'ASSIST') {
      requireWorkflow(
        proof.kind === 'dispatch' &&
          proof.coordinator === event.coordinator &&
          proof.project_id === seed.native_project_id &&
          proof.workspace === seed.predecessor.spec.workspace &&
          sameValue(proof.release, state.release) &&
          proof.attempts === 1,
        'coordinator-dispatch-unconfirmed',
      );
    } else requireWorkflow(proof.kind === event.kind, 'failure-kind-unconfirmed');
  }
}
