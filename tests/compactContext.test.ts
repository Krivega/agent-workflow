import { compactFixture } from './compactFixtures.js';
import { normativeRules } from '../core/compactContext.js';
import { compactProof } from '../adapters/project/compactContext.js';
import {
  confirmLoad,
  confirmCompactProof,
  localRunVersionSupported,
  startLocalRun,
  applyLocalEvent,
} from '../core/localRun.js';
import type { LocalImplementationPlan } from '../core/localRun.js';
import { event } from './localFixtures.js';
import { createExecution } from '../core/execution.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { fileConnectionReader } from '../adapters/project/fileConnectionReader.js';
import { fileRunInputs } from '../adapters/project/fileRunInputs.js';
import { parseConnection } from '../core/connection.js';
import { coderFixture } from './coderFixtures.js';
import { reserveCoder, assertCoderParent } from '../core/coder.js';

let f: Awaited<ReturnType<typeof compactFixture>>;
beforeEach(async () => {
  f = await compactFixture();
});
afterEach(async () => {
  await f.dispose();
});

it('assembles exact normative text and fresh task facts without converting a full LOAD', () => {
  const packet = f.build();
  expect(packet.procedures.map((entry) => entry.source.id)).toEqual([
    'bootstrap',
    'task',
    'evidence',
  ]);
  for (const entry of packet.procedures)
    for (const rule of entry.rules)
      expect(
        f.loaded.procedures.find((procedure) => procedure.id === entry.source.id)!.content,
      ).toContain(rule.content);
  const proof = compactProof(packet);
  expect(() => confirmCompactProof(f.run, proof, proof.procedures)).not.toThrow();
  const receipt = {
    run_id: f.run.spec.run_id,
    session_id: f.run.spec.session_id,
    procedures: proof.procedures,
    rules: f.run.spec.rules,
    observed_read: 'primary receipt',
    compact: proof,
  };
  expect(() => confirmLoad(f.run, receipt)).not.toThrow();
  expect(() => confirmLoad(f.executor, receipt)).toThrow('compact-context-disabled');
  expect(() => confirmLoad(f.run, { ...receipt, compact_fallback: 'stale source' })).toThrow(
    'compact-fallback-is-not-compact-load',
  );
  const { compact: _compact, ...full } = receipt;
  expect(() => confirmLoad(f.run, { ...full, compact_fallback: 'stale source' })).not.toThrow();
  expect(localRunVersionSupported(f.run)).toBe(true);
  expect(localRunVersionSupported({ ...f.run, schema_version: 1 })).toBe(false);
  expect(localRunVersionSupported({ ...f.executor, loaded: receipt })).toBe(false);
});

it('keeps a legacy full receipt readable without adopting compact metadata', async () => {
  const procedures = f.executor.spec.procedures.map(
    ({ fragments: _fragments, ...source }) => source,
  );
  expect(parseConnection({ ...f.connection, procedures }).procedures).toEqual(procedures);
  const legacy = { ...f.executor, spec: { ...f.executor.spec, procedures } };
  const inputs = fileRunInputs(f.root, 'connection.json');
  await expect(inputs.verify(legacy)).resolves.toBeUndefined();
  const receipt = {
    run_id: legacy.spec.run_id,
    session_id: legacy.spec.session_id,
    procedures,
    rules: legacy.spec.rules,
    observed_read: 'legacy full observed read',
  };
  expect(() => confirmLoad(f.executor, receipt)).not.toThrow();
  expect(receipt).not.toHaveProperty('compact');
  f.run.spec.procedures[0]!.fragments = [];
  await expect(inputs.verify(f.run)).rejects.toThrow('procedure-version-mismatch');
});

it('retains local planning admission and its risk checks in the v3 format', () => {
  const plan: LocalImplementationPlan = {
    schema_version: 1,
    requirement: f.proof,
    basis: [f.proof],
    owner: f.proof,
    paths: ['source.txt'],
    consumers: [f.proof],
    consumers_complete: true,
    reason: 'accepted local scope',
    checks: ['validate'],
    criterion: 'local result',
    risks: {
      new_behavior: false,
      new_contract: false,
      architecture: false,
      storage: false,
      authority: false,
      security: false,
      data_integrity: false,
      unknown_consumers: false,
    },
  };
  f.run.spec.route = { kind: 'local', accepted_plan: f.proof, plan };
  const run = startLocalRun(f.run.spec, 1);
  const compact = compactProof(f.build());
  const loaded = applyLocalEvent(
    run,
    event(run, {
      type: 'LOAD',
      receipt: {
        run_id: run.spec.run_id,
        session_id: run.spec.session_id,
        procedures: compact.procedures,
        rules: run.spec.rules,
        observed_read: 'native fixture',
        compact,
      },
    }),
  );
  expect(applyLocalEvent(loaded, event(loaded, { type: 'READY' })).status).toBe('ready');
  expect(f.build().admission).toEqual({ route: 'local', accepted: f.proof });
  const damaged = structuredClone(loaded);
  if (damaged.spec.route.kind !== 'local') throw new Error('fixture route');
  Reflect.set(damaged.spec.route.plan.risks, 'unknown_consumers', true);
  expect(() => applyLocalEvent(damaged, event(damaged, { type: 'READY' }))).toThrow(
    'local-needs-council-planning',
  );
});

