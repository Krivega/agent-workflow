import { supportedTaskClient } from '../src/policy/readerExecution.js';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Client } from '@temporalio/client';
import type { NativeConnection } from '@temporalio/worker';
import { StdioAppServer } from '../adapters/codex/appServerTransport.js';
import { TransportJournal } from '../adapters/codex/transportJournal.js';
import { comparisonParticipants } from '../adapters/codex/comparisonParticipants.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  readPrivateFile,
  safeDirectory,
  writePrivateFile,
} from '../adapters/storage/storeFiles.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { nativeReaderAuthority } from '../src/adapters/codex/readerAuthority.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import { createReaderHost } from '../src/worker/readerHost.js';
import { captureTaskBudget } from '../src/worker/taskBudget.js';
import { startLocalTask } from '../src/client/localTask.js';
import { bindTaskBackendClient } from '../src/client/taskBackend.js';
import { localPlanningRisks } from '../src/policy/localPlanning.js';
import { taskAdmissionIdentity } from '../src/policy/taskRecovery.js';
import type { NativeTaskInput } from '../src/contracts/localTask.js';
import type { ArtifactRef } from '../src/contracts/preparation.js';
import type { ProcessIdentity } from '../src/contracts/writerProcesses.js';
import { h01ReadPin, h01TaskPaths } from './comparisonH01Contract.js';
import type {
  H01BackendAdapter,
  H01BackendResult,
  H01NativeObservation,
  H01ModelStart,
  H01StopObservation,
} from './comparisonH01Contract.js';

export interface H01TemporalServices {
  client: Client;
  nativeConnection: NativeConnection;
  taskQueue: string;
  workflowsPath: string;
}
const entrypoint = fileURLToPath(import.meta.url);
const readerHostSource = fileURLToPath(new URL('../src/worker/readerHost.ts', import.meta.url));
const transportSource = fileURLToPath(
  new URL('../adapters/codex/appServerTransport.ts', import.meta.url),
);

