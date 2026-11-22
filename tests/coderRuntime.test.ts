import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeCoderRequest } from '../cli/coderRuntime.js';
import { openNativeCoderSessions } from '../cli/nativeCoderSessions.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import type { AppServerRpc, StdioAppServer } from '../adapters/codex/appServerTransport.js';
import { coderFixture } from './coderFixtures.js';
import type { CoderSessions } from '../ports/coder.js';
import type { CoderRun } from '../core/coder.js';
import { startCoder } from '../application/coderWorkflow.js';
import { applyCoder } from '../core/coder.js';
import { refuseCoderCreation } from '../adapters/codex/coderCreation.js';

const native = vi.hoisted(() => ({
  client: null as unknown,
  starts: [] as { binary: string; args: string[]; cwd: string }[],
  names: [] as string[],
  pid: 71 as number | undefined,
  processMissing: false,
  initialize: vi.fn(async () => {}),
  rpc: null as unknown,
  close: vi.fn(),
  stop: vi.fn(async () => {}),
}));
vi.mock('../adapters/codex/appServerTransport.js', () => ({
  StdioAppServer: class {
    pid = native.pid;
    constructor(binary: string, args: string[], cwd: string) {
      native.starts.push({ binary, args, cwd });
    }
    async initialize() {
      await native.initialize();
    }
    async request() {
      return { data: native.names.map((name) => ({ name })), nextCursor: null };
    }
    close() {
      native.close();
    }
  },
}));
vi.mock('../adapters/codex/writerProcesses.js', () => ({
  NativeWriterProcesses: class {
    async descendants(roots: number[]) {
      return native.processMissing
        ? []
        : roots.map((pid) => ({ pid, parent: process.pid, started: 'fixture' }));
    }
  },
}));
vi.mock('../adapters/codex/appServerCoder.js', () => ({
  AppServerCoderSessions: class {
    constructor(
      rpc: unknown,
      _directory: string,
      _journal: string,
      _processes: unknown,
      verifyCopy: (run: CoderRun) => Promise<void>,
      _policy: unknown,
      beforeTurn: (run: CoderRun) => Promise<void>,
    ) {
      native.rpc = rpc;
      const client = native.client as CoderSessions;
      return {
        ...client,
        create: async (run: CoderRun) => {
          await beforeTurn(run);
          return client.create(run);
        },
        load: async (run: CoderRun, fresh: boolean) => {
          await beforeTurn(run);
          await verifyCopy(run);
          return client.load(run, fresh);
        },
        send: async (run: CoderRun, fresh: boolean) => {
          await beforeTurn(run);
          return client.send(run, fresh);
        },
        stop: async (run: CoderRun) => {
          await beforeTurn(run);
          return client.stop(run);
        },
        stopOwned: native.stop,
      };
    }
  },
}));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcess>('node:child_process');
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
let f: Awaited<ReturnType<typeof coderFixture>>;
let request: Record<string, unknown>;
const execute = () => executeCoderRequest(request, f.deps, () => {});
beforeEach(async () => {
  const original = (await vi.importActual<typeof ChildProcess>('node:child_process')).execFileSync;
  vi.mocked(execFileSync).mockImplementation(original);
  vi.clearAllMocks();
  native.starts = [];
  native.names = [];
  native.pid = 71;
  native.processMissing = false;
  native.rpc = null;
  f = await coderFixture();
  native.client = f.deps.sessions;
  vi.mocked(execFileSync).mockImplementation(((binary: string, args: string[], options: never) =>
    binary === 'fixture-codex'
      ? JSON.stringify([
          {
            name: 'computer-use',
            transport: {
              type: 'streamable_http',
              url: 'https://example.test/private',
              env: { SECRET: 'must not be persisted' },
            },
          },
        ])
      : original(binary, args, options)) as typeof execFileSync);
  request = {
    root: f.root,
    evidence_root: f.db.parent,
    binary: 'fixture-codex',
    coder: {
      action: 'run',
      id: 'one',
      assignment: {
        goal: 'Fixture CLI flow',
        paths: ['source.txt'],
        files: ['source.txt'],
        checks: [],
        criterion: 'Only declared fixture changes',
      },
    },
  };
});
afterEach(async () => {
  await f.dispose();
  vi.restoreAllMocks();
});
it('uses explicit MCP disable flags before the only SDK launch, retains a candidate and integrates separately', async () => {
  const candidate = await execute();
  expect(candidate.status).toBe('released');
  expect(native.starts).toHaveLength(1);
  expect(native.starts[0]).toMatchObject({
    binary: 'fixture-codex',
    cwd: resolve(f.db.parent, 'coder-workspaces/one'),
  });
  expect(native.starts[0]!.args).toContain('mcp_servers.computer-use.enabled=false');
  expect(native.starts[0]!.args).toContain('mcp_servers.computer-use.url=""');
  expect(native.starts[0]!.args.join(' ')).not.toContain('https://example.test/private');
  expect(native.starts[0]!.args).not.toContain('mcp_servers."computer-use".enabled=false');
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('source revision 1');
  request.coder = { action: 'status', id: 'one' };
  expect((await execute()).status).toBe('released');
  request.coder = { action: 'integrate', id: 'one' };
  expect((await execute()).status).toBe('integrated');
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('after:source.txt');
  expect(native.stop).toHaveBeenCalled();
  expect(native.close).toHaveBeenCalled();
});
it('binds a project-specific coder profile and the selected descriptor as protected inputs', async () => {
  await f.file('team/coder.md', 'Read the assigned files.');
  const connection = {
    locator: 'connection.json',
    descriptor: { ...f.connection, coder_profile: 'team/coder.md' },
  };
  const result = await executeCoderRequest(request, f.deps, () => {}, connection);
  expect(result.brief.rules.map((rule) => rule.locator)).toEqual([
    'AGENTS.md',
    'connection.json',
    'team/coder.md',
  ]);
});

