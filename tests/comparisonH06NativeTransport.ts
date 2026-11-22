import { disabledMcpServers } from '../adapters/codex/disabledMcpServers.js';
import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as same } from 'node:util';
import { StdioAppServer } from '../adapters/codex/appServerTransport.js';
import { assertCoderCapabilities } from '../adapters/codex/coderCapabilities.js';
import { createPrivateDirectory, safeDirectory } from '../adapters/storage/storeFiles.js';
import { digest, publishFile } from '../src/adapters/artifacts/files.js';
import type { LocalTaskHost } from '../src/activities/localTask.js';
import { NativeWriterProcesses } from '../src/adapters/codex/writerProcesses.js';
import type { TaskWriterRuntime } from '../src/contracts/localTask.js';
import { exactFields, identifier, object, requireContract } from '../src/contracts/project.js';
import type { ProcessIdentity, WriterProcesses } from '../src/contracts/writerProcesses.js';
import { readerExecution, supportedTaskClient } from '../src/policy/readerExecution.js';
import { h04Pin, readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import {
  captureH06NativeCapabilities,
  h06NativeSessionSandbox,
} from './comparisonH06NativeCapabilities.js';

interface H06NativeTurn {
  role: 'reader' | 'writer';
  root: string;
  session: string;
  params: Readonly<Record<string, unknown>>;
  journal: string;
}
export interface H06NativeTransportOptions {
  operationId: string;
  binary: H04Pin;
  workspaceRoot: string;
  copyRoot: string;
  evidenceRoot: string;
  profile: LocalTaskHost['profile'];
  disabledServers: readonly string[];
  workDeadlineMs: number;
  stopDeadlineMs: number;
  retainedReaderSessions?: readonly string[];
  writerStimulus?: { node: H04Pin; minimumMs: number };
  readerLoadProbe?: { node: H04Pin; waitMs: number };
  admitTurn(turn: H06NativeTurn): Promise<void>;
  recordTurn(turn: H06NativeTurn & { turnId: string; response: unknown }): Promise<void>;
}
const inspectionMethods = [
  'model/list',
  'mcpServerStatus/list',
  'thread/read',
  'thread/loaded/list',
  'thread/backgroundTerminals/list',
  'turn/interrupt',
];
const inventory = { limit: 100, detail: 'toolsAndAuthOnly' };

async function deadline<T>(until: number, operation: () => Promise<T>): Promise<T> {
  const remaining = until - performance.now();
  requireContract(remaining > 0, 'h06-transport-deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('h06-transport-deadline')), remaining);
  });
  try {
    return await Promise.race([operation(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Opens one reader transport. The caller owns the enclosing host and must await stop(). */
export async function openH06NativeTransport(options: H06NativeTransportOptions) {
  const began = Date.now(),
    monotonic = performance.now(),
    work = monotonic + options.workDeadlineMs - began,
    hard = monotonic + options.stopDeadlineMs - began;
  const stimulus =
    options.writerStimulus === undefined ? undefined : object(options.writerStimulus);
  if (stimulus !== undefined) {
    exactFields(stimulus, ['node', 'minimumMs']);
    requireContract(
      typeof stimulus.minimumMs === 'number' &&
        Number.isSafeInteger(stimulus.minimumMs) &&
        stimulus.minimumMs > 0 &&
        stimulus.minimumMs + 60000 < 2 ** 31,
      'h06-transport-writer-stimulus',
    );
  }
  const writerStimulus =
    stimulus === undefined
      ? undefined
      : { node: h04Pin(stimulus.node), minimumMs: stimulus.minimumMs as number };
  if (writerStimulus !== undefined) readH04Pin(writerStimulus.node);
  const readerLoadProbe =
    options.readerLoadProbe === undefined ? undefined : structuredClone(options.readerLoadProbe);
  if (readerLoadProbe !== undefined) {
    exactFields(object(readerLoadProbe), ['node', 'waitMs']);
    requireContract(
      writerStimulus === undefined &&
        Number.isSafeInteger(readerLoadProbe.waitMs) &&
        readerLoadProbe.waitMs > 0 &&
        readerLoadProbe.waitMs < 2 ** 31,
      'h06-transport-load-probe',
    );
    readH04Pin(h04Pin(readerLoadProbe.node));
  }
  let probeDispatched = false;
  const operation = identifier(options.operationId);
  const profile = readerExecution(options.profile).profile;
  const binary = { ...h04Pin(options.binary) };
  const { admitTurn: authorize, recordTurn } = options;
  const disabled = [...options.disabledServers].sort();
  requireContract(
    supportedTaskClient(profile.clientVersion) &&
      typeof authorize === 'function' &&
      typeof recordTurn === 'function' &&
      disabled.every((name) => /^[a-zA-Z0-9_-]+$/u.test(name)) &&
      new Set(disabled).size === disabled.length &&
      Number.isSafeInteger(options.workDeadlineMs) &&
      Number.isSafeInteger(options.stopDeadlineMs) &&
      work > monotonic &&
      hard > work &&
      hard - monotonic < 2 ** 31,
    'h06-transport-options',
  );
  const workspace = safeDirectory(options.workspaceRoot);
  const copies = options.copyRoot;
  const evidence = options.evidenceRoot;
  requireContract(
    [copies, evidence].every((path) => isAbsolute(path) && resolve(path) === path) &&
      ![workspace, copies].some(
        (root) =>
          evidence === root || evidence.startsWith(root + sep) || root.startsWith(evidence + sep),
      ),
    'h06-transport-roots',
  );
  safeDirectory(dirname(copies));
  const retained = (options.retainedReaderSessions ?? []).map(identifier);
  requireContract(new Set(retained).size === retained.length, 'h06-transport-retained-sessions');
  readH04Pin(binary);
  createPrivateDirectory(evidence);
  const native = new NativeWriterProcesses();
  const terminated: ProcessIdentity[][] = [];
  const processes: WriterProcesses = {
    descendants: (pids) => deadline(hard, () => native.descendants(pids)),
    alive: (identities) => deadline(hard, () => native.alive(identities)),
    wait: (ms) => deadline(hard, () => native.wait(ms)),
    async terminate(identities) {
      const observed = await deadline(hard, () => native.terminate(identities));
      requireContract(
        identities.every((id) => observed.some((stopped) => same(id, stopped))),
        'h06-transport-stop-ownership',
      );
      terminated.push(observed);
      return observed;
    },
  };
  const ports: {
    pid: number;
    role: H06NativeTurn['role'];
    root: string;
    journal: string;
    sessions: H04Pin[];
    capabilities: H04Pin[];
    initial: Promise<ProcessIdentity[]>;
    close(): void;
  }[] = [];
  let closing = false;
  function working() {
    requireContract(!closing && performance.now() < work, 'h06-transport-deadline');
  }

  function openPort(root: string, role: H06NativeTurn['role']): TaskWriterRuntime {
    working();
    requireContract(readerLoadProbe === undefined || role === 'reader', 'h06-transport-load-probe');
    const journal = join(evidence, role + '-' + ports.length + '.jsonl');
    readH04Pin(binary);
    working();
    const args = [
      '-c',
      'features.apps=false',
      '-c',
      'features.plugins=false',
      '-c',
      'features.multi_agent=false',
      '-c',
      'web_search="disabled"',
    ];
    const overrides = ['0.169.1', '0.171.0-alpha.13'].includes(profile.clientVersion)
      ? disabledMcpServers(
          binary.path,
          root,
          args,
          disabled,
          Math.max(1, Math.ceil(work - performance.now())),
        ).overrides
      : disabled.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]);
    working();
    const rpc = new StdioAppServer(
      binary.path,
      [...args, ...overrides, 'app-server', '--stdio'],
      root,
      journal,
      role === 'writer' ? operation + '-' + ports.length : undefined,
    );
    const pid = rpc.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) {
      rpc.close();
      throw new Error('h06-transport-pid');
    }
    const initial = processes.descendants([pid]).then((identities) => {
      requireContract(
        identities.some((p) => p.pid === pid && p.parent === process.pid),
        'h06-transport-ownership',
      );
      return identities;
    });
    void initial.catch(() => {});
    let closed = false;
    let prepared: { key: string; ready: boolean; turn: H06NativeTurn } | null = null;
    let refused = false;
    const known = new Set(role === 'reader' ? retained : []);
    const ready = new Set<string>();
    const sent = new Set<string>();
    const sessions: H04Pin[] = [];
    const capabilities: H04Pin[] = [];
    const paths = new Map<string, unknown>();
    const scoped =
      role === 'writer'
        ? {
            type: 'workspaceWrite',
            writableRoots: [root],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          }
        : { type: 'readOnly', networkAccess: false };
    const close = () => {
      closed = true;
      prepared = null;
      rpc.close();
    };
    ports.push({ pid, role, root, journal, sessions, capabilities, initial, close });

    function recordSession(
      method: 'thread/start' | 'thread/resume' | 'thread/read',
      session: string,
      response: unknown,
      transcript: unknown,
    ) {
      // A successful open is always retained. A readback adds only new path evidence.
      if (method === 'thread/read' && (transcript == null || paths.get(session) === transcript))
        return;
      const path = join(
        evidence,
        basename(journal, '.jsonl') + '-session-' + sessions.length + '.json',
      );
      const bytes = Buffer.from(
        JSON.stringify({
          kind: 'h06-native-transport-session',
          operationId: operation,
          role,
          root,
          journal,
          session,
          method,
          response,
        }),
      );
      publishFile(path, bytes);
      const pin = { path, sha256: digest(bytes) };
      sessions.push(pin);
      if (transcript != null) paths.set(session, transcript);
      return pin;
    }

    let initialization: Promise<void> | undefined;
    function initialize() {
      working();
      return (initialization ??= deadline(work, async () => {
        await initial;
        working();
        await rpc.initialize();
        working();
        assertCoderCapabilities(await rpc.request('mcpServerStatus/list', inventory), disabled);
      }));
    }
    function scope(params: Record<string, unknown>) {
      const session = identifier(params.threadId);
      requireContract(known.has(session), 'h06-transport-session');
      return session;
    }
    function turnParams(params: Record<string, unknown>, session: string) {
      requireContract(
        Array.isArray(params.input) && params.input.length === 1,
        'h06-transport-input',
      );
      const message = object(params.input[0]);
      requireContract(
        message.type === 'text' && typeof message.text === 'string',
        'h06-transport-input',
      );
      let prompt = message.text;
      if (readerLoadProbe !== undefined) {
        requireContract(
          !probeDispatched &&
            /^Workflow operation: reader-load-[a-f0-9]{64}\nТолько чтение, без сети, записи, помощников и внешней истории\./u.test(
              prompt,
            ),
          'h06-transport-load-probe',
        );
        readH04Pin(readerLoadProbe.node);
        const executable = "'" + readerLoadProbe.node.path.replace(/'/gu, "'\\''") + "'";
        const command =
          executable +
          " -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0," +
          readerLoadProbe.waitMs +
          ")'";
        const newline = prompt.indexOf('\n');
        prompt =
          prompt.slice(0, newline + 1) +
          'TD-054: проверка deadline первичного LOAD. ПЕРВОЙ командой запусти в переднем плане `' +
          command +
          '`. Жди её завершения; до него не читай файлы и не завершай ответ. Ожидается прерывание хостом. Это единственное дополнительное действие отдельного допуска пробы. После него: ' +
          prompt.slice(newline + 1);
      }
      if (
        writerStimulus !== undefined &&
        role === 'writer' &&
        /^Workflow operation: task-implement-[a-f0-9]{64}-a[01]\n/u.test(prompt)
      ) {
        readH04Pin(writerStimulus.node);
        const newline = prompt.indexOf('\n');
        const executable = "'" + writerStimulus.node.path.replace(/'/gu, "'\\''") + "'";
        const command =
          executable +
          ' -e ' +
          "'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0," +
          (writerStimulus.minimumMs + 60000) +
          ")'";
        prompt =
          prompt.slice(0, newline + 1) +
          'H06/3 — проверка остановки живого Writer. ПЕРВОЙ командой запусти в переднем плане: `' +
          command +
          '`. Жди завершения этой команды: до него не меняй файлы и не завершай ответ. Ожидается прерывание хостом. Это не фоновый процесс и не проверка проекта.\n' +
          prompt.slice(newline + 1);
      }
      return {
        threadId: session,
        input: [{ type: 'text', text: prompt }],
        ...(params.outputSchema === undefined
          ? {}
          : { outputSchema: structuredClone(params.outputSchema) }),
        model: profile.model,
        effort: profile.effort,
        approvalPolicy: 'never',
        multiAgentMode: 'explicitRequestOnly',
        sandboxPolicy: structuredClone(scoped),
        environments: [{ environmentId: 'local', cwd: root, runtimeWorkspaceRoots: [root] }],
      };
    }
    const admitTurn = async (params: Record<string, unknown>) => {
      try {
        working();
        requireContract(!closed && !refused && prepared === null, 'h06-transport-admission');
        const session = scope(params);
        const key = JSON.stringify(params);
        requireContract(ready.has(session) && !sent.has(key), 'h06-transport-admission');
        const turn = { role, root, session, params: turnParams(params, session), journal };
        const marker = { key, ready: false, turn };
        prepared = marker;
        await deadline(work, () => authorize(structuredClone(turn)));
        working();
        requireContract(
          !closed && !refused && prepared === marker && key === JSON.stringify(params),
          'h06-transport-admission',
        );
        marker.ready = true;
      } catch (error) {
        refused = true;
        prepared = null;
        throw error;
      }
    };
    return {
      pid,
      initialize,
      admitTurn,
      async request(method, params) {
        requireContract(!closed && !closing, 'h06-transport-closed');
        if (method === 'turn/start') {
          try {
            working();
            requireContract(!refused, 'h06-transport-admission');
            if (prepared === null) await admitTurn(params);
            const marker = prepared;
            requireContract(
              marker !== null && marker.ready && marker.key === JSON.stringify(params),
              'h06-transport-admission',
            );
            prepared = null;
            working();
            // Dispatch immediately after admission consumption, without another await.
            const response = await deadline(work, () => {
              working();
              requireContract(!closed && !refused, 'h06-transport-admission');
              if (writerStimulus !== undefined) readH04Pin(writerStimulus.node);
              if (readerLoadProbe !== undefined) {
                requireContract(!probeDispatched, 'h06-transport-load-probe');
                probeDispatched = true;
              }
              sent.add(marker.key);
              return rpc.request(method, marker.turn.params);
            });
            const turnId = identifier(object(object(response).turn).id);
            await deadline(hard, () =>
              recordTurn({
                ...structuredClone(marker.turn),
                turnId,
                response: structuredClone(response),
              }),
            );
            return response;
          } catch (error) {
            refused = true;
            prepared = null;
            throw error;
          }
        }
        if (method === 'thread/start' || method === 'thread/resume') {
          working();
          requireContract(!refused, 'h06-transport-admission');
          const session = method === 'thread/resume' ? scope(params) : null;
          const reply = await deadline(work, () =>
            rpc.request(method, {
              ...(session === null
                ? { projectId: null, ephemeral: false, allowProviderModelFallback: false }
                : { threadId: session, excludeTurns: params.excludeTurns === true }),
              cwd: root,
              sandbox: role === 'writer' ? 'workspace-write' : 'read-only',
              approvalPolicy: 'never',
              model: profile.model,
              runtimeWorkspaceRoots: [root],
              selectedCapabilityRoots: [],
              multiAgentMode: 'explicitRequestOnly',
              config: {
                model_reasoning_effort: profile.effort,
                features: { apps: false, plugins: false, multi_agent: false },
                web_search: 'disabled',
                ...(role === 'writer'
                  ? {
                      sandbox_workspace_write: {
                        writable_roots: [root],
                        network_access: false,
                        exclude_slash_tmp: true,
                        exclude_tmpdir_env_var: true,
                      },
                    }
                  : { sandbox_read_only: { network_access: false } }),
                shell_environment_policy: {
                  inherit: 'none',
                  include_only: ['PATH', 'LANG', 'LC_ALL'],
                  set: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: root },
                },
              },
            }),
          );
          const raw = object(reply),
            thread = object(raw.thread),
            id = identifier(thread.id);
          requireContract(
            thread.cwd === root &&
              raw.cwd === root &&
              raw.approvalPolicy === 'never' &&
              h06NativeSessionSandbox(raw, role, root) &&
              raw.model === profile.model &&
              raw.reasoningEffort === profile.effort &&
              (session === null ? !known.has(id) : id === session),
            'h06-transport-session',
          );
          working();
          const sessionReceipt = recordSession(method, id, reply, thread.path)!;
          try {
            capabilities.push(
              await captureH06NativeCapabilities(
                { request: (name, args) => deadline(work, () => rpc.request(name, args)) },
                {
                  operationId: operation,
                  binary,
                  role,
                  root,
                  journal,
                  session: id,
                  profile,
                  disabledServers: disabled,
                },
                sessionReceipt,
                sessionReceipt.path.replace(/\.json$/u, '-capabilities.json'),
              ),
            );
          } catch (error) {
            refused = true;
            throw error;
          }
          working();
          known.add(id);
          ready.add(id);
          return reply;
        }
        requireContract(inspectionMethods.includes(method), 'h06-transport-method');
        if (
          method === 'thread/read' ||
          method === 'turn/interrupt' ||
          method === 'thread/backgroundTerminals/list'
        )
          scope(params);
        const reply = await deadline(hard, () => rpc.request(method, params));
        if (method === 'thread/read') {
          const thread = object(object(reply).thread);
          const session = scope(params);
          requireContract(thread.id === session && thread.cwd === root, 'h06-transport-session');
          recordSession(
            method,
            session,
            { thread: { id: session, cwd: root, path: thread.path } },
            thread.path,
          );
        }
        return reply;
      },
      completed(thread, turn, signal) {
        requireContract(!closed && !closing, 'h06-transport-closed');
        scope({ threadId: thread });
        identifier(turn);
        return deadline(hard, () => rpc.completed(thread, turn, signal));
      },
      close,
    };
  }

  let stopped: ReturnType<typeof cleanup> | undefined;
  async function cleanup() {
    if (ports.length === 0) return [];
    const outcomes = await Promise.allSettled(
      ports.map(async (port) => {
        try {
          const initial = await deadline(hard, () => port.initial);
          const root = initial.find((id) => id.pid === port.pid)!;
          const live = await processes.alive(initial);
          let owned = initial;
          if (live.some((id) => same(id, root))) {
            owned = await processes.descendants([port.pid]);
            requireContract(
              live.every((identity) => owned.some((id) => same(id, identity))),
              'h06-transport-stop-ownership',
            );
            owned = await processes.terminate(owned);
          } else {
            const receipt = terminated.find((group) =>
              initial.every((id) => group.some((item) => same(id, item))),
            );
            requireContract(live.length === 0, 'h06-transport-stop-initial-survivors');
            requireContract(receipt !== undefined, 'h06-transport-stop-termination-unrecorded');
            owned = receipt;
          }
          for (let attempt = 0; attempt < 100 && (await processes.alive(owned)).length; attempt++)
            await processes.wait(50);
          requireContract(
            (await processes.alive(owned)).length === 0,
            'h06-transport-stop-not-reaped',
          );
          return {
            role: port.role,
            root: port.root,
            journal: port.journal,
            processes: owned,
            confirmed: true as const,
            sessions: port.sessions.slice(),
            capabilities: port.capabilities.slice(),
          };
        } finally {
          port.close();
        }
      }),
    );
    const receipts = outcomes.map((result) => {
      if (result.status === 'rejected')
        throw new AggregateError(
          outcomes
            .filter((outcome) => outcome.status === 'rejected')
            .map((failure): unknown => failure.reason),
          'h06-transport-stop-unknown',
        );
      return result.value;
    });
    publishFile(
      join(evidence, 'transport-stop.json'),
      Buffer.from(
        JSON.stringify({ kind: 'h06-native-transport-stop', operationId: operation, receipts }),
      ),
    );
    return receipts;
  }
  function stop() {
    closing = true;
    return (stopped ??= cleanup());
  }

  try {
    const rpc = openPort(workspace, 'reader');
    await rpc.initialize();
    working();
    const localTasks: LocalTaskHost = {
      profile,
      disabledServers: disabled,
      processes,
      createRuntime(root) {
        requireContract(
          dirname(root) === copies &&
            safeDirectory(root) === root &&
            lstatSync(copies).isDirectory(),
          'h06-transport-copy-root',
        );
        return openPort(root, 'writer');
      },
    };
    return { rpc, localTasks, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'h06-transport-open-and-stop-failed');
    }
    throw error;
  }
}
