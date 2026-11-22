import { join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { localAdmissionActivities } from '../../src/activities/localAdmission.js';
import { localPlanningRisks, validateLocalPlan } from '../../src/policy/localPlanning.js';
import type { LocalImplementationPlan } from '../../src/policy/localPlanning.js';
import type { LocalAdmissionInput } from '../../src/contracts/localAdmission.js';
import type { ReviewRequest } from '../../src/contracts/review.js';
import { localAdmissionKey, parseLocalAdmission } from '../../src/policy/localAdmission.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { startLocalAdmission } from '../../src/client/localAdmission.js';
import { bindTaskBackendClient } from '../../src/client/taskBackend.js';
import { LocalAdmissionWorkflow } from '../../src/workflows/localAdmission.js';
import { controlFixture } from './controlFixture.js';

const sdk = vi.hoisted(() => ({ prepareLocalAdmission: vi.fn(), setHandler: vi.fn() }));
vi.mock('@temporalio/workflow', async () => ({
  ApplicationFailure: (await import('@temporalio/common')).ApplicationFailure,
  defineQuery: (name: string) => name,
  proxyActivities: () => ({ prepareLocalAdmission: sdk.prepareLocalAdmission }),
  setHandler: sdk.setHandler,
}));
function fixture() {
  const f = controlFixture();
  for (const file of ['accepted.md', 'owner.js', 'consumer.js'])
    writeFileSync(join(f.workspace, file), file);
  const ref = (locator: string) => ({
    locator,
    hash: digest(readFileSync(join(f.workspace, locator))),
  });
  const plan: LocalImplementationPlan = {
    schema_version: 1,
    requirement: ref('tasks/one.md'),
    basis: [ref('accepted.md')],
    owner: ref('owner.js'),
    consumers: [ref('consumer.js')],
    consumers_complete: true,
    paths: ['owner.js', 'consumer.js'],
    risks: Object.fromEntries(
      localPlanningRisks.map((risk) => [risk, false]),
    ) as LocalImplementationPlan['risks'],
    reason: 'Implement the accepted contract locally',
    checks: ['syntax'],
    criterion: 'Existing behavior meets the stated criterion',
  };
  const review: ReviewRequest = {
    schemaVersion: 1,
    phase: 'acceptance',
    scope: 'local',
    sharedPaths: ['accepted.md'],
    roles: [
      {
        roleId: 'reviewer',
        applies: true,
        reason: 'Check local result independently',
        paths: ['owner.js', 'consumer.js'],
        complete: true,
        attestedBy: 'qualification',
        discoveryRule: 'declared',
        history: { complete: true, answers: [] },
      },
    ],
  };
  function input(): LocalAdmissionInput {
    const body = Buffer.from(JSON.stringify(plan));
    writeFileSync(join(f.workspace, 'plan.json'), body);
    return {
      schemaVersion: 1,
      preparation: f.input.preparation,
      plan: { path: 'plan.json', sha256: digest(body) },
      acceptance: f.save(review),
    };
  }
  return { ...f, plan, review, input, activities: localAdmissionActivities(f.registration) };
}
describe('B1 local admission before any dependent action', () => {
  it('binds the existing local plan, source bytes and complete independent acceptance without models or writes', async () => {
    const f = fixture(),
      input = f.input(),
      before = readdirSync(f.workspace);
    const result = await f.activities.prepareLocalAdmission(input);
    expect(result.status).toBe('admitted');
    expect(await f.activities.prepareLocalAdmission(input)).toEqual(result);
    const manifest = JSON.parse(f.store.read(result.manifest).toString()) as {
      kind: string;
      plan: LocalImplementationPlan;
      acceptanceFiles: { path: string }[];
    };
    expect(manifest.kind).toBe('local-admission');
    expect(manifest.plan).toEqual(f.plan);
    expect(manifest.acceptanceFiles.map((v) => v.path)).toEqual([
      'accepted.md',
      'owner.js',
      'consumer.js',
    ]);
    expect(readdirSync(f.workspace)).toEqual(before);
    expect(f.rpc.request).not.toHaveBeenCalled();
  });
  it.each(localPlanningRisks)('rejects true or unknown %s even for one file', async (risk) => {
    const f = fixture();
    for (const flag of [true, null]) {
      const invalid: unknown = { ...f.plan, risks: { ...f.plan.risks, [risk]: flag } };
      expect(() => validateLocalPlan(invalid)).toThrow('local-needs-council-planning');
    }
  });
  it('preserves legacy plan validation for incomplete sources, paths and checks', () => {
    const f = fixture();
    for (const patch of [
      { schema_version: 2 },
      { basis: [] },
      { basis: null },
      { consumers: [] },
      { consumers: null },
      { consumers_complete: false },
      { paths: [] },
      { paths: null },
      { paths: ['owner.js', 'owner.js'] },
      { paths: ['../outside'] },
      { paths: ['/absolute'] },
      { paths: ['unsafe path'] },
      { risks: {} },
      { reason: '' },
      { criterion: ' ' },
      { checks: [] },
      { checks: null },
      { checks: [''] },
      { requirement: null },
      { owner: { locator: 7, hash: 'x' } },
      { owner: { locator: 'owner.js', hash: '' } },
    ])
      expect(() => validateLocalPlan({ ...f.plan, ...patch })).toThrow();
    expect(() => validateLocalPlan(null)).toThrow('invalid-object');
  });
  it('rejects missing, changed and foreign bindings before any model', async () => {
    const f = fixture(),
      input = f.input();
    await expect(
      f.activities.prepareLocalAdmission({
        ...input,
        preparation: { ...input.preparation, owner: 'other' },
      }),
    ).rejects.toThrow('preparation-grant-mismatch');
    writeFileSync(join(f.workspace, 'plan.json'), '{}');
    await expect(f.activities.prepareLocalAdmission(input)).rejects.toThrow(
      'local-plan-source-changed',
    );
    const next = f.input();
    writeFileSync(join(f.workspace, 'owner.js'), 'changed');
    await expect(f.activities.prepareLocalAdmission(next)).rejects.toThrow(
      'local-admission-source-changed',
    );
    expect(f.rpc.request).not.toHaveBeenCalled();
  });
  it('does not authorize editing admission sources, rules, role profiles or omitting required checks', async () => {
    for (const path of ['plan.json', 'accepted.md', 'tasks', 'RULES.md', 'reviewer.md']) {
      const f = fixture();
      f.plan.paths = [path];
      await expect(f.activities.prepareLocalAdmission(f.input())).rejects.toThrow(
        'local-plan-authorizes-own-basis',
      );
    }
    const f = fixture();
    f.plan.checks = ['other'];
    await expect(f.activities.prepareLocalAdmission(f.input())).rejects.toThrow(
      'local-plan-checks-incomplete',
    );
    f.plan.checks = ['syntax', 'other'];
    await expect(f.activities.prepareLocalAdmission(f.input())).rejects.toThrow(
      'local-plan-checks-incomplete',
    );
  });
  it('requires an acceptance role, complete dependencies/history and a real acceptance phase', async () => {
    for (const defect of ['planning', 'no-role', 'unknown', 'dependencies', 'history'] as const) {
      const f = fixture(),
        role = f.review.roles[0]!;
      if (defect === 'planning') f.review.phase = 'planning';
      if (defect === 'no-role') role.applies = false;
      if (defect === 'unknown') role.applies = null;
      if (defect === 'dependencies') role.complete = false;
      if (defect === 'history') role.history.complete = false;
      await expect(f.activities.prepareLocalAdmission(f.input())).rejects.toThrow(
        'local-acceptance-incomplete',
      );
    }
    const f = fixture();
    f.review.roles.push({ ...f.review.roles[0]!, roleId: 'unknown' });
    await expect(f.activities.prepareLocalAdmission(f.input())).rejects.toThrow();
  });
  it('checks additional registered commands during preparation without executing them', async () => {
    const f = fixture();
    f.plan.checks.push('extra');
    const invalid = localAdmissionActivities({
      ...f.registration,
      commands: { ...f.registration.commands, extra: { executable: '', args: [] } },
    });
    await expect(invalid.prepareLocalAdmission(f.input())).rejects.toThrow(
      'invalid-registered-command',
    );
    const valid = localAdmissionActivities({
      ...f.registration,
      commands: { ...f.registration.commands, extra: { executable: 'not-launched', args: [] } },
    });
    expect((await valid.prepareLocalAdmission(f.input())).status).toBe('admitted');
    expect(f.rpc.request).not.toHaveBeenCalled();
  });
  it('validates versioned input and keeps changed assignments distinct or conflicting', async () => {
    const f = fixture(),
      input = f.input();
    for (const patch of [
      { schemaVersion: 2 },
      { extra: 1 },
      { plan: { path: '../outside', sha256: input.plan.sha256 } },
      { plan: { path: 'plan.json', sha256: 'bad' } },
    ])
      expect(() => parseLocalAdmission({ ...input, ...patch })).toThrow();
    expect(localAdmissionKey(input)).toBe('aw/local-admission/neutral/one/' + input.plan.sha256);
    const query = vi.fn().mockResolvedValue(input),
      handle = { query },
      start = vi.fn().mockResolvedValue(handle);
    const client = { workflow: { start } } as unknown as Client;
    bindTaskBackendClient(client, f.registration);
    expect(await startLocalAdmission(client, input, 'q')).toBe(handle);
    expect(start.mock.calls[0]![1]).toMatchObject({
      workflowId: localAdmissionKey(input),
      taskQueue: 'q',
    });
    query.mockResolvedValue({ ...input, preparation: { ...input.preparation, revision: 2 } });
    await expect(startLocalAdmission(client, input, 'q')).rejects.toThrow(
      'local-admission-start-conflict',
    );
    sdk.prepareLocalAdmission.mockResolvedValue({ status: 'admitted', manifest: f.proof });
    expect(await LocalAdmissionWorkflow(input)).toEqual({ status: 'admitted', manifest: f.proof });
    expect((sdk.setHandler.mock.calls.at(-1)![1] as () => unknown)()).toEqual(input);
    await expect(
      LocalAdmissionWorkflow({ ...input, schemaVersion: 2 } as unknown as LocalAdmissionInput),
    ).rejects.toBeInstanceOf(ApplicationFailure);
  });
});
