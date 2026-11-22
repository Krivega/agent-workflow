import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  comparisonSession,
  type ComparisonH01SessionControls,
} from '../adapters/codex/comparisonSession.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import type { ProcessIdentity } from '../ports/writerProcesses.js';
import type { InputRef } from '../core/localRun.js';
import { confirmLoad } from '../core/localRun.js';
import { evidenceSchema, type TechnicalState } from '../core/evidence.js';
import { compareInputs, targetEvidenceInputs } from '../core/evidence.js';
import type { EvidenceStore } from '../ports/evidenceStore.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { executionBlockers } from '../core/execution.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { councilCurrentProfileRefs } from '../core/council.js';
import { readLegacyArchive } from './temporal/legacyArchive.js';
import {
  h01ReadJson,
  h01ReadPin,
  h01RawFile,
  h01Record,
  h01TaskPaths,
  type H01AttemptContext,
  type H01BackendAdapter,
  type H01BackendResult,
  type H01NativeObservation,
  type H01ModelStart,
  type H01StopObservation,
} from './comparisonH01Contract.js';

export async function runH01NativeSession(
  context: H01AttemptContext,
  stage: 'execution' | 'council',
  brief: string,
): Promise<H01BackendResult & { text: string }> {
  const observer = context.nativeObserver,
    disabled = [...(context.disabledMcpServers ?? [])];
  await observer.verify();
  const origin = stage === 'execution' ? 'legacy' : 'common-council';
  const directory = resolve(context.roots.evidenceRoot, origin + '-session');
  const evidence: InputRef[] = [],
    creations = new Map<string, InputRef>();
  const alreadyKnown = new Set(
    observer.accounting().participants.map((participant) => participant.session),
  );
  let capabilities: unknown,
    sequence = 0;
  const record = (label: string, value: unknown) => {
    const ref = h01Record(context.roots.evidenceRoot, origin + '-' + label, value);
    evidence.push(ref);
    return ref;
  };
  const participant = (thread: Record<string, unknown>, pathObservation?: InputRef) => {
    const session = textField(thread.id),
      creation = creations.get(session);
    requireWorkflow(creation !== undefined, 'h01-unexpected-participant');
    if (typeof thread.path !== 'string' || thread.path.length === 0) return;
    observer.registerParticipant({
      session,
      transcript: thread.path,
      run: context.opId,
      stage,
      creation,
      ...(pathObservation ? { pathObservation } : {}),
    });
  };
  const observe = (value: Parameters<typeof observer.observeParticipant>[0]) => {
    const known = observer
      .accounting()
      .participants.find(
        (entry) =>
          entry.session === value.session &&
          entry.transcript === value.transcript &&
          entry.run === value.run,
      );
    observer.observeParticipant(known ? { ...value, stage: known.stage } : value);
  };
  const controls: ComparisonH01SessionControls = {
    controlRef: observer.controlRef,
    signal: context.signal,
    async dispatch(method, params, send) {
      if (['turn/start', 'thread/start', 'thread/resume'].includes(method))
        context.signal.throwIfAborted();
      let start: H01ModelStart | undefined;
      if (method === 'turn/start') {
        const session = textField(params.threadId);
        start = {
          origin,
          session,
          stage,
          key: digest(canonical([context.opId, origin, session, ++sequence])),
          hash: digest(canonical(params)),
        };
        await observer.beforeModelStart(start);
      }
      if (['turn/start', 'thread/start', 'thread/resume'].includes(method))
        context.signal.throwIfAborted();
      const response = await send();
      if (method === 'mcpServerStatus/list') {
        capabilities = response;
        record('capability-inventory', {
          kind: 'h01-native-dispatch',
          method,
          params,
          response,
        });
      }
      if (method === 'thread/start' || method === 'thread/resume') {
        const observation: H01NativeObservation = {
          kind: 'h01-native-dispatch',
          method,
          params,
          response,
        };
        const creation = record('creation', observation),
          thread = object(object(response).thread),
          session = textField(thread.id);
        creations.set(session, creation);
        observer.registerCreation({
          session,
          run: context.opId,
          stage,
          creation,
        });
        requireWorkflow(capabilities !== undefined, 'h01-capabilities-missing');
        const capability = record('capabilities', {
          kind: 'h01-native-capabilities',
          session,
          response: capabilities,
        });
        observer.registerCapabilities({
          session,
          evidence: capability,
          disabled,
        });
        participant(thread);
      } else if (method === 'thread/read') {
        const thread = object(object(response).thread);
        const path = record('path', {
          kind: 'h01-native-dispatch',
          method,
          params,
          response,
        });
        participant(thread, path);
      } else if (start !== undefined) {
        const observation: H01NativeObservation = {
          kind: 'h01-native-dispatch',
          method: 'turn/start',
          start,
          params,
          response,
        };
        const ref = record('dispatch', observation);
        observer.confirmModelStart({
          key: start.key,
          session: start.session,
          turn: textField(object(object(response).turn).id),
          evidence: ref,
        });
      }
      return response;
    },
    createdParticipant(value) {
      observe(value);
    },
    observedParticipant(value) {
      observe(value);
    },
    modelProbe(response) {
      record('model-probe', {
        kind: 'h01-native-model-probe',
        profile: context.profile,
        response,
      });
    },
  };
  let outcome: H01BackendResult['outcome'] = 'unknown',
    text = '',
    nativeAcceptance: InputRef | null = null;
  let confirmed = false,
    reason = 'Native execution has no confirmed stop';
  try {
    const result = await comparisonSession(
      {
        binary: context.binary.locator,
        directory,
        workspace: context.roots.workspaceRoot,
        state_root: context.roots.stateRoot,
        operation: `h01-v2:${context.opId}:${stage}`,
        profile: context.profile,
        read_only: stage === 'council',
        brief: canonical({
          kind: 'h01-native-brief',
          opId: context.opId,
          requestHash: context.requestHash,
          rules: {
            ref: context.rules,
            content: h01ReadPin(context.rules).toString('utf8'),
          },
          role: {
            ref: stage === 'execution' ? context.executor : context.reviewer,
            content: h01ReadPin(
              stage === 'execution' ? context.executor : context.reviewer,
            ).toString('utf8'),
          },
          instruction: brief,
        }),
        run: context.opId,
        stage,
        h01_control: observer.controlRef,
        disabled_mcp_servers: disabled,
      },
      () => {
        throw new Error('h01-uncontrolled-participant');
      },
      () => observer.verify(),
      controls,
    );
    evidence.push(result.source);
    const answer = object(h01ReadJson(result.source)),
      stopped = object(answer.stopped);
    const stop: InputRef = {
      locator: textField(stopped.locator),
      hash: textField(stopped.hash),
    };
    const proof = object(h01ReadJson(stop)),
      owned = object(proof.owned),
      runtime = object(owned.runtime);
    requireWorkflow(
      proof.kind === 'writers-stopped' &&
        proof.active_turn === false &&
        proof.remaining_terminals === 0 &&
        proof.remaining_processes === 0 &&
        proof.before_hash === proof.after_hash &&
        Array.isArray(proof.processes),
      'h01-native-stop-unconfirmed',
    );
    const live = await new NativeWriterProcesses().alive([
      ...(proof.processes as ProcessIdentity[]),
      runtime.process as ProcessIdentity,
    ]);
    requireWorkflow(live.length === 0, 'h01-native-stop-unconfirmed');
    evidence.push(stop);
    confirmed = true;
    text = result.text;
    outcome = result.status === 'completed' ? 'completed' : 'failed';
    if (stage === 'council') nativeAcceptance = result.source;
  } catch (error) {
    reason = error instanceof Error ? error.message : 'Native execution outcome unknown';
    record('failure', { kind: 'h01-native-failure', reason });
    const stateFile = resolve(directory, 'session.json');
    if (existsSync(stateFile)) {
      const state = object(JSON.parse(h01RawFile(stateFile).toString('utf8')));
      if (state.runtime !== null && state.runtime !== undefined) {
        const runtime = object(state.runtime);
        try {
          confirmed =
            (await new NativeWriterProcesses().alive([runtime.process as ProcessIdentity]))
              .length === 0 && observer.accounting().reservedManagedStarts === 0;
          if (confirmed) outcome = 'failed';
        } catch {
          confirmed = false;
        }
      }
    }
  }
  const sessions = [
    ...new Set([
      ...creations.keys(),
      ...observer
        .accounting()
        .participants.filter((p) => !alreadyKnown.has(p.session))
        .map((p) => p.session),
    ]),
  ];
  const observation: H01StopObservation = {
    kind: 'comparison-h01-stop',
    executionVersion: 2,
    opId: context.opId,
    confirmed,
    sessions,
    remainingProcesses: [],
    evidence: [...evidence],
    ...(confirmed ? {} : { reason }),
  };
  const stop = record('stop', observation);
  for (const session of sessions)
    observer.completeParticipant(session, {
      outcome,
      stop,
      evidence: [...evidence],
    });
  if (!confirmed || observer.accounting().unknown) outcome = 'unknown';
  const projection = record('projection-unknown', {
    kind: 'h01-projection-unknown',
    opId: context.opId,
    reason: 'A native session alone does not prove a framework card projection',
  });
  return { outcome, evidence, stop, projection, nativeAcceptance, text };
}

