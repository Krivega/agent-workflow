import { requireStore, type Json } from '../../core/evidence.js';
import type { Council } from '../../core/council.js';
import { retainCouncilHistory } from '../../core/council.js';
import { canonicalHash } from './storeCodec.js';
import { historyKind } from './archiveJson.js';
import { decodeHistoryPayload } from './historyPayload.js';
import type { EvidenceContext } from '../../core/evidence.js';
import type { EvidenceStore } from '../../ports/evidenceStore.js';
import { object, requireWorkflow } from '../../core/connection.js';
import { eventPayload } from './archiveJson.js';

export { retainedPrefix } from './sharedJson.js';
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function commandFingerprint(text: string) {
  let command: unknown;
  try {
    command = JSON.parse(text);
  } catch {
    command = text;
  }
  return {
    payload: '',
    fingerprint: retentionFingerprint(command),
    ...(record(command) && Number.isSafeInteger(command.expected_revision)
      ? { expected_revision: command.expected_revision }
      : {}),
    ...(record(command) && Number.isSafeInteger(command.generation)
      ? { generation: command.generation }
      : {}),
    ...(record(command) && typeof command.type === 'string' ? { type: command.type } : {}),
  };
}

export function retentionFingerprint(value: unknown): string {
  return canonicalHash(retainEvidence(value));
}

export function retainEvidence(
  value: unknown,
  readEvent?: (hash: string) => string | ReturnType<typeof commandFingerprint>,
): Json {
  const seen = new WeakMap<object, Map<unknown, unknown>>();
  const receipt = (entry: RecordValue, encoding?: unknown, format?: unknown) => {
    requireStore(typeof entry.id === 'string' && typeof entry.payload === 'string', 'corrupt');
    if (entry.fingerprint !== undefined) {
      requireStore(
        format === 1 &&
          typeof entry.fingerprint === 'string' &&
          /^[a-f0-9]{64}$/u.test(entry.fingerprint) &&
          entry.payload === '' &&
          entry.archive === undefined,
        'corrupt',
      );
      return {
        id: entry.id,
        payload: '',
        fingerprint: entry.fingerprint,
        ...(entry.expected_revision === undefined
          ? {}
          : { expected_revision: entry.expected_revision }),
        ...(entry.generation === undefined ? {} : { generation: entry.generation }),
        ...(entry.type === undefined ? {} : { type: entry.type }),
      };
    }
    let text = entry.payload;
    if (entry.archive !== undefined) {
      requireStore(
        record(entry.archive) && typeof entry.archive.hash === 'string' && readEvent !== undefined,
        'corrupt',
      );
      const archived = readEvent(entry.archive.hash);
      if (typeof archived !== 'string') return { id: entry.id, ...archived };
      text = archived;
    } else if (encoding !== undefined) {
      requireStore(encoding === 1, 'unsupported-version');
      text = decodeHistoryPayload(text);
    }
    return { id: entry.id, ...commandFingerprint(text) };
  };
  const walk = (value: unknown, encoding?: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.get(value)?.has(encoding)) return seen.get(value)!.get(encoding);
    const remember = (result: unknown) => {
      const modes = seen.get(value) ?? new Map<unknown, unknown>();
      modes.set(encoding, result);
      seen.set(value, modes);
    };
    if (Array.isArray(value)) {
      const result = value.map((item) => walk(item));
      remember(result);
      return result;
    }
    const input = value as RecordValue;
    if (
      [2, 3].includes(input.schema_version as number) &&
      typeof input.task_id === 'string' &&
      'reviewer_sessions' in input
    )
      requireStore(Array.isArray(input.history), 'corrupt');
    const workflow =
      [1, 2].includes(input.schema_version as number) &&
      'execution' in input &&
      'readings' in input;
    if (workflow && input.history_payload_encoding !== undefined)
      requireStore(input.history_payload_encoding === 1, 'unsupported-version');
    const kind = historyKind(input);
    const messages =
      input.schema_version === 1 &&
      'thread_id' in input &&
      'initial_assignment' in input &&
      'requirements_revision' in input;
    const retained =
      kind === 'council'
        ? retainCouncilHistory(
            (input as unknown as Council).history,
            (input as unknown as Council).review_turns,
          )
        : null;
    const result: RecordValue = {};
    remember(result);
    const set = (key: string, child: unknown) =>
      Object.defineProperty(result, key, {
        value: child,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    if (kind === 'execution' || messages)
      requireStore(
        input.history_format === undefined || input.history_format === 1,
        'unsupported-version',
      );
    for (const [key, child] of Object.entries(input)) {
      if (workflow && key === 'history_payload_encoding') continue;
      if (key === 'history' && (kind === 'execution' || messages)) {
        requireStore(Array.isArray(child), 'corrupt');
        set(
          key,
          child.map((entry) => receipt(entry as RecordValue, encoding, input.history_format)),
        );
      } else if (key === 'history' && retained !== null) set(key, walk(retained.history));
      else
        set(
          key,
          walk(child, workflow && key === 'execution' ? input.history_payload_encoding : undefined),
        );
    }
    if (retained !== null) result.review_turns = retained.review_turns;
    if (kind === 'execution' || messages) result.history_format = 1;
    return result;
  };
  return walk(value) as Json;
}

export async function retainEvidenceAsync(
  value: unknown,
  readEvent: (hash: string) => Promise<string>,
) {
  const entries: string[] = [];
  const seen = new WeakSet<object>();
  const collect = (value: unknown) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (record(value) && historyKind(value) === 'execution')
      for (const entry of value.history as RecordValue[])
        if (record(entry.archive) && typeof entry.archive.hash === 'string')
          entries.push(entry.archive.hash);
    Object.values(value).forEach(collect);
  };
  collect(value);
  const receipts = new Map<string, ReturnType<typeof commandFingerprint>>();
  for (const hash of new Set(entries))
    receipts.set(hash, commandFingerprint(await readEvent(hash)));
  return retainEvidence(value, (hash) => receipts.get(hash)!);
}

export function retainStoreState(value: unknown, store: EvidenceStore, context: EvidenceContext) {
  return retainEvidenceAsync(value, async (hash) => {
    const reply = await store.execute({ context, command: { type: 'archive', hash } });
    requireWorkflow(reply.ok && 'value' in reply.value, 'workflow-archive-unavailable');
    return eventPayload(object(reply.value.value));
  });
}
