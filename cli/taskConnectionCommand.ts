import { readFile } from 'node:fs/promises';
import { FileTaskConnection } from '../adapters/project/taskConnection.js';
import type { TaskConnectionPlan } from '../core/taskConnection.js';
export const connectionCommands = [
  'preview-task',
  'apply-task',
  'disable-task',
  'rollback-task',
] as const;
export const connectionUsage =
  'preview-task <descriptor> <card> <task-id> [root] | apply-task <plan.json> <external-journal> [root] | disable-task <external-journal> [root] | rollback-task <external-journal> [root]';
export async function runTaskConnectionCommand(
  args: readonly string[],
  cwd: string,
  write: (message: string) => void,
  error: (message: string) => void,
) {
  const [command, ...values] = args,
    required = command === 'preview-task' ? 3 : command === 'apply-task' ? 2 : 1;
  if (
    !connectionCommands.includes(command as (typeof connectionCommands)[number]) ||
    values.length < required ||
    values.length > required + 1 ||
    values.some((v) => !v)
  ) {
    error(connectionUsage);
    return 2;
  }
  try {
    const service = new FileTaskConnection(values[required] ?? cwd);
    const result =
      command === 'preview-task'
        ? await service.preview(values[0]!, values[1]!, values[2]!)
        : command === 'apply-task'
          ? await service.apply(
              JSON.parse(await readFile(values[0]!, 'utf8')) as TaskConnectionPlan,
              values[1]!,
            )
          : await service.change(values[0]!, command === 'disable-task' ? 'DISABLE' : 'ROLLBACK');
    write(JSON.stringify(result, null, 2));
    return 0;
  } catch (cause) {
    error(cause instanceof Error ? cause.message : 'Не удалось изменить подключение.');
    return 1;
  }
}
