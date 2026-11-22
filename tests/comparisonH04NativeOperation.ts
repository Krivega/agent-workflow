import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { historyFromJSON, historyToJSON } from '@temporalio/common/proto-utils';
import { defaultPayloadConverter, fromPayloadsAtIndex } from '@temporalio/common';
import { AppServerSessions } from '../adapters/codex/appServerSessions.js';
import { verifyComparisonMaterial } from '../adapters/project/comparisonInputs.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { object, requireWorkflow } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { artifactStore, publishFile } from '../src/adapters/artifacts/files.js';
import { effectJournal, lookupEffect } from '../src/adapters/artifacts/effects.js';
import { controlRef } from '../src/policy/readerControl.js';
import type { H01AttemptContext, H01BackendAdapter } from './comparisonH01Contract.js';
import { h01ReadJson, h01ReadPin, h01RawFile, h01Record } from './comparisonH01Contract.js';
import type { H01TemporalServices } from './comparisonH01Temporal.js';
import { checkNativeCase } from './comparisonH01.js';
import { createH02NativeRpc } from './comparisonH02NativeRpc.js';
import { h04BoundLegacy, h04BoundOperation } from './comparisonH04.js';
import {
  checkH04BoundOperation,
  h04BoundIntent,
  type H04OperationBinding,
} from './comparisonH04Contract.js';
import {
  h04Material,
  h04Scenario,
  h04PreparedMetadata,
  h04NativeBinding,
  h04NativeWaitCommand,
  h04NativeLaunchCode,
  h04NativeTerminalPath,
  h04NativeRecord,
  verifyH04NativeWait,
  type H04NativeOperationRequest,
  type H04NativeCaseReport,
} from './comparisonH04NativeContract.js';

function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function save(path: string, value: unknown): InputRef {
  const bytes = Buffer.from(canonical(value) + '\n');
  publishFile(path, bytes);
  return { locator: path, hash: digest(bytes) };
}

