import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import type { H04Pin } from './comparisonH04Contract.js';
import {
  bindH06NativeUsageParticipants,
  checkH06NativeTemporalAttemptUsage,
  checkH06NativeUsage,
  sealH06NativeUsage,
} from './comparisonH06NativeUsage.js';
import { openH06NativeTurnLedger } from './comparisonH06NativeTurnLedger.js';

const roots: string[] = [];
const budget = { maxInputUncached: 100, maxOutput: 30 };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-usage-'));
  roots.push(root);
  return root;
}

function counters(input_tokens = 100, cached_input_tokens = 20, output_tokens = 10) {
  return { input_tokens, cached_input_tokens, output_tokens };
}

function response(
  session: string,
  id = 'model-response',
  usage = counters(),
  thread_token_usage = usage,
) {
  return {
    type: 'token_usage_record',
    payload: {
      thread_id: session,
      session_id: session,
      turn_id: 'turn',
      response_id: id,
      usage,
      thread_token_usage,
    },
  };
}

function event(type: string) {
  return { type: 'event_msg', payload: { type, turn_id: 'turn' } };
}

function save(participant: ComparisonParticipant, entries: unknown[]) {
  const records = [{ type: 'session_meta', payload: { id: participant.session } }, ...entries];
  writeFileSync(
    participant.transcript,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    { mode: 0o600 },
  );
}

function makeParticipant(root: string, session: string): ComparisonParticipant {
  return {
    session,
    transcript: join(root, session + '.jsonl'),
    run: 'native-h06',
    stage: 'execution',
  };
}

it('counts cached and uncached input, keeps exact receipt references and deduplicates native responses', () => {
  const root = directory();
  const writer = makeParticipant(root, 'writer');
  const reader = makeParticipant(root, 'reader');
  const writerResponse = response(writer.session, 'same-response');
  save(writer, [writerResponse, writerResponse]);
  save(reader, [response(reader.session, 'same-response', counters(22, 2, 20))]);
  const writerBytes = readFileSync(writer.transcript);
  const sealed = sealH06NativeUsage(writer);
  expect(readFileSync(writer.transcript)).toEqual(writerBytes);
  appendFileSync(writer.transcript, '{"later-partial":');
  const result = checkH06NativeUsage({
    expected: [writer, reader],
    participants: [sealH06NativeUsage(reader), sealed],
    budget,
  });
  expect(result).toMatchObject({
    status: 'WITHIN_BUDGET',
    totals: { responses: 2, inputUncached: 100, inputCached: 22, output: 30 },
    knownSubtotal: { responses: 2, inputUncached: 100, inputCached: 22, output: 30 },
    exceeded: { inputUncached: false, output: false },
    missing: [],
    providerHardCap: false,
    wholeAttemptComplete: false,
  });
  expect(result.receipts.map(({ participant }) => participant)).toEqual(['writer', 'reader']);
  expect(result.receipts[0]?.source).toEqual({
    locator: writer.transcript + '#L2',
    hash: digest(JSON.stringify(writerResponse) + '\n'),
  });
});

it('honors a pinned opening boundary and includes only subsequent native costs', () => {
  const root = directory();
  const writer = makeParticipant(root, 'writer');
  const earlier = response(writer.session);
  save(writer, [
    earlier,
    response(writer.session, 'later', counters(10, 3, 5), counters(110, 23, 15)),
  ]);
  writer.after = {
    locator: writer.transcript + '#L2',
    hash: digest(JSON.stringify(earlier) + '\n'),
  };
  expect(
    checkH06NativeUsage({ expected: [writer], participants: [sealH06NativeUsage(writer)], budget }),
  ).toMatchObject({
    status: 'WITHIN_BUDGET',
    totals: { responses: 1, inputUncached: 7, inputCached: 3, output: 5 },
  });
});

