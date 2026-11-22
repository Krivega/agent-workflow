import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { canonical } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { digest, readProjectFile } from '../src/adapters/artifacts/files.js';
import {
  exactFields,
  identifier,
  object,
  relativePath,
  requireContract,
} from '../src/contracts/project.js';
import { parseLocalTask, taskPathAllowed } from '../src/policy/localTask.js';
import { readerExecution, supportedTaskClient } from '../src/policy/readerExecution.js';
import { parseReviewRequest } from '../src/policy/review.js';
import { parseSubstantialPlan } from '../src/policy/substantialTask.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { planH06NativeAttempt } from './comparisonH06NativeAttemptPlan.js';

type Request = ReturnType<typeof planH06NativeAttempt>['request'];

export function temporalBootstrap(request: Request) {
  requireContract(
    request.binding.variant === 'temporal' && request.server !== null,
    'h06-temporal-operator-variant',
  );
  const body = object(JSON.parse(readH04Pin(request.bootstrap).toString()));
  exactFields(body, [
    'kind',
    'address',
    'server',
    'taskQueue',
    'workflows',
    'profile',
    'disabledServers',
    'input',
    'workspaceFiles',
    'artifacts',
  ]);
  const address = body.address;
  requireContract(
    body.kind === 'comparison-h06-native-temporal-bootstrap/2' &&
      typeof address === 'string' &&
      /^127\.0\.0\.1:[1-9]\d{0,4}$/u.test(address) &&
      Number(address.slice('127.0.0.1:'.length)) <= 65535,
    'h06-temporal-operator-endpoint',
  );
  const server = object(body.server);
  exactFields(server, ['httpPort', 'metricsPort', 'sqlitePath']);
  const port = (value: unknown) => {
    requireContract(
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 65535,
      'h06-temporal-operator-endpoint',
    );
    return value;
  };
  const httpPort = port(server.httpPort);
  const metricsPort = port(server.metricsPort);
  const sqlitePath = request.evidenceRoot + '-server/temporal.sqlite';
  requireContract(
    server.sqlitePath === sqlitePath &&
      new Set([Number(address.slice('127.0.0.1:'.length)), httpPort, metricsPort]).size === 3,
    'h06-temporal-operator-server-scope',
  );
  // Both Reader Host workers use the SDK's default namespace.
  const taskQueue = identifier(body.taskQueue);
  const workflows = h04Pin(body.workflows);
  requireContract(
    request.runtime.some((pin) => same(pin, workflows)),
    'h06-temporal-operator-workflows',
  );
  const profile = readerExecution(body.profile as Parameters<typeof readerExecution>[0]).profile;
  requireContract(supportedTaskClient(profile.clientVersion), 'h06-temporal-operator-profile');
  requireContract(
    Array.isArray(body.disabledServers) &&
      body.disabledServers.every(
        (name) => typeof name === 'string' && /^[a-zA-Z0-9_-]+$/u.test(name),
      ) &&
      new Set(body.disabledServers).size === body.disabledServers.length,
    'h06-temporal-operator-servers',
  );
  const disabledServers = body.disabledServers as string[];
  const input = parseLocalTask(body.input);
  const { preparation } = input.admission;
  requireContract(
    input.schemaVersion === 11 &&
      input.continuation.attempt === 0 &&
      preparation.hostId === request.binding.operationId &&
      input.baseline === 'syntax' &&
      same([...preparation.project.checks].sort(), ['syntax', 'validate']),
    'h06-temporal-operator-input',
  );
  const needed = new Set([
    ...preparation.project.rules,
    ...preparation.project.roles.map(({ profile: path }) => path),
    preparation.card,
    input.admission.plan.path,
    input.executor.path,
  ]);
  const workspaceFiles = object(body.workspaceFiles);
  exactFields(workspaceFiles, [...needed]);
  const workspace = request.binding.workspaceRoot;
  let topLevel: string;
  try {
    topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trimEnd();
  } catch (error) {
    throw new Error('h06-temporal-operator-git-workspace', { cause: error });
  }
  requireContract(topLevel === workspace, 'h06-temporal-operator-git-workspace');
  for (const [path, sha256] of Object.entries(workspaceFiles))
    requireContract(
      digest(readProjectFile(workspace, relativePath(path))) === sha256,
      'h06-temporal-operator-workspace-file',
    );
  requireContract(
    workspaceFiles[input.admission.plan.path] === input.admission.plan.sha256 &&
      workspaceFiles[input.executor.path] === input.executor.sha256,
    'h06-temporal-operator-input-pin',
  );
  const plan = parseSubstantialPlan(
    JSON.parse(readProjectFile(workspace, input.admission.plan.path).toString()),
  );
  requireContract(
    plan.paths.every((path) => path.startsWith('evidence/')) &&
      plan.paths.includes('evidence/manifest.json') &&
      plan.basis.some(
        ({ locator }) => dirname(locator) === 'evidence' && !taskPathAllowed(plan.paths, locator),
      ) &&
      same([...plan.checks].sort(), [...preparation.project.checks].sort()),
    'h06-temporal-operator-plan-scope',
  );
  const sources = [plan.requirement, ...plan.basis, plan.owner, ...plan.consumers];
  for (const source of sources)
    requireContract(
      digest(readProjectFile(workspace, source.locator)) === source.hash,
      'h06-temporal-operator-plan-source',
    );
  requireContract(
    Array.isArray(body.artifacts) && body.artifacts.length > 0,
    'h06-temporal-operator-artifacts',
  );
  const artifacts = new Map<string, Buffer>();
  for (const value of body.artifacts) {
    const pin = h04Pin(value);
    requireContract(
      !artifacts.has(pin.sha256) && request.runtime.some((entry) => same(entry, pin)),
      'h06-temporal-operator-artifacts',
    );
    artifacts.set(pin.sha256, readH04Pin(pin));
  }
  for (const phase of ['planning', 'acceptance'] as const) {
    const ref = input.admission[phase];
    const bytes = artifacts.get(ref.sha256);
    requireContract(bytes?.length === ref.bytes, 'h06-temporal-operator-artifacts');
    const review = parseReviewRequest(JSON.parse(bytes.toString()), {
      schemaVersion: 1,
      preparation,
      reviewId: phase,
      request: ref,
    });
    requireContract(review.phase === phase, 'h06-temporal-operator-review-phase');
    const applicable = review.roles.filter((role) => role.applies === true);
    requireContract(
      review.scope === plan.plan_id &&
        applicable.length > 0 &&
        review.roles.every(
          (role) => role.applies !== null && role.complete && role.history.complete,
        ),
      'h06-temporal-operator-review-scope',
    );
    if (phase === 'planning') {
      const visible = new Set([
        preparation.card,
        ...preparation.project.rules,
        ...review.sharedPaths,
        ...applicable.flatMap((role) => role.paths),
      ]);
      requireContract(
        applicable.every((role) =>
          [...review.sharedPaths, ...role.paths].includes(input.admission.plan.path),
        ) && sources.every(({ locator }) => visible.has(locator)),
        'h06-temporal-operator-review-inputs',
      );
    }
  }
  return {
    server: { binary: request.server, address, httpPort, metricsPort, sqlitePath },
    taskQueue,
    workflows,
    profile,
    disabledServers,
    input,
    artifacts,
  };
}

