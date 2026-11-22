import type { StageSupervisedTaskInput } from '../../src/contracts/localTask.js';
import type { AuditInput, AuditTiming } from '../../src/contracts/audit.js';
import type { TaskStageAudit, TaskStageContext } from '../../src/contracts/stageAudit.js';
import { taskAuditStages } from '../../src/contracts/localTask.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { taskAuditFixture } from './taskAuditFixture.js';
import { acceptance, throughIntegration, runReview } from './localTaskRun.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import { parseTaskStageAudit, parseTaskStageContext } from '../../src/policy/stageAudit.js';
import { confirmTaskStageAudit, confirmTaskStages } from '../../src/activities/stageAudit.js';

async function fixture() {
  const f = taskAuditFixture(true),
    input = f.input as StageSupervisedTaskInput;
  const { planning, record } = await f.prepare();
  const ledger = await f.auditor.service.activities.finishTaskPlanningAudit(record);
  const approved = await runReview(f, planning);
  const snapshot = await f.service.activities.prepareLocalTask(input, approved.manifest, ledger);
  const context: TaskStageContext = { input, snapshot, stage: 'writing', completed: [] };
  const timing: AuditTiming = {
    stage: 'writing',
    estimateMs: 1000,
    elapsedMs: 2000,
    knownElapsedMs: 2000,
    externalWaitMs: 0,
  };
  return { ...f, input, snapshot, context, timing };
}
async function audited(f: Awaited<ReturnType<typeof fixture>>, input: AuditInput) {
  const a = f.auditor.service.activities,
    s = await f.auditor.setup(input);
  const session = await a.launchAuditor(s.input, s.epoch);
  const load = (await a.observeAuditorLoad(s.input, session, s.epoch))!;
  const question = await a.prepareAuditQuestion(s.input, session, load, s.epoch);
  const turn = await a.answerAuditor(s.input, session, question, s.epoch);
  const answer = (await a.observeAuditAnswer(s.input, session, load, question, turn, s.epoch))!;
  const result = await a.finishAudit(s.input, session, load, question, turn, answer, s.epoch);
  const stop = await f.auditor.service.controls.stopAuditor(s.input, s.permit);
  return { input, result: result.manifest, stop };
}
describe('supervision of task implementation, checks and acceptance', { timeout: 15000 }, () => {
  it('requires every original estimate before any operation', () => {
    const f = taskAuditFixture(true);
    expect(parseLocalTask(f.input)).toEqual(f.input);
    const input = f.input as StageSupervisedTaskInput;
    for (const value of [0, -1, 0.5, 3600001, null])
      expect(() =>
        parseLocalTask({
          ...input,
          audit: { ...input.audit, stages: { ...input.audit.stages, writing: value } },
        }),
      ).toThrow();
    expect(() =>
      parseLocalTask({ ...input, audit: { ...input.audit, stages: { writing: 1000 } } }),
    ).toThrow();
    expect(() =>
      parseLocalTask({
        ...input,
        audit: { ...input.audit, stages: { ...input.audit.stages, extra: 1000 } },
      }),
    ).toThrow();
  });
  describe('validation of the prepared stage', () => {
    let baseline: Awaited<ReturnType<typeof fixture>>;
    beforeAll(async () => {
      baseline = await fixture();
    });
    function freshStage() {
      const context = structuredClone(baseline.context);
      return { ...baseline, context, input: context.input, timing: { ...baseline.timing } };
    }
    it.each(['stage', 'version', 'evidence', 'duplicate', 'snapshot'])(
      'rejects a malformed stage context: %s',
      (defect) => {
        const f = freshStage(),
          raw = f.context as unknown as Record<string, unknown>;
        if (defect === 'stage') raw.stage = 'done';
        if (defect === 'version')
          raw.input = { ...f.input, schemaVersion: 7, audit: { planningEstimateMs: 1000 } };
        if (defect === 'evidence') raw.completed = null;
        if (defect === 'duplicate') raw.completed = [f.snapshot, f.snapshot];
        if (defect === 'snapshot') raw.snapshot = {};
        expect(() => parseTaskStageContext(raw)).toThrow();
      },
    );
    it.each([
      'estimate',
      'stage',
      'wait',
      'unknown',
      'overrun',
      'claim',
      'input',
      'kind',
      'audit-id',
      'audit-preparation',
      'audit-claim',
    ])('rejects a forged stage record: %s', (defect) => {
      const f = freshStage();
      const record: TaskStageAudit = {
        schemaVersion: 1,
        kind: 'task-stage-supervision',
        context: f.context,
        timing: { ...f.timing, elapsedMs: 1000, knownElapsedMs: 1000 },
        claim: null,
        audit: null,
      };
      if (defect === 'estimate') record.timing.estimateMs++;
      if (defect === 'stage') record.timing.stage = 'planning';
      if (defect === 'wait') record.timing.externalWaitMs = null;
      if (defect === 'unknown') record.timing.elapsedMs = null;
      if (defect === 'overrun') record.timing.elapsedMs = record.timing.knownElapsedMs = 2000;
      if (defect === 'claim') record.claim = 'writing:overrun';
      if (defect === 'input') record.context.input = { ...f.input, baseline: 'other' };
      if (defect === 'kind') Object.assign(record, { kind: 'other' });
      if (defect.startsWith('audit-')) {
        record.timing = f.timing;
        record.claim = 'writing:overrun';
        record.audit = {
          input: {
            schemaVersion: 1,
            preparation: structuredClone(f.input.admission.preparation),
            auditId: 'writing-overrun',
            card: f.proof,
            preflight: f.proof,
          },
          result: f.proof,
          stop: f.proof,
        };
        if (defect === 'audit-id') record.audit.input.auditId = 'other';
        if (defect === 'audit-preparation') record.audit.input.preparation.revision++;
        if (defect === 'audit-claim') record.claim = 'other';
      }
      expect(() => parseTaskStageAudit(record, f.input)).toThrow();
    });
    it.each(['time', 'snapshot', 'goal', 'private', 'missing'])(
      'blocks incomplete primary facts before starting an auditor: %s',
      async (defect) => {
        const f = freshStage(),
          a = f.auditor.service.activities;
        const body = f.read(f.snapshot) as {
          input: unknown;
          tree: { files: unknown[] };
          plan: { requirement: { hash: string } };
        };
        if (defect === 'time') f.timing.stage = 'other';
        if (defect === 'snapshot') body.input = {};
        if (defect === 'goal') body.plan.requirement.hash = '0'.repeat(64);
        if (defect === 'private') body.tree.files.push({ path: '.env' });
        if (defect === 'missing') f.context.completed = [{ sha256: '0'.repeat(64), bytes: 0 }];
        f.context.snapshot = f.save(body);
        const preflight = await a.preflightAuditor(f.input.admission.preparation);
        await expect(a.prepareTaskStageAudit(f.context, f.timing, preflight)).rejects.toThrow();
        expect(f.auditor.state.starts).toBe(0);
      },
    );
  });
  it('retains the full primary proposal and verifies an independent audit through final checks and DONE', async () => {
    const f = await fixture(),
      a = f.auditor.service.activities;
    const baseline = await f.service.activities.checkLocalTask(
      f.input,
      f.snapshot,
      'baseline',
      null,
      null,
    );
    f.context.completed = [baseline.manifest];
    const preflight = await a.preflightAuditor(f.input.admission.preparation);
    const input = await a.prepareTaskStageAudit(f.context, f.timing, preflight);
    const card = f.read(input.card),
      completed = card.completed as { sha256: string }[];
    expect(completed).toContainEqual(f.snapshot);
    expect(completed).toContainEqual(baseline.manifest);
    const contents = completed.map((ref) => {
      try {
        return f.read(ref as { sha256: string; bytes: number });
      } catch {
        return {};
      }
    });
    expect(contents.some((body) => body.kind === 'substantial-proposal')).toBe(true);
    const audit = await audited(f, input);
    const run = await throughIntegration(f, f.input, undefined, f.snapshot);
    const review = await acceptance(f, run);
    const stages = [];
    for (const stage of taskAuditStages)
      stages.push(
        await a.finishTaskStageAudit({
          schemaVersion: 1,
          kind: 'task-stage-supervision',
          context: { ...f.context, stage },
          timing: {
            ...f.timing,
            stage,
            elapsedMs: stage === 'writing' ? 2000 : 1000,
            knownElapsedMs: stage === 'writing' ? 2000 : 1000,
          },
          claim: stage === 'writing' ? 'writing:overrun' : null,
          audit: stage === 'writing' ? audit : null,
        }),
      );
    await expect(
      f.service.activities.finishLocalTask(f.input, f.snapshot, run.packet, review.manifest),
    ).rejects.toThrow('task-stages-incomplete');
    await expect(
      confirmTaskStages(f.registration, f.auditor.rpc, f.input, f.snapshot, stages.slice(1)),
    ).rejects.toThrow('task-stages-incomplete');
    await expect(
      confirmTaskStages(f.registration, f.auditor.rpc, f.input, f.snapshot, [...stages].reverse()),
    ).rejects.toThrow('task-stages-order');
    await expect(
      confirmTaskStages(f.registration, f.auditor.rpc, f.input, f.proof, stages),
    ).rejects.toThrow('task-stages-order');
    const result = await f.service.activities.finishLocalTask(
      f.input,
      f.snapshot,
      run.packet,
      review.manifest,
      stages,
    );
    expect(f.read(result.result)).toMatchObject({
      stages,
      stageVerification: [null, expect.any(Object), null, null, null, null],
      complete: true,
    });
    expect(f.auditor.state.starts).toBe(4);
  });
  it.each(['partial', 'replace-executor', 'card', 'context', 'stop'])(
    'rejects a held or detached audit before stage completion: %s',
    async (defect) => {
      const f = await fixture(),
        a = f.auditor.service.activities;
      if (defect === 'partial') {
        f.auditor.state.coverage = 'partial';
        f.auditor.state.direction = null;
      }
      if (defect === 'replace-executor') f.auditor.state.direction = 'replace-executor';
      const input = await a.prepareTaskStageAudit(
        f.context,
        f.timing,
        await a.preflightAuditor(f.input.admission.preparation),
      );
      const audit = await audited(f, input);
      if (defect === 'card') {
        const card = f.read(input.card);
        card.completed = [f.proof];
        audit.input = { ...input, card: f.save(card) };
      }
      if (defect === 'context') {
        const card = f.read(input.card);
        const refs = card.completed as { sha256: string; bytes: number }[];
        const context = f.read(refs[0]!);
        context.context = {};
        refs[0] = f.save(context);
        audit.input = { ...input, card: f.save(card) };
      }
      if (defect === 'stop') audit.stop = f.proof;
      const record: TaskStageAudit = {
        schemaVersion: 1,
        kind: 'task-stage-supervision',
        context: f.context,
        timing: f.timing,
        claim: 'writing:overrun',
        audit,
      };
      await expect(
        confirmTaskStageAudit(f.registration, f.auditor.rpc, f.input, f.save(record)),
      ).rejects.toThrow();
    },
  );
});
