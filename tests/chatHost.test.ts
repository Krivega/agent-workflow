import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import {
  FileCurrentChatHost,
  chatPath,
  isSupportedChatClientVersion,
} from '../adapters/codex/currentChatHost.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { startLocalRun } from '../core/localRun.js';
import { localFixture } from './localFixtures.js';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
let f: Awaited<ReturnType<typeof localFixture>>;
beforeEach(async () => {
  f = await localFixture();
});
afterEach(async () => {
  await f.dispose();
});
async function hostFixture(clientVersion = '0.162.0-alpha.17.2') {
  const anchor = {
    thread_id: 'session',
    turn_id: 'turn',
    host_id: 'local' as const,
    workspace: f.root,
  };
  const session = {
    id: 'session',
    session_id: 'session',
    cli_version: clientVersion,
    cwd: f.root,
  };
  const turn = {
    turn_id: 'turn',
    cwd: f.root,
    model: 'fixture-model',
    effort: 'high',
    approval_policy: 'never',
    sandbox_policy: { type: 'danger-full-access' },
    permission_profile: { type: 'disabled' },
  };
  const reads = [...f.loaded.procedures, ...f.loaded.rules].map((entry) => ({
    chat_read: 'marker',
    locator: entry.locator,
    hash: entry.hash,
    content: entry.content,
  }));
  const item: {
    id?: string;
    type: string;
    cwd: string;
    status: string;
    exit_code: number;
    aggregated_output: string;
  } = {
    type: 'CommandExecution',
    cwd: 'file://' + f.root,
    status: 'completed',
    exit_code: 0,
    aggregated_output: 'output\n' + reads.map((r) => JSON.stringify(r)).join('\n'),
  };
  const payload = { type: 'item_completed', thread_id: 'session', turn_id: 'turn', item };
  const records: { type: string; payload: Record<string, unknown> }[] = [
    { type: 'session_meta', payload: session },
    { type: 'turn_context', payload: turn },
    { type: 'event_msg', payload: { type: 'other' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Other' } } },
    { type: 'event_msg', payload },
  ];
  const save = async () =>
    f.file('transcript.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await save();
  const host = new FileCurrentChatHost(f.root, resolve(f.root, 'transcript.jsonl'), anchor);
  const run = startLocalRun({ ...f.spec, host_id: 'local' }, 1);
  return { host, run, anchor, session, turn, payload, item, records, reads, save };
}

async function continuationFixture() {
  const h = await hostFixture();
  h.anchor.turn_id = 'next';
  h.records.splice(1, 0, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } });
  h.records.push(
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } },
    { type: 'turn_context', payload: { ...h.turn, turn_id: 'next' } },
  );
  return h;
}

async function worktreeHostFixture() {
  const h = await hostFixture('0.165.0-alpha.1.2');
  const origin = resolve(f.root, 'origin'),
    workspace = resolve(f.root, 'checkout'),
    common = resolve(origin, '.git'),
    gitdir = resolve(common, 'worktrees/checkout');
  await mkdir(gitdir, { recursive: true });
  await mkdir(workspace);
  await writeFile(resolve(workspace, '.git'), `gitdir: ${gitdir}\n`);
  await writeFile(resolve(gitdir, 'commondir'), '../..\n');
  await writeFile(resolve(gitdir, 'gitdir'), resolve(workspace, '.git') + '\n');
  Object.assign(h.session, {
    cwd: origin,
    source: 'vscode',
    originator: 'codex_work_desktop',
    thread_source: 'user',
  });
  h.turn.cwd = workspace;
  h.anchor.workspace = workspace;
  h.host = new FileCurrentChatHost(workspace, resolve(f.root, 'transcript.jsonl'), h.anchor);
  await h.save();
  return { ...h, origin, workspace, common, gitdir };
}

const desktop166 = {
  cli_version: '0.166.0-alpha.6',
  source: 'vscode',
  originator: 'codex_work_desktop',
  thread_source: 'user',
};

it('accepts CLI 0.169.1 for an independent council peer in its own workspace', async () => {
  const h = await hostFixture('0.169.1');
  Object.assign(h.session, { source: 'vscode', originator: 'Codex Desktop' });
  await h.save();
  const peer = new FileCurrentChatHost(
    f.root,
    resolve(f.root, 'transcript.jsonl'),
    h.anchor,
    undefined,
    true,
  );
  await expect(peer.observe()).resolves.toMatchObject({ client_version: '0.169.1' });
  await expect(h.host.observe()).rejects.toThrow('chat-client-unsupported');
  Object.assign(h.session, { originator: 'unknown' });
  await h.save();
  await expect(peer.observe()).rejects.toThrow('chat-client-unsupported');
  Object.assign(h.session, { originator: 'Codex Desktop', cwd: resolve(f.root, 'other') });
  await h.save();
  await expect(peer.observe()).rejects.toThrow('chat-client-unsupported');
});

it.each([
  ['plain', undefined, undefined],
  ['ordinary tool result', 'function', undefined],
  ['invalid metadata', undefined, null],
  ['missing metadata', undefined, undefined],
  ['different metadata', undefined, { unrelated: true }],
  ['other turn', undefined, { turn_id: 'later' }],
  ['created chat', undefined, { turn_id: 'turn' }],
  ['message from another chat', undefined, { turn_id: 'turn' }],
] as const)(
  'checks the exact same-root .166 Desktop user journal with %s',
  async (kind, callId, metadata) => {
    const h = await hostFixture(desktop166.cli_version);
    Object.assign(h.session, desktop166);
    const reply = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Exact fixture authorization' }],
      },
    };
    h.records.splice(
      1,
      0,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      reply,
    );
    if (kind !== 'plain') {
      h.records.splice(kind === 'created chat' ? 2 : 4, 0, {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: kind === 'created chat' ? 'create_thread' : 'send_message_to_thread',
          call_id: callId,
          internal_chat_message_metadata_passthrough: metadata,
        },
      });
    }
    await h.save();
    expect(isSupportedChatClientVersion(desktop166.cli_version)).toBe(false);
    await expect(h.host.observe()).resolves.toMatchObject({
      client_version: desktop166.cli_version,
      workspace: f.root,
    });
    const message = h.host.message(
      {
        locator: resolve(f.root, 'transcript.jsonl') + (kind === 'created chat' ? '#L4' : '#L3'),
        hash: contentHash(JSON.stringify(reply) + '\n'),
      },
      'turn',
    );
    if (kind === 'created chat' || kind === 'message from another chat')
      await expect(message).rejects.toThrow('chat-human-message-delegated');
    else await expect(message).resolves.toEqual({ thread_id: 'session', turn_id: 'turn' });
  },
);

