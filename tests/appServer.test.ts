import { readArtifactFile } from '../adapters/storage/sharedArtifacts.js';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AppServerSessions } from '../adapters/codex/appServerSessions.js';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { workflowFixture } from './workflowFixtures.js';
import type { AgentSession } from '../core/dataRoute.js';
import { councilRoles } from '../core/council.js';
let f: Awaited<ReturnType<typeof workflowFixture>>;
let out: string;
let rpc: {
  request: ReturnType<typeof vi.fn<AppServerRpc['request']>>;
  completed: ReturnType<typeof vi.fn<AppServerRpc['completed']>>;
};
let sessions: AppServerSessions;
let session: AgentSession;
beforeEach(async () => {
  f = await workflowFixture();
  out = await realpath(await mkdtemp(resolve(tmpdir(), 'aw5-codex-')));
  rpc = { request: vi.fn<AppServerRpc['request']>(), completed: vi.fn(async () => undefined) };
  sessions = new AppServerSessions(rpc, f.root, 'project', out);
  session = {
    id: 'session',
    model: 'model',
    effort: 'high',
    workspace: f.root,
    project_id: 'project',
    read_only: true,
    network: false,
    forked_from: null,
    initial_turns: 0,
    receipt: f.proof,
  };
});
afterEach(async () => {
  await f.dispose();
  await rm(out, { recursive: true, force: true });
});
const started = () => ({
  thread: { id: 'session', projectId: 'project', forkedFromId: null, turns: [] },
  cwd: f.root,
  model: 'model',
  reasoningEffort: 'high',
  sandbox: { type: 'readOnly', networkAccess: false },
});
const thread = (status: string, items: unknown[]) => ({
  thread: { id: 'session', turns: [{ id: 'turn', status, items }] },
});

it('keeps workflow project identity for an independent native root without a cloud project', async () => {
  const response = started();
  rpc.request.mockResolvedValue({ ...response, thread: { ...response.thread, projectId: null } });
  const native = new AppServerSessions(rpc, f.root, 'project', out, null, null);
  expect(await native.create({ model: 'model', effort: 'high', reason: 'planning' })).toMatchObject(
    { project_id: 'project', native_project_id: null },
  );
  expect(rpc.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({ projectId: null }),
  );
});

it('observes an existing native LOAD without starting or resuming any thread or turn', async () => {
  const query = f.query;
  const refs = [...query.procedures, ...query.rules];
  const output = await Promise.all(
    refs.map(async (ref) =>
      JSON.stringify({
        path: ref.locator,
        sha256: ref.hash,
        content: await readFile(resolve(f.root, ref.locator), 'utf8'),
      }),
    ),
  );
  rpc.request.mockResolvedValue(
    thread('completed', [
      { type: 'commandExecution', exitCode: 0, aggregatedOutput: output.join('\n') },
    ]),
  );
  const proof = await sessions.observeLoad(session, query, 'turn');
  expect(readArtifactFile(proof.locator)).toMatchObject({
    session: 'session',
    turn: 'turn',
    refs: refs.map(({ locator, hash }) => ({ locator, hash })),
  });
  expect(rpc.request).toHaveBeenCalledExactlyOnceWith('thread/read', {
    threadId: 'session',
    includeTurns: true,
  });
  expect(rpc.completed).not.toHaveBeenCalled();
  const observed = await sessions.observeLoad({ ...session, initial_turns: -1 }, query, 'turn');
  expect(readArtifactFile(observed.locator)).not.toHaveProperty('creation');
});

