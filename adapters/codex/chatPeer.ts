import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { object, requireWorkflow, textField } from '../../core/connection.js';
import type { ChatAnchor } from '../../core/currentChat.js';
import type { AgentSession } from '../../core/dataRoute.js';
import { FileCurrentChatHost } from './currentChatHost.js';
import type { AppServerRpc } from './appServerTransport.js';
import { contentHash } from '../project/projectFiles.js';
import { readPrivateFile } from '../storage/storeFiles.js';

// Writing peers are observed without resume, which would alter their active sandbox/profile.
export async function inspectChatPeer(
  rpc: Pick<AppServerRpc, 'request'>,
  roles: Record<string, unknown>,
  id: string,
  evidence: string,
  child?: { parent: string; project: string },
  councilProject?: string,
): Promise<AgentSession> {
  requireWorkflow(child === undefined || councilProject === undefined, 'chat-role-mode-conflict');
  const source = object(object(roles.peer_observations)[id]);
  const host = new FileCurrentChatHost(
    textField(source.root),
    textField(source.transcript),
    source.anchor as ChatAnchor,
    child?.parent,
    councilProject !== undefined,
  );
  const observed = await host.observe();
  const thread = object(
    object(await rpc.request('thread/read', { threadId: id, includeTurns: false })).thread,
  );
  let parent: Record<string, unknown> | null = null;
  if (councilProject !== undefined) {
    requireWorkflow(
      thread.path === source.transcript &&
        thread.parentThreadId === null &&
        thread.forkedFromId === null &&
        typeof thread.source === 'string' &&
        ['cli', 'vscode', 'exec'].includes(thread.source),
      'chat-council-root-unconfirmed',
    );
  }
  if (child !== undefined) {
    const spawn = object(object(object(thread.source).subAgent).thread_spawn);
    requireWorkflow(
      id !== child.parent &&
        thread.parentThreadId === child.parent &&
        spawn.parent_thread_id === child.parent &&
        thread.forkedFromId === null,
      'chat-native-child-unconfirmed',
    );
    parent = object(
      object(await rpc.request('thread/read', { threadId: child.parent, includeTurns: false }))
        .thread,
    );
    requireWorkflow(
      parent.id === child.parent &&
        parent.cwd === observed.workspace &&
        parent.projectId === roles.project_id &&
        (thread.projectId === null || thread.projectId === parent.projectId),
      'chat-native-parent-unconfirmed',
    );
  }
  requireWorkflow(
    observed.thread_id === id &&
      thread.id === id &&
      thread.cwd === observed.workspace &&
      (child !== undefined || thread.projectId === roles.project_id) &&
      thread.cliVersion === observed.client_version &&
      (thread.forkedFromId === null || typeof thread.forkedFromId === 'string') &&
      observed.network_access !== null &&
      ['read-only', 'workspace-write', 'danger-full-access'].includes(observed.sandbox_policy),
    'chat-peer-unconfirmed',
  );
  const fields = {
    id,
    model: observed.model,
    effort: observed.effort,
    workspace: observed.workspace,
    project_id:
      councilProject ?? (child === undefined ? textField(thread.projectId) : child.project),
    native_project_id: thread.projectId === null ? null : textField(thread.projectId),
    parent_id: parent === null ? null : textField(parent.id),
    native_child: child !== undefined,
    observed_turn: observed.turn_id,
    name: typeof thread.name === 'string' ? thread.name : null,
    agent_role: typeof thread.agentRole === 'string' ? thread.agentRole : null,
    read_only: observed.effective_read_only,
    network: observed.network_access,
    forked_from: thread.forkedFromId,
    initial_turns: -1,
  };
  const content =
      JSON.stringify({ schema_version: 1, session: fields, observed, thread, parent }) + '\n',
    hash = contentHash(content);
  const locator = resolve(evidence, `peer-${contentHash(id)}-${hash}.json`);
  try {
    await writeFile(locator, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    requireWorkflow(
      (error as { code?: string }).code === 'EEXIST' &&
        readPrivateFile(locator).toString('utf8') === content,
      'chat-peer-receipt-conflict',
    );
  }
  return { ...fields, receipt: { locator, hash } };
}
