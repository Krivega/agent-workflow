export interface ProjectInspection {
  scope: 'configuration-only';
  nodeRange: string;
  validation: { command: 'yarn validate'; script: string };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Ожидался объект конфигурации проекта.');
  }
  return value as Record<string, unknown>;
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Не задано поле ${field}.`);
  }
  return value;
}

export function inspectProjectManifest(manifest: unknown): ProjectInspection {
  const project = record(manifest);
  return {
    scope: 'configuration-only',
    nodeRange: nonEmptyText(record(project.engines).node, 'engines.node'),
    validation: {
      command: 'yarn validate',
      script: nonEmptyText(record(project.scripts).validate, 'scripts.validate'),
    },
  };
}
