import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AppServerWriters } from '../adapters/codex/appServerWriters.js';
import type { OwnedWriter } from '../adapters/codex/appServerWriters.js';
import { AppServerRelaySessions } from '../adapters/codex/appServerRelaySessions.js';
import { relayFixture } from './relayFixtures.js';
import type { WriterProcesses } from '../ports/writerProcesses.js';
let root: string;
let marker: string;
let owned: OwnedWriter;
let lists: unknown[];
let reads: unknown[];
let requests: string[];
let loaded: unknown;
const processes = {
  descendants: vi.fn(),
  alive: vi.fn(),
  terminate: vi.fn<WriterProcesses['terminate']>(),
  wait: vi.fn(),
};
const rpc = {
  completed: async () => {},
  request: async (method: string) => {
    requests.push(method);
    if (method === 'thread/loaded/list') return loaded;
    if (method === 'thread/backgroundTerminals/list') return lists.shift();
    if (method === 'thread/read') return reads.shift();
    return {};
  },
};
const inactive = { thread: { id: 'thread', turns: [{ id: 'turn', status: 'interrupted' }] } };
const terminal = { processId: 'process', osPid: 100 };
beforeEach(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'aw8-writers-'));
  marker = resolve(root, 'marker');
  await writeFile(marker, 'fixed');
  owned = {
    thread: 'thread',
    turn: 'turn',
    complete: true,
    terminals: [{ process: 'process', pid: 100 }],
    markers: [marker],
  };
  lists = [{ data: [terminal], nextCursor: null }, { data: [terminal] }, { data: [] }];
  reads = [{ thread: { id: 'thread', turns: [{ id: 'turn', status: 'inProgress' }] } }, inactive];
  requests = [];
  loaded = { data: ['thread'], nextCursor: null };
  processes.descendants.mockResolvedValue([
    { pid: 100, parent: 1, started: 't' },
    { pid: 101, parent: 100, started: 't' },
  ]);
  processes.alive.mockResolvedValue([]);
  processes.terminate.mockImplementation(async (identities) => identities);
  processes.wait.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.resetAllMocks();
  await rm(root, { recursive: true, force: true });
});
const stop = () => new AppServerWriters(rpc, processes).stop(owned, resolve(root, 'receipt.json'));