it('hands off the raw transport before initialization and uses the adopted RPC', async () => {
  let run = await startCoder(await f.brief('one', ['source.txt']), f.deps);
  run = applyCoder(run, { type: 'COPY_INTENT', id: 'one:COPY_INTENT', generation: 1 });
  run = applyCoder(run, {
    type: 'COPIED',
    id: 'one:COPIED',
    generation: 1,
    copy: await f.workspaces.copy(run),
  });
  const owner: { raw?: StdioAppServer } = {};
  const adopted = {
    request: vi.fn<AppServerRpc['request']>().mockResolvedValue({ data: [], nextCursor: null }),
    completed: vi.fn<AppServerRpc['completed']>().mockResolvedValue(undefined),
  };
  native.initialize.mockImplementationOnce(async () => {
    expect(owner.raw?.pid).toBe(native.pid);
  });
  const beforeSpawn = vi.fn(() => {
    expect(native.starts).toHaveLength(0);
  });
  const options = {
    run,
    binary: 'fixture-codex',
    journal: resolve(f.db.parent, 'coders/one/transport.jsonl'),
    processes: new NativeWriterProcesses(),
    adopt(raw: StdioAppServer) {
      expect(native.initialize).not.toHaveBeenCalled();
      owner.raw = raw;
      return adopted;
    },
    verifyCopy: async () => {},
    authorize: async () => {},
    inventoryTimeoutMs: 500,
    beforeSpawn,
  };
  await expect(
    openNativeCoderSessions({
      ...options,
      beforeSpawn: vi
        .fn()
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('fixture deadline expired');
        }),
    }),
  ).rejects.toThrow('fixture deadline expired');
  expect(native.starts).toHaveLength(0);
  await expect(
    openNativeCoderSessions({ ...options, expectedDisabledMcpServers: [] }),
  ).rejects.toThrow('coder-mcp-inventory-changed');
  expect(native.starts).toHaveLength(0);
  beforeSpawn.mockClear();
  await openNativeCoderSessions({ ...options, expectedDisabledMcpServers: ['computer-use'] });
  expect(beforeSpawn).toHaveBeenCalledTimes(2);
  expect(adopted.request).toHaveBeenCalledWith('mcpServerStatus/list', {
    limit: 100,
    detail: 'toolsAndAuthOnly',
  });
  expect(native.rpc).toBe(adopted);
  expect(execFileSync).toHaveBeenCalledWith(
    'fixture-codex',
    expect.arrayContaining(['mcp', 'list', '--json']),
    expect.objectContaining({ timeout: 500, killSignal: 'SIGKILL' }),
  );
  expect(native.close).not.toHaveBeenCalled();
  owner.raw!.close();
  expect(native.close).toHaveBeenCalledOnce();
});
it.each(['malformed', 'unsafe-name', 'external-tools'])(
  'retains a confirmed %s refusal before creating a native session',
  async (kind) => {
    if (kind === 'malformed')
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('SECRET configuration');
      });
    if (kind === 'unsafe-name') vi.mocked(execFileSync).mockReturnValue('[{"name":"a.b"}]');
    if (kind === 'external-tools') native.names = ['still-enabled'];
    const refused = await execute();
    expect(refused.status).toBe('not-started');
    expect(f.counts.creates).toBe(0);
    expect(await readFile(refused.receipt!.locator, 'utf8')).not.toContain('SECRET');
    expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
    request.coder = { action: 'run', id: 'one' };
    expect((await execute()).status).toBe('not-started');
  },
);
it('keeps native errors after creation unknown and does not convert them to not-started', async () => {
  f.deps.sessions.create = async () => {
    throw new Error('fixture actual create unknown');
  };
  await expect(execute()).rejects.toThrow('fixture actual create unknown');
  expect((await f.deps.journal.read()).coders!.one!.status).toBe('creating');
  expect((await f.deps.runs.read())!.coder_locks).toMatchObject([
    { id: 'one', paths: ['source.txt'], workspace: f.root },
  ]);
  request.coder = { action: 'run', id: 'one' };
  await expect(execute()).rejects.toThrow('coder-create-outcome-unknown');
});
it('rejects malformed requests and brief replays, then cancels a released child', async () => {
  request.coder = { action: 'invalid', id: 'one' };
  await expect(execute()).rejects.toThrow('invalid-coder-action');
  request.coder = { action: 'run', id: '../bad' };
  await expect(execute()).rejects.toThrow('unsafe-coder-id');
  request.coder = { action: 'status', id: 'missing' };
  await expect(execute()).rejects.toThrow('coder-not-found');
  request.coder = { action: 'run', id: 'one', assignment: {} };
  await expect(execute()).rejects.toThrow('incomplete-coder-brief');
  request.coder = {
    action: 'run',
    id: 'one',
    assignment: {
      goal: 'fixture',
      paths: ['source.txt'],
      files: ['source.txt'],
      checks: [],
      criterion: 'fixture',
    },
  };
  await execute();
  await expect(execute()).rejects.toThrow('coder-brief-replay-conflict');
  request.coder = { action: 'cancel', id: 'one' };
  expect((await execute()).status).toBe('cancelled');
});

