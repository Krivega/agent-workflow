import { localTaskFixture } from './localTaskFixture.js';
import type { ArbitrationTaskInput } from '../../src/contracts/localTask.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewActivities } from '../../src/activities/review.js';
import { readerActivities } from '../../src/activities/reader.js';
import { prepareScopedReview } from '../../src/adapters/codex/reviewInputs.js';
import { requireScoped, parseReviewSnapshot } from '../../src/policy/review.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as checks from '../../src/adapters/project/taskChecks.js';
import { arbitrationFixture } from './arbitrationFixture.js';
import { runReview, throughIntegration, acceptance } from './localTaskRun.js';
afterEach(() => vi.restoreAllMocks());
async function threeFails() {
  const f = arbitrationFixture(),
    input = f.arbitrationInput,
    a = f.service.activities;
  f.processes.wait = vi.fn(async () => {});
  vi.spyOn(checks, 'taskChecks').mockReturnValue({
    stop: vi.fn(async () => []),
    run: vi.fn<ReturnType<typeof checks.taskChecks>['run']>(async (_cwd, command) => ({
      code: 0,
      signal: null,
      error: null,
      stop: { confirmed: true, processes: [] },
      elapsedMs: 1,
      command,
      log: 'policy checks',
    })),
  });
  const planning = await a.prepareSubstantialPlanning(input),
    approved = await runReview(f, planning);
  f.fault.repeat = true;
  let current = await throughIntegration(f, input, approved.manifest),
    reviewed = await acceptance(f, current);
  await expect(
    a.prepareLocalArbitration(input, current.snapshot, current.packet, reviewed.manifest),
  ).rejects.toThrow('task-arbitration-round-required');
  for (let n = 0; n < 2; n++) {
    const next = await a.prepareLocalCorrection(
      input,
      current.snapshot,
      current.packet,
      reviewed.manifest,
    );
    current = await throughIntegration(f, input, undefined, next);
    reviewed = await acceptance(f, current);
  }
  expect(reviewed.complete).toBe(false);
  const prepared = await a.prepareLocalArbitration(
    input,
    current.snapshot,
    current.packet,
    reviewed.manifest,
  );
  return { f, input, a, current, reviewed, prepared };
}
describe('three-fail arbitration and bounded readiness', { timeout: 45000 }, () => {
  it('preserves three primary FAIL, obtains an independent direction and requires working checks and the original reviewer', async () => {
    const { f, input, a, current, reviewed, prepared } = await threeFails();
    const rounds = f.read(prepared.manifest).rounds as {
      snapshot: { sha256: string; bytes: number };
      review: { sha256: string; bytes: number };
    }[];
    expect(rounds[0]!.review).toEqual(reviewed.manifest);
    expect(
      (f.read(rounds[0]!.snapshot).correction as { previous: { review: unknown } }).previous.review,
    ).toEqual(rounds[1]!.review);
    const scoped = f.read(prepared.review.request);
    expect(scoped.evidence as unknown[]).toHaveLength(2);
    const adjudicated = await runReview(f, prepared.review, f.arbiterProfile);
    expect(adjudicated.complete).toBe(false);
    const result = await a.finishLocalArbitration(
      input,
      current.snapshot,
      prepared.manifest,
      adjudicated.manifest,
    );
    expect(f.read(prepared.manifest).writablePaths).toEqual(
      (f.read(result.snapshot!).plan as { paths: string[] }).paths,
    );
    expect(result.ready).toBe(true);
    expect(f.read(result.manifest)).toMatchObject({ decision: { kind: 'direction' }, ready: true });
    f.fault.repeat = false;
    const final = await throughIntegration(f, input, undefined, result.snapshot!),
      accepted = await acceptance(f, final);
    const request = f.read(final.packet.request),
      role = (
        request.roleEvidence as { roleId: string; evidence: { sha256: string; bytes: number }[] }[]
      ).find((row) => row.roleId === 'reviewer')!;
    expect(f.read(role.evidence.at(-1)!)).toMatchObject({
      adjudication: {
        source: result.manifest,
        decision: { kind: 'direction', mandatoryDefect: true },
      },
    });
    expect(accepted.complete).toBe(true);
    expect(
      (await a.finishLocalTask(input, final.snapshot, final.packet, accepted.manifest)).status,
    ).toBe('done');
    expect(f.state.starts).toBe(28);
  });
  it('rejects changed sources, wrong profiles and forged primary arbitration bindings before another writer', async () => {
    const { f, input, a, current, reviewed, prepared } = await threeFails();
    const before = f.state.starts;
    expect(
      await a.prepareLocalArbitration(input, current.snapshot, current.packet, reviewed.manifest),
    ).toEqual(prepared);
    await expect(runReview(f, prepared.review)).rejects.toThrow('arbitration-profile-mismatch');
    const plan = await reviewActivities(f.registration, f.rpc, f.arbiterProfile).prepareReviewPlan(
        prepared.review,
      ),
      actor = requireScoped(plan.decisions.find((row) => row.action === 'review')!.input),
      prep = prepareScopedReview(f.registration, actor);
    await expect(
      readerActivities(
        f.registration,
        f.rpc,
        f.profile,
        join(f.root, 'wrong-arbiter'),
      ).createReader(actor, prep),
    ).rejects.toThrow('arbitration-profile-mismatch');
    const raw = f.read(actor.review);
    expect(() =>
      parseReviewSnapshot(
        {
          ...raw,
          selection: {
            ...(raw.selection as object),
            history: { complete: true, answers: [f.proof] },
          },
        },
        actor,
      ),
    ).toThrow('review-arbitration-selection');
    const owner = readFileSync(join(f.workspace, 'owner.cjs'));
    writeFileSync(join(f.workspace, 'owner.cjs'), 'changed while waiting');
    await expect(
      a.prepareLocalArbitration(input, current.snapshot, current.packet, reviewed.manifest),
    ).rejects.toThrow();
    writeFileSync(join(f.workspace, 'owner.cjs'), owner);
    expect(f.state.starts).toBe(before);
    const adjudicated = await runReview(f, prepared.review, f.arbiterProfile);
    expect(adjudicated.complete).toBe(false);
    const foreign = await runReview(
        f,
        { ...prepared.review, reviewId: 'foreign-arbitration' },
        f.arbiterProfile,
      ),
      foreignBody = f.read(foreign.manifest),
      foreignPlan = f.read(foreignBody.plan as { sha256: string; bytes: number });
    const forgedPlan = f.save({ ...foreignPlan, input: prepared.review });
    const forged = await reviewActivities(f.registration, f.rpc, f.arbiterProfile).finishReview({
      schemaVersion: 1,
      input: prepared.review,
      plan: forgedPlan,
      answers: foreignBody.answers as {
        roleId: string;
        answer: { sha256: string; bytes: number } | null;
      }[],
    });
    await expect(
      a.finishLocalArbitration(input, current.snapshot, prepared.manifest, forged.manifest),
    ).rejects.toThrow('task-arbitration-plan-unconfirmed');

    await expect(
      a.finishLocalArbitration(input, current.snapshot, f.proof, adjudicated.manifest),
    ).rejects.toThrow('task-arbitration-binding');
    await expect(
      a.finishLocalArbitration(
        input,
        current.snapshot,
        prepared.manifest,
        f.save({ ...f.read(adjudicated.manifest), reports: [] }),
      ),
    ).rejects.toThrow('task-arbitration-unconfirmed');
    expect(f.state.starts).toBe(before + 4);
    await f.service.stopAll();
  });
});

