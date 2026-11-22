import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as files from '../adapters/storage/storeFiles.js';
import {
  bindChatEvidence,
  chatWriterLock,
  withChatWriter,
} from '../adapters/storage/chatWriter.js';
import type { TechnicalState } from '../core/evidence.js';

let root: string, store: string, evidence: string;
const initial = { checkpoint: null } as TechnicalState;
beforeEach(async () => {
  root = await realpath(await mkdtemp(resolve(tmpdir(), 'chat-writer-')));
  store = resolve(root, 'store');
  evidence = resolve(root, 'evidence');
  await mkdir(store);
  await mkdir(evidence);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('excludes another writer for the entire effect, including another Store in the same parent', async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let started!: () => void;
  const ready = new Promise<void>((done) => {
    started = done;
  });
  const first = withChatWriter(store, async () => {
    started();
    await held;
    return 'finished';
  });
  await Promise.race([ready, first]);
  const effect = vi.fn();
  await expect(withChatWriter(resolve(root, 'other-store'), effect)).rejects.toThrow(
    'chat-writer-busy-or-unknown',
  );
  expect(effect).not.toHaveBeenCalled();
  release();
  expect(await first).toBe('finished');
  expect(await withChatWriter(store, async () => 'next')).toBe('next');
});

it('releases a known failed invocation but never clears an unknown crash or replaced lock', async () => {
  await expect(
    withChatWriter(store, async () => {
      throw new Error('known failure');
    }),
  ).rejects.toThrow('known failure');
  const lock = chatWriterLock(store);
  await writeFile(lock, 'unresolved earlier invocation');
  await expect(withChatWriter(store, async () => undefined)).rejects.toThrow(
    'chat-writer-busy-or-unknown',
  );
  expect(await readFile(lock, 'utf8')).toBe('unresolved earlier invocation');
  await rm(lock);
  await expect(
    withChatWriter(store, async () => {
      await writeFile(lock, 'foreign owner');
    }),
  ).rejects.toThrow('chat-writer-lock-changed');
  expect(await readFile(lock, 'utf8')).toBe('foreign owner');
});

it('does not start an effect when acquiring its lock fails', async () => {
  vi.spyOn(files, 'writePrivateFile').mockImplementationOnce(() => {
    throw new Error('disk failure');
  });
  const effect = vi.fn();
  await expect(withChatWriter(store, effect)).rejects.toThrow('disk failure');
  expect(effect).not.toHaveBeenCalled();
});

it('pins evidence before the first effect and refuses a different root or future binding schema', async () => {
  bindChatEvidence(store, evidence, initial);
  const binding = resolve(store, 'chat-runtime.json');
  const bytes = await readFile(binding, 'utf8');
  bindChatEvidence(store, evidence, { checkpoint: {} } as TechnicalState);
  expect(await readFile(binding, 'utf8')).toBe(bytes);
  expect(() => bindChatEvidence(store, root, initial)).toThrow('chat-evidence-root-mismatch');
  await writeFile(binding, JSON.stringify({ schema_version: 3, evidence_root: evidence }));
  expect(() => bindChatEvidence(store, evidence, initial)).toThrow(
    'unsupported-chat-runtime-binding',
  );
});

it('never infers a legacy binding from completed results which could hide another unknown effect', () => {
  const legacy = {
    checkpoint: { local_run: { results: [{ source: { locator: resolve(evidence, 'ok.json') } }] } },
  } as unknown as TechnicalState;
  expect(() => bindChatEvidence(store, evidence, legacy)).toThrow('chat-runtime-binding-required');
});

it('never treats an unreadable runtime binding as an absent initial binding', () => {
  vi.spyOn(files, 'readPrivateFile').mockImplementationOnce(() => {
    throw new Error('disk failure');
  });
  expect(() => bindChatEvidence(store, evidence, initial)).toThrow('disk failure');
});

it('refuses replacement directories at the same path, so hidden unknown operations cannot disappear', async () => {
  bindChatEvidence(store, evidence, initial);
  await writeFile(resolve(evidence, 'unknown.intent.json'), '{}');
  await rename(evidence, evidence + '-original');
  await mkdir(evidence);
  expect(() => bindChatEvidence(store, evidence, initial)).toThrow(
    'chat-runtime-directory-changed',
  );
  await rm(evidence, { recursive: true });
  await rename(evidence + '-original', evidence);
  bindChatEvidence(store, evidence, initial);
  expect(await readFile(resolve(evidence, 'unknown.intent.json'), 'utf8')).toBe('{}');
});

it('pins the binding bytes throughout an invocation and retains the writer lock on a lost boundary', async () => {
  const verify = bindChatEvidence(store, evidence, initial);
  const binding = resolve(store, 'chat-runtime.json');
  await expect(
    withChatWriter(
      store,
      async () => {
        const bytes = JSON.parse(await readFile(binding, 'utf8')) as Record<string, unknown>;
        await writeFile(binding, JSON.stringify({ ...bytes, evidence_root: root }));
      },
      verify,
    ),
  ).rejects.toThrow('chat-runtime-binding-changed');
  expect(await readFile(chatWriterLock(store), 'utf8')).toContain('token');
});
