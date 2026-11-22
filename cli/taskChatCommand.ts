import { realpath } from 'node:fs/promises';
import { taskBackendPolicy } from '../src/adapters/project/taskBackend.js';
import { runTemporalStart, temporalStartFlags } from './temporalStart.js';
import { chatDiagnostic, reportTaskChatFailure } from './chatFailureGuidance.js';
export { taskChatUsage } from './chatFailureGuidance.js';
export async function runTaskChatCommand(
  args: readonly string[],
  root: string,
  write: (s: string) => void,
  error: (s: string) => void,
) {
  try {
    root = await realpath(root);
    const starting = args[0] === 'start';
    const policy = starting ? taskBackendPolicy(root) : null;
    if (
      starting &&
      (policy?.startAdmission !== undefined || args.some((arg) => temporalStartFlags.includes(arg)))
    )
      return await runTemporalStart(args, root, policy, write);
    const { runLegacyTaskChatCommand } = await import('./legacyTaskChatCommand.js');
    return runLegacyTaskChatCommand(args, root, policy, write, error);
  } catch (cause) {
    return reportTaskChatFailure(cause, chatDiagnostic, null, write, error);
  }
}
