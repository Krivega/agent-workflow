import { existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { object, requireWorkflow } from '../../core/connection.js';
import type { InputRef } from '../../core/localRun.js';
import { canonical, digest } from './storeCodec.js';
import { encodeSharedJson, decodeSharedJson, retainedPrefix } from './sharedJson.js';
import { retainEvidence } from './retainedJson.js';
import {
  archivePrefix,
  compactArchive,
  decodeArchivedJson,
  hasArchive,
  archiveHashes,
  readArchive,
  eventPayload,
} from './archiveJson.js';
import {
  readPrivateFile,
  writePrivateFile,
  safeDirectory,
  createPrivateDirectory,
  syncDirectory,
} from './storeFiles.js';

export const retainedInlinePrefix = 'AWRETAIN2\n';
const poolFile = '.workflow-pool.json';

export function shareArtifactPool(root: string, parent: string) {
  requireWorkflow(dirname(root) === parent, 'chat-artifact-pool-outside-root');
  safeDirectory(parent);
  safeDirectory(root);
  publish(resolve(root, poolFile), canonical({ schema_version: 1, parent: '..' }) + '\n');
}
function artifactPool(root: string) {
  const path = resolve(root, poolFile);
  if (!existsSync(path)) return root;
  const config = object(JSON.parse(readPrivateFile(path).toString('utf8')) as unknown);
  requireWorkflow(
    config.schema_version === 1 && config.parent === '..',
    'chat-artifact-pool-outside-root',
  );
  safeDirectory(dirname(root));
  return dirname(root);
}
export function artifactBlobPath(root: string, hash: string): string {
  requireWorkflow(/^[a-f0-9]{64}$/u.test(hash), 'chat-artifact-conflict');
  const local = resolve(root, 'shared-json', hash);
  return existsSync(local) ? local : resolve(artifactPool(root), 'shared-json', hash);
}
export function readArtifactBlob(root: string, hash: string): string {
  const content = readPrivateFile(artifactBlobPath(root, hash));
  requireWorkflow(digest(content) === hash, 'chat-artifact-conflict');
  return content.toString('utf8');
}
function proofContent(value: unknown, publish: (content: string) => string) {
  const encoded = encodeSharedJson(value, publish, true);
  return encoded.startsWith('AWJSON1\n["value",') ? canonical(value) + '\n' : encoded;
}
export function chatArtifactContent(value: unknown): string {
  return proofContent(value, digest);
}
export function encodeProofArtifact(root: string, value: unknown): string {
  const directory = resolve(artifactPool(root), 'shared-json');
  return proofContent(value, (content) => {
    if (!existsSync(directory)) createPrivateDirectory(directory);
    safeDirectory(directory);
    const hash = digest(content);
    publish(resolve(directory, hash), content);
    return hash;
  });
}

function publish(path: string, bytes: string) {
  if (!existsSync(path)) {
    const temporary = resolve(dirname(path), `.pending-${randomUUID()}`);
    writePrivateFile(temporary, bytes);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  }
  requireWorkflow(readPrivateFile(path).toString('utf8') === bytes, 'chat-artifact-conflict');
}

function large(value: unknown, remaining = 65535): number {
  if (typeof value === 'string' && value.length >= remaining) return remaining;
  if (value === null || typeof value !== 'object') return canonical(value).length;
  const entries = Array.isArray(value)
    ? value.map((item) => [null, item] as const)
    : Object.entries(value);
  let length = 2 + Math.max(0, entries.length - 1);
  for (const [key, item] of entries) {
    if (key !== null) length += JSON.stringify(key).length + 1;
    if (length >= remaining) break;
    length += large(item, remaining - length);
  }
  return length;
}

export function encodeChatArtifact(
  root: string,
  value: unknown,
  archive: boolean | 'minimal' = false,
  source?: (hash: string) => string,
): string {
  const minimal = archive === 'minimal';
  const packed = minimal
    ? {
        value: retainEvidence(value, (hash) =>
          eventPayload(
            readArchive(hash, (child) => {
              const path = resolve(root, 'shared-json', child);
              if (existsSync(path) || existsSync(resolve(artifactPool(root), 'shared-json', child)))
                return readArtifactBlob(root, child);
              requireWorkflow(source !== undefined, 'chat-archive-source-required');
              return source(child);
            }),
          ),
        ),
        blobs: [],
      }
    : archive
      ? compactArchive(value)
      : { value, blobs: [] };
  value = packed.value;
  if (minimal) {
    const blobs: Record<string, string> = {};
    const root = encodeSharedJson(value, (content) => {
      const hash = digest(content);
      blobs[hash] = content;
      return hash;
    });
    return retainedInlinePrefix + canonical({ root, blobs });
  }
  if (
    !minimal &&
    packed.blobs.length === 0 &&
    !(archive && hasArchive(value)) &&
    large(value) < 65535
  )
    return canonical(value) + '\n';
  const directory = resolve(artifactPool(root), 'shared-json');
  try {
    createPrivateDirectory(directory);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  safeDirectory(directory);
  const published = new Set<string>();
  const write = (content: string) => {
    const hash = digest(content);
    if (!published.has(hash)) {
      publish(resolve(directory, hash), content);
      published.add(hash);
    }
    return hash;
  };
  const roots = archive === true ? archiveHashes(value) : [];
  const archived = new Set(roots);
  for (const blob of packed.blobs) if (!archived.has(blob.hash)) write(blob.content);
  if (archive === true) {
    const pending = new Map(packed.blobs.map((blob) => [blob.hash, blob.content]));
    const target = (hash: string) => {
      requireWorkflow(/^[a-f0-9]{64}$/u.test(hash), 'chat-artifact-conflict');
      return resolve(directory, hash);
    };
    const copy = (hash: string) => {
      const path = target(hash),
        fresh = pending.get(hash);
      if (fresh === undefined && existsSync(path)) return;
      requireWorkflow(fresh !== undefined || source !== undefined, 'chat-archive-source-required');
      const content = fresh ?? source!(hash);
      requireWorkflow(digest(content) === hash, 'chat-artifact-conflict');
      const body = object(
        decodeSharedJson(content, (hash) => {
          const child = target(hash);
          if (!existsSync(child)) {
            requireWorkflow(source !== undefined, 'chat-archive-source-required');
            requireWorkflow(write(source(hash)) === hash, 'chat-artifact-conflict');
          }
          const bytes = readPrivateFile(child).toString('utf8');
          requireWorkflow(digest(bytes) === hash, 'chat-artifact-conflict');
          return bytes;
        }),
      );
      requireWorkflow(
        body.dependencies === undefined || Array.isArray(body.dependencies),
        'chat-artifact-conflict',
      );
      for (const dependency of (body.dependencies as string[] | undefined) ?? []) copy(dependency);
      write(content);
    };
    for (const hash of roots) copy(hash);
  }
  return (archive && hasArchive(value) ? archivePrefix : '') + encodeSharedJson(value, write);
}

export function saveChatArtifact(
  root: string,
  name: string,
  value: unknown,
  archive: boolean | 'minimal' = false,
  source?: (hash: string) => string,
): InputRef {
  const bytes = encodeChatArtifact(root, value, archive, source);
  const hash = digest(bytes);
  const locator = resolve(
    root,
    `${name}-${hash}${bytes.startsWith('AWJSON1\n') || bytes.startsWith(archivePrefix) || bytes.startsWith(retainedPrefix) || bytes.startsWith(retainedInlinePrefix) ? '.shared' : ''}.json`,
  );
  publish(locator, bytes);
  return { locator, hash };
}
export function readChatArtifact(ref: InputRef): unknown {
  const bytes = readPrivateFile(ref.locator);
  requireWorkflow(digest(bytes) === ref.hash, 'chat-artifact-conflict');
  return decodeChatArtifact(dirname(ref.locator), bytes.toString('utf8'));
}
export function readArtifactFile(path: string): unknown {
  return decodeChatArtifact(dirname(path), readPrivateFile(path).toString('utf8'));
}

export function decodeChatArtifact(root: string, bytes: string, full = true): unknown {
  if (bytes.startsWith(retainedInlinePrefix)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.slice(retainedInlinePrefix.length));
    } catch {
      throw new Error('chat-artifact-conflict');
    }
    const packet = object(parsed);
    requireWorkflow(typeof packet.root === 'string', 'chat-artifact-conflict');
    const blobs = object(packet.blobs);
    const read = new Set<string>();
    const value = decodeSharedJson(
      packet.root,
      (hash) => {
        requireWorkflow(
          /^[a-f0-9]{64}$/u.test(hash) &&
            typeof blobs[hash] === 'string' &&
            digest(blobs[hash]) === hash,
          'chat-artifact-conflict',
        );
        read.add(hash);
        return blobs[hash];
      },
      true,
    );
    requireWorkflow(read.size === Object.keys(blobs).length, 'chat-artifact-conflict');
    return value;
  }
  return decodeArchivedJson(
    bytes,
    (hash) => {
      return readArtifactBlob(root, hash);
    },
    full,
  );
}
