import { execFileSync } from 'node:child_process';
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beginExecution, advanceExecution } from '../application/executionWorkflow.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import {
  TaskWorkflowJournal,
  encodeWorkflowHistory,
  decodeWorkflowHistory,
} from '../adapters/storage/workflowJournal.js';
import { TaskChatContext } from '../adapters/storage/chatContext.js';
import { startLocalRun, applyLocalEvent } from '../core/localRun.js';
import { loadedRun, event as localEvent } from './localFixtures.js';
import { createChatMessages } from '../core/chatMessages.js';
import { createExecution } from '../core/execution.js';
import { compareInputs } from '../core/evidence.js';
import { fixture, grant } from './storageFixtures.js';
import { executionEvent, workflowFixture } from './workflowFixtures.js';
import type { Json, TechnicalState } from '../core/evidence.js';
let f: Awaited<ReturnType<typeof workflowFixture>>;
let db: ReturnType<typeof fixture>;
let journal: TaskWorkflowJournal;
beforeEach(async () => {
  f = await workflowFixture();
  db = fixture();
  db.claim();
  journal = new TaskWorkflowJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
    false,
  );
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});

it('reuses only verified marked history strings and drops obsolete cache entries', () => {
  const run = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'proof', kind: 'check', applicable: true, reason: 'storage roundtrip' }],
    false,
    'substantial',
  );
  run.history = [{ id: 'one', payload: 'large literal \ud800'.repeat(6000) }];
  const checkpoint = { schema_version: 1 as const, revision: 1, execution: run, readings: {} };
  const encoded = encodeWorkflowHistory(checkpoint);
  const cache = new Map([['obsolete', 'stale']]);
  expect(decodeWorkflowHistory(encoded, cache)).toEqual(checkpoint);
  expect(cache.size).toBe(1);
  expect(cache.has('obsolete')).toBe(false);
  expect(decodeWorkflowHistory(encoded, cache)).toEqual(checkpoint);
  expect(encodeWorkflowHistory(checkpoint, cache)).toEqual(encoded);
  const repeated = {
    ...encoded,
    execution: {
      ...encoded.execution!,
      history: [encoded.execution!.history[0]!, encoded.execution!.history[0]!],
    },
  };
  expect(decodeWorkflowHistory(repeated).execution!.history).toHaveLength(2);
  expect(decodeWorkflowHistory(checkpoint, cache)).toEqual(checkpoint);
  expect(cache.size).toBe(0);
});

it('stores long historical payloads compactly while both adapters preserve exact text and replay', async () => {
  expect(
    db.mutate(
      { type: 'checkpoint', state: { local_run: f.executor as unknown as Json }, effects: [] },
      1,
    ).ok,
  ).toBe(true);
  const run = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
    true,
    'substantial',
  );
  const payload = JSON.stringify({
    id: 'old-failure',
    reason: 'FAIL: ёж, кавычки " и перенос\n'.repeat(12000),
  });
  run.history.push({ id: 'old-failure', payload });
  await beginExecution(run, journal);
  const event = executionEvent(run, { type: 'PLAN', council: f.council('planning') });
  const planned = await advanceExecution(event, journal, f.inputs);
  const reply = db.store.execute({
    context: grant.context,
    command: { type: 'state', archive: 'current' },
  });
  expect(reply.ok).toBe(true);
  const raw = (reply as { ok: true; value: TechnicalState }).value.checkpoint as unknown as {
    workflow: { execution: { history: { payload: string }[] } };
  };
  expect(raw.workflow.execution.history[0]!.payload.length).toBeLessThan(payload.length / 4);
  expect((await journal.read({ archive: true })).execution!.history[0]!.payload).toBe(payload);
  const chat = new TaskChatContext(
    { execute: async (request) => db.store.execute(request) },
    grant.context,
    1,
    false,
  );
  expect((await chat.read()).workflow).toEqual(await journal.read());
  expect(await advanceExecution(event, journal, f.inputs)).toEqual(planned);
});

