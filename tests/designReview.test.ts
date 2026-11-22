import {
  answerCouncil,
  assignAdviser,
  councilBlockers,
  createCouncil,
  repeatCouncil,
  revisePlanning,
} from '../core/council.js';
import type { Council, ReviewAnswer } from '../core/council.js';
import { confirmDesignReview } from '../core/designReview.js';
import { decideArbitration, finishArbitration, startArbitration } from '../core/arbitration.js';
import { applyExecution, createExecution, executionBlockers } from '../core/execution.js';
import type { ExecutionAction } from '../core/execution.js';
import { recordFinding, recordRoundVerdict } from '../core/findings.js';
import { emptySupervision } from '../core/supervision.js';
import { refreshCouncilInputs } from '../cli/refreshCouncilInputs.js';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { designReviewFixture, executionEvent, workflowFixture } from './workflowFixtures.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
const role = 'ui-ux-designer';
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});
function assigned(phase: Council['phase']) {
  const rules = [...f.spec.rules, ...f.profiles[role]];
  const run = {
    ...f.adviser,
    spec: { ...f.adviser.spec, rules, sources: [...f.spec.sources, ...f.profiles[role]] },
    loaded: { ...f.adviser.loaded!, rules },
  };
  const selection = structuredClone(f.selection);
  selection.architect.trigger = false;
  selection[role].trigger = true;
  return assignAdviser(createCouncil(phase, selection, f.target), role, run);
}
function answer(council: Council): ReviewAnswer {
  return {
    ...f.answer(council),
    design: designReviewFixture(council.phase, council.target.inputs.inputs[0]!),
  };
}

