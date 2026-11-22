import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import { resolve } from 'node:path';
import * as files from '../adapters/storage/storeFiles.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import {
  h01GrantText,
  h01RawFile,
  h01ReadJson,
  h01ReadPin,
  h01Record,
  h01RequestHash,
  parseH01Bootstrap,
  parseH01GuardDescriptor,
  parseH01Profile,
  parseH01Request,
  parseH01Runtime,
  observeH01Authorization,
  verifyH01Authorization,
  verifyH01GuardAuthorization,
  requestScenario,
  type H01ExecutionRequest,
  type H01GuardDescriptor,
} from './comparisonH01Contract.js';

vi.mock('node:os', async (original) => ({ ...(await original<typeof os>()) }));
vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock('../adapters/storage/storeFiles.js', async (original) => ({
  ...(await original<typeof files>()),
}));
let root: string, request: H01ExecutionRequest;
const pin = (name: string, value: unknown): InputRef => {
  const locator = resolve(root, name),
    bytes = typeof value === 'string' ? value : canonical(value);
  fs.writeFileSync(locator, bytes, { flag: 'wx' });
  return { locator, hash: digest(bytes) };
};
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(resolve(tmpdir(), 'h01-contract-')));
  fs.mkdirSync(resolve(root, 'sessions'));
  vi.stubEnv('CODEX_HOME', root);
  const binary = pin('binary', 'not executed'),
    rules = pin('rules', 'rules');
  const profile = pin('profile', {
    model: 'fixture',
    effort: 'high',
    clientVersion: 'pinned',
    binary,
    rules,
    executor: rules,
    reviewer: rules,
  });
  request = {
    kind: 'comparison-h01-execution',
    executionVersion: 2,
    opId: 'H01-test',
    variant: 'baseline',
    material: rules,
    criteria: rules,
    profile,
    runtime: pin('runtime', { engine: 'legacy', root, files: [rules] }),
    bootstrap: pin('bootstrap', {
      engine: 'legacy',
      runtimeRoot: resolve(root, 'state/legacy-runtime'),
      modulesRoot: root,
      overlay: rules,
    }),
    roots: {
      workspaceRoot: resolve(root, 'workspace'),
      evidenceRoot: resolve(root, 'evidence'),
      artifactRoot: resolve(root, 'artifacts'),
      hostRoot: resolve(root, 'host'),
      stateRoot: resolve(root, 'state'),
    },
    identity: { taskId: 'task', owner: 'owner', generation: 1 },
    budget: {
      maxManagedStarts: 4,
      maxElapsedMs: 1000,
      maxInputUncached: 100,
      maxOutput: 50,
      reserveMs: 100,
    },
    authorization: {
      root,
      transcript: resolve(root, 'sessions/native.jsonl'),
      anchor: {
        thread_id: 'primary',
        turn_id: 'turn',
        workspace: root,
        host_id: 'local',
      },
      source: {
        locator: resolve(root, 'sessions/native.jsonl') + '#L4',
        hash: 'a'.repeat(64),
      },
      requestHash: '',
    },
  };
  request.authorization.requestHash = h01RequestHash(request);
  fs.mkdirSync(request.roots.evidenceRoot);
  vi.stubEnv('CODEX_THREAD_ID', 'primary');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it('binds explicit MCP disable targets without changing historical profiles', () => {
  const original = parseH01Profile(request.profile);
  expect(original).not.toHaveProperty('disabledMcpServers');
  const before = h01RequestHash(request);
  const disabledMcpServers = ['disabled-one', 'disabled_two'];
  request.profile = pin('profile-with-mcp-targets', {
    ...original,
    disabledMcpServers,
  });
  expect(parseH01Profile(request.profile)).toEqual({
    ...original,
    disabledMcpServers,
  });
  expect(h01RequestHash(request)).not.toBe(before);
  fs.writeFileSync(
    request.profile.locator,
    canonical({ ...original, disabledMcpServers: ['changed'] }),
  );
  expect(() => parseH01Profile(request.profile)).toThrow('h01-pin');
});
it.each([
  null,
  'server',
  {},
  1,
  [1],
  [''],
  ['duplicate', 'duplicate'],
  ['name.with.dot'],
  ['bad=key'],
  ['bad\nkey'],
])('rejects malformed explicit MCP disable targets %j', (disabledMcpServers) => {
  request.profile = pin('invalid-mcp-profile', {
    ...parseH01Profile(request.profile),
    disabledMcpServers,
  });
  expect(() => parseH01Profile(request.profile)).toThrow('h01-mcp-disabled-targets');
});
it('accepts an explicit empty MCP disable list while preserving the strict profile schema', () => {
  const profile = {
    ...parseH01Profile(request.profile),
    disabledMcpServers: [],
  };
  expect(parseH01Profile(pin('empty-mcp-targets', profile))).toEqual(profile);
  expect(() => parseH01Profile(pin('unknown-profile-field', { ...profile, extra: true }))).toThrow(
    'h01-fields',
  );
});
function primary(body = h01GrantText(request)) {
  const lines = [
    {
      type: 'session_meta',
      payload: {
        id: 'primary',
        session_id: 'primary',
        cwd: root,
        cli_version: '0.164.0-alpha.11.1',
      },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'turn_context',
      payload: {
        turn_id: 'turn',
        cwd: root,
        model: 'fixture',
        effort: 'high',
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: body }],
      },
    },
  ].map((line) => JSON.stringify(line));
  fs.writeFileSync(request.authorization.transcript, lines.join('\n') + '\n');
  request.authorization.source.hash = digest(lines[3]! + '\n');
}
function descriptor() {
  const profile = parseH01Profile(request.profile);
  return {
    kind: 'comparison-h01-guard',
    executionVersion: 2,
    opId: request.opId,
    requestHash: h01RequestHash(request),
    request: pin('request', request),
    variant: request.variant,
    roots: request.roots,
    budget: request.budget,
    profile: {
      model: profile.model,
      effort: profile.effort,
      clientVersion: profile.clientVersion,
    },
    binary: profile.binary,
    authorization: request.authorization,
    pins: [request.profile],
    startedNs: '10',
    deadlineNs: '1000000010',
    workDeadlineNs: '900000010',
  } satisfies H01GuardDescriptor;
}
it('separates H02 requests, primary grants and guard descriptors from H01', async () => {
  const original = h01GrantText(request);
  request.kind = 'comparison-h02-execution';
  request.authorization.requestHash = h01RequestHash(request);
  expect(requestScenario(request)).toBe('H-02');
  expect(() => requestScenario({ kind: 'comparison-h06-execution' })).toThrow(
    'comparison-scenario-kind',
  );
  expect(() => parseH01Request(request)).toThrow('h01-version');
  expect(parseH01Request(request, 'run', 'H-02')).toEqual(request);
  expect(h01GrantText(request)).toContain('comparison-h02-grant');
  primary(original);
  await expect(observeH01Authorization(request)).rejects.toThrow('h01-authority-body');
  primary();
  expect((await observeH01Authorization(request)).kind).toBe(
    'comparison-h02-authorization-observation',
  );
  const control: H01GuardDescriptor = { ...descriptor(), kind: 'comparison-h02-guard' };
  const ref = pin('h02-control', control);
  expect(() => parseH01GuardDescriptor(ref)).toThrow('h01-guard-version');
  expect(parseH01GuardDescriptor(ref, 'H-02')).toEqual(control);
  await expect(verifyH01GuardAuthorization(control)).resolves.toBeUndefined();
  request.kind = 'comparison-h01-execution';
  expect(() => parseH01Request(request, 'run', 'H-02')).toThrow('h01-version');
});

