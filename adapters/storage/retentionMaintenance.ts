import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  requireStore,
  type EvidenceGrant,
  type EventRecord,
  type Json,
  type WriteAck,
} from '../../core/evidence.js';
import { StoreDatabase, revisionMatches } from './storeDatabase.js';
import { pruneRetainedBlobs, retainedBlobRoots } from './retainedBlobs.js';
import { canonical, canonicalHash, digest } from './storeCodec.js';
import { eventPayload, readArchive } from './archiveJson.js';
import { retainEvidence } from './retainedJson.js';
import { decodeChatArtifact } from './sharedArtifacts.js';
import { object } from '../../core/connection.js';
import type { InputRef } from '../../core/localRun.js';
import {
  createPrivateDirectory,
  noStorageProbe,
  readPrivateFile,
  safeDirectory,
  syncDirectory,
  writePrivateFile,
} from './storeFiles.js';

export interface RetentionRequest {
  operation_id: string;
  expected_revision: number;
  expected_generation: number;
  expected_owner: string | null;
  backup: string;
  planning?: { previous: InputRef; current: InputRef; original: InputRef };
}
interface BackupManifest {
  schema_version: 1;
  source: string;
  files: Record<string, { hash: string; bytes: number }>;
  planning?: RetentionRequest['planning'];
}
type Probe = (stage: 'backup-created' | 'before-commit' | 'after-commit' | 'blob-removed') => void;
const manifestName = '.retention-backup.json';

function inventory(root: string): BackupManifest['files'] {
  const files = Object.create(null) as BackupManifest['files'];
  const visit = (directory: string) => {
    safeDirectory(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        const content = readPrivateFile(path);
        files[path.slice(root.length + 1)] = { hash: digest(content), bytes: content.length };
      }
    }
  };
  visit(root);
  return files;
}

function verifyBackup(root: string, hash?: string): BackupManifest {
  safeDirectory(root);
  const bytes = readPrivateFile(join(root, manifestName));
  if (hash !== undefined) requireStore(digest(bytes) === hash, 'corrupt');
  const manifest = JSON.parse(bytes.toString('utf8')) as BackupManifest;
  requireStore(
    manifest.schema_version === 1 && typeof manifest.source === 'string' && !!manifest.files,
    'corrupt',
  );
  for (const [name, file] of Object.entries(manifest.files)) {
    const path = resolve(root, name);
    requireStore(path.startsWith(root + '/') && name !== manifestName, 'permission-denied');
    safeDirectory(resolve(path, '..'));
    const content = readPrivateFile(path);
    requireStore(content.length === file.bytes && digest(content) === file.hash, 'corrupt');
  }
  return manifest;
}

function copyFiles(source: string, destination: string, files: BackupManifest['files']) {
  createPrivateDirectory(destination);
  const directories = new Set<string>([destination]);
  for (const name of Object.keys(files).sort()) {
    const parts = name.split('/');
    let directory = destination;
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part);
      if (!directories.has(directory)) {
        createPrivateDirectory(directory);
        directories.add(directory);
      }
    }
    writePrivateFile(join(destination, name), readPrivateFile(join(source, name)));
  }
}

export function restoreRetentionBackup(source: string, destination: string, hash: string) {
  const manifest = verifyBackup(source, hash);
  copyFiles(source, destination, manifest.files);
  requireStore(canonicalHash(inventory(destination)) === canonicalHash(manifest.files), 'corrupt');
  return {
    files: Object.keys(manifest.files).length,
    bytes: Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0),
  };
}

