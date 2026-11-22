import { requireWorkflow, object, textField, localLocator } from '../src/contracts/localValues.js';
export { requireWorkflow, object, textField, localLocator } from '../src/contracts/localValues.js';

export const procedureIds = [
  'bootstrap',
  'task',
  'implementation',
  'evidence',
  'boundary-review',
  'data-roles',
] as const;
export type ProcedureId =
  | (typeof procedureIds)[number]
  | 'council'
  | 'arbitration'
  | 'audit'
  | 'coordination'
  | 'relay'
  | 'finalization';
export interface Procedure {
  id: ProcedureId;
  version: string;
  locator: string;
  hash: string;
  fragments?: string[];
}
export interface CouncilConfiguration {
  catalog: string;
  profiles: Record<string, string>;
}
export interface ValidationCommand {
  file: string;
  args: string[];
}
export function validCouncilRoleId(id: string): boolean {
  return /^[a-z][a-z0-9-]*$/u.test(id) && !Object.hasOwn(Object.prototype, id);
}
export function parseCouncilConfiguration(value: unknown): CouncilConfiguration {
  const config = object(value);
  const catalog = localLocator(config.catalog);
  const entries = Object.entries(object(config.profiles));
  requireWorkflow(entries.length > 0, 'missing-council-profiles');
  const profiles = Object.fromEntries(
    entries.map(([id, path]) => {
      requireWorkflow(validCouncilRoleId(id), 'invalid-council-role');
      const profile = localLocator(path);
      requireWorkflow(profile !== catalog, 'invalid-council-profile');
      return [id, profile];
    }),
  );
  return { catalog, profiles };
}
function validationCommand(value: unknown): ValidationCommand {
  const command = object(value);
  requireWorkflow(Array.isArray(command.args), 'invalid-validation-command');
  return { file: textField(command.file), args: command.args.map(textField) };
}
export interface Connection {
  council?: CouncilConfiguration;
  coder_profile?: string;
  validation_commands?: ValidationCommand[];
  schema_version: 1;
  tool_version: 'aw-local/1';
  project_id: string;
  rules: string[];
  commands: string[];
  plans: { active: string; verifying: string; completed: string; cancelled?: string };
  mutable_links: string[];
  procedures: Procedure[];
}
function list(value: unknown): unknown[] {
  requireWorkflow(Array.isArray(value) && value.length > 0, 'missing-list');
  return value;
}
export function parseConnection(value: unknown): Connection {
  const input = object(value);
  requireWorkflow(
    input.schema_version === 1 && input.tool_version === 'aw-local/1',
    'unsupported-connection-version',
  );
  const plans = object(input.plans);
  const procedures = list(input.procedures).map((entry): Procedure => {
    const item = object(entry);
    requireWorkflow(
      [
        ...procedureIds,
        'council',
        'arbitration',
        'audit',
        'coordination',
        'relay',
        'finalization',
      ].includes(item.id as ProcedureId),
      'unknown-procedure',
    );
    const hash = textField(item.hash);
    requireWorkflow(/^[a-f0-9]{64}$/u.test(hash), 'invalid-procedure-hash');
    const fragments =
      item.fragments === undefined ? undefined : list(item.fragments).map(textField);
    requireWorkflow(
      fragments === undefined ||
        (new Set(fragments).size === fragments.length &&
          fragments.every(
            (id) =>
              typeof item.id === 'string' &&
              id.startsWith(item.id + '.') &&
              /^[a-z0-9.-]+$/u.test(id),
          )),
      'invalid-procedure-fragments',
    );
    return {
      id: item.id as ProcedureId,
      version: textField(item.version),
      locator: localLocator(item.locator),
      hash,
      ...(fragments === undefined ? {} : { fragments }),
    };
  });
  requireWorkflow(
    procedureIds.every((id) => procedures.some((p) => p.id === id)) &&
      new Set(procedures.map((p) => p.id)).size === procedures.length,
    'missing-or-duplicate-procedure',
  );
  const commands = list(input.commands).map(textField);
  requireWorkflow(
    commands.every((name) => /^[a-z][a-z0-9:-]*$/u.test(name)),
    'invalid-command-name',
  );
  const result: Connection = {
    schema_version: 1,
    tool_version: 'aw-local/1',
    project_id: textField(input.project_id),
    rules: list(input.rules).map(localLocator),
    commands,
    ...(input.council === undefined ? {} : { council: parseCouncilConfiguration(input.council) }),
    ...(input.coder_profile === undefined
      ? {}
      : { coder_profile: localLocator(input.coder_profile) }),
    ...(input.validation_commands === undefined
      ? {}
      : { validation_commands: list(input.validation_commands).map(validationCommand) }),
    plans: {
      active: localLocator(plans.active),
      verifying: localLocator(plans.verifying),
      completed: localLocator(plans.completed),
      ...(plans.cancelled === undefined ? {} : { cancelled: localLocator(plans.cancelled) }),
    },
    mutable_links: list(input.mutable_links).map(localLocator),
    procedures,
  };
  requireWorkflow(
    new Set(Object.values(result.plans)).size === Object.keys(result.plans).length,
    'duplicate-plan-root',
  );
  return result;
}
