import { describe, expect, it } from 'vitest';
import { auditFixture } from './auditFixture.js';
import {
  parseAuditTiming,
  parseAuditTrigger,
  parseAuditInput,
  parseAuditCard,
  parseAuditReport,
  auditClaim,
  auditWorkflowKey,
} from '../../src/policy/audit.js';
describe('durable audit rules', () => {
  it('claims the original 2× threshold once across new checkpoints and keeps unknown time unknown', () => {
    const f = auditFixture(),
      t = f.card.timing!;
    expect(() =>
      auditClaim({ ...t, elapsedMs: 1999, knownElapsedMs: 1999 }, 'first', f.card.trigger, []),
    ).toThrow('audit-threshold-not-reached');
    const claimed = auditClaim(t, 'first', f.card.trigger, []);
    expect(() =>
      auditClaim({ ...t, elapsedMs: 5000, knownElapsedMs: 5000 }, 'second', f.card.trigger, [
        claimed,
      ]),
    ).toThrow('audit-already-handled');
    const unknown = { ...t, elapsedMs: null, externalWaitMs: null };
    expect(parseAuditTiming(unknown)).toEqual(unknown);
    expect(auditClaim(unknown, 'first', f.card.trigger, [])).toBe(claimed);
    expect(() =>
      auditClaim({ ...unknown, knownElapsedMs: 100 }, 'first', f.card.trigger, []),
    ).toThrow('audit-threshold-not-reached');
    const trigger = { kind: 'no-progress' as const, evidence: f.proof };
    expect(parseAuditCard({ ...f.card, timing: null, trigger }).timing).toBeNull();
    expect(auditClaim(null, 'without-stage', trigger, [])).toContain('task-progress:without-stage');
    expect(() => auditClaim(null, 'without-stage', f.card.trigger, [])).toThrow(
      'audit-threshold-not-reached',
    );
    const noProgress = auditClaim(unknown, 'first', trigger, []);
    expect(auditClaim(unknown, 'second', trigger, [noProgress])).not.toBe(noProgress);
    expect(
      auditClaim(unknown, 'first', { kind: 'doubt', evidence: f.proof }, [noProgress]),
    ).not.toBe(noProgress);
  });
  it.each([
    { estimateMs: 0 },
    { estimateMs: 3600001 },
    { elapsedMs: -1 },
    { knownElapsedMs: 3 },
    { elapsedMs: '2000' },
    { externalWaitMs: 0.1 },
    { stage: '../stage' },
    { extra: true },
  ])('rejects invalid or invented timing %j', (fields) => {
    const f = auditFixture();
    expect(() => parseAuditTiming({ ...f.card.timing, ...fields })).toThrow();
  });
  it('binds the immutable input, primary sources and a report without acceptance powers', async () => {
    const f = auditFixture(),
      s = await f.setup();
    expect(parseAuditCard(f.card)).toEqual(f.card);
    expect(parseAuditInput(s.input)).toEqual(s.input);
    expect(auditWorkflowKey(s.input)).toBe('aw/audit/neutral/one/planning');
    for (const direction of [
      'continue',
      'replace-approach',
      'replace-executor',
      'reconsider-constraints',
      null,
    ]) {
      const report = {
        schemaVersion: 1,
        card: s.input.card,
        coverage: direction === null ? 'partial' : 'complete',
        direction,
        reasons: ['Факт из источника'],
        sources: ['tasks/one.md'],
        checkpoint: f.card.checkpoint,
        nextResult: 'Проверяемый результат',
        limitations: direction === null ? ['Время известно частично'] : [],
      };
      expect(
        parseAuditReport(report, {
          ref: s.input.card,
          checkpoint: f.card.checkpoint,
          sources: ['tasks/one.md'],
        }),
      ).toEqual(report);
    }
  });
  it.each([
    'schema',
    'goal',
    'duplicate-source',
    'criteria',
    'completed',
    'trigger',
    'checkpoint',
    'next',
    'no-progress',
  ])('rejects an incomplete or mismatched card: %s', (defect) => {
    const f = auditFixture(),
      card = structuredClone(f.card) as unknown as Record<string, unknown>;
    if (defect === 'schema') card.schemaVersion = 2;
    if (defect === 'goal') card.goal = { ...f.card.goal, sha256: 'a'.repeat(64) };
    if (defect === 'duplicate-source') card.sources = [f.card.goal, f.card.goal];
    if (defect === 'criteria') card.criteria = ['same', 'same'];
    if (defect === 'completed') card.completed = null;
    if (defect === 'trigger') card.trigger = { kind: 'other' };
    if (defect === 'checkpoint') card.checkpoint = '';
    if (defect === 'next') card.nextAction = '';
    if (defect === 'no-progress') card.trigger = { kind: 'no-progress' };
    expect(() => parseAuditCard(card)).toThrow();
  });
  it('rejects foreign inputs and unknown triggers', async () => {
    const f = auditFixture(),
      s = await f.setup();
    expect(() => parseAuditInput({ ...s.input, schemaVersion: 2 })).toThrow('audit-input-version');
    expect(() => parseAuditTrigger({ kind: 'other', evidence: f.proof })).toThrow(
      'audit-trigger-invalid',
    );
  });
  it.each([
    'schema',
    'card',
    'checkpoint',
    'coverage',
    'direction',
    'missing-direction',
    'source',
    'reasons',
    'sources',
    'limitations',
    'acceptance',
  ])('rejects an unbound report or attempted extra authority: %s', async (defect) => {
    const f = auditFixture(),
      s = await f.setup();
    const report: Record<string, unknown> = {
      schemaVersion: 1,
      card: s.input.card,
      coverage: 'complete',
      direction: 'continue',
      reasons: ['Основание'],
      sources: ['source'],
      checkpoint: f.card.checkpoint,
      nextResult: 'Результат',
      limitations: [],
    };
    if (defect === 'schema') report.schemaVersion = 2;
    if (defect === 'card') report.card = f.proof;
    if (defect === 'checkpoint') report.checkpoint = 'other';
    if (defect === 'coverage') report.coverage = ['complete'];
    if (defect === 'direction') report.direction = ['continue'];
    if (defect === 'missing-direction') report.direction = null;
    if (defect === 'source') report.sources = ['unknown'];
    if (defect === 'reasons') report.reasons = [];
    if (defect === 'sources') report.sources = null;
    if (defect === 'limitations') report.limitations = [''];
    if (defect === 'acceptance') report.acceptance = true;
    expect(() =>
      parseAuditReport(report, {
        ref: s.input.card,
        checkpoint: f.card.checkpoint,
        sources: ['source'],
      }),
    ).toThrow();
  });
});
