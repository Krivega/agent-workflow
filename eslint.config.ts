import js from '@eslint/js';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import type { ESLint } from 'eslint';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

const typeScriptPlugin = typescriptEslint as unknown as ESLint.Plugin;

export default defineConfig([
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'tmp/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  {
    rules: {
      'no-extra-boolean-cast': 'off',
      'no-useless-catch': 'off',
      'no-useless-escape': 'off',
      'no-empty-static-block': 'off',
      'no-regex-spaces': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': typeScriptPlugin,
    },
    rules: {
      // TypeScript reports these errors; JavaScript keeps the recommended checks.
      'constructor-super': 'off',
      'getter-return': 'off',
      'no-class-assign': 'off',
      'no-const-assign': 'off',
      'no-dupe-args': 'off',
      'no-dupe-class-members': 'off',
      'no-dupe-keys': 'off',
      'no-func-assign': 'off',
      'no-import-assign': 'off',
      'no-new-native-nonconstructor': 'off',
      'no-obj-calls': 'off',
      'no-setter-return': 'off',
      'no-this-before-super': 'off',
      'no-undef': 'off',
      'no-unsafe-negation': 'off',
      'no-with': 'off',
      'no-fallthrough': 'off',
      'no-delete-var': 'off',
      'no-nonoctal-decimal-escape': 'off',
      'no-octal': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-redeclare': ['error', { ignoreDeclarationMerge: false }],
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
    },
  },
  {
    files: ['{core,application,ports}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        'Date',
        'process',
        'globalThis',
        'global',
        'fetch',
        'performance',
        'crypto',
        'setTimeout',
        'setInterval',
        'setImmediate',
        'queueMicrotask',
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Передайте источник случайности через порт.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: globals.node },
  },
]);
