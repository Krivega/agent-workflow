import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  artifactStore,
  digest,
  privateDirectory,
  publishFile,
  readPrivateFile,
  readProjectFile,
} from '../../src/adapters/artifacts/files.js';
import { effectJournal, lookupEffect } from '../../src/adapters/artifacts/effects.js';
import type { EffectIntent } from '../../src/adapters/artifacts/effects.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));

const roots: string[] = [];
function directory() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'aw-temporal-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('content-addressed artifacts', () => {
  it('reads an existing root without mkdir and never recreates a missing root', () => {
    const root = directory(),
      original = artifactStore(root),
      ref = original.publish(Buffer.from('retained bytes')),
      mkdir = vi.spyOn(fs, 'mkdirSync'),
      read = artifactStore(root, { existingOnly: true });
    expect(read.read(ref).toString()).toBe('retained bytes');
    expect(read.path(ref)).toBe(join(root, ref.sha256));
    expect(() => artifactStore(join(root, 'missing'), { existingOnly: true })).toThrow();
    expect(fs.existsSync(join(root, 'missing'))).toBe(false);
    expect(mkdir).not.toHaveBeenCalled();
    const retained = root + '-retained';
    roots.push(retained);
    fs.renameSync(root, retained);
    expect(() => read.read(ref)).toThrow();
    expect(() => read.publish(Buffer.from('late effect'))).toThrow();
    expect(fs.existsSync(root)).toBe(false);
    expect(mkdir).not.toHaveBeenCalled();
    fs.mkdirSync(root);
    expect(() => read.read(ref)).toThrow('artifact-root-changed');
    expect(() => read.publish(Buffer.from('late effect'))).toThrow('artifact-root-changed');
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('rejects an existing linked root and a root replaced during a verified read', () => {
    const root = directory(),
      ref = artifactStore(root).publish(Buffer.from('retained bytes')),
      alias = join(root, 'alias');
    fs.symlinkSync(root, alias);
    expect(() => artifactStore(alias, { existingOnly: true })).toThrow('artifact-root-changed');
    fs.unlinkSync(alias);
    const read = artifactStore(root, { existingOnly: true }),
      originalRead = fs.readFileSync,
      retained = root + '-retained';
    roots.push(retained);
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce((path, options) => {
      const bytes = originalRead(path, options);
      fs.renameSync(root, retained);
      fs.mkdirSync(root);
      return bytes;
    });
    expect(() => read.read(ref)).toThrow('artifact-root-changed');
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('publishes immutable bytes idempotently and detects corruption', () => {
    const root = directory();
    const store = artifactStore(root);
    const ref = store.publish(Buffer.from('FAIL original'));
    expect(store.publish(Buffer.from('FAIL original'))).toEqual(ref);
    expect(store.read(ref).toString()).toBe('FAIL original');
    expect(fs.statSync(join(root, ref.sha256)).mode & 0o777).toBe(0o600);
    fs.writeFileSync(join(root, ref.sha256), 'FAIL changed');
    expect(() => store.read(ref)).toThrow('artifact-corrupted');
    expect(() => store.read({ ...ref, bytes: 0 })).toThrow('artifact-corrupted');
    expect(() => store.read({ ...ref, sha256: '../a' })).toThrow('invalid-artifact-ref');
    expect(() => store.read({ ...ref, bytes: -1 })).toThrow('invalid-artifact-ref');
    expect(() => store.read({ ...ref, bytes: 0.1 })).toThrow('invalid-artifact-ref');
  });
  it('rechecks bytes without writing or syncing an unchanged publication', () => {
    const store = artifactStore(directory());
    const bytes = Buffer.from('original');
    const ref = store.publish(bytes);
    const write = vi.spyOn(fs, 'writeFileSync');
    const sync = vi.spyOn(fs, 'fsyncSync');
    const read = vi.spyOn(fs, 'readFileSync');
    expect(store.publish(bytes)).toEqual(ref);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    read.mockReturnValueOnce(Buffer.from('tampered'));
    expect(() => store.publish(bytes)).toThrow('artifact-corrupted');
  });
  it('republishes removed files and syncs replacements and a fresh store', () => {
    const root = directory();
    const store = artifactStore(root);
    const bytes = Buffer.from('original');
    const ref = store.publish(bytes);
    const path = join(root, ref.sha256);
    fs.unlinkSync(path);
    expect(store.publish(bytes)).toEqual(ref);
    const sync = vi.spyOn(fs, 'fsyncSync');
    const replacement = join(root, 'replacement');
    fs.writeFileSync(replacement, bytes);
    fs.renameSync(replacement, path);
    expect(store.publish(bytes)).toEqual(ref);
    expect(sync).toHaveBeenCalled();
    sync.mockClear();
    expect(artifactStore(root).publish(bytes)).toEqual(ref);
    expect(sync).toHaveBeenCalled();
    fs.writeFileSync(path, 'tampered');
    expect(() => store.publish(bytes)).toThrow('artifact-corrupted');
  });
  it('propagates identity errors and refuses a linked replacement', () => {
    const root = directory();
    const store = artifactStore(root);
    const bytes = Buffer.from('original');
    const ref = store.publish(bytes);
    vi.spyOn(fs, 'lstatSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(() => store.publish(bytes)).toThrow('denied');
    const path = join(root, ref.sha256);
    fs.renameSync(path, join(root, 'original'));
    fs.symlinkSync(join(root, 'original'), path);
    expect(() => store.publish(bytes)).toThrow('unsafe-private-file');
  });
  it('retries directory durability after a lost publication without caching a failed sync', () => {
    const root = directory();
    const store = artifactStore(root);
    const bytes = Buffer.from('original');
    const actual = fs.fsyncSync;
    const sync = vi.spyOn(fs, 'fsyncSync');
    sync.mockImplementationOnce(actual).mockImplementationOnce(() => {
      throw new Error('directory sync failed');
    });
    expect(() => store.publish(bytes)).toThrow('directory sync failed');
    sync.mockClear();
    expect(store.publish(bytes)).toEqual({ sha256: digest(bytes), bytes: bytes.length });
    expect(sync).toHaveBeenCalledTimes(2);
    sync.mockClear();
    store.publish(bytes);
    expect(sync).not.toHaveBeenCalled();
  });
  it('publishes the same artifact from independent concurrent processes without partial files', async () => {
    const root = directory();
    const module = new URL('../../src/adapters/artifacts/files.ts', import.meta.url).href;
    const run = promisify(execFile);
    await Promise.all(
      [0, 1].map((worker) =>
        run(process.execPath, [
          '--input-type=module',
          '-e',
          `import {registerHooks} from 'node:module';
import {writeFileSync,existsSync} from 'node:fs';
const sourceModule=${JSON.stringify(module)};
registerHooks({resolve(specifier,context,nextResolve){
  return nextResolve(context.parentURL===sourceModule && specifier==='../../contracts/project.js'
    ? new URL('../../contracts/project.ts',sourceModule).href : specifier,context);
}});
const {artifactStore}=await import(sourceModule);
const root=${JSON.stringify(root)};
writeFileSync(root+'/ready-${worker}','');
for(let step=0;!existsSync(root+'/ready-${1 - worker}');step++){
  if(step>1000)throw new Error('Other publisher did not start');
  await new Promise(done=>setTimeout(done,1));
}
const store=artifactStore(root);
for(let index=0;index<8;index++)store.publish(Buffer.from('concurrent'));
`,
        ]),
      ),
    );
    const ref = { sha256: digest('concurrent'), bytes: 10 };
    expect(artifactStore(root).read(ref).toString()).toBe('concurrent');
    expect(fs.readdirSync(root).sort()).toEqual([ref.sha256, 'ready-0', 'ready-1'].sort());
  });
  it('bounds remembered publications and safely rechecks evicted entries', () => {
    const store = artifactStore(directory());
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {});
    for (let index = 0; index <= 1024; index++) store.publish(Buffer.from(String(index)));
    sync.mockClear();
    store.publish(Buffer.from('1024'));
    expect(sync).not.toHaveBeenCalled();
    store.publish(Buffer.from('0'));
    expect(sync).toHaveBeenCalledTimes(2);
  });
  it('refuses linked project inputs, linked private data and nonfiles', () => {
    const root = directory();
    fs.writeFileSync(join(root, 'RULES.md'), 'rules');
    expect(readProjectFile(root, 'RULES.md').toString()).toBe('rules');
    fs.symlinkSync(join(root, 'RULES.md'), join(root, 'link'));
    expect(() => readProjectFile(root, 'link')).toThrow('unsafe-project-file');
    expect(() => readPrivateFile(join(root, 'link'))).toThrow('unsafe-private-file');
    expect(() => readPrivateFile(root)).toThrow('unsafe-private-file');
    fs.symlinkSync(root, join(root, 'linked-directory'));
    expect(() => privateDirectory(join(root, 'linked-directory'))).toThrow('unsafe-directory');
  });
  it('fails closed on disk errors without publishing a partial artifact', () => {
    const root = directory();
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw error;
    });
    expect(() => publishFile(join(root, 'artifact'), Buffer.from('a'))).toThrow('disk full');
    expect(fs.readdirSync(root)).toEqual([]);
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw error;
    });
    expect(() => artifactStore(root).publish(Buffer.from('a'))).toThrow('disk full');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

const intent: EffectIntent = {
  projectId: 'p',
  taskId: 't',
  operationId: 'create-1',
  requestHash: digest('request'),
  hostId: 'mac',
  workspaceId: 'main',
  owner: 'u',
  generation: 1,
};
const receipt = { sha256: digest('receipt'), bytes: 7 };
describe('read-only external effect lookup', () => {
  it('keeps missing/pending unknown and reads only the exact completed receipt', async () => {
    const root = directory(),
      missing = join(root, 'missing');
    expect(lookupEffect(missing, intent)).toEqual({ status: 'missing' });
    expect(fs.existsSync(missing)).toBe(false);
    let release!: (ref: typeof receipt) => void;
    const pending = effectJournal(root).execute(
      intent,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(lookupEffect(root, intent)).toEqual({ status: 'pending' });
    expect(() => lookupEffect(root, { ...intent, generation: 2 })).toThrow('effect-id-conflict');
    release(receipt);
    await pending;
    expect(lookupEffect(root, intent)).toEqual({ status: 'completed', receipt });
    fs.writeFileSync(
      join(
        root,
        fs.readdirSync(root).find((name) => name.endsWith('.receipt'))!,
      ),
      JSON.stringify({ ...receipt, bytes: -1 }),
    );
    expect(() => lookupEffect(root, intent)).toThrow('invalid-effect-receipt');
  });
});

describe('minimal effect journal', () => {
  it('reconciles a lost outcome only from primary evidence, without repeating the effect', async () => {
    const root = directory();
    const journal = effectJournal(root);
    const effect = vi.fn(async () => {
      throw new Error('response lost');
    });
    await expect(journal.execute(intent, effect)).rejects.toThrow('response lost');
    const recover = vi.fn(async () => receipt);
    expect(await journal.execute(intent, effect, recover)).toEqual(receipt);
    expect(await journal.execute(intent, effect, recover)).toEqual(receipt);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
    await expect(journal.execute({ ...intent, generation: 2 }, effect, recover)).rejects.toThrow(
      'effect-id-conflict',
    );
    expect(recover).toHaveBeenCalledTimes(1);
  });
  it('leaves absent/ambiguous primary evidence unknown', async () => {
    const journal = effectJournal(directory());
    const effect = vi.fn(async () => {
      throw new Error('response lost');
    });
    await expect(journal.execute(intent, effect)).rejects.toThrow('response lost');
    await expect(journal.execute(intent, effect, async () => null)).rejects.toThrow(
      'effect-outcome-unknown',
    );
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('handles a race between completion and reconciliation with the same receipt', async () => {
    const journal = effectJournal(directory());
    let release!: (value: typeof receipt) => void;
    const first = journal.execute(
      intent,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(
      await journal.execute(
        intent,
        async () => receipt,
        async () => receipt,
      ),
    ).toEqual(receipt);
    release(receipt);
    expect(await first).toEqual(receipt);
  });
  it('refuses a conflicting outcome and preserves receipt write failures', async () => {
    const root = directory();
    const journal = effectJournal(root);
    let release!: (value: typeof receipt) => void;
    const first = journal.execute(
      intent,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await journal.execute(
      intent,
      async () => receipt,
      async () => receipt,
    );
    release({ ...receipt, bytes: 8 });
    await expect(first).rejects.toThrow('effect-outcome-conflict');
    const error = Object.assign(new Error('full'), { code: 'ENOSPC' });
    const original = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (String(to).endsWith('.receipt')) throw error;
      return original(from, to);
    });
    await expect(
      journal.execute({ ...intent, operationId: 'second' }, async () => receipt),
    ).rejects.toThrow('full');
  });
  it('returns the same receipt after retry and rejects conflicting identity or payload', async () => {
    const root = directory();
    const effect = vi.fn(async () => receipt);
    const journal = effectJournal(root);
    expect(await journal.execute(intent, effect)).toEqual(receipt);
    expect(await effectJournal(root).execute(intent, effect)).toEqual(receipt);
    expect(effect).toHaveBeenCalledTimes(1);
    await expect(
      journal.execute({ ...intent, requestHash: digest('other') }, effect),
    ).rejects.toThrow('effect-id-conflict');
    await expect(journal.execute({ ...intent, generation: 2 }, effect)).rejects.toThrow(
      'effect-id-conflict',
    );
  });
  it('does not repeat a concurrent or unknown effect after process restart', async () => {
    const root = directory();
    let release!: (value: typeof receipt) => void;
    const effect = vi.fn(
      () =>
        new Promise<typeof receipt>((resolve) => {
          release = resolve;
        }),
    );
    const first = effectJournal(root).execute(intent, effect);
    await expect(effectJournal(root).execute(intent, effect)).rejects.toThrow(
      'effect-outcome-unknown',
    );
    release(receipt);
    await first;
    const other = { ...intent, operationId: 'lost-response' };
    await expect(
      effectJournal(root).execute(other, async () => {
        throw new Error('lost response');
      }),
    ).rejects.toThrow('lost response');
    await expect(effectJournal(root).execute(other, effect)).rejects.toThrow(
      'effect-outcome-unknown',
    );
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...intent, requestHash: 'bad' },
    { ...intent, generation: 0 },
    { ...intent, generation: 0.1 },
  ])('rejects invalid intents', async (value) => {
    await expect(effectJournal(directory()).execute(value, async () => receipt)).rejects.toThrow(
      'invalid-effect-intent',
    );
  });
  it.each([
    { sha256: 'bad', bytes: 7 },
    { ...receipt, bytes: -1 },
    { ...receipt, bytes: 0.1 },
  ])('rejects unverified receipts, including on retry', async (value) => {
    const root = directory();
    const journal = effectJournal(root);
    await expect(journal.execute(intent, async () => value)).rejects.toThrow(
      'invalid-effect-receipt',
    );
    const [key] = fs.readdirSync(root);
    fs.writeFileSync(join(root, `${key!}.receipt`), JSON.stringify(value));
    await expect(journal.execute(intent, async () => receipt)).rejects.toThrow(
      'invalid-effect-receipt',
    );
  });
  it('propagates storage failures before effect and on receipt read', async () => {
    const root = directory();
    const effect = vi.fn(async () => receipt);
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw error;
    });
    await expect(effectJournal(root).execute(intent, effect)).rejects.toThrow('denied');
    expect(effect).not.toHaveBeenCalled();
    await effectJournal(root).execute(intent, effect);
    const read = vi.spyOn(fs, 'readFileSync');
    read.mockImplementationOnce(() =>
      Buffer.from(
        JSON.stringify([1, 'p', 't', 'create-1', intent.requestHash, 'mac', 'main', 'u', 1]),
      ),
    );
    read.mockImplementationOnce(() => {
      throw error;
    });
    await expect(effectJournal(root).execute(intent, effect)).rejects.toThrow('denied');
  });
});
