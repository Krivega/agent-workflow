import { backupSupervision } from '../adapters/storage/supervisionBackup.js';
import { taskBackendPolicy, requireTaskBackend } from '../src/adapters/project/taskBackend.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { initializeChatControl, advanceChatControl } from '../application/chatControl.js';
import { assertChatActive, validateChatControl } from '../core/chatControl.js';
import type { ChatControl, ChatControlEvent } from '../core/chatControl.js';
import { FileChatRecovery } from '../adapters/project/chatRecovery.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import { projectLocalCard } from '../application/projectLocalCard.js';
import { sameValue } from '../core/equality.js';
import { initializeChatMessages, advanceChatMessages } from '../application/chatMessages.js';
import { validateChatMessages, requireChatDecision } from '../core/chatMessages.js';
import type { ChatMessageEvent, ChatMessages } from '../core/chatMessages.js';
import { observeChatCouncil } from '../application/chatCouncil.js';
import type { Council, CouncilRole } from '../core/council.js';
import type { InputRef, LocalRun } from '../core/localRun.js';
import { withChatRoles } from './chatRoles.js';
import type { WorkflowInputs } from '../ports/workflowJournal.js';
import { FileAuditCards } from '../adapters/project/fileAuditCards.js';
import { FileCoordinationInputs } from '../adapters/project/coordinationScopes.js';
import { TaskCoordinationJournal } from '../adapters/storage/coordinationJournal.js';
import { beginCoordination, advanceCoordination } from '../application/coordinationWorkflow.js';
import type { CoordinationEvent, CoordinationSeed } from '../core/coordination.js';
import { replayCoordination } from '../core/coordination.js';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { ChatAnchor } from '../core/currentChat.js';
import type { EvidenceGrant, TechnicalState, EffectRecord } from '../core/evidence.js';
import { compareInputs, targetEvidenceInputs } from '../core/evidence.js';
import { advanceLocalWorkflow } from '../application/localWorkflow.js';
import type { LocalEvent, RunSpec } from '../core/localRun.js';
import type { Gate, ExecutionEvent } from '../core/execution.js';
import {
  actionProcedureLoading,
  confirmLoad,
  assertRunAction,
  requireLoadedProcedures,
} from '../core/localRun.js';
import type { ProcedureId } from '../core/connection.js';
import { fileConnectionReader } from '../adapters/project/fileConnectionReader.js';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { fileRunInputs } from '../adapters/project/fileRunInputs.js';
import { FileProjectCards } from '../adapters/project/fileProjectCards.js';
import { contentHash, projectText } from '../adapters/project/projectFiles.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { requestHash } from '../adapters/storage/storeCodec.js';
import type { EvidenceStore } from '../ports/evidenceStore.js';
import { TaskLocalRuns } from '../adapters/storage/localRunStores.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import {
  prepareCurrentChat,
  readyCurrentChat,
  beginChatExecution,
  finishChatProjection,
  chatStatus,
} from '../application/currentChatWorkflow.js';
import type { ChatPlanning, ChatDependencies } from '../application/currentChatWorkflow.js';
import { advanceExecution, verifyCouncilInputs } from '../application/executionWorkflow.js';
import {
  runChatCheck,
  verifyChatCheck,
  validateCheckCommand,
} from '../adapters/project/chatChecks.js';
import type { ChatCheckRequest } from '../adapters/project/chatChecks.js';
import { bindChatEvidence, withChatWriter } from '../adapters/storage/chatWriter.js';
import { continueChat, refreshChatLease, withActiveChatLease } from './chatContinuation.js';
import { NativeUserCommands } from '../adapters/codex/userCommands.js';
import { confirmTaskCouncilSelection } from './taskChatSelection.js';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import { preparedChecks, runPreparedChecks } from '../adapters/project/preparedChecks.js';
import { runTaskChatCouncil } from './taskChatCouncil.js';
import { validateLocalAdmission } from '../core/localPlanning.js';
import { executeCoderRequest } from './coderRuntime.js';
import { chatCompactContext } from './chatCompactContext.js';
import { compactContextLine } from '../adapters/project/compactContext.js';
import { councilWaitGuard } from './councilWaitGuard.js';

