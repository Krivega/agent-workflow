import { execFileSync, spawnSync } from 'node:child_process';
import {
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateAdrRepository } from './validateAdrChanges.mjs';

const roots: string[] = [];
const recordPath = 'docs/design/decisions/0001-fixture.md';
const accepted =
  '# ADR-0001: boundary\n\n- **Status:** `accepted`\n- **Date:** `2026-10-01`\n\n## Решение\n\nKeep the boundary.\n';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let seedRoot: string;
let initial: string;

function gitAt(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

beforeAll(() => {
  seedRoot = mkdtempSync(join(tmpdir(), 'adr-changes-seed-'));
  mkdirSync(join(seedRoot, 'scripts'));
  mkdirSync(join(seedRoot, 'docs/design/decisions'), { recursive: true });
  for (const file of ['validateAdrChanges.mjs', 'adrChangeValidation.ts', 'adrValidation.ts'])
    cpSync(resolve('scripts', file), join(seedRoot, 'scripts', file));
  symlinkSync(resolve('node_modules'), join(seedRoot, 'node_modules'), 'dir');
  writeFileSync(join(seedRoot, recordPath), accepted);
  gitAt(seedRoot, 'init', '-b', 'main');
  gitAt(seedRoot, 'config', 'user.email', 'fixture@example.test');
  gitAt(seedRoot, 'config', 'user.name', 'Fixture');
  gitAt(seedRoot, 'add', 'docs');
  gitAt(seedRoot, 'commit', '-m', 'Initial decision');
  initial = gitAt(seedRoot, 'rev-parse', 'HEAD');
});

afterAll(() => rmSync(seedRoot, { recursive: true, force: true }));

function fixture(branch = 'main') {
  const root = mkdtempSync(join(tmpdir(), 'adr-changes-'));
  roots.push(root);
  cpSync(seedRoot, root, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const git = (...args: string[]) => gitAt(root, ...args);
  if (branch !== 'main') git('branch', '-m', branch);
  const run = async (args: string[] = [], environment: Record<string, string> = {}) => {
    try {
      const report = await validateAdrRepository(root, args, {
        ...process.env,
        CI: '',
        ADR_BASE_REF: '',
        ADR_MAINTENANCE_REASON: '',
        ...environment,
      });
      return { status: report.issues.length ? 1 : 0, stdout: report.stdout, stderr: report.stderr };
    } catch (error) {
      return { status: 1, stdout: '', stderr: String(error) };
    }
  };
  return { root, git, initial, run };
}

it('checks committed changes against the remote default without modifying Git state', async () => {
  const f = fixture();
  f.git('update-ref', 'refs/remotes/origin/trunk', f.initial);
  f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  f.git('checkout', '-b', 'work');
  writeFileSync(join(f.root, recordPath), accepted.replace('Keep', 'Remove'));
  f.git('add', 'docs');
  f.git('commit', '-m', 'Alter decision');
  const head = f.git('rev-parse', 'HEAD');

  const result = await f.run();

  expect(result.status).toBe(1);
  expect(result.stdout).toContain('change-locked-content-modified');
  expect(result.stdout).toContain('base: refs/remotes/origin/trunk');
  expect(f.git('rev-parse', 'HEAD')).toBe(head);
  expect(f.git('status', '--porcelain')).toContain('?? scripts/');
});

it('verifies relocated primary files against Git rather than a claimed checksum', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'docs/extraction'), { recursive: true });
  const original = join(f.root, 'docs/extraction/source.json');
  writeFileSync(original, '{"primary":true}\n');
  const before = accepted.replace(
    'Keep the boundary.',
    'Keep [source](../../extraction/source.json#original).',
  );
  writeFileSync(join(f.root, recordPath), before);
  f.git('add', 'docs');
  f.git('commit', '-m', 'Record primary source');
  const base = f.git('rev-parse', 'HEAD');
  mkdirSync(join(f.root, 'docs/design/decisions/sources'));
  const relocated = join(f.root, 'docs/design/decisions/sources/source.json');
  cpSync(original, relocated);
  rmSync(original);
  writeFileSync(
    join(f.root, recordPath),
    before.replace('../../extraction/source.json', 'sources/source.json'),
  );
  expect((await f.run(['--base', base])).status).toBe(0);
  writeFileSync(relocated, '{"primary":false}\n');
  expect((await f.run(['--base', base])).stdout).toContain('change-locked-content-modified');
  rmSync(relocated);
  expect((await f.run(['--base', base])).status).toBe(1);
  writeFileSync(relocated, '{"primary":true}\n');
  expect((await f.run(['--base', f.initial])).status).toBe(1);
});

