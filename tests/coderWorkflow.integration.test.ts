import { readFile, writeFile, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coderFixture } from './coderFixtures.js';
import { startCoder, runCoder, integrateCoder, cancelCoder } from '../application/coderWorkflow.js';
import { executionBlockers } from '../core/execution.js';

let f: Awaited<ReturnType<typeof coderFixture>>;
afterEach(async () => {
  await f?.dispose();
});
it('runs in a real independent copy, reserves source paths through stop and integrates only after release', async () => {
  f = await coderFixture();
  const brief = await f.brief();
  await startCoder(brief, f.deps);
  expect((await f.deps.runs.read())!.schema_version).toBe(2);
  expect((await f.deps.runs.read())!.coder_locks).toEqual([
    { id: 'one', workspace: f.root, paths: brief.paths },
  ]);
  let state = await f.deps.journal.read();
  expect(state.schema_version).toBe(2);
  expect(state.format_backup).toBeDefined();
  expect(state.execution!.schema_version).toBe(3);
  expect(executionBlockers(state.execution!)).toContain('coder:one:pending');
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('coder-not-released');
  const run = await runCoder('one', f.deps);
  expect(run.status).toBe('released');
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('source revision 1');
  expect(await readFile(resolve(brief.copy_root, 'source.txt'), 'utf8')).toBe('after:source.txt');
  expect(f.counts).toEqual({ creates: 1, loads: 1, sends: 1, stops: 1 });
  await expect(startCoder(await f.brief('overlap', ['source.txt']), f.deps)).rejects.toThrow(
    'coder-source-overlap',
  );
  expect((await runCoder('one', f.deps)).status).toBe('released');
  const integrated = await integrateCoder('one', f.deps);
  expect(integrated.status).toBe('integrated');
  expect((await integrateCoder('one', f.deps)).receipt).toEqual(integrated.receipt);
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('after:source.txt');
  state = await f.deps.journal.read();
  expect(state.execution!.coder_reservations).toEqual([]);
  expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
  expect(state.coders!.one!.history).toHaveLength(14);
});
it('recovers a partial import with the original operation and no duplicate file write', async () => {
  let fail = true,
    applied = 0;
  f = await coderFixture((boundary) => {
    if (boundary === 'after-step') {
      applied++;
      if (fail) {
        fail = false;
        throw new Error('disk stopped after one file');
      }
    }
  });
  await startCoder(await f.brief(), f.deps);
  await runCoder('one', f.deps);
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('disk stopped after one file');
  const partial = (await f.deps.journal.read()).coders!.one!;
  expect(partial.status).toBe('integrating');
  expect(partial.integration!.operation).toBe('coder:one:integrate');
  await expect(cancelCoder('one', f.deps)).rejects.toThrow('coder-integration-already-started');
  await integrateCoder('one', f.deps);
  expect(applied).toBe(2);
  expect((await f.deps.journal.read()).coders!.one!.integration).toEqual(partial.integration);
});
it('reconstructs a lost final receipt and a lost Store reply without applying files again', async () => {
  let loseReceipt = true,
    writes = 0;
  f = await coderFixture((boundary) => {
    if (boundary === 'after-step') writes++;
    if (boundary === 'before-receipt' && loseReceipt) {
      loseReceipt = false;
      throw new Error('receipt lost');
    }
  });
  await startCoder(await f.brief(), f.deps);
  await runCoder('one', f.deps);
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('receipt lost');
  const intent = (await f.deps.journal.read()).coders!.one!.integration;
  const save = f.deps.journal.save.bind(f.deps.journal);
  let loseReply = true;
  f.deps.journal.save = async (before, next, operation) => {
    await save(before, next, operation);
    if (operation.endsWith(':INTEGRATED') && loseReply) {
      loseReply = false;
      throw new Error('Store reply lost');
    }
  };
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('Store reply lost');
  const completed = await integrateCoder('one', f.deps);
  expect(completed.status).toBe('integrated');
  expect(completed.integration).toEqual(intent);
  expect(writes).toBe(2);
});
it('keeps two disjoint source reservations in separate copies and integrates both independent results', async () => {
  f = await coderFixture();
  const first = await f.brief('first', ['source.txt']),
    second = await f.brief('second', ['second.txt']);
  await startCoder(first, f.deps);
  await startCoder(second, f.deps);
  await runCoder('first', f.deps);
  await runCoder('second', f.deps);
  expect((await f.deps.runs.read())!.coder_locks).toHaveLength(2);
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('source revision 1');
  expect(first.copy_root).not.toBe(second.copy_root);
  await integrateCoder('first', f.deps);
  await integrateCoder('second', f.deps);
  expect(await readFile(resolve(f.root, 'second.txt'), 'utf8')).toBe('after:second.txt');
  expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
});
it('preserves a foreign conflict after a partial write and holds the source reservation', async () => {
  f = await coderFixture((boundary) => {
    if (boundary === 'after-step') throw new Error('one file only');
  });
  await startCoder(await f.brief(), f.deps);
  await runCoder('one', f.deps);
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('one file only');
  await writeFile(resolve(f.root, 'source.txt'), 'foreign edit');
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('coder-source-conflict');
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('foreign edit');
  expect((await f.deps.runs.read())!.coder_locks).toHaveLength(1);
});
it('rejects an out-of-scope copy edit, symlink and changed source before import', async () => {
  f = await coderFixture();
  await startCoder(await f.brief(), f.deps);
  const result = f.deps.sessions.result;
  f.deps.sessions.result = async (run) => {
    const value = await result(run);
    await writeFile(resolve(run.brief.copy_root, 'outside.txt'), 'unauthorized');
    return value;
  };
  await runCoder('one', f.deps);
  await expect(integrateCoder('one', f.deps)).rejects.toThrow('coder-change-outside-scope');
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('source revision 1');
  await cancelCoder('one', f.deps);
  const second = await f.brief('two', ['source.txt']);
  await startCoder(second, f.deps);
  f.deps.sessions.result = result;
  await runCoder('two', f.deps);
  await writeFile(resolve(f.root, 'source.txt'), 'foreign source');
  await expect(integrateCoder('two', f.deps)).rejects.toThrow('coder-source-conflict');
  await cancelCoder('two', f.deps);
  const third = await f.brief('three', ['source.txt']);
  await startCoder(third, f.deps);
  await runCoder('three', f.deps);
  await symlink(resolve(f.root, 'source.txt'), resolve(third.copy_root, 'alias'));
  await expect(integrateCoder('three', f.deps)).rejects.toThrow('coder-copy-after-stop');
});
it('keeps unknown create/send under the original identity and never repeats a native effect', async () => {
  f = await coderFixture();
  await startCoder(await f.brief(), f.deps);
  let created: Awaited<ReturnType<typeof f.session>> | null = null;
  f.deps.sessions.create = async (run) => {
    f.counts.creates++;
    created = await f.session(run);
    throw new Error('lost creation reply');
  };
  await expect(runCoder('one', f.deps)).rejects.toThrow('lost creation reply');
  await expect(runCoder('one', f.deps)).rejects.toThrow('coder-create-outcome-unknown');
  expect(f.counts.creates).toBe(1);
  f.deps.sessions.recoverCreate = async () =>
    created === null ? null : { outcome: 'created', session: created };
  f.deps.sessions.send = async () => {
    f.counts.sends++;
    throw new Error('lost send reply');
  };
  await expect(runCoder('one', f.deps)).rejects.toThrow('lost send reply');
  f.deps.sessions.send = async (_run, fresh) => {
    expect(fresh).toBe(false);
    return 'original-turn';
  };
  const completed = await runCoder('one', f.deps);
  expect(completed.session!.id).toBe('native-one');
  expect(completed.turn).toBe('original-turn');
  expect(f.counts.creates).toBe(1);
  expect(f.counts.sends).toBe(1);
});
it('settles a confirmed refusal without a session and cancels an idle reservation without native creation', async () => {
  f = await coderFixture();
  await startCoder(await f.brief(), f.deps);
  f.deps.sessions.create = async () => ({
    outcome: 'not-started',
    receipt: await f.artifact('refusal', { kind: 'fixture-refusal' }),
  });
  const refused = await runCoder('one', f.deps);
  expect(refused.status).toBe('not-started');
  expect(refused.session).toBeNull();
  expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
  await startCoder(await f.brief('two'), f.deps);
  expect((await cancelCoder('two', f.deps)).status).toBe('cancelled');
  expect((await cancelCoder('two', f.deps)).status).toBe('cancelled');
  expect(f.counts.creates).toBe(0);
});

