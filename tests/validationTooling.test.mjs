import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { ESLint } from 'eslint';
import {
  cacheFingerprint,
  isFileLocalRule,
  prepareEslintPass,
} from '../scripts/lib/eslint-passes.mjs';

const root = resolve(import.meta.dirname, '..');
const staticSuites = [
  'typecheck:tests',
  'build',
  'lint:architecture',
  'lint',
  'format:check',
  'lint:adr',
  'lint:docs',
  'lint:docs:references',
];
const testSuites = [
  'test:coverage',
  'test:node',
  'test:profiles',
  'test:pinned-consumers:unit',
  'test:installed-full-consumers:unit',
  'test:task-execution:self',
  'test:task-execution:contract',
  'test:package-closure',
];
const sorted = (values) => values.toSorted();
function temporary(run) {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-validation-'));
  return Promise.resolve()
    .then(() => run(directory))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}
function write(cwd, path, content) {
  const file = join(cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
function fakeYarn(cwd) {
  const events = join(cwd, 'events.jsonl');
  write(
    cwd,
    'yarn',
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const suite=process.argv[2];
const event=(type)=>appendFileSync(process.env.VALIDATION_EVENTS,JSON.stringify({type,suite})+'\\n');
event('start');
setTimeout(()=>{event('end');if(process.env.FAIL_SUITE===suite+'-signal')process.kill(process.pid,'SIGTERM');process.exit(suite===process.env.FAIL_SUITE?7:0)},suite==='format:check'?120:10);
`,
  );
  // The extensionless executable is ESM independently of its temporary parent.
  write(cwd, 'package.json', '{"type":"module"}');
  const result = spawnSync('chmod', ['+x', join(cwd, 'yarn')]);
  assert.equal(result.status, 0);
  return (args = [], fail = '', missing = false) => {
    writeFileSync(events, '');
    const result = spawnSync(process.execPath, [join(root, 'scripts/runValidation.mjs'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: missing ? join(cwd, 'missing') : cwd,
        VALIDATION_EVENTS: events,
        FAIL_SUITE: fail,
      },
    });
    return {
      ...result,
      events: readFileSync(events, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row)),
    };
  };
}

test('validation preserves the full suite set, build dependencies and an exclusive coverage phase', () =>
  temporary((cwd) => {
    const run = fakeYarn(cwd);
    for (const args of [[], ['--serial'], ['--static']]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const starts = result.events.filter((e) => e.type === 'start').map((e) => e.suite);
      assert.deepEqual(
        sorted(starts),
        sorted([...staticSuites, ...(args[0] === '--static' ? [] : testSuites)]),
      );
      let active = new Set();
      let completed = new Set();
      for (const event of result.events) {
        if (event.type === 'start') {
          if (args[0] === '--serial' || event.suite === 'test:coverage')
            assert.equal(active.size, 0);
          if (event.suite.startsWith('test:'))
            assert.ok(staticSuites.every((s) => completed.has(s)));
          if (event.suite.startsWith('test:') && event.suite !== 'test:coverage')
            assert.ok(completed.has('test:coverage'));
          if (['build', 'lint:architecture', 'lint'].includes(event.suite)) {
            const chain = staticSuites.slice(0, 4);
            assert.ok(chain.slice(0, chain.indexOf(event.suite)).every((s) => completed.has(s)));
          }
          active.add(event.suite);
        } else {
          active.delete(event.suite);
          completed.add(event.suite);
        }
      }
      assert.equal(active.size, 0);
    }
  }));

test('validation waits for other lanes on failure, blocks dependents and reports errors', () =>
  temporary((cwd) => {
    const run = fakeYarn(cwd);
    const result = run([], 'typecheck:tests');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /typecheck:tests \(7;/);
    assert.ok(result.events.some((e) => e.type === 'end' && e.suite === 'format:check'));
    assert.ok(result.events.some((e) => e.type === 'end' && e.suite === 'lint:docs'));
    assert.ok(!result.events.some((e) => e.suite === 'build' || e.suite.startsWith('test:')));
    const serial = run(['--serial'], 'typecheck:tests');
    assert.deepEqual(
      serial.events.map((e) => e.suite),
      ['typecheck:tests', 'typecheck:tests'],
    );
    const coverage = run([], 'test:coverage');
    assert.equal(coverage.status, 1);
    assert.ok(!coverage.events.some((e) => e.suite === 'test:node'));
    const launch = run([], '', true);
    assert.equal(launch.status, 1);
    assert.match(launch.stderr, /ENOENT/);
    const signalled = run([], 'typecheck:tests-signal');
    assert.equal(signalled.status, 1);
    assert.match(signalled.stderr, /SIGTERM/);
    for (const args of [['--unknown'], ['--serial', '--static'], ['--help']]) {
      const result = run(args);
      assert.equal(result.status, args[0] === '--help' ? 0 : 1);
      assert.equal(result.events.length, 0);
      assert.match(result.stdout + result.stderr, /Usage:/);
    }
  }));

const diagnostics = (results) =>
  sorted(
    results.flatMap((r) =>
      r.messages.map((m) =>
        JSON.stringify([r.filePath, m.ruleId, m.severity, m.message, m.line, m.column]),
      ),
    ),
  );
async function lint(cwd, pass) {
  const { engine, files } = await prepareEslintPass({ cwd, pass });
  return files.length ? engine.lintFiles(files) : [];
}

test('ESLint caches only known file-local rules', () => {
  const plugins = {
    '@typescript-eslint': {
      rules: {
        local: { meta: { docs: {} } },
        typed: { meta: { docs: { requiresTypeChecking: true } } },
        unknown: {},
      },
    },
  };
  for (const rule of ['no-debugger', '@typescript-eslint/local'])
    assert.equal(isFileLocalRule(rule, plugins), true);
  for (const rule of [
    'other/rule',
    '@typescript-eslint/typed',
    '@typescript-eslint/unknown',
    '@typescript-eslint/missing',
  ])
    assert.equal(isFileLocalRule(rule, plugins), false);
});

test('ESLint split preserves diagnostics, inline directives, ignored files and all original extensions', () =>
  temporary(async (cwd) => {
    write(
      cwd,
      'eslint.config.mjs',
      `export default [
    {ignores:['ignored/**']},
    {rules:{'no-debugger':'error','no-console':['warn',{allow:['warn']}]}}
  ];`,
    );
    for (const extension of ['js', 'mjs', 'cjs', 'ts', 'tsx', 'mts'])
      write(cwd, `src/example.${extension}`, 'debugger;console.log("x");');
    write(cwd, 'src/dist/kept.ts', 'debugger;');
    write(
      cwd,
      'src/[directives].mjs',
      '/* eslint-disable no-console */\nconsole.log("ok");\n// eslint-disable-next-line no-debugger\nconsole.warn("unused");',
    );
    write(cwd, 'ignored/invalid.js', 'invalid % javascript');
    write(cwd, 'node_modules/ignored.js', 'invalid % javascript');
    const baseline = new ESLint({
      cwd,
      overrideConfig: {
        files: ['**/*.{ts,tsx,mts,mjs,cjs}'],
        linterOptions: { reportUnusedDisableDirectives: 'error' },
      },
    });
    const expected = await baseline.lintFiles(['.']);
    const full = await lint(cwd, 'full');
    const cached = await lint(cwd, 'cached');
    assert.deepEqual(diagnostics([...full, ...cached]), diagnostics(expected));
    assert.ok(!cached.some((r) => r.filePath.includes('[directives]')));
    assert.ok(
      full.some((r) => r.messages.some((m) => m.message.includes('Unused eslint-disable'))),
    );
    assert.ok(cached.some((r) => r.filePath.endsWith('.mts')));
    assert.deepEqual(
      diagnostics([...(await lint(cwd, 'full')), ...(await lint(cwd, 'cached'))]),
      diagnostics(expected),
    );
    write(cwd, 'src/example.ts', 'console.warn("allowed");');
    assert.ok(
      !(await lint(cwd, 'cached')).find((r) => r.filePath.endsWith('/example.ts')).messages.length,
    );
    const paths = [join(cwd, 'eslint.config.mjs')];
    const before = cacheFingerprint(cwd, paths);
    write(cwd, 'tsconfig.json', '{"compilerOptions":{}}');
    assert.notEqual(cacheFingerprint(cwd, paths), before);
    const after = cacheFingerprint(cwd, paths);
    write(cwd, 'yarn.lock', '# changed dependencies');
    assert.notEqual(cacheFingerprint(cwd, paths), after);
    write(cwd, 'eslint.config.mjs', `export default [{rules:{'no-console':'error'}}];`);
    assert.ok(
      (await lint(cwd, 'cached')).find((r) => r.filePath.endsWith('/example.ts')).messages.length,
    );
    await assert.rejects(prepareEslintPass({ cwd, pass: 'unknown' }), /Unknown ESLint pass/);
    symlinkSync(join(cwd, 'src'), join(cwd, 'linked'), 'dir');
    await assert.rejects(lint(cwd, 'full'), /symbolic link/);
  }));

test('ESLint full pass notices changed types in an unchanged consumer after warming the cache', () =>
  temporary(async (cwd) => {
    symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir');
    write(cwd, 'tsconfig.json', '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
    write(
      cwd,
      'eslint.config.mjs',
      `import parser from ${JSON.stringify(join(root, 'node_modules/@typescript-eslint/parser/dist/index.js'))};
import plugin from ${JSON.stringify(join(root, 'node_modules/@typescript-eslint/eslint-plugin/dist/index.js'))};
export default [{files:['**/*.ts'],languageOptions:{parser,parserOptions:{project:'./tsconfig.json',tsconfigRootDir:import.meta.dirname}},plugins:{'@typescript-eslint':plugin},rules:{'@typescript-eslint/no-unsafe-assignment':'error','@typescript-eslint/no-explicit-any':'error'}}];`,
    );
    write(cwd, 'producer.ts', 'export const value: string = "ok";');
    const consumer = write(
      cwd,
      'consumer.ts',
      'import { value } from "./producer"; const copied: string = value;',
    );
    assert.equal(
      diagnostics([...(await lint(cwd, 'full')), ...(await lint(cwd, 'cached'))]).length,
      0,
    );
    // A fresh CLI process mirrors the real invocation and avoids TypeScript's in-process program cache.
    write(cwd, 'producer.ts', 'export const value: any = "unsafe";');
    const result = spawnSync(process.execPath, [join(root, 'scripts/runEslint.mjs'), 'full'], {
      cwd,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /consumer.ts/);
    assert.match(result.stdout, /no-unsafe-assignment/);
    assert.equal(
      readFileSync(consumer, 'utf8'),
      'import { value } from "./producer"; const copied: string = value;',
    );
  }));

test('ESLint reuses the file-local cache, invalidates settings and always checks cross-file rules', () =>
  temporary(async (cwd) => {
    write(
      cwd,
      'eslint.config.mjs',
      `import {appendFileSync,readFileSync} from 'node:fs';
const local={meta:{docs:{}},create(){appendFileSync(new URL('./calls.log',import.meta.url),'local\\n');return {}}};
const cross={create(context){return {Program(node){if(readFileSync(new URL('./dependency.txt',import.meta.url),'utf8')==='bad')context.report({node,message:'dependency changed'})}}}};
export default [{files:['src/**'],plugins:{'@typescript-eslint':{rules:{local}},external:{rules:{cross}}},rules:{'@typescript-eslint/local':'error','external/cross':'error'}}];`,
    );
    write(cwd, 'src/main.js', 'void 0;');
    write(cwd, 'dependency.txt', 'good');
    await lint(cwd, 'cached');
    const calls = () => readFileSync(join(cwd, 'calls.log'), 'utf8');
    const cold = calls();
    assert.equal(cold, 'local\n');
    await lint(cwd, 'cached');
    assert.equal(calls(), cold);
    write(cwd, 'dependency.txt', 'bad');
    assert.ok(
      (await lint(cwd, 'full')).some((r) =>
        r.messages.some((m) => m.message === 'dependency changed'),
      ),
    );
    await lint(cwd, 'cached');
    assert.equal(calls(), cold);
    write(cwd, '.prettierrc', '{"singleQuote":true}');
    await lint(cwd, 'cached');
    assert.equal(calls(), cold + cold);
  }));
