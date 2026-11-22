import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectChatPeer } from '../adapters/codex/chatPeer.js';
import { localFixture } from './localFixtures.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';

let f: Awaited<ReturnType<typeof localFixture>>;
beforeEach(async () => {
  f = await localFixture();
});
afterEach(async () => {
  await f.dispose();
});
async function fixture() {
  const anchor = {
    thread_id: 'peer',
    turn_id: 'turn',
    host_id: 'local' as const,
    workspace: f.root,
  };
  const session = {
    id: 'peer',
    session_id: 'peer',
    cli_version: '0.162.0-alpha.17.2',
    cwd: f.root,
    thread_source: 'subagent',
    source: { subagent: { thread_spawn: { parent_thread_id: 'principal' } } },
  };
  const turn = {
    turn_id: 'turn',
    cwd: f.root,
    model: 'model',
    effort: 'high',
    approval_policy: 'never',
    sandbox_policy: { type: 'workspace-write', network_access: false as boolean | undefined },
    permission_profile: { type: 'workspace-write' } as Record<string, unknown>,
  };
  const thread = {
    id: 'peer',
    path: resolve(f.root, 'peer.jsonl'),
    cwd: f.root,
    projectId: 'native' as string | null,
    cliVersion: session.cli_version,
    forkedFromId: null as string | null | number,
    agentRole: null as string | null,
    parentThreadId: 'principal' as string | null,
    source: { subAgent: { thread_spawn: { parent_thread_id: 'principal' } } },
    name: 'Советник: Архитектор' as string | null,
  };
  const transcript = resolve(f.root, 'peer.jsonl');
  const save = async () =>
    f.file(
      'peer.jsonl',
      [
        { type: 'session_meta', payload: session },
        { type: 'turn_context', payload: turn },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
  await save();
  const roles = {
    project_id: 'native',
    peer_observations: { peer: { root: f.root, transcript, anchor } },
  };
  const parent = { id: 'principal', projectId: 'native' as string | null, cwd: f.root };
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
    thread: params.threadId === 'principal' ? parent : thread,
  }));
  return {
    turn,
    session,
    parent,
    anchor,
    transcript,
    thread,
    roles,
    request,
    save,
    inspect: () => inspectChatPeer({ request }, roles, 'peer', f.root),
  };
}
it('observes writing peers with metadata-only thread/read and preserves a repeatable private receipt', async () => {
  const h = await fixture();
  const peer = await h.inspect();
  expect(peer).toMatchObject({
    id: 'peer',
    project_id: 'native',
    native_project_id: 'native',
    read_only: false,
    network: false,
    forked_from: null,
    initial_turns: -1,
  });
  expect(h.request).toHaveBeenCalledWith('thread/read', { threadId: 'peer', includeTurns: false });
  expect(await h.inspect()).toEqual(peer);
  expect(JSON.parse(await readFile(peer.receipt.locator, 'utf8'))).toHaveProperty(
    'observed.source',
  );
  h.turn.sandbox_policy.type = 'read-only';
  h.thread.forkedFromId = 'parent';
  h.thread.agentRole = 'worker';
  await h.save();
  expect(await h.inspect()).toMatchObject({
    read_only: true,
    forked_from: 'parent',
    agent_role: 'worker',
  });
  await writeFile(peer.receipt.locator, 'conflict');
  h.turn.sandbox_policy.type = 'workspace-write';
  h.thread.forkedFromId = null;
  h.thread.agentRole = null;
  await h.save();
  await expect(h.inspect()).rejects.toThrow('chat-peer-receipt-conflict');
});

it.each(['native', null])(
  'observes a native child with project %s without resuming either chat',
  async (project) => {
    const h = await fixture();
    h.thread.projectId = project;
    h.session.session_id = 'principal';
    h.turn.sandbox_policy.type = 'read-only';
    h.turn.permission_profile = {
      type: 'managed',
      file_system: { type: 'restricted', entries: [{ access: 'read' }] },
      network: 'restricted',
    };
    await h.save();
    const observed = await inspectChatPeer({ request: h.request }, h.roles, 'peer', f.root, {
      parent: 'principal',
      project: 'project',
    });
    expect(observed).toMatchObject({
      native_child: true,
      parent_id: 'principal',
      name: 'Советник: Архитектор',
      project_id: 'project',
      native_project_id: project,
      read_only: true,
      network: false,
    });
    expect(h.request.mock.calls.map(([method, p]) => [method, p.threadId])).toEqual([
      ['thread/read', 'peer'],
      ['thread/read', 'principal'],
    ]);
    h.parent.projectId = null;
    h.thread.projectId = null;
    const roles = { ...h.roles, project_id: null };
    await expect(
      inspectChatPeer({ request: h.request }, roles, 'peer', f.root, {
        parent: 'principal',
        project: 'project',
      }),
    ).resolves.toMatchObject({ native_project_id: null });
  },
);

