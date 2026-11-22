import { defaultPayloadConverter } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { EventEmitter } from 'node:events';
import type * as ChildProcessModule from 'node:child_process';
import type * as ContractModule from './comparisonH01Contract.js';
import type * as GuardModule from './comparisonH01Guard.js';
import * as contract from './comparisonH01Contract.js';
import { readCardMarkdown } from '../adapters/project/cardMarkdown.js';
import { taskChatBrief } from '../cli/taskChatInputs.js';
import { fileConnectionReader } from '../adapters/project/fileConnectionReader.js';
import { object, parseConnection } from '../core/connection.js';
import { FileProjectCards } from '../adapters/project/fileProjectCards.js';
import type { H01AttemptContext } from './comparisonH01Contract.js';
import { localTaskKey } from '../src/policy/localTask.js';
import { validateLocalPlan } from '../src/policy/localPlanning.js';
import { readTaskCouncilSelection } from '../cli/taskChatSelection.js';
import { taskChatOptions } from '../cli/taskChatInputs.js';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as suiteData from '../core/comparison.js';
import type { ComparisonMaterial } from '../core/comparison.js';
import {
  canonical,
  digest,
  requestHash as storeRequestHash,
} from '../adapters/storage/storeCodec.js';
import type { StoreRequest } from '../core/evidence.js';
import { startLocalRun } from '../core/localRun.js';
import { compactContextLine } from '../adapters/project/compactContext.js';
import type { CompactContextPacket } from '../adapters/project/compactContext.js';
import { normativeRules } from '../core/compactContext.js';
import {
  h03ReaderInput,
  h03NativeCommands,
  h03Procedures,
  h03ProbeNames,
  h03ContextPath,
  publishH03Context,
  h03PreparedMetadata,
} from './comparisonH03Contract.js';
import { nativeReaderNotice } from '../src/adapters/codex/readerAuthority.js';
import type { InputRef } from '../core/localRun.js';
import type {
  H01BackendResult,
  H01ExecutionRequest,
  H01GuardDescriptor,
  H01NativeAccounting,
  H01KeeperInput,
} from './comparisonH01Contract.js';
import {
  h01ReadJson,
  h01Record,
  h01RequestHash,
  parseH01Profile,
} from './comparisonH01Contract.js';
import {
  captureH01RuntimeInventory,
  verifyH01Runtime,
  executeH01Child,
  h01Main,
  planH01,
  runH01,
  checkNativeCase,
} from './comparisonH01.js';
import { normalizeH01SeriesEvidence } from './comparisonH01SeriesEvidence.js';
import { h02NativeMain } from './comparisonH02Native.js';
import { h03NativeMain } from './comparisonH03Native.js';
import { h04NativeMain } from './comparisonH04Native.js';
import { h05NativeMain } from './comparisonH05Native.js';
import {
  readComparisonUsage,
  type ComparisonParticipant,
} from '../adapters/codex/comparisonUsage.js';

const provider = vi.hoisted(() => ({
  exec: vi.fn(),
  spawn: vi.fn(),
  capture: vi.fn(),
  verify: vi.fn(),
  accounting: vi.fn(),
  backend: vi.fn(),
  council: vi.fn(),
  checker: vi.fn<() => Promise<Record<string, unknown>>>(),
  stop: vi.fn(),
  keeper: vi.fn(),
  authorize: vi.fn(),
  guardAuthorization: vi.fn(),
  prepare: vi.fn(),
  overlayVerify: vi.fn(),
  connection: vi.fn(),
  nativeConnection: vi.fn(),
  connectionClose: vi.fn(),
  nativeClose: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: provider.exec,
  }),
  spawn: provider.spawn,
}));
vi.mock('../adapters/project/workflowInputs.js', () => ({
  FileWorkflowInputs: class {
    capture = provider.capture;
  },
}));
vi.mock('../examples/temporal-consumers/full/safety.mjs', () => ({
  ownProcess: () => ({ done: provider.checker(), stop: provider.stop }),
}));
vi.mock('./comparisonH01Contract.js', async (original) => ({
  ...(await original<typeof ContractModule>()),
  verifyH01Authorization: provider.authorize,
  verifyH01GuardAuthorization: provider.guardAuthorization,
}));
vi.mock('../core/comparison.js', async (original) => ({
  ...(await original<typeof suiteData>()),
}));
vi.mock('./comparisonH01Guard.js', async (original) => ({
  ...(await original<typeof GuardModule>()),
  createH01NativeGuard: (controlRef: InputRef) => ({
    controlRef,
    verify: provider.verify,
    accounting: provider.accounting,
  }),
  h01LegacyOverlayPlan: () => ({ pinned: 'plan' }),
  prepareH01LegacyOverlay: provider.prepare,
  verifyH01LegacyOverlay: provider.overlayVerify,
}));
vi.mock('./comparisonH01Legacy.js', () => ({
  createH01LegacyAdapter: () => ({ execute: provider.backend }),
  runH01NativeSession: provider.council,
}));
vi.mock('./comparisonH01Temporal.js', () => ({
  createH01TemporalAdapter: () => ({ execute: provider.backend }),
}));
vi.mock('./comparisonH02NativeLegacy.js', () => ({
  createH02NativeLegacyAdapter: () => ({ execute: provider.backend }),
}));
vi.mock('./comparisonH02NativeTemporal.js', () => ({
  createH02NativeTemporalAdapter: () => ({ execute: provider.backend }),
}));
vi.mock('./comparisonH03Legacy.js', () => ({
  createH03LegacyAdapter: () => ({ execute: provider.backend }),
}));
vi.mock('./comparisonH03Temporal.js', () => ({
  createH03TemporalAdapter: () => ({ execute: provider.backend }),
}));
vi.mock('./comparisonH04NativeLegacy.js', () => ({
  createH04NativeLegacyAdapter: () => ({ execute: provider.backend }),
}));
vi.mock('./comparisonH04NativeTemporal.js', () => ({
  createH04NativeTemporalAdapter: () => ({ execute: provider.backend }),
}));
vi.mock('./comparisonH05Legacy.js', () => ({
  createH05LegacyAdapter: () => ({ execute: provider.backend }),
}));
vi.mock('./comparisonH05Temporal.js', () => ({
  createH05TemporalAdapter: () => ({ execute: provider.backend }),
}));
vi.mock('./comparisonH01Keeper.js', () => ({
  runH01OwnedChild: provider.keeper,
}));
vi.mock('@temporalio/client', () => ({
  Client: class {},
  Connection: { connect: provider.connection },
}));
vi.mock('@temporalio/worker', () => ({
  NativeConnection: { connect: provider.nativeConnection },
}));

let root: string, request: H01ExecutionRequest, control: InputRef, requestRef: InputRef;
let account: H01NativeAccounting, checkerStop: Record<string, unknown>, backendOutcome: string;
const repo = resolve(import.meta.dirname, '..');
const criteria = JSON.parse(
  readFileSync(resolve(repo, 'tests/fixtures/qualification/suite.json'), 'utf8'),
) as {
  scenarios: { checks: string[] }[];
};
const h01Criteria = criteria.scenarios[0]!;
const material = JSON.parse(
  readFileSync(resolve(repo, 'tests/fixtures/qualification/materials.json'), 'utf8'),
) as {
  cases: ComparisonMaterial[];
};
const pin = (name: string, value: unknown) => h01Record(root, name, value);
function seriesEvidenceFixture(candidate = false, scenario: 'H-01' | 'H-02' | 'H-03' = 'H-01') {
  const label = scenario.replace('-', '').toLowerCase() as 'h01' | 'h02' | 'h03';
  const originalRequest = structuredClone(request);
  originalRequest.variant = candidate ? 'candidate' : 'baseline';
  if (scenario !== 'H-01') {
    originalRequest.kind = `comparison-${label}-execution`;
    originalRequest.budget.maxManagedStarts = 10;
  }
  const opId = originalRequest.opId;
  const record = (name: string, value: unknown) => pin('series-' + name, value);
  const raw = (name: string, value: unknown) => {
    const locator = resolve(root, 'series-primary', name);
    mkdirSync(resolve(root, 'series-primary'), { recursive: true });
    const bytes = Buffer.from(canonical(value) + '\n');
    writeFileSync(locator, bytes);
    return { locator, hash: digest(bytes) };
  };
  const primaryNativeStop = record('native-stop', {
    kind: 'writers-stopped',
    active_turn: false,
    remaining_terminals: 0,
    remaining_processes: 0,
    before_hash: 'a'.repeat(64),
    after_hash: 'a'.repeat(64),
    processes: [],
  });
  const checks = Object.fromEntries(
    criteria.scenarios[Number(scenario.slice(-2)) - 1]!.checks.map((key) => [key, true]),
  );
  const councilAnswer = h01Record(root, 'answer', {
    thread: 'council-primary',
    status: 'completed',
    stopped: primaryNativeStop,
    text: canonical({ outcome: 'accepted', checks, limitations: ['synthetic unit fixture'] }),
  });
  const nativeStop = (session: string, council = false) =>
    record('stop-' + session, {
      kind: `comparison-${label}-stop`,
      executionVersion: 2,
      opId,
      confirmed: true,
      sessions: [session],
      remainingProcesses: [],
      evidence: council ? [councilAnswer, primaryNativeStop] : [primaryNativeStop],
    });
  const finalStop = nativeStop('council-primary', true);
  const sessionNames =
    scenario === 'H-03'
      ? ['h03-session']
      : scenario === 'H-01'
        ? ['executor-primary', 'council-primary']
        : [
            'pricing-initial',
            'logging-initial',
            'storage-initial',
            ...(candidate ? ['pricing-repaired'] : []),
          ];
  const starts = scenario === 'H-01' ? 2 : scenario === 'H-02' ? 8 : 4;
  const participants: ComparisonParticipant[] = sessionNames.map((session, index) => {
    const locator = resolve(root, `series-${session}.jsonl`);
    const turns = scenario === 'H-01' ? 1 : !candidate && index === 0 ? 4 : 2;
    const rows = [
      { type: 'session_meta', payload: { id: session } },
      ...Array.from({ length: turns }, (_, turn) => ({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100 * (turn + 1),
              cached_input_tokens: 20 * (turn + 1),
              output_tokens: 10 * (turn + 1),
            },
            last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
          },
        },
      })),
    ].map((row) => canonical(row) + '\n');
    writeFileSync(locator, rows.join(''));
    return {
      session,
      transcript: locator,
      run: opId,
      stage: scenario === 'H-03' || (scenario === 'H-01' && index === 0) ? 'execution' : 'council',
      through: { locator: locator + '#L' + rows.length, hash: digest(rows.at(-1)!) },
    };
  });
  const completionRefs = participants.map((participant, index) =>
    raw(`complete-${digest(participant.session)}.json`, {
      participant,
      completion: {
        outcome: 'completed',
        stop: scenario === 'H-01' && index !== 0 ? finalStop : nativeStop(participant.session),
        evidence: [primaryNativeStop],
      },
    }),
  );
  mkdirSync(originalRequest.roots.artifactRoot, { recursive: true });
  const budgetBytes = Buffer.from(
    canonical({
      schemaVersion: 1,
      kind: 'task-model-budget',
      limit: originalRequest.budget.maxManagedStarts,
      credits: Array.from({ length: starts }, () => ({})),
    }),
  );
  const budgetManifest = { sha256: digest(budgetBytes), bytes: budgetBytes.length };
  writeFileSync(resolve(originalRequest.roots.artifactRoot, budgetManifest.sha256), budgetBytes);
  const budgetRef = raw('budget-' + String(starts).padStart(16, '0') + '.json', {
    limit: originalRequest.budget.maxManagedStarts,
    used: starts,
    manifest: budgetManifest,
  });
  const initialBudget = raw('budget-0000000000000000.json', {
    limit: originalRequest.budget.maxManagedStarts,
    used: 0,
    manifest: budgetManifest,
  });
  const accounting: H01NativeAccounting = {
    participants,
    receipts: participants.flatMap((participant) => readComparisonUsage(participant)),
    reservedManagedStarts: starts,
    observedResponses: starts,
    inputUncached: 80 * starts,
    inputCached: 20 * starts,
    output: 10 * starts,
    unknown: false,
    evidence: [initialBudget, budgetRef, ...completionRefs],
  };
  const clean = { stopped: true, code: 0, signal: null, killed: false, deadlineReached: false };
  const checker = h01Record(root, 'checker', {
    kind: 'comparison-h01-check',
    passed: true,
    stop: clean,
    stdout: record('checker-stdout', 'primary checker output'),
    stderr: record('checker-stderr', ''),
  });
  const timing = {
    start: { wall_ms: 1000, monotonic_ms: 0, clock_id: 'host' },
    end: { wall_ms: 1100, monotonic_ms: 100, clock_id: 'host' },
  };
  const spec = {
    kind: `comparison-${label}-operator`,
    schemaVersion: 1,
    opId,
    variant: originalRequest.variant,
    budget: originalRequest.budget,
    roots: originalRequest.roots,
    evidenceRoot: resolve(root, 'operator'),
    node: parseH01Profile(originalRequest.profile).binary,
    entrypoint: {
      locator: resolve(repo, 'tests/comparisonH01.ts'),
      hash: digest(readFileSync(resolve(repo, 'tests/comparisonH01.ts'))),
    },
    runtimeRoot: repo,
    ...(candidate
      ? {
          temporal: {
            binary: parseH01Profile(originalRequest.profile).binary,
            address: '127.0.0.1:17239',
            httpAddress: '127.0.0.1:17240',
            metricsAddress: '127.0.0.1:17241',
            namespace: 'default',
            taskQueue: 'series-unit',
            workflowsPath: resolve(repo, 'src/workflows/localTask.ts'),
            sqlitePath: resolve(root, 'operator/temporal.sqlite'),
          },
        }
      : {}),
  };
  if (scenario === 'H-03') {
    originalRequest.material = record('h03-material', material.cases[2]);
    originalRequest.criteria = record('h03-criteria', criteria.scenarios[2]);
    const user = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Synthetic H03 human input for a unit proof.' }],
      },
    };
    originalRequest.authorization.anchor.turn_id = 'h03-human-turn';
    originalRequest.authorization.source = {
      locator: originalRequest.authorization.transcript + '#L2',
      hash: digest(canonical(user) + '\n'),
    };
    writeFileSync(
      originalRequest.authorization.transcript,
      canonical({
        type: 'session_meta',
        payload: { id: originalRequest.authorization.anchor.thread_id },
      }) +
        '\n' +
        canonical(user) +
        '\n',
    );
  }
  const requestPin = record('request', originalRequest),
    specPin = record('spec', spec);
  const binding = {
    opId,
    variant: originalRequest.variant,
    requestHash: h01RequestHash(originalRequest),
    partialScope: true,
    qualification: false,
  };
  const child = {
    ...binding,
    kind: `comparison-${label}-execution-report`,
    executionVersion: 2,
    outcome: 'accepted',
    checks,
    evidence: [originalRequest.material, checker],
    stop: finalStop,
    nativeAcceptance: null as InputRef | null,
    projection: null as InputRef | null,
    accounting,
    timing,
    elapsedMs: 100,
  };
  const keeper = {
    kind: `${label}-keeper-stop`,
    opId,
    ...clean,
    ready: true,
    softStop: false,
    forcedStop: false,
    error: null,
    evidence: [] as InputRef[],
  };
  const owned = {
    ...binding,
    kind: `comparison-${label}-owned-report`,
    executionVersion: 2,
    outcome: 'accepted',
    child: {} as InputRef,
    stop: {} as InputRef,
    evidence: [] as InputRef[],
    accounting,
    timing,
    elapsedMs: 100,
  };
  const stops = [label, ...(candidate ? ['server'] : [])].map((name, index) => ({
    name,
    pid: 100 + index,
    error: null,
    receipt: { ...clean },
  }));
  const portStops = (
    candidate ? ['127.0.0.1:17239', '127.0.0.1:17240', '127.0.0.1:17241'] : []
  ).map((address) => ({ address, closed: true }));
  const outer = {
    ...binding,
    kind: `comparison-${label}-operator-report`,
    schemaVersion: 1,
    requestRef: requestPin,
    specRef: specPin,
    outcome: 'accepted',
    error: null,
    errors: [] as unknown[],
    timedOut: false,
    budget: originalRequest.budget,
    startedNs: '1000000',
    endedNs: '1001000000',
    deadlineNs: String(1_000_000n + BigInt(originalRequest.budget.maxElapsedMs) * 1_000_000n),
    elapsedMs: 1000,
    child: {} as unknown,
    stops,
    portStops,
    evidence: [] as InputRef[],
  };
  const refresh = () => {
    const childRef = record('child', child);
    keeper.evidence = [childRef];
    owned.child = childRef;
    owned.stop = record('keeper', keeper);
    owned.evidence = [childRef, owned.stop];
    outer.child = { ...owned, report: record('owned', owned) };
    outer.evidence = [
      requestPin,
      ...stops.map((entry) =>
        h01Record(root, 'stop-' + entry.name, {
          ...entry.receipt,
          pid: entry.pid,
          error: entry.error,
          owned: true,
        }),
      ),
      h01Record(root, 'ports-stopped', { portStops }),
    ];
    return {
      runId: `${scenario}:1:${originalRequest.variant}`,
      opId,
      request: requestPin,
      spec: specPin,
      operator: { ...outer, report: record('operator', outer) },
    };
  };
  return {
    child,
    owned,
    outer,
    keeper,
    record,
    nativeStop,
    originalRequest,
    refreshUsage() {
      accounting.receipts = participants.flatMap((participant) => readComparisonUsage(participant));
      for (const [field, source] of [
        ['observedResponses', 'responses'],
        ['inputUncached', 'input_uncached'],
        ['inputCached', 'input_cached'],
        ['output', 'output'],
      ] as const)
        accounting[field] = accounting.receipts.reduce((sum, row) => sum + (row[source] ?? 0), 0);
      for (const [index, participant] of participants.entries()) {
        const previous = completionRefs[index]!,
          value = object(h01ReadJson(previous));
        value.participant = participant;
        completionRefs[index] = raw('complete-' + digest(participant.session) + '.json', value);
        accounting.evidence = accounting.evidence.map((ref) =>
          ref.locator === previous.locator ? completionRefs[index]! : ref,
        );
      }
    },
    accounting,
    participants,
    finalStop,
    primaryNativeStop,
    checker,
    refresh,
    completionRefs,
    budgetRef,
    raw,
  };
}

