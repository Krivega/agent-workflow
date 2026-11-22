import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import { verifyH06TemporalSeriesPrimary } from './comparisonH06TemporalSeriesPrimary.js';

const native = vi.hoisted(() => ({
  authority: vi.fn(),
  failure: vi.fn((_binding: unknown, pin: unknown) => pin),
  start: vi.fn(),
  chain: vi.fn(),
  usage: vi.fn(),
  seal: vi.fn(),
  ledger: vi.fn(),
  profiles: vi.fn(),
}));
vi.mock('./comparisonH06NativeAttempt.js', () => ({
  openH06NativeAttemptTurnLedger: () => ({ inspect: native.ledger }),
}));
vi.mock('./comparisonH06ManagedProfiles.js', () => ({
  verifyH06ManagedProfiles: native.profiles,
}));
vi.mock('./comparisonH06TemporalAutonomousAuthority.js', () => ({
  readH06TemporalAutonomousAuthority: native.authority,
}));
vi.mock('./comparisonH06NativeTemporal.js', () => ({ readH06NativeTemporalStart: native.start }));
vi.mock('./comparisonH06NativeFailure.js', () => ({ checkH06NativeFailure: native.failure }));
vi.mock('./comparisonH06NativeTemporalEvidence.js', () => ({
  checkH06NativeTemporalEvidence: native.chain,
}));
vi.mock('./comparisonH06NativeUsage.js', () => ({
  checkH06NativeTemporalAttemptUsage: native.usage,
  sealH06NativeUsage: native.seal,
}));

const created: string[] = [];
afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-series-primary-'));
  created.push(root);
  const evidence = join(root, 'attempt'),
    serverRoot = evidence + '-server',
    requestHash = digest('request');
  function save(path: string, body: unknown = {}) {
    const bytes = JSON.stringify(body);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  }
  const saved = (name: string, body?: unknown) => save(join(evidence, name + '.json'), body);
  const serverFile = (name: string, body?: unknown) => save(join(serverRoot, name + '.json'), body);
  const operationId = 'h06';
  const authority = {
    receipt: saved('authority'),
    nativeClaim: saved('attempt-claim'),
    requestHash,
    request: {
      evidenceRoot: evidence,
      binding: { operationId },
      stimulus: { longStageMs: 30_000 },
      chat: { threadId: 'root', workspace: root },
    },
    grant: {
      sourceTurnId: 'grant-turn',
      anchor: { turn_id: 'grant-turn' },
      transcript: join(root, 'root.jsonl'),
      source: { locator: join(root, 'root.jsonl') + '#L3', hash: 'a'.repeat(64) },
    },
    server: { root: serverRoot, expected: { requestHash } },
    budget: { reserveMs: 100 },
    startedAt: 100,
    workDeadlineMs: 1000,
    stopDeadlineMs: 1100,
  };
  const execution = {
    evidence,
    start: {
      operationId,
      initialFailure: saved('f01/receipt'),
      controlMode: { kind: 'temporal-autonomous/3', authority: authority.receipt },
    },
  };
  const chain = { status: 'CHAIN_VERIFIED', workflowId: 'workflow', runId: 'execution' };
  const makePhase = (stage: string, pid: number) => ({
    pauseAck: saved(stage + '-pause'),
    status: saved(stage + '-status'),
    host: saved(stage + '-host', { owner: { pid } }),
    resumeAck: saved(stage + '-resume'),
  });
  const phasePids = { warm: 11, cold: 12 };
  const executionRefs = {
    authority: authority.receipt,
    started: saved('started'),
    warm: makePhase('warm', phasePids.warm),
    cold: makePhase('cold', phasePids.cold),
    history: saved('history-complete'),
  };
  const serverPid = 10;
  const ready = {
    kind: 'comparison-h06-native-temporal-server/2',
    ...authority.server.expected,
    process: { pid: serverPid },
  };
  const launch = {
    kind: 'comparison-h06-native-temporal-server-launch/2',
    expected: authority.server.expected,
    deadlineMs: authority.stopDeadlineMs,
    stopReserveMs: authority.budget.reserveMs,
  };
  const stopped = {
    kind: 'comparison-h06-native-temporal-server-stop/2',
    requestHash,
    launch: serverFile('server-launch', launch),
    ready: serverFile('server-ready', ready),
    receipt: { stopped: true, pids: [serverPid] },
  };
  const worker = (stage: string, pid: number) => ({
    kind: 'h06-native-temporal-process-outcome/1',
    stage,
    pid,
    server: stopped.ready,
    workDeadlineMs: authority.workDeadlineMs,
    stopDeadlineMs: authority.stopDeadlineMs,
    recordedAt: 1020,
    observedExit: true,
    failure: null,
    receipt: {
      stopped: true,
      pids: [pid],
      code: 0,
      signal: null,
      killed: false,
      deadlineReached: false,
    },
  });
  const warm = worker('initial-and-warm', phasePids.warm);
  const result = {
    primary: {
      ...executionRefs,
      workerStops: [
        serverFile('worker-initial-and-warm-outcome', warm),
        serverFile('worker-cold-outcome', worker('cold', phasePids.cold)),
      ],
      transportStops: ['initial', 'warm', 'cold'].map((stage) =>
        saved(`transport-${stage}/transport-stop`),
      ),
    },
    evidence: chain,
    server: { ready: stopped.ready, stopped: serverFile('server-stop', stopped) },
  };
  const usage = {
    status: 'WITHIN_BUDGET',
    binding: { participants: [{ session: 'writer' }], unavailable: [] as unknown[] },
    knownSubtotal: { responses: 2, inputUncached: 3, inputCached: 5, output: 7 },
    receipts: [],
  };
  native.authority.mockReturnValue(authority);
  native.start.mockReturnValue(execution);
  native.chain.mockReturnValue(chain);
  native.usage.mockReturnValue(usage);
  native.seal.mockReturnValue({ sealed: true });
  return {
    result: { ...result, usage },
    requestHash,
    evidence,
    authority,
    execution,
    ready,
    launch,
    stopped,
    warm,
    serverFile,
    usage,
  };
}

