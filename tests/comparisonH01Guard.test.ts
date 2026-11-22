import {
  appendFileSync,
  copyFileSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type * as NodeFs from 'node:fs';
import type * as Artifacts from '../src/adapters/artifacts/files.js';
import type { InputRef } from '../core/localRun.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { readerBudget } from '../src/adapters/codex/readerBudget.js';
import type {
  H01GuardDescriptor,
  H01ModelStart,
  H01NativeObserver,
} from './comparisonH01Contract.js';
import type * as ContractModule from './comparisonH01Contract.js';
import {
  createH01NativeGuard,
  h01GuardRequest as actualGuardRequest,
  h01NativePolicy,
  h01ApprovedNativeBinary,
  h01LegacyOverlayPlan,
  prepareH01LegacyOverlay,
  verifyH01LegacyOverlay,
} from './comparisonH01Guard.js';

function h01GuardRequest(
  observer: H01NativeObserver,
  stage: 'execution' | 'council',
  method: string,
  params: Record<string, unknown>,
  effect: () => Promise<unknown>,
) {
  return actualGuardRequest(observer, stage, method, params, effect, {
    disabled: [],
    request: async () => ({ data: [], nextCursor: null }),
  });
}

const mocks = vi.hoisted(() => ({
  authorization: vi.fn(),
  failRecord: '',
  beforeOpen: undefined as undefined | ((path: string, flags: number) => void),
  afterConsume: undefined as undefined | (() => void),
}));
vi.mock('../src/adapters/codex/readerBudget.js', async (original) => {
  const actual = await original<{ readerBudget: typeof readerBudget }>();
  return {
    readerBudget(directory: string, limit: number) {
      const consume = actual.readerBudget(directory, limit);
      return (key: string, hash: string) => {
        consume(key, hash);
        mocks.afterConsume?.();
      };
    },
  };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    openSync(path: string, flags: number, mode?: number) {
      mocks.beforeOpen?.(path, flags);
      return actual.openSync(path, flags, mode);
    },
  };
});
vi.mock('./comparisonH01Contract.js', async (original) => ({
  ...(await original<typeof ContractModule>()),
  verifyH01GuardAuthorization: mocks.authorization,
  parseH01GuardDescriptor: (ref: InputRef) =>
    JSON.parse(readFileSync(ref.locator, 'utf8')) as H01GuardDescriptor,
}));
vi.mock('../src/adapters/artifacts/files.js', async (original) => {
  const actual = await original<typeof Artifacts>();
  return {
    ...actual,
    publishFile(path: string, content: Uint8Array) {
      if (path.includes(mocks.failRecord) && mocks.failRecord !== '')
        throw 'storage outcome unknown';
      return actual.publishFile(path, content);
    },
  };
});
let now = 1_000_000_000n;
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'h01-guard-unit-')));
  now = 1_000_000_000n;
  mocks.authorization.mockResolvedValue(undefined);
  mocks.failRecord = '';
  mocks.beforeOpen = undefined;
  mocks.afterConsume = undefined;
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function file(path: string, value: unknown): InputRef {
  mkdirSync(dirname(path), { recursive: true });
  const content = typeof value === 'string' ? value : canonical(value) + '\n';
  writeFileSync(path, content);
  return { locator: path, hash: digest(content) };
}
function fixture(patch: Partial<H01GuardDescriptor> = {}, legacy = false) {
  const binary = file(join(root, 'binary'), 'pinned native binary, never executed');
  const plan = file(join(root, 'overlay-plan.json'), h01LegacyOverlayPlan());
  const bootstrap = file(
    join(root, 'bootstrap.json'),
    legacy ? { engine: 'legacy', overlay: plan } : { engine: 'temporal' },
  );
  const request = file(join(root, 'request.json'), { bootstrap });
  const roots = Object.fromEntries(
    ['workspaceRoot', 'evidenceRoot', 'artifactRoot', 'hostRoot', 'stateRoot'].map((name) => {
      const path = join(root, name);
      mkdirSync(path);
      return [name, path];
    }),
  ) as unknown as H01GuardDescriptor['roots'];
  const control: H01GuardDescriptor = {
    kind: 'comparison-h01-guard',
    executionVersion: 2,
    opId: 'attempt-H01',
    requestHash: 'a'.repeat(64),
    variant: 'candidate',
    roots,
    budget: {
      maxManagedStarts: 5,
      maxElapsedMs: 1000,
      maxInputUncached: 100,
      maxOutput: 50,
      reserveMs: 100,
    },
    profile: { model: 'fixture', effort: 'high', clientVersion: 'fixture' },
    binary,
    request,
    authorization: {
      root,
      transcript: binary.locator,
      anchor: {} as H01GuardDescriptor['authorization']['anchor'],
      source: binary,
      requestHash: 'a'.repeat(64),
    },
    pins: [binary],
    startedNs: String(now),
    deadlineNs: String(now + 1_000_000_000n),
    workDeadlineNs: String(now + 900_000_000n),
    ...patch,
  };
  const controlRef = file(join(root, 'control.json'), control);
  const observer = createH01NativeGuard(
    controlRef,
    control.kind === 'comparison-h01-guard'
      ? 'H-01'
      : control.kind === 'comparison-h02-guard'
        ? 'H-02'
        : control.kind === 'comparison-h03-guard'
          ? 'H-03'
          : control.kind === 'comparison-h04-guard'
            ? 'H-04'
            : 'H-05',
  );
  const native = join(roots.evidenceRoot, 'native-guard');
  function transcript(session = 'actor', usage = true) {
    const path = join(root, `${session}.jsonl`);
    const lines = [
      { type: 'session_meta', payload: { id: session } },
      ...(usage
        ? [
            {
              type: 'token_usage_record',
              payload: {
                thread_id: session,
                session_id: session,
                response_id: 'response',
                turn_id: 'turn',
                usage: {
                  input_tokens: 9,
                  cached_input_tokens: 2,
                  output_tokens: 3,
                },
                thread_token_usage: {
                  input_tokens: 9,
                  cached_input_tokens: 2,
                  output_tokens: 3,
                },
              },
            },
          ]
        : []),
    ];
    file(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return path;
  }
  function appendUsage(session = 'actor') {
    appendFileSync(
      join(root, `${session}.jsonl`),
      JSON.stringify({
        type: 'token_usage_record',
        payload: {
          thread_id: session,
          session_id: session,
          response_id: 'response',
          turn_id: 'turn',
          usage: { input_tokens: 9, cached_input_tokens: 2, output_tokens: 3 },
          thread_token_usage: {
            input_tokens: 9,
            cached_input_tokens: 2,
            output_tokens: 3,
          },
        },
      }) + '\n',
    );
  }
  function register(
    session = 'actor',
    usage = true,
    stage: 'execution' | 'council' = 'execution',
    capabilities = true,
  ) {
    const path = transcript(session, usage);
    const creation = file(join(root, `creation-${session}.json`), {
      kind: 'h01-native-dispatch',
      method: 'thread/start',
      params: { cwd: roots.workspaceRoot },
      response: {
        model: 'fixture',
        reasoningEffort: 'high',
        thread: { id: session, path, turns: [] },
      },
    });
    const participant = {
      session,
      transcript: path,
      run: control.opId,
      stage,
      creation,
    };
    observer.registerCreation({ session, run: control.opId, stage, creation });
    observer.registerParticipant(participant);
    if (capabilities) {
      const evidence = file(join(root, `capabilities-${session}.json`), {
        kind: 'h01-native-capabilities',
        session,
        response: { data: [], nextCursor: null },
      });
      observer.registerCapabilities({ session, evidence, disabled: [] });
    }
    return participant;
  }
  const start: H01ModelStart = {
    origin: 'legacy',
    key: digest('delivery'),
    hash: digest('params'),
    session: 'actor',
    stage: 'execution',
  };
  function confirm(s = start) {
    const evidence = file(join(root, `reply-${s.key}.json`), {
      kind: 'h01-native-dispatch',
      method: 'turn/start',
      params: { threadId: s.session },
      start: s,
      response: { turn: { id: 'turn' } },
    });
    observer.confirmModelStart({
      key: s.key,
      session: s.session,
      turn: 'turn',
      evidence,
    });
    return evidence;
  }
  function complete(
    session = 'actor',
    outcome: 'completed' | 'failed' | 'unknown' = 'completed',
    patchStop = {},
  ) {
    const raw = file(join(root, `raw-stop-${session}.json`), {
      fixture: 'physical stop observation',
    });
    const stop = file(join(root, `stop-${session}.json`), {
      kind:
        control.kind === 'comparison-h01-guard'
          ? 'comparison-h01-stop'
          : control.kind === 'comparison-h02-guard'
            ? 'comparison-h02-stop'
            : control.kind === 'comparison-h03-guard'
              ? 'comparison-h03-stop'
              : control.kind === 'comparison-h04-guard'
                ? 'comparison-h04-stop'
                : 'comparison-h05-stop',
      executionVersion: 2,
      opId: control.opId,
      confirmed: true,
      sessions: [session],
      remainingProcesses: [],
      evidence: [raw],
      ...patchStop,
    });
    observer.completeParticipant(session, { outcome, stop, evidence: [raw] });
    return stop;
  }
  return {
    control,
    controlRef,
    observer,
    native,
    register,
    start,
    confirm,
    complete,
    transcript,
    appendUsage,
  };
}

it('uses the same H02 ledger and primary STOP without installing a Legacy runtime overlay', async () => {
  const f = fixture({ kind: 'comparison-h02-guard', variant: 'baseline' }, true);
  f.register();
  await f.observer.beforeModelStart(f.start);
  f.confirm();
  f.complete();
  await f.observer.verify();
  expect(f.observer.accounting()).toMatchObject({ reservedManagedStarts: 1, unknown: false });
  expect(existsSync(join(f.control.roots.stateRoot, 'legacy-runtime'))).toBe(false);
});

it('keeps H04 managed starts and primary STOP in its own guard domain without a Legacy overlay', async () => {
  const f = fixture({ kind: 'comparison-h04-guard', variant: 'baseline' }, true);
  f.register();
  await f.observer.beforeModelStart(f.start);
  f.confirm();
  const stop = f.complete();
  await f.observer.verify();
  expect(JSON.parse(readFileSync(stop.locator, 'utf8')) as unknown).toMatchObject({
    kind: 'comparison-h04-stop',
  });
  expect(f.observer.accounting()).toMatchObject({
    reservedManagedStarts: 1,
    observedResponses: 1,
    unknown: false,
  });
  expect(existsSync(join(f.control.roots.stateRoot, 'legacy-runtime'))).toBe(false);
});

it('does not transfer the H03 compaction method authority to an H04 guard', async () => {
  const f = fixture({ kind: 'comparison-h04-guard' }, true);
  f.register();
  await expect(
    f.observer.beforeModelStart({ ...f.start, method: 'thread/compact/start' }),
  ).rejects.toThrow('native-compaction-start-forbidden');
  expect(f.observer.accounting().reservedManagedStarts).toBe(0);
});

it('keeps H05 managed starts and primary STOP in its own guard domain without a Legacy overlay', async () => {
  const f = fixture({ kind: 'comparison-h05-guard', variant: 'baseline' }, true);
  f.register();
  await f.observer.beforeModelStart(f.start);
  f.confirm();
  const stop = f.complete();
  await f.observer.verify();
  expect(JSON.parse(readFileSync(stop.locator, 'utf8')) as unknown).toMatchObject({
    kind: 'comparison-h05-stop',
  });
  expect(f.observer.accounting()).toMatchObject({
    reservedManagedStarts: 1,
    observedResponses: 1,
    unknown: false,
  });
  expect(existsSync(join(f.control.roots.stateRoot, 'legacy-runtime'))).toBe(false);
});

it('does not transfer the H03 compaction method authority to an H05 guard', async () => {
  const f = fixture({ kind: 'comparison-h05-guard' }, true);
  f.register();
  await expect(
    f.observer.beforeModelStart({ ...f.start, method: 'thread/compact/start' }),
  ).rejects.toThrow('native-compaction-start-forbidden');
  expect(f.observer.accounting().reservedManagedStarts).toBe(0);
});

it('permits only the original unsealed H05 participant and never rewrites its completion', async () => {
  const f = fixture({ kind: 'comparison-h05-guard', variant: 'baseline' }, true);
  const p = f.register();
  await f.observer.beforeModelStart(f.start);
  f.confirm();
  const before = readdirSync(f.native).sort();
  f.observer.assertRecoveryParticipant!(p.session, p.creation, p.transcript);
  expect(readdirSync(f.native).sort()).toEqual(before);
  expect(f.observer.accounting().reservedManagedStarts).toBe(1);
  f.complete();
  const completion = join(f.native, `complete-${digest(p.session)}.json`);
  const original = readFileSync(completion);
  expect(() => f.observer.assertRecoveryParticipant!(p.session, p.creation, p.transcript)).toThrow(
    'h05-recovery-participant-sealed',
  );
  expect(readFileSync(completion).equals(original)).toBe(true);
});

it.each([
  'created-session',
  'created-run',
  'created-stage',
  'created-creation',
  'participant-session',
  'participant-run',
  'participant-stage',
  'participant-creation',
  'participant-transcript',
  'unknown',
  'missing',
  'expired',
  'unpinned',
  'other-scenario',
])('rejects H05 recovery %s without writing a new guard decision', async (mode) => {
  const f = fixture(
    { kind: mode === 'other-scenario' ? 'comparison-h04-guard' : 'comparison-h05-guard' },
    true,
  );
  const p = f.register();
  await f.observer.beforeModelStart(f.start);
  f.confirm();
  if (mode.startsWith('created-') || mode.startsWith('participant-')) {
    const created = mode.startsWith('created-');
    const path = join(f.native, `${created ? 'created' : 'participant'}-${digest(p.session)}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const value = created ? stored : (stored.participant as Record<string, unknown>);
    const field = mode.slice(mode.indexOf('-') + 1);
    value[field] =
      field === 'creation'
        ? file(join(root, 'foreign-creation'), {})
        : field === 'stage'
          ? 'council'
          : 'foreign';
    file(path, stored);
  }
  if (mode === 'unknown') f.complete('actor', 'unknown');
  if (mode === 'expired') now = BigInt(f.control.workDeadlineNs);
  if (mode === 'unpinned') writeFileSync(p.creation.locator, 'changed');
  const before = readdirSync(f.native)
    .sort()
    .map((name) => [name, digest(readFileSync(join(f.native, name)))]);
  expect(() =>
    f.observer.assertRecoveryParticipant!(
      mode === 'missing' ? 'absent' : p.session,
      p.creation,
      p.transcript,
    ),
  ).toThrow();
  expect(
    readdirSync(f.native)
      .sort()
      .map((name) => [name, digest(readFileSync(join(f.native, name)))]),
  ).toEqual(before);
});

it.each([
  'unknown-marker',
  'missing-usage',
  'bad-credit',
  'zero-responses',
  'unobserved-budget',
  'pending',
  'extra-credit',
])('retains H05 recovery refusal for %s without releasing spent credit', async (mode) => {
  const f = fixture({ kind: 'comparison-h05-guard' }, true);
  const p = f.register(
    'actor',
    !['missing-usage', 'zero-responses', 'unobserved-budget'].includes(mode),
  );
  if (!['zero-responses', 'unobserved-budget'].includes(mode)) {
    await f.observer.beforeModelStart(f.start);
    if (mode !== 'pending') f.confirm();
  }
  if (mode === 'zero-responses') f.observer.accounting();
  if (mode === 'extra-credit')
    readerBudget(join(f.control.roots.hostRoot, 'turn-credits'), f.control.budget.maxManagedStarts)(
      digest('extra-unregistered-start'),
      digest('extra-request'),
    );
  if (mode === 'unknown-marker')
    file(join(f.native, 'unknown-kept.json'), { reason: 'retained-unknown' });
  const credit = join(f.control.roots.hostRoot, 'turn-credits/0.credit');
  if (mode === 'bad-credit') writeFileSync(credit, '{}');
  const originalCredit = existsSync(credit) ? readFileSync(credit) : null;
  const names = readdirSync(f.native).sort();
  expect(() =>
    f.observer.assertRecoveryParticipant!(p.session, p.creation, p.transcript),
  ).toThrow();
  expect(readdirSync(f.native).sort()).toEqual(names);
  if (originalCredit !== null) expect(readFileSync(credit).equals(originalCredit)).toBe(true);
  else expect(existsSync(credit)).toBe(false);
});

async function compactFixture() {
  const f = fixture({ kind: 'comparison-h03-guard' }, true),
    participant = f.register();
  const first = readFileSync(participant.transcript, 'utf8').trimEnd().split('\n');
  first.splice(
    1,
    0,
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }),
  );
  first.push(
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } }),
  );
  writeFileSync(participant.transcript, first.join('\n') + '\n');
  await f.observer.beforeModelStart(f.start);
  f.confirm();
  const original = readFileSync(participant.transcript, 'utf8');
  const rows = original.trimEnd().split('\n');
  const before = {
    locator: participant.transcript + '#L' + rows.length,
    hash: digest(rows.at(-1)! + '\n'),
  };
  const start: H01ModelStart = {
    ...f.start,
    method: 'thread/compact/start',
    before,
    key: digest('one compact'),
    hash: digest('compact params'),
  };
  await f.observer.beforeModelStart(start);
  const dispatch = {
    kind: 'comparison-native-compaction-dispatch',
    scenario: 'H-03',
    opId: f.control.opId,
    method: 'thread/compact/start',
    start,
    params: { threadId: participant.session },
    before,
  };
  const compacted = JSON.stringify({
    type: 'compacted',
    payload: { message: 'unit protocol event; not native qualification' },
  });
  const usage = JSON.stringify({
    type: 'token_usage_record',
    payload: {
      thread_id: participant.session,
      session_id: participant.session,
      response_id: 'compact-response',
      turn_id: 'compact-provider-turn',
      usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 },
      thread_token_usage: { input_tokens: 14, cached_input_tokens: 3, output_tokens: 5 },
    },
  });
  appendFileSync(participant.transcript, compacted + '\n' + usage + '\n');
  const boundary = {
    locator: participant.transcript + '#L' + (rows.length + 1),
    hash: digest(compacted + '\n'),
  };
  const through = {
    locator: participant.transcript + '#L' + (rows.length + 2),
    hash: digest(usage + '\n'),
  };
  const confirmation = {
    key: start.key,
    session: participant.session,
    before,
    boundary,
    through,
    evidence: file(join(root, 'compact-dispatch.json'), dispatch),
  };
  return { f, participant, original, compacted, usage, start, dispatch, confirmation };
}

it('reserves compact separately, reconciles the native boundary without inventing a turn ACK, and keeps its costs', async () => {
  const { f, confirmation } = await compactFixture();
  f.observer.confirmCompaction!(confirmation);
  f.complete();
  await f.observer.verify();
  expect(f.observer.accounting()).toMatchObject({
    reservedManagedStarts: 2,
    observedResponses: 2,
    inputUncached: 11,
    inputCached: 3,
    output: 5,
    unknown: false,
  });
  const second: H01ModelStart = {
    ...f.start,
    method: 'thread/compact/start',
    key: digest('second compact'),
  };
  await expect(f.observer.beforeModelStart(second)).rejects.toThrow('native-compaction-no-repeat');
});

it('accepts primary compact usage published before its boundary without a later through cursor', async () => {
  const x = await compactFixture();
  writeFileSync(x.participant.transcript, x.original + x.usage + '\n' + x.compacted + '\n');
  const { through: _through, ...confirmation } = x.confirmation;
  confirmation.boundary = {
    locator: x.confirmation.through.locator,
    hash: digest(x.compacted + '\n'),
  };
  x.f.observer.confirmCompaction!(confirmation);
  x.f.complete();
  await x.f.observer.verify();
  expect(x.f.observer.accounting().unknown).toBe(false);
});

it.each([
  'binding',
  'partial',
  'foreign-source',
  'changed-before',
  'wrong-boundary',
  'next-turn',
  'missing-cost',
  'cumulative-only',
])('preserves H03 %s as UNKNOWN rather than a free compact', async (failure) => {
  const x = await compactFixture();
  if (failure === 'binding')
    x.confirmation.evidence = file(join(root, 'bad-dispatch.json'), {
      ...x.dispatch,
      params: { threadId: 'other' },
    });
  if (failure === 'partial')
    writeFileSync(x.participant.transcript, x.original + x.compacted + '\n' + x.usage);
  if (failure === 'foreign-source')
    x.confirmation.before = { ...x.confirmation.before, locator: join(root, 'foreign') + '#L1' };
  if (failure === 'changed-before')
    x.confirmation.before = { ...x.confirmation.before, hash: '0'.repeat(64) };
  if (failure === 'wrong-boundary') {
    x.confirmation.boundary = x.confirmation.before;
  }
  if (failure === 'next-turn') {
    const turn = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'next' },
    });
    appendFileSync(x.participant.transcript, turn + '\n');
    x.confirmation.through = {
      locator:
        x.participant.transcript +
        '#L' +
        readFileSync(x.participant.transcript, 'utf8').trimEnd().split('\n').length,
      hash: digest(turn + '\n'),
    };
  }
  if (failure === 'missing-cost') x.confirmation.through = x.confirmation.boundary;
  if (failure === 'cumulative-only') {
    const cumulative = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 14, cached_input_tokens: 3, output_tokens: 5 },
          last_token_usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 },
        },
      },
    });
    writeFileSync(x.participant.transcript, x.original + x.compacted + '\n' + cumulative + '\n');
    x.confirmation.through = { ...x.confirmation.through, hash: digest(cumulative + '\n') };
  }
  expect(() => x.f.observer.confirmCompaction!(x.confirmation)).toThrow();
  expect(x.f.observer.accounting().unknown).toBe(true);
});

it('does not use a compact acknowledgement as a model turn confirmation or accept it under H02', async () => {
  const x = await compactFixture();
  const forged = file(join(root, 'compact-as-turn.json'), {
    kind: 'h01-native-dispatch',
    method: 'turn/start',
    start: x.start,
    params: { threadId: x.start.session },
    response: { turn: { id: 'invented' } },
  });
  expect(() =>
    x.f.observer.confirmModelStart({
      key: x.start.key,
      session: x.start.session,
      turn: 'invented',
      evidence: forged,
    }),
  ).toThrow('h01-guard-start-unconfirmed');
  const second = realpathSync(mkdtempSync(join(tmpdir(), 'compact-other-')));
  const previous = root;
  root = second;
  try {
    const h02 = fixture({ kind: 'comparison-h02-guard' });
    h02.register();
    await expect(
      h02.observer.beforeModelStart({ ...h02.start, method: 'thread/compact/start' }),
    ).rejects.toThrow('native-compaction-start-forbidden');
    expect(() => h02.observer.confirmCompaction!(x.confirmation)).toThrow(
      'native-compaction-scenario',
    );
  } finally {
    root = previous;
    rmSync(second, { recursive: true, force: true });
  }
});

describe('known in-flight managed participants', () => {
  const nested = (start: H01ModelStart): H01ModelStart => ({
    ...start,
    session: 'nested',
    key: digest('managed nested role'),
    hash: digest('nested prompt'),
    stage: 'council',
  });
  it('waits with null counters after ACK, starts a registered nested role, then closes with primary usage', async () => {
    const f = fixture();
    f.register('actor', false);
    await f.observer.beforeModelStart(f.start);
    f.confirm();
    await expect(f.observer.verify()).resolves.toBeUndefined();
    expect(f.observer.accounting()).toMatchObject({
      inputUncached: null,
      output: null,
      observedResponses: null,
    });
    expect(readdirSync(f.native).some((name) => name.startsWith('unknown-'))).toBe(false);
    f.register('nested', false, 'council');
    await f.observer.beforeModelStart(nested(f.start));
    f.confirm(nested(f.start));
    expect(f.observer.accounting()).toMatchObject({
      reservedManagedStarts: 2,
      inputUncached: null,
    });
    f.appendUsage();
    f.appendUsage('nested');
    f.complete('nested');
    f.complete();
    await f.observer.verify();
    expect(createH01NativeGuard(f.controlRef).accounting()).toMatchObject({
      reservedManagedStarts: 2,
      observedResponses: 2,
      inputUncached: 14,
      output: 6,
      unknown: false,
    });
  });
  it('does not call an in-flight Temporal host reservation orphan before its exact registration', async () => {
    const f = fixture();
    f.register('actor', false);
    await f.observer.beforeModelStart(f.start);
    f.confirm();
    f.register('nested', false, 'council');
    const start = { ...nested(f.start), origin: 'temporal-host' as const };
    readerBudget(join(f.control.roots.hostRoot, 'turn-credits'), 5)(start.key, start.hash);
    await expect(f.observer.verify()).resolves.toBeUndefined();
    await f.observer.beforeModelStart(start);
    f.confirm(start);
    expect(f.observer.accounting().reservedManagedStarts).toBe(2);
    expect(readdirSync(f.native).some((name) => name.startsWith('unknown-'))).toBe(false);
  });
  it('uses known lower bounds without turning pending participant counters into zero', async () => {
    const f = fixture({
      budget: {
        maxManagedStarts: 5,
        maxElapsedMs: 1000,
        reserveMs: 100,
        maxInputUncached: 7,
        maxOutput: 50,
      },
    });
    f.register('actor', false);
    await f.observer.beforeModelStart(f.start);
    f.confirm();
    f.register('nested', false, 'council');
    await f.observer.beforeModelStart(nested(f.start));
    f.confirm(nested(f.start));
    f.appendUsage();
    await f.observer.verify();
    expect(f.observer.accounting().inputUncached).toBeNull();
    f.register('third', false, 'council');
    await expect(
      f.observer.beforeModelStart({
        ...nested(f.start),
        session: 'third',
        key: digest('third'),
      }),
    ).rejects.toThrow('usage-unknown-or-exhausted');
    expect(f.observer.accounting().reservedManagedStarts).toBe(2);
  });
  it('stops when later primary usage exceeds the observed cutoff and keeps the actual costs', async () => {
    const f = fixture({
      budget: {
        maxManagedStarts: 5,
        maxElapsedMs: 1000,
        reserveMs: 100,
        maxInputUncached: 10,
        maxOutput: 50,
      },
    });
    f.register('actor', false);
    await f.observer.beforeModelStart(f.start);
    f.confirm();
    f.register('nested', false, 'council');
    await f.observer.beforeModelStart(nested(f.start));
    f.confirm(nested(f.start));
    f.appendUsage();
    f.appendUsage('nested');
    await expect(f.observer.verify()).rejects.toThrow('usage-unknown-or-exhausted');
    expect(f.observer.accounting()).toMatchObject({
      reservedManagedStarts: 2,
      inputUncached: 14,
      unknown: true,
    });
  });
  it('keeps missing closed metrics permanently unknown even if counters append after sealing', async () => {
    const f = fixture();
    f.register('actor', false);
    await f.observer.beforeModelStart(f.start);
    f.confirm();
    await f.observer.verify();
    f.complete();
    await expect(f.observer.verify()).rejects.toThrow();
    f.appendUsage();
    expect(createH01NativeGuard(f.controlRef).accounting()).toMatchObject({
      inputUncached: null,
      unknown: true,
    });
    expect(readdirSync(f.native).some((name) => name.startsWith('unknown-'))).toBe(true);
  });
  it('never treats an unconfirmed ACK as permission for a nested effect', async () => {
    const f = fixture();
    f.register('actor', false);
    await f.observer.beforeModelStart(f.start);
    f.register('nested', false, 'council');
    await expect(f.observer.beforeModelStart(nested(f.start))).rejects.toThrow('dispatch-pending');
    expect(f.observer.accounting().reservedManagedStarts).toBe(1);
    f.confirm();
    await expect(f.observer.verify()).rejects.toThrow('h01-guard-unknown');
  });
});

describe('transient physical ledger lock', () => {
  it('returns nullable pending accounting and records a known completion without poisoning a busy ledger', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture();
    f.register();
    await f.observer.beforeModelStart(f.start);
    f.confirm();
    const lock = join(f.control.roots.hostRoot, 'turn-credits/lock');
    mkdirSync(lock);
    expect(f.observer.accounting()).toMatchObject({
      reservedManagedStarts: null,
      observedResponses: null,
      inputUncached: null,
      inputCached: null,
      output: null,
      unknown: true,
    });
    f.complete();
    let completed = false;
    const verifying = f.observer.verify().then(() => {
      completed = true;
    });
    void verifying.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(readdirSync(f.native).some((name) => name.startsWith('unknown-'))).toBe(false);
    rmSync(lock, { recursive: true });
    await vi.advanceTimersByTimeAsync(25);
    await verifying;
    expect(f.observer.accounting()).toMatchObject({
      reservedManagedStarts: 1,
      inputUncached: 7,
      unknown: false,
    });
  });
  it('waits both before and after one physical reservation and never retries the reservation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture();
    f.register();
    const ledger = join(f.control.roots.hostRoot, 'turn-credits'),
      lock = join(ledger, 'lock');
    mkdirSync(lock);
    const consumed = vi.fn(() => {
      mocks.afterConsume = undefined;
      mkdirSync(lock);
    });
    mocks.afterConsume = consumed;
    let completed = false;
    const starting = f.observer.beforeModelStart(f.start).then(() => {
      completed = true;
    });
    void starting.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    expect(existsSync(join(ledger, '0.credit'))).toBe(false);
    rmSync(lock, { recursive: true });
    await vi.advanceTimersByTimeAsync(25);
    expect(consumed).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(ledger, '0.credit'))).toBe(true);
    expect(f.observer.accounting().reservedManagedStarts).toBeNull();
    rmSync(lock, { recursive: true });
    await vi.advanceTimersByTimeAsync(25);
    await starting;
    f.confirm();
    f.complete();
    expect(f.observer.accounting()).toMatchObject({
      reservedManagedStarts: 1,
      unknown: false,
    });
    expect(consumed).toHaveBeenCalledOnce();
  });
  it.each(['start', 'verify'])(
    'keeps a stuck lock intact and fails at the original %s deadline',
    async (phase) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const f = fixture();
      f.register();
      const ledger = join(f.control.roots.hostRoot, 'turn-credits'),
        lock = join(ledger, 'lock');
      mkdirSync(lock);
      const running =
        phase === 'start' ? f.observer.beforeModelStart(f.start) : f.observer.verify();
      const rejection = expect(running).rejects.toThrow('deadline');
      void rejection.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      now = phase === 'start' ? BigInt(f.control.workDeadlineNs) : BigInt(f.control.deadlineNs);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(join(ledger, '0.credit'))).toBe(false);
      expect(f.observer.accounting()).toMatchObject({
        reservedManagedStarts: null,
        inputUncached: null,
        unknown: true,
      });
      expect(readdirSync(f.native).some((name) => name.startsWith('unknown-'))).toBe(true);
    },
  );
  it('never retries corrupt or rewound ledger data as a transient lock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture();
    f.register();
    await f.observer.beforeModelStart(f.start);
    f.confirm();
    writeFileSync(join(f.control.roots.hostRoot, 'turn-credits/0.credit'), '{}');
    await expect(f.observer.verify()).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => f.observer.accounting()).toThrow();
    expect(readdirSync(f.native).some((name) => name.startsWith('unknown-'))).toBe(true);
  });
});

it('reserves before a legacy effect, confirms primary response and preserves the ledger across instances', async () => {
  const f = fixture();
  const p = f.register();
  await f.observer.beforeModelStart(f.start);
  expect(readdirSync(join(f.control.roots.hostRoot, 'turn-credits'))).toContain('0.credit');
  expect(f.observer.accounting().unknown).toBe(true);
  f.confirm();
  f.complete();
  await f.observer.verify();
  const result = createH01NativeGuard(f.controlRef).accounting();
  expect(result).toMatchObject({
    reservedManagedStarts: 1,
    inputUncached: 7,
    inputCached: 2,
    output: 3,
    unknown: false,
  });
  expect(result.evidence.every((r) => digest(readFileSync(r.locator)) === r.hash)).toBe(true);
  const { creation: _creation, ...observed } = p;
  f.observer.observeParticipant(observed);
});
it('asserts an existing exact Temporal credit without charging a second time', async () => {
  const f = fixture();
  f.register();
  readerBudget(join(f.control.roots.hostRoot, 'turn-credits'), 5)(f.start.key, f.start.hash);
  await f.observer.beforeModelStart({ ...f.start, origin: 'temporal-host' });
  f.confirm({ ...f.start, origin: 'temporal-host' });
  expect(f.observer.accounting().reservedManagedStarts).toBe(1);
});
it('keeps a physical reservation without a dispatch record unknown across fresh instances', async () => {
  const f = fixture();
  f.register();
  readerBudget(join(f.control.roots.hostRoot, 'turn-credits'), 5)(
    digest('orphan'),
    digest('lost request'),
  );
  const fresh = createH01NativeGuard(f.controlRef);
  await expect(fresh.beforeModelStart(f.start)).rejects.toThrow('unaccounted-credit');
  expect(fresh.accounting()).toMatchObject({
    reservedManagedStarts: 1,
    unknown: true,
  });
});
it('uses the common-council origin and council stage in the same shared ledger', async () => {
  const f = fixture();
  f.register('actor', true, 'council');
  await f.observer.beforeModelStart({
    ...f.start,
    origin: 'common-council',
    stage: 'council',
  });
  expect(f.observer.accounting().reservedManagedStarts).toBe(1);
});
it('does not repeat a pending or already confirmed dispatch, including after a fresh guard instance', async () => {
  const f = fixture();
  f.register();
  await f.observer.beforeModelStart(f.start);
  await expect(
    createH01NativeGuard(f.controlRef).beforeModelStart({
      ...f.start,
      key: digest('next'),
    }),
  ).rejects.toThrow('dispatch-pending');
  f.confirm();
  f.complete();
  expect(createH01NativeGuard(f.controlRef).accounting().unknown).toBe(true);
  await expect(f.observer.beforeModelStart(f.start)).rejects.toThrow('h01-guard-unknown');
});
it('rejects blind retry even when the original dispatch is confirmed', async () => {
  const f = fixture();
  f.register();
  await f.observer.beforeModelStart(f.start);
  f.confirm();
  await expect(f.observer.beforeModelStart(f.start)).rejects.toThrow('no-blind-retry');
});
it('allows a distinct next delivery after a confirmed dispatch without confusing starts with responses', async () => {
  const f = fixture();
  f.register();
  await f.observer.beforeModelStart(f.start);
  f.confirm();
  const next = {
    ...f.start,
    key: digest('answer after LOAD'),
    hash: digest('second prompt'),
  };
  await f.observer.beforeModelStart(next);
  f.confirm(next);
  expect(f.observer.accounting()).toMatchObject({
    reservedManagedStarts: 2,
    observedResponses: 1,
    unknown: true,
  });
});
it.each(['missing', 'wrong-hash'])(
  'rejects a %s Temporal credit before any new effect',
  async (kind) => {
    const f = fixture();
    f.register();
    if (kind === 'wrong-hash')
      readerBudget(join(f.control.roots.hostRoot, 'turn-credits'), 5)(f.start.key, digest('wrong'));
    await expect(
      f.observer.beforeModelStart({ ...f.start, origin: 'temporal-host' }),
    ).rejects.toThrow('temporal-credit-missing');
    expect(f.observer.accounting().reservedManagedStarts).toBe(kind === 'missing' ? 0 : 1);
  },
);

it.each(['binary', 'request', 'source'])(
  'refuses a changed H05 %s pin immediately before recovery without writing',
  async (mode) => {
    const source = file(join(root, 'recovery-source.json'), { stable: true });
    const f = fixture({ kind: 'comparison-h05-guard', pins: [source] }, true);
    const p = f.register();
    await f.observer.beforeModelStart(f.start);
    f.confirm();
    writeFileSync(
      (mode === 'source' ? source : f.control[mode as 'binary' | 'request']).locator,
      'changed',
    );
    const before = readdirSync(f.native)
      .sort()
      .map((name) => [name, digest(readFileSync(join(f.native, name)))]);
    expect(() =>
      f.observer.assertRecoveryParticipant!(p.session, p.creation, p.transcript),
    ).toThrow('h01-guard-pin-changed');
    expect(
      readdirSync(f.native)
        .sort()
        .map((name) => [name, digest(readFileSync(join(f.native, name)))]),
    ).toEqual(before);
  },
);
it.each(['clock', 'work-deadline', 'hard-deadline'])(
  'does not reset the %s in another guard',
  async (kind) => {
    const f = fixture();
    f.register();
    now = kind === 'clock' ? 0n : kind === 'work-deadline' ? 1_900_000_000n : 2_000_000_000n;
    await expect(createH01NativeGuard(f.controlRef).beforeModelStart(f.start)).rejects.toThrow(
      kind === 'clock' ? 'clock-unknown' : 'deadline',
    );
    expect(f.observer.accounting().reservedManagedStarts).toBe(0);
  },
);
it('allows stop verification inside the reserve while forbidding new starts', async () => {
  const f = fixture();
  now = 1_950_000_000n;
  await f.observer.verify();
  now = 2_000_000_000n;
  await expect(f.observer.verify()).rejects.toThrow('deadline');
});
it('preserves primary authorization rejection and never calls the model effect', async () => {
  const f = fixture();
  f.register();
  mocks.authorization.mockRejectedValue(new Error('grant changed'));
  const effect = vi.fn();
  await expect(
    h01GuardRequest(f.observer, 'execution', 'turn/start', { threadId: 'actor' }, effect),
  ).rejects.toThrow('grant changed');
  expect(effect).not.toHaveBeenCalled();
  mocks.authorization.mockResolvedValue(undefined);
  expect(f.observer.accounting().unknown).toBe(true);
});
it.each(['bad-key', 'bad-hash', 'bad-origin', 'stage'])('refuses %s starts', async (kind) => {
  const f = fixture();
  f.register();
  const start = {
    ...f.start,
    ...(kind === 'bad-key'
      ? { key: '?' }
      : kind === 'bad-hash'
        ? { hash: '?' }
        : kind === 'bad-origin'
          ? { origin: 'unmanaged' }
          : { stage: 'council' }),
  } as H01ModelStart;
  await expect(f.observer.beforeModelStart(start)).rejects.toThrow();
  expect(f.observer.accounting().reservedManagedStarts).toBe(0);
});
it('rejects changed pinned bytes and preserves unknown after the bytes return', async () => {
  const f = fixture();
  writeFileSync(f.control.binary.locator, 'changed');
  await expect(f.observer.verify()).rejects.toThrow('pin-changed');
  writeFileSync(f.control.binary.locator, 'pinned native binary, never executed');
  expect(f.observer.accounting().unknown).toBe(true);
});
it('keeps missing native usage null and stop/outcome unknown sticky', async () => {
  const f = fixture();
  f.register('actor', false);
  f.complete('actor', 'unknown');
  expect(f.observer.accounting()).toMatchObject({
    inputUncached: null,
    inputCached: null,
    output: null,
    unknown: true,
  });
  await expect(f.observer.verify()).rejects.toThrow();
});
it.each([
  { confirmed: false },
  { sessions: ['foreign'] },
  { remainingProcesses: [{ pid: 1 }] },
  { evidence: [] },
])('refuses an unconfirmed stop %j without completion', (patch) => {
  const f = fixture();
  f.register();
  expect(() => f.complete('actor', 'completed', patch)).toThrow('stop-unconfirmed');
  expect(readdirSync(f.native).some((name) => name.startsWith('complete-'))).toBe(false);
});
it('refuses unexpected participant discovery rather than adopting a foreign thread', () => {
  const f = fixture();
  expect(() =>
    f.observer.observeParticipant({
      session: 'foreign',
      transcript: '/unknown',
      run: null,
      stage: 'helper',
    }),
  ).toThrow();
  expect(f.observer.accounting().unknown).toBe(true);
});
it('retains both actual RPC response observations and charges only model sends', async () => {
  const f = fixture();
  const transcript = f.transcript();
  await h01GuardRequest(f.observer, 'execution', 'thread/start', {}, async () => ({
    model: 'fixture',
    reasoningEffort: 'high',
    thread: { id: 'actor', path: transcript, turns: [] },
  }));
  await h01GuardRequest(f.observer, 'execution', 'turn/start', { threadId: 'actor' }, async () => ({
    turn: { id: 'turn' },
  }));
  const effect = vi.fn().mockResolvedValue({ status: 'idle' });
  await expect(h01GuardRequest(f.observer, 'execution', 'noop', {}, effect)).resolves.toEqual({
    status: 'idle',
  });
  expect(f.observer.accounting().reservedManagedStarts).toBe(1);
  expect(readdirSync(f.native).filter((name) => name.startsWith('rpc-'))).toHaveLength(2);
});
it('retains a lost RPC response as pending without retrying the external effect', async () => {
  const f = fixture();
  f.register();
  const effect = vi.fn().mockRejectedValue(new Error('lost response'));
  await expect(
    h01GuardRequest(f.observer, 'execution', 'turn/start', { threadId: 'actor' }, effect),
  ).rejects.toThrow('lost response');
  expect(effect).toHaveBeenCalledTimes(1);
  expect(createH01NativeGuard(f.controlRef).accounting().unknown).toBe(true);
});
it('keeps a lost creation response unknown before any credit and refuses a second create', async () => {
  const f = fixture();
  const effect = vi.fn().mockRejectedValue(new Error('create response lost'));
  await expect(
    h01GuardRequest(f.observer, 'execution', 'thread/start', {}, effect),
  ).rejects.toThrow('create response lost');
  const fresh = createH01NativeGuard(f.controlRef);
  expect(fresh.accounting()).toMatchObject({
    reservedManagedStarts: 0,
    unknown: true,
  });
  await expect(h01GuardRequest(fresh, 'execution', 'thread/start', {}, effect)).rejects.toThrow(
    'h01-guard-unknown',
  );
  expect(effect).toHaveBeenCalledTimes(1);
});
it('keeps a non-Error publication failure unknown and does not charge a model start', async () => {
  const f = fixture();
  f.register();
  mocks.failRecord = 'start-';
  await expect(f.observer.beforeModelStart(f.start)).rejects.toBe('storage outcome unknown');
  mocks.failRecord = '';
  expect(f.observer.accounting()).toMatchObject({
    unknown: true,
    reservedManagedStarts: 0,
  });
});
it('keeps an active missing path/usage null while a registered nested role starts', async () => {
  const f = fixture();
  f.transcript();
  await h01GuardRequest(f.observer, 'execution', 'thread/start', {}, async () => ({
    model: 'fixture',
    reasoningEffort: 'high',
    thread: { id: 'actor', path: null, turns: [] },
  }));
  await h01GuardRequest(f.observer, 'execution', 'turn/start', { threadId: 'actor' }, async () => ({
    turn: { id: 'turn' },
  }));
  expect(f.observer.accounting()).toMatchObject({
    inputUncached: null,
    unknown: true,
  });
  await f.observer.verify();
  f.register('nested', false, 'council');
  await f.observer.beforeModelStart({
    ...f.start,
    session: 'nested',
    stage: 'council',
    key: digest('approved nested'),
  });
  expect(f.observer.accounting()).toMatchObject({
    reservedManagedStarts: 2,
    inputUncached: null,
  });
});
it('reserves no credit when the physical model-start cap is zero', async () => {
  const f = fixture({
    budget: {
      maxManagedStarts: 0,
      maxElapsedMs: 1000,
      reserveMs: 100,
      maxInputUncached: 100,
      maxOutput: 50,
    },
  });
  f.register();
  await expect(f.observer.beforeModelStart(f.start)).rejects.toThrow('budget-exhausted');
  expect(f.observer.accounting().reservedManagedStarts).toBe(0);
});
it.each(['input', 'output'])(
  'keeps stop verification available at the %s cap but refuses a new turn',
  async (kind) => {
    const f = fixture({
      budget: {
        maxManagedStarts: 5,
        maxElapsedMs: 1000,
        reserveMs: 100,
        maxInputUncached: kind === 'input' ? 7 : 100,
        maxOutput: kind === 'output' ? 3 : 50,
      },
    });
    f.register();
    await f.observer.verify();
    await expect(f.observer.beforeModelStart(f.start)).rejects.toThrow(
      'usage-unknown-or-exhausted',
    );
  },
);
it('records later path evidence without fabricating path or adopting unrelated reads', async () => {
  const f = fixture();
  const path = f.transcript();
  await h01GuardRequest(f.observer, 'execution', 'thread/start', {}, async () => ({
    model: 'fixture',
    reasoningEffort: 'high',
    thread: { id: 'actor', path: null, turns: [] },
  }));
  await h01GuardRequest(f.observer, 'execution', 'turn/start', { threadId: 'actor' }, async () => ({
    turn: { id: 'turn' },
  }));
  await h01GuardRequest(
    f.observer,
    'execution',
    'thread/read',
    { threadId: 'foreign' },
    async () => ({ thread: { id: 'foreign', path } }),
  );
  await h01GuardRequest(
    f.observer,
    'execution',
    'thread/read',
    { threadId: 'actor' },
    async () => ({ thread: { id: 'actor', path } }),
  );
  await h01GuardRequest(
    f.observer,
    'execution',
    'thread/read',
    { threadId: 'actor' },
    async () => ({ thread: { id: 'actor', path, status: 'idle' } }),
  );
  f.complete();
  expect(f.observer.accounting()).toMatchObject({
    inputUncached: 7,
    unknown: false,
  });
});
it('does not invent zero usage for an acknowledged turn with an existing transcript', async () => {
  const f = fixture();
  f.register('actor', false);
  await f.observer.beforeModelStart(f.start);
  f.confirm();
  expect(f.observer.accounting()).toMatchObject({
    inputUncached: null,
    observedResponses: null,
    unknown: true,
  });
  await f.observer.verify();
  expect(readdirSync(f.native).some((name) => name.startsWith('unknown-'))).toBe(false);
});
it('rejects a later path observation for another thread', () => {
  const f = fixture();
  const p = f.register();
  const pathObservation = file(join(root, 'foreign-read.json'), {
    method: 'thread/read',
    response: { thread: { id: 'foreign', path: p.transcript } },
  });
  expect(() => f.observer.registerParticipant({ ...p, pathObservation })).toThrow(
    'path-unconfirmed',
  );
});
it('rejects an incompatible repeated registration while preserving the original participant', () => {
  const f = fixture();
  const p = f.register();
  const newPath = f.transcript('other');
  const pathObservation = file(join(root, 'moved-read.json'), {
    method: 'thread/read',
    response: { thread: { id: 'actor', path: newPath } },
  });
  expect(() =>
    f.observer.registerParticipant({
      ...p,
      transcript: newPath,
      pathObservation,
    }),
  ).toThrow('participant-conflict');
});
it('refuses a hardlinked control before reading its contents', () => {
  const f = fixture();
  linkSync(f.controlRef.locator, join(root, 'alias'));
  expect(() => createH01NativeGuard(f.controlRef)).toThrow('file-unknown');
});
it('preserves late confirmation and completion as unknown after the hard deadline', async () => {
  const f = fixture();
  f.register();
  await f.observer.beforeModelStart(f.start);
  now = 2_000_000_000n;
  expect(() => f.confirm()).toThrow('deadline');
  expect(() => f.complete()).toThrow('deadline');
  expect(f.observer.accounting().unknown).toBe(true);
});

function runtime(f: ReturnType<typeof fixture>) {
  const path = join(f.control.roots.stateRoot, 'legacy-runtime');
  mkdirSync(path);
  file(join(path, '.comparison-h01-owner.json'), {
    kind: 'comparison-h01-runtime-owner',
    opId: f.control.opId,
    requestHash: f.control.requestHash,
    controlRef: f.controlRef,
  });
  for (const name of [
    'adapters/codex/appServerTransport.ts',
    'adapters/codex/appServerWaits.ts',
    'cli/nativeCoderSessions.ts',
    'cli/taskChatCouncil.ts',
    'cli/chatRoles.ts',
  ]) {
    const target = join(path, name);
    mkdirSync(dirname(target), { recursive: true });
    // The H01 baseline admits this exact historical council implementation.
    const source =
      name === 'cli/taskChatCouncil.ts'
        ? 'tests/temporal/fixtures/h01-legacy-task-chat-council.snapshot'
        : name;
    copyFileSync(resolve(import.meta.dirname, '..', source), target);
  }
  return path;
}
it('builds a separate snapshot overlay preserving all base bytes and explicit role stages', async () => {
  const f = fixture({}, true);
  const path = runtime(f);
  const transport = join(path, 'adapters/codex/appServerTransport.ts');
  const original = readFileSync(transport);
  const result = prepareH01LegacyOverlay(path, f.controlRef);
  verifyH01LegacyOverlay(path, f.controlRef, result.overlay);
  await f.observer.verify();
  expect(readFileSync(transport.replace('.ts', '.base.ts'))).toEqual(original);
  expect(result.files).toContainEqual({
    locator: join(path, 'adapters/codex/appServerWaits.ts'),
    hash: digest(readFileSync(join(path, 'adapters/codex/appServerWaits.ts'))),
  });
  expect(readFileSync(transport, 'utf8')).toContain('h01-overlay-stage-required');
  expect(readFileSync(join(path, 'cli/nativeCoderSessions.ts'), 'utf8')).toContain(
    "    `coder:${id}:create`,\n    'execution',\n  );",
  );
  expect(readFileSync(join(path, 'cli/taskChatCouncil.ts'), 'utf8')).toContain("'council',");
  expect(result.files.every((entry) => digest(readFileSync(entry.locator)) === entry.hash)).toBe(
    true,
  );
  expect(
    (
      JSON.parse(readFileSync(result.overlay.locator, 'utf8')) as {
        qualification: boolean;
      }
    ).qualification,
  ).toBe(false);
  expect(() => prepareH01LegacyOverlay(path, f.controlRef)).toThrow('source-unsupported');
});
it.each(['root', 'owner', 'source'])(
  'refuses an unsupported overlay %s before mutating transport',
  (kind) => {
    const f = fixture({}, true);
    const path = runtime(f);
    const transport = join(path, 'adapters/codex/appServerTransport.ts');
    if (kind === 'owner') file(join(path, '.comparison-h01-owner.json'), {});
    if (kind === 'source') writeFileSync(join(path, 'cli/chatRoles.ts'), 'unsupported source');
    const before = readFileSync(transport);
    expect(() => prepareH01LegacyOverlay(kind === 'root' ? root : path, f.controlRef)).toThrow();
    expect(readFileSync(transport)).toEqual(before);
    expect(existsSync(transport.replace('.ts', '.base.ts'))).toBe(false);
  },
);
it('does not write outside the owned snapshot when a parent changes before opening the mutation fd', () => {
  const f = fixture({}, true);
  const path = runtime(f);
  const cli = join(path, 'cli');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const protectedFile = file(join(outside, 'nativeCoderSessions.ts'), 'protected external bytes');
  mocks.beforeOpen = (target, flags) => {
    if (target === join(cli, 'nativeCoderSessions.ts') && (flags & constants.O_RDWR) !== 0) {
      mocks.beforeOpen = undefined;
      renameSync(cli, cli + '.original');
      symlinkSync(outside, cli);
    }
  };
  expect(() => prepareH01LegacyOverlay(path, f.controlRef)).toThrow('permission-denied');
  expect(digest(readFileSync(protectedFile.locator))).toBe(protectedFile.hash);
});
it('rejects declared after-hash updates and corrupted preimages rather than trusting the overlay manifest', () => {
  const f = fixture({}, true);
  const path = runtime(f);
  const result = prepareH01LegacyOverlay(path, f.controlRef);
  const changed = result.files.find((entry) =>
    entry.locator.endsWith('/cli/nativeCoderSessions.ts'),
  )!;
  writeFileSync(changed.locator, 'unapproved overlay code');
  const body = JSON.parse(readFileSync(result.overlay.locator, 'utf8')) as {
    files: InputRef[];
  };
  body.files.find((entry) => entry.locator === changed.locator)!.hash =
    digest('unapproved overlay code');
  const modified = file(result.overlay.locator, body);
  expect(() => verifyH01LegacyOverlay(path, f.controlRef, modified)).toThrow('manifest-changed');
  writeFileSync(changed.locator + '.h01-preimage.snapshot', 'unapproved preimage');
  expect(() => verifyH01LegacyOverlay(path, f.controlRef, modified)).toThrow('source-unsupported');
});
it('refuses an altered static overlay plan before any snapshot mutation', () => {
  const f = fixture({}, true);
  const path = runtime(f);
  writeFileSync(join(root, 'overlay-plan.json'), '{}');
  expect(() => prepareH01LegacyOverlay(path, f.controlRef)).toThrow('pin-changed');
});
it('runs the generated wrapper only against a fake base and refuses every missing-stage constructor before super', async () => {
  const f = fixture({}, true);
  const path = runtime(f);
  f.register();
  const result = prepareH01LegacyOverlay(path, f.controlRef);
  const source = readFileSync(result.files[0]!.locator, 'utf8');
  const executed = vi.fn();
  const sent = vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockImplementation(async (method) =>
      method === 'mcpServerStatus/list' ? { data: [], nextCursor: null } : { turn: { id: 'turn' } },
    );
  class Base {
    constructor(...args: unknown[]) {
      executed(...args);
    }
    request(...args: unknown[]) {
      return sent(...args);
    }
  }
  const sandbox = {
    exports: {} as Record<string, new (...args: unknown[]) => { request: typeof sent }>,
    require(name: string) {
      return name.includes('appServerTransport.base')
        ? { StdioAppServer: Base }
        : {
            createH01NativeGuard: () => f.observer,
            h01GuardRequest: actualGuardRequest,
            h01NativePolicy,
            h01ApprovedNativeBinary,
          };
    },
  };
  const code = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
    },
  }).outputText;
  runInNewContext(code, sandbox);
  const Wrapper = sandbox.exports.StdioAppServer!;
  expect(() => new Wrapper('never-exec', [], path, 'journal')).toThrow('stage-required');
  expect(executed).not.toHaveBeenCalled();
  expect(
    () => new Wrapper('unapproved', ['app-server'], path, 'journal', undefined, 'execution'),
  ).toThrow('binary-unapproved');
  expect(executed).not.toHaveBeenCalled();
  const wrapper = new Wrapper(
    f.control.binary.locator,
    ['app-server'],
    path,
    'journal',
    undefined,
    'execution',
  );
  expect(executed.mock.calls[0]![1]).toEqual([
    '-c',
    'features.apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.multi_agent=false',
    'app-server',
  ]);
  await wrapper.request('turn/start', { threadId: 'actor' });
  expect(sent.mock.calls.map(([method]) => method)).toEqual(['mcpServerStatus/list', 'turn/start']);
  expect(f.observer.accounting().reservedManagedStarts).toBe(1);
});
it.each(
  [
    [],
    ['--enable', 'multi_agent', 'app-server'],
    ['-c', 'features.apps=true', 'app-server'],
    ['--config', 'features.multi_agent=true', 'app-server'],
    ['app-server', '--help'],
    ['-c', 'model="unapproved"', 'app-server'],
    ['-c', 'mcp_servers.fixture.url=""', 'app-server'],
    [
      '-c',
      'mcp_servers.fixture.enabled=false',
      '-c',
      'mcp_servers.fixture.url="https://host"',
      'app-server',
    ],
  ].map((args) => [args]),
)('rejects unsupported or conflicting native args %j', (args) => {
  expect(() => h01NativePolicy(args)).toThrow('native-args-unsupported');
});
it('prepends the fixed native feature policy and preserves all supported stricter caller restrictions', () => {
  const args = [
    '--disable',
    'apps',
    '--disable',
    'plugins',
    '--disable',
    'multi_agent',
    '--config',
    'web_search="disabled"',
    '-c',
    'features.apps=false',
    '--config',
    'mcp_servers.fixture.enabled=false',
    '--config',
    'mcp_servers.fixture.enabled=false',
    '--config',
    'mcp_servers.fixture.url=""',
    'app-server',
  ];
  expect(h01NativePolicy(args)).toEqual({
    args: [
      '-c',
      'features.apps=false',
      '-c',
      'features.plugins=false',
      '-c',
      'features.multi_agent=false',
      ...args,
    ],
    disabled: ['fixture'],
  });
});
it('refuses a turn without a primary MCP inventory, even if the adapter declares itself safe', async () => {
  const f = fixture();
  f.register('actor', true, 'execution', false);
  await expect(f.observer.beforeModelStart(f.start)).rejects.toThrow('capabilities-missing');
  expect(f.observer.accounting().reservedManagedStarts).toBe(0);
});
it.each(['model', 'effort'])(
  'checks the primary native %s before charging a turn',
  async (field) => {
    const f = fixture({
      profile: {
        model: field === 'model' ? 'expected' : 'fixture',
        effort: field === 'effort' ? 'low' : 'high',
        clientVersion: 'fixture',
      },
    });
    f.register();
    await expect(f.observer.beforeModelStart(f.start)).rejects.toThrow('profile-unconfirmed');
    expect(f.observer.accounting().reservedManagedStarts).toBe(0);
  },
);
it.each([{ model: 'other' }, { effort: 'low' }])(
  'refuses a per-turn profile override %j',
  async (override) => {
    const f = fixture();
    f.register();
    const effect = vi.fn();
    await expect(
      h01GuardRequest(
        f.observer,
        'execution',
        'turn/start',
        { threadId: 'actor', ...override },
        effect,
      ),
    ).rejects.toThrow('profile-unconfirmed');
    expect(effect).not.toHaveBeenCalled();
  },
);
it('refuses missing or incomplete native probe ports and binds capability evidence to its own session', async () => {
  const f = fixture();
  f.register();
  const effect = vi.fn();
  await expect(
    actualGuardRequest(f.observer, 'execution', 'turn/start', { threadId: 'actor' }, effect),
  ).rejects.toThrow('probe-required');
  const evidence = file(join(root, 'foreign-capability.json'), {
    kind: 'h01-native-capabilities',
    session: 'foreign',
    response: { data: [] },
  });
  expect(() =>
    f.observer.registerCapabilities({
      session: 'actor',
      evidence,
      disabled: [],
    }),
  ).toThrow('capabilities-unconfirmed');
  expect(effect).not.toHaveBeenCalled();
});
it('rejects an incomplete primary MCP page before any model effect', async () => {
  const f = fixture();
  f.register();
  const effect = vi.fn();
  await expect(
    actualGuardRequest(f.observer, 'execution', 'turn/start', { threadId: 'actor' }, effect, {
      disabled: [],
      request: async () => ({ data: [], nextCursor: 'incomplete' }),
    }),
  ).rejects.toThrow('inventory-incomplete');
  expect(effect).not.toHaveBeenCalled();
  expect(f.observer.accounting().reservedManagedStarts).toBe(0);
});
it.each([{}, { httpOrigin: null, serverCapabilities: null }])(
  'accepts primary disabled MCP entries with optional metadata %j',
  async (optionalMetadata) => {
    const f = fixture();
    f.register();
    const response = {
      data: [
        {
          name: 'fixture',
          runtimeStatus: 'disabled',
          pluginId: null,
          serverInfo: null,
          ...optionalMetadata,
          toolsError: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
        },
      ],
      nextCursor: null,
    };
    await actualGuardRequest(
      f.observer,
      'execution',
      'turn/start',
      { threadId: 'actor', model: 'fixture', effort: 'high' },
      async () => ({ turn: { id: 'turn' } }),
      { disabled: ['fixture'], request: async () => response },
    );
    expect(f.observer.accounting().reservedManagedStarts).toBe(1);
  },
);
it('rechecks primary model and effort on resume without replacing the original creation', async () => {
  const f = fixture();
  const participant = f.register();
  await h01GuardRequest(
    f.observer,
    'execution',
    'thread/resume',
    { threadId: 'actor' },
    async () => ({
      model: 'fixture',
      reasoningEffort: 'high',
      thread: { id: 'actor', path: participant.transcript },
    }),
  );
  await expect(
    h01GuardRequest(f.observer, 'execution', 'thread/resume', { threadId: 'actor' }, async () => ({
      model: 'other',
      reasoningEffort: 'high',
      thread: { id: 'actor', path: participant.transcript },
    })),
  ).rejects.toThrow('profile-unconfirmed');
  expect(f.observer.accounting()).toMatchObject({
    unknown: true,
    reservedManagedStarts: 0,
  });
});
