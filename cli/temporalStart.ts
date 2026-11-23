import { lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isDeepStrictEqual as sameValue } from 'node:util';
import { requireWorkflow } from '../src/contracts/localValues.js';
import { readPrivateFile } from '../src/adapters/artifacts/files.js';
import { taskBackendPolicy } from '../src/adapters/project/taskBackend.js';
import {
  chatDiagnostic,
  taskChatHelpRequested,
  temporalReadSyntax,
  temporalStartSyntax,
  temporalTaskChatHelp,
} from './taskChatHelp.js';

const inputFlag = '--temporal-input';
const registrationFlag = '--temporal-registration';
const previewFlag = '--preview-digest';
const workflowFlag = '--workflow-id';

export function isTemporalTaskChat(args: readonly string[]) {
  return (
    taskChatHelpRequested(args) ||
    ['preview', 'status', 'result'].includes(args[0]!) ||
    (args[0] === 'start' &&
      args.some((arg) => [inputFlag, registrationFlag, previewFlag].includes(arg)))
  );
}

function options(
  args: readonly string[],
  flags: readonly string[],
  reason: string,
  optional?: string,
) {
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    requireWorkflow(
      (flags.includes(key) || key === optional) &&
        !values.has(key) &&
        value &&
        !value.startsWith('--'),
      reason,
    );
    values.set(key, value);
  }
  requireWorkflow(
    flags.every((key) => values.has(key)),
    reason,
  );
  return values;
}

function registrationBytes(root: string, registration: string) {
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
  const bytes = readPrivateFile(registration);
  const after = lstatSync(registration);
  requireWorkflow(
    sameValue(
      [stat.dev, stat.ino, stat.ctimeMs, stat.size],
      [after.dev, after.ino, after.ctimeMs, after.size],
    ),
    'task-chat-temporal-registration-changed',
  );
  return bytes;
}

function temporalReason(cause: unknown) {
  if (cause instanceof SyntaxError) return 'task-chat-temporal-json-invalid';
  if (cause instanceof Error) {
    if (/^[a-z][a-z0-9-]*$/u.test(cause.message)) return cause.message;
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'task-chat-temporal-file-missing';
    if (code === 'EACCES' || code === 'EPERM') return 'task-chat-temporal-file-inaccessible';
  }
  return 'task-chat-temporal-failed';
}

function readCommand(action: 'status' | 'result', workflowId: string, registration: string) {
  const quoted = `'${registration.replaceAll("'", "'\\''")}'`;
  return `agent-workflow task-chat ${action} --workflow-id ${workflowId} --temporal-registration ${quoted}`;
}

function runningGuidance(phase: string, nextStatus: string) {
  if (phase.endsWith('-unknown'))
    return 'Сверить первичные квитанции и состояние Worker для указанной фазы.';
  if (phase === 'waiting-human-gates')
    return 'Открыть решение владельца по процедуре ASK/decision.';
  if (phase === 'waiting-human' || phase === 'human-paused')
    return 'Проверить причину остановки и решение владельца о продолжении.';
  return nextStatus;
}

export async function runTemporalTaskChat(
  args: readonly string[],
  root: string,
  write: (s: string) => void,
  error: (s: string) => void,
) {
  if (taskChatHelpRequested(args)) {
    write(temporalTaskChatHelp);
    return 0;
  }
  const [action] = args;
  const reading = action === 'status' || action === 'result';
  let submitted: string | undefined;
  let registration: string | undefined;
  try {
    requireWorkflow(
      reading || action === 'start' || action === 'preview',
      'task-chat-action-required',
    );
    const values = options(
      args,
      reading ? [workflowFlag, registrationFlag] : [inputFlag, registrationFlag],
      reading ? 'task-chat-temporal-read-input-required' : 'task-chat-temporal-input-required',
      action === 'start' ? previewFlag : undefined,
    );
    const previewDigest = values.get(previewFlag);
    requireWorkflow(
      previewDigest === undefined || /^[0-9a-f]{64}$/u.test(previewDigest),
      'task-chat-temporal-preview-digest',
    );
    root = realpathSync(root);
    if (!reading) {
      const policy = taskBackendPolicy(root);
      requireWorkflow(policy?.startAdmission !== undefined, 'task-start-policy-required');
      requireWorkflow(policy.newTasks === 'temporal', 'backend-new-tasks-blocked');
    }
    const registrationPath = resolve(root, values.get(registrationFlag)!);
    registration = registrationPath;
    const settingsBytes = registrationBytes(root, registrationPath);
    const settings = JSON.parse(settingsBytes.toString('utf8')) as unknown;
    if (reading) {
      const workflowId = values.get(workflowFlag)!;
      const { readPreparedLocalTask } = await import('@krivega/agent-workflow/task-execution');
      const observation = await readPreparedLocalTask(root, settings, workflowId, action);
      write(
        JSON.stringify({
          ...observation,
          next_action:
            'phase' in observation
              ? runningGuidance(
                  observation.phase,
                  readCommand('status', workflowId, registrationPath),
                )
              : action === 'status'
                ? readCommand('result', workflowId, registrationPath)
                : null,
        }),
      );
      return 0;
    }
    const inputPath = resolve(root, values.get(inputFlag)!);
    const inputBytes = readPrivateFile(inputPath);
    const input = JSON.parse(inputBytes.toString('utf8')) as unknown;
    const { previewPreparedLocalTask, startPreparedLocalTask } =
      await import('@krivega/agent-workflow/local-task');
    if (action === 'preview') {
      write(JSON.stringify(await previewPreparedLocalTask(root, input, settings)));
      return 0;
    }
    const result = await startPreparedLocalTask(root, input, settings, {
      onSubmit(workflowId) {
        submitted = workflowId;
      },
      ...(previewDigest === undefined
        ? {}
        : {
            previewDigest,
            checkFiles() {
              requireWorkflow(
                settingsBytes.equals(registrationBytes(root, registrationPath)) &&
                  inputBytes.equals(readPrivateFile(inputPath)),
                'task-chat-temporal-preview-changed',
              );
            },
          }),
    });
    write(
      JSON.stringify({
        ...result,
        next_action: readCommand('status', result.workflowId, registrationPath),
      }),
    );
    return 0;
  } catch (cause) {
    const reason = temporalReason(cause);
    const status =
      submitted !== undefined
        ? 'unknown'
        : reason === 'task-chat-temporal-task-not-found'
          ? 'not-found'
          : reason === 'task-chat-temporal-server-unavailable'
            ? 'unavailable'
            : 'refused';
    const next_action =
      submitted !== undefined
        ? `Сверить исходный запуск командой ${readCommand('status', submitted, registration!)}. Сохранить исходный ID.`
        : reading
          ? temporalReadSyntax(action)
          : reason === 'task-chat-temporal-preview-changed' || action === 'preview'
            ? 'Повторить task-chat preview с исходными параметрами.'
            : temporalStartSyntax;
    error(reason);
    write(
      JSON.stringify({
        status,
        reason,
        next_action,
        details: {
          locator: chatDiagnostic,
          ...(submitted === undefined ? {} : { workflowId: submitted }),
        },
      }),
    );
    return 1;
  }
}
