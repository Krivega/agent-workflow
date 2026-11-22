import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  realpathSync,
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { StdioAppServer } from '../adapters/codex/appServerTransport.js';
import { AppServerWaits } from '../adapters/codex/appServerWaits.js';
import { TransportJournal } from '../adapters/codex/transportJournal.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', async (load) => ({ ...(await load<typeof fs>()) }));
let child: EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
};
let dir: string;
let rpc: StdioAppServer;
let requests: Record<string, unknown>[];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'aw5-rpc-')));
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    pid: 71,
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  requests = [];
  child.stdin.on('data', (bytes: Buffer) => {
    requests.push(JSON.parse(bytes.toString()) as Record<string, unknown>);
  });
  rpc = new StdioAppServer('test-server', ['--stdio'], dir, resolve(dir, 'rpc.jsonl'));
});
afterEach(() => {
  child.emit('exit', 0);
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});
const receive = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n');

it('forces a surviving owned transport to stop after EOF and TERM have not ended it', async () => {
  vi.useFakeTimers();
  rpc.close();
  expect(child.stdin.writableEnded).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
});

it('checks task authority while waiting and again before accepting a completion', async () => {
  vi.useFakeTimers();
  let revoked = false;
  const verify = vi.fn(async () => {
    if (revoked) throw new Error('revoked');
  });
  const waiting = rpc.completed('thread', 'turn', undefined, verify);
  const rejected = expect(waiting).rejects.toThrow('revoked');
  await vi.advanceTimersByTimeAsync(1000);
  revoked = true;
  receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } });
  await rejected;
  await expect(rpc.completed('thread', 'turn', undefined, verify)).rejects.toThrow('revoked');
});

it('wakes on revoked authority even without a native completion', async () => {
  vi.useFakeTimers();
  const verify = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(new Error('new requirements'));
  const waiting = rpc.completed('thread', 'turn', undefined, verify);
  const rejected = expect(waiting).rejects.toThrow('new requirements');
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(requests).toEqual([]);
});
it('does not read native history after cancellation during a pending authority check', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let release!: () => void;
  const verify = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
  const waiting = rpc.completed('thread', 'turn', controller.signal, verify);
  const cancelled = expect(waiting).rejects.toThrow('app-server-wait-cancelled');
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  await cancelled;
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toEqual([]);
});
it.each(['closed', 'aborted'])(
  'refuses %s transport while the initial authority check was pending',
  async (kind) => {
    const controller = new AbortController();
    await expect(
      rpc.completed('thread', 'turn', controller.signal, async () => {
        if (kind === 'closed') rpc.close();
        else controller.abort();
      }),
    ).rejects.toThrow(kind === 'closed' ? 'app-server-closed' : 'app-server-wait-cancelled');
  },
);

it('does not send a request when durable journaling fails and closes pending work', async () => {
  vi.spyOn(TransportJournal.prototype, 'write').mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  await expect(rpc.request('turn/start', {})).rejects.toThrow('storage unavailable');
  expect(requests).toEqual([]);
  expect(() => rpc.request('later', {})).toThrow('app-server-closed');
});

it('performs the handshake, correlates responses, refuses approval requests and awaits completion without polling', async () => {
  expect(rpc.pid).toBe(child.pid);
  const initialized = rpc.initialize();
  receive({ id: 1, result: {} });
  await initialized;
  expect(requests[1]).toEqual({ method: 'initialized', params: {} });
  const request = rpc.request('read', { id: 'x' });
  receive({ id: 2, result: { value: 1 } });
  expect(await request).toEqual({ value: 1 });
  receive({ id: 999, result: {} });
  receive({ method: 'ignored' });
  receive({ id: 'approval', method: 'item/permissions/requestApproval', params: {} });
  expect(requests.at(-1)).toMatchObject({ id: 'approval', error: { code: -32601 } });
  const waits = [rpc.completed('thread', 'turn'), rpc.completed('thread', 'turn')];
  receive({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
  });
  await Promise.all(waits);
  await rpc.completed('thread', 'turn');
  receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'other' } } });
  child.stderr.write('diagnostic only');
  rpc.close();
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
});

it('closes the owned input once, fails pending work and falls back only if the server does not exit', async () => {
  vi.useFakeTimers();
  const pending = rpc.request('pending', {}),
    waiting = rpc.completed('thread', 'turn');
  const rejected = [
    expect(pending).rejects.toThrow('app-server-closed'),
    expect(waiting).rejects.toThrow('app-server-closed'),
  ];
  rpc.close();
  rpc.close();
  await Promise.all(rejected);
  expect(child.stdin.writableEnded).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
});

it('does not signal a server that cleanly exited after EOF', async () => {
  vi.useFakeTimers();
  rpc.close();
  child.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(child.kill).not.toHaveBeenCalled();
});

