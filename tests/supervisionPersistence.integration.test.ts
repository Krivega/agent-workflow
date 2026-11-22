import type { EvidenceStore } from '../ports/evidenceStore.js';
import { resolve } from 'node:path';
import { beginExecution, advanceExecution } from '../application/executionWorkflow.js';
import { collectInputRefs } from '../core/inputRefs.js';
import { FileAuditCards } from '../adapters/project/fileAuditCards.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { validateExecution } from '../adapters/storage/workflowValidation.js';
import { applyExecution, createExecution, executionBlockers } from '../core/execution.js';
import { recordFinding, recordRoundVerdict } from '../core/findings.js';
import type { IndependentRole, SupervisionAction } from '../core/supervision.js';
import { supervisionEvidence } from '../core/supervision.js';
import { createTiming } from '../core/stageTiming.js';
import { fixture, grant } from './storageFixtures.js';
import { workflowFixture, executionEvent } from './workflowFixtures.js';
import type { Json, TechnicalState } from '../core/evidence.js';
import { connectCardMarkdown } from '../adapters/project/cardMarkdown.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
let db: ReturnType<typeof fixture>;
let journal: TaskWorkflowJournal;
let cards: FileAuditCards;
beforeEach(async () => {
  f = await workflowFixture();
  db = fixture();
  db.claim();
  db.mutate(
    { type: 'checkpoint', state: { local_run: f.executor as unknown as Json }, effects: [] },
    1,
  );
  journal = new TaskWorkflowJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
  );
  cards = new FileAuditCards(f.root, f.connection, resolve(f.root, 'audit-journal'));
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});
function role(kind: 'arbiter' | 'auditor'): IndependentRole {
  const run = structuredClone(f.adviser);
  run.spec.role = kind;
  run.spec.session_id = kind;
  run.loaded!.session_id = kind;
  return {
    run,
    agent_type: kind,
    type_receipt: f.proof,
    session: {
      id: kind,
      agent_role: kind,
      model: run.spec.requested.model,
      effort: run.spec.requested.effort,
      workspace: run.spec.workspace,
      project_id: run.spec.project_id,
      read_only: true,
      network: false,
      forked_from: null,
      initial_turns: 0,
      receipt: f.proof,
    },
  };
}
const data = () => ({
  goal: 'Audit exact assignment',
  criteria: ['mandatory checks remain'],
  completed: [f.proof],
  open_findings: [],
  timing: createTiming('stage', 60, 'cp'),
  next_action: 'Run required validation',
});
const execution = () =>
  createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
    true,
    'substantial',
  );

