import { chatDiagnostic, reportTaskChatFailure } from './chatFailureGuidance.js';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {
  taskBackendPolicy,
  requireTaskBackend,
  requireLegacyCardBackend,
} from '../src/adapters/project/taskBackend.js';
import { resolve, dirname } from 'node:path';
import type { CouncilConfiguration } from '../core/connection.js';
import { sameValue } from '../core/equality.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { RunSpec, LocalRun, InputRef, LoadReceipt } from '../core/localRun.js';
import type { ProcedureId } from '../core/connection.js';
import { actionProcedureLoading, selectedProcedures, startLocalRun } from '../core/localRun.js';
import type { ChatMessages, ChatMessageEvent } from '../core/chatMessages.js';
import { evidenceSchema } from '../core/evidence.js';
import type { EvidenceGrant, TechnicalState } from '../core/evidence.js';
import { createCouncil, revisePlanning, councilBlockers } from '../core/council.js';
import type { Council, CouncilRole, ReviewTarget } from '../core/council.js';
import type { Gate } from '../core/execution.js';
import {
  fileConnectionReader,
  projectDescriptor,
} from '../adapters/project/fileConnectionReader.js';
import { connectChatTask } from '../adapters/project/chatTaskConnection.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical } from '../adapters/storage/storeCodec.js';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { retentionFingerprint } from '../adapters/storage/retainedJson.js';
import { withChatWriter } from '../adapters/storage/chatWriter.js';
import { executeChatRequest } from './chatRuntime.js';
import { briefChatResult } from './chatOutput.js';
import {
  taskChatOptions,
  taskChatContext,
  taskChatBrief,
  taskChatSelection,
  taskChatGates,
} from './taskChatInputs.js';
import type { TaskChatOptions } from './taskChatInputs.js';
import { runTaskChatCouncil } from './taskChatCouncil.js';
import { readTaskCouncilSelection, sharedCouncilSources } from './taskChatSelection.js';
import { restoreCouncilSelection } from './refreshCouncilInputs.js';
import { waitCouncilProgress } from './councilProgress.js';
import { projectText } from '../adapters/project/projectFiles.js';
import { localPlanRefs, localStableRefs, validateLocalAdmission } from '../core/localPlanning.js';
import type { LocalImplementationPlan } from '../core/localRun.js';
import { validateLocalPlan } from '../core/localRun.js';
import { councilWaitGuard } from './councilWaitGuard.js';

interface ManagedChat {
  schema_version: 1 | 2;
  runtime_package_version?: string;
  local_plan?: LocalImplementationPlan;
  root: string;
  owner: string;
  binary: string;
  card: string;
  plan: string;
  sources: string[];
  targets: string[];
  skipped: TaskChatOptions['skipped'];
  council_selection?: InputRef | null;
  human: string[];
  council: Council;
  request: Record<string, unknown> & { spec: RunSpec };
  revision_event: ChatMessageEvent | null;
}
const runtimePackageVersion = textField(
  object(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))).version,
);
async function taskChatSources(
  files: FileWorkflowInputs,
  paths: string[],
  local?: LocalImplementationPlan,
) {
  const refs = await Promise.all(paths.map((path) => files.ref(path)));
  return local === undefined ? refs : localStableRefs(local, refs);
}
async function unstartedPlanningReviews(council: Council, root: string, evidence: string) {
  const proofs: { role: CouncilRole; session: string; answer_turn: string }[] = [];
  const files = new FileWorkflowInputs(root, evidence);
  for (const [role, adviser] of Object.entries(council.advisers)) {
    if (adviser.status === 'answered') continue;
    const prior = council.history
      .slice()
      .reverse()
      .find((entry) => entry.role === role && entry.session === adviser.run.spec.session_id);
    const progress = readManaged<{
      session: { id: string };
      load_pending: boolean;
      turn: string | null;
    }>(resolve(evidence, 'council', `${role}.json`));
    // The runner saves a pending LOAD/delivery before dispatch, under the same writer lock.
    requireWorkflow(
      progress !== null &&
        prior?.answer.binding !== undefined &&
        progress.session.id === prior.session &&
        progress.load_pending === false &&
        progress.turn === prior.answer.binding.answer_turn,
      'planning-adviser-running',
    );
    await files.verify([prior.answer.evidence]);
    proofs.push({
      role: role as CouncilRole,
      session: prior.session,
      answer_turn: textField(progress.turn),
    });
  }
  if (proofs.length > 0)
    saveManaged(resolve(evidence, `unstarted-planning-${contentHash(canonical(proofs))}.json`), {
      proofs,
    });
  return proofs;
}