it('preserves protocol errors and unknown outcomes instead of treating them as success', async () => {
  const bad = rpc.request('bad', {});
  const badAssertion = expect(bad).rejects.toThrow('app-server-error');
  receive({ id: 1, error: { code: -32600 } });
  await badAssertion;
  vi.useFakeTimers();
  const pending = rpc.request('uncertain', {});
  const assertion = expect(pending).rejects.toThrow('app-server-outcome-unknown');
  await vi.advanceTimersByTimeAsync(60_000);
  await assertion;
  receive({ id: 2, result: 'late' });
});

it('rejects pending work on malformed output, process error or exit and never reuses a closed connection', async () => {
  const pending = rpc.request('pending', {});
  const awaited = rpc.completed('thread', 'turn');
  const assertions = [
    expect(pending).rejects.toThrow('invalid-app-server-message'),
    expect(awaited).rejects.toThrow('invalid-app-server-message'),
  ];
  child.stdout.write('not json\n');
  await Promise.all(assertions);
  expect(() => rpc.request('later', {})).toThrow('app-server-closed');
  await expect(rpc.completed('thread', 'later')).rejects.toThrow('app-server-closed');
  child.emit('error', new Error('spawn failed'));
});

it('reports process exit to response and completion waiters', async () => {
  const pending = rpc.request('pending', {});
  const waiting = rpc.completed('thread', 'turn');
  const assertions = [
    expect(pending).rejects.toThrow('app-server-exited'),
    expect(waiting).rejects.toThrow('app-server-exited'),
  ];
  child.emit('exit', 1);
  await Promise.all(assertions);
});

it('treats a broken stdin pipe as a transport failure', async () => {
  const request = rpc.request('pending', {});
  const assertion = expect(request).rejects.toThrow('broken pipe');
  child.stdin.emit('error', new Error('broken pipe'));
  await assertion;
});

it('delivers recorded native notifications and supports stopping an observer', () => {
  const seen: unknown[] = [];
  const stop = rpc.observe((message) => {
    seen.push(message);
  });
  receive({ method: 'item/completed', params: { item: { type: 'contextCompaction' } } });
  stop();
  receive({ method: 'ignored' });
  expect(seen).toEqual([
    { method: 'item/completed', params: { item: { type: 'contextCompaction' } } },
  ]);
});

it('recovers a missing completion notification from primary history without restarting a turn', async () => {
  vi.useFakeTimers();
  let settled = false;
  const waiting = rpc.completed('thread', 'turn').then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(1000);
  const first = requests.at(-1)!;
  expect(first).toMatchObject({
    method: 'thread/read',
    params: { threadId: 'thread', includeTurns: true },
  });
  receive({
    id: first.id,
    result: {
      thread: {
        id: 'thread',
        turns: [{ id: 'turn', status: 'inProgress' }],
      },
    },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).toBe(false);
  receive({
    id: requests.at(-1)!.id,
    result: {
      thread: {
        id: 'thread',
        turns: [{ id: 'turn', status: 'completed' }],
      },
    },
  });
  await waiting;
  expect(requests.every((request) => request.method === 'thread/read')).toBe(true);
  const count = requests.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(requests).toHaveLength(count);
});

it('cancels one subscriber without cancelling another or accepting a late completion', async () => {
  vi.useFakeTimers();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(rpc.completed('thread', 'turn', cancelled.signal)).rejects.toThrow(
    'app-server-wait-cancelled',
  );
  const controller = new AbortController();
  const first = rpc.completed('thread', 'turn', controller.signal);
  const rejected = expect(first).rejects.toThrow('app-server-wait-cancelled');
  const second = rpc.completed('thread', 'turn');
  controller.abort();
  await rejected;
  receive({ method: 'turn/completed', params: { threadId: 'other', turn: { id: 'turn' } } });
  receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } });
  receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } });
  await second;
  await vi.advanceTimersByTimeAsync(2000);
  expect(requests).toEqual([]);
});

it.each([
  [{ id: 'other', turns: [] }, 'app-server-thread-unconfirmed'],
  [{ id: 'thread', turns: [] }, 'app-server-turn-unconfirmed'],
  [{ id: 'thread', turns: [{ id: 'turn' }, { id: 'turn' }] }, 'app-server-turn-unconfirmed'],
  [{ id: 'thread', turns: [{ id: 'turn', status: 'unknown' }] }, 'app-server-turn-unconfirmed'],
] as const)('refuses an unconfirmed primary history %j', async (thread, error) => {
  vi.useFakeTimers();
  const rejected = expect(rpc.completed('thread', 'turn')).rejects.toThrow(error);
  await vi.advanceTimersByTimeAsync(1000);
  receive({ id: requests.at(-1)!.id, result: { thread } });
  await rejected;
});