it('requires the owning runtime before inspecting or stopping writers, without resume or fallback', async () => {
  for (const data of [null, ['foreign'], [], [1]]) {
    loaded = { data, nextCursor: null };
    requests = [];
    await expect(stop()).rejects.toThrow(
      data === null || data[0] === 1 ? 'writer-runtime-list-incomplete' : 'writer-runtime-unbound',
    );
    expect(requests).toEqual(['thread/loaded/list']);
    expect(processes.descendants).not.toHaveBeenCalled();
    expect(processes.terminate).not.toHaveBeenCalled();
    await expect(readFile(resolve(root, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  loaded = { data: ['thread'], nextCursor: 'more' };
  await expect(stop()).rejects.toThrow('writer-runtime-list-incomplete');
  loaded = { data: ['thread'] };
  await stop();
});

it('interrupts, terminates only known terminals/descendants, and confirms a stable marker', async () => {
  processes.alive.mockResolvedValueOnce([{ pid: 101 }]);
  const proof = await stop();
  expect(JSON.parse(await readFile(proof.locator, 'utf8'))).toMatchObject({
    kind: 'writers-stopped',
    remaining_processes: 0,
    remaining_terminals: 0,
    observation_ms: 250,
  });
  expect(proof.hash).toHaveLength(64);
  expect(requests.filter((m) => m === 'turn/interrupt')).toHaveLength(1);
  expect(processes.terminate).toHaveBeenCalledWith([
    { pid: 100, parent: 1, started: 't' },
    { pid: 101, parent: 100, started: 't' },
  ]);
  expect(processes.wait).toHaveBeenCalledWith(50);
});
it('handles an already idle predecessor without manufacturing a termination', async () => {
  owned.terminals = [];
  lists = [{ data: [] }, { data: [] }, { data: [] }];
  reads = [inactive, inactive];
  processes.descendants.mockResolvedValue([]);
  await stop();
  expect(requests).not.toContain('turn/interrupt');
  expect(requests).not.toContain('thread/backgroundTerminals/terminate');
});
it('refuses a vanished root or failed process stop before interrupt and never writes a receipt', async () => {
  processes.descendants.mockResolvedValueOnce([]);
  await expect(stop()).rejects.toThrow('writer-process-identity-lost');
  lists = [{ data: [terminal] }];
  processes.terminate.mockRejectedValueOnce(new Error('writer-process-stop-unconfirmed'));
  await expect(stop()).rejects.toThrow('writer-process-stop-unconfirmed');
  expect(requests).not.toContain('turn/interrupt');
  await expect(readFile(resolve(root, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses incomplete/foreign observations and any late writes', async () => {
  const scenarios: [string, () => void][] = [
    [
      'writer-scope-incomplete',
      () => {
        owned.complete = false;
      },
    ],
    [
      'writer-scope-incomplete',
      () => {
        owned.markers = [];
      },
    ],
    [
      'writer-list-incomplete',
      () => {
        lists[0] = { data: null };
      },
    ],
    [
      'writer-list-incomplete',
      () => {
        lists[0] = { data: [], nextCursor: 'more' };
      },
    ],
    [
      'unknown-writer',
      () => {
        lists[0] = { data: [{ processId: 'foreign', osPid: 100 }] };
      },
    ],
    [
      'unknown-writer',
      () => {
        lists[0] = { data: [{ processId: 'process', osPid: 999 }] };
      },
    ],
    [
      'writer-thread-unconfirmed',
      () => {
        reads[0] = { thread: { id: 'foreign', turns: [] } };
      },
    ],
    [
      'writer-thread-unconfirmed',
      () => {
        reads[0] = { thread: { id: 'thread', turns: null } };
      },
    ],
    [
      'unknown-active-turn',
      () => {
        reads[0] = { thread: { id: 'thread', turns: [{ id: 'other', status: 'inProgress' }] } };
      },
    ],
    [
      'unknown-late-writer',
      () => {
        lists[1] = { data: [{ processId: 'foreign' }] };
      },
    ],
    [
      'writer-thread-unconfirmed',
      () => {
        reads[1] = { thread: { id: 'other' } };
      },
    ],
    [
      'writer-thread-unconfirmed',
      () => {
        reads[1] = { thread: { id: 'thread', turns: null } };
      },
    ],
    [
      'writers-still-active',
      () => {
        processes.alive.mockResolvedValue([{ pid: 100 }]);
      },
    ],
    [
      'writers-still-active',
      () => {
        lists[2] = { data: [terminal] };
      },
    ],
    [
      'writers-still-active',
      () => {
        reads[1] = { thread: { id: 'thread', turns: [{ status: 'inProgress' }] } };
      },
    ],
    [
      'late-writer-detected',
      () => {
        processes.wait.mockImplementation(async (ms: number) => {
          if (ms === 250) await writeFile(marker, 'late');
        });
      },
    ],
    [
      'late-writer-detected',
      () => {
        processes.alive
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ pid: 100 }]);
      },
    ],
  ];
  for (const [reason, setup] of scenarios) {
    owned = {
      thread: 'thread',
      turn: 'turn',
      complete: true,
      terminals: [{ process: 'process', pid: 100 }],
      markers: [marker],
    };
    lists = [{ data: [terminal] }, { data: [terminal] }, { data: [] }];
    reads = [inactive, inactive];
    processes.alive.mockReset().mockResolvedValue([]);
    processes.wait.mockReset().mockResolvedValue(undefined);
    await writeFile(marker, 'fixed');
    setup();
    await expect(stop(), reason).rejects.toThrow(reason);
  }
});
it('creates fresh native successors with the declared sandbox and retains primary identity metadata', async () => {
  const f = await relayFixture();
  try {
    const request = vi.fn(async () => ({
      thread: { id: 'new', projectId: 'native', turns: [], forkedFromId: null },
      sandbox: { type: 'workspaceWrite', networkAccess: false },
      cwd: f.root,
      model: 'model',
      reasoningEffort: 'high',
    }));
    const adapter = new AppServerRelaySessions({ request, completed: async () => {} }, root);
    const first = await adapter.create(f.seed);
    expect(first.read_only).toBe(false);
    expect(first.initial_turns).toBe(0);
    expect(request).toHaveBeenLastCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'workspace-write',
        ephemeral: false,
        projectId: 'native',
      }),
    );
    f.seed.predecessor.spec.requested.permissions = ['read', 'coordinate'];
    request.mockResolvedValue({
      thread: { id: 'reader', projectId: 'native', turns: [], forkedFromId: null },
      sandbox: { type: 'readOnly', networkAccess: false },
      cwd: f.root,
      model: 'model',
      reasoningEffort: 'high',
    });
    expect((await adapter.create(f.seed)).read_only).toBe(true);
    expect(request).toHaveBeenLastCalledWith(
      'thread/start',
      expect.objectContaining({ sandbox: 'read-only' }),
    );
    request.mockResolvedValue({
      thread: { id: '../escape', projectId: 'native', turns: [], forkedFromId: null },
      sandbox: { type: 'readOnly', networkAccess: false },
      cwd: f.root,
      model: 'model',
      reasoningEffort: 'high',
    });
    await expect(adapter.create(f.seed)).rejects.toThrow('invalid-relay-session');
    request.mockResolvedValue({
      thread: { id: 'unknown', projectId: 'native', turns: null, forkedFromId: null },
      sandbox: { type: 'readOnly', networkAccess: false },
      cwd: f.root,
      model: 'model',
      reasoningEffort: 'high',
    } as unknown as Awaited<ReturnType<typeof request>>);
    await expect(adapter.create(f.seed)).rejects.toThrow('invalid-relay-session');
    request.mockResolvedValue({
      thread: { id: 'fork', projectId: 'native', turns: [], forkedFromId: 'parent' },
      sandbox: { type: 'readOnly', networkAccess: true },
      cwd: f.root,
      model: 'model',
      reasoningEffort: 'high',
    } as unknown as Awaited<ReturnType<typeof request>>);
    expect((await adapter.create(f.seed)).forked_from).toBe('parent');
  } finally {
    await f.dispose();
  }
});

it('requires a durable OS binding when the native terminal omits its PID', async () => {
  owned.terminals = [{ process: 'process', pid: null }];
  const t = { processId: 'process', osPid: null };
  lists = [{ data: [t] }];
  await expect(stop()).rejects.toThrow('writer-process-binding-missing');
  const identities = [{ pid: 100, parent: 1, started: 'start' }];
  const good = {
    kind: 'process-binding',
    thread: 'thread',
    terminal: 'process',
    scope_complete: true,
    processes: identities,
  };
  const path = resolve(root, 'binding.json');
  const { createHash } = await import('node:crypto');
  const set = async (value: unknown) => {
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes);
    owned.bindings = [
      {
        terminal: 'process',
        processes: identities,
        evidence: { locator: path, hash: createHash('sha256').update(bytes).digest('hex') },
      },
    ];
    lists = [{ data: [t] }, { data: [t] }, { data: [] }];
    reads = [inactive, inactive];
  };
  await set(good);
  owned.bindings![0]!.terminal = 'other';
  await expect(stop()).rejects.toThrow('writer-process-binding-missing');
  await set(good);
  owned.bindings![0]!.processes = [];
  await expect(stop()).rejects.toThrow('writer-process-binding-missing');
  await set(good);
  await writeFile(path, '{}');
  await expect(stop()).rejects.toThrow('writer-process-binding-changed');
  for (const patch of [
    { kind: 'other' },
    { thread: 'other' },
    { terminal: 'other' },
    { scope_complete: false },
    { processes: [] },
  ]) {
    await set({ ...good, ...patch });
    await expect(stop()).rejects.toThrow('writer-process-binding-unconfirmed');
  }
  await set(good);
  await expect(stop()).rejects.toThrow('writer-process-identity-changed');
  await set(good);
  processes.descendants.mockResolvedValue(identities);
  processes.alive.mockResolvedValueOnce(identities).mockResolvedValue([]);
  const receipt = await stop();
  expect(receipt.hash).toHaveLength(64);
});
