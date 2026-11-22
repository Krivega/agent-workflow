import {
  createChatControl,
  applyChatControl,
  assertChatActive,
  validateChatControl,
} from '../core/chatControl.js';
import type { ChatControlEvent } from '../core/chatControl.js';
import { initializeChatControl, advanceChatControl } from '../application/chatControl.js';
import type { ChatContext, ChatContextJournal } from '../ports/chatContext.js';
import type { CurrentChatHost } from '../ports/currentChatHost.js';
import { workflowFixture } from './workflowFixtures.js';
import type { ChatObservation } from '../core/currentChat.js';
let f: Awaited<ReturnType<typeof workflowFixture>>;
let state: ChatContext, observed: ChatObservation;
let boundary: {
  kind: 'completed' | 'aborted' | 'compacted';
  source: { locator: string; hash: string };
};
let host: CurrentChatHost;
let journal: ChatContextJournal;
const recovery = { settled: vi.fn(), stopped: vi.fn() };
beforeEach(async () => {
  f = await workflowFixture();
  observed = {
    thread_id: 'session',
    turn_id: 'turn',
    workspace: f.root,
    host_id: 'local',
    client_version: '0.162.0-alpha.17.2',
    model: 'fixture-model',
    effort: 'high',
    approval_policy: 'never',
    sandbox_policy: 'danger-full-access',
    permission_profile: 'disabled',
    network_access: true,
    source: f.proof,
  };
  state = {
    run: f.executor,
    messages: null,
    workflow: { schema_version: 1, revision: 0, execution: null, readings: {} },
    coordination_bound: false,
    control: null,
  };
  boundary = { kind: 'completed', source: f.proof };
  host = {
    continuation: vi.fn(async (turn) => {
      if (turn === observed.turn_id) throw new Error('chat-continuation-turn-required');
      return boundary.source;
    }),
    observe: async () => observed,
    reference: async () => undefined,
    message: async () => ({ thread_id: observed.thread_id, turn_id: observed.turn_id }),
    boundary: async () => boundary,
    load: async (r) => ({
      ...r.loaded!,
      session_id: r.spec.session_id,
      run_id: r.spec.run_id,
      procedures: r.spec.procedures,
      rules: r.spec.rules,
      observed_read: 'fresh',
    }),
  };
  journal = {
    read: async () => state,
    save: async (expected, next) => {
      expect(expected).toBe(state);
      state = next;
    },
  };
  recovery.settled.mockReset();
  recovery.stopped.mockReset();
  await initializeChatControl(journal, { observe: host.observe });
});
afterEach(async () => {
  await f.dispose();
});
type Detail = ChatControlEvent extends infer E
  ? E extends ChatControlEvent
    ? Omit<E, 'id' | 'expected_revision' | 'generation' | 'thread_id' | 'source'>
    : never
  : never;
function event(detail: Detail): ChatControlEvent {
  return {
    ...detail,
    id: 'control-' + state.control!.revision,
    expected_revision: state.control!.revision,
    generation: 1,
    thread_id: 'session',
    source: f.proof,
  };
}
const advance = (detail: Detail) =>
  advanceChatControl(event(detail), journal, host, { verify: async () => undefined }, recovery);
