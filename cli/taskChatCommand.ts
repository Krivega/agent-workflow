import { realpath } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isDeepStrictEqual as sameValue } from 'node:util';
import { requireWorkflow } from '../src/contracts/localValues.js';
import { readPrivateFile } from '../src/adapters/artifacts/files.js';
import { taskBackendPolicy } from '../src/adapters/project/taskBackend.js';
import { chatDiagnostic, reportTaskChatFailure } from './chatFailureGuidance.js';
export { taskChatUsage } from './chatFailureGuidance.js';
const temporalStartFlags = ['--temporal-input', '--temporal-registration'];

async function runTemporalStart(
  args: readonly string[],
  root: string,
  policy: ReturnType<typeof taskBackendPolicy>,
  write: (s: string) => void,
) {
  const [, key, value, other, otherValue] = args;
  requireWorkflow(
    args.length === 5 &&
      key !== other &&
      temporalStartFlags.includes(key!) &&
      temporalStartFlags.includes(other!) &&
      value?.length &&
      otherValue?.length &&
      !value.startsWith('--') &&
      !otherValue.startsWith('--'),
    'task-chat-temporal-input-required',
  );
  requireWorkflow(policy?.startAdmission !== undefined, 'task-start-policy-required');
  requireWorkflow(policy.newTasks === 'temporal', 'backend-new-tasks-blocked');
  const input = resolve(root, key === '--temporal-input' ? value : otherValue);
  const registration = resolve(root, key === '--temporal-registration' ? value : otherValue);
  const stat = lstatSync(registration);
  requireWorkflow(
    realpathSync(registration) === registration &&
      registration !== root &&
      !registration.startsWith(root + sep) &&
      stat.isFile() &&
      stat.nlink === 1 &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0,
    'task-chat-temporal-registration-private',
  );
  const settingsBytes = readPrivateFile(registration);
  const after = lstatSync(registration);
  requireWorkflow(
    sameValue(
      [stat.dev, stat.ino, stat.ctimeMs, stat.size],
      [after.dev, after.ino, after.ctimeMs, after.size],
    ),
    'task-chat-temporal-registration-changed',
  );
  const settings = JSON.parse(settingsBytes.toString('utf8')) as unknown;
  const request = JSON.parse(readPrivateFile(input).toString('utf8')) as unknown;
  const { startPreparedLocalTask } = await import('@krivega/agent-workflow/local-task');
  write(JSON.stringify(await startPreparedLocalTask(root, request, settings)));
  return 0;
}

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
