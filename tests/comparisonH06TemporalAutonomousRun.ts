import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { exactFields, object, requireContract } from '../src/contracts/project.js';
import { h01RawFile } from './comparisonH01Contract.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { currentH06HumanAuthority } from './comparisonH06NativeAuthority.js';
import { runH06TemporalAutonomousDriver } from './comparisonH06NativeTemporalDriver.js';
import { h06TemporalWorkerProcesses } from './comparisonH06NativeTemporalProcesses.js';
import {
  consumeH06TemporalAutonomousAuthority,
  planH06TemporalAutonomousAuthority,
} from './comparisonH06TemporalAutonomousAuthority.js';

/** Prepare exact whole-attempt authority and canonical Worker pins without admitting a grant. */
export function planH06TemporalAutonomousRun(value: unknown) {
  const input = object(value);
  exactFields(input, ['kind', 'authority', 'worker']);
  requireContract(
    input.kind === 'comparison-h06-temporal-autonomous-run/3' ||
      input.kind === 'comparison-h06-temporal-reference-run/4',
    'h06-temporal-autonomous-run-kind',
  );
  const authority = h04Pin(input.authority);
  const plan = planH06TemporalAutonomousAuthority(JSON.parse(readH04Pin(authority).toString()));
  requireContract(
    plan.input.kind ===
      (input.kind === 'comparison-h06-temporal-autonomous-run/3'
        ? 'comparison-h06-temporal-autonomous/3'
        : 'comparison-h06-temporal-reference/4'),
    'h06-temporal-autonomous-run-authority-kind',
  );
  const raw = object(input.worker);
  exactFields(raw, ['node', 'tsx', 'entry']);
  const worker = { node: h04Pin(raw.node), tsx: h04Pin(raw.tsx), entry: h04Pin(raw.entry) };
  requireContract(
    same(worker.node, plan.request.binding.node) &&
      worker.tsx.path === fileURLToPath(import.meta.resolve('tsx')) &&
      worker.entry.path ===
        fileURLToPath(new URL('./comparisonH06NativeTemporalProcesses.ts', import.meta.url)) &&
      [worker.tsx, worker.entry].every((pin) =>
        plan.request.runtime.some((bound) => same(bound, pin)),
      ),
    'h06-temporal-autonomous-run-worker',
  );
  for (const pin of Object.values(worker)) readH04Pin(pin);
  return { authority, plan, worker };
}

/** Consume once before server setup. All subprocesses inherit the admitted absolute clocks. */
export async function runH06TemporalAutonomousFromChat(
  input: unknown,
  signal: AbortSignal,
  enclosingStartedAtMs?: number,
) {
  const { authority, plan, worker } = planH06TemporalAutonomousRun(input);
  signal.throwIfAborted();
  const source = await currentH06HumanAuthority(plan.request.chat, plan.reference === undefined);
  signal.throwIfAborted();
  const claim = await consumeH06TemporalAutonomousAuthority(
    JSON.parse(readH04Pin(authority).toString()),
    source,
    enclosingStartedAtMs,
    signal,
  );
  signal.throwIfAborted();
  const workers = h06TemporalWorkerProcesses(
    { ...worker, workDeadlineMs: claim.workDeadlineMs, stopDeadlineMs: claim.stopDeadlineMs },
    {
      source: async () => {
        throw new Error('h06-temporal-autonomous-unexpected-human-source');
      },
      record: async () => {
        throw new Error('h06-temporal-autonomous-unexpected-human-notice');
      },
    },
  );
  let active: Promise<unknown> | undefined;
  function own<T>(operation: () => Promise<T>) {
    const pending = operation();
    active = pending;
    return pending;
  }
  try {
    return await runH06TemporalAutonomousDriver(
      claim.receipt,
      {
        initialAndWarm: (data, stageSignal) =>
          own(() => workers.initialAndWarm(data, AbortSignal.any([signal, stageSignal]))),
        cold: (data, stageSignal) =>
          own(() => workers.cold(data, AbortSignal.any([signal, stageSignal]))),
      },
      signal,
    );
  } finally {
    // The server's abort race may finish before the owned Worker confirms its exit.
    await active?.catch(() => undefined);
  }
}

export async function h06TemporalAutonomousRunMain(args: readonly string[]) {
  const [command, path] = args;
  requireContract(
    args.length === 2 && path !== undefined && (command === '--plan' || command === '--run'),
    'h06-temporal-autonomous-run-arguments',
  );
  const value: unknown = JSON.parse(h01RawFile(resolve(path)).toString());
  if (command === '--plan') return planH06TemporalAutonomousRun(value);
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('h06-temporal-autonomous-run-interrupted'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    return await runH06TemporalAutonomousFromChat(value, abort.signal);
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void h06TemporalAutonomousRunMain(process.argv.slice(2)).then(
    (result) => process.stdout.write(JSON.stringify(result) + '\n'),
    (error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    },
  );
