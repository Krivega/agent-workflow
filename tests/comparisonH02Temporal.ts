import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InputRef } from '../core/localRun.js';
import { object, requireWorkflow } from '../core/connection.js';
import { checkH02Material, h02Material, h02Scenario } from './comparisonH02Contract.js';
import type {
  ArtifactRef,
  LocalProjectRegistration,
  PreparationInput,
} from '../src/contracts/preparation.js';
import type { CodexRpc } from '../src/contracts/codex.js';
import type { ReaderAuthority } from '../src/contracts/readerControl.js';
import type { ReviewInput, ReviewPlan, ReviewRequest } from '../src/contracts/review.js';
import { reviewActivities } from '../src/activities/review.js';
import { readerActivities } from '../src/activities/reader.js';
import { readerControlActivities } from '../src/activities/readerControl.js';
import { prepareScopedReview } from '../src/adapters/codex/reviewInputs.js';
import { readerBoundary } from '../src/adapters/codex/readerBoundary.js';
import { readerBudget } from '../src/adapters/codex/readerBudget.js';
import { readerExecution } from '../src/policy/readerExecution.js';
import { readerKey } from '../src/policy/readerControl.js';
import { requireScoped } from '../src/policy/review.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';

export interface H02TemporalContext {
  registration: LocalProjectRegistration;
  preparation: PreparationInput;
  profile: { model: string; effort: string; clientVersion: string };
  rpc: CodexRpc;
  authority: ReaderAuthority;
  directory: string;
  maxTurnStarts: number;
  signal: AbortSignal;
  executeRound?: (input: ReviewInput, rpc: CodexRpc) => Promise<H02TemporalRoundResult>;
}
export type H02TemporalReaderEvidence = {
  roleId: string;
  session: string | null;
  prepared: ArtifactRef;
  load: ArtifactRef | null;
  answer: ArtifactRef | null;
  stop: ArtifactRef | null;
};
export interface H02TemporalRoundResult {
  plan: ReviewPlan;
  readers: (Omit<H02TemporalReaderEvidence, 'session' | 'load' | 'answer' | 'stop'> & {
    session: string;
    load: ArtifactRef;
    answer: ArtifactRef;
    stop: ArtifactRef;
  })[];
  completion: { manifest: ArtifactRef; complete: boolean };
}
type Round = {
  name: string;
  input: ReviewInput;
  plan: ReviewPlan;
  readers: H02TemporalReaderEvidence[];
  completion: { manifest: ArtifactRef; complete: boolean } | null;
};

