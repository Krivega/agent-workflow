import { DataRoutes, directEvidence } from '../application/dataRoutes.js';
import { TaskWorkflowJournal } from '../adapters/storage/workflowJournal.js';
import {
  confirmSession,
  dataRole,
  roleBrief,
  validateDataAnswer,
  validateDataQuery,
} from '../core/dataRoute.js';
import type { AgentSession, DataAnswer, DataQuery, DataReading } from '../core/dataRoute.js';
import { body, fixture, grant } from './storageFixtures.js';
import { workflowFixture } from './workflowFixtures.js';
let f: Awaited<ReturnType<typeof workflowFixture>>;
let db: ReturnType<typeof fixture>;
const profile = { model: 'fixture', effort: 'high', reason: 'test-only profile' };
let session: AgentSession;
let ports: ReturnType<typeof makePorts>;
let journal: TaskWorkflowJournal;
let routes: DataRoutes;
function makePorts() {
  return {
    create: vi.fn(async () => session),
    inspect: vi.fn(async (_id: string): Promise<AgentSession | null> => session),
    load: vi.fn(async () => f.proof),
    send: vi.fn(async () => 'turn'),
    recoverSend: vi.fn(async (): Promise<string | null> => 'turn'),
    poll: vi.fn(
      async (): Promise<{ status: 'running' } | { status: 'completed'; answer: DataAnswer }> => ({
        status: 'running',
      }),
    ),
  };
}
beforeEach(async () => {
  f = await workflowFixture();
  db = fixture();
  db.claim();
  session = {
    id: 'session',
    model: profile.model,
    effort: profile.effort,
    workspace: f.root,
    project_id: 'project',
    read_only: true,
    network: false,
    forked_from: null,
    initial_turns: 0,
    receipt: f.proof,
  };
  ports = makePorts();
  journal = new TaskWorkflowJournal(
    { execute: async (r) => db.store.execute(r) },
    grant.context,
    1,
  );
  routes = new DataRoutes(journal, ports, f.inputs);
});
afterEach(async () => {
  db.dispose();
  await f.dispose();
});
const answer = (query: DataQuery = f.query): DataAnswer => ({
  outcome: 'PASS',
  scope: query.scope,
  sources: query.sources,
  coverage: 'complete',
  content: 'selected owner',
  continuation: null,
  limitations: ['test double'],
  evidence: f.proof,
});
async function completed(query: DataQuery = f.query) {
  await routes.start('read', query, profile);
  await routes.send('read');
  ports.poll.mockResolvedValue({ status: 'completed', answer: answer(query) });
  return routes.poll('read');
}
const large = (): DataQuery => ({
  ...f.query,
  kind: 'large-source',
  ranges: [{ start: 1, end: 2 }],
  selection: 'all lines',
  classification: 'source',
  completeness: 'entire selected range',
  continuation: null,
});
const evidence = (): DataQuery => ({
  ...f.query,
  kind: 'unknown-evidence',
  task_id: 'task',
  budget: { pages: 5, bodies: 5, bytes: 2000 },
});

it('reads known exact/head IDs directly without starting any data agent', async () => {
  expect(db.mutate({ type: 'write', id: 'known', body }, 1).ok).toBe(true);
  const store = {
    execute: async (r: Parameters<typeof db.store.execute>[0]) => db.store.execute(r),
  };
  for (const revision of [1, null])
    expect((await directEvidence(store, grant.context, 'known', revision)).metadata.id).toBe(
      'known',
    );
  await expect(directEvidence(store, grant.context, 'missing', 1)).rejects.toThrow(
    'direct-read-failed',
  );
  expect(ports.create).not.toHaveBeenCalled();
});

it('persists start/load/send/wait/result and follows up the same identity without copying extra context', async () => {
  const reading = await routes.start('read', f.query, profile);
  expect(reading.phase).toBe('ready');
  await expect(routes.start('read', f.query, profile)).rejects.toThrow(
    'data-reading-already-exists',
  );
  const running = await routes.send('read');
  expect(await routes.poll('read')).toEqual(running);
  expect(ports.create).toHaveBeenCalledTimes(1);
  ports.poll.mockResolvedValue({
    status: 'completed',
    answer: { ...answer(), coverage: 'partial', continuation: 'next range' },
  });
  const partial = await routes.poll('read');
  expect(partial.answers[0]!.coverage).toBe('partial');
  await routes.followUp('read', { ...f.query, question: 'next question' }, null);
  await routes.send('read');
  ports.poll.mockResolvedValue({ status: 'completed', answer: answer() });
  const final = await routes.poll('read');
  expect(final.answers).toHaveLength(2);
  expect(final.creations).toBe(1);
  expect(ports.create).toHaveBeenCalledTimes(1);
  expect(ports.inspect).toHaveBeenCalledWith('session');
  expect((await journal.read()).readings.read).toEqual(final);
  const brief = roleBrief({ ...f.query, history: ['PARENT_ONLY_SECRET'] } as DataQuery);
  expect(brief).not.toContain('PARENT_ONLY_SECRET');
  expect(brief).toContain('"fork_turns":"none"');
  expect(dataRole(f.query)).toBe('explorer');
  expect(dataRole(large())).toBe('raw-data-reader');
  expect(dataRole(evidence())).toBe('evidence-explorer');
  expect(JSON.parse(roleBrief(large()))).toMatchObject({
    ranges: [{ start: 1, end: 2 }],
    completeness: 'entire selected range',
    continuation: null,
  });
  expect(JSON.parse(roleBrief(evidence()))).toMatchObject({
    task_id: 'task',
    budget: { pages: 5, bodies: 5, bytes: 2000 },
  });
});

