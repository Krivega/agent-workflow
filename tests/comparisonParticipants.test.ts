import { mkdtemp, realpath, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { comparisonParticipants } from '../adapters/codex/comparisonParticipants.js';
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(resolve(tmpdir(), 'comparison-participants-')));
});
afterEach(async () => rm(root, { recursive: true, force: true }));
it('accounts for all native kinds and archived pages within exact owned directories in batches', async () => {
  for (let index = 0; index < 101; index++) await mkdir(resolve(root, `d${index}`));
  await mkdir(resolve(root, '.git'));
  await mkdir(resolve(root, 'node_modules'));
  await symlink(resolve(root, 'd0'), resolve(root, 'alias'));
  const register = vi.fn();
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
    data: [{ id: 'actor', path: '/primary.jsonl', cwd: (params.cwd as string[])[0] }],
    nextCursor: params.cursor === null ? 'next' : undefined,
  }));
  await comparisonParticipants({ request }, [root], 'run', register);
  expect(request).toHaveBeenCalledTimes(8);
  const calls = request.mock.calls.map((call) => call[1]);
  expect(calls[0]!.sourceKinds).toEqual(
    expect.arrayContaining(['exec', 'appServer', 'subAgentReview', 'unknown']),
  );
  expect(calls.map((call) => call.archived)).toEqual([
    false,
    false,
    true,
    true,
    false,
    false,
    true,
    true,
  ]);
  expect(calls.flatMap((call) => call.cwd)).not.toContain(resolve(root, '.git'));
  expect(calls.flatMap((call) => call.cwd)).not.toContain(resolve(root, 'alias'));
  expect(register).toHaveBeenCalledWith({
    session: 'actor',
    transcript: '/primary.jsonl',
    run: 'run',
    stage: 'helper',
  });
});
it.each([
  [{ data: null }, 'comparison-participants-incomplete'],
  [{ data: [{ id: 'x', path: '/x', cwd: '/foreign' }] }, 'comparison-participant-scope-mismatch'],
  [{ data: [], nextCursor: 'same' }, 'comparison-participants-pagination-loop'],
  [{ data: [], nextCursor: '' }, 'missing-text'],
])('refuses incomplete native inventory %#', async (page, error) => {
  await expect(
    comparisonParticipants({ request: async () => page }, [root], 'run', vi.fn()),
  ).rejects.toThrow(error);
});
it('refuses a root alias and accepts empty complete pages', async () => {
  const alias = resolve(root, 'alias');
  await symlink(root, alias);
  await expect(
    comparisonParticipants({ request: vi.fn() }, [alias], 'run', vi.fn()),
  ).rejects.toThrow('comparison-workspace-alias');
  const request = vi.fn(async () => ({ data: [], nextCursor: null }));
  await comparisonParticipants({ request }, [root], 'run', vi.fn());
  expect(request).toHaveBeenCalledTimes(2);
});