it('cancels a running child on SIGTERM and removes its signal handlers', async () => {
  const listeners = process.listenerCount('SIGTERM');
  const stop = f.deps.sessions.stop;
  let stopped!: () => void;
  const finished = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  f.deps.sessions.stop = async (run) => {
    const proof = await stop(run);
    stopped();
    return proof;
  };
  f.deps.sessions.result = async () => {
    process.emit('SIGTERM');
    process.emit('SIGINT');
    await finished;
    throw Error('fixture interrupted');
  };
  expect((await execute()).status).toBe('cancelled');
  expect(process.listenerCount('SIGTERM')).toBe(listeners);
  expect((await f.deps.runs.read())!.coder_locks).toEqual([]);
});
it('stops its own scope after loss of Store access without claiming cancellation', async () => {
  const read = f.deps.journal.read.bind(f.deps.journal);
  let stopped!: () => void;
  const finished = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  native.stop.mockImplementationOnce(async () => {
    stopped();
    throw Error('fixture unknown stop');
  });
  f.deps.sessions.result = async () => {
    f.deps.journal.read = async () => {
      throw Error('fixture ownership unavailable');
    };
    process.emit('SIGINT');
    await finished;
    throw Error('fixture interrupted');
  };
  await expect(execute()).rejects.toThrow('fixture ownership unavailable');
  expect(native.stop).toHaveBeenCalled();
  expect(native.close).toHaveBeenCalled();
  f.deps.journal.read = read;
  expect((await read()).coders!.one!.status).toBe('running');
});
it('recovers a persisted pre-create refusal after a failed Store acknowledgement without starting another SDK', async () => {
  native.names = ['still-enabled'];
  const save = f.deps.journal.save.bind(f.deps.journal);
  let fail = true;
  f.deps.journal.save = async (...args) => {
    if (fail && args[1].coders?.one?.status === 'not-started') {
      fail = false;
      throw Error('fixture Store refusal');
    }
    return save(...args);
  };
  await expect(execute()).rejects.toThrow('fixture Store refusal');
  expect((await f.deps.journal.read()).coders!.one!.status).toBe('creating');
  request.coder = { action: 'run', id: 'one' };
  expect((await execute()).status).toBe('not-started');
  expect(native.starts).toHaveLength(1);
});
it('rejects an absent parent and absent mandatory parent rules', async () => {
  const read = f.deps.runs.read.bind(f.deps.runs);
  f.deps.runs.read = async () => null;
  await expect(execute()).rejects.toThrow('coder-parent-missing');
  const local = (await read())!;
  f.deps.runs.read = async () => ({ ...local, spec: { ...local.spec, rules: [] } });
  await expect(execute()).rejects.toThrow('coder-parent-rules-missing');
  f.deps.runs.read = read;
});
it('uses the default binary with explicit string checks and no configured MCP servers', async () => {
  delete request.binary;
  const original = (await vi.importActual<typeof ChildProcess>('node:child_process')).execFileSync;
  vi.mocked(execFileSync).mockImplementation(((binary: string, args: string[], options: never) =>
    binary === 'codex' ? '[]' : original(binary, args, options)) as typeof execFileSync);
  (request.coder as { assignment: { checks: string[] } }).assignment.checks = ['node --version'];
  expect((await execute()).status).toBe('released');
  expect(native.starts[0]!.binary).toBe('codex');
});
it.each(['paths', 'files', 'checks'] as const)(
  'rejects a non-string %s item before native effects',
  async (field) => {
    const assignment = (request.coder as { assignment: Record<string, unknown> }).assignment;
    assignment[field] = [7];
    await expect(execute()).rejects.toThrow('incomplete-coder-brief');
    expect(native.starts).toEqual([]);
  },
);
it('stops a late confirmed create after interruption before permitting LOAD', async () => {
  const create = f.deps.sessions.create;
  f.deps.sessions.create = async (run) => {
    const receipt = await create(run);
    process.emit('SIGTERM');
    return receipt;
  };
  expect((await execute()).status).toBe('cancelled');
  expect(f.counts.loads).toBe(0);
  expect(f.counts.sends).toBe(0);
  expect(f.counts.stops).toBe(1);
});
it('does not create a writer when interrupted before source reservation', async () => {
  let interrupt = true;
  await expect(
    executeCoderRequest(request, f.deps, () => {
      if (interrupt) {
        interrupt = false;
        process.emit('SIGINT');
      }
    }),
  ).rejects.toThrow('coder-not-found');
  expect(f.counts.creates).toBe(0);
  expect(native.starts).toEqual([]);
  expect((await f.deps.runs.read())!.coder_locks).toBeUndefined();
});
it('stops its own confirmed writer even when the final Store lookup no longer exposes the child', async () => {
  const read = f.deps.journal.read.bind(f.deps.journal);
  let released = 0;
  f.deps.journal.read = async () => {
    const state = await read();
    return state.coders?.one?.status === 'released' && ++released === 2
      ? { ...state, coders: {} }
      : state;
  };
  expect((await execute()).status).toBe('released');
  expect(native.stop).toHaveBeenCalled();
});
it.each(['no-pid', 'missing-process'] as const)(
  'refuses an unbound native runtime: %s',
  async (kind) => {
    if (kind === 'no-pid') native.pid = undefined;
    else native.processMissing = true;
    expect((await execute()).status).toBe('not-started');
    expect(f.counts.creates).toBe(0);
  },
);
it('honors a durable refusal when the restored checkpoint still precedes CREATE_INTENT', async () => {
  let run = await startCoder(await f.brief('one', ['source.txt']), f.deps);
  run = applyCoder(run, { type: 'COPY_INTENT', id: 'one:COPY_INTENT', generation: 1 });
  run = applyCoder(run, {
    type: 'COPIED',
    id: 'one:COPIED',
    generation: 1,
    copy: await f.workspaces.copy(run),
  });
  const before = await f.deps.journal.read();
  await f.deps.journal.save(
    before,
    { ...before, revision: before.revision + 1, coders: { one: run } },
    'fixture:restored-copy',
  );
  const directory = resolve(f.db.parent, 'coders/one');
  await refuseCoderCreation(
    directory,
    resolve(directory, 'transport.jsonl'),
    run,
    'confirmed earlier refusal',
  );
  request.coder = { action: 'run', id: 'one' };
  expect((await execute()).status).toBe('not-started');
  expect(native.starts).toEqual([]);
});
it('returns cancellation when SIGTERM arrives after the final release was saved', async () => {
  const save = f.deps.journal.save.bind(f.deps.journal);
  let interrupt = true;
  f.deps.journal.save = async (...args) => {
    const result = await save(...args);
    if (interrupt && args[1].coders?.one?.status === 'released') {
      interrupt = false;
      process.emit('SIGTERM');
    }
    return result;
  };
  expect((await execute()).status).toBe('cancelled');
  expect(f.counts.stops).toBe(1);
});
