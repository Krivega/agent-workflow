import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { disabledMcpServers } from '../adapters/codex/disabledMcpServers.js';
import { execFileSync } from 'node:child_process';
import { AppServerCoderSessions } from '../adapters/codex/appServerCoder.js';
import { StdioAppServer, type AppServerRpc } from '../adapters/codex/appServerTransport.js';
import { assertCoderCapabilities } from '../adapters/codex/coderCapabilities.js';
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { readPrivateFile, safeDirectory } from '../adapters/storage/storeFiles.js';
import { requireWorkflow } from '../core/connection.js';
import type { CoderRun } from '../core/coder.js';
import type { WriterProcesses } from '../ports/writerProcesses.js';

interface OpenNativeCoderSessions {
  run: CoderRun;
  binary: string;
  journal: string;
  processes: WriterProcesses;
  adopt(raw: StdioAppServer): AppServerRpc;
  verifyCopy(run: CoderRun): Promise<void>;
  authorize(run: CoderRun): Promise<void>;
  expectedDisabledMcpServers?: readonly string[] | undefined;
  inventoryTimeoutMs?: number;
  beforeSpawn?: () => void;
}

/** Give the caller ownership of the raw process before any initialization can fail. */
export async function openNativeCoderSessions({
  run,
  binary,
  journal,
  processes,
  adopt,
  verifyCopy,
  authorize,
  expectedDisabledMcpServers,
  inventoryTimeoutMs,
  beforeSpawn,
}: OpenNativeCoderSessions): Promise<AppServerCoderSessions> {
  const { id, copy_root: cwd } = run.brief;
  const directory = dirname(journal);
  requireWorkflow(run.copy !== null, 'coder-copy-missing');
  requireWorkflow(
    inventoryTimeoutMs === undefined ||
      (Number.isSafeInteger(inventoryTimeoutMs) && inventoryTimeoutMs > 0),
    'coder-mcp-inventory-timeout',
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  safeDirectory(directory);
  const args = [
    '--disable',
    'apps',
    '--disable',
    'plugins',
    '--disable',
    'multi_agent',
    '--config',
    'web_search="disabled"',
  ];
  beforeSpawn?.();
  const { names, overrides } = disabledMcpServers(
    binary,
    cwd,
    args,
    expectedDisabledMcpServers,
    inventoryTimeoutMs,
  );
  args.push(...overrides);
  beforeSpawn?.();
  const raw = new StdioAppServer(
    binary,
    [...args, 'app-server'],
    cwd,
    journal,
    `coder:${id}:create`,
  );
  const rpc = adopt(raw);
  await raw.initialize();
  const observed = assertCoderCapabilities(
    await rpc.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' }),
    names,
  );
  const pid = raw.pid;
  requireWorkflow(typeof pid === 'number', 'coder-native-process-unknown');
  const runtime = (await processes.descendants([pid])).find((entry) => entry.pid === pid);
  requireWorkflow(
    runtime !== undefined && runtime.parent === process.pid,
    'coder-native-process-unknown',
  );
  const bytes =
    canonical({
      kind: 'coder-native-process',
      runtime,
      controller: {
        pid: process.pid,
        started: execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
          encoding: 'utf8',
        }).trim(),
      },
      binary,
      args: [...args, 'app-server'],
      cwd,
      disabled_mcp_servers: names,
      observed_mcp_servers: observed,
      plugins: false,
      apps: false,
      web_search: false,
      delegation: false,
    }) + '\n';
  const hash = digest(bytes),
    path = resolve(directory, `policy-${hash}.json`);
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    requireWorkflow(
      (error as { code?: string }).code === 'EEXIST' &&
        readPrivateFile(path).toString('utf8') === bytes,
      'coder-policy-conflict',
    );
  }
  return new AppServerCoderSessions(
    rpc,
    directory,
    journal,
    processes,
    verifyCopy,
    { locator: path, hash },
    authorize,
  );
}
