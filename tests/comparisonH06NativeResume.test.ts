import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { NativeConnection } from '@temporalio/worker';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import { bindTaskBackendClient } from '../src/client/taskBackend.js';
import { effectJournal } from '../src/adapters/artifacts/effects.js';
import {
  nativeHumanAuthorizationText,
  nativeReaderAuthority,
  nativeReaderNotice,
} from '../src/adapters/codex/readerAuthority.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import {
  h06TemporalControlAuthority,
  type H06TemporalAutonomousMode,
} from './comparisonH06TemporalAutonomousControls.js';
import * as nativeAttempt from './comparisonH06NativeAttempt.js';
import * as parentAuthority from './comparisonH06TemporalAutonomousAuthority.js';
import * as readerAuthority from '../src/adapters/codex/readerAuthority.js';
import * as taskWriter from '../src/adapters/codex/taskWriter.js';
import { taskFiles } from '../src/adapters/project/taskFiles.js';
import * as taskGate from '../src/adapters/project/taskGate.js';
import { makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import { object } from '../src/contracts/project.js';
import { parseLocalTask, localTaskKey } from '../src/policy/localTask.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { h06NativeResumeMain, planH06NativeResume } from './comparisonH06NativeResume.js';
import { captureH06NativePausedStatus } from './comparisonH06NativeTemporal.js';
import {
  issueH06NativeTemporalPause,
  observeH06NativeTemporalWriterReady,
  pauseH06NativeTemporal,
  planH06NativeTemporalPause,
} from './comparisonH06NativeTemporalPause.js';
import {
  deliverH06NativeTemporalResume,
  issueH06NativeTemporalResume,
  readH06NativeTemporalResumeReceipt,
  reopenH06NativeTemporal,
  verifyH06NativeTemporalResume,
} from './comparisonH06NativeTemporalResume.js';
import type { PayloadReaderCommand } from '../src/contracts/readerControl.js';
import { readH04Pin } from './comparisonH04Contract.js';

const hosts = vi.hoisted(() => ({ create: vi.fn(), recover: vi.fn() }));
vi.mock('../src/worker/readerHost.js', () => ({ createReaderHost: hosts.create }));
vi.mock('../src/worker/readerRecovery.js', () => ({ recoverReaderHost: hosts.recover }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  hosts.create.mockReset();
  hosts.recover.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(attempt = 1) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-resume-plan-'));
  roots.push(root);
  const artifactRoot = join(root, 'artifacts');
  const store = artifactStore(artifactRoot);
  const save = (value: unknown) => store.publish(Buffer.from(JSON.stringify(value)));
  const initial = parseLocalTask({
    schemaVersion: 11,
    admission: {
      schemaVersion: 3,
      preparation: {
        schemaVersion: 1,
        project: {
          schemaVersion: 1,
          projectId: 'h06-native-fixture',
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
  const target = taskControlTarget(initial);
  const nativeSource = {
    kind: 'codex-user-command',
    schemaVersion: 1,
    transcript: join(root, 'native.jsonl'),
    threadId: 'human-thread',
    turnId: 'human-turn',
    user: { line: 5, sha256: digest('human-record') },
  };
  const makeCommand = (
    action: 'pause' | 'resume',
    expectedRevision: number,
    commandId: string,
    attempt: number,
  ) =>
    makeTaskExecutionCommand({
      schemaVersion: 2,
      commandId,
      target,
      expectedRevision,
      author: target.owner,
      action,
      attempt,
      source: save(nativeSource),
      payload: save({ schemaVersion: 1, kind: 'task-interruption', reason: 'Human pause' }),
    });
  const earlierPause = makeCommand('pause', 0, 'earlier-pause', 0);
  const earlierResume = makeCommand('resume', 1, 'earlier-resume', 1);
  function nativeProof(command: typeof earlierPause) {
    return {
      kind: 'reader-native-human-authorization',
      command,
      source: nativeSource,
      observed: {
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
                aggregated_output: nativeReaderNotice(command),
              },
            },
          },
        },
      },
    };
  }
  const earlier = save({
    kind: 'task-execution-interruption',
    command: earlierPause,
    input: initial,
    authorization: save(nativeProof(earlierPause)),
  });
  const transition = save({
    kind: 'task-execution-continuation',
    command: earlierResume,
    input: initial,
    authorization: save(nativeProof(earlierResume)),
  });
  const input =
    attempt === 0 ? initial : { ...initial, continuation: { attempt, previous: transition } };
  const processes = [{ pid: 123, parent: 1, started: 'recorded-process-start' }];
  const writer = {
    kind: 'task-writers-stopped',
    schemaVersion: 2,
    confirmed: true,
    input,
    session: 'writer-session',
    processes,
    runtime: { session: 'writer-session', processes },
    terminals: [],
    source: { root: join(root, 'source') },
    before: { files: [], directories: [] },
    after: { files: [], directories: [] },
    copy: { root },
    primary: { thread: { id: 'writer-session', cwd: root, turns: [{ status: 'interrupted' }] } },
  };
  const stopped = { kind: 'task-stopped', confirmed: true, input, writer: save(writer) };
  const pause = makeCommand('pause', attempt * 2, 'pause-1', attempt);
  const revision = pause.expectedRevision + 1;
  const nativeAuthorization = nativeProof(pause);
  const proof = save(nativeAuthorization);
  const interruption = {
    kind: 'task-execution-interruption',
    input,
    command: pause,
    authorization: proof,
  };
  const authorization = save(interruption);
  const held = {
    kind: 'task-execution-held',
    input,
    stopped: save(stopped),
    progress: {
      snapshot: save({
        schemaVersion: 3,
        kind: 'substantial-task',
        input,
        source: writer.source,
        copy: writer.copy,
      }),
      records: [save({ kind: 'progress-record' })],
    },
    command: { commandId: pause.commandId, hash: pause.hash, revision, authorization },
  };
  const manifest = save({ schemaVersion: 1, kind: 'task-model-budget', limit: 15, credits: [] });
  const status = {
    workflowId: target.workflowId,
    runId: 'run-1',
    query: 'localTaskStatus',
    result: {
      phase: 'waiting-human',
      waiting: true,
      held: save(held),
      runId: 'run-1',
      revision,
      attempt,
      requirementsRevision: 2,
      stopFailure: '',
      budgetFailure: '',
      checkpointFailure: '',
      commands: attempt === 0 ? [authorization] : [earlier, transition, authorization],
      budget: { limit: 15, used: 0, manifest },
    },
  };
  const statusPath = join(root, 'status.json');
  function request() {
    const bytes = Buffer.from(JSON.stringify(status));
    writeFileSync(statusPath, bytes);
    return {
      kind: 'comparison-h06-native-resume-plan',
      artifactRoot,
      status: { path: statusPath, sha256: digest(bytes) },
      commandId: 'resume-1',
    };
  }
  function rewriteWriter(change: Record<string, unknown>) {
    const newWriter = save({ ...writer, ...change });
    status.result.held = save({ ...held, stopped: save({ ...stopped, writer: newWriter }) });
  }
  function snapshot() {
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
      .sort()
      .map((path) => {
        if (path === 'artifacts') return path;
        return [path, digest(readFileSync(join(root, path)))];
      });
  }
  function rewritePause(change: Record<string, unknown>) {
    const ref = save({ ...interruption, ...change });
    status.result.commands[2] = ref;
    status.result.held = save({ ...held, command: { ...held.command, authorization: ref } });
  }
  return {
    root,
    artifactRoot,
    initial,
    input,
    target,
    save,
    status,
    held,
    stopped,
    manifest,
    pause,
    nativeAuthorization,
    rewritePause,
    request,
    rewriteWriter,
    snapshot,
  };
}

describe('H06 capture after a confirmed Temporal PAUSE', () => {
  function paused(attempt = 1) {
    const f = fixture(attempt);
    const hostRoot = join(f.root, 'temporal-host');
    mkdirSync(hostRoot);
    const profile = { model: 'gpt-6-astra', effort: 'medium', clientVersion: '0.154.0' };
    const start = {
      kind: 'h06-native-temporal-start',
      controlMode: undefined as H06TemporalAutonomousMode | undefined,
      operationId: f.initial.admission.preparation.hostId,
      workflowId: f.target.workflowId,
      firstExecutionRunId: 'earlier-run',
      artifactRoot: f.artifactRoot,
      hostRoot,
      hostOwner: { id: 'initial-host', pid: process.pid, tasks: true, taskBindings: 2 },
      workspaceRoot: f.root,
      workflowsPath: join(f.root, 'workflow.js'),
      taskQueue: 'h06-queue',
      maxTurnStarts: 15,
      profile,
      input: f.initial,
    };
    const startPin = () => {
      const path = join(f.root, 'temporal-start.json');
      const bytes = JSON.stringify(start);
      writeFileSync(path, bytes);
      return { path, sha256: digest(bytes) };
    };
    const query = vi.fn(async () => f.status.result);
    const executeUpdate = vi.fn();
    const getHandle = vi.fn(() => ({ query, executeUpdate }));
    const withDeadline = vi.fn(async (_deadline: number, read: () => Promise<unknown>) => read());
    const client = { workflow: { getHandle }, connection: { withDeadline } } as unknown as Client;
    execFileSync('git', ['init', '--quiet'], { cwd: f.root, stdio: 'pipe' });
    bindTaskBackendClient(client, {
      ...f.initial.admission.preparation,
      workspaceRoot: f.root,
    });
    return { ...f, start, startPin, query, executeUpdate, getHandle, withDeadline, client };
  }

  async function authorized(attempt = 1, autonomous = false) {
    const f = paused(attempt);
    const mode = autonomous
      ? ({
          kind: 'temporal-autonomous/3',
          authority: { path: join(f.root, 'parent.json'), sha256: digest('{}') },
        } as const)
      : undefined;
    if (mode !== undefined) {
      writeFileSync(mode.authority.path, '{}');
      f.start.controlMode = mode;
      f.start.firstExecutionRunId = f.status.runId;
    }
    const commandId = autonomous
      ? attempt === 0
        ? 'h06-warm-resume'
        : 'h06-cold-resume'
      : 'resume-1';
    const started = f.startPin();
    const deadline = Date.now() + 10000;
    const { status, plan } = await captureH06NativePausedStatus(
      f.client,
      started,
      f.status.runId,
      f.held.command,
      commandId,
      deadline,
    );
    const request = { started, status, commandId };
    const issuer = {
      sessionsRoot: f.root,
      workspaceRoot: realpathSync(process.cwd()),
      threadId: 'h06-issuer',
      owner: f.target.owner,
    };
    if (mode !== undefined) {
      const path = join(f.root, 'bootstrap.json'),
        bytes = JSON.stringify({ input: f.initial });
      writeFileSync(path, bytes);
      const parent = {
        request: {
          evidenceRoot: f.root,
          bootstrap: { path, sha256: digest(bytes) },
          chat: { threadId: issuer.threadId, workspace: issuer.workspaceRoot },
        },
        grant: { sessionsRoot: issuer.sessionsRoot },
        workDeadlineMs: deadline,
      };
      vi.spyOn(parentAuthority, 'readH06TemporalAutonomousAuthority').mockReturnValue(
        parent as unknown as ReturnType<typeof parentAuthority.readH06TemporalAutonomousAuthority>,
      );
    }
    const transcript = join(f.root, 'native-resume.jsonl');
    const turnId = 'resume-turn';
    const records = [
      {
        type: 'session_meta',
        payload: {
          id: issuer.threadId,
          session_id: issuer.threadId,
          cwd: issuer.workspaceRoot,
          cli_version: '0.164.0-alpha.11.1',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: plan.authorizationText }],
        },
      },
    ];
    const write = () =>
      writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    write();
    vi.stubEnv('CODEX_THREAD_ID', issuer.threadId);
    const source = {
      kind: 'codex-user-command',
      schemaVersion: 1,
      transcript,
      threadId: issuer.threadId,
      turnId,
      user: { line: 3, sha256: digest(JSON.stringify(records[2]) + '\n') },
    } as const;
    const { command, notice } = await issueH06NativeTemporalResume(
      request,
      issuer,
      mode === undefined
        ? source
        : {
            kind: 'h06-temporal-autonomous-phase/3',
            mode,
            started,
            runId: f.status.runId,
            phase: attempt === 0 ? 'warm-resume' : 'cold-resume',
          },
    );
    const issued = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: issuer.threadId,
        turn_id: turnId,
        item: {
          type: 'CommandExecution',
          cwd: issuer.workspaceRoot,
          status: 'completed',
          exit_code: 0,
          aggregated_output: notice,
        },
      },
    };
    records.push(issued);
    write();
    const revision = command.expectedRevision + 1;
    const intent = join(f.root, `resume-${revision}-intent.json`);
    const journal = join(f.root, '.git', 'agent-workflow', 'tasks', digest(f.target.workflowId));
    const workflowIntent = join(journal, 'execution-command-intents', `${revision}.json`);
    const workflowRecord = join(journal, 'execution-commands', `${command.commandId}.json`);
    f.executeUpdate.mockImplementation(
      async (_name: string, options: { args: [PayloadReaderCommand] }) => {
        expect(existsSync(intent)).toBe(true);
        expect(options.args).toEqual([command]);
        const verified = await h06TemporalControlAuthority(
          artifactStore(f.artifactRoot, { existingOnly: true }),
          issuer,
          mode,
        ).verify(command);
        const ack = {
          revision,
          commandId: command.commandId,
          hash: command.hash,
          authorization: f.save({
            kind: 'task-execution-continuation',
            input: f.input,
            command,
            held: plan.held,
            admission: plan.payload.admission,
            authorization: verified.proof,
          }),
        };
        const next = parseLocalTask({
          ...f.input,
          admission: plan.payload.admission,
          continuation: { attempt: command.attempt, previous: ack.authorization },
        });
        mkdirSync(join(journal, 'execution-command-intents'), { recursive: true });
        mkdirSync(join(journal, 'execution-commands'), { recursive: true });
        writeFileSync(
          workflowIntent,
          JSON.stringify({ input: f.input, command, authorization: verified.proof }),
        );
        writeFileSync(workflowRecord, JSON.stringify({ command, ack, next }));
        return ack;
      },
    );
    f.getHandle.mockClear();
    return {
      ...f,
      request,
      issuer,
      command,
      intent,
      workflowIntent,
      workflowRecord,
      transcript,
      deadline,
      removeNotice: () => {
        records.pop();
        write();
      },
    };
  }

  it('writes a snapshot for the selected run that the existing planner can read again', async () => {
    const f = paused();
    const started = f.startPin();
    const deadline = Date.now() + 10000;
    const capture = () =>
      captureH06NativePausedStatus(
        f.client,
        started,
        f.status.runId,
        f.held.command,
        'resume-1',
        deadline,
      );
    const captured = await capture();
    expect(f.getHandle).toHaveBeenCalledExactlyOnceWith(f.target.workflowId, f.status.runId);
    expect(f.query).toHaveBeenCalledExactlyOnceWith('localTaskStatus');
    expect(f.withDeadline.mock.calls[0]?.[0]).toBe(deadline);
    expect(captured.status.path).toBe(join(f.root, 'status-paused-3.json'));
    const bytes = readFileSync(captured.status.path);
    expect(digest(bytes)).toBe(captured.status.sha256);
    expect(JSON.parse(bytes.toString()) as unknown).toEqual(f.status);
    expect(
      planH06NativeResume({
        kind: 'comparison-h06-native-resume-plan',
        artifactRoot: f.artifactRoot,
        status: captured.status,
        commandId: 'resume-1',
      }),
    ).toEqual(captured.plan);
    await expect(capture()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(captured.status.path)).toEqual(bytes);
  });

  it.each(['ack', 'run', 'waiting', 'target', 'deadline'] as const)(
    'does not publish a resumable snapshot with an invalid %s',
    async (which) => {
      const f = paused();
      const pause = { ...f.held.command };
      if (which === 'ack') pause.commandId = 'foreign-pause';
      if (which === 'run') f.status.result.runId = 'foreign-run';
      if (which === 'waiting') f.status.result.waiting = false;
      if (which === 'target') f.start.input.admission.preparation.owner = 'foreign-owner';
      const deadline = Date.now() + 10000;
      if (which === 'deadline')
        f.query.mockImplementationOnce(async () => {
          vi.spyOn(Date, 'now').mockReturnValue(deadline);
          return f.status.result;
        });
      await expect(
        captureH06NativePausedStatus(
          f.client,
          f.startPin(),
          f.status.runId,
          pause,
          'resume-1',
          deadline,
        ),
      ).rejects.toThrow();
      expect(readdirSync(f.root).some((name) => name.startsWith('status-paused-'))).toBe(false);
    },
  );

  it('issues the exact PAUSE notice and requires its completed native record before delivery', async () => {
    const f = paused();
    const workspace = join(f.root, 'source');
    mkdirSync(workspace);
    f.start.workspaceRoot = workspace;
    const snapshot = f.save({
      kind: 'substantial-task',
      schemaVersion: 3,
      input: f.input,
      profile: f.start.profile,
      source: { root: workspace },
    });
    const writing = {
      ...f.status.result,
      phase: 'writing',
      waiting: false,
      revision: f.pause.expectedRevision,
      snapshot,
    };
    f.query.mockResolvedValue(writing);
    const request = {
      started: f.startPin(),
      runId: f.status.runId,
      commandId: f.pause.commandId,
      reason: 'Human pause',
    };
    const deadline = Date.now() + 10000;
    const plan = await planH06NativeTemporalPause(f.client, request, deadline);
    expect(plan).toMatchObject({ mayRun: false, qualification: false });
    expect(plan.authorizationText).toBe(nativeHumanAuthorizationText(f.pause));
    const issuer = {
      sessionsRoot: f.root,
      workspaceRoot: realpathSync(process.cwd()),
      owner: f.target.owner,
      threadId: 'pause-issuer',
    };
    vi.stubEnv('CODEX_THREAD_ID', issuer.threadId);
    const transcript = join(f.root, 'native-pause.jsonl');
    const turnId = 'pause-turn';
    const records: unknown[] = [
      {
        type: 'session_meta',
        payload: {
          id: issuer.threadId,
          session_id: issuer.threadId,
          cwd: issuer.workspaceRoot,
          cli_version: '0.164.0-alpha.11.1',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: plan.authorizationText }],
        },
      },
    ];
    const write = () =>
      writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    write();
    const source = {
      kind: 'codex-user-command' as const,
      schemaVersion: 1 as const,
      transcript,
      threadId: issuer.threadId,
      turnId,
      user: { line: 3, sha256: digest(JSON.stringify(records[2]) + '\n') },
    };
    f.query.mockResolvedValueOnce({ ...writing, revision: writing.revision + 1 });
    await expect(
      issueH06NativeTemporalPause(f.client, request, issuer, source, deadline),
    ).rejects.toThrow();
    const { command, notice } = await issueH06NativeTemporalPause(
      f.client,
      request,
      issuer,
      source,
      deadline,
    );
    expect(notice).toBe(nativeReaderNotice(command));
    await expect(
      pauseH06NativeTemporal(f.client, request.started, request.runId, command, issuer, deadline),
    ).rejects.toThrow('reader-native');
    expect(f.executeUpdate).not.toHaveBeenCalled();
    records.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: issuer.threadId,
        turn_id: turnId,
        item: {
          type: 'CommandExecution',
          cwd: issuer.workspaceRoot,
          status: 'completed',
          exit_code: 0,
          aggregated_output: notice,
        },
      },
    });
    write();
    await expect(
      nativeReaderAuthority(artifactStore(f.artifactRoot, { existingOnly: true }), issuer).verify(
        command,
      ),
    ).resolves.toMatchObject({ origin: 'human', hash: command.hash });
  });

  it.each(['live', 'not-live', 'changed'] as const)(
    'records owned Writer processes before PAUSE and rejects unsafe state (%s)',
    async (mode) => {
      const f = paused();
      const workspace = join(f.root, 'source');
      mkdirSync(workspace);
      f.start.workspaceRoot = workspace;
      writeFileSync(join(f.start.hostRoot, 'host-owner'), JSON.stringify(f.start.hostOwner));
      const files = taskFiles(f.artifactRoot, { existingOnly: true });
      const snapshot = f.save({
        kind: 'substantial-task',
        schemaVersion: 3,
        input: f.input,
        profile: f.start.profile,
        source: files.binding(workspace),
        copy: files.binding(f.root),
      });
      const writing = {
        ...f.status.result,
        phase: 'writing',
        waiting: false,
        revision: f.pause.expectedRevision,
        snapshot,
      };
      f.query.mockResolvedValue(writing);
      if (mode === 'changed')
        f.query.mockResolvedValueOnce(writing).mockResolvedValueOnce({ ...writing, revision: 9 });
      const issuer = {
        sessionsRoot: f.root,
        workspaceRoot: f.root,
        owner: f.target.owner,
        threadId: 'issuer',
      };
      const proof = f.save(f.nativeAuthorization);
      vi.spyOn(readerAuthority, 'nativeReaderAuthority').mockReturnValue({
        issue: vi.fn(async () => 'notice'),
        verify: vi.fn(async () => ({
          proof,
          origin: 'human' as const,
          author: issuer.owner,
          hash: f.pause.hash,
        })),
      });
      const assert = vi.fn();
      vi.spyOn(taskGate, 'taskGate').mockReturnValue({
        assert,
        directory: f.root,
        admission: () => ({ mode: 'owned' }),
      } as unknown as ReturnType<typeof taskGate.taskGate>);
      const processes = [{ pid: 123, parent: 1, started: 'process-start' }];
      const live = { status: 'live' as const, runtime: { session: null, processes }, processes };
      vi.spyOn(taskWriter, 'inspectTaskWriter').mockResolvedValue(
        mode === 'not-live' ? { status: 'unknown', reason: 'not observed' } : live,
      );
      const owned = [...processes, { pid: 124, parent: 123, started: 'child-start' }];
      vi.spyOn(NativeWriterProcesses.prototype, 'descendants').mockResolvedValue(owned);
      const path = join(f.root, 'pause-3-intent.json');
      f.executeUpdate.mockImplementation(async () => {
        expect(JSON.parse(readFileSync(path, 'utf8')) as unknown).toMatchObject({
          kind: 'h06-native-temporal-pause-intent',
          observed: live,
          owned,
          snapshot,
        });
        return f.held.command;
      });
      const attempt = pauseH06NativeTemporal(
        f.client,
        f.startPin(),
        f.status.runId,
        f.pause,
        issuer,
        Date.now() + 10000,
      );
      if (mode !== 'live') {
        await expect(attempt).rejects.toThrow();
        expect(f.executeUpdate).not.toHaveBeenCalled();
        expect(existsSync(path)).toBe(false);
        return;
      }
      const result = await attempt;
      expect(result.ack).toEqual(f.held.command);
      expect(f.executeUpdate).toHaveBeenCalledExactlyOnceWith('taskExecutionControl', {
        args: [f.pause],
      });
      expect(JSON.parse(readH04Pin(result.receipt).toString()) as unknown).toMatchObject({
        kind: 'h06-native-temporal-pause-ack',
        ack: f.held.command,
      });
      expect(assert).toHaveBeenCalledTimes(2);
    },
  );

  it('delivers only to the pinned run and retains a verified acknowledgement', async () => {
    const f = await authorized();
    await verifyH06NativeTemporalResume(f.request, f.issuer, f.command);
    expect(f.getHandle).not.toHaveBeenCalled();
    const result = await deliverH06NativeTemporalResume(
      f.request,
      f.issuer,
      f.client,
      f.command,
      f.deadline,
    );
    expect(f.getHandle.mock.calls).toEqual([
      [f.target.workflowId, f.status.runId],
      [f.target.workflowId, f.status.runId],
    ]);
    expect(f.executeUpdate).toHaveBeenCalledExactlyOnceWith('taskExecutionControl', {
      args: [f.command],
    });
    expect(JSON.parse(readH04Pin(result.receipt).toString()) as unknown).toMatchObject({
      kind: 'h06-native-temporal-resume-ack',
      ack: result.ack,
      runId: f.status.runId,
    });
  });

  it.each(['notice', 'live-state', 'lost-response'] as const)(
    'refuses unsafe RESUME delivery (%s)',
    async (which) => {
      const f = await authorized();
      const deliver = () =>
        deliverH06NativeTemporalResume(f.request, f.issuer, f.client, f.command, f.deadline);
      if (which === 'notice') f.removeNotice();
      if (which === 'live-state') f.status.result.waiting = false;
      if (which === 'lost-response')
        f.executeUpdate.mockRejectedValueOnce(new Error('update response lost'));
      await expect(deliver()).rejects.toThrow();
      if (which === 'lost-response') {
        expect(existsSync(f.intent)).toBe(true);
        await expect(deliver()).rejects.toThrow('h06-temporal-resume-outcome-unknown');
        expect(f.executeUpdate).toHaveBeenCalledTimes(1);
        expect(f.getHandle).toHaveBeenCalledTimes(2);
      } else {
        expect(f.executeUpdate).not.toHaveBeenCalled();
        expect(existsSync(f.intent)).toBe(false);
      }
    },
  );

  it('returns the original ACK on an exact retry without a current transcript or an SDK call', async () => {
    const f = await authorized();
    expect(readH06NativeTemporalResumeReceipt(f.request, f.command)).toBeNull();
    const result = await deliverH06NativeTemporalResume(
      f.request,
      f.issuer,
      f.client,
      f.command,
      f.deadline,
    );
    unlinkSync(f.transcript);
    const retained = readH06NativeTemporalResumeReceipt(f.request, f.command);
    expect(retained).toEqual({ ...result, opened: null });
    await expect(
      deliverH06NativeTemporalResume(f.request, f.issuer, f.client, f.command, 0),
    ).resolves.toEqual(result);
    expect(f.getHandle).toHaveBeenCalledTimes(2);
    expect(f.executeUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'changed-command',
    'missing-intent',
    'wrong-request',
    'wrong-run',
    'wrong-ack',
    'missing-workflow-intent',
    'wrong-workflow-intent',
    'missing-workflow-record',
    'wrong-workflow-record',
    'wrong-transition',
    'wrong-proof',
    'wrong-opening',
  ] as const)('refuses readback from %s without another update', async (which) => {
    const f = await authorized();
    const result = await deliverH06NativeTemporalResume(
      f.request,
      f.issuer,
      f.client,
      f.command,
      f.deadline,
    );
    const amend = (path: string, change: Record<string, unknown>) =>
      writeFileSync(
        path,
        JSON.stringify({ ...object(JSON.parse(readFileSync(path, 'utf8'))), ...change }),
      );
    const rebind = () =>
      amend(result.receipt.path, {
        intent: { path: f.intent, sha256: digest(readFileSync(f.intent)) },
      });
    if (which === 'missing-intent') unlinkSync(f.intent);
    if (which === 'wrong-request') {
      amend(f.intent, { request: null });
      rebind();
    }
    if (which === 'wrong-run') amend(result.receipt.path, { runId: 'wrong-run' });
    if (which === 'wrong-ack')
      amend(result.receipt.path, { ack: { ...result.ack, hash: digest('other') } });
    if (which === 'missing-workflow-intent') unlinkSync(f.workflowIntent);
    if (which === 'wrong-workflow-intent') amend(f.workflowIntent, { command: null });
    if (which === 'missing-workflow-record') unlinkSync(f.workflowRecord);
    if (which === 'wrong-workflow-record') amend(f.workflowRecord, { next: null });
    if (which === 'wrong-transition')
      amend(result.receipt.path, { ack: { ...result.ack, authorization: f.save({}) } });
    if (which === 'wrong-proof') {
      amend(f.intent, { proof: f.save({}) });
      rebind();
    }
    if (which === 'wrong-opening') {
      amend(f.intent, { opened: result.receipt });
      rebind();
    }
    const command =
      which === 'changed-command'
        ? makeTaskExecutionCommand({ ...f.command, source: f.save({ different: true }) })
        : f.command;
    await expect(
      deliverH06NativeTemporalResume(f.request, f.issuer, f.client, command, f.deadline),
    ).rejects.toThrow();
    expect(f.getHandle).toHaveBeenCalledTimes(2);
    expect(f.executeUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'ready',
    'matching-session-marker',
    'not-live',
    'missing-create',
    'pending-create',
    'create-kind',
    'create-input',
    'create-processes',
    'create-session',
    'create-session-null',
    'create-thread-cwd',
    'create-cwd',
    'create-model',
    'create-effort',
    'create-snapshot',
    'marker-session',
    'pending-ledger',
    'reader',
    'root',
    'session',
    'profile',
    'load',
    'no-response',
    'empty',
    'expired',
    'host',
  ] as const)(
    'waits for a bound live implementation dispatch before phase intent: %s',
    async (kind) => {
      const f = paused(1),
        workspace = join(f.root, 'source');
      mkdirSync(workspace);
      f.start.workspaceRoot = workspace;
      writeFileSync(join(f.start.hostRoot, 'host-owner'), JSON.stringify(f.start.hostOwner));
      const files = taskFiles(f.artifactRoot, { existingOnly: true });
      const source = files.binding(workspace),
        copy = files.binding(f.root);
      const snapshotBody = {
        kind: 'substantial-task',
        schemaVersion: 3,
        input: f.input,
        profile: f.start.profile,
        source,
        copy,
      };
      const snapshot = f.save(snapshotBody);
      const writing = {
        ...f.status.result,
        phase: 'writing',
        waiting: false,
        revision: f.pause.expectedRevision,
        snapshot,
      };
      f.query.mockResolvedValue(writing);
      const asserted = vi.fn();
      vi.spyOn(taskGate, 'taskGate').mockReturnValue({
        assert: asserted,
        directory: f.root,
        admission: () => ({ mode: 'owned' }),
      } as unknown as ReturnType<typeof taskGate.taskGate>);
      const processes = [{ pid: 123, parent: 1, started: 'process-start' }];
      writeFileSync(
        join(f.root, 'writer-runtime.json'),
        JSON.stringify({ kind: 'task-writer-starting', input: f.input }),
      );
      const marker = JSON.stringify({
        session:
          kind === 'matching-session-marker'
            ? 'writer'
            : kind === 'marker-session'
              ? 'other'
              : null,
        processes,
      });
      writeFileSync(join(f.root, 'runtime-identity.json'), marker);
      vi.spyOn(NativeWriterProcesses.prototype, 'alive').mockResolvedValue(
        kind === 'not-live' ? [] : processes,
      );
      const creation = {
        kind: kind === 'create-kind' ? 'other' : 'task-writer-session',
        input: kind === 'create-input' ? f.initial : f.input,
        identity: {
          session:
            kind === 'create-session-null' ? null : kind === 'create-session' ? 'other' : 'writer',
          processes:
            kind === 'create-processes'
              ? [{ ...processes[0]!, started: 'other-start' }]
              : processes,
        },
        raw: {
          thread: { id: 'writer', cwd: kind === 'create-thread-cwd' ? workspace : copy.root },
          cwd: kind === 'create-cwd' ? workspace : copy.root,
          model: kind === 'create-model' ? 'other' : f.start.profile.model,
          reasoningEffort: kind === 'create-effort' ? 'other' : f.start.profile.effort,
        },
      };
      const createIntent = {
        projectId: f.target.projectId,
        taskId: f.target.taskId,
        operationId: `task-create-${digest(localTaskKey(f.input))}-a1`,
        requestHash: digest(
          JSON.stringify({
            snapshot:
              kind === 'create-snapshot'
                ? { ...snapshotBody, profile: { ...f.start.profile, model: 'other' } }
                : snapshotBody,
          }),
        ),
        hostId: f.target.hostId,
        workspaceId: f.target.workspaceId,
        owner: f.target.owner,
        generation: f.target.generation,
      };
      if (kind !== 'missing-create') {
        const journal = effectJournal(join(f.root, 'writer-effects'));
        if (kind === 'pending-create')
          await expect(
            journal.execute(createIntent, async () => {
              throw new Error('fixture-pending');
            }),
          ).rejects.toThrow('fixture-pending');
        else await journal.execute(createIntent, async () => f.save(creation));
      }
      writeFileSync(join(f.root, 'attempt-claim.json'), '{}');
      const scope = {
        role: kind === 'reader' ? 'reader' : 'writer',
        root: kind === 'root' ? workspace : f.root,
        session: kind === 'session' ? 'other' : 'writer',
        operation: `task-${kind === 'profile' ? 'profile' : kind === 'load' ? 'load' : 'implement'}-${digest(localTaskKey(f.input))}-a1`,
      };
      const deadline = Date.now() + 10000;
      const ledger = {
        status: kind === 'pending-ledger' ? 'UNKNOWN' : 'RECORDED',
        admissions:
          kind === 'empty'
            ? []
            : [{ scope, response: kind === 'no-response' ? null : { turnId: 'implementation' } }],
      };
      vi.spyOn(nativeAttempt, 'openH06NativeAttemptTurnLedger').mockReturnValue({
        inspect: () => {
          if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(deadline);
          return ledger;
        },
      } as unknown as ReturnType<typeof nativeAttempt.openH06NativeAttemptTurnLedger>);
      if (kind === 'host') f.start.hostRoot = join(f.root, 'foreign-host');
      const observation = observeH06NativeTemporalWriterReady(
        f.client,
        f.startPin(),
        f.status.runId,
        deadline,
      );
      if (kind === 'expired' || kind === 'host')
        await expect(observation).rejects.toThrow(
          kind === 'expired' ? 'h06-temporal-pause-deadline' : 'h06-temporal-pause-host',
        );
      else if (kind.startsWith('create-') || kind === 'marker-session')
        await expect(observation).rejects.toThrow();
      else
        await expect(observation).resolves.toBe(
          kind === 'ready' || kind === 'matching-session-marker',
        );
      expect(readFileSync(join(f.root, 'runtime-identity.json'), 'utf8')).toBe(marker);
      expect(existsSync(join(f.root, 'pause-3-intent.json'))).toBe(false);
      expect(f.executeUpdate).not.toHaveBeenCalled();
      expect(asserted).toHaveBeenCalledTimes(1);
    },
  );

  it('delivers autonomous PAUSE using a real initial-grant proof while retaining live-process guards', async () => {
    const f = paused(1),
      workspace = join(f.root, 'source');
    mkdirSync(workspace);
    const mode = {
      kind: 'temporal-autonomous/3',
      authority: { path: join(f.root, 'parent.json'), sha256: digest('{}') },
    } as const;
    writeFileSync(mode.authority.path, '{}');
    f.start.controlMode = mode;
    f.start.workspaceRoot = workspace;
    f.start.firstExecutionRunId = f.status.runId;
    writeFileSync(join(f.start.hostRoot, 'host-owner'), JSON.stringify(f.start.hostOwner));
    const files = taskFiles(f.artifactRoot, { existingOnly: true });
    const snapshot = f.save({
      kind: 'substantial-task',
      schemaVersion: 3,
      input: f.input,
      profile: f.start.profile,
      source: files.binding(workspace),
      copy: files.binding(f.root),
    });
    const writing = {
      ...f.status.result,
      phase: 'writing',
      waiting: false,
      revision: f.pause.expectedRevision,
      snapshot,
    };
    f.query.mockResolvedValue(writing);
    const issuer = {
      sessionsRoot: f.root,
      workspaceRoot: f.root,
      owner: f.target.owner,
      threadId: 'issuer',
    };
    const path = join(f.root, 'bootstrap.json'),
      bytes = JSON.stringify({ input: f.initial });
    writeFileSync(path, bytes);
    const deadline = Date.now() + 10000;
    vi.spyOn(parentAuthority, 'readH06TemporalAutonomousAuthority').mockReturnValue({
      request: {
        evidenceRoot: f.root,
        bootstrap: { path, sha256: digest(bytes) },
        chat: { threadId: issuer.threadId, workspace: issuer.workspaceRoot },
      },
      grant: { sessionsRoot: f.root },
      workDeadlineMs: deadline,
    } as unknown as ReturnType<typeof parentAuthority.readH06TemporalAutonomousAuthority>);
    const started = f.startPin(),
      request = {
        started,
        runId: f.status.runId,
        commandId: 'h06-cold-pause',
        reason: 'Approved autonomous pause',
      };
    const { command } = await issueH06NativeTemporalPause(
      f.client,
      request,
      issuer,
      {
        kind: 'h06-temporal-autonomous-phase/3',
        mode,
        started,
        runId: f.status.runId,
        phase: 'cold-pause',
      },
      deadline,
    );
    const gateAssert = vi.fn();
    vi.spyOn(taskGate, 'taskGate').mockReturnValue({
      assert: gateAssert,
      directory: f.root,
      admission: () => ({ mode: 'owned' }),
    } as unknown as ReturnType<typeof taskGate.taskGate>);
    const processes = [{ pid: 123, parent: 1, started: 'process-start' }];
    vi.spyOn(taskWriter, 'inspectTaskWriter').mockResolvedValue({
      status: 'live',
      runtime: { session: null, processes },
      processes,
    });
    vi.spyOn(NativeWriterProcesses.prototype, 'descendants').mockResolvedValue(processes);
    const verified = await h06TemporalControlAuthority(files.store, issuer, mode).verify(command);
    const authorization = f.save({
      kind: 'task-execution-interruption',
      input: f.input,
      command,
      authorization: verified.proof,
    });
    const ack = {
      commandId: command.commandId,
      hash: command.hash,
      revision: command.expectedRevision + 1,
      authorization,
    };
    f.executeUpdate.mockResolvedValue(ack);
    await expect(
      pauseH06NativeTemporal(f.client, started, f.status.runId, command, issuer, deadline),
    ).resolves.toMatchObject({ ack });
    expect(verified.origin).toBe('initial-grant');
    expect(gateAssert).toHaveBeenCalledTimes(2);
    expect(f.executeUpdate).toHaveBeenCalledExactlyOnceWith('taskExecutionControl', {
      args: [command],
    });
  });

  it.each([
    'warm',
    'cold-retained',
    'cold-closed',
    'autonomous-warm',
    'autonomous-cold-retained',
    'autonomous-cold-closed',
  ] as const)('reopens the retained host for %s RESUME', async (mode) => {
    const autonomous = mode.startsWith('autonomous-'),
      flavor = mode.replace('autonomous-', '');
    const phase = flavor === 'warm' ? 'warm' : 'cold';
    const f = await authorized(phase === 'warm' ? 0 : 1, autonomous);
    const { hostRoot, profile, taskQueue, workflowsPath, maxTurnStarts } = f.start;
    const ownerPath = join(hostRoot, 'host-owner');
    const registration = {
      ...f.initial.admission.preparation,
      workspaceRoot: f.start.workspaceRoot,
      artifactRoot: f.artifactRoot,
      commands: {},
    };
    const stopTransport = vi.fn(async () => {
      expect(existsSync(ownerPath)).toBe(false);
    });
    const services = {
      client: f.client,
      connection: {} as NativeConnection,
      registration,
      profile,
      openProject: vi.fn(async () => ({
        rpc: { request: vi.fn(), completed: vi.fn() },
        localTasks: { profile, createRuntime: vi.fn() },
        stop: stopTransport,
      })),
      issuer: f.issuer,
      taskQueue,
      workflowsPath,
      maxTurnStarts,
      workDeadlineMs: f.deadline,
    };
    const owner = { ...f.start.hostOwner, id: 'new-host' };
    hosts.create.mockImplementation(async () => {
      expect(existsSync(ownerPath)).toBe(false);
      writeFileSync(ownerPath, JSON.stringify(owner));
      return {
        async runUntil<T>(run: () => Promise<T>) {
          try {
            return await run();
          } finally {
            unlinkSync(ownerPath);
          }
        },
      };
    });
    const old = { ...owner, id: 'warm-host', pid: 2147483647 };
    const warmPath = join(f.root, 'temporal-warm-host.json');
    const warmBytes = JSON.stringify({
      kind: 'h06-native-temporal-reopen',
      phase: 'warm',
      started: f.request.started,
      hostRoot,
      owner: old,
    });
    if (phase === 'cold') {
      writeFileSync(warmPath, warmBytes);
    }
    if (flavor === 'cold-retained') {
      writeFileSync(ownerPath, JSON.stringify(old));
      hosts.recover.mockImplementation(async () => {
        unlinkSync(ownerPath);
        return { owner: old, proofs: [] };
      });
    }
    if (flavor === 'cold-closed')
      vi.spyOn(NativeWriterProcesses.prototype, 'descendants').mockResolvedValue([]);
    const opening: Parameters<typeof reopenH06NativeTemporal>[3] =
      phase === 'warm'
        ? ({ phase } as const)
        : {
            phase,
            warm: { path: warmPath, sha256: digest(warmBytes) },
            readers: [],
            tasks: [f.input],
          };
    const result = await reopenH06NativeTemporal(
      f.request,
      services,
      f.command,
      opening,
      async (resume, opened) => {
        expect(JSON.parse(readH04Pin(opened).toString()) as unknown).toMatchObject({
          phase,
          owner,
        });
        expect(JSON.parse(readFileSync(f.intent, 'utf8')) as unknown).toMatchObject({ opened });
        return resume;
      },
    );
    expect(result.ack.commandId).toBe(f.command.commandId);
    expect(hosts.recover).toHaveBeenCalledTimes(flavor === 'cold-retained' ? 1 : 0);
    expect(hosts.create).toHaveBeenCalledTimes(1);
    expect(stopTransport).toHaveBeenCalledTimes(1);
    expect(existsSync(ownerPath)).toBe(false);
    const runAgain = vi.fn();
    const retained = await reopenH06NativeTemporal(
      f.request,
      services,
      f.command,
      opening,
      runAgain,
    );
    expect(retained).toMatchObject(result);
    expect(readH06NativeTemporalResumeReceipt(f.request, f.command, opening)).toEqual(retained);
    expect(runAgain).not.toHaveBeenCalled();
    expect(hosts.create).toHaveBeenCalledTimes(1);
    expect(f.executeUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('H06 native RESUME plan', () => {
  it('binds the canonical command to verified held and stop evidence without publishing anything', () => {
    const f = fixture();
    const request = f.request();
    const before = f.snapshot();
    const plan = planH06NativeResume(request);
    const payload = {
      schemaVersion: 1,
      kind: 'task-execution-resume',
      held: f.status.result.held,
      admission: f.input.admission,
    };
    const command = {
      schemaVersion: 2 as const,
      commandId: request.commandId,
      action: 'resume' as const,
      author: f.target.owner,
      target: f.target,
      expectedRevision: 3,
      attempt: 2,
      payload: {
        sha256: digest(JSON.stringify(payload)),
        bytes: Buffer.byteLength(JSON.stringify(payload)),
      },
    };
    expect(plan).toMatchObject({
      kind: 'h06-native-resume-plan',
      mayRun: false,
      authority: null,
      qualification: false,
      workflowId: f.target.workflowId,
      runId: f.status.runId,
      held: f.status.result.held,
      payload,
    });
    expect(plan.command).toEqual(command);
    expect(plan.authorizationText).toBe(
      nativeHumanAuthorizationText({
        ...command,
        source: f.held.command.authorization,
        hash: digest('unused by formatter'),
      }),
    );
    expect(f.snapshot()).toEqual(before);
  });

  it.each([
    { workflowId: 'foreign-workflow' },
    { runId: 'foreign-run' },
    { query: 'localTaskInput' },
  ])('refuses an unrelated status envelope %j', (change) => {
    const f = fixture();
    Object.assign(f.status, change);
    expect(() => planH06NativeResume(f.request())).toThrow();
  });

  it.each([
    { runId: 'another-run' },
    { phase: 'running' },
    { waiting: false },
    { revision: 0 },
    { revision: 1.5 },
    { revision: '3' },
    { revision: Number.MAX_SAFE_INTEGER },
    { revision: 4 },
    { attempt: 0 },
    { requirementsRevision: 3 },
    { stopFailure: 'unknown' },
    { budgetFailure: 'unknown' },
    { checkpointFailure: 'unknown' },
    { commands: [] },
    { commands: null },
  ])('refuses unsafe status %j', (change) => {
    const f = fixture();
    Object.assign(f.status.result, change);
    expect(() => planH06NativeResume(f.request())).toThrow();
  });

  it.each([
    { kind: 'other-stop' },
    { schemaVersion: 1 },
    { confirmed: false },
    { session: null, processes: [] },
    { notStarted: true },
    { processes: [] },
    { processes: null },
    { session: '' },
    { runtime: { session: 'foreign', processes: [] } },
    { runtime: { session: 'writer-session', processes: null } },
    { runtime: { session: 'writer-session', processes: [] } },
    { source: { root: 'other' } },
    { terminals: null },
    { before: { directories: [] } },
    { before: { files: [] } },
    { primary: { thread: { id: 'foreign' } } },
    { copy: { root: 'foreign' } },
    { primary: { thread: { id: 'writer-session', turns: [] } } },
    { after: { 'late-write': digest('changed') } },
  ])('refuses insufficient physical stop evidence %j', (change) => {
    const f = fixture();
    f.rewriteWriter(change);
    expect(() => planH06NativeResume(f.request())).toThrow();
  });

  it.each([
    { used: '0' },
    { used: 0.5 },
    { used: -1 },
    { limit: '15' },
    { limit: 1.5 },
    { used: 15 },
  ])('refuses malformed or exhausted budget %j', (change) => {
    const f = fixture();
    Object.assign(f.status.result.budget, change);
    expect(() => planH06NativeResume(f.request())).toThrow('h06-resume-budget-unconfirmed');
  });

  it.each(['kind', 'input', 'action', 'hash', 'proof-kind', 'proof-command'] as const)(
    'refuses conflicting pause evidence (%s)',
    (which) => {
      const f = fixture();
      const changes = {
        kind: { kind: 'other' },
        input: { input: {} },
        action: { command: { ...f.pause, action: 'cancel' } },
        hash: { command: { ...f.pause, hash: digest('changed') } },
        'proof-kind': { authorization: f.save({ kind: 'other' }) },
        'proof-command': {
          authorization: f.save({ kind: 'reader-native-human-authorization', command: {} }),
        },
      };
      f.rewritePause(changes[which]);
      expect(() => planH06NativeResume(f.request())).toThrow();
    },
  );

  it.each(['earlier-pause', 'earlier-resume'])(
    'refuses reusing an earlier command ID %s',
    (commandId) => {
      const f = fixture();
      expect(() => planH06NativeResume({ ...f.request(), commandId })).toThrow(
        'h06-resume-command-id-used',
      );
    },
  );

  it.each(['missing', 'revision', 'workflow', 'hash', 'duplicate'] as const)(
    'refuses invalid retained command history (%s)',
    (which) => {
      const f = fixture();
      const ref = f.status.result.commands[0]!;
      if (which === 'missing') {
        unlinkSync(join(f.artifactRoot, ref.sha256));
        expect(() => planH06NativeResume(f.request())).toThrow();
        return;
      }
      const command = makeTaskExecutionCommand({
        ...f.pause,
        expectedRevision: which === 'revision' ? 1 : 0,
        target: { ...f.target, workflowId: which === 'workflow' ? 'other' : f.target.workflowId },
      });
      f.status.result.commands[0] = f.save({
        kind: 'task-execution-interruption',
        command: which === 'hash' ? { ...command, hash: digest('corrupt') } : command,
      });
      expect(() => planH06NativeResume(f.request())).toThrow(
        which === 'duplicate' ? 'h06-resume-command-id-used' : 'h06-resume-command-history',
      );
    },
  );

  it.each([
    { kind: 'other-budget' },
    { schemaVersion: 2 },
    { limit: 14 },
    { credits: null },
    { credits: [{ index: 0 }] },
  ])('refuses a retained budget inconsistent with status %j', (change) => {
    const f = fixture();
    f.status.result.budget.manifest = f.save({
      schemaVersion: 1,
      kind: 'task-model-budget',
      limit: 15,
      credits: [],
      ...change,
    });
    expect(() => planH06NativeResume(f.request())).toThrow('h06-resume-budget-binding');
  });

  it.each([
    ['proof', 'source', {}],
    ['session', 'id', 'other'],
    ['session', 'session_id', 'other'],
    ['user', 'line', 6],
    ['raw', 'type', 'other'],
    ['event', 'type', 'other'],
    ['event', 'thread_id', 'other'],
    ['event', 'turn_id', 'other'],
    ['item', 'type', 'other'],
    ['item', 'status', 'failed'],
    ['item', 'exit_code', 1],
    ['item', 'aggregated_output', null],
    ['item', 'aggregated_output', 'wrong notice'],
  ])('refuses conflicting native evidence %s.%s', (section, key, value) => {
    const f = fixture();
    const proof = f.nativeAuthorization;
    const raw = proof.observed.issued.raw;
    const parts = {
      proof,
      session: proof.observed.session,
      user: { ...proof.observed.user },
      raw,
      event: raw.payload,
      item: raw.payload.item,
    };
    proof.observed.user = parts.user;
    Object.assign(parts[section as keyof typeof parts], { [String(key)]: value });
    f.rewritePause({ authorization: f.save(proof) });
    expect(() => planH06NativeResume(f.request())).toThrow('h06-resume-pause-authority');
  });

  it.each([{ kind: 'other-snapshot' }, { schemaVersion: 2 }, { input: {} }])(
    'refuses unbound held snapshot %j',
    (change) => {
      const f = fixture();
      const snapshot = object(
        JSON.parse(readFileSync(join(f.artifactRoot, f.held.progress.snapshot.sha256), 'utf8')),
      );
      f.status.result.held = f.save({
        ...f.held,
        progress: { ...f.held.progress, snapshot: f.save({ ...snapshot, ...change }) },
      });
      expect(() => planH06NativeResume(f.request())).toThrow('h06-resume-snapshot-binding');
    },
  );

  it('refuses an incomplete progress artifact list', () => {
    const f = fixture();
    unlinkSync(join(f.artifactRoot, f.held.progress.records[0]!.sha256));
    expect(() => planH06NativeResume(f.request())).toThrow();
    f.status.result.held = f.save({ ...f.held, progress: { ...f.held.progress, records: null } });
    expect(() => planH06NativeResume(f.request())).toThrow('h06-resume-snapshot-binding');
  });

  const validProcess = { pid: 123, parent: 1, started: 'recorded-process-start' };
  it.each([
    { pid: '123' },
    { pid: 123.5 },
    { pid: 1 },
    { parent: '1' },
    { parent: 1.5 },
    { parent: -1 },
    { started: 1 },
    { started: '' },
  ])('refuses malformed stopped identity %j', (change) => {
    const f = fixture();
    f.rewriteWriter({ processes: [{ ...validProcess, ...change }] });
    expect(() => planH06NativeResume(f.request())).toThrow('h06-resume-process-identity');
  });

  it.each(
    [[validProcess, validProcess], [{ ...validProcess, started: 'reused-pid' }]].map(
      (processes) => ({ processes }),
    ),
  )('refuses inconsistent stopped identity %j', ({ processes }) => {
    const f = fixture();
    f.rewriteWriter({ processes });
    expect(() => planH06NativeResume(f.request())).toThrow('h06-resume-process-binding');
  });

  it('refuses reusing the pause command ID for RESUME', () => {
    const f = fixture();
    expect(() => planH06NativeResume({ ...f.request(), commandId: f.pause.commandId })).toThrow(
      'h06-resume-command-id-used',
    );
  });

  it.each([
    'held-kind',
    'input-version',
    'ack-id',
    'ack-hash',
    'commands',
    'stop-kind',
    'stop-input',
    'stop-confirmed',
    'writer-input',
    'running-turn',
    'non-array-turns',
  ] as const)('refuses a broken evidence link (%s)', (which) => {
    const f = fixture();
    const { continuation: _continuation, ...input } = f.input;
    const changes = {
      'held-kind': { kind: 'other' },
      'input-version': { input: { ...input, schemaVersion: 3 } },
      'ack-id': { command: { ...f.held.command, commandId: 'another-command' } },
      'ack-hash': { command: { ...f.held.command, hash: digest('other') } },
      commands: {},
      'stop-kind': { stopped: f.save({ ...f.stopped, kind: 'other' }) },
      'stop-input': { stopped: f.save({ ...f.stopped, input: {} }) },
      'stop-confirmed': { stopped: f.save({ ...f.stopped, confirmed: false }) },
      'writer-input': {},
      'running-turn': {},
      'non-array-turns': {},
    };
    f.status.result.held = f.save({ ...f.held, ...changes[which] });
    if (which === 'commands') f.status.result.commands[2] = f.manifest;
    if (which === 'writer-input') f.rewriteWriter({ input: {} });
    if (which === 'running-turn' || which === 'non-array-turns') {
      const turns = which === 'running-turn' ? [{ status: 'running' }] : null;
      f.rewriteWriter({ primary: { thread: { id: 'writer-session', cwd: f.root, turns } } });
    }
    expect(() => planH06NativeResume(f.request())).toThrow();
  });

  it('refuses a changed status pin and leaves the inputs in place', () => {
    const f = fixture();
    const request = f.request();
    writeFileSync(request.status.path, 'changed');
    const before = f.snapshot();
    expect(() => planH06NativeResume(request)).toThrow();
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['held', 'budget', 'authorization'] as const)('refuses missing %s bytes', (which) => {
    const f = fixture();
    const refs = {
      held: f.status.result.held,
      budget: f.manifest,
      authorization: f.held.command.authorization,
    };
    unlinkSync(join(f.artifactRoot, refs[which].sha256));
    expect(() => planH06NativeResume(f.request())).toThrow();
  });

  it.each([{ kind: 'wrong' }, { artifactRoot: 'relative/artifacts' }])(
    'refuses invalid request fields %j',
    (change) => {
      const f = fixture();
      expect(() => planH06NativeResume({ ...f.request(), ...change })).toThrow();
    },
  );

  it('refuses authority fields in the plan request', () => {
    const f = fixture();
    expect(() => planH06NativeResume({ ...f.request(), authority: 'forged' })).toThrow();
  });
});

describe('H06 native RESUME CLI', () => {
  it.each([{ args: [] }, { args: ['--run', 'request.json'] }])(
    'refuses unsupported arguments %j',
    ({ args }) => {
      expect(() => h06NativeResumeMain(args)).toThrow('h06-resume-arguments');
    },
  );

  it('returns the same proposal when reading a request file', () => {
    const f = fixture();
    const request = f.request();
    const path = join(f.root, 'request.json');
    writeFileSync(path, JSON.stringify(request));
    expect(h06NativeResumeMain(['--plan', path])).toEqual(planH06NativeResume(request));
  });

  it.each([true, false])(
    'handles the direct-entry guard with a script argument: %s',
    async (direct) => {
      const f = fixture();
      const request = f.request();
      const path = join(f.root, 'request.json');
      writeFileSync(path, JSON.stringify(request));
      const expected = planH06NativeResume(request);
      const argv = process.argv;
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      try {
        process.argv = direct
          ? [
              argv[0]!,
              fileURLToPath(new URL('./comparisonH06NativeResume.ts', import.meta.url)),
              '--plan',
              path,
            ]
          : [argv[0]!];
        vi.resetModules();
        await import('./comparisonH06NativeResume.js');
        if (direct) expect(write).toHaveBeenCalledWith(JSON.stringify(expected) + '\n');
        else expect(write).not.toHaveBeenCalled();
      } finally {
        process.argv = argv;
        write.mockRestore();
      }
    },
  );
});