export async function verifyH01LegacyOutcome(context: H01AttemptContext): Promise<InputRef> {
  const taskRoot = resolve(context.roots.stateRoot, 'legacy-task');
  const nativeState = object(
    JSON.parse(
      h01RawFile(resolve(context.roots.evidenceRoot, 'legacy-session/session.json')).toString(),
    ),
  );
  const nativeAnswer = nativeState.answer as InputRef;
  const answer = object(h01ReadJson(nativeAnswer)),
    principal = textField(object(nativeState.session).id);
  requireWorkflow(
    answer.thread === principal && answer.status === 'completed',
    'h01-legacy-principal',
  );
  const participant = context.nativeObserver
    .accounting()
    .participants.find(
      (p) => p.session === principal && p.run === context.opId && p.stage === 'execution',
    );
  requireWorkflow(participant !== undefined, 'h01-legacy-principal');
  const raw = readLegacyArchive({
    schemaVersion: 1,
    root: resolve(taskRoot, 'store'),
  });
  const state = raw.state as TechnicalState;
  const checkpoint: EvidenceStore = {
    execute: async () => ({ ok: true, value: state }),
  };
  const expectedRun = 'chat-' + digest(taskRoot).slice(0, 20);
  const captured = await new TaskChatContext(
    checkpoint,
    {
      schema_version: evidenceSchema,
      project_id: String(raw.identity.project),
      task_id: context.identity.taskId,
      subtask_id: null,
      actor_id: principal,
      run_id: expectedRun,
    },
    context.identity.generation,
  ).read({ archive: true });
  const { run, workflow } = captured,
    execution = workflow.execution;
  requireWorkflow(
    raw.identity.task === context.identity.taskId &&
      state.generation === context.identity.generation &&
      state.owner === principal &&
      state.frozen === false &&
      run.generation === context.identity.generation &&
      run.status === 'ready' &&
      run.spec.session_id === principal &&
      run.spec.run_id === expectedRun &&
      run.spec.workspace === context.roots.workspaceRoot &&
      run.spec.project_id === raw.identity.project &&
      run.spec.project_id === 'h01-' + digest(context.opId).slice(0, 16) &&
      'task_id' in run.spec.identity &&
      run.spec.identity.task_id === context.identity.taskId &&
      isDeepStrictEqual(run.spec.scope, ['range.mjs']) &&
      run.spec.outcome ===
        `${context.criteria.value.task}\n\n${context.material.value.instructions}` &&
      run.loaded !== null,
    'h01-legacy-run-binding',
  );
  requireWorkflow(
    run.spec.requested.model === context.profile.model &&
      run.spec.requested.effort === context.profile.effort &&
      run.spec.effective?.model === context.profile.model &&
      run.spec.effective.effort === context.profile.effort &&
      run.spec.rules.some(
        (ref) => ref.locator === h01TaskPaths.rules && ref.hash === context.rules.hash,
      ) &&
      [context.executor, context.reviewer].every((ref) =>
        run.spec.sources.some((source) => source.hash === ref.hash),
      ),
    'h01-legacy-profile-binding',
  );
  confirmLoad(run, run.loaded);
  const host = new FileCurrentChatHost(context.roots.workspaceRoot, participant.transcript, {
    thread_id: principal,
    turn_id: textField(answer.turn),
    workspace: context.roots.workspaceRoot,
    host_id: 'local',
  });
  const reads: unknown = JSON.parse(run.loaded.observed_read);
  requireWorkflow(Array.isArray(reads) && reads.length > 0, 'h01-legacy-load-missing');
  for (const source of reads) await host.reference(source as InputRef);
  requireWorkflow(
    execution !== null &&
      execution.status === 'done' &&
      execution.task_id === context.identity.taskId &&
      execution.generation === context.identity.generation &&
      execution.result !== null &&
      execution.baseline !== null &&
      execution.acceptance !== null &&
      execution.target.scope === run.spec.outcome &&
      execution.result.scope === run.spec.outcome &&
      executionBlockers(execution).length === 0 &&
      raw.effects.every((value) => !['pending', 'unknown'].includes(String(object(value).outcome))),
    'h01-legacy-done-missing',
  );
  const events = execution.history.map((entry) => object(JSON.parse(entry.payload)));
  const result = events.map((event) => event.type).lastIndexOf('RESULT');
  const done = events.at(-1);
  requireWorkflow(
    result >= 0 &&
      result < events.length - 1 &&
      done?.type === 'DONE' &&
      done.generation === context.identity.generation &&
      done.expected_revision === execution.revision - 1 &&
      isDeepStrictEqual(events[result]!.result, execution.result),
    'h01-legacy-history-binding',
  );
  const last = object(raw.events.at(-1)),
    eventContext = object(last.context);
  requireWorkflow(
    last.revision === state.revision &&
      eventContext.actor_id === principal &&
      eventContext.task_id === context.identity.taskId &&
      eventContext.run_id === expectedRun &&
      raw.operations.some(
        (value) =>
          object(value).operation_id === last.operation_id &&
          object(value).catalog_revision === state.revision,
      ),
    'h01-legacy-store-event-binding',
  );
  const files = new FileWorkflowInputs(context.roots.workspaceRoot, context.roots.stateRoot);
  requireWorkflow(
    compareInputs(
      execution.target.inputs,
      await files.current(execution.target.inputs, run.projection),
    ) === 'applicable',
    'h01-legacy-result-stale',
  );
  if (execution.target.evidence_inputs !== undefined)
    requireWorkflow(
      compareInputs(
        targetEvidenceInputs(execution.target),
        await files.current(execution.target.evidence_inputs, run.projection),
      ) === 'applicable',
      'h01-legacy-evidence-stale',
    );
  await files.verify(
    [
      execution.target.diff,
      ...execution.checks.map((check) => check.evidence),
      execution.baseline.evidence,
      ...execution.result.evidence,
      run.spec.assignment,
      ...[execution.planning, execution.acceptance]
        .filter((council) => council !== null)
        .flatMap(councilCurrentProfileRefs),
    ],
    run.projection,
  );
  requireWorkflow(
    run.projection?.result.status === 'confirmed' &&
      run.projection.plan.task_id === context.identity.taskId,
    'h01-legacy-projection-missing',
  );
  requireWorkflow(
    'task_id' in run.spec.identity &&
      run.spec.identity.card.locator === run.projection.result.locator &&
      run.spec.identity.card.hash === run.projection.result.revision,
    'h01-legacy-projection-binding',
  );
  const snapshot = h01Record(context.roots.evidenceRoot, 'legacy-store-snapshot', raw);
  return h01Record(context.roots.evidenceRoot, 'legacy-engine-result', {
    kind: 'h01-legacy-engine-result',
    opId: context.opId,
    requestHash: context.requestHash,
    nativeAnswer,
    snapshot,
    database: {
      locator: resolve(taskRoot, 'store/store.sqlite'),
      hash: raw.database.sha256,
    },
    projection: run.projection,
  });
}

