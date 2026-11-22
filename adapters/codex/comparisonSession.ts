import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import type { InputRef } from '../../core/localRun.js';
import { sameValue } from '../../core/equality.js';
import { StdioAppServer } from './appServerTransport.js';
import { AppServerSessions } from './appServerSessions.js';
import { nativeCreationProof, readDeliveryReceipt } from './transportJournal.js';
import { readManaged, saveManaged } from '../storage/managedChatFiles.js';
import { canonical, digest } from '../storage/storeCodec.js';
import type { ComparisonParticipant } from './comparisonUsage.js';
import type { AgentSession } from '../../core/dataRoute.js';
import { NativeWriterProcesses } from './writerProcesses.js';
import { AppServerWriters, ownedRuntimeProcesses } from './appServerWriters.js';
import { assertCoderCapabilities } from './coderCapabilities.js';
import { writerScopeHash } from '../project/writerScope.js';
import type { ProcessIdentity } from '../../ports/writerProcesses.js';
import { readPrivateFile } from '../storage/storeFiles.js';
import { comparisonParticipants } from './comparisonParticipants.js';
import { comparisonCompaction } from './comparisonCompaction.js';
import { FileCurrentChatHost } from './currentChatHost.js';

export interface ComparisonSessionRequest {
  binary: string;
  directory: string;
  workspace: string;
  state_root: string;
  operation: string;
  profile: { model: string; effort: string };
  read_only: boolean;
  brief: string;
  run: string;
  stage: 'execution' | 'council';
  h01_control?: InputRef;
  disabled_mcp_servers?: string[];
}
export interface ComparisonH01SessionControls {
  controlRef: InputRef;
  signal: AbortSignal;
  dispatch(
    method: string,
    params: Record<string, unknown>,
    send: () => Promise<unknown>,
  ): Promise<unknown>;
  createdParticipant(participant: ComparisonParticipant): void;
  observedParticipant(participant: ComparisonParticipant): void;
  modelProbe(response: unknown): void;
}
interface SessionState {
  schema_version: 1;
  request_hash: string;
  session: { id: string; path: string } | null;
  turn: string | null;
  answer: InputRef | null;
  runtime: { process: ProcessIdentity; policy: InputRef } | null;
  preparation_turn: string | null;
  compaction_intent: boolean;
  compaction: InputRef | null;
}

