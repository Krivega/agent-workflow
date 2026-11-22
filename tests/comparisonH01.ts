import { execFile, spawn } from 'node:child_process';
import {
  mkdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  lstatSync,
} from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, isDeepStrictEqual } from 'node:util';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import suiteSource from '../comparison/suite.json' with { type: 'json' };
import materialsSource from '../comparison/materials.json' with { type: 'json' };
import {
  comparisonDuration,
  parseComparisonMaterials,
  parseComparisonSuite,
  type ComparisonInstant,
} from '../core/comparison.js';
import { object, requireWorkflow, parseConnection } from '../core/connection.js';
import { readCardMarkdown } from '../adapters/project/cardMarkdown.js';
import { FileProjectCards } from '../adapters/project/fileProjectCards.js';
import type { CardProjection, CardCompletion } from '../core/card.js';
import type { Execution } from '../core/execution.js';
import { parseLocalTask, localTaskKey } from '../src/policy/localTask.js';
import { localPlanningRisks } from '../src/policy/localPlanning.js';
import { councilRoles, councilProfileLocators } from '../core/council.js';
import type { InputRef } from '../core/localRun.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { verifyComparisonMaterial } from '../adapters/project/comparisonInputs.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { ownProcess } from '../examples/temporal-consumers/full/safety.mjs';
import {
  h01GrantText,
  h01RawFile,
  h01ReadJson,
  h01ReadPin,
  h01Record,
  h01RequestHash,
  h01TaskPaths,
  comparisonKind,
  comparisonLabel,
  comparisonEntrypoint,
  requestScenario,
  parseH01Bootstrap,
  parseH01GuardDescriptor,
  parseH01Profile,
  parseH01Request,
  parseH01Runtime,
  verifyH01Authorization,
  verifyH01GuardAuthorization,
  type H01AttemptContext,
  type H01ExecutionReport,
  type H01ExecutionRequest,
  type H01GuardDescriptor,
  type H01NativeAccounting,
  type H01BackendAdapter,
  type NativeComparisonScenario,
} from './comparisonH01Contract.js';
import {
  createH01NativeGuard,
  h01LegacyOverlayPlan,
  prepareH01LegacyOverlay,
  verifyH01LegacyOverlay,
} from './comparisonH01Guard.js';
import { createH01LegacyAdapter, runH01NativeSession } from './comparisonH01Legacy.js';
import { createH01TemporalAdapter } from './comparisonH01Temporal.js';
import { runH01OwnedChild } from './comparisonH01Keeper.js';

const exec = promisify(execFile);
const entrypoint = fileURLToPath(import.meta.url);
const repository = resolve(import.meta.dirname, '..');
const suite = parseComparisonSuite(suiteSource);
const material = parseComparisonMaterials(materialsSource, suite)[0]!;
const criteria = { ...suite.scenarios[0]!, id: 'H-01' as const };
const unproven = [
  'One H01 variant/attempt; no comparative series qualification.',
  'Prestarted Temporal server, approval and source preparation precede attempt timing.',
  'Repository source assembly; no installed-package or global provider quota proof.',
  'Token caps are observed primary usage cutoffs, not provider-hard limits; inflight excess is retained. Managed starts alone have a hard reservation ledger.',
  'Legacy task-chat project/connection bootstrap is caller/native-agent driven and unqualified until actual execution.',
  'The final clock receipt itself is emitted after measuredEnd; its own I/O and CLI/operator delivery are outside this interval. This is not full operator/series elapsed time.',
];
const instant = (): ComparisonInstant => ({
  wall_ms: Date.now(),
  monotonic_ms: Number(process.hrtime.bigint()) / 1e6,
  clock_id: 'h01-local-host-hrtime',
});
const fileRef = (locator: string): InputRef => ({
  locator,
  hash: digest(h01RawFile(locator)),
});
const unknownAccounting = (): H01NativeAccounting => ({
  participants: [],
  receipts: [],
  reservedManagedStarts: null,
  observedResponses: null,
  inputUncached: null,
  inputCached: null,
  output: null,
  unknown: true,
  evidence: [],
});

/** Read-only review: creates no grant, attempt, subprocess, connection or permission. */
export function planH01(value: unknown, scenario: NativeComparisonScenario = 'H-01') {
  const request = parseH01Request(value, 'plan', scenario);
  const selectedMaterial = parseComparisonMaterials(materialsSource, suite).find(
    (row) => row.id === scenario,
  )!;
  const selectedCriteria = suite.scenarios.find((row) => row.id === scenario)!;
  const profile = parseH01Profile(request.profile);
  const runtime = parseH01Runtime(request.runtime, request.variant);
  const bootstrap = parseH01Bootstrap(request.bootstrap, request.variant);
  requireWorkflow(
    isDeepStrictEqual(h01ReadJson(request.material), selectedMaterial),
    'h01-material',
  );
  requireWorkflow(
    isDeepStrictEqual(h01ReadJson(request.criteria), selectedCriteria),
    'h01-criteria',
  );
  return {
    kind: comparisonKind(scenario, 'plan'),
    executionVersion: 2,
    opId: request.opId,
    variant: request.variant,
    engine: runtime.engine,
    requestHash: h01RequestHash(request),
    expectedGrantText: h01GrantText(request),
    roots: request.roots,
    identity: request.identity,
    task: {
      id: selectedMaterial.id,
      mutable: selectedMaterial.mutable,
      checks: selectedCriteria.checks,
    },
    budget: request.budget,
    profile,
    bootstrap,
    pins: [
      request.material,
      request.criteria,
      request.profile,
      request.runtime,
      request.bootstrap,
      ...runtime.files,
    ],
    scope:
      scenario === 'H-01'
        ? 'one H01 attempt; common checker and independent native acceptance'
        : `one ${scenario} scoped native attempt; no series qualification`,
    mayRun: false,
    qualification: false,
    partialScope: true,
    unproven,
  };
}

