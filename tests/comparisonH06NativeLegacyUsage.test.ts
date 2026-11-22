import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../adapters/storage/storeCodec.js';
import { checkH06NativeLegacyDispatch } from './comparisonH06NativeLegacyDispatch.js';
import { checkH06NativeLegacyAttemptUsage } from './comparisonH06NativeLegacyUsage.js';
import * as shared from './comparisonH06NativeUsage.js';

vi.mock('./comparisonH06NativeLegacyDispatch.js', () => ({
  checkH06NativeLegacyDispatch: vi.fn(),
}));

const dispatch = vi.mocked(checkH06NativeLegacyDispatch);
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(maxOutput = 100, completed = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-legacy-usage-'));
  roots.push(root);
  const sessionsRoot = join(root, 'sessions');
  mkdirSync(sessionsRoot);
  const pin = (path: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const claim = pin(join(root, 'attempt-claim.json'), {
    grant: { sessionsRoot },
    request: { budget: { maxInputUncached: 100, maxOutput } },
  });
  const started = pin(join(root, 'legacy-operator-start.json'), { claim });
  const phase = (name: string) => {
    const session = 'writer-' + name;
    const copy = join(root, 'copy-' + name);
    const transcript = join(sessionsRoot, session + '.jsonl');
    const turns = ['profile', 'load', 'implementation'].map((delivery) => ({
      turn: name + '-' + delivery,
      delivery,
      requestHash: digest(name + delivery + 'req'),
      responseHash: digest(name + delivery + 'resp'),
    }));
    const thread = { id: session, cwd: copy, path: transcript as unknown };
    const usage = (index: number) => ({
      input_tokens: 5 * index,
      cached_input_tokens: index,
      output_tokens: 2 * index,
    });
    const logs = [
      { type: 'session_meta', payload: { id: session, session_id: session, cwd: copy } },
      ...turns.flatMap(({ turn }, index) => [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
        {
          type: 'token_usage_record',
          payload: {
            turn_id: turn,
            thread_id: session,
            session_id: session,
            response_id: turn + '-response',
            usage: usage(1),
            thread_token_usage: usage(index + 1),
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: index === 2 && name !== 'completion' ? 'turn_aborted' : 'task_complete',
            turn_id: turn,
          },
        },
      ]),
    ];
    function writeLogs(records: unknown[] = logs, newline = true) {
      const bytes = records.map((row) => JSON.stringify(row)).join('\n') + (newline ? '\n' : '');
      writeFileSync(transcript, bytes);
      return bytes;
    }
    writeLogs();
    const refs = {
      stop: pin(join(root, name + '-stop.json'), {}),
      thread: pin(join(root, name + '-thread.json'), { thread }),
    };
    const patchThread = (change: Record<string, unknown>) =>
      pin(refs.thread.path, { thread: { ...thread, ...change } });
    return {
      refs,
      transcript,
      logs,
      writeLogs,
      patchThread,
      attempt: { coderId: 'coder-' + name, thread: session, implementation: turns[2]!.turn, turns },
    };
  };
  const warm = phase('warm');
  const cold = phase('cold');
  const completion = completed ? phase('completion') : null;
  const result = {
    status: 'LEGACY_DISPATCH_CHAIN_VERIFIED',
    operationId: 'legacy-attempt',
    attempts: [warm.attempt, cold.attempt, ...(completion === null ? [] : [completion.attempt])],
    store: [],
    qualification: false,
  } as const;
  dispatch.mockReturnValue({ ...result, attempts: [...result.attempts], store: [] });
  return {
    root,
    pin,
    claim,
    warm,
    cold,
    completion,
    input: {
      started,
      database: pin(join(root, 'database'), {}),
      warm: warm.refs,
      cold: cold.refs,
      ...(completion === null
        ? {}
        : {
            completion: {
              coder: pin(join(root, 'coder.json'), {}),
              thread: completion.refs.thread,
            },
          }),
    },
  };
}

it('accounts exact stopped Writers from native response records and keeps whole attempt unknown', () => {
  const { input, warm, cold } = fixture();
  const checked = checkH06NativeLegacyAttemptUsage(input);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(input);
  expect(checked).toMatchObject({
    status: 'UNKNOWN',
    dispatchStatus: 'LEGACY_DISPATCH_CHAIN_VERIFIED',
    wholeAttemptComplete: false,
    providerHardCap: false,
    missing: [],
    writerUsage: {
      status: 'WITHIN_BUDGET',
      totals: { responses: 6, inputUncached: 24, inputCached: 6, output: 12 },
    },
    writerSources: [
      { path: warm.transcript, sha256: digest(warm.writeLogs()) },
      { path: cold.transcript, sha256: digest(cold.writeLogs()) },
    ],
  });
  expect(checked.writerUsage.receipts.every((row) => row.run === 'legacy-attempt')).toBe(true);
});

it('adds the completed Writer to the verified subtotal and does not report aborted terminal usage as known', () => {
  const { input, completion } = fixture(17, true);
  expect(checkH06NativeLegacyAttemptUsage(input)).toMatchObject({
    status: 'OVER_BUDGET',
    missing: [],
    writerUsage: { totals: { responses: 9, inputUncached: 36, inputCached: 9, output: 18 } },
  });
  const records = completion!.logs;
  records[records.length - 1] = {
    type: 'event_msg',
    payload: { type: 'turn_aborted', turn_id: 'completion-implementation' },
  };
  completion!.writeLogs(records);
  expect(checkH06NativeLegacyAttemptUsage(input)).toMatchObject({
    status: 'UNKNOWN',
    missing: [{ phase: 'completion', reason: 'transcript-incomplete' }],
    writerUsage: { knownSubtotal: { responses: 6, output: 12 } },
  });
});

it('refuses an incomplete dispatch inventory for the completion form', () => {
  const { input } = fixture(100, true);
  const result = dispatch(input);
  dispatch.mockClear().mockReturnValue({ ...result, attempts: result.attempts.slice(0, 2) });
  expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow(
    'h06-legacy-usage-dispatch-inventory',
  );
});

it('uses native cumulative counters when there are no individual response records', () => {
  const { input, warm } = fixture();
  let index = 0;
  const logs = warm.logs.map((row) => {
    if (row.type !== 'token_usage_record') return row;
    index++;
    return {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: index * 5,
            cached_input_tokens: index,
            output_tokens: index * 2,
          },
          last_token_usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 },
        },
      },
    };
  });
  warm.writeLogs(logs);
  expect(checkH06NativeLegacyAttemptUsage(input).writerUsage.totals).toEqual({
    responses: 6,
    inputUncached: 24,
    inputCached: 6,
    output: 12,
  });
});