it.each([
  { cli_version: '0.166.0-alpha.7' },
  { source: 'cli' },
  { originator: 'other' },
  { thread_source: 'subagent' },
  { forked_from_id: 'foreign' },
  { forked_from_id: null },
  { parent_thread_id: 'foreign' },
])('rejects an unobserved .166 Desktop session shape %j', async (metadata) => {
  const h = await hostFixture(desktop166.cli_version);
  Object.assign(h.session, desktop166, metadata);
  await h.save();
  await expect(h.host.observe()).rejects.toThrow('chat-client-unsupported');
});

it('observes a delegated Desktop destination and keeps the human source unavailable', async () => {
  const h = await hostFixture('0.169.0-alpha.11.1');
  Object.assign(h.session, {
    ...desktop166,
    cli_version: h.session.cli_version,
    thread_source: 'agent_created_thread',
  });
  Object.assign(h.turn, { root_turn_id: 'sender-turn' });
  await h.save();
  const host = new FileCurrentChatHost(
    f.root,
    resolve(f.root, 'transcript.jsonl'),
    h.anchor,
    null,
    false,
    { senderTurn: 'sender-turn' },
  );
  expect((await host.observe()).thread_id).toEqual(h.anchor.thread_id);
  await expect(host.message({ locator: 'missing', hash: '0'.repeat(64) })).rejects.toThrow(
    'chat-human-message-delegated',
  );
});

it.each([
  ['direct', null],
  ['default host', 'chat-client-unsupported'],
  ['adjacent version', 'chat-client-unsupported'],
  ['fork', 'chat-client-unsupported'],
  ['subagent', 'chat-client-unsupported'],
  ['other originator', 'chat-client-unsupported'],
  ['other workspace', 'chat-comparison-origin-unconfirmed'],
  ['different root turn', 'chat-comparison-origin-unconfirmed'],
  ['duplicate context', 'chat-comparison-origin-unconfirmed'],
  ['compact replay', null],
  ['compact foreign', 'chat-comparison-origin-unconfirmed'],
  ['compact changed', 'chat-comparison-origin-unconfirmed'],
  ['compact partial', 'chat-comparison-origin-unconfirmed'],
  ['compact missing world', 'chat-comparison-origin-unconfirmed'],
  ['wrong source turn', 'chat-comparison-human-unconfirmed'],
  ['other metadata turn', 'chat-comparison-human-unconfirmed'],
  ['missing metadata', 'invalid-object'],
  ['harness content', 'chat-comparison-human-unconfirmed'],
  ['harness provenance', 'chat-comparison-human-unconfirmed'],
  ['extra content', 'chat-comparison-human-unconfirmed'],
  ['inbound delivery', 'chat-human-message-delegated'],
])('verifies comparison Desktop .169 origin: %s', async (kind, error) => {
  const h = await hostFixture('0.169.0-alpha.11.1');
  Object.assign(h.session, { ...desktop166, cli_version: h.session.cli_version });
  Object.assign(h.turn, { root_turn_id: kind === 'different root turn' ? 'foreign' : 'turn' });
  if (kind === 'adjacent version') h.session.cli_version = '0.169.0-alpha.11.2';
  if (kind === 'fork') Object.assign(h.session, { forked_from_id: null });
  if (kind === 'subagent') Object.assign(h.session, { thread_source: 'subagent' });
  if (kind === 'other originator') Object.assign(h.session, { originator: 'other' });
  if (kind === 'other workspace') h.session.cwd = resolve(f.root, 'elsewhere');
  if (kind === 'duplicate context') h.records.push({ type: 'turn_context', payload: h.turn });
  const turn = kind === 'wrong source turn' ? 'older' : 'turn';
  const reply = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: Array.from({ length: kind === 'extra content' ? 2 : 1 }, () => ({
        type: 'input_text',
        text: 'Direct instruction',
      })),
      internal_chat_message_metadata_passthrough:
        kind === 'missing metadata'
          ? undefined
          : {
              turn_id: kind === 'other metadata turn' ? 'foreign' : turn,
              content_item_kinds: [
                kind === 'harness content' ? 'agents_md.instructions' : 'user.text',
              ],
              content_item_metadata: [
                { provenance: { type: kind === 'harness provenance' ? 'harness' : 'user' } },
              ],
            },
    },
  };
  h.records.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } }, reply);
  const source = {
    locator: resolve(f.root, 'transcript.jsonl') + '#L' + h.records.length,
    hash: contentHash(JSON.stringify(reply) + '\n'),
  };
  if (kind.startsWith('compact ')) {
    h.records.push({
      type: 'compacted',
      payload: {
        resume_metadata: { last_started_turn_id: kind === 'compact foreign' ? 'foreign' : turn },
      },
    });
    h.records.push({
      type: kind === 'compact missing world' ? 'event_msg' : 'world_state',
      payload: { full: kind !== 'compact partial' },
    });
    h.records.push({
      type: 'turn_context',
      payload: { ...h.turn, ...(kind === 'compact changed' ? { model: 'other' } : {}) },
    });
  }
  if (kind === 'inbound delivery')
    h.records.push({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        namespace: 'codex_app',
        name: 'send_message_to_thread',
        internal_chat_message_metadata_passthrough: { turn_id: turn },
      },
    });
  await h.save();
  const host =
    kind === 'default host'
      ? h.host
      : new FileCurrentChatHost(
          f.root,
          resolve(f.root, 'transcript.jsonl'),
          h.anchor,
          null,
          false,
          true,
        );
  const result = host.message(source, turn);
  if (error === null)
    await expect(result).resolves.toEqual({ thread_id: 'session', turn_id: 'turn' });
  else await expect(result).rejects.toThrow(error);
});

it('does not qualify .166 for a moved workspace even when Git confirms the worktree', async () => {
  const h = await worktreeHostFixture();
  Object.assign(h.session, desktop166);
  await h.save();
  await expect(h.host.observe()).rejects.toThrow('chat-workspace-mismatch');
});

