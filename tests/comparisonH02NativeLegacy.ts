import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServerSessions } from '../adapters/codex/appServerSessions.js';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { inspectChatPeer } from '../adapters/codex/chatPeer.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { verifyComparisonMaterial } from '../adapters/project/comparisonInputs.js';
import { object, parseConnection, requireWorkflow, textField } from '../core/connection.js';
import { digest } from '../adapters/storage/storeCodec.js';
import type { AgentSession } from '../core/dataRoute.js';
import type { InputRef, RunSpec } from '../core/localRun.js';
import type { H01BackendAdapter } from './comparisonH01Contract.js';
import { h01ReadJson, h01ReadPin, h01Record } from './comparisonH01Contract.js';
import { h02Material, h02PreparedMetadata } from './comparisonH02Contract.js';
import {
  runH02LegacyCase,
  type H02LegacyContext,
  type H02LegacyRpcTurn,
} from './comparisonH02Legacy.js';
import { createH02NativeRpc } from './comparisonH02NativeRpc.js';

/** Native ports for the already implemented Legacy H02 case; no H01 grant or overlay. */
export function createH02NativeLegacyAdapter(): H01BackendAdapter {
  return {
    async execute(ctx) {
      requireWorkflow(
        ctx.criteria.value.id === 'H-02' && ctx.variant === 'baseline',
        'h02-native-legacy-context',
      );
      const evidence: InputRef[] = [],
        ports = new Map<
          string,
          { resource: ReturnType<typeof createH02NativeRpc>; sessions: AppServerSessions }
        >(),
        owners = new Map<string, string>();
      const counts = { threadStarts: 0, turnStarts: 0 },
        observed: H02LegacyRpcTurn[] = [];
      const record = (label: string, value: unknown) => {
        const ref = h01Record(ctx.roots.evidenceRoot, 'h02-legacy-' + label, value);
        evidence.push(ref);
        return ref;
      };
      let caseReport: InputRef | null = null,
        nativeAcceptance: InputRef | null = null,
        outcome: 'completed' | 'failed' | 'unknown' = 'unknown',
        stopPromise:
          | Promise<{ readersStopped: boolean; transportClosed: boolean; evidence: InputRef[] }>
          | undefined;
      const stop = () =>
        (stopPromise ??= (async () => {
          const results = await Promise.allSettled(
            [...ports.values()].map((port) => port.resource.stop()),
          );
          let readersStopped = true,
            transportClosed = true;
          const sessions: string[] = [],
            remainingProcesses: unknown[] = [];
          for (const result of results) {
            if (result.status === 'rejected') {
              readersStopped = false;
              transportClosed = false;
              record('stop-error', { kind: 'h02-native-legacy-stop-unknown' });
              continue;
            }
            evidence.push(result.value);
            try {
              const primary = object(h01ReadJson(result.value));
              requireWorkflow(
                primary.kind === 'comparison-h02-stop' &&
                  primary.executionVersion === 2 &&
                  primary.opId === ctx.opId &&
                  Array.isArray(primary.sessions) &&
                  Array.isArray(primary.remainingProcesses),
                'h02-native-legacy-stop-binding',
              );
              readersStopped &&= primary.confirmed === true && primary.readersStopped === true;
              transportClosed &&= primary.transportClosed === true;
              sessions.push(...(primary.sessions as unknown[]).map(textField));
              remainingProcesses.push(...(primary.remainingProcesses as unknown[]));
            } catch {
              readersStopped = false;
              transportClosed = false;
              record('stop-error', {
                kind: 'h02-native-legacy-stop-unknown',
                primary: result.value,
              });
            }
          }
          const aggregate = record('stop', {
            kind: 'comparison-h02-stop',
            executionVersion: 2,
            opId: ctx.opId,
            confirmed: readersStopped && transportClosed && remainingProcesses.length === 0,
            readersStopped,
            transportClosed,
            sessions,
            remainingProcesses,
            evidence: [...evidence],
          });
          return { readersStopped, transportClosed, evidence: [aggregate] };
        })());
      try {
        ctx.signal.throwIfAborted();
        await ctx.nativeObserver.verify();
        ctx.signal.throwIfAborted();
        const descriptor = ctx.runtime.files.find(
          (ref) => ref.locator === join(ctx.runtime.root, 'project/workflow.json'),
        );
        requireWorkflow(descriptor !== undefined, 'h02-native-legacy-descriptor-unpinned');
        const project = parseConnection(h01ReadJson(descriptor));
        const procedures = project.procedures.filter((procedure) =>
          ['bootstrap', 'data-roles', 'evidence', 'boundary-review', 'council'].includes(
            procedure.id,
          ),
        );
        requireWorkflow(procedures.length === 5, 'h02-native-legacy-procedures-incomplete');
        const prepared = {
          ...h02Material.files,
          ...h02PreparedMetadata(
            h01ReadPin(ctx.rules).toString(),
            h01ReadPin(ctx.reviewer).toString(),
          ),
        };
        for (const procedure of procedures) {
          const source = ctx.runtime.files.find(
            (ref) => ref.locator === join(ctx.runtime.root, procedure.locator),
          );
          requireWorkflow(
            source !== undefined && source.hash === procedure.hash,
            'h02-native-legacy-procedure-unpinned',
          );
          prepared[procedure.locator] = h01ReadPin(source).toString();
        }
        await verifyComparisonMaterial(ctx.roots.workspaceRoot, prepared, h02Material.mutable);
        ctx.signal.throwIfAborted();
        const inputs = new FileWorkflowInputs(ctx.roots.workspaceRoot, ctx.roots.evidenceRoot),
          assignment = await inputs.ref('.h02/task.md'),
          rule = await inputs.ref('.h02/rules.md');
        requireWorkflow(
          readFileSync(join(ctx.roots.workspaceRoot, '.h02/rules.md')).equals(
            h01ReadPin(ctx.rules),
          ),
          'h02-native-legacy-rules-changed',
        );
        const projectId = 'h02-' + digest(ctx.opId).slice(0, 16);
        const spec: RunSpec = {
          project_id: projectId,
          identity: { assignment_id: ctx.opId },
          assignment,
          product: false,
          run_id: ctx.opId,
          session_id: ctx.identity.owner,
          host_id: 'local',
          workspace: ctx.roots.workspaceRoot,
          parent_run_id: null,
          coordinator: false,
          role: null,
          fork_turns: 'none',
          scope: ['pricing.json'],
          outcome: h02Material.instructions,
          criteria: [...ctx.criteria.value.checks],
          writer: ctx.identity.owner,
          requested: {
            model: ctx.profile.model,
            effort: ctx.profile.effort,
            permissions: ['read'],
          },
          effective: {
            model: ctx.profile.model,
            effort: ctx.profile.effort,
            permissions: ['read'],
          },
          sources: [assignment, rule],
          rules: [rule],
          procedures,
          route: { kind: 'nonproduct' },
        };
        const owner = (id: string) => {
          const role = owners.get(id);
          requireWorkflow(role !== undefined, 'h02-native-legacy-session-unknown');
          return ports.get(role)!;
        };
        const rpc: AppServerRpc = {
          request: (method, params) =>
            owner(textField(params.threadId)).resource.rpc.request(method, params),
          completed: (id, turn, signal, verify) =>
            owner(id).resource.rpc.completed(id, turn, signal, verify),
        };
        const context: H02LegacyContext = {
          workspaceRoot: ctx.roots.workspaceRoot,
          evidenceRoot: ctx.roots.evidenceRoot,
          spec,
          configuration: {
            catalog: '.h02/roles.md',
            profiles: Object.fromEntries(
              ['pricing', 'logging', 'storage'].map((role) => [role, '.h02/' + role + '.md']),
            ),
          },
          inputs,
          rpc,
          counts: () => ({ ...counts }),
          observations: () => structuredClone(observed),
          stop,
          signal: ctx.signal,
          nativeSessions: {
            async create(profile) {
              requireWorkflow(
                ['pricing', 'logging', 'storage'].includes(profile.reason) &&
                  !ports.has(profile.reason) &&
                  profile.model === ctx.profile.model &&
                  profile.effort === ctx.profile.effort,
                'h02-native-legacy-role',
              );
              const resource = createH02NativeRpc(ctx, 'legacy-' + profile.reason);
              const tracked: AppServerRpc = {
                async request(method, params) {
                  const response = await resource.rpc.request(method, params);
                  if (method === 'thread/start') {
                    counts.threadStarts++;
                    owners.set(textField(object(object(response).thread).id), profile.reason);
                  }
                  if (method === 'turn/start') {
                    counts.turnStarts++;
                    const text = textField(object((params.input as unknown[])[0]).text);
                    requireWorkflow(
                      text.includes('Пути и хеши: ') ||
                        text.includes('Council review request file: '),
                      'h02-native-legacy-turn-purpose',
                    );
                    observed.push({
                      role: profile.reason,
                      session: textField(params.threadId),
                      turn: textField(object(object(response).turn).id),
                      kind: text.includes('Пути и хеши: ') ? 'load' : 'review',
                    });
                  }
                  return response;
                },
                completed: (...args) => resource.rpc.completed(...args),
              };
              const sessions = new AppServerSessions(
                tracked,
                ctx.roots.workspaceRoot,
                projectId,
                ctx.roots.evidenceRoot,
                null,
                null,
              );
              ports.set(profile.reason, { resource, sessions });
              return sessions.create(profile);
            },
            async inspect(id): Promise<AgentSession> {
              const port = owner(id),
                thread = object(
                  object(
                    await port.resource.rpc.request('thread/read', {
                      threadId: id,
                      includeTurns: true,
                    }),
                  ).thread,
                );
              requireWorkflow(
                Array.isArray(thread.turns) && thread.turns.length > 0,
                'h02-native-legacy-primary-turn-missing',
              );
              const turn = textField(object(thread.turns.at(-1)).id);
              return inspectChatPeer(
                port.resource.rpc,
                {
                  project_id: null,
                  peer_observations: {
                    [id]: {
                      root: ctx.roots.workspaceRoot,
                      transcript: textField(thread.path),
                      anchor: {
                        thread_id: id,
                        turn_id: turn,
                        workspace: ctx.roots.workspaceRoot,
                        host_id: 'local',
                      },
                    },
                  },
                },
                id,
                ctx.roots.evidenceRoot,
                undefined,
                projectId,
              );
            },
            load: (session, query) => owner(session.id).sessions.load(session, query),
            send: (session, brief, key) => owner(session.id).sessions.send(session, brief, key),
            recoverSend: (session, key) => owner(session.id).sessions.recoverSend(session, key),
            poll: (session, turn) => owner(session.id).sessions.poll(session, turn),
            verifyReview: (session, request, turn, answer) =>
              owner(session.id).sessions.verifyReview(session, request, turn, answer),
          },
        };
        const result = await runH02LegacyCase(context);
        caseReport = result.manifest;
        nativeAcceptance = result.rounds.corrected;
        evidence.push(result.manifest, ...result.evidence);
        if (
          result.outcome === 'accepted' &&
          !ctx.signal.aborted &&
          !ctx.nativeObserver.accounting().unknown
        )
          outcome = 'completed';
        else if (result.outcome === 'failed' && !ctx.signal.aborted) outcome = 'failed';
      } catch {
        record('failure', { kind: 'h02-native-legacy-unknown', opId: ctx.opId });
      }
      const stopped = await stop();
      if (!stopped.readersStopped || !stopped.transportClosed || ctx.signal.aborted)
        outcome = 'unknown';
      if (caseReport === null)
        caseReport = record('not-run', {
          kind: 'comparison-h02-native-case-not-run',
          opId: ctx.opId,
          outcome: 'unknown',
        });
      const projection = record('projection', {
        kind: 'comparison-h02-native-projection',
        scenario: 'H-02',
        opId: ctx.opId,
        engine: 'legacy',
        caseReport,
      });
      return {
        outcome,
        evidence: [...evidence, ...[...ports.values()].flatMap((port) => port.resource.evidence)],
        stop: stopped.evidence[0]!,
        projection,
        nativeAcceptance,
      };
    },
  };
}
