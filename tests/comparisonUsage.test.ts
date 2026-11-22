import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readComparisonUsage, sealComparisonUsage } from '../adapters/codex/comparisonUsage.js';
import { digest } from '../adapters/storage/storeCodec.js';
let directory: string;
let transcript: string;
const counters = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: output - 1,
});
const usage = (total = counters(100, 20, 10), last = total) => ({
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
});
let records: unknown[];
const participant = () => ({
  session: 'actor',
  transcript,
  run: 'H-01:1:baseline',
  stage: 'execution' as const,
});
const save = () =>
  writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join('\n') + '\n', {
    mode: 0o600,
  });
beforeEach(() => {
  directory = realpathSync(mkdtempSync(resolve(tmpdir(), 'comparison-usage-')));
  transcript = resolve(directory, 'native.jsonl');
  records = [
    { type: 'session_meta', payload: { id: 'actor' } },
    usage(),
    usage(counters(150, 30, 25), counters(50, 10, 15)),
  ];
  save();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('counts primary responses and separates cached input without adding reasoning twice', () => {
  const receipts = readComparisonUsage(participant());
  expect(receipts).toHaveLength(2);
  expect(
    receipts.map(({ responses, input_uncached, input_cached, output }) => ({
      responses,
      input_uncached,
      input_cached,
      output,
    })),
  ).toEqual([
    { responses: 1, input_uncached: 80, input_cached: 20, output: 10 },
    { responses: 1, input_uncached: 40, input_cached: 10, output: 15 },
  ]);
  expect(receipts[0]!.source).toEqual({
    locator: transcript + '#L2',
    hash: digest(JSON.stringify(records[1]) + '\n'),
  });
  records.splice(2, 0, records[1]);
  save();
  expect(readComparisonUsage(participant()).map((receipt) => receipt.id)).toEqual(
    receipts.map((receipt) => receipt.id),
  );
});
it('seals completed accounting at an exact primary line before later manual continuations', () => {
  const sealed = sealComparisonUsage(participant());
  expect(sealComparisonUsage(sealed)).toEqual(sealed);
  const before = readComparisonUsage(sealed);
  records.push(usage(counters(200, 30, 30), counters(50, 0, 5)));
  save();
  expect(readComparisonUsage(sealed)).toEqual(before);
  expect(readComparisonUsage(participant())).toHaveLength(3);
  writeFileSync(
    transcript,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n{"partial":',
  );
  expect(readComparisonUsage(sealed)).toEqual(before);
  expect(() =>
    readComparisonUsage({ ...sealed, through: { ...sealed.through!, hash: 'changed' } }),
  ).toThrow('comparison-usage-end-unconfirmed');
  writeFileSync(transcript, 'partial');
  expect(() => sealComparisonUsage(participant())).toThrow('comparison-usage-history-partial');
});
it('starts after an exact primary usage boundary and preserves unknown response counts', () => {
  const after = { locator: transcript + '#L2', hash: digest(JSON.stringify(records[1]) + '\n') };
  expect(readComparisonUsage({ ...participant(), after })).toHaveLength(1);
  records[2] = usage(counters(150, 30, 25), counters(10, 0, 2));
  save();
  expect(readComparisonUsage({ ...participant(), after })[0]).toMatchObject({
    responses: null,
    input_uncached: 40,
    output: 15,
  });
  expect(() => readComparisonUsage({ ...participant(), after: { ...after, hash: 'old' } })).toThrow(
    'comparison-usage-boundary-unconfirmed',
  );
  expect(() =>
    readComparisonUsage({
      ...participant(),
      after: { locator: transcript + '#L1', hash: digest(JSON.stringify(records[0]) + '\n') },
    }),
  ).toThrow('comparison-usage-boundary-invalid');
});
it('keeps absent usage unknown after completion and tolerates only a pending partial tail', () => {
  records = [records[0], { type: 'event_msg', payload: { type: 'token_count', info: null } }];
  save();
  expect(readComparisonUsage(participant())).toMatchObject([
    { responses: null, input_uncached: null, input_cached: null, output: null },
  ]);
  expect(readComparisonUsage(participant(), true)).toEqual([]);
  expect(readComparisonUsage(sealComparisonUsage(participant()))[0]!.source.locator).toBe(
    transcript + '#L2',
  );
  writeFileSync(transcript, JSON.stringify(records[0]) + '\n{"type":');
  expect(() => readComparisonUsage(participant())).toThrow('comparison-usage-history-partial');
  expect(readComparisonUsage(participant(), true)).toEqual([]);
  writeFileSync(transcript, '');
  expect(readComparisonUsage(participant(), true)).toEqual([]);
  unlinkSync(transcript);
  expect(readComparisonUsage(participant(), true)).toEqual([]);
  expect(() => readComparisonUsage(participant())).toThrow();
});
it('tolerates an absent nested native journal parent only while pending without creating it', () => {
  const parent = resolve(directory, 'sessions/2026/10/31');
  const future = { ...participant(), transcript: resolve(parent, 'native.jsonl') };
  expect(existsSync(parent)).toBe(false);
  expect(readComparisonUsage(future, true)).toEqual([]);
  expect(() => readComparisonUsage(future)).toThrow('ENOENT');
  expect(() => sealComparisonUsage(future)).toThrow('ENOENT');
  expect(existsSync(parent)).toBe(false);
});
it.each([false, true])('refuses symlink and non-directory parents, pending=%s', (pending) => {
  const alias = resolve(directory, 'alias');
  symlinkSync(directory, alias, 'dir');
  expect(() =>
    readComparisonUsage({ ...participant(), transcript: resolve(alias, 'native.jsonl') }, pending),
  ).toThrow('permission-denied');
  expect(() =>
    readComparisonUsage(
      { ...participant(), transcript: resolve(transcript, 'child.jsonl') },
      pending,
    ),
  ).toThrow('permission-denied');
});
it('does not let earlier usage hide missing counters for a later completed or aborted turn', () => {
  records.push(
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'next' } },
  );
  save();
  expect(readComparisonUsage(participant())).toMatchObject([
    { responses: 1 },
    { responses: 1 },
    { responses: null, input_uncached: null },
  ]);
  records.splice(-1, 0, usage(counters(200, 30, 30), counters(50, 0, 5)));
  save();
  expect(readComparisonUsage(participant()).every((receipt) => receipt.responses === 1)).toBe(true);
});
it.each([
  () => {
    records[0] = { type: 'session_meta', payload: { id: 'foreign' } };
  },
  () => {
    records.push(records[0]);
  },
  () => {
    records.shift();
  },
  () => {
    records[2] = usage(counters(50, 20, 20));
  },
  () => {
    records[2] = usage(counters(120, 60, 25));
  },
  () => {
    records[2] = usage(counters(-1, 0, 0));
  },
  () => {
    records[2] = usage(counters(1, 2, 3));
  },
  () => {
    records[2] = usage(counters(1.5, 0, 3));
  },
])('refuses a foreign, repeated or regressing primary history %#', (change) => {
  change();
  save();
  expect(() => readComparisonUsage(participant())).toThrow();
});

const response = (id = 'response-1', value = counters(100, 20, 10), total = value) => ({
  type: 'token_usage_record',
  payload: {
    thread_id: 'actor',
    session_id: 'actor',
    turn_id: 'turn-1',
    response_id: id,
    usage: value,
    thread_token_usage: total,
  },
});
it('uses unique response records and includes compaction costs omitted by events', () => {
  records = [
    records[0],
    response(),
    usage(),
    response('compaction', counters(50, 10, 15), counters(150, 30, 25)),
    { type: 'compacted', payload: {} },
    usage(),
  ];
  save();
  const receipts = readComparisonUsage(participant());
  expect(receipts).toMatchObject([
    { responses: 1, input_uncached: 80, input_cached: 20, output: 10 },
    { responses: 1, input_uncached: 40, input_cached: 10, output: 15 },
  ]);
  records.push(response());
  save();
  expect(readComparisonUsage(participant()).map((r) => r.id)).toEqual(receipts.map((r) => r.id));
  const sealed = sealComparisonUsage(participant());
  records.push(response('later', counters(50, 0, 5), counters(200, 30, 30)));
  save();
  expect(readComparisonUsage(sealed).map((r) => r.id)).toEqual(receipts.map((r) => r.id));
});
it.each(['primary', 'event'] as const)(
  'honours an exact %s boundary without recounting a duplicate response',
  (kind) => {
    records = [
      records[0],
      response(),
      usage(),
      response(),
      response('next', counters(50, 10, 15), counters(150, 30, 25)),
    ];
    save();
    const index = kind === 'primary' ? 1 : 2;
    const after = {
      locator: `${transcript}#L${index + 1}`,
      hash: digest(JSON.stringify(records[index]) + '\n'),
    };
    expect(readComparisonUsage({ ...participant(), after })).toMatchObject([
      { responses: 1, input_uncached: 40 },
    ]);
    expect(() =>
      readComparisonUsage({
        ...participant(),
        after: { locator: transcript + '#L1', hash: digest(JSON.stringify(records[0]) + '\n') },
      }),
    ).toThrow('comparison-usage-boundary-invalid');
    expect(() =>
      readComparisonUsage({ ...participant(), after: { ...after, hash: 'changed' } }),
    ).toThrow('comparison-usage-boundary-unconfirmed');
  },
);
it.each([
  [usage(), response('late', counters(50, 10, 15), counters(150, 30, 25))],
  [response(), usage(counters(150, 30, 25))],
  [response('partial', counters(50, 10, 15), counters(150, 30, 25))],
  [{ ...response(), payload: { ...response().payload, thread_token_usage: undefined } }],
])('keeps missing response history unknown instead of filling it with events %#', (...tail) => {
  records = [records[0], ...tail];
  save();
  expect(readComparisonUsage(participant()).at(-1)).toMatchObject({
    responses: null,
    output: null,
  });
});
it('keeps missing turn usage unknown and accepts primary usage without a later event', () => {
  records = [
    records[0],
    response(),
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'event_msg', payload: { type: 'task_aborted' } },
  ];
  save();
  expect(readComparisonUsage(participant())).toMatchObject([{ responses: 1 }, { responses: null }]);
  records.splice(-1, 0, response('next', counters(50, 10, 15), counters(150, 30, 25)));
  save();
  expect(readComparisonUsage(participant()).every((r) => r.responses === 1)).toBe(true);
  const after = { locator: `${transcript}#L4`, hash: digest(JSON.stringify(records[3]) + '\n') };
  expect(readComparisonUsage({ ...participant(), after })).toMatchObject([{ responses: null }]);
  expect(readComparisonUsage({ ...participant(), after }, true)).toEqual([]);
  writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n{"partial":');
  expect(readComparisonUsage(participant(), true)).toHaveLength(2);
  expect(() => readComparisonUsage(participant())).toThrow('comparison-usage-history-partial');
});
it.each([
  { response_id: '' },
  { turn_id: '' },
  { thread_id: 'foreign' },
  { session_id: 'foreign' },
  { usage: counters(-1, 0, 0) },
  { usage: counters(1, 2, 0) },
])('refuses invalid primary response metadata %j', (patch) => {
  records = [records[0], { ...response(), payload: { ...response().payload, ...patch } }];
  save();
  expect(() => readComparisonUsage(participant())).toThrow();
});
it('refuses conflicting duplicates and missing or repeated primary session identities', () => {
  for (const tail of [
    [response(), response('response-1', counters(101, 20, 10))],
    [response(), records[0]],
  ]) {
    const identity = records[0];
    records = [identity, ...tail];
    save();
    expect(() => readComparisonUsage(participant())).toThrow();
  }
  records = [response()];
  save();
  expect(() => readComparisonUsage(participant())).toThrow('comparison-usage-boundary-unconfirmed');
});
