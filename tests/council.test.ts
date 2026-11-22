import { runChatCommand } from '../cli/chatCommand.js';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  answerCouncil,
  assignAdviser,
  changedPlanningRoles,
  councilBlockers,
  councilRoles,
  createCouncil,
  repeatCouncil,
  revisePlanning,
  sameRefs,
  sameTarget,
  councilReviewRequest,
  councilReviewBasis,
} from '../core/council.js';
import type { Selection } from '../core/council.js';
import { councilReviewBrief } from '../adapters/codex/councilReviewBrief.js';
import { recordCorrection, recordFinding, resolveFinding } from '../core/findings.js';
import { workflowFixture } from './workflowFixtures.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createH02LegacyFixture } from './comparisonH02LegacyFixture.js';
import { runH02LegacyCase } from './comparisonH02Legacy.js';
import * as legacyCaseModule from './comparisonH02Legacy.js';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { checkH02Material, h02Scenario } from './comparisonH02Contract.js';
import type { Council } from '../core/council.js';
import * as councilPolicy from '../core/council.js';
import * as nativeContract from './comparisonH01Contract.js';
import type { H01AttemptContext, H01NativeObserver } from './comparisonH01Contract.js';
import { createH02NativeRpc } from './comparisonH02NativeRpc.js';
import * as nativeRpcModule from './comparisonH02NativeRpc.js';
import { createH02NativeLegacyAdapter } from './comparisonH02NativeLegacy.js';
import * as chatPeerModule from '../adapters/codex/chatPeer.js';
import { h02Material, h02PreparedMetadata } from './comparisonH02Contract.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { object, textField } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import type * as AppServerTransportModule from '../adapters/codex/appServerTransport.js';
import type { ProcessIdentity } from '../ports/writerProcesses.js';

// Only the native operating-system boundary is replaced. No native process/model is started.
const h02NativeBoundary = vi.hoisted(() => ({
  spawn: vi.fn(),
  descendants: vi.fn(),
  alive: vi.fn(),
  terminate: vi.fn(),
  wait: vi.fn(),
}));
vi.mock('../adapters/codex/appServerTransport.js', async (original) => ({
  ...(await original<typeof AppServerTransportModule>()),
  StdioAppServer: class {
    constructor(...args: unknown[]) {
      return h02NativeBoundary.spawn(...args) as object;
    }
  },
}));
vi.mock('../adapters/codex/writerProcesses.js', () => ({
  NativeWriterProcesses: class {
    descendants = h02NativeBoundary.descendants;
    alive = h02NativeBoundary.alive;
    terminate = h02NativeBoundary.terminate;
    wait = h02NativeBoundary.wait;
  },
}));
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});

it('exposes the subject and exact prior review facts without selecting a second council', () => {
  const council = f.council('planning');
  council.history = [
    { role: 'architect', session: 'session', answer: council.advisers.architect!.answer! },
  ];
  expect(
    councilReviewBasis(createCouncil('planning', f.selection, f.target), 'architect'),
  ).toMatchObject({
    previous: null,
    requirements: 'initial',
    rationale: 'initial',
    inputs: 'initial',
  });
  expect(councilReviewBasis(council, 'architect')).toMatchObject({
    previous: { verdict: 'PASS', coverage: 'complete', scope: f.target.scope },
    requirements: 'unchanged',
    rationale: 'unchanged',
    inputs: 'applicable',
  });
  council.selection.architect.reason = 'Изменено предметное основание';
  expect(councilReviewBasis(council, 'architect').rationale).toBe('changed');
  council.selection.architect.requirements = [f.proof];
  council.selection.architect.inputs = { ...council.selection.architect.inputs, complete: false };
  expect(councilReviewBasis(council, 'architect')).toMatchObject({
    requirements: 'changed',
    inputs: 'unknown',
  });
  council.history = council.history.map((entry) => ({
    role: entry.role,
    session: entry.session,
    retained: true as const,
    answer: {
      verdict: entry.answer.verdict,
      coverage: entry.answer.coverage,
      findings: entry.answer.findings,
      evidence: entry.answer.evidence,
    },
  }));
  council.advisers.architect!.answer = null;
  expect(councilReviewBasis(council, 'architect').previous!.scope).toBeNull();
  const reviewed = council.advisers.architect!.reviewed!;
  council.advisers.architect!.reviewed = {
    requirements: reviewed.requirements,
    inputs: reviewed.inputs,
  };
  expect(councilReviewBasis(council, 'architect').rationale).toBe('unknown');
  Object.assign(council.advisers.architect!.reviewed!, { reason: null });
  expect(councilReviewBasis(council, 'architect').rationale).toBe('unknown');
  council.advisers.architect!.reviewed = null;
  expect(councilReviewBasis(council, 'architect').requirements).toBe('unknown');
  expect(councilReviewBasis(council, 'architect').rationale).toBe('unknown');
});

it('binds separate evidence in targets, keeps compact requests small and rejects incomplete or duplicate packages', async () => {
  const evidence = await f.inputs.capture(
    { files: ['source.txt', 'proof.txt'], directories: [] },
    'package',
  );
  const target = { ...f.target, evidence_inputs: evidence };
  expect(sameTarget(f.target, target)).toBe(false);
  const council = assignAdviser(
    createCouncil('acceptance', f.selection, target),
    'architect',
    f.adviser,
  );
  const request = councilReviewRequest(council, 'architect', f.adviser);
  const brief = councilReviewBrief(request, f.proof);
  const portable = JSON.parse(
    councilReviewBrief({ ...request, reader: 'runtime-cli' }, f.proof).slice(
      'Council review request file: '.length,
    ),
  ) as { request_reader: unknown };
  expect(portable.request_reader).toEqual([
    process.execPath,
    '--import',
    import.meta.resolve('tsx'),
    resolve(import.meta.dirname, '../cli/main.ts'),
    'read-artifact',
    f.proof.locator + '.role.ref.json',
  ]);
  expect(brief).toContain('target.evidence_inputs');
  expect(brief).not.toContain(f.target.inputs.inputs[0]!.hash);
  for (const manifest of [
    { ...evidence, complete: false },
    { ...evidence, inputs: [f.proof] },
    { ...evidence, inputs: [...evidence.inputs, f.proof] },
  ])
    expect(() =>
      createCouncil('acceptance', f.selection, { ...target, evidence_inputs: manifest }),
    ).toThrow('target-evidence-missing-source-inputs');
  const repeated = f.council('acceptance');
  repeated.selection.backend.trigger = true;
  repeated.advisers.backend = structuredClone(repeated.advisers.architect!);
  expect(() => repeatCouncil(repeated, target, ['backend'])).toThrow('unreviewed-input-change');
});

it('keeps consumed answer turns across planning revisions after earlier PASS bodies were discarded', () => {
  const first = f.council('planning');
  const old = first.advisers.architect!.answer!;
  const second = answerCouncil(
    repeatCouncil(first, f.target, ['architect']),
    'architect',
    'session',
    {
      ...old,
      binding: { ...old.binding!, answer_turn: 'second-answer' },
    },
  );
  expect(second.history).toHaveLength(1);
  const revised = revisePlanning(second, second.selection, second.target);
  expect(revised.review_turns).toEqual(second.review_turns);
  expect(() =>
    answerCouncil(
      repeatCouncil(revised, revised.target, ['architect']),
      'architect',
      'session',
      old,
    ),
  ).toThrow('review-turn-already-used');
  revised.review_turns!.pop();
  expect(second.review_turns).toHaveLength(2);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.dispose();
});

