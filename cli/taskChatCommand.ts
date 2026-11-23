import { realpath } from 'node:fs/promises';
import { taskBackendPolicy } from '../src/adapters/project/taskBackend.js';
import { isTemporalTaskChat, runTemporalTaskChat } from './temporalStart.js';
import { chatDiagnostic, reportTaskChatFailure } from './chatFailureGuidance.js';
export { taskChatUsage } from './chatFailureGuidance.js';
export async function runTaskChatCommand(
  args: readonly string[],
  root: string,
  write: (s: string) => void,
  error: (s: string) => void,
) {
  if (isTemporalTaskChat(args)) return runTemporalTaskChat(args, root, write, error);
  try {
    root = await realpath(root);
    const starting = args[0] === 'start';
    const policy = starting ? taskBackendPolicy(root) : null;
    if (starting && policy?.startAdmission !== undefined)
      return runTemporalTaskChat(args, root, write, error);
    const { runLegacyTaskChatCommand } = await import('./legacyTaskChatCommand.js');
    return runLegacyTaskChatCommand(args, root, policy, write, error);
  } catch (cause) {
    return reportTaskChatFailure(cause, chatDiagnostic, null, write, error);
  }
}