export async function captureH01RuntimeInventory(
  root: string,
  scenario: NativeComparisonScenario = 'H-01',
): Promise<InputRef[]> {
  requireWorkflow(safeDirectory(root) === root, 'h01-actual-code-root');
  // Capture existing host source namespaces rather than inventing a second import parser.
  const names = [
    'adapters',
    'application',
    'core',
    'cli',
    'ports',
    'src',
    'procedures',
    'roles',
    'comparison',
    'harness2',
    'project',
  ];
  const files = [
    'AGENTS.md',
    'package.json',
    'yarn.lock',
    'README.md',
    'MIGRATION.md',
    ...readdirSync(resolve(root, 'tests'))
      .filter(
        (name) =>
          /^comparisonH01.*\.(?:ts|mts)$/u.test(name) ||
          (scenario !== 'H-01' && /^comparisonH02.*\.(?:ts|mts)$/u.test(name)) ||
          (scenario === 'H-03' && /^comparisonH03.*\.(?:ts|mts)$/u.test(name)) ||
          (scenario === 'H-04' && /^comparisonH04.*\.(?:ts|mts|mjs)$/u.test(name)) ||
          (scenario === 'H-05' && /^comparisonH05.*\.(?:ts|mts|mjs)$/u.test(name)),
      )
      .map((name) => 'tests/' + name),
    'examples/temporal-consumers/full/safety.mjs',
    'examples/temporal-consumers/full/spec.mjs',
  ];
  const manifest = await new FileWorkflowInputs(root).capture(
    {
      files,
      directories: [...names.map((name) => '' + name), '.agents', 'docs'],
    },
    'H01 actual repository host code inventory',
  );
  requireWorkflow(manifest.complete, 'h01-host-inventory');
  const refs = manifest.inputs
    .filter((ref) => basename(ref.locator) !== '.DS_Store')
    .map((ref) => ({
      locator: resolve(root, ref.locator),
      hash: ref.hash,
    }));
  refs.forEach(h01ReadPin);
  return refs;
}
export async function verifyH01Runtime(request: H01ExecutionRequest) {
  const runtime = parseH01Runtime(request.runtime, request.variant);
  requireWorkflow(runtime.root === repository, 'h01-actual-code-root');
  const manifest = await captureH01RuntimeInventory(runtime.root, requestScenario(request));
  const expected = new Map(runtime.files.map((ref) => [ref.locator, ref.hash]));
  requireWorkflow(
    manifest.every((ref) => expected.get(ref.locator) === ref.hash),
    'h01-host-inventory',
  );
  runtime.files.forEach(h01ReadPin);
  return runtime;
}

function freshRoots(request: H01ExecutionRequest) {
  const names = ['workspaceRoot', 'stateRoot', 'evidenceRoot', 'artifactRoot', 'hostRoot'] as const;
  const tree = dirname(request.roots.workspaceRoot);
  requireWorkflow(
    names.every(
      (name) =>
        name === 'workspaceRoot' ||
        name === 'stateRoot' ||
        !request.roots[name].startsWith(tree + sep),
    ),
    'h01-writer-tree-overlap',
  );
  for (const name of names) {
    const root = request.roots[name];
    requireWorkflow(!existsSync(root), 'h01-root-not-fresh');
    requireWorkflow(safeDirectory(dirname(root)) === dirname(root), 'h01-root-alias');
  }
  for (const name of names) mkdirSync(request.roots[name], { mode: 0o700 });
}

function verifyStop(ref: InputRef, opId: string, scenario: NativeComparisonScenario = 'H-01') {
  const proof = object(h01ReadJson(ref));
  requireWorkflow(
    proof.kind === comparisonKind(scenario, 'stop') &&
      proof.executionVersion === 2 &&
      proof.opId === opId &&
      proof.confirmed === true &&
      Array.isArray(proof.remainingProcesses) &&
      proof.remainingProcesses.length === 0 &&
      Array.isArray(proof.evidence) &&
      proof.evidence.length > 0,
    'h01-stop-unknown',
  );
}

