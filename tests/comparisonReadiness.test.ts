import console from 'node:console';
import process from 'node:process';
import * as fs from 'node:fs';
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, canonicalHash, digest } from '../adapters/storage/storeCodec.js';
import { readPrivateFile } from '../adapters/storage/storeFiles.js';
import { object } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { h01RequestHash, h01ReadJson } from './comparisonH01Contract.js';
import type { H01ExecutionRequest } from './comparisonH01Contract.js';
import {
  h01SeriesMain,
  planH01Series,
  stepH01Series,
  statusH01Series,
} from './comparisonH01Series.js';
import type { ComparisonReceipt, ComparisonResult, ComparisonTiming } from '../core/comparison.js';
import {
  readComparisonUsage,
  type NativeComparisonReceipt,
} from '../adapters/codex/comparisonUsage.js';
import {
  checkComparisonReadiness,
  checkComparisonTemporalSeries,
  comparisonReadinessCli,
  comparisonReadinessPlan,
} from './comparisonReadiness.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));
const h01Series = vi.hoisted(() => ({
  plan: vi.fn(),
  runtime: vi.fn(),
  run: vi.fn(),
  evidence: vi.fn(),
}));
vi.mock('./comparisonH01Operator.js', () => ({
  planH01Operator: h01Series.plan,
  runH01Operator: h01Series.run,
}));
vi.mock('./comparisonH01.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  verifyH01Runtime: h01Series.runtime,
}));
vi.mock('./comparisonH01SeriesEvidence.js', () => ({
  normalizeH01SeriesEvidence: h01Series.evidence,
}));

function sourceManifest() {
  const input = manifest();
  const roots = {
    source: join(root, 'source'),
    baseline: join(root, 'baseline'),
    candidate: join(root, 'candidate'),
  };
  const text = Buffer.from('physical source\n'),
    binary = Buffer.from([0, 255, 13]);
  for (const directory of Object.values(roots)) {
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(directory, 'scripts'), { mode: 0o700 });
    writeFileSync(join(directory, 'input.txt'), text, { mode: 0o600 });
    writeFileSync(join(directory, 'scripts/main.bin'), binary, { mode: 0o600 });
  }
  const entries = [
    { path: '', mode: 0o700, kind: 'directory' },
    { path: 'input.txt', mode: 0o600, kind: 'file', sha256: digest(text), bytes: text.length },
    { path: 'scripts', mode: 0o700, kind: 'directory' },
    {
      path: 'scripts/main.bin',
      mode: 0o600,
      kind: 'file',
      sha256: digest(binary),
      bytes: binary.length,
    },
  ];
  const inventory = file('source-inventory.json', JSON.stringify(entries));
  input.schema_version = 2;
  input.sourceSnapshot = { inventory, roots };
  return { input, roots, entries, inventory };
}

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'comparison-readiness-')));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function file(name: string, bytes: string) {
  const locator = join(root, name);
  writeFileSync(locator, bytes);
  return { locator, hash: digest(bytes) };
}
function manifest(): Record<string, unknown> {
  const result: Record<string, unknown> = comparisonReadinessPlan().manifest;
  result.seriesId = 'offline-preparation';
  for (const variant of ['baseline', 'candidate']) {
    Object.assign(object(object(result.variants)[variant]), {
      runtime: {
        engine: variant === 'baseline' ? 'legacy' : 'temporal',
        artifact: file(`${variant}-runtime`, `${variant} opaque artifact; not executed`),
      },
      profile: {
        model: 'declared-model',
        effort: 'declared-effort',
        clientVersion: 'declared-client-version',
        client: file(`${variant}-client`, 'same pinned client bytes; never executed'),
        rules: file(`${variant}-rules`, 'private rule bytes'),
        permissions: file(`${variant}-permissions`, 'declared permissions; no grant'),
        roles: ['executor', 'reviewer', 'council', 'helper'],
      },
      environment: {
        node: 'v24.18.0',
        yarn: '1.22.22',
        os: 'declared-os',
        architecture: 'declared-arch',
        cachePolicy: 'cold',
        sdk: '1.24.0',
        server: '1.32.0',
        workerSlots: 1,
        lock: file(`${variant}-lock`, 'same lock bytes'),
        hardware: file(`${variant}-hardware`, 'private hardware declaration'),
        background: file(`${variant}-background`, 'private workload declaration'),
        network: file(`${variant}-network`, 'private network declaration'),
      },
    });
  }
  return result;
}
function change(value: Record<string, unknown>, path: string, replacement: unknown) {
  const parts = path.split('.');
  let parent = value;
  for (const part of parts.slice(0, -1)) parent = object(parent[part]);
  parent[parts.at(-1)!] = replacement;
}
function snapshot() {
  return Object.fromEntries(
    (readdirSync(root) as string[]).map((name) => [name, digest(readFileSync(join(root, name)))]),
  );
}

const seriesTime = (start: number, end: number): ComparisonTiming => ({
  start: { wall_ms: start + 1000, monotonic_ms: start, clock_id: 'offline-clock' },
  end: { wall_ms: end + 1000, monotonic_ms: end, clock_id: 'offline-clock' },
});
type SeriesAttempt = {
  participants: string[];
  receipts: ComparisonReceipt[];
  result: Omit<ComparisonResult, 'timing'> & { timing: ComparisonTiming | null };
  stopConfirmed: boolean;
};
function seriesRecord(count = 0) {
  const input = manifest();
  const readiness = checkComparisonReadiness(input);
  const suite = JSON.parse(
    readFileSync(new URL('../comparison/suite.json', import.meta.url), 'utf8'),
  ) as {
    scenarios: { id: string; checks: string[] }[];
  };
  const receipt = (id: string, run: string | null): ComparisonReceipt => ({
    id,
    run,
    participant: id,
    stage: run === null ? 'preparation' : 'execution',
    responses: 1,
    input_uncached: 2,
    input_cached: 3,
    output: 4,
  });
  const attempts: SeriesAttempt[] = readiness.schedule.slice(0, count).map((run, index) => {
    const participants = [`executor-${index}`, `reviewer-${index}`];
    return {
      participants,
      receipts: participants.map((id) => receipt(id, run.id)),
      stopConfirmed: true,
      result: {
        run: run.id,
        attempt: 1,
        outcome: 'accepted',
        checks: Object.fromEntries(
          suite.scenarios
            .find((scenario) => scenario.id === run.scenario)!
            .checks.map((key) => [key, true]),
        ),
        evidence: [`primary-result-${index}`],
        timing: seriesTime(10 + index * 10, 20 + index * 10),
      },
    };
  });
  return {
    schema_version: 1,
    kind: 'temporal-comparison-series-record',
    allowedModelStarts: 0,
    authorization: null,
    readiness: file('series-readiness.json', JSON.stringify(input)),
    canonicalManifestHash: readiness.canonicalManifestHash,
    elapsed_ms: 1000,
    preparation: {
      participants: ['preparer'],
      receipts: [receipt('preparer', null)],
      timing: seriesTime(0, 10) as ComparisonTiming | null,
      stopConfirmed: true,
    },
    attempts,
  };
}

type UsageSource = {
  session: string;
  transcript: { locator: string; hash: string };
  run: string | null;
  stage: ComparisonReceipt['stage'];
  after?: { locator: string; hash: string };
  through: { locator: string; hash: string };
};
type PrimarySeries = Omit<ReturnType<typeof seriesRecord>, 'preparation' | 'attempts'> & {
  preparation: ReturnType<typeof seriesRecord>['preparation'] & { usageSources: UsageSource[] };
  attempts: (SeriesAttempt & { usageSources: UsageSource[] })[];
};
function sourceReceipts(source: UsageSource) {
  return readComparisonUsage({ ...source, transcript: source.transcript.locator }, false);
}
function primarySeries(format: 'cumulative' | 'response', count = 1): PrimarySeries {
  const record = seriesRecord(count) as PrimarySeries;
  record.schema_version = 2;
  const usage = (input: number, cached: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
  });
  for (const block of [record.preparation, ...record.attempts]) {
    block.usageSources = block.receipts.map((receipt) => {
      const session = receipt.participant;
      const rows = [
        { type: 'session_meta', payload: { id: session } },
        ...[0, 1].map((index) => ({
          type: format === 'response' ? 'token_usage_record' : 'event_msg',
          payload:
            format === 'response'
              ? {
                  thread_id: session,
                  session_id: session,
                  turn_id: 'turn-1',
                  response_id: `response-${index}`,
                  usage: index === 0 ? usage(100, 20, 10) : usage(50, 10, 15),
                  thread_token_usage: index === 0 ? usage(100, 20, 10) : usage(150, 30, 25),
                }
              : {
                  type: 'token_count',
                  info: {
                    total_token_usage: index === 0 ? usage(100, 20, 10) : usage(150, 30, 25),
                    last_token_usage: index === 0 ? usage(100, 20, 10) : usage(50, 10, 15),
                  },
                },
        })),
        { type: 'event_msg', payload: { type: 'task_complete' } },
      ].map((row) => JSON.stringify(row) + '\n');
      const transcript = file(`${session}.jsonl`, rows.join(''));
      return {
        session,
        transcript,
        run: receipt.run,
        stage: receipt.stage,
        through: { locator: transcript.locator + '#L4', hash: digest(rows[3]!) },
      };
    });
    block.receipts = block.usageSources.flatMap(sourceReceipts);
  }
  return record;
}

it.each(['cumulative', 'response'] as const)(
  'verifies listed primary %s ranges through the existing parser without changing files',
  (format) => {
    const record = primarySeries(format, 24),
      before = snapshot();
    const report = checkComparisonTemporalSeries(record);
    expect(report).toMatchObject({
      schema_version: 2,
      status: 'PASS',
      mayRun: false,
      qualification: false,
      allowedModelStarts: 0,
      authorization: null,
      observationsComplete: true,
      primaryUsageVerified: true,
      usageVerificationScope: 'listed-ranges',
      totals: { responses: 98, input_uncached: 5880, input_cached: 1470, output: 1225 },
    });
    expect(report.unproven).toContain('declared-participant-completeness');
    expect(report.unproven).toContain('native-accounting');
    expect(snapshot()).toEqual(before);
    const pinned = file('primary-series.json', JSON.stringify(record));
    expect(comparisonReadinessCli(['--series-check', pinned.locator])).toMatchObject({
      exitCode: 0,
      report: { schema_version: 2, primaryUsageVerified: true, mayRun: false },
    });
  },
);

