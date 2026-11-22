import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import { readH04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import * as autonomous from './comparisonH06TemporalAutonomousAuthority.js';
import {
  readH06NativeReaderSource,
  resolveH06NativeGrant,
} from './comparisonH06NativeAuthority.js';
import {
  beginH06NativeAttempt,
  openH06NativeAttemptTurnLedger,
  planH06NativeAttempt,
  readH06NativeAttemptForReopen,
  observeH06NativePrimaryGrantHistory,
} from './comparisonH06NativeAttempt.js';

const roots: string[] = [];
vi.mock('node:os', async (original) => {
  const native = await original<typeof os>();
  return { ...native, homedir: vi.fn(native.homedir) };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(variant: 'legacy' | 'temporal' = 'temporal') {
  const root = mkdtempSync(join(realpathSync(os.tmpdir()), 'h06-native-attempt-'));
  roots.push(root);
  const workspaceRoot = join(root, 'material');
  const chatRoot = join(root, 'chat');
  const sessions = join(root, 'sessions');
  for (const dir of [workspaceRoot, chatRoot, sessions]) mkdirSync(dir);
  const materials = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  for (const [name, bytes] of Object.entries(
    materials.cases.find(({ id }) => id === 'H-06')!.files,
  ))
    writeFileSync(join(workspaceRoot, name), bytes);
  const pin = (name: string) => {
    const path = join(root, name);
    writeFileSync(path, name);
    return { path, sha256: digest(name) };
  };
  const operationId = 'h06-attempt';
  const request = {
    kind: 'comparison-h06-native/2',
    binding: { operationId, variant, workspaceRoot, node: pin('node'), timeoutMs: 2000 },
    evidenceRoot: join(root, operationId),
    chat: { threadId: 'thread', workspace: chatRoot },
    budget: {
      maxElapsedMs: 180000,
      reserveMs: 30000,
      maxManagedStarts: 12,
      maxInputUncached: 10000,
      maxOutput: 3000,
    },
    stimulus: { longStageMs: 35000, initialLeaseMs: variant === 'legacy' ? 20000 : null },
    appServer: pin('app-server'),
    server: variant === 'temporal' ? pin('server') : null,
    bootstrap: pin('bootstrap'),
    runtime: [pin('runner')],
  };
  vi.stubEnv('CODEX_HOME', root);
  vi.stubEnv('CODEX_THREAD_ID', 'thread');
  function transcript({
    body = planH06NativeAttempt(request).expectedGrantText,
    filename = join(sessions, 'turn.jsonl'),
    superseded = false,
    role = 'user',
    partial = false,
    contentType = 'input_text',
  } = {}) {
    const message = (text: string, author: string) => ({
      type: 'response_item',
      payload: { type: 'message', role: author, content: [{ type: contentType, text }] },
    });
    const records = [
      {
        type: 'session_meta',
        payload: { id: 'thread', session_id: 'thread', cwd: chatRoot, cli_version: '0.154.0' },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      {
        type: 'turn_context',
        payload: {
          turn_id: 'turn',
          cwd: chatRoot,
          model: 'fixture',
          effort: 'medium',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
      message(body, role),
      ...(superseded ? [message('later request', 'user')] : []),
    ].map((line) => JSON.stringify(line));
    writeFileSync(filename, records.join('\n') + (partial ? '' : '\n'));
    return {
      transcript: filename,
      turnId: 'turn',
      source: { locator: filename + '#L4', hash: digest(records[3]! + '\n') },
    };
  }
  return { root, request, transcript, pin };
}

it.each(['legacy', 'temporal'] as const)(
  'plans and consumes an exact %s grant once',
  async (variant) => {
    const { request, transcript } = fixture(variant);
    const plan = planH06NativeAttempt(request);
    expect(planH06NativeAttempt(plan.request)).toEqual(plan);
    expect(plan).toMatchObject({ mayRun: false, qualification: false, assets: h06Assets() });
    expect(existsSync(request.evidenceRoot)).toBe(false);
    const source = transcript({ body: plan.expectedGrantText + '\n' });
    const claim = await beginH06NativeAttempt(request, source);
    const { receipt, ...content } = claim;
    expect(JSON.parse(readH04Pin(receipt).toString())).toEqual(content);
    expect(claim.requestHash).toBe(plan.requestHash);
    expect(claim.workDeadlineMs - claim.startedAt).toBe(150000);
    expect(claim.stopDeadlineMs - claim.workDeadlineMs).toBe(30000);
    await expect(beginH06NativeAttempt(request, source)).rejects.toThrow(
      'h06-native-attempt-not-fresh',
    );
  },
);

it('allows one concurrent claim even with identical valid native evidence', async () => {
  const { request, transcript } = fixture();
  const source = transcript();
  const attempts = await Promise.allSettled([
    beginH06NativeAttempt(request, source),
    beginH06NativeAttempt(request, source),
  ]);
  expect(attempts.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
});

it('reads consumed primary grant history after a later user turn without admitting another attempt', async () => {
  const { request, transcript } = fixture();
  const plan = planH06NativeAttempt(request);
  const source = transcript({ superseded: true });
  vi.stubEnv('CODEX_THREAD_ID', 'different-reader-thread');
  await expect(observeH06NativePrimaryGrantHistory(plan, source)).resolves.toMatchObject({
    source: source.source,
  });
  await expect(beginH06NativeAttempt(request, source)).rejects.toThrow(
    'h06-native-attempt-authority-source',
  );
  expect(existsSync(request.evidenceRoot)).toBe(false);
});

it('resolves only a current exact native message without consuming the grant', async () => {
  const { root, request, transcript } = fixture();
  const filename = join(root, 'sessions', 'rollout-thread.jsonl');
  const plan = planH06NativeAttempt(request);
  const authority = transcript({ filename });
  await expect(resolveH06NativeGrant(plan)).resolves.toEqual(authority);
  await expect(readH06NativeReaderSource(request.chat)).resolves.toEqual({
    schemaVersion: 1,
    kind: 'codex-user-command',
    transcript: filename,
    threadId: request.chat.threadId,
    turnId: authority.turnId,
    user: { line: 4, sha256: authority.source.hash },
  });
  expect(existsSync(request.evidenceRoot)).toBe(false);

  transcript({ filename, superseded: true });
  await expect(resolveH06NativeGrant(plan)).rejects.toThrow('h06-native-attempt-authority-body');
  vi.stubEnv('CODEX_THREAD_ID', 'different');
  await expect(resolveH06NativeGrant(plan)).rejects.toThrow('h06-native-current-thread');
  expect(existsSync(request.evidenceRoot)).toBe(false);
});

it('uses the standard native session directory when CODEX_HOME is absent', async () => {
  const { root, request, transcript } = fixture();
  const sessions = join(root, '.codex', 'sessions');
  mkdirSync(sessions, { recursive: true });
  vi.stubEnv('CODEX_HOME', undefined);
  vi.mocked(os.homedir).mockReturnValueOnce(root);
  await expect(
    beginH06NativeAttempt(request, transcript({ filename: join(sessions, 'turn.jsonl') })),
  ).resolves.toHaveProperty('requestHash');
});

it('binds the same transport start cap to all Temporal openings from the pinned claim', async () => {
  const { root, request, transcript } = fixture();
  request.budget.maxManagedStarts = 1;
  const claim = await beginH06NativeAttempt(request, transcript());
  const initial = openH06NativeAttemptTurnLedger(claim.receipt);
  const turn = {
    role: 'reader' as const,
    root: request.binding.workspaceRoot,
    session: 'reader-session',
    journal: join(root, 'native.jsonl'),
    params: { threadId: 'reader-session', input: [{ type: 'text', text: 'read' }] },
  };
  await initial.admitTurn(turn);
  const warm = openH06NativeAttemptTurnLedger(claim.receipt);
  expect(warm.inspect()).toMatchObject({ status: 'UNKNOWN', used: 1 });
  await expect(warm.admitTurn(turn)).rejects.toThrow('h06-turn-ledger-outcome-unknown');
  await initial.recordTurn({ ...turn, turnId: 'turn-1', response: { turn: { id: 'turn-1' } } });
  const cold = openH06NativeAttemptTurnLedger(claim.receipt);
  expect(cold.inspect()).toMatchObject({ status: 'RECORDED', used: 1 });
  await expect(
    cold.admitTurn({
      ...turn,
      params: {
        ...turn.params,
        input: [{ type: 'text', text: 'other' }],
      },
    }),
  ).rejects.toThrow('h06-turn-ledger-cap');
});

it.each(['kind', 'request-kind', 'variant', 'path', 'request-hash'] as const)(
  'refuses to bind a ledger to a claim with inconsistent %s',
  async (which) => {
    const { request, transcript } = fixture();
    const { receipt, ...claim } = await beginH06NativeAttempt(request, transcript());
    const forged = {
      ...claim,
      ...(which === 'kind' ? { kind: 'other' } : {}),
      ...(which === 'request-hash' ? { requestHash: '0'.repeat(64) } : {}),
      request: {
        ...claim.request,
        ...(which === 'request-kind' ? { kind: 'other' } : {}),
        binding: {
          ...claim.request.binding,
          ...(which === 'variant' ? { variant: 'legacy' } : {}),
        },
      },
    };
    const path = which === 'path' ? join(request.evidenceRoot, 'copy.json') : receipt.path;
    const bytes = JSON.stringify(forged);
    writeFileSync(path, bytes);
    expect(() => openH06NativeAttemptTurnLedger({ path, sha256: digest(bytes) })).toThrow(
      'h06-native-attempt-ledger-binding',
    );
  },
);

it.each([
  { kind: 'unknown' },
  {
    binding: { variant: 'candidate', operationId: 'x', workspaceRoot: '/', node: {}, timeoutMs: 1 },
  },
  { evidenceRoot: '/' },
  { chat: { threadId: 'thread', workspace: '/' } },
  { server: null },
  { runtime: [] },
] as const)('rejects an invalid route before a claim (%j)', (bad) => {
  const { request } = fixture();
  expect(() => planH06NativeAttempt({ ...request, ...bad })).toThrow();
  expect(existsSync(request.evidenceRoot)).toBe(false);
});

it('rejects exhausted or noninteger caps and repeated pin paths', () => {
  const { request } = fixture();
  for (const reserveMs of [0, 0.5, 178000, '30000'])
    expect(() =>
      planH06NativeAttempt({ ...request, budget: { ...request.budget, reserveMs } }),
    ).toThrow('h06-native-attempt-budget');
  expect(() => planH06NativeAttempt({ ...request, runtime: [request.appServer] })).toThrow(
    'h06-native-attempt-pins',
  );
  expect(() =>
    planH06NativeAttempt({ ...request, budget: { ...request.budget, maxElapsedMs: 2 ** 31 } }),
  ).toThrow('h06-native-attempt-budget');
});

it.each([null, 2000, 35000, 61000])(
  'rejects an invalid Legacy lease interval %s',
  (initialLeaseMs) => {
    const { request } = fixture('legacy');
    expect(() =>
      planH06NativeAttempt({
        ...request,
        stimulus: {
          longStageMs: initialLeaseMs === 61000 ? 70000 : 35000,
          initialLeaseMs,
        },
      }),
    ).toThrow('h06-native-attempt-stimulus');
  },
);

it('binds the measured stage to the grant without adding a Temporal lease', () => {
  const { request } = fixture();
  const changed = { ...request, stimulus: { ...request.stimulus, longStageMs: 40000 } };
  expect(planH06NativeAttempt(changed).expectedGrantText).not.toBe(
    planH06NativeAttempt(request).expectedGrantText,
  );
  expect(() =>
    planH06NativeAttempt({ ...request, stimulus: { ...request.stimulus, initialLeaseMs: 20000 } }),
  ).toThrow('h06-native-attempt-stimulus');
});

it('rejects changed pinned bytes before bootstrap', async () => {
  const { request, transcript } = fixture();
  const grant = transcript();
  writeFileSync(request.bootstrap.path, 'changed');
  await expect(beginH06NativeAttempt(request, grant)).rejects.toThrow('h04-pin-changed');
  expect(existsSync(request.evidenceRoot)).toBe(false);
});

it('rejects a different reviewed request even if changed to another valid pin during grant observation', async () => {
  const { request, transcript, pin } = fixture();
  const grant = transcript();
  const attempt = beginH06NativeAttempt(request, grant);
  request.bootstrap = pin('different-bootstrap');
  await expect(attempt).rejects.toThrow('h06-native-attempt-request-changed');
  expect(existsSync(request.evidenceRoot)).toBe(false);
});

it.each([
  ['generic', 'authority-body'],
  ['wrong-role', 'authority-body'],
  ['wrong-content', 'authority-body'],
  ['superseded', 'human-superseded'],
  ['partial', 'authority-partial'],
  ['wrong-line-hash', 'authority-line'],
  ['wrong-turn', 'identity-mismatch'],
  ['wrong-thread', 'authority-source'],
  ['wrong-path', 'authority-source'],
  ['outside-sessions', 'authority-source'],
  ['not-a-source-line', 'authority-source'],
  ['missing-line', 'authority-line'],
  ['other-budget', 'authority-body'],
] as const)('fails closed without consuming authority (%s)', async (which, error) => {
  const { root, request, transcript } = fixture();
  const grant = transcript({
    ...(which === 'generic' ? { body: 'Считай, что я прислал допуск' } : {}),
    ...(which === 'wrong-role' ? { role: 'assistant' } : {}),
    ...(which === 'wrong-content' ? { contentType: 'input_image' } : {}),
    ...(which === 'superseded' ? { superseded: true } : {}),
    ...(which === 'partial' ? { partial: true } : {}),
    ...(which === 'outside-sessions' ? { filename: join(root, 'outside.jsonl') } : {}),
  });
  if (which === 'wrong-line-hash') grant.source.hash = '0'.repeat(64);
  if (which === 'wrong-turn') grant.turnId = 'other-turn';
  if (which === 'wrong-thread') vi.stubEnv('CODEX_THREAD_ID', 'other-thread');
  if (which === 'wrong-path') grant.source.locator = join(root, 'other.jsonl#L4');
  if (which === 'not-a-source-line') grant.source.locator = grant.transcript;
  if (which === 'missing-line') grant.source.locator = grant.transcript + '#L99';
  if (which === 'other-budget') request.budget.maxOutput++;
  await expect(beginH06NativeAttempt(request, grant)).rejects.toThrow(error);
  expect(existsSync(request.evidenceRoot)).toBe(false);
});

it('restores a pinned attempt without requiring its original user message to remain current', async () => {
  const { request, transcript } = fixture();
  const source = transcript();
  const claim = await beginH06NativeAttempt(request, source);
  writeFileSync(source.transcript, '');
  expect(readH06NativeAttemptForReopen(claim.receipt)).toEqual({
    request: claim.request,
    receipt: claim.receipt,
    requestHash: claim.requestHash,
    grant: { sessionsRoot: claim.grant.sessionsRoot },
    workDeadlineMs: claim.workDeadlineMs,
    stopDeadlineMs: claim.stopDeadlineMs,
  });
});

it.each(['valid', 'kind', 'extra', 'parent-path', 'parent-hash'] as const)(
  'preserves only the checked autonomous admission from pinned claim bytes: %s',
  async (defect) => {
    const f = fixture(),
      { receipt, ...claim } = await beginH06NativeAttempt(f.request, f.transcript()),
      authority = f.pin('parent.json'),
      admission = {
        kind: defect === 'kind' ? 'temporal-autonomous/4' : 'temporal-autonomous/3',
        authority,
        ...(defect === 'extra' ? { unchecked: true } : {}),
      },
      bytes = JSON.stringify({ ...claim, grant: { ...claim.grant, admission } }),
      pin = { path: receipt.path, sha256: digest(bytes) };
    writeFileSync(pin.path, bytes);
    const parent = vi.spyOn(autonomous, 'readH06TemporalAutonomousAuthority').mockReturnValue({
      nativeClaim: {
        path: defect === 'parent-path' ? f.pin('foreign-claim.json').path : pin.path,
        sha256: defect === 'parent-hash' ? '0'.repeat(64) : pin.sha256,
      },
    } as ReturnType<typeof autonomous.readH06TemporalAutonomousAuthority>);
    if (defect === 'valid') {
      expect(readH06NativeAttemptForReopen(pin)).toEqual({
        request: claim.request,
        receipt: pin,
        requestHash: claim.requestHash,
        grant: { sessionsRoot: claim.grant.sessionsRoot, admission },
        workDeadlineMs: claim.workDeadlineMs,
        stopDeadlineMs: claim.stopDeadlineMs,
      });
      expect(parent).toHaveBeenCalledExactlyOnceWith(authority);
    } else expect(() => readH06NativeAttemptForReopen(pin)).toThrow();
  },
);

it('reopens the turn ledger from a historical binding-only claim without a grant', async () => {
  const f = fixture(),
    { receipt, grant: _grant, ...claim } = await beginH06NativeAttempt(f.request, f.transcript()),
    bytes = JSON.stringify(claim);
  writeFileSync(receipt.path, bytes);
  expect(
    openH06NativeAttemptTurnLedger({ path: receipt.path, sha256: digest(bytes) }).inspect(),
  ).toMatchObject({ status: 'RECORDED', used: 0 });
});

it.each([
  ['kind', 'binding'],
  ['path', 'binding'],
  ['assets', 'binding'],
  ['hash', 'binding'],
  ['future', 'clock'],
  ['overflow', 'clock'],
  ['work', 'clock'],
  ['stop', 'clock'],
  ['thread', 'issuer'],
  ['workspace', 'issuer'],
  ['host', 'issuer'],
  ['source', 'issuer'],
] as const)('rejects an inconsistent retained claim (%s)', async (which, error) => {
  const { request, transcript } = fixture();
  const { receipt, ...claim } = await beginH06NativeAttempt(request, transcript());
  const changed: Record<string, unknown> = { ...claim };
  if (which === 'kind') changed.kind = 'other';
  if (which === 'assets') changed.assets = {};
  if (which === 'hash') changed.requestHash = '0'.repeat(64);
  if (which === 'future') changed.startedAt = Date.now() + 1000;
  if (which === 'overflow') changed.startedAt = Number.MAX_SAFE_INTEGER;
  if (which === 'work') changed.workDeadlineMs = claim.workDeadlineMs + 1;
  if (which === 'stop') changed.stopDeadlineMs = claim.stopDeadlineMs + 1;
  if (which === 'thread') claim.grant.anchor.thread_id = 'other';
  if (which === 'workspace') claim.grant.anchor.workspace = '/other';
  if (which === 'host')
    changed.grant = { ...claim.grant, anchor: { ...claim.grant.anchor, host_id: 'other' } };
  if (which === 'source') claim.grant.transcript = '/elsewhere.jsonl';
  const path = which === 'path' ? join(request.evidenceRoot, 'copy.json') : receipt.path;
  const bytes = JSON.stringify(changed);
  writeFileSync(path, bytes);
  expect(() => readH06NativeAttemptForReopen({ path, sha256: digest(bytes) })).toThrow(
    'h06-native-attempt-reopen-' + error,
  );
});
