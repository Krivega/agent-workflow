import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { declareBackendFixture } from './backendPolicyFixture.js';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { prepareComparisonSeries, runComparisonSeries } from '../cli/comparisonSeries.js';
import { runAgentWorkflow, type WorkflowCliDependencies } from '../cli/runAgentWorkflow.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import * as managed from '../adapters/storage/managedChatFiles.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { parseComparisonSuite } from '../core/comparison.js';
import type { comparisonSchedule } from '../core/comparison.js';
import suiteSource from '../comparison/suite.json' with { type: 'json' };
import type {
  ComparisonSessionRequest,
  comparisonSession as NativeComparisonSession,
} from '../adapters/codex/comparisonSession.js';
import type * as FsPromises from 'node:fs/promises';
import type * as ComparisonInputs from '../adapters/project/comparisonInputs.js';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import type { InputManifest } from '../core/evidence.js';
import type { InputRef } from '../core/localRun.js';
vi.setConfig({ testTimeout: 30_000 });
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const mocks = vi.hoisted(() => ({
  freeze: vi.fn(),
  materialize: vi.fn(),
  client: vi.fn(),
  snapshot: vi.fn(),
  session: vi.fn<typeof NativeComparisonSession>(),
  observe: vi.fn(),
  message: vi.fn(),
  capture: vi.fn(),
  current: vi.fn(),
}));
vi.mock('../adapters/project/comparisonInputs.js', async (original) => ({
  ...(await original<typeof ComparisonInputs>()),
  freezeComparisonSnapshot: mocks.freeze,
  materializeComparisonSnapshot: mocks.materialize,
  verifyComparisonClient: mocks.client,
  verifyComparisonSnapshot: mocks.snapshot,
}));
vi.mock('../adapters/codex/comparisonSession.js', () => ({ comparisonSession: mocks.session }));
vi.mock('../adapters/codex/currentChatHost.js', () => ({
  FileCurrentChatHost: class {
    observe = mocks.observe;
    message = mocks.message;
  },
}));
vi.mock('../adapters/project/workflowInputs.js', () => ({
  FileWorkflowInputs: class {
    capture = mocks.capture;
    current = mocks.current;
  },
}));

const suite = parseComparisonSuite(suiteSource);
const manifest: InputManifest = {
  complete: true,
  attested_by: 'comparison runner',
  discovery_rule: '{"version":2,"kind":"explicit"}',
  inputs: [{ locator: 'runner', hash: 'a'.repeat(64) }],
};
interface Stored {
  schema_version: number;
  runner_version: number;
  series_id: string;
  suite_hash: string;
  materials_hash: string;
  sources: { baseline: InputRef; candidate: InputRef };
  runner: { root: string; inputs: InputManifest };
  profile: Record<string, string>;
  schedule: ReturnType<typeof comparisonSchedule>;
  participants: (ComparisonParticipant & { complete: boolean })[];
  receipts: unknown[];
  results: {
    run: string;
    attempt: number;
    outcome: string;
    checks: Record<string, boolean>;
    evidence: string[];
  }[];
  pending: {
    run: string;
    attempt: number;
    operation: string;
    stage: string;
    error: string | null;
  } | null;
  elapsed_ms: number;
  started_at: number;
}
let root: string,
  path: string,
  prepare: Record<string, unknown>,
  live: Record<string, unknown>,
  qualification: InputRef;