it.each(['cumulative', 'response'] as const)(
  'honours exact after/through boundaries in %s transcripts and pins earlier bytes',
  (format) => {
    const record = primarySeries(format);
    const source = record.preparation.usageSources[0]!;
    const rows = readFileSync(source.transcript.locator, 'utf8').split('\n');
    source.after = { locator: source.transcript.locator + '#L2', hash: digest(rows[1]! + '\n') };
    record.preparation.receipts = sourceReceipts(source);
    expect(checkComparisonTemporalSeries(record).totals.responses).toBe(5);
    // The selected through line itself stays unchanged; the whole-file pin still detects this edit.
    rows[1] = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } });
    writeFileSync(source.transcript.locator, rows.join('\n'));
    expect(() => checkComparisonTemporalSeries(record)).toThrow('readiness-pin-changed');
  },
);

it('preserves primary null usage and does not let declared zero hide unknown counters', () => {
  const record = primarySeries('cumulative');
  const block = record.attempts[0]!;
  const source = block.usageSources[0]!;
  const rows = [
    { type: 'session_meta', payload: { id: source.session } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map((row) => JSON.stringify(row) + '\n');
  writeFileSync(source.transcript.locator, rows.join(''));
  source.transcript.hash = digest(rows.join(''));
  source.through = { locator: source.transcript.locator + '#L3', hash: digest(rows[2]!) };
  block.receipts = block.usageSources.flatMap(sourceReceipts);
  expect(checkComparisonTemporalSeries(record)).toMatchObject({
    primaryUsageVerified: true,
    observationsComplete: false,
    next: { action: 'missing-metrics' },
  });
  const unknown = block.receipts.find((receipt) => receipt.responses === null)!;
  unknown.responses = 0;
  expect(() => checkComparisonTemporalSeries(record)).toThrow('series-usage-receipts-mismatch');
});

it('refuses altered primary declarations, omitted sources, foreign ranges and duplicate accounting', () => {
  const changes: ((record: PrimarySeries) => void)[] = [
    (record) => {
      record.preparation.usageSources = null as unknown as UsageSource[];
    },
    (record) => {
      record.preparation.usageSources = [];
    },
    (record) => {
      record.preparation.usageSources[0]!.session = 'foreign-session';
    },
    (record) => {
      record.preparation.usageSources[0]!.run = 'H-01:1:baseline';
    },
    (record) => {
      record.preparation.usageSources[0]!.stage = 'council';
    },
    (record) => {
      record.preparation.usageSources[0]!.transcript.locator = 'relative.jsonl';
    },
    (record) => {
      record.preparation.usageSources[0]!.transcript.hash = '0'.repeat(64);
    },
    (record) => {
      delete (record.preparation.usageSources[0] as Partial<UsageSource>).through;
    },
    (record) => {
      record.preparation.usageSources[0]!.through.hash = '0'.repeat(64);
    },
    (record) => {
      record.preparation.usageSources[0]!.through.hash = 'bad';
    },
    (record) => {
      record.preparation.usageSources[0]!.through.locator = '/foreign#L4';
    },
    (record) => {
      record.preparation.usageSources[0]!.through.locator += '0';
    },
    (record) => {
      record.preparation.usageSources[0]!.through.locator =
        record.preparation.usageSources[0]!.transcript.locator + '#L0';
    },
    (record) => {
      record.preparation.usageSources[0]!.after = {
        ...record.preparation.usageSources[0]!.through,
      };
    },
    (record) => {
      record.preparation.receipts[0]!.input_cached = 0;
    },
    (record) => {
      (record.preparation.receipts[0] as NativeComparisonReceipt).source.hash = '0'.repeat(64);
    },
    (record) => {
      record.preparation.receipts.pop();
    },
    (record) => {
      record.preparation.usageSources.push(structuredClone(record.preparation.usageSources[0]!));
    },
    (record) => {
      record.preparation.usageSources.push(structuredClone(record.preparation.usageSources[0]!));
      record.preparation.receipts.push(...sourceReceipts(record.preparation.usageSources[0]!));
    },
  ];
  for (const change of changes) {
    const record = primarySeries('response');
    change(record);
    expect(() => checkComparisonTemporalSeries(record)).toThrow();
  }
  const legacy = seriesRecord();
  Object.assign(legacy.preparation, { usageSources: [] });
  expect(() => checkComparisonTemporalSeries(legacy)).toThrow('readiness-fields-invalid');
});

it.each(['same-block', 'later-block'] as const)(
  'rejects two transcript formats for one session in %s before reading the conflicting source',
  (placement) => {
    const record = primarySeries('cumulative');
    const original = record.preparation.usageSources[0]!;
    const rows = readFileSync(original.transcript.locator, 'utf8').trimEnd().split('\n');
    const responseRows = rows.map((line, index) => {
      if (index !== 1 && index !== 2) return line + '\n';
      const info = object(object(JSON.parse(line)).payload).info;
      return (
        JSON.stringify({
          type: 'token_usage_record',
          payload: {
            thread_id: original.session,
            session_id: original.session,
            turn_id: 'turn-1',
            response_id: `alternate-response-${index}`,
            usage: object(info).last_token_usage,
            thread_token_usage: object(info).total_token_usage,
          },
        }) + '\n'
      );
    });
    const alternative: UsageSource = {
      ...original,
      transcript: file('alternate-preparer.jsonl', responseRows.join('')),
      through: {
        locator: join(root, 'alternate-preparer.jsonl') + '#L4',
        hash: digest(responseRows[3]!),
      },
    };
    expect(sourceReceipts(alternative).map((receipt) => receipt.id)).not.toEqual(
      sourceReceipts(original).map((receipt) => receipt.id),
    );
    if (placement === 'same-block') {
      record.preparation.usageSources.push(alternative);
      record.preparation.receipts.push(...sourceReceipts(alternative));
    } else {
      const block = record.attempts[0]!;
      alternative.run = block.result.run;
      alternative.stage = 'execution';
      block.participants[0] = original.session;
      block.usageSources[0] = alternative;
      block.receipts = block.usageSources.flatMap(sourceReceipts);
    }
    // A foreign path/hash is rejected before readComparisonUsage can open that source.
    writeFileSync(alternative.transcript.locator, '{unreadable conflicting source}\n');
    expect(() => checkComparisonTemporalSeries(record)).toThrow(
      'series-usage-session-source-conflict',
    );
  },
);

it.each(['cumulative', 'response'] as const)(
  'allows disjoint %s ranges of one pinned transcript across blocks without double counting',
  (format) => {
    const record = primarySeries(format);
    const original = record.preparation.usageSources[0]!;
    const final = original.through;
    const rows = readFileSync(original.transcript.locator, 'utf8').split('\n');
    original.through = {
      locator: original.transcript.locator + '#L2',
      hash: digest(rows[1]! + '\n'),
    };
    record.preparation.receipts = sourceReceipts(original);
    const block = record.attempts[0]!;
    block.participants[0] = original.session;
    block.usageSources[0] = {
      ...original,
      run: block.result.run,
      stage: 'execution',
      after: original.through,
      through: final,
    };
    block.receipts = block.usageSources.flatMap(sourceReceipts);
    expect(checkComparisonTemporalSeries(record)).toMatchObject({
      primaryUsageVerified: true,
      next: { action: 'prepare-run' },
      totals: { responses: 4, input_uncached: 240, input_cached: 60, output: 50 },
    });
  },
);

it('detects primary input changes during parsing and never publishes parser contents', () => {
  const record = primarySeries('cumulative');
  const source = record.preparation.usageSources[0]!;
  const original = fs.readFileSync;
  let reads = 0;
  vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
    const bytes = original(path);
    if (
      typeof path === 'number' &&
      Buffer.isBuffer(bytes) &&
      bytes.includes(Buffer.from(source.session))
    ) {
      reads++;
      if (reads === 2) writeFileSync(source.transcript.locator, String(bytes) + '\n');
    }
    return bytes;
  });
  expect(() => checkComparisonTemporalSeries(record)).toThrow();
  vi.restoreAllMocks();
  const invalid = primarySeries('response');
  const malformed = invalid.preparation.usageSources[0]!;
  writeFileSync(malformed.transcript.locator, '{private native accounting secret}\n');
  malformed.transcript.hash = digest(readFileSync(malformed.transcript.locator));
  const pinned = file('invalid-primary-series.json', JSON.stringify(invalid));
  const result = comparisonReadinessCli(['--series-check', pinned.locator]);
  expect(result).toMatchObject({ exitCode: 1, report: { mayRun: false, allowedModelStarts: 0 } });
  expect(JSON.stringify(result)).not.toContain('private native accounting secret');
});

it('checks the 24 observed runs and accounts every declared participant without allowing execution', () => {
  const record = seriesRecord(24),
    before = snapshot();
  const report = checkComparisonTemporalSeries(record);
  expect(report).toMatchObject({
    status: 'PASS',
    mayRun: false,
    qualification: false,
    allowedModelStarts: 0,
    authorization: null,
    observedRuns: 24,
    observationsComplete: true,
    next: { action: 'review-complete', run: null },
    totals: { responses: 49, input_uncached: 98, input_cached: 147, output: 196, elapsed_ms: 1000 },
  });
  expect(report.canonicalRecordHash).toBe(digest(canonical(record)));
  expect(report.unproven).toContain('primary-stop-evidence');
  expect(snapshot()).toEqual(before);
  const empty = seriesRecord();
  expect(checkComparisonTemporalSeries(empty).next).toEqual({
    action: 'prepare-run',
    run: 'H-01:1:baseline',
  });
  empty.preparation.participants = [];
  empty.preparation.receipts = [];
  expect(checkComparisonTemporalSeries(empty).observedRuns).toBe(0);
});

