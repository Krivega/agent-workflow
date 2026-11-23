import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkPackageFiles } from './pinned-consumers.mjs';
import {
  tarPath,
  checkPackageClosure,
  packageClosureCli,
  packageClosurePlan,
} from './packageClosure.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const output = resolve('tmp/package-closure-maintained-20261030');
mkdirSync(output, { recursive: true });
const evidence = mkdtempSync(join(output, 'unit-'));
const owned = [];
function fixture(files = {}, metadata = {}, link = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'package-closure-unit-')));
  const all = {
    'dist/contracts/project.js': 'export const value = 1;',
    'yarn.lock': '# yarn lockfile v1\n',
    ...files,
  };
  const meta = {
    name: 'fixture',
    exports: { './contracts': './dist/contracts/project.js' },
    ...metadata,
  };
  all['package.json'] = JSON.stringify(meta);
  for (const [path, bytes] of Object.entries(all)) {
    mkdirSync(dirname(join(root, 'package', path)), { recursive: true });
    writeFileSync(join(root, 'package', path), bytes);
  }
  if (link) symlinkSync('project.js', join(root, 'package/dist/contracts/link.js'));
  const path = join(root, 'fixture.tgz');
  execFileSync(tarPath, ['-czf', path, '-C', root, 'package'], {
    timeout: 2000,
  });
  const bytes = readFileSync(path);
  assert.ok(bytes.length < 8 * 1024 * 1024);
  const manifest = {
    schemaVersion: 1,
    archive: { path, sha256: digest(bytes), bytes: bytes.length },
    additionalRoots: [],
    trustedAssets: [],
  };
  const result = { root, manifest, results: [] };
  owned.push(result);
  return result;
}
function check(fixture) {
  try {
    const result = checkPackageClosure(fixture.manifest);
    fixture.results.push(result);
    return result;
  } catch (error) {
    fixture.results.push({ status: 'FAIL', error: String(error) });
    throw error;
  }
}
afterEach(() => {
  for (const fixture of owned.splice(0)) {
    const directory = mkdtempSync(join(evidence, 'case-'));
    cpSync(fixture.manifest.archive.path, join(directory, 'fixture.tgz'));
    writeFileSync(join(directory, 'original-manifest.json'), JSON.stringify(fixture.manifest));
    const replay = {
      ...fixture.manifest,
      archive: {
        ...fixture.manifest.archive,
        path: join(directory, 'fixture.tgz'),
      },
    };
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(replay));
    writeFileSync(join(directory, 'results.json'), JSON.stringify(fixture.results));
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('closes the actual RED: an allowed tar path can still import an absent relative file', () => {
  const f = fixture({ 'dist/contracts/project.js': "import './missing.js';" });
  const entries = execFileSync(tarPath, ['-tzf', f.manifest.archive.path], {
    encoding: 'utf8',
    timeout: 2000,
  })
    .trim()
    .split('\n');
  checkPackageFiles(entries);
  assert.equal(check(f).errors[0].code, 'missing-or-nonregular-relative');
});

test('rejects npm integrity for different archive bytes', () => {
  const f = fixture();
  assert.throws(
    () => checkPackageClosure({ ...f.manifest, npmIntegrity: 'sha512-mismatch' }),
    /npm integrity mismatch/u,
  );
});

test('allows bounded directory URL locators but keeps imports and absent directories fail-closed', () => {
  const code = (specifier) =>
    `export const path = new URL(${JSON.stringify(specifier)}, import.meta.url);`;
  for (const target of ['..', '../..']) {
    const f = fixture({ 'dist/contracts/project.js': code(target) });
    const result = check(f);
    assert.equal(result.errors.length, 0);
    assert.ok(result.graph.some((edge) => edge.kind === 'literal-url-directory'));
  }
  for (const target of ['./missing/', '../../../']) {
    assert.ok(check(fixture({ 'dist/contracts/project.js': code(target) })).errors.length > 0);
  }
  assert.ok(check(fixture({ 'dist/contracts/project.js': "import '..';" })).errors.length > 0);
  assert.ok(
    check(
      fixture({
        'dist/contracts/project.js':
          "import { readFileSync } from 'node:fs'; export const bytes = readFileSync(new URL('..', import.meta.url));",
      }),
    ).errors.length > 0,
  );
});

test('accepts real Yarn-created directory members without a trailing slash', () => {
  const f = fixture({}, { version: '1.0.0', private: true, files: ['dist', 'yarn.lock'] });
  assert.equal(
    JSON.parse(readFileSync(join(f.root, 'package/package.json'), 'utf8')).scripts,
    undefined,
  );
  const output = execFileSync(
    'yarn',
    ['--offline', '--ignore-scripts', 'pack', '--filename', f.manifest.archive.path],
    { cwd: join(f.root, 'package'), encoding: 'utf8', timeout: 5000 },
  );
  f.results.push({ kind: 'yarn-pack-fixture', output });
  const bytes = readFileSync(f.manifest.archive.path);
  assert.ok(bytes.length < 8 * 1024 * 1024);
  f.manifest.archive.sha256 = digest(bytes);
  f.manifest.archive.bytes = bytes.length;
  const listing = execFileSync(tarPath, ['-tvzf', f.manifest.archive.path], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.ok(
    listing.split('\n').some((row) => row.startsWith('d') && !row.endsWith('/')),
    'fixture must contain an actual directory without slash',
  );
  f.results.push({ kind: 'tar-inventory', listing });
  assert.equal(check(f).status, 'STATIC_CLOSURE_PASS');
});

test('keeps tar file/directory types authoritative and permits implicit directory parents', () => {
  for (const parent of ['package', 'package/dist']) {
    const f = fixture();
    writeFileSync(join(f.root, 'shadow'), 'regular parent');
    execFileSync(
      tarPath,
      [
        '-czf',
        f.manifest.archive.path,
        '-C',
        f.root,
        '-s',
        `,^shadow$,${parent},`,
        'shadow',
        'package/package.json',
        'package/yarn.lock',
        'package/dist/contracts/project.js',
      ],
      { timeout: 2000 },
    );
    const bytes = readFileSync(f.manifest.archive.path);
    f.manifest.archive.sha256 = digest(bytes);
    f.manifest.archive.bytes = bytes.length;
    assert.throws(() => check(f), /parent must be a directory/u);
  }
  const invalid = fixture();
  writeFileSync(join(invalid.root, 'shadow'), 'regular file with slash');
  execFileSync(
    tarPath,
    [
      '-czf',
      invalid.manifest.archive.path,
      '-C',
      invalid.root,
      '-s',
      ',^shadow$,package/dist/wrong/,',
      'shadow',
      'package/package.json',
      'package/yarn.lock',
      'package/dist/contracts/project.js',
    ],
    { timeout: 2000 },
  );
  let bytes = readFileSync(invalid.manifest.archive.path);
  invalid.manifest.archive.sha256 = digest(bytes);
  invalid.manifest.archive.bytes = bytes.length;
  assert.throws(
    () => check(invalid),
    /regular file has directory spelling|tar diagnostics rejected/u,
  );
  const implicit = fixture();
  execFileSync(
    tarPath,
    [
      '-czf',
      implicit.manifest.archive.path,
      '-C',
      implicit.root,
      'package/package.json',
      'package/yarn.lock',
      'package/dist/contracts/project.js',
    ],
    { timeout: 2000 },
  );
  bytes = readFileSync(implicit.manifest.archive.path);
  implicit.manifest.archive.sha256 = digest(bytes);
  implicit.manifest.archive.bytes = bytes.length;
  assert.equal(check(implicit).status, 'STATIC_CLOSURE_PASS');
});

test('rejects transitive undeclared bare imports, escapes and missing literal assets', () => {
  /** @type {[string, Record<string, string>, string][]} */
  const cases = [
    [
      "import '../hidden.js';",
      { 'dist/hidden.js': "import 'undeclared/subpath';" },
      'undeclared-bare',
    ],
    ["import '../../../outside.js';", {}, 'archive-escape-or-invalid-path'],
    ["new URL('./missing.json', import.meta.url);", {}, 'missing-or-nonregular-relative'],
  ];
  for (const [source, files, code] of cases) {
    const f = fixture({ 'dist/contracts/project.js': source, ...files });
    assert.ok(check(f).errors.some((error) => error.code === code));
  }
});

test('reads static/dynamic/require/self/dependency edges without running any archive code', () => {
  const f = fixture(
    {
      'dist/contracts/project.js':
        "import {createRequire as make} from 'node:module'; const localRequire=make(import.meta.url); localRequire.resolve('../data'); import('../other.js'); export * from '../other.js'; import 'fixture/other'; import 'allowed/subpath'; throw new Error('must never execute');",
      'dist/other.js': 'export const other = 1;',
      'dist/data.json': '{}',
    },
    {
      exports: {
        './contracts': './dist/contracts/project.js',
        './other': './dist/other.js',
      },
      dependencies: { allowed: '1.0.0' },
    },
  );
  const report = check(f);
  assert.equal(report.status, 'STATIC_CLOSURE_PASS');
  assert.equal(report.qualification, false);
  assert.ok(report.graph.some((edge) => edge.kind === 'require.resolve'));
  assert.ok(report.graph.some((edge) => edge.kind === 'dynamic-import'));
  assert.ok(report.graph.some((edge) => edge.kind === 'self-export'));
  assert.ok(report.graph.some((edge) => edge.boundary === 'declared-direct-dependency'));
  assert.equal(existsSync(join(f.root, 'executed')), false);
});

test('binds literal consumer roots and declared assets to exact archive source hashes', () => {
  const consumer = "installedModule('extra.js'); join(installed, 'dist/worker.js');";
  const source = 'new URL(`../${name}.md`, import.meta.url);';
  const f = fixture(
    {
      'examples/consumer.mjs': consumer,
      'dist/extra.js': "import './contracts/project.js';",
      'dist/worker.js': '',
      'dist/contracts/project.js': source,
      'procedures/audit.md': 'audit',
    },
    { scripts: { reader: 'node dist/worker.js --status' } },
  );
  f.manifest.additionalRoots.push({
    target: 'package/dist/extra.js',
    source: { path: 'package/examples/consumer.mjs', sha256: digest(consumer) },
  });
  f.manifest.additionalRoots.push({
    target: 'package/dist/worker.js',
    source: { path: 'package/examples/consumer.mjs', sha256: digest(consumer) },
  });
  f.manifest.trustedAssets.push({
    source: {
      path: 'package/dist/contracts/project.js',
      sha256: digest(source),
    },
    paths: ['package/procedures/audit.md'],
  });
  const report = check(f);
  assert.equal(report.status, 'STATIC_CLOSURE_WITH_UNKNOWNS');
  assert.equal(report.complete, false);
  assert.equal(report.unknown[0].kind, 'computed-or-external-url');
  assert.equal(report.assetBindings.length, 1);
  assert.ok(report.roots.some((root) => root.kind === 'package-script'));
  f.manifest.trustedAssets[0].source.sha256 = '0'.repeat(64);
  assert.throws(() => check(f), /binding mismatch/u);
});

test('refuses invented consumer declarations, changed hashes, links and unbound assets', () => {
  const f = fixture({
    'examples/consumer.mjs': "const unused = 'dist/not-a-call.js';",
    'dist/not-a-call.js': '',
  });
  f.manifest.additionalRoots.push({
    target: 'package/dist/not-a-call.js',
    source: {
      path: 'package/examples/consumer.mjs',
      sha256: digest("const unused = 'dist/not-a-call.js';"),
    },
  });
  assert.throws(() => check(f), /literal declaration/u);
  const linked = fixture({}, {}, true);
  assert.throws(() => check(linked), /nonregular/u);
  const changed = fixture();
  changed.manifest.archive.sha256 = 'a'.repeat(64);
  assert.throws(() => check(changed), /pin mismatch/u);
  const asset = fixture();
  asset.manifest.trustedAssets.push({
    source: {
      path: 'package/dist/contracts/project.js',
      sha256: digest('export const value = 1;'),
    },
    paths: ['package/procedures/missing.md'],
  });
  assert.throws(() => check(asset), /regular/u);
});

test('preserves computed/external unknown and ignores source-map-like strings', () => {
  const f = fixture({
    'dist/contracts/project.js':
      "import {readFileSync} from 'node:fs'; const text=\"import('./missing.js')\"; import(variable); require(variable); new URL(variable, import.meta.url); readFileSync(input); Worker.create({workflowsPath});",
  });
  const report = check(f);
  assert.equal(report.errors.length, 0);
  assert.equal(report.complete, false);
  assert.equal(report.unknown.length, 5);
  assert.equal(report.qualification, false);
});

test('provides plan/check CLI with explicit pin bounds and no installed qualification', () => {
  const plan = packageClosurePlan();
  assert.equal(plan.manifest.archive.bytes, null);
  assert.equal(packageClosureCli(['--plan']).exitCode, 0);
  const f = fixture(),
    path = join(f.root, 'manifest.json');
  writeFileSync(path, JSON.stringify(f.manifest));
  assert.equal(packageClosureCli(['--check', path]).report.status, 'STATIC_CLOSURE_PASS');
  for (const args of [[], ['--run'], ['--check', 'relative']])
    assert.equal(packageClosureCli(args).exitCode, 1);
  f.manifest.archive.bytes = 0;
  assert.throws(() => check(f), /size bound/u);
});

test('follows the published TypeScript CLI only through its declared tsx runtime boundary', () => {
  const files = {
    'cli/entry.mjs': "import 'tsx/esm/api'; await import('./main.ts');",
    'cli/main.ts': "export { value } from '../core/value.js';",
    'core/value.ts': "export { value } from '../src/contracts/typed.js';",
    'src/contracts/typed.ts': 'export const value: number = 1;',
  };
  const metadata = {
    bin: { 'agent-workflow': 'cli/entry.mjs' },
    dependencies: { tsx: '4.23.15' },
  };
  const result = check(fixture(files, metadata));
  assert.equal(result.complete, true);
  assert.ok(result.reachable.includes('package/core/value.ts'));
  assert.equal(check(fixture(files, { bin: metadata.bin })).complete, false);
  assert.equal(
    check(fixture({ ...files, 'core/value.ts': "export * from './absent.js';" }, metadata))
      .complete,
    false,
  );
  assert.equal(
    check(fixture(files, { ...metadata, bin: { bad: '../outside.js' } })).complete,
    false,
  );
});
