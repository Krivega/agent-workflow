import { applyExecution, createExecution, executionBlockers } from '../core/execution.js';
import { assignAdviser, configuredRoles, createCouncil } from '../core/council.js';
import type { Selection } from '../core/council.js';
import type { Execution, ExecutionAction } from '../core/execution.js';
import { applyLocalEvent, startLocalRun } from '../core/localRun.js';
import type { RunSpec } from '../core/localRun.js';
import {
  localStableRefs,
  validateLocalAdmission,
  validateLocalReview,
} from '../core/localPlanning.js';
import type { LocalAdmission } from '../core/localPlanning.js';
import type { LocalImplementationPlan } from '../core/localRun.js';
import { localPlanningRisks, validateLocalPlan } from '../core/localRun.js';
import { executionEvent, workflowFixture } from './workflowFixtures.js';
import { event, loadedRun } from './localFixtures.js';
import { taskChatOptions } from '../cli/taskChatInputs.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
let admission: LocalAdmission;
beforeEach(async () => {
  f = await workflowFixture();
  f.target.inputs = await f.inputs.capture(
    { files: ['source.txt', 'proof.txt'], directories: [] },
    'local plan',
  );
  for (const entry of Object.values(f.selection)) entry.inputs = f.target.inputs;
  const plan: LocalImplementationPlan = {
    schema_version: 1,
    requirement: f.proof,
    basis: [f.proof],
    owner: await f.ref('source.txt'),
    paths: ['source.txt'],
    consumers: [await f.ref('source.txt')],
    consumers_complete: true,
    risks: Object.fromEntries(
      localPlanningRisks.map((risk) => [risk, false]),
    ) as LocalImplementationPlan['risks'],
    reason: 'Correction inside the accepted pure-function contract',
    checks: ['validate'],
    criterion: 'Existing contract holds at the failing boundary',
  };
  admission = { plan, source: f.proof, inputs: f.target.inputs, selection: f.selection };
});
afterEach(async () => {
  await f.dispose();
});
const act = (run: Execution, action: ExecutionAction) =>
  applyExecution(run, executionEvent(run, action));