it.each([
  'no-path',
  'absent',
  'partial',
  'missing-turn',
  'missing-terminal',
  'missing-session',
  'overlap',
  'foreign-terminal',
  'unlabelled-terminal',
  'out-of-order',
] as const)(
  'preserves only the verified subtotal when a Writer source is incomplete (%s)',
  (reason) => {
    const { input, cold } = fixture();
    if (reason === 'no-path') input.cold.thread = cold.patchThread({ path: null });
    if (reason === 'absent') rmSync(cold.transcript);
    if (reason === 'partial') cold.writeLogs(cold.logs, false);
    if (reason === 'missing-turn') cold.writeLogs(cold.logs.slice(0, -3));
    if (reason === 'missing-terminal') cold.writeLogs(cold.logs.slice(0, -1));
    if (reason === 'missing-session') cold.writeLogs(cold.logs.slice(1));
    if (reason === 'overlap') cold.writeLogs(cold.logs.filter((_, index) => index !== 3));
    if (reason === 'foreign-terminal')
      cold.writeLogs([
        ...cold.logs.slice(0, -1),
        {
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'foreign' },
        },
      ]);
    if (reason === 'unlabelled-terminal')
      cold.writeLogs([
        ...cold.logs.slice(0, -1),
        {
          type: 'event_msg',
          payload: { type: 'task_aborted' },
        },
      ]);
    if (reason === 'out-of-order')
      cold.writeLogs([
        cold.logs[0],
        ...cold.logs.slice(4, 7),
        ...cold.logs.slice(1, 4),
        ...cold.logs.slice(7),
      ]);
    expect(checkH06NativeLegacyAttemptUsage(input)).toMatchObject({
      status: 'UNKNOWN',
      writerUsage: {
        status: 'UNKNOWN',
        totals: { responses: null, inputUncached: null, inputCached: null, output: null },
        knownSubtotal: { responses: 3, inputUncached: 12, inputCached: 3, output: 6 },
      },
      missing: [
        {
          phase: 'cold',
          reason:
            reason === 'no-path'
              ? 'transcript-unavailable'
              : reason === 'absent'
                ? 'transcript-absent'
                : 'transcript-incomplete',
        },
      ],
    });
  },
);

it.each([false, true])(
  'reports proven excess even when one source is incomplete (%s)',
  (incomplete) => {
    const { input, cold } = fixture(5);
    if (incomplete) rmSync(cold.transcript);
    expect(checkH06NativeLegacyAttemptUsage(input)).toMatchObject({
      status: 'OVER_BUDGET',
      writerUsage: { status: 'OVER_BUDGET', exceeded: { output: true } },
    });
  },
);

it('preserves UNKNOWN when the original dispatch readback has missing durable evidence', () => {
  const { input } = fixture();
  dispatch.mockImplementation(() => {
    throw Object.assign(new Error('missing dispatch'), { code: 'ENOENT' });
  });
  expect(checkH06NativeLegacyAttemptUsage(input)).toMatchObject({
    status: 'UNKNOWN',
    dispatchStatus: 'UNKNOWN',
    writerSources: [],
    writerUsage: {
      totals: { responses: null, inputUncached: null, inputCached: null, output: null },
    },
  });
});

