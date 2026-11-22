import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { NativeConnection } from '@temporalio/worker';
import { artifactStore } from '../src/adapters/artifacts/files.js';
import { readerBudget } from '../src/adapters/codex/readerBudget.js';
import { captureTaskBudget } from '../src/worker/taskBudget.js';
import { taskAdmissionIdentity } from '../src/policy/taskRecovery.js';
import { digest } from '../adapters/storage/storeCodec.js';
import type { InputRef } from '../core/localRun.js';
import type { NativeTaskInput, TaskWriterRuntime } from '../src/contracts/localTask.js';
import type { ProcessIdentity } from '../src/contracts/writerProcesses.js';
import type { ReaderProjectHost } from '../src/worker/readerHost.js';
import type {
  H01AttemptContext,
  H01NativeParticipant,
  H01ExecutionRequest,
  H01GuardDescriptor,
} from './comparisonH01Contract.js';
import { h01TaskPaths, h01RequestHash } from './comparisonH01Contract.js';
import { createH01NativeGuard } from './comparisonH01Guard.js';
import { createH01TemporalAdapter } from './comparisonH01Temporal.js';
import {
  TransportJournal,
  diagnosticBytes,
  diagnosticRecords,
} from '../adapters/codex/transportJournal.js';

const ports = vi.hoisted(() => ({
  rpc: vi.fn<
    (binary: string, args: string[], root: string, journal: string, operation: string) => object
  >(),
  descendants: vi.fn(),
  alive: vi.fn(),
  terminate: vi.fn(),
  wait: vi.fn(),
  host: vi.fn(),
  start: vi.fn(),
}));
vi.mock('../adapters/codex/appServerTransport.js', () => ({
  StdioAppServer: class {
    constructor(binary: string, args: string[], root: string, journal: string, operation: string) {
      return ports.rpc(binary, args, root, journal, operation);
    }
  },
}));
vi.mock('../src/adapters/codex/writerProcesses.js', () => ({
  NativeWriterProcesses: class {
    descendants = ports.descendants;
    alive = ports.alive;
    terminate = ports.terminate;
    wait = ports.wait;
  },
}));
vi.mock('../src/worker/readerHost.js', () => ({
  createReaderHost: ports.host,
}));
vi.mock('../src/client/localTask.js', () => ({ startLocalTask: ports.start }));

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'h01-temporal-provider-')));
  roots.push(root);
  const dir = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  };
  const pin = (name: string, value: string): InputRef => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { mode: 0o600 });
    return { locator: path, hash: digest(value) };
  };
  const controller = new AbortController();
  const workspace = dir('workspace'),
    sessionsRoot = dir('sessions');
  dir('workspace/.comparison');
  const storeRoot = dir('artifacts'),
    store = artifactStore(storeRoot);
  const publish = (value: unknown) => store.publish(Buffer.from(JSON.stringify(value)));
  const read = (ref: InputRef) =>
    JSON.parse(readFileSync(ref.locator).toString()) as Record<string, unknown>;
  const issuer = {
    sessionsRoot,
    workspaceRoot: workspace,
    threadId: 'human-thread',
    owner: 'operator',
  };
  const budget = {
    maxManagedStarts: 5,
    maxElapsedMs: 60000,
    maxInputUncached: 10000,
    maxOutput: 10000,
    reserveMs: 5000,
  };
  const files = {
    'range.mjs': 'export const range = (x,min,max) => x >= min && x < max;',
    'consumer-a.mjs': 'export {}',
    'consumer-b.mjs': 'export {}',
    'checks.mjs': 'export {}',
    'package.json': '{}',
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(workspace, name), bytes);
  for (const [key, path] of Object.entries(h01TaskPaths)) writeFileSync(join(workspace, path), key);
  const now = process.hrtime.bigint();
  const ctx: H01AttemptContext = {
    opId: 'h01-provider',
    requestHash: digest('request'),
    variant: 'candidate',
    material: {
      ref: pin('material.json', '{}'),
      value: {
        id: 'H-01',
        instructions: 'include the maximum',
        files,
        mutable: ['range.mjs'],
      },
    },
    criteria: {
      ref: pin('criteria.json', '{}'),
      value: {
        id: 'H-01',
        task: 'include maximum',
        stimulus: ['both consumers'],
        checks: ['validate'],
      },
    },
    roots: {
      workspaceRoot: workspace,
      artifactRoot: storeRoot,
      evidenceRoot: dir('evidence'),
      hostRoot: dir('host'),
      stateRoot: dir('state'),
    },
    identity: { taskId: 'h01-task', owner: 'operator', generation: 1 },
    profile: {
      model: 'test-provider',
      effort: 'high',
      clientVersion: '0.154.0',
    },
    binary: pin('binary', 'not an executable: mocked provider boundary'),
    rules: pin('rules', 'rules'),
    executor: pin('executor', 'executor'),
    reviewer: pin('reviewer', 'reviewer'),
    runtime: { engine: 'temporal', root, files: [] },
    bootstrap: {
      engine: 'temporal',
      address: '127.0.0.1:7233',
      namespace: 'default',
      taskQueue: 'h01',
      workflowsPath: join(root, 'workflows.ts'),
      issuer,
    },
    verifiedAuthorization: pin(
      'authorization.json',
      JSON.stringify({
        kind: 'comparison-h01-authorization-observation',
        executionVersion: 2,
        opId: 'h01-provider',
        requestHash: digest('request'),
        variant: 'candidate',
        budget,
        source: pin('source', 'primary user'),
        transcript: join(sessionsRoot, 'human.jsonl'),
        context: {
          threadId: issuer.threadId,
          turnId: 'human-turn',
          workspaceRoot: workspace,
          hostId: 'local',
          owner: issuer.owner,
        },
        issuer,
      }),
    ),
    budget,
    deadlineNs: String(now + 60_000_000_000n),
    workDeadlineNs: String(now + 55_000_000_000n),
    signal: controller.signal,
    nativeObserver: {
      controlRef: pin('guard', '{}'),
      beforeModelStart: vi.fn(async () => {}),
      confirmModelStart: vi.fn(),
      registerCreation: vi.fn(),
      registerCapabilities: vi.fn(),
      registerParticipant: vi.fn(),
      observeParticipant: vi.fn(),
      completeParticipant: vi.fn(),
      verify: vi.fn(async () => {}),
      accounting: vi.fn(() => ({
        participants: [],
        receipts: [],
        reservedManagedStarts: 2,
        observedResponses: 2,
        inputUncached: 10,
        inputCached: 0,
        output: 10,
        unknown: false,
        evidence: [],
      })),
    },
  };
  writeFileSync(join(root, 'workflows.ts'), 'mocked Worker provider');
  ctx.runtime.files = [
    fileURLToPath(new URL('./comparisonH01Temporal.ts', import.meta.url)),
    fileURLToPath(new URL('../src/worker/readerHost.ts', import.meta.url)),
    fileURLToPath(new URL('../adapters/codex/appServerTransport.ts', import.meta.url)),
    join(root, 'workflows.ts'),
  ].map((locator) => ({ locator, hash: digest(readFileSync(locator)) }));
  // Only the provider ports are doubles. The ledger, captures, artifacts and authority factory are real.
  const client = {
    options: { namespace: 'default' },
    connection: {
      options: { address: '127.0.0.1:7233' },
      withDeadline: (_deadline: number, fn: () => Promise<unknown>) => fn(),
    },
  } as unknown as Client;
  const services = {
    client,
    nativeConnection: {} as NativeConnection,
    taskQueue: 'h01',
    workflowsPath: join(root, 'workflows.ts'),
  };
  const consume = readerBudget(join(ctx.roots.hostRoot, 'turn-credits'), budget.maxManagedStarts);
  let project: ReaderProjectHost;
  let pid = 200;
  const identities = new Map<number, ProcessIdentity>();
  const alive = new Set<number>();
  const sessions = new Map<string, { id: string; cwd: string; path: string | null }>();
  const requests: {
    method: string;
    params: Record<string, unknown>;
    label: string;
  }[] = [];
  const closed: number[] = [];
  const config = {
    delayed: false,
    absentPath: false,
    writerAlive: false,
    blocked: false,
    noWriter: false,
    credit: 'normal',
    requestError: '',
    completionError: false,
    hostError: false,
    missingAdmissionsDirectory: false,
    discoveryError: false,
    missingJournal: false,
    diagnosticsFault: '',
    grantFault: '',
    pid: true,
    unobserved: false,
    stopChanged: false,
    survivors: false,
    aliveError: false,
    terminateError: false,
    stopWrong: false,
    mutatePrimary: (_primary: Record<string, unknown>) => {},
    mutateReady: (_ready: Record<string, unknown>) => {},
    beforeResult: async () => {},
    initialize: async (_label: string) => {},
    cancelError: false,
    hostOwner: false,
    unknownParticipant: false,
    resume: false,
    resumeFirst: false,
    wrongParent: false,
    reusedPid: false,
    cancelLastList: false,
    afterReaderSetup: () => {},
    resumeOther: false,
    abortReaderReply: '',
    writerAction: async (writer: TaskWriterRuntime, params: Record<string, unknown>) => {
      await writer.request('turn/start', params);
    },
  };
  ports.descendants.mockImplementation(async (pids: number[]) => {
    if (config.unobserved) return [];
    return pids.flatMap((id) => {
      const found = identities.get(id);
      return found === undefined
        ? []
        : [
            {
              ...found,
              ...(config.wrongParent ? { parent: process.pid + 1 } : {}),
              ...(config.stopChanged && requests.length > 0 ? { started: 'foreign reuse' } : {}),
            },
          ];
    });
  });
  ports.alive.mockImplementation(async (ids: ProcessIdentity[]) => {
    if (config.aliveError) throw new Error('ps unknown');
    return ids.filter((id) => alive.has(id.pid));
  });
  ports.terminate.mockImplementation(async (ids: ProcessIdentity[]) => {
    if (config.terminateError) throw new Error('terminate unknown');
    if (!config.survivors) ids.forEach((id) => alive.delete(id.pid));
    return ids;
  });
  ports.wait.mockImplementation(async () => {});
  ports.rpc.mockImplementation((_binary: string, _args: string[], cwd: string, journal: string) => {
    const id = pid++,
      label = journal.includes('writer-')
        ? 'writer'
        : journal.includes('probe')
          ? 'probe'
          : 'reader';
    identities.set(id, {
      pid: id,
      parent: process.pid,
      started: 'original-' + id,
    });
    alive.add(id);
    if (!config.missingJournal) {
      const diagnostics = journal + '.diagnostics.json';
      const message = { id: 1, method: 'initialize', params: {} };
      new TransportJournal(journal).write('send', message, JSON.stringify(message));
      if (config.diagnosticsFault === 'malformed') writeFileSync(diagnostics, '{');
      if (config.diagnosticsFault === 'schema')
        writeFileSync(diagnostics, JSON.stringify({ schema_version: 1, records: [] }));
      if (config.diagnosticsFault === 'records')
        writeFileSync(diagnostics, JSON.stringify({ schema_version: 2, records: null }));
      if (config.diagnosticsFault === 'record-limit')
        writeFileSync(
          diagnostics,
          JSON.stringify({
            schema_version: 2,
            records: Array(diagnosticRecords + 1).fill({}),
          }),
        );
      if (config.diagnosticsFault === 'byte-limit')
        writeFileSync(
          diagnostics,
          JSON.stringify({
            schema_version: 2,
            records: [{ preview: 'x'.repeat(diagnosticBytes) }],
          }),
        );
      if (config.diagnosticsFault === 'unsafe') {
        rmSync(diagnostics);
        symlinkSync(pin('diagnostics-' + id, '{}').locator, diagnostics);
      }
    }
    return {
      pid: config.pid ? id : undefined,
      initialize: vi.fn(async () => {
        if (config.reusedPid)
          throw new Error('app-server-exited before owned identity observation');
        await config.initialize(label);
      }),
      completed: vi.fn(async () => {
        if (config.completionError) throw new Error('completion unknown');
        return 'answer';
      }),
      close: () => {
        closed.push(id);
      },
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params, label });
        if (label === 'reader' && method === config.abortReaderReply)
          queueMicrotask(() => controller.abort());
        if (method === config.requestError) throw new Error('RPC lost response');
        if (method === 'mcpServerStatus/list')
          return {
            data: [
              {
                name: 'disabled_tools',
                runtimeStatus: 'disabled',
                pluginId: null,
                httpOrigin: null,
                serverInfo: null,
                serverCapabilities: null,
                toolsError: null,
                tools: {},
                resources: [],
                resourceTemplates: [],
              },
            ],
            nextCursor: null,
          };
        if (method === 'thread/start' || method === 'thread/resume') {
          const session =
              config.resumeOther && method === 'thread/resume'
                ? 'substituted-session'
                : label + '-' + id,
            path = join(sessionsRoot, session + '.jsonl');
          writeFileSync(path, 'mock primary; not native qualification\n');
          const thread = {
            id: session,
            cwd,
            turns: [],
            path: config.delayed || config.absentPath ? null : path,
          };
          sessions.set(session, thread);
          return {
            thread,
            model: ctx.profile.model,
            reasoningEffort: ctx.profile.effort,
          };
        }
        if (method === 'thread/read') {
          const thread = sessions.get(String(params.threadId))!;
          return {
            thread: {
              ...thread,
              path: config.absentPath ? null : join(sessionsRoot, thread.id + '.jsonl'),
            },
          };
        }
        if (method === 'thread/list') {
          if (config.discoveryError) throw new Error('inventory unknown');
          if (config.cancelLastList && params.archived === true)
            queueMicrotask(() => controller.abort());
          return {
            data: params.archived
              ? []
              : [
                  ...sessions.values(),
                  ...(config.unknownParticipant
                    ? [
                        {
                          id: 'unexpected',
                          cwd,
                          path: join(sessionsRoot, 'unexpected.jsonl'),
                        },
                      ]
                    : []),
                ]
                  .filter((p) => (params.cwd as string[]).includes(p.cwd))
                  .map((p) => ({
                    ...p,
                    path: join(sessionsRoot, p.id + '.jsonl'),
                  })),
            nextCursor: null,
          };
        }
        return { turn: { id: 'turn-' + requests.length } };
      },
    };
  });
  const admissions = join(ctx.roots.hostRoot, 'task-admissions-v2', 'host-instance');
  ports.host.mockImplementation(
    async (_connection, _queue, _path, projects: ReaderProjectHost[]) => {
      project = projects[0]!;
      dir('host/task-admissions-v2/host-instance');
      return {
        taskAdmissionsDirectory: config.missingAdmissionsDirectory ? null : admissions,
        runUntil: async (run: () => Promise<unknown>) => {
          const value = await run();
          if (config.hostOwner)
            writeFileSync(join(ctx.roots.hostRoot, 'host-owner'), 'not released');
          if (config.hostError) throw new Error('Worker stop unknown');
          return value;
        },
      };
    },
  );
  let input: NativeTaskInput;
  let grantPrepublished = false;
  let actualProjection: ReturnType<typeof publish> | undefined;
  ports.start.mockImplementation(async (_client, taskInput: NativeTaskInput) => {
    input = taskInput;
    return {
      workflowId: 'h01-workflow',
      cancel: vi.fn(async () => {
        if (config.cancelError) throw new Error('cancel unknown');
      }),
      fetchHistory: vi.fn(async () => ({ events: [] })),
      result: async () => {
        const reader = project.rpc;
        const thread = (await reader.request(
          config.resumeFirst ? 'thread/resume' : 'thread/start',
          {
            cwd: workspace,
            ...(config.resumeFirst ? { threadId: 'foreign' } : {}),
          },
        )) as { thread: { id: string } };
        if (config.resume)
          await reader.request('thread/resume', {
            threadId: thread.thread.id,
            cwd: workspace,
          });
        config.afterReaderSetup();
        const params = {
          threadId: thread.thread.id,
          input: [{ type: 'text', text: 'reader prompt' }],
        };
        if (config.credit !== 'missing')
          consume(digest('reader-key'), digest(JSON.stringify(params)));
        if (config.credit === 'ambiguous')
          consume(digest('second-reader-key'), digest(JSON.stringify(params)));
        if (config.credit === 'unmanaged') params.threadId = 'foreign';
        await reader.request('turn/start', params);
        await reader.completed(params.threadId, 'turn');
        await reader.request('thread/read', { threadId: params.threadId });
        let writerProof: Record<string, unknown> | undefined;
        if (!config.noWriter) {
          const writer = project.localTasks!.createRuntime(dir('writer-copy'));
          await writer.initialize();
          const started = (await writer.request('thread/start', {
            cwd: join(root, 'writer-copy'),
          })) as { thread: { id: string } };
          const message =
            config.credit === 'malformed-writer'
              ? 'unbound'
              : 'Workflow operation: write-H01\nfix inclusive maximum';
          consume(
            digest(config.credit === 'wrong-writer' ? 'wrong-operation' : 'write-H01'),
            digest(message),
          );
          await config.writerAction(writer, {
            threadId: started.thread.id,
            input: [{ type: 'text', text: message }],
          });
          await writer.completed(started.thread.id, 'writer-turn');
          if (config.delayed || config.absentPath)
            await writer.request('thread/read', {
              threadId: started.thread.id,
            });
          writer.close();
          if (!config.writerAlive) alive.delete(writer.pid!);
          writerProof = {
            kind: 'task-writers-stopped',
            confirmed: true,
            session: started.thread.id,
            processes: config.stopWrong ? [] : [identities.get(writer.pid!)],
          };
        }
        await config.beforeResult();
        if (config.blocked)
          return {
            status: 'blocked',
            stop: publish({
              kind: 'task-stopped',
              input,
              confirmed: true,
              ...(writerProof === undefined ? {} : { writer: publish(writerProof) }),
            }),
          };
        const grant = {
            input: config.grantFault === 'input' ? {} : input,
            instance: config.grantFault === 'instance' ? 'foreign-instance' : 'host-instance',
          },
          gate = dir('gate');
        const grantBytes = Buffer.from(JSON.stringify(grant));
        const grantRef = {
          sha256: config.grantFault === 'hash' ? '0'.repeat(64) : digest(grantBytes),
          bytes: grantBytes.length + (config.grantFault === 'size' ? 1 : 0),
        };
        const session = writerProof?.session;
        const load = {
          thread: { id: session },
          turn: { id: 'writer-load', status: 'completed' },
        };
        const ready = {
          kind: 'task-writer-ready',
          input,
          session,
          loadTurnId: load.turn.id,
          load: publish(load),
          grant: grantRef,
        };
        config.mutateReady(ready);
        const primary = {
          kind: 'local-task-result',
          complete: true,
          input,
          writer: {
            session,
            stop: publish(writerProof),
            answer: publish({
              kind: 'task-writer-answer',
              input,
              load,
              ready: publish(ready),
            }),
          },
          review: publish({ kind: 'reader-review-result', complete: true }),
          checks: publish({ checks: true }),
        };
        config.mutatePrimary(primary);
        grantPrepublished = existsSync(join(storeRoot, grantRef.sha256));
        writeFileSync(join(gate, 'grant.json'), grantBytes);
        if (config.grantFault === 'missing') rmSync(join(gate, 'grant.json'));
        if (config.grantFault === 'unsafe-file') {
          rmSync(join(gate, 'grant.json'));
          symlinkSync(
            pin('foreign-grant', grantBytes.toString()).locator,
            join(gate, 'grant.json'),
          );
        }
        if (config.grantFault === 'unsafe-directory') symlinkSync(gate, join(root, 'gate-alias'));
        writeFileSync(join(gate, 'permission.json'), JSON.stringify({ active: false }));
        writeFileSync(
          join(admissions, digest(taskAdmissionIdentity(input))),
          JSON.stringify({
            input,
            host: { id: 'host-instance' },
            gate: {
              mode: 'owned',
              directory: config.grantFault === 'unsafe-directory' ? join(root, 'gate-alias') : gate,
              grant: grantRef,
            },
          }),
        );
        actualProjection = publish({
          kind: 'task-card-projection',
          input,
          result: publish(primary),
          before: { content: publish('original card'), mode: 0o600 },
          after: {
            content: publish('framework DONE projection'),
            mode: 0o600,
          },
        });
        return {
          status: 'done',
          result: publish(primary),
          projection: actualProjection,
        };
      },
    };
  });
  return {
    ctx,
    config,
    services,
    controller,
    requests,
    read,
    publish,
    pin,
    closed,
    store,
    input: () => input,
    actualProjection: () => actualProjection,
    grantPrepublished: () => grantPrepublished,
    run: () => createH01TemporalAdapter(services).execute(ctx),
    budget: () => captureTaskBudget(join(ctx.roots.hostRoot, 'turn-credits'), store, null),
    setParticipant: (p: H01NativeParticipant) =>
      sessions.set(p.session, {
        id: p.session,
        path: p.transcript,
        cwd: workspace,
      }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function writerStarts(f: ReturnType<typeof fixture>) {
  return f.requests.filter(
    (request) => request.label === 'writer' && request.method === 'turn/start',
  );
}

function writerObserver(f: ReturnType<typeof fixture>) {
  const before = vi.mocked(f.ctx.nativeObserver.beforeModelStart);
  const confirm = vi.mocked(f.ctx.nativeObserver.confirmModelStart);
  before.mockClear();
  confirm.mockClear();
  return { before, confirm };
}

describe('transient H01 Writer turn admission through mocked RPC', () => {
  it('refuses admission before transport and never refunds the already consumed credit', async () => {
    const f = fixture();
    let observer: ReturnType<typeof writerObserver> | undefined;
    const errors: unknown[] = [];
    f.config.writerAction = async (writer, params) => {
      observer = writerObserver(f);
      observer.before.mockRejectedValueOnce(new Error('admission refused'));
      errors.push(await rejection(() => writer.admitTurn!(params)));
      errors.push(await rejection(() => writer.request('turn/start', params)));
      throw new Error('observed refusal boundary');
    };
    const result = await f.run();
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error instanceof Error)).toBe(true);
    expect(observer!.before).toHaveBeenCalledTimes(1);
    expect(observer!.confirm).not.toHaveBeenCalled();
    expect(writerStarts(f)).toEqual([]);
    expect(f.budget().used).toBe(2);
    expect(result.outcome).toBe('unknown');
    expect(result.nativeAcceptance).toBeNull();
  });
  it('admits exact parameters once and confirms only their actual matching dispatch', async () => {
    const f = fixture();
    let observer: ReturnType<typeof writerObserver> | undefined;
    let startsBeforeDispatch = -1;
    let guardsBeforeDispatch = -1;
    let synchronousStarts = -1;
    f.config.writerAction = async (writer, params) => {
      observer = writerObserver(f);
      await writer.admitTurn!(params);
      startsBeforeDispatch = writerStarts(f).length;
      guardsBeforeDispatch = observer.before.mock.calls.length;
      const dispatched = writer.request('turn/start', structuredClone(params));
      synchronousStarts = writerStarts(f).length;
      await dispatched;
    };
    expect((await f.run()).outcome).toBe('completed');
    expect(startsBeforeDispatch).toBe(0);
    expect(guardsBeforeDispatch).toBe(1);
    expect(synchronousStarts).toBe(1);
    expect(observer!.before).toHaveBeenCalledTimes(1);
    expect(observer!.confirm).toHaveBeenCalledTimes(1);
    expect(writerStarts(f)).toHaveLength(1);
    const admitted = observer!.before.mock.calls[0]![0];
    expect(admitted).toMatchObject({
      key: digest('write-H01'),
      stage: 'execution',
    });
    expect(observer!.confirm.mock.calls[0]![0]).toMatchObject({
      key: admitted.key,
      session: admitted.session,
    });
  });
  it('requires a fresh guard after consuming a marker instead of replaying its permission', async () => {
    const f = fixture();
    let observer: ReturnType<typeof writerObserver> | undefined;
    let retryError: unknown;
    f.config.writerAction = async (writer, params) => {
      observer = writerObserver(f);
      await writer.admitTurn!(params);
      await writer.request('turn/start', params);
      observer.before.mockRejectedValueOnce(new Error('fresh admission refused'));
      retryError = await rejection(() => writer.request('turn/start', params));
      throw new Error('observed retry boundary');
    };
    expect((await f.run()).outcome).toBe('unknown');
    expect(retryError).toBeInstanceOf(Error);
    expect(observer!.before).toHaveBeenCalledTimes(2);
    expect(observer!.confirm).toHaveBeenCalledTimes(1);
    expect(writerStarts(f)).toHaveLength(1);
    expect(f.budget().used).toBe(2);
  });
  it('keeps direct requests guarded when the caller does not use admission', async () => {
    const f = fixture();
    let observer: ReturnType<typeof writerObserver> | undefined;
    f.config.writerAction = async (writer, params) => {
      observer = writerObserver(f);
      observer.before.mockRejectedValueOnce(new Error('direct dispatch refused'));
      await writer.request('turn/start', params);
    };
    expect((await f.run()).outcome).toBe('unknown');
    expect(observer!.before).toHaveBeenCalledTimes(1);
    expect(observer!.confirm).not.toHaveBeenCalled();
    expect(writerStarts(f)).toEqual([]);
  });
  it.each(['message', 'session', 'extra', 'model'])(
    'rejects changed %s after admission and keeps the invalidation sticky',
    async (change) => {
      const f = fixture();
      let observer: ReturnType<typeof writerObserver> | undefined;
      const errors: unknown[] = [];
      f.config.writerAction = async (writer, params) => {
        observer = writerObserver(f);
        await writer.admitTurn!(params);
        const changed = structuredClone(params);
        if (change === 'message') (changed.input as { text: string }[])[0]!.text += '\nchanged';
        if (change === 'session') changed.threadId = 'foreign-session';
        if (change === 'extra') changed.extra = { tools: ['unexpected'] };
        if (change === 'model') changed.model = 'substituted-model';
        errors.push(await rejection(() => writer.request('turn/start', changed)));
        errors.push(await rejection(() => writer.request('turn/start', params)));
        errors.push(await rejection(() => writer.admitTurn!(params)));
        throw new Error('observed parameter binding boundary');
      };
      expect((await f.run()).outcome).toBe('unknown');
      expect(errors).toHaveLength(3);
      expect(errors.every((error) => error instanceof Error)).toBe(true);
      expect(observer!.before).toHaveBeenCalledTimes(1);
      expect(observer!.confirm).not.toHaveBeenCalled();
      expect(writerStarts(f)).toEqual([]);
    },
  );
  it('rejects a second admission instead of leaving the previous ready marker usable', async () => {
    const f = fixture();
    let observer: ReturnType<typeof writerObserver> | undefined;
    const errors: unknown[] = [];
    f.config.writerAction = async (writer, params) => {
      observer = writerObserver(f);
      await writer.admitTurn!(params);
      errors.push(await rejection(() => writer.admitTurn!(params)));
      errors.push(await rejection(() => writer.request('turn/start', params)));
      throw new Error('observed duplicate admission boundary');
    };
    expect((await f.run()).outcome).toBe('unknown');
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error instanceof Error)).toBe(true);
    expect(observer!.before).toHaveBeenCalledTimes(1);
    expect(observer!.confirm).not.toHaveBeenCalled();
    expect(writerStarts(f)).toEqual([]);
  });
  it.each([
    'direct-request',
    'concurrent-admit',
    'mutate-pending',
    'mutate-in-guard',
    'abort',
    'close',
  ])('does not turn a late pending admission into dispatch after %s', async (interruption) => {
    const f = fixture();
    const entered = deferred(),
      release = deferred(),
      done = deferred();
    let observer: ReturnType<typeof writerObserver> | undefined;
    const errors: unknown[] = [];
    let inspected = false;
    f.config.writerAction = async (writer, params) => {
      try {
        observer = writerObserver(f);
        observer.before.mockImplementation(async () => {
          if (interruption === 'mutate-in-guard') params.model = 'mutated-before-await';
          entered.resolve();
          await release.promise;
        });
        const pending = rejection(() => writer.admitTurn!(params));
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('admission ended before observer');
          }),
        ]);
        if (interruption === 'direct-request')
          errors.push(await rejection(() => writer.request('turn/start', params)));
        if (interruption === 'concurrent-admit')
          errors.push(await rejection(() => writer.admitTurn!(structuredClone(params))));
        if (interruption === 'mutate-pending') params.extra = { changed: true };
        if (interruption === 'abort') f.controller.abort();
        if (interruption === 'close') writer.close();
        release.resolve();
        errors.push(await pending);
        errors.push(await rejection(() => writer.request('turn/start', params)));
        inspected = true;
        throw new Error('observed late admission boundary');
      } finally {
        release.resolve();
        done.resolve();
      }
    };
    const result = await f.run();
    await done.promise;
    expect(inspected).toBe(true);
    expect(errors.every((error) => error instanceof Error)).toBe(true);
    expect(observer!.before).toHaveBeenCalledTimes(1);
    expect(observer!.confirm).not.toHaveBeenCalled();
    expect(writerStarts(f)).toEqual([]);
    expect(f.budget().used).toBe(2);
    expect(result.outcome).toBe('unknown');
    expect(result.nativeAcceptance).toBeNull();
  });
});

