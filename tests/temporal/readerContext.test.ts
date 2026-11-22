import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { readerContextCompacted } from '../../src/adapters/codex/readerContext.js';
import { ControlledReaderWorkflow } from '../../src/workflows/controlledReader.js';
import { readerKey } from '../../src/policy/readerControl.js';
import { readerExecution } from '../../src/policy/readerExecution.js';
import { readerActivities } from '../../src/activities/reader.js';
import { readerControlActivities } from '../../src/activities/readerControl.js';
import { preparationActivities } from '../../src/activities/preparation.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerBudget } from '../../src/adapters/codex/readerBudget.js';
import { artifactStore } from '../../src/adapters/artifacts/files.js';
import { confirmObservedLoad } from '../../src/adapters/codex/observedLoad.js';
import { readerLoadObserved } from '../../src/adapters/codex/readerLoadCommandOutputs.js';
import type { ReaderInput } from '../../src/contracts/reader.js';
import type { ReaderCommand } from '../../src/contracts/readerControl.js';
import type { H01AttemptContext } from '../comparisonH01Contract.js';
import { h01ReadJson, h01Record } from '../comparisonH01Contract.js';
import {
  h03Material,
  h03Scenario,
  h03PreparedMetadata,
  h03Procedures,
  h03ReaderInput,
  h03ContextPath,
} from '../comparisonH03Contract.js';
import { createH03TemporalAdapter } from '../comparisonH03Temporal.js';
import { createH05TemporalAdapter, verifyH05TemporalExecution } from '../comparisonH05Temporal.js';
import { historyFromJSON, historyToJSON } from '@temporalio/common/proto-utils';
import { ComparisonH05Workflow } from '../comparisonH05Workflow.js';
import type { H05WorkflowInput } from '../comparisonH05Workflow.js';
import type { H05WaitExecution, H05WaitExecutor } from '../comparisonH05Contract.js';
import type { InputRef } from '../../core/localRun.js';
import { digest } from '../../adapters/storage/storeCodec.js';
import * as hostModule from '../../src/worker/readerHost.js';
import * as rpcModule from '../comparisonH02NativeRpc.js';
import * as authorityModule from '../../src/adapters/codex/readerAuthority.js';
import * as commonModule from '../comparisonH01.js';

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  conditions: [] as { p: () => boolean; resolve: () => void }[],
  id: '',
  models: {} as Record<string, (...args: never[]) => unknown>,
  controls: {} as Record<string, (...args: never[]) => unknown>,
}));
const h05Case = vi.hoisted(() => vi.fn());
vi.mock('../comparisonH05Legacy.js', () => ({ runH05Case: h05Case }));
vi.mock('@temporalio/workflow', () => ({
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: 'WAIT_CANCELLATION_COMPLETED' },
  ApplicationFailure: { nonRetryable: (message: string) => new Error(message) },
  defineUpdate: (name: string) => name,
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  setHandler: (name: string, fn: (...args: unknown[]) => unknown) => sdk.handlers.set(name, fn),
  workflowInfo: () => ({ workflowId: sdk.id, taskQueue: 'h03-unit', runId: 'unit-run' }),
  proxyActivities: (options: { taskQueue?: string }) =>
    options.taskQueue ? sdk.controls : sdk.models,
  allHandlersFinished: () => true,
  condition: (p: () => boolean) =>
    p() ? Promise.resolve() : new Promise<void>((resolve) => sdk.conditions.push({ p, resolve })),
  isCancellation: () => false,
  CancellationScope: class {
    run<T>(fn: () => Promise<T>) {
      return fn();
    }
    cancel() {}
    static nonCancellable<T>(fn: () => Promise<T>) {
      return fn();
    }
  },
}));
vi.mock('../../src/worker/readerHost.js', async (original) => ({
  ...(await original<typeof hostModule>()),
}));
vi.mock('../comparisonH02NativeRpc.js', async (original) => ({
  ...(await original<typeof rpcModule>()),
}));
vi.mock('../../src/adapters/codex/readerAuthority.js', async (original) => ({
  ...(await original<typeof authorityModule>()),
}));
vi.mock('../comparisonH01.js', async (original) => ({
  ...(await original<typeof commonModule>()),
}));