it.each([false, true])(
  'normalizes the real operator→owned→child shape with primary usage and stop, candidate=%s',
  (candidate) => {
    const fixture = seriesEvidenceFixture(candidate),
      input = fixture.refresh();
    const before = readFileSync(fixture.participants[0]!.transcript);
    const summary = normalizeH01SeriesEvidence(input);
    expect(summary).toMatchObject({
      outcome: 'accepted',
      stopped: true,
      blocking: [],
      partialScope: true,
      qualification: false,
      accounting: {
        reservedManagedStarts: 2,
        observedResponses: 2,
        inputUncached: 160,
        inputCached: 40,
        output: 20,
        unknown: false,
      },
      mapping: { runId: input.runId, opId: 'op' },
      operatorElapsedMs: 1000,
    });
    expect(summary.checks).toEqual(fixture.child.checks);
    expect(summary.evidence.some((ref) => ref.locator === fixture.finalStop.locator)).toBe(true);
    expect(readFileSync(fixture.participants[0]!.transcript)).toEqual(before);
  },
);

it('preserves known primary costs when STOP or final acceptance is unknown', () => {
  for (const failure of ['stop', 'outcome', 'checks', 'accounting'] as const) {
    const f = seriesEvidenceFixture();
    if (failure === 'stop') f.keeper.stopped = false;
    if (failure === 'outcome') f.child.outcome = 'unknown';
    if (failure === 'checks') f.child.checks['root-cause'] = false;
    if (failure === 'accounting') f.accounting.unknown = true;
    const result = normalizeH01SeriesEvidence(f.refresh());
    expect(result.outcome).toBe('unknown');
    expect(result.blocking.length).toBeGreaterThan(0);
    expect(result.accounting.inputUncached).toBe(160);
    expect(result.accounting.reservedManagedStarts).toBe(2);
  }
});

it('keeps known primary subtotals when guard aggregate accounting is null or contains unknown receipts', () => {
  for (const mixed of [false, true]) {
    const f = seriesEvidenceFixture();
    if (mixed) {
      const participant = f.participants[0]!;
      const rows = [
        { type: 'session_meta', payload: { id: participant.session } },
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete' } },
      ].map((row) => canonical(row) + '\n');
      writeFileSync(participant.transcript, rows.join(''));
      participant.through = { locator: participant.transcript + '#L3', hash: digest(rows[2]!) };
      const ref = f.completionRefs[0]!;
      const completion = object(h01ReadJson(ref));
      completion.participant = participant;
      const bytes = canonical(completion) + '\n';
      writeFileSync(ref.locator, bytes);
      ref.hash = digest(bytes);
      f.accounting.receipts = f.participants.flatMap((value) => readComparisonUsage(value));
    }
    Object.assign(f.accounting, {
      reservedManagedStarts: null,
      observedResponses: null,
      inputUncached: null,
      inputCached: null,
      output: null,
      unknown: true,
    });
    const summary = normalizeH01SeriesEvidence(f.refresh());
    expect(summary).toMatchObject({
      outcome: 'unknown',
      accounting: {
        unknown: true,
        reservedManagedStarts: null,
        observedResponses: null,
        inputUncached: null,
        inputCached: null,
        output: null,
      },
      knownSubtotal: {
        observedResponses: mixed ? 1 : 2,
        inputUncached: mixed ? 80 : 160,
        inputCached: mixed ? 20 : 40,
        output: mixed ? 10 : 20,
      },
    });
    expect(summary.blocking).toContain('accounting-unknown');
  }
});

it('retains verified subtotals after a late malformed child check or primary STOP failure', () => {
  for (const failure of ['checks', 'stop'] as const) {
    const f = seriesEvidenceFixture();
    if (failure === 'checks') delete f.child.checks['root-cause'];
    else writeFileSync(f.finalStop.locator, 'private damaged STOP receipt');
    const summary = normalizeH01SeriesEvidence(f.refresh());
    expect(summary).toMatchObject({
      outcome: 'unknown',
      knownSubtotal: { observedResponses: 2, inputUncached: 160, inputCached: 40, output: 20 },
    });
    expect(summary.blocking).toContain('invalid-primary-evidence');
  }
});

it('retains verified actors when an unsealed actor has a pending tail or unreadable usage', () => {
  for (const partial of [true, false]) {
    const f = seriesEvidenceFixture();
    const pending = f.participants[1]!;
    delete pending.through;
    writeFileSync(
      pending.transcript,
      partial
        ? readFileSync(pending.transcript, 'utf8') + '{"partial":'
        : '{"invalid-complete-json":\n',
    );
    if (partial) {
      const ref = f.completionRefs[1]!,
        value = object(h01ReadJson(ref));
      value.participant = pending;
      const bytes = canonical(value) + '\n';
      writeFileSync(ref.locator, bytes);
      ref.hash = digest(bytes);
    }
    Object.assign(f.accounting, {
      reservedManagedStarts: null,
      observedResponses: null,
      inputUncached: null,
      inputCached: null,
      output: null,
      unknown: true,
    });
    const result = normalizeH01SeriesEvidence(f.refresh());
    expect(result.outcome).toBe('unknown');
    expect(result.knownSubtotal).toMatchObject({
      observedResponses: partial ? 2 : 1,
      inputUncached: partial ? 160 : 80,
      output: partial ? 20 : 10,
    });
    expect(result.blocking).toContain('usage-unsealed');
  }
});

it('refuses duplicate participants and unsupported primary council/checker answers', () => {
  for (const failure of [
    'duplicate',
    'answer-thread',
    'answer-status',
    'answer-text',
    'checker-kind',
  ] as const) {
    const f = seriesEvidenceFixture();
    if (failure === 'duplicate')
      f.accounting.participants.push(structuredClone(f.participants[0]!));
    else if (failure === 'checker-kind')
      f.child.evidence = [h01Record(root, 'checker', { kind: 'unrelated-proof' })];
    else {
      const proof = object(h01ReadJson(f.finalStop));
      const refs = proof.evidence as InputRef[];
      const answerIndex = refs.findIndex((ref) => ref.locator.includes('/answer-'));
      const answer = object(h01ReadJson(refs[answerIndex]!));
      if (failure === 'answer-thread') answer.thread = 'unrelated-session';
      if (failure === 'answer-status') answer.status = 'failed';
      if (failure === 'answer-text') answer.text = null;
      refs[answerIndex] = h01Record(root, 'answer', answer);
      f.child.stop = pin('changed-final-stop', proof);
    }
    const result = normalizeH01SeriesEvidence(f.refresh());
    expect(result.outcome).toBe('unknown');
    expect(result.knownSubtotal.inputUncached).toBe(160);
  }
});

it('preserves an observed failed attempt and rejects missing completion, unsealed usage and contradictory clocks', () => {
  for (const failure of [
    'failed',
    'completion',
    'unsealed',
    'timing',
    'deadline',
    'acceptance-ref',
    'port',
    'server-signal',
  ] as const) {
    const f = seriesEvidenceFixture(failure === 'port' || failure === 'server-signal');
    if (failure === 'failed') {
      f.child.outcome = f.owned.outcome = f.outer.outcome = 'failed';
      f.keeper.code = 1;
      f.outer.stops[0]!.receipt.code = 1;
    }
    if (failure === 'completion') f.accounting.evidence.pop();
    if (failure === 'unsealed') {
      delete f.participants[0]!.through;
      const ref = f.completionRefs[0]!,
        value = object(h01ReadJson(ref));
      value.participant = f.participants[0];
      const bytes = canonical(value) + '\n';
      writeFileSync(ref.locator, bytes);
      ref.hash = digest(bytes);
    }
    if (failure === 'timing') f.owned.elapsedMs = 101;
    if (failure === 'deadline') f.outer.deadlineNs = f.outer.endedNs;
    if (failure === 'acceptance-ref') Object.assign(f.child, { nativeAcceptance: f.finalStop });
    if (failure === 'port') f.outer.portStops[0]!.closed = false;
    if (failure === 'server-signal')
      Object.assign(f.outer.stops[1]!.receipt, { code: null, signal: 'SIGTERM' });
    const summary = normalizeH01SeriesEvidence(f.refresh());
    expect(summary.outcome).toBe(
      failure === 'failed'
        ? 'failed'
        : ['acceptance-ref', 'server-signal'].includes(failure)
          ? 'accepted'
          : 'unknown',
    );
    expect(summary.knownSubtotal.inputUncached).toBe(160);
  }
});

it('rejects forged report delivery, foreign op/run, primary usage and missing evidence', () => {
  for (const failure of [
    'delivery',
    'run',
    'op',
    'receipt',
    'total',
    'budget',
    'primary',
    'council',
  ] as const) {
    const f = seriesEvidenceFixture();
    if (failure === 'receipt') f.accounting.receipts[0]!.input_uncached = 0;
    if (failure === 'total') f.accounting.inputUncached = 0;
    if (failure === 'budget') f.accounting.reservedManagedStarts = 0;
    if (failure === 'primary')
      writeFileSync(f.participants[0]!.transcript, 'private altered primary bytes\n');
    if (failure === 'council') f.child.stop = recordWithoutCouncil();
    const input = f.refresh();
    if (failure === 'delivery') object(input.operator).outcome = 'accepted-without-primary';
    if (failure === 'run') input.runId = 'H-02:1:baseline';
    if (failure === 'op') input.opId = 'foreign-op';
    const summary = normalizeH01SeriesEvidence(input);
    expect(summary.outcome).toBe('unknown');
    expect(summary.blocking.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain('private altered primary bytes');
  }
  function recordWithoutCouncil() {
    return pin('without-council', {
      kind: 'comparison-h01-stop',
      executionVersion: 2,
      opId: 'op',
      confirmed: true,
      sessions: ['council-primary'],
      remainingProcesses: [],
      evidence: [request.material],
    });
  }
});
async function frameworkProjection(ctx: H01AttemptContext) {
  const cardPath = '.comparison/task.md',
    beforeText = readFileSync(resolve(ctx.roots.workspaceRoot, cardPath), 'utf8');
  if (ctx.variant === 'baseline') {
    const connection = parseConnection(
      JSON.parse(readFileSync(resolve(ctx.roots.workspaceRoot, 'project/workflow.json'), 'utf8')),
    );
    const gates = h01Criteria.checks.map((id) => ({
      id,
      kind: 'check',
      applicable: true,
      reason: id,
    }));
    const completion = {
      criteria: gates.flatMap((gate) => [gate.id, gate.reason]),
      summary: 'framework fixture',
      limitations: ['provider double'],
      evidence: [ctx.material.ref],
    };
    const cards = new FileProjectCards(
      ctx.roots.workspaceRoot,
      connection,
      resolve(root, 'projection-journal'),
    );
    const plan = await cards.prepare(
      await cards.read(cardPath),
      'completed',
      'fixture-finish',
      completion,
    );
    const projected = { plan, result: await cards.apply(plan) };
    const snapshot = pin('framework-snapshot', {
      state: {
        checkpoint: {
          local_run: { projection: projected },
          workflow: { execution: { gates, result: completion } },
        },
      },
    });
    return pin('framework-projection', {
      kind: 'h01-legacy-engine-result',
      opId: ctx.opId,
      requestHash: ctx.requestHash,
      snapshot,
      database: pin('fixture-database', { provider: 'double' }),
      projection: projected,
    });
  }
  const artifact = (value: unknown) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const sha256 = digest(bytes);
    writeFileSync(resolve(ctx.roots.artifactRoot, sha256), bytes, {
      mode: 0o600,
    });
    return { sha256, bytes: bytes.length };
  };
  const input = {
    schemaVersion: 1 as const,
    admission: {
      schemaVersion: 1 as const,
      preparation: {
        schemaVersion: 1 as const,
        project: {
          schemaVersion: 1 as const,
          projectId: 'h01-' + digest(ctx.opId).slice(0, 16),
          workspaceId: ctx.opId,
          rules: ['.comparison/RULES.md'],
          cardRoot: '.comparison',
          roles: [{ id: 'reviewer', profile: '.comparison/reviewer.md' }],
          checks: ['syntax', 'validate'],
        },
        taskId: ctx.identity.taskId,
        hostId: ctx.opId,
        owner: ctx.identity.owner,
        generation: ctx.identity.generation,
        revision: 1,
        card: cardPath,
      },
      plan: { path: '.comparison/plan.json', sha256: 'a'.repeat(64) },
      acceptance: { sha256: 'a'.repeat(64), bytes: 0 },
    },
    executor: { path: '.comparison/executor.md', sha256: ctx.executor.hash },
    baseline: 'syntax',
  };
  const before = { content: artifact(Buffer.from(beforeText)), mode: 0o600 };
  const snapshot = artifact({
    input,
    source: { root: ctx.roots.workspaceRoot },
    plan: {
      criterion: (h01ReadJson(ctx.criteria.ref) as { task: string }).task,
    },
    tree: { files: [{ path: cardPath, version: before }] },
  });
  const result = artifact({
    kind: 'local-task-result',
    complete: true,
    input,
    snapshot,
  });
  const afterText =
    beforeText +
    `\n<!-- agent-workflow:${localTaskKey(input)} -->\nРезультат: DONE\nКритерий: ${(h01ReadJson(ctx.criteria.ref) as { task: string }).task}\nДоказательство: ${result.sha256}\n<!-- /agent-workflow -->\n`;
  const projection = artifact({
    kind: 'task-card-projection',
    input,
    before,
    after: { content: artifact(Buffer.from(afterText)), mode: 0o600 },
    result,
  });
  writeFileSync(resolve(ctx.roots.workspaceRoot, cardPath), afterText);
  return {
    locator: resolve(ctx.roots.artifactRoot, projection.sha256),
    hash: projection.sha256,
  };
}
function stopped(label: string) {
  return pin(label, {
    kind: 'comparison-h01-stop',
    executionVersion: 2,
    opId: 'op',
    confirmed: true,
    sessions: ['native'],
    remainingProcesses: [],
    evidence: [request.material],
  });
}
function makeControl() {
  request.authorization.requestHash = h01RequestHash(request);
  requestRef = pin('request', request);
  const profile = parseH01Profile(request.profile),
    now = process.hrtime.bigint();
  const descriptor: H01GuardDescriptor = {
    kind: 'comparison-h01-guard',
    executionVersion: 2,
    opId: 'op',
    requestHash: h01RequestHash(request),
    request: requestRef,
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
    startedNs: String(now),
    deadlineNs: String(now + 60000000000n),
    workDeadlineNs: String(now + 50000000000n),
  };
  control = pin('descriptor', descriptor);
}
function setupChild() {
  for (const path of [
    request.roots.workspaceRoot,
    request.roots.stateRoot,
    request.roots.evidenceRoot,
    request.roots.artifactRoot,
    request.roots.hostRoot,
  ])
    mkdirSync(path);
  writeFileSync(
    resolve(request.roots.evidenceRoot, 'attempt-start.json'),
    canonical({
      start: {
        wall_ms: Date.now(),
        monotonic_ms: Number(process.hrtime.bigint()) / 1e6,
        clock_id: 'h01-local-host-hrtime',
      },
    }),
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  root = realpathSync(mkdtempSync(resolve(tmpdir(), 'h01-common-')));
  mkdirSync(resolve(root, 'work'));
  const binary = pin('binary', 'inert'),
    rules = pin('rules', 'inert rules');
  const code = resolve(import.meta.dirname, 'comparisonH01.ts');
  const projectPath = resolve(repo, 'project/workflow.json');
  const project = parseConnection(JSON.parse(readFileSync(projectPath, 'utf8')));
  const runtimeFiles = [
    code,
    projectPath,
    resolve(repo, 'roles/README.md'),
    resolve(repo, 'roles/system-analyst.md'),
    ...project.procedures.map((p) => resolve(repo, p.locator)),
  ].map((locator) => ({ locator, hash: digest(readFileSync(locator)) }));
  request = {
    kind: 'comparison-h01-execution',
    executionVersion: 2,
    opId: 'op',
    variant: 'baseline',
    material: pin('material', material.cases[0]),
    criteria: pin('criteria', h01Criteria),
    profile: pin('profile', {
      model: 'fixture',
      effort: 'high',
      clientVersion: '1',
      binary,
      rules,
      executor: rules,
      reviewer: rules,
    }),
    runtime: pin('runtime', {
      engine: 'legacy',
      root: repo,
      files: runtimeFiles,
    }),
    bootstrap: pin('bootstrap', {
      engine: 'legacy',
      runtimeRoot: resolve(root, 'work/state/legacy-runtime'),
      modulesRoot: repo,
      overlay: pin('overlay-plan', { pinned: 'plan' }),
    }),
    roots: {
      workspaceRoot: resolve(root, 'work/case'),
      stateRoot: resolve(root, 'work/state'),
      evidenceRoot: resolve(root, 'evidence'),
      artifactRoot: resolve(root, 'artifacts'),
      hostRoot: resolve(root, 'host'),
    },
    identity: { taskId: 'task', owner: 'owner', generation: 1 },
    budget: {
      maxManagedStarts: 6,
      maxElapsedMs: 60000,
      maxInputUncached: 10000,
      maxOutput: 1000,
      reserveMs: 10000,
    },
    authorization: {
      root,
      transcript: resolve(root, 'transcript'),
      anchor: {
        thread_id: 'primary',
        turn_id: 'turn',
        workspace: root,
        host_id: 'local',
      },
      source: {
        locator: resolve(root, 'transcript') + '#L1',
        hash: 'a'.repeat(64),
      },
      requestHash: '',
    },
  };
  account = {
    participants: [],
    receipts: [],
    reservedManagedStarts: 2,
    observedResponses: 2,
    inputUncached: 20,
    inputCached: 0,
    output: 10,
    unknown: false,
    evidence: [],
  };
  checkerStop = {
    stopped: true,
    code: 0,
    signal: null,
    deadlineReached: false,
    killed: false,
  };
  backendOutcome = 'completed';
  provider.authorize.mockImplementation(async () => pin('authorization', { primary: 'mock only' }));
  provider.accounting.mockImplementation(() => account);
  provider.capture.mockResolvedValue({
    complete: true,
    inputs: [{ locator: 'tests/comparisonH01.ts', hash: digest(readFileSync(code)) }],
  });
  provider.exec.mockImplementation(async (_binary: string, argv: string[]) => ({
    stdout: argv[0] === '--version' ? 'client 1\n' : '',
    stderr: '',
  }));
  provider.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    Object.assign(child, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 999,
    });
    return child;
  });
  provider.checker.mockImplementation(async () => checkerStop);
  provider.backend.mockImplementation(async (ctx: H01AttemptContext) => {
    writeFileSync(
      resolve(ctx.roots.workspaceRoot, 'range.mjs'),
      'export const contains = (value, min, max) => value >= min && value <= max;\n',
    );
    const projection =
      backendOutcome === 'completed'
        ? await frameworkProjection(ctx)
        : pin('no-projection', { kind: 'h01-projection-unknown' });
    return {
      outcome: backendOutcome,
      evidence: [request.material],
      stop: stopped('backend-stop'),
      nativeAcceptance: null,
      projection,
    };
  });
  provider.council.mockImplementation(async () => ({
    outcome: 'completed',
    evidence: [request.criteria],
    stop: stopped('council-stop'),
    nativeAcceptance: null,
    text: canonical({
      outcome: 'accepted',
      checks: Object.fromEntries(h01Criteria.checks.map((check) => [check, true])),
      limitations: ['provider double; not actual qualification'],
    }),
  }));
  provider.prepare.mockImplementation(() => ({
    overlay: request.material,
    files: [],
  }));
  provider.connection.mockResolvedValue({ close: provider.connectionClose });
  provider.nativeConnection.mockResolvedValue({ close: provider.nativeClose });
  makeControl();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