it('requires the command verifier and exact source for forwarded authorization', async () => {
  const resume = event({ type: 'RESUME', marker: 'fresh', authorization: f.proof });
  await expect(
    advanceChatControl(resume, journal, host, { verify: async () => undefined }, recovery),
  ).rejects.toThrow('chat-command-verifier-required');
  const verify = vi.fn(async () => {});
  await expect(
    advanceChatControl(
      { ...resume, source: { ...f.proof, hash: 'changed' } },
      journal,
      host,
      { verify: async () => undefined },
      recovery,
      { verify },
    ),
  ).rejects.toThrow('chat-command-source-mismatch');
  const identity = state.run.spec.identity;
  state.run.spec.identity = { assignment_id: 'assignment' };
  await expect(
    advanceChatControl(resume, journal, host, { verify: async () => undefined }, recovery, {
      verify,
    }),
  ).rejects.toThrow('chat-command-task-required');
  state.run.spec.identity = identity;
  const result = await advanceChatControl(
    resume,
    journal,
    host,
    { verify: async () => undefined },
    recovery,
    { verify },
  );
  expect(result.control!.status).toBe('active');
  expect(verify).toHaveBeenCalledWith(f.proof, {
    project_id: 'project',
    task_id: 'task',
    run_id: 'run',
    thread_id: 'session',
    generation: 1,
    control_revision: 0,
    requirements_revision: 0,
  });
});
it('separates pause, verified resume and cancellation, and safely replays confirmed operations', async () => {
  expect(await initializeChatControl(journal, { observe: host.observe })).toBe(state.control);
  const pause = event({ type: 'PAUSE', reason: 'user pause' });
  await advanceChatControl(pause, journal, host, { verify: async () => undefined }, recovery);
  expect(state.run.status).toBe('waiting');
  expect(state.run.loaded).toBeNull();
  expect(
    (await advanceChatControl(pause, journal, host, { verify: async () => undefined }, recovery))
      .control!.status,
  ).toBe('paused');
  await expect(advance({ type: 'RESUME', marker: 'fresh' })).rejects.toThrow(
    'chat-continuation-turn-required',
  );
  observed = { ...observed, turn_id: 'next', source: { ...f.proof, locator: 'next-context' } };
  await advance({ type: 'RESUME', marker: 'fresh', stopped: f.proof });
  expect(state.run.status).toBe('ready');
  expect(recovery.stopped).toHaveBeenCalledWith(f.proof, 'session', 'turn');
  await advance({ type: 'CANCEL', reason: 'user cancel', unfinished: ['scope'] });
  expect(state.control!.status).toBe('cancelling');
  expect(state.run.status).toBe('waiting');
  boundary.kind = 'compacted';
  await expect(advance({ type: 'STOP', stopped: f.proof })).rejects.toThrow(
    'chat-turn-not-stopped',
  );
  boundary.kind = 'aborted';
  const stop = event({ type: 'STOP', stopped: f.proof });
  await advanceChatControl(stop, journal, host, { verify: async () => undefined }, recovery);
  expect(state.run).toMatchObject({
    status: 'cancelled',
    generation: 2,
    cancellation: { unfinished: ['scope'] },
  });
  await advanceChatControl(stop, journal, host, { verify: async () => undefined }, recovery);
  await expect(advance({ type: 'RESUME', marker: 'late' })).rejects.toThrow(
    'chat-control-transition-forbidden',
  );
});
it('requires primary recovery boundaries, retains a revised WAIT and never mutates bound coordination', async () => {
  state = { ...state, coordination_bound: true };
  await expect(advance({ type: 'PAUSE', reason: 'pause' })).rejects.toThrow(
    'chat-control-coordination-bound',
  );
  state = {
    ...state,
    coordination_bound: false,
    run: { ...state.run, status: 'waiting', loaded: null },
  };
  boundary = { kind: 'compacted', source: { ...f.proof, hash: 'different' } };
  await expect(advance({ type: 'INTERRUPT', reason: 'compacted' })).rejects.toThrow(
    'chat-boundary-source-mismatch',
  );
  boundary.source = f.proof;
  await advance({ type: 'INTERRUPT', reason: 'compacted' });
  expect(state.control!.status).toBe('interrupted');
  observed = { ...observed, source: { ...f.proof, locator: 'after-compaction' } };
  boundary.kind = 'completed';
  await expect(advance({ type: 'RESUME', marker: 'new' })).rejects.toThrow(
    'chat-compaction-unconfirmed',
  );
  boundary.kind = 'compacted';
  state = {
    ...state,
    run: {
      ...state.run,
      spec: { ...state.run.spec, route: { kind: 'substantial', accepted_plan: null } },
    },
  };
  await advance({ type: 'RESUME', marker: 'new' });
  expect(state.run.status).toBe('waiting');
  expect(state.control!.status).toBe('active');
  await advance({ type: 'RESUME', marker: 'same-identity' });
});
it('rejects unknown versions, stale writers, conflicting replay and forbidden transitions', () => {
  const initial = state.control!;
  expect(() => createChatControl(observed, 0)).toThrow('invalid-generation');
  expect(() => validateChatControl({ ...initial, schema_version: 2 as 1 })).toThrow(
    'unsupported-chat-control',
  );
  expect(() => validateChatControl({ ...initial, revision: 1 })).toThrow('invalid-chat-control');
  expect(() => assertChatActive(null, observed)).not.toThrow();
  expect(() => assertChatActive(initial, { ...observed, effort: 'low' })).toThrow(
    'chat-resume-required',
  );
  const pause = event({ type: 'PAUSE', reason: 'pause' }),
    paused = applyChatControl(initial, pause, observed);
  expect(() => assertChatActive(paused, observed)).toThrow('chat-control-not-active');
  expect(() =>
    applyChatControl(paused, { ...pause, type: 'PAUSE', reason: 'changed' }, observed),
  ).toThrow('chat-control-conflict');
  expect(() => applyChatControl(initial, { ...pause, generation: 2 }, observed)).toThrow(
    'stale-chat-control',
  );
  expect(() =>
    applyChatControl(
      initial,
      { ...pause, type: 'UNKNOWN' } as unknown as ChatControlEvent,
      observed,
    ),
  ).toThrow('unsupported-chat-control-event');
  expect(() =>
    applyChatControl(
      initial,
      event({ type: 'CANCEL', reason: 'cancel', unfinished: [] }),
      observed,
    ),
  ).toThrow('missing-unfinished-scope');
});