/** The real activities boundary with caller-owned RPC; this is not a Workflow/SDK qualification. */
export async function runH02TemporalCase(ctx: H02TemporalContext) {
  const store = artifactStore(ctx.registration.artifactRoot);
  const save = (value: unknown) => store.publish(Buffer.from(JSON.stringify(value)));
  const data = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString('utf8')));
  const evidence = new Map<string, InputRef>();
  const retain = (ref: ArtifactRef) => {
    evidence.set(ref.sha256, { locator: store.path(ref), hash: ref.sha256 });
    return ref;
  };
  const rounds: Round[] = [];
  const probes: {
    name: string;
    plan: ReviewPlan | null;
    completion: { manifest: ArtifactRef; complete: boolean } | null;
    error: string | null;
  }[] = [];
  const dispatches: {
    phase: string;
    method: string;
    roleId: string | null;
    stage: string;
    session: string | null;
    turn: string | null;
  }[] = [];
  const blocking: string[] = [];
  let phase = 'initial',
    stage = 'prepare',
    active: {
      input: Parameters<ReturnType<typeof readerControlActivities>['freezeReader']>[0];
      permit: ArtifactRef;
    } | null = null;
  const rpc: CodexRpc = {
    async request(method, params) {
      if (['thread/start', 'thread/resume', 'turn/start'].includes(method))
        ctx.signal.throwIfAborted();
      const dispatch = {
        phase,
        method,
        roleId: active?.input.roleId ?? null,
        stage,
        session: typeof params.threadId === 'string' ? params.threadId : null,
        turn: null as string | null,
      };
      dispatches.push(dispatch);
      const response = await ctx.rpc.request(method, params);
      if (method === 'thread/start') dispatch.session = String(object(object(response).thread).id);
      if (method === 'turn/start') dispatch.turn = String(object(object(response).turn).id);
      return response;
    },
    completed(thread, turn, signal) {
      return ctx.rpc.completed(thread, turn, signal ?? ctx.signal);
    },
  };
  const local =
    ctx.executeRound === undefined
      ? (() => {
          const gate = readerBoundary(
            join(ctx.directory, 'permissions'),
            store,
            ctx.registration.workspaceRoot,
            readerExecution(ctx.profile),
            () => ctx.signal.throwIfAborted(),
            readerBudget(join(ctx.directory, 'turn-credits'), ctx.maxTurnStarts),
          );
          return {
            controls: readerControlActivities(ctx.registration, rpc, gate, ctx.authority),
            models: readerActivities(
              ctx.registration,
              rpc,
              ctx.profile,
              join(ctx.directory, 'effects'),
              gate.boundary,
            ),
          };
        })()
      : null;
  const reviews = reviewActivities(ctx.registration, rpc, ctx.profile);
  const request: ReviewRequest = {
    schemaVersion: 1,
    phase: 'planning',
    scope: 'H-02',
    sharedPaths: [],
    roles: ['pricing', 'logging', 'storage'].map((roleId) => ({
      roleId,
      applies: true,
      reason: `Review ${roleId} contract`,
      paths: [roleId + '.json'],
      complete: true,
      attestedBy: 'fixed H02 material',
      discoveryRule: 'H02-declared-paths/1',
      history: { complete: true, answers: [] },
    })),
  };
  const input = (name: string, value = request): ReviewInput => ({
    schemaVersion: 1,
    preparation: ctx.preparation,
    reviewId: 'h02-' + name,
    request: retain(save(value)),
  });
  const perform = async (name: string) => {
    ctx.signal.throwIfAborted();
    phase = name;
    const value = input(name);
    if (ctx.executeRound !== undefined) {
      const executed = await ctx.executeRound(value, rpc);
      const round: Round = { name, input: value, ...executed };
      rounds.push(round);
      retain(executed.plan.manifest);
      retain(executed.completion.manifest);
      for (const reader of executed.readers) {
        retain(reader.prepared);
        retain(reader.load);
        retain(reader.answer);
        retain(reader.stop);
        for (const dispatch of dispatches.filter(
          (entry) => entry.phase === name && entry.session === reader.session,
        )) {
          dispatch.roleId = reader.roleId;
          if (dispatch.method === 'turn/start') {
            const loadTurn = object(data(reader.load).observed).id,
              answerTurn = object(data(reader.answer).observed).id;
            requireWorkflow(
              dispatch.turn === loadTurn || dispatch.turn === answerTurn,
              'h02-sdk-unbound-turn',
            );
            dispatch.stage = dispatch.turn === loadTurn ? 'load' : 'answer';
          }
        }
      }
      ctx.signal.throwIfAborted();
      for (const decision of executed.plan.decisions) {
        const answer =
          decision.action === 'review'
            ? executed.readers.find((row) => row.roleId === decision.roleId)!.answer
            : decision.answer;
        const selection = request.roles.find((row) => row.roleId === decision.roleId)!;
        if (
          answer !== null &&
          !selection.history.answers.some((ref) => ref.sha256 === answer.sha256)
        )
          selection.history.answers.push(answer);
      }
      return round;
    }
    const plan = await reviews.prepareReviewPlan(value);
    const { controls, models } = local!;
    retain(plan.manifest);
    const round: Round = { name, input: value, plan, readers: [], completion: null };
    rounds.push(round);
    ctx.signal.throwIfAborted();
    const answers: { roleId: string; answer: ArtifactRef | null }[] = [];
    for (const decision of plan.decisions) {
      if (decision.action !== 'review') {
        answers.push({ roleId: decision.roleId, answer: decision.answer });
        continue;
      }
      const reader = requireScoped(decision.input),
        prepared = prepareScopedReview(ctx.registration, reader);
      retain(reader.review);
      retain(prepared.manifest);
      const permit = retain(await controls.registerReader(reader, readerKey(reader)));
      const epoch = { permit, revision: 0, attempt: 0 };
      const result: H02TemporalReaderEvidence = {
        roleId: decision.roleId,
        prepared: prepared.manifest,
        session: null,
        load: null,
        answer: null,
        stop: null,
      };
      round.readers.push(result);
      active = { input: reader, permit };
      try {
        ctx.signal.throwIfAborted();
        stage = 'create';
        const session = await models.createReader(reader, prepared, epoch);
        result.session = session.id;
        retain(session.creation);
        stage = 'load';
        result.load = retain(await models.loadReader(reader, prepared, session, epoch));
        stage = 'answer';
        result.answer = retain(
          await models.answerReader(reader, prepared, session, result.load, epoch),
        );
        answers.push({ roleId: decision.roleId, answer: result.answer });
      } finally {
        stage = 'stop';
        const revision = await controls.freezeReader(reader, permit);
        result.stop = retain((await controls.stopReader(reader, permit, revision)).receipt);
        active = null;
      }
    }
    round.completion = await reviews.finishReview({
      schemaVersion: 1,
      input: value,
      plan: plan.manifest,
      answers,
    });
    retain(round.completion.manifest);
    ctx.signal.throwIfAborted();
    for (const answer of answers) {
      const selection = request.roles.find((role) => role.roleId === answer.roleId)!;
      if (
        answer.answer !== null &&
        !selection.history.answers.some((ref) => ref.sha256 === answer.answer!.sha256)
      )
        selection.history.answers.push(answer.answer);
    }
    return round;
  };
  const counts = (name: string) => ({
    threadStarts: dispatches.filter((item) => item.phase === name && item.method === 'thread/start')
      .length,
    turnStarts: dispatches.filter((item) => item.phase === name && item.method === 'turn/start')
      .length,
  });
  const roleCounts = (name: string, roleId: string) => ({
    threadStarts: dispatches.filter(
      (item) => item.phase === name && item.roleId === roleId && item.method === 'thread/start',
    ).length,
    loadStarts: dispatches.filter(
      (item) =>
        item.phase === name &&
        item.roleId === roleId &&
        item.stage === 'load' &&
        item.method === 'turn/start',
    ).length,
    answerStarts: dispatches.filter(
      (item) =>
        item.phase === name &&
        item.roleId === roleId &&
        item.stage === 'answer' &&
        item.method === 'turn/start',
    ).length,
  });
  const planProbe = async (
    name: string,
    change: (value: ReviewRequest) => void,
    complete = false,
  ) => {
    phase = name;
    const changed = structuredClone(request);
    change(changed);
    const value = input(name, changed);
    const probe = {
      name,
      plan: null as ReviewPlan | null,
      completion: null as Round['completion'],
      error: null as string | null,
    };
    probes.push(probe);
    try {
      ctx.signal.throwIfAborted();
      probe.plan = await reviews.prepareReviewPlan(value);
      retain(probe.plan.manifest);
      ctx.signal.throwIfAborted();
      if (complete) {
        probe.completion = await reviews.finishReview({
          schemaVersion: 1,
          input: value,
          plan: probe.plan.manifest,
          answers: probe.plan.decisions.map((row) => ({
            roleId: row.roleId,
            answer: row.action === 'reuse' ? row.answer : null,
          })),
        });
        retain(probe.completion.manifest);
        ctx.signal.throwIfAborted();
      }
    } catch (error) {
      probe.error = error instanceof Error ? error.message : 'unknown-probe-failure';
      retain(
        save({ kind: 'h02-temporal-probe-failure', name, request: value, error: probe.error }),
      );
    }
    ctx.signal.throwIfAborted();
    return probe;
  };
  const originalPricing = readFileSync(join(ctx.registration.workspaceRoot, 'pricing.json'));
  const allChecks = Object.fromEntries(h02Scenario.checks.map((name) => [name, false]));
  try {
    ctx.signal.throwIfAborted();
    requireWorkflow(
      originalPricing.equals(Buffer.from(h02Material.files['pricing.json']!)),
      'h02-initial-pricing',
    );
    const initial = await perform('initial');
    const originalHistory = structuredClone(request.roles.map((role) => role.history.answers));
    writeFileSync(join(ctx.registration.workspaceRoot, 'pricing.json'), '{"rate":7}\n');
    const repaired = await perform('repaired');
    const pricingActions = repaired.plan.decisions.map((row) => row.action);
    const reused = await planProbe('unchanged', () => {});
    writeFileSync(join(ctx.registration.workspaceRoot, 'pricing.json'), '{"rate":8}\n');
    let changed;
    try {
      changed = await planProbe('changed-dependency', () => {});
    } finally {
      writeFileSync(join(ctx.registration.workspaceRoot, 'pricing.json'), '{"rate":7}\n');
    }
    const dependency = await planProbe('new-dependency', (value) => {
      value.roles[0]!.paths.push('logging.json');
    });
    const shared = await planProbe('shared-scope', (value) => {
      value.scope = 'H-02-shared';
    });
    const rationale = await planProbe('role-rationale', (value) => {
      value.roles[0]!.reason = 'Changed pricing responsibility';
    });
    const open = await planProbe('open-FAIL', (value) => {
      value.roles.forEach((role, index) => {
        role.history.answers = originalHistory[index]!;
      });
      value.roles[0]!.applies = false;
    });
    const missing = await planProbe('missing-role', (value) => {
      value.roles.pop();
    });
    const incomplete = await planProbe(
      'incomplete-map',
      (value) => {
        value.roles[0]!.complete = false;
      },
      true,
    );
    const actions = (probe: typeof reused) => probe.plan?.decisions.map((row) => row.action);
    allChecks['unchanged-pass'] =
      initial.completion?.complete === false &&
      repaired.completion?.complete === true &&
      JSON.stringify(pricingActions) === JSON.stringify(['review', 'reuse', 'reuse']) &&
      JSON.stringify(actions(reused)) === JSON.stringify(['reuse', 'reuse', 'reuse']) &&
      repaired.plan.decisions[1]!.answer?.sha256 === initial.readers[1]!.answer?.sha256 &&
      repaired.plan.decisions[2]!.answer?.sha256 === initial.readers[2]!.answer?.sha256;
    allChecks['changed-dependency'] =
      JSON.stringify(actions(changed)) === JSON.stringify(['review', 'reuse', 'reuse']) &&
      changed.plan!.decisions[0]!.reasons.includes('input-changed:pricing.json');
    allChecks['new-dependency'] =
      JSON.stringify(actions(dependency)) === JSON.stringify(['review', 'reuse', 'reuse']) &&
      dependency.plan!.decisions[0]!.reasons.includes('input-changed:logging.json');
    allChecks['shared-scope'] =
      shared.plan?.decisions.every(
        (row) => row.action === 'review' && row.reasons.includes('review-target-changed'),
      ) === true;
    allChecks['role-rationale'] =
      JSON.stringify(actions(rationale)) === JSON.stringify(['review', 'reuse', 'reuse']) &&
      rationale.plan!.decisions[0]!.reasons.includes('role-obligation-changed');
    allChecks['open-fail'] =
      open.plan?.decisions[0]!.action === 'review' &&
      open.plan.decisions[0]!.reasons.includes('open-failure');
    allChecks['incomplete-map'] =
      incomplete.plan?.decisions[0]!.reasons.includes('dependencies-unknown') === true &&
      incomplete.completion?.complete === false &&
      missing.error === 'review-role-selection-incomplete';
    const initialVerdicts = initial.readers.map((row) => object(data(row.answer!).report).verdict);
    const repairedVerdict = object(data(repaired.readers[0]!.answer!).report).verdict;
    requireWorkflow(await checkH02Material(ctx.registration.workspaceRoot), 'h02-common-checker');
    requireWorkflow(
      JSON.stringify(initialVerdicts) === JSON.stringify(['FAIL', 'PASS', 'PASS']) &&
        repairedVerdict === 'PASS',
      'h02-primary-verdicts',
    );
    requireWorkflow(
      counts('initial').threadStarts === 3 &&
        counts('initial').turnStarts === 6 &&
        counts('repaired').threadStarts === 1 &&
        counts('repaired').turnStarts === 2 &&
        probes.every(
          (probe) => counts(probe.name).threadStarts === 0 && counts(probe.name).turnStarts === 0,
        ),
      'h02-extra-model-dispatch',
    );
    requireWorkflow(
      repaired.readers.length === 1 &&
        repaired.readers[0]!.roleId === 'pricing' &&
        roleCounts('repaired', 'pricing').loadStarts === 1 &&
        roleCounts('repaired', 'pricing').answerStarts === 1 &&
        roleCounts('repaired', 'logging').answerStarts === 0 &&
        roleCounts('repaired', 'storage').answerStarts === 0,
      'h02-extra-role-review',
    );
    for (const round of rounds)
      for (const row of round.readers)
        requireWorkflow(
          row.stop !== null && data(row.stop).confirmed === true,
          'h02-stop-unconfirmed',
        );
  } catch (error) {
    blocking.push(error instanceof Error ? error.message : 'h02-unknown');
  } finally {
    if (active !== null) blocking.push('h02-reader-stop-unknown');
  }
  if (ctx.signal.aborted) blocking.push('h02-cancelled');
  const report = {
    kind: 'comparison-h02-temporal-case',
    schemaVersion: 1,
    variant: 'temporal' as const,
    engine: 'temporal-activities' as const,
    sdk: ctx.executeRound !== undefined,
    outcome:
      blocking.length === 0 && Object.values(allChecks).every(Boolean)
        ? ('accepted' as const)
        : ('unknown' as const),
    checks: allChecks,
    rounds,
    probes,
    blocking,
    effects: {
      threadStarts: dispatches.filter((item) => item.method === 'thread/start').length,
      turnStarts: dispatches.filter((item) => item.method === 'turn/start').length,
      byPhase: Object.fromEntries(
        [...new Set([...rounds.map((item) => item.name), ...probes.map((item) => item.name)])].map(
          (name) => [name, counts(name)],
        ),
      ),
      byRole: Object.fromEntries(
        ['initial', 'repaired'].map((name) => [
          name,
          Object.fromEntries(
            ['pricing', 'logging', 'storage'].map((roleId) => [roleId, roleCounts(name, roleId)]),
          ),
        ]),
      ),
    },
    evidence: [...evidence.values()],
    nativeUsage: null,
    physicalStop: null,
    qualification: false as const,
    nativeAcceptance: false as const,
    partialScope: true as const,
  };
  const ref = retain(save(report));
  return { ...report, report: { locator: store.path(ref), hash: ref.sha256 } };
}
