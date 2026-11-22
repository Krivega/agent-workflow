export interface ProjectDescriptor {
  schemaVersion: 1;
  projectId: string;
  workspaceId: string;
  rules: string[];
  cardRoot: string;
  roles: { id: string; profile: string }[];
  checks: string[];
}

export function requireContract(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

export function object(value: unknown): Record<string, unknown> {
  requireContract(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'object-required',
  );
  return value as Record<string, unknown>;
}

export function text(value: unknown): string {
  requireContract(
    typeof value === 'string' && value.length > 0 && value.length <= 512,
    'text-required',
  );
  return value;
}

export function identifier(value: unknown): string {
  const result = text(value);
  requireContract(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(result), 'invalid-identifier');
  return result;
}

export function relativePath(value: unknown): string {
  const result = text(value);
  requireContract(
    !result.includes('\\') &&
      result.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
      !result.includes(':') &&
      !Array.from(result).some((character) => character.charCodeAt(0) <= 31),
    'invalid-relative-path',
  );
  return result;
}

function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  requireContract(Array.isArray(value) && value.length > 0, 'nonempty-list-required');
  const items = value.map(parse);
  requireContract(
    new Set(items.map((item) => JSON.stringify(item))).size === items.length,
    'duplicate-item',
  );
  return items;
}

export function exactFields(value: Record<string, unknown>, fields: string[]): void {
  requireContract(
    Object.keys(value).every((key) => fields.includes(key)) &&
      Object.keys(value).length === fields.length,
    'unexpected-fields',
  );
}

export function parseProject(value: unknown): ProjectDescriptor {
  const project = object(value);
  exactFields(project, [
    'schemaVersion',
    'projectId',
    'workspaceId',
    'rules',
    'cardRoot',
    'roles',
    'checks',
  ]);
  requireContract(project.schemaVersion === 1, 'unsupported-project-schema');
  const roles = list(project.roles, (value) => {
    const role = object(value);
    exactFields(role, ['id', 'profile']);
    return { id: identifier(role.id), profile: relativePath(role.profile) };
  });
  requireContract(new Set(roles.map((role) => role.id)).size === roles.length, 'duplicate-role');
  return {
    schemaVersion: 1,
    projectId: identifier(project.projectId),
    workspaceId: identifier(project.workspaceId),
    rules: list(project.rules, relativePath),
    cardRoot: relativePath(project.cardRoot),
    roles,
    checks: list(project.checks, identifier),
  };
}

export function workflowKey(projectId: string, taskId: string): string {
  return `aw/preparation/${identifier(projectId)}/${identifier(taskId)}`;
}
