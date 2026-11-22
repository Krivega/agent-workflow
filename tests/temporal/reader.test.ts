import { readerExecution } from '../../src/policy/readerExecution.js';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { reserveTaskBackend, taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readerActivities } from '../../src/activities/reader.js';
import { artifactStore } from '../../src/adapters/artifacts/files.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { ReaderWorkflow } from '../../src/workflows/reader.js';
import type { ReaderInput } from '../../src/contracts/reader.js';
import { object } from '../../src/contracts/project.js';
import { readerLoadPrompt } from '../../src/adapters/codex/readerMessages.js';

const sdk = vi.hoisted(() => ({
  prepareProject: vi.fn(),
  createReader: vi.fn(),
  loadReader: vi.fn(),
  answerReader: vi.fn(),
}));
vi.mock('@temporalio/workflow', () => ({ proxyActivities: () => sdk }));
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-reader-')));
  roots.push(root);
  mkdirSync(join(root, 'tasks'));
  for (const path of ['RULES.md', 'reviewer.md', 'tasks/one.md'])
    writeFileSync(join(root, path), path);
  const project = {
    schemaVersion: 1 as const,
    projectId: 'neutral',
    workspaceId: 'main',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
    checks: ['syntax'],
  };
  const input: ReaderInput = {
    preparation: {
      schemaVersion: 1,
      taskId: 'one',
      project,
      hostId: 'mac',
      owner: 'user',
      generation: 1,
      revision: 1,
      card: 'tasks/one.md',
    },
    roleId: 'reviewer',
  };
  const registration = {
    project,
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    workspaceRoot: root,
    artifactRoot: join(root, 'artifacts'),
    commands: { syntax: { executable: 'node', args: [] } },
  };
  const response = {
    cwd: root,
    model: 'gpt-6.1-sol',
    reasoningEffort: 'medium',
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
    thread: {
      id: 'session',
      projectId: null,
      parentThreadId: null,
      forkedFromId: null,
      turns: [] as unknown[],
    },
  };
  let serial = 0;
  const turns: Record<string, unknown>[] = [];
  const rpc = {
    request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'thread/start' || method === 'thread/resume') return structuredClone(response);
      if (method === 'model/list')
        return {
          data: [
            { model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
          ],
        };
      if (method === 'thread/loaded/list') return { data: ['session'] };
      if (method === 'turn/start') {
        serial++;
        const prompt = (params.input as { text: string }[])[0]!.text;
        const marker = 'Пути и хеши: ';
        const start = prompt.indexOf(marker);
        const refs =
          start === -1
            ? []
            : (JSON.parse(
                prompt.slice(start + marker.length, prompt.indexOf('. Для больших', start)),
              ) as { path: string; sha256: string }[]);
        const items =
          refs.length > 0
            ? [
                {
                  type: 'commandExecution',
                  status: 'completed',
                  exitCode: 0,
                  aggregatedOutput: refs
                    .map((ref) =>
                      JSON.stringify({ ...ref, content: readFileSync(ref.path, 'utf8') }),
                    )
                    .join('\n'),
                },
              ]
            : [{ type: 'agentMessage', text: 'Finding with evidence' }];
        turns.push({
          id: String(serial),
          status: 'completed',
          items: [{ type: 'userMessage', content: [{ type: 'text', text: prompt }] }, ...items],
        });
        return { turn: { id: String(serial) } };
      }
      if (method === 'thread/read') return { thread: { id: 'session', turns } };
      throw new Error('unexpected-rpc');
    }),
    completed: vi.fn(async () => {}),
  };
  const profile = { model: 'gpt-6.1-sol', effort: 'medium', clientVersion: '0.154.0' };
  const create = () => readerActivities(registration, rpc, profile, join(root, 'effects'));
  const activities = create();
  const store = artifactStore(registration.artifactRoot);
  function save(value: unknown) {
    return store.publish(Buffer.from(JSON.stringify(value)));
  }
  return {
    root,
    input,
    registration,
    profile,
    response,
    rpc,
    turns,
    activities,
    store,
    save,
    create,
  };
}