export const chatRuntimeCommands = [
  'prepare-chat',
  'bootstrap-chat',
  'execution-chat',
  'check-chat',
  'checks-chat',
  'preflight-checks-chat',
  'council-run-chat',
  'project-chat',
  'status-chat',
  'compact-context-chat',
  'observe-audit-chat',
  'messages-chat',
  'council-chat',
  'coordination-chat',
  'control-chat',
  'cancel-project-chat',
  'continue-chat',
  'coder-chat',
] as const;
export async function executeChatRequest(
  command: (typeof chatRuntimeCommands)[number],
  request: Record<string, unknown>,
  delegatedActor?: { senderTurn: string; planningDirectory?: string | undefined },
) {
  if (
    command !== 'status-chat' &&
    command !== 'compact-context-chat' &&
    taskBackendPolicy(textField(request.root)) !== null
  ) {
    const identity = object(object(object(request.storage).grant).context);
    requireTaskBackend(
      textField(request.root),
      textField(identity.project_id),
      textField(identity.task_id),
      'legacy',
      'legacy',
    );
  }
  let assertRuntime = () => {};
  const action = () =>
    executeExclusiveChatRequest(
      command,
      request,
      (verify) => {
        assertRuntime = verify;
      },
      delegatedActor,
    );
  return command === 'status-chat' || command === 'compact-context-chat'
    ? action()
    : withChatWriter(resolve(textField(object(request.storage).root)), action, () =>
        assertRuntime(),
      );
}
async function executeExclusiveChatRequest(
  command: (typeof chatRuntimeCommands)[number],
  request: Record<string, unknown>,
  bound: (verify: () => void) => void,
  delegatedActor?: { senderTurn: string; planningDirectory?: string | undefined },
) {
  const root = textField(request.root),
    descriptor = textField(request.descriptor);
  const storage = object(request.storage),
    storeRoot = resolve(textField(storage.root));
  const generation = request.generation;
  requireWorkflow(
    typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0,
    'invalid-generation',
  );
  const grant = storage.grant as EvidenceGrant;
  const host = new FileCurrentChatHost(
    root,
    textField(request.transcript),
    request.anchor as ChatAnchor,
    null,
    false,
    delegatedActor,
  );
  const observed = await host.observe();
  requireWorkflow(
    observed.thread_id === process.env.CODEX_THREAD_ID,
    'chat-environment-identity-mismatch',
  );
  const loaded = await fileConnectionReader.load(root, descriptor);
  const connection = await new FileTaskConnection(root).read(textField(request.connection_journal));
  requireWorkflow(
    connection.receipt.phase === 'enabled' &&
      connection.plan.project_id === grant.context.project_id &&
      connection.plan.task_id === grant.context.task_id,
    'chat-connection-not-enabled',
  );
  requireWorkflow(loaded.descriptor.project_id === grant.context.project_id, 'wrong-project');
  requireWorkflow(
    loaded.revision === connection.plan.descriptor.hash,
    'chat-connection-inputs-changed',
  );
  // Only planning reads in the delegated bootstrap use the reviewed council's directory.
  const inputDirectory =
    delegatedActor?.planningDirectory !== undefined &&
    (command === 'bootstrap-chat' || (command === 'execution-chat' && request.event === undefined))
      ? delegatedActor.planningDirectory
      : textField(request.evidence_root);
  const files = new FileWorkflowInputs(root, inputDirectory);
  const inputs: WorkflowInputs = {
    current: (manifest, projection) => files.current(manifest, projection),
    verify: async (refs, projection) => {
      for (const ref of refs) {
        if (ref.locator.startsWith(textField(request.transcript) + '#L')) await host.reference(ref);
        else await files.verify([ref], projection);
      }
    },
  };
  const planning = async (): Promise<ChatPlanning> => {
    const locator = textField(request.planning_file);
    const value = object(
      decodeChatArtifact(dirname(resolve(root, locator)), await projectText(root, locator), false),
    );
    requireWorkflow([1, 2].includes(value.schema_version as number), 'unsupported-chat-planning');
    requireWorkflow(
      sameValue((value.council as Council).configuration, loaded.descriptor.council),
      'wrong-council-configuration',
    );
    if (value.schema_version === 2) {
      requireWorkflow(value.local !== undefined, 'local-plan-required');
      validateLocalAdmission(
        value.local as NonNullable<ChatPlanning['local']>,
        (value.council as Council).target,
      );
    }
    return {
      task_id: textField(value.task_id),
      council: value.council as ChatPlanning['council'],
      ...(value.local === undefined
        ? {}
        : { local: value.local as NonNullable<ChatPlanning['local']> }),
      source: await files.ref(locator),
      ...(value.retained_source === undefined
        ? {}
        : { retained_source: value.retained_source as InputRef }),
      ...(value.requirements_revision === undefined
        ? {}
        : { requirements_revision: value.requirements_revision as number }),
      ...(value.assignment === undefined ? {} : { assignment: value.assignment as InputRef }),
      ...(value.council_selection === undefined
        ? {}
        : {
            role_requirements: await confirmTaskCouncilSelection(
              root,
              inputDirectory,
              files,
              value.council_selection as InputRef,
              (value.council as Council).selection,
              request.spec as RunSpec,
              loaded.descriptor.council,
            ),
          }),
    };
  };
  const writable = command !== 'status-chat' && command !== 'compact-context-chat';
  const bootstrap = command === 'bootstrap-chat' || command === 'prepare-chat';
  if (writable)
    requireWorkflow(
      observed.sandbox_policy === 'danger-full-access' &&
        observed.approval_policy === 'never' &&
        observed.permission_profile === 'disabled',
      'chat-write-profile-unsupported',
    );
  if (writable)
    requireWorkflow(grant.context.actor_id === observed.thread_id, 'chat-store-actor-mismatch');
  const store = new SqliteEvidenceStore(
    storeRoot,
    grant,
    Date.now,
    undefined,
    writable ? 'live' : 'inspect',
  );
  if (bootstrap && !existsSync(storeRoot)) {
    requireWorkflow(grant.permissions.includes('manage'), 'chat-store-manage-forbidden');
    safeDirectory(dirname(storeRoot));
    requireWorkflow(
      !storeRoot.startsWith(observed.workspace + '/') && storeRoot !== observed.workspace,
      'chat-store-must-be-external',
    );
    initializeStore(storeRoot, grant.context);
  }
  const stateReply = store.execute({
    context: grant.context,
    command: { type: 'state', archive: 'current' },
  });
  requireWorkflow(
    stateReply.ok,
    !stateReply.ok && stateReply.error.code === 'recovery-required'
      ? 'chat-store-recovery-required'
      : 'chat-store-unavailable',
  );
  let state = stateReply.value as TechnicalState;
  let control =
    state.checkpoint === null || object(state.checkpoint).chat_control === undefined
      ? null
      : (object(state.checkpoint).chat_control as ChatControl);
  if (control !== null) validateChatControl(control);
  const lastControl = control?.history.at(-1);
  const reuseLoad =
    lastControl !== undefined &&
    object(JSON.parse(lastControl.payload) as unknown).previous_source_turn !== undefined;
  if (state.checkpoint !== null && object(state.checkpoint).chat_messages !== undefined)
    validateChatMessages(object(state.checkpoint).chat_messages as ChatMessages);
  if (bootstrap && state.generation === 0) {
    const claim = {
      context: grant.context,
      command: {
        type: 'mutate' as const,
        mutation: {
          operation_id: 'chat:initial-owner',
          expected_revision: state.revision,
          owner_generation: 0,
          payload_hash: '',
        },
        change: { type: 'claim' as const, lease_until: request.lease_until as number },
      },
    };
    claim.command.mutation.payload_hash = requestHash(claim);
    requireWorkflow(store.execute(claim).ok, 'chat-owner-claim-rejected');
    const next = store.execute({
      context: grant.context,
      command: { type: 'state', archive: 'current' },
    });
    requireWorkflow(next.ok, 'chat-store-unavailable');
    state = next.value as TechnicalState;
  }
  if (writable)
    requireWorkflow(
      state.owner === observed.thread_id &&
        state.generation === generation &&
        !state.released &&
        (state.lease_until > Date.now() ||
          command === 'continue-chat' ||
          (!bootstrap &&
            control?.status === 'active' &&
            [
              'execution-chat',
              'check-chat',
              'checks-chat',
              'preflight-checks-chat',
              'council-chat',
              'council-run-chat',
              'project-chat',
            ].includes(command))) &&
        !state.frozen &&
        grant.permissions.includes('manage'),
      'chat-owner-unconfirmed',
    );
  let assertRuntime = writable
    ? bindChatEvidence(storeRoot, resolve(textField(request.evidence_root)), state)
    : () => {};
  bound(assertRuntime);
  const persistence: EvidenceStore = {
    execute: async (r) => {
      assertRuntime();
      return store.execute(r);
    },
  };
  const deps: ChatDependencies = {
    requirements_revision:
      state.checkpoint === null || object(state.checkpoint).chat_messages === undefined
        ? 0
        : (object(state.checkpoint).chat_messages as ChatMessages).requirements_revision,
    host,
    inputs,
    runs: new TaskLocalRuns(persistence, grant.context, generation, true, (source, operation) =>
      backupSupervision(
        persistence,
        storeRoot,
        textField(request.evidence_root),
        grant,
        source,
        operation,
      ),
    ),
    runInputs: fileRunInputs(root, descriptor),
    journal: new TaskWorkflowJournal(
      persistence,
      grant.context,
      generation,
      true,
      (source, operation) =>
        backupSupervision(
          persistence,
          storeRoot,
          textField(request.evidence_root),
          grant,
          source,
          operation,
        ),
    ),
    cards: new FileProjectCards(
      root,
      loaded.descriptor,
      resolve(textField(request.evidence_root), 'card-projections'),
      () => assertRuntime(),
    ),
  };
  const chat = new TaskChatContext(persistence, grant.context, generation);
  host.compactContext = chatCompactContext(
    command,
    request,
    host,
    store,
    chat,
    loaded,
    deps.runInputs,
  );
  if (command === 'compact-context-chat') {
    requireWorkflow(
      chatRuntimeCommands.includes(
        request.compact_action as (typeof chatRuntimeCommands)[number],
      ) && !['status-chat', 'compact-context-chat'].includes(String(request.compact_action)),
      'invalid-compact-action',
    );
    const run = await deps.runs.read();
    requireWorkflow(run !== null, 'run-not-found');
    let line: ReturnType<typeof compactContextLine> | undefined;
    try {
      line = compactContextLine(await host.compactContext(run, textField(request.marker)));
    } catch (error) {
      if (run.spec.context_loading === undefined || (await host.compaction()) === undefined)
        throw error;
      // Сбой сборки не должен блокировать полный LOAD по Р1.
    }
    if (run.spec.context_loading === undefined)
      return { ...line, status: 'preview', receipt: null, reason: 'compact-context-disabled' };
    try {
      const receipt = await host.load(run, textField(request.marker));
      return {
        ...line,
        status: receipt.compact === undefined ? 'full-recovery' : 'loaded',
        receipt,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'chat-compact-outcome-unknown';
      return {
        ...line,
        status: reason.endsWith(':chat-compact-read-unconfirmed')
          ? 'read-required'
          : 'full-recovery',
        receipt: null,
        reason,
      };
    }
  }
  if (command === 'status-chat') {
    // Decode every status section from one captured checkpoint, including during a live writer.
    const snapshot: EvidenceStore = { execute: async () => ({ ok: true, value: state }) };
    const context = await new TaskChatContext(snapshot, grant.context, generation).read();
    const workflow = context.workflow;
    const coordination = await new TaskCoordinationJournal(
      snapshot,
      grant.context,
      generation,
    ).read();
    const pending = unwrap<EffectRecord[]>(
      store.execute({ context: grant.context, command: { type: 'effects' } }),
    )
      .filter((effect) => effect.outcome === 'pending' || effect.outcome === 'unknown')
      .map(({ id, outcome }) => ({ id, outcome }));
    const latest = unwrap<TechnicalState>(
      store.execute({ context: grant.context, command: { type: 'state', archive: 'current' } }),
    );
    requireWorkflow(latest.revision === state.revision, 'chat-status-checkpoint-changed');
    const execution = chatStatus(workflow.execution);
    return {
      checkpoint: {
        locator: storeRoot + '#state',
        revision: state.revision,
        generation: state.generation,
        workflow_revision: workflow.revision,
        execution_revision: workflow.execution?.revision ?? null,
        target: workflow.execution?.target.diff ?? null,
      },
      local: context.run,
      execution: {
        ...execution,
        blockers: [
          ...pending.map((effect) => `effect:${effect.id}:${effect.outcome}`),
          ...execution.blockers,
        ],
      },
      pending_operations: pending,
      ...(workflow.coders === undefined
        ? {}
        : {
            coders: Object.values(workflow.coders).map((run) => ({
              id: run.brief.id,
              status: run.status,
              source_paths: run.brief.paths,
              session: run.session?.id ?? null,
              native_policy: run.session?.policy ?? null,
            })),
          }),
      messages: context.messages,
      control: context.control,
      ownership: {
        owner: state.owner,
        generation: state.generation,
        lease_until: state.lease_until,
        expired: state.lease_until <= Date.now(),
      },
      resume_required:
        context.control !== null &&
        (context.control.status !== 'active' ||
          (coordination === null && !sameValue(context.control.observed, observed))),
      coordination: coordination === null ? null : replayCoordination(coordination),
    };
  }
  const recovery = new FileChatRecovery(
    root,
    textField(request.evidence_root),
    chat,
    new NativeWriterProcesses(),
  );
  if (command !== 'continue-chat' && state.lease_until <= Date.now()) {
    await continueChat(request, chat, host, deps.runInputs, recovery, store, assertRuntime);
    control = (await chat.read()).control;
  }
  const action = async () => {
    if (control === null) {
      const saved = state.checkpoint === null ? undefined : object(state.checkpoint).local_run;
      requireWorkflow(
        bootstrap && (saved === undefined || object(saved).status !== 'ready'),
        'chat-control-missing',
      );
    }
    if (command === 'messages-chat' && control !== null)
      requireWorkflow(
        ['active', 'paused', 'interrupted'].includes(control.status),
        'chat-control-not-active',
      );
    else if (command === 'coordination-chat' && control !== null)
      requireWorkflow(control.status === 'active', 'chat-control-not-active');
    else if (
      command !== 'control-chat' &&
      command !== 'cancel-project-chat' &&
      command !== 'continue-chat'
    )
      assertChatActive(control, observed);
    if (command === 'prepare-chat') {
      const spec = request.spec as RunSpec;
      requireWorkflow(
        spec.run_id === grant.context.run_id &&
          'task_id' in spec.identity &&
          spec.identity.task_id === grant.context.task_id &&
          spec.parent_run_id === null,
        'wrong-local-executor',
      );
      return prepareCurrentChat(spec, generation, request.marker, observed, reuseLoad, chat, deps);
    }
    if (command === 'bootstrap-chat') {
      deps.beforeReady = async () => {
        await initializeChatMessages(chat);
        await initializeChatControl(chat, host);
      };
      const spec = request.spec as RunSpec;
      requireWorkflow(spec.run_id === grant.context.run_id, 'wrong-local-executor');
      refreshChatLease(store);
      const result = await readyCurrentChat(
        spec,
        generation,
        textField(request.marker),
        await planning(),
        deps,
      );
      const initialized = await chat.read();
      return { ...result, messages: initialized.messages, control: initialized.control };
    }
    const currentRun = await deps.runs.read();
    requireWorkflow(currentRun !== null, 'run-not-found');
    let run = currentRun;
    if (run.projection?.result.status === 'pending')
      requireWorkflow(
        (command === 'project-chat' || command === 'cancel-project-chat') &&
          request.operation === run.projection.plan.operation_id,
        'reconciliation-pending',
      );
    requireWorkflow(
      run.spec.run_id === grant.context.run_id &&
        (run.generation === generation ||
          ((command === 'cancel-project-chat' || command === 'control-chat') &&
            control?.status === 'cancelled' &&
            run.generation === generation + 1)),
      'wrong-local-executor',
    );
    if (command !== 'continue-chat') refreshChatLease(store);
    if (command === 'control-chat')
      return advanceChatControl(
        request.control as ChatControlEvent,
        chat,
        host,
        deps.runInputs,
        recovery,
        new NativeUserCommands(root),
      );
    if (command === 'continue-chat')
      return continueChat(request, chat, host, deps.runInputs, recovery, store, assertRuntime);
    if (command === 'cancel-project-chat') {
      requireWorkflow(
        control?.status === 'cancelled' && run.status === 'cancelled',
        'chat-cancellation-unconfirmed',
      );
      const operation = textField(request.operation);
      if (run.projection?.result.status === 'confirmed') {
        requireWorkflow(
          run.projection.plan.operation_id === operation,
          'chat-projection-operation-conflict',
        );
        await deps.runInputs.verify(run);
        return run;
      }
      return projectLocalCard('cancelled', operation, deps.runs, deps.cards, deps.runInputs);
    }
    if (command === 'messages-chat')
      return advanceChatMessages(request.message as ChatMessageEvent, chat, host, deps.runInputs);
    await deps.runInputs.verify(run);
    if (actionProcedureLoading(run.spec)) {
      const receipt = await host.load(run, textField(request.marker), reuseLoad);
      const observedRun = { ...run, loaded: receipt };
      const procedures: ProcedureId[] = [];
      if (command === 'council-chat' || command === 'council-run-chat') procedures.push('council');
      if (command === 'execution-chat' && request.event !== undefined) {
        const event = request.event as ExecutionEvent;
        if (event.type === 'REVIEW' || event.type === 'ACCEPT') procedures.push('council');
        if (event.type === 'SUPERVISE') {
          if (event.action.kind === 'arbitrate') procedures.push('arbitration');
          if (
            ['audit', 'reserve-audit', 'launch-audit', 'settle-audit'].includes(event.action.kind)
          )
            procedures.push('audit');
        }
      }
      if (command === 'observe-audit-chat') procedures.push('audit');
      requireLoadedProcedures(observedRun, procedures);
      assertRunAction(
        observedRun,
        command === 'coordination-chat'
          ? 'coordinate'
          : command === 'council-chat' || command === 'council-run-chat'
            ? 'produce-evidence'
            : 'implement',
      );
      if (!sameValue(run.loaded, receipt))
        run = await advanceLocalWorkflow(
          {
            type: 'LOAD',
            receipt,
            event_id: `chat:action-load:${contentHash(JSON.stringify(receipt))}`,
            expected_revision: run.revision,
            generation,
          },
          deps.runs,
          deps.runInputs,
        );
    }
    if (command === 'observe-audit-chat') {
      const reservation = (await deps.journal.read()).execution?.supervision?.reservations?.find(
        (a) => a.id === request.audit_id,
      );
      requireWorkflow(
        reservation !== undefined && reservation.settled === null,
        'audit-reservation-not-open',
      );
      if (reservation.operation === null)
        return {
          outcome: 'not-started',
          operation: reservation.id,
          session: null,
          receipt: reservation.card.ref,
        };
      return withChatRoles(
        { ...request, event: { type: 'SUPERVISE', action: { kind: 'settle-audit' } } },
        observed.thread_id,
        grant.context.project_id,
        host,
        (sessions) => sessions.observeAuditAttempt!(reservation),
      );
    }
    if (command === 'council-run-chat') {
      assertRunAction(run, 'produce-evidence');
      confirmLoad(run, await host.load(run, textField(request.marker), reuseLoad));
      await recovery.settled();
      const evidence = resolve(textField(request.evidence_root));
      const path = resolve(textField(request.council_file));
      requireWorkflow(path.startsWith(evidence + '/'), 'council-checkpoint-outside-evidence');
      const previous = readManaged<Council>(path);
      const requested = request.council as Council | undefined;
      requireWorkflow(previous !== null || requested !== undefined, 'council-checkpoint-required');
      if (previous !== null && requested !== undefined)
        requireWorkflow(
          previous.phase === requested.phase &&
            sameValue(previous.target, requested.target) &&
            sameValue(previous.selection, requested.selection) &&
            sameValue(previous.configuration, requested.configuration),
          'council-checkpoint-conflict',
        );
      const council = previous ?? requested!;
      requireWorkflow(
        sameValue(council.configuration, loaded.descriptor.council),
        'wrong-council-configuration',
      );
      for (const manifest of new Set([council.target.inputs, targetEvidenceInputs(council.target)]))
        requireWorkflow(
          compareInputs(manifest, await inputs.current(manifest)) === 'applicable',
          'council-target-stale',
        );
      await inputs.verify([council.target.diff]);
      await verifyCouncilInputs(council, inputs);
      if (previous === null) saveManaged(path, council, true, 'minimal');
      return runTaskChatCouncil(
        council,
        run.spec,
        resolve(evidence, 'council'),
        request.binary === undefined ? 'codex' : textField(request.binary),
        (next) => {
          assertRuntime();
          saveManaged(path, next, true, 'minimal');
          return readManaged<Council>(path)!;
        },
        () => {},
        evidence,
        councilWaitGuard(request, host),
      );
    }
    if (command === 'council-chat') {
      requireWorkflow(
        sameValue((request.council as Council).configuration, loaded.descriptor.council),
        'wrong-council-configuration',
      );
      requireWorkflow(
        (request.role_run as LocalRun).spec.parent_run_id === run.spec.run_id,
        'chat-council-parent-run-mismatch',
      );
      return withChatRoles(
        request,
        observed.thread_id,
        grant.context.project_id,
        host,
        (sessions) =>
          observeChatCouncil(
            request.council as Council,
            request.role as CouncilRole,
            request.role_run as LocalRun,
            textField(request.role_turn),
            observed.thread_id,
            sessions,
            inputs,
          ),
        'council',
      );
    }
    if (command === 'coordination-chat') {
      assertRunAction(run, 'coordinate');
      confirmLoad(run, await host.load(run, textField(request.marker), reuseLoad));
      requireWorkflow(
        Array.isArray(request.coordination_roots) &&
          request.coordination_roots.every((v) => typeof v === 'string'),
        'chat-coordination-roots-required',
      );
      const journal = new TaskCoordinationJournal(persistence, grant.context, generation);
      const scopeInputs = new FileCoordinationInputs(
        root,
        request.coordination_roots,
        textField(request.evidence_root),
      );
      if (request.event === undefined)
        return beginCoordination(request.seed as CoordinationSeed, journal, scopeInputs);
      return withChatRoles(
        request,
        observed.thread_id,
        grant.context.project_id,
        host,
        (sessions) =>
          advanceCoordination(request.event as CoordinationEvent, journal, scopeInputs, sessions),
        true,
      );
    }
    assertRunAction(run, 'implement');
    confirmLoad(run, await host.load(run, textField(request.marker), reuseLoad));
    if (command === 'coder-chat') {
      requireLoadedProcedures(run, ['coordination']);
      return executeCoderRequest(request, deps, assertRuntime, {
        locator: descriptor,
        descriptor: loaded.descriptor,
      });
    }
    if (['check-chat', 'checks-chat', 'preflight-checks-chat'].includes(command)) {
      assertRunAction(run, 'produce-evidence');
      const check = async (check: ChatCheckRequest) => {
        const proof = await runChatCheck(
          root,
          textField(request.evidence_root),
          check,
          assertRuntime,
          loaded.descriptor.validation_commands,
        );
        const id = 'chat:check:' + proof.operation_id;
        const current = await deps.runs.read();
        requireWorkflow(current !== null, 'run-not-found');
        const old = current.history.find((e) => e.event_id === id);
        const event: LocalEvent = old
          ? (JSON.parse(old.payload) as LocalEvent)
          : {
              type: 'RESULT',
              event_id: id,
              expected_revision: current.revision,
              generation,
              session_id: current.spec.session_id,
              source: await files.ref(
                resolve(textField(request.evidence_root), proof.operation_id + '.json'),
              ),
              outcome: proof.check.verdict,
            };
        await advanceLocalWorkflow(event, deps.runs, deps.runInputs);
        return proof;
      };
      if (command === 'check-chat') return check(request.check as ChatCheckRequest);
      await recovery.settled();
      const plan = await preparedChecks(
        root,
        textField(request.evidence_root),
        request.check_plan as InputRef,
        loaded.descriptor.validation_commands,
      );
      requireWorkflow(
        'task_id' in run.spec.identity && sameValue(plan.card, run.spec.identity.card),
        'prepared-check-task-mismatch',
      );
      return runPreparedChecks(
        root,
        textField(request.evidence_root),
        request.check_plan as InputRef,
        check,
        command === 'preflight-checks-chat' ? 'preflight' : 'checks',
        undefined,
        loaded.descriptor.validation_commands,
      );
    }
    if (command === 'project-chat') return finishChatProjection(textField(request.operation), deps);
    if (request.event !== undefined) {
      const event = request.event as ExecutionEvent;
      requireWorkflow(
        event.type !== 'REPLAN' || event.requirements === undefined,
        'chat-requirements-message-required',
      );
      if (event.type === 'REVIEW') {
        const execution = (await deps.journal.read()).execution;
        requireWorkflow(execution !== null, 'execution-not-found');
        for (const check of event.checks)
          if (execution.gates.some((g) => g.id === check.id && g.kind === 'check')) {
            const proof = await verifyChatCheck(root, textField(request.evidence_root), check);
            validateCheckCommand(check.id, proof.command, loaded.descriptor.validation_commands);
          } else if (
            execution.gates.some((g) => g.id === check.id && g.kind === 'human' && g.applicable) &&
            (check.verdict === 'PASS' || check.verdict === 'FAIL')
          ) {
            const messages = (await chat.read()).messages;
            requireWorkflow(messages !== null, 'chat-messages-missing');
            requireChatDecision(messages, check.id, check.verdict === 'PASS', check.evidence);
          }
      }
      if (event.type === 'SUPERVISE' && event.action.kind === 'human') {
        const messages = (await chat.read()).messages;
        requireWorkflow(messages !== null, 'chat-messages-missing');
        requireChatDecision(
          messages,
          'arbitration:' + event.action.id,
          event.action.accepted,
          event.action.evidence,
        );
      }
      const auditCards =
        event.type === 'SUPERVISE' &&
        ['audit', 'reserve-audit', 'launch-audit', 'settle-audit'].includes(event.action.kind)
          ? new FileAuditCards(root, loaded.descriptor, resolve(root, 'tmp/agent-workflow-audit'))
          : undefined;
      const supervisionAction = event.type === 'SUPERVISE' ? event.action : null;
      const native =
        supervisionAction !== null &&
        (supervisionAction.kind === 'arbitrate' ||
          supervisionAction.kind === 'audit' ||
          supervisionAction.kind === 'launch-audit' ||
          (supervisionAction.kind === 'settle-audit' &&
            (await deps.journal.read()).execution?.supervision?.reservations?.find(
              (a) => a.id === supervisionAction.id,
            )?.operation !== null));
      if (native)
        return withChatRoles(
          request,
          observed.thread_id,
          grant.context.project_id,
          host,
          (sessions) => advanceExecution(event, deps.journal, inputs, sessions, auditCards),
        );
      return advanceExecution(event, deps.journal, inputs, undefined, auditCards);
    }
    return beginChatExecution(
      await planning(),
      request.gates as Gate[],
      request.code as boolean,
      deps,
    );
  };
  if (command === 'continue-chat') return action();
  return withActiveChatLease(store, assertRuntime, async (verify) => {
    assertRuntime = verify;
    bound(verify);
    return action();
  });
}