it('persists reconsideration and prior dissent, verifies its evidence and repeats the human gate', async () => {
  let run = execution();
  run.findings = recordFinding(
    [],
    {
      id: 'F1',
      scope: 'workflow',
      blocking: true,
      waivable: true,
      reason: 'dispute',
      condition: 'working contract',
      sources: [f.proof],
    },
    'architect',
    f.proof,
  );
  await beginExecution(run, journal);
  const advance = async (action: SupervisionAction) => {
    run = await advanceExecution(
      executionEvent(run, { type: 'SUPERVISE', action }),
      journal,
      f.inputs,
      { inspect: async () => role('arbiter').session },
    );
  };
  await advance({
    kind: 'arbitrate',
    id: 'A',
    finding: 'F1',
    role: role('arbiter'),
    trigger: { kind: 'initial-contradiction', reviewer: 'architect', confirmation: f.proof },
  });
  // Existing schema-2 checkpoints without attempt history remain readable.
  expect(run.supervision!.arbitrations[0]!.attempts).toBeUndefined();
  validateExecution(run);
  const decision = {
    outcome: 'undecided' as const,
    reason: 'needs evidence',
    exception: '',
    residual_risk: '',
    dissent: ['owner FAIL'],
    evidence: f.proof,
  };
  await advance({ kind: 'decision', id: 'A', session: 'arbiter', decision });
  await f.file('new-evidence.txt', 'new explanation');
  const evidence = await f.ref('new-evidence.txt');
  const reconsider = {
    kind: 'reconsider' as const,
    id: 'A',
    condition: 'working contract',
    evidence,
  };
  await expect(
    advance({ ...reconsider, evidence: { ...evidence, hash: 'stale' } }),
  ).rejects.toThrow();
  await advance(reconsider);
  run = (
    await new TaskWorkflowJournal(
      { execute: async (r) => db.store.execute(r) },
      grant.context,
      1,
    ).read()
  ).execution!;
  expect(run.supervision!.arbitrations[0]).toMatchObject({
    status: 'waiting',
    decision: null,
    original_fail: f.proof,
    attempts: [{ decision, evidence }],
  });
  expect(supervisionEvidence(run.supervision!)).toContainEqual(evidence);
  expect(executionBlockers(run)).toContain('arbitration:A');
  await advance({
    kind: 'decision',
    id: 'A',
    session: 'arbiter',
    decision: {
      ...decision,
      outcome: 'compromise',
      exception: 'bounded',
      residual_risk: 'recorded',
    },
  });
  await advance({ kind: 'human', id: 'A', accepted: false, evidence: f.proof });
  await advance(reconsider);
  await advance({
    kind: 'decision',
    id: 'A',
    session: 'arbiter',
    decision: {
      ...decision,
      outcome: 'compromise',
      exception: 'new boundary',
      residual_risk: 'recorded',
    },
  });
  expect(run.supervision!.arbitrations[0]!.status).toBe('human');
  expect(run.supervision!.arbitrations[0]!.attempts).toHaveLength(2);
  await advance({ kind: 'human', id: 'A', accepted: true, evidence: f.proof });
  const proof = {
    target: f.target,
    implementation: f.proof,
    review: { reviewer: 'architect' as const, verdict: 'FAIL' as const, evidence: f.proof },
    condition: 'working contract',
    working_check: f.proof,
    check_verdict: 'PASS' as const,
    mandatory_defect: false,
  };
  await advance({ kind: 'review', id: 'A', proof });
  await advance(reconsider);
  await advance({
    kind: 'decision',
    id: 'A',
    session: 'arbiter',
    decision: { ...decision, outcome: 'direction' },
  });
  await advance({
    kind: 'review',
    id: 'A',
    proof: { ...proof, review: { ...proof.review, verdict: 'PASS' } },
  });
  validateExecution(run);
  expect(run.supervision!.arbitrations[0]!.status).toBe('resolved');
  expect(supervisionEvidence(run.supervision!)).toContainEqual(f.proof);
  expect(executionBlockers(run)).toContain('validate:not-passed');
  expect((await journal.read()).execution).toEqual(run);
  for (const attempts of ['', {}, null, [null]]) {
    const invalid = structuredClone(run);
    Object.assign(invalid.supervision!.arbitrations[0]!, { attempts });
    expect(() => validateExecution(invalid)).toThrow();
  }
  for (const patch of [
    { condition: 'wrong' },
    { decision: null },
    { evidence: { locator: '', hash: '' } },
  ]) {
    const invalid = structuredClone(run);
    Object.assign(invalid.supervision!.arbitrations[0]!.attempts![0]!, patch);
    expect(() => validateExecution(invalid)).toThrow();
  }
});
it('continues an audit on a migrated v2 card without losing manual fields', async () => {
  await f.file(f.card.locator, connectCardMarkdown(f.card, 'project', 'task'));
  const result = await cards.prepare(
    f.card.locator,
    'task',
    'v2-audit',
    data(),
    await f.ref(f.card.locator),
  );
  expect((await cards.read(result.ref)).goal).toBe(data().goal);
});

