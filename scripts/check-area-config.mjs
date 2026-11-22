import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import rootConfig from '../vitest.config.ts';

const root = resolve(import.meta.dirname, '..');
const requireVitest = createRequire(import.meta.resolve('vitest/package.json'));
const picomatch = requireVitest('picomatch');
const { globSync } = requireVitest('tinyglobby');

export function defineCheckAreaConfig({
  id,
  include,
  coverageInclude = rootConfig.test.coverage.include,
}) {
  assert.match(id, /^[a-z][a-z0-9.-]*$/, 'Expected a check area identifier');
  assert.ok(
    Array.isArray(include) && include.length > 0,
    'A check area needs explicit test inputs',
  );
  assert.ok(
    Array.isArray(coverageInclude) && coverageInclude.length > 0,
    'A check area needs a source coverage scope',
  );
  const files = [
    ...globSync(include, {
      cwd: root,
      dot: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    }),
  ]
    .map((path) => path.replaceAll('\\', '/'))
    .sort();
  return {
    ...rootConfig,
    root,
    test: {
      ...rootConfig.test,
      outputFile: { junit: `tmp/check-areas/${id}/junit.xml` },
      coverage: {
        ...rootConfig.test.coverage,
        include: coverageInclude,
        reportsDirectory: `tmp/check-areas/${id}/coverage`,
      },
      projects: rootConfig.test.projects.map((project) => {
        const matches = picomatch(project.test.include, { dot: true });
        return {
          ...project,
          test: {
            ...project.test,
            include: files.filter((path) => matches(path)),
          },
        };
      }),
    },
  };
}
