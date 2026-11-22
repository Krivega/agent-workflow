import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { FSWatcher, PathLike, WatchListener } from 'node:fs';
import type * as NativeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { saveManaged } from '../adapters/storage/managedChatFiles.js';
import {
  saveCouncilProgress,
  waitCouncilProgress,
  type CouncilProgress,
} from '../cli/councilProgress.js';

let directory: string;
const events = vi.hoisted(() => ({
  watcher: null as FSWatcher | null,
  subscribed: vi.fn(),
  lost: false,
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NativeFs>();
  return {
    ...fs,
    watch: (path: PathLike, listener: WatchListener<string>) => {
      const watcher = fs.watch(path, (...args) => {
        if (!events.lost) listener(...args);
      });
      events.watcher = watcher;
      events.subscribed();
      return watcher;
    },
  };
});
const progress = (): CouncilProgress => ({
  schema_version: 1,
  run_id: 'run',
  phase: 'planning',
  scope: 'scope',
  target_hash: 'hash',
  status: 'running',
  roles: { architect: { status: 'pending' } },
});
beforeEach(async () => {
  directory = await mkdtemp(resolve(await realpath(tmpdir()), 'council-progress-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  events.subscribed.mockReset();
  events.lost = false;
  vi.useRealTimers();
});

it('returns a compact current snapshot and a stable cursor for identical state', async () => {
  const first = saveCouncilProgress(directory, progress());
  expect(saveCouncilProgress(directory, progress()).cursor).toBe(first.cursor);
  expect(await waitCouncilProgress(directory, null, 0)).toEqual({
    changed: true,
    timed_out: false,
    snapshot: first,
  });
  expect((await waitCouncilProgress(directory, first.cursor, 0)).changed).toBe(false);
  expect((await waitCouncilProgress(directory, null, 60_000)).snapshot).toEqual(first);
});

it('waits through unrelated file changes and wakes on atomic replacement of progress', async () => {
  const first = saveCouncilProgress(directory, progress());
  let completed = false;
  const waiting = waitCouncilProgress(directory, first.cursor, 1000).then((result) => {
    completed = true;
    return result;
  });
  await writeFile(resolve(directory, 'other.json'), 'unrelated');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(completed).toBe(false);
  const next = saveCouncilProgress(directory, {
    ...progress(),
    roles: { architect: { status: 'accepted', verdict: 'PASS' } },
  });
  expect(await waiting).toEqual({ changed: true, timed_out: false, snapshot: next });
});

it('observes an update between subscriptions and does not wait on terminal state', async () => {
  const first = saveCouncilProgress(directory, progress());
  const last = saveCouncilProgress(directory, { ...progress(), status: 'completed' });
  expect((await waitCouncilProgress(directory, first.cursor, 1000)).changed).toBe(true);
  expect(await waitCouncilProgress(directory, last.cursor, 60_000)).toEqual({
    changed: false,
    timed_out: false,
    snapshot: last,
  });
});
it('catches a replacement immediately after subscription and closes on watcher errors', async () => {
  const first = saveCouncilProgress(directory, progress());
  events.subscribed.mockImplementationOnce(() => {
    saveCouncilProgress(directory, {
      ...progress(),
      roles: { architect: { status: 'reviewing' } },
    });
  });
  const updated = await waitCouncilProgress(directory, first.cursor, 1000);
  expect(updated.changed).toBe(true);
  const pending = waitCouncilProgress(directory, updated.snapshot.cursor, 1000);
  events.watcher!.emit('change', 'rename', null);
  events.watcher!.emit('error', new Error('watch failed'));
  await expect(pending).rejects.toThrow('watch failed');
});

it('returns a bounded timeout without changing the snapshot', async () => {
  const first = saveCouncilProgress(directory, progress());
  expect(await waitCouncilProgress(directory, first.cursor, 15)).toEqual({
    changed: false,
    timed_out: true,
    snapshot: first,
  });
});

it('waits for a terminal result through log changes, duplicate events and lost delivery', async () => {
  vi.useFakeTimers();
  const first = saveCouncilProgress(directory, progress());
  let finished = false;
  const waiting = waitCouncilProgress(directory, first.cursor, 5000, { until: 'settled' }).then(
    (result) => {
      finished = true;
      return result;
    },
  );
  saveCouncilProgress(directory, { ...progress(), roles: { architect: { status: 'reviewing' } } });
  events.watcher!.emit('change', 'rename', 'progress.json');
  events.watcher!.emit('change', 'rename', 'progress.json');
  await vi.advanceTimersByTimeAsync(1000);
  expect(finished).toBe(false);
  events.lost = true;
  const last = saveCouncilProgress(directory, { ...progress(), status: 'completed' });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await waiting).snapshot).toEqual(last);
});

it('refuses a different operation during a settled wait and preserves the old snapshot', async () => {
  const first = saveCouncilProgress(directory, progress());
  const rejected = expect(
    waitCouncilProgress(directory, first.cursor, 1000, { until: 'settled' }),
  ).rejects.toThrow('council-wait-target-changed');
  saveCouncilProgress(directory, { ...progress(), target_hash: 'new-revision' });
  await rejected;
});

it.each(['changed', 'settled'] as const)(
  'distinguishes the %s deadline after intermediate progress without a terminal result',
  async (until) => {
    vi.useFakeTimers();
    events.lost = true;
    const first = saveCouncilProgress(directory, progress());
    const waiting = waitCouncilProgress(directory, first.cursor, 1000, { until });
    const next = saveCouncilProgress(directory, {
      ...progress(),
      roles: { architect: { status: 'reviewing' } },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toEqual({
      changed: true,
      timed_out: until === 'settled',
      snapshot: next,
    });
  },
);

it('cancels a wait before or during subscription and ignores late notifications', async () => {
  const first = saveCouncilProgress(directory, progress());
  const controller = new AbortController();
  const rejected = expect(
    waitCouncilProgress(directory, first.cursor, 1000, { signal: controller.signal }),
  ).rejects.toThrow('council-wait-cancelled');
  controller.abort();
  await rejected;
  events.watcher!.emit('change', 'rename', 'progress.json');
  await expect(
    waitCouncilProgress(directory, first.cursor, 1000, { signal: controller.signal }),
  ).rejects.toThrow('council-wait-cancelled');
  await expect(
    waitCouncilProgress(directory, first.cursor, 0, { until: 'other' as 'settled' }),
  ).rejects.toThrow('invalid-council-wait-mode');
});

it.each([-1, 60_001, 0.5, NaN])('rejects an invalid wait duration %s', async (timeout) => {
  await expect(waitCouncilProgress(directory, null, timeout)).rejects.toThrow(
    'invalid-council-wait-timeout',
  );
});

it('fails closed on missing, malformed or altered snapshots and removes the watcher', async () => {
  await expect(waitCouncilProgress(directory, null, 1000)).rejects.toThrow(
    'council-progress-missing',
  );
  await writeFile(resolve(directory, 'progress.json'), '{}');
  await expect(waitCouncilProgress(directory, null, 0)).rejects.toThrow('invalid-council-progress');
  const first = saveCouncilProgress(directory, progress());
  const rejected = expect(waitCouncilProgress(directory, first.cursor, 1000)).rejects.toThrow(
    'invalid-council-progress',
  );
  saveManaged(resolve(directory, 'progress.json'), { ...first, scope: 'tampered' }, false);
  await rejected;
});

it('rejects an exposed truncated snapshot and closes its subscription', async () => {
  const first = saveCouncilProgress(directory, progress());
  const rejected = expect(waitCouncilProgress(directory, first.cursor, 1000)).rejects.toThrow(
    'corrupt',
  );
  const watcher = events.watcher!;
  const closed = new Promise<void>((resolve) => watcher.once('close', resolve));
  await writeFile(resolve(directory, 'progress.json'), '');
  watcher.emit('change', 'change', 'progress.json');
  await rejected;
  await closed;
});
