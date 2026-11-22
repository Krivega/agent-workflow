import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

import { formatAdrChangeValidationReport, validateAdrChanges } from './adrChangeValidation.ts';

const execFileAsync = promisify(execFile);

export async function validateAdrRepository(root, args = [], environment = process.env) {
  const warnings = [];
  const adrPathPattern = /^docs\/design\/decisions\/\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

  function parseBase(args) {
    if (args.length === 0) return environment.ADR_BASE_REF?.trim();
    if (args.length === 2 && args[0] === '--base' && args[1]) return args[1];
    throw new Error('Usage: yarn lint:adr:diff [--base <git-ref>]');
  }

  async function git(args) {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  async function resolveBase(explicitBase) {
    if (explicitBase) {
      await git(['rev-parse', '--verify', `${explicitBase}^{commit}`]);
      return explicitBase;
    }
    if (environment.CI && environment.CI !== 'false') {
      throw new Error('CI requires ADR_BASE_REF or --base with the trusted target commit.');
    }
    let remoteDefault;
    try {
      remoteDefault = (await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    } catch {
      // A local clone may have no remote default reference.
    }
    const references = new Set(
      (await git(['for-each-ref', '--format=%(refname)'])).trim().split('\n'),
    );
    for (const candidate of [remoteDefault, 'origin/main', 'origin/master', 'main', 'master']) {
      if (!candidate) continue;
      // Skip absent refs in one batch; Git still verifies the selected commit-ish and its priority.
      if (
        ![
          candidate,
          `refs/${candidate}`,
          `refs/tags/${candidate}`,
          `refs/heads/${candidate}`,
          `refs/remotes/${candidate}`,
          `refs/remotes/${candidate}/HEAD`,
        ].some((reference) => references.has(reference))
      )
        continue;
      try {
        await git(['rev-parse', '--verify', `${candidate}^{commit}`]);
        return candidate;
      } catch {
        // Try the next existing local reference without fetching or changing Git state.
      }
    }
    warnings.push(
      'ADR changes: no target reference; HEAD checks only uncommitted changes. Use --base.',
    );
    try {
      await git(['rev-parse', '--verify', 'HEAD^{commit}']);
      return 'HEAD';
    } catch {
      warnings.push(
        'ADR changes: unborn repository; every current ADR is checked as a new record.',
      );
      return undefined;
    }
  }

  async function baseRecord(base, repositoryPath) {
    const content = await git(['show', `${base}:${repositoryPath}`]);
    return {
      filename: path.posix.basename(repositoryPath),
      path: repositoryPath,
      content,
    };
  }

  async function workingRecord(repositoryPath) {
    return {
      filename: path.posix.basename(repositoryPath),
      path: repositoryPath,
      content: await readFile(path.join(root, repositoryPath), 'utf8'),
    };
  }

  async function collectChanges(base) {
    if (!base) {
      const paths = await git([
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        'docs/design/decisions/*.md',
      ]);
      const records = [...new Set(paths.split('\n').filter((p) => adrPathPattern.test(p)))];
      return {
        changes: await Promise.all(records.map(async (p) => ({ after: await workingRecord(p) }))),
        comparisonBase: 'unborn',
      };
    }
    const comparisonBase = (await git(['merge-base', 'HEAD', base])).trim();
    const [output, untracked] = await Promise.all([
      git([
        'diff',
        '--name-status',
        '--find-renames',
        comparisonBase,
        '--',
        'docs/design/decisions',
      ]),
      git(['ls-files', '--others', '--exclude-standard', '--', 'docs/design/decisions/*.md']),
    ]);
    const changes = [];
    const currentPaths = new Set();
    for (const line of output.split('\n').filter(Boolean)) {
      const [rawStatus, firstPath, secondPath] = line.split('\t');
      if (!rawStatus || !firstPath) continue;
      if (rawStatus.startsWith('R') && secondPath) {
        if (!adrPathPattern.test(firstPath) && !adrPathPattern.test(secondPath)) continue;
        changes.push({
          before: adrPathPattern.test(firstPath)
            ? await baseRecord(comparisonBase, firstPath)
            : undefined,
          after: adrPathPattern.test(secondPath) ? await workingRecord(secondPath) : undefined,
        });
        currentPaths.add(secondPath);
        continue;
      }
      if (!adrPathPattern.test(firstPath)) continue;
      currentPaths.add(firstPath);
      if (rawStatus === 'A') {
        changes.push({ after: await workingRecord(firstPath) });
      } else if (rawStatus === 'D') {
        changes.push({ before: await baseRecord(comparisonBase, firstPath) });
      } else {
        changes.push({
          before: await baseRecord(comparisonBase, firstPath),
          after: await workingRecord(firstPath),
        });
      }
    }

    for (const repositoryPath of untracked.split('\n').filter(Boolean)) {
      if (!adrPathPattern.test(repositoryPath) || currentPaths.has(repositoryPath)) continue;
      changes.push({ after: await workingRecord(repositoryPath) });
    }
    return { changes, comparisonBase };
  }

  const base = await resolveBase(parseBase(args));
  const maintenanceReason = environment.ADR_MAINTENANCE_REASON;
  const { changes, comparisonBase } = await collectChanges(base);
  const linkedPaths = (source, prefix) =>
    [...source.content.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)]
      .map((match) =>
        path.posix.normalize(
          path.posix.join(path.posix.dirname(source.path), match[1].split('#')[0]),
        ),
      )
      .filter((target) => target.startsWith(prefix));
  const originalPaths = new Set(
    changes.flatMap((change) =>
      change.before ? linkedPaths(change.before, 'docs/extraction/') : [],
    ),
  );
  const relocatedPaths = changes.flatMap((change) =>
    change.after ? linkedPaths(change.after, 'docs/design/decisions/') : [],
  );
  const baselineDocuments = (
    await Promise.all(
      [...originalPaths].map(async (documentPath) => {
        try {
          const { stdout: bytes } = await execFileAsync(
            'git',
            ['show', `${comparisonBase}:${documentPath}`],
            {
              cwd: root,
              maxBuffer: 10 * 1024 * 1024,
              encoding: 'buffer',
            },
          );
          const content = bytes.toString('utf8');
          if (!Buffer.from(content, 'utf8').equals(bytes)) return undefined;
          return {
            path: documentPath,
            content,
          };
        } catch {
          // Missing primary bytes never authorize a change to a protected section.
          return undefined;
        }
      }),
    )
  ).filter(Boolean);
  const documentPaths = await git([
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    '*.md',
    '*.mdc',
  ]);
  const documents = (
    await Promise.all(
      [...new Set([...documentPaths.split('\n').filter(Boolean), ...relocatedPaths])].map(
        async (documentPath) => {
          try {
            const bytes = await readFile(path.join(root, documentPath));
            const content = bytes.toString('utf8');
            if (!Buffer.from(content, 'utf8').equals(bytes)) return undefined;
            return {
              path: documentPath,
              content,
            };
          } catch (error) {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          }
        },
      ),
    )
  ).filter(Boolean);
  const issues = validateAdrChanges({ changes, documents, baselineDocuments });
  const output = [
    `${formatAdrChangeValidationReport(issues)} (base: ${base}, merge-base: ${comparisonBase})`,
  ];
  if (maintenanceReason?.trim())
    output.push(`ADR maintenance note (checks unchanged): ${maintenanceReason.trim()}`);
  return {
    issues,
    stdout: `${output.join('\n')}\n`,
    stderr: warnings.length ? `${warnings.join('\n')}\n` : '',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  validateAdrRepository(root, process.argv.slice(2)).then(
    (report) => {
      process.stdout.write(report.stdout);
      process.stderr.write(report.stderr);
      if (report.issues.length) process.exitCode = 1;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
