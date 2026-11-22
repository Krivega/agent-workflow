// Run from the installed package, with a stable private host directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Runtime } from '@temporalio/worker';
import { register } from 'tsx/esm/api';
import { createReaderHost } from '../../dist/worker/readerHost.js';
import { parsePreparedTaskRegistration } from '../../dist/client/localTask.js';
import { artifactStore, privateDirectory } from '../../dist/adapters/artifacts/files.js';
import { nativeReaderAuthority } from '../../dist/adapters/codex/readerAuthority.js';
import { nativeTaskSource } from '../../dist/adapters/codex/nativeTaskSource.js';
import { nativeTaskHumanAuthority } from '../../dist/adapters/codex/taskHumanAuthority.js';
import { checkTaskStartAdmission } from '../../dist/adapters/project/taskStartAdmission.js';
import { checkWriterInventory } from '../../dist/adapters/codex/taskWriter.js';
import { readerExecution, supportedTaskClient } from '../../dist/policy/readerExecution.js';

function privatePath(path, directory) {
  assert(isAbsolute(path) && realpathSync(path) === path, 'Expected canonical absolute path');
  const stat = lstatSync(path);
  assert(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1);
  assert(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'Expected private host path');
  return path;
}
function json(path) {
  return JSON.parse(readFileSync(privatePath(path, false), 'utf8'));
}

