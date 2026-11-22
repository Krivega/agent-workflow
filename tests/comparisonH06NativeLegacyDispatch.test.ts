import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import {
  deliveryReceiptPath,
  nativeCreationProof,
  readDeliveryReceipt,
  TransportJournal,
} from '../adapters/codex/transportJournal.js';
import { SqliteEvidenceStore, unwrap } from '../adapters/storage/sqliteEvidenceStore.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { initializeStore } from '../adapters/storage/storeDatabase.js';
import type { Change, Json, WriteAck } from '../core/evidence.js';
import { readH04Pin } from './comparisonH04Contract.js';
import {
  captureH06NativeLegacyCompletedThread,
  captureH06NativeLegacyDispatchThread,
  checkH06NativeLegacyDispatch,
} from './comparisonH06NativeLegacyDispatch.js';
import { checkH06NativeHarness } from './comparisonH06NativeHarness.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';
import { grant, signed } from './storageFixtures.js';

const roots: string[] = [];
vi.mock('./comparisonH06NativeHarness.js', () => ({ checkH06NativeHarness: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const launch = [
  'COPY_INTENT',
  'COPIED',
  'CREATE_INTENT',
  'BIND',
  'LOAD_INTENT',
  'LOADED',
  'SEND_INTENT',
  'SENT',
];
const labels = ['profile', 'load', 'implementation'];
const cancel = ['STOP_INTENT', 'STOPPED', 'RELEASE', 'CANCEL_IDLE'];
const complete = ['RESULT', ...cancel.slice(0, -1), 'INTEGRATE_INTENT', 'INTEGRATED'];

function fixture(includeCompletion = false) {
  const evidence = mkdtempSync(join(realpathSync(tmpdir()), 'h06-legacy-dispatch-'));
  roots.push(evidence);
  const workspace = join(evidence, 'workspace');
  mkdirSync(workspace);
  const coders = join(evidence, 'coders');
  mkdirSync(coders);
  const workspaces = join(evidence, 'coder-workspaces');
  mkdirSync(workspaces);
  const storeRoot = join(evidence, 'legacy-store');
  const context = grant.context;
  const generation = 1;
  initializeStore(storeRoot, context);
  const store = new SqliteEvidenceStore(storeRoot, grant, () => 100);
  const database = join(storeRoot, 'store.sqlite');
  let revision = 0;
  const mutate = (change: Change, operation: string, ownerGeneration = generation) => {
    const ack = unwrap<WriteAck>(
      store.execute(signed(change, revision, ownerGeneration, operation)),
    );
    revision = ack.catalog_revision;
    return ack;
  };
  mutate({ type: 'claim', lease_until: 1000 }, 'claim', 0);
  const pin = (path: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const dbPin = () => ({ path: database, sha256: digest(readFileSync(database)) });
  const sql = (query: string, ...params: string[]) => {
    const db = new DatabaseSync(database);
    try {
      db.prepare(query).run(...params);
    } finally {
      db.close();
    }
  };
  const bootstrap = pin(join(evidence, 'bootstrap.json'), {});
  const briefOf = (id: string, copy: string) => ({
    id,
    project_id: context.project_id,
    task_id: context.task_id,
    parent_run_id: context.run_id,
    parent_session_id: context.actor_id,
    generation,
    source_root: workspace,
    copy_root: copy,
  });
  const completionBrief = pin(
    join(evidence, 'completion-brief.json'),
    briefOf('writer-completion', join(workspaces, 'writer-completion')),
  );
  const maxManagedStarts = 12;
  const request = {
    kind: 'comparison-h06-native/2',
    binding: { variant: 'legacy', operationId: context.task_id, workspaceRoot: workspace },
    evidenceRoot: evidence,
    bootstrap,
    ...(includeCompletion ? { runtime: [completionBrief], budget: { maxManagedStarts } } : {}),
  };
  const assets = {};
  const claim = pin(join(evidence, 'attempt-claim.json'), {
    kind: 'h06-native-attempt-claim',
    request,
    assets,
    requestHash: digest(canonical({ request, assets })),
  });
  const initial = {
    kind: 'h06-native-legacy-operator-start',
    context,
    claim,
    bootstrap,
    storeRoot,
    generation,
    revision,
  };
  const started = pin(join(evidence, 'legacy-operator-start.json'), initial);
  const identity = { workspace, store: storeRoot, evidence, context, generation };
  const inventory: Record<string, unknown> = {};
  const checkpoint = (operation: string, control?: unknown) =>
    mutate(
      {
        type: 'checkpoint',
        state: {
          workflow: { coders: inventory, ...(control === undefined ? {} : { control }) },
        } as Json,
        effects: [],
      },
      operation,
    );
  function phase(name: 'warm' | 'cold' | 'completion') {
    const id = 'writer-' + name;
    const directory = join(coders, id);
    mkdirSync(directory);
    const copy = name === 'completion' ? join(workspaces, id) : join(directory, 'copy');
    mkdirSync(copy);
    const journal = join(directory, 'transport.jsonl');
    const operation = `coder:${id}:create`;
    const native = new TransportJournal(journal, operation);
    const exchange = (req: unknown, response: unknown) => {
      native.write('send', req, canonical(req));
      native.write('recv', response, canonical(response));
    };
    const sessionId = 'thread-' + name;
    const turnId = 'implementation-' + name;
    exchange(
      { id: 1, method: 'thread/start' },
      { id: 1, result: { thread: { id: sessionId, turns: [] }, cwd: copy } },
    );
    const session = {
      id: sessionId,
      workspace: copy,
      receipt: nativeCreationProof(journal, operation)!.source!,
    };
    const delivery = (label: string) => `coder:${id}:${label}`;
    const turns = labels.map((label, index) => {
      const text = `Workflow delivery id: ${JSON.stringify(delivery(label))}\nExample ${label}`;
      const input = [{ type: 'text', text }];
      const turn = {
        id: label === 'implementation' ? turnId : label + '-' + name,
        status: label === 'implementation' && name !== 'completion' ? 'interrupted' : 'completed',
        items: [{ type: 'userMessage', content: input }],
      };
      exchange(
        { id: index + 2, method: 'turn/start', params: { threadId: sessionId, input } },
        { id: index + 2, result: { turn: { id: turn.id } } },
      );
      return turn;
    });
    const brief = briefOf(id, copy);
    const history = launch.map((type) => {
      const event = {
        id: `${id}:${type}`,
        type,
        generation,
        ...(type === 'BIND' ? { session } : {}),
        ...(type === 'SEND_INTENT' ? { delivery: delivery('implementation') } : {}),
        ...(type === 'SENT' ? { turn: turnId } : {}),
      };
      return { id: event.id, payload: canonical(event) };
    });
    const coder = {
      brief,
      session,
      copy: { binding: { root: copy } },
      status: 'running',
      turn: turnId,
      delivery: delivery('implementation'),
      history,
    };
    inventory[id] = coder;
    checkpoint(`coder:${id}:reserve`);
    launch.forEach((action) => checkpoint(`coder:${id}:${action}`));
    const receipt = readDeliveryReceipt(journal, sessionId, coder.delivery)!;
    const observation = { thread: sessionId, turn: turnId, delivery: receipt };
    const liveness = { status: 'live', observation };
    const paused = { path: join(evidence, 'pause.json'), sha256: '0'.repeat(64) };
    const intentPath = join(evidence, `legacy-${name}-writer-stop-intent.json`);
    const intent = {
      kind: 'h06-native-legacy-writer-stop-intent',
      phase: name,
      identity,
      coder,
      liveness,
      paused,
    };
    const rawPath = join(directory, 'stopped-record.json');
    const raw = {
      kind: 'writers-stopped',
      thread: sessionId,
      active_turn: false,
      remaining_terminals: 0,
      remaining_processes: 0,
      before_hash: '1'.repeat(64),
      after_hash: '1'.repeat(64),
      owned: { thread: sessionId, turn: turnId, tree: copy, complete: true },
    };
    const rawPin = pin(rawPath, raw);
    const stopPath = join(evidence, `legacy-${name}-writer-stop.json`);
    const stop = {
      kind: 'h06-native-legacy-writer-stop',
      phase: name,
      identity,
      coderId: id,
      paused,
      intent: pin(intentPath, intent),
      liveness,
      stopped: { locator: rawPin.path, hash: rawPin.sha256 },
    };
    const threadPath = join(evidence, `legacy-${name}-writer-thread.json`);
    const thread = { thread: { id: sessionId, cwd: copy, turns } };
    const refs = { stop: pin(stopPath, stop), thread: pin(threadPath, thread) };
    const repin = () => {
      const updated = pin(rawPath, raw);
      stop.stopped = { locator: updated.path, hash: updated.sha256 };
      stop.intent = pin(intentPath, intent);
      refs.stop = pin(stopPath, stop);
      refs.thread = pin(threadPath, thread);
    };
    return {
      refs,
      repin,
      stop,
      intent,
      raw,
      thread,
      journal,
      sessionId,
      delivery,
      receipt,
      directory,
      operation,
      coder,
    };
  }
  const warm = phase('warm');
  function finish(
    writer: ReturnType<typeof phase>,
    status: 'cancelled' | 'integrated',
    actions: string[],
  ) {
    const id = writer.coder.brief.id;
    const integrated = pin(join(writer.directory, 'integration.json'), {});
    const coder = {
      ...writer.coder,
      status,
      ...(status === 'integrated'
        ? {
            result: { outcome: 'PASS' },
            receipt: { locator: integrated.path, hash: integrated.sha256 },
          }
        : {}),
      history: [...writer.coder.history],
    };
    inventory[id] = coder;
    for (const type of actions) {
      const event = { id: `${id}:${type}`, type, generation };
      coder.history.push({ id: event.id, payload: canonical(event) });
      checkpoint(`coder:${id}:${type}`);
    }
    return coder;
  }
  if (includeCompletion) finish(warm, 'cancelled', cancel);
  const cold = phase('cold');
  let completion: {
    writer: ReturnType<typeof phase>;
    refs: { coder: ReturnType<typeof pin>; thread: ReturnType<typeof pin> };
    resume: ReturnType<typeof pin>;
  } | null = null;
  if (includeCompletion) {
    const event = { id: 'cold-resume', type: 'RESUME', stopped: cold.stop.stopped };
    const operation = 'chat:control:cold-resume';
    const intent = pin(join(evidence, 'legacy-cold-resume-intent.json'), {
      kind: 'h06-native-legacy-control-intent',
      phase: 'cold',
      operation,
      identity,
      event,
      stoppedBy: cold.refs.stop,
    });
    const control = { status: 'active' };
    const ack = checkpoint(operation, control);
    const resume = pin(join(evidence, 'legacy-cold-resume.json'), {
      kind: 'h06-native-legacy-resume',
      phase: 'cold',
      identity,
      event,
      operation,
      intent,
      control,
      ack,
    });
    finish(cold, 'cancelled', cancel);
    const writer = phase('completion');
    const integrated = finish(writer, 'integrated', complete);
    const coder = pin(join(evidence, 'legacy-completion-coder.json'), integrated);
    pin(join(evidence, 'legacy-completion-intent.json'), {
      claim,
      started,
      coldResume: resume,
      brief: completionBrief,
      warmThread: warm.refs.thread,
      coldThread: cold.refs.thread,
    });
    vi.mocked(checkH06NativeHarness).mockReturnValue({
      status: 'HARNESS_EVIDENCE_VERIFIED',
      variant: 'legacy',
      session: writer.sessionId,
      loadTurn: 'load-completion',
      implementationTurn: 'implementation-completion',
      checks: [],
      changed: ['evidence/manifest.json'],
      qualification: false,
    });
    completion = { writer, refs: { coder, thread: writer.refs.thread }, resume };
  }
  const refs = { started, database: dbPin(), warm: warm.refs, cold: cold.refs };
  return {
    refs,
    warm,
    cold,
    database,
    dbPin,
    sql,
    mutate,
    inventory,
    checkpoint,
    coders,
    pin,
    initial,
    completion,
    maxManagedStarts,
  };
}

it('matches recorded native creation and each delivery to two stopped Store Writers', () => {
  const f = fixture();
  const report = checkH06NativeLegacyDispatch(f.refs);
  expect(report).toMatchObject({
    status: 'LEGACY_DISPATCH_CHAIN_VERIFIED',
    operationId: 'task',
    qualification: false,
    attempts: [
      { coderId: 'writer-warm', thread: 'thread-warm' },
      { coderId: 'writer-cold', thread: 'thread-cold' },
    ],
  });
  expect(report.attempts.map(({ turns }) => turns.map(({ turn }) => turn))).toEqual([
    ['profile-warm', 'load-warm', 'implementation-warm'],
    ['profile-cold', 'load-cold', 'implementation-cold'],
  ]);
  expect(report.store[1]!.acknowledgements.at(-1)).toEqual({
    operation: 'coder:writer-cold:SENT',
    revision: 19,
  });
  expect(readH04Pin(f.refs.database)).toEqual(readFileSync(f.database));
  expect(Object.hasOwn(report, 'completion')).toBe(false);
});

async function completionFixture() {
  const f = fixture(true);
  const completion = f.completion!;
  const evidence = join(f.coders, '..');
  const ledger = openH06NativeTurnLedger(join(evidence, 'legacy-turns'), {
    mode: 'create',
    operationId: 'task',
    maxManagedStarts: f.maxManagedStarts,
    legacy: true,
  });
  for (const writer of [f.warm, f.cold, completion.writer]) {
    const thread = writer.thread.thread;
    for (const native of thread.turns) {
      const turn = {
        role: 'legacy-writer' as const,
        root: thread.cwd,
        session: thread.id,
        journal: writer.journal,
        params: { threadId: thread.id, input: native.items[0]!.content },
      };
      await ledger.admitTurn(turn);
      await ledger.recordTurn({
        ...turn,
        turnId: native.id,
        response: { turn: { id: native.id } },
      });
    }
  }
  return { ...f, completion, evidence, refs: { ...f.refs, completion: completion.refs } };
}

it('binds the separate integrated Writer after the confirmed cold RESUME to the same Store and transport ledger', async () => {
  const f = await completionFixture();
  const report = checkH06NativeLegacyDispatch(f.refs);
  expect(report.attempts.map(({ coderId }) => coderId)).toEqual([
    'writer-warm',
    'writer-cold',
    'writer-completion',
  ]);
  expect(report.completion).toMatchObject({
    status: 'HARNESS_EVIDENCE_VERIFIED',
    variant: 'legacy',
    implementationTurn: 'implementation-completion',
  });
  expect(report.store[2]?.acknowledgements.at(-1)?.operation).toBe(
    'coder:writer-completion:INTEGRATED',
  );
  expect(checkH06NativeHarness).toHaveBeenCalledOnce();
  expect(() => checkH06NativeLegacyDispatch(fixture(true).refs)).toThrow(
    'h06-legacy-dispatch-inventory',
  );
});

it('captures only the completed thread and preserves the first pinned bytes', async () => {
  const f = await completionFixture();
  const { refs, writer } = f.completion;
  rmSync(refs.thread.path);
  const request = vi.fn().mockResolvedValue(writer.thread);
  const captured = await captureH06NativeLegacyCompletedThread({ request }, refs.coder);
  expect(captured.path).toBe(refs.thread.path);
  expect(request).toHaveBeenCalledWith('thread/read', {
    threadId: 'thread-completion',
    includeTurns: true,
  });
  await expect(
    captureH06NativeLegacyCompletedThread({ request }, refs.coder),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(readH04Pin(captured)).toEqual(Buffer.from(canonical(writer.thread) + '\n'));
});

it.each([
  ['missing-resume-ack', 'h06-legacy-dispatch-store-operation'],
  ['unretired-cold', 'h06-legacy-dispatch-store-completion'],
  ['missing-integrated-ack', 'h06-legacy-dispatch-store-operation'],
  ['unknown-dispatch', 'h06-legacy-dispatch-turn-budget'],
  ['mismatched-harness', 'h06-legacy-dispatch-completion-harness'],
  ['wrong-terminal', 'h06-legacy-dispatch-turn'],
  ['wrong-brief', 'h06-legacy-dispatch-completion-intent'],
  ['wrong-cold-resume', 'h06-legacy-dispatch-cold-resume'],
] as const)('fails closed with %s in the third Writer chain', async (defect, message) => {
  const f = await completionFixture();
  if (defect === 'missing-resume-ack')
    f.sql('DELETE FROM operations WHERE id=?', 'chat:control:cold-resume');
  if (defect === 'unretired-cold') {
    f.inventory['writer-cold'] = f.cold.coder;
    f.checkpoint('unretired');
  }
  if (defect === 'missing-integrated-ack')
    f.sql('DELETE FROM operations WHERE id=?', 'coder:writer-completion:INTEGRATED');
  if (defect === 'unknown-dispatch') rmSync(join(f.evidence, 'legacy-turns', '9-response.json'));
  if (defect === 'mismatched-harness')
    vi.mocked(checkH06NativeHarness).mockImplementationOnce(() => ({
      status: 'HARNESS_EVIDENCE_VERIFIED',
      variant: 'legacy',
      session: 'other',
      loadTurn: 'other',
      implementationTurn: 'other',
      checks: [],
      changed: [],
      qualification: false,
    }));
  if (defect === 'wrong-terminal') {
    f.completion.writer.thread.thread.turns[2]!.status = 'interrupted';
    f.refs.completion.thread = f.pin(f.refs.completion.thread.path, f.completion.writer.thread);
  }
  if (defect === 'wrong-brief') {
    const path = join(f.evidence, 'legacy-completion-intent.json');
    const intent = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    f.pin(path, { ...intent, brief: f.refs.started });
  }
  if (defect === 'wrong-cold-resume') {
    const path = f.completion.resume.path;
    const resume = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    f.pin(path, { ...resume, phase: 'warm' });
  }
  f.refs.database = f.dbPin();
  expect(() => checkH06NativeLegacyDispatch(f.refs)).toThrow(message);
});

it('captures only the stopped thread and never overwrites primary bytes', async () => {
  const { warm } = fixture();
  rmSync(warm.refs.thread.path);
  const request = vi.fn(async () => warm.thread);
  const pinned = await captureH06NativeLegacyDispatchThread({ request }, warm.refs.stop);
  expect(request).toHaveBeenCalledExactlyOnceWith('thread/read', {
    threadId: 'thread-warm',
    includeTurns: true,
  });
  expect(JSON.parse(readH04Pin(pinned).toString())).toEqual(warm.thread);
  await expect(
    captureH06NativeLegacyDispatchThread({ request }, warm.refs.stop),
  ).rejects.toMatchObject({ code: 'EEXIST' });
});

it('does not save an incomplete native thread', async () => {
  const { warm } = fixture();
  rmSync(warm.refs.thread.path);
  warm.thread.thread.turns.pop();
  await expect(
    captureH06NativeLegacyDispatchThread({ request: async () => warm.thread }, warm.refs.stop),
  ).rejects.toThrow('h06-legacy-dispatch-thread');
  expect(existsSync(warm.refs.thread.path)).toBe(false);
});

it('allows an explicitly settled Store effect without omitting it from the inventory', () => {
  const f = fixture();
  f.mutate(
    {
      type: 'checkpoint',
      state: { workflow: { coders: f.inventory } } as Json,
      effects: [{ id: 'reserved', intent: {} }],
    },
    'reserve-unrelated-effect',
  );
  f.mutate(
    {
      type: 'effect',
      id: 'reserved',
      outcome: 'not-started',
      receipt: { reason: 'cancelled' },
    },
    'settle-unrelated-effect',
  );
  f.refs.database = f.dbPin();
  expect(checkH06NativeLegacyDispatch(f.refs).status).toBe('LEGACY_DISPATCH_CHAIN_VERIFIED');
});

it.each([
  'duplicate-native',
  'extra-native',
  'active',
  'wrong-thread',
  'wrong-marker',
  'wrong-terminal-id',
  'unknown-stop',
  'wrong-stop',
  'wrong-identity',
  'unbound-create',
  'unknown-live',
] as const)('refuses %s primary evidence', (change) => {
  const f = fixture();
  const w = f.warm;
  const turns = w.thread.thread.turns;
  if (change === 'duplicate-native') turns[1]!.id = turns[0]!.id;
  if (change === 'extra-native') turns.push(turns[2]!);
  if (change === 'active') turns[2]!.status = 'inProgress';
  if (change === 'wrong-thread') w.thread.thread.id = 'other';
  if (change === 'wrong-marker') turns[1]!.items[0]!.content[0]!.text = 'other';
  if (change === 'wrong-terminal-id') turns[2]!.id = 'other';
  if (change === 'unknown-stop') w.raw.active_turn = true;
  if (change === 'wrong-stop') w.raw.owned.turn = 'other';
  if (change === 'wrong-identity') w.intent.identity.generation = 2;
  if (change === 'unbound-create') w.coder.session.receipt.hash = '2'.repeat(64);
  if (change === 'unknown-live') w.intent.liveness.status = 'unknown';
  w.repin();
  expect(() => checkH06NativeLegacyDispatch(f.refs)).toThrow();
});

it.each([
  'missing',
  'extra',
  'unknown',
  'duplicate-send',
  'duplicate-response',
  'rpc-reuse',
  'changed-live',
  'extra-create',
  'unconfirmed-create',
  'third-coder',
] as const)('refuses %s in the durable transport inventory', (change) => {
  const f = fixture();
  const w = f.warm;
  const receipt = deliveryReceiptPath(w.journal, w.sessionId, w.delivery('implementation'));
  const other = deliveryReceiptPath(w.journal, w.sessionId, w.delivery('load'));
  if (change === 'missing') rmSync(receipt);
  if (change === 'extra') writeFileSync(join(w.journal + '.deliveries', 'extra.json'), '{}');
  if (change === 'unknown') f.pin(receipt, { ...w.receipt, outcome: 'unknown' });
  if (change === 'duplicate-send') f.pin(receipt, { ...w.receipt, attempts: 2 });
  if (change === 'duplicate-response') f.pin(receipt, { ...w.receipt, responses: 2 });
  if (change === 'rpc-reuse') {
    const load = readDeliveryReceipt(w.journal, w.sessionId, w.delivery('load'))!;
    f.pin(other, { ...load, rpc_id: w.receipt.rpc_id });
  }
  if (change === 'changed-live') f.pin(receipt, { ...w.receipt, response_hash: '2'.repeat(64) });
  if (change === 'extra-create') writeFileSync(join(w.journal + '.creations', 'extra.json'), '{}');
  if (change === 'unconfirmed-create') {
    const proof = nativeCreationProof(w.journal, w.operation)!;
    for (const name of [proof.source!.locator]) rmSync(name);
  }
  if (change === 'third-coder') mkdirSync(join(f.coders, 'third'));
  expect(() => checkH06NativeLegacyDispatch(f.refs)).toThrow();
});

it.each([
  'wrong-root',
  'active',
  'version',
  'wrong-owner',
  'third',
  'extra-op',
  'pending',
  'missing-ack',
  'wrong-ack',
  'wrong-event',
  'wrong-coder',
  'wrong-history',
  'bad-binding',
  'bad-send',
  'bad-turn',
] as const)('refuses %s in pinned Store evidence', (change) => {
  const f = fixture();
  const warm = f.warm.coder;
  if (change === 'wrong-root') f.refs.database.path += '.other';
  if (change === 'active') writeFileSync(f.database + '-journal', '');
  if (change === 'version') f.sql('PRAGMA user_version=3');
  if (change === 'wrong-owner') f.sql('UPDATE identity SET task=?', 'other');
  if (change === 'third') {
    f.inventory.third = {};
    f.checkpoint('next');
  }
  if (change === 'extra-op') f.checkpoint('coder:writer-warm:unexpected');
  if (change === 'pending')
    f.mutate(
      {
        type: 'checkpoint',
        state: { workflow: { coders: f.inventory } } as Json,
        effects: [{ id: 'pending', intent: {} }],
      },
      'pending',
    );
  if (change === 'missing-ack')
    f.sql('DELETE FROM operations WHERE id=?', 'coder:writer-cold:SENT');
  if (change === 'wrong-ack')
    f.sql("UPDATE operations SET ack='{}' WHERE id=?", 'coder:writer-warm:SENT');
  if (change === 'wrong-event') f.sql('UPDATE events SET body=\'{"change":{}}\' WHERE revision=10');
  if (change === 'wrong-coder') {
    f.inventory['writer-warm'] = { ...warm, turn: 'other' };
    f.checkpoint('next');
  }
  if (change === 'wrong-history') warm.history.pop();
  if (change === 'bad-binding')
    warm.history[3]!.payload = canonical({
      id: warm.history[3]!.id,
      type: 'BIND',
      generation: 1,
      session: {},
    });
  if (change === 'bad-send')
    warm.history[6]!.payload = canonical({
      id: warm.history[6]!.id,
      type: 'SEND_INTENT',
      generation: 1,
      delivery: 'other',
    });
  if (change === 'bad-turn')
    warm.history[7]!.payload = canonical({
      id: warm.history[7]!.id,
      type: 'SENT',
      generation: 1,
      turn: 'other',
    });
  if (['bad-binding', 'bad-send', 'bad-turn'].includes(change)) f.checkpoint('next');
  f.warm.repin();
  if (change !== 'wrong-root') f.refs.database = f.dbPin();
  expect(() => checkH06NativeLegacyDispatch(f.refs)).toThrow();
});
