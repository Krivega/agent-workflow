import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalTaskInput } from '../../src/contracts/localTask.js';
import type { SubstantialPlan } from '../../src/contracts/substantialTask.js';
import type { ReviewRequest } from '../../src/contracts/review.js';
import { localTaskFixture } from './localTaskFixture.js';
import { digest } from '../../src/adapters/artifacts/files.js';
export function substantialTaskFixture() {
  const f = localTaskFixture();
  writeFileSync(
    join(f.workspace, 'tasks/one.md'),
    '# Substantial fixture\nGoal: add trimming of names. Criterion S1: surrounding whitespace is removed and ordinary names are retained.\n',
  );
  writeFileSync(
    join(f.workspace, 'accepted.md'),
    'Current contract: names pass through unchanged.\n',
  );
  writeFileSync(
    join(f.workspace, 'proposal.md'),
    'Proposal S1: introduce trimming of surrounding whitespace. Ordinary names stay unchanged. Change only owner.cjs. Complete consumers: consumer.cjs, smoke.cjs, validate.cjs. No storage, new authority, network or architecture.\n',
  );
  writeFileSync(
    join(f.workspace, 'tester.md'),
    'Independently assess the proposed criteria and eventual actual checks.\n',
  );
  f.registration.project.roles.push({ id: 'tester', profile: 'tester.md' });
  const ref = (locator: string) => ({
    locator,
    hash: digest(readFileSync(join(f.workspace, locator))),
  });
  const plan: SubstantialPlan = {
    ...f.plan,
    schema_version: 2,
    plan_id: 'S1',
    requirement: ref('tasks/one.md'),
    basis: [ref('accepted.md'), ref('proposal.md')],
    risks: { ...f.plan.risks, new_behavior: true, new_contract: true },
    reason: 'Introduce the explicitly proposed trimming contract after planning acceptance',
  };
  const bytes = Buffer.from(JSON.stringify(plan));
  writeFileSync(join(f.workspace, 'plan.json'), bytes);
  const roles = f.registration.project.roles.map((r) => ({ ...f.review.roles[0]!, roleId: r.id }));
  const request: ReviewRequest = {
    ...f.review,
    scope: plan.plan_id,
    sharedPaths: [
      'plan.json',
      'proposal.md',
      'accepted.md',
      'consumer.cjs',
      'smoke.cjs',
      'validate.cjs',
    ],
    roles,
  };
  const input: Extract<LocalTaskInput, { schemaVersion: 3 }> = {
    schemaVersion: 3,
    admission: {
      schemaVersion: 3,
      preparation: f.input.admission.preparation,
      plan: { path: 'plan.json', sha256: digest(bytes) },
      planning: f.save({ ...request, phase: 'planning' }),
      acceptance: f.save(request),
    },
    executor: f.input.executor,
    baseline: f.input.baseline,
  };
  return { ...f, service: f.makeService(), substantialInput: input, proposal: plan, request };
}