/** The series reads the same primary effect owners as the adapter; report booleans do not grant acceptance. */
export function verifyH04NativeRun(requestRef: InputRef, report: H04NativeCaseReport) {
  const request = object(h01ReadJson(requestRef)) as unknown as H04NativeOperationRequest;
  const binding = h04NativeBinding(request),
    p = report.primary;
  requireWorkflow(
    report.opId === request.opId &&
      report.engine === request.engine &&
      p.result !== null &&
      p.effectStart !== null &&
      p.gate !== null &&
      p.terminal !== null,
    'h04-native-primary-incomplete',
  );
  h01ReadPin(request.material);
  const failure = object(h01ReadJson(request.failure));
  requireWorkflow(
    failure.failed === true && failure.opId === request.opId,
    'h04-native-initial-failure',
  );
  const check = object(h01ReadJson(failure.evidence as InputRef)),
    stop = object(check.stop);
  requireWorkflow(
    check.kind === 'comparison-h04-check' &&
      check.opId === request.opId &&
      check.requestHash === request.requestHash &&
      same(check.material, request.material) &&
      check.cwd === request.workspace &&
      check.passed === false &&
      stop.stopped === true &&
      Number.isInteger(stop.code) &&
      Number(stop.code) > 0 &&
      stop.signal === null &&
      stop.killed === false &&
      stop.deadlineReached === false,
    'h04-native-primary-failure',
  );
  h01ReadPin(check.stdout as InputRef);
  h01ReadPin(check.stderr as InputRef);
  const bytes = h01ReadPin(p.result!);
  const operation = checkH04BoundOperation(binding, JSON.parse(bytes.toString()));
  const ref = { sha256: p.result!.hash, bytes: bytes.length };
  for (const stage of ['run'] as const) {
    const effect = lookupEffect(
      join(request.outputRoot, 'effects'),
      h04BoundIntent(binding, stage),
    );
    requireWorkflow(
      effect.status === 'completed' && same(effect.receipt, ref),
      'h04-native-effect',
    );
  }
  requireWorkflow(
    same(h01ReadJson(p.effectStart!), {
      operationId: binding.operationId,
      inputHash: binding.inputHash,
    }),
    'h04-native-effect-start',
  );
  for (const log of operation.logs)
    requireWorkflow(
      same(
        JSON.parse(
          h01ReadPin({
            locator: join(request.outputRoot, `log-${log.sequence}.json`),
            hash: digest(Buffer.from(JSON.stringify(log) + '\n')),
          }).toString(),
        ),
        log,
      ),
      'h04-native-log',
    );
  const gate = object(h01ReadJson(p.gate!)),
    notification = object(gate.notification),
    params = object(notification.params),
    item = object(params.item);
  requireWorkflow(
    gate.kind === 'comparison-h04-native-gate' &&
      gate.opId === request.opId &&
      notification.method === 'item/started' &&
      params.threadId === report.session &&
      item.type === 'commandExecution' &&
      item.command === h04NativeWaitCommand(request, requestRef),
    'h04-native-gate',
  );
  requireWorkflow(report.nativeWait !== null, 'h04-native-gate-wait');
  const nativeStarted = object(h04NativeRecord(report.nativeWait.started).payload);
  const nativeCompleted = object(h04NativeRecord(report.nativeWait.completed).payload);
  requireWorkflow(
    params.turnId === report.nativeWait.turn &&
      item.id === object(nativeStarted.item).id &&
      item.id === object(nativeCompleted.item).id &&
      Number.isSafeInteger(gate.atMs) &&
      Number.isSafeInteger(nativeCompleted.started_at_ms) &&
      Number.isSafeInteger(nativeCompleted.completed_at_ms) &&
      Number(gate.atMs) >= Number(nativeCompleted.started_at_ms) &&
      Number(gate.atMs) <= Number(nativeCompleted.completed_at_ms) &&
      Number(nativeCompleted.completed_at_ms) - Number(nativeCompleted.started_at_ms) >= 35000,
    'h04-native-gate-binding',
  );
  requireWorkflow(
    same(h01ReadJson(p.terminal!), {
      kind: 'comparison-h04-native-terminal',
      opId: request.opId,
      operationId: binding.operationId,
      inputHash: binding.inputHash,
      result: ref,
    }),
    'h04-native-terminal',
  );
  if (request.engine === 'temporal') {
    requireWorkflow(p.history !== null && p.workflow !== null, 'h04-native-sdk-incomplete');
    const history = historyFromJSON(h01ReadJson(p.history!)),
      workflow = object(h01ReadJson(p.workflow!));
    const events = history.events!;
    const only = (type: number) => {
      const found = events.filter((event) => event.eventType === type);
      requireWorkflow(found.length === 1, 'h04-native-sdk-count');
      return found[0]!;
    };
    const started = only(1).workflowExecutionStartedEventAttributes!,
      scheduled = only(10),
      completed = only(12).activityTaskCompletedEventAttributes!,
      finished = only(2).workflowExecutionCompletedEventAttributes!;
    const input = { operationId: binding.operationId, inputHash: binding.inputHash };
    requireWorkflow(
      workflow.workflowId === binding.operationId &&
        typeof workflow.runId === 'string' &&
        workflow.runId.length > 0 &&
        started.originalExecutionRunId === workflow.runId &&
        started.workflowType?.name === 'ComparisonH04Workflow' &&
        same(fromPayloadsAtIndex(defaultPayloadConverter, 0, started.input?.payloads), input),
      'h04-native-sdk-binding',
    );
    const activity = scheduled.activityTaskScheduledEventAttributes!;
    requireWorkflow(
      activity.activityType?.name === 'h04Operation' &&
        String(completed.scheduledEventId) === String(scheduled.eventId) &&
        same(fromPayloadsAtIndex(defaultPayloadConverter, 0, activity.input?.payloads), input),
      'h04-native-sdk-input',
    );
    for (const output of [completed.result, finished.result])
      requireWorkflow(
        same(fromPayloadsAtIndex(defaultPayloadConverter, 0, output?.payloads), ref),
        'h04-native-sdk-result',
      );
  } else {
    requireWorkflow(p.wait !== null, 'h04-native-legacy-wait-missing');
    const waited = object(h01ReadJson(p.wait!)),
      snapshot = object(waited.snapshot);
    requireWorkflow(
      waited.timed_out === false &&
        snapshot.status === 'completed' &&
        snapshot.run_id === binding.operationId &&
        snapshot.target_hash === binding.inputHash,
      'h04-native-legacy-wait',
    );
  }
  return { binding, result: ref, operation };
}
export function verifyH04NativePrimary(requestRef: InputRef, report: H04NativeCaseReport) {
  const primary = verifyH04NativeRun(requestRef, report),
    application = report.primary.application;
  requireWorkflow(
    application !== null &&
      same(h01ReadJson(application), {
        operationId: primary.binding.operationId,
        result: primary.result,
      }),
    'h04-native-application',
  );
  const effect = lookupEffect(
    join(primary.binding.outputRoot, 'effects'),
    h04BoundIntent(primary.binding, 'apply'),
  );
  requireWorkflow(
    effect.status === 'completed' && same(effect.receipt, primary.result),
    'h04-native-effect',
  );
  requireWorkflow(
    readdirSync(join(primary.binding.outputRoot, 'effects')).length === 4,
    'h04-native-effect-count',
  );
  return primary;
}

