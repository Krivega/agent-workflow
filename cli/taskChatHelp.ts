import { fileURLToPath } from 'node:url';

export const chatDiagnostic = fileURLToPath(new URL('../CURRENT-CHAT.md', import.meta.url));

export const temporalStartSyntax =
  'task-chat start --temporal-input <input12.json> --temporal-registration <registration.json> [--preview-digest <sha256>]';
const registrationFlag = '--temporal-registration <registration.json>';
export const temporalReadSyntax = (action: 'status' | 'result') =>
  `task-chat ${action} --workflow-id <workflowId> ${registrationFlag}`;

export const temporalTaskChatHelp = `Задача Temporal (из корня зарегистрированной рабочей копии)
  ${temporalStartSyntax}
  task-chat preview --temporal-input <input12.json> ${registrationFlag}
  ${temporalReadSyntax('status')}
  ${temporalReadSyntax('result')}

Подготовка Input12 и регистрации описана в CURRENT-CHAT.md.
Команды с --state доступны для сравнительного запуска из исходников проекта.`;

export function taskChatHelpRequested(args: readonly string[]) {
  return args.length === 1 && (args[0] === '--help' || args[0] === '-h');
}