it('selects all roles, blocks unknown/missing/running/partial responses and rejects false N/A', () => {
  const council = createCouncil('planning', f.selection, f.target);
  expect(Object.keys(council.selection)).toEqual(councilRoles);
  expect(councilBlockers(council)).toEqual(['architect:NOT RUN']);
  const unknown = { ...f.selection, backend: { ...f.selection.backend, trigger: null } };
  expect(councilBlockers(createCouncil('planning', unknown, f.target))).toContain(
    'backend:applicability-unknown',
  );
  const assigned = assignAdviser(council, 'architect', f.adviser);
  expect(councilBlockers(assigned)).toEqual(['architect:running']);
  expect(() => assignAdviser(assigned, 'architect', f.adviser)).toThrow('adviser-already-assigned');
  expect(() => repeatCouncil(assigned, f.target, ['architect'])).toThrow(
    'reviewer-still-running-or-missing',
  );
  expect(() =>
    answerCouncil(assigned, 'architect', 'session', { ...f.answer(assigned), verdict: 'N/A' }),
  ).toThrow('mandatory-role-cannot-be-na');
  for (const patch of [
    { coverage: 'partial' as const },
    { verdict: 'FAIL' as const },
    { verdict: 'NOT RUN' as const },
  ]) {
    const failed = answerCouncil(assigned, 'architect', 'session', {
      ...f.answer(assigned),
      ...patch,
    });
    expect(councilBlockers(failed)).toEqual(['architect:not-accepted']);
  }
  const completed = answerCouncil(assigned, 'architect', 'session', f.answer(assigned));
  expect(councilBlockers(completed)).toEqual([]);
  expect(() => answerCouncil(completed, 'architect', 'session', f.answer(assigned))).toThrow(
    'adviser-already-answered',
  );
  expect(
    councilBlockers({
      ...completed,
      advisers: { architect: { ...completed.advisers.architect!, answer: null } },
    }),
  ).toEqual(['architect:not-accepted']);
});

it.each(councilRoles)('does not omit the mandatory %s adviser in either phase', (role) => {
  for (const phase of ['planning', 'acceptance'] as const) {
    const selection = structuredClone(f.selection);
    selection.architect.trigger = false;
    selection[role].trigger = true;
    expect(councilBlockers(createCouncil(phase, selection, f.target))).toEqual([`${role}:NOT RUN`]);
    selection[role].trigger = null;
    expect(councilBlockers(createCouncil(phase, selection, f.target))).toEqual([
      `${role}:applicability-unknown`,
    ]);
  }
});

it.each(['planning', 'acceptance'] as const)(
  'keeps an unresolved FAIL blocking when %s marks its role N/A',
  (phase) => {
    const assigned = assignAdviser(
      createCouncil(phase, f.selection, f.target),
      'architect',
      f.adviser,
    );
    const failed = answerCouncil(assigned, 'architect', 'session', {
      ...f.answer(assigned),
      verdict: 'FAIL',
    });
    const selection = {
      ...f.selection,
      architect: { ...f.selection.architect, trigger: false, reason: 'Область снята' },
    };
    const hidden =
      phase === 'planning'
        ? revisePlanning(failed, selection, f.target)
        : repeatCouncil(failed, f.target, ['architect'], selection);
    expect(councilBlockers(hidden)).toEqual(['architect:unresolved-failure']);
    expect(hidden.history).toEqual(failed.history);
    for (const answer of [
      { ...f.answer(assigned), verdict: 'NOT RUN' as const },
      { ...f.answer(assigned), coverage: 'partial' as const },
    ]) {
      const incomplete = {
        ...hidden,
        history: [...hidden.history, { role: 'architect' as const, session: 'session', answer }],
      };
      expect(councilBlockers(incomplete)).toEqual(['architect:unresolved-failure']);
    }
    const resolved = {
      ...hidden,
      history: [
        ...hidden.history,
        {
          role: 'architect' as const,
          session: 'session',
          answer: f.answer(assigned),
        },
      ],
    };
    expect(councilBlockers(resolved)).toEqual([]);
  },
);

it.each(['mobile-game-developer', 'methodologist-literary-editor', 'ui-ux-designer'] as const)(
  'requires explicit applicability for %s and blocks missing or unknown selection',
  (role) => {
    const missing = { ...f.selection, [role]: undefined };
    expect(() => createCouncil('planning', missing, f.target)).toThrow('missing-role-selection');
    for (const phase of ['planning', 'acceptance'] as const) {
      const selection = { ...f.selection, [role]: { ...f.selection[role], trigger: null } };
      expect(councilBlockers(createCouncil(phase, selection, f.target))).toContain(
        `${role}:applicability-unknown`,
      );
      selection[role].trigger = true;
      expect(councilBlockers(createCouncil(phase, selection, f.target))).toContain(
        `${role}:NOT RUN`,
      );
      selection[role].trigger = false;
      expect(councilBlockers(createCouncil(phase, selection, f.target))).toEqual([
        'architect:NOT RUN',
      ]);
    }
  },
);

it('requires confirmed read-only council loading, exact identity, sources and target', () => {
  expect(() =>
    createCouncil(
      'planning',
      { ...f.selection, architect: undefined } as unknown as Selection,
      f.target,
    ),
  ).toThrow('missing-role-selection');
  expect(() =>
    createCouncil(
      'planning',
      { ...f.selection, architect: { ...f.selection.architect, requirements: [] } },
      f.target,
    ),
  ).toThrow('missing-role-requirements');
  const council = createCouncil('planning', f.selection, f.target);
  expect(() => assignAdviser(council, 'product', f.adviser)).toThrow('role-not-applicable');
  expect(() =>
    assignAdviser(council, 'architect', {
      ...f.adviser,
      spec: { ...f.adviser.spec, role: 'explorer' },
    }),
  ).toThrow('not-council-adviser');
  for (const loaded of [
    null,
    {
      ...f.adviser.loaded!,
      procedures: f.adviser.loaded!.procedures.filter((p) => p.id !== 'council'),
    },
  ])
    expect(() => assignAdviser(council, 'architect', { ...f.adviser, loaded })).toThrow(
      'council-not-loaded',
    );
  const assigned = assignAdviser(council, 'architect', f.adviser);
  expect(() => answerCouncil(council, 'architect', 'session', f.answer(council))).toThrow(
    'wrong-adviser-identity',
  );
  expect(() => answerCouncil(assigned, 'architect', 'other', f.answer(assigned))).toThrow(
    'wrong-adviser-identity',
  );
  expect(() =>
    answerCouncil(assigned, 'architect', 'session', { ...f.answer(assigned), scope: 'other' }),
  ).toThrow('wrong-review-target');
  expect(() =>
    answerCouncil(assigned, 'architect', 'session', {
      ...f.answer(assigned),
      target: { ...f.target, base: 'other' },
    }),
  ).toThrow('wrong-review-target');
  expect(() =>
    answerCouncil(assigned, 'architect', 'session', { ...f.answer(assigned), sources: [] }),
  ).toThrow('missing-review-sources');
  expect(sameRefs([f.proof], [])).toBe(false);
  expect(sameRefs([f.proof, f.proof], [f.proof, { ...f.proof, locator: 'other' }])).toBe(false);
  expect(sameRefs([f.proof, { ...f.proof, locator: 'other' }], [f.proof, f.proof])).toBe(false);
  expect(sameRefs([f.proof], [{ ...f.proof, locator: 'other' }])).toBe(false);
  expect(sameTarget(f.target, { ...f.target, scope: 'other' })).toBe(false);
  expect(sameTarget(f.target, { ...f.target, diff: { ...f.target.diff, hash: 'changed' } })).toBe(
    false,
  );
  expect(
    sameTarget(f.target, { ...f.target, inputs: { ...f.target.inputs, complete: false } }),
  ).toBe(false);
});