async function temporalOperation(
  ctx: H01AttemptContext,
  binding: H04OperationBinding,
  services: H01TemporalServices,
  saved: (label: string, value: unknown) => InputRef,
  report: H04NativeCaseReport,
  signal: AbortSignal,
) {
  const worker = await Worker.create({
    connection: services.nativeConnection,
    taskQueue: binding.operationId,
    workflowsPath: fileURLToPath(new URL('./comparisonH04Workflow.ts', import.meta.url)),
    maxConcurrentActivityTaskExecutions: 1,
    activities: {
      h04Operation: (input: unknown) => {
        requireWorkflow(
          same(input, { operationId: binding.operationId, inputHash: binding.inputHash }),
          'h04-native-activity-input',
        );
        signal.throwIfAborted();
        return h04BoundOperation(binding, signal);
      },
    },
  });
  return await worker.runUntil(async () => {
    ctx.signal.throwIfAborted();
    const handle = await services.client.workflow.start('ComparisonH04Workflow', {
      taskQueue: binding.operationId,
      workflowId: binding.operationId,
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [{ operationId: binding.operationId, inputHash: binding.inputHash }],
    });
    report.primary.workflow = saved('workflow', {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    });
    const result = controlRef(await handle.result());
    report.primary.history = saved(
      'history',
      JSON.parse(historyToJSON(await handle.fetchHistory())),
    );
    return result;
  });
}

