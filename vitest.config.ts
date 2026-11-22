import { enableCompileCache } from 'node:module';
import { availableParallelism, totalmem } from 'node:os';
import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';
import ToolTestSequencer from './scripts/vitestTestSequencer.mjs';
import toolAwarePool from './scripts/vitestToolAwarePool.mjs';

process.env.NODE_COMPILE_CACHE ??= resolve(
  import.meta.dirname,
  'node_modules/.cache/node-compile-cache',
);
enableCompileCache(process.env.NODE_COMPILE_CACHE);

export default defineConfig({
  plugins: [
    swc.vite({
      include: /\.m?[jt]sx?(?:\?.*)?$/,
      tsconfigFile: false,
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    sequence: { hooks: 'list', sequencer: ToolTestSequencer },
    pool: toolAwarePool,
    vmMemoryLimit: '1GB',
    testTimeout: 5_000,
    hookTimeout: 5_000,
    maxWorkers: Math.max(
      1,
      Math.min(5, availableParallelism() - 1, Math.floor(totalmem() / (2 * 1024 ** 3))),
    ),
    reporters: ['default', 'junit'],
    outputFile: { junit: 'junit.xml' },
    coverage: {
      provider: 'istanbul',
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      reporter: ['text', 'text-summary', 'lcov', 'cobertura'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
      include: [
        '{core,ports,application,adapters,cli,comparison,src,tests}/**/*.{ts,tsx}',
        'tests/comparisonH04NativeWait.mjs',
        'scripts/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.stories.ts',
        '**/.storybook/**',
        '**/e2e/**',
        '**/index.ts',
        '**/generated.ts',
        '**/*.d.ts',
        'tmp/**',
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          globalSetup: ['./scripts/vitestScratch.mjs'],
          include: [
            '{core,ports,application,adapters,cli,comparison,src,tests,scripts}/**/*.test.{ts,tsx}',
          ],
          exclude: [...configDefaults.exclude, '**/*.integration.test.{ts,tsx}', 'tmp/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['**/*.integration.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'tmp/**'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