it.each(['failed', 'interrupted'])(
  'returns terminal %s for the caller to verify rather than repeating it',
  async (status) => {
    vi.useFakeTimers();
    const waiting = rpc.completed('thread', 'turn');
    await vi.advanceTimersByTimeAsync(1000);
    receive({
      id: requests.at(-1)!.id,
      result: {
        thread: {
          id: 'thread',
          turns: [{ id: 'turn', status }],
        },
      },
    });
    await waiting;
    await rpc.completed('thread', 'turn');
    expect(requests).toHaveLength(1);
  },
);

it.each(['notification', 'cancel', 'error', 'late-error'] as const)(
  'reconciles a pending history read with %s',
  async (outcome) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = rpc.completed('thread', 'turn', controller.signal);
    const assertion =
      outcome === 'notification' || outcome === 'late-error'
        ? expect(waiting).resolves.toBeUndefined()
        : expect(waiting).rejects.toThrow(
            outcome === 'cancel' ? 'app-server-wait-cancelled' : 'app-server-error',
          );
    await vi.advanceTimersByTimeAsync(1000);
    if (outcome === 'cancel') controller.abort();
    if (outcome === 'notification' || outcome === 'late-error')
      receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } });
    receive(
      outcome === 'error' || outcome === 'late-error'
        ? { id: requests.at(-1)!.id, error: { code: -1 } }
        : { id: requests.at(-1)!.id, result: {} },
    );
    await assertion;
    await vi.advanceTimersByTimeAsync(2000);
    expect(requests).toHaveLength(1);
  },
);

it('records metadata without persisting large responses or changing RPC results', async () => {
  const data = { source: 'source'.repeat(20000) };
  const first = rpc.request('read', {});
  receive({ id: 1, result: data });
  expect(await first).toEqual(data);
  const second = rpc.request('read', {});
  receive({ id: 2, result: data });
  expect(await second).toEqual(data);
  const journal = readFileSync(resolve(dir, 'rpc.jsonl.diagnostics.json'), 'utf8');
  expect(journal.length).toBeLessThan(3000);
  expect(journal).not.toContain(data.source);
  expect(existsSync(resolve(dir, 'shared-json'))).toBe(false);
});