it('rejects disputed dispatch rather than treating it as a missing roster', () => {
  const { input } = fixture();
  dispatch.mockImplementation(() => {
    throw new Error('h06-legacy-dispatch-inventory');
  });
  expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow('h06-legacy-dispatch-inventory');
});

it.each([
  { id: 'other-writer' },
  { path: 7 },
  { path: 'relative.jsonl' },
  { path: '/any/../other.jsonl' },
  { path: '/outside.jsonl' },
])('rejects conflicting native path or identity (%j)', (change) => {
  const { input, cold } = fixture();
  input.cold.thread = cold.patchThread(change);
  expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow(
    'h06-legacy-usage-transcript-binding',
  );
});

it.each(['duplicate-meta', 'thread', 'session', 'cwd'] as const)(
  'rejects inconsistent metadata (%s)',
  (mode) => {
    const { input, cold } = fixture();
    if (mode === 'duplicate-meta') cold.writeLogs([cold.logs[0], ...cold.logs]);
    else {
      const field = mode === 'thread' ? 'id' : mode === 'session' ? 'session_id' : 'cwd';
      const row = cold.logs[0]!;
      cold.writeLogs([
        { ...row, payload: { ...row.payload, [field]: 'wrong' } },
        ...cold.logs.slice(1),
      ]);
    }
    expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow(
      'h06-legacy-usage-transcript-binding',
    );
  },
);

it.each([
  'foreign-start',
  'malformed-start',
  'duplicate-start',
  'foreign-usage',
  'malformed-usage',
  'duplicate-terminal',
] as const)('rejects conflicting turn evidence (%s)', (mode) => {
  const { input, cold } = fixture();
  const records = [...cold.logs] as { type: string; payload: Record<string, unknown> }[];
  if (mode === 'foreign-start')
    records[1] = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'unknown' } };
  if (mode === 'malformed-start')
    records[1] = { type: 'event_msg', payload: { type: 'task_started' } };
  if (mode === 'duplicate-start') records.splice(4, 0, records[1]!);
  if (mode === 'foreign-usage')
    records[2] = { type: 'token_usage_record', payload: { turn_id: 'foreign' } };
  if (mode === 'malformed-usage') records[2] = { type: 'token_usage_record', payload: {} };
  if (mode === 'duplicate-terminal') records.splice(4, 0, records[3]!);
  cold.writeLogs(records);
  expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow('h06-legacy-usage-turn-binding');
});

it('rejects changed transcript bytes across accounting', () => {
  const { input, cold } = fixture();
  const measure = shared.checkH06NativeUsage;
  vi.spyOn(shared, 'checkH06NativeUsage').mockImplementationOnce((request) => {
    const result = measure(request);
    cold.writeLogs(cold.logs, false);
    return result;
  });
  expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow(
    'h06-legacy-usage-transcript-changed',
  );
});

it('rejects source hashes that would be calculated over invalid UTF-8', () => {
  const { input, cold } = fixture();
  writeFileSync(cold.transcript, Buffer.from([255, 10]));
  expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow(
    'h06-legacy-usage-transcript-encoding',
  );
});

it('leaves cumulative counters outside the observed turn roster unattributed', () => {
  const { input, cold } = fixture();
  cold.writeLogs([
    cold.logs[0],
    { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    ...cold.logs.slice(1),
  ]);
  expect(checkH06NativeLegacyAttemptUsage(input)).toMatchObject({
    missing: [{ phase: 'cold', reason: 'transcript-incomplete' }],
    writerUsage: { status: 'UNKNOWN' },
  });
});

it('allows empty usage observations before a Writer turn starts', () => {
  const { input, cold } = fixture();
  cold.writeLogs([
    cold.logs[0],
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
    ...cold.logs.slice(1),
  ]);
  expect(checkH06NativeLegacyAttemptUsage(input).writerUsage.status).toBe('WITHIN_BUDGET');
});

it('does not turn unsafe transcript paths into missing evidence', () => {
  const { input, cold } = fixture();
  rmSync(cold.transcript);
  mkdirSync(cold.transcript);
  expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow('h01-file-kind');
});

it('rejects a crossed claim or unresolved native session root', () => {
  const { root, input, claim, pin } = fixture();
  input.started = pin(input.started.path, { claim: { ...claim, path: join(root, 'wrong.json') } });
  expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow('h06-legacy-usage-claim');
  const updated = pin(claim.path, { grant: {}, request: { budget: {} } });
  input.started = pin(input.started.path, { claim: updated });
  expect(() => checkH06NativeLegacyAttemptUsage(input)).toThrow('h06-legacy-usage-sessions');
});