it('includes original FAIL, blockers, decisions, pending operations and bounded child identity', () => {
  const execution = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'full check' }],
    true,
    'substantial',
  );
  const council = f.council('planning');
  council.history[0]!.answer.verdict = 'FAIL';
  council.advisers.architect!.answer!.verdict = 'FAIL';
  execution.planning = council;
  execution.acceptance = f.council('acceptance');
  execution.checks = [
    {
      id: 'validate',
      verdict: 'FAIL',
      reason: 'regression',
      evidence: f.proof,
      inputs: f.target.inputs,
    },
  ];
  execution.findings = [
    {
      id: 'F1',
      scope: 'workflow',
      condition: 'repair',
      reason: 'failure',
      blocking: true,
      sources: [f.proof],
      owner: 'architect',
      original_fail: f.proof,
      rounds: [],
      resolution: null,
    },
  ];
  f.context.workflow.execution = execution;
  f.context.messages!.question = { id: 'q', action: 'implement', revision: 1 };
  f.context.messages!.decisions = [
    { question_id: 'old', action: 'read', revision: 0, accepted: true, source: f.proof },
  ];
  f.effects.push({
    id: 'send-unknown',
    intent: { secret: 'must not be printed' },
    outcome: 'unknown',
    receipt: null,
  });
  for (const outcome of ['pending', 'confirmed', 'not-started'] as const)
    f.effects.push({ id: outcome, intent: {}, outcome, receipt: null });
  const packet = f.build();
  expect(JSON.stringify(packet)).not.toContain('must not be printed');
  expect(packet.state).toMatchObject({
    question: { id: 'q' },
    decisions: [{ accepted: true }],
    pending_operations: [
      { id: 'send-unknown', outcome: 'unknown' },
      { id: 'pending', outcome: 'pending' },
    ],
    execution: {
      checks: [{ verdict: 'FAIL' }],
      findings: [{ original_fail: f.proof }],
      councils: [{ failures: [{ verdict: 'FAIL' }] }, { failures: [] }],
    },
  });
  const before = compactProof(packet);
  f.context.messages!.requirements_revision++;
  expect(compactProof(f.build()).state_hash).not.toBe(before.state_hash);
  f.ownership.frozen = true;
  f.ownership.released = true;
  f.ownership.lease_until = 0;
  expect(f.build().state).toMatchObject({
    constraints: { frozen: true, released: true, lease_expired: true },
  });
});

it('preserves accepted child evidence, fixture provenance, live child scope and an unknown effective profile', async () => {
  const childFixture = await coderFixture();
  try {
    const brief = await childFixture.brief();
    expect(() => assertCoderParent(f.run, brief)).toThrow('compact-coder-not-supported');
    const child = reserveCoder(
      childFixture.executor,
      brief,
      await childFixture.workspaces.capture(brief),
      [],
    );
    f.context.workflow.coders = { [brief.id]: child };
    expect(f.build().state).toMatchObject({
      children: [{ id: brief.id, source_root: brief.source_root, session: null }],
    });
    child.session = await childFixture.session(child);
    f.context.workflow.execution = childFixture.execution;
    const execution = f.context.workflow.execution;
    execution.baseline = {
      kind: 'fixture',
      scenario: 'explicit double',
      evidence: f.proof,
      inputs: f.target.inputs,
      elapsed_ms: 1,
      exit_code: 0,
    };
    execution.child_results = [
      {
        scope: 'child',
        criterion: 'accepted',
        evidence: f.proof,
        inputs: f.target.inputs,
        valid: true,
      },
    ];
    execution.coder_reservations = [brief.id];
    execution.result = {
      scope: 'workflow',
      target: f.target,
      evidence: [f.proof],
      child_results: execution.child_results,
      limitations: ['fixture'],
      summary: 'accepted scope',
    };
    f.run.spec.effective = null;
    const packet = f.build();
    expect(packet.profile.effective).toBeNull();
    expect(packet.state).toMatchObject({
      children: [{ session: child.session.id }],
      execution: {
        baseline: { kind: 'fixture' },
        child_results: [{ evidence: f.proof, valid: true }],
        result: { summary: 'accepted scope' },
      },
    });
    for (const route of [
      { kind: 'mechanical' as const, accepted_material: f.proof, semantic_delta: false },
      { kind: 'delegated' as const, authority: f.proof },
      { kind: 'nonproduct' as const },
    ]) {
      f.run.spec.route = route;
      expect(f.build().admission).toEqual({
        route: route.kind,
        accepted: route.kind === 'nonproduct' ? null : f.proof,
      });
    }
  } finally {
    await childFixture.dispose();
  }
});