it('rechecks the stopped managed transports and links the underlying chain without granting full accounting', () => {
  const f = fixture();
  const verified = verifyH06TemporalSeriesPrimary(f.result, f.evidence, f.requestHash);
  expect(verified).toMatchObject({
    stopped: true,
    budgetExceeded: false,
    knownSubtotal: { observedResponses: 2, inputUncached: 3, inputCached: 5, output: 7 },
  });
  expect(verified.evidence).toHaveLength(21);
  expect(native.usage).toHaveBeenLastCalledWith(
    expect.objectContaining({ claim: f.authority.nativeClaim, participants: [{ sealed: true }] }),
  );
  f.usage.status = 'OVER_BUDGET';
  f.usage.binding.unavailable.push('missing primary read');
  expect(verifyH06TemporalSeriesPrimary(f.result, f.evidence, f.requestHash)).toMatchObject({
    stopped: false,
    budgetExceeded: true,
  });
});

it('reopens the admitted managed turn inventory only for successful bounded native recovery', () => {
  const f = fixture();
  const profile = { model: 'model', effort: 'high', clientVersion: '0.154.0' };
  const sealed = [{ session: 'writer', through: { locator: '/writer#L9', hash: 'a'.repeat(64) } }];
  const result = {
    ...f.result,
    primary: { ...f.result.primary, participants: sealed },
    acceptance: { profile: 'h06-autonomous-recovery/3', status: 'PASS' },
    finalization: 'WITHIN_PARENT_DEADLINE',
    duration: { status: 'LONG_STAGE_VERIFIED', minimumMs: 30_000 },
    result: { status: 'done' },
    replay: {
      status: 'REPLAY_VERIFIED',
      history: f.result.primary.history,
      workflowId: 'workflow',
      runId: 'execution',
    },
  };
  const ledger = { used: 1, admissions: [{ scope: { session: 'writer' } }] };
  native.ledger.mockReturnValue(ledger);
  native.profiles.mockReturnValue([]);
  expect(
    verifyH06TemporalSeriesPrimary(result, f.evidence, f.requestHash, profile).receipt,
  ).toMatchObject({
    root: { session: 'root', turnId: 'grant-turn', startedAtMs: f.authority.startedAt },
    managed: { receipts: [], starts: 1 },
  });
  expect(native.profiles).toHaveBeenCalledWith(sealed, ledger.admissions, profile);
  expect(
    verifyH06TemporalSeriesPrimary(
      { ...result, acceptance: { ...result.acceptance, status: 'FAIL' } },
      f.evidence,
      f.requestHash,
      profile,
    ),
  ).toMatchObject({ receipt: null, failed: true });
  expect(() =>
    verifyH06TemporalSeriesPrimary(
      { ...result, primary: { ...result.primary, participants: [{ session: 'writer' }] } },
      f.evidence,
      f.requestHash,
      profile,
    ),
  ).toThrow('h06-series-temporal-managed-end');
});

it.each([
  ['workerStops', null],
  ['workerStops', []],
  ['transportStops', null],
  ['transportStops', []],
])('requires every stopped process and transport pin %s %j', (key, value) => {
  const f = fixture();
  const result = { ...f.result, primary: { ...f.result.primary, [key as string]: value } };
  expect(() => verifyH06TemporalSeriesPrimary(result, f.evidence, f.requestHash)).toThrow(
    'inventory',
  );
});

