import { observeChatCouncil } from '../application/chatCouncil.js';
import { createCouncil, repeatCouncil } from '../core/council.js';
import type { CouncilSessions } from '../ports/agentSessions.js';
import type { AgentSession, DataAnswer } from '../core/dataRoute.js';
import { designReviewFixture, workflowFixture } from './workflowFixtures.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});
function sessions() {
  const actual: AgentSession = {
    id: 'session',
    model: f.adviser.spec.requested.model,
    effort: 'high',
    workspace: f.root,
    project_id: 'project',
    parent_id: null,
    native_child: false,
    observed_turn: 'turn',
    name: 'Советник: Архитектор',
    read_only: true,
    network: false,
    forked_from: null,
    initial_turns: 0,
    receipt: f.proof,
  };
  const council = createCouncil('planning', f.selection, f.target);
  const raw = { ...f.answer(council), evidence: { locator: 'untrusted-model-claim', hash: 'bad' } };
  const answer: DataAnswer = {
    outcome: 'PASS',
    scope: [f.target.scope],
    sources: raw.sources,
    coverage: 'complete',
    content: JSON.stringify(raw),
    limitations: ['explicit test double'],
    continuation: null,
    evidence: f.proof,
  };
  const port: CouncilSessions = {
    inspect: async () => actual,
    poll: async () => ({ status: 'completed', answer }),
    verifyReview: async (_session, request, turn, evidence) => ({
      schema_version: 1,
      request,
      load_turn: 'load',
      answer_turn: turn,
      answer_evidence: evidence,
      evidence: f.proof,
    }),
  };
  return { actual, council, answer, port };
}

it('binds separate designer assessments and checks binary screenshot and interaction bytes', async () => {
  const s = sessions();
  const role = 'ui-ux-designer';
  s.council.phase = 'acceptance';
  s.council.selection.architect.trigger = false;
  s.council.selection[role].trigger = true;
  s.actual.name = 'Советник: Дизайнер UI/UX';
  const image = Buffer.from('89504e470d0a1a0a00ff80fe', 'hex');
  await writeFile(resolve(f.root, 'screen.png'), image);
  await f.file('interaction.txt', 'Fixture: open help, close, input and focus preserved');
  s.council.target.inputs = await f.inputs.capture(
    { files: ['source.txt', 'screen.png', 'interaction.txt'], directories: [] },
    'designer fixture',
  );
  const design = designReviewFixture('acceptance', await f.inputs.ref('screen.png'));
  design.ux.evidence[0]!.artifacts = [await f.inputs.ref('interaction.txt')];
  const rules = [...f.spec.rules, ...f.profiles[role]];
  const run = {
    ...f.adviser,
    spec: { ...f.adviser.spec, rules, sources: [...f.spec.sources, ...f.profiles[role]] },
    loaded: { ...f.adviser.loaded!, rules },
  };
  s.answer.content = JSON.stringify({ ...f.answer(s.council), design });
  const result = await observeChatCouncil(
    s.council,
    role,
    run,
    'turn',
    'principal',
    s.port,
    f.inputs,
  );
  expect(result.advisers[role]!.answer!.design).toEqual(design);
  expect(result.advisers[role]!.answer!.binding!.request.role).toBe(role);
  expect(result.advisers[role]!.answer!.binding!.request.phase).toBe('acceptance');
  const incomplete = structuredClone(design);
  Object.assign(incomplete.ux, { verdict: 'NOT RUN', coverage: 'partial', evidence: [] });
  s.answer.outcome = 'NOT RUN';
  s.answer.content = JSON.stringify({
    ...f.answer(s.council),
    design: incomplete,
    verdict: 'NOT RUN',
    coverage: 'partial',
  });
  const notRun = await observeChatCouncil(
    s.council,
    role,
    run,
    'turn',
    'principal',
    s.port,
    f.inputs,
  );
  expect(notRun.history[0]!.answer).toMatchObject({
    verdict: 'NOT RUN',
    coverage: 'partial',
    design: { ui: { verdict: 'PASS' }, ux: { verdict: 'NOT RUN' } },
  });
  for (const [path, content] of [
    ['screen.png', Buffer.from('89504e470d0a1a0a00ff81fe', 'hex')],
    ['interaction.txt', Buffer.from('Other scenario')],
  ] as const) {
    await writeFile(resolve(f.root, path), content);
    await expect(
      observeChatCouncil(s.council, role, run, 'turn', 'principal', s.port, f.inputs),
    ).rejects.toThrow('workflow-input-changed');
    await writeFile(resolve(f.root, 'screen.png'), image);
  }
});

it('accepts implemented target bytes while retaining the approved planning input snapshot', async () => {
  const s = sessions();
  s.council.phase = 'acceptance';
  await f.file('implementation.txt', 'Before implementation');
  const planned = await f.inputs.capture(
    { files: ['implementation.txt'], directories: [] },
    'owner',
  );
  s.council.selection.architect.inputs = planned;
  await f.file('implementation.txt', 'Implemented after planning');
  s.council.target.inputs = await f.inputs.current(planned);
  s.answer.content = JSON.stringify(f.answer(s.council));
  const result = await observeChatCouncil(
    s.council,
    'architect',
    f.adviser,
    'turn',
    'principal',
    s.port,
    f.inputs,
  );
  expect(result.advisers.architect!.answer!.verdict).toBe('PASS');
  expect(result.advisers.architect!.answer!.binding!.request.inputs).toEqual(planned);
  expect(result.advisers.architect!.answer!.target.inputs).toEqual(s.council.target.inputs);
  expect(result.selection.architect.inputs).toEqual(planned);
});

