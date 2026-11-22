import { compactFixture } from './compactFixtures.js';
import { fixture as storeFixture } from './storageFixtures.js';
import { chatCompactContext } from '../cli/chatCompactContext.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import type { TechnicalState } from '../core/evidence.js';

it('refuses a changing Store snapshot before materializing any compact admission', async () => {
  const f = await compactFixture();
  const db = storeFixture();
  db.claim();
  try {
    const host = new FileCurrentChatHost(f.root, 'unused', f.context.control!.observed);
    const read = db.store.execute.bind(db.store);
    let reads = 0;
    vi.spyOn(db.store, 'execute').mockImplementation((request) => {
      const result = read(request);
      if (request.command.type === 'state' && result.ok && ++reads === 2)
        return { ...result, value: { ...(result.value as TechnicalState), revision: 999 } };
      return result;
    });
    const build = chatCompactContext(
      'execution-chat',
      {},
      host,
      db.store,
      { read: async () => f.context, save: vi.fn() },
      f.loaded,
      { verify: async () => {} },
    );
    await expect(build(f.run, 'marker')).rejects.toThrow('compact-context-snapshot-changed');
  } finally {
    db.dispose();
    await f.dispose();
  }
});

it('requires a valid procedure selection and current owner even when no LOAD is stored', async () => {
  const f = await compactFixture();
  const db = storeFixture();
  db.claim();
  try {
    const host = new FileCurrentChatHost(f.root, 'unused', f.context.control!.observed);
    vi.spyOn(host, 'compaction').mockResolvedValue(f.proof);
    const dependencies = { read: async () => f.context, save: vi.fn() };
    const inputs = { verify: async () => {} };
    const invalid = chatCompactContext(
      'execution-chat',
      { load_procedures: 'invalid' },
      host,
      db.store,
      dependencies,
      f.loaded,
      inputs,
    );
    await expect(invalid(f.run, 'marker')).rejects.toThrow('invalid-compact-action-procedures');
    const unowned = chatCompactContext(
      'execution-chat',
      {},
      host,
      db.store,
      dependencies,
      f.loaded,
      inputs,
    );
    await expect(unowned(f.run, 'marker')).rejects.toThrow('compact-context-owner-mismatch');
  } finally {
    db.dispose();
    await f.dispose();
  }
});
