import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readHistorySource } from './historySources.mjs';

test('reads original or shared bytes and refuses corrupted or missing evidence without fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-history-sources-'));
  const directory = join(root, 'corpus');
  const bytes = Buffer.from('[ { "original": true } ]\n');
  const inventory = {
    file: 'original-source.json',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
  const local = join(directory, inventory.file);
  const shared = join(root, 'sources', inventory.sha256 + '.json');
  try {
    mkdirSync(directory);
    writeFileSync(local, bytes);
    assert.deepEqual(readHistorySource(directory, inventory), bytes);
    assert.throws(() => readHistorySource(directory, { ...inventory, bytes: bytes.length + 1 }));
    assert.throws(() => readHistorySource(directory, { ...inventory, sha256: 'a'.repeat(64) }));
    for (const change of [{ file: '../escape-source.json' }, { sha256: '../escape' }, { bytes: 0 }])
      assert.throws(() => readHistorySource(directory, { ...inventory, ...change }));
    mkdirSync(join(root, 'sources'));
    writeFileSync(shared, bytes);
    rmSync(local);
    assert.deepEqual(readHistorySource(directory, inventory), bytes);
    writeFileSync(local, bytes);
    writeFileSync(shared, Buffer.alloc(bytes.length));
    assert.throws(() => readHistorySource(directory, inventory));
    rmSync(shared);
    rmSync(local);
    assert.throws(() => readHistorySource(directory, inventory));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all original source-inventory references still resolve to their pinned bytes', () => {
  const root = fileURLToPath(new URL('./histories/', import.meta.url));
  let checked = 0;
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const directory = join(root, item.name);
    if (!item.isDirectory() || !existsSync(join(directory, 'manifest.json'))) continue;
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    for (const inventory of manifest.sourceInventories ?? []) {
      assert.ok(Array.isArray(JSON.parse(readHistorySource(directory, inventory))));
      checked++;
    }
  }
  assert.ok(checked > 0);
});