it('blocks missing metrics, stop and time instead of inferring completion or a new budget', () => {
  for (const stage of ['preparation', 'attempt'] as const) {
    for (const missing of ['metrics', 'stop', 'time', 'clock', 'elapsed'] as const) {
      const record = seriesRecord(stage === 'preparation' ? 0 : 1);
      const block = stage === 'preparation' ? record.preparation : record.attempts[0]!;
      const timing =
        stage === 'preparation' ? record.preparation.timing! : record.attempts[0]!.result.timing!;
      if (missing === 'metrics') block.receipts[0]!.input_cached = null;
      if (missing === 'stop') block.stopConfirmed = false;
      if (missing === 'time') {
        if (stage === 'preparation') record.preparation.timing = null;
        else record.attempts[0]!.result.timing = null;
      }
      if (missing === 'clock') timing.end.clock_id = 'different-clock';
      if (missing === 'elapsed') record.elapsed_ms = 0;
      const report = checkComparisonTemporalSeries(record);
      expect(report.next.action).toBe(
        missing === 'metrics'
          ? 'missing-metrics'
          : missing === 'stop'
            ? 'confirm-stop'
            : 'supply-timing',
      );
      expect(report.observationsComplete).toBe(false);
      expect(report.mayRun).toBe(false);
    }
  }
  const time = seriesRecord(1);
  time.attempts[0]!.result.timing = seriesTime(0, 20);
  expect(checkComparisonTemporalSeries(time).next.action).toBe('supply-timing');
  for (const [elapsed, action] of [
    [25_920_000, 'reserve'],
    [28_800_000, 'limit'],
  ] as const) {
    time.elapsed_ms = elapsed;
    expect(checkComparisonTemporalSeries(time).next.action).toBe(action);
  }
  for (const amount of [540, 600]) {
    const record = seriesRecord();
    record.preparation.receipts[0]!.responses = amount;
    expect(checkComparisonTemporalSeries(record).next.action).toBe(
      amount === 600 ? 'limit' : 'reserve',
    );
  }
});

it('preserves UNKNOWN and accepts only a same-attempt reconciliation with fresh evidence', () => {
  const record = seriesRecord(1);
  record.attempts[0]!.result.outcome = 'unknown';
  expect(checkComparisonTemporalSeries(record).next.action).toBe('unknown-outcome');
  const reconciliation = structuredClone(record.attempts[0]!);
  reconciliation.result.reconciles = 1;
  reconciliation.result.outcome = 'accepted';
  reconciliation.result.evidence = ['new-primary-observation'];
  reconciliation.result.timing!.end = seriesTime(0, 25).end;
  reconciliation.receipts.forEach((receipt) => {
    receipt.id += '-reconciliation';
  });
  record.attempts.push(reconciliation);
  expect(checkComparisonTemporalSeries(record)).toMatchObject({
    observedRuns: 1,
    next: { action: 'prepare-run' },
  });
  reconciliation.result.evidence = ['primary-result-0'];
  expect(() => checkComparisonTemporalSeries(record)).toThrow(
    'series-reconciliation-evidence-reused',
  );
  reconciliation.result.evidence = ['new-primary-observation'];
  reconciliation.result.attempt = 2;
  expect(() => checkComparisonTemporalSeries(record)).toThrow('comparison-invalid-reconciliation');
});

it('stops at known failure, harness error or a false acceptance check without retrying', () => {
  for (const outcome of ['failed', 'harness-error', 'accepted'] as const) {
    const record = seriesRecord(2);
    const later = record.attempts.pop()!;
    record.attempts[0]!.result.outcome = outcome;
    if (outcome === 'accepted') record.attempts[0]!.result.checks['root-cause'] = false;
    expect(checkComparisonTemporalSeries(record).next.action).toBe('review-failure');
    record.attempts.push(later);
    expect(() => checkComparisonTemporalSeries(record)).toThrow('series-order-blocked');
  }
});

it('rejects a start after the time reserve in preparation, a previous run or the gap before launch', () => {
  for (const source of ['preparation', 'previous', 'gap'] as const) {
    const record = seriesRecord(source === 'previous' ? 2 : 1);
    record.elapsed_ms = 26_000_000;
    if (source === 'preparation') {
      record.preparation.timing = seriesTime(0, 25_920_000);
      record.attempts[0]!.result.timing = seriesTime(25_920_000, 25_920_010);
    } else if (source === 'previous') {
      record.attempts[0]!.result.timing = seriesTime(10, 25_920_000);
      record.attempts[1]!.result.timing = seriesTime(25_920_000, 25_920_010);
    } else record.attempts[0]!.result.timing = seriesTime(25_920_000, 25_920_010);
    expect(() => checkComparisonTemporalSeries(record)).toThrow('series-order-blocked');
  }
});

it.each([
  ['schema_version', 2],
  ['kind', 'legacy-series'],
  ['authorization', {}],
  ['allowedModelStarts', 1],
  ['canonicalManifestHash', '0'.repeat(64)],
  ['attempts', null],
  ['elapsed_ms', -1],
  ['extra', true],
  ['preparation.participants', null],
  ['preparation.participants', ['preparer', 'preparer']],
  ['preparation.participants', ['missing']],
  ['preparation.receipts', null],
  ['preparation.stopConfirmed', null],
  ['preparation.receipts', []],
  ['preparation.timing', {}],
])('rejects malformed or unbound series field %s', (path, replacement) => {
  const record = seriesRecord();
  change(record, path, replacement);
  expect(() => checkComparisonTemporalSeries(record)).toThrow();
});

it('rejects skipped, reordered, repeated, unaccounted and unconfirmed observations', () => {
  const mutations: ((record: ReturnType<typeof seriesRecord>) => void)[] = [
    (record) => {
      record.attempts.shift();
    },
    (record) => {
      record.attempts.reverse();
    },
    (record) => {
      record.attempts[1] = structuredClone(record.attempts[0]!);
    },
    (record) => {
      record.attempts[0]!.participants = [];
    },
    (record) => {
      record.attempts[0]!.participants.push('unaccounted');
    },
    (record) => {
      record.attempts[0]!.receipts[0]!.run = null;
    },
    (record) => {
      record.attempts[0]!.result.evidence = null as unknown as string[];
    },
    (record) => {
      record.attempts[0]!.result.reconciles = 1;
    },
    (record) => {
      record.attempts[0]!.result.checks = null as unknown as Record<string, boolean>;
    },
    (record) => {
      record.attempts[0]!.result.outcome = 'unknown';
    },
    (record) => {
      record.attempts[0]!.stopConfirmed = false;
    },
    (record) => {
      record.attempts[0]!.result.timing = null;
    },
    (record) => {
      record.attempts[0]!.receipts[0]!.responses = null;
    },
    (record) => {
      record.attempts[0]!.receipts[0]!.id = 'preparer';
    },
  ];
  for (const mutate of mutations) {
    const record = seriesRecord(2);
    mutate(record);
    expect(() => checkComparisonTemporalSeries(record)).toThrow();
  }
});

it('checks series pins through the read-only CLI and conceals private parse errors', () => {
  const record = seriesRecord(1),
    pinned = file('series-record.json', JSON.stringify(record));
  const before = snapshot();
  expect(comparisonReadinessCli(['--series-check', pinned.locator])).toMatchObject({
    exitCode: 0,
    report: {
      kind: 'temporal-comparison-series-report',
      manifest: pinned,
      mayRun: false,
      observedRuns: 1,
    },
  });
  expect(snapshot()).toEqual(before);
  writeFileSync(pinned.locator, '{private series secret');
  const failure = comparisonReadinessCli(['--series-check', pinned.locator]);
  expect(failure).toMatchObject({
    exitCode: 1,
    report: { kind: 'temporal-comparison-series-report', status: 'FAIL', allowedModelStarts: 0 },
  });
  expect(JSON.stringify(failure)).not.toContain('private series secret');
  const changed = seriesRecord();
  writeFileSync(changed.readiness.locator, '{}');
  expect(() => checkComparisonTemporalSeries(changed)).toThrow('readiness-pin-changed');
  const inputs = seriesRecord();
  writeFileSync(join(root, 'candidate-client'), 'changed since readiness PASS');
  expect(() => checkComparisonTemporalSeries(inputs)).toThrow('readiness-pin-changed');
});

it('checks exact six-case pairs without changing files or borrowing old suite limits', () => {
  const input = manifest(),
    before = snapshot();
  const report = checkComparisonReadiness(input);
  expect(report).toMatchObject({
    status: 'PASS',
    mayRun: false,
    qualification: false,
    allowedModelStarts: 0,
    authorization: null,
  });
  expect(report.canonicalManifestHash).toBe(digest(canonical(input)));
  expect(report.schedule).toHaveLength(24);
  expect(report.schedule.slice(0, 4).map((run) => run.variant)).toEqual([
    'baseline',
    'candidate',
    'candidate',
    'baseline',
  ]);
  expect(report.variants.baseline.profileHash).toBe(report.variants.candidate.profileHash);
  expect(report.variants.baseline.environmentHash).toBe(report.variants.candidate.environmentHash);
  expect(report.variants.baseline.runtime.engine).toBe('legacy');
  expect(report.variants.candidate.runtime.engine).toBe('temporal');
  expect(snapshot()).toEqual(before);
  expect(JSON.stringify(report)).not.toMatch(
    /private rule bytes|declared-model|private hardware declaration|"responses":600|"elapsed_ms":28800000/u,
  );
  expect(report.unproven).toContain('full-game-source');
});

it('emits an intentionally incomplete draft that cannot pass as a prepared series', () => {
  const plan = comparisonReadinessPlan();
  expect(plan).toMatchObject({
    status: 'PLAN',
    mayRun: false,
    qualification: false,
    allowedModelStarts: 0,
  });
  expect(() => checkComparisonReadiness(plan.manifest)).toThrow();
  const input = manifest();
  change(input, 'variants.baseline.sourceRevision', 'a'.repeat(40));
  change(input, 'variants.candidate.sourceRevision', 'a'.repeat(40));
  expect(checkComparisonReadiness(input).variants.baseline.declaredSourceRevision).toBe(
    'a'.repeat(40),
  );
});

it.each([
  ['schema_version', 2],
  ['kind', 'legacy-comparison'],
  ['seriesId', null],
  ['allowedModelStarts', 600],
  ['authorization', { granted: true }],
  ['budget', { responses: 600 }],
  ['variants.candidate.extra', true],
  ['variants.candidate.runtime', null],
  ['variants.candidate.runtime.engine', 'legacy'],
  ['variants.baseline.runtime.engine', 'temporal'],
  ['variants.candidate.runtime.artifact.locator', 'relative'],
  ['variants.candidate.runtime.artifact.locator', '/tmp/../not-canonical'],
  ['variants.candidate.runtime.artifact.hash', 'bad'],
  ['variants.candidate.runtime.artifact.hash', '0'.repeat(64)],
  ['variants.candidate.sourceRevision', 'HEAD'],
  ['variants.candidate.sourceRevision', 'b'.repeat(40)],
  ['variants.candidate.profile.model', 'different-model'],
  ['variants.candidate.profile.effort', null],
  ['variants.candidate.profile.clientVersion', 'unknown'],
  ['variants.candidate.profile.roles', null],
  ['variants.candidate.profile.roles', []],
  ['variants.candidate.profile.roles', ['executor', 'executor']],
  ['variants.candidate.profile.roles', ['executor']],
  ['variants.candidate.environment.os', 'different-os'],
  ['variants.candidate.environment.workerSlots', 0],
  ['variants.candidate.environment.workerSlots', 1.5],
  ['variants.candidate.environment.cachePolicy', 'mixed'],
  ['variants.candidate.environment.sdk', 'TBD'],
  ['variants.candidate.environment.lock', { locator: '/missing', hash: 'a'.repeat(64) }],
  ['order', []],
])('rejects missing, unknown, conflicting or unapproved field %s', (path, value) => {
  const input = manifest();
  change(input, path, value);
  expect(() => checkComparisonReadiness(input)).toThrow();
});

