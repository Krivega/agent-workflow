import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  comparisonSession,
  type ComparisonSessionRequest,
  type ComparisonH01SessionControls,
} from '../adapters/codex/comparisonSession.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { writerScopeHash } from '../adapters/project/writerScope.js';
import type { InputRef } from '../core/localRun.js';
import type { ProcessIdentity } from '../ports/writerProcesses.js';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import type { OwnedWriter } from '../adapters/codex/appServerWriters.js';

const native = vi.hoisted(() => ({
  request: vi.fn(),
  completed: vi.fn(),
  initialize: vi.fn(),
  close: vi.fn(),
  creation: vi.fn(),
  receipt: vi.fn(),
  send: vi.fn(),
  recover: vi.fn(),
  descendants: vi.fn(),
  alive: vi.fn(),
  wait: vi.fn(),
  scope: vi.fn(),
  stop: vi.fn(),
  inventory: vi.fn(),
  compact: vi.fn(),
  reference: vi.fn(),
  pid: 321 as number | undefined,
  constructed: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fsPromises>()) }));
vi.mock('../adapters/codex/appServerTransport.js', () => ({
  StdioAppServer: class {
    constructor(...args: unknown[]) {
      native.constructed(...args);
    }
    get pid() {
      return native.pid;
    }
    request = native.request;
    completed = native.completed;
    initialize = native.initialize;
    close = native.close;
  },
}));
vi.mock('../adapters/codex/appServerSessions.js', () => ({
  AppServerSessions: class {
    send = native.send;
    recoverSend = native.recover;
  },
}));
vi.mock('../adapters/codex/transportJournal.js', () => ({
  nativeCreationProof: native.creation,
  readDeliveryReceipt: native.receipt,
}));
vi.mock('../adapters/codex/writerProcesses.js', () => ({
  NativeWriterProcesses: class {
    descendants = native.descendants;
    alive = native.alive;
    wait = native.wait;
  },
}));
vi.mock('../adapters/codex/appServerWriters.js', () => ({
  ownedRuntimeProcesses: native.scope,
  AppServerWriters: class {
    stop = native.stop;
  },
}));
vi.mock('../adapters/codex/comparisonParticipants.js', () => ({
  comparisonParticipants: native.inventory,
}));
vi.mock('../adapters/codex/comparisonCompaction.js', () => ({
  comparisonCompaction: native.compact,
}));
vi.mock('../adapters/codex/currentChatHost.js', () => ({
  FileCurrentChatHost: class {
    reference = native.reference;
  },
}));

interface State {
  schema_version: number;
  request_hash: string;
  session: { id: string; path: string } | null;
  turn: string | null;
  answer: InputRef | null;
  runtime: { process: ProcessIdentity; policy: InputRef } | null;
  preparation_turn: string | null;
  compaction_intent: boolean;
  compaction: InputRef | null;
}
let root: string,
  request: ComparisonSessionRequest,
  primary: Record<string, unknown>,
  creation: Record<string, unknown> | null;
let terminals: Record<string, unknown>;
let verify: ReturnType<typeof vi.fn<() => Promise<void>>>;
let register: ReturnType<typeof vi.fn<(participant: ComparisonParticipant) => void>>;
const identity = () => ({ pid: 321, parent: process.pid, started: 'owned-native' });
const disabledServer = (name: string) => ({
  name,
  runtimeStatus: null,
  pluginId: null,
  serverInfo: null,
  toolsError: null,
  tools: {},
  resources: [],
  resourceTemplates: [],
});
const statePath = () => resolve(request.directory, 'session.json');
const state = () => readManaged<State>(statePath())!;
const alter = (change: (value: State) => void) => {
  const value = state();
  change(value);
  saveManaged(statePath(), value, false);
};
const run = () => comparisonSession(request, register, verify);