it.each(['unknown', 'not-started', 'created'] as const)(
  'cancels only a reconciled original create: %s',
  async (outcome) => {
    f = await coderFixture();
    await startCoder(await f.brief(), f.deps);
    let original: Awaited<ReturnType<typeof f.session>> | null = null;
    f.deps.sessions.create = async (run) => {
      original = await f.session(run);
      throw Error('creation reply lost');
    };
    await expect(runCoder('one', f.deps)).rejects.toThrow('creation reply lost');
    const receipt = await f.artifact('confirmed-refusal', { fixture: true });
    f.deps.sessions.recoverCreate = async () =>
      outcome === 'unknown'
        ? null
        : outcome === 'not-started'
          ? { outcome, receipt }
          : { outcome, session: original! };
    if (outcome === 'unknown') {
      await expect(cancelCoder('one', f.deps)).rejects.toThrow('coder-create-outcome-unknown');
      expect((await f.deps.runs.read())!.coder_locks).toHaveLength(1);
    } else {
      expect((await cancelCoder('one', f.deps)).status).toBe(
        outcome === 'not-started' ? 'not-started' : 'cancelled',
      );
      expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
      expect(f.counts.stops).toBe(outcome === 'created' ? 1 : 0);
    }
  },
);
it.each(['STOP_INTENT', 'STOPPED'] as const)(
  'cancels after a lost %s acknowledgement without repeating a confirmed stop',
  async (boundary) => {
    f = await coderFixture();
    await startCoder(await f.brief(), f.deps);
    const save = f.deps.journal.save.bind(f.deps.journal);
    let fail = true;
    f.deps.journal.save = async (...args) => {
      const result = await save(...args);
      if (fail && args[2] === 'coder:one:' + boundary) {
        fail = false;
        throw Error('acknowledgement lost');
      }
      return result;
    };
    await expect(runCoder('one', f.deps)).rejects.toThrow('acknowledgement lost');
    const done = await cancelCoder('one', f.deps);
    expect(done.status).toBe('cancelled');
    expect(f.counts.stops).toBe(1);
    expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
  },
);
it.each([1, 3])(
  'settles concurrent duplicate cancellation after parent-read boundary %s exactly once',
  async (boundary) => {
    f = await coderFixture();
    await startCoder(await f.brief(), f.deps);
    await runCoder('one', f.deps);
    const read = f.deps.runs.read.bind(f.deps.runs);
    let calls = 0,
      entered!: () => void,
      release!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.deps.runs.read = async () => {
      const parent = await read();
      if (++calls === boundary) {
        entered();
        await resumed;
      }
      return parent;
    };
    const original = cancelCoder('one', f.deps);
    await paused;
    const duplicate = await cancelCoder('one', f.deps);
    release();
    expect(await original).toEqual(duplicate);
    expect(duplicate.status).toBe('cancelled');
    expect(duplicate.history.filter((event) => event.id === 'one:CANCEL_IDLE')).toHaveLength(1);
    expect((await read())!.coder_locks).toEqual([]);
    expect(f.counts.stops).toBe(1);
  },
);
