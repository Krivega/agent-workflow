import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { reserveTaskBackend, taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
import type {
  ReviewInput,
  ReviewRequest,
  ReviewReport,
  ReviewPlan,
} from '../../src/contracts/review.js';
import { controlFixture } from './controlFixture.js';
import { reviewActivities } from '../../src/activities/review.js';
import { readerActivities } from '../../src/activities/reader.js';
import {
  prepareScopedReview,
  scopedReviewInputs,
  confirmScopedPreparation,
} from '../../src/adapters/codex/reviewInputs.js';
import {
  parseReviewInput,
  parseReviewRequest,
  parseReviewSnapshot,
  parseReviewReport,
  reviewChanges,
  requireScoped,
  reviewKey,
} from '../../src/policy/review.js';
import { parseReaderInput, readerKey } from '../../src/policy/readerControl.js';
import { readerReport } from '../../src/adapters/codex/readerMessages.js';
import { startReview } from '../../src/client/review.js';
import { bindTaskBackendClient } from '../../src/client/taskBackend.js';
import { createH02TemporalFixture } from '../comparisonH02TemporalFixture.js';
import { runH02TemporalCase } from '../comparisonH02Temporal.js';
import * as h02TemporalModule from '../comparisonH02Temporal.js';
import { artifactStore } from '../../src/adapters/artifacts/files.js';
import { object } from '../../src/contracts/project.js';
import * as reviewClientModule from '../../src/client/review.js';
import * as readerHostModule from '../../src/worker/readerHost.js';
import * as nativeRpcModule from '../comparisonH02NativeRpc.js';
import { createH02NativeTemporalAdapter } from '../comparisonH02NativeTemporal.js';
import type { H01AttemptContext } from '../comparisonH01Contract.js';
import { h01ReadJson, h01Record } from '../comparisonH01Contract.js';
import { readerBudget } from '../../src/adapters/codex/readerBudget.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerControlActivities } from '../../src/activities/readerControl.js';
import { readerExecution } from '../../src/policy/readerExecution.js';
import { defaultPayloadConverter } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { MockActivityEnvironment } from '@temporalio/testing';

vi.mock('../../src/client/review.js', async (original) => ({
  ...(await original<typeof reviewClientModule>()),
}));
vi.mock('../../src/worker/readerHost.js', async (original) => ({
  ...(await original<typeof readerHostModule>()),
}));
vi.mock('../comparisonH02NativeRpc.js', async (original) => ({
  ...(await original<typeof nativeRpcModule>()),
}));
vi.mock('../comparisonH02Temporal.js', async (original) => ({
  ...(await original<typeof h02TemporalModule>()),
}));

function nativeSdkFixture(mode = 'accepted') {
  const owner = controlFixture(),
    local = createH02TemporalFixture(join(owner.root, 'native-h02'));
  const workspace = local.registration.workspaceRoot;
  writeFileSync(join(workspace, '.h02/roles.md'), 'pricing\nlogging\nstorage\n');
  mkdirSync(join(workspace, 'procedures'));
  for (const name of ['bootstrap', 'data-roles', 'evidence', 'boundary-review', 'council'])
    writeFileSync(join(workspace, `procedures/${name}.md`), name);
  const evidenceRoot = join(owner.root, 'native-evidence');
  mkdirSync(evidenceRoot);
  const store = artifactStore(local.registration.artifactRoot);
  const pin = (label: string, value: unknown) => h01Record(evidenceRoot, label, value);
  const controller = new AbortController(),
    now = process.hrtime.bigint();
  const ctx = {
    opId: 'native-h02-unit',
    profile: local.profile,
    identity: { taskId: 'h02', owner: local.registration.owner, generation: 1 },
    roots: {
      workspaceRoot: workspace,
      artifactRoot: local.registration.artifactRoot,
      hostRoot: join(owner.root, 'native-host'),
      stateRoot: join(owner.root, 'native-state'),
      evidenceRoot,
    },
    criteria: { value: { id: 'H-02' } },
    budget: { maxManagedStarts: 8, maxElapsedMs: 60000 },
    bootstrap: {
      engine: 'temporal',
      issuer: {
        sessionsRoot: owner.root,
        workspaceRoot: workspace,
        threadId: 'unit-parent',
        owner: local.registration.owner,
      },
    },
    signal: controller.signal,
    deadlineNs: String(now + 60_000_000_000n),
    workDeadlineNs: String(now + 50_000_000_000n),
  } as unknown as H01AttemptContext;
  let runtime: {
    run(input: ReviewInput): Promise<unknown>;
    result: unknown;
    plan: ReviewPlan | null;
  };
  const shutdowns: string[] = [],
    credits: unknown[] = [];
  const concurrency = { modelLists: 0, firstThreadLists: null as number | null };
  let releaseLists!: () => void;
  const listsReady = new Promise<void>((resolve) => {
    releaseLists = resolve;
  });
  vi.spyOn(readerHostModule, 'createReaderHost').mockImplementation(
    async (_connection, _queue, _workflows, projects, profile, directory, max) => {
      const project = projects[0]!,
        registration = project.registration;
      const scopedStore = artifactStore(registration.artifactRoot);
      const gate = readerBoundary(
        join(directory, 'sdk-permissions'),
        scopedStore,
        registration.workspaceRoot,
        readerExecution(profile),
        () => ctx.signal.throwIfAborted(),
        readerBudget(join(directory, 'turn-credits'), max),
      );
      const models = readerActivities(
        registration,
        project.rpc,
        profile,
        join(directory, 'sdk-effects'),
        gate.boundary,
      );
      const controls = readerControlActivities(registration, project.rpc, gate, project.authority);
      const reviews = reviewActivities(registration, project.rpc, profile);
      const admitted: {
        input: NonNullable<ReviewPlan['decisions'][number]['input']>;
        permit: ArtifactRef;
      }[] = [];
      runtime = {
        result: null,
        plan: null,
        async run(input) {
          const plan = await reviews.prepareReviewPlan(input);
          runtime.plan = plan;
          const activity = (reader: Parameters<typeof readerKey>[0]) =>
            new MockActivityEnvironment({
              workflowExecution: { workflowId: readerKey(reader), runId: 'unit-reader' },
            });
          if (mode === 'pending-list') {
            const reader = requireScoped(
              plan.decisions.find((row) => row.action === 'review')!.input,
            );
            await activity(reader).run(() => project.rpc.request('model/list', {}));
          }
          const answers = await Promise.all(
            plan.decisions.map(async (row) => {
              if (row.action !== 'review') {
                return { roleId: row.roleId, source: row.action, answer: row.answer };
              }
              const reader = requireScoped(row.input),
                prepared = prepareScopedReview(registration, reader);
              const permit = await controls.registerReader(reader, readerKey(reader));
              admitted.push({ input: reader, permit });
              const epoch = { permit, revision: 0, attempt: 0 },
                env = activity(reader);
              const runActivity = <R>(work: () => Promise<R>) =>
                env.run<[], R, () => Promise<R>>(work);
              const session = await runActivity(() => models.createReader(reader, prepared, epoch));
              const load = await runActivity(() =>
                models.loadReader(reader, prepared, session, epoch),
              );
              const answer = await runActivity(() =>
                models.answerReader(reader, prepared, session, load, epoch),
              );
              return {
                roleId: row.roleId,
                source: 'new',
                result: { status: 'answered', answer },
              };
            }),
          );
          const finished = await reviews.finishReview({
            schemaVersion: 1,
            input,
            plan: plan.manifest,
            answers: answers.map((row) => ({
              roleId: row.roleId,
              answer: 'result' in row ? row.result!.answer : row.answer!,
            })),
          });
          runtime.result = {
            status: mode === 'blocked' ? 'blocked' : 'reviewed',
            plan: plan.manifest,
            answers,
            ...finished,
          };
          return runtime.result;
        },
      };
      return {
        taskAdmissionsDirectory: null,
        async runUntil(run) {
          try {
            return await run();
          } finally {
            for (const entry of admitted) {
              const revision = await controls.freezeReader(entry.input, entry.permit);
              await controls.stopReader(entry.input, entry.permit, revision);
            }
            shutdowns.push('host-stopped');
          }
        },
      };
    },
  );
  let ordinal = 0;
  vi.spyOn(reviewClientModule, 'startReview').mockImplementation(async (_client, input) => {
    const current = runtime,
      id = reviewKey(input as ReviewInput),
      runId = 'unit-run-' + String(++ordinal);
    const handle = {
      workflowId: id,
      async result() {
        return current.run(input as ReviewInput);
      },
      async describe() {
        return { status: { name: mode === 'running' ? 'RUNNING' : 'COMPLETED' }, runId };
      },
      async fetchHistory() {
        if (mode === 'history') throw new Error('history missing');
        const payloads = (value: unknown) => ({
          payloads: [defaultPayloadConverter.toPayload(value)],
        });
        const events: Record<string, unknown>[] = [
          {
            eventId: '1',
            eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
            workflowExecutionStartedEventAttributes: {
              workflowType: { name: 'ReviewWorkflow' },
              originalExecutionRunId: runId,
              input: payloads(input),
            },
          },
        ];
        for (const row of current.plan!.decisions.filter((row) => row.action === 'review')) {
          const reader = requireScoped(row.input),
            childId = readerKey(reader),
            firstId = String(events.length + 1),
            startedId = String(events.length + 2);
          const returned = (
            object(current.result).answers as { roleId: string; result?: unknown }[]
          ).find((answer) => answer.roleId === row.roleId)!.result;
          events.push(
            {
              eventId: firstId,
              eventType: 'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED',
              startChildWorkflowExecutionInitiatedEventAttributes: {
                workflowId: childId,
                workflowType: { name: 'ControlledReaderWorkflow' },
                input: payloads(reader),
              },
            },
            {
              eventId: startedId,
              eventType: 'EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED',
              childWorkflowExecutionStartedEventAttributes: {
                initiatedEventId: firstId,
                workflowExecution: { workflowId: childId, runId: 'unit-child-' + firstId },
                workflowType: { name: 'ControlledReaderWorkflow' },
              },
            },
            {
              eventId: String(events.length + 3),
              eventType: 'EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_COMPLETED',
              childWorkflowExecutionCompletedEventAttributes: {
                initiatedEventId: firstId,
                startedEventId: startedId,
                workflowExecution: { workflowId: childId, runId: 'unit-child-' + firstId },
                workflowType: { name: 'ControlledReaderWorkflow' },
                result: payloads(returned),
              },
            },
          );
        }
        events.push({
          eventId: String(events.length + 1),
          eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
          workflowExecutionCompletedEventAttributes: { result: payloads(current.result) },
        });
        return temporal.api.history.v1.History.fromObject({ events });
      },
      async cancel() {
        throw new Error('unit cancel delivery unknown');
      },
    };
    if (mode === 'cancel-before-handle') controller.abort(new Error('early SDK cancellation'));
    return handle as unknown as Awaited<ReturnType<typeof startReview>>;
  });
  vi.spyOn(nativeRpcModule, 'createH02NativeRpc').mockImplementation((_ctx, label, options) => {
    if (mode === 'creation') throw new Error('creation unknown');
    let session: string | null = null;
    return {
      evidence: [],
      rpc: {
        async request(method, params) {
          if (method === 'model/list') {
            concurrency.modelLists++;
            if (mode === 'concurrent' && Number(label.split('-').at(-1)) <= 3) {
              if (concurrency.modelLists === 3) releaseLists();
              await listsReady;
            }
          }
          if (method === 'thread/loaded/list') return { data: session === null ? [] : [session] };
          if (method === 'turn/start') credits.push(await options!.startForTurn!(params));
          const result = await local.rpc.request(method, params);
          if (method === 'thread/start') {
            if (session !== null) throw new Error('unit-native-port-reused');
            concurrency.firstThreadLists ??= concurrency.modelLists;
            session = String(object(object(result).thread).id);
          }
          return result;
        },
        completed: local.rpc.completed,
      },
      async stop() {
        shutdowns.push(label);
        if (mode === 'late-cancel')
          controller.abort(new Error('late physical cleanup cancellation'));
        if (mode === 'port-stop') throw new Error('physical stop unknown');
        return pin('native-port-stop', {
          kind: 'comparison-h02-stop',
          executionVersion: 2,
          opId: ctx.opId,
          confirmed: mode !== 'stop-proof',
          remainingProcesses: [],
          sessions: session === null ? [] : [session],
        });
      },
    };
  });
  if (mode === 'opaque-artifact') store.publish(Buffer.from('opaque native artifact, not JSON'));
  if (mode === 'material') rmSync(join(workspace, 'pricing.json'));
  if (mode === 'unusual-boundary')
    vi.spyOn(h02TemporalModule, 'runH02TemporalCase').mockRejectedValue('unusual boundary failure');
  const services = {
    client: {
      connection: { withDeadline: async (_deadline: number, run: () => Promise<unknown>) => run() },
    },
    nativeConnection: {},
    taskQueue: 'h02-unit',
    workflowsPath: 'unused-by-mocked-worker',
  } as unknown as Parameters<typeof createH02NativeTemporalAdapter>[0];
  return {
    owner,
    ctx,
    store,
    shutdowns,
    credits,
    concurrency,
    execute: () => createH02NativeTemporalAdapter(services).execute(ctx),
  };
}

function fixture(clientVersion = '0.154.0') {
  const f = controlFixture();
  f.profile.clientVersion = clientVersion;
  f.input.preparation.project.roles.push({ id: 'backend', profile: 'backend.md' });
  for (const p of ['backend.md', 'front.ts', 'back.ts', 'shared.json'])
    writeFileSync(join(f.workspace, p), p);
  const request: ReviewRequest = {
    schemaVersion: 1,
    phase: 'planning',
    scope: 'feature',
    sharedPaths: ['shared.json'],
    roles: ['reviewer', 'backend'].map((roleId, i) => ({
      roleId,
      applies: true,
      reason: 'Own subsystem',
      paths: [i === 0 ? 'front.ts' : 'back.ts'],
      complete: true,
      attestedBy: 'project adapter',
      discoveryRule: 'declared-v1',
      history: { complete: true, answers: [] },
    })),
  };
  const threads = new Map<string, typeof f.response.thread>();
  const state = {
    starts: 0,
    sessions: 0,
    verdict: 'PASS' as ReviewReport['verdict'],
    coverage: 'complete' as ReviewReport['coverage'],
    onComplete: () => {},
    sameSession: false,
  };
  f.rpc.request.mockImplementation(async (method, params) => {
    if (method === 'model/list')
      return {
        data: [
          { model: f.profile.model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
        ],
      };
    if (method === 'thread/start') {
      const thread = { ...structuredClone(f.response.thread), id: 's' + String(++state.sessions) };
      if (state.sameSession) thread.id = 's1';
      if (!threads.has(thread.id)) threads.set(thread.id, thread);
      return { ...structuredClone(f.response), thread: structuredClone(thread) };
    }
    if (method === 'thread/resume')
      return {
        ...structuredClone(f.response),
        thread: structuredClone(threads.get(String(params.threadId))!),
      };
    if (method === 'thread/loaded/list') return { data: [...threads.keys()] };
    if (method === 'thread/read')
      return { thread: structuredClone(threads.get(String(params.threadId))!) };
    if (method === 'turn/start') {
      const thread = threads.get(String(params.threadId))!,
        message = (params.input as { text: string }[])[0]!.text;
      const marker = 'Пути и хеши: ',
        offset = message.indexOf(marker);
      let items: unknown[];
      if (offset >= 0) {
        const refs = JSON.parse(
          message.slice(offset + marker.length, message.indexOf('. Для больших', offset)),
        ) as { path: string; sha256: string }[];
        items = [
          {
            type: 'commandExecution',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: refs
              .map((ref) => JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }))
              .join('\n'),
          },
        ];
      } else {
        const begin = message.indexOf('Markdown: ') + 'Markdown: '.length;
        const report = JSON.parse(
          message.slice(begin, message.indexOf('. PASS несовместим', begin)),
        ) as ReviewReport;
        report.verdict = state.verdict;
        report.coverage = state.coverage;
        report.findings =
          state.verdict === 'FAIL' ? [{ id: 'defect', blocking: true, text: 'Fix required' }] : [];
        report.limitations = [];
        items = [{ type: 'agentMessage', text: JSON.stringify(report) }];
      }
      const turn = {
        id: 't' + String(++state.starts),
        status: 'completed',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: message }] }, ...items],
      };
      thread.turns.push(turn);
      return { turn: { id: turn.id } };
    }
    throw new Error('unexpected rpc');
  });
  f.rpc.completed.mockImplementation(async () => {
    state.onComplete();
  });
  const activity = reviewActivities(f.registration, f.rpc, f.profile);
  const input = (id = 'round-1'): ReviewInput => ({
    schemaVersion: 1,
    preparation: f.input.preparation,
    reviewId: id,
    request: f.save(request),
  });
  async function run(row: ReviewPlan['decisions'][number]) {
    const reader = requireScoped(row.input),
      prepared = prepareScopedReview(f.registration, reader);
    const actor = readerActivities(f.registration, f.rpc, f.profile, join(f.root, 'effects'));
    const session = await actor.createReader(reader, prepared),
      load = await actor.loadReader(reader, prepared, session);
    const answer = await actor.answerReader(reader, prepared, session, load);
    return { reader, prepared, session, load, answer };
  }
  const data = (ref: ArtifactRef) =>
    JSON.parse(f.store.read(ref).toString()) as Record<string, unknown>;
  async function baseline() {
    const plan = await activity.prepareReviewPlan(input());
    const results = [];
    for (const row of plan.decisions) results.push(await run(row));
    results.forEach((r, i) => request.roles[i]!.history.answers.push(r.answer));
    return { plan, results };
  }
  return {
    ...f,
    rawReaderInput: f.input,
    request,
    threads,
    state,
    activity,
    input,
    run,
    data,
    baseline,
  };
}
describe('scoped role review and reuse', () => {
  it('routes native H02 through two SDK review rounds and only completes after host and port STOP', async () => {
    const f = nativeSdkFixture();
    try {
      const result = await f.execute();
      expect(result.outcome).toBe('completed');
      const projection = object(h01ReadJson(result.projection));
      expect(projection).toMatchObject({
        kind: 'comparison-h02-native-projection',
        scenario: 'H-02',
        opId: f.ctx.opId,
        engine: 'temporal',
        sdk: true,
      });
      expect(projection.workflowEvidence).toHaveLength(2);
      const refs = projection.workflowEvidence as { locator: string; hash: string }[];
      expect(refs.map((ref) => object(h01ReadJson(ref)).round)).toEqual(['initial', 'repaired']);
      expect(refs.map((ref) => object(h01ReadJson(ref)).status)).toEqual([
        'COMPLETED',
        'COMPLETED',
      ]);
      for (const ref of refs) {
        const proof = object(h01ReadJson(ref));
        const history = object(h01ReadJson(proof.history as { locator: string; hash: string }));
        const decoded = temporal.api.history.v1.History.fromObject(object(history.history));
        const started = decoded.events![0]!.workflowExecutionStartedEventAttributes!;
        const completed = decoded.events!.at(-1)!.workflowExecutionCompletedEventAttributes!;
        expect(defaultPayloadConverter.fromPayload(started.input!.payloads![0]!)).toEqual(
          proof.input,
        );
        expect(defaultPayloadConverter.fromPayload(completed.result!.payloads![0]!)).toEqual(
          proof.result,
        );
        for (const event of decoded.events!)
          if (
            event.startChildWorkflowExecutionInitiatedEventAttributes !== null &&
            event.startChildWorkflowExecutionInitiatedEventAttributes !== undefined
          ) {
            const child = event.startChildWorkflowExecutionInitiatedEventAttributes;
            const input = defaultPayloadConverter.fromPayload(child.input!.payloads![0]!);
            expect(child.workflowId).toBe(readerKey(input as Parameters<typeof readerKey>[0]));
          }
      }
      const report = object(
        h01ReadJson(projection.caseReport as { locator: string; hash: string }),
      );
      expect(report).toMatchObject({
        sdk: true,
        outcome: 'accepted',
        effects: { threadStarts: 4, turnStarts: 8 },
      });
      expect(f.credits).toHaveLength(8);
      expect(f.credits.every((credit) => object(credit).origin === 'temporal-host')).toBe(true);
      expect(f.shutdowns).toEqual([
        'host-stopped',
        'host-stopped',
        'temporal-reader-1',
        'temporal-reader-2',
        'temporal-reader-3',
        'temporal-reader-4',
      ]);
      expect(object(h01ReadJson(result.stop)).confirmed).toBe(true);
      expect(object(h01ReadJson(result.nativeAcceptance!)).complete).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  }, 30_000);
  it.each(['pending-list', 'opaque-artifact', 'concurrent'])(
    'keeps SDK H02 evidence valid with %s',
    async (mode) => {
      const f = nativeSdkFixture(mode);
      try {
        expect((await f.execute()).outcome).toBe('completed');
        if (mode === 'concurrent')
          expect(f.concurrency).toEqual({ modelLists: 4, firstThreadLists: 3 });
      } finally {
        vi.restoreAllMocks();
      }
    },
    30_000,
  );
  it.each([
    'blocked',
    'running',
    'history',
    'creation',
    'port-stop',
    'stop-proof',
    'cancel-before-handle',
    'late-cancel',
    'material',
    'unusual-boundary',
  ])(
    'does not accept native H02 SDK outcome with %s',
    async (mode) => {
      const f = nativeSdkFixture(mode);
      try {
        const result = await f.execute();
        expect(result.outcome).toBe('unknown');
        expect(result.nativeAcceptance).toBeNull();
        if (['creation', 'port-stop', 'stop-proof'].includes(mode))
          expect(object(h01ReadJson(result.stop)).confirmed).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    },
    30_000,
  );
  it('runs fixed H02 through real activities with primary FAIL→PASS and exact unchanged reuse', async () => {
    const owner = controlFixture(),
      ctx = createH02TemporalFixture(join(owner.root, 'h02'));
    const result = await runH02TemporalCase(ctx);
    expect(result).toMatchObject({
      variant: 'temporal',
      engine: 'temporal-activities',
      outcome: 'accepted',
      blocking: [],
      effects: {
        threadStarts: 4,
        turnStarts: 8,
        byPhase: {
          initial: { threadStarts: 3, turnStarts: 6 },
          repaired: { threadStarts: 1, turnStarts: 2 },
        },
      },
      nativeUsage: null,
      physicalStop: null,
      nativeAcceptance: false,
      qualification: false,
      partialScope: true,
    });
    expect(Object.values(result.checks)).toEqual(Array(7).fill(true));
    expect(result.probes).toHaveLength(8);
    expect(result.probes.find((probe) => probe.name === 'missing-role')!.error).toBe(
      'review-role-selection-incomplete',
    );
    expect(
      result.probes.find((probe) => probe.name === 'incomplete-map')!.completion!.complete,
    ).toBe(false);
    const artifacts = artifactStore(ctx.registration.artifactRoot);
    const initial = result.rounds[0]!,
      repaired = result.rounds[1]!;
    expect(initial.completion!.complete).toBe(false);
    expect(repaired.completion!.complete).toBe(true);
    const report = (ref: ArtifactRef) => object(JSON.parse(artifacts.read(ref).toString()));
    expect(object(report(initial.readers[0]!.answer!).report).verdict).toBe('FAIL');
    expect(object(report(repaired.readers[0]!.answer!).report).verdict).toBe('PASS');
    expect(repaired.plan.decisions[1]!.answer).toEqual(initial.readers[1]!.answer);
    expect(repaired.plan.decisions[2]!.answer).toEqual(initial.readers[2]!.answer);
    const acceptedInput = report(repaired.input.request);
    const pricingHistory = object((acceptedInput.roles as Record<string, unknown>[])[0]).history;
    expect((object(pricingHistory).answers as ArtifactRef[])[0]).toEqual(
      initial.readers[0]!.answer,
    );
    for (const round of result.rounds)
      for (const reader of round.readers) expect(report(reader.stop!).confirmed).toBe(true);
  }, 30_000);
  it('stops H02 at the actual turn budget and does not fake a replacement answer', async () => {
    const owner = controlFixture(),
      ctx = createH02TemporalFixture(join(owner.root, 'h02-cap'));
    ctx.maxTurnStarts = 6;
    const result = await runH02TemporalCase(ctx);
    expect(result.outcome).toBe('unknown');
    expect(result.effects).toMatchObject({ threadStarts: 4, turnStarts: 6 });
    expect(result.blocking[0]).toContain('reader-model-budget-exhausted');
    expect(result.rounds[1]!.readers[0]!.answer).toBeNull();
    expect(result.rounds[1]!.readers[0]!.stop).not.toBeNull();
  });
  it('preserves unknown H02 STOP and prevents the next role from starting', async () => {
    const owner = controlFixture(),
      ctx = createH02TemporalFixture(join(owner.root, 'h02-stop'));
    const request = ctx.rpc.request.bind(ctx.rpc);
    let completedReads = 0;
    ctx.rpc.request = async (method, params) => {
      const response = await request(method, params);
      if (
        method === 'thread/read' &&
        (object(object(response).thread).turns as unknown[]).length === 2 &&
        ++completedReads >= 2
      )
        throw new Error('h02-test-stop-unavailable');
      return response;
    };
    const result = await runH02TemporalCase(ctx);
    expect(result.outcome).toBe('unknown');
    expect(result.blocking).toContain('h02-reader-stop-unknown');
    expect(result.effects).toMatchObject({ threadStarts: 1, turnStarts: 2 });
    expect(result.rounds[0]!.readers[0]!.stop).toBeNull();
  });
  it('rejects changed primary H02 history during reuse before any dependent model starts', async () => {
    const owner = controlFixture(),
      ctx = createH02TemporalFixture(join(owner.root, 'h02-primary'));
    const request = ctx.rpc.request.bind(ctx.rpc);
    ctx.rpc.request = async (method, params) => {
      const response = await request(method, params);
      if (
        method === 'thread/read' &&
        object(
          JSON.parse(readFileSync(join(ctx.registration.workspaceRoot, 'pricing.json'), 'utf8')),
        ).rate === 7
      ) {
        const thread = object(object(response).thread),
          turns = thread.turns as Record<string, unknown>[];
        const items = turns.at(-1)!.items as Record<string, unknown>[];
        items.find((item) => item.type === 'agentMessage')!.text = 'changed primary answer';
      }
      return response;
    };
    const result = await runH02TemporalCase(ctx);
    expect(result.outcome).toBe('unknown');
    expect(result.blocking[0]).toContain('review-history-turn-mismatch');
    expect(result.effects).toMatchObject({ threadStarts: 3, turnStarts: 6 });
  });
  it('refuses cancelled H02 input and an incomplete declared project before dispatch', async () => {
    for (const failure of ['cancel', 'roles'] as const) {
      const owner = controlFixture(),
        controller = new AbortController();
      const ctx = createH02TemporalFixture(join(owner.root, 'h02-' + failure), controller.signal);
      if (failure === 'cancel') controller.abort(new Error('fixed H02 cancelled'));
      else ctx.preparation.project.roles.pop();
      const result = await runH02TemporalCase(ctx);
      expect(result.outcome).toBe('unknown');
      expect(result.effects).toMatchObject({ threadStarts: 0, turnStarts: 0 });
    }
  });
  it('does not convert unusual provider/probe failures into H02 PASS', async () => {
    for (const failure of ['provider', 'probe'] as const) {
      const owner = controlFixture(),
        ctx = createH02TemporalFixture(join(owner.root, 'h02-' + failure));
      const request = ctx.rpc.request.bind(ctx.rpc);
      let repaired = false,
        lost = false;
      ctx.rpc.request = async (method, params) => {
        if (failure === 'provider' && method === 'model/list') throw 'private provider failure';
        const response = await request(method, params);
        if (method === 'turn/start' && params.threadId === 'h02-session-4') repaired = true;
        if (
          failure === 'probe' &&
          repaired &&
          !lost &&
          method === 'thread/read' &&
          params.threadId === 'h02-session-1'
        ) {
          lost = true;
          throw 'private probe failure';
        }
        return response;
      };
      const report = await runH02TemporalCase(ctx);
      expect(report.outcome).toBe('unknown');
      if (failure === 'provider') expect(report.blocking).toContain('h02-unknown');
      else {
        expect(report.checks['unchanged-pass']).toBe(false);
        expect(report.probes.find((probe) => probe.name === 'unchanged')!.error).toBe(
          'unknown-probe-failure',
        );
      }
      expect(JSON.stringify(report)).not.toContain('private provider failure');
      expect(JSON.stringify(report)).not.toContain('private probe failure');
    }
  }, 30_000);
  it('keeps the fixed H02 port interruptible and refuses human command authority', async () => {
    const owner = controlFixture(),
      ctx = createH02TemporalFixture(join(owner.root, 'h02-port'));
    const started = object(await ctx.rpc.request('thread/start', {})),
      threadId = String(object(started.thread).id);
    const turn = object(
      await ctx.rpc.request('turn/start', {
        threadId,
        input: [{ text: 'Пути и хеши: []. Для больших' }],
      }),
    );
    const turnId = String(object(turn.turn).id);
    await expect(ctx.rpc.request('turn/interrupt', { threadId, turnId })).resolves.toEqual({});
    await expect(ctx.rpc.completed(threadId, turnId)).resolves.toBeUndefined();
    await expect(
      ctx.rpc.request('turn/interrupt', { threadId: 'missing', turnId }),
    ).rejects.toThrow('h02-fixture-turn');
    await expect(ctx.authority.verify(owner.command())).rejects.toThrow(
      'h02-fixture-no-human-command-authority',
    );
  });
  it('keeps cancellation sticky after repaired H02 while preserving primary history and allowing cleanup reads', async () => {
    const owner = controlFixture(),
      controller = new AbortController();
    const ctx = createH02TemporalFixture(join(owner.root, 'h02-late-cancel'), controller.signal);
    const request = ctx.rpc.request.bind(ctx.rpc);
    let repaired = false,
      modelAfterCancel = 0;
    ctx.rpc.request = async (method, params) => {
      if (controller.signal.aborted && ['thread/start', 'turn/start'].includes(method))
        modelAfterCancel++;
      const response = await request(method, params);
      if (method === 'turn/start' && params.threadId === 'h02-session-4') repaired = true;
      if (repaired && method === 'thread/read' && params.threadId === 'h02-session-1')
        controller.abort(new Error('H02 late cancellation'));
      return response;
    };
    const result = await runH02TemporalCase(ctx);
    expect(result.outcome).toBe('unknown');
    expect(result.blocking).toContain('h02-cancelled');
    expect(result.effects).toMatchObject({ threadStarts: 4, turnStarts: 8 });
    expect(modelAfterCancel).toBe(0);
    const store = artifactStore(ctx.registration.artifactRoot);
    const first = object(JSON.parse(store.read(result.rounds[0]!.readers[0]!.answer!).toString()));
    expect(object(first.report).verdict).toBe('FAIL');
    expect(result.rounds[1]!.completion!.complete).toBe(true);
    expect(result.probes.map((probe) => probe.name)).toEqual(['unchanged']);
    expect(
      JSON.parse(readFileSync(join(ctx.registration.workspaceRoot, 'pricing.json'), 'utf8')),
    ).toEqual({ rate: 7 });
  }, 30_000);
  it.each(['legacy', 'lost-during-proof'] as const)(
    'refuses review completion before publication for %s',
    async (mode) => {
      const f = fixture();
      const { plan, results } = await f.baseline();
      const completion = {
        schemaVersion: 1 as const,
        input: f.data(plan.manifest).input as ReviewInput,
        plan: plan.manifest,
        answers: results.map((result, i) => ({
          roleId: f.request.roles[i]!.roleId,
          answer: result.answer,
        })),
      };
      execFileSync('git', ['init', '--quiet'], { cwd: f.workspace });
      declareBackendFixture(f.workspace);
      const home = taskBackendHome(f.workspace);
      mkdirSync(home);
      writeFileSync(
        join(home, 'backend-policy.json'),
        JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
      );
      reserveTaskBackend(f.workspace, {
        schemaVersion: 1,
        projectId: 'neutral',
        taskId: 'one',
        backend: mode === 'legacy' ? 'legacy' : 'temporal',
        cardName: 'one.md',
        origin: 'a'.repeat(64),
      });
      const activity = reviewActivities(f.registration, f.rpc, f.profile);
      const before = readdirSync(f.registration.artifactRoot).sort();
      if (mode === 'lost-during-proof') {
        const original = f.rpc.request.getMockImplementation()!;
        f.rpc.request.mockImplementation(async (method, params) => {
          if (method === 'thread/read') rmSync(home, { recursive: true, force: true });
          return original(method, params);
        });
      }
      await expect(activity.finishReview(completion)).rejects.toThrow(
        mode === 'legacy' ? 'backend-route-conflict' : 'backend-policy-required',
      );
      expect(readdirSync(f.registration.artifactRoot).sort()).toEqual(before);
    },
  );
  it('verifies the new client primary LOAD/answers, reuses only its exact profile and preserves the old client boundary', async () => {
    const f = fixture('0.165.0-alpha.1.2');
    await f.baseline();
    expect(f.state.starts).toBe(4);
    expect(
      (await f.activity.prepareReviewPlan(f.input('same-client'))).decisions.map(
        (row) => row.action,
      ),
    ).toEqual(['reuse', 'reuse']);
    const previousClient = reviewActivities(f.registration, f.rpc, {
      ...f.profile,
      clientVersion: '0.154.0',
    });
    expect(
      (await previousClient.prepareReviewPlan(f.input('previous-client'))).decisions.every(
        (row) => row.action === 'review' && row.reasons.includes('model-profile-changed'),
      ),
    ).toBe(true);
    expect(f.state.starts).toBe(4);
  });
  function evidencePacket(f: ReturnType<typeof fixture>) {
    const paths = [
      ...new Set([
        ...f.registration.project.rules,
        ...f.registration.project.roles.map((r) => r.profile),
        f.rawReaderInput.preparation.card,
        ...f.request.sharedPaths,
        ...f.request.roles.flatMap((r) => r.paths),
      ]),
    ];
    const expectedFiles = paths.map((path) => {
      const bytes = readFileSync(join(f.workspace, path));
      return { path, sha256: f.save('unused').sha256, bytes: bytes.length };
    });
    for (const file of expectedFiles)
      file.sha256 = f.store.publish(readFileSync(join(f.workspace, file.path))).sha256;
    const packet = {
      schemaVersion: 2 as const,
      evidence: [f.save({ kind: 'checks', logs: ['actual log'] })],
      expectedFiles,
    };
    Object.assign(f.request, packet);
    return packet;
  }
  it('LOADs immutable B1 evidence, rechecks its primary bytes on reuse and invalidates a changed packet', async () => {
    const f = fixture(),
      packet = evidencePacket(f);
    const { results } = await f.baseline();
    for (const result of results)
      expect(scopedReviewInputs(f.registration, result.reader).refs).toContainEqual({
        path: f.store.path(packet.evidence[0]!),
        sha256: packet.evidence[0]!.sha256,
      });
    expect(
      (await f.activity.prepareReviewPlan(f.input('unchanged'))).decisions.map((d) => d.action),
    ).toEqual(['reuse', 'reuse']);
    packet.evidence.push(f.save({ kind: 'checks', logs: ['new log'] }));
    expect(
      (await f.activity.prepareReviewPlan(f.input('changed'))).decisions.every((d) =>
        d.reasons.includes('evidence-changed'),
      ),
    ).toBe(true);
  });
  it.each(['empty', 'duplicate', 'stale', 'missing'])(
    'rejects an incomplete frozen acceptance file inventory: %s',
    async (defect) => {
      const f = fixture(),
        packet = evidencePacket(f);
      if (defect === 'empty') packet.expectedFiles = [];
      if (defect === 'duplicate') packet.expectedFiles.push(packet.expectedFiles[0]!);
      if (defect === 'stale')
        writeFileSync(join(f.workspace, packet.expectedFiles[0]!.path), 'foreign');
      if (defect === 'missing')
        packet.expectedFiles = packet.expectedFiles.filter((file) => file.path !== 'front.ts');
      Object.assign(f.request, packet);
      await expect(f.activity.prepareReviewPlan(f.input())).rejects.toThrow();
      expect(f.rpc.request).not.toHaveBeenCalled();
    },
  );
  it('rejects compaction between the original LOAD and answer but permits later compaction', async () => {
    const f = fixture();
    const { results } = await f.baseline();
    const turns = f.threads.get(results[0]!.session.id)!.turns;
    const compaction = {
      id: 'compaction',
      status: 'completed',
      items: [{ type: 'contextCompaction' }],
    };
    turns.push(compaction);
    expect(
      (await f.activity.prepareReviewPlan(f.input('later-compaction'))).decisions.map(
        (row) => row.action,
      ),
    ).toEqual(['reuse', 'reuse']);
    turns.pop();
    turns.splice(1, 0, compaction);
    await expect(f.activity.prepareReviewPlan(f.input('invalid-context'))).rejects.toThrow(
      'review-history-context-invalid',
    );
    turns.splice(1, 1);
    turns.reverse();
    await expect(f.activity.prepareReviewPlan(f.input('answer-before-load'))).rejects.toThrow(
      'review-history-context-invalid',
    );
    expect(f.state.starts).toBe(4);
  });
  it('rejects shared native identity across roles despite individually valid turns', async () => {
    const f = fixture();
    f.state.sameSession = true;
    const { plan, results } = await f.baseline();
    await expect(f.activity.prepareReviewPlan(f.input('next'))).rejects.toThrow(
      'review-history-independent-session-required',
    );
    await expect(
      f.activity.finishReview({
        schemaVersion: 1,
        input: f.data(plan.manifest).input as ReviewInput,
        plan: plan.manifest,
        answers: results.map((r, i) => ({ roleId: f.request.roles[i]!.roleId, answer: r.answer })),
      }),
    ).rejects.toThrow('review-history-independent-session-required');
  });
  it('rechecks complete result packages and never turns missing, partial or failed work into complete', async () => {
    const f = fixture(),
      { plan, results } = await f.baseline();
    const input = f.data(plan.manifest).input as ReviewInput;
    const completion = {
      schemaVersion: 1 as const,
      input,
      plan: plan.manifest,
      answers: results.map((r, i) => ({
        roleId: f.request.roles[i]!.roleId,
        answer: r.answer as ArtifactRef | null,
      })),
    };
    const result = await f.activity.finishReview(completion);
    expect(result.complete).toBe(true);
    expect(f.data(result.manifest).kind).toBe('reader-review-result');
    expect(
      (
        await f.activity.finishReview({
          ...completion,
          answers: completion.answers.map((a) => ({ ...a, answer: null })),
        })
      ).complete,
    ).toBe(false);
    const reused = await f.activity.prepareReviewPlan(f.input('reused'));
    expect(
      (
        await f.activity.finishReview({
          ...completion,
          input: f.data(reused.manifest).input as ReviewInput,
          plan: reused.manifest,
        })
      ).complete,
    ).toBe(true);
    writeFileSync(join(f.workspace, 'front.ts'), 'changed');
    await expect(f.activity.finishReview(completion)).rejects.toThrow('review-input-changed');
    writeFileSync(join(f.workspace, 'front.ts'), 'front.ts');
    for (const change of [
      { schemaVersion: 2 },
      { plan: f.proof },
      { answers: null },
      { answers: [] },
      { answers: [completion.answers[0], completion.answers[0]] },
    ])
      await expect(
        f.activity.finishReview({ ...completion, ...change } as typeof completion),
      ).rejects.toThrow();
    const planBody = f.data(plan.manifest),
      decisions = planBody.decisions as ReviewPlan['decisions'];
    decisions[0]!.action = 'not-applicable';
    await expect(
      f.activity.finishReview({ ...completion, plan: f.save(planBody) }),
    ).rejects.toThrow('review-completion-unexpected-answer');
    decisions[0]!.action = 'blocked';
    expect(
      (await f.activity.finishReview({ ...completion, plan: f.save(planBody) })).complete,
    ).toBe(false);
    decisions[0]!.action = 'review';
    const legacy = f.save({ kind: 'reader-answer', roleId: 'reviewer' });
    await expect(
      f.activity.finishReview({
        ...completion,
        answers: [{ roleId: 'reviewer', answer: legacy }, completion.answers[1]!],
      }),
    ).rejects.toThrow('review-completion-unqualified');
    const other = reviewActivities(f.registration, f.rpc, { ...f.profile, model: 'other' });
    await expect(other.finishReview(completion)).rejects.toThrow('review-completion-stale');
  });
  it('preserves non-PASS, partial and unknown completeness in final evidence', async () => {
    for (const change of ['fail', 'partial', 'dependencies', 'history'] as const) {
      const f = fixture();
      if (change === 'fail') f.state.verdict = 'FAIL';
      if (change === 'partial') f.state.coverage = 'partial';
      if (change === 'dependencies') f.request.roles[0]!.complete = false;
      if (change === 'history') f.request.roles[0]!.history.complete = false;
      const { plan, results } = await f.baseline();
      const result = await f.activity.finishReview({
        schemaVersion: 1,
        input: f.data(plan.manifest).input as ReviewInput,
        plan: plan.manifest,
        answers: results.map((r, i) => ({ roleId: f.request.roles[i]!.roleId, answer: r.answer })),
      });
      expect(result.complete).toBe(false);
    }
    const f = fixture();
    for (const role of f.request.roles) role.applies = false;
    const plan = await f.activity.prepareReviewPlan(f.input());
    expect(
      (
        await f.activity.finishReview({
          schemaVersion: 1,
          input: f.data(plan.manifest).input as ReviewInput,
          plan: plan.manifest,
          answers: f.request.roles.map((r) => ({ roleId: r.roleId, answer: null })),
        })
      ).complete,
    ).toBe(true);
  });
  it('rejects stale source substitution during completion and mismatched reuse receipts', async () => {
    const f = fixture(),
      { plan, results } = await f.baseline(),
      next = await f.activity.prepareReviewPlan(f.input('next'));
    const completion = {
      schemaVersion: 1 as const,
      input: f.data(next.manifest).input as ReviewInput,
      plan: next.manifest,
      answers: results.map((r, i) => ({ roleId: f.request.roles[i]!.roleId, answer: r.answer })),
    };
    const packet = f.data(next.manifest),
      rows = packet.decisions as ReviewPlan['decisions'];
    rows[0]!.action = 'review';
    await expect(f.activity.finishReview({ ...completion, plan: f.save(packet) })).rejects.toThrow(
      'review-completion-target-mismatch',
    );
    rows[0]!.action = 'reuse';
    rows[0]!.answer = f.proof;
    await expect(f.activity.finishReview({ ...completion, plan: f.save(packet) })).rejects.toThrow(
      'review-completion-reuse-mismatch',
    );
    expect(plan.manifest).not.toEqual(next.manifest);
  });
  it('loads only own subject files and reuses complete primary PASS without model effects', async () => {
    const f = fixture(),
      { results } = await f.baseline();
    expect(f.state.starts).toBe(4);
    const front = f.data(results[0]!.load).refs as { path: string }[];
    expect(front.map((r) => r.path)).toEqual(
      ['RULES.md', 'reviewer.md', 'tasks/one.md', 'shared.json', 'front.ts'].map((p) =>
        join(f.workspace, p),
      ),
    );
    expect(front.some((r) => r.path.endsWith('back.ts'))).toBe(false);
    const plan = await f.activity.prepareReviewPlan(f.input('round-2'));
    expect(plan.decisions.map((r) => r.action)).toEqual(['reuse', 'reuse']);
    expect(f.state.starts).toBe(4);
    expect(f.state.sessions).toBe(2);
    const manifest = f.data(plan.manifest);
    expect(manifest.kind).toBe('reader-review-plan');
    writeFileSync(join(f.workspace, 'front.ts'), 'local fix');
    const local = await f.activity.prepareReviewPlan(f.input('round-3'));
    expect(local.decisions.map((r) => r.action)).toEqual(['review', 'reuse']);
    expect(local.decisions[0]!.reasons).toContain('input-changed:front.ts');
    const fixed = await f.run(local.decisions[0]!);
    f.request.roles[0]!.history.answers.push(fixed.answer);
    expect(
      (await f.activity.prepareReviewPlan(f.input('round-4'))).decisions.map((r) => r.action),
    ).toEqual(['reuse', 'reuse']);
    writeFileSync(join(f.workspace, 'shared.json'), 'common change');
    expect(
      (await f.activity.prepareReviewPlan(f.input('round-5'))).decisions.map((r) => r.action),
    ).toEqual(['review', 'review']);
  });
  it('preserves an open FAIL even for a now inapplicable role, and closes it only with a new complete PASS', async () => {
    const f = fixture();
    f.state.verdict = 'FAIL';
    const { results } = await f.baseline();
    f.request.roles[0]!.applies = false;
    const failed = await f.activity.prepareReviewPlan(f.input('round-2'));
    expect(failed.decisions.map((r) => r.action)).toEqual(['review', 'review']);
    expect(failed.decisions[0]!.reasons).toContain('open-failure');
    f.state.verdict = 'PASS';
    const fixed = await f.run(failed.decisions[0]!);
    f.request.roles[0]!.history.answers.push(fixed.answer);
    const next = await f.activity.prepareReviewPlan(f.input('round-3'));
    expect(next.decisions[0]!.action).toBe('not-applicable');
    expect((f.data(results[0]!.answer).report as ReviewReport).verdict).toBe('FAIL');
    f.request.roles[0]!.history.answers = [fixed.answer];
    await expect(f.activity.prepareReviewPlan(f.input('omitted-failure'))).rejects.toThrow(
      'review-history-chain-incomplete',
    );
  });
  it('opens partial, unknown dependency/history, changed discovery, obligations, phase, requirements and model profile', async () => {
    const f = fixture();
    f.state.coverage = 'partial';
    await f.baseline();
    expect(
      (await f.activity.prepareReviewPlan(f.input('partial'))).decisions[0]!.reasons,
    ).toContain('partial-review');
    f.state.coverage = 'complete';
    const repaired = await f.activity.prepareReviewPlan(f.input('complete'));
    for (const [i, row] of repaired.decisions.entries())
      f.request.roles[i]!.history.answers.push((await f.run(row)).answer);
    for (const change of [
      { complete: false, attestedBy: '', discoveryRule: '' },
      { history: { complete: false, answers: [...f.request.roles[0]!.history.answers] } },
      { reason: 'Changed obligation' },
      { discoveryRule: 'v2' },
    ]) {
      const original = f.request.roles[0]!;
      f.request.roles[0] = { ...original, ...change };
      expect((await f.activity.prepareReviewPlan(f.input('mutation'))).decisions[0]!.action).toBe(
        'review',
      );
      f.request.roles[0] = original;
    }
    f.request.phase = 'acceptance';
    expect(
      (await f.activity.prepareReviewPlan(f.input('acceptance'))).decisions[0]!.reasons,
    ).toContain('review-target-changed');
    f.request.phase = 'planning';
    f.input().preparation.revision = 2;
    expect(
      (await f.activity.prepareReviewPlan(f.input('requirements'))).decisions[0]!.reasons,
    ).toContain('requirements-changed');
    f.input().preparation.revision = 1;
    const other = reviewActivities(f.registration, f.rpc, { ...f.profile, model: 'other' });
    expect((await other.prepareReviewPlan(f.input('model'))).decisions[0]!.reasons).toContain(
      'model-profile-changed',
    );
  });
  it('refuses all dependent effects when another role lacks an input or checks are unregistered', async () => {
    const f = fixture();
    rmSync(join(f.workspace, 'back.ts'));
    await expect(f.activity.prepareReviewPlan(f.input())).rejects.toThrow('ENOENT');
    expect(f.rpc.request).not.toHaveBeenCalled();
    f.registration.commands.syntax.executable = '';
    await expect(
      reviewActivities(f.registration, f.rpc, f.profile).prepareReviewPlan(f.input()),
    ).rejects.toThrow('review-check-unregistered');
    delete (f.registration.commands as Partial<typeof f.registration.commands>).syntax;
    await expect(
      reviewActivities(f.registration, f.rpc, f.profile).prepareReviewPlan(f.input()),
    ).rejects.toThrow('review-check-unregistered');
  });
  it('records N/A and unknown applicability and has no arbitrary file/role count limit', async () => {
    const f = fixture();
    f.request.roles[0]!.applies = false;
    f.request.roles[1]!.applies = null;
    const plan = await f.activity.prepareReviewPlan(f.input());
    expect(plan.decisions.map((r) => r.action)).toEqual(['not-applicable', 'blocked']);
    expect(f.state.starts).toBe(0);
    f.request.roles[0]!.history.complete = false;
    expect((await f.activity.prepareReviewPlan(f.input('history'))).decisions[0]!.action).toBe(
      'review',
    );
    f.request.roles[0]!.applies = true;
    for (let i = 0; i < 129; i++) {
      const path = `subject-${i}`;
      writeFileSync(join(f.workspace, path), '');
      f.request.roles[0]!.paths.push(path);
    }
    expect(
      (await f.activity.prepareReviewPlan(f.input('large'))).decisions[0]!.input,
    ).not.toBeNull();
  });
  it('rejects legacy evidence for reuse and validates all files again after primary reconciliation', async () => {
    const f = fixture(),
      legacy = f.save({ kind: 'reader-answer', roleId: 'reviewer' });
    f.request.roles[0]!.history.answers = [legacy];
    const plan = await f.activity.prepareReviewPlan(f.input());
    expect(plan.decisions[0]!.reasons).toContain('legacy-unqualified');
    const reviewed = await f.run(plan.decisions[0]!);
    f.request.roles[0]!.history.answers.push(reviewed.answer);
    expect((await f.activity.prepareReviewPlan(f.input('fresh'))).decisions[0]!.action).toBe(
      'reuse',
    );
    const primary = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (m, p) => {
      const result = await primary(m, p);
      if (m === 'thread/read') writeFileSync(join(f.workspace, 'front.ts'), 'late change');
      return result;
    });
    await expect(f.activity.prepareReviewPlan(f.input('late'))).rejects.toThrow(
      'review-input-changed',
    );
  });
  it('binds scoped input, preparation, permission and model result to exact immutable bytes', async () => {
    const f = fixture(),
      plan = await f.activity.prepareReviewPlan(f.input()),
      input = requireScoped(plan.decisions[0]!.input);
    expect(readerKey(input)).toContain('/' + input.reviewId);
    expect(parseReaderInput(input)).toEqual(input);
    expect(() => parseReaderInput({ ...input, schemaVersion: 3 })).toThrow(
      'reader-schema-version-unsupported',
    );
    expect(() => requireScoped(f.rawReaderInput)).toThrow('review-scoped-reader-required');
    const prepared = prepareScopedReview(f.registration, input);
    expect(() =>
      confirmScopedPreparation(f.registration, input, { ...prepared, manifest: f.proof }),
    ).toThrow('review-preparation-mismatch');
    const actor = readerActivities(f.registration, f.rpc, f.profile, join(f.root, 'effects')),
      session = await actor.createReader(input, prepared);
    f.state.onComplete = () => writeFileSync(join(f.workspace, 'front.ts'), 'changed during LOAD');
    await expect(actor.loadReader(input, prepared, session)).rejects.toThrow(
      'review-input-changed',
    );
    writeFileSync(join(f.workspace, 'front.ts'), 'front.ts');
    f.state.onComplete = () => {};
    const load = await actor.loadReader(input, prepared, session);
    f.state.onComplete = () =>
      writeFileSync(join(f.workspace, 'front.ts'), 'changed during answer');
    await expect(actor.answerReader(input, prepared, session, load)).rejects.toThrow(
      'review-input-changed',
    );
  });
  it.each(['id', 'cwd', 'turns', 'busy', 'duplicate', 'changed', 'missing-message', 'read-error'])(
    'does not trust altered, busy, unavailable or ambiguous primary histories: %s',
    async (defect) => {
      const f = fixture(),
        { results } = await f.baseline(),
        thread = f.threads.get(results[0]!.session.id)!;
      if (defect === 'id') thread.id = 'foreign';
      if (defect === 'cwd') thread.cwd = 'foreign';
      if (defect === 'turns') thread.turns = null as never;
      if (defect === 'busy') thread.turns[0]!.status = 'inProgress';
      if (defect === 'duplicate') thread.turns.push(thread.turns[0]!);
      if (defect === 'changed') thread.turns[0]!.extra = 'changed';
      if (defect === 'missing-message') {
        const answer = f.data(results[0]!.answer),
          load = f.data(results[0]!.load);
        const observed = thread.turns[0]!;
        observed.items = (observed.items as unknown[]).slice(1);
        load.observed = observed;
        answer.load = f.save(load);
        f.request.roles[0]!.history.answers = [f.save(answer)];
      }
      if (defect === 'read-error') f.rpc.request.mockRejectedValueOnce(new Error('offline'));
      await expect(f.activity.prepareReviewPlan(f.input('changed'))).rejects.toThrow();
      expect(f.state.starts).toBe(4);
    },
  );
  it.each([
    'kind',
    'role',
    'target',
    'client',
    'creation',
    'fresh',
    'preparation',
    'load',
    'attempt',
    'report',
  ])(
    'rejects mutations across every saved proof boundary before a new session: %s',
    async (defect) => {
      const f = fixture(),
        { results } = await f.baseline(),
        answer = f.data(results[0]!.answer);
      if (defect === 'kind') answer.kind = 'other';
      if (defect === 'role') answer.roleId = 'backend';
      if (defect === 'target')
        answer.input = {
          ...results[0]!.reader,
          preparation: { ...results[0]!.reader.preparation, taskId: 'foreign' },
        };
      if (defect === 'client') answer.profile = { ...f.profile, clientVersion: 'other' };
      if (defect === 'creation') answer.creation = f.proof;
      if (defect === 'fresh') {
        const creation = f.data(answer.creation as ArtifactRef),
          response = creation.response as typeof f.response;
        response.thread.turns = [{ status: 'completed' }];
        answer.creation = f.save(creation);
      }
      if (defect === 'preparation') {
        const prepared = answer.prepared as { manifest: ArtifactRef },
          creation = f.data(answer.creation as ArtifactRef);
        prepared.manifest = f.proof;
        creation.prepared = prepared;
        answer.creation = f.save(creation);
      }
      if (defect === 'load') answer.load = f.proof;
      if (defect === 'attempt') answer.attempt = -1;
      if (defect === 'report') answer.report = {};
      f.request.roles[0]!.history.answers = [f.save(answer)];
      await expect(f.activity.prepareReviewPlan(f.input('mutation'))).rejects.toThrow();
      expect(f.state.starts).toBe(4);
    },
  );
});

describe('review contracts and client', () => {
  it('normalizes packets and joins only the immutable accepted input', async () => {
    const f = fixture(),
      input = f.input(),
      query = vi.fn(async () => input),
      start = vi.fn(async () => ({ query }));
    const client = { workflow: { start } } as unknown as Client;
    bindTaskBackendClient(client, f.registration);
    expect(await startReview(client, input, 'q')).toEqual({ query });
    expect(reviewKey(input)).toBe('aw/review/neutral/one/round-1');
    query.mockResolvedValueOnce({ ...input, reviewId: 'different' });
    await expect(startReview(client, input, 'q')).rejects.toThrow('review-start-conflict');
    expect(() => parseReviewInput({ ...input, schemaVersion: 2 })).toThrow(
      'review-schema-unsupported',
    );
  });
  it('rejects incomplete selections, bad declarations and malformed structured reports', async () => {
    const f = fixture(),
      input = f.input();
    for (const change of [
      { schemaVersion: 2 },
      { phase: 'other' },
      { scope: '' },
      { sharedPaths: ['a', 'a'] },
      { roles: null },
      { roles: [] },
      { roles: [f.request.roles[0], f.request.roles[0]] },
    ])
      expect(() => parseReviewRequest({ ...f.request, ...change }, input)).toThrow();
    for (const change of [
      { applies: 1 },
      { reason: '' },
      { paths: ['../x'] },
      { paths: ['a', 'a'] },
      { complete: 0 },
      { attestedBy: 0 },
      { discoveryRule: 0 },
      { attestedBy: '' },
      { history: { complete: 0, answers: [] } },
      { history: { complete: true, answers: [f.proof, f.proof] } },
    ])
      expect(() =>
        parseReviewRequest(
          { ...f.request, roles: [{ ...f.request.roles[0], ...change }, f.request.roles[1]] },
          input,
        ),
      ).toThrow();
    const plan = await f.activity.prepareReviewPlan(input),
      reader = requireScoped(plan.decisions[0]!.input),
      snapshot = scopedReviewInputs(f.registration, reader).snapshot;
    const report: ReviewReport = {
      schemaVersion: 1,
      roleId: reader.roleId,
      phase: snapshot.phase,
      scope: snapshot.scope,
      review: reader.review,
      verdict: 'PASS',
      coverage: 'complete',
      findings: [],
      limitations: [],
    };
    expect(parseReviewReport(report, reader, snapshot)).toEqual(report);
    for (const change of [
      { schemaVersion: 2 },
      { roleId: 'other' },
      { phase: 'acceptance' },
      { scope: 'other' },
      { review: f.proof },
      { verdict: 'other' },
      { coverage: 'other' },
      { findings: [{ id: 'a', blocking: true, text: 'bad' }] },
      {
        findings: [
          { id: 'a', blocking: false, text: 'a' },
          { id: 'a', blocking: false, text: 'b' },
        ],
      },
      { limitations: [''] },
    ])
      expect(() => parseReviewReport({ ...report, ...change }, reader, snapshot)).toThrow();
    expect(() => readerReport({ items: [] }, reader, snapshot)).toThrow('review-report-missing');
    expect(() => readerReport({}, reader, snapshot)).toThrow('review-report-items-missing');
    expect(() => parseReviewSnapshot({ ...snapshot, kind: 'other' }, reader)).toThrow(
      'review-snapshot-invalid',
    );
    expect(() =>
      parseReviewSnapshot(
        { ...snapshot, input: { ...snapshot.input, reviewId: 'a'.repeat(64) } },
        reader,
      ),
    ).toThrow('review-snapshot-binding');
    expect(() =>
      parseReviewSnapshot(
        { ...snapshot, selection: { ...snapshot.selection, roleId: 'backend' } },
        reader,
      ),
    ).toThrow('review-snapshot-role');
    for (const files of [[], [snapshot.files[0], snapshot.files[0]]])
      expect(() => parseReviewSnapshot({ ...snapshot, files }, reader)).toThrow(
        'review-snapshot-files',
      );
    const altered = f.save({
      ...snapshot,
      files: snapshot.files.filter((p) => p.path !== 'RULES.md'),
    });
    expect(() => scopedReviewInputs(f.registration, { ...reader, review: altered })).toThrow(
      'review-required-input-missing',
    );
    const before = structuredClone(snapshot),
      after = structuredClone(snapshot);
    after.files.shift();
    expect(reviewChanges(before, after)).toContain('input-removed:RULES.md');
  });
});