/** Repository assembly; importing or constructing the adapter starts no Worker or native process. */
export function createH01TemporalAdapter(services: H01TemporalServices): H01BackendAdapter {
  return {
    async execute(ctx): Promise<H01BackendResult> {
      const store = artifactStore(ctx.roots.artifactRoot, {
        existingOnly: true,
      });
      const evidence: InputRef[] = [];
      function saved(value: unknown) {
        const ref = store.publish(Buffer.from(JSON.stringify(value)));
        const result = {
          locator: join(ctx.roots.artifactRoot, ref.sha256),
          hash: ref.sha256,
        };
        evidence.push(result);
        return result;
      }
      function artifact(value: unknown) {
        const raw = object(value),
          ref = { sha256: textField(raw.sha256), bytes: Number(raw.bytes) };
        const bytes = store.read(ref);
        const source = {
          locator: join(ctx.roots.artifactRoot, ref.sha256),
          hash: ref.sha256,
        };
        evidence.push(source);
        return {
          ref,
          source,
          value: object(JSON.parse(bytes.toString('utf8'))),
        };
      }
      const processes = new NativeWriterProcesses();
      const ports: {
        rpc: StdioAppServer;
        root: string;
        stage: 'execution' | 'council';
        initial: Promise<ProcessIdentity[]>;
        sessions: Set<string>;
        journal: string;
        stopped: boolean;
        close(): void;
      }[] = [];
      const participants = new Set<string>();
      const creations = new Map<
        string,
        {
          creation: InputRef;
          stage: 'execution' | 'council';
          root: string;
          transcript: string | null;
        }
      >();
      const stopErrors: string[] = [];
      const remainingProcesses: ProcessIdentity[] = [];
      let hostAttempted = false,
        hostFinished = false,
        creationPending = false;
      let budget: ArtifactRef | null = null,
        taskStop: ArtifactRef | null = null;
      let nativeAcceptance: InputRef | null = null;
      let ready: InputRef | undefined;
      let projection: InputRef | undefined;
      let outcome: H01BackendResult['outcome'] = 'unknown';
      let stopping = false;
      let handle: Awaited<ReturnType<typeof startLocalTask>> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let cancellation: Promise<unknown> | undefined;
      let abortReject!: (reason: Error) => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        abortReject = reject;
      });
      void interrupted.catch(() => {});
      let stopReject!: (reason: Error) => void;
      const stopExpired = new Promise<never>((_resolve, reject) => {
        stopReject = reject;
      });
      void stopExpired.catch(() => {});
      const remaining = (deadline: string) =>
        Math.floor(Number(BigInt(deadline) - process.hrtime.bigint()) / 1_000_000);
      const cleanup = <T>(promise: Promise<T>) => Promise.race([promise, stopExpired]);
      const abort = () => {
        stopping = true;
        if (handle !== undefined) {
          const cancelled = services.client.connection.withDeadline(
            Date.now() + Math.max(1, remaining(ctx.deadlineNs)),
            () => handle!.cancel(),
          );
          cancellation = cancelled;
          void cancelled.catch(() => {});
        }
        for (const port of ports) port.close();
        abortReject(new Error('h01-temporal-interrupted'));
      };
      function working() {
        ctx.signal.throwIfAborted();
        requireWorkflow(
          !stopping && remaining(ctx.workDeadlineNs) >= 1,
          'h01-temporal-work-deadline',
        );
      }
      async function stopPort(port: (typeof ports)[number]) {
        if (port.stopped) return;
        try {
          const initial = await cleanup(port.initial);
          const alive = await cleanup(processes.alive(initial));
          saved({ kind: 'h01-temporal-process-observation', initial, alive });
          if (alive.length === 0) {
            requireWorkflow(taskStop !== null, 'h01-temporal-unobserved-port-stop');
            const primary = artifact(taskStop).value;
            requireWorkflow(
              primary.confirmed === true && Array.isArray(primary.processes),
              'h01-temporal-primary-stop-invalid',
            );
            requireWorkflow(
              initial.every((id) =>
                (primary.processes as ProcessIdentity[]).some(
                  (p) => canonical(p) === canonical(id),
                ),
              ),
              'h01-temporal-primary-stop-binding',
            );
          } else {
            const owned = await cleanup(processes.descendants([initial[0]!.pid]));
            requireWorkflow(
              owned.some((id) => canonical(id) === canonical(initial[0])),
              'h01-temporal-port-identity-changed',
            );
            const stopped = await cleanup(processes.terminate(owned));
            for (let i = 0; i < 100 && (await cleanup(processes.alive(stopped))).length > 0; i++) {
              requireWorkflow(remaining(ctx.deadlineNs) > 0, 'h01-temporal-stop-deadline');
              await cleanup(processes.wait(50));
            }
            const survivors = await cleanup(processes.alive(stopped));
            remainingProcesses.push(...survivors);
            requireWorkflow(survivors.length === 0, 'h01-temporal-port-stop-unknown');
            saved({
              kind: 'h01-temporal-port-stop',
              root: port.root,
              initial,
              stopped,
              confirmed: true,
            });
          }
          port.stopped = true;
        } finally {
          port.close();
        }
      }
      function native(
        root: string,
        label: string,
        stage: 'execution' | 'council',
        disabled: string[],
      ) {
        working();
        h01ReadPin(ctx.binary);
        creationPending = true;
        const journal = join(ctx.roots.evidenceRoot, label + '.jsonl');
        const rpc = new StdioAppServer(
          ctx.binary.locator,
          [
            '-c',
            'features.apps=false',
            '-c',
            'features.plugins=false',
            '-c',
            'features.multi_agent=false',
            ...disabled.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
            'app-server',
            '--stdio',
          ],
          root,
          journal,
          ctx.opId + '-' + label,
        );
        const pid = rpc.pid;
        try {
          requireWorkflow(
            typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1,
            'h01-temporal-port-pid-unknown',
          );
        } catch (error) {
          rpc.close();
          throw error;
        }
        requireWorkflow(typeof pid === 'number', 'h01-temporal-port-pid-unknown');
        const initial = Promise.resolve().then(async () => {
          working();
          await Promise.race([rpc.initialize(), interrupted]);
          working();
          const owned = await Promise.race([processes.descendants([pid]), interrupted]);
          working();
          requireWorkflow(
            owned.some((id) => id.pid === pid && id.parent === process.pid),
            'h01-temporal-port-start-unobserved',
          );
          return [owned.find((id) => id.pid === pid)!, ...owned.filter((id) => id.pid !== pid)];
        });
        // Retain the rejected observation for final cleanup without an unhandled rejection.
        void initial.catch(() => {});
        let admitted: {
          binding: string;
          start: H01ModelStart;
          ready: boolean;
        } | null = null;
        let invalidated = false;
        const close = () => {
          invalidated = true;
          admitted = null;
          rpc.close();
        };
        const port = {
          rpc,
          root,
          stage,
          initial,
          journal,
          sessions: new Set<string>(),
          stopped: false,
          close,
        };
        ports.push(port);
        creationPending = false;
        const admitTurn = async (params: Record<string, unknown>) => {
          try {
            working();
            requireWorkflow(!invalidated, 'h01-temporal-admission-invalidated');
            requireWorkflow(admitted === null, 'h01-temporal-admission-pending');
            const binding = digest(canonical(params));
            requireWorkflow(
              port.sessions.has(String(params.threadId)),
              'h01-temporal-unmanaged-session',
            );
            const captured = captureTaskBudget(
              join(ctx.roots.hostRoot, 'turn-credits'),
              store,
              budget,
            );
            budget = captured.manifest;
            requireWorkflow(
              captured.limit === ctx.budget.maxManagedStarts,
              'h01-temporal-credit-limit',
            );
            const entries = object(JSON.parse(store.read(captured.manifest).toString())).credits;
            requireWorkflow(Array.isArray(entries), 'h01-temporal-credit-unknown');
            let hash = digest(JSON.stringify(params)),
              key: string | null = null;
            if (stage === 'execution') {
              const message = textField(object((params.input as unknown[])[0]).text);
              const operation = /^Workflow operation: ([^\n]+)\n/u.exec(message);
              requireWorkflow(operation !== null, 'h01-temporal-writer-operation-unknown');
              hash = digest(message);
              key = digest(operation[1]!);
            }
            const matches = entries.map(object).filter((credit) => credit.hash === hash);
            requireWorkflow(matches.length === 1, 'h01-temporal-credit-ambiguous');
            const credit = matches[0]!;
            requireWorkflow(key === null || key === credit.key, 'h01-temporal-credit-binding');
            const marker = {
              binding,
              start: {
                origin: 'temporal-host' as const,
                key: textField(credit.key),
                hash,
                stage,
                session: textField(params.threadId),
              },
              ready: false,
            };
            admitted = marker;
            await Promise.race([ctx.nativeObserver.beforeModelStart(marker.start), interrupted]);
            working();
            requireWorkflow(
              !invalidated && admitted === marker && binding === digest(canonical(params)),
              'h01-temporal-admission-invalidated',
            );
            marker.ready = true;
          } catch (error) {
            admitted = null;
            invalidated = true;
            throw error;
          }
        };
        const request = async (
          method: string,
          params: Record<string, unknown>,
        ): Promise<unknown> => {
          working();
          if (method === 'thread/resume' || method === 'thread/read') {
            const session = textField(params.threadId),
              known = creations.get(session);
            requireWorkflow(
              known !== undefined &&
                port.sessions.has(session) &&
                known.root === root &&
                known.stage === stage,
              'h01-temporal-session-binding',
            );
          }
          if (method === 'turn/start') {
            let start: H01ModelStart;
            try {
              requireWorkflow(!invalidated, 'h01-temporal-admission-invalidated');
              if (admitted === null) await admitTurn(params);
              const marker = admitted;
              requireWorkflow(
                marker !== null && marker.ready && marker.binding === digest(canonical(params)),
                'h01-temporal-admission-binding',
              );
              admitted = null;
              working();
              start = marker.start;
            } catch (error) {
              admitted = null;
              invalidated = true;
              throw error;
            }
            const response = await Promise.race([rpc.request(method, params), interrupted]);
            const confirmation = saved({
              kind: 'h01-native-dispatch',
              method,
              start,
              params,
              response,
            } satisfies H01NativeObservation);
            working();
            ctx.nativeObserver.confirmModelStart({
              key: start.key,
              session: textField(params.threadId),
              turn: textField(object(object(response).turn).id),
              evidence: confirmation,
            });
            return response;
          }
          const result = await Promise.race([rpc.request(method, params), interrupted]);
          working();
          if (['thread/start', 'thread/resume', 'thread/read'].includes(method)) {
            const thread = object(object(result).thread),
              session = textField(thread.id);
            requireWorkflow(thread.cwd === root, 'h01-temporal-thread-scope');
            requireWorkflow(
              method === 'thread/start' || session === params.threadId,
              'h01-temporal-unmanaged-session',
            );
            if (method === 'thread/start') {
              requireWorkflow(!creations.has(session), 'h01-temporal-creation-conflict');
              const creation = saved({
                kind: 'h01-native-dispatch',
                method,
                params,
                response: result,
              } satisfies H01NativeObservation);
              ctx.nativeObserver.registerCreation({
                session,
                run: ctx.opId,
                stage,
                creation,
              });
              creations.set(session, {
                creation,
                stage,
                root,
                transcript: null,
              });
              port.sessions.add(session);
              working();
              const capabilities = await Promise.race([
                rpc.request('mcpServerStatus/list', {
                  limit: 100,
                  detail: 'toolsAndAuthOnly',
                }),
                interrupted,
              ]);
              working();
              ctx.nativeObserver.registerCapabilities({
                session,
                disabled,
                evidence: saved({
                  kind: 'h01-native-capabilities',
                  session,
                  response: capabilities,
                }),
              });
            }
            const created = creations.get(session)!;
            if (method === 'thread/resume') {
              saved({
                kind: 'h01-native-dispatch',
                method,
                params,
                response: result,
              } satisfies H01NativeObservation);
              const original = object(
                  object(JSON.parse(h01ReadPin(created.creation).toString())).response,
                ),
                resumed = object(result);
              requireWorkflow(
                original.model === resumed.model &&
                  original.reasoningEffort === resumed.reasoningEffort,
                'h01-temporal-resume-profile',
              );
              await request('thread/read', {
                threadId: session,
                includeTurns: false,
              });
              return result;
            }
            if (typeof thread.path === 'string') {
              requireWorkflow(
                created.transcript === null || created.transcript === thread.path,
                'h01-temporal-transcript-changed',
              );
              created.transcript = thread.path;
              const pathObservation =
                method === 'thread/read'
                  ? saved({
                      kind: 'h01-native-dispatch',
                      method,
                      params,
                      response: result,
                    } satisfies H01NativeObservation)
                  : undefined;
              ctx.nativeObserver.registerParticipant({
                session,
                transcript: thread.path,
                run: ctx.opId,
                stage,
                creation: created.creation,
                ...(pathObservation === undefined ? {} : { pathObservation }),
              });
              participants.add(session);
            }
          }
          return result;
        };
        return {
          pid,
          initialize: async () => {
            await Promise.race([initial, interrupted]);
            working();
          },
          admitTurn,
          request,
          completed: (session: string, turn: string, signal?: AbortSignal) =>
            Promise.race([rpc.completed(session, turn, signal), interrupted]),
          close,
          port,
        };
      }
      try {
        working();
        timer = setTimeout(abort, Math.max(0, remaining(ctx.workDeadlineNs)));
        stopTimer = setTimeout(
          () => stopReject(new Error('h01-temporal-cleanup-deadline')),
          Math.max(0, remaining(ctx.deadlineNs)),
        );
        ctx.signal.addEventListener('abort', abort, { once: true });
        requireWorkflow(
          ctx.runtime.engine === 'temporal' && ctx.bootstrap.engine === 'temporal',
          'h01-temporal-engine',
        );
        requireWorkflow(
          supportedTaskClient(ctx.profile.clientVersion),
          'h01-temporal-client-version',
        );
        requireWorkflow(
          ctx.bootstrap.taskQueue === services.taskQueue &&
            ctx.bootstrap.workflowsPath === services.workflowsPath,
          'h01-temporal-service-binding',
        );
        requireWorkflow(
          ctx.bootstrap.namespace === 'default' &&
            services.client.options.namespace === ctx.bootstrap.namespace &&
            object(object(services.client.connection).options).address === ctx.bootstrap.address,
          'h01-temporal-service-binding',
        );
        requireWorkflow(
          ctx.bootstrap.issuer.owner === ctx.identity.owner,
          'h01-temporal-authority-owner',
        );
        const authorization = object(JSON.parse(h01ReadPin(ctx.verifiedAuthorization).toString()));
        const human = object(authorization.context),
          issuer = ctx.bootstrap.issuer;
        requireWorkflow(
          authorization.kind === 'comparison-h01-authorization-observation' &&
            authorization.executionVersion === 2 &&
            authorization.opId === ctx.opId &&
            authorization.requestHash === ctx.requestHash &&
            authorization.variant === ctx.variant &&
            canonical(authorization.budget) === canonical(ctx.budget),
          'h01-temporal-authorization-binding',
        );
        requireWorkflow(
          canonical(authorization.issuer) === canonical(issuer) &&
            human.threadId === issuer.threadId &&
            human.workspaceRoot === issuer.workspaceRoot &&
            human.owner === issuer.owner &&
            textField(authorization.transcript).startsWith(issuer.sessionsRoot + sep),
          'h01-temporal-issuer-binding',
        );
        for (const path of [entrypoint, readerHostSource, transportSource, services.workflowsPath])
          requireWorkflow(
            ctx.runtime.files.some((ref) => ref.locator === path),
            'h01-temporal-runtime-unpinned',
          );
        for (const ref of ctx.runtime.files) h01ReadPin(ref);
        requireWorkflow(
          ctx.material.value.id === 'H-01' &&
            canonical(ctx.material.value.mutable) === canonical(['range.mjs']),
          'h01-temporal-material',
        );
        await Promise.race([ctx.nativeObserver.verify(), interrupted]);
        working();
        const authority = nativeReaderAuthority(store, ctx.bootstrap.issuer);
        const workspace = safeDirectory(ctx.roots.workspaceRoot);
        for (const role of ['rules', 'executor', 'reviewer'] as const)
          requireWorkflow(
            readPrivateFile(join(workspace, h01TaskPaths[role])).equals(h01ReadPin(ctx[role])),
            'h01-temporal-role-pin',
          );
        const ref = (name: string) => ({
          locator: name,
          hash: digest(readPrivateFile(join(workspace, name))),
        });
        const planPath = '.comparison/temporal-plan.json';
        const plan = {
          schema_version: 1,
          requirement: ref(h01TaskPaths.card),
          basis: [ref(h01TaskPaths.basis)],
          owner: ref('range.mjs'),
          consumers: ['consumer-a.mjs', 'consumer-b.mjs', 'checks.mjs'].map(ref),
          consumers_complete: true,
          paths: ['range.mjs'],
          risks: Object.fromEntries(localPlanningRisks.map((risk) => [risk, false])),
          reason: ctx.material.value.instructions,
          checks: ['syntax', 'validate'],
          criterion: ctx.criteria.value.task,
        };
        safeDirectory(join(workspace, '.comparison'));
        writePrivateFile(join(workspace, planPath), JSON.stringify(plan));
        const preparation = {
          schemaVersion: 1 as const,
          project: {
            schemaVersion: 1 as const,
            projectId: 'h01-' + digest(ctx.opId).slice(0, 16),
            workspaceId: ctx.opId,
            rules: [h01TaskPaths.rules],
            cardRoot: '.comparison',
            roles: [{ id: 'reviewer', profile: h01TaskPaths.reviewer }],
            checks: ['syntax', 'validate'],
          },
          taskId: ctx.identity.taskId,
          hostId: ctx.opId,
          owner: ctx.identity.owner,
          generation: ctx.identity.generation,
          revision: 1,
          card: h01TaskPaths.card,
        };
        const acceptance = store.publish(
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              phase: 'acceptance',
              scope: 'H-01',
              sharedPaths: [h01TaskPaths.basis, 'consumer-a.mjs', 'consumer-b.mjs', 'checks.mjs'],
              roles: [
                {
                  roleId: 'reviewer',
                  applies: true,
                  reason: ctx.material.value.instructions,
                  paths: ['range.mjs'],
                  complete: true,
                  attestedBy: 'pinned H01 material',
                  discoveryRule: 'both declared consumers and immutable H01 checker',
                  history: { complete: true, answers: [] },
                },
              ],
            }),
          ),
        );
        const input: NativeTaskInput = {
          schemaVersion: 1,
          admission: {
            schemaVersion: 1,
            preparation,
            plan: { path: planPath, sha256: digest(JSON.stringify(plan)) },
            acceptance,
          },
          executor: {
            path: h01TaskPaths.executor,
            sha256: digest(readPrivateFile(join(workspace, h01TaskPaths.executor))),
          },
          baseline: 'syntax',
        };
        saved({
          kind: 'h01-temporal-assembly',
          opId: ctx.opId,
          requestHash: ctx.requestHash,
          input,
          runtime: ctx.runtime,
          authorization: ctx.verifiedAuthorization,
          guard: ctx.nativeObserver.controlRef,
          installedTarProof: false,
        });
        const probe = native(workspace, 'probe', 'council', []);
        await probe.initialize();
        const inventory = object(
          await probe.request('mcpServerStatus/list', {
            limit: 100,
            detail: 'toolsAndAuthOnly',
          }),
        );
        requireWorkflow(
          Array.isArray(inventory.data) && inventory.nextCursor == null,
          'h01-temporal-tool-inventory',
        );
        const disabled = inventory.data.map((row) => textField(object(row).name));
        requireWorkflow(
          disabled.every((name) => /^[A-Za-z0-9_-]+$/u.test(name)),
          'h01-temporal-tool-name',
        );
        await stopPort(probe.port);
        const reader = native(workspace, 'reader', 'council', disabled);
        await reader.initialize();
        working();
        let serial = 0;
        const registration = {
          project: preparation.project,
          hostId: preparation.hostId,
          owner: preparation.owner,
          generation: preparation.generation,
          workspaceRoot: workspace,
          artifactRoot: ctx.roots.artifactRoot,
          commands: {
            syntax: {
              executable: process.execPath,
              args: ['--check', 'range.mjs'],
              timeoutMs: 30000,
            },
            validate: {
              executable: process.execPath,
              args: ['checks.mjs'],
              timeoutMs: 30000,
            },
          },
        };
        bindTaskBackendClient(services.client, registration);
        hostAttempted = true;
        const hostRun = createReaderHost(
          services.nativeConnection,
          services.taskQueue,
          services.workflowsPath,
          [
            {
              registration,
              rpc: reader,
              authority,
              localTasks: {
                profile: ctx.profile,
                processes,
                disabledServers: disabled,
                createRuntime: (copy) => native(copy, 'writer-' + serial++, 'execution', disabled),
              },
            },
          ],
          ctx.profile,
          ctx.roots.hostRoot,
          ctx.budget.maxManagedStarts,
        ).then((host) =>
          host.runUntil(async () => {
            working();
            requireWorkflow(
              host.taskAdmissionsDirectory !== null,
              'h01-temporal-admissions-directory-missing',
            );
            const admissions = safeDirectory(host.taskAdmissionsDirectory);
            handle = await Promise.race([
              services.client.connection.withDeadline(
                Date.now() + remaining(ctx.workDeadlineNs),
                () => startLocalTask(services.client, input, services.taskQueue),
              ),
              interrupted,
            ]);
            const result = await Promise.race([handle.result(), interrupted]);
            working();
            saved({
              kind: 'h01-temporal-workflow-result',
              result,
              workflowId: handle.workflowId,
            });
            const history = await Promise.race([
              services.client.connection.withDeadline(
                Date.now() + remaining(ctx.workDeadlineNs),
                () => handle!.fetchHistory(),
              ),
              interrupted,
            ]);
            saved({
              kind: 'h01-temporal-history',
              workflowId: handle.workflowId,
              history,
            });
            working();
            if (result.status !== 'done') {
              const stopped = artifact(result.stop).value;
              requireWorkflow(
                stopped.confirmed === true && canonical(stopped.input) === canonical(input),
                'h01-temporal-blocked-stop',
              );
              if (stopped.writer !== undefined) taskStop = artifact(stopped.writer).ref;
              outcome = 'failed';
              return;
            }
            const primary = artifact(result.result).value;
            requireWorkflow(
              primary.kind === 'local-task-result' &&
                primary.complete === true &&
                canonical(primary.input) === canonical(input),
              'h01-temporal-result-binding',
            );
            const writer = object(primary.writer),
              stop = artifact(writer.stop);
            taskStop = stop.ref;
            requireWorkflow(
              stop.value.kind === 'task-writers-stopped' && stop.value.confirmed === true,
              'h01-temporal-writer-stop',
            );
            const review = artifact(primary.review);
            requireWorkflow(
              review.value.kind === 'reader-review-result' && review.value.complete === true,
              'h01-temporal-acceptance',
            );
            projection = artifact(result.projection).source;
            artifact(primary.checks);
            nativeAcceptance = review.source;
            const admissionPath = join(admissions, digest(taskAdmissionIdentity(input)));
            const admissionBytes = readPrivateFile(admissionPath),
              admission = object(JSON.parse(admissionBytes.toString()));
            requireWorkflow(
              canonical(admission.input) === canonical(input) &&
                object(admission.gate).mode === 'owned',
              'h01-temporal-admission-binding',
            );
            saved({
              kind: 'h01-temporal-admission',
              path: admissionPath,
              admission,
            });
            const gate = object(admission.gate),
              gateRoot = safeDirectory(textField(gate.directory)),
              grantBytes = readPrivateFile(join(gateRoot, 'grant.json')),
              grantRef = object(gate.grant),
              grantValue = object(JSON.parse(grantBytes.toString('utf8')));
            requireWorkflow(
              digest(grantBytes) === grantRef.sha256 &&
                grantBytes.length === grantRef.bytes &&
                canonical(grantValue.input) === canonical(input) &&
                grantValue.instance === object(admission.host).id,
              'h01-temporal-grant-binding',
            );
            const grant = artifact(store.publish(grantBytes));
            requireWorkflow(
              readPrivateFile(join(gateRoot, 'grant.json')).equals(store.read(grant.ref)),
              'h01-temporal-grant-binding',
            );
            const answer = artifact(writer.answer),
              readiness = artifact(answer.value.ready),
              load = artifact(readiness.value.load);
            requireWorkflow(
              answer.value.kind === 'task-writer-answer' &&
                readiness.value.kind === 'task-writer-ready' &&
                canonical(answer.value.input) === canonical(input) &&
                canonical(readiness.value.input) === canonical(input) &&
                canonical(readiness.value.grant) === canonical(grantRef) &&
                canonical(load.value) === canonical(answer.value.load) &&
                typeof writer.session === 'string' &&
                readiness.value.session === writer.session &&
                stop.value.session === writer.session &&
                object(load.value.thread).id === writer.session &&
                typeof readiness.value.loadTurnId === 'string' &&
                object(load.value.turn).id === readiness.value.loadTurnId &&
                object(load.value.turn).status === 'completed',
              'h01-temporal-ready-binding',
            );
            ready = readiness.source;
            for (const name of ['permission.json', 'revoked.json', 'stopped.json', 'done.json'])
              if (existsSync(join(gateRoot, name))) {
                const value: unknown = JSON.parse(readPrivateFile(join(gateRoot, name)).toString());
                saved({ kind: 'h01-temporal-gate-observation', name, value });
              }
            outcome = 'completed';
          }),
        );
        // Public host creation/shutdown is not abortable; unknown cleanup needs the caller's process keeper.
        await Promise.race([hostRun, interrupted]);
        hostFinished = true;
        working();
        await comparisonParticipants(
          reader,
          [...new Set(ports.map((port) => port.root))],
          ctx.opId,
          (participant) => {
            const known = creations.get(participant.session);
            ctx.nativeObserver.observeParticipant({
              ...participant,
              stage: known?.stage ?? participant.stage,
            });
          },
        );
        working();
      } catch (error) {
        outcome = 'unknown';
        saved({ kind: 'h01-temporal-failure', error: String(error) });
      } finally {
        stopping = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', abort);
        if (cancellation !== undefined) {
          try {
            await cleanup(cancellation);
          } catch (error) {
            stopErrors.push(String(error));
          }
        }
        for (const port of ports) {
          try {
            await stopPort(port);
          } catch (error) {
            stopErrors.push(String(error));
          }
          try {
            const path = port.journal + '.diagnostics.json',
              bytes = readPrivateFile(path);
            // Bounded transport metadata supplements the native primary and task stop proofs.
            new TransportJournal(port.journal);
            requireWorkflow(
              readPrivateFile(path).equals(bytes),
              'h01-temporal-diagnostics-changed',
            );
            evidence.push({ locator: path, hash: digest(bytes) });
          } catch (error) {
            stopErrors.push(String(error));
          }
        }
        if (creationPending || (hostAttempted && !hostFinished))
          stopErrors.push('native/Worker start or stop is unconfirmed');
      }
      if (hostFinished && existsSync(join(ctx.roots.hostRoot, 'host-owner')))
        stopErrors.push('host owner was not released');
      const confirmed = stopErrors.length === 0;
      if (!confirmed) outcome = 'unknown';
      projection ??= saved({
        kind: 'h01-projection-unknown',
        opId: ctx.opId,
        reason: 'No bound completed TaskWorkflow projection was observed',
      });
      saved({
        kind: 'h01-temporal-stop-details',
        requestHash: ctx.requestHash,
        hostFinished,
        ownedPorts: ports.length,
        operatorOwnsServer: true,
        taskStop,
        budget,
        reasons: stopErrors,
      });
      const stop = saved({
        kind: 'comparison-h01-stop',
        executionVersion: 2,
        opId: ctx.opId,
        confirmed,
        reason: stopErrors.join('\n'),
        sessions: [...creations.keys()],
        remainingProcesses,
        evidence: [...evidence],
      } satisfies H01StopObservation);
      try {
        requireWorkflow(participants.size === creations.size, 'h01-temporal-transcript-missing');
        if (confirmed)
          for (const session of participants)
            ctx.nativeObserver.completeParticipant(session, {
              outcome,
              stop,
              evidence: [...evidence],
            });
        await cleanup(ctx.nativeObserver.verify());
        const accounting = ctx.nativeObserver.accounting();
        saved({ kind: 'h01-temporal-native-accounting', accounting });
        requireWorkflow(!accounting.unknown, 'h01-temporal-usage-unknown');
      } catch (error) {
        outcome = 'unknown';
        saved({
          kind: 'h01-temporal-accounting-unknown',
          error: String(error),
        });
      }
      clearTimeout(stopTimer);
      return {
        outcome,
        evidence,
        stop,
        nativeAcceptance,
        projection,
        ...(ready ? { ready } : {}),
      };
    },
  };
}
