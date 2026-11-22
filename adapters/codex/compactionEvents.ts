import { object, requireWorkflow, textField } from '../../core/connection.js';
import type { Compaction } from '../../core/relay.js';
import type { InputRef } from '../../core/localRun.js';

// Only the native completed item is a trigger. Resume and helper compaction are not.
export function compactionEvent(
  message: unknown,
  thread: string,
  mode: Compaction['mode'],
  evidence: InputRef,
): Compaction | null {
  const value = object(message);
  if (value.method !== 'item/completed') return null;
  const params = object(value.params);
  const item = object(params.item);
  if (params.threadId !== thread || item.type !== 'contextCompaction') return null;
  requireWorkflow(['manual', 'auto'].includes(mode), 'unknown-compaction-origin');
  return { thread, turn: textField(params.turnId), item: textField(item.id), mode, evidence };
}
