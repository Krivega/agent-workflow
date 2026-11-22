import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import {
  enforceH06LegacyBudget,
  openH06NativeLegacyBudget,
} from './comparisonH06NativeLegacyBudget.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(maxManagedStarts = 3) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'h06-legacy-budget-')));
  roots.push(top);
  const evidenceRoot = join(top, 'legacy');
  const sessionsRoot = join(top, 'sessions');
  const root = join(top, 'writer');
  for (const path of [evidenceRoot, sessionsRoot, root]) mkdirSync(path);
  const journal = join(evidenceRoot, 'transport.jsonl');
  const binding = { variant: 'legacy' as const, operationId: 'legacy' };
  const budget = {
    maxElapsedMs: 20_000,
    reserveMs: 5_000,
    maxManagedStarts,
    maxInputUncached: 100,
    maxOutput: 20,
  };
  const request = { kind: 'comparison-h06-native/2', binding, evidenceRoot, budget };
  const startedAt = Date.now();
  const stopDeadlineMs = startedAt + budget.maxElapsedMs;
  const workDeadlineMs = stopDeadlineMs - budget.reserveMs;
  const path = join(evidenceRoot, 'attempt-claim.json');
  const assets = {};
  const bytes = canonical({
    kind: 'h06-native-attempt-claim',
    request,
    assets,
    requestHash: digest(canonical({ request, assets })),
    grant: { sessionsRoot },
    startedAt,
    stopDeadlineMs,
    workDeadlineMs,
  });
  writeFileSync(path, bytes);
  const claim = {
    request,
    receipt: { path, sha256: digest(bytes) },
    stopDeadlineMs,
    workDeadlineMs,
  };
  const open = (mode: 'create' | 'reopen' = 'create') => openH06NativeLegacyBudget(claim, mode);
  const session = 'writer-session';
  const thread = { id: session, cwd: root, path: join(sessionsRoot, 'writer.jsonl') };
  let serial = 0;
  const rpc = {
    request: vi.fn<AppServerRpc['request']>(async (method) =>
      method === 'turn/start' ? { turn: { id: `turn-${++serial}` } } : { thread, cwd: root },
    ),
    completed: vi.fn<AppServerRpc['completed']>(async () => {}),
  };
  const turn = (label: 'profile' | 'load' | 'implementation' = 'profile') => ({
    threadId: session,
    input: [{ type: 'text', text: `Workflow delivery id: "coder:writer:${label}"\nbrief` }],
  });
  const start = async (port: AppServerRpc) => port.request('thread/start', { cwd: root });
  const readUsage = vi.fn(() => ({
    status: 'WITHIN_BUDGET' as 'WITHIN_BUDGET' | 'UNKNOWN' | 'OVER_BUDGET',
    knownSubtotal: { inputUncached: 10, output: 2 },
  }));
  const wrap = (operator: ReturnType<typeof open>, read = readUsage) =>
    operator.wrap(rpc, { root, journal, readUsage: read });
  function log(inputTokens: number, terminal = true) {
    const usage = { input_tokens: inputTokens, cached_input_tokens: 2, output_tokens: 2 };
    const records = [
      { type: 'session_meta', payload: { id: session, session_id: session, cwd: root } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      {
        type: 'token_usage_record',
        payload: {
          session_id: session,
          thread_id: session,
          turn_id: 'turn-1',
          response_id: 'response-1',
          usage,
          thread_token_usage: usage,
        },
      },
    ];
    if (terminal)
      records.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } });
    writeFileSync(thread.path, records.map(canonical).join('\n') + '\n');
  }
  return {
    claim,
    open,
    rpc,
    wrap,
    thread,
    root,
    journal,
    sessionsRoot,
    start,
    turn,
    readUsage,
    log,
  };
}

it('reserves one managed start before dispatch and keeps the limit across reopen', async () => {
  const f = fixture(2);
  const controller = f.open();
  const transport = f.wrap(controller);
  await expect(transport.request('turn/start', f.turn())).rejects.toThrow('budget-session');
  await f.start(transport);
  f.rpc.request.mockImplementationOnce(async () => {
    expect(controller.inspect()).toMatchObject({ status: 'UNKNOWN', used: 1 });
    return { turn: { id: 'profile-turn' } };
  });
  await transport.request('turn/start', f.turn());
  expect(f.readUsage).not.toHaveBeenCalled();
  const next = f.open('reopen');
  const resumed = f.wrap(next);
  await resumed.request('thread/resume', { cwd: f.root, threadId: f.thread.id });
  await resumed.request('turn/start', f.turn('load'));
  expect(f.readUsage).toHaveBeenCalledOnce();
  await expect(resumed.request('turn/start', f.turn('implementation'))).rejects.toThrow(
    'budget-starts',
  );
  expect(next.inspect()).toMatchObject({ status: 'RECORDED', used: 2 });
});

