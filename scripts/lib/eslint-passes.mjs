import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { ESLint } from 'eslint';

export const eslintTargets = ['.'];
const rootOutputs = new Set(['dist', 'coverage', 'tmp']);
const configurationPattern =
  /^(?:package\.json|yarn\.lock|\.editorconfig|\.prettier.*|prettier\.config\..+|eslint\.config\..+|tsconfig.*\.json)$/u;

function collectFiles(path, root) {
  // Follow file links, but reject directory links instead of silently missing inputs or cycles.
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (
      ['.git', 'node_modules'].includes(entry.name) ||
      (path === root && rootOutputs.has(entry.name))
    )
      return [];
    const child = join(path, entry.name);
    if (entry.isSymbolicLink() && statSync(child).isDirectory()) {
      throw new Error(`ESLint input directory must not be a symbolic link: ${child}`);
    }
    return collectFiles(child, root);
  });
}

export function isFileLocalRule(id, plugins) {
  if (!id.includes('/') || id.startsWith('@stylistic/') || id === 'prettier/prettier') return true;
  if (!id.startsWith('@typescript-eslint/')) return false;
  const docs =
    plugins['@typescript-eslint']?.rules?.[id.slice('@typescript-eslint/'.length)]?.meta?.docs;
  return Boolean(docs) && docs.requiresTypeChecking !== true;
}

export function cacheFingerprint(cwd, files) {
  const inputs = new Set(files.filter((file) => configurationPattern.test(basename(file))));
  // Include root configs and ancestor EditorConfig files (Prettier reads those as well).
  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    if (!entry.isDirectory() && configurationPattern.test(entry.name))
      inputs.add(join(cwd, entry.name));
  }
  let directory = dirname(cwd);
  while (true) {
    for (const name of readdirSync(directory)) {
      if (name === '.editorconfig') inputs.add(join(directory, name));
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const digest = createHash('sha256')
    .update(process.version)
    .update(readFileSync(import.meta.filename));
  for (const file of [...inputs].sort())
    digest.update(file).update('\0').update(readFileSync(file)).update('\0');
  return digest.digest('hex');
}

export async function prepareEslintPass({ cwd, pass, targets = eslintTargets }) {
  if (!['full', 'cached'].includes(pass)) throw new Error(`Unknown ESLint pass: ${pass}`);
  const options = {
    cwd,
    overrideConfig: {
      files: ['**/*.{ts,tsx,mts,mjs,cjs}'],
      linterOptions: { reportUnusedDisableDirectives: 'error' },
    },
  };
  const baseline = new ESLint(options);
  const discovered = targets.flatMap((target) => collectFiles(resolve(cwd, target), resolve(cwd)));
  const files = [];
  const protectedFiles = [];
  const decisions = new Map();
  const seen = new Set();
  for (const file of discovered) {
    if (!/\.(?:[cm]?js|ts|tsx|mts)$/.test(file)) continue;
    const config = await baseline.calculateConfigForFile(file);
    if (!config) continue;
    files.push(file);
    if (/\beslint(?:-|\s)/u.test(readFileSync(file, 'utf8'))) protectedFiles.push(file);
    if (seen.has(config)) continue;
    seen.add(config);
    for (const id of Object.keys(config.rules ?? {})) {
      // A rule is cacheable only if every effective configuration considers it file-local.
      decisions.set(id, (decisions.get(id) ?? true) && isFileLocalRule(id, config.plugins));
    }
  }
  if (pass === 'full' && files.length === 0) throw new Error('No lintable files found');
  const off = Object.fromEntries(
    [...decisions].filter(([, local]) => local === (pass === 'full')).map(([id]) => [id, 'off']),
  );
  const protectedPatterns = protectedFiles.map((file) =>
    relative(cwd, file)
      .split(sep)
      .join('/')
      .replace(/[\\?*\[\]{}()!+@]/gu, '\\$&'),
  );
  const overrideConfig = [options.overrideConfig];
  if (pass === 'full') {
    overrideConfig.push({ ignores: protectedPatterns, rules: off });
  } else {
    overrideConfig.push(
      { ignores: protectedPatterns },
      {
        rules: off,
        languageOptions: { parserOptions: { project: false, projectService: false } },
        settings: { validationFileLocalCache: cacheFingerprint(cwd, discovered) },
      },
    );
  }
  const engine = new ESLint({
    ...options,
    overrideConfig,
    cache: pass === 'cached',
    cacheStrategy: 'content',
    cacheLocation: join(
      cwd,
      pass === 'cached'
        ? 'node_modules/.cache/eslint/file-local.eslintcache'
        : 'node_modules/.cache/eslint-unused',
    ),
  });
  return {
    engine,
    files: pass === 'full' ? files : files.filter((file) => !protectedFiles.includes(file)),
  };
}