export async function comparisonSession(
  request: ComparisonSessionRequest,
  register: (participant: ComparisonParticipant) => void,
  verify: () => Promise<void>,
  controls?: ComparisonH01SessionControls,
) {
  const h01 = request.operation.startsWith('h01-v2:');
  let disabled: string[] = [];
  requireWorkflow(h01 === (request.h01_control !== undefined), 'comparison-h01-control-required');
  if (h01) {
    const declared = request.disabled_mcp_servers === undefined ? [] : request.disabled_mcp_servers;
    requireWorkflow(
      Array.isArray(declared) &&
        declared.every((name) => typeof name === 'string' && /^[A-Za-z0-9_-]+$/u.test(name)) &&
        new Set(declared).size === declared.length,
      'comparison-mcp-targets-invalid',
    );
    disabled = [...declared];
    if (request.disabled_mcp_servers !== undefined)
      request = { ...request, disabled_mcp_servers: disabled };
    requireWorkflow(
      controls !== undefined && sameValue(controls.controlRef, request.h01_control),
      'comparison-h01-control-required',
    );
    requireWorkflow(
      digest(readPrivateFile(controls.controlRef.locator)) === controls.controlRef.hash,
      'comparison-h01-control-changed',
    );
    controls.signal.throwIfAborted();
  }
  await mkdir(request.directory, { recursive: true, mode: 0o700 });
  const path = resolve(request.directory, 'session.json');
  const previous = readManaged<SessionState>(path);
  if (h01) requireWorkflow(previous === null, 'comparison-h01-session-reuse');
  const state: SessionState = previous ?? {
    schema_version: 1,
    request_hash: digest(canonical(request)),
    session: null,
    turn: null,
    answer: null,
    runtime: null,
    preparation_turn: null,
    compaction_intent: false,
    compaction: null,
  };
  requireWorkflow(
    state.schema_version === 1 && state.request_hash === digest(canonical(request)),
    'comparison-session-conflict',
  );
  if (previous === null) saveManaged(path, state, false);
  const processes = new NativeWriterProcesses();
  const validateStop = async (ref: InputRef) => {
    const proof = readManaged<Record<string, unknown>>(ref.locator);
    requireWorkflow(
      state.runtime !== null &&
        state.session !== null &&
        ref.locator === resolve(request.directory, 'stopped.json') &&
        proof !== null &&
        digest(readPrivateFile(ref.locator)) === ref.hash,
      'comparison-stop-unconfirmed',
    );
    const owned = object(proof.owned);
    requireWorkflow(
      proof.kind === 'writers-stopped' &&
        owned.thread === state.session.id &&
        owned.tree === resolve(request.workspace, '..') &&
        sameValue(owned.runtime, {
          process: state.runtime.process,
          policy: state.runtime.policy,
        }) &&
        sameValue(owned.markers, [state.runtime.policy.locator]) &&
        proof.active_turn === false &&
        proof.remaining_terminals === 0 &&
        proof.remaining_processes === 0 &&
        proof.before_hash === proof.after_hash &&
        proof.after_hash ===
          (await writerScopeHash(owned.markers as string[], owned.tree as string)) &&
        Array.isArray(proof.processes) &&
        (await processes.alive([...(proof.processes as ProcessIdentity[]), state.runtime.process]))
          .length === 0,
      'comparison-stop-unconfirmed',
    );
    return ref;
  };
  if (state.answer !== null) {
    const answer = readManaged<{ text: string; status: string; stopped: InputRef }>(
      state.answer.locator,
    );
    requireWorkflow(
      answer !== null && digest(canonical(answer) + '\n') === state.answer.hash,
      'comparison-answer-changed',
    );
    await validateStop(answer.stopped);
    return { text: answer.text, status: answer.status, source: state.answer };
  }
  const journal = resolve(request.directory, 'transport.jsonl');
  const operation = `comparison:${request.operation}:create`;
  if (h01) controls!.signal.throwIfAborted();
  const rpc = new StdioAppServer(
    request.binary,
    h01
      ? [
          '-c',
          'features.apps=false',
          '-c',
          'features.plugins=false',
          '-c',
          'features.multi_agent=false',
          ...disabled.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
          'app-server',
          '--stdio',
        ]
      : ['app-server'],
    request.workspace,
    journal,
    operation,
  );
  if (h01) {
    const send = rpc.request.bind(rpc);
    rpc.request = (method, params) =>
      controls!.dispatch(method, params, () => send(method, params));
  }
  let stopped: InputRef | null = null;
  const current = async () => {
    await verify();
    await comparisonParticipants(
      rpc,
      [request.workspace, request.state_root],
      request.run,
      h01 ? controls!.observedParticipant : register,
    );
    await verify();
  };
  const stop = async (): Promise<InputRef> => {
    requireWorkflow(state.session !== null && state.runtime !== null, 'comparison-writer-unbound');
    const path = resolve(request.directory, 'stopped.json');
    if (readManaged(path) !== null)
      return validateStop({ locator: path, hash: digest(readPrivateFile(path)) });
    const policy = readPrivateFile(state.runtime.policy.locator);
    const declared = object(JSON.parse(policy.toString('utf8')));
    requireWorkflow(
      digest(policy) === state.runtime.policy.hash &&
        sameValue(declared.runtime, state.runtime.process) &&
        declared.operation === request.operation &&
        declared.workspace === request.workspace &&
        declared.state_root === request.state_root,
      'comparison-writer-policy-changed',
    );
    const scope = await ownedRuntimeProcesses(
      rpc,
      processes,
      state.runtime.process,
      state.session.id,
      state.runtime.policy,
    );
    const response = object(
      await rpc.request('thread/backgroundTerminals/list', {
        threadId: state.session.id,
        limit: 100,
      }),
    );
    requireWorkflow(
      Array.isArray(response.data) &&
        (response.nextCursor === null || response.nextCursor === undefined),
      'comparison-terminals-incomplete',
    );
    const terminals = response.data.map(object).map((entry) => ({
      process: textField(entry.processId),
      pid: entry.osPid === null ? null : Number(entry.osPid),
    }));
    const current = object(
      object(await rpc.request('thread/read', { threadId: state.session.id, includeTurns: true }))
        .thread,
    );
    requireWorkflow(
      current.id === state.session.id && Array.isArray(current.turns),
      'comparison-native-history-unconfirmed',
    );
    const active = current.turns.map(object).filter((turn) => turn.status === 'inProgress');
    requireWorkflow(active.length <= 1, 'comparison-native-turn-unconfirmed');
    const bindings = [];
    for (const terminal of terminals.filter((terminal) => terminal.pid === null)) {
      const identities = await scope.processes.descendants([]);
      requireWorkflow(identities.length > 0, 'writer-process-binding-missing');
      const proof = {
        kind: 'process-binding',
        thread: state.session.id,
        terminal: terminal.process,
        scope_complete: true,
        processes: identities,
      };
      const ref = {
        locator: resolve(request.directory, `process-${digest(canonical(proof))}.json`),
        hash: digest(canonical(proof) + '\n'),
      };
      saveManaged(ref.locator, proof, false);
      bindings.push({ terminal: terminal.process, processes: identities, evidence: ref });
    }
    return new AppServerWriters(rpc, scope.processes).stop(
      {
        thread: state.session.id,
        turn: active.length === 0 ? state.turn : textField(active[0]!.id),
        terminals,
        bindings,
        markers: [state.runtime.policy.locator],
        tree: resolve(request.workspace, '..'),
        runtime: scope.runtime,
        complete: true,
      },
      path,
    );
  };
  try {
    await verify();
    await rpc.initialize();
    assertCoderCapabilities(
      await rpc.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' }),
      disabled,
    );
    if (state.runtime === null) {
      requireWorkflow(typeof rpc.pid === 'number', 'comparison-native-process-unknown');
      const runtime = (await processes.descendants([rpc.pid])).find(
        (entry) => entry.pid === rpc.pid,
      );
      requireWorkflow(
        runtime !== undefined && runtime.parent === process.pid,
        'comparison-native-process-unknown',
      );
      const proof = {
        runtime,
        operation: request.operation,
        workspace: request.workspace,
        state_root: request.state_root,
        ...(h01 ? { disabled_mcp_servers: disabled } : {}),
      };
      const policy = {
        locator: resolve(request.directory, `policy-${digest(canonical(proof))}.json`),
        hash: digest(canonical(proof) + '\n'),
      };
      saveManaged(policy.locator, proof, false);
      state.runtime = { process: runtime, policy };
      saveManaged(path, state, false);
    }
    if (h01) {
      const response = object(await rpc.request('model/list', {}));
      controls!.modelProbe(response);
      requireWorkflow(
        Array.isArray(response.data) &&
          response.data
            .map(object)
            .some(
              (model) =>
                model.model === request.profile.model &&
                Array.isArray(model.supportedReasoningEfforts) &&
                model.supportedReasoningEfforts
                  .map(object)
                  .some((effort) => effort.reasoningEffort === request.profile.effort),
            ),
        'comparison-model-unavailable',
      );
    }
    let creation = nativeCreationProof(journal, operation);
    if (creation === null) {
      requireWorkflow(previous === null, 'comparison-creation-outcome-unknown');
      await verify();
      await rpc.request('thread/start', {
        projectId: null,
        cwd: request.workspace,
        runtimeWorkspaceRoots: [request.workspace],
        sandbox: request.read_only ? 'read-only' : 'danger-full-access',
        approvalPolicy: 'never',
        ephemeral: false,
        allowProviderModelFallback: false,
        model: request.profile.model,
        selectedCapabilityRoots: [],
        multiAgentMode: 'explicitRequestOnly',
        config: {
          model_reasoning_effort: request.profile.effort,
          features: { apps: false, plugins: false, multi_agent: false },
          web_search: 'disabled',
          sandbox_workspace_write: {
            writable_roots: [request.workspace],
            network_access: false,
            exclude_slash_tmp: true,
            exclude_tmpdir_env_var: true,
          },
          sandbox_read_only: { network_access: false },
          shell_environment_policy: {
            inherit: 'none',
            include_only: ['PATH', 'LANG', 'LC_ALL'],
            set: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: request.workspace },
          },
        },
      });
      creation = nativeCreationProof(journal, operation);
    }
    requireWorkflow(
      creation?.response !== null && creation?.response !== undefined,
      'comparison-creation-outcome-unknown',
    );
    const response = object(creation.response.result),
      thread = object(response.thread),
      sandbox = object(response.sandbox);
    requireWorkflow(
      thread.projectId === null &&
        thread.parentThreadId === null &&
        thread.forkedFromId === null &&
        Array.isArray(thread.turns) &&
        thread.turns.length === 0 &&
        response.cwd === request.workspace &&
        response.model === request.profile.model &&
        response.reasoningEffort === request.profile.effort &&
        response.approvalPolicy === 'never' &&
        (request.read_only
          ? sandbox.type === 'readOnly' && sandbox.networkAccess === false
          : sandbox.type === 'dangerFullAccess'),
      'comparison-native-profile-unconfirmed',
    );
    const actual = { id: textField(thread.id), path: textField(thread.path) };
    requireWorkflow(
      state.session === null || sameValue(state.session, actual),
      'comparison-session-identity-mismatch',
    );
    state.session = actual;
    saveManaged(path, state, false);
    (h01 ? controls!.createdParticipant : register)({
      session: actual.id,
      transcript: actual.path,
      run: request.run,
      stage: request.stage,
    });
    const session = { id: actual.id } as AgentSession;
    const sessions = new AppServerSessions(
      rpc,
      request.workspace,
      'comparison',
      request.directory,
      null,
      null,
    );
    const delivery = `comparison:${request.operation}:turn`;
    if (request.stage === 'execution' && request.run.startsWith('H-03:')) {
      const preparatory = `comparison:${request.operation}:preparation`;
      if (state.preparation_turn === null) {
        const receipt = readDeliveryReceipt(journal, actual.id, preparatory);
        if (receipt !== null)
          state.preparation_turn = await sessions.recoverSend(session, preparatory);
        else {
          requireWorkflow(previous === null, 'comparison-delivery-outcome-unknown');
          await current();
          state.preparation_turn = await sessions.send(
            session,
            request.brief +
              '\nВ этом ходе выполни только подготовку: сохрани незавершённую задачу, F-01 и известную незавершённую операцию. Затем верни промежуточный результат. Сжатие выполнит среда; продолжение будет в следующем ходе того же сеанса.',
            preparatory,
          );
        }
        requireWorkflow(state.preparation_turn !== null, 'comparison-delivery-outcome-unknown');
        saveManaged(path, state, false);
      }
      await rpc.completed(actual.id, state.preparation_turn, controls?.signal, current);
      if (state.turn === null && readDeliveryReceipt(journal, actual.id, delivery) !== null) {
        state.turn = await sessions.recoverSend(session, delivery);
        requireWorkflow(state.turn !== null, 'comparison-delivery-outcome-unknown');
        saveManaged(path, state, false);
      }
      const host = new FileCurrentChatHost(request.workspace, actual.path, {
        thread_id: actual.id,
        turn_id: state.turn ?? state.preparation_turn,
        host_id: 'local',
        workspace: request.workspace,
      });
      if (state.compaction === null) {
        requireWorkflow(!state.compaction_intent, 'comparison-compaction-outcome-unknown');
        state.compaction_intent = true;
        saveManaged(path, state, false);
        state.compaction = await comparisonCompaction(rpc, host, actual.id, current);
        saveManaged(path, state, false);
      } else await host.reference(state.compaction);
    }
    if (state.turn === null) {
      const receipt = readDeliveryReceipt(journal, actual.id, delivery);
      if (receipt !== null) state.turn = await sessions.recoverSend(session, delivery);
      else {
        requireWorkflow(previous === null, 'comparison-delivery-outcome-unknown');
        await verify();
        state.turn = await sessions.send(
          session,
          request.brief +
            (state.compaction === null
              ? ''
              : '\nНастоящее сжатие завершено. Продолжи ту же задачу с новым наблюдаемым LOAD; выполни отрицательные сценарии и полное восстановление по Р1.'),
          delivery,
        );
      }
      requireWorkflow(state.turn !== null, 'comparison-delivery-outcome-unknown');
      saveManaged(path, state, false);
    }
    await rpc.completed(actual.id, state.turn, controls?.signal, current);
    await current();
    const primary = object(
      object(await rpc.request('thread/read', { threadId: actual.id, includeTurns: true })).thread,
    );
    requireWorkflow(
      primary.id === actual.id && Array.isArray(primary.turns),
      'comparison-native-history-unconfirmed',
    );
    const turns = primary.turns.map(object).filter((turn) => turn.id === state.turn);
    requireWorkflow(
      turns.length === 1 &&
        ['completed', 'failed', 'interrupted'].includes(String(turns[0]!.status)) &&
        Array.isArray(turns[0]!.items),
      'comparison-native-turn-failed',
    );
    const items = (turns[0]!.items as unknown[]).map(object);
    const answer = items.filter((item) => item.type === 'agentMessage').at(-1);
    const text = turns[0]!.status === 'completed' ? textField(answer?.text) : '';
    stopped = await stop();
    await comparisonParticipants(
      rpc,
      [request.workspace, request.state_root],
      request.run,
      h01 ? controls!.observedParticipant : register,
    );
    await verify();
    const proof = {
      thread: actual.id,
      turn: state.turn,
      text,
      status: textField(turns[0]!.status),
      stopped,
      items: items.filter((item) =>
        ['agentMessage', 'commandExecution', 'fileChange'].includes(String(item.type)),
      ),
    };
    const bytes = canonical(proof) + '\n';
    const source = {
      locator: resolve(request.directory, `answer-${digest(bytes)}.json`),
      hash: digest(bytes),
    };
    saveManaged(source.locator, proof, false);
    state.answer = source;
    saveManaged(path, state, false);
    return { text, status: proof.status, source };
  } finally {
    try {
      if (stopped === null && state.session !== null) await stop();
    } finally {
      rpc.close();
      if (state.runtime !== null) {
        for (
          let attempt = 0;
          attempt < 20 && (await processes.alive([state.runtime.process])).length > 0;
          attempt++
        )
          await processes.wait(100);
        requireWorkflow(
          (await processes.alive([state.runtime.process])).length === 0,
          'comparison-native-process-still-running',
        );
      }
    }
  }
}