it.each(['planning', 'acceptance'] as const)(
  'reopens the designer when %s evidence changes outside its source manifest',
  async (phase) => {
    await f.file('design.txt', 'reviewed material');
    f.target.evidence_inputs = await f.inputs.capture(
      { files: ['source.txt', 'design.txt'], directories: [] },
      'package',
    );
    const pending = assigned(phase);
    const accepted = answerCouncil(pending, role, 'session', {
      ...answer(pending),
      design: designReviewFixture(phase, await f.ref('design.txt')),
    });
    const unchanged = await refreshCouncilInputs(accepted, f.target, f.inputs);
    expect(unchanged.advisers).toEqual(accepted.advisers);
    await f.file('unrelated.txt', 'new unrelated evidence');
    const expanded = {
      ...f.target,
      evidence_inputs: await f.inputs.capture(
        { files: ['source.txt', 'design.txt', 'unrelated.txt'], directories: [] },
        'expanded package',
      ),
    };
    expect((await refreshCouncilInputs(accepted, expanded, f.inputs)).advisers).toEqual(
      accepted.advisers,
    );
    for (const files of [['source.txt', 'design.txt'], ['source.txt']]) {
      await f.file('design.txt', 'unreviewed replacement');
      if (files.length === 1) await rm(resolve(f.root, 'design.txt'));
      const target = {
        ...f.target,
        evidence_inputs: await f.inputs.capture({ files, directories: [] }, 'new package'),
      };
      expect(councilBlockers({ ...accepted, target })).toEqual([
        `${role}:review-no-longer-applicable`,
      ]);
      if (phase === 'acceptance') {
        const proposal = { ...assigned('planning'), target };
        const planning = answerCouncil(proposal, role, 'session', {
          ...answer(proposal),
          design: designReviewFixture('planning', f.target.inputs.inputs[0]!),
        });
        let run = createExecution(
          'task',
          1,
          target,
          [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
          true,
          'substantial',
        );
        const actions: ExecutionAction[] = [
          { type: 'PLAN', council: planning },
          {
            type: 'REVIEW',
            target,
            selection: accepted.selection,
            baseline: {
              kind: 'real',
              scenario: 'fixture',
              evidence: f.proof,
              inputs: target.inputs,
              elapsed_ms: 1,
              exit_code: 0,
            },
            checks: [
              {
                id: 'validate',
                verdict: 'PASS',
                reason: 'fixture',
                evidence: f.proof,
                inputs: target.inputs,
              },
            ],
          },
          { type: 'ACCEPT', council: { ...accepted, target }, findings: [] },
        ];
        for (const action of actions) run = applyExecution(run, executionEvent(run, action));
        expect(() =>
          applyExecution(
            run,
            executionEvent(run, {
              type: 'RESULT',
              result: {
                scope: target.scope,
                target,
                evidence: [f.proof, target.diff],
                child_results: [],
                limitations: ['fixture'],
                summary: 'must not pass',
              },
            }),
          ),
        ).toThrow('result-gates-open');
      }
      const selection = {
        ...accepted.selection,
        backend: { ...accepted.selection.backend, trigger: true },
      };
      expect(() =>
        repeatCouncil({ ...accepted, selection }, target, ['backend'], selection),
      ).toThrow('unreviewed-input-change');
      const refreshed = await refreshCouncilInputs(accepted, target, f.inputs);
      expect(refreshed.advisers[role]?.status).toBe('running');
      expect(refreshed.advisers[role]?.answer).toBeNull();
      expect(refreshed.history).toEqual(accepted.history);
      expect(refreshed.review_turns).toEqual(accepted.review_turns);
      if (phase === 'planning')
        expect(revisePlanning(accepted, accepted.selection, target).advisers[role]?.status).toBe(
          'running',
        );
    }
  },
);

it('accepts screens and interaction from the separately hashed package while requiring every source ref', async () => {
  f.target.evidence_inputs = await f.inputs.capture(
    { files: ['source.txt', 'proof.txt'], directories: [] },
    'package',
  );
  const council = assigned('acceptance');
  const result = { ...answer(council), design: designReviewFixture('acceptance', f.proof) };
  expect(councilBlockers(answerCouncil(council, role, 'session', result))).toEqual([]);
  const omitted = {
    ...result,
    target: { ...f.target, evidence_inputs: { ...f.target.evidence_inputs, inputs: [f.proof] } },
  };
  expect(() => confirmDesignReview('acceptance', omitted)).toThrow(
    'target-evidence-missing-source-inputs',
  );
});

it.each(['planning', 'acceptance'] as const)(
  'accepts separate UI/UX results in %s and rechecks the persisted proof at admission',
  (phase) => {
    const council = assigned(phase);
    const result = answer(council);
    const accepted = answerCouncil(council, role, 'session', result);
    expect(councilBlockers(accepted)).toEqual([]);
    expect(accepted.history[0]!.answer.design).toEqual(result.design);
    delete accepted.advisers[role]!.answer!.design;
    expect(() => councilBlockers(accepted)).toThrow('design-review-required');
  },
);

it.each(['ui', 'ux'] as const)(
  'permits justified %s N/A and requires the other assessment',
  (area) => {
    const council = assigned('acceptance');
    const result = answer(council);
    result.design![area] = {
      verdict: 'N/A',
      coverage: 'complete',
      reason: 'This dimension is unchanged; see scoped requirements',
      evidence: [],
    };
    expect(councilBlockers(answerCouncil(council, role, 'session', result))).toEqual([]);
    result.design![area].reason = '';
    expect(() => answerCouncil(council, role, 'session', result)).toThrow('missing-text');
    result.design![area].reason = 'Outside scope';
    result.design![area].coverage = 'partial';
    expect(() => answerCouncil(council, role, 'session', result)).toThrow('design-na-incomplete');
  },
);

it('requires re-selection when both dimensions are N/A', () => {
  const council = assigned('acceptance');
  const result = answer(council);
  result.design!.ui.verdict = 'N/A';
  result.design!.ux.verdict = 'N/A';
  expect(() => answerCouncil(council, role, 'session', result)).toThrow(
    'design-role-not-applicable',
  );
});

it.each(['planning', 'acceptance'] as const)(
  'rejects JSON array verdicts without evidence at answer and admission in %s',
  (phase) => {
    const council = assigned(phase);
    const result = answer(council);
    const accepted = answerCouncil(council, role, 'session', result);
    const malformed = JSON.parse(
      JSON.stringify({
        ...result,
        design: {
          ui: { verdict: ['NOT RUN'], coverage: 'complete', reason: 'Not inspected', evidence: [] },
          ux: { verdict: ['FAIL'], coverage: 'complete', reason: 'Failed', evidence: [] },
        },
      }),
    ) as ReviewAnswer;
    expect(() => answerCouncil(council, role, 'session', malformed)).toThrow(
      'invalid-design-assessment',
    );
    accepted.advisers[role]!.answer = malformed;
    expect(() => councilBlockers(accepted)).toThrow('invalid-design-assessment');
  },
);

it('completes an arbitrated designer FAIL without rewriting or bypassing the original review', () => {
  const council = assigned('acceptance');
  const result = answer(council);
  result.verdict = 'FAIL';
  result.design!.ui.verdict = 'FAIL';
  result.findings = [
    {
      id: 'UI-1',
      scope: 'workflow',
      condition: 'Agreed visual tradeoff',
      reason: 'Disputed layout',
      blocking: true,
      waivable: true,
      sources: [f.proof],
    },
  ];
  const failed = answerCouncil(council, role, 'session', result);
  let finding = recordFinding([], result.findings[0]!, role, f.proof)[0]!;
  for (const correction of ['one', 'two', 'three'])
    finding = recordRoundVerdict(finding, correction, role, 'FAIL', f.proof);
  const compromise = decideArbitration(
    startArbitration('UI-A', finding, { kind: 'three-fail' }, 'arbiter'),
    'arbiter',
    {
      outcome: 'compromise',
      reason: 'Bounded tradeoff',
      exception: 'UI-1 only',
      residual_risk: 'Disputed layout remains',
      dissent: ['Designer retains FAIL'],
      evidence: f.proof,
    },
  );
  const arbitration = finishArbitration(compromise, finding, {
    target: f.target,
    implementation: f.proof,
    review: { reviewer: role, verdict: 'FAIL', evidence: f.proof },
    condition: finding.condition,
    working_check: f.proof,
    check_verdict: 'PASS',
    mandatory_defect: false,
  });
  const planning = assigned('planning');
  let run = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'Code change' }],
    true,
    'substantial',
  );
  run = applyExecution(
    run,
    executionEvent(run, {
      type: 'PLAN',
      council: answerCouncil(planning, role, 'session', answer(planning)),
    }),
  );
  run = applyExecution(
    run,
    executionEvent(run, {
      type: 'REVIEW',
      target: f.target,
      selection: planning.selection,
      checks: [
        {
          id: 'validate',
          verdict: 'PASS',
          reason: 'Fixture check',
          evidence: f.proof,
          inputs: f.target.inputs,
        },
      ],
      baseline: {
        kind: 'real',
        scenario: 'Fixture working check',
        evidence: f.proof,
        inputs: f.target.inputs,
        elapsed_ms: 1,
        exit_code: 0,
      },
    }),
  );
  run = applyExecution(
    run,
    executionEvent(run, { type: 'ACCEPT', council: failed, findings: [finding] }),
  );
  expect(executionBlockers(run)).toEqual(['open-blocker', `${role}:not-accepted`]);
  run.supervision = { ...emptySupervision(), arbitrations: [arbitration] };
  const snapshot = structuredClone(run);
  expect(executionBlockers(run)).toEqual([]);
  expect(run).toEqual(snapshot);
  expect(councilBlockers(run.acceptance!)).toEqual([`${role}:not-accepted`]);
  expect(councilBlockers({ ...failed, phase: 'planning' }, [role])).toEqual([
    `${role}:not-accepted`,
  ]);

  const corrupt = structuredClone(run);
  corrupt.acceptance!.advisers[role]!.answer!.design!.ui.verdict = 'PASS';
  expect(() => executionBlockers(corrupt)).toThrow('design-summary-mismatch');
  const missingProof = structuredClone(run);
  missingProof.acceptance!.advisers[role]!.answer!.design!.ux.evidence = [];
  expect(() => executionBlockers(missingProof)).toThrow('design-proof-incomplete');
  const stale = structuredClone(run);
  stale.supervision!.arbitrations[0]!.accepted_target!.diff.hash = 'changed';
  expect(executionBlockers(stale)).toEqual(['open-blocker', `${role}:not-accepted`]);
  const partial = structuredClone(run);
  partial.acceptance!.advisers[role]!.answer!.coverage = 'partial';
  partial.acceptance!.advisers[role]!.answer!.design!.ui.coverage = 'partial';
  expect(executionBlockers(partial)).toEqual([`${role}:not-accepted`]);
  const unreviewed = structuredClone(run);
  unreviewed.acceptance!.advisers[role]!.answer!.design!.ux.verdict = 'NOT RUN';
  unreviewed.acceptance!.advisers[role]!.answer!.design!.ux.evidence = [];
  expect(executionBlockers(unreviewed)).toEqual([`${role}:not-accepted`]);

  run = applyExecution(
    run,
    executionEvent(run, {
      type: 'RESULT',
      result: {
        scope: f.target.scope,
        target: f.target,
        evidence: [f.proof],
        child_results: [],
        limitations: ['Accepted UI-1 exception'],
        summary: 'Accepted with dissent',
      },
    }),
  );
  run = applyExecution(run, executionEvent(run, { type: 'DONE' }));
  expect(run.status).toBe('done');
  expect(run.acceptance).toEqual(failed);
  expect(run.findings).toEqual([finding]);
  expect(run.supervision!.arbitrations).toEqual([arbitration]);
});

