import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { FileChatRecovery } from '../adapters/project/chatRecovery.js';
import { AppServerWriters } from '../adapters/codex/appServerWriters.js';
import { runChatCheck } from '../adapters/project/chatChecks.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { workflowFixture } from './workflowFixtures.js';
import type { ChatContextJournal, ChatContext } from '../ports/chatContext.js';
let f: Awaited<ReturnType<typeof workflowFixture>>, evidence: string, state: ChatContext;
let recovery: FileChatRecovery;
const alive = vi.fn();
beforeEach(async () => {
  f = await workflowFixture();
  evidence = await mkdtemp(resolve(dirname(f.root), 'chat-recovery-'));
  state = {
    run: f.executor,
    messages: null,
    control: null,
    coordination_bound: false,
    workflow: { schema_version: 1, revision: 0, execution: null, readings: {} },
  };
  const journal: ChatContextJournal = { read: async () => state, save: async () => undefined };
  alive.mockReset();
  alive.mockResolvedValue([]);
  recovery = new FileChatRecovery(f.root, evidence, journal, { alive });
});
afterEach(async () => {
  await f.dispose();
  await rm(evidence, { recursive: true, force: true });
});
async function proof(overrides: Record<string, unknown> = {}) {
  const marker = resolve(f.root, 'source.txt');
  const hash = createHash('sha256').update(marker).update('source revision 1').digest('hex');
  const value = {
    kind: 'writers-stopped',
    thread: 'session',
    active_turn: false,
    remaining_terminals: 0,
    remaining_processes: 0,
    before_hash: hash,
    after_hash: hash,
    observation_ms: 250,
    owned: { thread: 'session', turn: 'prior', complete: true, markers: [marker] },
    processes: [],
    ...overrides,
  };
  await writeFile(resolve(evidence, 'stop.json'), JSON.stringify(value), { mode: 0o600 });
  return new FileWorkflowInputs(f.root, evidence).ref(resolve(evidence, 'stop.json'));
}
it('requires known check outcomes and receipts including locks, and preserves unknown operations', async () => {
  await recovery.settled();
  const request = {
    id: 'probe',
    command: { file: process.execPath, args: ['-v'] },
    discovery: { files: ['source.txt'], directories: [] },
    attested_by: 'owner',
  };
  await runChatCheck(f.root, evidence, request);
  await writeFile(resolve(evidence, 'probe.check.lock'), JSON.stringify({ operation: 'probe' }), {
    mode: 0o600,
  });
  await recovery.settled();
  await writeFile(resolve(evidence, 'lost.intent.json'), '{}', { mode: 0o600 });
  await expect(recovery.settled()).rejects.toThrow('chat-operation-unknown');
  await rm(resolve(evidence, 'lost.intent.json'));
  state.workflow.readings = {
    one: {
      id: 'one',
      query: f.query,
      profile: { model: 'fixture', effort: 'high', reason: 'bounded read' },
      phase: 'reserved',
      session: null,
      load: null,
      turn_id: null,
      creations: 1,
      answers: [],
      restart: null,
    },
  };
  await expect(recovery.settled()).rejects.toThrow('chat-role-operation-unknown');
  const reading = state.workflow.readings.one!;
  reading.session = {
    id: 'helper',
    model: 'fixture',
    effort: 'high',
    workspace: f.root,
    project_id: 'project',
    read_only: true,
    network: false,
    forked_from: null,
    initial_turns: 0,
    receipt: f.proof,
  };
  reading.phase = 'ready';
  await expect(recovery.settled()).rejects.toThrow('chat-role-operation-unknown');
  reading.load = f.proof;
  reading.phase = 'loading';
  await expect(recovery.settled()).rejects.toThrow('chat-role-operation-unknown');
  reading.phase = 'ready';
  await recovery.settled();
  reading.phase = 'running';
  await expect(recovery.settled()).rejects.toThrow('chat-role-operation-unknown');
  reading.turn_id = 'known-turn';
  await recovery.settled();
  reading.phase = 'answered';
  await recovery.settled();
  reading.phase = 'sending';
  await expect(recovery.settled()).rejects.toThrow('chat-role-operation-unknown');
});
it('binds a stop receipt to prior turn, actual process identities and unchanged scoped markers', async () => {
  await expect(
    recovery.stopped({ locator: 'relative-stop.json', hash: 'unknown' }, 'session', 'prior'),
  ).rejects.toThrow('chat-stop-locator-not-absolute');
  await recovery.stopped(await proof(), 'session', 'prior');
  await expect(
    recovery.stopped(await proof({ active_turn: true }), 'session', 'prior'),
  ).rejects.toThrow('chat-writers-stop-unconfirmed');
  await expect(
    recovery.stopped(await proof({ processes: [{ pid: 1 }] }), 'session', 'prior'),
  ).rejects.toThrow('chat-writer-identity-invalid');
  const source = await proof({ processes: [{ pid: 123, started: 'observed', parent: 2 }] });
  alive.mockResolvedValue([{ pid: 123, started: 'observed', parent: 2 }]);
  await expect(recovery.stopped(source, 'session', 'prior')).rejects.toThrow(
    'chat-writers-still-active',
  );
  alive.mockResolvedValue([]);
  await f.file('source.txt', 'late write');
  await expect(recovery.stopped(source, 'session', 'prior')).rejects.toThrow(
    'chat-late-writer-detected',
  );
  await expect(
    recovery.stopped(
      await proof({
        owned: { thread: 'session', turn: 'prior', complete: true, markers: ['relative'] },
      }),
      'session',
      'prior',
    ),
  ).rejects.toThrow('chat-writer-marker-invalid');
});

it('accepts native stop receipts for unchanged binary markers and rejects later byte changes', async () => {
  const marker = resolve(f.root, 'image.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(marker, bytes);
  const writers = new AppServerWriters(
    {
      request: async (method) => {
        if (method === 'thread/loaded/list') return { data: ['session'], nextCursor: null };
        if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
        return { thread: { id: 'session', turns: [{ id: 'prior', status: 'completed' }] } };
      },
    },
    {
      alive,
      descendants: async () => [],
      terminate: async () => [],
      wait: async () => undefined,
    },
  );
  const source = await writers.stop(
    { thread: 'session', turn: 'prior', complete: true, terminals: [], markers: [marker] },
    resolve(evidence, 'binary-stop.json'),
  );
  await recovery.stopped(source, 'session', 'prior');
  await writeFile(marker, Buffer.from([0x88, ...bytes.subarray(1)]));
  await expect(recovery.stopped(source, 'session', 'prior')).rejects.toThrow(
    'chat-late-writer-detected',
  );
});