it('observes the desktop registered worktree without replacing its original session workspace', async () => {
  const h = await worktreeHostFixture();
  h.records.push(
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Exact new task authorization fixture' }],
      },
    },
  );
  await h.save();
  const source = {
    locator: resolve(f.root, 'transcript.jsonl') + '#L' + h.records.length,
    hash: contentHash(JSON.stringify(h.records.at(-1)) + '\n'),
  };
  expect(await h.host.observe()).toMatchObject({
    workspace: h.workspace,
    client_version: '0.165.0-alpha.1.2',
    permission_profile: 'disabled',
  });
  expect(h.session.cwd).toBe(h.origin);
  await expect(h.host.reference(source)).resolves.toBeUndefined();
  await expect(h.host.message(source, 'turn')).resolves.toEqual({
    thread_id: 'session',
    turn_id: 'turn',
  });
  await expect(h.host.load(h.run, 'marker')).rejects.toThrow('chat-run-mismatch');
});

it('accepts reciprocal relative worktree pointers from either registered checkout', async () => {
  const h = await worktreeHostFixture();
  await writeFile(resolve(h.workspace, '.git'), 'gitdir: ../origin/.git/worktrees/checkout');
  await writeFile(resolve(h.gitdir, 'commondir'), '../..');
  await writeFile(resolve(h.gitdir, 'gitdir'), '../../../../checkout/.git');
  Object.assign(h.session, { forked_from_id: null });
  expect((await h.host.observe()).workspace).toBe(h.workspace);
  h.session.cwd = h.workspace;
  h.turn.cwd = h.origin;
  h.anchor.workspace = h.origin;
  await h.save();
  const host = new FileCurrentChatHost(h.origin, resolve(f.root, 'transcript.jsonl'), h.anchor);
  expect((await host.observe()).workspace).toBe(h.origin);
});

it('preserves normalized native workspace locators without rewriting their primary values', async () => {
  const h = await worktreeHostFixture();
  h.session.cwd = h.origin + '/../origin';
  h.turn.cwd = h.workspace + '/.';
  await h.save();
  expect((await h.host.observe()).workspace).toBe(h.workspace);
  expect(h.session.cwd).toBe(h.origin + '/../origin');
  expect(h.turn.cwd).toBe(h.workspace + '/.');
});

it('preserves the latest FileHost context observation for worktree and same-root sources', async () => {
  const h = await worktreeHostFixture();
  h.records.push({ type: 'turn_context', payload: { ...h.turn } });
  await h.save();
  expect((await h.host.observe()).workspace).toBe(h.workspace);
  h.session.cwd = h.workspace;
  await h.save();
  expect((await h.host.observe()).workspace).toBe(h.workspace);
});

it.each([
  'old-version',
  'native-version',
  'future-version',
  'wrong-source',
  'wrong-originator',
  'subagent',
  'fork',
  'session-id',
  'native-session-id',
  'turn-id',
  'turn-workspace',
  'anchor-workspace',
  'root-alias',
  'origin-alias',
  'foreign-repository',
  'missing-git',
  'git-alias',
  'git-hardlink',
  'git-directory-alias',
  'invalid-pointer',
  'missing-common',
  'unregistered-worktree',
  'wrong-backpointer',
  'linked-origin-backpointer',
])('refuses unproved desktop worktree identity: %s', async (kind) => {
  const h = await worktreeHostFixture();
  if (kind === 'old-version') h.session.cli_version = '0.164.0-alpha.11.1';
  if (kind === 'native-version') h.session.cli_version = '0.154.0';
  if (kind === 'future-version') h.session.cli_version = '0.166.0';
  if (kind === 'wrong-source') Object.assign(h.session, { source: 'cli' });
  if (kind === 'wrong-originator') Object.assign(h.session, { originator: 'foreign' });
  if (kind === 'subagent') Object.assign(h.session, { thread_source: 'subagent' });
  if (kind === 'fork') Object.assign(h.session, { forked_from_id: 'parent' });
  if (kind === 'session-id') h.session.id = 'foreign';
  if (kind === 'native-session-id') h.session.session_id = 'foreign';
  if (kind === 'turn-id') h.turn.turn_id = 'foreign';
  if (kind === 'turn-workspace') h.turn.cwd = h.origin;
  if (kind === 'anchor-workspace') h.anchor.workspace = h.origin;
  if (kind === 'root-alias') {
    const alias = resolve(f.root, 'root-alias');
    fs.symlinkSync(h.workspace, alias);
    h.host = new FileCurrentChatHost(alias, resolve(f.root, 'transcript.jsonl'), h.anchor);
  }
  if (kind === 'origin-alias') {
    h.session.cwd = resolve(f.root, 'origin-alias');
    fs.symlinkSync(h.origin, h.session.cwd);
  }
  if (kind === 'foreign-repository') {
    h.session.cwd = resolve(f.root, 'foreign');
    await mkdir(resolve(h.session.cwd, '.git'), { recursive: true });
  }
  if (kind === 'missing-git') fs.unlinkSync(resolve(h.workspace, '.git'));
  if (kind === 'git-alias' || kind === 'git-hardlink') {
    const path = resolve(h.workspace, '.git');
    fs.renameSync(path, path + '-original');
    if (kind === 'git-alias') fs.symlinkSync(path + '-original', path);
    else fs.linkSync(path + '-original', path);
  }
  if (kind === 'git-directory-alias') {
    fs.renameSync(h.common, h.common + '-original');
    fs.symlinkSync(h.common + '-original', h.common);
  }
  if (kind === 'invalid-pointer') await writeFile(resolve(h.workspace, '.git'), h.gitdir);
  if (kind === 'missing-common') fs.unlinkSync(resolve(h.gitdir, 'commondir'));
  if (kind === 'unregistered-worktree') {
    const moved = resolve(h.common, 'unregistered');
    fs.renameSync(h.gitdir, moved);
    await writeFile(resolve(moved, 'commondir'), '..\n');
    await writeFile(resolve(h.workspace, '.git'), `gitdir: ${moved}\n`);
  }
  if (kind === 'wrong-backpointer') await writeFile(resolve(h.gitdir, 'gitdir'), h.common + '\n');
  if (kind === 'linked-origin-backpointer') {
    h.session.cwd = h.workspace;
    h.turn.cwd = h.origin;
    h.anchor.workspace = h.origin;
    h.host = new FileCurrentChatHost(h.origin, resolve(f.root, 'transcript.jsonl'), h.anchor);
    await writeFile(resolve(h.gitdir, 'gitdir'), h.common + '\n');
  }
  await h.save();
  await expect(h.host.observe()).rejects.toThrow();
});

