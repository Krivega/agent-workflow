import { Context } from '@temporalio/activity';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { ArtifactRef, LocalProjectRegistration } from '../contracts/preparation.js';
import type { HumanManagedTaskInput } from '../contracts/localTask.js';
import type {
  BoundTaskHumanManifest,
  TaskHumanActivities,
  TaskHumanAuthority,
  TaskHumanCommandContext,
  TaskHumanExecutionCheckpoint,
  TaskHumanFinishRequest,
  TaskHumanState,
  TaskHumanTechnicalCompletion,
} from '../contracts/taskHuman.js';
import type { VerifiedStartAdmission } from '../contracts/taskStartAdmission.js';
import type { PayloadReaderCommand, ReaderCommandAck } from '../contracts/readerControl.js';
import type { TaskExecutionBudget } from '../contracts/taskExecution.js';
import { object, requireContract } from '../contracts/project.js';
import { parseLocalTask, localTaskKey } from '../policy/localTask.js';
import { controlRef } from '../policy/readerControl.js';
import {
  advanceTaskHumanRequirements,
  applyTaskHumanCommand,
  createTaskHumanState,
  parseBoundTaskHumanManifest,
  parseTaskHumanCommand,
  taskHumanBlockers,
  taskHumanCanonical,
  taskHumanCommandText,
} from '../policy/taskHuman.js';
import { taskExecutionDiagnostics } from '../policy/taskExecution.js';
import {
  artifactStore,
  digest,
  privateDirectory,
  publishFile,
  readPrivateFile,
} from '../adapters/artifacts/files.js';
import { taskBackendHome } from '../adapters/project/taskBackend.js';

export interface TaskHumanActivityPorts {
  taskQueue: string;
  namespace: string;
  authority?: TaskHumanAuthority;
  declaration(
    input: HumanManagedTaskInput,
    card: 'current' | 'retained',
  ): Promise<VerifiedStartAdmission>;
  technical(value: TaskHumanTechnicalCompletion): Promise<void>;
  finish(
    request: TaskHumanFinishRequest,
    seal: ArtifactRef,
  ): Promise<{
    status: 'done';
    result: ArtifactRef;
    projection: ArtifactRef;
  }>;
  control(
    context: TaskHumanCommandContext,
    command: PayloadReaderCommand,
    revision: number,
  ): Promise<{
    ack: ReaderCommandAck;
    input: HumanManagedTaskInput;
  }>;
  budget(input: HumanManagedTaskInput, previous: ArtifactRef | null): Promise<TaskExecutionBudget>;
}

