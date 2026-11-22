import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeWorkspaceMatches } from '../../src/adapters/codex/nativeWorkspace.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(resolve(tmpdir(), 'native-workspace-')));
  roots.push(root);
  const origin = resolve(root, 'origin'),
    workspace = resolve(root, 'checkout'),
    common = resolve(origin, '.git'),
    gitdir = resolve(common, 'worktrees/checkout');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(resolve(workspace, '.git'), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(resolve(gitdir, 'commondir'), '../..\n');
  fs.writeFileSync(resolve(gitdir, 'gitdir'), resolve(workspace, '.git') + '\n');
  const session: Record<string, unknown> = {
    cwd: origin,
    cli_version: '0.165.0-alpha.1.2',
    source: 'vscode',
    originator: 'codex_work_desktop',
    thread_source: 'user',
  };
  const context: Record<string, unknown> = { turn_id: 'command-turn', cwd: workspace };
  const contexts = [context];
  return {
    root,
    origin,
    workspace,
    common,
    gitdir,
    session,
    context,
    contexts,
    matches: () => nativeWorkspaceMatches(session, contexts, 'command-turn', workspace),
  };
}

it('uses the command turn while retaining reciprocal Git metadata without writes', () => {
  const f = fixture();
  f.contexts.push({ turn_id: 'later-turn', cwd: '/different-current-workspace' });
  const paths = [
    resolve(f.workspace, '.git'),
    resolve(f.gitdir, 'commondir'),
    resolve(f.gitdir, 'gitdir'),
  ];
  const before = paths.map((path) => fs.readFileSync(path));
  expect(f.matches()).toBe(true);
  expect(paths.map((path) => fs.readFileSync(path))).toEqual(before);
  expect(fs.readdirSync(f.workspace)).toEqual(['.git']);
  fs.writeFileSync(resolve(f.workspace, '.git'), 'gitdir: ../origin/.git/worktrees/checkout');
  fs.writeFileSync(resolve(f.gitdir, 'commondir'), '../..');
  fs.writeFileSync(resolve(f.gitdir, 'gitdir'), '../../../../checkout/.git');
  Object.assign(f.session, { cwd: pathToFileURL(f.origin).href, forked_from_id: null });
  f.context.cwd = pathToFileURL(f.workspace).href;
  expect(f.matches()).toBe(true);
  f.session.cwd = f.workspace;
  f.context.cwd = f.origin;
  expect(nativeWorkspaceMatches(f.session, f.contexts, 'command-turn', f.origin)).toBe(true);
});

it.each([
  'old-version',
  'future-version',
  'source',
  'originator',
  'subagent',
  'fork',
  'missing-origin',
  'relative-origin',
  'origin-alias-spelling',
  'same-root',
  'missing-context',
  'foreign-context',
  'duplicate-context',
  'wrong-context-workspace',
  'missing-context-workspace',
])('does not substitute primary session/command-turn metadata: %s', (kind) => {
  const f = fixture();
  if (kind === 'old-version') f.session.cli_version = '0.164.0-alpha.11.1';
  if (kind === 'future-version') f.session.cli_version = '0.166.0';
  if (kind === 'source') f.session.source = 'exec';
  if (kind === 'originator') f.session.originator = 'foreign';
  if (kind === 'subagent') f.session.thread_source = 'subagent';
  if (kind === 'fork') f.session.forked_from_id = 'parent';
  if (kind === 'missing-origin') f.session.cwd = null;
  if (kind === 'relative-origin') f.session.cwd = 'relative';
  if (kind === 'origin-alias-spelling') f.session.cwd = f.origin + '/.';
  if (kind === 'same-root') f.session.cwd = f.workspace;
  if (kind === 'missing-context') f.contexts.splice(0);
  if (kind === 'foreign-context') f.context.turn_id = 'other';
  if (kind === 'duplicate-context') f.contexts.push({ ...f.context });
  if (kind === 'wrong-context-workspace') f.context.cwd = f.origin;
  if (kind === 'missing-context-workspace') delete f.context.cwd;
  expect(f.matches()).toBe(false);
});