async function prepareCase(context: H01AttemptContext) {
  const root = context.roots.workspaceRoot;
  const stockPath = resolve(context.runtime.root, 'project/workflow.json');
  const stockRef = context.runtime.files.find((ref) => ref.locator === stockPath);
  requireWorkflow(stockRef !== undefined, 'h01-legacy-project-unpinned');
  const stock = parseConnection(h01ReadJson(stockRef));
  const connection = {
    ...stock,
    project_id: 'h01-' + digest(context.opId).slice(0, 16),
    rules: [h01TaskPaths.rules, h01TaskPaths.executor, h01TaskPaths.reviewer],
    mutable_links: [h01TaskPaths.basis],
    plans: {
      active: '.comparison',
      verifying: '.comparison/verifying',
      completed: '.comparison/completed',
      cancelled: '.comparison/cancelled',
    },
  };
  const immutable: Record<string, string> = {
    ...material.files,
    [h01TaskPaths.card]:
      `# Задача: H-01\n\n- **Статус:** \`active\`\n\n` +
      `## Цель\n\n${criteria.task}\n\n${material.instructions}\n\n` +
      `## Границы\n\n- range.mjs\n\n## Критерии приёмки\n\n` +
      criteria.checks.map((check) => `- [ ] ${check}: ${check}`).join('\n') +
      `\n\n<!-- agent-workflow:task-notes -->\n\`\`\`yaml\nschema_version: 2\nproject_id: ${JSON.stringify(connection.project_id)}\ntask_id: ${JSON.stringify(context.identity.taskId)}\n\`\`\`\n`,
    [h01TaskPaths.basis]:
      canonical({
        criteria,
        instructions: material.instructions,
        mutable: material.mutable,
        authority: 'only range.mjs; no publication, new services or grants',
      }) + '\n',
    [h01TaskPaths.rules]: h01ReadPin(context.rules).toString('utf8'),
    [h01TaskPaths.executor]: h01ReadPin(context.executor).toString('utf8'),
    [h01TaskPaths.reviewer]: h01ReadPin(context.reviewer).toString('utf8'),
    'project/workflow.json': canonical(connection) + '\n',
    '.comparison/README.md': `# H01\n\n- [${context.identity.taskId}](task.md)\n`,
    '.comparison/verifying/README.md': '# H01 verifying\n',
    '.comparison/completed/README.md': '# H01 completed\n',
    '.comparison/cancelled/README.md': '# H01 cancelled\n',
  };
  for (const procedure of stock.procedures) {
    const source = context.runtime.files.find(
      (ref) => ref.locator === resolve(context.runtime.root, procedure.locator),
    );
    requireWorkflow(
      source !== undefined && source.hash === procedure.hash,
      'h01-procedure-unpinned',
    );
    immutable[procedure.locator] = h01ReadPin(source).toString('utf8');
  }
  for (const path of councilProfileLocators('system-analyst')) {
    const source = context.runtime.files.find(
      (ref) =>
        ref.locator ===
        resolve(context.runtime.root, path.replace(/^tools\/agent-workflow\//u, '')),
    );
    requireWorkflow(source !== undefined, 'h01-role-unpinned');
    immutable[path] = h01ReadPin(source).toString('utf8');
  }
  const source = (locator: string) => ({
    locator,
    hash: digest(immutable[locator]!),
  });
  immutable['.comparison/legacy-plan.json'] =
    canonical({
      schema_version: 1,
      requirement: source(h01TaskPaths.card),
      basis: [source(h01TaskPaths.basis)],
      owner: source('range.mjs'),
      paths: ['range.mjs'],
      consumers: ['consumer-a.mjs', 'consumer-b.mjs', 'checks.mjs'].map(source),
      consumers_complete: true,
      risks: Object.fromEntries(localPlanningRisks.map((risk) => [risk, false])),
      reason: material.instructions,
      checks: ['validate'],
      criterion: criteria.task,
    }) + '\n';
  immutable['.comparison/legacy-selection.json'] =
    canonical({
      schema_version: 1,
      roles: Object.fromEntries(
        councilRoles.map((role) => [
          role,
          role === 'system-analyst'
            ? {
                trigger: true,
                reason:
                  'H01 shared range boundary and both consumers require independent contract verification',
                requirements: [h01TaskPaths.card, h01TaskPaths.basis, h01TaskPaths.reviewer],
                inputs: { files: Object.keys(material.files), directories: [] },
              }
            : {
                trigger: false,
                reason: 'H01 changes only the existing range boundary; no ' + role + ' scope',
              },
        ]),
      ),
    }) + '\n';
  for (const [name, bytes] of Object.entries(immutable)) {
    mkdirSync(dirname(resolve(root, name)), { recursive: true, mode: 0o700 });
    writeFileSync(resolve(root, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  const timeout = Math.floor(
    Number(BigInt(context.workDeadlineNs) - process.hrtime.bigint()) / 1e6,
  );
  requireWorkflow(timeout > 0, 'h01-deadline');
  await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'init', '--quiet', root], {
    timeout,
    signal: context.signal,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      NODE_ENV: process.env.NODE_ENV,
    },
  });
  return immutable;
}

/** Identical native scenario inputs for both engines; model ports remain read-only. */
async function prepareScenarioCase(context: H01AttemptContext) {
  const root = context.roots.workspaceRoot;
  const material = context.material.value;
  const metadata =
    context.criteria.value.id === 'H-02'
      ? (await import('./comparisonH02Contract.js')).h02PreparedMetadata(
          h01ReadPin(context.rules).toString('utf8'),
          h01ReadPin(context.reviewer).toString('utf8'),
        )
      : context.criteria.value.id === 'H-03'
        ? (await import('./comparisonH03Contract.js')).h03PreparedMetadata(
            h01ReadPin(context.rules).toString('utf8'),
            h01ReadPin(context.executor).toString('utf8'),
          )
        : context.criteria.value.id === 'H-04'
          ? (await import('./comparisonH04NativeContract.js')).h04PreparedMetadata(
              h01ReadPin(context.rules).toString('utf8'),
              h01ReadPin(context.executor).toString('utf8'),
            )
          : (await import('./comparisonH05Contract.js')).h05PreparedMetadata(
              h01ReadPin(context.rules).toString('utf8'),
              h01ReadPin(context.executor).toString('utf8'),
            );
  const immutable: Record<string, string> = { ...material.files, ...metadata };
  const project = parseConnection(
    h01ReadJson(
      context.runtime.files.find(
        (ref) => ref.locator === resolve(context.runtime.root, 'project/workflow.json'),
      )!,
    ),
  );
  const procedures =
    context.criteria.value.id === 'H-02'
      ? ['bootstrap', 'data-roles', 'evidence', 'boundary-review', 'council']
      : context.criteria.value.id === 'H-03'
        ? (await import('./comparisonH03Contract.js')).h03Procedures
        : context.criteria.value.id === 'H-04'
          ? (await import('./comparisonH04NativeContract.js')).h04Procedures
          : (await import('./comparisonH05Contract.js')).h05Procedures;
  for (const id of procedures) {
    const procedure = project.procedures.find((row) => row.id === id)!;
    const ref = context.runtime.files.find(
      (ref) => ref.locator === resolve(context.runtime.root, procedure.locator),
    );
    requireWorkflow(
      ref !== undefined && ref.hash === procedure.hash,
      comparisonLabel(context.criteria.value.id) + '-procedure-unpinned',
    );
    immutable[procedure.locator] = h01ReadPin(ref).toString('utf8');
  }
  for (const [path, bytes] of Object.entries(immutable)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true, mode: 0o700 });
    writeFileSync(resolve(root, path), bytes, { flag: 'wx', mode: 0o600 });
  }
  await verifyComparisonMaterial(root, immutable, material.mutable);
  return immutable;
}