it('distinguishes absent and unsealed participants without substituting zero for unknown totals', () => {
  const root = directory();
  const actor = makeParticipant(root, 'actor');
  const unsealed = makeParticipant(root, 'unsealed');
  const absent = makeParticipant(root, 'absent');
  const missing = makeParticipant(root, 'missing');
  save(actor, [response(actor.session)]);
  save(absent, [response(absent.session)]);
  const sealedAbsent = sealH06NativeUsage(absent);
  unlinkSync(absent.transcript);
  const result = checkH06NativeUsage({
    expected: [actor, unsealed, absent, missing],
    participants: [sealH06NativeUsage(actor), unsealed, sealedAbsent],
    budget,
  });
  expect(result).toMatchObject({
    status: 'UNKNOWN',
    totals: { responses: null, inputUncached: null, inputCached: null, output: null },
    knownSubtotal: { responses: 1, inputUncached: 80, inputCached: 20, output: 10 },
    missing: [
      { session: 'unsealed', reason: 'unsealed' },
      { session: 'absent', reason: 'transcript-absent' },
      { session: 'missing', reason: 'unsealed' },
    ],
  });
  expect(checkH06NativeUsage({ expected: [], participants: [], budget })).toMatchObject({
    status: 'UNKNOWN',
    totals: { responses: null, inputUncached: null, inputCached: null, output: null },
    receipts: [],
  });
});

it.each([
  [
    { maxInputUncached: 79, maxOutput: 30 },
    { inputUncached: true, output: false },
  ],
  [
    { maxInputUncached: 100, maxOutput: 9 },
    { inputUncached: false, output: true },
  ],
] as const)('retains an observed cap breach even with missing usage (%j)', (caps, exceeded) => {
  const root = directory();
  const writer = makeParticipant(root, 'writer');
  const absent = makeParticipant(root, 'absent');
  save(writer, [response(writer.session)]);
  expect(
    checkH06NativeUsage({
      expected: [writer, absent],
      participants: [sealH06NativeUsage(writer)],
      budget: caps,
    }),
  ).toMatchObject({
    status: 'OVER_BUDGET',
    totals: { responses: null, inputUncached: null, inputCached: null, output: null },
    knownSubtotal: { responses: 1, inputUncached: 80, inputCached: 20, output: 10 },
    exceeded,
  });
});

it('keeps missing response metadata distinct from observed token totals', () => {
  const root = directory();
  const writer = makeParticipant(root, 'writer');
  save(writer, [
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: counters(), last_token_usage: counters(50, 0, 5) },
      },
    },
  ]);
  expect(
    checkH06NativeUsage({ expected: [writer], participants: [sealH06NativeUsage(writer)], budget }),
  ).toMatchObject({
    status: 'UNKNOWN',
    totals: { responses: null, inputUncached: 80, inputCached: 20, output: 10 },
  });
});

it('keeps a later completed turn with no usage unknown', () => {
  const root = directory();
  const writer = makeParticipant(root, 'writer');
  save(writer, [response(writer.session), event('task_started'), event('task_aborted')]);
  expect(
    checkH06NativeUsage({ expected: [writer], participants: [sealH06NativeUsage(writer)], budget }),
  ).toMatchObject({
    status: 'UNKNOWN',
    totals: { responses: null, inputUncached: null, inputCached: null, output: null },
    receipts: [{ responses: 1 }, { responses: null }],
  });
});

