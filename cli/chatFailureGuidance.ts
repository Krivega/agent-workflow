import { temporalStartSyntax } from './taskChatHelp.js';
export { chatDiagnostic } from './taskChatHelp.js';
export function chatFailureGuidance(reason: string, locator: string) {
  const refused =
    /^(?:invalid-task-chat-[a-z-]+|task-chat-action-required|duplicate-task-chat-option|conflicting-task-chat-plan|conflicting-council-selection|chat-state-must-be-external|unsupported-chat-request-version|chat-environment-identity-mismatch|chat-write-profile-unsupported|invalid-local-plan-json|unsupported-local-plan|local-(?:consumers-incomplete|scope-incomplete|needs-council-planning|checks-missing))$/u.test(
      reason,
    );
  return {
    status: refused ? 'refused' : 'unknown',
    reason,
    next_action: refused
      ? reason === 'local-needs-council-planning'
        ? 'Передать изменение на планирование совета через --plan.'
        : reason === 'conflicting-task-chat-plan'
          ? 'Оставить один параметр: --plan или --local-plan.'
          : 'Исправить указанное условие допуска.'
      : 'Проверить исходную операцию и её квитанцию; не запускать повтор с новым ID.',
    details: { locator },
  };
}

export const taskChatUsage = `${temporalStartSyntax} | task-chat start --state <external-directory> --card <compact-card.md> (--plan <proposal.md> | --local-plan <plan.json>) --council-selection <roles.json> [--source <file>] [--binary <codex>] | task-chat load --state <directory> [--load-bytes <1000..512000>] [--procedure <id>] | task-chat continue --state <directory> | task-chat wait --state <directory> [--after <cursor>] [--timeout-ms <0..60000>] [--until changed|settled] | task-chat revise --state <directory> (--plan <proposal.md> | --local-plan <plan.json>) --affected <criterion> --council-selection <roles.json> (legacy: --skip-role <role:reason>)`;

export function reportTaskChatFailure(
  cause: unknown,
  diagnostic: string,
  input: { locator: string } | null,
  write: (s: string) => void,
  error: (s: string) => void,
) {
  const reason = cause instanceof Error ? cause.message : taskChatUsage;
  error(reason);
  try {
    const guidance = chatFailureGuidance(reason, input?.locator ?? diagnostic);
    if (input !== null && guidance.status === 'unknown') {
      guidance.status = 'refused';
      guidance.next_action = 'Исправить локальный план.';
    }
    write(JSON.stringify(guidance));
  } catch {
    return 1;
  }
  return 1;
}
