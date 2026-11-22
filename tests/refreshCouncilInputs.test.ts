import { workflowFixture } from './workflowFixtures.js';
import { refreshCouncilInputs } from '../cli/refreshCouncilInputs.js';
import { answerCouncil, councilBlockers, repeatCouncil } from '../core/council.js';
import type { Council } from '../core/council.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});

async function target(council: Council, extra: string[] = []) {
  return {
    ...council.target,
    inputs: await f.inputs.capture(
      {
        files: [...new Set([...council.target.inputs.inputs.map((ref) => ref.locator), ...extra])],
        directories: [],
      },
      'current target',
    ),
  };
}

it.each(['planning', 'acceptance'] as const)(
  'refreshes only the changed role in %s and retains native PASS and history',
  async (phase) => {
    const council = f.council(phase);
    await f.file('api/server.ts', 'old');
    council.selection.backend = {
      ...council.selection.backend,
      trigger: true,
      inputs: await f.inputs.capture({ files: [], directories: ['api'] }, 'backend'),
    };
    council.advisers.backend = {
      ...council.advisers.architect!,
      reviewed: council.selection.backend,
    };
    await f.file('api/server.ts', 'new');
    await f.file('api/new.ts', 'new dependency');
    const updated = await refreshCouncilInputs(
      council,
      await target(council, ['api/server.ts', 'api/new.ts']),
      f.inputs,
    );
    expect(updated.advisers.architect).toEqual(council.advisers.architect);
    expect(updated.advisers.backend?.status).toBe('running');
    expect(updated.advisers.backend?.answer).toBeNull();
    expect(updated.selection.backend.inputs.inputs).toEqual([
      await f.ref('api/new.ts'),
      await f.ref('api/server.ts'),
    ]);
    expect(updated.selection.architect.inputs.inputs).toEqual([await f.ref('source.txt')]);
    expect(updated.history).toEqual(council.history);
    expect(council.selection.backend.inputs.inputs).toHaveLength(1);
  },
);

it('preserves all answers with unchanged role inputs even when unrelated evidence is added', async () => {
  const council = f.council('acceptance');
  const updated = await refreshCouncilInputs(
    council,
    await target(council, ['diff.txt']),
    f.inputs,
  );
  expect(updated.advisers).toEqual(council.advisers);
  expect(updated.target.inputs.inputs).toHaveLength(2);
});

it('covers evidence-only role inputs and rejects a stale package without changing source inputs', async () => {
  const council = f.council('acceptance');
  const evidence = await f.inputs.capture(
    { files: ['source.txt', 'diff.txt'], directories: [] },
    'package',
  );
  council.selection.architect.inputs = await f.inputs.capture(
    { files: ['diff.txt'], directories: [] },
    'role',
  );
  const target = { ...f.target, evidence_inputs: evidence };
  const updated = await refreshCouncilInputs(council, target, f.inputs);
  expect(updated.target.inputs).toEqual(f.target.inputs);
  expect(updated.selection.architect.inputs.inputs).toEqual([await f.ref('diff.txt')]);
  await f.file('diff.txt', 'changed evidence');
  await expect(refreshCouncilInputs(council, target, f.inputs)).rejects.toThrow(
    'stale-council-evidence',
  );
});

it('reopens a partial PASS and retains its evidence instead of leaving an answered blocker', async () => {
  const pending = repeatCouncil(f.council('acceptance'), f.target, ['architect']);
  const council = answerCouncil(pending, 'architect', 'session', {
    ...f.answer(pending),
    coverage: 'partial',
  });
  expect(councilBlockers(council)).toContain('architect:not-accepted');
  const updated = await refreshCouncilInputs(council, council.target, f.inputs);
  expect(updated.advisers.architect?.status).toBe('running');
  expect(updated.advisers.architect?.answer).toBeNull();
  expect(updated.history).toEqual(council.history);
  expect(updated.review_turns).toEqual(council.review_turns);
  expect(council.advisers.architect?.status).toBe('answered');
});

it.each(['planning', 'acceptance'] as const)(
  'reopens %s when a role requirement or the scope changes',
  async (phase) => {
    const council = f.council(phase);
    await f.file('proof.txt', 'changed requirement');
    const updated = await refreshCouncilInputs(council, await target(council), f.inputs);
    expect(updated.selection.architect.requirements[0]).toEqual(await f.ref('proof.txt'));
    expect(updated.advisers.architect?.status).toBe('running');
    const expanded = await refreshCouncilInputs(
      council,
      { ...(await target(council)), scope: 'expanded' },
      f.inputs,
    );
    expect(expanded.advisers.architect?.status).toBe('running');
  },
);

it('retains the old FAIL in history and reopens its owner without changing applicability', async () => {
  const council = f.council('acceptance');
  council.advisers.architect!.answer!.verdict = 'FAIL';
  council.history.push({
    role: 'architect',
    session: 'session',
    answer: council.advisers.architect!.answer!,
  });
  const updated = await refreshCouncilInputs(council, await target(council), f.inputs);
  expect(updated.history.at(-1)?.answer.verdict).toBe('FAIL');
  expect(updated.advisers.architect?.status).toBe('running');
  expect(updated.selection.backend.trigger).toBe(false);
});

it('rejects an incomplete target, unknown applicability, missing or incomplete role inputs and uncovered discovery', async () => {
  const council = f.council('planning');
  await expect(
    refreshCouncilInputs(
      council,
      { ...f.target, inputs: { ...f.target.inputs, complete: false } },
      f.inputs,
    ),
  ).rejects.toThrow('incomplete-council-target');
  council.selection.backend.trigger = null;
  await expect(refreshCouncilInputs(council, f.target, f.inputs)).rejects.toThrow(
    'backend:applicability-unknown',
  );
  council.selection.backend.trigger = false;
  council.selection.architect.inputs.complete = false;
  await expect(refreshCouncilInputs(council, f.target, f.inputs)).rejects.toThrow(
    'architect:incomplete-inputs',
  );
  council.selection.architect.inputs.complete = true;
  council.selection.architect.inputs.inputs.push({ locator: 'missing.ts', hash: 'unknown' });
  await expect(refreshCouncilInputs(council, f.target, f.inputs)).rejects.toThrow(
    'architect:incomplete-inputs',
  );
  await f.file('api/new.ts', 'discovered');
  council.selection.architect.inputs = await f.inputs.capture(
    { files: [], directories: ['api'] },
    'role',
  );
  await expect(refreshCouncilInputs(council, f.target, f.inputs)).rejects.toThrow(
    'architect:inputs-outside-target',
  );
});

it('does not replace a pending or missing reviewer while refreshing acceptance', async () => {
  const council = f.council('acceptance');
  delete council.advisers.architect;
  await expect(refreshCouncilInputs(council, f.target, f.inputs)).rejects.toThrow(
    'reviewer-still-running-or-missing',
  );
});
it('rejects target discovery that missed a newly added file before retaining any PASS', async () => {
  const council = f.council('acceptance');
  await f.file('api/server.ts', 'old');
  const stale = {
    ...council.target,
    inputs: await f.inputs.capture({ files: ['source.txt'], directories: ['api'] }, 'target'),
  };
  await f.file('api/new.ts', 'new');
  await expect(refreshCouncilInputs(council, stale, f.inputs)).rejects.toThrow(
    'stale-council-target',
  );
});
