import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../src/adapters/artifacts/files.js';
import type { H04Pin } from './comparisonH04Contract.js';
import {
  captureH06NativeCapabilities,
  checkH06NativeCapabilities,
  type H06NativeCapabilitiesScope,
} from './comparisonH06NativeCapabilities.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(role: 'reader' | 'writer' = 'reader') {
  const evidence = mkdtempSync(join(realpathSync(tmpdir()), 'h06-capabilities-'));
  roots.push(evidence);
  function pin(path: string, bytes: string): H04Pin {
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  }
  const binding: H06NativeCapabilitiesScope = {
    operationId: 'operation',
    binary: pin(join(evidence, 'codex'), 'pinned codex'),
    role,
    root: join(evidence, 'workspace'),
    journal: join(evidence, role + '-0.jsonl'),
    session: 'session',
    profile: { model: 'gpt-6-astra', effort: 'medium', clientVersion: '0.154.0' },
    disabledServers: ['other-tool', 'allowed-tool'],
  };
  const sandbox =
    role === 'writer'
      ? {
          type: 'workspaceWrite',
          writableRoots: [binding.root],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        }
      : { type: 'readOnly', networkAccess: false };
  const response = {
    thread: { id: binding.session, cwd: binding.root },
    cwd: binding.root,
    approvalPolicy: 'never',
    model: binding.profile.model,
    reasoningEffort: binding.profile.effort,
    sandbox,
  };
  const session = {
    kind: 'h06-native-transport-session',
    operationId: binding.operationId,
    role,
    root: binding.root,
    journal: binding.journal,
    session: binding.session,
    method: role === 'writer' ? 'thread/start' : 'thread/resume',
    response,
  };
  const sessionPath = join(evidence, role + '-0-session-0.json');
  const sessionPin = (value: unknown = session, path = sessionPath) =>
    pin(path, JSON.stringify(value));
  const target = join(evidence, role + '-0-session-0-capabilities.json');
  const catalog = {
    data: [
      {
        model: binding.profile.model,
        supportedReasoningEfforts: [{ reasoningEffort: binding.profile.effort }],
      },
    ],
    nextCursor: null,
  };
  const disabled = {
    name: 'allowed-tool',
    runtimeStatus: 'disabled',
    pluginId: null,
    serverInfo: null,
    toolsError: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
  };
  const tools = { data: [disabled], nextCursor: null };
  const request = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>();
  request.mockResolvedValueOnce(catalog).mockResolvedValueOnce(tools);
  const rpc = { request };
  return {
    binding,
    session,
    response,
    sessionPath,
    sessionPin,
    target,
    catalog,
    disabled,
    tools,
    rpc,
    pin,
  };
}

function runtimeWriterResponse(f: ReturnType<typeof fixture>) {
  const root = f.binding.root;
  return {
    ...f.response,
    sandbox: { ...f.response.sandbox, writableRoots: [] as string[] },
    runtimeWorkspaceRoots: [root],
    thread: {
      ...f.response.thread,
      environments: [{ environmentId: 'local', cwd: root, runtimeWorkspaceRoots: [root] }],
    },
  };
}

it.each([false, true])(
  'checks the native runtime workspace with explicit roots=%s',
  async (explicit) => {
    const f = fixture('writer');
    const response = runtimeWriterResponse(f);
    if (explicit) response.sandbox.writableRoots = [f.binding.root];
    const source = f.sessionPin({ ...f.session, response });
    const evidence = await captureH06NativeCapabilities(f.rpc, f.binding, source, f.target);
    expect(checkH06NativeCapabilities(f.binding, source, evidence)).toMatchObject({
      role: 'writer',
      root: f.binding.root,
    });
  },
);

