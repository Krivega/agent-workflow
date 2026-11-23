import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const replayArchive = fileURLToPath(
  new URL('../../docs/evidence/temporal-replay/', import.meta.url),
);

export function readHistorySource(directory, inventory) {
  assert.match(inventory.file, /^[a-z0-9-]+-source\.json$/u);
  assert.match(inventory.sha256, /^[a-f0-9]{64}$/u);
  const shared = join(dirname(directory), 'sources', inventory.sha256 + '.json');
  return readPinnedArtifact(
    existsSync(shared) ? shared : join(directory, inventory.file),
    inventory,
  );
}

export function readReplayArtifact(directory, entry) {
  assert.match(entry.file, /^[a-z0-9-]+\.json$/u);
  const local = join(directory, entry.file);
  if (existsSync(local)) return readPinnedArtifact(local, entry);
  const archived = join(replayArchive, basename(directory), entry.file + '.gz');
  return readPinnedArtifact(archived, entry, true);
}

function readPinnedArtifact(path, inventory, compressed = false) {
  assert.match(inventory.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(inventory.bytes) && inventory.bytes > 0);
  const stored = readFileSync(path);
  const bytes = compressed ? gunzipSync(stored, { maxOutputLength: inventory.bytes }) : stored;
  assert.equal(bytes.length, inventory.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), inventory.sha256);
  return bytes;
}