it('retains original FAIL, reviews corrections with the same adviser, and replans only changed roles', () => {
  const finding = {
    id: 'F1',
    scope: 'workflow',
    condition: 'reject stale evidence',
    reason: 'false PASS',
    blocking: true,
    sources: [f.proof],
  };
  const assigned = assignAdviser(
    createCouncil('acceptance', f.selection, f.target),
    'architect',
    f.adviser,
  );
  expect(() =>
    answerCouncil(assigned, 'architect', 'session', { ...f.answer(assigned), findings: [finding] }),
  ).toThrow('pass-with-blocker');
  expect(() =>
    answerCouncil(assigned, 'architect', 'session', {
      ...f.answer(assigned),
      verdict: 'FAIL',
      findings: [finding, finding],
    }),
  ).toThrow('duplicate-finding');
  expect(() =>
    answerCouncil(assigned, 'architect', 'session', {
      ...f.answer(assigned),
      verdict: 'FAIL',
      findings: [{ ...finding, sources: [] }],
    }),
  ).toThrow('missing-finding-sources');
  const failed = answerCouncil(assigned, 'architect', 'session', {
    ...f.answer(assigned),
    verdict: 'FAIL',
    findings: [finding],
  });
  const repeated = repeatCouncil(failed, { ...f.target, diff: { locator: 'delta', hash: 'new' } }, [
    'architect',
  ]);
  expect(repeated.advisers.architect!.run.spec.session_id).toBe('session');
  expect(repeated.history[0]!.answer.verdict).toBe('FAIL');
  expect(() => repeatCouncil(failed, f.target, [])).toThrow('missing-affected-roles');
  expect(() => repeatCouncil(failed, f.target, ['backend'])).toThrow(
    'reviewer-still-running-or-missing',
  );
  expect(() =>
    repeatCouncil(failed, { ...f.target, inputs: { ...f.target.inputs, complete: false } }, [
      'backend',
    ]),
  ).toThrow('unreviewed-input-change');
  const changed = {
    ...f.selection,
    dba: { ...f.selection.dba, trigger: true },
    architect: { ...f.selection.architect, requirements: [{ ...f.proof, hash: 'new' }] },
  };
  const planning = f.council('planning');
  expect(changedPlanningRoles(planning, changed)).toEqual(['architect', 'dba']);
  expect(changedPlanningRoles(planning, f.selection)).toEqual([]);
  const replanned = revisePlanning(planning, changed, f.target);
  expect(replanned.advisers.architect!.status).toBe('running');
  expect(replanned.advisers.dba).toBeUndefined();
  expect(revisePlanning(planning, f.selection, f.target).advisers.architect!.status).toBe(
    'answered',
  );
  expect(
    revisePlanning(
      planning,
      { ...f.selection, architect: { ...f.selection.architect, trigger: false } },
      f.target,
    ).advisers.architect,
  ).toBeUndefined();
  expect(() => revisePlanning(failed, f.selection, f.target)).toThrow('not-planning-council');
  expect(() => revisePlanning({ ...assigned, phase: 'planning' }, f.selection, f.target)).toThrow(
    'planning-adviser-running',
  );
  let ledger = recordFinding([], finding, 'architect', f.proof);
  expect(recordFinding(ledger, finding, 'dba', f.proof)).toBe(ledger);
  expect(() =>
    recordFinding(ledger, { ...finding, condition: 'different' }, 'architect', f.proof),
  ).toThrow('finding-identity-conflict');
  expect(() =>
    recordFinding(ledger, { ...finding, scope: 'different' }, 'architect', f.proof),
  ).toThrow('finding-identity-conflict');
  let item = recordCorrection(ledger[0]!, 'correction-1', 'architect', f.proof);
  item = recordCorrection(item, 'correction-1', 'dba', f.proof);
  item = recordCorrection(item, 'correction-1', 'dba', f.proof);
  expect(item.rounds).toHaveLength(1);
  item = recordCorrection(item, 'correction-2', 'architect', f.proof);
  expect(item.rounds).toHaveLength(2);
  expect(() => resolveFinding(item, 'different', f.proof, 'architect', 'PASS')).toThrow(
    'resolution-condition-not-met',
  );
  expect(() => resolveFinding(item, item.condition, f.proof, 'architect', 'FAIL')).toThrow(
    'resolution-condition-not-met',
  );
  expect(() => resolveFinding(item, item.condition, f.proof, 'dba', 'PASS')).toThrow(
    'resolution-condition-not-met',
  );
  expect(() =>
    resolveFinding(item, item.condition, { locator: 'absent', hash: 'x' }, 'architect', 'PASS'),
  ).toThrow('resolution-evidence-missing');
  expect(() => resolveFinding(ledger[0]!, item.condition, f.proof, 'architect', 'PASS')).toThrow(
    'resolution-evidence-missing',
  );
  item = resolveFinding(item, item.condition, f.proof, 'architect', 'PASS');
  expect(item.original_fail).toEqual(f.proof);
  expect(() => recordCorrection(item, 'correction-3', 'architect', f.proof)).toThrow(
    'finding-already-resolved',
  );
  expect(() => resolveFinding(item, item.condition, f.proof, 'architect', 'PASS')).toThrow(
    'finding-already-resolved',
  );
  ledger = [item];
  expect(ledger[0]!.resolution).not.toBeNull();
});

it('invalidates answers for changed scope or role inputs, retaining only explicitly unaffected obligations', () => {
  const planning = f.council('planning');
  for (const trigger of [undefined, 'false', 0]) {
    const selection = {
      ...f.selection,
      architect: { ...f.selection.architect, trigger },
    } as unknown as Selection;
    expect(() => createCouncil('planning', selection, f.target)).toThrow('invalid-role-trigger');
    expect(() => councilBlockers({ ...planning, selection })).toThrow('invalid-role-trigger');
  }
  expect(() =>
    createCouncil(
      'planning',
      {
        ...f.selection,
        architect: { ...f.selection.architect, inputs: undefined },
      } as unknown as Selection,
      f.target,
    ),
  ).toThrow('missing-role-inputs');
  const differentScope = { ...f.target, scope: 'expanded' };
  expect(councilBlockers({ ...planning, target: differentScope })).toEqual([
    'architect:review-no-longer-applicable',
  ]);
  expect(revisePlanning(planning, f.selection, differentScope).advisers.architect!.status).toBe(
    'running',
  );
  const changed = {
    ...f.selection,
    architect: { ...f.selection.architect, inputs: { ...f.target.inputs, complete: false } },
  };
  expect(changedPlanningRoles(planning, changed)).toEqual(['architect']);
  expect(councilBlockers({ ...planning, selection: changed })).toEqual([
    'architect:review-no-longer-applicable',
  ]);
  expect(
    councilBlockers({
      ...planning,
      selection: {
        ...f.selection,
        architect: { ...f.selection.architect, requirements: [f.target.diff] },
      },
    }),
  ).toEqual(['architect:review-no-longer-applicable']);
  expect(
    councilBlockers({
      ...planning,
      advisers: { architect: { ...planning.advisers.architect!, reviewed: null } },
    }),
  ).toEqual(['architect:review-no-longer-applicable']);
  const unrelatedTarget = {
    ...f.target,
    diff: f.proof,
    inputs: { ...f.target.inputs, inputs: [...f.target.inputs.inputs, f.proof] },
  };
  expect(councilBlockers(revisePlanning(planning, f.selection, unrelatedTarget))).toEqual([]);
});

it('retains an unaffected reviewer only with an explicit unchanged role manifest and preserves FAIL history', async () => {
  const council = f.council('acceptance');
  council.selection.backend = { ...council.selection.backend, trigger: true };
  council.advisers.backend = structuredClone(council.advisers.architect!);
  const target = {
    ...f.target,
    inputs: { ...f.target.inputs, inputs: [{ locator: 'other.ts', hash: 'b'.repeat(64) }] },
  };
  expect(() => repeatCouncil(council, target, ['backend'])).toThrow('unreviewed-input-change');
  const repeated = repeatCouncil(council, target, ['backend'], council.selection);
  expect(repeated.advisers.architect).toEqual(council.advisers.architect);
  expect(repeated.advisers.backend!.status).toBe('running');
  expect(repeated.history).toEqual(council.history);
  for (const patch of [
    { inputs: { ...council.selection.architect.inputs, complete: false } },
    { requirements: [f.proof] },
  ])
    await expect(async () =>
      repeatCouncil(council, target, ['backend'], {
        ...council.selection,
        architect: { ...council.selection.architect, ...patch },
      }),
    ).rejects.toThrow('unreviewed-input-change');
  expect(() =>
    repeatCouncil(council, { ...target, scope: 'expanded' }, ['backend'], council.selection),
  ).toThrow('unreviewed-input-change');
  const failed = structuredClone(council);
  failed.advisers.architect!.answer!.verdict = 'FAIL';
  expect(() => repeatCouncil(failed, target, ['backend'], council.selection)).toThrow(
    'unreviewed-input-change',
  );
  await f.file(
    'repeat.json',
    JSON.stringify({
      schema_version: 1,
      root: f.root,
      evidence_root: f.root,
      council: f.council('acceptance'),
      target: f.target,
      roles: ['architect'],
      selection: f.selection,
    }),
  );
  expect(
    await runChatCommand(
      ['repeat-council', resolve(f.root, 'repeat.json')],
      () => {},
      () => {},
    ),
  ).toBe(0);
});

