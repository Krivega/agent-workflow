import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import registry from './check-areas.profiles.json' with { type: 'json' };
import original from './vitest.temporal.config.mjs';
import areas from './vitest.areas.config.mjs';

const root = resolve(import.meta.dirname);
const require = createRequire(import.meta.url);
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const baseline = JSON.parse(readFileSync(resolve(root, 'check-areas.baseline.json')));
const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json')));
const buildConfig = JSON.parse(readFileSync(resolve(import.meta.dirname, 'tsconfig.build.json')));
const sorted = (values) => [...values].sort();
const files = (groups) => groups.flatMap((group) => group.files);
function assertProfileResources(profile, hasPath = (path) => existsSync(resolve(root, path))) {
  const output = 'dist';
  for (const path of profile.resources) {
    if (path === output || path.startsWith(`${output}/`)) {
      assert.equal(profile.cwd, '.');
      assert.equal(profile.buildPrerequisite, 'yarn build');
      assert.equal(packageJson.scripts.build, 'tsc -p tsconfig.build.json');
      assert.equal(buildConfig.compilerOptions.outDir, 'dist');
      assert.equal(buildConfig.compilerOptions.rootDir, 'src');
      assert.deepEqual(buildConfig.include, ['src/**/*.ts']);
      assert.ok(path === output || path.endsWith('.js'), `Unknown build output: ${path}`);
      const source = path.replace(output, 'src').replace(/\.js$/, '.ts');
      assert.ok(hasPath(source), `Missing build source: ${source}`);
    } else assert.ok(hasPath(path), path);
  }
}
const discover = (config) =>
  JSON.parse(
    execFileSync(process.execPath, [vitest, 'list', '--config', config, '--filesOnly', '--json'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 ** 2,
    }),
  );

test('registers the exact 258 workflow and one harness2 root files without duplicate ownership', () => {
  assert.equal(registry.schemaVersion, 1);
  const registered = files(registry.repository.groups);
  assert.equal(new Set(registered).size, 263);
  assert.equal(registered.length, 263);
  assert.deepEqual(sorted(registered), sorted(baseline.rootTests.map((item) => item.path)));
  const harness = registry.repository.groups.find((group) => group.id === 'harness2');
  assert.deepEqual(harness.files, ['cli/harness2.test.ts']);
  assert.equal(registered.length - harness.files.length - registry.baseline.toolingFiles, 258);
});

test('keeps all 80 standalone tests independently from their root-project registration', () => {
  const registered = files(registry.temporal.groups);
  assert.equal(new Set(registered).size, 80);
  assert.equal(registered.length, 80);
  const old = discover('vitest.temporal.config.mjs');
  const current = discover('vitest.areas.config.mjs');
  const paths = (items) => sorted(items.map((item) => relative(import.meta.dirname, item.file)));
  assert.deepEqual(paths(old), sorted(registered));
  assert.deepEqual(paths(current), paths(old));
  for (const group of registry.temporal.groups)
    assert.deepEqual(
      paths(current.filter((item) => item.projectName === `temporal-${group.id}`)),
      sorted(group.files),
    );
});

