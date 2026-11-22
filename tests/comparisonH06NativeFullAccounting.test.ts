import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as nativeUsage from '../adapters/codex/comparisonUsage.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { verifyH06DelegatedDelivery } from './comparisonH06DelegatedDelivery.js';
import * as nativeJournal from './comparisonH06NativeJournal.js';
import { checkH06NativeFullAccounting } from './comparisonH06NativeFullAccounting.js';

vi.mock('./comparisonH06DelegatedDelivery.js', () => ({
  verifyH06DelegatedDelivery: vi.fn((value: unknown) => value),
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-full-accounting-'));
  roots.push(root);
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  const json = (name: string, value: unknown) => {
    const path = join(root, name),
      bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const journals: Record<string, Record<string, unknown>[]> = {};
  const transcript = (session: string, turns: string[]) => {
    const path = join(sessions, session + '.jsonl');
    journals[path] = [
      { type: 'session_meta', payload: { id: session } },
      ...turns.flatMap((turn, index) => [
        {
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: turn,
            turn_attribution: {
              turn_trigger: 'app_tool_send_message',
              parent_turn_id: 'root-turn',
              root_turn_id: 'root-turn',
            },
          },
        },
        { type: 'turn_context', payload: { turn_id: turn, model: 'model', effort: 'medium' } },
        {
          type: 'token_usage_record',
          payload: {
            session_id: session,
            thread_id: session,
            turn_id: turn,
            response_id: `${session}-${turn}`,
            usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 },
            thread_token_usage: {
              input_tokens: (index + 1) * 10,
              cached_input_tokens: (index + 1) * 3,
              output_tokens: (index + 1) * 2,
            },
          },
        },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, duration_ms: 1000 } },
      ]),
    ];
    return path;
  };
  const rootTranscript = transcript('root', ['root-turn']),
    actorTranscript = transcript('actor', ['load', 'wp', 'wr', 'cp', 'cr']);
  const source = { locator: rootTranscript + '#L3', hash: 'a'.repeat(64) };
  const claimed = {
    source: { transcript: rootTranscript, turnId: 'root-turn', source },
    actorId: 'actor',
    requestHash: 'request',
    request: { chat: { threadId: 'root' }, binding: { operationId: 'operation' } },
  };
  const claim = json('claim.json', claimed);
  const proofs = ['load', 'wp', 'wr', 'cp', 'cr'].map((turn) => ({
    input: {
      root: { threadId: 'root', turnId: 'root-turn' },
      actor: { threadId: 'actor' },
      command: { requestHash: 'request', target: { claim } },
    },
    user: source,
    inbound: { locator: actorTranscript + '#L3' },
    actorTurnId: turn,
  }));
  const deliveries = proofs.map((proof, index) => json(`delivery-${index}.json`, proof));
  const admissions = ['warm', 'cold', 'final'].flatMap((session) =>
    [0, 1, 2].map((index) => {
      const turnId = `${session}-${index}`,
        scope = { session };
      const pin = json(turnId + '-admission.json', { scope });
      const response = { pin: json(turnId + '-response.json', { admission: pin, turnId }), turnId };
      return { scope, pin, response };
    }),
  );
  const nativeSources = ['warm', 'cold', 'final'].map((session) => ({
    session,
    transcript: transcript(
      session,
      [0, 1, 2].map((index) => `${session}-${index}`),
    ),
  }));
  const outcome = {
    kind: 'h06-delegated-run-outcome/1',
    status: 'completed',
    claim,
    acceptance: {
      status: 'PASS',
      profile: 'h06-autonomous-recovery/3',
      wholeAttemptComplete: false,
      qualification: false,
    },
    usage: {
      caps: { maxInputUncached: 100, maxOutput: 20, maxElapsedMs: 900 },
      wholeAttemptComplete: false,
      claim,
      ledger: { status: 'RECORDED', used: 9, admissions },
      nativeSources,
      knownSubtotal: { responses: 9, inputUncached: 63, inputCached: 27, output: 18 },
    },
  };
  const sharedTranscript = transcript('architect', ['plan']);
  const input = {
    outcome: json('outcome.json', outcome),
    deliveries,
    shared: [
      {
        label: 'reused-architecture',
        session: 'architect',
        transcript: sharedTranscript,
        turns: ['plan'],
      },
    ],
  };
  const save = () => {
    for (const [path, rows] of Object.entries(journals))
      writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    input.outcome = json('outcome.json', outcome);
    proofs.forEach((proof, index) => {
      input.deliveries[index] = json(`delivery-${index}.json`, proof);
    });
  };
  save();
  return {
    input,
    outcome,
    claim,
    claimed,
    proofs,
    journals,
    rootTranscript,
    actorTranscript,
    json,
    save,
  };
}

