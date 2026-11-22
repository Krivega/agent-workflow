import { afterEach, expect, it, vi } from 'vitest';
import type { EvidenceContext, StoreRequest } from '../core/evidence.js';
import {
  runH06NativeLegacyCold,
  runH06NativeLegacyInitialAndWarm,
  type H06LegacyActorChat,
} from './comparisonH06NativeLegacyActor.js';
import type { runH06NativeLegacyTransportPhase } from './comparisonH06NativeLegacyTransportPhase.js';

const ports = vi.hoisted(() => ({
  claim: vi.fn(),
  pinned: vi.fn(),
  prepare: vi.fn(),
  read: vi.fn(),
  plan: vi.fn(),
  run: vi.fn(),
  phase: vi.fn(),
}));
vi.mock('./comparisonH06NativeAttempt.js', () => ({
  readH06NativeAttemptForReopen: ports.claim,
}));
vi.mock('./comparisonH04Contract.js', () => ({ readH04Pin: ports.pinned }));
vi.mock('./comparisonH06NativeLegacyPreparation.js', () => ({
  prepareH06NativeLegacy: ports.prepare,
}));
vi.mock('./comparisonH06NativeLegacyControlOperator.js', () => ({
  planH06NativeLegacyControl: ports.plan,
  runH06NativeLegacyControlOperator: ports.run,
}));
vi.mock('./comparisonH06NativeLegacyTransportPhase.js', () => ({
  runH06NativeLegacyTransportPhase: ports.phase,
}));
vi.mock('../adapters/storage/chatContext.js', () => ({
  TaskChatContext: class {
    constructor(
      private readonly store: { execute(value: StoreRequest): Promise<unknown> },
      private readonly context: EvidenceContext,
    ) {}

    async read(): Promise<unknown> {
      await this.store.execute({ context: this.context, command: { type: 'state' } });
      return ports.read();
    }
  },
}));
vi.mock('../adapters/storage/chatWriter.js', () => ({
  withChatWriter: (_root: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('../adapters/storage/sqliteEvidenceStore.js', () => ({
  unwrap: <T>(result: { value: T }) => result.value,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

const pin = (path: string) => ({ path, sha256: 'a'.repeat(64) });
const actor = {
  transcript: '/sessions/actor.jsonl',
  anchor: { thread_id: 'actor', turn_id: 'initial', workspace: '/workspace', host_id: 'local' },
} as const;
const input = {
  actor,
  claim: pin('/attempt/claim.json'),
  started: pin('/attempt/start.json'),
  preparation: pin('/inputs/preparation.json'),
  initialFailure: pin('/attempt/f01.json'),
  warmBrief: pin('/inputs/warm.json'),
  coldBrief: pin('/inputs/cold.json'),
};
type Store = Parameters<typeof runH06NativeLegacyInitialAndWarm>[1];
type Proposal = Parameters<H06LegacyActorChat['control']>[0];
type PhaseOptions = Parameters<typeof runH06NativeLegacyTransportPhase>[1];

function fixture() {
  vi.stubEnv('CODEX_THREAD_ID', 'actor');
  const state = {
    revision: 4,
    generation: 1,
    owner: 'actor',
    lease_until: Date.now() + 10000,
    released: false,
    frozen: false,
  };
  const events: string[] = [];
  let controlRevision = 0;
  const control = { revision: 0, status: 'active' };
  const store = {
    root: '/attempt/legacy-store',
    grant: { context: { actor_id: 'actor' } },
    execute: () => ({ ok: true, value: { ...state } }),
  } as unknown as Store;
  ports.claim.mockReturnValue({
    workDeadlineMs: Date.now() + 10000,
    grant: { sessionsRoot: '/sessions' },
    request: {
      evidenceRoot: '/attempt',
      binding: { variant: 'legacy', workspaceRoot: '/workspace' },
      runtime: [input.preparation],
      stimulus: { longStageMs: 10 },
    },
  });
  ports.pinned.mockReturnValue(Buffer.from('{"descriptor":"workflow.json"}'));
  ports.prepare.mockImplementation((_input, verify: () => void) => {
    verify();
    events.push('prepared');
    return { execution: { status: 'implementing' } };
  });
  ports.read.mockImplementation(() => ({
    control: { ...control, revision: controlRevision },
    messages: { requirements_revision: 1 },
  }));
  ports.plan.mockImplementation((_store, value: { control: Proposal['control'] }) => ({
    expectedText: value.control.event.id,
  }));
  ports.run.mockImplementation((_store, value: { control: Proposal['control'] }) => {
    events.push(value.control.event.id);
    state.revision++;
    controlRevision++;
    control.status = 'active';
    return { receipt: pin('/attempt/' + value.control.event.id + '.json') };
  });
  ports.phase.mockImplementation(
    async (phase: { phase: 'warm' | 'cold' }, options: PhaseOptions) => {
      const { event } = await options.awaitPause(
        {} as Parameters<PhaseOptions['awaitPause']>[0],
        new AbortController().signal,
      );
      events.push(event.id);
      controlRevision++;
      state.revision++;
      control.status = 'paused';
      return {
        pause: { receipt: pin('/attempt/' + phase.phase + '-pause.json') },
        stop: {
          link: pin('/attempt/' + phase.phase + '-stop.json'),
          stopped: { locator: '/attempt/stop-proof', hash: 'b'.repeat(64) },
        },
        thread: pin('/attempt/' + phase.phase + '-thread.json'),
      };
    },
  );
  const chat = {
    control: vi.fn(async ({ control }: Proposal) => {
      const source = { locator: '/sessions/actor.jsonl#L42', hash: 'c'.repeat(64) };
      return {
        ...control,
        anchor: { ...control.anchor, turn_id: 'human-turn' },
        event: {
          ...control.event,
          source,
          ...(control.event.type === 'RESUME' ? { authorization: source } : {}),
        },
      } as Proposal['control'];
    }),
  };
  const signal = new AbortController().signal;
  return { store, chat, verify: vi.fn(), signal, events, state };
}

it('prepares the actor and performs the two PAUSE and RESUME pairs in order', async () => {
  const { store, chat, verify, signal, events } = fixture();
  const held = await runH06NativeLegacyInitialAndWarm(input, store, chat, verify, signal);
  expect(events).toEqual([
    'prepared',
    'h06-legacy-warm-pause',
    'h06-legacy-warm-resume',
    'h06-legacy-cold-pause',
  ]);
  expect(ports.phase).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ brief: input.coldBrief, previousResume: held.warmResume.receipt }),
    expect.objectContaining({ warmThread: held.warm.thread }),
  );
  await expect(runH06NativeLegacyCold(held, store, chat, signal)).resolves.toEqual({
    receipt: pin('/attempt/h06-legacy-cold-resume.json'),
  });
  expect(events.at(-1)).toBe('h06-legacy-cold-resume');
  expect(chat.control.mock.calls.map(([value]) => value.control.storeRevision)).toEqual([
    4, 5, 6, 7,
  ]);
});

it('rejects the wrong native actor before opening preparation', async () => {
  const { store, chat, verify, signal } = fixture();
  vi.stubEnv('CODEX_THREAD_ID', 'wrong');
  await expect(
    runH06NativeLegacyInitialAndWarm(input, store, chat, verify, signal),
  ).rejects.toThrow('h06-legacy-actor-binding');
  expect(ports.prepare).not.toHaveBeenCalled();
});

it('refuses an actor port that changes the exact proposal', async () => {
  const { store, chat, verify, signal } = fixture();
  chat.control.mockImplementationOnce(async ({ control }) => ({
    ...control,
    phase: 'cold',
  }));
  await expect(
    runH06NativeLegacyInitialAndWarm(input, store, chat, verify, signal),
  ).rejects.toThrow('h06-legacy-actor-control-changed');
  expect(ports.run).not.toHaveBeenCalled();
});
