import { spawn } from 'node:child_process';
import process from 'node:process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { saveCouncilProgress, waitCouncilProgress } from '../cli/councilProgress.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { effectJournal } from '../src/adapters/artifacts/effects.js';
import { requireContract } from '../src/contracts/project.js';
import type { ArtifactRef } from '../src/contracts/preparation.js';
import { ownProcess } from '../examples/temporal-consumers/full/safety.mjs';
import { digest } from '../adapters/storage/storeCodec.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { isDeepStrictEqual } from 'node:util';
import { historyToJSON } from '@temporalio/common/proto-utils';
import type { H04WorkflowInput } from './comparisonH04Workflow.js';
import {
  checkH04,
  h04InputHash,
  parseH04Request,
  readH04Json,
  readH04Pin,
  type H04Operation,
  type H04Request,
  h04SourcePaths,
  h04Intent,
  inspectH04Primary,
  h04Binding,
  h04BoundIntent,
  type H04OperationBinding,
} from './comparisonH04Contract.js';

export function saveH04(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
}
export function h04SourcePins() {
  return h04SourcePaths.map((path) => {
    return { path, sha256: digest(h01RawFile(path)) };
  });
}
export function planH04(value: unknown) {
  const request = parseH04Request(value);
  requireContract(
    realpathSync(dirname(request.outputRoot)) === dirname(request.outputRoot),
    'h04-parent-alias',
  );
  readH04Pin(request.node);
  if (request.server !== null) readH04Pin(request.server);
  return {
    request,
    sourcePins: h04SourcePins(),
    inputHash: h04InputHash(request),
    mayRun: false,
    qualification: false,
    modelStarts: 0,
    nativeProof: 'UNMET_PRIMARY_NATIVE_CURRENT_TURN_WAIT_PROOF',
    durationMs: 35000,
    logs: 6,
  };
}
export async function h04Operation(request: H04Request): Promise<ArtifactRef> {
  return h04BoundOperation(h04Binding(request));
}
export async function h04BoundOperation(
  binding: H04OperationBinding,
  signal?: AbortSignal,
): Promise<ArtifactRef> {
  const root = binding.outputRoot,
    store = artifactStore(join(root, 'artifacts'));
  return await effectJournal(join(root, 'effects')).execute(
    h04BoundIntent(binding, 'run'),
    async () => {
      saveH04(join(root, 'operation-start.json'), {
        operationId: binding.operationId,
        inputHash: binding.inputHash,
      });
      const began = performance.now(),
        logs: H04Operation['logs'] = [];
      const until = async (milliseconds: number) => {
        while (performance.now() - began < milliseconds)
          await delay(milliseconds - (performance.now() - began), undefined, { signal });
      };
      for (let sequence = 1; sequence <= 6; sequence++) {
        await until(sequence * 5000);
        const log = { sequence, elapsedMs: performance.now() - began };
        saveH04(join(root, `log-${sequence}.json`), log);
        logs.push(log);
      }
      await until(35000);
      return store.publish(
        Buffer.from(
          JSON.stringify({
            kind: 'h04-operation-result',
            operationId: binding.operationId,
            inputHash: binding.inputHash,
            elapsedMs: performance.now() - began,
            logs,
          }),
        ),
      );
    },
  );
}
export async function h04Legacy(request: H04Request): Promise<ArtifactRef> {
  return h04BoundLegacy(h04Binding(request));
}
export async function h04BoundLegacy(
  binding: H04OperationBinding,
  signal?: AbortSignal,
): Promise<ArtifactRef> {
  const progress = {
    schema_version: 1 as const,
    run_id: binding.operationId,
    phase: 'planning' as const,
    scope: 'test-owned-h04-operation',
    target_hash: binding.inputHash,
    status: 'running' as const,
    roles: {},
  };
  const first = saveCouncilProgress(binding.outputRoot, progress);
  const operation = h04BoundOperation(binding, signal);
  // The rejection is observed while the settled waiter is still pending.
  const completed = operation.then(
    (result) => {
      saveCouncilProgress(binding.outputRoot, { ...progress, status: 'completed' });
      return result;
    },
    (error) => {
      saveCouncilProgress(binding.outputRoot, { ...progress, status: 'failed' });
      throw error;
    },
  );
  const [waited, result] = await Promise.all([
    waitCouncilProgress(binding.outputRoot, first.cursor, 60000, {
      until: 'settled',
      ...(signal === undefined ? {} : { signal }),
    }),
    completed,
  ]);
  requireContract(
    !waited.timed_out && waited.snapshot.status === 'completed',
    'h04-wait-unconfirmed',
  );
  saveH04(join(binding.outputRoot, 'wait.json'), waited);
  return result;
}
export async function h04Temporal(request: H04Request): Promise<ArtifactRef> {
  requireContract(request.server !== null, 'h04-server');
  const { TestWorkflowEnvironment } = await import('@temporalio/testing');
  const { Worker } = await import('@temporalio/worker');
  const environment = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      ui: false,
      executable: { type: 'existing-path', path: request.server.path },
      dbFilename: join(request.outputRoot, 'temporal.sqlite'),
    },
  });
  try {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: request.operationId,
      workflowsPath: fileURLToPath(new URL('./comparisonH04Workflow.ts', import.meta.url)),
      activities: {
        h04Operation: (input: H04WorkflowInput) => {
          requireContract(
            isDeepStrictEqual(input, {
              operationId: request.operationId,
              inputHash: h04InputHash(request),
            }),
            'h04-activity-input',
          );
          return h04Operation(request);
        },
      },
      maxConcurrentActivityTaskExecutions: 1,
    });
    return await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start('ComparisonH04Workflow', {
        taskQueue: request.operationId,
        workflowId: request.operationId,
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        args: [{ operationId: request.operationId, inputHash: h04InputHash(request) }],
      });
      saveH04(join(request.outputRoot, 'workflow.json'), {
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
      });
      const result = (await handle.result()) as ArtifactRef;
      saveH04(
        join(request.outputRoot, 'history.json'),
        JSON.parse(historyToJSON(await handle.fetchHistory())),
      );
      return result;
    });
  } finally {
    await environment.teardown();
  }
}
export async function h04Worker(request: H04Request): Promise<void> {
  try {
    const result =
      request.variant === 'legacy' ? await h04Legacy(request) : await h04Temporal(request);
    saveH04(join(request.outputRoot, 'worker.json'), {
      status: 'completed',
      inputHash: h04InputHash(request),
      result,
      waitCalls: 1,
      operationStarts: 1,
    });
  } catch (error) {
    saveH04(join(request.outputRoot, 'worker.json'), {
      status: 'unknown',
      inputHash: h04InputHash(request),
      error: error instanceof Error ? error.stack : String(error),
    });
    process.exitCode = 1;
  }
}
export async function h04Keeper(request: H04Request, deadlineNs: string): Promise<void> {
  requireContract(process.connected === true, 'h04-owner-ipc-required');
  const remaining = Number(BigInt(deadlineNs) - process.hrtime.bigint()) / 1e6;
  requireContract(remaining > 0 && remaining <= 120000, 'h04-owner-deadline');
  const child = spawn(
    request.node.path,
    [
      '--import',
      'tsx',
      fileURLToPath(import.meta.url),
      '--operation',
      join(request.outputRoot, 'request.json'),
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );
  const owned = ownProcess(child, { deadline: performance.now() + remaining, stopMs: 30000 });
  const disconnected = () => {
    void owned.stop();
  };
  process.on('disconnect', disconnected);
  let bytes = 0,
    exceeded = false;
  for (const [source, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const)
    source.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 1048576) {
        exceeded = true;
        void owned.stop();
      } else target.write(data);
    });
  let stop;
  try {
    stop = await owned.done;
  } finally {
    stop ??= await owned.stop();
    process.removeListener('disconnect', disconnected);
  }
  saveH04(join(request.outputRoot, 'worker-stop.json'), stop);
  if (!(
    process.connected &&
    stop.stopped &&
    stop.code === 0 &&
    stop.signal === null &&
    !stop.deadlineReached &&
    !exceeded
  ))
    process.exitCode = 1;
  if (process.connected) process.disconnect!();
}
export async function finishH04(request: H04Request) {
  const root = request.outputRoot;
  const primary = inspectH04Primary(request);
  if (primary.modelFree !== 'UNKNOWN') {
    const result = primary.result;
    // Only the still-running owner applies after the keeper confirms physical stop.
    await effectJournal(join(root, 'effects')).execute(h04Intent(request, 'apply'), async () => {
      saveH04(join(root, 'applied.json'), { operationId: request.operationId, result });
      return result;
    });
  }
  const result = checkH04(request);
  saveH04(join(root, 'report.json'), result);
  return result;
}
export async function runH04(value: unknown) {
  const { request, sourcePins } = planH04(value);
  requireContract(request.node.path === realpathSync(process.execPath), 'h04-actual-node-required');
  requireContract(!existsSync(request.outputRoot), 'h04-output-exists');
  mkdirSync(request.outputRoot, { mode: 0o700 });
  saveH04(join(request.outputRoot, 'request.json'), request);
  saveH04(join(request.outputRoot, 'source-pins.json'), sourcePins);
  const deadlineNs = process.hrtime.bigint() + 120000000000n;
  const child = spawn(
    request.node.path,
    [
      '--import',
      'tsx',
      fileURLToPath(import.meta.url),
      '--worker',
      join(request.outputRoot, 'request.json'),
      String(deadlineNs),
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        TSX_DISABLE_CACHE: '1',
        NODE_DISABLE_COMPILE_CACHE: '1',
        TMPDIR: request.outputRoot,
      },
    },
  );
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  const owned = ownProcess(child, {
    deadline: performance.now() + Number(deadlineNs - process.hrtime.bigint()) / 1e6,
    stopMs: 30000,
  });
  let stop;
  try {
    requireContract(child.stdout !== null && child.stderr !== null, 'h04-child-streams-missing');
    child.stdout.on('data', (bytes: Buffer) => stdout.push(bytes));
    child.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
    stop = await owned.done;
  } finally {
    stop ??= await owned.stop();
    saveH04(join(request.outputRoot, 'stop.json'), stop);
  }
  writeFileSync(join(request.outputRoot, 'stdout.log'), Buffer.concat(stdout));
  writeFileSync(join(request.outputRoot, 'stderr.log'), Buffer.concat(stderr));
  for (const pin of sourcePins) readH04Pin(pin);
  return await finishH04(request);
}
export async function h04Main(args: string[]) {
  requireContract(args.length === (args[0] === '--worker' ? 3 : 2), 'h04-arguments');
  const request = readH04Json(args[1]!);
  if (args[0] === '--plan') return planH04(request);
  if (args[0] === '--check') return checkH04(parseH04Request(request));
  if (args[0] === '--run') return await runH04(request);
  if (args[0] === '--worker') {
    await h04Keeper(parseH04Request(request), args[2]!);
    return null;
  }
  requireContract(args[0] === '--operation', 'h04-arguments');
  await h04Worker(parseH04Request(request));
  return null;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  h04Main(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    });
}
