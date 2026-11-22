import { join } from 'node:path';
import { readFileSync, chmodSync, writeFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { correctionFixture } from './correctionFixture.js';
import { throughIntegration, runReview, acceptance } from './localTaskRun.js';
import { localTaskFixture } from './localTaskFixture.js';
import * as checks from '../../src/adapters/project/taskChecks.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import type { ReviewRequest } from '../../src/contracts/review.js';
import { reviewActivities } from '../../src/activities/review.js';
import { reviewProof } from '../../src/adapters/codex/reviewProof.js';
import { readerLoadPrompt } from '../../src/adapters/codex/readerMessages.js';
import { requireScoped } from '../../src/policy/review.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import type { CorrectionTaskInput, TaskSnapshot } from '../../src/contracts/localTask.js';
import { archiveFixture } from './finalizationFixture.js';
import { inspectCompletedTaskFixture } from './taskRecoveryFixture.js';
afterEach(() => vi.restoreAllMocks());
describe('bounded correction and scoped acceptance', { timeout: 30000 }, () => {
  it('preserves original FAIL, narrows the next writer and reuses the unchanged role', async () => {
    const f = correctionFixture(),
      input = f.correctionInput,
      a = f.service.activities;
    const planning = await a.prepareSubstantialPlanning(input),
      approved = await runReview(f, planning),
      first = await throughIntegration(f, input, approved.manifest),
      failed = await acceptance(f, first);
    expect(failed.complete).toBe(false);
    const next = await a.prepareLocalCorrection(
      input,
      first.snapshot,
      first.packet,
      failed.manifest,
    );
    const body = f.read(next) as unknown as TaskSnapshot;
    expect(body).toMatchObject({
      schemaVersion: 4,
      correction: { round: 1, previous: { review: failed.manifest } },
      plan: { paths: ['owner.cjs'] },
    });
    const second = await throughIntegration(f, input, undefined, next),
      packet = second.packet;
    const starts = f.state.starts;
    const request = f.read(packet.request),
      reviewer = reviewActivities(f.registration, f.rpc, f.profile);
    await expect(
      reviewer.prepareReviewPlan({
        ...packet,
        request: f.save({ ...request, evidence: [{ sha256: '0'.repeat(64), bytes: 1 }] }),
      }),
    ).rejects.toThrow();
    const roleEvidence = request.roleEvidence as { roleId: string; openFindings: string[] }[];
    await expect(
      reviewer.prepareReviewPlan({
        ...packet,
        request: f.save({
          ...request,
          roleEvidence: roleEvidence.map((row) => ({ ...row, openFindings: [] })),
        }),
      }),
    ).rejects.toThrow('review-open-findings-incomplete');
    const verdict = await runReview(f, packet);
    expect(verdict.complete).toBe(true);
    const reviewed = f.read(verdict.manifest),
      reports = reviewed.reports as { roleId: string; answer: ArtifactRef }[];
    const source = f.read(reports.find((row) => row.roleId === 'reviewer')!.answer),
      current = requireScoped(source.input);
    const proof = reviewProof(f.registration, f.rpc);
    const load = f.read(source.load as ArtifactRef),
      legacyLoad = structuredClone(load);
    await expect(
      proof(
        f.save({
          ...source,
          load: f.save({ ...load, commandOutputs: f.save({ kind: 'foreign' }) }),
        }),
        current,
      ),
    ).rejects.toThrow();
    delete legacyLoad.promptVersion;
    const observed = legacyLoad.observed as {
        id: string;
        items: { type: string; content: { text: string }[] }[];
      },
      message = observed.items.find((item) => item.type === 'userMessage')!.content[0]!,
      refs = legacyLoad.refs as { path: string; sha256: string }[];
    message.text = message.text.replace(readerLoadPrompt(refs, 4), readerLoadPrompt(refs, 1));
    const nativeRequest = f.rpc.request,
      legacyRpc = vi.spyOn(f.rpc, 'request').mockImplementation(async (method, params) => {
        const result = await nativeRequest(method, params);
        if (method === 'thread/read' && params.threadId === source.session) {
          const value = result as { thread: { turns: { id: string }[] } };
          value.thread.turns[value.thread.turns.findIndex((t) => t.id === observed.id)] = observed;
        }
        return result;
      });
    await expect(
      proof(f.save({ ...source, load: f.save(legacyLoad) }), current),
    ).resolves.toMatchObject({ session: source.session });
    legacyLoad.promptVersion = 2;
    message.text = message.text.replace(readerLoadPrompt(refs, 1), readerLoadPrompt(refs, 2));
    await expect(
      proof(f.save({ ...source, load: f.save(legacyLoad) }), current),
    ).resolves.toMatchObject({ session: source.session });
    legacyLoad.promptVersion = 3;
    message.text = message.text.replace(readerLoadPrompt(refs, 2), readerLoadPrompt(refs, 3));
    await expect(
      proof(f.save({ ...source, load: f.save(legacyLoad) }), current),
    ).resolves.toMatchObject({ session: source.session });
    legacyRpc.mockRestore();
    await expect(
      proof(f.save({ ...source, load: f.save({ ...load, promptVersion: 1 }) }), current),
    ).rejects.toThrow('review-history-message-mismatch');
    await expect(
      proof(f.save({ ...source, load: f.save({ ...load, promptVersion: 9 }) }), current),
    ).rejects.toThrow('review-load-prompt-version');
    const creation = f.read(source.creation as ArtifactRef);
    await expect(
      proof(
        f.save({ ...source, creation: f.save({ ...creation, resumedFrom: f.proof }) }),
        current,
      ),
    ).rejects.toThrow('review-history-resume-mismatch');
    const response = structuredClone(creation.response) as { thread: { turns: unknown[] } };
    response.thread.turns.pop();
    await expect(
      proof(f.save({ ...source, creation: f.save({ ...creation, response }) }), current),
    ).rejects.toThrow('review-history-resume-prefix');
    for (const resolved of [[], ['unrelated']]) {
      const altered = structuredClone(source),
        observed = altered.observed as { items: { type: string; text?: string }[] };
      const report = { ...(altered.report as Record<string, unknown>), resolved };
      altered.report = report;
      observed.items.find((item) => item.type === 'agentMessage')!.text = JSON.stringify(report);
      const request = f.rpc.request,
        spy = vi.spyOn(f.rpc, 'request').mockImplementation(async (method, params) => {
          const result = await request(method, params);
          if (method === 'thread/read' && params.threadId === source.session) {
            const value = result as { thread: { turns: { id: string }[] } };
            value.thread.turns[value.thread.turns.length - 1] = altered.observed as { id: string };
          }
          return result;
        });
      await expect(proof(f.save(altered), current)).rejects.toThrow(
        resolved.length === 0 ? 'review-open-failure' : 'review-resolution-invalid',
      );
      spy.mockRestore();
    }

    expect(f.state.starts - starts).toBe(2);
    expect(f.state.readers).toBe(4);
    const done = await a.finishLocalTask(input, next, packet, verdict.manifest);
    expect(done.status).toBe('done');
    const recovery = await inspectCompletedTaskFixture(f, input);
    expect(recovery.observed[0]!.writers).toHaveLength(2);
    await recovery.recheck();
    expect(await a.finishLocalTask(input, next, packet, verdict.manifest)).toMatchObject({
      status: 'done',
    });
    expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).not.toContain('DEBUG_MARKER');
    expect(f.read(failed.manifest).complete).toBe(false);
    const archived = archiveFixture({ ...f, input }, done);
    expect((await archived.activity.archiveFinalizedTask(archived.input)).status).toBe('archived');
  });
});