it('keeps a lost reply unknown, blocks resend across reopen and leaves STOP accessible', async () => {
  const f = fixture();
  const controller = f.open();
  const port = f.wrap(controller);
  await f.start(port);
  f.rpc.request.mockRejectedValueOnce(new Error('lost reply'));
  await expect(port.request('turn/start', f.turn())).rejects.toThrow('lost reply');
  const next = f.open('reopen');
  const resumed = f.wrap(next);
  await f.start(resumed);
  await expect(resumed.request('turn/start', f.turn('load'))).rejects.toThrow('budget-starts');
  await resumed.request('turn/interrupt', { threadId: f.thread.id, turnId: 'turn-1' });
  const cleanup = vi.fn();
  await next.stop(cleanup);
  await next.stop(cleanup);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(next.inspect()).toMatchObject({ status: 'UNKNOWN', used: 1 });
  const observe = vi.fn();
  expect(await next.readUsage(next.inspect(), observe)).toMatchObject({ status: 'UNKNOWN' });
  expect(observe).not.toHaveBeenCalled();
  expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});

it.each([
  { status: 'UNKNOWN', knownSubtotal: { inputUncached: 0, output: 0 } },
  { status: 'OVER_BUDGET', knownSubtotal: { inputUncached: 101, output: 0 } },
  { status: 'WITHIN_BUDGET', knownSubtotal: { inputUncached: 100, output: 0 } },
  { status: 'WITHIN_BUDGET', knownSubtotal: { inputUncached: 0, output: 20 } },
  { status: 'WITHIN_BUDGET', knownSubtotal: { inputUncached: -1, output: 0 } },
] as const)(
  'denies a second turn with unresolved or exhausted usage $knownSubtotal',
  async (usage) => {
    const f = fixture();
    f.readUsage.mockReturnValue(usage);
    const controller = f.open();
    const port = f.wrap(controller);
    await f.start(port);
    await port.request('turn/start', f.turn());
    await expect(port.request('turn/start', f.turn('load'))).rejects.toThrow('budget-usage');
    expect(controller.inspect()).toMatchObject({ status: 'RECORDED', used: 1 });
  },
);

it('requires all admitted native terminals and primary usage from the owned session', async () => {
  const f = fixture();
  const controller = f.open();
  const observe = vi.fn(() => ({ thread: f.thread }));
  const port = controller.wrap(f.rpc, {
    root: f.root,
    journal: f.journal,
    readUsage: (ledger) => controller.readUsage(ledger, observe),
  });
  await f.start(port);
  await port.request('turn/start', f.turn());
  const retained = controller.inspect();
  expect(await controller.readUsage(retained, observe)).toMatchObject({ status: 'UNKNOWN' });
  f.log(12, false);
  await expect(port.request('turn/start', f.turn('load'))).rejects.toThrow('budget-usage');
  f.log(103);
  expect(await controller.readUsage(retained, observe)).toMatchObject({
    status: 'OVER_BUDGET',
    knownSubtotal: { inputUncached: 101, output: 2 },
    wholeAttemptComplete: false,
    providerHardCap: false,
  });
  f.log(12);
  expect(
    await controller.readUsage(retained, () => ({ thread: { ...f.thread, id: 'other' } })),
  ).toMatchObject({ status: 'UNKNOWN' });
  expect(await controller.readUsage(retained, observe)).toMatchObject({
    status: 'WITHIN_BUDGET',
    knownSubtotal: { inputUncached: 10, output: 2 },
  });
  await port.request('turn/start', f.turn('load'));
  await expect(controller.readUsage(retained, observe)).rejects.toThrow('budget-usage-ledger');
  expect(await controller.readUsage(controller.inspect(), observe)).toMatchObject({
    status: 'UNKNOWN',
  });
});

it('retains proven overage when another managed session has no evidence, but discards changed bytes', async () => {
  const f = fixture();
  const controller = f.open();
  const port = f.wrap(controller);
  await f.start(port);
  await port.request('turn/start', f.turn());
  const secondThread = { ...f.thread, id: 'second-session', path: f.thread.path + '.other' };
  const second = controller.wrap(
    {
      request: async (method) =>
        method === 'turn/start'
          ? { turn: { id: 'second-turn' } }
          : { thread: secondThread, cwd: f.root },
      completed: async () => {},
    },
    { root: f.root, journal: f.journal, readUsage: f.readUsage },
  );
  await f.start(second);
  await second.request('turn/start', { ...f.turn('load'), threadId: secondThread.id });
  const ledger = controller.inspect();
  f.log(103);
  const observe = ({ session }: { session: string }) => ({
    thread: session === f.thread.id ? f.thread : secondThread,
  });
  expect(await controller.readUsage(ledger, observe)).toMatchObject({
    status: 'OVER_BUDGET',
    knownSubtotal: { inputUncached: 101 },
  });
  expect(
    await controller.readUsage(ledger, (scope) => {
      if (scope.session === secondThread.id) f.log(12);
      return observe(scope);
    }),
  ).toMatchObject({ status: 'UNKNOWN' });
});

