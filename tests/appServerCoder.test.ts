import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coderFixture } from './coderFixtures.js';
import { applyCoder, reserveCoder } from '../core/coder.js';
import type { CoderAction, CoderRun } from '../core/coder.js';
import { AppServerCoderSessions } from '../adapters/codex/appServerCoder.js';
import { TransportJournal, nativeCreationProof } from '../adapters/codex/transportJournal.js';
import type { AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { selectedProcedures } from '../core/localRun.js';
import { object } from '../core/connection.js';

let f: Awaited<ReturnType<typeof coderFixture>>;
let run: CoderRun;
let client: AppServerCoderSessions;
let directory: string, journal: string, transcript: string;
let serial: number;
let turns: Record<string, unknown>[];
let contexts: Record<string, unknown>[];
let loaded: boolean, mcp: unknown[], terminals: unknown[];
let lostCreation: boolean, lostSend: boolean, compacted: boolean, nextRunning: boolean;
let createCount: number, sendCount: number, resumeCount: number;
let response: Record<string, unknown>;
let beforeTurn: ReturnType<typeof vi.fn<() => Promise<void>>>;
let rpc: AppServerRpc;
const act = (action: CoderAction) => {
  run = applyCoder(run, { ...action, id: `${action.type}-${run.history.length}`, generation: 1 });
};
function thread() {
  return { ...object(response.thread), turns };
}
async function saveContexts() {
  const meta = {
    type: 'session_meta',
    payload: { id: 'sdk-coder', session_id: 'sdk-coder', cwd: run.brief.copy_root, source: 'cli' },
  };
  await writeFile(
    transcript,
    [meta, ...contexts].map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
}
beforeEach(async () => {
  f = await coderFixture();
  const brief = await f.brief();
  run = reserveCoder(f.executor, brief, await f.workspaces.capture(brief), []);
  act({ type: 'COPY_INTENT' });
  act({ type: 'COPIED', copy: await f.workspaces.copy(run) });
  act({ type: 'CREATE_INTENT' });
  directory = resolve(f.db.parent, 'native');
  await mkdir(directory);
  journal = resolve(directory, 'transport.jsonl');
  transcript = resolve(directory, 'native.jsonl');
  serial = 0;
  turns = [];
  contexts = [];
  loaded = true;
  mcp = [];
  terminals = [];
  lostCreation = false;
  lostSend = false;
  compacted = false;
  nextRunning = false;
  createCount = 0;
  sendCount = 0;
  resumeCount = 0;
  response = {
    thread: {
      id: 'sdk-coder',
      projectId: null,
      parentThreadId: null,
      forkedFromId: null,
      agentRole: null,
      turns: [],
      path: transcript,
    },
    cwd: brief.copy_root,
    model: brief.profile.model,
    reasoningEffort: brief.profile.effort,
    approvalPolicy: 'never',
    sandbox: {
      type: 'workspaceWrite',
      networkAccess: false,
      writableRoots: [brief.copy_root],
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    },
  };
  const transport = new TransportJournal(journal, 'coder:one:create');
  rpc = {
    completed: async (_session, id) => {
      const turn = turns.find((turn) => turn.id === id)!;
      if (turn.status === 'inProgress') turn.status = 'completed';
    },
    request: async (method, params) => {
      const id = ++serial,
        request = { id, method, params };
      transport.write('send', request, JSON.stringify(request));
      let result: unknown;
      if (method === 'mcpServerStatus/list') result = { data: mcp, nextCursor: null };
      else if (method === 'thread/start') {
        createCount++;
        result = structuredClone(response);
      } else if (method === 'thread/resume') {
        resumeCount++;
        loaded = true;
        result = { ...response, thread: thread() };
      } else if (method === 'thread/loaded/list')
        result = { data: loaded ? ['sdk-coder'] : [], nextCursor: null };
      else if (method === 'thread/read') result = { thread: thread() };
      else if (method === 'thread/backgroundTerminals/list')
        result = { data: terminals, nextCursor: null };
      else if (method === 'thread/backgroundTerminals/terminate') {
        terminals = [];
        result = {};
      } else if (method === 'turn/interrupt') {
        turns.find((turn) => turn.id === params.turnId)!.status = 'interrupted';
        result = {};
      } else if (method === 'turn/start') {
        sendCount++;
        const text = String(object((params.input as unknown[])[0]).text),
          marker = text.split('\n')[0]!;
        const delivery = JSON.parse(marker.slice('Workflow delivery id: '.length)) as string;
        const turnId = `turn-${sendCount}`;
        const items: Record<string, unknown>[] = [
          { type: 'userMessage', content: [{ type: 'text', text }] },
        ];
        contexts.push({
          type: 'turn_context',
          payload: {
            turn_id: turnId,
            cwd: run.brief.copy_root,
            model: run.brief.profile.model,
            effort: run.brief.profile.effort,
            approval_policy: 'never',
            sandbox_policy: {
              type: 'workspace-write',
              network_access: false,
              exclude_slash_tmp: true,
              exclude_tmpdir_env_var: true,
            },
            permission_profile: {
              type: 'managed',
              network: 'restricted',
              file_system: {
                type: 'restricted',
                entries: [
                  { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
                  { path: { type: 'path', path: run.brief.copy_root }, access: 'write' },
                ],
              },
            },
          },
        });
        if (delivery.endsWith(':load')) {
          const refs = [...selectedProcedures(run.writer!.spec), ...run.brief.rules];
          const lines = await Promise.all(
            refs.map(async (ref) => {
              const content = await readFile(resolve(run.brief.copy_root, ref.locator), 'utf8');
              return JSON.stringify({ path: ref.locator, sha256: digest(content), content });
            }),
          );
          items.push({ type: 'commandExecution', exitCode: 0, aggregatedOutput: lines.join('\n') });
        }
        if (delivery.endsWith(':implementation')) {
          await writeFile(resolve(run.brief.copy_root, 'source.txt'), 'native fixture after');
          if (compacted) items.push({ type: 'contextCompaction' });
          items.push({
            type: 'agentMessage',
            text: JSON.stringify({
              summary: 'fixture only',
              errors: [],
              limitations: ['not a native qualification'],
            }),
          });
        } else items.push({ type: 'agentMessage', text: 'fixture LOAD' });
        const turn = { id: turnId, status: nextRunning ? 'inProgress' : 'completed', items };
        nextRunning = false;
        turns.push(turn);
        await saveContexts();
        result = { turn };
      } else throw new Error(method);
      const frame = { id, result };
      transport.write('recv', frame, JSON.stringify(frame));
      if (method === 'thread/start' && lostCreation) throw new Error('creation reply lost');
      if (method === 'turn/start' && lostSend && sendCount === 3)
        throw new Error('send reply lost');
      return result;
    },
  };
  beforeTurn = vi.fn(async () => {});
  client = new AppServerCoderSessions(
    rpc,
    directory,
    journal,
    {
      descendants: async (roots) =>
        roots.map((pid) => ({ pid, parent: 2, started: 'fixture-start' })),
      alive: async () => [],
      terminate: async (ids) => ids,
      wait: async () => {},
    },
    (value) => f.workspaces.verifyCopy(value),
    await f.artifact('native-policy', {
      kind: 'fixture spawn only',
      runtime: { pid: 91, parent: 2, started: 'fixture-start' },
    }),
    beforeTurn,
  );
});
afterEach(async () => {
  await f.dispose();
  vi.unstubAllEnvs();
});
async function bind() {
  const created = await client.create(run);
  expect(created.outcome).toBe('created');
  if (created.outcome !== 'created') throw new Error('fixture did not create');
  act({ type: 'BIND', session: created.session });
}
async function load() {
  await bind();
  act({ type: 'LOAD_INTENT' });
  act({ type: 'LOADED', receipt: await client.load(run, true) });
}
async function send() {
  await load();
  act({ type: 'SEND_INTENT', delivery: 'coder:one:implementation' });
  act({ type: 'SENT', turn: await client.send(run, true) });
}
it('binds primary creation, observes full LOAD and actual profile, and stops its bound writer scope', async () => {
  const creating = run;
  await send();
  expect(createCount).toBe(1);
  expect(sendCount).toBe(3);
  expect(await client.recoverCreate(creating)).toMatchObject({
    outcome: 'created',
    session: { id: 'sdk-coder' },
  });
  expect(nativeCreationProof(journal, 'coder:one:create')!.source).toEqual(run.session!.receipt);
  expect((await client.result(run)).outcome).toBe('PASS');
  expect(await readFile(resolve(f.root, 'source.txt'), 'utf8')).toBe('source revision 1');
  const stopped = await client.stop(run);
  expect(stopped.hash).toHaveLength(64);
  expect(await client.stop(run)).toEqual(stopped);
  await client.stopOwned(run);
  await expect(client.create(creating)).rejects.toThrow('native-creation-already-attempted');
  expect(beforeTurn).toHaveBeenCalledTimes(4);
});
it('recovers a lost create and send by original primary identities without another native effect', async () => {
  const creating = run;
  lostCreation = true;
  await expect(client.create(run)).rejects.toThrow('creation reply lost');
  const recovered = await client.recoverCreate(creating);
  expect(recovered).toMatchObject({ outcome: 'created', session: { id: 'sdk-coder' } });
  if (recovered?.outcome !== 'created') throw new Error('fixture did not recover');
  act({ type: 'BIND', session: recovered.session });
  loaded = false;
  act({ type: 'LOAD_INTENT' });
  act({ type: 'LOADED', receipt: await client.load(run, false) });
  expect(resumeCount).toBe(1);
  expect(createCount).toBe(1);
  act({ type: 'SEND_INTENT', delivery: 'coder:one:implementation' });
  lostSend = true;
  await expect(client.send(run, true)).rejects.toThrow('send reply lost');
  const turn = await client.send(run, false);
  expect(turn).toBe('turn-3');
  expect(sendCount).toBe(3);
});
it('refuses before native create when external capabilities or ownership are unconfirmed', async () => {
  mcp = [{ name: 'external' }];
  const refused = await client.create(run);
  expect(refused.outcome).toBe('not-started');
  expect(createCount).toBe(0);
  mcp = [];
  expect((await client.create(run)).outcome).toBe('not-started');
  expect(createCount).toBe(0);
  expect(await client.recoverCreate(run)).toEqual(refused);
});
it('preserves an ownership refusal before native creation', async () => {
  beforeTurn.mockRejectedValueOnce(new Error('ownership changed'));
  expect((await client.create(run)).outcome).toBe('not-started');
  expect(createCount).toBe(0);
});

it('recovers no creation before an attempt and treats a non-Error preflight refusal conservatively', async () => {
  expect(await client.recoverCreate(run)).toBeNull();
  await client.stopOwned(run);
  beforeTurn.mockRejectedValueOnce('fixture unknown refusal');
  expect((await client.create(run)).outcome).toBe('not-started');
});
it.each([true, false])(
  'verifies an already saved creation policy, matching=%s',
  async (matching) => {
    const locator = resolve(f.db.parent, 'native-policy.json'),
      policy = { locator, hash: digest(await readFile(locator)) };
    await writeFile(
      resolve(directory, 'creation-policy.json'),
      matching
        ? canonical({ operation: 'coder:one:create', policy, brief: run.brief }) + '\n'
        : '{}',
    );
    const result = await client.create(run);
    expect(result.outcome).toBe(matching ? 'created' : 'not-started');
  },
);
it('accepts only disabled native capabilities from the exact process policy', async () => {
  const policy = await f.artifact('disabled-policy', { disabled_mcp_servers: ['computer-use'] });
  mcp = [
    {
      name: 'computer-use',
      runtimeStatus: 'disabled',
      pluginId: null,
      httpOrigin: null,
      serverInfo: null,
      serverCapabilities: null,
      toolsError: null,
      tools: {},
      resources: [],
      resourceTemplates: [],
    },
  ];
  client = new AppServerCoderSessions(
    rpc,
    directory,
    journal,
    {
      descendants: async () => [],
      alive: async () => [],
      terminate: async () => [],
      wait: async () => {},
    },
    (value) => f.workspaces.verifyCopy(value),
    policy,
    beforeTurn,
  );
  delete object(response.thread).agentRole;
  vi.stubEnv('PATH', undefined);
  expect((await client.create(run)).outcome).toBe('created');
  vi.unstubAllEnvs();
});
it('recovers a still-running delivered turn in the owning runtime without repeating delivery', async () => {
  await send();
  turns.at(-1)!.status = 'inProgress';
  const recovered = new AppServerCoderSessions(
    rpc,
    directory,
    journal,
    {
      descendants: async () => [],
      alive: async () => [],
      terminate: async () => [],
      wait: async () => {},
    },
    (value) => f.workspaces.verifyCopy(value),
    await f.artifact('recovered-policy', {}),
    beforeTurn,
  );
  expect((await recovered.result(run)).outcome).toBe('PASS');
  expect(sendCount).toBe(3);
});
it('observes the fresh, single implementation turn without starting, resuming or stopping it', async () => {
  await send();
  await expect(client.observeLiveWriter(run)).rejects.toThrow('coder-live-turn-unconfirmed');
  turns.at(-1)!.status = 'inProgress';
  const observation = await client.observeLiveWriter(run);
  expect(observation).toMatchObject({
    thread: 'sdk-coder',
    turn: run.turn,
    delivery: {
      delivery: run.delivery,
      attempts: 1,
      responses: 1,
      outcome: 'accepted',
    },
    runtime: { process: { pid: 91, parent: 2, started: 'fixture-start' } },
    processes: [],
  });
  expect(turns.at(-1)!.status).toBe('inProgress');
  expect(sendCount).toBe(3);
  expect(resumeCount).toBe(0);
});

it('rejects an unloaded writer, another live turn and an ambiguous implementation delivery', async () => {
  await expect(client.observeLiveWriter(run)).rejects.toThrow('coder-live-writer-unbound');
  await send();
  const writer = turns.at(-1)!;
  writer.status = 'inProgress';
  loaded = false;
  await expect(client.observeLiveWriter(run)).rejects.toThrow('coder-live-writer-unbound');
  loaded = true;
  turns[0]!.status = 'inProgress';
  await expect(client.observeLiveWriter(run)).rejects.toThrow('coder-live-turn-unconfirmed');
  turns.push({ ...writer, id: 'duplicated-delivery' });
  await expect(client.observeLiveWriter(run)).rejects.toThrow('coder-live-delivery-unconfirmed');
  expect(sendCount).toBe(3);
  expect(resumeCount).toBe(0);
});
it('preserves a profile failure in the candidate and stops a bound numeric background process', async () => {
  await send();
  object(object(contexts.at(-1)!.payload).permission_profile).network = 'enabled';
  await saveContexts();
  expect((await client.result(run)).outcome).toBe('FAIL');
  terminals = [{ processId: 'fixture-background', osPid: 71 }];
  expect((await client.stop(run)).hash).toHaveLength(64);
});
it('refuses unconfirmed profiles and inherited history after preserving the actual creation receipt', async () => {
  object(response.sandbox).excludeSlashTmp = false;
  await expect(client.create(run)).rejects.toThrow('coder-native-profile-unconfirmed');
  expect(nativeCreationProof(journal, 'coder:one:create')!.response).not.toBeNull();
  await expect(client.recoverCreate(run)).rejects.toThrow('coder-native-profile-unconfirmed');
});

it('waits for its newly started native turn before reading a materialized history', async () => {
  const completed = rpc.completed.bind(rpc);
  let materialized = false;
  rpc.completed = async (session, id) => {
    materialized = true;
    await completed(session, id);
  };
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method === 'thread/read' && !materialized) throw Error('list_turns is not supported yet');
    return request(method, params);
  };
  await load();
  expect(materialized).toBe(true);
  expect(run.writer!.loaded).not.toBeNull();
});
it('recovers an idle pre-dispatch stop failure with primary history and preserves its original refusal', async () => {
  await bind();
  const request = rpc.request.bind(rpc);
  let fail = true;
  rpc.request = async (method, params) => {
    if (method === 'thread/read' && fail) {
      fail = false;
      throw Error('fixture history unavailable');
    }
    return request(method, params);
  };
  await client.stopOwned(run);
  loaded = false;
  act({ type: 'LOAD_INTENT' });
  act({ type: 'LOADED', receipt: await client.load(run, false) });
  expect(resumeCount).toBe(1);
  expect(await readFile(resolve(directory, 'unconfirmed-stop.json'), 'utf8')).toContain(
    'sdk-coder',
  );
  expect(await readFile(resolve(directory, 'idle-stop-recovery.json'), 'utf8')).toContain(
    'coder-idle-stop-recovery',
  );
  const stopped = await client.stop(run);
  loaded = false;
  expect(await client.stop(run)).toEqual(stopped);
});
it('rejects extra native write roots before formal LOAD and refuses a premature copy edit', async () => {
  await bind();
  act({ type: 'LOAD_INTENT' });
  const unchanged = f.workspaces.verifyCopy.bind(f.workspaces);
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    const value = await request(method, params);
    if (method === 'turn/start') {
      const payload = object(contexts.at(-1)!.payload),
        profile = object(payload.permission_profile),
        fs = object(profile.file_system);
      (fs.entries as unknown[]).push({
        path: { type: 'special', value: { kind: 'slash_tmp' } },
        access: 'write',
      });
      await saveContexts();
    }
    return value;
  };
  await expect(client.load(run, true)).rejects.toThrow('coder-native-write-roots-unconfirmed');
  rpc.request = request;
  object(object(contexts[0]!.payload).permission_profile).network = 'enabled';
  await saveContexts();
  await expect(client.load(run, false)).rejects.toThrow('coder-native-profile-unconfirmed');
  expect(sendCount).toBe(1);
  object(object(contexts[0]!.payload).permission_profile).network = 'restricted';
  object(object(object(contexts[0]!.payload).permission_profile).file_system).entries = [
    { path: { type: 'path', path: run.brief.copy_root }, access: 'write' },
  ];
  await saveContexts();
  await writeFile(resolve(run.brief.copy_root, 'source.txt'), 'premature');
  await expect(unchanged(run)).rejects.toThrow('coder-premature-write');
});
it('does not accept compaction as a passing candidate', async () => {
  compacted = true;
  await send();
  const result = await client.result(run);
  expect(result.outcome).toBe('FAIL');
  expect(result.errors).toContain('coder-load-stale-or-compacted');
  await client.stop(run);
});
it.each([
  'failed-check',
  'unknown-check',
  'failed-turn',
  'invalid-result',
  'missing-summary',
  'invalid-errors',
  'invalid-limitations',
])('keeps %s from becoming PASS', async (kind) => {
  run.brief.checks = ['fixture-check'];
  await send();
  const turn = turns.at(-1)!,
    items = turn.items as Record<string, unknown>[];
  if (kind === 'failed-check' || kind === 'unknown-check')
    items.push({
      type: 'commandExecution',
      command: 'fixture-check',
      exitCode: kind === 'failed-check' ? 1 : null,
      aggregatedOutput: 'fixture check',
    });
  else if (kind === 'failed-turn') turn.status = 'failed';
  else if (kind === 'invalid-result') items.at(-1)!.text = 'invalid JSON';
  else {
    const result: Record<string, unknown> = { summary: 'fixture', errors: [], limitations: [] };
    if (kind === 'missing-summary') delete result.summary;
    if (kind === 'invalid-errors') result.errors = [null];
    if (kind === 'invalid-limitations') result.limitations = [null];
    items.at(-1)!.text = JSON.stringify(result);
  }
  expect((await client.result(run)).outcome).toBe('FAIL');
});
it('keeps an unconfirmed process scope unresolved after transport cleanup or an empty later inventory', async () => {
  await send();
  terminals = [{ processId: 'background', osPid: null }];
  await expect(client.stop(run)).rejects.toThrow('writer-process-binding-missing');
  await client.stopOwned(run);
  terminals = [];
  turns.push({
    id: 'foreign',
    status: 'completed',
    items: [{ type: 'userMessage', content: [{ type: 'text', text: 'foreign turn' }] }],
  });
  await expect(client.stop(run)).rejects.toThrow('coder-native-turns-unknown');
  turns.pop();
  await expect(client.stop(run)).rejects.toThrow('coder-stop-scope-unconfirmed');
});
it('rejects a late copy change after a confirmed stop receipt', async () => {
  await send();
  await client.stop(run);
  await writeFile(resolve(run.brief.copy_root, 'source.txt'), 'late write');
  await expect(client.stop(run)).rejects.toThrow('coder-stop-receipt-unconfirmed');
});
it('stops a confirmed idle created session and waits only for a running native turn', async () => {
  await bind();
  const stopped = await client.stop(run);
  expect(stopped.hash).toHaveLength(64);
  nextRunning = true;
  act({ type: 'LOAD_INTENT' });
  act({ type: 'LOADED', receipt: await client.load(run, true) });
  expect(sendCount).toBe(2);
});
it.each(['terminal-profile', 'tool-bearing-profile', 'active-profile'] as const)(
  'recovers only a terminal pre-product profile without tools: %s',
  async (kind) => {
    await bind();
    act({ type: 'LOAD_INTENT' });
    const request = rpc.request.bind(rpc);
    let lose = true;
    rpc.request = async (method, params) => {
      const value = await request(method, params);
      if (method === 'turn/start' && lose) {
        lose = false;
        throw Error('profile reply lost after acceptance');
      }
      return value;
    };
    await expect(client.load(run, true)).rejects.toThrow('profile reply lost after acceptance');
    expect(sendCount).toBe(1);
    if (kind === 'tool-bearing-profile')
      (turns[0]!.items as unknown[]).push({ type: 'commandExecution', exitCode: 0 });
    if (kind === 'active-profile') {
      turns[0]!.status = 'inProgress';
      rpc.completed = async () => {};
    }
    loaded = false;
    if (kind === 'terminal-profile') {
      act({ type: 'LOADED', receipt: await client.load(run, false) });
      expect(resumeCount).toBe(1);
      expect(sendCount).toBe(2);
    } else {
      await expect(client.load(run, false)).rejects.toThrow(
        kind === 'active-profile'
          ? 'coder-native-turn-not-terminal'
          : 'coder-writer-runtime-unbound',
      );
      expect(resumeCount).toBe(0);
      expect(sendCount).toBe(1);
    }
  },
);
it('accepts complete native inventories with an omitted optional cursor, including a cached stop', async () => {
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    const value = await request(method, params);
    if (method === 'thread/loaded/list' || method === 'thread/backgroundTerminals/list')
      delete object(value).nextCursor;
    return value;
  };
  await send();
  turns.at(-1)!.status = 'inProgress';
  expect((await client.observeLiveWriter(run)).turn).toBe(run.turn);
  const stopped = await client.stop(run);
  expect(await client.stop(run)).toEqual(stopped);
});
it('retains non-Error profile and stop failures without replacing an earlier unknown receipt', async () => {
  await send();
  const request = rpc.request.bind(rpc);
  let reads = 0;
  rpc.request = async (method, params) => {
    if (method === 'thread/read' && ++reads === 2) throw 'non-Error profile failure';
    return request(method, params);
  };
  expect((await client.result(run)).errors).toContain('coder-profile-unknown');
  rpc.request = async () => {
    throw 'non-Error stop failure';
  };
  await client.stopOwned(run);
  const path = resolve(directory, 'unconfirmed-stop.json'),
    first = await readFile(path, 'utf8');
  await client.stopOwned(run);
  expect(await readFile(path, 'utf8')).toBe(first);
});
it.each(['bound', 'changed-root', 'empty-tree', 'other-thread', 'invalid-root'] as const)(
  'binds an opaque terminal only to the observed dedicated runtime: %s',
  async (kind) => {
    const root = { pid: 91, parent: 2, started: 'fixture-sdk-start' },
      writer = { pid: 71, parent: 91, started: 'fixture-writer-start' };
    const policy = await f.artifact('runtime-policy', {
      runtime: kind === 'invalid-root' ? { ...root, pid: '91' } : root,
    });
    let stopped = false;
    client = new AppServerCoderSessions(
      rpc,
      directory,
      journal,
      {
        descendants: async (roots) =>
          roots.includes(root.pid)
            ? [
                kind === 'changed-root' ? { ...root, started: 'reused PID' } : root,
                ...(kind === 'empty-tree' || stopped ? [] : [writer]),
              ]
            : [writer],
        alive: async (ids) => ids.filter((id) => id.pid === root.pid || !stopped),
        terminate: async (ids) => {
          stopped = true;
          return ids;
        },
        wait: async () => {},
      },
      (value) => f.workspaces.verifyCopy(value),
      policy,
      beforeTurn,
    );
    await send();
    terminals = [
      {
        itemId: 'background-item',
        processId: 'opaque-terminal',
        osPid: null,
        cwd: run.brief.copy_root,
      },
    ];
    if (kind === 'bound') {
      const request = rpc.request.bind(rpc);
      rpc.request = async (method, params) => {
        const value = await request(method, params);
        if (method === 'thread/loaded/list') delete object(value).nextCursor;
        return value;
      };
    }
    if (kind === 'other-thread') {
      const request = rpc.request.bind(rpc);
      rpc.request = async (method, params) =>
        method === 'thread/loaded/list'
          ? { data: ['sdk-coder', 'foreign-thread'], nextCursor: null }
          : request(method, params);
    }
    if (kind === 'bound') {
      const receipt = await client.stop(run),
        proof = object(JSON.parse(await readFile(receipt.locator, 'utf8')) as unknown);
      expect(proof.processes).toEqual([writer]);
      expect(object(proof.owned).bindings).toMatchObject([
        { terminal: 'opaque-terminal', processes: [writer] },
      ]);
      expect(proof.processes).not.toContainEqual(root);
      expect(stopped).toBe(true);
    } else {
      await expect(client.stop(run)).rejects.toThrow(
        kind === 'changed-root'
          ? 'writer-process-identity-changed'
          : kind === 'other-thread'
            ? 'writer-runtime-list-incomplete'
            : 'writer-process-binding-missing',
      );
      expect(stopped).toBe(false);
    }
  },
);