type RuntimeWriterResponse = ReturnType<typeof runtimeWriterResponse>;
const unsafeWriterResponses: [string, (response: RuntimeWriterResponse) => void][] = [
  ['missing-runtime-roots', (r) => Object.assign(r, { runtimeWorkspaceRoots: undefined })],
  ['null-runtime-roots', (r) => Object.assign(r, { runtimeWorkspaceRoots: null })],
  ['empty-runtime-roots', (r) => (r.runtimeWorkspaceRoots = [])],
  ['extra-runtime-root', (r) => r.runtimeWorkspaceRoots.push('/outside')],
  ['missing-environments', (r) => Object.assign(r.thread, { environments: undefined })],
  ['null-environments', (r) => Object.assign(r.thread, { environments: null })],
  ['empty-environments', (r) => (r.thread.environments = [])],
  ['extra-environment', (r) => r.thread.environments.push(r.thread.environments[0]!)],
  ['remote-environment', (r) => (r.thread.environments[0]!.environmentId = 'remote')],
  ['different-environment-cwd', (r) => (r.thread.environments[0]!.cwd = '/outside')],
  ['different-environment-roots', (r) => (r.thread.environments[0]!.runtimeWorkspaceRoots = [])],
  ['extra-writable-root', (r) => (r.sandbox.writableRoots = [r.cwd, '/outside'])],
  ['duplicate-writable-root', (r) => (r.sandbox.writableRoots = [r.cwd, r.cwd])],
  ['null-writable-roots', (r) => Object.assign(r.sandbox, { writableRoots: null })],
  ['network', (r) => Object.assign(r.sandbox, { networkAccess: true })],
  ['slash-tmp', (r) => Object.assign(r.sandbox, { excludeSlashTmp: false })],
  ['environment-tmp', (r) => Object.assign(r.sandbox, { excludeTmpdirEnvVar: false })],
  ['full-access', (r) => Object.assign(r.sandbox, { type: 'dangerFullAccess' })],
  ['cwd', (r) => (r.cwd = '/outside')],
  ['thread-cwd', (r) => (r.thread.cwd = '/outside')],
  ['model', (r) => (r.model = 'other')],
  ['effort', (r) => (r.reasoningEffort = 'high')],
  ['approval', (r) => (r.approvalPolicy = 'on-request')],
];
it.each(unsafeWriterResponses)('rejects native Writer scope drift: %s', async (_name, change) => {
  const f = fixture('writer');
  const response = runtimeWriterResponse(f);
  change(response);
  const source = f.sessionPin({ ...f.session, response });
  await expect(captureH06NativeCapabilities(f.rpc, f.binding, source, f.target)).rejects.toThrow(
    'h06-capabilities-session',
  );
  expect(f.rpc.request).not.toHaveBeenCalled();
  expect(existsSync(f.target)).toBe(false);
});

it.each(['runtime', 'environment'] as const)(
  'rejects contradictory %s metadata even with an explicit writable root',
  async (which) => {
    const f = fixture('writer');
    const response = runtimeWriterResponse(f);
    response.sandbox.writableRoots = [f.binding.root];
    if (which === 'runtime') response.runtimeWorkspaceRoots = ['/outside'];
    else response.thread.environments[0]!.runtimeWorkspaceRoots = ['/outside'];
    const source = f.sessionPin({ ...f.session, response });
    await expect(captureH06NativeCapabilities(f.rpc, f.binding, source, f.target)).rejects.toThrow(
      'h06-capabilities-session',
    );
    expect(f.rpc.request).not.toHaveBeenCalled();
  },
);

it.each(['reader', 'writer'] as const)(
  'captures and checks effective %s inventory',
  async (role) => {
    const f = fixture(role);
    const source = f.sessionPin();
    const evidence = await captureH06NativeCapabilities(f.rpc, f.binding, source, f.target);
    expect(f.rpc.request.mock.calls).toEqual([
      ['model/list', {}],
      ['mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' }],
    ]);
    expect(checkH06NativeCapabilities(f.binding, source, evidence)).toEqual({
      profile: f.binding.profile,
      role,
      root: f.binding.root,
      journal: f.binding.journal,
      session: f.binding.session,
      disabledServers: ['allowed-tool', 'other-tool'],
      observedServers: ['allowed-tool'],
      qualification: false,
    });
    const bytes = readFileSync(f.target);
    expect(JSON.parse(bytes.toString()) as unknown).toMatchObject({
      kind: 'h06-native-capabilities',
      binding: { binary: f.binding.binary, sessionReceipt: source },
      models: f.catalog,
      capabilities: f.tools,
    });
    expect(digest(bytes)).toBe(evidence.sha256);
  },
);

