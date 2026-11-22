import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '..');
process.env.NODE_COMPILE_CACHE ??= resolve(root, 'node_modules/.cache/node-compile-cache');
// Type-aware checks share memory; documentation and formatting have independent inputs.
const staticGroups = [
  ['typecheck:tests', 'build', 'lint:architecture', 'lint'],
  ['format:check'],
  ['lint:adr', 'lint:docs', 'lint:docs:references'],
];
// Coverage owns the machine. The remaining suites run only after the build and coverage pass.
const testGroups = [
  ['test:node', 'test:profiles'],
  [
    'test:pinned-consumers:unit',
    'test:installed-full-consumers:unit',
    'test:task-execution:self',
    'test:task-execution:contract',
    'test:package-closure',
  ],
];
const usage = 'Usage: yarn validate [--serial | --static | --help]';
const args = process.argv.slice(2);

async function runGroup(suites) {
  for (const suite of suites) {
    const started = performance.now();
    console.log(`Запуск: yarn ${suite}`);
    const result = await new Promise((done) => {
      const child = spawn('yarn', [suite], { cwd: root, env: process.env, stdio: 'inherit' });
      child.once('error', (error) => done({ error }));
      child.once('close', (status, signal) => done({ status, signal }));
    });
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    if (result.status !== 0) {
      console.error(
        `Ошибка: yarn ${suite} (${result.error?.message ?? result.signal ?? result.status}; ${seconds} с)`,
      );
      return false;
    }
    console.log(`Готово: yarn ${suite} (${seconds} с)`);
  }
  return true;
}

if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else if (args.length > 1 || (args.length === 1 && !['--serial', '--static'].includes(args[0]))) {
  console.error(usage);
  process.exitCode = 1;
} else {
  const started = performance.now();
  const serial = args[0] === '--serial';
  const runGroups = async (groups) => {
    const results = await Promise.all((serial ? [groups.flat()] : groups).map(runGroup));
    return results.every(Boolean);
  };
  let passed = await runGroups(staticGroups);
  if (passed && args[0] !== '--static') {
    passed = await runGroup(['test:coverage']);
    if (passed) passed = await runGroups(testGroups);
  }
  console.log(
    `Validate: ${passed ? 'успех' : 'ошибка'} (${((performance.now() - started) / 1000).toFixed(2)} с)`,
  );
  process.exitCode = passed ? 0 : 1;
}