it('keeps legacy payloads and literal encoding prefixes, rejecting unknown or corrupt encodings', () => {
  const run = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
    true,
    'substantial',
  );
  run.history = [
    { id: 'small', payload: 'legacy FAIL' },
    { id: 'literal', payload: 'agent-workflow:gzip-history:1:literal' },
    { id: 'unicode-prefix', payload: '\uFEFF' + 'x'.repeat(65_536) },
  ];
  const checkpoint = { schema_version: 1 as const, revision: 1, execution: run, readings: {} };
  const marked = { ...checkpoint, history_payload_encoding: 1 };
  const unsupported = { ...checkpoint, history_payload_encoding: 2 };
  expect(() => decodeWorkflowHistory(unsupported)).toThrow('unsupported-history-format');
  expect(decodeWorkflowHistory(encodeWorkflowHistory(checkpoint))).toEqual(checkpoint);
  expect(decodeWorkflowHistory({ ...checkpoint, execution: null }).execution).toBeNull();
  for (const payload of [
    'agent-workflow:gzip-history:3:future',
    'agent-workflow:gzip-history:1:bad',
    'agent-workflow:gzip-history:1:' + gzipSync(Buffer.from([255])).toString('base64'),
    'agent-workflow:gzip-history:1:' + gzipSync('').toString('base64'),
    'agent-workflow:gzip-history:2:' + gzipSync('invalid-json').toString('base64'),
    'agent-workflow:gzip-history:2:' + gzipSync('123').toString('base64'),
  ]) {
    run.history = [{ id: 'bad', payload }];
    expect(() => decodeWorkflowHistory(marked)).toThrow(
      payload.includes(':3:') ? 'unsupported-history-payload' : 'workflow-history-corrupt',
    );
  }
  run.history = [
    {
      id: 'legacy-gzip',
      payload: 'agent-workflow:gzip-history:1:' + gzipSync('legacy UTF8 ёж').toString('base64'),
    },
  ];
  expect(decodeWorkflowHistory(marked).execution!.history[0]!.payload).toBe('legacy UTF8 ёж');
});