function configureH02Child(candidate = false) {
  request.kind = 'comparison-h02-execution';
  request.material = pin('h02-material', material.cases[1]);
  request.criteria = pin('h02-criteria', criteria.scenarios[1]);
  if (candidate) {
    request.variant = 'candidate';
    const runtime = object(h01ReadJson(request.runtime));
    request.runtime = pin('h02-runtime', { ...runtime, engine: 'temporal' });
    request.bootstrap = pin('h02-bootstrap', {
      engine: 'temporal',
      address: '127.0.0.1:7233',
      namespace: 'default',
      taskQueue: 'h02',
      workflowsPath: resolve(repo, 'src/workflows/localTask.ts'),
      issuer: { sessionsRoot: root, workspaceRoot: root, threadId: 'primary', owner: 'owner' },
    });
  }
  makeControl();
  control = pin('h02-control', { ...object(h01ReadJson(control)), kind: 'comparison-h02-guard' });
}

function configureH03Child(candidate = false) {
  configureH02Child(candidate);
  request.kind = 'comparison-h03-execution';
  request.material = pin('h03-material', material.cases[2]);
  request.criteria = pin('h03-criteria', criteria.scenarios[2]);
  makeControl();
  control = pin('h03-control', { ...object(h01ReadJson(control)), kind: 'comparison-h03-guard' });
}

function configureH04Child(candidate = false) {
  configureH02Child(candidate);
  request.kind = 'comparison-h04-execution';
  request.material = pin('h04-material', material.cases[3]);
  request.criteria = pin('h04-criteria', criteria.scenarios[3]);
  makeControl();
  control = pin('h04-control', { ...object(h01ReadJson(control)), kind: 'comparison-h04-guard' });
}

it.each([false, true])(
  'dispatches H04 through the shared owned child and exact immutable metadata (candidate=%s)',
  async (candidate) => {
    configureH04Child(candidate);
    expect(() => planH01(request, 'H-03')).toThrow('h01-version');
    expect(planH01(request, 'H-04').task.id).toBe('H-04');
    setupChild();
    provider.backend.mockImplementationOnce(async (ctx: H01AttemptContext) => {
      expect(readFileSync(resolve(ctx.roots.workspaceRoot, '.h04/task.md'), 'utf8')).toBe(
        material.cases[3]!.instructions + '\n',
      );
      expect(ctx.criteria.value.id).toBe('H-04');
      for (const id of ['bootstrap', 'task', 'evidence', 'implementation', 'boundary-review'])
        expect(existsSync(resolve(ctx.roots.workspaceRoot, `procedures/${id}.md`))).toBe(true);
      const report = pin('h04-case', {
        kind: 'comparison-h04-case',
        outcome: 'accepted',
        checks: Object.fromEntries(criteria.scenarios[3]!.checks.map((check) => [check, true])),
      });
      return {
        outcome: 'completed',
        evidence: [report],
        nativeAcceptance: report,
        projection: pin('h04-projection', {
          kind: 'comparison-h04-native-projection',
          scenario: 'H-04',
          opId: request.opId,
          engine: candidate ? 'temporal' : 'legacy',
          caseReport: report,
        }),
        stop: pin('h04-stop', {
          kind: 'comparison-h04-stop',
          executionVersion: 2,
          opId: request.opId,
          confirmed: true,
          sessions: ['native'],
          remainingProcesses: [],
          evidence: [report],
        }),
      };
    });
    expect(await executeH01Child(requestRef, control, 'H-04')).toMatchObject({
      kind: 'comparison-h04-execution-report',
      outcome: 'accepted',
    });
    expect(provider.backend).toHaveBeenCalledTimes(1);
    expect(provider.council).not.toHaveBeenCalled();
    expect(provider.prepare).not.toHaveBeenCalled();
  },
);

it('preserves H04 UNKNOWN projection, primary evidence and known costs without extra native calls', async () => {
  configureH04Child();
  setupChild();
  const primary = pin('h04-unsettled-operation', { status: 'pending', result: null });
  const projection = pin('h04-unknown-projection', {
    kind: 'comparison-h04-native-projection',
    scenario: 'H-04',
    opId: request.opId,
    engine: 'legacy',
    caseReport: primary,
  });
  provider.backend.mockResolvedValueOnce({
    outcome: 'unknown',
    evidence: [primary],
    nativeAcceptance: null,
    projection,
    stop: pin('h04-unknown-stop', {
      kind: 'comparison-h04-stop',
      executionVersion: 2,
      opId: request.opId,
      confirmed: true,
      sessions: ['native'],
      remainingProcesses: [],
      evidence: [primary],
    }),
  });
  const result = await executeH01Child(requestRef, control, 'H-04');
  expect(result).toMatchObject({
    outcome: 'unknown',
    nativeAcceptance: null,
    projection,
    accounting: { inputUncached: 20, output: 10 },
  });
  expect(result.evidence).toContainEqual(primary);
  expect(provider.backend).toHaveBeenCalledTimes(1);
  expect(provider.council).not.toHaveBeenCalled();
  expect(provider.prepare).not.toHaveBeenCalled();
});

it('binds an H04 primary checker receipt to the exact operation and material', async () => {
  configureH04Child();
  setupChild();
  provider.backend.mockImplementationOnce(async (ctx: H01AttemptContext) => {
    const checked = await checkNativeCase(ctx, 'h04-primary-check');
    expect(checked.passed).toBe(true);
    expect(h01ReadJson(checked.evidence)).toMatchObject({
      kind: 'comparison-h04-check',
      opId: ctx.opId,
      requestHash: ctx.requestHash,
      material: ctx.material.ref,
      cwd: ctx.roots.workspaceRoot,
    });
    return {
      outcome: 'unknown',
      evidence: [checked.evidence],
      nativeAcceptance: null,
      projection: checked.evidence,
      stop: checked.evidence,
    };
  });
  expect((await executeH01Child(requestRef, control, 'H-04')).outcome).toBe('unknown');
});

it('binds H04 native CLI/keeper/guard routing while planning starts no actor', async () => {
  configureH04Child();
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h04NativeMain(['--plan', requestRef.locator]);
  expect(object(JSON.parse(String(output.mock.calls.at(-1)![0])) as unknown).kind).toBe(
    'comparison-h04-plan',
  );
  expect(existsSync(request.roots.workspaceRoot)).toBe(false);
  expect(provider.backend).not.toHaveBeenCalled();
  provider.keeper.mockResolvedValueOnce({
    outcome: 'completed',
    stop: pin('h04-keeper-stop', { stopped: true }),
    evidence: [],
    report: pin('h04-owned-child', { outcome: 'accepted', accounting: account }),
  });
  expect((await runH01(request, 'H-04')).kind).toBe('comparison-h04-owned-report');
  const input = provider.keeper.mock.calls[0]![0] as H01KeeperInput;
  expect(input.entrypoint.locator).toBe(resolve(repo, 'tests/comparisonH04Native.ts'));
  expect(object(h01ReadJson(input.controlRef)).kind).toBe('comparison-h04-guard');
});

it('catches only a selected H04 native CLI failure without executing an adapter', async () => {
  const previous = process.argv,
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [previous[0]!];
    await import('./comparisonH04Native.js');
    vi.resetModules();
    process.argv = [previous[0]!, resolve(repo, 'tests/comparisonH04Native.ts'), '--invalid'];
    await import('./comparisonH04Native.js');
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith('h04-native-failed\n'));
    expect(provider.backend).not.toHaveBeenCalled();
  } finally {
    process.argv = previous;
  }
});

function configureH05Child(candidate = false) {
  configureH02Child(candidate);
  request.kind = 'comparison-h05-execution';
  request.identity.generation = 2;
  request.material = pin('h05-material', material.cases[4]);
  request.criteria = pin('h05-criteria', criteria.scenarios[4]);
  makeControl();
  control = pin('h05-control', { ...object(h01ReadJson(control)), kind: 'comparison-h05-guard' });
}

it.each([false, true])(
  'dispatches H05 through the shared owned child and exact immutable metadata (candidate=%s)',
  async (candidate) => {
    configureH05Child(candidate);
    expect(() => planH01(request, 'H-03')).toThrow('h01-version');
    expect(planH01(request, 'H-05').task.id).toBe('H-05');
    setupChild();
    provider.backend.mockImplementationOnce(async (ctx: H01AttemptContext) => {
      expect(readFileSync(resolve(ctx.roots.workspaceRoot, '.h05/task.md'), 'utf8')).toBe(
        material.cases[4]!.instructions + '\n',
      );
      expect(ctx.criteria.value.id).toBe('H-05');
      for (const id of ['bootstrap', 'task', 'evidence', 'data-roles', 'boundary-review'])
        expect(existsSync(resolve(ctx.roots.workspaceRoot, `procedures/${id}.md`))).toBe(true);
      const report = pin('h05-case', {
        kind: 'comparison-h05-case',
        outcome: 'accepted',
        checks: Object.fromEntries(criteria.scenarios[4]!.checks.map((check) => [check, true])),
      });
      return {
        outcome: 'completed',
        evidence: [report],
        nativeAcceptance: report,
        projection: pin('h05-projection', {
          kind: 'comparison-h05-native-projection',
          scenario: 'H-05',
          opId: request.opId,
          engine: candidate ? 'temporal' : 'legacy',
          caseReport: report,
        }),
        stop: pin('h05-stop', {
          kind: 'comparison-h05-stop',
          executionVersion: 2,
          opId: request.opId,
          confirmed: true,
          sessions: ['native'],
          remainingProcesses: [],
          evidence: [report],
        }),
      };
    });
    expect(await executeH01Child(requestRef, control, 'H-05')).toMatchObject({
      kind: 'comparison-h05-execution-report',
      outcome: 'accepted',
    });
    expect(provider.backend).toHaveBeenCalledTimes(1);
    expect(provider.council).not.toHaveBeenCalled();
    expect(provider.prepare).not.toHaveBeenCalled();
  },
);

it('preserves H05 UNKNOWN projection, primary evidence and known costs without extra native calls', async () => {
  configureH05Child();
  setupChild();
  const primary = pin('h05-unsettled-operation', { status: 'pending', result: null });
  const projection = pin('h05-unknown-projection', {
    kind: 'comparison-h05-native-projection',
    scenario: 'H-05',
    opId: request.opId,
    engine: 'legacy',
    caseReport: primary,
  });
  provider.backend.mockResolvedValueOnce({
    outcome: 'unknown',
    evidence: [primary],
    nativeAcceptance: null,
    projection,
    stop: pin('h05-unknown-stop', {
      kind: 'comparison-h05-stop',
      executionVersion: 2,
      opId: request.opId,
      confirmed: true,
      sessions: ['native'],
      remainingProcesses: [],
      evidence: [primary],
    }),
  });
  const result = await executeH01Child(requestRef, control, 'H-05');
  expect(result).toMatchObject({
    outcome: 'unknown',
    nativeAcceptance: null,
    projection,
    accounting: { inputUncached: 20, output: 10 },
  });
  expect(result.evidence).toContainEqual(primary);
  expect(provider.backend).toHaveBeenCalledTimes(1);
  expect(provider.council).not.toHaveBeenCalled();
  expect(provider.prepare).not.toHaveBeenCalled();
});

it('binds an H05 primary checker receipt to the exact operation and material', async () => {
  configureH05Child();
  setupChild();
  provider.backend.mockImplementationOnce(async (ctx: H01AttemptContext) => {
    const checked = await checkNativeCase(ctx, 'h05-primary-check');
    expect(checked.passed).toBe(true);
    expect(h01ReadJson(checked.evidence)).toMatchObject({
      kind: 'comparison-h05-check',
      opId: ctx.opId,
      requestHash: ctx.requestHash,
      material: ctx.material.ref,
      cwd: ctx.roots.workspaceRoot,
    });
    return {
      outcome: 'unknown',
      evidence: [checked.evidence],
      nativeAcceptance: null,
      projection: checked.evidence,
      stop: checked.evidence,
    };
  });
  expect((await executeH01Child(requestRef, control, 'H-05')).outcome).toBe('unknown');
});

it('binds H05 native CLI/keeper/guard routing while planning starts no actor', async () => {
  configureH05Child();
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h05NativeMain(['--plan', requestRef.locator]);
  expect(object(JSON.parse(String(output.mock.calls.at(-1)![0])) as unknown).kind).toBe(
    'comparison-h05-plan',
  );
  expect(existsSync(request.roots.workspaceRoot)).toBe(false);
  expect(provider.backend).not.toHaveBeenCalled();
  provider.keeper.mockResolvedValueOnce({
    outcome: 'completed',
    stop: pin('h05-keeper-stop', { stopped: true }),
    evidence: [],
    report: pin('h05-owned-child', { outcome: 'accepted', accounting: account }),
  });
  expect((await runH01(request, 'H-05')).kind).toBe('comparison-h05-owned-report');
  const input = provider.keeper.mock.calls[0]![0] as H01KeeperInput;
  expect(input.entrypoint.locator).toBe(resolve(repo, 'tests/comparisonH05Native.ts'));
  expect(object(h01ReadJson(input.controlRef)).kind).toBe('comparison-h05-guard');
});

it('catches only a selected H05 native CLI failure without executing an adapter', async () => {
  const previous = process.argv,
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [previous[0]!];
    await import('./comparisonH05Native.js');
    vi.resetModules();
    process.argv = [previous[0]!, resolve(repo, 'tests/comparisonH05Native.ts'), '--invalid'];
    await import('./comparisonH05Native.js');
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith('h05-native-failed\n'));
    expect(provider.backend).not.toHaveBeenCalled();
  } finally {
    process.argv = previous;
  }
});

it.each([false, true])(
  'uses the same H03 owned child without allowing H02 requests (candidate=%s)',
  async (candidate) => {
    configureH03Child(candidate);
    expect(() => planH01(request, 'H-02')).toThrow('h01-version');
    expect(planH01(request, 'H-03').task.id).toBe('H-03');
    setupChild();
    provider.backend.mockImplementationOnce(async (ctx: H01AttemptContext) => {
      expect(readFileSync(resolve(ctx.roots.workspaceRoot, '.h03/task.md'), 'utf8')).toContain(
        'F-01',
      );
      expect(ctx.criteria.value.id).toBe('H-03');
      const checks = Object.fromEntries(criteria.scenarios[2]!.checks.map((name) => [name, true]));
      const report = pin('h03-case', { outcome: 'accepted', checks });
      return {
        outcome: 'completed',
        evidence: [report],
        nativeAcceptance: report,
        projection: pin('h03-projection', {
          kind: 'comparison-h03-native-projection',
          scenario: 'H-03',
          opId: request.opId,
          engine: candidate ? 'temporal' : 'legacy',
          caseReport: report,
        }),
        stop: pin('h03-native-stop', {
          kind: 'comparison-h03-stop',
          executionVersion: 2,
          opId: request.opId,
          confirmed: true,
          sessions: ['native'],
          remainingProcesses: [],
          evidence: [report],
        }),
      };
    });
    expect((await executeH01Child(requestRef, control, 'H-03')).outcome).toBe('accepted');
    expect(provider.council).not.toHaveBeenCalled();
    expect(provider.prepare).not.toHaveBeenCalled();
  },
);

it.each([
  { code: 1, signal: null, killed: false, expected: true },
  { code: null, signal: 'SIGKILL', killed: false, expected: false },
  { code: 1, signal: 'SIGSEGV', killed: false, expected: false },
  { code: 1, signal: null, killed: true, expected: false },
])('distinguishes an initial H03 FAIL from checker interruption: %j', async (value) => {
  configureH03Child();
  setupChild();
  provider.backend.mockImplementationOnce(async (ctx: H01AttemptContext) => {
    checkerStop = { ...checkerStop, ...value };
    const checked = await checkNativeCase(ctx, 'h03-primary-failure');
    expect(checked.failed).toBe(value.expected);
    expect(object(h01ReadJson(checked.evidence))).toMatchObject({
      kind: 'comparison-h03-check',
      opId: ctx.opId,
      requestHash: ctx.requestHash,
      material: ctx.material.ref,
      cwd: ctx.roots.workspaceRoot,
    });
    return {
      outcome: 'unknown',
      evidence: [checked.evidence],
      nativeAcceptance: null,
      stop: checked.evidence,
      projection: checked.evidence,
    };
  });
  expect((await executeH01Child(requestRef, control, 'H-03')).outcome).toBe('unknown');
});