it.each(['stopped', 'late-child', 'cached-child'] as const)(
  'observes SDK descendants with an empty terminal inventory: %s',
  async (kind) => {
    const root = { pid: 91, parent: 2, started: 'fixture-sdk-start' },
      writer = { pid: 71, parent: 91, started: 'fixture-writer-start' };
    let stopped = false,
      cachedChild = false;
    client = new AppServerCoderSessions(
      rpc,
      directory,
      journal,
      {
        descendants: async () => [
          root,
          ...(!stopped || kind === 'late-child' || cachedChild ? [writer] : []),
        ],
        alive: async (ids) => (stopped ? [] : ids),
        terminate: async (ids) => {
          expect(ids).toEqual([writer]);
          stopped = true;
          return ids;
        },
        wait: async () => {},
      },
      (value) => f.workspaces.verifyCopy(value),
      await f.artifact('empty-terminal-policy', { runtime: root }),
      beforeTurn,
    );
    await send();
    expect(terminals).toEqual([]);
    turns.at(-1)!.status = 'inProgress';
    expect(await client.observeLiveWriter(run)).toMatchObject({
      runtime: { process: root },
      processes: [writer],
    });
    if (kind === 'late-child') {
      await expect(client.stop(run)).rejects.toThrow('writers-still-active');
    } else {
      const receipt = await client.stop(run),
        proof = object(JSON.parse(await readFile(receipt.locator, 'utf8')) as unknown);
      expect(proof.processes).toEqual([writer]);
      expect(object(proof.owned).runtime).toMatchObject({ process: root });
      if (kind === 'cached-child') {
        cachedChild = true;
        await expect(client.stop(run)).rejects.toThrow('coder-stop-receipt-unconfirmed');
      }
    }
    expect(stopped).toBe(true);
  },
);