it('rejects re-pinned altered task bytes or criteria and changed context while allowing one artifact for both engines', () => {
  for (const key of ['taskSource', 'criteria']) {
    const input = manifest();
    const candidate = object(object(input.variants).candidate);
    const original = object(candidate[key]);
    const bytes = readFileSync(String(original.locator), 'utf8') + '\n';
    candidate[key] = file('changed-input', bytes);
    expect(() => checkComparisonReadiness(input)).toThrow('readiness-case-inputs-changed');
  }
  const alias = manifest();
  change(
    alias,
    'variants.candidate.runtime.artifact',
    object(object(object(alias.variants).baseline).runtime).artifact,
  );
  expect(checkComparisonReadiness(alias).status).toBe('PASS');
  for (const path of ['profile.rules', 'environment.background']) {
    const input = manifest();
    change(input, `variants.candidate.${path}`, file('changed-context', 'different bytes'));
    expect(() => checkComparisonReadiness(input)).toThrow(/mismatch/u);
  }
  const swapped = manifest();
  const order = swapped.order as unknown[];
  [order[0], order[1]] = [order[1], order[0]];
  expect(() => checkComparisonReadiness(swapped)).toThrow('readiness-order-mismatch');
});

it('refuses linked pins and a source changed after the manifest was pinned', () => {
  const input = manifest();
  const runtime = object(object(object(object(input.variants).candidate).runtime).artifact);
  const originalLocator = String(runtime.locator);
  symlinkSync(originalLocator, join(root, 'linked-runtime'));
  change(input, 'variants.candidate.runtime.artifact.locator', join(root, 'linked-runtime'));
  expect(() => checkComparisonReadiness(input)).toThrow();
  change(input, 'variants.candidate.runtime.artifact.locator', originalLocator);
  writeFileSync(originalLocator, 'changed after pin');
  expect(() => checkComparisonReadiness(input)).toThrow('readiness-pin-changed');
});

it('keeps CLI read-only and its reports free of file contents, including parser errors', () => {
  expect(comparisonReadinessCli(['--plan']).report.status).toBe('PLAN');
  const input = file('manifest.json', JSON.stringify(manifest()));
  const result = comparisonReadinessCli(['--check', input.locator]);
  expect(result.exitCode).toBe(0);
  expect(result.report).toMatchObject({ manifest: input, status: 'PASS', mayRun: false });
  const invalid = file('invalid.json', '{"private secret input"');
  for (const args of [
    [],
    ['--run'],
    ['--other'],
    ['--check'],
    ['--check', 'relative'],
    ['--check', '/tmp/../bad'],
    ['--check', '/missing'],
    ['--check', invalid.locator],
    ['--check', input.locator, 'extra'],
    ['--other', input.locator],
  ]) {
    const response = comparisonReadinessCli(args);
    expect(response).toMatchObject({
      exitCode: 1,
      report: {
        status: 'FAIL',
        mayRun: false,
        qualification: false,
        allowedModelStarts: 0,
        authorization: null,
      },
    });
    expect(JSON.stringify(response)).not.toContain('private secret input');
  }
});

it('dispatches only its explicit command entry point', async () => {
  const argv = process.argv,
    previousExit = process.exitCode;
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.argv = [
      'node',
      fileURLToPath(new URL('./comparisonReadiness.ts', import.meta.url)),
      '--plan',
    ];
    vi.resetModules();
    await import('./comparisonReadiness.js');
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
      status: 'PLAN',
      mayRun: false,
    });
  } finally {
    process.argv = argv;
    process.exitCode = previousExit;
  }
});

it('checks all physical source bytes through the existing CLI without changing schema1 or its default draft', () => {
  const f = sourceManifest();
  const before = readdirSync(root, { recursive: true });
  const pinned = file('schema2.json', JSON.stringify(f.input));
  const report = comparisonReadinessCli(['--check', pinned.locator]);
  expect(report.exitCode).toBe(0);
  expect(report.report).toMatchObject({
    schema_version: 2,
    status: 'PASS',
    mayRun: false,
    qualification: false,
    allowedModelStarts: 0,
    authorization: null,
    sourceSnapshot: {
      inventory: f.inventory,
      roots: f.roots,
      treeHash: digest(canonical(f.entries)),
      observedEquality: true,
    },
  });
  expect(readdirSync(root, { recursive: true }).filter((name) => name !== 'schema2.json')).toEqual(
    before,
  );
  expect(JSON.stringify(report)).not.toContain('physical source');
  expect(report.report).toHaveProperty(
    'unproven',
    expect.arrayContaining(['full-game-source', 'git-revision', 'future-isolated-copies']),
  );
  expect(comparisonReadinessPlan().manifest).not.toHaveProperty('sourceSnapshot');
  expect(checkComparisonReadiness(manifest())).not.toHaveProperty('sourceSnapshot');
  f.input.schema_version = 1;
  expect(() => checkComparisonReadiness(f.input)).toThrow('readiness-fields-invalid');
});

it.each(['source', 'baseline', 'candidate'] as const)(
  'rejects missing, extra, modified bytes and modes in the actual %s tree',
  (name) => {
    const f = sourceManifest(),
      directory = f.roots[name],
      path = join(directory, 'input.txt');
    for (const mutate of [
      () => rmSync(path),
      () => writeFileSync(join(directory, 'extra.txt'), 'extra'),
      () => writeFileSync(path, 'altered source'),
      () => chmodSync(path, 0o400),
    ]) {
      mutate();
      expect(() => checkComparisonReadiness(f.input)).toThrow();
      rmSync(join(directory, 'extra.txt'), { force: true });
      if (fs.existsSync(path)) chmodSync(path, 0o600);
      writeFileSync(path, 'physical source\n');
      chmodSync(path, 0o600);
    }
  },
);

it.each([
  'missing',
  'extra',
  'duplicate',
  'traversal',
  'absolute',
  'unknown-field',
  'symlink',
  'special',
  'not-array',
  'null-row',
] as const)('rejects a re-pinned %s inventory rather than trusting its declaration', (defect) => {
  const f = sourceManifest();
  const rows: unknown[] = [...f.entries];
  if (defect === 'missing') rows.pop();
  if (defect === 'extra') rows.push({ ...f.entries[1], path: 'extra.txt' });
  if (defect === 'duplicate') rows.push(rows[1]);
  if (defect === 'traversal') rows[1] = { ...f.entries[1], path: '../input.txt' };
  if (defect === 'absolute') rows[1] = { ...f.entries[1], path: '/input.txt' };
  if (defect === 'unknown-field') rows[1] = { ...f.entries[1], complete: true };
  if (defect === 'symlink' || defect === 'special') rows[1] = { ...f.entries[1], kind: defect };
  if (defect === 'null-row') rows[1] = null;
  change(
    f.input,
    'sourceSnapshot.inventory',
    file('repinned-inventory', JSON.stringify(defect === 'not-array' ? {} : rows)),
  );
  expect(() => checkComparisonReadiness(f.input)).toThrow();
});

it('requires a real file and refuses links and aliases in the whole provided namespace', () => {
  const f = sourceManifest(),
    path = join(f.roots.candidate, 'input.txt');
  rmSync(path);
  symlinkSync(join(f.roots.source, 'input.txt'), path);
  expect(() => checkComparisonReadiness(f.input)).toThrow('readiness-source-file-unsafe');
  rmSync(path);
  linkSync(join(f.roots.source, 'input.txt'), path);
  expect(() => checkComparisonReadiness(f.input)).toThrow('readiness-source-file-linked');
  rmSync(path);
  writeFileSync(path, 'physical source\n', { mode: 0o600 });
  rmSync(join(f.roots.candidate, 'scripts'), { recursive: true });
  symlinkSync(join(f.roots.source, 'scripts'), join(f.roots.candidate, 'scripts'));
  expect(() => checkComparisonReadiness(f.input)).toThrow();
  for (const directory of Object.values(f.roots)) {
    rmSync(directory, { recursive: true });
    mkdirSync(directory, { mode: 0o700 });
  }
  change(
    f.input,
    'sourceSnapshot.inventory',
    file('empty-inventory', JSON.stringify([{ path: '', kind: 'directory', mode: 0o700 }])),
  );
  expect(() => checkComparisonReadiness(f.input)).toThrow('readiness-source-empty');
});

it.each([
  'relative',
  'noncanonical',
  'filesystem-root',
  'same',
  'nested',
  'root-link',
  'parent-link',
  'pin-inside',
  'pin-root',
  'pin-relative',
  'pin-hash',
  'pin-changed',
  'pin-link',
  'unknown-root',
  'missing-source',
  'schema3',
] as const)('refuses the %s source binding before claiming equality', (defect) => {
  const f = sourceManifest();
  if (defect === 'relative') change(f.input, 'sourceSnapshot.roots.source', 'relative');
  if (defect === 'noncanonical')
    change(f.input, 'sourceSnapshot.roots.source', root + '/source/../source');
  if (defect === 'filesystem-root') change(f.input, 'sourceSnapshot.roots.source', '/');
  if (defect === 'same') change(f.input, 'sourceSnapshot.roots.candidate', f.roots.source);
  if (defect === 'nested')
    change(f.input, 'sourceSnapshot.roots.candidate', join(f.roots.source, 'scripts'));
  if (defect === 'root-link' || defect === 'parent-link') {
    symlinkSync(f.roots.source, join(root, 'alias'));
    change(
      f.input,
      'sourceSnapshot.roots.source',
      join(root, 'alias', ...(defect === 'parent-link' ? ['scripts'] : [])),
    );
  }
  if (defect === 'pin-inside')
    change(f.input, 'sourceSnapshot.inventory', {
      locator: join(f.roots.source, 'input.txt'),
      hash: digest('physical source\n'),
    });
  if (defect === 'pin-root')
    change(f.input, 'sourceSnapshot.inventory', { locator: f.roots.source, hash: 'a'.repeat(64) });
  if (defect === 'pin-relative') change(f.input, 'sourceSnapshot.inventory.locator', 'relative');
  if (defect === 'pin-hash') change(f.input, 'sourceSnapshot.inventory.hash', 'bad');
  if (defect === 'pin-changed') writeFileSync(f.inventory.locator, '[]');
  if (defect === 'pin-link') {
    symlinkSync(f.inventory.locator, join(root, 'inventory-alias'));
    change(f.input, 'sourceSnapshot.inventory.locator', join(root, 'inventory-alias'));
  }
  if (defect === 'unknown-root') change(f.input, 'sourceSnapshot.roots.extra', f.roots.source);
  if (defect === 'missing-source') delete f.input.sourceSnapshot;
  if (defect === 'schema3') f.input.schema_version = 3;
  expect(() => checkComparisonReadiness(f.input)).toThrow();
});