it.each([
  { owner: 'other' },
  { generation: 2 },
  { role: 'auditor' },
  { identity: { assignment_id: 'other' } },
  { schema_version: 2 },
  { rule_ids: [] },
  { procedures: [] },
  { payload_hash: 'wrong' },
  { marker: '' },
])('refuses a forged or incomplete compact proof %j', (patch) => {
  const proof = compactProof(f.build());
  expect(() =>
    confirmCompactProof(f.run, { ...proof, ...patch } as typeof proof, proof.procedures),
  ).toThrow();
});

it('refuses dropped prohibitions, extra/nested/malformed IDs and stale procedure bytes', async () => {
  const source = f.loaded.procedures[0]!;
  const { content, ...procedure } = source;
  for (const patch of [
    undefined,
    [],
    ['bootstrap.missing'],
    [...procedure.fragments!, ...procedure.fragments!],
  ]) {
    expect(() =>
      normativeRules(
        {
          ...procedure,
          ...(patch === undefined ? { fragments: undefined } : { fragments: patch }),
        } as typeof procedure,
        content,
      ),
    ).toThrow();
  }
  for (const text of [
    '<!-- /aw-rule -->',
    '<!-- aw-rule bootstrap.01 -->',
    '<!-- aw-rule bootstrap.01 --><!-- aw-rule bootstrap.02 -->',
  ])
    expect(() => normativeRules(procedure, text)).toThrow();
  expect(() =>
    normativeRules(
      { ...procedure, fragments: ['bootstrap.01'] },
      '<!-- aw-rule bootstrap.01 --> <!-- /aw-rule -->',
    ),
  ).toThrow('missing-text');
  source.content += '\nchanged';
  expect(() => f.build()).toThrow('compact-procedure-stale');
  source.content = content;
  f.ownership.owner = 'other';
  expect(() => f.build()).toThrow('compact-context-owner-mismatch');
  f.ownership.owner = f.run.spec.session_id;
  f.context.coordination_bound = true;
  expect(() => f.build()).toThrow('compact-coordination-not-supported');
  f.context.coordination_bound = false;
  f.context.control = null;
  expect(() => f.build()).toThrow('compact-context-incomplete');
  const changed: typeof f.connection = {
    ...f.connection,
    procedures: f.connection.procedures.map((p) => ({ ...p, fragments: ['wrong-prefix'] })),
  };
  expect(() => parseConnection(changed)).toThrow('invalid-procedure-fragments');
  expect(() =>
    parseConnection({
      ...f.connection,
      procedures: f.connection.procedures.map((procedure) => ({
        ...procedure,
        fragments: [`${procedure.id}.01`, `${procedure.id}.01`],
      })),
    }),
  ).toThrow('invalid-procedure-fragments');
  await f.file(procedure.locator, content.replace('<!-- aw-rule bootstrap.01 -->', ''));
  changed.procedures = f.connection.procedures.map((p) =>
    p.id === procedure.id
      ? { ...p, hash: contentHash(content.replace('<!-- aw-rule bootstrap.01 -->', '')) }
      : p,
  );
  await f.file('broken.json', JSON.stringify(changed));
  const full = await fileConnectionReader.load(f.root, 'broken.json');
  expect(() => normativeRules(full.procedures[0]!, full.procedures[0]!.content)).toThrow(
    'compact-rule-unopened',
  );
});

it('never enables compact mode for unsupported roles, legacy schemas or unknown modes', () => {
  for (const patch of [
    { context_loading: 'unknown' },
    { coordinator: true },
    { procedure_loading: undefined },
    { role: 'auditor' },
    { parent_run_id: 'parent' },
  ])
    expect(() => startLocalRun({ ...f.run.spec, ...patch } as typeof f.run.spec, 1)).toThrow(
      'unsupported-context-loading',
    );
  expect(localRunVersionSupported({ ...f.run, format: 'coder' })).toBe(false);
  expect(localRunVersionSupported({ ...f.run, coder_locks: [] })).toBe(false);
});

it('refuses coder delegation before changing the compact parent format', () => {
  const before = structuredClone(f.run);
  expect(() => applyLocalEvent(f.run, event(f.run, { type: 'CODER_LOCKS', locks: [] }))).toThrow(
    'compact-coder-not-supported',
  );
  expect(f.run).toEqual(before);
  expect(localRunVersionSupported(f.run)).toBe(true);
});