it.each(councilRoles)(
  'requires observed full text of the common and %s profile in native LOAD',
  async (role) => {
    const query = { ...f.query, rules: [...f.spec.rules, ...f.profiles[role]] };
    const refs = [...query.procedures, ...query.rules];
    const lines = await Promise.all(
      refs.map(async (ref) =>
        JSON.stringify({
          path: ref.locator,
          sha256: ref.hash,
          content: await readFile(resolve(f.root, ref.locator), 'utf8'),
        }),
      ),
    );
    for (const missing of f.profiles[role]) {
      const output = lines.filter(
        (line) => (JSON.parse(line) as { path: string }).path !== missing.locator,
      );
      rpc.request.mockResolvedValueOnce({ turn: { id: 'turn' } }).mockResolvedValueOnce(
        thread('completed', [
          { type: 'agentMessage', text: `Read ${missing.locator}` },
          { type: 'commandExecution', exitCode: 0, aggregatedOutput: output.join('\n') },
        ]),
      );
      await expect(sessions.load(session, query)).rejects.toThrow('procedure-read-unconfirmed');
    }
    rpc.request
      .mockResolvedValueOnce({ turn: { id: 'turn' } })
      .mockResolvedValueOnce(
        thread('completed', [
          { type: 'commandExecution', exitCode: 0, aggregatedOutput: lines.join('\n') },
        ]),
      );
    const receipt = await sessions.load(session, query);
    const saved = readArtifactFile(receipt.locator) as { refs: unknown[] };
    expect(saved.refs).toEqual(expect.arrayContaining(f.profiles[role]));
    const prompts = JSON.stringify(rpc.request.mock.calls);
    for (const ref of f.profiles[role]) expect(prompts).toContain(ref.locator);
    for (const other of councilRoles.filter((id) => id !== role))
      expect(prompts).not.toContain(f.profiles[other][1]!.locator);
  },
);

it('starts a fresh read-only session with no fork/history and resumes the exact identity while preserving primary receipts', async () => {
  rpc.request.mockResolvedValue(started());
  const created = await sessions.create({ model: 'model', effort: 'high', reason: 'role' });
  expect(created).toMatchObject({
    initial_turns: 0,
    forked_from: null,
    read_only: true,
    network: false,
  });
  expect(rpc.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      sandbox: 'read-only',
      approvalPolicy: 'never',
      model: 'model',
      config: { model_reasoning_effort: 'high' },
    }),
  );
  expect(JSON.stringify(rpc.request.mock.calls)).not.toContain('thread/fork');
  const resumed = await sessions.inspect('session');
  expect(resumed!.initial_turns).toBe(-1);
  expect(readArtifactFile(created.receipt.locator)).toMatchObject({
    operation: 'thread/start',
    session: { thread: { turns: [] } },
  });
  expect(readArtifactFile(resumed!.receipt.locator)).toMatchObject({
    operation: 'thread/resume',
  });
  expect(await readFile(created.receipt.locator, 'utf8')).toContain('"readOnly"');
  await sessions.inspect('session'); // Immutable repeated observation uses the existing identical receipt.
  await writeFile(created.receipt.locator, 'corrupted');
  await expect(sessions.create({ model: 'model', effort: 'high', reason: 'role' })).rejects.toThrow(
    'receipt-write-failed',
  );
  const absentOut = new AppServerSessions(rpc, f.root, 'project', resolve(out, 'missing'));
  await expect(
    absentOut.create({ model: 'model', effort: 'high', reason: 'role' }),
  ).rejects.toThrow('receipt-write-failed');
});

it('distinguishes a lost empty rollout from an unknown transport failure and rejects foreign or unconfirmed metadata', async () => {
  rpc.request.mockRejectedValueOnce(
    new Error(
      'app-server-error:{"code":-32600,"message":"no rollout found for thread id session"}',
    ),
  );
  expect(await sessions.inspect('session')).toBeNull();
  for (const error of [
    new Error('transport unavailable'),
    'not an Error',
    new Error('app-server-error:other failure'),
  ]) {
    rpc.request.mockRejectedValueOnce(error);
    await expect(sessions.inspect('session')).rejects.toBe(error);
  }
  rpc.request.mockResolvedValue({ ...started(), cwd: '/other' });
  await expect(sessions.inspect('session')).rejects.toThrow('wrong-session-project');
  rpc.request.mockResolvedValue({
    ...started(),
    thread: { ...started().thread, projectId: 'other' },
  });
  await expect(sessions.inspect('session')).rejects.toThrow('wrong-session-project');
  rpc.request.mockResolvedValue({ ...started(), thread: { ...started().thread, turns: null } });
  await expect(sessions.inspect('session')).rejects.toThrow('session-history-unknown');
  rpc.request.mockResolvedValue({
    ...started(),
    thread: { ...started().thread, id: 'other', forkedFromId: 'parent' },
    sandbox: { type: 'workspaceWrite', networkAccess: true },
  });
  await expect(sessions.inspect('session')).rejects.toThrow('wrong-resumed-session');
  rpc.request.mockResolvedValue({ ...started(), thread: { ...started().thread, id: '../escape' } });
  await expect(sessions.inspect('session')).rejects.toThrow('unsafe-receipt-name');
});