it('never reuses PASS when superseding an undispatched planning review and rejects unbound prior turns', () => {
  const accepted = f.council('planning');
  const pending = repeatCouncil(accepted, accepted.target, ['architect']);
  const proof = {
    role: 'architect' as const,
    session: 'session',
    answer_turn: accepted.advisers.architect!.answer!.binding!.answer_turn,
  };
  const next = revisePlanning(pending, pending.selection, pending.target, [proof]);
  expect(next.advisers.architect!.status).toBe('running');
  expect(next.advisers.architect!.answer).toBeNull();
  for (const patch of [
    { role: 'dba' as const },
    { session: 'other' },
    { answer_turn: 'unaccepted' },
  ])
    expect(() =>
      revisePlanning(pending, pending.selection, pending.target, [{ ...proof, ...patch }]),
    ).toThrow('planning-adviser-running');
});

it('reopens only a role whose substantive review rationale changed with identical files', () => {
  const planning = f.council('planning');
  const changed = structuredClone(planning.selection);
  changed.architect.reason = 'Проверить новую границу полномочий в прежних файлах';
  expect(changedPlanningRoles(planning, changed)).toEqual(['architect']);
  expect(revisePlanning(planning, changed, planning.target).advisers.architect!.status).toBe(
    'running',
  );
});

it('executes H02 through real Legacy council ports, preserves the initial FAIL and repeats only pricing', async () => {
  const context = await createH02LegacyFixture(
    join(f.root, 'h02-legacy'),
    new AbortController().signal,
  );
  const result = await runH02LegacyCase(context);
  expect(result.blocking).toEqual([]);
  expect(result).toMatchObject({
    outcome: 'accepted',
    variant: 'legacy',
    engine: 'legacy-council',
    nativeUsage: null,
    nativeAcceptance: false,
    qualification: false,
    partialScope: true,
    localRpcTurns: 8,
    stop: { readersStopped: true, transportClosed: true },
  });
  expect(result.checks).toEqual(
    Object.fromEntries(h02Scenario.checks.map((check) => [check, true])),
  );
  expect(result.effects).toEqual({
    threadStarts: 3,
    turnStarts: 8,
    byPhase: {
      initial: { threadStarts: 3, turnStarts: 6 },
      correction: { threadStarts: 0, turnStarts: 2 },
      probes: { threadStarts: 0, turnStarts: 0 },
    },
  });
  expect(
    result.localRpcObservations.filter((turn) => turn.kind === 'review').map((turn) => turn.role),
  ).toEqual(['pricing', 'logging', 'storage', 'pricing']);
  const initial = decodeChatArtifact(
    context.evidenceRoot,
    readFileSync(result.rounds.initial!.locator, 'utf8'),
  ) as { council: Council };
  const corrected = decodeChatArtifact(
    context.evidenceRoot,
    readFileSync(result.rounds.corrected!.locator, 'utf8'),
  ) as { council: Council };
  expect(initial.council.advisers.pricing!.answer!.verdict).toBe('FAIL');
  expect(corrected.council.advisers.pricing!.answer!.verdict).toBe('PASS');
  expect(
    corrected.council.history.find(
      (entry) => entry.role === 'pricing' && entry.answer.verdict === 'FAIL',
    )!.answer.evidence,
  ).toEqual(initial.council.advisers.pricing!.answer!.evidence);
  for (const role of ['logging', 'storage'])
    expect(corrected.council.advisers[role]).toEqual(initial.council.advisers[role]);
  expect(await checkH02Material(context.workspaceRoot)).toBe(true);
  expect(JSON.parse(readFileSync(join(context.workspaceRoot, 'pricing.json'), 'utf8'))).toEqual({
    rate: 7,
  });
  expect(Object.keys(result.probes).sort()).toEqual([
    'changed-dependency',
    'incomplete-map',
    'new-dependency',
    'open-fail',
    'role-rationale',
    'shared-scope',
    'unchanged-pass',
  ]);
}, 30_000);

it.each([
  'material',
  'roles',
  'roots',
  'unknown-rpc',
  'lost-session',
  'initial-turns',
  'correction-turns',
] as const)(
  'fails H02 Legacy safely on %s without a native model or a false accepted result',
  async (defect) => {
    const context = await createH02LegacyFixture(join(f.root, 'h02-legacy'));
    if (defect === 'material')
      writeFileSync(join(context.workspaceRoot, 'checks.mjs'), 'throw new Error("tampered");');
    if (defect === 'roles') delete context.configuration.profiles.storage;
    if (defect === 'roots') context.workspaceRoot = context.evidenceRoot;
    if (defect === 'unknown-rpc')
      vi.spyOn(context.rpc, 'request').mockRejectedValueOnce('unconfirmed local protocol');
    if (defect === 'lost-session') {
      const inspect = context.nativeSessions.inspect;
      vi.spyOn(context.nativeSessions, 'inspect').mockImplementation(async (id) =>
        context.counts().turnStarts >= 6 && id === 'h02-local-reader-1' ? null : inspect(id),
      );
    }
    if (defect === 'initial-turns') vi.spyOn(context, 'observations').mockReturnValue([]);
    if (defect === 'correction-turns') {
      const observed = context.observations;
      vi.spyOn(context, 'observations').mockImplementation(() =>
        observed().map((turn, index) => (index === 7 ? { ...turn, role: 'logging' } : turn)),
      );
    }
    const result = await runH02LegacyCase(context);
    expect(result.outcome).toBe('unknown');
    expect(result.blocking).toContain('h02-legacy-case-incomplete');
    expect(result).toMatchObject({
      nativeUsage: null,
      nativeAcceptance: false,
      qualification: false,
      partialScope: true,
      stop: { readersStopped: true, transportClosed: true },
    });
  },
  30_000,
);

it.each(['throw', 'readers', 'transport'] as const)(
  'does not confuse H02 Legacy %s cleanup with confirmed native STOP',
  async (defect) => {
    const context = await createH02LegacyFixture(join(f.root, 'h02-legacy')),
      stop = context.stop;
    context.stop = async () => {
      const result = await stop();
      if (defect === 'throw') throw new Error('local cleanup unavailable');
      return {
        ...result,
        ...(defect === 'readers' ? { readersStopped: false } : { transportClosed: false }),
      };
    };
    const result = await runH02LegacyCase(context);
    expect(result.outcome).toBe('unknown');
    expect(result.blocking).toContain('h02-legacy-stop-unconfirmed');
    expect(result.nativeAcceptance).toBe(false);
  },
  30_000,
);

it.each([
  'unexpected-missing',
  'unexpected-incomplete',
  'missing-non-error',
  'incomplete-non-error',
] as const)(
  'requires the actual H02 %s owner refusal rather than any exception',
  async (defect) => {
    const context = await createH02LegacyFixture(join(f.root, 'h02-legacy'));
    if (defect === 'unexpected-missing' || defect === 'missing-non-error') {
      const create = councilPolicy.createCouncil;
      vi.spyOn(councilPolicy, 'createCouncil').mockImplementation(
        (...args: Parameters<typeof create>) => {
          if (Object.keys(args[1]).length === 2) {
            if (defect === 'missing-non-error') throw 'unrelated failure';
            throw new Error('unrelated failure');
          }
          return create(...args);
        },
      );
    } else {
      const current = context.inputs.current.bind(context.inputs);
      vi.spyOn(context.inputs, 'current').mockImplementation(
        (...args: Parameters<typeof current>) => {
          if (!args[0].complete)
            return Promise.reject(
              defect === 'incomplete-non-error'
                ? 'unrelated failure'
                : new Error('unrelated failure'),
            );
          return current(...args);
        },
      );
    }
    const result = await runH02LegacyCase(context);
    expect(result.outcome).toBe('failed');
    expect(result.checks['incomplete-map']).toBe(false);
    expect(result.effects.byPhase.probes).toEqual({ threadStarts: 0, turnStarts: 0 });
  },
  30_000,
);

it('cancels H02 Legacy before another protocol effect and closes its own local reader port', async () => {
  const controller = new AbortController(),
    context = await createH02LegacyFixture(join(f.root, 'h02-legacy'), controller.signal),
    request = context.rpc.request;
  vi.spyOn(context.rpc, 'request').mockImplementation(async (method, params) => {
    const result = await request(method, params);
    controller.abort();
    return result;
  });
  const result = await runH02LegacyCase(context);
  expect(result.outcome).toBe('unknown');
  expect(result.effects).toMatchObject({ threadStarts: 1, turnStarts: 0 });
  expect(result.stop).toEqual({ readersStopped: true, transportClosed: true });
  await expect(
    context.rpc.request('thread/read', { threadId: 'h02-local-reader-1' }),
  ).rejects.toThrow();
}, 30_000);

