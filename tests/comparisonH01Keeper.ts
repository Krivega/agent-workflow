import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { ownProcess } from '../examples/temporal-consumers/full/safety.mjs';
import type { OwnedProcessReceipt } from '../examples/temporal-consumers/full/safety.mjs';
import { object, requireWorkflow } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import {
  h01RawFile,
  h01ReadJson,
  h01ReadPin,
  h01Record,
  h01RequestHash,
  comparisonKind,
  comparisonLabel,
  parseH01GuardDescriptor,
  parseH01Request,
  verifyH01GuardAuthorization,
} from './comparisonH01Contract.js';
import type {
  H01KeeperInput,
  H01KeeperResult,
  NativeComparisonScenario,
} from './comparisonH01Contract.js';

/** The child owns Workers/native ports; the existing operator server remains outside this keeper. */
export async function runH01OwnedChild(
  input: H01KeeperInput,
  signal?: AbortSignal,
  scenario: NativeComparisonScenario = 'H-01',
): Promise<H01KeeperResult> {
  const label = comparisonLabel(scenario);
  const evidence: InputRef[] = [input.entrypoint, input.request, input.controlRef];
  let child: ChildProcess | undefined;
  let softStop = false,
    ready = false,
    forcedStop = false;
  let error: string | undefined;
  let observed: OwnedProcessReceipt | undefined;
  let report: InputRef | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let owned: ReturnType<typeof ownProcess> | undefined;
  let stop: (() => void) | undefined;
  let onMessage: ((message: unknown) => void) | undefined;
  const now = () => Number(process.hrtime.bigint() / 1_000_000n);
  const open: number[] = [];
  try {
    requireWorkflow(
      safeDirectory(input.evidenceRoot) === input.evidenceRoot,
      'h01-keeper-evidence-root',
    );
    signal?.throwIfAborted();
    const request = parseH01Request(h01ReadJson(input.request), 'run', scenario),
      descriptor = parseH01GuardDescriptor(input.controlRef, scenario);
    h01ReadPin(input.entrypoint);
    const deadline = BigInt(input.deadlineNs),
      work = BigInt(input.workDeadlineNs);
    requireWorkflow(
      BigInt(descriptor.startedNs) <= process.hrtime.bigint() && work > process.hrtime.bigint(),
      'h01-keeper-deadline',
    );
    requireWorkflow(
      descriptor.opId === input.opId &&
        request.opId === input.opId &&
        request.roots.evidenceRoot === input.evidenceRoot &&
        isDeepStrictEqual(descriptor.request, input.request) &&
        descriptor.deadlineNs === input.deadlineNs &&
        descriptor.workDeadlineNs === input.workDeadlineNs,
      'h01-keeper-binding',
    );
    await verifyH01GuardAuthorization(descriptor);
    signal?.throwIfAborted();
    requireWorkflow(work > process.hrtime.bigint(), 'h01-keeper-work-deadline');
    // Recheck actual bytes after the asynchronous primary authorization, before creating any child.
    for (const pin of [input.entrypoint, input.request, input.controlRef]) h01ReadPin(pin);
    const logs = [label + '-child.stdout', label + '-child.stderr'].map((name) =>
      join(input.evidenceRoot, name),
    );
    for (const path of logs)
      open.push(
        openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        ),
      );
    signal?.throwIfAborted();
    requireWorkflow(work > process.hrtime.bigint(), 'h01-keeper-work-deadline');
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        input.entrypoint.locator,
        '--' + label + '-child',
        input.request.locator,
        input.request.hash,
        input.controlRef.locator,
        input.controlRef.hash,
      ],
      { detached: true, stdio: ['ignore', open[0]!, open[1]!, 'ipc'] },
    );
    const owner = ownProcess(child, {
      now,
      deadline: Number(deadline / 1_000_000n),
      stopMs: Math.min(10000, Number((deadline - work) / 1_000_000n)),
      signal(pid, name) {
        forcedStop = true;
        process.kill(pid, name);
      },
    });
    owned = owner;
    const requestStop = () => {
      softStop = true;
      void owner.stop();
    };
    stop = requestStop;
    onMessage = (message) => {
      if (
        ready ||
        softStop ||
        signal?.aborted ||
        process.hrtime.bigint() >= work ||
        !isDeepStrictEqual(message, {
          kind: comparisonKind(scenario, 'owned-child-ready'),
          opId: input.opId,
          parentPid: process.pid,
          request: input.request,
          controlRef: input.controlRef,
        })
      ) {
        error = 'h01-keeper-ipc-binding';
        requestStop();
        return;
      }
      ready = true;
    };
    child.on('message', onMessage);
    timer = setTimeout(
      requestStop,
      Math.max(0, Number((work - process.hrtime.bigint()) / 1_000_000n)),
    );
    signal?.addEventListener('abort', requestStop, { once: true });
    if (signal?.aborted) requestStop();
    else
      child.send(
        {
          kind: comparisonKind(scenario, 'owned-child'),
          opId: input.opId,
          parentPid: process.pid,
          request: input.request,
          controlRef: input.controlRef,
        },
        (failure) => {
          if (failure !== null) {
            error = String(failure);
            requestStop();
          }
        },
      );
    observed = await owned.done;
    for (const path of logs) evidence.push({ locator: path, hash: digest(h01RawFile(path)) });
    if (observed.stopped) {
      const path = join(input.evidenceRoot, label + '-child-report.json'),
        bytes = h01RawFile(path),
        value = object(JSON.parse(bytes.toString('utf8')));
      requireWorkflow(
        value.kind === comparisonKind(scenario, 'execution-report') &&
          value.executionVersion === 2 &&
          value.opId === input.opId &&
          value.requestHash === h01RequestHash(request),
        'h01-keeper-report-binding',
      );
      report = { locator: path, hash: digest(bytes) };
      evidence.push(report);
    }
  } catch (failure) {
    error = String(failure);
    if (owned !== undefined) {
      softStop = true;
      observed = await owned.stop();
    }
  } finally {
    clearTimeout(timer);
    if (stop !== undefined) signal?.removeEventListener('abort', stop);
    if (child !== undefined && onMessage !== undefined) child.removeListener('message', onMessage);
    for (const fd of open) closeSync(fd);
  }
  const clean =
    observed?.stopped === true &&
    observed.signal === null &&
    !observed.deadlineReached &&
    !softStop &&
    !forcedStop &&
    ready &&
    error === undefined &&
    report !== undefined;
  const code = observed?.code;
  const outcome = clean ? (code === 0 ? 'completed' : 'failed') : 'unknown';
  const stopRef = h01Record(input.evidenceRoot, 'keeper-stop', {
    kind: label + '-keeper-stop',
    opId: input.opId,
    ...observed,
    notStarted: child === undefined,
    stopped: child === undefined || observed?.stopped === true,
    ready,
    softStop,
    forcedStop,
    error: error ?? null,
    evidence,
  });
  return {
    outcome,
    stop: stopRef,
    ...(report === undefined ? {} : { report }),
    evidence: [...evidence, stopRef],
  };
}