it.each([
  'relative-workspace',
  'workspace-spelling',
  'workspace-file',
  'workspace-alias',
  'origin-alias',
  'foreign-repository',
  'missing-git',
  'git-alias',
  'git-hardlink',
  'git-directory-alias',
  'invalid-pointer',
  'missing-common',
  'unregistered-worktree',
  'wrong-backpointer',
  'linked-origin-backpointer',
])('refuses unproved physical Git registration: %s', (kind) => {
  const f = fixture();
  let workspace = f.workspace;
  if (kind === 'relative-workspace') workspace = 'relative';
  if (kind === 'workspace-spelling') workspace += '/.';
  if (kind === 'workspace-file') {
    workspace = resolve(f.root, 'file');
    fs.writeFileSync(workspace, 'ordinary file');
  }
  if (kind === 'workspace-alias') {
    workspace = resolve(f.root, 'alias');
    fs.symlinkSync(f.workspace, workspace);
  }
  if (kind === 'origin-alias') {
    f.session.cwd = resolve(f.root, 'origin-alias');
    fs.symlinkSync(f.origin, String(f.session.cwd));
  }
  if (kind === 'foreign-repository') {
    f.session.cwd = resolve(f.root, 'foreign');
    fs.mkdirSync(resolve(String(f.session.cwd), '.git'), { recursive: true });
  }
  if (kind === 'missing-git') fs.unlinkSync(resolve(workspace, '.git'));
  if (kind === 'git-alias' || kind === 'git-hardlink') {
    const path = resolve(workspace, '.git');
    fs.renameSync(path, path + '-original');
    if (kind === 'git-alias') fs.symlinkSync(path + '-original', path);
    else fs.linkSync(path + '-original', path);
  }
  if (kind === 'git-directory-alias') {
    fs.renameSync(f.common, f.common + '-original');
    fs.symlinkSync(f.common + '-original', f.common);
  }
  if (kind === 'invalid-pointer') fs.writeFileSync(resolve(workspace, '.git'), f.gitdir);
  if (kind === 'missing-common') fs.unlinkSync(resolve(f.gitdir, 'commondir'));
  if (kind === 'unregistered-worktree') {
    const moved = resolve(f.common, 'unregistered');
    fs.renameSync(f.gitdir, moved);
    fs.writeFileSync(resolve(moved, 'commondir'), '..\n');
    fs.writeFileSync(resolve(workspace, '.git'), `gitdir: ${moved}\n`);
  }
  if (kind === 'wrong-backpointer') fs.writeFileSync(resolve(f.gitdir, 'gitdir'), f.common + '\n');
  if (kind === 'linked-origin-backpointer') {
    f.session.cwd = f.workspace;
    workspace = f.origin;
    fs.writeFileSync(resolve(f.gitdir, 'gitdir'), f.common + '\n');
  }
  f.context.cwd = workspace;
  expect(() => nativeWorkspaceMatches(f.session, f.contexts, 'command-turn', workspace)).toThrow();
});

it.each(['empty', 'multiline', 'invalid-utf8', 'nul', 'oversized', 'directory'])(
  'refuses malformed Git metadata: %s',
  (kind) => {
    const f = fixture(),
      path = resolve(f.gitdir, 'commondir');
    if (kind === 'empty') fs.writeFileSync(path, '');
    if (kind === 'multiline') fs.writeFileSync(path, '../..\nforeign\n');
    if (kind === 'invalid-utf8') fs.writeFileSync(path, Buffer.from([0xff]));
    if (kind === 'nul') fs.writeFileSync(path, '../..\0');
    if (kind === 'oversized') fs.writeFileSync(path, 'x'.repeat(8193));
    if (kind === 'directory') {
      fs.unlinkSync(path);
      fs.mkdirSync(path);
    }
    expect(() => f.matches()).toThrow('chat-worktree-unconfirmed');
  },
);

it.each(['before-read', 'during-read', 'namespace', 'directory-namespace', 'metadata-error'])(
  'rejects metadata races and closes every opened descriptor: %s',
  async (kind) => {
    const f = fixture(),
      path = resolve(f.workspace, '.git');
    const { readFileSync: read, openSync: open } = await vi.importActual<typeof fs>('node:fs');
    const opened = vi.spyOn(fs, 'openSync').mockClear(),
      closed = vi.spyOn(fs, 'closeSync').mockClear();
    const change = () => fs.writeFileSync(path, `gitdir: ${f.gitdir}\n `);
    const hook =
      kind === 'before-read'
        ? opened.mockImplementationOnce((...args) => {
            change();
            return open(...args);
          })
        : vi.spyOn(fs, 'readFileSync').mockImplementationOnce((file) => {
            if (kind === 'metadata-error') throw new Error('injected metadata read error');
            const bytes = read(file);
            if (kind === 'during-read') change();
            else {
              fs.renameSync(f.workspace, f.workspace + '-old');
              fs.mkdirSync(f.workspace);
              if (kind === 'directory-namespace')
                fs.renameSync(resolve(f.workspace + '-old', '.git'), path);
              else fs.writeFileSync(path, `gitdir: ${f.gitdir}\n`);
            }
            return bytes;
          });
    try {
      expect(() => f.matches()).toThrow();
      expect(opened).toHaveBeenCalled();
      expect(closed).toHaveBeenCalledTimes(opened.mock.calls.length);
    } finally {
      hook.mockRestore();
      opened.mockRestore();
      closed.mockRestore();
    }
  },
);