export function createH01LegacyAdapter(): H01BackendAdapter {
  return {
    async execute(context) {
      requireWorkflow(
        context.variant === 'baseline' && context.bootstrap.engine === 'legacy',
        'h01-legacy-engine',
      );
      requireWorkflow(
        context.bootstrap.runtimeRoot === resolve(context.roots.stateRoot, 'legacy-runtime'),
        'h01-legacy-runtime-scope',
      );
      h01ReadPin(context.binary);
      const task =
        `${context.criteria.value.task}\n${context.material.value.instructions}\n` +
        `Only ${context.material.value.mutable.join(', ')} may change. Keep checks.mjs/package.json/consumers and ${h01TaskPaths.basis} unchanged.\n` +
        `Use ONLY the pinned managed legacy agent-workflow at ${context.bootstrap.runtimeRoot}. ` +
        `Task workspace: ${context.roots.workspaceRoot}; managed state: ${context.roots.stateRoot}. ` +
        `Every managed CLI request must explicitly use binary=${JSON.stringify(context.binary.locator)}, ` +
        `model=${JSON.stringify(context.profile.model)}, effort=${JSON.stringify(context.profile.effort)}; no PATH/default binary. ` +
        'No standalone Codex CLI, native multi_agent, model helpers outside managed workflow, network, publication, background work or new authority. ' +
        'Preserve primary LOAD/READY/native council/check/stop evidence. Missing supported route is NOT RUN, never substitute a local double. Return summary and limitations.';
      const result = await runH01NativeSession(
        context,
        'execution',
        task +
          ` Use existing task-chat with --state ${resolve(context.roots.stateRoot, 'legacy-task')}, ` +
          `--card ${h01TaskPaths.card}. Exact task=${context.identity.taskId}, generation=${context.identity.generation}; ` +
          '--local-plan .comparison/legacy-plan.json --council-selection .comparison/legacy-selection.json. ' +
          `LOAD pinned rules ${h01TaskPaths.rules} and include ${h01TaskPaths.executor}/${h01TaskPaths.reviewer} in sources. ` +
          'A direct edit/summary without real legacy Store RESULT then DONE is not a legacy result.',
      );
      if (result.outcome === 'completed') {
        try {
          const projection = await verifyH01LegacyOutcome(context);
          return {
            ...result,
            projection,
            evidence: [...result.evidence, projection],
          };
        } catch (error) {
          const projection = h01Record(context.roots.evidenceRoot, 'legacy-proof-unknown', {
            kind: 'h01-projection-unknown',
            opId: context.opId,
            reason: String(error),
          });
          return {
            ...result,
            outcome: 'unknown',
            projection,
            evidence: [...result.evidence, projection],
          };
        }
      }
      return result;
    },
  };
}
