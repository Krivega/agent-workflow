import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import proto from '@temporalio/proto';
import { Context } from '@temporalio/activity';
import type { CodexRpc } from '../src/contracts/codex.js';
import type {
  ArtifactRef,
  LocalProjectRegistration,
  PreparationInput,
} from '../src/contracts/preparation.js';
import type { H01BackendAdapter, H01ModelStart } from './comparisonH01Contract.js';
import type { H01TemporalServices } from './comparisonH01Temporal.js';
import type { ReviewInput, ReviewPlan } from '../src/contracts/review.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { InputRef } from '../core/localRun.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { nativeReaderAuthority } from '../src/adapters/codex/readerAuthority.js';
import { createReaderHost } from '../src/worker/readerHost.js';
import { captureTaskBudget } from '../src/worker/taskBudget.js';
import { startReview } from '../src/client/review.js';
import { bindTaskBackendClient } from '../src/client/taskBackend.js';
import { readerKey, readerTarget } from '../src/policy/readerControl.js';
import { requireScoped } from '../src/policy/review.js';
import { h01ReadJson, h01ReadPin, h01Record } from './comparisonH01Contract.js';
import { createH02NativeRpc } from './comparisonH02NativeRpc.js';
import { runH02TemporalCase, type H02TemporalRoundResult } from './comparisonH02Temporal.js';