function fast() {
  const f = correctionFixture();
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
      log: 'checks isolated from correction policy',
    })),
  });
  return f;
}
async function firstRound(f: ReturnType<typeof fast>) {
  const a = f.service.activities,
    input = f.correctionInput;
  const planning = await a.prepareSubstantialPlanning(input),
    approved = await runReview(f, planning);
  const run = await throughIntegration(f, input, approved.manifest),
    failed = await acceptance(f, run);
  return { a, input, run, failed };
}
describe('correction qualification boundaries', { timeout: 30000 }, () => {
  it('validates explicit role check mappings and budgets before effects', () => {
    const f = fast(),
      input = f.correctionInput;
    expect(parseLocalTask(input)).toEqual(input);
    for (const corrections of [
      { ...input.corrections, maxRounds: 0 },
      { ...input.corrections, checks: null },
      { ...input.corrections, checks: [] },
      {
        ...input.corrections,
        checks: input.corrections.checks.map((row) => ({ ...row, commands: ['unknown'] })),
      },
      {
        ...input.corrections,
        checks: input.corrections.checks.map((row) => ({ ...row, commands: ['smoke', 'smoke'] })),
      },
      {
        ...input.corrections,
        checks: input.corrections.checks.map((row) => ({ ...row, roleId: 'unknown' })),
      },
    ])
      expect(() => parseLocalTask({ ...input, corrections })).toThrow();
    expect(f.state.starts).toBe(0);
  });
  it('keeps B1 admission without adding a planning council or correction when the first acceptance passes', async () => {
    const f = localTaskFixture(),
      a = f.service.activities;
    f.processes.wait = vi.fn(async () => {});
    const input: CorrectionTaskInput = {
      ...f.input,
      schemaVersion: 4,
      corrections: {
        maxRounds: 1,
        checks: [{ roleId: 'reviewer', commands: ['smoke', 'validate'] }],
      },
    };
    expect(parseLocalTask(input)).toEqual(input);
    await expect(a.prepareSubstantialPlanning(input)).rejects.toThrow('substantial-input-required');
    const run = await throughIntegration(f, input),
      reviewed = await acceptance(f, run);
    expect(f.read(run.snapshot)).toMatchObject({
      schemaVersion: 4,
      planning: null,
      correction: { round: 0 },
    });
    await expect(
      a.prepareLocalCorrection(input, run.snapshot, run.packet, reviewed.manifest),
    ).rejects.toThrow('task-correction-review-required');
    expect(
      (await a.finishLocalTask(input, run.snapshot, run.packet, reviewed.manifest)).status,
    ).toBe('done');
    expect(f.state.starts).toBe(5);
  });
  it('pins canonical failed acceptance, retains one preparation and limits the writable scope', async () => {
    const f = fast(),
      { a, input, run, failed } = await firstRound(f),
      starts = f.state.starts;
    await expect(
      a.prepareLocalCorrection(
        input,
        run.snapshot,
        { ...run.packet, reviewId: 'other' },
        failed.manifest,
      ),
    ).rejects.toThrow('task-acceptance-binding');
    await expect(
      a.prepareLocalCorrection(
        input,
        run.snapshot,
        run.packet,
        f.save({ ...f.read(failed.manifest), complete: true }),
      ),
    ).rejects.toThrow('task-correction-review-required');
    await expect(
      a.prepareLocalCorrection(
        input,
        run.snapshot,
        run.packet,
        f.save({ ...f.read(failed.manifest), reports: [] }),
      ),
    ).rejects.toThrow('task-correction-review-unconfirmed');
    const next = await a.prepareLocalCorrection(input, run.snapshot, run.packet, failed.manifest);
    expect(
      await a.prepareLocalCorrection(input, run.snapshot, run.packet, failed.manifest),
    ).toEqual(next);
    expect(f.state.starts).toBe(starts);
    const body = f.read(next) as unknown as TaskSnapshot;
    expect(body.plan.paths).toEqual(['owner.cjs']);
    f.state.outside = true;
    await expect(a.writeLocalTask(input, next)).rejects.toThrow('task-change-outside-scope');
    expect(readFileSync(join(f.workspace, 'consumer.cjs'), 'utf8')).toContain(
      "require('./owner.cjs')",
    );
    expect(f.read(await f.service.controls.stopLocalTask(input))).toMatchObject({
      confirmed: true,
    });
    expect(f.read(await f.service.controls.stopLocalTask(input))).toMatchObject({
      confirmed: true,
    });
  });
  it('stops after a second complete failure and retains the review needed for arbitration', async () => {
    const f = fast();
    f.fault.repeat = true;
    const original = f.rpc.request;
    f.rpc.request = async (method, params) => {
      const result = await original(method, params);
      if (method === 'thread/read') {
        const turns = (
          result as { thread: { turns: { items: { type: string; text?: string }[] }[] } }
        ).thread.turns;
        for (const turn of turns.slice(2))
          for (const item of turn.items)
            if (item.type === 'agentMessage') {
              const report = JSON.parse(item.text!) as {
                verdict: string;
                findings: { id: string }[];
              };
              if (report.verdict === 'FAIL') {
                report.findings[0]!.id = 'another-defect';
                item.text = JSON.stringify(report);
              }
            }
      }
      return result;
    };
    const { a, input, run, failed } = await firstRound(f),
      next = await a.prepareLocalCorrection(input, run.snapshot, run.packet, failed.manifest),
      second = await throughIntegration(f, input, undefined, next),
      rejected = await acceptance(f, second),
      starts = f.state.starts;
    expect(rejected.complete).toBe(false);
    await expect(
      a.prepareLocalCorrection(input, next, second.packet, rejected.manifest),
    ).rejects.toThrow('task-correction-budget-exhausted:' + rejected.manifest.sha256);
    expect(f.state.starts).toBe(starts);
    expect(f.read(await f.service.controls.stopLocalTask(input))).toMatchObject({
      confirmed: true,
    });
  });
  it('requires arbitration after the third consecutive FAIL with the same finding ID', async () => {
    const f = fast();
    f.correctionInput.corrections.maxRounds = 2;
    f.fault.repeat = true;
    const { a, input, run, failed } = await firstRound(f);
    const one = await a.prepareLocalCorrection(input, run.snapshot, run.packet, failed.manifest),
      second = await throughIntegration(f, input, undefined, one),
      rejected = await acceptance(f, second);
    const two = await a.prepareLocalCorrection(input, one, second.packet, rejected.manifest),
      third = await throughIntegration(f, input, undefined, two),
      again = await acceptance(f, third);
    await expect(
      a.prepareLocalCorrection(input, two, third.packet, again.manifest),
    ).rejects.toThrow('task-arbitration-required:' + again.manifest.sha256);
    expect(f.read(await f.service.controls.stopLocalTask(input))).toMatchObject({
      confirmed: true,
    });
  });
  it('rejects copy mode drift before a correction writer starts', async () => {
    const f = fast(),
      { a, input, run, failed } = await firstRound(f),
      next = await a.prepareLocalCorrection(input, run.snapshot, run.packet, failed.manifest);
    const body = f.read(next) as unknown as TaskSnapshot;
    chmodSync(join(body.copy.root, 'accepted.md'), 0o700);
    await expect(a.writeLocalTask(input, next)).rejects.toThrow('task-premature-write');
    expect(f.state.starts).toBe(11);
  });
});

