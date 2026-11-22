import type { CodexRpc } from '../../contracts/codex.js';
import type { ReaderExecution } from '../../contracts/readerControl.js';
import { object, requireContract } from '../../contracts/project.js';

export function unpersistedReaderHistory(error: unknown, clientVersion: string) {
  return (
    clientVersion === '0.154.0' &&
    (error instanceof Error ? error.message : String(error)) ===
      'app-server-error:{"code":-32601,"message":"list_turns is not supported yet"}'
  );
}

export async function nativeReaderHeader(
  rpc: CodexRpc,
  workspace: string,
  profile: ReaderExecution['profile'],
  id: string,
) {
  const raw = await rpc.request('thread/read', { threadId: id, includeTurns: false });
  const thread = object(object(raw).thread);
  requireContract(
    thread.id === id &&
      thread.cwd === workspace &&
      thread.projectId === null &&
      thread.parentThreadId === null &&
      thread.forkedFromId === null &&
      thread.model === profile.model &&
      thread.reasoningEffort === profile.effort &&
      thread.cliVersion === profile.clientVersion,
    'reader-native-header-unconfirmed',
  );
  return { raw, thread };
}
