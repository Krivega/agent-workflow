import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { object, requireWorkflow } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { ownProcess } from '../examples/temporal-consumers/full/safety.mjs';
import type { OwnedProcessReceipt } from '../examples/temporal-consumers/full/safety.mjs';
import {
  h01RawFile,
  h01ReadJson,
  h01ReadPin,
  h01Record,
  h01RequestHash,
  observeH01Authorization,
  parseH01Bootstrap,
  parseH01Profile,
  parseH01Request,
  parseH01Runtime,
  comparisonKind,
  comparisonLabel,
  comparisonEntrypoint,
} from './comparisonH01Contract.js';
import type { NativeComparisonScenario } from './comparisonH01Contract.js';
import { parseH01OperatorSpec } from './comparisonH01Preparation.js';
import { verifyH01Runtime } from './comparisonH01.js';

const self = fileURLToPath(import.meta.url);
const rootNames = [
  'workspaceRoot',
  'stateRoot',
  'evidenceRoot',
  'artifactRoot',
  'hostRoot',
] as const;
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
const fileRef = (path: string): InputRef => ({
  locator: path,
  hash: digest(h01RawFile(path)),
});
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function inputs(
  specRef: InputRef,
  requestRef: InputRef,
  mode: 'plan' | 'run',
  scenario: NativeComparisonScenario,
) {
  const spec = parseH01OperatorSpec(h01ReadJson(specRef), scenario);
  requireWorkflow(
    spec.node.locator === realpathSync(process.execPath),
    'h01-operator-node-binding',
  );
  const request = parseH01Request(h01ReadJson(requestRef), mode, scenario);
  const runtime = parseH01Runtime(request.runtime, request.variant);
  const bootstrap = parseH01Bootstrap(request.bootstrap, request.variant);
  const profile = parseH01Profile(request.profile);
  requireWorkflow(
    spec.opId === request.opId &&
      spec.variant === request.variant &&
      same(spec.budget, request.budget) &&
      same(spec.roots, request.roots) &&
      spec.runtimeRoot === runtime.root &&
      spec.entrypoint.locator === join(runtime.root, comparisonEntrypoint(scenario)) &&
      self === join(runtime.root, 'tests/comparisonH01Operator.ts') &&
      runtime.files.some((ref) => same(ref, specRef)) &&
      runtime.files.some((ref) => same(ref, spec.entrypoint)) &&
      runtime.files.some((ref) => ref.locator === self && ref.hash === digest(h01RawFile(self))),
    'h01-operator-binding',
  );
  requireWorkflow(
    (bootstrap.engine === 'temporal') === (spec.temporal !== undefined),
    'h01-operator-engine',
  );
  if (bootstrap.engine === 'temporal') {
    const temporal = spec.temporal!;
    requireWorkflow(
      temporal.address === bootstrap.address &&
        temporal.namespace === bootstrap.namespace &&
        temporal.namespace === 'default' &&
        temporal.taskQueue === bootstrap.taskQueue &&
        temporal.workflowsPath === bootstrap.workflowsPath &&
        runtime.files.some((ref) => ref.locator === temporal.workflowsPath) &&
        dirname(temporal.sqlitePath) === spec.evidenceRoot,
      'h01-operator-temporal-binding',
    );
  }
  const roots = [...rootNames.map((name) => request.roots[name]), spec.evidenceRoot];
  const runBase = dirname(spec.evidenceRoot);
  requireWorkflow(
    !present(runBase) && safeDirectory(dirname(runBase)) === dirname(runBase),
    'h01-operator-run-base',
  );
  const pins = [
    specRef,
    requestRef,
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
    spec.node,
    ...(spec.temporal ? [spec.temporal.binary] : []),
  ];
  for (const [i, root] of roots.entries()) {
    requireWorkflow(
      roots.every((other, j) => i === j || !overlaps(root, other)) &&
        root.startsWith(runBase + sep) &&
        !overlaps(root, runtime.root) &&
        !root.startsWith(request.authorization.root + sep) &&
        pins.every((ref) => !ref.locator.startsWith(root + sep)),
      'h01-operator-roots-overlap',
    );
    requireWorkflow(!present(root), 'h01-operator-root-not-fresh');
  }
  requireWorkflow(
    !request.roots.evidenceRoot.startsWith(dirname(request.roots.workspaceRoot) + sep) &&
      !request.roots.artifactRoot.startsWith(dirname(request.roots.workspaceRoot) + sep) &&
      !request.roots.hostRoot.startsWith(dirname(request.roots.workspaceRoot) + sep),
    'h01-operator-writer-tree',
  );
  pins.forEach(h01ReadPin);
  for (const binary of [spec.node, ...(spec.temporal ? [spec.temporal.binary] : [])])
    requireWorkflow(Boolean(lstatSync(binary.locator).mode & 0o100), 'h01-operator-executable');
  return { spec, request, runtime, pins, runBase };
}

