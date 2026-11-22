import { join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { safeDirectory } from '../adapters/storage/storeFiles.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { nativeReaderNotice } from '../src/adapters/codex/readerAuthority.js';
import { makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import type { ManagedTaskInput } from '../src/contracts/localTask.js';
import type { PayloadReaderCommand } from '../src/contracts/readerControl.js';
import { controlRef } from '../src/policy/readerControl.js';
import { taskExecutionCommand, taskInterruption } from '../src/policy/taskExecution.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { planH06NativeResumeObservation } from './comparisonH06NativeResume.js';
import { readH06NativeTemporalStart } from './comparisonH06NativeTemporal.js';

import {
  verifyH06TemporalControlProof,
  type H06TemporalAutonomousMode,
} from './comparisonH06TemporalAutonomousControls.js';

function hostOwner(value: unknown) {
  const owner = object(value);
  exactFields(owner, ['id', 'pid', 'tasks', 'taskBindings']);
  const { pid } = owner;
  requireContract(
    typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      pid > 1 &&
      owner.tasks === true &&
      (owner.taskBindings === 2 || owner.taskBindings === 3),
    'h06-temporal-evidence-owner',
  );
  return { pid, id: identifier(owner.id), tasks: true, taskBindings: owner.taskBindings };
}

function commandAck(value: unknown, command: PayloadReaderCommand) {
  const ack = object(value);
  exactFields(ack, ['commandId', 'hash', 'revision', 'authorization']);
  requireContract(
    ack.commandId === command.commandId &&
      ack.hash === command.hash &&
      ack.revision === command.expectedRevision + 1,
    'h06-temporal-evidence-ack',
  );
  return {
    commandId: command.commandId,
    hash: command.hash,
    revision: command.expectedRevision + 1,
    authorization: controlRef(ack.authorization),
  };
}

/** Checks the saved, single-run handoff chain. Missing or invalid evidence must remain unknown. */
export function checkH06NativeTemporalEvidence(value: unknown) {
  const refs = object(value);
  exactFields(refs, ['started', 'warm', 'cold']);
  const started = h04Pin(refs.started);
  const {
    start,
    input: initial,
    workflowId,
    evidence,
    artifactRoot,
  } = readH06NativeTemporalStart(started);
  const runId = identifier(start.firstExecutionRunId);
  const hostRoot = join(evidence, 'temporal-host');
  const workspace = safeDirectory(text(start.workspaceRoot));
  requireContract(
    start.hostRoot === hostRoot &&
      workspace !== evidence &&
      !workspace.startsWith(evidence + sep) &&
      !evidence.startsWith(workspace + sep),
    'h06-temporal-evidence-roots',
  );
  const firstOwner = hostOwner(start.hostOwner);
  const store = artifactStore(artifactRoot, { existingOnly: true });
  const artifact = (value: unknown) => object(JSON.parse(store.read(controlRef(value)).toString()));
  function pinned(value: unknown, name: string) {
    const pin = h04Pin(value);
    requireContract(pin.path === join(evidence, name), 'h06-temporal-evidence-path');
    return { pin, value: object(JSON.parse(readH04Pin(pin).toString())) };
  }
  function authorization(ref: unknown, command: PayloadReaderCommand) {
    const proof = artifact(ref);
    const source = artifact(command.source);
    if (start.controlMode !== undefined) {
      verifyH06TemporalControlProof(
        store,
        start.controlMode as H06TemporalAutonomousMode,
        command,
        proof,
      );
      return;
    }
    const observed = object(proof.observed);
    const session = object(observed.session);
    const event = object(object(observed.issued).raw);
    const issued = object(event.payload);
    const item = object(issued.item);
    requireContract(
      proof.kind === 'reader-native-human-authorization' &&
        same(proof.command, command) &&
        same(proof.source, source) &&
        source.kind === 'codex-user-command' &&
        source.schemaVersion === 1 &&
        same(object(source.user), {
          line: object(observed.user).line,
          sha256: object(observed.user).sha256,
        }) &&
        session.id === identifier(source.threadId) &&
        session.session_id === source.threadId &&
        event.type === 'event_msg' &&
        issued.type === 'item_completed' &&
        issued.thread_id === source.threadId &&
        issued.turn_id === identifier(source.turnId) &&
        item.type === 'CommandExecution' &&
        item.status === 'completed' &&
        item.exit_code === 0 &&
        typeof item.aggregated_output === 'string' &&
        item.aggregated_output.split('\n').includes(nativeReaderNotice(command)),
      'h06-temporal-evidence-authority',
    );
  }
  function phase(
    name: 'warm' | 'cold',
    input: ManagedTaskInput,
    previous: ReturnType<typeof hostOwner>,
    previousCommands: unknown[],
  ) {
    const part = object(refs[name]);
    exactFields(part, ['pauseAck', 'status', 'host', 'resumeAck']);
    const revision = previousCommands.length + 1;
    const pauseReceipt = pinned(part.pauseAck, `pause-${revision}-ack.json`).value;
    const pause = pinned(pauseReceipt.intent, `pause-${revision}-intent.json`).value;
    const pauseCommand = taskExecutionCommand(input, pause.command, revision - 1);
    requireContract(
      pauseReceipt.kind === 'h06-native-temporal-pause-ack' &&
        pause.kind === 'h06-native-temporal-pause-intent' &&
        same(pause.started, started) &&
        pause.workflowId === workflowId &&
        pause.runId === runId &&
        same(pause.owner, previous) &&
        pauseCommand.action === 'pause',
      'h06-temporal-evidence-pause',
    );
    taskInterruption(artifact(pauseCommand.payload));
    const pauseAck = commandAck(pauseReceipt.ack, pauseCommand);
    authorization(pause.proof, pauseCommand);
    const status = pinned(part.status, `status-paused-${revision}.json`);
    const resumeReceipt = pinned(part.resumeAck, `resume-${revision + 1}-ack.json`).value;
    const resume = pinned(resumeReceipt.intent, `resume-${revision + 1}-intent.json`).value;
    const request = object(resume.request);
    const plan = planH06NativeResumeObservation(
      artifactRoot,
      status.value,
      request.commandId,
      pauseAck,
    );
    const held = artifact(plan.held);
    const progress = object(held.progress);
    const snapshot = artifact(progress.snapshot);
    const stopped = artifact(held.stopped);
    const writer = artifact(stopped.writer);
    const observed = object(pause.observed);
    const owned = pause.owned;
    const stoppedProcesses = writer.processes;
    requireContract(
      plan.workflowId === workflowId &&
        plan.runId === runId &&
        same(held.input, input) &&
        same(pause.snapshot, progress.snapshot) &&
        object(snapshot.source).root === workspace &&
        same(snapshot.profile, start.profile) &&
        same(object(status.value.result).commands, [...previousCommands, pauseAck.authorization]) &&
        typeof pause.observedAt === 'number' &&
        Number.isSafeInteger(pause.observedAt) &&
        pause.observedAt > 0 &&
        observed.status === 'live' &&
        Array.isArray(observed.processes) &&
        observed.processes.length > 0 &&
        Array.isArray(owned) &&
        Array.isArray(stoppedProcesses) &&
        observed.processes.every(
          (p) => owned.some((x) => same(p, x)) && stoppedProcesses.some((x) => same(p, x)),
        ) &&
        same(object(observed.runtime).processes, object(writer.runtime).processes),
      'h06-temporal-evidence-held',
    );
    const { pin: opened, value: host } = pinned(part.host, `temporal-${name}-host.json`);
    const owner = hostOwner(host.owner);
    requireContract(
      host.kind === 'h06-native-temporal-reopen' &&
        host.phase === name &&
        same(host.started, started) &&
        same(host.status, status.pin) &&
        host.hostRoot === hostRoot &&
        same(host.previous, previous) &&
        owner.id !== previous.id &&
        (name === 'warm'
          ? owner.pid === previous.pid && host.recovery === null && host.previousProcesses === null
          : owner.pid !== previous.pid && owner.id !== firstOwner.id),
      'h06-temporal-evidence-host',
    );
    if (name === 'cold') {
      if (host.recovery === null) {
        requireContract(same(host.previousProcesses, []), 'h06-temporal-evidence-recovery');
      } else {
        const recovery = object(host.recovery);
        requireContract(
          host.previousProcesses === null &&
            same(recovery.owner, previous) &&
            Array.isArray(recovery.tasks) &&
            recovery.tasks.some((row) => {
              const task = object(row);
              const admission = object(task.admission);
              return (
                same(admission.host, { pid: previous.pid, id: previous.id }) &&
                same(admission.input, input) &&
                same(task.outcome, held.stopped) &&
                Array.isArray(task.writers) &&
                task.writers.some((ref) => same(ref, stopped.writer))
              );
            }),
          'h06-temporal-evidence-recovery',
        );
      }
    }
    const command = taskExecutionCommand(input, resume.command, revision);
    requireContract(
      resumeReceipt.kind === 'h06-native-temporal-resume-ack' &&
        resume.kind === 'h06-native-temporal-resume-intent' &&
        same(resume.opened, opened) &&
        same(request, { started, status: status.pin, commandId: command.commandId }) &&
        resume.workflowId === workflowId &&
        resume.runId === runId &&
        resumeReceipt.workflowId === workflowId &&
        resumeReceipt.runId === runId &&
        same(command, makeTaskExecutionCommand({ ...plan.command, source: command.source })) &&
        same(artifact(command.payload), plan.payload),
      'h06-temporal-evidence-resume',
    );
    const ack = commandAck(resumeReceipt.ack, command);
    const transition = artifact(ack.authorization);
    requireContract(
      transition.kind === 'task-execution-continuation' &&
        same(transition.command, command) &&
        same(transition.input, input) &&
        same(transition.held, plan.held) &&
        same(transition.admission, plan.payload.admission),
      'h06-temporal-evidence-transition',
    );
    authorization(resume.proof, command);
    authorization(transition.authorization, command);
    return { owner, held: plan.held, pauseAck, ack, admission: plan.payload.admission };
  }
  const warm = phase('warm', initial, firstOwner, []);
  const cold = phase(
    'cold',
    {
      ...initial,
      admission: warm.admission,
      continuation: { attempt: 1, previous: warm.ack.authorization },
    },
    warm.owner,
    [warm.pauseAck.authorization, warm.ack.authorization],
  );
  return {
    status: 'CHAIN_VERIFIED' as const,
    mayRun: false as const,
    authority: null,
    qualification: false as const,
    workflowId,
    runId,
    warm: { held: warm.held, authorization: warm.ack.authorization },
    cold: { held: cold.held, authorization: cold.ack.authorization },
  };
}
