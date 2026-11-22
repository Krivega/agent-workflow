import { statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, requireWorkflow } from '../../core/connection.js';
import type { TechnicalState } from '../../core/evidence.js';
import { readPrivateFile, safeDirectory, syncDirectory, writePrivateFile } from './storeFiles.js';

export function chatWriterLock(store: string) {
  return resolve(safeDirectory(dirname(store)), 'agent-workflow-chat-writer.lock');
}

// One canonical private parent owns exclusion, including case aliases and initial Store creation.
export async function withChatWriter<T>(
  store: string,
  action: () => Promise<T>,
  assertSettled: () => void = () => {},
): Promise<T> {
  safeDirectory(dirname(store));
  const lock = chatWriterLock(store);
  const token = JSON.stringify({ schema_version: 1, token: randomUUID(), store });
  try {
    writePrivateFile(lock, token);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    throw new Error('chat-writer-busy-or-unknown');
  }
  try {
    return await action();
  } finally {
    // A changed runtime boundary leaves the invocation unknown; retain exclusion for recovery.
    assertSettled();
    requireWorkflow(readPrivateFile(lock).toString('utf8') === token, 'chat-writer-lock-changed');
    unlinkSync(lock);
    syncDirectory(dirname(store));
  }
}

export function bindChatEvidence(store: string, evidence: string, state: TechnicalState) {
  safeDirectory(store);
  safeDirectory(evidence);
  const locator = resolve(store, 'chat-runtime.json');
  let bytes: string;
  try {
    bytes = readPrivateFile(locator).toString('utf8');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    // Completed results cannot rule out an unknown older effect in a different directory.
    requireWorkflow(state.checkpoint === null, 'chat-runtime-binding-required');
    const source = statSync(evidence),
      storeIdentity = statSync(store);
    bytes = JSON.stringify({
      schema_version: 2,
      evidence_root: evidence,
      evidence_dev: source.dev,
      evidence_ino: source.ino,
      store_dev: storeIdentity.dev,
      store_ino: storeIdentity.ino,
    });
    writePrivateFile(locator, bytes);
  }
  const binding = object(JSON.parse(bytes) as unknown);
  const verify = () => {
    safeDirectory(store);
    safeDirectory(evidence);
    requireWorkflow(
      readPrivateFile(locator).toString('utf8') === bytes,
      'chat-runtime-binding-changed',
    );
    const source = statSync(evidence),
      storeIdentity = statSync(store);
    requireWorkflow(binding.schema_version === 2, 'unsupported-chat-runtime-binding');
    requireWorkflow(binding.evidence_root === evidence, 'chat-evidence-root-mismatch');
    requireWorkflow(
      binding.evidence_dev === source.dev &&
        binding.evidence_ino === source.ino &&
        binding.store_dev === storeIdentity.dev &&
        binding.store_ino === storeIdentity.ino,
      'chat-runtime-directory-changed',
    );
  };
  verify();
  return verify;
}