it('continues the same owner with primary settled-turn evidence, preserving identity and generation', async () => {
  await advance({ type: 'PAUSE', reason: 'pause' });
  const original = structuredClone(state.run.spec);
  observed = { ...observed, turn_id: 'next', source: { ...f.proof, locator: 'next-context' } };
  await advance({ type: 'RESUME', marker: 'fresh' });
  expect(state.run.spec).toEqual(original);
  expect(state.run.generation).toBe(1);
  expect(state.control).toMatchObject({
    status: 'active',
    continuation: { previous_turn: 'turn', boundary: f.proof },
  });
  expect(recovery.settled).toHaveBeenCalledOnce();
  expect(recovery.stopped).not.toHaveBeenCalled();
});

it.each([
  { workspace: '/other' },
  { host_id: 'other' },
  { client_version: 'other' },
  { model: 'other' },
  { effort: 'low' },
  { approval_policy: 'on-request' },
  { sandbox_policy: 'workspace-write' },
  { permission_profile: 'managed' },
  { network_access: false },
])('refuses same-owner continuation after identity or profile changes: %j', async (patch) => {
  await advance({ type: 'PAUSE', reason: 'pause' });
  observed = { ...observed, ...patch, turn_id: 'next' } as ChatObservation;
  await expect(advance({ type: 'RESUME', marker: 'fresh' })).rejects.toThrow(
    'chat-continuation-identity-mismatch',
  );
  expect(state.control!.status).toBe('paused');
});

it('never readies an unsettled continuation or a run with changed ownership generation', async () => {
  await advance({ type: 'PAUSE', reason: 'pause' });
  observed = { ...observed, turn_id: 'next' };
  recovery.settled.mockRejectedValueOnce(new Error('chat-operation-unknown'));
  await expect(advance({ type: 'RESUME', marker: 'fresh' })).rejects.toThrow(
    'chat-operation-unknown',
  );
  state.run = { ...state.run, generation: 2 };
  await expect(advance({ type: 'RESUME', marker: 'fresh' })).rejects.toThrow(
    'chat-continuation-identity-mismatch',
  );
  expect(state.control!.status).toBe('paused');
});

it('validates an explicitly supplied native stop proof even in the current turn', async () => {
  recovery.stopped.mockRejectedValueOnce(new Error('chat-writers-stop-unconfirmed'));
  await expect(advance({ type: 'RESUME', marker: 'fresh', stopped: f.proof })).rejects.toThrow(
    'chat-writers-stop-unconfirmed',
  );
  expect(recovery.stopped).toHaveBeenCalledWith(f.proof, 'session', 'turn');
  expect(state.control!.revision).toBe(0);
});

