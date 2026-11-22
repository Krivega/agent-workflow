import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireContract } from '../../contracts/project.js';

function localPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.startsWith('file:') ? fileURLToPath(value) : value;
}

function confirmWorktreeOrigin(origin: string, workspace: string): void {
  const checks: (() => void)[] = [];
  const version = (s: Stats) =>
    [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
  function physicalDirectory(path: string) {
    requireContract(
      isAbsolute(path) &&
        resolve(path) === path &&
        realpathSync(path) === path &&
        lstatSync(path).isDirectory(),
      'chat-worktree-unconfirmed',
    );
  }
  function directory(path: string) {
    physicalDirectory(path);
    const before = version(lstatSync(path));
    checks.push(() => {
      physicalDirectory(path);
      requireContract(version(lstatSync(path)) === before, 'chat-worktree-unconfirmed');
    });
    return path;
  }
  function metadata(path: string) {
    directory(dirname(path));
    const before = lstatSync(path);
    requireContract(
      before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= 8192,
      'chat-worktree-unconfirmed',
    );
    const current = () => {
      requireContract(version(lstatSync(path)) === version(before), 'chat-worktree-unconfirmed');
    };
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      requireContract(version(fstatSync(fd)) === version(before), 'chat-worktree-unconfirmed');
      checks.forEach((check) => check());
      current();
      const bytes = readFileSync(fd),
        text = bytes.toString('utf8');
      requireContract(
        Buffer.from(text).equals(bytes) && /^[^\0\r\n]+\n?$/u.test(text),
        'chat-worktree-unconfirmed',
      );
      requireContract(version(fstatSync(fd)) === version(before), 'chat-worktree-unconfirmed');
      current();
      checks.push(current);
      return text.endsWith('\n') ? text.slice(0, -1) : text;
    } finally {
      closeSync(fd);
    }
  }
  function common(root: string) {
    directory(root);
    const marker = resolve(root, '.git');
    if (lstatSync(marker).isDirectory()) return directory(marker);
    const pointer = metadata(marker);
    requireContract(/^gitdir: .+$/u.test(pointer), 'chat-worktree-unconfirmed');
    const gitdir = directory(resolve(root, pointer.slice(8))),
      shared = directory(resolve(gitdir, metadata(resolve(gitdir, 'commondir'))));
    requireContract(dirname(gitdir) === resolve(shared, 'worktrees'), 'chat-worktree-unconfirmed');
    requireContract(
      resolve(gitdir, metadata(resolve(gitdir, 'gitdir'))) === marker,
      'chat-worktree-unconfirmed',
    );
    return shared;
  }
  requireContract(common(origin) === common(workspace), 'chat-worktree-unconfirmed');
  checks.forEach((check) => check());
}

/** A distinct worktree requires the original desktop root and the command's own native turn. */
export function nativeWorkspaceMatches(
  session: Record<string, unknown>,
  contexts: readonly Record<string, unknown>[],
  turnId: string,
  workspace: string,
): boolean {
  if (
    session.cli_version !== '0.165.0-alpha.1.2' ||
    session.source !== 'vscode' ||
    session.originator !== 'codex_work_desktop' ||
    session.thread_source !== 'user' ||
    (session.forked_from_id !== undefined && session.forked_from_id !== null)
  )
    return false;
  const origin = localPath(session.cwd),
    turns = contexts.filter((context) => context.turn_id === turnId);
  if (
    origin === null ||
    !isAbsolute(origin) ||
    resolve(origin) !== origin ||
    origin === workspace ||
    turns.length !== 1 ||
    localPath(turns[0]!.cwd) !== workspace
  )
    return false;
  confirmWorktreeOrigin(origin, workspace);
  return true;
}