it('rejects malformed budgets, inventory paths and repeated identities', () => {
  const root = directory();
  const writer = makeParticipant(root, 'writer');
  const reader = makeParticipant(root, 'reader');
  const check = (expected: ComparisonParticipant[], caps = budget) =>
    checkH06NativeUsage({ expected, participants: [], budget: caps });
  for (const caps of [
    { ...budget, maxInputUncached: 0 },
    { ...budget, maxOutput: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(() => check([writer], caps)).toThrow('h06-usage-budget');
  for (const expected of [
    [{ ...writer, transcript: 'relative.jsonl' }],
    [{ ...writer, transcript: root + '/./writer.jsonl' }],
    [writer, { ...reader, transcript: writer.transcript }],
    [writer, { ...reader, session: writer.session }],
  ])
    expect(() => check(expected)).toThrow('h06-usage-inventory');
});

it('rejects foreign, inconsistent or repeated participant evidence', () => {
  const root = directory();
  const writer = makeParticipant(root, 'writer');
  save(writer, [response(writer.session)]);
  const sealed = sealH06NativeUsage(writer);
  for (const participants of [
    [sealed, sealed],
    [{ ...sealed, session: 'foreign' }],
    [{ ...sealed, transcript: join(root, 'other.jsonl') }],
    [{ ...sealed, run: 'other-run' }],
    [{ ...sealed, stage: 'council' as const }],
    [{ ...sealed, after: sealed.through! }],
  ])
    expect(() => checkH06NativeUsage({ expected: [writer], participants, budget })).toThrow(
      'h06-usage-participant-binding',
    );
});

it('rejects conflicting response counters and a changed closing receipt', () => {
  const root = directory();
  const writer = makeParticipant(root, 'writer');
  const first = response(writer.session);
  save(writer, [first, response(writer.session, 'model-response', counters(101, 20, 10))]);
  expect(() =>
    checkH06NativeUsage({ expected: [writer], participants: [sealH06NativeUsage(writer)], budget }),
  ).toThrow('comparison-usage-response-conflict');
  save(writer, [first]);
  const sealed = sealH06NativeUsage(writer);
  save(writer, [response(writer.session, 'changed')]);
  expect(() => checkH06NativeUsage({ expected: [writer], participants: [sealed], budget })).toThrow(
    'comparison-usage-end-unconfirmed',
  );
});

it('rejects an unrepresentable aggregate across individually valid participant receipts', () => {
  const root = directory();
  const first = makeParticipant(root, 'first');
  const second = makeParticipant(root, 'second');
  save(first, [response(first.session, 'first', counters(Number.MAX_SAFE_INTEGER, 0, 0))]);
  save(second, [response(second.session, 'second', counters(1, 0, 0))]);
  expect(() =>
    checkH06NativeUsage({
      expected: [first, second],
      participants: [sealH06NativeUsage(first), sealH06NativeUsage(second)],
      budget,
    }),
  ).toThrow('h06-usage-overflow');
});

function bindingFixture() {
  const root = directory();
  const operationId = 'h06-operation';
  const session = 'reader';
  const workspace = join(root, 'workspace');
  const transcript = join(root, 'primary-reader.jsonl');
  function port(name = 'initial') {
    const evidence = join(root, name);
    mkdirSync(evidence);
    const journal = join(evidence, 'reader-0.jsonl');
    const scope = { role: 'reader' as const, root: workspace, journal, session };
    const stopPath = join(evidence, 'transport-stop.json');
    const pin = (path: string, value: unknown): H04Pin => {
      const bytes = JSON.stringify(value);
      writeFileSync(path, bytes, { mode: 0o600 });
      return { path, sha256: digest(bytes) };
    };
    function source(
      index = 0,
      method = 'thread/start',
      path: unknown = transcript,
      edit: Record<string, unknown> = {},
      otherPath?: string,
    ) {
      return pin(otherPath ?? join(evidence, 'reader-0-session-' + index + '.json'), {
        kind: 'h06-native-transport-session',
        operationId,
        ...scope,
        method,
        response: { thread: { id: session, cwd: workspace, path } },
        ...edit,
      });
    }
    function stop(
      sessions: H04Pin[],
      edit: Record<string, unknown> = {},
      editPort: Record<string, unknown> = {},
      path = stopPath,
    ) {
      return pin(path, {
        kind: 'h06-native-transport-stop',
        operationId,
        receipts: [
          {
            role: scope.role,
            root: scope.root,
            journal,
            confirmed: true,
            processes: [{ pid: 1, parent: 2, started: 'known' }],
            sessions,
            ...editPort,
          },
        ],
        ...edit,
      });
    }
    return { scope, evidence, stop, source };
  }
  return { root, operationId, transcript, port };
}

it('binds one session across initial and reopened port journals and counts its range once', () => {
  const f = bindingFixture();
  const initial = f.port();
  const warm = f.port('warm');
  const result = bindH06NativeUsageParticipants({
    operationId: f.operationId,
    stops: [initial.stop([initial.source()]), warm.stop([warm.source(0, 'thread/resume')])],
    admissions: [{ scope: initial.scope }, { scope: warm.scope }, { scope: warm.scope }],
  });
  expect(result).toEqual({
    status: 'BOUND',
    participants: [
      { session: 'reader', transcript: f.transcript, run: f.operationId, stage: 'execution' },
    ],
    missing: [],
    unavailable: [],
  });
});

it.each([
  ['no-stop', 'transport-unconfirmed'],
  ['no-path', 'transcript-unavailable'],
  ['no-origin', 'session-origin-unknown'],
] as const)('reports %s instead of inventing a native usage participant', (which, reason) => {
  const f = bindingFixture();
  const port = f.port();
  const stops =
    which === 'no-stop'
      ? []
      : [
          port.stop([
            which === 'no-path'
              ? port.source(0, 'thread/start', null)
              : port.source(0, 'thread/resume'),
          ]),
        ];
  expect(
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops,
      admissions: [{ scope: port.scope }],
    }),
  ).toEqual({
    status: 'UNKNOWN',
    participants: [],
    missing: [{ scope: port.scope, reason }],
    unavailable: [],
  });
});

it('leaves a sealed stop with no admitted sessions unknown', () => {
  const f = bindingFixture();
  const p = f.port();
  expect(
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [p.stop([p.source()])],
      admissions: [],
    }),
  ).toMatchObject({ status: 'UNKNOWN', participants: [], missing: [] });
});