export function retainStore(
  root: string,
  grant: EvidenceGrant,
  request: RetentionRequest,
  now: () => number = Date.now,
  probe: Probe = () => {},
) {
  requireStore(grant.permissions.includes('manage'), 'permission-denied');
  requireStore(
    typeof request.operation_id === 'string' &&
      request.operation_id.length > 0 &&
      Number.isSafeInteger(request.expected_revision) &&
      request.expected_revision >= 0 &&
      Number.isSafeInteger(request.expected_generation) &&
      request.expected_generation >= 0,
    'invalid-context',
  );
  requireStore(
    resolve(request.backup) === request.backup &&
      request.backup !== root &&
      !request.backup.startsWith(root + '/'),
    'permission-denied',
  );
  const operationHash = canonicalHash({ context: grant.context, ...request });
  const db = new StoreDatabase(root, grant.context, noStorageProbe);
  let backupHash = '';
  try {
    const ack = db.transaction(true, () => {
      const state = db.state('current');
      const previous = db.db
        .prepare('SELECT hash,ack FROM operations WHERE id=?')
        .get(request.operation_id);
      if (previous !== undefined) {
        requireStore(previous['hash'] === operationHash, 'revision-conflict');
        const ack = JSON.parse(previous['ack'] as string) as WriteAck;
        revisionMatches(state.revision, ack.catalog_revision);
        const event = db.decode<EventRecord>(
          db.db.prepare('SELECT body FROM events WHERE revision=?').get(ack.catalog_revision)![
            'body'
          ] as string,
          undefined,
          false,
        );
        backupHash = (event.change as Record<string, Json>).backup_hash as string;
        verifyBackup(request.backup, backupHash);
        return ack;
      }
      revisionMatches(state.revision, request.expected_revision);
      requireStore(
        state.owner === request.expected_owner &&
          state.generation === request.expected_generation &&
          !state.frozen &&
          (state.released || state.lease_until <= now()),
        'stale-owner',
      );
      if (request.planning !== undefined) {
        const { previous, current, original } = request.planning;
        const checkpoint = object(state.checkpoint),
          local = object(checkpoint.local_run),
          spec = object(local.spec),
          route = object(spec.route);
        requireStore(
          route.kind === 'substantial' &&
            canonicalHash(route.accepted_plan) === canonicalHash(previous) &&
            previous.locator === current.locator,
          'invalid-context',
        );
        const path = resolve(spec.workspace as string, current.locator);
        requireStore(
          isAbsolute(original.locator) && !original.locator.startsWith(root + '/'),
          'permission-denied',
        );
        const oldBytes = readPrivateFile(original.locator),
          newBytes = readPrivateFile(path);
        requireStore(
          original.hash === previous.hash &&
            digest(oldBytes) === previous.hash &&
            digest(newBytes) === current.hash,
          'corrupt',
        );
        const oldPlan = decodeChatArtifact(
          dirname(original.locator),
          oldBytes.toString('utf8'),
          false,
        );
        const newPlan = object(decodeChatArtifact(dirname(path), newBytes.toString('utf8'), false));
        const { retained_source, ...retained } = newPlan;
        requireStore(
          canonicalHash(retained_source) === canonicalHash(previous) &&
            canonicalHash(retainEvidence(oldPlan)) === canonicalHash(retainEvidence(retained)),
          'corrupt',
        );
        requireStore(
          typeof local.revision === 'number' &&
            Number.isSafeInteger(local.revision) &&
            local.revision >= 0,
          'corrupt',
        );
        route.accepted_plan = current;
        local.revision += 1;
      }
      const manifest: BackupManifest = {
        schema_version: 1,
        source: root,
        files: inventory(root),
        ...(request.planning === undefined ? {} : { planning: request.planning }),
      };
      requireStore(!Object.hasOwn(manifest.files, manifestName), 'invalid-context');
      if (!existsSync(request.backup)) {
        copyFiles(root, request.backup, manifest.files);
        writePrivateFile(join(request.backup, manifestName), canonical(manifest));
      }
      probe('backup-created');
      const copied = verifyBackup(request.backup);
      requireStore(
        copied.source === root &&
          canonicalHash(copied.planning ?? null) === canonicalHash(manifest.planning ?? null) &&
          Object.entries(copied.files).every(
            ([name, file]) => canonicalHash(file) === canonicalHash(manifest.files[name]),
          ) &&
          Object.keys(manifest.files).every(
            (name) => Object.hasOwn(copied.files, name) || /^blobs\/[a-f0-9]{64}$/u.test(name),
          ),
        'corrupt',
      );
      backupHash = digest(readPrivateFile(join(request.backup, manifestName)));
      state.checkpoint = retainEvidence(state.checkpoint, (hash) =>
        eventPayload(readArchive(hash, (child) => db.files.readBlob(child))),
      );

      state.revision += 1;
      state.retention_gc = true;
      db.db.exec('PRAGMA secure_delete=ON');
      db.save(state, false, true);
      // Historical snapshots have no recovery consumer; operation acknowledgements protect retries.
      db.db.exec('DELETE FROM events');
      const checkpointHash = canonicalHash(state.checkpoint);
      const ack: WriteAck = {
        operation_id: request.operation_id,
        catalog_revision: state.revision,
        generation: state.generation,
        evidence_id: null,
        revision: null,
        content_hash: checkpointHash,
        locator: `${root}#operation=${encodeURIComponent(request.operation_id)}`,
      };
      db.db
        .prepare('INSERT INTO operations VALUES (?,?,?)')
        .run(request.operation_id, operationHash, canonical(ack));
      const event: EventRecord = {
        operation_id: request.operation_id,
        revision: state.revision,
        context: grant.context,
        change: { type: 'retention', state_hash: checkpointHash, backup_hash: backupHash },
      };
      db.db.prepare('INSERT INTO events VALUES (?,?)').run(state.revision, db.encode(event));
      retainedBlobRoots(db);
      probe('before-commit');
      return ack;
    });
    probe('after-commit');
    let deleted = 0;
    db.transaction(true, () => {
      const state = db.state('current');
      revisionMatches(state.revision, ack.catalog_revision);
      requireStore(
        state.owner === request.expected_owner &&
          state.generation === request.expected_generation &&
          (state.released || state.lease_until <= now()),
        'stale-owner',
      );
      deleted = pruneRetainedBlobs(db, () => probe('blob-removed'));
    });
    db.db.exec('VACUUM');
    syncDirectory(root);
    db.check();
    return { ack, backup: request.backup, backup_hash: backupHash, deleted_blobs: deleted };
  } finally {
    db.close();
  }
}