it('cannot hide an unsettled earlier turn behind a later pause, even across another interruption', async () => {
  const origin = structuredClone(observed);
  delete state.control!.unreconciled_turns;
  observed = { ...observed, turn_id: 'pause-turn' };
  await advance({ type: 'PAUSE', reason: 'later pause' });
  await advance({ type: 'INTERRUPT', reason: 'pause turn completed' });
  expect(state.control!.origin).toEqual(origin);
  expect(state.control!.unreconciled_turns).toEqual(['turn']);
  observed = { ...observed, turn_id: 'resume-turn' };
  vi.mocked(host.continuation).mockRejectedValueOnce(new Error('chat-native-calls-pending'));
  await expect(advance({ type: 'RESUME', marker: 'fresh' })).rejects.toThrow(
    'chat-native-calls-pending',
  );
  expect(state.control!.status).toBe('interrupted');
  expect(state.run.loaded).toBeNull();
  await advance({ type: 'RESUME', marker: 'fresh' });
  expect(host.continuation).toHaveBeenLastCalledWith('pause-turn');
  expect(state.control!.unreconciled_turns).toEqual([]);
  expect(state.control!.origin).toEqual(origin);
  expect(state.run.status).toBe('ready');
});

it('does not rebaseline the owner profile through PAUSE and requires a known continuation origin', async () => {
  observed = { ...observed, turn_id: 'pause-turn', model: 'other-model' };
  await advance({ type: 'PAUSE', reason: 'later pause' });
  observed = { ...observed, turn_id: 'resume-turn' };
  await expect(advance({ type: 'RESUME', marker: 'fresh' })).rejects.toThrow(
    'chat-continuation-identity-mismatch',
  );
  delete state.control!.origin;
  await expect(advance({ type: 'RESUME', marker: 'fresh' })).rejects.toThrow(
    'chat-continuation-origin-unconfirmed',
  );
  expect(() =>
    validateChatControl({ ...state.control!, unreconciled_turns: 'turn' as unknown as string[] }),
  ).toThrow('invalid-chat-control');
  expect(() => validateChatControl({ ...state.control!, unreconciled_turns: [''] })).toThrow();
});

it('retains the actual interruption handling turn as well as the cited older boundary', async () => {
  delete state.control!.unreconciled_turns;
  observed = { ...observed, turn_id: 'interrupt-handler' };
  await advance({ type: 'INTERRUPT', reason: 'old turn ended' });
  expect(state.control!.observed.turn_id).toBe('turn');
  expect(state.control!.unreconciled_turns).toEqual(['interrupt-handler']);
  observed = { ...observed, turn_id: 'resume-turn' };
  vi.mocked(host.continuation).mockRejectedValueOnce(new Error('chat-native-calls-pending'));
  await expect(advance({ type: 'RESUME', marker: 'fresh' })).rejects.toThrow(
    'chat-native-calls-pending',
  );
  expect(host.continuation).toHaveBeenLastCalledWith('interrupt-handler');
  expect(state.control!.status).toBe('interrupted');
  await advance({ type: 'RESUME', marker: 'fresh' });
  expect(host.continuation).toHaveBeenLastCalledWith('turn');
});

it('never cancels while an earlier turn remains unsettled or treats compaction as explicit stop', async () => {
  observed = { ...observed, turn_id: 'cancel-turn' };
  await advance({ type: 'CANCEL', reason: 'cancel', unfinished: ['scope'] });
  observed = { ...observed, turn_id: 'confirm-turn' };
  vi.mocked(host.continuation).mockRejectedValueOnce(new Error('chat-native-calls-pending'));
  await expect(advance({ type: 'STOP', stopped: f.proof })).rejects.toThrow(
    'chat-native-calls-pending',
  );
  expect(recovery.stopped).not.toHaveBeenCalled();
  await advance({ type: 'STOP', stopped: f.proof });
  expect(state.control!.status).toBe('cancelled');
  expect(state.control!.unreconciled_turns).toEqual([]);
});

it('preserves the explicit STOP path for a legacy control without pending-turn metadata', async () => {
  await advance({ type: 'CANCEL', reason: 'cancel', unfinished: ['scope'] });
  delete state.control!.unreconciled_turns;
  await advance({ type: 'STOP', stopped: f.proof });
  expect(state.control!.status).toBe('cancelled');
  expect(recovery.stopped).toHaveBeenCalledWith(f.proof, 'session', 'turn');
});

it('rejects an explicit stop receipt against a compacted continuation boundary', async () => {
  boundary.kind = 'compacted';
  await expect(advance({ type: 'RESUME', marker: 'fresh', stopped: f.proof })).rejects.toThrow(
    'chat-turn-not-stopped',
  );
  expect(recovery.stopped).not.toHaveBeenCalled();
  delete state.control!.unreconciled_turns;
  boundary.kind = 'completed';
  await advance({ type: 'RESUME', marker: 'fresh', stopped: f.proof });
});