let sessionBehavior: (
  request: ComparisonSessionRequest,
  result: { text: string; status: string; source: InputRef },
) => void | Promise<void>;
const cache = new Map<string, { text: string; status: string; source: InputRef }>();
const stored = () => readManaged<Stored>(path)!;
const change = (fn: (series: Stored) => void) => {
  const series = stored();
  fn(series);
  saveManaged(path, series, false);
};
const file = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};
const proof = async (locator: string, value: unknown) => {
  const bytes = canonical(value) + '\n';
  await file(locator, bytes);
  return { locator, hash: digest(bytes) };
};
const authorize = async () => {
  const series = stored();
  qualification = await proof(resolve(root, 'qualification.json'), {
    schema_version: 1,
    kind: 'native-workflow-comparison',
    profile_hash: digest(canonical(series.profile)),
    sources_hash: digest(canonical(series.sources)),
    scenarios: suite.scenarios.map((s) => s.id),
    evidence: [await proof(resolve(root, 'qualified-source.json'), { fixture: true })],
  });
  live = {
    schema_version: 1,
    live: true,
    series: path,
    qualification,
    authorization: {
      root,
      transcript: resolve(root, 'human.jsonl'),
      anchor: {},
      source: { locator: '/human#L1', hash: 'human' },
      series_id: series.series_id,
      sources_hash: digest(canonical(series.sources)),
    },
  };
};
const setup = async () => {
  await prepareComparisonSeries(prepare);
  await authorize();
};
it('refuses an unqualified comparison before series locking, updates or native sessions', async () => {
  await setup();
  const before = await readFile(path, 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: root });
  declareBackendFixture(root);
  await file(
    resolve(root, '.git/agent-workflow/backend-policy.json'),
    JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
  );
  const lock = resolve(dirname(path), 'agent-workflow-chat-writer.lock');
  await file(lock, 'existing-owner');
  await expect(runComparisonSeries(live)).rejects.toThrow('backend-consumer-not-qualified');
  expect(await readFile(lock, 'utf8')).toBe('existing-owner');
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(mocks.session).not.toHaveBeenCalled();
});
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv('CODEX_THREAD_ID', 'human');
  cache.clear();
  sessionBehavior = () => {};
  root = await realpath(await mkdtemp(resolve(tmpdir(), 'comparison-series-')));
  path = resolve(root, 'series/series.json');
  const binary = resolve(root, 'codex');
  await file(binary, 'fixture executable');
  const modules = resolve(root, 'node_modules');
  await mkdir(modules);
  await file(resolve(root, 'yarn.lock'), 'fixture lock');
  prepare = {
    schema_version: 1,
    series_id: 'fixture-series',
    state_root: dirname(path),
    binary,
    modules,
    variants: {
      baseline: { root: resolve(root, 'baseline'), revision: 'a'.repeat(40) },
      candidate: { root: resolve(root, 'candidate'), revision: null },
    },
    profile: { model: 'fixture-model', effort: 'high' },
  };
  mocks.freeze.mockImplementation(
    async (_source: string, revision: string | null, directory: string) =>
      proof(resolve(directory, `snapshot-${revision === null ? 'candidate' : 'baseline'}.json`), {
        fixture: revision,
      }),
  );
  mocks.materialize.mockImplementation(async (_ref: InputRef, destination: string) =>
    mkdir(destination, { recursive: true }),
  );
  mocks.client.mockResolvedValue('0.164.0');
  mocks.capture.mockResolvedValue(manifest);
  mocks.current.mockResolvedValue(manifest);
  mocks.observe.mockResolvedValue({
    thread_id: 'human',
    model: 'fixture-model',
    effort: 'high',
    sandbox_policy: 'danger-full-access',
    approval_policy: 'never',
    permission_profile: 'disabled',
    network_access: true,
  });
  mocks.message.mockResolvedValue({ thread_id: 'human', turn_id: 'turn' });
  mocks.session.mockImplementation(
    async (
      request: ComparisonSessionRequest,
      register: (p: ComparisonParticipant) => void,
      verify: () => Promise<void>,
    ) => {
      if (cache.has(request.operation)) return cache.get(request.operation)!;
      const session = request.operation;
      const transcript = resolve(root, `native-${digest(session)}.jsonl`);
      const tokens = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 };
      await file(
        transcript,
        JSON.stringify({ type: 'session_meta', payload: { id: session } }) +
          '\n' +
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: { total_token_usage: tokens, last_token_usage: tokens },
            },
          }) +
          '\n',
      );
      register({ session, transcript, run: request.run, stage: request.stage });
      await verify();
      const scenario = suite.scenarios.find((s) => request.run.startsWith(s.id))!;
      if (request.stage === 'execution') {
        if (scenario.id === 'H-01')
          await file(
            resolve(request.workspace, 'range.mjs'),
            'export const contains = (value, min, max) => value >= min && value <= max;\n',
          );
        else if (scenario.id === 'H-02')
          await file(resolve(request.workspace, 'pricing.json'), '{"rate":7}\n');
        else
          await file(
            resolve(request.workspace, 'evidence/manifest.json'),
            JSON.stringify({
              initial_failure: 'F-01',
              sources: [{ locator: '/fixture-only', hash: 'a'.repeat(64) }],
            }),
          );
      }
      const result = {
        status: 'completed',
        text:
          request.stage === 'execution'
            ? '{"summary":"fixture"}'
            : JSON.stringify({
                outcome: 'accepted',
                checks: Object.fromEntries(scenario.checks.map((check) => [check, true])),
                limitations: [],
              }),
        source: await proof(resolve(root, `${digest(session)}.json`), { fixture: session }),
      };
      await sessionBehavior(request, result);
      cache.set(request.operation, result);
      return result;
    },
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('prepares immutable variants/common profiles and runs 24 ordered pairs with all costs and independent acceptance', async () => {
  const ready = await prepareComparisonSeries(prepare);
  expect(ready).toMatchObject({ status: 'prepared', may_start: true });
  expect(stored().runner.root).toBe(resolve(import.meta.dirname, '..'));
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.client).toHaveBeenCalledTimes(2);
  await authorize();
  const result = await runComparisonSeries(live);
  expect(result).toMatchObject({
    complete: true,
    comparison_eligible: true,
    may_start: false,
    totals: { responses: 48, input_uncached: 3840, input_cached: 960, output: 480 },
  });
  expect(mocks.session).toHaveBeenCalledTimes(48);
  expect(stored().participants).toHaveLength(48);
  expect(stored().participants.every((p) => p.complete && p.through !== undefined)).toBe(true);
  expect(
    stored()
      .schedule.slice(0, 4)
      .map((s) => s.variant),
  ).toEqual(['baseline', 'candidate', 'candidate', 'baseline']);
  const calls = mocks.session.mock.calls.length;
  expect(await runComparisonSeries(live)).toMatchObject({ comparison_eligible: true });
  expect(mocks.session).toHaveBeenCalledTimes(calls);
});
it('allows only explicit retries of known failures and preserves costs of every attempt', async () => {
  await setup();
  sessionBehavior = (request, result) => {
    if (request.run === 'H-06:2:baseline' && request.stage === 'council') result.text = 'not JSON';
  };
  await runComparisonSeries(live);
  expect(stored().results.at(-1)?.outcome).toBe('harness-error');
  sessionBehavior = () => {};
  expect(await runComparisonSeries({ ...live, retry: 'H-06:2:baseline' })).toMatchObject({
    complete: true,
    comparison_eligible: true,
    totals: { responses: 50 },
  });
  expect(stored().results.at(-1)?.attempt).toBe(2);
  await expect(runComparisonSeries({ ...live, retry: 'H-01:1:baseline' })).rejects.toThrow(
    'comparison-retry-not-allowed',
  );
});
it('persists an unknown operation and resumes the same actor without repeating an accepted create/send', async () => {
  await setup();
  let lost = true;
  sessionBehavior = (request) => {
    if (request.stage === 'council' && lost) {
      lost = false;
      throw new Error('reply lost');
    }
  };
  await expect(runComparisonSeries(live)).rejects.toThrow('reply lost');
  expect(stored().pending).toMatchObject({ stage: 'council', error: 'reply lost' });
  const first = mocks.session.mock.calls[0]![0] as ComparisonSessionRequest;
  expect(await runComparisonSeries(live)).toMatchObject({ complete: true });
  expect(mocks.session.mock.calls[2]![0]).toMatchObject({ operation: first.operation });
  expect(stored().receipts).toHaveLength(48);
});
it('persists preparation intent before copying and safely resumes identical material after I/O loss', async () => {
  await setup();
  mocks.materialize.mockRejectedValueOnce(new Error('copy lost'));
  await expect(runComparisonSeries(live)).rejects.toThrow('copy lost');
  expect(stored().pending).toMatchObject({ stage: 'preparation' });
  expect(mocks.session).not.toHaveBeenCalled();
  await runComparisonSeries(live);
  expect(stored().results).toHaveLength(24);
});
it('reconciles a partial material write and refuses altered existing bytes before creating a model', async () => {
  await setup();
  const original = vi.mocked(writeFile).getMockImplementation()!;
  vi.mocked(writeFile)
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error('disk lost'));
  await expect(runComparisonSeries(live)).rejects.toThrow('disk lost');
  const caseRoot = resolve(dirname(path), `work-${stored().pending!.operation}`, 'case');
  await file(resolve(caseRoot, 'range.mjs'), 'changed');
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-material-changed');
  expect(mocks.session).not.toHaveBeenCalled();
  await file(
    resolve(caseRoot, 'range.mjs'),
    'export const contains = (value, min, max) => value >= min && value < max;\n',
  );
  await runComparisonSeries(live);
  expect(stored().results).toHaveLength(24);
});
it('retains durable pending intent when persisting a known result fails', async () => {
  await setup();
  const original = managed.saveManaged;
  let fail = true;
  vi.spyOn(managed, 'saveManaged').mockImplementation((target, value, shared, archive) => {
    const record = value as Stored;
    if (target === path && record.pending === null && record.results.length > 0 && fail) {
      fail = false;
      throw new Error('commit lost');
    }
    original(target, value, shared, archive);
  });
  await expect(runComparisonSeries(live)).rejects.toThrow('commit lost');
  expect(stored().pending).toMatchObject({ stage: 'council' });
  expect(stored().results).toHaveLength(0);
});
it('retains non-Error unknown failures and records a non-Error check failure without acceptance', async () => {
  await setup();
  mocks.snapshot.mockRejectedValueOnce('check unavailable');
  sessionBehavior = (request) => {
    if (request.run === 'H-01:1:candidate') throw 'transport unknown';
  };
  await expect(runComparisonSeries(live)).rejects.toBe('transport unknown');
  expect(stored().pending).toMatchObject({ error: 'comparison-operation-outcome-unknown' });
  expect(stored().results[0]!.outcome).toBe('failed');
});
it('never starts a live actor without a bound human authorization and qualification', async () => {
  await setup();
  await expect(runComparisonSeries({ ...live, live: false })).rejects.toThrow(
    'comparison-live-authorization-required',
  );
  await expect(
    runComparisonSeries({
      ...live,
      authorization: { ...(live.authorization as object), sources_hash: 'foreign' },
    }),
  ).rejects.toThrow('comparison-authorization-binding-mismatch');
  mocks.message.mockRejectedValueOnce(new Error('human-turn-revoked'));
  await expect(runComparisonSeries(live)).rejects.toThrow('human-turn-revoked');
  const altered = await proof(resolve(root, 'bad-qualification'), {
    schema_version: 1,
    kind: 'summary',
  });
  await expect(runComparisonSeries({ ...live, qualification: altered })).rejects.toThrow(
    'comparison-native-qualification-required',
  );
  await expect(
    runComparisonSeries({ ...live, qualification: { ...qualification, hash: 'changed' } }),
  ).rejects.toThrow('comparison-source-changed');
  expect(mocks.session).not.toHaveBeenCalled();
});
it('refuses current-context drift during execution before another model can start', async () => {
  await setup();
  const observed = (await mocks.observe()) as Record<string, unknown>;
  sessionBehavior = () => {
    mocks.observe.mockResolvedValue({ ...observed, model: 'changed' });
  };
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-authorization-changed');
  expect(mocks.session).toHaveBeenCalledOnce();
});
it('rejects overlapping state/source trees before freezing or creating anything', async () => {
  await mkdir(resolve(root, 'baseline'));
  await expect(
    prepareComparisonSeries({ ...prepare, state_root: resolve(root, 'baseline/series') }),
  ).rejects.toThrow('comparison-state-overlaps-source');
  expect(mocks.freeze).not.toHaveBeenCalled();
});
it.each([
  [
    'comparison-series-incompatible',
    (s: Stored) => {
      s.schema_version = 2;
    },
  ],
  [
    'comparison-runner-changed',
    (s: Stored) => {
      s.profile.runner_hash = 'changed';
    },
  ],
  [
    'comparison-runner-changed',
    (s: Stored) => {
      s.runner.root = '/other';
    },
  ],
  [
    'comparison-inputs-changed',
    (s: Stored) => {
      for (const run of s.schedule.filter((run) => run.scenario === 'H-01'))
        run.material_hash = 'b'.repeat(64);
    },
  ],
  [
    'comparison-inputs-changed',
    (s: Stored) => {
      for (const run of s.schedule.filter((run) => run.scenario === 'H-01'))
        run.profile_hash = 'b'.repeat(64);
    },
  ],
  [
    'comparison-pending-operation-mismatch',
    (s: Stored) => {
      s.pending = { run: 'other', attempt: 1, operation: 'other', stage: 'execution', error: null };
    },
  ],
  [
    'comparison-series-stopped:limit',
    (s: Stored) => {
      s.started_at = Date.now() - 28_800_001;
    },
  ],
  [
    'comparison-series-stopped:reserve',
    (s: Stored) => {
      s.started_at = Date.now() - 26_000_000;
    },
  ],
])('rejects drift, conflicts or exhausted budgets: %s', async (error, mutate) => {
  await setup();
  change(mutate);
  await expect(runComparisonSeries(live)).rejects.toThrow(error);
  expect(mocks.session).not.toHaveBeenCalled();
});
it('refuses changed runtime, runner inputs or primary source bytes before effects', async () => {
  await setup();
  mocks.current.mockResolvedValueOnce({ ...manifest, complete: false });
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-runner-changed');
  await file(String(prepare.binary), 'changed');
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-runtime-changed');
  await file(String(prepare.binary), 'fixture executable');
  await file(stored().sources.baseline.locator, 'changed');
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-source-changed');
  expect(mocks.session).not.toHaveBeenCalled();
});
it('accounts helper sessions and refuses conflicting participant identity without a new operation', async () => {
  await setup();
  const implementation = mocks.session.getMockImplementation()!;
  mocks.session.mockImplementationOnce(
    async (
      request: ComparisonSessionRequest,
      register: (p: ComparisonParticipant) => void,
      verify: () => Promise<void>,
    ) => {
      const result = await implementation(request, register, verify);
      const main = stored().participants[0]!;
      register({ ...main, stage: 'helper' });
      register({ ...main, transcript: '/changed-path' });
      return result;
    },
  );
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-participant-conflict');
  expect(stored().pending).not.toBeNull();
});
it('treats missing native usage as unknown and stops before another model', async () => {
  await setup();
  sessionBehavior = async () => {
    const main = stored().participants[0]!;
    await file(
      main.transcript,
      JSON.stringify({ type: 'session_meta', payload: { id: main.session } }) + '\n',
    );
  };
  await expect(runComparisonSeries(live)).rejects.toThrow(
    'comparison-series-stopped:missing-metrics',
  );
  expect(stored().receipts).toMatchObject([{ responses: null }]);
  expect(mocks.session).toHaveBeenCalledOnce();
});
it.each(['failed', 'interrupted'])(
  'records known executor status %s and does not invent council acceptance',
  async (status) => {
    await setup();
    sessionBehavior = (request, result) => {
      if (request.stage === 'execution') result.status = status;
    };
    await runComparisonSeries(live);
    expect(stored().results.every((r) => r.outcome === 'failed')).toBe(true);
    expect(mocks.session).toHaveBeenCalledTimes(24);
  },
);
it('records a failed reviewer as a harness error and rejects incomplete or unsupported review JSON', async () => {
  await setup();
  sessionBehavior = (request, result) => {
    if (request.stage === 'council') {
      if (request.run.includes('baseline')) result.status = 'failed';
      else result.text = '{"outcome":"unknown","checks":{}}';
    }
  };
  await runComparisonSeries(live);
  expect(stored().results.every((r) => r.outcome === 'harness-error')).toBe(true);
});
it('forces failed acceptance when immutable material changes and retains check evidence', async () => {
  await setup();
  sessionBehavior = async (request) => {
    if (request.stage === 'execution' && request.run.startsWith('H-01'))
      await file(resolve(request.workspace, 'checks.mjs'), 'process.exit(0)');
  };
  await runComparisonSeries(live);
  expect(
    stored()
      .results.slice(0, 4)
      .every((r) => r.outcome === 'failed'),
  ).toBe(true);
  const check = stored().results[0]!.evidence.at(-1)!;
  expect(JSON.parse(await readFile(check, 'utf8'))).toMatchObject({
    exit_code: 1,
    error: 'comparison-material-changed',
  });
});
it('dispatches CLI preparation/run requests, enforces arity and reports failures without native effects', async () => {
  const output = vi.fn(),
    error = vi.fn();
  const deps = { write: output, writeError: error } as unknown as WorkflowCliDependencies;
  const input = resolve(root, 'request.json');
  await file(input, JSON.stringify(prepare));
  expect(await runAgentWorkflow(['comparison-prepare', input], deps)).toBe(0);
  await authorize();
  await file(input, JSON.stringify({ ...live, live: false }));
  expect(await runAgentWorkflow(['comparison-run', input], deps)).toBe(1);
  expect(error).toHaveBeenLastCalledWith('comparison-live-authorization-required');
  expect(await runAgentWorkflow(['comparison-run'], deps)).toBe(2);
  expect(await runAgentWorkflow(['comparison-prepare', input, 'extra'], deps)).toBe(2);
  expect(mocks.session).not.toHaveBeenCalled();
});