it.each(['empty', 'multiline', 'invalid-utf8', 'nul', 'oversized', 'directory'])(
  'refuses malformed Git metadata before treating it as a worktree: %s',
  async (kind) => {
    const h = await worktreeHostFixture();
    const path = resolve(h.gitdir, 'commondir');
    if (kind === 'empty') await writeFile(path, '');
    if (kind === 'multiline') await writeFile(path, '../..\nforeign\n');
    if (kind === 'invalid-utf8') await writeFile(path, Buffer.from([0xff]));
    if (kind === 'nul') await writeFile(path, '../..\0');
    if (kind === 'oversized') await writeFile(path, 'x'.repeat(8193));
    if (kind === 'directory') {
      fs.unlinkSync(path);
      await mkdir(path);
    }
    await expect(h.host.observe()).rejects.toThrow('chat-worktree-unconfirmed');
  },
);

it('accepts the observed 0.154 native LOAD event envelope with the existing chat-read protocol', async () => {
  const h = await hostFixture('0.154.0');
  Object.assign(h.session, { source: 'vscode', originator: 'Codex Desktop' });
  Object.assign(h.turn, {
    sandbox_policy: { type: 'read-only' },
    permission_profile: {
      type: 'managed',
      file_system: {
        type: 'restricted',
        entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }],
      },
      network: 'restricted',
    },
  });
  Object.assign(h.payload, { started_at_ms: 1000, completed_at_ms: 2000 });
  Object.assign(h.item, {
    id: 'command',
    process_id: null,
    command: ['/bin/zsh', '-lc', 'read-only LOAD fixture'],
    parsed_cmd: [],
    source: 'unified_exec_startup',
    stdout: h.item.aggregated_output,
    stderr: '',
    duration: { secs: 1, nanos: 0 },
    formatted_output: 'primary format fixture',
  });
  await h.save();
  expect(await h.host.load(h.run, 'marker')).toMatchObject({
    rules: h.run.spec.rules,
    procedures: h.run.spec.procedures,
  });
  Object.assign(h.turn, {
    sandbox_policy: {
      type: 'workspace-write',
      network_access: false,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    },
  });
  await h.save();
  expect(await h.host.observe()).toMatchObject({
    sandbox_policy: 'workspace-write',
    permission_profile: 'managed',
    network_access: false,
  });
  h.payload.turn_id = 'other';
  await h.save();
  await expect(h.host.load(h.run, 'marker')).rejects.toThrow('chat-read-unconfirmed');
});

it.each(['before-read', 'during-read', 'namespace', 'directory-namespace', 'metadata-error'])(
  'rejects changed Git metadata and closes its descriptor: %s',
  async (kind) => {
    const h = await worktreeHostFixture();
    const path = resolve(h.workspace, '.git');
    const { readFileSync: read, openSync: open } = await vi.importActual<typeof fs>('node:fs');
    const opened = vi.spyOn(fs, 'openSync').mockClear();
    const closed = vi.spyOn(fs, 'closeSync').mockClear();
    const change = () => fs.writeFileSync(path, `gitdir: ${h.gitdir}\n `);
    const hook =
      kind === 'before-read'
        ? vi.spyOn(fs, 'openSync').mockImplementationOnce((...args) => {
            change();
            return open(...args);
          })
        : vi.spyOn(fs, 'readFileSync').mockImplementationOnce((file) => {
            if (kind === 'metadata-error') throw new Error('injected metadata read error');
            const bytes = read(file);
            if (kind === 'during-read') change();
            else {
              fs.renameSync(h.workspace, h.workspace + '-old');
              fs.mkdirSync(h.workspace);
              if (kind === 'directory-namespace')
                fs.renameSync(resolve(h.workspace + '-old', '.git'), path);
              else fs.writeFileSync(path, `gitdir: ${h.gitdir}\n`);
            }
            return bytes;
          });
    try {
      await expect(h.host.observe()).rejects.toThrow();
      expect(opened).toHaveBeenCalled();
      expect(closed).toHaveBeenCalledTimes(opened.mock.calls.length);
    } finally {
      hook.mockRestore();
      opened.mockRestore();
      closed.mockRestore();
    }
  },
);

async function backgroundContinuationFixture() {
  const h = await continuationFixture();
  h.records.splice(
    h.records.findIndex((r) => r.payload.type === 'item_completed' && !('thread_id' in r.payload)),
    1,
  );
  Object.assign(h.records[1]!, { timestamp: new Date(1000).toISOString() });
  const end = h.records.findIndex((r) => r.payload.type === 'task_complete');
  Object.assign(h.records[end]!, { timestamp: new Date(3000).toISOString() });
  h.records.splice(
    end,
    0,
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'background-launch',
        name: 'exec',
        input: 'text(await tools.exec_command({cmd:"yarn validate:brief",yield_time_ms:1000}));',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'background-launch',
        output: [{ type: 'input_text', text: JSON.stringify({ session_id: 10566, output: '' }) }],
      },
    },
  );
  const completion = {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'session',
      turn_id: 'turn',
      started_at_ms: 2000,
      completed_at_ms: 4000,
      item: {
        type: 'CommandExecution',
        id: 'background',
        source: 'unified_exec_startup',
        process_id: '10566',
        command: ['/bin/zsh', '-lc', 'yarn validate:brief'],
        cwd: 'file://' + f.root,
        status: 'completed',
        exit_code: 0,
      },
    },
  };
  h.records.push(completion);
  Object.assign(h.records.at(-1)!, { timestamp: new Date(4000).toISOString() });
  return { ...h, completion };
}