function registry(f: ReturnType<typeof fixture>) {
  const ctx = f.ctx;
  if (ctx.bootstrap.engine !== 'temporal') throw new Error('test requires Temporal');
  const issuer = ctx.bootstrap.issuer;
  const request: H01ExecutionRequest = {
    kind: 'comparison-h01-execution',
    executionVersion: 2,
    opId: ctx.opId,
    variant: ctx.variant,
    material: ctx.material.ref,
    criteria: ctx.criteria.ref,
    profile: f.pin(
      'registry-profile.json',
      JSON.stringify({
        ...ctx.profile,
        binary: ctx.binary,
        rules: ctx.rules,
        executor: ctx.executor,
        reviewer: ctx.reviewer,
      }),
    ),
    runtime: f.pin('registry-runtime.json', JSON.stringify(ctx.runtime)),
    bootstrap: f.pin('registry-bootstrap.json', JSON.stringify(ctx.bootstrap)),
    roots: ctx.roots,
    identity: ctx.identity,
    budget: ctx.budget,
    authorization: {
      root: issuer.workspaceRoot,
      transcript: join(issuer.sessionsRoot, 'human.jsonl'),
      anchor: {
        thread_id: issuer.threadId,
        turn_id: 'human-turn',
        workspace: issuer.workspaceRoot,
        host_id: 'local',
      },
      source: {
        locator: join(issuer.sessionsRoot, 'human.jsonl') + '#L1',
        hash: digest('primary not verified in registry-only test'),
      },
      requestHash: digest('pending'),
    },
  };
  request.authorization.requestHash = h01RequestHash(request);
  const requestRef = f.pin('registry-request.json', JSON.stringify(request));
  const descriptor: H01GuardDescriptor = {
    kind: 'comparison-h01-guard',
    executionVersion: 2,
    opId: ctx.opId,
    requestHash: h01RequestHash(request),
    request: requestRef,
    variant: ctx.variant,
    roots: ctx.roots,
    budget: ctx.budget,
    profile: ctx.profile,
    binary: ctx.binary,
    authorization: request.authorization,
    pins: [ctx.binary],
    startedNs: String(BigInt(ctx.deadlineNs) - BigInt(ctx.budget.maxElapsedMs) * 1_000_000n),
    deadlineNs: ctx.deadlineNs,
    workDeadlineNs: ctx.workDeadlineNs,
  };
  const guard = createH01NativeGuard(f.pin('registry-control.json', JSON.stringify(descriptor)));
  // Registry/capability methods are real. This seam deliberately stops before usage/model dispatch or authority qualification.
  Object.assign(ctx.nativeObserver, {
    registerCreation: vi.fn(guard.registerCreation),
    registerCapabilities: vi.fn(guard.registerCapabilities),
    registerParticipant: vi.fn(guard.registerParticipant),
    observeParticipant: vi.fn(guard.observeParticipant),
  });
  let reached = false;
  f.config.afterReaderSetup = () => {
    reached = true;
    throw new Error('registry-only boundary reached; no model dispatch');
  };
  return {
    reached: () => reached,
    records: () => readdirSync(join(ctx.roots.evidenceRoot, 'native-guard')),
  };
}