export function planH01Operator(
  spec: InputRef,
  request: InputRef,
  scenario: NativeComparisonScenario = 'H-01',
) {
  const value = inputs(spec, request, 'plan', scenario);
  return {
    kind: comparisonKind(scenario, 'operator-plan'),
    schemaVersion: 1,
    opId: value.request.opId,
    variant: value.request.variant,
    budget: value.request.budget,
    requestHash: h01RequestHash(value.request),
    spec,
    request,
    roots: value.request.roots,
    evidenceRoot: value.spec.evidenceRoot,
    mayRun: false,
    qualification: false,
    actualModelStarts: 0,
    actualServices: 0,
    scope: `one external ${scenario} interval; observed token cutoff, no provider-global quota`,
  };
}

function environment(): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:LD_|DYLD_|NODE_|TSX_|TEMPORAL|PG|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/iu.test(
          name,
        ),
    ),
  );
  return {
    ...kept,
    NODE_ENV: process.env.NODE_ENV,
    PATH: [dirname(realpathSync(process.execPath)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
      ':',
    ),
  };
}

interface Resource {
  name: 'server' | 'h01' | 'h02' | 'h03' | 'h04' | 'h05';
  child: ChildProcess;
  owner?: ReturnType<typeof ownProcess>;
  receipt?: OwnedProcessReceipt;
  stopping?: boolean;
  error?: string;
}

