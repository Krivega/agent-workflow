import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type * as os from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, it, vi } from 'vitest';
import { writerScopeHash } from '../adapters/project/writerScope.js';
import type { prepareChatControl } from '../application/chatControl.js';
import type { ChatControl } from '../core/chatControl.js';
import type { CoderRun } from '../core/coder.js';
import type { EffectRecord, TechnicalState } from '../core/evidence.js';
import type { ChatContext } from '../ports/chatContext.js';
import type { EvidenceStore } from '../ports/evidenceStore.js';
import type { ProcessIdentity } from '../ports/writerProcesses.js';
import { digest } from '../src/adapters/artifacts/files.js';
import { object } from '../src/contracts/project.js';
import {
  runH06NativeLegacyControl,
  stopH06NativeLegacyWriter,
} from './comparisonH06NativeLegacyControl.js';

const ports = vi.hoisted(() => ({
  read: vi.fn<() => Promise<ChatContext>>(),
  save: vi.fn<() => Promise<void>>(),
  prepare: vi.fn(),
  settled: vi.fn<() => Promise<void>>(),
  execute: vi.fn<EvidenceStore['execute']>(),
  homedir: vi.fn<() => string>(),
  alive: vi.fn<(processes: ProcessIdentity[]) => Promise<ProcessIdentity[]>>(),
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: ports.homedir,
}));
vi.mock('../application/chatControl.js', () => ({ prepareChatControl: ports.prepare }));
vi.mock('../adapters/storage/chatContext.js', () => ({
  TaskChatContext: class {
    constructor(store: EvidenceStore) {
      ports.execute.mockImplementation((request) => store.execute(request));
    }
    read = ports.read;
    save = ports.save;
  },
}));
vi.mock('../adapters/project/chatRecovery.js', () => ({
  FileChatRecovery: class {
    settled = ports.settled;
  },
}));
vi.mock('../adapters/storage/chatWriter.js', () => ({
  bindChatEvidence: () => () => undefined,
}));
vi.mock('../src/adapters/codex/writerProcesses.js', () => ({
  NativeWriterProcesses: class {
    alive = ports.alive;
  },
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(phase: 'warm' | 'cold' = 'warm', fallbackHome = false) {
  ports.alive.mockResolvedValue([]);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'h06-native-legacy-control-')));
  roots.push(root);
  const nativeHome = fallbackHome ? join(root, '.codex') : root;
  vi.stubEnv('CODEX_HOME', fallbackHome ? undefined : nativeHome);
  ports.homedir.mockReturnValue(root);
  const evidenceRoot = join(root, 'evidence');
  mkdirSync(evidenceRoot);
  mkdirSync(join(nativeHome, 'sessions'), { recursive: true });
  const transcript = join(nativeHome, 'sessions', 'transcript.jsonl');
  writeFileSync(transcript, '');
  const source = { locator: transcript + '#L1', hash: 'a'.repeat(64) };
  const anchor = {
    host_id: 'local' as const,
    thread_id: 'owner',
    turn_id: 'turn',
    workspace: root,
  };
  const context = {
    schema_version: 'aw-evidence/1-draft',
    project_id: 'project',
    task_id: 'task',
    run_id: 'run',
    actor_id: 'owner',
    subtask_id: null,
  };
  let state: TechnicalState = {
    revision: 5,
    generation: 1,
    owner: 'owner',
    lease_until: Date.now() + 60_000,
    released: false,
    frozen: false,
    checkpoint: null,
  };
  const effects: EffectRecord[] = [];
  let operation = 'chat:control:pause';
  let ackKnown = true;
  let staleMutation = false;
  const store: Parameters<typeof runH06NativeLegacyControl>[0] = {
    root,
    grant: { context, permissions: ['read', 'manage'] },
    execute({ command }) {
      if (command.type === 'state') return { ok: true, value: state };
      if (command.type === 'effects') return { ok: true, value: effects };
      if (command.type === 'mutate') return { ok: true, value: state };
      if (command.type !== 'operation') throw Error('unexpected store command');
      expect(command.operation_id).toBe(operation);
      return {
        ok: true,
        value: ackKnown
          ? {
              status: 'confirmed',
              ack: {
                operation_id: operation,
                catalog_revision: state.revision,
                generation: 1,
                evidence_id: null,
                revision: null,
                content_hash: 'b'.repeat(64),
                locator: root + '#operation=' + operation,
              },
            }
          : { status: 'unknown' },
      };
    },
  };
  const copy = join(root, 'copy');
  mkdirSync(copy);
  const bindingOf = (path: string) => {
    const { dev, ino } = statSync(path);
    return { root: path, dev, ino };
  };
  const markers = [
    join(evidenceRoot, 'copy-marker.json'),
    join(evidenceRoot, 'session-marker.json'),
  ];
  for (const marker of markers) writeFileSync(marker, '{}');
  const runtime = {
    process: { pid: 92, parent: 1, started: 'runtime-start' },
    policy: { locator: markers[1]!, hash: digest('{}') },
  };
  const coder = {
    brief: {
      id: 'coder',
      project_id: 'project',
      task_id: 'task',
      parent_run_id: 'run',
      parent_session_id: 'owner',
      generation: 1,
      source_root: root,
      copy_root: copy,
    },
    baseline: { source: bindingOf(root) },
    copy: { binding: bindingOf(copy), evidence: { locator: markers[0], hash: digest('{}') } },
    session: {
      id: 'child',
      workspace: copy,
      project_id: 'project',
      receipt: { locator: markers[1], hash: digest('{}') },
    },
    turn: 'writer-turn',
  } as unknown as CoderRun;
  const chat = {
    control: { revision: 1, generation: 1, status: 'active', history: [], observed: anchor },
    run: {
      spec: {
        project_id: 'project',
        run_id: 'run',
        session_id: 'owner',
        identity: { task_id: 'task' },
      },
      generation: 1,
    },
    messages: { requirements_revision: 2 },
    workflow: { coders: { coder } },
  } as unknown as ChatContext;
  ports.read.mockImplementation(async () => {
    await ports.execute({ context, command: { type: 'state', archive: 'current' } });
    return chat;
  });
  ports.save.mockImplementation(async () => {
    expect(
      existsSync(join(evidenceRoot, `legacy-${phase}-${operation.split(':').at(-1)}-intent.json`)),
    ).toBe(true);
    await ports.execute({ context, command: { type: 'state', archive: 'current' } });
    await ports.execute({
      context,
      command: {
        type: 'mutate',
        mutation: {
          operation_id: operation,
          expected_revision: state.revision + (staleMutation ? 1 : 0),
          owner_generation: state.generation,
          payload_hash: '',
        },
        change: { type: 'renew', lease_until: state.lease_until },
      },
    });
    state = { ...state, revision: state.revision + 1 };
  });
  const binding = {
    workspaceRoot: root,
    descriptor: 'tools/agent-workflow/project/workflow.json',
    evidenceRoot,
    transcript,
    anchor,
    phase,
    storeRevision: 5,
    requirementsRevision: 2,
  };
  const event = { id: 'pause', expected_revision: 1, generation: 1, thread_id: 'owner', source };
  const paused = {
    ...chat.control,
    revision: 2,
    status: 'paused',
    history: [{ id: 'pause', payload: '' }],
  } as ChatControl;
  ports.prepare.mockResolvedValue({ next: { control: paused, run: { loaded: null } } });
  const sessions = {
    stop: vi.fn(async (run: CoderRun) => {
      expect(run).toBe(coder);
      expect(existsSync(join(evidenceRoot, `legacy-${phase}-writer-stop-intent.json`))).toBe(true);
      const scope = await writerScopeHash(markers, copy);
      const bytes = JSON.stringify({
        kind: 'writers-stopped',
        thread: 'child',
        active_turn: false,
        remaining_terminals: 0,
        remaining_processes: 0,
        before_hash: scope,
        after_hash: scope,
        observation_ms: 250,
        owned: {
          thread: 'child',
          turn: 'writer-turn',
          tree: copy,
          complete: true,
          markers,
          runtime,
        },
        processes: [{ pid: 123, parent: 1, started: 'recorded' }],
      });
      const locator = join(evidenceRoot, 'stopped.json');
      writeFileSync(locator, bytes);
      return { locator, hash: digest(bytes) };
    }),
  };
  const observation = {
    thread: 'child',
    turn: 'writer-turn',
    delivery: {
      schema_version: 1 as const,
      session: 'child',
      delivery: 'coder:coder:implementation',
      connection: 'native-connection',
      rpc_id: 3,
      request_hash: 'c'.repeat(64),
      attempts: 1,
      responses: 1,
      outcome: 'accepted' as const,
      response_hash: 'd'.repeat(64),
    },
    native: {
      active: { id: 'writer-turn', status: 'inProgress' },
      loaded: { data: ['child'], nextCursor: null },
    },
    runtime,
    processes: [{ pid: 123, parent: runtime.process.pid, started: 'recorded' }],
  };
  return {
    binding,
    store,
    effects,
    pause: { ...binding, event: { ...event, type: 'PAUSE' as const, reason: 'user pause' } },
    sessions,
    observation,
    async resume(
      pausedPin: { path: string; sha256: string },
      observeLiveWriter?: () => Promise<typeof observation>,
    ) {
      chat.control = paused;
      effects.push({ id: 'settled', outcome: 'not-started', intent: null, receipt: null });
      const { stopped, link } = await stopH06NativeLegacyWriter(
        store,
        observeLiveWriter === undefined ? sessions : { ...sessions, observeLiveWriter },
        {
          ...binding,
          paused: pausedPin,
          coderId: 'coder',
        },
      );
      operation = 'chat:control:resume';
      ports.prepare.mockImplementation(async (...args: Parameters<typeof prepareChatControl>) => {
        await args[4].settled();
        await args[4].stopped(stopped, 'owner', 'turn');
        return {
          next: {
            control: { ...paused, revision: 3, status: 'active', history: [{ id: 'resume' }] },
            run: { loaded: {} },
          },
        };
      });
      return {
        ...binding,
        storeRevision: state.revision,
        paused: pausedPin,
        stoppedBy: link,
        event: {
          ...event,
          id: 'resume',
          expected_revision: 2,
          type: 'RESUME' as const,
          stopped,
          authorization: source,
          marker: 'fresh-load',
        },
      };
    },
    expire: () => {
      state = { ...state, lease_until: Date.now() - 1 };
    },
    change: () => {
      state = { ...state, revision: state.revision + 1 };
    },
    staleMutation: () => {
      staleMutation = true;
    },
    unknownAck: () => {
      ackKnown = false;
    },
  };
}