it.each([
  ['role', { role: 'adviser' }],
  ['relative-root', { root: 'relative' }],
  ['uncanonical-root', { root: '/one/../two' }],
  ['foreign-journal', { journal: '/writer-0.jsonl' }],
  [
    'unsupported-client',
    { profile: { model: 'gpt-6-astra', effort: 'medium', clientVersion: 'other' } },
  ],
  ['bad-disabled-name', { disabledServers: ['../tool'] }],
  ['duplicate-disabled', { disabledServers: ['tool', 'tool'] }],
] as const)('rejects invalid scope %s before RPC', async (_name, changes) => {
  const f = fixture();
  const source = f.sessionPin();
  const binding = { ...f.binding, ...changes } as H06NativeCapabilitiesScope;
  await expect(captureH06NativeCapabilities(f.rpc, binding, source, f.target)).rejects.toThrow(
    'h06-capabilities-scope',
  );
  expect(f.rpc.request).not.toHaveBeenCalled();
});

it.each([
  ['/elsewhere/reader-0-session-0.json', 'elsewhere'],
  ['wrong-session-0.json', 'foreign-journal'],
  ['reader-0-session-oops.json', 'non-numeric-index'],
  ['reader-0-session-0.json', 'foreign-evidence'],
])('rejects an unbound path %s (%s)', async (leaf, which) => {
  const f = fixture();
  const source = f.sessionPin();
  const path = which === 'elsewhere' ? leaf : join(f.target, '..', leaf);
  const target = which === 'foreign-evidence' ? f.target + '-other' : f.target;
  await expect(
    captureH06NativeCapabilities(f.rpc, f.binding, { ...source, path }, target),
  ).rejects.toThrow('h06-capabilities-path');
  expect(f.rpc.request).not.toHaveBeenCalled();
});

it.each([
  { kind: 'wrong' },
  { operationId: 'other' },
  { role: 'writer' },
  { root: '/other' },
  { journal: '/other.jsonl' },
  { session: 'other' },
  { method: 'thread/read' },
])('rejects foreign session receipt metadata %j', async (changes) => {
  const f = fixture();
  const source = f.sessionPin({ ...f.session, ...changes });
  await expect(captureH06NativeCapabilities(f.rpc, f.binding, source, f.target)).rejects.toThrow(
    'h06-capabilities-session',
  );
  expect(f.rpc.request).not.toHaveBeenCalled();
});

it.each([
  { thread: { id: 'other', cwd: 'foreign' } },
  { cwd: '/foreign' },
  { approvalPolicy: 'on-request' },
  { model: 'other' },
  { reasoningEffort: 'high' },
  { sandbox: { type: 'readOnly', networkAccess: true } },
])('rejects a different effective profile %j', async (changes) => {
  const f = fixture();
  const source = f.sessionPin({ ...f.session, response: { ...f.response, ...changes } });
  await expect(captureH06NativeCapabilities(f.rpc, f.binding, source, f.target)).rejects.toThrow(
    'h06-capabilities-session',
  );
  expect(f.rpc.request).not.toHaveBeenCalled();
});

it('rejects a mismatched native thread root even when the outer scope matches', async () => {
  const f = fixture();
  const source = f.sessionPin({
    ...f.session,
    response: { ...f.response, thread: { id: f.binding.session, cwd: '/other' } },
  });
  await expect(captureH06NativeCapabilities(f.rpc, f.binding, source, f.target)).rejects.toThrow(
    'h06-capabilities-session',
  );
  expect(f.rpc.request).not.toHaveBeenCalled();
});