/** One externally authorized attempt; no retry, lifecycle, grant issuance or source cleanup. */
export async function runH01Operator(
  specRef: InputRef,
  requestRef: InputRef,
  signal?: AbortSignal,
  scenario: NativeComparisonScenario = 'H-01',
) {
  const label = comparisonLabel(scenario);
  const startedNs = process.hrtime.bigint();
  const initial = inputs(specRef, requestRef, 'run', scenario);
  const { spec, request } = initial;
  const deadlineNs = startedNs + BigInt(spec.budget.maxElapsedMs) * 1_000_000n;
  const workDeadlineNs = deadlineNs - BigInt(spec.budget.reserveMs) * 1_000_000n;
  const resources: Resource[] = [],
    evidence: InputRef[] = [];
  const errors: { phase: string; reason: string }[] = [];
  const portStops: { address: string; closed: boolean | null }[] = [];
  const controller = new AbortController();
  let timedOut = false,
    error: string | null = null;
  let result: Record<string, unknown> | null = null;
  let outcome: 'accepted' | 'failed' | 'unknown' = 'unknown';
  const failure = (phase: string, value: unknown) => {
    const reason = String(value);
    errors.push({ phase, reason });
    error ??= reason;
    outcome = 'unknown';
  };
  let identity: [number, number] | undefined,
    baseIdentity: [number, number] | undefined,
    marker: InputRef | undefined;
  const now = () => process.hrtime.bigint();
  const check = (work: boolean) => {
    signal?.throwIfAborted();
    controller.signal.throwIfAborted();
    requireWorkflow(
      now() >= startedNs && now() < (work ? workDeadlineNs : deadlineNs),
      'h01-operator-deadline',
    );
  };
  const remaining = () => {
    check(true);
    const ms = Math.floor(Number(workDeadlineNs - now()) / 1_000_000);
    requireWorkflow(ms > 0, 'h01-operator-deadline');
    return ms;
  };
  const verifyOwner = () => {
    const stat = lstatSync(spec.evidenceRoot);
    const base = lstatSync(initial.runBase);
    requireWorkflow(same([stat.dev, stat.ino], identity), 'h01-operator-owner-changed');
    requireWorkflow(same([base.dev, base.ino], baseIdentity), 'h01-operator-owner-changed');
    h01ReadPin(marker!);
  };
  const record = (name: string, value: unknown) => {
    verifyOwner();
    const ref = h01Record(spec.evidenceRoot, name, value);
    evidence.push(ref);
    return ref;
  };
  const stop = () => {
    controller.abort();
    for (const resource of resources) {
      try {
        void resource.owner?.stop().catch((failure: unknown) => {
          resource.error ??= String(failure);
        });
      } catch (failure) {
        resource.error ??= String(failure);
      }
    }
  };
  const bounded = async <T>(pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('h01-operator-deadline')), remaining());
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  };
  // This observes the actual primary source, root chat and native home without creating roots.
  const authority = await bounded(observeH01Authorization(request));
  await bounded(verifyH01Runtime(request));
  check(true);
  inputs(specRef, requestRef, 'run', scenario);
  await bounded(observeH01Authorization(request));
  check(true);
  mkdirSync(initial.runBase, { mode: 0o700 });
  const baseStat = lstatSync(initial.runBase);
  baseIdentity = [baseStat.dev, baseStat.ino];
  const createdParents = [initial.runBase];
  const parents = (path: string) => {
    requireWorkflow(
      path === initial.runBase || path.startsWith(initial.runBase + sep),
      'h01-operator-parent-scope',
    );
    const missing: string[] = [];
    while (!present(path)) {
      missing.unshift(path);
      path = dirname(path);
    }
    requireWorkflow(safeDirectory(path) === path, 'h01-operator-parent-alias');
    for (const parent of missing) {
      check(true);
      requireWorkflow(!present(parent), 'h01-operator-parent-race');
      mkdirSync(parent, { mode: 0o700 });
      createdParents.push(parent);
    }
  };
  parents(dirname(spec.evidenceRoot));
  mkdirSync(spec.evidenceRoot, { mode: 0o700 });
  const stat = lstatSync(spec.evidenceRoot);
  identity = [stat.dev, stat.ino];
  marker = h01Record(spec.evidenceRoot, 'owner', {
    kind: label + '-operator-owner',
    opId: request.opId,
    specRef,
    requestRef,
  });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, remaining());
  signal?.addEventListener('abort', stop, { once: true });
  const launch = async (name: Resource['name'], binary: InputRef, args: string[]) => {
    const authority = await bounded(observeH01Authorization(request));
    await bounded(verifyH01Runtime(request));
    check(true);
    verifyOwner();
    initial.pins.forEach(h01ReadPin);
    record('authorization-before-' + name, authority);
    const fds: number[] = [];
    try {
      for (const suffix of ['stdout', 'stderr'])
        fds.push(
          openSync(
            join(spec.evidenceRoot, name + '.' + suffix),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          ),
        );
      check(true);
      const child = spawn(binary.locator, args, {
        cwd: initial.runtime.root,
        env: environment(),
        detached: true,
        stdio: ['ignore', fds[0]!, fds[1]!],
      });
      const resource: Resource = { name, child };
      resources.push(resource);
      resource.owner = ownProcess(child, {
        now: () => Number(now() / 1_000_000n),
        deadline: Number(deadlineNs / 1_000_000n),
        stopMs: spec.budget.reserveMs,
        ...(name === 'server' ? { termGraceMs: Math.ceil(spec.budget.reserveMs / 2) } : {}),
        listenerPaths: name === 'server' ? [spec.temporal!.sqlitePath] : [],
      });
      void resource.owner.done.then(
        (receipt) => {
          resource.receipt = receipt;
          if (!receipt.stopped || (name === 'server' && !resource.stopping)) stop();
        },
        (failure: unknown) => {
          resource.error ??= String(failure);
          stop();
        },
      );
      record('launch-' + name, {
        binary,
        args,
        pid: child.pid ?? null,
        startedNs: String(now()),
      });
      return resource;
    } finally {
      fds.forEach(closeSync);
    }
  };
  const port = (address: string) => Number(address.slice(address.lastIndexOf(':') + 1));
  const probe = (address: string) =>
    new Promise<boolean>((resolveProbe, reject) => {
      const left = Math.floor(Number(deadlineNs - now()) / 1_000_000);
      requireWorkflow(now() >= startedNs && left > 0, 'h01-operator-deadline');
      const timeout = Math.min(500, left);
      const socket = createConnection({
        host: '127.0.0.1',
        port: port(address),
      });
      socket.once('connect', () => {
        socket.destroy();
        resolveProbe(true);
      });
      socket.once('error', (failure: NodeJS.ErrnoException) => {
        socket.destroy();
        if (failure.code === 'ECONNREFUSED') resolveProbe(false);
        else reject(failure);
      });
      socket.setTimeout(timeout, () => {
        socket.destroy();
        reject(new Error('h01-operator-port-unknown'));
      });
    });
  const addresses = spec.temporal
    ? [spec.temporal.address, spec.temporal.httpAddress, spec.temporal.metricsAddress]
    : [];
  try {
    record('authorization', authority);
    for (const name of rootNames) parents(dirname(request.roots[name]));
    record('parents', { createdParents, retained: true });
    for (const address of addresses) {
      requireWorkflow(!(await probe(address)), 'h01-operator-port-already-open');
      check(true);
    }
    if (spec.temporal) {
      const temporal = spec.temporal;
      const server = await launch('server', temporal.binary, [
        'server',
        'start-dev',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port(temporal.address)),
        '--http-port',
        String(port(temporal.httpAddress)),
        '--metrics-port',
        String(port(temporal.metricsAddress)),
        '--headless',
        '--db-filename',
        temporal.sqlitePath,
      ]);
      for (;;) {
        check(true);
        requireWorkflow(
          server.receipt === undefined && server.error === undefined,
          'h01-operator-server-stop-unknown',
        );
        requireWorkflow(
          server.child.exitCode === null && server.child.signalCode === null,
          'h01-operator-server-exited',
        );
        if (await probe(temporal.address)) {
          check(true);
          const listeners = execFileSync(
            '/usr/sbin/lsof',
            ['-nP', '-t', '-iTCP:' + port(temporal.address), '-sTCP:LISTEN'],
            {
              encoding: 'utf8',
              timeout: Math.min(2000, remaining()),
              env: environment(),
            },
          ).trim();
          requireWorkflow(
            listeners === String(server.child.pid),
            'h01-operator-server-owner-unknown',
          );
          record('server-ready', {
            address: temporal.address,
            pid: server.child.pid,
            listeners,
          });
          break;
        }
        await pause(Math.min(25, remaining()));
      }
    }
    check(true);
    const child = await launch(label, spec.node, [
      '--import',
      'tsx',
      spec.entrypoint.locator,
      '--run',
      requestRef.locator,
    ]);
    child.receipt = await child.owner!.done;
    check(false);
    requireWorkflow(
      child.receipt.stopped &&
        child.receipt.code !== null &&
        child.receipt.signal === null &&
        !child.receipt.killed &&
        !child.receipt.deadlineReached,
      'h01-operator-child-stop-unknown',
    );
    result = object(JSON.parse(h01RawFile(join(spec.evidenceRoot, label + '.stdout')).toString()));
    const report = result.report as InputRef;
    const stored = object(h01ReadJson(report));
    const { report: _report, ...delivered } = result;
    requireWorkflow(
      same(stored, delivered) &&
        stored.kind === comparisonKind(scenario, 'owned-report') &&
        stored.opId === request.opId &&
        stored.requestHash === h01RequestHash(request) &&
        stored.variant === request.variant &&
        stored.partialScope === true &&
        stored.qualification === false &&
        ((child.receipt.code === 0 && stored.outcome === 'accepted') ||
          (child.receipt.code !== 0 && stored.outcome === 'failed') ||
          (child.receipt.code === 1 && stored.outcome === 'unknown')),
      'h01-operator-result-binding',
    );
    evidence.push(report);
    outcome = stored.outcome as 'accepted' | 'failed' | 'unknown';
    if (outcome === 'accepted') {
      const accounting = object(stored.accounting);
      requireWorkflow(
        accounting.unknown === false &&
          [
            'reservedManagedStarts',
            'observedResponses',
            'inputUncached',
            'inputCached',
            'output',
          ].every(
            (name) => Number.isSafeInteger(accounting[name]) && Number(accounting[name]) >= 0,
          ) &&
          Number(accounting.reservedManagedStarts) <= spec.budget.maxManagedStarts &&
          Number(accounting.inputUncached) <= spec.budget.maxInputUncached &&
          Number(accounting.output) <= spec.budget.maxOutput,
        'h01-operator-accounting-unknown',
      );
    }
  } catch (error) {
    failure('execution', error);
  } finally {
    for (const resource of [...resources].reverse()) {
      try {
        resource.stopping = true;
        if (resource.receipt === undefined && resource.owner !== undefined)
          resource.receipt = await resource.owner.stop();
        const receipt = resource.receipt;
        if (
          !receipt?.stopped ||
          receipt.killed ||
          receipt.deadlineReached ||
          resource.error ||
          (resource.name === 'server' && receipt.code !== 0 && receipt.signal !== 'SIGTERM')
        )
          outcome = 'unknown';
        record('stop-' + resource.name, {
          ...receipt,
          pid: resource.child.pid ?? null,
          error: resource.error ?? null,
          owned: resource.owner !== undefined,
        });
      } catch (error) {
        failure('stop-' + resource.name, error);
      }
    }
    // A cancellation/deadline is sticky, but physical stop observations still use the remaining hard interval.
    for (const address of addresses) {
      try {
        const closed = !(await probe(address));
        portStops.push({ address, closed });
        requireWorkflow(closed, 'h01-operator-listener-remains');
      } catch (error) {
        if (!portStops.some((value) => value.address === address))
          portStops.push({ address, closed: null });
        failure('port-stop', error);
      }
    }
    try {
      record('ports-stopped', { portStops });
    } catch (error) {
      failure('stop-export', error);
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
  try {
    check(false);
    verifyOwner();
    initial.pins.forEach(h01ReadPin);
    for (const resource of resources)
      for (const suffix of ['stdout', 'stderr'])
        evidence.push(fileRef(join(spec.evidenceRoot, resource.name + '.' + suffix)));
    const exported: { source: InputRef; copy: InputRef }[] = [];
    const copy = (source: string, destination: string) => {
      check(false);
      verifyOwner();
      requireWorkflow(safeDirectory(source) === source, 'h01-operator-export-alias');
      mkdirSync(destination, { mode: 0o700 });
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        check(false);
        const from = join(source, entry.name),
          to = join(destination, entry.name);
        if (entry.isDirectory()) copy(from, to);
        else {
          const bytes = h01RawFile(from);
          writeFileSync(to, bytes, { flag: 'wx', mode: 0o600 });
          const original = fileRef(from),
            preserved = fileRef(to);
          requireWorkflow(
            original.hash === preserved.hash && digest(bytes) === original.hash,
            'h01-operator-export-changed',
          );
          exported.push({ source: original, copy: preserved });
        }
      }
    };
    if (existsSync(request.roots.evidenceRoot))
      copy(request.roots.evidenceRoot, join(spec.evidenceRoot, 'export'));
    else
      requireWorkflow(
        resources.every((resource) => resource.name !== label),
        'h01-operator-evidence-missing',
      );
    record('export', {
      kind: label + '-operator-export',
      exported,
      retainedRoots: request.roots,
      wholeStore: false,
      activationAllowed: false,
    });
    check(false);
  } catch (error) {
    failure('export', error);
  }
  const endedNs = now();
  if (
    timedOut ||
    controller.signal.aborted ||
    signal?.aborted ||
    endedNs < startedNs ||
    endedNs >= deadlineNs
  )
    outcome = 'unknown';
  const report = {
    kind: comparisonKind(scenario, 'operator-report'),
    schemaVersion: 1,
    opId: request.opId,
    requestHash: h01RequestHash(request),
    variant: request.variant,
    specRef,
    requestRef,
    outcome,
    error,
    errors,
    timedOut,
    budget: spec.budget,
    startedNs: String(startedNs),
    endedNs: String(endedNs),
    deadlineNs: String(deadlineNs),
    elapsedMs: endedNs < startedNs ? null : Number(endedNs - startedNs) / 1_000_000,
    child: result,
    stops: resources.map(({ name, child, receipt, error }) => ({
      name,
      pid: child.pid ?? null,
      receipt: receipt ?? null,
      error: error ?? null,
    })),
    portStops,
    evidence,
    rootsRetained: true,
    activationAllowed: false,
    partialScope: true,
    qualification: false,
    clockBoundary:
      'before primary authorization/preparation/server; through child, known stops and substantive evidence export; final clock receipt and CLI delivery excluded',
    unproven: [
      'provider-global quota; tokens are observed cutoffs with nullable pending metrics',
      'whole-store/export of other retained roots',
      'physical preemption of synchronous filesystem IO',
      'full T5 pair/series',
    ],
  };
  const receipt = record('operator-result', report);
  return { ...report, report: receipt };
}

export async function h01OperatorMain(args: string[], scenario: NativeComparisonScenario = 'H-01') {
  requireWorkflow(
    args.length === 3 && ['--plan', '--run'].includes(args[0]!),
    'h01-operator-usage',
  );
  const spec = fileRef(resolve(args[1]!)),
    request = fileRef(resolve(args[2]!));
  const controller = new AbortController();
  const abort = () => controller.abort();
  let result;
  if (args[0] === '--plan') result = planH01Operator(spec, request, scenario);
  else {
    process.once('SIGTERM', abort);
    process.once('SIGINT', abort);
    try {
      result = await runH01Operator(spec, request, controller.signal, scenario);
    } finally {
      process.removeListener('SIGTERM', abort);
      process.removeListener('SIGINT', abort);
    }
  }
  process.stdout.write(canonical(result) + '\n');
  if ('outcome' in result && result.outcome !== 'accepted') process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  h01OperatorMain(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  });
