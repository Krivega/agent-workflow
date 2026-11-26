import { chmodSync } from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { digest } from '../src/adapters/artifacts/files.js';
import { readerActivities } from '../src/activities/reader.js';
import { readerLoadPrompt, readerOperationId } from '../src/adapters/codex/readerMessages.js';
import type { ReaderInput } from '../src/contracts/reader.js';
import type * as WriterProcessesModule from '../src/adapters/codex/writerProcesses.js';
import type { ProcessIdentity } from '../src/contracts/writerProcesses.js';
import { readH04Pin } from './comparisonH04Contract.js';
import { checkH06NativeCapabilities } from './comparisonH06NativeCapabilities.js';
import { bindH06NativeUsageParticipants } from './comparisonH06NativeUsage.js';
import {
  openH06NativeTransport,
  type H06NativeTransportOptions,
} from './comparisonH06NativeTransport.js';

const mock = vi.hoisted(() => ({
  port: vi.fn(),
  initialize: vi.fn(),
  request:
    vi.fn<(method: string, params: Record<string, unknown>, root: string) => Promise<unknown>>(),
  close: vi.fn(),
  completed: vi.fn(),
  descendants: vi.fn(),
  alive: vi.fn(),
  terminate: vi.fn(),
  wait: vi.fn(),
}));
vi.mock('../adapters/codex/appServerTransport.js', () => ({
  StdioAppServer: class {
    pid: number;
    initialize = mock.initialize;
    close = mock.close;
    completed = mock.completed;
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    constructor(binary: string, args: string[], cwd: string, journal: string, operation?: string) {
      this.pid = mock.port(binary, args, cwd, journal, operation) as number;
      this.request = vi.fn((method: string, params: Record<string, unknown>) =>
        mock.request(method, params, cwd),
      );
    }
  },
}));
vi.mock('../src/adapters/codex/writerProcesses.js', () => ({
  NativeWriterProcesses: class {
    descendants = mock.descendants;
    alive = mock.alive;
    terminate = mock.terminate;
    wait = mock.wait;
  },
}));

const roots: string[] = [];
const dead = new Set<number>();
function identity(pid: number): ProcessIdentity {
  return { pid, parent: process.pid, started: 'pid-' + pid };
}
function thread(
  id: string,
  root: string,
  model = 'gpt-6-astra',
  effort = 'medium',
  writable = false,
) {
  return {
    thread: { id, cwd: root },
    cwd: root,
    model,
    reasoningEffort: effort,
    approvalPolicy: 'never',
    sandbox: writable
      ? {
          type: 'workspaceWrite',
          writableRoots: [root],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        }
      : { type: 'readOnly', networkAccess: false },
  };
}

