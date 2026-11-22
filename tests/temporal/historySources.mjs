import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function readHistorySource(directory, inventory) {
  assert.match(inventory.file, /^[a-z0-9-]+-source\.json$/u);
  assert.match(inventory.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(inventory.bytes) && inventory.bytes > 0);
  const shared = join(dirname(directory), 'sources', inventory.sha256 + '.json');
  const bytes = readFileSync(existsSync(shared) ? shared : join(directory, inventory.file));
  assert.equal(bytes.length, inventory.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), inventory.sha256);
  return bytes;
}
