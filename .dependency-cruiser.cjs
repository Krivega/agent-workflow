const npmDependencyTypes = [
  'npm',
  'npm-dev',
  'npm-optional',
  'npm-peer',
  'npm-bundled',
  'npm-no-pkg',
  'npm-unknown',
];

module.exports = {
  forbidden: [
    {
      name: 'temporal-contracts-and-policy-stay-pure',
      severity: 'error',
      from: { path: '^src/(contracts|policy)/' },
      to: { path: '^(?!src/(contracts|policy)/)' },
    },
    {
      name: 'temporal-workflows-use-only-deterministic-boundaries',
      severity: 'error',
      from: { path: '^src/workflows/' },
      to: {
        path: '^(?!src/(contracts|policy|workflows)/|node_modules/@temporalio/(workflow|common)/)',
      },
    },
    {
      name: 'temporal-does-not-wrap-legacy-runtime',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^(core|ports|application|adapters|cli)/' },
    },
    {
      name: 'product-does-not-import-agent-workflow',
      severity: 'error',
      from: { path: '^(apps|games|packages)/' },
      to: { path: '^(core|ports|application|adapters|cli|src)/' },
    },
    {
      name: 'agent-workflow-does-not-import-product',
      severity: 'error',
      from: { path: '^(core|ports|application|adapters|cli|src)/' },
      to: { path: '^(apps|games|packages)/' },
    },
    {
      name: 'production-stays-inside-agent-workflow',
      severity: 'error',
      from: { path: '^(core|ports|application|adapters|cli|comparison|src)/' },
      to: { path: '^(?:\\.\\./|/)' },
    },
    {
      name: 'agent-workflow-core-is-pure',
      severity: 'error',
      from: { path: '^core/' },
      to: {
        path: '^(?!core/|src/policy/(readFragments|localPlanning)\\.ts$|src/contracts/localValues\\.ts$|node_modules/xstate/)',
      },
    },
    {
      name: 'agent-workflow-ports-depend-only-on-core-and-ports',
      severity: 'error',
      from: { path: '^ports/' },
      to: {
        path: '^(?!(core|ports)/|src/contracts/writerProcesses\\.ts$)',
      },
    },
    {
      name: 'agent-workflow-application-depends-only-on-core-and-ports',
      severity: 'error',
      from: { path: '^application/' },
      to: { path: '^(?!(core|application|ports)/)' },
    },
    {
      name: 'agent-workflow-adapters-do-not-import-application-or-cli',
      severity: 'error',
      from: { path: '^adapters/' },
      to: { path: '^(application|cli|tests)/' },
    },
    {
      name: 'agent-workflow-production-does-not-import-tests',
      severity: 'error',
      from: {
        path: '^(core|ports|application|adapters|cli|src)/',
        pathNot: '((^|/)tests/|\\.test\\.tsx?$)',
      },
      to: { path: '((^|/)tests/|\\.test\\.tsx?$)' },
    },
  ],
  options: {
    baseDir: __dirname,
    combinedDependencies: true,
    doNotFollow: {
      path: 'node_modules|^tmp(?:/|$)',
      dependencyTypes: npmDependencyTypes,
    },
    enhancedResolveOptions: {
      conditionNames: ['types', 'import', 'require', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.cjs', '.json'],
      exportsFields: ['exports'],
      mainFields: ['types', 'module', 'main'],
    },
    exclude: {
      path: '(^|/)(node_modules|coverage|dist|\\.expo|\\.features-gen)/',
    },
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    tsPreCompilationDeps: true,
  },
};