it('keeps the fixed H02 local protocol isolated, rejects unknown methods and preserves normal recovery ports', async () => {
  const context = await createH02LegacyFixture(join(f.root, 'h02-legacy'));
  const session = await context.nativeSessions.create({
    model: context.spec.requested.model,
    effort: context.spec.requested.effort,
    reason: 'pricing',
  });
  expect(await context.nativeSessions.recoverSend(session, 'not-issued')).toBeNull();
  await expect(context.rpc.request('not-a-native-command', {})).rejects.toThrow(
    'h02-local-rpc-method',
  );
  await expect(context.rpc.completed(session.id, 'not-issued')).rejects.toThrow(
    'h02-local-turn-unconfirmed',
  );
  const before = context.counts();
  await context.stop();
  await expect(context.rpc.request('thread/start', {})).rejects.toThrow('h02-local-rpc-closed');
  expect(context.counts()).toEqual(before);
  await expect(createH02LegacyFixture('relative')).rejects.toThrow('h02-legacy-fixture-root');
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    createH02LegacyFixture(join(f.root, 'never-created'), cancelled.signal),
  ).rejects.toThrow();
}, 30_000);

it.each(['correction-observation', 'unchanged-capture', 'probe-refresh', 'cleanup'] as const)(
  'keeps H02 Legacy cancellation sticky at %s after all four review replies',
  async (boundary) => {
    const controller = new AbortController(),
      context = await createH02LegacyFixture(join(f.root, 'h02-late-cancel'), controller.signal);
    if (boundary === 'correction-observation') {
      const verify = context.nativeSessions.verifyReview;
      vi.spyOn(context.nativeSessions, 'verifyReview').mockImplementation(
        async (...args: Parameters<typeof verify>) => {
          const result = await verify(...args);
          if (context.counts().turnStarts === 8) controller.abort();
          return result;
        },
      );
    }
    if (boundary === 'unchanged-capture') {
      const capture = context.inputs.capture.bind(context.inputs);
      vi.spyOn(context.inputs, 'capture').mockImplementation(
        async (...args: Parameters<typeof capture>) => {
          const result = await capture(...args);
          if (context.counts().turnStarts === 8) controller.abort();
          return result;
        },
      );
    }
    if (boundary === 'probe-refresh') {
      const current = context.inputs.current.bind(context.inputs);
      vi.spyOn(context.inputs, 'current').mockImplementation(
        async (...args: Parameters<typeof current>) => {
          const result = await current(...args);
          const pricing = JSON.parse(
            readFileSync(join(context.workspaceRoot, 'pricing.json'), 'utf8'),
          ) as { rate: number };
          if (pricing.rate === 8) controller.abort();
          return result;
        },
      );
    }
    if (boundary === 'cleanup') {
      const stop = context.stop;
      context.stop = async () => {
        const result = await stop();
        controller.abort();
        return result;
      };
    }
    const stop = vi.spyOn(context, 'stop'),
      result = await runH02LegacyCase(context);
    expect(result.outcome).toBe('unknown');
    expect(result.blocking).toContain('h02-legacy-cancelled');
    expect(result.effects).toMatchObject({ threadStarts: 3, turnStarts: 8 });
    expect(
      result.localRpcObservations.filter((turn) => turn.kind === 'review').map((turn) => turn.role),
    ).toEqual(['pricing', 'logging', 'storage', 'pricing']);
    expect(result.stop).toEqual({ readersStopped: true, transportClosed: true });
    expect(stop).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(context.workspaceRoot, 'pricing.json'), 'utf8'))).toEqual({
      rate: 7,
    });
    if (boundary === 'cleanup') expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result).toMatchObject({
      nativeAcceptance: false,
      qualification: false,
      nativeUsage: null,
    });
  },
  30_000,
);

function h02NativeUnitContext() {
  const root = join(f.root, 'native-unit');
  mkdirSync(root);
  const put = (name: string, bytes: string): InputRef => {
    const path = join(root, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, bytes, { mode: 0o600 });
    return { locator: path, hash: digest(bytes) };
  };
  const roots = Object.fromEntries(
    ['workspaceRoot', 'writerRoot', 'evidenceRoot', 'artifactRoot', 'stateRoot', 'hostRoot'].map(
      (key) => {
        const path = join(root, key === 'workspaceRoot' ? 'writer/workspace' : key);
        mkdirSync(path, { recursive: true });
        return [key, path];
      },
    ),
  ) as unknown as H01AttemptContext['roots'];
  const controller = new AbortController(),
    pin = put('binary', 'Unit boundary only; never executed'),
    observer: H01NativeObserver = {
      controlRef: put('observer.json', '{}'),
      verify: vi.fn(async () => {}),
      beforeModelStart: vi.fn(async () => {}),
      confirmModelStart: vi.fn(),
      registerCreation: vi.fn(),
      registerCapabilities: vi.fn(),
      registerParticipant: vi.fn(),
      observeParticipant: vi.fn(),
      completeParticipant: vi.fn(),
      accounting: vi.fn(() => ({
        participants: [],
        receipts: [],
        reservedManagedStarts: null,
        observedResponses: null,
        inputUncached: null,
        inputCached: null,
        output: null,
        unknown: false,
        evidence: [],
      })),
    };
  const deadline = String(process.hrtime.bigint() + 20_000_000_000n),
    ctx = {
      opId: 'h02-native-unit',
      requestHash: digest('request'),
      variant: 'baseline',
      criteria: { ref: pin, value: { id: 'H-02', checks: h02Scenario.checks } },
      material: { ref: pin, value: h02Material },
      roots,
      identity: { owner: 'local-unit-owner' },
      profile: { model: 'deterministic-local-rpc', effort: 'fixture', clientVersion: '0.165.0' },
      binary: pin,
      rules: pin,
      executor: pin,
      reviewer: pin,
      runtime: { engine: 'legacy', root, files: [] },
      deadlineNs: deadline,
      workDeadlineNs: deadline,
      signal: controller.signal,
      nativeObserver: observer,
    } as unknown as H01AttemptContext;
  let live = true;
  const identity: ProcessIdentity = { pid: 71001, parent: process.pid, started: 'unit-pid-start' },
    thread: Record<string, unknown> = {
      id: 'unit-reader',
      cwd: roots.workspaceRoot,
      projectId: null,
      parentThreadId: null,
      forkedFromId: null,
      path: put('transcript.jsonl', '{}\n').locator,
      turns: [],
    };
  const response = () => ({
    cwd: roots.workspaceRoot,
    model: ctx.profile.model,
    reasoningEffort: ctx.profile.effort,
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
    thread: structuredClone(thread),
  });
  const raw = {
    pid: identity.pid,
    initialize: vi.fn(async () => {}),
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'model/list')
        return {
          data: [
            {
              model: ctx.profile.model,
              supportedReasoningEfforts: [{ reasoningEffort: ctx.profile.effort }],
            },
          ],
        };
      if (method === 'mcpServerStatus/list') return { data: [] };
      if (method === 'thread/start' || method === 'thread/resume') return response();
      if (method === 'thread/read') return { thread: structuredClone(thread) };
      if (method === 'thread/loaded/list') return { data: [thread.id], nextCursor: null };
      if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
      if (method === 'turn/start') {
        const turns = thread.turns as Record<string, unknown>[];
        const turn = {
          id: 'unit-turn-' + String(turns.length + 1),
          status: 'completed',
          items: [],
        };
        turns.push(turn);
        return { turn };
      }
      if (method === 'turn/interrupt') {
        for (const turn of thread.turns as Record<string, unknown>[])
          if (turn.id === params.turnId) turn.status = 'interrupted';
      }
      return {};
    }),
    completed: vi.fn(
      async (_id: string, _turn: string, _signal?: AbortSignal, verify?: () => Promise<void>) => {
        await verify?.();
      },
    ),
  };
  h02NativeBoundary.spawn.mockReset().mockReturnValue(raw);
  h02NativeBoundary.descendants
    .mockReset()
    .mockImplementation(async () => (live ? [identity] : []));
  h02NativeBoundary.alive
    .mockReset()
    .mockImplementation(async (ids: ProcessIdentity[]) => (live ? ids : []));
  h02NativeBoundary.terminate.mockReset().mockImplementation(async (ids: ProcessIdentity[]) => {
    if (ids.some((id) => id.pid === identity.pid)) live = false;
    return ids;
  });
  h02NativeBoundary.wait.mockReset().mockResolvedValue(undefined);
  const start = () => ({
    cwd: roots.workspaceRoot,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    model: ctx.profile.model,
    config: { model_reasoning_effort: ctx.profile.effort },
  });
  const turn = () => ({ threadId: 'unit-reader', input: [{ type: 'text', text: 'unit-turn' }] });
  return { ctx, controller, put, observer, raw, thread, identity, start, turn, response };
}

