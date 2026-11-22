import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { requireStore } from '../../core/evidence.js';
import type { StoreDatabase } from './storeDatabase.js';
import { EvidenceRecords } from './evidenceRecords.js';
import { syncDirectory } from './storeFiles.js';

export function retainedBlobRoots(db: StoreDatabase): Set<string> {
  const blobs = new Set<string>();
  const state = db.db.prepare('SELECT body FROM state WHERE singleton=1').get()!['body'] as string;
  db.decode(state, blobs, false);
  for (const table of ['events', 'effects'])
    for (const row of db.db.prepare(`SELECT body FROM ${table}`).all())
      db.decode(row['body'] as string, blobs, false);
  for (const entry of new EvidenceRecords(db).all()) {
    for (const hash of [entry.content_hash, entry.raw_hash]) {
      db.files.readBlob(hash);
      blobs.add(hash);
    }
  }
  return blobs;
}

// The caller holds BEGIN IMMEDIATE; only committed, reachable values may survive.
export function pruneRetainedBlobs(db: StoreDatabase, removed: () => void = () => {}) {
  const reachable = retainedBlobRoots(db);
  let count = 0;
  for (const name of readdirSync(join(db.files.root, 'blobs'))) {
    requireStore(
      /^[a-f0-9]{64}$/u.test(name) || /^\.pending-[a-f0-9-]{36}$/u.test(name),
      'corrupt',
    );
    if (reachable.has(name)) continue;
    const path = join(db.files.root, 'blobs', name),
      stat = lstatSync(path);
    requireStore(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'permission-denied');
    unlinkSync(path);
    count += 1;
    removed();
  }
  syncDirectory(join(db.files.root, 'blobs'));
  return count;
}