it.each(['ui', 'ux'] as const)(
  'rejects missing or wrong-phase %s proof and incomplete PASS',
  (area) => {
    for (const phase of ['planning', 'acceptance'] as const) {
      const council = assigned(phase);
      for (const patch of [
        { evidence: [] },
        { coverage: 'partial' as const },
        {
          evidence: [
            {
              kind: phase === 'planning' ? ('interaction' as const) : ('proposal' as const),
              artifacts: [f.target.inputs.inputs[0]!],
              observation: 'Wrong phase',
            },
          ],
        },
      ]) {
        const result = answer(council);
        Object.assign(result.design![area], patch);
        expect(() => answerCouncil(council, role, 'session', result)).toThrow(
          'design-proof-incomplete',
        );
      }
    }
  },
);

it.each([
  ['FAIL', 'complete', 'FAIL', 'complete'],
  ['FAIL', 'partial', 'FAIL', 'partial'],
  ['NOT RUN', 'complete', 'NOT RUN', 'complete'],
  ['NOT RUN', 'partial', 'NOT RUN', 'partial'],
] as const)(
  'preserves UI PASS and UX %s/%s without granting admission',
  (verdict, coverage, overall, total) => {
    const council = assigned('acceptance');
    const result = answer(council);
    Object.assign(result.design!.ux, { verdict, coverage, evidence: [] });
    expect(() => answerCouncil(council, role, 'session', result)).toThrow(
      'design-summary-mismatch',
    );
    Object.assign(result, { verdict: overall, coverage: total });
    const rejected = answerCouncil(council, role, 'session', result);
    expect(councilBlockers(rejected)).toEqual([`${role}:not-accepted`]);
    expect(rejected.history[0]!.answer.design!.ui.verdict).toBe('PASS');
  },
);

