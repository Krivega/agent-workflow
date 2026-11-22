import { afterEach, expect, it } from 'vitest';
import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { coderFixture } from './coderFixtures.js';
import {
  startCoder,
  launchCoder,
  runCoder,
  integrateCoder,
  cancelCoder,
} from '../application/coderWorkflow.js';

let f: Awaited<ReturnType<typeof coderFixture>>;
afterEach(async () => {
  await f.dispose();
});
async function candidate(paths = ['module']) {
  f = await coderFixture();
  await f.file('module/existing.txt', 'before');
  await f.file('module/nested/old.txt', 'old');
  const brief = await f.brief('one', paths);
  f.deps.sessions.result = async () => ({
    outcome: 'PASS',
    evidence: await f.artifact('result', { fixture: true }),
    checks: [],
    errors: [],
    limitations: [],
  });
  await startCoder(brief, f.deps);
  return runCoder('one', f.deps);
}

it('can retain a sent Writer without waiting and later collect its original result', async () => {
  f = await coderFixture();
  await startCoder(await f.brief('one', ['source.txt']), f.deps);
  const running = await launchCoder('one', f.deps);
  expect(running.status).toBe('running');
  expect((await f.deps.journal.read()).coders?.one).toEqual(running);
  expect(f.counts).toMatchObject({ creates: 1, loads: 1, sends: 1, stops: 0 });
  expect((await runCoder('one', f.deps)).status).toBe('released');
  expect(f.counts).toMatchObject({ creates: 1, loads: 1, sends: 1, stops: 1 });
});
it('integrates new nested files, file deletion and modes with recovery through the same file intent', async () => {
  f = await coderFixture();
  await f.file('module/existing.txt', 'before');
  await f.file('module/nested/old.txt', 'old');
  const brief = await f.brief('one', ['module']);
  f.deps.sessions.result = async (run) => {
    await unlink(resolve(run.brief.copy_root, 'module/nested/old.txt'));
    await writeFile(resolve(run.brief.copy_root, 'module/existing.txt'), 'after');
    await chmod(resolve(run.brief.copy_root, 'module/existing.txt'), 0o700);
    await mkdir(resolve(run.brief.copy_root, 'module/new/deeper'), { recursive: true });
    await writeFile(resolve(run.brief.copy_root, 'module/new/deeper/file.txt'), 'new');
    return {
      outcome: 'PASS',
      evidence: await f.artifact('result', { fixture: true }),
      checks: [],
      errors: [],
      limitations: [],
    };
  };
  await startCoder(brief, f.deps);
  await runCoder('one', f.deps);
  const done = await integrateCoder('one', f.deps);
  expect(done.status).toBe('integrated');
  expect(await readFile(resolve(f.root, 'module/new/deeper/file.txt'), 'utf8')).toBe('new');
  await expect(readFile(resolve(f.root, 'module/nested/old.txt'))).rejects.toThrow();
  expect((await integrateCoder('one', f.deps)).receipt).toEqual(done.receipt);
});
it('replays an exact prepared copy and rejects a changed copy binding or source dependency', async () => {
  const run = await candidate();
  expect(await f.workspaces.copy(run)).toEqual(run.copy);
  await f.file('source.txt', 'foreign dependency');
  // Add a dependency to the next isolated assignment, while keeping the original candidate intact.
  await cancelCoder('one', f.deps);
  const brief = await f.brief('two', ['module']);
  brief.files.push(await f.ref('source.txt'));
  await startCoder(brief, f.deps);
  await runCoder('two', f.deps);
  await f.file('source.txt', 'changed dependency');
  await expect(integrateCoder('two', f.deps)).rejects.toThrow('coder-source-conflict');
  const current = (await f.deps.journal.read()).coders!.two!;
  await rename(current.brief.copy_root, current.brief.copy_root + '-original');
  await mkdir(current.brief.copy_root);
  await expect(f.workspaces.verifyCopy(current)).rejects.toThrow('coder-root-binding-changed');
});
it.each(['private', 'ignored', 'empty-directory', 'directory-mode', 'new-source'])(
  'rejects %s changes before importing any byte',
  async (kind) => {
    f = await coderFixture();
    await f.file('module/existing.txt', 'before');
    const brief = await f.brief('one', ['module']);
    f.deps.sessions.result = async (run) => {
      if (kind === 'private')
        await writeFile(resolve(run.brief.copy_root, 'module/.env'), 'secret');
      if (kind === 'ignored') {
        await f.file('.gitignore', 'module/ignored.txt\n');
        await writeFile(resolve(run.brief.copy_root, 'module/ignored.txt'), 'ignored');
      }
      if (kind === 'empty-directory') await mkdir(resolve(run.brief.copy_root, 'module/empty'));
      if (kind === 'directory-mode') await chmod(resolve(run.brief.copy_root, 'module'), 0o777);
      if (kind === 'new-source') await f.file('module/foreign.txt', 'foreign');
      return {
        outcome: 'PASS',
        evidence: await f.artifact('result', { fixture: true }),
        checks: [],
        errors: [],
        limitations: [],
      };
    };
    await startCoder(brief, f.deps);
    await runCoder('one', f.deps);
    await expect(integrateCoder('one', f.deps)).rejects.toThrow(
      kind === 'private'
        ? 'coder-protected-change'
        : kind === 'ignored'
          ? 'ignored-coder-input'
          : kind === 'empty-directory'
            ? 'coder-directory-outside-scope'
            : kind === 'directory-mode'
              ? 'coder-directory-change-unsupported'
              : 'coder-source-discovery-changed',
    );
    expect(await readFile(resolve(f.root, 'module/existing.txt'), 'utf8')).toBe('before');
  },
);
it('rejects private and ignored declared inputs, symlinks and hardlinks without creating a child', async () => {
  f = await coderFixture();
  await f.file('.env', 'secret');
  await f.file('ignored.txt', 'ignored');
  for (const path of ['.env', 'ignored.txt']) {
    const brief = await f.brief(path === '.env' ? 'private' : 'ignored', ['source.txt']);
    brief.files.push(await f.ref(path));
    await expect(startCoder(brief, f.deps)).rejects.toThrow(
      path === '.env' ? 'private-coder-input' : 'ignored-coder-input',
    );
  }
  await mkdir(resolve(f.root, 'module'));
  await symlink(resolve(f.root, 'source.txt'), resolve(f.root, 'module/alias'));
  await expect(startCoder(await f.brief('link', ['module']), f.deps)).rejects.toThrow(
    'unsafe-coder-path',
  );
  await unlink(resolve(f.root, 'module/alias'));
  await link(resolve(f.root, 'source.txt'), resolve(f.root, 'module/hard'));
  await expect(startCoder(await f.brief('hard', ['module']), f.deps)).rejects.toThrow(
    'unsafe-coder-file',
  );
  await unlink(resolve(f.root, 'module/hard'));
  const brief = await f.brief('wrong', ['source.txt']);
  brief.copy_root = resolve(f.db.parent, 'foreign');
  await expect(startCoder(brief, f.deps)).rejects.toThrow('coder-copy-outside-owned-root');
  await rm(resolve(f.root, 'module'), { recursive: true });
});

