import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  previewWorkflowUpgrade,
  applyWorkflowUpgrade,
} from '../adapters/storage/workflowUpgrade.js';
import { validateCheckpoint } from '../adapters/storage/workflowValidation.js';
import { createExecution } from '../core/execution.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { workflowFixture } from './workflowFixtures.js';
import { fixture, grant } from './storageFixtures.js';
import type { Json, TechnicalState, StoreReply } from '../core/evidence.js';
import type { WorkflowUpgrade } from '../adapters/storage/workflowUpgrade.js';
let f: Awaited<ReturnType<typeof workflowFixture>>,
  db: ReturnType<typeof fixture>,
  source: TechnicalState,
  plan: WorkflowUpgrade;
const ref = async (name: string) => {
  const locator = resolve(f.root, name);
  return { locator, hash: contentHash(await readFile(locator, 'utf8')) };
};
const backup = async (p = plan) => {
  await f.file('upgrade.json', JSON.stringify(p));
  return ref('upgrade.json');
};
beforeEach(async () => {
  f = await workflowFixture();
  db = fixture();
  db.claim();
  const execution = {
    ...createExecution(
      'task',
      1,
      f.target,
      [{ id: 'check', kind: 'check', applicable: true, reason: 'required' }],
      false,
      'substantial',
    ),
    schema_version: 1,
    unknown: 'preserve',
  };
  db.mutate(
    {
      type: 'checkpoint',
      state: {
        local_run: f.executor,
        workflow: { schema_version: 1, revision: 0, execution, readings: {} },
        pending_human: ['choice'],
      } as unknown as Json,
      effects: [],
    },
    1,
  );
  const reply = db.execute({ type: 'state' });
  if (!reply.ok) throw Error('fixture');
  source = reply.value as TechnicalState;
  await f.file(
    'stopped.json',
    JSON.stringify({
      kind: 'workflow-writers-stopped',
      project_id: 'project',
      task_id: 'task',
      run_id: 'run',
      remaining: 0,
    }),
  );
  plan = previewWorkflowUpgrade(grant.context, source, await ref('stopped.json'));
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});
const store = () => ({
  execute: async (request: Parameters<typeof db.store.execute>[0]) => db.store.execute(request),
});
it('previews without writes, upgrades the actual Store and restores exact legacy state from a verified backup', async () => {
  const original = structuredClone(source),
    proof = await backup();
  expect(source).toEqual(original);
  expect(() => validateCheckpoint((source.checkpoint as { workflow: Json }).workflow)).toThrow(
    'unsupported-execution',
  );
  await applyWorkflowUpgrade(plan, store(), 'upgrade', 'upgrade', proof);
  const after = db.execute({ type: 'state' });
  expect(after.ok && after.value).toMatchObject({
    checkpoint: {
      workflow: { execution: { schema_version: 2, unknown: 'preserve' } },
      pending_human: ['choice'],
    },
  });
  validateCheckpoint((plan.target as { workflow: Json }).workflow);
  await applyWorkflowUpgrade(plan, store(), 'rollback', 'rollback', proof);
  const restored = db.execute({ type: 'state' });
  expect(restored.ok && (restored.value as TechnicalState).checkpoint).toEqual(original.checkpoint);
  expect(() => validateCheckpoint((original.checkpoint as { workflow: Json }).workflow)).toThrow(
    'unsupported-execution',
  );
});
it('rejects unknown legacy shape, altered ownership and identities before writing', async () => {
  const stop = await ref('stopped.json');
  for (const stopped of [
    { ...stop, locator: '' },
    { ...stop, hash: 'invalid' },
  ])
    expect(() => previewWorkflowUpgrade(grant.context, source, stopped)).toThrow('stop-required');
  for (const patch of [{ released: true }, { frozen: true }, { owner: 'other' }])
    expect(() => previewWorkflowUpgrade(grant.context, { ...source, ...patch }, stop)).toThrow(
      'owner-mismatch',
    );
  const checkpoint = source.checkpoint as {
    workflow: { schema_version: number; execution: Record<string, Json> };
  };
  expect(() =>
    previewWorkflowUpgrade(
      grant.context,
      {
        ...source,
        checkpoint: { ...checkpoint, workflow: { ...checkpoint.workflow, schema_version: 9 } },
      },
      stop,
    ),
  ).toThrow('unsupported-upgrade');
  for (const patch of [
    { schema_version: 9 },
    { supervision: {} },
    { task_id: 'other' },
    { generation: 2 },
  ]) {
    const changed = {
      ...source,
      checkpoint: {
        ...checkpoint,
        workflow: {
          ...checkpoint.workflow,
          execution: { ...checkpoint.workflow.execution, ...patch },
        },
      },
    } as TechnicalState;
    expect(() => previewWorkflowUpgrade(grant.context, changed, stop)).toThrow();
  }
});
it('checks the complete plan, saved backup and stop receipt before granting mutation', async () => {
  const proof = await backup();
  await expect(
    applyWorkflowUpgrade({ ...plan, schema_version: 9 as 1 }, store(), 'x', 'upgrade', proof),
  ).rejects.toThrow('unsupported-upgrade-plan');
  await expect(
    applyWorkflowUpgrade({ ...plan, target: null }, store(), 'x', 'upgrade', proof),
  ).rejects.toThrow('plan-changed');
  await expect(
    applyWorkflowUpgrade(plan, store(), 'x', 'upgrade', { ...proof, hash: 'wrong' }),
  ).rejects.toThrow('proof-changed');
  await f.file('upgrade.json', '{}');
  await expect(
    applyWorkflowUpgrade(plan, store(), 'x', 'upgrade', await ref('upgrade.json')),
  ).rejects.toThrow('backup-mismatch');
  const stop = JSON.parse(await readFile(plan.stopped_writers_receipt.locator, 'utf8')) as Record<
    string,
    unknown
  >;
  for (const patch of [
    { kind: 'wrong' },
    { project_id: 'wrong' },
    { task_id: 'wrong' },
    { run_id: 'wrong' },
    { remaining: 1 },
  ]) {
    await f.file('stopped.json', JSON.stringify({ ...stop, ...patch }));
    const changed = { ...plan, stopped_writers_receipt: await ref('stopped.json') };
    await expect(
      applyWorkflowUpgrade(changed, store(), 'x', 'upgrade', await backup(changed)),
    ).rejects.toThrow('writers-unconfirmed');
  }
  const unchanged = db.execute({ type: 'state' });
  expect(unchanged.ok && unchanged.value).toEqual(source);
});
it('blocks stale revision/checkpoint or owner and keeps unknown mutation results recoverable by operation ID', async () => {
  const proof = await backup();
  for (const patch of [
    { generation: 2 },
    { owner: 'other' },
    { released: true },
    { frozen: true },
    { revision: source.revision + 1 },
    { checkpoint: { changed: true } },
  ]) {
    const altered = {
      execute: async (): Promise<StoreReply> => ({ ok: true, value: { ...source, ...patch } }),
    };
    await expect(applyWorkflowUpgrade(plan, altered, 'x', 'upgrade', proof)).rejects.toThrow();
  }
  const unknown: StoreReply = {
    ok: false,
    error: {
      code: 'unknown-outcome',
      operation_id: 'upgrade-unknown',
      observed_revision: null,
      retryable: true,
      recovery_locator: db.root,
    },
  };
  await expect(
    applyWorkflowUpgrade(
      plan,
      {
        execute: async (request) => {
          const result = db.store.execute(request);
          return request.command.type === 'mutate' ? unknown : result;
        },
      },
      'upgrade-unknown',
      'upgrade',
      proof,
    ),
  ).rejects.toThrow('unavailable');
  expect(db.execute({ type: 'operation', operation_id: 'upgrade-unknown' })).toMatchObject({
    ok: true,
    value: { status: 'confirmed' },
  });
  await expect(
    applyWorkflowUpgrade(plan, store(), 'blind-retry', 'upgrade', proof),
  ).rejects.toThrow('input-changed');
  await applyWorkflowUpgrade(plan, store(), 'rollback-confirmed', 'rollback', proof);
});
