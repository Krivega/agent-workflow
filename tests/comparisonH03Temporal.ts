import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import proto from '@temporalio/proto';
import type { CodexRpc } from '../src/contracts/codex.js';
import type { ArtifactRef, LocalProjectRegistration } from '../src/contracts/preparation.js';
import type { ReaderStatus } from '../src/contracts/readerControl.js';
import {
  artifactStore,
  readPrivateFile,
  readProjectFile,
} from '../src/adapters/artifacts/files.js';
import { effectJournal, lookupEffect } from '../src/adapters/artifacts/effects.js';
import { nativeReaderAuthority } from '../src/adapters/codex/readerAuthority.js';
import { readerBoundary } from '../src/adapters/codex/readerBoundary.js';
import { readerExecution } from '../src/policy/readerExecution.js';
import {
  parseReaderCommand,
  parseReaderInput,
  readerKey,
  readerTarget,
} from '../src/policy/readerControl.js';
import { readerActivities } from '../src/activities/reader.js';
import { preparationActivities } from '../src/activities/preparation.js';
import { createReaderHost } from '../src/worker/readerHost.js';
import { captureTaskBudget } from '../src/worker/taskBudget.js';
import { startControlledReader, controlReader } from '../src/client/reader.js';
import { bindTaskBackendClient } from '../src/client/taskBackend.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import type {
  H01BackendAdapter,
  H01ModelStart,
  H01VerifiedAuthorization,
} from './comparisonH01Contract.js';
import { h01ReadJson, h01ReadPin, h01Record } from './comparisonH01Contract.js';
import type { H01TemporalServices } from './comparisonH01Temporal.js';
import { createH02NativeRpc } from './comparisonH02NativeRpc.js';
import {
  h03ReaderInput,
  h03NativeCommands,
  h03NativeSource,
  h03PreparedMetadata,
  publishH03Context,
  type H03CaseReport,
} from './comparisonH03Contract.js';
import { checkNativeCase } from './comparisonH01.js';