it('copies only pinned installed coder documents and refuses substitution or integration of those files', async () => {
  f = await coderFixture();
  await f.file('.gitignore', 'node_modules/\n');
  const brief = await f.brief('installed', ['source.txt']);
  const installed = 'node_modules/@krivega/agent-workflow';
  const profile = installed + '/roles/coder.md';
  await f.file(profile, 'installed coder role');
  const role = await f.ref(profile);
  brief.rules.push(role);
  for (const procedure of brief.procedures) {
    const locator = installed + '/procedures/' + procedure.id + '.md';
    await f.file(locator, await readFile(resolve(f.root, procedure.locator), 'utf8'));
    procedure.locator = locator;
  }
  for (const file of [role, ...brief.procedures]) await chmod(resolve(f.root, file.locator), 0o644);
  await f.file(profile, 'substituted');
  await expect(f.workspaces.capture(brief)).rejects.toThrow('coder-package-input-changed');
  await f.file(profile, 'installed coder role');
  await chmod(resolve(f.root, profile), 0o755);
  await expect(f.workspaces.capture(brief)).rejects.toThrow('coder-package-input-changed');
  await chmod(resolve(f.root, profile), 0o644);
  const adjacent = installed + '/roles/other.md';
  await f.file(adjacent, 'unreviewed');
  const extra = await f.ref(adjacent);
  await expect(f.workspaces.capture({ ...brief, rules: [...brief.rules, extra] })).rejects.toThrow(
    'private-coder-input',
  );
  await expect(f.workspaces.capture({ ...brief, rules: [], files: [role] })).rejects.toThrow(
    'private-coder-input',
  );
  const unbound = installed + '/procedures/audit.md';
  await f.file(unbound, 'procedure outside coder role');
  const outside = { ...brief.procedures[0]!, id: 'audit' as const, ...(await f.ref(unbound)) };
  await expect(
    f.workspaces.capture({ ...brief, procedures: [...brief.procedures, outside] }),
  ).rejects.toThrow('private-coder-input');
  await link(resolve(f.root, profile), resolve(f.root, 'linked-profile'));
  await expect(f.workspaces.capture(brief)).rejects.toThrow('unsafe-coder-file');
  await unlink(resolve(f.root, 'linked-profile'));
  await rename(resolve(f.root, profile), resolve(f.root, 'original-profile'));
  await symlink(resolve(f.root, 'original-profile'), resolve(f.root, profile));
  await expect(f.workspaces.capture(brief)).rejects.toThrow('unsafe-coder-file');
  await unlink(resolve(f.root, profile));
  await rename(resolve(f.root, 'original-profile'), resolve(f.root, profile));
  await startCoder(brief, f.deps);
  f.deps.sessions.result = async (run) => {
    expect(await readFile(resolve(run.brief.copy_root, profile), 'utf8')).toBe(
      'installed coder role',
    );
    await expect(readFile(resolve(run.brief.copy_root, adjacent))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    for (const procedure of brief.procedures)
      expect(await readFile(resolve(run.brief.copy_root, procedure.locator))).toEqual(
        await readFile(resolve(f.root, procedure.locator)),
      );
    await writeFile(resolve(run.brief.copy_root, profile), 'forbidden change');
    return { outcome: 'PASS', evidence: f.proof, checks: [], errors: [], limitations: [] };
  };
  await runCoder('installed', f.deps);
  await expect(integrateCoder('installed', f.deps)).rejects.toThrow('coder-protected-change');
  expect(await readFile(resolve(f.root, profile), 'utf8')).toBe('installed coder role');
});
