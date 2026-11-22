import { object } from './connection.js';
import type { InputRef } from './localRun.js';

export function collectInputRefs(value: unknown): InputRef[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectInputRefs);
  const record = object(value);
  if (typeof record.locator === 'string' && typeof record.hash === 'string')
    return [{ locator: record.locator, hash: record.hash }];
  return Object.values(record).flatMap(collectInputRefs);
}