function initial() {
  return createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
    true,
    'local',
  );
}
function review(): Extract<ExecutionAction, { type: 'REVIEW' }> {
  return {
    type: 'REVIEW',
    target: f.target,
    selection: f.selection,
    checks: [
      {
        id: 'validate',
        verdict: 'PASS',
        reason: 'real check',
        evidence: f.proof,
        inputs: f.target.inputs,
      },
    ],
    baseline: {
      kind: 'real',
      scenario: 'local command',
      evidence: f.proof,
      inputs: f.target.inputs,
      elapsed_ms: 1,
      exit_code: 0,
    },
  };
}
it('admits a separate versioned route while requiring LOAD, checks and independent acceptance', () => {
  validateLocalAdmission(admission, f.target);
  const local = startLocalRun(
    { ...f.spec, route: { kind: 'local', accepted_plan: f.proof, plan: admission.plan } },
    1,
  );
  expect(local.schema_version).toBe(2);
  expect(() => applyLocalEvent(local, event(local, { type: 'READY' }))).toThrow('load-unconfirmed');
  const loaded = loadedRun(local);
  expect(applyLocalEvent(loaded, event(loaded, { type: 'READY' })).status).toBe('ready');
  let run = initial();
  expect(run.schema_version).toBe(3);
  expect(() => act(run, review())).toThrow('implementation-not-started');
  run = act(run, { type: 'LOCAL', admission });
  expect(run.planning).toBeNull();
  expect(run.status).toBe('implementing');
  run = act(run, review());
  expect(executionBlockers(run)).toContain('acceptance-missing');
  expect(() => act(run, { type: 'DONE' })).toThrow('premature-done');
  run = act(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] });
  expect(executionBlockers(run)).toEqual([]);
});
it('restores a project-defined local reviewer from the accepted profile after losing its session', () => {
  const [catalog, profile] = f.profiles.architect;
  const configuration = { catalog: catalog!.locator, profiles: { maintainer: profile!.locator } };
  const roles = configuredRoles(configuration);
  const reviewer = roles[0]!;
  const selection = Object.fromEntries(
    roles.map((role) => [role, f.selection.architect]),
  ) as Selection;
  let run = act(initial(), {
    type: 'LOCAL',
    admission: { ...admission, selection, configuration },
  });
  run = act(run, { ...review(), selection });
  const council = assignAdviser(
    createCouncil('acceptance', selection, f.target, configuration),
    reviewer,
    f.adviser,
  );
  run = act(run, { type: 'ACCEPT', council, findings: [] });
  const replacement = {
    ...f.adviser,
    spec: { ...f.adviser.spec, session_id: 'replacement' },
    loaded: { ...f.adviser.loaded!, session_id: 'replacement' },
  };
  run = act(run, {
    type: 'REPLACE_REVIEWER',
    role: reviewer,
    previous_session: f.adviser.spec.session_id,
    run: replacement,
    checkpoint: f.proof,
  });
  expect(run.acceptance?.configuration).toEqual(configuration);
  expect(run.reviewer_sessions.maintainer).toBe('replacement');
});
it.each(localPlanningRisks)('rejects the %s risk even for one declared file', (risk) => {
  expect(() =>
    validateLocalPlan({ ...admission.plan, risks: { ...admission.plan.risks, [risk]: true } }),
  ).toThrow('local-needs-council-planning');
  expect(() =>
    validateLocalPlan({ ...admission.plan, risks: { ...admission.plan.risks, [risk]: null } }),
  ).toThrow('local-needs-council-planning');
});
it('rejects incomplete classification, sources, checks and unknown applicability', () => {
  for (const patch of [
    { schema_version: 2 },
    { basis: [] },
    { consumers: [] },
    { consumers_complete: false },
    { paths: [] },
    { paths: ['../outside'] },
    { paths: ['source.txt', 'source.txt'] },
    { risks: {} },
    { risks: { ...admission.plan.risks, extra: false } },
    { reason: '' },
    { checks: [] },
    { checks: [''] },
    { criterion: '' },
    { requirement: { locator: '', hash: 'x' } },
  ])
    expect(() => validateLocalPlan({ ...admission.plan, ...patch })).toThrow();
  expect(() =>
    validateLocalAdmission(
      { ...admission, inputs: { ...admission.inputs, complete: false } },
      f.target,
    ),
  ).toThrow('local-admission-inputs-mismatch');
  expect(() =>
    validateLocalAdmission({ ...admission, source: { ...f.proof, hash: 'changed' } }, f.target),
  ).toThrow('local-admission-source-missing');
  const selection = structuredClone(f.selection);
  selection.architect.trigger = false;
  expect(() => validateLocalAdmission({ ...admission, selection }, f.target)).toThrow(
    'local-acceptance-required',
  );
  selection.architect.trigger = null;
  expect(() => validateLocalAdmission({ ...admission, selection }, f.target)).toThrow();
});
it('permits the declared implementation delta and escalates changed basis, consumers or roles', async () => {
  const original = structuredClone(admission);
  expect(localStableRefs(admission.plan, admission.inputs.inputs)).toEqual([f.proof]);
  await f.file('source.txt', 'changed implementation');
  f.target.inputs = await f.inputs.current(f.target.inputs);
  const selection = structuredClone(f.selection);
  selection.architect.inputs = f.target.inputs;
  validateLocalReview(original, f.target, selection);
  const extra = { locator: 'other-consumer.ts', hash: 'new' };
  expect(() =>
    validateLocalReview(
      original,
      { ...f.target, inputs: { ...f.target.inputs, inputs: [...f.target.inputs.inputs, extra] } },
      selection,
    ),
  ).toThrow('local-delta-needs-planning');
  expect(() =>
    validateLocalReview(
      original,
      { ...f.target, inputs: { ...f.target.inputs, complete: false } },
      selection,
    ),
  ).toThrow('local-inputs-unknown');
  await f.file('proof.txt', 'changed accepted basis');
  const changedBasis = await f.inputs.current(f.target.inputs);
  expect(() =>
    validateLocalReview(original, { ...f.target, inputs: changedBasis }, selection),
  ).toThrow('local-delta-needs-planning');
  const newRole = structuredClone(selection);
  newRole.dba.trigger = true;
  expect(() => validateLocalReview(original, f.target, newRole)).toThrow(
    'local-delta-needs-planning',
  );
  const newRequirements = structuredClone(selection);
  newRequirements.architect.requirements.push(extra);
  expect(() => validateLocalReview(original, f.target, newRequirements)).toThrow(
    'local-delta-needs-planning',
  );
});
it('returns to ordinary planning on revised requirements and preserves the local history', () => {
  const run = act(initial(), { type: 'LOCAL', admission });
  const next = act(run, {
    type: 'REPLAN',
    target: f.target,
    requirements: { revision: 1, source: f.proof },
  });
  expect(next.route).toBe('substantial');
  expect(next.local).toBeUndefined();
  expect(next.schema_version).toBe(3);
  expect(next.history).toHaveLength(2);
  expect(() => act(next, review())).toThrow('implementation-not-started');
});
it('rejects an unknown route and legacy version pretending to carry a local admission', () => {
  const run = loadedRun(startLocalRun(f.spec, 1));
  const unknown = {
    ...run,
    spec: { ...run.spec, route: { kind: 'future' } as unknown as RunSpec['route'] },
  };
  expect(() => applyLocalEvent(unknown, event(unknown, { type: 'READY' }))).toThrow(
    'unsupported-run-route',
  );
  const legacy = {
    ...run,
    spec: {
      ...run.spec,
      route: { kind: 'local' as const, accepted_plan: f.proof, plan: admission.plan },
    },
  };
  expect(() => applyLocalEvent(legacy, event(legacy, { type: 'READY' }))).toThrow(
    'local-plan-required',
  );
});
it('selects the explicit local CLI route without conflating it with --plan', () => {
  expect(
    taskChatOptions(['start', '--state', '/tmp/external', '--local-plan', 'local.json']).localPlan,
  ).toBe('local.json');
  expect(() =>
    taskChatOptions([
      'start',
      '--state',
      '/tmp/external',
      '--plan',
      'normal.md',
      '--local-plan',
      'local.json',
    ]),
  ).toThrow('conflicting-task-chat-plan');
});
