import { createFinalization, applyFinalization, replayFinalization } from '../core/finalization.js';
import type {
  FinalizationSeed,
  FinalizationAction,
  FinalizationState,
} from '../core/finalization.js';
import { finalizationFixture } from './finalizationFixtures.js';
let f: Awaited<ReturnType<typeof finalizationFixture>>;
beforeEach(async () => {
  f = await finalizationFixture();
});
afterEach(async () => {
  await f.dispose();
});
const apply = (s: FinalizationState, a: FinalizationAction, seed = f.seed) =>
  applyFinalization(seed, s, { ...a, id: 'event-' + s.revision, revision: s.revision });
it('requires current task, exact loaded procedures, selected evidence and explicit positive grace', () => {
  const mutate = (fn: (s: FinalizationSeed) => void, reason: string) => {
    const s = structuredClone(f.seed);
    fn(s);
    expect(() => createFinalization(s)).toThrow(reason);
  };
  mutate((s) => {
    s.schema_version = 2 as 1;
  }, 'unsupported');
  mutate((s) => {
    s.id = '';
  }, 'missing-text');
  mutate((s) => {
    s.run.status = 'cancelled';
  }, 'task-required');
  mutate((s) => {
    s.run.spec.identity = { assignment_id: 'cardless' };
  }, 'task-required');
  mutate((s) => {
    s.run.loaded = null;
  }, 'load-required');
  for (const id of ['finalization', 'evidence'])
    mutate((s) => {
      s.run.spec.procedures = s.run.spec.procedures.filter((p) => p.id !== id);
      s.run.loaded!.procedures = s.run.spec.procedures;
    }, 'procedure-required');
  for (const version of ['1', '5', 'unknown'])
    mutate((s) => {
      s.run.spec.procedures = s.run.spec.procedures.map((p) =>
        p.id === 'evidence' ? { ...p, version } : p,
      );
      s.run.loaded!.procedures = s.run.spec.procedures;
    }, 'procedure-required');
  for (const entries of [
    [],
    [{ id: '', revision: 1 }],
    [{ id: 'a', revision: 0.5 }],
    [{ id: 'a', revision: 0 }],
  ])
    mutate((s) => {
      s.significant = entries;
    }, 'significant');
  for (const grace of [0, 0.5])
    mutate((s) => {
      if (s.policy.mode === 'test-cleanup') s.policy.grace_ms = grace;
    }, 'grace-required');
  expect(createFinalization({ ...f.seed, policy: { mode: 'retain' } }).phase).toBe('started');
  for (const version of ['2', '3', '4']) {
    const previous = structuredClone(f.seed);
    previous.run.spec.procedures = previous.run.spec.procedures.map((p) =>
      p.id === 'evidence' ? { ...p, version } : p,
    );
    previous.run.loaded!.procedures = previous.run.spec.procedures;
    expect(createFinalization(previous).phase).toBe('started');
  }
});
it('preserves catalogue/history, deduplicates events and rejects conflicting replay and stale revision', async () => {
  await f.archived();
  const log = await f.log(),
    state = replayFinalization(log),
    last = log.events.at(-1)!;
  expect(applyFinalization(f.seed, state, last)).toBe(state);
  expect(() => applyFinalization(f.seed, state, { ...last, revision: 9 })).toThrow(
    'event-conflict',
  );
  expect(() =>
    applyFinalization(f.seed, state, { type: 'CANCEL', reason: 'cancel', id: 'new', revision: 0 }),
  ).toThrow('revision-conflict');
  expect(() => apply(state, { type: 'CANCEL', reason: 'cancel' })).toThrow('transition');
  expect(() => replayFinalization({ ...log, schema_version: 9 as 1 })).toThrow('unsupported');
  expect(state.manifest!.entries[0]).toMatchObject({ id: 'original-fail', result: 'FAIL' });
  expect(apply(createFinalization(f.seed), { type: 'CANCEL', reason: 'explicit' }).phase).toBe(
    'cancelled',
  );
});
it('rejects incomplete or wrong frozen catalog and unreconciled effects', async () => {
  const manifest = await f.archive.freeze(f.seed),
    state = createFinalization(f.seed);
  const variants = [
    { ...manifest, schema_version: 'future' },
    { ...manifest, state: { ...manifest.state, frozen: false } },
    { ...manifest, context: { ...manifest.context, project_id: 'other' } },
    { ...manifest, context: { ...manifest.context, task_id: 'other' } },
  ];
  for (const m of variants)
    expect(() => apply(state, { type: 'CATALOG', manifest: m })).toThrow('catalog-mismatch');
  expect(() =>
    apply(
      state,
      { type: 'CATALOG', manifest },
      {
        ...f.seed,
        run: { ...f.seed.run, spec: { ...f.seed.run.spec, identity: { assignment_id: 'a' } } },
      },
    ),
  ).toThrow('catalog-mismatch');
  for (const outcome of ['pending', 'unknown'] as const)
    expect(() =>
      apply(state, {
        type: 'CATALOG',
        manifest: {
          ...manifest,
          effects: [{ id: 'pending', intent: null, outcome, receipt: null }],
        },
      }),
    ).toThrow('unreconciled');
  const reconciled = {
    ...manifest,
    effects: ['confirmed', 'not-started'].map((outcome) => ({
      id: outcome,
      intent: null,
      outcome: outcome as 'confirmed' | 'not-started',
      receipt: null,
    })),
  };
  expect(apply(state, { type: 'CATALOG', manifest: reconciled }).phase).toBe('catalogued');
  for (const selected of [
    { id: 'missing', revision: 1 },
    { id: 'original-fail', revision: 2 },
  ])
    expect(() =>
      apply(state, { type: 'CATALOG', manifest }, { ...f.seed, significant: [selected] }),
    ).toThrow('missing-significant');
});
it('requires matching copies and archive time, operator, policy authority and elapsed grace', async () => {
  const manifest = await f.start(),
    state = await f.current(),
    exported = await f.archive.export(manifest);
  for (const patch of [
    { revision: 0 },
    { project_id: 'other' },
    { task_id: 'other' },
    { blobs: [] },
  ])
    expect(() =>
      apply(state, { type: 'EXPORT', ...exported, receipt: { ...exported.receipt, ...patch } }),
    ).toThrow('export-catalog');
  await f.send({ type: 'EXPORT', ...exported });
  const es = await f.current();
  expect(() =>
    apply(es, { type: 'RESTORE', ...exported, receipt: { ...exported.receipt, revision: 0 } }),
  ).toThrow('restore-export');
  await f.send({ type: 'RESTORE', ...(await f.archive.restore(manifest)) });
  const rs = await f.current();
  for (const at of [-1, 0.5])
    expect(() => apply(rs, { type: 'ARCHIVE', authority: f.proof, proof: f.proof, at })).toThrow(
      'archive-time',
    );
  await f.send({
    type: 'ARCHIVE',
    authority: f.proof,
    ...(await f.archive.archive(f.seed, rs, f.proof)),
  });
  const as = await f.current(),
    action = {
      type: 'RESERVE_CLEANUP' as const,
      operator: 'tester',
      authority: f.seed.policy.mode === 'test-cleanup' ? f.seed.policy.authority : f.proof,
      now: 110,
    };
  expect(() => apply(as, action, { ...f.seed, policy: { mode: 'retain' } })).toThrow('retention');
  for (const patch of [{ operator: 'other' }, { authority: f.proof }])
    expect(() => apply(as, { ...action, ...patch })).toThrow('authority');
  for (const now of [109, 110.5]) expect(() => apply(as, { ...action, now })).toThrow('grace');
  expect(apply(as, action).phase).toBe('cleanup-reserved');
});

it('requires the finalization procedure in the actual scoped LOAD before freezing evidence', () => {
  f.seed.run.spec.procedure_loading = 'by-action';
  const full = f.seed.run.loaded!;
  f.seed.run.loaded = {
    ...full,
    procedures: full.procedures.filter((p) => ['bootstrap', 'task', 'evidence'].includes(p.id)),
  };
  expect(() => createFinalization(f.seed)).toThrow('procedure-not-loaded:finalization');
  f.seed.run.loaded.procedures.push(full.procedures.find((p) => p.id === 'finalization')!);
  expect(createFinalization(f.seed).phase).toBe('started');
});
