import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment, TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime } from '@temporalio/worker';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import { createReaderHost } from '../src/worker/readerHost.js';
import { startLocalTask } from '../src/client/localTask.js';
import { bindTaskBackendClient } from '../src/client/taskBackend.js';
import { controlTaskExecution, makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import type { TaskWriterRuntime } from '../src/contracts/localTask.js';
import type { PayloadReaderCommand } from '../src/contracts/readerControl.js';
import type { ProcessIdentity } from '../src/contracts/writerProcesses.js';
import { object } from '../src/contracts/project.js';
import { parseLocalTask, localTaskKey } from '../src/policy/localTask.js';
import { localPlanningRisks } from '../src/policy/localPlanning.js';
import { localTaskActivities } from '../src/activities/localTask.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  h06TemporalControlAuthority,
  publishH06TemporalControlSource,
  type H06TemporalControlPhase,
  readH06TemporalControlMode,
} from './comparisonH06TemporalAutonomousControls.js';
import {
  planH06TemporalAutonomousAuthority,
  consumeH06TemporalAutonomousAuthority,
  readH06TemporalAutonomousAuthority,
  openH06TemporalAutonomousNativeClaim,
} from './comparisonH06TemporalAutonomousAuthority.js';
import { readH06NativeAttemptForReopen } from './comparisonH06NativeAttempt.js';
import {
  captureH06NativePausedStatus,
  readH06NativeHostOwner,
  withH06TemporalProject,
  type H06TemporalStage,
} from './comparisonH06NativeTemporal.js';
import { reopenH06NativeTemporalOperator } from './comparisonH06NativeTemporalOperator.js';
import {
  assertH06NativeReaderNotBlocked,
  withH06NativeReaderFailure,
} from './comparisonH06NativeReaderFailure.js';
const roots: string[] = [],
  children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-temporal-operator-'));
  roots.push(root);
  const workspaceRoot = join(root, 'material');
  const chatRoot = join(root, 'chat');
  const sessions = join(root, 'sessions');
  for (const dir of [workspaceRoot, chatRoot, sessions]) mkdirSync(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: workspaceRoot, stdio: 'pipe' });
  const materials = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  for (const [name, bytes] of Object.entries(
    materials.cases.find(({ id }) => id === 'H-06')!.files,
  ))
    writeFileSync(join(workspaceRoot, name), bytes);
  mkdirSync(join(workspaceRoot, 'tasks'));
  mkdirSync(join(workspaceRoot, 'evidence'));
  const file = (name: string, bytes: string, directory = root) => {
    const path = join(directory, name);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const workFiles = Object.fromEntries(
    ['rules.md', 'review.md', 'tasks/card.md', 'executor.md'].map((name) => [
      name,
      file(name, name, workspaceRoot).sha256,
    ]),
  );
  const basis = { locator: 'rules.md', hash: workFiles['rules.md']! };
  const evidenceBasis = {
    locator: 'evidence/README.md',
    hash: file('evidence/README.md', 'H06 evidence directory', workspaceRoot).sha256,
  };
  const plan = {
    schema_version: 2,
    plan_id: 'h06',
    requirement: basis,
    basis: [basis, evidenceBasis],
    owner: basis,
    consumers: [basis],
    consumers_complete: true,
    paths: ['evidence/manifest.json'],
    risks: Object.fromEntries(localPlanningRisks.map((risk) => [risk, risk === 'new_behavior'])),
    reason: 'Observe continuity',
    checks: ['syntax', 'validate'],
    criterion: 'Preserve the owner',
  };
  workFiles['plan.json'] = file('plan.json', JSON.stringify(plan), workspaceRoot).sha256;
  const operationId = 'h06-temporal-operator';
  const workflows = file('workflows.js', 'workflows');
  function review(phase: string) {
    const bytes = JSON.stringify({
      schemaVersion: 1,
      phase,
      scope: 'h06',
      sharedPaths: ['checks.mjs', 'plan.json', 'evidence/README.md'],
      roles: [
        {
          roleId: 'reviewer',
          applies: true,
          reason: 'Observe continuity',
          paths: ['checks.mjs'],
          complete: true,
          attestedBy: 'H06 fixture',
          discoveryRule: 'scope',
          history: { complete: true, answers: [] },
        },
      ],
    });
    const pin = file(phase + '.json', bytes);
    return { pin, ref: { sha256: pin.sha256, bytes: Buffer.byteLength(bytes) } };
  }
  const planning = review('planning');
  const acceptance = review('acceptance');
  const profile = { model: 'fixture', effort: 'medium', clientVersion: '0.154.0' };
  const descriptor = {
    kind: 'comparison-h06-native-temporal-bootstrap/2',
    address: '127.0.0.1:7233',
    server: {
      httpPort: 7234,
      metricsPort: 7235,
      sqlitePath: join(root, operationId + '-server', 'temporal.sqlite'),
    },
    taskQueue: 'h06-queue',
    workflows,
    profile,
    disabledServers: ['a', 'b'],
    input: {
      schemaVersion: 11,
      admission: {
        schemaVersion: 3,
        preparation: {
          schemaVersion: 1,
          taskId: 'task',
          project: {
            schemaVersion: 1,
            projectId: 'project',
            workspaceId: 'workspace',
            rules: ['rules.md'],
            cardRoot: 'tasks',
            roles: [{ id: 'reviewer', profile: 'review.md' }],
            checks: ['syntax', 'validate'],
          },
          hostId: operationId,
          owner: 'operator',
          generation: 1,
          revision: 1,
          card: 'tasks/card.md',
        },
        plan: { path: 'plan.json', sha256: workFiles['plan.json']! },
        planning: planning.ref,
        acceptance: acceptance.ref,
      },
      executor: { path: 'executor.md', sha256: workFiles['executor.md']! },
      baseline: 'syntax',
      continuation: { attempt: 0, previous: null },
    },
    workspaceFiles: workFiles,
    artifacts: [planning.pin, acceptance.pin],
  };
  const request = {
    kind: 'comparison-h06-native/2',
    binding: {
      operationId,
      variant: 'temporal',
      workspaceRoot,
      node: file('node', 'node'),
      timeoutMs: 1000,
    },
    evidenceRoot: join(root, operationId),
    chat: { threadId: 'operator-thread', workspace: chatRoot },
    budget: {
      maxElapsedMs: 180000,
      reserveMs: 30000,
      maxManagedStarts: 24,
      maxInputUncached: 10000,
      maxOutput: 3000,
    },
    stimulus: { longStageMs: 35000, initialLeaseMs: null as number | null },
    appServer: file('app-server', 'app-server'),
    server: file('server', 'server') as ReturnType<typeof file> | null,
    bootstrap: file('bootstrap.json', JSON.stringify(descriptor)),
    runtime: [workflows, planning.pin, acceptance.pin],
  };
  vi.stubEnv('CODEX_HOME', root);
  vi.stubEnv('CODEX_THREAD_ID', request.chat.threadId);
  const input = {
    kind: 'comparison-h06-temporal-autonomous/3',
    attempt: file('attempt.json', JSON.stringify(request)),
    budget: { maxElapsedMs: 360000, stopReserveMs: 60000 },
  };
  function authority(body = planH06TemporalAutonomousAuthority(input).expectedGrantText) {
    const transcript = join(sessions, 'rollout-operator-thread.jsonl');
    const turnId = 'native-turn';
    const records = [
      {
        type: 'session_meta',
        payload: {
          id: request.chat.threadId,
          session_id: request.chat.threadId,
          cwd: chatRoot,
          cli_version: '0.166.0-alpha.6',
          source: 'vscode',
          originator: 'codex_work_desktop',
          thread_source: 'user',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      {
        type: 'turn_context',
        payload: {
          turn_id: turnId,
          cwd: chatRoot,
          model: 'fixture',
          effort: 'medium',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] },
      },
    ].map((record) => JSON.stringify(record) + '\n');
    writeFileSync(transcript, records.join(''));
    return {
      transcript,
      turnId,
      source: { locator: transcript + '#L4', hash: digest(records[3]!) },
    };
  }
  return { root, sessions, request, descriptor, authority, file, input };
}

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No fixture port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline)
      throw new Error('SDK fixture state timeout: ' + JSON.stringify(value));
    await delay(25);
  }
}

