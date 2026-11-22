import { join, dirname } from 'node:path';
import { readFileSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type {
  TaskSnapshot,
  TaskWriterRuntime,
  TaskRuntimeProof,
  TaskWriterObservation,
  WriterResult,
} from '../../contracts/localTask.js';
import type { ProcessIdentity, WriterProcesses } from '../../contracts/writerProcesses.js';
import { exactFields, object, requireContract, text } from '../../contracts/project.js';
import { controlRef } from '../../policy/readerControl.js';
import { digest, publishFile, readPrivateFile } from '../artifacts/files.js';
import { effectJournal, lookupEffect } from '../artifacts/effects.js';
import { recoverSentTurn } from './recoveredSend.js';
import { readerLoadPrompt } from './readerMessages.js';
import { confirmObservedLoad } from './observedLoad.js';
import { readerContextCompacted } from './readerContext.js';
import { localTaskKey } from '../../policy/localTask.js';
import type { taskFiles } from '../project/taskFiles.js';
import type { taskGate } from '../project/taskGate.js';

export function checkWriterInventory(
  inventory: Record<string, unknown>,
  disabledServers: readonly string[],
) {
  requireContract(
    Array.isArray(inventory.data) && inventory.nextCursor == null,
    'task-tools-inventory-unknown',
  );
  requireContract(
    inventory.data
      .map(object)
      .every(
        (s) =>
          disabledServers.includes(String(s.name)) &&
          s.pluginId === null &&
          s.serverInfo === null &&
          s.httpOrigin == null &&
          s.serverCapabilities == null &&
          s.toolsError == null &&
          Object.keys(object(s.tools)).length === 0 &&
          Array.isArray(s.resources) &&
          s.resources.length === 0 &&
          Array.isArray(s.resourceTemplates) &&
          s.resourceTemplates.length === 0 &&
          (s.runtimeStatus == null || s.runtimeStatus === 'disabled'),
      ),
    'task-external-tools-enabled',
  );
}

function retained(path: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(readPrivateFile(path).toString()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function runtimeProof(value: unknown): TaskRuntimeProof {
  const v = object(value);
  exactFields(v, ['processes', 'session']);
  requireContract(
    Array.isArray(v.processes) && v.processes.length > 0,
    'task-writer-process-unknown',
  );
  const processes: ProcessIdentity[] = v.processes.map((value) => {
    const p = object(value);
    exactFields(p, ['pid', 'parent', 'started']);
    requireContract(
      Number.isSafeInteger(p.pid) &&
        Number(p.pid) > 1 &&
        Number.isSafeInteger(p.parent) &&
        Number(p.parent) >= 0,
      'task-writer-process-unknown',
    );
    return { pid: Number(p.pid), parent: Number(p.parent), started: text(p.started) };
  });
  requireContract(
    new Set(processes.map((p) => p.pid)).size === processes.length,
    'task-writer-process-unknown',
  );
  return { processes, session: v.session === null ? null : text(v.session) };
}
type WriterFiles = Pick<ReturnType<typeof taskFiles>, 'store' | 'bound' | 'observeTree'>;
function stoppedCopy(snapshot: TaskSnapshot, files: WriterFiles, after: unknown) {
  files.bound(snapshot.copy);
  requireContract(same(files.observeTree(snapshot.copy.root), after), 'task-late-writer');
  files.bound(snapshot.copy);
}

// A failed baseline may leave additions before the writer ever starts. Only its
// retained outcome can attest those bytes. Later changes still fail closed.
async function unstartedCopy(
  snapshot: TaskSnapshot,
  files: WriterFiles,
  directory: string,
  processes: WriterProcesses,
) {
  files.bound(snapshot.copy);
  const after = files.observeTree(snapshot.copy.root);
  files.bound(snapshot.copy);
  const unchanged = same(after, snapshot.tree);
  const checked = retained(join(directory, 'checks-baseline.json'));
  if (unchanged && checked?.status !== 'FAIL') return { after };
  requireContract(checked?.status === 'FAIL', 'task-late-writer');
  const baseline = controlRef(checked.manifest);
  const read = (ref: ArtifactRef) => object(JSON.parse(files.store.read(ref).toString()));
  const manifest = read(baseline);
  const ref = controlRef(retained(join(directory, 'snapshot.json')));
  const name = snapshot.input.baseline;
  requireContract(
    same(read(ref), snapshot) &&
      same(retained(join(directory, 'checks-baseline-intent.json')), {
        snapshot: ref,
        stage: 'baseline',
        result: null,
        integration: null,
      }) &&
      manifest.kind === 'task-checks' &&
      manifest.stage === 'baseline' &&
      manifest.status === 'FAIL' &&
      same(manifest.input, snapshot.input) &&
      same(manifest.snapshot, ref) &&
      same(manifest.tree, snapshot.tree) &&
      Array.isArray(manifest.outcomes) &&
      manifest.outcomes.length === 1,
    'task-baseline-stop-binding',
  );
  const outcome = object(manifest.outcomes[0]);
  const proof = read(controlRef(outcome.proof));
  requireContract(
    outcome.name === name &&
      outcome.status === 'FAIL' &&
      proof.kind === 'task-check' &&
      proof.stage === 'baseline' &&
      proof.name === name &&
      proof.status === 'FAIL' &&
      same(proof.input, snapshot.input) &&
      same(proof.command, snapshot.commands[name]) &&
      same(proof.before, snapshot.tree) &&
      same(proof.after, after) &&
      snapshot.tree.files.every((file) => after.files.some((row) => same(file, row))) &&
      snapshot.tree.directories.every((dir) => after.directories.some((row) => same(dir, row))),
    'task-baseline-stop-binding',
  );
  if (unchanged) return { after };
  const stop = object(proof.stop);
  requireContract(stop.confirmed === true, 'task-recovery-check-stop-unknown');
  const owned = runtimeProof({ session: null, processes: stop.processes }).processes;
  requireContract((await processes.alive(owned)).length === 0, 'task-recovery-check-live');
  stoppedCopy(snapshot, files, after);
  requireContract(
    [
      'writer-result.json',
      'writer-runtime.json',
      'runtime-identity.json',
      'checks-candidate-intent.json',
      'checks-integrated-intent.json',
      'checks-candidate.json',
      'checks-integrated.json',
    ].every((name) => !existsSync(join(directory, name))) &&
      readdirSync(join(directory, 'writer-effects')).length === 0,
    'task-writer-runtime-unknown',
  );
  return { after, baseline };
}

export async function unstartedWriterStop(
  snapshot: TaskSnapshot,
  files: WriterFiles,
  directory: string,
  processes: WriterProcesses,
) {
  const observation = await unstartedCopy(snapshot, files, directory, processes);
  return {
    schemaVersion: 2,
    notStarted: true,
    input: snapshot.input,
    source: snapshot.source,
    copy: snapshot.copy,
    runtime: null,
    before: snapshot.tree,
    ...observation,
    kind: 'task-writers-stopped',
    confirmed: true,
    session: null,
    processes: [],
  };
}

// Inspect retained primary evidence without publishing an intent, outcome or new permission.
export async function inspectTaskWriter(
  snapshot: TaskSnapshot,
  files: WriterFiles,
  directory: string,
  processes: WriterProcesses,
): Promise<TaskWriterObservation> {
  const marker = retained(join(directory, 'writer-runtime.json'));
  if (marker === null) {
    const stopped = retained(join(directory, 'writer-stopped.json'));
    if (stopped === null) return { status: 'unknown', reason: 'task-writer-start-not-observed' };
    const receipt = controlRef(stopped),
      proof = object(JSON.parse(files.store.read(receipt).toString()));
    if (proof.schemaVersion !== 2 || proof.notStarted !== true)
      return { status: 'unknown', reason: 'task-writer-start-not-observed' };
    const permission =
        snapshot.schemaVersion === 4 && snapshot.correction.round > 0
          ? dirname(dirname(directory))
          : directory,
      grantBytes = readPrivateFile(join(permission, 'grant.json')),
      grant = object(JSON.parse(grantBytes.toString())),
      revocation = retained(join(permission, 'revoked.json'));
    requireContract(
      proof.kind === 'task-writers-stopped' &&
        proof.confirmed === true &&
        proof.runtime === null &&
        proof.session === null &&
        same(proof.processes, []) &&
        same(proof.input, snapshot.input) &&
        same(proof.source, snapshot.source) &&
        same(proof.copy, snapshot.copy) &&
        same(proof.before, snapshot.tree) &&
        !existsSync(join(directory, 'runtime-identity.json')) &&
        existsSync(join(directory, 'writer-effects')) &&
        readdirSync(join(directory, 'writer-effects')).length === 0 &&
        revocation?.schemaVersion === 1 &&
        revocation.grant === digest(grantBytes) &&
        same(grant.input, snapshot.input) &&
        same(grant.source, snapshot.source),
      'task-writer-stop-binding',
    );
    stoppedCopy(snapshot, files, proof.after);
    const observed = await unstartedCopy(snapshot, files, directory, processes);
    requireContract(
      same(proof.baseline, observed.baseline) && same(proof.after, observed.after),
      'task-writer-stop-binding',
    );
    return { status: 'stopped', runtime: { session: null, processes: [] }, receipt };
  }
  requireContract(
    marker.kind === 'task-writer-starting' && same(marker.input, snapshot.input),
    'task-writer-runtime-binding',
  );
  const initial = retained(join(directory, 'runtime-identity.json'));
  if (initial === null) return { status: 'unknown', reason: 'task-writer-process-unknown' };
  const runtime = runtimeProof(initial),
    stopped = retained(join(directory, 'writer-stopped.json'));
  if (stopped === null) {
    const live = await processes.alive(runtime.processes);
    return live.length > 0
      ? { status: 'live', runtime, processes: live }
      : { status: 'unknown', reason: 'task-writer-stop-unconfirmed' };
  }
  const receipt = controlRef(stopped),
    proof = object(JSON.parse(files.store.read(receipt).toString()));
  if (proof.schemaVersion !== 2)
    return { status: 'unknown', reason: 'task-writer-stop-binding-unknown' };
  requireContract(
    proof.kind === 'task-writers-stopped' &&
      proof.confirmed === true &&
      same(proof.input, snapshot.input) &&
      same(proof.source, snapshot.source) &&
      same(proof.copy, snapshot.copy) &&
      same(proof.before, proof.after),
    'task-writer-stop-binding',
  );
  const owned = runtimeProof(proof.runtime),
    stoppedProcesses = runtimeProof({ processes: proof.processes, session: proof.session });
  requireContract(
    same(owned.processes, runtime.processes) &&
      runtime.session === null &&
      owned.session === stoppedProcesses.session,
    'task-writer-stop-binding',
  );
  // The STOP inventory covers termination. Short-lived children from startup can
  // already have exited. Bind them through their original ancestry and check both cuts.
  const observed = new Map(stoppedProcesses.processes.map((p) => [p.pid, p]));
  const missing = owned.processes.filter((p) => !observed.has(p.pid));
  while (missing.length > 0) {
    const index = missing.findIndex((p) =>
      owned.processes.some(
        (parent) => parent.pid === p.parent && same(observed.get(parent.pid), parent),
      ),
    );
    requireContract(index >= 0, 'task-writer-stop-binding');
    const child = missing.splice(index, 1)[0]!;
    observed.set(child.pid, child);
  }
  requireContract(
    owned.processes.every((p) => same(observed.get(p.pid), p)),
    'task-writer-stop-binding',
  );
  const live = await processes.alive([...observed.values()]);
  if (live.length === 0) {
    stoppedCopy(snapshot, files, proof.after);
  }
  return live.length > 0
    ? { status: 'live', runtime: owned, processes: live }
    : { status: 'stopped', runtime: owned, receipt };
}

function writerIntent(snapshot: TaskSnapshot, operation: string, request: unknown) {
  const p = snapshot.input.admission.preparation;
  return {
    projectId: p.project.projectId,
    taskId: p.taskId,
    operationId:
      'task-' +
      operation +
      '-' +
      digest(localTaskKey(snapshot.input)) +
      (snapshot.input.schemaVersion === 11 || snapshot.input.schemaVersion === 12
        ? '-a' + snapshot.input.continuation.attempt
        : '') +
      (snapshot.schemaVersion === 4 ? '-r' + snapshot.correction.round : ''),
    requestHash: digest(JSON.stringify(request)),
    hostId: p.hostId,
    workspaceId: p.project.workspaceId,
    owner: p.owner,
    generation: p.generation,
  };
}

function implementationPrompt(snapshot: TaskSnapshot, store: WriterFiles['store']) {
  return `Выполни локальный план ${snapshot.input.admission.plan.path} по прочитанной карточке и принятой основе. Критерий: ${snapshot.plan.criterion}.${snapshot.schemaVersion === 4 && snapshot.correction.instructions !== null ? ` Исправь открытые замечания из прочитанного ${store.path(snapshot.correction.instructions)}; не меняй согласованный замысел.` : ''} Изменяй только ${JSON.stringify(snapshot.plan.paths)}. Нельзя менять правила, профили, план, принятую основу и карточку. Без сети, помощников, внешней истории и фоновых процессов. Проверки запускает хост; самостоятельно их не запускай. Верни краткое описание фактических изменений и ограничений. Твой ответ — только кандидат, независимую приёмку выполняет другой сеанс.`;
}

function writerRecords(snapshot: TaskSnapshot, session: string, thread: Record<string, unknown>) {
  const path = text(thread.path);
  requireContract(realpathSync(path) === path, 'task-transcript-alias');
  const body = readFileSync(path, 'utf8');
  requireContract(body.endsWith('\n'), 'task-transcript-partial');
  const records = body
    .trimEnd()
    .split('\n')
    .map((line) => object(JSON.parse(line) as unknown));
  const metadata = records.filter((r) => r.type === 'session_meta').map((r) => object(r.payload));
  requireContract(
    metadata.length === 1 &&
      metadata[0]!.id === session &&
      metadata[0]!.cwd === snapshot.copy.root &&
      metadata[0]!.cli_version === snapshot.profile.clientVersion,
    'task-native-identity',
  );
  return records;
}

// Read only the already acknowledged B1 turn. A terminal model event is not a STOP receipt.
export function interruptedWriterTurn(
  snapshot: TaskSnapshot,
  files: WriterFiles,
  directory: string,
) {
  const effects = join(directory, 'writer-effects');
  function receipt(operation: string, request: unknown) {
    const result = lookupEffect(effects, writerIntent(snapshot, operation, request));
    requireContract(result.status === 'completed', 'task-writer-turn-receipt-unknown');
    return object(JSON.parse(files.store.read(result.receipt).toString()));
  }
  const created = receipt('create', { snapshot });
  const identity = runtimeProof(created.identity);
  const thread = object(object(created.raw).thread);
  requireContract(
    created.kind === 'task-writer-session' &&
      same(created.input, snapshot.input) &&
      identity.session !== null &&
      thread.id === identity.session &&
      thread.cwd === snapshot.copy.root &&
      same(runtimeProof(retained(join(directory, 'runtime-identity.json'))), {
        ...identity,
        session: null,
      }),
    'task-writer-runtime-binding',
  );
  const turn = text(
    receipt('implement', {
      thread: identity.session,
      prompt: implementationPrompt(snapshot, files.store),
    }).turnId,
  );
  const events = writerRecords(snapshot, identity.session, thread)
    .filter((r) => r.type === 'event_msg')
    .map((r) => object(r.payload))
    .filter(
      (e) =>
        e.turn_id === turn &&
        ['task_started', 'turn_aborted', 'task_complete'].includes(String(e.type)),
    );
  requireContract(
    same(
      events.map((e) => e.type),
      ['task_started', 'turn_aborted'],
    ),
    'task-writer-turn-outcome-unknown',
  );
  return { session: identity.session, turn };
}

export function taskWriter(
  snapshot: TaskSnapshot,
  files: ReturnType<typeof taskFiles>,
  gate: ReturnType<typeof taskGate>,
  factory: (root: string) => TaskWriterRuntime,
  processes: WriterProcesses,
  consume: (id: string, hash: string) => void,
) {
  const store = files.store,
    journal = effectJournal(join(gate.directory, 'writer-effects'));
  const effectiveProfiles: ArtifactRef[] = [];
  let runtime: TaskWriterRuntime | null = null,
    identity: TaskRuntimeProof | null = null,
    stopping: Promise<ArtifactRef> | null = null,
    creationAttempted = false,
    stopRequested = false,
    dispatched = false;
  const save = files.save,
    read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  function publishStop(receipt: ArtifactRef) {
    try {
      publishFile(
        join(gate.directory, 'writer-stopped.json'),
        Buffer.from(JSON.stringify(receipt)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      requireContract(
        same(
          JSON.parse(readPrivateFile(join(gate.directory, 'writer-stopped.json')).toString()),
          receipt,
        ),
        'task-stop-conflict',
      );
    }
  }
  async function noTools() {
    const inventory = object(
      await runtime!.request('mcpServerStatus/list', {
        limit: 100,
        detail: 'toolsAndAuthOnly',
        ...(identity?.session ? { threadId: identity.session } : {}),
      }),
    );
    checkWriterInventory(inventory, snapshot.disabledServers);
    save({ kind: 'task-capabilities', inventory });
  }
  function session(raw: unknown) {
    const response = object(raw),
      thread = object(response.thread),
      sandbox = object(response.sandbox);
    requireContract(
      thread.forkedFromId === null &&
        thread.parentThreadId === null &&
        thread.projectId === null &&
        Array.isArray(thread.turns) &&
        thread.turns.length === 0 &&
        response.cwd === snapshot.copy.root &&
        response.model === snapshot.profile.model &&
        response.reasoningEffort === snapshot.profile.effort &&
        response.approvalPolicy === 'never' &&
        sandbox.type === 'workspaceWrite' &&
        sandbox.networkAccess === false &&
        sandbox.excludeSlashTmp === true &&
        sandbox.excludeTmpdirEnvVar === true &&
        Array.isArray(sandbox.writableRoots) &&
        sandbox.writableRoots.every((r) => r === snapshot.copy.root),
      'task-writer-profile',
    );
    return text(thread.id);
  }
  async function primary(turnId: string) {
    await runtime!.completed(identity!.session!, turnId);
    const raw = await runtime!.request('thread/read', {
      threadId: identity!.session,
      includeTurns: true,
    });
    save({ kind: 'task-primary-turn', raw });
    const thread = object(object(raw).thread);
    requireContract(
      thread.id === identity!.session && Array.isArray(thread.turns),
      'task-history-unknown',
    );
    const matches = thread.turns.map(object).filter((t) => t.id === turnId);
    requireContract(
      matches.length === 1 && matches[0]!.status === 'completed',
      'task-turn-unconfirmed',
    );
    const records = writerRecords(snapshot, identity!.session!, thread);
    const contexts = records
      .filter((r) => r.type === 'turn_context')
      .map((r) => object(r.payload))
      .filter((c) => c.turn_id === turnId);
    requireContract(contexts.length > 0, 'task-native-context-missing');
    effectiveProfiles.push(
      save({ kind: 'task-effective-profile', session: identity!.session, turnId, contexts }),
    );
    for (const context of contexts) {
      const sandbox = object(context.sandbox_policy),
        permission = object(context.permission_profile),
        filesystem = object(permission.file_system);
      requireContract(
        context.cwd === snapshot.copy.root &&
          context.model === snapshot.profile.model &&
          context.effort === snapshot.profile.effort &&
          context.approval_policy === 'never' &&
          sandbox.type === 'workspace-write' &&
          sandbox.network_access === false &&
          sandbox.exclude_slash_tmp === true &&
          sandbox.exclude_tmpdir_env_var === true &&
          permission.type === 'managed' &&
          permission.network === 'restricted' &&
          filesystem.type === 'restricted' &&
          Array.isArray(filesystem.entries),
        'task-native-profile',
      );
      const writes = filesystem.entries.map(object).filter((e) => e.access !== 'read');
      requireContract(
        writes.length > 0 &&
          writes.every(
            (e) => e.access === 'write' && same(e.path, { type: 'path', path: snapshot.copy.root }),
          ),
        'task-native-write-roots',
      );
    }
    await noTools();
    return { thread, turn: matches[0]! };
  }
  async function send(operation: string, prompt: string) {
    gate.assert();
    requireContract(!stopRequested, 'task-writer-stopped');
    await noTools();
    const request = { thread: identity!.session, prompt },
      operationIntent = writerIntent(snapshot, operation, request),
      message = `Workflow operation: ${operationIntent.operationId}\n${prompt}`;
    const ref = await journal.execute(operationIntent, async () => {
      gate.assert();
      requireContract(!stopRequested, 'task-writer-stopped');
      consume(digest(operationIntent.operationId), digest(message));
      const params = {
        threadId: identity!.session,
        input: [{ type: 'text', text: message }],
        model: snapshot.profile.model,
        effort: snapshot.profile.effort,
        approvalPolicy: 'never',
        multiAgentMode: 'explicitRequestOnly',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [snapshot.copy.root],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
        environments: [
          {
            environmentId: 'local',
            cwd: snapshot.copy.root,
            runtimeWorkspaceRoots: [snapshot.copy.root],
          },
        ],
      };
      await runtime!.admitTurn?.(params);
      gate.assert();
      requireContract(!stopRequested, 'task-writer-stopped');
      dispatched = true;
      let response: unknown;
      try {
        response = await runtime!.request('turn/start', params);
      } catch (error) {
        if (operation !== 'implement') throw error;
        gate.assert();
        const history = await runtime!.request('thread/read', {
          threadId: identity!.session,
          includeTurns: true,
        });
        const turnId = recoverSentTurn(history, identity!.session!, message);
        if (turnId === null) throw error;
        return save({ turnId });
      }
      return save({ turnId: text(object(object(response).turn).id) });
    });
    return primary(text(read(ref).turnId));
  }
  async function stopRuntime(terminals: Record<string, unknown>[]) {
    const retained = await processes.alive(identity!.processes);
    const roots = [runtime!.pid, ...retained.map((p) => p.pid)];
    const owned = await processes.descendants([...new Set(roots)]);
    requireContract(
      owned.some((o) => identity!.processes.some((p) => p.pid === runtime!.pid && same(o, p))) &&
        retained.every((p) => owned.some((o) => same(o, p))),
      'task-process-identity-changed',
    );
    const stopped = await processes.terminate(owned);
    runtime!.close();
    for (let i = 0; i < 100 && (await processes.alive(stopped)).length; i++)
      await processes.wait(50);
    requireContract((await processes.alive(stopped)).length === 0, 'task-process-stop-unknown');
    const before = files.tree(snapshot.copy.root);
    await processes.wait(250);
    const after = files.tree(snapshot.copy.root);
    requireContract(
      same(before, after) && (await processes.alive(stopped)).length === 0,
      'task-late-writer',
    );
    requireContract(
      terminals.every(
        (terminal) => terminal.osPid === null || owned.some((p) => p.pid === terminal.osPid),
      ),
      'task-terminal-process-identity-unknown',
    );
    return { stopped, before, after };
  }
  async function stop(): Promise<ArtifactRef> {
    stopRequested = true;
    if (stopping !== null) return stopping;
    stopping = (async () => {
      if (runtime === null) {
        const observed = await inspectTaskWriter(snapshot, files, gate.directory, processes);
        if (observed.status === 'stopped') {
          await processes.wait(250);
          const final = await inspectTaskWriter(snapshot, files, gate.directory, processes);
          requireContract(
            final.status === 'stopped' && same(final.receipt, observed.receipt),
            'task-late-writer',
          );
          return observed.receipt;
        }
        try {
          readPrivateFile(join(gate.directory, 'writer-runtime.json'));
          throw new Error('task-writer-runtime-unknown');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          requireContract(
            !existsSync(join(gate.directory, 'runtime-identity.json')) &&
              !existsSync(join(gate.directory, 'writer-stopped.json')) &&
              readdirSync(join(gate.directory, 'writer-effects')).length === 0,
            'task-writer-runtime-unknown',
          );
          gate.freeze();
          const receipt = save(
            await unstartedWriterStop(snapshot, files, gate.directory, processes),
          );
          publishStop(receipt);
          return receipt;
        }
      }
      requireContract(identity !== null, 'task-writer-process-unknown');
      let primaryHistory: unknown = null;
      let terminals: Record<string, unknown>[] = [];
      if (identity.session !== null && dispatched) {
        try {
          const loaded = object(await runtime.request('thread/loaded/list', { limit: 100 }));
          requireContract(
            Array.isArray(loaded.data) &&
              loaded.data.length === 1 &&
              loaded.data[0] === identity.session &&
              loaded.nextCursor == null,
            'task-writer-runtime-unbound',
          );
          const list = object(
            await runtime.request('thread/backgroundTerminals/list', {
              threadId: identity.session,
              limit: 100,
            }),
          );
          requireContract(
            Array.isArray(list.data) && list.nextCursor == null,
            'task-terminal-inventory-unknown',
          );
          terminals = list.data.map(object);
          const raw = await runtime.request('thread/read', {
              threadId: identity.session,
              includeTurns: true,
            }),
            thread = object(object(raw).thread);
          requireContract(
            thread.id === identity.session && Array.isArray(thread.turns),
            'task-stop-history-unknown',
          );
          for (const turn of thread.turns.map(object))
            if (turn.status === 'inProgress') {
              await runtime.request('turn/interrupt', {
                threadId: identity.session,
                turnId: text(turn.id),
              });
              await runtime.completed(identity.session, text(turn.id), AbortSignal.timeout(30000));
            }
          primaryHistory = await runtime.request('thread/read', {
            threadId: identity.session,
            includeTurns: true,
          });
          const final = object(object(primaryHistory).thread);
          requireContract(
            final.id === identity.session &&
              Array.isArray(final.turns) &&
              final.turns
                .map(object)
                .every((t) => ['completed', 'failed', 'interrupted'].includes(String(t.status))),
            'task-stop-unconfirmed',
          );
        } catch (primaryError) {
          try {
            await stopRuntime([]);
          } catch (physicalError) {
            const message = (failure: unknown) =>
              failure instanceof Error
                ? failure.message
                : typeof failure === 'string'
                  ? failure
                  : 'Non-Error stop failure';
            throw new AggregateError([primaryError, physicalError], message(primaryError), {
              cause: new Error(
                JSON.stringify({
                  primary: message(primaryError).slice(0, 4096),
                  physical: message(physicalError).slice(0, 4096),
                  physicalCause:
                    physicalError instanceof Error && physicalError.cause instanceof Error
                      ? physicalError.cause.message.slice(0, 4096)
                      : null,
                }),
              ),
            });
          }
          throw primaryError;
        }
      }
      const { stopped, before, after } = await stopRuntime(terminals);
      requireContract(
        !creationAttempted || identity.session !== null,
        'task-create-outcome-unknown',
      );
      const receipt = save({
        schemaVersion: 2,
        kind: 'task-writers-stopped',
        confirmed: true,
        input: snapshot.input,
        source: snapshot.source,
        copy: snapshot.copy,
        runtime: identity,
        session: identity.session,
        processes: stopped,
        primary: primaryHistory,
        terminals,
        before,
        after,
      });
      publishStop(receipt);
      return receipt;
    })();
    try {
      return await stopping;
    } catch (error) {
      stopping = null;
      throw error;
    }
  }
  async function write(): Promise<WriterResult> {
    requireContract(snapshot.input.schemaVersion !== 2, 'task-native-route-required');
    gate.assert();
    files.sourceCurrent(snapshot);
    requireContract(same(files.tree(snapshot.copy.root), snapshot.tree), 'task-premature-write');
    const createIntent = writerIntent(snapshot, 'create', { snapshot });
    const created = await journal.execute(createIntent, async () => {
      gate.assert();
      const runtimeFile = join(gate.directory, 'writer-runtime.json');
      publishFile(
        runtimeFile,
        Buffer.from(JSON.stringify({ kind: 'task-writer-starting', input: snapshot.input })),
      );
      runtime = factory(snapshot.copy.root);
      const owned = await processes.descendants([runtime.pid]);
      requireContract(
        owned.some((p) => p.pid === runtime!.pid),
        'task-writer-process-unknown',
      );
      identity = { processes: owned, session: null };
      publishFile(
        join(gate.directory, 'runtime-identity.json'),
        Buffer.from(JSON.stringify(identity)),
      );
      await runtime.initialize();
      gate.assert();
      await noTools();
      const models = object(await runtime.request('model/list', {}));
      requireContract(
        Array.isArray(models.data) &&
          models.data
            .map(object)
            .some(
              (m) =>
                m.model === snapshot.profile.model &&
                Array.isArray(m.supportedReasoningEfforts) &&
                m.supportedReasoningEfforts
                  .map(object)
                  .some((e) => e.reasoningEffort === snapshot.profile.effort),
            ),
        'task-model-unavailable',
      );
      creationAttempted = true;
      const raw = await runtime.request('thread/start', {
        projectId: null,
        cwd: snapshot.copy.root,
        runtimeWorkspaceRoots: [snapshot.copy.root],
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        selectedCapabilityRoots: [],
        ephemeral: false,
        allowProviderModelFallback: false,
        model: snapshot.profile.model,
        multiAgentMode: 'explicitRequestOnly',
        config: {
          model_reasoning_effort: snapshot.profile.effort,
          features: { apps: false, plugins: false, multi_agent: false },
          web_search: 'disabled',
          sandbox_workspace_write: {
            writable_roots: [snapshot.copy.root],
            network_access: false,
            exclude_slash_tmp: true,
            exclude_tmpdir_env_var: true,
          },
          shell_environment_policy: {
            inherit: 'none',
            include_only: ['PATH', 'LANG', 'LC_ALL'],
            set: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: snapshot.copy.root },
          },
        },
      });
      save({ kind: 'task-create-response', raw });
      identity.session = text(object(object(raw).thread).id);
      session(raw);
      return save({ kind: 'task-writer-session', raw, identity, input: snapshot.input });
    });
    requireContract(
      runtime !== null &&
        identity !== null &&
        identity.session === object(read(created).identity).session,
      'task-writer-runtime-unknown',
    );
    await send(
      'profile',
      'Проверка фактического профиля. Не вызывай инструменты, не выполняй задание, не меняй файлы. Ответь: профиль ожидает проверки хостом.',
    );
    requireContract(same(files.tree(snapshot.copy.root), snapshot.tree), 'task-premature-write');
    const refs = snapshot.tree.files.map((file) => ({
      path: join(snapshot.copy.root, file.path),
      sha256: file.version.content.sha256,
    }));
    if (snapshot.schemaVersion === 4 && snapshot.correction.instructions !== null)
      refs.push({
        path: store.path(snapshot.correction.instructions),
        sha256: snapshot.correction.instructions.sha256,
      });
    const loaded = await send('load', readerLoadPrompt(refs, 4));
    confirmObservedLoad(loaded.turn, refs);
    requireContract(
      !readerContextCompacted({ thread: loaded.thread }, identity.session!, text(loaded.turn.id)),
      'task-context-compacted',
    );
    requireContract(same(files.tree(snapshot.copy.root), snapshot.tree), 'task-premature-write');
    files.sourceCurrent(snapshot);
    gate.assert();
    const ready = save({
      kind: 'task-writer-ready',
      input: snapshot.input,
      session: identity.session,
      loadTurnId: text(loaded.turn.id),
      load: save(loaded),
      grant: gate.admission().grant,
    });
    const result = await send('implement', implementationPrompt(snapshot, store));
    requireContract(
      !readerContextCompacted({ thread: result.thread }, identity.session!, text(loaded.turn.id)),
      'task-context-compacted',
    );
    requireContract(
      Array.isArray(result.turn.items) &&
        result.turn.items
          .map(object)
          .some(
            (item) =>
              item.type === 'agentMessage' &&
              typeof item.text === 'string' &&
              item.text.trim().length > 0,
          ),
      'task-answer-missing',
    );
    const candidate = files.candidate(snapshot),
      answer = save({
        kind: 'task-writer-answer',
        input: snapshot.input,
        created,
        load: loaded,
        ready,
        primary: result,
        effectiveProfiles,
      });
    const receipt = await stop();
    gate.assert();
    requireContract(same(candidate, files.candidate(snapshot)), 'task-copy-after-stop');
    return { session: identity.session!, answer, stop: receipt, tree: save(candidate) };
  }
  return { write, stop };
}