it('hashes physical file-location pointer bytes without resolving outside contents', () => {
  const f = sourceManifest();
  const locationRoot = join(root, 'physical-location');
  mkdirSync(locationRoot);
  for (const name of ['source', 'baseline', 'candidate'] as const) {
    const destination = join(locationRoot, name);
    renameSync(f.roots[name], destination);
    f.roots[name] = destination;
  }
  const external = 'external resolved bytes',
    hash = digest(external);
  const pointer = 'AWLOCATION1\n' + hash + '\n';
  const directory = join(root, 'archives', canonicalHash(locationRoot));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, hash), external);
  writeFileSync(
    join(locationRoot, '.workflow-files.json'),
    JSON.stringify({
      schema_version: 1,
      root: locationRoot,
      operation_hash: 'b'.repeat(64),
      complete: true,
      files: Object.fromEntries(
        ['source', 'baseline', 'candidate'].map((name) => [
          name + '/input.txt',
          { hash, bytes: Buffer.byteLength(external), mode: 0o600, kind: 'archive' },
        ]),
      ),
    }),
  );
  for (const directory of Object.values(f.roots))
    writeFileSync(join(directory, 'input.txt'), pointer);
  expect(readPrivateFile(join(f.roots.source, 'input.txt')).toString()).toBe(external);
  f.entries[1] = {
    path: 'input.txt',
    mode: 0o600,
    kind: 'file',
    sha256: digest(pointer),
    bytes: Buffer.byteLength(pointer),
  };
  change(f.input, 'sourceSnapshot.inventory', file('pointer-inventory', JSON.stringify(f.entries)));
  expect(checkComparisonReadiness(f.input).status).toBe('PASS');
  f.entries[1] = { ...f.entries[1], sha256: digest('external resolved bytes') };
  change(
    f.input,
    'sourceSnapshot.inventory',
    file('resolved-inventory', JSON.stringify(f.entries)),
  );
  expect(() => checkComparisonReadiness(f.input)).toThrow('readiness-source-tree-mismatch');
});

it('refuses distinct root paths whose observed device/inode identify the same directory', () => {
  const f = sourceManifest();
  const stat = fs.lstatSync(f.roots.source),
    original = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation((path) =>
    path === f.roots.candidate ? stat : original(path),
  );
  expect(() => checkComparisonReadiness(f.input)).toThrow('readiness-source-roots-alias');
});

it.each([
  'before-read-fd',
  'before-read-path',
  'short-read',
  'after-read-fd',
  'after-read-path',
  'directory',
  'namespace',
  'second-tree',
  'root-replaced',
  'inventory',
] as const)('refuses a %s race and closes every opened physical descriptor', (race) => {
  const f = sourceManifest(),
    target = join(f.roots.source, 'input.txt');
  const nativeOpen = fs.openSync,
    nativeRead = fs.readFileSync,
    nativeStat = fs.fstatSync,
    nativePathStat = fs.lstatSync;
  const descriptors = new Set<number>();
  let fd = -1,
    reads = 0,
    stats = 0,
    changed = false;
  const directoryBefore = nativePathStat(f.roots.source);
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    const result = nativeOpen(path, flags, mode);
    descriptors.add(result);
    if (path === target) {
      fd = result;
      if (race === 'before-read-path') {
        renameSync(target, target + '.old');
        writeFileSync(target, 'substituted source');
      }
    }
    return result;
  });
  const nativeClose = fs.closeSync;
  vi.spyOn(fs, 'closeSync').mockImplementation((value) => {
    descriptors.delete(value);
    return nativeClose(value);
  });
  vi.spyOn(fs, 'fstatSync').mockImplementation((value) => {
    const stat = nativeStat(value);
    if (value === fd) {
      stats++;
      if ((race === 'before-read-fd' && stats === 1) || (race === 'after-read-fd' && stats === 2))
        stat.ino++;
      if (race === 'after-read-path' && stats === 2) {
        renameSync(target, target + '.old');
        writeFileSync(target, 'replaced after read');
      }
    }
    return stat;
  });
  vi.spyOn(fs, 'lstatSync').mockImplementation((path) => {
    const stat = nativePathStat(path);
    if (race === 'namespace' && path === f.roots.source) return directoryBefore;
    return stat;
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
    if (path === fd) {
      reads++;
      if (race === 'short-read') writeFileSync(target, '');
    }
    const bytes = nativeRead(path);
    if (path === fd && (race === 'directory' || race === 'namespace'))
      writeFileSync(join(f.roots.source, 'new-entry'), 'extra');
    // The candidate's last file is read only after the source tree was captured.
    if (
      !changed &&
      typeof path === 'number' &&
      Buffer.isBuffer(bytes) &&
      bytes.equals(Buffer.from([0, 255, 13]))
    ) {
      const candidateBytes = nativeRead(join(f.roots.candidate, 'scripts/main.bin'));
      if (bytes.equals(candidateBytes)) {
        // Count the same binary content across source, baseline, then candidate.
        binaryReads++;
        if (binaryReads === 3) {
          changed = true;
          if (race === 'second-tree')
            writeFileSync(target, 'changed between complete observations');
          if (race === 'root-replaced') {
            renameSync(f.roots.source, f.roots.source + '.old');
            cpSync(f.roots.source + '.old', f.roots.source, { recursive: true });
          }
          if (race === 'inventory') writeFileSync(f.inventory.locator, '[]');
        }
      }
    }
    return bytes;
  });
  let binaryReads = 0;
  expect(() => checkComparisonReadiness(f.input)).toThrow();
  expect(descriptors.size).toBe(0);
  if (race === 'before-read-fd' || race === 'before-read-path') expect(reads).toBe(0);
});