it('loads procedures only from exact observed tool output, never from model assertions', async () => {
  const refs = [...f.query.procedures, ...f.query.rules];
  const lines = await Promise.all(
    refs.map(async (ref) =>
      JSON.stringify({
        path: ref.locator,
        sha256: ref.hash,
        content: await readFile(resolve(f.root, ref.locator), 'utf8'),
      }),
    ),
  );
  const items = [
    { type: 'agentMessage', text: 'I read everything' },
    { type: 'commandExecution', exitCode: 1, aggregatedOutput: lines.join('\n') },
    { type: 'commandExecution', exitCode: 0, aggregatedOutput: null },
    {
      type: 'commandExecution',
      exitCode: 0,
      aggregatedOutput:
        'not-json\nnull\n{"path":0}\n{"path":"x","content":0}\n{"path":"x","content":"wrong","sha256":"wrong"}\n' +
        lines.join('\n'),
    },
  ];
  rpc.request
    .mockResolvedValueOnce({ turn: { id: 'turn' } })
    .mockResolvedValueOnce(thread('completed', items));
  const receipt = await sessions.load(session, {
    ...f.query,
    procedures: f.query.procedures.map((ref) => ({ ...ref, content: 'PARENT_HISTORY_SECRET' })),
    rules: f.query.rules.map((ref) => ({ ...ref, parent_history: 'PARENT_HISTORY_SECRET' })),
  });
  expect(JSON.stringify(rpc.request.mock.calls)).not.toContain('PARENT_HISTORY_SECRET');
  expect(contentHash(await readFile(receipt.locator, 'utf8'))).toBe(receipt.hash);
  expect(rpc.completed).toHaveBeenCalledWith('session', 'turn');
  expect(rpc.request.mock.calls[0]![1]).toMatchObject({
    environments: [{ environmentId: 'local', cwd: f.root, runtimeWorkspaceRoots: [f.root] }],
  });
  for (const response of [
    thread('failed', []),
    thread('completed', []),
    thread('completed', [{ type: 'agentMessage', text: 'all loaded' }]),
    thread('completed', [
      { type: 'commandExecution', exitCode: 0, aggregatedOutput: lines.slice(1).join('\n') },
    ]),
  ]) {
    rpc.request.mockResolvedValueOnce({ turn: { id: 'turn' } }).mockResolvedValueOnce(response);
    await expect(sessions.load(session, f.query)).rejects.toThrow();
  }
  rpc.request
    .mockResolvedValueOnce({ turn: { id: 'turn' } })
    .mockResolvedValueOnce(thread('completed', []));
  await expect(sessions.load(session, f.query)).rejects.toThrow('procedure-read-unconfirmed');
});

