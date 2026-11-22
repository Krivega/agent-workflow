import { FileProjectCards } from '../adapters/project/fileProjectCards.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beginLocalWorkflow, advanceLocalWorkflow } from '../application/localWorkflow.js';
import { projectLocalCard, reconcileLocalCard } from '../application/projectLocalCard.js';
import { AssignmentLocalRuns, TaskLocalRuns } from '../adapters/storage/localRunStores.js';
import { startLocalRun } from '../core/localRun.js';
import type { LocalRun, RunSpec } from '../core/localRun.js';
import { event, localFixture } from './localFixtures.js';
import { fixture, grant } from './storageFixtures.js';

let f: Awaited<ReturnType<typeof localFixture>>;
let storage: ReturnType<typeof fixture>;
beforeEach(async () => {
  f = await localFixture();
  storage = fixture();
  storage.claim();
});
afterEach(async () => {
  storage.dispose();
  await f.dispose();
});
function taskRuns() {
  return new TaskLocalRuns(
    { execute: (r) => Promise.resolve(storage.store.execute(r)) },
    grant.context,
    1,
  );
}
async function boot() {
  const runs = taskRuns();
  let run = await beginLocalWorkflow(f.spec, 1, runs, f.inputs);
  run = await advanceLocalWorkflow(
    event(run, {
      type: 'LOAD',
      receipt: {
        run_id: 'run',
        session_id: 'session',
        rules: f.spec.rules,
        procedures: f.spec.procedures,
        observed_read: 'fixture-only',
      },
    }),
    runs,
    f.inputs,
  );
  run = await advanceLocalWorkflow(event(run, { type: 'READY' }), runs, f.inputs);
  return { runs, run };
}

it.each(['arbiter', 'auditor'] as const)(
  'loads a minimal %s through the file adapter',
  async (role) => {
    const procedure = role === 'arbiter' ? 'arbitration' : 'audit';
    const spec: RunSpec = {
      ...f.spec,
      role,
      parent_run_id: 'parent',
      requested: { ...f.spec.requested, permissions: ['read'] },
      effective: { ...f.spec.effective!, permissions: ['read'] },
      product: false,
      identity: { assignment_id: role },
      route: { kind: 'nonproduct' },
      fork_turns: 'none',
      procedures: f.spec.procedures.filter((p) => p.id === procedure || p.id === 'evidence'),
    };
    for (const procedures of [
      spec.procedures.filter((p) => p.id !== procedure),
      spec.procedures.filter((p) => p.id !== 'evidence'),
      f.spec.procedures.filter((p) => ['bootstrap', 'data-roles', 'evidence'].includes(p.id)),
    ])
      await expect(f.inputs.verify(startLocalRun({ ...spec, procedures }, 1))).rejects.toThrow(
        'missing-procedure',
      );
    const runs = new AssignmentLocalRuns(resolve(f.root, role));
    let run = await beginLocalWorkflow(spec, 1, runs, f.inputs);
    run = await advanceLocalWorkflow(
      event(run, {
        type: 'LOAD',
        receipt: {
          run_id: spec.run_id,
          session_id: spec.session_id,
          rules: spec.rules,
          procedures: spec.procedures,
          observed_read: 'fixture-only',
        },
      }),
      runs,
      f.inputs,
    );
    run = await advanceLocalWorkflow(event(run, { type: 'READY' }), runs, f.inputs);
    expect(run.status).toBe('ready');
    expect(await new AssignmentLocalRuns(resolve(f.root, role)).read()).toEqual(run);
  },
);

it('persists local readiness in AW3, moves a card and resumes after reopening the store', async () => {
  const { runs, run } = await boot();
  expect(run.status).toBe('ready');
  await expect(beginLocalWorkflow(f.spec, 1, runs, f.inputs)).rejects.toThrow('run-already-exists');
  const next = await projectLocalCard('verifying', 'project', runs, f.cards, f.inputs);
  expect(next.projection?.result.status).toBe('confirmed');
  expect(next.spec.identity).toMatchObject({
    task_id: 'task',
    card: { locator: `${f.connection.plans.verifying}/task.md` },
  });
  expect(await taskRuns().read()).toEqual(next);
  const cancelled = await advanceLocalWorkflow(
    event(next, {
      type: 'CANCEL',
      reason: 'stop',
      unfinished: ['acceptance'],
      stopped_receipt: 'fixture no writers',
    }),
    runs,
    f.inputs,
  );
  expect(
    await advanceLocalWorkflow(
      event(next, {
        type: 'CANCEL',
        reason: 'stop',
        unfinished: ['acceptance'],
        stopped_receipt: 'fixture no writers',
      }),
      runs,
      f.inputs,
    ),
  ).toEqual(cancelled);
  await expect(
    advanceLocalWorkflow(event(cancelled, { type: 'READY' }), runs, f.inputs),
  ).rejects.toThrow('run-cancelled');
  expect((await f.cards.read(`${f.connection.plans.verifying}/task.md`)).status).toBe('verifying');
});