it(
  'preserves a scoped no-decision and stops without another writer',
  { timeout: 45000 },
  async () => {
    const f = arbitrationFixture(),
      input = f.arbitrationInput,
      a = f.service.activities;
    f.fault.repeat = true;
    f.state.arbitrationDecision = {
      kind: 'no-decision',
      mandatoryDefect: null,
      direction: null,
      exception: null,
      residualRisk: null,
      dissent: ['Original FAIL remains'],
      condition: 'Need a concrete missing decision',
    };
    f.processes.wait = vi.fn(async () => {});
    vi.spyOn(checks, 'taskChecks').mockReturnValue({
      stop: vi.fn(async () => []),
      run: vi.fn<ReturnType<typeof checks.taskChecks>['run']>(async (_cwd, command) => ({
        code: 0,
        signal: null,
        error: null,
        stop: { confirmed: true, processes: [] },
        elapsedMs: 1,
        command,
        log: 'policy checks',
      })),
    });
    const planning = await a.prepareSubstantialPlanning(input),
      approved = await runReview(f, planning);
    let run = await throughIntegration(f, input, approved.manifest),
      reviewed = await acceptance(f, run);
    for (let n = 0; n < 2; n++) {
      const next = await a.prepareLocalCorrection(
        input,
        run.snapshot,
        run.packet,
        reviewed.manifest,
      );
      run = await throughIntegration(f, input, undefined, next);
      reviewed = await acceptance(f, run);
    }
    const prepared = await a.prepareLocalArbitration(
        input,
        run.snapshot,
        run.packet,
        reviewed.manifest,
      ),
      answer = await runReview(f, prepared.review, f.arbiterProfile),
      result = await a.finishLocalArbitration(
        input,
        run.snapshot,
        prepared.manifest,
        answer.manifest,
      );
    expect(result).toMatchObject({ ready: false, snapshot: null });
    expect(f.state.starts).toBe(23);
    expect(f.read(result.manifest)).toMatchObject({
      decision: { kind: 'no-decision', condition: 'Need a concrete missing decision' },
    });
    expect(f.read(await f.service.controls.stopLocalTask(input))).toMatchObject({
      confirmed: true,
    });
  },
);
it(
  'requires an independent registered arbiter before planning or model work',
  { timeout: 15000 },
  async () => {
    const f = arbitrationFixture(),
      input = f.arbitrationInput;
    Object.assign(f.host, { arbiter: undefined });
    await expect(f.service.activities.prepareSubstantialPlanning(input)).rejects.toThrow(
      'task-arbiter-host-required',
    );
    expect(f.state.starts).toBe(0);
    Object.assign(f.host, { arbiter: { roleId: 'arbiter', profile: f.arbiterProfile } });
    const original = f.rpc.request;
    f.rpc.request = async (method, params) =>
      method === 'model/list' ? { data: [] } : original(method, params);
    await expect(f.service.activities.prepareLocalTask(input)).rejects.toThrow(
      'task-arbiter-model-unavailable',
    );
    expect(f.state.starts).toBe(0);
  },
);