it('creates F2 cards without invented elapsed, preserves manual text and detects conflicting revisions', async () => {
  const locator = `${f.connection.plans.active}/audit.md`;
  const unknown = {
    ...data(),
    timing: { ...data().timing, elapsed_ms: null, external_wait_ms: null },
  };
  const card = await cards.prepare(locator, 'task', 'new-audit', unknown, null);
  expect(await cards.read(card.ref)).toEqual(card);
  expect(card.timing.elapsed_ms).toBeNull();
  expect(await cards.prepare(locator, 'task', 'new-audit', unknown, null)).toEqual(card);
  await expect(cards.prepare('outside/audit.md', 'task', 'outside', data(), null)).rejects.toThrow(
    'audit-card-outside-plans',
  );
  await expect(
    cards.prepare(`${f.connection.plans.active}/bad.txt`, 'task', 'outside', data(), null),
  ).rejects.toThrow('audit-card-outside-plans');
  await expect(cards.prepare(locator, 'task', 'mismatch', data(), f.proof)).rejects.toThrow(
    'audit-card-locator-mismatch',
  );
  await expect(
    cards.prepare(locator, 'task', 'stale', data(), { locator, hash: 'stale' }),
  ).rejects.toThrow('audit-card-conflict');
  await expect(
    cards.prepare(locator, 'other-task', 'wrong', data(), await f.ref(locator)),
  ).rejects.toThrow('audit-card-identity-mismatch');
  const nextCard = await cards.prepare(locator, 'task', 'next-audit', data(), await f.ref(locator));
  expect(nextCard.ref).not.toEqual(card.ref);
  expect(await cards.read(card.ref)).toEqual(card);
  await expect(cards.read({ ...card.ref, hash: 'stale' })).rejects.toThrow('audit-card-conflict');
  const existing = await cards.prepare(f.card.locator, 'task', 'manual-card', data(), {
    locator: f.card.locator,
    hash: f.card.revision,
  });
  expect((await f.cards.read(existing.ref.locator)).content).toContain('Keep manual text.');
  await f.file(locator, '# Changed\n\n- **Статус:** `active`\n');
  await expect(cards.prepare(locator, 'task', 'racing-editor', data(), null)).rejects.toThrow(
    'audit-card-reconciliation-pending',
  );
  await expect(cards.read(await f.ref(locator))).rejects.toThrow('audit-card-payload-missing');
  await f.file(locator, '<!-- agent-workflow:audit-v1 -->\ninvalid');
  await expect(cards.read(await f.ref(locator))).rejects.toThrow('audit-card-payload-invalid');
});

it('binds audit input to the real card and confirmed session before checkpoint writes, retaining the result after reopen', async () => {
  let run = execution();
  expect(() => validateExecution({ ...run, schema_version: 1 })).toThrow(
    'unsupported-execution-version',
  );
  await beginExecution(run, journal);
  const advance = async (action: SupervisionAction) => {
    run = await advanceExecution(
      executionEvent(run, { type: 'SUPERVISE', action }),
      journal,
      f.inputs,
      { inspect: async (id) => role(id as 'arbiter' | 'auditor').session },
      cards,
    );
  };
  await advance({ kind: 'stage', id: 'stage', estimate_ms: 60, checkpoint: 'cp' });
  const card = await cards.prepare(
    `${f.connection.plans.active}/audit.md`,
    'task',
    'create',
    data(),
    null,
  );
  const action: SupervisionAction = {
    kind: 'audit',
    id: 'audit',
    stage: 'stage',
    trigger: { kind: 'doubt', evidence_id: 'risk-1' },
    card,
    role: role('auditor'),
  };
  const event = executionEvent(run, { type: 'SUPERVISE', action });
  await expect(advanceExecution(event, journal, f.inputs)).rejects.toThrow(
    'audit-card-reader-required',
  );
  await expect(
    advanceExecution(event, journal, f.inputs, undefined, {
      read: async () => ({ ...card, goal: 'fake' }),
    }),
  ).rejects.toThrow('audit-card-content-mismatch');
  await expect(advanceExecution(event, journal, f.inputs, undefined, cards)).rejects.toThrow(
    'independent-session-unconfirmed',
  );
  await expect(
    advanceExecution(event, journal, f.inputs, { inspect: async () => null }, cards),
  ).rejects.toThrow('independent-session-missing');
  for (const patch of [{ id: 'wrong' }, { project_id: 'wrong' }, { workspace: 'wrong' }])
    await expect(
      advanceExecution(
        event,
        journal,
        f.inputs,
        { inspect: async () => ({ ...role('auditor').session, ...patch }) },
        cards,
      ),
    ).rejects.toThrow('independent-session-mismatch');
  await advance(action);
  await advance({
    kind: 'audit-answer',
    id: 'audit',
    session: 'auditor',
    answer: {
      direction: 'continue',
      reason: 'valid path',
      next_result: 'full validation',
      evidence: f.proof,
    },
  });
  await advance({ kind: 'audit-apply', id: 'audit', checkpoint: 'next', evidence: f.proof });
  expect(
    (
      await new TaskWorkflowJournal(
        { execute: async (r) => db.store.execute(r) },
        grant.context,
        1,
      ).read()
    ).execution,
  ).toEqual(run);
  expect(
    collectInputRefs({
      empty: null,
      values: [f.proof, { locator: 'not a ref' }, { hash: 'not a ref' }],
    }),
  ).toEqual([f.proof]);
});

