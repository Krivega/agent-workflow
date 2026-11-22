import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    maxWorkers: 2,
    include: ['tests/temporal/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['**/index.ts'],
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
      reporter: ['text-summary', 'json'],
    },
  },
});