it('refuses different primary bytes that both decode to Unicode replacement characters', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'docs/extraction'), { recursive: true });
  writeFileSync(join(f.root, 'docs/extraction/source.json'), Buffer.from([0xff]));
  const before = accepted.replace(
    'Keep the boundary.',
    'Keep [source](../../extraction/source.json).',
  );
  writeFileSync(join(f.root, recordPath), before);
  f.git('add', 'docs');
  f.git('commit', '-m', 'Record invalid primary bytes');
  const base = f.git('rev-parse', 'HEAD');
  mkdirSync(join(f.root, 'docs/design/decisions/sources'));
  writeFileSync(join(f.root, 'docs/design/decisions/sources/source.json'), Buffer.from([0xfe]));
  writeFileSync(
    join(f.root, recordPath),
    before.replace('../../extraction/source.json', 'sources/source.json'),
  );
  expect((await f.run(['--base', base])).status).toBe(1);
});

it('uses local branch candidates and includes staged, unstaged and untracked ADRs', async () => {
  const f = fixture();
  f.git('checkout', '-b', 'work');
  writeFileSync(join(f.root, recordPath), accepted.replace('Keep', 'Remove'));
  f.git('add', 'docs');
  writeFileSync(join(f.root, 'docs/design/decisions/0002-new.md'), accepted);

  const result = await f.run();

  expect(result.status).toBe(1);
  expect(result.stdout).toContain('base: main');
  expect(result.stdout).toContain('change-locked-content-modified');
  expect(result.stdout).toContain('Отсутствует поле Decision basis.');
  expect(f.git('diff', '--cached', '--name-only')).toBe(recordPath);
});

it('accepts an approved new ADR in the working tree, index and branch, then locks it once in the base', async () => {
  const f = fixture();
  f.git('checkout', '-b', 'work');
  const nextPath = 'docs/design/decisions/0002-approved.md';
  const decision = accepted
    .replace('ADR-0001', 'ADR-0002')
    .replace(
      '- **Date:** `2026-10-01`',
      '- **Date:** `2026-10-01`\n- **Decision basis:** [Принятие](../../approval.md#решение)',
    );
  writeFileSync(
    join(f.root, 'docs/approval.md'),
    '# Решение\n\nПользователь 2026-10-15: принимаю ADR-0002.\n',
  );
  writeFileSync(join(f.root, nextPath), decision);
  expect((await f.run()).status).toBe(0);
  f.git('add', 'docs');
  expect((await f.run()).status).toBe(0);
  f.git('commit', '-m', 'Record explicit acceptance');
  expect((await f.run()).status).toBe(0);
  f.git('branch', '-f', 'main', 'HEAD');
  writeFileSync(join(f.root, nextPath), decision.replace('Keep', 'Remove'));
  const result = await f.run();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('change-locked-content-modified');
  expect(readFileSync(join(f.root, nextPath), 'utf8')).toContain('Remove');
});

it('rejects missing or invalid approval links for new accepted ADRs, including a deleted target', async () => {
  const f = fixture();
  const nextPath = 'docs/design/decisions/0002-approved.md';
  const approvalPath = join(f.root, 'docs/approval.md');
  const withBasis = (basis: string) =>
    accepted.replace('- **Date:**', `- **Decision basis:** ${basis}\n- **Date:**`);
  writeFileSync(join(f.root, nextPath), withBasis('Принято пользователем'));
  expect((await f.run()).stdout).toContain('decision-basis-link-missing');
  writeFileSync(join(f.root, nextPath), withBasis('[Решение](../../approval.md#решение)'));
  expect((await f.run()).stdout).toContain('decision-basis-target-missing');
  writeFileSync(approvalPath, '# Другой раздел\n');
  expect((await f.run()).stdout).toContain('decision-basis-anchor-missing');
  writeFileSync(approvalPath, '# Решение\n\nПользователь принимает ADR-0002.\n');
  expect((await f.run()).status).toBe(0);
  f.git('add', 'docs/approval.md');
  rmSync(approvalPath);
  const missing = await f.run();
  expect(missing.status).toBe(1);
  expect(missing.stdout).toContain('decision-basis-target-missing');
});