it('reports all bound direct turns and separate nonzero shared costs without upgrading recovery', () => {
  const f = fixture(),
    before = readFileSync(f.input.outcome.path);
  const result = checkH06NativeFullAccounting(f.input);
  expect(result.direct.knownSubtotal).toEqual({
    responses: 15,
    input_uncached: 105,
    input_cached: 45,
    output: 30,
  });
  expect(result.direct.participants.map((entry) => entry.windows.length)).toEqual([1, 5, 3, 3, 3]);
  expect(result.rootDurationMs).toBe(1000);
  expect(result.shared[0]!.knownSubtotal.responses).toBe(1);
  expect(result.shared[0]!.attribution).toBe('SHARED_NOT_ALLOCATED');
  expect(result.wholeAttemptCost).toBe('UNKNOWN');
  expect(result.wholeAttemptComplete).toBe(false);
  expect(result.qualification).toBe(false);
  expect(result.budgetScope).toBe('managed-writers-only');
  expect(verifyH06DelegatedDelivery).toHaveBeenCalledTimes(5);
  expect(readFileSync(f.input.outcome.path)).toEqual(before);
});

it.each([
  [
    'kind',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.kind = 'wrong';
    },
  ],
  [
    'status',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.status = 'failed';
    },
  ],
  [
    'acceptance',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.acceptance.status = 'FAIL';
    },
  ],
  [
    'profile',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.acceptance.profile = 'manual';
    },
  ],
  [
    'whole',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.acceptance.wholeAttemptComplete = true;
    },
  ],
  [
    'qualification',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.acceptance.qualification = true;
    },
  ],
  [
    'managed whole',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.usage.wholeAttemptComplete = true;
    },
  ],
  [
    'managed claim',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.usage.claim = { ...f.claim, sha256: 'b'.repeat(64) };
    },
  ],
  [
    'ledger status',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.usage.ledger.status = 'UNKNOWN';
    },
  ],
  [
    'ledger count',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.usage.ledger.used = 8;
    },
  ],
  [
    'admissions kind',
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.outcome.usage.ledger, { admissions: null });
    },
  ],
  [
    'admissions count',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.usage.ledger.admissions.pop();
    },
  ],
  [
    'native kind',
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.outcome.usage, { nativeSources: null });
    },
  ],
  [
    'native count',
    (f: ReturnType<typeof fixture>) => {
      f.outcome.usage.nativeSources.pop();
    },
  ],
  [
    'delivery count',
    (f: ReturnType<typeof fixture>) => {
      f.input.deliveries.pop();
      f.proofs.pop();
    },
  ],
] as const)('rejects changed sealed %s', (_name, mutate) => {
  const f = fixture();
  mutate(f);
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-attempt');
});

it.each(['threadId', 'turnId', 'user', 'actor', 'request', 'claim'] as const)(
  'rejects delivery %s rebinding',
  (field) => {
    const f = fixture(),
      p = f.proofs[0]!;
    if (field === 'threadId' || field === 'turnId') p.input.root[field] = 'other';
    if (field === 'user') p.user = { ...p.user, hash: 'b'.repeat(64) };
    if (field === 'actor') p.input.actor.threadId = 'other';
    if (field === 'request') p.input.command.requestHash = 'other';
    if (field === 'claim') p.input.command.target.claim = { ...f.claim, sha256: 'b'.repeat(64) };
    f.save();
    expect(() => checkH06NativeFullAccounting(f.input)).toThrow(
      'h06-full-accounting-delivery-binding',
    );
  },
);