it('retains a pending projection and both versions after manual conflict, then explicitly reconciles', async () => {
  const { runs } = await boot();
  const originalApply = f.cards.apply.bind(f.cards);
  const apply = vi.spyOn(f.cards, 'apply').mockImplementationOnce(async (plan) => {
    await f.file('pointer.md', 'manual');
    return originalApply(plan);
  });
  let run = await projectLocalCard('verifying', 'manual', runs, f.cards, f.inputs);
  expect(run.projection?.result).toEqual({ status: 'pending', conflicts: ['pointer.md'] });
  await expect(advanceLocalWorkflow(event(run, { type: 'READY' }), runs, f.inputs)).rejects.toThrow(
    'reconciliation-pending',
  );
  await expect(projectLocalCard('completed', 'new', runs, f.cards, f.inputs)).rejects.toThrow(
    'reconciliation-pending',
  );
  expect(await readFile(resolve(f.root, 'pointer.md'), 'utf8')).toBe('manual');
  const change = run.projection.plan.changes.find((c) => c.locator === 'pointer.md')!;
  await f.file('pointer.md', change.before!);
  run = await projectLocalCard('verifying', 'manual', taskRuns(), f.cards, f.inputs);
  expect(run.projection?.result.status).toBe('confirmed');
  expect(apply).toHaveBeenCalledTimes(2);
});

it('rechecks sources and card revision before readiness or a dependent write', async () => {
  const { run, runs } = await boot();
  await f.file('source.txt', 'new revision');
  await expect(advanceLocalWorkflow(event(run, { type: 'READY' }), runs, f.inputs)).rejects.toThrow(
    'source-revision-mismatch',
  );
  expect(await runs.read()).toEqual(run);
  await f.file('source.txt', 'source revision 1');
  await f.file(f.card.locator, f.card.content + '\nManual criterion\n');
  await expect(projectLocalCard('completed', 'conflict', runs, f.cards, f.inputs)).rejects.toThrow(
    'card-identity-mismatch',
  );
  // A concurrent edit after input verification must still lose the projection CAS.
  await expect(
    projectLocalCard('completed', 'conflict', runs, f.cards, { verify: async () => undefined }),
  ).rejects.toThrow('card-revision-conflict');
});

it('persists cardless assignments separately and preserves their failures and elapsed after reopen', async () => {
  const spec = {
    ...f.spec,
    product: false,
    identity: { assignment_id: 'assignment' },
    route: { kind: 'nonproduct' as const },
  };
  const root = resolve(f.root, '.assignment');
  const runs = new AssignmentLocalRuns(root);
  const run = await beginLocalWorkflow(spec, 1, runs, f.inputs);
  const failed = await advanceLocalWorkflow(
    event(run, {
      type: 'RESULT',
      session_id: 'session',
      source: spec.sources[0]!,
      outcome: 'FAIL',
    }),
    runs,
    f.inputs,
  );
  expect(await new AssignmentLocalRuns(root).read()).toEqual(failed);
  await expect(runs.save(run, failed)).rejects.toThrow('run-revision-conflict');
  await expect(runs.save(failed, startLocalRun(f.spec, 1))).rejects.toThrow('assignment-only');
  await writeFile(resolve(root, 'assignment.json'), '{"schema_version":99}');
  await expect(runs.read()).rejects.toThrow('unsupported-run-version');
  await writeFile(resolve(root, 'assignment.json'), 'not-json');
  await expect(runs.read()).rejects.toThrow(SyntaxError);
  expect(await taskRuns().read()).toBeNull();
});

