import { join } from 'node:path';
import { expect } from 'vitest';
import type { localTaskFixture } from './localTaskFixture.js';
import { reviewActivities } from '../../src/activities/review.js';
import { readerActivities } from '../../src/activities/reader.js';
import { prepareScopedReview } from '../../src/adapters/codex/reviewInputs.js';
import { requireScoped } from '../../src/policy/review.js';
import type { LocalTaskInput } from '../../src/contracts/localTask.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
type TaskRunFixture = Omit<ReturnType<typeof localTaskFixture>, 'input'> & {
  input: LocalTaskInput;
};
import type { ReviewInput } from '../../src/contracts/review.js';

export async function throughIntegration(
  f: TaskRunFixture,
  input: LocalTaskInput = f.input,
  planning?: ArtifactRef,
  preparedSnapshot?: ArtifactRef,
  progress?: ArtifactRef,
) {
  const a = f.service.activities,
    snapshot = preparedSnapshot ?? (await a.prepareLocalTask(input, planning));
  const baseline = await a.checkLocalTask(input, snapshot, 'baseline', null, null);
  expect(baseline.status).toBe('PASS');
  const writer =
    input.schemaVersion === 9
      ? await a.writeLocalTask(input, snapshot, progress)
      : await a.writeLocalTask(input, snapshot);
  const candidate = await a.checkLocalTask(input, snapshot, 'candidate', writer, null);
  expect(candidate.status).toBe('PASS');
  const intent = await a.planLocalIntegration(input, snapshot, writer, candidate.manifest),
    integration = await a.integrateLocalTask(input, snapshot, intent);
  const checked = await a.checkLocalTask(input, snapshot, 'integrated', writer, integration);
  expect(checked.status).toBe('PASS');
  const packet = await a.prepareLocalAcceptance(
    input,
    snapshot,
    writer,
    candidate.manifest,
    intent,
    integration,
    checked.manifest,
    baseline.manifest,
  );
  return { a, snapshot, baseline, writer, candidate, intent, integration, checked, packet };
}
export async function acceptance(
  f: TaskRunFixture,
  run: Awaited<ReturnType<typeof throughIntegration>>,
) {
  return runReview(f, run.packet);
}
export async function runReview(f: TaskRunFixture, review: ReviewInput, profile = f.profile) {
  const activity = reviewActivities(f.registration, f.rpc, profile),
    plan = await activity.prepareReviewPlan(review),
    answers = [];
  for (const row of plan.decisions) {
    if (row.action !== 'review') {
      answers.push({ roleId: row.roleId, answer: row.answer });
      continue;
    }
    const input = requireScoped(row.input),
      prepared = prepareScopedReview(f.registration, input);
    const actor = readerActivities(f.registration, f.rpc, profile, join(f.root, 'reader-effects'));
    const session = await actor.createReader(input, prepared),
      load = await actor.loadReader(input, prepared, session),
      answer = await actor.answerReader(input, prepared, session, load);
    answers.push({ roleId: row.roleId, answer });
  }
  return activity.finishReview({
    schemaVersion: 1,
    input: review,
    plan: plan.manifest,
    answers,
  });
}