export async function runLegacyTaskChatCommand(
  args: readonly string[],
  root: string,
  policy: ReturnType<typeof taskBackendPolicy>,
  write: (s: string) => void,
  error: (s: string) => void,
) {
  let diagnostic = chatDiagnostic;
  const localInput: { failure: { cause: unknown; locator: string } | null } = { failure: null };
  const compactLoad: { required: { cause: Error; result: Record<string, unknown> } | null } = {
    required: null,
  };
  try {
    const options = taskChatOptions(args);
    requireWorkflow(
      options.state !== root && !options.state.startsWith(root + '/'),
      'chat-state-must-be-external',
    );
    if (options.action === 'wait') {
      write(
        JSON.stringify(
          await waitCouncilProgress(
            resolve(options.state, 'council'),
            options.after,
            options.timeoutMs,
            { until: options.until },
          ),
        ),
      );
      return 0;
    }
    const saved = ['continue', 'load'].includes(options.action)
      ? readManaged<ManagedChat>(resolve(options.state, 'managed-chat.json'))
      : null;
    if ((args[0] === 'start' ? policy : taskBackendPolicy(root)) !== null) {
      const existing =
        saved ?? readManaged<ManagedChat>(resolve(options.state, 'managed-chat.json'));
      if (existing !== null) {
        const identity = object(object(object(existing.request.storage).grant).context);
        requireTaskBackend(
          root,
          textField(identity.project_id),
          textField(identity.task_id),
          'legacy',
          'legacy',
        );
      } else {
        const loaded = await fileConnectionReader.load(root, projectDescriptor(root));
        requireLegacyCardBackend(root, loaded.descriptor.project_id, textField(options.card));
      }
    }
    const previous =
      saved === null || saved.request.human_source === undefined
        ? undefined
        : {
            source: saved.request.human_source as InputRef,
            turn_id: textField(
              saved.request.previous_source_turn ?? object(saved.request.anchor).turn_id,
            ),
          };
    const context = await taskChatContext(root, previous);
    const nativeMarker = contentHash(canonical(context.observed.source));
    requireWorkflow(
      context.observed.sandbox_policy === 'danger-full-access' &&
        context.observed.approval_policy === 'never' &&
        context.observed.permission_profile === 'disabled',
      'chat-write-profile-unsupported',
    );
    const path = resolve(options.state, 'managed-chat.json');
    const hasSelection =
      options.councilSelection !== undefined || Object.keys(options.skipped).length > 0;
    // A repeated start can reuse the selection after reading the managed state under the lock.
    requireWorkflow(
      options.action !== 'start' || hasSelection || existsSync(path),
      'council-selection-required',
    );
    await mkdir(options.state, { recursive: true, mode: 0o700 });
    safeDirectory(options.state);
    const control = resolve(options.state, 'controller');
    await mkdir(control, { recursive: true, mode: 0o700 });
    return await withChatWriter(resolve(control, 'state'), async () => {
      let state = readManaged<ManagedChat>(path);
      if (state !== null) diagnostic = path;
      requireWorkflow(state !== null || options.action === 'start', 'managed-chat-not-started');
      const choosing = state === null || options.action === 'revise';
      if (state !== null && !choosing) {
        requireWorkflow(
          Object.keys(options.skipped).length === 0 ||
            (state.council_selection == null &&
              canonical(options.skipped) === canonical(state.skipped)),
          'managed-chat-selection-revision-required',
        );
        if (options.councilSelection !== undefined) {
          requireWorkflow(
            state.council_selection != null &&
              state.council_selection.locator === options.councilSelection,
            'managed-chat-selection-revision-required',
          );
          await new FileWorkflowInputs(root, options.state).verify([state.council_selection]);
        }
      }
      requireWorkflow(!choosing || hasSelection, 'council-selection-required');
      const readSelection = (configuration?: CouncilConfiguration) =>
        options.councilSelection !== undefined
          ? readTaskCouncilSelection(root, options.councilSelection, configuration)
          : null;
      let localPlan: unknown = choosing ? undefined : state?.local_plan;
      if (choosing && options.localPlan !== undefined) {
        let locator = diagnostic;
        try {
          const source = await projectText(root, options.localPlan);
          locator = resolve(root, options.localPlan);
          try {
            localPlan = JSON.parse(source) as unknown;
          } catch {
            throw new Error('invalid-local-plan-json');
          }
          validateLocalPlan(localPlan);
        } catch (cause) {
          localInput.failure = { cause, locator };
          throw cause;
        }
      } else if (localPlan !== undefined) validateLocalPlan(localPlan);
      diagnostic = state === null ? chatDiagnostic : path;
      const planOption = options.plan ?? options.localPlan;
      if (state === null) {
        const card = textField(options.card),
          plan = textField(planOption);
        taskChatGates((await taskChatBrief(root, card)).criteria, options.human);
        const descriptor = projectDescriptor(root);
        const loaded = await fileConnectionReader.load(root, descriptor);
        const selectionPlan = await readSelection(loaded.descriptor.council);
        const connected = await connectChatTask(root, {
          descriptor,
          journal: resolve(options.state, 'connection'),
          cards: [card],
          create: null,
        });
        const files = new FileWorkflowInputs(root, options.state);
        const refs = [
          ...new Set([
            card,
            plan,
            ...options.sources,
            ...(localPlan === undefined ? [] : localPlanRefs(localPlan).map((ref) => ref.locator)),
            ...loaded.descriptor.rules,
            ...(selectionPlan === null ? [] : [selectionPlan.ref.locator]),
          ]),
        ];
        const runSources = await taskChatSources(files, refs, localPlan);
        const { selection, inputs } = await taskChatSelection(
          files,
          refs,
          options.skipped,
          options.targets,
          selectionPlan === null
            ? undefined
            : {
                plan: selectionPlan,
                shared: sharedCouncilSources(runSources, selectionPlan.ref.locator, plan, card),
                directory: options.state,
              },
          loaded.descriptor.council,
        );
        const assignment = await files.ref(plan);
        const project = loaded.descriptor.project_id;
        const runId = `chat-${contentHash(options.state).slice(0, 20)}`;
        const workspace = `tmp/agent-workflow/${runId}`;
        await mkdir(resolve(root, workspace), { recursive: true, mode: 0o700 });
        safeDirectory(resolve(root, workspace));
        const spec: RunSpec = {
          project_id: project,
          identity: { task_id: connected.plan.task_id, card: await files.ref(card) },
          assignment,
          product: true,
          run_id: runId,
          session_id: context.observed.thread_id,
          host_id: 'local',
          workspace: root,
          parent_run_id: null,
          coordinator: false,
          role: null,
          fork_turns: 'none',
          writer: runId,
          ...(await taskChatBrief(root, card)),
          requested: {
            model: context.observed.model,
            effort: context.observed.effort,
            permissions: ['read', 'implement', 'update-card', 'produce-evidence'],
          },
          effective: null,
          sources: runSources,
          procedures: loaded.descriptor.procedures,
          procedure_loading: 'by-action',
          rules: loaded.rules.map(({ locator, hash }) => ({ locator, hash })),
          route:
            localPlan === undefined
              ? { kind: 'substantial', accepted_plan: null }
              : {
                  kind: 'local',
                  accepted_plan: null,
                  plan: localPlan,
                },
        };
        const council = createCouncil(
          'planning',
          selection,
          {
            scope: spec.outcome,
            base: assignment.hash,
            diff: assignment,
            inputs,
          },
          loaded.descriptor.council,
        );
        state = {
          schema_version: localPlan === undefined ? 1 : 2,
          runtime_package_version: runtimePackageVersion,
          ...(localPlan === undefined ? {} : { local_plan: localPlan }),
          root,
          owner: spec.session_id,
          binary: options.binary,
          card,
          plan,
          sources: options.sources,
          targets: options.targets,
          skipped: options.skipped,
          council_selection: selectionPlan?.ref ?? null,
          human: options.human,
          council,
          revision_event: null,
          request: {
            schema_version: 1,
            runtime_package_version: runtimePackageVersion,
            root,
            descriptor,
            evidence_root: options.state,
            connection_journal: resolve(options.state, 'connection'),
            storage: {
              root: resolve(options.state, 'store'),
              grant: {
                context: {
                  schema_version: evidenceSchema,
                  project_id: project,
                  task_id: connected.plan.task_id,
                  subtask_id: null,
                  run_id: runId,
                  actor_id: spec.session_id,
                },
                permissions: ['read', 'produce', 'resolve', 'manage'],
              },
            },
            generation: 1,
            planning_file: `${workspace}/planning.json`,
            spec,
            code: true,
          },
        };
        saveManaged(path, state, true, 'minimal');
        diagnostic = path;
      }
      requireWorkflow(
        [1, 2].includes(state.schema_version) &&
          state.root === root &&
          state.owner === context.observed.thread_id,
        'managed-chat-identity-mismatch',
      );
      requireWorkflow(
        options.card === undefined || options.card === state.card,
        'managed-chat-card-conflict',
      );
      requireWorkflow(
        options.action === 'revise' || planOption === undefined || planOption === state.plan,
        'managed-chat-plan-conflict',
      );
      const request: ManagedChat['request'] = {
        ...state.request,
        transcript: context.transcript,
        anchor: context.anchor,
        human_source: context.human_source,
        lease_until: Date.now() + 30 * 60_000,
      };
      delete request.previous_source_turn;
      if (context.previous_source_turn !== undefined)
        request.previous_source_turn = context.previous_source_turn;
      const loaded = await fileConnectionReader.load(root, textField(request.descriptor));
      requireWorkflow(
        sameValue(state.council.configuration, loaded.descriptor.council),
        'council-configuration-changed',
      );
      if (options.action === 'revise') {
        const connections = new FileTaskConnection(root);
        const prior = await connections.read(textField(request.connection_journal));
        if (prior.plan.descriptor.hash !== loaded.revision) {
          requireWorkflow(prior.receipt.phase === 'enabled', 'chat-connection-not-enabled');
          const plan = await connections.preview(
            textField(request.descriptor),
            state.card,
            prior.plan.task_id,
          );
          requireWorkflow(
            plan.project_id === prior.plan.project_id &&
              plan.from_version === 2 &&
              plan.before === plan.after,
            'chat-connection-refresh-requires-no-delta',
          );
          const journal = resolve(options.state, `connection-${loaded.revision}`);
          await connections.apply(plan, journal);
          request.connection_journal = journal;
          state.request = { ...state.request, connection_journal: journal };
          saveManaged(path, state, true, 'minimal');
        }
      }
      let status: Awaited<ReturnType<typeof executeChatRequest>> | null = null;
      let snapshot: TechnicalState | null = null;
      if (readManaged(resolve(options.state, 'store/chat-runtime.json')) !== null) {
        const storage = object(request.storage);
        const grant = storage.grant as EvidenceGrant;
        snapshot = unwrap<TechnicalState>(
          new SqliteEvidenceStore(textField(storage.root), grant, Date.now).execute({
            context: grant.context,
            command: { type: 'state', archive: 'current' },
          }),
        );
        if (snapshot.checkpoint !== null && object(snapshot.checkpoint).local_run !== undefined) {
          status = await executeChatRequest('status-chat', request);
          request.spec = (object(status).local as LocalRun).spec;
        }
      }
      requireWorkflow(
        status === null ||
          object(status).control === null ||
          object(object(status).control).status !== 'paused' ||
          options.action === 'continue',
        'managed-chat-resume-required',
      );
      const rules = loaded.rules.map(({ locator, hash }) => ({ locator, hash }));
      if (options.action === 'revise') {
        requireWorkflow(
          status !== null && options.affected.length > 0,
          'chat-revision-not-started',
        );
        const selectionPlan = await readSelection(loaded.descriptor.council);
        const current = object(status);
        const messages = current.messages as ChatMessages;
        if (object(current.ownership).expired === true) {
          request.marker = `managed:${nativeMarker}:${messages.requirements_revision}:${contentHash(canonical(actionProcedureLoading(request.spec) ? [...rules, ...loaded.descriptor.procedures] : rules))}`;
          const { reads } = await context.host.readSelection(
            startLocalRun({ ...request.spec, rules, procedures: loaded.descriptor.procedures }, 1),
            textField(request.marker),
          );
          const pending = [
            ...selectedProcedures({ ...request.spec, procedures: loaded.descriptor.procedures }),
            ...rules,
          ].filter((r) => !reads.has(r.locator));
          if (pending.length > 0) {
            write(
              JSON.stringify({
                status: 'LOAD_REQUIRED',
                reason: 'Не подтверждено полное наблюдаемое чтение текущего набора.',
                next_action: ['task-chat', 'load', '--state', options.state],
                details: { locator: resolve(options.state, 'request.json') },
                remaining: pending.length,
                command: ['task-chat', 'load', '--state', options.state],
              }),
            );
            return 0;
          }
        }
        const plan = textField(planOption);
        const files = new FileWorkflowInputs(root, options.state);
        const assignment = await files.ref(plan),
          card = await files.ref(state.card);
        const brief = await taskChatBrief(root, state.card);
        const human = [
          ...new Set([
            ...state.human.filter((criterion) => brief.criteria.includes(criterion)),
            ...options.human,
          ]),
        ];
        const sources = [...new Set([...state.sources, ...options.sources])];
        const targets = [...new Set([...state.targets, ...options.targets])];
        const id = `requirements:${contentHash(
          canonical({
            source: context.human_source,
            assignment,
            card,
            affected: options.affected,
            sources,
            targets,
            human,
            skipped: options.skipped,
            selection: selectionPlan,
            rules,
            procedures: loaded.descriptor.procedures,
          }),
        )}`;
        const previous = messages.history.find((e) => e.id === id);
        let event: ChatMessageEvent;
        if (previous && previous.fingerprint === undefined)
          event = JSON.parse(previous.payload) as ChatMessageEvent;
        else if (state.revision_event?.id === id) event = state.revision_event;
        else {
          const refs = [
            ...new Set([
              state.card,
              plan,
              ...state.sources,
              ...options.sources,
              ...(localPlan === undefined
                ? []
                : localPlanRefs(localPlan).map((ref) => ref.locator)),
              ...rules.map((r) => r.locator),
              ...(selectionPlan === null ? [] : [selectionPlan.ref.locator]),
            ]),
          ];
          const runSources = await taskChatSources(files, refs, localPlan);
          const { selection, inputs } = await taskChatSelection(
            files,
            refs,
            options.skipped,
            targets,
            selectionPlan === null
              ? undefined
              : {
                  plan: selectionPlan,
                  shared: sharedCouncilSources(
                    runSources,
                    selectionPlan.ref.locator,
                    plan,
                    card.locator,
                  ),
                  directory: options.state,
                },
            loaded.descriptor.council,
          );
          const target = { scope: brief.outcome, base: assignment.hash, diff: assignment, inputs };
          event = {
            type: 'REQUIREMENTS',
            id,
            expected_revision: previous?.expected_revision ?? messages.revision,
            generation: previous?.generation ?? messages.generation,
            thread_id: state.owner,
            source: context.human_source,
            affected: options.affected,
            revision: {
              ...brief,
              assignment,
              card,
              rules,
              procedures: loaded.descriptor.procedures,
              sources: runSources,
            },
            target,
            gates: taskChatGates(brief.criteria, human),
          };
          if (previous === undefined)
            state.council = revisePlanning(
              state.council,
              await restoreCouncilSelection(state.council, selection, files),
              target,
              await unstartedPlanningReviews(state.council, root, options.state),
            );
        }
        if (
          previous?.fingerprint !== undefined &&
          retentionFingerprint(event) !== previous.fingerprint
        ) {
          requireWorkflow(
            event.type === 'REQUIREMENTS' &&
              snapshot?.checkpoint !== null &&
              snapshot?.checkpoint !== undefined,
            'chat-revision-intent-unrecoverable',
          );
          const checkpoint = object(snapshot.checkpoint),
            spec = object(checkpoint.local_run).spec as RunSpec,
            execution = object(object(checkpoint.workflow).execution);
          requireWorkflow('task_id' in spec.identity, 'chat-revision-intent-unrecoverable');
          const recovered: ChatMessageEvent = {
            ...event,
            revision: {
              assignment: spec.assignment,
              sources: spec.sources,
              scope: spec.scope,
              outcome: spec.outcome,
              criteria: spec.criteria,
              rules: spec.rules,
              procedures: spec.procedures,
              card: spec.identity.card,
            },
            target: execution.target as ReviewTarget,
            gates: execution.gates as Gate[],
          };
          requireWorkflow(
            retentionFingerprint(recovered) === previous.fingerprint,
            'chat-revision-intent-unrecoverable',
          );
          event = recovered;
        }
        state.revision_event = event;
        state.plan = plan;
        if (localPlan === undefined) delete state.local_plan;
        else {
          state.schema_version = 2;
          state.local_plan = localPlan;
          state.council = { ...state.council, advisers: {} };
        }
        state.sources = sources;
        state.targets = targets;
        state.human = human;
        state.skipped = options.skipped;
        state.council_selection = selectionPlan?.ref ?? null;
        // Save the complete intent before REQUIREMENTS; replay recovers the same revision after a lost reply.
        saveManaged(path, state, true, 'minimal');
        const changed = object(
          await executeChatRequest(
            object(current.ownership).expired === true ? 'continue-chat' : 'messages-chat',
            { ...request, message: event },
          ),
        );
        request.spec = (changed.run as LocalRun).spec;
        status = await executeChatRequest('status-chat', request);
        state.request = request;
        // Keep the exact accepted intent for a retry after LOAD, even if implementation inputs changed.
        saveManaged(path, state, true, 'minimal');
      }
      const revision =
        status === null
          ? 0
          : ((object(status).messages as ChatMessages | null)?.requirements_revision ?? 0);
      const marker = `managed:${nativeMarker}:${revision}:${contentHash(canonical(actionProcedureLoading(request.spec) ? [...rules, ...loaded.descriptor.procedures] : rules))}`;
      Object.assign(request, { marker, gates: taskChatGates(request.spec.criteria, state.human) });
      const run =
        status === null ? startLocalRun(request.spec, 1) : (object(status).local as LocalRun);
      const { reads, fragments } = await context.host.readSelection(
        { ...run, spec: { ...run.spec, rules, procedures: loaded.descriptor.procedures } },
        marker,
        context.previous_source_turn !== undefined,
      );
      const additional: ProcedureId[] =
        options.action === 'load'
          ? [
              ...((request.load_procedures as ProcedureId[] | undefined) ?? [
                'implementation',
                'council',
              ]),
              ...options.procedures,
            ]
          : options.action === 'continue'
            ? []
            : ['implementation', 'council'];
      const selected = selectedProcedures(
        { ...run.spec, procedures: loaded.descriptor.procedures },
        additional,
      );
      let pending = [
        ...loaded.procedures.filter((p) => selected.some((s) => s.id === p.id)),
        ...loaded.rules,
      ].filter((r) => !reads.has(r.locator));
      const compactReady = (info: Record<string, unknown>) => {
        const receipt = info.receipt as LoadReceipt | null | undefined;
        return (
          receipt != null &&
          selected.every((procedure) =>
            receipt.procedures.some((loaded) => loaded.id === procedure.id),
          )
        );
      };
      const compact =
        run.spec.context_loading === 'fragments-v1' &&
        status !== null &&
        (await context.host.compaction()) !== undefined;
      if (options.action === 'load') {
        if (compact) {
          let info: Record<string, unknown>;
          try {
            info = object(
              await executeChatRequest('compact-context-chat', {
                ...request,
                compact_action: request.load_action ?? 'continue-chat',
              }),
            );
          } catch {
            info = { status: 'full-recovery' };
          }
          if (info.status === 'read-required') {
            pending = pending.filter((entry) =>
              run.spec.rules.some((rule) => rule.locator === entry.locator),
            );
            if (pending.length === 0) {
              write(
                JSON.stringify({
                  chat_compact: info.chat_compact,
                  action: info.action,
                  payload_hash: info.payload_hash,
                  state_hash: info.state_hash,
                  hash: info.hash,
                  content: info.content,
                }),
              );
              return 0;
            }
          } else if (compactReady(info)) return 0;
        }
        let bytes = 0;
        for (const entry of pending) {
          const offset = fragments.get(entry.locator)?.length ?? 0;
          let size = Math.min(8000, entry.content.length - offset);
          let split = offset > 0 || entry.content.length > size;
          const render = () =>
            JSON.stringify({
              chat_read: marker,
              locator: entry.locator,
              hash: entry.hash,
              content: split ? entry.content.slice(offset, offset + size) : entry.content,
              ...(split ? { offset, length: entry.content.length } : {}),
            });
          let line = render();
          if (bytes > 0 && bytes + Buffer.byteLength(line + '\n') > options.loadBytes) break;
          while (Buffer.byteLength(line + '\n') > options.loadBytes) {
            size = Math.floor(size / 2);
            requireWorkflow(size > 0, 'chat-load-budget-too-small');
            split = true;
            line = render();
          }
          write(line);
          bytes += Buffer.byteLength(line + '\n');
          if (split) break;
        }
        return 0;
      }
      request.load_procedures = additional;
      state.request = request;
      saveManaged(path, state, true, 'minimal');
      if (compact) pending = [];
      if (pending.length > 0) {
        write(
          JSON.stringify({
            status: 'LOAD_REQUIRED',
            reason: 'Не подтверждено полное наблюдаемое чтение текущего набора.',
            next_action: ['task-chat', 'load', '--state', options.state],
            details: { locator: resolve(options.state, 'request.json') },
            remaining: pending.length,
            command: ['task-chat', 'load', '--state', options.state],
          }),
        );
        return 0;
      }
      const execute = async (
        command: 'continue-chat' | 'prepare-chat' | 'bootstrap-chat' | 'execution-chat',
        payload: typeof request,
      ) => {
        if (compact) {
          state.request = { ...payload, load_action: command };
          saveManaged(path, state, true, 'minimal');
          let info: Record<string, unknown>;
          try {
            info = object(
              await executeChatRequest('compact-context-chat', {
                ...payload,
                compact_action: command,
              }),
            );
          } catch (cause) {
            info = {
              receipt: null,
              reason: cause instanceof Error ? cause.message : 'chat-compact-outcome-unknown',
            };
          }
          if (!compactReady(info)) {
            const cause = new Error('managed-compact-load-required');
            compactLoad.required = {
              cause,
              result: {
                status: 'LOAD_REQUIRED',
                reason:
                  info.reason ?? 'Не подтверждено чтение краткого контекста текущего действия.',
                next_action: ['task-chat', 'load', '--state', options.state],
                details: { locator: path },
              },
            };
            throw cause;
          }
        }
        return executeChatRequest(command, payload);
      };
      if (
        status !== null &&
        object(status).resume_required === true &&
        options.action !== 'continue'
      )
        await execute('continue-chat', request);
      if (options.action === 'continue' && status !== null && object(status).control !== null) {
        const result = await execute('continue-chat', request);
        const resumed = object(result).run as LocalRun;
        request.spec = resumed.spec;
        status = await executeChatRequest('status-chat', request);
        if (resumed.status === 'ready') {
          saveManaged(resolve(options.state, 'request.json'), request);
          write(
            JSON.stringify({
              status: 'ready',
              request: resolve(options.state, 'request.json'),
              result: briefChatResult('continue-chat', result, request),
            }),
          );
          return 0;
        }
      }
      const files = new FileWorkflowInputs(root, options.state);
      await files.verify(request.spec.sources);
      if (status === null || object(status).control === null) {
        const prepared = object(await execute('prepare-chat', request));
        request.spec = (prepared.run as LocalRun).spec;
        status = await executeChatRequest('status-chat', request);
      }
      if (status === null || object(object(status).local).status !== 'ready') {
        if (state.local_plan === undefined)
          state.council = await runTaskChatCouncil(
            state.council,
            request.spec,
            resolve(options.state, 'council'),
            state.binary,
            (council) => {
              state.council = council;
              saveManaged(path, state, true, 'minimal');
              state.council = readManaged<ManagedChat>(path)!.council;
              return state.council;
            },
            write,
            options.state,
            councilWaitGuard(request, context.host),
          );
        const local =
          state.local_plan === undefined
            ? undefined
            : {
                plan: state.local_plan,
                source: request.spec.assignment,
                inputs: state.council.target.inputs,
                selection: state.council.selection,
                ...(state.council.configuration === undefined
                  ? {}
                  : { configuration: state.council.configuration }),
              };
        if (local) validateLocalAdmission(local, state.council.target);
        else
          requireWorkflow(councilBlockers(state.council).length === 0, 'chat-planning-unconfirmed');
        const planning = `${dirname(textField(request.planning_file))}/planning-${revision}-${contentHash(canonical(state.council))}.json`;
        request.planning_file = planning;
        saveManaged(
          resolve(root, planning),
          {
            schema_version: local === undefined ? 1 : 2,
            ...(local === undefined ? {} : { local }),
            task_id: object(request.spec.identity).task_id,
            council: state.council,
            requirements_revision: revision,
            assignment: request.spec.assignment,
            ...(state.council_selection == null
              ? {}
              : { council_selection: state.council_selection }),
          },
          true,
          'minimal',
        );
        request.spec = {
          ...request.spec,
          route:
            local === undefined
              ? { kind: 'substantial', accepted_plan: await files.ref(planning) }
              : { kind: 'local', accepted_plan: await files.ref(planning), plan: local.plan },
        };
        state.request = request;
        saveManaged(path, state, true, 'minimal');
        await execute('bootstrap-chat', request);
      }
      const gates = taskChatGates(request.spec.criteria, state.human);
      const result = await execute('execution-chat', { ...request, gates });
      saveManaged(resolve(options.state, 'request.json'), { ...request, gates });
      write(
        JSON.stringify({
          status: 'implementing',
          request: resolve(options.state, 'request.json'),
          result: briefChatResult('execution-chat', result, request),
        }),
      );
      return 0;
    });
  } catch (cause) {
    if (compactLoad.required !== null && compactLoad.required.cause === cause) {
      write(JSON.stringify(compactLoad.required.result));
      return 0;
    }
    const input =
      localInput.failure !== null && localInput.failure.cause === cause ? localInput.failure : null;
    return reportTaskChatFailure(cause, diagnostic, input, write, error);
  }
}
