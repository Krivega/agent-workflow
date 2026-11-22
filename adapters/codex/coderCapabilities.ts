import { object, requireWorkflow, textField } from '../../core/connection.js';

export function assertCoderCapabilities(raw: unknown, disabled: string[]): string[] {
  const status = object(raw);
  requireWorkflow(
    Array.isArray(status.data) && (status.nextCursor === null || status.nextCursor === undefined),
    'coder-mcp-inventory-incomplete',
  );
  const names = status.data.map((entry) => {
    const server = object(entry),
      name = textField(server.name);
    requireWorkflow(
      disabled.includes(name) &&
        [null, 'disabled'].includes(server.runtimeStatus as null | string) &&
        server.pluginId === null &&
        (server.httpOrigin === null || server.httpOrigin === undefined) &&
        server.serverInfo === null &&
        (server.serverCapabilities === null || server.serverCapabilities === undefined) &&
        server.toolsError === null &&
        Object.keys(object(server.tools)).length === 0 &&
        Array.isArray(server.resources) &&
        server.resources.length === 0 &&
        Array.isArray(server.resourceTemplates) &&
        server.resourceTemplates.length === 0,
      'coder-external-tools-enabled',
    );
    return name;
  });
  requireWorkflow(new Set(names).size === names.length, 'coder-mcp-inventory-incomplete');
  return names.sort();
}