it('honors explicit arguments before environment and fails for invalid explicit references', async () => {
  const f = fixture();
  expect((await f.run(['--base', f.initial], { ADR_BASE_REF: 'missing' })).status).toBe(0);
  expect((await f.run([], { ADR_BASE_REF: f.initial })).status).toBe(0);
  expect((await f.run([], { ADR_BASE_REF: 'missing' })).status).toBe(1);
  expect((await f.run(['--unknown'])).status).toBe(1);
});

it('requires an explicit available CI target even if a local default exists', async () => {
  const f = fixture();
  const missing = await f.run([], { CI: 'true' });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('CI requires ADR_BASE_REF');
  expect((await f.run([], { CI: 'true', ADR_BASE_REF: 'missing' })).status).toBe(1);
  expect((await f.run([], { CI: 'true', ADR_BASE_REF: f.initial })).status).toBe(0);
});

it('reports degraded local coverage when no default branch is available', async () => {
  const f = fixture('work');
  const result = await f.run();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('HEAD checks only uncommitted changes');
  expect(result.stdout).toContain('base: HEAD');
});

it('never uses a maintenance note to permit committed changes to a decision', async () => {
  const f = fixture();
  f.git('checkout', '-b', 'work');
  writeFileSync(join(f.root, recordPath), accepted.replace('Keep', 'Remove'));
  f.git('add', 'docs');
  f.git('commit', '-m', 'Alter decision');
  const result = await f.run([], { ADR_MAINTENANCE_REASON: 'исправлена ссылка' });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('change-locked-content-modified');
  expect(result.stdout).toContain('maintenance note (checks unchanged)');
  writeFileSync(join(f.root, recordPath), accepted);
  expect((await f.run([], { ADR_MAINTENANCE_REASON: 'восстановлен владелец' })).status).toBe(0);
});

it('preserves real command-line success, rejection and argument errors', () => {
  const f = fixture();
  const cli = (args: string[] = []) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/validateAdrChanges.mjs', ...args], {
      cwd: f.root,
      encoding: 'utf8',
      env: { ...process.env, CI: '', ADR_BASE_REF: f.initial, ADR_MAINTENANCE_REASON: '' },
    });
  const success = cli();
  expect(success.status).toBe(0);
  expect(success.stdout).toContain('ADR changes: valid');
  writeFileSync(join(f.root, recordPath), accepted.replace('Keep', 'Remove'));
  const rejected = cli();
  expect(rejected.status).toBe(1);
  expect(rejected.stdout).toContain('change-locked-content-modified');
  const invalidArgument = cli(['--unknown']);
  expect(invalidArgument.status).toBe(1);
  expect(invalidArgument.stderr).toContain('Usage: yarn lint:adr:diff');
});

it('checks staged and untracked ADRs before the first commit without creating Git state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adr-changes-unborn-'));
  roots.push(root);
  mkdirSync(join(root, 'docs/design/decisions'), { recursive: true });
  gitAt(root, 'init', '-b', 'main');
  writeFileSync(join(root, recordPath), accepted.replace('`accepted`', '`proposed`'));
  gitAt(root, 'add', 'docs');
  const second = 'docs/design/decisions/0002-next.md';
  writeFileSync(
    join(root, second),
    accepted.replaceAll('0001', '0002').replace('`accepted`', '`proposed`'),
  );
  const before = gitAt(root, 'status', '--porcelain');
  const report = await validateAdrRepository(root, [], { CI: '', ADR_BASE_REF: '' });
  expect(report.issues).toEqual([]);
  expect(report.stderr).toContain('unborn repository');
  expect(report.stdout).toContain('merge-base: unborn');
  expect(gitAt(root, 'status', '--porcelain')).toBe(before);
  expect(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status).not.toBe(0);
});