/** Validate the backend descriptor before consuming the attempt's primary grant. */
export function planH06NativeTemporalOperator(value: unknown) {
  const plan = planH06NativeAttempt(value);
  temporalBootstrap(plan.request);
  return plan;
}

/** Propose only an owned server lifetime. The native attempt retains its own grant. */
export function planH06NativeTemporalServerSetup(value: unknown, budgetValue: unknown) {
  const attempt = planH06NativeAttempt(value);
  const { server } = temporalBootstrap(attempt.request);
  const budget = object(budgetValue);
  exactFields(budget, ['maxElapsedMs', 'stopReserveMs']);
  const { maxElapsedMs, stopReserveMs } = budget;
  requireContract(
    typeof maxElapsedMs === 'number' &&
      Number.isSafeInteger(maxElapsedMs) &&
      maxElapsedMs < 2 ** 31 &&
      typeof stopReserveMs === 'number' &&
      Number.isSafeInteger(stopReserveMs) &&
      stopReserveMs > 0 &&
      maxElapsedMs - stopReserveMs > attempt.request.budget.maxElapsedMs,
    'h06-temporal-server-setup-budget',
  );
  const root = dirname(server.sqlitePath);
  safeDirectory(dirname(root));
  requireContract(
    lstatSync(root, { throwIfNoEntry: false }) === undefined,
    'h06-temporal-server-setup-not-fresh',
  );
  const expected = { requestHash: attempt.requestHash, ...server };
  const bounds = { maxElapsedMs, stopReserveMs };
  const setupHash = digest(canonical({ expected, budget: bounds }));
  return {
    attempt,
    expected,
    budget: bounds,
    root,
    setupHash,
    expectedGrantText: canonical({
      kind: 'comparison-h06-native-temporal-server-setup-grant/2',
      operationId: attempt.request.binding.operationId,
      requestHash: attempt.requestHash,
      setupHash,
      budget: bounds,
    }),
    mayRun: false,
    qualification: false,
  } as const;
}