function h01SeriesFixture(version: 1 | 2 | 3 = 1) {
  const source = sourceManifest(),
    readiness = source.input;
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(runtimeRoot);
  mkdirSync(join(runtimeRoot, 'tests'));
  const pin = (name: string, value: unknown): InputRef => {
    const locator = join(runtimeRoot, name),
      bytes = canonical(value);
    writeFileSync(locator, bytes);
    return { locator, hash: digest(bytes) };
  };
  const refresh = (ref: InputRef, value: unknown): InputRef => {
    const bytes = canonical(value);
    writeFileSync(ref.locator, bytes);
    return { locator: ref.locator, hash: digest(bytes) };
  };
  const entrypoint = pin('tests/comparisonH01.ts', 'never executed source');
  const entrypoints = {
    'H-01': entrypoint,
    'H-02': version >= 2 ? pin('tests/comparisonH02Native.ts', 'never executed H02 source') : null,
    'H-03': version === 3 ? pin('tests/comparisonH03Native.ts', 'never executed H03 source') : null,
  };
  const commonFiles = Object.values(entrypoints).filter((ref): ref is InputRef => ref !== null),
    node = pin('node', 'never executed node');
  const binary = pin('codex', 'never executed client'),
    rules = pin('rules', 'immutable rules'),
    executor = pin('executor', 'same executor'),
    reviewer = pin('reviewer', 'same reviewer');
  const profile = pin('profile.json', {
    model: 'declared-model',
    effort: 'declared-effort',
    clientVersion: 'declared-client-version',
    binary,
    rules,
    executor,
    reviewer,
  });
  const suite = JSON.parse(
    readFileSync(new URL('../comparison/suite.json', import.meta.url), 'utf8'),
  ) as { scenarios: Record<string, unknown>[] };
  const materials = JSON.parse(
    readFileSync(new URL('../comparison/materials.json', import.meta.url), 'utf8'),
  ) as { cases: unknown[] };
  const material = pin('material.json', materials.cases[0]),
    criteria = pin('criteria.json', { ...suite.scenarios[0], id: 'H-01' });
  const budget = {
    maxElapsedMs: 1000,
    reserveMs: 100,
    maxManagedStarts: 10,
    maxInputUncached: 100,
    maxOutput: 50,
  };
  const readinessVariants = object(readiness.variants);
  for (const variant of ['baseline', 'candidate']) {
    const declared = object(readinessVariants[variant]);
    Object.assign(object(declared.profile), { client: binary, rules });
    const common = pin(variant + '-common.json', {
      engine: variant === 'baseline' ? 'legacy' : 'temporal',
      root: runtimeRoot,
      files: commonFiles,
    });
    declared.runtime = { engine: variant === 'baseline' ? 'legacy' : 'temporal', artifact: common };
  }
  const slots = checkComparisonReadiness(readiness).schedule.filter(
    (run) =>
      run.scenario === 'H-01' ||
      (version >= 2 && run.scenario === 'H-02') ||
      (version === 3 && run.scenario === 'H-03'),
  );
  const drafts: H01ExecutionRequest[] = [],
    specs: Record<string, unknown>[] = [];
  const steps = slots.map((slot, index) => {
    const base = join(root, 'run-' + index),
      variant = slot.variant,
      label = slot.scenario.replace('-', '').toLowerCase() as 'h01' | 'h02' | 'h03',
      scenarioIndex = Number(slot.scenario.slice(-2)) - 1;
    const roots = {
      workspaceRoot: join(base, 'writer', 'workspace'),
      stateRoot: join(base, 'state'),
      evidenceRoot: join(base, 'evidence'),
      artifactRoot: join(base, 'artifacts'),
      hostRoot: join(base, 'host'),
    };
    const spec = {
      kind: `comparison-${label}-operator`,
      schemaVersion: 1,
      opId: 'op-' + index,
      variant,
      budget,
      roots,
      evidenceRoot: join(base, 'operator'),
      node,
      entrypoint: entrypoints[slot.scenario as keyof typeof entrypoints]!,
      runtimeRoot,
      ...(variant === 'candidate'
        ? {
            temporal: {
              binary: node,
              address: '127.0.0.1:7233',
              httpAddress: '127.0.0.1:8233',
              metricsAddress: '127.0.0.1:9233',
              namespace: 'default',
              taskQueue: 'queue-' + index,
              workflowsPath: entrypoint.locator,
              sqlitePath: join(base, 'operator', 'temporal.sqlite'),
            },
          }
        : {}),
    };
    specs.push(spec);
    const specRef = pin('spec-' + index + '.json', spec);
    const runtime = pin('runtime-' + index + '.json', {
      engine: variant === 'baseline' ? 'legacy' : 'temporal',
      root: runtimeRoot,
      files: [...commonFiles, specRef],
    });
    const bootstrap = pin(
      'bootstrap-' + index + '.json',
      variant === 'baseline'
        ? {
            engine: 'legacy',
            runtimeRoot: join(base, 'state', 'legacy-runtime'),
            modulesRoot: runtimeRoot,
            overlay: rules,
          }
        : {
            engine: 'temporal',
            address: '127.0.0.1:7233',
            namespace: 'default',
            taskQueue: 'queue-' + index,
            workflowsPath: entrypoint.locator,
            issuer: { sessionsRoot: root, workspaceRoot: root, threadId: 'parent', owner: 'owner' },
          },
    );
    const draft: H01ExecutionRequest = {
      kind: `comparison-${label}-execution`,
      executionVersion: 2,
      opId: 'op-' + index,
      variant,
      material:
        slot.scenario === 'H-01'
          ? material
          : pin(label + '-material-' + index + '.json', materials.cases[scenarioIndex]),
      criteria:
        slot.scenario === 'H-01'
          ? criteria
          : pin(label + '-criteria-' + index + '.json', suite.scenarios[scenarioIndex]),
      profile,
      runtime,
      bootstrap,
      roots,
      identity: { taskId: 'task-' + index, owner: 'owner', generation: 1 },
      budget,
      authorization: {
        root,
        transcript: join(root, 'transcript'),
        anchor: { thread_id: 'parent', turn_id: '', workspace: root, host_id: 'local' },
        source: { locator: '', hash: '' },
        requestHash: '',
      },
    };
    drafts.push(draft);
    return { runId: slot.id, spec: specRef, request: pin('draft-' + index + '.json', draft) };
  });
  const startedAtMs = Date.now() - 100;
  const manifest = {
    kind: 'comparison-h01-series',
    schemaVersion: version,
    readiness: pin('readiness.json', readiness),
    outputRoot: join(root, 'series'),
    startedAtMs,
    cap: {
      maxElapsedMs: 100_000,
      reserveMs: 1000,
      maxManagedStarts: 40 * version,
      maxInputUncached: 400 * version,
      maxOutput: 200 * version,
    },
    steps,
  };
  let manifestRef = pin('manifest.json', manifest),
    commands = 0;
  const command = (
    index = 0,
    previousState: InputRef | null = null,
    overrides: Record<string, unknown> = {},
  ) => {
    const actual = structuredClone(drafts[index]!);
    actual.authorization.anchor.turn_id = 'grant-' + index;
    actual.authorization.source = {
      locator: actual.authorization.transcript + '#L1',
      hash: 'a'.repeat(64),
    };
    actual.authorization.requestHash = h01RequestHash(actual);
    const request = pin('sealed-' + index + '.json', actual);
    return pin('command-' + commands++ + '.json', {
      kind: 'comparison-h01-series-step',
      schemaVersion: version,
      manifest: manifestRef,
      runId: steps[index]!.runId,
      request,
      previousState,
      ...overrides,
    });
  };
  const primary = {
    outcome: 'accepted',
    stopped: true,
    accounting: {
      reservedManagedStarts: 2,
      observedResponses: 2,
      inputUncached: 3,
      inputCached: 4,
      output: 5,
      unknown: false,
    },
    blocking: [] as string[],
  };
  h01Series.plan.mockReset();
  h01Series.runtime.mockReset().mockResolvedValue({});
  h01Series.run.mockReset();
  h01Series.evidence.mockReset();
  h01Series.evidence.mockImplementation(
    ({ runId, opId, operator }: { runId: string; opId: string; operator: unknown }) => {
      const result = object(h01ReadJson(object(operator).report as InputRef));
      return {
        ...result,
        checks: { 'all-required': true },
        attempt: null,
        evidence: [object(operator).report],
        mapping: { runId, opId },
        partialScope: true,
        qualification: false,
      };
    },
  );
  h01Series.run.mockImplementation(async (_spec: InputRef, request: InputRef) => {
    const actual = h01ReadJson(request) as H01ExecutionRequest;
    expect(
      object(JSON.parse(readFileSync(join(manifest.outputRoot, 'state.json'), 'utf8'))).pending,
    ).toMatchObject({ opId: actual.opId, requestHash: h01RequestHash(actual) });
    expect(fs.existsSync(join(manifest.outputRoot, 'pending.json'))).toBe(true);
    const report = pin('result-' + actual.opId + '.json', primary);
    return { report };
  });
  return {
    source,
    readiness,
    runtimeRoot,
    pin,
    refresh,
    manifest,
    steps,
    specs,
    drafts,
    primary,
    command,
    get manifestRef() {
      return manifestRef;
    },
    save() {
      manifestRef = refresh(manifestRef, manifest);
      return manifestRef;
    },
    statePath: join(manifest.outputRoot, 'state.json'),
  };
}