it.each([{ kind: 'foreign-stop' }, { operationId: 'foreign' }, { receipts: {} }, { receipts: [] }])(
  'rejects inconsistent stop evidence %j',
  (edit) => {
    const f = bindingFixture();
    const p = f.port();
    expect(() =>
      bindH06NativeUsageParticipants({
        operationId: f.operationId,
        stops: [p.stop([p.source()], edit)],
        admissions: [{ scope: p.scope }],
      }),
    ).toThrow('h06-usage-transport-stop');
  },
);

it('rejects the same transport stop supplied from a wrong file path', () => {
  const f = bindingFixture();
  const p = f.port();
  expect(() =>
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [p.stop([p.source()], {}, {}, join(p.evidence, 'wrong.json'))],
      admissions: [{ scope: p.scope }],
    }),
  ).toThrow('h06-usage-transport-stop');
});

it.each([
  { role: 'foreign' },
  { root: null },
  { journal: null },
  { journal: '/wrong-root/reader-0.jsonl' },
  { journal: 'wrong-name' },
  { confirmed: false },
  { processes: null },
  { processes: [] },
  { sessions: null },
])('rejects inconsistent stopped port evidence %j', (edit) => {
  const f = bindingFixture();
  const p = f.port();
  const port =
    edit.journal === 'wrong-name' ? { journal: join(p.evidence, 'writer-0.jsonl') } : edit;
  expect(() =>
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [p.stop([p.source()], {}, port)],
      admissions: [{ scope: p.scope }],
    }),
  ).toThrow('h06-usage-transport-port');
});

it('rejects duplicate STOP port coverage', () => {
  const f = bindingFixture();
  const p = f.port();
  const stop = p.stop([]);
  expect(() =>
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [stop, stop],
      admissions: [{ scope: p.scope }],
    }),
  ).toThrow('h06-usage-transport-port');
});

