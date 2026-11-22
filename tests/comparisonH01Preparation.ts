import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import type {
  H01Budget,
  H01Roots,
  H01Variant,
  H01ExecutionRequest,
  H01Profile,
  NativeComparisonScenario,
} from './comparisonH01Contract.js';
import {
  h01GrantText,
  h01RawFile,
  h01ReadJson,
  h01ReadPin,
  h01RequestHash,
  parseH01DisabledMcpServers,
  parseH01Request,
  comparisonKind,
  comparisonEntrypoint,
} from './comparisonH01Contract.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { discoverChat } from '../adapters/codex/chatDiscovery.js';
import { captureH01RuntimeInventory } from './comparisonH01.js';
import { h01LegacyOverlayPlan } from './comparisonH01Guard.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { parseComparisonMaterials, parseComparisonSuite } from '../core/comparison.js';

export interface H01OperatorSpec {
  kind:
    | 'comparison-h01-operator'
    | 'comparison-h02-operator'
    | 'comparison-h03-operator'
    | 'comparison-h04-operator'
    | 'comparison-h05-operator';
  schemaVersion: 1;
  opId: string;
  variant: H01Variant;
  budget: H01Budget;
  roots: H01Roots;
  evidenceRoot: string;
  node: InputRef;
  entrypoint: InputRef;
  runtimeRoot: string;
  temporal?: {
    binary: InputRef;
    address: string;
    httpAddress: string;
    metricsAddress: string;
    namespace: 'default';
    taskQueue: string;
    workflowsPath: string;
    sqlitePath: string;
  };
}
function fields(value: unknown, names: string[]) {
  const v = object(value);
  requireWorkflow(
    isDeepStrictEqual(Object.keys(v).sort(), [...names].sort()),
    'h01-preparation-fields',
  );
  return v;
}
function absolute(value: unknown): string {
  const path = textField(value);
  requireWorkflow(
    isAbsolute(path) && resolve(path) === path && !/[\r\n]/u.test(path),
    'h01-preparation-path',
  );
  return path;
}
function ref(value: unknown): InputRef {
  const input = fields(value, ['locator', 'hash']);
  requireWorkflow(
    typeof input.hash === 'string' && /^[a-f0-9]{64}$/u.test(input.hash),
    'h01-preparation-hash',
  );
  return { locator: absolute(input.locator), hash: input.hash };
}
function disjoint(paths: string[]) {
  requireWorkflow(
    paths.every((path, i) =>
      paths.every((other, j) => i === j || (path !== other && !path.startsWith(other + sep))),
    ),
    'h01-preparation-roots-overlap',
  );
}
/** Data parser only: no file access, process, grant or default execution budget. */
export function parseH01OperatorSpec(
  value: unknown,
  scenario: NativeComparisonScenario = 'H-01',
): H01OperatorSpec {
  const v = object(value);
  const candidate = v.variant === 'candidate';
  fields(v, [
    'kind',
    'schemaVersion',
    'opId',
    'variant',
    'budget',
    'roots',
    'evidenceRoot',
    'node',
    'entrypoint',
    'runtimeRoot',
    ...(candidate ? ['temporal'] : []),
  ]);
  requireWorkflow(
    v.kind === comparisonKind(scenario, 'operator') &&
      v.schemaVersion === 1 &&
      (v.variant === 'baseline' || candidate),
    'h01-operator-version',
  );
  textField(v.opId);
  ref(v.node);
  ref(v.entrypoint);
  const runtime = absolute(v.runtimeRoot),
    evidence = absolute(v.evidenceRoot);
  const runBase = dirname(evidence);
  const roots = fields(v.roots, [
    'workspaceRoot',
    'stateRoot',
    'evidenceRoot',
    'artifactRoot',
    'hostRoot',
  ]);
  const paths = Object.values(roots).map(absolute);
  disjoint([...paths, evidence, runtime]);
  requireWorkflow(
    paths.every((path) => path.startsWith(runBase + sep)) &&
      dirname(String(roots.workspaceRoot)) !== runBase &&
      [roots.evidenceRoot, roots.artifactRoot, roots.hostRoot].every(
        (path) => !String(path).startsWith(dirname(String(roots.workspaceRoot)) + sep),
      ),
    'h01-operator-run-base',
  );
  const budget = fields(v.budget, [
    'maxManagedStarts',
    'maxElapsedMs',
    'maxInputUncached',
    'maxOutput',
    'reserveMs',
  ]);
  requireWorkflow(
    Object.values(budget).every((n) => Number.isSafeInteger(n) && Number(n) > 0) &&
      Number(budget.reserveMs) < Number(budget.maxElapsedMs),
    'h01-preparation-budget',
  );
  if (candidate) {
    const temporal = fields(v.temporal, [
      'binary',
      'address',
      'httpAddress',
      'metricsAddress',
      'namespace',
      'taskQueue',
      'workflowsPath',
      'sqlitePath',
    ]);
    ref(temporal.binary);
    textField(temporal.taskQueue);
    const addresses = [temporal.address, temporal.httpAddress, temporal.metricsAddress].map(
      (value) => {
        requireWorkflow(
          typeof value === 'string' &&
            /^127\.0\.0\.1:([1-9]\d{0,4})$/u.test(value) &&
            Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535,
          'h01-operator-loopback',
        );
        return value;
      },
    );
    requireWorkflow(
      new Set(addresses).size === 3 && temporal.namespace === 'default',
      'h01-operator-endpoints',
    );
    requireWorkflow(
      absolute(temporal.workflowsPath).startsWith(runtime + sep) &&
        absolute(temporal.sqlitePath).startsWith(evidence + sep),
      'h01-operator-path-scope',
    );
  }
  return v as unknown as H01OperatorSpec;
}