it('rejects separate actor journal paths', () => {
  const f = fixture();
  f.proofs[0]!.inbound.locator = '/other#L3';
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-actor-path');
});

it.each(['empty', 'duplicate'] as const)('rejects %s turn inventory', (kind) => {
  const f = fixture();
  if (kind === 'empty') f.input.shared[0]!.turns = [];
  else f.proofs[1]!.actorTurnId = 'load';
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-turn-inventory');
});

it.each(['missing-start', 'missing-end', 'duplicate-start', 'duplicate-end', 'reversed'] as const)(
  'rejects %s terminal window',
  (kind) => {
    const f = fixture(),
      rows = f.journals[f.rootTranscript]!;
    if (kind === 'missing-start') rows.splice(1, 1);
    if (kind === 'missing-end') rows.pop();
    if (kind === 'duplicate-start') rows.push(rows[1]!);
    if (kind === 'duplicate-end') rows.push(rows[4]!);
    if (kind === 'reversed') [rows[1], rows[4]] = [rows[4]!, rows[1]!];
    f.save();
    expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-terminal');
  },
);

it('preserves unknown duration instead of inventing zero', () => {
  const f = fixture();
  delete (f.journals[f.rootTranscript]![4]!.payload as Record<string, unknown>).duration_ms;
  f.save();
  expect(checkH06NativeFullAccounting(f.input).rootDurationMs).toBeNull();
});

it.each(['bad', -1, 0.5])('rejects invalid duration %s', (duration_ms) => {
  const f = fixture();
  Object.assign(f.journals[f.rootTranscript]![4]!.payload as object, { duration_ms });
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-duration');
});

it.each(['missing', 'duplicate'] as const)('rejects %s effective context', (kind) => {
  const f = fixture(),
    rows = f.journals[f.rootTranscript]!;
  if (kind === 'missing') rows.splice(2, 1);
  else rows.splice(2, 0, rows[2]!);
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-context');
});

it.each(['turn_trigger', 'parent_turn_id', 'root_turn_id'] as const)(
  'rejects actor attribution %s mismatch',
  (field) => {
    const f = fixture();
    (
      (f.journals[f.actorTranscript]![1]!.payload as Record<string, unknown>)
        .turn_attribution as Record<string, unknown>
    )[field] = 'other';
    f.save();
    expect(() => checkH06NativeFullAccounting(f.input)).toThrow(
      'h06-full-accounting-actor-attribution',
    );
  },
);

it('rejects missing writer admission', () => {
  const f = fixture();
  f.outcome.usage.ledger.admissions[0]!.scope.session = 'other';
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow(
    'h06-full-accounting-writer-inventory',
  );
});

it.each(['scope', 'admission', 'turn'] as const)('rejects changed ledger %s', (kind) => {
  const f = fixture(),
    e = f.outcome.usage.ledger.admissions[0]!;
  if (kind === 'scope') e.pin = f.json('other-admission.json', { scope: {} });
  if (kind === 'admission')
    e.response.pin = f.json('other-response.json', { admission: {}, turnId: e.response.turnId });
  if (kind === 'turn') e.response.turnId = 'other';
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-ledger-binding');
});

it('rejects overlapping direct participant sessions', () => {
  const f = fixture();
  f.outcome.usage.nativeSources[0]!.session = 'actor';
  f.outcome.usage.nativeSources[0]!.transcript = f.actorTranscript;
  for (const e of f.outcome.usage.ledger.admissions.slice(0, 3)) {
    e.scope.session = 'actor';
    e.pin = f.json(e.response.turnId + '-updated.json', { scope: e.scope });
    e.response.pin = f.json(e.response.turnId + '-response-updated.json', {
      admission: e.pin,
      turnId: e.response.turnId,
    });
  }
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-terminal');
});

it('rejects an unrecorded turn rather than turning absent response usage into zero', () => {
  const f = fixture();
  f.journals[f.rootTranscript]!.splice(3, 1);
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow(
    'h06-full-accounting-incomplete-usage',
  );
});