it.each(['H-03', 'H-04', 'H-05'] as const)(
  'requires its own exact %s primary grant and guard while retaining earlier defaults',
  async (scenario) => {
    const oldGrant = h01GrantText(request);
    const label = scenario === 'H-03' ? 'h03' : scenario === 'H-04' ? 'h04' : 'h05';
    request.kind = `comparison-${label}-execution`;
    if (scenario === 'H-05') {
      expect(() => parseH01Request(request, 'plan', scenario)).toThrow('h05-generation-required');
      request.identity.generation = 2;
    }
    request.authorization.requestHash = h01RequestHash(request);
    expect(requestScenario(request)).toBe(scenario);
    expect(() => parseH01Request(request)).toThrow('h01-version');
    expect(() => parseH01Request(request, 'run', 'H-02')).toThrow('h01-version');
    if (scenario !== 'H-03')
      expect(() => parseH01Request(request, 'run', 'H-03')).toThrow('h01-version');
    if (scenario === 'H-05')
      expect(() => parseH01Request(request, 'run', 'H-04')).toThrow('h01-version');
    expect(parseH01Request(request, 'run', scenario)).toEqual(request);
    primary(oldGrant);
    await expect(observeH01Authorization(request)).rejects.toThrow('h01-authority-body');
    if (scenario !== 'H-03') {
      primary(h01GrantText({ ...request, kind: 'comparison-h03-execution' }));
      await expect(observeH01Authorization(request)).rejects.toThrow('h01-authority-body');
    }
    if (scenario === 'H-05') {
      primary(h01GrantText({ ...request, kind: 'comparison-h04-execution' }));
      await expect(observeH01Authorization(request)).rejects.toThrow('h01-authority-body');
    }
    primary();
    expect((await observeH01Authorization(request)).kind).toBe(
      `comparison-${label}-authorization-observation`,
    );
    const control: H01GuardDescriptor = { ...descriptor(), kind: `comparison-${label}-guard` };
    const ref = pin(label + '-control', control);
    expect(() => parseH01GuardDescriptor(ref)).toThrow('h01-guard-version');
    expect(() => parseH01GuardDescriptor(ref, 'H-02')).toThrow('h01-guard-version');
    if (scenario !== 'H-03')
      expect(() => parseH01GuardDescriptor(ref, 'H-03')).toThrow('h01-guard-version');
    if (scenario === 'H-05')
      expect(() => parseH01GuardDescriptor(ref, 'H-04')).toThrow('h01-guard-version');
    expect(parseH01GuardDescriptor(ref, scenario)).toEqual(control);
    await expect(verifyH01GuardAuthorization(control)).resolves.toBeUndefined();
  },
);
it('pins explicit budgets, delivery-independent grant text and strict physical source bytes', async () => {
  expect(parseH01Request(request)).toEqual(request);
  const hash = h01RequestHash(request);
  request.authorization.anchor.turn_id = 'later';
  request.authorization.source = { locator: '', hash: '' };
  request.authorization.requestHash = '';
  expect(h01RequestHash(request)).toBe(hash);
  expect(parseH01Request(request, 'plan')).toEqual(request);
  expect(h01GrantText(request)).toContain('"maxManagedStarts":4');
  expect(() => parseH01Request(request)).toThrow();
  expect(parseH01Runtime(request.runtime, 'baseline').files).toHaveLength(1);
  expect(parseH01Bootstrap(request.bootstrap, 'baseline').engine).toBe('legacy');
});
it.each([
  ['kind', 'wrong'],
  ['executionVersion', 1],
  ['variant', 'other'],
  ['opId', ''],
  ['budget.maxManagedStarts', 0],
  ['budget.maxOutput', 1.5],
  ['budget.reserveMs', 1000],
  ['identity.generation', 0],
  ['identity.owner', ''],
  ['identity.taskId', ''],
  ['roots.hostRoot', '/x/../y'],
  ['roots.stateRoot', '/relative\n'],
  ['authorization.anchor.host_id', 'remote'],
  ['authorization.anchor.workspace', '/elsewhere'],
  ['authorization.anchor.turn_id', ''],
  ['authorization.anchor.thread_id', ''],
  ['authorization.source.hash', 'wrong'],
  ['authorization.source.locator', '/wrong#L1'],
  ['authorization.requestHash', 'wrong'],
  ['material.hash', 'wrong'],
  ['material.locator', 'relative'],
])('refuses malformed %s', (path, value) => {
  const copy = structuredClone(request) as unknown as Record<string, unknown>;
  const parts = path.split('.');
  let parent = copy;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  parent[parts.at(-1)!] = value;
  expect(() => parseH01Request(copy)).toThrow();
});
it('refuses extra keys, overlapping roots and dishonest plan placeholders', () => {
  expect(() => parseH01Request({ ...request, extra: true })).toThrow();
  request.roots.hostRoot = resolve(request.roots.workspaceRoot, 'host');
  expect(() => parseH01Request(request)).toThrow('h01-roots-overlap');
  request.roots.hostRoot = request.roots.stateRoot;
  expect(() => parseH01Request(request)).toThrow('h01-roots-overlap');
  request.roots.hostRoot = resolve(root, 'host');
  (request.authorization.anchor as unknown as Record<string, unknown>).turn_id = 1;
  expect(() => parseH01Request(request, 'plan')).toThrow();
});
it('publishes immutable observations, never resolves AWLOCATION data, and refuses links/changed bytes', () => {
  const data = h01Record(root, 'observation', {
    raw: 'AWLOCATION 1\nanything',
  });
  expect(h01Record(root, 'observation', { raw: 'AWLOCATION 1\nanything' })).toEqual(data);
  expect(h01ReadJson(data)).toEqual({ raw: 'AWLOCATION 1\nanything' });
  expect(() => h01ReadPin({ ...data, hash: 'a'.repeat(64) })).toThrow('h01-pin-changed');
  expect(() => h01Record(root, '../escape', {})).toThrow();
  fs.symlinkSync(data.locator, resolve(root, 'link'));
  expect(() => h01RawFile(resolve(root, 'link'))).toThrow('h01-file-alias');
  fs.linkSync(data.locator, resolve(root, 'hardlink'));
  expect(() => h01RawFile(data.locator)).toThrow('h01-file-kind');
  expect(() => h01RawFile(root)).toThrow();
});
it('propagates observation publication failures instead of treating them as an existing proof', () => {
  vi.spyOn(files, 'writePrivateFile').mockImplementationOnce(() => {
    throw new Error('disk failure');
  });
  expect(() => h01Record(root, 'failure', {})).toThrow('disk failure');
});
it('closes opened descriptors without reading after path replacement', () => {
  const file = pin('race', 'before');
  const opened = fs.fstatSync;
  const read = vi.spyOn(fs, 'readFileSync');
  const close = vi.spyOn(fs, 'closeSync');
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
    const stat = opened(fd);
    fs.renameSync(file.locator, file.locator + '.old');
    fs.writeFileSync(file.locator, 'outside');
    return stat;
  });
  expect(() => h01RawFile(file.locator)).toThrow('h01-file-changed');
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
it('detects changes during a read and closes the descriptor', () => {
  const file = pin('race', 'before');
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementationOnce((fd) => {
    const bytes = read(fd);
    fs.writeFileSync(file.locator, 'changed');
    return bytes;
  });
  const close = vi.spyOn(fs, 'closeSync');
  expect(() => h01RawFile(file.locator)).toThrow('h01-file-changed');
  expect(close).toHaveBeenCalledOnce();
});
it.each(['продолжай', '"quoted"', 'Do this?', '{"kind":"comparison-h01-grant"}'])(
  'refuses noncanonical human body %s',
  async (body) => {
    primary(body);
    await expect(verifyH01Authorization(request)).rejects.toThrow('h01-authority-body');
  },
);
it('verifies the actual latest primary line while nested guards do not require child thread env', async () => {
  primary();
  const proof = await verifyH01Authorization(request);
  expect(h01ReadJson(proof)).toMatchObject({
    context: { threadId: 'primary', owner: 'owner' },
    source: request.authorization.source,
  });
  const desc = descriptor();
  const ref = pin('descriptor', desc);
  expect(parseH01GuardDescriptor(ref)).toEqual(desc);
  vi.stubEnv('CODEX_THREAD_ID', 'child');
  await expect(verifyH01GuardAuthorization(desc)).resolves.toBeUndefined();
  await expect(verifyH01Authorization(request)).rejects.toThrow('h01-root-thread');
  await expect(verifyH01GuardAuthorization({ ...desc, opId: 'other' })).rejects.toThrow(
    'h01-guard-binding',
  );
  await expect(
    verifyH01GuardAuthorization({
      ...desc,
      profile: { ...desc.profile, model: 'other' },
    }),
  ).rejects.toThrow('h01-guard-profile');
});
it('observes primary authorization without creating evidence or issuing a grant', async () => {
  primary();
  fs.rmSync(request.roots.evidenceRoot, { recursive: true });
  const write = vi.spyOn(fs, 'writeFileSync'),
    mkdir = vi.spyOn(fs, 'mkdirSync');
  const observation = await observeH01Authorization(request);
  expect(observation).toMatchObject({
    source: request.authorization.source,
    context: { threadId: 'primary' },
  });
  expect(write).not.toHaveBeenCalled();
  expect(mkdir).not.toHaveBeenCalled();
  expect(fs.existsSync(request.roots.evidenceRoot)).toBe(false);
  vi.stubEnv('CODEX_THREAD_ID', 'nested');
  await expect(observeH01Authorization(request)).rejects.toThrow('h01-root-thread');
});
it('rejects a complete synthetic transcript outside native sessions even with matching thread/cwd/turn/grant', async () => {
  request.authorization.transcript = resolve(root, 'synthetic.jsonl');
  request.authorization.source.locator = request.authorization.transcript + '#L4';
  request.authorization.requestHash = h01RequestHash(request);
  primary();
  await expect(verifyH01Authorization(request)).rejects.toThrow('h01-native-primary-source');
});
it('uses the host home native sessions default when CODEX_HOME is absent', async () => {
  vi.stubEnv('CODEX_HOME', undefined);
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  fs.mkdirSync(resolve(root, '.codex/sessions'), { recursive: true });
  request.authorization.transcript = resolve(root, '.codex/sessions/native.jsonl');
  request.authorization.source.locator = request.authorization.transcript + '#L4';
  request.authorization.requestHash = h01RequestHash(request);
  primary();
  await expect(verifyH01Authorization(request)).resolves.toBeDefined();
});
it('rejects stale metadata/hash, partial transcript, extra content, superseded primary and wrong line', async () => {
  primary();
  const original = fs.readFileSync(request.authorization.transcript, 'utf8');
  request.authorization.requestHash = 'b'.repeat(64);
  await expect(verifyH01Authorization(request)).rejects.toThrow('h01-authorization-binding');
  request.authorization.requestHash = h01RequestHash(request);
  fs.writeFileSync(request.authorization.transcript, original.trimEnd());
  await expect(verifyH01Authorization(request)).rejects.toThrow();
  fs.writeFileSync(
    request.authorization.transcript,
    original +
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'later' }],
        },
      }) +
      '\n',
  );
  await expect(verifyH01Authorization(request)).rejects.toThrow(
    'chat-continuation-human-superseded',
  );
  fs.writeFileSync(request.authorization.transcript, original);
  request.authorization.source.hash = 'b'.repeat(64);
  await expect(verifyH01Authorization(request)).rejects.toThrow();
});
it('binds candidate issuer to actual primary thread/workspace/owner and sessions root', async () => {
  request.variant = 'candidate';
  const issuer = {
    sessionsRoot: resolve(root, 'sessions'),
    workspaceRoot: root,
    threadId: 'primary',
    owner: 'owner',
  };
  request.bootstrap = pin('temporal-bootstrap', {
    engine: 'temporal',
    address: '[::1]:7233',
    namespace: 'default',
    taskQueue: 'h01',
    workflowsPath: resolve(root, 'workflows.ts'),
    issuer,
  });
  request.authorization.requestHash = h01RequestHash(request);
  primary();
  expect(h01ReadJson(await verifyH01Authorization(request))).toMatchObject({
    issuer,
  });
  issuer.owner = 'different';
  request.bootstrap = pin('wrong-bootstrap', {
    engine: 'temporal',
    address: 'localhost:7233',
    namespace: 'default',
    taskQueue: 'h01',
    workflowsPath: resolve(root, 'workflows.ts'),
    issuer,
  });
  request.authorization.requestHash = h01RequestHash(request);
  primary();
  await expect(verifyH01Authorization(request)).rejects.toThrow('h01-issuer-binding');
});
it.each(['remote:7233', 'https://localhost:7233', '127.0.0.1:65536', 'localhost:0'])(
  'rejects remote or invalid endpoint %s',
  (address) => {
    const ref = pin('remote', {
      engine: 'temporal',
      address,
      namespace: 'default',
      taskQueue: 'q',
      workflowsPath: resolve(root, 'w'),
      issuer: {
        sessionsRoot: resolve(root, 'sessions'),
        workspaceRoot: root,
        threadId: 't',
        owner: 'o',
      },
    });
    expect(() => parseH01Bootstrap(ref, 'candidate')).toThrow('h01-temporal-loopback');
  },
);
it('refuses runtime engine/root/duplicate/escape and strict descriptor clock/version/pins', () => {
  expect(() => parseH01Runtime(request.runtime, 'candidate')).toThrow('h01-engine');
  const rules = parseH01Profile(request.profile).rules;
  for (const [name, value] of Object.entries({
    empty: [],
    duplicate: [rules, rules],
    escape: [{ locator: '/outside', hash: rules.hash }],
  })) {
    const ref = pin(name, { engine: 'legacy', root, files: value });
    expect(() => parseH01Runtime(ref, 'baseline')).toThrow();
  }
  const desc = descriptor();
  for (const [i, change] of [
    { kind: 'wrong' },
    { opId: 'wrong' },
    { pins: [] },
    { deadlineNs: 'wrong' },
    { workDeadlineNs: '1' },
    { deadlineNs: '1' },
  ].entries())
    expect(() => parseH01GuardDescriptor(pin('bad-desc-' + i, { ...desc, ...change }))).toThrow();
});

