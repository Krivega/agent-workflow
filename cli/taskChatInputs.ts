import { cardCriteria } from '../adapters/project/cardMarkdown.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { requireWorkflow, textField } from '../core/connection.js';
import { projectText } from '../adapters/project/projectFiles.js';
import type { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { discoverChat } from '../adapters/codex/chatDiscovery.js';
import { validCouncilRoleId } from '../core/connection.js';
import type { CouncilConfiguration } from '../core/connection.js';
import { configuredRoles, configuredProfileLocators } from '../core/council.js';
import type { CouncilRole, Selection } from '../core/council.js';
import type { Gate } from '../core/execution.js';
import type { InputRef } from '../core/localRun.js';
import { procedureIds } from '../core/connection.js';
import type { ProcedureId } from '../core/connection.js';
import { scopedTaskChatSelection } from './taskChatSelection.js';
import type { TaskCouncilSelection } from './taskChatSelection.js';

export interface TaskChatOptions {
  action: 'start' | 'continue' | 'revise' | 'load' | 'wait';
  state: string;
  card?: string | undefined;
  plan?: string | undefined;
  localPlan?: string | undefined;
  councilSelection?: string | undefined;
  sources: string[];
  targets: string[];
  skipped: Partial<Record<CouncilRole, string>>;
  affected: string[];
  binary: string;
  human: string[];
  loadBytes: number;
  after: string | null;
  timeoutMs: number;
  until: 'changed' | 'settled';
  procedures: ProcedureId[];
}
export function taskChatOptions(args: readonly string[]): TaskChatOptions {
  const action = args[0];
  requireWorkflow(
    ['start', 'continue', 'revise', 'load', 'wait'].includes(String(action)),
    'task-chat-action-required',
  );
  const values: Record<string, string[]> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    requireWorkflow(
      [
        '--state',
        '--card',
        '--plan',
        '--local-plan',
        '--source',
        '--target',
        '--skip-role',
        '--council-selection',
        '--affected',
        '--binary',
        '--human',
        '--load-bytes',
        '--after',
        '--timeout-ms',
        '--until',
        '--procedure',
      ].includes(key) &&
        value !== undefined &&
        !value.startsWith('--'),
      'invalid-task-chat-option',
    );
    (values[key] ??= []).push(textField(value));
  }
  for (const key of [
    '--state',
    '--card',
    '--plan',
    '--local-plan',
    '--binary',
    '--council-selection',
    '--load-bytes',
    '--after',
    '--timeout-ms',
    '--until',
  ])
    requireWorkflow((values[key]?.length ?? 0) <= 1, 'duplicate-task-chat-option');
  const loadBytes = Number(values['--load-bytes']?.[0] ?? 24_000);
  requireWorkflow(
    values['--plan'] === undefined || values['--local-plan'] === undefined,
    'conflicting-task-chat-plan',
  );
  requireWorkflow(
    Number.isInteger(loadBytes) &&
      loadBytes >= 1000 &&
      loadBytes <= 512_000 &&
      (values['--load-bytes'] === undefined || action === 'load'),
    'invalid-task-chat-load-budget',
  );
  const timeoutMs = Number(values['--timeout-ms']?.[0] ?? 60_000);
  const until = values['--until']?.[0] ?? 'changed';
  requireWorkflow(
    ['changed', 'settled'].includes(until) &&
      (values['--until'] === undefined || action === 'wait'),
    'invalid-task-chat-wait-mode',
  );
  requireWorkflow(
    Number.isInteger(timeoutMs) &&
      timeoutMs >= 0 &&
      timeoutMs <= 60_000 &&
      (action === 'wait' ||
        (values['--after'] === undefined && values['--timeout-ms'] === undefined)),
    'invalid-task-chat-wait-option',
  );
  const skipped: TaskChatOptions['skipped'] = {};
  const procedures = values['--procedure'] ?? [];
  requireWorkflow(
    (procedures.length === 0 || action === 'load') &&
      procedures.every((id) =>
        [
          ...procedureIds,
          'council',
          'arbitration',
          'audit',
          'coordination',
          'relay',
          'finalization',
        ].includes(id),
      ),
    'invalid-task-chat-procedure',
  );
  for (const entry of values['--skip-role'] ?? []) {
    const colon = entry.indexOf(':');
    const role = entry.slice(0, colon) as CouncilRole;
    requireWorkflow(
      colon > 0 && validCouncilRoleId(role) && skipped[role] === undefined,
      'invalid-skipped-role',
    );
    skipped[role] = textField(entry.slice(colon + 1));
  }
  requireWorkflow(
    values['--council-selection'] === undefined || Object.keys(skipped).length === 0,
    'conflicting-council-selection',
  );
  return {
    action: action as TaskChatOptions['action'],
    state: resolve(textField(values['--state']?.[0])),
    card: values['--card']?.[0],
    plan: values['--plan']?.[0],
    localPlan: values['--local-plan']?.[0],
    councilSelection: values['--council-selection']?.[0],
    sources: values['--source'] ?? [],
    skipped,
    affected: values['--affected'] ?? [],
    targets: values['--target'] ?? [],
    binary: values['--binary']?.[0] ?? 'codex',
    human: values['--human'] ?? [],
    loadBytes,
    after: values['--after']?.[0] ?? null,
    timeoutMs,
    until: until as TaskChatOptions['until'],
    procedures: [...new Set(procedures)] as ProcedureId[],
  };
}
export async function taskChatContext(
  root: string,
  previous?: { source: InputRef; turn_id: string },
) {
  const home = process.env.CODEX_HOME ?? resolve(homedir(), '.codex');
  return discoverChat(
    root,
    resolve(home, 'sessions'),
    textField(process.env.CODEX_THREAD_ID),
    previous,
  );
}
export async function taskChatBrief(root: string, card: string) {
  const content = await projectText(root, card);
  const section = (name: string) => {
    const match = new RegExp(`^## ${name}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'mu').exec(
      content,
    );
    return match?.[1]?.trim();
  };
  const outcome = textField(
    section('Цель') ??
      section('Результат и не-цели') ??
      /^# Задача: (.+)\r?$/mu.exec(content)?.[1]?.trim(),
  );
  const boundary = section('Границы');
  const scope =
    boundary === undefined
      ? [section('Границы и критерии')?.split(/\r?\n\s*\r?\n/u)[0] ?? outcome]
      : boundary
          .split('\n')
          .filter((s) => s.startsWith('- '))
          .map((s) => s.slice(2));
  const criteria = cardCriteria(content);
  requireWorkflow(scope.length > 0 && criteria.length > 0, 'task-chat-brief-incomplete');
  return { outcome, scope, criteria };
}
export function taskChatGates(criteria: string[], human: string[]): Gate[] {
  requireWorkflow(
    human.every((id) => criteria.includes(id)) && !human.includes('validate'),
    'task-chat-human-criterion-unknown',
  );
  const gates: Gate[] = criteria.map((criterion) => ({
    id: human.includes(criterion)
      ? criterion
      : (/^([a-zA-Z0-9_-]+): /u.exec(criterion)?.[1] ?? criterion),
    kind: human.includes(criterion) ? 'human' : 'check',
    applicable: true,
    reason: criterion,
  }));
  requireWorkflow(
    new Set(gates.map((gate) => gate.id)).size === gates.length,
    'duplicate-criterion-id',
  );
  if (!gates.some((gate) => gate.id === 'validate'))
    gates.push({ id: 'validate', kind: 'check', applicable: true, reason: 'validate' });
  return gates;
}
export async function taskChatSelection(
  files: FileWorkflowInputs,
  refs: string[],
  skipped: TaskChatOptions['skipped'],
  targets: string[],
  routing?: { plan: TaskCouncilSelection; shared: string[]; directory: string },
  configuration?: CouncilConfiguration,
) {
  if (routing !== undefined) return scopedTaskChatSelection(files, refs, targets, routing);
  requireWorkflow(Object.keys(skipped).length > 0, 'council-selection-required');
  const inputs = await files.capture(
    { files: [...new Set([...refs, ...targets])], directories: [] },
    'Explicit task-chat source selection',
  );
  const selection = {} as Selection;
  const roles = configuredRoles(configuration);
  requireWorkflow(
    Object.keys(skipped).every((role) => roles.includes(role as CouncilRole)),
    'invalid-skipped-role',
  );
  for (const role of roles) {
    const requirements = await Promise.all(
      [
        ...new Set([
          ...refs,
          ...(skipped[role] === undefined ? configuredProfileLocators(role, configuration) : []),
        ]),
      ].map((p) => files.ref(p)),
    );
    selection[role] = {
      trigger: skipped[role] === undefined,
      reason: skipped[role] ?? 'Проверить план в пределах предметного профиля роли',
      requirements,
      inputs,
    };
  }
  return { selection, inputs };
}