it('deduplicates identical source receipts across shared references', () => {
  const f = fixture();
  f.input.shared.push({
    label: 'same-source',
    session: 'root',
    transcript: f.rootTranscript,
    turns: ['root-turn'],
  });
  expect(checkH06NativeFullAccounting(f.input).direct.knownSubtotal.responses).toBe(15);
});

it('rejects response id reuse across different sources', () => {
  const f = fixture(),
    path = f.outcome.usage.nativeSources[0]!.transcript;
  (f.journals[path]![3]!.payload as Record<string, unknown>).response_id = 'root-root-turn';
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow(
    'h06-full-accounting-response-conflict',
  );
});

it('rejects an aggregate overflow', () => {
  const f = fixture(),
    row = f.journals[f.rootTranscript]![3]!.payload as Record<string, unknown>;
  (row.usage as Record<string, unknown>).output_tokens = Number.MAX_SAFE_INTEGER;
  (row.thread_token_usage as Record<string, unknown>).output_tokens = Number.MAX_SAFE_INTEGER;
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-overflow');
});

it('rejects disagreement with the sealed managed subtotal', () => {
  const f = fixture();
  f.outcome.usage.knownSubtotal.output++;
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow(
    'h06-full-accounting-managed-subtotal',
  );
});

it('rejects a changed already observed native prefix', () => {
  const f = fixture(),
    original = nativeJournal.readH06NativeJournal;
  let rootReads = 0;
  vi.spyOn(nativeJournal, 'readH06NativeJournal').mockImplementation((path) => {
    const bytes = original(path);
    return path === f.rootTranscript && ++rootReads === 2 ? Buffer.from('changed') : bytes;
  });
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-prefix-changed');
});

it('rejects unknown primary counters instead of adding zero', () => {
  const f = fixture(),
    read = nativeUsage.readComparisonUsage;
  vi.spyOn(nativeUsage, 'readComparisonUsage').mockImplementation((input) =>
    read(input).map((row) => ({ ...row, responses: null })),
  );
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow(
    'h06-full-accounting-incomplete-usage',
  );
});

it.each(['bad', 0, 0.5])('rejects invalid managed numeric cap %s', (cap) => {
  const f = fixture();
  Object.assign(f.outcome.usage.caps, { maxOutput: cap });
  f.save();
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-caps');
});

it('rejects a non-primary receipt even when numeric counters exist', () => {
  const f = fixture(),
    read = nativeUsage.readComparisonUsage;
  vi.spyOn(nativeUsage, 'readComparisonUsage').mockImplementation((input) =>
    read(input).map((row) => ({ ...row, source: input.through! })),
  );
  expect(() => checkH06NativeFullAccounting(f.input)).toThrow('h06-full-accounting-primary-usage');
});

it('accepts appended bytes without changing the sealed turn window', () => {
  const f = fixture(),
    original = nativeJournal.readH06NativeJournal;
  let reads = 0;
  vi.spyOn(nativeJournal, 'readH06NativeJournal').mockImplementation((path) => {
    const bytes = original(path);
    return path === f.rootTranscript && ++reads === 2
      ? Buffer.concat([
          bytes,
          Buffer.from('{"type":"event_msg","payload":{"type":"task_started","turn_id":"later"}}\n'),
        ])
      : bytes;
  });
  expect(checkH06NativeFullAccounting(f.input).direct.knownSubtotal.responses).toBe(15);
});

it('does not count a repeated primary response twice', () => {
  const f = fixture(),
    rows = f.journals[f.rootTranscript]!;
  rows.splice(3, 0, rows[3]!);
  f.save();
  const report = checkH06NativeFullAccounting(f.input);
  expect(report.direct.knownSubtotal.responses).toBe(15);
  expect(report.direct.participants[0]!.windows[0]).toMatchObject({
    model: 'model',
    effort: 'medium',
    knownSubtotal: { responses: 1 },
  });
  expect(report.knownDirectLowerBoundOverNumericCaps).toEqual({
    inputUncached: true,
    output: true,
    rootElapsedMs: true,
  });
  expect(report.currencyCost).toBe('UNKNOWN');
});