export function createH04NativeAdapter(
  engine: 'legacy' | 'temporal',
  services?: H01TemporalServices,
): H01BackendAdapter {
  return {
    async execute(ctx) {
      requireWorkflow(
        ctx.criteria.value.id === 'H-04' &&
          ctx.variant === (engine === 'legacy' ? 'baseline' : 'candidate'),
        'h04-native-context',
      );
      const evidence: InputRef[] = [],
        saved = (label: string, value: unknown) => {
          const ref = h01Record(ctx.roots.evidenceRoot, 'h04-' + label, value);
          evidence.push(ref);
          return ref;
        };
      const report: H04NativeCaseReport = {
        kind: 'comparison-h04-case',
        scenario: 'H-04',
        opId: ctx.opId,
        engine,
        session: null,
        outcome: 'unknown',
        checks: Object.fromEntries(h04Scenario.checks.map((id) => [id, false])),
        blocking: [],
        request: null,
        nativeWait: null,
        primary: {
          result: null,
          application: null,
          effectStart: null,
          gate: null,
          history: null,
          workflow: null,
          terminal: null,
          wait: null,
        },
        stop: ctx.verifiedAuthorization,
        evidence,
        nativeAcceptance: false,
        qualification: false,
        partialScope: true,
      };
      const abort = new AbortController(),
        signal = AbortSignal.any([ctx.signal, abort.signal]);
      let operation: Promise<void> | null = null,
        request: H04NativeOperationRequest | null = null;
      let confirmedTurn: string | null = null;
      let candidateGate: Record<string, unknown> | null = null;
      let accepted: InputRef | null = null;
      const working = async () => {
        signal.throwIfAborted();
        await ctx.nativeObserver.verify();
        signal.throwIfAborted();
        if (report.request !== null) h01ReadPin(report.request);
      };
      const start = async (message: Record<string, unknown>) => {
        const params = object(message.params),
          item = object(params.item);
        requireWorkflow(
          request !== null &&
            report.request !== null &&
            operation === null &&
            params.threadId === report.session &&
            params.turnId === confirmedTurn &&
            item.type === 'commandExecution' &&
            item.command === h04NativeWaitCommand(request, report.request),
          'h04-native-start-gate',
        );
        report.primary.gate = saved('gate', {
          kind: 'comparison-h04-native-gate',
          opId: ctx.opId,
          atMs: Date.now(),
          atNs: process.hrtime.bigint().toString(),
          notification: message,
        });
        await working();
        const binding = h04NativeBinding(request);
        const result =
          engine === 'legacy'
            ? await h04BoundLegacy(binding, signal)
            : await temporalOperation(ctx, binding, services!, saved, report, signal);
        await working();
        if (engine === 'legacy') {
          const path = join(binding.outputRoot, 'wait.json');
          report.primary.wait = { locator: path, hash: digest(h01RawFile(path)) };
          evidence.push(report.primary.wait);
        }
        const store = artifactStore(join(binding.outputRoot, 'artifacts'), { existingOnly: true });
        const bytes = store.read(result);
        checkH04BoundOperation(binding, JSON.parse(bytes.toString()));
        report.primary.result = { locator: store.path(result), hash: result.sha256 };
        evidence.push(report.primary.result);
        report.primary.effectStart = {
          locator: join(binding.outputRoot, 'operation-start.json'),
          hash: digest(
            Buffer.from(
              JSON.stringify({ operationId: binding.operationId, inputHash: binding.inputHash }) +
                '\n',
            ),
          ),
        };
        report.primary.terminal = save(h04NativeTerminalPath(request), {
          kind: 'comparison-h04-native-terminal',
          opId: ctx.opId,
          operationId: binding.operationId,
          inputHash: binding.inputHash,
          result,
        });
        evidence.push(report.primary.effectStart, report.primary.terminal);
      };
      const startObserved = () => {
        const work = start(candidateGate!);
        operation = work;
        void work.catch((error: unknown) => {
          abort.abort(error);
        });
      };
      const port = createH02NativeRpc(ctx, 'h04-waiter', {
        stage: 'execution',
        observe(message) {
          if (message.method !== 'item/started') return;
          const item = object(object(message.params).item);
          if (item.type !== 'commandExecution') return;
          if (candidateGate !== null) {
            abort.abort(new Error('h04-native-duplicate-command'));
            return;
          }
          candidateGate = message;
          if (confirmedTurn !== null) startObserved();
        },
      });
      let stopped: Promise<InputRef> | undefined;
      const stopOnce = () => (stopped ??= port.stop());
      try {
        await working();
        await verifyComparisonMaterial(
          ctx.roots.workspaceRoot,
          {
            ...h04Material.files,
            ...h04PreparedMetadata(
              h01ReadPin(ctx.rules).toString(),
              h01ReadPin(ctx.executor).toString(),
            ),
          },
          [],
        );
        const checked = await checkNativeCase(ctx, 'h04-initial-check');
        requireWorkflow(checked.failed, 'h04-native-initial-check');
        const failure = saved('initial-failure', {
          kind: 'comparison-h04-initial-failure',
          opId: ctx.opId,
          failed: checked.failed,
          evidence: checked.evidence,
        });
        const waiter = ctx.runtime.files.find(
          (pin) => pin.locator === join(ctx.runtime.root, 'tests/comparisonH04NativeWait.mjs'),
        );
        requireWorkflow(
          waiter !== undefined && (engine === 'legacy' || services !== undefined),
          'h04-native-operation-unavailable',
        );
        h01ReadPin(waiter);
        const nodePath = realpathSync(process.execPath);
        const outputRoot = join(ctx.roots.evidenceRoot, 'h04-operation');
        mkdirSync(outputRoot, { mode: 0o700 });
        request = {
          kind: 'comparison-h04-native-operation',
          schemaVersion: 1,
          opId: ctx.opId,
          requestHash: ctx.requestHash,
          material: ctx.material.ref,
          failure,
          engine,
          operationId: 'h04-' + digest(ctx.opId).slice(0, 32),
          outputRoot,
          workspace: ctx.roots.workspaceRoot,
          deadlineNs: ctx.workDeadlineNs,
          node: { locator: nodePath, hash: digest(h01RawFile(nodePath)) },
          waiter,
        };
        mkdirSync(join(ctx.roots.workspaceRoot, 'evidence'), { mode: 0o700, recursive: true });
        report.request = save(
          join(ctx.roots.workspaceRoot, 'evidence/h04-operation-request.json'),
          request,
        );
        evidence.push(report.request, failure, checked.evidence);
        const sessions = new AppServerSessions(
          port.rpc,
          ctx.roots.workspaceRoot,
          'h04-' + digest(ctx.opId).slice(0, 16),
          ctx.roots.evidenceRoot,
          null,
        );
        const session = await sessions.create({
          model: ctx.profile.model,
          effort: ctx.profile.effort,
          reason: 'H04 read-only waiting turn',
        });
        report.session = session.id;
        const turn = await sessions.send(
          session,
          'Read-only H04. The owning host starts and applies the authorized operation. Copy exactly the following single code-mode launch:\n' +
            h04NativeLaunchCode(request, report.request) +
            '\nUse its observed session_id in exactly one code-mode call: text(await tools.write_stdin({"session_id":<observed integer>,"chars":"","yield_time_ms":60000,"max_output_tokens":2000}));\nNo other tools, model polling, writes or permission changes. Stay in this turn until terminal exit. If unavailable, report NOT RUN; never retry.\n' +
            canonical({
              rules: h01ReadPin(ctx.rules).toString(),
              executor: h01ReadPin(ctx.executor).toString(),
              material: h04Material.instructions,
            }),
          ctx.opId + ':wait',
        );
        confirmedTurn = turn;
        if (candidateGate !== null) startObserved();
        await port.rpc.completed(session.id, turn, signal, working);
        await working();
        const pendingOperation = operation as Promise<void> | null;
        requireWorkflow(pendingOperation !== null, 'h04-native-wait-not-started');
        await pendingOperation;
        const participants = ctx.nativeObserver
          .accounting()
          .participants.filter((p) => p.session === session.id && p.run === ctx.opId);
        requireWorkflow(
          participants.length === 1 && report.primary.terminal !== null,
          'h04-native-participant',
        );
        report.nativeWait = verifyH04NativeWait(
          report.request,
          participants[0]!,
          report.primary.terminal!,
        );
        report.stop = await stopOnce();
        const stoppedPrimary = object(h01ReadJson(report.stop));
        requireWorkflow(
          stoppedPrimary.kind === 'comparison-h04-stop' &&
            stoppedPrimary.opId === ctx.opId &&
            stoppedPrimary.confirmed === true &&
            stoppedPrimary.readersStopped === true &&
            stoppedPrimary.transportClosed === true &&
            same(stoppedPrimary.sessions, [report.session]) &&
            same(stoppedPrimary.remainingProcesses, []) &&
            !ctx.signal.aborted,
          'h04-native-stop-before-apply',
        );
        await verifyComparisonMaterial(
          ctx.roots.workspaceRoot,
          {
            ...h04Material.files,
            ...h04PreparedMetadata(
              h01ReadPin(ctx.rules).toString(),
              h01ReadPin(ctx.executor).toString(),
            ),
          },
          [],
        );
        await working();
        requireWorkflow(
          process.hrtime.bigint() < BigInt(ctx.workDeadlineNs),
          'h04-native-apply-deadline',
        );
        for (const [path, content] of Object.entries({
          ...h04Material.files,
          ...h04PreparedMetadata(
            h01ReadPin(ctx.rules).toString(),
            h01ReadPin(ctx.executor).toString(),
          ),
        }))
          requireWorkflow(
            h01RawFile(join(ctx.roots.workspaceRoot, path)).equals(Buffer.from(content)),
            'h04-native-immutable-before-apply',
          );
        verifyH04NativeRun(report.request, report);
        requireWorkflow(
          readdirSync(join(request.outputRoot, 'effects')).length === 2,
          'h04-native-before-apply',
        );
        const binding = h04NativeBinding(request),
          resultBytes = h01ReadPin(report.primary.result!);
        const result = { sha256: report.primary.result!.hash, bytes: resultBytes.length };
        await effectJournal(join(binding.outputRoot, 'effects')).execute(
          h04BoundIntent(binding, 'apply'),
          async () => {
            report.primary.application = save(join(binding.outputRoot, 'applied.json'), {
              operationId: binding.operationId,
              result,
            });
            return result;
          },
        );
        evidence.push(report.primary.application!);
        // Legacy wait receipt is pinned after its real await; the gate observation itself stays immutable.
        verifyH04NativePrimary(report.request, report);
        accepted = saved('acceptance', {
          kind: 'comparison-h04-native-acceptance',
          opId: ctx.opId,
          request: report.request,
          proof: report.nativeWait,
          primary: report.primary,
          qualification: false,
        });
        const manifest = save(join(ctx.roots.workspaceRoot, 'evidence/manifest.json'), {
          sources: [failure, report.primary.result, report.primary.application, accepted],
          initial_failure: 'F-01',
        });
        evidence.push(manifest);
        report.checks = Object.fromEntries(h04Scenario.checks.map((id) => [id, true]));
        report.outcome = 'accepted';
      } catch (error) {
        report.blocking.push(error instanceof Error ? error.message : String(error));
        if (report.request === null) report.outcome = 'not-run';
      } finally {
        abort.abort(new Error('h04-native-cleanup'));
        await (operation as Promise<void> | null)?.catch(() => undefined);
        report.stop = await stopOnce();
        const stop = object(h01ReadJson(report.stop));
        if (stop.confirmed !== true || ctx.signal.aborted) {
          report.outcome = 'unknown';
          report.blocking.push('h04-native-stop-unconfirmed');
        }
      }
      evidence.push(...port.evidence);
      const caseReport = saved('case', report);
      const projection = saved('projection', {
        kind: 'comparison-h04-native-projection',
        scenario: 'H-04',
        opId: ctx.opId,
        engine,
        caseReport,
      });
      return {
        outcome: report.outcome === 'accepted' ? 'completed' : 'unknown',
        evidence,
        stop: report.stop,
        projection,
        nativeAcceptance: accepted,
      };
    },
  };
}