it('arbitrates B1 without inventing planning sessions', { timeout: 45000 }, async () => {
  const f = localTaskFixture();
  f.registration.project.roles.push({ id: 'arbiter', profile: 'arbiter.md' });
  writeFileSync(
    join(f.workspace, 'arbiter.md'),
    'Independent read-only arbitration. No technical acceptance or implementation.',
  );
  const arbiterProfile = { ...f.profile, effort: 'high' },
    input: ArbitrationTaskInput = {
      ...f.input,
      schemaVersion: 5,
      admission: {
        ...f.input.admission,
        acceptance: f.save({
          ...f.review,
          roles: [
            ...f.review.roles,
            {
              ...f.review.roles[0]!,
              roleId: 'arbiter',
              applies: false,
              reason: 'Arbitration only',
              paths: [],
            },
          ],
        }),
      },
      corrections: {
        maxRounds: 2,
        checks: [
          { roleId: 'reviewer', commands: ['smoke', 'validate'] },
          { roleId: 'arbiter', commands: [] },
        ],
      },
      arbitration: { roleId: 'arbiter', profile: arbiterProfile, compromiseFindings: [] },
    };
  Object.assign(f.host, { arbiter: { roleId: 'arbiter', profile: arbiterProfile } });
  f.processes.wait = vi.fn(async () => {});
  vi.spyOn(checks, 'taskChecks').mockReturnValue({
    stop: vi.fn(async () => []),
    run: vi.fn<ReturnType<typeof checks.taskChecks>['run']>(async (_cwd, command) => ({
      code: 0,
      signal: null,
      error: null,
      stop: { confirmed: true, processes: [] },
      elapsedMs: 1,
      command,
      log: 'policy checks',
    })),
  });
  let round = 0;
  const original = f.host.createRuntime;
  f.host.createRuntime = (root) => {
    const rpc = original(root),
      n = round++;
    return {
      ...rpc,
      async request(method, params) {
        const result = await rpc.request(method, params);
        if (
          method === 'turn/start' &&
          (params.input as { text: string }[])[0]!.text.includes('Выполни локальный план') &&
          n < 3
        )
          writeFileSync(
            join(root, 'owner.cjs'),
            'module.exports=name=>name.trim(); // round ' + n + '\n',
          );
        return result;
      },
    };
  };
  f.state.verdict = 'FAIL';
  f.service = f.makeService();
  const a = f.service.activities;
  let run = await throughIntegration(f, input),
    review = await acceptance(f, run);
  for (let n = 0; n < 2; n++) {
    const next = await a.prepareLocalCorrection(input, run.snapshot, run.packet, review.manifest);
    run = await throughIntegration(f, input, undefined, next);
    review = await acceptance(f, run);
  }
  const prepared = await a.prepareLocalArbitration(
      input,
      run.snapshot,
      run.packet,
      review.manifest,
    ),
    adjudicated = await runReview(f, prepared.review, arbiterProfile),
    result = await a.finishLocalArbitration(
      input,
      run.snapshot,
      prepared.manifest,
      adjudicated.manifest,
    );
  expect(result.ready).toBe(true);
  expect(
    await a.finishLocalArbitration(input, run.snapshot, prepared.manifest, adjudicated.manifest),
  ).toEqual(result);
  f.state.verdict = 'PASS';
  const final = await throughIntegration(f, input, undefined, result.snapshot!),
    accepted = await acceptance(f, final);
  expect(accepted.complete).toBe(true);
  expect(
    (await a.finishLocalTask(input, final.snapshot, final.packet, accepted.manifest)).status,
  ).toBe('done');
  expect(f.state.readers).toBe(2);
});