it.each(['stopped-runtime', 'live-runtime'] as const)(
  'reuses a cached stop in a replacement SDK only after the previous runtime is gone: %s',
  async (kind) => {
    await send();
    const receipt = await client.stop(run),
      previous = { pid: 91, parent: 2, started: 'fixture-start' },
      replacement = { pid: 92, parent: 2, started: 'replacement-start' };
    client = new AppServerCoderSessions(
      rpc,
      directory,
      journal,
      {
        descendants: async () => [replacement],
        alive: async (ids) =>
          kind === 'live-runtime' ? ids.filter((p) => p.pid === previous.pid) : [],
        terminate: async () => {
          throw Error('cached stop must not terminate another runtime');
        },
        wait: async () => {},
      },
      (value) => f.workspaces.verifyCopy(value),
      await f.artifact('replacement-policy', { runtime: replacement }),
      beforeTurn,
    );
    if (kind === 'live-runtime')
      await expect(client.stop(run)).rejects.toThrow('coder-stop-receipt-unconfirmed');
    else expect(await client.stop(run)).toEqual(receipt);
  },
);
it.each(['pid', 'parent', 'started'] as const)(
  'refuses a malformed cached runtime identity: %s',
  async (field) => {
    await send();
    const receipt = await client.stop(run),
      proof = object(JSON.parse(await readFile(receipt.locator, 'utf8')) as unknown),
      runtime = object(object(object(proof.owned).runtime).process);
    runtime[field] = null;
    await writeFile(receipt.locator, JSON.stringify(proof));
    await expect(client.stop(run)).rejects.toThrow('coder-stop-receipt-unconfirmed');
  },
);