const roots: string[] = [];
beforeEach(() => {
  h05Case.mockReset();
  sdk.conditions = [];
  sdk.handlers.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function flush() {
  for (let n = 0; n < 16; n++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const c of sdk.conditions.splice(0))
      if (c.p()) c.resolve();
      else sdk.conditions.push(c);
  }
}

/** Unit-only SDK/transport doubles; real reader/control/effect owners run without services or models. */
function h03Fixture(mode = 'accepted') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-h03-sdk-unit-')));
  roots.push(root);
  const dir = (path: string) => {
    const value = join(root, path);
    mkdirSync(value, { recursive: true });
    return value;
  };
  const workspace = dir('workspace'),
    evidenceRoot = dir('evidence'),
    artifactRoot = dir('artifacts'),
    hostRoot = dir('host');
  dir('workspace/.h03');
  dir('workspace/procedures');
  const pin = (label: string, value: unknown) => h01Record(evidenceRoot, label, value);
  const bytes = (name: string, value: string) => {
    const locator = join(root, name);
    writeFileSync(locator, value);
    return { locator, hash: digest(value) };
  };
  const controller = new AbortController(),
    now = process.hrtime.bigint();
  const issuer = {
    sessionsRoot: root,
    workspaceRoot: workspace,
    threadId: 'unit-human',
    owner: 'operator',
  };
  const ctx = {
    opId: 'h03-sdk-unit',
    requestHash: 'a'.repeat(64),
    variant: 'candidate',
    identity: { taskId: 'h03', owner: 'operator', generation: 1 },
    roots: {
      workspaceRoot: workspace,
      evidenceRoot,
      artifactRoot,
      hostRoot,
      stateRoot: dir('state'),
    },
    profile: { model: 'gpt-6.1-sol', effort: 'medium', clientVersion: '0.154.0' },
    criteria: { ref: pin('criteria', h03Scenario), value: h03Scenario },
    material: { ref: pin('material', h03Material), value: h03Material },
    rules: bytes('rules', 'Mandatory prohibition.\n'),
    executor: bytes('executor', 'Executor.\n'),
    budget: {
      maxManagedStarts: 4,
      maxElapsedMs: 60000,
      maxInputUncached: 10000,
      maxOutput: 10000,
      reserveMs: 10000,
    },
    bootstrap: {
      engine: 'temporal',
      address: 'unit:7233',
      namespace: 'default',
      taskQueue: 'h03-unit',
      workflowsPath: 'unit-workflows',
      issuer,
    },
    signal: controller.signal,
    deadlineNs: String(now + 60_000_000_000n),
    workDeadlineNs: String(now + 50_000_000_000n),
    nativeObserver: { verify: vi.fn(async () => {}) },
  } as unknown as H01AttemptContext;
  ctx.verifiedAuthorization = pin('authorization', {
    kind: 'comparison-h03-authorization-observation',
    opId: ctx.opId,
    requestHash: ctx.requestHash,
    variant: ctx.variant,
    budget: ctx.budget,
    issuer,
    source: { locator: join(root, 'human.jsonl#L1'), hash: 'b'.repeat(64) },
    transcript: join(root, 'human.jsonl'),
    context: {
      threadId: issuer.threadId,
      turnId: 'unit-human-turn',
      owner: issuer.owner,
      workspaceRoot: workspace,
    },
  });
  for (const [path, content] of Object.entries({
    ...h03Material.files,
    ...h03PreparedMetadata(
      readFileSync(ctx.rules.locator, 'utf8'),
      readFileSync(ctx.executor.locator, 'utf8'),
    ),
  }))
    writeFileSync(join(workspace, path), content);
  for (const name of h03Procedures) writeFileSync(join(workspace, `procedures/${name}.md`), name);
  const store = artifactStore(artifactRoot),
    publish = (value: unknown) => store.publish(Buffer.from(JSON.stringify(value)));
  const authority = {
    verify: vi.fn(async (command: ReaderCommand) => {
      if (mode === 'missing-notice') throw new Error('reader-native-issuance-unconfirmed');
      return {
        origin: (mode === 'initial-grant' ? 'initial-grant' : 'human') as 'human',
        author: command.author,
        hash: command.hash,
        proof: publish({ kind: 'unit-only-human-proof', command }),
      };
    }),
    issue: vi.fn(),
  };
  vi.spyOn(authorityModule, 'nativeReaderAuthority').mockReturnValue(authority);
  vi.spyOn(commonModule, 'checkNativeCase').mockImplementation(async () => {
    if (mode === 'checker-string-error') return Promise.reject('unit-checker-error');
    const failed = ![
      'initial-pass',
      'initial-unknown',
      'checker-sigkill',
      'checker-sigsegv',
      'checker-zero-cancel',
    ].includes(mode);
    const stop = {
      stopped: true,
      code:
        mode === 'checker-zero-cancel'
          ? 0
          : mode === 'checker-sigkill' || mode === 'checker-sigsegv'
            ? null
            : 1,
      signal:
        mode === 'checker-sigkill' ? 'SIGKILL' : mode === 'checker-sigsegv' ? 'SIGSEGV' : null,
      killed: mode === 'checker-sigkill',
      deadlineReached: false,
    };
    return {
      passed: mode === 'initial-pass',
      known: mode !== 'initial-unknown',
      failed,
      evidence: pin('initial-check', {
        kind: 'comparison-h03-check',
        passed: false,
        known: true,
        failed,
        stop,
        aborted: mode === 'checker-zero-cancel',
        unit: true,
      }),
    };
  });
  const turns: Record<string, unknown>[] = [],
    calls: string[] = [],
    credits: H01AttemptContext[] = [];
  let serial = 0,
    compactEvidence: ReturnType<typeof pin> | null = null,
    compactCount = 0;
  const thread = () => ({
    id: 'unit-session',
    cwd: workspace,
    path: join(root, 'unit-native.jsonl'),
    projectId: null,
    parentThreadId: null,
    forkedFromId: null,
    turns: structuredClone(turns),
  });
  const history: temporal.api.history.v1.IHistory = { events: [] };
  vi.spyOn(rpcModule, 'createH02NativeRpc').mockImplementation((_ctx, _label, options) => ({
    rpc: {
      request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        calls.push(method);
        if (method === 'thread/start' || method === 'turn/start') ctx.signal.throwIfAborted();
        if (method === 'model/list')
          return {
            data: [
              {
                model: ctx.profile.model,
                supportedReasoningEfforts: [{ reasoningEffort: ctx.profile.effort }],
              },
            ],
          };
        if (method === 'thread/start' || method === 'thread/resume')
          return {
            cwd: workspace,
            model: ctx.profile.model,
            reasoningEffort: ctx.profile.effort,
            approvalPolicy: 'never',
            sandbox: { type: 'readOnly', networkAccess: false },
            thread: thread(),
          };
        if (method === 'thread/loaded/list') return { data: ['unit-session'] };
        if (method === 'thread/read') return { thread: thread() };
        if (method === 'turn/start') {
          const credit = await options!.startForTurn!(params);
          expect(credit.stage).toBe('execution');
          credits.push(_ctx);
          const prompt = (params.input as { text: string }[])[0]!.text,
            marker = 'Пути и хеши: ',
            start = prompt.indexOf(marker);
          const refs =
            start < 0
              ? []
              : (JSON.parse(
                  prompt.slice(start + marker.length, prompt.indexOf('. Для больших', start)),
                ) as { path: string; sha256: string }[]);
          const items = refs.length
            ? [
                {
                  type: 'commandExecution',
                  status: 'completed',
                  exitCode: 0,
                  aggregatedOutput: refs
                    .map((ref) =>
                      JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }),
                    )
                    .join('\n'),
                },
              ]
            : [{ type: 'agentMessage', text: 'Read-only result; F-01 and pending remain open.' }];
          const id = 'turn-' + String(++serial);
          turns.push({
            id,
            status: 'completed',
            items: [{ type: 'userMessage', content: [{ type: 'text', text: prompt }] }, ...items],
          });
          return { turn: { id } };
        }
        throw new Error('unit-unexpected-rpc:' + method);
      }),
      completed: vi.fn(async () => {}),
    },
    compact: async () => {
      compactCount++;
      if (mode !== 'compact-silent')
        turns.push({ id: 'compact', status: 'completed', items: [{ type: 'contextCompaction' }] });
      const line = { locator: join(root, 'unit-native.jsonl#L2'), hash: 'd'.repeat(64) };
      compactEvidence = pin('compact-primary', {
        kind: 'comparison-native-compaction',
        scenario: 'H-03',
        opId: ctx.opId,
        session: 'unit-session',
        before: { ...line, locator: join(root, 'unit-native.jsonl#L1') },
        request: pin('compact-request', { method: 'thread/compact/start' }),
        boundary: line,
        through: line,
        usage: [line],
      });
      return line;
    },
    get compactionEvidence() {
      return compactEvidence;
    },
    evidence: [],
    stop: vi.fn(async () => {
      if (mode === 'late-cancel') controller.abort();
      if (mode === 'stop-throws') throw new Error('unit-port-stop-unknown');
      return pin('port-stop', {
        kind: 'comparison-h03-stop',
        opId: ctx.opId,
        confirmed: mode !== 'stop-unconfirmed',
        remainingProcesses: [],
      });
    }),
  }));
  vi.spyOn(hostModule, 'createReaderHost').mockImplementation(
    async (_connection, _queue, _workflows, projects, profile, directory, limit) => {
      if (mode === 'host-failure') throw new Error('unit-host-unavailable');
      const registration = projects[0]!.registration,
        input = h03ReaderInput(ctx);
      const gate = readerBoundary(
        join(directory, digest(input.preparation.project.projectId), 'permissions'),
        store,
        workspace,
        readerExecution(profile),
        undefined,
        readerBudget(join(directory, 'turn-credits'), limit),
      );
      const controls = readerControlActivities(registration, projects[0]!.rpc, gate, authority);
      sdk.controls = controls as unknown as typeof sdk.controls;
      const models = readerActivities(
        registration,
        projects[0]!.rpc,
        profile,
        join(directory, digest(input.preparation.project.projectId), 'effects'),
        gate.boundary,
      );
      sdk.models = {
        ...models,
        prepareControlledReader: (value: ReaderInput) =>
          preparationActivities(registration).prepareProject(value.preparation),
        answerReader: async (...args: Parameters<typeof models.answerReader>) => {
          if (mode === 'status-wait' && serial === 1) await waiting;
          return models.answerReader(...args);
        },
      } as unknown as typeof sdk.models;
      return {
        taskAdmissionsDirectory: null,
        runUntil: async <T>(run: () => Promise<T>) => {
          try {
            return await run();
          } finally {
            const state = gate.inspect(input);
            const revision = await controls.freezeReader(input, state.permit);
            await controls.stopReader(input, state.permit, revision);
          }
        },
      };
    },
  );
  let release!: () => void,
    delayed = false;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let result: Promise<Awaited<ReturnType<typeof ControlledReaderWorkflow>>>;
  const handle = {
    workflowId: readerKey(h03ReaderInput(ctx)),
    query: async (name: string) => {
      if (mode === 'status-wait' && name === 'readerStatus' && !delayed) {
        delayed = true;
        setImmediate(release);
        return sdk.handlers.get(name)!();
      }
      await flush();
      return sdk.handlers.get(name)!();
    },
    executeUpdate: async (_name: string, options: { args: ReaderCommand[] }) => {
      const ack = Promise.resolve(sdk.handlers.get('readerControl')!(options.args[0]));
      await flush();
      return ack;
    },
    result: async () => {
      await flush();
      const value = await result;
      if (mode === 'context-changed') writeFileSync(join(workspace, h03ContextPath), 'changed\n');
      if (mode === 'pending-lost')
        for (const file of readdirSync(join(hostRoot, 'h03-pending')))
          unlinkSync(join(hostRoot, 'h03-pending', file));
      return value;
    },
    describe: async () => ({ status: { name: 'COMPLETED' }, runId: 'unit-run' }),
    fetchHistory: async () => history,
    cancel: vi.fn(async () => {
      throw new Error('unit-cancel-unknown');
    }),
  };
  const client = {
    options: { namespace: 'default' },
    connection: {
      options: { address: 'unit:7233' },
      withDeadline: (_time: number, run: () => unknown) => Promise.resolve(run()),
    },
    workflow: {
      start: async (_name: string, options: { args: ReaderInput[] }) => {
        sdk.id = readerKey(options.args[0]!);
        result = ControlledReaderWorkflow(options.args[0]!);
        void result.catch(() => {});
        history.events = [
          {
            workflowExecutionStartedEventAttributes: {
              input: { payloads: [defaultPayloadConverter.toPayload(options.args[0])] },
            },
          },
        ];
        if (mode === 'abort-start') controller.abort();
        return handle;
      },
      getHandle: () => handle,
    },
  } as unknown as Client;
  const run = () =>
    createH03TemporalAdapter({
      client,
      nativeConnection: {} as never,
      taskQueue: 'h03-unit',
      workflowsPath: 'unit-workflows',
    }).execute(ctx);
  return {
    ctx,
    controller,
    run,
    calls,
    authority,
    store,
    credits,
    compactCount: () => compactCount,
    pin,
  };
}