it('still verifies planning context bytes outside the review target', async () => {
  const s = sessions();
  await f.file('context.txt', 'Planning context');
  s.council.selection.architect.inputs = await f.inputs.capture(
    { files: ['context.txt'], directories: [] },
    'owner',
  );
  await f.file('context.txt', 'Changed before planning acceptance');
  s.answer.content = JSON.stringify(f.answer(s.council));
  await expect(
    observeChatCouncil(s.council, 'architect', f.adviser, 'turn', 'principal', s.port, f.inputs),
  ).rejects.toThrow('workflow-input-changed');
});

it.each(['target', 'requirements', 'assignment', 'request-file'])(
  'rejects changed current acceptance %s despite historical planning inputs',
  async (kind) => {
    const s = sessions();
    s.council.phase = 'acceptance';
    s.answer.content = JSON.stringify(f.answer(s.council));
    let port = s.port;
    if (kind === 'request-file') {
      await f.file('request.json', 'Immutable exact native request');
      const ref = await f.ref('request.json');
      port = {
        ...port,
        verifyReview: async (...args) => ({
          ...(await s.port.verifyReview(...args)),
          request_file: ref,
        }),
      };
      await f.file('request.json', 'Tampered request');
    } else {
      const locator =
        kind === 'target'
          ? 'source.txt'
          : kind === 'requirements'
            ? f.proof.locator
            : f.adviser.spec.assignment.locator;
      await f.file(locator, 'Changed after reviewer snapshot');
    }
    await expect(
      observeChatCouncil(s.council, 'architect', f.adviser, 'turn', 'principal', port, f.inputs),
    ).rejects.toThrow('workflow-input-changed');
  },
);

it('preserves the first LOAD witness on repeat and refuses a missing or replaced origin', async () => {
  const s = sessions();
  const accepted = await observeChatCouncil(
    s.council,
    'architect',
    f.adviser,
    'first-answer',
    'principal',
    { ...s.port, inspect: async () => ({ ...s.actual, observed_turn: 'first-answer' }) },
    f.inputs,
  );
  for (const origin of [null, undefined, await f.ref('diff.txt')]) {
    const next = repeatCouncil(accepted, f.target, ['architect']);
    const run = structuredClone(f.adviser);
    if (origin === null) next.advisers.architect!.run.loaded = null;
    else if (origin === undefined) delete next.advisers.architect!.run.loaded!.origin;
    else run.loaded!.origin = origin;
    await expect(
      observeChatCouncil(next, 'architect', run, 'turn', 'principal', s.port, f.inputs),
    ).rejects.toThrow('chat-council-origin-changed');
  }
});
it.each([0, 1])('rejects profile input %s changed after the reviewer read it', async (index) => {
  const s = sessions();
  await f.file(f.profiles.architect[index]!.locator, '# Changed after LOAD\n');
  await expect(
    observeChatCouncil(s.council, 'architect', f.adviser, 'turn', 'principal', s.port, f.inputs),
  ).rejects.toThrow('workflow-input-changed');
  expect(s.council.history).toEqual([]);
});

it('keeps an unaffected role answer when another selected profile needs a new review', async () => {
  const s = sessions();
  s.council.selection.backend.trigger = true;
  await f.file(f.profiles.backend[1]!.locator, '# Changed backend profile\n');
  const result = await observeChatCouncil(
    s.council,
    'architect',
    f.adviser,
    'turn',
    'principal',
    s.port,
    f.inputs,
  );
  expect(result.advisers.architect!.answer!.verdict).toBe('PASS');
  expect(result.advisers.backend).toBeUndefined();
});

