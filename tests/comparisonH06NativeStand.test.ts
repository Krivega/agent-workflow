import { mkdtempSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import {
  h06NativeStandCli,
  h06NativeStandMain,
  planH06NativeStand,
} from './comparisonH06NativeStand.js';

const backends = vi.hoisted(() => ({
  legacy: vi.fn<(input: unknown) => unknown>(),
  temporal: vi.fn<(input: unknown) => unknown>(),
  setup: vi.fn<(input: unknown, budget: unknown) => unknown>(),
  authority: vi.fn<(input: unknown) => Promise<unknown>>(),
  phase: vi.fn<(input: unknown) => Promise<unknown>>(),
  reopen: vi.fn<(input: unknown) => unknown>(),
}));
vi.mock('./comparisonH06NativeAuthority.js', () => ({
  resolveH06NativeGrant: backends.authority,
  readH06NativeReaderSource: backends.phase,
}));
vi.mock('./comparisonH06NativeAttempt.js', () => ({
  readH06NativeAttemptForReopen: backends.reopen,
}));
vi.mock('./comparisonH06NativeLegacyOperator.js', () => ({
  planH06NativeLegacyOperator: backends.legacy,
}));
vi.mock('./comparisonH06NativeTemporalOperator.js', () => ({
  planH06NativeTemporalOperator: backends.temporal,
  planH06NativeTemporalServerSetup: backends.setup,
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-native-stand-'));
  roots.push(root);
  function pin(name: string, value: unknown) {
    const path = join(root, name);
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  }
  const node = pin('node', 'node');
  const appServer = pin('app-server', 'app-server');
  const assets = { suite: pin('suite.json', 'suite') };
  function backend(variant: 'legacy' | 'temporal') {
    const request = {
      binding: {
        variant,
        operationId: 'attempt-' + variant,
        workspaceRoot: join(root, 'material-' + variant),
        node: { ...node },
        timeoutMs: 3000,
      },
      evidenceRoot: join(root, 'attempt-' + variant),
      chat: { workspace: join(root, 'chat'), threadId: 'human' },
      stimulus: { longStageMs: 35000 },
      appServer: { ...appServer },
    };
    return {
      request,
      assets: structuredClone(assets),
      requestHash: digest(variant),
      expectedGrantText: JSON.stringify({ kind: 'fixture-grant', variant }),
    };
  }
  const legacy = backend('legacy');
  const temporal = backend('temporal');
  backends.legacy.mockReturnValue(legacy);
  backends.temporal.mockReturnValue(temporal);
  const input = {
    kind: 'comparison-h06-native-stand/2',
    legacy: pin('legacy.json', legacy.request),
    temporal: pin('temporal.json', temporal.request),
  };
  return { root, input, legacy, temporal, pin };
}

it('returns two exact proposals from pinned backend inputs without opening a workspace', () => {
  const f = fixture();
  const before = readdirSync(f.root).sort();
  const result = planH06NativeStand(f.input);
  expect(backends.legacy).toHaveBeenCalledExactlyOnceWith(f.legacy.request);
  expect(backends.temporal).toHaveBeenCalledExactlyOnceWith(f.temporal.request);
  expect(result.standHash).toMatch(/^[a-f\d]{64}$/u);
  expect(result).toEqual({
    kind: 'comparison-h06-native-stand-plan/2',
    standHash: result.standHash,
    packages: {
      legacy: {
        pin: f.input.legacy,
        requestHash: f.legacy.requestHash,
        expectedGrantText: f.legacy.expectedGrantText,
      },
      temporal: {
        pin: f.input.temporal,
        requestHash: f.temporal.requestHash,
        expectedGrantText: f.temporal.expectedGrantText,
      },
    },
    order: ['legacy', 'temporal'],
    mayRun: false,
    qualification: false,
  });
  expect(readdirSync(f.root).sort()).toEqual(before);
  expect(planH06NativeStand(f.input)).toEqual(result);
});

it('rejects unexpected top-level data or changed request bytes before authorizing either variant', () => {
  const f = fixture();
  expect(() => planH06NativeStand({ ...f.input, authority: 'other' })).toThrow('unexpected-fields');
  expect(() => planH06NativeStand({ ...f.input, kind: 'other' })).toThrow('h06-native-stand-kind');
  writeFileSync(f.input.legacy.path, 'different');
  expect(() => planH06NativeStand(f.input)).toThrow('h04-pin-changed');
  expect(backends.legacy).not.toHaveBeenCalled();
  expect(backends.temporal).not.toHaveBeenCalled();
});

it.each([
  'operation',
  'same',
  'parent',
  'child',
  'chat',
  'assets',
  'node',
  'app-server',
  'checker',
  'duration',
] as const)('rejects cross-variant contamination or drift (%s)', (which) => {
  const f = fixture();
  const l = f.legacy.request;
  const t = f.temporal.request;
  if (which === 'operation') t.binding.operationId = l.binding.operationId;
  if (which === 'same') t.binding.workspaceRoot = l.binding.workspaceRoot;
  if (which === 'parent') t.binding.workspaceRoot = join(l.binding.workspaceRoot, 'sub');
  if (which === 'child') l.binding.workspaceRoot = join(t.binding.workspaceRoot, 'sub');
  if (which === 'chat') t.chat.threadId = 'other';
  if (which === 'assets') f.temporal.assets.suite.sha256 = digest('other');
  if (which === 'node') t.binding.node.sha256 = digest('other');
  if (which === 'app-server') t.appServer.sha256 = digest('other');
  if (which === 'checker') t.binding.timeoutMs++;
  if (which === 'duration') t.stimulus.longStageMs++;
  expect(() => planH06NativeStand(f.input)).toThrow(
    ['operation', 'same', 'parent', 'child'].includes(which)
      ? 'h06-native-stand-roots'
      : 'h06-native-stand-common-inputs',
  );
});

it('supports only read-only plan arguments', () => {
  const f = fixture();
  const input = f.pin('stand.json', f.input);
  expect(h06NativeStandMain(['--plan', input.path])).toEqual(planH06NativeStand(f.input));
  expect(() => h06NativeStandMain(['--run', input.path])).toThrow('h06-native-stand-arguments');
  expect(() => h06NativeStandMain(['--plan'])).toThrow('h06-native-stand-arguments');
});

it('prepares the separate server proposal from a pinned Temporal attempt', () => {
  const f = fixture();
  const budget = { maxElapsedMs: 240000, stopReserveMs: 30000 };
  const request = {
    kind: 'comparison-h06-native-server-setup/2',
    attempt: f.input.temporal,
    budget,
  };
  const input = f.pin('setup.json', request);
  backends.setup.mockReturnValue({ expectedGrantText: 'server-only', mayRun: false });
  expect(h06NativeStandMain(['--plan-server', input.path])).toEqual({
    expectedGrantText: 'server-only',
    mayRun: false,
  });
  expect(backends.setup).toHaveBeenCalledExactlyOnceWith(f.temporal.request, budget);
  const invalid = f.pin('invalid.json', { ...request, kind: 'other' });
  expect(() => h06NativeStandMain(['--plan-server', invalid.path])).toThrow(
    'h06-native-stand-server-kind',
  );
  writeFileSync(f.input.temporal.path, 'different');
  expect(() => h06NativeStandMain(['--plan-server', input.path])).toThrow('h04-pin-changed');
});

it.each(['legacy', 'temporal'] as const)(
  'resolves the pinned %s proposal without opening it',
  async (variant) => {
    const f = fixture();
    const input = f.pin('stand.json', f.input);
    const observed = { turnId: 'native-source' };
    backends.authority.mockResolvedValue(observed);
    await expect(h06NativeStandCli(['--resolve-grant', input.path, variant])).resolves.toEqual(
      observed,
    );
    expect(backends.authority).toHaveBeenCalledExactlyOnceWith({
      request: f[variant].request,
      expectedGrantText: f[variant].expectedGrantText,
    });
    await expect(h06NativeStandCli(['--resolve-grant', input.path, 'foreign'])).rejects.toThrow(
      'h06-native-stand-arguments',
    );
  },
);

it('resolves only the distinct server proposal for the pinned attempt', async () => {
  const f = fixture();
  const input = f.pin('setup.json', {
    kind: 'comparison-h06-native-server-setup/2',
    attempt: f.input.temporal,
    budget: {},
  });
  backends.setup.mockReturnValue({ attempt: f.temporal, expectedGrantText: 'server-only' });
  backends.authority.mockResolvedValue({ turnId: 'server-turn' });
  await expect(h06NativeStandCli(['--resolve-server-grant', input.path])).resolves.toEqual({
    turnId: 'server-turn',
  });
  expect(backends.authority).toHaveBeenCalledExactlyOnceWith({
    request: f.temporal.request,
    expectedGrantText: 'server-only',
  });
  backends.legacy
    .mockReturnValueOnce(f.legacy)
    .mockReturnValueOnce({ ...f.legacy, requestHash: 'changed' });
  await expect(
    h06NativeStandCli(['--resolve-grant', f.pin('stand.json', f.input).path, 'legacy']),
  ).rejects.toThrow('h06-native-stand-package-changed');
});

it('reads authority from a single attempt and phase source from its retained claim', async () => {
  const f = fixture();
  backends.authority.mockResolvedValue('grant');
  backends.phase.mockResolvedValue('phase-source');
  for (const variant of ['legacy', 'temporal'] as const) {
    const attempt = f.pin(`${variant}-request.json`, f[variant].request);
    await expect(h06NativeStandCli(['--resolve-attempt-grant', attempt.path])).resolves.toBe(
      'grant',
    );
  }
  const claim = f.pin('claim.json', {});
  backends.reopen.mockReturnValue({ request: f.temporal.request });
  await expect(h06NativeStandCli(['--phase-source', claim.path])).resolves.toBe('phase-source');
  expect(backends.reopen).toHaveBeenCalledExactlyOnceWith(claim);
  expect(backends.phase).toHaveBeenCalledExactlyOnceWith(f.temporal.request.chat);
  await expect(h06NativeStandCli(['--phase-source'])).rejects.toThrow('h06-native-stand-arguments');
});

it.each([false, true])('uses the CLI only as a direct entry point (%s)', async (direct) => {
  const f = fixture();
  const input = f.pin('stand.json', f.input);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const argv = process.argv;
  try {
    process.argv = direct
      ? [
          'node',
          fileURLToPath(new URL('./comparisonH06NativeStand.ts', import.meta.url)),
          '--plan',
          input.path,
        ]
      : ['node'];
    vi.resetModules();
    await import('./comparisonH06NativeStand.js');
    await Promise.resolve();
    expect(output).toHaveBeenCalledTimes(direct ? 1 : 0);
  } finally {
    process.argv = argv;
  }
});

it('returns a nonzero CLI status for a refused command', async () => {
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const argv = process.argv;
  const exitCode = process.exitCode;
  try {
    process.argv = [
      'node',
      fileURLToPath(new URL('./comparisonH06NativeStand.ts', import.meta.url)),
      '--run',
    ];
    vi.resetModules();
    await import('./comparisonH06NativeStand.js');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('h06-native-stand-arguments'));
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