describe('native LOAD context boundary', () => {
  it('requires fresh LOAD after compaction, including compaction within the LOAD turn', () => {
    const turns = [
      { id: 'before', items: [{ type: 'contextCompaction' }] },
      { id: 'load', items: [] },
    ];
    const primary = { thread: { id: 'session', turns } };
    expect(readerContextCompacted(primary, 'session', 'load')).toBe(false);
    turns.push({ id: 'after', items: [{ type: 'contextCompaction' }] });
    expect(readerContextCompacted(primary, 'session', 'load')).toBe(true);
    expect(readerContextCompacted(primary, 'session', 'after')).toBe(true);
  });
  it('does not infer a valid context from incomplete or foreign history', () => {
    for (const thread of [
      { id: 'other', turns: [] },
      { id: 'session', turns: null },
      { id: 'session', turns: [] },
      {
        id: 'session',
        turns: [
          { id: 'load', items: [] },
          { id: 'load', items: [] },
        ],
      },
      { id: 'session', turns: [{ id: 'load', items: null }] },
    ])
      expect(() => readerContextCompacted({ thread }, 'session', 'load')).toThrow(
        'reader-context-unknown',
      );
  });
});

describe('H03 native Temporal adapter (unit SDK and transport doubles)', () => {
  it('uses the actual ControlledReaderWorkflow refusal, human controls and one session recovery', async () => {
    const f = h03Fixture(),
      result = await f.run();
    const projection = h01ReadJson(result.projection) as {
      sdk: boolean;
      caseReport: Parameters<typeof h01ReadJson>[0];
      workflowEvidence: Parameters<typeof h01ReadJson>[0][];
    };
    const report = h01ReadJson(projection.caseReport) as {
      checks: Record<string, boolean>;
      session: string;
      context: Parameters<typeof h01ReadJson>[0];
      initial: { load: Parameters<typeof h01ReadJson>[0] };
      recovered: { load: Parameters<typeof h01ReadJson>[0] };
      retained: {
        failure: Parameters<typeof h01ReadJson>[0];
        pending: Parameters<typeof h01ReadJson>[0];
        before: Parameters<typeof h01ReadJson>[0];
        after: Parameters<typeof h01ReadJson>[0];
      };
      probes: Record<string, { error: string; refused: boolean }>;
      nativeAcceptance: false;
    };
    expect(result.outcome).toBe('completed');
    expect(result.nativeAcceptance).not.toBeNull();
    expect(projection.sdk).toBe(true);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.probes).every((probe) => probe.refused)).toBe(true);
    expect(report.probes['stale-source']!.error).toContain('reader-input-changed');
    expect(report.session).toBe('unit-session');
    expect(report.nativeAcceptance).toBe(false);
    expect(f.compactCount()).toBe(1);
    expect(f.calls.filter((method) => method === 'thread/start')).toHaveLength(1);
    expect(f.calls.filter((method) => method === 'turn/start')).toHaveLength(3);
    expect(f.credits).toHaveLength(3);
    const context = readFileSync(report.context.locator, 'utf8');
    expect(digest(context)).toBe(report.context.hash);
    expect(JSON.parse(context) as unknown).toMatchObject({
      kind: 'comparison-h03-context',
      opId: f.ctx.opId,
      identity: f.ctx.identity,
      failure: {
        id: 'F-01',
        source: report.retained.failure,
        text: readFileSync(report.retained.failure.locator, 'utf8'),
      },
      pending: {
        source: report.retained.pending,
        text: readFileSync(report.retained.pending.locator, 'utf8'),
      },
    });
    for (const ref of [report.initial.load, report.recovered.load]) {
      const load = h01ReadJson(ref) as {
        prepared: { manifest: { sha256: string; bytes: number } };
        refs: { path: string; sha256: string }[];
        observed: Record<string, unknown>;
        commandOutputs: unknown;
        session: string;
      };
      const prepared = JSON.parse(f.store.read(load.prepared.manifest).toString('utf8')) as {
        inputs: unknown[];
      };
      expect(prepared.inputs).toContainEqual({
        path: h03ContextPath,
        sha256: report.context.hash,
        bytes: Buffer.byteLength(context),
      });
      expect(load.refs).toContainEqual({
        path: report.context.locator,
        sha256: report.context.hash,
      });
      const observed = readerLoadObserved(
        f.store,
        load.observed,
        load.commandOutputs,
        f.ctx.roots.workspaceRoot,
        f.ctx.profile,
        load.session,
      );
      confirmObservedLoad(observed, load.refs);
      const items = observed.items as { aggregatedOutput?: string }[];
      const reads = items.flatMap((item) =>
        (item.aggregatedOutput ?? '')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
      );
      expect(reads).toContainEqual({
        path: report.context.locator,
        sha256: report.context.hash,
        content: context,
      });
    }
    const before = h01ReadJson(report.retained.before),
      after = h01ReadJson(report.retained.after);
    expect(before).toMatchObject({ state: { status: 'pending' } });
    expect(after).toMatchObject({
      state: { status: 'pending' },
      repeated: false,
      error: expect.stringContaining('effect-outcome-unknown') as unknown,
    });
    expect(JSON.parse(readFileSync(report.retained.pending.locator, 'utf8'))).toContain(
      'h03-unfinished',
    );
    const marker = h01ReadJson(projection.workflowEvidence[0]!) as {
      input: ReaderInput;
      history: Parameters<typeof h01ReadJson>[0];
    };
    const saved = h01ReadJson(marker.history) as { history: temporal.api.history.v1.IHistory };
    const restored = temporal.api.history.v1.History.fromObject(saved.history);
    expect(
      defaultPayloadConverter.fromPayload(
        restored.events![0]!.workflowExecutionStartedEventAttributes!.input!.payloads![0]!,
      ),
    ).toEqual(marker.input);
  }, 30000);

  it('waits only on SDK state while an owner activity is still running', async () => {
    expect((await h03Fixture('status-wait').run()).outcome).toBe('completed');
  }, 30000);
  it.each([
    'missing-notice',
    'initial-grant',
    'initial-pass',
    'initial-unknown',
    'host-failure',
    'stop-throws',
    'stop-unconfirmed',
    'late-cancel',
    'abort-start',
    'pending-lost',
    'checker-string-error',
    'compact-silent',
    'checker-sigkill',
    'checker-sigsegv',
    'checker-zero-cancel',
    'context-changed',
  ])(
    'keeps %s nonaccepted and preserves available primary observations',
    async (mode) => {
      const f = h03Fixture(mode),
        result = await f.run();
      expect(result.outcome).toBe('unknown');
      expect(result.nativeAcceptance).toBeNull();
      const projection = h01ReadJson(result.projection) as {
        caseReport: Parameters<typeof h01ReadJson>[0];
      };
      const report = h01ReadJson(projection.caseReport) as {
        outcome: string;
        blocking: string[];
        initial: { load: unknown };
        retained: { failure: unknown };
      };
      expect(report.blocking.length).toBeGreaterThan(0);
      if (mode === 'missing-notice' || mode === 'initial-grant') {
        expect(report.outcome).toBe('not-run');
        expect(f.calls).toEqual([]);
      }
      if (['checker-sigkill', 'checker-sigsegv', 'checker-zero-cancel'].includes(mode)) {
        expect(report.blocking).toContain('h03-initial-failure-missing');
        expect(report.retained.failure).toBeNull();
        expect(report.initial.load).toBeNull();
        expect(f.calls).toEqual([]);
        expect(rpcModule.createH02NativeRpc).not.toHaveBeenCalled();
      }
      if (mode === 'late-cancel') {
        expect(report.blocking).toContain('h03-cancelled');
        expect(report.retained.failure).not.toBeNull();
        expect(report.initial.load).not.toBeNull();
      }
    },
    30000,
  );
});