it.each(
  ['journal', 'chat'].flatMap((adapter) =>
    [
      'agent-workflow:gzip-history:1:literal',
      'agent-workflow:gzip-history:2:' +
        gzipSync(JSON.stringify('different text')).toString('base64'),
    ].map((payload) => ({ adapter, payload })),
  ),
)(
  'reads unmarked legacy text literally through $adapter: $payload',
  async ({ adapter, payload }) => {
    const run = createExecution(
      'task',
      1,
      f.target,
      [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
      true,
      'substantial',
    );
    run.history.push({ id: 'legacy-literal', payload });
    const workflow = { schema_version: 1 as const, revision: 1, execution: run, readings: {} };
    expect(
      db.mutate(
        {
          type: 'checkpoint',
          state: {
            local_run: f.executor as unknown as Json,
            workflow: workflow as unknown as Json,
          },
          effects: [],
        },
        1,
      ).ok,
    ).toBe(true);
    const stored =
      adapter === 'journal'
        ? await journal.read()
        : (
            await new TaskChatContext(
              { execute: async (request) => db.store.execute(request) },
              grant.context,
              1,
              false,
            ).read()
          ).workflow;
    expect(stored).toEqual(workflow);
  },
);

it.each(['\uD800', '\uDC00'])(
  'preserves lone UTF-16 units through both writers and event replay: %j',
  async (unit) => {
    let executor = loadedRun(
      startLocalRun({ ...f.executor.spec, session_id: grant.context.actor_id }, 1),
    );
    executor = applyLocalEvent(executor, localEvent(executor, { type: 'READY' }));
    expect(
      db.mutate(
        { type: 'checkpoint', state: { local_run: executor as unknown as Json }, effects: [] },
        1,
      ).ok,
    ).toBe(true);
    const run = createExecution(
      'task',
      1,
      f.target,
      [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
      true,
      'substantial',
    );
    const payload = 'x'.repeat(65_536) + unit;
    run.history.push({ id: 'legacy-unit', payload });
    await beginExecution(run, journal);
    expect((await journal.read({ archive: true })).execution!.history[0]!.payload).toBe(payload);
    const chat = new TaskChatContext(
      { execute: async (request) => db.store.execute(request) },
      grant.context,
      1,
      false,
    );
    const before = await chat.read({ archive: true });
    expect(before.workflow.execution!.history[0]!.payload).toBe(payload);
    const messages = createChatMessages(
      'task',
      executor.spec.session_id,
      1,
      f.executor.spec.assignment,
    );
    const next = {
      ...before,
      messages,
      workflow: {
        ...before.workflow,
        revision: before.workflow.revision + 1,
        execution: {
          ...before.workflow.execution!,
          history: [...before.workflow.execution!.history, { id: 'chat-unit', payload }],
        },
      },
    };
    await chat.save(before, next, 'chat-write-unit');
    await chat.save(before, next, 'chat-write-unit');
    expect(
      (await journal.read({ archive: true })).execution!.history.map((event) => event.payload),
    ).toEqual([payload, payload]);
    expect((await chat.read({ archive: true })).workflow).toEqual(next.workflow);
    const event = executionEvent(run, { type: 'PLAN', council: f.council('planning') });
    const planned = await advanceExecution(event, journal, f.inputs);
    expect(await advanceExecution(event, journal, f.inputs)).toEqual(planned);
  },
);

it('persists the execution beside AW4 state, enforces CAS/ownership, and resumes without losing receipts', async () => {
  expect(
    db.mutate(
      {
        type: 'checkpoint',
        state: { local_run: f.executor as unknown as Json, other: 'keep' },
        effects: [],
      },
      1,
    ).ok,
  ).toBe(true);
  let run = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'validate', kind: 'check', applicable: true, reason: 'code' }],
    true,
    'substantial',
  );
  const blank = await journal.read();
  await beginExecution(run, journal);
  await expect(beginExecution(run, journal)).rejects.toThrow('execution-already-exists');
  let event = executionEvent(run, { type: 'PLAN', council: f.council('planning') });
  run = await advanceExecution(event, journal, f.inputs);
  expect(await advanceExecution(event, journal, f.inputs)).toEqual(run);
  await expect(
    journal.save(blank, { ...blank, revision: 1, execution: null }, 'stale'),
  ).rejects.toThrow('workflow-revision-conflict');
  const state = await journal.read();
  await journal.save({ ...state, revision: state.revision - 1 }, state, 'already-saved');
  await expect(journal.save(state, state, 'bad-revision')).rejects.toThrow(
    'invalid-workflow-revision',
  );
  await expect(
    journal.save(
      state,
      { ...state, revision: state.revision + 1, execution: { ...run, task_id: 'other' } },
      'wrong-task',
    ),
  ).rejects.toThrow('wrong-workflow-task');
  const lateOwner = new TaskWorkflowJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    99,
  );
  await expect(
    lateOwner.save(state, { ...state, revision: state.revision + 1 }, 'late-owner'),
  ).rejects.toThrow('workflow-store-write-rejected');
  event = executionEvent(run, {
    type: 'REVIEW',
    target: f.target,
    selection: f.selection,
    baseline: {
      kind: 'real',
      scenario: 'real command represented in unit contract',
      evidence: f.proof,
      inputs: f.target.inputs,
      elapsed_ms: 2,
      exit_code: 0,
    },
    checks: [
      {
        id: 'validate',
        verdict: 'PASS',
        reason: 'check',
        evidence: f.proof,
        inputs: f.target.inputs,
      },
    ],
  });
  run = await advanceExecution(event, journal, f.inputs);
  run = await advanceExecution(
    executionEvent(run, { type: 'ACCEPT', council: f.council('acceptance'), findings: [] }),
    journal,
    f.inputs,
  );
  const reuse = {
    type: 'REUSE' as const,
    scope: 'child',
    original_scope: 'child',
    criterion: 'same',
    original_criterion: 'same',
    source: f.target.inputs,
    current: f.target.inputs,
    evidence: f.proof,
    risk: false,
  };
  const changedInputs = {
    ...f.inputs,
    verify: f.inputs.verify.bind(f.inputs),
    current: async () => ({ ...f.target.inputs, complete: false }),
  };
  await expect(
    advanceExecution(executionEvent(run, reuse), journal, changedInputs),
  ).rejects.toThrow('execution-inputs-stale-or-unknown');
  let reads = 0;
  await expect(
    advanceExecution(executionEvent(run, reuse), journal, {
      verify: f.inputs.verify.bind(f.inputs),
      current: async () => ({ ...f.target.inputs, complete: ++reads <= 2 }),
    }),
  ).rejects.toThrow('council-inputs-stale-or-unknown');
  reads = 0;
  const acceptedRoles = Object.values(run.acceptance!.selection).filter(
    (role) => role.trigger === true,
  ).length;
  await expect(
    advanceExecution(executionEvent(run, reuse), journal, {
      verify: f.inputs.verify.bind(f.inputs),
      current: async () => ({ ...f.target.inputs, complete: ++reads <= 2 + acceptedRoles }),
    }),
  ).rejects.toThrow('child-inputs-changed');
  run = await advanceExecution(executionEvent(run, reuse), journal, f.inputs);
  run = await advanceExecution(
    executionEvent(run, {
      type: 'RESULT',
      result: {
        scope: run.target.scope,
        target: run.target,
        evidence: [f.proof],
        child_results: run.child_results,
        limitations: ['local contract test'],
        summary: 'done',
      },
    }),
    journal,
    f.inputs,
  );
  await f.file('proof.txt', 'changed after result');
  await expect(
    advanceExecution(executionEvent(run, { type: 'DONE' }), journal, f.inputs),
  ).rejects.toThrow('workflow-input-changed');
  await f.file('proof.txt', 'real observation');
  run = await advanceExecution(executionEvent(run, { type: 'DONE' }), journal, f.inputs);
  expect(run.status).toBe('done');
  expect(
    (
      await new TaskWorkflowJournal(
        { execute: async (r) => db.store.execute(r) },
        grant.context,
        1,
        false,
      ).read()
    ).execution,
  ).toEqual(run);
  const stored = db.execute({ type: 'state' });
  expect(stored).toMatchObject({
    ok: true,
    value: { checkpoint: { local_run: f.executor as unknown as Json, other: 'keep' } },
  });
});