it('rejects changed revisions and old range continuations until explicit reselection is supplied', async () => {
  await completed(large());
  await f.file('source.txt', 'new revision');
  const changed = { ...large(), sources: [await f.ref('source.txt')] } as Extract<
    DataQuery,
    { kind: 'large-source' }
  >;
  await expect(routes.followUp('read', changed, null)).rejects.toThrow('source-revision-changed');
  await expect(
    routes.followUp('read', { ...changed, continuation: 'old lines' }, f.proof),
  ).rejects.toThrow('old-range-continuation');
  const next = await routes.followUp('read', changed, f.proof);
  expect(next.phase).toBe('ready');
  await f.file('source.txt', 'changed again');
  await expect(routes.send('read')).rejects.toThrow('workflow-input-changed');
  expect(ports.create).toHaveBeenCalledTimes(1);
});

it('does not silently retry an uncertain create or send; recovery and explicit restart remain distinct', async () => {
  ports.create.mockRejectedValueOnce(new Error('transport lost'));
  await expect(routes.start('read', f.query, profile)).rejects.toThrow('transport lost');
  expect((await journal.read()).readings.read!.phase).toBe('reserved');
  await expect(routes.start('read', f.query, profile)).rejects.toThrow(
    'data-reading-already-exists',
  );
  await expect(routes.send('read')).rejects.toThrow('data-not-ready');
  ports.inspect.mockResolvedValueOnce(null);
  await expect(routes.recover('read', 'session', null, null)).rejects.toThrow('role-identity-lost');
  await expect(routes.recover('read', 'session', null, 'turn')).rejects.toThrow(
    'recovery-load-missing',
  );
  expect((await routes.recover('read', 'session', null, null)).phase).toBe('ready');
  ports.send.mockRejectedValueOnce(new Error('send uncertain'));
  await expect(routes.send('read')).rejects.toThrow('send uncertain');
  await expect(routes.recover('read', 'wrong', f.proof, 'turn')).rejects.toThrow(
    'wrong-recovery-identity',
  );
  const recovered = await routes.recover('read', 'session', f.proof, 'turn');
  expect(recovered.phase).toBe('running');
  await expect(routes.recover('read', 'session', f.proof, null)).rejects.toThrow(
    'recovery-not-needed',
  );
  await expect(
    routes.start('replacement', f.query, profile, { previous_id: 'read', checkpoint: f.proof }),
  ).rejects.toThrow('previous-session-recoverable');
  ports.inspect.mockResolvedValueOnce(null);
  const replacement = await routes.start('replacement', f.query, profile, {
    previous_id: 'read',
    checkpoint: f.proof,
  });
  expect(replacement.restart!.previous_id).toBe('read');
  ports.load.mockRejectedValueOnce(new Error('load interrupted'));
  await expect(routes.start('loading', f.query, profile)).rejects.toThrow('load interrupted');
  expect((await routes.recover('loading', 'session', f.proof, null)).phase).toBe('ready');
  ports.create.mockRejectedValueOnce(new Error('unknown create'));
  await expect(routes.start('lost', f.query, profile)).rejects.toThrow('unknown create');
  expect(
    (await routes.start('explicit', f.query, profile, { previous_id: 'lost', checkpoint: f.proof }))
      .phase,
  ).toBe('ready');
});

it('blocks malformed/incomplete briefs, unconfirmed profiles and partial answers without continuation', () => {
  for (const query of [
    { ...f.query, scope: [] },
    { ...f.query, sources: [] },
    { ...f.query, rules: [] },
  ])
    expect(() => validateDataQuery(query)).toThrow('incomplete-data-brief');
  expect(() => validateDataQuery({ ...f.query, procedures: [] })).toThrow(
    'data-procedures-missing',
  );
  expect(() => validateDataQuery({ ...f.query, entrypoints: [] })).toThrow('entrypoints-missing');
  expect(() =>
    validateDataQuery({ ...evidence(), budget: { pages: 0, bodies: 1, bytes: 1 } } as DataQuery),
  ).toThrow('data-budget-invalid');
  for (const patch of [
    { sources: [f.proof, f.proof] },
    { ranges: [] },
    { ranges: [{ start: 0, end: 2 }] },
    { ranges: [{ start: 2, end: 1 }] },
    { ranges: [{ start: 1.5, end: 2 }] },
    { ranges: [{ start: 1, end: 2.5 }] },
  ])
    expect(() => validateDataQuery({ ...large(), ...patch })).toThrow('data-ranges-invalid');
  for (const patch of [
    { model: 'other' },
    { effort: 'other' },
    { read_only: false },
    { network: true },
  ])
    expect(() => confirmSession({ ...session, ...patch }, profile, true)).toThrow(
      'effective-profile-mismatch',
    );
  for (const patch of [{ forked_from: 'parent' }, { initial_turns: 1 }])
    expect(() => confirmSession({ ...session, ...patch }, profile, true)).toThrow(
      'parent-history-inherited',
    );
  expect(() => confirmSession({ ...session, initial_turns: 3 }, profile, false)).not.toThrow();
  const reading = { query: f.query } as DataReading;
  for (const scope of [[], ['foreign']])
    expect(() => validateDataAnswer(reading, { ...answer(), scope })).toThrow('wrong-data-scope');
  expect(() => validateDataAnswer(reading, { ...answer(), sources: [] })).toThrow(
    'wrong-data-revision',
  );
  expect(() => validateDataAnswer(reading, { ...answer(), coverage: 'partial' })).toThrow(
    'partial-without-continuation',
  );
});

