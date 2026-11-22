import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { initialArbitrationFixture } from './initialArbitrationFixture.js';
import { runReview, throughIntegration, acceptance } from './localTaskRun.js';
import { initialArbitrationActivities } from '../../src/activities/initialArbitration.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import {
  parseReviewReport,
  parseReviewRequest,
  parseReviewSnapshot,
  requireScoped,
  reviewChanges,
} from '../../src/policy/review.js';
import { readerAnswerPrompt, readerReportSchema } from '../../src/adapters/codex/readerMessages.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
import type { ReviewReport } from '../../src/contracts/review.js';

type F = ReturnType<typeof initialArbitrationFixture>;
async function initial(f: F) {
  const input = f.initialInput,
    a = f.service.activities;
  const planning = await a.prepareSubstantialPlanning(input),
    reviewed = await runReview(f, planning);
  expect(reviewed.complete).toBe(false);
  return { input, a, planning, reviewed };
}
async function arbitration(f: F) {
  const state = await initial(f),
    prepared = await state.a.prepareInitialArbitration(
      state.input,
      state.planning,
      state.reviewed.manifest,
    ),
    adjudicated = await runReview(f, prepared.review, f.arbiterProfile);
  return { ...state, prepared, adjudicated };
}
describe('primary planning conflict before a writer', { timeout: 45000 }, () => {
  it.each(['ordinary', 'partial-peer'])(
    'does not dispatch arbitration for %s planning',
    async (mode) => {
      const f = initialArbitrationFixture();
      if (mode === 'ordinary') {
        f.state.initialConflict = false;
        f.state.initialOrdinaryFail = true;
      } else f.state.initialTesterPartial = true;
      const s = await initial(f),
        before = f.state.starts;
      await expect(
        s.a.prepareInitialArbitration(s.input, s.planning, s.reviewed.manifest),
      ).rejects.toThrow(
        mode === 'ordinary'
          ? 'initial-single-confirmed-conflict-required'
          : 'initial-planning-incomplete',
      );
      expect(f.state.starts).toBe(before);
      await f.service.stopAll();
    },
  );
  it('preserves the primary conflict, independently arbitrates, rechecks with original roles and completes the full task', async () => {
    const f = initialArbitrationFixture(),
      owner = readFileSync(join(f.workspace, 'owner.cjs')),
      s = await arbitration(f);
    expect(readFileSync(join(f.workspace, 'owner.cjs'))).toEqual(owner);
    const result = await s.a.finishInitialArbitration(
      s.input,
      s.prepared.manifest,
      s.adjudicated.manifest,
    );
    expect(result.planning).not.toBeNull();
    expect(
      await s.a.finishInitialArbitration(s.input, s.prepared.manifest, s.adjudicated.manifest),
    ).toEqual(result);
    const next = await runReview(f, result.planning!);
    expect(next.complete).toBe(true);
    const original = f.read(s.reviewed.manifest).reports as {
        roleId: string;
        answer: ArtifactRef;
      }[],
      rechecked = f.read(next.manifest).reports as { roleId: string; answer: ArtifactRef }[];
    for (const row of original)
      expect(f.read(rechecked.find((r) => r.roleId === row.roleId)!.answer).session).toBe(
        f.read(row.answer).session,
      );
    const request = f.read(s.prepared.manifest);
    expect(request.kind).toBe('initial-arbitration-request');
    expect(request.target).toEqual({ roleId: 'reviewer', findingId: 'INITIAL-CONFLICT' });
    const run = await throughIntegration(f, s.input, next.manifest),
      accepted = await acceptance(f, run);
    expect(
      (await s.a.finishLocalTask(s.input, run.snapshot, run.packet, accepted.manifest)).status,
    ).toBe('done');
    expect(readFileSync(join(f.workspace, 'tasks/one.md'), 'utf8')).toContain('Результат: DONE');
    await f.service.stopAll();
  });
  it.each(['compromise', 'no-decision', 'partial'] as const)(
    'keeps %s open without a writer or a planning restart',
    async (mode) => {
      const f = initialArbitrationFixture();
      if (mode === 'compromise')
        f.state.arbitrationDecision = {
          kind: 'compromise',
          mandatoryDefect: false,
          direction: 'Prefer accepted trimming',
          exception: 'Defer the alternative proposal',
          residualRisk: 'Alternative remains unimplemented',
          dissent: ['proposal author'],
          condition: null,
        };
      if (mode === 'no-decision')
        f.state.arbitrationDecision = {
          kind: 'no-decision',
          mandatoryDefect: null,
          direction: null,
          exception: null,
          residualRisk: null,
          dissent: [],
          condition: 'Need explicit source precedence',
        };
      if (mode === 'partial') f.state.arbitrationCoverage = 'partial';
      const s = await arbitration(f);
      const result = await s.a.finishInitialArbitration(
        s.input,
        s.prepared.manifest,
        s.adjudicated.manifest,
      );
      expect(result.planning).toBeNull();
      expect(f.read(result.manifest).ready).toBe(false);
      expect(readFileSync(join(f.workspace, 'owner.cjs'), 'utf8')).not.toContain('name.trim()');
      await f.service.stopAll();
    },
  );
  it('rejects source changes and foreign review bindings before dependent dispatch', async () => {
    const f = initialArbitrationFixture(),
      s = await initial(f),
      before = f.state.starts;
    await expect(
      s.a.prepareInitialArbitration(
        s.input,
        { ...s.planning, reviewId: 'foreign' },
        s.reviewed.manifest,
      ),
    ).rejects.toThrow('initial-planning-binding');
    const bytes = readFileSync(join(f.workspace, 'proposal.md'));
    writeFileSync(join(f.workspace, 'proposal.md'), 'changed');
    await expect(
      s.a.prepareInitialArbitration(s.input, s.planning, s.reviewed.manifest),
    ).rejects.toThrow('initial-input-changed');
    writeFileSync(join(f.workspace, 'proposal.md'), bytes);
    const prepared = await s.a.prepareInitialArbitration(s.input, s.planning, s.reviewed.manifest);
    expect(await s.a.prepareInitialArbitration(s.input, s.planning, s.reviewed.manifest)).toEqual(
      prepared,
    );
    expect(f.state.starts).toBe(before);
    await expect(s.a.finishInitialArbitration(s.input, f.proof, f.proof)).rejects.toThrow(
      'initial-arbitration-binding',
    );
    await expect(
      s.a.prepareInitialArbitration(f.input, s.planning, s.reviewed.manifest),
    ).rejects.toThrow('initial-input-required');
    await expect(s.a.finishInitialArbitration(f.input, f.proof, f.proof)).rejects.toThrow(
      'initial-input-required',
    );
    await f.service.stopAll();
  });
  it('requires a confirmed conflict rather than an ordinary FAIL and validates exact source tuples', async () => {
    const f = initialArbitrationFixture(),
      s = await initial(f),
      result = f.read(s.reviewed.manifest),
      row = (
        result.reports as { roleId: string; answer: ArtifactRef; report: ReviewReport }[]
      ).find((r) => r.roleId === 'reviewer')!,
      answer = f.read(row.answer),
      actor = requireScoped(answer.input),
      snapshot = parseReviewSnapshot(f.read(actor.review), actor);
    if (snapshot.schemaVersion !== 6) throw new Error('primary planning snapshot required');
    const report = row.report;
    expect(report.schemaVersion).toBe(4);
    if (report.schemaVersion !== 4) throw new Error('conflict report required');
    const conflict = report.conflicts[0]!;
    for (const sources of [
      [],
      [conflict.sources[0]!],
      [conflict.sources[0]!, conflict.sources[0]!],
      conflict.sources.map((r) => ({ ...r, sha256: '0'.repeat(64) })),
      conflict.sources.map((r) => ({ ...r, bytes: r.bytes + 1 })),
      conflict.sources.map((r) => ({ ...r, path: 'foreign.md' })),
    ])
      expect(() =>
        parseReviewReport({ ...report, conflicts: [{ ...conflict, sources }] }, actor, snapshot),
      ).toThrow('review-conflict-unconfirmed');
    expect(() => parseReviewReport({ ...report, coverage: 'partial' }, actor, snapshot)).toThrow(
      'review-conflict-unconfirmed',
    );
    expect(() => parseReviewReport({ ...report, findings: [] }, actor, snapshot)).toThrow(
      'review-conflict-unconfirmed',
    );
    expect(() =>
      parseReviewReport({ ...report, conflicts: [conflict, conflict] }, actor, snapshot),
    ).toThrow('review-conflict-duplicate');
    expect(parseReviewReport({ ...report, conflicts: [] }, actor, snapshot)).toMatchObject({
      conflicts: [],
    });
    expect(() =>
      parseReviewReport(
        {
          ...report,
          conflicts: [
            {
              ...conflict,
              sources: conflict.sources.map((source) => ({
                ...source,
                path: join(f.workspace, source.path),
              })),
            },
          ],
        },
        actor,
        snapshot,
      ),
    ).toThrow('invalid-relative-path');
    expect(readerAnswerPrompt(actor, snapshot)).toContain(JSON.stringify(snapshot.files));
    expect(readerReportSchema(actor, snapshot)).toMatchObject({
      properties: {
        conflicts: {
          items: {
            properties: {
              sources: {
                items: { properties: { path: { enum: snapshot.files.map((file) => file.path) } } },
              },
            },
          },
        },
      },
    });
    const helper = initialArbitrationActivities(f.registration, f.rpc, f.profile),
      trigger = f.read(
        (await s.a.prepareInitialArbitration(s.input, s.planning, s.reviewed.manifest)).manifest,
      );
    await expect(helper.prepare(s.input, f.proof, s.planning, s.reviewed.manifest)).rejects.toThrow(
      'initial-preflight-binding',
    );
    const preflight = trigger.preflight as ArtifactRef;
    await expect(
      helper.prepare(
        s.input,
        preflight,
        s.planning,
        f.save({ ...result, input: { ...s.planning, reviewId: 'foreign' } }),
      ),
    ).rejects.toThrow('initial-review-binding');
    const request = f.read(s.planning.request);
    expect(() => parseReviewRequest({ ...request, phase: 'acceptance' }, s.planning)).toThrow(
      'review-conflict-phase',
    );
    expect(() => parseReviewSnapshot({ ...snapshot, phase: 'acceptance' }, actor)).toThrow(
      'review-conflict-phase',
    );
    expect(readerAnswerPrompt(actor, snapshot)).toContain('Обычный FAIL не означает противоречие');
    expect(readerReportSchema(actor, snapshot).required).toContain('conflicts');
    expect(reviewChanges(snapshot, { ...snapshot, schemaVersion: 3 })).toContain(
      'report-format-changed',
    );
    expect(parseLocalTask(s.input)).toEqual(s.input);
    expect(() =>
      parseLocalTask({
        ...s.input,
        arbitration: { ...s.input.arbitration, compromiseFindings: [] },
      }),
    ).toThrow();
    expect(() =>
      parseLocalTask({ ...s.input, arbitration: { ...s.input.arbitration, roleId: 'foreign' } }),
    ).toThrow('task-arbitration-role-invalid');
    await f.service.stopAll();
  });
});