describe('H01 real Temporal assembly through mocked provider ports', () => {
  it('publishes only the exact gate-local grant after verifying its admission fingerprint', async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.grantPrepublished()).toBe(false);
    expect(result.outcome).toBe('completed');
    const admission = JSON.parse(
      readFileSync(
        join(
          f.ctx.roots.hostRoot,
          'task-admissions-v2',
          'host-instance',
          digest(taskAdmissionIdentity(f.input())),
        ),
        'utf8',
      ),
    ) as { gate: { directory: string; grant: ReturnType<typeof f.publish> } };
    const bytes = readFileSync(join(admission.gate.directory, 'grant.json'));
    expect(f.store.read(admission.gate.grant).equals(bytes)).toBe(true);
    expect(result.evidence).toContainEqual({
      locator: join(f.ctx.roots.artifactRoot, admission.gate.grant.sha256),
      hash: admission.gate.grant.sha256,
    });
  });
  it('does not start the workflow when the host reports no task admissions directory', async () => {
    const f = fixture();
    f.config.missingAdmissionsDirectory = true;
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(ports.start).not.toHaveBeenCalled();
    const failure = result.evidence.map(f.read).find((row) => row.kind === 'h01-temporal-failure');
    expect(failure?.error).toContain('h01-temporal-admissions-directory-missing');
  });
  it.each(['hash', 'size', 'unsafe-file', 'unsafe-directory', 'missing', 'input', 'instance'])(
    'refuses the %s gate grant without accepting a new authority',
    async (fault) => {
      const f = fixture();
      f.config.grantFault = fault;
      const result = await f.run();
      expect(result.outcome).toBe('unknown');
      const failures = result.evidence.map(f.read).filter((r) => r.kind === 'h01-temporal-failure');
      expect(failures).toHaveLength(1);
      if (['hash', 'size', 'input', 'instance'].includes(fault))
        expect(failures[0]!.error).toContain('h01-temporal-grant-binding');
      expect(f.grantPrepublished()).toBe(false);
    },
  );
  it('retains real bounded transport metadata as supplemental evidence without raw journals', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.outcome).toBe('completed');
    expect(f.read(result.stop).confirmed).toBe(true);
    const diagnostics = result.evidence.filter((ref) => ref.locator.endsWith('.diagnostics.json'));
    expect(diagnostics).toHaveLength(3);
    for (const ref of diagnostics) {
      expect(existsSync(ref.locator.replace(/\.diagnostics\.json$/u, ''))).toBe(false);
      expect(f.read(ref)).toMatchObject({
        schema_version: 2,
        records: [{ direction: 'send', method: 'initialize' }],
      });
      expect(digest(readFileSync(ref.locator))).toBe(ref.hash);
    }
  });
  it.each(['missing', 'malformed', 'schema', 'records', 'record-limit', 'byte-limit', 'unsafe'])(
    'keeps malformed or unsafe %s transport diagnostics unconfirmed',
    async (fault) => {
      const f = fixture();
      f.config.diagnosticsFault = fault;
      f.config.missingJournal = fault === 'missing';
      const result = await f.run();
      expect(result.outcome).toBe('unknown');
      expect(f.read(result.stop).confirmed).toBe(false);
      expect(result.evidence.some((ref) => ref.locator.endsWith('.diagnostics.json'))).toBe(false);
    },
  );
  it('does not replace strict primary stop binding with valid transport diagnostics', async () => {
    const f = fixture();
    f.config.stopWrong = true;
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop)).toMatchObject({ confirmed: false });
    expect(f.read(result.stop).reason).toContain('h01-temporal-primary-stop-binding');
    expect(result.evidence.filter((ref) => ref.locator.endsWith('.diagnostics.json'))).toHaveLength(
      3,
    );
  });
  it('constructs without effects; preserves real ledger debits, bound Input1 and primary result/stop references', async () => {
    const f = fixture();
    createH01TemporalAdapter(f.services);
    expect(ports.host).not.toHaveBeenCalled();
    expect(ports.rpc).not.toHaveBeenCalled();
    const result = await f.run();
    expect(result.outcome).toBe('completed');
    expect(f.read(result.stop)).toMatchObject({
      confirmed: true,
      remainingProcesses: [],
    });
    expect(Array.isArray(f.read(result.stop).sessions)).toBe(true);
    expect(result.nativeAcceptance).not.toBeNull();
    expect(result.ready).toBeDefined();
    const ready = f.read(result.ready!);
    expect(ready).toMatchObject({
      kind: 'task-writer-ready',
      input: f.input(),
    });
    expect(result.evidence).toContainEqual(result.ready);
    expect(result.evidence.map(f.read)).toContainEqual({
      thread: { id: ready.session },
      turn: { id: ready.loadTurnId, status: 'completed' },
    });
    expect(f.read(result.projection)).toMatchObject({
      kind: 'task-card-projection',
      input: f.input(),
    });
    expect(result.projection).toEqual({
      locator: join(f.ctx.roots.artifactRoot, f.actualProjection()!.sha256),
      hash: f.actualProjection()!.sha256,
    });
    expect(f.budget().used).toBe(2);
    expect(f.ctx.nativeObserver.beforeModelStart).toHaveBeenCalledTimes(2);
    expect(f.ctx.nativeObserver.confirmModelStart).toHaveBeenCalledTimes(2);
    expect(f.ctx.nativeObserver.registerCapabilities).toHaveBeenCalledTimes(2);
    for (const [capabilities] of vi.mocked(f.ctx.nativeObserver.registerCapabilities).mock.calls) {
      expect(capabilities.disabled).toEqual(['disabled_tools']);
      expect(f.read(capabilities.evidence)).toMatchObject({
        kind: 'h01-native-capabilities',
        session: capabilities.session,
      });
    }
    expect(f.input()).toMatchObject({
      schemaVersion: 1,
      baseline: 'syntax',
      admission: {
        preparation: {
          owner: 'operator',
          revision: 1,
          project: { checks: ['syntax', 'validate'] },
        },
      },
    });
    expect(ports.host.mock.calls[0]![6]).toBe(f.ctx.budget.maxManagedStarts);
    expect(ports.rpc.mock.calls[1]![1]).toContain('mcp_servers.disabled_tools.enabled=false');
    expect(result.evidence.map(f.read).filter((p) => p.kind === 'h01-temporal-grant')).toEqual([]);
  });
  it('binds delayed transcript paths to their original creation and raw thread/read observations', async () => {
    const f = fixture();
    f.config.delayed = true;
    expect((await f.run()).outcome).toBe('completed');
    const calls = vi.mocked(f.ctx.nativeObserver.registerParticipant).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [participant] of calls) {
      expect(f.read(participant.creation).method).toBe('thread/start');
      expect(f.read(participant.pathObservation!).method).toBe('thread/read');
    }
  });
  it.each(['missing', 'ambiguous', 'wrong-writer', 'malformed-writer', 'unmanaged'])(
    'rejects %s ledger/session binding before dispatch',
    async (credit) => {
      const f = fixture();
      f.config.credit = credit;
      const result = await f.run();
      expect(result.outcome).toBe('unknown');
      expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(
        credit === 'wrong-writer' || credit === 'malformed-writer' ? 1 : 0,
      );
      expect(f.read(result.stop).confirmed).toBe(false);
    },
  );
  it.each(['blocked', 'blocked-no-writer'])(
    'preserves primary %s as failed with a confirmed shutdown',
    async (kind) => {
      const f = fixture();
      f.config.blocked = true;
      f.config.noWriter = kind === 'blocked-no-writer';
      const result = await f.run();
      expect(result.outcome).toBe('failed');
      expect(f.read(result.stop).confirmed).toBe(true);
      expect(result.nativeAcceptance).toBeNull();
      expect(f.read(result.projection)).toMatchObject({
        kind: 'h01-projection-unknown',
        opId: f.ctx.opId,
      });
    },
  );
  it.each([
    'absentPath',
    'missingJournal',
    'unobserved',
    'hostError',
    'discoveryError',
    'stopWrong',
    'aliveError',
    'terminateError',
    'stopChanged',
    'survivors',
  ] as const)('keeps %s unknown with retained observations', async (key) => {
    const f = fixture();
    f.config[key] = true;
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(result.evidence.length).toBeGreaterThan(0);
  });
  it('rejects missing process identity and closes its transport', async () => {
    const f = fixture();
    f.config.pid = false;
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).confirmed).toBe(false);
    expect(f.closed.length).toBe(1);
  });
  it('does not refund a reserved start after a lost RPC response', async () => {
    const f = fixture();
    f.config.requestError = 'turn/start';
    expect((await f.run()).outcome).toBe('unknown');
    expect(f.budget().used).toBe(1);
    expect(f.ctx.nativeObserver.confirmModelStart).not.toHaveBeenCalled();
  });
  it('keeps a rejected primary post-disable capability inventory before the first managed start', async () => {
    const f = fixture();
    vi.mocked(f.ctx.nativeObserver.registerCapabilities).mockImplementation(() => {
      throw new Error('capability inventory unknown');
    });
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect(f.budget().used).toBe(0);
    const [capabilities] = vi.mocked(f.ctx.nativeObserver.registerCapabilities).mock.calls[0]!;
    expect(f.read(capabilities.evidence).kind).toBe('h01-native-capabilities');
  });
  it('cancels before dispatch when an authority/accounting wait is interrupted', async () => {
    const f = fixture();
    vi.mocked(f.ctx.nativeObserver.beforeModelStart).mockImplementation(async () => {
      f.controller.abort();
    });
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect(f.budget().used).toBe(1);
  });
  it.each(['complete', 'input', 'review', 'writer'] as const)(
    'rejects unbound primary %s',
    async (field) => {
      const f = fixture();
      f.config.mutatePrimary = (primary) => {
        primary[field] = field === 'complete' ? false : field === 'input' ? {} : { invalid: true };
      };
      expect((await f.run()).outcome).toBe('unknown');
    },
  );
  it.each(['input', 'session', 'loadTurnId', 'load', 'grant'])(
    'refuses a READY receipt with a substituted %s',
    async (field) => {
      const f = fixture();
      f.config.mutateReady = (ready) => {
        ready[field] = 'foreign';
      };
      const result = await f.run();
      expect(result.outcome).toBe('unknown');
      expect(result.ready).toBeUndefined();
    },
  );
  it.each(['verify', 'probe', 'reader', 'host'])(
    'rejects cancellation after awaited %s setup before any subsequent capability',
    async (stage) => {
      const f = fixture();
      if (stage === 'verify')
        vi.mocked(f.ctx.nativeObserver.verify).mockImplementationOnce(async () => {
          f.controller.abort();
        });
      else if (stage === 'host') {
        const create = ports.host.getMockImplementation()!;
        ports.host.mockImplementation(async (...args: unknown[]) => {
          f.controller.abort();
          const created: unknown = await create(...args);
          return created;
        });
      } else
        f.config.initialize = async (label) => {
          if (label === stage) f.controller.abort();
        };
      const result = await f.run();
      expect(result.outcome).toBe('unknown');
      expect(ports.start).not.toHaveBeenCalled();
      expect(f.requests.some((r) => r.method === 'turn/start')).toBe(false);
      expect(ports.rpc).toHaveBeenCalledTimes(stage === 'verify' ? 0 : stage === 'probe' ? 1 : 2);
    },
  );
  it('checks cancellation before any setup', async () => {
    const f = fixture();
    f.controller.abort();
    expect((await f.run()).outcome).toBe('unknown');
    expect(ports.rpc).not.toHaveBeenCalled();
  });
  it('keeps an unresolved cancellation and Worker shutdown unknown at the hard deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.ctx.nativeObserver.beforeModelStart).mockImplementation(
      () => new Promise(() => {}),
    );
    const running = f.run();
    await vi.advanceTimersByTimeAsync(100_000);
    const result = await running;
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).confirmed).toBe(false);
    expect(f.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect(f.budget().used).toBe(1);
  });
  it('bounds an unresponsive physical observer without reporting a confirmed stop', async () => {
    vi.useFakeTimers();
    const f = fixture();
    ports.alive.mockImplementation(() => new Promise(() => {}));
    const running = f.run();
    await vi.advanceTimersByTimeAsync(100_000);
    const result = await running;
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).confirmed).toBe(false);
    expect(f.read(result.stop).reason).toContain('cleanup-deadline');
    expect(ports.start).not.toHaveBeenCalled();
    expect(f.closed.length).toBeGreaterThan(0);
  });
  it('preserves a cancel rejection rather than declaring stop confirmed', async () => {
    const f = fixture();
    f.config.cancelError = true;
    vi.mocked(f.ctx.nativeObserver.beforeModelStart).mockImplementation(async () => {
      f.controller.abort();
    });
    const result = await f.run();
    expect(f.read(result.stop).confirmed).toBe(false);
    expect(f.read(result.stop).reason).toContain('cancel unknown');
  });
  it('retains an unreleased host owner and never releases the operator server', async () => {
    const f = fixture();
    f.config.hostOwner = true;
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(f.read(result.stop).confirmed).toBe(false);
    expect(readFileSync(join(f.ctx.roots.hostRoot, 'host-owner')).toString()).toBe('not released');
  });
  it('makes an unexpected discovered helper sticky unknown', async () => {
    const f = fixture();
    f.config.unknownParticipant = true;
    vi.mocked(f.ctx.nativeObserver.observeParticipant).mockImplementation((participant) => {
      if (participant.session === 'unexpected') throw new Error('unregistered participant');
    });
    expect((await f.run()).outcome).toBe('unknown');
  });
  it('binds resume creation and repeated path observations without guessed transcripts', async () => {
    const f = fixture();
    f.config.resume = true;
    f.config.delayed = true;
    expect((await f.run()).outcome).toBe('completed');
    const [creation] = vi.mocked(f.ctx.nativeObserver.registerCreation).mock.calls[0]!;
    expect(f.read(creation.creation).method).toBe('thread/start');
    expect(f.ctx.nativeObserver.registerCreation).toHaveBeenCalledTimes(2);
  });
  it('does not turn missing native usage into zero usage', async () => {
    const f = fixture();
    const accounting = f.ctx.nativeObserver.accounting();
    accounting.unknown = true;
    accounting.observedResponses = null;
    vi.mocked(f.ctx.nativeObserver.accounting).mockReturnValue(accounting);
    expect((await f.run()).outcome).toBe('unknown');
  });
  it('also physically stops an owned writer still alive after a valid result', async () => {
    const f = fixture();
    f.config.writerAlive = true;
    expect((await f.run()).outcome).toBe('completed');
    expect(ports.terminate).toHaveBeenCalledTimes(3);
  });
  it.each([
    'runtime',
    'version',
    'queue',
    'namespace',
    'authority',
    'authorization',
    'pin',
    'role',
    'material',
  ])('rejects unbound %s before a native process is created', async (kind) => {
    const f = fixture();
    if (kind === 'runtime') f.ctx.runtime.engine = 'legacy';
    if (kind === 'version') f.ctx.profile.clientVersion = 'unobserved';
    if (kind === 'queue') f.services.taskQueue = 'other';
    if (kind === 'namespace') Object.assign(f.ctx.bootstrap, { namespace: 'other' });
    if (kind === 'authority')
      Object.assign(f.ctx.bootstrap, {
        issuer: {
          sessionsRoot: '',
          workspaceRoot: '',
          owner: 'other',
          threadId: 'other',
        },
      });
    if (kind === 'authorization') f.ctx.verifiedAuthorization = f.pin('bad-auth.json', '{}');
    if (kind === 'pin') f.ctx.runtime.files = [];
    if (kind === 'role')
      writeFileSync(join(f.ctx.roots.workspaceRoot, h01TaskPaths.rules), 'substituted role');
    if (kind === 'material') f.ctx.material.value.mutable.push('checks.mjs');
    expect((await f.run()).outcome).toBe('unknown');
    expect(ports.rpc).not.toHaveBeenCalled();
  });
  it.each(['wrong-parent', 'reused-pid'])(
    'rejects %s initial process ownership without terminating a foreign identity',
    async (kind) => {
      const f = fixture();
      f.config.wrongParent = true;
      f.config.reusedPid = kind === 'reused-pid';
      const result = await f.run();
      expect(result.outcome).toBe('unknown');
      expect(f.read(result.stop).confirmed).toBe(false);
      expect(ports.terminate).not.toHaveBeenCalled();
      expect(ports.start).not.toHaveBeenCalled();
    },
  );
  it('keeps the original fresh creation when a known session resumes against the real guard registry', async () => {
    const f = fixture(),
      real = registry(f);
    f.config.resume = true;
    f.config.delayed = true;
    const result = await f.run();
    expect(result.outcome).toBe('unknown');
    expect(real.reached()).toBe(true);
    expect(f.ctx.nativeObserver.registerCreation).toHaveBeenCalledTimes(1);
    const [created] = vi.mocked(f.ctx.nativeObserver.registerCreation).mock.calls[0]!;
    const [participant] = vi.mocked(f.ctx.nativeObserver.registerParticipant).mock.calls[0]!;
    expect(participant.creation).toEqual(created.creation);
    expect(f.read(created.creation).method).toBe('thread/start');
    expect(f.read(participant.pathObservation!).method).toBe('thread/read');
    expect(real.records().some((name) => name.startsWith('unknown-'))).toBe(false);
    expect(f.budget().used).toBe(0);
  });
  it.each(['first-resume', 'substituted-session'])(
    'rejects %s without creating a replacement grant in the real registry',
    async (kind) => {
      const f = fixture(),
        real = registry(f);
      f.config.resumeFirst = kind === 'first-resume';
      f.config.resume = kind !== 'first-resume';
      f.config.resumeOther = kind !== 'first-resume';
      expect((await f.run()).outcome).toBe('unknown');
      expect(real.reached()).toBe(false);
      expect(f.ctx.nativeObserver.registerCreation).toHaveBeenCalledTimes(
        kind === 'first-resume' ? 0 : 1,
      );
      expect(f.requests.some((r) => r.method === 'turn/start')).toBe(false);
    },
  );
  it('does not complete when cancellation follows the last resolved inventory reply', async () => {
    const f = fixture();
    f.config.cancelLastList = true;
    const result = await f.run();
    expect(f.controller.signal.aborted).toBe(true);
    expect(result.outcome).toBe('unknown');
  });
  it.each(['thread/start', 'mcpServerStatus/list', 'turn/start'])(
    'does not apply a late %s reader response after cancellation',
    async (method) => {
      const f = fixture();
      f.config.abortReaderReply = method;
      const result = await f.run();
      expect(result.outcome).toBe('unknown');
      expect(f.ctx.nativeObserver.confirmModelStart).not.toHaveBeenCalled();
      expect(f.budget().used).toBe(method === 'turn/start' ? 1 : 0);
      if (method === 'thread/start')
        expect(f.ctx.nativeObserver.registerCreation).not.toHaveBeenCalled();
      if (method === 'mcpServerStatus/list')
        expect(f.ctx.nativeObserver.registerCapabilities).not.toHaveBeenCalled();
      if (method === 'turn/start')
        expect(
          result.evidence
            .map(f.read)
            .some((item) => item.kind === 'h01-native-dispatch' && item.method === 'turn/start'),
        ).toBe(true);
    },
  );
});