it.each([
  { kind: 'other' },
  { operationId: 'other' },
  { role: 'writer' },
  { root: '/foreign' },
  { journal: '/foreign' },
  { response: { thread: { id: 'wrong', cwd: '/foreign' } } },
  { response: { thread: { id: 'reader', cwd: '/foreign' } } },
  { method: 'turn/start' },
])('rejects inconsistent primary session evidence %j', (edit) => {
  const f = bindingFixture();
  const p = f.port();
  expect(() =>
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [p.stop([p.source(0, 'thread/start', f.transcript, edit)])],
      admissions: [{ scope: p.scope }],
    }),
  ).toThrow('h06-usage-transport-source');
});

it('rejects a substituted primary session pin', () => {
  const f = bindingFixture();
  const p = f.port();
  expect(() =>
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [p.stop([p.source(1)])],
      admissions: [{ scope: p.scope }],
    }),
  ).toThrow('h06-usage-transport-source');
});

it.each([1, 'relative.jsonl', '/a/./b.jsonl'])('rejects an invalid native path %j', (path) => {
  const f = bindingFixture();
  const p = f.port();
  expect(() =>
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [p.stop([p.source(0, 'thread/start', path)])],
      admissions: [{ scope: p.scope }],
    }),
  ).toThrow('h06-usage-transcript-path');
});

it.each([
  ['thread/start', 'h06-usage-transport-origin'],
  ['thread/read', 'h06-usage-transcript-changed'],
] as const)('rejects conflicting repeated %s observations', (method, error) => {
  const f = bindingFixture();
  const p = f.port();
  expect(() =>
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [p.stop([p.source(), p.source(1, method, '/wrong.jsonl')])],
      admissions: [{ scope: p.scope }],
    }),
  ).toThrow(error);
});

it.each([{ role: 'writer' as const }, { root: '/other' }])(
  'rejects admission with a mismatched stopped port scope %j',
  (edit) => {
    const f = bindingFixture();
    const p = f.port();
    expect(() =>
      bindH06NativeUsageParticipants({
        operationId: f.operationId,
        stops: [p.stop([p.source()])],
        admissions: [{ scope: { ...p.scope, ...edit } }],
      }),
    ).toThrow('h06-usage-transport-scope');
  },
);

it('rejects a different transcript even if the first port had no admitted turns', () => {
  const f = bindingFixture();
  const initial = f.port();
  const warm = f.port('warm');
  expect(() =>
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [
        initial.stop([initial.source()]),
        warm.stop([warm.source(0, 'thread/resume', '/wrong.jsonl')]),
      ],
      admissions: [{ scope: warm.scope }],
    }),
  ).toThrow('h06-usage-transcript-changed');
});

it('rejects a different workspace for the same resumed session', () => {
  const f = bindingFixture();
  const initial = f.port();
  const warm = f.port('warm');
  const root = '/different-root';
  const resumed = warm.source(0, 'thread/resume', f.transcript, {
    root,
    response: { thread: { id: warm.scope.session, cwd: root, path: f.transcript } },
  });
  expect(() =>
    bindH06NativeUsageParticipants({
      operationId: f.operationId,
      stops: [initial.stop([initial.source()]), warm.stop([resumed], {}, { root })],
      admissions: [{ scope: initial.scope }, { scope: { ...warm.scope, root } }],
    }),
  ).toThrow('h06-usage-transport-scope');
});

async function attemptUsageFixture(options: { pending?: boolean; cap?: number } = {}) {
  const fixture = bindingFixture();
  const { root, operationId, transcript } = fixture;
  const port = fixture.port('transport-initial');
  const ledger = openH06NativeTurnLedger(join(root, 'turns'), {
    mode: 'create',
    operationId,
    maxManagedStarts: 5,
  });
  const turn = {
    ...port.scope,
    params: { threadId: port.scope.session, input: [{ type: 'text', text: 'prompt' }] },
  };
  await ledger.admitTurn(turn);
  if (!options.pending)
    await ledger.recordTurn({ ...turn, turnId: 'turn', response: { turn: { id: 'turn' } } });
  const request = {
    kind: 'comparison-h06-native/2',
    binding: { operationId, variant: 'temporal' },
    evidenceRoot: root,
    budget: {
      ...budget,
      maxInputUncached: options.cap ?? budget.maxInputUncached,
      maxManagedStarts: 5,
    },
  };
  const assets = {};
  const bytes = canonical({
    kind: 'h06-native-attempt-claim',
    request,
    assets,
    requestHash: digest(canonical({ request, assets })),
  });
  const path = join(root, 'attempt-claim.json');
  writeFileSync(path, bytes, { mode: 0o600 });
  const claim = { path, sha256: digest(bytes) };
  const source = port.source();
  const stop = port.stop([source]);
  const writer: ComparisonParticipant = {
    session: port.scope.session,
    transcript,
    run: operationId,
    stage: 'execution',
  };
  save(writer, [response(writer.session)]);
  const participants = [sealH06NativeUsage(writer)];
  return { claim, stop, source, participants, root };
}