/** Model protocol boundary only; files, activities, gates, processes and SDK workflows are real. */
function rpcFixture(
  f: ReturnType<typeof fixture>,
  root: string,
  writer: number,
  counts: { readers: number; writerStarts: number[] },
  observeLoad?: () => Promise<void>,
  rejectLoad = false,
) {
  const profile = f.descriptor.profile,
    threads = new Map<string, Record<string, unknown>>();
  const child =
    writer === 0
      ? null
      : spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, stdio: 'ignore' });
  if (child !== null) children.push(child);
  const turns = (thread: Record<string, unknown>) => thread.turns as Record<string, unknown>[];
  const runtime: TaskWriterRuntime = {
    pid: child?.pid ?? process.pid,
    initialize: async () => {},
    close() {},
    async completed(session, id) {
      const turn = turns(threads.get(session)!).find((turn) => turn.id === id)!;
      if (turn.status !== 'inProgress') return;
      const signal = Context.current().cancellationSignal;
      if (signal.aborted) throw new CancelledFailure('Fixture model interrupted');
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new CancelledFailure('Fixture model interrupted')),
          { once: true },
        ),
      );
    },
    async request(method, params) {
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
      if (method === 'model/list')
        return {
          data: [
            { model: profile.model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
          ],
        };
      if (method === 'thread/start' || method === 'thread/resume') {
        const thread = threads.get(String(params.threadId)) ?? {
          id: writer === 0 ? 'review-' + ++counts.readers : 'writer-' + writer,
          cwd: root,
          path: join(f.root, 'native-writer-' + writer + '.jsonl'),
          turns: [],
          forkedFromId: null,
          parentThreadId: null,
          projectId: null,
        };
        threads.set(String(thread.id), thread);
        return {
          cwd: root,
          model: profile.model,
          reasoningEffort: profile.effort,
          approvalPolicy: 'never',
          sandbox:
            writer === 0
              ? { type: 'readOnly', networkAccess: false }
              : {
                  type: 'workspaceWrite',
                  networkAccess: false,
                  excludeSlashTmp: true,
                  excludeTmpdirEnvVar: true,
                  writableRoots: [root],
                },
          thread: structuredClone(thread),
        };
      }
      if (method === 'thread/loaded/list') return { data: [...threads.keys()], nextCursor: null };
      if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
      if (method === 'thread/read')
        return { thread: structuredClone(threads.get(String(params.threadId))) };
      if (method === 'turn/interrupt') {
        turns(threads.get(String(params.threadId))!).find(
          (turn) => turn.id === params.turnId,
        )!.status = 'interrupted';
        return {};
      }
      if (method !== 'turn/start') throw new Error('Unexpected fixture model method: ' + method);
      const thread = threads.get(String(params.threadId))!,
        text = String(object((params.input as unknown[])[0]).text),
        offset = text.indexOf('Пути и хеши: ');
      const implementation = writer > 0 && text.includes('Выполни локальный план');
      let items: Record<string, unknown>[];
      if (offset >= 0) {
        if (writer === 0) await observeLoad?.();
        const refs = JSON.parse(
          text.slice(offset + 'Пути и хеши: '.length, text.indexOf('. Для больших', offset)),
        ) as { path: string; sha256: string }[];
        items = [
          {
            type: 'commandExecution',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: rejectLoad
              ? 'Rejected cold Writer LOAD fixture'
              : refs
                  .map((ref) => JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }))
                  .join('\n'),
          },
        ];
      } else if (writer > 0) {
        if (implementation) {
          counts.writerStarts.push(writer);
          mkdirSync(join(root, 'evidence'), { recursive: true });
          writeFileSync(
            join(root, 'evidence', 'manifest.json'),
            JSON.stringify({
              initial_failure: 'F-01',
              sources: [{ locator: 'rules.md', hash: f.descriptor.workspaceFiles['rules.md'] }],
            }),
          );
        }
        items = [{ type: 'agentMessage', text: 'Fixture model response; no real model call.' }];
      } else {
        const begin = text.indexOf('Markdown: ') + 'Markdown: '.length;
        const report = object(
          JSON.parse(text.slice(begin, text.indexOf('. PASS несовместим', begin))),
        );
        Object.assign(report, {
          verdict: 'PASS',
          coverage: 'complete',
          findings: [],
          limitations: ['Model boundary fixture'],
        });
        items = [{ type: 'agentMessage', text: JSON.stringify(report) }];
      }
      const id = 'turn-' + (turns(thread).length + 1),
        turn = {
          id,
          status: implementation && writer < 3 ? 'inProgress' : 'completed',
          items: [{ type: 'userMessage', content: params.input }, ...items],
        };
      turns(thread).push(turn);
      if (writer > 0)
        writeFileSync(
          String(thread.path),
          [
            {
              type: 'session_meta',
              payload: { id: thread.id, cwd: root, cli_version: profile.clientVersion },
            },
            ...turns(thread).map((turn) => ({
              type: 'turn_context',
              payload: {
                turn_id: turn.id,
                cwd: root,
                model: profile.model,
                effort: profile.effort,
                approval_policy: 'never',
                sandbox_policy: {
                  type: 'workspace-write',
                  network_access: false,
                  exclude_slash_tmp: true,
                  exclude_tmpdir_env_var: true,
                },
                permission_profile: {
                  type: 'managed',
                  network: 'restricted',
                  file_system: {
                    type: 'restricted',
                    entries: [{ access: 'write', path: { type: 'path', path: root } }],
                  },
                },
              },
            })),
          ]
            .map(canonical)
            .join('\n') + '\n',
        );
      return { turn: { id } };
    },
  };
  return runtime;
}

