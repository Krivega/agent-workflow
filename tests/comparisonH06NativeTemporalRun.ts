import { resolve } from 'node:path';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { resolveH06NativeGrant } from './comparisonH06NativeAuthority.js';
import { h06NativeChatRelay } from './comparisonH06NativeChatRelay.js';
import { runH06NativeTemporalDriver } from './comparisonH06NativeTemporalDriver.js';
import { planH06NativeTemporalServerSetup } from './comparisonH06NativeTemporalOperator.js';
import { h06TemporalWorkerProcesses } from './comparisonH06NativeTemporalProcesses.js';

export function planH06NativeTemporalRun(value: unknown) {
  const input = object(value);
  exactFields(input, ['kind', 'setup', 'worker']);
  requireContract(input.kind === 'comparison-h06-native-temporal-run/2', 'h06-temporal-run-kind');
  const setup = object(JSON.parse(readH04Pin(h04Pin(input.setup)).toString()));
  exactFields(setup, ['kind', 'attempt', 'budget']);
  requireContract(
    setup.kind === 'comparison-h06-native-server-setup/2',
    'h06-native-stand-server-kind',
  );
  const request: unknown = JSON.parse(readH04Pin(h04Pin(setup.attempt)).toString());
  const plan = planH06NativeTemporalServerSetup(request, setup.budget);
  const rawWorker = object(input.worker);
  exactFields(rawWorker, ['node', 'tsx', 'entry']);
  const worker = {
    node: h04Pin(rawWorker.node),
    tsx: h04Pin(rawWorker.tsx),
    entry: h04Pin(rawWorker.entry),
  };
  requireContract(
    same(worker.node, plan.attempt.request.binding.node) &&
      worker.tsx.path === fileURLToPath(import.meta.resolve('tsx')) &&
      worker.entry.path ===
        fileURLToPath(new URL('./comparisonH06NativeTemporalProcesses.ts', import.meta.url)) &&
      [worker.tsx, worker.entry].every((pin) =>
        plan.attempt.request.runtime.some((entry) => same(entry, pin)),
      ),
    'h06-temporal-run-unpinned-worker',
  );
  for (const pin of Object.values(worker)) readH04Pin(pin);
  return { plan, worker };
}

/** Start only from the exact current server grant, then request the attempt grant after READY. */
export async function runH06NativeTemporalFromChat(
  input: unknown,
  channel: { input: Readable; output: Writable; signal: AbortSignal },
) {
  const { plan, worker } = planH06NativeTemporalRun(input);
  const { request } = plan.attempt;
  const server = await resolveH06NativeGrant({
    request,
    expectedGrantText: plan.expectedGrantText,
  });
  channel.signal.throwIfAborted();
  const relay = h06NativeChatRelay(channel.input, channel.output);
  const stopDeadlineMs = Date.now() + plan.budget.maxElapsedMs;
  const workDeadlineMs = stopDeadlineMs - plan.budget.stopReserveMs;
  const workers = h06TemporalWorkerProcesses(
    { ...worker, workDeadlineMs, stopDeadlineMs },
    relay.chat,
  );
  try {
    return await runH06NativeTemporalDriver(
      request,
      plan.budget,
      {
        server,
        attempt: (signal) =>
          relay.attempt(plan.attempt.expectedGrantText, AbortSignal.any([signal, channel.signal])),
      },
      {
        initialAndWarm: (data, signal) =>
          workers.initialAndWarm(data, AbortSignal.any([signal, channel.signal])),
        cold: (data, signal) => workers.cold(data, AbortSignal.any([signal, channel.signal])),
      },
      channel.signal,
    );
  } finally {
    relay.close();
  }
}

export async function h06NativeTemporalRunMain(args: readonly string[]) {
  const [command, path] = args;
  requireContract(
    args.length === 2 && path !== undefined && (command === '--plan' || command === '--run'),
    'h06-temporal-run-arguments',
  );
  const value: unknown = JSON.parse(h01RawFile(resolve(path)).toString());
  if (command === '--plan') return planH06NativeTemporalRun(value);
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('h06-temporal-run-interrupted'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    return await runH06NativeTemporalFromChat(value, {
      input: process.stdin,
      output: process.stdout,
      signal: abort.signal,
    });
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void h06NativeTemporalRunMain(process.argv.slice(2)).then(
    (result) => process.stdout.write(JSON.stringify(result) + '\n'),
    (error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    },
  );