/** Assembly only: callers own the explicit H02 grant and Temporal service interval. */
export function createH02NativeTemporalAdapter(services: H01TemporalServices): H01BackendAdapter {
  return {
    async execute(ctx) {
      requireWorkflow(ctx.criteria.value.id === 'H-02', 'h02-temporal-scenario');
      const store = artifactStore(ctx.roots.artifactRoot, { existingOnly: true });
      const evidence: InputRef[] = [],
        workflowEvidence: InputRef[] = [];
      const saved = (label: string, value: unknown) => {
        const ref = h01Record(ctx.roots.evidenceRoot, 'h02-' + label, value);
        evidence.push(ref);
        return ref;
      };
      const data = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString('utf8')));
      const source = (ref: ArtifactRef): InputRef => ({
        locator: store.path(ref),
        hash: ref.sha256,
      });
      const ports: Awaited<ReturnType<typeof createH02NativeRpc>>[] = [];
      const sessions = new Map<string, (typeof ports)[number]>();
      const byReader = new Map<string, (typeof ports)[number]>();
      let roundInput: ReviewInput | null = null,
        allowedReaders: Set<string> | null = null,
        budget: ArtifactRef | null = null,
        creationPending = false;
      const readerPort = (create: boolean) => {
        requireWorkflow(roundInput !== null, 'h02-temporal-reader-round-unknown');
        const execution = Context.current().info.workflowExecution;
        requireWorkflow(execution !== undefined, 'h02-temporal-workflow-context-required');
        const key = execution.workflowId;
        if (allowedReaders === null) {
          const plans = readdirSync(ctx.roots.artifactRoot)
            .filter((name) => /^[a-f0-9]{64}$/u.test(name))
            .flatMap((name) => {
              const bytes = h01ReadPin({ locator: join(ctx.roots.artifactRoot, name), hash: name });
              try {
                const value = object(JSON.parse(bytes.toString('utf8')));
                return value.kind === 'reader-review-plan' &&
                  canonical(value.input) === canonical(roundInput)
                  ? [value]
                  : [];
              } catch {
                return [];
              }
            });
          requireWorkflow(
            plans.length === 1 && Array.isArray(plans[0]!.decisions),
            'h02-temporal-reader-plan-unknown',
          );
          allowedReaders = new Set(
            (plans[0]!.decisions as ReviewPlan['decisions'])
              .filter((row) => row.action === 'review')
              .map((row) => readerKey(requireScoped(row.input))),
          );
        }
        requireWorkflow(allowedReaders.has(key), 'h02-temporal-reader-key-unbound');
        let port = byReader.get(key);
        if (port === undefined && create) {
          creationPending = true;
          port = createH02NativeRpc(ctx, 'temporal-reader-' + String(ports.length + 1), {
            startForTurn,
          });
          byReader.set(key, port);
          ports.push(port);
          creationPending = false;
        }
        requireWorkflow(port !== undefined, 'h02-temporal-reader-not-created');
        return port;
      };
      const startForTurn = async (params: Record<string, unknown>): Promise<H01ModelStart> => {
        ctx.signal.throwIfAborted();
        const captured = captureTaskBudget(join(ctx.roots.hostRoot, 'turn-credits'), store, budget);
        budget = captured.manifest;
        const credits = data(captured.manifest).credits;
        requireWorkflow(
          captured.limit === ctx.budget.maxManagedStarts && Array.isArray(credits),
          'h02-temporal-credit-limit',
        );
        const hash = digest(JSON.stringify(params)),
          matches = credits.map(object).filter((credit) => credit.hash === hash);
        requireWorkflow(matches.length === 1, 'h02-temporal-credit-ambiguous');
        return {
          origin: 'temporal-host',
          key: textField(matches[0]!.key),
          hash,
          session: textField(params.threadId),
          stage: 'council',
        };
      };
      const native: CodexRpc = {
        async request(method, params) {
          if (method === 'model/list') {
            return readerPort(true).rpc.request(method, params);
          }
          if (method === 'thread/start') {
            const port = readerPort(false),
              response = await port.rpc.request(method, params);
            const id = textField(object(object(response).thread).id);
            requireWorkflow(!sessions.has(id), 'h02-temporal-session-repeated');
            sessions.set(id, port);
            return response;
          }
          if (method === 'thread/loaded/list') {
            const responses = await Promise.all(
              ports.map((port) => port.rpc.request(method, params)),
            );
            const ids = responses.flatMap((response) => {
              const loaded = object(response).data;
              requireWorkflow(
                Array.isArray(loaded) &&
                  loaded.every((id) => typeof id === 'string' && sessions.has(id)),
                'h02-temporal-loaded-session',
              );
              return loaded as string[];
            });
            return { data: [...new Set(ids)] };
          }
          const port = sessions.get(textField(params.threadId));
          requireWorkflow(port !== undefined, 'h02-temporal-session-unknown');
          return port.rpc.request(method, params);
        },
        completed(session, turn, signal) {
          const port = sessions.get(session);
          requireWorkflow(port !== undefined, 'h02-temporal-session-unknown');
          return port.rpc.completed(session, turn, signal);
        },
      };
      const project = {
        schemaVersion: 1 as const,
        projectId: 'h02-' + digest(ctx.opId).slice(0, 16),
        workspaceId: ctx.opId,
        rules: [
          '.h02/rules.md',
          '.h02/roles.md',
          ...['bootstrap', 'data-roles', 'evidence', 'boundary-review', 'council'].map(
            (name) => `procedures/${name}.md`,
          ),
        ],
        cardRoot: '.h02',
        roles: ['pricing', 'logging', 'storage'].map((id) => ({ id, profile: `.h02/${id}.md` })),
        checks: ['syntax', 'validate'],
      };
      const registration: LocalProjectRegistration = {
        project,
        hostId: ctx.opId,
        owner: ctx.identity.owner,
        generation: ctx.identity.generation,
        workspaceRoot: ctx.roots.workspaceRoot,
        artifactRoot: ctx.roots.artifactRoot,
        commands: {
          syntax: { executable: process.execPath, args: ['--check', 'checks.mjs'] },
          validate: { executable: process.execPath, args: ['checks.mjs'] },
        },
      };
      const preparation: PreparationInput = {
        schemaVersion: 1,
        project,
        taskId: ctx.identity.taskId,
        hostId: ctx.opId,
        owner: ctx.identity.owner,
        generation: ctx.identity.generation,
        revision: 1,
        card: '.h02/task.md',
      };
      requireWorkflow(ctx.bootstrap.engine === 'temporal', 'h02-temporal-bootstrap');
      const authority = nativeReaderAuthority(store, ctx.bootstrap.issuer);
      bindTaskBackendClient(services.client, registration);
      const executeRound = async (
        input: ReviewInput,
        rpc: CodexRpc,
      ): Promise<H02TemporalRoundResult> => {
        roundInput = input;
        allowedReaders = null;
        const host = await createReaderHost(
          services.nativeConnection,
          services.taskQueue,
          services.workflowsPath,
          [{ registration, rpc, authority }],
          ctx.profile,
          ctx.roots.hostRoot,
          ctx.budget.maxManagedStarts,
        );
        let handle: Awaited<ReturnType<typeof startReview>> | undefined;
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
        ctx.signal.addEventListener('abort', abort, { once: true });
        let result: Awaited<ReturnType<Awaited<ReturnType<typeof startReview>>['result']>>;
        try {
          result = await host.runUntil(async () => {
            ctx.signal.throwIfAborted();
            handle = await startReview(services.client, input, services.taskQueue);
            if (ctx.signal.aborted) {
              abort();
              ctx.signal.throwIfAborted();
            }
            const value = await handle.result();
            ctx.signal.throwIfAborted();
            const description = await handle.describe(),
              history = await handle.fetchHistory();
            requireWorkflow(
              description.status.name === 'COMPLETED',
              'h02-temporal-workflow-not-completed',
            );
            const round = input.reviewId.replace(/^h02-/u, '');
            const historyRef = saved('review-history', {
              kind: 'comparison-h02-review-history',
              scenario: 'H-02',
              opId: ctx.opId,
              round,
              workflowId: handle.workflowId,
              runId: description.runId,
              history: proto.temporal.api.history.v1.History.fromObject(history).toJSON(),
            });
            const ref = saved('review-workflow', {
              kind: 'comparison-h02-review-workflow-proof',
              scenario: 'H-02',
              opId: ctx.opId,
              round,
              workflowId: handle.workflowId,
              runId: description.runId,
              status: description.status.name,
              input,
              history: historyRef,
              result: value,
            });
            workflowEvidence.push(ref);
            return value;
          });
        } finally {
          ctx.signal.removeEventListener('abort', abort);
          roundInput = null;
          allowedReaders = null;
        }
        requireWorkflow(result.status === 'reviewed', 'h02-temporal-workflow-result');
        const planValue = data(result.plan),
          plan: ReviewPlan = {
            manifest: result.plan,
            decisions: planValue.decisions as ReviewPlan['decisions'],
          };
        const readers: H02TemporalRoundResult['readers'] = [];
        for (const row of plan.decisions.filter((row) => row.action === 'review')) {
          const completed = result.answers.find((answer) => answer.roleId === row.roleId);
          requireWorkflow(
            completed !== undefined &&
              'result' in completed &&
              completed.result.status === 'answered',
            'h02-temporal-reader-result',
          );
          const answer = completed.result.answer,
            primary = data(answer),
            reader = requireScoped(row.input);
          const stops = readdirSync(ctx.roots.artifactRoot)
            .filter((name) => /^[a-f0-9]{64}$/u.test(name))
            .map((name) => {
              const bytes = h01ReadPin({ locator: join(ctx.roots.artifactRoot, name), hash: name });
              try {
                return {
                  ref: { sha256: name, bytes: bytes.length },
                  value: object(JSON.parse(bytes.toString('utf8'))),
                };
              } catch {
                return null;
              }
            })
            .filter(
              (value) =>
                value !== null &&
                value.value.kind === 'reader-stop' &&
                canonical(value.value.target) ===
                  canonical(readerTarget(reader, readerKey(reader))) &&
                value.value.confirmed === true,
            );
          requireWorkflow(stops.length === 1, 'h02-temporal-reader-stop-unknown');
          readers.push({
            roleId: row.roleId,
            session: textField(primary.session),
            prepared: object(primary.prepared).manifest as ArtifactRef,
            load: primary.load as ArtifactRef,
            answer,
            stop: stops[0]!.ref,
          });
        }
        return {
          plan,
          readers,
          completion: { manifest: result.manifest, complete: result.complete },
        };
      };
      let caseReport: Awaited<ReturnType<typeof runH02TemporalCase>> | undefined,
        failure: string | null = null;
      const stops: InputRef[] = [];
      try {
        caseReport = await runH02TemporalCase({
          registration,
          preparation,
          profile: ctx.profile,
          rpc: native,
          authority,
          directory: join(ctx.roots.hostRoot, 'h02-driver'),
          maxTurnStarts: ctx.budget.maxManagedStarts,
          signal: ctx.signal,
          executeRound,
        });
        evidence.push(caseReport.report, ...caseReport.evidence);
      } catch (error) {
        failure = error instanceof Error ? error.message : 'h02-temporal-unknown';
      } finally {
        for (const port of ports) {
          try {
            stops.push(await port.stop());
          } catch {
            failure ??= 'h02-temporal-port-stop-unknown';
          }
          evidence.push(...port.evidence);
        }
      }
      const confirmed =
        failure === null &&
        !creationPending &&
        stops.length === ports.length &&
        stops.every((ref) => {
          const proof = object(h01ReadJson(ref));
          return (
            proof.kind === 'comparison-h02-stop' &&
            proof.opId === ctx.opId &&
            proof.confirmed === true &&
            Array.isArray(proof.remainingProcesses) &&
            proof.remainingProcesses.length === 0
          );
        });
      const stop = saved('temporal-stop', {
        kind: 'comparison-h02-stop',
        executionVersion: 2,
        opId: ctx.opId,
        confirmed,
        sessions: [...sessions.keys()],
        remainingProcesses: [],
        evidence: [...evidence, ...stops],
        ...(failure === null ? {} : { reason: failure }),
      });
      const projection = saved('temporal-projection', {
        kind: 'comparison-h02-native-projection',
        scenario: 'H-02',
        opId: ctx.opId,
        engine: 'temporal',
        sdk: true,
        caseReport: caseReport?.report ?? null,
        workflowEvidence,
      });
      const repaired = caseReport?.rounds.find((round) => round.name === 'repaired')?.completion;
      const completed =
        !ctx.signal.aborted &&
        confirmed &&
        caseReport?.outcome === 'accepted' &&
        workflowEvidence.length === 2 &&
        repaired?.complete === true;
      return {
        outcome: completed ? 'completed' : 'unknown',
        evidence,
        stop,
        projection,
        nativeAcceptance: completed ? source(repaired.manifest) : null,
      };
    },
  };
}
