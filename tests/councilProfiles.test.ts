import {
  answerCouncil,
  assignAdviser,
  changedPlanningRoles,
  councilBlockers,
  councilCurrentProfileRefs,
  councilProfileRefs,
  councilRoles,
  councilAdviserName,
  councilAdviserTaskName,
  createCouncil,
  revisePlanning,
  repeatCouncil,
} from '../core/council.js';
import { fileRunInputs } from '../adapters/project/fileRunInputs.js';
import { designReviewFixture, workflowFixture } from './workflowFixtures.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;

it('provides distinct readable names and valid native task names for all council roles', () => {
  const names = councilRoles.map(councilAdviserName);
  expect(new Set(names).size).toBe(councilRoles.length);
  for (const role of councilRoles) {
    expect(councilAdviserName(role)).toMatch(/^Советник: [А-Я]/u);
    expect(councilAdviserTaskName(role)).toMatch(/^council_[a-z_]+$/u);
  }
  expect(councilAdviserTaskName('system-analyst')).toBe('council_system_analyst');
});
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});
function roleRun(role: (typeof councilRoles)[number]) {
  const rules = [...f.spec.rules, ...f.profiles[role]];
  return {
    ...f.adviser,
    spec: { ...f.adviser.spec, rules, sources: [...f.spec.sources, ...f.profiles[role]] },
    loaded: { ...f.adviser.loaded!, rules },
  };
}

it.each(councilRoles)(
  'loads only the common rules and selected %s profile with exact file hashes',
  async (role) => {
    const run = roleRun(role);
    const selection = Object.fromEntries(
      councilRoles.map((id) => [
        id,
        {
          ...f.selection[id],
          trigger: id === role,
        },
      ]),
    ) as typeof f.selection;
    const council = createCouncil('planning', selection, f.target);
    expect(councilCurrentProfileRefs(council)).toEqual(f.profiles[role]);
    await fileRunInputs(f.root, 'connection.json').verify(run);
    const assigned = assignAdviser(council, role, run);
    const answer = f.answer(assigned);
    if (role === 'ui-ux-designer')
      answer.design = designReviewFixture('planning', f.target.inputs.inputs[0]!);
    const answered = answerCouncil(assigned, role, run.spec.session_id, answer);
    expect(councilBlockers(answered)).toEqual([]);
    const old = structuredClone(answered);
    old.advisers[role]!.run.spec.rules = f.spec.rules;
    old.advisers[role]!.run.loaded!.rules = f.spec.rules;
    expect(() => councilBlockers(old)).toThrow('council-profile-not-loaded');
  },
);

it('rejects missing, duplicate, malformed or foreign profiles and incomplete observed LOAD', () => {
  const council = createCouncil('planning', f.selection, f.target);
  for (const requirements of [
    [],
    [f.proof],
    [f.profiles.architect[1]!],
    [...f.profiles.backend],
    [...f.profiles.architect, f.profiles.architect[1]!],
    f.profiles.architect.map((ref) => ({ ...ref, hash: 'unconfirmed' })),
  ])
    expect(() => councilProfileRefs('architect', requirements)).toThrow('council-profile-required');
  for (const patch of [
    { rules: f.spec.rules },
    { sources: f.spec.sources },
    { sources: [...f.spec.sources, ...f.profiles.backend] },
  ]) {
    const spec = { ...f.adviser.spec, ...patch };
    const run = { ...f.adviser, spec, loaded: { ...f.adviser.loaded!, rules: spec.rules } };
    expect(() => assignAdviser(council, 'architect', run)).toThrow('council-profile-not-loaded');
  }
  const unread = { ...f.adviser, loaded: { ...f.adviser.loaded!, rules: f.spec.rules } };
  expect(() => assignAdviser(council, 'architect', unread)).toThrow('rules-not-loaded');
  const assigned = assignAdviser(council, 'architect', f.adviser);
  assigned.advisers.architect!.run.loaded = null;
  expect(() => answerCouncil(assigned, 'architect', 'session', f.answer(assigned))).toThrow(
    'council-profile-not-loaded',
  );
});

it('invalidates only affected roles, keeps history, and requires reloading the changed profile', async () => {
  const planning = f.council('planning');
  const path = f.profiles.architect[1]!.locator;
  await f.file(path, '# Updated architect expertise\n');
  const changed = await f.ref(path);
  const requirements = [f.proof, f.profiles.architect[0]!, changed];
  const selection = { ...f.selection, architect: { ...f.selection.architect, requirements } };
  expect(changedPlanningRoles(planning, selection)).toEqual(['architect']);
  const next = revisePlanning(planning, selection, f.target);
  expect(next.history).toEqual(planning.history);
  expect(() => answerCouncil(next, 'architect', 'session', f.answer(next))).toThrow(
    'council-profile-not-loaded',
  );
  await expect(fileRunInputs(f.root, 'connection.json').verify(f.adviser)).rejects.toThrow(
    'source-revision-mismatch',
  );
  const rules = [...f.spec.rules, f.profiles.architect[0]!, changed];
  next.advisers.architect!.run = {
    ...f.adviser,
    spec: { ...f.adviser.spec, rules, sources: [...f.spec.sources, ...rules] },
    loaded: { ...f.adviser.loaded!, rules },
  };
  await fileRunInputs(f.root, 'connection.json').verify(next.advisers.architect!.run);
  expect(() =>
    answerCouncil(next, 'architect', 'session', planning.advisers.architect!.answer!),
  ).toThrow('review-input-binding-mismatch');
  const completed = answerCouncil(next, 'architect', 'session', f.answer(next));
  expect(councilBlockers(completed)).toEqual([]);
  expect(completed.history).toHaveLength(1);
  expect(completed.review_turns).toHaveLength(2);
});

