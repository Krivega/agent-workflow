import { confirmTaskProgressAudit } from './progressAudit.js';
import { Context } from '@temporalio/activity';
import { confirmTaskStages } from './stageAudit.js';
import { arbitrationReadiness } from '../policy/arbitration.js';
import type { ArbitrationScope } from '../contracts/review.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef } from '../contracts/preparation.js';
import type {
  LocalTaskActivities,
  LocalTaskControls,
  LocalTaskInput,
  TaskSnapshot,
  TaskTree,
  TaskIntegration,
  TaskWriterRuntime,
  WriterResult,
  FileVersion,
  TaskCorrection,
} from '../contracts/localTask.js';
import type { ReaderExecution, ReaderAuthority } from '../contracts/readerControl.js';
import type { TaskContinuationControls } from '../contracts/taskContinuation.js';
import type { TaskExecutionControls } from '../contracts/taskExecution.js';
import type { TaskHumanActivities } from '../contracts/taskHuman.js';
import {
  taskHumanExecutionCommand,
  parseTaskHumanExecutionResume,
  checkTaskHumanExecutionResume,
} from '../policy/taskExecution.js';
import { taskControlTarget } from '../policy/taskContinuation.js';
import type { TaskExecutionBudget } from '../contracts/taskExecution.js';
import type { TaskExecutionCheckpoint } from '../contracts/taskExecution.js';
import type { AnyManagedTaskInput, HumanManagedTaskInput } from '../contracts/localTask.js';
import type { TaskHumanAuthority } from '../contracts/taskHuman.js';
import type { TaskPermissionOwner } from '../contracts/taskRecovery.js';
import type { TaskStartPrincipalAuthority } from '../contracts/taskStartAdmission.js';
import { taskHumanActivities } from './taskHuman.js';
import {
  inspectTaskHumanTechnical,
  requireTaskHumanCompletionSeal,
} from './taskHumanCompletion.js';
import { checkTaskStartAdmission } from '../adapters/project/taskStartAdmission.js';
import { taskHumanCompletionGate } from '../adapters/project/taskHumanCompletionGate.js';
import type { PayloadReaderCommand, ReaderCommandAck } from '../contracts/readerControl.js';
import {
  taskExecutionCommand,
  parseTaskExecutionResume,
  checkTaskExecutionResume,
  taskInterruption,
  taskExecutionDiagnostics,
  parseTaskHumanWaitResume,
  checkTaskHumanWaitResume,
} from '../policy/taskExecution.js';
import {
  taskResumeCommand,
  parseTaskResumePayload,
  checkTaskContinuation,
} from '../policy/taskContinuation.js';
import { parseSubstantialPlan } from '../policy/substantialTask.js';
import { readerCommandText, parsePayloadReaderCommand } from '../policy/readerControl.js';
import type { WriterProcesses } from '../contracts/writerProcesses.js';
import type { ReviewInput, ReviewRequest } from '../contracts/review.js';
import type { LocalProjectRegistration } from './preparation.js';
import type { CodexRpc } from './reader.js';
import { localAdmissionActivities } from './localAdmission.js';
import { preflightSubstantialTask, admitSubstantialTask } from './substantialTask.js';
import type { SubstantialPlan } from '../contracts/substantialTask.js';
import { prepareMechanicalTask } from './mechanicalTask.js';
import type { LocalImplementationPlan } from '../policy/localPlanning.js';
import { applyMechanicalTask, confirmMechanicalTree } from '../adapters/project/mechanicalTask.js';
import { checkRegistration } from '../policy/preparation.js';
import { taskBackendGuard } from '../adapters/project/taskBackend.js';
import { captureRegistration, resolveRegisteredCommands } from '../adapters/project/preparation.js';
import {
  localTaskKey,
  parseLocalTask,
  taskPathAllowed,
  taskDelta,
  checkCorrectionRoles,
  correctingTask,
  supervisedTask,
  stageSupervisedTask,
} from '../policy/localTask.js';
import { reviewProof } from '../adapters/codex/reviewProof.js';
import { requireScoped, parseReviewSnapshot } from '../policy/review.js';
import { parseReviewRequest } from '../policy/review.js';
import { validateLocalPlan } from '../policy/localPlanning.js';
import { controlRef } from '../policy/readerControl.js';
import { readerExecution, supportedTaskClient } from '../policy/readerExecution.js';
import { object, requireContract } from '../contracts/project.js';
import {
  digest,
  privateDirectory,
  publishFile,
  readPrivateFile,
  readProjectFile,
} from '../adapters/artifacts/files.js';
import { effectJournal } from '../adapters/artifacts/effects.js';
import { taskCardProjection, taskFiles } from '../adapters/project/taskFiles.js';
import { taskGate, taskGateBinding } from '../adapters/project/taskGate.js';
import { inspectStoppedTask } from '../adapters/project/stoppedTask.js';
import { taskChecks } from '../adapters/project/taskChecks.js';
import { taskWriter } from '../adapters/codex/taskWriter.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import { reviewActivities } from './review.js';
import { confirmPlanningSupervision } from './taskAudit.js';
import { initialArbitrationActivities } from './initialArbitration.js';

export interface LocalTaskHost {
  profile: ReaderExecution['profile'];
  createRuntime(root: string): TaskWriterRuntime;
  disabledServers?: readonly string[];
  processes?: WriterProcesses;
  auditorRpc?: CodexRpc;
  arbiter?: { roleId: string; profile: ReaderExecution['profile'] };
  authority?: ReaderAuthority;
  executionCommandOrigin?: 'initial-grant';
  startAdmissionAuthority?: TaskStartPrincipalAuthority;
  humanAuthority?: TaskHumanAuthority;
}
type HumanCompletionPermit = Pick<
  ReturnType<typeof taskHumanCompletionGate>,
  'assert' | 'exclusive'
