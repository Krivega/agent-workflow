import type { ArtifactRef } from '../../src/contracts/preparation.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskAuditFixture } from './taskAuditFixture.js';
import { acceptance, runReview, throughIntegration } from './localTaskRun.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import { parsePlanningSupervision } from '../../src/policy/taskAudit.js';
import {
  confirmPlanningSupervision,
  taskPlanningProgress,
} from '../../src/activities/taskAudit.js';
import { reviewActivities } from '../../src/activities/review.js';
import { readerActivities } from '../../src/activities/reader.js';
import { prepareScopedReview } from '../../src/adapters/codex/reviewInputs.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerExecution } from '../../src/policy/readerExecution.js';
import { requireScoped } from '../../src/policy/review.js';

afterEach(() => vi.restoreAllMocks());
describe('planning supervision before writer admission', { timeout: 15000 }, () => {
  it.each(['unavailable', 'opaque-error', 'wrong-profile', 'different-error', 'new-client'])(
    'keeps unsupported pre-first-turn history unknown and verifies the native header: %s',
    async (mode) => {
      const f = taskAuditFixture(),
        { planning } = await f.prepare();
      const profile = {
        ...f.profile,
        clientVersion: mode === 'new-client' ? '0.165.0-alpha.1.2' : '0.154.0',
      };
      const selection = await reviewActivities(f.registration, f.rpc, profile).prepareReviewPlan(
        planning,
      );
      const input = requireScoped(
        selection.decisions.find((row) => row.action === 'review')!.input!,
      );
      const permit = readerBoundary(
        join(f.root, 'header-permits'),
        f.store,
        f.workspace,
        readerExecution(profile),
      ).install(input);
      const actor = readerActivities(f.registration, f.rpc, profile, join(f.root, 'header-reader'));
      const session = await actor.createReader(input, prepareScopedReview(f.registration, input));
      const original = f.rpc.request;
      const unsupported =
        'app-server-error:{"code":-32601,"message":"list_turns is not supported yet"}';
      vi.spyOn(f.rpc, 'request').mockImplementation(async (method, params) => {
        if (method === 'thread/read' && params.includeTurns === true) {
          if (mode === 'opaque-error') throw unsupported;
          throw new Error(mode === 'different-error' ? 'transport offline' : unsupported);
        }
        const value = await original(method, params);
        if (method === 'thread/read') {
          const raw = value as { thread: Record<string, unknown> };
          return {
            thread: {
              ...raw.thread,
              model: mode === 'wrong-profile' ? 'foreign' : profile.model,
              reasoningEffort: profile.effort,
              cliVersion: profile.clientVersion,
              status: { type: 'idle' },
            },
          };
        }
        return value;
      });
      const operations = f.save({
        kind: 'task-planning-reader-operations',
        input,
        permit,
        observation: { permission: 'active', revision: 0, requests: [] },
      });
      const progress = taskPlanningProgress(f.registration, f.rpc, profile, f.input, planning, [
        { input, permit, session, operations },
      ]);
      if (mode === 'unavailable' || mode === 'opaque-error') {
        const body = f.read(await progress);
        expect(body.roles).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              roleId: input.roleId,
              historyError: unsupported,
              loadConfirmed: false,
            }),
          ]),
        );
      } else await expect(progress).rejects.toThrow();
      expect(f.state.starts).toBe(0);
    },
  );
  it.each(['missing', 'foreign', 'kind'])(
    'requires bound primary progress before preparing the audit card: %s',
    async (defect) => {
      const f = taskAuditFixture(),
        { planning, record } = await f.prepare();
      const activities = f.auditor.service.activities;
      const preflight = await activities.preflightAuditor(f.input.admission.preparation);
      record.timing.elapsedMs = record.timing.knownElapsedMs = 2000;
      const progress = await taskPlanningProgress(
        f.registration,
        f.rpc,
        f.profile,
        f.input,
        planning,
        [],
      );
      const body = f.read(progress);
      if (defect === 'foreign') body.planning = {};
      if (defect === 'kind') body.kind = 'foreign';
      await expect(
        activities.prepareTaskPlanningAudit(
          f.input,
          planning,
          preflight,
          record.timing,
          defect === 'missing' ? undefined : f.save(body),
        ),
      ).rejects.toThrow();
      expect(f.auditor.state.starts).toBe(0);
    },
  );
  it('preserves opaque original FAIL evidence and every declared planning artifact in the sole audit card', async () => {
    const f = taskAuditFixture();
    const request = f.read(f.input.admission.planning);
    const original = f.store.publish(
      Buffer.from('Historical FAIL: preserve this exact non-JSON evidence.'),
    );
    f.input.admission.planning = f.save({
      ...request,
      schemaVersion: 2,
      evidence: [original],
      expectedFiles: [],
    });
    const { record, question } = await f.audit();
    const card = f.read(record.audit!.input.card);
    expect(card.completed).toEqual(
      expect.arrayContaining([original, f.input.admission.planning, f.input.admission.acceptance]),
    );
    const evidence = f.read(question).evidence as { ref: unknown; content: string }[];
    expect(
      evidence.find((row) => JSON.stringify(row.ref) === JSON.stringify(original))?.content,
    ).toContain('Historical FAIL');
    await expect(
      f.auditor.service.activities.finishTaskPlanningAudit(record),
    ).resolves.toBeDefined();
  });
  it('records already reused primary answers without starting another council model', async () => {
    const f = taskAuditFixture(),
      { planning } = await f.prepare();
    const reviewed = await runReview(f, planning);
    const reports = f.read(reviewed.manifest).reports as { roleId: string; answer: ArtifactRef }[];
    const request = f.read(planning.request) as {
      roles: { roleId: string; history: { complete: boolean; answers: unknown[] } }[];
    };
    for (const report of reports)
      request.roles
        .find((row) => row.roleId === report.roleId)!
        .history.answers.push(report.answer);
    const next = { ...planning, reviewId: 'progress-reuse', request: f.save(request) };
    const starts = f.state.starts;
    const progress = f.read(
      await taskPlanningProgress(f.registration, f.rpc, f.profile, f.input, next, []),
    );
    const reused = (
      progress.roles as { roleId: string; action: string; answer: { content: unknown } | null }[]
    ).find((row) => row.roleId === 'reviewer');
    expect(reused?.action).toBe('reuse');
    expect(reused?.answer?.content).toHaveProperty('kind', 'reader-answer');
    expect(f.state.starts).toBe(starts);
  });
  it.each(['registered', 'empty', 'loaded', 'in-progress', 'permit', 'session', 'primary', 'load'])(
    'captures exact primary council progress without a dependent model: %s',
    async (mode) => {
      const f = taskAuditFixture(),
        { planning } = await f.prepare();
      const selection = await reviewActivities(f.registration, f.rpc, f.profile).prepareReviewPlan(
        planning,
      );
      const row = selection.decisions.find((r) => r.action === 'review')!;
      const input = requireScoped(row.input!);
      const boundary = readerBoundary(
        join(f.root, 'progress-permits'),
        f.store,
        f.workspace,
        readerExecution(f.profile),
      );
      let permit = boundary.install(input);
      let session = null;
      if (mode !== 'registered' && mode !== 'permit') {
        const prepared = prepareScopedReview(f.registration, input);
        const actor = readerActivities(
          f.registration,
          f.rpc,
          f.profile,
          join(f.root, 'progress-reader'),
        );
        session = await actor.createReader(input, prepared);
        if (mode !== 'empty') await actor.loadReader(input, prepared, session);
      }
      if (mode === 'permit') permit = f.save({ ...f.read(permit), target: {} });
      if (mode === 'session')
        session!.creation = f.save({ ...f.read(session!.creation), input: {} });
      const primary = f.rpc.request;
      if (['primary', 'load', 'in-progress'].includes(mode))
        vi.spyOn(f.rpc, 'request').mockImplementation(async (method, params) => {
          const result = await primary(method, params);
          if (method === 'thread/read') {
            const response = structuredClone(result) as {
              thread: { id: string; turns: { status: string; items: unknown[] }[] };
            };
            if (mode === 'primary') response.thread.id = 'foreign';
            if (mode === 'load') response.thread.turns[0]!.items = [];
            if (mode === 'in-progress') response.thread.turns[0]!.status = 'inProgress';
            return response;
          }
          return result;
        });
      const starts = f.state.starts;
      const progress = taskPlanningProgress(f.registration, f.rpc, f.profile, f.input, planning, [
        { input, permit, session },
      ]);
      if (['permit', 'session', 'primary', 'load'].includes(mode))
        await expect(progress).rejects.toThrow();
      else {
        const body = f.read(await progress);
        expect(body).toMatchObject({ kind: 'task-planning-progress', input: f.input, planning });
        expect(body.roles).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              roleId: 'reviewer',
              observation: mode === 'registered' ? 'registered' : 'session-observed',
            }),
          ]),
        );
        if (mode !== 'registered')
          expect(body.roles).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ roleId: 'reviewer', loadConfirmed: mode === 'loaded' }),
            ]),
          );
      }
      expect(f.state.starts).toBe(starts);
    },
  );
  it.each([false, true])(
    'retains verified planning supervision through actual checks, source changes and final acceptance: audited=%s',
    async (audited) => {
      const f = taskAuditFixture();
      const { planning, record } = audited ? await f.audit() : await f.prepare();
      const ledger = await f.auditor.service.activities.finishTaskPlanningAudit(record);
      const approved = await runReview(f, planning);
      const snapshot = await f.service.activities.prepareLocalTask(
        f.input,
        approved.manifest,
        ledger,
      );
      expect(
        await f.service.activities.prepareLocalTask(f.input, approved.manifest, ledger),
      ).toEqual(snapshot);
      expect(f.read(snapshot).supervision).toEqual(ledger);
      const run = await throughIntegration(f, f.input, approved.manifest, snapshot);
      const verdict = await acceptance(f, run);
      const result = await f.service.activities.finishLocalTask(
        f.input,
        snapshot,
        run.packet,
        verdict.manifest,
      );
      expect(f.read(result.result)).toMatchObject({ complete: true, supervision: ledger });
      expect(f.read(result.result).auditVerification === null).toBe(!audited);
      expect(
        await f.service.activities.finishLocalTask(f.input, snapshot, run.packet, verdict.manifest),
      ).toEqual(result);
      expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).toContain('trim()');
      expect(f.auditor.state.starts).toBe(audited ? 4 : 0);
    },
  );
  it.each(['partial', 'replace-approach', 'replace-executor', 'reconsider-constraints'])(
    'holds an incomplete or non-continuing audit before copy and writer: %s',
    async (direction) => {
      const f = taskAuditFixture();
      if (direction === 'partial') {
        f.auditor.state.coverage = 'partial';
        f.auditor.state.direction = null;
      } else f.auditor.state.direction = direction;
      const { planning, record } = await f.audit();
      await expect(f.auditor.service.activities.finishTaskPlanningAudit(record)).rejects.toThrow(
        'task-supervision-held',
      );
      const approved = await runReview(f, planning);
      await expect(
        f.service.activities.prepareLocalTask(f.input, approved.manifest, f.save(record)),
      ).rejects.toThrow('task-supervision-held');
      expect(f.state.creates).toBe(0);
      await f.service.controls.stopLocalTask(f.input);
    },
  );
  it('requires the dedicated host and a bound ledger before creating a writer copy', async () => {
    const f = taskAuditFixture();
    const { localTaskActivities } = await import('../../src/activities/localTask.js');
    const unregistered = localTaskActivities(f.registration, f.host, f.rpc, f.profile, () => {});
    await expect(unregistered.activities.prepareSubstantialPlanning(f.input)).rejects.toThrow(
      'task-auditor-host-required',
    );
    const { planning, record } = await f.prepare();
    const approved = await runReview(f, planning);
    await expect(f.service.activities.prepareLocalTask(f.input, approved.manifest)).rejects.toThrow(
      'task-supervision-required',
    );
    const ledger = f.save(record);
    const snapshot = await f.service.activities.prepareLocalTask(
      f.input,
      approved.manifest,
      ledger,
    );
    const conflict = f.save({
      ...record,
      timing: { ...record.timing, elapsedMs: 1100, knownElapsedMs: 1100 },
    });
    await expect(
      f.service.activities.prepareLocalTask(f.input, approved.manifest, conflict),
    ).rejects.toThrow('task-supervision-conflict');
    expect(f.read(snapshot).supervision).toEqual(ledger);
    expect(f.state.creates).toBe(0);
    await f.service.controls.stopLocalTask(f.input);
  });
  it('checks original estimates and requires a declared auditor before any effect', () => {
    const f = taskAuditFixture();
    expect(parseLocalTask(f.input)).toEqual(f.input);
    for (const planningEstimateMs of [0, -1, 0.5, 3600001, null])
      expect(() => parseLocalTask({ ...f.input, audit: { planningEstimateMs } })).toThrow();
    expect(() =>
      parseLocalTask({ ...f.input, audit: { ...f.input.audit, extra: true } }),
    ).toThrow();
    const input = structuredClone(f.input);
    input.admission.preparation.project.roles = input.admission.preparation.project.roles.filter(
      (r) => r.id !== 'auditor',
    );
    expect(() => parseLocalTask(input)).toThrow();
  });
  it.each([
    'estimate',
    'wait',
    'unknown',
    'overrun',
    'claim',
    'input',
    'planning',
    'audit-id',
    'audit-preparation',
    'audit-claim',
  ])('rejects a forged supervision record: %s', async (defect) => {
    const f = taskAuditFixture();
    const { record } = await f.prepare();
    const raw = structuredClone(record);
    if (defect === 'estimate') raw.timing.estimateMs++;
    if (defect === 'wait') raw.timing.externalWaitMs = 1;
    if (defect === 'unknown') raw.timing.elapsedMs = null;
    if (defect === 'overrun') raw.timing.elapsedMs = raw.timing.knownElapsedMs = 2000;
    if (defect === 'claim') raw.claim = 'planning:overrun';
    if (defect === 'input') raw.input.audit.planningEstimateMs++;
    if (defect === 'planning') raw.planning.preparation.revision++;
    if (defect.startsWith('audit-')) {
      raw.timing.elapsedMs = raw.timing.knownElapsedMs = 2000;
      raw.claim = 'planning:overrun';
      raw.audit = {
        input: {
          schemaVersion: 1,
          preparation: structuredClone(f.input.admission.preparation),
          auditId: 'planning-overrun',
          card: f.proof,
          preflight: f.proof,
        },
        result: f.proof,
        stop: f.proof,
      };
      if (defect === 'audit-id') raw.audit.input.auditId = 'other';
      if (defect === 'audit-preparation') raw.audit.input.preparation.revision++;
      if (defect === 'audit-claim') raw.claim = 'other';
    }
    expect(() => parsePlanningSupervision(raw, f.input)).toThrow();
  });
  it.each(['plan', 'proposal', 'request', 'time', 'source', 'goal'])(
    'rejects changed or unbound facts before an audit launch: %s',
    async (defect) => {
      const f = taskAuditFixture();
      const { planning, record } = await f.prepare();
      const a = f.auditor.service.activities;
      const preflight = await a.preflightAuditor(f.input.admission.preparation);
      const progress = await taskPlanningProgress(
        f.registration,
        f.rpc,
        f.profile,
        f.input,
        planning,
        [],
      );
      record.timing.elapsedMs = record.timing.knownElapsedMs = 2000;
      if (defect === 'plan') writeFileSync(join(f.workspace, 'plan.json'), '{}');
      const request = f.read(planning.request) as Record<string, unknown>;
      if (defect === 'proposal') request.evidence = [f.proof];
      if (defect === 'request') request.phase = 'acceptance';
      if (defect === 'goal')
        request.expectedFiles = (request.expectedFiles as { path: string }[]).filter(
          (s) => s.path !== f.proposal.requirement.locator,
        );
      if (['proposal', 'request', 'goal'].includes(defect)) planning.request = f.save(request);
      if (defect === 'time') record.timing.stage = 'implementation';
      if (defect === 'source') writeFileSync(join(f.workspace, 'owner.cjs'), 'late');
      await expect(
        a.prepareTaskPlanningAudit(f.input, planning, preflight, record.timing, progress),
      ).rejects.toThrow();
      expect(f.auditor.state.starts).toBe(0);
    },
  );
  it.each(['planning', 'card', 'context'])(
    'rejects an audit detached from the original task: %s',
    async (defect) => {
      const f = taskAuditFixture();
      const { planning, record } = await f.audit();
      if (defect === 'planning') record.planning.reviewId = 'foreign';
      else {
        const card = f.read(record.audit!.input.card);
        if (defect === 'card') card.criteria = ['foreign'];
        else card.completed = [planning.request];
        record.audit!.input.card = f.save(card);
      }
      await expect(
        confirmPlanningSupervision(
          f.registration,
          f.auditor.rpc,
          f.input,
          planning,
          f.save(record),
        ),
      ).rejects.toThrow();
    },
  );
});