it.each(['send', 'recv', 'stderr'] as const)(
  'stops the owned process and preserves the primary error after %s journal failure',
  async (channel) => {
    vi.useFakeTimers();
    const original = TransportJournal.prototype.write;
    const failure = new Error('journal ENOSPC');
    const spy = vi.spyOn(TransportJournal.prototype, 'write').mockImplementation(function (
      this: TransportJournal,
      direction,
      ...args
    ) {
      if (direction === channel) throw failure;
      original.call(this, direction, ...args);
    });
    try {
      const result = rpc.request('probe', {});
      const rejected = expect(result).rejects.toBe(failure);
      if (channel === 'recv') expect(() => receive({ id: 1, result: {} })).not.toThrow();
      if (channel === 'stderr') expect(() => child.stderr.write('disk failure')).not.toThrow();
      await rejected;
      expect(child.stdin.writableEnded).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(() => rpc.request('another', {})).toThrow('app-server-closed');
      expect(() => {
        child.stderr.write('late stderr');
        receive({ id: 1, result: 'late' });
        rpc.close();
      }).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  },
);
it('normalizes a non-Error journal failure and refuses further sends', async () => {
  const spy = vi.spyOn(TransportJournal.prototype, 'write').mockImplementationOnce(() => {
    throw 'unavailable';
  });
  try {
    await expect(rpc.request('probe', {})).rejects.toThrow('app-server-journal-failed');
    expect(child.stdin.writableEnded).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
it.each(['stdout', 'stderr'] as const)(
  'handles a %s pipe error without an uncaught exception or a live owned transport',
  async (stream) => {
    const pending = rpc.request('probe', {});
    const rejected = expect(pending).rejects.toThrow('pipe unavailable');
    expect(() => child[stream].emit('error', new Error('pipe unavailable'))).not.toThrow();
    await rejected;
    expect(child.stdin.writableEnded).toBe(true);
  },
);

it('uses the same completion owner independently without accepting RPC responses as notifications', async () => {
  const read = vi.fn(async () => ({})),
    waits = new AppServerWaits(read);
  const completed = {
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'turn' } },
  };
  waits.observe({ ...completed, id: 1 });
  waits.observe({ method: 'ignored' });
  let settled = false;
  const waiting = waits.completed('thread', 'turn').then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  waits.observe(completed);
  await waiting;
  await waits.completed('thread', 'turn');
  expect(read).not.toHaveBeenCalled();
  waits.close(new Error('closed independently'));
  waits.observe(completed);
  await expect(waits.completed('thread', 'turn')).rejects.toThrow('app-server-closed');
});
it('closes the isolated completion owner once and preserves its original pending error', async () => {
  const read = vi.fn(async () => ({})),
    waits = new AppServerWaits(read),
    failure = new Error('owner transport lost');
  const pending = waits.completed('thread', 'turn'),
    rejected = expect(pending).rejects.toBe(failure);
  waits.close(failure);
  waits.close(new Error('later failure'));
  await rejected;
  expect(read).not.toHaveBeenCalled();
});

it('opt-in raw capture preserves exact lines before parse and observers with private append-only sequence', async () => {
  const path = resolve(dir, 'full.jsonl');
  const captured = new StdioAppServer(
    'test-server',
    ['--stdio'],
    dir,
    resolve(dir, 'captured.rpc.jsonl'),
    undefined,
    path,
  );
  const raw =
    ' { "method" : "turn/completed", "params" : {"threadId":"thread","turn":{"id":"turn"}} } ';
  const seen: unknown[] = [];
  captured.observe(() => {
    seen.push(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as unknown);
  });
  const pending = captured.request('thread/read', { threadId: 'thread', includeTurns: true });
  child.stdout.write(raw + '\n');
  receive({ id: 1, result: { thread: { id: 'thread', turns: [] } } });
  await pending;
  const lines = readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { seq: number; side: string; raw: string });
  expect(lines).toEqual([
    {
      seq: 1,
      side: 'send',
      raw: JSON.stringify({
        id: 1,
        method: 'thread/read',
        params: { threadId: 'thread', includeTurns: true },
      }),
    },
    { seq: 2, side: 'recv', raw },
    {
      seq: 3,
      side: 'recv',
      raw: JSON.stringify({ id: 1, result: { thread: { id: 'thread', turns: [] } } }),
    },
  ]);
  expect(seen).toEqual([lines[1]]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  captured.close();
  const frozen = readFileSync(path, 'utf8');
  receive({ method: 'late' });
  expect(readFileSync(path, 'utf8')).toBe(frozen);
});
it('refuses an existing opt-in capture before spawning and preserves its primary bytes', () => {
  const path = resolve(dir, 'full.jsonl');
  writeFileSync(path, 'original');
  const calls = vi.mocked(spawn).mock.calls.length;
  expect(
    () =>
      new StdioAppServer('test-server', [], dir, resolve(dir, 'fresh.rpc.jsonl'), undefined, path),
  ).toThrow();
  expect(vi.mocked(spawn)).toHaveBeenCalledTimes(calls);
  expect(readFileSync(path, 'utf8')).toBe('original');
});
it('captures malformed incoming bytes before rejecting the owned transport', async () => {
  const path = resolve(dir, 'full.jsonl'),
    captured = new StdioAppServer(
      'test-server',
      [],
      dir,
      resolve(dir, 'captured.rpc.jsonl'),
      undefined,
      path,
    );
  const pending = captured.request('probe', {}),
    rejected = expect(pending).rejects.toThrow('invalid-app-server-message');
  child.stdout.write('not json\n');
  await rejected;
  expect(readFileSync(path, 'utf8')).toContain(
    JSON.stringify({ seq: 2, side: 'recv', raw: 'not json' }) + '\n',
  );
});
it.each(['send', 'recv', 'non-error'] as const)(
  'fails closed before effect or observer on raw capture %s failure',
  async (side) => {
    const path = resolve(dir, 'full.jsonl'),
      captured = new StdioAppServer(
        'test-server',
        [],
        dir,
        resolve(dir, 'captured.rpc.jsonl'),
        undefined,
        path,
      ),
      seen = vi.fn();
    captured.observe(seen);
    const failure = new Error('raw journal full');
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw side === 'non-error' ? 'raw unavailable' : failure;
    });
    try {
      if (side === 'recv') {
        spy.mockRestore();
        const pending = captured.request('probe', {}),
          rejected = expect(pending).rejects.toBe(failure);
        const incoming = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
          throw failure;
        });
        try {
          receive({
            method: 'turn/completed',
            params: { threadId: 'thread', turn: { id: 'turn' } },
          });
          await rejected;
        } finally {
          incoming.mockRestore();
        }
      } else {
        const pending = captured.request('probe', {});
        if (side === 'non-error')
          await expect(pending).rejects.toThrow('app-server-capture-failed');
        else await expect(pending).rejects.toBe(failure);
        expect(requests).toEqual([]);
      }
      expect(seen).not.toHaveBeenCalled();
      expect(child.stdin.writableEnded).toBe(true);
      expect(() => captured.request('later', {})).toThrow('app-server-closed');
    } finally {
      spy.mockRestore();
      captured.close();
    }
  },
);