it.each(['workerStops', 'transportStops'] as const)(
  'refuses changes after capturing the original %s',
  (key) => {
    const f = fixture();
    writeFileSync(f.result.primary[key][0]!.path, '{}\n');
    expect(() => verifyH06TemporalSeriesPrimary(f.result, f.evidence, f.requestHash)).toThrow(
      'pin-changed',
    );
  },
);

it('refuses a change to the managed usage after STOP', () => {
  const f = fixture();
  native.usage.mockReturnValue({
    ...f.usage,
    knownSubtotal: { ...f.usage.knownSubtotal, output: 17 },
  });
  expect(() => verifyH06TemporalSeriesPrimary(f.result, f.evidence, f.requestHash)).toThrow(
    'h06-series-temporal-usage-changed',
  );
});

it.each([
  'request',
  'authority-root',
  'execution-root',
  'operation',
  'mode',
  'chain',
  'history-path',
  'history-bytes',
])('rejects mismatched primary execution %s', (fault) => {
  const f = fixture();
  switch (fault) {
    case 'request':
      f.authority.requestHash = digest('other');
      break;
    case 'authority-root':
      f.authority.request.evidenceRoot += '-other';
      break;
    case 'execution-root':
      f.execution.evidence += '-other';
      break;
    case 'operation':
      f.execution.start.operationId += '-other';
      break;
    case 'mode':
      f.execution.start.controlMode.kind = 'different';
      break;
    case 'chain':
      native.chain.mockReturnValue({ status: 'different' });
      break;
    case 'history-path':
      f.result.primary.history.path += '-other';
      break;
    case 'history-bytes':
      writeFileSync(f.result.primary.history.path, 'changed');
      break;
  }
  expect(() => verifyH06TemporalSeriesPrimary(f.result, f.evidence, f.requestHash)).toThrow();
  expect(native.usage).not.toHaveBeenCalled();
});

it.each([
  ['ready', { kind: 'different' }],
  ['ready', { requestHash: digest('other') }],
  ['launch', { kind: 'different' }],
  ['launch', { expected: {} }],
  ['launch', { deadlineMs: 10 }],
  ['launch', { stopReserveMs: 10 }],
  ['stopped', { kind: 'different' }],
  ['stopped', { requestHash: digest('other') }],
  ['stopped', { ready: null }],
])('rejects a mismatched server %s %j', (target, change) => {
  const f = fixture();
  if (target === 'ready')
    f.result.server.ready = f.stopped.ready = f.serverFile('server-ready', {
      ...f.ready,
      ...change,
    });
  if (target === 'launch')
    f.stopped.launch = f.serverFile('server-launch', { ...f.launch, ...change });
  f.result.server.stopped = f.serverFile('server-stop', {
    ...f.stopped,
    ...(target === 'stopped' ? change : {}),
  });
  expect(() => verifyH06TemporalSeriesPrimary(f.result, f.evidence, f.requestHash)).toThrow(
    'h06-series-temporal-server',
  );
});

it.each([
  { pid: '11' },
  { pid: 11.5 },
  { pid: 1 },
  { pid: 10 },
  { receipt: { stopped: false } },
  { receipt: { stopped: true, pids: null } },
  { receipt: { stopped: true, pids: [12] } },
])('rejects unbound physical STOP %j', (change) => {
  const f = fixture();
  f.result.primary.workerStops[0] = f.serverFile('worker-initial-and-warm-outcome', {
    ...f.warm,
    ...change,
  });
  expect(() => verifyH06TemporalSeriesPrimary(f.result, f.evidence, f.requestHash)).toThrow(
    'h06-series-temporal-stop',
  );
});

it.each([
  { kind: 'different' },
  { stage: 'cold' },
  { pid: 13, receipt: { stopped: true, pids: [13] } },
  { server: null },
  { workDeadlineMs: 100 },
  { stopDeadlineMs: 100 },
  { recordedAt: '1020' },
  { recordedAt: 1020.5 },
  { recordedAt: 99 },
  { recordedAt: 1101 },
  { observedExit: false },
  { failure: 'error' },
  ...[{ code: 1 }, { signal: 'SIGTERM' }, { killed: true }, { deadlineReached: true }].map(
    (receipt) => ({ receipt }),
  ),
])('rejects an incomplete Worker outcome %j', (change) => {
  const f = fixture();
  f.result.primary.workerStops[0] = f.serverFile('worker-initial-and-warm-outcome', {
    ...f.warm,
    ...change,
    receipt: { ...f.warm.receipt, ...change.receipt },
  });
  expect(() => verifyH06TemporalSeriesPrimary(f.result, f.evidence, f.requestHash)).toThrow(
    'h06-series-temporal-worker',
  );
});