describe('correction partial preparation and initial evidence', { timeout: 30000 }, () => {
  it('stops a planning-only admission without creating a writer or losing its stop receipt', async () => {
    const f = fast();
    await f.service.activities.prepareSubstantialPlanning(f.correctionInput);
    expect(f.read(await f.service.controls.stopLocalTask(f.correctionInput))).toMatchObject({
      confirmed: true,
      rounds: [],
    });
    expect(f.state.starts).toBe(0);
  });
  it('retains initial evidence and encodes a newly created output in addressed evidence', async () => {
    const f = fast(),
      input = f.correctionInput;
    f.correctionPlan.paths.push('new.cjs');
    const bytes = Buffer.from(JSON.stringify(f.correctionPlan));
    writeFileSync(join(f.workspace, 'plan.json'), bytes);
    input.admission.plan.sha256 = digest(bytes);
    const extra = f.save({ kind: 'accepted-source', value: 'retained' });
    input.admission.acceptance = f.save({
      ...f.correctionRequest,
      schemaVersion: 2,
      evidence: [extra],
      expectedFiles: [],
      roles: f.correctionRequest.roles.map((row) =>
        row.roleId === 'reviewer' ? { ...row, paths: [...row.paths, 'new.cjs'] } : row,
      ),
    } satisfies ReviewRequest);
    const original = f.host.createRuntime;
    f.host.createRuntime = (root) => {
      const rpc = original(root);
      return {
        ...rpc,
        async request(method, params) {
          const result = await rpc.request(method, params);
          if (
            method === 'turn/start' &&
            (params.input as { text: string }[])[0]!.text.includes('Выполни локальный план')
          )
            writeFileSync(join(root, 'new.cjs'), 'module.exports=1;\n');
          return result;
        },
      };
    };
    const { run } = await firstRound(f),
      request = f.read(run.packet.request),
      roles = request.roleEvidence as { roleId: string; evidence: ArtifactRef[] }[];
    expect((request.evidence as ArtifactRef[])[0]).toEqual(extra);
    const evidence = roles.find((row) => row.roleId === 'reviewer')!.evidence;
    expect(evidence[0]).toEqual(extra);
    expect(f.read(evidence.at(-1)!).diff).toEqual(
      expect.arrayContaining([{ path: 'new.cjs', before: null, after: 'module.exports=1;\n' }]),
    );
    await f.service.controls.stopLocalTask(input);
  });
});

it('rejects a missing B1 correction check mapping before any writer or model dispatch', async () => {
  const f = localTaskFixture(),
    input: CorrectionTaskInput = {
      ...f.input,
      schemaVersion: 4,
      corrections: { maxRounds: 1, checks: [{ roleId: 'reviewer', commands: [] }] },
    };
  await expect(f.service.activities.prepareLocalTask(input)).rejects.toThrow(
    'task-role-checks-incomplete',
  );
  expect(f.state.starts).toBe(0);
  expect(f.state.creates).toBe(0);
  await f.service.controls.stopLocalTask(input);
});