it('keeps H03 keeper/CLI and its own guard domain while a plan starts no native actor', async () => {
  configureH03Child();
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h03NativeMain(['--plan', requestRef.locator]);
  expect(object(JSON.parse(String(out.mock.calls.at(-1)![0])) as unknown).kind).toBe(
    'comparison-h03-plan',
  );
  provider.keeper.mockImplementationOnce(async () => ({
    outcome: 'completed',
    stop: pin('h03-keeper-stop', { stopped: true }),
    evidence: [],
    report: pin('h03-owned-child', { outcome: 'accepted', accounting: account }),
  }));
  const result = await runH01(request, 'H-03');
  expect(result.kind).toBe('comparison-h03-owned-report');
  const input = provider.keeper.mock.calls[0]![0] as H01KeeperInput;
  expect(input.entrypoint.locator).toBe(resolve(repo, 'tests/comparisonH03Native.ts'));
  expect(object(h01ReadJson(input.controlRef)).kind).toBe('comparison-h03-guard');
});

it('catches only the selected H03 native CLI and rejects unsupported checker labels', async () => {
  const previous = process.argv;
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [previous[0]!];
    await import('./comparisonH03Native.js');
    vi.resetModules();
    process.argv = [previous[0]!, resolve(repo, 'tests/comparisonH03Native.ts'), '--invalid'];
    await import('./comparisonH03Native.js');
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith('h03-native-failed\n'));
    await expect(checkNativeCase({} as H01AttemptContext, '../outside')).rejects.toThrow(
      'comparison-check-label',
    );
  } finally {
    process.argv = previous;
  }
});

it.each([false, true])(
  'executes H02 with the same owned child lifecycle (candidate=%s)',
  async (candidate) => {
    configureH02Child(candidate);
    expect(() => planH01(request)).toThrow('h01-version');
    expect(planH01(request, 'H-02')).toMatchObject({
      kind: 'comparison-h02-plan',
      task: { id: 'H-02' },
    });
    setupChild();
    provider.backend.mockImplementationOnce(async (ctx: H01AttemptContext) => {
      expect(readFileSync(resolve(ctx.roots.workspaceRoot, '.h02/task.md'), 'utf8')).toContain(
        'pricing',
      );
      expect(ctx.criteria.value.id).toBe('H-02');
      writeFileSync(resolve(ctx.roots.workspaceRoot, 'pricing.json'), '{"rate":7}\n');
      const caseReport = pin('h02-case', {
        outcome: 'accepted',
        checks: Object.fromEntries(criteria.scenarios[1]!.checks.map((check) => [check, true])),
      });
      return {
        outcome: 'completed',
        evidence: [caseReport],
        nativeAcceptance: caseReport,
        projection: pin('h02-projection', {
          kind: 'comparison-h02-native-projection',
          scenario: 'H-02',
          opId: request.opId,
          engine: candidate ? 'temporal' : 'legacy',
          caseReport,
        }),
        stop: pin('h02-stop', {
          kind: 'comparison-h02-stop',
          executionVersion: 2,
          opId: request.opId,
          confirmed: true,
          sessions: ['native'],
          remainingProcesses: [],
          evidence: [caseReport],
        }),
      };
    });
    const result = await executeH01Child(requestRef, control, 'H-02');
    expect(result).toMatchObject({ kind: 'comparison-h02-execution-report', outcome: 'accepted' });
    expect(provider.council).not.toHaveBeenCalled();
    expect(provider.prepare).not.toHaveBeenCalled();
    expect(existsSync(resolve(request.roots.evidenceRoot, 'h02-child-report.json'))).toBe(true);
  },
);

it.each([
  'unknown',
  'failed',
  'case-report-failed',
  'false-check',
  'wrong-projection',
  'invalid-checks',
  'missing-acceptance',
  'unpinned-procedure',
])('preserves H02 %s as unaccepted without extra native calls', async (failure) => {
  configureH02Child();
  if (failure === 'unpinned-procedure') {
    const runtime = object(h01ReadJson(request.runtime));
    request.runtime = pin('h02-bad-procedure-runtime', {
      ...runtime,
      files: (runtime.files as InputRef[]).filter(
        (ref) => !ref.locator.endsWith('/procedures/council.md'),
      ),
    });
    makeControl();
    control = pin('h02-bad-control', {
      ...object(h01ReadJson(control)),
      kind: 'comparison-h02-guard',
    });
  }
  setupChild();
  provider.backend.mockImplementationOnce(async (ctx: H01AttemptContext) => {
    writeFileSync(resolve(ctx.roots.workspaceRoot, 'pricing.json'), '{"rate":7}\n');
    const checks = Object.fromEntries(
      criteria.scenarios[1]!.checks.map((check) => [check, failure !== 'false-check']),
    );
    if (failure === 'invalid-checks') Object.assign(checks, { unexpected: true });
    const caseReport = pin('h02-failed-case', {
      outcome: ['failed', 'case-report-failed'].includes(failure) ? 'failed' : 'accepted',
      checks,
    });
    return {
      outcome: failure === 'unknown' ? 'unknown' : failure === 'failed' ? 'failed' : 'completed',
      evidence: [caseReport],
      nativeAcceptance: failure === 'missing-acceptance' ? null : caseReport,
      projection: pin('h02-failed-projection', {
        kind: failure === 'wrong-projection' ? 'wrong' : 'comparison-h02-native-projection',
        scenario: 'H-02',
        opId: request.opId,
        engine: 'legacy',
        caseReport,
      }),
      stop: pin('h02-failed-stop', {
        kind: 'comparison-h02-stop',
        executionVersion: 2,
        opId: request.opId,
        confirmed: true,
        sessions: ['native'],
        remainingProcesses: [],
        evidence: [caseReport],
      }),
    };
  });
  const result = await executeH01Child(requestRef, control, 'H-02');
  expect(result.outcome).toBe(
    ['failed', 'case-report-failed', 'false-check'].includes(failure) ? 'failed' : 'unknown',
  );
  expect(provider.council).not.toHaveBeenCalled();
});

it('routes the H02 native CLI only to its bound scenario without creating execution roots for a plan', async () => {
  configureH02Child();
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h02NativeMain(['--plan', requestRef.locator]);
  expect(object(JSON.parse(String(output.mock.calls.at(-1)![0])) as unknown).kind).toBe(
    'comparison-h02-plan',
  );
  expect(existsSync(request.roots.workspaceRoot)).toBe(false);
  expect(provider.backend).not.toHaveBeenCalled();
});

it('catches an explicitly selected H02 native entrypoint without granting execution', async () => {
  const previous = process.argv;
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [previous[0]!];
    await import('./comparisonH02Native.js');
    vi.resetModules();
    process.argv = [
      previous[0]!,
      resolve(import.meta.dirname, 'comparisonH02Native.ts'),
      '--invalid',
    ];
    await import('./comparisonH02Native.js');
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith('h02-native-failed\n'));
    expect(provider.backend).not.toHaveBeenCalled();
  } finally {
    process.argv = previous;
  }
});

it('owns H02 request, descriptor and keeper output without accepting an H01 request', async () => {
  configureH02Child();
  provider.keeper.mockImplementationOnce(async (_input) => ({
    outcome: 'completed',
    stop: pin('h02-keeper-stop', { stopped: true }),
    evidence: [],
    report: pin('h02-keeper-report', {
      kind: 'comparison-h02-execution-report',
      outcome: 'accepted',
      accounting: account,
    }),
  }));
  const result = await runH01(request, 'H-02');
  expect(result).toMatchObject({ kind: 'comparison-h02-owned-report', outcome: 'accepted' });
  expect(provider.keeper.mock.calls[0]![2]).toBe('H-02');
  const keeperInput = provider.keeper.mock.calls[0]![0] as H01KeeperInput;
  const ownedDescriptor = object(h01ReadJson(keeperInput.controlRef));
  expect(ownedDescriptor.kind).toBe('comparison-h02-guard');
});

it('aborts a running checker through its existing owner and preserves both raw output files', async () => {
  setupChild();
  provider.spawn.mockImplementationOnce(
    (_binary, _args, options: { stdio: [string, number, number] }) => {
      writeFileSync(options.stdio[1], 'primary stdout\n');
      writeFileSync(options.stdio[2], 'primary stderr\n');
      return {};
    },
  );
  provider.checker.mockImplementationOnce(async () => {
    const stop = process.listeners('SIGTERM').at(-1)!;
    stop('SIGTERM');
    return checkerStop;
  });
  const result = await executeH01Child(requestRef, control);
  expect(result.outcome).toBe('unknown');
  expect(provider.stop).toHaveBeenCalledOnce();
  expect(readFileSync(resolve(request.roots.evidenceRoot, 'checker.stdout'), 'utf8')).toBe(
    'primary stdout\n',
  );
});
it('forwards pinned MCP disable targets to the backend and common council', async () => {
  setupChild();
  const disabledMcpServers = ['disabled-one', 'disabled_two'];
  request.profile = pin('profile-with-mcp-targets', {
    ...parseH01Profile(request.profile),
    disabledMcpServers,
  });
  makeControl();
  const result = await executeH01Child(requestRef, control);
  expect(result.outcome).toBe('accepted');
  expect(provider.backend).toHaveBeenCalledWith(expect.objectContaining({ disabledMcpServers }));
  expect(provider.council).toHaveBeenCalledWith(
    expect.objectContaining({ disabledMcpServers }),
    'council',
    expect.any(String),
  );
});
it('expires the work timer, retains an unusual failure and never retries a native attempt', async () => {
  setupChild();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  provider.backend.mockImplementationOnce(async () => {
    await vi.advanceTimersByTimeAsync(50001);
    throw 'lost-response';
  });
  const result = await executeH01Child(requestRef, control);
  expect(result.outcome).toBe('unknown');
  expect(provider.backend).toHaveBeenCalledOnce();
});
it('does not accept incoherent attempt or outer timing', async () => {
  setupChild();
  vi.spyOn(suiteData, 'comparisonDuration').mockReturnValue(null);
  expect((await executeH01Child(requestRef, control)).outcome).toBe('unknown');
  rmSync(request.roots.evidenceRoot, { recursive: true });
  rmSync(request.roots.workspaceRoot, { recursive: true });
  rmSync(request.roots.stateRoot, { recursive: true });
  rmSync(request.roots.hostRoot, { recursive: true });
  rmSync(request.roots.artifactRoot, { recursive: true });
  provider.keeper.mockImplementationOnce(async () => ({
    outcome: 'completed',
    stop: stopped('outer-stop'),
    report: pin('outer-child', { outcome: 'accepted', accounting: account }),
    evidence: [],
  }));
  expect((await runH01(request)).outcome).toBe('unknown');
});
it.each(['accepted', 'failed'])(
  'accepts only the exact owned IPC binding and exports child %s',
  async (outcome) => {
    setupChild();
    vi.spyOn(process, 'send').mockReturnValue(true);
    vi.spyOn(process, 'disconnect').mockImplementation(() => {});
    if (outcome === 'failed') backendOutcome = 'failed';
    const pending = h01Main([
      '--h01-child',
      requestRef.locator,
      requestRef.hash,
      control.locator,
      control.hash,
    ]);
    process.emit('message', {
      kind: 'comparison-h01-owned-child',
      opId: 'op',
      parentPid: process.ppid,
      request: requestRef,
      controlRef: control,
    });
    await pending;
    expect(process.send).toHaveBeenCalledWith({
      kind: 'comparison-h01-owned-child-ready',
      opId: 'op',
      parentPid: process.ppid,
      request: requestRef,
      controlRef: control,
    });
    expect(process.exitCode).toBe(outcome === 'accepted' ? 0 : 1);
  },
);
it('refuses a forged IPC parent before the first native provider', async () => {
  setupChild();
  const pending = h01Main([
    '--h01-child',
    requestRef.locator,
    requestRef.hash,
    control.locator,
    control.hash,
  ]);
  process.emit('message', {
    kind: 'comparison-h01-owned-child',
    opId: 'op',
    parentPid: process.ppid + 1,
    request: requestRef,
    controlRef: control,
  });
  await expect(pending).rejects.toThrow('h01-child-parent');
  expect(provider.backend).not.toHaveBeenCalled();
});
it('dispatches explicit run CLI and returns nonzero on preserved unknown', async () => {
  const path = resolve(root, 'input.json');
  writeFileSync(path, canonical(request));
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  provider.keeper.mockImplementationOnce(async (_input, signal: AbortSignal) => {
    process.listeners('SIGTERM').at(-1)!('SIGTERM');
    expect(signal.aborted).toBe(true);
    return { outcome: 'unknown', stop: stopped('outer-stop'), evidence: [] };
  });
  await h01Main(['--run', path]);
  expect(process.exitCode).toBe(1);
});
it('runs the module CLI only when explicitly selected and catches failures without issuing effects', async () => {
  const before = process.argv;
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [before[0]!];
    await import('./comparisonH01.js');
    process.argv = [before[0]!, resolve(import.meta.dirname, 'comparisonH01.ts'), '--invalid'];
    vi.resetModules();
    await import('./comparisonH01.js');
    await new Promise((accept) => setImmediate(accept));
    expect(stderr).toHaveBeenCalledWith('h01-usage\n');
    const path = resolve(root, 'input.json');
    writeFileSync(path, canonical(request));
    process.argv = [before[0]!, resolve(import.meta.dirname, 'comparisonH01.ts'), '--run', path];
    provider.guardAuthorization.mockRejectedValueOnce('raw failure');
    vi.resetModules();
    await import('./comparisonH01.js');
    await new Promise((accept) => setImmediate(accept));
    expect(stderr).toHaveBeenCalledWith('raw failure\n');
    expect(provider.backend).not.toHaveBeenCalled();
  } finally {
    process.argv = before;
  }
});
it('read-only plan exposes exact grant/caps/pins without issuing permission or touching roots', () => {
  const result = planH01(request);
  expect(result).toMatchObject({
    mayRun: false,
    qualification: false,
    partialScope: true,
    engine: 'legacy',
    budget: request.budget,
  });
  expect(result.expectedGrantText).toContain(result.requestHash);
  expect(existsSync(request.roots.workspaceRoot)).toBe(false);
  expect(provider.exec).not.toHaveBeenCalled();
  expect(provider.spawn).not.toHaveBeenCalled();
});
it.each(['material', 'criteria'] as const)('refuses substituted %s before execution', (field) => {
  request[field] = pin('wrong', {});
  expect(() => planH01(request)).toThrow('h01-' + field);
});
it('runs real shared case/verifier around mocked native providers and emits bounded partial evidence', async () => {
  setupChild();
  const result = await executeH01Child(requestRef, control);
  if (result.outcome === 'unknown')
    throw new Error(
      JSON.stringify(
        result.evidence.filter((ref) => ref.locator.includes('/failure-')).map(h01ReadJson),
      ),
    );
  expect(result).toMatchObject({
    outcome: 'accepted',
    qualification: false,
    partialScope: true,
    accounting: account,
  });
  expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  const cardPath = '.comparison/task.md';
  expect(
    readCardMarkdown(
      cardPath,
      readFileSync(resolve(request.roots.evidenceRoot, 'card-before', cardPath), 'utf8'),
    ).status,
  ).toBe('active');
  expect(
    await taskChatBrief(resolve(request.roots.evidenceRoot, 'card-before'), cardPath),
  ).toMatchObject({
    scope: ['range.mjs'],
  });
  expect(
    (await fileConnectionReader.load(request.roots.workspaceRoot, 'project/workflow.json'))
      .descriptor.project_id,
  ).toBe('h01-' + digest('op').slice(0, 16));
  expect(() =>
    validateLocalPlan(
      JSON.parse(
        readFileSync(resolve(request.roots.workspaceRoot, '.comparison/legacy-plan.json'), 'utf8'),
      ),
    ),
  ).not.toThrow();
  expect(
    (
      await readTaskCouncilSelection(
        request.roots.workspaceRoot,
        '.comparison/legacy-selection.json',
      )
    ).roles['system-analyst'].trigger,
  ).toBe(true);
  expect(
    taskChatOptions([
      'start',
      '--state',
      resolve(request.roots.stateRoot, 'legacy-task'),
      '--card',
      '.comparison/task.md',
      '--local-plan',
      '.comparison/legacy-plan.json',
      '--council-selection',
      '.comparison/legacy-selection.json',
      '--binary',
      parseH01Profile(request.profile).binary.locator,
    ]).action,
  ).toBe('start');
  expect(result.timing.start.clock_id).toBe(result.timing.end.clock_id);
  expect(provider.council).toHaveBeenCalledOnce();
  expect(provider.overlayVerify).toHaveBeenCalledOnce();
  expect(existsSync(resolve(request.roots.evidenceRoot, 'h01-child-report.json'))).toBe(true);
});
it.each(['owned-report', 'clock'])(
  'includes late %s export in full timing and refuses acceptance',
  async (delayedLabel) => {
    let now = process.hrtime.bigint();
    const began = now,
      wall = Date.now();
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => now);
    let exported = false;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (exported && delayedLabel === 'clock') {
        now += 60001000000n;
        exported = false;
      }
      return wall + Number((now - began) / 1000000n);
    });
    const record = contract.h01Record;
    vi.spyOn(contract, 'h01Record').mockImplementation((directory, label, value) => {
      const ref = record(directory, label, value);
      if (label === delayedLabel) now += 60001000000n;
      if (label === 'owned-report') exported = true;
      return ref;
    });
    provider.keeper.mockImplementationOnce(async () => ({
      outcome: 'completed',
      stop: stopped('outer-stop'),
      evidence: [],
      report: pin('child-result', { outcome: 'accepted', accounting: account }),
    }));
    const result = await runH01(request);
    expect(result.outcome).toBe('unknown');
    expect(result.elapsedMs).toBe(60001);
    expect(result.accounting).toEqual(account);
    expect(h01ReadJson(result.report)).toMatchObject({
      outcome: 'unknown',
      elapsedMs: 60001,
    });
    const { report: _ref, ...body } = result;
    expect(h01ReadJson(result.report)).toEqual(body);
    expect(existsSync(request.roots.evidenceRoot)).toBe(true);
  },
);
it.each(['unknown', 'failed'])('does not start checker/council on backend %s', async (outcome) => {
  setupChild();
  backendOutcome = outcome;
  const result = await executeH01Child(requestRef, control);
  expect(result.outcome).toBe(outcome);
  expect(provider.spawn).not.toHaveBeenCalled();
  expect(provider.council).not.toHaveBeenCalled();
});
it.each([
  { stopped: false },
  { deadlineReached: true },
  { signal: 'SIGTERM' },
  { code: 1 },
  { killed: true },
])('does not accept a failed/unknown or forcibly stopped checker %o', async (change) => {
  setupChild();
  Object.assign(checkerStop, change);
  const result = await executeH01Child(requestRef, control);
  expect(result.outcome).not.toBe('accepted');
  if (change.stopped === false || change.deadlineReached === true)
    expect(provider.council).not.toHaveBeenCalled();
});
it('preserves immutable changes and refuses council after corrupting consumers', async () => {
  setupChild();
  provider.backend.mockImplementationOnce(async () => {
    writeFileSync(resolve(request.roots.workspaceRoot, 'consumer-a.mjs'), 'tampered');
    return {
      outcome: 'completed',
      evidence: [],
      stop: stopped('backend-stop'),
      nativeAcceptance: null,
    };
  });
  expect((await executeH01Child(requestRef, control)).outcome).toBe('unknown');
  expect(provider.council).not.toHaveBeenCalled();
});
it.each(['unknown', 'failed', 'malformed', 'negative', 'wrong-checks'])(
  'handles council %s conservatively',
  async (mode) => {
    setupChild();
    provider.council.mockImplementationOnce(async () => ({
      outcome: mode === 'unknown' || mode === 'failed' ? mode : 'completed',
      evidence: [],
      stop: stopped('council-stop'),
      text:
        mode === 'malformed'
          ? 'not JSON'
          : canonical({
              outcome: mode === 'negative' ? 'failed' : 'accepted',
              checks:
                mode === 'wrong-checks'
                  ? {}
                  : Object.fromEntries(h01Criteria.checks.map((key) => [key, true])),
              limitations: ['provider double; not actual qualification'],
            }),
    }));
    expect((await executeH01Child(requestRef, control)).outcome).not.toBe('accepted');
  },
);
it('refuses an unconfirmed backend stop before the checker', async () => {
  setupChild();
  provider.backend.mockResolvedValueOnce({
    outcome: 'completed',
    evidence: [],
    stop: pin('bad-stop', { confirmed: true }),
    nativeAcceptance: null,
  });
  expect((await executeH01Child(requestRef, control)).outcome).toBe('unknown');
  expect(provider.spawn).not.toHaveBeenCalled();
});
it('treats incomplete accounting as unknown even after provider PASS', async () => {
  setupChild();
  account.unknown = true;
  account.reservedManagedStarts = null;
  expect((await executeH01Child(requestRef, control)).outcome).toBe('unknown');
});
it.each([false, true])(
  'uses operator loopback connections for candidate, closeFailure=%s',
  async (closeFailure) => {
    request.variant = 'candidate';
    const value = h01ReadJson(request.runtime) as Record<string, unknown>;
    request.runtime = pin('temporal-runtime', { ...value, engine: 'temporal' });
    request.bootstrap = pin('temporal-bootstrap', {
      engine: 'temporal',
      address: 'localhost:7233',
      namespace: 'default',
      taskQueue: 'q',
      workflowsPath: resolve(repo, 'src/workflows/index.ts'),
      issuer: {
        sessionsRoot: root,
        workspaceRoot: root,
        threadId: 'primary',
        owner: 'owner',
      },
    });
    makeControl();
    setupChild();
    const load = pin('primary-load', {
      turn: 'load-turn',
      status: 'completed',
    });
    const ready = pin('primary-ready', { kind: 'task-writer-ready', load });
    const backend = provider.backend.getMockImplementation()! as (
      context: H01AttemptContext,
    ) => Promise<H01BackendResult>;
    provider.backend.mockImplementationOnce(async (context: H01AttemptContext) => {
      const result = await backend(context);
      return {
        ...result,
        ready,
        evidence: [...result.evidence, ready, load],
      };
    });
    if (closeFailure) provider.nativeClose.mockRejectedValueOnce(new Error('unconfirmed close'));
    expect((await executeH01Child(requestRef, control)).outcome).toBe(
      closeFailure ? 'unknown' : 'accepted',
    );
    expect(provider.connection).toHaveBeenCalledWith({
      address: 'localhost:7233',
    });
    expect(provider.nativeConnection).toHaveBeenCalledOnce();
    const brief = String(provider.council.mock.calls[0]?.[2]);
    const announced = brief.match(/primary READY receipt (\{[^}]+\})/u)?.[1];
    expect(announced).toBeDefined();
    const observed = h01ReadJson(JSON.parse(announced!) as typeof ready);
    expect(observed).toEqual({ kind: 'task-writer-ready', load });
    expect(brief).toContain(canonical(load));
  },
);
it('rejects wrong request binding and unpinned actual host inventory before any provider', async () => {
  setupChild();
  const wrong = pin('wrong-request', { ...request, opId: 'other' });
  await expect(executeH01Child(wrong, control)).rejects.toThrow('h01-child-binding');
  provider.capture.mockResolvedValueOnce({ complete: false, inputs: [] });
  await expect(executeH01Child(requestRef, control)).rejects.toThrow('h01-host-inventory');
  expect(provider.exec).not.toHaveBeenCalled();
});
it('does not interpret keeper exit as acceptance without matching child report and keeps null unknown usage', async () => {
  provider.keeper.mockImplementationOnce(async () => ({
    outcome: 'unknown',
    stop: stopped('outer-stop'),
    evidence: [],
  }));
  const result = await runH01(request);
  expect(result).toMatchObject({
    outcome: 'unknown',
    accounting: { reservedManagedStarts: null, observedResponses: null },
    qualification: false,
  });
  expect(existsSync(request.roots.evidenceRoot)).toBe(true);
});
it.each(['completed', 'failed'])(
  'merges %s owned child evidence after physical keeper completion',
  async (outcome) => {
    provider.keeper.mockImplementationOnce(async () => ({
      outcome,
      stop: stopped('outer-stop'),
      evidence: [],
      report: pin('child-result', {
        outcome: outcome === 'completed' ? 'accepted' : 'failed',
        accounting: account,
      }),
    }));
    const result = await runH01(request);
    expect(result.outcome).toBe(outcome === 'completed' ? 'accepted' : 'failed');
    expect(result.accounting).toEqual(account);
    const { report: _ref, ...body } = result;
    expect(h01ReadJson(result.report)).toEqual(body);
  },
);
it('rejects existing roots and writer-tree overlap rather than reusing failed evidence', async () => {
  mkdirSync(request.roots.workspaceRoot);
  await expect(runH01(request)).rejects.toThrow('h01-root-not-fresh');
  request.roots.workspaceRoot = resolve(root, 'work/new-case');
  request.roots.evidenceRoot = resolve(root, 'work/inside');
  await expect(runH01(request)).rejects.toThrow('h01-writer-tree-overlap');
});
it('supports explicit plan CLI and refuses default/forged owned-child execution', async () => {
  const path = resolve(root, 'request-file.json');
  writeFileSync(path, canonical(request));
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await h01Main(['--plan', path]);
  expect(output).toHaveBeenCalled();
  await expect(h01Main([])).rejects.toThrow('h01-usage');
  await expect(h01Main(['--h01-child', 'a', 'b', 'c', 'd'])).rejects.toThrow();
});