it('rejects missing execution, unknown checkpoint versions, malformed state and an unavailable Store', async () => {
  const run = createExecution(
    'task',
    1,
    f.target,
    [{ id: 'check', kind: 'check', applicable: true, reason: 'required' }],
    false,
    'mechanical',
  );
  await expect(
    advanceExecution(executionEvent(run, { type: 'DONE' }), journal, f.inputs),
  ).rejects.toThrow('execution-not-found');
  let revision = 1;
  for (const [state, error] of [
    [{ workflow: { schema_version: 2 } }, 'unsupported-workflow-version'],
    [
      { workflow: { schema_version: 1, revision: 'x', execution: null, readings: {} } },
      'invalid-workflow-integer',
    ],
    [
      { workflow: { schema_version: 1, revision: 0, execution: null, readings: null } },
      'invalid-object',
    ],
    [
      { workflow: { schema_version: 1, revision: 0, execution: null, readings: 0 } },
      'invalid-object',
    ],
  ] as const) {
    expect(
      db.mutate({ type: 'checkpoint', state: state as unknown as Json, effects: [] }, revision++)
        .ok,
    ).toBe(true);
    await expect(journal.read()).rejects.toThrow(error);
  }
  const unavailable = new TaskWorkflowJournal(
    {
      execute: async () => ({
        ok: false,
        error: {
          code: 'unavailable',
          operation_id: null,
          observed_revision: null,
          retryable: true,
          recovery_locator: 'local',
        },
      }),
    },
    grant.context,
    1,
    false,
  );
  await expect(unavailable.read()).rejects.toThrow('workflow-store-unavailable');
});