it('gives FAIL precedence over NOT RUN and preserves correction history with the same adviser', () => {
  const council = assigned('acceptance');
  const result = answer(council);
  result.design!.ui.verdict = 'FAIL';
  Object.assign(result.design!.ux, { verdict: 'NOT RUN', coverage: 'partial', evidence: [] });
  Object.assign(result, { verdict: 'FAIL', coverage: 'partial' });
  result.findings = [
    {
      id: 'UI-1',
      scope: 'workflow',
      condition: 'Restore a visible exit',
      reason: 'Exit is obscured',
      blocking: true,
      sources: [f.proof],
    },
  ];
  const failed = answerCouncil(council, role, 'session', result);
  const repeat = repeatCouncil(failed, f.target, [role]);
  const fixed = answerCouncil(repeat, role, 'session', answer(repeat));
  expect(councilBlockers(fixed)).toEqual([]);
  expect(fixed.history.map((entry) => entry.answer.verdict)).toEqual(['FAIL', 'PASS']);
  expect(fixed.advisers[role]!.run).toEqual(council.advisers[role]!.run);
});

it('keeps the general blocker and overall coverage gates for designer answers', () => {
  const council = assigned('acceptance');
  const result = answer(council);
  result.coverage = 'partial';
  expect(() => answerCouncil(council, role, 'session', result)).toThrow('design-summary-mismatch');
  result.coverage = 'complete';
  result.findings = [
    {
      id: 'UX-1',
      scope: 'workflow',
      condition: 'Explain next step',
      reason: 'No next action',
      blocking: true,
      sources: [f.proof],
    },
  ];
  expect(() => answerCouncil(council, role, 'session', result)).toThrow('pass-with-blocker');
});