/** Assembly only. A separately completed human issuance must precede any native start. */
export function createH03TemporalAdapter(services: H01TemporalServices): H01BackendAdapter {
  return {
    async execute(ctx) {
      requireWorkflow(ctx.criteria.value.id === 'H-03', 'h03-temporal-scenario');
      const store = artifactStore(ctx.roots.artifactRoot, { existingOnly: true });
      const evidence: InputRef[] = [],
        workflowEvidence: InputRef[] = [],
        readerStops: InputRef[] = [];
      const saved = (label: string, value: unknown) => {
        const ref = h01Record(ctx.roots.evidenceRoot, 'h03-' + label, value);
        evidence.push(ref);
        return ref;
      };
      const source = (ref: ArtifactRef): InputRef => ({
        locator: store.path(ref),
        hash: ref.sha256,
      });
      const data = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString('utf8')));
      const artifacts = (kind: string) =>
        readdirSync(ctx.roots.artifactRoot)
          .filter((name) => /^[a-f0-9]{64}$/u.test(name))
          .flatMap((name) => {
            const bytes = h01ReadPin({ locator: join(ctx.roots.artifactRoot, name), hash: name });
            try {
              const value = object(JSON.parse(bytes.toString('utf8')));
              return value.kind === kind
                ? [{ ref: { sha256: name, bytes: bytes.length }, value }]
                : [];
            } catch {
              return [];
            }
          });
      const input = h03ReaderInput(ctx);
      const registration: LocalProjectRegistration = {
        project: input.preparation.project,
        hostId: input.preparation.hostId,
        owner: input.preparation.owner,
        generation: input.preparation.generation,
        workspaceRoot: ctx.roots.workspaceRoot,
        artifactRoot: ctx.roots.artifactRoot,
        commands: {
          syntax: { executable: process.execPath, args: ['--check', 'checks.mjs'] },
          validate: { executable: process.execPath, args: ['checks.mjs'] },
        },
      };
      const checks = Object.fromEntries(ctx.criteria.value.checks.map((check) => [check, false]));
      const probes: Record<
        string,
        { basis: InputRef; observed: InputRef; error: string; refused: boolean }
      > = {};
      const initial: { load: InputRef | null; state: InputRef | null } = {
        load: null,
        state: null,
      };
      const recovered: typeof initial = { load: null, state: null };
      const retained: {
        failure: InputRef | null;
        pending: InputRef | null;
        before: InputRef | null;
        after: InputRef | null;
      } = {
        failure: null,
        pending: null,
        before: null,
        after: null,
      };
      const compaction: H03CaseReport['compaction'] = {
        before: null,
        request: null,
        boundary: null,
        receipt: null,
        usage: [],
      };
      let port: ReturnType<typeof createH02NativeRpc> | undefined,
        handle: Awaited<ReturnType<typeof startControlledReader>> | undefined,
        budget: ArtifactRef | null = null,
        session: string | null = null,
        transcript: string | null = null,
        compacted = false,
        hostFinished = false,
        failure: string | null = null,
        issued = false,
        physicalStop: InputRef | null = null;
      let context: InputRef | null = null;
      const starts: { method: string; params: Record<string, unknown> }[] = [];
      const working = () => {
        ctx.signal.throwIfAborted();
        requireWorkflow(
          BigInt(ctx.workDeadlineNs) > process.hrtime.bigint(),
          'h03-temporal-work-deadline',
        );
      };
      const startForTurn = async (params: Record<string, unknown>): Promise<H01ModelStart> => {
        working();
        const captured = captureTaskBudget(join(ctx.roots.hostRoot, 'turn-credits'), store, budget);
        budget = captured.manifest;
        const credits = data(captured.manifest).credits,
          hash = digest(JSON.stringify(params));
        requireWorkflow(
          captured.limit === ctx.budget.maxManagedStarts && Array.isArray(credits),
          'h03-temporal-credit-limit',
        );
        const matches = credits.map(object).filter((credit) => credit.hash === hash);
        requireWorkflow(matches.length === 1, 'h03-temporal-credit-ambiguous');
        return {
          origin: 'temporal-host',
          key: textField(matches[0]!.key),
          hash,
          session: textField(params.threadId),
          stage: 'execution',
        };
      };
      const native: CodexRpc = {
        async request(method, params) {
          requireWorkflow(port !== undefined, 'h03-temporal-port-unavailable');
          if (method === 'thread/read' && !compacted && session !== null) {
            const loads = artifacts('reader-load').filter((row) => row.value.session === session);
            if (loads.length === 1) {
              initial.load = source(loads[0]!.ref);
              requireWorkflow(
                transcript !== null && port.compact !== undefined,
                'h03-native-compact-unavailable',
              );
              compacted = true;
              await port.compact(
                new FileCurrentChatHost(ctx.roots.workspaceRoot, transcript, {
                  thread_id: session,
                  turn_id: textField(object(loads[0]!.value.observed).id),
                  workspace: ctx.roots.workspaceRoot,
                  host_id: 'local',
                }),
              );
              requireWorkflow(
                port.compactionEvidence !== undefined && port.compactionEvidence !== null,
                'h03-native-compaction-primary-missing',
              );
              const proof = object(h01ReadJson(port.compactionEvidence));
              requireWorkflow(
                proof.kind === 'comparison-native-compaction' &&
                  proof.scenario === 'H-03' &&
                  proof.opId === ctx.opId &&
                  proof.session === session,
                'h03-native-compaction-binding',
              );
              compaction.before = proof.before as InputRef;
              compaction.request = proof.request as InputRef;
              compaction.boundary = proof.boundary as InputRef;
              compaction.receipt = port.compactionEvidence;
              requireWorkflow(Array.isArray(proof.usage), 'h03-native-compaction-usage');
              compaction.usage = proof.usage as InputRef[];
              evidence.push(port.compactionEvidence);
            }
          }
          const result = await port.rpc.request(method, params);
          if (method === 'thread/start' || method === 'turn/start') starts.push({ method, params });
          if (method === 'thread/start') {
            requireWorkflow(session === null, 'h03-native-session-replaced');
            session = textField(object(object(result).thread).id);
            transcript = textField(object(object(result).thread).path);
          }
          return result;
        },
        completed(id, turn, signal) {
          requireWorkflow(port !== undefined, 'h03-temporal-port-unavailable');
          return port.rpc.completed(id, turn, signal);
        },
      };
      const abort = () => {
        if (handle !== undefined)
          void services.client.connection
            .withDeadline(
              Date.now() +
                Math.max(1, Number(BigInt(ctx.deadlineNs) - process.hrtime.bigint()) / 1e6),
              () => handle!.cancel(),
            )
            .catch(() => {});
      };
      const status = async (accept: (value: ReaderStatus) => boolean) => {
        for (;;) {
          working();
          const value = await handle!.query<ReaderStatus>('readerStatus');
          working();
          if (accept(value)) return value;
          requireWorkflow(
            value.mode !== 'answered' && value.mode !== 'cancelled',
            'h03-temporal-unexpected-terminal',
          );
          await delay(20, undefined, { signal: ctx.signal });
        }
      };
      try {
        working();
        requireWorkflow(ctx.bootstrap.engine === 'temporal', 'h03-temporal-bootstrap');
        requireWorkflow(
          ctx.bootstrap.taskQueue === services.taskQueue &&
            ctx.bootstrap.workflowsPath === services.workflowsPath,
          'h03-temporal-service-binding',
        );
        requireWorkflow(
          ctx.bootstrap.namespace === 'default' &&
            services.client.options.namespace === ctx.bootstrap.namespace &&
            object(object(services.client.connection).options).address === ctx.bootstrap.address,
          'h03-temporal-service-binding',
        );
        for (const [path, text] of Object.entries(
          h03PreparedMetadata(
            h01ReadPin(ctx.rules).toString('utf8'),
            h01ReadPin(ctx.executor).toString('utf8'),
          ),
        ))
          requireWorkflow(
            readProjectFile(ctx.roots.workspaceRoot, path).equals(Buffer.from(text)),
            'h03-temporal-metadata-changed',
          );
        const authority = nativeReaderAuthority(store, ctx.bootstrap.issuer);
        const authorization = h01ReadJson(ctx.verifiedAuthorization) as H01VerifiedAuthorization;
        requireWorkflow(
          authorization.opId === ctx.opId &&
            authorization.requestHash === ctx.requestHash &&
            authorization.variant === ctx.variant &&
            canonical(authorization.budget) === canonical(ctx.budget) &&
            canonical(authorization.issuer) === canonical(ctx.bootstrap.issuer),
          'h03-temporal-authorization-binding',
        );
        const commandSource = store.publish(
          Buffer.from(JSON.stringify(h03NativeSource(authorization))),
        );
        const commands = h03NativeCommands(ctx, commandSource);
        for (const command of [commands.pause, commands.resume]) {
          const verified = await authority.verify(command);
          requireWorkflow(verified.origin === 'human', 'h03-recovery-human-required');
          evidence.push(source(verified.proof));
        }
        issued = true;
        await ctx.nativeObserver.verify();
        working();
        const initialCheck = await checkNativeCase(ctx, 'h03-initial-check');
        requireWorkflow(initialCheck.failed === true, 'h03-initial-failure-missing');
        retained.failure = initialCheck.evidence;
        evidence.push(initialCheck.evidence);
        const intent = {
          projectId: input.preparation.project.projectId,
          taskId: input.preparation.taskId,
          operationId: 'h03-unfinished',
          requestHash: digest(canonical({ opId: ctx.opId, material: ctx.material.ref })),
          hostId: input.preparation.hostId,
          workspaceId: input.preparation.project.workspaceId,
          owner: input.preparation.owner,
          generation: input.preparation.generation,
        };
        const pendingRoot = join(ctx.roots.hostRoot, 'h03-pending'),
          journal = effectJournal(pendingRoot);
        try {
          await journal.execute(intent, async () => {
            throw new Error('h03-pending-result-unavailable');
          });
        } catch (error) {
          requireWorkflow(
            error instanceof Error && error.message === 'h03-pending-result-unavailable',
            'h03-pending-setup-unknown',
          );
        }
        const pendingPath = join(
          pendingRoot,
          digest(JSON.stringify([intent.projectId, intent.taskId, intent.operationId])),
        );
        retained.pending = { locator: pendingPath, hash: digest(readPrivateFile(pendingPath)) };
        const before = lookupEffect(pendingRoot, intent);
        requireWorkflow(before.status === 'pending', 'h03-pending-not-retained');
        retained.before = saved('retained-before', {
          failure: retained.failure,
          pending: retained.pending,
          intent,
          state: before,
        });
        context = publishH03Context(ctx, retained.failure, retained.pending);
        h01ReadPin(context);
        evidence.push(context);
        port = createH02NativeRpc(ctx, 'temporal-executor', { stage: 'execution', startForTurn });
        bindTaskBackendClient(services.client, registration);
        const host = await createReaderHost(
          services.nativeConnection,
          services.taskQueue,
          services.workflowsPath,
          [{ registration, rpc: native, authority }],
          ctx.profile,
          ctx.roots.hostRoot,
          ctx.budget.maxManagedStarts,
        );
        ctx.signal.addEventListener('abort', abort, { once: true });
        await host.runUntil(async () => {
          working();
          handle = await startControlledReader(services.client, input, services.taskQueue);
          if (ctx.signal.aborted) {
            abort();
            working();
          }
          const blocked = await status(
            (value) =>
              value.mode === 'blocked' && value.error.includes('reader-context-compacted:'),
          );
          requireWorkflow(
            blocked.session === session &&
              blocked.phase === 'answering' &&
              blocked.attempt === 0 &&
              blocked.revision === 0 &&
              initial.load !== null,
            'h03-stale-load-refusal-unbound',
          );
          initial.state = saved('initial-state', blocked);
          const invalidation = blocked.error.match(/reader-context-compacted:([a-f0-9]{64})/u);
          requireWorkflow(invalidation !== null, 'h03-compacted-proof-missing');
          const invalidated = artifacts('reader-compacted-context').find(
            (row) => row.ref.sha256 === invalidation[1],
          );
          requireWorkflow(
            invalidated !== undefined && invalidated.value.session === session,
            'h03-compacted-proof-unbound',
          );
          evidence.push(source(invalidated.ref));
          const initialLoad = data({
            sha256: initial.load.hash,
            bytes: h01ReadPin(initial.load).length,
          });
          const prepared = initialLoad.prepared as { status: 'prepared'; manifest: ArtifactRef };
          const created = artifacts('reader-session').filter(
            (row) => object(object(row.value.response).thread).id === session,
          );
          requireWorkflow(
            created.length === 1 && blocked.permit !== null,
            'h03-reader-primary-missing',
          );
          const reader = { id: session!, creation: created[0]!.ref };
          const gate = readerBoundary(
            join(ctx.roots.hostRoot, digest(input.preparation.project.projectId), 'permissions'),
            store,
            ctx.roots.workspaceRoot,
            readerExecution(ctx.profile),
          );
          const epoch = {
            permit: blocked.permit,
            revision: blocked.revision,
            attempt: blocked.attempt,
          };
          const models = readerActivities(
            registration,
            native,
            ctx.profile,
            join(ctx.roots.hostRoot, digest(input.preparation.project.projectId), 'effects'),
            gate.boundary,
          );
          const probe = async (
            name: string,
            value: unknown,
            expected: string,
            run: () => unknown | Promise<unknown>,
          ) => {
            working();
            const basis = saved('probe-' + name + '-basis', value),
              count = starts.length;
            let error = '';
            try {
              await run();
            } catch (failure) {
              error = String(failure);
            }
            working();
            const observed = saved('probe-' + name + '-owner', {
              kind: 'comparison-h03-probe-observation',
              probe: name,
              basis,
              error,
              state: gate.inspect(input),
              beforeStarts: count,
              afterStarts: starts.length,
            });
            probes[name] = {
              basis,
              observed,
              error,
              refused: error.includes(expected) && count === starts.length,
            };
          };
          const missing = structuredClone(input);
          missing.preparation.project.rules = missing.preparation.project.rules.slice(1);
          await probe(
            'missing-rule',
            { registration, input: missing },
            'project-registration-mismatch',
            () => preparationActivities(registration).prepareProject(missing.preparation),
          );
          const path = input.preparation.project.rules[0]!,
            original = readProjectFile(ctx.roots.workspaceRoot, path);
          try {
            const changed = Buffer.concat([original, Buffer.from('\n')]);
            writeFileSync(join(ctx.roots.workspaceRoot, path), changed);
            const version = (bytes: Buffer) => ({
              path,
              sha256: digest(bytes),
              bytes: bytes.length,
              content: source(store.publish(bytes)),
            });
            await probe(
              'stale-source',
              { prepared, load: initial.load, before: version(original), after: version(changed) },
              'reader-input-changed',
              () =>
                models.answerReader(
                  input,
                  prepared,
                  reader,
                  { sha256: initial.load!.hash, bytes: h01ReadPin(initial.load!).length },
                  epoch,
                ),
            );
          } finally {
            writeFileSync(join(ctx.roots.workspaceRoot, path), original);
          }
          const wrong = { ...input, roleId: 'not-executor' };
          await probe('wrong-role', wrong, 'reader-role-not-declared', () =>
            parseReaderInput(wrong),
          );
          const action = { ...commands.resume, action: 'write' };
          await probe('new-action', action, 'reader-command-action-invalid', () =>
            parseReaderCommand(action),
          );
          requireWorkflow(
            Object.values(probes).every((probe) => probe.refused),
            'h03-context-probe-not-refused',
          );
          await controlReader(services.client, readerKey(input), commands.pause);
          const paused = await status((value) => value.mode === 'paused');
          requireWorkflow(
            paused.revision === 1 && paused.attempt === 0 && paused.session === session,
            'h03-pause-unconfirmed',
          );
          evidence.push(saved('paused-state', paused));
          await controlReader(services.client, readerKey(input), commands.resume);
          working();
          const result = await handle!.result();
          working();
          requireWorkflow(result.status === 'answered', 'h03-reader-not-answered');
          const answer = data(result.answer);
          requireWorkflow(answer.session === session, 'h03-recovery-session-mismatch');
          const loads = artifacts('reader-load').filter(
            (row) => row.value.session === session && row.ref.sha256 !== initial.load!.hash,
          );
          requireWorkflow(loads.length === 1, 'h03-fresh-load-missing');
          recovered.load = source(loads[0]!.ref);
          const final = await handle!.query<ReaderStatus>('readerStatus');
          requireWorkflow(
            final.mode === 'answered' &&
              final.revision === 2 &&
              final.attempt === 1 &&
              final.session === session,
            'h03-recovery-state-unconfirmed',
          );
          recovered.state = saved('recovered-state', final);
          const description = await handle!.describe(),
            history = await handle!.fetchHistory();
          requireWorkflow(description.status.name === 'COMPLETED', 'h03-workflow-not-completed');
          const historyRef = saved('reader-history', {
            kind: 'comparison-h03-reader-history',
            scenario: 'H-03',
            opId: ctx.opId,
            workflowId: handle!.workflowId,
            runId: description.runId,
            history: proto.temporal.api.history.v1.History.fromObject(history).toJSON(),
          });
          workflowEvidence.push(
            saved('reader-workflow', {
              kind: 'comparison-h03-reader-workflow-proof',
              scenario: 'H-03',
              opId: ctx.opId,
              workflowId: handle!.workflowId,
              runId: description.runId,
              status: description.status.name,
              input,
              history: historyRef,
              result,
              initial: initial.state,
              recovered: recovered.state,
              commands,
            }),
          );
        });
        hostFinished = true;
        h01ReadPin(context);
        const stops = artifacts('reader-stop').filter(
          (row) =>
            canonical(row.value.target) === canonical(readerTarget(input, readerKey(input))) &&
            row.value.confirmed === true,
        );
        readerStops.push(...stops.map((row) => source(row.ref)));
        evidence.push(...readerStops);
        requireWorkflow(
          stops.some((row) => row.value.minimumRevision === 1) &&
            stops.some((row) => row.value.minimumRevision === 3),
          'h03-reader-stop-unconfirmed',
        );
        working();
        let repeated = false,
          pendingError = '';
        try {
          await journal.execute(
            intent,
            async () => {
              repeated = true;
              throw new Error('h03-forbidden-product-dispatch');
            },
            async () => null,
          );
        } catch (error) {
          pendingError = String(error);
        }
        const after = lookupEffect(pendingRoot, intent);
        h01ReadPin(retained.pending!);
        h01ReadPin(retained.failure!);
        retained.after = saved('retained-after', {
          failure: retained.failure,
          pending: retained.pending,
          intent,
          state: after,
          repeated,
          error: pendingError,
        });
        checks['real-compaction'] = compaction.boundary !== null && compacted;
        checks['fresh-observed-read'] =
          recovered.load !== null && initial.load?.hash !== recovered.load.hash;
        checks['mandatory-rules'] = probes['missing-rule']!.refused;
        checks['invalid-context-refused'] =
          initial.state !== null && Object.values(probes).every((probe) => probe.refused);
        checks['full-load-recovery'] =
          recovered.state !== null &&
          starts.filter((call) => call.method === 'thread/start').length === 1 &&
          starts.filter((call) => call.method === 'turn/start').length === 3;
        checks['pending-preserved'] =
          after.status === 'pending' &&
          !repeated &&
          pendingError.includes('effect-outcome-unknown');
        mkdirSync(join(ctx.roots.workspaceRoot, 'evidence'), { recursive: true, mode: 0o700 });
        writeFileSync(
          join(ctx.roots.workspaceRoot, 'evidence/manifest.json'),
          JSON.stringify({
            sources: [
              initial.load,
              compaction.receipt,
              recovered.load,
              retained.failure,
              retained.pending,
            ],
            initial_failure: 'F-01',
          }) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        ctx.signal.removeEventListener('abort', abort);
        if (port !== undefined) {
          try {
            physicalStop = await port.stop();
          } catch (error) {
            failure ??= String(error);
          }
          evidence.push(...port.evidence);
        }
      }
      const physical = physicalStop === null ? null : object(h01ReadJson(physicalStop));
      const remainingProcesses = physical === null ? null : physical.remainingProcesses;
      const confirmed =
        hostFinished &&
        physical !== null &&
        physical.kind === 'comparison-h03-stop' &&
        physical.opId === ctx.opId &&
        physical.confirmed === true &&
        Array.isArray(remainingProcesses) &&
        remainingProcesses.length === 0;
      const stop = saved('temporal-stop', {
        kind: 'comparison-h03-stop',
        executionVersion: 2,
        opId: ctx.opId,
        confirmed,
        sessions: session === null ? [] : [session],
        remainingProcesses,
        evidence: [...readerStops, ...(physicalStop === null ? [] : [physicalStop])],
        hostFinished,
      });
      const blocking = [
        ...Object.entries(checks)
          .filter(([, pass]) => !pass)
          .map(([check]) => check),
        ...(failure === null ? [] : [failure]),
        ...(!confirmed ? ['h03-stop-unconfirmed'] : []),
        ...(ctx.signal.aborted ? ['h03-cancelled'] : []),
      ];
      const accepted = blocking.length === 0;
      const report: H03CaseReport = {
        kind: 'comparison-h03-case',
        scenario: 'H-03',
        opId: ctx.opId,
        engine: 'temporal',
        session,
        context,
        outcome: accepted ? 'accepted' : issued ? 'unknown' : 'not-run',
        checks,
        blocking,
        initial,
        compaction,
        probes,
        recovered,
        retained,
        stop,
        evidence,
        nativeAcceptance: false,
        qualification: false,
        partialScope: true,
      };
      const caseReport = saved('temporal-case', report);
      const projection = saved('temporal-projection', {
        kind: 'comparison-h03-native-projection',
        scenario: 'H-03',
        opId: ctx.opId,
        engine: 'temporal',
        sdk: true,
        caseReport,
        workflowEvidence,
      });
      return {
        outcome: accepted ? 'completed' : 'unknown',
        evidence,
        stop,
        projection,
        nativeAcceptance: accepted ? recovered.load : null,
      };
    },
  };
}
