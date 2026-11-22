import type { ProgressSupervisedTaskInput } from '../../src/contracts/localTask.js';
import type { TaskProgressAudit, TaskProgressContext } from '../../src/contracts/progressAudit.js';
import { taskAuditStages } from '../../src/contracts/localTask.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { taskAuditFixture } from './taskAuditFixture.js';
import { acceptance, throughIntegration, runReview } from './localTaskRun.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import { auditClaim } from '../../src/policy/audit.js';
import {
  parseTaskProgressContext,
  parseTaskProgressAudit,
  parseTaskProgressEvidence,
} from '../../src/policy/progressAudit.js';
import { confirmTaskProgressAudit } from '../../src/activities/progressAudit.js';

async function fixture(kind: 'no-progress' | 'doubt' = 'no-progress') {
  const f = taskAuditFixture(true, kind),
    input = f.input as ProgressSupervisedTaskInput;
  const { planning, record } = await f.prepare();
  const ledger = await f.auditor.service.activities.finishTaskPlanningAudit(record);
  const approved = await runReview(f, planning);
  const snapshot = await f.service.activities.prepareLocalTask(input, approved.manifest, ledger);
  const baseline = await f.service.activities.checkLocalTask(
    input,
    snapshot,
    'baseline',
    null,
    null,
  );
  const context: TaskProgressContext = {
    input,
    snapshot,
    baseline: baseline.manifest,
    taskElapsedMs: 1000,
  };
  const a = f.auditor.service.activities;
  const preflight = await a.preflightAuditor(input.admission.preparation);
  return { ...f, input, snapshot, baseline, context, a, preflight };
}
async function audited(f: Awaited<ReturnType<typeof fixture>>) {
  const input = await f.a.prepareTaskProgressAudit(f.context, f.preflight);
  const run = await f.runAudit(input);
  const record: TaskProgressAudit = {
    schemaVersion: 1,
    kind: 'task-progress-supervision',
    context: f.context,
    timing: null,
    claim: auditClaim(null, f.input.progress.checkpoint, f.input.progress.trigger, []),
    audit: { input, result: run.result.manifest, stop: run.stop },
  };
  return { record, ...run };
}
describe('explicit no-progress and doubt checkpoint before writer', { timeout: 20000 }, () => {
  it('rejects an incomplete progress request before dependent planning or audit models', async () => {
    const f = taskAuditFixture(true, 'no-progress'),
      input = f.input as ProgressSupervisedTaskInput;
    const note = f.read(input.progress.trigger.evidence);
    input.progress.trigger.evidence = f.save({ ...note, evidence: [] });
    await expect(f.service.activities.prepareSubstantialPlanning(input)).rejects.toThrow(
      'task-progress-evidence-required',
    );
    expect(f.state.starts).toBe(0);
    expect(f.auditor.state.starts).toBe(0);
  });
  it.each(['no-progress', 'doubt'] as const)(
    'retains the full original chain without inventing timing and rechecks %s before DONE',
    async (kind) => {
      const f = await fixture(kind);
      if (kind === 'doubt') f.context.taskElapsedMs = null;
      expect(parseLocalTask(f.input)).toEqual(f.input);
      expect(f.state.creates).toBe(0);
      await expect(f.service.activities.writeLocalTask(f.input, f.snapshot)).rejects.toThrow(
        'task-progress-required',
      );
      expect(f.state.creates).toBe(0);
      const { record, question } = await audited(f);
      const card = f.read(record.audit.input.card);
      expect(card).toMatchObject({
        timing: null,
        checkpoint: 'before-writing',
        trigger: f.input.progress.trigger,
      });
      const packet = f.read(question) as {
        evidence: { ref: { sha256: string }; content: string }[];
        allowedSources: string[];
      };
      expect(new Set(packet.allowedSources).size).toBe(packet.allowedSources.length);
      expect(
        packet.evidence.filter(
          (row) => row.ref.sha256 === f.input.progress.trigger.evidence.sha256,
        ),
      ).toHaveLength(1);
      const text = packet.evidence.map((row) => row.content).join('\n');
      expect(text).toContain('substantial-proposal');
      expect(text).toContain('reader-answer');
      expect(text).toContain('task-planning-supervision');
      expect(text).toContain('task-check');
      expect(text).toContain('caller-reported');
      const progress = await f.a.finishTaskProgressAudit(record);
      const run = await throughIntegration(f, f.input, undefined, f.snapshot, progress);
      const reviewed = await acceptance(f, run);
      const stages = [];
      for (const stage of taskAuditStages)
        stages.push(
          await f.a.finishTaskStageAudit({
            schemaVersion: 1,
            kind: 'task-stage-supervision',
            context: { input: f.input, stage, snapshot: f.snapshot, completed: [] },
            timing: { stage, estimateMs: 1000, elapsedMs: 1, knownElapsedMs: 1, externalWaitMs: 0 },
            claim: null,
            audit: null,
          }),
        );
      await expect(
        f.service.activities.finishLocalTask(
          f.input,
          f.snapshot,
          run.packet,
          reviewed.manifest,
          stages,
        ),
      ).rejects.toThrow('task-progress-required');
      const result = await f.service.activities.finishLocalTask(
        f.input,
        f.snapshot,
        run.packet,
        reviewed.manifest,
        stages,
        progress,
      );
      expect(f.read(result.result)).toMatchObject({
        progress,
        complete: true,
      });
      expect(f.read(result.result)).toHaveProperty('progressVerification.sha256');
      expect(f.auditor.state.starts).toBe(4);
    },
  );
  it.each(['overrun', 'missing', 'extra', 'oversized'])(
    'rejects an unsupported or incomplete checkpoint input: %s',
    (defect) => {
      const f = taskAuditFixture(true, 'no-progress'),
        input = f.input as ProgressSupervisedTaskInput;
      const progress =
        defect === 'missing'
          ? undefined
          : defect === 'oversized'
            ? { ...input.progress, checkpoint: 'a'.repeat(120) }
            : defect === 'extra'
              ? { ...input.progress, elapsedMs: 0 }
              : { ...input.progress, trigger: { ...input.progress.trigger, kind: 'overrun' } };
      expect(() => parseLocalTask({ ...input, progress })).toThrow();
      expect(f.auditor.state.starts).toBe(0);
    },
  );
  describe('independent mutations of a confirmed baseline', () => {
    let baseline: Awaited<ReturnType<typeof fixture>>;
    beforeAll(async () => {
      baseline = await fixture();
    });
    function freshContext() {
      // Published artifacts are immutable. Each case mutates only its own input
      // and context, and publishes any changed bytes under a new hash.
      const context = structuredClone(baseline.context);
      return { ...baseline, context, input: context.input };
    }
    it.each([
      'context-version',
      'context-extra',
      'context-time',
      'context-unknown',
      'record-version',
      'kind',
      'timing',
      'claim',
      'input',
      'audit-id',
      'audit-preparation',
    ])('rejects a detached or invented record: %s', async (defect) => {
      const f = freshContext();
      const context = structuredClone(f.context) as unknown as Record<string, unknown>;
      if (defect === 'context-version') context.input = { ...f.input, schemaVersion: 8 };
      if (defect === 'context-extra') context.elapsedMs = 0;
      if (defect === 'context-time') context.taskElapsedMs = -1;
      if (defect === 'context-unknown') delete context.taskElapsedMs;
      if (defect.startsWith('context-')) {
        expect(() => parseTaskProgressContext(context)).toThrow();
        return;
      }
      const record: TaskProgressAudit = {
        schemaVersion: 1,
        kind: 'task-progress-supervision',
        context: f.context,
        timing: null,
        claim: auditClaim(null, f.input.progress.checkpoint, f.input.progress.trigger, []),
        audit: {
          input: {
            schemaVersion: 1,
            preparation: structuredClone(f.input.admission.preparation),
            auditId: 'progress-before-writing',
            card: f.proof,
            preflight: f.proof,
          },
          result: f.proof,
          stop: f.proof,
        },
      };
      if (defect === 'record-version') Object.assign(record, { schemaVersion: 2 });
      if (defect === 'kind') Object.assign(record, { kind: 'other' });
      if (defect === 'timing')
        Object.assign(record, { timing: { stage: 'invented', estimateMs: 1000 } });
      if (defect === 'claim') record.claim = 'other';
      if (defect === 'input') record.context.input = { ...f.input, baseline: 'other' };
      if (defect === 'audit-id') record.audit.input.auditId = 'other';
      if (defect === 'audit-preparation') record.audit.input.preparation.revision++;
      expect(() => parseTaskProgressAudit(record, f.input)).toThrow();
    });
    it.each([
      'goal',
      'preparation',
      'checkpoint',
      'trigger',
      'kind',
      'empty',
      'duplicate',
      'missing-blob',
      'reason',
      'extra',
    ])('requires bound primary request evidence before any auditor turn: %s', async (defect) => {
      const f = freshContext();
      const note = f.read(f.input.progress.trigger.evidence) as Record<string, unknown>;
      if (defect === 'goal') note.goal = { ...(note.goal as object), sha256: '0'.repeat(64) };
      if (defect === 'preparation')
        note.preparation = { ...f.input.admission.preparation, revision: 2 };
      if (defect === 'checkpoint') note.checkpoint = 'other';
      if (defect === 'trigger') note.trigger = 'doubt';
      if (defect === 'kind') note.kind = 'other';
      if (defect === 'empty') note.evidence = [];
      if (defect === 'duplicate') note.evidence = [f.proof, f.proof];
      if (defect === 'missing-blob') note.evidence = [{ sha256: '0'.repeat(64), bytes: 0 }];
      if (defect === 'reason') note.reason = ' ';
      if (defect === 'extra') note.elapsedMs = 0;
      f.input.progress.trigger.evidence = f.save(note);
      // Keep the input binding exact so the request itself is the rejected boundary.
      f.context.input = f.input;
      const body = f.read(f.snapshot);
      body.input = f.input;
      f.context.snapshot = f.save(body);
      const baseline = f.read(f.context.baseline);
      baseline.input = f.input;
      baseline.snapshot = f.context.snapshot;
      const row = (baseline.outcomes as { proof: unknown }[])[0]!;
      const check = f.read(row.proof as { sha256: string; bytes: number });
      check.input = f.input;
      row.proof = f.save(check);
      f.context.baseline = f.save(baseline);
      await expect(f.a.prepareTaskProgressAudit(f.context, f.preflight)).rejects.toThrow();
      expect(f.auditor.state.starts).toBe(0);
    });
    it.each([
      'snapshot',
      'planning',
      'kind',
      'input',
      'binding',
      'stage',
      'status',
      'outcomes',
      'name',
      'outcome-status',
      'proof-kind',
      'proof-input',
      'proof-stage',
      'proof-name',
      'proof-status',
      'code',
      'signal',
      'error',
      'mutation',
    ])('rejects an unconfirmed baseline chain: %s', async (defect) => {
      const f = freshContext(),
        body = f.read(f.snapshot);
      if (defect === 'snapshot') body.input = {};
      if (defect === 'planning') delete body.supervision;
      if (defect === 'snapshot' || defect === 'planning') f.context.snapshot = f.save(body);
      const baseline = f.read(f.context.baseline);
      if (defect === 'kind') baseline.kind = 'other';
      if (defect === 'input') baseline.input = {};
      if (defect === 'binding') baseline.snapshot = f.proof;
      if (defect === 'stage') baseline.stage = 'candidate';
      if (defect === 'status') baseline.status = 'FAIL';
      if (defect === 'outcomes') baseline.outcomes = [];
      const row = (baseline.outcomes as { name: string; status: string; proof: unknown }[])[0];
      if (row) {
        if (defect === 'name') row.name = 'other';
        if (defect === 'outcome-status') row.status = 'FAIL';
        const check = f.read(row.proof as { sha256: string; bytes: number });
        if (defect === 'proof-kind') check.kind = 'other';
        if (defect === 'proof-input') check.input = {};
        if (defect === 'proof-stage') check.stage = 'candidate';
        if (defect === 'proof-name') check.name = 'other';
        if (defect === 'proof-status') check.status = 'FAIL';
        if (defect === 'code') check.code = 1;
        if (defect === 'signal') check.signal = 'SIGTERM';
        if (defect === 'error') check.error = 'lost';
        if (defect === 'mutation') check.after = {};
        row.proof = f.save(check);
      }
      f.context.baseline = f.save(baseline);
      await expect(f.a.prepareTaskProgressAudit(f.context, f.preflight)).rejects.toThrow();
      expect(f.auditor.state.starts).toBe(0);
    });
  });
  it.each([
    'partial',
    'replace-approach',
    'replace-executor',
    'reconsider-constraints',
    'context',
    'snapshot',
    'baseline',
    'timing',
    'trigger',
    'missing-source',
    'reason',
    'stop',
  ])('holds a non-continuing or detached audit: %s', async (defect) => {
    const f = await fixture();
    if (defect === 'partial') {
      f.auditor.state.coverage = 'partial';
      f.auditor.state.direction = null;
    }
    if (['replace-approach', 'replace-executor', 'reconsider-constraints'].includes(defect))
      f.auditor.state.direction = defect;
    const { record } = await audited(f);
    if (defect === 'snapshot') record.context.snapshot = f.proof;
    if (defect === 'baseline') record.context.baseline = f.proof;
    if (defect === 'stop') record.audit.stop = f.proof;
    if (['context', 'timing', 'trigger', 'missing-source', 'reason'].includes(defect)) {
      const card = f.read(record.audit.input.card),
        refs = card.completed as { sha256: string; bytes: number }[];
      if (defect === 'context') {
        const context = f.read(refs[0]!);
        context.context = {};
        refs[0] = f.save(context);
      }
      if (defect === 'timing')
        card.timing = {
          stage: 'invented',
          estimateMs: 1,
          elapsedMs: 0,
          knownElapsedMs: 0,
          externalWaitMs: 0,
        };
      if (defect === 'trigger') card.trigger = { ...f.input.progress.trigger, kind: 'doubt' };
      if (defect === 'missing-source')
        card.completed = refs.filter(
          (ref) => ref.sha256 !== f.input.progress.trigger.evidence.sha256,
        );
      if (defect === 'reason') card.openFindings = [];
      record.audit.input = { ...record.audit.input, card: f.save(card) };
    }
    await expect(
      confirmTaskProgressAudit(
        f.registration,
        f.auditor.rpc,
        f.input,
        f.snapshot,
        f.context.baseline,
        f.save(record),
      ),
    ).rejects.toThrow();
    await expect(
      f.service.activities.writeLocalTask(f.input, f.snapshot, f.save(record)),
    ).rejects.toThrow();
    expect(f.state.creates).toBe(0);
  });
  it('rejects a missing reason even when its other fields match', () => {
    const f = taskAuditFixture(true, 'doubt'),
      input = f.input as ProgressSupervisedTaskInput;
    const note = f.read(input.progress.trigger.evidence);
    expect(() =>
      parseTaskProgressEvidence(
        { ...note, reason: null },
        input,
        note.goal as { path: string; sha256: string; bytes: number },
      ),
    ).toThrow();
  });
});