describe('Temporal Codex reader activities', () => {
  it('refuses native dispatch if Git ownership changes while model discovery is pending', async () => {
    const f = fixture();
    execFileSync('git', ['init', '--quiet'], { cwd: f.root });
    declareBackendFixture(f.root);
    const home = taskBackendHome(f.root);
    mkdirSync(home);
    writeFileSync(
      join(home, 'backend-policy.json'),
      JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
    );
    reserveTaskBackend(f.root, {
      schemaVersion: 1,
      projectId: 'neutral',
      taskId: 'one',
      backend: 'temporal',
      cardName: 'one.md',
      origin: 'a'.repeat(64),
    });
    const activities = f.create();
    const prepared = await activities.prepareProject(f.input.preparation);
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'model/list') {
        renameSync(join(f.root, '.git'), join(f.root, '.git-old'));
        execFileSync('git', ['init', '--quiet'], { cwd: f.root });
      }
      return original(method, params);
    });
    await expect(activities.createReader(f.input, prepared)).rejects.toThrow(
      'backend-git-root-changed',
    );
    expect(f.rpc.request.mock.calls.some(([method]) => method === 'thread/start')).toBe(false);
  });
  it.each([1, 2, 3] as const)(
    'rechecks historical LOAD v%s without adding native supplements',
    async (version) => {
      const f = fixture(),
        prepared = await f.activities.prepareProject(f.input.preparation),
        session = await f.activities.createReader(f.input, prepared);
      const load = await f.activities.loadReader(f.input, prepared, session),
        proof = object(JSON.parse(f.store.read(load).toString()));
      const observed = object(proof.observed),
        message = object((object((observed.items as unknown[])[0]).content as unknown[])[0]);
      message.text = String(message.text).replace(
        readerLoadPrompt(proof.refs as { path: string; sha256: string }[], 4),
        readerLoadPrompt(proof.refs as { path: string; sha256: string }[], version),
      );
      if (version !== 3) delete proof.commandOutputs;
      if (version === 1) delete proof.promptVersion;
      else proof.promptVersion = version;
      f.turns[0] = observed;
      await expect(
        f.activities.answerReader(f.input, prepared, session, f.save(proof)),
      ).resolves.toBeDefined();
      expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
        2,
      );
    },
  );

  it('records and rechecks v4 native supplements while preserving the original empty RPC item', async () => {
    const f = fixture(),
      home = join(f.root, 'native-home'),
      path = join(home, 'sessions', 'rollout-session.jsonl');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    vi.stubEnv('CODEX_HOME', home);
    const nativeRequest = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      const response = await nativeRequest(method, params);
      return method === 'thread/read'
        ? {
            thread: {
              ...object(object(response).thread),
              path,
              cwd: f.root,
              model: f.profile.model,
              reasoningEffort: f.profile.effort,
              cliVersion: f.profile.clientVersion,
            },
          }
        : response;
    });
    f.rpc.completed.mockImplementationOnce(async () => {
      const turn = f.turns.at(-1)!,
        item = object((turn.items as unknown[])[1]);
      const output = item.aggregatedOutput;
      const command = 'literal approved fixture read';
      Object.assign(item, {
        id: 'native-command',
        cwd: f.root,
        source: 'unifiedExecStartup',
        commandActions: [{ type: 'unknown', command }],
        aggregatedOutput: null,
      });
      const records = [
        {
          type: 'session_meta',
          payload: { id: 'session', cwd: f.root, cli_version: f.profile.clientVersion },
        },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: turn.id } },
        {
          type: 'turn_context',
          payload: {
            turn_id: turn.id,
            cwd: f.root,
            model: f.profile.model,
            effort: f.profile.effort,
            approval_policy: 'never',
            sandbox_policy: { type: 'read-only' },
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            status: 'completed',
            name: 'exec',
            call_id: 'native-call',
            input: `text(await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:12000}));`,
            internal_chat_message_metadata_passthrough: { turn_id: turn.id },
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            thread_id: 'session',
            turn_id: turn.id,
            item: {
              type: 'CommandExecution',
              id: 'native-command',
              cwd: f.root,
              command: ['/bin/zsh', '-lc', command],
              status: 'completed',
              exit_code: 0,
              aggregated_output: '',
              source: 'unified_exec_startup',
            },
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'native-call',
            output: [{ type: 'input_text', text: JSON.stringify({ output, exit_code: 0 }) }],
            internal_chat_message_metadata_passthrough: { turn_id: turn.id },
          },
        },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } },
      ];
      writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    });
    const prepared = await f.activities.prepareProject(f.input.preparation),
      session = await f.activities.createReader(f.input, prepared);
    const load = await f.activities.loadReader(f.input, prepared, session),
      proof = object(JSON.parse(f.store.read(load).toString()));
    expect(proof.promptVersion).toBe(4);
    expect(proof.commandOutputs).not.toBeNull();
    expect(object((object(proof.observed).items as unknown[])[1]).aggregatedOutput).toBeNull();
    await expect(
      f.activities.answerReader(f.input, prepared, session, load),
    ).resolves.toBeDefined();
    const bad = f.save({ ...proof, commandOutputs: f.save({ kind: 'foreign' }) });
    await expect(f.activities.answerReader(f.input, prepared, session, bad)).rejects.toThrow();
    await expect(
      f.activities.answerReader(f.input, prepared, session, f.save({ ...proof, promptVersion: 9 })),
    ).rejects.toThrow('reader-load-prompt-version');
  });

  it('invalidates LOAD on native compaction and accepts only a fresh read in the same session', async () => {
    const f = fixture();
    const prepared = await f.activities.prepareProject(f.input.preparation);
    const session = await f.activities.createReader(f.input, prepared);
    const load = await f.activities.loadReader(f.input, prepared, session);
    f.turns.push({ id: 'compact', status: 'completed', items: [{ type: 'contextCompaction' }] });
    await expect(f.activities.answerReader(f.input, prepared, session, load)).rejects.toThrow(
      'reader-context-compacted:',
    );
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    const epoch = { permit: { sha256: 'a'.repeat(64), bytes: 1 }, revision: 1, attempt: 1 };
    const freshLoad = await f.activities.loadReader(f.input, prepared, session, epoch);
    await f.activities.answerReader(f.input, prepared, session, freshLoad, epoch);
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(
      1,
    );
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(3);
  });
  it.each(['load', 'answer'])(
    'rejects compaction during the %s turn even when a primary result exists',
    async (phase) => {
      const f = fixture();
      const prepared = await f.activities.prepareProject(f.input.preparation);
      const session = await f.activities.createReader(f.input, prepared);
      const load =
        phase === 'answer' ? await f.activities.loadReader(f.input, prepared, session) : null;
      f.rpc.completed.mockImplementationOnce(async () => {
        (f.turns.at(-1)!.items as unknown[]).push({ type: 'contextCompaction' });
      });
      await expect(
        phase === 'load'
          ? f.activities.loadReader(f.input, prepared, session)
          : f.activities.answerReader(f.input, prepared, session, load!),
      ).rejects.toThrow('reader-context-compacted:');
    },
  );
  it('fences every controlled stage and binds explicit attempts without replacing a session', async () => {
    const f = fixture(),
      gate = readerBoundary(
        join(f.root, 'permissions'),
        f.store,
        f.root,
        readerExecution(f.profile),
      );
    const permit = gate.install(f.input),
      epoch = { permit, revision: 0, attempt: 0 };
    const create = () =>
      readerActivities(
        f.registration,
        f.rpc,
        f.profile,
        join(f.root, 'controlled-effects'),
        gate.boundary,
      );
    const a = create(),
      prepared = await a.prepareProject(f.input.preparation);
    for (const bad of [undefined, { ...epoch, attempt: -1 }, { ...epoch, attempt: 0.5 }])
      await expect(a.createReader(f.input, prepared, bad)).rejects.toThrow('reader-epoch-required');
    const session = await a.createReader(f.input, prepared, epoch);
    const load = await a.loadReader(f.input, prepared, session, { ...epoch, attempt: 1 });
    await a.answerReader(f.input, prepared, session, load, { ...epoch, attempt: 1 });
    const prompts = f.rpc.request.mock.calls
      .filter(([m]) => m === 'turn/start')
      .map(([, p]) => (p.input as { text: string }[])[0]!.text);
    expect(prompts[0]).toContain('Workflow operation: reader-load-');
    expect(prompts[0]).not.toEqual(prompts[1]);
    gate.freeze(f.input, permit);
    for (const action of [
      () => a.createReader(f.input, prepared, epoch),
      () => a.loadReader(f.input, prepared, session, epoch),
      () => a.answerReader(f.input, prepared, session, load, epoch),
    ])
      await expect(action()).rejects.toThrow('reader-permit-revoked');
  });
  it('recovers a lost creation journal receipt from the durable native response only', async () => {
    const f = fixture(),
      gate = readerBoundary(
        join(f.root, 'permissions'),
        f.store,
        f.root,
        readerExecution(f.profile),
      ),
      permit = gate.install(f.input),
      epoch = { permit, revision: 0, attempt: 0 };
    const root = join(f.root, 'controlled-effects'),
      create = () => readerActivities(f.registration, f.rpc, f.profile, root, gate.boundary);
    const a = create(),
      prepared = await a.prepareProject(f.input.preparation),
      session = await a.createReader(f.input, prepared, epoch);
    const { readdirSync } = await import('node:fs');
    for (const name of readdirSync(root).filter((name) => name.endsWith('.receipt')))
      rmSync(join(root, name));
    expect(await create().createReader(f.input, prepared, epoch)).toEqual(session);
    expect(f.rpc.request.mock.calls.filter(([m]) => m === 'thread/start')).toHaveLength(1);
    const unknown = fixture(),
      none = readerBoundary(
        join(unknown.root, 'permissions'),
        unknown.store,
        unknown.root,
        readerExecution(unknown.profile),
      ),
      p = none.install(unknown.input);
    const primary = unknown.rpc.request.getMockImplementation()!;
    unknown.rpc.request.mockImplementation((method, params) =>
      method === 'thread/start' ? Promise.reject(new Error('lost')) : primary(method, params),
    );
    const fresh = () =>
      readerActivities(
        unknown.registration,
        unknown.rpc,
        unknown.profile,
        join(unknown.root, 'lost-effects'),
        none.boundary,
      );
    const prep = await fresh().prepareProject(unknown.input.preparation),
      e = { permit: p, revision: 0, attempt: 0 };
    await expect(fresh().createReader(unknown.input, prep, e)).rejects.toThrow('lost');
    await expect(fresh().createReader(unknown.input, prep, e)).rejects.toThrow(
      'effect-outcome-unknown',
    );
  });
  it('rejects a completed native result if its external permission changed during the turn', async () => {
    const f = fixture(),
      gate = readerBoundary(
        join(f.root, 'permissions'),
        f.store,
        f.root,
        readerExecution(f.profile),
      ),
      permit = gate.install(f.input),
      epoch = { permit, revision: 0, attempt: 0 };
    const a = readerActivities(
      f.registration,
      f.rpc,
      f.profile,
      join(f.root, 'controlled-effects'),
      gate.boundary,
    );
    const prepared = await a.prepareProject(f.input.preparation),
      session = await a.createReader(f.input, prepared, epoch);
    f.rpc.completed.mockImplementationOnce(async () => {
      gate.freeze(f.input, permit);
    });
    await expect(a.loadReader(f.input, prepared, session, epoch)).rejects.toThrow(
      'reader-permit-revoked',
    );
  });
  it('recovers a lost send response from the same primary turn after Activity restart', async () => {
    const f = fixture();
    const prepared = await f.activities.prepareProject(f.input.preparation);
    const session = await f.activities.createReader(f.input, prepared);
    const primary = f.rpc.request.getMockImplementation()!;
    let lose = true;
    f.rpc.request.mockImplementation(async (method, params) => {
      const response = await primary(method, params);
      if (method === 'turn/start' && lose) {
        lose = false;
        throw new Error('send response lost');
      }
      return response;
    });
    await expect(f.activities.loadReader(f.input, prepared, session)).rejects.toThrow(
      'send response lost',
    );
    const load = await f.create().loadReader(f.input, prepared, session);
    expect(f.store.read(load).toString()).toContain('reader-load');
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });
  it('does not repeat sends after lost completion and leaves an absent send unknown', async () => {
    const f = fixture();
    const prepared = await f.activities.prepareProject(f.input.preparation);
    const session = await f.activities.createReader(f.input, prepared);
    f.rpc.completed.mockRejectedValueOnce(new Error('completion lost'));
    await expect(f.activities.loadReader(f.input, prepared, session)).rejects.toThrow(
      'completion lost',
    );
    await f.create().loadReader(f.input, prepared, session);
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    const other = fixture();
    const otherPrepared = await other.activities.prepareProject(other.input.preparation);
    const otherSession = await other.activities.createReader(other.input, otherPrepared);
    const primary = other.rpc.request.getMockImplementation()!;
    other.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'turn/start') throw new Error('outcome unknown');
      return primary(method, params);
    });
    await expect(
      other.activities.loadReader(other.input, otherPrepared, otherSession),
    ).rejects.toThrow('outcome unknown');
    await expect(
      other.create().loadReader(other.input, otherPrepared, otherSession),
    ).rejects.toThrow('effect-outcome-unknown');
    expect(other.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
      1,
    );
  });
  it('supports the full declared role identifier and revision ranges', async () => {
    const f = fixture();
    f.input.roleId = 'r'.repeat(128);
    f.input.preparation.project.roles[0]!.id = f.input.roleId;
    f.input.preparation.revision = Number.MAX_SAFE_INTEGER;
    const activities = f.create();
    const prepared = await activities.prepareProject(f.input.preparation);
    expect((await activities.createReader(f.input, prepared)).id).toBe('session');
  });
  it('checks primary LOAD and returns a bound answer without repeating create/send on retry', async () => {
    const f = fixture();
    const prepared = await f.activities.prepareProject(f.input.preparation);
    const session = await f.activities.createReader(f.input, prepared);
    expect(await f.create().createReader(f.input, prepared)).toEqual(session);
    const load = await f.activities.loadReader(f.input, prepared, session);
    const answer = await f.activities.answerReader(f.input, prepared, session, load);
    expect(await f.create().answerReader(f.input, prepared, session, load)).toEqual(answer);
    expect(f.store.read(answer).toString()).toContain('Finding with evidence');
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(
      1,
    );
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2);
  });
  it('rejects unsupported clients and incomplete preparation before any model action', async () => {
    const f = fixture();
    expect(() =>
      readerActivities(
        f.registration,
        f.rpc,
        { ...f.profile, clientVersion: 'next' },
        join(f.root, 'effects'),
      ),
    ).toThrow('unsupported-codex-client');
    const prepared = await f.activities.prepareProject(f.input.preparation);
    await expect(
      f.activities.createReader({ ...f.input, roleId: 'other' }, prepared),
    ).rejects.toThrow('reader-role-not-declared');
    for (const manifest of [
      { kind: 'other' },
      { kind: 'preparation', input: {} },
      { kind: 'preparation', input: f.input.preparation, inputs: null },
    ]) {
      await expect(
        f.activities.createReader(f.input, { status: 'prepared', manifest: f.save(manifest) }),
      ).rejects.toThrow();
    }
    writeFileSync(join(f.root, 'RULES.md'), 'changed');
    await expect(f.activities.createReader(f.input, prepared)).rejects.toThrow(
      'reader-input-changed',
    );
    expect(f.rpc.request).not.toHaveBeenCalled();
  });
  it.each([
    { model: 'other' },
    { reasoningEffort: 'high' },
    { cwd: '/other' },
    { approvalPolicy: 'on-request' },
    { sandbox: { type: 'workspaceWrite', networkAccess: false } },
    { sandbox: { type: 'readOnly', networkAccess: true } },
    { thread: { forkedFromId: 'old' } },
    { thread: { projectId: 'other' } },
    { thread: { parentThreadId: 'other' } },
    { thread: { turns: null } },
    { thread: { turns: [{ status: 'inProgress' }] } },
    { thread: { turns: [{ status: 'completed' }] } },
  ])('rejects a wrong effective profile, history or isolation', async (override) => {
    const f = fixture();
    const prepared = await f.activities.prepareProject(f.input.preparation);
    const changed = {
      ...f.response,
      ...override,
      thread: { ...f.response.thread, ...override.thread },
    };
    f.rpc.request.mockResolvedValueOnce({
      data: [
        {
          model: f.profile.model,
          supportedReasoningEfforts: [{ reasoningEffort: f.profile.effort }],
        },
      ],
    });
    f.rpc.request.mockResolvedValueOnce(changed);
    await expect(f.activities.createReader(f.input, prepared)).rejects.toThrow();
  });
  it('rejects swapped session/LOAD receipts and unfinished or missing primary answers', async () => {
    const f = fixture();
    const prepared = await f.activities.prepareProject(f.input.preparation);
    const session = await f.activities.createReader(f.input, prepared);
    const creation = JSON.parse(f.store.read(session.creation).toString()) as Record<
      string,
      unknown
    >;
    for (const bad of [
      { ...creation, kind: 'other' },
      { ...creation, input: {} },
      { ...creation, prepared: {} },
    ]) {
      await expect(
        f.activities.loadReader(f.input, prepared, { ...session, creation: f.save(bad) }),
      ).rejects.toThrow('reader-creation-binding-mismatch');
    }
    await expect(
      f.activities.loadReader(f.input, prepared, { ...session, id: 'other' }),
    ).rejects.toThrow('reader-session-mismatch');
    f.rpc.request.mockResolvedValueOnce({
      ...f.response,
      thread: { ...f.response.thread, id: 'other' },
    });
    await expect(f.create().loadReader(f.input, prepared, session)).rejects.toThrow(
      'reader-session-mismatch',
    );
    const load = await f.activities.loadReader(f.input, prepared, session);
    const proof = JSON.parse(f.store.read(load).toString()) as Record<string, unknown>;
    for (const bad of [
      { ...proof, kind: 'other' },
      { ...proof, session: 'other' },
      { ...proof, roleId: 'other' },
      { ...proof, prepared: {} },
      { ...proof, refs: [] },
    ]) {
      await expect(
        f.activities.answerReader(f.input, prepared, session, f.save(bad)),
      ).rejects.toThrow('reader-load-binding-mismatch');
    }
    await f.activities.answerReader(f.input, prepared, session, load);
    f.turns[1]!.items = [
      { type: 'agentMessage', text: '' },
      { type: 'commandExecution' },
      { type: 'agentMessage', text: null },
    ];
    await expect(f.activities.answerReader(f.input, prepared, session, load)).rejects.toThrow(
      'reader-answer-missing',
    );
    f.turns[1]!.items = null;
    await expect(f.activities.answerReader(f.input, prepared, session, load)).rejects.toThrow(
      'reader-context-unknown',
    );
    f.turns[1]!.items = [];
    f.turns[1]!.status = 'inProgress';
    await expect(f.activities.answerReader(f.input, prepared, session, load)).rejects.toThrow(
      'reader-turn-unconfirmed',
    );
    f.turns.splice(1);
    await expect(f.activities.answerReader(f.input, prepared, session, load)).rejects.toThrow(
      'reader-turn-unconfirmed',
    );
  });
  it('preserves unknown create/send outcomes across Activity retries', async () => {
    const f = fixture();
    const prepared = await f.activities.prepareProject(f.input.preparation);
    f.rpc.request.mockResolvedValueOnce({
      data: [
        {
          model: f.profile.model,
          supportedReasoningEfforts: [{ reasoningEffort: f.profile.effort }],
        },
      ],
    });
    f.rpc.request.mockRejectedValueOnce(new Error('lost create response'));
    await expect(f.activities.createReader(f.input, prepared)).rejects.toThrow(
      'lost create response',
    );
    await expect(f.create().createReader(f.input, prepared)).rejects.toThrow(
      'effect-outcome-unknown',
    );
    expect(f.rpc.request).toHaveBeenCalledTimes(3);
  });
  it.each([
    { data: null },
    { data: [] },
    { data: [{ model: 'other' }] },
    { data: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: null }] },
    { data: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] },
  ])('rejects unavailable models/efforts before creating any session', async (models) => {
    const f = fixture();
    const prepared = await f.activities.prepareProject(f.input.preparation);
    f.rpc.request.mockResolvedValueOnce(models);
    await expect(f.activities.createReader(f.input, prepared)).rejects.toThrow(
      'reader-model-unavailable',
    );
    expect(
      f.rpc.request.mock.calls.filter(
        ([method]) => method === 'thread/start' || method === 'turn/start',
      ),
    ).toHaveLength(0);
  });
  it.each([{ data: null }, { data: [] }])(
    'requires the original live connection before the first turn',
    async (loaded) => {
      const f = fixture();
      const prepared = await f.activities.prepareProject(f.input.preparation);
      const session = await f.activities.createReader(f.input, prepared);
      f.rpc.request.mockResolvedValueOnce(loaded);
      await expect(f.activities.loadReader(f.input, prepared, session)).rejects.toThrow(
        'reader-fresh-session-unconfirmed',
      );
      expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
        0,
      );
    },
  );
  it('has Temporal schedule every read boundary without a local lifecycle store', async () => {
    const input = fixture().input;
    sdk.prepareProject.mockResolvedValue('prepared');
    sdk.createReader.mockResolvedValue('session');
    sdk.loadReader.mockResolvedValue('load');
    sdk.answerReader.mockResolvedValue('answer');
    expect(await ReaderWorkflow(input)).toEqual({ status: 'answered', answer: 'answer' });
    expect(sdk.answerReader).toHaveBeenCalledWith(input, 'prepared', 'session', 'load');
  });
});