it('uses the native response receipt, checks isolation/profile, and repeats review in the same session', async () => {
  const s = sessions();
  const result = await observeChatCouncil(
    s.council,
    'architect',
    f.adviser,
    'turn',
    'principal',
    s.port,
    f.inputs,
  );
  expect(result.advisers.architect!.answer!.evidence).toEqual(f.proof);
  await expect(
    observeChatCouncil(result, 'architect', f.adviser, 'turn', 'principal', s.port, f.inputs),
  ).rejects.toThrow('adviser-already-answered');
  const repeated = repeatCouncil(result, f.target, ['architect']);
  s.actual.observed_turn = 'turn2';
  const next = await observeChatCouncil(
    repeated,
    'architect',
    f.adviser,
    'turn2',
    'principal',
    s.port,
    f.inputs,
  );
  expect(next.history).toHaveLength(1);
  expect(next.review_turns).toHaveLength(2);
  await f.file('new-brief.txt', 'Revised task source');
  const revisedRun = {
    ...f.adviser,
    spec: {
      ...f.adviser.spec,
      assignment: await f.ref('new-brief.txt'),
      sources: [await f.ref('new-brief.txt'), ...f.profiles.architect],
    },
  };
  const refreshed = await observeChatCouncil(
    repeatCouncil(next, f.target, ['architect']),
    'architect',
    revisedRun,
    'turn3',
    'principal',
    { ...s.port, inspect: async () => ({ ...s.actual, observed_turn: 'turn3' }) },
    f.inputs,
  );
  expect(refreshed.advisers.architect!.run.spec.assignment).toEqual(await f.ref('new-brief.txt'));
  expect(refreshed.history).toHaveLength(1);
  expect(refreshed.review_turns).toHaveLength(3);
  await expect(
    observeChatCouncil(
      repeated,
      'architect',
      {
        ...f.adviser,
        spec: { ...f.adviser.spec, session_id: 'other' },
        loaded: { ...f.adviser.loaded!, session_id: 'other' },
      },
      'turn',
      'principal',
      { ...s.port, inspect: async () => ({ ...s.actual, id: 'other', observed_turn: 'turn' }) },
      f.inputs,
    ),
  ).rejects.toThrow('reviewer-replacement-needs-recovery');
});

it('rejects an earlier answer even when a later observed turn has a safe profile', async () => {
  const s = sessions();
  s.actual.observed_turn = 'later-safe-turn';
  await expect(
    observeChatCouncil(
      s.council,
      'architect',
      f.adviser,
      'unsafe-answer',
      'principal',
      s.port,
      f.inputs,
    ),
  ).rejects.toThrow('chat-adviser-turn-unconfirmed');
});
it('rejects the principal, lost identity, write access, a running role and an incomplete or foreign answer', async () => {
  const s = sessions();
  await expect(
    observeChatCouncil(s.council, 'architect', f.adviser, 'turn', 'session', s.port, f.inputs),
  ).rejects.toThrow('chat-independent-role-required');
  await expect(
    observeChatCouncil(
      s.council,
      'architect',
      f.adviser,
      'turn',
      'principal',
      { ...s.port, inspect: async () => null },
      f.inputs,
    ),
  ).rejects.toThrow('chat-role-identity-unconfirmed');
  await expect(
    observeChatCouncil(
      s.council,
      'architect',
      f.adviser,
      'turn',
      'principal',
      { ...s.port, inspect: async () => ({ ...s.actual, read_only: false }) },
      f.inputs,
    ),
  ).rejects.toThrow('effective-profile-mismatch');
  await expect(
    observeChatCouncil(
      s.council,
      'architect',
      f.adviser,
      'turn',
      'principal',
      { ...s.port, poll: async () => ({ status: 'running' }) },
      f.inputs,
    ),
  ).rejects.toThrow('chat-role-still-running');
  s.answer.coverage = 'partial';
  await expect(
    observeChatCouncil(s.council, 'architect', f.adviser, 'turn', 'principal', s.port, f.inputs),
  ).rejects.toThrow('chat-role-answer-unconfirmed');
});
it.each(['FAIL', 'NOT RUN'] as const)(
  'rejects a PASS nested inside a native %s envelope',
  async (outcome) => {
    const s = sessions();
    s.answer.outcome = outcome;
    await expect(
      observeChatCouncil(s.council, 'architect', f.adviser, 'turn', 'principal', s.port, f.inputs),
    ).rejects.toThrow('chat-role-answer-unconfirmed');
  },
);

it.each([
  { parent_id: 'principal' },
  { parent_id: 'another-chat' },
  { native_child: true },
  { forked_from: 'principal' },
])('rejects an unrelated or inherited reviewer: %j', async (patch) => {
  const s = sessions();
  await expect(
    observeChatCouncil(
      s.council,
      'architect',
      f.adviser,
      'turn',
      'principal',
      { ...s.port, inspect: async () => ({ ...s.actual, ...patch }) },
      f.inputs,
    ),
  ).rejects.toThrow('chat-role-identity-unconfirmed');
});

it.each([null, '', 'Read all procedures', 'Советник: Сервер'])(
  'rejects a missing, technical or foreign role name: %s',
  async (name) => {
    const s = sessions();
    await expect(
      observeChatCouncil(
        s.council,
        'architect',
        f.adviser,
        'turn',
        'principal',
        { ...s.port, inspect: async () => ({ ...s.actual, name }) },
        f.inputs,
      ),
    ).rejects.toThrow('chat-adviser-name-unconfirmed');
  },
);

it.each([
  { network: true },
  { model: 'other' },
  { effort: 'other' },
  { read_only: false },
  { observed_turn: 'later-safe-turn' },
])('rejects effective profile/answer-turn mismatch: %j', async (patch) => {
  const s = sessions();
  await expect(
    observeChatCouncil(
      s.council,
      'architect',
      f.adviser,
      'turn',
      'principal',
      { ...s.port, inspect: async () => ({ ...s.actual, ...patch }) },
      f.inputs,
    ),
  ).rejects.toThrow(
    'observed_turn' in patch ? 'chat-adviser-turn-unconfirmed' : 'effective-profile-mismatch',
  );
});