it('reuses unchanged inputs across an unrelated real commit, detects dirty dependencies and discovery additions/removals', async () => {
  await f.file('dependencies/input.txt', 'dependency v1');
  await f.file('discovery/a.txt', 'a');
  const manifest = await f.inputs.capture(
    { files: ['source.txt', 'dependencies/input.txt'], directories: ['discovery'] },
    'scope-owner',
  );
  const git = (args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=AW5 Test',
        '-c',
        'user.email=aw5@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: f.root, stdio: 'pipe' },
    )
      .toString()
      .trim();
  git(['init']);
  git(['add', '.']);
  git(['commit', '-m', 'Initial isolated fixture']);
  const head = git(['rev-parse', 'HEAD']);
  await f.file('unrelated.txt', 'other');
  git(['add', 'unrelated.txt']);
  git(['commit', '-m', 'Unrelated fixture commit']);
  expect(git(['rev-parse', 'HEAD'])).not.toBe(head);
  expect(compareInputs(manifest, await f.inputs.current(manifest))).toBe('applicable');
  await f.file('dependencies/input.txt', 'dependency v2');
  expect(compareInputs(manifest, await f.inputs.current(manifest))).toBe('changed');
  await f.file('dependencies/input.txt', 'dependency v1');
  const beforeDirty = git(['rev-parse', 'HEAD']);
  await f.file('source.txt', 'uncommitted');
  expect(git(['rev-parse', 'HEAD'])).toBe(beforeDirty);
  expect(compareInputs(manifest, await f.inputs.current(manifest))).toBe('changed');
  await f.file('source.txt', 'source revision 1');
  await f.file('discovery/nested/b.txt', 'new member');
  expect(compareInputs(manifest, await f.inputs.current(manifest))).toBe('changed');
  await unlink(resolve(f.root, 'discovery/nested/b.txt'));
  await unlink(resolve(f.root, 'discovery/a.txt'));
  expect(compareInputs(manifest, await f.inputs.current(manifest))).toBe('changed');
  await unlink(resolve(f.root, 'dependencies/input.txt'));
  expect(compareInputs(manifest, await f.inputs.current(manifest))).toBe('unknown');
  expect((await f.inputs.current({ ...manifest, complete: false })).complete).toBe(false);
});

it('hashes actual binary bytes, limits external evidence roots, rejects aliases, and preserves unknown discovery', async () => {
  await writeFile(resolve(f.root, 'binary.dat'), Buffer.from([0, 255, 1]));
  const ref = await f.inputs.ref('binary.dat');
  expect(ref.hash).toHaveLength(64);
  await f.inputs.verify([ref]);
  await expect(f.inputs.ref(resolve(f.root, 'binary.dat'))).rejects.toThrow(
    'external-evidence-not-authorized',
  );
  const external = new FileWorkflowInputs(f.root, f.root);
  expect((await external.ref(resolve(f.root, 'binary.dat'))).hash).toBe(ref.hash);
  await expect(external.ref('/etc/hosts')).rejects.toThrow('unsafe-locator');
  await mkdir(resolve(f.root, 'discovery'));
  await symlink(resolve(f.root, 'discovery'), resolve(f.root, 'alias'));
  await expect(f.inputs.capture({ files: [], directories: ['alias'] }, 'owner')).rejects.toThrow(
    'unsafe-discovery-path',
  );
  await expect(
    f.inputs.capture({ files: [], directories: ['source.txt'] }, 'owner'),
  ).rejects.toThrow('not-discovery-directory');
  await expect(f.inputs.capture({ files: [], directories: [] }, 'owner')).rejects.toThrow(
    'empty-input-manifest',
  );
  for (const discovery_rule of ['broken', '{}', '{"files":[],"directories":null}'])
    expect((await f.inputs.current({ ...f.target.inputs, discovery_rule })).complete).toBe(false);
  expect((await f.inputs.current({ ...f.target.inputs, complete: false })).complete).toBe(false);
  expect((await f.inputs.current({ ...f.target.inputs, attested_by: '' })).complete).toBe(false);
});