it.each([
  [
    'missing design',
    (a: ReviewAnswer) => {
      delete a.design;
    },
    'design-review-required',
  ],
  [
    'missing UI',
    (a: ReviewAnswer) => {
      Reflect.deleteProperty(a.design!, 'ui');
    },
    'invalid-object',
  ],
  [
    'invalid verdict',
    (a: ReviewAnswer) => {
      Object.assign(a.design!.ui, { verdict: 'OK' });
    },
    'invalid-design-assessment',
  ],
  [
    'invalid coverage',
    (a: ReviewAnswer) => {
      Object.assign(a.design!.ui, { coverage: null });
    },
    'invalid-design-assessment',
  ],
  [
    'array coverage',
    (a: ReviewAnswer) => {
      Object.assign(a.design!.ui, { verdict: 'FAIL', coverage: ['complete'], evidence: [] });
      Object.assign(a, { verdict: 'FAIL', coverage: 'partial' });
    },
    'invalid-design-assessment',
  ],
  [
    'unknown coverage',
    (a: ReviewAnswer) => {
      Object.assign(a.design!.ui, { coverage: 'full' });
    },
    'invalid-design-assessment',
  ],
  [
    'missing evidence',
    (a: ReviewAnswer) => {
      Reflect.deleteProperty(a.design!.ui, 'evidence');
    },
    'design-evidence-required',
  ],
  [
    'invalid kind',
    (a: ReviewAnswer) => {
      Object.assign(a.design!.ui.evidence[0]!, { kind: 'code' });
    },
    'invalid-design-evidence',
  ],
  [
    'array kind',
    (a: ReviewAnswer) => {
      Object.assign(a.design!.ui.evidence[0]!, { kind: ['screens'] });
      a.design!.ui.verdict = 'FAIL';
      a.verdict = 'FAIL';
    },
    'invalid-design-evidence',
  ],
  [
    'missing artifacts',
    (a: ReviewAnswer) => {
      Reflect.deleteProperty(a.design!.ui.evidence[0]!, 'artifacts');
    },
    'invalid-design-evidence',
  ],
  [
    'empty artifacts',
    (a: ReviewAnswer) => {
      a.design!.ui.evidence[0]!.artifacts = [];
    },
    'invalid-design-evidence',
  ],
  [
    'empty observation',
    (a: ReviewAnswer) => {
      a.design!.ui.evidence[0]!.observation = '';
    },
    'missing-text',
  ],
  [
    'non-string hash',
    (a: ReviewAnswer) => {
      Object.assign(a.design!.ui.evidence[0]!.artifacts[0]!, { hash: 42 });
    },
    'invalid-design-artifact-hash',
  ],
  [
    'malformed hash',
    (a: ReviewAnswer) => {
      a.design!.ui.evidence[0]!.artifacts[0]!.hash = 'old';
    },
    'invalid-design-artifact-hash',
  ],
  [
    'stale hash',
    (a: ReviewAnswer) => {
      a.design!.ui.evidence[0]!.artifacts[0]!.hash = '0'.repeat(64);
    },
    'design-artifact-outside-target',
  ],
  [
    'unknown artifact',
    (a: ReviewAnswer) => {
      a.design!.ui.evidence[0]!.artifacts[0]!.locator = 'missing.png';
    },
    'design-artifact-outside-target',
  ],
  [
    'incomplete manifest',
    (a: ReviewAnswer) => {
      a.target.inputs.complete = false;
    },
    'design-artifact-outside-target',
  ],
] as const)('rejects %s at the structured answer boundary', (_name, mutate, error) => {
  const result = structuredClone(answer(assigned('acceptance')));
  mutate(result);
  expect(() => confirmDesignReview('acceptance', result)).toThrow(error);
});

it('invalidates a retained PASS when artifact inputs change', () => {
  const council = assigned('acceptance');
  const accepted = answerCouncil(council, role, 'session', answer(council));
  accepted.selection[role].inputs.inputs[0]!.hash = 'changed';
  expect(councilBlockers(accepted)).toEqual([`${role}:review-no-longer-applicable`]);
});