it('rejects unrelated native children and parent/project contradictions before publishing a receipt', async () => {
  const h = await fixture();
  h.session.session_id = 'principal';
  h.turn.permission_profile = {
    type: 'managed',
    file_system: { type: 'restricted', entries: [{ access: 'read' }] },
    network: 'restricted',
  };
  await h.save();
  const inspect = () =>
    inspectChatPeer({ request: h.request }, h.roles, 'peer', f.root, {
      parent: 'principal',
      project: 'project',
    });
  for (const parent of [null, 'foreign']) {
    h.thread.parentThreadId = parent;
    await expect(inspect()).rejects.toThrow('chat-native-child-unconfirmed');
  }
  h.thread.parentThreadId = 'principal';
  h.thread.source.subAgent.thread_spawn.parent_thread_id = 'foreign';
  await expect(inspect()).rejects.toThrow('chat-native-child-unconfirmed');
  h.thread.source.subAgent.thread_spawn.parent_thread_id = 'principal';
  h.thread.forkedFromId = 'principal';
  await expect(inspect()).rejects.toThrow('chat-native-child-unconfirmed');
  h.thread.forkedFromId = null;
  for (const patch of [{ id: 'foreign' }, { cwd: '/foreign' }, { projectId: 'foreign' }]) {
    const previous = { ...h.parent };
    Object.assign(h.parent, patch);
    await expect(inspect()).rejects.toThrow('chat-native-parent-unconfirmed');
    Object.assign(h.parent, previous);
  }
  h.thread.projectId = 'foreign';
  await expect(inspect()).rejects.toThrow('chat-native-parent-unconfirmed');
  h.thread.projectId = 'native';
  h.thread.name = null;
  await expect(inspect()).resolves.toMatchObject({ name: null });
  h.session.source.subagent.thread_spawn.parent_thread_id = 'foreign';
  await h.save();
  await expect(inspect()).rejects.toThrow('chat-native-parent-unconfirmed');
  h.session.source.subagent.thread_spawn.parent_thread_id = 'principal';
  h.session.thread_source = 'vscode';
  await h.save();
  await expect(inspect()).rejects.toThrow('chat-native-parent-unconfirmed');
});

it('rejects inherited parent transcript history and a principal disguised as its own child', async () => {
  const h = await fixture();
  h.session.session_id = 'principal';
  await h.save();
  const source = await readFile(h.transcript, 'utf8');
  await writeFile(
    h.transcript,
    source +
      JSON.stringify({
        type: 'session_meta',
        payload: {
          ...h.session,
          id: 'principal',
        },
      }) +
      '\n',
  );
  const host = new FileCurrentChatHost(f.root, h.transcript, h.anchor, 'principal');
  await expect(host.observe()).rejects.toThrow('chat-context-missing');
  await h.save();
  h.session.session_id = 'peer';
  h.session.source.subagent.thread_spawn.parent_thread_id = 'peer';
  h.thread.parentThreadId = 'peer';
  h.thread.source.subAgent.thread_spawn.parent_thread_id = 'peer';
  await h.save();
  await expect(
    inspectChatPeer({ request: h.request }, h.roles, 'peer', f.root, {
      parent: 'peer',
      project: 'project',
    }),
  ).rejects.toThrow('chat-native-child-unconfirmed');
});
it('refuses unknown or contradictory native metadata and receipt write failure', async () => {
  const h = await fixture();
  h.thread.forkedFromId = 1;
  await expect(h.inspect()).rejects.toThrow('chat-peer-unconfirmed');
  h.thread.forkedFromId = null;
  h.turn.sandbox_policy.network_access = undefined;
  await h.save();
  await expect(h.inspect()).rejects.toThrow('chat-peer-unconfirmed');
  h.turn.sandbox_policy.network_access = true;
  h.turn.sandbox_policy.type = 'unknown';
  await h.save();
  await expect(h.inspect()).rejects.toThrow('chat-peer-unconfirmed');
  h.turn.sandbox_policy.type = 'workspace-write';
  await h.save();
  await expect(
    inspectChatPeer({ request: h.request }, h.roles, 'peer', resolve(f.root, 'missing')),
  ).rejects.toThrow('chat-peer-receipt-conflict');
});

it('requires independent native identity and a managed read-only profile for a council root', async () => {
  const h = await fixture();
  Object.assign(h.session, { source: 'vscode', thread_source: null });
  Object.assign(h.thread, { source: 'vscode', parentThreadId: null });
  h.turn.sandbox_policy.type = 'read-only';
  h.turn.permission_profile = {
    type: 'managed',
    file_system: { type: 'restricted', entries: [{ access: 'read' }] },
    network: 'restricted',
  };
  const inspect = () =>
    inspectChatPeer({ request: h.request }, h.roles, 'peer', f.root, undefined, 'logical-project');
  await h.save();
  expect(await inspect()).toMatchObject({
    project_id: 'logical-project',
    native_child: false,
    parent_id: null,
    read_only: true,
    network: false,
  });
  for (const patch of [
    { path: '/forged-transcript' },
    { parentThreadId: 'principal' },
    { forkedFromId: 'principal' },
    { source: {} },
    { source: 'unknown' },
  ]) {
    const original = { ...h.thread };
    Object.assign(h.thread, patch);
    await expect(inspect()).rejects.toThrow('chat-council-root-unconfirmed');
    Object.assign(h.thread, original);
  }
  await expect(
    inspectChatPeer(
      { request: h.request },
      h.roles,
      'peer',
      f.root,
      { parent: 'principal', project: 'project' },
      'project',
    ),
  ).rejects.toThrow();
  for (const patch of [
    { source: {} },
    { source: 'unknown' },
    { source: 'vscode', thread_source: 'subagent' },
  ]) {
    const original = { ...h.session };
    Object.assign(h.session, patch);
    await h.save();
    await expect(inspect()).rejects.toThrow('chat-independent-root-unconfirmed');
    Object.assign(h.session, original);
  }
});