it('polls active turns without restarting and validates completed structured answers against protocol failures', async () => {
  rpc.request.mockResolvedValue(thread('inProgress', []));
  expect(await sessions.poll(session, 'turn')).toEqual({ status: 'running' });
  const answer = {
    outcome: 'PASS',
    scope: f.query.scope,
    sources: f.query.sources,
    coverage: 'complete',
    content: 'raw data',
    continuation: null,
    limitations: [],
  };
  rpc.request.mockResolvedValue(
    thread('completed', [
      { type: 'reasoning' },
      { type: 'agentMessage', text: JSON.stringify(answer) },
    ]),
  );
  const result = await sessions.poll(session, 'turn');
  expect(result).toMatchObject({ status: 'completed', answer });
  for (const patch of [
    { outcome: 'UNKNOWN' },
    { coverage: 'unknown' },
    { scope: null },
    { sources: null },
    { limitations: null },
    { content: null },
    { continuation: 1 },
  ]) {
    rpc.request.mockResolvedValue(
      thread('completed', [
        { type: 'agentMessage', text: JSON.stringify({ ...answer, ...patch }) },
      ]),
    );
    await expect(sessions.poll(session, 'turn')).rejects.toThrow('invalid-data-answer');
  }
  rpc.request.mockResolvedValue(
    thread('completed', [
      {
        type: 'agentMessage',
        text: JSON.stringify({ ...answer, coverage: 'partial', continuation: 'next' }),
      },
    ]),
  );
  expect(await sessions.poll(session, 'turn')).toMatchObject({ status: 'completed' });
  for (const response of [
    thread('failed', []),
    thread('completed', null as unknown as unknown[]),
    thread('completed', []),
    thread('completed', [{ type: 'agentMessage', text: 1 }]),
    thread('completed', [{ type: 'agentMessage', text: 'not-json' }]),
    { thread: { id: 'foreign', turns: [] } },
    { thread: { id: 'session', turns: null } },
    { thread: { id: 'session', turns: [] } },
  ]) {
    rpc.request.mockResolvedValue(response);
    await expect(sessions.poll(session, 'turn')).rejects.toThrow();
  }
});

