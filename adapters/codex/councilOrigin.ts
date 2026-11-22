import { relative } from 'node:path';
import { object, requireWorkflow } from '../../core/connection.js';
import { sameValue } from '../../core/equality.js';
import type { AgentSession } from '../../core/dataRoute.js';
import type { InputRef } from '../../core/localRun.js';
import { contentHash, projectText } from '../project/projectFiles.js';
import { confirmNativeRead } from './nativeRead.js';
import { decodeChatArtifact } from '../storage/sharedArtifacts.js';

async function readReceipt(root: string, ref: InputRef, error: string) {
  const content = await projectText(root, relative(root, ref.locator));
  requireWorkflow(contentHash(content) === ref.hash, error);
  return object(decodeChatArtifact(root, content));
}

export async function confirmCouncilOrigin(
  root: string,
  session: AgentSession,
  origin: InputRef | undefined,
  first: Record<string, unknown>,
) {
  requireWorkflow(origin !== undefined, 'native-council-origin-required');
  const load = await readReceipt(root, origin, 'native-council-origin-changed');
  requireWorkflow(
    load.session === session.id && Array.isArray(load.refs) && load.refs.length > 0,
    'native-council-origin-mismatch',
  );
  requireWorkflow(first.id === load.turn, 'native-council-history-not-empty');
  confirmNativeRead(first, load.refs as InputRef[]);
  const creation = await readReceipt(
    root,
    object(load.creation) as unknown as InputRef,
    'native-council-creation-changed',
  );
  const response = object(creation.session);
  const thread = object(response.thread);
  const sandbox = object(response.sandbox);
  requireWorkflow(
    sameValue(
      {
        operation: creation.operation,
        parent: creation.parent,
        id: thread.id,
        project: thread.projectId,
        parent_thread: thread.parentThreadId,
        fork: thread.forkedFromId,
        turns: thread.turns,
        workspace: thread.cwd,
        cwd: response.cwd,
        model: response.model,
        effort: response.reasoningEffort,
        approval: response.approvalPolicy,
        sandbox: { type: sandbox.type, networkAccess: sandbox.networkAccess },
      },
      {
        operation: 'thread/start',
        parent: null,
        id: session.id,
        project: session.native_project_id,
        parent_thread: null,
        fork: null,
        turns: [],
        workspace: session.workspace,
        cwd: session.workspace,
        model: session.model,
        effort: session.effort,
        approval: 'never',
        sandbox: { type: 'readOnly', networkAccess: false },
      },
    ),
    'native-council-creation-unconfirmed',
  );
  return { load, creation, turn: first };
}
