import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { readH04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import * as attempt from './comparisonH06NativeAttempt.js';
import { checkH06NativeLegacyCrossing, runH06NativeLegacy } from './comparisonH06NativeLegacy.js';
import {
  planH06NativeLegacyOperator,
  runH06NativeLegacyOperator,
  runH06NativeLegacyWithActor,
} from './comparisonH06NativeLegacyOperator.js';
import { signed } from './storageFixtures.js';

vi.mock('./comparisonH06NativeLegacy.js', () => ({
  runH06NativeLegacy: vi.fn(),
  checkH06NativeLegacyCrossing: vi.fn(),
}));

const roots: string[] = [];
const initialFailure = { path: '/fixture/f01', sha256: digest('f01') };
const renewal = { path: '/fixture/renewal', sha256: digest('renewal') };
const crossing = { path: '/fixture/crossing', sha256: digest('crossing') };
const continuity = {
  status: 'LEASE_CROSSING_VERIFIED',
  qualification: false,
  renewal,
  crossing,
} as const;
const verifyLease = vi.fn();

beforeEach(() => {
  vi.mocked(runH06NativeLegacy).mockImplementation(
    async (_binding, _root, _store, _oldDeadline, _workDeadline, stage) => ({
      initialFailure,
      writer: { result: await stage(verifyLease, initialFailure), renewal, crossing },
    }),
  );
  vi.mocked(checkH06NativeLegacyCrossing).mockReturnValue(continuity);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-legacy-operator-'));
  roots.push(root);
  const workspaceRoot = join(root, 'material');
  const chat = join(root, 'chat');
  const sessions = join(root, 'sessions');
  for (const directory of [workspaceRoot, chat, sessions]) mkdirSync(directory);
  const materials = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  for (const [name, body] of Object.entries(materials.cases.find(({ id }) => id === 'H-06')!.files))
    writeFileSync(join(workspaceRoot, name), body);

  const pin = (name: string, body = name) => {
    const path = join(root, name);
    writeFileSync(path, body);
    return { path, sha256: digest(body) };
  };
  const descriptor = {
    kind: 'comparison-h06-native-legacy-bootstrap/2',
    projectId: 'project',
    runId: 'run',
    actorId: 'actor',
    generation: 1,
    permissions: ['read', 'manage', 'produce'],
  };
  const operationId = 'h06-legacy-operator';
  const request = {
    kind: 'comparison-h06-native/2',
    binding: { operationId, variant: 'legacy', workspaceRoot, node: pin('node'), timeoutMs: 2000 },
    evidenceRoot: join(root, operationId),
    chat: { threadId: 'human-thread', workspace: chat },
    budget: {
      maxElapsedMs: 180000,
      reserveMs: 30000,
      maxManagedStarts: 12,
      maxInputUncached: 10000,
      maxOutput: 3000,
    },
    stimulus: { longStageMs: 35000, initialLeaseMs: 20000 as number | null },
    appServer: pin('app-server'),
    server: null as ReturnType<typeof pin> | null,
    bootstrap: pin('bootstrap', JSON.stringify(descriptor)),
    runtime: [pin('runtime')],
  };
  vi.stubEnv('CODEX_HOME', root);
  vi.stubEnv('CODEX_THREAD_ID', request.chat.threadId);
  function authority(body = attempt.planH06NativeAttempt(request).expectedGrantText) {
    const transcript = join(sessions, 'turn.jsonl');
    const turnId = 'turn';
    const records = [
      {
        type: 'session_meta',
        payload: {
          id: request.chat.threadId,
          session_id: request.chat.threadId,
          cwd: chat,
          cli_version: '0.154.0',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      {
        type: 'turn_context',
        payload: {
          turn_id: turnId,
          cwd: chat,
          model: 'fixture',
          effort: 'medium',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] },
      },
    ].map((record) => JSON.stringify(record));
    writeFileSync(transcript, records.join('\n') + '\n');
    return {
      transcript,
      turnId,
      source: { locator: transcript + '#L4', hash: digest(records[3]! + '\n') },
    };
  }
  return { request, descriptor, pin, authority, sessions, root };
}

type Prepare = Parameters<typeof runH06NativeLegacyOperator>[2];
type Preparation = Parameters<Prepare>[0];

function ownedStore({ storeRoot, grant, oldDeadline }: Preparation, lease = oldDeadline) {
  initializeStore(storeRoot, grant.context);
  const store = new SqliteEvidenceStore(storeRoot, grant, Date.now);
  unwrap(
    store.execute(signed({ type: 'claim', lease_until: lease }, 0, 0, 'chat:initial-owner', grant)),
  );
  return store;
}

it('binds an owned Store and the lease stimulus to an exact, single-use attempt', async () => {
  const f = fixture();
  const prepare = vi.fn<Prepare>(async (preparation) => {
    expect(existsSync(preparation.claim.receipt.path)).toBe(true);
    expect(existsSync(join(f.request.evidenceRoot, 'f01'))).toBe(false);
    expect(preparation).toMatchObject({
      storeRoot: join(f.request.evidenceRoot, 'legacy-store'),
      generation: 1,
      grant: { context: { actor_id: 'actor', task_id: f.request.binding.operationId } },
    });
    expect(preparation.oldDeadline - preparation.claim.startedAt).toBe(
      f.request.stimulus.initialLeaseMs,
    );
    return ownedStore(preparation);
  });
  const stage = vi.fn(async (verify: () => void) => {
    verify();
    expect(existsSync(join(f.request.evidenceRoot, 'legacy-operator-start.json'))).toBe(true);
    return 'stage-result';
  });
  const authority = f.authority();
  const { start, ...result } = await runH06NativeLegacyOperator(
    f.request,
    authority,
    prepare,
    stage,
  );
  const preparation = prepare.mock.calls[0]![0];
  expect(result).toEqual({
    initialFailure,
    writer: { result: 'stage-result', renewal, crossing },
    claim: preparation.claim.receipt,
    continuity,
    qualification: false,
  });
  expect(start.path).toBe(join(f.request.evidenceRoot, 'legacy-operator-start.json'));
  expect(JSON.parse(readH04Pin(start).toString())).toEqual({
    kind: 'h06-native-legacy-operator-start',
    claim: preparation.claim.receipt,
    bootstrap: f.request.bootstrap,
    storeRoot: preparation.storeRoot,
    context: preparation.grant.context,
    generation: preparation.generation,
    revision: 1,
    oldDeadline: preparation.oldDeadline,
  });
  expect(runH06NativeLegacy).toHaveBeenCalledExactlyOnceWith(
    f.request.binding,
    f.request.evidenceRoot,
    await prepare.mock.results[0]!.value,
    preparation.oldDeadline,
    preparation.claim.workDeadlineMs,
    expect.any(Function),
  );
  expect(stage).toHaveBeenCalledExactlyOnceWith(expect.any(Function), initialFailure, preparation);
  expect(verifyLease).toHaveBeenCalledTimes(3);
  expect(checkH06NativeLegacyCrossing).toHaveBeenCalledExactlyOnceWith(
    f.request.binding,
    renewal,
    crossing,
    f.request.stimulus.longStageMs,
  );
  await expect(runH06NativeLegacyOperator(f.request, authority, prepare, stage)).rejects.toThrow(
    'h06-native-attempt-not-fresh',
  );
  expect(prepare).toHaveBeenCalledTimes(1);
});

it('rejects a generic assent without creating the Store or F-01 attempt', async () => {
  const f = fixture();
  const prepare = vi.fn<Prepare>();
  await expect(
    runH06NativeLegacyOperator(f.request, f.authority('Продолжай'), prepare, vi.fn()),
  ).rejects.toThrow('h06-native-attempt-authority-body');
  expect(prepare).not.toHaveBeenCalled();
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
});

it.each([
  { kind: 'untrusted' },
  { generation: '1' },
  { generation: 0 },
  { generation: 1.5 },
  { permissions: null },
  { permissions: ['read', 'manage', 'publish'] },
  { permissions: ['read', 'read', 'manage'] },
  { permissions: ['manage'] },
  { permissions: ['read'] },
])('rejects malformed Legacy bootstrap %j before consuming authority', async (change) => {
  const f = fixture();
  f.request.bootstrap = f.pin('bootstrap', JSON.stringify({ ...f.descriptor, ...change }));
  const prepare = vi.fn<Prepare>();
  await expect(
    runH06NativeLegacyOperator(f.request, f.authority(), prepare, vi.fn()),
  ).rejects.toThrow('h06-legacy-operator-');
  expect(prepare).not.toHaveBeenCalled();
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
});

it('rejects a Temporal attempt at the Legacy entry', async () => {
  const f = fixture();
  f.request.binding.variant = 'temporal';
  f.request.stimulus.initialLeaseMs = null;
  f.request.server = f.pin('temporal');
  await expect(
    runH06NativeLegacyOperator(f.request, f.authority(), vi.fn(), vi.fn()),
  ).rejects.toThrow('h06-legacy-operator-variant');
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
});

it.each([
  'wrong-root',
  'wrong-permissions',
  'foreign-owner',
  'wrong-generation',
  'released',
  'frozen',
  'wrong-lease',
  'effects',
  'changed-bootstrap',
  'deadline',
  'work-deadline',
] as const)('rejects %s Store preparation before F-01, renewal or Writer', async (which) => {
  const f = fixture();
  const time = 100000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(time);
  if (which === 'work-deadline') {
    f.request.budget.maxElapsedMs = 68000;
  }
  const authority = f.authority();
  const prepare = vi.fn<Prepare>(async (preparation) => {
    const { grant, oldDeadline, storeRoot } = preparation;
    const store = ownedStore(preparation, which === 'wrong-lease' ? oldDeadline + 1 : oldDeadline);
    if (which === 'wrong-root')
      return new SqliteEvidenceStore(join(f.request.evidenceRoot, 'elsewhere'), grant, Date.now);
    if (which === 'wrong-permissions')
      return new SqliteEvidenceStore(
        storeRoot,
        { ...grant, permissions: ['read', 'manage'] },
        Date.now,
      );
    if (which === 'changed-bootstrap') writeFileSync(f.request.bootstrap.path, 'changed');
    if (which === 'deadline') clock.mockReturnValue(oldDeadline);
    if (which === 'work-deadline') clock.mockReturnValue(time + 2000);
    if (
      which === 'foreign-owner' ||
      which === 'wrong-generation' ||
      which === 'released' ||
      which === 'frozen' ||
      which === 'effects'
    ) {
      const execute = store.execute.bind(store);
      vi.spyOn(store, 'execute').mockImplementation((input) => {
        const result = execute(input);
        if (result.ok && input.command.type === 'effects' && which === 'effects')
          return {
            ok: true,
            value: [{ id: 'old-writer', intent: null, outcome: 'pending', receipt: null }],
          };
        if (!result.ok || input.command.type !== 'state') return result;
        return {
          ok: true,
          value: {
            ...(result.value as object),
            ...(which === 'foreign-owner' ? { owner: 'different' } : {}),
            ...(which === 'wrong-generation' ? { generation: 2 } : {}),
            ...(which === 'released' ? { released: true } : {}),
            ...(which === 'frozen' ? { frozen: true } : {}),
          } as typeof result.value,
        };
      });
    }
    return store;
  });
  const stage = vi.fn();
  const code = which === 'changed-bootstrap' ? 'h04-pin-changed' : 'h06-legacy-operator-';
  await expect(runH06NativeLegacyOperator(f.request, authority, prepare, stage)).rejects.toThrow(
    code,
  );
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(runH06NativeLegacy).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
  expect(existsSync(join(f.request.evidenceRoot, 'attempt-claim.json'))).toBe(true);
  expect(existsSync(join(f.request.evidenceRoot, 'f01'))).toBe(false);
});

it('refuses a generation change between F-01 and Writer', async () => {
  const f = fixture();
  vi.mocked(runH06NativeLegacy).mockImplementationOnce(
    async (_binding, _root, store, _old, _work, stage) => {
      const execute = store.execute.bind(store);
      vi.spyOn(store, 'execute').mockImplementation((input) => {
        const result = execute(input);
        return result.ok && input.command.type === 'state'
          ? {
              ok: true,
              value: { ...(result.value as object), generation: 2 } as typeof result.value,
            }
          : result;
      });
      return {
        initialFailure,
        writer: { result: await stage(verifyLease, initialFailure), renewal, crossing },
      };
    },
  );
  const writer = vi.fn();
  await expect(
    runH06NativeLegacyOperator(
      f.request,
      f.authority(),
      async (preparation) => ownedStore(preparation),
      writer,
    ),
  ).rejects.toThrow('h06-legacy-operator-store-state');
  expect(writer).not.toHaveBeenCalled();
});

it('retains the attempt without accepting the stage when startup evidence changes', async () => {
  const f = fixture();
  const writer = vi.fn(async () => {
    writeFileSync(join(f.request.evidenceRoot, 'legacy-operator-start.json'), 'replaced');
  });
  await expect(
    runH06NativeLegacyOperator(
      f.request,
      f.authority(),
      async (preparation) => ownedStore(preparation),
      writer,
    ),
  ).rejects.toThrow('h04-pin-changed');
  expect(writer).toHaveBeenCalledTimes(1);
  expect(checkH06NativeLegacyCrossing).not.toHaveBeenCalled();
});

function nativeActor(
  f: ReturnType<typeof fixture>,
  profile: { sandbox?: string; approval?: string; permission?: string } = {},
) {
  const workspace = f.request.binding.workspaceRoot;
  const thread = f.descriptor.actorId;
  const transcript = join(f.sessions, 'legacy-actor.jsonl');
  const anchor = { workspace, host_id: 'local' as const, thread_id: thread, turn_id: 'actor-turn' };
  const events = [
    {
      type: 'session_meta',
      payload: { id: thread, session_id: thread, cwd: workspace, cli_version: '0.154.0' },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: anchor.turn_id } },
    {
      type: 'turn_context',
      payload: {
        turn_id: anchor.turn_id,
        cwd: workspace,
        model: 'fixture',
        effort: 'medium',
        approval_policy: profile.approval ?? 'never',
        sandbox_policy: { type: profile.sandbox ?? 'danger-full-access' },
        permission_profile: { type: profile.permission ?? 'disabled' },
      },
    },
  ];
  writeFileSync(transcript, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return { transcript, anchor, events };
}

it('validates the Legacy bootstrap and claims the original lease without renew', async () => {
  const f = fixture();
  f.request.bootstrap = f.pin(
    'bootstrap-mcp',
    JSON.stringify({ ...f.descriptor, disabledMcpServers: ['one'] }),
  );
  expect(planH06NativeLegacyOperator(f.request).mayRun).toBe(false);
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  const actor = nativeActor(f);
  const stage = vi.fn(async () => 'actor-stage');
  const result = await runH06NativeLegacyWithActor(f.request, f.authority(), actor, stage);
  const store = vi.mocked(runH06NativeLegacy).mock.calls[0]![2];
  const context = store.grant.context;
  const state = unwrap(store.execute({ context, command: { type: 'state', archive: 'current' } }));
  expect(state).toMatchObject({ owner: f.descriptor.actorId, generation: 1, revision: 1 });
  const claim = JSON.parse(readH04Pin(result.claim).toString()) as { startedAt: number };
  expect(state).toMatchObject({
    lease_until: claim.startedAt + f.request.stimulus.initialLeaseMs!,
  });
  const operation = (id: string) =>
    unwrap(store.execute({ context, command: { type: 'operation', operation_id: id } }));
  expect(operation('chat:initial-owner')).toHaveProperty('status', 'confirmed');
  expect(operation('chat:lease:1:1')).not.toHaveProperty('status', 'confirmed');
  expect(result.writer.result).toBe('actor-stage');
});

it.each([
  'generation',
  'transcript',
  'actor',
  'workspace',
  'sandbox',
  'approval',
  'permission',
  'generic',
] as const)('refuses an unsafe Legacy actor before consuming a grant (%s)', async (which) => {
  const f = fixture();
  if (which === 'generation') {
    f.descriptor.generation = 2;
    f.request.bootstrap = f.pin('bootstrap', JSON.stringify(f.descriptor));
  }
  const actor = nativeActor(f, {
    ...(which === 'sandbox' ? { sandbox: 'read-only' } : {}),
    ...(which === 'approval' ? { approval: 'on-request' } : {}),
    ...(which === 'permission' ? { permission: 'other' } : {}),
  });
  if (which === 'transcript') actor.transcript = join(f.root, 'elsewhere.jsonl');
  if (which === 'actor') actor.anchor.thread_id = 'other';
  if (which === 'workspace') actor.anchor.workspace = f.root;
  const grant = f.authority(which === 'generic' ? 'continue' : undefined);
  await expect(runH06NativeLegacyWithActor(f.request, grant, actor, vi.fn())).rejects.toThrow();
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(runH06NativeLegacy).not.toHaveBeenCalled();
});

it.each(['sessions', 'actor', 'deadline'] as const)(
  'refuses a changed actor after primary claim (%s)',
  async (which) => {
    const f = fixture();
    const actor = nativeActor(f);
    const grant = f.authority();
    const begin = attempt.beginH06NativeAttempt;
    vi.spyOn(attempt, 'beginH06NativeAttempt').mockImplementationOnce(async (request, auth) => {
      const claimed = await begin(request, auth);
      if (which === 'sessions') claimed.grant.sessionsRoot = f.root;
      if (which === 'actor') nativeActor(f, { approval: 'on-request' });
      if (which === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(claimed.workDeadlineMs);
      return claimed;
    });
    await expect(runH06NativeLegacyWithActor(f.request, grant, actor, vi.fn())).rejects.toThrow(
      'h06-legacy-operator-actor-changed',
    );
    expect(existsSync(join(f.request.evidenceRoot, 'legacy-store'))).toBe(false);
  },
);