const [action, root, ...extra] = process.argv.slice(2);
assert(
  ['--check', '--check-writer', '--plist', '--run'].includes(action) && !extra.length,
  'Use --check|--check-writer|--plist|--run HOST_DIRECTORY',
);
privatePath(root, true);
const config = json(join(root, 'worker.json'));
const { profile, maxTurnStarts, codexBinary, codexHome, disabledServers } = config;
readerExecution(profile);
assert(supportedTaskClient(profile.clientVersion));
assert(Number.isSafeInteger(maxTurnStarts) && maxTurnStarts >= 0);
assert(isAbsolute(codexBinary) && isAbsolute(codexHome));
const sessionsRoot = join(codexHome, 'sessions');
assert(
  Array.isArray(disabledServers) &&
    disabledServers.every((name) => typeof name === 'string' && /^[A-Za-z0-9_-]+$/u.test(name)),
);
assert(config.projects.length > 0);
const entries = config.projects.map(({ file, threadId }) => {
  const settings = json(file);
  const { registration, ...route } = parsePreparedTaskRegistration(
    settings,
    realpathSync(settings.registration.workspaceRoot),
  );
  assert(typeof threadId === 'string' && threadId.length);
  assert.equal(route.address, '127.0.0.1:7233');
  return { route, threadId, registration };
});
const { route } = entries[0];
const projectIds = new Set();
for (const { route: projectRoute, registration } of entries) {
  assert.deepEqual(projectRoute, route, 'Project routes must match');
  assert.equal(registration.owner, entries[0].registration.owner, 'Project owners must match');
  assert.equal(registration.hostId, entries[0].registration.hostId, 'Host IDs must match');
  assert(!projectIds.has(registration.project.projectId), 'Duplicate project ID');
  projectIds.add(registration.project.projectId);
}
if (action === '--plist') {
  const plist = {
    Label: 'com.krivega.agent-workflow.worker',
    ProgramArguments: [process.execPath, fileURLToPath(import.meta.url), '--run', root],
    WorkingDirectory: root,
    EnvironmentVariables: {
      PATH: [
        dirname(process.execPath),
        dirname(codexBinary),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].join(':'),
    },
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 30,
    ExitTimeOut: 90,
    Umask: 0o077,
    StandardOutPath: join(root, 'worker.stdout.log'),
    StandardErrorPath: join(root, 'worker.stderr.log'),
  };
  process.stdout.write(
    execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], {
      input: JSON.stringify(plist),
    }),
  );
} else if (action === '--check') {
  console.log(
    JSON.stringify({
      ...route,
      queues: [route.taskQueue, route.taskQueue + '.control'],
      projects: entries.length,
    }),
  );
} else {
  process.umask(0o077);
  process.env.CODEX_HOME = codexHome;
  register();
  const { StdioAppServer } = await import('../../adapters/codex/appServerTransport.ts');
  assert.equal(
    execFileSync(codexBinary, ['--version'], { encoding: 'utf8' }).trim(),
    'codex-cli ' + profile.clientVersion,
  );
  const logs = privateDirectory(join(root, 'rpc'));
  const args = [
    '-c',
    'features.apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.multi_agent=false',
    ...disabledServers.flatMap((name) => ['-c', 'mcp_servers.' + name + '.enabled=false']),
    'app-server',
    '--stdio',
  ];
  function transport(workspace) {
    return new StdioAppServer(codexBinary, args, workspace, join(logs, randomUUID() + '.jsonl'));
  }
  class WriterTransport extends StdioAppServer {
    async initialize() {
      await super.initialize();
      const status = await this.request('account/read', { refreshToken: false });
      assert(
        status?.requiresOpenaiAuth === false ||
          (status?.requiresOpenaiAuth === true &&
            typeof status.account?.type === 'string' &&
            status.account.type.length > 0),
        'Writer login unavailable: check Codex login in the CODEX_HOME selected by the Writer launcher',
      );
    }
  }
  function writerTransport(workspace) {
    return new WriterTransport(codexBinary, args, workspace, join(logs, randomUUID() + '.jsonl'));
  }
  for (const { registration } of entries) {
    const copies = privateDirectory(join(registration.artifactRoot, 'copies'));
    const workspace = mkdtempSync(join(copies, 'preflight-'));
    try {
      const writer = writerTransport(workspace);
      try {
        await writer.initialize();
        checkWriterInventory(
          await writer.request('mcpServerStatus/list', {
            limit: 100,
            detail: 'toolsAndAuthOnly',
          }),
          disabledServers,
        );
      } finally {
        writer.close();
      }
    } finally {
      rmdirSync(workspace);
    }
  }
  if (action === '--check-writer') {
    console.log(JSON.stringify({ writerPreflight: 'passed', projects: entries.length }));
  } else {
    Runtime.install({ shutdownSignals: [] });
    const { promise: stopped, resolve: stop } = Promise.withResolvers();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const connection = await NativeConnection.connect({ address: route.address });
    const readers = [];
    try {
      const projects = [];
      for (const { registration, threadId } of entries) {
        const { workspaceRoot, artifactRoot, owner } = registration;
        const store = artifactStore(artifactRoot);
        const issuer = { sessionsRoot, workspaceRoot, threadId, owner };
        const authority = nativeReaderAuthority(store, issuer);
        const observer = nativeTaskSource(store, { ...issuer, chatWorkspace: workspaceRoot });
        const humanAuthority = nativeTaskHumanAuthority(store, observer, (input) =>
          checkTaskStartAdmission(
            registration,
            observer,
            input.startAdmission,
            input.admission.preparation,
            undefined,
            { card: 'retained' },
          ),
        );
        const rpc = transport(workspaceRoot);
        readers.push(rpc);
        await rpc.initialize();
        projects.push({
          registration,
          authority,
          rpc,
          localTasks: {
            profile,
            disabledServers,
            createRuntime: writerTransport,
            startAdmissionAuthority: observer,
            humanAuthority,
          },
        });
      }
      const workflowsPath = fileURLToPath(
        new URL('../../dist/workflows/localTask.js', import.meta.url),
      );
      const host = await createReaderHost(
        connection,
        route.taskQueue,
        workflowsPath,
        projects,
        profile,
        join(root, 'state'),
        maxTurnStarts,
        undefined,
        route.namespace,
      );
      await host.runUntil(() => stopped);
    } finally {
      for (const rpc of readers) rpc.close();
      await connection.close();
    }
  }
}