it('preserves the real parent authority through native claim reopen before the SDK stage factory', async () => {
  const f = fixture(),
    parent = await consumeH06TemporalAutonomousAuthority(f.input, f.authority()),
    native = openH06TemporalAutonomousNativeClaim(parent.receipt),
    reopened = readH06NativeAttemptForReopen(native.receipt);
  expect(reopened.grant).toMatchObject({
    admission: { kind: 'temporal-autonomous/3', authority: parent.receipt },
  });
  expect(reopened.requestHash).toBe(parent.requestHash);
  expect(reopened.workDeadlineMs).toBe(parent.workDeadlineMs);
  expect(reopened.stopDeadlineMs).toBe(parent.stopDeadlineMs);
});

it.each([false, true])(
  'composes the real SDK warm/cold chain and physical STOP; cold Writer LOAD rejected=%s',
  async (rejectColdLoad) => {
    const f = fixture(),
      grpc = await port(),
      http = await port(),
      metrics = await port();
    f.descriptor.address = '127.0.0.1:' + grpc;
    f.descriptor.server.httpPort = http;
    f.descriptor.server.metricsPort = metrics;
    const serverBinary = resolve('tmp/temporal-downloads/temporal-v1.9.1');
    f.request.server = { path: serverBinary, sha256: digest(readFileSync(serverBinary)) };
    f.request.binding.node = {
      path: process.execPath,
      sha256: digest(readFileSync(process.execPath)),
    };
    const workflowsPath = resolve('dist/workflows/localTask.js');
    f.descriptor.workflows = { path: workflowsPath, sha256: digest(readFileSync(workflowsPath)) };
    f.request.runtime[0] = f.descriptor.workflows;
    f.request.bootstrap = f.file('bootstrap.json', JSON.stringify(f.descriptor));
    f.input.attempt = f.file('attempt.json', JSON.stringify(f.request));
    const parent = await consumeH06TemporalAutonomousAuthority(f.input, f.authority());
    const native = openH06TemporalAutonomousNativeClaim(parent.receipt);
    const parsedInput = parseLocalTask(f.descriptor.input);
    if (parsedInput.schemaVersion !== 11) throw new Error('Expected managed fixture');
    const input = parsedInput;
    const store = artifactStore(join(parent.request.evidenceRoot, 'artifacts'));
    for (const pin of f.descriptor.artifacts) store.publish(readH04Pin(pin));
    const mode = readH06TemporalControlMode(native.grant.admission);
    const issuer = {
      threadId: parent.request.chat.threadId,
      workspaceRoot: parent.request.chat.workspace,
      sessionsRoot: parent.grant.sessionsRoot,
      owner: input.admission.preparation.owner,
    };
    const authority = h06TemporalControlAuthority(store, issuer, mode);
    const registration = {
      project: input.admission.preparation.project,
      hostId: input.admission.preparation.hostId,
      owner: input.admission.preparation.owner,
      generation: 1,
      workspaceRoot: f.request.binding.workspaceRoot,
      artifactRoot: join(parent.request.evidenceRoot, 'artifacts'),
      commands: {
        syntax: { executable: process.execPath, args: ['--check', 'checks.mjs'] },
        validate: { executable: process.execPath, args: ['checks.mjs'] },
      },
    };
    const checksBefore = readFileSync(join(registration.workspaceRoot, 'checks.mjs'));
    let handle: Awaited<ReturnType<typeof startLocalTask>>, started: H04Pin;
    const query = async () => object(await handle.query('localTaskStatus'));
    const observedPlanningAttempts = new Set<number>();
    const counts = { readers: 0, writerStarts: [] as number[] },
      reader = rpcFixture(f, registration.workspaceRoot, 0, counts, async () => {
        await assertH06NativeReaderNotBlocked(
          environment!.client,
          started,
          String((await query()).runId),
          parent.workDeadlineMs,
          new AbortController().signal,
        );
        observedPlanningAttempts.add(Number((await query()).attempt));
      });
    let writerNumber = 0;
    const writerProcesses = new NativeWriterProcesses(),
      identities = new Map<number, ProcessIdentity[]>(),
      stoppedStages: string[] = [];
    const localTasks = {
      profile: f.descriptor.profile,
      processes: writerProcesses,
      createRuntime: (root: string) => {
        const index = ++writerNumber,
          runtime = rpcFixture(f, root, index, counts, undefined, rejectColdLoad && index === 3);
        return {
          ...runtime,
          async initialize() {
            await runtime.initialize();
            if (typeof runtime.pid !== 'number') throw new Error('Expected fixture Writer PID');
            identities.set(index, await writerProcesses.descendants([runtime.pid]));
          },
        };
      },
    };
    const hostRoot = join(parent.request.evidenceRoot, 'temporal-host'),
      queue = 'h06-autonomous-sdk';
    let environment: TestWorkflowEnvironment | undefined;
    try {
      Runtime.instance();
      environment = await TestWorkflowEnvironment.createLocal({
        server: {
          ip: '127.0.0.1',
          port: grpc,
          ui: false,
          dbFilename: f.descriptor.server.sqlitePath,
          executable: {
            type: 'existing-path',
            path: serverBinary,
          },
          extraArgs: ['--http-port', String(http), '--metrics-port', String(metrics)],
        },
      });
      const env = environment;
      bindTaskBackendClient(env.client, registration);
      async function stage<T>(phase: 'initial' | 'warm' | 'cold', run: () => Promise<T>) {
        const claim = phase === 'initial' ? native : readH06NativeAttemptForReopen(native.receipt);
        const services: H06TemporalStage = {
          client: env.client,
          connection: env.nativeConnection,
          taskQueue: queue,
          workflowsPath,
          registration,
          issuer,
          profile: f.descriptor.profile,
          maxTurnStarts: claim.request.budget.maxManagedStarts,
          workDeadlineMs: claim.workDeadlineMs,
          ...('admission' in claim.grant
            ? { controlMode: readH06TemporalControlMode(claim.grant.admission) }
            : {}),
          openProject: async () => ({
            rpc: reader,
            localTasks,
            stop: async () => {
              stoppedStages.push(phase);
              expect(await writerProcesses.alive([...identities.values()].flat())).toEqual([]);
            },
          }),
        };
        return withH06TemporalProject(services, parent.request.evidenceRoot, async (transport) => {
          const host = await createReaderHost(
            env.nativeConnection,
            queue,
            workflowsPath,
            [{ registration, rpc: transport.rpc, localTasks: transport.localTasks, authority }],
            f.descriptor.profile,
            hostRoot,
            claim.request.budget.maxManagedStarts,
          );
          return host.runUntil(run);
        });
      }
      const observe = <T>(run: () => Promise<T>) =>
        withH06NativeReaderFailure(
          env.client,
          started,
          handle.firstExecutionRunId,
          parent.workDeadlineMs,
          new AbortController().signal,
          run,
        );
      function commandFor(phase: H06TemporalControlPhase, status: Record<string, unknown>) {
        const resume = phase.endsWith('resume'),
          payload = store.publish(
            Buffer.from(
              JSON.stringify(
                resume
                  ? {
                      schemaVersion: 1,
                      kind: 'task-execution-resume',
                      held: status.held,
                      admission: input.admission,
                    }
                  : { schemaVersion: 1, kind: 'task-interruption', reason: 'SDK fixture ' + phase },
              ),
            ),
          );
        const command: Omit<PayloadReaderCommand, 'hash' | 'source'> = {
          schemaVersion: 2,
          commandId: 'h06-' + phase,
          target: taskControlTarget(input),
          expectedRevision: Number(status.revision),
          author: issuer.owner,
          action: resume ? 'resume' : 'pause',
          attempt: Number(status.attempt) + (resume ? 1 : 0),
          payload,
        };
        const source = publishH06TemporalControlSource(
          store,
          {
            kind: 'h06-temporal-autonomous-phase/3',
            mode,
            started,
            runId: String(status.runId),
            phase,
          },
          command,
        );
        const value = makeTaskExecutionCommand({ ...command, source });
        return value;
      }
      async function control(phase: H06TemporalControlPhase, status: Record<string, unknown>) {
        const value = commandFor(phase, status);
        const ack = await controlTaskExecution(
          env.client,
          handle.workflowId,
          value,
          String(status.runId),
        );
        expect(ack.revision).toBe(Number(status.revision) + 1);
        return ack;
      }
      async function writing(attempt: number) {
        return until(
          query,
          (status) =>
            status.phase === 'writing' &&
            status.attempt === attempt &&
            counts.writerStarts.length === attempt + 1,
        );
      }
      async function pause(phase: 'warm-pause' | 'cold-pause', attempt: number) {
        const running = await writing(attempt),
          actor = children[attempt]!;
        expect(() => process.kill(actor.pid!, 0)).not.toThrow();
        const ack = await control(phase, running);
        const held = await until(
          query,
          (status) => status.waiting === true && status.revision === ack.revision,
        );
        expect(held).toMatchObject({
          phase: 'waiting-human',
          attempt,
          stopFailure: '',
          checkpointFailure: '',
          budgetFailure: '',
        });
        expect(actor.signalCode).toBe('SIGKILL');
        expect(readFileSync(join(registration.workspaceRoot, 'checks.mjs'))).toEqual(checksBefore);
        const captured = await captureH06NativePausedStatus(
          env.client,
          started,
          String(held.runId),
          ack,
          'h06-' + (phase === 'warm-pause' ? 'warm-resume' : 'cold-resume'),
          parent.workDeadlineMs,
        );
        return { held, captured };
      }
      const afterWarmPause = await stage('initial', async () => {
        handle = await startLocalTask(env.client, input, queue);
        const run = String((await query()).runId),
          bytes = Buffer.from(
            JSON.stringify({
              kind: 'h06-native-temporal-start',
              operationId: input.admission.preparation.hostId,
              controlMode: mode,
              artifactRoot: registration.artifactRoot,
              workspaceRoot: registration.workspaceRoot,
              hostRoot,
              hostOwner: readH06NativeHostOwner(hostRoot),
              profile: f.descriptor.profile,
              transportRoot: join(parent.request.evidenceRoot, 'transport-initial'),
              input,
              workflowId: localTaskKey(input),
              firstExecutionRunId: run,
            }),
          );
        const path = join(parent.request.evidenceRoot, 'temporal-start.json');
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
        started = { path, sha256: digest(bytes) };
        return observe(() => pause('warm-pause', 0));
      });
      expect(existsSync(join(hostRoot, 'host-owner'))).toBe(false);
      const afterColdPause = await stage('warm', async () => {
        const command = commandFor('warm-resume', afterWarmPause.held),
          currentOwner = readH06NativeHostOwner(hostRoot),
          manual = localTaskActivities(
            registration,
            { ...localTasks, authority },
            reader,
            f.descriptor.profile,
            () => {},
            { instance: currentOwner.id, admitted() {} },
          );
        await expect(
          new MockActivityEnvironment().run(
            manual.executionControls.resumeTaskExecution,
            input,
            afterWarmPause.captured.plan.held,
            command,
            command.expectedRevision,
          ),
        ).rejects.toThrow('task-human-authorization-required');
        expect(await query()).toMatchObject({
          waiting: true,
          revision: command.expectedRevision,
          attempt: 0,
        });
        expect(counts.writerStarts).toEqual([1]);
        for (const retainedMode of [
          undefined,
          { ...mode, authority: f.file('foreign-parent.json', '{}') },
        ]) {
          await expect(
            reopenH06NativeTemporalOperator(
              {
                claim: native.receipt,
                server: parent.receipt,
                resume: {
                  started,
                  status: afterWarmPause.captured.status,
                  commandId: command.commandId,
                },
                opening: { phase: 'warm' },
                command,
                stops: [],
                participants: [],
                ...(retainedMode === undefined ? {} : { controlMode: retainedMode }),
              },
              async () => undefined,
            ),
          ).rejects.toThrow('h06-temporal-operator-reopen-mode');
        }
        await control('warm-resume', afterWarmPause.held);
        return observe(() => pause('cold-pause', 1));
      });
      expect(existsSync(join(hostRoot, 'host-owner'))).toBe(false);
      const cold = stage('cold', async () => {
        expect(await query()).toMatchObject({
          runId: handle.firstExecutionRunId,
          phase: 'waiting-human',
          waiting: true,
          attempt: 1,
          revision: 3,
          requirementsRevision: input.admission.preparation.revision,
          held: afterColdPause.held.held,
          stopFailure: '',
        });
        await control('cold-resume', afterColdPause.held);
        return observe(async () => {
          const completion = await handle.result();
          expect(completion).toMatchObject({ status: 'done', budgetFailure: '', diagnostics: [] });
          expect(counts.writerStarts).toEqual([1, 2, 3]);
          expect(writerNumber).toBe(3);
          expect([...observedPlanningAttempts]).toEqual([0, 1, 2]);
          if (!('commands' in completion) || !('budget' in completion))
            throw new Error('Expected managed completion');
          expect(completion.commands).toHaveLength(4);
          const commands = completion.commands.map((ref) =>
            object(object(JSON.parse(store.read(ref).toString())).command),
          );
          expect(commands.map(({ expectedRevision }) => expectedRevision)).toEqual([0, 1, 2, 3]);
          expect(commands.map(({ attempt }) => attempt)).toEqual([0, 1, 1, 2]);
          expect(completion.budget!.used).toBeGreaterThanOrEqual(
            Number(object(afterColdPause.held.budget).used),
          );
          expect(completion.budget!.used).toBeGreaterThan(9);
          expect(completion.budget!.limit).toBe(parent.budget.maxManagedStarts);
          const manifest = JSON.parse(
            readFileSync(join(registration.workspaceRoot, 'evidence', 'manifest.json'), 'utf8'),
          ) as { initial_failure: string };
          expect(manifest.initial_failure).toBe('F-01');
          expect(
            children.every((child) => child.exitCode !== null || child.signalCode !== null),
          ).toBe(true);
        });
      });
      if (rejectColdLoad) {
        await expect(cold).rejects.toThrow('h06-temporal-task-held');
        const receipt = object(
            JSON.parse(
              readFileSync(join(parent.request.evidenceRoot, 'task-failure-2.json'), 'utf8'),
            ),
          ),
          held = object(receipt.status),
          previousStatus = object(
            JSON.parse(readH04Pin(afterColdPause.captured.status).toString()),
          );
        expect(held).toMatchObject({
          phase: 'waiting-human',
          waiting: true,
          attempt: 2,
          revision: 4,
          stopFailure: '',
        });
        expect(String(held.error)).toContain('Activity task failed');
        expect(counts.writerStarts).toEqual([1, 2]);
        expect(writerNumber).toBe(3);
        expect(identities.get(3)).toHaveLength(1);
        expect(await writerProcesses.alive(identities.get(3)!)).toEqual([]);
        expect([...observedPlanningAttempts]).toEqual([0, 1, 2]);
        expect(existsSync(join(registration.workspaceRoot, 'evidence', 'manifest.json'))).toBe(
          false,
        );
        expect(receipt).toMatchObject({
          kind: 'h06-native-task-held',
          task: { workflowId: previousStatus.workflowId, runId: previousStatus.runId, attempt: 2 },
          held: held.held,
          error: held.error,
        });
      } else await cold;
      expect(stoppedStages).toEqual(['initial', 'warm', 'cold']);
      expect(readH06TemporalAutonomousAuthority(parent.receipt)).toEqual(parent);
    } finally {
      await environment?.teardown();
    }
  },
  120000,
);