it('rejects missing/wrong identities, changed role contracts, stale results and overlapping sends', async () => {
  await expect(routes.send('missing')).rejects.toThrow('data-reading-missing');
  await expect(routes.poll('missing')).rejects.toThrow('data-reading-missing');
  await routes.start('read', f.query, profile);
  await expect(routes.poll('read')).rejects.toThrow('data-not-running');
  await expect(routes.followUp('read', f.query, null)).rejects.toThrow('data-follow-up-not-ready');
  const sends = await Promise.allSettled([routes.send('read'), routes.send('read')]);
  expect(sends.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(ports.send).toHaveBeenCalledTimes(1);
  ports.poll.mockResolvedValue({ status: 'completed', answer: answer() });
  await f.file('source.txt', 'late change');
  await expect(routes.poll('read')).rejects.toThrow('workflow-input-changed');
  await f.file('source.txt', 'source revision 1');
  await routes.poll('read');
  ports.inspect.mockResolvedValueOnce(null);
  await expect(routes.followUp('read', f.query, null)).rejects.toThrow('role-identity-lost');
  ports.inspect.mockResolvedValueOnce({ ...session, id: 'wrong' });
  await expect(routes.followUp('read', f.query, null)).rejects.toThrow('role-identity-lost');
  for (const query of [
    large(),
    { ...f.query, rules: [] },
    { ...f.query, rules: [f.proof] },
    { ...f.query, procedures: f.query.procedures.map((p) => ({ ...p, hash: 'changed' })) },
  ])
    await expect(routes.followUp('read', query, null)).rejects.toThrow();
  await f.file('source.txt', 'revision 2');
  const changed = { ...f.query, sources: [await f.ref('source.txt')] };
  expect((await routes.followUp('read', changed, f.proof)).phase).toBe('ready');
  // A later competing checkpoint must not be overwritten by a stale operation.
  const originalRead = journal.read.bind(journal);
  let calls = 0;
  const spy = vi.spyOn(journal, 'read').mockImplementation(async () => {
    const state = await originalRead();
    calls += 1;
    if (calls === 2) state.readings.read = { ...state.readings.read!, phase: 'sending' };
    return state;
  });
  await expect(routes.send('read')).rejects.toThrow('data-revision-conflict');
  spy.mockRestore();
});

it('recovers a lost turn/start response only from the saved delivery id and never repeats an uncertain send', async () => {
  await routes.start('read', f.query, profile);
  ports.send.mockRejectedValueOnce(new Error('accepted but response lost'));
  await expect(routes.send('read')).rejects.toThrow('accepted but response lost');
  ports.recoverSend.mockResolvedValueOnce(null);
  await expect(routes.recover('read', 'session', null, null)).rejects.toThrow(
    'send-outcome-unknown',
  );
  await expect(routes.send('read')).rejects.toThrow('data-not-ready');
  await expect(routes.recover('read', 'session', null, 'other')).rejects.toThrow(
    'send-outcome-unknown',
  );
  expect((await journal.read()).readings.read!.phase).toBe('sending');
  expect((await routes.recover('read', 'session', null, null)).phase).toBe('running');
  expect(ports.recoverSend).toHaveBeenLastCalledWith(session, 'read:0');
  expect(ports.send).toHaveBeenCalledTimes(1);
  expect(ports.load).toHaveBeenCalledTimes(1);
  const state = await journal.read();
  for (const patch of [{ send_id: undefined }, { load: null }]) {
    const previous = await journal.read();
    const reading = { ...state.readings.read!, phase: 'sending' as const, ...patch };
    if (reading.send_id === undefined) delete reading.send_id;
    await journal.save(
      previous,
      { ...state, revision: previous.revision + 1, readings: { read: reading as DataReading } },
      `legacy-${previous.revision}`,
    );
    await expect(routes.recover('read', 'session', f.proof, null)).rejects.toThrow(
      'send-outcome-unknown',
    );
  }
});
