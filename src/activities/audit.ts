import { taskProgressAuditActivities } from './progressAudit.js';
import type { TaskProgressAuditActivities } from '../contracts/progressAudit.js';
import { taskStageAuditActivities } from './stageAudit.js';
import type { TaskStageAuditActivities } from '../contracts/stageAudit.js';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type {
  AuditInput,
  AuditorActivities,
  AuditorControls,
  AuditorSession,
} from '../contracts/audit.js';
import type { ArtifactRef } from '../contracts/preparation.js';
import type { CodexRpc } from '../contracts/codex.js';
import type { ReaderEpoch, ReaderInput } from '../contracts/reader.js';
import type { ReaderAuthority, ReaderExecution } from '../contracts/readerControl.js';
import type { LocalProjectRegistration } from './preparation.js';
import type { readerBoundary } from '../adapters/codex/readerBoundary.js';
import { object, requireContract, text } from '../contracts/project.js';
import { parsePreparation, checkRegistration } from '../policy/preparation.js';
import { taskBackendGuard } from '../adapters/project/taskBackend.js';
import { captureRegistration } from '../adapters/project/preparation.js';
import {
  parseAuditCard,
  parseAuditInput,
  parseAuditReport,
  auditWorkflowKey,
} from '../policy/audit.js';
import { readerKey, controlRef } from '../policy/readerControl.js';
import {
  artifactStore,
  digest,
  privateDirectory,
  publishFile,
  readPrivateFile,
  readProjectFile,
} from '../adapters/artifacts/files.js';
import { effectJournal } from '../adapters/artifacts/effects.js';
import {
  auditParentProfile,
  auditorProfile,
  nativeAuditChild,
  nativeAuditCalls,
  confirmAuditorSession,
  auditChildTurn,
  confirmAuditDelivery,
} from '../adapters/codex/nativeAudit.js';
import { readerSession } from '../adapters/codex/readerSession.js';
import { readerLoadPrompt } from '../adapters/codex/readerMessages.js';
import { confirmObservedLoad } from '../adapters/codex/observedLoad.js';
import { taskAuditActivities } from './taskAudit.js';
import type { TaskAuditActivities } from '../contracts/taskAudit.js';
import { verifyAuditResult, observeAuditProof } from '../adapters/codex/auditProof.js';
import { recoverSentTurn } from '../adapters/codex/recoveredSend.js';
import { readerControlActivities } from './readerControl.js';
import { preparationActivities } from './preparation.js';
import {
  auditorRole as role,
  auditLoadFiles,
  confirmAuditorInputs,
} from '../adapters/codex/auditInputs.js';