it('rejects absent runs, foreign writers, stale Store owners and wrong task context', async () => {
  const runs = taskRuns();
  const initial = startLocalRun(f.spec, 1);
  await expect(
    advanceLocalWorkflow(event(initial, { type: 'WAIT' }), runs, f.inputs),
  ).rejects.toThrow('run-not-found');
  await expect(projectLocalCard('active', 'x', runs, f.cards, f.inputs)).rejects.toThrow(
    'run-not-found',
  );
  const { run } = await boot();
  await expect(runs.save(null, run)).rejects.toThrow('run-revision-conflict');
  await expect(
    runs.save(run, { ...run, spec: { ...f.spec, project_id: 'foreign' } }),
  ).rejects.toThrow('wrong-store-context');
  const foreign: LocalRun = {
    ...run,
    revision: run.revision + 1,
    spec: { ...f.spec, writer: 'other' },
  };
  await runs.save(run, foreign);
  await expect(projectLocalCard('active', 'x', runs, f.cards, f.inputs)).rejects.toThrow(
    'not-card-writer',
  );
  const stale = new TaskLocalRuns(
    { execute: (r) => Promise.resolve(storage.store.execute(r)) },
    grant.context,
    99,
  );
  await expect(stale.save(foreign, { ...foreign, revision: foreign.revision + 1 })).rejects.toThrow(
    'store-write-rejected',
  );
  const unavailable = new TaskLocalRuns(
    {
      execute: async () => ({
        ok: false,
        error: {
          code: 'unavailable',
          operation_id: null,
          observed_revision: null,
          retryable: true,
          recovery_locator: '',
        },
      }),
    },
    grant.context,
    1,
  );
  await expect(unavailable.read()).rejects.toThrow('store-unavailable');
});

it('does not accept missing or changed rules, procedures, task IDs or source files', async () => {
  const initial = startLocalRun(f.spec, 1);
  for (const [spec, error] of [
    [{ ...f.spec, project_id: 'wrong' }, 'wrong-project'],
    [{ ...f.spec, procedures: [] }, 'missing-procedure'],
    [
      { ...f.spec, procedures: f.spec.procedures.map((p) => ({ ...p, version: '99' })) },
      'procedure-version-mismatch',
    ],
    [{ ...f.spec, rules: [] }, 'rules-version-mismatch'],
    [{ ...f.spec, rules: [{ locator: 'AGENTS.md', hash: 'changed' }] }, 'rules-version-mismatch'],
    [
      {
        ...f.spec,
        identity: { task_id: 'wrong', card: { locator: f.card.locator, hash: f.card.revision } },
      },
      'card-identity-mismatch',
    ],
  ] as [RunSpec, string][])
    await expect(f.inputs.verify({ ...initial, spec })).rejects.toThrow(error);
  await f.inputs.verify({
    ...initial,
    spec: {
      ...f.spec,
      route: { kind: 'mechanical', accepted_material: f.spec.assignment, semantic_delta: false },
    },
  });
  await f.inputs.verify({
    ...initial,
    spec: { ...f.spec, route: { kind: 'substantial', accepted_plan: null } },
  });
  await expect(
    f.inputs.verify({
      ...initial,
      spec: { ...f.spec, sources: [{ locator: 'missing.txt', hash: 'a' }] },
    }),
  ).rejects.toThrow('ENOENT');
});

it('preserves unrelated technical checkpoint fields when adding a run', async () => {
  expect(
    storage.mutate({ type: 'checkpoint', state: { retained: 'FAIL' }, effects: [] }, 1).ok,
  ).toBe(true);
  const runs = taskRuns();
  expect(await runs.read()).toBeNull();
  const run = await beginLocalWorkflow(f.spec, 1, runs, f.inputs);
  expect(await runs.read()).toEqual(run);
  expect(storage.execute({ type: 'state' })).toMatchObject({
    ok: true,
    value: { checkpoint: { retained: 'FAIL' } },
  });
});

it('explicitly reconciles a manual version, retaining the old journal and the accepted manual text', async () => {
  const { runs } = await boot();
  const decision = {
    previous_id: 'original',
    operation_id: 'resolved',
    decision: 'Owner accepts merged text',
    files: [],
  };
  await expect(reconcileLocalCard(decision, runs, f.cards)).rejects.toThrow(
    'no-pending-projection',
  );
  const apply = f.cards.apply.bind(f.cards);
  vi.spyOn(f.cards, 'apply').mockImplementationOnce(async (plan) => {
    await f.file('pointer.md', 'manual text');
    return apply(plan);
  });
  const run = await projectLocalCard('verifying', 'original', runs, f.cards, f.inputs);
  const change = run.projection.plan.changes.find((f) => f.locator === 'pointer.md')!;
  const resolution = {
    ...decision,
    files: [{ ...change, before: 'manual text', after: `${change.after}\nmanual text\n` }],
  };
  for (const patch of [{ previous_id: 'unknown' }, { operation_id: 'original' }, { decision: '' }])
    await expect(reconcileLocalCard({ ...resolution, ...patch }, runs, f.cards)).rejects.toThrow(
      'invalid-reconciliation',
    );
  for (const files of [[], [change, change], [{ ...change, locator: 'outside.md' }]])
    await expect(reconcileLocalCard({ ...resolution, files }, runs, f.cards)).rejects.toThrow(
      'reconciliation-scope-mismatch',
    );
  await expect(
    reconcileLocalCard(
      resolution,
      {
        read: async () => ({ ...run, spec: { ...run.spec, writer: 'foreign' } }),
        save: async () => undefined,
      },
      f.cards,
    ),
  ).rejects.toThrow('not-card-writer');
  const next = await reconcileLocalCard(resolution, runs, f.cards);
  expect(next.projection?.result.status).toBe('confirmed');
  expect(await readFile(resolve(f.root, 'pointer.md'), 'utf8')).toContain('manual text');
  expect(await readFile(resolve(f.root, '.journal/original.json'), 'utf8')).toContain(
    'operation_id',
  );
  expect(next.projection?.plan.supersedes).toEqual({
    operation_id: 'original',
    decision: decision.decision,
  });
});