it.each([
  [{ data: null }, 'model-inventory'],
  [{ data: [], nextCursor: 'page' }, 'model-inventory'],
  [{ data: [] }, 'model-unavailable'],
  [{ data: [{ model: 'gpt-6-astra', supportedReasoningEfforts: null }] }, 'model-unavailable'],
  [
    { data: [{ model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'other' }] }] },
    'model-unavailable',
  ],
  [{ data: [{ model: 'gpt-6-astra' }, { model: 'gpt-6-astra' }] }, 'model-unavailable'],
] as const)('rejects unavailable or incomplete model evidence %j', async (response, code) => {
  const f = fixture();
  f.rpc.request.mockReset().mockResolvedValueOnce(response).mockResolvedValueOnce(f.tools);
  await expect(
    captureH06NativeCapabilities(f.rpc, f.binding, f.sessionPin(), f.target),
  ).rejects.toThrow('h06-capabilities-' + code);
  expect(existsSync(f.target)).toBe(false);
});

it.each([
  [{ data: [], nextCursor: 'page' }, 'coder-mcp-inventory-incomplete'],
  [{ data: [{ name: 'foreign' }], nextCursor: null }, 'coder-external-tools-enabled'],
] as const)('rejects unsafe or incomplete capability evidence %j', async (response, code) => {
  const f = fixture();
  f.rpc.request.mockReset().mockResolvedValueOnce(f.catalog).mockResolvedValueOnce(response);
  await expect(
    captureH06NativeCapabilities(f.rpc, f.binding, f.sessionPin(), f.target),
  ).rejects.toThrow(code);
  expect(existsSync(f.target)).toBe(false);
});

it('does not publish after the session source changes during observations', async () => {
  const f = fixture();
  const source = f.sessionPin();
  f.rpc.request
    .mockReset()
    .mockResolvedValueOnce(f.catalog)
    .mockImplementationOnce(async () => {
      writeFileSync(source.path, '{}');
      return f.tools;
    });
  await expect(captureH06NativeCapabilities(f.rpc, f.binding, source, f.target)).rejects.toThrow(
    'h04-pin-changed',
  );
  expect(existsSync(f.target)).toBe(false);
});

it('does not overwrite existing evidence', async () => {
  const f = fixture();
  const source = f.sessionPin();
  writeFileSync(f.target, 'existing record');
  await expect(
    captureH06NativeCapabilities(f.rpc, f.binding, source, f.target),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(readFileSync(f.target).toString()).toBe('existing record');
});

it('rejects changed binary bytes and substituted scope when independently checking', async () => {
  const f = fixture();
  const source = f.sessionPin();
  const pin = await captureH06NativeCapabilities(f.rpc, f.binding, source, f.target);
  expect(() =>
    checkH06NativeCapabilities({ ...f.binding, operationId: 'different' }, source, pin),
  ).toThrow('h06-capabilities-binding');
  writeFileSync(f.binding.binary.path, 'different binary');
  expect(() => checkH06NativeCapabilities(f.binding, source, pin)).toThrow('h04-pin-changed');
});

it('rejects repinned content with a wrong kind or unconfirmed model evidence', async () => {
  const f = fixture();
  const source = f.sessionPin();
  const pin = await captureH06NativeCapabilities(f.rpc, f.binding, source, f.target);
  const previous = JSON.parse(readFileSync(pin.path).toString()) as Record<string, unknown>;
  const wrongKind = f.pin(f.target, JSON.stringify({ ...previous, kind: 'other' }));
  expect(() => checkH06NativeCapabilities(f.binding, source, wrongKind)).toThrow(
    'h06-capabilities-binding',
  );
  const badInventory = f.pin(f.target, JSON.stringify({ ...previous, models: { data: [] } }));
  expect(() => checkH06NativeCapabilities(f.binding, source, badInventory)).toThrow(
    'h06-capabilities-model-unavailable',
  );
});