test('inherits standalone strictness and isolates its artifacts without importing repository config', () => {
  assert.deepEqual(areas.test.coverage.include, original.test.coverage.include);
  assert.deepEqual(areas.test.coverage.exclude, original.test.coverage.exclude);
  assert.deepEqual(areas.test.coverage.thresholds, {
    lines: 100,
    statements: 100,
    functions: 100,
    branches: 100,
  });
  assert.equal(areas.test.globals, original.test.globals);
  assert.equal(areas.test.maxWorkers, original.test.maxWorkers);
  assert.equal(areas.root, import.meta.dirname);
  assert.equal(
    areas.test.coverage.reportsDirectory,
    resolve(import.meta.dirname, 'tmp/check-areas/temporal/coverage'),
  );
  assert.equal(
    areas.test.outputFile.junit,
    resolve(import.meta.dirname, 'tmp/check-areas/temporal/junit.xml'),
  );
  for (const name of ['vitest.temporal.config.mjs', 'vitest.areas.config.mjs']) {
    const source = readFileSync(resolve(import.meta.dirname, name), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*)['"]\.\.\//);
    assert.doesNotMatch(source, /readFile|\.\.\/\.\.\/|process\.cwd/);
  }
});

test('discovers standalone profiles from a separate source-free configuration copy', () => {
  const copy = realpathSync(mkdtempSync(resolve(tmpdir(), 'workflow-check-areas-')));
  try {
    for (const name of [
      'vitest.temporal.config.mjs',
      'vitest.areas.config.mjs',
      'check-areas.profiles.json',
    ])
      copyFileSync(resolve(import.meta.dirname, name), resolve(copy, name));
    writeFileSync(resolve(copy, 'package.json'), '{"type":"module"}');
    symlinkSync(
      resolve(dirname(require.resolve('vitest/package.json')), '..'),
      resolve(copy, 'node_modules'),
      'dir',
    );
    for (const path of files(registry.temporal.groups)) {
      mkdirSync(dirname(resolve(copy, path)), { recursive: true });
      writeFileSync(resolve(copy, path), 'export {};\n');
    }
    const actual = JSON.parse(
      execFileSync(
        process.execPath,
        [vitest, 'list', '--config', 'vitest.areas.config.mjs', '--filesOnly', '--json'],
        { cwd: copy, encoding: 'utf8' },
      ),
    );
    assert.deepEqual(
      sorted(actual.map((item) => relative(copy, item.file))),
      sorted(files(registry.temporal.groups)),
    );
    assert.equal(existsSync(resolve(copy, 'vitest.config.ts')), false);
    assert.equal(existsSync(resolve(copy, 'src')), false);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('repository profiles discover the exact original file/project pairs and retain all original commands', () => {
  const actual = registry.repository.groups.flatMap((group) =>
    discover(`check-areas/${group.id}.config.mjs`).map((item) => ({
      path: relative(root, item.file),
      project: item.projectName,
    })),
  );
  const pairs = (items) => sorted(items.map((item) => `${item.project}:${item.path}`));
  const expected = baseline.rootTests.filter((item) => item.path.startsWith(''));
  assert.deepEqual(pairs(actual), pairs(expected));
  assert.equal(new Set(pairs(actual)).size, actual.length);
  assert.equal(packageJson.scripts.test, 'vitest run --config vitest.config.ts');
  assert.equal(
    packageJson.scripts['test:coverage'],
    'vitest run --config vitest.config.ts --coverage',
  );
});

test('narrow commands have unique artifact locations and repository configs stay outside the published files', () => {
  const artifacts = new Set();
  for (const group of registry.temporal.groups) {
    const command = packageJson.scripts[`test:areas:${group.id}`];
    assert.ok(command.includes(`--project temporal-${group.id}`));
    const location = `tmp/check-areas/temporal-${group.id}`;
    assert.ok(command.includes(`--outputFile.junit=${location}/junit.xml`));
    assert.ok(command.includes(`--coverage.reportsDirectory=${location}/coverage`));
    artifacts.add(location);
  }
  assert.equal(artifacts.size, registry.temporal.groups.length);
  assert.ok(!packageJson.files.includes('check-areas'));
  assert.ok(!packageJson.files.includes('check-areas.profiles.json'));
  for (const group of registry.repository.groups) {
    assert.ok(group.files.length > 0);
    assert.ok(group.coverageInclude.length > 0);
    assert.equal(
      packageJson.scripts[`test:repo:${group.id}`],
      `vitest run --config check-areas/${group.id}.config.mjs`,
    );
  }
});

test('registers every other workflow check with its existing driver and explicit external boundaries', () => {
  const additional = registry.additionalRunners.flatMap((profile) => profile.files);
  const registered = [...files(registry.repository.groups), ...additional];
  assert.equal(new Set(registered).size, registered.length);
  const inventory = JSON.parse(readFileSync(resolve(root, 'check-areas.source-inventory.json')));
  assert.deepEqual(
    sorted(registered),
    sorted([...inventory.tests.map((item) => item.path), 'check-areas.profiles.test.mjs']),
  );
  assert.ok(registered.every((path) => !path.includes('/evidence/')));
  for (const profile of registry.additionalRunners) {
    for (const key of ['cwd', 'command', 'limits', 'status'])
      assert.equal(typeof profile[key], 'string');
    for (const key of ['files', 'resources', 'env', 'output'])
      assert.ok(Array.isArray(profile[key]));
    assertProfileResources(profile);
    if (profile.id.startsWith('workflow.native.') || profile.id.startsWith('workflow.installed.')) {
      assert.equal(profile.status, 'pending');
      assert.ok(profile.env.some((condition) => /authorization/.test(condition)));
      assert.ok(profile.drivers.length > 0);
    }
  }
});

test('validates clean-checkout resources from tracked sources and explicit build prerequisites', () => {
  const tracked = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const hasPath = (path) => tracked.some((file) => file === path || file.startsWith(`${path}/`));
  assert.equal(hasPath('dist'), false);
  for (const profile of [...registry.additionalRunners, ...registry.supplementalProfiles])
    assertProfileResources(profile, hasPath);

  const profile = registry.additionalRunners.find((item) => item.id === 'workflow.node.retention');
  assert.throws(() =>
    assertProfileResources({ ...profile, buildPrerequisite: undefined }, hasPath),
  );
  assert.throws(() =>
    assertProfileResources({ ...profile, buildPrerequisite: 'yarn missing' }, hasPath),
  );
  for (const path of ['missing-source.ts', 'dist/missing-output.js', 'dist-unrelated/missing.js'])
    assert.throws(
      () => assertProfileResources({ ...profile, resources: [path] }, hasPath),
      /Missing build source|missing/,
    );
  assert.throws(
    () =>
      assertProfileResources(
        profile,
        (path) => path !== 'src/adapters/artifacts/files.ts' && hasPath(path),
      ),
    /Missing build source/,
  );
});

test('developer commands referenced by the check profiles exist in the standalone package', () => {
  for (const entry of [...registry.repository.groups, ...registry.additionalRunners]) {
    const command = /^yarn ([-:\w]+)/u.exec(entry.command)?.[1];
    assert.ok(command && Object.hasOwn(packageJson.scripts, command), entry.command);
  }
  for (const command of [
    'comparison:h06:package',
    'comparison:h06:preflight',
    'harness2',
    'harness2:test',
  ])
    assert.ok(Object.hasOwn(packageJson.scripts, command), command);
});

test('Temporal CLI preparation fails closed on a mismatched release and keeps the previous binary', () => {
  const copy = mkdtempSync(resolve(tmpdir(), 'workflow-temporal-setup-'));
  try {
    const scripts = resolve(copy, 'scripts');
    const output = resolve(copy, 'tmp/temporal-downloads');
    mkdirSync(scripts);
    mkdirSync(output, { recursive: true });
    const prepare = resolve(scripts, 'prepareTemporalCli.sh');
    copyFileSync(resolve(root, 'scripts/prepareTemporalCli.sh'), prepare);
    const installed = resolve(output, 'temporal-v1.9.1');
    writeFileSync(installed, 'previous');
    const archive = resolve(copy, 'invalid.tar.gz');
    writeFileSync(archive, 'invalid');
    assert.throws(() => execFileSync('sh', [prepare, archive], { stdio: 'pipe' }));
    assert.equal(readFileSync(installed, 'utf8'), 'previous');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