it('restores arbitration evidence and preserves a narrow three-fail disposition without waiving validation', async () => {
  let run = execution();
  let item = recordFinding(
    [],
    {
      id: 'F1',
      scope: 'workflow',
      blocking: true,
      waivable: true,
      reason: 'disputed design',
      condition: 'working contract',
      sources: [f.proof],
    },
    'architect',
    f.proof,
  )[0]!;
  for (const correction of ['one', 'two', 'three'])
    item = recordRoundVerdict(item, correction, 'architect', 'FAIL', f.proof);
  run.findings = [item];
  await beginExecution(run, journal);
  const advance = async (action: SupervisionAction) => {
    run = await advanceExecution(
      executionEvent(run, { type: 'SUPERVISE', action }),
      journal,
      f.inputs,
      { inspect: async () => role('arbiter').session },
    );
  };
  await advance({
    kind: 'arbitrate',
    id: 'A',
    finding: 'F1',
    trigger: { kind: 'three-fail' },
    role: role('arbiter'),
  });
  await advance({
    kind: 'decision',
    id: 'A',
    session: 'arbiter',
    decision: {
      outcome: 'compromise',
      reason: 'bounded dispute',
      exception: 'one finding only',
      residual_risk: 'recorded',
      dissent: ['owner FAIL'],
      evidence: f.proof,
    },
  });
  await advance({
    kind: 'review',
    id: 'A',
    proof: {
      target: f.target,
      implementation: f.proof,
      review: { reviewer: 'architect', verdict: 'FAIL', evidence: f.proof },
      condition: item.condition,
      working_check: f.proof,
      check_verdict: 'PASS',
      mandatory_defect: false,
    },
  });
  expect(executionBlockers(run)).toEqual(['validate:not-passed', 'acceptance-missing']);
  const council = f.council('acceptance');
  council.advisers.architect!.answer!.verdict = 'FAIL';
  council.advisers.architect!.answer!.findings = [item];
  expect(executionBlockers({ ...run, acceptance: council })).toEqual(['validate:not-passed']);
  expect(council.advisers.architect!.answer!.verdict).toBe('FAIL');
  council.advisers.architect!.answer!.findings = [{ ...item, id: 'other' }];
  expect(executionBlockers({ ...run, acceptance: council })).toContain('architect:not-accepted');
  council.advisers.architect!.answer = null;
  expect(executionBlockers({ ...run, acceptance: council })).toContain('architect:not-accepted');
  run.status = 'review';
  const correction = {
    ...item,
    rounds: [
      ...item.rounds,
      { correction_id: 'four', evidence: [f.proof], reviewers: ['architect' as const] },
    ],
  };
  applyExecution(
    run,
    executionEvent(run, { type: 'CORRECT', findings: [correction] }),
    journal.fingerprint,
  );
  const lost = structuredClone(correction);
  delete lost.rounds[0]!.verdicts;
  expect(() =>
    applyExecution(
      run,
      executionEvent(run, { type: 'CORRECT', findings: [lost] }),
      journal.fingerprint,
    ),
  ).toThrow('finding-history-lost');
  const other = structuredClone(correction);
  other.rounds[0]!.verdicts![0]!.verdict = 'PASS';
  expect(() =>
    applyExecution(
      run,
      executionEvent(run, { type: 'CORRECT', findings: [other] }),
      journal.fingerprint,
    ),
  ).toThrow('finding-history-lost');
  expect((await journal.read()).execution!.supervision!.arbitrations[0]!.decision!.dissent).toEqual(
    ['owner FAIL'],
  );
  for (const status of ['waiting', 'blocked', 'human', 'implementing', 'resolved'] as const) {
    const snapshot = structuredClone(run);
    snapshot.supervision!.arbitrations[0]!.status = status;
    snapshot.supervision!.arbitrations[0]!.trigger = {
      kind: 'initial-contradiction',
      confirmation: f.proof,
      reviewer: 'architect',
    };
    snapshot.supervision!.arbitrations[0]!.human = f.proof;
    validateExecution(snapshot);
    if (status !== 'resolved') {
      snapshot.supervision!.arbitrations[0]!.decision = null;
      snapshot.supervision!.arbitrations[0]!.implementation = null;
      snapshot.supervision!.arbitrations[0]!.review = null;
      validateExecution(snapshot);
    }
  }
});