it('commits pinned PAUSE and RESUME with separate intents and an exact stopped ref', async () => {
  const f = fixture('warm', true);
  const pause = await runH06NativeLegacyControl(f.store, f.pause);
  const request = await f.resume(pause.receipt);
  const resume = await runH06NativeLegacyControl(f.store, request);
  expect(ports.prepare.mock.calls[1]?.[0]).toEqual(request.event);
  expect(ports.save).toHaveBeenCalledTimes(2);
  expect(existsSync(resume.receipt.path)).toBe(true);
});

it('pins the fresh child liveness before STOP and binds it to the stopped runtime', async () => {
  const f = fixture();
  const pause = await runH06NativeLegacyControl(f.store, f.pause);
  const observe = vi.fn(async () => {
    expect(f.sessions.stop).not.toHaveBeenCalled();
    return f.observation;
  });
  const request = await f.resume(pause.receipt, observe);
  const link = object(JSON.parse(readFileSync(request.stoppedBy.path, 'utf8')));
  const intent = object(link.intent);
  const bytes = readFileSync(String(intent.path));
  expect(digest(bytes)).toBe(intent.sha256);
  const liveness = object(object(JSON.parse(bytes.toString())).liveness);
  expect(liveness.observedAt).toEqual(expect.any(Number));
  expect(liveness.status).toBe('live');
  expect(liveness.observation).toEqual(f.observation);
  expect(link.liveness).toEqual(liveness);
  expect(observe).toHaveBeenCalledTimes(1);
  await runH06NativeLegacyControl(f.store, request);
});

