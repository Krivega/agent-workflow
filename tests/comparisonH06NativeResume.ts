import {
  readH06TemporalControlMode,
  verifyH06TemporalControlProof,
} from './comparisonH06TemporalAutonomousControls.js';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import {
  nativeHumanAuthorizationText,
  nativeReaderNotice,
} from '../src/adapters/codex/readerAuthority.js';
import { makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import type { ReaderCommandAck } from '../src/contracts/readerControl.js';
import { parseLocalTask } from '../src/policy/localTask.js';
import {
  controlRef,
  parsePayloadReaderCommand,
  readerCommandText,
} from '../src/policy/readerControl.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import {
  checkTaskExecutionResume,
  parseTaskExecutionResume,
  taskExecutionCommand,
} from '../src/policy/taskExecution.js';
import { h04Pin, readH04Pin, readH04Json } from './comparisonH04Contract.js';

/** Formats a proposal from retained artifacts. The live host still verifies authority and state. */
export function planH06NativeResume(value: unknown) {
  const request = object(value);
  exactFields(request, ['kind', 'artifactRoot', 'status', 'commandId']);
  requireContract(request.kind === 'comparison-h06-native-resume-plan', 'h06-resume-request');
  return planH06NativeResumeObservation(
    request.artifactRoot,
    JSON.parse(readH04Pin(h04Pin(request.status)).toString()),
    request.commandId,
  );
}