it('binds H02 native RPC starts, primary dispatches, participants and idempotent physical STOP', async () => {
  const unit = h02NativeUnitContext(),
    port = createH02NativeRpc(unit.ctx, 'legacy-pricing');
  expect(h02NativeBoundary.spawn).not.toHaveBeenCalled();
  expect(await port.rpc.request('model/list', {})).toMatchObject({
    data: [{ model: unit.ctx.profile.model }],
  });
  await port.rpc.request('thread/start', unit.start());
  await port.rpc.request('thread/name/set', { threadId: 'unit-reader', name: 'pricing' });
  await port.rpc.request('thread/resume', { ...unit.start(), threadId: 'unit-reader' });
  await port.rpc.request('mcpServerStatus/list', {});
  await port.rpc.request('turn/start', unit.turn());
  await port.rpc.request('turn/start', unit.turn());
  await port.rpc.request('thread/read', { threadId: 'unit-reader', includeTurns: true });
  await port.rpc.request('thread/loaded/list', {});
  const verify = vi.fn(async () => {});
  await port.rpc.completed('unit-reader', 'unit-turn-1', new AbortController().signal, verify);
  expect(verify).toHaveBeenCalledOnce();
  expect(unit.observer.beforeModelStart).toHaveBeenCalledTimes(2);
  const starts = vi.mocked(unit.observer.beforeModelStart).mock.calls.map(([value]) => value);
  expect(starts[0]!.key).not.toBe(starts[1]!.key);
  expect(starts.every((value) => value.origin === 'legacy' && value.stage === 'council')).toBe(
    true,
  );
  expect(unit.observer.confirmModelStart).toHaveBeenCalledTimes(2);
  expect(unit.observer.registerCreation).toHaveBeenCalledOnce();
  expect(unit.observer.registerParticipant).toHaveBeenCalled();
  const stop = port.stop();
  expect(port.stop()).toBe(stop);
  expect(nativeContract.h01ReadJson(await stop)).toMatchObject({
    kind: 'comparison-h02-stop',
    executionVersion: 2,
    opId: unit.ctx.opId,
    confirmed: true,
    readersStopped: true,
    transportClosed: true,
    sessions: ['unit-reader'],
    remainingProcesses: [],
  });
  expect(unit.raw.close).toHaveBeenCalledOnce();
  expect(unit.observer.completeParticipant).toHaveBeenCalledWith(
    'unit-reader',
    expect.objectContaining({ outcome: 'completed' }),
  );
  await expect(port.rpc.request('turn/start', unit.turn())).rejects.toThrow(
    'h02-native-rpc-frozen',
  );
}, 30_000);

