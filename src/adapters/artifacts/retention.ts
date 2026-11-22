import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { exactFields, object, relativePath, requireContract } from '../../contracts/project.js';
import { controlRef } from '../../policy/readerControl.js';
import { verifyBackup } from './backup.js';
import { digest, readPrivateFile } from './files.js';

const day = 86_400_000;
function timestamp(value: unknown): number {
  requireContract(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value),
    'retention-time-invalid',
  );
  const time = Date.parse(value);
  requireContract(
    Number.isFinite(time) && new Date(time).toISOString() === value,
    'retention-time-invalid',
  );
  return time;
}

export function retentionReport(raw: unknown) {
  const input = object(raw);
  exactFields(input, ['schemaVersion', 'root', 'now', 'files', 'protected', 'backups']);
  requireContract(input.schemaVersion === 1, 'retention-input-version');
  requireContract(
    typeof input.root === 'string' && isAbsolute(input.root),
    'retention-absolute-root-required',
  );
  const root = resolve(input.root),
    now = timestamp(input.now);
  requireContract(
    realpathSync(root) === root && lstatSync(root).isDirectory(),
    'retention-plain-root-required',
  );
  requireContract(
    Array.isArray(input.files) && Array.isArray(input.protected) && Array.isArray(input.backups),
    'retention-list-required',
  );
  const protectedRefs = input.protected.map(controlRef),
    backups = input.backups.map(verifyBackup);
  for (const backup of backups) protectedRefs.push(backup.manifest, ...backup.blobs);
  const protectedHashes = new Set(protectedRefs.map((ref) => ref.sha256)),
    seen = new Set<string>();
  const entries = input.files.map((raw: unknown) => {
    const value = object(raw);
    exactFields(value, ['path', 'kind', 'createdAt', 'content']);
    const name = relativePath(value.path),
      ref = controlRef(value.content),
      createdAt = timestamp(value.createdAt),
      path = join(root, name),
      stat = lstatSync(path);
    requireContract(!seen.has(name), 'retention-duplicate-path');
    seen.add(name);
    requireContract(
      ['log', 'fail', 'manifest', 'evidence', 'projection', 'workcopy'].includes(
        String(value.kind),
      ),
      'retention-kind-invalid',
    );
    requireContract(
      realpathSync(path) === path && stat.isFile() && stat.nlink === 1,
      'retention-plain-file-required',
    );
    const bytes = readPrivateFile(path);
    requireContract(
      bytes.length === ref.bytes && digest(bytes) === ref.sha256,
      'retention-content-corrupted',
    );
    requireContract(createdAt <= now, 'retention-future-file');
    const days =
      value.kind === 'log' ? 30 : value.kind === 'fail' || value.kind === 'manifest' ? 180 : null;
    const reason = protectedHashes.has(ref.sha256)
      ? ('referenced-evidence' as const)
      : days === null
        ? ('separate-authorization-required' as const)
        : now - createdAt < days * day
          ? ('minimum-window' as const)
          : null;
    return {
      path: name,
      kind: value.kind,
      content: ref,
      minimumDays: days,
      decision: reason === null ? ('candidate' as const) : ('retain' as const),
      reason,
    };
  });
  return {
    schemaVersion: 1 as const,
    status: 'report-only' as const,
    deletionAuthorized: false as const,
    entries,
    verifiedBackups: backups.length,
  };
}