it('records attempt boundaries before preparation and after acceptance without resetting a resumed interval', async () => {
  await setup();
  mocks.materialize.mockRejectedValueOnce(new Error('copy interrupted'));
  await expect(runComparisonSeries(live)).rejects.toThrow('copy interrupted');
  const pending = stored().pending as NonNullable<Stored['pending']> & {
    started: { wall_ms: number; monotonic_ms: number; clock_id: string };
  };
  expect(pending.started.wall_ms).toBeGreaterThanOrEqual(stored().started_at);
  const report = await runComparisonSeries(live);
  expect(report.timings.runs[0]).toMatchObject({
    attempts: [{ timing: { start: pending.started } }],
  });
  expect(report.timings.runs.every((run) => run.accepted_ms !== null)).toBe(true);
});
it('retains an interval across restart as unknown and stops before a new execution', async () => {
  await setup();
  mocks.materialize.mockRejectedValueOnce(new Error('interrupted'));
  await expect(runComparisonSeries(live)).rejects.toThrow('interrupted');
  change((series) => {
    const pending = series.pending as NonNullable<Stored['pending']> & {
      started: { clock_id: string };
    };
    pending.started.clock_id = 'previous-process';
  });
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-timing-unknown');
  expect(stored().results).toHaveLength(1);
  expect(mocks.session).toHaveBeenCalledTimes(2);
});
it('reads a legacy pending attempt without inventing a start time and blocks subsequent work', async () => {
  await setup();
  mocks.materialize.mockRejectedValueOnce(new Error('interrupted'));
  await expect(runComparisonSeries(live)).rejects.toThrow('interrupted');
  change((series) => {
    const pending = series.pending as NonNullable<Stored['pending']> & { started?: unknown };
    delete pending.started;
  });
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-timing-unknown');
  expect(stored().results).toHaveLength(1);
});

it('refuses new model work when historical shared preparation has no primary time bounds', async () => {
  await setup();
  change((series) => {
    delete (series as Stored & { preparation_timing?: unknown }).preparation_timing;
  });
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-preparation-timing-unknown');
  expect(mocks.session).not.toHaveBeenCalled();
});

it('does not hide a backwards series clock behind the previous elapsed budget', async () => {
  await setup();
  const before = stored();
  vi.spyOn(Date, 'now').mockReturnValue(before.started_at - 1);
  await expect(runComparisonSeries(live)).rejects.toThrow('comparison-series-clock-regressed');
  expect(stored()).toEqual(before);
  expect(mocks.session).not.toHaveBeenCalled();
});