it('shares a readonly physical runtime inventory and rejects incomplete or stale pins', async () => {
  const locator = resolve(repo, 'tests/comparisonH01.ts');
  const source = { locator, hash: digest(readFileSync(locator)) };
  provider.capture.mockResolvedValue({
    complete: true,
    inputs: [{ locator: 'tests/comparisonH01.ts', hash: source.hash }],
  });
  await expect(captureH01RuntimeInventory(repo)).resolves.toEqual([source]);
  const value = { engine: 'legacy', root: repo, files: [source] };
  request.runtime = pin('shared-runtime', value);
  await expect(verifyH01Runtime(request)).resolves.toEqual(value);
  provider.capture.mockResolvedValueOnce({ complete: false, inputs: [] });
  await expect(captureH01RuntimeInventory(repo)).rejects.toThrow('h01-host-inventory');
  provider.capture.mockResolvedValueOnce({
    complete: true,
    inputs: [{ locator: source.locator, hash: '0'.repeat(64) }],
  });
  await expect(captureH01RuntimeInventory(repo)).rejects.toThrow('h01-pin');
  request.runtime = pin('missing-shared-runtime', { ...value, files: [] });
  await expect(verifyH01Runtime(request)).rejects.toThrow();
});

it('captures the H04 runtime namespace and its shared native RPC consumer', async () => {
  await captureH01RuntimeInventory(repo, 'H-04');
  const input = provider.capture.mock.calls.at(-1)![0] as { files: string[] };
  expect(input.files).toContain('tests/comparisonH04Native.ts');
  expect(input.files).toContain('tests/comparisonH04NativeContract.ts');
  expect(input.files).toContain('tests/comparisonH02NativeRpc.ts');
  expect(input.files).not.toContain('tests/comparisonH03Legacy.ts');
});

it('excludes Finder metadata while preserving checks for similarly named source files', async () => {
  const directory = resolve(root, 'docs/product');
  mkdirSync(directory, { recursive: true });
  mkdirSync(resolve(root, 'tests'), { recursive: true });
  const metadata = resolve(directory, '.DS_Store');
  const source = resolve(directory, '.DS_Store.ts');
  writeFileSync(metadata, 'Finder layout before');
  writeFileSync(source, 'export const value = 1;');
  const ref = { locator: source, hash: digest(readFileSync(source)) };
  provider.capture.mockResolvedValue({
    complete: true,
    inputs: [
      { locator: 'docs/product/.DS_Store', hash: '0'.repeat(64) },
      { locator: 'docs/product/.DS_Store.ts', hash: ref.hash },
    ],
  });
  await expect(captureH01RuntimeInventory(root)).resolves.toEqual([ref]);
  writeFileSync(metadata, 'Finder layout after');
  await expect(captureH01RuntimeInventory(root)).resolves.toEqual([ref]);
  writeFileSync(source, 'export const value = 2;');
  await expect(captureH01RuntimeInventory(root)).rejects.toThrow('h01-pin');
});

function h02SeriesEvidenceFixture(candidate = false) {
  const f = seriesEvidenceFixture(candidate, 'H-02');
  const report: Record<string, unknown> = {
    outcome: 'accepted',
    blocking: [],
    checks: f.child.checks,
    evidence: [],
    effects: {
      threadStarts: candidate ? 4 : 3,
      turnStarts: 8,
      byPhase: candidate
        ? {
            initial: { threadStarts: 3, turnStarts: 6 },
            repaired: { threadStarts: 1, turnStarts: 2 },
          }
        : {
            initial: { threadStarts: 3, turnStarts: 6 },
            correction: { threadStarts: 0, turnStarts: 2 },
            probes: { threadStarts: 0, turnStarts: 0 },
          },
    },
  };
  const projection: Record<string, unknown> = {
    kind: 'comparison-h02-native-projection',
    scenario: 'H-02',
    opId: f.originalRequest.opId,
    engine: candidate ? 'temporal' : 'legacy',
    caseReport: null,
  };
  const artifact = (value: unknown) => {
    const bytes = Buffer.from(canonical(value));
    const sha256 = digest(bytes);
    writeFileSync(resolve(f.originalRequest.roots.artifactRoot, sha256), bytes);
    return { sha256, bytes: bytes.length };
  };
  const proofPin = (ref: { sha256: string }) => ({
    locator: resolve(f.originalRequest.roots.artifactRoot, ref.sha256),
    hash: ref.sha256,
  });
  const workflowProofs: Record<string, unknown>[] = [];
  const histories: Record<string, unknown>[] = [];
  const payloads = (value: unknown) => ({
    payloads: [
      temporal.api.common.v1.Payload.fromObject(defaultPayloadConverter.toPayload(value)!).toJSON(),
    ],
  });
  if (!candidate) {
    const advisers = Object.fromEntries(
      ['pricing', 'logging', 'storage'].map((role) => [
        role,
        {
          status: 'answered',
          answer: { verdict: role === 'pricing' ? 'FAIL' : 'PASS', coverage: 'complete' },
          run: { spec: { session_id: role + '-initial' } },
        },
      ]),
    );
    const repaired = structuredClone(advisers);
    repaired.pricing!.answer.verdict = 'PASS';
    const configuration = {
      catalog: 'catalog.md',
      profiles: Object.fromEntries(
        ['pricing', 'logging', 'storage'].map((role) => [role, role + '.md']),
      ),
    };
    const selection = Object.fromEntries(
      ['pricing', 'logging', 'storage'].map((role) => [
        role,
        { trigger: true, inputs: { complete: true }, reason: role },
      ]),
    );
    const target = { scope: 'H-02', inputs: { complete: true } };
    const initialCouncil = {
      phase: 'acceptance',
      configuration,
      selection,
      target,
      advisers,
      history: [],
    };
    const correctedCouncil = { ...initialCouncil, advisers: repaired };
    const initial = f.record('h02-initial', {
      kind: 'h02-initial-council',
      council: initialCouncil,
    });
    const corrected = f.record('h02-corrected', {
      kind: 'h02-corrected-council',
      council: correctedCouncil,
    });
    report.rounds = { initial, corrected };
    f.child.nativeAcceptance = corrected;
    report.localRpcObservations = ['pricing', 'logging', 'storage', 'pricing'].flatMap((role, i) =>
      ['load', 'review'].map((kind) => ({
        role,
        kind,
        session: role + '-initial',
        turn: 'turn-' + i + '-' + kind,
      })),
    );
    const council = (running: string[]) => ({
      ...correctedCouncil,
      advisers: Object.fromEntries(
        Object.entries(repaired).map(([role, value]) => [
          role,
          { ...value, status: running.includes(role) ? 'running' : 'answered' },
        ]),
      ),
    });
    const missing = { ...selection };
    delete missing.pricing;
    const partial = structuredClone(correctedCouncil);
    partial.selection.pricing!.inputs.complete = false;
    const probes = {
      'unchanged-pass': { kind: 'h02-unchanged-pass', council: council([]) },
      'changed-dependency': {
        kind: 'h02-changed-dependency',
        council: council(['pricing']),
        basis: { inputs: 'changed', requirements: 'changed', rationale: 'unchanged' },
      },
      'new-dependency': {
        kind: 'h02-new-dependency',
        roles: ['pricing'],
        council: council(['pricing']),
      },
      'shared-scope': {
        kind: 'h02-shared-scope',
        council: council(['pricing', 'logging', 'storage']),
      },
      'role-rationale': {
        kind: 'h02-role-rationale',
        roles: ['pricing'],
        basis: { rationale: 'changed', inputs: 'applicable', requirements: 'unchanged' },
      },
      'open-fail': { kind: 'h02-open-fail', blockers: ['pricing:unresolved-failure'], history: [] },
      'incomplete-map': {
        kind: 'h02-incomplete-map',
        missing: true,
        incomplete: true,
        missingError: 'missing-role-selection',
        incompleteError: 'pricing:incomplete-inputs',
        missingBasis: { phase: 'acceptance', selection: missing, target, configuration },
        incompleteBasis: { council: partial, target },
      },
    };
    report.probes = Object.fromEntries(
      Object.entries(probes).map(([name, value]) => [name, f.record('h02-probe-' + name, value)]),
    );
  } else {
    const preparation = {
      schemaVersion: 1 as const,
      project: {
        schemaVersion: 1 as const,
        projectId: 'h02-project',
        workspaceId: 'workspace',
        rules: ['.h02/rules.md'],
        cardRoot: '.h02',
        roles: ['pricing', 'logging', 'storage'].map((id) => ({
          id,
          profile: '.h02/' + id + '.md',
        })),
        checks: ['syntax'],
      },
      taskId: 'h02-task',
      hostId: 'host',
      owner: 'owner',
      generation: 1,
      revision: 1,
      card: '.h02/task.md',
    };
    const initialAnswers = ['FAIL', 'PASS', 'PASS'].map((verdict) =>
      artifact({ report: { verdict, coverage: 'complete' } }),
    );
    const rounds = ['initial', 'repaired'].map((name) => {
      const readerRoles = name === 'initial' ? ['pricing', 'logging', 'storage'] : ['pricing'];
      const readers = readerRoles.map((roleId, i) => ({
        roleId,
        session: roleId + '-' + name,
        answer:
          name === 'initial'
            ? initialAnswers[i]
            : artifact({ report: { verdict: 'PASS', coverage: 'complete' } }),
      }));
      const input = {
        schemaVersion: 1,
        preparation,
        reviewId: 'h02-' + name,
        request: artifact({ name }),
      };
      const decisions = ['pricing', 'logging', 'storage'].map((roleId, i) => ({
        roleId,
        action: name === 'initial' || i === 0 ? 'review' : 'reuse',
        input: {
          schemaVersion: 2,
          preparation,
          reviewId: digest(name),
          roleId,
          review: artifact({ name, roleId }),
        },
        answer: name === 'repaired' && i !== 0 ? initialAnswers[i] : null,
      }));
      const plan = { manifest: artifact({ decisions }), decisions };
      const completion = {
        manifest: artifact({ name, complete: name === 'repaired' }),
        complete: name === 'repaired',
      };
      const result = { status: 'reviewed', plan: plan.manifest, ...completion };
      const workflowId = `aw/review/h02-project/h02-task/h02-${name}`;
      const runId = 'run-' + name;
      const history = {
        kind: 'comparison-h02-review-history',
        scenario: 'H-02',
        opId: f.originalRequest.opId,
        round: name,
        workflowId,
        runId,
        history: {
          events: [
            {
              workflowExecutionStartedEventAttributes: {
                workflowType: { name: 'ReviewWorkflow' },
                originalExecutionRunId: runId,
                input: payloads(input),
              },
            },
            ...readerRoles.map((role) => ({
              startChildWorkflowExecutionInitiatedEventAttributes: {
                workflowId: `aw/review-reader/h02-project/h02-task/${role}/${digest(name)}`,
                workflowType: { name: 'ControlledReaderWorkflow' },
                input: payloads(decisions.find((row) => row.roleId === role)!.input),
              },
            })),
            { workflowExecutionCompletedEventAttributes: { result: payloads(result) } },
          ],
        },
      };
      histories.push(history);
      workflowProofs.push({
        kind: 'comparison-h02-review-workflow-proof',
        scenario: 'H-02',
        opId: f.originalRequest.opId,
        round: name,
        workflowId,
        runId,
        status: 'COMPLETED',
        input,
        history: null,
        result,
      });
      return { name, input, plan, readers, completion };
    });
    const probeNames = [
      'unchanged',
      'changed-dependency',
      'new-dependency',
      'shared-scope',
      'role-rationale',
      'open-FAIL',
      'missing-role',
      'incomplete-map',
    ];
    const latest = [rounds[1]!.readers[0]!.answer, initialAnswers[1], initialAnswers[2]];
    report.probes = probeNames.map((name) => {
      object(object(report.effects).byPhase)[name] = { threadStarts: 0, turnStarts: 0 };
      const request = {
        schemaVersion: 1,
        phase: 'planning',
        scope: 'H-02',
        sharedPaths: [],
        roles: (name === 'missing-role'
          ? ['pricing', 'logging']
          : ['pricing', 'logging', 'storage']
        ).map((roleId) => ({
          roleId,
          applies: true,
          reason: roleId,
          paths: [roleId + '.json'],
          complete: name !== 'incomplete-map' || roleId !== 'pricing',
          attestedBy: 'fixture',
          discoveryRule: 'H02-declared-paths/1',
          history: { complete: true, answers: [] },
        })),
      };
      const input = {
        schemaVersion: 1,
        preparation,
        reviewId: 'h02-' + name,
        request: artifact(request),
      };
      if (name === 'missing-role') {
        (report.evidence as InputRef[]).push(
          proofPin(
            artifact({
              kind: 'h02-temporal-probe-failure',
              name,
              request: input,
              error: 'review-role-selection-incomplete',
            }),
          ),
        );
        return { name, plan: null, completion: null, error: 'review-role-selection-incomplete' };
      }
      const reason = {
        unchanged: 'complete-pass-with-unchanged-inputs',
        'changed-dependency': 'input-changed:pricing.json',
        'new-dependency': 'input-changed:logging.json',
        'shared-scope': 'review-target-changed',
        'role-rationale': 'role-obligation-changed',
        'open-FAIL': 'open-failure',
        'incomplete-map': 'dependencies-unknown',
      }[name]!;
      const decisions = ['pricing', 'logging', 'storage'].map((roleId, i) => ({
        roleId,
        action: name === 'unchanged' || (name !== 'shared-scope' && i !== 0) ? 'reuse' : 'review',
        reasons: [
          name === 'shared-scope' || i === 0 ? reason : 'complete-pass-with-unchanged-inputs',
        ],
        input: rounds[1]!.plan.decisions[i]!.input,
        answer: name === 'unchanged' || (name !== 'shared-scope' && i !== 0) ? latest[i] : null,
      }));
      const plan = {
        manifest: artifact({
          schemaVersion: 1,
          kind: 'reader-review-plan',
          input,
          request,
          decisions,
        }),
        decisions,
      };
      const completion =
        name === 'incomplete-map'
          ? {
              manifest: artifact({
                schemaVersion: 1,
                kind: 'reader-review-result',
                input,
                plan: plan.manifest,
                complete: false,
              }),
              complete: false,
            }
          : null;
      return { name, plan, completion, error: null };
    });
    report.rounds = rounds;
    projection.sdk = true;
    projection.workflowEvidence = [];
    f.child.nativeAcceptance = proofPin(rounds[1]!.completion.manifest);
  }
  const refresh = () => {
    if (candidate)
      projection.workflowEvidence = workflowProofs.map((proof, i) => {
        proof.history = f.record('h02-history-' + i, histories[i]);
        return f.record('h02-workflow-' + i, proof);
      });
    projection.caseReport = f.record('h02-case', report);
    f.child.projection = f.record('h02-projection', projection);
    return f.refresh();
  };
  return {
    ...f,
    report,
    projection,
    workflowProofs,
    histories,
    refresh,
    artifact,
    proofPin,
    payloads,
  };
}
it.each([false, true])(
  'normalizes H02 through primary native evidence, candidate=%s',
  (candidate) => {
    const f = h02SeriesEvidenceFixture(candidate);
    expect(normalizeH01SeriesEvidence(f.refresh(), 'H-02')).toMatchObject({
      outcome: 'accepted',
      stopped: true,
      accounting: {
        reservedManagedStarts: 8,
        observedResponses: 8,
        inputUncached: 640,
        inputCached: 160,
        output: 80,
        unknown: false,
      },
    });
  },
);