function runtimeWriter(root: string) {
  const response = thread('session', root, undefined, undefined, true);
  return {
    ...response,
    sandbox: { ...response.sandbox, writableRoots: [] as string[] },
    runtimeWorkspaceRoots: [root],
    thread: {
      ...response.thread,
      environments: [{ environmentId: 'local', cwd: root, runtimeWorkspaceRoots: [root] }],
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  dead.clear();
  let pid = 8001;
  mock.port.mockImplementation(() => pid++);
  mock.initialize.mockResolvedValue(undefined);
  mock.completed.mockResolvedValue(undefined);
  mock.descendants.mockImplementation(async (roots: number[]) => roots.map(identity));
  mock.alive.mockImplementation(async (ids: ProcessIdentity[]) =>
    ids.filter(({ pid }) => !dead.has(pid)),
  );
  mock.terminate.mockImplementation(async (ids: ProcessIdentity[]) => {
    for (const { pid } of ids) dead.add(pid);
    return ids;
  });
  mock.request.mockImplementation(
    async (method: string, params: Record<string, unknown>, root: string) => {
      if (method === 'thread/start' || method === 'thread/resume')
        return thread(
          String(params.threadId ?? 'session'),
          root,
          undefined,
          undefined,
          params.sandbox === 'workspace-write',
        );
      if (method === 'thread/read') return { thread: { id: params.threadId, cwd: root } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'model/list')
        return {
          data: [
            { model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
          ],
          nextCursor: null,
        };
      return { data: [], nextCursor: null };
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-transport-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const copyRoot = join(root, 'copies');
  const copy = join(copyRoot, 'attempt-1');
  const evidenceRoot = join(root, 'evidence');
  const path = join(root, 'binary');
  mkdirSync(workspaceRoot);
  mkdirSync(copy, { recursive: true });
  writeFileSync(path, 'pinned binary');
  const options: H06NativeTransportOptions = {
    operationId: 'h06-operation',
    binary: { path, sha256: digest('pinned binary') },
    workspaceRoot,
    copyRoot,
    evidenceRoot,
    profile: { model: 'gpt-6-astra', effort: 'medium', clientVersion: '0.154.0' },
    disabledServers: ['computer-use', 'node_repl'],
    workDeadlineMs: Date.now() + 30000,
    stopDeadlineMs: Date.now() + 60000,
    admitTurn: vi.fn(async () => {}),
    recordTurn: vi.fn(async () => {}),
  };
  return { root, copy, options };
}
function params(threadId = 'session') {
  return { threadId, input: [{ type: 'text', text: 'Workflow operation: op\nmessage' }] };
}

const loadClientVersions = ['0.169.1', '0.171.0-alpha.13', '0.171.0-alpha.13.2'];
it.each(loadClientVersions)('enforces one Reader LOAD on %s', async (version) => {
  const { root, options, copy } = fixture();
  options.profile.clientVersion = version;
  writeFileSync(
    options.binary.path,
    '#!/bin/sh\necho \'[{"name":"computer-use"},{"name":"node_repl","transport":{"type":"streamable_http"}}]\'\n',
  );
  chmodSync(options.binary.path, 0o700);
  options.binary.sha256 = digest(readFileSync(options.binary.path));
  mkdirSync(join(options.workspaceRoot, 'tasks'));
  for (const path of ['RULES.md', 'reviewer.md', 'tasks/one.md'])
    writeFileSync(join(options.workspaceRoot, path), path);
  const project = {
    schemaVersion: 1 as const,
    projectId: 'neutral',
    workspaceId: 'main',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
    checks: ['syntax'],
  };
  const input: ReaderInput = {
    preparation: {
      schemaVersion: 1,
      taskId: 'one',
      project,
      hostId: 'host',
      owner: 'owner',
      generation: 1,
      revision: 1,
      card: 'tasks/one.md',
    },
    roleId: 'reviewer',
  };
  const fallback = mock.request.getMockImplementation()!;
  mock.request.mockImplementation(async (method, params, workspace) => {
    if (method === 'thread/start') {
      const response = thread('session', workspace);
      return {
        ...response,
        thread: {
          ...response.thread,
          projectId: null,
          parentThreadId: null,
          forkedFromId: null,
          turns: [],
        },
      };
    }
    if (method === 'thread/loaded/list') return { data: ['session'] };
    return fallback(method, params, workspace);
  });
  options.readerLoadProbe = { node: options.binary, waitMs: 120000 };
  const runtime = await openH06NativeTransport(options);
  const dispatch = vi.spyOn(runtime.rpc, 'request');
  options.readerLoadProbe.waitMs = 1;
  const activities = readerActivities(
    {
      project,
      hostId: 'host',
      owner: 'owner',
      generation: 1,
      workspaceRoot: options.workspaceRoot,
      artifactRoot: join(root, 'artifacts'),
      commands: { syntax: { executable: options.binary.path, args: ['--check'] } },
    },
    runtime.rpc,
    options.profile,
    join(root, 'effects'),
  );
  const prepared = await activities.prepareProject(input.preparation);
  const session = await activities.createReader(input, prepared);
  mock.completed.mockRejectedValueOnce(new Error('synthetic stop after dispatch'));
  await expect(activities.loadReader(input, prepared, session)).rejects.toThrow(
    'synthetic stop after dispatch',
  );
  const original = dispatch.mock.calls.find(([method]) => method === 'turn/start')![1];
  const marker = `Workflow operation: ${readerOperationId(input, 'load', 0)}\n`;
  const body = readerLoadPrompt(
    ['RULES.md', 'reviewer.md', 'tasks/one.md'].map((path) => ({
      path: join(options.workspaceRoot, path),
      sha256: digest(readFileSync(join(options.workspaceRoot, path))),
    })),
    4,
  );
  expect(original.input).toEqual([{ type: 'text', text: marker + body }]);
  const sent = mock.request.mock.calls.find(([method]) => method === 'turn/start')![1];
  const prompt = (sent.input as { text: string }[])[0]!.text;
  expect(prompt.startsWith(marker + 'TD-054:')).toBe(true);
  expect(prompt.endsWith(body)).toBe(true);
  expect(prompt).toContain('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120000)');
  expect(options.admitTurn).toHaveBeenCalledOnce();
  expect(options.recordTurn).toHaveBeenCalledOnce();
  await expect(
    runtime.rpc.request('turn/start', {
      threadId: 'session',
      input: [
        {
          type: 'text',
          text: marker + body + '2',
        },
      ],
    }),
  ).rejects.toThrow('h06-transport-load-probe');
  expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  expect(options.admitTurn).toHaveBeenCalledOnce();
  expect(() => runtime.localTasks.createRuntime(copy)).toThrow('h06-transport-load-probe');
  await runtime.stop();
  expect(mock.port).toHaveBeenCalledOnce();
});

it.each(['budget', 'writer', 'pin', 'fields'] as const)(
  'refuses invalid dedicated LOAD stimulus before process start (%s)',
  async (kind) => {
    const { options } = fixture();
    options.readerLoadProbe = { node: options.binary, waitMs: kind === 'budget' ? 0 : 120000 };
    if (kind === 'writer') options.writerStimulus = { node: options.binary, minimumMs: 1000 };
    if (kind === 'pin')
      options.readerLoadProbe.node = { ...options.binary, sha256: '0'.repeat(64) };
    if (kind === 'fields') Object.assign(options.readerLoadProbe, { foreign: true });
    await expect(openH06NativeTransport(options)).rejects.toThrow();
    expect(mock.port).not.toHaveBeenCalled();
  },
);

it.each([
  'bare',
  'answer',
  'short-hash',
  'uppercase-hash',
  'prefix',
  'crlf',
  'blank-line',
  'body',
  'nested',
])('refuses a noncanonical production LOAD envelope before admission (%s)', async (kind) => {
  const { options } = fixture();
  options.readerLoadProbe = { node: options.binary, waitMs: 120000 };
  const runtime = await openH06NativeTransport(options);
  await runtime.rpc.request('thread/start', {});
  const marker = 'Workflow operation: reader-load-' + 'a'.repeat(64) + '\n';
  const body = 'Только чтение, без сети, записи, помощников и внешней истории. LOAD';
  let prompt = marker + body;
  if (kind === 'bare') prompt = body;
  if (kind === 'answer') prompt = prompt.replace('reader-load-', 'reader-answer-');
  if (kind === 'short-hash') prompt = prompt.replace('a'.repeat(64), 'a'.repeat(63));
  if (kind === 'uppercase-hash') prompt = prompt.replace('a'.repeat(64), 'A'.repeat(64));
  if (kind === 'prefix') prompt = 'prefix\n' + prompt;
  if (kind === 'crlf') prompt = marker.replace('\n', '\r\n') + body;
  if (kind === 'blank-line') prompt = marker + '\n' + body;
  if (kind === 'body') prompt = marker + 'Выполни реализацию';
  if (kind === 'nested') prompt = marker + marker + body;
  await expect(
    runtime.rpc.request('turn/start', {
      threadId: 'session',
      input: [{ type: 'text', text: prompt }],
    }),
  ).rejects.toThrow('h06-transport-load-probe');
  await expect(
    runtime.rpc.request('turn/start', {
      threadId: 'session',
      input: [{ type: 'text', text: marker + body }],
    }),
  ).rejects.toThrow('h06-transport-admission');
  expect(options.admitTurn).not.toHaveBeenCalled();
  expect(options.recordTurn).not.toHaveBeenCalled();
  expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0);
  await runtime.stop();
});

it('pins real argv, scopes reader and writer calls, and retains an immutable all-port stop', async () => {
  const { options, copy } = fixture();
  const transport = await openH06NativeTransport(options);
  const readerJournal = join(options.evidenceRoot, 'reader-0.jsonl');
  expect(mock.port).toHaveBeenCalledExactlyOnceWith(
    options.binary.path,
    [
      '-c',
      'features.apps=false',
      '-c',
      'features.plugins=false',
      '-c',
      'features.multi_agent=false',
      '-c',
      'web_search="disabled"',
      '-c',
      'mcp_servers.computer-use.enabled=false',
      '-c',
      'mcp_servers.node_repl.enabled=false',
      'app-server',
      '--stdio',
    ],
    options.workspaceRoot,
    readerJournal,
    undefined,
  );
  await transport.rpc.request('thread/start', { config: { web_search: 'live' }, model: 'foreign' });
  await transport.rpc.request('turn/start', { ...params(), outputSchema: { type: 'object' } });
  expect(vi.mocked(options.admitTurn).mock.calls[0]?.[0]).toMatchObject({
    role: 'reader',
    session: 'session',
    journal: readerJournal,
    params: {
      model: 'gpt-6-astra',
      effort: 'medium',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      outputSchema: { type: 'object' },
    },
  });
  await transport.rpc.request('thread/read', { threadId: 'session' });
  await transport.rpc.completed('session', 'turn-1');
  const writer = transport.localTasks.createRuntime(copy);
  await writer.initialize();
  await writer.initialize();
  await writer.request('thread/start', {});
  await writer.admitTurn?.(params());
  await writer.request('turn/start', params());
  expect(options.admitTurn).toHaveBeenCalledTimes(2);
  expect(vi.mocked(options.recordTurn).mock.lastCall?.[0]).toMatchObject({
    role: 'writer',
    root: copy,
    turnId: 'turn-1',
    response: { turn: { id: 'turn-1' } },
    params: {
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [copy],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      },
    },
  });
  await transport.localTasks.processes!.wait(1);
  await transport.localTasks.processes!.terminate([identity(writer.pid)]);
  writer.close();
  const receipts = await transport.stop();
  expect(receipts).toEqual([
    expect.objectContaining({
      role: 'reader',
      journal: readerJournal,
      processes: [identity(8001)],
      confirmed: true,
    }),
    expect.objectContaining({ role: 'writer', processes: [identity(8002)], confirmed: true }),
  ]);
  expect(await transport.stop()).toBe(receipts);
  expect(
    JSON.parse(readFileSync(join(options.evidenceRoot, 'transport-stop.json'), 'utf8')),
  ).toEqual({
    kind: 'h06-native-transport-stop',
    operationId: options.operationId,
    receipts,
  });
});

it('opens only previously declared reader sessions on replacement and rechecks runtime capability', async () => {
  const { options } = fixture();
  options.retainedReaderSessions = ['old-session'];
  const transport = await openH06NativeTransport(options);
  await expect(transport.rpc.request('thread/resume', { threadId: 'foreign' })).rejects.toThrow(
    'h06-transport-session',
  );
  await transport.rpc.request('thread/resume', { threadId: 'old-session', excludeTurns: true });
  expect(mock.request).toHaveBeenCalledWith(
    'thread/resume',
    expect.objectContaining({ threadId: 'old-session', excludeTurns: true }),
    options.workspaceRoot,
  );
  await transport.rpc.request('turn/start', params('old-session'));
  await transport.stop();
});

it('pins exact native session responses, including path-bearing retained readback, at STOP', async () => {
  const { root, options, copy } = fixture();
  const readerPath = join(root, 'reader-session.jsonl');
  const writerPath = join(root, 'writer-session.jsonl');
  const readerResponse = thread('reader-session', options.workspaceRoot);
  const writerResponse = {
    ...thread('writer-session', copy, undefined, undefined, true),
    thread: { id: 'writer-session', cwd: copy, path: writerPath },
  };
  const original = mock.request.getMockImplementation()!;
  mock.request.mockImplementation(async (method, params, cwd) => {
    if (method === 'thread/start') return cwd === copy ? writerResponse : readerResponse;
    if (method === 'thread/read')
      return { thread: { id: params.threadId, cwd, path: readerPath, turns: [{ id: 'turn' }] } };
    return original(method, params, cwd);
  });
  const runtime = await openH06NativeTransport(options);
  await runtime.rpc.request('thread/start', {});
  await runtime.rpc.request('thread/read', { threadId: 'reader-session' });
  await runtime.rpc.request('thread/read', { threadId: 'reader-session' });
  const writer = runtime.localTasks.createRuntime(copy);
  await writer.initialize();
  await writer.request('thread/start', {});
  const [readerStopped, writerStopped] = await runtime.stop();
  expect(readerStopped?.capabilities).toHaveLength(1);
  expect(writerStopped?.capabilities).toHaveLength(1);
  expect(
    checkH06NativeCapabilities(
      {
        operationId: options.operationId,
        binary: options.binary,
        role: 'reader',
        root: options.workspaceRoot,
        journal: join(options.evidenceRoot, 'reader-0.jsonl'),
        session: 'reader-session',
        profile: options.profile,
        disabledServers: options.disabledServers,
      },
      readerStopped!.sessions[0]!,
      readerStopped!.capabilities[0]!,
    ),
  ).toMatchObject({
    profile: options.profile,
    session: 'reader-session',
    observedServers: [],
    qualification: false,
  });
  expect(
    readerStopped?.sessions.map((pin): unknown => JSON.parse(readH04Pin(pin).toString())),
  ).toMatchObject([
    { method: 'thread/start', response: readerResponse },
    {
      method: 'thread/read',
      response: { thread: { id: 'reader-session', cwd: options.workspaceRoot, path: readerPath } },
    },
  ]);
  expect(
    writerStopped?.sessions.map((pin): unknown => JSON.parse(readH04Pin(pin).toString())),
  ).toMatchObject([{ method: 'thread/start', response: writerResponse }]);
  const path = join(options.evidenceRoot, 'transport-stop.json');
  const admissions = [
    {
      scope: {
        role: 'reader' as const,
        root: options.workspaceRoot,
        journal: readerStopped!.journal,
        session: 'reader-session',
      },
    },
    {
      scope: {
        role: 'writer' as const,
        root: copy,
        journal: writerStopped!.journal,
        session: 'writer-session',
      },
    },
  ];
  expect(
    bindH06NativeUsageParticipants({
      operationId: options.operationId,
      stops: [{ path, sha256: digest(readFileSync(path)) }],
      admissions,
    }),
  ).toEqual({
    status: 'BOUND',
    participants: [
      {
        session: 'reader-session',
        transcript: readerPath,
        run: options.operationId,
        stage: 'execution',
      },
      {
        session: 'writer-session',
        transcript: writerPath,
        run: options.operationId,
        stage: 'execution',
      },
    ],
    missing: [],
    unavailable: [],
  });
});

it.each([false, true])(
  'admits the native Writer workspace with explicit roots=%s',
  async (explicit) => {
    const { options, copy } = fixture();
    const response = runtimeWriter(copy);
    if (explicit) response.sandbox.writableRoots = [copy];
    const original = mock.request.getMockImplementation()!;
    mock.request.mockImplementation(async (method, params, cwd) =>
      method === 'thread/start' && cwd === copy ? response : original(method, params, cwd),
    );
    const transport = await openH06NativeTransport(options);
    const writer = transport.localTasks.createRuntime(copy);
    await writer.initialize();
    await expect(writer.request('thread/start', {})).resolves.toEqual(response);
    await writer.request('turn/start', params());
    expect(options.admitTurn).toHaveBeenCalledOnce();
    const [, stopped] = await transport.stop();
    expect(stopped?.sessions).toHaveLength(1);
    expect(stopped?.capabilities).toHaveLength(1);
  },
);

type RuntimeWriter = ReturnType<typeof runtimeWriter>;
const unsafeWriterSessions: [string, (response: RuntimeWriter) => void][] = [
  ['missing-runtime-roots', (r) => Object.assign(r, { runtimeWorkspaceRoots: undefined })],
  ['extra-runtime-root', (r) => r.runtimeWorkspaceRoots.push('/outside')],
  ['missing-environments', (r) => Object.assign(r.thread, { environments: undefined })],
  ['extra-environment', (r) => r.thread.environments.push(r.thread.environments[0]!)],
  ['environment-cwd', (r) => (r.thread.environments[0]!.cwd = '/outside')],
  ['environment-roots', (r) => r.thread.environments[0]!.runtimeWorkspaceRoots.push('/outside')],
  ['extra-writable-root', (r) => (r.sandbox.writableRoots = [r.cwd, '/outside'])],
  ['network', (r) => Object.assign(r.sandbox, { networkAccess: true })],
  ['slash-tmp', (r) => Object.assign(r.sandbox, { excludeSlashTmp: false })],
  ['environment-tmp', (r) => Object.assign(r.sandbox, { excludeTmpdirEnvVar: false })],
  ['cwd', (r) => (r.cwd = '/outside')],
  ['thread-cwd', (r) => (r.thread.cwd = '/outside')],
  ['model', (r) => (r.model = 'other')],
  ['effort', (r) => (r.reasoningEffort = 'high')],
];
it.each(unsafeWriterSessions)(
  'refuses a Writer before any turn on %s drift',
  async (_name, change) => {
    const { options, copy } = fixture();
    const response = runtimeWriter(copy);
    change(response);
    const original = mock.request.getMockImplementation()!;
    mock.request.mockImplementation(async (method, params, cwd) =>
      method === 'thread/start' && cwd === copy ? response : original(method, params, cwd),
    );
    const transport = await openH06NativeTransport(options);
    const writer = transport.localTasks.createRuntime(copy);
    await writer.initialize();
    await expect(writer.request('thread/start', {})).rejects.toThrow('h06-transport-session');
    expect(options.admitTurn).not.toHaveBeenCalled();
    expect(mock.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    const [, stopped] = await transport.stop();
    expect(stopped?.sessions).toEqual([]);
  },
);

it('retains the observed session but refuses all new work after an invalid capability inventory', async () => {
  const { options } = fixture();
  const original = mock.request.getMockImplementation()!;
  mock.request.mockImplementation(async (method, params, cwd) =>
    method === 'model/list' ? { data: [], nextCursor: null } : original(method, params, cwd),
  );
  const transport = await openH06NativeTransport(options);
  await expect(transport.rpc.request('thread/start', {})).rejects.toThrow();
  await expect(transport.rpc.request('thread/start', {})).rejects.toThrow(
    'h06-transport-admission',
  );
  await expect(transport.rpc.request('turn/start', params())).rejects.toThrow(
    'h06-transport-admission',
  );
  expect(mock.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  const [stopped] = await transport.stop();
  expect(stopped?.sessions).toHaveLength(1);
  expect(stopped?.capabilities).toEqual([]);
});

it.each(['deny', 'mutate', 'pending-request', 'stop', 'record-failure', 'repeat'] as const)(
  'does not grant a new dispatch after %s',
  async (which) => {
    const { options, copy } = fixture();
    const request = params();
    let release = () => {};
    let entered = () => {};
    const admitting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    options.admitTurn = vi.fn(async () => {
      if (which === 'deny') throw new Error('operator-denied');
      if (which === 'mutate') request.input[0]!.text = 'changed';
      if (which === 'pending-request' || which === 'stop') {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    if (which === 'record-failure')
      options.recordTurn = vi.fn(async () => {
        throw new Error('receipt failed');
      });
    const transport = await openH06NativeTransport(options);
    const writer = transport.localTasks.createRuntime(copy);
    await writer.initialize();
    await writer.request('thread/start', {});
    if (which === 'pending-request' || which === 'stop') {
      const pending = writer.admitTurn!(request).catch((error: unknown) => error);
      await admitting;
      if (which === 'stop') await transport.stop();
      else
        await expect(writer.request('turn/start', request)).rejects.toThrow(
          'h06-transport-admission',
        );
      release();
      expect(await pending).toBeInstanceOf(Error);
    } else if (which === 'record-failure') {
      await expect(writer.request('turn/start', request)).rejects.toThrow('receipt failed');
    } else if (which === 'repeat') {
      await writer.request('turn/start', request);
    }
    await expect(writer.request('turn/start', request)).rejects.toThrow();
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
      which === 'record-failure' || which === 'repeat' ? 1 : 0,
    );
    await transport.stop();
  },
);

it.each([
  'pin',
  'profile',
  'missing-admission',
  'missing-recorder',
  'mcp-name',
  'mcp-duplicate',
  'work-shape',
  'stop-shape',
  'expired',
  'no-reserve',
  'overflow',
  'copy-relative',
  'overlap',
  'retained-duplicate',
] as const)('refuses an invalid opening (%s) before creating a port', async (which) => {
  const { options } = fixture();
  if (which === 'pin') writeFileSync(options.binary.path, 'changed binary');
  if (which === 'profile') options.profile.clientVersion = '0.164.0';
  if (which === 'missing-admission') Object.assign(options, { admitTurn: null });
  if (which === 'missing-recorder') Object.assign(options, { recordTurn: null });
  if (which === 'mcp-name') options.disabledServers = ['a.b'];
  if (which === 'mcp-duplicate') options.disabledServers = ['a', 'a'];
  if (which === 'work-shape') options.workDeadlineMs += 0.5;
  if (which === 'stop-shape') options.stopDeadlineMs += 0.5;
  if (which === 'expired') options.workDeadlineMs = 0;
  if (which === 'no-reserve') options.stopDeadlineMs = options.workDeadlineMs;
  if (which === 'overflow') options.stopDeadlineMs += 2 ** 31;
  if (which === 'copy-relative') options.copyRoot = './copies';
  if (which === 'overlap') options.evidenceRoot = join(options.workspaceRoot, 'evidence');
  if (which === 'retained-duplicate') options.retainedReaderSessions = ['one', 'one'];
  await expect(openH06NativeTransport(options)).rejects.toThrow();
  expect(mock.port).not.toHaveBeenCalled();
});

it.each([
  'pid-missing',
  'pid-invalid',
  'pid-system',
  'unknown-owner',
  'initialize',
  'active-mcp',
] as const)('does not return a transport after failed startup (%s)', async (which) => {
  const { options } = fixture();
  if (which === 'pid-missing') mock.port.mockReturnValueOnce(undefined);
  if (which === 'pid-invalid') mock.port.mockReturnValueOnce(10.5);
  if (which === 'pid-system') mock.port.mockReturnValueOnce(1);
  if (which === 'unknown-owner') mock.descendants.mockResolvedValueOnce([identity(9000)]);
  if (which === 'initialize') mock.initialize.mockRejectedValueOnce(new Error('startup failed'));
  if (which === 'active-mcp')
    mock.request.mockResolvedValueOnce({ data: [{ name: 'unapproved' }] });
  await expect(openH06NativeTransport(options)).rejects.toThrow();
  expect(mock.close).toHaveBeenCalled();
  if (which === 'active-mcp' || which === 'initialize') expect(dead.has(8001)).toBe(true);
});

it.each(['lost', 'reused', 'survives', 'omitted', 'initial-survivor'] as const)(
  'keeps unconfirmed cleanup unknown (%s)',
  async (which) => {
    const { options } = fixture();
    const transport = await openH06NativeTransport(options);
    if (which === 'lost') mock.alive.mockResolvedValue([]);
    if (which === 'reused')
      mock.descendants.mockResolvedValue([{ ...identity(8001), started: 'foreign' }]);
    if (which === 'survives') mock.terminate.mockResolvedValue([identity(8001)]);
    if (which === 'omitted') mock.terminate.mockResolvedValue([]);
    if (which === 'initial-survivor') mock.alive.mockResolvedValue([identity(9000)]);
    const failure: unknown = await transport.stop().catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'h06-transport-stop-unknown' });
    if (which === 'lost' || which === 'survives' || which === 'initial-survivor')
      expect(failure).toMatchObject({
        errors: [
          expect.objectContaining({
            message:
              which === 'lost'
                ? 'h06-transport-stop-termination-unrecorded'
                : which === 'survives'
                  ? 'h06-transport-stop-not-reaped'
                  : 'h06-transport-stop-initial-survivors',
          }) as unknown,
        ],
      });
    expect(() => readFileSync(join(options.evidenceRoot, 'transport-stop.json'))).toThrow();
    expect(mock.close).toHaveBeenCalled();
  },
);

it('does not confirm a missing reader using a different initial group termination', async () => {
  const { options, copy } = fixture();
  const transport = await openH06NativeTransport(options);
  const writer = transport.localTasks.createRuntime(copy);
  await transport.localTasks.processes!.terminate([identity(writer.pid)]);
  mock.alive.mockResolvedValue([]);
  const failure: unknown = await transport.stop().catch((error: unknown) => error);
  expect(failure).toMatchObject({
    message: 'h06-transport-stop-unknown',
    errors: [expect.objectContaining({ message: 'h06-transport-stop-termination-unrecorded' })],
  });
  expect(() => readFileSync(join(options.evidenceRoot, 'transport-stop.json'))).toThrow();
  expect(mock.close).toHaveBeenCalledTimes(2);
});

it('waits for a real killed reader to be reaped and reconciles an already stopped Writer', async () => {
  const { NativeWriterProcesses } = await vi.importActual<typeof WriterProcessesModule>(
    '../src/adapters/codex/writerProcesses.js',
  );
  const native = new NativeWriterProcesses();
  const children = [0, 1].map(() =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }),
  );
  const exits = children.map((child) => once(child, 'exit'));
  try {
    await Promise.all(children.map((child) => once(child, 'spawn')));
    const [reader, writer] = children;
    const { options, copy } = fixture();
    mock.port.mockReturnValueOnce(reader!.pid).mockReturnValueOnce(writer!.pid);
    mock.descendants.mockImplementation((pids: number[]) => native.descendants(pids));
    let pendingReap: ProcessIdentity[] | undefined;
    let delayedObservation = false;
    mock.alive.mockImplementation(async (ids: ProcessIdentity[]) => {
      if (pendingReap !== undefined && ids.some(({ pid }) => pid === reader!.pid)) {
        const pending = pendingReap;
        pendingReap = undefined;
        delayedObservation = true;
        return pending;
      }
      return native.alive(ids);
    });
    mock.terminate.mockImplementation(async (ids: ProcessIdentity[]) => {
      const stopped = await native.terminate(ids);
      if (ids.some(({ pid }) => pid === reader!.pid)) pendingReap = stopped;
      return stopped;
    });
    mock.wait.mockImplementation((ms: number) => native.wait(ms));
    const transport = await openH06NativeTransport(options);
    const runtime = transport.localTasks.createRuntime(copy);
    await transport.localTasks.processes!.terminate(await native.descendants([runtime.pid]));
    await exits[1];
    const receipts = await transport.stop();
    expect(delayedObservation).toBe(true);
    expect(mock.wait).toHaveBeenCalledWith(50);
    expect(receipts.map(({ confirmed }) => confirmed)).toEqual([true, true]);
    expect(await native.alive(receipts.flatMap(({ processes }) => processes))).toEqual([]);
    await Promise.all(exits);
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(exits);
  }
});

it('keeps delayed process reaping bounded by the original hard deadline', async () => {
  vi.useFakeTimers();
  const { options } = fixture();
  options.workDeadlineMs = Date.now() + 5000;
  options.stopDeadlineMs = Date.now() + 10000;
  mock.terminate.mockResolvedValue([identity(8001)]);
  mock.wait.mockImplementation(async () => new Promise<void>(() => {}));
  const transport = await openH06NativeTransport(options);
  const stopped = transport.stop().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10001);
  expect(await stopped).toMatchObject({ message: 'h06-transport-stop-unknown' });
  expect(() => readFileSync(join(options.evidenceRoot, 'transport-stop.json'))).toThrow();
  expect(mock.close).toHaveBeenCalled();
});

it('cancels active LOAD at work deadline, freezes dispatch and seals all STOP receipts before hard deadline', async () => {
  vi.useFakeTimers();
  const began = performance.now(),
    wall = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => began + Date.now() - wall);
  const { options, copy } = fixture();
  options.workDeadlineMs = Date.now() + 2000;
  options.stopDeadlineMs = Date.now() + 5000;
  const abort = new AbortController();
  mock.completed.mockImplementation(
    (_thread, _turn, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  );
  const transport = await openH06NativeTransport(options);
  await transport.rpc.request('thread/start', {});
  await transport.rpc.request('turn/start', {
    threadId: 'session',
    input: [{ type: 'text', text: 'LOAD: await the active reader turn' }],
  });
  const writer = transport.localTasks.createRuntime(copy);
  const deadlineError = new Error('work deadline');
  const pending = (async () => {
    try {
      await transport.rpc.completed('session', 'turn-1', abort.signal);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await transport.stop();
    }
  })().catch((error: unknown) => error);
  setTimeout(() => abort.abort(deadlineError), 2000);
  await vi.advanceTimersByTimeAsync(2001);
  const dispatches = mock.request.mock.calls.length;
  await expect(transport.rpc.request('turn/start', params())).rejects.toThrow(
    'h06-transport-deadline',
  );
  await expect(writer.request('thread/start', {})).rejects.toThrow('h06-transport-deadline');
  expect(() => transport.localTasks.createRuntime(copy)).toThrow('h06-transport-deadline');
  await vi.advanceTimersByTimeAsync(1200);
  expect(await pending).toBe(deadlineError);
  expect(Date.now()).toBeLessThan(options.stopDeadlineMs);
  const path = join(options.evidenceRoot, 'transport-stop.json');
  const bytes = readFileSync(path);
  expect(JSON.parse(bytes.toString()) as unknown).toMatchObject({
    receipts: [
      { role: 'reader', confirmed: true },
      { role: 'writer', confirmed: true },
    ],
  });
  await transport.stop();
  await vi.advanceTimersByTimeAsync(2000);
  expect(readFileSync(path)).toEqual(bytes);
  expect(mock.request).toHaveBeenCalledTimes(dispatches);
  expect(options.admitTurn).toHaveBeenCalledOnce();
  expect(mock.port).toHaveBeenCalledTimes(2);
});

it('observes the work deadline without dispatching a late approved turn', async () => {
  vi.useFakeTimers();
  const { options } = fixture();
  options.workDeadlineMs = Date.now() + 5000;
  options.stopDeadlineMs = Date.now() + 10000;
  let release = () => {};
  let entered = () => {};
  const admitting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  options.admitTurn = vi.fn(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const transport = await openH06NativeTransport(options);
  await transport.rpc.request('thread/start', {});
  const result = transport.rpc.request('turn/start', params()).catch((error: unknown) => error);
  await admitting;
  await vi.advanceTimersByTimeAsync(5001);
  expect(await result).toMatchObject({ message: 'h06-transport-deadline' });
  release();
  expect(mock.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  await transport.stop();
});

it('bounds methods, writer roots and inspection scope', async () => {
  const { options } = fixture();
  const transport = await openH06NativeTransport(options);
  const before = mock.request.mock.calls.length;
  expect(() => transport.localTasks.createRuntime(options.workspaceRoot)).toThrow(
    'h06-transport-copy-root',
  );
  await expect(transport.rpc.request('command/exec', {})).rejects.toThrow('h06-transport-method');
  await expect(transport.rpc.request('turn/interrupt', { threadId: 'foreign' })).rejects.toThrow(
    'h06-transport-session',
  );
  expect(mock.request.mock.calls).toHaveLength(before);
  vi.stubEnv('PATH', undefined);
  try {
    await transport.rpc.request('thread/start', {});
  } finally {
    vi.unstubAllEnvs();
  }
  await transport.rpc.request('model/list', {});
  await transport.rpc.request('thread/backgroundTerminals/list', { threadId: 'session' });
  await transport.rpc.request('turn/interrupt', { threadId: 'session', turnId: 'turn-1' });
  await transport.stop();
  expect(() => transport.rpc.completed('session', 'turn-1')).toThrow('h06-transport-closed');
});

it.each([null, [], [{ type: 'file', text: 'x' }], [{ type: 'text', text: null }]])(
  'never forwards unchecked turn input %j',
  async (input) => {
    const { options } = fixture();
    const transport = await openH06NativeTransport(options);
    await transport.rpc.request('thread/start', {});
    await expect(transport.rpc.request('turn/start', { ...params(), input })).rejects.toThrow(
      'h06-transport-input',
    );
    expect(options.admitTurn).not.toHaveBeenCalled();
    await transport.stop();
  },
);

it('holds only the first two real implementation turns and binds their actual delivered prompts', async () => {
  const { root, copy, options } = fixture();
  const node = join(root, "node's runtime");
  writeFileSync(node, 'pinned node');
  options.writerStimulus = {
    node: { path: node, sha256: digest('pinned node') },
    minimumMs: 35000,
  };
  const transport = await openH06NativeTransport(options);
  await transport.rpc.request('thread/start', {});
  const operation = (kind: string, attempt: number) => ({
    threadId: 'session',
    input: [
      {
        type: 'text',
        text: `Workflow operation: task-${kind}-${'a'.repeat(64)}-a${attempt}\nВыполни локальный план plan.json.`,
      },
    ],
  });
  const reader = operation('implement', 0);
  await transport.rpc.request('turn/start', reader);
  expect(vi.mocked(options.recordTurn).mock.lastCall?.[0].params.input).toEqual(reader.input);
  const writer = transport.localTasks.createRuntime(copy);
  await writer.initialize();
  await writer.request('thread/start', {});
  for (const kind of ['profile', 'load']) {
    const original = operation(kind, 0);
    await writer.request('turn/start', original);
    expect(vi.mocked(options.recordTurn).mock.lastCall?.[0].params.input).toEqual(original.input);
  }
  for (const attempt of [0, 1, 2]) {
    const original = operation('implement', attempt);
    await writer.admitTurn!(original);
    await writer.request('turn/start', original);
    const admitted = vi.mocked(options.admitTurn).mock.lastCall![0],
      recorded = vi.mocked(options.recordTurn).mock.lastCall![0];
    expect(recorded.params).toEqual(admitted.params);
    expect(
      mock.request.mock.calls.filter(([method]) => method === 'turn/start').at(-1)![1],
    ).toEqual(admitted.params);
    const text = (admitted.params.input as { text: string }[])[0]!.text;
    expect(text.split('\n')[0]).toBe(original.input[0]!.text.split('\n')[0]);
    if (attempt < 2) {
      expect(text).toContain('ПЕРВОЙ командой');
      expect(text).toContain('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,95000)');
      expect(text).toContain("node'\\''s runtime");
      expect(text).toContain('не меняй файлы и не завершай ответ');
    } else expect(text).toBe(original.input[0]!.text);
  }
  await transport.stop();
});

it.each([0, -1, 0.5, 2 ** 31 - 60000, Number.NaN, '35000'])(
  'rejects invalid writer stimulus duration %s before opening any transport',
  async (value) => {
    const { options } = fixture();
    Object.assign(options, { writerStimulus: { node: options.binary, minimumMs: value } });
    await expect(openH06NativeTransport(options)).rejects.toThrow('h06-transport-writer-stimulus');
    expect(mock.port).not.toHaveBeenCalled();
  },
);
it('rejects unexpected stimulus fields and invalid node pins before opening a transport', async () => {
  const { options } = fixture();
  Object.assign(options, {
    writerStimulus: { node: options.binary, minimumMs: 35000, extra: true },
  });
  await expect(openH06NativeTransport(options)).rejects.toThrow('unexpected-field');
  options.writerStimulus = {
    node: { ...options.binary, sha256: '0'.repeat(64) },
    minimumMs: 35000,
  };
  await expect(openH06NativeTransport(options)).rejects.toThrow('h04-pin-changed');
  expect(mock.port).not.toHaveBeenCalled();
});
it('rechecks the stimulus pin after admission and does not dispatch an altered runtime', async () => {
  const { root, copy, options } = fixture(),
    node = join(root, 'node');
  writeFileSync(node, 'pinned node');
  options.writerStimulus = {
    node: { path: node, sha256: digest('pinned node') },
    minimumMs: 35000,
  };
  const transport = await openH06NativeTransport(options),
    writer = transport.localTasks.createRuntime(copy);
  await writer.initialize();
  await writer.request('thread/start', {});
  const turn = {
    threadId: 'session',
    input: [
      {
        type: 'text',
        text: `Workflow operation: task-implement-${'a'.repeat(64)}-a0\nВыполни локальный план plan.json.`,
      },
    ],
  };
  await writer.admitTurn!(turn);
  writeFileSync(node, 'changed');
  await expect(writer.request('turn/start', turn)).rejects.toThrow('h04-pin-changed');
  expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0);
  expect(options.recordTurn).not.toHaveBeenCalled();
  await transport.stop();
});
it('does not let a stimulus bypass malformed turn input validation', async () => {
  const { copy, options } = fixture();
  options.writerStimulus = { node: options.binary, minimumMs: 35000 };
  const transport = await openH06NativeTransport(options),
    writer = transport.localTasks.createRuntime(copy);
  await writer.initialize();
  await writer.request('thread/start', {});
  await expect(writer.request('turn/start', { threadId: 'session', input: [] })).rejects.toThrow(
    'h06-transport-input',
  );
  await transport.stop();
});
