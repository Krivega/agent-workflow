import { gzipSync, gunzipSync } from 'node:zlib';
import { requireStore, type ArchiveBlob, type Json } from '../../core/evidence.js';
import { encodeSharedJson, decodeSharedJson, retainedPrefix } from './sharedJson.js';
import { canonical, digest } from './storeCodec.js';

export const archivePrefix = 'AWARCHIVE1\n';
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function reference(value: unknown): value is { hash: string } {
  return record(value) && typeof value.hash === 'string' && /^[a-f0-9]{64}$/u.test(value.hash);
}
export function historyKind(value: RecordValue): 'execution' | 'council' | null {
  if (
    [2, 3].includes(value.schema_version as number) &&
    typeof value.task_id === 'string' &&
    'reviewer_sessions' in value &&
    Array.isArray(value.history)
  )
    return 'execution';
  if (
    (value.phase === 'planning' || value.phase === 'acceptance') &&
    'selection' in value &&
    'advisers' in value &&
    Array.isArray(value.history)
  )
    return 'council';
  return null;
}
function summary(answer: RecordValue) {
  return {
    verdict: answer.verdict,
    coverage: answer.coverage,
    findings: answer.findings,
    evidence: answer.evidence,
    ...(answer.design === undefined ? {} : { design: answer.design }),
    ...(record(answer.binding) ? { binding: { answer_turn: answer.binding.answer_turn } } : {}),
  };
}
function archived(value: RecordValue): boolean {
  return (
    reference(value.archive) &&
    ((typeof value.id === 'string' && value.payload === '') ||
      (typeof value.role === 'string' && typeof value.session === 'string' && record(value.answer)))
  );
}

// The envelope, rather than payload text, distinguishes archive references from literal JSON.
export function compactArchive(value: unknown): { value: Json; blobs: ArchiveBlob[] } {
  const blobs = new Map<string, string>();
  const publish = (content: string) => {
    const hash = digest(content);
    blobs.set(hash, content);
    return hash;
  };
  const save = (body: unknown) => ({ hash: publish(encodeSharedJson(body, publish)) });
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!record(value)) return value;
    const kind = historyKind(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key !== 'history' || kind === null) return [key, walk(child)];
        return [
          key,
          (child as RecordValue[]).map((entry) => {
            if (archived(entry) || entry.retained === true || entry.fingerprint !== undefined)
              return entry;
            if (kind === 'execution') {
              requireStore(
                typeof entry.payload === 'string' && typeof entry.id === 'string',
                'corrupt',
              );
              return {
                ...entry,
                payload: '',
                archive: save({
                  kind: 'execution-event',
                  payload: gzipSync(JSON.stringify(entry.payload)).toString('base64'),
                  dependencies: entry.dependencies ?? [],
                }),
              };
            }
            const answer = entry.answer as RecordValue;
            return {
              role: entry.role,
              session: entry.session,
              answer: summary(answer),
              archive: save({ kind: 'council-answer', answer }),
            };
          }),
        ];
      }),
    );
  };
  return {
    value: walk(value) as Json,
    blobs: [...blobs].map(([hash, content]) => ({ hash, content })),
  };
}

export function hasArchive(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasArchive);
  return (
    record(value) &&
    ((historyKind(value) !== null && (value.history as RecordValue[]).some(archived)) ||
      Object.values(value).some(hasArchive))
  );
}
export function archiveHashes(value: unknown): string[] {
  const hashes = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (record(value)) {
      if (historyKind(value) !== null)
        for (const entry of value.history as RecordValue[])
          if (archived(entry)) hashes.add((entry.archive as { hash: string }).hash);
      Object.values(value).forEach(walk);
    }
  };
  walk(value);
  return [...hashes];
}

export function readArchive(
  hash: string,
  read: (hash: string) => string,
  known = new Set<string>(),
): RecordValue {
  requireStore(/^[a-f0-9]{64}$/u.test(hash), 'corrupt');
  const content = read(hash);
  requireStore(digest(content) === hash, 'corrupt');
  const body = decodeSharedJson(content, read);
  requireStore(record(body), 'corrupt');
  if (body.dependencies !== undefined) {
    requireStore(Array.isArray(body.dependencies), 'corrupt');
    for (const hash of body.dependencies)
      if (!known.has(hash as string)) readArchive(hash as string, read, known);
  }
  return body;
}

export function eventPayload(body: RecordValue): string {
  requireStore(body.kind === 'execution-event' && typeof body.payload === 'string', 'corrupt');
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        gunzipSync(Buffer.from(body.payload, 'base64'), { maxOutputLength: 1_073_741_824 }),
      ),
    );
    requireStore(typeof decoded === 'string', 'corrupt');
    return decoded;
  } catch {
    requireStore(false, 'corrupt');
  }
}

export function expandArchive(value: unknown, read: (hash: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => expandArchive(item, read));
  if (!record(value)) return value;
  const kind = historyKind(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key !== 'history' || kind === null) return [key, expandArchive(child, read)];
      return [
        key,
        (child as RecordValue[]).map((entry) => {
          if (!archived(entry)) return entry;
          const body = readArchive((entry.archive as { hash: string }).hash, read);
          if (kind === 'execution') {
            const { archive: _archive, ...plain } = entry;
            return { ...plain, payload: eventPayload(body) };
          }
          requireStore(
            body.kind === 'council-answer' &&
              record(body.answer) &&
              canonical(entry.answer) === canonical(summary(body.answer)),
            'corrupt',
          );
          return { role: entry.role, session: entry.session, answer: body.answer };
        }),
      ];
    }),
  );
}

export function decodeArchivedJson(
  text: string,
  read: (hash: string) => string,
  full = true,
): unknown {
  if (text.startsWith(retainedPrefix))
    return decodeSharedJson(text.slice(retainedPrefix.length), read, true);
  const marked = text.startsWith(archivePrefix);
  const value = decodeSharedJson(marked ? text.slice(archivePrefix.length) : text, read);
  return marked && full ? expandArchive(value, read) : value;
}
