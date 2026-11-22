import { join } from 'node:path';
import { identifier, requireContract } from '../../contracts/project.js';
import type { ArtifactRef } from '../../contracts/preparation.js';
import { digest, privateDirectory, publishFile, readPrivateFile } from './files.js';

export interface EffectIntent {
  projectId: string;
  taskId: string;
  operationId: string;
  requestHash: string;
  hostId: string;
  workspaceId: string;
  owner: string;
  generation: number;
}

function encode(intent: EffectIntent): string {
  for (const value of [
    intent.projectId,
    intent.taskId,
    intent.operationId,
    intent.hostId,
    intent.workspaceId,
    intent.owner,
  ])
    identifier(value);
  requireContract(
    /^[a-f0-9]{64}$/u.test(intent.requestHash) &&
      Number.isSafeInteger(intent.generation) &&
      intent.generation > 0,
    'invalid-effect-intent',
  );
  return JSON.stringify([
    1,
    intent.projectId,
    intent.taskId,
    intent.operationId,
    intent.requestHash,
    intent.hostId,
    intent.workspaceId,
    intent.owner,
    intent.generation,
  ]);
}

function optionalFile(path: string): string | null {
  try {
    return readPrivateFile(path).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function receiptBytes(receipt: ArtifactRef): Buffer {
  requireContract(
    /^[a-f0-9]{64}$/u.test(receipt.sha256) &&
      Number.isSafeInteger(receipt.bytes) &&
      receipt.bytes >= 0,
    'invalid-effect-receipt',
  );
  return Buffer.from(JSON.stringify(receipt));
}
export function lookupEffect(
  directory: string,
  intent: EffectIntent,
): { status: 'missing' | 'pending' } | { status: 'completed'; receipt: ArtifactRef } {
  const payload = encode(intent),
    key = digest(JSON.stringify([intent.projectId, intent.taskId, intent.operationId])),
    path = join(directory, key),
    retained = optionalFile(path);
  if (retained === null) return { status: 'missing' };
  requireContract(retained === payload, 'effect-id-conflict');
  const outcome = optionalFile(`${path}.receipt`);
  if (outcome === null) return { status: 'pending' };
  const receipt = JSON.parse(outcome) as ArtifactRef;
  receiptBytes(receipt);
  return { status: 'completed', receipt };
}

export function effectJournal(directory: string) {
  const root = privateDirectory(directory);
  return {
    async execute(
      intent: EffectIntent,
      effect: () => Promise<ArtifactRef>,
      recover?: () => Promise<ArtifactRef | null>,
    ): Promise<ArtifactRef> {
      const payload = encode(intent);
      const key = digest(JSON.stringify([intent.projectId, intent.taskId, intent.operationId]));
      const path = join(root, key);
      let fresh = false;
      try {
        publishFile(path, Buffer.from(payload));
        fresh = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      requireContract(readPrivateFile(path).toString('utf8') === payload, 'effect-id-conflict');
      const outcome = optionalFile(`${path}.receipt`);
      if (outcome !== null) {
        const ref = JSON.parse(outcome) as ArtifactRef;
        receiptBytes(ref);
        return ref;
      }
      const receipt = fresh ? await effect() : await recover?.();
      requireContract(receipt !== null && receipt !== undefined, 'effect-outcome-unknown');
      const bytes = receiptBytes(receipt);
      try {
        publishFile(`${path}.receipt`, bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        requireContract(
          readPrivateFile(`${path}.receipt`).equals(bytes),
          'effect-outcome-conflict',
        );
      }
      return receipt;
    },
  };
}
