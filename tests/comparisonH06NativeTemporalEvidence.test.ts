import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { object } from '../src/contracts/project.js';
import { afterEach, expect, test, vi } from 'vitest';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import { nativeReaderNotice } from '../src/adapters/codex/readerAuthority.js';
import { makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import type { ManagedTaskInput } from '../src/contracts/localTask.js';
import type { ArtifactRef } from '../src/contracts/preparation.js';
import type { PayloadReaderCommand } from '../src/contracts/readerControl.js';
import { parseLocalTask, localTaskKey } from '../src/policy/localTask.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { planH06NativeResumeObservation } from './comparisonH06NativeResume.js';
import { checkH06NativeTemporalEvidence } from './comparisonH06NativeTemporalEvidence.js';

import { publishH06TemporalControlSource } from './comparisonH06TemporalAutonomousControls.js';
const parent = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('./comparisonH06TemporalAutonomousAuthority.js', () => ({
  readH06TemporalAutonomousAuthority: () => parent.value,
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(coldPreviousMismatch = false, autonomous = false, taskBindings: 2 | 3 = 2) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-temporal-evidence-'));
  roots.push(root);
  const evidence = join(root, 'evidence');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const hostRoot = join(evidence, 'temporal-host');
  const artifactRoot = join(evidence, 'artifacts');
  const store = artifactStore(artifactRoot);
  const save = (value: unknown) => store.publish(Buffer.from(JSON.stringify(value)));
  function write(name: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    const path = join(evidence, name);
    writeFileSync(path, bytes, { mode: 0o600 });
    return { path, sha256: digest(bytes) };
  }

  const initial = parseLocalTask({
    schemaVersion: 11,
    admission: {
      schemaVersion: 3,
      preparation: {
        schemaVersion: 1,
        project: {
          schemaVersion: 1,
          projectId: 'h06',
          workspaceId: 'workspace',
          rules: ['RULES.md'],
          cardRoot: 'tasks',
          roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
          checks: ['validate'],
        },
        taskId: 'one',
        hostId: 'test-host',
        owner: 'task-owner',
        generation: 4,
        revision: 2,
        card: 'tasks/one.md',
      },
      plan: { path: 'plan.json', sha256: digest('plan') },
      planning: save({ kind: 'planning' }),
      acceptance: save({ kind: 'acceptance' }),
    },
    executor: { path: 'executor.md', sha256: digest('executor') },
    baseline: 'validate',
    continuation: { attempt: 0, previous: null },
  });
  if (initial.schemaVersion !== 11) throw new Error('fixture-input-schema');
  const workflowId = localTaskKey(initial);
  const runId = 'run-1';
  const owner = (id: string, pid: number) => ({ id, pid, tasks: true, taskBindings });
  const firstOwner = owner('first', 123);
  const warmOwner = owner('warm', 123);
  const coldOwner = owner('cold', 124);
  const profile = { model: 'gpt-6-astra', effort: 'medium', clientVersion: '0.154.0' };
  const mode = { kind: 'temporal-autonomous/3', authority: write('parent.json', {}) } as const;
  parent.value = {
    request: {
      evidenceRoot: evidence,
      bootstrap: write('bootstrap.json', { input: initial }),
      chat: {},
    },
    grant: {},
    workDeadlineMs: Date.now() + 10000,
  };
  const started = write('temporal-start.json', {
    ...(autonomous ? { controlMode: mode } : {}),
    kind: 'h06-native-temporal-start',
    operationId: 'test-host',
    input: initial,
    hostRoot,
    hostOwner: firstOwner,
    artifactRoot,
    workspaceRoot: workspace,
    profile,
    workflowId,
    firstExecutionRunId: runId,
  });
  const nativeSource = {
    kind: 'codex-user-command',
    schemaVersion: 1,
    transcript: join(root, 'native.jsonl'),
    threadId: 'human-thread',
    turnId: 'human-turn',
    user: { line: 5, sha256: digest('human-record') },
  };
  const sourceRef = save(nativeSource);
  function proof(command: PayloadReaderCommand, snapshotBytes: number) {
    if (autonomous) {
      const source = JSON.parse(store.read(command.source).toString()) as { phase: string };
      return save({
        kind: 'reader-h06-temporal-initial-grant-authorization/3',
        command,
        source,
        authority: mode.authority,
        intent: {
          path: join(evidence, `autonomous-${source.phase}-intent.json`),
          sha256: digest(store.read(command.source)),
        },
      });
    }
    return save({
      kind: 'reader-native-human-authorization',
      command,
      source: nativeSource,
      observed: {
        bytes: snapshotBytes,
        session: { id: nativeSource.threadId, session_id: nativeSource.threadId },
        user: nativeSource.user,
        issued: {
          raw: {
            type: 'event_msg',
            payload: {
              type: 'item_completed',
              thread_id: nativeSource.threadId,
              turn_id: nativeSource.turnId,
              item: {
                type: 'CommandExecution',
                status: 'completed',
                exit_code: 0,
                aggregated_output: `${'x'.repeat(513)}\n${nativeReaderNotice(command)}`,
              },
            },
          },
        },
      },
    });
  }

  function phase(
    name: 'warm' | 'cold',
    input: ManagedTaskInput,
    previous: typeof firstOwner,
    next: typeof firstOwner,
    previousCommands: ArtifactRef[],
  ) {
    const target = taskControlTarget(input);
    let pause = makeTaskExecutionCommand({
      schemaVersion: 2,
      commandId: `${autonomous ? 'h06-' : ''}${name}-pause`,
      target,
      expectedRevision: previousCommands.length,
      author: target.owner,
      action: 'pause',
      attempt: input.continuation.attempt,
      source: sourceRef,
      payload: save({ schemaVersion: 1, kind: 'task-interruption', reason: 'Human pause' }),
    });
    if (autonomous)
      pause = makeTaskExecutionCommand({
        ...pause,
        source: publishH06TemporalControlSource(
          store,
          { kind: 'h06-temporal-autonomous-phase/3', mode, started, runId, phase: `${name}-pause` },
          pause,
        ),
      });
    const pauseAuthorization = save({
      kind: 'task-execution-interruption',
      input,
      command: pause,
      authorization: proof(pause, 4000),
    });
    const revision = pause.expectedRevision + 1;
    const pauseAck = {
      commandId: pause.commandId,
      hash: pause.hash,
      revision,
      authorization: pauseAuthorization,
    };
    const source = { root: workspace };
    const copy = { root: join(evidence, 'writer-copy') };
    const snapshot = save({
      kind: 'substantial-task',
      schemaVersion: 3,
      input,
      source,
      copy,
      profile,
    });
    const processes = [
      { pid: 321 + revision, parent: previous.pid, started: 'writer-process-start' },
    ];
    const before = { files: [], directories: [] };
    const writer = save({
      kind: 'task-writers-stopped',
      schemaVersion: 2,
      confirmed: true,
      input,
      source,
      copy,
      session: 'writer-session',
      runtime: { session: 'writer-session', processes },
      processes,
      terminals: [],
      before,
      after: before,
      primary: {
        thread: { id: 'writer-session', cwd: copy.root, turns: [{ status: 'interrupted' }] },
      },
    });
    const stopped = save({ kind: 'task-stopped', confirmed: true, input, writer });
    const held = save({
      kind: 'task-execution-held',
      input,
      stopped,
      progress: { snapshot, records: [] },
      command: pauseAck,
    });
    const pauseIntent = {
      kind: 'h06-native-temporal-pause-intent',
      started,
      workflowId,
      runId,
      owner: previous,
      command: pause,
      snapshot,
      proof: proof(pause, 3999),
      observed: { status: 'live', runtime: { session: null, processes }, processes },
      owned: processes,
      observedAt: 1234,
    };
    const pauseAckFile = write(`pause-${revision}-ack.json`, {
      kind: 'h06-native-temporal-pause-ack',
      intent: write(`pause-${revision}-intent.json`, pauseIntent),
      ack: pauseAck,
    });
    const observation = {
      workflowId,
      runId,
      query: 'localTaskStatus',
      result: {
        phase: 'waiting-human',
        waiting: true,
        held,
        runId,
        revision,
        attempt: input.continuation.attempt,
        requirementsRevision: target.requirementsRevision,
        stopFailure: '',
        budgetFailure: '',
        checkpointFailure: '',
        commands: [...previousCommands, pauseAck.authorization],
        budget: {
          limit: 15,
          used: 0,
          manifest: save({ kind: 'task-model-budget', schemaVersion: 1, limit: 15, credits: [] }),
        },
      },
    };
    const status = write(`status-paused-${revision}.json`, observation);
    const plan = planH06NativeResumeObservation(
      artifactRoot,
      observation,
      `${autonomous ? 'h06-' : ''}${name}-resume`,
      pauseAck,
    );
    const command = makeTaskExecutionCommand({
      ...plan.command,
      source: autonomous
        ? publishH06TemporalControlSource(
            store,
            {
              kind: 'h06-temporal-autonomous-phase/3',
              mode,
              started,
              runId,
              phase: `${name}-resume`,
            },
            plan.command,
          )
        : sourceRef,
    });
    expect(save(plan.payload)).toEqual(command.payload);
    const transition = {
      kind: 'task-execution-continuation',
      input,
      held,
      command,
      authorization: proof(command, 5000),
      admission: plan.payload.admission,
    };
    const resumeAck = {
      commandId: command.commandId,
      hash: command.hash,
      revision: revision + 1,
      authorization: save(transition),
    };
    const hostReceipt = {
      kind: 'h06-native-temporal-reopen',
      phase: name,
      started,
      status,
      hostRoot,
      previous,
      owner: next,
      recovery: null,
      previousProcesses: name === 'cold' ? [] : null,
    };
    const host = write(`temporal-${name}-host.json`, hostReceipt);
    const resumeIntent = {
      kind: 'h06-native-temporal-resume-intent',
      request: { started, status, commandId: command.commandId },
      opened: host,
      workflowId,
      runId,
      command,
      proof: proof(command, 4999),
    };
    const resumeReceipt = {
      kind: 'h06-native-temporal-resume-ack',
      workflowId,
      runId,
      intent: write(`resume-${revision + 1}-intent.json`, resumeIntent),
      ack: resumeAck,
    };
    const pins = {
      pauseAck: pauseAckFile,
      status,
      host,
      resumeAck: write(`resume-${revision + 1}-ack.json`, resumeReceipt),
    };
    return {
      pins,
      pauseAck,
      resumeAck,
      held,
      stopped,
      writer,
      input,
      observation,
      hostReceipt,
      resumeIntent,
      resumeReceipt,
      transition,
    };
  }

  const warm = phase('warm', initial, firstOwner, warmOwner, []);
  const cold = phase(
    'cold',
    {
      ...initial,
      continuation: {
        attempt: 1,
        previous: coldPreviousMismatch ? save({ foreign: true }) : warm.resumeAck.authorization,
      },
    },
    warmOwner,
    coldOwner,
    [warm.pauseAck.authorization, warm.resumeAck.authorization],
  );
  const pins = { started, warm: warm.pins, cold: cold.pins };
  return { pins, warm, cold, workflowId, runId, write, save };
}

test('binds both native command ACK transitions to the same run, with separate intent and update proofs', () => {
  const f = fixture();
  expect(checkH06NativeTemporalEvidence(f.pins)).toEqual({
    status: 'CHAIN_VERIFIED',
    mayRun: false,
    authority: null,
    qualification: false,
    workflowId: f.workflowId,
    runId: f.runId,
    warm: { held: f.warm.held, authorization: f.warm.resumeAck.authorization },
    cold: { held: f.cold.held, authorization: f.cold.resumeAck.authorization },
  });
});

test('preserves the actual taskBindings 3 chain and exact source/run/artifact identities', () => {
  const f = fixture(false, false, 3);
  const files = [f.pins.started, f.pins.warm.host, f.pins.cold.host];
  const before = files.map(({ path }) => readFileSync(path));
  expect(object(object(JSON.parse(before[0]!.toString()) as unknown).hostOwner).taskBindings).toBe(
    3,
  );
  for (const bytes of before.slice(1)) {
    const host = object(JSON.parse(bytes.toString()) as unknown);
    expect(object(host.previous).taskBindings).toBe(3);
    expect(object(host.owner).taskBindings).toBe(3);
  }
  expect(checkH06NativeTemporalEvidence(f.pins)).toEqual({
    status: 'CHAIN_VERIFIED',
    mayRun: false,
    authority: null,
    qualification: false,
    workflowId: f.workflowId,
    runId: f.runId,
    warm: { held: f.warm.held, authorization: f.warm.resumeAck.authorization },
    cold: { held: f.cold.held, authorization: f.cold.resumeAck.authorization },
  });
  expect(files.map(({ path }) => readFileSync(path))).toEqual(before);
});

test('rejects unsupported taskBindings 4 before admitting the evidence chain', () => {
  const f = fixture(false, false, 3);
  const started = object(JSON.parse(readFileSync(f.pins.started.path).toString()) as unknown);
  f.pins.started = f.write('temporal-start.json', {
    ...started,
    hostOwner: { ...object(started.hostOwner), taskBindings: 4 },
  });
  const before = readFileSync(f.pins.started.path);
  expect(() => checkH06NativeTemporalEvidence(f.pins)).toThrow('h06-temporal-evidence-owner');
  expect(readFileSync(f.pins.started.path)).toEqual(before);
});

test('rejects a missing second RESUME ACK', () => {
  const f = fixture();
  rmSync(f.pins.cold.resumeAck.path);
  expect(() => checkH06NativeTemporalEvidence(f.pins)).toThrow();
});

test('rejects a changed status digest and an unrelated receipt path', () => {
  const f = fixture();
  const original = f.pins.cold.status;
  f.pins.cold.status = { ...original, sha256: digest('foreign') };
  expect(() => checkH06NativeTemporalEvidence(f.pins)).toThrow();
  f.pins.cold.status = f.pins.warm.status;
  expect(() => checkH06NativeTemporalEvidence(f.pins)).toThrow('h06-temporal-evidence-path');
});

test('rejects an internally consistent second held state whose prior transition is foreign', () => {
  expect(() => checkH06NativeTemporalEvidence(fixture(true).pins)).toThrow(
    'h06-temporal-evidence-held',
  );
});

test('rejects a cold replacement claiming the same process', () => {
  const f = fixture();
  const receipt = f.cold.hostReceipt;
  f.pins.cold.host = f.write('temporal-cold-host.json', {
    ...receipt,
    owner: { ...receipt.owner, pid: receipt.previous.pid },
  });
  expect(() => checkH06NativeTemporalEvidence(f.pins)).toThrow('h06-temporal-evidence-host');
});

test('rejects a clean-cold receipt with a remaining former process', () => {
  const f = fixture();
  f.pins.cold.host = f.write('temporal-cold-host.json', {
    ...f.cold.hostReceipt,
    previousProcesses: [{ pid: 123, parent: 1, started: 'former-host' }],
  });
  expect(() => checkH06NativeTemporalEvidence(f.pins)).toThrow('h06-temporal-evidence-recovery');
});

test('requires stale recovery to bind the former owner, exact input and stop outcome', () => {
  const f = fixture();
  const { previous } = f.cold.hostReceipt;
  const recovery = {
    owner: previous,
    tasks: [
      {
        admission: { host: { pid: previous.pid, id: previous.id }, input: f.cold.input },
        outcome: f.cold.stopped,
        writers: [f.cold.writer],
      },
    ],
  };
  const receipt = { ...f.cold.hostReceipt, previousProcesses: null, recovery };
  f.pins.cold.host = f.write('temporal-cold-host.json', receipt);
  f.pins.cold.resumeAck = f.write('resume-4-ack.json', {
    ...f.cold.resumeReceipt,
    intent: f.write('resume-4-intent.json', { ...f.cold.resumeIntent, opened: f.pins.cold.host }),
  });
  expect(checkH06NativeTemporalEvidence(f.pins).status).toBe('CHAIN_VERIFIED');
  f.pins.cold.host = f.write('temporal-cold-host.json', {
    ...receipt,
    recovery: { ...recovery, tasks: [{ ...recovery.tasks[0], outcome: f.warm.stopped }] },
  });
  expect(() => checkH06NativeTemporalEvidence(f.pins)).toThrow('h06-temporal-evidence-recovery');
});

test.each(['direct', 'other-host'])('rejects a RESUME intent that refers to %s', (variant) => {
  const f = fixture();
  f.pins.cold.resumeAck = f.write('resume-4-ack.json', {
    ...f.cold.resumeReceipt,
    intent: f.write('resume-4-intent.json', {
      ...f.cold.resumeIntent,
      opened: variant === 'direct' ? null : f.pins.warm.host,
    }),
  });
  expect(() => checkH06NativeTemporalEvidence(f.pins)).toThrow('h06-temporal-evidence-resume');
});

test('rejects an ACK artifact that points at the other held state', () => {
  const f = fixture();
  f.pins.cold.resumeAck = f.write('resume-4-ack.json', {
    ...f.cold.resumeReceipt,
    ack: {
      ...f.cold.resumeAck,
      authorization: f.save({ ...f.cold.transition, held: f.warm.held }),
    },
  });
  expect(() => checkH06NativeTemporalEvidence(f.pins)).toThrow('h06-temporal-evidence-transition');
});

test('independently verifies the full autonomous proof chain without claiming human controls', () => {
  const f = fixture(false, true);
  expect(checkH06NativeTemporalEvidence(f.pins)).toMatchObject({
    status: 'CHAIN_VERIFIED',
    qualification: false,
  });
});