export function auditorActivities(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  profile: ReaderExecution['profile'],
  boundary: ReturnType<typeof readerBoundary>,
  directory: string,
  consume: (key: string, hash: string) => void,
  authority: ReaderAuthority,
) {
  requireContract(same(profile, auditParentProfile), 'auditor-client-unsupported');
  const backend = taskBackendGuard(
    registration.workspaceRoot,
    registration.taskBackend === 'required',
  );
  registration = captureRegistration(registration);
  const store = artifactStore(registration.artifactRoot),
    root = privateDirectory(directory),
    journal = effectJournal(join(root, 'effects'));
  const save = (v: unknown) => store.publish(Buffer.from(JSON.stringify(v)));
  const read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  const entries = new Map<
    string,
    { input: AuditInput; reader: ReaderInput; permit: ArtifactRef | null; home: string }
  >();
  const fresh = new Set<string>();
  const base = readerControlActivities(registration, rpc, boundary, authority);
  function once(path: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    try {
      publishFile(path, bytes);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      requireContract(readPrivateFile(path).equals(bytes), 'auditor-binding-conflict');
    }
  }
  function context(raw: AuditInput) {
    const input = parseAuditInput(raw);
    checkRegistration(input.preparation, registration);
    role(input.preparation);
    const key = auditWorkflowKey(input),
      reader: ReaderInput = {
        preparation: { ...input.preparation, taskId: 'audit_' + digest(key).slice(0, 48) },
        roleId: 'auditor',
      };
    const home = privateDirectory(join(root, digest(key)));
    once(join(home, 'binding.json'), input);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { input, reader, permit: null, home };
      entries.set(key, entry);
    }
    requireContract(same(entry.input, input), 'auditor-input-conflict');
    return entry;
  }
  function active(input: AuditInput, epoch: ReaderEpoch) {
    backend.require(
      input.preparation.project.projectId,
      input.preparation.taskId,
      'temporal',
      'worker',
      input.preparation.card,
    );
    const entry = context(input);
    boundary.boundary.assert(entry.reader, epoch);
    return entry;
  }
  function card(input: AuditInput) {
    const body = parseAuditCard(read(input.card));
    requireContract(same(body.preparation, input.preparation), 'auditor-card-binding');
    for (const source of body.sources) {
      const bytes = readProjectFile(registration.workspaceRoot, source.path);
      requireContract(
        bytes.length === source.bytes && digest(bytes) === source.sha256,
        'auditor-source-changed',
      );
      requireContract(digest(bytes.toString('utf8')) === source.sha256, 'auditor-nontext-input');
    }
    for (const ref of body.completed) store.read(ref);
    if (body.trigger.kind !== 'overrun') store.read(body.trigger.evidence);
    return body;
  }
  async function models() {
    const raw = object(await rpc.request('model/list', {}));
    requireContract(Array.isArray(raw.data), 'auditor-models-unknown');
    for (const requested of [auditParentProfile, auditorProfile])
      requireContract(
        raw.data
          .map(object)
          .some(
            (m) =>
              m.model === requested.model &&
              Array.isArray(m.supportedReasoningEfforts) &&
              m.supportedReasoningEfforts
                .map(object)
                .some((e) => e.reasoningEffort === requested.effort),
          ),
        'auditor-model-unavailable',
      );
    return save(raw);
  }
  async function tools() {
    const inventory = object(
      await rpc.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' }),
    );
    requireContract(
      Array.isArray(inventory.data) && inventory.nextCursor == null,
      'auditor-tools-incomplete',
    );
    const disabled = inventory.data.map(object).map((server) => text(server.name));
    requireContract(
      new Set(disabled).size === disabled.length &&
        disabled.every((name) => /^[A-Za-z0-9_-]+$/u.test(name)),
      'auditor-tools-invalid',
    );
    return { disabled: disabled.sort(), inventory: save(inventory) };
  }
  function current(input: AuditInput) {
    const { before } = confirmAuditorInputs(registration, input);
    card(input);
    return before;
  }
  function loadPrompt(input: AuditInput) {
    const before = current(input);
    return (
      readerLoadPrompt(before.refs as { path: string; sha256: string }[]) +
      ' После технического LOAD остановись. Когда получишь единственный локатор карточки, полностью прочитай саму карточку тем же форматом path/sha256/content (для крупных файлов частями) и затем верни одно agentMessage с JSON по responseContract в карточке. Не выполняй техническую приёмку.'
    );
  }
  function intent(input: AuditInput, operation: string, request: unknown) {
    const p = input.preparation;
    return {
      projectId: p.project.projectId,
      taskId: p.taskId,
      operationId: 'auditor_' + digest(JSON.stringify([input.auditId, operation])),
      requestHash: digest(JSON.stringify(request)),
      hostId: p.hostId,
      workspaceId: p.project.workspaceId,
      owner: p.owner,
      generation: p.generation,
    };
  }
  async function parentThread(id: string) {
    const raw = object(await rpc.request('thread/read', { threadId: id, includeTurns: true }));
    const thread = object(raw.thread);
    requireContract(
      thread.id === id && thread.cwd === registration.workspaceRoot && Array.isArray(thread.turns),
      'auditor-parent-history',
    );
    return thread;
  }
  async function childThread(session: AuditorSession) {
    const raw = object(
      await rpc.request('thread/read', { threadId: session.child, includeTurns: true }),
    );
    const t = object(raw.thread);
    requireContract(
      t.id === session.child &&
        t.cwd === registration.workspaceRoot &&
        t.parentThreadId === session.parent.id &&
        t.agentRole === 'auditor' &&
        t.forkedFromId === null &&
        Array.isArray(t.turns),
      'auditor-child-identity',
    );
    return t;
  }
  async function parentRestore(
    input: AuditInput,
    session: AuditorSession['parent'],
    epoch: ReaderEpoch,
  ) {
    const proof = read(session.creation);
    requireContract(
      proof.kind === 'auditor-parent' && same(proof.input, input),
      'auditor-parent-binding',
    );
    readerSession(proof.response, registration.workspaceRoot, profile, session.id);
    if (fresh.delete(session.id)) {
      const loaded = object(await rpc.request('thread/loaded/list', {}));
      requireContract(
        Array.isArray(loaded.data) && loaded.data.includes(session.id),
        'auditor-parent-connection-lost',
      );
      return;
    }
    active(input, epoch);
    const original = object(proof.params),
      params = {
        threadId: session.id,
        excludeTurns: false,
        cwd: original.cwd,
        model: original.model,
        approvalPolicy: original.approvalPolicy,
        sandbox: original.sandbox,
        config: original.config,
        developerInstructions: original.developerInstructions,
        allowProviderModelFallback: false,
      };
    readerSession(
      await boundary.boundary.dispatch(
        context(input).reader,
        epoch,
        intent(input, 'resume', { session: session.id }).operationId,
        'thread/resume',
        params,
        () => rpc.request('thread/resume', params),
      ),
      registration.workspaceRoot,
      profile,
      session.id,
    );
  }
  async function send(
    input: AuditInput,
    parent: AuditorSession['parent'],
    operation: string,
    prompt: string,
    epoch: ReaderEpoch,
  ) {
    const entry = active(input, epoch),
      request = { parent: parent.id, prompt },
      spec = intent(input, operation, request),
      message = `Workflow operation: ${spec.operationId}\n${prompt}`;
    const ref = await journal.execute(
      spec,
      async () => {
        consume(digest(spec.operationId + ':native-child'), digest(JSON.stringify(request)));
        const response = object(
          await boundary.boundary.dispatch(
            entry.reader,
            epoch,
            spec.operationId,
            'turn/start',
            { threadId: parent.id, input: [{ type: 'text', text: message }] },
            () =>
              rpc.request('turn/start', {
                threadId: parent.id,
                input: [{ type: 'text', text: message }],
              }),
          ),
        );
        return save({ parent: parent.id, turn: text(object(response.turn).id) });
      },
      async () => {
        const t = await parentThread(parent.id),
          id = recoverSentTurn({ thread: t }, parent.id, message);
        return id === null ? null : save({ parent: parent.id, turn: id });
      },
    );
    const accepted = read(ref);
    requireContract(accepted.parent === parent.id, 'auditor-send-binding');
    const turn = text(accepted.turn);
    await rpc.completed(parent.id, turn);
    active(input, epoch);
    return turn;
  }
  async function nativeSession(session: AuditorSession) {
    const raw = await rpc.request('thread/resume', { threadId: session.child, excludeTurns: true });
    confirmAuditorSession(raw, session.parent.id, session.child, registration.workspaceRoot);
    return save({
      kind: 'auditor-native-session',
      method: 'thread/resume',
      request: { threadId: session.child, excludeTurns: true },
      response: raw,
    });
  }
  const activities: AuditorActivities &
    TaskAuditActivities &
    TaskStageAuditActivities &
    TaskProgressAuditActivities = {
    ...taskAuditActivities(registration, rpc),
    ...taskStageAuditActivities(registration, rpc),
    ...taskProgressAuditActivities(registration, rpc),
    async verifyAuditResult(input, result, stop) {
      context(input);
      return verifyAuditResult(registration, rpc, input, result, stop);
    },
    async preflightAuditor(raw) {
      const preparation = parsePreparation(raw);
      checkRegistration(preparation, registration);
      const declared = auditLoadFiles(registration, preparation);
      const prepared = await preparationActivities(registration).prepareProject(preparation);
      const { procedures, refs } = declared;
      return save({
        kind: 'auditor-preflight',
        preparation,
        prepared,
        role: declared.role,
        profile,
        procedures,
        refs,
        models: await models(),
        tools: await tools(),
      });
    },
    async registerAuditor(input) {
      backend.require(
        input.preparation.project.projectId,
        input.preparation.taskId,
        'temporal',
        'worker',
        input.preparation.card,
      );
      const entry = context(input);
      current(input);
      try {
        readPrivateFile(join(entry.home, 'stopping.json'));
        throw new Error('auditor-already-stopping');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      once(join(entry.home, 'registering.json'), entry.input);
      const permit = await base.registerReader(entry.reader, readerKey(entry.reader));
      entry.permit = permit;
      once(join(entry.home, 'permit.json'), permit);
      return permit;
    },
    async launchAuditor(input, epoch) {
      const entry = active(input, epoch),
        before = current(input);
      await models();
      const inventory = await tools();
      requireContract(
        same(inventory.disabled, object(before.tools).disabled),
        'auditor-tools-changed',
      );
      active(input, epoch);
      const params = {
        projectId: null,
        cwd: registration.workspaceRoot,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ephemeral: false,
        allowProviderModelFallback: false,
        model: profile.model,
        config: {
          model_reasoning_effort: profile.effort,
          sandbox_read_only: { network_access: false },
          web_search: 'disabled',
          mcp_servers: Object.fromEntries(
            inventory.disabled.map((name) => [name, { enabled: false }]),
          ),
          features: {
            apps: false,
            plugins: false,
            memories: false,
            request_permissions_tool: false,
          },
          agents: {
            enabled: true,
            max_concurrent_threads_per_session: 1,
            auditor: {
              config_file: resolve(registration.workspaceRoot, role(input.preparation).profile),
              description:
                'Independent native workflow auditor; technical LOAD before the sole card',
            },
          },
        },
        developerInstructions:
          'You are only a native-auditor launcher. You own no task and may not inspect task contents. Perform exactly the requested single native spawn or single followup to the same auditor, then stop. Never wait, read files, run code, create another role or send an extra message.',
      };
      const spec = intent(input, 'parent', { params, preflight: input.preflight });
      const creation = await journal.execute(
        spec,
        async () => {
          const response = await boundary.boundary.dispatch(
            entry.reader,
            epoch,
            spec.operationId,
            'thread/start',
            params,
            () => rpc.request('thread/start', params),
          );
          const observed = readerSession(response, registration.workspaceRoot, profile);
          requireContract(
            (observed.thread.turns as unknown[]).length === 0,
            'auditor-parent-not-fresh',
          );
          fresh.add(observed.id);
          return save({ kind: 'auditor-parent', input, params, response });
        },
        async () => {
          const response = boundary.boundary.response(
            entry.reader,
            epoch,
            spec.operationId,
            'thread/start',
          );
          return response === null
            ? null
            : save({ kind: 'auditor-parent', input, params, response });
        },
      );
      const parent = {
        id: readerSession(read(creation).response, registration.workspaceRoot, profile).id,
        creation,
      };
      await parentRestore(input, parent, epoch);
      const load = loadPrompt(input),
        operation = 'audit_' + digest(auditWorkflowKey(input)).slice(0, 48),
        args = { task_name: operation, agent_type: 'auditor', fork_turns: 'none', message: load };
      const prompt = `Use the native spawn_agent tool exactly once with exactly these arguments: ${JSON.stringify(args)}. agent_type auditor is mandatory. If unsupported, stop with NOT RUN; never substitute model/effort overrides. Stop immediately after the tool result. No wait, followup, other tool or audit.`;
      const parentTurn = await send(input, parent, 'launch', prompt, epoch),
        observed = await parentThread(parent.id),
        child = nativeAuditChild(observed, operation);
      requireContract(
        child.parentTurn === parentTurn && same(before, current(input)),
        'auditor-launch-binding',
      );
      return { parent, child: child.id, path: child.path, parentTurn };
    },
    async observeAuditorLoad(input, session, epoch) {
      active(input, epoch);
      current(input);
      const t = await childThread(session);
      if ((t.turns as unknown[]).length === 0) return null;
      const turn = auditChildTurn(t, session.parentTurn);
      if (turn.status === 'inProgress') return null;
      if (turn.status !== 'completed') {
        const receipt = save({ kind: 'auditor-load-rejected', input, session, turn });
        throw new Error('auditor-load-not-completed:' + receipt.sha256);
      }
      requireContract((t.turns as unknown[]).length === 1, 'auditor-load-history');
      const parent = await parentThread(session.parent.id),
        launched = nativeAuditChild(
          parent,
          'audit_' + digest(auditWorkflowKey(input)).slice(0, 48),
        );
      requireContract(
        launched.id === session.child &&
          launched.path === session.path &&
          launched.parentTurn === session.parentTurn,
        'auditor-launch-binding',
      );
      const delivery = confirmAuditDelivery(
        t,
        session.parentTurn,
        session.path,
        launched.message,
        loadPrompt(input),
      );
      confirmObservedLoad(turn, current(input).refs as { path: string; sha256: string }[]);
      const native = await nativeSession(session);
      active(input, epoch);
      return save({
        kind: 'auditor-load',
        input,
        session,
        turn,
        native,
        preflight: input.preflight,
        delivery,
      });
    },
    async prepareAuditQuestion(input, session, load, epoch) {
      active(input, epoch);
      const proof = read(load);
      requireContract(
        proof.kind === 'auditor-load' && same(proof.input, input) && same(proof.session, session),
        'auditor-load-binding',
      );
      const facts = card(input),
        native = read(controlRef(proof.native));
      confirmAuditorSession(
        native.response,
        session.parent.id,
        session.child,
        registration.workspaceRoot,
      );
      const refs =
        facts.trigger.kind === 'overrun'
          ? facts.completed
          : [...facts.completed, facts.trigger.evidence];
      const declared = refs.map((ref) => ({
        ref,
        path: store.path(ref),
        content: store.read(ref).toString('utf8'),
      }));
      const evidence = [...new Map(declared.map((row) => [row.ref.sha256, row])).values()];
      const sources = facts.sources.map((ref) => ({
        ...ref,
        content: readProjectFile(registration.workspaceRoot, ref.path).toString('utf8'),
      }));
      const allowedSources = [
        ...new Set([
          ...sources.map((s) => s.path),
          ...evidence.map((e) => e.path),
          store.path(input.card),
          store.path(controlRef(proof.native)),
        ]),
      ];
      return save({
        kind: 'native-audit-card',
        originalCard: input.card,
        facts,
        sources,
        evidence,
        native: { source: controlRef(proof.native), content: native },
        allowedSources,
        responseContract: {
          instruction:
            'Return one agentMessage with exactly this JSON shape. card is the originalCard reference below. Complete coverage requires one of the four directions. Unknown/incomplete facts require partial, direction null and explicit limitations. Reasons, nextResult and all human text in Russian. Do not grant acceptance, close findings, waive checks or change the task.',
          template: {
            schemaVersion: 1,
            card: input.card,
            coverage: 'complete|partial',
            direction: 'continue|replace-approach|replace-executor|reconsider-constraints|null',
            reasons: ['reason with source'],
            sources: allowedSources,
            checkpoint: facts.checkpoint,
            nextResult: 'next observable result',
            limitations: [],
          },
        },
      });
    },
    async answerAuditor(input, session, question, epoch) {
      active(input, epoch);
      current(input);
      const body = read(question);
      requireContract(
        body.kind === 'native-audit-card' &&
          same(body.originalCard, input.card) &&
          same(body.facts, card(input)),
        'auditor-question-binding',
      );
      await parentRestore(input, session.parent, epoch);
      const prompt = `Use native followup_task exactly once with exactly these arguments: ${JSON.stringify({ target: session.path, message: store.path(question) })}. The child's substantive message must contain only that locator. Never spawn, change model or effort, wait, add text, read files or use any other tool. Stop after the tool result.`;
      return send(input, session.parent, 'question', prompt, epoch);
    },
    async observeAuditAnswer(input, session, load, question, parentTurn, epoch) {
      active(input, epoch);
      current(input);
      const answer = await observeAuditProof(
        registration,
        rpc,
        input,
        session,
        load,
        question,
        parentTurn,
      );
      current(input);
      active(input, epoch);
      return answer;
    },
    async finishAudit(input, session, load, question, parentTurn, answer, epoch) {
      const verified = await activities.observeAuditAnswer(
        input,
        session,
        load,
        question,
        parentTurn,
        epoch,
      );
      requireContract(verified !== null && same(verified, answer), 'auditor-answer-unconfirmed');
      const body = read(answer),
        report = parseAuditReport(body.report, {
          ref: input.card,
          checkpoint: card(input).checkpoint,
          sources: [...(read(question).allowedSources as string[]), store.path(question)],
        });
      return {
        manifest: save({
          kind: 'audit-result',
          input,
          session,
          load,
          question,
          parentTurn,
          answer,
          report,
          acceptance: false,
        }),
        report: { coverage: report.coverage, direction: report.direction },
      };
    },
  };
  const controls: AuditorControls = {
    async stopAuditor(input, permit) {
      const entry = context(input);
      once(join(entry.home, 'stopping.json'), entry.input);
      if (permit === null) {
        try {
          readPrivateFile(join(entry.home, 'registering.json'));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          return save({ kind: 'auditor-not-started', input, confirmed: true });
        }
        permit =
          entry.permit ??
          controlRef(
            JSON.parse(readPrivateFile(join(entry.home, 'permit.json')).toString()) as unknown,
          );
      }
      const revision = await base.freezeReader(entry.reader, permit),
        parentStop = await base.stopReader(entry.reader, permit, revision),
        requests = boundary.requests(entry.reader, permit, revision),
        parents = new Set<string>(),
        observations: ArtifactRef[] = [];
      for (const r of requests.filter((r) => r.method === 'thread/start')) {
        requireContract(r.response !== null, 'auditor-stop-parent-unknown');
        parents.add(readerSession(r.response, registration.workspaceRoot, profile).id);
      }
      for (const id of parents) {
        const p = await parentThread(id);
        const calls = nativeAuditCalls(p),
          started = (p.turns as unknown[])
            .flatMap((t) => (object(t).items as unknown[]).map(object))
            .filter((i) => i.type === 'subAgentActivity' && i.kind === 'started');
        requireContract(
          calls.every((c) =>
            ['spawn_agent', 'followup_task', 'interrupt_agent'].includes(
              c.name.replace(/^collaboration\./u, ''),
            ),
          ) &&
            calls
              .filter((c) => c.name.endsWith('spawn_agent'))
              .every((c) => started.some((i) => i.id === c.id)),
          'auditor-stop-spawn-unknown',
        );
        const children = new Set(started.map((i) => text(i.agentThreadId)));
        for (const child of children) {
          const before = object(
            object(await rpc.request('thread/read', { threadId: child, includeTurns: true }))
              .thread,
          );
          requireContract(
            before.id === child &&
              before.parentThreadId === id &&
              before.cwd === registration.workspaceRoot &&
              Array.isArray(before.turns),
            'auditor-stop-child-binding',
          );
          for (const turn of before.turns.map(object)) {
            requireContract(
              turn.status === 'inProgress' ||
                turn.status === 'completed' ||
                turn.status === 'failed' ||
                turn.status === 'interrupted',
              'auditor-stop-child-unknown',
            );
            if (turn.status === 'inProgress') {
              await rpc.request('turn/interrupt', { threadId: child, turnId: text(turn.id) });
              await rpc.completed(child, text(turn.id), AbortSignal.timeout(30_000));
            }
          }
          const after = object(
            object(await rpc.request('thread/read', { threadId: child, includeTurns: true }))
              .thread,
          );
          requireContract(
            after.id === child &&
              after.parentThreadId === id &&
              after.cwd === registration.workspaceRoot &&
              Array.isArray(after.turns) &&
              before.turns
                .map(object)
                .every(
                  (t) =>
                    (after.turns as unknown[]).map(object).filter((v) => v.id === t.id).length ===
                    1,
                ) &&
              after.turns
                .map(object)
                .every(
                  (t) =>
                    t.status === 'completed' || t.status === 'failed' || t.status === 'interrupted',
                ),
            'auditor-stop-child-active',
          );
          const origin = started.find((i) => i.agentThreadId === child)!;
          const deliveries = calls.filter(
            (c) =>
              c.id === origin.id ||
              (c.name.endsWith('followup_task') && c.args.target === origin.agentPath),
          );
          for (const delivery of deliveries) auditChildTurn(after, delivery.turn);
          requireContract(
            !(after.turns as unknown[])
              .flatMap((t) => (object(t).items as unknown[]).map(object))
              .some((i) => i.type === 'subAgentActivity' || i.type === 'collabAgentToolCall'),
            'auditor-stop-delegation-unknown',
          );
          observations.push(save({ kind: 'auditor-child-stop', input, child, observed: after }));
        }
      }
      return save({ kind: 'auditor-stopped', input, parentStop, observations, confirmed: true });
    },
  };
  return {
    activities,
    controls,
    async stopAll() {
      for (const entry of entries.values()) await controls.stopAuditor(entry.input, entry.permit);
    },
  };
}