it('locates an uncertain delivery in primary turn history without repeating turn/start', async () => {
  rpc.request.mockResolvedValueOnce({ turn: { id: 'turn' } });
  expect(await sessions.send(session, 'brief', 'read:0')).toBe('turn');
  const marker = 'Workflow delivery id: "read:0"\nbrief';
  expect(JSON.stringify(rpc.request.mock.calls[0])).toContain('Workflow delivery id');
  const found = [{ type: 'userMessage', content: [{ type: 'text', text: marker }] }];
  for (const items of [
    found,
    [
      { type: 'reasoning' },
      { type: 'userMessage', content: null },
      {
        type: 'userMessage',
        content: [
          { type: 'image' },
          { type: 'text', text: 1 },
          { type: 'text', text: 'other' },
          { type: 'text', text: marker },
        ],
      },
    ],
  ]) {
    rpc.request.mockResolvedValueOnce(thread('completed', items));
    expect(await sessions.recoverSend(session, 'read:0')).toBe('turn');
  }
  rpc.request.mockResolvedValueOnce(thread('completed', []));
  expect(await sessions.recoverSend(session, 'read:0')).toBeNull();
  rpc.request.mockResolvedValueOnce({
    thread: {
      id: 'session',
      turns: [
        { id: 'a', items: found },
        { id: 'b', items: found },
      ],
    },
  });
  expect(await sessions.recoverSend(session, 'read:0')).toBeNull();
  for (const response of [
    { thread: { id: 'other', turns: [] } },
    { thread: { id: 'session', turns: null } },
    thread('completed', null as unknown as unknown[]),
  ]) {
    rpc.request.mockResolvedValueOnce(response);
    await expect(sessions.recoverSend(session, 'read:0')).rejects.toThrow();
  }
  expect(rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});

it('reads the actual native agent role from the server metadata', async () => {
  const response = started();
  rpc.request.mockResolvedValue({
    ...response,
    thread: { ...response.thread, agentRole: 'auditor' },
  });
  expect((await sessions.inspect('session'))!.agent_role).toBe('auditor');
});

it('confirms a native auditor project through its real parent without inventing a native project id', async () => {
  const raw = started();
  const native = {
    ...raw,
    thread: { ...raw.thread, projectId: null, agentRole: 'auditor', parentThreadId: 'parent' },
  };
  rpc.request.mockImplementation(async (method) =>
    method === 'thread/read'
      ? { thread: { id: 'parent', projectId: 'project', cwd: f.root } }
      : native,
  );
  expect(await sessions.inspect('session')).toMatchObject({
    project_id: 'project',
    native_project_id: null,
    parent_id: 'parent',
    agent_role: 'auditor',
  });
  for (const parent of [
    { id: 'wrong', projectId: 'project', cwd: f.root },
    { id: 'parent', projectId: 'project', cwd: 'wrong' },
  ]) {
    rpc.request.mockImplementation(async (method) =>
      method === 'thread/read' ? { thread: parent } : native,
    );
    await expect(sessions.inspect('session')).rejects.toThrow('wrong-native-parent');
  }
  for (const patch of [{ agentRole: 'other' }, { parentThreadId: null }]) {
    rpc.request.mockResolvedValue({ ...native, thread: { ...native.thread, ...patch } });
    await expect(sessions.inspect('session')).rejects.toThrow('wrong-session-project');
  }
});

it('restores only an explicitly bound native parent before inspecting its unloaded auditor', async () => {
  const raw = started();
  const native = {
    ...raw,
    thread: { ...raw.thread, projectId: null, agentRole: 'auditor', parentThreadId: 'parent' },
  };
  const parent = { ...raw, thread: { ...raw.thread, id: 'parent', cwd: f.root } };
  const bound = new AppServerSessions(rpc, f.root, 'project', out, 'parent');
  rpc.request.mockImplementation(async (method, params) => {
    if (method === 'thread/read') return params.threadId === 'parent' ? parent : native;
    return params.threadId === 'parent' ? parent : native;
  });
  expect((await bound.inspect('session'))!.agent_role).toBe('auditor');
  expect(rpc.request.mock.calls.slice(0, 3).map(([method, p]) => [method, p.threadId])).toEqual([
    ['thread/read', 'session'],
    ['thread/resume', 'parent'],
    ['thread/resume', 'session'],
  ]);
  for (const patch of [{ id: 'wrong' }, { agentRole: 'other' }, { parentThreadId: 'foreign' }]) {
    rpc.request.mockResolvedValue({ ...native, thread: { ...native.thread, ...patch } });
    await expect(bound.inspect('session')).rejects.toThrow('wrong-native-child');
  }
});

it('observes terminal audit attempts without DataAnswer or LOAD and never resumes or starts them', async () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    rpc.request.mockResolvedValue(thread(status, []));
    const result = await sessions.observeAuditTerminal('attempt', session, f.proof, false, []);
    expect(result).toMatchObject({
      outcome: 'terminal',
      operation: 'attempt',
      turn: 'turn',
      status,
    });
    if (result.outcome !== 'unknown')
      expect(contentHash(await readFile(result.receipt.locator, 'utf8'))).toBe(result.receipt.hash);
  }
  for (const status of ['inProgress', 'unknown']) {
    rpc.request.mockResolvedValue(thread(status, []));
    expect(await sessions.observeAuditTerminal('attempt', session, f.proof, false, [])).toEqual({
      outcome: 'unknown',
    });
  }
  rpc.request.mockResolvedValue({ thread: { id: session.id, turns: [] } });
  expect(await sessions.observeAuditTerminal('attempt', session, f.proof, false, [])).toEqual({
    outcome: 'unknown',
  });
  expect(await sessions.observeAuditTerminal('attempt', session, f.proof, true, [])).toMatchObject({
    outcome: 'idle',
  });
  expect(await sessions.observeAuditRefusal('attempt', f.proof)).toMatchObject({
    outcome: 'not-started',
    session: null,
  });
  expect(rpc.request.mock.calls.every(([method]) => method === 'thread/read')).toBe(true);
  rpc.request.mockResolvedValue({ thread: { id: 'foreign', turns: [] } });
  await expect(
    sessions.observeAuditTerminal('attempt', session, f.proof, false, []),
  ).rejects.toThrow('wrong-thread-read');
});