export function planH06NativeResumeObservation(
  artifactRoot: unknown,
  value: unknown,
  id: unknown,
  expectedPause?: ReaderCommandAck,
) {
  requireContract(
    typeof artifactRoot === 'string' && resolve(artifactRoot) === artifactRoot,
    'h06-resume-artifacts',
  );
  const commandId = identifier(id);
  const store = artifactStore(artifactRoot, { existingOnly: true });
  const read = (ref: unknown) => object(JSON.parse(store.read(controlRef(ref)).toString()));
  const observation = object(value);
  const status = object(observation.result);
  requireContract(
    observation.query === 'localTaskStatus' &&
      status.phase === 'waiting-human' &&
      status.waiting === true &&
      status.runId === observation.runId &&
      status.stopFailure === '' &&
      status.budgetFailure === '' &&
      status.checkpointFailure === '',
    'h06-resume-state-unconfirmed',
  );
  const runId = identifier(observation.runId);
  const held = controlRef(status.held);
  const record = read(held);
  const input = parseLocalTask(record.input);
  requireContract(
    record.kind === 'task-execution-held' && input.schemaVersion === 11,
    'h06-resume-held-binding',
  );
  const target = taskControlTarget(input);
  const revision = Number(status.revision);
  requireContract(
    target.workflowId === observation.workflowId &&
      status.attempt === input.continuation.attempt &&
      status.requirementsRevision === target.requirementsRevision &&
      status.revision === revision &&
      Number.isSafeInteger(revision) &&
      revision > 0 &&
      revision < Number.MAX_SAFE_INTEGER,
    'h06-resume-target-binding',
  );
  const budget = object(status.budget);
  requireContract(
    typeof budget.used === 'number' &&
      Number.isSafeInteger(budget.used) &&
      budget.used >= 0 &&
      typeof budget.limit === 'number' &&
      Number.isSafeInteger(budget.limit) &&
      budget.used < budget.limit,
    'h06-resume-budget-unconfirmed',
  );
  const manifest = read(budget.manifest);
  requireContract(
    manifest.kind === 'task-model-budget' &&
      manifest.schemaVersion === 1 &&
      manifest.limit === budget.limit &&
      Array.isArray(manifest.credits) &&
      manifest.credits.length === budget.used,
    'h06-resume-budget-binding',
  );

  const ack = object(record.command);
  const interruption = read(ack.authorization);
  const pause = taskExecutionCommand(input, interruption.command, revision - 1);
  requireContract(
    interruption.kind === 'task-execution-interruption' &&
      same(interruption.input, input) &&
      pause.action === 'pause' &&
      ack.revision === revision &&
      ack.commandId === pause.commandId &&
      ack.hash === pause.hash &&
      (expectedPause === undefined || same(ack, expectedPause)) &&
      Array.isArray(status.commands) &&
      status.commands.length === revision &&
      same(status.commands[revision - 1], ack.authorization),
    'h06-resume-pause-binding',
  );
  const history = status.commands.map((ref, index) => {
    const previous = parsePayloadReaderCommand(read(ref).command);
    requireContract(
      previous.expectedRevision === index &&
        previous.target.workflowId === target.workflowId &&
        previous.hash === digest(readerCommandText(previous)),
      'h06-resume-command-history',
    );
    return previous.commandId;
  });
  requireContract(
    new Set(history).size === history.length && !history.includes(commandId),
    'h06-resume-command-id-used',
  );
  const proof = read(interruption.authorization);
  const source = read(pause.source);
  if (source.kind === 'h06-temporal-autonomous-control/3') {
    verifyH06TemporalControlProof(store, readH06TemporalControlMode(source.mode), pause, proof);
  } else {
    const threadId = identifier(source.threadId);
    const turnId = identifier(source.turnId);
    const observed = object(proof.observed);
    const session = object(observed.session);
    const issued = object(object(observed.issued).raw);
    const event = object(issued.payload);
    const item = object(event.item);
    requireContract(
      proof.kind === 'reader-native-human-authorization' &&
        same(proof.command, pause) &&
        same(proof.source, source) &&
        source.kind === 'codex-user-command' &&
        source.schemaVersion === 1 &&
        same(object(source.user), {
          line: object(observed.user).line,
          sha256: object(observed.user).sha256,
        }) &&
        session.id === threadId &&
        session.session_id === threadId &&
        issued.type === 'event_msg' &&
        event.type === 'item_completed' &&
        event.thread_id === threadId &&
        event.turn_id === turnId &&
        item.type === 'CommandExecution' &&
        item.status === 'completed' &&
        item.exit_code === 0 &&
        typeof item.aggregated_output === 'string' &&
        item.aggregated_output.split('\n').includes(nativeReaderNotice(pause)),
      'h06-resume-pause-authority',
    );
  }
  const progress = object(record.progress);
  const snapshot = read(progress.snapshot);
  requireContract(
    snapshot.kind === 'substantial-task' &&
      snapshot.schemaVersion === 3 &&
      same(snapshot.input, input) &&
      Array.isArray(progress.records),
    'h06-resume-snapshot-binding',
  );
  for (const ref of progress.records) store.read(controlRef(ref));
  const stop = read(record.stopped);
  requireContract(
    stop.kind === 'task-stopped' && stop.confirmed === true && same(stop.input, input),
    'h06-resume-stop-binding',
  );
  const writer = read(stop.writer);
  const runtime = object(writer.runtime);
  const before = object(writer.before);
  const thread = object(object(writer.primary).thread);
  requireContract(
    writer.kind === 'task-writers-stopped' &&
      writer.schemaVersion === 2 &&
      writer.confirmed === true &&
      writer.notStarted !== true &&
      same(writer.input, input) &&
      same(object(writer.source), object(snapshot.source)) &&
      same(object(writer.copy), object(snapshot.copy)) &&
      typeof writer.session === 'string' &&
      writer.session.length > 0 &&
      runtime.session === writer.session &&
      Array.isArray(runtime.processes) &&
      runtime.processes.length > 0 &&
      Array.isArray(writer.processes) &&
      writer.processes.length > 0 &&
      Array.isArray(writer.terminals) &&
      Array.isArray(before.files) &&
      Array.isArray(before.directories) &&
      same(before, writer.after) &&
      thread.id === writer.session &&
      thread.cwd === object(writer.copy).root &&
      Array.isArray(thread.turns) &&
      thread.turns.length > 0 &&
      thread.turns.every((turn) =>
        ['completed', 'failed', 'interrupted'].includes(String(object(turn).status)),
      ),
    'h06-resume-writer-stop-binding',
  );
  const stoppedProcesses: unknown[] = writer.processes;
  const pids = stoppedProcesses.map((value) => {
    const identity = object(value);
    requireContract(
      typeof identity.pid === 'number' &&
        Number.isSafeInteger(identity.pid) &&
        identity.pid > 1 &&
        typeof identity.parent === 'number' &&
        Number.isSafeInteger(identity.parent) &&
        identity.parent >= 0 &&
        typeof identity.started === 'string' &&
        identity.started.length > 0,
      'h06-resume-process-identity',
    );
    return identity.pid;
  });
  requireContract(
    new Set(pids).size === pids.length &&
      runtime.processes.every((owned) => stoppedProcesses.some((stopped) => same(stopped, owned))),
    'h06-resume-process-binding',
  );
  const payload = parseTaskExecutionResume({
    schemaVersion: 1,
    kind: 'task-execution-resume',
    held,
    admission: input.admission,
  });
  checkTaskExecutionResume(input, payload);
  const bytes = JSON.stringify(payload);
  const command = {
    schemaVersion: 2 as const,
    commandId,
    target,
    expectedRevision: revision,
    author: target.owner,
    action: 'resume' as const,
    attempt: input.continuation.attempt + 1,
    payload: { sha256: digest(bytes), bytes: Buffer.byteLength(bytes) },
  };
  // The formatter omits source and hash. A held record cannot serve as a native user source.
  const authorizationText = nativeHumanAuthorizationText(
    makeTaskExecutionCommand({ ...command, source: held }),
  );
  return {
    kind: 'h06-native-resume-plan',
    mayRun: false,
    authority: null,
    qualification: false,
    workflowId: target.workflowId,
    runId,
    held,
    command,
    payload,
    authorizationText,
  };
}

export function h06NativeResumeMain(args: string[]) {
  const [command, path] = args;
  requireContract(
    args.length === 2 && command === '--plan' && typeof path === 'string',
    'h06-resume-arguments',
  );
  return planH06NativeResume(readH04Json(path));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(h06NativeResumeMain(process.argv.slice(2))) + '\n');
}