it.each([
  '0.154.0',
  '0.163.0-alpha.10.2',
  '0.163.0-alpha.11',
  '0.163.0-alpha.11.1',
  '0.163.0-alpha.11.2',
  '0.164.0-alpha.11.1',
  '0.165.0-alpha.1.2',
])(
  'qualifies client %s for a writing main and read-only auxiliary observation',
  async (clientVersion) => {
    const h = await hostFixture(clientVersion);
    expect(await h.host.observe()).toMatchObject({
      client_version: clientVersion,
      effective_read_only: false,
      network_access: true,
      approval_policy: 'never',
      permission_profile: 'disabled',
    });
    Object.assign(h.session, { source: 'vscode' });
    Object.assign(h.turn, {
      sandbox_policy: { type: 'read-only' },
      permission_profile: {
        type: 'managed',
        file_system: { type: 'restricted', entries: [{ access: 'read' }] },
        network: 'restricted',
      },
    });
    await h.save();
    expect(await h.host.observe()).toMatchObject({
      effective_read_only: true,
      network_access: null,
    });
    const parent = new FileCurrentChatHost(
      f.root,
      resolve(f.root, 'transcript.jsonl'),
      h.anchor,
      null,
      true,
    );
    expect(await parent.observe()).toMatchObject({
      effective_read_only: true,
      network_access: false,
    });
    Object.assign(h.session, {
      session_id: 'parent',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
    });
    await h.save();
    const child = new FileCurrentChatHost(
      f.root,
      resolve(f.root, 'transcript.jsonl'),
      h.anchor,
      'parent',
    );
    expect(await child.observe()).toMatchObject({
      effective_read_only: true,
      network_access: false,
    });
    h.session.cli_version = '0.164.0';
    await h.save();
    await expect(h.host.observe()).rejects.toThrow('chat-client-unsupported');
    await expect(parent.observe()).rejects.toThrow('chat-independent-root-unconfirmed');
    await expect(child.observe()).rejects.toThrow('chat-client-unsupported');
  },
);
it('continues a completed native turn only after all observed calls and items have known outcomes', async () => {
  const h = await continuationFixture();
  h.item.id = 'command';
  h.records.splice(
    2,
    0,
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'function' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'function' } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_started',
        thread_id: 'session',
        turn_id: 'turn',
        item: { type: 'CommandExecution', id: 'command' },
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        namespace: 'codex_app',
        name: 'send_message_to_thread',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn' },
      },
    },
  );
  h.records.splice(2, 0, {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'session',
      turn_id: 'turn',
      item: { type: 'Reasoning' },
    },
  });
  // Existing host-fixture unrelated events have no native turn identity and are omitted here.
  h.records.splice(
    h.records.findIndex(
      (r) =>
        r.type === 'event_msg' &&
        r.payload.type === 'item_completed' &&
        !('thread_id' in r.payload),
    ),
    1,
  );
  await h.save();
  const boundary = await h.host.boundary('turn');
  expect(await h.host.continuation('turn')).toEqual(boundary.source);
  h.item.status = 'failed';
  h.records.find((r) => r.payload.type === 'task_complete')!.payload.type = 'task_aborted';
  await h.save();
  expect(await h.host.continuation('turn')).toEqual((await h.host.boundary('turn')).source);
  await expect(h.host.continuation('next')).rejects.toThrow('chat-continuation-turn-required');
});

it('ignores late subagent completion notifications while rejecting late starts and writers', async () => {
  const h = await continuationFixture();
  h.records.splice(
    h.records.findIndex((r) => r.payload.type === 'item_completed' && !('thread_id' in r.payload)),
    1,
  );
  const notification = {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'session',
      turn_id: 'turn',
      item: { id: 'subagent-completed', type: 'SubAgentActivity' },
    },
  };
  h.records.push(notification);
  await h.save();
  expect(await h.host.continuation('turn')).toEqual((await h.host.boundary('turn')).source);
  notification.payload.type = 'item_started';
  await h.save();
  await expect(h.host.continuation('turn')).rejects.toThrow('chat-continuation-late-operation');
  notification.payload.type = 'item_completed';
  notification.payload.item.type = 'FileChange';
  await h.save();
  await expect(h.host.continuation('turn')).rejects.toThrow('chat-continuation-late-operation');
});

it('continues after a known background command finishes beyond the prior turn boundary', async () => {
  const h = await backgroundContinuationFixture();
  await h.save();
  await expect(h.host.continuation('turn')).resolves.toEqual({
    locator: `${resolve(f.root, 'transcript.jsonl')}#L${h.records.length}`,
    hash: contentHash(JSON.stringify(h.records.at(-1)) + '\n'),
  });
});

it('keeps yielded execution cells pending until a matching native wait actually completes', async () => {
  const h = await continuationFixture();
  h.records.splice(
    h.records.findIndex((r) => r.payload.type === 'item_completed' && !('thread_id' in r.payload)),
    1,
  );
  const running = [
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'exec', name: 'exec' } },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'exec',
        output: [{ type: 'input_text', text: 'Script running with cell ID running-cell' }],
      },
    },
  ];
  h.records.splice(2, 0, ...running);
  await h.save();
  await expect(h.host.continuation('turn')).rejects.toThrow('chat-continuation-operation-pending');
  const wait = [
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'wait',
        name: 'wait',
        arguments: JSON.stringify({ cell_id: 'running-cell' }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'wait',
        output: 'Script running with cell ID running-cell',
      },
    },
  ];
  h.records.splice(4, 0, ...wait);
  await h.save();
  await expect(h.host.continuation('turn')).rejects.toThrow('chat-continuation-operation-pending');
  wait[1]!.payload.output = 'Script completed';
  await h.save();
  expect(await h.host.continuation('turn')).toEqual((await h.host.boundary('turn')).source);
});