async function controlled() {
  const locator = resolve(root, 'h01-control.json'),
    bytes = '{"test":"control only"}\n';
  await writeFile(locator, bytes);
  request.operation = 'h01-v2:op:execution';
  request.h01_control = { locator, hash: digest(bytes) };
  const original = native.request.getMockImplementation()! as (
    method: string,
    ...args: unknown[]
  ) => Promise<unknown>;
  native.request.mockImplementation(async (method: string, ...args: unknown[]) =>
    method === 'model/list'
      ? {
          data: [
            {
              model: request.profile.model,
              supportedReasoningEfforts: [{ reasoningEffort: request.profile.effort }],
            },
          ],
        }
      : original(method, ...args),
  );
  const controls: ComparisonH01SessionControls = {
    controlRef: request.h01_control,
    signal: new AbortController().signal,
    dispatch: vi.fn<ComparisonH01SessionControls['dispatch']>(async (_method, _params, send) =>
      send(),
    ),
    createdParticipant: vi.fn(),
    observedParticipant: vi.fn(),
    modelProbe: vi.fn(),
  };
  return controls;
}
beforeEach(async () => {
  vi.resetAllMocks();
  native.pid = 321;
  root = await realpath(await mkdtemp(resolve(tmpdir(), 'comparison-session-')));
  request = {
    binary: '/fake/codex',
    directory: resolve(root, 'actor'),
    workspace: resolve(root, 'work/case'),
    state_root: resolve(root, 'work/state'),
    operation: 'operation',
    profile: { model: 'fixture-model', effort: 'high' },
    read_only: false,
    brief: 'fixture only',
    run: 'H-01:1:baseline',
    stage: 'execution',
  };
  await mkdir(request.workspace, { recursive: true });
  await mkdir(request.state_root);
  creation = null;
  terminals = { data: [], nextCursor: null };
  primary = {
    id: 'actor',
    turns: [
      {
        id: 'turn',
        status: 'completed',
        items: [
          { type: 'reasoning', text: 'private' },
          { type: 'agentMessage', text: 'answer' },
        ],
      },
    ],
  };
  native.creation.mockImplementation(() => creation);
  native.receipt.mockReturnValue(null);
  native.send.mockResolvedValue('turn');
  native.recover.mockResolvedValue('turn');
  native.completed.mockImplementation(
    async (_thread: unknown, _turn: unknown, _signal: unknown, guard: () => Promise<void>) => {
      await guard();
    },
  );
  native.descendants.mockResolvedValue([identity()]);
  native.alive.mockResolvedValue([]);
  native.scope.mockImplementation(
    async (
      _rpc: unknown,
      _processes: unknown,
      runtime: ProcessIdentity,
      _thread: string,
      policy: InputRef,
    ) => ({
      runtime: { process: runtime, policy },
      processes: { descendants: async () => [{ pid: 322, parent: 321, started: 'child' }] },
    }),
  );
  native.request.mockImplementation(async (method: string) => {
    if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
    if (method === 'thread/start') {
      creation = {
        response: {
          result: {
            thread: {
              id: 'actor',
              path: resolve(root, 'native.jsonl'),
              projectId: null,
              parentThreadId: null,
              forkedFromId: null,
              turns: [],
            },
            cwd: request.workspace,
            model: request.profile.model,
            reasoningEffort: request.profile.effort,
            approvalPolicy: 'never',
            sandbox: request.read_only
              ? { type: 'readOnly', networkAccess: false }
              : { type: 'dangerFullAccess' },
          },
        },
      };
      return {};
    }
    if (method === 'thread/read') return { thread: primary };
    if (method === 'thread/backgroundTerminals/list') return terminals;
    throw new Error('unexpected RPC: ' + method);
  });
  native.stop.mockImplementation(async (owned: OwnedWriter, path: string) => {
    const hash = await writerScopeHash(owned.markers, owned.tree);
    const proof = {
      kind: 'writers-stopped',
      owned,
      processes: [],
      active_turn: false,
      remaining_terminals: 0,
      remaining_processes: 0,
      before_hash: hash,
      after_hash: hash,
    };
    saveManaged(path, proof, false);
    return { locator: path, hash: digest(canonical(proof) + '\n') };
  });
  native.compact.mockResolvedValue({ locator: '/primary#L4', hash: 'compacted' });
  verify = vi.fn(async () => {});
  register = vi.fn();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it('does not spawn H01 native transport if cancelled during directory preparation', async () => {
  const controls = await controlled(),
    controller = new AbortController();
  controls.signal = controller.signal;
  const actual = fsPromises.mkdir;
  let release!: () => void;
  const pending = new Promise<void>((accept) => {
    release = accept;
  });
  vi.spyOn(fsPromises, 'mkdir').mockImplementation(async (path, options) => {
    await pending;
    return actual(path, options);
  });
  const running = comparisonSession(request, register, verify, controls);
  controller.abort(new Error('cancel during mkdir'));
  release();
  await expect(running).rejects.toThrow('cancel during mkdir');
  expect(native.constructed).not.toHaveBeenCalled();
});

it('binds H01 control into request_hash, probes model, dispatches and forwards the cancellation signal', async () => {
  const controls = await controlled();
  const result = await comparisonSession(request, register, verify, controls);
  expect(result.status).toBe('completed');
  expect(state().request_hash).toBe(digest(canonical(request)));
  expect(controls.modelProbe).toHaveBeenCalledOnce();
  expect(controls.dispatch).toHaveBeenCalledWith('model/list', {}, expect.any(Function));
  expect(controls.createdParticipant).toHaveBeenCalledWith(
    expect.objectContaining({ run: request.run, stage: 'execution' }),
  );
  expect(register).not.toHaveBeenCalled();
  expect(native.completed).toHaveBeenCalledWith(
    'actor',
    'turn',
    controls.signal,
    expect.any(Function),
  );
  await expect(comparisonSession(request, register, verify, controls)).rejects.toThrow(
    'comparison-h01-session-reuse',
  );
});
it('launches H01 with declared MCP disables and binds the same list into its hashed runtime policy', async () => {
  const controls = await controlled();
  const disabled = ['local_tools-1', 'Docs2'];
  Object.assign(request, { disabled_mcp_servers: disabled });
  const original = native.request.getMockImplementation()! as (
    method: string,
    ...args: unknown[]
  ) => Promise<unknown>;
  native.request.mockImplementation((method: string, ...args: unknown[]) =>
    method === 'mcpServerStatus/list'
      ? { data: disabled.map(disabledServer), nextCursor: null }
      : original(method, ...args),
  );
  const result = await comparisonSession(request, register, verify, controls);
  expect(result.status).toBe('completed');
  expect(native.constructed.mock.calls[0]![1]).toEqual([
    '-c',
    'features.apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    'mcp_servers.local_tools-1.enabled=false',
    '-c',
    'mcp_servers.Docs2.enabled=false',
    'app-server',
    '--stdio',
  ]);
  expect(state().request_hash).toBe(digest(canonical(request)));
  const policy = state().runtime!.policy;
  expect(readManaged(policy.locator)).toMatchObject({ disabled_mcp_servers: disabled });
  expect(digest(canonical(readManaged(policy.locator)) + '\n')).toBe(policy.hash);
  Object.assign(request, { disabled_mcp_servers: ['changed'] });
  await expect(comparisonSession(request, register, verify, controls)).rejects.toThrow(
    'comparison-h01-session-reuse',
  );
  expect(native.constructed).toHaveBeenCalledOnce();
});
it.each([null, {}, 'tools', ['duplicate', 'duplicate'], ['bad.name'], [''], [1]])(
  'rejects malformed declared MCP targets before spawning: %o',
  async (targets) => {
    const controls = await controlled();
    Object.assign(request, { disabled_mcp_servers: targets });
    await expect(comparisonSession(request, register, verify, controls)).rejects.toThrow(
      'comparison-mcp-targets-invalid',
    );
    expect(native.constructed).not.toHaveBeenCalled();
    expect(native.send).not.toHaveBeenCalled();
  },
);
it.each([
  { data: [disabledServer('undeclared')], nextCursor: null },
  { data: [{ ...disabledServer('known'), tools: { external: {} } }], nextCursor: null },
  { data: [{ ...disabledServer('known'), resources: [{}] }], nextCursor: null },
  { data: [{ ...disabledServer('known'), runtimeStatus: 'enabled' }], nextCursor: null },
  { data: [{ ...disabledServer('known'), tools: null }], nextCursor: null },
  { data: [disabledServer('known')], nextCursor: 'more' },
  { data: [disabledServer('known'), disabledServer('known')], nextCursor: null },
])('keeps H01 strict deny for an unconfirmed post-disable inventory: %o', async (inventory) => {
  const controls = await controlled();
  request.disabled_mcp_servers = ['known'];
  const original = native.request.getMockImplementation()! as (
    method: string,
    ...args: unknown[]
  ) => Promise<unknown>;
  native.request.mockImplementation((method: string, ...args: unknown[]) =>
    method === 'mcpServerStatus/list' ? inventory : original(method, ...args),
  );
  await expect(comparisonSession(request, register, verify, controls)).rejects.toThrow();
  expect(native.request.mock.calls.some(([method]) => method === 'thread/start')).toBe(false);
  expect(native.send).not.toHaveBeenCalled();
  expect(state().runtime).toBeNull();
});
it('snapshots the declared list before asynchronous setup so caller mutation cannot change CLI or policy', async () => {
  const controls = await controlled();
  const declared = ['known'];
  request.disabled_mcp_servers = declared;
  const bound = canonical(request);
  const original = native.request.getMockImplementation()! as (
    method: string,
    ...args: unknown[]
  ) => Promise<unknown>;
  native.request.mockImplementation((method: string, ...args: unknown[]) =>
    method === 'mcpServerStatus/list'
      ? { data: [disabledServer('known')], nextCursor: null }
      : original(method, ...args),
  );
  const actualMkdir = fsPromises.mkdir;
  vi.spyOn(fsPromises, 'mkdir').mockImplementationOnce(async (path, options) => {
    declared.push('late');
    return actualMkdir(path, options);
  });
  await comparisonSession(request, register, verify, controls);
  expect(state().request_hash).toBe(digest(bound));
  expect(native.constructed.mock.calls[0]![1]).toContain('mcp_servers.known.enabled=false');
  expect(native.constructed.mock.calls[0]![1]).not.toContain('mcp_servers.late.enabled=false');
  expect(readManaged(state().runtime!.policy.locator)).toMatchObject({
    disabled_mcp_servers: ['known'],
  });
});
it('refuses a changed hashed MCP policy without publishing an answer', async () => {
  const controls = await controlled();
  request.disabled_mcp_servers = ['known'];
  native.completed.mockImplementationOnce(async () => {
    const policy = state().runtime!.policy;
    saveManaged(
      policy.locator,
      {
        ...readManaged<Record<string, unknown>>(policy.locator),
        disabled_mcp_servers: ['foreign'],
      },
      false,
    );
  });
  await expect(comparisonSession(request, register, verify, controls)).rejects.toThrow(
    'comparison-writer-policy-changed',
  );
  expect(state().answer).toBeNull();
});
it('does not change non-H01 launch or policy when MCP targets are supplied', async () => {
  request.disabled_mcp_servers = ['known'];
  expect((await run()).status).toBe('completed');
  expect(native.constructed.mock.calls[0]![1]).toEqual(['app-server']);
  expect(readManaged(state().runtime!.policy.locator)).not.toHaveProperty('disabled_mcp_servers');
});
it('does not let a non-H01 target list authorize a configured MCP server', async () => {
  request.disabled_mcp_servers = ['known'];
  native.request.mockResolvedValue({ data: [disabledServer('known')], nextCursor: null });
  await expect(run()).rejects.toThrow('coder-external-tools-enabled');
  expect(native.send).not.toHaveBeenCalled();
});
it('refuses H01 requests through the old three-argument entrypoint or a changed/missing control', async () => {
  const controls = await controlled();
  await expect(run()).rejects.toThrow('comparison-h01-control-required');
  await expect(
    comparisonSession(request, register, verify, {
      ...controls,
      controlRef: { ...controls.controlRef, hash: 'changed' },
    }),
  ).rejects.toThrow('comparison-h01-control-required');
  await writeFile(controls.controlRef.locator, 'changed');
  await expect(comparisonSession(request, register, verify, controls)).rejects.toThrow(
    'comparison-h01-control-changed',
  );
  delete request.h01_control;
  await expect(comparisonSession(request, register, verify, controls)).rejects.toThrow(
    'comparison-h01-control-required',
  );
  request.operation = 'old-default';
  request.h01_control = controls.controlRef;
  await expect(run()).rejects.toThrow('comparison-h01-control-required');
  expect(native.initialize).not.toHaveBeenCalled();
});
it('refuses an aborted H01 control before native bootstrap', async () => {
  const controls = await controlled(),
    controller = new AbortController();
  controller.abort(new Error('test abort'));
  await expect(
    comparisonSession(request, register, verify, { ...controls, signal: controller.signal }),
  ).rejects.toThrow('test abort');
  expect(native.initialize).not.toHaveBeenCalled();
});
it.each([
  {},
  { data: [] },
  { data: [{ model: 'wrong', supportedReasoningEfforts: [] }] },
  { data: [{ model: 'fixture-model' }] },
  { data: [{ model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'wrong' }] }] },
])('fails H01 unsupported model/effort before model start %o', async (models) => {
  const controls = await controlled(),
    original = native.request.getMockImplementation()! as (
      method: string,
      ...args: unknown[]
    ) => Promise<unknown>;
  native.request.mockImplementation((method: string, ...args: unknown[]) =>
    method === 'model/list' ? models : original(method, ...args),
  );
  await expect(comparisonSession(request, register, verify, controls)).rejects.toThrow(
    'comparison-model-unavailable',
  );
  expect(native.send).not.toHaveBeenCalled();
});