it.each([
  'projection-engine',
  'projection-owner',
  'case-unknown',
  'extra-start',
  'wrong-acceptance',
  'lost-open-fail',
  'changed-reused-answer',
  'changed-review-role',
  'unknown-native-session',
  'extra-probe-start',
  'missing-probe',
])('refuses H02 legacy primary substitution %s and preserves observed usage', (mode) => {
  const f = h02SeriesEvidenceFixture();
  if (mode === 'projection-engine') f.projection.engine = 'temporal';
  if (mode === 'projection-owner') f.projection.opId = 'other-operation';
  if (mode === 'case-unknown') f.report.outcome = 'unknown';
  if (mode === 'extra-start') object(f.report.effects).turnStarts = 9;
  if (mode === 'wrong-acceptance') f.child.nativeAcceptance = null;
  if (mode === 'lost-open-fail' || mode === 'changed-reused-answer') {
    const rounds = object(f.report.rounds),
      initial = object(h01ReadJson(rounds.initial as InputRef));
    const advisers = object(object(initial.council).advisers);
    object(object(advisers[mode === 'lost-open-fail' ? 'pricing' : 'logging']).answer).verdict =
      mode === 'lost-open-fail' ? 'PASS' : 'FAIL';
    rounds.initial = f.record('h02-mutated-initial', initial);
  }
  if (mode === 'changed-review-role')
    (f.report.localRpcObservations as Record<string, unknown>[])[7]!.role = 'logging';
  if (mode === 'unknown-native-session')
    (f.report.localRpcObservations as Record<string, unknown>[])[0]!.session = 'unaccounted-native';
  if (mode === 'extra-probe-start')
    object(object(object(f.report.effects).byPhase).probes).turnStarts = 1;
  if (mode === 'missing-probe') delete object(f.report.probes)['open-fail'];
  const result = normalizeH01SeriesEvidence(f.refresh(), 'H-02');
  expect(result.outcome).toBe('unknown');
  expect(result.knownSubtotal).toMatchObject({
    observedResponses: 8,
    inputUncached: 640,
    output: 80,
  });
});
it.each([
  'direct-activities',
  'missing-workflow',
  'duplicate-workflow',
  'workflow-owner',
  'workflow-status',
  'workflow-result',
  'history-owner',
  'history-start',
  'history-run',
  'history-child',
  'history-completion',
  'initial-verdict',
  'repaired-verdict',
  'retained-answer',
  'unaccounted-reader',
  'incomplete-repair',
  'extra-probe-start',
  'wrong-acceptance',
  'artifact-size',
])('refuses H02 candidate primary substitution %s and preserves observed usage', (mode) => {
  const f = h02SeriesEvidenceFixture(true),
    rounds = f.report.rounds as Record<string, unknown>[];
  const initial = rounds[0]!,
    repaired = rounds[1]!;
  if (mode === 'direct-activities') f.projection.sdk = false;
  if (mode === 'missing-workflow') f.workflowProofs.pop();
  if (mode === 'duplicate-workflow') f.workflowProofs[1]!.round = 'initial';
  if (mode === 'workflow-owner') f.workflowProofs[0]!.opId = 'other-operation';
  if (mode === 'workflow-status') f.workflowProofs[0]!.status = 'RUNNING';
  if (mode === 'workflow-result') object(f.workflowProofs[0]!.result).complete = true;
  if (mode === 'history-owner') f.histories[0]!.opId = 'other-operation';
  const events = object(f.histories[0]!.history).events as Record<string, unknown>[];
  if (mode === 'history-start')
    object(object(events[0]!.workflowExecutionStartedEventAttributes).workflowType).name =
      'OtherWorkflow';
  if (mode === 'history-run')
    object(events[0]!.workflowExecutionStartedEventAttributes).originalExecutionRunId = 'other-run';
  if (mode === 'history-child')
    object(events[1]!.startChildWorkflowExecutionInitiatedEventAttributes).workflowId =
      'other-child';
  if (mode === 'history-completion') events.pop();
  const initialReaders = initial.readers as Record<string, unknown>[],
    repairedReaders = repaired.readers as Record<string, unknown>[];
  if (mode === 'initial-verdict')
    initialReaders[0]!.answer = f.artifact({ report: { verdict: 'PASS' } });
  if (mode === 'repaired-verdict')
    repairedReaders[0]!.answer = f.artifact({ report: { verdict: 'FAIL' } });
  if (mode === 'retained-answer')
    (object(repaired.plan).decisions as Record<string, unknown>[])[1]!.answer = f.artifact({
      report: { verdict: 'PASS', other: true },
    });
  if (mode === 'unaccounted-reader') initialReaders[0]!.session = 'other-native-session';
  if (mode === 'incomplete-repair') object(repaired.completion).complete = false;
  if (mode === 'extra-probe-start')
    object(object(f.report.effects).byPhase).probe = { threadStarts: 0, turnStarts: 1 };
  if (mode === 'wrong-acceptance') f.child.nativeAcceptance = null;
  if (mode === 'artifact-size') object(initialReaders[0]!.answer).bytes = 0;
  const result = normalizeH01SeriesEvidence(f.refresh(), 'H-02');
  expect(result.outcome).toBe('unknown');
  expect(result.knownSubtotal).toMatchObject({
    observedResponses: 8,
    inputUncached: 640,
    output: 80,
  });
});

it.each([
  'unchanged-pass',
  'changed-dependency',
  'new-dependency',
  'shared-scope',
  'role-rationale',
  'open-fail',
  'incomplete-map',
  'missing-code',
  'missing-basis',
  'incomplete-basis',
])(
  'requires the primary Legacy probe outcome even when the case booleans claim PASS: %s',
  (mode) => {
    const f = h02SeriesEvidenceFixture();
    const name = ['missing-code', 'missing-basis', 'incomplete-basis'].includes(mode)
      ? 'incomplete-map'
      : mode;
    const probes = object(f.report.probes),
      proof = object(h01ReadJson(probes[name] as InputRef));
    if (
      name === 'unchanged-pass' ||
      name === 'changed-dependency' ||
      name === 'new-dependency' ||
      name === 'shared-scope'
    ) {
      const advisers = object(object(proof.council).advisers);
      object(advisers.pricing).status = name === 'unchanged-pass' ? 'running' : 'answered';
    }
    if (name === 'role-rationale') object(proof.basis).rationale = 'unchanged';
    if (name === 'open-fail') proof.blockers = [];
    if (mode === 'incomplete-map') proof.incompleteError = 'another-error';
    if (mode === 'missing-code') proof.missingError = 'another-error';
    if (mode === 'missing-basis')
      object(proof.missingBasis).selection = object(
        object(h01ReadJson(object(f.report.rounds).corrected as InputRef)).council,
      ).selection;
    if (mode === 'incomplete-basis')
      object(object(object(object(proof.incompleteBasis).council).selection).pricing).inputs = {
        complete: true,
      };
    probes[name] = f.record('h02-bad-probe', proof);
    const result = normalizeH01SeriesEvidence(f.refresh(), 'H-02');
    expect(result.outcome).toBe('unknown');
    expect(result.knownSubtotal.observedResponses).toBe(8);
  },
);
it.each([
  'unchanged',
  'changed-dependency',
  'new-dependency',
  'shared-scope',
  'role-rationale',
  'open-FAIL',
  'missing-role',
  'incomplete-map',
  'missing-failure',
  'plan-pin',
  'extra-probe',
])('requires the primary SDK probe outcome even when the case booleans claim PASS: %s', (mode) => {
  const f = h02SeriesEvidenceFixture(true),
    probes = f.report.probes as Record<string, unknown>[];
  if (mode === 'missing-failure') f.report.evidence = [];
  else if (mode === 'extra-probe') probes.push({ ...probes[0], name: 'other-probe' });
  else {
    const name = mode === 'plan-pin' ? 'unchanged' : mode;
    const probe = probes.find((row) => row.name === name)!;
    if (mode === 'missing-role') probe.error = 'other-error';
    else if (mode === 'incomplete-map') object(probe.completion).complete = true;
    else {
      const plan = object(probe.plan),
        decisions = plan.decisions as Record<string, unknown>[];
      if (mode === 'plan-pin') {
        decisions[0]!.action = 'review';
      } else {
        decisions[0]!.reasons = [];
        const primary = object(
          h01ReadJson(f.proofPin(object(plan.manifest) as { sha256: string })),
        );
        primary.decisions = decisions;
        plan.manifest = f.artifact(primary);
      }
    }
  }
  const result = normalizeH01SeriesEvidence(f.refresh(), 'H-02');
  expect(result.outcome).toBe('unknown');
  expect(result.knownSubtotal.observedResponses).toBe(8);
});
it.each([
  'missing-start-input',
  'missing-child-input',
  'missing-result',
  'other-start-input',
  'other-child-input',
  'other-result',
  'multiple-inputs',
  'synthetic-skeleton',
])('requires SDK payload bindings rather than matching workflow labels: %s', (mode) => {
  const f = h02SeriesEvidenceFixture(true);
  const events = object(f.histories[0]!.history).events as Record<string, unknown>[];
  const started = object(events[0]!.workflowExecutionStartedEventAttributes),
    child = object(events[1]!.startChildWorkflowExecutionInitiatedEventAttributes),
    completed = object(events.at(-1)!.workflowExecutionCompletedEventAttributes);
  if (mode === 'missing-start-input') delete started.input;
  if (mode === 'missing-child-input') delete child.input;
  if (mode === 'missing-result') delete completed.result;
  if (mode === 'other-start-input') started.input = f.payloads({ other: 'input' });
  if (mode === 'other-child-input') child.input = f.payloads({ other: 'reader' });
  if (mode === 'other-result')
    completed.result = f.payloads({ status: 'reviewed', complete: true });
  if (mode === 'multiple-inputs')
    object(started.input).payloads = [
      ...f.payloads(f.workflowProofs[0]!.input).payloads,
      ...f.payloads({ extra: true }).payloads,
    ];
  if (mode === 'synthetic-skeleton') {
    delete started.input;
    for (const event of events.slice(1, -1))
      delete object(event.startChildWorkflowExecutionInitiatedEventAttributes).input;
    delete completed.result;
  }
  const result = normalizeH01SeriesEvidence(f.refresh(), 'H-02');
  expect(result.outcome).toBe('unknown');
  expect(result.knownSubtotal.observedResponses).toBe(8);
});

