import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { ownProcess } from '../examples/temporal-consumers/full/safety.mjs';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import {
  nativeHumanAuthorizationText,
  nativeReaderNotice,
  type NativeReaderSource,
} from '../src/adapters/codex/readerAuthority.js';
import { makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import type { PayloadReaderCommand } from '../src/contracts/readerControl.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  runH06NativeTemporalCold,
  runH06NativeTemporalInitialAndWarm,
  type H06TemporalCommandChat,
  type H06TemporalWorkerProcesses,
} from './comparisonH06NativeTemporalDriver.js';

const entryPath = fileURLToPath(import.meta.url);
const tsxPath = fileURLToPath(import.meta.resolve('tsx'));
const kind = 'h06-native-temporal-process/2';
const switchName = '--h06-temporal-worker';
const commands = [
  ['h06-warm-pause', 'pause', 0],
  ['h06-warm-resume', 'resume', 1],
  ['h06-cold-pause', 'pause', 1],
  ['h06-cold-resume', 'resume', 2],
] as const;

type Stage = 'initial-and-warm' | 'cold' | 'deadline-load';
type StageInput = Parameters<H06TemporalWorkerProcesses['initialAndWarm']>[0];
type Warm = Awaited<ReturnType<H06TemporalWorkerProcesses['initialAndWarm']>>;
type Cold = Awaited<ReturnType<H06TemporalWorkerProcesses['cold']>>;
type Identity = { stage: Stage; nonce: string; parent: number; pid: number };
type Wire = Record<string, unknown>;

function workerErrorMessage(error: unknown, depth = 0): string {
  const message = String(error).slice(0, 2048);
  if (depth === 3 || !(error instanceof Error)) return message;
  const nested: unknown[] =
    error instanceof AggregateError && Array.isArray(error.errors) ? error.errors.slice(0, 4) : [];
  if (error.cause !== undefined) nested.push(error.cause);
  return [message, ...nested.map((cause) => workerErrorMessage(cause, depth + 1))]
    .join('; ')
    .slice(0, 2048);
}

interface ProcessPins {
  node: H04Pin;
  tsx: H04Pin;
  entry: H04Pin;
  workDeadlineMs: number;
  stopDeadlineMs: number;
}

import {
  isH06TemporalAutonomousMode,
  readH06TemporalControlMode,
} from './comparisonH06TemporalAutonomousControls.js';
import { readH06TemporalAutonomousAuthority } from './comparisonH06TemporalAutonomousAuthority.js';
import { runTD054DeadlineLoad } from './td054DeadlineNative.mjs';

function wire(identity: Identity, type: string, fields: Wire) {
  return { kind, ...identity, type, ...fields };
}

function bound(value: unknown, identity: Identity) {
  const body = object(value);
  requireContract(
    body.kind === kind &&
      body.stage === identity.stage &&
      body.nonce === identity.nonce &&
      body.parent === identity.parent &&
      body.pid === identity.pid,
    'h06-temporal-process-binding',
  );
  return body;
}

function fields(body: Wire, names: string[]) {
  exactFields(body, ['kind', 'stage', 'nonce', 'parent', 'pid', 'type', ...names]);
}

function sourceValue(value: unknown): NativeReaderSource {
  const source = object(value);
  exactFields(source, ['kind', 'schemaVersion', 'threadId', 'turnId', 'transcript', 'user']);
  const user = object(source.user);
  exactFields(user, ['line', 'sha256']);
  const { path: transcript, sha256 } = h04Pin({ path: source.transcript, sha256: user.sha256 });
  const line = user.line;
  requireContract(
    source.kind === 'codex-user-command' &&
      source.schemaVersion === 1 &&
      typeof line === 'number' &&
      Number.isSafeInteger(line) &&
      line > 0,
    'h06-temporal-process-source',
  );
  return {
    kind: 'codex-user-command',
    schemaVersion: 1,
    transcript,
    threadId: identifier(source.threadId),
    turnId: identifier(source.turnId),
    user: { line, sha256 },
  };
}

