import { backup } from 'node:sqlite';
import { chmodSync, lstatSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  evidenceSchema,
  requireStore,
  type EvidenceGrant,
  type FinalizationManifest,
  type BackupReceipt,
} from '../../core/evidence.js';
import { EvidenceRecords } from './evidenceRecords.js';
import { canonical, digest } from './storeCodec.js';
import { StoreDatabase, storageSchema } from './storeDatabase.js';
import { authorize } from './sqliteEvidenceStore.js';
import {
  createPrivateDirectory,
  noStorageProbe,
  parseStored,
  readPrivateFile,
  safeDirectory,
  syncDirectory,
  writePrivateFile,
} from './storeFiles.js';

function snapshot(
  db: StoreDatabase,
  grant: EvidenceGrant,
  revision?: number,
): FinalizationManifest {
  db.check();
  return db.transaction(false, () =>
    new EvidenceRecords(db).finalization(revision ?? db.state('current').revision, grant.context),
  );
}

export function readBackupManifest(
  root: string,
  revision: number,
  grant: EvidenceGrant,
): FinalizationManifest {
  authorize(
    { context: grant.context, command: { type: 'finalization', expected_revision: revision } },
    grant,
  );
  const db = new StoreDatabase(root, grant.context, noStorageProbe, 'backup');
  try {
    return snapshot(db, grant, revision);
  } finally {
    db.close();
  }
}

export async function exportStore(
  root: string,
  destination: string,
  grant: EvidenceGrant,
): Promise<BackupReceipt> {
  requireStore(grant.context.schema_version === evidenceSchema, 'unsupported-version');
  requireStore(grant.permissions.includes('manage'), 'permission-denied');
  requireStore(destination !== root && !destination.startsWith(`${root}/`), 'permission-denied');
  // Opening the live Store can recover its journal, so claim the destination first.
  createPrivateDirectory(destination);
  const reserved = lstatSync(destination);
  let db: StoreDatabase | undefined;
  let manifest: FinalizationManifest;
  try {
    db = new StoreDatabase(root, grant.context, noStorageProbe);
    manifest = snapshot(db, grant);
  } catch (error) {
    db?.close();
    const current = lstatSync(destination, { throwIfNoEntry: false });
    if (current?.ino === reserved.ino && current.dev === reserved.dev) {
      rmdirSync(destination);
      syncDirectory(dirname(destination));
    }
    throw error;
  }
  try {
    createPrivateDirectory(join(destination, 'blobs'));
    await backup(db.db, join(destination, 'store.sqlite'));
    chmodSync(join(destination, 'store.sqlite'), 0o600);
    syncDirectory(join(destination, 'store.sqlite'));
    writePrivateFile(
      join(destination, 'identity.json'),
      readPrivateFile(join(root, 'identity.json')),
    );
    for (const hash of manifest.blobs)
      writePrivateFile(join(destination, 'blobs', hash), db.files.readBlob(hash));
    const after = snapshot(db, grant);
    requireStore(canonical(after) === canonical(manifest), 'revision-conflict');
    const copied = new StoreDatabase(destination, grant.context, noStorageProbe);
    try {
      requireStore(canonical(snapshot(copied, grant)) === canonical(manifest), 'corrupt');
    } finally {
      copied.close();
    }
    const receipt: BackupReceipt = {
      schema: db.schema,
      revision: manifest.state.revision,
      manifest_hash: digest(canonical(manifest)),
      database_hash: digest(readPrivateFile(join(destination, 'store.sqlite'))),
      blobs: manifest.blobs,
      project_id: grant.context.project_id,
      task_id: grant.context.task_id,
    };
    writePrivateFile(join(destination, 'manifest.json'), canonical(manifest));
    writePrivateFile(join(destination, 'receipt.json'), canonical(receipt));
    syncDirectory(destination);
    return receipt;
  } finally {
    db.close();
  }
}

export function restoreStore(
  source: string,
  destination: string,
  grant: EvidenceGrant,
): BackupReceipt {
  requireStore(grant.context.schema_version === evidenceSchema, 'unsupported-version');
  requireStore(grant.permissions.includes('manage'), 'permission-denied');
  safeDirectory(source);
  const receipt = parseStored<BackupReceipt>(
    readPrivateFile(join(source, 'receipt.json')).toString('utf8'),
  );
  requireStore([1, storageSchema].includes(receipt.schema), 'unsupported-version');
  requireStore(
    receipt.project_id === grant.context.project_id && receipt.task_id === grant.context.task_id,
    'invalid-context',
  );
  requireStore(
    digest(readPrivateFile(join(source, 'manifest.json'))) === receipt.manifest_hash,
    'corrupt',
  );
  const database = readPrivateFile(join(source, 'store.sqlite'));
  requireStore(digest(database) === receipt.database_hash, 'corrupt');
  const origin = new StoreDatabase(source, grant.context, noStorageProbe, 'backup');
  try {
    const manifest = snapshot(origin, grant);
    requireStore(
      origin.schema === receipt.schema &&
        digest(canonical(manifest)) === receipt.manifest_hash &&
        manifest.state.revision === receipt.revision &&
        canonical(manifest.blobs) === canonical(receipt.blobs),
      'corrupt',
    );
    requireStore(
      destination !== source && !destination.startsWith(`${source}/`),
      'permission-denied',
    );
    createPrivateDirectory(destination);
    createPrivateDirectory(join(destination, 'blobs'));
    writePrivateFile(join(destination, 'store.sqlite'), database);
    writePrivateFile(
      join(destination, 'identity.json'),
      readPrivateFile(join(source, 'identity.json')),
    );
    for (const hash of receipt.blobs)
      writePrivateFile(join(destination, 'blobs', hash), origin.files.readBlob(hash));
    const restored = new StoreDatabase(destination, grant.context, noStorageProbe, 'backup');
    try {
      requireStore(
        digest(canonical(snapshot(restored, grant))) === receipt.manifest_hash,
        'corrupt',
      );
    } finally {
      restored.close();
    }
    writePrivateFile(join(destination, 'restore-receipt.json'), canonical(receipt));
    return receipt;
  } finally {
    origin.close();
  }
}