it('keeps reconciliation pending if an explicitly merged input changed again', async () => {
  const { runs } = await boot();
  const apply = f.cards.apply.bind(f.cards);
  vi.spyOn(f.cards, 'apply').mockImplementationOnce(async (plan) => {
    await f.file('pointer.md', 'manual');
    return apply(plan);
  });
  const run = await projectLocalCard('verifying', 'original', runs, f.cards, f.inputs);
  const change = run.projection.plan.changes.find((f) => f.locator === 'pointer.md')!;
  const next = await reconcileLocalCard(
    {
      previous_id: 'original',
      operation_id: 'resolved',
      decision: 'Owner merge',
      files: [{ ...change, before: 'stale manual' }],
    },
    runs,
    f.cards,
  );
  expect(next.projection?.result.status).toBe('pending');
  expect(await readFile(resolve(f.root, 'pointer.md'), 'utf8')).toBe('manual');
});

it('requires every bootstrap rule for a standalone run and only explicit rules for a role', async () => {
  f.connection.rules.push('source.txt');
  await f.file('connection.json', JSON.stringify(f.connection));
  const initial = startLocalRun(f.spec, 1);
  await expect(f.inputs.verify(initial)).rejects.toThrow('required-rule-not-loaded');
  const role = startLocalRun(
    {
      ...f.spec,
      parent_run_id: 'parent',
      role: 'explorer',
      requested: { ...f.spec.requested, permissions: ['read'] },
      effective: { ...f.spec.requested, permissions: ['read'] },
    },
    1,
  );
  await f.inputs.verify(role);
});

it('projects an explicit whole-task cancellation without resuming work, preserving IDs, unfinished scope and indices', async () => {
  const { run, runs } = await boot();
  await expect(projectLocalCard('cancelled', 'early', runs, f.cards, f.inputs)).rejects.toThrow(
    'cancellation-required',
  );
  const cancelled = await advanceLocalWorkflow(
    event(run, {
      type: 'CANCEL',
      reason: 'owner cancelled whole task',
      unfinished: ['acceptance'],
      stopped_receipt: 'no fixture writers',
    }),
    runs,
    f.inputs,
  );
  await expect(
    projectLocalCard('completed', 'false-done', runs, f.cards, f.inputs),
  ).rejects.toThrow('action-forbidden');
  const denied = {
    ...cancelled,
    spec: {
      ...cancelled.spec,
      requested: { ...cancelled.spec.requested, permissions: ['read'] as const },
    },
  };
  await expect(
    projectLocalCard(
      'cancelled',
      'denied',
      { read: async () => denied as unknown as LocalRun, save: runs.save.bind(runs) },
      f.cards,
      f.inputs,
    ),
  ).rejects.toThrow('cancellation-projection-forbidden');
  const plans = { ...f.connection.plans };
  delete plans.cancelled;
  const legacyCards = new FileProjectCards(
    f.root,
    { ...f.connection, plans },
    resolve(f.root, '.legacy-journal'),
  );
  await expect(legacyCards.prepare(f.card, 'cancelled', 'legacy')).rejects.toThrow(
    'missing-cancelled-plan-root',
  );
  const next = await projectLocalCard('cancelled', 'cancel-projection', runs, f.cards, f.inputs);
  expect(next.status).toBe('cancelled');
  expect(next.cancellation).toEqual(cancelled.cancellation);
  expect(next.spec.identity).toMatchObject({
    task_id: 'task',
    card: { locator: `${f.connection.plans.cancelled}/task.md` },
  });
  expect((await f.cards.read(`${f.connection.plans.cancelled}/task.md`)).status).toBe('cancelled');
  expect(
    await readFile(resolve(f.root, f.connection.plans.active, 'README.md'), 'utf8'),
  ).not.toContain('[Task]');
  expect(
    await readFile(resolve(f.root, f.connection.plans.cancelled!, 'README.md'), 'utf8'),
  ).toContain('[Task]');
  await expect(
    advanceLocalWorkflow(event(next, { type: 'READY' }), runs, f.inputs),
  ).rejects.toThrow('run-cancelled');
});