it.each([
  ['append-only', 'append', 10],
  ['append-only', 'rewrite', 0],
  ['immutable', 'append', 0],
] as const)(
  'keeps %s journal prefix evidence after %s without treating missing participants as complete',
  async (mode, change, expectedInput) => {
    const f = fixture();
    const controller = enforceH06LegacyBudget(f.claim, 'create', f.sessionsRoot, mode);
    const first = f.wrap(controller);
    await f.start(first);
    await first.request('turn/start', f.turn());
    const other = { ...f.thread, id: 'other-writer', path: f.thread.path + '.missing' };
    const second = controller.wrap(
      {
        request: async (method) =>
          method === 'turn/start' ? { turn: { id: 'other-turn' } } : { thread: other, cwd: f.root },
        completed: async () => {},
      },
      { root: f.root, journal: f.journal, readUsage: f.readUsage },
    );
    await f.start(second);
    await second.request('turn/start', { ...f.turn('load'), threadId: other.id });
    f.log(12);
    const usage = await controller.readUsage(controller.inspect(), (scope) => {
      if (scope.session === other.id) {
        if (change === 'append')
          appendFileSync(
            f.thread.path,
            canonical({ type: 'event_msg', payload: { type: 'background_notification' } }) + '\n',
          );
        else f.log(13);
      }
      return { thread: scope.session === other.id ? other : f.thread };
    });
    expect(usage).toMatchObject({
      status: 'UNKNOWN',
      knownSubtotal: { inputUncached: expectedInput, output: expectedInput === 0 ? 0 : 2 },
      wholeAttemptComplete: false,
    });
  },
);

it('cuts off work, allows read/interrupt and stops even after the reserve is lost', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const epoch = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - epoch);
  const f = fixture();
  const controller = f.open();
  const port = f.wrap(controller);
  await port.request('mcpServerStatus/list', {});
  await expect(port.request('turn/steer', {})).rejects.toThrow('budget-method');
  await f.start(port);
  f.rpc.request.mockImplementationOnce(async () => new Promise(() => undefined));
  const pending = expect(port.request('turn/start', f.turn())).rejects.toThrow('budget-work');
  await vi.advanceTimersByTimeAsync(15_000);
  await pending;
  await expect(port.request('thread/start', { cwd: f.root })).rejects.toThrow('budget-work');
  await port.request('thread/read', { threadId: f.thread.id });
  await port.request('turn/interrupt', { threadId: f.thread.id, turnId: 'turn-1' });
  const verify = vi.fn(async () => {});
  await port.completed(f.thread.id, 'turn-1', new AbortController().signal, verify);
  expect(f.rpc.completed).toHaveBeenCalledWith(
    f.thread.id,
    'turn-1',
    expect.any(AbortSignal),
    verify,
  );
  await port.completed(f.thread.id, 'turn-1');
  await vi.advanceTimersByTimeAsync(5_000);
  const cleanup = vi.fn(async () => {
    throw new Error('transport did not confirm cleanup');
  });
  await expect(controller.stop(cleanup)).rejects.toThrow('budget-stop');
  expect(cleanup).toHaveBeenCalledOnce();
  expect(controller.inspect()).toMatchObject({ status: 'UNKNOWN', used: 1 });
});

it('rejects substituted claim bounds, transports outside evidence and unbound thread replies', async () => {
  const f = fixture();
  expect(() =>
    openH06NativeLegacyBudget({ ...f.claim, workDeadlineMs: f.claim.stopDeadlineMs }, 'create'),
  ).toThrow('budget-claim');
  const controller = f.open();
  expect(() =>
    controller.wrap(f.rpc, {
      root: f.root,
      journal: join(f.root, 'outside.jsonl'),
      readUsage: f.readUsage,
    }),
  ).toThrow('budget-transport');
  const port = f.wrap(controller);
  await expect(port.request('thread/start', { cwd: f.journal })).rejects.toThrow('budget-thread');
  await expect(port.request('thread/resume', { cwd: f.root, threadId: 'other' })).rejects.toThrow(
    'budget-thread',
  );
});
