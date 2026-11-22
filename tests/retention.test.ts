import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  retainEvidence,
  retainEvidenceAsync,
  commandFingerprint,
  retentionFingerprint,
  retainedPrefix,
  retainStoreState,
} from '../adapters/storage/retainedJson.js';
import {
  encodeChatArtifact,
  decodeChatArtifact,
  retainedInlinePrefix,
  saveChatArtifact,
  readChatArtifact,
} from '../adapters/storage/sharedArtifacts.js';
import { compactArchive, eventPayload } from '../adapters/storage/archiveJson.js';
import { decodeHistoryPayload } from '../adapters/storage/historyPayload.js';
import { encodeSharedJson, decodeSharedJson } from '../adapters/storage/sharedJson.js';
import { answerSummary } from '../core/council.js';
import { canonicalHash } from '../adapters/storage/storeCodec.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import { validateCheckpoint } from '../adapters/storage/workflowValidation.js';
import { copyState } from '../core/equality.js';
import { createExecution, applyExecution } from '../core/execution.js';
import { createChatMessages, applyChatMessage } from '../core/chatMessages.js';
import { councilBlockers, repeatCouncil, answerCouncil } from '../core/council.js';
import { beginExecution, advanceExecution } from '../application/executionWorkflow.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { fixture, grant } from './storageFixtures.js';
import { workflowFixture, executionEvent } from './workflowFixtures.js';
import type { Execution } from '../core/execution.js';
import type { Council } from '../core/council.js';
import type { Json, TechnicalState } from '../core/evidence.js';

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeEach(async () => {
  f = await workflowFixture();
});
afterEach(async () => {
  await f.dispose();
});
const gates = [{ id: 'proof', kind: 'check' as const, applicable: true, reason: 'check' }];
function execution() {
  return createExecution('task', 1, f.target, gates, false, 'substantial');
}

it('keeps current admission, significant FAIL and consumed turns, discarding replaced answer bodies', () => {
  const council = f.council('planning');
  const answer = council.advisers.architect!.answer!;
  council.history = ['PASS', 'FAIL', 'PASS', 'NOT RUN'].map((verdict, index) => ({
    role: 'architect',
    session: 'session',
    answer: {
      ...copyState(answer),
      verdict: verdict as typeof answer.verdict,
      binding: { ...answer.binding!, answer_turn: `turn-${index}` },
    },
  }));
  const result = retainEvidence(council) as unknown as Council;
  expect(result.history.map((entry) => entry.answer.verdict)).toEqual(['FAIL', 'PASS', 'NOT RUN']);
  expect(result.review_turns).toHaveLength(5); // Includes the already consumed initial fixture answer.
  expect(
    result.history.every(
      (entry) => entry.retained && !entry.archive && !('target' in entry.answer),
    ),
  ).toBe(true);
  expect(result.advisers).toEqual(council.advisers);
  expect(councilBlockers(result)).toEqual([]);
  const next = repeatCouncil(result, f.target, ['architect']);
  expect(() =>
    answerCouncil(next, 'architect', 'session', {
      ...answer,
      binding: { ...answer.binding!, answer_turn: 'turn-0' },
    }),
  ).toThrow('review-turn-already-used');
  result.history[0]!.answer.findings.push({
    id: 'test',
    scope: 's',
    condition: 'c',
    reason: 'r',
    blocking: true,
    sources: [f.proof],
  });
  expect(council.history[1]!.answer.findings).toEqual([]);
});

