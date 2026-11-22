import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireStore, type EvidenceGrant } from '../../core/evidence.js';
import { StoreDatabase, revisionMatches } from './storeDatabase.js';
import { canonical, canonicalHash } from './storeCodec.js';
import { readArtifactFile } from './sharedArtifacts.js';
import {
  filePointer,
  locatedPath,
  locationsName,
  type FileLocations,
  type LocatedFile,
} from './fileLocations.js';
import {
  createPrivateDirectory,
  noStorageProbe,
  privateFileSource,
  readPrivateFile,
  safeDirectory,
  syncDirectory,
  writePrivateFile,
} from './storeFiles.js';

export interface TaskFileRequest {
  operation_id: string;
  expected_revision: number;
  expected_generation: number;
  expected_owner: string | null;
  files: Record<string, { hash: string; kind: 'archive' | 'tool' }>;
}
function directory(path: string) {
  if (!existsSync(path)) {
    directory(dirname(path));
    createPrivateDirectory(path);
  }
  safeDirectory(path);
}
function replace(path: string, bytes: string) {
  const temporary = resolve(dirname(path), '.relocate-' + randomUUID());
  writePrivateFile(temporary, bytes);
  try {
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function durableCopy(source: string, target: string, mode: number) {
  copyFileSync(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(target, mode & 0o700);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(target));
}
function protectedFile(name: string) {
  return (
    name.startsWith('store/') ||
    name.startsWith('connection/') ||
    name.startsWith('controller/') ||
    name.startsWith('card-projections/') ||
    ['managed-chat.json', 'request.json', 'CURRENT-CHECKPOINT.md', locationsName].includes(name) ||
    name.endsWith('.workflow-pool.json') ||
    name.endsWith('.check.lock') ||
    name.endsWith('.intent.json') ||
    (name.startsWith('council/') &&
      /^[^/]+\.json$/u.test(name.slice('council/'.length)) &&
      !/^(request|load|review|answer)-/u.test(name.slice('council/'.length)))
  );
}
export function relocateTaskFiles(
  root: string,
  storage: string,
  grant: EvidenceGrant,
  request: TaskFileRequest,
  now: () => number = Date.now,
  probe: (stage: 'copied' | 'indexed' | 'replaced') => void = () => {},
) {
  requireStore(grant.permissions.includes('manage'), 'permission-denied');
  safeDirectory(root);
  requireStore(
    dirname(storage) === root &&
      typeof request.operation_id === 'string' &&
      request.operation_id.length > 0 &&
      Number.isSafeInteger(request.expected_revision) &&
      request.expected_revision >= 0 &&
      Number.isSafeInteger(request.expected_generation) &&
      request.expected_generation >= 0 &&
      request.files !== null &&
      typeof request.files === 'object' &&
      !Array.isArray(request.files),
    'invalid-context',
  );
  const operation_hash = canonicalHash({ root, context: grant.context, request });
  const indexPath = resolve(root, locationsName);
  const existing = existsSync(indexPath)
    ? (JSON.parse(readPrivateFile(indexPath).toString('utf8')) as FileLocations)
    : null;
  if (existing !== null)
    requireStore(
      existing.schema_version === 1 &&
        existing.root === root &&
        existing.operation_hash === operation_hash,
      'revision-conflict',
    );
  const db = new StoreDatabase(storage, grant.context, noStorageProbe);
  try {
    return db.transaction(true, () => {
      const state = db.state('current');
      revisionMatches(state.revision, request.expected_revision);
      requireStore(
        state.owner === request.expected_owner &&
          state.generation === request.expected_generation &&
          !state.frozen &&
          (state.released || state.lease_until <= now()),
        'stale-owner',
      );
      requireStore(
        db.db.prepare('SELECT count(*) AS n FROM effects').get()!['n'] === 0,
        'invalid-context',
      );
      for (const name of readdirSync(root)) {
        requireStore(!name.endsWith('.check.lock'), 'invalid-context');
        if (name.endsWith('.intent.json')) {
          const intent = readArtifactFile(resolve(root, name)) as { request_hash: string };
          const proof = readArtifactFile(
            resolve(root, name.slice(0, -'.intent.json'.length) + '.json'),
          ) as { request_hash: string; operation_id: string };
          requireStore(
            typeof intent.request_hash === 'string' &&
              proof.request_hash === intent.request_hash &&
              proof.operation_id === name.slice(0, -'.intent.json'.length),
            'invalid-context',
          );
        }
      }
      const checkpoint_hash = canonicalHash(state.checkpoint);
      const names = Object.keys(request.files).sort();
      requireStore(names.length > 0, 'invalid-context');
      const toolNames = names.filter((name) => request.files[name]!.kind === 'tool');
      const bundle = canonicalHash(toolNames.map((name) => [name, request.files[name]!.hash]));
      const files = Object.create(null) as FileLocations['files'];
      for (const name of names) {
        requireStore(!protectedFile(name), 'permission-denied');
        const requested = request.files[name]!;
        requireStore(requested.kind === 'archive' || requested.kind === 'tool', 'invalid-context');
        const path = resolve(root, name);
        requireStore(path.startsWith(root + '/'), 'permission-denied');
        safeDirectory(dirname(path));
        const stat = lstatSync(path);
        requireStore(
          stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
          'permission-denied',
        );
        const source = privateFileSource(path);
        requireStore(source.hash === requested.hash, 'corrupt');
        const old = existing?.files[name];
        const entry: LocatedFile = old ?? {
          ...requested,
          bytes: stat.size,
          mode: stat.mode & 0o777,
          ...(requested.kind === 'tool' ? { bundle } : {}),
        };
        requireStore(entry.hash === requested.hash && entry.kind === requested.kind, 'corrupt');
        const target = locatedPath(root, name, entry);
        directory(dirname(target));
        if (!existsSync(target)) {
          const temporary = target + '.' + randomUUID();
          try {
            durableCopy(source.path, temporary, entry.mode);
            requireStore(privateFileSource(temporary).hash === entry.hash, 'corrupt');
            renameSync(temporary, target);
            syncDirectory(dirname(target));
          } finally {
            if (existsSync(temporary)) unlinkSync(temporary);
          }
        }
        requireStore(privateFileSource(target).hash === entry.hash, 'corrupt');
        files[name] = entry;
      }
      probe('copied');
      const index: FileLocations = {
        schema_version: 1,
        root,
        operation_hash,
        complete: false,
        files,
      };
      replace(indexPath, canonical(index) + '\n');
      probe('indexed');
      for (const name of names) {
        requireStore(privateFileSource(resolve(root, name)).hash === files[name]!.hash, 'corrupt');
        replace(resolve(root, name), filePointer(files[name]!.hash));
        probe('replaced');
      }
      requireStore(canonicalHash(db.state('current').checkpoint) === checkpoint_hash, 'corrupt');
      replace(indexPath, canonical({ ...index, complete: true }) + '\n');
      return {
        operation_id: request.operation_id,
        checkpoint_hash,
        files: names.length,
        logical_bytes: Object.values(files).reduce((n, f) => n + f.bytes, 0),
        archive: resolve(dirname(root), 'archives', canonicalHash(root)),
        tools: toolNames.length === 0 ? null : resolve(dirname(root), 'tool-cache', bundle),
        index: indexPath,
      };
    });
  } finally {
    db.close();
  }
}
export function materializeTaskFiles(
  root: string,
  destination: string,
  storage: string,
  grant: EvidenceGrant,
  now: () => number = Date.now,
) {
  requireStore(grant.permissions.includes('manage'), 'permission-denied');
  requireStore(dirname(storage) === root, 'invalid-context');
  const db = new StoreDatabase(storage, grant.context, noStorageProbe);
  try {
    return db.transaction(true, () => {
      const state = db.state('current');
      requireStore(state.frozen || state.released || state.lease_until <= now(), 'stale-owner');
      requireStore(
        db.db.prepare('SELECT count(*) AS n FROM effects').get()!['n'] === 0,
        'invalid-context',
      );
      return materializeFiles(root, destination);
    });
  } finally {
    db.close();
  }
}
function materializeFiles(root: string, destination: string) {
  safeDirectory(root);
  requireStore(
    resolve(destination) === destination &&
      destination !== root &&
      !destination.startsWith(root + '/') &&
      !existsSync(destination),
    'permission-denied',
  );
  const index = JSON.parse(
    readPrivateFile(resolve(root, locationsName)).toString('utf8'),
  ) as FileLocations;
  requireStore(
    index.schema_version === 1 &&
      index.root === root &&
      index.files !== null &&
      typeof index.files === 'object',
    'corrupt',
  );
  createPrivateDirectory(destination);
  const files: Record<string, string> = {};
  const copy = (source: string, target: string) => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const path = resolve(source, entry.name),
        out = resolve(target, entry.name),
        name = path.slice(root.length + 1);
      if (name === locationsName) continue;
      if (entry.isDirectory()) {
        createPrivateDirectory(out);
        copy(path, out);
        continue;
      }
      const actual = privateFileSource(path);
      const mode = index.files[name]?.mode ?? lstatSync(path).mode;
      durableCopy(actual.path, out, mode);
      requireStore(privateFileSource(out).hash === actual.hash, 'corrupt');
      files[name] = actual.hash;
    }
  };
  copy(root, destination);
  return { root: destination, files, hash: canonicalHash(files) };
}