/** Immutable source/intent receipts only; the mutable human lifecycle belongs to the Workflow. */
export function taskHumanActivities(
  registration: LocalProjectRegistration,
  ports: TaskHumanActivityPorts,
): TaskHumanActivities {
  const store = artifactStore(registration.artifactRoot, { existingOnly: true });
  const read = (ref: ArtifactRef) => object(JSON.parse(store.read(controlRef(ref)).toString()));
  const save = (value: unknown) => store.publish(Buffer.from(taskHumanCanonical(value)));
  function input(value: unknown): HumanManagedTaskInput {
    const parsed = parseLocalTask(value);
    requireContract(parsed.schemaVersion === 12, 'human-input-required');
    return parsed;
  }
  function producer(name: string, value: HumanManagedTaskInput) {
    const context = Context.current(),
      info = context.info;
    context.cancellationSignal.throwIfAborted();
    requireContract(
      !info.isLocal &&
        info.workflowType === 'LocalTaskWorkflow' &&
        info.workflowExecution?.workflowId === localTaskKey(value) &&
        typeof info.workflowExecution.runId === 'string' &&
        info.workflowExecution.runId.length > 0 &&
        info.activityType === name &&
        info.taskQueue === ports.taskQueue &&
        info.namespace === ports.namespace,
      'human-activity-owner-unconfirmed',
    );
    return {
      workflowId: info.workflowExecution.workflowId,
      runId: info.workflowExecution.runId,
      activityId: info.activityId,
      activityType: info.activityType,
      workflowType: info.workflowType,
      isLocal: info.isLocal,
      taskQueue: info.taskQueue,
      namespace: info.namespace,
    };
  }
  function location(value: HumanManagedTaskInput, kind: string, name: string) {
    return join(
      taskBackendHome(registration.workspaceRoot),
      'tasks',
      digest(localTaskKey(value)),
      'human-' + kind,
      name + '.json',
    );
  }
  function retain(path: string, ref: ArtifactRef) {
    privateDirectory(join(path, '..'));
    const bytes = Buffer.from(JSON.stringify(ref));
    try {
      publishFile(path, bytes);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
    }
    requireContract(readPrivateFile(path).equals(bytes), 'human-receipt-conflict');
  }
  async function declared(value: HumanManagedTaskInput, card: 'current' | 'retained') {
    const checked = await ports.declaration(value, card);
    requireContract(same(checked.ref, value.startAdmission), 'human-start-admission-binding');
    const bound = parseBoundTaskHumanManifest(checked.manifest);
    requireContract(same(read(bound.ref), bound.manifest), 'human-manifest-bytes');
    if (bound.manifest.criteria.some((row) => row.kind === 'human' && row.applicable))
      requireContract(ports.authority !== undefined, 'human-authority-required');
    return bound;
  }
  function recordedProducer(value: unknown, name: string, current: HumanManagedTaskInput) {
    const record = object(value);
    requireContract(
      record.workflowId === localTaskKey(current) &&
        typeof record.runId === 'string' &&
        record.runId.length > 0 &&
        typeof record.activityId === 'string' &&
        record.activityId.length > 0 &&
        record.activityType === name &&
        record.workflowType === 'LocalTaskWorkflow' &&
        record.isLocal === false &&
        record.taskQueue === ports.taskQueue &&
        record.namespace === ports.namespace,
      'human-recorded-producer',
    );
  }
  async function humanState(
    current: HumanManagedTaskInput,
    value: TaskHumanState,
    closing = false,
  ) {
    const bound = await declared(current, 'retained');
    requireContract(same(value.current, bound), 'human-state-manifest');
    requireContract(
      value.schemaVersion === 1 &&
        typeof value.closed === 'boolean' &&
        Array.isArray(value.history) &&
        Number.isSafeInteger(value.revision) &&
        value.revision === value.history.length,
      'human-state-invalid',
    );
    let replay: TaskHumanState;
    if (value.history.length === 0) replay = createTaskHumanState(bound);
    else {
      const first = value.history[0]!;
      const initial =
        first.kind === 'requirements'
          ? parseBoundTaskHumanManifest({
              manifest: read(first.previousManifest),
              ref: first.previousManifest,
            })
          : (object(read(first.receipt.proof).context).state as unknown as TaskHumanState);
      replay =
        first.kind === 'requirements'
          ? createTaskHumanState(initial as BoundTaskHumanManifest)
          : createTaskHumanState((initial as TaskHumanState).current);
      const historic = input({
        ...current,
        startAdmission: replay.current.manifest.declaration,
        admission: {
          ...current.admission,
          preparation: {
            ...current.admission.preparation,
            revision: replay.current.manifest.target.requirementsRevision,
          },
        },
      });
      requireContract(
        same(replay.current, await declared(historic, 'retained')),
        'human-history-origin',
      );
    }
    for (const row of value.history) {
      requireContract(row.receipt.revision === replay.revision + 1, 'human-history-revision');
      if (row.kind === 'requirements') {
        const next = parseBoundTaskHumanManifest({
          manifest: read(row.nextManifest),
          ref: row.nextManifest,
        });
        const historic = input({
          ...current,
          startAdmission: next.manifest.declaration,
          admission: {
            ...current.admission,
            preparation: {
              ...current.admission.preparation,
              revision: next.manifest.target.requirementsRevision,
            },
          },
        });
        requireContract(
          same(next, await declared(historic, 'retained')) &&
            same(row.receipt.proof, next.ref) &&
            same(row.source, next.manifest.declaration) &&
            row.receipt.hash === next.ref.sha256,
          'human-requirements-proof',
        );
        replay = advanceTaskHumanRequirements(replay, {
          kind: 'verified-task-human-requirements',
          commandId: row.receipt.commandId,
          hash: row.receipt.hash,
          previousManifest: row.previousManifest,
          next,
          expectedRevision: replay.revision,
          source: row.source,
          proof: row.receipt.proof,
        });
      } else {
        const proof = read(row.receipt.proof),
          original = proof.context as unknown as TaskHumanCommandContext;
        requireContract(
          proof.kind === 'task-human-command-proof' &&
            same(proof.command, row.command) &&
            same(original.state, replay),
          'human-command-proof-binding',
        );
        recordedProducer(proof.producer, 'verifyTaskHumanCommand', current);
        requireContract(ports.authority !== undefined, 'human-authority-required');
        const verified = await ports.authority.verify(original, row.command);
        requireContract(same(verified.proof, proof.authority), 'human-command-source-changed');
        const applied = applyTaskHumanCommand(replay, row.command, {
          ...verified,
          proof: row.receipt.proof,
        });
        requireContract(same(applied.receipt, row.receipt), 'human-history-receipt');
        replay = applied.state;
      }
    }
    requireContract(same({ ...replay, closed: value.closed }, value), 'human-history-state');
    if (closing)
      requireContract(
        value.closed && value.pending === null && taskHumanBlockers(value).length === 0,
        'human-gates-open',
      );
  }
  async function state(value: TaskHumanCommandContext, closing = false) {
    const current = input(value.input);
    await humanState(current, value.state, closing);
    requireContract(same(value.technical.input, current), 'human-technical-input');
    await ports.technical(value.technical);
    return current;
  }
  async function checkpoint(value: TaskHumanExecutionCheckpoint) {
    const initial = input(value.initial),
      current = input(value.input);
    requireContract(
      value.schemaVersion === 2 &&
        initial.continuation.attempt === 0 &&
        localTaskKey(initial) === localTaskKey(current) &&
        Number.isSafeInteger(value.revision) &&
        value.revision >= 0 &&
        Number.isSafeInteger(value.beganAt) &&
        value.beganAt >= 0 &&
        Array.isArray(value.history) &&
        Array.isArray(value.commands),
      'human-checkpoint-invalid',
    );
    await declared(current, 'retained');
    taskExecutionDiagnostics(value.diagnostics);
    for (const ref of [...value.history, ...value.commands]) store.read(controlRef(ref));
    if (value.wait.kind === 'human-gates') {
      requireContract(
        typeof value.wait.paused === 'boolean' && value.technical !== null,
        'human-checkpoint-technical-required',
      );
      await state({ input: current, state: value.humanState, technical: value.technical });
    } else {
      requireContract(value.wait.kind === 'execution-held', 'human-checkpoint-wait');
      requireContract(value.technical === null, 'human-checkpoint-held-technical');
      await humanState(current, value.humanState);
      const held = read(value.wait.held),
        stop = read(value.wait.stop);
      requireContract(
        same(held.input, current) &&
          same(held.stopped, value.wait.stop) &&
          stop.confirmed === true &&
          same(stop.input, current),
        'human-checkpoint-stop',
      );
    }
    if (value.previous !== null) {
      const previous = read(value.previous);
      requireContract(
        previous.kind === 'task-human-checkpoint' &&
          same(previous.initial, initial) &&
          previous.beganAt === value.beganAt &&
          Number(previous.revision) <= value.revision,
        'human-checkpoint-prefix',
      );
    }
    const budget = await ports.budget(current, value.budget.manifest);
    requireContract(
      budget.limit === value.budget.limit && budget.used >= value.budget.used,
      'human-checkpoint-budget',
    );
    return budget;
  }
  return {
    async prepareTaskHuman(raw) {
      const current = input(raw);
      producer('prepareTaskHuman', current);
      return declared(current, 'retained');
    },
    async verifyTaskHumanCommand(context, raw) {
      const current = input(context.input),
        origin = producer('verifyTaskHumanCommand', current);
      const witness = taskHumanCanonical(context);
      await state(context);
      requireContract(ports.authority !== undefined, 'human-authority-required');
      const command = parseTaskHumanCommand(raw);
      requireContract(digest(taskHumanCommandText(command)) === command.hash, 'human-command-hash');
      const verified = await ports.authority.verify(context, command);
      await declared(current, 'retained');
      producer('verifyTaskHumanCommand', current);
      requireContract(taskHumanCanonical(context) === witness, 'human-verification-stale');
      const proof = save({
        kind: 'task-human-command-proof',
        context,
        command,
        authority: verified.proof,
        producer: origin,
      });
      return { ...verified, proof };
    },
    async controlTaskHumanExecution(context, command, revision) {
      const current = input(context.input);
      producer('controlTaskHumanExecution', current);
      const witness = taskHumanCanonical(context);
      await state(context);
      producer('controlTaskHumanExecution', current);
      requireContract(taskHumanCanonical(context) === witness, 'human-verification-stale');
      return ports.control(context, command, revision);
    },
    async finishTaskHuman(request) {
      const current = input(request.input),
        origin = producer('finishTaskHuman', current);
      const witness = taskHumanCanonical(request);
      requireContract(
        request.schemaVersion === 1 &&
          request.kind === 'task-human-finish' &&
          request.expectedRevision === request.state.revision,
        'human-finish-request',
      );
      await state(request, true);
      producer('finishTaskHuman', current);
      requireContract(taskHumanCanonical(request) === witness, 'human-verification-stale');
      const intent = location(current, 'completion', request.technical.snapshot.sha256);
      const body = { kind: 'task-human-completion-seal', request, producer: origin };
      let seal: ArtifactRef;
      if (existsSync(intent)) {
        seal = controlRef(JSON.parse(readPrivateFile(intent).toString()));
        const previous = read(seal);
        requireContract(
          previous.kind === body.kind &&
            same(previous.request, request) &&
            object(previous.producer).workflowId === origin.workflowId,
          'human-completion-conflict',
        );
      } else {
        seal = save(body);
        retain(intent, seal);
      }
      await declared(current, 'retained');
      producer('finishTaskHuman', current);
      requireContract(taskHumanCanonical(request) === witness, 'human-verification-stale');
      return ports.finish(request, seal);
    },
    async saveTaskHumanCheckpoint(value) {
      const origin = producer('saveTaskHumanCheckpoint', input(value.input));
      const witness = taskHumanCanonical(value);
      requireContract(
        same(value.producer, { workflowId: origin.workflowId, runId: origin.runId }),
        'human-checkpoint-producer',
      );
      const budget = await checkpoint(value);
      producer('saveTaskHumanCheckpoint', input(value.input));
      requireContract(taskHumanCanonical(value) === witness, 'human-verification-stale');
      const ref = save({ ...value, budget, kind: 'task-human-checkpoint' });
      retain(location(value.input, 'checkpoints', ref.sha256), ref);
      return ref;
    },
    async loadTaskHumanCheckpoint(raw, ref, continuedFromRunId) {
      const initial = input(raw),
        origin = producer('loadTaskHumanCheckpoint', initial),
        record = read(ref);
      requireContract(
        record.kind === 'task-human-checkpoint' &&
          record.schemaVersion === 2 &&
          same(record.initial, initial) &&
          object(record.producer).workflowId === origin.workflowId &&
          object(record.producer).runId === continuedFromRunId &&
          continuedFromRunId.length > 0 &&
          continuedFromRunId !== origin.runId,
        'human-checkpoint-producer',
      );
      const { kind: ignored, ...value } = record;
      void ignored;
      const result = value as unknown as TaskHumanExecutionCheckpoint;
      requireContract(
        same(
          controlRef(
            JSON.parse(
              readPrivateFile(location(result.input, 'checkpoints', ref.sha256)).toString(),
            ),
          ),
          ref,
        ),
        'human-checkpoint-unconfirmed',
      );
      const budget = await checkpoint(result);
      return { ...result, budget };
    },
  };
}