it.each([
  ['open-call', 'chat-continuation-operation-pending'],
  ['duplicate-call', 'chat-continuation-history-incomplete'],
  ['orphan-output', 'chat-continuation-history-incomplete'],
  ['unidentified-output', 'chat-continuation-history-incomplete'],
  ['open-item', 'chat-continuation-operation-pending'],
  ['running-command', 'chat-continuation-operation-pending'],
  ['foreign-command', 'chat-continuation-item-unconfirmed'],
  ['late-command', 'chat-continuation-late-operation'],
  ['missing-start', 'chat-continuation-history-incomplete'],
  ['changed-boundary', 'chat-continuation-history-incomplete'],
  ['compacted', 'chat-continuation-boundary-unconfirmed'],
])('rejects an incomplete prior native turn: %s', async (kind, reason) => {
  const h = await continuationFixture();
  h.records.splice(
    h.records.findIndex(
      (r) =>
        r.type === 'event_msg' &&
        r.payload.type === 'item_completed' &&
        !('thread_id' in r.payload),
    ),
    1,
  );
  const call = { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call' } };
  if (kind === 'open-call' || kind === 'duplicate-call') h.records.splice(2, 0, call);
  if (kind === 'duplicate-call') h.records.splice(2, 0, structuredClone(call));
  if (kind === 'orphan-output')
    h.records.splice(2, 0, {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'absent' },
    });
  if (kind === 'unidentified-output')
    h.records.splice(2, 0, { type: 'response_item', payload: { type: 'custom_tool_call_output' } });
  if (kind === 'open-item')
    h.records.splice(2, 0, {
      type: 'event_msg',
      payload: {
        type: 'item_started',
        thread_id: 'session',
        turn_id: 'turn',
        item: { id: 'unfinished' },
      },
    });
  if (kind === 'running-command') h.item.status = 'inProgress';
  if (kind === 'foreign-command') h.payload.turn_id = 'foreign';
  if (kind === 'late-command')
    h.records.push({ type: 'event_msg', payload: structuredClone(h.payload) });
  if (kind === 'missing-start') h.records.splice(1, 1);
  if (kind === 'changed-boundary') {
    await h.save();
    const boundary = await h.host.boundary('turn');
    vi.spyOn(h.host, 'boundary').mockResolvedValue({
      ...boundary,
      source: { ...boundary.source, hash: 'changed' },
    });
  }
  if (kind === 'compacted')
    h.records.splice(
      h.records.findIndex((r) => r.payload.type === 'task_complete'),
      1,
      { type: 'compacted', payload: {} },
    );
  await h.save();
  await expect(h.host.continuation('turn')).rejects.toThrow(reason);
});
it('reuses exact accepted reads in an automatic turn until compaction, with fresh bytes checked', async () => {
  const h = await hostFixture();
  const receipt = await h.host.load(h.run, 'marker');
  h.run.loaded = receipt;
  h.anchor.turn_id = 'automatic';
  h.records.push({ type: 'turn_context', payload: { ...h.turn, turn_id: 'automatic' } });
  await h.save();
  await expect(h.host.load(h.run, 'automatic')).rejects.toThrow('chat-load-incomplete');
  expect(await h.host.load(h.run, 'automatic', true)).toEqual(receipt);
  h.records.push({
    type: 'event_msg',
    payload: {
      ...h.payload,
      turn_id: 'automatic',
      item: {
        ...h.item,
        aggregated_output: JSON.stringify({ ...h.reads[0], chat_read: 'automatic' }),
      },
    },
  });
  await h.save();
  expect((await h.host.load(h.run, 'automatic', true)).procedures).toEqual(receipt.procedures);
  await f.file(h.reads[0]!.locator, 'Changed rules');
  await expect(h.host.load(h.run, 'automatic', true)).rejects.toThrow(
    'chat-read-stale-or-duplicate',
  );
  h.records.push(
    { type: 'compacted', payload: {} },
    { type: 'turn_context', payload: { ...h.turn, turn_id: 'automatic' } },
  );
  await h.save();
  await expect(h.host.load(h.run, 'automatic', true)).rejects.toThrow('chat-load-incomplete');
});
it.each(['legacy', '{}', '[null]', '[{"locator":"foreign","hash":"wrong"}]'])(
  'requires fresh LOAD for unusable historical receipts: %s',
  async (observed_read) => {
    const h = await hostFixture();
    h.run.loaded = { ...(await h.host.load(h.run, 'marker')), observed_read };
    h.anchor.turn_id = 'automatic';
    h.records.push({ type: 'turn_context', payload: { ...h.turn, turn_id: 'automatic' } });
    await h.save();
    await expect(h.host.load(h.run, 'automatic', true)).rejects.toThrow('chat-load-incomplete');
  },
);

