import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import temporal from './vitest.temporal.config.mjs';
import registry from './check-areas.profiles.json' with { type: 'json' };

export default defineConfig({
  ...temporal,
  root: import.meta.dirname,
  test: {
    ...temporal.test,
    include: [],
    reporters: ['default', 'junit'],
    outputFile: { junit: resolve(import.meta.dirname, 'tmp/check-areas/temporal/junit.xml') },
    coverage: {
      ...temporal.test.coverage,
      reportsDirectory: resolve(import.meta.dirname, 'tmp/check-areas/temporal/coverage'),
    },
    projects: registry.temporal.groups.map((group) => ({
      extends: true,
      test: { name: `temporal-${group.id}`, include: group.files },
    })),
  },
});