it.each([false, true])(
  'refuses completion if a previously observed child survived (changed runtime: %s)',
  async (changedRuntime) => {
    const f = fixture();
    const pause = await runH06NativeLegacyControl(f.store, f.pause);
    const escaped = { ...f.observation.processes[0]!, pid: 124 };
    ports.alive.mockImplementation(async (processes) =>
      processes.filter((p) => p.pid === escaped.pid),
    );
    await expect(
      f.resume(pause.receipt, async () => ({
        ...f.observation,
        processes: [escaped],
        runtime: changedRuntime
          ? { ...f.observation.runtime, process: { pid: 93, parent: 1, started: 'other' } }
          : f.observation.runtime,
      })),
    ).rejects.toThrow('h06-legacy-writer-stop-changed');
    expect(f.sessions.stop).toHaveBeenCalledTimes(1);
    expect(existsSync(join(f.binding.evidenceRoot, 'legacy-warm-writer-stop-intent.json'))).toBe(
      true,
    );
    expect(existsSync(join(f.binding.evidenceRoot, 'legacy-warm-writer-stop.json'))).toBe(false);
  },
);

it.each([
  ['unobservable', 'observation-unconfirmed'],
  ['wrong-turn', 'observation-unconfirmed'],
  ['wrong-runtime', 'stop-scope-changed'],
] as const)(
  'can stop and resume an %s writer without recording a qualified observation',
  async (mode, reason) => {
    const f = fixture();
    const pause = await runH06NativeLegacyControl(f.store, f.pause);
    const request = await f.resume(pause.receipt, async () => {
      if (mode === 'unobservable') throw new Error('writer not live');
      return mode === 'wrong-turn'
        ? { ...f.observation, turn: 'other-turn' }
        : {
            ...f.observation,
            runtime: {
              ...f.observation.runtime,
              process: { pid: 93, parent: 1, started: 'other' },
            },
          };
    });
    expect(object(JSON.parse(readFileSync(request.stoppedBy.path, 'utf8'))).liveness).toEqual({
      status: 'unknown',
      reason,
    });
    expect(f.sessions.stop).toHaveBeenCalledTimes(1);
    await runH06NativeLegacyControl(f.store, request);
  },
);