it.each([
  '0.154.0',
  '0.162.0-alpha.17.2',
  '0.163.0-alpha.10.2',
  '0.163.0-alpha.11',
  '0.163.0-alpha.11.1',
  '0.163.0-alpha.11.2',
  '0.164.0-alpha.11.1',
  '0.165.0-alpha.1.2',
])(
  'binds a native turn and proves the complete exact read for client %s without resuming it or copying extra metadata',
  async (clientVersion) => {
    const h = await hostFixture(clientVersion);
    expect(await h.host.observe()).toMatchObject({
      thread_id: 'session',
      turn_id: 'turn',
      model: 'fixture-model',
      workspace: f.root,
    });
    const receipt = await h.host.load(h.run, 'marker');
    expect(receipt).toMatchObject({
      run_id: 'run',
      session_id: 'session',
      rules: f.spec.rules,
      procedures: f.spec.procedures,
    });
    expect(JSON.parse(receipt.observed_read)).toHaveLength(h.reads.length);
    expect(chatPath(f.root + '/.')).toBe(f.root);
    expect(chatPath('file://localhost' + f.root)).toBe(f.root);
    expect(() => chatPath('relative')).toThrow('chat-workspace-not-absolute');
    expect(() => chatPath('file://foreign/etc')).toThrow();
  },
);
it.each(
  [
    '0.154.0',
    '0.162.0-alpha.17.2',
    '0.163.0-alpha.10.2',
    '0.163.0-alpha.11',
    '0.163.0-alpha.11.1',
    '0.163.0-alpha.11.2',
    '0.164.0-alpha.11.1',
    '0.165.0-alpha.1.2',
  ].flatMap((clientVersion) =>
    [
      'session',
      'native-session',
      'turn',
      'version',
      'session-workspace',
      'turn-workspace',
      'anchor-workspace',
      'missing-context',
      'duplicate-session',
      'missing-model',
    ].map((kind) => ({ clientVersion, kind })),
  ),
)(
  'rejects unconfirmed host metadata for $clientVersion: $kind',
  async ({ clientVersion, kind }) => {
    const h = await hostFixture(clientVersion);
    if (kind === 'session') h.session.id = 'foreign';
    if (kind === 'native-session') h.session.session_id = 'foreign';
    if (kind === 'turn') h.turn.turn_id = 'other';
    if (kind === 'version') h.session.cli_version = 'future';
    if (kind === 'session-workspace') h.session.cwd = '/other';
    if (kind === 'turn-workspace') h.turn.cwd = '/other';
    if (kind === 'anchor-workspace') h.anchor.workspace = '/other';
    if (kind === 'missing-context') h.records.splice(1, 1);
    if (kind === 'duplicate-session') h.records.push(h.records[0]!);
    if (kind === 'missing-model') h.turn.model = '';
    await h.save();
    await expect(h.host.observe()).rejects.toThrow();
  },
);
it('rejects a partial transcript, malformed JSON, run identity/profile changes and incomplete reads', async () => {
  const h = await hostFixture();
  await f.file('transcript.jsonl', '{');
  await expect(h.host.observe()).rejects.toThrow('chat-transcript-partial');
  await f.file('transcript.jsonl', '{\n');
  await expect(h.host.observe()).rejects.toThrow();
  await h.save();
  await expect(h.host.load(h.run, 'other')).rejects.toThrow('chat-load-incomplete');
  await expect(
    h.host.load({ ...h.run, spec: { ...h.run.spec, session_id: 'other' } }, 'marker'),
  ).rejects.toThrow('chat-run-mismatch');
  await expect(
    h.host.load(
      { ...h.run, spec: { ...h.run.spec, requested: { ...h.run.spec.requested, effort: 'low' } } },
      'marker',
    ),
  ).rejects.toThrow('chat-run-mismatch');
  h.item.aggregated_output += '\n' + JSON.stringify({ chat_read: 'other' });
  await h.save();
  expect(await h.host.load(h.run, 'marker')).toBeDefined();
});
it('isolates a fresh LOAD from truncated output of another attempt without accepting partial current reads', async () => {
  const h = await hostFixture();
  const complete = h.item.aggregated_output;
  h.item.aggregated_output = '{"chat_read":"old-attempt","content":"truncated\n' + complete;
  await h.save();
  expect(await h.host.load(h.run, 'marker')).toBeDefined();
  await expect(h.host.load(h.run, 'old-attempt')).rejects.toThrow();
  h.item.aggregated_output = '{"chat_read":"old-attempt","content":"truncated';
  await h.save();
  await expect(h.host.load(h.run, 'marker')).rejects.toThrow('chat-load-incomplete');
  h.item.aggregated_output = complete + '\n{"chat_read":"marker","content":"truncated';
  await h.save();
  await expect(h.host.load(h.run, 'marker')).rejects.toThrow();
  h.item.aggregated_output = complete + '\n{"chat_read":"marker","chat_read":"other"}';
  await h.save();
  await expect(h.host.load(h.run, 'marker')).rejects.toThrow('chat-read-unconfirmed');
});
it('recovers the same marker with a complete later command without crediting the truncated command', async () => {
  const h = await hostFixture();
  const complete = h.item.aggregated_output;
  h.item.aggregated_output = complete + '\n{"chat_read":"marker","content":"truncated';
  await h.save();
  expect((await h.host.readSelection(h.run, 'marker')).reads.size).toBe(0);
  await expect(h.host.load(h.run, 'marker')).rejects.toThrow('chat-load-incomplete');
  h.records.push({
    type: 'event_msg',
    payload: { ...h.payload, item: { ...h.item, aggregated_output: complete } },
  });
  await h.save();
  const loaded = await h.host.load(h.run, 'marker');
  expect(JSON.parse(loaded.observed_read)).toHaveLength(h.reads.length);
});
it.each([
  'thread',
  'turn',
  'cwd',
  'exit',
  'status',
  'hash',
  'bytes',
  'duplicate',
  'changed-input',
  'procedure-header',
])('rejects unconfirmed or stale read: %s', async (kind) => {
  const h = await hostFixture();
  if (kind === 'thread') h.payload.thread_id = 'other';
  if (kind === 'turn') h.payload.turn_id = 'other';
  if (kind === 'cwd') h.item.cwd = '/other';
  if (kind === 'exit') h.item.exit_code = 1;
  if (kind === 'status') h.item.status = 'failed';
  if (kind === 'hash') h.reads[0]!.hash = 'other';
  if (kind === 'bytes') h.reads[0]!.content += 'change';
  if (kind === 'duplicate') h.reads.push(h.reads[0]!);
  if (kind === 'changed-input') await f.file(h.reads[0]!.locator, 'changed');
  if (kind === 'procedure-header') h.run.spec.procedures[0]!.version = '99';
  h.item.aggregated_output = h.reads.map((r) => JSON.stringify(r)).join('\n');
  await h.save();
  await expect(h.host.load(h.run, 'marker')).rejects.toThrow();
});

it('verifies primary references without copying text and accepts human decisions only in the bound turn', async () => {
  const h = await hostFixture();
  const records = [
    { type: 'session_meta', payload: h.session },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Human fixture instruction' }],
      },
    },
    { type: 'turn_context', payload: h.turn },
  ];
  const source = {
    locator: resolve(f.root, 'transcript.jsonl') + '#L3',
    hash: contentHash(JSON.stringify(records[2]) + '\n'),
  };
  const save = async () =>
    f.file('transcript.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await save();
  await expect(h.host.reference(source)).resolves.toBeUndefined();
  expect(await h.host.message(source)).toEqual({ thread_id: 'session', turn_id: 'turn' });
  await expect(h.host.reference({ ...source, hash: 'wrong' })).rejects.toThrow(
    'chat-source-unconfirmed',
  );
  await expect(h.host.message({ ...source, hash: 'wrong' })).rejects.toThrow(
    'chat-source-unconfirmed',
  );
  (records[1]!.payload as { turn_id: string }).turn_id = 'old';
  await save();
  await expect(h.host.message(source)).rejects.toThrow('chat-human-message-unconfirmed');
});
it.each(['task_aborted', 'turn_aborted'])(
  'requires fresh reads and distinguishes the native %s boundary',
  async (aborted) => {
    const h = await hostFixture();
    await expect(h.host.boundary('turn')).rejects.toThrow('chat-boundary-unconfirmed');
    const original = h.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await f.file(
      'transcript.jsonl',
      original +
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }) +
        '\n',
    );
    expect(await h.host.load(h.run, 'marker')).toBeDefined();
    const compacted = JSON.stringify({ type: 'compacted', payload: {} }) + '\n';
    await f.file('transcript.jsonl', original + compacted);
    expect(await h.host.boundary('turn')).toMatchObject({ kind: 'compacted' });
    await expect(h.host.load(h.run, 'marker')).rejects.toThrow('chat-load-incomplete');
    await f.file(
      'transcript.jsonl',
      original +
        compacted +
        JSON.stringify({ type: 'turn_context', payload: h.turn }) +
        '\n' +
        JSON.stringify({ type: 'event_msg', payload: h.payload }) +
        '\n',
    );
    expect(await h.host.load(h.run, 'marker')).toBeDefined();
    const ended =
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } }) +
      '\n';
    await f.file('transcript.jsonl', original + ended);
    expect(await h.host.boundary('turn')).toMatchObject({ kind: 'completed' });
    await f.file(
      'transcript.jsonl',
      original +
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }) +
        '\n' +
        JSON.stringify({ type: 'event_msg', payload: { type: aborted, turn_id: 'other' } }) +
        '\n',
    );
    await expect(h.host.boundary('turn')).rejects.toThrow('chat-boundary-unconfirmed');
    await f.file(
      'transcript.jsonl',
      original +
        JSON.stringify({ type: 'event_msg', payload: { type: aborted, turn_id: 'turn' } }) +
        '\n',
    );
    expect(await h.host.boundary('turn')).toMatchObject({ kind: 'aborted' });
  },
);