it('requires every primary send to have one exact observed turn before retiring an audit', async () => {
  const items = [
    { type: 'reasoning' },
    { type: 'userMessage', content: [{ type: 'image' }, { type: 'text', text: 'card.md' }] },
  ];
  rpc.request.mockResolvedValue(thread('completed', items));
  expect(
    await sessions.observeAuditTerminal('attempt', session, f.proof, false, ['card.md']),
  ).toMatchObject({ outcome: 'terminal' });
  for (const payload of [
    thread('completed', []),
    thread('completed', [{ type: 'userMessage', content: null }]),
    thread('completed', [{ type: 'userMessage', content: [{ type: 'text', text: 'different' }] }]),
    thread('completed', null as unknown as unknown[]),
  ]) {
    rpc.request.mockResolvedValue(payload);
    expect(
      await sessions.observeAuditTerminal('attempt', session, f.proof, false, ['card.md']),
    ).toEqual({ outcome: 'unknown' });
  }
  rpc.request.mockResolvedValue({
    thread: {
      id: session.id,
      turns: [
        { id: 'one', status: 'completed', items },
        { id: 'two', status: 'completed', items },
      ],
    },
  });
  expect(
    await sessions.observeAuditTerminal('attempt', session, f.proof, false, ['card.md']),
  ).toEqual({ outcome: 'unknown' });
});

it('correlates native V2 turns through primary parent attribution when user messages are not exposed', async () => {
  const path = resolve(out, 'native-child.jsonl');
  const native = { ...session, native_child: true, parent_id: 'parent' };
  const meta = { type: 'session_meta', payload: { id: session.id, parent_thread_id: 'parent' } };
  const started = {
    type: 'event_msg',
    payload: {
      type: 'task_started',
      turn_id: 'turn',
      turn_attribution: { parent_turn_id: 'parent-turn' },
    },
  };
  const observation = thread('interrupted', []);
  Object.assign(observation.thread, { path });
  rpc.request.mockResolvedValue(observation);
  const write = async (records: unknown[]) =>
    writeFile(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await write([meta, started]);
  expect(
    await sessions.observeAuditTerminal(
      'attempt',
      native,
      f.proof,
      false,
      ['encrypted'],
      ['parent-turn'],
    ),
  ).toMatchObject({ outcome: 'terminal', status: 'interrupted' });
  for (const records of [
    [started],
    [meta, meta, started],
    [meta, started, started],
    [{ ...meta, payload: { ...meta.payload, id: 'foreign' } }, started],
    [{ ...meta, payload: { ...meta.payload, parent_thread_id: 'foreign' } }, started],
    [meta, { ...started, payload: { ...started.payload, turn_id: 'foreign' } }],
    [
      meta,
      {
        ...started,
        payload: { ...started.payload, turn_attribution: { parent_turn_id: 'foreign' } },
      },
    ],
    [meta, { type: 'unrelated', payload: {} }],
    [meta, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }],
  ]) {
    await write(records);
    expect(
      await sessions.observeAuditTerminal(
        'attempt',
        native,
        f.proof,
        false,
        ['encrypted'],
        ['parent-turn'],
      ),
    ).toEqual({ outcome: 'unknown' });
  }
  await write([meta, started]);
  const withoutParent: AgentSession = { ...native };
  delete withoutParent.parent_id;
  for (const peer of [session, withoutParent])
    expect(
      await sessions.observeAuditTerminal(
        'attempt',
        peer,
        f.proof,
        false,
        ['encrypted'],
        ['parent-turn'],
      ),
    ).toEqual({ outcome: 'unknown' });
  for (const text of ['{', JSON.stringify(meta), '\n']) {
    await writeFile(path, text);
    expect(
      await sessions.observeAuditTerminal(
        'attempt',
        native,
        f.proof,
        false,
        ['encrypted'],
        ['parent-turn'],
      ),
    ).toEqual({ outcome: 'unknown' });
  }
  const second = {
    ...started,
    payload: {
      ...started.payload,
      turn_id: 'second',
      turn_attribution: { parent_turn_id: 'second-parent' },
    },
  };
  await write([meta, started, second]);
  rpc.request.mockResolvedValue({
    thread: {
      ...observation.thread,
      turns: [observation.thread.turns[0], { id: 'second', status: 'completed', items: [] }],
    },
  });
  expect(
    await sessions.observeAuditTerminal(
      'attempt',
      native,
      f.proof,
      false,
      ['encrypted-one', 'encrypted-two'],
      ['parent-turn', 'second-parent'],
    ),
  ).toMatchObject({ outcome: 'terminal', turn: 'second' });
  expect(rpc.request.mock.calls.every(([method]) => method === 'thread/read')).toBe(true);
});