describe.each([
  'mobile-game-developer',
  'methodologist-literary-editor',
  'ui-ux-designer',
] as const)('adding %s to a legacy council', (role) => {
  it.each([true, null, false])(
    'preserves history and requires explicit applicability and review for trigger=%s',
    (trigger) => {
      const legacy = f.council('planning');
      if (role !== 'ui-ux-designer') {
        Reflect.deleteProperty(legacy.selection, 'mobile-game-developer');
        Reflect.deleteProperty(legacy.selection, 'methodologist-literary-editor');
      } else Reflect.deleteProperty(legacy.selection, role);
      const original = structuredClone(legacy);
      expect(() => councilBlockers(legacy)).toThrow('missing-role-selection');
      expect(() => revisePlanning(legacy, legacy.selection, f.target)).toThrow(
        'missing-role-selection',
      );

      const selection = { ...f.selection, [role]: { ...f.selection[role], trigger } };
      expect(changedPlanningRoles(legacy, selection)).toEqual(trigger === false ? [] : [role]);
      const revised = revisePlanning(legacy, selection, f.target);
      expect(Object.keys(revised.selection)).toEqual(councilRoles);
      expect(revised.selection[role].trigger).toBe(trigger);
      expect(revised.history).toEqual(original.history);
      expect(revised.history).not.toBe(legacy.history);
      expect(revised.advisers.architect).toEqual(original.advisers.architect);
      expect(revised.advisers[role]).toBeUndefined();
      expect(councilBlockers(revised)).toEqual(
        trigger === false
          ? []
          : [`${role}:${trigger === null ? 'applicability-unknown' : 'NOT RUN'}`],
      );
      if (trigger === true) {
        expect(() => assignAdviser(revised, role, f.adviser)).toThrow('council-profile-not-loaded');
        const assigned = assignAdviser(revised, role, roleRun(role));
        expect(councilBlockers(assigned)).toEqual([`${role}:running`]);
      }
      expect(legacy).toEqual(original);
    },
  );
});

it('keeps legacy records readable but blocks admission without a current native binding', () => {
  const answered = f.council('planning');
  const legacy = structuredClone(answered);
  delete legacy.advisers.architect!.answer!.binding;
  expect(() => councilBlockers(legacy)).toThrow('native-review-binding-required');
  const assigned = assignAdviser(
    createCouncil('planning', f.selection, f.target),
    'architect',
    f.adviser,
  );
  const answer = f.answer(assigned);
  for (const binding of [undefined, { ...answer.binding!, schema_version: 2 }]) {
    expect(() =>
      answerCouncil(assigned, 'architect', 'session', { ...answer, binding } as typeof answer),
    ).toThrow('native-review-binding-required');
  }
  expect(() =>
    answerCouncil(assigned, 'architect', 'session', {
      ...answer,
      binding: { ...answer.binding!, answer_evidence: { ...f.proof, hash: 'other' } },
    }),
  ).toThrow('review-input-binding-mismatch');
  expect(() =>
    answerCouncil(assigned, 'architect', 'session', {
      ...answer,
      binding: { ...answer.binding!, answer_turn: 'load' },
    }),
  ).toThrow('review-before-load');
  expect(() =>
    answerCouncil(
      repeatCouncil(answered, f.target, ['architect']),
      'architect',
      'session',
      answered.advisers.architect!.answer!,
    ),
  ).toThrow('review-turn-already-used');
  const missingLoad = structuredClone(assigned);
  delete missingLoad.advisers.architect!.run.loaded!.native;
  expect(() => answerCouncil(missingLoad, 'architect', 'session', answer)).toThrow(
    'native-council-load-required',
  );
  const missingOrigin = structuredClone(assigned);
  delete missingOrigin.advisers.architect!.run.loaded!.origin;
  expect(() => answerCouncil(missingOrigin, 'architect', 'session', answer)).toThrow(
    'native-council-origin-required',
  );
});

it('keeps profile rules unavailable to unrelated data roles and ignores non-applicable profiles', async () => {
  const explorer = { ...f.adviser, spec: { ...f.adviser.spec, role: 'explorer' as const } };
  await expect(fileRunInputs(f.root, 'connection.json').verify(explorer)).rejects.toThrow(
    'rules-version-mismatch',
  );
  const council = createCouncil(
    'planning',
    {
      ...f.selection,
      architect: { ...f.selection.architect, trigger: false, requirements: [f.proof] },
    },
    f.target,
  );
  expect(councilCurrentProfileRefs(council)).toEqual([]);
  expect(councilBlockers(council)).toEqual([]);
});