it('observes a scoped LOAD, extends it from primary reads and invalidates it after compaction', async () => {
  const h = await hostFixture('0.163.0-alpha.11.2');
  h.run.spec.procedure_loading = 'by-action';
  const base = new Set([
    ...h.run.spec.procedures
      .filter((p) => ['bootstrap', 'task', 'evidence'].includes(p.id))
      .map((p) => p.locator),
    ...h.run.spec.rules.map((r) => r.locator),
  ]);
  h.item.aggregated_output = h.reads
    .filter((r) => base.has(r.locator))
    .map((r) => JSON.stringify(r))
    .join('\n');
  await h.save();
  const initial = await h.host.load(h.run, 'marker');
  expect(initial.procedures.map((p) => p.id)).toEqual(['bootstrap', 'task', 'evidence']);
  h.run.loaded = initial;
  h.records.push({
    type: 'event_msg',
    payload: {
      ...h.payload,
      item: {
        ...h.item,
        aggregated_output: h.reads
          .filter((r) => !base.has(r.locator))
          .map((r) => JSON.stringify(r))
          .join('\n'),
      },
    },
  });
  await h.save();
  expect((await h.host.load(h.run, 'marker')).procedures).toEqual(h.run.spec.procedures);
  h.anchor.turn_id = 'automatic';
  h.records.push({ type: 'turn_context', payload: { ...h.turn, turn_id: 'automatic' } });
  await h.save();
  expect((await h.host.load(h.run, 'automatic', true)).procedures).toEqual(initial.procedures);
  h.records.push({ type: 'compacted', payload: {} });
  await h.save();
  await expect(h.host.load(h.run, 'automatic', true)).rejects.toThrow('chat-load-incomplete');
});

it('observes a launch from the primary native transcript instead of trusting a caller claim', async () => {
  const h = await hostFixture();
  expect(await h.host.auditLaunch('attempt')).toEqual({ outcome: 'unknown' });
  h.records.push(
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'collaboration.spawn_agent',
        call_id: 'create',
        arguments: JSON.stringify({
          task_name: 'attempt',
          agent_type: 'auditor',
          message: 'card.md',
        }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'create',
        output: JSON.stringify({ agent_id: 'child' }),
      },
    },
  );
  await h.save();
  expect(await h.host.auditLaunch('attempt')).toMatchObject({
    outcome: 'created',
    session: 'child',
    deliveries: ['card.md'],
  });
});

it('requires every ordered observed LOAD fragment and retains all primary receipts', async () => {
  const h = await hostFixture();
  const source = h.reads[0]!;
  const cut = Math.floor(source.content.length / 2);
  const fragment = (offset: number, content: string) => ({
    ...source,
    offset,
    length: source.content.length,
    content,
  });
  h.item.aggregated_output = JSON.stringify(fragment(0, source.content.slice(0, cut)));
  await h.save();
  const partial = await h.host.readSelection(h.run, 'marker');
  expect(partial.reads.has(source.locator)).toBe(false);
  expect(partial.fragments.get(source.locator)).toBe(source.content.slice(0, cut));
  await expect(h.host.load(h.run, 'marker')).rejects.toThrow('chat-load-incomplete');
  h.records.push({
    type: 'event_msg',
    payload: {
      ...h.payload,
      item: {
        ...h.item,
        aggregated_output:
          JSON.stringify(fragment(cut, source.content.slice(cut))) +
          '\n' +
          h.reads
            .slice(1)
            .map((r) => JSON.stringify(r))
            .join('\n'),
      },
    },
  });
  await h.save();
  expect((await h.host.load(h.run, 'marker')).procedures).toEqual(f.spec.procedures);
  const loaded = await h.host.readSelection(h.run, 'marker');
  expect(loaded.reads.get(source.locator)).toBe(source.content);
  expect(loaded.receipts).toHaveLength(h.reads.length + 1);
});

it.each(['gap', 'negative', 'fraction', 'length', 'content', 'oversize', 'repeat'])(
  'refuses invalid observed LOAD fragment: %s',
  async (kind) => {
    const h = await hostFixture();
    const source = h.reads[0]!;
    const first = {
      ...source,
      content: source.content.slice(0, 10),
      offset: 0,
      length: source.content.length,
    };
    const second = {
      ...source,
      content: source.content.slice(10),
      offset: 10,
      length: source.content.length,
    };
    if (kind === 'gap') second.offset = 11;
    if (kind === 'negative') second.offset = -1;
    if (kind === 'fraction') second.offset = 10.5;
    if (kind === 'length') second.length++;
    if (kind === 'content') second.content = 'foreign';
    if (kind === 'oversize') second.content = 'a'.repeat(8001);
    if (kind === 'repeat') Object.assign(second, first);
    h.item.aggregated_output = JSON.stringify(first) + '\n' + JSON.stringify(second);
    await h.save();
    await expect(h.host.readSelection(h.run, 'marker')).rejects.toThrow(
      'chat-read-fragment-invalid',
    );
  },
);
