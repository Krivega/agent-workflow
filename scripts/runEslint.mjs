import { performance } from 'node:perf_hooks';

import { prepareEslintPass } from './lib/eslint-passes.mjs';

const usage = 'Usage: node scripts/runEslint.mjs <full|cached|--help>';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else if (args.length !== 1 || !['full', 'cached'].includes(args[0])) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const started = performance.now();
    const { engine, files } = await prepareEslintPass({ cwd: process.cwd(), pass: args[0] });
    const results = files.length ? await engine.lintFiles(files) : [];
    const output = (await engine.loadFormatter('stylish')).format(results);
    if (output) console.log(output);
    const failed = results.some((result) => result.errorCount || result.warningCount);
    console.log(
      `ESLint ${args[0]}: ${files.length} файлов, ${((performance.now() - started) / 1000).toFixed(2)} с`,
    );
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
