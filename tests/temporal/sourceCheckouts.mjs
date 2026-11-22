import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function sourceCheckouts(roots, execute = execFileSync) {
  const denied = new Set();
  for (const root of new Set(roots.map((entry) => realpathSync(entry)))) {
    const common = realpathSync(
      execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    );
    assert.equal(basename(common), '.git', 'Expected a regular repository or a linked worktree');
    denied.add(root);
    denied.add(dirname(common));
  }
  return [...denied];
}

export function copyValidationCheckout(source, copy) {
  const git = (cwd, args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const head = git(source, ['rev-parse', 'HEAD']).trim();
  git(source, ['clone', '--quiet', '--no-local', '--no-checkout', '--', source, copy]);
  git(copy, ['reset', '--quiet', '--mixed', head]);
  const names = git(source, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
  for (const name of new Set(names)) {
    const origin = join(source, name);
    if (!existsSync(origin)) continue;
    assert.ok(
      realpathSync(origin) === origin && lstatSync(origin).isFile(),
      'Unexpected validation input: ' + name,
    );
    const target = join(copy, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(origin, target);
  }
  git(copy, ['add', '--all']);
}