it('preserves literal strings and explicit legacy encodings while producing only retry fingerprints', async () => {
  const run = execution();
  const payload = JSON.stringify({ type: 'DONE', id: 'one', expected_revision: 2, generation: 1 });
  const encoded =
    'agent-workflow:gzip-history:2:' + gzipSync(JSON.stringify(payload)).toString('base64');
  run.history = [{ id: 'one', payload: encoded }];
  const workflow = {
    schema_version: 1,
    revision: 1,
    execution: run,
    readings: {},
    history_payload_encoding: 1,
  };
  const value = retainEvidence({ workflow, unmarked: run }) as unknown as {
    workflow: { execution: Execution };
    unmarked: Execution;
  };
  expect(value.workflow.execution.history[0]).toEqual({
    id: 'one',
    payload: '',
    fingerprint: canonicalHash(JSON.parse(payload)),
    type: 'DONE',
    expected_revision: 2,
    generation: 1,
  });
  expect(value.unmarked.history[0]!.fingerprint).toBe(canonicalHash(encoded));
  expect(value.workflow).not.toHaveProperty('history_payload_encoding');
  expect(commandFingerprint('\ud800').fingerprint).not.toBe(
    commandFingerprint('\udc00').fingerprint,
  );
  for (const text of [
    'null',
    '3',
    '"text"',
    '\ufeffliteral',
    'not JSON',
    '{"generation":"wrong","type":3}',
  ])
    expect(commandFingerprint(text).fingerprint).toHaveLength(64);
  const literal = JSON.parse('{"__proto__":{"value":3},"items":[null,false,1,"text"]}') as Record<
    string,
    unknown
  >;
  expect(retainEvidence(literal)).toEqual(literal);
  expect(Object.getOwnPropertyDescriptor(retainEvidence(literal), '__proto__')).toBeDefined();
  const archived = {
    ...run,
    history: [{ id: 'one', payload: '', archive: { hash: 'a'.repeat(64) } }],
  };
  const read = vi.fn(async () => payload);
  const retained = await retainEvidenceAsync(
    { a: archived, b: archived, council: f.council('planning') },
    read,
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(retainEvidence(retained)).toEqual(retained);
  expect(retainEvidence(archived, () => payload)).toEqual((retained as { a: Json }).a);
});

it('rejects corrupt receipts, missing readers, bad encoding markers and unknown retention versions', () => {
  const run = execution();
  for (const entry of [
    { id: 1, payload: '' },
    { id: 'x', payload: null },
    { id: 'x', payload: '', fingerprint: 'bad' },
    { id: 'x', payload: '', fingerprint: 'a'.repeat(64) },
    { id: 'x', payload: '', archive: { hash: 3 } },
    { id: 'x', payload: '', archive: { hash: 'a'.repeat(64) } },
  ])
    expect(() => retainEvidence({ ...run, history: [entry] })).toThrow('corrupt');
  expect(() => retainEvidence({ ...run, history_format: 9 })).toThrow('unsupported-version');
  expect(() =>
    retainEvidence({
      schema_version: 1,
      execution: run,
      readings: {},
      history_payload_encoding: 9,
    }),
  ).toThrow('unsupported-version');
  const invalid = {
    ...run,
    history_format: 1,
    history: [{ id: 'x', payload: 'body', fingerprint: 'a'.repeat(64) }],
  };
  expect(() => retainEvidence(invalid)).toThrow('corrupt');
  expect(() => retainEvidence({ ...run, history: null })).toThrow('corrupt');
});

it('shares only deeply immutable current facts and keeps mutable views independent', () => {
  const directory = join(f.root, 'artifacts');
  mkdirSync(directory);
  const target = {
    ...f.target,
    inputs: {
      ...f.target.inputs,
      inputs: Array.from({ length: 100 }, (_, i) => ({
        locator: `source-${i}`,
        hash: 'a'.repeat(64),
      })),
    },
  };
  const mutable = { values: ['separate '.repeat(1000)] };
  const source = { a: { target, mutable }, b: { target: copyState(target), mutable } };
  const wire = encodeChatArtifact(directory, source, 'minimal');
  expect(wire.startsWith(retainedInlinePrefix)).toBe(true);
  const read = decodeChatArtifact(directory, wire) as typeof source;
  expect(read.a.target.inputs.inputs).toBe(read.b.target.inputs.inputs);
  expect(Object.isFrozen(read.a.target.inputs.inputs[0])).toBe(true);
  expect(() => {
    read.a.target.inputs.inputs[0]!.hash = 'changed';
  }).toThrow(TypeError);
  expect(read.a.mutable).not.toBe(read.b.mutable);
  read.a.mutable.values[0] = 'changed';
  expect(read.b.mutable.values[0]).toBe(mutable.values[0]);
  const cloned = copyState(read);
  expect(cloned.a.target.inputs.inputs).toBe(read.a.target.inputs.inputs);
  cloned.b.mutable.values.push('copy');
  expect(read.b.mutable.values).toHaveLength(1);
  const shallow = Object.freeze({ inner: { x: 1 } });
  expect(copyState(shallow)).toBe(shallow);
  expect(Object.isFrozen(shallow.inner)).toBe(true);
});

it('continues and rejects changed retries after the complete historical command body is gone', async () => {
  const db = fixture();
  db.claim();
  try {
    expect(
      db.mutate(
        { type: 'checkpoint', state: { local_run: f.executor as unknown as Json }, effects: [] },
        1,
      ).ok,
    ).toBe(true);
    const journal = new TaskWorkflowJournal(
      { execute: async (request) => db.store.execute(request) },
      grant.context,
      1,
    );
    const initial = execution();
    await beginExecution(initial, journal);
    const event = executionEvent(initial, { type: 'PLAN', council: f.council('planning') });
    const planned = await advanceExecution(event, journal, f.inputs);
    expect(planned.history[0]).toMatchObject({
      payload: '',
      fingerprint: retentionFingerprint(event),
    });
    expect(await advanceExecution(event, journal, f.inputs)).toEqual(planned);
    await expect(advanceExecution({ ...event, generation: 2 }, journal, f.inputs)).rejects.toThrow(
      'execution-event-conflict',
    );
    const next = executionEvent(planned, { type: 'REPLAN', target: f.target });
    expect((await advanceExecution(next, journal, f.inputs)).status).toBe('planning');
    validateCheckpoint(await journal.read());
    expect(() => applyExecution(planned, next)).toThrow('execution-fingerprint-required');
    const state = db.execute({ type: 'state' }) as { ok: true; value: TechnicalState };
    const raw = readFileSync(join(db.root, 'store.sqlite')).toString('utf8');
    expect(raw).toContain(retainedPrefix);
    expect(state.value.revision).toBe(5);
  } finally {
    db.dispose();
  }
});

it('protects message retries using fingerprints while preserving pending questions and decisions', () => {
  const state = createChatMessages('task', 'thread', 1, f.proof);
  const event = {
    type: 'ASK' as const,
    id: 'ask',
    expected_revision: 0,
    generation: 1,
    thread_id: 'thread',
    source: f.proof,
    question_id: 'q',
    action: 'accept',
  };
  const asked = applyChatMessage(state, event, retentionFingerprint);
  expect(asked.history[0]!.payload).toBe('');
  expect(applyChatMessage(asked, event, retentionFingerprint)).toBe(asked);
  expect(() =>
    applyChatMessage(asked, { ...event, action: 'other' }, retentionFingerprint),
  ).toThrow('chat-message-conflict');
  expect(() => applyChatMessage(asked, event)).toThrow('chat-fingerprint-required');
  expect(asked.question?.id).toBe('q');
});

it('stores explicit discovery once, rereads legacy rules and checks each identical file reference once', async () => {
  const files = new FileWorkflowInputs(f.root);
  const manifest = await files.capture({ files: ['source.txt'], directories: [] }, 'owner');
  expect(manifest.discovery_rule).toBe('{"version":2,"kind":"explicit"}');
  expect(await files.current(manifest)).toEqual(manifest);
  const legacy = { ...manifest, discovery_rule: '{"files":["source.txt"],"directories":[]}' };
  expect(await files.current(legacy)).toEqual(legacy);
  for (const discovery_rule of [
    '{"version":3,"kind":"explicit"}',
    '{"version":2,"kind":"wrong"}',
    '{"version":2,"kind":"explicit","files":[]}',
  ])
    expect((await files.current({ ...manifest, discovery_rule })).complete).toBe(false);
  const ref = vi.spyOn(files, 'ref');
  await files.verify([manifest.inputs[0]!, manifest.inputs[0]!]);
  expect(ref).toHaveBeenCalledTimes(1);
});

it('migrates legacy archive artifacts through a local or external source and rejects missing/corrupt sources', async () => {
  const run = execution();
  run.history = [{ id: 'legacy', payload: JSON.stringify({ text: 'old '.repeat(2000) }) }];
  const directory = join(f.root, 'legacy');
  mkdirSync(directory);
  const ref = saveChatArtifact(directory, 'state', run, true);
  const current = decodeChatArtifact(directory, readFileSync(ref.locator, 'utf8'), false);
  const minimal = encodeChatArtifact(directory, current, 'minimal');
  expect(decodeChatArtifact(directory, minimal)).toEqual(retainEvidence(run));
  const external = join(f.root, 'external');
  mkdirSync(external);
  const read = (hash: string) => readFileSync(join(directory, 'shared-json', hash), 'utf8');
  expect(
    decodeChatArtifact(external, encodeChatArtifact(external, current, 'minimal', read)),
  ).toEqual(retainEvidence(run));
  expect(() => encodeChatArtifact(external, current, 'minimal')).toThrow(
    'chat-archive-source-required',
  );
  for (const bytes of [
    retainedInlinePrefix + '{',
    retainedInlinePrefix + '{"root":"AWJSON1\\n[\"ref\",\"bad\"]","blobs":{}}',
  ])
    expect(() => decodeChatArtifact(external, bytes)).toThrow('chat-artifact-conflict');
  const packet = JSON.parse(minimal.slice(retainedInlinePrefix.length)) as {
    blobs: Record<string, string>;
  };
  packet.blobs['a'.repeat(64)] = 'unused';
  expect(() =>
    decodeChatArtifact(directory, retainedInlinePrefix + JSON.stringify(packet)),
  ).toThrow('chat-artifact-conflict');
  expect(() => decodeHistoryPayload('agent-workflow:gzip-history:9:bad')).toThrow(
    'unsupported-history-payload',
  );
  const legacy = 'agent-workflow:gzip-history:1:' + gzipSync('literal').toString('base64');
  expect(decodeHistoryPayload(legacy)).toBe('literal');
  expect(decodeHistoryPayload('ordinary literal')).toBe('ordinary literal');
  const packed = compactArchive(run);
  const values = new Map(packed.blobs.map((b) => [b.hash, b.content]));
  // The Store port returns the decoded event envelope, never a guessed user string.
  const hash = (packed.value as unknown as Execution).history[0]!.archive!.hash;
  const envelope = decodeSharedJson(values.get(hash)!, (child) => values.get(child)!);
  const store = {
    execute: async () => ({ ok: true as const, value: { hash, value: envelope as Json } }),
  };
  expect(eventPayload(envelope as Record<string, Json>)).toBe(run.history[0]!.payload);
  expect(await retainStoreState(packed.value, store, grant.context)).toEqual(retainEvidence(run));
  await expect(
    retainStoreState(
      packed.value,
      { execute: async () => ({ ok: true, value: [] }) },
      grant.context,
    ),
  ).rejects.toThrow('workflow-archive-unavailable');
  const saved = saveChatArtifact(external, 'minimal', run, 'minimal');
  expect(readChatArtifact(saved)).toEqual(retainEvidence(run));
});

it('shares supported fact shapes while keeping partial lookalikes and mutable data independent', () => {
  const pad = Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [`key-${i}`, 'x'.repeat(40)]),
  );
  const values = [
    { complete: true, attested_by: 'owner', discovery_rule: 'rule', inputs: [], ...pad },
    { scope: 's', base: f.proof, diff: f.proof, inputs: f.target.inputs, ...pad },
    {
      schema_version: 1,
      session_id: 's',
      assignment: f.proof,
      target: f.target,
      reads: [],
      ...pad,
    },
    null,
    1,
    [],
    [null, 1, { locator: 3, hash: 'x' }],
    { complete: true, ...pad },
    { complete: true, attested_by: 'x', ...pad },
    { scope: 's', ...pad },
    { scope: 's', base: f.proof, ...pad },
    { schema_version: 1, ...pad },
    { schema_version: 1, session_id: 's', ...pad },
    { schema_version: 1, session_id: 's', assignment: f.proof, ...pad },
    { schema_version: 1, session_id: 's', assignment: f.proof, target: f.target, ...pad },
  ];
  const blobs = new Map<string, string>();
  const wire = encodeSharedJson({ a: values, b: copyState(values) }, (text) => {
    const hash = canonicalHash(text);
    blobs.set(hash, text);
    return hash;
  });
  const decoded = decodeSharedJson(wire, (hash) => blobs.get(hash)!, true) as {
    a: unknown[];
    b: unknown[];
  };
  expect(decoded.a).toEqual(values);
  for (let i = 0; i < 3; i++) expect(decoded.a[i]).toBe(decoded.b[i]);
  expect(decoded.a[8]).not.toBe(decoded.b[8]);
  const council = f.council('planning');
  delete council.review_turns;
  validateCheckpoint({
    schema_version: 1,
    revision: 0,
    execution: { ...execution(), planning: council },
    readings: {},
  });
  const { binding: _binding, design: _design, ...bare } = council.advisers.architect!.answer!;
  const summary = answerSummary(bare);
  expect(summary).not.toHaveProperty('binding');
  expect(summary).not.toHaveProperty('design');
  const retained = retainEvidence({
    ...council,
    review_turns: undefined,
    history: [{ role: 'architect', session: 's', answer: bare }],
  }) as unknown as Council;
  const run = { ...execution(), planning: retained };
  validateCheckpoint({ schema_version: 1, revision: 0, execution: run, readings: {} });
});

it('accepts an unchanged legacy retry with the new fingerprint provider', () => {
  const run = execution();
  const event = executionEvent(run, { type: 'PLAN', council: f.council('planning') });
  const legacy = applyExecution(run, event);
  expect(applyExecution(legacy, event, retentionFingerprint)).toBe(legacy);
  const state = createChatMessages('task', 'thread', 1, f.proof);
  const message = {
    type: 'ASK' as const,
    id: 'ask',
    expected_revision: 0,
    generation: 1,
    thread_id: 'thread',
    source: f.proof,
    question_id: 'q',
    action: 'accept',
  };
  const asked = applyChatMessage(state, message);
  expect(applyChatMessage(asked, message, retentionFingerprint)).toBe(asked);
});