it('reconciles the existing Temporal start credit and freezes if its callback changes the request', async () => {
  const unit = h02NativeUnitContext(),
    credit = vi.fn(async (params: Record<string, unknown>) => ({
      origin: 'temporal-host' as const,
      key: digest('existing-credit'),
      hash: digest(JSON.stringify(params)),
      session: textField(params.threadId),
      stage: 'council' as const,
    })),
    port = createH02NativeRpc(unit.ctx, 'temporal-reader', { startForTurn: credit });
  await port.rpc.request('thread/start', unit.start());
  await port.rpc.request('turn/start', unit.turn());
  expect(unit.observer.beforeModelStart).toHaveBeenCalledWith(await credit.mock.results[0]!.value);
  credit.mockImplementationOnce(async (params) => {
    params.extra = 'mutated';
    return {
      origin: 'temporal-host',
      key: digest('changed'),
      hash: digest(JSON.stringify(unit.turn())),
      session: 'unit-reader',
      stage: 'council',
    };
  });
  await expect(port.rpc.request('turn/start', unit.turn())).rejects.toThrow(
    'h02-native-rpc-request-changed',
  );
  expect(unit.raw.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  await port.stop();
}, 30_000);

it.each([
  'method',
  'session',
  'profile',
  'credit',
  'mutation',
  'abort-credit',
  'observer',
  'wait',
  'foreign-wait',
] as const)(
  'freezes H02 native dispatch at the %s boundary and retains cancellation-safe STOP',
  async (boundary) => {
    const unit = h02NativeUnitContext(),
      port = createH02NativeRpc(
        unit.ctx,
        'reader',
        boundary === 'credit'
          ? {
              startForTurn: async () => ({
                origin: 'legacy',
                key: digest('bad'),
                hash: digest('bad'),
                session: 'foreign',
                stage: 'execution',
              }),
            }
          : boundary === 'abort-credit'
            ? {
                startForTurn: async () => {
                  unit.controller.abort();
                  return {
                    origin: 'temporal-host',
                    key: digest('cancelled'),
                    hash: digest(JSON.stringify(unit.turn())),
                    session: 'unit-reader',
                    stage: 'council',
                  };
                },
              }
            : {},
      );
    await port.rpc.request('thread/start', unit.start());
    if (boundary === 'method')
      await expect(port.rpc.request('exec-anything', {})).rejects.toThrow('h02-native-rpc-method');
    if (boundary === 'session')
      await expect(port.rpc.request('thread/read', { threadId: 'foreign' })).rejects.toThrow(
        'h02-native-rpc-session',
      );
    if (boundary === 'profile')
      await expect(
        port.rpc.request('turn/start', { ...unit.turn(), model: 'other' }),
      ).rejects.toThrow('h02-native-rpc-profile');
    if (boundary === 'credit' || boundary === 'abort-credit')
      await expect(port.rpc.request('turn/start', unit.turn())).rejects.toThrow();
    if (boundary === 'mutation') {
      vi.mocked(unit.observer.beforeModelStart).mockImplementationOnce(async () => {
        unit.ctx.opId = 'changed';
      });
      await expect(port.rpc.request('turn/start', unit.turn())).rejects.toThrow(
        'h02-native-rpc-binding-changed',
      );
    }
    if (boundary === 'observer') {
      vi.mocked(unit.observer.beforeModelStart).mockRejectedValueOnce(new Error('no-credit'));
      await expect(port.rpc.request('turn/start', unit.turn())).rejects.toThrow('no-credit');
    }
    if (boundary === 'wait') {
      unit.raw.completed.mockRejectedValueOnce(new Error('wait-unknown'));
      await expect(port.rpc.completed('unit-reader', 'turn')).rejects.toThrow('wait-unknown');
    }
    if (boundary === 'foreign-wait')
      await expect(port.rpc.completed('foreign', 'turn')).rejects.toThrow('h02-native-rpc-session');
    const proof = object(nativeContract.h01ReadJson(await port.stop()));
    expect(proof.confirmed).toBe(true);
    expect(unit.raw.close).toHaveBeenCalledOnce();
    expect(unit.observer.completeParticipant).toHaveBeenCalledWith(
      'unit-reader',
      expect.objectContaining({ outcome: 'unknown' }),
    );
    expect(unit.raw.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
      0,
    );
  },
  30_000,
);

it.each([
  'pid',
  'identity',
  'model',
  'caps',
  'initialize',
  'effective',
  'history',
  'thread-identity',
  'no-path',
  'loaded',
] as const)(
  'keeps H02 native initialization and identity proof strict for %s',
  async (boundary) => {
    const unit = h02NativeUnitContext(),
      normal = unit.raw.request.getMockImplementation()!;
    if (boundary === 'pid') unit.raw.pid = 0;
    if (boundary === 'identity') h02NativeBoundary.descendants.mockResolvedValue([]);
    if (boundary === 'initialize')
      unit.raw.initialize.mockRejectedValueOnce(new Error('init-unknown'));
    unit.raw.request.mockImplementation(async (method, params) => {
      if (boundary === 'model' && method === 'model/list') return { data: [] };
      if (boundary === 'caps' && method === 'mcpServerStatus/list')
        return { data: [], nextCursor: 'unknown-more' };
      const value = await normal(method, params);
      if (method === 'thread/start') {
        if (boundary === 'effective') object(value).model = 'other';
        if (boundary === 'history') object(object(value).thread).turns = [{ id: 'old' }];
        if (boundary === 'thread-identity') object(object(value).thread).projectId = 'foreign';
        if (boundary === 'no-path') delete object(object(value).thread).path;
      }
      if (boundary === 'loaded' && method === 'thread/loaded/list') return { data: ['foreign'] };
      return value;
    });
    const port = createH02NativeRpc(unit.ctx, 'reader');
    if (boundary === 'no-path' || boundary === 'loaded') {
      await port.rpc.request('thread/start', unit.start());
      if (boundary === 'loaded')
        await expect(port.rpc.request('thread/loaded/list', {})).rejects.toThrow(
          'h02-native-rpc-loaded-unknown',
        );
      else expect(unit.observer.registerParticipant).not.toHaveBeenCalled();
    } else await expect(port.rpc.request('thread/start', unit.start())).rejects.toThrow();
    const proof = object(nativeContract.h01ReadJson(await port.stop()));
    expect(proof.confirmed).toBe(!['pid', 'identity', 'loaded'].includes(boundary));
    expect(unit.raw.close).toHaveBeenCalledOnce();
  },
  30_000,
);

it.each([
  'terminal',
  'history',
  'active',
  'survivor',
  'process-proof',
  'usage',
  'active-cancel',
  'interrupt',
] as const)(
  'does not hide H02 native STOP uncertainty at %s',
  async (boundary) => {
    const unit = h02NativeUnitContext(),
      port = createH02NativeRpc(unit.ctx, 'reader');
    await port.rpc.request('thread/start', unit.start());
    const normal = unit.raw.request.getMockImplementation()!;
    unit.raw.request.mockImplementation(async (method, params) => {
      if (boundary === 'terminal' && method === 'thread/backgroundTerminals/list')
        return { data: [{ processId: 'unknown' }] };
      if (boundary === 'history' && method === 'thread/read')
        return { thread: { id: 'foreign', turns: [] } };
      return normal(method, params);
    });
    if (boundary === 'active')
      unit.thread.turns = [
        { id: 'a', status: 'inProgress' },
        { id: 'b', status: 'inProgress' },
      ];
    if (boundary === 'interrupt') unit.thread.turns = [{ id: 'active', status: 'inProgress' }];
    if (boundary === 'active-cancel') {
      unit.thread.turns = [{ id: 'active', status: 'inProgress' }];
      unit.controller.abort();
      await expect(port.rpc.request('turn/start', unit.turn())).rejects.toThrow();
      expect(await port.rpc.request('thread/read', { threadId: 'unit-reader' })).toMatchObject({
        thread: { id: 'unit-reader' },
      });
      await port.rpc.request('turn/interrupt', { threadId: 'unit-reader', turnId: 'active' });
      await port.rpc.request('thread/backgroundTerminals/list', { threadId: 'unit-reader' });
      await port.rpc.request('thread/backgroundTerminals/terminate', {
        threadId: 'unit-reader',
        processId: 'none',
      });
    }
    if (boundary === 'survivor')
      h02NativeBoundary.alive.mockImplementation(async (ids: ProcessIdentity[]) => ids);
    if (boundary === 'process-proof') {
      const record = nativeContract.h01Record;
      vi.spyOn(nativeContract, 'h01Record').mockImplementation((root, label, value) => {
        if (label.endsWith('-process-stop')) throw new Error('disk-write-failed');
        return record(root, label, value);
      });
    }
    if (boundary === 'usage')
      vi.mocked(unit.observer.completeParticipant).mockImplementationOnce(() => {
        throw new Error('missing-primary-usage');
      });
    const proof = object(nativeContract.h01ReadJson(await port.stop()));
    expect(proof.confirmed).toBe(['usage', 'active-cancel', 'interrupt'].includes(boundary));
    if (boundary === 'process-proof') {
      expect(proof.readersStopped).toBe(true);
      expect(proof.transportClosed).toBe(false);
      expect(proof.remainingProcesses).toEqual([]);
      expect(h02NativeBoundary.terminate).toHaveBeenLastCalledWith([unit.identity]);
    }
    if (boundary === 'active-cancel')
      expect(unit.observer.completeParticipant).toHaveBeenCalledWith(
        'unit-reader',
        expect.objectContaining({ outcome: 'unknown' }),
      );
    if (boundary === 'usage')
      expect(
        port.evidence.some(
          (ref) => object(nativeContract.h01ReadJson(ref)).kind === 'h02-native-accounting-unknown',
        ),
      ).toBe(true);
    expect(unit.raw.close).toHaveBeenCalledOnce();
  },
  30_000,
);

it('retains a no-process STOP on early abort, refuses context and does not reset expired clocks', async () => {
  const unit = h02NativeUnitContext();
  expect(() => createH02NativeRpc(unit.ctx, '../unsafe')).toThrow('h02-native-rpc-context');
  const port = createH02NativeRpc(unit.ctx, 'reader');
  unit.controller.abort();
  await expect(port.rpc.request('thread/read', { threadId: 'unknown' })).rejects.toThrow();
  expect(object(nativeContract.h01ReadJson(await port.stop()))).toMatchObject({
    confirmed: true,
    sessions: [],
  });
  expect(h02NativeBoundary.spawn).not.toHaveBeenCalled();
}, 30_000);

async function h02LegacyBackendUnit() {
  const unit = h02NativeUnitContext(),
    local = await createH02LegacyFixture(join(f.root, 'backend-protocol'));
  unit.ctx.roots.workspaceRoot = local.workspaceRoot;
  unit.ctx.roots.evidenceRoot = local.evidenceRoot;
  const rules = 'Unit rules: preserve primary FAIL and immutable evidence.\n',
    reviewer = 'Unit reviewer: real scope and source binding.\n';
  unit.ctx.rules = unit.put('rules.md', rules);
  unit.ctx.reviewer = unit.put('reviewer.md', reviewer);
  for (const [name, bytes] of Object.entries(h02PreparedMetadata(rules, reviewer))) {
    mkdirSync(resolve(join(local.workspaceRoot, name), '..'), { recursive: true });
    writeFileSync(join(local.workspaceRoot, name), bytes, { mode: 0o600 });
  }
  const descriptor = unit.put(
    'runtime/project/workflow.json',
    readFileSync(new URL('../project/workflow.json', import.meta.url), 'utf8'),
  );
  unit.ctx.runtime = {
    engine: 'legacy',
    root: resolve(descriptor.locator, '../..'),
    files: [
      descriptor,
      ...local.spec.procedures.map((procedure) =>
        unit.put(
          'runtime/' + procedure.locator,
          readFileSync(join(local.workspaceRoot, procedure.locator), 'utf8'),
        ),
      ),
    ],
  };
  const actualRpc = local.rpc,
    created: string[] = [],
    observations = new Map<string, string>();
  let cleanupAborts = false,
    stopRejects = false,
    stopMalformed = false;
  vi.spyOn(nativeRpcModule, 'createH02NativeRpc').mockImplementation((_ctx, label) => {
    created.push(label);
    const refs: InputRef[] = [];
    let own: string | null = null;
    const rpc: AppServerRpc = {
      async request(method, params) {
        const response = await actualRpc.request(method, params);
        if (method === 'thread/start') own = textField(object(object(response).thread).id);
        if (['thread/start', 'thread/resume', 'thread/read'].includes(method))
          object(object(response).thread).path = unit.put(
            'transcripts/' + String(own) + '.jsonl',
            '{}\n',
          ).locator;
        if (method === 'thread/name/set')
          observations.set(textField(params.threadId), textField(params.name));
        return response;
      },
      completed: (...args) => actualRpc.completed(...args),
    };
    return {
      rpc,
      evidence: refs,
      async stop() {
        if (cleanupAborts) unit.controller.abort();
        if (stopRejects) throw new Error('physical-stop-unknown');
        const ref = nativeContract.h01Record(
          local.evidenceRoot,
          'unit-native-stop-' + label,
          stopMalformed
            ? { kind: 'foreign-stop' }
            : {
                kind: 'comparison-h02-stop',
                executionVersion: 2,
                opId: unit.ctx.opId,
                confirmed: true,
                readersStopped: true,
                transportClosed: true,
                sessions: own === null ? [] : [own],
                remainingProcesses: [],
                evidence: [],
              },
        );
        refs.push(ref);
        return ref;
      },
    };
  });
  vi.spyOn(chatPeerModule, 'inspectChatPeer').mockImplementation(
    async (rpc, roles, id, _evidence, _child, councilProject) => {
      const thread = object(
          object(await rpc.request('thread/read', { threadId: id, includeTurns: true })).thread,
        ),
        session = await local.nativeSessions.inspect(id);
      if (session === null) throw new Error('unit-session-missing');
      return {
        ...session,
        project_id: councilProject!,
        native_child: false,
        name: observations.get(id)!,
        observed_turn: textField(object((thread.turns as unknown[]).at(-1)).id),
        workspace: textField(object(object(roles.peer_observations)[id]).root),
      };
    },
  );
  return {
    ...unit,
    local,
    created,
    options: (options: {
      cleanupAborts?: boolean;
      stopRejects?: boolean;
      stopMalformed?: boolean;
    }) => {
      cleanupAborts = options.cleanupAborts ?? false;
      stopRejects = options.stopRejects ?? false;
      stopMalformed = options.stopMalformed ?? false;
    },
  };
}

it('assembles native H02 Legacy around the existing council case and keeps its primary FAIL, reuse and corrected proof', async () => {
  const unit = await h02LegacyBackendUnit();
  const run = legacyCaseModule.runH02LegacyCase;
  vi.spyOn(legacyCaseModule, 'runH02LegacyCase').mockImplementation(async (context) => {
    const create = context.nativeSessions.create;
    vi.spyOn(context.nativeSessions, 'create').mockImplementation(async (profile) => {
      const session = await create(profile);
      expect(await context.nativeSessions.recoverSend(session, 'never-issued')).toBeNull();
      return session;
    });
    return run(context);
  });
  const result = await createH02NativeLegacyAdapter().execute(unit.ctx);
  expect(result.outcome).toBe('completed');
  expect(unit.created).toEqual(['legacy-pricing', 'legacy-logging', 'legacy-storage']);
  expect(h02NativeBoundary.spawn).not.toHaveBeenCalled();
  const projection = object(nativeContract.h01ReadJson(result.projection));
  expect(projection).toMatchObject({
    kind: 'comparison-h02-native-projection',
    scenario: 'H-02',
    opId: unit.ctx.opId,
    engine: 'legacy',
  });
  const report = object(
    decodeChatArtifact(
      unit.local.evidenceRoot,
      nativeContract.h01ReadPin(projection.caseReport as InputRef).toString(),
    ),
  );
  expect(report).toMatchObject({
    outcome: 'accepted',
    nativeAcceptance: false,
    qualification: false,
    partialScope: true,
    effects: { threadStarts: 3, turnStarts: 8 },
  });
  expect(Object.values(object(report.checks)).every(Boolean)).toBe(true);
  expect(result.nativeAcceptance).toEqual(object(report.rounds).corrected);
  expect(nativeContract.h01ReadJson(result.stop)).toMatchObject({
    kind: 'comparison-h02-stop',
    confirmed: true,
    readersStopped: true,
    transportClosed: true,
    sessions: ['h02-local-reader-1', 'h02-local-reader-2', 'h02-local-reader-3'],
    remainingProcesses: [],
  });
  const negative = object(
    decodeChatArtifact(
      unit.local.evidenceRoot,
      nativeContract.h01ReadPin(object(report.probes)['incomplete-map'] as InputRef).toString(),
    ),
  );
  expect(negative).toMatchObject({
    missing: true,
    incomplete: true,
    missingError: 'missing-role-selection',
    incompleteError: 'pricing:incomplete-inputs',
  });
  expect(object(object(negative.missingBasis).selection).pricing).toBeUndefined();
  expect(object(object(object(negative.incompleteBasis).council).selection).pricing).toMatchObject({
    inputs: { complete: false },
  });
}, 30_000);

it.each([
  'metadata',
  'descriptor',
  'procedure-count',
  'procedure-pin',
  'abort',
  'accounting',
  'cleanup-abort',
  'stop-reject',
  'stop-malformed',
  'case-fail',
] as const)(
  'keeps H02 native Legacy unknown or failed at %s without inventing acceptance',
  async (boundary) => {
    const unit = await h02LegacyBackendUnit();
    if (boundary === 'metadata')
      writeFileSync(join(unit.local.workspaceRoot, '.h02/pricing.md'), 'wrong-role');
    if (boundary === 'descriptor') unit.ctx.runtime.files = [];
    if (boundary === 'procedure-count') {
      const ref = unit.ctx.runtime.files[0]!,
        descriptor = object(nativeContract.h01ReadJson(ref));
      descriptor.procedures = [];
      writeFileSync(ref.locator, JSON.stringify(descriptor));
      ref.hash = digest(readFileSync(ref.locator));
    }
    if (boundary === 'procedure-pin') unit.ctx.runtime.files.splice(1, 1);
    if (boundary === 'abort') unit.controller.abort();
    if (boundary === 'accounting')
      vi.mocked(unit.observer.accounting).mockReturnValue({
        ...unit.observer.accounting(),
        unknown: true,
      });
    if (boundary === 'cleanup-abort') unit.options({ cleanupAborts: true });
    if (boundary === 'stop-reject') unit.options({ stopRejects: true });
    if (boundary === 'stop-malformed') unit.options({ stopMalformed: true });
    if (boundary === 'case-fail') {
      const basis = councilPolicy.councilReviewBasis;
      vi.spyOn(councilPolicy, 'councilReviewBasis').mockImplementation((...args) => ({
        ...basis(...args),
        rationale: 'unchanged',
      }));
    }
    const result = await createH02NativeLegacyAdapter().execute(unit.ctx);
    expect(result.outcome).toBe(boundary === 'case-fail' ? 'failed' : 'unknown');
    expect(nativeContract.h01ReadJson(result.projection)).toMatchObject({
      kind: 'comparison-h02-native-projection',
      scenario: 'H-02',
    });
    if (
      ['metadata', 'descriptor', 'procedure-count', 'procedure-pin', 'abort'].includes(boundary)
    ) {
      expect(unit.created).toEqual([]);
      expect(result.nativeAcceptance).toBeNull();
    }
  },
  30_000,
);

it('pins disabled MCP switches and the safe environment without inheriting an undeclared PATH', async () => {
  const unit = h02NativeUnitContext();
  unit.ctx.disabledMcpServers = ['unit-disabled'];
  const previous = process.env.PATH;
  delete process.env.PATH;
  try {
    const port = createH02NativeRpc(unit.ctx, 'reader');
    await port.rpc.request('thread/start', unit.start());
    await port.rpc.request('turn/start', {
      ...unit.turn(),
      model: unit.ctx.profile.model,
      effort: unit.ctx.profile.effort,
    });
    expect(h02NativeBoundary.spawn.mock.calls[0]![1]).toContain(
      'mcp_servers.unit-disabled.enabled=false',
    );
    const params = unit.raw.request.mock.calls.find(([method]) => method === 'thread/start')![1];
    expect(object(object(params.config).shell_environment_policy).set).toMatchObject({
      PATH: '/usr/bin:/bin',
      TMPDIR: unit.ctx.roots.workspaceRoot,
    });
    await port.stop();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}, 30_000);

it.each(['deadline', 'cancel'] as const)(
  'bounds a pending native initialization by %s and leaves STOP accessible',
  async (boundary) => {
    const unit = h02NativeUnitContext();
    let entered!: () => void, finish!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    unit.raw.initialize.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    if (boundary === 'deadline')
      unit.ctx.workDeadlineNs = String(process.hrtime.bigint() + 60_000_000n);
    const port = createH02NativeRpc(unit.ctx, 'reader'),
      request = port.rpc.request('thread/start', unit.start());
    const rejected = expect(request).rejects.toThrow(
      boundary === 'deadline' ? 'h02-native-rpc-deadline' : 'h02-native-rpc-cancelled',
    );
    await entering;
    if (boundary === 'cancel') unit.controller.abort();
    await rejected;
    finish();
    await expect(port.rpc.request('thread/loaded/list', {})).rejects.toThrow(
      'h02-native-rpc-session',
    );
    expect(nativeContract.h01ReadJson(await port.stop())).toMatchObject({
      confirmed: true,
      sessions: [],
      transportClosed: true,
    });
    expect(
      unit.raw.request.mock.calls.filter(([method]) => method === 'thread/start'),
    ).toHaveLength(0);
  },
  30_000,
);