export async function verifyH01Projection(
  context: H01AttemptContext,
  ref: InputRef,
  before: Record<string, string>,
) {
  const proof = object(h01ReadJson(ref));
  const expected = { ...before };
  if (context.variant === 'candidate') {
    requireWorkflow(proof.kind === 'task-card-projection', 'h01-projection-missing');
    const input = parseLocalTask(proof.input),
      preparation = input.admission.preparation;
    requireWorkflow(
      preparation.taskId === context.identity.taskId &&
        preparation.owner === context.identity.owner &&
        preparation.generation === context.identity.generation &&
        preparation.card === h01TaskPaths.card &&
        preparation.project.projectId === 'h01-' + digest(context.opId).slice(0, 16),
      'h01-projection-input',
    );
    const artifact = (value: unknown) => {
      const artifact = object(value);
      requireWorkflow(
        typeof artifact.sha256 === 'string' &&
          /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
          Number.isSafeInteger(artifact.bytes),
        'h01-projection-artifact',
      );
      const bytes = h01ReadPin({
        locator: resolve(context.roots.artifactRoot, artifact.sha256),
        hash: artifact.sha256,
      });
      requireWorkflow(bytes.length === artifact.bytes, 'h01-projection-artifact');
      return bytes;
    };
    const result = object(JSON.parse(artifact(proof.result).toString('utf8')));
    const snapshot = object(JSON.parse(artifact(result.snapshot).toString('utf8')));
    const original = object(proof.before),
      after = object(proof.after);
    const tree = object(snapshot.tree);
    requireWorkflow(
      Array.isArray(tree.files) &&
        tree.files.some(
          (value) =>
            object(value).path === h01TaskPaths.card &&
            isDeepStrictEqual(object(value).version, original),
        ),
      'h01-projection-before',
    );
    requireWorkflow(
      result.kind === 'local-task-result' &&
        result.complete === true &&
        isDeepStrictEqual(result.input, input) &&
        isDeepStrictEqual(snapshot.input, input) &&
        object(snapshot.source).root === context.roots.workspaceRoot &&
        object(snapshot.plan).criterion === criteria.task &&
        artifact(original.content).toString('utf8') === before[h01TaskPaths.card] &&
        original.mode === after.mode,
      'h01-projection-binding',
    );
    const text =
      before[h01TaskPaths.card]! +
      `\n<!-- agent-workflow:${localTaskKey(input)} -->\nРезультат: DONE\nКритерий: ${criteria.task}\nДоказательство: ${String(object(proof.result).sha256)}\n<!-- /agent-workflow -->\n`;
    requireWorkflow(
      artifact(after.content).toString('utf8') === text &&
        (lstatSync(resolve(context.roots.workspaceRoot, h01TaskPaths.card)).mode & 0o777) ===
          after.mode,
      'h01-projection-after',
    );
    expected[h01TaskPaths.card] = text;
  } else {
    requireWorkflow(
      proof.kind === 'h01-legacy-engine-result' &&
        proof.opId === context.opId &&
        proof.requestHash === context.requestHash,
      'h01-projection-binding',
    );
    h01ReadPin(proof.database as InputRef);
    const captured = object(h01ReadJson(proof.snapshot as InputRef));
    const checkpoint = object(object(captured.state).checkpoint);
    const run = object(checkpoint.local_run),
      projected = object(proof.projection);
    requireWorkflow(
      isDeepStrictEqual(run.projection, projected) &&
        object(projected.result).status === 'confirmed',
      'h01-projection-binding',
    );
    const execution = object(checkpoint.workflow).execution as Execution;
    const completion: CardCompletion = {
      criteria: execution.gates
        .filter((gate) => gate.applicable)
        .flatMap((gate) => [gate.id, gate.reason]),
      summary: execution.result!.summary,
      limitations: execution.result!.limitations,
      evidence: execution.result!.evidence,
    };
    const connection = parseConnection(JSON.parse(before['project/workflow.json']!));
    const directory = resolve(context.roots.evidenceRoot, 'card-before');
    mkdirSync(directory, { mode: 0o700 });
    for (const name of [
      h01TaskPaths.card,
      '.comparison/README.md',
      '.comparison/completed/README.md',
      ...connection.mutable_links,
    ]) {
      mkdirSync(dirname(resolve(directory, name)), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(resolve(directory, name), before[name]!, {
        flag: 'wx',
        mode: 0o600,
      });
    }
    const plan = object(projected.plan) as unknown as CardProjection;
    const rendered = await new FileProjectCards(directory, connection, directory).prepare(
      readCardMarkdown(h01TaskPaths.card, before[h01TaskPaths.card]!),
      'completed',
      plan.operation_id,
      completion,
    );
    requireWorkflow(
      isDeepStrictEqual(plan, rendered) &&
        object(projected.result).locator === plan.to &&
        object(projected.result).revision ===
          digest(plan.changes.find((change) => change.locator === plan.to)!.after!),
      'h01-projection-after',
    );
    for (const change of plan.changes) {
      requireWorkflow(change.before === (before[change.locator] ?? null), 'h01-projection-before');
      if (change.after === null) {
        requireWorkflow(
          lstatSync(resolve(context.roots.workspaceRoot, change.locator), {
            throwIfNoEntry: false,
          }) === undefined,
          'h01-projection-after',
        );
        delete expected[change.locator];
      } else expected[change.locator] = change.after;
    }
  }
  await verifyComparisonMaterial(context.roots.workspaceRoot, expected, material.mutable);
  return expected;
}

function prepareLegacy(context: H01AttemptContext) {
  requireWorkflow(context.bootstrap.engine === 'legacy', 'h01-engine');
  const bootstrap = context.bootstrap,
    root = bootstrap.runtimeRoot;
  requireWorkflow(
    root === resolve(context.roots.stateRoot, 'legacy-runtime') &&
      !existsSync(root) &&
      isDeepStrictEqual(h01ReadJson(bootstrap.overlay), h01LegacyOverlayPlan()),
    'h01-overlay-plan',
  );
  mkdirSync(root, { mode: 0o700 });
  for (const ref of context.runtime.files) {
    const name = relative(context.runtime.root, ref.locator);
    requireWorkflow(name !== '' && !name.startsWith('..' + sep), 'h01-runtime-path');
    const target = resolve(root, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, h01ReadPin(ref), { flag: 'wx', mode: 0o600 });
  }
  requireWorkflow(
    safeDirectory(bootstrap.modulesRoot) === bootstrap.modulesRoot,
    'h01-modules-alias',
  );
  symlinkSync(bootstrap.modulesRoot, resolve(root, 'node_modules'), 'dir');
  writeFileSync(
    resolve(root, '.comparison-h01-owner.json'),
    canonical({
      kind: 'comparison-h01-runtime-owner',
      opId: context.opId,
      requestHash: context.requestHash,
      controlRef: context.nativeObserver.controlRef,
    }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  const prepared = prepareH01LegacyOverlay(root, context.nativeObserver.controlRef);
  verifyH01LegacyOverlay(root, context.nativeObserver.controlRef, prepared.overlay);
  return prepared.files.concat(prepared.overlay);
}

export async function checkNativeCase(context: H01AttemptContext, label = 'checker') {
  requireWorkflow(/^[a-z0-9-]+$/u.test(label), 'comparison-check-label');
  context.signal.throwIfAborted();
  const remaining = Number(BigInt(context.workDeadlineNs) - process.hrtime.bigint()) / 1e6;
  requireWorkflow(remaining >= 1, 'h01-deadline');
  const command = [process.execPath, 'checks.mjs'];
  const paths = [label + '.stdout', label + '.stderr'].map((name) =>
    resolve(context.roots.evidenceRoot, name),
  );
  const fds: number[] = [];
  try {
    for (const path of paths) fds.push(openSync(path, 'wx', 0o600));
    const child = spawn(command[0]!, command.slice(1), {
      cwd: context.roots.workspaceRoot,
      detached: true,
      stdio: ['ignore', fds[0]!, fds[1]!],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: context.roots.workspaceRoot,
        NODE_ENV: process.env.NODE_ENV,
      },
    });
    const owned = ownProcess(child, {
      deadline: performance.now() + remaining,
      stopMs: Math.min(context.budget.reserveMs, remaining),
    });
    const abort = () => {
      void owned.stop();
    };
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    try {
      const stop = await owned.done;
      const passed =
        stop.stopped &&
        stop.code === 0 &&
        stop.signal === null &&
        !stop.deadlineReached &&
        !stop.killed &&
        !context.signal.aborted;
      const evidence = h01Record(context.roots.evidenceRoot, label, {
        kind: comparisonKind(context.criteria.value.id, 'check'),
        ...(context.criteria.value.id === 'H-03' ||
        context.criteria.value.id === 'H-04' ||
        context.criteria.value.id === 'H-05'
          ? {
              opId: context.opId,
              requestHash: context.requestHash,
              material: context.material.ref,
              cwd: context.roots.workspaceRoot,
            }
          : {}),
        command,
        stop,
        passed,
        stdout: fileRef(paths[0]!),
        stderr: fileRef(paths[1]!),
      });
      const failed =
        stop.stopped &&
        stop.code !== null &&
        stop.code > 0 &&
        stop.signal === null &&
        !stop.killed &&
        !stop.deadlineReached &&
        !context.signal.aborted;
      return { passed, failed, known: stop.stopped && !stop.deadlineReached, evidence };
    } finally {
      context.signal.removeEventListener('abort', abort);
    }
  } finally {
    for (const fd of fds) closeSync(fd);
  }
}

function acceptance(text: string) {
  const value = object(JSON.parse(text));
  requireWorkflow(
    isDeepStrictEqual(Object.keys(value).sort(), ['checks', 'limitations', 'outcome']) &&
      ['accepted', 'failed'].includes(String(value.outcome)) &&
      Array.isArray(value.limitations) &&
      value.limitations.every((line) => typeof line === 'string'),
    'h01-acceptance-schema',
  );
  const checks = object(value.checks);
  requireWorkflow(
    isDeepStrictEqual(Object.keys(checks).sort(), [...criteria.checks].sort()) &&
      Object.values(checks).every((value) => typeof value === 'boolean'),
    'h01-acceptance-schema',
  );
  return {
    accepted: value.outcome === 'accepted' && Object.values(checks).every(Boolean),
    checks: checks as Record<string, boolean>,
  };
}

/** One real operation. Dependencies are fixed production adapters; tests mock providers at module seams. */
export async function executeH01Child(
  requestRef: InputRef,
  controlRef: InputRef,
  scenario: NativeComparisonScenario = 'H-01',
) {
  const descriptor = parseH01GuardDescriptor(controlRef, scenario),
    request = parseH01Request(h01ReadJson(requestRef), 'run', scenario);
  const material = parseComparisonMaterials(materialsSource, suite).find(
    (row) => row.id === scenario,
  )!;
  const criteria = { ...suite.scenarios.find((row) => row.id === scenario)!, id: scenario };
  requireWorkflow(isDeepStrictEqual(descriptor.request, requestRef), 'h01-child-binding');
  await verifyH01GuardAuthorization(descriptor);
  const verifiedAuthorization = await verifyH01Authorization(request);
  const startRef = fileRef(resolve(request.roots.evidenceRoot, 'attempt-start.json'));
  const startRecord = object(h01ReadJson(startRef));
  const runtime = await verifyH01Runtime(request),
    profile = parseH01Profile(request.profile);
  const bootstrap = parseH01Bootstrap(request.bootstrap, request.variant);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('h01-work-deadline')),
    Math.max(0, Number(BigInt(descriptor.workDeadlineNs) - process.hrtime.bigint()) / 1e6),
  );
  const signal = () => controller.abort(new Error('h01-parent-stop'));
  process.once('SIGTERM', signal);
  process.once('SIGINT', signal);
  const observer = createH01NativeGuard(controlRef, scenario);
  const context: H01AttemptContext = {
    opId: request.opId,
    requestHash: descriptor.requestHash,
    variant: request.variant,
    material: { ref: request.material, value: material },
    criteria: { ref: request.criteria, value: criteria },
    roots: request.roots,
    identity: request.identity,
    profile: {
      model: profile.model,
      effort: profile.effort,
      clientVersion: profile.clientVersion,
    },
    disabledMcpServers: profile.disabledMcpServers ?? [],
    binary: profile.binary,
    rules: profile.rules,
    executor: profile.executor,
    reviewer: profile.reviewer,
    runtime,
    bootstrap,
    verifiedAuthorization,
    budget: request.budget,
    deadlineNs: descriptor.deadlineNs,
    workDeadlineNs: descriptor.workDeadlineNs,
    signal: controller.signal,
    nativeObserver: observer,
  };
  const evidence: InputRef[] = [verifiedAuthorization, startRef];
  let outcome: H01ExecutionReport['outcome'] = 'unknown',
    nativeAcceptance: InputRef | null = null;
  let checks = Object.fromEntries(criteria.checks.map((check) => [check, false]));
  let stop = h01Record(request.roots.evidenceRoot, 'initial-stop', {
    kind: comparisonKind(scenario, 'stop'),
    executionVersion: 2,
    opId: request.opId,
    confirmed: false,
    sessions: [],
    remainingProcesses: [],
    evidence: [],
    reason: 'not yet executed',
  });
  let projection: InputRef | undefined;
  let connection: Connection | undefined, nativeConnection: NativeConnection | undefined;
  try {
    let immutable = await (scenario === 'H-01'
      ? prepareCase(context)
      : prepareScenarioCase(context));
    if (bootstrap.engine === 'legacy' && scenario === 'H-01')
      evidence.push(...prepareLegacy(context));
    await observer.verify();
    // Pin and inspect the exact executable only after the fresh primary grant.
    h01ReadPin(profile.binary);
    const timeout = Math.floor(
      Number(BigInt(descriptor.workDeadlineNs) - process.hrtime.bigint()) / 1e6,
    );
    requireWorkflow(timeout > 0, 'h01-deadline');
    const version = await exec(profile.binary.locator, ['--version'], {
      timeout,
      signal: controller.signal,
      cwd: request.roots.workspaceRoot,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: request.roots.workspaceRoot,
        NODE_ENV: process.env.NODE_ENV,
      },
    });
    requireWorkflow(
      version.stdout.trim().split(' ').at(-1) === profile.clientVersion,
      'h01-client-version',
    );
    let backend: H01BackendAdapter;
    if (bootstrap.engine === 'legacy')
      backend =
        scenario === 'H-01'
          ? createH01LegacyAdapter()
          : scenario === 'H-02'
            ? (await import('./comparisonH02NativeLegacy.js')).createH02NativeLegacyAdapter()
            : scenario === 'H-03'
              ? (await import('./comparisonH03Legacy.js')).createH03LegacyAdapter()
              : scenario === 'H-04'
                ? (await import('./comparisonH04NativeLegacy.js')).createH04NativeLegacyAdapter()
                : (await import('./comparisonH05Legacy.js')).createH05LegacyAdapter();
    else {
      connection = await Connection.connect({ address: bootstrap.address });
      nativeConnection = await NativeConnection.connect({
        address: bootstrap.address,
      });
      const services = {
        client: new Client({ connection, namespace: bootstrap.namespace }),
        nativeConnection,
        taskQueue: bootstrap.taskQueue,
        workflowsPath: bootstrap.workflowsPath,
      };
      backend =
        scenario === 'H-01'
          ? createH01TemporalAdapter(services)
          : scenario === 'H-02'
            ? (await import('./comparisonH02NativeTemporal.js')).createH02NativeTemporalAdapter(
                services,
              )
            : scenario === 'H-03'
              ? (await import('./comparisonH03Temporal.js')).createH03TemporalAdapter(services)
              : scenario === 'H-04'
                ? (await import('./comparisonH04NativeTemporal.js')).createH04NativeTemporalAdapter(
                    services,
                  )
                : (await import('./comparisonH05Temporal.js')).createH05TemporalAdapter(services);
    }
    const result = await backend.execute(context);
    if (scenario !== 'H-01') projection = result.projection;
    evidence.push(...result.evidence, result.stop);
    stop = result.stop;
    nativeAcceptance = result.nativeAcceptance;
    if (scenario !== 'H-01' && result.outcome !== 'unknown') {
      projection = result.projection;
      verifyStop(stop, request.opId, scenario);
      await observer.verify();
      const projected = object(h01ReadJson(result.projection));
      requireWorkflow(
        projected.kind === comparisonKind(scenario, 'native-projection') &&
          projected.scenario === scenario &&
          projected.opId === request.opId &&
          projected.engine === bootstrap.engine,
        'h02-native-projection',
      );
      const caseReport = object(h01ReadJson(projected.caseReport as InputRef));
      checks = object(caseReport.checks) as Record<string, boolean>;
      requireWorkflow(
        isDeepStrictEqual(Object.keys(checks).sort(), [...criteria.checks].sort()) &&
          Object.values(checks).every((value) => typeof value === 'boolean'),
        'h02-native-checks',
      );
      requireWorkflow(nativeAcceptance !== null, 'h02-native-acceptance-missing');
      h01ReadPin(nativeAcceptance);
      await verifyComparisonMaterial(request.roots.workspaceRoot, immutable, material.mutable);
      const checked = await exec(process.execPath, ['checks.mjs'], {
        cwd: request.roots.workspaceRoot,
        timeout: Math.max(
          1,
          Math.floor(Number(BigInt(descriptor.workDeadlineNs) - process.hrtime.bigint()) / 1e6),
        ),
        signal: controller.signal,
        env: { PATH: '/usr/bin:/bin' },
      });
      evidence.push(
        h01Record(request.roots.evidenceRoot, 'h02-checker', {
          stdout: checked.stdout,
          stderr: checked.stderr,
        }),
      );
      await verifyComparisonMaterial(request.roots.workspaceRoot, immutable, material.mutable);
      outcome =
        result.outcome === 'completed' &&
        caseReport.outcome === 'accepted' &&
        Object.values(checks).every(Boolean)
          ? 'accepted'
          : 'failed';
    } else if (scenario === 'H-01' && result.outcome !== 'unknown') {
      verifyStop(stop, request.opId);
      await observer.verify();
      if (result.outcome === 'completed')
        immutable = await verifyH01Projection(context, result.projection, immutable);
      await verifyComparisonMaterial(request.roots.workspaceRoot, immutable, material.mutable);
      if (result.outcome === 'failed') outcome = 'failed';
      else {
        const checked = await checkNativeCase(context);
        evidence.push(checked.evidence);
        await verifyComparisonMaterial(request.roots.workspaceRoot, immutable, material.mutable);
        if (checked.known) {
          const council = await runH01NativeSession(
            context,
            'council',
            `Independent read-only H01 acceptance. Task: ${criteria.task}\n${material.instructions}\n` +
              (result.ready
                ? `Read the host's primary READY receipt ${canonical(result.ready)} and its bound LOAD artifact in the same directory. `
                : '') +
              `Inspect both consumers and boundaries; use primary evidence ${canonical(evidence)}. ` +
              `Common checker passed=${checked.passed}. Do not change files or grant authority. ` +
              `Return ONLY JSON {"outcome":"accepted"|"failed","checks":${canonical(checks)},"limitations":[]} ` +
              'with an honest boolean for every criterion. Missing evidence means failed.',
          );
          evidence.push(...council.evidence, council.stop);
          stop = council.stop;
          if (council.outcome !== 'unknown') {
            verifyStop(stop, request.opId);
            const reviewed = acceptance(council.text);
            checks = reviewed.checks;
            await verifyComparisonMaterial(
              request.roots.workspaceRoot,
              immutable,
              material.mutable,
            );
            await observer.verify();
            outcome =
              checked.passed && reviewed.accepted && council.outcome === 'completed'
                ? 'accepted'
                : 'failed';
          }
        }
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    evidence.push(
      h01Record(request.roots.evidenceRoot, 'failure', {
        kind: 'comparison-h01-failure',
        message: reason,
      }),
    );
    stop = h01Record(request.roots.evidenceRoot, 'unknown-stop', {
      kind: comparisonKind(scenario, 'stop'),
      executionVersion: 2,
      opId: request.opId,
      confirmed: false,
      sessions: [],
      remainingProcesses: [],
      evidence: [...evidence],
      reason: 'Operation failed; this observation does not confirm native stop: ' + reason,
    });
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', signal);
    process.removeListener('SIGINT', signal);
    // These SDK promises are bounded physically by the owning parent, not by an invented timeout proof.
    try {
      await nativeConnection?.close();
      await connection?.close();
    } catch (error) {
      outcome = 'unknown';
      evidence.push(h01Record(request.roots.evidenceRoot, 'close-failure', String(error)));
    }
  }
  const accounting = observer.accounting();
  if (accounting.unknown || controller.signal.aborted) outcome = 'unknown';
  h01ReadPin(startRef);
  const timing = {
    start: startRecord.start as unknown as ComparisonInstant,
    end: instant(),
  };
  const report: H01ExecutionReport = {
    kind: comparisonKind(scenario, 'execution-report'),
    executionVersion: 2,
    opId: request.opId,
    requestHash: descriptor.requestHash,
    variant: request.variant,
    outcome,
    checks,
    evidence,
    stop,
    nativeAcceptance,
    accounting,
    timing,
    elapsedMs: comparisonDuration(timing.start, timing.end),
    unproven:
      scenario === 'H-01'
        ? unproven
        : [
            `One ${scenario} scoped native attempt; no installed supply or full series qualification.`,
          ],
    partialScope: true,
    qualification: false,
  };
  if (projection !== undefined) Object.assign(report, { projection });
  if (report.elapsedMs === null) report.outcome = 'unknown';
  writeFileSync(
    resolve(request.roots.evidenceRoot, comparisonLabel(scenario) + '-child-report.json'),
    canonical(report) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return report;
}

export async function runH01(value: unknown, scenario: NativeComparisonScenario = 'H-01') {
  const start = instant(),
    startedNs = process.hrtime.bigint();
  const request = parseH01Request(value, 'run', scenario);
  planH01(request, scenario);
  const runtime = await verifyH01Runtime(request);
  freshRoots(request);
  writeFileSync(
    resolve(request.roots.evidenceRoot, 'attempt-start.json'),
    canonical({ start }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  const requestRef = h01Record(request.roots.evidenceRoot, 'request', request);
  const authorization = await verifyH01Authorization(request);
  const profile = parseH01Profile(request.profile);
  const deadlineNs = startedNs + BigInt(request.budget.maxElapsedMs) * 1000000n;
  const descriptor: H01GuardDescriptor = {
    kind: comparisonKind(scenario, 'guard'),
    executionVersion: 2,
    opId: request.opId,
    requestHash: h01RequestHash(request),
    request: requestRef,
    variant: request.variant,
    roots: request.roots,
    budget: request.budget,
    profile: {
      model: profile.model,
      effort: profile.effort,
      clientVersion: profile.clientVersion,
    },
    binary: profile.binary,
    authorization: request.authorization,
    pins: [
      request.material,
      request.criteria,
      request.profile,
      request.runtime,
      request.bootstrap,
      profile.binary,
      profile.rules,
      profile.executor,
      profile.reviewer,
      ...runtime.files,
    ],
    startedNs: String(startedNs),
    deadlineNs: String(deadlineNs),
    workDeadlineNs: String(deadlineNs - BigInt(request.budget.reserveMs) * 1000000n),
  };
  const controlRef = h01Record(request.roots.evidenceRoot, 'control', descriptor);
  await verifyH01GuardAuthorization(descriptor);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    const kept = await runH01OwnedChild(
      {
        entrypoint: fileRef(
          scenario === 'H-01' ? entrypoint : resolve(repository, comparisonEntrypoint(scenario)),
        ),
        request: requestRef,
        controlRef,
        evidenceRoot: request.roots.evidenceRoot,
        opId: request.opId,
        deadlineNs: descriptor.deadlineNs,
        workDeadlineNs: descriptor.workDeadlineNs,
      },
      controller.signal,
      scenario,
    );
    const child = kept.report ? object(h01ReadJson(kept.report)) : null;
    const timing = { start, end: instant() };
    const report = {
      kind: comparisonKind(scenario, 'owned-report'),
      executionVersion: 2,
      opId: request.opId,
      requestHash: descriptor.requestHash,
      variant: request.variant,
      outcome:
        kept.outcome === 'completed' && child?.outcome === 'accepted' && !controller.signal.aborted
          ? 'accepted'
          : kept.outcome === 'failed' && child?.outcome === 'failed'
            ? 'failed'
            : 'unknown',
      child: kept.report ?? null,
      stop: kept.stop,
      evidence: [authorization, controlRef, ...kept.evidence],
      accounting: child?.accounting ?? unknownAccounting(),
      timing,
      elapsedMs: comparisonDuration(timing.start, timing.end),
      partialScope: true,
      qualification: false,
      unproven:
        scenario === 'H-01'
          ? unproven
          : [
              `One ${scenario} attempt; native execution and full series acceptance require separate evidence.`,
            ],
    };
    const exported = h01Record(request.roots.evidenceRoot, 'owned-report', {
      ...report,
      kind: comparisonKind(scenario, 'owned-evidence'),
      outcome: 'pending-final-clock-check',
      proposedOutcome: report.outcome,
    });
    const result = {
      ...report,
      evidence: [...report.evidence, exported],
      timing: { start, end: instant() },
      clockBoundary:
        'after child stop, keeper logs and substantive owned-evidence export; before this final clock receipt',
    };
    result.elapsedMs = comparisonDuration(result.timing.start, result.timing.end);
    if (
      result.elapsedMs === null ||
      result.elapsedMs > request.budget.maxElapsedMs ||
      process.hrtime.bigint() > deadlineNs
    ) {
      result.outcome = 'unknown';
    }
    const ref = h01Record(
      request.roots.evidenceRoot,
      result.outcome === 'unknown' ? 'owned-overrun' : 'owned-result',
      result,
    );
    return { ...result, report: ref };
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}

export async function h01Main(args: string[], scenario: NativeComparisonScenario = 'H-01') {
  if (args[0] === '--' + comparisonLabel(scenario) + '-child') {
    requireWorkflow(
      args.length === 5 && process.connected && process.send !== undefined,
      'h01-child-parent',
    );
    const request = { locator: args[1]!, hash: args[2]! },
      controlRef = { locator: args[3]!, hash: args[4]! };
    const descriptor = parseH01GuardDescriptor(controlRef, scenario);
    const binding: unknown = await new Promise((accept) => process.once('message', accept));
    requireWorkflow(
      isDeepStrictEqual(binding, {
        kind: comparisonKind(scenario, 'owned-child'),
        opId: descriptor.opId,
        parentPid: process.ppid,
        request,
        controlRef,
      }) && isDeepStrictEqual(descriptor.request, request),
      'h01-child-parent',
    );
    await verifyH01GuardAuthorization(descriptor);
    process.send!({
      kind: comparisonKind(scenario, 'owned-child-ready'),
      opId: descriptor.opId,
      parentPid: process.ppid,
      request,
      controlRef,
    });
    const report = await executeH01Child(request, controlRef, scenario);
    process.exitCode = report.outcome === 'accepted' ? 0 : 1;
    process.disconnect!();
    return;
  }
  requireWorkflow(args.length === 2 && ['--plan', '--run'].includes(args[0]!), 'h01-usage');
  const request: unknown = JSON.parse(h01RawFile(resolve(args[1]!)).toString('utf8'));
  const result =
    args[0] === '--plan' ? planH01(request, scenario) : await runH01(request, scenario);
  process.stdout.write(canonical(result) + '\n');
  if (args[0] === '--run' && 'outcome' in result && result.outcome !== 'accepted')
    process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h01Main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
