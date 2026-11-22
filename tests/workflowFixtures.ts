import {
  createCouncil,
  configuredRoles,
  councilRoles,
  assignAdviser,
  answerCouncil,
  councilProfileLocators,
  councilReviewRequest,
} from '../core/council.js';
import type { Council, ReviewAnswer, ReviewTarget, Selection } from '../core/council.js';
import type { DesignAssessment, DesignReview } from '../core/designReview.js';
import type { InputRef } from '../core/localRun.js';
import { applyLocalEvent, startLocalRun } from '../core/localRun.js';
import { event, loadedRun, localFixture } from './localFixtures.js';
import type { Execution, ExecutionAction, ExecutionEvent } from '../core/execution.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import type { DataQuery } from '../core/dataRoute.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function designReviewFixture(phase: Council['phase'], ref: InputRef): DesignReview {
  const assessment = (kind: DesignAssessment['evidence'][number]['kind']): DesignAssessment => ({
    verdict: 'PASS',
    coverage: 'complete',
    reason: 'Fixture assessment of explicit criteria',
    evidence: [
      {
        kind,
        artifacts: [structuredClone(ref)],
        observation: 'Fixture observation; not live UI proof',
      },
    ],
  });
  return {
    ui: assessment(phase === 'planning' ? 'proposal' : 'screens'),
    ux: assessment(phase === 'planning' ? 'proposal' : 'interaction'),
  };
}

export async function workflowFixture() {
  const f = await localFixture();
  await f.file('proof.txt', 'real observation');
  await f.file('diff.txt', 'exact delta');
  const inputs = new FileWorkflowInputs(f.root);
  const manifest = await inputs.capture({ files: ['source.txt'], directories: [] }, 'owner');
  const proof = await f.ref('proof.txt');
  for (const locator of new Set(councilRoles.flatMap(councilProfileLocators)))
    await f.file(
      locator,
      await readFile(
        resolve(import.meta.dirname, '..', locator.replace(/^tools\/agent-workflow\//u, '')),
        'utf8',
      ),
    );
  const profiles = Object.fromEntries(
    await Promise.all(
      councilRoles.map(async (role) => {
        const refs = [];
        for (const locator of councilProfileLocators(role)) {
          refs.push(await f.ref(locator));
        }
        return [role, refs];
      }),
    ),
  ) as Record<(typeof councilRoles)[number], (typeof proof)[]>;
  const target: ReviewTarget = {
    scope: 'workflow',
    base: 'base',
    diff: await f.ref('diff.txt'),
    inputs: manifest,
  };
  const selection = Object.fromEntries(
    councilRoles.map((role) => [
      role,
      {
        trigger: role === 'architect',
        reason: role === 'architect' ? 'contract change' : 'outside scope',
        requirements: [proof, ...profiles[role]],
        inputs: manifest,
      },
    ]),
  ) as Selection;
  const spec = {
    ...f.spec,
    rules: [...f.spec.rules, ...profiles.architect],
    sources: [...f.spec.sources, ...profiles.architect],
    product: false,
    identity: { assignment_id: 'review' },
    parent_run_id: 'parent',
    role: 'council-adviser' as const,
    route: { kind: 'nonproduct' as const },
    requested: { model: 'fixture', effort: 'high', permissions: ['read' as const] },
    effective: { model: 'fixture', effort: 'high', permissions: ['read' as const] },
  };
  let adviser = loadedRun(startLocalRun(spec, 1));
  adviser.loaded!.native = proof;
  adviser.loaded!.origin = proof;
  adviser = applyLocalEvent(adviser, event(adviser, { type: 'READY' }));
  let executor = loadedRun(
    startLocalRun(
      {
        ...f.spec,
        requested: {
          ...f.spec.requested,
          permissions: ['read', 'implement', 'update-card', 'produce-evidence'],
        },
        effective: {
          ...f.spec.requested,
          permissions: ['read', 'implement', 'update-card', 'produce-evidence'],
        },
      },
      1,
    ),
  );
  executor = applyLocalEvent(executor, event(executor, { type: 'READY' }));
  const answer = (council: Council): ReviewAnswer => ({
    verdict: 'PASS',
    scope: target.scope,
    target: council.target,
    coverage: 'complete',
    sources: [proof],
    limitations: ['test double'],
    findings: [],
    evidence: proof,
    binding: {
      schema_version: 1,
      request: councilReviewRequest(
        council,
        configuredRoles(council.configuration).find(
          (role) => council.advisers[role] !== undefined,
        ) ?? 'architect',
        Object.values(council.advisers)[0]?.run ?? adviser,
      ),
      load_turn: 'load',
      answer_turn: `answer-${council.review_turns?.length ?? council.history.length}`,
      answer_evidence: proof,
      evidence: proof,
    },
  });
  const council = (phase: Council['phase']) => {
    const assigned = assignAdviser(createCouncil(phase, selection, target), 'architect', adviser);
    return answerCouncil(assigned, 'architect', 'session', answer(assigned));
  };
  const query: DataQuery = {
    kind: 'unknown-source',
    question: 'Find input owner',
    scope: ['source.txt'],
    sources: [await f.ref('source.txt')],
    criterion: 'owner found',
    format: 'JSON DataAnswer',
    rules: adviser.spec.rules,
    procedures: adviser.spec.procedures,
    entrypoints: ['source.txt'],
  };
  return {
    ...f,
    inputs,
    profiles,
    proof,
    target,
    selection,
    adviser,
    executor,
    answer,
    council,
    query,
  };
}
export const executionEvent = (run: Execution, action: ExecutionAction): ExecutionEvent => ({
  ...action,
  id: `event-${run.revision}`,
  expected_revision: run.revision,
  generation: run.generation,
});