/** Real Workflow/Activity body with unit-only server/Worker scheduling. No native process or model. */
function h05SdkFixture(mode = 'wait') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-h05-sdk-unit-')));
  roots.push(root);
  const controller = new AbortController(),
    runId = 'h05-unit-run',
    evidenceRoot = join(root, 'evidence');
  mkdirSync(evidenceRoot);
  const pin = (label: string, value: unknown) => h01Record(evidenceRoot, label, value);
  const binding = pin('known-binding', {
    kind: 'unit-known-native-wait',
    owner: 'operator',
    generation: 2,
    session: 'one-session',
    turn: 'one-turn',
  });
  const receipt = pin('known-result', {
    session: 'one-session',
    turn: 'one-turn',
    outcome: 'completed',
  });
  const ctx = {
    opId: 'h05-unit',
    criteria: { value: { id: 'H-05' } },
    roots: { evidenceRoot },
    signal: controller.signal,
    deadlineNs: String(process.hrtime.bigint() + 60_000_000_000n),
    workDeadlineNs: String(process.hrtime.bigint() + 50_000_000_000n),
    bootstrap: {
      engine: 'temporal',
      namespace: 'default',
      address: 'unit:7233',
      taskQueue: 'h05-unit',
      workflowsPath: 'unit-workflows',
    },
  } as unknown as H01AttemptContext;
  const execution: H05WaitExecution = {
    id: mode.startsWith('restart')
      ? 'restart-reconciled'
      : mode.startsWith('cancel')
        ? 'late-cancel-refused'
        : 'pre-subscription',
    binding,
    mode: mode.startsWith('restart') ? 'restart' : mode.startsWith('cancel') ? 'cancel' : 'wait',
  };
  let enterObservation!: () => void, releaseObservation!: () => void;
  const observationEntered = new Promise<void>((resolve) => {
    enterObservation = resolve;
  });
  const observationReleased = new Promise<void>((resolve) => {
    releaseObservation = resolve;
  });
  let workflowInput: H05WorkflowInput,
    workflowId = '',
    taskQueue = '',
    scheduledId = 0,
    state = 'RUNNING',
    activityPending = false,
    waitCalls = 0;
  let resolveActivity!: (value: InputRef) => void, rejectActivity!: (error: unknown) => void;
  const pendingActivity = new Promise<InputRef>((resolve, reject) => {
    resolveActivity = resolve;
    rejectActivity = reject;
  });
  void pendingActivity.catch(() => {});
  const history: temporal.api.history.v1.IHistory = { events: [] };
  const event = (value: Record<string, unknown>) =>
    history.events!.push(
      temporal.api.history.v1.HistoryEvent.fromObject({
        eventId: history.events!.length + 1,
        ...value,
      }),
    );
  type Options = Parameters<typeof Worker.create>[0];
  const workers: {
    options: Options;
    state: string;
    env: MockActivityEnvironment;
    resolveRun(): void;
    rejectRun(error: Error): void;
    settled: Promise<void>;
    runActivity(): void;
  }[] = [];
  const runActivity = (own: (typeof workers)[number]) => {
    activityPending = false;
    const ordinal = workers.indexOf(own) + 1;
    const info = { workflowId, runId: mode === 'wrong-run' ? 'foreign-run' : runId };
    own.env = new MockActivityEnvironment({
      attempt: ordinal,
      activityId: 'known-wait',
      workflowExecution: info,
    });
    const activities = own.options.activities as {
      h05Wait(input: H05WorkflowInput): Promise<InputRef>;
    };
    const actual = mode === 'foreign-input' ? { ...workflowInput, opId: 'foreign' } : workflowInput;
    own.settled = own.env
      .run<[H05WorkflowInput], InputRef, typeof activities.h05Wait>(activities.h05Wait, actual)
      .then(
        (value) => {
          state = 'COMPLETED';
          const startedId = history.events!.length + 1;
          event({
            activityTaskStartedEventAttributes: {
              identity: own.options.identity,
              attempt: ordinal,
              scheduledEventId: scheduledId,
            },
          });
          event({
            activityTaskCompletedEventAttributes: {
              result: { payloads: [defaultPayloadConverter.toPayload(value)] },
              scheduledEventId: scheduledId,
              startedEventId: startedId,
            },
          });
          event({
            workflowExecutionCompletedEventAttributes: {
              result: { payloads: [defaultPayloadConverter.toPayload(value)] },
            },
          });
          resolveActivity(value);
        },
        (error: unknown) => {
          if (error instanceof CancelledFailure && error.message === 'WORKER_SHUTDOWN') {
            activityPending = true;
          } else {
            state = error instanceof CancelledFailure ? 'CANCELLED' : 'FAILED';
            if (state === 'CANCELLED') {
              const startedId = history.events!.length + 1;
              event({
                activityTaskStartedEventAttributes: {
                  identity: own.options.identity,
                  attempt: ordinal,
                  scheduledEventId: scheduledId,
                },
              });
              event({
                activityTaskCanceledEventAttributes: {
                  scheduledEventId: scheduledId,
                  startedEventId: startedId,
                },
              });
              event({ workflowExecutionCanceledEventAttributes: {} });
            }
            rejectActivity(Object.assign(new Error('unit-workflow-failed'), { cause: error }));
          }
        },
      );
  };
  vi.spyOn(Worker, 'create').mockImplementation(async (options) => {
    if (mode === 'worker-create') throw new Error('unit-worker-create-failed');
    let resolveRun!: () => void, rejectRun!: (error: Error) => void;
    const running = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const own = {
      options,
      state: 'INITIALIZED',
      env: new MockActivityEnvironment(),
      resolveRun,
      rejectRun,
      settled: Promise.resolve(),
      runActivity: () => runActivity(own),
    };
    workers.push(own);
    return {
      run() {
        own.state = 'RUNNING';
        if (mode === 'worker-run') {
          own.state = 'FAILED';
          rejectRun(new Error('unit-worker-run-failed'));
        } else if (activityPending) own.runActivity();
        return running;
      },
      getState: () => own.state,
      shutdown() {
        own.state = 'STOPPING';
        own.env.cancel('WORKER_SHUTDOWN');
        void own.settled.then(() => {
          own.state = mode === 'worker-stop' ? 'FAILED' : 'STOPPED';
          if (mode === 'restart-binding' && workers.length === 1)
            writeFileSync(binding.locator, 'changed\n');
          resolveRun();
        });
      },
    } as unknown as Worker;
  });
  const handle = {
    firstExecutionRunId: runId,
    get workflowId() {
      return workflowId;
    },
    result: () => pendingActivity,
    cancel: vi.fn(async () => {
      if (mode.includes('cancel-error')) throw new Error('unit-cancel-unknown');
      workers.at(-1)!.env.cancel('CANCELLED');
    }),
    describe: async () => {
      if (mode === 'held-describe') {
        enterObservation();
        await observationReleased;
      }
      return {
        runId,
        status: { name: mode === 'wrong-status' ? 'RUNNING' : state },
        raw: {
          workflowExecutionInfo: { execution: { workflowId, runId } },
          pendingActivities:
            state === 'RUNNING'
              ? [
                  {
                    activityId: 'known-wait',
                    attempt: 1,
                    lastWorkerIdentity: workers[0]!.options.identity,
                  },
                ]
              : [],
        },
      };
    },
    fetchHistory: async () => {
      if (mode === 'held-history') {
        enterObservation();
        await observationReleased;
      }
      return history;
    },
  };
  const start = vi.fn(
    async (
      _name: string,
      options: { workflowId: string; taskQueue: string; args: H05WorkflowInput[] },
    ) => {
      if (mode === 'start-failed') throw new Error('unit-start-failed');
      workflowInput = options.args[0]!;
      workflowId = options.workflowId;
      taskQueue = options.taskQueue;
      event({
        workflowExecutionStartedEventAttributes: {
          originalExecutionRunId: runId,
          workflowType: { name: 'ComparisonH05Workflow' },
          taskQueue: { name: taskQueue },
          input: { payloads: [defaultPayloadConverter.toPayload(workflowInput)] },
        },
      });
      sdk.models = {
        h05Wait: () => {
          scheduledId = history.events!.length + 1;
          event({
            activityTaskScheduledEventAttributes: {
              activityId: 'known-wait',
              activityType: { name: 'h05Wait' },
              taskQueue: { name: taskQueue },
              input: { payloads: [defaultPayloadConverter.toPayload(workflowInput)] },
            },
          });
          if (workers[0]!.state === 'RUNNING') workers[0]!.runActivity();
          return pendingActivity;
        },
      };
      void ComparisonH05Workflow(workflowInput).catch(() => {});
      if (mode.startsWith('abort-start')) controller.abort();
      return mode === 'missing-run' ? { ...handle, firstExecutionRunId: undefined } : handle;
    },
  );
  const getHandle = vi.fn(() => handle);
  const client = {
    options: { namespace: 'default' },
    connection: { options: { address: 'unit:7233' } },
    workflow: { start, getHandle },
  } as unknown as Client;
  const wait = (signal: AbortSignal) => {
    waitCalls++;
    if (mode === 'wait-error') return Promise.reject(new Error('unit-primary-unavailable'));
    const held =
      (execution.mode === 'cancel' && mode !== 'cancel-early') ||
      (execution.mode === 'restart' && waitCalls === 1 && mode !== 'restart-no-attempt');
    if (!held) return Promise.resolve(receipt);
    return new Promise<InputRef>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('unit-native-wait-cancelled')), {
        once: true,
      });
      if (signal.aborted) reject(new Error('unit-native-wait-cancelled'));
    });
  };
  let observed: Awaited<ReturnType<H05WaitExecutor>> | undefined;
  h05Case.mockImplementation(
    async (_ctx: H01AttemptContext, engine: string, executor: H05WaitExecutor) => {
      expect(engine).toBe('temporal');
      let outcome = 'completed';
      try {
        observed = await executor(execution, wait);
      } catch {
        outcome = 'unknown';
      }
      if (mode === 'late-abort') controller.abort();
      return {
        outcome,
        evidence: [binding],
        stop: receipt,
        projection: receipt,
        nativeAcceptance: outcome === 'completed' ? receipt : null,
      };
    },
  );
  const run = () =>
    createH05TemporalAdapter({
      client,
      nativeConnection: {} as never,
      taskQueue: 'h05-unit',
      workflowsPath: 'unit-workflows',
    }).execute(ctx);
  return {
    run,
    ctx,
    controller,
    workers,
    start,
    getHandle,
    waitCalls: () => waitCalls,
    observed: () => observed,
    binding,
    execution,
    pin,
    observationEntered,
    releaseObservation,
  };
}