export interface H01PreparationInput {
  kind:
    | 'comparison-h01-preparation'
    | 'comparison-h02-preparation'
    | 'comparison-h03-preparation'
    | 'comparison-h04-preparation'
    | 'comparison-h05-preparation';
  schemaVersion: 1;
  runtimeRoot: string;
  primaryRoot: string;
  outputRoot: string;
  profile: H01Profile;
  node: InputRef;
  identity: H01ExecutionRequest['identity'];
  budget: H01Budget;
  attempts: Record<H01Variant, { opId: string; runBase: string }>;
  temporal: {
    binary: InputRef;
    address: string;
    httpAddress: string;
    metricsAddress: string;
    namespace: 'default';
    taskQueue: string;
    build: InputRef;
  };
}

function roots(runBase: string): H01Roots {
  return {
    workspaceRoot: resolve(runBase, 'writer/workspace'),
    stateRoot: resolve(runBase, 'state'),
    evidenceRoot: resolve(runBase, 'evidence'),
    artifactRoot: resolve(runBase, 'artifacts'),
    hostRoot: resolve(runBase, 'host'),
  };
}

async function draft(value: unknown, scenario: NativeComparisonScenario) {
  const input = fields(value, [
    'kind',
    'schemaVersion',
    'runtimeRoot',
    'primaryRoot',
    'outputRoot',
    'profile',
    'node',
    'identity',
    'budget',
    'attempts',
    'temporal',
  ]) as unknown as H01PreparationInput;
  requireWorkflow(
    input.kind === comparisonKind(scenario, 'preparation') && input.schemaVersion === 1,
    'h01-preparation-version',
  );
  const runtimeRoot = absolute(input.runtimeRoot),
    primaryRoot = absolute(input.primaryRoot),
    outputRoot = absolute(input.outputRoot);
  requireWorkflow(
    runtimeRoot === resolve(import.meta.dirname, '..') &&
      safeDirectory(runtimeRoot) === runtimeRoot &&
      safeDirectory(primaryRoot) === primaryRoot &&
      outputRoot.startsWith(runtimeRoot + sep) &&
      !existsSync(outputRoot) &&
      safeDirectory(dirname(outputRoot)) === dirname(outputRoot),
    'h01-preparation-output',
  );
  const attempts = fields(input.attempts, ['baseline', 'candidate']);
  for (const variant of ['baseline', 'candidate'] as const) {
    const attempt = fields(attempts[variant], ['opId', 'runBase']);
    textField(attempt.opId);
    absolute(attempt.runBase);
  }
  requireWorkflow(
    input.attempts.baseline.opId !== input.attempts.candidate.opId,
    'h01-preparation-op',
  );
  const bases = [input.attempts.baseline.runBase, input.attempts.candidate.runBase];
  disjoint([...bases, runtimeRoot]);
  for (const base of bases)
    requireWorkflow(
      !existsSync(base) &&
        safeDirectory(dirname(base)) === dirname(base) &&
        !(
          base === primaryRoot ||
          base.startsWith(primaryRoot + sep) ||
          primaryRoot.startsWith(base + sep)
        ),
      'h01-preparation-run-base',
    );
  fields(input.profile, [
    'model',
    'effort',
    'clientVersion',
    'binary',
    'rules',
    'executor',
    'reviewer',
    ...(Object.hasOwn(input.profile, 'disabledMcpServers') ? ['disabledMcpServers'] : []),
  ]);
  [input.profile.model, input.profile.effort, input.profile.clientVersion].forEach(textField);
  if (Object.hasOwn(input.profile, 'disabledMcpServers'))
    parseH01DisabledMcpServers(input.profile.disabledMcpServers);
  const staticPins = [
    input.node,
    input.profile.binary,
    input.profile.rules,
    input.profile.executor,
    input.profile.reviewer,
  ];
  staticPins.forEach((pin) => h01ReadPin(ref(pin)));
  requireWorkflow(
    input.node.locator === realpathSync(process.execPath) &&
      (lstatSync(input.node.locator).mode & 0o111) !== 0,
    'h01-preparation-node',
  );
  const temporal = fields(input.temporal, [
    'binary',
    'address',
    'httpAddress',
    'metricsAddress',
    'namespace',
    'taskQueue',
    'build',
  ]);
  h01ReadPin(ref(temporal.binary));
  const buildRef = ref(temporal.build);
  requireWorkflow(buildRef.locator.startsWith(runtimeRoot + sep), 'h01-preparation-build');
  const build = object(h01ReadJson(buildRef));
  requireWorkflow(
    build.kind === 'h01-workflow-build-artifacts' &&
      build.qualification === false &&
      build.canonical === runtimeRoot &&
      Array.isArray(build.actualRuntimeJavaScript) &&
      build.actualRuntimeJavaScript.length > 0,
    'h01-preparation-build',
  );
  const compiled = build.actualRuntimeJavaScript.map((raw) => {
    const row = fields(raw, ['locator', 'hash', 'bytes']);
    const pin = ref({ locator: row.locator, hash: row.hash });
    requireWorkflow(
      pin.locator.endsWith('.js') &&
        Number.isSafeInteger(row.bytes) &&
        Number(row.bytes) > 0 &&
        h01ReadPin(pin).length === row.bytes &&
        pin.locator.startsWith(runtimeRoot + sep),
      'h01-preparation-compiled',
    );
    return pin;
  });
  const workflowsPath = absolute(build.actualWorkflowsPath);
  requireWorkflow(
    compiled.some((pin) => pin.locator === workflowsPath) &&
      workflowsPath.endsWith('/workflows/localTask.js'),
    'h01-preparation-workflows',
  );
  const compiledRoot = dirname(dirname(workflowsPath));
  requireWorkflow(
    new Set(compiled.map((pin) => pin.locator)).size === compiled.length &&
      compiled.every((pin) => pin.locator.startsWith(compiledRoot + sep)),
    'h01-preparation-compiled',
  );
  const observedCompiled = await new FileWorkflowInputs(runtimeRoot).capture(
    { files: [], directories: [relative(runtimeRoot, compiledRoot)] },
    'H01 prepared compiled JavaScript',
  );
  requireWorkflow(
    observedCompiled.complete &&
      observedCompiled.inputs.length === compiled.length &&
      observedCompiled.inputs.every((pin) =>
        compiled.some(
          (expected) =>
            expected.locator === resolve(runtimeRoot, pin.locator) && expected.hash === pin.hash,
        ),
      ),
    'h01-preparation-compiled-incomplete',
  );
  const source = await captureH01RuntimeInventory(runtimeRoot, scenario);
  const sessionsRoot = resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'sessions');
  requireWorkflow(safeDirectory(sessionsRoot) === sessionsRoot, 'h01-preparation-native-home');
  const current = await discoverChat(
    primaryRoot,
    sessionsRoot,
    textField(process.env.CODEX_THREAD_ID),
    undefined,
    true,
  );
  requireWorkflow(
    realpathSync(current.transcript).startsWith(sessionsRoot + sep),
    'h01-preparation-native-home',
  );
  const planned: { ref: InputRef; bytes: Buffer }[] = [];
  const file = (name: string, body: unknown) => {
    const bytes = Buffer.from(canonical(body) + '\n'),
      pin = {
        locator: resolve(outputRoot, name + '.json'),
        hash: digest(bytes),
      };
    planned.push({ ref: pin, bytes });
    return pin;
  };
  const suite = parseComparisonSuite(
    JSON.parse(
      h01RawFile(resolve(runtimeRoot, 'tests/fixtures/qualification/suite.json')).toString('utf8'),
    ),
  );
  const materials = parseComparisonMaterials(
    JSON.parse(
      h01RawFile(resolve(runtimeRoot, 'tests/fixtures/qualification/materials.json')).toString(
        'utf8',
      ),
    ),
    suite,
  );
  const material = file(
      'material',
      materials.find((row) => row.id === scenario),
    ),
    criteria = file(
      'criteria',
      suite.scenarios.find((row) => row.id === scenario),
    );
  const profile = file('profile', input.profile),
    overlay = file('legacy-overlay', h01LegacyOverlayPlan());
  const entrypoint = source.find(
    (pin) => pin.locator === resolve(runtimeRoot, comparisonEntrypoint(scenario)),
  );
  requireWorkflow(entrypoint !== undefined, 'h01-preparation-entrypoint');
  const snapshots = (['baseline', 'candidate'] as const).map((variant) => {
    const attempt = input.attempts[variant],
      ownedRoots = roots(attempt.runBase),
      evidenceRoot = resolve(attempt.runBase, 'operator-evidence');
    const spec = parseH01OperatorSpec(
      {
        kind: comparisonKind(scenario, 'operator'),
        schemaVersion: 1,
        opId: attempt.opId,
        variant,
        budget: input.budget,
        roots: ownedRoots,
        evidenceRoot,
        node: input.node,
        entrypoint,
        runtimeRoot,
        ...(variant === 'candidate'
          ? {
              temporal: {
                binary: input.temporal.binary,
                address: input.temporal.address,
                httpAddress: input.temporal.httpAddress,
                metricsAddress: input.temporal.metricsAddress,
                namespace: input.temporal.namespace,
                taskQueue: input.temporal.taskQueue,
                workflowsPath,
                sqlitePath: resolve(evidenceRoot, 'temporal.sqlite'),
              },
            }
          : {}),
      },
      scenario,
    );
    const operatorSpec = file(variant + '-operator', spec);
    const bootstrap = file(
      variant + '-bootstrap',
      variant === 'baseline'
        ? {
            engine: 'legacy',
            runtimeRoot: resolve(ownedRoots.stateRoot, 'legacy-runtime'),
            modulesRoot: realpathSync(resolve(runtimeRoot, 'node_modules')),
            overlay,
          }
        : {
            engine: 'temporal',
            address: input.temporal.address,
            namespace: input.temporal.namespace,
            taskQueue: input.temporal.taskQueue,
            workflowsPath,
            issuer: {
              sessionsRoot,
              workspaceRoot: current.observed.workspace,
              threadId: current.observed.thread_id,
              owner: input.identity.owner,
            },
          },
    );
    const runtime = file(variant + '-runtime', {
      engine: variant === 'baseline' ? 'legacy' : 'temporal',
      root: runtimeRoot,
      files: [...source, operatorSpec, ...(variant === 'candidate' ? [buildRef, ...compiled] : [])],
    });
    const request = parseH01Request(
      {
        kind: comparisonKind(scenario, 'execution'),
        executionVersion: 2,
        opId: attempt.opId,
        variant,
        material,
        criteria,
        profile,
        runtime,
        bootstrap,
        roots: ownedRoots,
        identity: input.identity,
        budget: input.budget,
        authorization: {
          root: primaryRoot,
          transcript: current.transcript,
          anchor: {
            thread_id: current.observed.thread_id,
            turn_id: '',
            workspace: current.observed.workspace,
            host_id: 'local',
          },
          source: { locator: '', hash: '' },
          requestHash: '',
        },
      },
      'plan',
      scenario,
    );
    return {
      variant,
      request,
      requestFile: file(variant + '-request', request),
      operatorSpec,
      requestHash: h01RequestHash(request),
      expectedGrantText: h01GrantText(request),
    };
  });
  const plan = {
    kind: comparisonKind(scenario, 'preparation-plan'),
    schemaVersion: 1,
    runtimeRoot,
    outputRoot,
    sourceInventory: source,
    compiledInventory: compiled,
    drafts: snapshots,
    files: planned.map(({ ref, bytes }) => ({ ...ref, bytes: bytes.length })),
    mayRun: false,
    qualification: false,
    authorizationIssued: false,
    allowedModelStarts: 0,
    limits: [
      'Draft source/turn/requestHash are intentionally empty; a new exact primary human message is required.',
      'No binary, client, server, worker, model, installation, run roots or operator roots are started/created.',
      'Code and compiled bytes are pinned; this does not qualify their effective runtime or installed supply.',
    ],
  };
  return {
    plan,
    planned,
    staticPins: [...staticPins, input.temporal.binary, buildRef, ...compiled],
    source,
  };
}

