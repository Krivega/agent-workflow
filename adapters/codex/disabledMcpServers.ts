import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { object, requireWorkflow, textField } from '../../core/connection.js';

export function disabledMcpServers(
  binary: string,
  cwd: string,
  args: readonly string[],
  expectedDisabledMcpServers?: readonly string[],
  inventoryTimeoutMs?: number,
) {
  let names: string[];
  const http = new Set<string>();
  try {
    const configured: unknown = JSON.parse(
      execFileSync(binary, [...args, 'mcp', 'list', '--json'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(inventoryTimeoutMs === undefined
          ? {}
          : { timeout: inventoryTimeoutMs, killSignal: 'SIGKILL' as const }),
      }),
    );
    requireWorkflow(Array.isArray(configured), 'coder-mcp-inventory-unknown');
    names = configured
      .map((entry: unknown) => {
        const server = object(entry),
          name = textField(server.name);
        if ((server.transport as { type?: unknown } | undefined)?.type === 'streamable_http')
          http.add(name);
        return name;
      })
      .sort();
    requireWorkflow(new Set(names).size === names.length, 'coder-mcp-inventory-incomplete');
    requireWorkflow(
      names.every((name) => /^[a-zA-Z0-9_-]+$/u.test(name)),
      'coder-mcp-name-unsupported',
    );
  } catch {
    throw new Error('coder-mcp-configuration-unconfirmed');
  }
  requireWorkflow(
    expectedDisabledMcpServers === undefined ||
      isDeepStrictEqual(names, [...expectedDisabledMcpServers].sort()),
    'coder-mcp-inventory-changed',
  );
  const overrides = names.flatMap((name) => {
    const flag = ['--config', `mcp_servers.${name}.enabled=false`];
    // Remove the network endpoint from the child configuration of disabled HTTP servers.
    if (http.has(name)) flag.push('--config', `mcp_servers.${name}.url=""`);
    return flag;
  });
  return { names, overrides };
}
