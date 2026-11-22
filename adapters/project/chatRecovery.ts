import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { requireWorkflow, object, textField } from '../../core/connection.js';
import { requireSettledReadings } from '../../core/dataRoute.js';
import type { InputRef } from '../../core/localRun.js';
import type { ChatRecovery } from '../../ports/chatRecovery.js';
import type { ChatContextJournal } from '../../ports/chatContext.js';
import type { WriterProcesses, ProcessIdentity } from '../../ports/writerProcesses.js';
import { FileWorkflowInputs } from './workflowInputs.js';
import { verifyChatCheck } from './chatChecks.js';
import type { ChatCheckProof } from './chatChecks.js';
import { projectPath } from './projectFiles.js';
import { readPrivateFile, safeDirectory } from '../storage/storeFiles.js';
import { readArtifactFile } from '../storage/sharedArtifacts.js';

export class FileChatRecovery implements ChatRecovery {
  private readonly inputs: FileWorkflowInputs;
  constructor(
    private readonly root: string,
    private readonly evidence: string,
    private readonly journal: ChatContextJournal,
    private readonly processes: Pick<WriterProcesses, 'alive'>,
  ) {
    this.inputs = new FileWorkflowInputs(root, evidence);
  }
  async settled() {
    safeDirectory(this.evidence);
    const files = await readdir(this.evidence);
    try {
      for (const name of files) {
        if (!name.endsWith('.intent.json') && !name.endsWith('.check.lock')) continue;
        const operation = name.endsWith('.check.lock')
          ? textField(
              object(
                JSON.parse(
                  readPrivateFile(resolve(this.evidence, name)).toString('utf8'),
                ) as unknown,
              ).operation,
            )
          : name.slice(0, -'.intent.json'.length);
        requireWorkflow(/^[a-zA-Z0-9_-]+$/u.test(operation), 'chat-operation-unknown');
        const proof = readArtifactFile(
          resolve(this.evidence, operation + '.json'),
        ) as ChatCheckProof;
        requireWorkflow(proof.operation_id === operation, 'chat-operation-unknown');
        await verifyChatCheck(this.root, this.evidence, proof.check);
      }
    } catch {
      throw new Error('chat-operation-unknown');
    }
    const state = await this.journal.read();
    requireSettledReadings(state.workflow.readings);
  }
  async stopped(source: InputRef, thread: string, turn: string) {
    requireWorkflow(isAbsolute(source.locator), 'chat-stop-locator-not-absolute');
    await this.inputs.verify([source]);
    const proof = object(JSON.parse(readPrivateFile(source.locator).toString('utf8')) as unknown);
    const owned = object(proof.owned);
    requireWorkflow(
      proof.kind === 'writers-stopped' &&
        proof.thread === thread &&
        proof.active_turn === false &&
        proof.remaining_terminals === 0 &&
        proof.remaining_processes === 0 &&
        proof.before_hash === proof.after_hash &&
        typeof proof.before_hash === 'string' &&
        typeof proof.observation_ms === 'number' &&
        proof.observation_ms > 0 &&
        owned.thread === thread &&
        owned.turn === turn &&
        owned.complete === true &&
        Array.isArray(owned.markers) &&
        owned.markers.length > 0 &&
        Array.isArray(proof.processes),
      'chat-writers-stop-unconfirmed',
    );
    const processes = proof.processes as ProcessIdentity[];
    requireWorkflow(
      processes.every(
        (p) => Number.isSafeInteger(p.pid) && p.pid > 1 && typeof p.started === 'string',
      ),
      'chat-writer-identity-invalid',
    );
    requireWorkflow(
      (await this.processes.alive(processes)).length === 0,
      'chat-writers-still-active',
    );
    const hash = createHash('sha256');
    for (const marker of owned.markers) {
      const path = textField(marker);
      requireWorkflow(isAbsolute(path) && resolve(path) === path, 'chat-writer-marker-invalid');
      hash.update(path);
      hash.update(readPrivateFile(await projectPath(this.root, relative(this.root, path))));
    }
    requireWorkflow(hash.digest('hex') === proof.after_hash, 'chat-late-writer-detected');
  }
}