it('refuses same-host cold RESUME', async () => {
  const f = fixture('cold');
  const pause = await runH06NativeLegacyControl(f.store, f.pause);
  await expect(runH06NativeLegacyControl(f.store, await f.resume(pause.receipt))).rejects.toThrow(
    'h06-legacy-control-handoff',
  );
  expect(ports.save).toHaveBeenCalledTimes(1);
});

it('refuses a changed stopped writer copy before accepting RESUME', async () => {
  const f = fixture();
  const pause = await runH06NativeLegacyControl(f.store, f.pause);
  const request = await f.resume(pause.receipt);
  writeFileSync(join(f.binding.workspaceRoot, 'copy', 'late.txt'), 'late writer');
  await expect(runH06NativeLegacyControl(f.store, request)).rejects.toThrow(
    'h06-legacy-writer-stop-changed',
  );
  expect(f.sessions.stop).toHaveBeenCalledTimes(1);
  expect(ports.save).toHaveBeenCalledTimes(1);
});

it('requires the previous cold host PID to be absent before committing', async () => {
  const f = fixture('cold');
  const pause = await runH06NativeLegacyControl(f.store, f.pause);
  const body = object(JSON.parse(readFileSync(pause.receipt.path, 'utf8')));
  const previousPid = process.pid + 1;
  const bytes = JSON.stringify({ ...body, host: { pid: previousPid, startedAt: 1 } });
  writeFileSync(pause.receipt.path, bytes);
  const request = await f.resume({ path: pause.receipt.path, sha256: digest(bytes) });
  const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
  await expect(runH06NativeLegacyControl(f.store, request)).rejects.toThrow(
    'h06-legacy-control-old-host-active',
  );
  probe.mockImplementation(() => {
    throw Object.assign(new Error('process observation denied'), { code: 'EPERM' });
  });
  await expect(runH06NativeLegacyControl(f.store, request)).rejects.toThrow(
    'process observation denied',
  );
  probe.mockImplementation(() => {
    throw Object.assign(new Error('absent'), { code: 'ESRCH' });
  });
  await runH06NativeLegacyControl(f.store, request);
  expect(probe).toHaveBeenCalledWith(previousPid, 0);
  expect(ports.save).toHaveBeenCalledTimes(2);
});

it('keeps an unresolved effect and an expired owner outside control', async () => {
  const f = fixture();
  f.effects.push({ id: 'effect', outcome: 'unknown', intent: null, receipt: null });
  await expect(runH06NativeLegacyControl(f.store, f.pause)).rejects.toThrow(
    'h06-legacy-control-effect-unknown',
  );
  f.expire();
  await expect(runH06NativeLegacyControl(f.store, f.pause)).rejects.toThrow(
    'h06-legacy-control-owner',
  );
  expect(ports.prepare).not.toHaveBeenCalled();
  expect(ports.save).not.toHaveBeenCalled();
});

it('does not commit after authority and STOP preparation observed a changed Store', async () => {
  const f = fixture();
  ports.prepare.mockImplementation(async () => {
    f.change();
    return {};
  });
  await expect(runH06NativeLegacyControl(f.store, f.pause)).rejects.toThrow(
    'h06-legacy-control-store-changed',
  );
  expect(ports.save).not.toHaveBeenCalled();
});

it('retains only the intent when the ACK is unknown', async () => {
  const f = fixture();
  f.unknownAck();
  await expect(runH06NativeLegacyControl(f.store, f.pause)).rejects.toThrow(
    'h06-legacy-control-ack-unknown',
  );
  expect(existsSync(join(f.binding.evidenceRoot, 'legacy-warm-pause-intent.json'))).toBe(true);
  expect(existsSync(join(f.binding.evidenceRoot, 'legacy-warm-pause.json'))).toBe(false);
});

it('rejects a stale checkpoint mutation at the Store boundary', async () => {
  const f = fixture();
  f.staleMutation();
  await expect(runH06NativeLegacyControl(f.store, f.pause)).rejects.toThrow(
    'h06-legacy-control-store-changed',
  );
});
