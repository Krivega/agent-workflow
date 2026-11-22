import { existsSync, renameSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type {
  EvidenceGrant,
  FinalizationManifest,
  TechnicalState,
  BackupReceipt,
} from '../../core/evidence.js';
import type {
  FinalizationSeed,
  FinalizationState,
  FinalizationEvent,
} from '../../core/finalization.js';
import type { FinalizationProofs } from '../../ports/finalization.js';
import type { InputRef } from '../../core/localRun.js';
import { object, requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import { FileWorkflowInputs } from '../project/workflowInputs.js';
import { exportStore, readBackupManifest, restoreStore } from './storeBackup.js';
import { SqliteEvidenceStore, unwrap } from './sqliteEvidenceStore.js';
import { canonical, digest, requestHash } from './storeCodec.js';
import { readPrivateFile, safeDirectory, writePrivateFile, syncDirectory } from './storeFiles.js';
import { decodeChatArtifact } from './sharedArtifacts.js';

export interface ArchiveLocations {
  source: string;
  archive: string;
  restored: string;
  receipts: string;
}
export class FinalizationArchive implements FinalizationProofs {
  private readonly inputs: FileWorkflowInputs;
  constructor(
    private readonly projectRoot: string,
    evidenceRoot: string,
    private readonly paths: ArchiveLocations,
    private readonly grant: EvidenceGrant,
    private readonly now: () => number,
  ) {
    this.inputs = new FileWorkflowInputs(projectRoot, evidenceRoot);
    const roots = [
      paths.source,
      paths.archive,
      paths.restored,
      paths.receipts,
      paths.source + '.cleanup',
    ];
    requireWorkflow(
      roots.every(
        (a) =>
          resolve(a) === a &&
          roots.every((b) => a === b || (!a.startsWith(b + '/') && !b.startsWith(a + '/'))),
      ) && new Set(roots).size === 5,
      'archive-roots-must-be-disjoint',
    );
    roots.forEach((p) => safeDirectory(dirname(p)));
    safeDirectory(paths.receipts);
  }
  async verify(refs: InputRef[]) {
    await this.inputs.verify(refs);
  }
  private async read(ref: InputRef) {
    await this.verify([ref]);
    return object(
      decodeChatArtifact(
        dirname(resolve(this.projectRoot, ref.locator)),
        readPrivateFile(resolve(this.projectRoot, ref.locator)).toString('utf8'),
      ),
    );
  }
  private source(root = this.paths.source) {
    return new SqliteEvidenceStore(root, this.grant, this.now);
  }
  private state(root = this.paths.source) {
    return unwrap<TechnicalState>(
      this.source(root).execute({ context: this.grant.context, command: { type: 'state' } }),
    );
  }
  private catalog(root: string, revision: number) {
    return unwrap<FinalizationManifest>(
      this.source(root).execute({
        context: this.grant.context,
        command: { type: 'finalization', expected_revision: revision },
      }),
    );
  }
  private async receipt(name: string, value: unknown) {
    const path = resolve(this.paths.receipts, name + '.json'),
      bytes = canonical(value);
    if (existsSync(path))
      requireWorkflow(readPrivateFile(path).toString('utf8') === bytes, 'archive-receipt-conflict');
    else writePrivateFile(path, bytes);
    return this.inputs.ref(path);
  }
  async prepare(seed: FinalizationSeed) {
    requireWorkflow(this.grant.permissions.includes('manage'), 'archive-authority-required');
    const state = this.state(),
      checkpoint = object(state.checkpoint),
      execution = object(object(checkpoint.workflow).execution);
    requireWorkflow(
      [2, 3].includes(execution.schema_version as number) &&
        execution.status === 'done' &&
        execution.result !== null &&
        seed.run.spec.project_id === this.grant.context.project_id &&
        'task_id' in seed.run.spec.identity &&
        seed.run.spec.identity.task_id === this.grant.context.task_id,
      'finalization-needs-done',
    );
    const done = await this.read(seed.done),
      stopped = await this.read(seed.stopped);
    requireWorkflow(
      done.kind === 'done' && sameValue(done.result, execution.result),
      'done-proof-mismatch',
    );
    requireWorkflow(
      stopped.kind === 'producers-stopped' &&
        stopped.complete === true &&
        stopped.project_id === this.grant.context.project_id &&
        stopped.task_id === this.grant.context.task_id &&
        stopped.remaining === 0,
      'producers-not-stopped',
    );
    if (seed.policy.mode === 'test-cleanup') await this.cleanupAuthority(seed);
  }
  async freeze(seed: FinalizationSeed) {
    const before = this.state();
    await this.prepare(seed);
    const state = this.state();
    requireWorkflow(sameValue(before, state), 'finalization-source-changed');
    if (!state.frozen) {
      const request = {
        context: this.grant.context,
        command: {
          type: 'mutate' as const,
          mutation: {
            operation_id: `${seed.id}:freeze`,
            expected_revision: state.revision,
            owner_generation: state.generation,
            payload_hash: '',
          },
          change: { type: 'freeze' as const },
        },
      };
      request.command.mutation.payload_hash = requestHash(request);
      unwrap(this.source().execute(request));
    }
    return this.catalog(this.paths.source, this.state().revision);
  }
  private verifyCopy(root: string, manifest: FinalizationManifest, receiptName: string) {
    const receipt = JSON.parse(
      readPrivateFile(resolve(root, receiptName)).toString('utf8'),
    ) as BackupReceipt;
    const actual = readBackupManifest(root, manifest.state.revision, this.grant);
    requireWorkflow(
      sameValue(actual, manifest) &&
        receipt.manifest_hash === digest(canonical(manifest)) &&
        receipt.database_hash === digest(readPrivateFile(resolve(root, 'store.sqlite'))) &&
        receipt.revision === manifest.state.revision &&
        receipt.project_id === manifest.context.project_id &&
        receipt.task_id === manifest.context.task_id &&
        sameValue(receipt.blobs, manifest.blobs),
      'archive-copy-mismatch',
    );
    return receipt;
  }
  async export(manifest: FinalizationManifest) {
    this.reconcileSource(manifest);
    if (!existsSync(this.paths.archive))
      await exportStore(this.paths.source, this.paths.archive, this.grant);
    const receipt = this.verifyCopy(this.paths.archive, manifest, 'receipt.json');
    return {
      receipt,
      proof: await this.receipt('export', { kind: 'export', receipt, root: this.paths.archive }),
    };
  }
  async restore(manifest: FinalizationManifest) {
    this.verifyCopy(this.paths.archive, manifest, 'receipt.json');
    if (!existsSync(this.paths.restored))
      restoreStore(this.paths.archive, this.paths.restored, this.grant);
    const receipt = this.verifyCopy(this.paths.restored, manifest, 'restore-receipt.json');
    return {
      receipt,
      proof: await this.receipt('restore', { kind: 'restore', receipt, root: this.paths.restored }),
    };
  }
  private reconcileSource(manifest: FinalizationManifest, root = this.paths.source) {
    requireWorkflow(
      sameValue(this.catalog(root, this.state(root).revision), manifest),
      'finalization-catalog-changed',
    );
  }
  private reconcileCopies(manifest: FinalizationManifest) {
    this.verifyCopy(this.paths.archive, manifest, 'receipt.json');
    this.verifyCopy(this.paths.restored, manifest, 'restore-receipt.json');
  }
  async archive(seed: FinalizationSeed, state: FinalizationState, authority: InputRef) {
    requireWorkflow(state.phase === 'restored', 'restore-before-archive');
    await this.verify([authority]);
    this.reconcileSource(state.manifest!);
    this.reconcileCopies(state.manifest!);
    const existing = resolve(this.paths.receipts, 'archive.json');
    const at = existsSync(existing)
        ? (object(JSON.parse(readPrivateFile(existing).toString('utf8')) as unknown).at as number)
        : this.now(),
      proof = await this.receipt('archive', {
        kind: 'archive',
        id: seed.id,
        at,
        authority,
        manifest: state.exported!.manifest_hash,
        revision: state.manifest!.state.revision,
      });
    return { at, proof };
  }
  private async cleanupAuthority(seed: FinalizationSeed) {
    requireWorkflow(seed.policy.mode === 'test-cleanup', 'retention-forbids-cleanup');
    const policy = seed.policy;
    const authority = await this.read(policy.authority);
    requireWorkflow(
      authority.kind === 'test-cleanup-authority' &&
        authority.disposable === true &&
        authority.source === this.paths.source &&
        authority.operator === policy.operator &&
        authority.policy_version === policy.version &&
        authority.grace_ms === policy.grace_ms,
      'cleanup-test-authority-required',
    );
    return policy;
  }
  async cleanup(seed: FinalizationSeed, state: FinalizationState) {
    requireWorkflow(state.phase === 'cleanup-reserved', 'cleanup-reservation-required');
    const policy = await this.cleanupAuthority(seed);
    requireWorkflow(this.now() >= state.archive!.at + policy.grace_ms, 'cleanup-grace-pending');
    const archived = await this.read(state.archive!.proof);
    requireWorkflow(
      archived.kind === 'archive' &&
        archived.id === seed.id &&
        archived.manifest === state.exported!.manifest_hash &&
        archived.at === state.archive!.at,
      'archive-confirmation-mismatch',
    );
    this.reconcileCopies(state.manifest!);
    const quarantine = this.paths.source + '.cleanup';
    requireWorkflow(
      existsSync(resolve(this.paths.receipts, 'cleanup-intent.json')) ||
        existsSync(this.paths.source),
      'cleanup-origin-unknown',
    );
    const intent = await this.receipt('cleanup-intent', {
      id: seed.id,
      source: this.paths.source,
      quarantine,
      manifest: state.exported!.manifest_hash,
      archive: state.archive!.proof,
    });
    if (existsSync(this.paths.source)) {
      requireWorkflow(!existsSync(quarantine), 'cleanup-location-conflict');
      this.reconcileSource(state.manifest!);
      renameSync(this.paths.source, quarantine);
      syncDirectory(dirname(this.paths.source));
    }
    if (existsSync(quarantine)) {
      this.reconcileSource(state.manifest!, quarantine);
      rmSync(quarantine, { recursive: true });
      syncDirectory(dirname(quarantine));
    }
    return this.receipt('cleaned', {
      kind: 'cleaned',
      id: seed.id,
      intent,
      archive: state.archive!.proof,
      manifest: state.exported!.manifest_hash,
    });
  }
  async confirm(seed: FinalizationSeed, state: FinalizationState, event: FinalizationEvent) {
    if (event.type === 'CANCEL') return;
    if (event.type === 'CATALOG') {
      await this.prepare(seed);
      this.reconcileSource(event.manifest);
      return;
    }
    if (event.type === 'RESERVE_CLEANUP') {
      await this.cleanupAuthority(seed);
      requireWorkflow(event.now <= this.now(), 'cleanup-clock-unconfirmed');
      this.reconcileSource(state.manifest!);
      this.reconcileCopies(state.manifest!);
      return;
    }
    const value = await this.read(event.proof);
    if (event.type === 'EXPORT' || event.type === 'RESTORE') {
      const exporting = event.type === 'EXPORT',
        root = exporting ? this.paths.archive : this.paths.restored;
      requireWorkflow(
        value.kind === (exporting ? 'export' : 'restore') &&
          value.root === root &&
          sameValue(value.receipt, event.receipt),
        'archive-proof-mismatch',
      );
      requireWorkflow(
        sameValue(
          this.verifyCopy(
            root,
            state.manifest!,
            exporting ? 'receipt.json' : 'restore-receipt.json',
          ),
          event.receipt,
        ),
        'archive-receipt-mismatch',
      );
    } else if (event.type === 'ARCHIVE') {
      this.reconcileSource(state.manifest!);
      this.reconcileCopies(state.manifest!);
      requireWorkflow(
        value.kind === 'archive' &&
          value.id === seed.id &&
          value.at === event.at &&
          value.at <= this.now() &&
          sameValue(value.authority, event.authority) &&
          value.manifest === state.exported!.manifest_hash &&
          value.revision === state.manifest!.state.revision,
        'archive-confirmation-mismatch',
      );
    } else {
      requireWorkflow(
        value.kind === 'cleaned' &&
          value.id === seed.id &&
          value.manifest === state.exported!.manifest_hash &&
          sameValue(value.archive, state.archive!.proof) &&
          !existsSync(this.paths.source) &&
          !existsSync(this.paths.source + '.cleanup'),
        'cleanup-unconfirmed',
      );
      this.reconcileCopies(state.manifest!);
    }
  }
}