function proposal(value: unknown, index: number) {
  requireContract(
    typeof value === 'string' && value.length <= 16384,
    'h06-temporal-process-proposal',
  );
  const body = object(JSON.parse(value));
  exactFields(body, [
    'schemaVersion',
    'commandId',
    'author',
    'action',
    'target',
    'expectedRevision',
    'attempt',
    'payload',
  ]);
  const expected = commands[index];
  requireContract(
    expected !== undefined &&
      body.schemaVersion === 2 &&
      body.commandId === expected[0] &&
      body.action === expected[1] &&
      body.attempt === expected[2] &&
      body.expectedRevision === index,
    'h06-temporal-process-proposal',
  );
  const command = body as unknown as Omit<PayloadReaderCommand, 'hash' | 'source'>;
  const reference = { bytes: 0, sha256: '0'.repeat(64) };
  requireContract(
    value ===
      nativeHumanAuthorizationText(makeTaskExecutionCommand({ ...command, source: reference })),
    'h06-temporal-process-proposal',
  );
  return { text: value, command };
}

function readWarm(value: unknown): Warm {
  const result = object(value);
  exactFields(result, ['claim', 'started', 'warm', 'cold', 'coldPauseAck', 'duration']);
  for (const pin of [result.claim, result.started, result.coldPauseAck]) h04Pin(pin);
  return result as unknown as Warm;
}

function readCold(value: unknown): Cold {
  const result = object(value);
  exactFields(result, ['cold', 'result', 'history']);
  h04Pin(result.history);
  return result as unknown as Cold;
}