it('reserves progress in SQLite after a verified backup and recovers a stale, refused launch without another auditor', async () => {
  const { backupSupervision } = await import('../adapters/storage/supervisionBackup.js');
  const { restoreStore } = await import('../adapters/storage/storeBackup.js');
  const { SqliteEvidenceStore, unwrap } =
    await import('../adapters/storage/sqliteEvidenceStore.js');
  const { dirname } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const { contentHash } = await import('../adapters/project/projectFiles.js');
  let run = execution();
  await beginExecution(run, journal);
  run = await advanceExecution(
    executionEvent(run, { type: 'PLAN', council: f.council('planning') }),
    journal,
    f.inputs,
  );
  const card = await cards.prepare(
    `${f.connection.plans.active}/progress.md`,
    'task',
    'progress-card',
    {
      ...data(),
      timing: null,
      progress: {
        schema_version: 1,
        task_id: 'task',
        scope: f.target.scope,
        goal_source: f.target.inputs.inputs[0]!,
        checkpoint: 'original',
        evidence: f.proof,
        inputs: f.target.inputs,
        estimate_ms: null,
        elapsed_ms: null,
        external_wait_ms: null,
      },
    },
    null,
  );
  const beforeProgress = await journal.read();
  await journal.ensureReady({
    ...run,
    supervision: {
      schema_version: 2,
      reservations: [],
      stages: [],
      arbitrations: [],
      arbiters: [],
      audits: [],
    },
  });
  expect(await journal.read()).toEqual(beforeProgress);
  const reserve = executionEvent(run, {
    type: 'SUPERVISE',
    action: { kind: 'reserve-audit', id: 'progress', card },
  });
  const stale = { ...beforeProgress, revision: beforeProgress.revision - 1 };
  await expect(
    journal.save(
      stale,
      {
        ...stale,
        revision: stale.revision + 1,
        execution: applyExecution(run, reserve, journal.fingerprint),
      },
      'stale-progress-write',
    ),
  ).rejects.toThrow('workflow-revision-conflict');
  await expect(advanceExecution(reserve, journal, f.inputs, undefined, cards)).rejects.toThrow(
    'supervision-backup-required',
  );
  let loseCheckpoint = true;
  const persistence: EvidenceStore = {
    execute: async (r) => {
      if (
        loseCheckpoint &&
        r.command.type === 'mutate' &&
        r.command.mutation.operation_id === `execution:task:${reserve.id}`
      ) {
        loseCheckpoint = false;
        throw new Error('checkpoint-not-started');
      }
      return db.store.execute(r);
    },
  };
  journal = new TaskWorkflowJournal(persistence, grant.context, 1, true, (state, operation) =>
    backupSupervision(
      { execute: async (r) => db.store.execute(r) },
      db.root,
      db.parent,
      grant,
      state,
      operation,
    ),
  );
  const advance = async (
    action: SupervisionAction,
    sessions?: Parameters<typeof advanceExecution>[3],
  ) => {
    run = await advanceExecution(
      executionEvent(run, { type: 'SUPERVISE', action }),
      journal,
      f.inputs,
      {
        inspect: async () => role('auditor').session,
        confirmAuditParent: async () => {},
        ...sessions,
      },
      cards,
    );
  };
  await expect(advanceExecution(reserve, journal, f.inputs, undefined, cards)).rejects.toThrow(
    'checkpoint-not-started',
  );
  run = await advanceExecution(reserve, journal, f.inputs, undefined, cards);
  const checkpoint = await journal.read();
  expect(checkpoint.supervision_backup).toBeDefined();
  expect(checkpoint.execution!.supervision!.schema_version).toBe(2);
  const backup = checkpoint.supervision_backup!;
  expect(contentHash(await readFile(backup.locator, 'utf8'))).toBe(backup.hash);
  restoreStore(dirname(backup.locator), resolve(db.parent, 'legacy-restored'), grant);
  const legacyStore = new SqliteEvidenceStore(
    resolve(db.parent, 'legacy-restored'),
    grant,
    () => 100,
  );
  const legacy = await new TaskWorkflowJournal(
    { execute: async (r) => legacyStore.execute(r) },
    grant.context,
    1,
  ).read();
  expect(legacy.execution!.supervision).toBeUndefined();
  expect(unwrap(db.execute({ type: 'effects' }))).toMatchObject([
    { id: 'progress-audit:progress', outcome: 'pending' },
  ]);
  await advance({
    kind: 'launch-audit',
    id: 'progress',
    operation: 'one-create',
    parent: 'audit-parent',
  });
  await expect(
    advance({
      kind: 'launch-audit',
      id: 'progress',
      operation: 'another-create',
      parent: 'audit-parent',
    }),
  ).rejects.toThrow('audit-launch-already-claimed');
  await f.file('source.txt', 'Changed source after the launch');
  const target = { ...f.target, inputs: await f.inputs.current(f.target.inputs) };
  run = await advanceExecution(executionEvent(run, { type: 'REPLAN', target }), journal, f.inputs);
  const observation = {
    outcome: 'not-started' as const,
    operation: 'one-create',
    session: null,
    receipt: f.proof,
  };
  const settle: SupervisionAction = { kind: 'settle-audit', id: 'progress', observation };
  await expect(advance(settle)).rejects.toThrow('audit-attempt-observer-required');
  const inspect = async () => role('auditor').session;
  await expect(
    advance(settle, { inspect, observeAuditAttempt: async () => ({ outcome: 'unknown' }) }),
  ).rejects.toThrow('audit-attempt-outcome-unknown');
  await advance(settle, { inspect, observeAuditAttempt: async () => observation });
  expect(unwrap(db.execute({ type: 'effects' }))).toMatchObject([{ outcome: 'not-started' }]);
  await f.file('new-proof.txt', 'New proof for a changed checkpoint');
  const newCard = await cards.prepare(
    `${f.connection.plans.active}/progress.md`,
    'task',
    'new-progress-card',
    {
      ...data(),
      timing: null,
      progress: {
        ...card.progress,
        checkpoint: 'new',
        evidence: await f.ref('new-proof.txt'),
        goal_source: target.inputs.inputs[0]!,
        inputs: target.inputs,
      },
    },
    await f.ref(`${f.connection.plans.active}/progress.md`),
  );
  await advance({ kind: 'reserve-audit', id: 'fresh', card: newCard });
  await advance({
    kind: 'launch-audit',
    id: 'fresh',
    operation: 'fresh-create',
    parent: 'audit-parent',
  });
  const freshRole = role('auditor');
  const source = target.inputs.inputs[0]!;
  freshRole.run.spec.sources = freshRole.run.spec.sources.map((ref) =>
    ref.locator === source.locator ? source : ref,
  );
  if (freshRole.run.spec.assignment.locator === source.locator)
    freshRole.run.spec.assignment = source;
  await advance(
    {
      kind: 'audit',
      id: 'fresh',
      stage: null,
      trigger: { kind: 'no-progress', evidence_id: newCard.progress.evidence.hash },
      card: newCard,
      role: freshRole,
    },
    {
      inspect,
      observeAuditAttempt: async () => ({
        outcome: 'terminal',
        operation: 'fresh-create',
        session: role('auditor').session,
        turn: 'original-turn',
        status: 'completed',
        receipt: f.proof,
      }),
    },
  );
  await advance({
    kind: 'audit-answer',
    id: 'fresh',
    session: 'auditor',
    answer: {
      direction: 'replace-approach',
      reason: 'Original task not delivered',
      next_result: 'Deliver observable result',
      evidence: f.proof,
    },
  });
  await advance({
    kind: 'audit-apply',
    id: 'fresh',
    checkpoint: 'observed-result',
    evidence: f.proof,
  });
  expect(run.supervision!.stages).toEqual([]);
  expect(run.supervision!.audits.filter((a) => a.applied !== null)).toHaveLength(1);
  expect(run.supervision!.reservations![0]!.settled).toEqual(observation);
  const backupSource = unwrap<TechnicalState>(db.execute({ type: 'state', archive: 'current' }));
  const nextBackup = await backupSupervision(
    { execute: async (r) => db.store.execute(r) },
    db.root,
    db.parent,
    grant,
    backupSource,
    'post-audit-backup',
  );
  restoreStore(dirname(nextBackup.locator), resolve(db.parent, 'new-restored'), grant);
  const restoredStore = new SqliteEvidenceStore(
    resolve(db.parent, 'new-restored'),
    grant,
    () => 100,
  );
  expect(
    (
      await new TaskWorkflowJournal(
        { execute: async (r) => restoredStore.execute(r) },
        grant.context,
        1,
      ).read()
    ).execution,
  ).toEqual(run);
});