it('checks the sealed ranges against the attempt cap and the actual ledger from disk', async () => {
  const { claim, stop, participants } = await attemptUsageFixture();
  expect(checkH06NativeTemporalAttemptUsage({ claim, stops: [stop], participants })).toMatchObject({
    status: 'WITHIN_BUDGET',
    totals: { responses: 1, inputUncached: 80, inputCached: 20, output: 10 },
    binding: { status: 'BOUND' },
    ledgerStatus: 'RECORDED',
    providerHardCap: false,
    wholeAttemptComplete: false,
  });
});

it.each(['ledger', 'stop', 'source', 'range'] as const)(
  'reports unknown and null totals when attempt %s is missing',
  async (which) => {
    const { claim, stop, source, participants, root } = await attemptUsageFixture();
    if (which === 'ledger') rmSync(join(root, 'turns'), { recursive: true });
    if (which === 'stop') unlinkSync(stop.path);
    if (which === 'source') unlinkSync(source.path);
    expect(
      checkH06NativeTemporalAttemptUsage({
        claim,
        stops: [stop],
        participants: which === 'range' ? [] : participants,
      }),
    ).toMatchObject({
      status: 'UNKNOWN',
      totals: { responses: null, inputUncached: null, inputCached: null, output: null },
    });
  },
);

it.each([
  [100, 'UNKNOWN'],
  [79, 'OVER_BUDGET'],
] as const)(
  'keeps measured tokens despite an unconfirmed admission (cap %s)',
  async (cap, status) => {
    const { claim, stop, participants } = await attemptUsageFixture({ pending: true, cap });
    expect(
      checkH06NativeTemporalAttemptUsage({ claim, stops: [stop], participants }),
    ).toMatchObject({
      status,
      ledgerStatus: 'UNKNOWN',
      totals: { responses: null, inputUncached: null, inputCached: null, output: null },
      knownSubtotal: { responses: 1, inputUncached: 80, inputCached: 20, output: 10 },
    });
  },
);

it('rejects out-of-attempt STOP, an unadmitted participant, and corrupted ledger pins', async () => {
  const { claim, stop, participants, root } = await attemptUsageFixture();
  const other = bindingFixture().port();
  expect(() =>
    checkH06NativeTemporalAttemptUsage({ claim, stops: [other.stop([])], participants }),
  ).toThrow('h06-usage-attempt-stop-root');
  expect(() =>
    checkH06NativeTemporalAttemptUsage({
      claim,
      stops: [stop],
      participants: [{ ...participants[0]!, session: 'foreign' }],
    }),
  ).toThrow('h06-usage-attempt-participant');
  writeFileSync(join(root, 'turns', 'ledger.json'), 'changed');
  expect(() => checkH06NativeTemporalAttemptUsage({ claim, stops: [stop], participants })).toThrow(
    'h06-turn-ledger-binding',
  );
});

it('rejects changed bytes of a previously pinned primary path observation', async () => {
  const { claim, stop, source, participants } = await attemptUsageFixture();
  writeFileSync(source.path, '{}');
  expect(() => checkH06NativeTemporalAttemptUsage({ claim, stops: [stop], participants })).toThrow(
    'h04-pin-changed',
  );
});