function h03SeriesEvidenceFixture(candidate = false) {
  const f = seriesEvidenceFixture(candidate, 'H-03'),
    req = f.originalRequest,
    session = 'h03-session',
    identity = { opId: req.opId, identity: req.identity };
  const dir = (name: string) => {
    const path = resolve(req.roots.workspaceRoot, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    return path;
  };
  mkdirSync(req.roots.workspaceRoot, { recursive: true });
  mkdirSync(req.roots.hostRoot, { recursive: true });
  const source = (name: string, content: string) => {
    const locator = dir(name);
    writeFileSync(locator, content);
    return { locator: name, hash: digest(content) };
  };
  const stock = parseConnection(
    JSON.parse(readFileSync(resolve(repo, 'project/workflow.json'), 'utf8')),
  );
  const procedures = h03Procedures.map((id) => stock.procedures.find((row) => row.id === id)!);
  for (const procedure of procedures)
    source(procedure.locator, readFileSync(resolve(repo, procedure.locator), 'utf8'));
  const assignment = source('.h03/task.md', material.cases[2]!.instructions + '\n');
  const profile = parseH01Profile(req.profile),
    metadata = h03PreparedMetadata(
      contract.h01ReadPin(profile.rules).toString(),
      contract.h01ReadPin(profile.executor).toString(),
    );
  const rule = source('.h03/rules.md', metadata['.h03/rules.md']!),
    executor = source('.h03/executor.md', metadata['.h03/executor.md']!);
  const artifact = (value: unknown) => {
    const bytes = Buffer.from(canonical(value)),
      sha256 = digest(bytes);
    writeFileSync(resolve(req.roots.artifactRoot, sha256), bytes);
    return { sha256, bytes: bytes.length };
  };
  const artifactBytes = (value: string) => {
    const bytes = Buffer.from(value),
      sha256 = digest(bytes);
    writeFileSync(resolve(req.roots.artifactRoot, sha256), bytes);
    return { locator: resolve(req.roots.artifactRoot, sha256), hash: sha256 };
  };
  const proofPin = (ref: { sha256: string }) => ({
    locator: resolve(req.roots.artifactRoot, ref.sha256),
    hash: ref.sha256,
  });
  const payloads = (value: unknown) => ({
    payloads: [
      temporal.api.common.v1.Payload.fromObject(defaultPayloadConverter.toPayload(value)!).toJSON(),
    ],
  });
  const rows: Record<string, unknown>[] = [{ type: 'session_meta', payload: { id: session } }];
  const native = (value: Record<string, unknown>) => {
    rows.push(value);
    return {
      locator: f.participants[0]!.transcript + '#L' + rows.length,
      hash: digest(canonical(value) + '\n'),
    };
  };
  let responses = 0;
  const usage = (turn: string) => {
    responses++;
    return native({
      type: 'token_usage_record',
      payload: {
        thread_id: session,
        session_id: session,
        turn_id: turn,
        response_id: 'response-' + responses,
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
        thread_token_usage: {
          input_tokens: 100 * responses,
          cached_input_tokens: 20 * responses,
          output_tokens: 10 * responses,
        },
      },
    });
  };
  const begin = (turn: string) => {
    native({
      type: 'event_msg',
      payload: { type: 'task_started', thread_id: session, turn_id: turn },
    });
    native({
      type: 'turn_context',
      payload: {
        turn_id: turn,
        cwd: req.roots.workspaceRoot,
        model: 'fixture',
        effort: 'high',
        approval_policy: 'never',
        sandbox_policy: { type: 'read-only', network_access: false },
      },
    });
  };
  const command = (turn: string, output: string) =>
    native({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: session,
        turn_id: turn,
        item: {
          type: 'CommandExecution',
          id: 'command-' + turn,
          cwd: req.roots.workspaceRoot,
          status: 'completed',
          exit_code: 0,
          aggregated_output: output,
        },
      },
    });
  const end = (turn: string) =>
    native({
      type: 'event_msg',
      payload: { type: 'task_complete', thread_id: session, turn_id: turn },
    });
  const clean = { stopped: true, code: 1, signal: null, killed: false, deadlineReached: false };
  const initialCheck = f.record('h03-check', {
    kind: 'comparison-h03-check',
    opId: req.opId,
    requestHash: h01RequestHash(req),
    material: req.material,
    cwd: req.roots.workspaceRoot,
    passed: false,
    stop: clean,
    stdout: f.raw('h03-check.stdout', ''),
    stderr: f.raw('h03-check.stderr', 'initial failure'),
  });
  const report: Record<string, unknown> = {
    kind: 'comparison-h03-case',
    scenario: 'H-03',
    opId: req.opId,
    engine: candidate ? 'temporal' : 'legacy',
    session,
    outcome: 'accepted',
    checks: f.child.checks,
    blocking: [],
    initial: {},
    recovered: {},
    retained: {},
    compaction: {},
    probes: {},
    stop: f.nativeStop(session),
    evidence: [],
    nativeAcceptance: false,
    qualification: false,
    partialScope: true,
  };
  const projection: Record<string, unknown> = {
    kind: 'comparison-h03-native-projection',
    scenario: 'H-03',
    opId: req.opId,
    engine: report.engine,
    caseReport: null,
  };
  const context = {
    opId: req.opId,
    requestHash: h01RequestHash(req),
    identity: req.identity,
    roots: req.roots,
  };
  const retained = object(report.retained);
  let input: ReturnType<typeof h03ReaderInput> | null = null;
  let legacyRun: ReturnType<typeof startLocalRun> | null = null;
  let initialState: Record<string, unknown> = {},
    recoveredState: Record<string, unknown> = {};
  let failed: Record<string, unknown> | null = null,
    pendingProof: Record<string, unknown> | null = null;
  const mutation = (change: Record<string, unknown>, operation: string) => {
    const request = {
      context: {
        schema_version: '1',
        project_id: 'h03-project',
        task_id: 'h03-task',
        subtask_id: null,
        run_id: req.opId,
        actor_id: session,
      },
      command: {
        type: 'mutate',
        mutation: {
          operation_id: req.opId + ':' + operation,
          expected_revision: 1,
          owner_generation: 1,
          payload_hash: '',
        },
        change,
      },
    } as unknown as StoreRequest;
    if (request.command.type !== 'mutate') throw new Error('fixture-mutation');
    request.command.mutation.payload_hash = storeRequestHash(request);
    return {
      request,
      reply: { ok: true, value: { operation_id: request.command.mutation.operation_id } },
    };
  };
  if (candidate) {
    input = h03ReaderInput(identity);
    const intent = {
      projectId: input.preparation.project.projectId,
      taskId: input.preparation.taskId,
      operationId: 'h03-unfinished',
      requestHash: digest(canonical({ opId: req.opId, material: req.material })),
      hostId: input.preparation.hostId,
      workspaceId: input.preparation.project.workspaceId,
      owner: input.preparation.owner,
      generation: input.preparation.generation,
    };
    const parent = resolve(req.roots.hostRoot, 'h03-pending');
    mkdirSync(parent);
    const locator = resolve(
      parent,
      digest(JSON.stringify([intent.projectId, intent.taskId, intent.operationId])),
    );
    const bytes = JSON.stringify([
      1,
      intent.projectId,
      intent.taskId,
      intent.operationId,
      intent.requestHash,
      intent.hostId,
      intent.workspaceId,
      intent.owner,
      intent.generation,
    ]);
    writeFileSync(locator, bytes);
    retained.failure = initialCheck;
    retained.pending = { locator, hash: digest(bytes) };
    retained.before = f.record('h03-before', {
      failure: retained.failure,
      pending: retained.pending,
      intent,
      state: { status: 'pending' },
    });
    retained.after = f.record('h03-after', {
      failure: retained.failure,
      pending: retained.pending,
      intent,
      state: { status: 'pending' },
      repeated: false,
      error: 'Error: effect-outcome-unknown',
    });
  } else {
    const body = {
        kind: 'h03-initial-check',
        result: 'FAIL',
        manifest: { inputs: [initialCheck] },
      },
      stored = {
        metadata: { id: 'F-01', revision: 1, head_revision: 1, result: 'FAIL' },
        body,
        successor: null,
      };
    failed = {
      kind: 'comparison-h03-initial-failure',
      check: initialCheck,
      ...mutation({ type: 'write', id: 'F-01', body }, 'initial-failure'),
      stored,
    };
    const effect = {
      id: req.opId + ':unfinished',
      intent: { kind: 'h03-unfinished-operation', opId: req.opId },
      outcome: 'pending',
      receipt: null,
    };
    pendingProof = {
      kind: 'comparison-h03-pending-intent',
      id: effect.id,
      ...mutation(
        { type: 'checkpoint', state: {}, effects: [{ id: effect.id, intent: effect.intent }] },
        'checkpoint',
      ),
    };
    retained.failure = f.record('h03-failure', failed);
    retained.pending = f.record('h03-pending', pendingProof);
    initialState = {
      kind: 'comparison-h03-state',
      state: {
        owner: session,
        generation: 1,
        checkpoint: { workflow: { execution: { findings: [{ id: 'F-01', resolution: null }] } } },
      },
      effects: [effect],
      failure: stored,
    };
    recoveredState = structuredClone(initialState);
    retained.before = f.record('h03-before', initialState);
    retained.after = f.record('h03-after', recoveredState);
  }
  report.context = publishH03Context(
    context,
    retained.failure as InputRef,
    retained.pending as InputRef,
  );
  const contextRule = { locator: h03ContextPath, hash: object(report.context).hash as string };
  const readContext = readFileSync(object(report.context).locator as string, 'utf8');
  let firstLoad: Record<string, unknown>, finalLoad: Record<string, unknown>;
  const prepared =
    input === null
      ? null
      : {
          status: 'prepared',
          manifest: artifact({
            kind: 'preparation',
            input: input.preparation,
            inputs: [
              ...new Set([
                ...input.preparation.project.rules,
                input.preparation.project.roles[0]!.profile,
                input.preparation.card,
              ]),
            ].map((path) => ({
              path,
              sha256: digest(readFileSync(resolve(req.roots.workspaceRoot, path))),
              bytes: readFileSync(resolve(req.roots.workspaceRoot, path)).length,
            })),
          }),
        };
  const sdkRefs =
    input === null
      ? []
      : [
          ...new Set([
            ...input.preparation.project.rules,
            input.preparation.project.roles[0]!.profile,
            input.preparation.card,
          ]),
        ].map((path) => ({
          path: resolve(req.roots.workspaceRoot, path),
          sha256: digest(readFileSync(resolve(req.roots.workspaceRoot, path))),
        }));
  const legacySpec =
    input !== null
      ? null
      : {
          project_id: 'h03-project',
          identity: { assignment_id: req.opId },
          assignment,
          product: false,
          run_id: req.opId,
          session_id: session,
          host_id: 'local',
          workspace: req.roots.workspaceRoot,
          parent_run_id: null,
          coordinator: false,
          role: null,
          fork_turns: 'none',
          scope: ['evidence/'],
          outcome: 'H03 native recovery',
          criteria: Object.keys(f.child.checks),
          writer: req.identity.owner,
          requested: { model: 'fixture', effort: 'high', permissions: ['read'] },
          effective: { model: 'fixture', effort: 'high', permissions: ['read'] },
          sources: [assignment, contextRule],
          procedures,
          rules: [rule, executor, contextRule],
          procedure_loading: 'by-action',
          context_loading: 'fragments-v1',
          route: { kind: 'nonproduct' },
        };
  if (legacySpec !== null)
    legacyRun = startLocalRun(legacySpec as Parameters<typeof startLocalRun>[0], 1);
  const observed = (turn: string) => ({
    id: turn,
    status: 'completed',
    items: [
      {
        id: 'command-' + turn,
        type: 'commandExecution',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: sdkRefs
          .map((ref) =>
            JSON.stringify({
              path: ref.path,
              sha256: ref.sha256,
              content: readFileSync(ref.path, 'utf8'),
            }),
          )
          .join('\n'),
      },
    ],
  });
  const nativeLoad = (turn: string, marker: string, fresh: boolean) => {
    begin(turn);
    if (candidate) {
      const turnData = observed(turn);
      command(turn, String(object((turnData.items as unknown[])[0]).aggregatedOutput));
      usage(turn);
      end(turn);
      return {
        kind: 'reader-load',
        promptVersion: 4,
        session,
        roleId: 'executor',
        prepared,
        refs: sdkRefs,
        observed: turnData,
        commandOutputs: null,
      };
    }
    const refs = [...procedures, ...legacySpec!.rules],
      output = refs
        .map((ref) =>
          JSON.stringify({
            chat_read: marker,
            locator: ref.locator,
            hash: ref.hash,
            content: readFileSync(resolve(req.roots.workspaceRoot, ref.locator), 'utf8'),
          }),
        )
        .join('\n');
    const read = command(turn, output);
    usage(turn);
    end(turn);
    const receipt = {
      run_id: req.opId,
      session_id: session,
      procedures,
      rules: legacySpec!.rules,
      observed_read: JSON.stringify([read, read]),
      ...(fresh ? { compact_fallback: 'chat-compact-read-unconfirmed' } : {}),
    };
    return {
      kind: 'comparison-h03-native-load',
      session,
      turn,
      marker,
      run: legacyRun,
      receipt,
      host: {
        root: req.roots.workspaceRoot,
        transcript: f.participants[0]!.transcript,
        anchor: {
          thread_id: session,
          turn_id: turn,
          workspace: req.roots.workspaceRoot,
          host_id: 'local',
        },
      },
      packet: null,
    };
  };
  firstLoad = nativeLoad('h03-initial', 'h03-initial', false);
  const before = {
    locator: f.participants[0]!.transcript + '#L' + rows.length,
    hash: digest(canonical(rows.at(-1)) + '\n'),
  };
  const compactUsage = usage('h03-compact'),
    boundary = native({
      type: 'compacted',
      payload: { message: 'Synthetic completed native compaction for unit verification.' },
    });
  const params = { threadId: session },
    start = {
      origin: 'legacy',
      method: 'thread/compact/start',
      before,
      stage: 'execution',
      session,
      key: 'h03-compact-credit',
      hash: digest(canonical(params)),
    };
  const dispatch = f.record('h03-compaction-dispatch', {
    kind: 'comparison-native-compaction-dispatch',
    scenario: 'H-03',
    opId: req.opId,
    method: 'thread/compact/start',
    before,
    start,
    params,
  });
  const compaction: Record<string, unknown> = {
    before,
    request: dispatch,
    boundary,
    through: boundary,
    usage: [compactUsage],
  };
  const actorHost = (turn: string) => ({
    root: req.roots.workspaceRoot,
    transcript: f.participants[0]!.transcript,
    anchor: {
      thread_id: session,
      turn_id: turn,
      workspace: req.roots.workspaceRoot,
      host_id: 'local',
    },
  });
  if (!candidate) {
    const base = (marker: string, additional = false) => ({
      schema_version: 1,
      run_id: req.opId,
      session_id: session,
      workspace: req.roots.workspaceRoot,
      project_id: 'h03-project',
      marker,
      action: additional ? 'execution-chat' : 'continue-chat',
      payload_hash: h01RequestHash(req),
      boundary,
      owner: session,
      generation: 1,
      role: legacyRun!.type as CompactContextPacket['role'],
      identity: legacySpec!.identity,
      assignment,
      admission: { route: 'nonproduct', accepted: null },
      outcome: 'H03 recovery',
      scope: ['evidence/'],
      criteria: Object.keys(f.child.checks),
      permissions: ['read'],
      profile: { requested: legacySpec!.requested, effective: legacySpec!.effective },
      sources: legacySpec!.sources,
      rules: legacySpec!.rules,
      procedures: procedures
        .filter((procedure) =>
          ['bootstrap', 'task', 'evidence', ...(additional ? ['implementation'] : [])].includes(
            procedure.id,
          ),
        )
        .map((procedure) => ({
          source: procedure,
          rules: normativeRules(
            procedure,
            readFileSync(resolve(req.roots.workspaceRoot, procedure.locator), 'utf8'),
          ),
        })),
      state: {
        pending_operations: [{ id: req.opId + ':unfinished', outcome: 'pending' }],
        execution: { findings: [{ id: 'F-01', resolution: null }] },
      },
    });
    const lines: string[] = [];
    for (const name of h03ProbeNames) {
      const marker = 'h03-' + name,
        expected = base(marker, name === 'new-action'),
        packet = structuredClone(name === 'new-action' ? base(marker) : expected);
      if (name === 'missing-rule')
        packet.procedures.find((row) => row.source.id === 'evidence')!.rules = packet.procedures
          .find((row) => row.source.id === 'evidence')!
          .rules.filter((row) => row.id !== 'evidence.03');
      if (name === 'stale-source')
        packet.procedures[0]!.source = { ...packet.procedures[0]!.source, hash: digest('stale') };
      if (name === 'wrong-role') packet.role = 'auditor';
      const line = JSON.stringify(compactContextLine(packet as CompactContextPacket));
      lines.push(line);
      const input = f.record('h03-probe-input-' + name, {
          kind: 'comparison-h03-probe-input',
          probe: name,
          packet,
          line,
        }),
        basis = f.record('h03-probe-basis-' + name, {
          kind: 'comparison-h03-probe-basis',
          probe: name,
          run: legacyRun,
          marker,
          host: actorHost('h03-probes'),
          expected,
          packet,
          input,
        }),
        error =
          name === 'new-action'
            ? 'chat-compact-full-load-required:chat-compact-read-unconfirmed'
            : 'chat-compact-full-load-required:chat-compact-context-stale';
      object(report.probes)[name] = {
        basis,
        observed: f.record('h03-probe-owner-' + name, {
          kind: 'comparison-h03-load-refused',
          probe: name,
          basis,
          error,
        }),
        error,
        refused: true,
      };
    }
    begin('h03-probes');
    command('h03-probes', lines.join('\n'));
    usage('h03-probes');
    end('h03-probes');
  }
  finalLoad = nativeLoad('h03-recovery', 'h03-recovery', true);
  if (candidate) {
    begin('h03-answer');
    usage('h03-answer');
    end('h03-answer');
  }
  const line = (pin: InputRef) => Number(pin.locator.match(/#L(\d+)$/u)![1]);
  const writeHistory = () => {
    writeFileSync(f.participants[0]!.transcript, rows.map((row) => canonical(row) + '\n').join(''));
    const last = rows.at(-1)!;
    f.participants[0]!.through = {
      locator: f.participants[0]!.transcript + '#L' + rows.length,
      hash: digest(canonical(last) + '\n'),
    };
    f.refreshUsage();
  };
  writeHistory();
  const compactReceipts = readComparisonUsage({ ...f.participants[0]!, through: boundary }).filter(
    (receipt) => line(receipt.source) > line(before),
  );
  const descriptor = f.record('h03-compaction', {
    kind: 'comparison-native-compaction',
    scenario: 'H-03',
    opId: req.opId,
    session,
    ...compaction,
  });
  f.accounting.evidence.push(
    f.raw('start-' + start.key + '.json', start),
    f.raw('confirmed-' + start.key + '.json', {
      kind: 'comparison-native-compaction-confirmation',
      key: start.key,
      session,
      before,
      boundary,
      evidence: dispatch,
      through: boundary,
      usage: compactReceipts,
    }),
  );
  report.compaction = {
    before,
    request: dispatch,
    boundary,
    usage: [compactUsage],
    receipt: descriptor,
  };
  report.initial = {
    load: f.record('h03-initial-load', firstLoad),
    state: candidate ? null : retained.before,
  };
  report.recovered = {
    load: f.record('h03-recovered-load', finalLoad),
    state: candidate ? null : retained.after,
  };
  const workflowProofs: Record<string, unknown>[] = [];
  const histories: Record<string, unknown>[] = [];
  if (candidate) {
    const invalid = proofPin(
      artifact({
        kind: 'reader-compacted-context',
        session,
        loadTurn: 'h03-initial',
        primary: {
          thread: {
            id: session,
            turns: [{ id: 'h03-initial', items: [{ type: 'contextCompaction' }] }],
          },
        },
      }),
    );
    (report.evidence as InputRef[]).push(
      invalid,
      artifactBytes('Synthetic transport journal, not a human authorization.\n'),
    );
    const initial = {
      mode: 'blocked',
      revision: 0,
      attempt: 0,
      session,
      phase: 'answering',
      error: 'reader-context-compacted:' + invalid.hash,
    };
    const final = {
      mode: 'answered',
      revision: 2,
      attempt: 1,
      session,
      phase: 'answering',
      error: '',
    };
    object(report.initial).state = f.record('h03-initial-state', initial);
    object(report.recovered).state = f.record('h03-final-state', final);
    const userLines = readFileSync(req.authorization.transcript, 'utf8').trimEnd().split('\n'),
      source = {
        schemaVersion: 1,
        kind: 'codex-user-command',
        transcript: req.authorization.transcript,
        threadId: req.authorization.anchor.thread_id,
        turnId: req.authorization.anchor.turn_id,
        user: { line: 2, sha256: req.authorization.source.hash },
      },
      commandSource = artifact(source),
      commands = h03NativeCommands(identity, commandSource);
    for (const command of [commands.pause, commands.resume]) {
      const raw = {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: source.threadId,
          turn_id: source.turnId,
          item: {
            type: 'CommandExecution',
            cwd: req.authorization.root,
            status: 'completed',
            exit_code: 0,
            aggregated_output: nativeReaderNotice(command),
          },
        },
      };
      userLines.push(canonical(raw));
      const human = proofPin(
        artifact({
          kind: 'reader-native-human-authorization',
          command,
          source,
          observed: {
            user: {
              line: 2,
              sha256: source.user.sha256,
              raw: JSON.parse(userLines[1]!) as unknown,
            },
            issued: { line: userLines.length, sha256: digest(canonical(raw) + '\n'), raw },
          },
        }),
      );
      (report.evidence as InputRef[]).push(human);
    }
    writeFileSync(req.authorization.transcript, userLines.join('\n') + '\n');
    for (const name of h03ProbeNames) {
      let basis: unknown;
      const code = {
        'missing-rule': 'project-registration-mismatch',
        'stale-source': 'reader-input-changed',
        'wrong-role': 'reader-role-not-declared',
        'new-action': 'reader-command-action-invalid',
      }[name];
      if (name === 'missing-rule') {
        const changed = structuredClone(input!);
        changed.preparation.project.rules = changed.preparation.project.rules.slice(1);
        basis = { registration: { project: input!.preparation.project }, input: changed };
      } else if (name === 'stale-source') {
        const text = readFileSync(resolve(req.roots.workspaceRoot, rule.locator), 'utf8');
        const prior = artifactBytes(text),
          after = artifactBytes(text + '\n');
        basis = {
          prepared,
          load: object(report.initial).load,
          before: {
            path: rule.locator,
            sha256: prior.hash,
            bytes: Buffer.byteLength(text),
            content: prior,
          },
          after: {
            path: rule.locator,
            sha256: after.hash,
            bytes: Buffer.byteLength(text + '\n'),
            content: after,
          },
        };
      } else if (name === 'wrong-role') basis = { ...input!, roleId: 'not-executor' };
      else basis = { ...commands.resume, action: 'write' };
      const pin = f.record('h03-probe-basis-' + name, basis),
        error = 'Error: ' + code;
      object(report.probes)[name] = {
        basis: pin,
        observed: f.record('h03-probe-observed-' + name, {
          kind: 'comparison-h03-probe-observation',
          probe: name,
          basis: pin,
          error,
          beforeStarts: 2,
          afterStarts: 2,
        }),
        error,
        refused: true,
      };
    }
    const result = {
      status: 'answered',
      answer: artifact({
        kind: 'reader-answer',
        session,
        load: {
          sha256: object(object(report.recovered).load).hash,
          bytes: readFileSync(object(object(report.recovered).load).locator as string).length,
        },
      }),
    };
    const workflowId =
        'aw/controlled-reader/' +
        input!.preparation.project.projectId +
        '/' +
        input!.preparation.taskId +
        '/executor',
      runId = 'h03-sdk-run';
    histories.push({
      kind: 'comparison-h03-reader-history',
      scenario: 'H-03',
      opId: req.opId,
      workflowId,
      runId,
      history: {
        events: [
          {
            workflowExecutionStartedEventAttributes: {
              workflowType: { name: 'ControlledReaderWorkflow' },
              originalExecutionRunId: runId,
              input: payloads(input),
            },
          },
          ...[commands.pause, commands.resume].map((command) => ({
            workflowExecutionUpdateAcceptedEventAttributes: {
              acceptedRequest: { input: { name: 'readerControl', args: payloads(command) } },
            },
          })),
          { workflowExecutionCompletedEventAttributes: { result: payloads(result) } },
        ],
      },
    });
    workflowProofs.push({
      kind: 'comparison-h03-reader-workflow-proof',
      scenario: 'H-03',
      opId: req.opId,
      workflowId,
      runId,
      status: 'COMPLETED',
      input,
      history: null,
      result,
      initial: object(report.initial).state,
      recovered: object(report.recovered).state,
      commands,
    });
    projection.sdk = true;
  }
  const refresh = () => {
    projection.caseReport = f.record('h03-case', report);
    if (candidate)
      projection.workflowEvidence = workflowProofs.map((proof, index) => {
        proof.history = f.record('h03-sdk-history-' + index, histories[index]);
        return f.record('h03-sdk-proof-' + index, proof);
      });
    f.child.projection = f.record('h03-projection', projection);
    f.child.nativeAcceptance = object(report.recovered).load as InputRef;
    return f.refresh();
  };
  return {
    ...f,
    report,
    projection,
    firstLoad,
    finalLoad,
    failed,
    pendingProof,
    initialState,
    recoveredState,
    rows,
    writeHistory,
    workflowProofs,
    histories,
    refresh,
    artifact,
    payloads,
    readContext,
  };
}
it.each([false, true])(
  'normalizes H03 same-session compaction and full primary recovery, candidate=%s',
  (candidate) => {
    const f = h03SeriesEvidenceFixture(candidate),
      result = normalizeH01SeriesEvidence(f.refresh(), 'H-03');
    expect(result).toMatchObject({
      outcome: 'accepted',
      stopped: true,
      accounting: {
        reservedManagedStarts: 4,
        observedResponses: 4,
        inputUncached: 320,
        inputCached: 80,
        output: 40,
        unknown: false,
      },
    });
  },
);

const h03CommonModes = [
  'not-run',
  'session',
  'context',
  'receipt',
  'old-load',
  'stop',
  'ledger',
  'through',
  'failure',
  'pending',
] as const;
it.each([false, true].flatMap((candidate) => h03CommonModes.map((mode) => ({ candidate, mode }))))(
  'refuses H03 $mode primary substitution, candidate=$candidate',
  ({ candidate, mode }) => {
    const f = h03SeriesEvidenceFixture(candidate),
      retained = object(f.report.retained);
    if (mode === 'not-run') f.report.outcome = 'not-run';
    if (mode === 'session') f.report.session = 'replacement-session';
    if (mode === 'context') writeFileSync(object(f.report.context).locator as string, '{}\n');
    if (mode === 'receipt')
      object(f.report.compaction).receipt = f.record('h03-fake-compaction', {
        kind: 'comparison-native-compaction',
      });
    if (mode === 'old-load') object(f.report.recovered).load = object(f.report.initial).load;
    if (mode === 'stop')
      f.report.stop = f.record('h03-unconfirmed-stop', {
        ...object(h01ReadJson(f.report.stop as InputRef)),
        confirmed: false,
      });
    if (mode === 'ledger')
      f.accounting.evidence = f.accounting.evidence.filter(
        (ref) => !ref.locator.endsWith('/confirmed-h03-compact-credit.json'),
      );
    if (mode === 'through') {
      const comp = object(f.report.compaction),
        descriptor = object(h01ReadJson(comp.receipt as InputRef));
      const before = Number(
        object(comp.before)
          .locator!.toString()
          .match(/#L(\d+)$/u)![1],
      );
      const receipts = readComparisonUsage(f.participants[0]!).filter(
        (receipt) => Number(receipt.source.locator.match(/#L(\d+)$/u)![1]) > before,
      );
      descriptor.through = f.participants[0]!.through;
      descriptor.usage = receipts.map((receipt) => receipt.source);
      comp.usage = descriptor.usage;
      comp.receipt = f.record('h03-expanded-compaction', descriptor);
      const previous = f.accounting.evidence.find((ref) =>
        ref.locator.endsWith('/confirmed-h03-compact-credit.json'),
      )!;
      const confirmed = {
        ...object(h01ReadJson(previous)),
        through: descriptor.through,
        usage: receipts,
      };
      const next = f.raw('confirmed-h03-compact-credit.json', confirmed);
      f.accounting.evidence = f.accounting.evidence.map((ref) =>
        ref.locator === previous.locator ? next : ref,
      );
    }
    if (mode === 'failure') {
      if (candidate)
        retained.failure = f.record('h03-fake-pass', {
          ...object(h01ReadJson(retained.failure as InputRef)),
          passed: true,
        });
      else {
        object(object(f.recoveredState.failure).metadata).result = 'PASS';
        retained.after = f.record('h03-lost-failure', f.recoveredState);
        object(f.report.recovered).state = retained.after;
      }
    }
    if (mode === 'pending') {
      if (candidate)
        writeFileSync(
          (retained.pending as InputRef).locator + '.receipt',
          JSON.stringify({ sha256: 'a'.repeat(64), bytes: 0 }),
        );
      else {
        object((f.recoveredState.effects as unknown[])[0]).outcome = 'confirmed';
        retained.after = f.record('h03-settled-pending', f.recoveredState);
        object(f.report.recovered).state = retained.after;
      }
    }
    const result = normalizeH01SeriesEvidence(f.refresh(), 'H-03');
    expect(result.outcome, mode).toBe('unknown');
    expect(result.knownSubtotal.observedResponses, mode).toBe(4);
  },
);
it.each(h03ProbeNames)(
  'requires actual H03 legacy invalid-input semantics rather than a claimed %s refusal',
  (name) => {
    const f = h03SeriesEvidenceFixture(),
      row = object(object(f.report.probes)[name]),
      basis = object(h01ReadJson(row.basis as InputRef));
    const packet = structuredClone(basis.expected),
      source = object(h01ReadJson(basis.input as InputRef)),
      old = textFieldForFixture(source.line);
    source.packet = packet;
    source.line = JSON.stringify(compactContextLine(packet as CompactContextPacket));
    basis.packet = packet;
    basis.input = f.record('h03-accepted-probe-input', source);
    row.basis = f.record('h03-accepted-probe-basis', basis);
    row.observed = f.record('h03-claimed-refusal', {
      ...object(h01ReadJson(row.observed as InputRef)),
      basis: row.basis,
    });
    for (const event of f.rows) {
      if (event.type !== 'event_msg') continue;
      const payload = object(event.payload);
      if (payload.type !== 'item_completed' || payload.turn_id !== 'h03-probes') continue;
      const item = object(payload.item);
      item.aggregated_output = String(item.aggregated_output).replace(old, source.line as string);
    }
    f.writeHistory();
    expect(normalizeH01SeriesEvidence(f.refresh(), 'H-03')).toMatchObject({
      outcome: 'unknown',
      knownSubtotal: { observedResponses: 4 },
    });
  },
);
function textFieldForFixture(value: unknown) {
  expect(typeof value).toBe('string');
  return value as string;
}
it.each(h03ProbeNames)(
  'requires actual H03 SDK %s input basis and a model-free owner refusal',
  (name) => {
    const f = h03SeriesEvidenceFixture(true),
      row = object(object(f.report.probes)[name]),
      basis = object(h01ReadJson(row.basis as InputRef));
    if (name === 'missing-rule')
      object(basis.input).preparation = object(f.workflowProofs[0]!.input).preparation;
    if (name === 'stale-source') basis.after = basis.before;
    if (name === 'wrong-role') basis.roleId = 'executor';
    if (name === 'new-action') basis.action = 'resume';
    row.basis = f.record('h03-valid-sdk-input', basis);
    row.observed = f.record('h03-claimed-sdk-refusal', {
      ...object(h01ReadJson(row.observed as InputRef)),
      basis: row.basis,
    });
    expect(normalizeH01SeriesEvidence(f.refresh(), 'H-03')).toMatchObject({
      outcome: 'unknown',
      knownSubtotal: { observedResponses: 4 },
    });
  },
);
it.each([
  'started-input',
  'result',
  'control-payload',
  'no-controls',
  'human-notice',
  'initial-grant',
] as const)('requires real H03 SDK history and issued human recovery notices: %s', (mode) => {
  const f = h03SeriesEvidenceFixture(true),
    proof = f.workflowProofs[0]!,
    history = object(f.histories[0]!.history),
    events = history.events as Record<string, unknown>[];
  if (mode === 'started-input')
    object(events[0]!.workflowExecutionStartedEventAttributes).input = f.payloads({
      other: 'reader',
    });
  if (mode === 'result')
    object(events.at(-1)!.workflowExecutionCompletedEventAttributes).result = f.payloads({
      status: 'answered',
      other: true,
    });
  if (mode === 'control-payload')
    object(
      object(events[1]!.workflowExecutionUpdateAcceptedEventAttributes).acceptedRequest,
    ).input = { name: 'readerControl', args: f.payloads(object(proof.commands).resume) };
  if (mode === 'no-controls') history.events = [events[0], events.at(-1)];
  if (mode === 'human-notice') {
    const file = f.originalRequest.authorization.transcript,
      rows = readFileSync(file, 'utf8').trimEnd().split('\n'),
      entry = object(JSON.parse(rows[2]!));
    object(object(entry.payload).item).aggregated_output =
      'A claimed resume is not an issued notice.';
    rows[2] = canonical(entry);
    writeFileSync(file, rows.join('\n') + '\n');
  }
  if (mode === 'initial-grant')
    f.report.evidence = (f.report.evidence as InputRef[]).filter((ref) => {
      try {
        return object(h01ReadJson(ref)).kind !== 'reader-native-human-authorization';
      } catch {
        return true;
      }
    });
  expect(normalizeH01SeriesEvidence(f.refresh(), 'H-03')).toMatchObject({
    outcome: 'unknown',
    knownSubtotal: { observedResponses: 4 },
  });
});
it('accepts a complete fresh Legacy native read assembled from contiguous fragments without double-counting repeated command refs', () => {
  const f = h03SeriesEvidenceFixture(),
    final = f.finalLoad,
    receipt = object(final.receipt),
    turn = String(final.turn);
  const event = f.rows.find(
    (row) =>
      row.type === 'event_msg' &&
      object(row.payload).type === 'item_completed' &&
      object(row.payload).turn_id === turn,
  )!;
  const item = object(object(event.payload).item),
    lines = String(item.aggregated_output).split('\n'),
    first = object(JSON.parse(lines[0]!)),
    text = String(first.content),
    middle = Math.floor(text.length / 2);
  const fragments = [
    { ...first, content: text.slice(0, middle), offset: 0, length: text.length },
    { ...first, content: text.slice(middle), offset: middle, length: text.length },
  ];
  item.aggregated_output = [...fragments.map((row) => JSON.stringify(row)), ...lines.slice(1)].join(
    '\n',
  );
  const index = f.rows.indexOf(event),
    pin = {
      locator: f.participants[0]!.transcript + '#L' + String(index + 1),
      hash: digest(canonical(event) + '\n'),
    };
  receipt.observed_read = JSON.stringify([pin, pin]);
  f.writeHistory();
  object(f.report.recovered).load = f.record('h03-fragmented-load', final);
  expect(normalizeH01SeriesEvidence(f.refresh(), 'H-03')).toMatchObject({
    outcome: 'accepted',
    accounting: { unknown: false },
  });
});

it('refuses a coherent Legacy deletion of a mandatory rule from both specs, receipts and native read records', () => {
  const f = h03SeriesEvidenceFixture();
  for (const load of [f.firstLoad, f.finalLoad]) {
    const run = object(load.run),
      spec = object(run.spec),
      receipt = object(load.receipt),
      turn = String(load.turn);
    spec.rules = (spec.rules as { locator: string }[]).filter(
      (ref) => ref.locator !== '.h03/rules.md',
    );
    receipt.rules = spec.rules;
    const event = f.rows.find(
        (row) =>
          row.type === 'event_msg' &&
          object(row.payload).type === 'item_completed' &&
          object(row.payload).turn_id === turn,
      )!,
      item = object(object(event.payload).item);
    item.aggregated_output = String(item.aggregated_output)
      .split('\n')
      .filter((line) => object(JSON.parse(line)).locator !== '.h03/rules.md')
      .join('\n');
    const pin = {
      locator: f.participants[0]!.transcript + '#L' + String(f.rows.indexOf(event) + 1),
      hash: digest(canonical(event) + '\n'),
    };
    receipt.observed_read = JSON.stringify([pin, pin]);
  }
  f.writeHistory();
  object(f.report.initial).load = f.record('h03-thin-initial-load', f.firstLoad);
  object(f.report.recovered).load = f.record('h03-thin-recovered-load', f.finalLoad);
  expect(normalizeH01SeriesEvidence(f.refresh(), 'H-03')).toMatchObject({
    outcome: 'unknown',
    knownSubtotal: { observedResponses: 4 },
  });
});
it('binds H03 human recovery notices to the exact operator user source even when another user line in that turn has valid notices', () => {
  const f = h03SeriesEvidenceFixture(true),
    req = f.originalRequest,
    proof = f.workflowProofs[0]!;
  const rows = readFileSync(req.authorization.transcript, 'utf8').trimEnd().split('\n');
  const human = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'A different primary human message in the same turn.' },
      ],
    },
  };
  rows.push(canonical(human));
  const source = {
    schemaVersion: 1,
    kind: 'codex-user-command',
    transcript: req.authorization.transcript,
    threadId: req.authorization.anchor.thread_id,
    turnId: req.authorization.anchor.turn_id,
    user: { line: rows.length, sha256: digest(canonical(human) + '\n') },
  };
  const commands = h03NativeCommands(
    { opId: req.opId, identity: req.identity },
    f.artifact(source),
  );
  proof.commands = commands;
  f.report.evidence = (f.report.evidence as InputRef[]).filter((ref) => {
    try {
      return object(h01ReadJson(ref)).kind !== 'reader-native-human-authorization';
    } catch {
      return true;
    }
  });
  for (const command of [commands.pause, commands.resume]) {
    const raw = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: source.threadId,
        turn_id: source.turnId,
        item: {
          type: 'CommandExecution',
          cwd: req.authorization.root,
          status: 'completed',
          exit_code: 0,
          aggregated_output: nativeReaderNotice(command),
        },
      },
    };
    rows.push(canonical(raw));
    const pin = f.artifact({
      kind: 'reader-native-human-authorization',
      command,
      source,
      observed: {
        user: { ...source.user, raw: human },
        issued: { line: rows.length, sha256: digest(canonical(raw) + '\n'), raw },
      },
    });
    (f.report.evidence as InputRef[]).push({
      locator: resolve(req.roots.artifactRoot, pin.sha256),
      hash: pin.sha256,
    });
  }
  writeFileSync(req.authorization.transcript, rows.join('\n') + '\n');
  const events = object(f.histories[0]!.history).events as Record<string, unknown>[];
  object(object(events[1]!.workflowExecutionUpdateAcceptedEventAttributes).acceptedRequest).input =
    { name: 'readerControl', args: f.payloads(commands.pause) };
  object(object(events[2]!.workflowExecutionUpdateAcceptedEventAttributes).acceptedRequest).input =
    { name: 'readerControl', args: f.payloads(commands.resume) };
  const probe = object(object(f.report.probes)['new-action']);
  probe.basis = f.record('h03-other-user-resume', { ...commands.resume, action: 'write' });
  probe.observed = f.record('h03-other-user-owner', {
    ...object(h01ReadJson(probe.observed as InputRef)),
    basis: probe.basis,
  });
  expect(normalizeH01SeriesEvidence(f.refresh(), 'H-03')).toMatchObject({
    outcome: 'unknown',
    knownSubtotal: { observedResponses: 4 },
  });
});