/** Fork each stage from the pinned inputs. Both success and failure await owned cleanup. */
export function h06TemporalWorkerProcesses(
  pins: ProcessPins,
  chat: H06TemporalCommandChat,
): H06TemporalWorkerProcesses & {
  deadlineLoad(
    input: { claim: H04Pin; server: H04Pin; node: H04Pin },
    signal: AbortSignal,
  ): Promise<never>;
} {
  const options = structuredClone(pins);
  const { node, tsx, entry, workDeadlineMs, stopDeadlineMs } = options;
  const attempted = new Set<Stage>();
  requireContract(
    h04Pin(tsx).path === tsxPath &&
      h04Pin(entry).path === entryPath &&
      Number.isSafeInteger(workDeadlineMs) &&
      Number.isSafeInteger(stopDeadlineMs) &&
      workDeadlineMs < stopDeadlineMs &&
      stopDeadlineMs - Date.now() < 2 ** 31,
    'h06-temporal-process-input',
  );
  async function run<T>(
    stage: Stage,
    input: unknown,
    resultValue: (value: unknown) => T,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    const inputBody = object(input);
    const modeValue = stage === 'cold' ? object(inputBody.cold).controlMode : inputBody.authority;
    const autonomous = isH06TemporalAutonomousMode(modeValue);
    if (autonomous) {
      const mode = readH06TemporalControlMode(modeValue),
        parent = readH06TemporalAutonomousAuthority(mode.authority);
      requireContract(
        parent.workDeadlineMs === workDeadlineMs && parent.stopDeadlineMs === stopDeadlineMs,
        'h06-temporal-process-autonomous-clock',
      );
      requireContract(
        stage === 'initial-and-warm'
          ? same(inputBody.attempt, parent.request)
          : same(object(inputBody.cold).claim, parent.nativeClaim),
        'h06-temporal-process-autonomous-input',
      );
    }
    for (const pin of [node, tsx, entry]) readH04Pin(h04Pin(pin));
    const server = h04Pin(stage === 'cold' ? object(inputBody.cold).server : inputBody.server);
    readH04Pin(server);
    const root = safeDirectory(dirname(server.path));
    const rootIdentity = lstatSync(root, { bigint: true });
    const outcomePath = join(root, `worker-${stage}-outcome.json`);
    requireContract(
      !attempted.has(stage) && lstatSync(outcomePath, { throwIfNoEntry: false }) === undefined,
      'h06-temporal-process-already-attempted',
    );
    const now = Date.now();
    requireContract(now < workDeadlineMs, 'h06-temporal-process-deadline');
    attempted.add(stage);
    const nonce = randomUUID();
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.TSX_TSCONFIG_PATH;
    const child = spawn(node.path, ['--import', tsx.path, entry.path, switchName, stage, nonce], {
      detached: true,
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const hardDeadline = performance.now() + stopDeadlineMs - now;
    const owner = ownProcess(child, {
      deadline: hardDeadline,
      // Reserve the last part for TERM/KILL and observation; cancellation owns the rest.
      automaticStopAt: hardDeadline - Math.min(2000, (stopDeadlineMs - workDeadlineMs) / 4),
      stopMs: stopDeadlineMs - workDeadlineMs,
    });
    const identity = { stage, nonce, parent: process.pid, pid: child.pid ?? 0 };
    const abort = new AbortController();
    let failure: Error | undefined;
    let cancelSentAt: number | null = null;
    let cancelDeliveredAt: number | null = null;
    let exited = false;
    let result: { value: T } | undefined;
    let processing = false;
    let next = 0;
    let pending:
      | { command: Omit<PayloadReaderCommand, 'hash' | 'source'>; source: NativeReaderSource }
      | undefined;
    function fail(error: unknown, cooperative = false) {
      if (failure !== undefined) return;
      failure = error instanceof Error ? error : new Error(String(error));
      abort.abort(failure);
      if (cooperative) {
        try {
          cancelSentAt = Date.now();
          child.send(wire(identity, 'cancel', {}), (error) => {
            if (error !== null) void owner.stop();
            else cancelDeliveredAt = Date.now();
          });
        } catch {
          void owner.stop();
        }
      } else void owner.stop();
    }
    const interrupted = () => fail(signal.reason, true);
    const timer = setTimeout(
      () => fail(new Error('h06-temporal-process-deadline'), true),
      workDeadlineMs - now,
    );
    const onExit = () => {
      exited = true;
    };
    const send = (type: string, data: Wire) => {
      abort.signal.throwIfAborted();
      child.send(wire(identity, type, data), (error) => {
        if (error !== null) fail(error);
      });
    };
    async function receive(value: unknown) {
      requireContract(
        !processing && result === undefined && !abort.signal.aborted,
        'h06-temporal-process-order',
      );
      const body = bound(value, identity);
      if (body.type === 'error') {
        fields(body, ['message']);
        requireContract(typeof body.message === 'string', 'h06-temporal-process-error');
        throw new Error('h06-temporal-worker: ' + body.message);
      }
      if (body.type === 'result') {
        fields(body, ['value']);
        requireContract(
          pending === undefined &&
            next === (stage === 'initial-and-warm' && !autonomous ? commands.length : 0),
          'h06-temporal-process-incomplete',
        );
        result = { value: resultValue(body.value) };
        return;
      }
      requireContract(
        stage === 'initial-and-warm' && !autonomous && body.step === next,
        'h06-temporal-process-order',
      );
      processing = true;
      if (body.type === 'source') {
        fields(body, ['step', 'text']);
        requireContract(pending === undefined, 'h06-temporal-process-order');
        const proposed = proposal(body.text, next);
        const source = sourceValue(await chat.source(proposed.text, abort.signal));
        pending = { command: proposed.command, source };
        processing = false;
        send('source', { step: next, source });
        return;
      }
      fields(body, ['step', 'notice', 'source']);
      requireContract(
        body.type === 'record' && pending !== undefined && same(body.source, pending.source),
        'h06-temporal-process-notice',
      );
      const bytes = Buffer.from(JSON.stringify(pending.source));
      const source = { sha256: digest(bytes), bytes: bytes.length };
      const notice = nativeReaderNotice(makeTaskExecutionCommand({ ...pending.command, source }));
      requireContract(body.notice === notice, 'h06-temporal-process-notice');
      await chat.record(notice, pending.source, abort.signal);
      pending = undefined;
      processing = false;
      send('record', { step: next++ });
    }
    const onMessage = (message: unknown) => {
      if (!abort.signal.aborted) void receive(message).catch((error: unknown) => fail(error));
    };
    signal.addEventListener('abort', interrupted, { once: true });
    child.once('exit', onExit);
    child.on('message', onMessage);
    try {
      try {
        signal.throwIfAborted();
        requireContract(identity.pid > 1, 'h06-temporal-process-pid');
        send('start', { input });
      } catch (error) {
        fail(error);
      }
      const stopped = await owner.done;
      readH04Pin(server);
      const currentRoot = lstatSync(safeDirectory(root), { bigint: true });
      requireContract(
        currentRoot.dev === rootIdentity.dev && currentRoot.ino === rootIdentity.ino,
        'h06-temporal-process-root-changed',
      );
      const recordedAt = Date.now();
      publishFile(
        outcomePath,
        Buffer.from(
          JSON.stringify({
            kind: 'h06-native-temporal-process-outcome/1',
            ...identity,
            server,
            workDeadlineMs,
            stopDeadlineMs,
            recordedAt,
            observedExit: exited,
            failure: failure === undefined ? null : workerErrorMessage(failure),
            ...(stage === 'deadline-load'
              ? { deadlineCancel: { sentAt: cancelSentAt, deliveredAt: cancelDeliveredAt } }
              : {}),
            receipt: stopped,
          }),
        ),
      );
      requireContract(stopped.stopped && exited, 'h06-temporal-process-stop-unconfirmed');
      if (failure !== undefined) throw failure;
      requireContract(
        stopped.code === 0 &&
          stopped.signal === null &&
          !stopped.killed &&
          !stopped.deadlineReached &&
          recordedAt <= stopDeadlineMs &&
          result !== undefined,
        'h06-temporal-process-result-unconfirmed',
      );
      return result.value;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', interrupted);
      child.removeListener('exit', onExit);
      child.removeListener('message', onMessage);
      abort.abort();
    }
  }
  return {
    initialAndWarm(input, signal) {
      const attempt = object(input.attempt);
      requireContract(
        same(node, h04Pin(object(attempt.binding).node)),
        'h06-temporal-process-node',
      );
      return run('initial-and-warm', input, readWarm, signal);
    },
    cold: (input, signal) => run('cold', input, readCold, signal),
    deadlineLoad(input, signal) {
      requireContract(same(node, h04Pin(input.node)), 'h06-temporal-process-node');
      return run(
        'deadline-load',
        input,
        () => {
          throw new Error('h06-temporal-process-unexpected-load-result');
        },
        signal,
      );
    },
  };
}

async function workerMain(args: string[]) {
  const [flag, stage, nonce] = args;
  requireContract(
    args.length === 3 &&
      flag === switchName &&
      (stage === 'initial-and-warm' || stage === 'cold' || stage === 'deadline-load') &&
      typeof nonce === 'string' &&
      /^[a-f\d-]{36}$/u.test(nonce) &&
      process.send !== undefined &&
      process.connected,
    'h06-temporal-process-child',
  );
  const identity: Identity = { stage, nonce, parent: process.ppid, pid: process.pid };
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  for (const event of ['disconnect', 'SIGTERM', 'SIGINT'] as const) process.on(event, interrupted);
  const cancelled = (value: unknown) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('type' in value) ||
      value.type !== 'cancel'
    )
      return;
    try {
      fields(bound(value, identity), []);
      abort.abort(new Error('h06-temporal-process-cancelled'));
    } catch (error) {
      abort.abort(error);
    }
  };
  process.on('message', cancelled);
  const signal = abort.signal;
  const send = (type: string, data: Wire) =>
    new Promise<void>((accept, reject) => {
      process.send!(wire(identity, type, data), (error) => {
        if (error === null) accept();
        else reject(error);
      });
    });
  async function receive() {
    const messages: unknown[] = await once(process, 'message', { signal });
    return bound(messages[0], identity);
  }
  let step = 0;
  async function exchange(type: string, data: Wire) {
    signal.throwIfAborted();
    const [response] = await Promise.all([receive(), send(type, { step, ...data })]);
    requireContract(response.type === type && response.step === step, 'h06-temporal-process-reply');
    return response;
  }
  try {
    const started = await receive();
    fields(started, ['input']);
    requireContract(started.type === 'start', 'h06-temporal-process-start');
    const chat: H06TemporalCommandChat = {
      async source(text, stageSignal) {
        stageSignal.throwIfAborted();
        const response = await exchange('source', { text });
        fields(response, ['step', 'source']);
        return sourceValue(response.source);
      },
      async record(notice, source, stageSignal) {
        stageSignal.throwIfAborted();
        const response = await exchange('record', { notice, source });
        fields(response, ['step']);
        step++;
      },
    };
    let result: Warm | Cold;
    if (stage === 'initial-and-warm') {
      const input = object(started.input);
      exactFields(input, ['attempt', 'authority', 'server']);
      result = await runH06NativeTemporalInitialAndWarm(
        { ...input, server: h04Pin(input.server) } as StageInput,
        chat,
        signal,
      );
    } else if (stage === 'cold')
      result = await runH06NativeTemporalCold(readWarm(started.input), signal);
    else result = await runTD054DeadlineLoad(started.input, signal);
    signal.throwIfAborted();
    await send('result', { value: result });
  } catch (error) {
    process.exitCode = 1;
    if (process.connected) await send('error', { message: workerErrorMessage(error) });
  } finally {
    process.off('message', cancelled);
    for (const event of ['disconnect', 'SIGTERM', 'SIGINT'] as const)
      process.off(event, interrupted);
    if (process.connected) process.disconnect!();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === entryPath)
  await workerMain(process.argv.slice(2));