it('plans the fixed 24-slot series and delegates only four H01 slots without issuing authority', async () => {
  const f = h01SeriesFixture(),
    plan = await planH01Series(f.manifestRef);
  expect(plan.schedule).toHaveLength(24);
  expect(plan.executable).toHaveLength(4);
  expect(plan).toMatchObject({
    partialScope: true,
    qualification: false,
    mayRun: false,
    allowedModelStarts: 0,
  });
  expect(h01Series.plan).toHaveBeenCalledTimes(4);
  expect(h01Series.run).not.toHaveBeenCalled();
  expect(fs.existsSync(f.manifest.outputRoot)).toBe(false);
});
it('runs four independent H01 operators in order, persists pending first and refuses the next adapter', async () => {
  const f = h01SeriesFixture();
  let previous: InputRef | null = null;
  for (let i = 0; i < 4; i++) {
    const command = f.command(i, previous),
      result = await stepH01Series(command);
    expect(result.records).toHaveLength(i + 1);
    expect(result.qualification).toBe(false);
    previous = result.state;
    const calls = h01Series.run.mock.calls.length;
    expect((await stepH01Series(command)).records).toHaveLength(i + 1);
    expect(h01Series.run).toHaveBeenCalledTimes(calls);
  }
  expect(statusH01Series(f.statePath)).toMatchObject({
    status: 'adapter-required',
    next: 'H-02:1:baseline',
    partialScope: true,
    qualification: false,
  });
  expect(h01Series.run).toHaveBeenCalledTimes(4);
  expect(fs.existsSync(join(f.manifest.outputRoot, 'writer'))).toBe(false);
});
it.each(['failed', 'unknown', 'stop', 'metrics', 'null-metrics', 'checks', 'overrun'] as const)(
  'halts after %s while preserving primary costs and exact replay',
  async (mode) => {
    const f = h01SeriesFixture();
    if (mode === 'failed' || mode === 'unknown') f.primary.outcome = mode;
    if (mode === 'stop') f.primary.stopped = false;
    if (mode === 'metrics') f.primary.accounting.unknown = true;
    if (mode === 'null-metrics')
      Object.assign(f.primary.accounting, {
        inputCached: null,
        inputUncached: null,
        unknown: false,
      });
    if (mode === 'checks') f.primary.blocking = ['missing-check'];
    if (mode === 'overrun') f.primary.accounting.inputUncached = 401;
    const command = f.command(),
      result = await stepH01Series(command);
    expect(result.status).toBe('blocked');
    expect(result.records[0]!.evidence.accounting.reservedManagedStarts).toBe(2);
    expect((await stepH01Series(command)).records).toEqual(result.records);
    await expect(stepH01Series(f.command(1, result.state))).rejects.toThrow('series-step-blocked');
    expect(h01Series.run).toHaveBeenCalledTimes(1);
  },
);
it.each(['throw', 'normalizer', 'save', 'save-sync'] as const)(
  'keeps the durable pending fence after %s and never retries',
  async (mode) => {
    const f = h01SeriesFixture(),
      command = f.command();
    if (mode === 'throw') h01Series.run.mockRejectedValueOnce(new Error('operator unknown'));
    if (mode === 'normalizer')
      h01Series.evidence.mockImplementationOnce(() => {
        throw new Error('unreadable evidence');
      });
    if (mode === 'save') {
      const rename = fs.renameSync;
      let calls = 0;
      vi.spyOn(fs, 'renameSync').mockImplementation((...args: Parameters<typeof fs.renameSync>) => {
        if (++calls === 2) throw new Error('final save denied');
        return rename(...args);
      });
    }
    if (mode === 'save-sync') {
      const rename = fs.renameSync,
        fsync = fs.fsyncSync;
      let calls = 0,
        failed = false;
      vi.spyOn(fs, 'renameSync').mockImplementation((...args: Parameters<typeof fs.renameSync>) => {
        calls++;
        return rename(...args);
      });
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (calls === 2 && !failed && fs.fstatSync(fd).isDirectory()) {
          failed = true;
          throw new Error('final sync denied');
        }
        return fsync(fd);
      });
    }
    await expect(stepH01Series(command)).rejects.toThrow();
    expect(statusH01Series(f.statePath)).toMatchObject({ status: 'pending', next: null });
    if (mode === 'throw') {
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const exitCode = process.exitCode;
      try {
        await h01SeriesMain(['--status', f.statePath]);
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = exitCode;
      }
    }
    await expect(stepH01Series(command)).rejects.toThrow('series-step-pending');
    expect(h01Series.run).toHaveBeenCalledTimes(1);
  },
);
it('rejects a concurrent writer while the sole operator is outstanding', async () => {
  const f = h01SeriesFixture(),
    command = f.command(),
    original = h01Series.run.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  h01Series.run.mockImplementationOnce(async (...args: unknown[]) => {
    ready();
    await gate;
    return original(...args) as unknown;
  });
  const first = stepH01Series(command);
  await started;
  await expect(stepH01Series(command)).rejects.toThrow('EEXIST');
  release();
  await first;
  expect(h01Series.run).toHaveBeenCalledTimes(1);
});
it.each([
  'summary',
  'repinned-summary',
  'record-order',
  'rewind',
  'primary',
  'manifest',
  'command',
  'previous',
] as const)('rejects forged %s even with a newly pinned prior state', async (mode) => {
  const f = h01SeriesFixture(),
    firstCommand = f.command();
  await stepH01Series(firstCommand);
  const state = JSON.parse(readFileSync(f.statePath, 'utf8')) as {
    records: Record<string, unknown>[];
  };
  if (mode === 'summary')
    object(state.records[0]!.evidence).accounting = { reservedManagedStarts: 0 };
  if (mode === 'repinned-summary') {
    object(object(state.records[0]!.evidence).accounting).inputUncached = 0;
    writeFileSync(join(f.manifest.outputRoot, 'record-0.json'), canonical(state.records[0]));
  }
  if (mode === 'record-order') state.records[0]!.opId = 'other';
  if (mode === 'rewind') state.records = [];
  if (mode === 'primary')
    f.refresh(object(state.records[0]!.operator).report as InputRef, {
      ...f.primary,
      outcome: 'failed',
    });
  if (mode === 'manifest') f.manifest.startedAtMs--;
  if (mode === 'command') {
    const fresh = f.command();
    await expect(stepH01Series(fresh)).rejects.toThrow('series-step-replay-conflict');
    return;
  }
  if (mode === 'previous') {
    await expect(stepH01Series(f.command(1, null))).rejects.toThrow('series-step-previous-state');
    return;
  }
  if (mode === 'manifest') f.save();
  writeFileSync(f.statePath, canonical(state));
  const previous = { locator: f.statePath, hash: digest(readFileSync(f.statePath)) };
  await expect(stepH01Series(f.command(1, previous))).rejects.toThrow();
  expect(h01Series.run).toHaveBeenCalledTimes(1);
});
it.each(['manifest', 'state', 'root', 'lock', 'request', 'source-tree'] as const)(
  'refuses %s replacement during asynchronous preparation before any operator',
  async (mode) => {
    const f = h01SeriesFixture(),
      command = f.command();
    h01Series.runtime.mockImplementationOnce(async () => {
      if (mode === 'manifest') writeFileSync(f.manifestRef.locator, '{}');
      if (mode === 'state') writeFileSync(f.statePath, '{}');
      if (mode === 'root') {
        renameSync(f.manifest.outputRoot, f.manifest.outputRoot + '.old');
        mkdirSync(f.manifest.outputRoot);
        mkdirSync(join(f.manifest.outputRoot, 'writer'));
      }
      if (mode === 'lock') {
        renameSync(
          join(f.manifest.outputRoot, 'writer'),
          join(f.manifest.outputRoot, 'old-writer'),
        );
        mkdirSync(join(f.manifest.outputRoot, 'writer'));
      }
      if (mode === 'request')
        writeFileSync((h01ReadJson(command) as { request: InputRef }).request.locator, '{}');
      if (mode === 'source-tree')
        writeFileSync(join(f.source.roots.baseline, 'extra'), 'unexpected source');
    });
    await expect(stepH01Series(command)).rejects.toThrow();
    expect(h01Series.run).not.toHaveBeenCalled();
  },
);
it.each(['before', 'after', 'rollback'] as const)(
  'includes preparation and refuses elapsed budget %s the await',
  async (mode) => {
    const f = h01SeriesFixture(),
      start = Date.now();
    if (mode === 'before') f.manifest.startedAtMs = start - 100_000;
    f.save();
    if (mode === 'after')
      h01Series.runtime.mockImplementationOnce(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(start + 100_000);
      });
    if (mode === 'rollback')
      h01Series.runtime.mockImplementationOnce(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(start - 200);
      });
    await expect(stepH01Series(f.command())).rejects.toThrow();
    expect(h01Series.run).not.toHaveBeenCalled();
  },
);
it('does not reduce a pinned per-step grant to fit a spent aggregate cap', async () => {
  const f = h01SeriesFixture();
  f.primary.accounting.inputUncached = 399;
  const first = await stepH01Series(f.command());
  await expect(stepH01Series(f.command(1, first.state))).rejects.toThrow('series-step-budget-cap');
  expect(h01Series.run).toHaveBeenCalledTimes(1);
});
it.each([
  'version',
  'readiness',
  'order',
  'duplicate-op',
  'profile',
  'role-profile',
  'runtime',
  'roots',
  'snapshot-run',
  'output',
  'cap',
  'reserve',
  'clock',
  'request',
] as const)('rejects invalid %s before creating series output', async (mode) => {
  const f = h01SeriesFixture();
  if (mode === 'version') f.manifest.schemaVersion = 2;
  if (mode === 'readiness') {
    f.readiness.schema_version = 1;
    delete f.readiness.sourceSnapshot;
    f.manifest.readiness = f.refresh(f.manifest.readiness, f.readiness);
  }
  if (mode === 'order') f.manifest.steps.reverse();
  if (mode === 'duplicate-op') {
    f.drafts[1]!.opId = f.drafts[0]!.opId;
    f.specs[1]!.opId = f.drafts[0]!.opId;
    f.steps[1]!.spec = f.refresh(f.steps[1]!.spec, f.specs[1]);
    f.steps[1]!.request = f.refresh(f.steps[1]!.request, f.drafts[1]);
  }
  if (mode === 'profile') {
    const profile = object(h01ReadJson(f.drafts[0]!.profile));
    profile.model = 'different';
    f.drafts[0]!.profile = f.pin('changed-profile.json', profile);
    f.steps[0]!.request = f.refresh(f.steps[0]!.request, f.drafts[0]);
  }
  if (mode === 'role-profile') {
    const profile = object(h01ReadJson(f.drafts[0]!.profile));
    profile.executor = f.pin('other-role', 'different role');
    f.drafts[0]!.profile = f.pin('changed-profile.json', profile);
    f.steps[0]!.request = f.refresh(f.steps[0]!.request, f.drafts[0]);
  }
  if (mode === 'runtime') {
    const runtime = object(h01ReadJson(f.drafts[0]!.runtime));
    runtime.files = [...(runtime.files as InputRef[]), f.pin('extra-source', 'extra')];
    f.drafts[0]!.runtime = f.refresh(f.drafts[0]!.runtime, runtime);
    f.steps[0]!.request = f.refresh(f.steps[0]!.request, f.drafts[0]);
  }
  if (mode === 'roots') {
    const base = join(root, 'run-0');
    f.specs[1]!.evidenceRoot = join(base, 'operator-2');
    f.steps[1]!.spec = f.refresh(f.steps[1]!.spec, f.specs[1]);
  }
  if (mode === 'snapshot-run') {
    const base = join(f.source.roots.baseline, 'new-run');
    const roots = {
      workspaceRoot: join(base, 'writer', 'workspace'),
      stateRoot: join(base, 'state'),
      evidenceRoot: join(base, 'evidence'),
      artifactRoot: join(base, 'artifacts'),
      hostRoot: join(base, 'host'),
    };
    Object.assign(f.specs[0]!, { roots, evidenceRoot: join(base, 'operator') });
    f.steps[0]!.spec = f.refresh(f.steps[0]!.spec, f.specs[0]);
    const runtime = object(h01ReadJson(f.drafts[0]!.runtime));
    runtime.files = [...(runtime.files as InputRef[]).slice(0, 1), f.steps[0]!.spec];
    f.drafts[0]!.runtime = f.refresh(f.drafts[0]!.runtime, runtime);
    f.drafts[0]!.roots = roots;
    f.steps[0]!.request = f.refresh(f.steps[0]!.request, f.drafts[0]);
  }
  if (mode === 'output') f.manifest.outputRoot = f.runtimeRoot;
  if (mode === 'cap') f.manifest.cap.maxManagedStarts = 1;
  if (mode === 'reserve') f.manifest.cap.reserveMs = f.manifest.cap.maxElapsedMs;
  if (mode === 'clock') f.manifest.startedAtMs = Date.now() + 100_000;
  if (mode === 'request') f.manifest.steps[0]!.runId = 'H-05:1:baseline';
  f.save();
  await expect(planH01Series(f.manifestRef)).rejects.toThrow();
  expect(h01Series.run).not.toHaveBeenCalled();
});
it('keeps the three CLI modes bounded, removes signal listeners and reports pending failure', async () => {
  const f = h01SeriesFixture(),
    stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true),
    before = process.listeners('SIGINT').length;
  const exitCode = process.exitCode;
  try {
    h01Series.runtime.mockImplementationOnce(async () => {
      process.emit('SIGINT');
    });
    await h01SeriesMain(['--plan', f.manifestRef.locator]);
    f.primary.outcome = 'failed';
    const command = f.command();
    await h01SeriesMain(['--step', command.locator]);
    await h01SeriesMain(['--status', f.statePath]);
    expect(stdout).toHaveBeenCalledTimes(3);
    expect(process.listeners('SIGINT')).toHaveLength(before);
    await expect(h01SeriesMain(['--step'])).rejects.toThrow('series-step-usage');
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = exitCode;
  }
});
it('refuses an already aborted step before its operator and forwards cancellation during the sole operator', async () => {
  const f = h01SeriesFixture(),
    command = f.command(),
    controller = new AbortController();
  controller.abort();
  await expect(stepH01Series(command, controller.signal)).rejects.toThrow();
  expect(h01Series.run).not.toHaveBeenCalled();
  const live = new AbortController(),
    original = h01Series.run.getMockImplementation()!;
  h01Series.run.mockImplementationOnce(async (...args: unknown[]) => {
    live.abort();
    expect((args[2] as AbortSignal).aborted).toBe(true);
    return original(...args) as unknown;
  });
  expect((await stepH01Series(command, live.signal)).status).toBe('blocked');
});
it('reports only a generic CLI failure when a directly invoked entry contains private malformed JSON', async () => {
  const argv = process.argv,
    exitCode = process.exitCode,
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const secret = file('private.json', '{ private secret material');
  try {
    process.argv = [
      'node',
      fileURLToPath(new URL('./comparisonH01Series.ts', import.meta.url)),
      '--plan',
      secret.locator,
    ];
    vi.resetModules();
    await import('./comparisonH01Series.js');
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith('series-step-failed\n'));
    expect(stderr.mock.calls.flat().join('')).not.toContain('private secret');
    process.argv = [];
    vi.resetModules();
    await import('./comparisonH01Series.js');
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
it.each(['rollback-between', 'jump', 'reset', 'tamper-clock'] as const)(
  'refuses %s across separate commands without resetting the global interval',
  async (mode) => {
    const f = h01SeriesFixture(),
      first = await stepH01Series(f.command());
    const now = first.observedAtMs,
      ns = BigInt(first.observedNs),
      command = f.command(1, first.state);
    if (mode === 'tamper-clock') {
      const state = JSON.parse(readFileSync(f.statePath, 'utf8')) as Record<string, unknown>;
      state.observedNs = String(ns + 100_000_000n);
      state.elapsedMs = 0;
      writeFileSync(f.statePath, canonical(state));
      const changed = object(h01ReadJson(command));
      changed.previousState = { locator: f.statePath, hash: digest(readFileSync(f.statePath)) };
      await expect(stepH01Series(f.refresh(command, changed))).rejects.toThrow(
        'series-step-state-clock',
      );
    } else {
      vi.spyOn(Date, 'now').mockReturnValue(now + (mode === 'jump' ? 100_000 : 200));
      vi.spyOn(process.hrtime, 'bigint').mockReturnValue(
        mode === 'reset' ? ns - 1n : ns + BigInt(mode === 'jump' ? 100 : 100_000) * 1_000_000n,
      );
      await expect(stepH01Series(command)).rejects.toThrow('series-step-clock');
    }
    expect(h01Series.run).toHaveBeenCalledTimes(1);
  },
);
it('blocks elapsed overrun observed after the operator instead of granting the next slot', async () => {
  const f = h01SeriesFixture(),
    original = h01Series.run.getMockImplementation()!,
    now = Date.now(),
    ns = process.hrtime.bigint();
  h01Series.run.mockImplementationOnce(async (...args: unknown[]) => {
    const result: unknown = await original(...args);
    vi.spyOn(Date, 'now').mockReturnValue(now + 100_000);
    vi.spyOn(process.hrtime, 'bigint').mockReturnValue(ns + 100_000_000_000n);
    return result;
  });
  const result = await stepH01Series(f.command());
  expect(result.status).toBe('blocked');
  expect(result.blocked).toContain('series-step-time-cap');
  await expect(stepH01Series(f.command(1, result.state))).rejects.toThrow('series-step-blocked');
});
it('retains pending when the primary source namespace changes during its only operator', async () => {
  const f = h01SeriesFixture(),
    original = h01Series.run.getMockImplementation()!;
  h01Series.run.mockImplementationOnce(async (...args: unknown[]) => {
    const result: unknown = await original(...args);
    writeFileSync(join(f.source.roots.source, 'extra'), 'unexpected write');
    return result;
  });
  const command = f.command();
  await expect(stepH01Series(command)).rejects.toThrow('readiness-source-tree-mismatch');
  expect(fs.existsSync(join(f.manifest.outputRoot, 'pending.json'))).toBe(true);
  await expect(stepH01Series(command)).rejects.toThrow();
  expect(h01Series.run).toHaveBeenCalledTimes(1);
});

it('plans and executes the version-2 H01/H02 slice through each scenario owner with independent grants', async () => {
  const f = h01SeriesFixture(2);
  expect(await planH01Series(f.manifestRef)).toMatchObject({ schemaVersion: 2 });
  expect(h01Series.plan.mock.calls.map((args) => String(args[2]))).toEqual([
    'H-01',
    'H-01',
    'H-01',
    'H-01',
    'H-02',
    'H-02',
    'H-02',
    'H-02',
  ]);
  let previous: InputRef | null = null;
  for (let i = 0; i < 8; i++) {
    const command = f.command(i, previous);
    const result = await stepH01Series(command);
    expect(result.schemaVersion).toBe(2);
    expect(result.records).toHaveLength(i + 1);
    expect((await stepH01Series(command)).records).toHaveLength(i + 1);
    previous = result.state;
  }
  expect(statusH01Series(f.statePath)).toMatchObject({
    status: 'adapter-required',
    next: 'H-03:1:baseline',
  });
  expect(h01Series.run).toHaveBeenCalledTimes(8);
  expect(h01Series.run.mock.calls.map((args) => String(args[3]))).toEqual([
    'H-01',
    'H-01',
    'H-01',
    'H-01',
    'H-02',
    'H-02',
    'H-02',
    'H-02',
  ]);
  expect(h01Series.evidence.mock.calls.some((args) => args[1] === 'H-02')).toBe(true);
}, 30_000);
it.each(['command-version', 'h01-request', 'h01-spec', 'missing-h02', 'state-version'] as const)(
  'rejects a cross-scenario/version substitution: %s',
  async (mode) => {
    const f = h01SeriesFixture(2);
    if (mode === 'command-version') {
      await expect(stepH01Series(f.command(0, null, { schemaVersion: 1 }))).rejects.toThrow(
        'series-step-command-version',
      );
    } else if (mode === 'h01-request') {
      f.drafts[4]!.kind = 'comparison-h01-execution';
      f.steps[4]!.request = f.refresh(f.steps[4]!.request, f.drafts[4]);
      f.save();
      await expect(planH01Series(f.manifestRef)).rejects.toThrow('h01-version');
    } else if (mode === 'h01-spec') {
      f.specs[4]!.kind = 'comparison-h01-operator';
      f.steps[4]!.spec = f.refresh(f.steps[4]!.spec, f.specs[4]);
      f.save();
      await expect(planH01Series(f.manifestRef)).rejects.toThrow('h01-operator-version');
    } else if (mode === 'missing-h02') {
      f.manifest.steps.splice(4);
      f.save();
      await expect(planH01Series(f.manifestRef)).rejects.toThrow('series-step-order');
    } else {
      await stepH01Series(f.command());
      const state = object(JSON.parse(readFileSync(f.statePath, 'utf8')));
      state.schemaVersion = 1;
      writeFileSync(f.statePath, canonical(state));
      expect(() => statusH01Series(f.statePath)).toThrow('series-step-state-binding');
    }
    expect(h01Series.run).toHaveBeenCalledTimes(mode === 'state-version' ? 1 : 0);
  },
);

it('checks H02 runtime closure even after the same variant inventory passed H01', async () => {
  const f = h01SeriesFixture(2);
  h01Series.runtime.mockImplementation(async (request: H01ExecutionRequest) => {
    if (request.kind === 'comparison-h02-execution') throw new Error('h02-runtime-closure-missing');
    return {};
  });
  await expect(planH01Series(f.manifestRef)).rejects.toThrow('h02-runtime-closure-missing');
  expect(h01Series.runtime.mock.calls.map((args) => String(object(args[0]).kind))).toEqual([
    'comparison-h01-execution',
    'comparison-h01-execution',
    'comparison-h02-execution',
  ]);
  expect(h01Series.run).not.toHaveBeenCalled();
});

it('executes exactly the version-3 H01/H02/H03 slice and fences H04 without losing H03 replay safety', async () => {
  const f = h01SeriesFixture(3),
    plan = await planH01Series(f.manifestRef);
  expect(plan.schemaVersion).toBe(3);
  expect(plan.executable).toHaveLength(12);
  expect(h01Series.runtime).toHaveBeenCalledTimes(6);
  const expected = [
    'H-01',
    'H-01',
    'H-01',
    'H-01',
    'H-02',
    'H-02',
    'H-02',
    'H-02',
    'H-03',
    'H-03',
    'H-03',
    'H-03',
  ];
  expect(h01Series.plan.mock.calls.map((args) => String(args[2]))).toEqual(expected);
  let previous: InputRef | null = null;
  for (let i = 0; i < 12; i++) {
    const command = f.command(i, previous),
      result = await stepH01Series(command);
    expect(result.schemaVersion).toBe(3);
    expect(result.records).toHaveLength(i + 1);
    if (i === 8 || i === 11) expect((await stepH01Series(command)).records).toHaveLength(i + 1);
    previous = result.state;
  }
  expect(h01Series.run).toHaveBeenCalledTimes(12);
  expect(h01Series.run.mock.calls.map((args) => String(args[3]))).toEqual(expected);
  expect(statusH01Series(f.statePath)).toMatchObject({
    schemaVersion: 3,
    status: 'adapter-required',
    next: 'H-04:1:baseline',
  });
}, 30_000);
it.each([
  'command-version',
  'h02-request',
  'h02-spec',
  'missing-h03',
  'state-version',
  'v2-manifest',
  'unsupported-version',
] as const)('rejects an H03 cross-scenario/version substitution: %s', async (mode) => {
  const f = h01SeriesFixture(3);
  if (mode === 'command-version')
    await expect(stepH01Series(f.command(0, null, { schemaVersion: 2 }))).rejects.toThrow(
      'series-step-command-version',
    );
  else if (mode === 'h02-request') {
    f.drafts[8]!.kind = 'comparison-h02-execution';
    f.steps[8]!.request = f.refresh(f.steps[8]!.request, f.drafts[8]);
    f.save();
    await expect(planH01Series(f.manifestRef)).rejects.toThrow('h01-version');
  } else if (mode === 'h02-spec') {
    f.specs[8]!.kind = 'comparison-h02-operator';
    f.steps[8]!.spec = f.refresh(f.steps[8]!.spec, f.specs[8]);
    f.save();
    await expect(planH01Series(f.manifestRef)).rejects.toThrow('h01-operator-version');
  } else if (mode === 'missing-h03') {
    f.manifest.steps.splice(8);
    f.save();
    await expect(planH01Series(f.manifestRef)).rejects.toThrow('series-step-order');
  } else if (mode === 'v2-manifest') {
    f.manifest.schemaVersion = 2;
    f.save();
    await expect(planH01Series(f.manifestRef)).rejects.toThrow('series-step-order');
  } else if (mode === 'unsupported-version') {
    (f.manifest as Record<string, unknown>).schemaVersion = 7;
    f.save();
    await expect(planH01Series(f.manifestRef)).rejects.toThrow('series-step-version');
  } else {
    await stepH01Series(f.command());
    const state = object(JSON.parse(readFileSync(f.statePath, 'utf8')));
    state.schemaVersion = 2;
    writeFileSync(f.statePath, canonical(state));
    expect(() => statusH01Series(f.statePath)).toThrow('series-step-state-binding');
  }
  expect(h01Series.run).toHaveBeenCalledTimes(mode === 'state-version' ? 1 : 0);
});
it('checks H03 runtime closure independently of already checked H01/H02 inventories', async () => {
  const f = h01SeriesFixture(3);
  h01Series.runtime.mockImplementation(async (request: H01ExecutionRequest) => {
    if (request.kind === 'comparison-h03-execution') throw new Error('h03-runtime-closure-missing');
    return {};
  });
  await expect(planH01Series(f.manifestRef)).rejects.toThrow('h03-runtime-closure-missing');
  expect(h01Series.runtime.mock.calls.map((args) => String(object(args[0]).kind))).toEqual([
    'comparison-h01-execution',
    'comparison-h01-execution',
    'comparison-h02-execution',
    'comparison-h02-execution',
    'comparison-h03-execution',
  ]);
  expect(h01Series.run).not.toHaveBeenCalled();
});
