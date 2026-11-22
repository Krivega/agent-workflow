import assert from 'node:assert/strict';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { digest } from './spec.mjs';

export function inventory(root) {
  const entries = [];
  function visit(relative) {
    const file = join(root, relative),
      stat = lstatSync(file);
    const common = { path: relative, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink())
      entries.push({ ...common, kind: 'symlink', target: readlinkSync(file) });
    else if (stat.isDirectory()) {
      entries.push({ ...common, kind: 'directory' });
      for (const name of readdirSync(file).sort()) visit(relative ? relative + '/' + name : name);
    } else if (stat.isFile()) {
      const bytes = readFileSync(file);
      entries.push({ ...common, kind: 'file', sha256: digest(bytes), bytes: bytes.length });
    } else entries.push({ ...common, kind: 'special' });
  }
  visit('');
  return entries;
}
export function saveInventory(root, destination) {
  const entries = inventory(root),
    bytes = JSON.stringify(entries, null, 2) + '\n';
  writeFileSync(destination, bytes);
  return { sha256: digest(bytes), entries: entries.length };
}
export function checkSource(root, snapshot, owner, ownerHash) {
  for (const ref of snapshot.files) {
    const file = join(root, ref.path);
    assert.equal(realpathSync(file), file, 'checker source alias: ' + ref.path);
    assert.equal(
      digest(readFileSync(file)),
      ref.path === owner ? ownerHash : ref.sha256,
      'checker source changed: ' + ref.path,
    );
    assert.equal(
      lstatSync(file).mode & 0o777,
      ref.mode,
      'checker source mode changed: ' + ref.path,
    );
  }
}