> & {
  seal: ArtifactRef;
};
interface TaskEntry {
  input: LocalTaskInput;
  gate: ReturnType<typeof taskGate>;
  checks: ReturnType<typeof taskChecks>;
  writer: ReturnType<typeof taskWriter> | null;
  snapshot: TaskSnapshot | null;
  rounds: Map<number, TaskEntry>;
}
export function localTaskActivities(
  registration: LocalProjectRegistration,
  host: LocalTaskHost,
  readerRpc: CodexRpc,
  readerProfile: ReaderExecution['profile'],
  consume: (id: string, hash: string) => void,
  binding?: {
    instance: string;
    continued?: { input: LocalTaskInput; instance: string };
    owner?: TaskPermissionOwner;
    admitted(
      input: LocalTaskInput,
      gate: ReturnType<ReturnType<typeof taskGate>['admission']>,
    ): void;
    budget?(input: AnyManagedTaskInput, previous: ArtifactRef | null): TaskExecutionBudget;
    taskQueue?: string;
    namespace?: string;
  },
) {
  const backend = taskBackendGuard(
    registration.workspaceRoot,
    registration.taskBackend === 'required',
  );
  registration = captureRegistration(registration);
  const profile = readerExecution(host.profile).profile,
    disabledServers = [...(host.disabledServers ?? [])];
  const instance = binding?.instance ?? randomUUID();
  const humanActivityScope = {
    taskQueue: binding?.taskQueue ?? '',
    namespace: binding?.namespace ?? '',
  };
  requireContract(supportedTaskClient(profile.clientVersion), 'task-client-unsupported');
  const files = taskFiles(registration.artifactRoot),
    store = files.store,
    contexts = new Map<string, TaskEntry>(),
    stops = new WeakMap<TaskEntry, Promise<ArtifactRef>>(),
    rechecks = new WeakMap<TaskEntry, { cancel: AbortController; drained: Promise<void> }>(),
    processes = host.processes ?? new NativeWriterProcesses();
  let phase: 'open' | 'stopping' | 'stopped' = 'open';
  const save = files.save,
    read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  function once(path: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    try {
      publishFile(path, bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      requireContract(readPrivateFile(path).equals(bytes), 'task-receipt-conflict');
    }
  }
  async function startAdmission(input: HumanManagedTaskInput, card: 'current' | 'retained') {
    const preparation = input.admission.preparation;
    const assigned = backend.require(
      preparation.project.projectId,
      preparation.taskId,
      'temporal',
      'worker',
      preparation.card,
    );
    requireContract(
      assigned?.schemaVersion === 2 && host.startAdmissionAuthority !== undefined,
      'task-start-admission-required',
    );
    return checkTaskStartAdmission(
      registration,
      host.startAdmissionAuthority,
      input.startAdmission,
      preparation,
      assigned,
      { card },
    );
  }
  async function requireActivityAdmission(value: unknown, name: string) {
    const raw = object(value),
      input = parseLocalTask('input' in raw ? raw.input : raw);
    if (input.schemaVersion === 12) {
      const retained = new Set([
        'stopLocalTask',
        'captureTaskExecutionBudget',
        'findTaskExecutionCommand',
        'interruptTaskExecution',
        'holdTaskExecution',
        'resumeTaskExecution',
        'prepareTaskHuman',
        'verifyTaskHumanCommand',
        'controlTaskHumanExecution',
        'finishTaskHuman',
        'saveTaskHumanCheckpoint',
        'loadTaskHumanCheckpoint',
      ]);
      await startAdmission(input, retained.has(name) ? 'retained' : 'current');
    } else if (backend.assert()?.startAdmission !== undefined) {
      const directory = taskGateBinding(
        input,
        files.binding(registration.workspaceRoot),
        profile,
        registration.artifactRoot,
        instance,
      ).directory;
      const grant = object(JSON.parse(readPrivateFile(join(directory, 'grant.json')).toString()));
      requireContract(
        grant.schemaVersion === 1 &&
          same(grant.input, input) &&
          same(grant.source, files.binding(registration.workspaceRoot)) &&
          same(grant.profile, profile) &&
          grant.artifactRoot === registration.artifactRoot &&
          typeof grant.instance === 'string' &&
          grant.instance.length > 0,
        'task-start-legacy-admission-required',
      );
    }
  }
  function requireActivityOpen(value: unknown, stopping: boolean) {
    if (stopping || phase === 'open') return;
    const raw = object(value),
      input = 'input' in raw ? raw.input : raw,
      entry = [...contexts.values()].find((current) => same(current.input, input));
    requireContract(
      phase === 'stopped' && entry !== undefined && entry.input.schemaVersion !== 12,
      'local-task-host-closing',
    );
    const path = join(entry.gate.directory, 'done.json');
    requireContract(existsSync(path), 'local-task-host-closing');
    const done = object(JSON.parse(readPrivateFile(path).toString())),
      result = read(controlRef(done.result));
    requireContract(
      done.status === 'done' &&
        result.kind === 'local-task-result' &&
        result.complete === true &&
        same(result.input, entry.input),
      'local-task-host-closing',
    );
    store.read(controlRef(done.projection));
  }
  function admittedActivities<T extends object>(group: T): T {
    return Object.fromEntries(
      Object.entries(group).map(([name, method]) => {
        requireContract(typeof method === 'function', 'task-activity-method-required');
        const invoke = method as (...args: unknown[]) => unknown;
        return [
          name,
          (...args: unknown[]) => {
            // Known STOP must revoke permission before yielding to another Activity.
            if (
              name === 'stopLocalTask' &&
              [...contexts.values()].some((entry) => same(entry.input, args[0]))
            )
              return Reflect.apply(invoke, group, args) as unknown;
            return (async () => {
              requireActivityOpen(args[0], name === 'stopLocalTask');
              await requireActivityAdmission(args[0], name);
              requireActivityOpen(args[0], name === 'stopLocalTask');
              return Reflect.apply(invoke, group, args) as unknown;
            })();
          },
        ];
      }),
    ) as T;
  }
  function create(input: LocalTaskInput): TaskEntry {
    const gate = taskGate(
      input,
      files.binding(registration.workspaceRoot),
      profile,
      registration.artifactRoot,
      binding?.continued?.instance ?? instance,
      binding?.owner,
    );
    const checks = taskChecks(privateDirectory(join(gate.directory, 'check-logs')), processes);
    return {
      input,
      gate,
      checks,
      writer: null as ReturnType<typeof taskWriter> | null,
      snapshot: null as TaskSnapshot | null,
      rounds: new Map<number, TaskEntry>(),
    };
  }
  function context(value: LocalTaskInput, stopping = false) {
    const input = parseLocalTask(value);
    checkRegistration(input.admission.preparation, registration);
    requireActivityOpen(input, stopping);
    if (!stopping)
      backend.require(
        input.admission.preparation.project.projectId,
        input.admission.preparation.taskId,
        'temporal',
        'worker',
        input.admission.preparation.card,
      );
    const key =
      localTaskKey(input) +
      (input.schemaVersion === 10 || input.schemaVersion === 11 || input.schemaVersion === 12
        ? '/planning-' + input.continuation.attempt
        : '');
    let entry = contexts.get(key);
    if (entry === undefined) {
      entry = create(input);
      binding?.admitted(input, entry.gate.admission());
      contexts.set(key, entry);
    }
    requireContract(same(entry.input, input), 'task-input-conflict');
    return entry;
  }
  function scoped(entry: TaskEntry, round: number): TaskEntry {
    requireContract(
      Number.isSafeInteger(round) &&
        round >= 0 &&
        correctingTask(entry.input) &&
        round <= entry.input.corrections.maxRounds + (entry.input.schemaVersion === 5 ? 1 : 0),
      'task-correction-round-invalid',
    );
    if (round === 0) return entry;
    let result = entry.rounds.get(round);
    if (result === undefined) {
      const gate = {
        ...entry.gate,
        directory: privateDirectory(join(entry.gate.directory, 'corrections', String(round))),
      };
      result = {
        ...entry,
        gate,
        checks: taskChecks(privateDirectory(join(gate.directory, 'check-logs')), processes),
        writer: null,
        snapshot: null,
      };
      entry.rounds.set(round, result);
    }
    return result;
  }
  function copyRoot(input: LocalTaskInput, round: number) {
    return join(
      registration.artifactRoot,
      'copies',
      digest(localTaskKey(input)) +
        (input.schemaVersion === 11 || input.schemaVersion === 12
          ? '-a' + input.continuation.attempt
          : '') +
        (round === 0 ? '' : '-r' + round),
    );
  }
  function snapshot(value: LocalTaskInput, ref: ArtifactRef, permit?: HumanCompletionPermit) {
    const body = read(ref) as unknown as TaskSnapshot;
    const owner = context(value),
      entry = body.schemaVersion === 4 ? scoped(owner, body.correction.round) : owner;
    requireContract(
      ((correctingTask(entry.input) &&
        body.schemaVersion === 4 &&
        body.kind === 'correction-task') ||
        (entry.input.schemaVersion === 1 &&
          body.schemaVersion === 1 &&
          body.kind === 'local-task') ||
        ((entry.input.schemaVersion === 3 ||
          entry.input.schemaVersion === 6 ||
          entry.input.schemaVersion === 10 ||
          entry.input.schemaVersion === 11 ||
          entry.input.schemaVersion === 12 ||
          supervisedTask(entry.input)) &&
          body.schemaVersion === 3 &&
          body.kind === 'substantial-task') ||
        (entry.input.schemaVersion === 2 &&
          body.schemaVersion === 2 &&
          body.kind === 'mechanical-task')) &&
        same(body.input, entry.input) &&
        same(body.profile, profile) &&
        same(body.disabledServers, disabledServers) &&
        body.source.root === registration.workspaceRoot &&
        body.copy.root ===
          copyRoot(entry.input, body.schemaVersion === 4 ? body.correction.round : 0),
      'task-snapshot-binding',
    );
    requireContract(
      same(
        JSON.parse(readPrivateFile(join(entry.gate.directory, 'snapshot.json')).toString()),
        ref,
      ),
      'task-snapshot-unconfirmed',
    );
    entry.snapshot = body;
    if (permit === undefined) entry.gate.assert();
    else permit.assert();
    files.bound(body.source);
    files.bound(body.copy);
    for (const command of Object.values(body.commands))
      requireContract(
        digest(readFileSync(command.executable)) === command.sha256,
        'task-check-runtime-changed',
      );
    return { ...entry, body };
  }
  function completion(
    input: LocalTaskInput,
    ref: ArtifactRef,
    packet: ReviewInput,
    review: ArtifactRef,
  ) {
    const body = read(ref) as unknown as TaskSnapshot;
    const entry =
        body.schemaVersion === 4 ? scoped(context(input), body.correction.round) : context(input),
      commit = read(
        controlRef(
          JSON.parse(
            readPrivateFile(join(entry.gate.directory, 'completion-intent.json')).toString(),
          ) as unknown,
        ),
      );
    requireContract(
      commit.kind === 'task-completion-intent' &&
        same(commit.input, input) &&
        same(commit.snapshot, ref) &&
        same(commit.packet, packet) &&
        same(commit.review, review),
      'task-completion-binding',
    );
    if (input.schemaVersion === 12) {
      const checked = requireTaskHumanCompletionSeal(registration, input, {
        snapshot: ref,
        packet,
        review,
      });
      requireContract(
        same(commit.humanCompletion, checked.ref) &&
          same(read(controlRef(commit.result)).humanCompletion, checked.ref),
        'human-completion-conflict',
      );
    }
    return commit;
  }
  function completeProjection(
    input: LocalTaskInput,
    ref: ArtifactRef,
    packet: ReviewInput,
    review: ArtifactRef,
    permit?: HumanCompletionPermit,
  ) {
    const entry = snapshot(input, ref, permit),
      commit = completion(input, ref, packet, review);
    const projectionRef = controlRef(commit.projection),
      projection = read(projectionRef),
      before = projection.before as unknown as FileVersion,
      after = projection.after as unknown as FileVersion;
    requireContract(
      projection.kind === 'task-card-projection' &&
        same(projection.input, input) &&
        same(projection.result, commit.result),
      'task-projection-binding',
    );
    const card = input.admission.preparation.card,
      expected = commit.tree as TaskTree;
    const outcome = {
      status: 'done' as const,
      result: controlRef(commit.result),
      projection: projectionRef,
    };
    (permit ?? entry.gate).exclusive(() => {
      if (permit !== undefined) Context.current().cancellationSignal.throwIfAborted();
      const current = files.capture(entry.body.source.root, [
        ...new Set([
          ...expected.files.map((f) => f.path),
          ...entry.body.tree.files.map((f) => f.path),
          ...entry.body.plan.paths,
        ]),
      ]);
      const actual = files.version(entry.body.source.root, card);
      requireContract(same(actual, before) || same(actual, after), 'task-card-conflict');
      const normalized = current.files.map((f) =>
        f.path === card ? { path: f.path, version: before } : f,
      );
      requireContract(same(normalized, expected.files), 'task-final-input-changed');
      if (!same(actual, after)) files.replace(entry.body.source.root, card, after);
      once(join(context(input).gate.directory, 'done.json'), outcome);
    });
    if (permit === undefined) {
      entry.gate.freeze();
      entry.gate.release();
    }
    return outcome;
  }
  function writer(entry: ReturnType<typeof context>, body: TaskSnapshot) {
    entry.writer ??= taskWriter(body, files, entry.gate, host.createRuntime, processes, consume);
    return entry.writer;
  }
  async function confirmStopped(body: TaskSnapshot, result: WriterResult) {
    if (body.schemaVersion === 2) {
      const stop = read(result.stop),
        answer = read(result.answer),
        tree = files.candidate(body);
      requireContract(
        result.session === null &&
          stop.kind === 'task-mechanical-stopped' &&
          stop.confirmed === true &&
          stop.session === null &&
          same(stop.input, body.input) &&
          same(stop.processes, []) &&
          same(stop.after, tree),
        'mechanical-stop-unconfirmed',
      );
      requireContract(
        answer.kind === 'mechanical-application' &&
          same(answer.input, body.input) &&
          same(answer.mechanical, body.mechanical) &&
          answer.modelStarts === 0,
        'mechanical-answer-binding',
      );
      requireContract(same(read(result.tree), tree), 'task-copy-after-stop');
      confirmMechanicalTree(body, tree);
      return;
    }
    const stop = read(result.stop);
    requireContract(
      stop.kind === 'task-writers-stopped' &&
        stop.confirmed === true &&
        stop.session === result.session &&
        Array.isArray(stop.processes) &&
        (
          await processes.alive(
            stop.processes as unknown as Parameters<WriterProcesses['alive']>[0],
          )
        ).length === 0 &&
        same(stop.after, files.candidate(body)),
      'task-writer-stop-unconfirmed',
    );
    const answer = read(result.answer),
      creation = read(controlRef(answer.created));
    requireContract(
      answer.kind === 'task-writer-answer' &&
        same(answer.input, body.input) &&
        object(creation.identity).session === result.session,
      'task-writer-answer-binding',
    );
    requireContract(same(read(result.tree), files.candidate(body)), 'task-copy-after-stop');
  }
  async function previousIntegration(input: AnyManagedTaskInput, current: TaskSnapshot) {
    let cursor = input;
    const links: ArtifactRef[] = [];
    while (cursor.continuation.previous !== null) {
      const transitionRef = cursor.continuation.previous,
        transition = read(transitionRef),
        prior = parseLocalTask(transition.input);
      requireContract(
        (prior.schemaVersion === 11 || prior.schemaVersion === 12) &&
          prior.schemaVersion === cursor.schemaVersion &&
          (transition.kind === 'task-execution-continuation' ||
            transition.kind === 'task-human-execution-control') &&
          prior.continuation.attempt + 1 === cursor.continuation.attempt,
        'task-previous-integration-binding',
      );
      const command = parsePayloadReaderCommand(transition.command),
        retained = executionJournal(cursor).records.find((r) =>
          same(r.ack.authorization, transitionRef),
        );
      requireContract(
        retained !== undefined && same(retained.next, cursor) && same(retained.command, command),
        'task-previous-integration-binding',
      );
      const entry = context(prior),
        primary = (name: string) =>
          controlRef(JSON.parse(readPrivateFile(join(entry.gate.directory, name)).toString()));
      let stopped: ArtifactRef, progressSnapshot: unknown;
      if (transition.kind === 'task-human-execution-control') {
        requireContract(
          prior.schemaVersion === 12 && cursor.schemaVersion === 12 && transition.replan === true,
          'task-previous-integration-binding',
        );
        const proposal = humanExecutionProposal(prior, command),
          technical = object(object(transition.context).technical);
        requireContract(
          proposal.replan && same(proposal.next.admission, cursor.admission),
          'task-previous-integration-binding',
        );
        retainedHumanExecutionContinuation(prior, cursor, transitionRef);
        await startAdmission(prior, 'retained');
        stopped = controlRef(technical.stopped);
        progressSnapshot = technical.snapshot;
      } else {
        const payload = executionResumePayload(prior, read(command.payload)),
          heldRef = controlRef(transition.held),
          held = read(heldRef);
        requireContract(
          same(payload.admission, cursor.admission) &&
            same(payload.held, heldRef) &&
            same(primary('execution-held.json'), heldRef) &&
            held.kind === 'task-execution-held' &&
            same(held.input, prior),
          'task-previous-integration-binding',
        );
        stopped = controlRef(held.stopped);
        progressSnapshot = object(held.progress).snapshot;
      }
      const stop = read(stopped);
      requireContract(
        same(primary('stopped.json'), stopped) &&
          stop.confirmed === true &&
          same(stop.input, prior) &&
          !existsSync(join(entry.gate.directory, 'done.json')),
        'task-previous-integration-binding',
      );
      const receiptPath = join(entry.gate.directory, 'integration-receipt.json'),
        intentPath = join(entry.gate.directory, 'integration-intent.json');
      if (existsSync(receiptPath) || existsSync(intentPath)) {
        const receiptRef = primary('integration-receipt.json'),
          receipt = read(receiptRef),
          snapshotRef = primary('snapshot.json'),
          before = read(snapshotRef) as unknown as TaskSnapshot,
          intentRef = primary('integration-intent.json'),
          intent = read(intentRef) as unknown as TaskIntegration,
          sealed = read(primary('execution-admission.json'));
        requireContract(
          same(receipt, {
            kind: 'task-integrated',
            input: prior,
            snapshot: snapshotRef,
            intent: intentRef,
          }) &&
            same(progressSnapshot, snapshotRef) &&
            same(before.input, prior) &&
            sealed.kind === 'task-execution-admission' &&
            same(sealed.input, prior) &&
            same(parseSubstantialPlan(read(controlRef(sealed.plan))), before.plan) &&
            same(before.source, current.source) &&
            same(intent.source, before.source) &&
            same(intent.copy, before.copy) &&
            current.plan.paths.every((path) => taskPathAllowed(before.plan.paths, path)),
          'task-previous-integration-binding',
        );
        await confirmStopped(before, intent.writer);
        const candidate = read(intent.candidate) as unknown as TaskTree;
        requireContract(
          same(candidate, read(intent.writer.tree)) &&
            same(intent.changes, taskDelta(before.tree, candidate)),
          'task-previous-integration-binding',
        );
        files.bound(before.source);
        const actual = files.capture(before.source.root, before.plan.paths),
          expected = {
            files: candidate.files.filter((f) => taskPathAllowed(before.plan.paths, f.path)),
            directories: candidate.directories.filter((d) =>
              before.plan.paths.some(
                (p) => p === d.path || p.startsWith(d.path + '/') || d.path.startsWith(p + '/'),
              ),
            ),
          };
        files.bound(before.source);
        requireContract(same(actual, expected), 'task-previous-integration-stale');
        if (intent.changes.length > 0) {
          requireContract(
            links.every((link) => same(link, receiptRef)),
            'task-previous-integration-binding',
          );
          return receiptRef;
        }
        requireContract(
          intent.previousIntegration !== undefined,
          'task-previous-integration-binding',
        );
        links.push(intent.previousIntegration);
      }
      cursor = prior;
    }
    throw new Error('task-result-empty');
  }
  function checked(ref: ArtifactRef, body: TaskSnapshot, stage: string) {
    const record = read(ref);
    requireContract(
      record.kind === 'task-checks' &&
        record.status === 'PASS' &&
        record.stage === stage &&
        same(record.snapshot, save(body)) &&
        same(record.input, body.input),
      'task-checks-unconfirmed',
    );
    return record;
  }
  async function failedAcceptance(
    entry: ReturnType<typeof snapshot>,
    packet: ReviewInput,
    reviewRef: ArtifactRef,
  ) {
    const accepted = object(
      JSON.parse(
        readPrivateFile(join(entry.gate.directory, 'acceptance.json')).toString(),
      ) as unknown,
    );
    requireContract(same(accepted.review, packet), 'task-acceptance-binding');
    const reviewed = read(reviewRef);
    requireContract(
      reviewed.kind === 'reader-review-result' &&
        reviewed.complete === false &&
        same(reviewed.input, packet),
      'task-correction-review-required',
    );
    const verified = await reviewActivities(registration, readerRpc, readerProfile).finishReview({
      schemaVersion: 1,
      input: packet,
      plan: controlRef(reviewed.plan),
      answers: reviewed.answers as { roleId: string; answer: ArtifactRef | null }[],
    });
    requireContract(
      !verified.complete && same(verified.manifest, reviewRef),
      'task-correction-review-unconfirmed',
    );
    const reports = reviewed.reports as {
      roleId: string;
      answer: ArtifactRef;
      report: {
        verdict: string;
        coverage: string;
        findings: { id: string; blocking: boolean; text: string }[];
      };
    }[];
    const failures = reports.filter((row) => row.report.verdict === 'FAIL');
    requireContract(
      failures.length > 0 &&
        reports.every((row) => row.report.coverage === 'complete') &&
        failures.every((row) => row.report.findings.some((f) => f.blocking)),
      'task-correction-incomplete',
    );
    return { accepted, reviewed, reports, failures };
  }
  async function arbitrationTarget(
    failures: Awaited<ReturnType<typeof failedAcceptance>>['failures'],
  ) {
    for (const row of failures) {
      const proof = await reviewProof(registration, readerRpc)(
        row.answer,
        requireScoped(read(row.answer).input),
      );
      requireContract(proof !== null, 'task-correction-incomplete');
      for (const finding of row.report.findings.filter((f) => f.blocking)) {
        let count = 0;
        for (const ref of proof.snapshot.selection.history.answers) {
          const report = object(read(ref).report);
          if (
            report.verdict === 'FAIL' &&
            (report.findings as { id: string; blocking: boolean }[]).some(
              (f) => f.id === finding.id && f.blocking,
            )
          )
            count++;
          else count = 0;
        }
        if (count + 1 >= 3)
          return {
            target: { roleId: row.roleId, findingId: finding.id },
            answers: [...proof.snapshot.selection.history.answers.slice(-2), row.answer],
          };
      }
    }
    return null;
  }
  async function checkArbitrationAdmission(input: LocalTaskInput) {
    if (input.schemaVersion !== 5 && input.schemaVersion !== 6) return;
    requireContract(
      same(
        host.arbiter,
        input.arbitration && {
          roleId: input.arbitration.roleId,
          profile: input.arbitration.profile,
        },
      ),
      'task-arbiter-host-required',
    );
    const procedureBytes = readFileSync(
      new URL('../../procedures/arbitration.md', import.meta.url),
    );
    requireContract(
      /^Procedure: arbitration\nVersion: 3$/m.test(procedureBytes.toString()),
      'task-arbitration-procedure-version',
    );
    const procedure = store.publish(procedureBytes);
    once(join(context(input).gate.directory, 'arbitration-procedure.json'), procedure);
    const requests = [
      input.admission.acceptance,
      ...(input.admission.schemaVersion === 3 ? [input.admission.planning] : []),
    ];
    for (const request of requests) {
      const parsed = parseReviewRequest(read(request), {
        schemaVersion: 1,
        preparation: input.admission.preparation,
        reviewId: 'arbitration-admission',
        request,
      });
      const role = parsed.roles.find((role) => role.roleId === input.arbitration.roleId)!;
      requireContract(
        role.applies === false &&
          role.complete &&
          role.history.complete &&
          role.history.answers.length === 0,
        'task-arbiter-must-be-independent',
      );
    }
    const models = object(await readerRpc.request('model/list', {}));
    requireContract(
      Array.isArray(models.data) &&
        models.data
          .map(object)
          .some(
            (m) =>
              m.model === input.arbitration.profile.model &&
              Array.isArray(m.supportedReasoningEfforts) &&
              m.supportedReasoningEfforts
                .map(object)
                .some((e) => e.reasoningEffort === input.arbitration.profile.effort),
          ),
      'task-arbiter-model-unavailable',
    );
    return procedure;
  }
  async function prepareCorrection(
    entry: ReturnType<typeof snapshot>,
    input: LocalTaskInput,
    previous: ArtifactRef,
    packet: ReviewInput,
    reviewRef: ArtifactRef,
    arbitration?: ArtifactRef,
  ) {
    const body = entry.body;
    requireContract(
      body.schemaVersion === 4 && correctingTask(input),
      'task-correction-input-required',
    );
    const { accepted, failures } = await failedAcceptance(entry, packet, reviewRef);
    const next = body.correction.round + 1;
    if (next > input.corrections.maxRounds && arbitration === undefined) {
      const target = await arbitrationTarget(failures);
      throw new Error(
        (target !== null ? 'task-arbitration-required:' : 'task-correction-budget-exhausted:') +
          reviewRef.sha256,
      );
    }
    const adjudicated = arbitration === undefined ? null : read(arbitration);
    if (adjudicated !== null)
      requireContract(
        input.schemaVersion === 5 &&
          body.correction.round === 2 &&
          adjudicated.kind === 'task-arbitration-result' &&
          adjudicated.ready === true &&
          same(adjudicated.snapshot, previous) &&
          same(adjudicated.input, input),
        'task-arbitration-resolution-invalid',
      );
    const result = accepted.result as unknown as WriterResult;
    await confirmStopped(body, result);
    const checkedResult = checked(controlRef(accepted.finalChecks), body, 'integrated');
    const transfer = read(controlRef(accepted.intent)) as unknown as TaskIntegration;
    files.sourceCurrent(body, transfer);
    const originRef = body.correction.origin ?? previous,
      origin = read(originRef) as unknown as TaskSnapshot;
    requireContract(
      origin.schemaVersion === 4 && origin.correction.round === 0,
      'task-correction-origin',
    );
    const paths = [
      ...new Set(
        failures
          .filter((row) => adjudicated === null || row.roleId === object(adjudicated.target).roleId)
          .flatMap((row) => {
            const answer = read(row.answer),
              actor = requireScoped(answer.input),
              scope = parseReviewSnapshot(read(actor.review), actor);
            return scope.files
              .map((f) => f.path)
              .filter((path) => taskPathAllowed(origin.plan.paths, path));
          }),
      ),
    ].sort();
    requireContract(paths.length > 0, 'task-correction-scope-empty');
    const target = scoped(context(input), next),
      retained = join(target.gate.directory, 'snapshot.json');
    if (existsSync(retained)) {
      const ref = controlRef(JSON.parse(readPrivateFile(retained).toString()) as unknown);
      const prior = snapshot(input, ref);
      requireContract(
        prior.body.schemaVersion === 4 &&
          same(prior.body.correction.previous, { snapshot: previous, packet, review: reviewRef }),
        'task-correction-conflict',
      );
      return ref;
    }
    const tree = files.capture(body.source.root, [
      ...new Set([
        ...(checkedResult.tree as TaskTree).files.map((f) => f.path),
        ...origin.plan.paths,
      ]),
    ]);
    requireContract(
      same(tree.files, (checkedResult.tree as TaskTree).files),
      'task-final-input-changed',
    );
    const correction: TaskCorrection = {
      round: next,
      origin: originRef,
      previous: { snapshot: previous, packet, review: reviewRef },
      ...(arbitration === undefined ? {} : { arbitration }),
      instructions: save({
        ...(adjudicated === null
          ? {}
          : { arbitration: { source: arbitration, decision: adjudicated.decision } }),
        kind: 'task-correction-instructions',
        input,
        round: next,
        origin: originRef,
        previous: { snapshot: previous, packet, review: reviewRef },
        paths,
        findings: failures.map((row) => ({
          roleId: row.roleId,
          answer: row.answer,
          findings: row.report.findings,
        })),
        rule: 'Resolve the original blocking findings inside the accepted proposal; preserve all other files. The independent reviewer must verify closure.',
      }),
    };
    target.gate.assert();
    const copied = files.copy(body.source, tree, privateDirectory(copyRoot(input, next)));
    const prepared: TaskSnapshot = {
      ...body,
      plan: { ...origin.plan, paths },
      copy: copied.binding,
      tree: copied.tree,
      correction,
    };
    const ref = save(prepared);
    target.gate.assert();
    publishFile(retained, Buffer.from(JSON.stringify(ref)));
    target.snapshot = prepared;
    return ref;
  }
  async function correctionReview(
    body: Extract<TaskSnapshot, { schemaVersion: 4 }>,
    ref: ArtifactRef,
    request: ReviewRequest,
    packet: ArtifactRef,
    tree: TaskTree,
    writerResult: WriterResult,
    logs: Record<string, unknown>[],
  ) {
    const originRef = body.correction.origin ?? ref,
      origin = read(originRef) as unknown as TaskSnapshot;
    const previous = body.correction.previous;
    const oldRequest =
      previous === null ? null : parseReviewRequest(read(previous.packet.request), previous.packet);
    const oldReview = previous === null ? null : read(previous.review);
    const oldReports = (oldReview?.reports ?? []) as { roleId: string; answer: ArtifactRef }[];
    const roles: ReviewRequest['roles'] = [],
      roleEvidence: { roleId: string; evidence: ArtifactRef[]; openFindings: string[] }[] = [];
    const cumulative = taskDelta(origin.tree, tree);
    for (const selection of request.roles) {
      const paths = [
        ...new Set([
          ...body.input.admission.preparation.project.rules,
          body.input.admission.preparation.card,
          body.input.admission.preparation.project.roles.find(
            (role) => role.id === selection.roleId,
          )!.profile,
          ...request.sharedPaths,
          ...selection.paths,
        ]),
      ];
      const versions = paths.map((path) => {
        const file = tree.files.find((f) => f.path === path);
        requireContract(file !== undefined, 'task-role-input-missing');
        return file;
      });
      const prior = oldReports.find((row) => row.roleId === selection.roleId);
      const history = [
        ...(oldRequest?.roles.find((role) => role.roleId === selection.roleId)?.history.answers ??
          selection.history.answers),
      ];
      if (prior !== undefined && !history.some((ref) => same(ref, prior.answer)))
        history.push(prior.answer);
      const role = {
        ...selection,
        history: { complete: selection.history.complete, answers: history },
      };
      roles.push(role);
      const proof =
        prior === undefined
          ? null
          : await reviewProof(registration, readerRpc)(
              prior.answer,
              requireScoped(read(prior.answer).input),
            );
      const openFindings = proof?.openFindings ?? [];
      const old = (
        proof !== null && proof.snapshot.schemaVersion !== 1 ? proof.snapshot.evidence : undefined
      )
        ?.map((ref) => ({ ref, body: read(ref) }))
        .find(
          (item) => item.body.kind === 'task-role-evidence' && item.body.roleId === role.roleId,
        );
      const commands = body.input.corrections.checks.find(
        (row) => row.roleId === role.roleId,
      )!.commands;
      requireContract(role.applies !== true || commands.length > 0, 'task-role-checks-incomplete');
      const adjudication =
        body.correction.arbitration === undefined ? null : read(body.correction.arbitration);
      const arbitration =
        adjudication !== null && object(adjudication.target).roleId === role.roleId
          ? body.correction.arbitration!
          : null;
      const reusable =
        proof?.report.verdict === 'PASS' &&
        proof.report.coverage === 'complete' &&
        old !== undefined &&
        same(old.body.versions, versions) &&
        same(old.body.commands, commands) &&
        openFindings.length === 0 &&
        same(old.body.arbitration ?? null, arbitration);
      const evidence = reusable
        ? old.ref
        : save({
            ...(arbitration === null
              ? {}
              : {
                  arbitration,
                  adjudication: {
                    source: arbitration,
                    target: adjudication!.target,
                    decision: adjudication!.decision,
                  },
                }),
            kind: 'task-role-evidence',
            roleId: role.roleId,
            scope: request.scope,
            criterion: origin.plan.criterion,
            origin: originRef,
            versions,
            commands,
            diff: cumulative
              .filter((change) => paths.includes(change.path))
              .map((change) => ({
                path: change.path,
                before:
                  change.before === null ? null : store.read(change.before.content).toString(),
                after: store.read(change.after!.content).toString(),
              })),
            logs: logs.filter((log) => commands.includes(String(log.name))),
            writer: writerResult,
            globalPacket: packet,
            priorReports: history.map((ref) => ({ answer: ref, report: read(ref).report })),
            openFindings,
          });
      roleEvidence.push({
        roleId: role.roleId,
        evidence: [...(request.schemaVersion === 1 ? [] : request.evidence), evidence],
        openFindings,
      });
    }
    return {
      ...request,
      schemaVersion: 4 as const,
      roles,
      evidence: [...(request.schemaVersion === 1 ? [] : request.evidence), packet],
      roleEvidence,
      expectedFiles: tree.files.map((file) => ({ path: file.path, ...file.version.content })),
    };
  }
  async function finishTechnical(
    input: LocalTaskInput,
    ref: ArtifactRef,
    packet: ReviewInput,
    reviewRef: ArtifactRef,
    stages?: ArtifactRef[],
    progress?: ArtifactRef,
    permit?: HumanCompletionPermit,
  ) {
    if (input.schemaVersion === 12) {
      requireContract(permit !== undefined, 'human-finish-required');
      requireTaskHumanCompletionSeal(registration, input, {
        snapshot: ref,
        packet,
        review: reviewRef,
        seal: permit.seal,
        producer: humanActivityScope,
      });
    }
    const owner = context(input),
      done = join(owner.gate.directory, 'done.json');
    if (existsSync(done)) {
      const commit = completion(input, ref, packet, reviewRef),
        outcome = {
          status: 'done' as const,
          result: controlRef(commit.result),
          projection: controlRef(commit.projection),
        };
      requireContract(
        same(JSON.parse(readPrivateFile(done).toString()), outcome),
        'task-completion-conflict',
      );
      return outcome;
    }
    if (existsSync(join(snapshot(input, ref, permit).gate.directory, 'completion-intent.json')))
      return completeProjection(input, ref, packet, reviewRef, permit);
    const entry = snapshot(input, ref, permit),
      body = entry.body,
      accepted = object(
        JSON.parse(
          readPrivateFile(join(entry.gate.directory, 'acceptance.json')).toString(),
        ) as unknown,
      );
    requireContract(same(accepted.review, packet), 'task-acceptance-binding');
    const reviewed = read(reviewRef);
    requireContract(
      reviewed.kind === 'reader-review-result' &&
        reviewed.complete === true &&
        same(reviewed.input, packet),
      'task-acceptance-not-passed',
    );
    const rechecked = await reviewActivities(registration, readerRpc, readerProfile).finishReview({
      schemaVersion: 1,
      input: packet,
      plan: controlRef(reviewed.plan),
      answers: reviewed.answers as { roleId: string; answer: ArtifactRef | null }[],
    });
    requireContract(
      rechecked.complete && same(rechecked.manifest, reviewRef),
      'task-acceptance-not-passed',
    );
    const result = accepted.result as unknown as WriterResult;
    await confirmStopped(body, result);
    for (const report of reviewed.reports as { answer: ArtifactRef }[])
      requireContract(read(report.answer).session !== result.session, 'task-self-acceptance');
    const final = checked(controlRef(accepted.finalChecks), body, 'integrated'),
      tree = final.tree as TaskTree;
    requireContract(
      same(
        files.capture(body.source.root, [
          ...new Set([
            ...tree.files.map((f) => f.path),
            ...body.tree.files.map((f) => f.path),
            ...body.plan.paths,
          ]),
        ]).files,
        tree.files,
      ),
      'task-final-input-changed',
    );
    let auditVerification: ArtifactRef | null = null;
    if (supervisedTask(input)) {
      requireContract(
        host.auditorRpc !== undefined && body.schemaVersion === 3 && body.supervision !== undefined,
        'task-supervision-required',
      );
      const ready = read(
        controlRef(
          JSON.parse(
            readPrivateFile(join(entry.gate.directory, 'substantial-preflight.json')).toString(),
          ) as unknown,
        ),
      );
      auditVerification = await confirmPlanningSupervision(
        registration,
        host.auditorRpc,
        input,
        ready.planning as unknown as ReviewInput,
        body.supervision,
      );
      entry.gate.assert();
    }
    const stageVerification = stageSupervisedTask(input)
      ? await confirmTaskStages(registration, host.auditorRpc!, input, ref, stages ?? [])
      : null;
    let progressVerification: ArtifactRef | null = null;
    if (input.schemaVersion === 9) {
      requireContract(progress !== undefined, 'task-progress-required');
      const material = read(controlRef(accepted.packet));
      const baseline = controlRef(object(material.baseline).source);
      checked(baseline, body, 'baseline');
      progressVerification = await confirmTaskProgressAudit(
        registration,
        host.auditorRpc!,
        input,
        ref,
        baseline,
        progress,
      );
    }
    if (permit === undefined) entry.gate.assert();
    else permit.assert();
    const resultRef = save({
      kind: 'local-task-result',
      ...(permit === undefined ? {} : { humanCompletion: permit.seal }),
      ...(input.schemaVersion === 9 ? { progress, progressVerification } : {}),
      ...(stageSupervisedTask(input) ? { stages, stageVerification } : {}),
      ...(supervisedTask(input) && body.schemaVersion === 3
        ? { supervision: body.supervision, auditVerification }
        : {}),
      ...(body.schemaVersion === 4 ? { correction: body.correction } : {}),
      input,
      snapshot: ref,
      packet,
      review: reviewRef,
      checks: accepted.finalChecks,
      writer: result,
      complete: true,
    });
    const card = input.admission.preparation.card,
      original = body.tree.files.find((f) => f.path === card)!.version;
    const rendered = taskCardProjection(
      input,
      resultRef,
      body.plan.criterion,
      original,
      store.read(original.content),
    );
    store.publish(rendered.card);
    const projection = save(rendered.projection);
    const commit = save({
      kind: 'task-completion-intent',
      ...(permit === undefined ? {} : { humanCompletion: permit.seal }),
      input,
      snapshot: ref,
      packet,
      review: reviewRef,
      result: resultRef,
      projection,
      tree,
    });
    once(join(entry.gate.directory, 'completion-intent.json'), commit);
    return completeProjection(input, ref, packet, reviewRef, permit);
  }
  async function checkLocalTask(
    input: LocalTaskInput,
    ref: ArtifactRef,
    stage: 'baseline' | 'candidate' | 'integrated',
    result: WriterResult | null,
    integration: ArtifactRef | null,
    retry?: { permit: HumanCompletionPermit; authorization: ArtifactRef },
  ) {
    requireContract(['baseline', 'candidate', 'integrated'].includes(stage), 'task-check-stage');
    const entry = snapshot(input, ref, retry?.permit),
      body = entry.body;
    let expected: TaskTree;
    if (stage === 'baseline') {
      requireContract(result === null && integration === null, 'task-baseline-binding');
      files.sourceCurrent(body);
      expected = body.tree;
    } else {
      requireContract(result !== null, 'task-check-writer-missing');
      await confirmStopped(body, result);
      expected = read(result.tree) as unknown as TaskTree;
    }
    const cwd = stage === 'integrated' ? body.source.root : body.copy.root;
    if (stage === 'integrated') {
      requireContract(integration !== null, 'task-integration-missing');
      const receipt = read(integration);
      requireContract(
        receipt.kind === 'task-integrated' && same(receipt.input, input),
        'task-integration-unconfirmed',
      );
    }
    const observed = () =>
      stage === 'integrated'
        ? files.capture(cwd, [
            ...new Set([
              ...expected.files.map((f) => f.path),
              ...body.tree.files.map((f) => f.path),
              ...body.plan.paths,
            ]),
          ])
        : files.tree(cwd);
    requireContract(same(observed().files, expected.files), 'task-check-input-changed');
    const stem = retry ? 'recheck-' + retry.authorization.sha256 : 'checks-' + stage;
    const retained = join(entry.gate.directory, stem + '.json'),
      request = { snapshot: ref, stage, result, integration };
    const pending = join(entry.gate.directory, stem + '-intent.json');
    if (existsSync(pending)) {
      requireContract(
        same(JSON.parse(readPrivateFile(pending).toString()), request),
        'task-check-request-conflict',
      );
      requireContract(existsSync(retained), 'task-check-outcome-unknown');
      return JSON.parse(readPrivateFile(retained).toString()) as {
        status: 'PASS' | 'FAIL';
        manifest: ArtifactRef;
      };
    }
    publishFile(pending, Buffer.from(JSON.stringify(request)));
    const outcomes = [];
    for (const name of stage === 'baseline' ? [input.baseline] : body.plan.checks) {
      (retry?.permit ?? entry.gate).assert();
      const before = observed();
      const command = body.commands[name]!;
      requireContract(
        digest(readFileSync(command.executable)) === command.sha256,
        'task-check-runtime-changed',
      );
      const outcome = await entry.checks.run(cwd, command);
      const after = observed();
      const status =
        digest(readFileSync(command.executable)) === command.sha256 &&
        outcome.code === 0 &&
        outcome.signal === null &&
        outcome.error === null &&
        same(before, after)
          ? 'PASS'
          : 'FAIL';
      const proof = save({
        kind: 'task-check',
        input,
        stage,
        name,
        before,
        after,
        ...outcome,
        status,
      });
      outcomes.push({ name, status, proof });
      if (status === 'FAIL') break;
    }
    const status: 'PASS' | 'FAIL' =
      outcomes.length > 0 && outcomes.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL';
    const outcome = {
      status,
      manifest: save({
        kind: 'task-checks',
        input,
        stage,
        snapshot: ref,
        tree: expected,
        outcomes,
        status,
      }),
    };
    once(retained, outcome);
    return outcome;
  }
  async function prepareLocalAcceptance(
    input: LocalTaskInput,
    ref: ArtifactRef,
    result: WriterResult,
    candidateChecks: ArtifactRef,
    intent: ArtifactRef,
    integration: ArtifactRef,
    finalChecks: ArtifactRef,
    baseline: ArtifactRef,
    retry?: { permit: HumanCompletionPermit; authorization: ArtifactRef },
  ) {
    const entry = snapshot(input, ref, retry?.permit),
      body = entry.body;
    await confirmStopped(body, result);
    checked(baseline, body, 'baseline');
    checked(candidateChecks, body, 'candidate');
    const final = checked(finalChecks, body, 'integrated');
    const transfer = read(intent) as unknown as TaskIntegration;
    files.sourceCurrent(body, transfer);
    requireContract(
      transfer.changes.every((c) => same(files.version(body.source.root, c.path), c.after)) &&
        same(
          files.capture(body.source.root, [
            ...new Set([
              ...(final.tree as TaskTree).files.map((f) => f.path),
              ...body.tree.files.map((f) => f.path),
              ...body.plan.paths,
            ]),
          ]).files,
          (final.tree as TaskTree).files,
        ),
      'task-acceptance-stale',
    );
    requireContract(
      same(read(integration), { kind: 'task-integrated', input, snapshot: ref, intent }),
      'task-integration-unconfirmed',
    );
    const raw = read(input.admission.acceptance),
      request = parseReviewRequest(raw, {
        schemaVersion: 1,
        preparation: input.admission.preparation,
        reviewId: 'b1',
        request: input.admission.acceptance,
      });
    if (request.schemaVersion !== 1)
      requireContract(
        request.expectedFiles.every((expected) =>
          (final.tree as TaskTree).files.some(
            (file) =>
              file.path === expected.path &&
              same(file.version.content, { sha256: expected.sha256, bytes: expected.bytes }),
          ),
        ),
        'task-acceptance-expected-input-changed',
      );
    const written = read(result.answer),
      stopped = read(result.stop);
    const evidence = (ref: ArtifactRef) => {
      const record: Record<string, unknown> = { ...read(ref), source: ref };
      delete record.input;
      delete record.snapshot;
      return record;
    };
    const checkSummary = (ref: ArtifactRef) => {
      const record = evidence(ref);
      return { ...record, tree: save(record.tree) };
    };
    const packet = save({
      kind: 'local-task-acceptance-packet',
      input,
      snapshot: ref,
      artifactRoot: registration.artifactRoot,
      admission: evidence(body.admission),
      writer: {
        ...evidence(result.answer),
        session: result.session,
        ...(body.schemaVersion !== 2
          ? { load: save(written.load), primary: object(written.primary).turn }
          : {}),
      },
      stop: {
        ...evidence(result.stop),
        before: save(stopped.before),
        after: save(stopped.after),
        ...(body.schemaVersion !== 2
          ? {
              primary: (
                object(object(stopped.primary).thread).turns as Record<string, unknown>[]
              ).map((turn) => ({ id: turn.id, status: turn.status })),
            }
          : {}),
      },
      diff: transfer.changes.map((c) => ({
        path: c.path,
        before: c.before === null ? null : store.read(c.before.content).toString('utf8'),
        after: c.after === null ? null : store.read(c.after.content).toString('utf8'),
      })),
      baseline: checkSummary(baseline),
      candidateChecks: checkSummary(candidateChecks),
      integration: evidence(integration),
      finalChecks: checkSummary(finalChecks),
      logs: [baseline, candidateChecks, finalChecks].flatMap((r) =>
        (read(r).outcomes as { proof: ArtifactRef }[]).map((c) => {
          const { before, after, ...record } = evidence(c.proof);
          return { ...record, source: c.proof, before: save(before), after: save(after) };
        }),
      ),
    });
    let acceptance: ReviewRequest = {
      ...request,
      schemaVersion: body.schemaVersion === 3 ? 3 : 2,
      evidence: [...(request.schemaVersion !== 1 ? request.evidence : []), packet],
      expectedFiles: (final.tree as TaskTree).files.map((f) => ({
        path: f.path,
        ...f.version.content,
      })),
    };
    if (body.schemaVersion === 4)
      acceptance = await correctionReview(
        body,
        ref,
        request,
        packet,
        final.tree as TaskTree,
        result,
        read(packet).logs as Record<string, unknown>[],
      );
    const review: ReviewInput = {
      schemaVersion: 1,
      preparation: input.admission.preparation,
      reviewId: 'b1-' + packet.sha256.slice(0, 32),
      request: save(acceptance),
    };
    retry?.permit.assert();
    once(join(entry.gate.directory, 'acceptance.json'), {
      ...(retry ? { recheck: retry.authorization } : {}),
      review,
      result,
      finalChecks,
      intent,
      packet,
    });
    return review;
  }
  function integratedFailure(input: HumanManagedTaskInput, heldRef: ArtifactRef) {
    const entry = context(input),
      held = read(heldRef),
      progress = object(held.progress);
    const pointer = (name: string) =>
      object(
        JSON.parse(
          readPrivateFile(join(entry.gate.directory, name + '.json')).toString(),
        ) as unknown,
      );
    const snapshot = controlRef(pointer('snapshot')),
      integration = controlRef(pointer('integration-receipt')),
      intent = controlRef(pointer('integration-intent')),
      stopped = controlRef(held.stopped),
      failed = controlRef(pointer('checks-integrated').manifest),
      check = read(failed),
      baseline = controlRef(pointer('checks-baseline').manifest),
      candidate = controlRef(pointer('checks-candidate').manifest),
      records = (progress.records as ArtifactRef[]).map(controlRef);
    requireContract(
      [baseline, candidate, integration, intent, failed].every((ref) =>
        records.some((record) => same(record, ref)),
      ) &&
        same(pointer('checks-integrated'), { status: 'FAIL', manifest: failed }) &&
        check.kind === 'task-checks' &&
        same(pointer('execution-held'), heldRef) &&
        same(held.input, input) &&
        held.command === null &&
        progress.phase === 'integrated-checks' &&
        held.reason === 'Error: task-integrated-checks-failed:' + failed.sha256 &&
        same(progress.snapshot, snapshot) &&
        same(pointer('stopped'), stopped) &&
        same(read(integration), { kind: 'task-integrated', input, snapshot, intent }) &&
        check.status === 'FAIL' &&
        check.stage === 'integrated' &&
        same(check.input, input) &&
        same(check.snapshot, snapshot) &&
        same(pointer('checks-integrated-intent'), {
          snapshot,
          stage: 'integrated',
          result: read(intent).writer,
          integration,
        }),
      'task-integrated-recheck-binding',
    );
    return {
      snapshot,
      integration,
      intent,
      stopped,
      baseline,
      candidate,
      records,
    };
  }
  const activities: LocalTaskActivities = {
    async recheckIntegratedTask(input, authorization) {
      const entry = context(input),
        proof = read(authorization),
        journal = executionJournal(input);
      requireContract(
        proof.kind === 'task-integrated-recheck' &&
          same(proof.input, input) &&
          same(journal.records.at(-1)?.ack.authorization, authorization) &&
          journal.pending === null,
        'task-recheck-authorization',
      );
      const data = integratedFailure(input, controlRef(proof.held)),
        transfer = read(data.intent) as unknown as TaskIntegration;
      const gate = taskHumanCompletionGate(
        input,
        files.binding(registration.workspaceRoot),
        profile,
        registration.artifactRoot,
        data.stopped,
        authorization,
        binding?.owner,
        'task-integrated-recheck',
      );
      const cancel = new AbortController(),
        signal = AbortSignal.any([Context.current().cancellationSignal, cancel.signal]);
      const permit = {
        ...gate,
        seal: authorization,
        assert() {
          requireActivityOpen(input, false);
          signal.throwIfAborted();
          gate.assert();
          requireContract(
            same(integratedFailure(input, controlRef(proof.held)), data),
            'task-integrated-recheck-binding',
          );
        },
      };
      const retry = { permit, authorization };
      const observed = await inspectStoppedTask({
        input,
        source: files.binding(registration.workspaceRoot),
        artifacts: files.binding(registration.artifactRoot),
        directory: entry.gate.directory,
        grant: readPrivateFile(join(entry.gate.directory, 'grant.json')),
        processes,
      });
      requireContract(same(observed.outcome, data.stopped), 'task-held-stop-unconfirmed');
      await observed.recheck();
      gate.acquire();
      let finishDrain!: () => void;
      const drained = new Promise<void>((resolve) => {
        finishDrain = resolve;
      });
      rechecks.set(entry, { cancel, drained });
      // A check is bounded and supervises its process group. Cancellation can never
      // publish acceptance; release the reservation only after confirmed process stop.

      try {
        const body = snapshot(input, data.snapshot, permit).body;
        files.sourceCurrent(body, transfer);
        const checked = await checkLocalTask(
          input,
          data.snapshot,
          'integrated',
          transfer.writer,
          data.integration,
          retry,
        );
        requireContract(
          checked.status === 'PASS',
          'task-integrated-checks-failed:' + checked.manifest.sha256,
        );
        const packet = await prepareLocalAcceptance(
          input,
          data.snapshot,
          transfer.writer,
          data.candidate,
          data.intent,
          data.integration,
          checked.manifest,
          data.baseline,
          retry,
        );
        return {
          snapshot: data.snapshot,
          stopped: data.stopped,
          packet,
          records: [...data.records, authorization, checked.manifest, packet.request],
        };
      } finally {
        try {
          await entry.checks.stop();
          gate.release();
          rechecks.delete(entry);
        } finally {
          finishDrain();
        }
      }
    },

    async prepareLocalArbitration(input, previous, packet, reviewRef) {
      requireContract(input.schemaVersion === 5, 'task-arbitration-input-required');
      const procedure = await checkArbitrationAdmission(input);
      requireContract(procedure !== undefined, 'task-arbitration-procedure-required');
      const entry = snapshot(input, previous),
        body = entry.body;
      requireContract(
        body.schemaVersion === 4 && body.correction.round === 2,
        'task-arbitration-round-required',
      );
      const { accepted, reviewed, failures } = await failedAcceptance(entry, packet, reviewRef),
        trigger = await arbitrationTarget(failures);
      requireContract(trigger !== null, 'task-arbitration-trigger-missing');
      await confirmStopped(body, accepted.result as unknown as WriterResult);
      const checkedResult = checked(controlRef(accepted.finalChecks), body, 'integrated');
      files.sourceCurrent(body, read(controlRef(accepted.intent)) as unknown as TaskIntegration);
      const rounds: Record<string, unknown>[] = [],
        sessions = [...(body.planning?.sessions ?? [])];
      let cursor = body,
        cursorReview = reviewRef;
      for (;;) {
        const stored = object(
          JSON.parse(
            readPrivateFile(
              join(
                scoped(context(input), cursor.correction.round).gate.directory,
                'acceptance.json',
              ),
            ).toString(),
          ) as unknown,
        );
        rounds.push({
          snapshot: save(cursor),
          packet: stored.packet,
          writer: stored.result,
          review: cursorReview,
        });
        const writer = stored.result as unknown as WriterResult;
        requireContract(writer.session !== null, 'task-arbitration-writer-session-required');
        sessions.push(writer.session);
        const predecessor = cursor.correction.previous;
        if (predecessor === null) break;
        cursorReview = predecessor.review;
        const earlier = read(predecessor.snapshot) as unknown as TaskSnapshot;
        requireContract(earlier.schemaVersion === 4, 'task-correction-origin');
        cursor = earlier;
      }
      for (const ref of [
        ...trigger.answers,
        ...(reviewed.reports as { answer: ArtifactRef }[]).map((row) => row.answer),
      ])
        sessions.push(String(read(ref).session));
      const targetActor = requireScoped(read(trigger.answers.at(-1)!).input),
        targetScope = parseReviewSnapshot(read(targetActor.review), targetActor);
      const writablePaths = body.plan.paths.filter((path) =>
        targetScope.files.some((file) => file.path === path),
      );
      requireContract(writablePaths.length > 0, 'task-arbitration-scope-empty');
      const originalRequest = parseReviewRequest(read(input.admission.acceptance), packet);
      const originalEvidence = originalRequest.schemaVersion === 1 ? [] : originalRequest.evidence;
      const manifest = save({
        procedure,
        priorEvidence: originalEvidence.map((source) => ({
          source,
          content: store.read(source).toString('utf8'),
        })),
        writablePaths,
        kind: 'task-arbitration-request',
        input,
        snapshot: previous,
        packet,
        review: reviewRef,
        ...trigger,
        rounds,
        sessions: [...new Set(sessions)],
        currentTree: checkedResult.tree,
        fullPacket: read(controlRef(accepted.packet)),
        originalReports: trigger.answers.map((ref) => ({ source: ref, ...read(ref) })),
      });
      const scope = {
        target: trigger.target,
        trigger: manifest,
        profile: input.arbitration.profile,
      };
      const request: ReviewRequest = {
        schemaVersion: 5,
        phase: 'arbitration',
        scope: 'three-fail-' + manifest.sha256,
        sharedPaths: [],
        evidence: [procedure, manifest],
        arbitration: scope,
        expectedFiles: (checkedResult.tree as TaskTree).files.map((f) => ({
          path: f.path,
          ...f.version.content,
        })),
        roles: input.admission.preparation.project.roles.map((role) => ({
          roleId: role.id,
          applies: role.id === input.arbitration.roleId,
          reason:
            role.id === input.arbitration.roleId
              ? 'Three consecutive primary FAIL of the exact finding'
              : 'No technical acceptance in arbitration',
          paths: role.id === input.arbitration.roleId ? body.tree.files.map((f) => f.path) : [],
          complete: true,
          attestedBy: 'project adapter',
          discoveryRule: 'frozen three-fail packet',
          history: { complete: true, answers: [] },
        })),
      };
      const result = {
        manifest,
        review: {
          schemaVersion: 1 as const,
          preparation: input.admission.preparation,
          reviewId: 'arbitration-' + manifest.sha256.slice(0, 32),
          request: save(request),
        },
      };
      once(join(entry.gate.directory, 'arbitration-prepared.json'), result);
      return result;
    },
    async finishLocalArbitration(input, previous, arbitration, reviewedRef) {
      requireContract(input.schemaVersion === 5, 'task-arbitration-input-required');
      const entry = snapshot(input, previous),
        prepared = object(
          JSON.parse(
            readPrivateFile(join(entry.gate.directory, 'arbitration-prepared.json')).toString(),
          ) as unknown,
        );
      requireContract(same(prepared.manifest, arbitration), 'task-arbitration-binding');
      const request = read(arbitration),
        reviewed = read(reviewedRef);
      requireContract(
        request.kind === 'task-arbitration-request' &&
          same(request.input, input) &&
          same(request.snapshot, previous) &&
          reviewed.kind === 'reader-review-result' &&
          same(reviewed.input, prepared.review),
        'task-arbitration-binding',
      );
      const expectedPlan = await reviewActivities(
        registration,
        readerRpc,
        input.arbitration.profile,
      ).prepareReviewPlan(prepared.review as unknown as ReviewInput);
      requireContract(
        same(expectedPlan.manifest, reviewed.plan),
        'task-arbitration-plan-unconfirmed',
      );
      const verified = await reviewActivities(
        registration,
        readerRpc,
        input.arbitration.profile,
      ).finishReview({
        schemaVersion: 1,
        input: prepared.review as unknown as ReviewInput,
        plan: controlRef(reviewed.plan),
        answers: reviewed.answers as { roleId: string; answer: ArtifactRef | null }[],
      });
      requireContract(
        !verified.complete && same(verified.manifest, reviewedRef),
        'task-arbitration-unconfirmed',
      );
      const reports = reviewed.reports as { roleId: string; answer: ArtifactRef }[];
      requireContract(
        reports.length === 1 && reports[0]!.roleId === input.arbitration.roleId,
        'task-arbitration-report-required',
      );
      const answer = read(reports[0]!.answer),
        proof = await reviewProof(registration, readerRpc)(
          reports[0]!.answer,
          requireScoped(answer.input),
        );
      requireContract(
        proof !== null &&
          proof.snapshot.schemaVersion === 5 &&
          same(proof.snapshot.arbitration.trigger, arbitration) &&
          same(proof.profile, input.arbitration.profile) &&
          !(request.sessions as string[]).includes(proof.session) &&
          proof.report.schemaVersion === 3,
        'task-arbitration-independent-required',
      );
      const decision = proof.report.decision,
        target = object(request.target);
      const readiness = arbitrationReadiness(
          decision,
          proof.report.coverage,
          target as unknown as ArbitrationScope['target'],
          input.arbitration.compromiseFindings,
        ),
        ready = readiness.ready;
      const manifest = save({
        kind: 'task-arbitration-result',
        input,
        snapshot: previous,
        request: arbitration,
        review: reviewedRef,
        answer: reports[0]!.answer,
        target,
        decision,
        ready,
        reason: readiness.reason,
      });
      const result = {
        manifest,
        snapshot: ready
          ? await prepareCorrection(
              entry,
              input,
              previous,
              request.packet as unknown as ReviewInput,
              controlRef(request.review),
              manifest,
            )
          : null,
        ready,
      };
      once(join(entry.gate.directory, 'arbitration-result.json'), {
        arbitration,
        reviewed: reviewedRef,
        result,
      });
      return result;
    },
    async prepareLocalCorrection(input, previous, packet, review) {
      const entry = snapshot(input, previous);
      requireContract(entry.body.schemaVersion === 4, 'task-correction-input-required');
      return prepareCorrection(entry, input, previous, packet, review);
    },
    async prepareInitialArbitration(value, planning, review) {
      requireContract(value.schemaVersion === 6, 'initial-input-required');
      const entry = context(value);
      entry.gate.assert();
      const preflight = controlRef(
        JSON.parse(
          readPrivateFile(join(entry.gate.directory, 'substantial-preflight.json')).toString(),
        ) as unknown,
      );
      const result = await initialArbitrationActivities(
        registration,
        readerRpc,
        readerProfile,
      ).prepare(value, preflight, planning, review);
      once(join(entry.gate.directory, 'initial-arbitration-prepared.json'), result);
      return result;
    },
    async finishInitialArbitration(value, arbitration, reviewed) {
      requireContract(value.schemaVersion === 6, 'initial-input-required');
      const entry = context(value);
      entry.gate.assert();
      const prepared = JSON.parse(
        readPrivateFile(join(entry.gate.directory, 'initial-arbitration-prepared.json')).toString(),
      ) as { manifest: ArtifactRef; review: ReviewInput };
      requireContract(same(prepared.manifest, arbitration), 'initial-arbitration-binding');
      const result = await initialArbitrationActivities(
        registration,
        readerRpc,
        readerProfile,
      ).finish(value, prepared, reviewed);
      if (result.preflight !== null)
        once(join(entry.gate.directory, 'initial-replanning-preflight.json'), result.preflight);
      const outcome = { manifest: result.manifest, planning: result.planning };
      once(join(entry.gate.directory, 'initial-arbitration-result.json'), {
        arbitration,
        reviewed,
        outcome,
      });
      return outcome;
    },
    async prepareSubstantialPlanning(value) {
      await checkArbitrationAdmission(value);
      const entry = context(value),
        input = entry.input;
      requireContract(
        input.schemaVersion === 3 ||
          input.schemaVersion === 6 ||
          input.schemaVersion === 10 ||
          input.schemaVersion === 11 ||
          input.schemaVersion === 12 ||
          supervisedTask(input) ||
          correctingTask(input),
        'substantial-input-required',
      );
      requireContract(input.admission.schemaVersion === 3, 'substantial-input-required');
      if (input.schemaVersion === 10 || input.schemaVersion === 11 || input.schemaVersion === 12)
        requireContract(host.authority !== undefined, 'task-human-authority-required');
      if (input.schemaVersion === 10 && input.continuation.previous !== null) {
        const previous = read(input.continuation.previous),
          prior = parseLocalTask(previous.input);
        requireContract(
          previous.kind === 'task-planning-continuation' && prior.schemaVersion === 10,
          'task-continuation-binding',
        );
        const resumed = await continuationControls.resumeTaskPlanning(
          prior,
          controlRef(previous.held),
          previous.command as Parameters<TaskContinuationControls['resumeTaskPlanning']>[2],
          Number(object(previous.command).expectedRevision),
        );
        requireContract(same(resumed.input, input), 'task-continuation-binding');
      }
      if (input.schemaVersion === 11 || input.schemaVersion === 12) {
        const seal = read(
          controlRef(
            JSON.parse(
              readPrivateFile(join(entry.gate.directory, 'execution-admission.json')).toString(),
            ),
          ),
        );
        requireContract(
          seal.kind === 'task-execution-admission' && same(seal.input, input),
          'task-execution-admission-required',
        );
        await validateTaskExecutionContinuation(input);
      }
      if (supervisedTask(input))
        requireContract(host.auditorRpc !== undefined, 'task-auditor-host-required');
      entry.gate.install();
      const path = join(entry.gate.directory, 'substantial-preflight.json');
      if (existsSync(path)) {
        const retained = controlRef(JSON.parse(readPrivateFile(path).toString()) as unknown);
        return read(retained).planning as unknown as ReviewInput;
      }
      const ready = await preflightSubstantialTask(
        registration,
        { ...input, admission: input.admission },
        readerRpc,
        readerProfile,
      );
      entry.gate.assert();
      publishFile(path, Buffer.from(JSON.stringify(ready.manifest)));
      return ready.planning;
    },
    async prepareLocalTask(value, planning, supervision) {
      await checkArbitrationAdmission(value);
      const entry = context(value),
        input = entry.input;
      entry.gate.install();
      if (supervisedTask(input)) {
        requireContract(
          host.auditorRpc !== undefined && supervision !== undefined,
          'task-supervision-required',
        );
        const ready = read(
          controlRef(
            JSON.parse(
              readPrivateFile(join(entry.gate.directory, 'substantial-preflight.json')).toString(),
            ) as unknown,
          ),
        );
        await confirmPlanningSupervision(
          registration,
          host.auditorRpc,
          input,
          ready.planning as unknown as ReviewInput,
          supervision,
        );
        entry.gate.assert();
      }
      const retained = join(entry.gate.directory, 'snapshot.json');
      if (existsSync(retained)) {
        const ref = controlRef(JSON.parse(readPrivateFile(retained).toString()) as unknown);
        const previous = snapshot(input, ref);
        if (supervisedTask(input))
          requireContract(
            previous.body.schemaVersion === 3 && same(previous.body.supervision, supervision),
            'task-supervision-conflict',
          );
        files.sourceCurrent(previous.body);
        return ref;
      }
      const admitted = await (async () => {
        if (input.schemaVersion === 1)
          return localAdmissionActivities(registration).prepareLocalAdmission(input.admission);
        if (input.schemaVersion === 2)
          return prepareMechanicalTask(registration, input.admission, readerRpc, readerProfile);
        if (input.admission.schemaVersion === 1)
          return localAdmissionActivities(registration).prepareLocalAdmission(input.admission);
        requireContract(planning !== undefined, 'substantial-planning-required');
        const ready = controlRef(
          JSON.parse(
            readPrivateFile(
              join(
                entry.gate.directory,
                input.schemaVersion === 6 &&
                  existsSync(join(entry.gate.directory, 'initial-replanning-preflight.json'))
                  ? 'initial-replanning-preflight.json'
                  : 'substantial-preflight.json',
              ),
            ).toString(),
          ) as unknown,
        );
        return admitSubstantialTask(
          registration,
          { ...input, admission: input.admission },
          ready,
          planning,
          readerRpc,
          readerProfile,
        );
      })();
      if (correctingTask(input) && input.admission.schemaVersion === 1)
        checkCorrectionRoles(
          input,
          parseReviewRequest(read(input.admission.acceptance), {
            schemaVersion: 1,
            preparation: input.admission.preparation,
            reviewId: 'local-admission',
            request: input.admission.acceptance,
          }).roles,
        );
      entry.gate.assert();
      const admission = read(admitted.manifest),
        rawPlan = admission.plan;
      if (
        input.schemaVersion === 1 ||
        (correctingTask(input) && input.admission.schemaVersion === 1)
      )
        validateLocalPlan(rawPlan);
      const plan = 'plan' in admitted ? admitted.plan : (rawPlan as LocalImplementationPlan);
      const commands = resolveRegisteredCommands(registration, [input.baseline, ...plan.checks]);
      const source = files.binding(registration.workspaceRoot),
        paths = [
          ...plan.paths,
          input.admission.plan.path,
          ...(input.schemaVersion !== 2 ? [input.executor.path] : []),
          plan.requirement.locator,
          ...plan.basis.map((f) => f.locator),
          ...(input.schemaVersion !== 2
            ? [
                (rawPlan as LocalImplementationPlan).owner.locator,
                ...(rawPlan as LocalImplementationPlan).consumers.map((f) => f.locator),
              ]
            : []),
          ...input.admission.preparation.project.rules,
          ...input.admission.preparation.project.roles.map((r) => r.profile),
          input.admission.preparation.card,
          ...(admission.acceptanceFiles as { path: string }[]).map((f) => f.path),
        ];
      const tree = files.capture(source.root, [...new Set(paths)]);
      const sources = [
        plan.requirement,
        ...plan.basis,
        { locator: input.admission.plan.path, hash: input.admission.plan.sha256 },
        ...(input.schemaVersion !== 2
          ? [
              (rawPlan as LocalImplementationPlan).owner,
              ...(rawPlan as LocalImplementationPlan).consumers,
            ]
          : []),
      ];
      const changes = 'mechanical' in admitted ? admitted.mechanical.changes : [];
      const prepared = read(controlRef(object(admission.prepared).manifest));
      const expected = [
        ...(prepared.inputs as { path: string; sha256: string; bytes: number }[]),
        ...(admission.acceptanceFiles as { path: string; sha256: string; bytes: number }[]).flatMap(
          (file) => {
            const change = changes.find((c) => c.path === file.path);
            return change === undefined
              ? [file]
              : change.before === null
                ? []
                : [{ path: file.path, ...change.before.content }];
          },
        ),
      ];
      requireContract(
        (!('tree' in admitted) || same(tree, admitted.tree)) &&
          sources.every((s) =>
            tree.files.some((f) => f.path === s.locator && f.version.content.sha256 === s.hash),
          ) &&
          expected.every((s) =>
            tree.files.some(
              (f) =>
                f.path === s.path &&
                f.version.content.sha256 === s.sha256 &&
                f.version.content.bytes === s.bytes,
            ),
          ) &&
          changes.every((c) =>
            same(tree.files.find((f) => f.path === c.path)?.version ?? null, c.before),
          ),
        'task-admission-input-changed',
      );
      if (input.schemaVersion !== 2) {
        const executor = tree.files.find((f) => f.path === input.executor.path);
        requireContract(
          executor?.version.content.sha256 === input.executor.sha256 &&
            !taskPathAllowed(plan.paths, input.executor.path),
          'task-executor-profile-changed',
        );
      }
      const copied = files.copy(source, tree, privateDirectory(copyRoot(input, 0)));
      const fields = {
        admission: admitted.manifest,
        profile,
        disabledServers,
        source,
        copy: copied.binding,
        tree: copied.tree,
        commands,
      };
      let body: TaskSnapshot;
      if (input.schemaVersion === 1)
        body = {
          schemaVersion: 1,
          kind: 'local-task',
          input,
          plan: plan as LocalImplementationPlan,
          ...fields,
        };
      else if (correctingTask(input)) {
        body = {
          schemaVersion: 4,
          kind: 'correction-task',
          input,
          plan: rawPlan as LocalImplementationPlan | SubstantialPlan,
          planning: 'planning' in admitted ? admitted.planning : null,
          correction: { round: 0, origin: null, previous: null, instructions: null },
          ...fields,
        };
      } else if (
        input.schemaVersion === 3 ||
        input.schemaVersion === 6 ||
        input.schemaVersion === 10 ||
        input.schemaVersion === 11 ||
        input.schemaVersion === 12 ||
        supervisedTask(input)
      ) {
        requireContract('planning' in admitted, 'substantial-admission-missing');
        body = {
          schemaVersion: 3,
          kind: 'substantial-task',
          input,
          plan: rawPlan as SubstantialPlan,
          planning: admitted.planning,
          ...(supervision !== undefined && supervisedTask(input) ? { supervision } : {}),
          ...fields,
        };
      } else {
        requireContract('mechanical' in admitted, 'mechanical-admission-missing');
        body = {
          schemaVersion: 2,
          kind: 'mechanical-task',
          input,
          plan,
          mechanical: admitted.mechanical,
          ...fields,
        };
      }
      const ref = save(body);
      entry.gate.assert();
      publishFile(retained, Buffer.from(JSON.stringify(ref)));
      entry.snapshot = body;
      return ref;
    },
    checkLocalTask: (input, ref, stage, result, integration) =>
      checkLocalTask(input, ref, stage, result, integration),
    async writeLocalTask(input, ref, progress) {
      const entry = snapshot(input, ref),
        owner =
          entry.body.schemaVersion === 4
            ? scoped(context(input), entry.body.correction.round)
            : context(input),
        journal = effectJournal(join(entry.gate.directory, 'task-effects'));
      if (input.schemaVersion === 9) {
        requireContract(
          host.auditorRpc !== undefined && progress !== undefined,
          'task-progress-required',
        );
        const retained = object(
          JSON.parse(
            readPrivateFile(join(entry.gate.directory, 'checks-baseline.json')).toString(),
          ) as unknown,
        );
        const baseline = controlRef(retained.manifest);
        requireContract(retained.status === 'PASS', 'task-progress-baseline-binding');
        checked(baseline, entry.body, 'baseline');
        await confirmTaskProgressAudit(
          registration,
          host.auditorRpc,
          input,
          ref,
          baseline,
          progress,
        );
        entry.gate.assert();
      }
      const p = input.admission.preparation,
        intent = {
          projectId: p.project.projectId,
          taskId: p.taskId,
          operationId:
            'task-write-' +
            digest(localTaskKey(input)) +
            (input.schemaVersion === 11 || input.schemaVersion === 12
              ? '-a' + input.continuation.attempt
              : '') +
            (entry.body.schemaVersion === 4 ? '-r' + entry.body.correction.round : ''),
          requestHash: digest(
            JSON.stringify(input.schemaVersion === 9 ? { snapshot: ref, progress } : ref),
          ),
          hostId: p.hostId,
          workspaceId: p.project.workspaceId,
          owner: p.owner,
          generation: p.generation,
        };
      const result = await journal.execute(
        intent,
        async () => {
          const written =
              entry.body.schemaVersion !== 2
                ? await writer(owner, entry.body).write()
                : await applyMechanicalTask(entry.body, files, entry.gate),
            result = save(written);
          publishFile(
            join(entry.gate.directory, 'writer-result.json'),
            Buffer.from(JSON.stringify(result)),
          );
          return result;
        },
        async () =>
          existsSync(join(entry.gate.directory, 'writer-result.json'))
            ? controlRef(
                JSON.parse(
                  readPrivateFile(join(entry.gate.directory, 'writer-result.json')).toString(),
                ) as unknown,
              )
            : null,
      );
      const answer = read(result) as unknown as WriterResult;
      await confirmStopped(entry.body, answer);
      return answer;
    },
    async planLocalIntegration(input, ref, result, checks) {
      const entry = snapshot(input, ref),
        body = entry.body;
      await confirmStopped(body, result);
      checked(checks, body, 'candidate');
      files.sourceCurrent(body);
      const current = files.candidate(body),
        expected = read(result.tree) as unknown as TaskTree;
      requireContract(same(current, expected), 'task-candidate-changed');
      const changes = taskDelta(body.tree, current);
      const previous =
        changes.length === 0 && (input.schemaVersion === 11 || input.schemaVersion === 12)
          ? await previousIntegration(input, body)
          : null;
      requireContract(changes.length > 0 || previous !== null, 'task-result-empty');
      const intent = save({
        changes,
        source: body.source,
        copy: body.copy,
        candidate: result.tree,
        writer: result,
        ...(previous !== null ? { previousIntegration: previous } : {}),
      } satisfies TaskIntegration);
      once(join(entry.gate.directory, 'integration-intent.json'), intent);
      return intent;
    },
    async integrateLocalTask(input, ref, intentRef) {
      const entry = snapshot(input, ref),
        intent = read(intentRef) as unknown as TaskIntegration;
      await confirmStopped(entry.body, intent.writer);
      requireContract(
        same(
          JSON.parse(
            readPrivateFile(join(entry.gate.directory, 'integration-intent.json')).toString(),
          ),
          intentRef,
        ),
        'task-integration-intent-changed',
      );
      if ((input.schemaVersion === 11 || input.schemaVersion === 12) && intent.changes.length === 0)
        requireContract(
          same(intent.previousIntegration, await previousIntegration(input, entry.body)),
          'task-previous-integration-binding',
        );
      await files.integration(entry.body, intent, entry.gate.exclusive);
      const receipt = save({ kind: 'task-integrated', input, snapshot: ref, intent: intentRef });
      try {
        publishFile(
          join(entry.gate.directory, 'integration-receipt.json'),
          Buffer.from(JSON.stringify(receipt)),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        requireContract(
          same(
            JSON.parse(
              readPrivateFile(join(entry.gate.directory, 'integration-receipt.json')).toString(),
            ),
            receipt,
          ),
          'task-integration-receipt-conflict',
        );
      }
      return receipt;
    },
    prepareLocalAcceptance: (
      input,
      ref,
      result,
      candidateChecks,
      intent,
      integration,
      finalChecks,
      baseline,
    ) =>
      prepareLocalAcceptance(
        input,
        ref,
        result,
        candidateChecks,
        intent,
        integration,
        finalChecks,
        baseline,
      ),
    async finishLocalTask(input, ref, packet, reviewRef, stages, progress) {
      requireContract(input.schemaVersion !== 12, 'human-finish-required');
      return finishTechnical(input, ref, packet, reviewRef, stages, progress);
    },
  };
  const controls: LocalTaskControls = {
    async stopLocalTask(value) {
      const entry = context(value, true),
        input = entry.input,
        stopping = stops.get(entry);
      const recheck = rechecks.get(entry);
      if (recheck) {
        recheck.cancel.abort();
        await recheck.drained;
        requireContract(!rechecks.has(entry), 'task-check-stop-unknown');
      }
      if (stopping !== undefined) return stopping;
      if (existsSync(join(entry.gate.directory, 'done.json'))) {
        if (input.schemaVersion === 12) requireTaskHumanCompletionSeal(registration, input);
        return save({ kind: 'task-stopped', input, confirmed: true, completed: true });
      }
      const stoppedFile = join(entry.gate.directory, 'stopped.json');
      if (existsSync(stoppedFile)) {
        const receipt = controlRef(JSON.parse(readPrivateFile(stoppedFile).toString()) as unknown);
        const outcome = read(receipt);
        const writers = Array.isArray(outcome.rounds)
          ? outcome.rounds.map((round: unknown) => object(round).writer)
          : [outcome.writer];
        if (
          writers.some((ref) => ref !== undefined && read(controlRef(ref)).baseline !== undefined)
        ) {
          const observed = await inspectStoppedTask({
            input,
            source: files.binding(registration.workspaceRoot),
            artifacts: files.binding(registration.artifactRoot),
            directory: entry.gate.directory,
            grant: readPrivateFile(join(entry.gate.directory, 'grant.json')),
            processes,
          });
          requireContract(same(observed.outcome, receipt), 'task-writer-stop-binding');
        }
        entry.gate.release();
        return receipt;
      }
      entry.gate.freeze();
      const pending = Promise.resolve().then(async () => {
        if (!existsSync(join(entry.gate.directory, 'grant.json'))) {
          requireContract(
            [
              'snapshot.json',
              'writer-runtime.json',
              'runtime-identity.json',
              'writer-stopped.json',
              'writer-result.json',
            ].every((name) => !existsSync(join(entry.gate.directory, name))),
            'task-writer-runtime-unknown',
          );
          const receipt = save({ kind: 'task-not-started', input, confirmed: true });
          once(stoppedFile, receipt);
          entry.gate.release();
          return receipt;
        }
        if (correctingTask(input)) {
          const scopes = [
            entry,
            ...[...entry.rounds].sort(([a], [b]) => a - b).map(([, scope]) => scope),
          ];
          const stopped = [];
          let latest: TaskEntry | null = null;
          for (const current of scopes) {
            const checks = await current.checks.stop();
            const file = join(current.gate.directory, 'snapshot.json');
            if (existsSync(file)) {
              const ref = controlRef(JSON.parse(readPrivateFile(file).toString()) as unknown),
                body = read(ref) as unknown as TaskSnapshot;
              requireContract(body.schemaVersion === 4, 'task-correction-input-required');
              const writerStop = await writer(current, body).stop();
              stopped.push({ round: body.correction.round, writer: writerStop, checks });
              current.snapshot = body;
              latest = current;
            } else
              requireContract(
                !existsSync(join(current.gate.directory, 'writer-runtime.json')),
                'task-writer-runtime-unknown',
              );
          }
          if (latest !== null) {
            const path = join(latest.gate.directory, 'integration-intent.json');
            if (existsSync(path)) {
              const intent = read(
                controlRef(JSON.parse(readPrivateFile(path).toString()) as unknown),
              ) as unknown as TaskIntegration;
              requireContract(
                intent.changes.every((change) =>
                  same(files.version(registration.workspaceRoot, change.path), change.before),
                ) ||
                  intent.changes.every((change) =>
                    same(files.version(registration.workspaceRoot, change.path), change.after),
                  ),
                'task-partial-integration-unknown',
              );
            }
          }
          const receipt = save({ kind: 'task-stopped', input, confirmed: true, rounds: stopped });
          once(stoppedFile, receipt);
          entry.gate.release();
          return receipt;
        }
        const checksStopped = await entry.checks.stop();
        if (!existsSync(join(entry.gate.directory, 'snapshot.json'))) {
          requireContract(
            !existsSync(join(entry.gate.directory, 'writer-runtime.json')),
            'task-writer-runtime-unknown',
          );
          const receipt = save({ kind: 'task-not-started', input, confirmed: true });
          once(stoppedFile, receipt);
          entry.gate.release();
          return receipt;
        }
        const ref = controlRef(
            JSON.parse(
              readPrivateFile(join(entry.gate.directory, 'snapshot.json')).toString(),
            ) as unknown,
          ),
          body = read(ref) as unknown as TaskSnapshot;
        const stopped =
          body.schemaVersion !== 2
            ? await writer(entry, body).stop()
            : save({
                kind: 'task-mechanical-stopped',
                input,
                confirmed: true,
                session: null,
                processes: [],
                after: files.tree(body.copy.root),
              });
        const integrationFile = join(entry.gate.directory, 'integration-intent.json');
        if (existsSync(integrationFile)) {
          const intent = read(
            controlRef(JSON.parse(readPrivateFile(integrationFile).toString()) as unknown),
          ) as unknown as TaskIntegration;
          requireContract(
            intent.changes.every((c) => same(files.version(body.source.root, c.path), c.before)) ||
              intent.changes.every((c) => same(files.version(body.source.root, c.path), c.after)),
            'task-partial-integration-unknown',
          );
        }
        const receipt = save({
          kind: 'task-stopped',
          input,
          confirmed: true,
          writer: stopped,
          checksStopped,
        });
        once(stoppedFile, receipt);
        entry.gate.release();
        return receipt;
      });
      stops.set(entry, pending);
      try {
        return await pending;
      } finally {
        stops.delete(entry);
      }
    },
  };
  const continuationControls: TaskContinuationControls = {
    async holdTaskPlanning(input, planning, reviewRef) {
      const entry = context(input);
      const retained = join(entry.gate.directory, 'held.json');
      if (existsSync(retained)) {
        const ref = controlRef(JSON.parse(readPrivateFile(retained).toString())),
          body = read(ref);
        requireContract(
          same(body.input, input) && same(body.planning, planning) && same(body.review, reviewRef),
          'task-held-planning-binding',
        );
        return ref;
      }
      if (!existsSync(join(entry.gate.directory, 'stopped.json'))) entry.gate.assert();
      requireContract(
        !existsSync(join(entry.gate.directory, 'snapshot.json')) &&
          !existsSync(join(entry.gate.directory, 'writer-runtime.json')),
        'task-continuation-after-writer',
      );
      const preflight = read(
        controlRef(
          JSON.parse(
            readPrivateFile(join(entry.gate.directory, 'substantial-preflight.json')).toString(),
          ),
        ),
      );
      const reviewed = read(reviewRef);
      requireContract(
        same(preflight.input, input) &&
          same(preflight.planning, planning) &&
          reviewed.kind === 'reader-review-result' &&
          reviewed.complete === false &&
          same(reviewed.input, planning),
        'task-held-planning-binding',
      );
      const verified = await reviewActivities(registration, readerRpc, readerProfile).finishReview({
        schemaVersion: 1,
        input: planning,
        plan: controlRef(reviewed.plan),
        answers: reviewed.answers as { roleId: string; answer: ArtifactRef | null }[],
      });
      requireContract(
        !verified.complete && same(verified.manifest, reviewRef),
        'task-held-review-unconfirmed',
      );
      const stopped = await controls.stopLocalTask(input);
      const held = save({
        kind: 'task-planning-held',
        input,
        planning,
        review: reviewRef,
        stopped,
      });
      once(join(entry.gate.directory, 'held.json'), held);
      return held;
    },
    async resumeTaskPlanning(input, held, raw, revision) {
      const command = taskResumeCommand(input, raw, revision),
        entry = context(input);
      requireContract(host.authority !== undefined, 'task-human-authority-required');
      requireContract(
        digest(readerCommandText(command)) === command.hash,
        'task-command-hash-invalid',
      );
      requireContract(
        same(JSON.parse(readPrivateFile(join(entry.gate.directory, 'held.json')).toString()), held),
        'task-held-binding',
      );
      const record = read(held),
        stopped = read(controlRef(record.stopped));
      requireContract(
        record.kind === 'task-planning-held' &&
          same(record.input, input) &&
          stopped.confirmed === true &&
          same(stopped.input, input),
        'task-held-stop-unconfirmed',
      );
      requireContract(
        !existsSync(join(entry.gate.directory, 'snapshot.json')) &&
          !existsSync(join(entry.gate.directory, 'writer-runtime.json')),
        'task-continuation-after-writer',
      );
      const path = join(
        privateDirectory(join(entry.gate.directory, 'continuations')),
        command.commandId + '.json',
      );
      if (existsSync(path)) {
        const retained = JSON.parse(readPrivateFile(path).toString()) as {
          command: typeof command;
          result: Awaited<ReturnType<TaskContinuationControls['resumeTaskPlanning']>>;
        };
        requireContract(same(retained.command, command), 'task-command-id-conflict');
        return retained.result;
      }
      const authorization = await host.authority.verify(command);
      requireContract(
        authorization.origin === 'human' &&
          authorization.author === command.author &&
          authorization.hash === command.hash,
        'task-human-authorization-required',
      );
      store.read(authorization.proof);
      const payload = parseTaskResumePayload(read(command.payload));
      requireContract(same(payload.held, held), 'task-resume-held-changed');
      checkTaskContinuation(input, payload);
      const previous = read(
        controlRef(
          JSON.parse(
            readPrivateFile(join(entry.gate.directory, 'substantial-preflight.json')).toString(),
          ),
        ),
      );
      const before = parseSubstantialPlan(previous.plan),
        bytes = readProjectFile(registration.workspaceRoot, payload.admission.plan.path);
      requireContract(digest(bytes) === payload.admission.plan.sha256, 'substantial-plan-changed');
      const next = parseSubstantialPlan(JSON.parse(bytes.toString()));
      requireContract(
        next.plan_id === before.plan_id &&
          next.paths.every((path) => taskPathAllowed(before.paths, path)),
        'task-resume-writer-scope-changed',
      );
      const transition = save({
        kind: 'task-planning-continuation',
        input,
        held,
        command,
        authorization: authorization.proof,
        admission: payload.admission,
        invalidated: [
          'planning',
          'baseline',
          'candidate-checks',
          'integrated-checks',
          'acceptance',
        ],
      });
      const nextInput = parseLocalTask({
        ...input,
        admission: payload.admission,
        continuation: { attempt: command.attempt, previous: transition },
      });
      requireContract(nextInput.schemaVersion === 10, 'task-continuation-input-required');
      const result = {
        input: nextInput,
        ack: {
          commandId: command.commandId,
          hash: command.hash,
          revision: revision + 1,
          authorization: transition,
        },
      };
      once(path, { command, result });
      return result;
    },
  };
  function executionInput(value: unknown): AnyManagedTaskInput {
    const input = parseLocalTask(value);
    requireContract(
      input.schemaVersion === 11 || input.schemaVersion === 12,
      'task-execution-input-required',
    );
    return input;
  }
  function executionResumePayload(input: AnyManagedTaskInput, value: unknown) {
    if (input.schemaVersion === 12) {
      const payload = parseTaskHumanExecutionResume(value);
      checkTaskHumanExecutionResume(input, payload);
      return payload;
    }
    const payload = parseTaskExecutionResume(value);
    checkTaskExecutionResume(input, payload);
    return payload;
  }
  function executionNext(
    input: AnyManagedTaskInput,
    payload: ReturnType<typeof executionResumePayload>,
    attempt: number,
    transition: ArtifactRef,
  ) {
    return executionInput({
      ...input,
      admission: payload.admission,
      ...(payload.schemaVersion === 2 ? { startAdmission: payload.startAdmission } : {}),
      continuation: { attempt, previous: transition },
    });
  }
  function humanExecutionProposal(input: HumanManagedTaskInput, command: PayloadReaderCommand) {
    if (command.action !== 'resume') {
      taskInterruption(read(command.payload));
      requireContract(command.attempt === input.continuation.attempt, 'task-command-stale');
      return {
        replan: false,
        next: {
          admission: input.admission,
          startAdmission: input.startAdmission,
          attempt: input.continuation.attempt,
        },
      };
    }
    const payload = parseTaskHumanWaitResume(read(command.payload)),
      replan = checkTaskHumanWaitResume(input, payload);
    requireContract(
      command.attempt === input.continuation.attempt + (replan ? 1 : 0),
      'task-command-stale',
    );
    return {
      replan,
      next: {
        admission: payload.admission,
        startAdmission: payload.startAdmission,
        attempt: command.attempt,
      },
    };
  }
  function humanExecutionNext(
    input: HumanManagedTaskInput,
    proposal: ReturnType<typeof humanExecutionProposal>,
    transition: ArtifactRef,
  ): HumanManagedTaskInput {
    if (!proposal.replan) return input;
    const next = executionInput({
      ...input,
      admission: proposal.next.admission,
      startAdmission: proposal.next.startAdmission,
      continuation: { attempt: proposal.next.attempt, previous: transition },
    });
    requireContract(next.schemaVersion === 12, 'task-execution-input-required');
    return next;
  }
  async function executionDeclaration(
    input: HumanManagedTaskInput,
    previous?: HumanManagedTaskInput,
  ) {
    const p = input.admission.preparation,
      verified = await startAdmission(input, 'current');
    if (previous !== undefined)
      requireContract(
        same(verified.admission.previous, previous.startAdmission) &&
          p.revision === previous.admission.preparation.revision + 1,
        'task-start-revision-chain',
      );
    return verified;
  }
  function executionPlanScope(
    input: AnyManagedTaskInput,
    admission: HumanManagedTaskInput['admission'],
  ) {
    const path = join(context(input).gate.directory, 'execution-admission.json'),
      sealedBytes = readPrivateFile(path),
      ref = controlRef(JSON.parse(sealedBytes.toString())),
      sealed = read(ref),
      before = parseSubstantialPlan(read(controlRef(sealed.plan))),
      bytes = readProjectFile(registration.workspaceRoot, admission.plan.path);
    requireContract(
      sealed.kind === 'task-execution-admission' &&
        same(sealed.input, input) &&
        digest(bytes) === admission.plan.sha256,
      'task-execution-admission-required',
    );
    const next = parseSubstantialPlan(JSON.parse(bytes.toString()));
    requireContract(
      next.plan_id === before.plan_id &&
        next.paths.every((value) => taskPathAllowed(before.paths, value)),
      'task-resume-writer-scope-changed',
    );
    return () => {
      store.read(ref);
      store.read(controlRef(sealed.plan));
      requireContract(
        readPrivateFile(path).equals(sealedBytes) &&
          readProjectFile(registration.workspaceRoot, admission.plan.path).equals(bytes),
        'task-execution-admission-required',
      );
    };
  }
  async function validateTaskExecutionContinuation(input: AnyManagedTaskInput) {
    if (input.continuation.previous === null) return;
    const transitionRef = input.continuation.previous,
      transition = read(transitionRef),
      prior = parseLocalTask(transition.input),
      command = parsePayloadReaderCommand(transition.command);
    requireContract(
      (prior.schemaVersion === 11 || prior.schemaVersion === 12) &&
        prior.schemaVersion === input.schemaVersion,
      'task-continuation-binding',
    );
    if (transition.kind !== 'task-human-execution-control') {
      requireContract(
        transition.kind === 'task-execution-continuation',
        'task-continuation-binding',
      );
      const resumed = await executionControls.resumeTaskExecution(
        prior,
        controlRef(transition.held),
        command,
        command.expectedRevision,
      );
      requireContract(same(resumed.input, input), 'task-continuation-binding');
      return;
    }
    requireContract(
      prior.schemaVersion === 12 && input.schemaVersion === 12,
      'task-continuation-binding',
    );
    retainedHumanExecutionContinuation(prior, input, transitionRef);
    await executionDeclaration(input, prior);
    executionPlanScope(prior, input.admission)();
  }
  function retainedHumanExecutionContinuation(
    prior: HumanManagedTaskInput,
    input: HumanManagedTaskInput,
    transitionRef: ArtifactRef,
  ) {
    Context.current().cancellationSignal.throwIfAborted();
    const transition = read(transitionRef),
      command = taskHumanExecutionCommand(
        prior,
        transition.command,
        parsePayloadReaderCommand(transition.command).expectedRevision,
      ),
      proposal = humanExecutionProposal(prior, command),
      journal = executionJournal(input),
      retained = journal.records.find((record) => same(record.ack.authorization, transitionRef)),
      intent = journal.intents[command.expectedRevision];
    requireContract(
      transition.kind === 'task-human-execution-control' &&
        same(transition.input, prior) &&
        proposal.replan &&
        transition.replan === true &&
        command.action === 'resume' &&
        digest(readerCommandText(command)) === command.hash &&
        retained !== undefined &&
        intent !== undefined &&
        same(intent.input, prior) &&
        same(intent.command, command) &&
        same(intent.authorization, transition.authorization) &&
        same(retained.command, command) &&
        same(retained.next, input) &&
        same(humanExecutionNext(prior, proposal, transitionRef), input),
      'task-continuation-binding',
    );
    store.read(command.source);
    store.read(intent.authorization);
  }
  function executionPath(input: AnyManagedTaskInput, id: string) {
    return join(
      dirname(dirname(context(input).gate.directory)),
      'execution-commands',
      id + '.json',
    );
  }
  function executionJournal(input: AnyManagedTaskInput) {
    const directory = dirname(executionPath(input, 'record')),
      intentDirectory = join(dirname(directory), 'execution-command-intents');
    const records: { command: PayloadReaderCommand; ack: ReaderCommandAck; next: unknown }[] = [];
    for (const name of existsSync(directory) ? readdirSync(directory).sort() : []) {
      const body = object(JSON.parse(readPrivateFile(join(directory, name)).toString())),
        command = parsePayloadReaderCommand(body.command),
        ack = object(body.ack),
        authorization = controlRef(ack.authorization),
        proof = read(authorization);
      requireContract(
        name === command.commandId + '.json' &&
          ack.commandId === command.commandId &&
          ack.hash === command.hash &&
          ack.revision === command.expectedRevision + 1 &&
          same(proof.command, command) &&
          [
            'task-execution-interruption',
            'task-execution-continuation',
            'task-integrated-recheck',
            'task-human-execution-control',
          ].includes(String(proof.kind)),
        'task-command-receipt-invalid',
      );
      records.push({
        command,
        ack: {
          commandId: command.commandId,
          hash: command.hash,
          revision: Number(ack.revision),
          authorization,
        },
        next: body.next,
      });
    }
    records.sort((a, b) => a.ack.revision - b.ack.revision);
    requireContract(
      records.every((record, index) => record.ack.revision === index + 1),
      'task-command-history-conflict',
    );
    const intents: {
      input: AnyManagedTaskInput;
      command: PayloadReaderCommand;
      authorization: ArtifactRef;
    }[] = [];
    for (const name of existsSync(intentDirectory)
      ? readdirSync(intentDirectory).sort(
          (a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]),
        )
      : []) {
      const body = object(JSON.parse(readPrivateFile(join(intentDirectory, name)).toString())),
        command = parsePayloadReaderCommand(body.command),
        prior = parseLocalTask(body.input),
        authorization = controlRef(body.authorization);
      requireContract(
        (prior.schemaVersion === 11 || prior.schemaVersion === 12) &&
          prior.schemaVersion === input.schemaVersion &&
          localTaskKey(prior) === localTaskKey(input) &&
          name === command.expectedRevision + 1 + '.json',
        'task-command-history-conflict',
      );
      requireContract(
        same(
          { ...prior.admission.preparation, revision: input.admission.preparation.revision },
          input.admission.preparation,
        ) &&
          same(prior.executor, input.executor) &&
          prior.baseline === input.baseline,
        'task-command-target-mismatch',
      );
      if (prior.schemaVersion === 12)
        taskHumanExecutionCommand(prior, command, command.expectedRevision);
      else taskExecutionCommand(prior, command, command.expectedRevision);
      store.read(authorization);
      intents.push({ input: prior, command, authorization });
    }
    for (const record of records) {
      const intent = intents[record.command.expectedRevision],
        proof = read(record.ack.authorization);
      requireContract(
        intent !== undefined && same(proof.authorization, intent.authorization),
        'task-command-receipt-invalid',
      );
      if (proof.kind === 'task-human-execution-control') {
        requireContract(intent.input.schemaVersion === 12, 'task-command-receipt-invalid');
        const captured = object(proof.context),
          state = object(captured.state),
          current = object(state.current),
          manifest = object(current.manifest),
          proposal = humanExecutionProposal(intent.input, record.command);
        requireContract(
          same(captured.input, intent.input) &&
            same(object(captured.technical).input, intent.input) &&
            state.closed === false &&
            same(manifest.target, taskControlTarget(intent.input)) &&
            same(manifest.declaration, intent.input.startAdmission) &&
            same(proof.next, proposal.next) &&
            proof.replan === proposal.replan &&
            same(record.next, humanExecutionNext(intent.input, proposal, record.ack.authorization)),
          'task-command-receipt-invalid',
        );
      } else if (proof.kind === 'task-integrated-recheck') {
        const payload = executionResumePayload(intent.input, read(record.command.payload));
        requireContract(
          intent.input.schemaVersion === 12 &&
            record.command.action === 'resume' &&
            record.command.attempt === intent.input.continuation.attempt &&
            same(record.next, intent.input) &&
            same(payload.held, proof.held) &&
            same(payload.admission, intent.input.admission),
          'task-command-receipt-invalid',
        );
      } else if (record.command.action === 'resume') {
        taskExecutionCommand(intent.input, record.command, record.command.expectedRevision);
        const payload = executionResumePayload(intent.input, read(record.command.payload));
        requireContract(
          proof.kind === 'task-execution-continuation' &&
            same(proof.held, payload.held) &&
            same(proof.admission, payload.admission) &&
            (payload.schemaVersion !== 2 || same(proof.startAdmission, payload.startAdmission)) &&
            same(
              record.next,
              executionNext(
                intent.input,
                payload,
                record.command.attempt,
                record.ack.authorization,
              ),
            ),
          'task-command-receipt-invalid',
        );
      } else
        requireContract(
          proof.kind === 'task-execution-interruption' &&
            record.next === null &&
            proof.reason === taskInterruption(read(record.command.payload)),
          'task-command-receipt-invalid',
        );
    }
    requireContract(
      intents.length >= records.length &&
        intents.length <= records.length + 1 &&
        intents.every(
          (intent, index) =>
            intent.command.expectedRevision === index &&
            (index >= records.length ||
              (same(intent.command, records[index]!.command) &&
                same(read(records[index]!.ack.authorization).input, intent.input))),
        ),
      'task-command-history-conflict',
    );
    return { records, intents, pending: intents[records.length] ?? null };
  }
  async function executionAuthority(
    input: AnyManagedTaskInput,
    command: PayloadReaderCommand,
    revision: number,
    humanWait = false,
  ) {
    Context.current().cancellationSignal.throwIfAborted();
    if (humanWait && input.schemaVersion === 12)
      taskHumanExecutionCommand(input, command, revision);
    else taskExecutionCommand(input, command, revision);
    const existing = executionJournal(input).intents[revision];
    if (existing !== undefined) {
      requireContract(
        same(existing.command, command) && same(existing.input, input),
        'task-command-pending',
      );
    }
    requireContract(
      host.authority !== undefined && digest(readerCommandText(command)) === command.hash,
      'task-human-authorization-required',
    );
    if (humanWait && input.schemaVersion === 12 && existing !== undefined) {
      store.read(command.source);
      store.read(existing.authorization);
      return existing.authorization;
    }
    const proof = await host.authority.verify(command);
    Context.current().cancellationSignal.throwIfAborted();
    requireContract(
      proof.origin === (host.executionCommandOrigin ?? 'human') &&
        proof.author === command.author &&
        proof.hash === command.hash,
      'task-human-authorization-required',
    );
    store.read(proof.proof);
    requireContract(
      existing === undefined || same(existing.authorization, proof.proof),
      'task-human-authorization-required',
    );
    return proof.proof;
  }
  function reserveExecutionCommand(
    input: AnyManagedTaskInput,
    command: PayloadReaderCommand,
    revision: number,
    proof: ArtifactRef,
  ) {
    Context.current().cancellationSignal.throwIfAborted();
    const journal = executionJournal(input);
    requireContract(
      journal.records.length === revision &&
        (journal.pending === null ||
          (same(journal.pending.command, command) && same(journal.pending.authorization, proof))),
      'task-command-pending',
    );
    store.read(proof);
    const directory = privateDirectory(
        join(
          dirname(dirname(executionPath(input, command.commandId))),
          'execution-command-intents',
        ),
      ),
      path = join(directory, revision + 1 + '.json');
    try {
      publishFile(path, Buffer.from(JSON.stringify({ input, command, authorization: proof })));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const retained = object(JSON.parse(readPrivateFile(path).toString()));
    requireContract(
      same(retained.command, command) && same(retained.input, input),
      'task-command-pending',
    );
    const authorization = controlRef(retained.authorization);
    store.read(authorization);
    return authorization;
  }
  function retainExecutionCommand(
    input: AnyManagedTaskInput,
    command: PayloadReaderCommand,
    ack: ReaderCommandAck,
    next: AnyManagedTaskInput | null,
  ) {
    const path = executionPath(input, command.commandId);
    privateDirectory(dirname(path));
    once(path, { command, ack, next });
  }
  const executionControls: TaskExecutionControls &
    Pick<TaskHumanActivities, 'controlTaskHumanExecution'> = {
    async controlTaskHumanExecution(value, raw, revision) {
      const captured = structuredClone(value),
        parsed = executionInput(captured.input);
      requireContract(parsed.schemaVersion === 12, 'human-input-required');
      const input = parsed;
      const command = parsePayloadReaderCommand(raw),
        previous = await executionControls.findTaskExecutionCommand(input, command);
      if (previous !== null) {
        const record = object(
            JSON.parse(readPrivateFile(executionPath(input, command.commandId)).toString()),
          ),
          proof = read(previous.authorization),
          next = executionInput(record.next);
        requireContract(
          proof.kind === 'task-human-execution-control' && next.schemaVersion === 12,
          'task-command-receipt-invalid',
        );
        return { ack: previous, input: next };
      }
      taskHumanExecutionCommand(input, command, revision);
      const admitted = await startAdmission(input, 'retained');
      requireContract(
        !captured.state.closed &&
          same(captured.state.current, admitted.manifest) &&
          same(captured.technical.input, input) &&
          same(captured.state.current.manifest.target, taskControlTarget(input)),
        'human-control-context',
      );
      const verified = await executionAuthority(input, command, revision, true),
        proposal = humanExecutionProposal(input, command),
        proposed = proposal.replan
          ? executionInput({
              ...input,
              admission: proposal.next.admission,
              startAdmission: proposal.next.startAdmission,
            })
          : input;
      requireContract(proposed.schemaVersion === 12, 'human-input-required');
      const declared = proposal.replan ? await executionDeclaration(proposed, input) : null,
        checkPlan = proposal.replan ? executionPlanScope(input, proposed.admission) : null,
        entry = context(input),
        stopped = controlRef(captured.technical.stopped);
      function commit(unchanged: () => void) {
        Context.current().cancellationSignal.throwIfAborted();
        unchanged();
        requireContract(
          same(captured, value) &&
            !existsSync(join(entry.gate.directory, 'done.json')) &&
            !existsSync(join(entry.gate.directory, 'completion-intent.json')),
          'human-control-context',
        );
        const grant = readPrivateFile(join(entry.gate.directory, 'grant.json')),
          reservation = taskGateBinding(
            input,
            files.binding(registration.workspaceRoot),
            profile,
            registration.artifactRoot,
            instance,
          ).reservation;
        requireContract(
          !existsSync(reservation) || readPrivateFile(reservation).equals(grant),
          'task-source-reserved',
        );
        if (declared !== null) {
          const card = readProjectFile(
            registration.workspaceRoot,
            proposed.admission.preparation.card,
          );
          requireContract(
            digest(card) === declared.admission.card.sha256 &&
              card.length === declared.admission.card.bytes,
            'task-start-card-changed',
          );
        }
        checkPlan?.();
        store.read(command.payload);
        const authorization = reserveExecutionCommand(input, command, revision, verified),
          transition = save({
            kind: 'task-human-execution-control',
            context: captured,
            input,
            command,
            authorization,
            next: proposal.next,
            replan: proposal.replan,
          }),
          next = humanExecutionNext(input, proposal, transition),
          ack = {
            commandId: command.commandId,
            hash: command.hash,
            revision: revision + 1,
            authorization: transition,
          };
        retainExecutionCommand(input, command, ack, next);
        return { ack, input: next };
      }
      async function observed(grant: Buffer) {
        const inspection = await inspectStoppedTask({
          input,
          source: files.binding(registration.workspaceRoot),
          artifacts: files.binding(registration.artifactRoot),
          directory: entry.gate.directory,
          grant,
          processes,
        });
        requireContract(same(inspection.outcome, stopped), 'task-held-stop-unconfirmed');
        await inspection.recheck();
        return () => commit(inspection.assertUnchanged);
      }
      return entry.gate.recordStopped(observed);
    },
    async saveTaskExecutionCheckpoint(value) {
      Context.current().cancellationSignal.throwIfAborted();
      const initial = parseLocalTask(value.initial),
        input = parseLocalTask(value.input);
      requireContract(
        initial.schemaVersion === 11 &&
          input.schemaVersion === 11 &&
          initial.continuation.attempt === 0 &&
          localTaskKey(initial) === localTaskKey(input) &&
          Number.isSafeInteger(value.revision) &&
          value.revision >= 0 &&
          Number.isSafeInteger(value.beganAt) &&
          value.beganAt >= 0,
        'task-checkpoint-invalid',
      );
      const entry = context(input),
        held = controlRef(value.held),
        record = read(held),
        origin = read(
          controlRef(
            JSON.parse(
              readPrivateFile(
                join(context(initial).gate.directory, 'execution-admission.json'),
              ).toString(),
            ),
          ),
        );
      requireContract(
        origin.kind === 'task-execution-admission' && same(origin.input, initial),
        'task-checkpoint-invalid',
      );
      requireContract(
        record.kind === 'task-execution-held' &&
          same(record.input, input) &&
          same(
            controlRef(
              JSON.parse(
                readPrivateFile(join(entry.gate.directory, 'execution-held.json')).toString(),
              ),
            ),
            held,
          ),
        'task-checkpoint-held-binding',
      );
      const stopped = controlRef(record.stopped),
        stop = read(stopped);
      requireContract(
        stop.confirmed === true &&
          same(stop.input, input) &&
          same(
            controlRef(
              JSON.parse(readPrivateFile(join(entry.gate.directory, 'stopped.json')).toString()),
            ),
            stopped,
          ),
        'task-held-stop-unconfirmed',
      );
      const journal = executionJournal(input);
      requireContract(
        journal.pending === null && journal.records.length === value.revision,
        'task-command-pending',
      );
      const budget = await executionControls.captureTaskExecutionBudget(
        input,
        controlRef(value.budget.manifest),
      );
      if (value.previous !== null) {
        const prior = read(controlRef(value.previous));
        requireContract(
          prior.kind === 'task-execution-checkpoint' &&
            same(prior.initial, initial) &&
            prior.beganAt === value.beganAt &&
            Number(prior.revision) <= value.revision,
          'task-checkpoint-prefix-invalid',
        );
        await executionControls.captureTaskExecutionBudget(
          input,
          controlRef(object(prior.budget).manifest),
        );
      }
      for (const ref of [...value.history, ...value.commands]) store.read(controlRef(ref));
      requireContract(same(executionJournal(input), journal), 'task-command-pending');
      Context.current().cancellationSignal.throwIfAborted();
      const checkpoint = save({
        schemaVersion: 1,
        kind: 'task-execution-checkpoint',
        initial,
        input,
        revision: value.revision,
        held,
        history: value.history,
        commands: value.commands,
        previous: value.previous,
        budget,
        beganAt: value.beganAt,
        diagnostics: taskExecutionDiagnostics(value.diagnostics),
        journal: save(journal),
      });
      const directory = privateDirectory(
        join(dirname(dirname(entry.gate.directory)), 'execution-checkpoints'),
      );
      once(join(directory, checkpoint.sha256 + '.json'), checkpoint);
      return checkpoint;
    },
    async loadTaskExecutionCheckpoint(initial, checkpoint) {
      const record = read(controlRef(checkpoint)),
        input = parseLocalTask(record.input);
      requireContract(
        record.schemaVersion === 1 &&
          record.kind === 'task-execution-checkpoint' &&
          same(parseLocalTask(record.initial), parseLocalTask(initial)) &&
          input.schemaVersion === 11 &&
          localTaskKey(input) === localTaskKey(initial),
        'task-checkpoint-invalid',
      );
      const entry = context(input),
        path = join(
          dirname(dirname(entry.gate.directory)),
          'execution-checkpoints',
          checkpoint.sha256 + '.json',
        );
      requireContract(
        same(controlRef(JSON.parse(readPrivateFile(path).toString())), checkpoint),
        'task-checkpoint-unconfirmed',
      );
      const journal = executionJournal(input),
        journalRef = controlRef(record.journal),
        bytes = Buffer.from(JSON.stringify(journal));
      store.read(journalRef);
      requireContract(
        journal.pending === null &&
          journal.records.length === record.revision &&
          digest(bytes) === journalRef.sha256 &&
          bytes.length === journalRef.bytes,
        'task-command-history-conflict',
      );
      const held = controlRef(record.held),
        body = read(held);
      requireContract(
        body.kind === 'task-execution-held' &&
          same(body.input, input) &&
          same(
            controlRef(
              JSON.parse(
                readPrivateFile(join(entry.gate.directory, 'execution-held.json')).toString(),
              ),
            ),
            held,
          ),
        'task-checkpoint-held-binding',
      );
      const stopped = controlRef(body.stopped),
        stop = read(stopped);
      requireContract(
        stop.confirmed === true &&
          same(stop.input, input) &&
          same(
            controlRef(
              JSON.parse(readPrivateFile(join(entry.gate.directory, 'stopped.json')).toString()),
            ),
            stopped,
          ) &&
          !existsSync(join(entry.gate.directory, 'done.json')),
        'task-held-stop-unconfirmed',
      );
      requireContract(
        Number.isSafeInteger(record.beganAt) &&
          Number(record.beganAt) >= 0 &&
          Array.isArray(record.history) &&
          Array.isArray(record.commands),
        'task-checkpoint-invalid',
      );
      const budget = await executionControls.captureTaskExecutionBudget(
          input,
          controlRef(object(record.budget).manifest),
        ),
        history = record.history.map(controlRef),
        commands = record.commands.map(controlRef);
      for (const ref of [...history, ...commands]) store.read(ref);
      const result: TaskExecutionCheckpoint = {
        initial,
        input,
        held,
        revision: journal.records.length,
        history,
        commands,
        previous: record.previous === null ? null : controlRef(record.previous),
        budget,
        beganAt: Number(record.beganAt),
        diagnostics: taskExecutionDiagnostics(record.diagnostics),
      };
      return { ...result, stop: stopped };
    },
    async captureTaskExecutionBudget(input, previous) {
      requireContract(
        (input.schemaVersion === 11 || input.schemaVersion === 12) && binding?.budget !== undefined,
        'task-budget-observer-unavailable',
      );
      context(input);
      return binding.budget(input, previous);
    },
    async prepareTaskExecution(input) {
      requireContract(
        input.schemaVersion === 11 || input.schemaVersion === 12,
        'task-execution-input-required',
      );
      const entry = context(input);
      requireContract(host.authority !== undefined, 'task-human-authority-required');
      const bytes = readProjectFile(registration.workspaceRoot, input.admission.plan.path);
      requireContract(digest(bytes) === input.admission.plan.sha256, 'substantial-plan-changed');
      parseSubstantialPlan(JSON.parse(bytes.toString()));
      const ref = save({
        kind: 'task-execution-admission',
        input: entry.input,
        plan: store.publish(bytes),
      });
      once(join(entry.gate.directory, 'execution-admission.json'), ref);
      return ref;
    },
    async findTaskExecutionCommand(input, value) {
      requireContract(
        input.schemaVersion === 11 || input.schemaVersion === 12,
        'task-execution-input-required',
      );
      const command = parsePayloadReaderCommand(value),
        journal = executionJournal(input),
        prior = journal.records.find((record) => record.command.commandId === command.commandId);
      if (prior !== undefined) {
        requireContract(same(prior.command, command), 'task-command-id-conflict');
        return prior.ack;
      }
      requireContract(
        journal.pending === null || same(journal.pending.command, command),
        'task-command-pending',
      );
      requireContract(
        command.expectedRevision === journal.records.length,
        'task-command-history-conflict',
      );
      return null;
    },
    async interruptTaskExecution(input, value, revision) {
      const command = taskExecutionCommand(input, value, revision);
      requireContract(command.action !== 'resume', 'task-command-action');
      const previous = await executionControls.findTaskExecutionCommand(input, command);
      if (previous !== null) return previous;
      const entry = context(input),
        retained = entry.gate.admission().mode === 'retained',
        verified = await executionAuthority(input, command, revision),
        reason = taskInterruption(read(command.payload));
      requireContract(!existsSync(join(entry.gate.directory, 'done.json')), 'task-already-closed');
      function record(revoke: (before: () => void) => void) {
        let request: ArtifactRef | null = null;
        revoke(() => {
          Context.current().cancellationSignal.throwIfAborted();
          requireContract(
            !existsSync(join(entry.gate.directory, 'done.json')),
            'task-already-closed',
          );
          const authorization = reserveExecutionCommand(input, command, revision, verified);
          request = save({
            kind: 'task-execution-interruption',
            input: entry.input,
            command,
            authorization,
            reason,
          });
          const interruptions = privateDirectory(join(entry.gate.directory, 'interruptions'));
          once(join(interruptions, command.commandId + '.json'), { command, request });
        });
        const ack = {
          commandId: command.commandId,
          hash: command.hash,
          revision: revision + 1,
          authorization: controlRef(request),
        };
        retainExecutionCommand(input, command, ack, null);
        return ack;
      }
      if (retained) {
        requireContract(command.action === 'cancel', 'task-retained-cancel-required');
        return entry.gate.recordRetainedStop(async (grant) => {
          const path = join(entry.gate.directory, 'execution-held.json'),
            heldBytes = readPrivateFile(path),
            held = read(controlRef(JSON.parse(heldBytes.toString()))),
            stopped = controlRef(held.stopped);
          requireContract(
            held.kind === 'task-execution-held' && same(held.input, input),
            'task-held-binding',
          );
          const observed = await inspectStoppedTask({
            input,
            source: files.binding(registration.workspaceRoot),
            artifacts: files.binding(registration.artifactRoot),
            directory: entry.gate.directory,
            grant,
            processes,
          });
          requireContract(same(observed.outcome, stopped), 'task-held-stop-unconfirmed');
          await observed.recheck();
          return () => {
            Context.current().cancellationSignal.throwIfAborted();
            observed.assertUnchanged();
            requireContract(readPrivateFile(path).equals(heldBytes), 'task-held-binding');
            return record((before) => before());
          };
        });
      }
      return record((before) => entry.gate.freeze(before));
    },
    async holdTaskExecution(input, progress, stopped, reason, command) {
      requireContract(
        input.schemaVersion === 11 || input.schemaVersion === 12,
        'task-execution-input-required',
      );
      const entry = context(input),
        done = join(entry.gate.directory, 'done.json');
      if (existsSync(done)) {
        if (input.schemaVersion === 12) requireTaskHumanCompletionSeal(registration, input);
        const outcome = object(JSON.parse(readPrivateFile(done).toString())),
          result = controlRef(outcome.result),
          projection = controlRef(outcome.projection),
          body = read(result);
        requireContract(
          outcome.status === 'done' &&
            body.kind === 'local-task-result' &&
            body.complete === true &&
            same(body.input, input),
          'task-completion-binding',
        );
        store.read(projection);
        return { status: 'done', result, projection };
      }
      requireContract(
        same(
          controlRef(
            JSON.parse(readPrivateFile(join(entry.gate.directory, 'stopped.json')).toString()),
          ),
          stopped,
        ),
        'task-held-stop-unconfirmed',
      );
      const stop = read(stopped);
      requireContract(
        stop.confirmed === true && same(stop.input, input),
        'task-held-stop-unconfirmed',
      );
      for (const ref of progress.records) store.read(ref);
      if (progress.snapshot !== null)
        requireContract(
          same(
            controlRef(
              JSON.parse(readPrivateFile(join(entry.gate.directory, 'snapshot.json')).toString()),
            ),
            progress.snapshot,
          ),
          'task-held-snapshot-binding',
        );
      const held = save({
        kind: 'task-execution-held',
        input: entry.input,
        progress,
        stopped,
        reason,
        command,
      });
      once(join(entry.gate.directory, 'execution-held.json'), held);
      return { status: 'held', held };
    },
    async resumeTaskExecution(input, held, value, revision) {
      const command = taskExecutionCommand(input, value, revision);
      requireContract(command.action === 'resume', 'task-command-action');
      const previous = await executionControls.findTaskExecutionCommand(input, command);
      if (previous !== null) {
        const record = object(
            JSON.parse(readPrivateFile(executionPath(input, command.commandId)).toString()),
          ),
          next = parseLocalTask(record.next);
        requireContract(
          (next.schemaVersion === 11 || next.schemaVersion === 12) &&
            next.schemaVersion === input.schemaVersion,
          'task-command-receipt-invalid',
        );
        return { input: next, ack: previous };
      }
      const entry = context(input);
      function heldStop() {
        const record = read(held);
        requireContract(
          record.kind === 'task-execution-held' &&
            same(record.input, input) &&
            same(
              controlRef(
                JSON.parse(
                  readPrivateFile(join(entry.gate.directory, 'execution-held.json')).toString(),
                ),
              ),
              held,
            ),
          'task-held-binding',
        );
        const stopped = controlRef(record.stopped),
          stop = read(stopped);
        requireContract(
          stop.confirmed === true &&
            same(stop.input, input) &&
            same(
              controlRef(
                JSON.parse(readPrivateFile(join(entry.gate.directory, 'stopped.json')).toString()),
              ),
              stopped,
            ) &&
            !existsSync(join(entry.gate.directory, 'done.json')),
          'task-held-stop-unconfirmed',
        );
        return stopped;
      }
      const stopped = heldStop();
      const verified = await executionAuthority(input, command, revision),
        payload = executionResumePayload(input, read(command.payload));
      requireContract(same(payload.held, held), 'task-resume-held-changed');
      const proposed = executionInput({
        ...input,
        admission: payload.admission,
        ...(payload.schemaVersion === 2 ? { startAdmission: payload.startAdmission } : {}),
      });
      const declared =
        proposed.schemaVersion === 12
          ? await executionDeclaration(
              proposed,
              proposed.admission.preparation.revision === input.admission.preparation.revision
                ? undefined
                : (input as HumanManagedTaskInput),
            )
          : null;
      const sealPath = join(entry.gate.directory, 'execution-admission.json'),
        sealBytes = readPrivateFile(sealPath),
        sealRef = controlRef(JSON.parse(sealBytes.toString())),
        seal = read(sealRef),
        before = parseSubstantialPlan(read(controlRef(seal.plan))),
        bytes = readProjectFile(registration.workspaceRoot, payload.admission.plan.path);
      requireContract(
        seal.kind === 'task-execution-admission' &&
          same(seal.input, input) &&
          digest(bytes) === payload.admission.plan.sha256,
        'task-execution-admission-required',
      );
      const next = parseSubstantialPlan(JSON.parse(bytes.toString()));
      requireContract(
        next.plan_id === before.plan_id &&
          next.paths.every((path) => taskPathAllowed(before.paths, path)),
        'task-resume-writer-scope-changed',
      );
      if (command.attempt === input.continuation.attempt) {
        requireContract(
          input.schemaVersion === 12 && same(proposed, input),
          'task-recheck-admission-changed',
        );
        integratedFailure(input, held);
      }
      function resume() {
        const authorization = reserveExecutionCommand(input, command, revision, verified);
        if (command.attempt === input.continuation.attempt) {
          const transition = save({
            kind: 'task-integrated-recheck',
            input,
            held,
            command,
            authorization,
          });
          const ack = {
            commandId: command.commandId,
            hash: command.hash,
            revision: revision + 1,
            authorization: transition,
          };
          retainExecutionCommand(input, command, ack, input);
          return { input, ack };
        }
        const transition = save({
          kind: 'task-execution-continuation',
          input: entry.input,
          held,
          command,
          authorization,
          admission: payload.admission,
          ...(payload.schemaVersion === 2 ? { startAdmission: payload.startAdmission } : {}),
          invalidated: [
            'planning',
            'baseline',
            'writer',
            'candidate-checks',
            'integration',
            'integrated-checks',
            'acceptance',
            'result',
          ],
        });
        const resumed = executionNext(input, payload, command.attempt, transition);
        const ack = {
          commandId: command.commandId,
          hash: command.hash,
          revision: revision + 1,
          authorization: transition,
        };
        retainExecutionCommand(input, command, ack, resumed);
        return { input: resumed, ack };
      }
      function declaredCurrent() {
        if (declared !== null) {
          const card = readProjectFile(
            registration.workspaceRoot,
            proposed.admission.preparation.card,
          );
          requireContract(
            digest(card) === declared.admission.card.sha256 &&
              card.length === declared.admission.card.bytes,
            'task-start-card-changed',
          );
        }
      }
      if (entry.gate.admission().mode === 'owned') {
        declaredCurrent();
        return resume();
      }
      return entry.gate.recordRetainedStop(async (grant) => {
        const observed = await inspectStoppedTask({
          input,
          source: files.binding(registration.workspaceRoot),
          artifacts: files.binding(registration.artifactRoot),
          directory: entry.gate.directory,
          grant,
          processes,
        });
        requireContract(same(observed.outcome, stopped), 'task-held-stop-unconfirmed');
        await observed.recheck();
        return () => {
          observed.assertUnchanged();
          declaredCurrent();
          heldStop();
          store.read(sealRef);
          store.read(controlRef(seal.plan));
          store.read(command.payload);
          requireContract(
            readPrivateFile(sealPath).equals(sealBytes) &&
              readProjectFile(registration.workspaceRoot, payload.admission.plan.path).equals(
                bytes,
              ),
            'task-execution-admission-required',
          );
          return resume();
        };
      });
    },
  };
  const humanActivities = taskHumanActivities(registration, {
    ...humanActivityScope,
    ...(host.humanAuthority === undefined ? {} : { authority: host.humanAuthority }),
    declaration: startAdmission,
    async technical(value) {
      await inspectTaskHumanTechnical(registration, profile, disabledServers, processes, value);
    },
    control(value, command, revision) {
      return executionControls.controlTaskHumanExecution(value, command, revision);
    },
    budget(input, previous) {
      return executionControls.captureTaskExecutionBudget(input, previous);
    },
    async finish(request, seal) {
      const { input, technical } = request;
      requireTaskHumanCompletionSeal(registration, input, {
        snapshot: technical.snapshot,
        packet: technical.packet,
        review: technical.acceptance,
        seal,
        producer: humanActivityScope,
      });
      const retained = await inspectTaskHumanTechnical(
        registration,
        profile,
        disabledServers,
        processes,
        technical,
      );
      const done = join(retained.directory, 'done.json');
      if (existsSync(done)) {
        const commit = completion(
            input,
            technical.snapshot,
            technical.packet,
            technical.acceptance,
          ),
          outcome = {
            status: 'done' as const,
            result: controlRef(commit.result),
            projection: controlRef(commit.projection),
          };
        requireContract(
          same(commit.humanCompletion, seal) &&
            same(read(controlRef(commit.result)).humanCompletion, seal) &&
            same(JSON.parse(readPrivateFile(done).toString()), outcome),
          'human-completion-conflict',
        );
        return outcome;
      }
      if (!existsSync(join(retained.directory, 'completion-intent.json')))
        await startAdmission(input, 'current');
      context(input);
      const gate = taskHumanCompletionGate(
        input,
        retained.source,
        profile,
        registration.artifactRoot,
        technical.stopped,
        seal,
        binding?.owner,
      );
      await retained.inspection.recheck();
      gate.acquire();
      try {
        await retained.inspection.recheck();
        return await finishTechnical(
          input,
          technical.snapshot,
          technical.packet,
          technical.acceptance,
          undefined,
          undefined,
          { ...gate, seal },
        );
      } finally {
        gate.release();
      }
    },
  });
  if (binding?.continued !== undefined) context(binding.continued.input);
  const guardedControls = admittedActivities(controls);
  return {
    activities: admittedActivities(activities),
    controls: guardedControls,
    continuationControls: admittedActivities(continuationControls),
    executionControls: admittedActivities<TaskExecutionControls>(executionControls),
    humanActivities: admittedActivities(humanActivities),
    async stopAll() {
      phase = 'stopping';
      for (const entry of contexts.values()) await guardedControls.stopLocalTask(entry.input);
      phase = 'stopped';
    },
  };
}