describe('H05 Temporal known-turn SDK assembly (unit scheduler and transport doubles)', () => {
  it.each(['held-history', 'held-describe'])(
    'does not export a completed wait when cancellation arrives during %s',
    async (mode) => {
      const f = h05SdkFixture(mode),
        running = f.run();
      await f.observationEntered;
      f.controller.abort();
      f.releaseObservation();
      const result = await running;
      expect(result.outcome).toBe('unknown');
      expect(result.nativeAcceptance).toBeNull();
      expect(f.observed()).toBeUndefined();
      expect(result.evidence).toContainEqual(f.binding);
    },
  );
  it('does not export a completed wait when the original work clock expires during history read', async () => {
    const f = h05SdkFixture('held-history'),
      running = f.run();
    await f.observationEntered;
    f.ctx.workDeadlineNs = String(process.hrtime.bigint() - 1n);
    f.releaseObservation();
    const result = await running;
    expect(result.outcome).toBe('unknown');
    expect(f.observed()).toBeUndefined();
    expect(result.evidence).toContainEqual(f.binding);
  });
  it.each(['wait', 'cancel', 'restart'])(
    'executes %s through the real Workflow and Activity body',
    async (mode) => {
      const f = h05SdkFixture(mode),
        result = await f.run();
      expect(result.outcome).toBe('completed');
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(f.waitCalls()).toBe(mode === 'restart' ? 2 : 1);
      expect(f.observed()!.outcome).toBe(mode === 'cancel' ? 'cancelled' : 'completed');
      const proofs = result.evidence.map((ref) => h01ReadJson(ref) as Record<string, unknown>);
      const proof = proofs.find((value) => value.kind === 'comparison-h05-sdk-proof')!;
      expect(proof.runId).toBe('h05-unit-run');
      expect(proof.workerStops).toHaveLength(mode === 'restart' ? 2 : 1);
      expect(f.workers.every((worker) => worker.state === 'STOPPED')).toBe(true);
      if (mode === 'restart') {
        expect(f.getHandle).toHaveBeenCalledWith(proof.workflowId, 'h05-unit-run');
        expect(proof.attempts).toHaveLength(2);
      }
      const history = temporal.api.history.v1.History.fromObject(
        h01ReadJson(proof.history as InputRef) as temporal.api.history.v1.IHistory,
      );
      const started = history.events![0]!.workflowExecutionStartedEventAttributes!;
      expect(defaultPayloadConverter.fromPayload(started.input!.payloads![0]!)).toEqual(
        proof.input,
      );
    },
  );

  it.each([
    'workflow-input',
    'activity-input',
    'missing-input',
    'missing-payloads',
    'workflow-result',
    'activity-result',
    'attempt',
    'worker-stop',
    'restart-pending',
    'cancel-result',
  ])('rejects a forged %s even when SDK labels claim completion', async (change) => {
    const f = h05SdkFixture(
      change === 'restart-pending' ? 'restart' : change === 'cancel-result' ? 'cancel' : 'wait',
    );
    expect((await f.run()).outcome).toBe('completed');
    const executionResult = structuredClone(f.observed()!);
    const original = executionResult.evidence.find(
      (ref) => (h01ReadJson(ref) as { kind?: string }).kind === 'comparison-h05-sdk-proof',
    )!;
    const proof = h01ReadJson(original) as {
      history: InputRef;
      attempts: InputRef[];
      workerStops: InputRef[];
      restartPending: InputRef;
      result: InputRef | null;
    };
    if (change === 'attempt' || change === 'worker-stop') {
      const refs = change === 'attempt' ? proof.attempts : proof.workerStops;
      refs[0] = f.pin('forged-sdk-worker', {
        ...(h01ReadJson(refs[0]!) as object),
        ...(change === 'attempt' ? { identity: 'foreign-worker' } : { state: 'RUNNING' }),
      });
    } else if (change === 'restart-pending') {
      const pending = h01ReadJson(proof.restartPending) as {
        raw: { pendingActivities: { lastWorkerIdentity: string }[] };
      };
      pending.raw.pendingActivities[0]!.lastWorkerIdentity = 'foreign-worker';
      proof.restartPending = f.pin('forged-pending', pending);
    } else if (change === 'cancel-result') executionResult.result = f.binding;
    else {
      const history = historyFromJSON(h01ReadJson(proof.history)),
        events = history.events!;
      if (change === 'workflow-input')
        events[0]!.workflowExecutionStartedEventAttributes!.input = {
          payloads: [defaultPayloadConverter.toPayload({ foreign: true })],
        };
      else if (change === 'activity-input')
        events.find(
          (event) => event.activityTaskScheduledEventAttributes,
        )!.activityTaskScheduledEventAttributes!.input = {
          payloads: [defaultPayloadConverter.toPayload({ foreign: true })],
        };
      else if (change === 'missing-input' || change === 'missing-payloads')
        events[0]!.workflowExecutionStartedEventAttributes!.input =
          change === 'missing-input' ? null : {};
      else if (change === 'workflow-result')
        events.find(
          (event) => event.workflowExecutionCompletedEventAttributes,
        )!.workflowExecutionCompletedEventAttributes!.result = {
          payloads: [defaultPayloadConverter.toPayload(f.binding)],
        };
      else
        events.find(
          (event) => event.activityTaskCompletedEventAttributes,
        )!.activityTaskCompletedEventAttributes!.result = {
          payloads: [defaultPayloadConverter.toPayload(f.binding)],
        };
      proof.history = f.pin('forged-sdk-history', JSON.parse(historyToJSON(history)) as unknown);
    }
    const forged = f.pin('forged-sdk-proof', proof);
    executionResult.evidence = executionResult.evidence.map((ref) =>
      ref.locator === original.locator ? forged : ref,
    );
    expect(() => verifyH05TemporalExecution(f.ctx.opId, f.execution, executionResult)).toThrow(
      'h05-sdk',
    );
  });

  it.each([
    'foreign-input',
    'worker-create',
    'worker-run',
    'worker-stop',
    'start-failed',
    'abort-start',
    'missing-run',
    'wrong-run',
    'wrong-status',
    'cancel-error',
    'cancel-early',
    'restart-binding',
    'restart-no-attempt',
    'late-abort',
    'abort-start-cancel-error',
    'wait-error',
  ])('preserves %s as UNKNOWN with known evidence', async (mode) => {
    const f = h05SdkFixture(mode),
      result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(result.nativeAcceptance).toBeNull();
    expect(result.evidence).toContainEqual(f.binding);
  });
});