it('accepts one native delivery LF while preserving the raw primary source binding', async () => {
  const expected = h01GrantText(request);
  expect(expected.endsWith('\n')).toBe(false);
  primary(expected + '\n');
  const source = { ...request.authorization.source };
  const bytes = fs.readFileSync(request.authorization.transcript);
  const observed = await observeH01Authorization(request);
  expect(observed.source).toEqual(source);
  expect(fs.readFileSync(request.authorization.transcript)).toEqual(bytes);
  expect(request.authorization.source).toEqual(source);
  const proof = await verifyH01Authorization(request);
  expect(h01ReadJson(proof)).toMatchObject({ source });
  await expect(verifyH01GuardAuthorization(descriptor())).resolves.toBeUndefined();
});

it.each([
  'two-LF',
  'leading-space',
  'trailing-space',
  'leading-LF',
  'CR',
  'CRLF',
  'quoted',
  'wrapper',
])('refuses noncanonical delivery padding or wrapping: %s', async (kind) => {
  const expected = h01GrantText(request);
  const bodies: Record<string, string> = {
    'two-LF': expected + '\n\n',
    'leading-space': ' ' + expected,
    'trailing-space': expected + ' ',
    'leading-LF': '\n' + expected,
    CR: expected + '\r',
    CRLF: expected + '\r\n',
    quoted: JSON.stringify(expected),
    wrapper: '<user_reply>' + expected + '</user_reply>\n',
  };
  primary(bodies[kind]!);
  await expect(observeH01Authorization(request)).rejects.toThrow('h01-authority-body');
});