it('persists create/send intent, verifies primary completion, stops writers and replays without another effect', async () => {
  const result = await run();
  expect(result).toMatchObject({ text: 'answer', status: 'completed' });
  expect(readManaged(result.source.locator)).toMatchObject({
    items: [{ type: 'agentMessage', text: 'answer' }],
  });
  expect(native.send).toHaveBeenCalledOnce();
  expect(native.stop).toHaveBeenCalledOnce();
  expect(native.inventory).toHaveBeenCalled();
  expect(native.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({ sandbox: 'danger-full-access', allowProviderModelFallback: false }),
  );
  expect(register).toHaveBeenCalledWith(
    expect.objectContaining({ session: 'actor', stage: 'execution' }),
  );
  expect(await run()).toEqual(result);
  expect(native.send).toHaveBeenCalledOnce();
  expect(native.initialize).toHaveBeenCalledOnce();
});
it('uses a fresh read-only reviewer and can reconcile known delivery receipts', async () => {
  vi.stubEnv('PATH', undefined);
  request.read_only = true;
  request.stage = 'council';
  native.receipt.mockReturnValue({ turn: 'turn' });
  await run();
  expect(native.send).not.toHaveBeenCalled();
  expect(native.recover).toHaveBeenCalledOnce();
  expect(native.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({ sandbox: 'read-only' }),
  );
});
it('performs a real same-session compact between preparation and implementation, retaining the primary source', async () => {
  request.run = 'H-03:1:candidate';
  native.send.mockResolvedValueOnce('prep').mockResolvedValueOnce('turn');
  await run();
  expect(state()).toMatchObject({
    preparation_turn: 'prep',
    compaction_intent: true,
    compaction: { hash: 'compacted' },
  });
  expect(native.completed).toHaveBeenCalledTimes(2);
  expect(native.compact).toHaveBeenCalledOnce();
  expect(native.send.mock.calls[1]![1]).toContain('новым наблюдаемым LOAD');
});
it('recovers preparation/delivery in the same session and verifies an existing compact source', async () => {
  request.run = 'H-03:1:candidate';
  native.receipt.mockReturnValue({ turn: 'turn' });
  native.recover.mockResolvedValueOnce('prep').mockResolvedValueOnce('turn');
  native.compact.mockRejectedValueOnce(new Error('compact reply lost'));
  await expect(run()).rejects.toThrow('compact reply lost');
  alter((s) => {
    s.compaction = { locator: '/primary', hash: 'proven' };
  });
  await run();
  expect(native.reference).toHaveBeenCalledWith({ locator: '/primary', hash: 'proven' });
  expect(native.send).not.toHaveBeenCalled();
  expect(native.compact).toHaveBeenCalledOnce();
});
it('does not repeat an unknown compaction or create after a lost response', async () => {
  request.run = 'H-03:1:candidate';
  native.compact.mockRejectedValueOnce(new Error('lost'));
  await expect(run()).rejects.toThrow('lost');
  await expect(run()).rejects.toThrow('comparison-compaction-outcome-unknown');
  expect(native.compact).toHaveBeenCalledOnce();
  await rm(request.directory, { recursive: true });
  request.run = 'H-01:1:baseline';
  creation = null;
  native.creation.mockReturnValue(null);
  await expect(run()).rejects.toThrow('comparison-creation-outcome-unknown');
  await expect(run()).rejects.toThrow('comparison-creation-outcome-unknown');
  expect(native.request.mock.calls.filter((call) => call[0] === 'thread/start')).toHaveLength(2);
});
it('blocks unknown sends, missing receipts and a changed accepted request', async () => {
  native.send.mockRejectedValueOnce(new Error('send reply lost'));
  await expect(run()).rejects.toThrow('send reply lost');
  await expect(run()).rejects.toThrow('comparison-delivery-outcome-unknown');
  expect(native.send).toHaveBeenCalledOnce();
  request.brief = 'different';
  await expect(run()).rejects.toThrow('comparison-session-conflict');
});
it.each(['failed', 'interrupted'])(
  'records known native terminal status %s without inventing an answer',
  async (status) => {
    primary.turns = [{ id: 'turn', status, items: [] }];
    expect(await run()).toMatchObject({ text: '', status });
  },
);
it('binds terminals with an absent OS PID to the owned process scope and an active turn', async () => {
  terminals = {
    data: [
      { processId: 'terminal-a', osPid: null },
      { processId: 'terminal-b', osPid: 322 },
    ],
  };
  primary.turns = [
    { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'answer' }] },
    { id: 'active', status: 'inProgress', items: [] },
  ];
  await run();
  expect(native.stop).toHaveBeenCalledWith(
    expect.objectContaining({
      turn: 'active',
      bindings: [expect.objectContaining({ terminal: 'terminal-a' })],
    }),
    expect.any(String),
  );
});
it.each([
  [
    'comparison-native-history-unconfirmed',
    () => {
      primary.id = 'foreign';
    },
  ],
  [
    'comparison-native-turn-failed',
    () => {
      primary.turns = [];
    },
  ],
  [
    'comparison-native-turn-failed',
    () => {
      primary.turns = [{ id: 'turn', status: 'inProgress', items: [] }];
    },
  ],
  [
    'comparison-terminals-incomplete',
    () => {
      terminals.nextCursor = 'more';
    },
  ],
  [
    'comparison-native-turn-unconfirmed',
    () => {
      primary.turns = [
        { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'a' }] },
        { id: 'a', status: 'inProgress' },
        { id: 'b', status: 'inProgress' },
      ];
    },
  ],
  [
    'writer-process-binding-missing',
    () => {
      terminals.data = [{ processId: 'x', osPid: null }];
      native.scope.mockResolvedValue({ processes: { descendants: async () => [] } });
    },
  ],
])('refuses incomplete terminal and process evidence: %s', async (error, change) => {
  change();
  await expect(run()).rejects.toThrow(error);
  expect(native.close).toHaveBeenCalledOnce();
});
it('rejects profile or identity changes before another delivery', async () => {
  native.send.mockRejectedValueOnce(new Error('hold'));
  await expect(run()).rejects.toThrow('hold');
  const result = (creation!.response as { result: Record<string, unknown> }).result;
  result.model = 'other';
  await expect(run()).rejects.toThrow('comparison-native-profile-unconfirmed');
  result.model = request.profile.model;
  (result.thread as { id: string }).id = 'other';
  await expect(run()).rejects.toThrow('comparison-session-identity-mismatch');
});
it('refuses unknown runtime ownership and closes on cancellation before create', async () => {
  native.pid = undefined;
  await expect(run()).rejects.toThrow('comparison-native-process-unknown');
  await rm(request.directory, { recursive: true });
  native.pid = 321;
  native.descendants.mockResolvedValue([]);
  await expect(run()).rejects.toThrow('comparison-native-process-unknown');
  await rm(request.directory, { recursive: true });
  verify.mockRejectedValueOnce(new Error('revoked'));
  await expect(run()).rejects.toThrow('revoked');
  expect(native.send).not.toHaveBeenCalled();
});
it('waits for native server exit and refuses a server which remains alive', async () => {
  native.alive
    .mockResolvedValueOnce([identity()])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
  await run();
  expect(native.wait).toHaveBeenCalledWith(100);
  alter((s) => {
    s.answer = null;
  });
  native.alive.mockResolvedValue([identity()]);
  await expect(run()).rejects.toThrow('comparison-native-process-still-running');
});
it.each([
  [
    'comparison-answer-changed',
    async () => {
      const s = state();
      await writeFile(s.answer!.locator, '{}');
    },
  ],
  [
    'comparison-stop-unconfirmed',
    async () => {
      const path = resolve(request.directory, 'stopped.json');
      saveManaged(path, {}, false);
    },
  ],
  [
    'comparison-stop-unconfirmed',
    async () => {
      await writeFile(resolve(request.workspace, 'late-write'), 'late');
    },
  ],
  [
    'comparison-stop-unconfirmed',
    async () => {
      native.alive.mockResolvedValue([identity()]);
    },
  ],
])('refuses cached results whose stop or answer proof changed: %s', async (error, change) => {
  await run();
  await change();
  await expect(run()).rejects.toThrow(error);
  expect(native.send).toHaveBeenCalledOnce();
});