it('retires a prepared reservation without requiring current stale source files or a native session', async () => {
  const { backupSupervision } = await import('../adapters/storage/supervisionBackup.js');
  journal = new TaskWorkflowJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
    true,
    (source, operation) =>
      backupSupervision(
        { execute: async (r) => db.store.execute(r) },
        db.root,
        db.parent,
        grant,
        source,
        operation,
      ),
  );
  let run = execution();
  await beginExecution(run, journal);
  const card = await cards.prepare(
    `${f.connection.plans.active}/prepared.md`,
    'task',
    'prepare',
    {
      ...data(),
      timing: null,
      progress: {
        schema_version: 1,
        task_id: 'task',
        scope: f.target.scope,
        goal_source: f.target.inputs.inputs[0]!,
        checkpoint: 'cp',
        evidence: f.proof,
        inputs: f.target.inputs,
        estimate_ms: null,
        elapsed_ms: null,
        external_wait_ms: null,
      },
    },
    null,
  );
  run = await advanceExecution(
    executionEvent(run, {
      type: 'SUPERVISE',
      action: { kind: 'reserve-audit', id: 'prepared', card },
    }),
    journal,
    f.inputs,
    undefined,
    cards,
  );
  await f.file('source.txt', 'Changed after reserve');
  const event = executionEvent(run, {
    type: 'SUPERVISE',
    action: {
      kind: 'settle-audit',
      id: 'prepared',
      observation: {
        outcome: 'not-started',
        operation: 'prepared',
        session: null,
        receipt: card.ref,
      },
    },
  });
  run = await advanceExecution(event, journal, f.inputs);
  expect(run.supervision!.reservations![0]!.settled?.outcome).toBe('not-started');
});
