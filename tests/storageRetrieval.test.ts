import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { EvidenceRetrieval } from '../application/retrieveEvidence.js';
import { persistEvidence } from '../application/persistEvidence.js';
import { importFallback, saveFallback } from '../adapters/storage/evidenceFallback.js';
import { canonical, failure } from '../adapters/storage/storeCodec.js';
import type { EvidenceStore } from '../ports/evidenceStore.js';
import { body, fixture, grant, signed } from './storageFixtures.js';

let f: ReturnType<typeof fixture>;
let port: EvidenceStore;
beforeEach(() => {
  f = fixture();
  f.claim();
  port = { execute: async (request) => f.store.execute(request) };
});
afterEach(() => {
  f.dispose();
});

it('enforces scoped page/body/UTF-8 budgets with explicit question-specific extensions', async () => {
  expect(() => new EvidenceRetrieval(port, grant.context, '')).toThrow('invalid-context');
  f.mutate({ type: 'write', id: 'e', body }, 1);
  const retrieval = new EvidenceRetrieval(port, grant.context, 'check failure');
  for (let page = 0; page < 5; page += 1)
    expect((await retrieval.page('')).coverage).toBe('complete');
  await expect(retrieval.page('')).rejects.toThrow('budget-exhausted');
  await expect(retrieval.selectedBody('e', 1)).rejects.toThrow('budget-exhausted');
  const extension = {
    question: 'check failure',
    reason: 'full raw required',
    coverage: 'all metadata',
    continuation: 'e/1',
    pages: 6,
    bodies: 6,
    bytes: 100_000,
  };
  for (const invalid of [
    { ...extension, question: 'other' },
    { ...extension, reason: '' },
    { ...extension, coverage: '' },
    { ...extension, continuation: '' },
    { ...extension, pages: 0 },
  ])
    expect(() => retrieval.extend(invalid)).toThrow('invalid-context');
  retrieval.extend(extension);
  expect(retrieval.extensions).toEqual([extension]);
  expect((await retrieval.page('')).items).toHaveLength(1);
  for (let read = 0; read < 5; read += 1)
    expect((await retrieval.selectedBody('e', 1)).body.raw).toEqual(body.raw);
  await expect(retrieval.selectedBody('e', 1)).rejects.toThrow('budget-exhausted');
  const failed: EvidenceStore = {
    execute: async (request) => failure(new Error('disk'), request, f.root),
  };
  const inaccessible = new EvidenceRetrieval(failed, grant.context, 'question');
  await expect(inaccessible.page('')).rejects.toThrow('unavailable');
  await expect(inaccessible.selectedBody('e', 1)).rejects.toThrow('unavailable');
});

it('preserves complete fallback data, exposes NOT RUN, and imports idempotently only after recovery', async () => {
  const request = signed({ type: 'write', id: 'e', body }, 1);
  const save = vi.fn(async () => saveFallback(f.parent, request, 'Store недоступен'));
  const offline: EvidenceStore = {
    execute: async () => failure(new Error('disk'), request, f.root),
  };
  const result = await persistEvidence(offline, { save }, request, 'Store недоступен');
  expect(result).toMatchObject({
    ok: false,
    fallback: { status: 'fallback', store_check: 'NOT RUN' },
  });
  if (result.ok || !('fallback' in result)) throw new Error('expected fallback');
  const receipt = result.fallback;
  expect(readFileSync(join(receipt.locator, 'request.json'), 'utf8')).toBe(canonical(request));
  expect(await importFallback(receipt.locator, port)).toMatchObject({
    ok: true,
    value: { catalog_revision: 2 },
  });
  expect(await importFallback(receipt.locator, port)).toMatchObject({
    ok: true,
    value: { catalog_revision: 2 },
  });
  expect(await persistEvidence(port, { save }, request, 'unused')).toMatchObject({ ok: true });
  expect(save).toHaveBeenCalledTimes(1);
  const denied: EvidenceStore = {
    execute: async () => ({
      ok: false,
      error: {
        code: 'permission-denied',
        operation_id: 'op-1',
        observed_revision: null,
        retryable: false,
        recovery_locator: f.root,
      },
    }),
  };
  expect(await persistEvidence(denied, { save }, request, 'must not bypass')).toMatchObject({
    ok: false,
    error: { code: 'permission-denied' },
  });
  expect(save).toHaveBeenCalledTimes(1);
  const unknown: EvidenceStore = {
    execute: vi.fn(async () => ({ ok: true as const, value: { status: 'unknown' as const } })),
  };
  expect(await importFallback(receipt.locator, unknown)).toMatchObject({
    ok: false,
    error: { code: 'unknown-outcome' },
  });
  expect(unknown.execute).toHaveBeenCalledTimes(1);
  expect(await importFallback(receipt.locator, offline)).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  writeFileSync(join(receipt.locator, 'request.json'), '{}');
  await expect(importFallback(receipt.locator, port)).rejects.toThrow('corrupt');
  expect(() => saveFallback(f.parent, request, 'я'.repeat(2501))).toThrow('budget-exhausted');
  expect(() =>
    saveFallback(f.parent, { context: grant.context, command: { type: 'state' } }, 'summary'),
  ).toThrow('invalid-context');
  expect(() => saveFallback(f.parent, signed({ type: 'freeze' }, 2), 'summary')).toThrow(
    'invalid-context',
  );
});