export async function planH01Preparation(
  value: unknown,
  scenario: NativeComparisonScenario = 'H-01',
) {
  return (await draft(value, scenario)).plan;
}
/** Writes only new draft JSON under outputRoot; never writes an authorization/grant or execution root. */
export async function prepareH01Drafts(
  value: unknown,
  scenario: NativeComparisonScenario = 'H-01',
) {
  const prepared = await draft(value, scenario);
  mkdirSync(prepared.plan.outputRoot, { mode: 0o700 });
  for (const file of prepared.planned)
    writeFileSync(file.ref.locator, file.bytes, { flag: 'wx', mode: 0o600 });
  prepared.staticPins.forEach(h01ReadPin);
  requireWorkflow(
    isDeepStrictEqual(
      await captureH01RuntimeInventory(prepared.plan.runtimeRoot, scenario),
      prepared.source,
    ),
    'h01-preparation-source-changed',
  );
  for (const file of prepared.planned) h01ReadPin(file.ref);
  return prepared.plan;
}
export async function h01PreparationMain(args: string[]) {
  requireWorkflow(
    args.length === 2 && ['--plan', '--prepare'].includes(args[0]!),
    'h01-preparation-usage',
  );
  const input: unknown = JSON.parse(h01RawFile(resolve(args[1]!)).toString('utf8'));
  process.stdout.write(
    canonical(
      args[0] === '--plan' ? await planH01Preparation(input) : await prepareH01Drafts(input),
    ) + '\n',
  );
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h01PreparationMain(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  });
